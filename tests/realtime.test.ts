import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RealtimeClient, isAuthRejectionClose } from '../src/realtime.js'
import type { WsMessage, Message } from '../src/types/index.js'

// ─── Test double for WebSocket ─────────────────────────────────────────────
//
// Browser WebSocket has a tiny, well-defined surface — constructor, four
// event handler slots, `send()`, `close()`, `readyState`. The mock below
// implements just enough of it to exercise every RealtimeClient path. We
// inject the constructor via `RealtimeOptions.webSocket`, which the SDK
// uses in place of `globalThis.WebSocket` / the `ws` fallback.

type Listener = (event: Event) => void

interface MockOpenEvent extends Event {}
interface MockMessageEvent extends Event {
  data: string
}
interface MockCloseEvent extends Event {
  code: number
  reason: string
  wasClean: boolean
}

class MockWebSocket {
  static readonly instances: MockWebSocket[] = []
  static latest(): MockWebSocket {
    const last = MockWebSocket.instances.at(-1)
    if (!last) throw new Error('MockWebSocket.latest(): no instance yet')
    return last
  }

  static reset() {
    MockWebSocket.instances.length = 0
  }

  readonly url: string
  readyState = 0 // CONNECTING
  readonly sent: string[] = []
  closed: { code: number; reason: string } | null = null

  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  // ─── Driven by tests ──────────────────────────────────────────────────
  simulateOpen() {
    this.readyState = 1 // OPEN
    this.onopen?.({ type: 'open' } as MockOpenEvent)
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({
      type: 'message',
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MockMessageEvent)
  }

  simulateClose(code = 1006, reason = 'abnormal', wasClean = false) {
    this.readyState = 3 // CLOSED
    this.onclose?.({
      type: 'close',
      code,
      reason,
      wasClean,
    } as MockCloseEvent)
  }

  // ─── WebSocket surface the SDK uses ───────────────────────────────────
  send(data: string) {
    this.sent.push(data)
  }

  close(code = 1000, reason = '') {
    this.readyState = 3
    this.closed = { code, reason }
  }
}

// Cast to satisfy the `typeof globalThis.WebSocket` parameter of the SDK.
const MockWebSocketCtor = MockWebSocket as unknown as typeof globalThis.WebSocket

// ─── Node `ws`-shaped socket ────────────────────────────────────────────────
//
// `ws` is an EventEmitter: it surfaces the server's ping frames through
// `on('ping')` and can `terminate()` a dead pipe without a closing handshake.
// The SDK detects this shape and uses both for liveness.
class MockNodeWebSocket extends MockWebSocket {
  private readonly listeners = new Map<string, Set<() => void>>()
  terminated = false

  on(event: string, listener: () => void): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  simulatePing() {
    for (const listener of this.listeners.get('ping') ?? []) listener()
  }

  terminate() {
    this.readyState = 3
    this.terminated = true
  }
}
const MockNodeWebSocketCtor = MockNodeWebSocket as unknown as typeof globalThis.WebSocket

// Open + hello.ok on a mock socket; returns it.
function handshake(ws: MockWebSocket, capabilities: string[] = ['ack']): MockWebSocket {
  ws.simulateOpen()
  ws.simulateMessage({ type: 'hello.ok', capabilities })
  return ws
}

// Helper — builds a message.new envelope for a given conversation + seq.
function messageNew(conversationId: string, seq: number, extra?: Partial<Message>): WsMessage {
  return {
    type: 'message.new',
    payload: {
      id: `msg_${seq}`,
      conversation_id: conversationId,
      sender: '@other',
      client_msg_id: `c_${seq}`,
      seq,
      type: 'text',
      content: { text: `hi ${seq}` },
      metadata: {},
      status: 'stored',
      created_at: '2026-01-01T00:00:00Z',
      delivered_at: null,
      read_at: null,
      ...extra,
    },
  } as unknown as WsMessage
}

// Helper — one bare-array row exactly as `GET /v1/messages/sync` ships it:
// the public message shape plus an opaque string `delivery_id` cursor
// (`del_<32 hex>`, nullable). See tests/sync-wire.test.ts and
// docs/realtime-delivery-ack.md for the authoritative contract.
function syncRow(
  conversationId: string,
  seq: number,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `msg_${conversationId}_${seq}`,
    conversation_id: conversationId,
    delivery_id: `del_${seq.toString(16).padStart(32, '0')}`,
    sender: 'other',
    client_msg_id: `c_${seq}`,
    seq,
    type: 'text',
    content: { text: `hi ${seq}` },
    metadata: {},
    status: 'stored',
    created_at: '2026-01-01T00:00:00Z',
    delivered_at: null,
    read_at: null,
    ...extra,
  }
}

// The drain hops through several awaits per page (sync fetch → per-row
// settlement → ack → next page); a handful of macrotask ticks lets the
// whole loop run to completion. Real timers only — never mix with
// vi.useFakeTimers().
async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

// Parsed frames of a given type sent by the client on a mock socket.
function sentFrames(ws: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return ws.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type)
}

beforeEach(() => {
  MockWebSocket.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('RealtimeClient — handshake', () => {
  it('sends HELLO on open and fires onConnect after hello.ok', async () => {
    const rt = new RealtimeClient({
      apiKey: 'sk_test',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onConnect = vi.fn()
    rt.onConnect(onConnect)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()

    expect(ws.sent).toHaveLength(1)
    // The HELLO frame always advertises the delivery-ack capability; the
    // server decides (via the hello.ok echo) whether it's actually used.
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: 'hello',
      api_key: 'sk_test',
      capabilities: ['ack'],
      client: 'typescript_sdk',
      client_version: '0.0.0-dev',
    })
    expect(onConnect).not.toHaveBeenCalled() // only after hello.ok

    ws.simulateMessage({ type: 'hello.ok' })
    expect(onConnect).toHaveBeenCalledOnce()
    expect(rt.isConnected).toBe(true)

    rt.disconnect()
  })

  it('emits ConnectionError when hello.ok misses the handshake deadline', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onError = vi.fn()
    rt.onError(onError)

    await rt.connect()
    MockWebSocket.latest().simulateOpen()

    vi.advanceTimersByTime(14_999)
    expect(onError).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1) // handshakeTimeoutMs default: 15 s from connect()
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toMatch(/handshake timeout/)
    // reconnect is off: idle, not dead and not blocked.
    expect(rt.state).toBe('idle')

    rt.disconnect()
  })
})

