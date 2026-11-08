import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient, wakePayloadOf, type RealtimeOptions } from '../src/realtime.js'
import type { HeartbeatFrame, WakeFrame } from '../src/types/index.js'
import { MockWebSocket, MockWebSocketCtor, sentFrames, settle } from './helpers/mock-websocket.js'
import { json, raw } from './integration/fixtures.js'

// ─── Socket behaviour of contract v1: capabilities, heartbeat, wake frames,
// connect budget. Frames and cases come from conformance/v1. ────────────────

// Node `ws` shape: EventEmitter with pings and the upgrade's HTTP answer.
class MockNodeWebSocket extends MockWebSocket {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  terminated = false
  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
  terminate(): void {
    this.readyState = 3
    this.terminated = true
  }
  /** The upgrade answered with an HTTP status: `ws` emits, the SDK terminates, the close follows. */
  simulateUpgradeAnswer(status: number, retryAfter?: string): void {
    const res = { statusCode: status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter }, resume: vi.fn() }
    this.emit('unexpected-response', {}, res)
    this.simulateClose(1006, '', false)
  }
}
const MockNodeWebSocketCtor = MockNodeWebSocket as unknown as typeof globalThis.WebSocket

function client(options: Partial<RealtimeOptions> = {}): RealtimeClient {
  const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, ...options })
  rt.onError(() => undefined)
  rt.on('message.new', () => undefined) // attached before the socket opens: the HELLO offers acks
  return rt
}

async function open(rt: RealtimeClient, hello: unknown = json('hello-ok.v1.json')): Promise<MockWebSocket> {
  await rt.connect()
  const ws = MockWebSocket.latest()
  ws.simulateOpen()
  ws.simulateMessage(hello)
  return ws
}

beforeEach(() => MockWebSocket.reset())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('capabilities', () => {
  it('offers ack and heartbeat by default, rewake only when asked', async () => {
    const plain = client({ reconnect: false })
    await plain.connect()
    MockWebSocket.latest().simulateOpen()
    expect(JSON.parse(MockWebSocket.latest().sent[0]!)).toMatchObject({ capabilities: ['ack', 'heartbeat'] })
    plain.disconnect()

    const loop = client({ reconnect: false, capabilities: { rewake: true } })
    await loop.connect()
    MockWebSocket.latest().simulateOpen()
    expect(JSON.parse(MockWebSocket.latest().sent[0]!)).toMatchObject({ capabilities: ['ack', 'heartbeat', 'rewake'] })
    loop.disconnect()

    const quiet = client({ reconnect: false, capabilities: { heartbeat: false } })
    await quiet.connect()
    MockWebSocket.latest().simulateOpen()
    expect(JSON.parse(MockWebSocket.latest().sent[0]!)).toMatchObject({ capabilities: ['ack'] })
    quiet.disconnect()
  })

  it('offers ack only while a message handler is attached: a handler-less client is marked on send, as before', async () => {
    const bare = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor })
    const errors: Error[] = []
    bare.onError((e) => errors.push(e))
    await bare.connect()
    const first = MockWebSocket.latest()
    first.simulateOpen()
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ capabilities: ['heartbeat'] })
    first.simulateMessage({ type: 'hello.ok', capabilities: ['ack', 'heartbeat'] }) // an echo it was not offered
    expect(bare.ackNegotiated).toBe(false)
    expect(MockWebSocket.instances).toHaveLength(1)

    // The first message handler arrives late: one quiet reconnect, and the next HELLO offers acks.
    const seen: string[] = []
    bare.on('message.new', (m) => {
      seen.push(String(m.payload.id))
    })
    await settle()
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(first.closed).toEqual({ code: 1000, reason: 'client reconnects to negotiate delivery acks' })
    const second = MockWebSocket.latest()
    second.simulateOpen()
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ capabilities: ['ack', 'heartbeat'] })
    second.simulateMessage({ type: 'hello.ok', capabilities: ['ack', 'heartbeat'] })
    expect(bare.ackNegotiated).toBe(true)
    expect(bare.state).toBe('ready')
    expect(errors).toEqual([])
    // A second handler does not reconnect again.
    bare.on('message.new', () => undefined)
    await settle()
    expect(MockWebSocket.instances).toHaveLength(2)
    bare.disconnect()
  })

  it('a handler attached before the HELLO goes out needs no reconnect', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor })
    await rt.connect()
    rt.on('message.new', () => undefined)
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ capabilities: ['ack', 'heartbeat'] })
    await settle()
    expect(MockWebSocket.instances).toHaveLength(1)
    rt.disconnect()
  })

  it('hello-ok.v1.json: exposes what the server accepted; a close clears it', async () => {
    const rt = client({ reconnect: false, capabilities: { rewake: true } })
    const ws = await open(rt)
    expect([...rt.capabilities].sort()).toEqual(['ack', 'heartbeat', 'rewake'])
    expect(rt.ackNegotiated).toBe(true)
    ws.simulateClose(1006, '', false)
    expect(rt.capabilities.size).toBe(0)
    rt.disconnect()
  })
})

