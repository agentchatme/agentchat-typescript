import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import { buildPrompt, canonicalJson, parseVerdicts, type Verdict } from '../src/gate.js'
import { AgentChatClient } from '../src/client.js'
import type { InboxTray, Reachability, Texts, TrayNotice, WakeFrame } from '../src/types/index.js'
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

// ─── Reachability and notices: accept every example, show `text`, ignore the unknown ───

/** A fetch that answers every request with `body` (status 200). */
function answer(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof globalThis.fetch
}

const KNOWN_STATES = ['ready', 'untested', 'failing', 'offline', 'quiet', 'when_run', 'paused', 'none']
const KNOWN_VIAS = ['socket', 'webhook', 'wake_check', null]
const KNOWN_PROBLEMS = ['wake_failing', 'woken_undelivered', 'listener_not_ready', 'listener_runs_failing']

describe('conformance — reachability.v1.json', () => {
  const file = json<Record<string, unknown>>('reachability.v1.json')
  const groups = ['agent', 'connector', 'integration', 'owner'] as const
  const examples = groups.flatMap((group) =>
    Object.entries(file[group] as Record<string, Reachability>).map(([name, r]) => [`${group}.${name}`, r] as const),
  )

  it('is version 1 and has an example of every state', () => {
    expect(file.version).toBe(1)
    const states = new Set(examples.map(([, r]) => r.state))
    for (const state of KNOWN_STATES) expect(states.has(state), state).toBe(true)
  })

  it.each(examples)('%s: a v1 reachability with a text to show', (_name, r) => {
    expect(r.version).toBe(1)
    expect(KNOWN_STATES).toContain(r.state)
    expect(KNOWN_VIAS).toContain(r.via)
    expect(typeof r.text).toBe('string')
    expect(r.text.length).toBeGreaterThan(0)
    for (const field of ['last_alive_at', 'wake_link_pending_until'] as const) {
      expect(r[field] === null || typeof r[field] === 'string').toBe(true)
    }
    if (r.problem !== null) {
      expect(KNOWN_PROBLEMS).toContain(r.problem.kind)
      expect(typeof r.problem.text).toBe('string')
      expect(r.problem.since === null || typeof r.problem.since === 'string').toBe(true)
    }
  })

  it.each(examples)('%s: getMe() hands it back as sent, unknown fields kept', async (_name, r) => {
    const client = new AgentChatClient({ apiKey: 'k', fetch: answer({ handle: 'example-relay', reachability: r }) })
    const me = await client.getMe()
    expect(me.reachability).toEqual(r)
  })

  it.each(examples)('%s: a register done answer hands it back as sent', async (_name, r) => {
    const body = { agent: { handle: 'example-relay' }, api_key: 'ac_example-not-a-real-key', next_step: 'done', reachability: r }
    const result = await AgentChatClient.verify('pnd_1', '123456', { fetch: answer(body) })
    expect(result.reachability).toEqual(r)
  })

  it('a state, via, problem kind or field it does not know is kept, and text is still the text', async () => {
    const base = (file.agent as Record<string, Reachability>).failing_listener_not_ready!
    const later = { ...base, state: 'later_state', via: 'later_via', problem: { ...base.problem!, kind: 'later_kind' }, later_field: 1 }
    const me = await new AgentChatClient({ apiKey: 'k', fetch: answer({ handle: 'example-relay', reachability: later }) }).getMe()
    expect(me.reachability).toEqual(later)
    expect(me.reachability?.text).toBe(base.text)
  })
})

describe('conformance — notice fixtures', () => {
  const files = [
    'notice.wake-failing.v1.json',
    'notice.no-wake.v1.json',
    'notice.woken-undelivered.v1.json',
    'notice.no-wake-yet.v1.json',
    'notice.socket-offline.v1.json',
  ]
  const notices = files.flatMap((name) => {
    const file = json<{ version: number; notices: Record<string, TrayNotice>; tray_example: { notices: TrayNotice[] } }>(name)
    return [
      ...Object.entries(file.notices).map(([key, notice]) => [`${name} notices.${key}`, notice] as const),
      ...file.tray_example.notices.map((notice, i) => [`${name} tray_example.notices[${i}]`, notice] as const),
    ]
  })

  it.each(files)('%s is version 1 with a tray example', (name) => {
    const file = json<{ version: number; tray_example: { notices: unknown[] } }>(name)
    expect(file.version).toBe(1)
    expect(file.tray_example.notices.length).toBeGreaterThan(0)
  })

  it.each(notices)('%s: a notice with a kind and a text to show', (_name, notice) => {
    expect(typeof notice.kind).toBe('string')
    expect(typeof notice.text).toBe('string')
    expect(notice.text.length).toBeGreaterThan(0)
  })

  it('names the two new kinds', () => {
    const kinds = new Set(notices.map(([, n]) => n.kind))
    expect(kinds.has('no_wake_yet')).toBe(true)
    expect(kinds.has('socket_offline')).toBe(true)
  })

  it('a tray with notices reads as it was sent, and its notices are never cards', async () => {
    const v1 = json<InboxTray>('tray.v1.sample.json')
    const all = notices.map(([, n]) => n)
    const later: TrayNotice = { kind: 'later_kind', text: 'A notice of a kind this SDK does not know.', later_field: true }
    const served = { ...v1, notices: [...all, later] }
    const tray = await new AgentChatClient({ apiKey: 'k', fetch: answer(served) }).inbox.tray()
    expect(tray.notices).toEqual([...all, later])
    expect(tray.notices?.map((n) => n.text)).toEqual([...all, later].map((n) => n.text))
    expect(buildPrompt(tray, { texts })).toBe(buildPrompt(v1, { texts }))
  })
})
