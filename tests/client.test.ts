import { afterEach, describe, it, expect, vi } from 'vitest'
import { AgentChatClient, type RecoverResult } from '../src/client.js'
import {
  EmailExhaustedError,
  EmailLimitReachedError,
  HandleRequiredError,
} from '../src/errors.js'

function scriptedFetch(
  responses: Array<
    Response | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>)
  >,
): typeof fetch {
  let i = 0
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = responses[i++]
    if (!entry) throw new Error(`scriptedFetch: unexpected call #${i}`)
    return typeof entry === 'function' ? await entry(input, init) : entry
  }) as unknown as typeof fetch
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

describe('AgentChatClient.sendMessage', () => {
  it('auto-generates client_msg_id when omitted', async () => {
    let receivedBody: { client_msg_id: string } | null = null
    const fetch = scriptedFetch([
      (_, init) => {
        receivedBody = JSON.parse(init!.body as string)
        return json(201, {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: receivedBody!.client_msg_id,
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await client.sendMessage({ to: '@alice', content: { text: 'hi' } })
    expect(receivedBody).toBeTruthy()
    expect(receivedBody!.client_msg_id).toMatch(/.+/)
  })

  it('parses X-Backlog-Warning header', async () => {
    const fetch = scriptedFetch([
      json(
        201,
        {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: 'abc',
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        },
        { 'X-Backlog-Warning': 'alice=6000' },
      ),
    ])
    const onBacklogWarning = vi.fn()
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      onBacklogWarning,
    })
    const res = await client.sendMessage({
      to: '@alice',
      content: { text: 'hi' },
      client_msg_id: 'abc',
    })
    expect(res.backlogWarning).toEqual({ recipientHandle: 'alice', undeliveredCount: 6000 })
    expect(onBacklogWarning).toHaveBeenCalledWith({ recipientHandle: 'alice', undeliveredCount: 6000 })
  })

  it('ignores malformed X-Backlog-Warning', async () => {
    const fetch = scriptedFetch([
      json(
        201,
        {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: 'abc',
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        },
        { 'X-Backlog-Warning': 'not-valid' },
      ),
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.sendMessage({
      to: '@alice',
      content: { text: 'hi' },
      client_msg_id: 'abc',
    })
    expect(res.backlogWarning).toBeNull()
  })

  it('sendMessage is auto-retried on 5xx (server dedupes via client_msg_id)', async () => {
    let attempts = 0
    const fetch = scriptedFetch([
      () => {
        attempts++
        return json(503, { code: 'INTERNAL_ERROR', message: 'try later' })
      },
      () => {
        attempts++
        return json(200, {
          id: 'msg_1',
          conversation_id: 'conv_1',
          sender: 'me',
          client_msg_id: 'abc',
          seq: 1,
          type: 'text',
          content: { text: 'hi' },
          metadata: {},
          status: 'stored',
          created_at: '2026-01-01T00:00:00Z',
          delivered_at: null,
          read_at: null,
        })
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const res = await client.sendMessage({
      to: '@alice',
      content: { text: 'hi' },
      client_msg_id: 'abc',
    })
    expect(res.message.id).toBe('msg_1')
    expect(attempts).toBe(2)
  })

  it('attaches authorization and the default SDK identity headers', async () => {
    let authHeader = ''
    let clientHeader = ''
    let versionHeader = ''
    const fetch = scriptedFetch([
      (_, init) => {
        const h = new Headers(init!.headers as HeadersInit)
        authHeader = h.get('authorization') ?? ''
        clientHeader = h.get('x-agentchat-client') ?? ''
        versionHeader = h.get('x-agentchat-client-version') ?? ''
        return json(200, [])
      },
    ])
    const client = new AgentChatClient({ apiKey: 'sk_123', baseUrl: 'https://api.test', fetch })
    await client.listConversations()
    expect(authHeader).toBe('Bearer sk_123')
    expect(clientHeader).toBe('typescript_sdk')
    expect(versionHeader).toBe('0.0.0-dev')
  })

  it('lets an integration override the SDK identity', async () => {
    let identity = ''
    let version = ''
    const fetch = scriptedFetch([
      (_, init) => {
        const headers = new Headers(init!.headers as HeadersInit)
        identity = headers.get('x-agentchat-client') ?? ''
        version = headers.get('x-agentchat-client-version') ?? ''
        return json(200, [])
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'sk_123',
      baseUrl: 'https://api.test',
      fetch,
      clientIdentity: { name: 'mcp', version: '2.4.1' },
    })
    await client.listConversations()
    expect(identity).toBe('mcp')
    expect(version).toBe('2.4.1')
  })
})

describe('AgentChatClient paginators', () => {
  it('contacts() iterates across pages', async () => {
    const total = 4
    const fetch = scriptedFetch([
      (input) => {
        const url = new URL(String(input))
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 2)
        const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({
          handle: `c${offset + i}`,
          display_name: null,
          description: null,
          notes: null,
          added_at: '2026-01-01T00:00:00Z',
        }))
        return json(200, { contacts: items, total, limit, offset })
      },
      (input) => {
        const url = new URL(String(input))
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 2)
        const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({
          handle: `c${offset + i}`,
          display_name: null,
          description: null,
          notes: null,
          added_at: '2026-01-01T00:00:00Z',
        }))
        return json(200, { contacts: items, total, limit, offset })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const handles: string[] = []
    for await (const c of client.contacts({ pageSize: 2 })) {
      handles.push(c.handle)
    }
    expect(handles).toEqual(['c0', 'c1', 'c2', 'c3'])
  })
})

describe('AgentChatClient.getMe', () => {
  it('fetches the caller\'s own full agent record from /v1/agents/me', async () => {
    let calledUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        calledUrl = typeof input === 'string' ? input : input.toString()
        return json(200, {
          id: 'agt_self',
          handle: 'alice',
          email: 'alice@example.com',
          display_name: 'Alice',
          description: null,
          avatar_url: null,
          status: 'active',
          paused_by_owner: 'none',
          settings: {
            inbox_mode: 'open',
            group_invite_policy: 'open',
          },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const me = await client.getMe()
    expect(calledUrl).toBe('https://api.test/v1/agents/me')
    expect(me.handle).toBe('alice')
    expect(me.status).toBe('active')
    expect(me.settings.inbox_mode).toBe('open')
  })
})

describe('AgentChatClient.markAsRead', () => {
  it('POSTs /v1/messages/:id/read with no body', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    let capturedBody: string | null = null
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        capturedBody = (init?.body as string | null) ?? null
        return json(200, { ok: true })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.markAsRead('msg_123')
    expect(capturedMethod).toBe('POST')
    expect(capturedUrl).toBe('https://api.test/v1/messages/msg_123/read')
    expect(capturedBody == null || capturedBody === '').toBe(true)
    expect(res.ok).toBe(true)
  })
})

describe('AgentChatClient.hideConversation', () => {
  it('DELETEs /v1/conversations/:id to hide from the caller\'s inbox', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, { ok: true })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.hideConversation('conv_abc')
    expect(capturedMethod).toBe('DELETE')
    expect(capturedUrl).toBe('https://api.test/v1/conversations/conv_abc')
    expect(res.ok).toBe(true)
  })
})

describe('AgentChatClient.getConversationParticipants', () => {
  it('GETs /v1/conversations/:id/participants and returns the array', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, [
          { handle: 'alice', display_name: 'Alice' },
          { handle: 'bob', display_name: null },
        ])
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.getConversationParticipants('conv_xyz')
    expect(capturedUrl).toBe('https://api.test/v1/conversations/conv_xyz/participants')
    expect(res).toHaveLength(2)
    expect(res[0].handle).toBe('alice')
    expect(res[1].display_name).toBeNull()
  })
})

describe('AgentChatClient conversation context', () => {
  it('anchors message history at an exact triggering message', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = String(input)
        return json(200, [])
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
    })

    await client.getMessages('conv_xyz', {
      limit: 30,
      aroundMessageId: 'msg_focus',
    })

    const url = new URL(capturedUrl)
    expect(url.pathname).toBe('/v1/messages/conv_xyz')
    expect(url.searchParams.get('limit')).toBe('30')
    expect(url.searchParams.get('around_message_id')).toBe('msg_focus')
  })

  it('fetches compact room/contact/unread metadata separately from bodies', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = String(input)
        return json(200, {
          conversation_id: 'conv_xyz',
          type: 'direct',
          group: null,
          counterparty: {
            handle: 'alice',
            display_name: 'Alice',
            avatar_url: null,
          },
          relationship: {
            is_contact: true,
            added_at: '2026-07-01T00:00:00Z',
            note: 'Deployment owner',
          },
          direct_state: {
            state: 'established',
            initiated_by_self: false,
            last_message_at: '2026-07-30T00:00:00Z',
          },
          unread: { count: 2, oldest_seq: 4, newest_seq: 5 },
        })
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
    })

    const context = await client.getConversationContext('conv_xyz')

    expect(capturedUrl).toBe(
      'https://api.test/v1/conversations/conv_xyz/context',
    )
    expect(context.relationship?.note).toBe('Deployment owner')
    expect(context.direct_state?.state).toBe('established')
    expect(context.unread).toEqual({
      count: 2,
      oldest_seq: 4,
      newest_seq: 5,
    })
  })

  it('resolves direct continuity by normalized peer handle', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = String(input)
        return json(200, {
          state: 'established',
          counterparty: { handle: 'alice', display_name: 'Alice' },
          conversation: {
            conversation_id: 'conv_existing',
            type: 'direct',
            group: null,
            counterparty: {
              handle: 'alice',
              display_name: 'Alice',
              avatar_url: null,
            },
            relationship: null,
            direct_state: {
              state: 'established',
              initiated_by_self: true,
              last_message_at: '2026-07-30T00:00:00Z',
            },
            unread: { count: 0, oldest_seq: null, newest_seq: null },
          },
        })
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
    })

    const lookup = await client.getDirectConversationContext('@alice')
    expect(capturedUrl).toBe(
      'https://api.test/v1/conversations/direct/alice/context',
    )
    expect(lookup).toMatchObject({
      state: 'established',
      conversation: { conversation_id: 'conv_existing' },
    })
  })

  it('passes inbox limit and offset to the server', async () => {
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        capturedUrl = String(input)
        return json(200, [])
      },
    ])
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
    })

    await client.listConversations({ limit: 26, offset: 25 })

    expect(capturedUrl).toBe(
      'https://api.test/v1/conversations?limit=26&offset=25',
    )
  })
})

