/**
 * The listener report, kept current (contract v1 §3.13): a resident listener
 * (a program that holds the agent's socket and starts its runs) tells
 * AgentChat when it cannot do its job, so the agent's `reachability` and its
 * person's dashboard say so instead of a socket that looks healthy while
 * every run fails, or a silence that looks like a closed laptop.
 *
 * The integration says what is true (`set(state, reasonKind?)`); the
 * reporter decides when to send it:
 *   - on every change of state (or reason), about a second after the first
 *     change of a burst (`coalesceMs`), so a burst is one report, of its latest;
 *   - at most one attempt a minute (`minIntervalMs`), so a flapping state
 *     stays far under the server's 120 reports an hour;
 *   - again every 30 minutes while the state is not `ok` (`resendMs`): the
 *     server counts a report fresh for 45;
 *   - a change back to what the server already holds before it was sent is
 *     no report at all;
 *   - a failure is retried after 1 minute, doubling to 15 (`retryMs`,
 *     `retryMaxMs`), or after the wait the server names, at most an hour (a
 *     429's `Retry-After`, a 429 / 503 body's `retry_after_s`).
 * It never throws into the caller: a failure goes to `onError` (once per new
 * failure, not once per retry), and its timers never keep the process
 * alive. Report from the process that holds the socket only (a standby
 * reports nothing). When the listener is switched off or uninstalled, report
 * `stopped` before it closes its socket: `set('stopped')`, `await flush()`,
 * then `stop()`, then close the socket.
 *
 * `listenerInstanceId(file)` makes the install's id once and reuses it.
 */

import type { AgentChatClient } from '../client.js'
import { AgentChatError, RateLimitedError } from '../errors.js'
import { LISTENER_REPORT_RESEND_MS, type ListenerReasonKind, type ListenerState } from '../types/index.js'
import type { TimerHandle } from './coalescer.js'
import { createOnce, readBytes, writeAtomic } from './files.js'

/** How long after a change the report goes out, so a burst of changes is one report. */
export const LISTENER_REPORT_COALESCE_MS = 1_000
/** The shortest time between two attempts (a change, a re-send or a retry). */
export const LISTENER_REPORT_MIN_INTERVAL_MS = 60_000
/** The first retry after a failed attempt; doubles per failure up to `LISTENER_REPORT_RETRY_MAX_MS`. */
export const LISTENER_REPORT_RETRY_MS = 60_000
export const LISTENER_REPORT_RETRY_MAX_MS = 15 * 60_000

/** The longest wait a server's answer can set (its report budget is counted per hour). */
const SERVER_WAIT_MAX_MS = 60 * 60_000
/** The longest delay a timer takes; a longer one is re-armed when it fires. */
const TIMER_MAX_MS = 2_147_483_647

/** What the reporter needs from the client; `AgentChatClient` satisfies it. */
export type ListenerReportClient = Pick<AgentChatClient, 'reportListener'>

