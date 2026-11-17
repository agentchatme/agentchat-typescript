import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_AUTO_WAITS, MIN_WAIT_MS, run, type AccountAnswer, type AccountQuestion } from '../../src/integration/account.js'

// ─── run(): when it waits, and when it asks instead ─────────────────────────
//
// A fake wall clock (Date only) that run's sleep advances. The recover server
// below behaves like the server before the honest-cooldown fix: a recover
// inside the email's resend minute is answered like any other (the decoy
// 200, a fresh pending id) and sends no email. run must never get there.

const API = 'https://api.agentchat.test'
const IDENTITY = { name: 'openclaw' as const, version: '9.9.9' }
const T0 = new Date('2026-11-17T10:00:00.000Z').getTime()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

interface Seen {
  path: string
  body: Record<string, unknown> | null
  at: number
}

function server(handler: (path: string, body: Record<string, unknown> | null) => Response) {
  const seen: Seen[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    seen.push({ path, body, at: Date.now() - T0 })
    return handler(path, body)
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, seen }
}

const sleeps: number[] = []
const sleep = async (ms: number) => {
  sleeps.push(ms)
  vi.setSystemTime(Date.now() + ms)
}
beforeEach(() => {
  sleeps.length = 0
})

function pendingFields(id: string, issuedAt: number) {
  const now = Date.now()
  return {
    status: 'pending',
    pending_id: id,
    expires_at: new Date(issuedAt + 600_000).toISOString(),
    expires_in_s: Math.max(0, Math.floor((issuedAt + 600_000 - now) / 1000)),
    code_length: 6,
    attempts: 0,
    max_attempts: 5,
    resend_after_s: Math.max(0, Math.ceil((issuedAt + 60_000 - now) / 1000)),
  }
}

/** Recover as the decoy design answers it: inside the resend minute, a 200 and no email. */
function recoverServer(opts: { ambiguous?: boolean } = {}) {
  let lastRealSend = -Infinity
  let n = 0
  const records = new Map<string, { kind: 'real' | 'decoy' | 'ambiguous'; code: string | null; issuedAt: number }>()
  const realCodes: string[] = []
  const srv = server((path, body) => {
    const now = Date.now()
    if (path === '/v1/agents/recover') {
      const id = `pnd_${++n}`
      if (now - lastRealSend < 60_000) {
        records.set(id, { kind: 'decoy', code: null, issuedAt: now })
      } else {
        lastRealSend = now
        const code = String(100000 + n)
        realCodes.push(code)
        records.set(id, { kind: opts.ambiguous && !body?.handle ? 'ambiguous' : 'real', code, issuedAt: now })
      }
      return json(200, {
        pending_id: id,
        message: 'If an agent is registered with a@example.com, we sent a 6-digit code there. It expires in 10 minutes.',
        version: 1,
        flow: 'recover',
        next_step: 'recover_verify',
        ...pendingFields(id, now),
      })
    }
    if (path === '/v1/agents/recover/verify') {
      const id = String(body?.pending_id)
      const rec = records.get(id)
      if (rec && rec.code !== null && rec.code === body?.code) {
        records.delete(id)
        if (rec.kind === 'ambiguous') {
          return json(409, {
            code: 'HANDLE_REQUIRED',
            message: 'More than one agent uses this email address. Choose the handle to recover.',
            details: { handles: ['alpha', 'beta'], version: 1, flow: 'recover', next_step: 'recover', param: 'handle' },
          })
        }
        return json(200, {
          handle: 'alpha',
          api_key: 'key_test_new',
          message: 'Email verified. Logged in as @alpha. Your old API key no longer works.',
          version: 1,
          flow: 'recover',
          next_step: 'done',
          status: 'approved',
        })
      }
      return json(400, {
        code: 'INVALID_CODE',
        message: "That code didn't work. Check the code and try again.",
        details: {
          version: 1,
          flow: 'recover',
          next_step: 'recover_verify',
          param: 'code',
          ...pendingFields(id, rec?.issuedAt ?? now),
        },
      })
    }
    throw new Error(`unexpected ${path}`)
  })
  return { ...srv, realCodes }
}

const codeSent = (id: string) =>
  json(200, {
    pending_id: id,
    message: 'We sent a 6-digit code to a@example.com. It expires in 10 minutes.',
    version: 1,
    flow: 'register',
    next_step: 'verify',
    ...pendingFields(id, Date.now()),
  })

const registered = () =>
  json(201, {
    agent: { handle: 'alpha' },
    api_key: 'key_test_1',
    message: 'Email verified. Logged in as @alpha.',
    version: 1,
    flow: 'register',
    next_step: 'done',
    status: 'approved',
  })

function scripted(answers: Response[]) {
  let i = 0
  return server(() => {
    const next = answers[i++]
    if (next === undefined) throw new Error(`unexpected request #${i}`)
    return next
  })
}

