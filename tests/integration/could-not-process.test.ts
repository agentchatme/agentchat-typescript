import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../../src/client.js'
import { buildPrompt } from '../../src/gate.js'
import {
  Pacer,
  ReceiveLoop,
  conversationRunPrompt,
  type ReceiveLoopEvent,
  type ReceiveLoopOptions,
  type RunEnd,
  type RunRequest,
  type TurnAdmission,
  type TurnRequest,
} from '../../src/integration/receive-loop.js'
import type { TurnEnd } from '../../src/integration/outcome.js'
import type {
  InboxCard,
  InboxTray,
  ProcessingFailureAction,
  ReplyDecision,
  ReportProcessingFailureOptions,
  Texts,
} from '../../src/types/index.js'
import { MockWebSocket, MockWebSocketCtor } from '../helpers/mock-websocket.js'
import { json } from './fixtures.js'

// Could not process (contract v1, additive): conversation runs in single-run
// mode, the gate-chunk split, and the failure report with the server's answer.

const served = json<Texts>('texts.sample.json')
/** The same texts as an older server served them: no conversation runs. */
const { conversation_run_template: _runs, ...oldTexts } = served
const sample = json<InboxTray>('tray.sample.json')
const v1 = json<InboxTray>('tray.v1.sample.json')
const INVITE = v1.invites![0]!
const TEMPLATE =
  'AgentChat started this run for ONE conversation, <conversation_id>: open it, answer it if it needs an answer, record your verdict for <conversation_id>, and leave every other conversation alone.'
/** The served texts of a server with conversation runs. */
const texts: Texts = { ...served, conversation_run_template: TEMPLATE }
const NOTE = '[Hidden from you: this message from @example-nova could not be processed on your side, so it is not shown.]'

const card = (id: string, anchor: string, extra: Partial<InboxCard> = {}): InboxCard => ({
  ...sample.conversations[0]!,
  conversation_id: id,
  preview: { ...sample.conversations[0]!.preview!, message_id: anchor },
  ...extra,
})
const P = card('conv_poison0001', 'msg_poison03') // the card the runtime's AI cannot process
const A = card('conv_alpha00001', 'msg_alpha001')
const B = card('conv_bravo00001', 'msg_bravo001')

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
const briefly = () => new Promise((r) => setTimeout(r, 15))

const answer = (action: ProcessingFailureAction['action'], extra: Partial<ProcessingFailureAction> = {}): ProcessingFailureAction => ({
  action,
  attempts: 1,
  hidden_message_ids: [],
  paused_until: null,
  ...extra,
})

function fakeClient(answers: Array<ProcessingFailureAction | Error> = []) {
  const state: { tray: InboxTray | Error } = { tray: trayOf([]) }
  const tray = vi.fn(async () => {
    if (state.tray instanceof Error) throw state.tray
    return structuredClone(state.tray)
  })
  const record = vi.fn(async (conversationId: string, opts: { decision: string }) => ({ id: 'd', conversation_id: conversationId, decision: opts.decision }) as unknown as ReplyDecision)
  const dismissInvite = vi.fn(async () => ({ dismissed: true }))
  const report = vi.fn(async (_conversationId: string, _opts: ReportProcessingFailureOptions): Promise<ProcessingFailureAction> => {
    const next = answers.shift() ?? answer('none')
    if (next instanceof Error) throw next
    return next
  })
  const client = {
    inbox: { tray },
    decisions: { record },
    groups: { dismissInvite },
    conversations: { reportProcessingFailure: report },
    baseUrl: 'https://api.agentchat.me',
  }
  return { client, state, tray, record, dismissInvite, report }
}

const textsSource = (value: Texts | null = texts) => ({ current: () => value, ensure: async () => value })

/** Runs the test ends by hand, in the order they started. */
function runs() {
  const started: RunRequest[] = []
  const ends: Array<(end: RunEnd) => void> = []
  const startRun = vi.fn((request: RunRequest) => {
    started.push(request)
    return new Promise<RunEnd>((r) => ends.push(r))
  })
  return { started, ends, startRun, ids: () => started.map((r) => r.conversationId ?? r.kind) }
}

function runLoop(over: Partial<ReceiveLoopOptions> & Pick<ReceiveLoopOptions, 'client' | 'startRun'>) {
  const events: ReceiveLoopEvent[] = []
  const loop = new ReceiveLoop({
    mode: 'singleRun',
    texts: textsSource(),
    socket: null,
    quietMs: 0,
    maxMs: 0,
    onEvent: (e) => events.push(e),
    ...over,
  })
  return { loop, events }
}

const reportsIn = (events: ReceiveLoopEvent[]) =>
  events.filter((e): e is Extract<ReceiveLoopEvent, { type: 'processing_failure' }> => e.type === 'processing_failure')