describe('heartbeat frames (D7)', () => {
  it('heartbeat-frame.json reaches heartbeat handlers, is never acked, and is not a message', async () => {
    const rt = client({ reconnect: false })
    const ws = await open(rt)
    const beats: HeartbeatFrame[] = []
    const messages = vi.fn()
    rt.on('heartbeat', (frame) => {
      beats.push(frame)
    })
    rt.on('message.new', messages)
    ws.simulateMessage(raw('heartbeat-frame.json'))
    await settle()
    expect(beats).toEqual([json('heartbeat-frame.json')])
    expect(messages).not.toHaveBeenCalled()
    expect(ws.sent.slice(1)).toEqual([]) // nothing after the HELLO
    rt.disconnect()
  })

  it('a browser-shaped socket with heartbeat accepted gets the idle deadline: heartbeats keep it up, silence ends it', async () => {
    vi.useFakeTimers()
    const rt = client()
    const ws = await open(rt)
    for (let t = 0; t < 30 * 60_000; t += 45_000) {
      await vi.advanceTimersByTimeAsync(45_000)
      ws.simulateMessage(raw('heartbeat-frame.json'))
    }
    expect(ws.closed).toBeNull()
    expect(rt.state).toBe('ready')
    // One missed heartbeat is survived; the second is not.
    await vi.advanceTimersByTimeAsync(90_000)
    expect(ws.closed).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ws.closed).toEqual({ code: 4000, reason: 'client liveness timeout' })
    expect(rt.state).toBe('backoff')
    rt.disconnect()
  })

  it('without the heartbeat capability a browser-shaped socket keeps the deadline off (unchanged)', async () => {
    vi.useFakeTimers()
    const rt = client()
    const ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(ws.closed).toBeNull()
    expect(rt.state).toBe('ready')
    rt.disconnect()
  })

  it('livenessTimeoutMs: 0 still disables it', async () => {
    vi.useFakeTimers()
    const rt = client({ livenessTimeoutMs: 0 })
    const ws = await open(rt)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(ws.closed).toBeNull()
    rt.disconnect()
  })
})

