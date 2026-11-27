import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  actionOf,
  flowOf,
  MAX_WAIT_S,
  start,
  submitCode,
  type SignupAction,
} from '../src/integration/account.js'
import { AgentChatClient } from '../src/client.js'
import {
  AgentChatError,
  ConnectorSignupError,
  createAgentChatError,
  type AgentChatErrorResponse,
} from '../src/errors.js'
import type { ConnectorVerifyResult, RegisterFinish, SignupFlow } from '../src/types/index.js'
import type { RecoverVerifyResult, RegisterVerifyResult, VerifyOptions } from '../src/client.js'

// ─── signup-flow.cases.json (contract v1, "Sign-up flows") ──────────────────
//
// Byte-identical copy of the contract's fixture. Each case: the request a
// client made, the server's response, and what the client derives (the flow
// object, the code, the message to show, the action). Nothing here restates
// a case; the expectations come from the file.

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../conformance/v1/signup-flow.cases.json')

interface SignupCase {
  name: string
  note?: string
  request: { kind: string; method: string; path: string; body: Record<string, unknown> }
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> }
  expect: {
    action: SignupAction
    code: string | null
    flow: Record<string, unknown> | null
    message: string
  }
}

interface SignupFixture {
  version: number
  actions: SignupAction[]
  start_steps: Record<string, string>
  verify_steps: Record<string, string>
  wait_limit_s: number
  cases: SignupCase[]
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SignupFixture

const isError = (c: SignupCase) => typeof c.response.body.code === 'string'

/** The response as the SDK surfaces it: the body of a 2xx, the SDK error otherwise. */
function surfaced(c: SignupCase): unknown {
  if (!isError(c)) return c.response.body
  return createAgentChatError(
    c.response.body as unknown as AgentChatErrorResponse,
    c.response.status,
    new Headers(c.response.headers),
  )
}

/** Every flow field the fixture lists, with its value; a parser may keep more. */
function expectFlow(actual: SignupFlow | null, expected: Record<string, unknown> | null) {
  if (expected === null) {
    expect(actual).toBeNull()
    return
  }
  expect(actual).not.toBeNull()
  for (const [key, value] of Object.entries(expected)) {
    expect((actual as unknown as Record<string, unknown>)[key], key).toEqual(value)
  }
}

describe('conformance — signup-flow.cases.json: the vocabulary', () => {
  it('names the same actions, steps and wait limit as the SDK', () => {
    expect(fixture.version).toBe(1)
    const sdkActions: SignupAction[] = [
      'done',
      'ask_code',
      'ask_param',
      'offer_new_code',
      'wait_then_retry',
      'stop',
      'legacy',
      'connect',
    ]
    expect([...fixture.actions].sort()).toEqual([...sdkActions].sort())
    expect(fixture.wait_limit_s).toBe(MAX_WAIT_S)
    expect(fixture.start_steps).toEqual({ register: 'register', recover: 'recover', rotate_key: 'rotate_key' })
    expect(fixture.verify_steps).toEqual({
      register: 'verify',
      recover: 'recover_verify',
      rotate_key: 'rotate_key_verify',
    })
  })

  it('covers every action', () => {
    const seen = new Set(fixture.cases.map((c) => c.expect.action))
    for (const action of fixture.actions) expect(seen.has(action), action).toBe(true)
  })
})

describe('conformance — signup-flow.cases.json: flowOf / actionOf', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    // From the raw body (code that calls the endpoints itself).
    const fromBody = flowOf(c.response.body)
    expectFlow(fromBody, c.expect.flow)
    expect(actionOf(fromBody, c.response.status, c.request.kind)).toBe(c.expect.action)

    // From what the SDK surfaces (the body, or the SDK error).
    const shown = surfaced(c)
    const fromSdk = flowOf(shown)
    expect(fromSdk).toEqual(fromBody)
    if (isError(c)) {
      const err = shown as ReturnType<typeof createAgentChatError>
      expect(err.code).toBe(c.expect.code)
      expect(err.message).toBe(c.expect.message)
      expect(err.details).toEqual(c.response.body.details)
    } else {
      expect(c.expect.code).toBeNull()
      expect(c.response.body.message).toBe(c.expect.message)
    }
  })
})

