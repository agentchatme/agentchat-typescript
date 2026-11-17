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
 *   actionOf(flow, status)   what the client does next (the conformance vocabulary)
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
 * `param`, `retry_after_s` and the HTTP status (conformance
 * `signup-flow.cases.json`):
 *
 * | action            | when |
 * |-------------------|------|
 * | `done`            | `next_step: "done"` (the key is in the body) |
 * | `ask_code`        | a verify step, no `retry_after_s` |
 * | `ask_param`       | a start step with `param`: re-ask that field, call the start step again |
 * | `offer_new_code`  | a start step, no `param`, `status` `expired` / `max_attempts_reached`: ask before sending a new code (wait `retry_after_s` first when set) |
 * | `wait_then_retry` | 429 with `retry_after_s` ≤ 60: wait, then repeat `next_step` |
 * | `stop`            | 429 with `retry_after_s` > 60, a 5xx, an unknown `next_step`, anything else: show `message`, end |
 * | `legacy`          | no flow object (a server older than the flow contract) |
 */
export type SignupAction =
  | 'done'
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
}

/** Input of the recover start call (`POST /v1/agents/recover`). Pass `handle` whenever it is known. */
export interface RecoverInput {
  email: string
  handle?: string
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
  /** True when the server sent no flow object and the answer was read from its code. */
  legacy: boolean
  /** The error code, for a non-2xx answer. */
  code?: string
  /** On `done`: the API key. Shown once — save it. */
  apiKey?: string
  /** On `done`: the handle the server returned. Save this one, not the typed one. */
  handle?: string
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
   */
  input?: Partial<RegisterInput> | Partial<RecoverInput>
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
 * object and the answer's HTTP status. Pure. Order: an unknown step stops;
 * `done`; a 5xx stops; a verify step asks for the code unless it carries a
 * wait; a start step re-asks its `param`, or offers a new code when the old
 * one is gone; a 429 with a short wait waits; everything else stops.
 */
export function actionOf(flow: SignupFlow | null, httpStatus: number): SignupAction {
  if (flow === null) return 'legacy'
  const step = flow.next_step
  if (!KNOWN_STEPS.has(step)) return 'stop'
  if (step === 'done') return 'done'
  if (httpStatus >= 500) return 'stop'
  const wait = flow.retry_after_s
  if (isVerifyStep(step) && wait === undefined) return 'ask_code'
  if (isStartStep(step)) {
    if (flow.param !== undefined) return 'ask_param'
    if (flow.status === 'expired' || flow.status === 'max_attempts_reached') return 'offer_new_code'
  }
  if (httpStatus === 429 && wait !== undefined && wait <= MAX_WAIT_S) return 'wait_then_retry'
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
    const wait = legacyWaitSeconds(error)
    if (error.code === 'OTP_ATTEMPTS_EXHAUSTED') return startFlow({ status: 'max_attempts_reached' })
    const waitField = wait !== undefined ? { retry_after_s: wait } : {}
    return stepCalled === 'verify' ? pendingAgain(waitField) : startFlow(waitField)
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
  let action = actionOf(flow, httpStatus) as Exclude<SignupAction, 'legacy'>
  const credentials = error === null ? keyAndHandle(body) : {}
  // `done` means the key is in the body; without one there is nothing to save.
  if (action === 'done' && (credentials.apiKey === undefined || credentials.handle === undefined)) action = 'stop'
  // A code step without a pending id cannot be answered.
  if (action === 'ask_code' && flow.pending_id === undefined) action = 'stop'
  const handles = handlesOf(error)
  return {
    flow,
    message: error !== null ? error.message : successMessage(body),
    action,
    httpStatus,
    legacy,
    ...(error !== null ? { code: error.code } : {}),
    ...(action === 'done' ? credentials : {}),
    ...(handles !== undefined ? { handles } : {}),
  }
}

/**
 * Start a flow: `register` sends a code to `input.email` for a new agent
 * `input.handle`; `recover` sends a code to the email the agent was
 * registered with. One call, never retried. Resolves with every answer the
 * server gives; rejects only when there is no answer (network, timeout,
 * abort).
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
        }
      : { email: input.email, handle: input.handle }
  const answer = await call(options, 'POST', steps.startPath, body)
  return read(kind, 'start', answer, null)
}

/**
 * Submit the emailed code for a pending flow (a flow whose `next_step` is
 * `verify` or `recover_verify`, as `start` or an earlier `submitCode`
 * returned it, or as saved to disk). One call, never retried. On `done`,
 * `apiKey` and `handle` are set: save both. Throws a `TypeError` for a flow
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
 * code, message}` with the server's answer. Rejects only when there is no
 * answer (network, timeout, abort): then nothing is known about the key.
 */
export async function checkKey(apiKey: string, options: AccountCallOptions): Promise<CheckKeyResult> {
  const answer = await call(options, 'GET', '/v1/agents/me', undefined, apiKey)
  if (answer.error !== null) return { ok: false, code: answer.error.code, message: answer.error.message }
  const handle = isRecord(answer.body) ? text(answer.body.handle) : undefined
  if (handle === undefined) {
    return { ok: false, code: 'INVALID_RESPONSE', message: 'The server answered without a handle.' }
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

/**
 * The whole sign-up conversation, for an interactive setup. It follows
 * `next_step`: shows every server `message` (through `show`), asks only for
 * what the server names (`param`, or the code), and lets the person enter
 * the code, ask for a new code, or cancel. It never sends a new code unasked.
 * It waits out a `retry_after_s` of up to 60 s (the message says how long),
 * and stops on a longer one; after a yes to a new code it first waits out
 * the flow's `retry_after_s` (the time until one may be sent). No attempt
 * caps of its own: the server's are the only ones.
 *
 * Resolves `{outcome: 'done', apiKey, handle}` (save both),
 * `{outcome: 'cancelled'}`, or `{outcome: 'stopped', code, message}` (the
 * message has been shown). Rejects when the server cannot be reached, or
 * when `ask` / `show` / `sleep` throw.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const { kind, ask, show } = options
  if (STEPS[kind] === undefined) throw new TypeError(`integration.account.run: unknown kind ${JSON.stringify(kind)}`)
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

  const askOne = async (question: AccountQuestion): Promise<AccountAnswer> => {
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

  const required: Array<'email' | 'handle'> = kind === 'register' ? ['email', 'handle'] : ['email']
  for (const field of required) {
    if (typeof input[field] === 'string' && input[field].trim().length > 0) continue
    if (!(await askField(field, null))) return { outcome: 'cancelled' }
  }

  const startCall = (): Promise<StepResult> => {
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
  }
  let repeat: { step: 'start' | 'verify'; call: () => Promise<StepResult> } = { step: 'start', call: startCall }
  let result = await repeat.call()

  for (;;) {
    if (result.message.length > 0) await show(result.message)
    switch (result.action) {
      case 'done':
        return { outcome: 'done', apiKey: result.apiKey!, handle: result.handle! }

      case 'ask_code': {
        const flow = result.flow
        const answer = await askOne({ field: 'code', label: labels.code, answers: CODE_ANSWERS, flow })
        if (answer.answer === 'cancel') return { outcome: 'cancelled' }
        repeat =
          answer.answer === 'new_code'
            ? { step: 'start', call: startCall }
            : { step: 'verify', call: () => submitCode(flow, answer.value.trim(), callOptions) }
        break
      }

      case 'ask_param': {
        const param = result.flow.param
        const field = param === 'email' ? 'email' : param === 'handle' ? 'handle' : null
        if (field === null) return stopped(result)
        if (!(await askField(field, result.flow, result.handles))) return { outcome: 'cancelled' }
        repeat = { step: 'start', call: startCall }
        break
      }

      case 'offer_new_code': {
        if (!(await offerNewCode(result.flow))) return { outcome: 'cancelled' }
        repeat = { step: 'start', call: startCall }
        break
      }

      case 'wait_then_retry': {
        // Repeat the call that was turned away — unless that would send a
        // new code nobody asked for (the wait names a start step, but the
        // call was a code): then the person is asked first.
        if (repeat.step === 'verify' && isStartStep(result.flow.next_step)) {
          if (!(await offerNewCode(result.flow))) return { outcome: 'cancelled' }
          repeat = { step: 'start', call: startCall }
          break
        }
        await sleep(result.flow.retry_after_s! * 1000)
        break
      }

      default:
        return stopped(result)
    }
    result = await repeat.call()
  }

  /**
   * Ask before a new code; on a yes, sit out the flow's `retry_after_s`
   * first (the time until a new code may be sent), so the new code is not
   * turned away. A wait over the limit is left to the server's answer.
   */
  async function offerNewCode(flow: SignupFlow): Promise<boolean> {
    const answer = await askOne({ field: 'new_code', label: null, answers: NEW_CODE_ANSWERS, flow })
    if (answer.answer !== 'new_code') return false
    const wait = flow.retry_after_s
    if (wait !== undefined && wait > 0 && wait <= MAX_WAIT_S) await sleep(wait * 1000)
    return true
  }
}

function stopped(result: StepResult): RunResult {
  return { outcome: 'stopped', code: result.code ?? null, message: result.message }
}
