import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReceiveLoop, replyPrompt, type ReceiveLoopEvent, type RunRequest, type TurnAdmission, type TurnRequest } from '../../src/integration/receive-loop.js'
import { buildPrompt } from '../../src/gate.js'
import type { TurnEnd } from '../../src/integration/outcome.js'
import { TurnTracker } from '../../src/integration/turn-tracker.js'
import type { InboxCard, InboxTray, ReplyDecision, Texts, TrayInvite } from '../../src/types/index.js'
import { MockWebSocket, MockWebSocketCtor, sentFrames } from '../helpers/mock-websocket.js'
import { json, raw } from './fixtures.js'

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
      // The served reply_turn_template, naming this one conversation.
      prompt: texts.reply_turn_template!.split('<conversation_id>').join(DIRECT.conversation_id),
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
    expect(loop.status().socket).toEqual({ state: 'ready', ackNegotiated: true, capabilities: ['ack', 'heartbeat', 'rewake'], intakePaused: false })

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
  runs: Array<{
    status: 'completed' | 'failed' | 'not_started'
    fresh_tray: { invites: TrayInvite[]; invites_truncated: boolean } | null
    ended_at_ms: number
  }>
  expect: Array<{ action: string; reason: string }>
}
const outcomeDoc = json<{ single_run_pace_ms: number; single_run_invite_cases: SingleRunInviteCase[] }>('turn-outcome.cases.json')

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
    let clock = 0
    const loop = new ReceiveLoop({
      mode: 'singleRun',
      client: client as never,
      texts: textsSource(),
      socket: null,
      quietMs: 0,
      maxMs: 0,
      paceMs: outcomeDoc.single_run_pace_ms,
      now: () => clock,
      startRun: async () => ({ status: statuses.shift()! }),
      onEvent: (e) => {
        if (e.type === 'invite_outcome') outcomes.push({ action: e.outcome.action, reason: e.outcome.reason })
      },
    })
    for (let i = 0; i < c.runs.length; i++) {
      clock = c.runs[i]!.ended_at_ms // the loop's clock when the run ends
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

  it('a turn gated while a refused admission hands its slot on queues behind the waiting ones', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT, CREW, OPS])
    const started: string[] = []
    const ends: Array<(end: TurnEnd) => void> = []
    const startTurn = vi.fn(async (request: TurnRequest): Promise<TurnAdmission> => {
      const id = (request as { conversationId: string }).conversationId
      started.push(id)
      if (id === CREW.conversation_id) return { started: false, error: 'busy' } // the runtime refuses this one
      return { started: true, done: new Promise<TurnEnd>((r) => ends.push(r)) }
    })
    const reply = (id: string) => ({ conversation_id: id, decision: 'reply' })
    let gates = 0
    const callModel = vi.fn(async () => {
      gates += 1
      const decisions = gates === 1 ? [reply(DIRECT.conversation_id), reply(CREW.conversation_id), reply(OPS.conversation_id)] : [reply(DIRECT.conversation_id)]
      return JSON.stringify({ decisions })
    })
    const { loop, events } = gateLoop({ client, callModel, startTurn })
    // The window, held open: after a refused admission the slot is free, and
    // the pump has not yet handed it on to the next waiting turn.
    const seam = loop as unknown as { admitInSlot: (handle: unknown, admit: () => Promise<boolean>) => Promise<boolean> }
    const admitInSlot = seam.admitInSlot.bind(loop)
    let handOn!: () => void
    const held = new Promise<void>((resolve) => (handOn = resolve))
    seam.admitInSlot = async (handle, admit) => {
      const ok = await admitInSlot(handle, admit)
      if (!ok) await held
      return ok
    }
    loop.wake()
    await until(() => loop.status().lastCycle !== null, 'the first cycle')
    expect(started).toEqual([DIRECT.conversation_id]) // CREW and OPS wait, in that order
    expect(loop.status().counters.turnsWaiting).toBe(2)
    ends[0]!({ status: 'failed', detail: 'x' }) // DIRECT ends: CREW gets the slot and is refused
    await until(() => events.some((e) => e.type === 'turn_refused'), "CREW's refusal")
    await until(() => loop.status().counters.turnsActive === 0, 'the freed slot')
    loop.wake() // a cycle gates DIRECT again while OPS still waits
    await until(() => loop.status().recentCycles.length === 2, 'the second cycle')
    await idle()
    expect(callModel).toHaveBeenCalledTimes(2)
    // DIRECT queued behind OPS, and the free slot went to OPS at once.
    expect(started).toEqual([DIRECT.conversation_id, CREW.conversation_id, OPS.conversation_id])
    expect(loop.status().counters).toMatchObject({ turnsActive: 1, turnsWaiting: 1 })
    handOn() // the held pump goes on: the slot is taken, nothing more starts
    await idle()
    expect(started).toEqual([DIRECT.conversation_id, CREW.conversation_id, OPS.conversation_id])
    expect(loop.status().counters).toMatchObject({ turnsActive: 1, turnsWaiting: 1 }) // DIRECT waits behind OPS
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

