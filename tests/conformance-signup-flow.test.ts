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
import { AgentChatError, createAgentChatError, type AgentChatErrorResponse } from '../src/errors.js'
import type { SignupFlow } from '../src/types/index.js'

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

/** A connector sign-up's own calls: `AgentChatClient.register({ finish })` and `registerStatus`, below. */
const isConnectorCall = (c: SignupCase) => c.request.body.finish !== undefined || c.request.kind === 'register_status'
const stepCases = fixture.cases.filter((c) => STEP_KINDS[c.request.kind] !== undefined && !isConnectorCall(c))
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
    const rest = fixture.cases.filter((c) => !stepCases.includes(c) && !isConnectorCall(c))
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
        ? await start(kind, body as { email: string; handle: string }, options)
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
    if (c.expect.action === 'done') {
      expect(result.apiKey).toBe(c.response.body.api_key)
      const agent = c.response.body.agent as { handle?: string } | undefined
      expect(result.handle).toBe(c.response.body.handle ?? agent?.handle)
    } else {
      expect(result.apiKey).toBeUndefined()
    }
    if (result.action === 'ask_code') expect(result.flow.pending_id).toBe(c.request.body.pending_id ?? c.expect.flow?.pending_id)
  })
})

describe('conformance — signup-flow.cases.json: connector sign-up', () => {
  const connectorCases = fixture.cases.filter(isConnectorCall)

  it.each(connectorCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { seen, fetchImpl } = answering(c)
    const outcome = await (c.request.kind === 'register_status'
      ? AgentChatClient.registerStatus(`${API}${c.request.path}`, { fetch: fetchImpl })
      : AgentChatClient.register({
          ...(c.request.body as { email: string; handle: string; finish: 'connector' }),
          baseUrl: API,
          fetch: fetchImpl,
        })
    ).catch((e: unknown) => e)

    // The request is the fixture's: one call, the status read with no body.
    const body = c.request.method === 'GET' ? undefined : c.request.body
    expect(seen).toEqual([{ method: c.request.method, path: c.request.path, body }])
    if (isError(c)) {
      expect(outcome).toBeInstanceOf(AgentChatError)
      expect((outcome as AgentChatError).code).toBe(c.expect.code)
      expect((outcome as AgentChatError).message).toBe(c.expect.message)
    } else {
      expect(outcome).toEqual(c.response.body)
    }
  })
})
