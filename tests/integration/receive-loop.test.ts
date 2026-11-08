import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReceiveLoop, type ReceiveLoopEvent, type RunRequest, type TurnAdmission, type TurnRequest } from '../../src/integration/receive-loop.js'
import type { TurnEnd } from '../../src/integration/outcome.js'
import { TurnTracker } from '../../src/integration/turn-tracker.js'
import type { InboxCard, InboxTray, ReplyDecision, Texts, TrayInvite } from '../../src/types/index.js'
import { MockWebSocket, MockWebSocketCtor, sentFrames } from '../helpers/mock-websocket.js'
import { json } from './fixtures.js'

const texts = json<Texts>('texts.sample.json')
const sample = json<InboxTray>('tray.sample.json')
const v1 = json<InboxTray>('tray.v1.sample.json')
const DIRECT = sample.conversations[0]! // owes a reply, anchor msg_nova0first00001a
const CREW = sample.conversations[1]! // "Thanks all"
const MUTED = v1.conversations[1]!
const INVITE = v1.invites![0]!

const trayOf = (conversations: InboxCard[], extra: Partial<InboxTray> = {}): InboxTray => ({
  ...sample,
  version: 1,
  conversations,
  invites: [],
  invites_truncated: false,
  truncated: false,
  ...extra,
})

