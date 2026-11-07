import type { WsMessage, Message, WakeFrame } from './types/index.js'
import type { AgentChatClient, SyncEnvelope } from './client.js'
import { ConnectionError } from './errors.js'
import { resolveWebSocket } from './ws-resolver.js'
import {
  DEFAULT_CLIENT_IDENTITY,
  type AgentChatClientIdentity,
} from './client-identity.js'

/**
 * Handlers may be async. For `message.new`, completion matters: when the
 * server negotiated delivery acks, the ack is sent only after every handler
 * settled without throwing — a rejected handler leaves the message unacked
 * so the server re-offers it (at-least-once; the dedup cache absorbs the
 * eventual duplicate of anything that DID succeed). With `ackOnReceipt` the
 * ack goes out before handlers run and completion no longer gates it.
 */
export type MessageHandler = (message: WsMessage) => void | Promise<void>
/** Handler for `wake` frames: a content-free "check AgentChat" signal. */
export type WakeHandler = (frame: WakeFrame) => void | Promise<void>
export type ErrorHandler = (error: Error) => void

/**
 * Fired once per successful HELLO_ACK. Useful for updating UI ("connected"
 * state), (re)subscribing to typing indicators, emitting metrics, etc.
 * Not guaranteed to be called on the initial connect — only after a
 * handshake completes.
 */
export type ConnectHandler = () => void

/** Close information handed to `onDisconnect` on every socket close. */
export interface DisconnectInfo {
  code: number
  reason: string
  wasClean: boolean
  /**
   * Who ended the socket. `'client'` is this client's own watchdog (the
   * handshake or liveness deadline): such a close says nothing about the
   * server and always takes the normal reconnect backoff. `'server'` is a
   * close that arrived on the wire — the server, a proxy, or the network.
   */
  initiator: 'client' | 'server'
}

/** Fired on every socket close, regardless of reason. */
export type DisconnectHandler = (info: DisconnectInfo) => void

/**
 * Connection lifecycle. `stopped` is the only terminal state and only
 * `disconnect()` reaches it; every other state leads back to `connecting`
 * on its own.
 *
 * - `idle` — no socket and nothing scheduled: before the first `connect()`,
 *   or after a close with `reconnect: false`.
 * - `connecting` — a socket is opening, or its HELLO awaits `hello.ok`.
 * - `ready` — `hello.ok` received; frames flow.
 * - `backoff` — the socket closed; the next attempt is scheduled with
 *   exponential backoff.
 * - `blocked` — the server rejected the credential during the handshake; a
 *   fresh attempt is scheduled every 10–15 minutes until one is accepted.
 * - `stopped` — `disconnect()` was called.
 */
export type RealtimeState = 'idle' | 'connecting' | 'ready' | 'backoff' | 'blocked' | 'stopped'
export type StateHandler = (state: RealtimeState, previous: RealtimeState) => void

/** Why the client is `blocked`, and when it will try again. */
export interface BlockedInfo {
  /** Close code the server rejected the handshake with: 4401, 4403 or 1008. */
  code: number
  /** The server's close reason, e.g. `Invalid token`. */
  reason: string
  /** Milliseconds until the next automatic attempt; `null` when `reconnect` is off. */
  retryInMs: number | null
}
export type BlockedHandler = (info: BlockedInfo) => void
export type StoppedHandler = () => void

export interface SequenceGapInfo {
  conversationId: string
  // The seq we were waiting for when the gap window expired.
  expectedSeq: number
  // The lowest seq we had buffered above the expected — what triggered
  // the gap detection. Null when the gap was discovered some other way
  // (e.g. buffer overflow without a clear "next" arrival).
  bufferedSeq: number | null
  // Wall-clock duration we waited before resolving the gap, in ms.
  gapMs: number
  // True iff getMessages successfully returned the missing rows and we
  // dispatched them in order before any higher seqs. False means we
  // gave up and emitted whatever we had (possibly skipping some seqs
  // forever — caller should /sync to fully reconcile).
  recovered: boolean
  reason:
    | 'gap_filled'
    | 'gap_fill_failed'
    | 'gap_fill_unavailable'
    | 'buffer_overflow'
    // ackOnReceipt only: the socket closed while frames sat in the gap
    // buffer. They were already acknowledged, so they were handed to the
    // handlers in seq order instead of being dropped (see the option).
    | 'connection_closed'
}

export type SequenceGapHandler = (info: SequenceGapInfo) => void

export interface RealtimeOptions {
  apiKey: string
  baseUrl?: string
  /**
   * Product-integration identity included in every HELLO frame. Leave unset
   * for direct SDK use (`typescript_sdk/<SDK version>`).
   */
  clientIdentity?: AgentChatClientIdentity
  /**
   * Reconnect after every close that is not `disconnect()`. Default: `true`.
   * With `false` the client goes `idle` after a close and waits for the next
   * `connect()`; it never reconnects or retries on its own.
   */
  reconnect?: boolean
  /**
   * Initial reconnect delay in milliseconds. Each consecutive failure
   * doubles it, jittered up to 25% below the step, up to
   * `maxReconnectInterval` (a true ceiling). Default: 500ms.
   */
  reconnectInterval?: number
  /**
   * Cap on the delay between reconnect attempts for the first 60 consecutive
   * failures. Default: 30s. After 60 consecutive failures the cap widens to
   * five minutes (or this value, if larger), one error is emitted through
   * `onError`, and the client keeps trying forever. There is no attempt
   * limit: only `disconnect()` ends the client.
   */
  maxReconnectInterval?: number
  /**
   * @deprecated Ignored — the client never gives up on its own; only
   * `disconnect()` ends it. Kept so existing call sites compile.
   */
  maxReconnectAttempts?: number
  /**
   * Optional client used for in-order recovery AND for the post-reconnect
   * `/v1/messages/sync` drain.
   *
   * - **Gap recovery**: when the realtime feed sees a per-conversation seq
   *   gap (e.g. `seq=8` then `seq=12`), the client waits briefly for
   *   natural arrival, then calls `getMessages(conversationId, { afterSeq })`
   *   to pull the missing rows and emit them in order.
   * - **Reconnect drain**: after every successful `hello.ok`, the client
   *   calls `/v1/messages/sync` to pull envelopes that accumulated while
   *   disconnected, dispatches them through the same `message.new`
   *   pipeline, and acknowledges with `/v1/messages/sync/ack`.
   *
   * Without a `client`, neither recovery path is available — gaps fire
   * `onSequenceGap` with `recovered: false`, and offline envelopes sit
   * in the server-side queue until the application calls `sync()`
   * manually.
   */
  client?: AgentChatClient
  /**
   * Fired whenever a per-conversation seq gap is detected and resolved
   * (one way or the other). Use this to emit metrics, log incidents,
   * or trigger an explicit `/sync` if `recovered: false`.
   */
  onSequenceGap?: SequenceGapHandler
  /**
   * Disable the automatic post-reconnect `/v1/messages/sync` drain. On by
   * default when a `client` is provided. Turn off if you prefer to run
   * sync on your own schedule.
   */
  autoDrainOnConnect?: boolean
  /**
   * Capacity of the bounded LRU cache of recently-dispatched message ids,
   * shared by the live WebSocket path and the offline drain. Delivery is
   * at-least-once — the same message legitimately arrives twice after a
   * lost ack or a drain/live overlap — and the cache suppresses the
   * duplicate dispatch while still acknowledging receipt. Default: 2048.
   */
  dedupCacheSize?: number
  /**
   * Acknowledge each `message.new` the moment its frame is parsed, before
   * any handler runs. This is the integration setting: "delivered" then
   * means the agent's machine received the message, and whether the agent
   * has looked is tracked separately as read state (a verdict or
   * `client.conversations.markRead`), so an early ack never empties the
   * tray. Covers live frames, the server's reconnect backlog and gap-fill
   * rows; the REST offline drain keeps its settle-then-ack cursor. Default
   * `false`: ack after every handler settled, for app clients whose
   * handler IS the processing.
   *
   * Trade-off: an acked frame is never re-offered by the server, so a frame
   * that is parked on a seq gap when the socket drops is handed to the
   * handlers at close time, in seq order but possibly ahead of the seqs it
   * was waiting for (which arrive after the reconnect). Ack-on-receipt
   * trades strict ordering across a connection drop for no loss; the
   * default mode keeps ordering because unacked frames come back in order
   * on the next drain. Such a flush fires `onSequenceGap` with
   * `reason: 'connection_closed'`.
   */
  ackOnReceipt?: boolean
  /**
   * Override the WebSocket constructor. Defaults to `globalThis.WebSocket`
   * with a dynamic-import fallback to the `ws` package (for Node 20).
   * Tests use this to inject a mock. Users on a polyfilled environment
   * can supply their own implementation — anything that matches the
   * browser WebSocket shape (`onopen/onmessage/onclose/onerror`, `send`,
   * `close`, `readyState`) works.
   *
   * On Node the default resolution prefers `WebSocket` from the `ws`
   * package when it is installed and falls back to the native socket only
   * without it: `ws` exposes the server's ping frames (`on('ping')`), which
   * lets the liveness watchdog tell a quiet-but-healthy socket from a dead
   * one. The browser-shaped socket (including Node's native one) cannot see
   * pings — see `livenessTimeoutMs`. Pass a constructor only to override.
   */
  webSocket?: typeof globalThis.WebSocket
  /**
   * Handshake deadline: milliseconds from `connect()` to `hello.ok`. A
   * half-open upgrade or a server that never answers HELLO is closed by the
   * client at this point and reconnected with the normal backoff. The
   * server's own HELLO timer is 5 s, so this is the safety net for a dead
   * pipe, not the common path. Default: 15 000.
   */
  handshakeTimeoutMs?: number
  /**
   * Idle deadline: milliseconds without any inbound frame — or, on a socket
   * that exposes them, a ping — before the connection is presumed dead,
   * closed by the client and reconnected. The server pings every 45 s, so
   * the default (100 000) survives one missed ping and trips on the second.
   *
   * Ping frames are visible only on a socket with `on('ping')` (Node `ws`).
   * A browser-shaped socket cannot see them, so there the idle deadline is
   * OFF unless set explicitly: only application frames would keep it alive,
   * and an idle but healthy connection would otherwise be reopened every
   * cycle. `0` disables it on any socket; the handshake deadline stays.
   */
  livenessTimeoutMs?: number
}