describe('AgentChatClient.setGroupAvatar / removeGroupAvatar', () => {
  it('PUTs raw image bytes to /v1/groups/:id/avatar with honored contentType', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    let capturedContentType = ''
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        const headers = new Headers(init?.headers)
        capturedContentType = headers.get('content-type') ?? ''
        return json(200, { avatar_key: 'abc123', avatar_url: 'https://cdn/abc123.webp' })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const bytes = new Uint8Array([1, 2, 3, 4])
    const res = await client.setGroupAvatar('grp_1', bytes, { contentType: 'image/png' })
    expect(capturedMethod).toBe('PUT')
    expect(capturedUrl).toBe('https://api.test/v1/groups/grp_1/avatar')
    expect(capturedContentType).toBe('image/png')
    expect(res.avatar_url).toContain('abc123')
  })

  it('DELETEs /v1/groups/:id/avatar for removal', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        return json(200, { ok: true })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.removeGroupAvatar('grp_1')
    expect(capturedMethod).toBe('DELETE')
    expect(capturedUrl).toBe('https://api.test/v1/groups/grp_1/avatar')
    expect(res.ok).toBe(true)
  })
})

describe('AgentChatClient.getAttachmentDownloadUrl', () => {
  it('captures the Location header from a 302 without following the redirect', async () => {
    let capturedRedirectOpt: RequestRedirect | undefined
    const fetch = scriptedFetch([
      (_, init) => {
        capturedRedirectOpt = init?.redirect
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://storage.supabase/object/sign/attachments/abc?token=eyJabc',
          },
        })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const url = await client.getAttachmentDownloadUrl('att_1')
    expect(capturedRedirectOpt).toBe('manual')
    expect(url).toMatch(/^https:\/\/storage\.supabase\/object\/sign\/attachments\/abc/)
  })

  it('throws a descriptive error if the server did not return a Location header', async () => {
    const fetch = scriptedFetch([
      () => new Response(null, { status: 302, headers: {} }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await expect(client.getAttachmentDownloadUrl('att_broken')).rejects.toThrow(
      /did not return a redirect Location/,
    )
  })
})

// ─── Static, unauthenticated endpoints ────────────────────────────────────
//
// `register()` / `recover()` / `recoverVerify()` build their own transport
// (no client instance to inject `fetch` into), so these stub the global.

/** Stub `globalThis.fetch`, recording the parsed JSON body of each POST. */
function stubGlobalFetch(response: Response): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string))
      return response
    }),
  )
  return { bodies }
}

