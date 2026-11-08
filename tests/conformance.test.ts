import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import { buildPrompt, canonicalJson, parseVerdicts, type Verdict } from '../src/gate.js'
import type { InboxTray, WakeFrame } from '../src/types/index.js'
import { MockWebSocket, MockWebSocketCtor, sentFrames, settle } from './helpers/mock-websocket.js'

// ─── The shared conformance fixtures ────────────────────────────────────────
//
// `conformance/v1/` holds the cases every AgentChat SDK must pass, byte for
// byte identical across the TypeScript and Python repos. Tests load the
// files; nothing here restates their content.

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../conformance/v1')

function raw(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8')
}

function json<T>(name: string): T {
  return JSON.parse(raw(name)) as T
}

interface VerdictCase {
  name: string
  text: string
  expected: Verdict[] | null
}

const tray = json<InboxTray>('tray.sample.json')

describe('conformance fixtures — canonical form', () => {
  it('ships exactly the six named files', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([
      'ack-frame.json',
      'engine-scenarios.json',
      'gate-prompt.expected.txt',
      'tray.sample.json',
      'verdict-parse.cases.json',
      'wake-frame.json',
    ])
  })

  it.each([
    'tray.sample.json',
    'verdict-parse.cases.json',
    'wake-frame.json',
    'ack-frame.json',
    'engine-scenarios.json',
  ])(
    '%s has sorted keys, two-space indent and one trailing newline',
    (name) => {
      const text = raw(name)
      expect(text).toBe(canonicalJson(JSON.parse(text)) + '\n')
    },
  )

  it('gate-prompt.expected.txt ends with exactly one newline', () => {
    const text = raw('gate-prompt.expected.txt')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})

describe('conformance — tray.sample.json', () => {
  it('covers a direct card, a group card, a mention and a deleted group', () => {
    const cards = tray.conversations
    expect(cards.some((c) => c.type === 'direct')).toBe(true)
    expect(cards.some((c) => c.type === 'group' && c.group?.deleted === null)).toBe(true)
    expect(cards.some((c) => c.mentioned_you)).toBe(true)
    expect(cards.some((c) => c.group?.deleted !== null && c.group?.deleted !== undefined)).toBe(true)
    // Every card carries the anchor a verdict reads through.
    for (const card of cards) expect(card.preview?.message_id).toMatch(/^msg_/)
  })
})

describe('conformance — gate prompt', () => {
  it('renders tray.sample.json to gate-prompt.expected.txt', () => {
    expect(buildPrompt(tray) + '\n').toBe(raw('gate-prompt.expected.txt'))
  })

  it('carries the server question verbatim, after the tool-less preamble', () => {
    const prompt = buildPrompt(tray)
    expect(prompt).toContain(`\n\n${tray.question}\n\n`)
    expect(prompt.indexOf(tray.question)).toBeGreaterThan(0)
  })
})

describe('conformance — verdict parsing', () => {
  const cases = json<VerdictCase[]>('verdict-parse.cases.json')

  it('has unique case names', () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(parseVerdicts(c.text, tray)).toEqual(c.expected)
  })
})

describe('conformance — socket frames', () => {
  beforeEach(() => MockWebSocket.reset())

  async function connected(options: { ackOnReceipt?: boolean } = {}) {
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

  it('wake-frame.json reaches `wake` handlers as-is and is never acked', async () => {
    const frame = json<WakeFrame>('wake-frame.json')
    const { rt, ws } = await connected()
    const onWake = vi.fn()
    rt.on('wake', onWake)

    ws.simulateMessage(raw('wake-frame.json'))
    await settle()

    expect(onWake).toHaveBeenCalledTimes(1)
    expect(onWake.mock.calls[0]?.[0]).toEqual(frame)
    expect(sentFrames(ws, 'ack')).toEqual([])
    rt.disconnect()
  })

  it('ack-frame.json is what the client sends for a delivered message', async () => {
    const ack = json<{ type: 'ack'; message_id: string }>('ack-frame.json')
    const { rt, ws } = await connected({ ackOnReceipt: true })
    rt.on('message.new', vi.fn())

    ws.simulateMessage({
      type: 'message.new',
      payload: { id: ack.message_id, conversation_id: 'conv_direct0first01', seq: 1 },
    })
    await settle()

    expect(ws.sent.map((s) => JSON.parse(s) as unknown)).toContainEqual(ack)
    expect(sentFrames(ws, 'ack')).toHaveLength(1)
    rt.disconnect()
  })
})
