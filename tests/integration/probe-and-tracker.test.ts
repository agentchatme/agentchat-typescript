import { describe, expect, it, vi } from 'vitest'
import { probeHostedTools } from '../../src/integration/probe.js'
import { TurnTracker } from '../../src/integration/turn-tracker.js'
import type { TurnEnd } from '../../src/integration/outcome.js'

function mcp(answers: Array<(body: { method: string }) => Response>) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  let i = 0
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string }
    calls.push({ url: String(url), method: body.method, headers: new Headers(init?.headers) })
    const answer = answers[Math.min(i, answers.length - 1)]!
    i += 1
    return answer(body)
  }) as unknown as typeof fetch
  return { fetch, calls }
}
const rpc = (result: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const initResult = { protocolVersion: '2025-06-18', serverInfo: { name: 'agentchat', version: '0.4.1' }, capabilities: {} }

describe('probeHostedTools', () => {
  it('initialize + tools/list with the bearer key: ok when the tools a turn needs are listed', async () => {
    const { fetch, calls } = mcp([
      rpc(initResult),
      rpc({ tools: [{ name: 'agentchat_inbox' }, { name: 'agentchat_decide' }, { name: 'agentchat_send_message' }] }),
    ])
    const result = await probeHostedTools({ apiBase: 'https://api.agentchat.me/', apiKey: 'ac_key', fetch })
    expect(result).toMatchObject({
      ok: true,
      serverName: 'agentchat',
      serverVersion: '0.4.1',
      protocolVersion: '2025-06-18',
      tools: ['agentchat_inbox', 'agentchat_decide', 'agentchat_send_message'],
      missing: [],
    })
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      ['https://api.agentchat.me/mcp', 'initialize'],
      ['https://api.agentchat.me/mcp', 'tools/list'],
    ])
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ac_key')
    expect(calls[1]!.headers.get('mcp-protocol-version')).toBe('2025-06-18')
  })

  it('names the tools a turn needs that are missing', async () => {
    const { fetch } = mcp([rpc(initResult), rpc({ tools: [{ name: 'agentchat_inbox' }] })])
    const result = await probeHostedTools({ apiBase: 'https://api.agentchat.me', apiKey: 'k', fetch })
    expect(result).toMatchObject({ ok: false, missing: ['agentchat_decide'] })
    expect(result.error).toMatch(/agentchat_decide/)
  })

  it('a 401 says the key does not authenticate; an SSE answer is read too; a transport error is reported', async () => {
    const unauthorized = mcp([() => new Response('{}', { status: 401 })])
    expect(await probeHostedTools({ apiBase: 'https://x', apiKey: 'bad', fetch: unauthorized.fetch })).toMatchObject({
      ok: false,
      status: 401,
      error: 'the key does not authenticate against the hosted MCP server',
    })
    const sse = mcp([
      () => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: initResult })}\n\n`, { status: 200 }),
      () => new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'agentchat_inbox' }, { name: 'agentchat_decide' }] } })}\n\n`, { status: 200 }),
    ])
    expect((await probeHostedTools({ apiBase: 'https://x', apiKey: 'k', fetch: sse.fetch })).ok).toBe(true)
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeHostedTools({ apiBase: 'https://x', apiKey: 'k', fetch: down })).toEqual({ ok: false, error: 'ECONNREFUSED' })
  })
})

describe('TurnTracker', () => {
  it('one turn per conversation and per invite; running cards are left out', () => {
    const tracker = new TurnTracker({ now: () => 1000 })
    const a = tracker.begin({ kind: 'reply', conversationId: 'c1', anchor: 'm1' })
    expect(a).not.toBeNull()
    expect(tracker.begin({ kind: 'reply', conversationId: 'c1', anchor: 'm2' })).toBeNull()
    expect(tracker.begin({ kind: 'invite', inviteId: 'c1' })).not.toBeNull() // another namespace
    expect(tracker.withoutRunning([{ conversation_id: 'c1' }, { conversation_id: 'c2' }])).toEqual([{ conversation_id: 'c2' }])
    expect(tracker.running()).toEqual([
      { kind: 'reply', conversationId: 'c1', anchor: 'm1', startedAt: 1000, waitTimedOutAt: null },
      { kind: 'invite', inviteId: 'c1', startedAt: 1000, waitTimedOutAt: null },
    ])
    tracker.end(a!)
    expect(tracker.conversationRunning('c1')).toBe(false)
  })

  it('a wait timeout is not an end: still_running is followed to the confirmed end', async () => {
    let t = 0
    const tracker = new TurnTracker({ now: () => t })
    const handle = tracker.begin({ kind: 'reply', conversationId: 'c1', anchor: null })!
    let finish: (end: TurnEnd) => void = () => undefined
    const next = new Promise<TurnEnd>((r) => (finish = r))
    t = 900_000
    const end = tracker.confirmedEnd(handle, Promise.resolve({ status: 'still_running', next }))
    await new Promise((r) => setTimeout(r, 0))
    expect(tracker.running()[0]).toMatchObject({ conversationId: 'c1', waitTimedOutAt: 900_000 })
    expect(tracker.conversationRunning('c1')).toBe(true)
    finish({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    await expect(end).resolves.toEqual({ status: 'completed', agentchatCalls: { made: 2, failed: 0 } })
    expect(tracker.conversationRunning('c1')).toBe(true) // until the outcome is recorded and end() is called
  })

  it('still_running with no way to learn the end holds the turn until release; a rejected report is a failed turn', async () => {
    const tracker = new TurnTracker()
    const held = tracker.begin({ kind: 'reply', conversationId: 'c1', anchor: null })!
    const end = tracker.confirmedEnd(held, Promise.resolve({ status: 'still_running' }))
    let settled = false
    void end.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    expect(tracker.release(held.key)).toBe(true)
    await expect(end).resolves.toBeNull()
    expect(tracker.conversationRunning('c1')).toBe(false)

    const broken = tracker.begin({ kind: 'invite', inviteId: 'i1' })!
    await expect(tracker.confirmedEnd(broken, Promise.reject(new Error('lost')))).resolves.toMatchObject({ status: 'failed' })
  })

  it('a turn released while it runs never records: its later end reads as null', async () => {
    const tracker = new TurnTracker()
    const handle = tracker.begin({ kind: 'reply', conversationId: 'c1', anchor: null })!
    let finish: (end: TurnEnd) => void = () => undefined
    const end = tracker.confirmedEnd(handle, new Promise<TurnEnd>((r) => (finish = r)))
    expect(tracker.release(handle.key)).toBe(true)
    expect(tracker.holds(handle)).toBe(false)
    finish({ status: 'completed', agentchatCalls: { made: 1, failed: 0 } })
    await expect(end).resolves.toBeNull()
    // A new turn for the conversation is a different handle; the old one does not hold it.
    const next = tracker.begin({ kind: 'reply', conversationId: 'c1', anchor: null })!
    expect(tracker.holds(next)).toBe(true)
    expect(tracker.holds(handle)).toBe(false)
  })
})
