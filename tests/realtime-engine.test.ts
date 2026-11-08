import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import type { AgentChatClient } from '../src/client.js'
import type { Message, WakeFrame } from '../src/types/index.js'
import {
  MockWebSocket,
  MockWebSocketCtor,
  messageNew,
  sentFrames,
  settle,
} from './helpers/mock-websocket.js'

// ─── wake frames, ack-on-receipt, several instances per process ────────────

beforeEach(() => MockWebSocket.reset())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// One bare-array row as `GET /v1/messages/sync` ships it.
function syncRow(conversationId: string, seq: number): Record<string, unknown> {
  return {
    ...(messageNew(conversationId, seq).payload as Record<string, unknown>),
    id: `msg_${conversationId}_${seq}`,
    delivery_id: `del_${seq.toString(16).padStart(32, '0')}`,
  }
}

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

  it('hands an acked frame parked on a seq gap to the handlers when the socket drops (1006)', async () => {
    const onGap = vi.fn()
    const { rt, ws } = await connected({ ackOnReceipt: true, onSequenceGap: onGap })
    const dispatched: number[] = []
    rt.on('message.new', (m) => void dispatched.push((m.payload as { seq: number }).seq))

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3)) // parked; already acked
    await settle()
    expect(dispatched).toEqual([1])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3'])

    // The server has msg_3 as delivered and will never re-offer it. An
    // abnormal close must not drop it with the ordering state.
    ws.simulateClose(1006, 'abnormal', false)
    await settle()
    expect(dispatched).toEqual([1, 3])
    expect(onGap).toHaveBeenCalledTimes(1)
    expect(onGap.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'c',
      expectedSeq: 2,
      bufferedSeq: 3,
      recovered: false,
      reason: 'connection_closed',
    })
    // No second ack: it was acked at receipt.
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3'])
    rt.disconnect()
  })

  it('in default mode a parked frame is dropped on close: unacked, the server re-offers it in order', async () => {
    const onGap = vi.fn()
    const { rt, ws } = await connected({ onSequenceGap: onGap })
    const dispatched: number[] = []
    rt.on('message.new', (m) => void dispatched.push((m.payload as { seq: number }).seq))

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3))
    await settle()
    ws.simulateClose(1006, 'abnormal', false)
    await settle()

    expect(dispatched).toEqual([1])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1'])
    expect(onGap).not.toHaveBeenCalled()
    rt.disconnect()
  })

  it('acks a gap-filled row when it is fetched, dispatches in order, never acks it twice', async () => {
    vi.useFakeTimers()
    const getMessages = vi.fn(async (): Promise<Message[]> => [
      messageNew('c', 2).payload as unknown as Message,
    ])
    const client = { getMessages, sync: vi.fn(), syncAck: vi.fn() } as unknown as AgentChatClient
    const onGap = vi.fn()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      ackOnReceipt: true,
      client,
      autoDrainOnConnect: false,
      onSequenceGap: onGap,
    })
    const dispatched: number[] = []
    rt.on('message.new', (m) => void dispatched.push((m.payload as { seq: number }).seq))
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3))
    expect(dispatched).toEqual([1])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3'])

    await vi.advanceTimersByTimeAsync(2_100) // past the gap window
    await vi.runAllTimersAsync()

    expect(getMessages).toHaveBeenCalledOnce()
    expect(dispatched).toEqual([1, 2, 3])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3', 'msg_2'])
    expect(onGap.mock.calls[0]?.[0]).toMatchObject({ recovered: true, reason: 'gap_filled' })
    rt.disconnect()
  })

  it('keeps the REST drain on its settle-then-ack cursor: no WS acks for drained rows', async () => {
    const sync = vi.fn(async () => [syncRow('c', 1), syncRow('c', 2)])
    const syncAck = vi.fn(async () => ({ acked: 2 }))
    const client = { getMessages: vi.fn(), sync, syncAck } as unknown as AgentChatClient
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      ackOnReceipt: true,
      client,
    })
    const dispatched: string[] = []
    rt.on('message.new', (m) => void dispatched.push(String(m.payload.id)))
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    await settle()

    expect(sync).toHaveBeenCalledOnce()
    expect(dispatched).toEqual(['msg_c_1', 'msg_c_2'])
    expect(syncAck).toHaveBeenCalledWith(syncRow('c', 2).delivery_id)
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })

  it('REST drain under ackOnReceipt still withholds the cursor when a handler throws', async () => {
    const sync = vi.fn(async () => [syncRow('c', 1)])
    const syncAck = vi.fn(async () => ({ acked: 1 }))
    const client = { getMessages: vi.fn(), sync, syncAck } as unknown as AgentChatClient
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      ackOnReceipt: true,
      client,
    })
    rt.on('message.new', () => {
      throw new Error('boom')
    })
    rt.onError(() => undefined)
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    await settle()

    expect(syncAck).not.toHaveBeenCalled()
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })
})