async function until(condition: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const idle = () => new Promise((r) => setTimeout(r, 15))

function fakeClient() {
  const state: { tray: InboxTray | Error } = { tray: trayOf([]) }
  const tray = vi.fn(async () => {
    if (state.tray instanceof Error) throw state.tray
    return structuredClone(state.tray)
  })
  const record = vi.fn(async (conversationId: string, opts: { decision: string }) => ({ id: 'd', conversation_id: conversationId, decision: opts.decision }) as unknown as ReplyDecision)
  const dismissInvite = vi.fn(async () => ({ dismissed: true }))
  const client = { inbox: { tray }, decisions: { record }, groups: { dismissInvite }, baseUrl: 'https://api.agentchat.me' }
  return { client, state, tray, record, dismissInvite }
}

const textsSource = (value: Texts | null = texts) => ({ current: () => value, ensure: async () => value })
const answer = (entries: Array<Record<string, unknown>>) => async () => JSON.stringify({ decisions: entries })

/** A turn the test ends by hand. */
function turns() {
  const started: TurnRequest[] = []
  const ends: Array<(end: TurnEnd) => void> = []
  const startTurn = vi.fn(async (request: TurnRequest): Promise<TurnAdmission> => {
    started.push(request)
    return { started: true, done: new Promise<TurnEnd>((r) => ends.push(r)) }
  })
  return { started, ends, startTurn }
}

function gateLoop(over: Partial<ConstructorParameters<typeof ReceiveLoop>[0]> & { client: ReturnType<typeof fakeClient>['client'] }) {
  const events: ReceiveLoopEvent[] = []
  const loop = new ReceiveLoop({
    mode: 'gateCall',
    texts: textsSource(),
    socket: null,
    quietMs: 0,
    maxMs: 0,
    callModel: async () => '{"decisions": []}',
    startTurn: async () => ({ started: false }),
    onEvent: (e) => events.push(e),
    ...over,
  })
  return { loop, events }
}

beforeEach(() => MockWebSocket.reset())

describe('ReceiveLoop — gate-call mode', () => {
  it('needs callModel and startTurn; single-run needs startRun', () => {
    const { client } = fakeClient()
    expect(() => new ReceiveLoop({ mode: 'gateCall', client, texts: textsSource(), socket: null })).toThrow(/callModel/)
    expect(() => new ReceiveLoop({ mode: 'singleRun', client, texts: textsSource(), socket: null })).toThrow(/startRun/)
  })

  it('records dismiss at once, starts one turn per reply, and records reply only once the card shows the send', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT, CREW])
    const t = turns()
    const callModel = vi.fn(
      answer([
        { conversation_id: DIRECT.conversation_id, decision: 'reply', category: 'open_request' },
        { conversation_id: CREW.conversation_id, decision: 'dismiss', category: 'acknowledgement' },
      ]),
    )
    const { loop, events } = gateLoop({ client, callModel, startTurn: t.startTurn })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1, 'the turn')
    expect(callModel.mock.calls[0]![0]).toContain(texts.gate_call_preamble!)
    expect(record.mock.calls).toEqual([
      [CREW.conversation_id, { decision: 'dismiss', category: 'acknowledgement', throughMessageId: CREW.preview!.message_id }],
    ])
    const request = t.started[0]!
    expect(request).toMatchObject({
      kind: 'reply',
      conversationId: DIRECT.conversation_id,
      anchor: 'msg_nova0first00001a',
      category: 'open_request',
      prompt: `${texts.wake_instruction}\n\nconversation_id: ${DIRECT.conversation_id}`,
    })
    expect(request.signal.aborted).toBe(false)

    // The turn sent: the card shows it. The host records reply through the gate's anchor.
    state.tray = trayOf([{ ...DIRECT, you_owe_reply: false, your_last_message_at: '2026-11-08T09:11:30.000Z' }])
    t.ends[0]!({ status: 'completed', agentchatCalls: { made: 3, failed: 0 } })
    await until(() => record.mock.calls.length === 2, 'the reply record')
    expect(record.mock.calls[1]).toEqual([
      DIRECT.conversation_id,
      { decision: 'reply', category: 'open_request', throughMessageId: 'msg_nova0first00001a' },
    ])
    expect(events.some((e) => e.type === 'turn_outcome' && e.outcome.reason === 'answer_sent' && e.recorded)).toBe(true)
    expect(loop.status().counters.outcomes).toEqual({ answer_sent: 1 })
    await loop.stop()
  })

  it('a running turn holds its card out of the gate; when it ends the tray is read again', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const callModel = vi.fn(answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]))
    const { loop } = gateLoop({ client, callModel, startTurn: t.startTurn })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1)
    expect(loop.status().turns).toMatchObject([{ kind: 'reply', conversationId: DIRECT.conversation_id }])

    // A new card arrives while the turn runs: the gate sees only it.
    state.tray = trayOf([DIRECT, CREW])
    loop.wake()
    await until(() => callModel.mock.calls.length === 2)
    const second = callModel.mock.calls[1]![0] as string
    expect(second).not.toContain(DIRECT.conversation_id)
    expect(second).toContain(CREW.conversation_id)
    expect(loop.status().lastCycle).toMatchObject({ heldByTurns: 1, gated: 1 })

    // The turn fails: nothing recorded for it, and the tray is read once more.
    const reads = client.inbox.tray.mock.calls.length
    t.ends[0]!({ status: 'failed', detail: 'provider error' })
    await until(() => client.inbox.tray.mock.calls.length >= reads + 2, 'the post-turn read and the re-read')
    await idle()
    expect(record.mock.calls.filter(([id]) => id === DIRECT.conversation_id)).toEqual([])
    await loop.stop()
  })

  it('a wait timeout is not an end: no second turn starts for that conversation', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn: t.startTurn })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'still_running' })
    await idle()
    loop.wake()
    await idle()
    loop.wake()
    await idle()
    expect(t.started).toHaveLength(1)
    expect(loop.status().turns[0]).toMatchObject({ conversationId: DIRECT.conversation_id })
    expect(loop.status().turns[0]!.waitTimedOutAt).not.toBeNull()
    // The operator lets go of it: the next cycle may gate it again.
    expect(loop.releaseTurn(`conversation:${DIRECT.conversation_id}`)).toBe(true)
    await until(() => t.started.length === 2, 'a turn after release')
    await loop.stop()
  })

  it('looked and did nothing: nothing the first time, dismiss (no_action_needed) the second time for the same anchor', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn: t.startTurn, paceMs: 0 })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await until(() => loop.status().counters.outcomes.silent_first === 1)
    expect(record).not.toHaveBeenCalled()
    loop.wake() // the server's re-wake (D3)
    await until(() => t.started.length === 2)
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 3, failed: 0 } })
    await until(() => record.mock.calls.length === 1)
    expect(record.mock.calls[0]).toEqual([
      DIRECT.conversation_id,
      { decision: 'dismiss', category: 'no_action_needed', throughMessageId: 'msg_nova0first00001a' },
    ])
    await loop.stop()
  })

  it('with the AgentChat calls unknown, the second silent look records defer, not dismiss (the card stays unread)', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn: t.startTurn, paceMs: 0 })
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'completed', agentchatCalls: null })
    await until(() => loop.status().counters.outcomes.silent_first === 1)
    loop.wake()
    await until(() => t.started.length === 2)
    t.ends[1]!({ status: 'completed', agentchatCalls: null })
    await until(() => record.mock.calls.length === 1)
    expect(record.mock.calls[0]).toEqual([DIRECT.conversation_id, { decision: 'defer', throughMessageId: 'msg_nova0first00001a' }])
    await loop.stop()
  })

  it('a turn that sent and then failed: reply is recorded, so the card is not gated again', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn: t.startTurn })
    loop.wake()
    await until(() => t.started.length === 1)
    state.tray = trayOf([{ ...DIRECT, you_owe_reply: false, your_last_message_at: '2026-11-08T09:11:30.000Z' }])
    t.ends[0]!({ status: 'failed', detail: 'the runtime hit its time limit after the send' })
    await until(() => record.mock.calls.length === 1)
    expect(record.mock.calls[0]![1]).toMatchObject({ decision: 'reply', throughMessageId: 'msg_nova0first00001a' })
    await loop.stop()
  })

  it('a refused turn records nothing and schedules nothing (the server re-wakes)', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const startTurn = vi.fn(async () => ({ started: false as const, error: 'no runtime' }))
    const { loop, events } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn })
    await loop.start()
    loop.wake()
    await until(() => startTurn.mock.calls.length === 1)
    await idle()
    expect(record).not.toHaveBeenCalled()
    expect(loop.status().coalescer.state).toBe('idle')
    expect(loop.status().coalescer.cycles).toBe(1)
    expect(events.some((e) => e.type === 'turn_refused' && e.error === 'no runtime')).toBe(true)
    expect(loop.status().turns).toEqual([])
    await loop.stop()
  })

  it('invites on the tray: one invite turn each, no gate call; left pending twice → dismissed', async () => {
    const { client, state, dismissInvite } = fakeClient()
    state.tray = trayOf([], { invites: [INVITE] })
    const t = turns()
    const callModel = vi.fn(answer([]))
    const startInviteTurn = vi.fn(t.startTurn)
    const { loop } = gateLoop({ client, callModel, startTurn: async () => ({ started: false }), startInviteTurn, paceMs: 0 })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1)
    expect(callModel).not.toHaveBeenCalled()
    expect(t.started[0]).toMatchObject({ kind: 'invite', invite: INVITE, prompt: `${texts.invite_prompt}\n\ninvite_id: ${INVITE.invite_id}` })
    t.ends[0]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    await until(() => loop.status().counters.outcomes.invite_silent_first === 1)
    loop.wake()
    await until(() => t.started.length === 2)
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    await until(() => dismissInvite.mock.calls.length === 1)
    expect(dismissInvite.mock.calls[0]).toEqual([INVITE.invite_id])
    await loop.stop()
  })

  it('an invite the turn answered is left alone', async () => {
    const { client, state, dismissInvite } = fakeClient()
    state.tray = trayOf([], { invites: [INVITE] })
    const t = turns()
    const { loop } = gateLoop({ client, startTurn: t.startTurn })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1)
    state.tray = trayOf([], { invites: [] })
    t.ends[0]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await until(() => loop.status().counters.outcomes.invite_invite_answered === 1)
    expect(dismissInvite).not.toHaveBeenCalled()
    await loop.stop()
  })

  it('texts without the gate-call fields: the legacy gate wording; no texts at all: waits', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const callModel = vi.fn(answer([{ conversation_id: DIRECT.conversation_id, decision: 'dismiss' }]))
    const old = { ...texts, gate_call_preamble: undefined, gate_call_answer_format: undefined }
    const { loop } = gateLoop({ client, callModel, texts: textsSource(old) })
    await loop.start()
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', dismiss: 1 })
    expect(callModel.mock.calls[0]![0]).toMatch(/^You are triaging your AgentChat tray before any turn starts/)
    expect(record).toHaveBeenCalledTimes(1)
    await loop.stop()

    const none = gateLoop({ client, callModel, texts: textsSource(null) })
    await none.loop.start()
    none.loop.wake()
    await until(() => none.loop.status().lastCycle !== null)
    expect(none.loop.status().lastCycle).toMatchObject({ outcome: 'texts_missing' })
    await none.loop.stop()
  })

  it('only muted cards: nothing owed, no model call; tools unavailable: no model call', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([MUTED])
    const callModel = vi.fn(answer([]))
    const { loop } = gateLoop({ client, callModel })
    await loop.start()
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', cards: 1 })
    await loop.stop()

    state.tray = trayOf([DIRECT])
    const unready = gateLoop({ client, callModel, readiness: () => ({ ready: false, reason: 'the hosted tools are not registered' }) })
    await unready.loop.start()
    unready.loop.wake()
    await until(() => unready.loop.status().lastCycle !== null)
    expect(unready.loop.status().lastCycle).toMatchObject({ outcome: 'tools_unavailable', failure: 'the hosted tools are not registered' })
    expect(callModel).not.toHaveBeenCalled()
    await unready.loop.stop()
  })

  it('a tray that cannot be read: the cycle ends, nothing is scheduled', async () => {
    const { client, state } = fakeClient()
    state.tray = new Error('503 from the server')
    const { loop } = gateLoop({ client })
    await loop.start()
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    await idle()
    expect(loop.status()).toMatchObject({ lastCycle: { outcome: 'tray_failed' }, lastError: '503 from the server' })
    expect(loop.status().coalescer).toMatchObject({ state: 'idle', cycles: 1 })
    await loop.stop()
  })

  it('a truncated tray is read again after a decided cycle', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([CREW], { truncated: true })
    const callModel = vi.fn(answer([{ conversation_id: CREW.conversation_id, decision: 'dismiss' }]))
    const { loop } = gateLoop({ client, callModel })
    await loop.start()
    loop.wake()
    await until(() => callModel.mock.calls.length >= 2, 'the second read')
    state.tray = trayOf([])
    await loop.stop()
  })

  it('stop() aborts the signal handed to running turns', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn: t.startTurn })
    await loop.start()
    loop.wake()
    await until(() => t.started.length === 1)
    const stopped = loop.stop()
    expect(t.started[0]!.signal.aborted).toBe(true)
    t.ends[0]!({ status: 'failed', detail: 'interrupted' })
    await stopped
    expect(loop.status().stopped).toBe(true)
  })
})

