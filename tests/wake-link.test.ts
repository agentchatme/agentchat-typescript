import { describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import { AgentChatError, RateLimitedError, ServerError, ValidationError } from '../src/errors.js'
import * as sdk from '../src/index.js'
import type { CreateWakeLinkResult } from '../src/types/index.js'

// ─── Wake links: the person pastes the trigger's URL and secret on AgentChat's page ───

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

const ROUTE = 'https://api.agentchat.me/v1/agents/me/wake-links'

// A placeholder link: the shape the server answers, not a real token.
const URL_ = 'https://app.agentchat.test/wake/awl_example'
const LINE = `Give this link to the person you work with. On it they paste your trigger's URL and secret; AgentChat tests it with one wake and saves it. This link expires in 60 minutes: ${URL_}`

const link: CreateWakeLinkResult = {
  wake_url: URL_,
  expires_at: '2026-11-22T15:00:00.000Z',
  expires_in_s: 3600,
  message: LINE,
}

describe('client.createWakeLink', () => {
  it('POSTs /v1/agents/me/wake-links with the dialect only and returns the server answer', async () => {
    const { fetch, calls } = capture([() => json(201, link)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.createWakeLink({ dialect: 'claude-code' })).resolves.toEqual(link)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: ROUTE })
    expect(calls[0]!.body).toEqual({ dialect: 'claude-code' })
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined()
    expect(calls[0]!.headers.authorization).toBe('Bearer k')
  })

  it('sends url and rewake when given, and never the call options', async () => {
    const { fetch, calls } = capture([() => json(201, link)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await client.createWakeLink({
      dialect: 'standard-webhooks',
      url: 'https://hooks.example.com/agent',
      rewake: false,
      timeoutMs: 5_000,
      idempotencyKey: 'caller-key-1',
    })
    expect(calls[0]!.body).toEqual({ dialect: 'standard-webhooks', url: 'https://hooks.example.com/agent', rewake: false })
  })

  it('is never retried: a transient failure is one attempt, even with a retry policy', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(201, link)])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await expect(client.createWakeLink({ dialect: 'agentchat' })).rejects.toBeInstanceOf(AgentChatError)
    await expect(client.createWakeLink({ dialect: 'agentchat', retry: fastRetry })).resolves.toEqual(link)
    expect(calls).toHaveLength(2)
  })

  it('a caller-supplied Idempotency-Key and retry policy still give exactly one attempt on a 503, and no key is sent', async () => {
    for (const retry of [fastRetry, 'auto'] as const) {
      const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(201, link)])
      const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
      await expect(
        client.createWakeLink({ dialect: 'agentchat', idempotencyKey: 'caller-key-1', retry }),
      ).rejects.toBeInstanceOf(AgentChatError)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.headers['idempotency-key']).toBeUndefined()
    }
  })

  it('keeps the caller signal and timeout', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return json(201, link)
    }) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    controller.abort()
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.createWakeLink({ dialect: 'agentchat', signal: controller.signal, timeoutMs: 5_000 })).rejects.toThrow()
    await expect(client.createWakeLink({ dialect: 'agentchat', timeoutMs: 5_000 })).resolves.toEqual(link)
  })

  it('400 INVALID_WAKE_WEBHOOK_URL and WAKE_WEBHOOK_URL_UNRESOLVED are plain AgentChatErrors carrying their code', async () => {
    for (const code of ['INVALID_WAKE_WEBHOOK_URL', 'WAKE_WEBHOOK_URL_UNRESOLVED'] as const) {
      const message = `The webhook URL was refused (${code}).`
      const { fetch, calls } = capture([() => json(400, { code, message })])
      const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
      const err = (await client
        .createWakeLink({ dialect: 'agentchat', url: 'https://hooks.example.com/agent' })
        .catch((e: unknown) => e)) as AgentChatError
      expect(err.constructor).toBe(AgentChatError)
      expect(err.code).toBe(sdk.ErrorCode[code])
      expect(err.status).toBe(400)
      expect(err.message).toBe(message)
      expect(calls).toHaveLength(1)
    }
  })

  it('400 VALIDATION_ERROR is a ValidationError', async () => {
    const { fetch } = capture([() => json(400, { code: 'VALIDATION_ERROR', message: 'dialect: Invalid enum value' })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const err = await client.createWakeLink({ dialect: 'not-a-dialect' as 'agentchat' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
  })

  it('409 WAKE_DESTINATION_EXISTS is a plain AgentChatError carrying its code', async () => {
    const message = 'This agent has a wake check. Clear it first (DELETE /v1/agents/me/wake-check).'
    const { fetch } = capture([() => json(409, { code: 'WAKE_DESTINATION_EXISTS', message })])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const err = (await client.createWakeLink({ dialect: 'agentchat' }).catch((e: unknown) => e)) as AgentChatError
    expect(err.constructor).toBe(AgentChatError)
    expect(err.code).toBe(sdk.ErrorCode.WAKE_DESTINATION_EXISTS)
    expect(err.status).toBe(409)
    expect(err.message).toBe(message)
  })

  it('429 RATE_LIMITED is a RateLimitedError with the wait, and is not retried', async () => {
    const { fetch, calls } = capture([
      () =>
        json(
          429,
          { code: 'RATE_LIMITED', message: 'Too many wake links. Try again in 42 minutes.', details: { retry_after_s: 2520 } },
          { 'Retry-After': '2520' },
        ),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    const err = (await client.createWakeLink({ dialect: 'agentchat' }).catch((e: unknown) => e)) as RateLimitedError
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err.retryAfterMs).toBe(2_520_000)
    expect(err.retryAfterS).toBe(2520)
    expect(calls).toHaveLength(1)
  })

  it('503 WAKE_LINKS_UNAVAILABLE and WAKE_SECRET_UNAVAILABLE are ServerErrors carrying their code, one attempt', async () => {
    for (const code of ['WAKE_LINKS_UNAVAILABLE', 'WAKE_SECRET_UNAVAILABLE'] as const) {
      const { fetch, calls } = capture([() => json(503, { code, message: 'Not available on this server.' }), () => json(201, link)])
      const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
      const err = (await client.createWakeLink({ dialect: 'agentchat' }).catch((e: unknown) => e)) as ServerError
      expect(err).toBeInstanceOf(ServerError)
      expect(err.code).toBe(sdk.ErrorCode[code])
      expect(err.status).toBe(503)
      expect(calls).toHaveLength(1)
    }
  })
})

describe('public surface', () => {
  it('exports the client method and the wake-link error codes', () => {
    expect(typeof AgentChatClient.prototype.createWakeLink).toBe('function')
    expect(sdk.ErrorCode.INVALID_WAKE_WEBHOOK_URL).toBe('INVALID_WAKE_WEBHOOK_URL')
    expect(sdk.ErrorCode.WAKE_WEBHOOK_URL_UNRESOLVED).toBe('WAKE_WEBHOOK_URL_UNRESOLVED')
    expect(sdk.ErrorCode.WAKE_LINKS_UNAVAILABLE).toBe('WAKE_LINKS_UNAVAILABLE')
    expect(sdk.ErrorCode.WAKE_SECRET_UNAVAILABLE).toBe('WAKE_SECRET_UNAVAILABLE')
  })
})