describe('RealtimeClient — message dispatch', () => {
  it('delivers message.new events to registered handlers', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('conv_1', 1))
    ws.simulateMessage(messageNew('conv_1', 2))

    expect(onMessage).toHaveBeenCalledTimes(2)
    const firstPayload = (onMessage.mock.calls[0][0] as WsMessage).payload as { seq: number }
    expect(firstPayload.seq).toBe(1)

    rt.disconnect()
  })

  it('ignores frames that arrive before hello.ok (other than hello.ok itself)', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()

    ws.simulateMessage(messageNew('conv_1', 1)) // pre-ack — dropped
    ws.simulateMessage({ type: 'hello.ok' })
    ws.simulateMessage(messageNew('conv_1', 2)) // post-ack — delivered

    expect(onMessage).toHaveBeenCalledTimes(1)

    rt.disconnect()
  })
})

describe('RealtimeClient — per-conversation seq ordering', () => {
  it('delivers out-of-order seqs in ascending order once the gap closes', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('c', 1)) // anchor
    ws.simulateMessage(messageNew('c', 3)) // buffered (gap at 2)
    ws.simulateMessage(messageNew('c', 4)) // buffered
    expect(seen).toEqual([1])

    ws.simulateMessage(messageNew('c', 2)) // closes the gap
    expect(seen).toEqual([1, 2, 3, 4])

    rt.disconnect()
  })

  it('recovers a gap via client.getMessages after the gap window expires', async () => {
    vi.useFakeTimers()
    const getMessages = vi.fn(
      async (_conv: string, opts: { afterSeq?: number }): Promise<Message[]> => {
        expect(opts.afterSeq).toBe(1) // expectedSeq=2 → afterSeq=1
        return [
          (messageNew('c', 2).payload as unknown) as Message,
        ]
      },
    )
    const mockClient = {
      getMessages,
      sync: vi.fn(),
      syncAck: vi.fn(),
    } as unknown as import('../src/client.js').AgentChatClient

    const onGap = vi.fn()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient,
      autoDrainOnConnect: false,
      onSequenceGap: onGap,
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3))
    expect(seen).toEqual([1])

    // Advance past GAP_FILL_WINDOW_MS (2000ms).
    await vi.advanceTimersByTimeAsync(2_100)
    // Let the getMessages microtask settle.
    await vi.runAllTimersAsync()

    expect(getMessages).toHaveBeenCalledOnce()
    expect(seen).toEqual([1, 2, 3])
    expect(onGap).toHaveBeenCalledOnce()
    expect(onGap.mock.calls[0][0]).toMatchObject({
      conversationId: 'c',
      recovered: true,
      reason: 'gap_filled',
    })

    rt.disconnect()
  })

  it('surfaces onSequenceGap with recovered:false when no client is available', async () => {
    vi.useFakeTimers()
    const onGap = vi.fn()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      onSequenceGap: onGap,
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3)) // gap at 2

    await vi.advanceTimersByTimeAsync(2_100)
    await vi.runAllTimersAsync()

    expect(seen).toEqual([1, 3]) // skipped past, no recovery possible
    expect(onGap).toHaveBeenCalledOnce()
    expect(onGap.mock.calls[0][0]).toMatchObject({
      recovered: false,
      reason: 'gap_fill_unavailable',
    })

    rt.disconnect()
  })
})

describe('RealtimeClient — reconnect', () => {
  it('schedules a reconnect with jittered backoff after onclose', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 1_000,
      maxReconnectInterval: 10_000,
    })

    await rt.connect()
    MockWebSocket.latest().simulateClose(1006, 'abnormal', false)

    // Only one instance so far; after the reconnect fires a second one
    // should appear. Jitter is ±25% of 1000ms → upper bound ~1250ms.
    expect(MockWebSocket.instances).toHaveLength(1)
    // `connect()` on the scheduled tick is async; the async advance drains
    // the microtasks between timers.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)

    rt.disconnect()
  })

  it('does not reconnect after disconnect()', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 100,
    })
    await rt.connect()
    const first = MockWebSocket.latest()
    rt.disconnect()

    // disconnect() closes the socket directly; any later simulateClose
    // would be a no-op, but schedule a tick and make sure no second
    // instance appears.
    first.simulateClose(1000, 'bye', true)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('fires onDisconnect handlers on every close', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onDisconnect = vi.fn()
    rt.onDisconnect(onDisconnect)

    await rt.connect()
    MockWebSocket.latest().simulateClose(1011, 'server error', false)

    expect(onDisconnect).toHaveBeenCalledWith({
      code: 1011,
      reason: 'server error',
      wasClean: false,
      initiator: 'server',
    })

    rt.disconnect()
  })
})

