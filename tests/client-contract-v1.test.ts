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
    await expect(client.groups.dismissInvite('gri_1')).resolves.toEqual({ dismissed: true })
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.agentchat.me/v1/groups/invites/gri_1/dismiss' })
    expect(calls[0]!.headers['idempotency-key']).toMatch(/\S{8,}/)
  })

  it('is retried safely on a transient error, with the same key', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(200, { dismissed: true })])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await client.groups.dismissInvite('gri_1', { idempotencyKey: 'key-1' })
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-1', 'key-1'])
  })

  it('throws NotFoundError for an unknown, answered or cancelled invite', async () => {
    const { fetch } = capture([() => json(404, { code: 'INVITE_NOT_FOUND', message: 'no such invite' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.groups.dismissInvite('gri_x')).rejects.toBeInstanceOf(NotFoundError)
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

describe('client.decisions.record — any 2xx is a recorded verdict', () => {
  it.each([
    ['an empty body', () => new Response(null, { status: 200 })],
    ['a 204', () => new Response(null, { status: 204 })],
    ['a null body', () => json(200, null)],
    ['a body without the decision', () => json(201, { ok: true })],
    ['a null decision', () => json(200, { decision: null })],
  ])('%s: resolves (fields the server did not echo are null), never throws', async (_what, respond) => {
    const { fetch, calls } = capture([respond])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const result = await client.decisions.record('conv_1', { decision: 'defer', category: 'goal_followup', throughMessageId: 'msg_9' })
    expect(result).toEqual({
      id: null,
      conversation_id: 'conv_1',
      decision: 'defer',
      category: 'goal_followup',
      through_message_id: 'msg_9',
      defer_until: null,
      created_at: null,
    })
    expect(calls).toHaveLength(1)
  })

  it('the server decision, when present, is returned as served', async () => {
    const served = {
      id: 'dec_1',
      conversation_id: 'conv_1',
      decision: 'defer',
      category: 'goal_followup',
      through_message_id: 'msg_9',
      defer_until: '2026-11-08T09:15:00.000Z',
      defer_step: 1,
      created_at: '2026-11-08T09:00:00.000Z',
    }
    const { fetch } = capture([() => json(201, { decision: served })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.decisions.record('conv_1', { decision: 'defer' })).resolves.toEqual(served)
  })
})

describe('per-call retry never retries a POST without an Idempotency-Key', () => {
  it('decisions.record with a retry policy: one attempt (a retried defer would climb the ladder twice)', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(
      client.decisions.record('conv_1', { decision: 'defer', retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 } }),
    ).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('with an Idempotency-Key the policy applies', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(201, { decision: null })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await client.decisions.record('conv_1', {
      decision: 'defer',
      idempotencyKey: 'k-1',
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    })
    expect(calls).toHaveLength(2)
  })
})

describe('inbox.tray includeInvites', () => {
  it('sends invites=1 when asked, nothing otherwise', async () => {
    const tray = { you: '@x', question: 'q', categories: [], conversations: [], deferred: 0, truncated: false, waited_ms: null }
    const { fetch, calls } = capture([() => json(200, tray)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await client.inbox.tray({ includeInvites: true, limit: 50 })
    await client.inbox.tray()
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.agentchat.me/v1/inbox?limit=50&invites=1',
      'https://api.agentchat.me/v1/inbox',
    ])
  })
})

describe('static calls take fetch, timeoutMs and signal', () => {
  it('register / verify / recover / recoverVerify go through the given fetch; the returned client keeps it', async () => {
    const { fetch, calls } = capture([
      () => json(200, { pending_id: 'p1', message: 'sent' }),
      () => json(200, { agent: { handle: 'example-relay' }, api_key: 'key_1' }),
      () => json(200, { pending_id: 'p2', message: 'sent' }),
      () => json(200, { handle: 'example-relay', api_key: 'key_2' }),
      () => json(200, { id: 'a', handle: 'example-relay' }),
    ])
    const controller = new AbortController()
    await AgentChatClient.register({ email: 'a@example.com', handle: 'example-relay', fetch, timeoutMs: 5_000, signal: controller.signal })
    const verified = await AgentChatClient.verify('p1', '123456', { fetch })
    await AgentChatClient.recover('a@example.com', { handle: 'example-relay', fetch })
    await AgentChatClient.recoverVerify('p2', '654321', { fetch })
    await verified.client.getMe()
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.agentchat.me/v1/register',
      'https://api.agentchat.me/v1/register/verify',
      'https://api.agentchat.me/v1/agents/recover',
      'https://api.agentchat.me/v1/agents/recover/verify',
      'https://api.agentchat.me/v1/agents/me',
    ])
    expect(calls[4]!.headers.authorization).toBe('Bearer key_1')
  })

  it('an aborted signal stops a static call', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return json(200, { pending_id: 'p', message: 'm' })
    }) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    controller.abort()
    await expect(AgentChatClient.recover('a@example.com', { fetch, signal: controller.signal })).rejects.toThrow()
  })
})

// ─── could not process: the report, the scoped wait, a hidden message ──────