describe('conversation runs (single-run mode, texts with conversation_run_template)', () => {
  it('one run per owed card, prompted for that one conversation, then one invite run; one at a time; nothing recorded', async () => {
    const { client, state, record } = fakeClient()
    state.tray = trayOf([A, B], { invites: [INVITE] })
    const r = runs()
    const { loop, events } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1, 'the first run')
    expect(r.started[0]).toMatchObject({
      kind: 'conversation',
      conversationId: A.conversation_id,
      prompt: TEMPLATE.split('<conversation_id>').join(A.conversation_id),
      cards: 1,
      invites: 0,
    })
    expect(r.started[0]!.prompt).not.toContain('<conversation_id>')
    await until(() => loop.status().lastCycle !== null, 'the cycle summary')
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'runs_started', cards: 2, invites: 1, turnsStarted: 1, turnsQueued: 2 })
    // The running run and the two waiting ones each hold what they are for.
    expect(loop.status().turns.map((t) => (t.kind === 'reply' ? t.conversationId : t.inviteId))).toEqual([
      A.conversation_id,
      B.conversation_id,
      INVITE.invite_id,
    ])
    expect(loop.status().counters).toMatchObject({ turnsActive: 1, turnsWaiting: 2 })

    r.ends[0]!({ status: 'completed' })
    await until(() => r.started.length === 2, 'the second run')
    expect(r.started[1]).toMatchObject({ kind: 'conversation', conversationId: B.conversation_id })
    r.ends[1]!({ status: 'completed' })
    await until(() => r.started.length === 3, 'the invite run')
    expect(r.started[2]).toMatchObject({ kind: 'invite', prompt: served.invite_prompt, cards: 0, invites: 1 })
    expect(r.started[2]!.conversationId).toBeUndefined()
    r.ends[2]!({ status: 'completed' })
    await loop.idle()
    expect(record).not.toHaveBeenCalled()
    expect(loop.status().counters).toMatchObject({ runsStarted: 3, runsCompleted: 3 })
    const runEvents = events.filter((e) => e.type === 'run').map((e) => [(e as { kind?: string }).kind, (e as { conversationId?: string }).conversationId])
    expect(runEvents).toEqual([
      ['conversation', A.conversation_id],
      ['conversation', B.conversation_id],
      ['invite', undefined],
    ])
    await loop.stop()
  })

  it('a conversation whose run is in flight is held out of later cycles; a completed run at the same anchor is paced; a newer message lifts it', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([A])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)

    // A message in another conversation while A's run runs: A is held, B waits for the slot.
    state.tray = trayOf([A, B])
    loop.wake()
    await until(() => loop.status().coalescer.cycles === 2 && loop.status().coalescer.state === 'idle')
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'runs_started', heldByTurns: 1, turnsQueued: 1 })
    expect(r.started).toHaveLength(1)

    // A's run ends without taking its card off the tray: B starts; A is paced at that anchor.
    r.ends[0]!({ status: 'completed' })
    await until(() => r.started.length === 2)
    expect(r.started[1]!.conversationId).toBe(B.conversation_id)
    r.ends[1]!({ status: 'completed' })
    await loop.idle()
    await briefly()
    const cycles = loop.status().coalescer.cycles
    loop.wake()
    await until(() => loop.status().coalescer.cycles === cycles + 1 && loop.status().coalescer.state === 'idle', 'the paced cycle')
    expect(r.started).toHaveLength(2)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', paced: 2 })

    // A newer message moves A's anchor: it runs again.
    state.tray = trayOf([card(A.conversation_id, 'msg_alpha002')])
    loop.wake()
    await until(() => r.started.length === 3)
    expect(r.started[2]!.conversationId).toBe(A.conversation_id)
    r.ends[2]!({ status: 'completed' })
    await loop.stop()
  })

  it('a notices-only card (preview null) is not owed: no run of its own; it waits for the next real run of its conversation', async () => {
    const N = card('conv_notice0001', 'msg_unused', { preview: null, last_message_id: 'msg_joined0001', you_owe_reply: false, unread: 1 })
    const { client, state, record } = fakeClient()
    state.tray = trayOf([N])
    const r = runs()
    const checkReady = vi.fn(() => ({ ready: true as const }))
    const { loop } = runLoop({ client, startRun: r.startRun, readiness: checkReady })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', cards: 1, turnsStarted: 0, turnsQueued: 0 })
    expect(r.started).toHaveLength(0)
    expect(checkReady).not.toHaveBeenCalled() // nothing owed: no readiness probe either

    // With a real card beside it: only the real one runs.
    state.tray = trayOf([N, A])
    loop.wake()
    await until(() => r.started.length === 1)
    await until(() => loop.status().coalescer.cycles === 2 && loop.status().coalescer.state === 'idle')
    expect(r.started[0]!.conversationId).toBe(A.conversation_id)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'runs_started', turnsStarted: 1, turnsQueued: 0 })
    r.ends[0]!({ status: 'completed' })
    await loop.idle()

    // A real message in that conversation: it runs, and the run reads through the notices.
    state.tray = trayOf([{ ...N, preview: { ...sample.conversations[0]!.preview!, message_id: 'msg_real0001' }, you_owe_reply: true, unread: 2 }])
    loop.wake()
    await until(() => r.started.length === 2)
    expect(r.started[1]!.conversationId).toBe(N.conversation_id)
    r.ends[1]!({ status: 'completed' })
    await loop.idle()
    expect(record).not.toHaveBeenCalled()
    await loop.stop()

    // Without the template (one run for the tray) nothing changes: a notices-only card still counts.
    const old = fakeClient()
    old.state.tray = trayOf([N])
    const seen: RunRequest[] = []
    const tray = runLoop({ client: old.client, texts: textsSource(oldTexts), startRun: async (request) => (seen.push(request), { status: 'completed' }) })
    tray.loop.wake()
    await until(() => tray.loop.status().lastCycle !== null)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'tray', cards: 1 })
    await tray.loop.stop()
  })

  it('a tray that cannot be read starts no run (tray_failed): one run for the tray would undo the walls', async () => {
    const { client, state } = fakeClient()
    state.tray = new Error('timeout')
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'tray_failed', failure: 'timeout' })
    expect(r.started).toHaveLength(0)
    await loop.stop()
  })

  it('maxConcurrentTurns: 2 runs two conversations at once', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([A, B, P])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, maxConcurrentTurns: 2 })
    loop.wake()
    await until(() => r.started.length === 2)
    await briefly()
    expect(r.ids()).toEqual([A.conversation_id, B.conversation_id])
    r.ends[1]!({ status: 'completed' })
    await until(() => r.started.length === 3)
    expect(r.started[2]!.conversationId).toBe(P.conversation_id)
    r.ends[0]!({ status: 'completed' })
    r.ends[2]!({ status: 'completed' })
    await loop.stop()
  })

  it('idle() waits for the runs; stop() aborts the running one, drops the waiting ones and waits for the end', async () => {
    const { client, state } = fakeClient()
    state.tray = trayOf([A, B])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    let idled = false
    void loop.idle().then(() => (idled = true))
    await briefly()
    expect(idled).toBe(false)
    r.ends[0]!({ status: 'completed' })
    await until(() => r.started.length === 2)
    await briefly()
    expect(idled).toBe(false)
    r.ends[1]!({ status: 'completed' })
    await until(() => idled, 'idle after the last run')

    const other = fakeClient()
    other.state.tray = trayOf([A, B])
    const s = runs()
    const second = runLoop({ client: other.client, startRun: s.startRun })
    second.loop.wake()
    await until(() => s.started.length === 1)
    await until(() => second.loop.status().counters.turnsWaiting === 1)
    let stopped = false
    const stopping = second.loop.stop().then(() => (stopped = true))
    await briefly()
    expect(s.started[0]!.signal.aborted).toBe(true)
    expect(stopped).toBe(false)
    s.ends[0]!({ status: 'failed', detail: 'interrupted' })
    await stopping
    expect(s.started).toHaveLength(1)
    expect(second.loop.status().turns).toEqual([])
    // A run the stop cut short did not fail on its conversation: nothing reported.
    expect(other.report).not.toHaveBeenCalled()
  })

  it('old texts (no conversation_run_template) and conversationRuns: false keep one run for the whole tray', async () => {
    for (const setup of [{ texts: oldTexts }, { texts, conversationRuns: false }]) {
      const { client, state } = fakeClient()
      state.tray = trayOf([A, B])
      const seen: RunRequest[] = []
      const { loop } = runLoop({
        client,
        texts: textsSource(setup.texts),
        ...(setup.conversationRuns === false ? { conversationRuns: false } : {}),
        startRun: async (request) => {
          seen.push(request)
          return { status: 'completed' }
        },
      })
      loop.wake()
      await until(() => loop.status().lastCycle !== null)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ kind: 'tray', prompt: served.wake_instruction, cards: 2, invites: 0 })
      expect(seen[0]!.conversationId).toBeUndefined()
      expect(loop.status().lastCycle).toMatchObject({ outcome: 'run_completed' })
      await loop.stop()
    }
  })

  it('the published texts (conformance texts.sample.json) carry the template: it starts conversation runs', async () => {
    expect(served.conversation_run_template).toMatch(/^AgentChat started this run for ONE conversation/)
    const { client, state } = fakeClient()
    state.tray = trayOf([A])
    const r = runs()
    const { loop } = runLoop({ client, texts: textsSource(served), startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    expect(r.started[0]).toMatchObject({
      kind: 'conversation',
      conversationId: A.conversation_id,
      prompt: served.conversation_run_template!.trim().split('<conversation_id>').join(A.conversation_id),
    })
    expect(r.started[0]!.prompt).not.toContain('<conversation_id>')
    r.ends[0]!({ status: 'completed' })
    await loop.stop()
  })

  it('conversationRunPrompt: every placeholder replaced; a template without one gets a conversation_id line; no template falls back to the reply prompt', () => {
    expect(conversationRunPrompt(texts, 'conv_x')).toBe(TEMPLATE.split('<conversation_id>').join('conv_x'))
    expect(conversationRunPrompt({ ...texts, conversation_run_template: ' Just this one. ' }, 'conv_x')).toBe('Just this one.\n\nconversation_id: conv_x')
    expect(conversationRunPrompt({ ...oldTexts, conversation_run_template: '  ' }, 'conv_x')).toBe(
      served.reply_turn_template!.split('<conversation_id>').join('conv_x'),
    )
    // The id goes in as it is ($& is not a replacement pattern here).
    expect(conversationRunPrompt(texts, 'conv_$&')).toContain('conv_$&:')
  })
})