describe('RealtimeClient — offline drain on reconnect', () => {
  // Server default page size for /v1/messages/sync — a page shorter than
  // this tells the drain it has caught up.
  const PAGE = 200

  function mockClient(overrides: {
    sync: ReturnType<typeof vi.fn>
    syncAck?: ReturnType<typeof vi.fn>
  }) {
    return {
      sync: overrides.sync,
      syncAck: overrides.syncAck ?? vi.fn(async () => ({ acked: 0 })),
      getMessages: vi.fn(async () => []),
    } as unknown as import('../src/client.js').AgentChatClient
  }

  it('drains the bare-array wire and acks the positional string cursor on hello.ok', async () => {
    const rows = [syncRow('c', 1), syncRow('c', 2)]
    const sync = vi.fn(async () => rows)
    const syncAck = vi.fn(async () => ({ acked: 2 }))

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient({ sync, syncAck }),
      // autoDrainOnConnect defaults to true when client is set
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    await settle()

    // A short page means caught up — exactly one read, no empty-page probe.
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0][0]).toMatchObject({ limit: PAGE })
    // Ack cursor is the batch's last delivery_id (opaque string, positional).
    expect(syncAck).toHaveBeenCalledTimes(1)
    expect(syncAck).toHaveBeenCalledWith(rows[1].delivery_id)
    expect(onMessage).toHaveBeenCalledTimes(2)
    // Rows flow through the ordered pipeline as message.new envelopes.
    expect((onMessage.mock.calls[0][0] as WsMessage).payload).toMatchObject({
      id: 'msg_c_1',
      seq: 1,
    })

    rt.disconnect()
  })

  it('paginates with the after cursor and acks each page (last non-null delivery_id)', async () => {
    const page1 = Array.from({ length: PAGE }, (_, i) => syncRow('c', i + 1))
    const page2 = [
      syncRow('c', PAGE + 1),
      // Trailing null cursor — the positional ack must fall back to the
      // last NON-null delivery_id, never index math or numeric compares.
      syncRow('c', PAGE + 2, { delivery_id: null }),
    ]
    let call = 0
    const sync = vi.fn(async () => {
      call++
      return call === 1 ? page1 : page2
    })
    const syncAck = vi.fn(async () => ({ acked: 1 }))

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient({ sync, syncAck }),
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    await settle(20)

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls[0][0]).toMatchObject({ limit: PAGE })
    expect(sync.mock.calls[0][0].after).toBeUndefined()
    // Page 2 is fetched with the read cursor of page 1's last row.
    expect(sync.mock.calls[1][0]).toMatchObject({
      after: page1[PAGE - 1].delivery_id,
      limit: PAGE,
    })
    // One ack per page, both positional string cursors.
    expect(syncAck).toHaveBeenNthCalledWith(1, page1[PAGE - 1].delivery_id)
    expect(syncAck).toHaveBeenNthCalledWith(2, page2[0].delivery_id)
    // Every row dispatched, in seq order, exactly once.
    expect(seen).toEqual(Array.from({ length: PAGE + 2 }, (_, i) => i + 1))

    rt.disconnect()
  })

  it('stops at the first invalid row: processes the clean prefix, never acks past it', async () => {
    const good1 = syncRow('c', 1)
    const good2 = syncRow('c', 2)
    // Numeric delivery_id — the pre-1.0.21 phantom shape; fails validation.
    const bad = syncRow('c', 3, { delivery_id: 42 })
    const tail = syncRow('c', 4)
    const sync = vi.fn(async () => [good1, good2, bad, tail])
    const syncAck = vi.fn(async () => ({ acked: 2 }))

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient({ sync, syncAck }),
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    await settle()

    // Clean prefix only — the row after the bad one is never dispatched.
    expect(onMessage).toHaveBeenCalledTimes(2)
    // The ack cursor stops at the prefix; acking past the unparsed row
    // would mark a message delivered that was never surfaced.
    expect(syncAck).toHaveBeenCalledTimes(1)
    expect(syncAck).toHaveBeenCalledWith(good2.delivery_id)
    // The drain stops rather than paging over the bad row.
    expect(sync).toHaveBeenCalledTimes(1)
    expect(errors.some((e) => /failed validation/.test(e.message))).toBe(true)

    rt.disconnect()
  })

  it('does not ack a drain row whose handler threw (nor anything after it)', async () => {
    const rows = [syncRow('c', 1), syncRow('c', 2), syncRow('c', 3)]
    const sync = vi.fn(async () => rows)
    const syncAck = vi.fn(async () => ({ acked: 0 }))

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient({ sync, syncAck }),
    })
    rt.on('message.new', (evt) => {
      if ((evt.payload as { seq: number }).seq === 2) {
        throw new Error('handler exploded on seq 2')
      }
    })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    await settle()

    // Row 1 settled cleanly → acked. Row 2 failed → cursor frozen before
    // it; rows 2 and 3 stay 'stored' server-side for redelivery.
    expect(syncAck).toHaveBeenCalledTimes(1)
    expect(syncAck).toHaveBeenCalledWith(rows[0].delivery_id)
    expect(errors.some((e) => /handler exploded on seq 2/.test(e.message))).toBe(true)

    rt.disconnect()
  })

  it('never acks a row parked in the ordering buffer (gap-timer stranding fix)', async () => {
    // seq 2 is genuinely absent from the page (e.g. delivered on a prior
    // connection), so seq 3 parks in the out-of-order buffer behind a 2s
    // gap timer. The ack cursor must stop at seq 1: covering seq 3 while
    // it sits in the buffer would lose it forever if the socket dropped
    // before the gap resolved (resetOrderStates clears the buffer, and an
    // acked envelope is never re-offered).
    const rows = [syncRow('c', 1), syncRow('c', 3)]
    const sync = vi.fn(async () => rows)
    const syncAck = vi.fn(async () => ({ acked: 1 }))

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient({ sync, syncAck }),
    })
    const seen: number[] = []
    rt.on('message.new', (evt) => {
      seen.push((evt.payload as { seq: number }).seq)
    })

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    await settle()

    // Row 1 dispatched; row 3 still buffered awaiting the gap window.
    expect(seen).toEqual([1])
    expect(syncAck).toHaveBeenCalledTimes(1)
    expect(syncAck).toHaveBeenCalledWith(rows[0].delivery_id)

    // Teardown cancels the pending gap timer and flushes the buffer.
    rt.disconnect()
    expect(seen).toEqual([1, 3])
  })

  // A group where the agent's own message is seq 2: the drain page is [1, 3]
  // (a sender has no envelope for its own message), so 3 parks behind the
  // gap. The handler for 1 is slow (it calls a model) and the socket drops
  // while it runs. The close clears the ordering buffer; the drain is still
  // awaiting row 1's settlement and must not then cover row 3, which no
  // handler ever saw.
  it.each([
    // Default: the close drops parked row 3 unacked; it comes back later.
    { ackOnReceipt: false, seen: [1], coveredRows: 1 },
    // Ack-on-receipt: the close hands parked frames to the handlers first.
    { ackOnReceipt: true, seen: [1, 3], coveredRows: 2 },
  ])(
    'never acks a parked row the socket close cleared while an earlier handler ran (ackOnReceipt=$ackOnReceipt)',
    async ({ ackOnReceipt, seen: expectedSeen, coveredRows }) => {
      const rows = [syncRow('g', 1), syncRow('g', 3)]
      const sync = vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([])
      const syncAck = vi.fn(async () => ({ acked: 1 }))

      const rt = new RealtimeClient({
        apiKey: 'k',
        webSocket: MockWebSocketCtor,
        reconnect: false,
        ackOnReceipt,
        client: mockClient({ sync, syncAck }),
      })
      const seen: number[] = []
      const finished: number[] = []
      let release!: () => void
      rt.on('message.new', async (evt) => {
        const seq = (evt.payload as { seq: number }).seq
        seen.push(seq)
        if (seq === 1) await new Promise<void>((r) => (release = r))
        finished.push(seq)
      })

      await rt.connect()
      const ws = MockWebSocket.latest()
      ws.simulateOpen()
      ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
      await settle()
      // Row 1's handler is running; row 3 is parked on the gap.
      expect(seen).toEqual([1])
      expect(syncAck).not.toHaveBeenCalled()

      ws.simulateClose(1006, 'abnormal', false)
      await settle()
      release()
      await settle()

      expect(seen).toEqual(expectedSeen)
      expect(syncAck).toHaveBeenCalledTimes(1)
      expect(syncAck).toHaveBeenCalledWith(rows[coveredRows - 1]!.delivery_id)
      // Whatever the cursor covers, a handler finished.
      for (const row of rows.slice(0, coveredRows)) expect(finished).toContain(row.seq)
      rt.disconnect()
    },
  )

  it('dedups a row redelivered on the next drain but still acks it', async () => {
    const row = syncRow('c', 1)
    // The server re-offers the same envelope on every drain until acked —
    // simulate an ack lost in transit by re-serving the row on drain #2.
    const sync = vi.fn(async () => [row])
    const syncAck = vi.fn(async () => ({ acked: 1 }))

    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      client: mockClient({ sync, syncAck }),
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws1 = MockWebSocket.latest()
    ws1.simulateOpen()
    ws1.simulateMessage({ type: 'hello.ok' })
    await settle()

    // Drop and manually reconnect — ordering state resets, dedup does not.
    ws1.simulateClose(1006, 'net blip', false)
    await rt.connect()
    const ws2 = MockWebSocket.latest()
    ws2.simulateOpen()
    ws2.simulateMessage({ type: 'hello.ok' })
    await settle()

    expect(sync).toHaveBeenCalledTimes(2)
    // Handlers saw the message exactly once; the duplicate was suppressed.
    expect(onMessage).toHaveBeenCalledTimes(1)
    // But BOTH drains acked it — prior processing is the proof.
    expect(syncAck).toHaveBeenCalledTimes(2)
    expect(syncAck).toHaveBeenLastCalledWith(row.delivery_id)

    rt.disconnect()
  })

  it('skips auto-drain when client is omitted', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })

    // Nothing to assert beyond "doesn't throw" — the goal here is to
    // pin the "no client → no drain" path against a future refactor.
    await new Promise((r) => setTimeout(r, 0))
    rt.disconnect()
  })
})

