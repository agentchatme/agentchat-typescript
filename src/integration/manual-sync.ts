/**
 * The served manual, placed and kept current. An integration's skill file
 * follows the manual the served texts announce (`texts.manual: {url,
 * version, sha256?}`). When the file on disk is not the announced one, the
 * announced address is downloaded, checked and written over the old file
 * atomically. The file is its own record: its front matter (`version:`) and,
 * when the server announces one, the sha256 of its bytes say what is placed.
 *
 * Ported from agent-core `skill/served-manual.ts`, keeping every property of
 * its security review:
 *   - "never worse than before": offline, an error answer, a body over the
 *     size cap, a body that is not the agentchat skill at the announced
 *     version (or hash) — the existing file stays exactly as it is;
 *   - where a download may go is decided by where the announcement came
 *     from (the API base the texts were fetched from): an HTTPS base allows
 *     every hop HTTPS on `agentchat.me`, `*.agentchat.me` or the base's own
 *     host; a plain-HTTP loopback base (a development server) allows plain
 *     HTTP to loopback only; any other plain-HTTP base allows no download;
 *   - redirects are followed here, one hop at a time (at most three), each
 *     hop checked — never a plaintext hop between two TLS ones, never off
 *     those hosts, never an address carrying credentials;
 *   - a size cap (declared and actual), a timeout over every hop, UTF-8
 *     only, no NUL, front matter naming the skill at the announced version,
 *     sha256 of the exact bytes when announced; a leading BOM and CRLF line
 *     endings read the same as LF;
 *   - the exact bytes that were checked are the bytes written: temp file,
 *     fsync, rename (retried on Windows), the old file kept on any failure;
 *   - fetched without credentials: the manual is public, and the agent's key
 *     is never sent to an address the server merely names.
 * The body is text for a model to read; it is never executed or interpreted
 * beyond its front matter.
 *
 * Unlike agent-core this package bundles no manual (every text is served,
 * rule 3): an integration that wants a first-install fallback passes its own
 * `fallback` bytes, written only when no file exists and nothing verified
 * could be had, or when they are the announced manual.
 */

import type { Texts } from '../types/index.js'
import { readBytes, writeAtomic, type RenameOptions } from './files.js'
import type { TextsCache } from './texts-cache.js'

/** What the served texts announce: `Texts['manual']`. */
export type ServedManual = Texts['manual']

/** The manual is ~60 KB; anything past this is not the manual. */
export const MANUAL_MAX_BYTES = 512 * 1024
/** One attempt, every hop included. */
export const MANUAL_FETCH_TIMEOUT_MS = 10_000
/** Redirects followed (each one checked) before giving up. */
export const MANUAL_MAX_REDIRECTS = 3
/** The skill the manual is: `<skills dir>/agentchat/SKILL.md`. */
export const MANUAL_SKILL_NAME = 'agentchat'

/** `fetch`'s shape, injectable for tests. Called with `redirect: 'manual'`. */
export type ManualFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * - `current`  — the file already is the announced manual; nothing fetched.
 * - `updated`  — the announced manual was written (downloaded, or the fallback when it is that manual).
 * - `kept`     — the existing file was left as it was: nothing announced, or no verified copy could be had.
 * - `fallback` — no file existed and nothing verified could be had: the fallback bytes were written.
 * - `failed`   — no file existed and none could be written (no fallback, or the write failed).
 */
export type ManualSyncState = 'current' | 'updated' | 'kept' | 'fallback' | 'failed'

export interface ManualSyncResult {
  readonly state: ManualSyncState
  readonly path: string
  /** The version the file carries after the sync; null when there is no file or it names none. */
  readonly version: string | null
  /** The version the file carried before; null when there was none. */
  readonly previous: string | null
  /** The file carried the announced version but not the announced bytes. */
  readonly tampered: boolean
  /** The announced version; null when nothing was announced. */
  readonly served: string | null
  readonly url: string | null
  readonly source: 'download' | 'fallback' | null
  readonly written: boolean
  /** Whether the file now is the announced manual; null when nothing was announced. */
  readonly upToDate: boolean | null
  /** Why the announced manual is not on disk, else null. */
  readonly error: string | null
}