export interface ListenerReporterOptions {
  readonly client: ListenerReportClient
  /** This install's id (`listenerInstanceId(file)`): 8 to 64 of `A-Z a-z 0-9 _ -`. */
  readonly instanceId: string
  readonly resendMs?: number
  readonly coalesceMs?: number
  readonly minIntervalMs?: number
  readonly retryMs?: number
  readonly retryMaxMs?: number
  /** Called once per new failure condition (not once per retry) with what went wrong. */
  readonly onError?: (error: Error) => void
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

/** A snapshot for a status command. */
export interface ListenerReporterStatus {
  readonly instanceId: string
  /** What `set()` last said; null before the first call. */
  readonly state: ListenerState | null
  /** Its reason: null for `ok` and `stopped`, `other` when a failing state named none. */
  readonly reasonKind: ListenerReasonKind | null
  /** The last report the server accepted, and when (this machine's clock). */
  readonly reported: { readonly state: ListenerState; readonly reasonKind: ListenerReasonKind | null; readonly at: string } | null
  /** True while the server does not hold what `set()` last said. */
  readonly pending: boolean
  /** Failed attempts since the last accepted report. */
  readonly failures: number
  /** The last failure, cleared by the next accepted report. */
  readonly lastError: string | null
  /** When the next attempt is due, or null when none is. */
  readonly nextAttemptAt: string | null
  readonly stopped: boolean
}

const LISTENER_STATES: ReadonlySet<string> = new Set<ListenerState>(['ok', 'runs_failing', 'not_ready', 'stopped'])
const LISTENER_REASONS: ReadonlySet<string> = new Set<ListenerReasonKind>([
  'not_signed_in',
  'runtime_missing',
  'runtime_outdated',
  'runtime_check_failed',
  'other',
])

const INSTANCE_ID = /^[A-Za-z0-9_-]{8,64}$/

/** Whether `value` is a listener instance id the server takes: 8 to 64 of `A-Z a-z 0-9 _ -`. */
export function isListenerInstanceId(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_ID.test(value)
}

interface Report {
  readonly state: ListenerState
  readonly reasonKind: ListenerReasonKind | null
}

function sameReport(a: Report | null, b: Report | null): boolean {
  return a !== null && b !== null && a.state === b.state && a.reasonKind === b.reasonKind
}

/** A reason belongs to a state that is not ok; a failing state without one is `other`, as the server records it. */
function reasonOf(state: ListenerState, reasonKind: ListenerReasonKind | undefined): ListenerReasonKind | null {
  if (state === 'ok' || state === 'stopped') return null
  return reasonKind ?? 'other'
}

/** The wait the server named for this failure, in ms (at most an hour), or null. */
function serverWaitMs(err: unknown): number | null {
  let ms: number | null = null
  if (err instanceof RateLimitedError && err.retryAfterMs !== null) ms = err.retryAfterMs
  else if (err instanceof AgentChatError && (err.status === 429 || err.status === 503) && err.retryAfterS !== null) {
    ms = err.retryAfterS * 1000
  }
  return ms === null ? null : Math.min(SERVER_WAIT_MAX_MS, Math.max(0, ms))
}

function failureText(err: unknown): string {
  if (err instanceof AgentChatError) return `${err.status} ${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

export class ListenerReporter {
  readonly instanceId: string
  private readonly client: ListenerReportClient
  private readonly resendMs: number
  private readonly coalesceMs: number
  private readonly minIntervalMs: number
  private readonly retryMs: number
  private readonly retryMaxMs: number
  private readonly onError: (error: Error) => void
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void

  /** What `set()` last said, and when it changed. */
  private desired: Report | null = null
  private changedAt = 0
  /** What the server last accepted, and when. */
  private reported: (Report & { readonly at: number }) | null = null
  private inFlight: { readonly report: Report; readonly controller: AbortController; readonly done: Promise<boolean> } | null = null
  private timer: TimerHandle | null = null
  private dueAt: number | null = null
  private lastAttemptAt: number | null = null
  private failures = 0
  /** No attempt before this, after a failure (our backoff, or the server's word). */
  private retryAt = 0
  /** No attempt before this because the server said so (`flush()` respects it too). */
  private serverWaitUntil = 0
  private _lastError: string | null = null
  private stopped = false

  constructor(options: ListenerReporterOptions) {
    if (!isListenerInstanceId(options.instanceId)) {
      throw new TypeError('ListenerReporter: instanceId must be 8 to 64 of A-Z a-z 0-9 _ - (integration.listenerInstanceId)')
    }
    this.client = options.client
    this.instanceId = options.instanceId
    this.resendMs = options.resendMs ?? LISTENER_REPORT_RESEND_MS
    this.coalesceMs = options.coalesceMs ?? LISTENER_REPORT_COALESCE_MS
    this.minIntervalMs = options.minIntervalMs ?? LISTENER_REPORT_MIN_INTERVAL_MS
    this.retryMs = options.retryMs ?? LISTENER_REPORT_RETRY_MS
    this.retryMaxMs = Math.max(this.retryMs, options.retryMaxMs ?? LISTENER_REPORT_RETRY_MAX_MS)
    this.onError = options.onError ?? (() => undefined)
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
  }

  /**
   * Say what is true now. A change of state (or of the reason, for
   * `runs_failing` and `not_ready`) is reported about a second later; the
   * same state again is nothing. `reasonKind` is ignored for `ok` and
   * `stopped`. Never throws for a send; throws a `TypeError` only for a
   * state or reason that is not one of the contract's. After `stop()` it
   * does nothing.
   */
  set(state: ListenerState, reasonKind?: ListenerReasonKind): void {
    if (!LISTENER_STATES.has(state)) throw new TypeError(`ListenerReporter.set: unknown state ${JSON.stringify(state)}`)
    if (reasonKind !== undefined && !LISTENER_REASONS.has(reasonKind)) {
      throw new TypeError(`ListenerReporter.set: unknown reasonKind ${JSON.stringify(reasonKind)}`)
    }
    if (this.stopped) return
    const next: Report = { state, reasonKind: reasonOf(state, reasonKind) }
    if (sameReport(this.desired, next)) {
      // Nothing new; but if nothing is armed or under way, make sure what is due is.
      if (this.timer === null && this.inFlight === null) this.schedule()
      return
    }
    // The wait runs from the first change the server has not heard of, so a
    // state that keeps changing is still reported, at its latest.
    if (!this.pending()) this.changedAt = this.now()
    this.desired = next
    this.schedule()
  }

  /**
   * Send what `set()` last said now, without the coalescing delay or the
   * once-a-minute spacing (a wait the server named is still kept). Resolves
   * true once the server holds it (also when it already did, or nothing was
   * set), false when the attempt failed, the server asked to wait, or the
   * reporter is stopped. Never rejects.
   */
  async flush(): Promise<boolean> {
    for (;;) {
      if (this.stopped) return false
      if (!this.pending()) return true
      let inFlight = this.inFlight
      if (inFlight === null) {
        if (this.now() < this.serverWaitUntil) return false
        this.send()
        inFlight = this.inFlight!
      }
      const accepted = await inFlight.done
      // The send under way was for what `set()` still says: its answer is the answer.
      if (sameReport(inFlight.report, this.desired) || this.stopped) return accepted
    }
  }

  /** Stop: no more reports, its timer cleared, a report under way abandoned. Idempotent. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearTimer()
    this.inFlight?.controller.abort()
  }

  status(): ListenerReporterStatus {
    const reported = this.reported
    return {
      instanceId: this.instanceId,
      state: this.desired?.state ?? null,
      reasonKind: this.desired?.reasonKind ?? null,
      reported:
        reported === null
          ? null
          : { state: reported.state, reasonKind: reported.reasonKind, at: new Date(reported.at).toISOString() },
      pending: this.pending(),
      failures: this.failures,
      lastError: this._lastError,
      nextAttemptAt: this.dueAt === null ? null : new Date(this.dueAt).toISOString(),
      stopped: this.stopped,
    }
  }

  /**
   * Whether the server does not (or will not, once the report under way
   * lands) hold what `set()` said: a report in flight for another state
   * counts, since it will replace what the server holds.
   */
  private pending(): boolean {
    if (this.desired === null) return false
    if (this.inFlight !== null && !sameReport(this.inFlight.report, this.desired)) return true
    return !sameReport(this.desired, this.reported)
  }

  /** When the next attempt is due, or null when nothing is to be sent. */
  private nextDue(): number | null {
    const desired = this.desired
    if (desired === null) return null
    let due: number
    if (sameReport(desired, this.reported)) {
      // The server holds it: refresh it while it is not ok, before it goes stale.
      if (desired.state === 'ok') return null
      due = this.reported!.at + this.resendMs
    } else {
      due = this.changedAt + this.coalesceMs
    }
    due = Math.max(due, this.retryAt)
    if (this.lastAttemptAt !== null) due = Math.max(due, this.lastAttemptAt + this.minIntervalMs)
    return due
  }

  private schedule(): void {
    if (this.stopped || this.inFlight !== null) return
    const due = this.nextDue()
    if (due === null) {
      this.clearTimer()
      return
    }
    if (this.timer !== null && this.dueAt === due) return
    this.clearTimer()
    this.dueAt = due
    this.timer = this._setTimeout(() => {
      this.timer = null
      this.dueAt = null
      this.tick()
    }, Math.min(TIMER_MAX_MS, Math.max(0, due - this.now())))
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private tick(): void {
    if (this.stopped || this.inFlight !== null) return
    const due = this.nextDue()
    if (due === null) return
    if (due > this.now()) {
      this.schedule()
      return
    }
    void this.send()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
    this.dueAt = null
  }

  /** One attempt for what `set()` says now. Resolves whether the server accepted it; never rejects. */
  private send(): Promise<boolean> {
    const report = this.desired!
    this.clearTimer()
    this.lastAttemptAt = this.now()
    const controller = new AbortController()
    const done = this.attempt(report, controller).finally(() => {
      if (this.inFlight?.done === done) this.inFlight = null
      this.schedule()
    })
    this.inFlight = { report, controller, done }
    return done
  }

  private async attempt(report: Report, controller: AbortController): Promise<boolean> {
    try {
      await this.client.reportListener({
        instanceId: this.instanceId,
        state: report.state,
        ...(report.reasonKind !== null ? { reasonKind: report.reasonKind } : {}),
        signal: controller.signal,
      })
    } catch (err) {
      // Abandoned by stop(): nothing to tell.
      if (this.stopped) return false
      this.failures += 1
      const wait = serverWaitMs(err)
      const backoff = Math.min(this.retryMaxMs, this.retryMs * 2 ** Math.min(this.failures - 1, 20))
      const now = this.now()
      this.retryAt = now + (wait ?? backoff)
      this.serverWaitUntil = wait !== null ? now + wait : 0
      const message = failureText(err)
      if (message !== this._lastError) {
        this._lastError = message
        this.report(new Error(`listener report (${report.state}): ${message}; trying again later`))
      }
      return false
    }
    this.reported = { ...report, at: this.now() }
    this.failures = 0
    this.retryAt = 0
    this.serverWaitUntil = 0
    this._lastError = null
    return true
  }

  private report(error: Error): void {
    try {
      this.onError(error)
    } catch {
      // an observer must not break the reporter
    }
  }
}

// ─── The install's id ────────────────────────────────────────────────────────

/** 16 random bytes, base64url without padding: 22 characters of `A-Z a-z 0-9 _ -`. */
function newInstanceId(): string {
  const bytes = new Uint8Array(16)
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (!cryptoObj?.getRandomValues) throw new Error('listenerInstanceId: no crypto.getRandomValues in this runtime')
  cryptoObj.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function readInstanceId(file: string): Promise<string | null> {
  const bytes = await readBytes(file)
  if (bytes === null) return null
  const id = new TextDecoder().decode(bytes).trim()
  return isListenerInstanceId(id) ? id : null
}

/**
 * This install's listener id, kept in `file` (one line, mode 0600): read
 * when the file holds one, else made (22 random characters of `A-Z a-z 0-9
 * _ -`) and written once. Of two processes that start together, both get the
 * id that was written first. A file that holds no valid id (damaged, edited)
 * is replaced by a new one. Keep `file` with the install (beside its
 * credentials, say); a new id is a new install to the server. Throws when
 * the file can be neither read nor written.
 */
export async function listenerInstanceId(file: string): Promise<string> {
  const held = await readInstanceId(file)
  if (held !== null) return held
  const id = newInstanceId()
  if (await createOnce(file, `${id}\n`, { mode: 0o600 })) return id
  // Another process wrote first (or a file without a valid id is in the way).
  const theirs = await readInstanceId(file)
  if (theirs !== null) return theirs
  await writeAtomic(file, `${id}\n`, { mode: 0o600 })
  return id
}