describe('ReceiveLoop — the socket', () => {
  it('owns a RealtimeClient with ackOnReceipt and ack/heartbeat/rewake; echoes are not wakes; frames, wakes, invites and connects are', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([])
    const events: ReceiveLoopEvent[] = []
    const loop = new ReceiveLoop({
      mode: 'gateCall',
      client,
      texts: textsSource(),
      callModel: answer([]),
      startTurn: async () => ({ started: false }),
      socket: { apiKey: 'ac_key', webSocket: MockWebSocketCtor },
      handle: '@Example-Relay',
      quietMs: 0,
      maxMs: 0,
      onEvent: (e) => events.push(e),
    })
    await loop.start()
    const ws = MockWebSocket.latest()
    expect(ws.url).toBe('wss://api.agentchat.me/v1/ws')
    ws.simulateOpen()
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'hello', api_key: 'ac_key', capabilities: ['ack', 'heartbeat', 'rewake'] })
    ws.simulateMessage(json('hello-ok.v1.json'))
    await until(() => loop.status().coalescer.cycles === 1, 'the connect cycle')
    expect(loop.status().socket).toEqual({ state: 'ready', ackNegotiated: true, capabilities: ['ack', 'heartbeat', 'rewake'] })

    const frame = (id: string, sender: string) => ({ type: 'message.new', payload: { id, conversation_id: 'conv_x', sender, seq: Number(id.slice(-1)) } })
    ws.simulateMessage(frame('msg_own1', 'example-relay'))
    await idle()
    expect(events.filter((e) => e.type === 'echo')).toHaveLength(1)
    expect(loop.status().coalescer.cycles).toBe(1)
    ws.simulateMessage(frame('msg_peer2', '@example-scout'))
    await until(() => loop.status().coalescer.cycles === 2, 'a message wake')
    ws.simulateMessage(json('wake-frame.unanswered.json'))
    await until(() => loop.status().coalescer.cycles === 3, 'a wake-frame wake')
    ws.simulateMessage({ type: 'group.invite.received', payload: { invite_id: 'gri_1', group_id: 'grp_1' } })
    await until(() => loop.status().coalescer.cycles === 4, 'an invite wake')
    // Delivered on receipt, the echo included (it reached this machine); nothing else is sent.
    expect(sentFrames(ws, 'ack').map((f) => f.message_id)).toEqual(['msg_own1', 'msg_peer2'])
    expect(events.filter((e) => e.type === 'wake').map((e) => (e as { source: string }).source)).toEqual([
      'connect',
      'message',
      'wake_frame',
      'invite',
    ])
    await loop.stop()
    expect(loop.status().socket?.state).toBe('stopped')
  })

  it('learns its own handle from the tray when none is given', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([], { you: '@example-relay' })
    const loop = new ReceiveLoop({
      mode: 'singleRun',
      client,
      texts: textsSource(),
      startRun: async () => ({ status: 'completed' }),
      socket: null,
      quietMs: 0,
      maxMs: 0,
    })
    expect(loop.status().handle).toBeNull()
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(loop.status().handle).toBe('example-relay')
    await loop.stop()
  })
})