export interface SyncManualOptions {
  /** The skill file. The integration knows where; this package never derives it. */
  readonly path: string
  /** `texts.manual`; null when no texts are in hand. */
  readonly served: ServedManual | null
  /** The API base the texts were fetched from. Null, or plain HTTP off loopback: no download. */
  readonly apiBase: string | null
  /** Bytes to place when there is no file and nothing verified can be had. */
  readonly fallback?: Uint8Array | string | null
  readonly fetch?: ManualFetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
  /** Test seam for the Windows rename retry. */
  readonly rename?: RenameOptions['rename']
}

/**
 * The YAML front matter's top-level `key: value` fields, or null when the
 * text does not open with one. Deliberately not a YAML parser: nothing here
 * interprets more of a downloaded text than its name and version. A leading
 * BOM and CRLF line endings read the same as LF.
 */
export function manualFrontMatter(raw: string): ReadonlyMap<string, string> | null {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  let close = text.indexOf('\n---', 3)
  while (close >= 0 && text.charAt(close + 4) !== '\n' && close + 4 !== text.length) close = text.indexOf('\n---', close + 1)
  if (close < 0) return null
  const fields = new Map<string, string>()
  for (const line of text.slice(4, close).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (match === null) continue
    const value = match[2] ?? ''
    fields.set(match[1] ?? '', /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value)
  }
  return fields
}

/** The `version:` of a manual's front matter, or null. */
export function manualVersion(text: string): string | null {
  const version = manualFrontMatter(text)?.get('version')
  return version !== undefined && version.length > 0 ? version : null
}

/** Bring the skill file at `path` to the announced manual. Never throws. */
export async function syncManual(options: SyncManualOptions): Promise<ManualSyncResult> {
  const file = options.path
  const served = options.served
  const local = await readLocal(file)
  const fallback = toBytes(options.fallback)
  const base = { path: file, previous: local.version, served: served?.version ?? null, url: served?.url ?? null }
  let tampered = false
  let error: string | null = null

  if (served !== null) {
    const hash = announcedHash(served)
    if (hash instanceof Error) {
      error = hash.message
    } else {
      if (local.exists && local.version === served.version) {
        if (hash === null || (await sha256(local.bytes)) === hash) {
          return { ...base, tampered, state: 'current', version: local.version, source: null, written: false, upToDate: true, error: null }
        }
        tampered = true
      }
      const origin = manualOrigin(options.apiBase)
      if (!origin.ok) {
        error = origin.reason
      } else {
        let bytes: Uint8Array | null = null
        let source: 'download' | 'fallback' = 'fallback'
        if (fallback !== null && (await isAnnounced(fallback, served, hash))) {
          bytes = fallback
        } else {
          try {
            bytes = await downloadManual(served, hash, origin, options)
            source = 'download'
          } catch (err) {
            error = describe(err)
          }
        }
        if (bytes !== null) {
          try {
            await writeAtomic(file, bytes, { mode: 0o644, ...(options.rename ? { rename: options.rename } : {}) })
            return { ...base, tampered, state: 'updated', version: served.version, source, written: true, upToDate: true, error: null }
          } catch (err) {
            error = `could not write ${file}: ${describe(err)}`
          }
        }
      }
    }
  }

  if (local.exists) {
    return { ...base, tampered, state: 'kept', version: local.version, source: null, written: false, upToDate: served === null ? null : false, error }
  }
  if (fallback === null) {
    return { ...base, tampered, state: 'failed', version: null, source: null, written: false, upToDate: served === null ? null : false, error: error ?? 'no manual could be had and no fallback was given' }
  }
  try {
    await writeAtomic(file, fallback, { mode: 0o644, ...(options.rename ? { rename: options.rename } : {}) })
  } catch (err) {
    return { ...base, tampered, state: 'failed', version: null, source: null, written: false, upToDate: served === null ? null : false, error: describe(err) }
  }
  const fallbackIsServed = served !== null && (await isAnnounced(fallback, served, announcedHashOrNull(served)))
  return {
    ...base,
    tampered,
    state: 'fallback',
    version: manualVersion(decode(fallback)),
    source: 'fallback',
    written: true,
    upToDate: served === null ? null : fallbackIsServed,
    error,
  }
}