// ─── The steps, against the fixture's responses ─────────────────────────────

const STEP_KINDS: Record<string, { kind: 'register' | 'recover'; step: 'start' | 'verify' }> = {
  register: { kind: 'register', step: 'start' },
  verify: { kind: 'register', step: 'verify' },
  recover: { kind: 'recover', step: 'start' },
  recover_verify: { kind: 'recover', step: 'verify' },
}

/** What the SDK reads from an older server's answer (the fixture says only `legacy`). */
const LEGACY_READING: Record<string, { action: string; flow: Record<string, unknown> }> = {
  'legacy-register-code-sent': {
    action: 'ask_code',
    flow: { version: 1, flow: 'register', next_step: 'verify', status: 'pending' },
  },
  'legacy-verify-wrong-code': {
    action: 'ask_code',
    flow: { version: 1, flow: 'register', next_step: 'verify', status: 'pending', param: 'code' },
  },
  'legacy-cooldown': {
    action: 'wait_then_retry',
    flow: { version: 1, flow: 'register', next_step: 'register', retry_after_s: 42 },
  },
  'legacy-validation-error': {
    action: 'ask_param',
    flow: { version: 1, flow: 'register', next_step: 'register', param: 'handle' },
  },
}

/** A start with `finish` (connector sign-in): driven through the kit's `start` here and through the client below. */
const hasFinish = (c: SignupCase) => c.request.body.finish !== undefined
const stepCases = fixture.cases.filter((c) => STEP_KINDS[c.request.kind] !== undefined)
const API = 'https://api.agentchat.test'

/** A fetch that answers the case's response and records each request. */
function answering(c: SignupCase) {
  const seen: Array<{ method: string; path: string; body: unknown }> = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? 'GET',
      path: new URL(String(input)).pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(c.response.body), {
      status: c.response.status,
      headers: { 'content-type': 'application/json', ...c.response.headers },
    })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

describe('conformance — signup-flow.cases.json: start / submitCode', () => {
  it('drives every register and recover case (rotate key is the client’s rotateKey)', () => {
    expect(stepCases.length).toBeGreaterThan(0)
    const rest = fixture.cases.filter((c) => !stepCases.includes(c))
    for (const c of rest) expect(c.request.kind, c.name).toMatch(/^rotate_key/)
  })

  it.each(stepCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { kind, step } = STEP_KINDS[c.request.kind]!
    const { seen, fetchImpl } = answering(c)
    const options = { clientIdentity: { name: 'typescript_sdk' as const }, apiBase: API, fetch: fetchImpl }

    const body = c.request.body
    if (step === 'verify' && typeof body.pending_id !== 'string') {
      // A request the SDK cannot make (no pending id: a programmer error) is
      // refused before anything is sent.
      await expect(
        submitCode({ version: 1, flow: kind, next_step: c.request.kind }, String(body.code ?? ''), options),
      ).rejects.toThrow(TypeError)
      expect(seen).toEqual([])
      return
    }
    const result =
      step === 'start'
        ? await start(kind, body as { email: string; handle: string; finish?: RegisterFinish }, options)
        : await submitCode(
            { version: 1, flow: kind, next_step: c.request.kind, pending_id: body.pending_id as string },
            body.code as string,
            options,
          )

    // The request is the fixture's, one call, never retried.
    expect(seen).toEqual([{ method: c.request.method, path: c.request.path, body: c.request.body }])
    expect(result.message).toBe(c.expect.message)
    expect(result.code ?? null).toBe(c.expect.code)
    expect(result.httpStatus).toBe(c.response.status)
    expect(result.calledStep).toBe(c.request.kind)

    if (c.expect.action === 'legacy') {
      const reading = LEGACY_READING[c.name]
      expect(reading, `add the SDK's reading of ${c.name}`).toBeDefined()
      expect(result.legacy).toBe(true)
      expect(result.action).toBe(reading!.action)
      expectFlow(result.flow, reading!.flow)
      return
    }
    expect(result.legacy).toBe(false)
    expect(result.action).toBe(c.expect.action)
    expectFlow(result.flow, c.expect.flow)
    const agent = c.response.body.agent as { handle?: string } | undefined
    if (c.expect.action === 'done') {
      expect(result.apiKey).toBe(c.response.body.api_key)
      expect(result.handle).toBe(c.response.body.handle ?? agent?.handle)
    } else {
      expect(result.apiKey).toBeUndefined()
    }
    if (c.expect.action === 'connect') {
      expect(result.connect).toEqual(c.response.body.connect)
      expect(result.handle).toBe(c.response.body.handle ?? agent?.handle)
    } else {
      expect(result.connect).toBeUndefined()
    }
    if (result.action === 'ask_code') expect(result.flow.pending_id).toBe(c.request.body.pending_id ?? c.expect.flow?.pending_id)
  })
})