describe('ReceiveLoop — single-run mode', () => {
  function runLoop(client: ReturnType<typeof fakeClient>['client'], startRun: (r: RunRequest) => Promise<{ status: 'completed' | 'failed' | 'not_started' }>) {
    return new ReceiveLoop({ mode: 'singleRun', client, texts: textsSource(), startRun, socket: null, quietMs: 0, maxMs: 0 })
  }

  it('starts one run with the served wake text when cards are owed, and records nothing itself', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT, CREW])
    const runs: RunRequest[] = []
    const loop = runLoop(client, async (r) => {
      runs.push(r)
      return { status: 'completed' }
    })
    loop.wake()
    await until(() => runs.length === 1)
    expect(runs[0]).toMatchObject({ prompt: texts.wake_instruction, cards: 2, invites: 0 })
    await until(() => loop.status().lastCycle !== null)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'run_completed' })
    expect(record).not.toHaveBeenCalled()
    await loop.stop()
  })

  it('invites only → the invite prompt; both → both texts; empty or muted-only → no run', async () => {
    const { client, state } = fakeClient()
    const prompts: string[] = []
    const loop = runLoop(client, async (r) => {
      prompts.push(r.prompt)
      return { status: 'completed' }
    })
    state.tray = trayOf([], { invites: [INVITE] })
    loop.wake()
    await until(() => prompts.length === 1)
    state.tray = trayOf([DIRECT], { invites: [INVITE] })
    loop.wake()
    await until(() => prompts.length === 2)
    expect(prompts).toEqual([texts.invite_prompt, `${texts.wake_instruction}\n\n${texts.invite_prompt}`])
    for (const tray of [trayOf([]), trayOf([MUTED])]) {
      state.tray = tray
      const cycles = loop.status().coalescer.cycles
      loop.wake()
      await until(() => loop.status().coalescer.cycles === cycles + 1 && loop.status().coalescer.state === 'idle')
    }
    expect(prompts).toHaveLength(2)
    expect(loop.status().lastCycle?.outcome).toBe('nothing_owed')
    await loop.stop()
  })

  it('a tray that cannot be read is not an empty tray: the run starts anyway', async () => {
    const { client, state } = fakeClient()
    state.tray = new Error('timeout')
    const runs: RunRequest[] = []
    const loop = runLoop(client, async (r) => {
      runs.push(r)
      return { status: 'completed' }
    })
    loop.wake()
    await until(() => runs.length === 1)
    expect(runs[0]).toMatchObject({ prompt: texts.wake_instruction, cards: null, invites: null })
    await loop.stop()
  })

  it('one run at a time: wakes during a run earn exactly one more run', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    let release: () => void = () => undefined
    let runs = 0
    const loop = runLoop(client, async () => {
      runs += 1
      if (runs === 1) await new Promise<void>((r) => (release = r))
      return { status: 'completed' }
    })
    loop.wake()
    await until(() => runs === 1)
    loop.wake()
    loop.wake()
    loop.wake()
    await idle()
    expect(runs).toBe(1)
    release()
    await until(() => runs === 2)
    await idle()
    expect(runs).toBe(2)
    expect(loop.status().counters).toMatchObject({ runsStarted: 2, runsCompleted: 2 })
    await loop.stop()
  })

  it('a failed run is reported, not retried', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    const startRun = vi.fn(async () => ({ status: 'failed' as const, detail: 'exit 1' }))
    const loop = runLoop(client, startRun)
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    await idle()
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(loop.status()).toMatchObject({ lastCycle: { outcome: 'run_failed', failure: 'exit 1' }, counters: { runsFailed: 1 } })
    await loop.stop()
  })
})

