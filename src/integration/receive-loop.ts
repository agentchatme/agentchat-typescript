/**
 * The receive loop: the socket as a wake, one cycle per burst, the tray, the
 * gate call or the run, and what is recorded afterwards. Optional — every
 * part it uses is exported on its own.
 *
 * Two modes (contract v1, D5):
 *
 * - `gateCall` (Hermes, OpenClaw): read the tray, ask the agent's own model
 *   the served gate question in a tool-less call (`callModel`), record
 *   `dismiss` / `defer` at once, start one turn per `reply` (`startTurn`),
 *   and when a turn has ended record from what actually happened
 *   (`turnOutcome`). Each pending invite on the tray gets one invite turn
 *   (`startInviteTurn`, default `startTurn`) and the same rule.
 * - `singleRun` (Claude Code, Codex, routines, a listener): when anything is
 *   owed, start one run (`startRun`) with the served wake text; the run reads
 *   the tray itself and records its own verdicts. The loop records nothing
 *   for cards. An invite still pending and undismissed after two completed
 *   runs is dismissed (seen, left pending, not shown again), so an ignored
 *   invite does not cost a run on every wake; the count is in memory only
 *   (`dismissIgnoredInvites: false` turns this off).
 *
 * Wakes: a `message.new` frame that is not the echo of the agent's own send,
 * a `wake` frame (a reminder, or unanswered cards), every accepted HELLO (a
 * reconnect after a heartbeat gap included), a `group.invite.received`
 * frame, and `wake()` for whatever the integration hears itself (a wake
 * webhook). The socket is the SDK's `RealtimeClient` with `ackOnReceipt` and
 * the `ack`, `heartbeat` and `rewake` capabilities: delivered means this
 * machine received the message; only a verdict reads it.
 *
 * Turns: at most `maxConcurrentTurns` (default 1) reply and invite turns run
 * at once; the rest wait for a slot, held out of the gate meanwhile (their
 * cards stay on the tray; nothing is recorded for them; no second model call
 * decides them again). `stop()` drops the waiting ones. A turn that ends
 * after `stop()` still has its outcome recorded: what it did is a fact.
 * `startTurn` / `startRun` must enforce their own deadline (the loop cannot
 * end a turn); `status()` marks a turn running longer than 30 minutes.
 *
 * Pacing (D5): after a silent turn (it looked and did nothing) the same
 * conversation at the same anchor is not gated again for `paceMs` (60 s)
 * unless a newer message moves its anchor or an `unanswered` wake names it;
 * after an invite turn that left the invite pending, no second invite turn
 * for it within `paceMs` unless an `unanswered` wake arrives (those name no
 * invites). In memory.
 *
 * There is no retry ladder here. A cycle that could not finish (the tray
 * could not be read, the model failed, a turn was refused or failed) leaves
 * the cards on the tray and does nothing more: the server re-wakes
 * unanswered cards on its own durable ladder (D3). The one wake the loop
 * gives itself is for a truncated tray (read the rest): at once after a cycle
 * that recorded a verdict or started a turn; otherwise after a backoff
 * (1 s doubling to 60 s), so a cycle that cannot progress never spins.
 */

import type { AgentChatClient } from '../client.js'
import { RealtimeClient, type RealtimeOptions, type RealtimeState } from '../realtime.js'
import { anchorOf, cardsOf, run as runGate, type GateModelCall, type GateReply, type ToolNamer } from '../gate.js'
import type { InboxCard, InboxTray, Texts, TrayInvite, WsMessage } from '../types/index.js'
import type { AgentChatClientIdentity } from '../client-identity.js'
import { WakeCoalescer, type CoalescerState, type TimerHandle } from './coalescer.js'
import {
  applyInviteOutcome,
  applyOutcome,
  inviteOutcome,
  turnOutcome,
  type InviteOutcome,
  type TurnEnd,
  type TurnOutcome,
} from './outcome.js'
import { TurnTracker, type RunningTurn, type TurnHandle } from './turn-tracker.js'
import { normalizeHandle } from './anchor.js'

/** Largest tray the server builds: the loop always reads all of it. */
const TRAY_LIMIT = 50
/** Silent-turn and pacing memory, bounded. */
const SILENT_MEMORY = 1_000
/** D5 pacing: how long a silent turn's card (or an invite after its turn) is not gated again. */
export const PACE_MS = 60_000
/** A running turn older than this is shown as overdue in `status()`. */
export const TURN_OVERDUE_MS = 30 * 60_000
/** The truncated-tray self-wake after a cycle that made no progress: 1 s, doubling, at most 60 s. */
const NO_PROGRESS_BACKOFF_MS = 1_000
const NO_PROGRESS_BACKOFF_MAX_MS = 60_000
/** The gate call's deadline: past it the cycle fails closed for its cards. */
export const GATE_CALL_TIMEOUT_MS = 60_000
/** A cycle's deadline, not counting time inside turns and runs: past it the cycle is abandoned. */
export const CYCLE_TIMEOUT_MS = 10 * 60_000
/** How many cycle summaries `status().recentCycles` keeps. */
const RECENT_CYCLES = 20

/** One cycle's clock and identity: abandoned cycles go stale and stop acting. */
interface CycleRun {
  readonly token: number
  readonly signal: AbortSignal
  stale(): boolean
  /** Await work whose time does not count against the cycle deadline (turn admissions, runs). */
  exclude<T>(work: () => Promise<T>): Promise<T>
}

export type ReceiveLoopMode = 'gateCall' | 'singleRun'

/** One turn the loop asks the runtime to start (gate-call mode). */
export type TurnRequest =
  | {
      readonly kind: 'reply'
      readonly conversationId: string
      /** The card the gate decided on. */
      readonly card: InboxCard
      /** The message the gate's verdict reads through. */
      readonly anchor: string | null
      readonly category: string | null
      /** The served wake instruction and the conversation id: what the turn starts with. */
      readonly prompt: string
      readonly texts: Texts
      /** Aborted when the loop stops. */
      readonly signal: AbortSignal
    }
  | {
      readonly kind: 'invite'
      readonly invite: TrayInvite
      /** The served invite prompt and the invite id. */
      readonly prompt: string
      readonly texts: Texts
      readonly signal: AbortSignal
    }

