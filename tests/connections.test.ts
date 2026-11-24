import { describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import {
  AgentChatError,
  ConnectorSignInUnsupportedError,
  NotFoundError,
  RateLimitedError,
  ServerError,
} from '../src/errors.js'
import * as sdk from '../src/index.js'
import type { Agent, EndConnectionResult, RegisterStatusResult } from '../src/types/index.js'

// ─── Connector sign-in: connector-mode sign-up, its status, and connections ───

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
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const fastRetry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }

const BASE = 'https://api.agentchat.me'

// The shape the server answers in connector mode (placeholders, not real ids).
const connectorAnswer = {
  pending_id: 'pnd_example',
  message:
    'We sent a 6-digit code to agent@example.com. Add the connector at https://api.agentchat.me/mcp/connector; when your person taps Connect, they enter @my-agent and the code on AgentChat\'s page.',
  version: 1,
  flow: 'register',
  next_step: 'connect',
  status: 'pending',
  expires_at: '2026-11-24T10:10:00.000Z',
  expires_in_s: 600,
  code_length: 6,
  connect: {
    mcp_url: 'https://api.agentchat.me/mcp/connector',
    status_url: 'https://api.agentchat.me/v1/register/pnd_example',
  },
  signup_expires_at: '2026-11-25T10:00:00.000Z',
}

const ordinaryAnswer = {
  pending_id: 'pnd_example',
  message: 'We sent a 6-digit code to agent@example.com. It expires in 10 minutes.',
  version: 1,
  flow: 'register',
  next_step: 'verify',
  status: 'pending',
}