describe('RealtimeClient — WS delivery acks (capability-negotiated)', () => {
  async function connectWith(helloOk: Record<string, unknown>) {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage(helloOk)
    return { rt, ws }
  }

  it('acks a live message.new after handlers complete when hello.ok echoes ack', async () => {
    const { rt, ws } = await connectWith({ type: 'hello.ok', capabilities: ['ack'] })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(sentFrames(ws, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])

    rt.disconnect()
  })

  it('awaits async handlers before acking', async () => {
    const { rt, ws } = await connectWith({ type: 'hello.ok', capabilities: ['ack'] })
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    rt.on('message.new', () => gate)

    ws.simulateMessage(messageNew('c', 1))
    await settle()
    // Handler still running — the ack must not have been sent yet.
    expect(sentFrames(ws, 'ack')).toHaveLength(0)

    finish()
    await settle()
    expect(sentFrames(ws, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])

    rt.disconnect()
  })

  it('does not ack when a handler throws synchronously', async () => {
    const { rt, ws } = await connectWith({ type: 'hello.ok', capabilities: ['ack'] })
    rt.on('message.new', () => {
      throw new Error('sync boom')
    })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    expect(sentFrames(ws, 'ack')).toHaveLength(0)
    expect(errors.some((e) => /sync boom/.test(e.message))).toBe(true)

    rt.disconnect()
  })

  it('does not ack when an async handler rejects', async () => {
    const { rt, ws } = await connectWith({ type: 'hello.ok', capabilities: ['ack'] })
    rt.on('message.new', async () => {
      throw new Error('async boom')
    })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    expect(sentFrames(ws, 'ack')).toHaveLength(0)
    expect(errors.some((e) => /async boom/.test(e.message))).toBe(true)

    rt.disconnect()
  })

  it('stays in legacy mode when hello.ok omits capabilities', async () => {
    const { rt, ws } = await connectWith({ type: 'hello.ok' })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    // Legacy server marks delivered-on-send; a client ack frame would just
    // be an unknown frame to it. Dispatch works, no ack goes out.
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(sentFrames(ws, 'ack')).toHaveLength(0)

    rt.disconnect()
  })

  it('stays in legacy mode when hello.ok echoes other capabilities only', async () => {
    const { rt, ws } = await connectWith({ type: 'hello.ok', capabilities: ['compression'] })
    rt.on('message.new', vi.fn())

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    expect(sentFrames(ws, 'ack')).toHaveLength(0)

    rt.disconnect()
  })

  it('dedups a redelivered live frame across reconnect and still acks it', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
    })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    await rt.connect()
    const ws1 = MockWebSocket.latest()
    ws1.simulateOpen()
    ws1.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws1.simulateMessage(messageNew('c', 1))
    await settle()
    expect(sentFrames(ws1, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])

    // The ack is lost in transit; the server re-pushes the frame on the
    // next connection's backlog drain. Ordering state resets across the
    // reconnect (so the frame re-anchors), the dedup cache does not.
    ws1.simulateClose(1006, 'net blip', false)
    await rt.connect()
    const ws2 = MockWebSocket.latest()
    ws2.simulateOpen()
    ws2.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws2.simulateMessage(messageNew('c', 1))
    await settle()

    // No double dispatch — but the duplicate is re-acked so the server
    // can finally mark it delivered.
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(sentFrames(ws2, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])

    rt.disconnect()
  })
})

// ─── Never a dead end ──────────────────────────────────────────────────────
//
// A messaging client must never park itself with no way out, and a close the
// client itself initiated is never evidence about the server. The server
// closes a rejected HELLO with 1008 'Invalid token', but also uses 1008 for a
// handshake that was merely slow ('HELLO frame required', its own 5 s timer)
// and for evictions after hello.ok (key rotated, account suspended). Only
// disconnect() ends the client.

type ClientOptions = ConstructorParameters<typeof RealtimeClient>[0]

function makeClient(overrides: Partial<ClientOptions> = {}): RealtimeClient {
  return new RealtimeClient({
    apiKey: 'k',
    webSocket: MockWebSocketCtor,
    reconnect: true,
    reconnectInterval: 10,
    ...overrides,
  })
}

interface Probe {
  states: string[]
  blocked: Array<{ code: number; reason: string; retryInMs: number | null }>
  disconnects: Array<{ code: number; reason: string; wasClean: boolean; initiator: string }>
  errors: Error[]
  stopped: number
}

function probe(rt: RealtimeClient): Probe {
  const p: Probe = { states: [], blocked: [], disconnects: [], errors: [], stopped: 0 }
  rt.on('state', (state) => p.states.push(state))
  rt.on('blocked', (info) => p.blocked.push(info))
  rt.on('stopped', () => {
    p.stopped++
  })
  rt.onDisconnect((info) => p.disconnects.push(info))
  rt.onError((err) => p.errors.push(err))
  return p
}

function count(errors: Error[], re: RegExp): number {
  return errors.filter((e) => re.test(e.message)).length
}