// Keep the type import used for readers of this file.
export type { TrayInvite }

// ─── conformance/v1/turn-outcome.cases.json — single_run_invite_cases ──────

interface SingleRunInviteCase {
  name: string
  why: string
  invite: TrayInvite
  runs: Array<{ status: 'completed' | 'failed' | 'not_started'; fresh_tray: { invites: TrayInvite[]; invites_truncated: boolean } | null }>
  expect: Array<{ action: string; reason: string }>
}
const outcomeDoc = json<{ single_run_invite_cases: SingleRunInviteCase[] }>('turn-outcome.cases.json')

describe('conformance — single-run invites (turn-outcome.cases.json)', () => {
  it.each(outcomeDoc.single_run_invite_cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    // Each run: the tray it starts from holds the invite; a completed run is followed by the case's tray.
    const answers: Array<InboxTray | Error> = []
    for (const r of c.runs) {
      answers.push(trayOf([], { invites: [c.invite] }))
      if (r.status === 'completed') {
        answers.push(r.fresh_tray === null ? new Error('read failed') : trayOf([], r.fresh_tray))
      }
    }
    const tray = vi.fn(async () => {
      const next = answers.shift() ?? trayOf([])
      if (next instanceof Error) throw next
      return next
    })
    const dismissInvite = vi.fn(async () => ({ dismissed: true }))
    const record = vi.fn()
    const client = { inbox: { tray }, decisions: { record }, groups: { dismissInvite }, baseUrl: 'https://api.agentchat.me' }
    const statuses = c.runs.map((r) => r.status)
    const outcomes: Array<{ action: string; reason: string }> = []
    const loop = new ReceiveLoop({
      mode: 'singleRun',
      client: client as never,
      texts: textsSource(),
      socket: null,
      quietMs: 0,
      maxMs: 0,
      startRun: async () => ({ status: statuses.shift()! }),
      onEvent: (e) => {
        if (e.type === 'invite_outcome') outcomes.push({ action: e.outcome.action, reason: e.outcome.reason })
      },
    })
    for (let i = 0; i < c.runs.length; i++) {
      loop.wake()
      await until(() => outcomes.length === i + 1, `the outcome after run ${i + 1}`)
    }
    expect(outcomes).toEqual(c.expect)
    const dismissals = c.expect.filter((e) => e.action === 'dismiss_invite').length
    expect(dismissInvite).toHaveBeenCalledTimes(dismissals)
    expect(record).not.toHaveBeenCalled() // cards: the run's own verdicts only
    await loop.stop()
  })
})

// ─── turn slots, pacing, the truncated-tray backoff, after stop ────────────