/**
 * Whether the runtime admitted the turn. `done` resolves with what the
 * runtime reports when it ends — `still_running` (with `next` when known) if
 * the integration stopped waiting before the end. It should not reject (a
 * rejection counts as a failed turn). The runtime enforces the turn's own
 * deadline; the loop never ends a turn.
 */
export type TurnAdmission =
  | { readonly started: false; readonly error?: string }
  | { readonly started: true; readonly done: Promise<TurnEnd> }

export type TurnStarter = (request: TurnRequest) => Promise<TurnAdmission>

/** The one run the loop asks for (single-run mode). */
export interface RunRequest {
  /** The served wake instruction (and the invite prompt when invites wait), or the invite prompt alone. */
  readonly prompt: string
  readonly texts: Texts
  /** Unanswered cards and pending invites on the tray that started it; null when the tray could not be read. */
  readonly cards: number | null
  readonly invites: number | null
  readonly signal: AbortSignal
}

export interface RunEnd {
  readonly status: 'completed' | 'failed' | 'not_started'
  readonly detail?: string
}

/** Starts the one run and resolves when it ends. Enforce the run's deadline here: the loop never ends a run. */
export type RunStarter = (request: RunRequest) => Promise<RunEnd>

/** Whether a turn started now could reach AgentChat (e.g. `probeHostedTools`); checked before a cycle spends a model call. */
export type Readiness = () =>
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string }
  | Promise<{ readonly ready: true } | { readonly ready: false; readonly reason: string }>

/** Where the loop reads the served texts; a `TextsCache` satisfies it. */
export interface TextsSource {
  current(): Texts | null
  ensure(): Promise<Texts | null>
  readonly source?: string
  readonly fetchedAt?: string | null
  readonly lastError?: string | null
}

export type WakeSource = 'message' | 'wake_frame' | 'connect' | 'invite' | 'external' | 'more'

export type CycleOutcome =
  /** The tray had no cards and no invites. */
  | 'empty'
  /** Cards were there, but only muted ones, paced ones or ones a turn holds. */
  | 'nothing_owed'
  | 'tray_failed'
  | 'texts_missing'
  | 'tools_unavailable'
  /** gateCall: the gate decided (turns started or queued for the replies). */
  | 'decided'
  /** gateCall: the model failed or answered nothing usable; nothing recorded. */
  | 'fail_closed'
  /** gateCall: only invites were owed; their turns were started or queued. */
  | 'invites_only'
  /** singleRun: the run's end. */
  | 'run_completed'
  | 'run_failed'
  | 'run_not_started'
  /** The cycle ran past `cycleTimeoutMs` and was abandoned; the next wake runs a new one. */
  | 'abandoned'

export interface CycleSummary {
  readonly at: string
  readonly outcome: CycleOutcome
  readonly cards: number
  readonly invites: number
  readonly gated: number
  readonly reply: number
  readonly dismiss: number
  readonly defer: number
  readonly undecided: number
  /** `dismiss` / `defer` verdicts the gate recorded. */
  readonly recorded: number
  readonly recordFailures: number
  readonly turnsStarted: number
  readonly turnsRefused: number
  /** Reply or invite turns waiting for a slot (`maxConcurrentTurns`). */
  readonly turnsQueued: number
  /** Cards left out because a turn for their conversation is running or waiting. */
  readonly heldByTurns: number
  /** Cards and invites left out by D5 pacing (a recent silent turn). */
  readonly paced: number
  readonly truncated: boolean
  readonly failure: string | null
}

export type ReceiveLoopEvent =
  | {
      readonly type: 'wake'
      readonly source: WakeSource
      readonly conversationId?: string
      /** A wake frame's `reason` (`reminder`, `unanswered`, …). */
      readonly reason?: string
      /** An `unanswered` wake frame's conversations. */
      readonly conversationIds?: string[]
    }
  | { readonly type: 'echo'; readonly conversationId?: string }
  | { readonly type: 'cycle'; readonly summary: CycleSummary }
  | { readonly type: 'turn_started'; readonly request: Omit<TurnRequest, 'signal' | 'texts'> }
  | { readonly type: 'turn_refused'; readonly kind: 'reply' | 'invite'; readonly id: string; readonly error: string | null }
  | { readonly type: 'turn_outcome'; readonly outcome: TurnOutcome; readonly recorded: boolean }
  | { readonly type: 'invite_outcome'; readonly outcome: InviteOutcome; readonly recorded: boolean }
  | { readonly type: 'run'; readonly end: RunEnd }
  | { readonly type: 'error'; readonly error: Error }

export interface ReceiveLoopSocketOptions {
  /** The agent's API key; the socket authenticates with it. */
  readonly apiKey: string
  /** `wss://…`; default: the client's base URL with `http` → `ws`. */
  readonly baseUrl?: string
  readonly clientIdentity?: AgentChatClientIdentity
  readonly webSocket?: RealtimeOptions['webSocket']
  readonly reconnectInterval?: number
  readonly maxReconnectInterval?: number
}

/** What the loop calls on the client; `AgentChatClient` satisfies it. */
export type ReceiveLoopClient = Pick<AgentChatClient, 'inbox' | 'decisions' | 'groups'> & { readonly baseUrl?: string }