describe('RealtimeClient — close classification (never a dead end)', () => {
  it('handshake deadline: no hello.ok in 15 s → client close, backoff, reconnect — never blocked', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const p = probe(rt)

    await rt.connect()
    const first = MockWebSocket.latest()
    first.simulateOpen() // HELLO sent; the server never answers
    expect(rt.state).toBe('connecting')

    await vi.advanceTimersByTimeAsync(14_999)
    expect(first.closed).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    // Our own close: a browser-shaped socket gets close(4000, …), and the
    // state machine moves on at once instead of waiting for a close event
    // a dead pipe would deliver late or never.
    expect(first.closed).toEqual({ code: 4000, reason: 'client handshake timeout' })
    expect(p.disconnects).toEqual([
      { code: 4000, reason: 'client handshake timeout', wasClean: false, initiator: 'client' },
    ])
    expect(count(p.errors, /handshake timeout/)).toBe(1)
    expect(rt.state).toBe('backoff')
    expect(p.blocked).toEqual([])

    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(p.states).toEqual(['connecting', 'backoff', 'connecting'])

    // The abandoned socket's own late close is ignored: no second
    // disconnect, no second reconnect.
    first.simulateClose(1006, 'late', false)
    expect(p.disconnects).toHaveLength(1)
    expect(MockWebSocket.instances).toHaveLength(2)

    handshake(MockWebSocket.latest())
    expect(rt.state).toBe('ready')
    rt.disconnect()
  })

  it('handshake deadline also bounds a socket that never opens (half-open upgrade)', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const p = probe(rt)
    await rt.connect()
    const first = MockWebSocket.latest()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(first.closed).toEqual({ code: 4000, reason: 'client handshake timeout' })
    expect(rt.state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(p.blocked).toEqual([])
    rt.disconnect()
  })

  it.each(['HELLO frame required', 'HELLO frame required first', ''])(
    '1008 %j during the handshake is transient → backoff, then hello.ok',
    async (reason) => {
      vi.useFakeTimers()
      const rt = makeClient()
      const p = probe(rt)
      await rt.connect()
      const first = MockWebSocket.latest()
      first.simulateOpen()
      first.simulateClose(1008, reason, false)

      expect(rt.state).toBe('backoff')
      expect(p.blocked).toEqual([])
      expect(count(p.errors, /rejected the credential/)).toBe(0)
      await vi.advanceTimersByTimeAsync(100)
      expect(MockWebSocket.instances).toHaveLength(2)
      handshake(MockWebSocket.latest())
      expect(rt.state).toBe('ready')
      rt.disconnect()
    },
  )

  it.each([
    [1008, 'Invalid token'],
    [1008, 'invalid token'],
    [4401, 'Unauthorized'],
    [4403, 'Forbidden'],
  ])(
    '%i %j during the handshake → blocked, fresh HELLO in 10–15 min, hello.ok clears it',
    async (code, reason) => {
      vi.useFakeTimers()
      const rt = makeClient()
      const p = probe(rt)
      await rt.connect()
      const first = MockWebSocket.latest()
      first.simulateOpen()
      first.simulateClose(code, reason, false)

      expect(rt.state).toBe('blocked')
      expect(p.blocked).toHaveLength(1)
      expect(p.blocked[0]).toMatchObject({ code, reason })
      const retryInMs = p.blocked[0]!.retryInMs!
      expect(retryInMs).toBeGreaterThanOrEqual(600_000)
      expect(retryInMs).toBeLessThanOrEqual(900_000)
      expect(count(p.errors, /rejected the credential/)).toBe(1)
      expect(p.disconnects[0]).toMatchObject({ code, reason, initiator: 'server' })

      // Nothing before the promised retry…
      await vi.advanceTimersByTimeAsync(retryInMs - 1)
      expect(MockWebSocket.instances).toHaveLength(1)
      // …a fresh socket exactly then. (Left unanswered, it would hit the
      // handshake deadline and cycle through the normal backoff — which is
      // the point of the deadline, so the test answers it promptly.)
      await vi.advanceTimersByTimeAsync(1)
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(rt.state).toBe('connecting')

      // Rejected again: blocked again, the event fires again, the error does not.
      const second = MockWebSocket.latest()
      second.simulateOpen()
      second.simulateClose(code, reason, false)
      expect(rt.state).toBe('blocked')
      expect(p.blocked).toHaveLength(2)
      expect(count(p.errors, /rejected the credential/)).toBe(1)

      // Key rotated back / account reinstated: the next HELLO is accepted.
      const secondRetryInMs = p.blocked[1]!.retryInMs!
      expect(secondRetryInMs).toBeGreaterThanOrEqual(600_000)
      expect(secondRetryInMs).toBeLessThanOrEqual(900_000)
      await vi.advanceTimersByTimeAsync(secondRetryInMs)
      expect(MockWebSocket.instances).toHaveLength(3)
      handshake(MockWebSocket.latest())
      expect(rt.state).toBe('ready')
      expect(rt.isConnected).toBe(true)
      expect(p.states).toEqual([
        'connecting',
        'blocked',
        'connecting',
        'blocked',
        'connecting',
        'ready',
      ])

      // A later rejection is a new incident: one error again.
      MockWebSocket.latest().simulateClose(1008, 'API key rotated', false) // eviction → backoff
      await vi.advanceTimersByTimeAsync(100)
      const fourth = MockWebSocket.latest()
      fourth.simulateOpen()
      fourth.simulateClose(code, reason, false)
      expect(rt.state).toBe('blocked')
      expect(count(p.errors, /rejected the credential/)).toBe(2)

      rt.disconnect()
    },
  )

  it.each([
    [1008, 'API key rotated'],
    [1008, 'Account suspended'],
    [4401, 'Unauthorized'],
  ])(
    '%i %j after hello.ok is an eviction → normal backoff; the next HELLO decides',
    async (code, reason) => {
      vi.useFakeTimers()
      const rt = makeClient()
      const p = probe(rt)
      await rt.connect()
      handshake(MockWebSocket.latest())
      MockWebSocket.latest().simulateClose(code, reason, false)

      expect(rt.state).toBe('backoff')
      expect(p.blocked).toEqual([])
      await vi.advanceTimersByTimeAsync(100)
      expect(MockWebSocket.instances).toHaveLength(2)

      // The fresh HELLO is the evidence: rejected → blocked now.
      const second = MockWebSocket.latest()
      second.simulateOpen()
      second.simulateClose(1008, 'Invalid token', false)
      expect(rt.state).toBe('blocked')
      expect(p.blocked).toHaveLength(1)
      rt.disconnect()
    },
  )

  it('isAuthRejectionClose: 4401/4403 always; 1008 only with the server auth reason', () => {
    expect(isAuthRejectionClose(4401, '')).toBe(true)
    expect(isAuthRejectionClose(4403, 'Forbidden')).toBe(true)
    expect(isAuthRejectionClose(1008, 'Invalid token')).toBe(true)
    expect(isAuthRejectionClose(1008, 'INVALID TOKEN')).toBe(true)
    expect(isAuthRejectionClose(1008, 'HELLO frame required')).toBe(false)
    expect(isAuthRejectionClose(1008, 'HELLO frame required first')).toBe(false)
    expect(isAuthRejectionClose(1008, '')).toBe(false)
    expect(isAuthRejectionClose(1008, 'API key rotated')).toBe(false)
    expect(isAuthRejectionClose(1006, 'Invalid token')).toBe(false)
    expect(isAuthRejectionClose(1000, '')).toBe(false)
  })

  it('reconnect: false → a rejected handshake reports blocked and waits for connect()', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ reconnect: false })
    const p = probe(rt)
    await rt.connect()
    const first = MockWebSocket.latest()
    first.simulateOpen()
    first.simulateClose(1008, 'Invalid token', false)

    expect(rt.state).toBe('blocked')
    expect(p.blocked).toEqual([{ code: 1008, reason: 'Invalid token', retryInMs: null }])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(MockWebSocket.instances).toHaveLength(1)

    await rt.connect() // the application's call is the retry
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(rt.state).toBe('connecting')
    rt.disconnect()
  })
})

