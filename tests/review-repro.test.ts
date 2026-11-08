import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import { ReceiveLoop } from '../src/integration/receive-loop.js'
import type { InboxCard, InboxTray, ReplyDecision, Texts } from '../src/types/index.js'
import { MockWebSocket, MockWebSocketCtor, sentFrames, settle } from './helpers/mock-websocket.js'
import { json } from './integration/fixtures.js'

// The delta review's repro cases (F1, F3, F4), as assertions.

beforeEach(() => MockWebSocket.reset())

async function open(rt: RealtimeClient): Promise<MockWebSocket> {
  await rt.connect()
  const ws = MockWebSocket.latest()
  ws.simulateOpen()
  ws.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
  return ws
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('review repro', () => {
  it('F1: a message that waited in its lane is adopted after a reconnect; the bound counts from its start', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, inFlightAdoptMs: 100 })
    rt.onError(() => undefined)
    const entered: string[] = []
    rt.on('message.new', async (m) => {
      const id = String(m.payload.id)
      entered.push(id)
      if (id === 'a1') await sleep(80) // the first message takes 80 ms
      else await new Promise(() => undefined) // a2 runs long
    })
    let ws = await open(rt)
    ws.simulateMessage({ type: 'message.new', payload: { id: 'a1', conversation_id: 'c', seq: 1 } })
    ws.simulateMessage({ type: 'message.new', payload: { id: 'a2', conversation_id: 'c', seq: 2 } })
    await sleep(120) // a2 started at ~80 ms: it has run ~40 ms (< 100), though queued 120 ms ago
    expect(entered).toEqual(['a1', 'a2'])
    ws.simulateClose(1006, '', false)
    ws = await open(rt)
    ws.simulateMessage({ type: 'message.new', payload: { id: 'a2', conversation_id: 'c', seq: 2 } }) // re-offered
    await sleep(30)
    expect(entered).toEqual(['a1', 'a2']) // not dispatched twice
    rt.disconnect()
  })

  it('F3: under backpressure a conversation is never handed over out of order (intake refused for the whole episode)', async () => {
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: true, reconnectInterval: 1, maxQueuedMessages: 4 })
    rt.onError(() => undefined)
    const entered: string[] = []
    const releases = new Map<string, () => void>()
    rt.on('message.new', async (m) => {
      const id = String(m.payload.id)
      entered.push(id)
      await new Promise<void>((r) => releases.set(id, r))
    })
    const ws = await open(rt)
    const f = (conv: string, seq: number) => ({ type: 'message.new', payload: { id: `${conv}${seq}`, conversation_id: conv, seq } })
    ws.simulateMessage(f('b', 1))
    ws.simulateMessage(f('b', 2))
    ws.simulateMessage(f('b', 3))
    ws.simulateMessage(f('a', 1)) // queue: 4 = full
    ws.simulateMessage(f('a', 2)) // left with the server
    await settle()
    releases.get('a1')!() // queue 3: not full, but the episode lasts until half
    await settle()
    ws.simulateMessage(f('a', 3)) // also left with the server (it would overtake a2)
    await settle()
    expect(entered).toEqual(['b1', 'a1'])
    expect(sentFrames(ws, 'ack').map((x) => x.message_id)).toEqual(['a1']) // acked after its handler; nothing shed is acked
    releases.get('b1')!() // queue back to half → a quiet reconnect
    await settle()
    expect(ws.closed).toEqual({ code: 1000, reason: 'client reconnects to fetch messages it left with the server' })
    ws.simulateClose(1000, 'bye', true)
    const ws2 = MockWebSocket.latest()
    expect(ws2).not.toBe(ws)
    ws2.simulateOpen()
    ws2.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
    ws2.simulateMessage(f('a', 2)) // the server re-offers a2, a3 in order
    ws2.simulateMessage(f('a', 3))
    await settle()
    releases.get('a2')?.()
    await settle()
    expect(entered.filter((id) => id.startsWith('a'))).toEqual(['a1', 'a2', 'a3'])
    rt.disconnect()
  }, 10_000)

  it('F4: an abandoned gate-call cycle records nothing more; every conversation is recorded once', async () => {
    const texts = json<Texts>('texts.sample.json')
    const sample = json<InboxTray>('tray.sample.json')
    const cards: InboxCard[] = [0, 1, 2, 3].map((i) => ({
      ...sample.conversations[1]!,
      conversation_id: `conv_${i}`,
      preview: { ...sample.conversations[1]!.preview!, message_id: `msg_${i}` },
    }))
    const recorded = new Set<string>()
    const record = vi.fn(async (id: string, opts: { decision: string }) => {
      await sleep(30)
      recorded.add(id)
      return { id: 'd', conversation_id: id, decision: opts.decision } as unknown as ReplyDecision
    })
    const tray = vi.fn(
      async () =>
        ({
          ...sample,
          version: 1,
          invites: [],
          invites_truncated: false,
          truncated: false,
          conversations: cards.filter((c) => !recorded.has(c.conversation_id)),
        }) as InboxTray,
    )
    const client = { inbox: { tray }, decisions: { record }, groups: { dismissInvite: vi.fn() }, baseUrl: 'https://api.example.test' }
    const callModel = vi.fn(async (prompt: string) => {
      const ids = cards.map((c) => c.conversation_id).filter((id) => prompt.includes(id))
      return JSON.stringify({ decisions: ids.map((id) => ({ conversation_id: id, decision: 'defer' })) })
    })
    const loop = new ReceiveLoop({
      mode: 'gateCall',
      client: client as never,
      texts: { current: () => texts, ensure: async () => texts },
      socket: null,
      quietMs: 0,
      maxMs: 0,
      callModel,
      startTurn: async () => ({ started: false }),
      cycleTimeoutMs: 50,
    })
    await loop.start()
    loop.wake()
    await sleep(60) // the first cycle is abandoned mid-recording
    loop.wake()
    await sleep(400)
    const perConversation: Record<string, number> = {}
    for (const [id] of record.mock.calls) perConversation[id as string] = (perConversation[id as string] ?? 0) + 1
    expect(Object.values(perConversation).every((n) => n === 1)).toBe(true)
    expect(Object.keys(perConversation).sort()).toEqual(['conv_0', 'conv_1', 'conv_2', 'conv_3'])
    expect(loop.status().recentCycles.map((c) => c.outcome)[0]).toBe('abandoned')
    await loop.stop()
  })
})
