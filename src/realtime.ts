import type { WsMessage, Message } from './types/index.js'
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
 * eventual duplicate of anything that DID succeed).
 */
export type MessageHandler = (message: WsMessage) => void | Promise<void>
export type ErrorHandler = (error: Error) => void

/**
 * Fired once per successful HELLO_ACK. Useful for updating UI ("connected"
 * state), (re)subscribing to typing indicators, emitting metrics, etc.
 * Not guaranteed to be called on the initial connect — only after a
 * handshake completes.
 */
export type ConnectHandler = () => void

/** Fired on every socket close, regardless of reason. */
export type DisconnectHandler = (info: { code: number; reason: string; wasClean: boolean }) => void

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
  /** Auto-reconnect on unexpected close. Default: `true`. */
  reconnect?: boolean
  /**
   * Initial reconnect delay in milliseconds. Subsequent reconnects use
   * exponential backoff with ±25% jitter, capped at
   * `maxReconnectInterval`. Default: 500ms.
   */
  reconnectInterval?: number
  /** Maximum delay between reconnect attempts. Default: 30s. */
  maxReconnectInterval?: number
  /** Maximum total reconnect attempts before giving up. Default: Infinity. */
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
   * Override the WebSocket constructor. Defaults to `globalThis.WebSocket`
   * with a dynamic-import fallback to the `ws` package (for Node 20).
   * Tests use this to inject a mock. Users on a polyfilled environment
   * can supply their own implementation — anything that matches the
   * browser WebSocket shape (`onopen/onmessage/onclose/onerror`, `send`,
   * `close`, `readyState`) works.
   */
  webSocket?: typeof globalThis.WebSocket
}

// Time to wait for `hello.ok` after sending the HELLO frame before we give
// up and reconnect. Must stay under the server-side HELLO_TIMEOUT_MS (5s).
const HELLO_ACK_TIMEOUT_MS = 4_000

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