export interface ReceiveLoopOptions {
  readonly client: ReceiveLoopClient
  readonly texts: TextsSource
  readonly mode: ReceiveLoopMode
  /** gateCall: the tool-less model call that answers the gate question. */
  readonly callModel?: GateModelCall
  /** gateCall: starts one reply turn (and invite turns, unless `startInviteTurn`). */
  readonly startTurn?: TurnStarter
  /** gateCall: starts one invite turn. Default: `startTurn`. */
  readonly startInviteTurn?: TurnStarter
  /** singleRun: starts the one run. */
  readonly startRun?: RunStarter
  /**
   * The socket: options to build one (needs the API key), a `RealtimeClient`
   * you built (the loop attaches its handlers and connects and disconnects
   * it; build it with `ackOnReceipt: true` and `capabilities: { rewake: true }`),
   * or `null` for none (wakes only through `wake()`).
   */
  readonly socket: ReceiveLoopSocketOptions | RealtimeClient | null
  /** This agent's handle, for the echo filter. Default: learned from the tray's `you`. */
  readonly handle?: string
  /** How this runtime spells the hosted tools named in the tray's question (gate call). */
  readonly toolNamer?: ToolNamer
  readonly readiness?: Readiness
  /** Reply and invite turns running at once (gateCall). Default 1. */
  readonly maxConcurrentTurns?: number
  /** D5 pacing window. Default `PACE_MS` (60 s). */
  readonly paceMs?: number
  /** A tracker shared with other loops or the integration; default: the loop's own. */
  readonly tracker?: TurnTracker
  /**
   * The gate call's deadline (`GATE_CALL_TIMEOUT_MS`, 60 s). Past it the
   * cycle fails closed for its cards (nothing recorded; the next wake asks
   * again) and the call's `signal` aborts.
   */
  readonly gateCallTimeoutMs?: number
  /**
   * A cycle's deadline (`CYCLE_TIMEOUT_MS`, 10 min), not counting time
   * inside turn admissions and runs. A cycle past it is abandoned (it stops
   * acting at its next step), reported once, and the loop takes wakes again.
   */
  readonly cycleTimeoutMs?: number
  /**
   * singleRun: dismiss an invite still pending after two completed runs that
   * left it (default `true`), so an ignored invite does not cost a run on
   * every wake. `false` leaves every invite to the runs (a host that
   * forwards invites elsewhere): nothing is recorded for them.
   */
  readonly dismissIgnoredInvites?: boolean
  readonly quietMs?: number
  readonly maxMs?: number
  readonly onEvent?: (event: ReceiveLoopEvent) => void
  readonly now?: () => number
  readonly setTimeout?: (fn: () => void, ms: number) => TimerHandle
  readonly clearTimeout?: (handle: TimerHandle) => void
}

export interface ReceiveLoopStatus {
  readonly mode: ReceiveLoopMode
  readonly started: boolean
  readonly stopped: boolean
  readonly handle: string | null
  readonly socket: { readonly state: RealtimeState; readonly ackNegotiated: boolean; readonly capabilities: string[] } | null
  readonly coalescer: { readonly state: CoalescerState; readonly wakes: number; readonly absorbed: number; readonly cycles: number }
  readonly texts: {
    readonly version: string | null
    readonly manualVersion: string | null
    readonly source: string | null
    readonly fetchedAt: string | null
    readonly lastError: string | null
  }
  readonly lastCycle: CycleSummary | null
  /** The last cycles, newest last (at most 20). */
  readonly recentCycles: CycleSummary[]
  /** Turns the tracker holds; `overdue` past 30 minutes (the runtime should have ended it). */
  readonly turns: Array<RunningTurn & { readonly overdue: boolean }>
  readonly counters: {
    readonly frames: number
    readonly echoes: number
    readonly turnsStarted: number
    readonly turnsRefused: number
    readonly turnsQueued: number
    readonly inviteTurnsStarted: number
    /** Turns holding a slot now. */
    readonly turnsActive: number
    /** Turns waiting for a slot now. */
    readonly turnsWaiting: number
    readonly runsStarted: number
    readonly runsCompleted: number
    readonly runsFailed: number
    readonly runsNotStarted: number
    readonly outcomes: Readonly<Record<string, number>>
    readonly outcomeRecordFailures: number
  }
  readonly lastError: string | null
}

/** D5 pacing, in memory: a key (`conversation:<id>` / `invite:<id>`) held until a time, for one anchor. */
class Pacer {
  private readonly until = new Map<string, { anchor: string | null; until: number }>()
  constructor(
    private readonly paceMs: number,
    private readonly now: () => number,
  ) {}

  hold(key: string, anchor: string | null): void {
    this.until.delete(key)
    this.until.set(key, { anchor, until: this.now() + this.paceMs })
    while (this.until.size > SILENT_MEMORY) {
      const oldest = this.until.keys().next().value
      if (oldest === undefined) break
      this.until.delete(oldest)
    }
  }

  held(key: string, anchor: string | null): boolean {
    const entry = this.until.get(key)
    if (!entry) return false
    if (entry.anchor !== anchor || this.now() >= entry.until) {
      this.until.delete(key)
      return false
    }
    return true
  }

  release(key: string): void {
    this.until.delete(key)
  }

  releaseInvites(): void {
    for (const key of [...this.until.keys()]) if (key.startsWith('invite:')) this.until.delete(key)
  }
}

type Launch = 'started' | 'refused' | 'queued'

export class ReceiveLoop {
  private readonly options: ReceiveLoopOptions
  private readonly client: ReceiveLoopClient
  private readonly coalescer: WakeCoalescer
  private readonly tracker: TurnTracker
  private readonly pacer: Pacer
  private readonly maxTurns: number
  private readonly now: () => number
  private readonly _setTimeout: (fn: () => void, ms: number) => TimerHandle
  private readonly _clearTimeout: (handle: TimerHandle) => void
  private readonly abort = new AbortController()
  private readonly realtime: RealtimeClient | null
  private readonly unsubscribe: Array<() => void> = []
  private readonly silent = new Map<string, number>()
  private readonly waiting: Array<{ handle: TurnHandle; admit: () => Promise<boolean> }> = []
  /** Turns holding a slot (admitted, not yet ended or released). */
  private readonly slotted = new Set<TurnHandle>()

  private handle: string | null
  private started = false
  private stopped = false
  private heldWhileRunning = false
  private activeTurns = 0
  private noProgressStreak = 0
  private moreTimer: TimerHandle | null = null
  private lastCycle: CycleSummary | null = null
  private readonly recentCycles: CycleSummary[] = []
  private cycleToken = 0
  private readonly gateCallTimeoutMs: number
  private readonly cycleTimeoutMs: number
  private lastError: string | null = null
  private readonly counts = {
    frames: 0,
    echoes: 0,
    turnsStarted: 0,
    turnsRefused: 0,
    turnsQueued: 0,
    inviteTurnsStarted: 0,
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsNotStarted: 0,
    outcomeRecordFailures: 0,
  }
  private readonly outcomes: Record<string, number> = {}
  private readonly pendingWork = new Set<Promise<unknown>>()

