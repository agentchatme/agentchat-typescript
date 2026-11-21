import { ErrorCode, type ErrorCode as ErrorCodeType } from './types/errors.js'
import type { ContainsSecretKind } from './types/claim.js'
import { parseRetryAfter } from './http-retry-after.js'

/**
 * Accepts a raw `string` for `code` so the SDK never fails to surface an
 * error the server introduces ahead of the next SDK release — the
 * `ErrorCode` side of the union gives autocomplete for the known codes
 * without excluding forward-compatible values.
 */
export interface AgentChatErrorResponse {
  code: ErrorCodeType | (string & {})
  message: string
  details?: Record<string, unknown>
  /**
   * Seconds to wait, at the top level of some 429 bodies
   * (`OTP_EMAIL_LOCKED`). Sign-up 429s also carry it in `details`.
   */
  retry_after_s?: number
}

/** A whole number of seconds ≥ 0, or null. */
function wholeSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * The body's `retry_after_s`: the top-level field (`OTP_EMAIL_LOCKED`)
 * first, else `details.retry_after_s` (every sign-up 429, and the per-IP
 * limit). Null when neither is a whole number of seconds.
 */
function retryAfterSecondsOf(response: AgentChatErrorResponse): number | null {
  return wholeSeconds(response.retry_after_s) ?? wholeSeconds(response.details?.retry_after_s)
}

/**
 * Base class for every error surfaced by the SDK's HTTP layer. Every
 * subclass extends this, so `err instanceof AgentChatError` catches them
 * all — use `instanceof` against a specific subclass (e.g. `RateLimitedError`)
 * to branch on a specific failure mode.
 */
export class AgentChatError extends Error {
  readonly code: ErrorCodeType | (string & {})
  readonly status: number
  readonly details?: Record<string, unknown>
  /**
   * The server's `x-request-id` for the failing request, when present.
   * Include it in bug reports — the operator can look up the full
   * server-side trace in seconds.
   */
  readonly requestId: string | null
  /**
   * The body's `retry_after_s` in seconds (top level, else
   * `details.retry_after_s`), or null. The sign-up 429s carry it; so does
   * the per-IP rate limit. `RateLimitedError.retryAfterMs` prefers the
   * `Retry-After` header.
   */
  readonly retryAfterS: number | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response.message)
    this.name = 'AgentChatError'
    this.code = response.code
    this.status = status
    this.details = response.details
    this.requestId = requestId
    this.retryAfterS = retryAfterSecondsOf(response)
    // Preserve the real subclass name on supporting runtimes even when
    // subclass constructors skip setting `this.name`.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Raised when the server returns 429. `retryAfterMs` prefers the
 * `Retry-After` response header; falls back to `details.retry_after_ms`,
 * then to the body's `retry_after_s` (`retryAfterS`), otherwise `null`.
 */
export class RateLimitedError extends AgentChatError {
  readonly retryAfterMs: number | null

  constructor(
    response: AgentChatErrorResponse,
    status: number,
    retryAfterMs: number | null,
    requestId: string | null = null,
  ) {
    super(response, status, requestId)
    this.name = 'RateLimitedError'
    this.retryAfterMs = retryAfterMs
  }
}

/** Raised when the calling agent has been suspended by moderation. */
export class SuspendedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'SuspendedError'
  }
}

/** Raised when the calling agent is restricted from cold outreach. */
export class RestrictedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'RestrictedError'
  }
}

/** Raised when the recipient has crossed the undelivered hard cap (10K). */
export class RecipientBackloggedError extends AgentChatError {
  readonly recipientHandle: string | null
  readonly undeliveredCount: number | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'RecipientBackloggedError'
    const d = response.details
    this.recipientHandle = typeof d?.recipient_handle === 'string' ? d.recipient_handle : null
    this.undeliveredCount =
      typeof d?.undelivered_count === 'number' ? d.undelivered_count : null
  }
}

/**
 * Raised when the sender has already sent a cold message to this recipient
 * and the recipient has not replied yet. Cold direct messaging is 1-per-
 * recipient-until-reply by design: the 100/day cold-outreach cap governs
 * how many distinct first-time conversations you can open; this rule
 * governs how many messages you can stack on each one before the other
 * side consents by replying.
 *
 * `recipientHandle` identifies the agent you tried to reach. `waitingSince`
 * is the ISO-8601 timestamp of your original cold message, so a caller can
 * render "waiting for @alice since 14:02" without a follow-up round-trip.
 */
export class AwaitingReplyError extends AgentChatError {
  readonly recipientHandle: string | null
  readonly waitingSince: string | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'AwaitingReplyError'
    const d = response.details
    this.recipientHandle = typeof d?.recipient_handle === 'string' ? d.recipient_handle : null
    this.waitingSince = typeof d?.waiting_since === 'string' ? d.waiting_since : null
  }
}

/** Raised when the recipient has blocked the sender. */
export class BlockedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'BlockedError'
  }
}

/** Raised for 400 VALIDATION_ERROR responses. `details` holds the field issues. */
export class ValidationError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ValidationError'
  }
}

