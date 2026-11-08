import { describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import { NotFoundError } from '../src/errors.js'
import type { TestWakeResult, WakeWebhookStatus } from '../src/types/index.js'

// ─── client.groups / wakeWebhook / syncPage / per-call retry ───────────────

interface Captured {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

function capture(responses: Array<() => Response>) {
  const calls: Captured[] = []
  let index = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    const respond = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return respond()
  }) as unknown as typeof fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const fastRetry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }

const status: WakeWebhookStatus = {
  url: 'https://example.com/wake',
  dialect: 'hermes',
  prompt: null,
  state: 'active',
  consecutive_failures: 0,
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-11-08T09:00:00.000Z',
  rewake: true,
}

describe('client.groups.dismissInvite', () => {
  it('POSTs …/dismiss with an Idempotency-Key and returns the body', async () => {
    const { fetch, calls } = capture([() => json(200, { dismissed: true })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.groups.dismissInvite('ginv_1')).resolves.toEqual({ dismissed: true })
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.agentchat.me/v1/groups/invites/ginv_1/dismiss' })
    expect(calls[0]!.headers['idempotency-key']).toMatch(/\S{8,}/)
  })

  it('is retried safely on a transient error, with the same key', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(200, { dismissed: true })])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await client.groups.dismissInvite('ginv_1', { idempotencyKey: 'key-1' })
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-1', 'key-1'])
  })

  it('throws NotFoundError for an unknown, answered or cancelled invite', async () => {
    const { fetch } = capture([() => json(404, { code: 'INVITE_NOT_FOUND', message: 'no such invite' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.groups.dismissInvite('ginv_x')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('client.wakeWebhook', () => {
  it('set: PUTs only the documented fields, rewake included', async () => {
    const { fetch, calls } = capture([() => json(200, { wake_webhook: status })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const result = await client.wakeWebhook.set({
      url: 'https://example.com/wake',
      secret: 'wks_0123456789abcdef',
      dialect: 'hermes',
      rewake: true,
      timeoutMs: 5_000,
    })
    expect(result).toEqual(status)
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.agentchat.me/v1/agents/me/wake-webhook',
      body: { url: 'https://example.com/wake', secret: 'wks_0123456789abcdef', dialect: 'hermes', rewake: true },
    })
  })

  it('set: an omitted rewake or dialect stays off the wire', async () => {
    const { fetch, calls } = capture([() => json(200, { wake_webhook: status })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await client.wakeWebhook.set({ url: 'https://example.com/wake', secret: 'wks_0123456789abcdef' })
    expect(calls[0]!.body).toEqual({ url: 'https://example.com/wake', secret: 'wks_0123456789abcdef' })
  })

  it('test: POSTs …/test and unwraps test_wake; clear: DELETEs', async () => {
    const wake: TestWakeResult = {
      ok: true,
      dialect: 'hermes',
      url_host: 'example.com',
      status: 200,
      duration_ms: 31,
      error: null,
      delivery_id: '7d4f1c2e-9a3b-4c5d-8e6f-0a1b2c3d4e5f',
    }
    const { fetch, calls } = capture([() => json(200, { test_wake: wake }), () => json(200, { ok: true, removed: true })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.wakeWebhook.test()).resolves.toEqual(wake)
    await expect(client.wakeWebhook.clear()).resolves.toEqual({ ok: true, removed: true })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://api.agentchat.me/v1/agents/me/wake-webhook/test'],
      ['DELETE', 'https://api.agentchat.me/v1/agents/me/wake-webhook'],
    ])
  })
})

describe('client.syncPage / sync with waitMs', () => {
  it('long-polls with wait_ms and reads the waited and poll-interval headers', async () => {
    const { fetch, calls } = capture([
      () => json(200, [], { 'X-AgentChat-Waited-Ms': '45012' }),
      () => json(200, [], { 'X-AgentChat-Poll-Interval-Seconds': '300', 'x-request-id': 'req_1' }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const waited = await client.syncPage({ waitMs: 45_000, after: 'del_1', limit: 50 })
    expect(waited).toMatchObject({ rows: [], waitedMs: 45012, pollIntervalSeconds: null })
    expect(calls[0]!.url).toBe('https://api.agentchat.me/v1/messages/sync?limit=50&after=del_1&wait_ms=45000')
    const plain = await client.syncPage()
    expect(plain).toMatchObject({ rows: [], waitedMs: null, pollIntervalSeconds: 300, requestId: 'req_1' })
    expect(calls[1]!.url).toBe('https://api.agentchat.me/v1/messages/sync')
  })

  it('sync() keeps its bare-array result and takes waitMs too', async () => {
    const row = { id: 'msg_1', conversation_id: 'c', delivery_id: 'del_1' }
    const { fetch, calls } = capture([() => json(200, [row])])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.sync({ waitMs: 1_000 })).resolves.toEqual([row])
    expect(calls[0]!.url).toContain('wait_ms=1000')
  })
})

describe('per-call retry option', () => {
  it("retry: 'never' makes one attempt where the client would retry", async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await expect(client.syncPage({ waitMs: 1_000, retry: 'never' })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('a per-call policy replaces the client policy', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(
      client.inbox.tray({ retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } }),
    ).rejects.toThrow()
    expect(calls).toHaveLength(2)
  })
})