describe('wake frames (contract v1)', () => {
  it('wake-frame.unanswered.json reaches wake handlers as-is and is never acked', async () => {
    const rt = client({ reconnect: false, capabilities: { rewake: true } })
    const ws = await open(rt)
    const wakes: WakeFrame[] = []
    rt.on('wake', (frame) => {
      wakes.push(frame)
    })
    ws.simulateMessage(raw('wake-frame.unanswered.json'))
    ws.simulateMessage(raw('wake-frame.json'))
    await settle()
    expect(wakes).toEqual([json('wake-frame.unanswered.json'), json('wake-frame.json')])
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })

  it('without rewake the 1.2 rule holds: only reminder-shaped wakes reach the handlers', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))
    const ws = await open(rt) // the server echo names rewake, but this HELLO did not offer it
    expect(rt.capabilities.has('rewake')).toBe(false)
    const wakes: WakeFrame[] = []
    rt.on('wake', (frame) => {
      wakes.push(frame)
    })
    ws.simulateMessage(raw('wake-frame.unanswered.json'))
    ws.simulateMessage({ type: 'wake', payload: { reason: 'something_new', at: '2026-11-08T09:01:00.000Z' } })
    ws.simulateMessage(raw('wake-frame.json'))
    await settle()
    expect(wakes).toEqual([json('wake-frame.json')])
    expect(errors).toHaveLength(2)
    rt.disconnect()
  })

  it('with rewake: validates each known reason by its own shape; forwards an unknown reason', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, capabilities: { rewake: true } })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))
    const ws = await open(rt)
    const wakes: WakeFrame[] = []
    rt.on('wake', (frame) => {
      wakes.push(frame)
    })
    const at = '2026-11-08T09:01:00.000Z'
    ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', step: 1, at } }) // no ids
    ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: [1], step: 1, at } })
    ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['c'], at } }) // no step
    ws.simulateMessage({ type: 'wake', payload: { reason: 'reminder', conversation_ids: ['c'], step: 1, at } })
    ws.simulateMessage({ type: 'wake', payload: { reason: 'something_new', at } })
    ws.simulateMessage({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: [], step: 4, at } })
    await settle()
    expect(errors).toHaveLength(4)
    expect(errors.every((e) => /wake frame failed validation/.test(e.message))).toBe(true)
    expect(wakes.map((w) => wakePayloadOf(w).reason)).toEqual(['something_new', 'unanswered'])
    rt.disconnect()
  })
})

// ─── conformance/v1/connect-budget.cases.json, through the socket ──────────

interface BudgetCase {
  name: string
  event: { kind: 'close'; code: number; reason: string }
  expect: { delay_ms: number | null; blocked: boolean }
}

const budget = json<{ cases: BudgetCase[] }>('connect-budget.cases.json')

describe('connect budget (D8) — the socket backs off for the server delay, never blocked', () => {
  it.each(budget.cases.filter((c) => c.expect.delay_ms !== null).map((c) => [c.name, c] as const))(
    '%s',
    async (_name, c) => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockNodeWebSocketCtor, reconnectInterval: 10 })
      const errors: Error[] = []
      const blocked = vi.fn()
      rt.onError((e) => errors.push(e))
      rt.on('blocked', blocked)
      await rt.connect()
      const ws = MockWebSocket.latest() as MockNodeWebSocket
      ws.simulateOpen()
      ws.simulateClose(c.event.code, c.event.reason, true)
      expect(rt.state).toBe('backoff')
      expect(blocked).not.toHaveBeenCalled()
      expect(errors.some((e) => /connect budget exceeded/.test(e.message))).toBe(true)
      const delay = c.expect.delay_ms!
      // The wait is the server's delay plus 0–10% (never less); with the
      // jitter pinned at its middle: nothing before delay × 1.05, the next attempt then.
      const top = Math.floor(delay * (1 + 0.5 * 0.1))
      expect(top).toBeGreaterThanOrEqual(delay)
      await vi.advanceTimersByTimeAsync(top - 1)
      expect(MockWebSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(rt.state).toBe('connecting')
      rt.disconnect()
    },
  )

  it.each(budget.cases.filter((c) => c.expect.delay_ms === null).map((c) => [c.name, c] as const))(
    '%s',
    async (_name, c) => {
      vi.useFakeTimers()
      const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockNodeWebSocketCtor, reconnectInterval: 10 })
      rt.onError(() => undefined)
      await rt.connect()
      const ws = MockWebSocket.latest()
      ws.simulateOpen()
      ws.simulateClose(c.event.code, c.event.reason, false)
      expect(rt.state).toBe('backoff')
      await vi.advanceTimersByTimeAsync(10) // the ordinary backoff's first step
      expect(MockWebSocket.instances).toHaveLength(2)
      rt.disconnect()
    },
  )

  it('an upgrade answered 429 (no AgentChat server does): the ordinary backoff, never blocked, Retry-After ignored', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockNodeWebSocketCtor, reconnectInterval: 10 })
    const blocked = vi.fn()
    rt.onError(() => undefined)
    rt.on('blocked', blocked)
    await rt.connect()
    const ws = MockWebSocket.latest() as MockNodeWebSocket
    ws.simulateUpgradeAnswer(429, '3600')
    expect(ws.terminated).toBe(true)
    expect(rt.state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(10)
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(blocked).not.toHaveBeenCalled()
    rt.disconnect()
  })

  it('an upgrade answered with another status takes the ordinary backoff', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockNodeWebSocketCtor, reconnectInterval: 10 })
    rt.onError(() => undefined)
    await rt.connect()
    ;(MockWebSocket.latest() as MockNodeWebSocket).simulateUpgradeAnswer(502)
    await vi.advanceTimersByTimeAsync(10)
    expect(MockWebSocket.instances).toHaveLength(2)
    rt.disconnect()
  })
})