describe('AgentChatClient.register with finish: "connector"', () => {
  it('sends finish and returns the connector answer as is, with no key', async () => {
    const { fetch, calls } = capture([() => json(201, connectorAnswer)])
    const res = await AgentChatClient.register({
      email: 'agent@example.com',
      handle: 'my-agent',
      finish: 'connector',
      fetch,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/register` })
    expect(calls[0]!.body).toEqual({ email: 'agent@example.com', handle: 'my-agent', finish: 'connector' })
    expect(res.next_step).toBe('connect')
    expect(res.connect.mcp_url).toBe('https://api.agentchat.me/mcp/connector')
    expect(res.connect.status_url).toBe('https://api.agentchat.me/v1/register/pnd_example')
    expect(res.signup_expires_at).toBe('2026-11-25T10:00:00.000Z')
    expect(res.expires_at).toBe('2026-11-24T10:10:00.000Z')
    expect(res).not.toHaveProperty('api_key')
  })

  it('leaves finish out of an ordinary sign-up body', async () => {
    const { fetch, calls } = capture([() => json(201, ordinaryAnswer)])
    await AgentChatClient.register({ email: 'agent@example.com', handle: 'my-agent', fetch })
    expect(calls[0]!.body).toEqual({ email: 'agent@example.com', handle: 'my-agent' })
    expect(calls[0]!.body).not.toHaveProperty('finish')
  })

  it('refuses an ordinary answer to a connector sign-up instead of passing it off as one', async () => {
    const { fetch } = capture([() => json(201, ordinaryAnswer)])
    const err = await AgentChatClient.register({
      email: 'agent@example.com',
      handle: 'my-agent',
      finish: 'connector',
      fetch,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectorSignInUnsupportedError)
    expect((err as ConnectorSignInUnsupportedError).pendingId).toBe('pnd_example')
    expect((err as ConnectorSignInUnsupportedError).serverMessage).toBe(ordinaryAnswer.message)
  })

  it('refuses a connector answer that carries a key', async () => {
    const { fetch } = capture([() => json(201, { ...connectorAnswer, api_key: 'ac_not_a_real_key' })])
    await expect(
      AgentChatClient.register({ email: 'agent@example.com', handle: 'my-agent', finish: 'connector', fetch }),
    ).rejects.toBeInstanceOf(ConnectorSignInUnsupportedError)
  })

  it.each([
    [409, 'HANDLE_TAKEN', AgentChatError],
    [409, 'TOO_MANY_SIGN_UPS', AgentChatError],
    [503, 'CONNECTOR_SIGN_IN_UNAVAILABLE', ServerError],
    [500, 'OTP_FAILED', ServerError],
  ] as const)('a %i %s from a connector sign-up is one attempt, with its code', async (status, code, cls) => {
    const { fetch, calls } = capture([() => json(status, { code, message: 'x', details: { param: 'handle' } })])
    const err = await AgentChatClient.register({
      email: 'agent@example.com',
      handle: 'my-agent',
      finish: 'connector',
      fetch,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(cls)
    expect((err as AgentChatError).code).toBe(code)
    expect(calls).toHaveLength(1)
  })

  it('surfaces the server 404 of a server where connector sign-in is off', async () => {
    const { fetch } = capture([
      () => json(404, { code: 'NOT_FOUND', message: 'Connector sign-in is not available on this server.' }),
    ])
    await expect(
      AgentChatClient.register({ email: 'agent@example.com', handle: 'my-agent', finish: 'connector', fetch }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('verify() on a connector sign-up surfaces FINISH_ON_PAGE as a plain AgentChatError', async () => {
    const { fetch } = capture([
      () =>
        json(409, {
          code: 'FINISH_ON_PAGE',
          message: "This sign-up finishes on AgentChat's page when your person approves the connector.",
          details: { version: 1, flow: 'register', next_step: 'connect' },
        }),
    ])
    const err = await AgentChatClient.verify('pnd_example', '123456', { fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentChatError)
    expect((err as AgentChatError).code).toBe('FINISH_ON_PAGE')
    expect((err as AgentChatError).status).toBe(409)
    expect(sdk.ErrorCode.FINISH_ON_PAGE).toBe('FINISH_ON_PAGE')
  })
})

describe('AgentChatClient.registerStatus', () => {
  const approved: RegisterStatusResult = {
    status: 'approved',
    handle: 'my-agent',
    next_step: 'get_my_status',
    signup_expires_at: '2026-11-25T10:00:00.000Z',
    message: 'Your person approved the connector. Call agentchat_get_my_status through it.',
  }

  it('GETs /v1/register/{pending_id} with the id encoded and returns the answer', async () => {
    const { fetch, calls } = capture([() => json(200, approved)])
    await expect(AgentChatClient.registerStatus('pnd_a/b', { fetch })).resolves.toEqual(approved)
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/v1/register/pnd_a%2Fb` })
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it.each(['handle_taken', 'attempts_exhausted', 'email_limit', 'replaced'] as const)(
    'passes the failure reason %s through, with next_step register',
    async (reason) => {
      const failed: RegisterStatusResult = {
        status: 'failed',
        handle: 'my-agent',
        reason,
        next_step: 'register',
        signup_expires_at: '2026-11-25T10:00:00.000Z',
        message: 'x',
      }
      const { fetch } = capture([() => json(200, failed)])
      const res = await AgentChatClient.registerStatus('pnd_example', { fetch })
      expect(res.status).toBe('failed')
      expect(res.reason).toBe(reason)
      expect(res.next_step).toBe('register')
    },
  )

  it('maps CONNECTOR_SIGN_IN_UNAVAILABLE (503) to ServerError after its retries', async () => {
    const { fetch, calls } = capture([
      () => json(503, { code: 'CONNECTOR_SIGN_IN_UNAVAILABLE', message: 'Connector sign-in is not available right now.' }),
    ])
    const err = await AgentChatClient.registerStatus('pnd_example', { fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServerError)
    expect((err as ServerError).code).toBe('CONNECTOR_SIGN_IN_UNAVAILABLE')
    expect(calls.length).toBeGreaterThanOrEqual(1)
  })

  it('throws NotFoundError for an unknown pending id', async () => {
    const { fetch } = capture([() => json(404, { code: 'NOT_FOUND', message: 'No such sign-up.' })])
    await expect(AgentChatClient.registerStatus('pnd_unknown', { fetch })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('client.connections.end', () => {
  const ended: EndConnectionResult = { ended: true, id: '4f6c2a8e-1b3d-4c5e-9f7a-2b8d6e0c1a34' }

  it('DELETEs /v1/agents/me/connections/{id} with the key and returns the answer', async () => {
    const { fetch, calls } = capture([() => json(200, ended)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.connections.end('4f6c2a8e-1b3d-4c5e-9f7a-2b8d6e0c1a34')).resolves.toEqual(ended)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/v1/agents/me/connections/4f6c2a8e-1b3d-4c5e-9f7a-2b8d6e0c1a34` })
    expect(calls[0]!.headers.authorization).toBe('Bearer k')
  })

  it('encodes the id', async () => {
    const { fetch, calls } = capture([() => json(200, ended)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await client.connections.end('con/../x')
    expect(calls[0]!.url).toBe(`${BASE}/v1/agents/me/connections/con%2F..%2Fx`)
  })

  it('maps CONNECTION_NOT_FOUND to NotFoundError', async () => {
    const { fetch } = capture([() => json(404, { code: 'CONNECTION_NOT_FOUND', message: 'No such connection.' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const err = await client.connections.end('con_x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect((err as NotFoundError).code).toBe('CONNECTION_NOT_FOUND')
    expect(sdk.ErrorCode.CONNECTION_NOT_FOUND).toBe('CONNECTION_NOT_FOUND')
  })

  it('maps RATE_LIMITED to RateLimitedError with the wait', async () => {
    const { fetch } = capture([
      () => json(429, { code: 'RATE_LIMITED', message: 'Slow down.' }, { 'Retry-After': '7' }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: { maxRetries: 0 } })
    const err = await client.connections.end('con_x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).retryAfterMs).toBe(7000)
  })

  it('is arrow-bound like the other resources', async () => {
    const { fetch } = capture([() => json(200, ended)])
    const { end } = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry }).connections
    await expect(end('4f6c2a8e-1b3d-4c5e-9f7a-2b8d6e0c1a34')).resolves.toEqual(ended)
  })
})

describe('connections in your own status', () => {
  it('reads connections from getMe() as sent, and tolerates their absence', async () => {
    const connections = [
      {
        id: '4f6c2a8e-1b3d-4c5e-9f7a-2b8d6e0c1a34',
        client_name: 'Example runtime',
        redirect_host: 'runtime.example.com',
        created_at: '2026-11-24T10:00:00.000Z',
        last_used_at: null,
        current: true,
      },
      {
        id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        client_name: null,
        redirect_host: 'other.example.com',
        created_at: '2026-11-24T11:00:00.000Z',
        last_used_at: '2026-11-24T11:05:00.000Z',
        current: false,
      },
    ]
    const base = {
      id: 'agt_example',
      handle: 'my-agent',
      email: 'agent@example.com',
      display_name: null,
      description: null,
      avatar_url: null,
      status: 'active',
      paused_by_owner: 'none',
      settings: { inbox_mode: 'open', group_invite_policy: 'open' },
      created_at: '2026-11-24T10:00:00.000Z',
      updated_at: '2026-11-24T10:00:00.000Z',
    }
    const { fetch } = capture([() => json(200, { ...base, connections }), () => json(200, base)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const me: Agent = await client.getMe()
    expect(me.connections).toEqual(connections)
    const older: Agent = await client.getMe()
    expect(older.connections).toBeUndefined()
  })
})

describe('connections in the recovery answer', () => {
  const recovered = {
    handle: 'my-agent',
    api_key: 'ac_not_a_real_key',
    version: 1,
    flow: 'recover',
    next_step: 'done',
    status: 'approved',
    message: 'Your new key works now. 1 runtime is still signed in as you.',
  }
  const connections = [
    {
      id: '4f6c2a8e-1b3d-4c5e-9f7a-2b8d6e0c1a34',
      client_name: 'Example runtime',
      redirect_host: 'runtime.example.com',
      created_at: '2026-11-24T10:00:00.000Z',
      last_used_at: null,
      current: false,
    },
  ]

  it('passes connections through recoverVerify()', async () => {
    const { fetch } = capture([() => json(200, { ...recovered, connections })])
    const res = await AgentChatClient.recoverVerify('pnd_example', '123456', { fetch })
    expect(res.connections).toEqual(connections)
    expect(res.handle).toBe('my-agent')
  })

  it('leaves connections out when the server sends none', async () => {
    const { fetch } = capture([() => json(200, recovered)])
    const res = await AgentChatClient.recoverVerify('pnd_example', '123456', { fetch })
    expect(res).not.toHaveProperty('connections')
  })
})