describe('could not process: the report (conversation runs)', () => {
  it('three new messages, one card: the kit reports once, through the card anchor; the server picks the span; the run goes again', async () => {
    const { client, state, report } = fakeClient([
      answer('hidden', { attempts: 2, hidden_message_ids: ['msg_poison01', 'msg_poison02', 'msg_poison03'] }),
    ])
    const span = card(P.conversation_id, 'msg_poison03', { unread: 3 })
    state.tray = trayOf([span, A])
    const r = runs()
    const { loop, events } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    expect(r.started[0]!.conversationId).toBe(P.conversation_id)
    r.ends[0]!({ status: 'failed', detail: 'API error: the request was refused' })
    // No evidence yet: nothing reported; the failure waits.
    await until(() => r.started.length === 2)
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().processingFailures.awaitingEvidence).toBe(1)

    // A's run completes after P's started: the runtime works. One report, through P's anchor.
    r.ends[1]!({ status: 'completed' })
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]).toEqual([
      P.conversation_id,
      { throughMessageId: 'msg_poison03', outcome: 'failed', evidence: 'other_run_completed' },
    ])
    // hidden: P runs again (the run reads the note in place of the span).
    await until(() => r.started.length === 3)
    expect(r.started[2]).toMatchObject({ kind: 'conversation', conversationId: P.conversation_id })
    r.ends[2]!({ status: 'completed' })
    await loop.idle()
    expect(report).toHaveBeenCalledTimes(1)
    expect(reportsIn(events)).toMatchObject([
      {
        conversationId: P.conversation_id,
        source: 'run',
        throughMessageId: 'msg_poison03',
        evidence: 'other_run_completed',
        result: { action: 'hidden', hidden_message_ids: ['msg_poison01', 'msg_poison02', 'msg_poison03'] },
        next: 'rerun',
      },
    ])
    expect(loop.status().processingFailures).toMatchObject({ reported: 1, hidden: 1, reruns: 1, awaitingEvidence: 0 })
    await loop.stop()
  })

  it('retry, then hidden, then the run goes through: the queued run is the evidence first, the runtime check (nothing queued) next', async () => {
    const { client, state, report } = fakeClient([answer('retry'), answer('hidden', { attempts: 2, hidden_message_ids: ['msg_poison03'] })])
    state.tray = trayOf([P, A])
    const r = runs()
    const checkRuntime = vi.fn(async () => ({ ok: true }))
    const { loop } = runLoop({ client, startRun: r.startRun, checkRuntime })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' }) // P, 1st: A is queued, so the failure waits for it (no runtime check yet)
    await until(() => r.started.length === 2)
    expect(r.started[1]!.conversationId).toBe(A.conversation_id)
    expect(checkRuntime).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    r.ends[1]!({ status: 'completed' }) // A completes after P started: evidence (a)
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]![1]).toEqual({ throughMessageId: 'msg_poison03', outcome: 'failed', evidence: 'other_run_completed' })
    // retry: P goes again.
    await until(() => r.started.length === 3)
    expect(r.started[2]!.conversationId).toBe(P.conversation_id)
    r.ends[2]!({ status: 'failed' }) // P, 2nd: nothing else queued, only P failing: the runtime check
    await until(() => report.mock.calls.length === 2)
    expect(report.mock.calls[1]![1]).toEqual({ throughMessageId: 'msg_poison03', outcome: 'failed', evidence: 'runtime_check' })
    await until(() => r.started.length === 4)
    expect(r.started[3]!.conversationId).toBe(P.conversation_id)
    r.ends[3]!({ status: 'completed' }) // P, 3rd: around the hidden span
    await loop.idle()
    expect(r.ids()).toEqual([P.conversation_id, A.conversation_id, P.conversation_id, P.conversation_id])
    expect(checkRuntime).toHaveBeenCalledTimes(1)
    expect(loop.status().processingFailures).toMatchObject({ reported: 2, retry: 1, hidden: 1, reruns: 2, runtimeChecksOk: 1 })
    expect(loop.status().processingFailures.lastRuntimeCheck).toMatchObject({ ok: true, detail: null })
    await loop.stop()
  })

  it('a run that timed out is reported only on another run completing, never on the runtime check alone', async () => {
    // Alone: the check is not even asked (a timeout is ambiguous: a brownout, a hung hook).
    const alone = fakeClient()
    alone.state.tray = trayOf([P])
    const checkRuntime = vi.fn(async () => ({ ok: true }))
    const startRun = vi.fn(async (): Promise<RunEnd> => ({ status: 'failed', timedOut: true }))
    const first = runLoop({ client: alone.client, startRun, checkRuntime })
    first.loop.wake()
    await until(() => startRun.mock.calls.length === 1)
    await first.loop.idle()
    expect(alone.report).not.toHaveBeenCalled()
    expect(checkRuntime).not.toHaveBeenCalled()
    expect(first.loop.status().processingFailures.awaitingEvidence).toBe(1)
    await first.loop.stop()

    // With another conversation's run completing after it started: reported, timed_out.
    const { client, state, report } = fakeClient([answer('retry')])
    state.tray = trayOf([P, A])
    const r = runs()
    const second = runLoop({ client, startRun: r.startRun, checkRuntime })
    second.loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed', timedOut: true })
    await until(() => r.started.length === 2)
    r.ends[1]!({ status: 'completed' })
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]![1]).toEqual({ throughMessageId: 'msg_poison03', outcome: 'timed_out', evidence: 'other_run_completed' })
    await until(() => r.started.length === 3)
    r.ends[2]!({ status: 'completed' })
    await second.loop.stop()
  })

  it('several conversations failing together is the runtime: a passing runtime check reports none of them', async () => {
    const { client, state, report } = fakeClient()
    state.tray = trayOf([P, A])
    const checkRuntime = vi.fn(async () => ({ ok: true }))
    const startRun = vi.fn(async (): Promise<RunEnd> => ({ status: 'failed', detail: 'the provider is down' }))
    const { loop } = runLoop({ client, startRun, checkRuntime })
    loop.wake()
    await until(() => startRun.mock.calls.length === 2)
    await loop.idle()
    expect(report).not.toHaveBeenCalled()
    expect(checkRuntime).not.toHaveBeenCalled()
    // Both still wait for evidence (a): a later completion of another conversation's run.
    expect(loop.status().processingFailures.awaitingEvidence).toBe(2)
    await loop.stop()
  })

  it('only a completion of the same kind of work counts: an invite run completing is no evidence for a conversation run', async () => {
    const { client, state, report } = fakeClient()
    state.tray = trayOf([P], { invites: [INVITE] })
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' }) // P
    await until(() => r.started.length === 2)
    expect(r.started[1]!.kind).toBe('invite')
    r.ends[1]!({ status: 'completed' })
    await loop.idle()
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().processingFailures.awaitingEvidence).toBe(1)
    await loop.stop()
  })

  it('paused stops: no run again for that conversation', async () => {
    const { client, state, report } = fakeClient([answer('paused', { attempts: 3, paused_until: '2026-11-20T12:00:00.000Z' })])
    state.tray = trayOf([P])
    const r = runs()
    const { loop, events } = runLoop({ client, startRun: r.startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' })
    await until(() => report.mock.calls.length === 1)
    await loop.idle()
    expect(r.started).toHaveLength(1)
    expect(reportsIn(events)[0]).toMatchObject({ result: { action: 'paused', paused_until: '2026-11-20T12:00:00.000Z' }, next: 'stop' })
    expect(loop.status().processingFailures).toMatchObject({ reported: 1, paused: 1, reruns: 0 })
    // The server's pause is a mute: the card comes back muted and owes nothing.
    state.tray = trayOf([{ ...P, muted: true }])
    loop.wake()
    await loop.idle()
    expect(r.started).toHaveLength(1)
    await loop.stop()
  })

  it('paused also drops a run for that conversation still waiting for a slot', async () => {
    const { client, state, report } = fakeClient([answer('paused', { attempts: 3, paused_until: '2026-11-20T12:00:00.000Z' })])
    state.tray = trayOf([P])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' }) // no evidence yet: it waits
    await until(() => loop.status().processingFailures.awaitingEvidence === 1)
    // The next wake queues A, B, then P (its last run failed, so it goes last).
    state.tray = trayOf([P, A, B])
    loop.wake()
    await until(() => r.started.length === 2)
    await until(() => loop.status().counters.turnsWaiting === 2)
    r.ends[1]!({ status: 'completed' }) // A: the evidence; the server pauses P
    await until(() => report.mock.calls.length === 1)
    await until(() => r.started.length === 3)
    expect(r.started[2]!.conversationId).toBe(B.conversation_id)
    expect(loop.status().counters.turnsWaiting).toBe(0)
    r.ends[2]!({ status: 'completed' })
    await loop.idle()
    expect(r.ids()).toEqual([P.conversation_id, A.conversation_id, B.conversation_id])
    expect(loop.status().turns).toEqual([])
    await loop.stop()
  })

  it('no evidence, nothing reported: a lone failure waits; a failed runtime check drops it; the next completion reports what waits', async () => {
    const { client, state, report } = fakeClient([answer('none', { attempts: 0 })])
    state.tray = trayOf([P])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed', detail: 'exit 1' })
    await loop.idle()
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().processingFailures.awaitingEvidence).toBe(1)

    // The next wake: A runs first (P's last run failed, so it goes last); A completing is the evidence.
    state.tray = trayOf([P, A])
    loop.wake()
    await until(() => r.started.length === 2)
    expect(r.started[1]!.conversationId).toBe(A.conversation_id)
    r.ends[1]!({ status: 'completed' })
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]![1]).toMatchObject({ evidence: 'other_run_completed', throughMessageId: 'msg_poison03' })
    // none: P's run queued behind A waited for the answer and does not start; P is held at its anchor.
    await loop.idle()
    expect(r.started).toHaveLength(2)
    expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, anchor: 'msg_poison03', reason: 'none' }])
    await loop.stop()

    // A runtime whose own check fails: not the conversation's fault; nothing kept, nothing reported.
    const broken = fakeClient()
    broken.state.tray = trayOf([P])
    const s = runs()
    const second = runLoop({ client: broken.client, startRun: s.startRun, checkRuntime: async () => ({ ok: false, detail: 'not signed in' }) })
    second.loop.wake()
    await until(() => s.started.length === 1)
    s.ends[0]!({ status: 'failed' })
    await until(() => second.loop.status().processingFailures.runtimeChecksFailed === 1)
    await second.loop.idle()
    expect(broken.report).not.toHaveBeenCalled()
    expect(second.loop.status().processingFailures).toMatchObject({ awaitingEvidence: 0, reported: 0 })
    expect(second.loop.status().processingFailures.lastRuntimeCheck).toMatchObject({ ok: false, detail: 'not signed in' })
    await second.loop.stop()
  })

  it('a run that answered (or left the tray) before it failed is not reported', async () => {
    const { client, state, report } = fakeClient()
    state.tray = trayOf([P, A])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => r.started.length === 1)
    // The run sent its answer, then hit its time limit: the card shows the send.
    state.tray = trayOf([{ ...P, you_owe_reply: false, your_last_message_at: '2026-11-19T10:00:00.000Z' }, A])
    r.ends[0]!({ status: 'failed', timedOut: true })
    await until(() => r.started.length === 2)
    // A: the run read it (the card is gone), then crashed.
    state.tray = trayOf([{ ...P, you_owe_reply: false, your_last_message_at: '2026-11-19T10:00:00.000Z' }])
    r.ends[1]!({ status: 'failed' })
    await loop.idle()
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().processingFailures).toMatchObject({ awaitingEvidence: 0, runtimeChecksOk: 0 })
    await loop.stop()
  })

  it('a server that keeps answering retry: at most MAX_RERUNS_PER_CYCLE re-runs, then the loop stops for it', async () => {
    const { client, state, report } = fakeClient(Array.from({ length: 10 }, () => answer('retry')))
    state.tray = trayOf([P])
    const startRun = vi.fn(async (): Promise<RunEnd> => ({ status: 'failed' }))
    const { loop, events } = runLoop({ client, startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => report.mock.calls.length === 4, 'four reports')
    await loop.idle()
    expect(startRun).toHaveBeenCalledTimes(4) // the run, then three re-runs
    expect(reportsIn(events).map((e) => e.next)).toEqual(['rerun', 'rerun', 'rerun', 'rerun_capped'])
    expect(loop.status().processingFailures).toMatchObject({ reported: 4, retry: 4, reruns: 3, rerunsCapped: 1 })
    await loop.stop()
  })

  it('a report that fails is counted and stops nothing else; the loop goes on', async () => {
    const { client, state, report } = fakeClient([new Error('network down')])
    state.tray = trayOf([P, A])
    const r = runs()
    const { loop, events } = runLoop({ client, startRun: r.startRun })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' })
    await until(() => r.started.length === 2)
    r.ends[1]!({ status: 'completed' }) // the evidence: the report goes out, and fails
    await until(() => report.mock.calls.length === 1)
    await loop.idle()
    expect(loop.status().processingFailures).toMatchObject({ reported: 0, reportErrors: 1 })
    expect(reportsIn(events)[0]).toMatchObject({ result: null, error: 'network down', next: 'stop' })
    expect(events.some((e) => e.type === 'error' && e.error.message === 'network down')).toBe(true)
    // The server did not answer: nothing is held.
    expect(loop.status().processingFailures.held).toEqual([])
    // The loop goes on: the next wake runs.
    loop.wake()
    await until(() => r.started.length === 3)
    r.ends[2]!({ status: 'completed' })
    await loop.stop()
  })

  it('the conversation stays held until the server answers: a cycle meanwhile does not start it; the re-run is the answer’s', async () => {
    let answerNow: (a: ProcessingFailureAction) => void = () => undefined
    const { client, state, report } = fakeClient()
    report.mockImplementationOnce(() => new Promise<ProcessingFailureAction>((r) => (answerNow = r)))
    state.tray = trayOf([P])
    const r = runs()
    const { loop, events } = runLoop({ client, startRun: r.startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' })
    await until(() => report.mock.calls.length === 1, 'the report under way')
    // A wake while the report is out: P is held, nothing starts.
    loop.wake()
    await until(() => loop.status().lastCycle?.heldByTurns === 1, 'a cycle that held P')
    expect(r.started).toHaveLength(1)
    answerNow(answer('retry'))
    await until(() => r.started.length === 2, 'the re-run')
    expect(reportsIn(events)[0]).toMatchObject({ next: 'rerun' })
    r.ends[1]!({ status: 'completed' })
    await loop.idle()
    expect(r.started).toHaveLength(2)
    await loop.stop()
  })

  it('a failure waits for evidence at most AWAITING_EVIDENCE_MS: a completion later than that reports nothing', async () => {
    let clock = 1_000_000
    const { client, state, report } = fakeClient()
    state.tray = trayOf([P])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, now: () => clock })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' })
    await until(() => loop.status().processingFailures.awaitingEvidence === 1)
    clock += 11 * 60_000 // an outage long enough that a later completion proves nothing about it
    state.tray = trayOf([A])
    loop.wake()
    await until(() => r.started.length === 2)
    r.ends[1]!({ status: 'completed' })
    await loop.idle()
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().processingFailures.awaitingEvidence).toBe(0)
    await loop.stop()
  })

  it('no runtime check when nothing could be reported (an older client without the report)', async () => {
    const { client, state } = fakeClient()
    client.conversations = undefined as never
    state.tray = trayOf([P])
    const checkRuntime = vi.fn(async () => ({ ok: true }))
    const startRun = vi.fn(async (): Promise<RunEnd> => ({ status: 'failed' }))
    const { loop } = runLoop({ client, startRun, checkRuntime })
    loop.wake()
    await until(() => startRun.mock.calls.length === 1)
    await loop.idle()
    expect(checkRuntime).not.toHaveBeenCalled()
    expect(loop.status().processingFailures).toMatchObject({ reported: 0, awaitingEvidence: 0 })
    await loop.stop()
  })

  it('an older server (plain 404 for the route): the report reads as none, and the loop goes on', async () => {
    const tray = trayOf([P])
    const calls: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      if (url.includes('/v1/inbox')) return new Response(JSON.stringify(tray), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }) as unknown as typeof globalThis.fetch
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } })
    const startRun = vi.fn(async (): Promise<RunEnd> => ({ status: 'failed' }))
    const { loop, events } = runLoop({ client, startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => reportsIn(events).length === 1)
    await loop.idle()
    expect(calls).toContain(`POST /v1/conversations/${P.conversation_id}/processing-failures`)
    expect(reportsIn(events)[0]).toMatchObject({ result: { action: 'none', attempts: 0 }, next: 'stop' })
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(loop.status().processingFailures).toMatchObject({ reported: 1, none: 1, reportErrors: 0 })
    expect(events.some((e) => e.type === 'error')).toBe(false)
    await loop.stop()
  })
})

