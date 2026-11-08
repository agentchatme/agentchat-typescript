/**
 * Wake coalescing: one cycle per burst, never one per frame.
 *
 * A wake is a hint that the tray may have changed, never the carrier of what
 * changed: a `message.new` frame, a `wake` frame, a (re)connect, a webhook
 * the integration received. A group waking up arrives as many frames seconds
 * apart; whoever runs the cycle reads the whole tray, so nothing a later
 * frame announced is missed. The tray is the truth, the wake is not.
 *
 * Timing (conformance `coalescer.cases.json`):
 *   - The window is trailing-edge: every wake moves the start to `quietMs`
 *     after it, but never past `maxMs` after the burst's first wake, so a
 *     steady trickle cannot starve the cycle.
 *   - One cycle at a time. A wake while a cycle runs earns exactly one more
 *     cycle after it, however many arrive: due `quietMs` after the last of
 *     them, capped at `maxMs` after the first, never before the cycle ended.
 *
 * There is no delayed or retry wake here: the server re-wakes unanswered
 * cards on its own durable ladder (contract v1, D3), so an integration keeps
 * no retry ladder of its own.
 *
 * Where the copies this replaces differed (OpenClaw `integration/wake.ts`,
 * agent-core `integration/wake.ts`, Hermes `wake.py`): the OpenClaw window
 * (trailing edge with a cap) is kept over the fixed window the other two
 * used; the "one more cycle" rule the three invokers each wrote is kept here,
 * in one place; `wakeAfter` / `cancelDelayed` (the local retry ladder) are
 * gone.
 */

export const DEFAULT_QUIET_MS = 2_000
export const DEFAULT_MAX_MS = 6_000

export type TimerHandle = ReturnType<typeof setTimeout>

export interface WakeCoalescerOptions {
  /** The cycle. Its promise settling (either way) ends the cycle. */
  readonly onCycle: () => void | Promise<unknown>
  /** Quiet time after the last wake before the cycle starts. Default 2000. */
  readonly quietMs?: number
  /** A burst starts its cycle no later than this after its first wake. Default 6000. */
  readonly maxMs?: number
  /** Called when `onCycle` throws or rejects; the coalescer carries on either way. */
  readonly onError?: (error: unknown) => void
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

export type CoalescerState = 'idle' | 'waiting' | 'running' | 'stopped'

export interface CoalescerCounters {
  /** Every `wake()` accepted (not after stop). */
  readonly wakes: number
  /** Wakes that joined a window or a running cycle instead of starting one. */
  readonly absorbed: number
  /** Cycles started. */
  readonly cycles: number
}

export class WakeCoalescer {
  private readonly onCycle: () => void | Promise<unknown>
  private readonly onError: (error: unknown) => void
  private readonly quietMs: number
  private readonly maxMs: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void

  private timer: TimerHandle | null = null
  /** First wake of the burst the armed timer belongs to. */
  private burstStartedAt: number | null = null
  private running = false
  /** Wakes that arrived while the cycle ran: first and last. */
  private pendingFirstAt: number | null = null
  private pendingLastAt: number | null = null
  private stopped = false
  private current: Promise<void> | null = null

  private wakeCount = 0
  private absorbedCount = 0
  private cycleCount = 0

  constructor(options: WakeCoalescerOptions) {
    const quiet = options.quietMs ?? DEFAULT_QUIET_MS
    const max = options.maxMs ?? DEFAULT_MAX_MS
    if (!(quiet >= 0) || !Number.isFinite(quiet)) throw new RangeError('quietMs must be a finite number >= 0')
    if (!(max >= quiet) || !Number.isFinite(max)) throw new RangeError('maxMs must be a finite number >= quietMs')
    this.onCycle = options.onCycle
    this.onError = options.onError ?? (() => undefined)
    this.quietMs = quiet
    this.maxMs = max
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle))
  }

  get state(): CoalescerState {
    if (this.stopped) return 'stopped'
    if (this.running) return 'running'
    return this.timer !== null ? 'waiting' : 'idle'
  }

  /** True while a wake that arrived during the running cycle is waiting for it to end. */
  get pending(): boolean {
    return this.pendingFirstAt !== null
  }

  counters(): CoalescerCounters {
    return { wakes: this.wakeCount, absorbed: this.absorbedCount, cycles: this.cycleCount }
  }

  /** A wake. Starts a window, joins the open one, or earns one more cycle after the running one. */
  wake(): void {
    if (this.stopped) return
    this.wakeCount += 1
    const now = this.now()
    if (this.running) {
      if (this.pendingFirstAt === null) this.pendingFirstAt = now
      else this.absorbedCount += 1
      this.pendingLastAt = now
      return
    }
    if (this.timer === null) {
      this.burstStartedAt = now
      this.arm(this.quietMs)
      return
    }
    this.absorbedCount += 1
    const capAt = (this.burstStartedAt ?? now) + this.maxMs
    this.arm(Math.max(0, Math.min(now + this.quietMs, capAt) - now))
  }

  /** Cancel the window and drop pending wakes; a running cycle finishes on its own. Later wakes are ignored. */
  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.pendingFirstAt = null
    this.pendingLastAt = null
  }

  /** Resolves when the running cycle (if any) has ended. */
  idle(): Promise<void> {
    return this.current ?? Promise.resolve()
  }

  private arm(delayMs: number): void {
    this.clearTimer()
    this.timer = this._setTimeout(() => {
      this.timer = null
      this.startCycle()
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this._clearTimeout(this.timer)
      this.timer = null
    }
  }

  private startCycle(): void {
    if (this.stopped || this.running) return
    this.burstStartedAt = null
    this.running = true
    this.cycleCount += 1
    let result: void | Promise<unknown>
    try {
      result = this.onCycle()
    } catch (err) {
      this.report(err)
      result = undefined
    }
    const done = Promise.resolve(result).then(
      () => undefined,
      (err: unknown) => this.report(err),
    )
    this.current = done.then(() => this.endCycle())
  }

  private endCycle(): void {
    this.running = false
    this.current = null
    const first = this.pendingFirstAt
    const last = this.pendingLastAt
    this.pendingFirstAt = null
    this.pendingLastAt = null
    if (this.stopped || first === null || last === null) return
    const now = this.now()
    const dueAt = Math.max(now, Math.min(last + this.quietMs, first + this.maxMs))
    this.burstStartedAt = first
    this.arm(dueAt - now)
  }

  private report(err: unknown): void {
    try {
      this.onError(err)
    } catch {
      // an observer must not break the coalescer
    }
  }
}