const base = { clientIdentity: IDENTITY, apiBase: API, show: () => {}, sleep }

describe('run waits before any start that follows a send (recover decoy)', () => {
  it('a new code asked for at once waits out the resend minute, so the second recover really sends', async () => {
    const srv = recoverServer()
    const result = await run({
      ...base,
      kind: 'recover',
      input: { email: 'a@example.com', handle: 'alpha' },
      fetch: srv.fetch,
      ask: async (q: AccountQuestion): Promise<AccountAnswer> => {
        const codeQuestions = srv.seen.filter((s) => s.path === '/v1/agents/recover').length
        // First code question: "send another"; then the newest real code.
        if (q.field === 'code' && codeQuestions === 1) return { answer: 'new_code' }
        if (q.field === 'code') return { answer: 'value', value: srv.realCodes.at(-1)! }
        return { answer: 'cancel' }
      },
    })
    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_new', handle: 'alpha' })
    expect(sleeps).toEqual([60_000])
    expect(srv.realCodes).toHaveLength(2)
    expect(srv.seen.map((s) => [s.path, s.at])).toEqual([
      ['/v1/agents/recover', 0],
      ['/v1/agents/recover', 60_000],
      ['/v1/agents/recover/verify', 60_000],
    ])
    expect(srv.seen[2]!.body).toEqual({ pending_id: 'pnd_2', code: srv.realCodes[1] })
  })

  it('email-only recover → HANDLE_REQUIRED → the chosen handle: waits out the minute, then recovers', async () => {
    const srv = recoverServer({ ambiguous: true })
    let codeQuestions = 0
    const result = await run({
      ...base,
      kind: 'recover',
      input: { email: 'a@example.com' },
      fetch: srv.fetch,
      ask: async (q: AccountQuestion): Promise<AccountAnswer> => {
        if (q.field === 'handle') return { answer: 'value', value: 'alpha' }
        if (q.field === 'code') {
          codeQuestions++
          return { answer: 'value', value: srv.realCodes[codeQuestions - 1]! }
        }
        return { answer: 'cancel' }
      },
    })
    expect(result).toEqual({ outcome: 'done', apiKey: 'key_test_new', handle: 'alpha' })
    expect(srv.realCodes).toHaveLength(2) // the second recover was a real send, not a decoy
    expect(sleeps).toEqual([60_000])
    expect(srv.seen.map((s) => s.path)).toEqual([
      '/v1/agents/recover',
      '/v1/agents/recover/verify',
      '/v1/agents/recover',
      '/v1/agents/recover/verify',
    ])
    expect(srv.seen[2]).toMatchObject({ body: { email: 'a@example.com', handle: 'alpha' }, at: 60_000 })
  })

  it('a re-asked handle after a send waits too; a changed email does not', async () => {
    const taken = json(409, {
      code: 'HANDLE_TAKEN',
      message: 'The handle @alpha is taken. Try another.',
      details: { version: 1, flow: 'register', next_step: 'register', param: 'handle' },
    })
    const limit = json(409, {
      code: 'EMAIL_LIMIT_REACHED',
      message: 'This email address already has 10 active agents, the most allowed. Use a different email address.',
      details: { limit: 10, version: 1, flow: 'register', next_step: 'register', param: 'email' },
    })
    // The handle lost a race at verify: same email, the minute still runs.
    const sameEmail = scripted([codeSent('pnd_1'), taken, codeSent('pnd_2'), registered()])
    const answers: AccountAnswer[] = [
      { answer: 'value', value: '123456' },
      { answer: 'value', value: 'alpha-2' },
      { answer: 'value', value: '654321' },
    ]
    await run({ ...base, kind: 'register', input: { email: 'a@example.com', handle: 'alpha' }, fetch: sameEmail.fetch, ask: async () => answers.shift()! })
    expect(sleeps).toEqual([60_000])

    sleeps.length = 0
    const otherEmail = scripted([codeSent('pnd_1'), limit, codeSent('pnd_2'), registered()])
    const answers2: AccountAnswer[] = [
      { answer: 'value', value: '123456' },
      { answer: 'value', value: 'b@example.com' },
      { answer: 'value', value: '654321' },
    ]
    await run({ ...base, kind: 'register', input: { email: 'a@example.com', handle: 'alpha' }, fetch: otherEmail.fetch, ask: async () => answers2.shift()! })
    expect(sleeps).toEqual([])
    expect(otherEmail.seen[2]!.body).toEqual({ email: 'b@example.com', handle: 'alpha' })
  })
})

