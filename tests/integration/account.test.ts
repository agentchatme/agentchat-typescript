import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  actionOf,
  checkKey,
  DEFAULT_LABELS,
  flowOf,
  run,
  start,
  submitCode,
  type AccountAnswer,
  type AccountQuestion,
  type RunOptions,
} from '../../src/integration/account.js'
import { AgentChatClient } from '../../src/client.js'
import { createAgentChatError, RateLimitedError } from '../../src/errors.js'
import { integration } from '../../src/index.js'
import type { SignupFlow } from '../../src/types/index.js'

// ─── A scripted server ──────────────────────────────────────────────────────
//
// Each entry answers one request, in order; every request is recorded. The
// bodies follow the sign-up flow contract (contract v1, "Sign-up flows") or,
// for the legacy cases, what a server before it answered.

const API = 'https://api.agentchat.test'
const IDENTITY = { name: 'openclaw' as const, version: '9.9.9' }

interface Seen {
  method: string
  path: string
  body: Record<string, unknown> | null
  headers: Headers
}

function server(answers: Array<Response | (() => Response) | Error>) {
  const seen: Seen[] = []
  let i = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: new Headers(init?.headers),
    })
    const entry = answers[i++]
    if (entry === undefined) throw new Error(`server: unexpected request #${i} ${url.pathname}`)
    if (entry instanceof Error) throw entry
    return typeof entry === 'function' ? entry() : entry
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, seen, left: () => answers.length - i }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

type Kind = 'register' | 'recover'
const verifyStep = (kind: Kind) => (kind === 'register' ? 'verify' : 'recover_verify')

function pending(id = 'pnd_1', over: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    pending_id: id,
    expires_at: '2026-11-17T10:10:00.000Z',
    expires_in_s: 600,
    code_length: 6,
    attempts: 0,
    max_attempts: 5,
    resend_after_s: 60,
    ...over,
  }
}

const sent = (kind: Kind = 'register', id = 'pnd_1', message = 'We sent a 6-digit code to a@example.com. It expires in 10 minutes.') =>
  json(200, { pending_id: id, message, version: 1, flow: kind, next_step: verifyStep(kind), ...pending(id) })

const error = (
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
  headers: Record<string, string> = {},
) => json(status, { code, message, details: { version: 1, ...details } }, headers)

const wrongCode = (attempts = 1, kind: Kind = 'register') =>
  error(400, 'INVALID_CODE', "That code didn't work. Check the code and try again.", {
    flow: kind,
    next_step: verifyStep(kind),
    ...pending('pnd_1', { attempts }),
    param: 'code',
  })

const registered = (handle = 'alice') =>
  json(201, {
    agent: { handle, email: 'a@example.com' },
    api_key: 'key_test_1',
    message: `Email verified. Logged in as @${handle}.`,
    version: 1,
    flow: 'register',
    next_step: 'done',
    status: 'approved',
  })

const recovered = (handle = 'alice') =>
  json(200, {
    handle,
    api_key: 'key_test_2',
    message: `Email verified. Logged in as @${handle}. Your old API key no longer works.`,
    version: 1,
    flow: 'recover',
    next_step: 'done',
    status: 'approved',
  })

const cooldown = (seconds: number, kind: Kind = 'register') =>
  error(
    429,
    'OTP_COOLDOWN',
    `You can request a new code in ${seconds} seconds.`,
    { flow: kind, next_step: kind, retry_after_s: seconds },
    { 'Retry-After': String(seconds) },
  )

// ─── A scripted person ──────────────────────────────────────────────────────

function person(answers: AccountAnswer[]) {
  const asked: AccountQuestion[] = []
  const shown: string[] = []
  const slept: number[] = []
  let i = 0
  return {
    asked,
    shown,
    slept,
    ask: async (question: AccountQuestion) => {
      asked.push(question)
      const answer = answers[i++]
      if (answer === undefined) throw new Error(`person: unexpected question #${i} (${question.field})`)
      return answer
    },
    show: (message: string) => {
      shown.push(message)
    },
    sleep: async (ms: number) => {
      slept.push(ms)
    },
  }
}

const value = (v: string): AccountAnswer => ({ answer: 'value', value: v })
const NEW_CODE: AccountAnswer = { answer: 'new_code' }
const CANCEL: AccountAnswer = { answer: 'cancel' }

