import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import { ConnectionError, NotFoundError } from '../src/errors.js'
import type { InboxTray, ReplyDecision, Texts } from '../src/types/index.js'

// ─── client.inbox / decisions / conversations / texts ──────────────────────

interface Captured {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
  signal: AbortSignal | null | undefined
}

function capture(response: () => Response) {
  const calls: Captured[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal,
    })
    return response()
  }) as unknown as typeof fetch
  return { fetch, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const emptyTray: InboxTray = {
  you: '@me',
  question: 'q',
  categories: ['other'],
  conversations: [],
  deferred: 0,
  truncated: false,
  waited_ms: null,
}

const decision: ReplyDecision = {
  id: 'dec_1',
  conversation_id: 'conv_1',
  decision: 'dismiss',
  category: 'closing',
  through_message_id: 'msg_1',
  defer_until: null,
  created_at: '2026-11-04T23:00:00.000Z',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('client.inbox.tray', () => {
  it('GETs /v1/inbox with no query for a plain read', async () => {
    const { fetch, calls } = capture(() => json(200, emptyTray))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const tray = await client.inbox.tray()
    expect(tray).toEqual(emptyTray)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://api.test/v1/inbox')
  })

  it('passes wait_ms and limit as query parameters', async () => {
    const { fetch, calls } = capture(() => json(200, { ...emptyTray, waited_ms: 1200 }))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const tray = await client.inbox.tray({ waitMs: 25_000, limit: 5 })
    expect(tray.waited_ms).toBe(1200)
    expect(calls[0]?.url).toBe('https://api.test/v1/inbox?wait_ms=25000&limit=5')
  })

  it('works when destructured off the client', async () => {
    const { fetch } = capture(() => json(200, emptyTray))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const { tray } = client.inbox
    await expect(tray()).resolves.toEqual(emptyTray)
  })

  it('does not time out a long-poll before the server wait has elapsed', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (r: Response) => void
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }) as unknown as typeof fetch
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    })

    const pending = client.inbox.tray({ waitMs: 50_000 })
    // The transport default (30 s) would have fired by now.
    await vi.advanceTimersByTimeAsync(45_000)
    expect(signal?.aborted).toBe(false)
    resolveFetch(json(200, { ...emptyTray, waited_ms: 45_000 }))
    await expect(pending).resolves.toMatchObject({ waited_ms: 45_000 })
  })

  it('does time out once the wait plus grace has elapsed', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    ) as unknown as typeof fetch
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const pending = client.inbox.tray({ waitMs: 1_000 })
    const outcome = pending.then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await vi.advanceTimersByTimeAsync(11_001)
    expect(await outcome).toBeInstanceOf(ConnectionError)
  })

  it('honours an explicit timeoutMs over the derived one', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    ) as unknown as typeof fetch
    const client = new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const outcome = client.inbox.tray({ waitMs: 50_000, timeoutMs: 2_000 }).then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await vi.advanceTimersByTimeAsync(2_001)
    expect(await outcome).toBeInstanceOf(ConnectionError)
  })
})

describe('client.decisions.record', () => {
  it('POSTs the verdict with the anchor and unwraps the decision', async () => {
    const { fetch, calls } = capture(() => json(201, { decision }))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const result = await client.decisions.record('conv_1', {
      decision: 'dismiss',
      category: 'closing',
      throughMessageId: 'msg_1',
    })
    expect(result).toEqual(decision)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://api.test/v1/conversations/conv_1/decisions')
    expect(calls[0]?.body).toEqual({
      decision: 'dismiss',
      category: 'closing',
      through_message_id: 'msg_1',
    })
  })

  it('leaves optional fields off the wire entirely when unset', async () => {
    const { fetch, calls } = capture(() => json(201, { decision: { ...decision, decision: 'reply' } }))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await client.decisions.record('conv_1', { decision: 'reply' })
    expect(calls[0]?.body).toEqual({ decision: 'reply' })
    expect(Object.keys(calls[0]?.body as object)).toEqual(['decision'])
  })

  it('URL-encodes the conversation id', async () => {
    const { fetch, calls } = capture(() => json(201, { decision }))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await client.decisions.record('conv/odd id', { decision: 'defer' })
    expect(calls[0]?.url).toBe('https://api.test/v1/conversations/conv%2Fodd%20id/decisions')
  })

  it('takes call options in the same object and keeps them off the wire', async () => {
    const { fetch, calls } = capture(() => json(201, { decision }))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const controller = new AbortController()
    await client.decisions.record('conv_1', {
      decision: 'dismiss',
      throughMessageId: 'msg_1',
      idempotencyKey: 'idem-123',
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    expect(calls[0]?.body).toEqual({ decision: 'dismiss', through_message_id: 'msg_1' })
    expect(calls[0]?.headers['idempotency-key']).toBe('idem-123')
    expect(calls[0]?.signal).toBeDefined()
  })
})

describe('client.conversations.markRead', () => {
  it('POSTs the anchor and returns the count', async () => {
    const { fetch, calls } = capture(() => json(200, { read: 3 }))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const result = await client.conversations.markRead('conv_1', 'msg_9')
    expect(result).toEqual({ read: 3 })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://api.test/v1/conversations/conv_1/read')
    expect(calls[0]?.body).toEqual({ through_message_id: 'msg_9' })
  })

  it('surfaces a foreign anchor as NotFoundError', async () => {
    const { fetch } = capture(() =>
      json(404, { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' }),
    )
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await expect(client.conversations.markRead('conv_1', 'msg_other')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})

describe('client.texts.get', () => {
  it('GETs /v1/texts for the runtime', async () => {
    const texts: Texts = {
      version: '1',
      manual: { url: 'https://agentchat.me/manual', version: '2.1.2' },
      wake_instruction: 'w',
      invite_prompt: 'i',
      identity_line: 'l',
      identity_line_template: 't',
    }
    const { fetch, calls } = capture(() => json(200, texts))
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const result = await client.texts.get({ runtime: 'claude-code', timeoutMs: 5_000 })
    expect(result).toEqual(texts)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://api.test/v1/texts?runtime=claude-code')
  })
})
