import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient, type RealtimeOptions } from '../src/realtime.js'
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
afterEach(() => vi.useRealTimers())

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

  it('validates each known reason by its own shape; forwards an unknown reason', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false })
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
    expect(wakes.map((w) => w.payload.reason)).toEqual(['something_new', 'unanswered'])
    rt.disconnect()
  })
})

// ─── conformance/v1/connect-budget.cases.json, through the socket ──────────

interface BudgetCase {
  name: string
  event:
    | { kind: 'close'; code: number; reason: string }
    | { kind: 'upgrade'; status: number; retry_after: string | null; now?: string }
  expect: { delay_ms: number | null; blocked: boolean }
}

const budget = json<{ cases: BudgetCase[] }>('connect-budget.cases.json')

describe('connect budget (D8) — the socket backs off for the server delay, never blocked', () => {
  it.each(budget.cases.filter((c) => c.expect.delay_ms !== null).map((c) => [c.name, c] as const))(
    '%s',
    async (_name, c) => {
      vi.useFakeTimers()
      if (c.event.kind === 'upgrade' && c.event.now) vi.setSystemTime(new Date(c.event.now))
      const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockNodeWebSocketCtor, reconnectInterval: 10 })
      const errors: Error[] = []
      const blocked = vi.fn()
      rt.onError((e) => errors.push(e))
      rt.on('blocked', blocked)
      await rt.connect()
      const ws = MockWebSocket.latest() as MockNodeWebSocket
      if (c.event.kind === 'close') {
        ws.simulateOpen()
        ws.simulateClose(c.event.code, c.event.reason, true)
      } else {
        ws.simulateUpgradeAnswer(c.event.status, c.event.retry_after ?? undefined)
        expect(ws.terminated).toBe(true)
      }
      expect(rt.state).toBe('backoff')
      expect(blocked).not.toHaveBeenCalled()
      expect(errors.some((e) => /connect budget exceeded/.test(e.message))).toBe(true)
      const delay = c.expect.delay_ms!
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(MockWebSocket.instances).toHaveLength(1)
      // This SDK adds no jitter to the server's delay (the contract allows up to +10%).
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
      if (c.event.kind === 'close') ws.simulateClose(c.event.code, c.event.reason, false)
      expect(rt.state).toBe('backoff')
      await vi.advanceTimersByTimeAsync(10) // the ordinary backoff's first step
      expect(MockWebSocket.instances).toHaveLength(2)
      rt.disconnect()
    },
  )

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