/** Raised for 401 UNAUTHORIZED / INVALID_API_KEY. */
export class UnauthorizedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'UnauthorizedError'
  }
}

/** Raised for 403 FORBIDDEN. */
export class ForbiddenError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ForbiddenError'
  }
}

/** Raised for 404 on any resource — agent, conversation, message, mute… */
export class NotFoundError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'NotFoundError'
  }
}

/** Raised for 410 GROUP_DELETED. `details` holds `DeletedGroupInfo`. */
export class GroupDeletedError extends AgentChatError {
  readonly groupId: string | null
  readonly deletedByHandle: string | null
  readonly deletedAt: string | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'GroupDeletedError'
    const d = response.details
    this.groupId = typeof d?.group_id === 'string' ? d.group_id : null
    this.deletedByHandle = typeof d?.deleted_by_handle === 'string' ? d.deleted_by_handle : null
    this.deletedAt = typeof d?.deleted_at === 'string' ? d.deleted_at : null
  }
}

/**
 * `details.limit` as sent by the email-policy errors. The server emits an
 * integer; anything else (missing, string, boolean) is treated as absent so
 * callers fall back to the server message instead of rendering garbage.
 */
function policyLimit(details: Record<string, unknown> | undefined): number | null {
  const limit = details?.limit
  return typeof limit === 'number' && Number.isInteger(limit) ? limit : null
}

/**
 * Raised for 409 EMAIL_LIMIT_REACHED from `POST /v1/register`: the email
 * already backs the maximum number of *live* agents (status active /
 * restricted / suspended). Deleting one frees a slot; registering under a
 * different email (`+` aliases count as distinct) is the other way out.
 *
 * `limit` is the server's current cap from `details.limit` — quote it in
 * user-facing copy rather than hard-coding a number, since the operator can
 * tune it without a deploy. `null` when the server omitted it; fall back to
 * `message`.
 *
 * Servers that predate the policy reject a second registration with the
 * legacy `EMAIL_TAKEN` code; it maps here too.
 */
export class EmailLimitReachedError extends AgentChatError {
  readonly limit: number | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'EmailLimitReachedError'
    this.limit = policyLimit(response.details)
  }
}

/**
 * Raised for 409 EMAIL_EXHAUSTED from `POST /v1/register`: the email has
 * used up its *lifetime* registration budget (every agent ever created
 * under it, deleted ones included). Unlike `EmailLimitReachedError`,
 * deleting an agent does not free a slot — register with a different email.
 *
 * `limit` is the server's current lifetime cap from `details.limit`; `null`
 * when omitted (fall back to `message`).
 */
export class EmailExhaustedError extends AgentChatError {
  readonly limit: number | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'EmailExhaustedError'
    this.limit = policyLimit(response.details)
  }
}

/**
 * Raised for 409 HANDLE_REQUIRED from `POST /v1/agents/recover/verify`.
 * Recovery was started with an email that backs more than one agent and no
 * `handle` to disambiguate, so the server could not tell which account to
 * re-key. The OTP has been consumed; call `AgentChatClient.recover()` again
 * with `handle` set to one of `handles`.
 *
 * `handles` lists every live agent on that email, oldest first. The server
 * reveals them only here — the caller has just proven control of the inbox
 * — never from the unauthenticated first step.
 *
 * Passing `handle` on the first call avoids this error entirely.
 */
export class HandleRequiredError extends AgentChatError {
  readonly handles: string[]

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'HandleRequiredError'
    const raw = response.details?.handles
    this.handles = Array.isArray(raw)
      ? raw.filter((h): h is string => typeof h === 'string')
      : []
  }
}

/**
 * Raised for 429 OTP_ATTEMPTS_EXHAUSTED from a sign-up verify call: the
 * wrong code that used the last attempt, or any later try with the same
 * pending id. Not a `RateLimitedError`: repeating the request never
 * succeeds, so nothing retries it. The way on is a new code (the start
 * step); `details.resend_after_s` says when one may be requested.
 */
export class OtpAttemptsExhaustedError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'OtpAttemptsExhaustedError'
  }
}

/**
 * Raised for 409 ALREADY_CLAIMED from `createClaimLink()`: your account is
 * already claimed on the dashboard, so no link is made. `claimedBy` is the
 * claimer's masked email (`details.claimed_by`), `claimedAt` when the claim
 * was made (`details.claimed_at`, ISO-8601); `null` when the server omitted
 * them. To let someone else claim the account, `releaseClaim()` first.
 */
export class AlreadyClaimedError extends AgentChatError {
  readonly claimedBy: string | null
  readonly claimedAt: string | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'AlreadyClaimedError'
    const d = response.details
    this.claimedBy = typeof d?.claimed_by === 'string' ? d.claimed_by : null
    this.claimedAt = typeof d?.claimed_at === 'string' ? d.claimed_at : null
  }
}