describe('ReceiveLoop — turn slots (maxConcurrentTurns)', () => {
  const OPS = sample.conversations[2]! // owes a reply too

  it('one turn at a time by default: the rest wait, held out of the gate, and start when a slot frees', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT, OPS])
    const t = turns()
    const callModel = vi.fn(
      answer([
        { conversation_id: DIRECT.conversation_id, decision: 'reply' },
        { conversation_id: OPS.conversation_id, decision: 'reply' },
      ]),
    )
    const { loop } = gateLoop({ client, callModel, startTurn: t.startTurn })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(t.started.map((r) => (r as { conversationId: string }).conversationId)).toEqual([DIRECT.conversation_id])
    expect(loop.status().lastCycle).toMatchObject({ turnsStarted: 1, turnsQueued: 1 })
    expect(loop.status().counters).toMatchObject({ turnsActive: 1, turnsWaiting: 1 })
    // Another wake: both cards are held (running or waiting): no second model call decides them.
    loop.wake()
    await until(() => loop.status().coalescer.cycles === 2)
    await idle()
    expect(callModel).toHaveBeenCalledTimes(1)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', heldByTurns: 2 })
    // The first ends: the waiting one starts.
    t.ends[0]!({ status: 'failed', detail: 'x' })
    await until(() => t.started.length === 2, 'the queued turn')
    expect((t.started[1] as { conversationId: string }).conversationId).toBe(OPS.conversation_id)
    expect(loop.status().counters).toMatchObject({ turnsActive: 1, turnsWaiting: 0 })
    await loop.stop()
  })

  it('stop() drops waiting turns; maxConcurrentTurns must be an integer >= 1', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT, OPS])
    const t = turns()
    const { loop } = gateLoop({
      client,
      callModel: answer([
        { conversation_id: DIRECT.conversation_id, decision: 'reply' },
        { conversation_id: OPS.conversation_id, decision: 'reply' },
      ]),
      startTurn: t.startTurn,
    })
    loop.wake()
    await until(() => loop.status().counters.turnsWaiting === 1)
    const stopping = loop.stop()
    expect(loop.status().counters.turnsWaiting).toBe(0)
    expect(loop.status().turns.map((x) => (x as { conversationId?: string }).conversationId)).toEqual([DIRECT.conversation_id])
    t.ends[0]!({ status: 'failed' })
    await stopping
    expect(t.started).toHaveLength(1)
    expect(() => gateLoop({ client, maxConcurrentTurns: 0 })).toThrow(RangeError)
  })

  it('maxConcurrentTurns: 2 runs two at once', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT, OPS])
    const t = turns()
    const { loop } = gateLoop({
      client,
      maxConcurrentTurns: 2,
      callModel: answer([
        { conversation_id: DIRECT.conversation_id, decision: 'reply' },
        { conversation_id: OPS.conversation_id, decision: 'reply' },
      ]),
      startTurn: t.startTurn,
    })
    loop.wake()
    await until(() => t.started.length === 2)
    expect(loop.status().counters).toMatchObject({ turnsActive: 2, turnsWaiting: 0 })
    await loop.stop()
  })

  it('a shared tracker: a turn another loop runs keeps its card out of this gate', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT, CREW])
    const tracker = new TurnTracker()
    tracker.begin({ kind: 'reply', conversationId: DIRECT.conversation_id, anchor: 'msg_nova0first00001a' })
    const callModel = vi.fn(answer([{ conversation_id: CREW.conversation_id, decision: 'dismiss' }]))
    const { loop } = gateLoop({ client, callModel, tracker })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(callModel.mock.calls[0]![0]).not.toContain(DIRECT.conversation_id)
    expect(loop.status().lastCycle).toMatchObject({ heldByTurns: 1 })
    await loop.stop()
  })
})

