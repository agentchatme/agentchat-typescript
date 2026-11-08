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
 *   the tray itself and records its own verdicts. The loop records nothing on
 *   its behalf.
 *
 * Wakes: a `message.new` frame that is not the echo of the agent's own send,
 * a `wake` frame (a reminder, or unanswered cards), every accepted HELLO (a
 * reconnect after a heartbeat gap included), a `group.invite.received`
 * frame, and `wake()` for whatever the integration hears itself (a wake
 * webhook). The socket is the SDK's `RealtimeClient` with `ackOnReceipt` and
 * the `ack`, `heartbeat` and `rewake` capabilities: delivered means this
 * machine received the message; only a verdict reads it.
 *
 * There is no retry ladder here. A cycle that could not finish (the tray
 * could not be read, the model failed, a turn was refused or failed) leaves
 * the cards on the tray and does nothing more: the server re-wakes
 * unanswered cards on its own durable ladder (D3).
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
/** Silent-turn memory (D5 "second time for the same anchor"), bounded. */
const SILENT_MEMORY = 1_000

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
 * rejection counts as a failed turn).
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
  /** Cards were there, but only muted ones or ones a running turn holds. */
  | 'nothing_owed'
  | 'tray_failed'
  | 'texts_missing'
  | 'tools_unavailable'
  /** gateCall: the gate decided (turns started for the replies). */
  | 'decided'
  /** gateCall: the model failed or answered nothing usable; nothing recorded. */
  | 'fail_closed'
  /** gateCall: only invites were owed; their turns were started. */
  | 'invites_only'
  /** singleRun: the run's end. */
  | 'run_completed'
  | 'run_failed'
  | 'run_not_started'

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
  readonly recordFailures: number
  readonly turnsStarted: number
  readonly turnsRefused: number
  /** Cards left out because a turn for their conversation is running. */
  readonly heldByTurns: number
  readonly truncated: boolean
  readonly failure: string | null
}

export type ReceiveLoopEvent =
  | { readonly type: 'wake'; readonly source: WakeSource; readonly conversationId?: string }
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
  readonly turns: RunningTurn[]
  readonly counters: {
    readonly frames: number
    readonly echoes: number
    readonly turnsStarted: number
    readonly turnsRefused: number
    readonly inviteTurnsStarted: number
    readonly runsStarted: number
    readonly runsCompleted: number
    readonly runsFailed: number
    readonly runsNotStarted: number
    readonly outcomes: Readonly<Record<string, number>>
    readonly outcomeRecordFailures: number
  }
  readonly lastError: string | null
}

export class ReceiveLoop {
  private readonly options: ReceiveLoopOptions
  private readonly client: ReceiveLoopClient
  private readonly coalescer: WakeCoalescer
  private readonly tracker: TurnTracker
  private readonly now: () => number
  private readonly abort = new AbortController()
  private readonly realtime: RealtimeClient | null
  private readonly unsubscribe: Array<() => void> = []
  private readonly silent = new Map<string, number>()

  private handle: string | null
  private started = false
  private stopped = false
  private heldWhileRunning = false
  private lastCycle: CycleSummary | null = null
  private lastError: string | null = null
  private readonly counts = {
    frames: 0,
    echoes: 0,
    turnsStarted: 0,
    turnsRefused: 0,
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
    this.options = options
    this.client = options.client
    this.now = options.now ?? Date.now
    this.handle = options.handle ? normalizeHandle(options.handle) : null
    this.tracker = new TurnTracker({ now: this.now })
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
      rt.on('wake', (frame) => {
        this.counts.frames += 1
        const id = (frame.payload as { conversation_id?: unknown }).conversation_id
        this.wakeFrom('wake_frame', typeof id === 'string' ? id : undefined)
      }),
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
   * Stop: no new cycles or turns, the socket closed, running turns and runs
   * signalled through their `AbortSignal`. Resolves when the running cycle
   * and any recording already under way have finished; it does not wait for
   * turns the runtime has not ended (they record nothing once stopped).
   */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.coalescer.stop()
    this.abort.abort()
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
    await this.coalescer.settled()
    await Promise.allSettled([...this.pendingWork])
  }

