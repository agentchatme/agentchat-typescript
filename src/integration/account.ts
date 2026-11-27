/**
 * Sign-up for an integration's setup (`integration.account`): register a new
 * agent or recover a lost key by email code, following the server's answer
 * instead of a rulebook of its own.
 *
 * Every answer of the sign-up endpoints carries a flow object (contract v1,
 * "Sign-up flows"): the next call to make (`next_step`), the state of the
 * pending code, the one input that must change (`param`), how long to wait
 * (`retry_after_s`), and a `message` written to be shown to a person as is.
 * The integration asks the person, shows the message, and saves the key;
 * the rules stay on the server.
 *
 *   flowOf(bodyOrError)      the flow object of a body or SDK error, or null
 *   actionOf(flow, status, calledStep)  what the client does next (the conformance vocabulary)
 *   start(kind, input, …)    one start call (sends a code)
 *   submitCode(flow, code, …) one verify call
 *   run({kind, input, ask, show, …})  the whole conversation, for a wizard
 *   checkKey(apiKey, …)      does the server accept this key (GET /v1/agents/me)
 *
 * The step functions work alone, one per process run: save the returned
 * `flow` (plain JSON) between `start` and `submitCode`. They return every
 * answer the server gives and throw only for network errors and misuse.
 *
 * Rules for every integration: never save a key the server rejected; save
 * the handle the server returned, not the one typed; show `message` verbatim
 * and branch only on `action` / `next_step` / `code`, never on the text.
 *
 * A server older than the flow contract sends no `next_step`: the step
 * functions then read today's codes into the same flow shape (`legacy:
 * true` on the result), so a caller follows one path for both.
 */

import { HttpTransport } from '../http.js'
import { AgentChatError, RateLimitedError } from '../errors.js'
import { clientIdentityHeaders, type AgentChatClientIdentity } from '../client-identity.js'
import type {
  ConnectorSignupConnect,
  RegisterFinish,
  SignupFlow,
  SignupParam,
  SignupStartStep,
  SignupVerifyStep,
} from '../types/index.js'

const DEFAULT_API_BASE = 'https://api.agentchat.me'

/** The longest wait `run` sits out on `retry_after_s`; a longer one stops the flow. */
export const MAX_WAIT_S = 60

/** The default field labels: the only words this helper brings (GOV.UK / One Login wording). */
export const DEFAULT_LABELS: Readonly<AccountLabels> = Object.freeze({
  email: 'Email address',
  handle: 'Handle',
  code: 'Enter the 6-digit code',
})

/** The flows an integration's setup runs. Key rotation needs the old key: `AgentChatClient.rotateKey`. */
export type AccountKind = 'register' | 'recover'

/**
 * What the client does next, derived only from `next_step`, `status`,
 * `param`, `retry_after_s`, the HTTP status and the step called
 * (conformance `signup-flow.cases.json`; `actionOf` has the order):
 *
 * | action            | when |
 * |-------------------|------|
 * | `done`            | `next_step: "done"` (the key is in the body) |
 * | `connect`         | `next_step: "connect"` (the right code on a flow started with `finish: "connector"`): the flow is done and no key comes; add the connector from `connect` (at `connect.mcp_url`) and show `message` |
 * | `ask_code`        | a verify step, no `retry_after_s` |
 * | `ask_param`       | a start step with `param`: re-ask that field, call the start step again |
 * | `offer_new_code`  | a start step, no `param`, the code gone (`expired` / `max_attempts_reached`, or a 429 to a verify step), any wait ≤ 60: ask before sending a new code (wait first if accepted) |
 * | `wait_then_retry` | 429 with `retry_after_s` ≤ 60 naming the step called: wait, then repeat it |
 * | `stop`            | a 5xx, a longer wait, an unknown `next_step`, anything else: show `message`, end |
 * | `legacy`          | no flow object (a server older than the flow contract) |
 */
export type SignupAction =
  | 'done'
  | 'connect'
  | 'ask_code'
  | 'ask_param'
  | 'offer_new_code'
  | 'wait_then_retry'
  | 'stop'
  | 'legacy'

export interface AccountLabels {
  email: string
  handle: string
  code: string
}

/** Input of the register start call (`POST /v1/register`). */
export interface RegisterInput {
  email: string
  handle: string
  display_name?: string
  description?: string
  /**
   * `connector`: the right code answers action `connect` with `connect` set
   * (a connector address that signs the new account in once) instead of a
   * key. Sent only when given. `start` and `submitCode` only: `run` signs up
   * with a key.
   */
  finish?: RegisterFinish
}

