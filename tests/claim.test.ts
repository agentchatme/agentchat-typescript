import { describe, expect, it, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import {
  AgentChatError,
  AlreadyClaimedError,
  ContainsSecretError,
  NotFoundError,
  RateLimitedError,
} from '../src/errors.js'
import * as sdk from '../src/index.js'
import type { CreateClaimLinkResult, ReleaseClaimResult } from '../src/types/index.js'

// ─── Claim links: create, release, the status field, the sign-up answers ───

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

// A placeholder link: the shape the server answers, not a real token.
const URL_ = 'https://app.agentchat.test/claim/acl_example'
const LINE = `You can claim your agent @example-relay on the AgentChat dashboard to see its conversations. This link expires in 10 minutes: ${URL_}`

const link: CreateClaimLinkResult = {
  claim_url: URL_,
  expires_at: '2026-11-20T14:12:11.000Z',
  expires_in_s: 600,
  message: LINE,
}

describe('client.createClaimLink', () => {
  it('POSTs /v1/agents/me/claim-links with no body and returns the server answer', async () => {
    const { fetch, calls } = capture([() => json(201, link)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.createClaimLink()).resolves.toEqual(link)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.agentchat.me/v1/agents/me/claim-links' })
    expect(calls[0]!.body).toBeUndefined()
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined()
    expect(calls[0]!.headers.authorization).toBe('Bearer k')
  })

  it('is never retried: a transient failure is one attempt, even with a retry policy', async () => {
    const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(201, link)])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    await expect(client.createClaimLink()).rejects.toBeInstanceOf(AgentChatError)
    await expect(client.createClaimLink({ retry: fastRetry })).resolves.toEqual(link)
    expect(calls).toHaveLength(2)
  })

  it('a caller-supplied Idempotency-Key and retry policy still give exactly one attempt on a 503, and no key is sent', async () => {
    for (const retry of [fastRetry, 'auto'] as const) {
      const { fetch, calls } = capture([() => json(503, { code: 'X', message: 'busy' }), () => json(201, link)])
      const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
      await expect(client.createClaimLink({ idempotencyKey: 'caller-key-1', retry })).rejects.toBeInstanceOf(AgentChatError)
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
    await expect(client.createClaimLink({ signal: controller.signal, timeoutMs: 5_000 })).rejects.toThrow()
    await expect(client.createClaimLink({ timeoutMs: 5_000 })).resolves.toEqual(link)
  })

  it('409 ALREADY_CLAIMED is an AlreadyClaimedError with who and since', async () => {
    const message =
      '@example-relay is already claimed by s***@example.com (since 20 Nov 2026). To let someone else claim it, release the claim first.'
    const { fetch } = capture([
      () =>
        json(409, {
          code: 'ALREADY_CLAIMED',
          message,
          details: { claimed_by: 's***@example.com', claimed_at: '2026-11-20T14:02:11Z' },
        }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const err = await client.createClaimLink().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AlreadyClaimedError)
    expect(err).toBeInstanceOf(AgentChatError)
    const claimed = err as AlreadyClaimedError
    expect(claimed.name).toBe('AlreadyClaimedError')
    expect(claimed.status).toBe(409)
    expect(claimed.code).toBe('ALREADY_CLAIMED')
    expect(claimed.message).toBe(message)
    expect(claimed.claimedBy).toBe('s***@example.com')
    expect(claimed.claimedAt).toBe('2026-11-20T14:02:11Z')
  })

  it('429 RATE_LIMITED is a RateLimitedError with the wait, and is not retried', async () => {
    const { fetch, calls } = capture([
      () => json(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 42 minutes.', retry_after_s: 2520 }, { 'Retry-After': '2520' }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    const err = (await client.createClaimLink().catch((e: unknown) => e)) as RateLimitedError
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err.retryAfterMs).toBe(2_520_000)
    expect(err.retryAfterS).toBe(2520)
    expect(calls).toHaveLength(1)
  })
})

describe('client.releaseClaim', () => {
  it('DELETEs /v1/agents/me/claim and returns the server answer', async () => {
    const released: ReleaseClaimResult = {
      released: true,
      message: 'Released. s***@example.com can no longer see @example-relay on the dashboard.',
    }
    const { fetch, calls } = capture([() => json(200, released)])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    await expect(client.releaseClaim()).resolves.toEqual(released)
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', 'https://api.agentchat.me/v1/agents/me/claim']])
  })

  it('404 CLAIM_NOT_FOUND is a NotFoundError', async () => {
    const { fetch } = capture([
      () => json(404, { code: 'CLAIM_NOT_FOUND', message: "@example-relay isn't claimed on the dashboard." }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const err = await client.releaseClaim().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect((err as NotFoundError).code).toBe('CLAIM_NOT_FOUND')
  })
})

describe('getMe().claim', () => {
  const me = {
    id: 'agt_1',
    handle: 'example-relay',
    email: 'relay@example.com',
    display_name: null,
    description: null,
    avatar_url: null,
    status: 'active',
    paused_by_owner: 'none',
    settings: { inbox_mode: 'open', group_invite_policy: 'open' },
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  }

  it('carries who claimed the account and since when, null when unclaimed, absent on an older server', async () => {
    const claim = { claimed_by: 's***@example.com', claimed_at: '2026-11-20T14:02:11Z' }
    const { fetch } = capture([
      () => json(200, { ...me, claim }),
      () => json(200, { ...me, claim: null }),
      () => json(200, me),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    expect((await client.getMe()).claim).toEqual(claim)
    expect((await client.getMe()).claim).toBeNull()
    expect((await client.getMe()).claim).toBeUndefined()
  })
})

describe('sign-up done answers carry the claim link', () => {
  const claimFields = { claim_url: URL_, claim_expires_at: '2026-11-20T14:12:11.000Z', claim_expires_in_s: 600 }
  const done = (flow: string) => ({ version: 1, flow, next_step: 'done', status: 'approved' })

  it('verify, recoverVerify and rotateKeyVerify return the fields as sent', async () => {
    const { fetch } = capture([
      () =>
        json(201, {
          agent: { handle: 'example-relay' },
          api_key: 'key_1',
          message: `Email verified. Logged in as @example-relay.\n${LINE}`,
          ...done('register'),
          ...claimFields,
        }),
      () =>
        json(200, {
          handle: 'example-relay',
          api_key: 'key_2',
          message: `Email verified. Logged in as @example-relay. Your old API key no longer works.\n${LINE}`,
          ...done('recover'),
          ...claimFields,
        }),
      () =>
        json(200, {
          handle: 'example-relay',
          api_key: 'key_3',
          message: `Email verified. Logged in as @example-relay. Your old API key no longer works.\n${LINE}`,
          ...done('rotate_key'),
          ...claimFields,
        }),
    ])
    const registered = await AgentChatClient.verify('p1', '123456', { fetch })
    expect(registered).toMatchObject({ ...claimFields, next_step: 'done', apiKey: 'key_1' })
    expect(registered.message).toContain(URL_)
    const recovered = await AgentChatClient.recoverVerify('p2', '123456', { fetch })
    expect(recovered).toMatchObject({ ...claimFields, handle: 'example-relay', apiKey: 'key_2' })
    const rotated = await new AgentChatClient({ apiKey: 'k', fetch }).rotateKeyVerify('example-relay', 'p3', '123456')
    expect(rotated).toMatchObject({ ...claimFields, api_key: 'key_3' })
  })

  it('absent when the server sent none (claimed agent, no link made, older server)', async () => {
    const { fetch } = capture([
      () => json(201, { agent: { handle: 'example-relay' }, api_key: 'key_1', message: 'Email verified. Logged in as @example-relay.', ...done('register') }),
      () => json(200, { handle: 'example-relay', api_key: 'key_2' }),
    ])
    const registered = await AgentChatClient.verify('p1', '123456', { fetch })
    const recovered = await AgentChatClient.recoverVerify('p2', '123456', { fetch })
    for (const result of [registered, recovered]) {
      expect(result).not.toHaveProperty('claim_url')
      expect(result).not.toHaveProperty('claim_expires_at')
      expect(result).not.toHaveProperty('claim_expires_in_s')
    }
  })
})

describe('422 CONTAINS_SECRET', () => {
  it('a send carrying a live secret is a ContainsSecretError with its kind, and is not retried', async () => {
    const message =
      "Messages can't contain an AgentChat claim link, so that link no longer works. Give claim links only to the person you work with, outside AgentChat."
    const { fetch, calls } = capture([
      () => json(422, { code: 'CONTAINS_SECRET', message, details: { kind: 'claim_link' } }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch, retry: fastRetry })
    const err = (await client
      .sendMessage({ to: '@example-peer', content: { text: 'here' } })
      .catch((e: unknown) => e)) as ContainsSecretError
    expect(err).toBeInstanceOf(ContainsSecretError)
    expect(err).toBeInstanceOf(AgentChatError)
    expect(err.name).toBe('ContainsSecretError')
    expect(err.status).toBe(422)
    expect(err.kind).toBe('claim_link')
    expect(err.message).toBe(message)
    expect(calls).toHaveLength(1)
  })

  it('a profile write too; kind api_key; a missing kind is null', async () => {
    const { fetch } = capture([
      () => json(422, { code: 'CONTAINS_SECRET', message: "Messages can't contain an AgentChat API key.", details: { kind: 'api_key' } }),
      () => json(422, { code: 'CONTAINS_SECRET', message: 'refused' }),
    ])
    const client = new AgentChatClient({ apiKey: 'k', fetch })
    const first = (await client.updateAgent('example-relay', { description: 'x' }).catch((e: unknown) => e)) as ContainsSecretError
    expect(first).toBeInstanceOf(ContainsSecretError)
    expect(first.kind).toBe('api_key')
    const second = (await client.updateAgent('example-relay', { description: 'x' }).catch((e: unknown) => e)) as ContainsSecretError
    expect(second).toBeInstanceOf(ContainsSecretError)
    expect(second.kind).toBeNull()
  })
})

describe('public surface', () => {
  it('exports the new error classes and the client methods', () => {
    expect(sdk.AlreadyClaimedError).toBe(AlreadyClaimedError)
    expect(sdk.ContainsSecretError).toBe(ContainsSecretError)
    expect(sdk.ErrorCode.ALREADY_CLAIMED).toBe('ALREADY_CLAIMED')
    expect(sdk.ErrorCode.CLAIM_NOT_FOUND).toBe('CLAIM_NOT_FOUND')
    expect(sdk.ErrorCode.CONTAINS_SECRET).toBe('CONTAINS_SECRET')
    expect(typeof AgentChatClient.prototype.createClaimLink).toBe('function')
    expect(typeof AgentChatClient.prototype.releaseClaim).toBe('function')
  })
})