describe('client.conversations.reportProcessingFailure', () => {
  const served = { action: 'hidden', attempts: 2, hidden_message_ids: ['msg_1', 'msg_2', 'msg_3'], paused_until: null }

  it('POSTs the report (wire names only) with an Idempotency-Key and returns the server answer', async () => {
    const { fetch, calls } = capture([() => json(200, served)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const result = await client.conversations.reportProcessingFailure('conv_1', {
      throughMessageId: 'msg_3',
      outcome: 'failed',
      evidence: 'other_run_completed',
      timeoutMs: 5_000,
    })
    expect(result).toEqual(served)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.agentchat.me/v1/conversations/conv_1/processing-failures',
      body: { through_message_id: 'msg_3', outcome: 'failed', evidence: 'other_run_completed' },
    })
    expect(calls[0]!.headers['idempotency-key']).toMatch(/\S{8,}/)
  })

  it('a transient failure is retried with the same key: one report, counted once', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(200, served)])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await client.conversations.reportProcessingFailure('conv_1', { throughMessageId: 'msg_3', outcome: 'timed_out', evidence: 'runtime_check' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['idempotency-key']).toBe(calls[1]!.headers['idempotency-key'])
  })

  it('a field the server did not send, or an action this SDK does not know, reads as nothing to act on', async () => {
    const { fetch } = capture([() => json(200, { action: 'quarantined', attempts: 'x', hidden_message_ids: ['msg_1', 7] }), () => new Response(null, { status: 204 })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const opts = { throughMessageId: 'msg_1', outcome: 'failed', evidence: 'runtime_check' } as const
    await expect(client.conversations.reportProcessingFailure('conv_1', opts)).resolves.toEqual({
      action: 'none',
      attempts: 0,
      hidden_message_ids: ['msg_1'],
      paused_until: null,
    })
    await expect(client.conversations.reportProcessingFailure('conv_1', opts)).resolves.toEqual({
      action: 'none',
      attempts: 0,
      hidden_message_ids: [],
      paused_until: null,
    })
  })

  it.each([
    ['a plain-text 404 (an older server without the route)', () => new Response('404 Not Found', { status: 404 })],
    ['an empty 404', () => new Response(null, { status: 404 })],
    ['a 404 with a code of no route of its own', () => json(404, { code: 'NOT_FOUND', message: 'Not Found' })],
  ])('%s → { action: none }, never a throw', async (_what, respond) => {
    const { fetch } = capture([respond])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(
      client.conversations.reportProcessingFailure('conv_1', { throughMessageId: 'msg_1', outcome: 'failed', evidence: 'runtime_check' }),
    ).resolves.toEqual({ action: 'none', attempts: 0, hidden_message_ids: [], paused_until: null })
  })

  it.each(['CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND'])('404 %s throws NotFoundError', async (code) => {
    const { fetch } = capture([() => json(404, { code, message: 'no' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const call = client.conversations.reportProcessingFailure('conv_1', { throughMessageId: 'msg_1', outcome: 'failed', evidence: 'runtime_check' })
    await expect(call).rejects.toBeInstanceOf(NotFoundError)
    await expect(call).rejects.toMatchObject({ code })
  })
})

describe('getMessages: afterMessageId and the scoped wait', () => {
  const hidden = {
    id: 'msg_2',
    conversation_id: 'conv_1',
    sender: '@example-nova',
    client_msg_id: 'c2',
    seq: 2,
    type: 'text',
    content: { text: '[Hidden from you: this message from @example-nova could not be processed on your side, so it is not shown.]' },
    metadata: {},
    status: 'delivered',
    created_at: '2026-11-19T10:00:00.000Z',
    delivered_at: '2026-11-19T10:00:01.000Z',
    read_at: null,
    could_not_process: { at: '2026-11-19T10:05:00.000Z', original_type: 'file' },
  }

  it('sends after_message_id and wait_ms, raises the timeout over the wait, and returns how long the server held it', async () => {
    const { fetch, calls } = capture([() => json(200, [hidden], { 'X-AgentChat-Waited-Ms': '1200' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch, timeoutMs: 1_000 })
    const page = await client.getMessagesPage('conv_1', { afterMessageId: 'msg_1', waitMs: 30_000.7, limit: 20 })
    expect(calls[0]!.url).toBe('https://api.agentchat.me/v1/messages/conv_1?limit=20&after_message_id=msg_1&wait_ms=30000')
    expect(page.waitedMs).toBe(1200)
    expect(page.messages).toEqual([hidden])
    expect(page.messages[0]!.could_not_process).toEqual({ at: '2026-11-19T10:05:00.000Z', original_type: 'file' })
  })

  it('getMessages returns the rows; no wait_ms when 0; the cursors as before', async () => {
    const { fetch, calls } = capture([() => json(200, [hidden])])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.getMessages('conv_1', { afterSeq: 1, waitMs: 0 })).resolves.toEqual([hidden])
    await client.getMessages('conv_1', { beforeSeq: 9 })
    await client.getMessages('conv_1')
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.agentchat.me/v1/messages/conv_1?limit=50&after_seq=1',
      'https://api.agentchat.me/v1/messages/conv_1?limit=50&before_seq=9',
      'https://api.agentchat.me/v1/messages/conv_1?limit=50',
    ])
    const page = await client.getMessagesPage('conv_1', { afterSeq: 1 })
    expect(page.waitedMs).toBeNull()
  })

  it('a scoped wait is not cut off by the default timeout while the server holds it', async () => {
    let seenSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined
      await new Promise((r) => setTimeout(r, 60))
      return json(200, [])
    }) as unknown as typeof globalThis.fetch
    const client = new AgentChatClient({ apiKey: 'k', fetch, timeoutMs: 20 })
    await expect(client.getMessages('conv_1', { afterMessageId: 'msg_1', waitMs: 100 })).resolves.toEqual([])
    expect(seenSignal?.aborted).toBe(false)
  })
})