describe('RealtimeClient — no reconnect cap', () => {
  it('61+ consecutive failures: still reconnecting at the 5-minute cap, exactly one error', async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0) // no jitter: delays sit exactly on the step
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnectInterval: 500,
      maxReconnectInterval: 30_000,
      maxReconnectAttempts: 3, // deprecated: ignored
    })
    const p = probe(rt)

    await rt.connect()
    // First tier: the delay doubles from 500 ms and caps at 30 s.
    for (let i = 1; i <= 60; i++) {
      MockWebSocket.latest().simulateClose(1006, 'refused', false)
      expect(rt.state).toBe('backoff')
      const delay = Math.min(500 * 2 ** (i - 1), 30_000)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(MockWebSocket.instances).toHaveLength(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(MockWebSocket.instances).toHaveLength(i + 1)
    }
    expect(count(p.errors, /still reconnecting/)).toBe(0)

    // Failure 61 opens the long-outage tier: one error, cap widens to 5 min.
    MockWebSocket.latest().simulateClose(1006, 'refused', false)
    expect(rt.state).toBe('backoff')
    expect(count(p.errors, /still reconnecting after 60/)).toBe(1)
    await vi.advanceTimersByTimeAsync(300_000 - 1)
    expect(MockWebSocket.instances).toHaveLength(61)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances).toHaveLength(62)

    // And on, forever, with no second error.
    for (let i = 0; i < 10; i++) {
      MockWebSocket.latest().simulateClose(1006, 'refused', false)
      await vi.advanceTimersByTimeAsync(300_000)
    }
    expect(MockWebSocket.instances).toHaveLength(72)
    expect(count(p.errors, /still reconnecting/)).toBe(1)
    expect(rt.state).toBe('connecting')
    expect(p.blocked).toEqual([])

    // A connection that proves itself stable resets the ramp.
    handshake(MockWebSocket.latest())
    await vi.advanceTimersByTimeAsync(30_000)
    MockWebSocket.latest().simulateClose(1006, 'blip', false)
    await vi.advanceTimersByTimeAsync(500)
    expect(MockWebSocket.instances).toHaveLength(73)

    random.mockRestore()
    rt.disconnect()
  })
})

describe('RealtimeClient — liveness watchdog', () => {
  it('Node ws: trips after 100 s without frames or pings, as a client close, and reconnects', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ webSocket: MockNodeWebSocketCtor })
    const p = probe(rt)
    await rt.connect()
    const ws = handshake(MockWebSocket.latest()) as MockNodeWebSocket
    expect(rt.ackNegotiated).toBe(true)

    await vi.advanceTimersByTimeAsync(99_999)
    expect(ws.terminated).toBe(false)
    expect(rt.isConnected).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    // terminate(), not a closing handshake the dead pipe would never answer.
    expect(ws.terminated).toBe(true)
    expect(ws.closed).toBeNull()
    expect(p.disconnects).toEqual([
      { code: 4000, reason: 'client liveness timeout', wasClean: false, initiator: 'client' },
    ])
    expect(count(p.errors, /liveness timeout/)).toBe(1)
    expect(rt.state).toBe('backoff')
    expect(rt.ackNegotiated).toBe(false)
    expect(p.blocked).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    rt.disconnect()
  })

  it('Node ws: the server pings (every 45 s) keep an idle socket alive', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ webSocket: MockNodeWebSocketCtor })
    const p = probe(rt)
    await rt.connect()
    const ws = handshake(MockWebSocket.latest()) as MockNodeWebSocket
    for (let t = 0; t < 30 * 60_000; t += 45_000) {
      await vi.advanceTimersByTimeAsync(45_000)
      ws.simulatePing()
    }
    expect(ws.terminated).toBe(false)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(rt.state).toBe('ready')
    expect(p.disconnects).toEqual([])

    // One missed ping must not kill a healthy socket; the second does.
    await vi.advanceTimersByTimeAsync(90_000)
    expect(ws.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ws.terminated).toBe(true)
    rt.disconnect()
  })

  it('Node ws: inbound frames count as liveness too', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ webSocket: MockNodeWebSocketCtor })
    await rt.connect()
    const ws = handshake(MockWebSocket.latest()) as MockNodeWebSocket
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(90_000)
      ws.simulateMessage({ type: 'presence', payload: { handle: 'x', status: 'online' } })
    }
    expect(ws.terminated).toBe(false)
    expect(rt.state).toBe('ready')
    rt.disconnect()
  })

  it('browser-shaped socket: the idle deadline is off by default (it cannot see pings)', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const p = probe(rt)
    await rt.connect()
    const ws = handshake(MockWebSocket.latest())
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(ws.closed).toBeNull()
    expect(rt.state).toBe('ready')
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(p.disconnects).toEqual([])
    rt.disconnect()
  })

  it('browser-shaped socket: livenessTimeoutMs opts in, and inbound frames re-arm it', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ livenessTimeoutMs: 100_000 })
    const p = probe(rt)
    await rt.connect()
    const ws = handshake(MockWebSocket.latest())
    await vi.advanceTimersByTimeAsync(60_000)
    ws.simulateMessage({ type: 'presence', payload: {} })
    await vi.advanceTimersByTimeAsync(60_000) // 120 s since hello.ok, 60 s since the frame
    expect(ws.closed).toBeNull()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(ws.closed).toEqual({ code: 4000, reason: 'client liveness timeout' })
    expect(p.disconnects[0]).toMatchObject({ initiator: 'client' })
    expect(rt.state).toBe('backoff')
    rt.disconnect()
  })

  it('livenessTimeoutMs: 0 disables the idle deadline on a Node ws socket', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ webSocket: MockNodeWebSocketCtor, livenessTimeoutMs: 0 })
    await rt.connect()
    const ws = handshake(MockWebSocket.latest()) as MockNodeWebSocket
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(ws.terminated).toBe(false)
    expect(rt.state).toBe('ready')
    rt.disconnect()
  })

  it('the handshake deadline is configurable', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ handshakeTimeoutMs: 2_000 })
    await rt.connect()
    const ws = MockWebSocket.latest()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(ws.closed).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(ws.closed).toEqual({ code: 4000, reason: 'client handshake timeout' })
    rt.disconnect()
  })
})