describe('RealtimeClient — stored rows older than the live anchor', () => {
  // The server registers a socket and THEN drains the stored backlog, so a
  // live frame (seq 5) can anchor a conversation before the drain brings
  // stored seqs 3 and 4. Those are below the anchor but were never
  // dispatched; dropping them would lose them because the ack marks them
  // delivered for good.

  it.each([false, true])(
    'backlog pushed over the socket after a live anchor is dispatched and acked once (ackOnReceipt=%s)',
    async (ackOnReceipt) => {
      const { rt, ws } = await connected({ ackOnReceipt })
      const dispatched: number[] = []
      rt.on('message.new', (m) => void dispatched.push((m.payload as { seq: number }).seq))

      ws.simulateMessage(messageNew('c', 5)) // live fan-out beats the drain
      ws.simulateMessage(messageNew('c', 3)) // server's reconnect drain, stored rows
      ws.simulateMessage(messageNew('c', 4))
      await settle()

      expect(dispatched).toEqual([5, 3, 4])
      expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_5', 'msg_3', 'msg_4'])
      rt.disconnect()
    },
  )

  it.each([false, true])(
    'REST drain rows below the live anchor are dispatched before the cursor covers them (ackOnReceipt=%s)',
    async (ackOnReceipt) => {
      let resolveSync!: (rows: Record<string, unknown>[]) => void
      const sync = vi
        .fn()
        .mockImplementationOnce(() => new Promise<Record<string, unknown>[]>((r) => (resolveSync = r)))
      const syncAck = vi.fn(async () => ({ acked: 2 }))
      const client = { getMessages: vi.fn(), sync, syncAck } as unknown as AgentChatClient
      const rt = new RealtimeClient({
        apiKey: 'k',
        webSocket: MockWebSocketCtor,
        reconnect: false,
        ackOnReceipt,
        client,
      })
      const dispatched: string[] = []
      rt.on('message.new', (m) => void dispatched.push(String(m.payload.id)))
      await rt.connect()
      const ws = MockWebSocket.latest()
      ws.simulateOpen()
      ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] }) // drain starts, waits on sync

      ws.simulateMessage(messageNew('c', 5)) // live frame anchors c at 5
      resolveSync([syncRow('c', 3), syncRow('c', 4)])
      await settle()

      expect(dispatched).toEqual(['msg_5', 'msg_c_3', 'msg_c_4'])
      expect(syncAck).toHaveBeenCalledWith(syncRow('c', 4).delivery_id)
      // Drain rows are covered by the cursor, never by a WS ack frame.
      expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_5'])
      rt.disconnect()
    },
  )

  it('a true repeat below the anchor (same message id) is skipped and acked once more', async () => {
    const { rt, ws } = await connected()
    const onMessage = vi.fn()
    rt.on('message.new', onMessage)

    ws.simulateMessage(messageNew('c', 5))
    ws.simulateMessage(messageNew('c', 6))
    await settle()
    ws.simulateMessage(messageNew('c', 5)) // server double-publish / lost ack
    await settle()

    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_5', 'msg_6', 'msg_5'])
    rt.disconnect()
  })

  it('a seq skipped by a failed gap-fill that arrives late is dispatched, not dropped', async () => {
    vi.useFakeTimers()
    const onGap = vi.fn()
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      onSequenceGap: onGap, // no client → gap-fill unavailable
    })
    const dispatched: number[] = []
    rt.on('message.new', (m) => void dispatched.push((m.payload as { seq: number }).seq))
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })

    ws.simulateMessage(messageNew('c', 1))
    ws.simulateMessage(messageNew('c', 3))
    await vi.advanceTimersByTimeAsync(2_100) // gap window lapses; 3 is released, 2 skipped
    expect(dispatched).toEqual([1, 3])
    expect(onGap).toHaveBeenCalledOnce()

    ws.simulateMessage(messageNew('c', 2)) // the skipped seq finally arrives
    await vi.advanceTimersByTimeAsync(0)
    expect(dispatched).toEqual([1, 3, 2])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_3', 'msg_2'])
    rt.disconnect()
  })
})

