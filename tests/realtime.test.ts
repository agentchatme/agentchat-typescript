import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
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

  it('emits ConnectionError on HELLO ack timeout', async () => {
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

    vi.advanceTimersByTime(5_000) // > HELLO_ACK_TIMEOUT_MS (4s)
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toMatch(/HELLO ack timeout/)

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
    await vi.advanceTimersByTimeAsync(2_000)
    // `connect()` on the scheduled tick is async — drain microtasks.
    await vi.runAllTimersAsync()
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

describe('RealtimeClient — terminal close codes', () => {
  it.each([1008, 4401, 4403])(
    'stops reconnecting and emits a terminal error on close code %i',
    async (code) => {
      vi.useFakeTimers()
      const rt = new RealtimeClient({
        apiKey: 'k',
        webSocket: MockWebSocketCtor,
        reconnect: true,
        reconnectInterval: 10,
      })
      const errors: Error[] = []
      rt.onError((e) => errors.push(e))
      const onDisconnect = vi.fn()
      rt.onDisconnect(onDisconnect)

      await rt.connect()
      MockWebSocket.latest().simulateClose(code, 'auth rejected', false)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.runAllTimersAsync()

      // No second socket — the reconnect loop is off.
      expect(MockWebSocket.instances).toHaveLength(1)
      // The close itself still reaches disconnect handlers…
      expect(onDisconnect).toHaveBeenCalledWith({
        code,
        reason: 'auth rejected',
        wasClean: false,
      })
      // …and the terminal condition is surfaced through the error channel.
      expect(errors.some((e) => /terminal code/.test(e.message))).toBe(true)

      rt.disconnect()
    },
  )

  it('still reconnects after our own HELLO-ack-timeout close (self-close reuses 1008)', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 10,
    })
    rt.onError(() => { /* HELLO timeout error is expected here */ })

    await rt.connect()
    const first = MockWebSocket.latest()
    first.simulateOpen() // HELLO sent, ack timer armed — no hello.ok follows

    await vi.advanceTimersByTimeAsync(4_100) // > HELLO_ACK_TIMEOUT_MS
    expect(first.closed?.code).toBe(1008)

    // The mock's close() doesn't fire onclose on its own — deliver the
    // close completion the way a real socket would echo it.
    first.simulateClose(1008, 'HELLO ack timeout', false)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()

    // 1008 from our own hello-timeout close is transient, not terminal.
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)

    rt.disconnect()
  })

  it('keeps reconnecting on non-terminal close codes', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: true,
      reconnectInterval: 10,
    })

    await rt.connect()
    MockWebSocket.latest().simulateClose(1011, 'server error', false)

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTimersAsync()
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)

    rt.disconnect()
  })
})