describe('RealtimeClient — disconnect() is the only end', () => {
  it('from blocked → stopped, no timers, no socket afterwards', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const p = probe(rt)
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateClose(1008, 'Invalid token', false)
    expect(rt.state).toBe('blocked')
    expect(vi.getTimerCount()).toBe(1) // the slow retry

    rt.disconnect()
    expect(rt.state).toBe('stopped')
    expect(p.stopped).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(p.states.at(-1)).toBe('stopped')
    await expect(rt.connect()).rejects.toThrow(/disposed/)
  })

  it('from a pending backoff → stopped, no socket afterwards', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ reconnectInterval: 1_000 })
    const p = probe(rt)
    await rt.connect()
    MockWebSocket.latest().simulateClose(1006, 'blip', false)
    expect(rt.state).toBe('backoff')

    rt.disconnect()
    expect(rt.state).toBe('stopped')
    expect(p.stopped).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('from ready → closes the socket cleanly and fires stopped once', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ webSocket: MockNodeWebSocketCtor })
    const p = probe(rt)
    await rt.connect()
    const ws = handshake(MockWebSocket.latest()) as MockNodeWebSocket
    rt.disconnect()
    rt.disconnect() // idempotent
    expect(ws.closed).toEqual({ code: 1000, reason: 'client disconnect' })
    expect(ws.terminated).toBe(false)
    expect(p.stopped).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    // The socket's own close event arriving afterwards changes nothing.
    ws.simulateClose(1000, 'client disconnect', true)
    expect(rt.state).toBe('stopped')
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

describe('RealtimeClient — connect() semantics', () => {
  it('while in backoff, connect() retries at once and cancels the pending timer', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ reconnectInterval: 10_000 })
    await rt.connect()
    MockWebSocket.latest().simulateClose(1006, 'blip', false)
    expect(rt.state).toBe('backoff')

    await rt.connect()
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(rt.state).toBe('connecting')
    // No second socket from the old timer, and no duplicate from a second call.
    await rt.connect()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    rt.disconnect()
  })

  it('while blocked, connect() is the "retry now" hook (a key rotated in place)', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const p = probe(rt)
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateClose(1008, 'Invalid token', false)
    expect(rt.state).toBe('blocked')

    await rt.connect()
    expect(MockWebSocket.instances).toHaveLength(2)
    handshake(MockWebSocket.latest())
    expect(rt.state).toBe('ready')
    await vi.advanceTimersByTimeAsync(20 * 60_000) // the old slow-retry timer is gone
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(p.blocked).toHaveLength(1)
    rt.disconnect()
  })

  it('a WebSocket constructor that throws is a failed attempt, not the end', async () => {
    vi.useFakeTimers()
    let calls = 0
    class Flaky extends MockWebSocket {
      constructor(url: string) {
        calls++
        if (calls === 1) throw new Error('ENOTFOUND')
        super(url)
      }
    }
    const rt = makeClient({ webSocket: Flaky as unknown as typeof globalThis.WebSocket })
    const p = probe(rt)
    await expect(rt.connect()).rejects.toThrow(/ENOTFOUND/)
    expect(rt.state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(2)
    expect(rt.state).toBe('connecting')
    expect(count(p.errors, /ENOTFOUND/)).toBe(1)
    rt.disconnect()
  })
})

describe('RealtimeClient — state and capabilities', () => {
  it('walks idle → connecting → ready → backoff → connecting → ready, with the previous state', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const transitions: string[] = []
    rt.on('state', (state, previous) => transitions.push(`${previous}>${state}`))
    expect(rt.state).toBe('idle')
    await rt.connect()
    handshake(MockWebSocket.latest())
    MockWebSocket.latest().simulateClose(1006, 'blip', false)
    await vi.advanceTimersByTimeAsync(100)
    handshake(MockWebSocket.latest())
    expect(transitions).toEqual([
      'idle>connecting',
      'connecting>ready',
      'ready>backoff',
      'backoff>connecting',
      'connecting>ready',
    ])
    rt.disconnect()
    expect(transitions.at(-1)).toBe('ready>stopped')
  })

  it('ackNegotiated mirrors the hello.ok capabilities and resets on close', async () => {
    const rt = makeClient({ reconnect: false })
    expect(rt.ackNegotiated).toBe(false)
    await rt.connect()
    handshake(MockWebSocket.latest(), ['ack'])
    expect(rt.ackNegotiated).toBe(true)
    MockWebSocket.latest().simulateClose(1006, 'blip', false)
    expect(rt.ackNegotiated).toBe(false)
    expect(rt.state).toBe('idle')

    await rt.connect()
    handshake(MockWebSocket.latest(), [])
    expect(rt.ackNegotiated).toBe(false)
    expect(rt.isConnected).toBe(true)
    rt.disconnect()
  })

  it("a server frame typed 'state' / 'blocked' / 'stopped' never reaches the lifecycle handlers", async () => {
    const rt = makeClient({ reconnect: false })
    const p = probe(rt)
    await rt.connect()
    const ws = handshake(MockWebSocket.latest())
    const before = [...p.states]
    ws.simulateMessage({ type: 'state', payload: {} })
    ws.simulateMessage({ type: 'blocked', payload: { reason: 'spoof' } })
    ws.simulateMessage({ type: 'stopped', payload: {} })
    expect(p.states).toEqual(before)
    expect(p.blocked).toEqual([])
    expect(p.stopped).toBe(0)
    rt.disconnect()
  })

  it('the instability notice goes through onError, never the console', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rt = makeClient()
    const p = probe(rt)
    await rt.connect()
    for (let i = 0; i < 5; i++) {
      handshake(MockWebSocket.latest())
      await vi.advanceTimersByTimeAsync(5_000)
      MockWebSocket.latest().simulateClose(1006, 'flap', false)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(count(p.errors, /connection is unstable/)).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    rt.disconnect()
  })
})