// ─── Connector sign-in through the client ───────────────────────────────────

/** The flow and claim-link fields a 2xx sign-up body carries, as `ConnectorVerifyResult` keeps them. */
const RESULT_FIELDS = [
  'version',
  'flow',
  'next_step',
  'status',
  'param',
  'expires_at',
  'expires_in_s',
  'code_length',
  'attempts',
  'max_attempts',
  'resend_after_s',
  'retry_after_s',
  'claim_url',
  'claim_expires_at',
  'claim_expires_in_s',
] as const

/** What the client's verify with `{ finish: 'connector' }` returns for a connect case, from the fixture alone. */
function expectedConnectorResult(c: SignupCase): ConnectorVerifyResult {
  const body = c.response.body
  const agent = body.agent as { handle?: string } | undefined
  const out: Record<string, unknown> = {}
  for (const key of RESULT_FIELDS) if (body[key] !== undefined) out[key] = body[key]
  return {
    ...out,
    handle: (body.handle as string | undefined) ?? agent!.handle!,
    connect: body.connect as ConnectorVerifyResult['connect'],
    message: c.expect.message,
  }
}

// The client's static calls, against the fixture's responses. A start is
// register(body) / recover(email, body); a verify is every verify and
// recover_verify case a client can send (a body with a pending id and a
// code: `verify-invalid-json` is a request no client method makes), with and
// without `finish: 'connector'`, which is never sent: the answer decides.
const CLIENT_START_CASES = fixture.cases.filter((c) => c.request.kind === 'register' || c.request.kind === 'recover')
const CLIENT_VERIFY_CASES = fixture.cases.filter(
  (c) =>
    (c.request.kind === 'verify' || c.request.kind === 'recover_verify') &&
    typeof c.request.body.pending_id === 'string' &&
    typeof c.request.body.code === 'string',
)