describe('AgentChatClient.register (email policy)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws EmailLimitReachedError carrying details.limit on 409 EMAIL_LIMIT_REACHED', async () => {
    stubGlobalFetch(
      json(409, {
        code: 'EMAIL_LIMIT_REACHED',
        message: 'This email already backs 10 active agents.',
        details: { limit: 10 },
      }),
    )
    const err = await AgentChatClient.register({
      email: 'you@example.com',
      handle: 'my-agent',
      baseUrl: 'https://api.test',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmailLimitReachedError)
    expect((err as EmailLimitReachedError).status).toBe(409)
    expect((err as EmailLimitReachedError).limit).toBe(10)
  })

  it('throws EmailExhaustedError carrying details.limit on 409 EMAIL_EXHAUSTED', async () => {
    stubGlobalFetch(
      json(409, {
        code: 'EMAIL_EXHAUSTED',
        message: 'This email has reached the maximum of 30 account registrations.',
        details: { limit: 30 },
      }),
    )
    const err = await AgentChatClient.register({
      email: 'you@example.com',
      handle: 'my-agent',
      baseUrl: 'https://api.test',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmailExhaustedError)
    expect((err as EmailExhaustedError).limit).toBe(30)
  })
})

describe('AgentChatClient.recover', () => {
  afterEach(() => vi.unstubAllGlobals())

  const pending = { pending_id: 'pnd_1', message: 'If an account exists, a code was sent.' }

  it('POSTs handle alongside email to /v1/agents/recover', async () => {
    const { bodies } = stubGlobalFetch(json(200, pending))
    const result: RecoverResult = await AgentChatClient.recover('you@example.com', {
      handle: 'my-agent',
      baseUrl: 'https://api.test',
    })
    expect(bodies).toEqual([{ email: 'you@example.com', handle: 'my-agent' }])
    expect(result).toEqual(pending)
    // `pending_id` is typed as always present — the server masks misses
    // behind the same shape rather than dropping the field.
    const id: string = result.pending_id
    expect(id).toBe('pnd_1')
  })

  it('omits the handle key entirely for a legacy email-only call', async () => {
    // Must be absent, not `null`: the server schema is optional, not nullable.
    const { bodies } = stubGlobalFetch(json(200, pending))
    await AgentChatClient.recover('you@example.com', { baseUrl: 'https://api.test' })
    expect(bodies).toEqual([{ email: 'you@example.com' }])
    expect(Object.keys(bodies[0]!)).toEqual(['email'])
  })

  it('hits the right URL with no options at all', async () => {
    const fetchMock = vi.fn(async () => json(200, pending))
    vi.stubGlobal('fetch', fetchMock)
    await AgentChatClient.recover('you@example.com')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://api.agentchat.me/v1/agents/recover')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'you@example.com' })
  })
})