describe('RealtimeClient — review hardening', () => {
  // An observer that throws. Every notice is emitted right before the step
  // that keeps the client alive (arming a timer, opening the next socket);
  // the emitter isolates the throw so that step still runs.
  const boom = (): void => {
    throw new Error('observer exploded')
  }

  it('a throwing onError never parks the client: handshake deadline', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    rt.onError(boom)
    const p = probe(rt) // registered after boom: proves the loop went on
    await rt.connect()
    MockWebSocket.latest().simulateOpen()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(rt.state).toBe('backoff')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(count(p.errors, /handshake timeout/)).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    rt.disconnect()
  })

  it('a throwing onError never parks the client: liveness deadline', async () => {
    vi.useFakeTimers()
    const rt = makeClient({ webSocket: MockNodeWebSocketCtor })
    rt.onError(boom)
    await rt.connect()
    handshake(MockWebSocket.latest())
    await vi.advanceTimersByTimeAsync(100_000)
    expect(rt.state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    rt.disconnect()
  })

  it('a throwing onError never parks the client: long-outage notice', async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0) // delays sit exactly on the step
    const rt = makeClient({ reconnectInterval: 1, maxReconnectInterval: 1 })
    rt.onError(boom)
    await rt.connect()
    for (let i = 1; i <= 61; i++) {
      MockWebSocket.latest().simulateClose(1006, 'refused', false)
      expect(rt.state).toBe('backoff')
      await vi.advanceTimersByTimeAsync(i > 60 ? 300_000 : 1)
      expect(MockWebSocket.instances).toHaveLength(i + 1)
    }
    random.mockRestore()
    rt.disconnect()
  })

  it('a throwing onError never parks the client: blocked', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    rt.onError(boom)
    const p = probe(rt)
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateClose(1008, 'Invalid token', false)
    expect(rt.state).toBe('blocked')
    expect(p.blocked).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(p.blocked[0]!.retryInMs!)
    expect(MockWebSocket.instances).toHaveLength(2)
    rt.disconnect()
  })

  it('a throwing onError never parks the client: HELLO send failure', async () => {
    vi.useFakeTimers()
    class SendFails extends MockWebSocket {
      send(data: string) {
        if (MockWebSocket.instances.indexOf(this) === 0) throw new Error('EPIPE')
        super.send(data)
      }
    }
    const rt = makeClient({ webSocket: SendFails as unknown as typeof globalThis.WebSocket })
    rt.onError(boom)
    const p = probe(rt)
    await rt.connect()
    const first = MockWebSocket.latest()
    first.simulateOpen()
    expect(first.closed).toEqual({ code: 4000, reason: 'client HELLO send failed' })
    expect(rt.state).toBe('backoff')
    expect(p.disconnects[0]).toMatchObject({ initiator: 'client' })
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    handshake(MockWebSocket.latest())
    expect(rt.state).toBe('ready')
    rt.disconnect()
  })

  it('a 1008 with no reason (a polyfilled socket) is a transient close, not a crash', async () => {
    vi.useFakeTimers()
    const rt = makeClient()
    const p = probe(rt)
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    // Straight to the handler: the mock's simulateClose would default the
    // missing reason, which is exactly what a polyfilled socket does not do.
    ws.readyState = 3
    ws.onclose!({ type: 'close', code: 1008, reason: undefined, wasClean: false } as unknown as Event)
    expect(rt.state).toBe('backoff')
    expect(p.disconnects).toEqual([{ code: 1008, reason: '', wasClean: false, initiator: 'server' }])
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(isAuthRejectionClose(1008, undefined as unknown as string)).toBe(false)
    rt.disconnect()
  })

  it('reconnect jitter stays at or below the documented caps', async () => {
    vi.useFakeTimers()
    // Most jitter: 25% below the step. Attempt 1: step 1 000 → 750.
    const random = vi.spyOn(Math, 'random').mockReturnValue(1)
    const rt = makeClient({ reconnectInterval: 1_000, maxReconnectInterval: 30_000 })
    await rt.connect()
    MockWebSocket.latest().simulateClose(1006, 'x', false)
    await vi.advanceTimersByTimeAsync(749)
    expect(MockWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances).toHaveLength(2)

    // Least jitter: exactly the step — never above it, including at the cap.
    random.mockReturnValue(0)
    for (let i = 2; i <= 7; i++) {
      MockWebSocket.latest().simulateClose(1006, 'x', false)
      const step = Math.min(1_000 * 2 ** (i - 1), 30_000)
      await vi.advanceTimersByTimeAsync(step - 1)
      expect(MockWebSocket.instances).toHaveLength(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(MockWebSocket.instances).toHaveLength(i + 1)
    }
    random.mockRestore()
    rt.disconnect()
  })
})

// ─── Reconnect backoff stability window ───────────────────────────────────
//
// The bug these cover: resetting the attempt counter on `hello.ok` treats a
// successful HANDSHAKE as a healthy CONNECTION. A socket that connects then
// dies seconds later retries at the floor delay forever, because the
// exponential backoff only counts attempts that failed BEFORE the
// handshake. Seen in production as 725 reconnects in four hours from one
// agent with a completely flat interval.

describe('RealtimeClient — reconnect stability window', () => {
  function makeFlappy() {
    return new RealtimeClient({
      apiKey: 'sk_test',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 100,
      maxReconnectInterval: 10_000,
    })
  }

  it('does NOT clear the backoff on hello.ok alone', async () => {
    const rt = makeFlappy()
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()

    // Backoff already climbing from earlier failures. Seeded BEFORE the
    // handshake — the old code reset right here, so this ordering is what
    // makes the assertion a real regression guard rather than a tautology.
    ;(rt as unknown as { reconnectAttempts: number }).reconnectAttempts = 4
    ws.simulateMessage({ type: 'hello.ok' })

    expect(
      (rt as unknown as { reconnectAttempts: number }).reconnectAttempts,
    ).toBe(4)

    rt.disconnect()
  })

  it('clears the backoff only after the connection survives the window', async () => {
    vi.useFakeTimers()
    const rt = makeFlappy()
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ;(rt as unknown as { reconnectAttempts: number }).reconnectAttempts = 7
    ws.simulateMessage({ type: 'hello.ok' })

    // Just before the window elapses — still counted as unproven.
    vi.advanceTimersByTime(29_000)
    expect(
      (rt as unknown as { reconnectAttempts: number }).reconnectAttempts,
    ).toBe(7)

    vi.advanceTimersByTime(2_000)
    expect(
      (rt as unknown as { reconnectAttempts: number }).reconnectAttempts,
    ).toBe(0)

    rt.disconnect()
    vi.useRealTimers()
  })

  it('keeps the counter climbing across repeated short-lived connections', async () => {
    vi.useFakeTimers()
    const rt = makeFlappy()

    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })
    // Dies well inside the stability window.
    vi.advanceTimersByTime(5_000)
    ws.simulateClose(1006, 'abnormal')

    const after = (rt as unknown as { reconnectAttempts: number }).reconnectAttempts
    expect(after).toBeGreaterThan(0)

    rt.disconnect()
    vi.useRealTimers()
  })
})
