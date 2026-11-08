/**
 * The served texts, kept current: fetched at start and on a daily timer,
 * the last good copy kept in a file so an integration that starts offline is
 * not mute, and a change event for whatever is placed from them (the
 * identity block, the manual).
 *
 * Every text an agent sees is written once on the server and served as data
 * (`GET /v1/texts?runtime=`). This cache carries no copy of any of them.
 *
 * Policy (the stricter of the three copies this replaces — OpenClaw
 * `integration/texts.ts`, agent-core `integration/texts.ts`, Hermes
 * `texts.py`):
 *   - the file is read at start, before the first fetch, and only a file
 *     written for the same runtime counts (agent-core);
 *   - a served copy is never replaced by the file: a failed refresh keeps
 *     the last served copy (Hermes);
 *   - after a failure the next attempt comes after 5 min, doubling to 1 h
 *     (Hermes); after a success after `refreshMs` (24 h);
 *   - one fetch attempt per call, bounded by a timeout, never retried
 *     inside the call (the timer is the retry);
 *   - the file is replaced atomically (temp + fsync + rename, mode 0600);
 *   - listeners hear only real changes (content, not a re-fetch of the same).
 */

import type { AgentChatClient } from '../client.js'
import type { Texts, TextsRuntime } from '../types/index.js'
import { canonicalJson } from '../gate.js'
import { readBytes, writeAtomic } from './files.js'
import type { TimerHandle } from './coalescer.js'

export const TEXTS_REFRESH_MS = 24 * 60 * 60_000
export const TEXTS_RETRY_MS = 5 * 60_000
export const TEXTS_RETRY_MAX_MS = 60 * 60_000
export const TEXTS_FETCH_TIMEOUT_MS = 10_000
const CACHE_FILE_VERSION = 1

/** What the cache needs from the client; `AgentChatClient` satisfies it. */
export type TextsClient = Pick<AgentChatClient, 'texts'> & { readonly baseUrl?: string }

export type TextsSource = 'server' | 'cache' | 'none'

export type TextsListener = (texts: Texts, source: Exclude<TextsSource, 'none'>) => void

export interface TextsCacheOptions {
  readonly client: TextsClient
  readonly runtime: TextsRuntime
  /** Where the last good copy is kept. Without it nothing is written or read. */
  readonly filePath?: string
  readonly refreshMs?: number
  readonly retryMs?: number
  readonly retryMaxMs?: number
  readonly fetchTimeoutMs?: number
  /** Called once per new failure condition (not once per retry) with what went wrong. */
  readonly onError?: (error: Error) => void
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

/** The shape every consumer relies on. Extra fields a newer server adds pass through. */
export function isTexts(value: unknown): value is Texts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const t = value as Record<string, unknown>
  const manual = t.manual as Record<string, unknown> | null | undefined
  const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0
  return (
    typeof t.version === 'string' &&
    typeof manual === 'object' &&
    manual !== null &&
    typeof manual.url === 'string' &&
    typeof manual.version === 'string' &&
    nonEmpty(t.wake_instruction) &&
    nonEmpty(t.invite_prompt) &&
    nonEmpty(t.identity_line) &&
    typeof t.identity_line_template === 'string'
  )
}

export class TextsCache {
  readonly runtime: TextsRuntime
  private readonly client: TextsClient
  private readonly filePath: string | null
  private readonly refreshMs: number
  private readonly retryMs: number
  private readonly retryMaxMs: number
  private readonly fetchTimeoutMs: number
  private readonly onError: (error: Error) => void
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void
  private readonly listeners = new Set<TextsListener>()

  private texts: Texts | null = null
  private _source: TextsSource = 'none'
  private _fetchedAt: string | null = null
  private _lastError: string | null = null
  private failures = 0
  private serverSeen = false
  private inFlight: Promise<boolean> | null = null
  private timer: TimerHandle | null = null
  private started = false
  private stopped = false

  constructor(options: TextsCacheOptions) {
    this.client = options.client
    this.runtime = options.runtime
    this.filePath = options.filePath ?? null
    this.refreshMs = options.refreshMs ?? TEXTS_REFRESH_MS
    this.retryMs = options.retryMs ?? TEXTS_RETRY_MS
    this.retryMaxMs = Math.max(this.retryMs, options.retryMaxMs ?? TEXTS_RETRY_MAX_MS)
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? TEXTS_FETCH_TIMEOUT_MS
    this.onError = options.onError ?? (() => undefined)
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
  }

  /** The texts in hand, or null until a copy exists. No network. */
  current(): Texts | null {
    return this.texts
  }