describe('in-flight adoption across reconnects is bounded (inFlightAdoptMs)', () => {
  it('a re-offer on a later connection past the bound is dispatched afresh', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, inFlightAdoptMs: 0 })
    rt.onError(() => undefined)
    const calls: string[] = []
    rt.on('message.new', async (m) => {
      calls.push(String(m.payload.id))
      if (calls.length === 1) await new Promise(() => undefined) // a handler that never finishes
    })
    let ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'c', seq: 1 } })
    await settle()
    ws.simulateClose(1006, '', false)
    ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'c', seq: 1 } })
    await settle()
    expect(calls).toEqual(['msg_1', 'msg_1'])
    rt.disconnect()
  })
})

describe('one message at a time per conversation (promise 2)', () => {
  it('a conversation waits for its running handler; another conversation does not; order is seq order', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false })
    const entered: string[] = []
    const releases = new Map<string, () => void>()
    rt.on('message.new', async (m) => {
      const id = String(m.payload.id)
      entered.push(id)
      await new Promise<void>((r) => releases.set(id, r))
    })
    const ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    const frame = (conv: string, seq: number) => ({ type: 'message.new', payload: { id: `${conv}_${seq}`, conversation_id: conv, seq } })
    ws.simulateMessage(frame('a', 1))
    ws.simulateMessage(frame('a', 2))
    ws.simulateMessage(frame('b', 1))
    ws.simulateMessage(frame('a', 3))
    await settle()
    expect(entered).toEqual(['a_1', 'b_1'])
    releases.get('a_1')!()
    await settle()
    expect(entered).toEqual(['a_1', 'b_1', 'a_2'])
    releases.get('a_2')!()
    await settle()
    expect(entered).toEqual(['a_1', 'b_1', 'a_2', 'a_3'])
    // Acks follow each handler's end, in that order.
    releases.get('a_3')!()
    releases.get('b_1')!()
    await settle()
    const acks = sentFrames(ws, 'ack').map((f) => String(f.message_id))
    expect(acks.filter((id) => id.startsWith('a_'))).toEqual(['a_1', 'a_2', 'a_3'])
    expect(acks).toContain('b_1')
    rt.disconnect()
  })

  it('plain (synchronous) handlers are still called at once, frame by frame', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false })
    const seen: string[] = []
    rt.on('message.new', (m) => {
      seen.push(String(m.payload.id))
    })
    const ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'x1', conversation_id: 'a', seq: 1 } })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'x2', conversation_id: 'a', seq: 2 } })
    expect(seen).toEqual(['x1', 'x2'])
    rt.disconnect()
  })

  it('a handler that never finishes holds its conversation at most inFlightAdoptMs', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, inFlightAdoptMs: 20 })
    const entered: string[] = []
    rt.on('message.new', async (m) => {
      entered.push(String(m.payload.id))
      if (m.payload.id === 'h1') await new Promise(() => undefined)
    })
    const ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'h1', conversation_id: 'a', seq: 1 } })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'h2', conversation_id: 'a', seq: 2 } })
    await settle()
    expect(entered).toEqual(['h1'])
    await new Promise((r) => setTimeout(r, 40))
    expect(entered).toEqual(['h1', 'h2'])
    rt.disconnect()
  })
})