// ─── gate-call mode: the chunk split, and reply-turn failures ──────────────

const idsIn = (prompt: string) => [...prompt.matchAll(/"conversation_id": "(conv_[^"]+)"/g)].map((m) => m[1]!)
const allAs = (decision: string, prompt: string) =>
  JSON.stringify({ decisions: idsIn(prompt).map((id) => ({ conversation_id: id, decision })) })

function turns() {
  const started: TurnRequest[] = []
  const ends: Array<(end: TurnEnd) => void> = []
  const startTurn = vi.fn(async (request: TurnRequest): Promise<TurnAdmission> => {
    started.push(request)
    return { started: true, done: new Promise<TurnEnd>((r) => ends.push(r)) }
  })
  return { started, ends, startTurn }
}

function gateLoop(over: Partial<ReceiveLoopOptions> & Pick<ReceiveLoopOptions, 'client'>) {
  const events: ReceiveLoopEvent[] = []
  const loop = new ReceiveLoop({
    mode: 'gateCall',
    texts: textsSource(served),
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

describe('could not process: the gate-chunk split (gate-call mode)', () => {
  const POISON = card('conv_poison0001', 'msg_poison03', {
    preview: { ...sample.conversations[0]!.preview!, message_id: 'msg_poison03', text: 'POISON: content the model refuses' },
  })
  const D = card('conv_delta00001', 'msg_delta001')
  /** The model refuses any prompt that holds the poison text. */
  const refusing = () =>
    vi.fn(async (prompt: string) => {
      if (prompt.includes('POISON')) throw new Error('the provider refused the request')
      return allAs('dismiss', prompt)
    })

  it('a chunk that fails is re-gated one card per call: only the bad card fails, the others are decided in the same cycle', async () => {
    const { client, state, record } = fakeClient()
    client.conversations = undefined as never // no reporting: the split alone
    state.tray = trayOf([A, POISON, B])
    const callModel = refusing()
    const { loop, events } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(callModel.mock.calls.map(([prompt]) => idsIn(prompt))).toEqual([
      [A.conversation_id, POISON.conversation_id, B.conversation_id],
      [A.conversation_id],
      [POISON.conversation_id],
      [B.conversation_id],
    ])
    expect(callModel.mock.calls[1]![0]).toBe(buildPrompt(trayOf([A]), { texts: served }))
    expect(record.mock.calls.map(([id]) => id)).toEqual([A.conversation_id, B.conversation_id])
    expect(loop.status().lastCycle).toMatchObject({
      outcome: 'decided',
      gated: 3,
      dismiss: 2,
      undecided: 1,
      chunksOk: 0,
      chunksFailed: 1,
      splitCallsOk: 2,
      splitCallsFailed: 1,
      failure: `model call failed: the provider refused the request; 1 of 3 single-card calls failed; ${POISON.conversation_id}: model call failed: the provider refused the request`,
    })
    const split = events.filter((e) => e.type === 'gate_chunk' && e.split === true)
    expect(split.map((e) => [(e as { conversationId?: string }).conversationId, (e as { outcome: string }).outcome])).toEqual([
      [A.conversation_id, 'decided'],
      [POISON.conversation_id, 'fail_closed'],
      [B.conversation_id, 'decided'],
    ])

    // The next cycle: the card whose call failed is gated alone, after the others' chunk.
    state.tray = trayOf([POISON, D])
    loop.wake()
    await until(() => loop.status().recentCycles.length === 2)
    expect(callModel.mock.calls.slice(4).map(([prompt]) => idsIn(prompt))).toEqual([[D.conversation_id], [POISON.conversation_id]])
    await loop.stop()
  })

  it('the bad card is reported once a later call succeeds (evidence); retry re-gates it at the end; hidden gates it again in the next cycle, on the fresh card', async () => {
    const { client, state, record, report } = fakeClient([answer('retry')])
    state.tray = trayOf([A, POISON, B])
    const callModel = refusing()
    const { loop, events } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().coalescer.cycles === 1 && loop.status().coalescer.state === 'idle')
    // Chunk, A, POISON (fails), B (succeeds: the evidence), POISON again (retry).
    expect(callModel.mock.calls.map(([prompt]) => idsIn(prompt))).toEqual([
      [A.conversation_id, POISON.conversation_id, B.conversation_id],
      [A.conversation_id],
      [POISON.conversation_id],
      [B.conversation_id],
      [POISON.conversation_id],
    ])
    expect(report.mock.calls).toEqual([
      [POISON.conversation_id, { throughMessageId: 'msg_poison03', outcome: 'failed', evidence: 'other_run_completed' }],
    ])
    expect(reportsIn(events)[0]).toMatchObject({ source: 'gate', result: { action: 'retry' }, next: 'rerun' })
    // The retried call failed with nothing after it in this cycle: it waits for evidence.
    expect(loop.status().processingFailures.awaitingEvidence).toBe(1)

    // The next cycle: D's chunk succeeds (the evidence); the server hides the span; the next cycle reads the fresh card.
    report.mockImplementationOnce(async () => {
      state.tray = trayOf([
        { ...POISON, preview: { ...POISON.preview!, text: NOTE, could_not_process: true } },
      ])
      return answer('hidden', { attempts: 2, hidden_message_ids: ['msg_poison03'] })
    })
    state.tray = trayOf([POISON, D])
    loop.wake()
    await until(() => record.mock.calls.some(([id]) => id === POISON.conversation_id), 'the verdict on the hidden card')
    // Cycle 2 gated D alone and skipped the stale poison card; cycle 3 gated the note.
    expect(callModel.mock.calls.slice(5).map(([prompt]) => idsIn(prompt))).toEqual([[D.conversation_id], [POISON.conversation_id]])
    expect(callModel.mock.calls[6]![0]).toContain(NOTE)
    expect(callModel.mock.calls.filter(([prompt]) => prompt.includes('POISON'))).toHaveLength(3)
    expect(record.mock.calls.find(([id]) => id === POISON.conversation_id)![1]).toMatchObject({ decision: 'dismiss', throughMessageId: 'msg_poison03' })
    expect(loop.status().processingFailures).toMatchObject({ reported: 2, retry: 1, hidden: 1, awaitingEvidence: 0 })
    await loop.stop()
  })

  it('a single-card call that fails with no other call succeeding after it is not reported (unless the runtime check passes)', async () => {
    const { client, state, report } = fakeClient([answer('retry'), answer('none')])
    state.tray = trayOf([POISON])
    const { loop } = gateLoop({ client, callModel: refusing() })
    loop.wake()
    await until(() => loop.status().lastCycle !== null)
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'fail_closed', chunksFailed: 1, splitCallsFailed: 0 })
    await loop.stop()

    const checked = fakeClient([answer('none')])
    checked.state.tray = trayOf([POISON])
    const second = gateLoop({ client: checked.client, callModel: refusing(), checkRuntime: async () => ({ ok: true }) })
    second.loop.wake()
    await until(() => checked.report.mock.calls.length === 1)
    expect(checked.report.mock.calls[0]![1]).toEqual({ throughMessageId: 'msg_poison03', outcome: 'failed', evidence: 'runtime_check' })
    await second.loop.stop()
  })

  it('the split guard: two single-card failures in a row with nothing decided go on only while checkRuntime passes, else split_stopped; several failing together reports none', async () => {
    const cards = [A, B, D, card('conv_echo000001', 'msg_echo0001')]
    for (const checkOk of [true, false]) {
      const { client, state, report } = fakeClient(Array.from({ length: 5 }, () => answer('retry')))
      state.tray = trayOf(cards)
      const callModel = vi.fn(async () => {
        throw new Error('503 from the provider')
      })
      const checkRuntime = vi.fn(async () => ({ ok: checkOk }))
      const { loop, events } = gateLoop({ client, callModel, checkRuntime })
      loop.wake()
      await until(() => loop.status().lastCycle !== null)
      const stops = events.filter((e) => e.type === 'split_stopped')
      if (checkOk) {
        // The chunk, then all four alone (the check passed after two); nothing reported: all of them failing is the runtime.
        expect(callModel).toHaveBeenCalledTimes(5)
        expect(checkRuntime).toHaveBeenCalledTimes(2) // the guard after cards 1-2 and after cards 3-4
        expect(stops).toEqual([])
        expect(loop.status().lastCycle).toMatchObject({ outcome: 'fail_closed', splitCallsFailed: 4, splitStopped: false })
      } else {
        // The chunk, two alone, then the check fails: the split stops with two cards left.
        expect(callModel).toHaveBeenCalledTimes(3)
        expect(stops).toEqual([expect.objectContaining({ remaining: 2, reason: 'runtime_check_failed' })])
        expect(loop.status().lastCycle).toMatchObject({ outcome: 'fail_closed', splitCallsFailed: 2, splitStopped: true })
        expect(loop.status().processingFailures.splitsStopped).toBe(1)
      }
      expect(report).not.toHaveBeenCalled()
      await loop.stop()
    }
  })

  it('a gate failure from an earlier cycle answered retry mid-gate re-gates the card as this cycle read it, once', async () => {
    const { client, state, report } = fakeClient([answer('retry')])
    state.tray = trayOf([POISON])
    const callModel = refusing()
    const { loop } = gateLoop({ client, callModel })
    loop.wake()
    await until(() => loop.status().processingFailures.awaitingEvidence === 1, 'the failure waiting for evidence')
    // A newer message on the same conversation; D's chunk is the evidence.
    const newer = { ...POISON, preview: { ...POISON.preview!, message_id: 'msg_poison04' } }
    state.tray = trayOf([newer, D])
    loop.wake()
    await until(() => loop.status().recentCycles.length === 2)
    expect(report.mock.calls[0]![1]).toMatchObject({ throughMessageId: 'msg_poison03', evidence: 'other_run_completed' })
    const cycle2 = callModel.mock.calls.slice(1).map(([prompt]) => prompt)
    expect(cycle2.map(idsIn)).toEqual([[D.conversation_id], [POISON.conversation_id]])
    expect(cycle2[1]).toBe(buildPrompt(trayOf([newer]), { texts: served }))
    await loop.stop()
  })

  it('a gate call past its deadline is reported as timed_out, only when another gate call completes after it (not on the runtime check)', async () => {
    const hangs = (prompt: string) =>
      prompt.includes('POISON') ? new Promise<string>(() => undefined) : Promise.resolve(allAs('dismiss', prompt))
    // Alone, with a passing runtime check: not reported.
    const alone = fakeClient([answer('none')])
    alone.state.tray = trayOf([POISON])
    const checkRuntime = vi.fn(async () => ({ ok: true }))
    const first = gateLoop({ client: alone.client, callModel: vi.fn(hangs), gateCallTimeoutMs: 20, checkRuntime })
    first.loop.wake()
    await until(() => first.loop.status().lastCycle !== null)
    expect(alone.report).not.toHaveBeenCalled()
    expect(checkRuntime).not.toHaveBeenCalled()
    await first.loop.stop()

    // In a chunk with A: the chunk times out, POISON alone times out, A alone decides after it: evidence (a).
    const { client, state, report } = fakeClient([answer('none')])
    state.tray = trayOf([POISON, A])
    const second = gateLoop({ client, callModel: vi.fn(hangs), gateCallTimeoutMs: 20, checkRuntime })
    second.loop.wake()
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]![1]).toEqual({ throughMessageId: 'msg_poison03', outcome: 'timed_out', evidence: 'other_run_completed' })
    await second.loop.stop()
  })

})