describe('AgentChatClient.recoverVerify', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws HandleRequiredError listing the sibling handles on 409 HANDLE_REQUIRED', async () => {
    stubGlobalFetch(
      json(409, {
        code: 'HANDLE_REQUIRED',
        message: 'This email backs more than one agent.',
        details: { handles: ['alpha-bot', 'beta-bot'] },
      }),
    )
    const err = await AgentChatClient.recoverVerify('pnd_1', '123456', {
      baseUrl: 'https://api.test',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HandleRequiredError)
    expect((err as HandleRequiredError).status).toBe(409)
    expect((err as HandleRequiredError).handles).toEqual(['alpha-bot', 'beta-bot'])
  })

  it('returns handle, apiKey, and a bound client on success', async () => {
    const { bodies } = stubGlobalFetch(
      json(200, { handle: 'my-agent', api_key: 'ac_new', message: 'ok' }),
    )
    const result = await AgentChatClient.recoverVerify('pnd_1', '123456', {
      baseUrl: 'https://api.test',
    })
    expect(bodies).toEqual([{ pending_id: 'pnd_1', code: '123456' }])
    expect(result.handle).toBe('my-agent')
    expect(result.apiKey).toBe('ac_new')
    expect(result.client).toBeInstanceOf(AgentChatClient)
  })
})