// Close codes that mean "the server rejected this session and retrying with
// the same credentials cannot succeed": 1008 (policy violation — the server
// closes invalid/expired API keys with it) and 4401/4403 (explicit
// auth-rejected codes). Reconnecting on these would hammer the server with
// doomed handshakes forever, so they are terminal: the client surfaces a
// final error through onError and stops. The one exception is our own
// HELLO-ack-timeout close, which reuses 1008 on the wire but is transient —
// see the `helloTimeoutClose` flag.
const TERMINAL_CLOSE_CODES = new Set([1008, 4401, 4403])

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
    maxReconnectAttempts: number
    client?: AgentChatClient
    onSequenceGap?: SequenceGapHandler
    autoDrainOnConnect: boolean
    dedupCacheSize: number
    webSocket?: typeof globalThis.WebSocket
    clientIdentity: AgentChatClientIdentity
  }
  private handlers = new Map<string, Set<MessageHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private connectHandlers = new Set<ConnectHandler>()
  private disconnectHandlers = new Set<DisconnectHandler>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private helloAckTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false
  // True only when the server echoed the 'ack' capability in hello.ok.
  // Per-connection: reset on every close and re-negotiated on every HELLO.
  private ackMode = false
  // Set immediately before our own close(1008, 'HELLO ack timeout') so the
  // onclose handler can tell this transient self-close apart from a
  // server-initiated 1008 (which is terminal — invalid credentials).
  private helloTimeoutClose = false
  // Bounded LRU of recently-dispatched message ids (Set iteration order is
  // insertion order — delete + re-add refreshes recency). Ids are added
  // only AFTER a successful dispatch: adding earlier would let a failed
  // dispatch suppress its own redelivery.
  private dedupSeen = new Set<string>()
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
    this.options = {
      baseUrl: options.baseUrl ?? 'wss://api.agentchat.me',
      reconnect: options.reconnect ?? true,
      reconnectInterval: options.reconnectInterval ?? 500,
      maxReconnectInterval: options.maxReconnectInterval ?? 30_000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY,
      apiKey: options.apiKey,
      client: options.client,
      onSequenceGap: options.onSequenceGap,
      autoDrainOnConnect: options.autoDrainOnConnect ?? Boolean(options.client),
      dedupCacheSize,
      webSocket: options.webSocket,
      clientIdentity: options.clientIdentity ?? DEFAULT_CLIENT_IDENTITY,
    }
  }

  /**
   * Open the WebSocket connection and perform the HELLO handshake.
   * Resolves once the socket is open and the HELLO frame has been sent —
   * NOT after `hello.ok`. Listen for `onConnect()` to react to a
   * completed handshake.
   *
   * Safe to call on a disposed client only if you expect a fresh run —
   * reinstate with a new instance instead.
   */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new ConnectionError('RealtimeClient has been disposed; create a new instance to reconnect.')
    }

    let WebSocketCtor: typeof globalThis.WebSocket
    try {
      WebSocketCtor = this.options.webSocket ?? (await resolveWebSocket())
    } catch (err) {
      const error = err instanceof Error ? err : new ConnectionError('Failed to resolve WebSocket')
      this.emitError(error)
      this.scheduleReconnect()
      throw error
    }

    // Authenticate via HELLO frame (not URL). Browser WebSocket cannot set
    // custom headers, so this is the only cross-runtime path. The API key
    // never appears in the URL, access logs, or Referer headers.
    const url = `${this.options.baseUrl}/v1/ws`
    this.ws = new WebSocketCtor(url)
    this.authenticated = false
    this.ackMode = false
    this.helloTimeoutClose = false

    this.ws.onopen = () => {
      try {
        // Advertise the delivery-ack capability (docs/realtime-delivery-ack.md).
        // Legacy servers ignore unknown HELLO fields; ack-mode turns on only
        // if hello.ok echoes the capability back.
        this.ws!.send(
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
        return
      }

      this.helloAckTimer = setTimeout(() => {
        this.emitError(new ConnectionError('HELLO ack timeout'))
        // 1008 doubles as a terminal auth code on server-initiated closes;
        // flag this self-close so onclose keeps the reconnect loop alive.
        this.helloTimeoutClose = true
        try { this.ws?.close(1008, 'HELLO ack timeout') } catch { /* already closed */ }
      }, HELLO_ACK_TIMEOUT_MS)
    }

    this.ws.onmessage = (event: MessageEvent) => {
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
          this.reconnectAttempts = 0
          if (this.helloAckTimer) {
            clearTimeout(this.helloAckTimer)
            this.helloAckTimer = null
          }
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
        this.processOrderedMessage(message)
        return
      }
      this.dispatch(message)
    }

    this.ws.onerror = () => {
      this.emitError(new ConnectionError('WebSocket error'))
    }

    this.ws.onclose = (event: CloseEvent) => {
      if (this.helloAckTimer) {
        clearTimeout(this.helloAckTimer)
        this.helloAckTimer = null
      }
      this.authenticated = false
      this.ackMode = false
      const selfClosedForHelloTimeout = this.helloTimeoutClose
      this.helloTimeoutClose = false

      for (const handler of this.disconnectHandlers) {
        try {
          handler({ code: event.code, reason: event.reason, wasClean: event.wasClean })
        } catch { /* user hook must not break flow */ }
      }

      // Drop all per-conversation ordering state. Across the connection
      // break the application is responsible for calling /sync (or
      // enabling `autoDrainOnConnect`), which re-establishes the cursor
      // via the next message.new arrival. Leaving stale nextExpectedSeq
      // values would cause spurious gap detections after reconnect when
      // a /sync drain delivers higher-seq rows than what live previously
      // emitted.
      this.resetOrderStates()

      // Terminal auth closes: the server rejected the session outright
      // (invalid/expired key, forbidden). Retrying with the same
      // credentials is a doomed loop, so stop here — surface a final
      // error and leave reconnection off. Our own HELLO-ack-timeout close
      // reuses 1008 on the wire and is explicitly exempted: a slow
      // hello.ok is transient and must keep the retry loop alive.
      if (TERMINAL_CLOSE_CODES.has(event.code) && !selfClosedForHelloTimeout) {
        this.emitError(
          new ConnectionError(
            `WebSocket closed with terminal code ${event.code}${event.reason ? ` (${event.reason})` : ''}; ` +
              'the server rejected the session and auto-reconnect has stopped. ' +
              'Check the API key, then create a new RealtimeClient.',
          ),
        )
        return
      }

      this.scheduleReconnect()
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
   * - A row parked in the out-of-order buffer (awaiting seq gap-fill) is
   *   not acked until actually dispatched: acks FREEZE at the last settled
   *   row for the remainder of the drain. Without this, a disconnect that
   *   clears the ordering buffers (`resetOrderStates`) would silently drop
   *   an already-acked message — acked-but-undispatched is exactly the
   *   loss the ack protocol exists to prevent. Reading continues so the
   *   in-session gap-fill still resolves; the frozen tail is re-offered on
   *   the next drain and absorbed by the dedup cache.
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
          if (settlement) {
            const ok = await settlement
            if (!ok) {
              // Handler failure — leave this row and everything after it
              // unacked so the server re-offers them.
              acksFrozen = true
              break
            }
          } else if (this.isBufferedInOrderState(row)) {
            // Parked on a seq gap — not dispatched yet. See the stranding
            // note in the method doc.
            acksFrozen = true
            break
          }
          // Reaching here means the row is safe to cover with the cursor:
          // either its dispatch settled cleanly, or the ordered pipeline
          // dropped it as a below-anchor duplicate (drain/live overlap) —
          // it will never be dispatched this session, and acking it stops
          // the server from re-offering it forever.
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

  // True when a drain row is currently parked in the per-conversation
  // out-of-order buffer (its dispatch is deferred to the gap-fill
  // machinery — natural arrival, gap-fill fetch, or forced resolveGap).
  private isBufferedInOrderState(row: SyncEnvelope): boolean {
    if (typeof row.seq !== 'number') return false
    const state = this.orderStates.get(row.conversation_id)
    return state !== undefined && state.buffer.has(row.seq)
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (!this.options.reconnect) return
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) return
    if (this.reconnectTimer) return

    this.reconnectAttempts++
    const delay = this.computeReconnectDelay(this.reconnectAttempts)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch((err) => {
        this.emitError(err instanceof Error ? err : new ConnectionError(String(err)))
      })
    }, delay)
  }

  private computeReconnectDelay(attempt: number): number {
    const exp = this.options.reconnectInterval * Math.pow(2, Math.min(attempt - 1, 10))
    const capped = Math.min(exp, this.options.maxReconnectInterval)
    // ±25% jitter avoids thundering-herd reconnect when a whole fleet
    // drops at the same moment.
    const jitter = 0.75 + Math.random() * 0.5
    return Math.max(0, Math.floor(capped * jitter))
  }

  on(event: string, handler: MessageHandler): () => void {
    let handlers = this.handlers.get(event)
    if (!handlers) {
      handlers = new Set()
      this.handlers.set(event, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) this.handlers.delete(event)
    }
  }

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

  /**
   * Close the socket, disable auto-reconnect, and release all handlers.
   * After calling this, `connect()` throws — create a fresh
   * `RealtimeClient` if you want to reopen.
   */
  disconnect(): void {
    this.disposed = true
    this.options.reconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.helloAckTimer) {
      clearTimeout(this.helloAckTimer)
      this.helloAckTimer = null
    }
    // Flush any buffered envelopes synchronously so the caller doesn't
    // miss them after disconnect(). No gap-fill — we're tearing down,
    // and an in-flight HTTP request would race the close.
    this.drainAllPendingForShutdown()
    try { this.ws?.close() } catch { /* already closed */ }
    this.ws = null
    this.authenticated = false
    this.handlers.clear()
    this.errorHandlers.clear()
    this.connectHandlers.clear()
    this.disconnectHandlers.clear()
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error)
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
   * Ack routing: live frames (including server-pushed reconnect backlog
   * and gap-fill rows) send a WS `{type:'ack'}` frame when ack-mode was
   * negotiated; REST-drain rows are covered by the drain's sync/ack
   * cursor instead — the drain awaits this settlement before advancing
   * that cursor.
   */
  private dispatchMessageNew(message: WsMessage): Promise<boolean> {
    const isDrainRow = this.restDrainOrigin.has(message)
    const messageId = this.extractMessageId(message)

    let settlement: Promise<boolean>

    if (messageId !== null && this.dedupHit(messageId)) {
      settlement = Promise.resolve(true)
      if (!isDrainRow) this.sendAckFrame(messageId)
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
      settlement = Promise.allSettled(pending).then((outcomes) => {
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
          if (!isDrainRow) this.sendAckFrame(messageId)
        }
        return true
      })
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

  // ─── Per-conversation seq ordering ───────────────────────────────────────
  //
  // Invariant: for any conversation_id, handlers see message.new envelopes
  // strictly in seq-ascending order with no skipped or repeated seqs (modulo
  // the gap-fill failure path, where we surface the incident via
  // onSequenceGap and continue forward).
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
      // Duplicate — usually a drain↔live-fanout race after reconnect, or
      // a server-side double-publish. We've already dispatched this seq
      // (or skipped it during a gap-fill failure), so drop silently.
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
      state.buffer.set(rowSeq, {
        type: 'message.new',
        payload: row as unknown as Record<string, unknown>,
      })
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

  private drainAllPendingForShutdown(): void {
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
        reason: 'gap_fill_unavailable',
      })
    }
    this.orderStates.clear()
  }
}
