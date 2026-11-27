import { describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import { NotFoundError, RateLimitedError, ServerError, UnauthorizedError, ValidationError } from '../src/errors.js'
import * as sdk from '../src/index.js'
import { run, submitCode } from '../src/integration/account.js'
import type { Agent, ListenerReport, Reachability } from '../src/types/index.js'
import { json as fixture } from './integration/fixtures.js'

// ─── Reachability (contract v1 §3.12), wake_mode, and the listener report (§3.13) ───

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
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value))
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      headers,
    })
    const respond = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return respond()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const fastRetry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }
const API = 'https://api.agentchat.me'

const examples = fixture<{ agent: Record<string, Reachability> }>('reachability.v1.json').agent
const none = examples.none!

/** A reachability a later server might send: a state and a field this SDK does not know. */
const later = {
  ...examples.failing_listener_not_ready!,
  state: 'hibernating',
  problem: { kind: 'listener_sleepy', since: null, text: 'A later problem kind.' },
  extra_field: { nested: true },
} as unknown as Reachability

const me = {
  id: 'agt_1',
  handle: 'example-relay',
  email: 'r***@example.com',
  display_name: null,
  description: null,
  avatar_url: null,
  status: 'active',
  paused_by_owner: 'none',
  settings: { inbox_mode: 'open', group_invite_policy: 'open', wake_mode: 'when_run' },
  created_at: '2026-11-28T09:30:00.000Z',
  updated_at: '2026-11-28T09:30:00.000Z',
  wake_webhook: null,
  reachability: later,
}

describe('getMe: reachability and settings.wake_mode', () => {
  it('passes reachability through as sent, unknown state, problem kind and fields included', async () => {
    const { fetch } = capture([() => json(200, me)])
    const agent: Agent = await new AgentChatClient({ apiKey: 'k', fetch }).getMe()
    expect(agent.reachability).toEqual(later)
    expect(agent.reachability?.text).toBe(examples.failing_listener_not_ready!.text)
    expect(agent.settings.wake_mode).toBe('when_run')
  })

  it('reachability is absent when the server sent none', async () => {
    const { reachability: _omit, ...older } = me
    const { fetch } = capture([() => json(200, older)])
    const agent = await new AgentChatClient({ apiKey: 'k', fetch }).getMe()
    expect(agent.reachability).toBeUndefined()
  })
})