describe('could not process: reply turns (gate-call mode)', () => {
  it('a failed reply turn is reported once another turn completes; retry starts it again after the turns already queued', async () => {
    const { client, state, report } = fakeClient([answer('retry')])
    state.tray = trayOf([P, A])
    const t = turns()
    const callModel = vi.fn(async (prompt: string) => allAs('reply', prompt))
    const { loop, events } = gateLoop({ client, callModel, startTurn: t.startTurn })
    loop.wake()
    await until(() => t.started.length === 1)
    expect((t.started[0] as { conversationId: string }).conversationId).toBe(P.conversation_id)
    // P's turn fails; the fresh card is untouched.
    t.ends[0]!({ status: 'failed', detail: 'API error: refused' })
    await until(() => t.started.length === 2)
    expect(report).not.toHaveBeenCalled()
    expect((t.started[1] as { conversationId: string }).conversationId).toBe(A.conversation_id)
    // A's turn completes: the evidence. P is reported (source turn) and starts again.
    state.tray = trayOf([P])
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]).toEqual([P.conversation_id, { throughMessageId: 'msg_poison03', outcome: 'failed', evidence: 'other_run_completed' }])
    expect(reportsIn(events)[0]).toMatchObject({ source: 'turn', next: 'rerun' })
    await until(() => t.started.length === 3)
    expect(t.started[2]).toMatchObject({
      kind: 'reply',
      conversationId: P.conversation_id,
      prompt: served.reply_turn_template!.split('<conversation_id>').join(P.conversation_id),
    })
    t.ends[2]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await briefly()
    expect(callModel).toHaveBeenCalledTimes(1) // the re-run is the turn itself, no second gate call
    await loop.stop()
  })

  it('a gate call on the failing conversation’s own card is no evidence; with nothing else queued the runtime check is', async () => {
    const { client, state, report } = fakeClient([answer('none')])
    state.tray = trayOf([P])
    const t = turns()
    const callModel = vi.fn(async (prompt: string) => allAs('reply', prompt))
    const { loop } = gateLoop({ client, callModel, startTurn: t.startTurn })
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'failed' })
    await until(() => loop.status().processingFailures.awaitingEvidence === 1, 'the failure waiting for evidence')
    // The server re-wakes: the gate decides P again. Its own card: no evidence, no report; the gate's verdict starts the next turn.
    loop.wake()
    await until(() => t.started.length === 2)
    await briefly()
    expect(report).not.toHaveBeenCalled()
    expect(loop.status().counters).toMatchObject({ turnsStarted: 2, turnsRefused: 0 })
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await loop.stop()

    // With a runtime check: once nothing else is queued, the check is the evidence.
    const checked = fakeClient([answer('none')])
    checked.state.tray = trayOf([P])
    const u = turns()
    const second = gateLoop({ client: checked.client, callModel, startTurn: u.startTurn, checkRuntime: async () => ({ ok: true }) })
    second.loop.wake()
    await until(() => u.started.length === 1)
    u.ends[0]!({ status: 'failed' })
    await until(() => checked.report.mock.calls.length === 1)
    expect(checked.report.mock.calls[0]![1]).toMatchObject({ evidence: 'runtime_check' })
    await second.loop.stop()
  })

  it('a reply turn asked for while a gate is deciding starts after that cycle’s own turns', async () => {
    const { client, state, report } = fakeClient([answer('retry')])
    state.tray = trayOf([P, B])
    const t = turns()
    let gateA: (text: string) => void = () => undefined
    const callModel = vi.fn((prompt: string) => {
      // The second cycle's gate (A) answers only when the test says so.
      if (idsIn(prompt).includes(A.conversation_id)) return new Promise<string>((r) => (gateA = () => r(allAs('reply', prompt))))
      return Promise.resolve(allAs('reply', prompt))
    })
    const callsAtAdmission: number[] = []
    const startTurn = vi.fn(async (request: TurnRequest) => {
      callsAtAdmission.push(callModel.mock.calls.length)
      return t.startTurn(request)
    })
    const { loop } = gateLoop({ client, callModel, startTurn, maxConcurrentTurns: 2 })
    loop.wake()
    await until(() => t.started.length === 2, 'P and B')
    t.ends[0]!({ status: 'failed' }) // P: B is still running, so it waits
    await until(() => loop.status().processingFailures.awaitingEvidence === 1)
    // The next cycle gates A; while that call is out, B's turn completes: evidence for P; the server says retry.
    state.tray = trayOf([A])
    loop.wake()
    await until(() => callModel.mock.calls.length === 2, 'the gate call for A under way')
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    await until(() => report.mock.calls.length === 1)
    await briefly()
    expect(t.started).toHaveLength(2) // P's re-run waits for the gate
    gateA('')
    await until(() => t.started.length === 4, 'A’s turn, then P’s re-run')
    expect(t.started.map((r) => (r as { conversationId: string }).conversationId)).toEqual([
      P.conversation_id,
      B.conversation_id,
      A.conversation_id,
      P.conversation_id,
    ])
    expect(callsAtAdmission.slice(2)).toEqual([2, 2]) // both after the gate had answered
    t.ends[2]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    t.ends[3]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    await loop.stop()
  })

  it('a turn that timed out is reported as timed_out only when another turn completes after it; a failed turn whose card cannot be read again is not reported', async () => {
    const { client, state, report } = fakeClient([answer('none')])
    state.tray = trayOf([P, A])
    const t = turns()
    const checkRuntime = vi.fn(async () => ({ ok: true }))
    const { loop } = gateLoop({ client, callModel: async (prompt: string) => allAs('reply', prompt), startTurn: t.startTurn, checkRuntime })
    loop.wake()
    await until(() => t.started.length === 1)
    t.ends[0]!({ status: 'failed', timedOut: true }) // P
    await until(() => t.started.length === 2)
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } }) // A: evidence (a)
    await until(() => report.mock.calls.length === 1)
    expect(report.mock.calls[0]![1]).toEqual({ throughMessageId: 'msg_poison03', outcome: 'timed_out', evidence: 'other_run_completed' })
    expect(checkRuntime).not.toHaveBeenCalled()
    await loop.stop()

    const unread = fakeClient()
    unread.state.tray = trayOf([P])
    const u = turns()
    const second = gateLoop({ client: unread.client, callModel: async (prompt: string) => allAs('reply', prompt), startTurn: u.startTurn, checkRuntime: async () => ({ ok: true }) })
    second.loop.wake()
    await until(() => u.started.length === 1)
    unread.state.tray = new Error('tray read failed')
    u.ends[0]!({ status: 'failed' })
    await until(() => second.loop.status().counters.outcomes.turn_failed === 1)
    await briefly()
    expect(unread.report).not.toHaveBeenCalled()
    await second.loop.stop()
  })

})