  constructor(options: ReceiveLoopOptions) {
    if (options.mode === 'gateCall' && (!options.callModel || !options.startTurn)) {
      throw new Error('ReceiveLoop: gateCall mode needs callModel and startTurn')
    }
    if (options.mode === 'singleRun' && !options.startRun) {
      throw new Error('ReceiveLoop: singleRun mode needs startRun')
    }
    const maxTurns = options.maxConcurrentTurns ?? 1
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new RangeError('ReceiveLoop: maxConcurrentTurns must be an integer >= 1')
    this.options = options
    this.client = options.client
    this.now = options.now ?? Date.now
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((h) => clearTimeout(h))
    this.maxTurns = maxTurns
    this.gateCallTimeoutMs = positive(options.gateCallTimeoutMs, GATE_CALL_TIMEOUT_MS)
    this.cycleTimeoutMs = positive(options.cycleTimeoutMs, CYCLE_TIMEOUT_MS)
    this.handle = options.handle ? normalizeHandle(options.handle) : null
    this.tracker = options.tracker ?? new TurnTracker({ now: this.now })
    // A released turn (here, or by another holder of a shared tracker) frees
    // its slot at once: the runtime may never end it.
    this.unsubscribe.push(this.tracker.onRelease((handle) => this.releaseSlot(handle)))
    this.pacer = new Pacer(options.paceMs ?? PACE_MS, this.now)
    this.coalescer = new WakeCoalescer({
      onCycle: () => this.cycle(),
      onError: (err) => this.fail(err),
      ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
      ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
      now: this.now,
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    })
    const socket = options.socket
    if (socket === null) this.realtime = null
    else if (socket instanceof RealtimeClient) this.realtime = socket
    else {
      this.realtime = new RealtimeClient({
        apiKey: socket.apiKey,
        baseUrl: socket.baseUrl ?? wsBase(this.client.baseUrl),
        client: this.client as AgentChatClient,
        ackOnReceipt: true,
        capabilities: { heartbeat: true, rewake: true },
        ...(socket.clientIdentity ? { clientIdentity: socket.clientIdentity } : {}),
        ...(socket.webSocket ? { webSocket: socket.webSocket } : {}),
        ...(socket.reconnectInterval !== undefined ? { reconnectInterval: socket.reconnectInterval } : {}),
        ...(socket.maxReconnectInterval !== undefined ? { maxReconnectInterval: socket.maxReconnectInterval } : {}),
      })
    }
  }

  /** Attach to the socket and connect it; with no socket, wait for `wake()`. Resolves once the connect loop has started. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    const rt = this.realtime
    if (rt === null) return
    this.unsubscribe.push(
      rt.on('message.new', (message) => this.onMessage(message)),
      rt.on('wake', (frame) => this.onWakeFrame(frame.payload as unknown as Record<string, unknown>)),
      rt.on('group.invite.received', () => {
        this.counts.frames += 1
        this.wakeFrom('invite')
      }),
      rt.onConnect(() => this.wakeFrom('connect')),
      rt.onError((error) => this.emit({ type: 'error', error })),
    )
    try {
      await rt.connect()
    } catch (err) {
      // No WebSocket implementation is a configuration error; report it. Every other failure is the client's own retry.
      this.fail(err)
    }
  }

  /** A wake the integration heard itself (a wake webhook, a timer of its own). */
  wake(): void {
    this.wakeFrom('external')
  }