describe('run goes back to the held code on any 429 it does not wait out', () => {
  it('a new code answered RATE_LIMITED (25 min): asks for the held code, which still works', async () => {
    const srv = scripted([
      codeSent('pnd_1'),
      json(
        429,
        {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Try again in 25 minutes.',
          details: { retry_after_s: 1500, version: 1, flow: 'register', next_step: 'register' },
        },
        { 'Retry-After': '1500' },
      ),
      registered(),
    ])
    const asked: string[] = []
    const result = await run({
      ...base,
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alpha' },
      fetch: srv.fetch,
      ask: async (q) => {
        asked.push(q.field)
        return asked.length === 1 ? { answer: 'new_code' } : { answer: 'value', value: '123456' }
      },
    })
    expect(result).toMatchObject({ outcome: 'done' })
    expect(asked).toEqual(['code', 'code'])
    expect(srv.seen[2]!.body).toEqual({ pending_id: 'pnd_1', code: '123456' })
  })

  it('the held code’s expiry counts from its answer (expires_in_s), not from a skewed expires_at', async () => {
    // The server's clock is an hour behind: its expires_at is already past here.
    const skewed = json(200, {
      pending_id: 'pnd_1',
      message: 'We sent a 6-digit code to a@example.com. It expires in 10 minutes.',
      version: 1,
      flow: 'register',
      next_step: 'verify',
      ...pendingFields('pnd_1', Date.now()),
      expires_at: new Date(T0 - 3_600_000 + 600_000).toISOString(),
      resend_after_s: 0,
    })
    const cap = json(
      429,
      {
        code: 'OTP_HOURLY_CAP',
        message: 'Too many codes have been sent. Enter the last code you received, or try again in 30 minutes.',
        details: { retry_after_s: 1800, version: 1, flow: 'register', next_step: 'register' },
      },
      { 'Retry-After': '1800' },
    )
    const srv = scripted([skewed, cap, registered()])
    const asked: string[] = []
    const result = await run({
      ...base,
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alpha' },
      fetch: srv.fetch,
      ask: async (q) => {
        asked.push(q.field)
        return asked.length === 1 ? { answer: 'new_code' } : { answer: 'value', value: '123456' }
      },
    })
    expect(result).toMatchObject({ outcome: 'done' })
    expect(asked).toEqual(['code', 'code'])
  })
})

describe('automatic waits: at least 1 s, at most 3 in a row', () => {
  it('a body-less 429 with Retry-After: 0 is waited 1 s, three times, then the person is asked', async () => {
    let calls = 0
    const srv = server(() => {
      calls++
      return new Response('', { status: 429, headers: { 'Retry-After': '0' } })
    })
    const questions: AccountQuestion[] = []
    const result = await run({
      ...base,
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alpha' },
      fetch: srv.fetch,
      ask: async (q) => {
        questions.push(q)
        return { answer: 'cancel' }
      },
    })
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(sleeps).toEqual(Array(MAX_AUTO_WAITS).fill(MIN_WAIT_MS))
    expect(sleeps).toEqual([1_000, 1_000, 1_000])
    expect(calls).toBe(4)
    expect(questions.map((q) => q.field)).toEqual(['new_code'])
  })

  it('a yes resets the count: three more waits, then asked again', async () => {
    let calls = 0
    const srv = server(() => {
      calls++
      if (calls === 8) return codeSent('pnd_1')
      return json(
        429,
        {
          code: 'OTP_COOLDOWN',
          message: 'You can request a new code in 5 seconds.',
          details: { retry_after_s: 5, version: 1, flow: 'register', next_step: 'register' },
        },
        { 'Retry-After': '5' },
      )
    })
    const asked: string[] = []
    const result = await run({
      ...base,
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alpha' },
      fetch: srv.fetch,
      ask: async (q) => {
        asked.push(q.field)
        return q.field === 'new_code' ? { answer: 'new_code' } : { answer: 'cancel' }
      },
    })
    expect(result).toEqual({ outcome: 'cancelled' })
    // 3 waits, a question (it resets the count), 3 waits, a question, 1 wait, then a code arrives.
    expect(asked).toEqual(['new_code', 'new_code', 'code'])
    expect(sleeps).toEqual(Array(7).fill(5_000))
    expect(calls).toBe(8)
  })

  it('waits on a code: after three, the person is asked for the code again', async () => {
    const limited = () =>
      json(
        429,
        {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Try again in 10 seconds.',
          details: { retry_after_s: 10, version: 1, flow: 'register', next_step: 'verify' },
        },
        { 'Retry-After': '10' },
      )
    const srv = scripted([codeSent('pnd_1'), limited(), limited(), limited(), limited()])
    const asked: string[] = []
    const result = await run({
      ...base,
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alpha' },
      fetch: srv.fetch,
      ask: async (q) => {
        asked.push(q.field)
        return asked.length === 1 ? { answer: 'value', value: '123456' } : { answer: 'cancel' }
      },
    })
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(sleeps).toEqual([10_000, 10_000, 10_000])
    expect(asked).toEqual(['code', 'code'])
    expect(srv.seen.slice(1).every((s) => s.body?.pending_id === 'pnd_1' && s.body?.code === '123456')).toBe(true)
  })
})
