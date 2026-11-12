import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import { buildPrompt, canonicalJson, parseVerdicts, type Verdict } from '../src/gate.js'
import type { InboxTray, Texts, WakeFrame } from '../src/types/index.js'
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
const texts = json<Texts>('texts.sample.json')

describe('conformance fixtures — canonical form', () => {
  const files = readdirSync(FIXTURES).sort()

  it('ships exactly the files the manifest names, byte for byte', () => {
    const manifest = raw('manifest.sha256')
    const entries = manifest
      .trimEnd()
      .split('\n')
      .map((line) => {
        const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line)
        expect(match, `manifest line: ${line}`).not.toBeNull()
        return { sha: match![1]!, name: match![2]! }
      })
    expect(entries.map((e) => e.name)).toEqual(files.filter((f) => f !== 'manifest.sha256'))
    expect([...entries.map((e) => e.name)].sort()).toEqual(entries.map((e) => e.name))
    for (const { sha, name } of entries) {
      const digest = createHash('sha256').update(readFileSync(resolve(FIXTURES, name))).digest('hex')
      expect(digest, `${name} differs from the manifest`).toBe(sha)
    }
  })

  it.each(files.filter((f) => f.endsWith('.json')))(
    '%s has sorted keys, two-space indent and one trailing newline',
    (name) => {
      const text = raw(name)
      expect(text).toBe(canonicalJson(JSON.parse(text)) + '\n')
    },
  )

  it.each(files.filter((f) => !f.endsWith('.json')))('%s ends with exactly one newline', (name) => {
    const text = raw(name)
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

describe('conformance — texts.sample.json', () => {
  it('is a v1 text set with the gate-call texts (D6)', () => {
    expect(texts.version).toBe('1')
    for (const field of [
      'wake_instruction',
      'invite_prompt',
      'identity_line',
      'identity_line_template',
      'gate_call_preamble',
      'gate_call_answer_format',
    ] as const) {
      expect(typeof texts[field]).toBe('string')
      expect((texts[field] ?? '').length).toBeGreaterThan(0)
    }
    expect(texts.manual.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(texts.identity_line_template).toContain('<handle>')
  })

  it('carries the reply-turn template (§3.6), naming one conversation by <conversation_id>', () => {
    expect(typeof texts.reply_turn_template).toBe('string')
    expect(texts.reply_turn_template).toContain('<conversation_id>')
    expect(texts.reply_turn_template).not.toBe(texts.wake_instruction)
  })
})

describe('conformance — gate prompt', () => {
  it('renders tray.sample.json with texts.sample.json to gate-prompt.expected.txt', () => {
    expect(buildPrompt(tray, { texts }) + '\n').toBe(raw('gate-prompt.expected.txt'))
  })

  it('renders the same prompt without texts (the legacy wording, deprecated)', () => {
    expect(buildPrompt(tray) + '\n').toBe(raw('gate-prompt.expected.txt'))
  })

  it('carries the served preamble first, then the server question verbatim, and the served answer format last', () => {
    const prompt = buildPrompt(tray, { texts })
    expect(prompt.startsWith(`${texts.gate_call_preamble}\n\n${tray.question}\n\n`)).toBe(true)
    expect(prompt.endsWith(`\n\n${texts.gate_call_answer_format}`)).toBe(true)
  })
})

describe('conformance — tray.v1.sample.json', () => {
  const v1 = json<InboxTray>('tray.v1.sample.json')

  it('is a v1 tray with invites, a muted card and a reminder card', () => {
    expect(v1.version).toBe(1)
    expect(v1.invites?.length).toBeGreaterThan(0)
    expect(v1.invites_truncated).toBe(false)
    for (const invite of v1.invites ?? []) {
      expect(invite.invite_id).toMatch(/^gri_/)
      expect(invite.invited_by.startsWith('@')).toBe(true)
      expect(typeof invite.group.id).toBe('string')
      expect(typeof invite.group.member_count).toBe('number')
    }
    expect(v1.conversations.some((c) => c.muted === true)).toBe(true)
    expect(v1.conversations.some((c) => c.reminder?.step === 2)).toBe(true)
  })

  it('a v1 tray gates like any other: only conversations are cards', () => {
    const prompt = buildPrompt(v1, { texts })
    expect(prompt).toContain(`Your tray, as the server built it: ${v1.conversations.length} conversations.`)
    expect(prompt).not.toContain('gri_')
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
    // The usual order: a message handler is attached before the socket opens,
    // so the HELLO offers acks. Tests add their own handlers alongside.
    rt.on('message.new', () => undefined)
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
