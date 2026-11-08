import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { anchorOf, buildPrompt, mcpToolNamer, run, type GateClient } from '../src/gate.js'
import type { InboxTray, ReplyDecision, Texts } from '../src/types/index.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../conformance/v1')
const sampleTray = (): InboxTray =>
  JSON.parse(readFileSync(resolve(FIXTURES, 'tray.sample.json'), 'utf8')) as InboxTray

// The served texts: the gate call's preamble and answer format come from here (D6).
const texts = JSON.parse(readFileSync(resolve(FIXTURES, 'texts.sample.json'), 'utf8')) as Texts

const IDS = {
  direct: 'conv_direct0first01',
  crew: 'conv_group0crew0001',
  ops: 'conv_group0ops00001',
  gone: 'conv_group0gone0001',
}

const decisionRow = (conversationId: string, decision: ReplyDecision['decision'] = 'dismiss'): ReplyDecision => ({
  id: `dec_${conversationId}`,
  conversation_id: conversationId,
  decision,
  category: null,
  through_message_id: null,
  defer_until: null,
  created_at: '2026-11-04T23:00:00.000Z',
})

function fakeClient(impl?: (conversationId: string, opts: { decision: string }) => Promise<ReplyDecision>) {
  const record = vi.fn(
    impl ??
      (async (conversationId: string, opts: { decision: string }) =>
        decisionRow(conversationId, opts.decision as ReplyDecision['decision'])),
  )
  const client: GateClient = { decisions: { record } }
  return { client, record }
}

const answer = (entries: Array<Record<string, unknown>>) => JSON.stringify({ decisions: entries })

describe('gate.buildPrompt', () => {
  it('opens with the served gate-call preamble, then the served question verbatim', () => {
    const tray = sampleTray()
    const prompt = buildPrompt(tray, { texts })
    const [preamble, ...rest] = prompt.split('\n\n')
    expect(preamble).toBe(texts.gate_call_preamble)
    expect(rest.join('\n\n').startsWith(tray.question)).toBe(true)
  })

  it('ends with the served answer format verbatim', () => {
    const prompt = buildPrompt(sampleTray(), { texts })
    expect(prompt.endsWith(`\n\n${texts.gate_call_answer_format}`)).toBe(true)
  })

  it('carries no gate-call text of its own: other served texts change the prompt', () => {
    const custom = { gate_call_preamble: 'PREAMBLE AS SERVED', gate_call_answer_format: 'FORMAT AS SERVED' }
    const prompt = buildPrompt(sampleTray(), { texts: custom })
    expect(prompt.startsWith('PREAMBLE AS SERVED\n\n')).toBe(true)
    expect(prompt.endsWith('\n\nFORMAT AS SERVED')).toBe(true)
    expect(prompt).not.toContain('You are triaging')
  })

  it('without texts: the legacy wording, byte for byte what 1.2 sent (gate-prompt.expected.txt)', () => {
    const tray = sampleTray()
    const expected = readFileSync(resolve(FIXTURES, 'gate-prompt.expected.txt'), 'utf8')
    expect(buildPrompt(tray) + '\n').toBe(expected)
    expect(buildPrompt(tray, { texts: null }) + '\n').toBe(expected)
    expect(buildPrompt(tray, {}) + '\n').toBe(expected)
  })

  it('a served field wins; a missing or blank one falls back to the legacy wording, field by field', () => {
    const tray = sampleTray()
    const legacy = buildPrompt(tray).split('\n\n')
    const onlyPreamble = buildPrompt(tray, { texts: { gate_call_preamble: 'SERVED PREAMBLE' } }).split('\n\n')
    expect(onlyPreamble[0]).toBe('SERVED PREAMBLE')
    expect(onlyPreamble.at(-1)).toBe(legacy.at(-1))
    const onlyFormat = buildPrompt(tray, { texts: { gate_call_preamble: '  ', gate_call_answer_format: 'SERVED FORMAT' } }).split('\n\n')
    expect(onlyFormat[0]).toBe(legacy[0])
    expect(onlyFormat.at(-1)).toBe('SERVED FORMAT')
  })

  it('legacy: spells hosted tool names through the namer, in the preamble and the question alike', () => {
    const tray = sampleTray()
    const prompt = buildPrompt(tray, { toolNamer: mcpToolNamer('agentchat') })
    const inQuestion = tray.question.match(/agentchat_decide/g)?.length ?? 0
    expect(inQuestion).toBeGreaterThan(0)
    expect(prompt.match(/mcp__agentchat__agentchat_decide/g)).toHaveLength(1 + inQuestion)
    expect(prompt).not.toMatch(/(^|[^_])agentchat_decide/)
  })

  it('legacy: omits the category field from the answer shape when the server serves no categories', () => {
    const prompt = buildPrompt({ ...sampleTray(), categories: [] })
    expect(prompt).not.toContain('Categories:')
    expect(prompt).not.toContain('"category": "<one of')
    expect(prompt).toContain('"decision": "reply" | "dismiss" | "defer"}]}')
  })

  it('spells hosted tool names in the question through the namer; the served preamble is used as served', () => {
    const tray = sampleTray()
    const prompt = buildPrompt(tray, { texts, toolNamer: mcpToolNamer('agentchat') })
    const inQuestion = tray.question.match(/agentchat_decide/g)?.length ?? 0
    expect(inQuestion).toBeGreaterThan(0)
    expect(prompt.match(/mcp__agentchat__agentchat_decide/g)).toHaveLength(inQuestion)
    expect(prompt.startsWith(`${texts.gate_call_preamble}\n\n`)).toBe(true)
    // The rest of the question is untouched.
    expect(prompt).toContain('On this network silence is a valid reply.')
  })

  it('is identical to the served text with the default namer', () => {
    const tray = sampleTray()
    expect(buildPrompt(tray, { texts })).toBe(buildPrompt(tray, { texts, toolNamer: (t) => t }))
  })

  it('throws when the tray carries no question', () => {
    const tray = { ...sampleTray(), question: '' }
    expect(() => buildPrompt(tray, { texts })).toThrow(/no question/)
  })

  it('omits the category list when the server serves none', () => {
    const tray = { ...sampleTray(), categories: [] }
    const prompt = buildPrompt(tray, { texts })
    expect(prompt).not.toContain('Categories:')
  })

  it('renders cards with sorted keys regardless of server key order', () => {
    const tray = sampleTray()
    const [first, ...rest] = tray.conversations
    // Reverse the key order of one card; the prompt must not change.
    const reversed = Object.fromEntries(Object.entries(first!).reverse()) as typeof first
    expect(buildPrompt({ ...tray, conversations: [reversed!, ...rest] }, { texts })).toBe(buildPrompt(tray, { texts }))
  })
})