/** Handshake deadline, `connect()` → `hello.ok`. See `handshakeTimeoutMs`. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000

/** Idle deadline on ping-capable sockets: two server ping cycles (45 s) plus slack. */
const DEFAULT_LIVENESS_TIMEOUT_MS = 100_000

/**
 * Close code this client uses when its own watchdog ends a socket. In the
 * private-use range so a browser socket accepts it (browsers allow only 1000
 * and 3000–4999 from `close()`). On a Node `ws` socket the watchdog
 * terminates instead, which sends no close frame at all — a dead pipe would
 * otherwise hold a polite close open for up to 30 s waiting for a reply.
 */
const CLIENT_CLOSE_CODE = 4000

/**
 * After this many consecutive failures the outage is long: one error is
 * emitted for the operator and the backoff cap widens to
 * LONG_OUTAGE_MAX_INTERVAL_MS. Retrying continues until the server is back —
 * a deploy, a DNS outage or a laptop closed overnight is not a reason to
 * stay dead afterwards.
 */
const LONG_OUTAGE_AFTER_ATTEMPTS = 60
const LONG_OUTAGE_MAX_INTERVAL_MS = 5 * 60_000

/**
 * Reconnect delays are jittered up to 25% BELOW each step: a fleet that
 * drops together spreads back out, and the documented caps stay true
 * ceilings (30 s, then 5 min — never 37.5 s or 6.25 min).
 */
const RECONNECT_JITTER_RATIO = 0.25

/**
 * After the server rejects the credential, retry a fresh HELLO at this
 * cadence (±20% jitter → 10–15 min). A rejected key is not a dead end: keys
 * get rotated back, suspended accounts get reinstated, and a server-side
 * lookup failure during HELLO presents as a reject too.
 */
const AUTH_RETRY_INTERVAL_MS = 750_000
const AUTH_RETRY_JITTER_RATIO = 0.2

// Close codes that mean "the server rejected this credential" when the
// SERVER sends them during the handshake. 4401/4403 are unambiguous. 1008
// (policy violation) is not: the server closes a rejected HELLO with
// 1008 'Invalid token', but also uses 1008 for a handshake that was merely
// too slow ('HELLO frame required', from its own 5 s timer), and a database
// failure during auth ends as that same timer close. So 1008 counts as a
// rejection only with the server's auth reason; any other 1008 takes the
// normal backoff. A close this client initiated never counts, whatever code
// it carries. These codes after `hello.ok` (the server evicts a rotated key
// or a suspended account with 1008 and its own reasons) are an eviction, not
// a verdict: the next HELLO is the evidence, so they take the normal path.
const UNAMBIGUOUS_AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([4401, 4403])
const AMBIGUOUS_AUTH_CLOSE_CODE = 1008
const SERVER_AUTH_CLOSE_REASONS: readonly string[] = ['invalid token']

/**
 * True iff a server-originated close with this code and reason, received
 * before `hello.ok`, means the credential was rejected. Pure; exported so
 * integrations and tests share one definition.
 */
export function isAuthRejectionClose(code: number, reason: string): boolean {
  if (UNAMBIGUOUS_AUTH_CLOSE_CODES.has(code)) return true
  if (code !== AMBIGUOUS_AUTH_CLOSE_CODE) return false
  if (typeof reason !== 'string') return false
  const lower = reason.toLowerCase()
  return SERVER_AUTH_CLOSE_REASONS.some((known) => lower.includes(known))
}

// A Node `ws` socket is an EventEmitter and surfaces ping/pong frames; the
// browser shape has neither `on` nor the frames.
type PingCapableSocket = WebSocket & {
  on(event: 'ping' | 'pong', listener: () => void): unknown
}
function isPingCapable(ws: WebSocket): ws is PingCapableSocket {
  return typeof (ws as { on?: unknown }).on === 'function'
}