  /** Resolves when the running cycle has finished (tests, graceful stops). */
  settled(): Promise<void> {
    return this.coalescer.settled()
  }

  /** Let go of a turn whose end the runtime will never confirm (an operator's call). */
  releaseTurn(key: string): boolean {
    const released = this.tracker.release(key)
    if (released) this.wakeFrom('more')
    return released
  }

  status(): ReceiveLoopStatus {
    const texts = this.options.texts.current()
    const counters = this.coalescer.counters()
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
      turns: this.tracker.running(),
      counters: { ...this.counts, outcomes: { ...this.outcomes } },
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

  private wakeFrom(source: WakeSource, conversationId?: string): void {
    if (this.stopped) return
    this.emit({ type: 'wake', source, ...(conversationId ? { conversationId } : {}) })
    this.coalescer.wake()
  }

  // ─── one cycle ──────────────────────────────────────────────────────────

  private async cycle(): Promise<void> {
    if (this.stopped) return
    const summary =
      this.options.mode === 'gateCall' ? await this.gateCallCycle() : await this.singleRunCycle()
    this.lastCycle = summary
    if (summary.failure !== null) this.lastError = summary.failure
    this.emit({ type: 'cycle', summary })
  }

  private async readTray(): Promise<InboxTray | null> {
    try {
      const tray = await this.client.inbox.tray({ waitMs: 0, limit: TRAY_LIMIT, signal: this.abort.signal })
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

  private async gateCallCycle(): Promise<CycleSummary> {
    const tray = await this.readTray()
    if (tray === null) return this.summary('tray_failed', { failure: this.lastError })
    const cards = cardsOf(tray)
    const invites = trayInvites(tray)
    const gateCards = this.tracker.withoutRunning(cards)
    const heldByTurns = cards.length - gateCards.length
    if (heldByTurns > 0) this.heldWhileRunning = true
    const owedCards = gateCards.filter((card) => card.muted !== true)
    const owedInvites = invites.filter((invite) => !this.tracker.inviteRunning(invite.invite_id))
    const base = { cards: cards.length, invites: invites.length, heldByTurns, truncated: tray.truncated === true }
    if (cards.length === 0 && invites.length === 0) return this.summary('empty', base)
    if (owedCards.length === 0 && owedInvites.length === 0) return this.summary('nothing_owed', base)

    const texts = await this.options.texts.ensure()
    if (texts === null) return this.summary('texts_missing', { ...base, failure: 'the served texts are not available' })
    const unready = await this.checkReady()
    if (unready !== null) return this.summary('tools_unavailable', { ...base, failure: unready })

    let gated = 0
    const tally = { reply: 0, dismiss: 0, defer: 0, undecided: 0, recordFailures: 0, turnsStarted: 0, turnsRefused: 0 }
    let outcome: CycleOutcome = 'invites_only'
    let failure: string | null = null
    if (owedCards.length > 0) {
      gated = gateCards.length
      const result = await runGate({
        tray: { ...tray, conversations: gateCards },
        callModel: this.options.callModel!,
        client: this.client,
        texts,
        ...(this.options.toolNamer ? { toolNamer: this.options.toolNamer } : {}),
      })
      for (const verdict of result.verdicts) tally[verdict.decision] += 1
      tally.undecided = result.undecided.length
      tally.recordFailures = result.recordFailures.length
      if (result.outcome === 'fail_closed') {
        outcome = 'fail_closed'
        failure = result.failure
      } else {
        outcome = 'decided'
        for (const reply of result.reply) {
          if (this.stopped) break
          if (await this.startReplyTurn(reply, texts)) tally.turnsStarted += 1
          else tally.turnsRefused += 1
        }
      }
    }
    for (const invite of owedInvites) {
      if (this.stopped) break
      if (await this.startInviteTurn(invite, texts)) tally.turnsStarted += 1
      else tally.turnsRefused += 1
    }
    // More conversations wait than one tray shows: read again for the rest.
    if (tray.truncated === true && outcome === 'decided') this.wakeFrom('more')
    return this.summary(outcome, { ...base, gated, ...tally, failure })
  }

  private async singleRunCycle(): Promise<CycleSummary> {
    const tray = await this.readTray()
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
    if (texts === null) return this.summary('texts_missing', { ...base, failure: 'the served texts are not available' })
    const unready = await this.checkReady()
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
      end = await this.options.startRun!({ prompt, texts, cards, invites, signal: this.abort.signal })
    } catch (err) {
      end = { status: 'not_started', detail: err instanceof Error ? err.message : String(err) }
    }
    if (end.status === 'completed') this.counts.runsCompleted += 1
    else if (end.status === 'failed') this.counts.runsFailed += 1
    else this.counts.runsNotStarted += 1
    this.emit({ type: 'run', end })
    const outcome: CycleOutcome =
      end.status === 'completed' ? 'run_completed' : end.status === 'failed' ? 'run_failed' : 'run_not_started'
    return this.summary(outcome, { ...base, failure: end.status === 'completed' ? null : (end.detail ?? null) })
  }

  // ─── turns (gate-call mode) ─────────────────────────────────────────────

  private async startReplyTurn(reply: GateReply, texts: Texts): Promise<boolean> {
    const anchor = anchorFrom(reply.card)
    const handle = this.tracker.begin({ kind: 'reply', conversationId: reply.conversationId, anchor })
    if (handle === null) return false
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
  }

  private async afterReplyTurn(handle: TurnHandle, reply: GateReply, done: Promise<TurnEnd>): Promise<void> {
    try {
      const end = await this.tracker.confirmedEnd(handle, done)
      if (end === null || this.stopped) return // released, or stopping: nothing recorded
      await this.track(this.recordReplyOutcome(handle, reply, end))
    } finally {
      this.tracker.end(handle)
      this.afterTurnEnded()
    }
  }

  private async recordReplyOutcome(handle: TurnHandle, reply: GateReply, end: TurnEnd): Promise<void> {
    const fresh = await this.readTray()
    const key = `${reply.conversationId}|${anchorFrom(reply.card) ?? ''}`
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
    if (outcome.reason === 'silent_first') this.remember(key, silentBefore + 1)
    let recorded = false
    if (outcome.action !== 'none' && !this.stopped) {
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

  private async startInviteTurn(invite: TrayInvite, texts: Texts): Promise<boolean> {
    const handle = this.tracker.begin({ kind: 'invite', inviteId: invite.invite_id })
    if (handle === null) return false
    const request: TurnRequest = {
      kind: 'invite',
      invite,
      prompt: `${texts.invite_prompt.trim()}\n\ninvite_id: ${invite.invite_id}`,
      texts,
      signal: this.abort.signal,
    }
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
  }

  private async afterInviteTurn(handle: TurnHandle, invite: TrayInvite, done: Promise<TurnEnd>): Promise<void> {
    try {
      const end = await this.tracker.confirmedEnd(handle, done)
      if (end === null || this.stopped) return
      await this.track(this.recordInviteOutcome(invite, end))
    } finally {
      this.tracker.end(handle)
      this.afterTurnEnded()
    }
  }

  private async recordInviteOutcome(invite: TrayInvite, end: TurnEnd): Promise<void> {
    const fresh = await this.readTray()
    const key = `invite|${invite.invite_id}`
    const silentBefore = this.silent.get(key) ?? 0
    const outcome = inviteOutcome({ turn: end, invite, freshTray: fresh, silentBefore })
    this.count(`invite_${outcome.reason}`)
    if (outcome.reason === 'silent_first') this.remember(key, silentBefore + 1)
    let recorded = false
    if (outcome.action !== 'none' && !this.stopped) {
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
      recordFailures: 0,
      turnsStarted: 0,
      turnsRefused: 0,
      heldByTurns: 0,
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