// ─── the hold: a none or paused answer, until a newer message ───────────────

describe('could not process: a none or paused answer holds the conversation until a newer message', () => {
  beforeEach(() => MockWebSocket.reset())

  const frame = (id: string, conversationId: string, seq: number) => ({
    type: 'message.new',
    payload: { id, conversation_id: conversationId, sender: '@example-scout', seq },
  })
  const unanswered = (ids: string[]) => ({
    type: 'wake',
    payload: { reason: 'unanswered', conversation_ids: ids, step: 1, at: '2026-11-20T09:01:00.000Z' },
  })
  const settled = async (loop: ReceiveLoop, cycles: number, what: string) => {
    await until(() => loop.status().coalescer.cycles >= cycles && loop.status().coalescer.state === 'idle', what)
    await loop.idle()
    await briefly()
  }

  /** Single-run mode over a socket; a lone failure is reported on the runtime check. */
  async function socketRuns(answers: Array<ProcessingFailureAction | Error>) {
    const fake = fakeClient(answers)
    const r = runs()
    const events: ReceiveLoopEvent[] = []
    const loop = new ReceiveLoop({
      mode: 'singleRun',
      client: fake.client,
      texts: textsSource(),
      startRun: r.startRun,
      checkRuntime: async () => ({ ok: true }),
      socket: { apiKey: 'ac_key', webSocket: MockWebSocketCtor, reconnectInterval: 5, maxReconnectInterval: 5 },
      handle: '@example-relay',
      quietMs: 0,
      maxMs: 0,
      onEvent: (e) => events.push(e),
    })
    return { ...fake, r, loop, events }
  }
  const connect = (): MockWebSocket => {
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    ws.simulateMessage(json('hello-ok.v1.json'))
    return ws
  }

  it('none: a message elsewhere, a wake frame, an unanswered re-wake and a reconnect start no run of it while the others run; a newer message lifts it and its failure gets retry again', async () => {
    const { state, report, r, loop, events } = await socketRuns([answer('none', { attempts: 3 }), answer('retry')])
    state.tray = trayOf([P])
    await loop.start()
    let ws = connect()
    await until(() => r.started.length === 1, 'P’s run on the connect wake')
    r.ends[0]!({ status: 'failed', detail: 'API error: the request was refused' })
    await until(() => report.mock.calls.length === 1, 'the report')
    await settled(loop, 1, 'the first cycle')
    expect(reportsIn(events)[0]).toMatchObject({ throughMessageId: 'msg_poison03', result: { action: 'none' }, next: 'stop' })
    expect(loop.status().processingFailures.held).toEqual([
      { conversationId: P.conversation_id, anchor: 'msg_poison03', since: expect.any(String), reason: 'none' },
    ])

    // A message in another conversation: A runs, P does not.
    state.tray = trayOf([P, A])
    ws.simulateMessage(frame('msg_alpha001', A.conversation_id, 1))
    await until(() => r.started.length === 2, 'A’s run')
    expect(r.started[1]!.conversationId).toBe(A.conversation_id)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'runs_started', heldAfterFailure: 1, turnsStarted: 1 })
    r.ends[1]!({ status: 'completed' }) // its card stays: paced
    await settled(loop, 2, 'A’s cycle')

    // A wake frame (a reminder): nothing owed.
    let cycles = loop.status().coalescer.cycles
    ws.simulateMessage(json('wake-frame.json'))
    await settled(loop, cycles + 1, 'the wake-frame cycle')
    expect(r.started).toHaveLength(2)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', paced: 1, heldAfterFailure: 1 })

    // An unanswered re-wake naming both: A's pace yields, P's hold does not.
    ws.simulateMessage(unanswered([P.conversation_id, A.conversation_id]))
    await until(() => r.started.length === 3, 'A again after the re-wake')
    expect(r.started[2]!.conversationId).toBe(A.conversation_id)
    r.ends[2]!({ status: 'completed' })
    await loop.idle()
    await briefly()

    // A reconnect (a new HELLO): nothing for P.
    cycles = loop.status().coalescer.cycles
    const sockets = MockWebSocket.instances.length
    ws.simulateClose()
    await until(() => MockWebSocket.instances.length > sockets, 'the reconnect')
    ws = connect()
    await settled(loop, cycles + 1, 'the reconnect cycle')
    expect(r.ids()).toEqual([P.conversation_id, A.conversation_id, A.conversation_id])
    expect(loop.status().processingFailures.held).toHaveLength(1)

    // A newer message in P: the hold ends, P runs on it; its failure is reported through the new anchor and retried.
    state.tray = trayOf([card(P.conversation_id, 'msg_poison04'), A])
    ws.simulateMessage(frame('msg_poison04', P.conversation_id, 4))
    await until(() => r.started.length === 4, 'P on the newer message')
    expect(r.started[3]!.conversationId).toBe(P.conversation_id)
    expect(loop.status().processingFailures.held).toEqual([])
    r.ends[3]!({ status: 'failed' })
    await until(() => r.started.length === 5, 'P again on retry')
    expect(report.mock.calls.map(([id, opts]) => [id, opts.throughMessageId])).toEqual([
      [P.conversation_id, 'msg_poison03'],
      [P.conversation_id, 'msg_poison04'],
    ])
    expect(reportsIn(events).map((e) => [e.result?.action, e.next])).toEqual([
      ['none', 'stop'],
      ['retry', 'rerun'],
    ])
    r.ends[4]!({ status: 'completed' })
    await loop.stop()
  })

  it('a run of it waiting for a slot waits for the answer: none drops it; retry starts it once, after the answer', async () => {
    for (const action of ['none', 'retry'] as const) {
      let answerNow: (a: ProcessingFailureAction) => void = () => undefined
      const { client, state, report } = fakeClient()
      report.mockImplementationOnce(() => new Promise<ProcessingFailureAction>((resolve) => (answerNow = resolve)))
      state.tray = trayOf([P])
      const r = runs()
      const { loop, events } = runLoop({ client, startRun: r.startRun })
      loop.wake()
      await until(() => r.started.length === 1)
      r.ends[0]!({ status: 'failed' }) // no evidence yet: it waits
      await until(() => loop.status().processingFailures.awaitingEvidence === 1)
      // The next wake: A runs, P waits behind it (its last run failed).
      state.tray = trayOf([P, A])
      loop.wake()
      await until(() => r.started.length === 2 && loop.status().counters.turnsWaiting === 1)
      expect(r.started[1]!.conversationId).toBe(A.conversation_id)
      // A completes (the evidence): the slot is free, but P's run waits for the server's answer.
      r.ends[1]!({ status: 'completed' })
      await until(() => report.mock.calls.length === 1, 'the report under way')
      await briefly()
      expect(r.started).toHaveLength(2)
      expect(loop.status().counters.turnsWaiting).toBe(1)
      // A wake meanwhile does not start it either.
      loop.wake()
      await briefly()
      expect(r.started).toHaveLength(2)
      answerNow(answer(action))
      if (action === 'none') {
        await until(() => loop.status().counters.turnsWaiting === 0, 'the waiting run dropped')
        await loop.idle()
        expect(r.started).toHaveLength(2)
        expect(loop.status().turns).toEqual([])
        expect(reportsIn(events)[0]).toMatchObject({ next: 'stop' })
        expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, reason: 'none' }])
      } else {
        await until(() => r.started.length === 3, 'P after the answer')
        expect(r.started[2]!.conversationId).toBe(P.conversation_id)
        expect(reportsIn(events)[0]).toMatchObject({ next: 'running' }) // its next run was already queued
        r.ends[2]!({ status: 'completed' })
        await loop.idle()
        expect(r.ids()).toEqual([P.conversation_id, A.conversation_id, P.conversation_id])
        expect(loop.status().processingFailures.held).toEqual([])
      }
      await loop.stop()
    }
  })

  it('a waiting failure reported on the runtime check is held while the check runs: a cycle meanwhile starts no run of it', async () => {
    let pass: (answer: { ok: boolean }) => void = () => undefined
    const checkRuntime = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => (pass = resolve)))
    const { client, state, report } = fakeClient([answer('none', { attempts: 3 })])
    state.tray = trayOf([P], { invites: [INVITE] })
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, checkRuntime })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' }) // P: the invite run is queued, so no check yet
    await until(() => r.started.length === 2)
    expect(r.started[1]!.kind).toBe('invite')
    expect(checkRuntime).not.toHaveBeenCalled()
    state.tray = trayOf([P])
    r.ends[1]!({ status: 'completed' }) // no evidence for a run; nothing else queued: the check for P
    await until(() => checkRuntime.mock.calls.length === 1, 'the runtime check')
    const cycles = loop.status().coalescer.cycles
    loop.wake() // a cycle while the check runs
    await until(() => loop.status().coalescer.cycles > cycles && loop.status().coalescer.state === 'idle', 'the cycle')
    expect(r.started).toHaveLength(2)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', heldByTurns: 1 })
    pass({ ok: true })
    await until(() => report.mock.calls.length === 1, 'the report')
    await loop.idle()
    expect(report.mock.calls[0]![1]).toMatchObject({ evidence: 'runtime_check', throughMessageId: 'msg_poison03' })
    loop.wake()
    await loop.idle()
    await briefly()
    expect(r.started).toHaveLength(2)
    expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, reason: 'none' }])
    await loop.stop()
  })

  it('paused holds the same way, also while the card is not shown muted', async () => {
    const { client, state, report } = fakeClient([answer('paused', { attempts: 3, paused_until: '2026-11-21T12:00:00.000Z' })])
    state.tray = trayOf([P, A])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' }) // P: A is queued behind it, the evidence
    await until(() => r.started.length === 2)
    r.ends[1]!({ status: 'completed' })
    await until(() => report.mock.calls.length === 1)
    await loop.idle()
    expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, anchor: 'msg_poison03', reason: 'paused' }])
    // Wakes: A goes on (a newer message), P stays held at its anchor.
    state.tray = trayOf([P, card(A.conversation_id, 'msg_alpha002')])
    loop.wake()
    await until(() => r.started.length === 3)
    expect(r.started[2]!.conversationId).toBe(A.conversation_id)
    r.ends[2]!({ status: 'completed' })
    await loop.idle()
    loop.wake()
    await loop.idle()
    await briefly()
    expect(r.ids()).toEqual([P.conversation_id, A.conversation_id, A.conversation_id])
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', heldAfterFailure: 1 })
    // A newer message in P lifts it.
    state.tray = trayOf([card(P.conversation_id, 'msg_poison04')])
    loop.wake()
    await until(() => r.started.length === 4)
    expect(r.started[3]!.conversationId).toBe(P.conversation_id)
    r.ends[3]!({ status: 'completed' })
    await loop.stop()
  })

  it('a card read meanwhile (a verdict, a mark-read) ends the hold; a truncated tray without it proves nothing', async () => {
    const { client, state, report } = fakeClient([answer('none', { attempts: 3 })])
    state.tray = trayOf([P])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' })
    await until(() => report.mock.calls.length === 1)
    await loop.idle()
    expect(loop.status().processingFailures.held).toHaveLength(1)
    // A truncated tray that does not show P: still held.
    state.tray = trayOf([A], { truncated: true })
    loop.wake()
    await until(() => r.started.length === 2)
    r.ends[1]!({ status: 'completed' })
    await loop.idle()
    expect(loop.status().processingFailures.held).toHaveLength(1)
    // A complete tray without P: the card was read; nothing left to hold.
    state.tray = trayOf([])
    loop.wake()
    await until(() => loop.status().lastCycle?.outcome === 'empty')
    expect(loop.status().processingFailures.held).toEqual([])
    // Back at the same anchor later (a deferred card's reminder): it runs again.
    state.tray = trayOf([P])
    loop.wake()
    await until(() => r.started.length === 3)
    expect(r.started[2]!.conversationId).toBe(P.conversation_id)
    r.ends[2]!({ status: 'completed' })
    await loop.stop()
  })

  it('gate-call mode: a reply turn answered none is not gated again while its anchor stands; an unanswered re-wake does not lift it; the other cards are gated', async () => {
    const { client, state, report } = fakeClient([answer('none', { attempts: 3 })])
    state.tray = trayOf([P])
    const t = turns()
    const callModel = vi.fn(async (prompt: string) => allAs('reply', prompt))
    const events: ReceiveLoopEvent[] = []
    const loop = new ReceiveLoop({
      mode: 'gateCall',
      client,
      texts: textsSource(served),
      callModel,
      startTurn: t.startTurn,
      checkRuntime: async () => ({ ok: true }),
      socket: { apiKey: 'ac_key', webSocket: MockWebSocketCtor },
      handle: '@example-relay',
      quietMs: 0,
      maxMs: 0,
      onEvent: (e) => events.push(e),
    })
    await loop.start()
    const ws = connect()
    await until(() => t.started.length === 1, 'P’s turn')
    t.ends[0]!({ status: 'failed', detail: 'API error: refused' })
    await until(() => report.mock.calls.length === 1)
    await briefly()
    expect(reportsIn(events)[0]).toMatchObject({ source: 'turn', result: { action: 'none' }, next: 'stop' })
    expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, anchor: 'msg_poison03' }])

    // A message elsewhere: B is gated, P is not.
    state.tray = trayOf([P, B])
    ws.simulateMessage(frame('msg_bravo001', B.conversation_id, 1))
    await until(() => t.started.length === 2, 'B’s turn')
    expect(idsIn(callModel.mock.calls.at(-1)![0])).toEqual([B.conversation_id])
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', heldAfterFailure: 1 })
    state.tray = trayOf([P])
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await briefly()
    // An unanswered re-wake naming P: still no gate call for it.
    const calls = callModel.mock.calls.length
    const cycles = loop.status().coalescer.cycles
    ws.simulateMessage(unanswered([P.conversation_id]))
    await settled(loop, cycles + 1, 'the re-wake cycle')
    expect(callModel.mock.calls.length).toBe(calls)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', heldAfterFailure: 1 })
    expect(t.started).toHaveLength(2)

    // A newer message in P: gated again.
    state.tray = trayOf([card(P.conversation_id, 'msg_poison04')])
    ws.simulateMessage(frame('msg_poison04', P.conversation_id, 4))
    await until(() => t.started.length === 3, 'P on the newer message')
    expect(t.started[2]).toMatchObject({ kind: 'reply', conversationId: P.conversation_id, anchor: 'msg_poison04' })
    t.ends[2]!({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await loop.stop()
  })

  it('gate-call mode: a single-card gate call answered none is not gated again; a newer message gates it alone', async () => {
    const POISON = card('conv_poison0001', 'msg_poison03', {
      preview: { ...sample.conversations[0]!.preview!, message_id: 'msg_poison03', text: 'POISON: content the model refuses' },
    })
    const { client, state, report } = fakeClient([answer('none', { attempts: 3 })])
    state.tray = trayOf([POISON])
    const callModel = vi.fn(async (prompt: string) => {
      if (prompt.includes('POISON')) throw new Error('the provider refused the request')
      return allAs('dismiss', prompt)
    })
    const { loop } = gateLoop({ client, callModel, checkRuntime: async () => ({ ok: true }) })
    loop.wake()
    await until(() => report.mock.calls.length === 1)
    await loop.idle()
    expect(report.mock.calls[0]![1]).toMatchObject({ evidence: 'runtime_check', throughMessageId: 'msg_poison03' })
    state.tray = trayOf([POISON, B])
    for (let i = 0; i < 2; i++) {
      loop.wake()
      await loop.idle()
      await briefly()
    }
    expect(callModel.mock.calls.filter(([prompt]) => prompt.includes('POISON'))).toHaveLength(1)
    expect(callModel.mock.calls.slice(1).map(([prompt]) => idsIn(prompt))).toEqual([[B.conversation_id], [B.conversation_id]])
    state.tray = trayOf([{ ...POISON, preview: { ...POISON.preview!, message_id: 'msg_poison04', text: 'hello again' } }])
    loop.wake()
    await until(() => callModel.mock.calls.length === 4)
    expect(idsIn(callModel.mock.calls[3]![0])).toEqual([POISON.conversation_id])
    expect(loop.status().processingFailures.held).toEqual([])
    await loop.stop()
  })
})