describe('ReceiveLoop — dismissIgnoredInvites', () => {
  it('false: a run-ignored invite is never dismissed and no outcome is recorded for it', async () => {
    const { client, state, dismissInvite, tray } = fakeClient()
    state.tray = trayOf([], { invites: [INVITE] })
    let runs = 0
    const events: ReceiveLoopEvent[] = []
    const loop = new ReceiveLoop({
      mode: 'singleRun',
      client,
      texts: textsSource(),
      socket: null,
      quietMs: 0,
      maxMs: 0,
      dismissIgnoredInvites: false,
      startRun: async () => {
        runs += 1
        return { status: 'completed' }
      },
      onEvent: (e) => events.push(e),
    })
    for (let i = 1; i <= 3; i++) {
      loop.wake()
      await until(() => runs === i && loop.status().coalescer.state === 'idle', `run ${i}`)
    }
    await idle()
    expect(dismissInvite).not.toHaveBeenCalled()
    expect(events.filter((e) => e.type === 'invite_outcome')).toEqual([])
    expect(tray).toHaveBeenCalledTimes(3) // no post-run reads
    await loop.stop()
  })

  it('default (true): dismissed after the second completed run, a pacing window later', async () => {
    const { client, state, dismissInvite } = fakeClient()
    state.tray = trayOf([], { invites: [INVITE] })
    let runs = 0
    let clock = 0
    const loop = new ReceiveLoop({
      mode: 'singleRun',
      client,
      texts: textsSource(),
      socket: null,
      quietMs: 0,
      maxMs: 0,
      now: () => clock,
      startRun: async () => {
        runs += 1
        return { status: 'completed' }
      },
    })
    for (let i = 1; i <= 2; i++) {
      clock = (i - 1) * 61_000
      loop.wake()
      await until(() => runs === i && loop.status().coalescer.state === 'idle', `run ${i}`)
    }
    await until(() => dismissInvite.mock.calls.length === 1)
    await loop.stop()
  })
})

describe('ReceiveLoop — invite turns need known calls to dismiss', () => {
  it('two silent invite turns with unknown call counts dismiss nothing (silent_unconfirmed)', async () => {
    const { client, state, dismissInvite } = fakeClient()
    state.tray = trayOf([], { invites: [INVITE] })
    const t = turns()
    const { loop } = gateLoop({ client, startTurn: t.startTurn, paceMs: 0 })
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'completed', agentchatCalls: null })
    await until(() => loop.status().counters.outcomes.invite_silent_first === 1)
    loop.wake()
    await until(() => t.started.length === 2)
    t.ends[1]!({ status: 'completed', agentchatCalls: null })
    await until(() => loop.status().counters.outcomes.invite_silent_unconfirmed === 1)
    expect(dismissInvite).not.toHaveBeenCalled()
    await loop.stop()
  })
})

