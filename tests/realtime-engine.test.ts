import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import type { WakeFrame } from '../src/types/index.js'
import {
  MockWebSocket,
  MockWebSocketCtor,
  messageNew,
  sentFrames,
  settle,
} from './helpers/mock-websocket.js'

// ─── wake frames, ack-on-receipt, several instances per process ────────────

beforeEach(() => MockWebSocket.reset())
afterEach(() => vi.useRealTimers())

async function connected(options: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const rt = new RealtimeClient({
    apiKey: 'k',
    webSocket: MockWebSocketCtor,
    reconnect: false,
    ...options,
  })
  await rt.connect()
  const ws = MockWebSocket.latest()
  ws.simulateOpen()
  ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
  return { rt, ws }
}

const wake: WakeFrame = {
  type: 'wake',
  payload: {
    reason: 'reminder',
    conversation_id: 'conv_1',
    anchor_message_id: 'msg_1',
    step: 2,
    at: '2026-11-05T00:00:00.000Z',
  },
}

describe('RealtimeClient — wake frames', () => {
  it('dispatches a wake frame to `wake` handlers with its typed payload', async () => {
    const { rt, ws } = await connected()
    const seen: string[] = []
    rt.on('wake', (frame) => {
      seen.push(`${frame.payload.reason}:${frame.payload.conversation_id}:${frame.payload.step}`)
    })
    ws.simulateMessage(wake)
    await settle()
    expect(seen).toEqual(['reminder:conv_1:2'])
    rt.disconnect()
  })

  it('never acks a wake and does not hand it to message.new handlers', async () => {
    const { rt, ws } = await connected()
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)
    rt.on('wake', vi.fn())
    ws.simulateMessage(wake)
    await settle()
    expect(onMessage).not.toHaveBeenCalled()
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })

  it('surfaces a malformed wake through onError instead of dispatching it', async () => {
    const { rt, ws } = await connected()
    const onWake = vi.fn()
    const errors: Error[] = []
    rt.on('wake', onWake)
    rt.onError((e) => errors.push(e))

    ws.simulateMessage({ type: 'wake', payload: { reason: 'reminder' } })
    ws.simulateMessage({ type: 'wake', payload: 'soon' })
    ws.simulateMessage({ type: 'wake' })
    await settle()

    expect(onWake).not.toHaveBeenCalled()
    expect(errors).toHaveLength(3)
    expect(errors.every((e) => /wake frame failed validation/.test(e.message))).toBe(true)
    rt.disconnect()
  })

  it('still ignores frame types nobody subscribed to', async () => {
    const { rt, ws } = await connected()
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))
    ws.simulateMessage({ type: 'something.new', payload: { x: 1 } })
    ws.simulateMessage(wake) // no wake handler registered either
    await settle()
    expect(errors).toEqual([])
    rt.disconnect()
  })

  it('unsubscribes a wake handler', async () => {
    const { rt, ws } = await connected()
    const onWake = vi.fn()
    const off = rt.on('wake', onWake)
    off()
    ws.simulateMessage(wake)
    await settle()
    expect(onWake).not.toHaveBeenCalled()
    rt.disconnect()
  })
})