describe('backpressure (maxQueuedMessages)', () => {
  it('a full handler queue takes no new frames in (no ack on receipt, no dispatch); once half drained the drain fetches them', async () => {
    // The server: stored rows stay until a sync/ack cursor covers them.
    const rows: Array<Record<string, unknown>> = []
    const sync = vi.fn(async (opts?: { after?: string }) => {
      const from = opts?.after ? rows.findIndex((r) => r.delivery_id === opts.after) + 1 : 0
      return rows.slice(from)
    })
    const syncAck = vi.fn(async (cursor: string) => {
      const upto = rows.findIndex((r) => r.delivery_id === cursor)
      rows.splice(0, upto + 1)
      return { acked: upto + 1 }
    })
    const client = { sync, syncAck, getMessages: vi.fn(async () => []) }
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      ackOnReceipt: true,
      autoDrainOnConnect: false,
      maxQueuedMessages: 2,
      client: client as never,
    })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))
    const seen: string[] = []
    const releases: Array<() => void> = []
    rt.on('message.new', async (m) => {
      seen.push(String(m.payload.id))
      await new Promise<void>((r) => releases.push(r))
    })
    const ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    const frame = (seq: number) => ({ type: 'message.new', payload: { id: `m${seq}`, conversation_id: 'a', seq } })
    for (let seq = 1; seq <= 5; seq++) ws.simulateMessage(frame(seq))
    await settle()
    // Two taken in (one running, one queued); three left with the server: not acked.
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['m1', 'm2'])
    expect(seen).toEqual(['m1'])
    expect(errors.filter((e) => /handlers are behind/.test(e.message))).toHaveLength(1)
    // The server still holds m3..m5; the drain brings them once the queue is back to half.
    rows.push(
      ...[3, 4, 5].map((seq) => ({ id: `m${seq}`, conversation_id: 'a', seq, delivery_id: `del_${seq}`, type: 'text', content: { text: 'x' } })),
    )
    releases.shift()!()
    await settle()
    expect(sync).toHaveBeenCalled()
    for (let i = 0; i < 50 && seen.length < 5; i++) {
      releases.shift()?.()
      await settle()
    }
    expect(seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    releases.splice(0).forEach((r) => r())
    await settle()
    expect(rows).toEqual([]) // every row the drain handed over was acked by the cursor, once handled
    rt.disconnect()
  })

  it('without a REST client the recovery is one quiet reconnect, so the server re-offers its backlog', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, ackOnReceipt: true, maxQueuedMessages: 1 })
    rt.onError(() => undefined)
    const releases: Array<() => void> = []
    rt.on('message.new', async () => {
      await new Promise<void>((r) => releases.push(r))
    })
    const ws = await open(rt, { type: 'hello.ok', capabilities: ['ack'] })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'n1', conversation_id: 'a', seq: 1 } })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'n2', conversation_id: 'a', seq: 2 } })
    await settle()
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['n1'])
    releases.shift()!()
    await settle()
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(ws.closed).toEqual({ code: 1000, reason: 'client reconnects to fetch messages it left with the server' })
    rt.disconnect()
  })
})