describe('ReceiveLoop — stop() mid-gate, Infinity deadlines', () => {
  it('stop() during the gate records no further verdict; the cards stay for the next start', async () => {
    const OPS = sample.conversations[2]!
    const { client, state, record } = fakeClient()
    state.tray = trayOf([DIRECT, CREW, OPS])
    let entered = 0
    record.mockImplementation(async (conversationId: string, opts: { decision: string }) => {
      entered += 1
      await new Promise((r) => setTimeout(r, 30))
      return { id: 'd', conversation_id: conversationId, decision: opts.decision } as unknown as ReplyDecision
    })
    const callModel = vi.fn(
      answer([DIRECT, CREW, OPS].map((c) => ({ conversation_id: c.conversation_id, decision: 'dismiss' }))),
    )
    const { loop } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => entered === 1, 'the first verdict under way')
    await loop.stop()
    await new Promise((r) => setTimeout(r, 80))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('Infinity turns a deadline off, like 0; a negative value is an error', () => {
    const { client } = fakeClient()
    expect(() => gateLoop({ client, gateCallTimeoutMs: Number.POSITIVE_INFINITY, cycleTimeoutMs: Number.POSITIVE_INFINITY })).not.toThrow()
    expect(() => gateLoop({ client, gateCallTimeoutMs: 0, cycleTimeoutMs: 0 })).not.toThrow()
    expect(() => gateLoop({ client, cycleTimeoutMs: -1 })).toThrow(RangeError)
  })
})

// ─── the gate in chunks (contract v1 §3.6), and the reply turn's prompt ────

describe('ReceiveLoop — the gate in chunks (gateChunkSize)', () => {
  const cardAt = (i: number): InboxCard => {
    const n = String(i).padStart(2, '0')
    return { ...DIRECT, conversation_id: `conv_chunk${n}`, preview: { ...DIRECT.preview!, message_id: `msg_chunk${n}` } }
  }
  const cardsUpTo = (n: number): InboxCard[] => Array.from({ length: n }, (_, i) => cardAt(i))
  const ids = (cards: InboxCard[]) => cards.map((c) => c.conversation_id)
  /** The card ids a gate prompt carries, in order. */
  const idsIn = (prompt: string) => [...prompt.matchAll(/"conversation_id": "(conv_[^"]+)"/g)].map((m) => m[1]!)
  const allAs = (decision: string, prompt: string) =>
    JSON.stringify({ decisions: idsIn(prompt).map((id) => ({ conversation_id: id, decision })) })
  const chunkEvents = (events: ReceiveLoopEvent[]) =>
    events.filter((e): e is Extract<ReceiveLoopEvent, { type: 'gate_chunk' }> => e.type === 'gate_chunk')
  /** Fake clock (`vi.useFakeTimers()`): time moves only here, in steps, until the condition holds. */
  async function untilFake(condition: () => boolean, what: string, stepMs = 10, maxMs = 120_000): Promise<void> {
    for (let t = 0; t <= maxMs; t += stepMs) {
      if (condition()) return
      await vi.advanceTimersByTimeAsync(stepMs)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  /** A model call that answers after `ms` of the (fake) clock. */
  const answersAfter = (ms: number, decide: (prompt: string) => string) => (prompt: string) =>
    new Promise<string>((r) => setTimeout(() => r(decide(prompt)), ms))

  afterEach(() => vi.useRealTimers())

  it('a 50-card tray is gated in five calls of 10; a cut-off answer in chunk 3 leaves only its 10 cards undecided', async () => {
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(50)
    state.tray = trayOf(cards)
    const prompts: string[] = []
    const callModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      const full = allAs('dismiss', prompt)
      // Chunk 3's answer stops mid-way, as an answer cut at the token cap does.
      return prompts.length === 3 ? full.slice(0, Math.floor(full.length / 2)) : full
    })
    const { loop, events } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().lastCycle !== null, 'the cycle')
    expect(callModel).toHaveBeenCalledTimes(5)
    // Each chunk's prompt is the §3.6 prompt for its own cards, in tray order, N = 10.
    for (let k = 0; k < 5; k++) {
      expect(prompts[k]).toBe(buildPrompt(trayOf(cards.slice(k * 10, k * 10 + 10)), { texts }))
      expect(prompts[k]).toContain('Your tray, as the server built it: 10 conversations.')
    }
    // Chunks 1, 2, 4 and 5 recorded, each through its card's anchor; chunk 3's cards stay on the tray.
    expect(record.mock.calls.map(([id]) => id)).toEqual(ids([...cards.slice(0, 20), ...cards.slice(30)]))
    expect(record.mock.calls[0]).toEqual(['conv_chunk00', { decision: 'dismiss', category: undefined, throughMessageId: 'msg_chunk00' }])
    const failure = '1 of 5 gate chunks failed; chunk 3: no usable verdicts in the answer'
    expect(loop.status().lastCycle).toMatchObject({
      outcome: 'decided',
      cards: 50,
      gated: 50,
      dismiss: 40,
      recorded: 40,
      undecided: 10,
      chunksOk: 4,
      chunksFailed: 1,
      failure,
    })
    expect(chunkEvents(events).map((e) => [e.index, e.of, e.cards, e.outcome, e.undecided])).toEqual([
      [1, 5, 10, 'decided', 0],
      [2, 5, 10, 'decided', 0],
      [3, 5, 10, 'fail_closed', 10],
      [4, 5, 10, 'decided', 0],
      [5, 5, 10, 'decided', 0],
    ])
    expect(chunkEvents(events)[2]!.failure).toBe('no usable verdicts in the answer')
    expect(loop.status().counters).toMatchObject({ chunksOk: 4, chunksFailed: 1 })
    expect(loop.status().lastError).toBe(failure)
    await loop.stop()
  })

  it('a tray of 10 cards or fewer is one call with exactly the prompt of a single gate call (gate-prompt.expected.txt)', async () => {
    const { client, state } = fakeClient()
    const prompts: string[] = []
    const callModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return allAs('dismiss', prompt)
    })
    const { loop, events } = gateLoop({ client, callModel })

    state.tray = trayOf(sample.conversations)
    loop.wake()
    await until(() => loop.status().coalescer.cycles === 1 && loop.status().coalescer.state === 'idle', 'the sample tray')
    expect(prompts).toHaveLength(1)
    expect(prompts[0] + '\n').toBe(raw('gate-prompt.expected.txt'))

    const ten = cardsUpTo(10)
    state.tray = trayOf(ten)
    loop.wake()
    await until(() => loop.status().coalescer.cycles === 2 && loop.status().coalescer.state === 'idle', 'the 10-card tray')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toBe(buildPrompt(trayOf(ten), { texts }))
    expect(prompts[1]).toContain('Card 10 of 10')
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', gated: 10, chunksOk: 1, chunksFailed: 0, failure: null })
    expect(chunkEvents(events).map((e) => [e.index, e.of, e.cards])).toEqual([
      [1, 1, 4],
      [1, 1, 10],
    ])
    // Each event names its cycle: the second cycle's is a different, larger number.
    const [first, second] = chunkEvents(events).map((e) => e.cycle)
    expect(second!).toBeGreaterThan(first!)
    await loop.stop()
  })

  it('11 cards: two calls, 10 and 1, each numbered for its own chunk; gateChunkSize changes the split', async () => {
    const { client, state } = fakeClient()
    const eleven = cardsUpTo(11)
    state.tray = trayOf(eleven)
    const prompts: string[] = []
    const callModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return allAs('dismiss', prompt)
    })
    const { loop } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(prompts.map(idsIn)).toEqual([ids(eleven.slice(0, 10)), ids(eleven.slice(10))])
    expect(prompts[1]).toBe(buildPrompt(trayOf(eleven.slice(10)), { texts }))
    expect(prompts[1]).toContain('Your tray, as the server built it: 1 conversation.')
    expect(prompts[1]).toContain('Card 1 of 1\n')
    await loop.stop()

    for (const [size, split] of [
      [4, [4, 4, 3]],
      [1, Array<number>(11).fill(1)],
      [50, [11]],
    ] as const) {
      const other = fakeClient()
      other.state.tray = trayOf(eleven)
      const seen: string[] = []
      const each = gateLoop({
        client: other.client,
        gateChunkSize: size,
        callModel: async (prompt: string) => {
          seen.push(prompt)
          return allAs('dismiss', prompt)
        },
      })
      each.loop.wake()
      await until(() => each.loop.status().lastCycle !== null, `gateChunkSize ${size}`)
      expect(seen.map((p) => idsIn(p).length)).toEqual(split)
      expect(other.record).toHaveBeenCalledTimes(11)
      await each.loop.stop()
    }
  })

  it('gateChunkSize must be an integer from 1 to 50', () => {
    const { client } = fakeClient()
    for (const bad of [0, 51, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
      expect(() => gateLoop({ client, gateChunkSize: bad }), String(bad)).toThrow(RangeError)
    }
    for (const ok of [1, 10, 50]) expect(() => gateLoop({ client, gateChunkSize: ok })).not.toThrow()
    expect(() => gateLoop({ client, gateChunkSize: 0 })).toThrow('ReceiveLoop: gateChunkSize must be an integer from 1 to 50')
  })

  it('every chunk fails: fail_closed, nothing recorded, the count of failed chunks in the summary', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf(cardsUpTo(15))
    const callModel = vi.fn(async () => 'I would dismiss most of these.')
    const { loop } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(callModel).toHaveBeenCalledTimes(2)
    expect(record).not.toHaveBeenCalled()
    expect(loop.status().lastCycle).toMatchObject({
      outcome: 'fail_closed',
      gated: 15,
      undecided: 15,
      chunksOk: 0,
      chunksFailed: 2,
      failure: '2 of 2 gate chunks failed; chunk 1: no usable verdicts in the answer',
    })
    await loop.stop()
  })

  it('replies from several chunks: the turns start after the last chunk, in tray order', async () => {
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(21)
    state.tray = trayOf(cards)
    const wanted = new Set(['conv_chunk00', 'conv_chunk15', 'conv_chunk20'])
    const callModel = vi.fn(async (prompt: string) =>
      JSON.stringify({
        decisions: idsIn(prompt).map((id) => ({ conversation_id: id, decision: wanted.has(id) ? 'reply' : 'dismiss' })),
      }),
    )
    const callsAtAdmission: number[] = []
    const t = turns()
    const startTurn = vi.fn(async (request: TurnRequest) => {
      callsAtAdmission.push(callModel.mock.calls.length)
      return t.startTurn(request)
    })
    const { loop } = gateLoop({ client, callModel, startTurn, maxConcurrentTurns: 3 })
    loop.wake()
    await until(() => t.started.length === 3, 'three turns')
    expect(t.started.map((r) => (r as { conversationId: string }).conversationId)).toEqual([...wanted])
    expect(callsAtAdmission).toEqual([3, 3, 3]) // every chunk was gated before the first turn started
    expect(record).toHaveBeenCalledTimes(18)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', reply: 3, dismiss: 18, turnsStarted: 3, chunksOk: 3 })
    await loop.stop()
  })

  it('a card whose turn began while an earlier chunk was gated is held out of its own chunk', async () => {
    const { client, state } = fakeClient()
    const cards = cardsUpTo(20)
    state.tray = trayOf(cards)
    const tracker = new TurnTracker()
    const prompts: string[] = []
    const callModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      // Another holder of the shared tracker starts a turn for card 12 meanwhile.
      if (prompts.length === 1) tracker.begin({ kind: 'reply', conversationId: 'conv_chunk12', anchor: 'msg_chunk12' })
      return allAs('dismiss', prompt)
    })
    const { loop } = gateLoop({ client, callModel, tracker })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(prompts).toHaveLength(2)
    expect(idsIn(prompts[1]!)).toEqual(ids(cards.slice(10)).filter((id) => id !== 'conv_chunk12'))
    expect(prompts[1]).toContain('Your tray, as the server built it: 9 conversations.')
    expect(loop.status().lastCycle).toMatchObject({ gated: 19, heldByTurns: 1, dismiss: 19, chunksOk: 2 })
    await loop.stop()
  })

  it('each chunk has its own deadline: a chunk past it fails closed alone; the next one gets a fresh signal', async () => {
    vi.useFakeTimers()
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(21)
    state.tray = trayOf(cards)
    const signals: AbortSignal[] = []
    const abortedAtCall: boolean[] = []
    const answer = answersAfter(5_000, (prompt) => allAs('dismiss', prompt))
    const callModel = vi.fn((prompt: string, options?: { signal?: AbortSignal }) => {
      signals.push(options!.signal!)
      abortedAtCall.push(options!.signal!.aborted)
      if (signals.length === 2) return new Promise<string>(() => undefined) // chunk 2 never answers
      return answer(prompt)
    })
    const startedAt = Date.now()
    // Each call 5 s against an 8 s deadline: 5 + 8 + 5 s in all, past any one deadline.
    const { loop } = gateLoop({ client, callModel, gateCallTimeoutMs: 8_000 })
    loop.wake()
    await untilFake(() => loop.status().lastCycle !== null, 'the cycle', 100)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(18_000)
    expect(callModel).toHaveBeenCalledTimes(3)
    expect(abortedAtCall).toEqual([false, false, false])
    expect(signals.map((s) => s.aborted)).toEqual([false, true, false])
    expect(record.mock.calls.map(([id]) => id)).toEqual(ids([...cards.slice(0, 10), ...cards.slice(20)]))
    expect(loop.status().lastCycle).toMatchObject({
      outcome: 'decided',
      recorded: 11,
      undecided: 10,
      chunksOk: 2,
      chunksFailed: 1,
      failure: '1 of 3 gate chunks failed; chunk 2: model call failed: no answer within 8000 ms',
    })
    await loop.stop()
  })

  it('stop() during a chunk: its call aborts, no later chunk is called, earlier verdicts stay recorded, no turn starts', async () => {
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(30)
    state.tray = trayOf(cards)
    const signals: AbortSignal[] = []
    const callModel = vi.fn((prompt: string, options?: { signal?: AbortSignal }) => {
      signals.push(options!.signal!)
      if (signals.length === 2) return new Promise<string>(() => undefined) // stop() comes while chunk 2 is out
      return Promise.resolve(
        JSON.stringify({
          decisions: idsIn(prompt).map((id) => ({ conversation_id: id, decision: id === 'conv_chunk00' ? 'reply' : 'dismiss' })),
        }),
      )
    })
    const t = turns()
    const { loop } = gateLoop({ client, callModel, startTurn: t.startTurn })
    loop.wake()
    await until(() => signals.length === 2, 'chunk 2 under way')
    await loop.stop()
    await idle()
    expect(signals[1]!.aborted).toBe(true)
    expect(callModel).toHaveBeenCalledTimes(2)
    expect(record.mock.calls.map(([id]) => id)).toEqual(ids(cards.slice(1, 10)))
    expect(t.startTurn).not.toHaveBeenCalled() // chunk 1's reply waits for the next start
    // The call the stop cut short is not a failed chunk: the cycle is abandoned.
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'abandoned', gated: 10, reply: 1, dismiss: 9, recorded: 9, chunksOk: 1, chunksFailed: 0, failure: null })
    expect(loop.status().counters).toMatchObject({ chunksOk: 1, chunksFailed: 0 })
  })

  it('stop() while a chunk records: the verdicts cut short count as undecided, once; gated is the sum of the outcomes', async () => {
    vi.useFakeTimers()
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(20)
    state.tray = trayOf(cards)
    let chunk2Entered = 0
    record.mockImplementation(async (conversationId: string, opts: { decision: string }) => {
      if (conversationId >= 'conv_chunk10') {
        chunk2Entered += 1
        await new Promise((r) => setTimeout(r, 1_000)) // chunk 2's records are slow
      }
      return { id: 'd', conversation_id: conversationId, decision: opts.decision } as unknown as ReplyDecision
    })
    const { loop, events } = gateLoop({ client, callModel: async (prompt: string) => allAs('dismiss', prompt) })
    loop.wake()
    await untilFake(() => chunk2Entered === 1, "chunk 2's first record under way", 1)
    const stopping = loop.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await stopping
    // Chunk 1: 10 recorded. Chunk 2: the record under way finishes; the other 9 stay undecided.
    expect(record).toHaveBeenCalledTimes(11)
    const summary = loop.status().lastCycle!
    expect(summary).toMatchObject({ outcome: 'abandoned', gated: 20, dismiss: 11, undecided: 9, recorded: 11, chunksOk: 2, chunksFailed: 0 })
    expect(summary.reply + summary.dismiss + summary.defer + summary.undecided).toBe(summary.gated)
    expect(chunkEvents(events).map((e) => [e.index, e.outcome, e.undecided])).toEqual([
      [1, 'decided', 0],
      [2, 'decided', 9],
    ])
  })

  it('a cycle the watchdog abandons while a chunk records reports and counts no chunk after its summary', async () => {
    vi.useFakeTimers()
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(20)
    state.tray = trayOf(cards)
    let slow = true
    record.mockImplementation(async (conversationId: string, opts: { decision: string }) => {
      // Chunk 2's records are slow; time inside records counts against the cycle deadline.
      if (slow && conversationId >= 'conv_chunk10') await new Promise((r) => setTimeout(r, 6_000))
      return { id: 'd', conversation_id: conversationId, decision: opts.decision } as unknown as ReplyDecision
    })
    const callModel = vi.fn(async (prompt: string) => allAs('dismiss', prompt))
    const { loop, events } = gateLoop({ client, callModel, cycleTimeoutMs: 10_000 })
    loop.wake()
    await untilFake(() => loop.status().lastCycle !== null, 'the abandoned cycle', 100)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'abandoned' })
    // The record under way at the abandonment ends later; the abandoned work then finishes.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(record).toHaveBeenCalledTimes(12) // chunk 1's 10, then chunk 2's first two
    expect(callModel).toHaveBeenCalledTimes(2)
    const abandonedAt = events.findIndex((e) => e.type === 'cycle')
    expect(events.slice(abandonedAt + 1).filter((e) => e.type === 'gate_chunk' || e.type === 'cycle')).toEqual([])
    expect(chunkEvents(events).map((e) => e.index)).toEqual([1])
    expect(loop.status().counters).toMatchObject({ chunksOk: 1, chunksFailed: 0 })
    expect(loop.status().recentCycles).toHaveLength(1)

    // The next cycle's chunks carry their own cycle.
    slow = false
    state.tray = trayOf(cards.slice(12))
    loop.wake()
    await untilFake(() => loop.status().recentCycles.length === 2, 'the next cycle', 100)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', gated: 8, chunksOk: 1 })
    const [abandoned, next] = chunkEvents(events).map((e) => e.cycle)
    expect(next!).toBeGreaterThan(abandoned!)
    await loop.stop()
  })

  it('a cycle abandoned before stop() emits no second summary when its work ends after the stop', async () => {
    vi.useFakeTimers()
    const { client, state, record } = fakeClient()
    state.tray = trayOf(cardsUpTo(20))
    record.mockImplementation(async (conversationId: string, opts: { decision: string }) => {
      if (conversationId >= 'conv_chunk10') await new Promise((r) => setTimeout(r, 6_000))
      return { id: 'd', conversation_id: conversationId, decision: opts.decision } as unknown as ReplyDecision
    })
    const { loop, events } = gateLoop({ client, callModel: async (prompt: string) => allAs('dismiss', prompt), cycleTimeoutMs: 10_000 })
    loop.wake()
    await untilFake(() => loop.status().lastCycle !== null, 'the abandoned cycle', 100)
    await loop.stop()
    await vi.advanceTimersByTimeAsync(30_000) // the abandoned work ends after the stop
    expect(events.filter((e) => e.type === 'cycle').map((e) => (e as { summary: { outcome: string } }).summary.outcome)).toEqual(['abandoned'])
    expect(chunkEvents(events)).toHaveLength(1)
  })

  it('an abandoned cycle (watchdog, gate deadline off) stops between chunks: the call in flight aborts, no later chunk is called', async () => {
    vi.useFakeTimers()
    const { client, state, record } = fakeClient()
    const cards = cardsUpTo(30)
    state.tray = trayOf(cards)
    const signals: AbortSignal[] = []
    const answer = answersAfter(6_000, (prompt) => allAs('dismiss', prompt))
    const callModel = vi.fn((prompt: string, options?: { signal?: AbortSignal }) => {
      signals.push(options!.signal!)
      return answer(prompt)
    })
    // With no gate deadline the watchdog is the gate calls' only bound: they
    // count against the cycle. Calls of 6 s against 10 s: abandoned in chunk 2.
    const { loop } = gateLoop({ client, callModel, gateCallTimeoutMs: 0, cycleTimeoutMs: 10_000 })
    loop.wake()
    await untilFake(() => loop.status().lastCycle !== null, 'the abandoned cycle', 100)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'abandoned' })
    expect(callModel).toHaveBeenCalledTimes(2)
    expect(signals[1]!.aborted).toBe(true)
    expect(record.mock.calls.map(([id]) => id)).toEqual(ids(cards.slice(0, 10)))
    await loop.stop()
  })

  it('time inside gate calls that have a deadline does not count against the cycle deadline', async () => {
    vi.useFakeTimers()
    const { client, state, record } = fakeClient()
    state.tray = trayOf(cardsUpTo(30))
    const callModel = vi.fn(answersAfter(6_000, (prompt) => allAs('dismiss', prompt)))
    // Three calls of 6 s (18 s) are far past a 10 s cycle deadline; each is bounded by its own 60 s deadline.
    const { loop } = gateLoop({ client, callModel, gateCallTimeoutMs: 60_000, cycleTimeoutMs: 10_000 })
    loop.wake()
    await untilFake(() => loop.status().lastCycle !== null, 'the cycle', 100)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', chunksOk: 3, recorded: 30 })
    expect(record).toHaveBeenCalledTimes(30)
    await loop.stop()
  })

  it('a chunk of muted cards only costs no call: 10 owed then 3 muted is one call; muted cards with owed ones ride along', async () => {
    const mutedAt = (i: number): InboxCard => ({ ...cardAt(i), muted: true, you_owe_reply: false })
    const { client, state, record } = fakeClient()
    const owed = cardsUpTo(10)
    state.tray = trayOf([...owed, mutedAt(10), mutedAt(11), mutedAt(12)])
    const prompts: string[] = []
    const callModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return allAs('dismiss', prompt)
    })
    const { loop, events } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(prompts.map(idsIn)).toEqual([ids(owed)])
    expect(record).toHaveBeenCalledTimes(10)
    // The muted chunk is left as a nothing_owed cycle leaves its cards: not gated, not undecided.
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', cards: 13, gated: 10, undecided: 0, chunksOk: 1, chunksFailed: 0 })
    expect(chunkEvents(events).map((e) => [e.index, e.of, e.cards])).toEqual([[1, 2, 10]])
    await loop.stop()

    // Muted cards in a chunk with an owed card are gated with it, as in one call.
    const mixed = fakeClient()
    const tray = [...cardsUpTo(9), mutedAt(9), cardAt(10), mutedAt(11), mutedAt(12)]
    mixed.state.tray = trayOf(tray)
    const seen: string[] = []
    const other = gateLoop({
      client: mixed.client,
      callModel: async (prompt: string) => {
        seen.push(prompt)
        return allAs('dismiss', prompt)
      },
    })
    other.loop.wake()
    await until(() => other.loop.status().lastCycle !== null)
    expect(seen.map(idsIn)).toEqual([ids(tray.slice(0, 10)), ids(tray.slice(10))])
    await other.loop.stop()
  })
})