describe('gate.anchorOf', () => {
  it('prefers the preview message, falls back to last_message_id, else undefined', () => {
    const card = sampleTray().conversations[0]!
    expect(anchorOf(card)).toBe('msg_nova0first00001a')
    expect(anchorOf({ ...card, preview: null, last_message_id: 'msg_last0000000001' })).toBe('msg_last0000000001')
    expect(anchorOf({ ...card, preview: null, last_message_id: null })).toBeUndefined()
    expect(anchorOf({ ...card, preview: null })).toBeUndefined()
  })
})

describe('gate.run', () => {
  it('records dismiss and defer at once with each card anchor; replies wait for record()', async () => {
    const tray = sampleTray()
    const { client, record } = fakeClient()
    const callModel = vi.fn(async () =>
      answer([
        { conversation_id: IDS.direct, decision: 'reply', category: 'open_request' },
        { conversation_id: IDS.crew, decision: 'dismiss', category: 'acknowledgement' },
        { conversation_id: IDS.ops, decision: 'defer', category: 'goal_followup' },
        { conversation_id: IDS.gone, decision: 'dismiss', category: 'no_action_needed' },
      ]),
    )

    const result = await run({ texts, tray, callModel, client })

    expect(callModel).toHaveBeenCalledWith(buildPrompt(tray, { texts }))
    expect(result.outcome).toBe('decided')
    expect(result.undecided).toEqual([])
    expect(result.recorded).toBe(3)
    expect(result.recordFailures).toEqual([])
    expect(record).toHaveBeenCalledTimes(3)
    expect(record).toHaveBeenNthCalledWith(1, IDS.crew, {
      decision: 'dismiss',
      category: 'acknowledgement',
      throughMessageId: 'msg_crew0thanks0001b',
    })
    expect(record).toHaveBeenNthCalledWith(2, IDS.ops, {
      decision: 'defer',
      category: 'goal_followup',
      throughMessageId: 'msg_ops0mention001c',
    })
    expect(record.mock.calls.some(([id]) => id === IDS.direct)).toBe(false)

    // The reply: nothing recorded until the host says the turn has started.
    expect(result.reply.map((r) => r.conversationId)).toEqual([IDS.direct])
    const reply = result.reply[0]!
    expect(reply.card).toEqual(tray.conversations[0])
    expect(reply.category).toBe('open_request')

    const recordedReply = await reply.record()
    expect(recordedReply.decision).toBe('reply')
    expect(record).toHaveBeenLastCalledWith(IDS.direct, {
      decision: 'reply',
      category: 'open_request',
      throughMessageId: 'msg_nova0first00001a',
    })
  })

  it('record() on a reply is idempotent on success and retryable after failure', async () => {
    let fail = true
    const { client, record } = fakeClient(async (conversationId, opts) => {
      if (fail) throw new Error('503')
      return decisionRow(conversationId, opts.decision as ReplyDecision['decision'])
    })
    const result = await run({
      texts,
      tray: sampleTray(),
      callModel: async () => answer([{ conversation_id: IDS.direct, decision: 'reply' }]),
      client,
    })
    const reply = result.reply[0]!
    await expect(reply.record()).rejects.toThrow(/503/)
    fail = false
    const first = reply.record()
    const second = reply.record()
    expect(second).toBe(first)
    await expect(first).resolves.toMatchObject({ decision: 'reply' })
    await expect(reply.record()).resolves.toMatchObject({ decision: 'reply' })
    expect(record).toHaveBeenCalledTimes(2) // one failed, one succeeded
  })

  it('passes the namer through to the prompt', async () => {
    const tray = sampleTray()
    const { client } = fakeClient()
    const callModel = vi.fn(async () => answer([{ conversation_id: IDS.crew, decision: 'dismiss' }]))
    await run({ texts, tray, callModel, client, toolNamer: mcpToolNamer('ac') })
    expect(callModel.mock.calls[0]?.[0]).toContain('mcp__ac__agentchat_decide')
  })

  it('without texts: decides with the legacy prompt, exactly as 1.2 did', async () => {
    const tray = sampleTray()
    const { client, record } = fakeClient()
    const callModel = vi.fn(async () => answer([{ conversation_id: IDS.crew, decision: 'dismiss' }]))
    const result = await run({ tray, callModel, client })
    expect(result.outcome).toBe('decided')
    expect(callModel).toHaveBeenCalledWith(buildPrompt(tray))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('records nothing and fails closed when the model call throws', async () => {
    const { client, record } = fakeClient()
    const result = await run({
      texts,
      tray: sampleTray(),
      callModel: async () => {
        throw new Error('provider down')
      },
      client,
    })
    expect(result.outcome).toBe('fail_closed')
    expect(result.failure).toMatch(/provider down/)
    expect(result.reply).toEqual([])
    expect(result.undecided).toEqual(Object.values(IDS))
    expect(record).not.toHaveBeenCalled()
  })

  it('records nothing and fails closed when the answer has no usable verdict', async () => {
    const { client, record } = fakeClient()
    for (const text of ['', 'Reply to Nova, dismiss the rest.', answer([{ conversation_id: IDS.direct, decision: 'maybe' }])]) {
      const result = await run({ texts, tray: sampleTray(), callModel: async () => text, client })
      expect(result.outcome).toBe('fail_closed')
      expect(result.failure).toMatch(/no usable verdicts/)
    }
    expect(record).not.toHaveBeenCalled()
  })

  it('fails closed without a model call when the tray has no question', async () => {
    const { client, record } = fakeClient()
    const callModel = vi.fn(async () => '')
    const result = await run({ texts, tray: { ...sampleTray(), question: '' }, callModel, client })
    expect(result.outcome).toBe('fail_closed')
    expect(callModel).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('returns `empty` for a tray without cards and never calls the model', async () => {
    const { client, record } = fakeClient()
    const callModel = vi.fn(async () => '')
    const result = await run({ texts, tray: { ...sampleTray(), conversations: [] }, callModel, client })
    expect(result).toEqual({
      outcome: 'empty',
      reply: [],
      verdicts: [],
      undecided: [],
      recorded: 0,
      recordFailures: [],
      failure: null,
    })
    expect(callModel).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('lists cards the model skipped as undecided and still records the rest', async () => {
    const { client, record } = fakeClient()
    const result = await run({
      texts,
      tray: sampleTray(),
      callModel: async () => answer([{ conversation_id: IDS.crew, decision: 'dismiss', category: 'closing' }]),
      client,
    })
    expect(result.outcome).toBe('decided')
    expect(result.undecided).toEqual([IDS.direct, IDS.ops, IDS.gone])
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('reports an immediate verdict the server refused and keeps going', async () => {
    const { client, record } = fakeClient(async (conversationId, opts) => {
      if (conversationId === IDS.crew) throw new Error('503 from server')
      return decisionRow(conversationId, opts.decision as ReplyDecision['decision'])
    })
    const result = await run({
      texts,
      tray: sampleTray(),
      callModel: async () =>
        answer([
          { conversation_id: IDS.crew, decision: 'dismiss' },
          { conversation_id: IDS.gone, decision: 'dismiss' },
        ]),
      client,
    })
    expect(result.outcome).toBe('decided')
    expect(result.recorded).toBe(1)
    expect(result.recordFailures).toHaveLength(1)
    expect(result.recordFailures[0]?.conversation_id).toBe(IDS.crew)
    expect(result.recordFailures[0]?.error.message).toMatch(/503/)
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('omits the category when the model gave none, and anchors on last_message_id when the card has no preview', async () => {
    const tray = sampleTray()
    tray.conversations[3] = { ...tray.conversations[3]!, preview: null, last_message_id: 'msg_gone0deleted01d' }
    tray.conversations[1] = { ...tray.conversations[1]!, preview: null }
    const { client, record } = fakeClient()
    await run({
      texts,
      tray,
      callModel: async () =>
        answer([
          { conversation_id: IDS.gone, decision: 'dismiss', category: 'urgent' },
          { conversation_id: IDS.crew, decision: 'dismiss' },
        ]),
      client,
    })
    expect(record).toHaveBeenNthCalledWith(1, IDS.gone, {
      decision: 'dismiss',
      category: undefined,
      throughMessageId: 'msg_gone0deleted01d',
    })
    // Neither preview nor last_message_id: recorded unanchored.
    expect(record).toHaveBeenNthCalledWith(2, IDS.crew, {
      decision: 'dismiss',
      category: undefined,
      throughMessageId: undefined,
    })
  })
})