describe('RealtimeClient — ackOnReceipt', () => {
  it('acks before any handler runs, and exactly once', async () => {
    const { rt, ws } = await connected({ ackOnReceipt: true })
    const acksWhenHandlerRan: number[] = []
    rt.on('message.new', () => {
      acksWhenHandlerRan.push(sentFrames(ws, 'ack').length)
    })

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    expect(acksWhenHandlerRan).toEqual([1])
    expect(sentFrames(ws, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])
    rt.disconnect()
  })

  it('acks even when the handler throws — delivery is not processing', async () => {
    const { rt, ws } = await connected({ ackOnReceipt: true })
    rt.on('message.new', () => {
      throw new Error('boom')
    })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))

    ws.simulateMessage(messageNew('c', 1))
    await settle()

    expect(sentFrames(ws, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])
    expect(errors.some((e) => /boom/.test(e.message))).toBe(true)
    rt.disconnect()
  })

  it('acks a frame parked on a seq gap at receipt, not when it is finally dispatched', async () => {
    const { rt, ws } = await connected({ ackOnReceipt: true })
    const dispatched: number[] = []
    rt.on('message.new', (m) => {
      dispatched.push((m.payload as { seq: number }).seq)
    })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3)) // parked until seq 2 arrives
    await settle()
    expect(dispatched).toEqual([1])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3'])

    ws.simulateMessage(messageNew('c', 2))
    await settle()
    expect(dispatched).toEqual([1, 2, 3])
    // No second ack for seq 3 once it leaves the buffer.
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3', 'msg_2'])
    rt.disconnect()
  })

  it('acks a redelivered duplicate once more, without re-dispatching it', async () => {
    const { rt, ws } = await connected({ ackOnReceipt: true })
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    ws.simulateMessage(messageNew('c', 1))
    await settle()
    // Same message, different seq anchoring is irrelevant: dedup is by id.
    ws.simulateMessage(messageNew('d', 7, { id: 'msg_1' }))
    await settle()

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(sentFrames(ws, 'ack')).toEqual([
      { type: 'ack', message_id: 'msg_1' },
      { type: 'ack', message_id: 'msg_1' },
    ])
    rt.disconnect()
  })

  it('sends nothing against a server that did not negotiate ack', async () => {
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      ackOnReceipt: true,
    })
    rt.on('message.new', vi.fn())
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })
    ws.simulateMessage(messageNew('c', 1))
    await settle()
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })

  it('leaves the default (ack after handlers settle) unchanged', async () => {
    const { rt, ws } = await connected()
    let release!: () => void
    rt.on('message.new', () => new Promise<void>((r) => (release = r)))
    ws.simulateMessage(messageNew('c', 1))
    await settle()
    expect(sentFrames(ws, 'ack')).toEqual([])
    release()
    await settle()
    expect(sentFrames(ws, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])
    rt.disconnect()
  })
})

describe('RealtimeClient — a guest in a host process', () => {
  it('runs two instances side by side; closing one leaves the other untouched', async () => {
    vi.useFakeTimers()
    const a = new RealtimeClient({ apiKey: 'ka', webSocket: MockWebSocketCtor, ackOnReceipt: true })
    const b = new RealtimeClient({ apiKey: 'kb', webSocket: MockWebSocketCtor })
    const seenA: string[] = []
    const seenB: string[] = []
    a.on('message.new', (m) => void seenA.push(String(m.payload.id)))
    b.on('message.new', (m) => void seenB.push(String(m.payload.id)))

    await a.connect()
    const wsA = MockWebSocket.latest()
    await b.connect()
    const wsB = MockWebSocket.latest()
    expect(wsA).not.toBe(wsB)
    wsA.simulateOpen()
    wsA.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    wsB.simulateOpen()
    wsB.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    expect(a.isConnected && b.isConnected).toBe(true)

    // Each socket authenticated with its own key.
    expect(JSON.parse(wsA.sent[0]!)).toMatchObject({ api_key: 'ka' })
    expect(JSON.parse(wsB.sent[0]!)).toMatchObject({ api_key: 'kb' })

    a.disconnect()
    expect(wsA.closed).not.toBeNull()
    expect(wsB.closed).toBeNull()
    expect(a.isConnected).toBe(false)
    expect(b.isConnected).toBe(true)

    // b still receives, dedups and acks on its own socket.
    wsB.simulateMessage(messageNew('c', 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(seenB).toEqual(['msg_1'])
    expect(seenA).toEqual([])
    expect(sentFrames(wsB, 'ack')).toEqual([{ type: 'ack', message_id: 'msg_1' }])
    expect(sentFrames(wsA, 'ack')).toEqual([])

    // Closing a released every timer it owned (reconnect, hello-ack,
    // stability window, gap timers); the socket for a is not reopened even
    // after its server-side close lands and long after any backoff.
    const socketsBefore = MockWebSocket.instances.length
    wsA.simulateClose(1006, 'server noticed', false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockWebSocket.instances.length).toBe(socketsBefore)
    expect(b.isConnected).toBe(true)

    b.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a pending reconnect timer on close', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnectInterval: 1_000,
    })
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok' })
    ws.simulateClose(1006, 'blip', false) // schedules a reconnect
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    rt.disconnect()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('releases the hello-ack timer when closed mid-handshake', async () => {
    vi.useFakeTimers()
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor })
    await rt.connect()
    MockWebSocket.latest().simulateOpen() // HELLO sent, 4 s ack timer armed
    expect(vi.getTimerCount()).toBe(1)
    rt.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })
})