describe('ReceiveLoop — D5 pacing', () => {
  it('after a silent turn the card is not gated again at that anchor; a newer message lifts it', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const callModel = vi.fn(answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]))
    const { loop } = gateLoop({ client, callModel, startTurn: t.startTurn })
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await until(() => loop.status().counters.outcomes.silent_first === 1)
    loop.wake()
    await until(() => loop.status().coalescer.cycles === 2)
    await idle()
    expect(callModel).toHaveBeenCalledTimes(1)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', paced: 1 })
    // A newer message moves the anchor: gated again.
    state.tray = trayOf([{ ...DIRECT, preview: { ...DIRECT.preview!, message_id: 'msg_newer0000001' }, last_message_id: 'msg_newer0000001' }])
    loop.wake()
    await until(() => callModel.mock.calls.length === 2, 'the gate after a newer message')
    await loop.stop()
  })

  it('an unanswered wake that names the conversation lifts its pacing, and lifts every invite pacing', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT], { invites: [INVITE] })
    const t = turns()
    const callModel = vi.fn(answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]))
    const events: ReceiveLoopEvent[] = []
    const loop = new ReceiveLoop({
      mode: 'gateCall',
      client,
      texts: textsSource(),
      callModel,
      startTurn: t.startTurn,
      maxConcurrentTurns: 2,
      socket: { apiKey: 'k', webSocket: MockWebSocketCtor },
      quietMs: 0,
      maxMs: 0,
      onEvent: (e) => events.push(e),
    })
    await loop.start()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage(json('hello-ok.v1.json'))
    await until(() => t.started.length === 2, 'a reply turn and an invite turn')
    t.ends[0]!({ status: 'completed', agentchatCalls: null })
    t.ends[1]!({ status: 'completed', agentchatCalls: null })
    await until(() => loop.status().counters.outcomes.silent_first === 1 && loop.status().counters.outcomes.invite_silent_first === 1)
    const cycles = loop.status().coalescer.cycles
    ws.simulateMessage({ type: 'message.new', payload: { id: 'msg_x9', conversation_id: 'conv_other', sender: '@example-quill', seq: 9 } })
    await until(() => loop.status().coalescer.cycles > cycles)
    await idle()
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', paced: 2 })
    ws.simulateMessage({
      type: 'wake',
      payload: { reason: 'unanswered', conversation_ids: [DIRECT.conversation_id], step: 1, at: '2026-11-08T09:01:00.000Z' },
    })
    await until(() => t.started.length === 4, 'both again after the unanswered wake')
    const wake = events.find((e) => e.type === 'wake' && e.source === 'wake_frame')
    expect(wake).toMatchObject({ reason: 'unanswered', conversationIds: [DIRECT.conversation_id] })
    await loop.stop()
  })
})

describe('ReceiveLoop — a truncated tray that cannot progress does not spin', () => {
  it('no verdict recorded and no turn started: the self-wake backs off instead of re-gating at once', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([CREW], { truncated: true })
    record.mockImplementation(async () => {
      throw new Error('500')
    })
    const callModel = vi.fn(answer([{ conversation_id: CREW.conversation_id, decision: 'dismiss' }]))
    const { loop } = gateLoop({ client, callModel })
    loop.wake()
    await new Promise((r) => setTimeout(r, 200))
    expect(callModel).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 1_000))
    expect(callModel).toHaveBeenCalledTimes(2) // after the first backoff step (1 s)
    await new Promise((r) => setTimeout(r, 1_300))
    expect(callModel).toHaveBeenCalledTimes(2) // the next step is 2 s
    await loop.stop()
  })
})

describe('ReceiveLoop — after stop, and what it reports', () => {
  it('a turn that ends after stop() still has its outcome recorded', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({ client, callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]), startTurn: t.startTurn })
    loop.wake()
    await until(() => t.started.length === 1)
    await loop.stop()
    state.tray = trayOf([{ ...DIRECT, you_owe_reply: false, your_last_message_at: '2026-11-08T09:11:30.000Z' }])
    t.ends[0]!({ status: 'completed', agentchatCalls: { made: 3, failed: 0 } })
    await until(() => record.mock.calls.length === 1, 'the reply after stop')
    expect(record.mock.calls[0]![1]).toMatchObject({ decision: 'reply', throughMessageId: 'msg_nova0first00001a' })
  })

  it('asks the server for invites on every tray read, and marks a turn running past 30 minutes', async () => {
    const { client, state, tray } = fakeClient()
    state.tray = trayOf([DIRECT])
    let clock = Date.parse('2026-11-08T09:00:00.000Z')
    const t = turns()
    const { loop } = gateLoop({
      client,
      callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]),
      startTurn: t.startTurn,
      now: () => clock,
    })
    loop.wake()
    await until(() => t.started.length === 1)
    expect(tray.mock.calls[0]).toEqual([{ waitMs: 0, limit: 50, includeInvites: true }])
    expect(loop.status().turns[0]).toMatchObject({ overdue: false })
    clock += 31 * 60_000
    expect(loop.status().turns[0]).toMatchObject({ overdue: true })
    await loop.stop()
  })
})