function runWith(
  srv: ReturnType<typeof server>,
  who: ReturnType<typeof person>,
  over: Partial<RunOptions> = {},
) {
  return run({
    kind: 'register',
    input: { email: 'a@example.com', handle: 'alice' },
    ask: who.ask,
    show: who.show,
    sleep: who.sleep,
    clientIdentity: IDENTITY,
    apiBase: API,
    fetch: srv.fetch,
    ...over,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

// ─── run(): scripted conversations ──────────────────────────────────────────

describe('integration.account.run — scripted conversations', () => {
  it('is reachable as integration.account', () => {
    expect(integration.account.run).toBe(run)
    expect(integration.account.DEFAULT_LABELS).toEqual({
      email: 'Email address',
      handle: 'Handle',
      code: 'Enter the 6-digit code',
    })
  })

  it('enter the code: done, with the key and the handle the server returned', async () => {
    const srv = server([sent(), registered('alice')])
    const who = person([value(' 123456 ')])
    const result = await runWith(srv, who, { input: { email: 'a@example.com', handle: 'alice', display_name: 'Alice' } })

    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_1', handle: 'alice' })
    expect(who.shown).toEqual([
      'We sent a 6-digit code to a@example.com. It expires in 10 minutes.',
      'Email verified. Logged in as @alice.',
    ])
    expect(who.asked.map((q) => [q.field, q.label, q.answers])).toEqual([
      ['code', 'Enter the 6-digit code', ['value', 'new_code', 'cancel']],
    ])
    expect(who.asked[0]!.flow).toMatchObject({ next_step: 'verify', pending_id: 'pnd_1', resend_after_s: 60 })
    expect(srv.seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /v1/register', 'POST /v1/register/verify'])
    expect(srv.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice', display_name: 'Alice' })
    expect(srv.seen[1]!.body).toEqual({ pending_id: 'pnd_1', code: '123456' })
    for (const s of srv.seen) {
      expect(s.headers.get('x-agentchat-client')).toBe('openclaw')
      expect(s.headers.get('x-agentchat-client-version')).toBe('9.9.9')
      expect(s.headers.get('authorization')).toBeNull()
    }
  })

  it('wrong code, then the right one: shows the server sentence and asks again, same pending id', async () => {
    const srv = server([sent(), wrongCode(1), registered()])
    const who = person([value('111111'), value('123456')])
    const result = await runWith(srv, who)

    expect(result).toMatchObject({ outcome: 'done', apiKey: 'key_test_1' })
    expect(who.shown[1]).toBe("That code didn't work. Check the code and try again.")
    expect(who.asked.map((q) => q.field)).toEqual(['code', 'code'])
    expect(who.asked[1]!.flow).toMatchObject({ attempts: 1, max_attempts: 5 })
    expect(srv.seen.slice(1).map((s) => s.body)).toEqual([
      { pending_id: 'pnd_1', code: '111111' },
      { pending_id: 'pnd_1', code: '123456' },
    ])
  })

  it('no attempt cap of its own: keeps asking while the server says the code is alive', async () => {
    const srv = server([sent(), wrongCode(1), wrongCode(2), wrongCode(3), wrongCode(4), registered()])
    const who = person([value('1'), value('2'), value('3'), value('4'), value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(srv.left()).toBe(0)
  })

  it('ask for a new code: only when the person asks, then the new pending id', async () => {
    const srv = server([sent('register', 'pnd_1'), sent('register', 'pnd_2'), registered()])
    const who = person([NEW_CODE, value('654321')])
    const result = await runWith(srv, who)

    expect(result).toMatchObject({ outcome: 'done' })
    expect(srv.seen.map((s) => s.path)).toEqual(['/v1/register', '/v1/register', '/v1/register/verify'])
    expect(srv.seen[1]!.body).toEqual(srv.seen[0]!.body)
    expect(srv.seen[2]!.body).toEqual({ pending_id: 'pnd_2', code: '654321' })
  })

  it('cancel at the code: cancelled, nothing more is called', async () => {
    const srv = server([sent()])
    const who = person([CANCEL])
    expect(await runWith(srv, who)).toEqual({ outcome: 'cancelled' })
    expect(srv.seen).toHaveLength(1)
  })

  it('a wait of 60 s or less: shows the server sentence, waits, repeats the call', async () => {
    const srv = server([cooldown(42), sent(), registered()])
    const who = person([value('123456')])
    const result = await runWith(srv, who)

    expect(result).toMatchObject({ outcome: 'done' })
    expect(who.shown[0]).toBe('You can request a new code in 42 seconds.')
    expect(who.slept).toEqual([42_000])
    expect(srv.seen.map((s) => s.path)).toEqual(['/v1/register', '/v1/register', '/v1/register/verify'])
  })

  it('a wait of exactly 60 s is waited out', async () => {
    const srv = server([cooldown(60), sent(), registered()])
    const who = person([value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.slept).toEqual([60_000])
  })

  it('a wait over 60 s: stops with the server sentence, no wait', async () => {
    const message = 'Too many codes have been sent. Enter the last code you received, or try again in 30 minutes.'
    const srv = server([
      error(429, 'OTP_HOURLY_CAP', message, { flow: 'register', next_step: 'register', retry_after_s: 1800 }, { 'Retry-After': '1800' }),
    ])
    const who = person([])
    const result = await runWith(srv, who)

    expect(result).toEqual({ outcome: 'stopped', code: 'OTP_HOURLY_CAP', message })
    expect(who.shown).toEqual([message])
    expect(who.slept).toEqual([])
  })

  it('a new code asked for inside the cooldown: the server says how long, run waits, then sends', async () => {
    const srv = server([sent('register', 'pnd_1'), cooldown(25), sent('register', 'pnd_2'), registered()])
    const who = person([NEW_CODE, value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.slept).toEqual([25_000])
    expect(srv.seen.map((s) => s.path)).toEqual(['/v1/register', '/v1/register', '/v1/register', '/v1/register/verify'])
    expect(srv.seen[3]!.body).toEqual({ pending_id: 'pnd_2', code: '123456' })
  })

  it('handle taken: re-asks the handle only, keeps the email', async () => {
    const srv = server([
      error(409, 'HANDLE_TAKEN', 'The handle @alice is taken. Try another.', {
        flow: 'register',
        next_step: 'register',
        param: 'handle',
      }),
      sent(),
      registered('alice-2'),
    ])
    const who = person([value('alice-2'), value('123456')])
    const result = await runWith(srv, who)

    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_1', handle: 'alice-2' })
    expect(who.shown[0]).toBe('The handle @alice is taken. Try another.')
    expect(who.asked.map((q) => [q.field, q.label])).toEqual([
      ['handle', 'Handle'],
      ['code', 'Enter the 6-digit code'],
    ])
    expect(who.asked[0]!.answers).toEqual(['value', 'cancel'])
    expect(srv.seen[1]!.body).toEqual({ email: 'a@example.com', handle: 'alice-2' })
  })

  it('email at its limit: re-asks the email only', async () => {
    const srv = server([
      error(
        409,
        'EMAIL_LIMIT_REACHED',
        'This email address already has 10 active agents, the most allowed. Use a different email address.',
        { limit: 10, flow: 'register', next_step: 'register', param: 'email' },
      ),
      sent(),
      registered(),
    ])
    const who = person([value('b@example.com'), value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.asked.map((q) => q.field)).toEqual(['email', 'code'])
    expect(srv.seen[1]!.body).toEqual({ email: 'b@example.com', handle: 'alice' })
  })

  it('cancel while re-asking a field: cancelled', async () => {
    const srv = server([
      error(409, 'HANDLE_TAKEN', 'The handle @alice is taken. Try another.', {
        flow: 'register',
        next_step: 'register',
        param: 'handle',
      }),
    ])
    const who = person([CANCEL])
    expect(await runWith(srv, who)).toEqual({ outcome: 'cancelled' })
  })

  it('expired: asks before sending a new code; a yes sends one', async () => {
    const srv = server([
      sent(),
      error(400, 'EXPIRED', 'That code has expired. Request a new code.', {
        flow: 'register',
        next_step: 'register',
        status: 'expired',
      }),
      sent('register', 'pnd_2'),
      registered(),
    ])
    const who = person([value('123456'), NEW_CODE, value('222222')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.asked.map((q) => [q.field, q.label, q.answers])).toEqual([
      ['code', 'Enter the 6-digit code', ['value', 'new_code', 'cancel']],
      ['new_code', null, ['new_code', 'cancel']],
      ['code', 'Enter the 6-digit code', ['value', 'new_code', 'cancel']],
    ])
    expect(who.shown[1]).toBe('That code has expired. Request a new code.')
  })

  it('expired, and the person declines a new code: cancelled, no code sent', async () => {
    const srv = server([
      sent(),
      error(400, 'EXPIRED', 'That code has expired. Request a new code.', {
        flow: 'register',
        next_step: 'register',
        status: 'expired',
      }),
    ])
    const who = person([value('123456'), CANCEL])
    expect(await runWith(srv, who)).toEqual({ outcome: 'cancelled' })
    expect(srv.seen).toHaveLength(2)
  })

  it('the last wrong code (429 with a short retry_after_s): asks before a new code, never waits and resends', async () => {
    const srv = server([
      sent(),
      error(
        429,
        'OTP_ATTEMPTS_EXHAUSTED',
        'You entered the wrong code too many times. Request a new code.',
        {
          flow: 'register',
          next_step: 'register',
          status: 'max_attempts_reached',
          attempts: 5,
          max_attempts: 5,
          retry_after_s: 0,
        },
        { 'Retry-After': '0' },
      ),
    ])
    const who = person([value('999999'), CANCEL])
    expect(await runWith(srv, who)).toEqual({ outcome: 'cancelled' })
    expect(who.asked.map((q) => q.field)).toEqual(['code', 'new_code'])
    expect(who.slept).toEqual([])
    expect(srv.seen).toHaveLength(2)
  })

  it('the last wrong code inside the resend minute: on a yes, waits retry_after_s, then sends', async () => {
    const srv = server([
      sent(),
      error(
        429,
        'OTP_ATTEMPTS_EXHAUSTED',
        'You entered the wrong code too many times. Request a new code.',
        {
          flow: 'register',
          next_step: 'register',
          status: 'max_attempts_reached',
          attempts: 5,
          max_attempts: 5,
          retry_after_s: 30,
        },
        { 'Retry-After': '30' },
      ),
      sent('register', 'pnd_2'),
      registered(),
    ])
    const who = person([value('999999'), NEW_CODE, value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.asked.map((q) => q.field)).toEqual(['code', 'new_code', 'code'])
    expect(who.slept).toEqual([30_000])
    expect(srv.seen.map((s) => s.path)).toEqual([
      '/v1/register',
      '/v1/register/verify',
      '/v1/register',
      '/v1/register/verify',
    ])
  })

  it('a per-IP 429 on a code (≤ 60 s): waits and submits the same code again', async () => {
    const srv = server([
      sent(),
      error(
        429,
        'RATE_LIMITED',
        'Too many attempts. Try again in 30 seconds.',
        { flow: 'register', next_step: 'verify', retry_after_s: 30 },
        { 'Retry-After': '30' },
      ),
      registered(),
    ])
    const who = person([value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.slept).toEqual([30_000])
    expect(srv.seen.slice(1).map((s) => s.body)).toEqual([
      { pending_id: 'pnd_1', code: '123456' },
      { pending_id: 'pnd_1', code: '123456' },
    ])
  })

  it('a malformed code: the server re-asks it (no pending id in the answer), same pending id', async () => {
    const srv = server([
      sent(),
      error(400, 'VALIDATION_ERROR', 'Enter the code using only 6 digits.', {
        formErrors: [],
        fieldErrors: { code: ['Invalid'] },
        flow: 'register',
        next_step: 'verify',
        param: 'code',
        code_length: 6,
      }),
      registered(),
    ])
    const who = person([value('12a456'), value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.shown[1]).toBe('Enter the code using only 6 digits.')
    expect(srv.seen[2]!.body).toEqual({ pending_id: 'pnd_1', code: '123456' })
  })

  it('the per-email lock on a code (long wait): stops', async () => {
    const message = 'You entered the wrong code too many times. Wait 2 hours, then request a new code.'
    const srv = server([
      sent(),
      json(
        429,
        {
          code: 'OTP_EMAIL_LOCKED',
          message,
          retry_after_s: 7200,
          details: { version: 1, flow: 'register', next_step: 'verify', ...pending(), retry_after_s: 7200 },
        },
        { 'Retry-After': '7200' },
      ),
    ])
    const who = person([value('123456')])
    expect(await runWith(srv, who)).toEqual({ outcome: 'stopped', code: 'OTP_EMAIL_LOCKED', message })
    expect(who.slept).toEqual([])
  })

  it('the code email could not be sent (5xx): stops', async () => {
    const message = "We couldn't send the code. Try again in a few minutes."
    const srv = server([error(500, 'OTP_FAILED', message, { flow: 'register', next_step: 'register' })])
    const who = person([])
    expect(await runWith(srv, who)).toEqual({ outcome: 'stopped', code: 'OTP_FAILED', message })
  })

  it('an unknown next_step: stops with the message', async () => {
    const srv = server([
      json(200, { pending_id: 'pnd_1', message: 'Open the link we sent.', version: 1, flow: 'register', next_step: 'open_link' }),
    ])
    const who = person([])
    expect(await runWith(srv, who)).toEqual({ outcome: 'stopped', code: null, message: 'Open the link we sent.' })
  })

  it('asks for the inputs it was not given, with the default labels (or the integration’s)', async () => {
    const srv = server([sent(), registered()])
    const who = person([value('a@example.com'), value('alice'), value('123456')])
    const result = await runWith(srv, who, { input: {}, labels: { handle: 'Your handle' } })
    expect(result).toMatchObject({ outcome: 'done' })
    expect(who.asked.map((q) => [q.field, q.label, q.flow])).toEqual([
      ['email', 'Email address', null],
      ['handle', 'Your handle', null],
      ['code', 'Enter the 6-digit code', expect.any(Object)],
    ])
  })

  it('recover: sends the handle, and gets the new key', async () => {
    const srv = server([
      sent('recover', 'pnd_1', 'If @alice is registered with a@example.com, we sent a 6-digit code there. It expires in 10 minutes.'),
      recovered('alice'),
    ])
    const who = person([value('123456')])
    const result = await runWith(srv, who, { kind: 'recover', input: { email: 'a@example.com', handle: 'alice' } })
    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_2', handle: 'alice' })
    expect(srv.seen.map((s) => [s.path, s.body])).toEqual([
      ['/v1/agents/recover', { email: 'a@example.com', handle: 'alice' }],
      ['/v1/agents/recover/verify', { pending_id: 'pnd_1', code: '123456' }],
    ])
    expect(who.shown[1]).toBe('Email verified. Logged in as @alice. Your old API key no longer works.')
  })

  it('recover without a handle on an email with several agents: offers the handles, starts again with one', async () => {
    const srv = server([
      sent('recover', 'pnd_1', 'If an agent is registered with a@example.com, we sent a 6-digit code there. It expires in 10 minutes.'),
      error(409, 'HANDLE_REQUIRED', 'More than one agent uses this email address. Choose the handle to recover.', {
        handles: ['alice', 'alice-2'],
        flow: 'recover',
        next_step: 'recover',
        param: 'handle',
      }),
      sent('recover', 'pnd_2'),
      recovered('alice-2'),
    ])
    const who = person([value('123456'), value('alice-2'), value('654321')])
    const result = await runWith(srv, who, { kind: 'recover', input: { email: 'a@example.com' } })
    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_2', handle: 'alice-2' })
    expect(srv.seen[0]!.body).toEqual({ email: 'a@example.com' })
    expect(who.asked[1]).toMatchObject({ field: 'handle', handles: ['alice', 'alice-2'] })
    expect(srv.seen[2]!.body).toEqual({ email: 'a@example.com', handle: 'alice-2' })
  })

  it('recover asks for the email only (the handle is optional)', async () => {
    const srv = server([sent('recover'), recovered()])
    const who = person([value('a@example.com'), value('123456')])
    await runWith(srv, who, { kind: 'recover', input: {} })
    expect(who.asked.map((q) => q.field)).toEqual(['email', 'code'])
  })

  it('a network error rejects (nothing is known)', async () => {
    const srv = server([new TypeError('fetch failed')])
    const who = person([])
    await expect(runWith(srv, who)).rejects.toThrow('fetch failed')
  })

  it('an answer the question does not allow is a programmer error', async () => {
    const srv = server([sent()])
    const who = person([{ answer: 'value', value: 'x' }])
    await expect(
      runWith(srv, who, {
        ask: async () => ({ answer: 'bogus' }) as unknown as AccountAnswer,
      }),
    ).rejects.toThrow(TypeError)
  })

  it('the default sleep is a timer (fake time)', async () => {
    vi.useFakeTimers()
    const srv = server([cooldown(42), sent(), registered()])
    const who = person([value('123456')])
    const done = run({
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alice' },
      ask: who.ask,
      show: who.show,
      clientIdentity: IDENTITY,
      apiBase: API,
      fetch: srv.fetch,
    })
    await vi.advanceTimersByTimeAsync(41_999)
    expect(srv.seen).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toMatchObject({ outcome: 'done' })
    expect(srv.seen).toHaveLength(3)
  })

  it('the default sleep stops on abort', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const srv = server([cooldown(42)])
    const who = person([])
    const done = run({
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alice' },
      ask: who.ask,
      show: who.show,
      clientIdentity: IDENTITY,
      apiBase: API,
      fetch: srv.fetch,
      signal: controller.signal,
    })
    const outcome = expect(done).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    await outcome
  })
})

// ─── run(): a server before the flow contract ───────────────────────────────

describe('integration.account.run — legacy server (no next_step)', () => {
  const legacySent = () => json(200, { pending_id: 'pnd_1', message: 'Verification code sent to email' })
  const legacyRegistered = () => json(201, { agent: { handle: 'alice', email: 'a@example.com' }, api_key: 'key_test_1' })

  it('code sent → wrong code → right code: today’s texts, same flow', async () => {
    const srv = server([
      legacySent(),
      json(400, { code: 'INVALID_CODE', message: 'Invalid or expired verification code' }),
      legacyRegistered(),
    ])
    const who = person([value('111111'), value('123456')])
    expect(await runWith(srv, who)).toEqual({ outcome: 'done', apiKey: 'key_test_1', handle: 'alice' })
    expect(who.shown).toEqual(['Verification code sent to email', 'Invalid or expired verification code'])
    expect(srv.seen.slice(1).map((s) => s.body)).toEqual([
      { pending_id: 'pnd_1', code: '111111' },
      { pending_id: 'pnd_1', code: '123456' },
    ])
  })

  it('HANDLE_TAKEN → re-asks the handle only', async () => {
    const srv = server([
      json(409, { code: 'HANDLE_TAKEN', message: 'Handle @alice is already taken' }),
      legacySent(),
      legacyRegistered(),
    ])
    const who = person([value('alice-2'), value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.asked.map((q) => q.field)).toEqual(['handle', 'code'])
  })

  it('EXPIRED → asks before a new code', async () => {
    const srv = server([
      legacySent(),
      json(400, { code: 'EXPIRED', message: 'Registration expired or invalid. Please start again.' }),
    ])
    const who = person([value('123456'), CANCEL])
    expect(await runWith(srv, who)).toEqual({ outcome: 'cancelled' })
    expect(who.asked.map((q) => q.field)).toEqual(['code', 'new_code'])
  })

  it('OTP_ATTEMPTS_EXHAUSTED → asks before a new code', async () => {
    const srv = server([
      legacySent(),
      json(429, { code: 'OTP_ATTEMPTS_EXHAUSTED', message: 'Too many incorrect codes (max 5). Please request a new one.' }),
    ])
    const who = person([value('123456'), CANCEL])
    expect(await runWith(srv, who)).toEqual({ outcome: 'cancelled' })
    expect(who.asked.map((q) => q.field)).toEqual(['code', 'new_code'])
  })

  it('OTP_COOLDOWN with Retry-After → waits, then sends', async () => {
    const srv = server([
      json(429, { code: 'OTP_COOLDOWN', message: 'Please wait 20s before requesting another code.' }, { 'Retry-After': '20' }),
      legacySent(),
      legacyRegistered(),
    ])
    const who = person([value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.slept).toEqual([20_000])
  })

  it('OTP_EMAIL_LOCKED (top-level retry_after_s, long) → stops', async () => {
    const srv = server([
      legacySent(),
      json(
        429,
        { code: 'OTP_EMAIL_LOCKED', message: 'Too many wrong codes for this email. Try again in 3 hours.', retry_after_s: 10800 },
        { 'Retry-After': '10800' },
      ),
    ])
    const who = person([value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'stopped', code: 'OTP_EMAIL_LOCKED' })
  })

  it('a 429 with no wait named → stops', async () => {
    const srv = server([json(429, { code: 'RATE_LIMITED', message: 'Too many requests' })])
    expect(await runWith(srv, person([]))).toMatchObject({ outcome: 'stopped', code: 'RATE_LIMITED' })
  })

  it('EMAIL_EXHAUSTED → re-asks the email', async () => {
    const srv = server([
      json(409, { code: 'EMAIL_EXHAUSTED', message: 'Lifetime limit.', details: { limit: 30 } }),
      legacySent(),
      legacyRegistered(),
    ])
    const who = person([value('b@example.com'), value('123456')])
    expect(await runWith(srv, who)).toMatchObject({ outcome: 'done' })
    expect(who.asked.map((q) => q.field)).toEqual(['email', 'code'])
  })

  it('HANDLE_REQUIRED on recover → offers the handles', async () => {
    const srv = server([
      json(200, { pending_id: 'pnd_1', message: 'If an agent is registered with that email, a code was sent.' }),
      json(409, { code: 'HANDLE_REQUIRED', message: 'Several agents.', details: { handles: ['alice', 'bob'] } }),
      json(200, { pending_id: 'pnd_2', message: 'If an agent is registered with that email, a code was sent.' }),
      json(200, { handle: 'bob', api_key: 'key_test_2' }),
    ])
    const who = person([value('123456'), value('bob'), value('654321')])
    const result = await runWith(srv, who, { kind: 'recover', input: { email: 'a@example.com' } })
    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_2', handle: 'bob' })
    expect(who.asked[1]).toMatchObject({ field: 'handle', handles: ['alice', 'bob'] })
  })

  it('a 5xx with no JSON body → stops', async () => {
    const srv = server([new Response('bad gateway', { status: 502 })])
    expect(await runWith(srv, person([]))).toMatchObject({ outcome: 'stopped', code: 'INTERNAL_ERROR' })
  })
})

// ─── The steps alone (one per process run) ──────────────────────────────────

describe('integration.account.start / submitCode — one step per process', () => {
  const options = (srv: ReturnType<typeof server>) => ({ clientIdentity: IDENTITY, apiBase: API, fetch: srv.fetch })

  it('start returns a plain-JSON flow; a later process submits the code from the saved copy', async () => {
    const first = server([sent()])
    const started = await start('register', { email: 'a@example.com', handle: 'alice' }, options(first))
    expect(started).toMatchObject({
      action: 'ask_code',
      httpStatus: 200,
      legacy: false,
      message: 'We sent a 6-digit code to a@example.com. It expires in 10 minutes.',
    })
    expect(started.code).toBeUndefined()
    const saved = JSON.parse(JSON.stringify(started.flow)) as SignupFlow
    expect(saved).toEqual(started.flow)

    const second = server([registered('alice')])
    const verified = await submitCode(saved, '123456', options(second))
    expect(verified).toMatchObject({ action: 'done', apiKey: 'key_test_1', handle: 'alice', httpStatus: 201 })
    expect(second.seen[0]!.body).toEqual({ pending_id: 'pnd_1', code: '123456' })
  })

  it('API outcomes resolve with the code, never throw', async () => {
    const srv = server([
      error(409, 'HANDLE_TAKEN', 'The handle @alice is taken. Try another.', {
        flow: 'register',
        next_step: 'register',
        param: 'handle',
      }),
    ])
    const result = await start('register', { email: 'a@example.com', handle: 'alice' }, options(srv))
    expect(result).toMatchObject({ action: 'ask_param', code: 'HANDLE_TAKEN', httpStatus: 409, legacy: false })
    expect(result.flow.param).toBe('handle')
    expect(result.apiKey).toBeUndefined()
  })

  it('a legacy answer is read into the same flow shape, marked legacy', async () => {
    const srv = server([json(200, { pending_id: 'pnd_9', message: 'Verification code sent to email' })])
    const result = await start('register', { email: 'a@example.com', handle: 'alice' }, options(srv))
    expect(result).toMatchObject({ action: 'ask_code', legacy: true })
    expect(result.flow).toEqual({
      version: 1,
      flow: 'register',
      next_step: 'verify',
      status: 'pending',
      pending_id: 'pnd_9',
      code_length: 6,
    })
  })

  it('submitCode refuses a flow that is not waiting for a code', async () => {
    const srv = server([])
    const flow: SignupFlow = { version: 1, flow: 'register', next_step: 'register' }
    await expect(submitCode(flow, '123456', options(srv))).rejects.toThrow(TypeError)
    await expect(
      submitCode({ version: 1, flow: 'register', next_step: 'verify' }, '123456', options(srv)),
    ).rejects.toThrow(/pending_id/)
    await expect(
      submitCode({ version: 1, flow: 'rotate_key', next_step: 'rotate_key_verify', pending_id: 'p' }, '1', options(srv)),
    ).rejects.toThrow(/rotateKeyVerify/)
    expect(srv.seen).toHaveLength(0)
  })

  it('done without a key in the body is not done', async () => {
    const srv = server([json(201, { message: 'ok', version: 1, flow: 'register', next_step: 'done', status: 'approved' })])
    const result = await submitCode({ version: 1, flow: 'register', next_step: 'verify', pending_id: 'pnd_1' }, '1', options(srv))
    expect(result.action).toBe('stop')
    expect(result.apiKey).toBeUndefined()
  })

  it('a network error rejects', async () => {
    const srv = server([new TypeError('fetch failed')])
    await expect(start('recover', { email: 'a@example.com' }, options(srv))).rejects.toThrow('fetch failed')
  })

  it('never retries (one request per step)', async () => {
    const srv = server([error(503, 'INTERNAL_ERROR', 'Internal error', { flow: 'register', next_step: 'register' })])
    const result = await start('register', { email: 'a@example.com', handle: 'alice' }, options(srv))
    expect(result.action).toBe('stop')
    expect(srv.seen).toHaveLength(1)
  })
})

// ─── checkKey ───────────────────────────────────────────────────────────────

describe('integration.account.checkKey', () => {
  const options = (srv: ReturnType<typeof server>) => ({ clientIdentity: IDENTITY, apiBase: API, fetch: srv.fetch })

  it('ok with the handle the key belongs to', async () => {
    const srv = server([json(200, { id: 'agt_1', handle: 'alice', email: 'a@example.com' })])
    expect(await checkKey('key_test_1', options(srv))).toEqual({ ok: true, handle: 'alice' })
    expect(srv.seen[0]).toMatchObject({ method: 'GET', path: '/v1/agents/me' })
    expect(srv.seen[0]!.headers.get('authorization')).toBe('Bearer key_test_1')
  })

  it('rejected: the server’s code and message, one attempt', async () => {
    const srv = server([json(401, { code: 'UNAUTHORIZED', message: 'Invalid API key' })])
    expect(await checkKey('key_test_1', options(srv))).toEqual({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid API key' })
    expect(srv.seen).toHaveLength(1)
  })

  it('a 5xx is not retried', async () => {
    const srv = server([json(503, { code: 'INTERNAL_ERROR', message: 'down' })])
    expect(await checkKey('key_test_1', options(srv))).toEqual({ ok: false, code: 'INTERNAL_ERROR', message: 'down' })
    expect(srv.seen).toHaveLength(1)
  })

  it('a network error rejects', async () => {
    const srv = server([new TypeError('fetch failed')])
    await expect(checkKey('key_test_1', options(srv))).rejects.toThrow('fetch failed')
  })

  it('a 2xx without a handle rejects (nothing usable is known)', async () => {
    const srv = server([json(200, { id: 'agt_1' })])
    await expect(checkKey('key_test_1', options(srv))).rejects.toThrow(/without a handle/)
  })
})

// ─── flowOf / actionOf (beyond the fixture) ─────────────────────────────────

describe('integration.account.flowOf / actionOf', () => {
  it('reads an SDK error’s details', () => {
    const err = createAgentChatError(
      {
        code: 'OTP_COOLDOWN',
        message: 'You can request a new code in 30 seconds.',
        details: { version: 1, flow: 'register', next_step: 'register', retry_after_s: 30 },
      },
      429,
    )
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(flowOf(err)).toEqual({ version: 1, flow: 'register', next_step: 'register', retry_after_s: 30 })
    expect(actionOf(flowOf(err), 429)).toBe('wait_then_retry')
  })

  it('null without a next_step (legacy); unknown fields are dropped', () => {
    expect(flowOf({ pending_id: 'p', message: 'm' })).toBeNull()
    expect(flowOf({ code: 'X', message: 'm' })).toBeNull()
    expect(flowOf(null)).toBeNull()
    expect(flowOf('text')).toBeNull()
    expect(flowOf({ version: 1, flow: 'register', next_step: 'verify', pending_id: 'p', shiny: true })).toEqual({
      version: 1,
      flow: 'register',
      next_step: 'verify',
      pending_id: 'p',
    })
    expect(actionOf(null, 200)).toBe('legacy')
  })

  it('a 5xx stops even on a verify step', () => {
    expect(actionOf({ version: 1, flow: 'register', next_step: 'verify', pending_id: 'p' }, 500)).toBe('stop')
  })
})

// ─── The static methods carry the flow fields ───────────────────────────────

describe('AgentChatClient static sign-up calls — flow fields (additive)', () => {
  it('register, verify, recover and recoverVerify return the flow fields beside the old ones', async () => {
    const srv = server([sent(), registered(), sent('recover'), recovered()])
    const options = { baseUrl: API, fetch: srv.fetch }
    const reg = await AgentChatClient.register({ email: 'a@example.com', handle: 'alice', ...options })
    expect(reg).toMatchObject({ pending_id: 'pnd_1', next_step: 'verify', status: 'pending', expires_in_s: 600 })

    const ver = await AgentChatClient.verify('pnd_1', '123456', options)
    expect(ver).toMatchObject({
      apiKey: 'key_test_1',
      next_step: 'done',
      status: 'approved',
      message: 'Email verified. Logged in as @alice.',
    })
    expect(ver.client).toBeInstanceOf(AgentChatClient)

    const rec = await AgentChatClient.recover('a@example.com', { handle: 'alice', ...options })
    expect(rec).toMatchObject({ next_step: 'recover_verify', resend_after_s: 60 })

    const recVer = await AgentChatClient.recoverVerify('pnd_1', '123456', options)
    expect(recVer).toMatchObject({ handle: 'alice', apiKey: 'key_test_2', next_step: 'done', flow: 'recover' })
  })

  it('an old server’s verify answer has no flow fields', async () => {
    const srv = server([json(201, { agent: { handle: 'alice' }, api_key: 'key_test_1' })])
    const ver = await AgentChatClient.verify('pnd_1', '123456', { baseUrl: API, fetch: srv.fetch })
    expect(Object.keys(ver).sort()).toEqual(['agent', 'apiKey', 'client'])
  })

  it('a sign-up error keeps details and retry_after_s', async () => {
    const srv = server([
      json(
        429,
        {
          code: 'OTP_EMAIL_LOCKED',
          message: 'locked',
          retry_after_s: 7200,
          details: { version: 1, flow: 'register', next_step: 'verify', retry_after_s: 7200 },
        },
      ),
    ])
    const err = await AgentChatClient.verify('pnd_1', '123456', { baseUrl: API, fetch: srv.fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    const rl = err as RateLimitedError
    expect(rl.retryAfterS).toBe(7200)
    expect(rl.retryAfterMs).toBe(7_200_000)
    expect(rl.details).toMatchObject({ next_step: 'verify', retry_after_s: 7200 })
    expect(flowOf(rl)).toMatchObject({ next_step: 'verify', retry_after_s: 7200 })
  })
})

describe('DEFAULT_LABELS', () => {
  it('are the only words the helper brings', () => {
    expect(DEFAULT_LABELS).toEqual({ email: 'Email address', handle: 'Handle', code: 'Enter the 6-digit code' })
    expect(Object.isFrozen(DEFAULT_LABELS)).toBe(true)
  })
})