describe('ReceiveLoop — the reply turn prompt (reply_turn_template)', () => {
  const TEMPLATE =
    'You were woken by AgentChat for one conversation: <conversation_id>. Answer only this conversation; leave the rest of your tray to the host. Read it with agentchat_get_conversation (conversation_id <conversation_id>).'

  async function promptFor(served: Texts): Promise<string> {
    const { client, state } = fakeClient()
    state.tray = trayOf([DIRECT])
    const t = turns()
    const { loop } = gateLoop({
      client,
      texts: textsSource(served),
      callModel: answer([{ conversation_id: DIRECT.conversation_id, decision: 'reply' }]),
      startTurn: t.startTurn,
    })
    loop.wake()
    await until(() => t.started.length === 1, 'the reply turn')
    await loop.stop()
    return t.started[0]!.prompt
  }

  it('starts from the served template, every <conversation_id> replaced by the card id', async () => {
    const prompt = await promptFor({ ...texts, reply_turn_template: TEMPLATE })
    expect(prompt).toBe(TEMPLATE.split('<conversation_id>').join(DIRECT.conversation_id))
    expect(prompt).not.toContain('<conversation_id>')
    expect(prompt).not.toContain(texts.wake_instruction)
    expect(replyPrompt({ ...texts, reply_turn_template: TEMPLATE }, 'conv_$&x')).toBe(TEMPLATE.split('<conversation_id>').join('conv_$&x'))
  })

  it('without the field (an older server, cached texts), the wake instruction and the conversation id line', async () => {
    const legacy = `${texts.wake_instruction.trim()}\n\nconversation_id: ${DIRECT.conversation_id}`
    const { reply_turn_template: _absent, ...old } = { ...texts, reply_turn_template: TEMPLATE }
    expect(await promptFor(old as Texts)).toBe(legacy)
    // No usable value counts as absent, as for every served text: empty, blank, not a string.
    for (const none of ['', '   ', 42 as unknown as string, null as unknown as string]) {
      expect(await promptFor({ ...texts, reply_turn_template: none }), JSON.stringify(none)).toBe(legacy)
    }
    expect(replyPrompt({ wake_instruction: texts.wake_instruction }, DIRECT.conversation_id)).toBe(legacy)
  })

  it('a served template that names no <conversation_id>: the template, then a conversation_id line (never the wake instruction)', async () => {
    const plain = '  Answer the one conversation this run was started for, and leave the rest of your tray alone.  '
    const expected = `${plain.trim()}\n\nconversation_id: ${DIRECT.conversation_id}`
    expect(await promptFor({ ...texts, reply_turn_template: plain })).toBe(expected)
    expect(replyPrompt({ ...texts, reply_turn_template: plain }, DIRECT.conversation_id)).toBe(expected)
    expect(expected).not.toContain(texts.wake_instruction)
  })

  it('invite turns still start from the invite prompt', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([], { invites: [INVITE] })
    const t = turns()
    const { loop } = gateLoop({ client, texts: textsSource({ ...texts, reply_turn_template: TEMPLATE }), startTurn: t.startTurn })
    loop.wake()
    await until(() => t.started.length === 1)
    expect(t.started[0]!.prompt).toBe(`${texts.invite_prompt}\n\ninvite_id: ${INVITE.invite_id}`)
    await loop.stop()
  })
})