describe('updateAgent: settings.wake_mode', () => {
  it('PATCHes /v1/agents/{handle} with only the wake mode', async () => {
    const { fetch, calls } = capture([() => json(200, { ...me, settings: { ...me.settings } })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await client.updateAgent('example-relay', { settings: { wake_mode: 'when_run' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${API}/v1/agents/example-relay` })
    expect(calls[0]!.body).toEqual({ settings: { wake_mode: 'when_run' } })
  })
})

describe('the sign-up done answers carry reachability', () => {
  const done = {
    agent: { handle: 'example-relay' },
    api_key: 'ac_example-not-a-real-key',
    flow: 'register',
    next_step: 'done',
    status: 'approved',
    version: 1,
    message: 'Email verified. Logged in as @example-relay.',
    reachability: none,
  }

  it('verify() exposes it as sent; next_step stays done', async () => {
    const { fetch } = capture([() => json(201, done)])
    const result = await AgentChatClient.verify('pnd_1', '123456', { fetch })
    expect(result.reachability).toEqual(none)
    expect(result.next_step).toBe('done')
    expect(result.apiKey).toBe(done.api_key)
  })

  it('verify() leaves it out when the server sent none, or something that is not an object', async () => {
    for (const reachability of [undefined, null, 'none', ['none']]) {
      const { fetch } = capture([() => json(201, { ...done, reachability })])
      const result = await AgentChatClient.verify('pnd_1', '123456', { fetch })
      expect(result).not.toHaveProperty('reachability')
    }
  })

  it('recoverVerify() exposes it, unknown values kept', async () => {
    const body = { ...done, flow: 'recover', handle: 'example-relay', agent: undefined, reachability: later }
    const { fetch } = capture([() => json(200, body)])
    const result = await AgentChatClient.recoverVerify('pnd_1', '123456', { fetch })
    expect(result.reachability).toEqual(later)
    expect(result.handle).toBe('example-relay')
  })

  it('rotateKeyVerify() passes it through', async () => {
    const body = { flow: 'rotate_key', next_step: 'done', handle: 'example-relay', api_key: 'ac_new', reachability: examples.offline }
    const { fetch } = capture([() => json(200, body)])
    const result = await new AgentChatClient({ apiKey: 'k', fetch }).rotateKeyVerify('example-relay', 'pnd_1', '123456')
    expect(result.reachability).toEqual(examples.offline)
  })

  it('integration.account: submitCode and run carry it on done, for the integration to show', async () => {
    const options = { clientIdentity: { name: 'typescript_sdk' as const }, apiBase: API }
    {
      const { fetch } = capture([() => json(201, done)])
      const result = await submitCode({ version: 1, flow: 'register', next_step: 'verify', pending_id: 'pnd_1' }, '123456', { ...options, fetch })
      expect(result.action).toBe('done')
      expect(result.reachability).toEqual(none)
    }
    {
      const started = { pending_id: 'pnd_1', flow: 'register', next_step: 'verify', status: 'pending', version: 1, code_length: 6, message: 'We sent a code.' }
      const { fetch } = capture([() => json(200, started), () => json(201, done)])
      const result = await run({
        ...options,
        fetch,
        kind: 'register',
        input: { email: 'relay@example.com', handle: 'example-relay' },
        show: () => undefined,
        ask: async () => ({ answer: 'value', value: '123456' }),
      })
      expect(result).toEqual({ outcome: 'done', apiKey: done.api_key, handle: 'example-relay', reachability: none })
    }
    {
      // An older server: no reachability, and none made up.
      const { reachability: _omit, ...older } = done
      const { fetch } = capture([() => json(201, older)])
      const result = await submitCode({ version: 1, flow: 'register', next_step: 'verify', pending_id: 'pnd_1' }, '123456', { ...options, fetch })
      expect(result.action).toBe('done')
      expect(result).not.toHaveProperty('reachability')
    }
  })

  it('a reachability on an answer that is not done is not carried', async () => {
    const wrong = { code: 'INVALID_CODE', message: 'That code didn\'t work.', details: { flow: 'register', next_step: 'verify', status: 'pending', version: 1, param: 'code', reachability: none } }
    const { fetch } = capture([() => json(400, wrong)])
    const result = await submitCode({ version: 1, flow: 'register', next_step: 'verify', pending_id: 'pnd_1' }, '000000', { clientIdentity: { name: 'typescript_sdk' }, apiBase: API, fetch })
    expect(result.action).toBe('ask_code')
    expect(result).not.toHaveProperty('reachability')
  })
})

describe('client.reportListener', () => {
  const ROUTE = `${API}/v1/agents/me/listener`
  const record: ListenerReport = {
    instance_id: 'inst_0123456789abcdef',
    state: 'runs_failing',
    reason_kind: 'runtime_check_failed',
    state_since: '2026-11-28T11:45:00.000Z',
    reported_at: '2026-11-28T12:00:00.000Z',
  }

  it('PUTs the documented body and resolves the server record', async () => {
    const { fetch, calls } = capture([() => json(200, { listener: record })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(
      client.reportListener({ instanceId: 'inst_0123456789abcdef', state: 'runs_failing', reasonKind: 'runtime_check_failed', timeoutMs: 5_000 }),
    ).resolves.toEqual(record)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'PUT', url: ROUTE })
    expect(calls[0]!.headers.authorization).toBe('Bearer k')
    expect(calls[0]!.body).toEqual({ instance_id: 'inst_0123456789abcdef', state: 'runs_failing', reason_kind: 'runtime_check_failed' })
  })

  it('leaves reason_kind out when none is given', async () => {
    const { fetch, calls } = capture([() => json(200, { listener: { ...record, state: 'ok', reason_kind: null } })])
    await new AgentChatClient({ apiKey: 'k', fetch }).reportListener({ instanceId: 'inst_0123456789abcdef', state: 'ok' })
    expect(calls[0]!.body).toEqual({ instance_id: 'inst_0123456789abcdef', state: 'ok' })
  })

  it('a transient failure is retried like any PUT', async () => {
    const { fetch, calls } = capture([() => json(502, { code: 'BAD_GATEWAY', message: 'upstream' }), () => json(200, { listener: record })])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await expect(client.reportListener({ instanceId: 'inst_0123456789abcdef', state: 'runs_failing' })).resolves.toEqual(record)
    expect(calls).toHaveLength(2)
  })

  it('503 LISTENER_REPORTS_UNAVAILABLE is a ServerError, never retried', async () => {
    const { fetch, calls } = capture([
      () => json(503, { code: 'LISTENER_REPORTS_UNAVAILABLE', message: 'Listener reports are not available right now' }),
      () => json(200, { listener: record }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    const err = await client.reportListener({ instanceId: 'inst_0123456789abcdef', state: 'ok' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect((err as ServerError).code).toBe(sdk.ErrorCode.LISTENER_REPORTS_UNAVAILABLE)
    expect((err as ServerError).status).toBe(503)
    expect(calls).toHaveLength(1)
  })

  it('maps 400, 401, 404 and 429 to the SDK errors', async () => {
    const cases: Array<[Response, new (...args: never[]) => Error]> = [
      [json(400, { code: 'VALIDATION_ERROR', message: 'Invalid request' }), ValidationError],
      [json(413, { code: 'VALIDATION_ERROR', message: 'Request body too large' }), ValidationError],
      [json(401, { code: 'UNAUTHORIZED', message: 'Invalid API key' }), UnauthorizedError],
      [json(404, { code: 'NOT_FOUND', message: 'Not found' }), NotFoundError],
      [json(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'Retry-After': '1800' }), RateLimitedError],
    ]
    for (const [response, kind] of cases) {
      const { fetch } = capture([() => response])
      const err = await new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
        .reportListener({ instanceId: 'inst_0123456789abcdef', state: 'ok' })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(kind)
    }
    const { fetch } = capture([() => json(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'Retry-After': '1800' })])
    const limited = (await new AgentChatClient({ apiKey: 'k', fetch })
      .reportListener({ instanceId: 'inst_0123456789abcdef', state: 'ok' })
      .catch((e: unknown) => e)) as RateLimitedError
    expect(limited.retryAfterMs).toBe(1_800_000)
  })
})

describe('public surface', () => {
  it('exposes reportListener, the listener report constants and the error code', () => {
    const client = new AgentChatClient({ apiKey: 'k', fetch: (() => Promise.reject(new Error('unused'))) as typeof fetch })
    expect(typeof client.reportListener).toBe('function')
    expect(sdk.LISTENER_REPORT_RESEND_MS).toBe(30 * 60_000)
    expect(sdk.LISTENER_REPORT_FRESH_MS).toBe(45 * 60_000)
    expect(sdk.ErrorCode.LISTENER_REPORTS_UNAVAILABLE).toBe('LISTENER_REPORTS_UNAVAILABLE')
    expect(typeof sdk.integration.ListenerReporter).toBe('function')
    expect(typeof sdk.integration.listenerInstanceId).toBe('function')
  })
})