// ─── the hold at the start itself: an answer that came after the card was read ──

describe('could not process: the hold is checked when a run or turn starts', () => {
  /** Gate-call mode with two slots: P's turn fails while B's runs, so P waits for evidence; the next gate (P, A) answers when the test says. */
  async function gateWithParkedP(answers: Parameters<typeof fakeClient>[0], reportFirst?: Promise<ProcessingFailureAction>) {
    const fake = fakeClient(answers)
    if (reportFirst) fake.report.mockImplementationOnce(() => reportFirst)
    fake.state.tray = trayOf([P, B])
    const t = turns()
    let release: () => void = () => undefined
    const callModel = vi.fn((prompt: string) => {
      if (callModel.mock.calls.length === 2) return new Promise<string>((r) => (release = () => r(allAs('reply', prompt))))
      return Promise.resolve(allAs('reply', prompt))
    })
    const { loop } = gateLoop({ client: fake.client, callModel, startTurn: t.startTurn, maxConcurrentTurns: 2 })
    loop.wake()
    await until(() => t.started.length === 2, 'P and B')
    t.ends[0]!({ status: 'failed' }) // P; B still runs: no evidence yet
    await until(() => loop.status().processingFailures.awaitingEvidence === 1)
    fake.state.tray = trayOf([P, A])
    loop.wake()
    await until(() => callModel.mock.calls.length === 2, 'the gate call for P and A')
    t.ends[1]!({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } }) // B: the evidence for P
    await until(() => fake.report.mock.calls.length === 1, 'the report')
    return { ...fake, t, loop, release: () => release() }
  }
  const startedIds = (t: ReturnType<typeof turns>) => t.started.map((r) => (r as { conversationId: string }).conversationId)

  it('gate-call mode: none lands while the gate call carrying the card is out; the gate says reply; no turn starts at the held anchor', async () => {
    const { t, loop, release } = await gateWithParkedP([answer('none', { attempts: 3 })])
    await briefly()
    expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, anchor: 'msg_poison03' }])
    release()
    await until(() => t.started.length === 3, 'A’s turn')
    await loop.idle()
    await briefly()
    expect(startedIds(t)).toEqual([P.conversation_id, B.conversation_id, A.conversation_id])
    expect(loop.status().processingFailures.startsHeld).toBe(1)
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'decided', heldAfterFailure: 1 })
    await loop.stop()
  })

  it('gate-call mode: the gate answers while the report is still out; the turn waits for the answer (with a slot free) and none drops it', async () => {
    let answerNow: (a: ProcessingFailureAction) => void = () => undefined
    const pending = new Promise<ProcessingFailureAction>((resolve) => (answerNow = resolve))
    const { t, loop, release } = await gateWithParkedP([], pending)
    release()
    await until(() => t.started.length === 3, 'A’s turn')
    await briefly()
    expect(startedIds(t)).toEqual([P.conversation_id, B.conversation_id, A.conversation_id])
    expect(loop.status().counters.turnsWaiting).toBe(1) // P's, waiting for the answer
    answerNow(answer('none'))
    await until(() => loop.status().counters.turnsWaiting === 0, 'P’s turn dropped')
    await briefly()
    expect(t.started).toHaveLength(3)
    expect(loop.status().processingFailures.startsHeld).toBe(1)
    await loop.stop()
  })

  it('conversation runs: none lands while the cycle waits on its readiness check; the run of the card it read does not start', async () => {
    let answerNow: (a: ProcessingFailureAction) => void = () => undefined
    const { client, state, report } = fakeClient()
    report.mockImplementationOnce(() => new Promise<ProcessingFailureAction>((resolve) => (answerNow = resolve)))
    state.tray = trayOf([P, A])
    const r = runs()
    let ready: (() => void) | null = null
    let slow = false
    const readiness = async (): Promise<{ ready: true }> => {
      if (slow) await new Promise<void>((resolve) => (ready = resolve))
      return { ready: true }
    }
    const { loop } = runLoop({ client, startRun: r.startRun, maxConcurrentTurns: 2, readiness })
    loop.wake()
    await until(() => r.started.length === 2, 'P and A')
    r.ends[0]!({ status: 'failed' }) // P; A still runs
    await until(() => loop.status().processingFailures.awaitingEvidence === 1)
    slow = true
    loop.wake() // reads [P, A]: A is running, P is owed; the cycle waits on readiness
    await until(() => ready !== null, 'the cycle in its readiness check')
    r.ends[1]!({ status: 'completed' }) // A: the evidence for P
    await until(() => report.mock.calls.length === 1)
    answerNow(answer('none'))
    await until(() => (loop.status().processingFailures.held ?? []).length === 1, 'the hold')
    ready!()
    await loop.idle()
    await briefly()
    expect(r.ids()).toEqual([P.conversation_id, A.conversation_id])
    expect(loop.status().processingFailures.startsHeld).toBe(1)
    await loop.stop()
  })

  it('none keeps a run waiting at a newer anchor (new input); paused drops it', async () => {
    for (const action of ['none', 'paused'] as const) {
      const { client, state, report } = fakeClient([answer(action, { attempts: 3 })])
      state.tray = trayOf([P])
      const r = runs()
      const { loop } = runLoop({ client, startRun: r.startRun })
      loop.wake()
      await until(() => r.started.length === 1)
      r.ends[0]!({ status: 'failed' }) // P at msg_poison03: no evidence yet
      await until(() => loop.status().processingFailures.awaitingEvidence === 1)
      // A newer message in P: its run waits behind A's (its last run failed).
      state.tray = trayOf([card(P.conversation_id, 'msg_poison04'), A])
      loop.wake()
      await until(() => r.started.length === 2 && loop.status().counters.turnsWaiting === 1)
      r.ends[1]!({ status: 'completed' }) // A: the evidence; the report is through msg_poison03
      await until(() => report.mock.calls.length === 1)
      expect(report.mock.calls[0]![1]).toMatchObject({ throughMessageId: 'msg_poison03' })
      if (action === 'none') {
        await until(() => r.started.length === 3, 'P on its newer message')
        expect(r.started[2]!.conversationId).toBe(P.conversation_id)
        r.ends[2]!({ status: 'completed' })
        await loop.idle()
        // The next tray shows the newer anchor: the old hold is gone from status.
        loop.wake()
        await loop.idle()
        await briefly()
        expect(loop.status().processingFailures.held).toEqual([])
      } else {
        await until(() => loop.status().counters.turnsWaiting === 0)
        await loop.idle()
        await briefly()
        expect(r.started).toHaveLength(2)
        expect(loop.status().processingFailures.startsHeld).toBe(1)
      }
      await loop.stop()
    }
  })

  it('a run of it already under way when none lands, ending silent at that anchor, does not lift the hold', async () => {
    const { client, state, report } = fakeClient([answer('none', { attempts: 3 })])
    state.tray = trayOf([P])
    const r = runs()
    const { loop } = runLoop({ client, startRun: r.startRun, maxConcurrentTurns: 2 })
    loop.wake()
    await until(() => r.started.length === 1)
    r.ends[0]!({ status: 'failed' }) // no evidence yet
    await until(() => loop.status().processingFailures.awaitingEvidence === 1)
    state.tray = trayOf([P, A])
    loop.wake()
    await until(() => r.started.length === 3, 'A and P again, two slots')
    const a = r.ids().indexOf(A.conversation_id, 1)
    const p = a === 1 ? 2 : 1
    r.ends[a]!({ status: 'completed' }) // A: the evidence; none holds P at msg_poison03
    await until(() => report.mock.calls.length === 1)
    await until(() => (loop.status().processingFailures.held ?? []).length === 1)
    r.ends[p]!({ status: 'completed' }) // P's run under way ends silent at the same anchor
    await loop.idle()
    loop.wake()
    await loop.idle()
    await briefly()
    expect(r.started).toHaveLength(3)
    expect(loop.status().processingFailures.held).toMatchObject([{ conversationId: P.conversation_id, anchor: 'msg_poison03' }])
    expect(loop.status().lastCycle).toMatchObject({ outcome: 'nothing_owed', heldAfterFailure: 1 })
    await loop.stop()
  })
})