describe('conformance — signup-flow.cases.json: the client’s static calls', () => {
  it('has connector starts and connect answers for both register and recover', () => {
    expect(fixture.cases.filter(hasFinish).map((c) => c.request.kind).sort()).toEqual(['recover', 'register'])
    expect(
      fixture.cases
        .filter((c) => c.expect.action === 'connect')
        .map((c) => c.request.kind)
        .sort(),
    ).toEqual(['recover_verify', 'verify'])
    expect(CLIENT_VERIFY_CASES.filter((c) => c.expect.action === 'done').length).toBeGreaterThan(0)
  })

  it.each(CLIENT_START_CASES.map((c) => [c.name, c] as const))('%s: register / recover', async (_name, c) => {
    const { seen, fetchImpl } = answering(c)
    const body = c.request.body as { email: string; handle?: string; finish?: RegisterFinish }
    const options = { baseUrl: API, fetch: fetchImpl }
    const outcome = await (c.request.kind === 'recover'
      ? AgentChatClient.recover(body.email, {
          ...(body.handle !== undefined ? { handle: body.handle } : {}),
          ...(body.finish !== undefined ? { finish: body.finish } : {}),
          ...options,
        })
      : AgentChatClient.register({ ...(body as { email: string; handle: string; finish?: RegisterFinish }), ...options })
    ).catch((e: unknown) => e)

    // The request is the fixture's: one call; finish only when the case has it.
    expect(seen).toEqual([{ method: c.request.method, path: c.request.path, body: c.request.body }])
    if (isError(c)) {
      expect(outcome).toBeInstanceOf(AgentChatError)
      expect((outcome as AgentChatError).code).toBe(c.expect.code)
      expect((outcome as AgentChatError).message).toBe(c.expect.message)
      expect(flowOf(outcome)).toEqual(flowOf(c.response.body))
    } else {
      // A start with finish is the ordinary pending start: the body as served.
      expect(outcome).toEqual(c.response.body)
    }
  })

  it.each(
    CLIENT_VERIFY_CASES.flatMap((c) =>
      [undefined, 'connector' as const].map((finish) => [c.name, finish ?? 'no finish', c, finish] as const),
    ),
  )('%s (%s): verify / recoverVerify', async (_name, _label, c, finish) => {
    const { seen, fetchImpl } = answering(c)
    const body = c.request.body as { pending_id: string; code: string }
    const call = c.request.kind === 'recover_verify' ? AgentChatClient.recoverVerify : AgentChatClient.verify
    const options: VerifyOptions = { baseUrl: API, fetch: fetchImpl, ...(finish !== undefined ? { finish } : {}) }
    const outcome: unknown = await call(body.pending_id, body.code, options).catch((e: unknown) => e)
    const served = c.response.body

    // The request is the fixture's: one call, and finish is never sent.
    expect(seen).toEqual([{ method: c.request.method, path: c.request.path, body: c.request.body }])
    if (isError(c)) {
      expect(outcome).toBeInstanceOf(AgentChatError)
      expect(outcome).not.toBeInstanceOf(ConnectorSignupError)
      expect((outcome as AgentChatError).code).toBe(c.expect.code)
      expect((outcome as AgentChatError).message).toBe(c.expect.message)
      return
    }
    if (c.expect.action === 'done') {
      // A key came: the ordinary result, finish or not, with a client bound to it.
      const result = outcome as RegisterVerifyResult | RecoverVerifyResult
      expect(result).not.toHaveProperty('connect')
      expect(result.apiKey).toBe(served.api_key)
      expect(result.client).toBeInstanceOf(AgentChatClient)
      expect(result.message).toBe(c.expect.message)
      if (c.request.kind === 'recover_verify') expect((result as RecoverVerifyResult).handle).toBe(served.handle)
      else expect((result as RegisterVerifyResult).agent).toEqual(served.agent)
      expectFlow(flowOf(result), c.expect.flow)
      return
    }
    expect(c.expect.action, c.name).toBe('connect')
    if (finish === undefined) {
      // No connector result asked for: an error that still carries the address.
      expect(outcome).toBeInstanceOf(ConnectorSignupError)
      const e = outcome as ConnectorSignupError
      expect(e.message).toBe(c.expect.message)
      expect(e.code).toBe('CONNECTOR_SIGNUP')
      expect(e.status).toBe(c.response.status)
      expect(e.connect).toEqual(served.connect)
      expect(e.handle).toBe(expectedConnectorResult(c).handle)
      expect(e.result).toEqual(expectedConnectorResult(c))
      expectFlow(flowOf(e), c.expect.flow)
      expect(actionOf(flowOf(e), c.response.status, c.request.kind)).toBe('connect')
      return
    }
    expect(outcome).toEqual(expectedConnectorResult(c))
    expect(outcome).not.toHaveProperty('apiKey')
    expect(outcome).not.toHaveProperty('client')
    expectFlow(flowOf(outcome), c.expect.flow)
  })
})