/** Input of the recover start call (`POST /v1/agents/recover`). Pass `handle` whenever it is known. */
export interface RecoverInput {
  email: string
  handle?: string
  /**
   * `connector`: sign a runtime in as the account instead of replacing its
   * key. The right code then answers action `connect` with `connect` set,
   * and the key stays as it is. Sent only when given. `start` and
   * `submitCode` only: `run` recovers a key.
   */
  finish?: RegisterFinish
}

/** How every account call reaches the server. Never retried (a second code would be sent). */
export interface AccountCallOptions {
  /** The integration's identity (`X-AgentChat-Client`), as for its client. */
  clientIdentity: AgentChatClientIdentity
  /** Default `https://api.agentchat.me`. */
  apiBase?: string
  /** `fetch` override (tests, polyfills). */
  fetch?: typeof fetch
  /** Per-request timeout in ms. Default 30 s. */
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * One step's answer. `flow` is plain JSON: save it between a `start` and a
 * `submitCode` that run in different processes.
 */
export interface StepResult {
  /** The server's flow object; for a legacy server, today's answer read into the same shape. */
  flow: SignupFlow
  /** The server's sentence. Show it as is. */
  message: string
  /** What to do next. Never `legacy`: a legacy answer is read into a flow first. */
  action: Exclude<SignupAction, 'legacy'>
  /** HTTP status of the answer. */
  httpStatus: number
  /** The step this call made (`register`, `verify`, `recover`, `recover_verify`): `actionOf`'s third input. */
  calledStep: SignupStartStep | SignupVerifyStep
  /** True when the server sent no flow object and the answer was read from its code. */
  legacy: boolean
  /** The error code, for a non-2xx answer. */
  code?: string
  /** On `done`: the API key. Shown once — save it. */
  apiKey?: string
  /** On `done` and `connect`: the handle the server returned. Save this one, not the typed one. */
  handle?: string
  /**
   * On `connect`: the connector address (`mcp_url`, a one-use grant: use it
   * as it is) and its sign-in endpoints, as the server sent them. Add the
   * connector from it before `connect.expires_at`; no key comes.
   */
  connect?: ConnectorSignupConnect
  /** `HANDLE_REQUIRED`: the handles on this email (`details.handles`), to choose from. */
  handles?: string[]
}

/** One question `run` puts to the person. */
export interface AccountQuestion {
  /**
   * `email` / `handle`: enter that field. `code`: enter the emailed code.
   * `new_code`: the code is gone (expired, or too many wrong tries) — send a
   * new one?
   */
  field: 'email' | 'handle' | 'code' | 'new_code'
  /** The field's label (`DEFAULT_LABELS` unless overridden); null for `new_code`. */
  label: string | null
  /** The answers allowed: `value` (typed input), `new_code`, `cancel` (always). */
  answers: ReadonlyArray<AccountAnswer['answer']>
  /** `HANDLE_REQUIRED`: the handles to choose from. */
  handles?: string[]
  /** The flow the question comes from (null before the first call). */
  flow: SignupFlow | null
}

export type AccountAnswer =
  | { answer: 'value'; value: string }
  | { answer: 'new_code' }
  | { answer: 'cancel' }

export interface RunOptions extends AccountCallOptions {
  kind: AccountKind
  /**
   * What is known up front. A missing `email` (or, to register, `handle`) is
   * asked first; `display_name` / `description` go with every register call.
   * `run` ends with a key, so it takes no `finish` (a `TypeError`): a
   * connector sign-up or recovery is `start` and `submitCode`.
   */
  input?: Partial<Omit<RegisterInput, 'finish'>> | Partial<Omit<RecoverInput, 'finish'>>
  /** Ask the person one question. */
  ask: (question: AccountQuestion) => Promise<AccountAnswer>
  /** Show the person a server sentence, as is. */
  show: (message: string) => void | Promise<void>
  /** Sit out a wait. Default: a timer (aborted by `signal`). */
  sleep?: (ms: number) => Promise<void>
  labels?: Partial<AccountLabels>
}

export type RunResult =
  | { outcome: 'done'; apiKey: string; handle: string }
  | { outcome: 'cancelled' }
  /** The flow ended on the server's word; `message` has been shown. */
  | { outcome: 'stopped'; code: string | null; message: string }

export type CheckKeyResult =
  | { ok: true; handle: string }
  | { ok: false; code: string; message: string }

// ─── Reading the answer ──────────────────────────────────────────────────────

const START_STEPS: ReadonlySet<string> = new Set<SignupStartStep>(['register', 'recover', 'rotate_key'])
const VERIFY_STEPS: ReadonlySet<string> = new Set<SignupVerifyStep>(['verify', 'recover_verify', 'rotate_key_verify'])
const KNOWN_STEPS: ReadonlySet<string> = new Set([...START_STEPS, ...VERIFY_STEPS, 'done'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The flow object of a sign-up answer: of a 2xx body, of an error body
 * (`details`), or of an SDK error (its `details`). Null when there is none —
 * a server older than the flow contract, or anything else. Pure; only the
 * known fields, each only when it has the contract's type.
 */
export function flowOf(bodyOrError: unknown): SignupFlow | null {
  let source: unknown
  if (bodyOrError instanceof AgentChatError) source = bodyOrError.details
  else if (isRecord(bodyOrError)) source = typeof bodyOrError.code === 'string' ? bodyOrError.details : bodyOrError
  if (!isRecord(source)) return null
  const nextStep = text(source.next_step)
  if (nextStep === undefined) return null
  const flow: SignupFlow = {
    version: typeof source.version === 'number' ? source.version : 1,
    flow: text(source.flow) ?? '',
    next_step: nextStep,
  }
  const strings = ['status', 'pending_id', 'param', 'expires_at'] as const
  for (const key of strings) {
    const value = text(source[key])
    if (value !== undefined) flow[key] = value
  }
  const numbers = [
    'expires_in_s',
    'code_length',
    'attempts',
    'max_attempts',
    'resend_after_s',
    'retry_after_s',
  ] as const
  for (const key of numbers) {
    const value = wholeNumber(source[key])
    if (value !== undefined) flow[key] = value
  }
  return flow
}

function isStartStep(step: string): step is SignupStartStep {
  return START_STEPS.has(step)
}

function isVerifyStep(step: string): step is SignupVerifyStep {
  return VERIFY_STEPS.has(step)
}

/**
 * What the client does next (the table on `SignupAction`), from the flow
 * object, the answer's HTTP status and the step that was called. Pure.
 * First match wins:
 *
 * - no flow → `legacy`; `next_step: "done"` → `done`;
 * - `next_step: "connect"` → `connect`;
 * - a 5xx → `stop`;
 * - a verify step without `retry_after_s` → `ask_code`;
 * - a start step with `param` → `ask_param`;
 * - a start step without `param` whose code is gone (`status` `expired` /
 *   `max_attempts_reached`, or a 429 to a verify step), and no
 *   `retry_after_s` or one ≤ 60 → `offer_new_code` (the client waits it out
 *   only if the person accepts);
 * - a 429 with `retry_after_s` ≤ 60 that names the step called →
 *   `wait_then_retry`;
 * - anything else (an unknown `next_step`, another 4xx to a verify step, a
 *   longer wait) → `stop`.
 *
 * Knowing the called step keeps a wait from turning into a new code nobody
 * asked for: a 429 on a code that names the start step is an offer, not a
 * retry.
 */
export function actionOf(
  flow: SignupFlow | null,
  httpStatus: number,
  calledStep: SignupStartStep | SignupVerifyStep | (string & {}),
): SignupAction {
  if (flow === null) return 'legacy'
  const step = flow.next_step
  if (step === 'done') return 'done'
  if (step === 'connect') return 'connect'
  if (httpStatus >= 500 || !KNOWN_STEPS.has(step)) return 'stop'
  const wait = flow.retry_after_s
  if (isVerifyStep(step) && wait === undefined) return 'ask_code'
  if (isStartStep(step)) {
    if (flow.param !== undefined) return 'ask_param'
    const codeGone =
      flow.status === 'expired' ||
      flow.status === 'max_attempts_reached' ||
      (httpStatus === 429 && isVerifyStep(calledStep))
    if (codeGone && (wait === undefined || wait <= MAX_WAIT_S)) return 'offer_new_code'
  }
  if (httpStatus === 429 && wait !== undefined && wait <= MAX_WAIT_S && step === calledStep) return 'wait_then_retry'
  return 'stop'
}

// ─── The steps ───────────────────────────────────────────────────────────────

interface Steps {
  start: SignupStartStep
  verify: SignupVerifyStep
  startPath: string
  verifyPath: string
}

const STEPS: Record<AccountKind, Steps> = {
  register: { start: 'register', verify: 'verify', startPath: '/v1/register', verifyPath: '/v1/register/verify' },
  recover: {
    start: 'recover',
    verify: 'recover_verify',
    startPath: '/v1/agents/recover',
    verifyPath: '/v1/agents/recover/verify',
  },
}

/** What one call answered, before it is read. */
interface Answer {
  httpStatus: number
  body: unknown
  error: AgentChatError | null
}

function transport(options: AccountCallOptions, apiKey?: string): HttpTransport {
  return new HttpTransport({
    baseUrl: options.apiBase ?? DEFAULT_API_BASE,
    defaultHeaders: clientIdentityHeaders(options.clientIdentity),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
}

async function call(
  options: AccountCallOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  apiKey?: string,
): Promise<Answer> {
  try {
    const res = await transport(options, apiKey).request<unknown>(method, path, {
      ...(body !== undefined ? { body } : {}),
      retry: 'never',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    })
    return { httpStatus: res.status, body: res.data, error: null }
  } catch (err) {
    // An answer from the server is an outcome; anything else (no answer,
    // an abort) is the caller's to handle.
    if (err instanceof AgentChatError) return { httpStatus: err.status, body: undefined, error: err }
    throw err
  }
}

function successMessage(body: unknown): string {
  return isRecord(body) && typeof body.message === 'string' ? body.message : ''
}

function keyAndHandle(body: unknown): { apiKey?: string; handle?: string } {
  if (!isRecord(body)) return {}
  const apiKey = text(body.api_key)
  const agent = isRecord(body.agent) ? body.agent : null
  const handle = text(body.handle) ?? text(agent?.handle)
  return { ...(apiKey !== undefined ? { apiKey } : {}), ...(handle !== undefined ? { handle } : {}) }
}

/** The `connect` block of a connector answer, as sent; undefined when it has no `mcp_url`. */
function connectOf(body: unknown): ConnectorSignupConnect | undefined {
  if (!isRecord(body) || !isRecord(body.connect) || text(body.connect.mcp_url) === undefined) return undefined
  return body.connect as unknown as ConnectorSignupConnect
}

function handlesOf(error: AgentChatError | null): string[] | undefined {
  const raw = error?.details?.handles
  if (!Array.isArray(raw)) return undefined
  return raw.filter((h): h is string => typeof h === 'string')
}

/** Seconds to wait on a 429, from wherever an older server put it. */
function legacyWaitSeconds(error: AgentChatError): number | undefined {
  if (error.retryAfterS !== null) return error.retryAfterS
  if (error instanceof RateLimitedError && error.retryAfterMs !== null) return Math.ceil(error.retryAfterMs / 1000)
  return undefined
}

/** The zod field an older server's VALIDATION_ERROR names, when it names exactly one we ask for. */
function legacyFieldOf(error: AgentChatError): SignupParam | undefined {
  const fieldErrors = error.details?.fieldErrors
  if (!isRecord(fieldErrors)) return undefined
  const named = (['email', 'handle', 'code'] as const).filter((f) => fieldErrors[f] !== undefined)
  return named.length === 1 ? named[0] : undefined
}

/**
 * Today's answers, read into the flow shape: a server older than the flow
 * contract sends `{code, message}` (or `{pending_id, message}`) and nothing
 * more. The reading follows what the integrations did with those codes; the
 * message stays the server's own.
 */
function legacyFlow(
  kind: AccountKind,
  stepCalled: 'start' | 'verify',
  answer: Answer,
  submitted: SignupFlow | null,
): SignupFlow {
  const steps = STEPS[kind]
  const startFlow = (extra: Partial<SignupFlow> = {}): SignupFlow => ({
    version: 1,
    flow: kind,
    next_step: steps.start,
    ...extra,
  })
  const pendingAgain = (extra: Partial<SignupFlow> = {}): SignupFlow => ({
    version: 1,
    flow: kind,
    next_step: steps.verify,
    status: 'pending',
    ...(submitted?.pending_id !== undefined ? { pending_id: submitted.pending_id } : {}),
    code_length: submitted?.code_length ?? 6,
    ...extra,
  })
  const { error, body } = answer
  if (error === null) {
    // A 2xx without what it should carry reads as a bare start step: stop.
    if (stepCalled === 'start') {
      const pendingId = isRecord(body) ? text(body.pending_id) : undefined
      if (pendingId === undefined) return startFlow()
      return { version: 1, flow: kind, next_step: steps.verify, status: 'pending', pending_id: pendingId, code_length: 6 }
    }
    const { apiKey } = keyAndHandle(body)
    if (apiKey === undefined) return startFlow()
    return { version: 1, flow: kind, next_step: 'done', status: 'approved' }
  }
  if (error.status === 429) {
    if (error.code === 'OTP_ATTEMPTS_EXHAUSTED') return startFlow({ status: 'max_attempts_reached' })
    // A 429 that names no wait is a bare start step: stop.
    const wait = legacyWaitSeconds(error)
    if (wait === undefined) return startFlow()
    return stepCalled === 'verify' ? pendingAgain({ retry_after_s: wait }) : startFlow({ retry_after_s: wait })
  }
  switch (error.code) {
    case 'HANDLE_TAKEN':
    case 'INVALID_HANDLE':
    case 'HANDLE_REQUIRED':
      return startFlow({ param: 'handle' })
    case 'EMAIL_LIMIT_REACHED':
    case 'EMAIL_TAKEN':
    case 'EMAIL_EXHAUSTED':
      return startFlow({ param: 'email' })
    case 'INVALID_CODE':
      return pendingAgain({ param: 'code' })
    case 'EXPIRED':
      return startFlow({ status: 'expired' })
    case 'VALIDATION_ERROR': {
      const field = legacyFieldOf(error)
      if (stepCalled === 'verify') return field === 'code' ? pendingAgain({ param: 'code' }) : startFlow()
      return field === 'email' || field === 'handle' ? startFlow({ param: field }) : startFlow()
    }
    default:
      return startFlow()
  }
}

function read(
  kind: AccountKind,
  stepCalled: 'start' | 'verify',
  answer: Answer,
  submitted: SignupFlow | null,
): StepResult {
  const { error, body, httpStatus } = answer
  const served = flowOf(error ?? body)
  const legacy = served === null
  let flow = served ?? legacyFlow(kind, stepCalled, answer, submitted)
  // An answer to a code that sends the client back to the same verify step
  // without naming the pending id (a malformed code, a per-IP 429) still
  // refers to the one submitted, which stays alive.
  if (
    !legacy &&
    submitted?.pending_id !== undefined &&
    flow.pending_id === undefined &&
    flow.next_step === submitted.next_step
  ) {
    flow = { ...flow, pending_id: submitted.pending_id }
  }
  const calledStep = stepCalled === 'start' ? STEPS[kind].start : STEPS[kind].verify
  let action = actionOf(flow, httpStatus, calledStep) as Exclude<SignupAction, 'legacy'>
  const credentials = error === null ? keyAndHandle(body) : {}
  // `done` means the key is in the body; without one there is nothing to save.
  if (action === 'done' && (credentials.apiKey === undefined || credentials.handle === undefined)) action = 'stop'
  // `connect` means the connector address is in the body; without it (or the handle) there is nothing to add.
  const connect = error === null ? connectOf(body) : undefined
  if (action === 'connect' && (connect === undefined || credentials.handle === undefined)) action = 'stop'
  // A code step without a pending id cannot be answered.
  if (action === 'ask_code' && flow.pending_id === undefined) action = 'stop'
  const handles = handlesOf(error)
  return {
    flow,
    message: error !== null ? error.message : successMessage(body),
    action,
    httpStatus,
    calledStep,
    legacy,
    ...(error !== null ? { code: error.code } : {}),
    ...(action === 'done' ? credentials : {}),
    ...(action === 'connect' ? { handle: credentials.handle!, connect: connect! } : {}),
    ...(handles !== undefined ? { handles } : {}),
  }
}

/**
 * Start a flow: `register` sends a code to `input.email` for a new agent
 * `input.handle`; `recover` sends a code to the email the agent was
 * registered with. With `input.finish: 'connector'`, on either, the right
 * code answers action `connect` instead of a key. One call, never retried. Resolves
 * with every answer the server gives; rejects only when there is no answer
 * (network, timeout, abort).
 */
export function start(kind: 'register', input: RegisterInput, options: AccountCallOptions): Promise<StepResult>
export function start(kind: 'recover', input: RecoverInput, options: AccountCallOptions): Promise<StepResult>
export function start(
  kind: AccountKind,
  input: RegisterInput | RecoverInput,
  options: AccountCallOptions,
): Promise<StepResult>
export async function start(
  kind: AccountKind,
  input: RegisterInput | RecoverInput,
  options: AccountCallOptions,
): Promise<StepResult> {
  const steps = STEPS[kind]
  if (steps === undefined) throw new TypeError(`integration.account.start: unknown kind ${JSON.stringify(kind)}`)
  if (!isRecord(input)) throw new TypeError('integration.account.start: input must be an object')
  const body =
    kind === 'register'
      ? {
          email: input.email,
          handle: input.handle,
          display_name: (input as RegisterInput).display_name,
          description: (input as RegisterInput).description,
          // Sent only when given: an ordinary sign-up's body is unchanged.
          ...((input as RegisterInput).finish !== undefined ? { finish: (input as RegisterInput).finish } : {}),
        }
      : {
          email: input.email,
          handle: input.handle,
          // Sent only when given: an ordinary recovery's body is unchanged.
          ...((input as RecoverInput).finish !== undefined ? { finish: (input as RecoverInput).finish } : {}),
        }
  const answer = await call(options, 'POST', steps.startPath, body)
  return read(kind, 'start', answer, null)
}

/**
 * Submit the emailed code for a pending flow (a flow whose `next_step` is
 * `verify` or `recover_verify`, as `start` or an earlier `submitCode`
 * returned it, or as saved to disk). One call, never retried. On `done`,
 * `apiKey` and `handle` are set: save both. On `connect` (a flow started
 * with `finish: 'connector'`), `connect` and `handle` are set and no key
 * comes: add the connector from `connect`. Throws a `TypeError` for a flow
 * that is not waiting for a code.
 */
export async function submitCode(flow: SignupFlow, code: string, options: AccountCallOptions): Promise<StepResult> {
  if (!isRecord(flow) || typeof flow.next_step !== 'string') {
    throw new TypeError('integration.account.submitCode: flow must be a sign-up flow object')
  }
  const kind: AccountKind | null =
    flow.next_step === 'verify' ? 'register' : flow.next_step === 'recover_verify' ? 'recover' : null
  if (kind === null) {
    throw new TypeError(
      `integration.account.submitCode: the flow is not waiting for a code (next_step ${JSON.stringify(flow.next_step)}); ` +
        'submit only to next_step "verify" or "recover_verify" (key rotation: AgentChatClient.rotateKeyVerify)',
    )
  }
  if (typeof flow.pending_id !== 'string' || flow.pending_id.length === 0) {
    throw new TypeError('integration.account.submitCode: the flow carries no pending_id')
  }
  const answer = await call(options, 'POST', STEPS[kind].verifyPath, { pending_id: flow.pending_id, code })
  return read(kind, 'verify', answer, flow)
}

/**
 * Does the server accept this key? One `GET /v1/agents/me`, never retried.
 * `{ok: true, handle}` with the handle the key belongs to, or `{ok: false,
 * code, message}` with the server's answer. Rejects when no usable answer
 * came (network, timeout, abort, a 2xx without a handle): then nothing is
 * known about the key.
 */
export async function checkKey(apiKey: string, options: AccountCallOptions): Promise<CheckKeyResult> {
  const answer = await call(options, 'GET', '/v1/agents/me', undefined, apiKey)
  if (answer.error !== null) return { ok: false, code: answer.error.code, message: answer.error.message }
  const handle = isRecord(answer.body) ? text(answer.body.handle) : undefined
  if (handle === undefined) {
    throw new Error(`integration.account.checkKey: GET /v1/agents/me answered ${answer.httpStatus} without a handle`)
  }
  return { ok: true, handle }
}

// ─── The conversation ────────────────────────────────────────────────────────

function defaultSleep(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

const FIELD_ANSWERS = ['value', 'cancel'] as const
const CODE_ANSWERS = ['value', 'new_code', 'cancel'] as const
const NEW_CODE_ANSWERS = ['new_code', 'cancel'] as const

/** The shortest wait `run` sits out, in ms (a `Retry-After: 0` is not a tight loop). */
export const MIN_WAIT_MS = 1_000
/** Waits `run` sits out in a row without a question; before the next one it asks the person. */
export const MAX_AUTO_WAITS = 3

/**
 * The whole sign-up conversation, for an interactive setup. It follows
 * `next_step`: shows every server `message` (through `show`), asks only for
 * what the server names (`param`, or the code), and lets the person enter
 * the code, ask for a new code, or cancel. It never sends a new code unasked
 * and keeps no attempt caps of its own: the server's are the only ones.
 *
 * Waiting. Every wait is at least 1 s and at most 60 s; after 3 waits in a
 * row without a question, the person is asked before the next one (the
 * code again, or "send a new code?"). It waits out a `retry_after_s` of up
 * to 60 s that names the step it called; after a yes to a new code it
 * first waits out the answer's `retry_after_s`. And before every start
 * call that follows a send to the same email in this run (a new code, a
 * re-asked handle, a recover with the chosen handle) it waits out what is
 * left of the last answer's `resend_after_s`: a start inside that window
 * would be turned away, or, for recover, answered like any other with no
 * email sent. When more than 60 s are left, a new code asked for at the
 * code question goes back to the code the person holds while it still
 * works, and otherwise the flow stops.
 *
 * A new code asked for and answered by a 429 that `run` does not wait out
 * (`OTP_HOURLY_CAP`, a long per-IP limit, …) also goes back to the held
 * code while it still works (`expires_in_s` from its answer, else
 * `expires_at`), instead of stopping.
 *
 * Resolves `{outcome: 'done', apiKey, handle}` (save both),
 * `{outcome: 'cancelled'}`, or `{outcome: 'stopped', code, message}` (the
 * message has been shown). Rejects when the server cannot be reached, or
 * when `ask` / `show` / `sleep` throw.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { kind, ask, show } = options
  if (STEPS[kind] === undefined) throw new TypeError(`integration.account.run: unknown kind ${JSON.stringify(kind)}`)
  if (isRecord(options.input) && (options.input as { finish?: unknown }).finish !== undefined) {
    throw new TypeError('integration.account.run: run ends with a key and takes no finish; use start and submitCode')
  }
  const labels: AccountLabels = { ...DEFAULT_LABELS, ...options.labels }
  const sleep = options.sleep ?? defaultSleep(options.signal)
  const callOptions: AccountCallOptions = {
    clientIdentity: options.clientIdentity,
    ...(options.apiBase !== undefined ? { apiBase: options.apiBase } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const input: { email?: string; handle?: string; display_name?: string; description?: string } = {
    ...options.input,
  }
  /** Waits since the last question. */
  let waitsInARow = 0

  const askOne = async (question: AccountQuestion): Promise<AccountAnswer> => {
    waitsInARow = 0
    const answer = await ask(question)
    if (!isRecord(answer) || !question.answers.includes(answer.answer)) {
      throw new TypeError(
        `integration.account.run: ask answered ${JSON.stringify(answer)} to a ${question.field} question ` +
          `(allowed: ${question.answers.join(', ')})`,
      )
    }
    if (answer.answer === 'value' && typeof answer.value !== 'string') {
      throw new TypeError('integration.account.run: a value answer carries a string value')
    }
    return answer
  }
  /** Ask for a field; false when the person cancelled. */
  const askField = async (field: 'email' | 'handle', flow: SignupFlow | null, handles?: string[]) => {
    const answer = await askOne({
      field,
      label: labels[field],
      answers: FIELD_ANSWERS,
      ...(handles !== undefined && handles.length > 0 ? { handles } : {}),
      flow,
    })
    if (answer.answer !== 'value') return false
    input[field] = answer.value.trim()
    return true
  }
  const wait = async (ms: number) => {
    waitsInARow += 1
    await sleep(Math.max(MIN_WAIT_MS, ms))
  }

  const required: Array<'email' | 'handle'> = kind === 'register' ? ['email', 'handle'] : ['email']
  for (const field of required) {
    if (typeof input[field] === 'string' && input[field].trim().length > 0) continue
    if (!(await askField(field, null))) return { outcome: 'cancelled' }
  }

  type Call = { step: 'start' | 'verify'; call: () => Promise<StepResult> }
  const startCall: Call = {
    step: 'start',
    call: () => {
      const email = input.email ?? ''
      if (kind === 'recover') {
        return start('recover', { email, ...(input.handle ? { handle: input.handle } : {}) }, callOptions)
      }
      return start(
        'register',
        {
          email,
          handle: input.handle ?? '',
          ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
        callOptions,
      )
    },
  }

  /** The code the person holds: the flow of the last code question, and when it stops working (epoch ms, or null). */
  let held: { flow: SignupFlow; expiresAtMs: number | null } | null = null
  const holdsAWorkingCode = () => held !== null && held.expiresAtMs !== null && held.expiresAtMs > Date.now()
  /** The last answer that said when the email may get a new code (`resend_after_s`), and when it arrived. */
  let resend: { email: string; afterMs: number; receivedAt: number } | null = null

  /**
   * Before a start call: sit out what is left of the last answer's
   * `resend_after_s` for this email. False when more than 60 s are left.
   */
  const beforeStart = async (): Promise<boolean> => {
    if (resend === null || resend.email !== (input.email ?? '')) return true
    const leftMs = resend.afterMs - (Date.now() - resend.receivedAt)
    if (leftMs > MAX_WAIT_S * 1000) return false
    if (leftMs > 0) await wait(leftMs)
    return true
  }

  /** Ask for the code of `flow`: the next call, null when the person cancelled, or STOP. */
  const askCode = async (flow: SignupFlow): Promise<Call | null | typeof STOP> => {
    for (;;) {
      const answer = await askOne({ field: 'code', label: labels.code, answers: CODE_ANSWERS, flow })
      if (answer.answer === 'cancel') return null
      if (answer.answer === 'value') {
        const code = answer.value.trim()
        return { step: 'verify', call: () => submitCode(flow, code, callOptions) }
      }
      if (await beforeStart()) return startCall
      // Too long until a new code may be sent: the held code, while it works.
      if (holdsAWorkingCode()) continue
      return STOP
    }
  }

  /**
   * Ask before a new code; on a yes, sit out the answer's `retry_after_s`
   * and what is left of the resend window. `true` to send, null when the
   * person declined, STOP when the window is too long.
   */
  const offerNewCode = async (flow: SignupFlow): Promise<true | null | typeof STOP> => {
    const answer = await askOne({ field: 'new_code', label: null, answers: NEW_CODE_ANSWERS, flow })
    if (answer.answer !== 'new_code') return null
    const retryAfterS = flow.retry_after_s
    if (retryAfterS !== undefined && retryAfterS > 0 && retryAfterS <= MAX_WAIT_S) await wait(retryAfterS * 1000)
    return (await beforeStart()) ? true : STOP
  }

  let repeat: Call = startCall
  let result = await repeat.call()
  let receivedAt = Date.now()
  for (;;) {
    const after = result.flow.resend_after_s
    if (after !== undefined) resend = { email: input.email ?? '', afterMs: after * 1000, receivedAt }
    if (result.message.length > 0) await show(result.message)
    let next: Call | null | typeof STOP = STOP
    switch (result.action) {
      case 'done':
        return { outcome: 'done', apiKey: result.apiKey!, handle: result.handle! }

      case 'ask_code': {
        const flow = result.flow
        const expiresAtMs: number | null =
          expiryOf(flow, receivedAt) ??
          (held !== null && held.flow.pending_id === flow.pending_id ? held.expiresAtMs : null)
        held = { flow, expiresAtMs }
        next = await askCode(flow)
        break
      }

      case 'ask_param': {
        held = null
        const param = result.flow.param
        const field = param === 'email' ? 'email' : param === 'handle' ? 'handle' : null
        if (field === null) break
        if (!(await askField(field, result.flow, result.handles))) return { outcome: 'cancelled' }
        if (await beforeStart()) next = startCall
        break
      }

      case 'offer_new_code': {
        held = null
        const offered = await offerNewCode(result.flow)
        next = offered === true ? startCall : offered
        break
      }

      case 'wait_then_retry': {
        if (waitsInARow >= MAX_AUTO_WAITS) {
          // Enough waiting without the person: ask before the next try.
          if (repeat.step === 'verify') {
            next = await askCode(held?.flow ?? result.flow)
            break
          }
          const again = await askOne({ field: 'new_code', label: null, answers: NEW_CODE_ANSWERS, flow: result.flow })
          if (again.answer !== 'new_code') return { outcome: 'cancelled' }
        }
        await wait(result.flow.retry_after_s! * 1000)
        next = repeat
        break
      }

      default:
        // A new code asked for and turned away for longer than run waits:
        // while the code the person holds still works, go back to it.
        if (result.httpStatus === 429 && repeat.step === 'start' && held !== null && holdsAWorkingCode()) {
          next = await askCode(held.flow)
        }
    }
    if (next === null) return { outcome: 'cancelled' }
    if (next === STOP) return stopped(result)
    repeat = next
    result = await repeat.call()
    receivedAt = Date.now()
  }
}

/**
 * When the flow's code stops working (epoch ms): `expires_in_s` from when
 * its answer arrived (no clock skew), else `expires_at`; null when neither.
 */
function expiryOf(flow: SignupFlow, receivedAt: number): number | null {
  if (flow.expires_in_s !== undefined) return receivedAt + flow.expires_in_s * 1000
  if (flow.expires_at !== undefined) {
    const at = Date.parse(flow.expires_at)
    if (Number.isFinite(at)) return at
  }
  return null
}

/** `run`'s marker for "end the flow on the last answer". */
const STOP: unique symbol = Symbol('stop')

function stopped(result: StepResult): RunResult {
  return { outcome: 'stopped', code: result.code ?? null, message: result.message }
}
