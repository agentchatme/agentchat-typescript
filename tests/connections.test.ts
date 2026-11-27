import { describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import {
  AgentChatError,
  ConnectorSignupError,
  NotFoundError,
  RateLimitedError,
  ServerError,
} from '../src/errors.js'
import { flowOf } from '../src/integration/account.js'
import * as sdk from '../src/index.js'
import type { Agent, ConnectorSignupConnect, ConnectorVerifyResult, EndConnectionResult } from '../src/types/index.js'

// ─── Connector sign-in: register and recover with finish, their verify, and connections ───

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

const ordinaryAnswer = {
  pending_id: 'pnd_example',
  message: 'We sent a 6-digit code to agent@example.com. It expires in 10 minutes.',
  version: 1,
  flow: 'register',
  next_step: 'verify',
  status: 'pending',
}

// The connector answers themselves, and the 404 where it is off, are the
// contract fixture's cases (conformance-signup-flow.test.ts).
describe('AgentChatClient.register with finish: "connector"', () => {
  it('leaves finish out of an ordinary sign-up body', async () => {
    const { fetch, calls } = capture([() => json(201, ordinaryAnswer)])
    await AgentChatClient.register({ email: 'agent@example.com', handle: 'my-agent', fetch })
    expect(calls[0]!.body).toEqual({ email: 'agent@example.com', handle: 'my-agent' })
  })

  it('sends finish and resolves the ordinary pending start', async () => {
    const { fetch, calls } = capture([() => json(200, ordinaryAnswer)])
    const started = await AgentChatClient.register({
      email: 'agent@example.com',
      handle: 'my-agent',
      finish: 'connector',
      fetch,
    })
    expect(calls[0]!.body).toEqual({ email: 'agent@example.com', handle: 'my-agent', finish: 'connector' })
    expect(started).toEqual(ordinaryAnswer)
    expect(started).not.toHaveProperty('connect')
  })

  it.each([
    [409, 'HANDLE_TAKEN', AgentChatError],
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
})

describe('AgentChatClient.recover with finish: "connector"', () => {
  const recoverAnswer = { ...ordinaryAnswer, flow: 'recover', next_step: 'recover_verify' }

  it('sends finish only when given', async () => {
    const { fetch, calls } = capture([() => json(200, recoverAnswer)])
    await AgentChatClient.recover('agent@example.com', { handle: 'my-agent', fetch })
    await AgentChatClient.recover('agent@example.com', { fetch })
    await AgentChatClient.recover('agent@example.com', { handle: 'my-agent', finish: 'connector', fetch })
    expect(calls.map((c) => c.body)).toEqual([
      { email: 'agent@example.com', handle: 'my-agent' },
      { email: 'agent@example.com' },
      { email: 'agent@example.com', handle: 'my-agent', finish: 'connector' },
    ])
    expect(calls.every((c) => c.url === `${BASE}/v1/agents/recover`)).toBe(true)
  })

  it('resolves the ordinary pending start', async () => {
    const { fetch } = capture([() => json(200, recoverAnswer)])
    await expect(
      AgentChatClient.recover('agent@example.com', { handle: 'my-agent', finish: 'connector', fetch }),
    ).resolves.toEqual(recoverAnswer)
  })
})

describe('AgentChatClient.verify / recoverVerify on a connector answer', () => {
  const CONNECT: ConnectorSignupConnect = {
    mcp_url: 'https://api.agentchat.me/mcp/connector/acg_example-not-a-real-grant',
    resource: 'https://api.agentchat.me/mcp/connector/acg_example-not-a-real-grant',
    issuer: 'https://api.agentchat.me',
    authorization_endpoint: 'https://api.agentchat.me/oauth/authorize',
    token_endpoint: 'https://api.agentchat.me/oauth/token',
    registration_endpoint: 'https://api.agentchat.me/oauth/register',
    scope: 'agentchat',
    expires_at: '2026-11-17T10:04:00.000Z',
  }
  const REGISTER_MESSAGE = 'Email verified. @my-agent is registered. Add AgentChat to your runtime as a connector at connect.mcp_url.'
  const RECOVER_MESSAGE = 'Email verified. Add AgentChat to your runtime as a connector at connect.mcp_url. Your API key and your wake are unchanged.'
  const registerConnect = {
    agent: { handle: 'my-agent', email: 'agent@example.com' },
    connect: CONNECT,
    claim_url: 'https://app.agentchat.me/claim/acl_example-not-a-real-link',
    claim_expires_at: '2026-11-17T09:14:00.000Z',
    claim_expires_in_s: 600,
    message: REGISTER_MESSAGE,
    version: 1,
    flow: 'register',
    next_step: 'connect',
    status: 'approved',
  }
  const recoverConnect = {
    handle: 'my-agent',
    connect: CONNECT,
    message: RECOVER_MESSAGE,
    version: 1,
    flow: 'recover',
    next_step: 'connect',
    status: 'approved',
  }
  const registerDone = {
    agent: { handle: 'my-agent', email: 'agent@example.com' },
    api_key: 'ac_placeholder_not_a_real_key',
    message: 'Email verified. @my-agent is registered.',
    version: 1,
    flow: 'register',
    next_step: 'done',
    status: 'approved',
  }
  const recoverDone = {
    handle: 'my-agent',
    api_key: 'ac_placeholder_not_a_real_key',
    message: 'Email verified. Your old API key no longer works.',
    version: 1,
    flow: 'recover',
    next_step: 'done',
    status: 'approved',
  }

  it('verify with finish: the connect result, no key and no client; finish is never sent', async () => {
    const { fetch, calls } = capture([() => json(201, registerConnect)])
    const result = await AgentChatClient.verify('pnd_example', '123456', { finish: 'connector', fetch })
    const expected: ConnectorVerifyResult = {
      handle: 'my-agent',
      connect: CONNECT,
      message: REGISTER_MESSAGE,
      claim_url: registerConnect.claim_url,
      claim_expires_at: registerConnect.claim_expires_at,
      claim_expires_in_s: 600,
      version: 1,
      flow: 'register',
      next_step: 'connect',
      status: 'approved',
    }
    expect(result).toEqual(expected)
    expect(result).not.toHaveProperty('apiKey')
    expect(result).not.toHaveProperty('client')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/register/verify` })
    expect(calls[0]!.body).toEqual({ pending_id: 'pnd_example', code: '123456' })
  })

  it('recoverVerify with finish: the connect result, no key and no client; finish is never sent', async () => {
    const { fetch, calls } = capture([() => json(200, recoverConnect)])
    const result = await AgentChatClient.recoverVerify('pnd_example', '123456', { finish: 'connector', fetch })
    expect(result).toEqual({
      handle: 'my-agent',
      connect: CONNECT,
      message: RECOVER_MESSAGE,
      version: 1,
      flow: 'recover',
      next_step: 'connect',
      status: 'approved',
    })
    expect(result).not.toHaveProperty('apiKey')
    expect(result).not.toHaveProperty('client')
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/agents/recover/verify` })
    expect(calls[0]!.body).toEqual({ pending_id: 'pnd_example', code: '123456' })
  })

  it.each([
    ['verify', registerConnect, 201, REGISTER_MESSAGE, 'register'],
    ['recoverVerify', recoverConnect, 200, RECOVER_MESSAGE, 'recover'],
  ] as const)('%s without finish: a connect answer throws ConnectorSignupError carrying connect', async (method, body, status, message, flow) => {
    const { fetch, calls } = capture([() => json(status, body, { 'x-request-id': 'req_example' })])
    const err = await AgentChatClient[method]('pnd_example', '123456', { fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectorSignupError)
    expect(err).toBeInstanceOf(AgentChatError)
    const e = err as ConnectorSignupError
    expect(e.name).toBe('ConnectorSignupError')
    expect(e.connect).toEqual(CONNECT)
    expect(e.handle).toBe('my-agent')
    expect(e.message).toBe(message)
    expect(e.code).toBe('CONNECTOR_SIGNUP')
    expect(e.status).toBe(status)
    expect(e.requestId).toBe('req_example')
    expect(e.result.connect).toEqual(CONNECT)
    expect(e.result).not.toHaveProperty('apiKey')
    // The flow, where every sign-up answer keeps it: the kit reads it as any other.
    expect(e.details).toEqual({ version: 1, flow, next_step: 'connect', status: 'approved' })
    expect(flowOf(e)).toEqual({ version: 1, flow, next_step: 'connect', status: 'approved' })
    expect(calls).toHaveLength(1)
  })

  it('verify with finish and a done answer: the ordinary result, with its key and client', async () => {
    const { fetch } = capture([() => json(201, registerDone)])
    const result = await AgentChatClient.verify('pnd_example', '123456', { finish: 'connector', fetch })
    expect('connect' in result).toBe(false)
    if ('connect' in result) throw new Error('unreachable')
    expect(result.apiKey).toBe(registerDone.api_key)
    expect(result.client).toBeInstanceOf(AgentChatClient)
    expect(result.agent).toEqual(registerDone.agent)
    expect(result.next_step).toBe('done')
  })

  it('recoverVerify with finish and a done answer: the ordinary result, with its key and client', async () => {
    const { fetch } = capture([() => json(200, recoverDone)])
    const result = await AgentChatClient.recoverVerify('pnd_example', '123456', { finish: 'connector', fetch })
    if ('connect' in result) throw new Error('expected the ordinary result')
    expect(result.apiKey).toBe(recoverDone.api_key)
    expect(result.handle).toBe('my-agent')
    expect(result.client).toBeInstanceOf(AgentChatClient)
  })

  it.each(['verify', 'recoverVerify'] as const)(
    '%s never builds a client without a key: a 2xx with no api_key that is not a connect answer throws',
    async (method) => {
      const { fetch } = capture([
        () => json(201, { agent: { handle: 'my-agent' }, handle: 'my-agent', message: 'ok', version: 1, flow: 'register', next_step: 'done', status: 'approved' }),
      ])
      const err = await AgentChatClient[method]('pnd_example', '123456', { fetch }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(AgentChatError)
      expect((err as Error).message).toMatch(/no API key/)
    },
  )

  it.each([
    ['no connect block', { ...recoverConnect, connect: undefined }],
    ['no mcp_url', { ...recoverConnect, connect: { ...CONNECT, mcp_url: undefined } }],
    ['no handle', { ...recoverConnect, handle: undefined }],
  ])('a connect answer with %s throws, with or without finish', async (_what, body) => {
    for (const options of [{}, { finish: 'connector' as const }]) {
      const { fetch } = capture([() => json(200, body)])
      const err = await AgentChatClient.recoverVerify('pnd_example', '123456', { ...options, fetch }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(ConnectorSignupError)
      expect((err as Error).message).toMatch(/next_step "connect"/)
    }
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