describe('could not process: no wake loop', () => {
  it('a card whose gate call keeps failing, a runtime check that fails and a turn that runs on: one wake is one cycle, not a spin', async () => {
    const X = card('conv_xray000001', 'msg_xray0001', {
      preview: { ...sample.conversations[0]!.preview!, message_id: 'msg_xray0001', text: 'POISON x' },
    })
    const { client, state, report } = fakeClient()
    state.tray = trayOf([B, X])
    const t = turns()
    const callModel = vi.fn(async (prompt: string) => {
      if (prompt.includes('POISON')) throw new Error('refused')
      return allAs('reply', prompt)
    })
    const checkRuntime = vi.fn(async () => ({ ok: false }))
    const { loop } = gateLoop({ client, callModel, startTurn: t.startTurn, checkRuntime })
    loop.wake()
    await until(() => t.started.length === 1, 'B’s turn') // it runs on and does not end
    await loop.idle()
    await briefly()
    const calls = callModel.mock.calls.length
    const checks = checkRuntime.mock.calls.length
    const cycles = loop.status().coalescer.cycles
    loop.wake()
    await new Promise((r) => setTimeout(r, 200))
    await loop.idle()
    expect(loop.status().coalescer.cycles - cycles).toBeLessThanOrEqual(2)
    expect(callModel.mock.calls.length - calls).toBeLessThanOrEqual(2)
    expect(checkRuntime.mock.calls.length - checks).toBeLessThanOrEqual(2)
    expect(report).not.toHaveBeenCalled()
    await loop.stop()
  })
})

describe('Pacer: could-not-process holds beside D5 paces', () => {
  it('bounds paces and holds apart; a tray read lifts only holds made before it; a moved anchor lifts one, an absent card only on a complete tray', () => {
    let clock = 1_000
    const pacer = new Pacer(60_000, () => clock)
    pacer.holdFailed('conversation:p', 'm1', 'none')
    for (let i = 0; i < 1_500; i++) pacer.hold(`conversation:c${i}`, 'm')
    expect(pacer.failed().map((h) => h.key)).toEqual(['conversation:p']) // paces never push a hold out
    for (let i = 0; i < 1_000; i++) {
      clock += 1
      pacer.holdFailed(`conversation:h${i}`, 'm', 'paused')
    }
    const held = pacer.failed()
    expect(held).toHaveLength(1_000)
    expect(held[0]!.key).toBe('conversation:h0') // the oldest hold went first
    expect(pacer.check('conversation:c1499', 'm')).toBe('paced')

    const fresh = new Pacer(60_000, () => clock)
    const before = fresh.mark()
    fresh.holdFailed('conversation:p', 'm1', 'none')
    fresh.keepFailedOn(new Map(), before, true) // a read that began before the hold
    expect(fresh.heldFailedAt('conversation:p', 'm1')).toBe(true)
    fresh.keepFailedOn(new Map(), fresh.mark(), false) // truncated, card not shown: proves nothing
    expect(fresh.heldFailedAt('conversation:p', 'm1')).toBe(true)
    fresh.hold('conversation:p', 'm1') // a pace at the same anchor does not replace it
    expect(fresh.check('conversation:p', 'm1')).toBe('failed')
    fresh.releasePace('conversation:p') // an unanswered wake
    expect(fresh.heldFailedAt('conversation:p', 'm1')).toBe(true)
    expect(fresh.heldFailedAt('conversation:p', 'm0')).toBe(false) // an older anchor neither matches nor lifts it
    expect(fresh.heldFailedAt('conversation:p', 'm1')).toBe(true)
    fresh.keepFailedOn(new Map([['conversation:p', 'm2']]), fresh.mark(), false) // a newer anchor shown
    expect(fresh.failed()).toEqual([])
    fresh.holdFailed('conversation:q', 'm1', 'none')
    fresh.keepFailedOn(new Map(), fresh.mark(), true) // a complete tray without it: read
    expect(fresh.failed()).toEqual([])
  })
})