export interface ManualSyncOptions {
  /** The texts cache the announcement comes from; its client's base URL pins where a download may go. */
  readonly texts: Pick<TextsCache, 'current' | 'onChange' | 'apiBase'>
  /** The skill file, e.g. `<skills dir>/agentchat/SKILL.md`. */
  readonly targetPath: string
  readonly fallback?: Uint8Array | string | null
  readonly fetch?: ManualFetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** Called with every result; failures once per condition (`error` changed). */
  readonly onResult?: (result: ManualSyncResult) => void
}

/**
 * Keeps the skill file at the manual the texts announce. `start()` syncs once
 * and then on every texts change (the texts' own cadence: daily, sooner while
 * the server does not answer). Calls are serialised; `stop()` aborts a
 * download in flight.
 */
export class ManualSync {
  private readonly options: ManualSyncOptions
  private readonly controller = new AbortController()
  private chain: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private lastError: string | null = null
  private last: ManualSyncResult | null = null

  constructor(options: ManualSyncOptions) {
    this.options = options
  }

  /** The latest result, for an integration's status. */
  get result(): ManualSyncResult | null {
    return this.last
  }

  /** Sync now, then follow every texts change. Resolves with the first result. */
  start(): Promise<ManualSyncResult | null> {
    if (this.unsubscribe === null) {
      this.unsubscribe = this.options.texts.onChange((texts) => {
        void this.sync(texts.manual)
      })
    }
    return this.sync()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.controller.abort()
  }

  /** One serialised sync against `served` (default: the texts in hand). Null when nothing is in hand or stopped. */
  sync(served: ServedManual | null = this.options.texts.current()?.manual ?? null): Promise<ManualSyncResult | null> {
    const next = this.chain.then(async () => {
      if (served === null || this.controller.signal.aborted) return null
      const result = await syncManual({
        path: this.options.targetPath,
        served,
        apiBase: this.options.texts.apiBase,
        signal: this.controller.signal,
        ...(this.options.fallback !== undefined ? { fallback: this.options.fallback } : {}),
        ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
        ...(this.options.maxBytes !== undefined ? { maxBytes: this.options.maxBytes } : {}),
      })
      if (this.controller.signal.aborted) return result
      this.last = result
      if (result.upToDate === true || result.error !== this.lastError) {
        try {
          this.options.onResult?.(result)
        } catch {
          // an observer must not break the sync
        }
      }
      this.lastError = result.upToDate === true ? null : result.error
      return result
    })
    this.chain = next.catch(() => undefined)
    return next
  }
}

// ─── where a download may go ────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const MANUAL_HOME = 'agentchat.me'

type Origin = { readonly ok: true; readonly host: string; readonly plainLoopback: boolean } | { readonly ok: false; readonly reason: string }

function manualOrigin(apiBase: string | null): Origin {
  if (apiBase === null) return { ok: false, reason: 'no API base is known for the served texts' }
  let url: URL
  try {
    url = new URL(apiBase)
  } catch {
    return { ok: false, reason: `the API base ${apiBase} is not a URL` }
  }
  if (url.protocol === 'https:') return { ok: true, host: url.hostname, plainLoopback: false }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, host: url.hostname, plainLoopback: true }
  return { ok: false, reason: `the served texts came from ${url.origin}, which is not HTTPS, so the manual is not downloaded` }
}

function refusal(url: URL, origin: Extract<Origin, { ok: true }>): string | null {
  const host = url.hostname
  if (host !== MANUAL_HOME && !host.endsWith(`.${MANUAL_HOME}`) && host !== origin.host) {
    return `${url.host} is neither ${MANUAL_HOME} nor the API's own host`
  }
  if (url.username !== '' || url.password !== '') return 'the address carries credentials'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && origin.plainLoopback && LOOPBACK_HOSTS.has(host)) return null
  return `${url.protocol}// to ${url.host} — the manual is fetched over HTTPS only (plain HTTP only to loopback, from a loopback API base)`
}

// ─── download and checks ────────────────────────────────────────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SHA256_HEX = /^[0-9a-f]{64}$/

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) throw new Error('Web Crypto (globalThis.crypto.subtle) is not available')
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

function announcedHash(served: ServedManual): string | null | Error {
  const raw = (served as { sha256?: unknown }).sha256
  if (raw === undefined || raw === null) return null
  const hash = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return SHA256_HEX.test(hash) ? hash : new Error('the announced sha256 is not a hex sha256')
}