describe('RealtimeClient — a repeat while the first copy is still with the handlers', () => {
  // After a reconnect the server pushes its stored backlog on the socket
  // and the REST drain brings the same rows. With a slow handler the second
  // copy arrives before the first one finished, so the dedup cache (filled
  // only on success) cannot catch it.

  function deferred() {
    let resolve!: () => void
    let reject!: (err: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it.each([false, true])(
    'a REST drain row is not dispatched again and the drain never waits for the first copy (ackOnReceipt=%s)',
    async (ackOnReceipt) => {
      const sync = vi
        .fn()
        .mockResolvedValueOnce([syncRow('c', 1), syncRow('d', 1)])
        .mockResolvedValueOnce([syncRow('c', 1)])
        .mockResolvedValue([])
      const syncAck = vi.fn(async () => ({ acked: 1 }))
      const client = { getMessages: vi.fn(), sync, syncAck } as unknown as AgentChatClient
      const rt = new RealtimeClient({
        apiKey: 'k',
        webSocket: MockWebSocketCtor,
        reconnect: false,
        autoDrainOnConnect: false,
        ackOnReceipt,
        client,
      })
      const slow = deferred()
      const calls: string[] = []
      rt.on('message.new', async (m) => {
        calls.push(String(m.payload.id))
        if (m.payload.id === 'msg_c_1') await slow.promise
      })
      await rt.connect()
      const ws = MockWebSocket.latest()
      ws.simulateOpen()
      ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })

      // The live copy (the server's backlog push) carries the row's id.
      ws.simulateMessage({ type: 'message.new', payload: syncRow('c', 1) })
      // The drain finishes while that handler still runs: the repeat is not
      // dispatched, the next row (another conversation) is, and the cursor
      // stops at the repeat instead of waiting for it.
      await rt.drainOfflineEnvelopes()
      expect(calls).toEqual(['msg_c_1', 'msg_d_1'])
      expect(syncAck).not.toHaveBeenCalled()

      slow.resolve()
      await settle()
      expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_c_1'])
      // The next drain re-offers the row: a dedup hit now, so it is covered.
      await rt.drainOfflineEnvelopes()
      expect(calls).toEqual(['msg_c_1', 'msg_d_1'])
      expect(syncAck).toHaveBeenCalledWith(syncRow('c', 1).delivery_id)
      rt.disconnect()
    },
  )

  it('a live repeat of a first copy that failed is never acked', async () => {
    const { rt, ws } = await connected()
    rt.onError(() => undefined)
    const slow = deferred()
    const calls: string[] = []
    rt.on('message.new', async (m) => {
      calls.push(String(m.payload.id))
      await slow.promise
    })

    ws.simulateMessage(messageNew('c', 5))
    ws.simulateMessage(messageNew('c', 7)) // keeps the ordering state live
    ws.simulateMessage(messageNew('c', 5)) // the repeat adopts the running first copy
    await settle()
    slow.reject(new Error('model call failed'))
    await settle()
    expect(calls).toEqual(['msg_5'])
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })

  it('a re-offer on a later connection adopts the first copy still running: no second dispatch', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false })
    const slow = deferred()
    const calls: string[] = []
    rt.on('message.new', async (m) => {
      calls.push(String(m.payload.id))
      if (calls.length === 1) await slow.promise // a slow handler (a model call)
    })
    await rt.connect()
    const ws1 = MockWebSocket.latest()
    ws1.simulateOpen()
    ws1.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws1.simulateMessage(messageNew('c', 1))
    await settle()
    ws1.simulateClose(1006, 'abnormal', false)

    await rt.connect()
    const ws2 = MockWebSocket.latest()
    ws2.simulateOpen()
    ws2.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws2.simulateMessage(messageNew('c', 1)) // the server re-offers the unacked message
    await settle()
    expect(calls).toEqual(['msg_1'])
    expect(sentFrames(ws2, 'ack')).toEqual([])

    slow.resolve()
    await settle()
    expect(calls).toEqual(['msg_1'])
    // The first copy's ack and the adopted copy's ack, both on the live socket.
    expect(sentFrames(ws2, 'ack').map((f) => f.message_id)).toEqual(['msg_1', 'msg_1'])
    rt.disconnect()
  })

  it('a re-offer after the first copy failed is dispatched again', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false })
    rt.onError(() => undefined)
    const slow = deferred()
    const calls: string[] = []
    rt.on('message.new', async (m) => {
      calls.push(String(m.payload.id))
      if (calls.length === 1) await slow.promise
    })
    await rt.connect()
    const ws1 = MockWebSocket.latest()
    ws1.simulateOpen()
    ws1.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws1.simulateMessage(messageNew('c', 1))
    await settle()
    ws1.simulateClose(1006, 'abnormal', false)
    slow.reject(new Error('model call failed'))
    await settle()

    await rt.connect()
    const ws2 = MockWebSocket.latest()
    ws2.simulateOpen()
    ws2.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws2.simulateMessage(messageNew('c', 1))
    await settle()
    expect(calls).toEqual(['msg_1', 'msg_1'])
    expect(sentFrames(ws2, 'ack').map((f) => f.message_id)).toEqual(['msg_1'])
    rt.disconnect()
  })

  it('no message handler attached: nothing is acked or remembered, in either mode', async () => {
    for (const ackOnReceipt of [false, true]) {
      MockWebSocket.reset()
      const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, ackOnReceipt })
      await rt.connect()
      const ws = MockWebSocket.latest()
      ws.simulateOpen()
      ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
      ws.simulateMessage(messageNew('c', 1))
      await settle()
      expect(sentFrames(ws, 'ack')).toEqual([])
      // A handler attached later gets the re-offer: it was never deduped.
      const calls: string[] = []
      rt.on('message.new', (m) => {
        calls.push(String(m.payload.id))
      })
      ws.simulateMessage(messageNew('c', 1))
      await settle()
      expect(calls).toEqual(['msg_1'])
      expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_1'])
      rt.disconnect()
    }
  })

  it('a live repeat is acked only after the first copy succeeded, without a second dispatch', async () => {
    const { rt, ws } = await connected()
    const slow = deferred()
    const calls: string[] = []
    rt.on('message.new', async (m) => {
      calls.push(String(m.payload.id))
      await slow.promise
    })

    ws.simulateMessage(messageNew('c', 5))
    ws.simulateMessage(messageNew('c', 7)) // keeps the ordering state live
    ws.simulateMessage(messageNew('c', 5)) // below the anchor, first copy still running
    await settle()
    expect(calls).toEqual(['msg_5'])
    expect(sentFrames(ws, 'ack')).toEqual([])

    slow.resolve()
    await settle()
    expect(calls).toEqual(['msg_5'])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_5', 'msg_5'])
    rt.disconnect()
  })

  it('a failed first copy leaves the repeat unacked, and a later copy is dispatched again', async () => {
    const sync = vi.fn().mockResolvedValueOnce([syncRow('c', 1)]).mockResolvedValue([])
    const syncAck = vi.fn(async () => ({ acked: 1 }))
    const client = { getMessages: vi.fn(), sync, syncAck } as unknown as AgentChatClient
    const rt = new RealtimeClient({
      apiKey: 'k',
      webSocket: MockWebSocketCtor,
      reconnect: false,
      autoDrainOnConnect: false,
      client,
    })
    rt.onError(() => undefined)
    const slow = deferred()
    const calls: string[] = []
    let failNext = true
    rt.on('message.new', async (m) => {
      calls.push(String(m.payload.id))
      if (failNext) {
        failNext = false
        await slow.promise
      }
    })
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })

    ws.simulateMessage({ type: 'message.new', payload: syncRow('c', 1) })
    const drain = rt.drainOfflineEnvelopes()
    await settle()
    slow.reject(new Error('model call failed'))
    await drain
    await settle()
    // Neither copy is acknowledged: the server re-offers the message.
    expect(calls).toEqual(['msg_c_1'])
    expect(syncAck).not.toHaveBeenCalled()
    expect(sentFrames(ws, 'ack')).toEqual([])

    // The re-offer is a fresh attempt, handed to the handler again.
    ws.simulateMessage({ type: 'message.new', payload: syncRow('c', 1) })
    await settle()
    expect(calls).toEqual(['msg_c_1', 'msg_c_1'])
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_c_1'])
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
    MockWebSocket.latest().simulateOpen() // HELLO sent; the 15 s handshake deadline is the one timer
    expect(vi.getTimerCount()).toBe(1)
    rt.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves the WebSocket constructor per connect, never from a process-wide memo', async () => {
    // On Node the resolver prefers `ws`. Two hosts in one process may
    // provide different implementations (here: two `ws` module instances);
    // the second client must get the one in scope when IT connects. A
    // module memo would hand it the first client's constructor.
    class HostA extends MockWebSocket {}
    class HostB extends MockWebSocket {}

    vi.doMock('ws', () => ({ default: HostA }))
    vi.resetModules()
    const a = new RealtimeClient({ apiKey: 'ka', reconnect: false })
    await a.connect()
    const wsA = MockWebSocket.latest()

    vi.doMock('ws', () => ({ default: HostB }))
    vi.resetModules()
    const b = new RealtimeClient({ apiKey: 'kb', reconnect: false })
    await b.connect()
    const wsB = MockWebSocket.latest()

    expect(wsA).toBeInstanceOf(HostA)
    expect(wsB).toBeInstanceOf(HostB)
    expect(wsB).not.toBeInstanceOf(HostA)

    // No cross-talk: each socket carries its own HELLO and only its own frames.
    wsA.simulateOpen()
    wsB.simulateOpen()
    expect(JSON.parse(wsA.sent[0]!)).toMatchObject({ api_key: 'ka' })
    expect(JSON.parse(wsB.sent[0]!)).toMatchObject({ api_key: 'kb' })
    expect(wsA.sent).toHaveLength(1)
    expect(wsB.sent).toHaveLength(1)

    a.disconnect()
    b.disconnect()
    vi.doUnmock('ws')
  })

  it('prefers `ws` over the native socket on Node (ping frames for the liveness watchdog)', async () => {
    class Native extends MockWebSocket {}
    class Ws extends MockWebSocket {}
    vi.stubGlobal('WebSocket', Native)
    vi.doMock('ws', () => ({ default: Ws }))
    vi.resetModules()
    const rt = new RealtimeClient({ apiKey: 'k', reconnect: false })
    await rt.connect()
    expect(MockWebSocket.latest()).toBeInstanceOf(Ws)
    rt.disconnect()
    vi.doUnmock('ws')
    vi.unstubAllGlobals()
  })

  it('falls back to the native socket when `ws` is not installed', async () => {
    class Native extends MockWebSocket {}
    vi.stubGlobal('WebSocket', Native)
    vi.doMock('ws', () => {
      throw new Error("Cannot find package 'ws'")
    })
    vi.resetModules()
    const rt = new RealtimeClient({ apiKey: 'k', reconnect: false })
    await rt.connect()
    expect(MockWebSocket.latest()).toBeInstanceOf(Native)
    rt.disconnect()
    vi.doUnmock('ws')
    vi.unstubAllGlobals()
  })

  it('no WebSocket implementation anywhere: connect() rejects, the client stays idle, no retry loop', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', undefined)
    vi.doMock('ws', () => {
      throw new Error("Cannot find package 'ws'")
    })
    vi.resetModules()
    const rt = new RealtimeClient({ apiKey: 'k', reconnectInterval: 10 })
    const errors: Error[] = []
    rt.onError((e) => errors.push(e))
    const before = MockWebSocket.instances.length

    await expect(rt.connect()).rejects.toThrow(/no WebSocket implementation/)
    // A configuration error, not an outage: nothing a retry could change.
    expect(rt.state).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances.length).toBe(before)
    expect(errors).toEqual([])

    rt.disconnect()
    vi.doUnmock('ws')
    vi.unstubAllGlobals()
  })
})