describe('ReceiveLoop — releaseTurn frees the slot', () => {
  it('a turn the runtime never ends: releasing it frees its slot and the waiting turn starts', async () => {
    const OPS = sample.conversations[2]!
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT, OPS])
    const started: TurnRequest[] = []
    const startTurn = vi.fn(async (request: TurnRequest): Promise<TurnAdmission> => {
      started.push(request)
      return { started: true, done: new Promise<TurnEnd>(() => undefined) } // never ends
    })
    const { loop } = gateLoop({
      client,
      callModel: answer([
        { conversation_id: DIRECT.conversation_id, decision: 'reply' },
        { conversation_id: OPS.conversation_id, decision: 'reply' },
      ]),
      startTurn,
    })
    loop.wake()
    await until(() => loop.status().counters.turnsWaiting === 1)
    expect(loop.status().counters.turnsActive).toBe(1)
    expect(loop.releaseTurn(`conversation:${DIRECT.conversation_id}`)).toBe(true)
    await until(() => started.length === 2, 'the waiting turn after the release')
    expect((started[1] as { conversationId: string }).conversationId).toBe(OPS.conversation_id)
    expect(loop.status().counters).toMatchObject({ turnsActive: 1, turnsWaiting: 0 })
    expect(record).not.toHaveBeenCalled() // the released turn records nothing
    // Released while waiting: it is dropped, nothing starts for it.
    await loop.stop()
  })

  it('a turn released while it waits for a slot never starts', async () => {
    const OPS = sample.conversations[2]!
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT, OPS])
    const t = turns()
    const { loop } = gateLoop({
      client,
      callModel: answer([
        { conversation_id: DIRECT.conversation_id, decision: 'reply' },
        { conversation_id: OPS.conversation_id, decision: 'reply' },
      ]),
      startTurn: t.startTurn,
    })
    loop.wake()
    await until(() => loop.status().counters.turnsWaiting === 1)
    expect(loop.releaseTurn(`conversation:${OPS.conversation_id}`)).toBe(true)
    expect(loop.status().counters.turnsWaiting).toBe(0) // the queued admission is dropped
    // Released, its card may be gated again (a new turn, queued behind the running one).
    await until(() => loop.status().counters.turnsWaiting === 1, 'the card gated again')
    t.ends[0]!({ status: 'failed' })
    await until(() => t.started.length === 2)
    await idle()
    // OPS started once: the re-gated turn, never the dropped admission as well.
    expect(t.started.filter((r) => (r as { conversationId?: string }).conversationId === OPS.conversation_id)).toHaveLength(1)
    await loop.stop()
  })
})

describe('ReceiveLoop — deadlines (gateCallTimeoutMs, cycleTimeoutMs) and recentCycles', () => {
  it('a gate call past its deadline fails closed: nothing recorded, its signal aborts, the next wake asks again', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([CREW])
    const signals: AbortSignal[] = []
    const callModel = vi.fn((_prompt: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal)
      return new Promise<string>(() => undefined) // never answers
    })
    const { loop } = gateLoop({ client, callModel, gateCallTimeoutMs: 30 })
    loop.wake()
    await until(() => loop.status().lastCycle !== null, 'the timed-out cycle')
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'fail_closed', failure: 'model call failed: no answer within 30 ms' })
    expect(signals[0]?.aborted).toBe(true)
    expect(record).not.toHaveBeenCalled()
    loop.wake()
    await until(() => callModel.mock.calls.length === 2, 'the retry on the next wake')
    await loop.stop()
  })

  it('a cycle stuck past cycleTimeoutMs is abandoned once, and the loop takes wakes again', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([CREW])
    let calls = 0
    const readiness = vi.fn(() => {
      calls += 1
      return calls === 1 ? new Promise<never>(() => undefined) : { ready: true as const }
    })
    const callModel = vi.fn(answer([{ conversation_id: CREW.conversation_id, decision: 'dismiss' }]))
    const { loop, events } = gateLoop({ client, callModel, readiness, cycleTimeoutMs: 40 })
    loop.wake()
    await until(() => loop.status().lastCycle !== null, 'the abandoned cycle')
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'abandoned' })
    expect(events.filter((e) => e.type === 'error' && /abandoned/.test(e.error.message))).toHaveLength(1)
    expect(loop.status().coalescer.state).not.toBe('running')
    loop.wake()
    await until(() => callModel.mock.calls.length === 1, 'a new cycle after the abandoned one')
    await until(() => loop.status().lastCycle?.outcome === 'decided')
    expect(loop.status().recentCycles.map((c) => c.outcome)).toEqual(['abandoned', 'decided'])
    await loop.stop()
  })

  it('time inside a turn admission does not count against the cycle deadline', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    const startTurn = vi.fn(async (): Promise<TurnAdmission> => {
      await new Promise((r) => setTimeout(r, 120)) // a slow runtime admitting the turn
      return { started: true, done: new Promise<TurnEnd>(() => undefined) }
    })
    const { loop } = gateLoop({
      client,
      callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]),
      startTurn,
      cycleTimeoutMs: 60,
    })
    loop.wake()
    await until(() => loop.status().lastCycle !== null, 'the cycle')
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', turnsStarted: 1 })
    await loop.stop()
  })

  it('recentCycles keeps the last 20, newest last', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([])
    const { loop } = gateLoop({ client })
    for (let i = 0; i < 23; i++) {
      loop.wake()
      await until(() => loop.status().coalescer.cycles === i + 1 && loop.status().coalescer.state === 'idle')
    }
    const recent = loop.status().recentCycles
    expect(recent).toHaveLength(20)
    expect(recent.every((c) => c.outcome === 'empty')).toBe(true)
    expect(recent.at(-1)).toBe(loop.status().lastCycle)
    await loop.stop()
  })
})