// Never hold a Node process open for a watchdog or a counter reset; the
// socket itself (or a pending reconnect) is what keeps a daemon alive.
function unref(timer: ReturnType<typeof setTimeout>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * How long a connection must SURVIVE before we call it healthy and clear
 * the reconnect backoff.
 *
 * "The handshake succeeded" is not the same claim as "this connection
 * works". Resetting the attempt counter on `hello.ok` alone means a socket
 * that connects and dies seconds later always retries at the floor delay —
 * the exponential backoff can then never engage, because it only ever
 * counts attempts that failed BEFORE the handshake. A client in that state
 * reconnects forever with no ramp at all: observed in production as 725
 * connections in four hours from one agent, delivering zero messages,
 * while sibling agents on the same host held single connections.
 *
 * 30s is comfortably longer than any handshake-adjacent failure (the
 * handshake deadline is 15s, the server heartbeat cycle 45s) and short
 * enough that a healthy client clears its counter well before a second blip.
 */
const STABLE_CONNECTION_MS = 30_000

/** Reconnects faster than this count as "rapid" for the instability warning. */
const RAPID_RECONNECT_MS = 60_000

/**
 * Consecutive rapid reconnects before we warn the operator. This failure is
 * invisible from inside the agent — every reconnect succeeds, so nothing
 * looks broken locally while the connection is unusable in practice.
 */
const INSTABILITY_WARN_THRESHOLD = 5

// How long we wait for the missing seqs to arrive naturally (e.g. via the
// pub/sub fan-out catching up to the drain) before triggering an explicit
// gap-fill round-trip. Two seconds is well below the perceptual floor for
// agent loops (which tick in hundreds of ms minimum) and well above the
// typical drain↔live-fanout interleave window (10–100 ms). The cost when
// no real gap exists is zero — the timer is started lazily on detection
// and cancelled the moment the missing seq arrives.
const GAP_FILL_WINDOW_MS = 2_000

// Hard cap on how many out-of-order messages we hold per conversation
// before draining unconditionally. Prevents memory blow-up if a sender
// publishes wildly off-sequence or a server bug emits seqs in the wrong
// order at high volume. 500 is well above realistic burst sizes (group
// fan-out batches at 100), so we only hit this in true pathologies — at
// which point we surface it via onSequenceGap and continue.
const MAX_BUFFERED_PER_CONVERSATION = 500

// Cap on how many messages we'll request from the server in one gap-fill
// round-trip. If the gap is bigger than this, recovery is best-effort and
// the application should call /sync afterwards to fully reconcile. The
// onSequenceGap callback fires with recovered:false if we couldn't close
// the gap completely.
const GAP_FILL_LIMIT = 200

// Page size for the post-reconnect /v1/messages/sync drain. Matches the
// server default (200, hard-capped at 500 server-side); a response shorter
// than this is the server saying "caught up".
const SYNC_DRAIN_PAGE_SIZE = 200

// Default capacity of the message-id dedup cache. See
// RealtimeOptions.dedupCacheSize.
const DEFAULT_DEDUP_CACHE_SIZE = 2048

// Minimal structural validation of one sync row, mirroring the reference
// wire schema (docs/realtime-delivery-ack.md): id / conversation_id /
// delivery_id (string|null) are required; optional fields are type-checked
// only when present; unknown fields pass through untouched. The drain stops
// at the FIRST invalid row and never acks past it — acking past an unparsed
// row would mark a message delivered that was never surfaced to handlers.
function isValidSyncRow(row: unknown): row is SyncEnvelope {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string') return false
  if (typeof r.conversation_id !== 'string') return false
  if (typeof r.delivery_id !== 'string' && r.delivery_id !== null) return false
  for (const key of ['sender', 'sender_handle', 'type', 'created_at'] as const) {
    if (r[key] !== undefined && typeof r[key] !== 'string') return false
  }
  if (
    r.content !== undefined &&
    (typeof r.content !== 'object' || r.content === null || Array.isArray(r.content))
  ) {
    return false
  }
  return true
}

// Latest ackable cursor from a batch of rows (rows arrive oldest-first).
// The cursor is POSITIONAL: delivery_id is an opaque string, so "latest"
// means "last non-null in batch order", never a numeric comparison.
function lastDeliveryId(rows: SyncEnvelope[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const id = rows[i]?.delivery_id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function toError(reason: unknown, context: string): Error {
  return reason instanceof Error
    ? reason
    : new Error(`${context} handler failed: ${String(reason)}`)
}

interface OrderState {
  // The next seq we expect to dispatch. Null means we're un-anchored —
  // the next `message.new` with a numeric seq sets this to seq + 1.
  // Re-set to null on disconnect so the post-reconnect /sync drain can
  // re-anchor without false gap detections across the connection break.
  nextExpectedSeq: number | null
  // Out-of-order messages waiting on a missing earlier seq. Keyed by
  // seq for O(1) lookup during the consecutive-drain pass.
  buffer: Map<number, WsMessage>
  gapTimer: ReturnType<typeof setTimeout> | null
  gapStartedAt: number | null
  // The seq we were waiting on when the gap timer started. Used so a
  // later arrival of an even-higher seq doesn't reset the timer or
  // confuse the gap report.
  gapStartedExpectedSeq: number | null
  // True while a getMessages call is in flight, so a re-detect of the
  // same gap doesn't kick off a parallel fetch.
  gapFillInFlight: boolean
}

export class RealtimeClient {
  private ws: WebSocket | null = null
  private options: {
    apiKey: string
    baseUrl: string
    reconnect: boolean
    reconnectInterval: number
    maxReconnectInterval: number
    handshakeTimeoutMs: number
    /** `null` = decide per socket: on with ping frames, off without. */
    livenessTimeoutMs: number | null
    client?: AgentChatClient
    onSequenceGap?: SequenceGapHandler
    autoDrainOnConnect: boolean
    dedupCacheSize: number
    ackOnReceipt: boolean
    webSocket?: typeof globalThis.WebSocket
    clientIdentity: AgentChatClientIdentity
  }
  private handlers = new Map<string, Set<MessageHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private connectHandlers = new Set<ConnectHandler>()
  private disconnectHandlers = new Set<DisconnectHandler>()
  private stateHandlers = new Set<StateHandler>()
  private blockedHandlers = new Set<BlockedHandler>()
  private stoppedHandlers = new Set<StoppedHandler>()
  private _state: RealtimeState = 'idle'
  /** Consecutive failed attempts; drives the backoff. Cleared by the stability timer only. */
  private reconnectAttempts = 0
  /** Clears reconnectAttempts once this connection proves itself stable. */
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive connections that died before STABLE_CONNECTION_MS. Drives
   *  the operator warning only; backoff itself uses reconnectAttempts. */
  private rapidReconnects = 0
  private lastConnectAt: number | null = null
  /** The pending backoff or blocked-retry timer — at most one at a time. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Handshake deadline: armed by connect(), cleared by hello.ok or close. */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** Idle deadline: armed by hello.ok; inbound frames and pings refresh it. */
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  /** Idle deadline in effect for the current socket; 0 = off. */
  private livenessMs = 0
  private lastInboundAt = 0
  private authenticated = false
  // True only when the server echoed the 'ack' capability in hello.ok.
  // Per-connection: reset on every close and re-negotiated on every HELLO.
  private ackMode = false
  /** One error per long outage, then silent until a stable connection. */
  private longOutageAnnounced = false
  /** One error per run of rejected handshakes, then silent until hello.ok. */
  private blockedAnnounced = false
  // Bounded LRU of recently-dispatched message ids (Set iteration order is
  // insertion order — delete + re-add refreshes recency). Ids are added
  // only AFTER a successful dispatch: adding earlier would let a failed
  // dispatch suppress its own redelivery.
  private dedupSeen = new Set<string>()
  // Dispatches still running, by message id: the first copy's settlement.
  // A second copy of an id that is here (the server's reconnect backlog and
  // the REST drain bring the same stored rows; a slow handler is still on
  // the first) is not handed to the handlers again. It takes the first
  // copy's outcome instead. An entry lives exactly as long as its handlers
  // run, so the map is bounded by the dispatches in flight.
  private inFlight = new Map<string, Promise<boolean>>()
  // Envelopes injected by the REST drain, as opposed to live WS frames.
  // Drain rows are acknowledged via the REST sync/ack cursor, never via a
  // WS ack frame; everything else on the message.new pipeline (live frames,
  // server-pushed reconnect backlog, gap-fill rows) takes the WS ack path
  // when ack-mode is negotiated.
  private restDrainOrigin = new WeakSet<WsMessage>()
  // Per-envelope dispatch settlement for drain rows: resolves true when
  // every handler settled cleanly (or the row deduped), false when a
  // handler threw/rejected. The drain awaits these before advancing the
  // ack cursor. WeakMap so entries die with the envelope objects.
  private drainSettlements = new WeakMap<WsMessage, Promise<boolean>>()
  // Coalesces concurrent drains — the server-side ack pointer only moves
  // forward, so one drain at a time is both sufficient and simpler to
  // reason about than interleaved read cursors.
  private drainInFlight = false
  private orderStates = new Map<string, OrderState>()
  private disposed = false

  constructor(options: RealtimeOptions) {
    const dedupCacheSize =
      typeof options.dedupCacheSize === 'number' &&
      Number.isFinite(options.dedupCacheSize) &&
      options.dedupCacheSize >= 1
        ? Math.floor(options.dedupCacheSize)
        : DEFAULT_DEDUP_CACHE_SIZE
    const handshakeTimeoutMs =
      typeof options.handshakeTimeoutMs === 'number' &&
      Number.isFinite(options.handshakeTimeoutMs) &&
      options.handshakeTimeoutMs > 0
        ? options.handshakeTimeoutMs
        : DEFAULT_HANDSHAKE_TIMEOUT_MS
    const livenessTimeoutMs =
      typeof options.livenessTimeoutMs === 'number' &&
      Number.isFinite(options.livenessTimeoutMs) &&
      options.livenessTimeoutMs >= 0
        ? options.livenessTimeoutMs
        : null
    this.options = {
      baseUrl: options.baseUrl ?? 'wss://api.agentchat.me',
      reconnect: options.reconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 500,
      maxReconnectInterval: options.maxReconnectInterval ?? 30_000,
      handshakeTimeoutMs,
      livenessTimeoutMs,
      apiKey: options.apiKey,
      client: options.client,
      onSequenceGap: options.onSequenceGap,
      autoDrainOnConnect: options.autoDrainOnConnect ?? Boolean(options.client),
      dedupCacheSize,
      ackOnReceipt: options.ackOnReceipt ?? false,
      webSocket: options.webSocket,
      clientIdentity: options.clientIdentity ?? DEFAULT_CLIENT_IDENTITY,
    }
  }

  /**
   * Open the WebSocket connection and perform the HELLO handshake.
   * Resolves once the socket has been constructed and its handlers bound —
   * NOT after `hello.ok`. Listen for `onConnect()` or `on('state')` to react
   * to a completed handshake.
   *
   * Also the way to retry at once: called while `backoff` or `blocked`, it
   * cancels the pending timer and opens a socket now. A no-op while a socket
   * is already connecting or connected. Throws after `disconnect()` — create
   * a fresh `RealtimeClient` instead. Rejects, without retrying, when no
   * WebSocket implementation exists (neither `ws` nor a native one): that is
   * a configuration error and the client stays `idle`.
   */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new ConnectionError('RealtimeClient has been disposed; create a new instance to reconnect.')
    }
    if (this.ws) return
    this.clearReconnectTimer()

    let WebSocketCtor: typeof globalThis.WebSocket
    try {
      WebSocketCtor = this.options.webSocket ?? (await resolveWebSocket())
    } catch (err) {
      // No WebSocket implementation anywhere is a configuration error, not
      // an outage: nothing a retry could change. Reject so the caller sees
      // it, and stay idle rather than announce the same error every backoff.
      this.setState('idle')
      throw err instanceof Error ? err : new ConnectionError('Failed to resolve WebSocket')
    }
    // disconnect() or a concurrent connect() may have run during the await.
    if (this.disposed || this.ws) return

    this.setState('connecting')

    // Authenticate via HELLO frame (not URL). Browser WebSocket cannot set
    // custom headers, so this is the only cross-runtime path. The API key
    // never appears in the URL, access logs, or Referer headers.
    const url = `${this.options.baseUrl}/v1/ws`
    let ws: WebSocket
    try {
      ws = new WebSocketCtor(url)
    } catch (err) {
      // A constructor that throws (bad URL, host refusing to create sockets)
      // is a failed attempt like any other: it backs off, it does not end
      // the client.
      const error = err instanceof Error ? err : new ConnectionError('WebSocket constructor threw')
      this.emitError(error)
      this.scheduleReconnect()
      throw error
    }
    this.ws = ws
    this.authenticated = false
    this.ackMode = false
    this.livenessMs =
      this.options.livenessTimeoutMs ?? (isPingCapable(ws) ? DEFAULT_LIVENESS_TIMEOUT_MS : 0)
    this.armHandshakeDeadline()

    // Every handler checks that it still speaks for the current socket. A
    // socket the watchdog abandoned (or disconnect() closed) was dealt with
    // the moment we let go of it; its own late events — a close that arrives
    // seconds later from a dead pipe, an error from an aborted upgrade —
    // must not touch the state machine again. The handlers stay attached
    // (never detached) because a Node `ws` socket with no error listener
    // turns an error event into an uncaught exception.
    const current = (): boolean => this.ws === ws

    ws.onopen = () => {
      if (!current()) return
      try {
        // Advertise the delivery-ack capability (docs/realtime-delivery-ack.md).
        // Legacy servers ignore unknown HELLO fields; ack-mode turns on only
        // if hello.ok echoes the capability back.
        ws.send(
          JSON.stringify({
            type: 'hello',
            api_key: this.options.apiKey,
            capabilities: ['ack'],
            client: this.options.clientIdentity.name,
            ...(this.options.clientIdentity.version
              ? { client_version: this.options.clientIdentity.version }
              : {}),
          }),
        )
      } catch (err) {
        this.emitError(err instanceof Error ? err : new ConnectionError('HELLO send failed'))
        // A socket that cannot carry the HELLO cannot carry anything; the
        // handshake deadline would end it anyway, so end it now.
        this.abandonSocket(CLIENT_CLOSE_CODE, 'client HELLO send failed')
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      if (!current()) return
      // Any inbound frame is proof of life, parseable or not.
      this.touchLiveness()

      let message: WsMessage
      try {
        message = JSON.parse(String(event.data)) as WsMessage
      } catch {
        return
      }

      // Intercept the handshake ACK — never surfaces to user handlers.
      if (!this.authenticated) {
        if ((message as { type?: string }).type === 'hello.ok') {
          this.authenticated = true
          // Capability negotiation: ack-mode only if the server echoed
          // 'ack' back. A hello.ok without capabilities is a legacy server
          // (marks envelopes delivered on send); sending ack frames to it
          // would just be unknown frames.
          const caps = (message as { capabilities?: unknown }).capabilities
          this.ackMode = Array.isArray(caps) && caps.includes('ack')
          this.clearHandshakeTimer()
          // The idle deadline takes over from the handshake deadline.
          this.touchLiveness()
          // reconnectAttempts is deliberately NOT reset here. A successful
          // handshake proves the credential, not the connection — see
          // STABLE_CONNECTION_MS. The counter clears from the timer below,
          // and only if we are still connected 30s from now.
          this.startStabilityTimer()
          // The credential was accepted: a later rejection is a new event.
          this.blockedAnnounced = false
          this.setState('ready')
          for (const handler of this.connectHandlers) {
            try { handler() } catch { /* user hook must not break flow */ }
          }
          if (this.options.autoDrainOnConnect && this.options.client) {
            // Fire-and-forget by design, but never an unhandled rejection:
            // anything that escapes the drain's internal error handling
            // still surfaces through the standard error channel.
            this.drainOfflineEnvelopes().catch((err) => {
              this.emitError(
                err instanceof Error ? err : new ConnectionError('sync drain failed'),
              )
            })
          }
        }
        return
      }

      // Per-conversation seq ordering applies only to message.new — every
      // other event type (presence, group.deleted, message.read, system
      // messages without a seq) passes straight through.
      if (this.isMessageNew(message)) {
        // Ack-on-receipt: the frame is parsed, the machine has it. Sent
        // before ordering so a frame parked on a seq gap is already
        // delivered; the post-dispatch ack is suppressed for this mode.
        if (this.options.ackOnReceipt) {
          const messageId = this.extractMessageId(message)
          if (messageId !== null) this.sendAckFrame(messageId)
        }
        this.processOrderedMessage(message)
        return
      }
      if (this.isWake(message)) {
        this.dispatchWake(message)
        return
      }
      this.dispatch(message)
    }

    ws.onerror = () => {
      if (!current()) return
      this.emitError(new ConnectionError('WebSocket error'))
    }

    ws.onclose = (event: CloseEvent) => {
      if (!current()) return
      this.ws = null
      this.handleClose({
        code: event.code,
        // A polyfilled socket may omit the reason; the rejection rule
        // lowercases it, so it must be a string here.
        reason: String(event.reason ?? ''),
        wasClean: event.wasClean,
        initiator: 'server',
      })
    }

    // Node `ws`: the server's ping frames (every 45 s) are proof of life
    // too. The library answers them on its own; here they only refresh the
    // idle deadline, which is what lets a quiet socket stay up.
    if (isPingCapable(ws)) {
      const alive = (): void => {
        if (current()) this.touchLiveness()
      }
      ws.on('ping', alive)
      ws.on('pong', alive)
    }
  }

  /**
   * Drain offline envelopes accumulated while the socket was disconnected.
   * Automatically invoked on every successful `hello.ok` when
   * `autoDrainOnConnect` is enabled and a client is configured.
   *
   * `GET /v1/messages/sync` returns a **bare array** of rows, oldest first
   * (see `SyncEnvelope`). Each page is dispatched through the same ordered
   * `message.new` pipeline as live frames, then acknowledged via
   * `POST /v1/messages/sync/ack` with a **positional** cursor — the last
   * non-null `delivery_id` of the fully-processed prefix. `delivery_id` is
   * an opaque string and is never compared numerically. Pages are fetched
   * with the `after` read cursor (non-committing) until a short page.
   *
   * Correctness rules, in cursor order:
   * - A row failing minimal validation stops the drain: the clean prefix
   *   before it is processed and acked; the cursor never crosses the row.
   * - A row whose handler threw is not acked — nor is anything after it
   *   (the ack cursor is at-or-before) — so the server re-offers it; the
   *   dedup cache suppresses re-dispatch of its acked predecessors.
   * - A row no handler has been handed yet is not acked: acks FREEZE at the
   *   last settled row for the remainder of the drain. That is a row
   *   parked in the out-of-order buffer (awaiting seq gap-fill), and also a
   *   row that was parked when the socket closed: in the default mode the
   *   close clears the ordering buffers (`resetOrderStates`) without
   *   dispatching them, possibly while the drain is still awaiting an
   *   earlier row's handler. Covering either would mark a message
   *   delivered that no handler saw — acked-but-undispatched is exactly the
   *   loss the ack protocol exists to prevent. Reading continues so the
   *   in-session gap-fill still resolves; the frozen tail is re-offered on
   *   the next drain (or the server's reconnect backlog) and absorbed by
   *   the dedup cache.
   *
   * Concurrent calls are coalesced (the second returns immediately). The
   * server-side ack pointer only moves forward, so re-running after a
   * partial drain is always safe. REST-drained rows are acked via this
   * cursor, never via WS ack frames.
   */
  async drainOfflineEnvelopes(): Promise<void> {
    const client = this.options.client
    if (!client) return
    if (this.drainInFlight) return
    this.drainInFlight = true
    try {
      await this.runDrain(client)
    } finally {
      this.drainInFlight = false
    }
  }

  private async runDrain(client: AgentChatClient): Promise<void> {
    let after: string | undefined
    let acksFrozen = false

    while (!this.disposed) {
      let batch: SyncEnvelope[]
      try {
        batch = await client.sync({ after, limit: SYNC_DRAIN_PAGE_SIZE })
      } catch (err) {
        this.emitError(err instanceof Error ? err : new ConnectionError('sync drain failed'))
        return
      }

      // Defensive against the exact class of bug this path once shipped
      // (SDK/server wire drift): anything but an array is a contract
      // violation, not an empty queue.
      if (!Array.isArray(batch)) {
        this.emitError(
          new ConnectionError(
            `sync drain: expected a bare array from /v1/messages/sync, got ${typeof batch}`,
          ),
        )
        return
      }
      // disconnect() may have run while the request was in flight — the
      // handler map is cleared, so dispatching (and then acking) would
      // mark messages delivered that no handler ever saw.
      if (this.disposed) return
      if (batch.length === 0) return

      // Keep only the clean prefix — stop at the FIRST invalid row rather
      // than skipping it (the ack cursor covers everything at-or-before).
      const rows: SyncEnvelope[] = []
      let invalidIndex = -1
      for (const [index, item] of batch.entries()) {
        if (!isValidSyncRow(item)) {
          invalidIndex = index
          break
        }
        rows.push(item)
      }

      // Inject the prefix into the ordered pipeline. Dispatch STARTS
      // synchronously and in order; settlement of async handlers is
      // awaited below, before the ack cursor moves.
      const envelopes: WsMessage[] = rows.map((row) => {
        const envelope: WsMessage = {
          type: 'message.new',
          payload: row as unknown as Record<string, unknown>,
        }
        this.restDrainOrigin.add(envelope)
        return envelope
      })
      for (const envelope of envelopes) {
        this.processOrderedMessage(envelope)
      }

      if (!acksFrozen) {
        let ackCursor: string | null = null
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]
          const envelope = envelopes[i]
          if (!row || !envelope) break // unreachable; satisfies indexed access
          const settlement = this.drainSettlements.get(envelope)
          if (!settlement) {
            // Never handed to a handler: still parked on a seq gap, or
            // parked and then cleared from the buffer by a socket close
            // (`resetOrderStates`) while an earlier row's handler was
            // running. No handler saw it, so the cursor stops here and the
            // server re-offers it. See the stranding note in the method doc.
            acksFrozen = true
            break
          }
          if (!(await settlement)) {
            // Handler failure — leave this row and everything after it
            // unacked so the server re-offers them.
            acksFrozen = true
            break
          }
          // Reaching here means the row is safe to cover with the cursor:
          // its dispatch settled cleanly, or it was a dedup hit (already
          // dispatched by this process — prior processing is the proof).
          // A settlement exists only once dispatchMessageNew ran for the
          // envelope, so its presence is the proof a handler was reached.
          const deliveryId = row.delivery_id
          if (typeof deliveryId === 'string' && deliveryId.length > 0) {
            ackCursor = deliveryId
          }
        }
        if (ackCursor !== null) {
          try {
            await client.syncAck(ackCursor)
          } catch (err) {
            this.emitError(err instanceof Error ? err : new ConnectionError('sync ack failed'))
            return
          }
        }
      }

      if (invalidIndex >= 0) {
        this.emitError(
          new ConnectionError(
            `sync drain: row ${invalidIndex} failed validation — processed the ` +
              `${rows.length}-row prefix and stopped; the ack cursor was not advanced past it`,
          ),
        )
        return
      }

      // A short page means the server is caught up.
      if (batch.length < SYNC_DRAIN_PAGE_SIZE) return

      // Page forward with the read cursor (non-committing). A page whose
      // delivery ids are all null offers no way to make progress — stop
      // rather than spin re-reading the same rows.
      const nextAfter = lastDeliveryId(rows)
      if (nextAfter === null) return
      after = nextAfter
    }
  }

  /**
   * Clear the reconnect backoff once this connection proves itself.
   *
   * Scheduled on `hello.ok`, cancelled on close. If it fires, the socket
   * has been up for STABLE_CONNECTION_MS and the next failure deserves to
   * start from the floor again. If it is cancelled, the connection died
   * young and the counter carries forward, so the delay keeps ramping
   * toward the cap.
   */
  private startStabilityTimer(): void {
    this.cancelStabilityTimer()
    this.lastConnectAt = Date.now()
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null
      if (this.disposed || !this.authenticated) return
      this.reconnectAttempts = 0
      this.rapidReconnects = 0
      // The outage is over; the next one gets its own announcement.
      this.longOutageAnnounced = false
    }, STABLE_CONNECTION_MS)
    unref(this.stabilityTimer)
  }

  private cancelStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }
  }

  /**
   * Track short-lived connections and warn once they form a pattern.
   * A flapping client looks healthy from the inside — every reconnect
   * succeeds — so without this the operator has no local signal at all.
   * The notice goes through `onError` like every other signal: an SDK
   * that runs as a guest inside a host process does not own its console.
   */
  private noteConnectionEnded(): void {
    const started = this.lastConnectAt
    this.lastConnectAt = null
    if (started === null) return

    if (Date.now() - started >= RAPID_RECONNECT_MS) {
      this.rapidReconnects = 0
      return
    }

    this.rapidReconnects++
    if (this.rapidReconnects === INSTABILITY_WARN_THRESHOLD) {
      this.emitError(
        new ConnectionError(
          `realtime connection is unstable: ${this.rapidReconnects} consecutive ` +
            `connections each lasting under ${RAPID_RECONNECT_MS / 1000}s. Backing off ` +
            `(next retry in up to ${this.options.maxReconnectInterval / 1000}s). This ` +
            `usually means the network path or a local supervisor is dropping the ` +
            `socket, not an AgentChat outage.`,
        ),
      )
    }
  }

  // ─── Lifecycle: close funnel, backoff, blocked, watchdogs ───────────────
  //
  // Invariant: the client never parks itself. Every close leads to a timer
  // (backoff or blocked retry) or, with `reconnect: false`, to `idle` where
  // the application's next connect() picks up. Only disconnect() ends it.

  /**
   * The single funnel for "this socket is over", whoever ended it. Runs
   * after `this.ws` has been let go of, so nothing here touches the socket
   * again. Decides what comes next — backoff, blocked or idle, never nothing.
   */
  private handleClose(info: DisconnectInfo): void {
    const duringHandshake = !this.authenticated
    this.clearWatchdogs()
    // Cancel BEFORE clearing `authenticated`: a connection that dies young
    // must not clear the backoff counter — that is the whole point of the
    // stability window.
    this.cancelStabilityTimer()
    this.noteConnectionEnded()
    this.authenticated = false
    this.ackMode = false

    for (const handler of this.disconnectHandlers) {
      try { handler(info) } catch { /* user hook must not break flow */ }
    }

    // Ack-on-receipt: every frame parked on a seq gap was acknowledged at
    // parse, so the server has it `delivered` and will never re-offer it.
    // Dropping the buffer here would lose it for good — the exact loss the
    // ack protocol exists to prevent. Hand the parked frames to the
    // handlers now, in seq order, before the state goes. Default mode
    // skips this: its parked frames are unacked and come back in order on
    // the next drain. That includes REST drain rows: the drain's cursor
    // covers only rows that reached a handler, so a parked row dropped
    // here stops the cursor instead of being acked.
    if (this.options.ackOnReceipt) this.flushParkedFrames('connection_closed')

    // Drop all per-conversation ordering state. Across the connection
    // break the application is responsible for calling /sync (or
    // enabling `autoDrainOnConnect`), which re-establishes the cursor
    // via the next message.new arrival. Leaving stale nextExpectedSeq
    // values would cause spurious gap detections after reconnect when
    // a /sync drain delivers higher-seq rows than what live previously
    // emitted.
    this.resetOrderStates()

    if (this.disposed) return

    // Only a close the SERVER sent, before hello.ok, with a code and reason
    // that mean rejection, is a rejection. Our own watchdog closes say
    // nothing about the server, whatever code they carry; an eviction after
    // hello.ok takes the normal path and the next HELLO decides.
    if (
      info.initiator === 'server' &&
      duringHandshake &&
      isAuthRejectionClose(info.code, info.reason)
    ) {
      this.enterBlocked(info.code, info.reason)
      return
    }

    this.scheduleReconnect()
  }

  /**
   * End the current socket on the client's own decision (a watchdog trip,
   * a HELLO that could not be sent) and move on at once, without waiting for
   * the socket's close event: on a dead pipe a polite close waits for a
   * reply that never comes. Terminated where the API allows it (Node `ws`),
   * closed otherwise; its own late events are ignored because it is no
   * longer `this.ws`.
   */
  private abandonSocket(code: number, reason: string): void {
    const ws = this.ws
    if (!ws) return
    this.ws = null
    const terminate = (ws as { terminate?: () => void }).terminate
    try {
      if (typeof terminate === 'function') terminate.call(ws)
      else ws.close(code, reason)
    } catch { /* already closed */ }
    this.handleClose({ code, reason, wasClean: false, initiator: 'client' })
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (this.reconnectTimer) return
    if (!this.options.reconnect) {
      this.setState('idle')
      return
    }

    this.reconnectAttempts++
    const attempt = this.reconnectAttempts
    if (attempt > LONG_OUTAGE_AFTER_ATTEMPTS && !this.longOutageAnnounced) {
      // Once per outage: the operator should know the control plane has
      // been unreachable this long. Retrying goes on at the wider cap.
      this.longOutageAnnounced = true
      this.emitError(
        new ConnectionError(
          `still reconnecting after ${LONG_OUTAGE_AFTER_ATTEMPTS} consecutive failed attempts; ` +
            `backing off to at most ${Math.round(this.longOutageCap() / 1000)}s between ` +
            'attempts and not giving up',
        ),
      )
    }

    const delay = this.computeReconnectDelay(attempt)
    this.setState('backoff')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retryNow()
    }, delay)
  }

  /**
   * The server rejected the credential. `blocked` is not the end: a fresh
   * HELLO goes out every AUTH_RETRY_INTERVAL_MS (jittered) until one is
   * accepted — keys get rotated back and accounts get reinstated, and the
   * running client has no other way to learn it. The first rejection of a
   * run is an error; the following ones only fire `blocked`, so an operator
   * sees one line per incident rather than one every quarter hour.
   */
  private enterBlocked(code: number, reason: string): void {
    const retryInMs = this.options.reconnect
      ? this.jittered(AUTH_RETRY_INTERVAL_MS, AUTH_RETRY_JITTER_RATIO)
      : null
    this.setState('blocked')

    if (!this.blockedAnnounced) {
      this.blockedAnnounced = true
      this.emitError(
        new ConnectionError(
          `server rejected the credential (close ${code}${reason ? ` ${reason}` : ''}); ` +
            (retryInMs !== null
              ? `retrying with a fresh HELLO in about ${Math.round(retryInMs / 60_000)} min ` +
                'and every 10–15 min after that until it is accepted again'
              : 'reconnect is off, so call connect() to try again'),
        ),
      )
    }

    const info: BlockedInfo = { code, reason, retryInMs }
    for (const handler of this.blockedHandlers) {
      try { handler(info) } catch { /* user hook must not break flow */ }
    }

    if (retryInMs === null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retryNow()
    }, retryInMs)
  }

  /**
   * The timer-driven attempt. connect() emits and re-arms on its own for
   * every failure it retries (a throwing constructor, a close); the one
   * failure it does not retry — no WebSocket implementation at all — left
   * nothing armed, so it is announced here: the operator should see why the
   * client went quiet.
   */
  private retryNow(): void {
    void this.connect().catch((err) => {
      if (this.disposed || this.ws || this.reconnectTimer) return
      this.emitError(err instanceof Error ? err : new ConnectionError(String(err)))
    })
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private computeReconnectDelay(attempt: number): number {
    const exp = this.options.reconnectInterval * Math.pow(2, Math.min(attempt - 1, 20))
    // A long outage widens the cap: a down control plane is polled every few
    // minutes instead of every `maxReconnectInterval`, for as long as it takes.
    const cap =
      attempt > LONG_OUTAGE_AFTER_ATTEMPTS ? this.longOutageCap() : this.options.maxReconnectInterval
    return this.jitteredBelow(Math.min(exp, cap), RECONNECT_JITTER_RATIO)
  }

  private longOutageCap(): number {
    return Math.max(this.options.maxReconnectInterval, LONG_OUTAGE_MAX_INTERVAL_MS)
  }

  /** Symmetric ±ratio jitter around `ms` — for the blocked retry, a range (10–15 min), not a cap. */
  private jittered(ms: number, ratio: number): number {
    const factor = 1 - ratio + Math.random() * 2 * ratio
    return Math.max(0, Math.floor(ms * factor))
  }

  /** Jitter in [ms × (1 − ratio), ms]: `ms` is a ceiling. Thundering-herd-safe across a fleet. */
  private jitteredBelow(ms: number, ratio: number): number {
    const factor = 1 - Math.random() * ratio
    return Math.max(0, Math.floor(ms * factor))
  }

  private armHandshakeDeadline(): void {
    this.clearHandshakeTimer()
    const ms = this.options.handshakeTimeoutMs
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      this.emitError(new ConnectionError(`handshake timeout: no hello.ok within ${ms}ms`))
      this.abandonSocket(CLIENT_CLOSE_CODE, 'client handshake timeout')
    }, ms)
    unref(this.handshakeTimer)
  }

  /**
   * Note proof of life (any inbound frame, or a ping/pong on a socket that
   * shows them). The timer itself is lazy: it is armed once per connection
   * and, when it fires early because traffic arrived meanwhile, re-arms for
   * the remainder — one `Date.now()` per frame instead of a timer churn.
   */
  private touchLiveness(): void {
    this.lastInboundAt = Date.now()
    if (this.livenessTimer === null) this.armLiveness(this.livenessMs)
  }

  private armLiveness(ms: number): void {
    if (this.livenessMs <= 0 || !this.ws || !this.authenticated) return
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null
      const quietFor = Date.now() - this.lastInboundAt
      if (quietFor < this.livenessMs) {
        this.armLiveness(this.livenessMs - quietFor)
        return
      }
      this.emitError(
        new ConnectionError(`liveness timeout: nothing received for ${this.livenessMs}ms`),
      )
      this.abandonSocket(CLIENT_CLOSE_CODE, 'client liveness timeout')
    }, Math.max(1, ms))
    unref(this.livenessTimer)
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private clearWatchdogs(): void {
    this.clearHandshakeTimer()
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private setState(next: RealtimeState): void {
    const previous = this._state
    if (previous === next) return
    this._state = next
    for (const handler of this.stateHandlers) {
      try { handler(next, previous) } catch { /* user hook must not break flow */ }
    }
  }

  /**
   * Subscribe to one event type. `wake` handlers receive a typed
   * `WakeFrame`; the frame carries no message and is never acknowledged.
   * Returns an unsubscribe function.
   *
   * Three events are the client's own rather than server frames:
   * - `state` — every transition of `state` (see `RealtimeState`).
   * - `blocked` — the server rejected the credential during the handshake;
   *   carries the close code, reason and the delay to the next attempt.
   * - `stopped` — `disconnect()` was called; fired once, before handlers
   *   are released.
   */
  on(event: 'wake', handler: WakeHandler): () => void
  on(event: 'state', handler: StateHandler): () => void
  on(event: 'blocked', handler: BlockedHandler): () => void
  on(event: 'stopped', handler: StoppedHandler): () => void
  on(event: string, handler: MessageHandler): () => void
  on(
    event: string,
    handler: MessageHandler | WakeHandler | StateHandler | BlockedHandler | StoppedHandler,
  ): () => void {
    // Lifecycle events live in their own sets: a server frame that happened
    // to be typed 'state' must never reach them through dispatch.
    switch (event) {
      case 'state':
        return this.subscribe(this.stateHandlers, handler as StateHandler)
      case 'blocked':
        return this.subscribe(this.blockedHandlers, handler as BlockedHandler)
      case 'stopped':
        return this.subscribe(this.stoppedHandlers, handler as StoppedHandler)
      default:
        break
    }
    let handlers = this.handlers.get(event)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(event, handlers)
    }
    // A validated wake frame is a WsMessage whose payload is a WakePayload;
    // dispatchWake guarantees the shape before any 'wake' handler runs.
    const stored = handler as MessageHandler
    handlers.add(stored)
    return () => {
      handlers!.delete(stored)
      if (handlers!.size === 0) this.handlers.delete(event)
    }
  }

  private subscribe<T>(set: Set<T>, handler: T): () => void {
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /**
   * Every signal the client has for its operator comes through here:
   * transport errors, handler failures, the watchdog and backoff notices
   * (`handshake timeout`, `liveness timeout`, `still reconnecting after
   * 60 …`, `server rejected the credential …`, `connection is unstable`).
   * The SDK never writes to the console.
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  /** Fires each time the handshake completes (initial + every reconnect). */
  onConnect(handler: ConnectHandler): () => void {
    this.connectHandlers.add(handler)
    return () => this.connectHandlers.delete(handler)
  }

  /** Fires on every socket close, regardless of reason (clean or error). */
  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  send(message: WsMessage): void {
    // `WebSocket.OPEN` is 1 per the spec — hardcode rather than reading
    // from `WebSocket.OPEN`, which is only available as a static on
    // whichever constructor we resolved (native vs `ws`).
    if (!this.ws || this.ws.readyState !== 1 || !this.authenticated) {
      throw new ConnectionError('WebSocket is not connected')
    }
    this.ws.send(JSON.stringify(message))
  }

  /**
   * Announce that the caller has started composing in `conversationId`.
   * Fire-and-forget: server broadcasts a `typing.start` event to every
   * other participant but does not ACK. Pair with `sendTypingStop` when
   * the agent finishes composing or navigates away. Throws
   * `ConnectionError` if the socket is not open.
   */
  sendTypingStart(conversationId: string): void {
    this.send({ type: 'typing.start', payload: { conversation_id: conversationId } })
  }

  /** Counterpart to `sendTypingStart`. */
  sendTypingStop(conversationId: string): void {
    this.send({ type: 'typing.stop', payload: { conversation_id: conversationId } })
  }

  /**
   * Push a read receipt. `throughSeq` means "every message up to and
   * including this seq is read". The server fans out a `message.read`
   * event to other participants. Cheap to call repeatedly; send the
   * highest seq observed per conversation.
   */
  sendReadAck(conversationId: string, throughSeq: number): void {
    this.send({
      type: 'message.read_ack',
      payload: { conversation_id: conversationId, through_seq: throughSeq },
    })
  }

  /** `true` after a completed HELLO handshake and before the next close. */
  get isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === 1
  }

  /** Where the connection lifecycle is right now. See `RealtimeState`. */
  get state(): RealtimeState {
    return this._state
  }

  /**
   * `true` when the current connection's `hello.ok` echoed the `ack`
   * capability: the server keeps each envelope `stored` until this client
   * acknowledges it. `false` before `hello.ok`, after a close, and against
   * a legacy server (which marks envelopes delivered on push).
   */
  get ackNegotiated(): boolean {
    return this.ackMode
  }

  /**
   * Close the socket, cancel every timer, and release all handlers. The
   * only way into `stopped`, and the only way the client ever stops on
   * purpose: works from any state (`blocked` and a pending backoff
   * included). `stopped` fires once. After this, `connect()` throws —
   * create a fresh `RealtimeClient` if you want to reopen.
   */
  disconnect(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.reconnect = false
    this.clearReconnectTimer()
    this.clearWatchdogs()
    this.cancelStabilityTimer()
    // Flush any buffered envelopes synchronously so the caller doesn't
    // miss them after disconnect(). No gap-fill — we're tearing down,
    // and an in-flight HTTP request would race the close.
    this.flushParkedFrames('gap_fill_unavailable')
    const ws = this.ws
    this.ws = null
    try { ws?.close(1000, 'client disconnect') } catch { /* already closed */ }
    this.authenticated = false
    this.ackMode = false
    this.setState('stopped')
    for (const handler of this.stoppedHandlers) {
      try { handler() } catch { /* user hook must not break flow */ }
    }
    this.handlers.clear()
    this.errorHandlers.clear()
    this.connectHandlers.clear()
    this.disconnectHandlers.clear()
    this.stateHandlers.clear()
    this.blockedHandlers.clear()
    this.stoppedHandlers.clear()
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      // Every notice is emitted right before the step that keeps the client
      // alive (arming a timer, opening the next socket). A throwing observer
      // must not take that step with it — that would be the one way into a
      // parked client.
      try { handler(error) } catch { /* user hook must not break flow */ }
    }
  }

  private dispatch(message: WsMessage): void {
    if (this.isMessageNew(message)) {
      // message.new rides the dedup + delivery-ack pipeline. Handlers are
      // still invoked synchronously and in order here; only settlement
      // (async handler completion → ack) is deferred. The returned promise
      // never rejects.
      void this.dispatchMessageNew(message)
      return
    }
    const handlers = this.handlers.get(message.type)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        const result = handler(message)
        if (isThenable(result)) {
          result.catch((err) => this.emitError(toError(err, message.type)))
        }
      } catch (err) {
        // A throwing handler must not break dispatch to the remaining
        // handlers (or, upstream, the WebSocket message pump).
        this.emitError(toError(err, message.type))
      }
    }
  }

  /**
   * Dedup + dispatch + acknowledge one `message.new` envelope. Never
   * rejects.
   *
   * Resolves `true` when the envelope is safe to acknowledge: every
   * handler settled without throwing (async handlers awaited), or the
   * message id was already in the dedup cache — prior successful
   * processing is the proof, so a duplicate skips dispatch but is still
   * acked. Resolves `false` when any handler threw or rejected: the
   * message is NOT acked on any path and the server re-offers it.
   *
   * A copy of a message whose first copy is still with the handlers is not
   * dispatched again: it resolves with the first copy's outcome (and, when
   * that succeeded, is acked like a dedup hit).
   *
   * Ack routing: live frames (including server-pushed reconnect backlog
   * and gap-fill rows) send a WS `{type:'ack'}` frame when ack-mode was
   * negotiated; REST-drain rows are covered by the drain's sync/ack
   * cursor instead — the drain awaits this settlement before advancing
   * that cursor.
   */
  private dispatchMessageNew(message: WsMessage): Promise<boolean> {
    const isDrainRow = this.restDrainOrigin.has(message)
    const messageId = this.extractMessageId(message)
    // Drain rows are covered by the REST cursor; ack-on-receipt frames were
    // acked at parse (or at gap-fill fetch) time. Everything else acks here,
    // once dispatch has settled.
    const ackAfterDispatch = !isDrainRow && !this.options.ackOnReceipt

    let settlement: Promise<boolean>

    const first = messageId !== null ? this.inFlight.get(messageId) : undefined

    if (messageId !== null && this.dedupHit(messageId)) {
      settlement = Promise.resolve(true)
      if (ackAfterDispatch) this.sendAckFrame(messageId)
    } else if (messageId !== null && first !== undefined) {
      // The same message is already with the handlers. Wait for that
      // outcome instead of dispatching it twice: success covers this copy
      // too (acked like a dedup hit), a failure leaves it unacked so the
      // server re-offers it. A drain row's cursor waits here as it would
      // for its own handler.
      settlement = first.then((ok) => {
        if (ok && ackAfterDispatch) this.sendAckFrame(messageId)
        return ok
      })
    } else {
      const handlers = this.handlers.get('message.new')
      const pending: Array<Promise<unknown>> = []
      if (handlers) {
        for (const handler of handlers) {
          try {
            const result = handler(message)
            if (isThenable(result)) pending.push(result)
          } catch (err) {
            pending.push(Promise.reject(err))
          }
        }
      }
      const own: Promise<boolean> = Promise.allSettled(pending).then((outcomes) => {
        // Leave the in-flight map in the same step the outcome is known
        // (and, on success, the id enters the dedup cache): a later copy
        // always finds one or the other, never neither.
        if (messageId !== null && this.inFlight.get(messageId) === own) {
          this.inFlight.delete(messageId)
        }
        let ok = true
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            ok = false
            this.emitError(toError(outcome.reason, 'message.new'))
          }
        }
        if (!ok) return false
        if (messageId !== null) {
          this.dedupAdd(messageId)
          if (ackAfterDispatch) this.sendAckFrame(messageId)
        }
        return true
      })
      if (messageId !== null) this.inFlight.set(messageId, own)
      settlement = own
    }

    if (isDrainRow) this.drainSettlements.set(message, settlement)
    return settlement
  }

  /**
   * Best-effort delivery ack for one processed message. No-op unless the
   * server negotiated ack-mode on this connection. Send failures are
   * swallowed by design: a dying socket leaves the envelope `stored`
   * server-side, the next drain re-offers it, and the dedup cache absorbs
   * the duplicate.
   */
  private sendAckFrame(messageId: string): void {
    if (!this.ackMode) return
    if (!this.ws || this.ws.readyState !== 1 || !this.authenticated) return
    try {
      this.ws.send(JSON.stringify({ type: 'ack', message_id: messageId }))
    } catch { /* socket teardown race — redelivery + dedup cover it */ }
  }

  // Membership check that also refreshes recency on a hit (Set iteration
  // order is insertion order, so delete + re-add moves the id to the back
  // of the eviction queue).
  private dedupHit(messageId: string): boolean {
    if (!this.dedupSeen.has(messageId)) return false
    this.dedupSeen.delete(messageId)
    this.dedupSeen.add(messageId)
    return true
  }

  private dedupAdd(messageId: string): void {
    this.dedupSeen.delete(messageId)
    this.dedupSeen.add(messageId)
    while (this.dedupSeen.size > this.options.dedupCacheSize) {
      const oldest = this.dedupSeen.values().next().value
      if (oldest === undefined) break
      this.dedupSeen.delete(oldest)
    }
  }

  private extractMessageId(message: WsMessage): string | null {
    const id = (message as { payload?: { id?: unknown } }).payload?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  }

  private isMessageNew(message: WsMessage): boolean {
    return (message as { type?: string }).type === 'message.new'
  }

  private isWake(message: WsMessage): boolean {
    return (message as { type?: string }).type === 'wake'
  }

  /**
   * A `wake` frame is a content-free signal: validate the payload shape
   * (so `wake` handlers can trust the `WakeFrame` type), then dispatch. A
   * frame the server sent malformed is surfaced through `onError` rather
   * than handed to handlers as something it is not. Never acked — there is
   * no message to deliver.
   */
  private dispatchWake(message: WsMessage): void {
    const payload = (message as { payload?: unknown }).payload
    const reason = this.wakePayloadProblem(payload)
    if (reason !== null) {
      this.emitError(new ConnectionError(`wake frame failed validation: ${reason}`))
      return
    }
    this.dispatch(message)
  }

  private wakePayloadProblem(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return 'payload is not an object'
    }
    const p = payload as Record<string, unknown>
    for (const key of ['reason', 'conversation_id', 'anchor_message_id', 'at'] as const) {
      if (typeof p[key] !== 'string' || p[key] === '') return `${key} is not a non-empty string`
    }
    if (typeof p.step !== 'number' || !Number.isInteger(p.step)) return 'step is not an integer'
    return null
  }

  // ─── Per-conversation seq ordering ───────────────────────────────────────
  //
  // Invariant: for any conversation_id, handlers see message.new envelopes
  // in seq-ascending order with no skipped or repeated seqs — except that a
  // frame older than this connection's anchor (a stored row the drain brings
  // after a live frame anchored the conversation, or a seq a failed gap-fill
  // skipped) is dispatched late rather than dropped: never lost beats
  // strictly ordered, since the ack would otherwise bury it for good. The
  // dedup cache alone decides what is a repeat.
  //
  // Why per-conversation instead of global: seq numbers are minted per
  // conversation by send_message_atomic, so cross-conversation arrivals
  // have no ordering relationship to enforce.

  private processOrderedMessage(message: WsMessage): void {
    const payload = (message as { payload?: { conversation_id?: unknown; seq?: unknown } }).payload
    const conversationId = payload?.conversation_id

    // No conversation_id → not a real fan-out envelope. Pass through so a
    // malformed or extension envelope isn't silently dropped.
    if (typeof conversationId !== 'string') {
      this.dispatch(message)
      return
    }

    const seq = this.extractSeq(message)
    // System messages (e.g. server-emitted notices reusing message.new
    // shape) may not carry a numeric seq. Dispatch immediately rather
    // than blocking the per-conversation cursor on a non-orderable msg.
    if (seq === null) {
      this.dispatch(message)
      return
    }

    const state = this.getOrCreateOrderState(conversationId)

    // First arrival for this conversation in this connection — anchor.
    // We can't validate against history we never saw; the application
    // is responsible for running /sync if it cares about earlier rows.
    if (state.nextExpectedSeq === null) {
      state.nextExpectedSeq = seq + 1
      this.dispatch(message)
      return
    }

    if (seq < state.nextExpectedSeq) {
      // Below the anchor. With a first-arrival anchor this means "older
      // than the first frame this connection saw", NOT "already
      // dispatched": the server registers a socket before it drains the
      // stored backlog, so a live frame can anchor a conversation at seq 5
      // and the drain then brings stored seqs 3 and 4 that no handler has
      // ever seen. Dropping them here would lose them: the drain cursor (or
      // the ack-on-receipt frame) marks them delivered and the server never
      // re-offers them. The same holds for a seq skipped by a failed
      // gap-fill that arrives late. So hand the frame to dispatch, where the
      // dedup cache — the only evidence of a prior dispatch — decides: a hit
      // skips the handlers and acks, a miss dispatches (out of order, never
      // lost) and acks after.
      this.dispatch(message)
      return
    }

    if (seq === state.nextExpectedSeq) {
      // The expected next message — dispatch and try to drain any
      // higher-seq messages that were waiting on this one.
      this.dispatch(message)
      state.nextExpectedSeq = seq + 1
      this.drainConsecutive(conversationId, state)
      // The drain may have closed the gap that motivated a pending timer.
      this.maybeClearGapTimer(state)
      this.cleanupIfIdle(conversationId, state)
      return
    }

    // seq > nextExpectedSeq — out of order. Buffer and start the gap timer
    // if not already running.
    state.buffer.set(seq, message)

    if (state.buffer.size > MAX_BUFFERED_PER_CONVERSATION) {
      // Pathological: emit everything we have and skip past the gap.
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'buffer_overflow',
        bufferedSeq: this.minBufferedSeq(state),
      })
      return
    }

    if (state.gapTimer === null) {
      state.gapStartedAt = Date.now()
      state.gapStartedExpectedSeq = state.nextExpectedSeq
      state.gapTimer = setTimeout(() => {
        void this.handleGapTimer(conversationId)
      }, GAP_FILL_WINDOW_MS)
    }
  }

  private async handleGapTimer(conversationId: string): Promise<void> {
    const state = this.orderStates.get(conversationId)
    if (!state) return
    state.gapTimer = null

    // Race: the missing seq might have arrived while the timer was
    // queued (the dispatch-loop drain didn't trigger maybeClearGapTimer
    // because the timer was still ticking). If we're caught up, exit.
    if (state.buffer.size === 0) {
      this.cleanupIfIdle(conversationId, state)
      return
    }

    const expectedSeq = state.nextExpectedSeq
    if (expectedSeq === null) return // shouldn't happen, defensive

    // No client → can't gap-fill. Drain in seq order, advance past the
    // gap, surface the incident.
    if (!this.options.client) {
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'gap_fill_unavailable',
        bufferedSeq: this.minBufferedSeq(state),
      })
      return
    }

    // Already fetching (e.g. the timer fired again before the previous
    // call returned). Defer; the in-flight call will resolve everything.
    if (state.gapFillInFlight) return
    state.gapFillInFlight = true

    let fetched: Message[] = []
    let fillError = false
    try {
      // afterSeq is exclusive (seq > N), so subtract 1 to make the
      // expected seq inclusive. The server caps internally at GAP_FILL_LIMIT
      // worth of rows; we pass our own limit as a belt-and-braces.
      fetched = await this.options.client.getMessages(conversationId, {
        afterSeq: expectedSeq - 1,
        limit: GAP_FILL_LIMIT,
      })
    } catch {
      fillError = true
    } finally {
      state.gapFillInFlight = false
    }

    // The state may have been reset (disconnect during the await) — bail.
    const stateNow = this.orderStates.get(conversationId)
    if (!stateNow || stateNow !== state) return

    if (fillError) {
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'gap_fill_failed',
        bufferedSeq: this.minBufferedSeq(state),
      })
      return
    }

    // Insert fetched rows into the buffer (skip anything below our cursor —
    // shouldn't happen but defensive against server-side filtering changes).
    for (const row of fetched) {
      const rowSeq = typeof row.seq === 'number' ? row.seq : null
      if (rowSeq === null || rowSeq < expectedSeq) continue
      // Skip if already in buffer (the natural arrival beat us to it).
      if (state.buffer.has(rowSeq)) continue
      // Wrap as a message.new envelope for the dispatch path.
      const envelope: WsMessage = {
        type: 'message.new',
        payload: row as unknown as Record<string, unknown>,
      }
      // Ack-on-receipt: the fetch is this machine's receipt of the row.
      if (this.options.ackOnReceipt) {
        const messageId = this.extractMessageId(envelope)
        if (messageId !== null) this.sendAckFrame(messageId)
      }
      state.buffer.set(rowSeq, envelope)
    }

    // Drain consecutive starting from expectedSeq. If we still hit a gap
    // after draining (the server returned [9, 10, 12] when we needed 11),
    // that's a partial recovery — surface as recovered:false but keep
    // moving. The application should /sync to fully reconcile.
    const drainedThroughGap = this.drainConsecutive(conversationId, state)
    if (drainedThroughGap) {
      this.resolveGap(conversationId, state, {
        recovered: true,
        reason: 'gap_filled',
        bufferedSeq: null,
      })
    } else {
      // Either the fetch returned nothing useful or there's still a hole.
      // Drop into the same fallback path as gap_fill_failed: dispatch
      // whatever's contiguous-from-buffer-min and skip ahead.
      this.resolveGap(conversationId, state, {
        recovered: false,
        reason: 'gap_fill_failed',
        bufferedSeq: this.minBufferedSeq(state),
      })
    }
  }

  // Returns true if we drained at least one message past the original
  // expected seq (i.e. the gap is closed for now). Returns false if the
  // expected seq still isn't in the buffer — caller decides what to do.
  private drainConsecutive(conversationId: string, state: OrderState): boolean {
    if (state.nextExpectedSeq === null) return false
    let drained = false
    while (state.buffer.has(state.nextExpectedSeq)) {
      const msg = state.buffer.get(state.nextExpectedSeq)!
      state.buffer.delete(state.nextExpectedSeq)
      this.dispatch(msg)
      state.nextExpectedSeq += 1
      drained = true
    }
    if (drained) this.cleanupIfIdle(conversationId, state)
    return drained
  }

  // Force-resolve a gap by dispatching every buffered message in seq
  // order, advancing nextExpectedSeq past the highest, and firing the
  // onSequenceGap callback. Used for unrecoverable cases (no client,
  // fetch failed, buffer overflow).
  private resolveGap(
    conversationId: string,
    state: OrderState,
    info: {
      recovered: boolean
      reason: SequenceGapInfo['reason']
      bufferedSeq: number | null
    },
  ): void {
    const expectedSeq = state.gapStartedExpectedSeq ?? state.nextExpectedSeq ?? 0
    const gapMs = state.gapStartedAt !== null ? Date.now() - state.gapStartedAt : 0

    const seqs = Array.from(state.buffer.keys()).sort((a, b) => a - b)
    let highestDispatched = state.nextExpectedSeq !== null ? state.nextExpectedSeq - 1 : -1
    for (const s of seqs) {
      const msg = state.buffer.get(s)!
      this.dispatch(msg)
      if (s > highestDispatched) highestDispatched = s
    }
    state.buffer.clear()
    if (highestDispatched >= 0) {
      state.nextExpectedSeq = highestDispatched + 1
    }

    if (state.gapTimer !== null) {
      clearTimeout(state.gapTimer)
      state.gapTimer = null
    }
    state.gapStartedAt = null
    state.gapStartedExpectedSeq = null

    this.options.onSequenceGap?.({
      conversationId,
      expectedSeq,
      bufferedSeq: info.bufferedSeq,
      gapMs,
      recovered: info.recovered,
      reason: info.reason,
    })

    this.cleanupIfIdle(conversationId, state)
  }

  private maybeClearGapTimer(state: OrderState): void {
    if (state.gapTimer !== null && state.buffer.size === 0) {
      clearTimeout(state.gapTimer)
      state.gapTimer = null
      state.gapStartedAt = null
      state.gapStartedExpectedSeq = null
    }
  }

  private getOrCreateOrderState(conversationId: string): OrderState {
    let state = this.orderStates.get(conversationId)
    if (!state) {
      state = {
        nextExpectedSeq: null,
        buffer: new Map(),
        gapTimer: null,
        gapStartedAt: null,
        gapStartedExpectedSeq: null,
        gapFillInFlight: false,
      }
      this.orderStates.set(conversationId, state)
    }
    return state
  }

  // Drop the per-conversation entry once it's quiescent (no buffered
  // messages, no pending gap timer, no in-flight fetch). Keeps the map
  // bounded — without this, every conversation an agent ever touches
  // would leave a stale entry alive for the lifetime of the connection.
  private cleanupIfIdle(conversationId: string, state: OrderState): void {
    if (
      state.buffer.size === 0 &&
      state.gapTimer === null &&
      !state.gapFillInFlight
    ) {
      this.orderStates.delete(conversationId)
    }
  }

  private extractSeq(message: WsMessage): number | null {
    const seq = (message as { payload?: { seq?: unknown } }).payload?.seq
    return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
  }

  private minBufferedSeq(state: OrderState): number | null {
    if (state.buffer.size === 0) return null
    let min = Infinity
    for (const k of state.buffer.keys()) if (k < min) min = k
    return Number.isFinite(min) ? min : null
  }

  private resetOrderStates(): void {
    for (const state of this.orderStates.values()) {
      if (state.gapTimer !== null) clearTimeout(state.gapTimer)
    }
    this.orderStates.clear()
  }

  // Hand every parked frame to the handlers in seq order per conversation,
  // cancel the gap timers and clear the ordering state. Used when frames
  // must not be dropped: on disconnect() (the caller is leaving) and, under
  // ackOnReceipt, on every socket close (the frames are already acked).
  private flushParkedFrames(reason: SequenceGapInfo['reason']): void {
    for (const [conversationId, state] of this.orderStates) {
      if (state.gapTimer !== null) {
        clearTimeout(state.gapTimer)
        state.gapTimer = null
      }
      if (state.buffer.size === 0) continue
      const seqs = Array.from(state.buffer.keys()).sort((a, b) => a - b)
      for (const s of seqs) this.dispatch(state.buffer.get(s)!)
      state.buffer.clear()
      this.options.onSequenceGap?.({
        conversationId,
        expectedSeq: state.gapStartedExpectedSeq ?? state.nextExpectedSeq ?? 0,
        bufferedSeq: seqs[0] ?? null,
        gapMs: state.gapStartedAt !== null ? Date.now() - state.gapStartedAt : 0,
        recovered: false,
        reason,
      })
    }
    this.orderStates.clear()
  }
}
