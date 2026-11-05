import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildPrompt, mcpToolNamer, run, type GateClient } from '../src/gate.js'
import type { InboxTray, ReplyDecision } from '../src/types/index.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../conformance/v1')
const sampleTray = (): InboxTray =>
  JSON.parse(readFileSync(resolve(FIXTURES, 'tray.sample.json'), 'utf8')) as InboxTray

const IDS = {
  direct: 'conv_direct0first01',
  crew: 'conv_group0crew0001',
  ops: 'conv_group0ops00001',
  gone: 'conv_group0gone0001',
}

function fakeClient(impl?: (conversationId: string) => Promise<ReplyDecision>) {
  const record = vi.fn(
    impl ??
      (async (conversationId: string): Promise<ReplyDecision> => ({
        id: 'dec_1',
        conversation_id: conversationId,
        decision: 'dismiss',
        category: null,
        through_message_id: null,
        defer_until: null,
        created_at: '2026-11-04T23:00:00.000Z',
      })),
  )
  const client: GateClient = { decisions: { record } }
  return { client, record }
}

const answer = (entries: Array<Record<string, unknown>>) => JSON.stringify({ decisions: entries })

describe('gate.buildPrompt', () => {
  it('spells hosted tool names per runtime through the namer, nothing else', () => {
    const tray = sampleTray()
    const prompt = buildPrompt(tray, { toolNamer: mcpToolNamer('agentchat') })
    expect(prompt).toContain('mcp__agentchat__agentchat_decide')
    expect(prompt).not.toMatch(/(^|[^_])agentchat_decide/)
    // The rest of the question is untouched.
    expect(prompt).toContain('On this network silence is a valid reply.')
  })

  it('is identical to the served text with the default namer', () => {
    const tray = sampleTray()
    expect(buildPrompt(tray)).toBe(buildPrompt(tray, { toolNamer: (t) => t }))
  })

  it('throws when the tray carries no question', () => {
    const tray = { ...sampleTray(), question: '' }
    expect(() => buildPrompt(tray)).toThrow(/no question/)
  })

  it('omits the category list and field when the server serves none', () => {
    const tray = { ...sampleTray(), categories: [] }
    const prompt = buildPrompt(tray)
    expect(prompt).not.toContain('Categories:')
    expect(prompt).not.toContain('"category": "<one of')
    expect(prompt).toContain('"decision": "reply" | "dismiss" | "defer"}]}')
  })

  it('renders cards with sorted keys regardless of server key order', () => {
    const tray = sampleTray()
    const [first, ...rest] = tray.conversations
    // Reverse the key order of one card; the prompt must not change.
    const reversed = Object.fromEntries(Object.entries(first!).reverse()) as typeof first
    expect(buildPrompt({ ...tray, conversations: [reversed!, ...rest] })).toBe(buildPrompt(tray))
  })
})

describe('gate.run', () => {
  it('records all three verdicts with each card anchor and returns the reply set', async () => {
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

    const result = await run({ tray, callModel, client })

    expect(callModel).toHaveBeenCalledWith(buildPrompt(tray))
    expect(result.outcome).toBe('decided')
    expect(result.reply).toEqual([IDS.direct])
    expect(result.undecided).toEqual([])
    expect(result.recorded).toBe(4)
    expect(result.recordFailures).toEqual([])
    expect(record).toHaveBeenCalledTimes(4)
    expect(record).toHaveBeenNthCalledWith(1, IDS.direct, {
      decision: 'reply',
      category: 'open_request',
      throughMessageId: 'msg_nova0first00001a',
    })
    expect(record).toHaveBeenNthCalledWith(3, IDS.ops, {
      decision: 'defer',
      category: 'goal_followup',
      throughMessageId: 'msg_ops0mention001c',
    })
  })

  it('passes the namer through to the prompt', async () => {
    const tray = sampleTray()
    const { client } = fakeClient()
    const callModel = vi.fn(async () => answer([{ conversation_id: IDS.crew, decision: 'dismiss' }]))
    await run({ tray, callModel, client, toolNamer: mcpToolNamer('ac') })
    expect(callModel.mock.calls[0]?.[0]).toContain('mcp__ac__agentchat_decide')
  })

  it('records nothing and fails closed when the model call throws', async () => {
    const { client, record } = fakeClient()
    const result = await run({
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
      const result = await run({ tray: sampleTray(), callModel: async () => text, client })
      expect(result.outcome).toBe('fail_closed')
      expect(result.failure).toMatch(/no usable verdicts/)
    }
    expect(record).not.toHaveBeenCalled()
  })

  it('fails closed without a model call when the tray has no question', async () => {
    const { client, record } = fakeClient()
    const callModel = vi.fn(async () => '')
    const result = await run({ tray: { ...sampleTray(), question: '' }, callModel, client })
    expect(result.outcome).toBe('fail_closed')
    expect(callModel).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('returns `empty` for a tray without cards and never calls the model', async () => {
    const { client, record } = fakeClient()
    const callModel = vi.fn(async () => '')
    const result = await run({ tray: { ...sampleTray(), conversations: [] }, callModel, client })
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
      tray: sampleTray(),
      callModel: async () => answer([{ conversation_id: IDS.crew, decision: 'dismiss', category: 'closing' }]),
      client,
    })
    expect(result.outcome).toBe('decided')
    expect(result.undecided).toEqual([IDS.direct, IDS.ops, IDS.gone])
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('keeps a reply in the reply set when recording it fails, and reports the failure', async () => {
    const { client, record } = fakeClient(async (conversationId) => {
      if (conversationId === IDS.direct) throw new Error('503 from server')
      return {
        id: 'dec_2',
        conversation_id: conversationId,
        decision: 'dismiss',
        category: null,
        through_message_id: null,
        defer_until: null,
        created_at: '2026-11-04T23:00:00.000Z',
      }
    })
    const result = await run({
      tray: sampleTray(),
      callModel: async () =>
        answer([
          { conversation_id: IDS.direct, decision: 'reply' },
          { conversation_id: IDS.crew, decision: 'dismiss' },
        ]),
      client,
    })
    expect(result.reply).toEqual([IDS.direct])
    expect(result.recorded).toBe(1)
    expect(result.recordFailures).toHaveLength(1)
    expect(result.recordFailures[0]?.conversation_id).toBe(IDS.direct)
    expect(result.recordFailures[0]?.error.message).toMatch(/503/)
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('omits the category when the model gave none, and the anchor when the card has no preview', async () => {
    const tray = sampleTray()
    tray.conversations[1]!.preview = null
    const { client, record } = fakeClient()
    await run({
      tray,
      callModel: async () => answer([{ conversation_id: IDS.crew, decision: 'dismiss', category: 'urgent' }]),
      client,
    })
    expect(record).toHaveBeenCalledWith(IDS.crew, {
      decision: 'dismiss',
      category: undefined,
      throughMessageId: undefined,
    })
  })
})