  /**
   * Stop: no new cycles or turns, waiting turns dropped (their cards stay on
   * the tray), the socket closed, running turns and runs signalled through
   * their `AbortSignal`. Resolves when the running cycle and any recording
   * already under way have finished. A turn that ends later still has its
   * outcome recorded.
   */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.coalescer.stop()
    this.clearMoreTimer()
    this.abort.abort()
    for (const { handle } of this.waiting.splice(0)) this.tracker.end(handle)
    for (const off of this.unsubscribe.splice(0)) {
      try {
        off()
      } catch {
        // already gone
      }
    }
    try {
      this.realtime?.disconnect()
    } catch {
      // already closed
    }
    await this.coalescer.idle()
    await Promise.allSettled([...this.pendingWork])
  }

  /** Resolves when the running cycle has finished (tests, graceful stops). */
  idle(): Promise<void> {
    return this.coalescer.idle()
  }

  /** Let go of a turn whose end the runtime will never confirm (an operator's call). Nothing is recorded for it. */
  releaseTurn(key: string): boolean {
    const released = this.tracker.release(key)
    if (released) this.wakeFrom('more')
    return released
  }

  status(): ReceiveLoopStatus {
    const texts = this.options.texts.current()
    const counters = this.coalescer.counters()
    const now = this.now()
    return {
      mode: this.options.mode,
      started: this.started,
      stopped: this.stopped,
      handle: this.handle,
      socket:
        this.realtime === null
          ? null
          : {
              state: this.realtime.state,
              ackNegotiated: this.realtime.ackNegotiated,
              capabilities: [...this.realtime.capabilities].sort(),
            },
      coalescer: { state: this.coalescer.state, ...counters },
      texts: {
        version: texts?.version ?? null,
        manualVersion: texts?.manual?.version ?? null,
        source: this.options.texts.source ?? null,
        fetchedAt: this.options.texts.fetchedAt ?? null,
        lastError: this.options.texts.lastError ?? null,
      },
      lastCycle: this.lastCycle,
      recentCycles: [...this.recentCycles],
      turns: this.tracker.running().map((turn) => ({ ...turn, overdue: now - turn.startedAt > TURN_OVERDUE_MS })),
      counters: {
        ...this.counts,
        turnsActive: this.activeTurns,
        turnsWaiting: this.waiting.length,
        outcomes: { ...this.outcomes },
      },
      lastError: this.lastError,
    }
  }

  // ─── wakes ──────────────────────────────────────────────────────────────

  private onMessage(message: WsMessage): void {
    this.counts.frames += 1
    const payload = (message.payload ?? {}) as Record<string, unknown>
    const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined
    const raw = payload.sender ?? payload.from ?? payload.sender_handle
    const sender = typeof raw === 'string' ? normalizeHandle(raw) : ''
    if (this.handle !== null && sender === this.handle) {
      // The server echoes this agent's own sends back; its own words never wake it.
      this.counts.echoes += 1
      this.emit({ type: 'echo', ...(conversationId ? { conversationId } : {}) })
      return
    }
    this.wakeFrom('message', conversationId)
  }

  private onWakeFrame(payload: Record<string, unknown>): void {
    this.counts.frames += 1
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined
    const id = typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined
    const named = Array.isArray(payload.conversation_ids)
      ? payload.conversation_ids.filter((x): x is string => typeof x === 'string')
      : []
    if (reason === 'unanswered') {
      // The server says these are still unanswered: pacing yields.
      for (const conversationId of named) this.pacer.release(`conversation:${conversationId}`)
      this.pacer.releaseInvites()
    }
    this.wakeFrom('wake_frame', id, {
      ...(reason !== undefined ? { reason } : {}),
      ...(named.length > 0 ? { conversationIds: named } : {}),
    })
  }

  private wakeFrom(
    source: WakeSource,
    conversationId?: string,
    extra: { reason?: string; conversationIds?: string[] } = {},
  ): void {
    if (this.stopped) return
    this.emit({ type: 'wake', source, ...(conversationId ? { conversationId } : {}), ...extra })
    this.coalescer.wake()
  }

  // ─── one cycle ──────────────────────────────────────────────────────────

  private async cycle(): Promise<void> {
    if (this.stopped) return
    const token = ++this.cycleToken
    const controller = new AbortController()
    const startedAt = this.now()
    let excludedMs = 0
    let excludedSince: number | null = null
    let depth = 0
    const run: CycleRun = {
      token,
      signal: controller.signal,
      stale: () => this.cycleToken !== token || this.stopped,
      exclude: async <T>(work: () => Promise<T>): Promise<T> => {
        if (depth++ === 0) excludedSince = this.now()
        try {
          return await work()
        } finally {
          if (--depth === 0 && excludedSince !== null) {
            excludedMs += this.now() - excludedSince
            excludedSince = null
          }
        }
      },
    }
    const work = (async () => {
      const summary =
        this.options.mode === 'gateCall' ? await this.gateCallCycle(run) : await this.singleRunCycle(run)
      if (!run.stale() || this.stopped) this.finishCycle(summary)
    })()
    let timer: TimerHandle | null = null
    const overdue = new Promise<'overdue'>((resolve) => {
      const check = (): void => {
        timer = null
        const now = this.now()
        const excluded = excludedMs + (excludedSince !== null ? now - excludedSince : 0)
        const active = now - startedAt - excluded
        if (active >= this.cycleTimeoutMs) {
          resolve('overdue')
          return
        }
        timer = this._setTimeout(check, Math.max(1, this.cycleTimeoutMs - active))
        ;(timer as { unref?: () => void }).unref?.()
      }
      timer = this._setTimeout(check, this.cycleTimeoutMs)
      ;(timer as { unref?: () => void }).unref?.()
    })
    const result = await Promise.race([work.then(() => 'done' as const), overdue])
    if (timer !== null) this._clearTimeout(timer)
    if (result === 'done') return
    // Abandoned: it acts no more (every step checks `stale()`), its pending
    // calls see an aborted signal, and the coalescer takes wakes again.
    this.cycleToken += 1
    controller.abort()
    void work.catch(() => undefined)
    const failure = `the cycle ran past ${this.cycleTimeoutMs} ms (not counting turns) and was abandoned; the next wake starts a new one`
    this.fail(new Error(failure))
    this.finishCycle(this.summary('abandoned', { failure }))
  }

  private finishCycle(summary: CycleSummary): void {
    this.lastCycle = summary
    this.recentCycles.push(summary)
    if (this.recentCycles.length > RECENT_CYCLES) this.recentCycles.shift()
    if (summary.failure !== null) this.lastError = summary.failure
    this.emit({ type: 'cycle', summary })
  }

  /** The runtime's model call, bounded by `gateCallTimeoutMs` (and the cycle's own abandonment). */
  private boundedModelCall(run: CycleRun): GateModelCall {
    return (prompt) =>
      new Promise<string>((resolve, reject) => {
        const controller = new AbortController()
        const abort = (): void => {
          controller.abort()
          reject(new Error('the cycle was abandoned'))
        }
        if (run.signal.aborted) {
          abort()
          return
        }
        run.signal.addEventListener('abort', abort, { once: true })
        const timer = this._setTimeout(() => {
          run.signal.removeEventListener('abort', abort)
          controller.abort()
          reject(new Error(`no answer within ${this.gateCallTimeoutMs} ms`))
        }, this.gateCallTimeoutMs)
        ;(timer as { unref?: () => void }).unref?.()
        let call: Promise<string>
        try {
          call = Promise.resolve(this.options.callModel!(prompt, { signal: controller.signal }))
        } catch (err) {
          call = Promise.reject(err)
        }
        call.then(
          (text) => {
            this._clearTimeout(timer)
            run.signal.removeEventListener('abort', abort)
            resolve(text)
          },
          (err: unknown) => {
            this._clearTimeout(timer)
            run.signal.removeEventListener('abort', abort)
            reject(err)
          },
        )
      })
  }

  private async readTray(): Promise<InboxTray | null> {
    try {
      // The loop acts on the tray's invites, so it says so to the server
      // (a held wait then also ends for an invite). No stop signal: a turn
      // that ends after stop() still reads the card before its outcome.
      const tray = await this.client.inbox.tray({ waitMs: 0, limit: TRAY_LIMIT, includeInvites: true })
      if (this.handle === null && typeof tray.you === 'string' && tray.you.length > 0) {
        this.handle = normalizeHandle(tray.you)
      }
      return tray
    } catch (err) {
      if (!this.stopped) this.fail(err)
      return null
    }
  }

  private async checkReady(): Promise<string | null> {
    const readiness = this.options.readiness
    if (!readiness) return null
    try {
      const answer = await readiness()
      return answer.ready ? null : answer.reason
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  private async gateCallCycle(run: CycleRun): Promise<CycleSummary> {
    const tray = await this.readTray()
    if (run.stale()) return this.summary('abandoned')
    if (tray === null) return this.summary('tray_failed', { failure: this.lastError })
    const cards = cardsOf(tray)
    const invites = trayInvites(tray)
    const unheld = this.tracker.withoutRunning(cards)
    const heldByTurns = cards.length - unheld.length
    if (heldByTurns > 0) this.heldWhileRunning = true
    const gateCards = unheld.filter((card) => !this.pacer.held(`conversation:${card.conversation_id}`, anchorFrom(card)))
    const openInvites = invites.filter((invite) => !this.tracker.inviteRunning(invite.invite_id))
    const owedInvites = openInvites.filter((invite) => !this.pacer.held(`invite:${invite.invite_id}`, null))
    const paced = unheld.length - gateCards.length + (openInvites.length - owedInvites.length)
    const owedCards = gateCards.filter((card) => card.muted !== true)
    const base = { cards: cards.length, invites: invites.length, heldByTurns, paced, truncated: tray.truncated === true }
    if (cards.length === 0 && invites.length === 0) return this.summary('empty', base)
    if (owedCards.length === 0 && owedInvites.length === 0) return this.summary('nothing_owed', base)

    const texts = await this.options.texts.ensure()
    if (run.stale()) return this.summary('abandoned', base)
    if (texts === null) return this.summary('texts_missing', { ...base, failure: 'the served texts are not available' })
    const unready = await this.checkReady()
    if (run.stale()) return this.summary('abandoned', base)
    if (unready !== null) return this.summary('tools_unavailable', { ...base, failure: unready })

    let gated = 0
    const tally = {
      reply: 0,
      dismiss: 0,
      defer: 0,
      undecided: 0,
      recorded: 0,
      recordFailures: 0,
      turnsStarted: 0,
      turnsRefused: 0,
      turnsQueued: 0,
    }
    let outcome: CycleOutcome = 'invites_only'
    let failure: string | null = null
    if (owedCards.length > 0) {
      gated = gateCards.length
      const result = await runGate({
        tray: { ...tray, conversations: gateCards },
        callModel: this.boundedModelCall(run),
        client: this.client,
        texts,
        ...(this.options.toolNamer ? { toolNamer: this.options.toolNamer } : {}),
      })
      for (const verdict of result.verdicts) tally[verdict.decision] += 1
      tally.undecided = result.undecided.length
      tally.recorded = result.recorded
      tally.recordFailures = result.recordFailures.length
      if (result.outcome === 'fail_closed') {
        outcome = 'fail_closed'
        failure = result.failure
      } else {
        outcome = 'decided'
        for (const reply of result.reply) {
          if (run.stale()) break
          tally[launchKey(await run.exclude(() => this.startReplyTurn(reply, texts)))] += 1
        }
      }
    }
    for (const invite of owedInvites) {
      if (run.stale()) break
      tally[launchKey(await run.exclude(() => this.startInviteTurn(invite, texts)))] += 1
    }
    if (run.stale()) return this.summary('abandoned', base)
    if (tray.truncated === true && outcome === 'decided') {
      this.readTheRest(tally.recorded > 0 || tally.turnsStarted > 0)
    }
    return this.summary(outcome, { ...base, gated, ...tally, failure })
  }

  /**
   * More conversations wait than one tray shows. After a cycle that moved
   * something (a verdict recorded, a turn started) read again at once; after
   * one that did not, wait 1 s, doubling to 60 s, so a cycle that cannot
   * progress (every record failing, every turn refused) never spins.
   */
  private readTheRest(progressed: boolean): void {
    if (this.stopped) return
    if (progressed) {
      this.noProgressStreak = 0
      this.clearMoreTimer()
      this.wakeFrom('more')
      return
    }
    this.noProgressStreak += 1
    if (this.moreTimer !== null) return
    const delay = Math.min(NO_PROGRESS_BACKOFF_MAX_MS, NO_PROGRESS_BACKOFF_MS * 2 ** Math.min(this.noProgressStreak - 1, 16))
    this.moreTimer = this._setTimeout(() => {
      this.moreTimer = null
      this.wakeFrom('more')
    }, delay)
    ;(this.moreTimer as { unref?: () => void }).unref?.()
  }

  private clearMoreTimer(): void {
    if (this.moreTimer !== null) {
      this._clearTimeout(this.moreTimer)
      this.moreTimer = null
    }
  }

  private async singleRunCycle(run: CycleRun): Promise<CycleSummary> {
    const tray = await this.readTray()
    if (run.stale()) return this.summary('abandoned')
    let cards: number | null = null
    let invites: number | null = null
    let base = { cards: 0, invites: 0, heldByTurns: 0, truncated: false }
    if (tray !== null) {
      cards = cardsOf(tray).filter((card) => card.muted !== true).length
      invites = trayInvites(tray).length
      base = { cards: cardsOf(tray).length, invites, heldByTurns: 0, truncated: tray.truncated === true }
      if (base.cards === 0 && invites === 0) return this.summary('empty', base)
      if (cards === 0 && invites === 0) return this.summary('nothing_owed', base)
    }
    // A tray that could not be read is not an empty tray, and the wake was real: the run starts anyway.
    const texts = await this.options.texts.ensure()
    if (run.stale()) return this.summary('abandoned', base)
    if (texts === null) return this.summary('texts_missing', { ...base, failure: 'the served texts are not available' })
    const unready = await this.checkReady()
    if (run.stale()) return this.summary('abandoned', base)
    if (unready !== null) return this.summary('tools_unavailable', { ...base, failure: unready })

    const prompt =
      cards === 0 && (invites ?? 0) > 0
        ? texts.invite_prompt.trim()
        : (invites ?? 0) > 0
          ? `${texts.wake_instruction.trim()}\n\n${texts.invite_prompt.trim()}`
          : texts.wake_instruction.trim()
    this.counts.runsStarted += 1
    let end: RunEnd
    try {
      end = await run.exclude(() => this.options.startRun!({ prompt, texts, cards, invites, signal: this.abort.signal }))
    } catch (err) {
      end = { status: 'not_started', detail: err instanceof Error ? err.message : String(err) }
    }
    if (end.status === 'completed') this.counts.runsCompleted += 1
    else if (end.status === 'failed') this.counts.runsFailed += 1
    else this.counts.runsNotStarted += 1
    this.emit({ type: 'run', end })
    // Cards: the run recorded its own verdicts; nothing is recorded for it.
    // Invites sit on the tray until answered, so one the run ignored would
    // cost a run on every wake: the same rule as an invite turn (D5) —
    // pending after the second completed run → dismissed.
    const startedWith = tray === null || this.options.dismissIgnoredInvites === false ? [] : trayInvites(tray)
    if (startedWith.length > 0) await this.track(this.afterRunInvites(startedWith, end))
    const outcome: CycleOutcome =
      end.status === 'completed' ? 'run_completed' : end.status === 'failed' ? 'run_failed' : 'run_not_started'
    return this.summary(outcome, { ...base, failure: end.status === 'completed' ? null : (end.detail ?? null) })
  }

  private async afterRunInvites(invites: TrayInvite[], end: RunEnd): Promise<void> {
    const completed = end.status === 'completed'
    const fresh = completed ? await this.readTray() : null
    const turn: TurnEnd = completed
      ? { status: 'completed', agentchatCalls: null }
      : { status: 'failed', ...(end.detail !== undefined ? { detail: end.detail } : {}) }
    for (const invite of invites) {
      await this.settleInvite(invite, turn, fresh)
    }
  }

  // ─── turns (gate-call mode) ─────────────────────────────────────────────

  private async startReplyTurn(reply: GateReply, texts: Texts): Promise<Launch> {
    const anchor = anchorFrom(reply.card)
    const handle = this.tracker.begin({ kind: 'reply', conversationId: reply.conversationId, anchor })
    if (handle === null) return 'refused'
    const request: TurnRequest = {
      kind: 'reply',
      conversationId: reply.conversationId,
      card: reply.card,
      anchor,
      category: reply.category,
      prompt: replyPrompt(texts, reply.conversationId),
      texts,
      signal: this.abort.signal,
    }
    return this.launch(handle, async () => {
      const admission = await this.admit(this.options.startTurn!, request)
      if (!admission.started) {
        this.tracker.end(handle)
        this.counts.turnsRefused += 1
        this.emit({ type: 'turn_refused', kind: 'reply', id: reply.conversationId, error: admission.error ?? null })
        return false
      }
      this.counts.turnsStarted += 1
      this.emit({ type: 'turn_started', request: withoutRuntime(request) })
      void this.afterReplyTurn(handle, reply, admission.done)
      return true
    })
  }

  private async startInviteTurn(invite: TrayInvite, texts: Texts): Promise<Launch> {
    const handle = this.tracker.begin({ kind: 'invite', inviteId: invite.invite_id })
    if (handle === null) return 'refused'
    const request: TurnRequest = {
      kind: 'invite',
      invite,
      prompt: `${texts.invite_prompt.trim()}\n\ninvite_id: ${invite.invite_id}`,
      texts,
      signal: this.abort.signal,
    }
    return this.launch(handle, async () => {
      const admission = await this.admit(this.options.startInviteTurn ?? this.options.startTurn!, request)
      if (!admission.started) {
        this.tracker.end(handle)
        this.counts.turnsRefused += 1
        this.emit({ type: 'turn_refused', kind: 'invite', id: invite.invite_id, error: admission.error ?? null })
        return false
      }
      this.counts.inviteTurnsStarted += 1
      this.emit({ type: 'turn_started', request: withoutRuntime(request) })
      void this.afterInviteTurn(handle, invite, admission.done)
      return true
    })
  }

  /** Start a turn now when a slot is free, else let it wait for one (its tracker entry holds the card out of the gate). */
  private async launch(handle: TurnHandle, admit: () => Promise<boolean>): Promise<Launch> {
    if (this.activeTurns >= this.maxTurns) {
      this.waiting.push({ handle, admit })
      this.counts.turnsQueued += 1
      return 'queued'
    }
    return (await this.admitInSlot(handle, admit)) ? 'started' : 'refused'
  }

  private async admitInSlot(handle: TurnHandle, admit: () => Promise<boolean>): Promise<boolean> {
    this.activeTurns += 1
    this.slotted.add(handle)
    const started = await admit()
    if (!started) this.releaseSlot(handle, { pump: false })
    return started
  }

  /** The turn's slot is free (it ended, was refused, or was released): start the turns waiting for one. */
  private releaseSlot(handle: TurnHandle, options: { pump?: boolean } = {}): void {
    if (this.slotted.delete(handle)) this.activeTurns = Math.max(0, this.activeTurns - 1)
    const queued = this.waiting.findIndex((w) => w.handle === handle)
    if (queued >= 0) this.waiting.splice(queued, 1) // released while it waited
    if (options.pump !== false) void this.pump()
  }

  private async pump(): Promise<void> {
    while (this.waiting.length > 0 && this.activeTurns < this.maxTurns && !this.stopped) {
      const next = this.waiting.shift()!
      if (!this.tracker.holds(next.handle)) continue // released while it waited
      await this.admitInSlot(next.handle, next.admit)
    }
  }

  private async afterReplyTurn(handle: TurnHandle, reply: GateReply, done: Promise<TurnEnd>): Promise<void> {
    try {
      const end = await this.tracker.confirmedEnd(handle, done)
      if (end === null || !this.tracker.holds(handle)) return // released: nothing recorded
      // Recorded also when the turn ends after stop(): what it did is a fact.
      await this.track(this.recordReplyOutcome(handle, reply, end))
    } finally {
      this.tracker.end(handle)
      this.releaseSlot(handle)
      this.afterTurnEnded()
    }
  }

  private async recordReplyOutcome(handle: TurnHandle, reply: GateReply, end: TurnEnd): Promise<void> {
    const fresh = await this.readTray()
    if (!this.tracker.holds(handle)) return // released while the card was read
    const anchor = anchorFrom(reply.card)
    const key = `${reply.conversationId}|${anchor ?? ''}`
    const silentBefore = this.silent.get(key) ?? 0
    const outcome = turnOutcome({
      turn: end,
      turnStartedAt: handle.startedAt,
      gateCard: reply.card,
      category: reply.category,
      freshTray: fresh,
      silentBefore,
    })
    this.count(outcome.reason)
    if (outcome.reason === 'silent_first') {
      this.remember(key, silentBefore + 1)
      // D5 pacing: not gated again at this anchor for a while.
      this.pacer.hold(`conversation:${reply.conversationId}`, anchor)
    } else if (outcome.reason === 'card_left_tray' || outcome.reason === 'turn_recorded_verdict') {
      this.silent.delete(key)
    }
    let recorded = false
    if (outcome.action !== 'none') {
      try {
        recorded = await applyOutcome(this.client, outcome)
        this.silent.delete(key)
      } catch (err) {
        this.counts.outcomeRecordFailures += 1
        this.fail(err)
      }
    }
    this.emit({ type: 'turn_outcome', outcome, recorded })
  }

  private async afterInviteTurn(handle: TurnHandle, invite: TrayInvite, done: Promise<TurnEnd>): Promise<void> {
    try {
      const end = await this.tracker.confirmedEnd(handle, done)
      if (end === null || !this.tracker.holds(handle)) return
      await this.track(this.recordInviteOutcome(handle, invite, end))
      // D5 pacing: no second invite turn for it for a while (an answered
      // invite has left the tray anyway).
      this.pacer.hold(`invite:${invite.invite_id}`, null)
    } finally {
      this.tracker.end(handle)
      this.releaseSlot(handle)
      this.afterTurnEnded()
    }
  }

  private async recordInviteOutcome(handle: TurnHandle, invite: TrayInvite, end: TurnEnd): Promise<void> {
    const fresh = await this.readTray()
    if (!this.tracker.holds(handle)) return
    await this.settleInvite(invite, end, fresh)
  }

  /** The D5 rule for one invite after a turn or a run, and the one call it asks for. */
  private async settleInvite(invite: TrayInvite, end: TurnEnd, fresh: InboxTray | null): Promise<void> {
    const key = `invite|${invite.invite_id}`
    const silentBefore = this.silent.get(key) ?? 0
    const outcome = inviteOutcome({ turn: end, invite, freshTray: fresh, silentBefore })
    this.count(`invite_${outcome.reason}`)
    if (outcome.reason === 'silent_first') this.remember(key, silentBefore + 1)
    if (outcome.reason === 'invite_answered') this.silent.delete(key)
    let recorded = false
    if (outcome.action !== 'none') {
      try {
        recorded = await applyInviteOutcome(this.client, outcome)
        this.silent.delete(key)
      } catch (err) {
        this.counts.outcomeRecordFailures += 1
        this.fail(err)
      }
    }
    this.emit({ type: 'invite_outcome', outcome, recorded })
  }

  private async admit(start: TurnStarter, request: TurnRequest): Promise<TurnAdmission> {
    try {
      return await start(request)
    } catch (err) {
      return { started: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** A turn's end: cards a cycle left out meanwhile are read again. */
  private afterTurnEnded(): void {
    if (this.heldWhileRunning && !this.stopped) {
      this.heldWhileRunning = false
      this.wakeFrom('more')
    }
  }

  // ─── small things ───────────────────────────────────────────────────────

  /** Recording under way after a turn's confirmed end: `stop()` waits for it. */
  private track(work: Promise<void>): Promise<void> {
    this.pendingWork.add(work)
    return work.finally(() => this.pendingWork.delete(work))
  }

  private remember(key: string, count: number): void {
    this.silent.delete(key)
    this.silent.set(key, count)
    while (this.silent.size > SILENT_MEMORY) {
      const oldest = this.silent.keys().next().value
      if (oldest === undefined) break
      this.silent.delete(oldest)
    }
  }

  private count(reason: string): void {
    this.outcomes[reason] = (this.outcomes[reason] ?? 0) + 1
  }

  private summary(
    outcome: CycleOutcome,
    parts: Partial<Omit<CycleSummary, 'at' | 'outcome'>> = {},
  ): CycleSummary {
    return {
      at: new Date(this.now()).toISOString(),
      outcome,
      cards: 0,
      invites: 0,
      gated: 0,
      reply: 0,
      dismiss: 0,
      defer: 0,
      undecided: 0,
      recorded: 0,
      recordFailures: 0,
      turnsStarted: 0,
      turnsRefused: 0,
      turnsQueued: 0,
      heldByTurns: 0,
      paced: 0,
      truncated: false,
      failure: null,
      ...parts,
    }
  }

  private fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    this.lastError = error.message
    this.emit({ type: 'error', error })
  }

  private emit(event: ReceiveLoopEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // an observer must not break the loop
    }
  }
}

/** The prompt a reply turn starts with: the served wake instruction, then the conversation it is for. */
export function replyPrompt(texts: Pick<Texts, 'wake_instruction'>, conversationId: string): string {
  return `${texts.wake_instruction.trim()}\n\nconversation_id: ${conversationId}`
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function launchKey(launch: Launch): 'turnsStarted' | 'turnsRefused' | 'turnsQueued' {
  return launch === 'started' ? 'turnsStarted' : launch === 'queued' ? 'turnsQueued' : 'turnsRefused'
}

function trayInvites(tray: InboxTray): TrayInvite[] {
  const raw: unknown = tray.invites
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (invite): invite is TrayInvite =>
      typeof invite === 'object' &&
      invite !== null &&
      typeof (invite as { invite_id?: unknown }).invite_id === 'string' &&
      (invite as { invite_id: string }).invite_id.length > 0,
  )
}

function anchorFrom(card: InboxCard): string | null {
  return anchorOf(card) ?? null
}

function withoutRuntime(request: TurnRequest): Omit<TurnRequest, 'signal' | 'texts'> {
  const { signal: _signal, texts: _texts, ...rest } = request
  return rest
}

function wsBase(httpBase: string | undefined): string {
  const base = (httpBase ?? 'https://api.agentchat.me').replace(/\/+$/, '')
  return base.replace(/^http/, 'ws')
}