  /** Where `current()` came from: this process's fetch, the file, or nowhere yet. */
  get source(): TextsSource {
    return this._source
  }

  /** When the current copy was served (also for a copy read from the file). */
  get fetchedAt(): string | null {
    return this._fetchedAt
  }

  /** The last fetch failure, cleared by the next success. */
  get lastError(): string | null {
    return this._lastError
  }

  /** The API base the texts are fetched from — what a manual download is pinned to. */
  get apiBase(): string | null {
    return typeof this.client.baseUrl === 'string' ? this.client.baseUrl : null
  }

  /** Called with every copy that differs from the one before (from the file or the server). */
  onChange(listener: TextsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Read the file, make one fetch, arm the timer. Resolves with what is in
   * hand once the first attempt has finished; never throws.
   */
  async start(): Promise<Texts | null> {
    if (this.started) return this.texts
    this.started = true
    this.stopped = false
    await this.loadFile()
    await this.refresh()
    return this.texts
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * The texts for a cycle: what is in hand, after one more fetch attempt if
   * the server has not answered yet in this process. Null only when the
   * server is unreachable and no copy was ever kept.
   */
  async ensure(): Promise<Texts | null> {
    if (!this.serverSeen && !this.stopped) await this.refresh()
    return this.texts
  }

  /** Fetch now (coalesced with one in flight), keep it, arm the next attempt. Resolves whether the server answered. */
  refresh(): Promise<boolean> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.fetchOnce().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async fetchOnce(): Promise<boolean> {
    try {
      const served: unknown = await this.client.texts.get({
        runtime: this.runtime,
        timeoutMs: this.fetchTimeoutMs,
        retry: 'never',
      })
      if (!isTexts(served)) throw new Error('GET /v1/texts: the answer is not a text set')
      const runtime = (served as { runtime?: unknown }).runtime
      if (runtime !== undefined && runtime !== this.runtime) {
        throw new Error(`GET /v1/texts: texts for ${String(runtime)}, asked for ${this.runtime}`)
      }
      if (this.stopped) return true
      const fetchedAt = new Date(this.now()).toISOString()
      this.serverSeen = true
      this.failures = 0
      this._lastError = null
      this.adopt(served, 'server', fetchedAt)
      await this.saveFile(served, fetchedAt)
      this.arm(this.refreshMs)
      return true
    } catch (err) {
      if (this.stopped) return false
      const message = err instanceof Error ? err.message : String(err)
      this.failures += 1
      if (message !== this._lastError) {
        this._lastError = message
        this.report(new Error(`texts: ${message} — ${this.texts === null ? 'no texts yet' : `keeping the ${this._source} copy from ${this._fetchedAt ?? '?'}`}`))
      }
      this.arm(Math.min(this.retryMaxMs, this.retryMs * 2 ** Math.min(this.failures - 1, 20)))
      return false
    }
  }

  private adopt(texts: Texts, source: Exclude<TextsSource, 'none'>, fetchedAt: string): void {
    const changed = this.texts === null || canonicalJson(this.texts) !== canonicalJson(texts)
    this.texts = texts
    this._source = source
    this._fetchedAt = fetchedAt
    if (!changed) return
    for (const listener of this.listeners) {
      try {
        listener(texts, source)
      } catch (err) {
        this.report(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private async loadFile(): Promise<void> {
    if (this.filePath === null || this.texts !== null) return
    const bytes = await readBytes(this.filePath).catch(() => null)
    if (bytes === null) return
    try {
      const entry = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      if (entry.version !== CACHE_FILE_VERSION || entry.runtime !== this.runtime) return
      if (typeof entry.fetched_at !== 'string' || !isTexts(entry.texts)) return
      this.adopt(entry.texts, 'cache', entry.fetched_at)
    } catch {
      // a damaged file is no file; the next success rewrites it
    }
  }

  private async saveFile(texts: Texts, fetchedAt: string): Promise<void> {
    if (this.filePath === null) return
    const entry = { version: CACHE_FILE_VERSION, runtime: this.runtime, fetched_at: fetchedAt, texts }
    try {
      await writeAtomic(this.filePath, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
    } catch (err) {
      // The file is a convenience for an offline start, never a dependency.
      this.report(new Error(`texts: the cache file could not be written: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private arm(ms: number): void {
    if (this.stopped || !this.started) return
    if (this.timer !== null) this._clearTimeout(this.timer)
    this.timer = this._setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, ms)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private report(error: Error): void {
    try {
      this.onError(error)
    } catch {
      // an observer must not break the cache
    }
  }
}