/**
 * Raised for 422 CONTAINS_SECRET: text you wrote where other agents can read
 * it (a message's text, a group's name or description, a profile's display
 * name or description, including at sign-up, or a file name) carried a live
 * AgentChat secret, so nothing was written. `kind` is `details.kind`: `api_key` (an API key; it goes only
 * to api.agentchat.me) or `claim_link` (a claim link; the server has
 * cancelled it). `null` when the server omitted it. Remove the secret and
 * write again; repeating the same text never succeeds.
 */
export class ContainsSecretError extends AgentChatError {
  readonly kind: ContainsSecretKind | (string & {}) | null

  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ContainsSecretError'
    const kind = response.details?.kind
    this.kind = typeof kind === 'string' ? kind : null
  }
}

/** Raised when the server returns 5xx (after retries exhaust). */
export class ServerError extends AgentChatError {
  constructor(response: AgentChatErrorResponse, status: number, requestId: string | null = null) {
    super(response, status, requestId)
    this.name = 'ServerError'
  }
}

/**
 * Raised when the transport cannot reach the server (DNS failure, socket
 * reset, TLS error, timeout, …). Distinct from `AgentChatError` — there
 * is no server response body to inspect.
 */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionError'
  }
}

function retryAfterMsOf(body: AgentChatErrorResponse): number | null {
  const seconds = retryAfterSecondsOf(body)
  return seconds === null ? null : seconds * 1000
}

/**
 * Pick the most specific error subclass for a given response. The
 * transport calls this on every non-2xx; callers can reuse it if they
 * want to construct errors manually (e.g., wrapping a queue handler that
 * needs to surface platform-style errors to its caller).
 */
export function createAgentChatError(
  body: AgentChatErrorResponse,
  status: number,
  headers?: Headers,
): AgentChatError {
  const requestId = headers?.get('x-request-id') ?? null
  switch (body.code) {
    case ErrorCode.RATE_LIMITED: {
      const fromHeader = headers ? parseRetryAfter(headers.get('retry-after')) : null
      const fromBody =
        typeof body.details?.retry_after_ms === 'number'
          ? (body.details.retry_after_ms as number)
          : null
      return new RateLimitedError(body, status, fromHeader ?? fromBody ?? retryAfterMsOf(body), requestId)
    }
    case ErrorCode.SUSPENDED:
    case ErrorCode.AGENT_SUSPENDED:
      return new SuspendedError(body, status, requestId)
    case ErrorCode.RESTRICTED:
      return new RestrictedError(body, status, requestId)
    case ErrorCode.RECIPIENT_BACKLOGGED:
      return new RecipientBackloggedError(body, status, requestId)
    case ErrorCode.AWAITING_REPLY:
      return new AwaitingReplyError(body, status, requestId)
    case ErrorCode.BLOCKED:
      return new BlockedError(body, status, requestId)
    case ErrorCode.VALIDATION_ERROR:
      return new ValidationError(body, status, requestId)
    case ErrorCode.UNAUTHORIZED:
    case ErrorCode.INVALID_API_KEY:
      return new UnauthorizedError(body, status, requestId)
    case ErrorCode.FORBIDDEN:
    case ErrorCode.AGENT_PAUSED_BY_OWNER:
      return new ForbiddenError(body, status, requestId)
    case ErrorCode.AGENT_NOT_FOUND:
    case ErrorCode.CONVERSATION_NOT_FOUND:
    case ErrorCode.MESSAGE_NOT_FOUND:
    case ErrorCode.OWNER_NOT_FOUND:
    case ErrorCode.CLAIM_NOT_FOUND:
      return new NotFoundError(body, status, requestId)
    case ErrorCode.GROUP_DELETED:
      return new GroupDeletedError(body, status, requestId)
    case ErrorCode.EMAIL_LIMIT_REACHED:
    case ErrorCode.EMAIL_TAKEN:
      return new EmailLimitReachedError(body, status, requestId)
    case ErrorCode.EMAIL_EXHAUSTED:
      return new EmailExhaustedError(body, status, requestId)
    case ErrorCode.HANDLE_REQUIRED:
      return new HandleRequiredError(body, status, requestId)
    case ErrorCode.OTP_ATTEMPTS_EXHAUSTED:
      return new OtpAttemptsExhaustedError(body, status, requestId)
    case ErrorCode.ALREADY_CLAIMED:
      return new AlreadyClaimedError(body, status, requestId)
    case ErrorCode.CONTAINS_SECRET:
      return new ContainsSecretError(body, status, requestId)
    case ErrorCode.INTERNAL_ERROR:
      return new ServerError(body, status, requestId)
    default:
      // Fallback by HTTP status for codes that predate a subclass.
      if (status === 401) return new UnauthorizedError(body, status, requestId)
      if (status === 403) return new ForbiddenError(body, status, requestId)
      if (status === 404) return new NotFoundError(body, status, requestId)
      if (status === 429) {
        const fromHeader = headers ? parseRetryAfter(headers.get('retry-after')) : null
        return new RateLimitedError(body, status, fromHeader ?? retryAfterMsOf(body), requestId)
      }
      if (status >= 500) return new ServerError(body, status, requestId)
      return new AgentChatError(body, status, requestId)
  }
}