function announcedHashOrNull(served: ServedManual): string | null {
  const hash = announcedHash(served)
  return hash instanceof Error ? null : hash
}

async function isAnnounced(bytes: Uint8Array, served: ServedManual, hash: string | null): Promise<boolean> {
  return manualVersion(decode(bytes)) === served.version && (hash === null || (await sha256(bytes)) === hash)
}

interface LocalManual {
  readonly exists: boolean
  readonly bytes: Uint8Array
  readonly version: string | null
}

async function readLocal(file: string): Promise<LocalManual> {
  const bytes = await readBytes(file).catch(() => null)
  if (bytes === null) return { exists: false, bytes: new Uint8Array(0), version: null }
  return { exists: true, bytes, version: manualVersion(decode(bytes)) }
}

function toBytes(value: Uint8Array | string | null | undefined): Uint8Array | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

async function downloadManual(
  served: ServedManual,
  hash: string | null,
  origin: Extract<Origin, { ok: true }>,
  options: SyncManualOptions,
): Promise<Uint8Array> {
  let url: URL
  try {
    url = new URL(served.url)
  } catch {
    throw new Error(`the announced address is not a URL: ${served.url}`)
  }
  const refused = refusal(url, origin)
  if (refused !== null) throw new Error(`refusing ${url.href}: ${refused}`)
  const maxBytes = options.maxBytes ?? MANUAL_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? MANUAL_FETCH_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal !== undefined ? anySignal(options.signal, timeout) : timeout
  const doFetch: ManualFetch = options.fetch ?? ((input, init) => fetch(input, init))

  let bytes: Uint8Array
  try {
    for (let hop = 0; ; hop++) {
      const response = await doFetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined)
        if (hop >= MANUAL_MAX_REDIRECTS) throw new Error(`more than ${MANUAL_MAX_REDIRECTS} redirects from ${served.url}`)
        const location = response.headers.get('location')
        if (location === null || location === '') throw new Error(`HTTP ${response.status} from ${url.href} with no Location`)
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new Error(`HTTP ${response.status} from ${url.href} to an unparseable Location`)
        }
        const why = refusal(next, origin)
        if (why !== null) throw new Error(`redirected to ${next.href}: ${why}`)
        url = next
        continue
      }
      if (response.type === 'opaqueredirect' || response.status === 0) throw new Error(`an opaque redirect from ${url.href}`)
      // A fetch that followed on its own (an injected one) still says where it ended.
      if (response.url !== '' && response.url !== url.href) {
        const why = refusal(new URL(response.url), origin)
        if (why !== null) throw new Error(`redirected to ${response.url}: ${why}`)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.href}`)
      const declared = Number(response.headers.get('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${declared} bytes declared, over the ${maxBytes}-byte cap`)
      bytes = await readCapped(response, maxBytes)
      break
    }
  } catch (err) {
    if (timeout.aborted) throw new Error(`no answer from ${served.url} within ${timeoutMs} ms`)
    throw err
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('the body is not UTF-8 text')
  }
  checkManualText(text, served.version)
  if (hash !== null) {
    const got = await sha256(bytes)
    if (got !== hash) throw new Error(`the body's sha256 is ${got}, the server announced ${hash}`)
  }
  return bytes
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`the body is over the ${maxBytes}-byte cap`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function checkManualText(text: string, announced: string): void {
  if (text.includes('\u0000')) throw new Error('the body is not text')
  const fields = manualFrontMatter(text)
  if (fields === null) throw new Error('the body has no front matter — not the manual')
  if (fields.get('name') !== MANUAL_SKILL_NAME) throw new Error(`the front matter names "${fields.get('name') ?? ''}", not the ${MANUAL_SKILL_NAME} skill`)
  const version = manualVersion(text)
  if (version !== announced) throw new Error(`the body is version ${version ?? '(none)'}, the server announced ${announced}`)
}

/** `AbortSignal.any` where it exists (Node 20.3+), a manual join elsewhere. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') return any([a, b])
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (a.aborted || b.aborted) controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const detail = cause instanceof Error ? ((cause as { code?: string }).code ?? cause.message) : null
  return detail !== null && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message
}
