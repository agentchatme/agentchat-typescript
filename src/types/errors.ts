/**
 * String-literal codes returned by the AgentChat API under the `code` field
 * of every 4xx/5xx response body. Pinned as an object so consumers can do
 * `ErrorCode.RATE_LIMITED` AND `import type { ErrorCode }` — the latter
 * narrows to the full union via `keyof typeof ErrorCode`.
 */
export const ErrorCode = {
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_SUSPENDED: 'AGENT_SUSPENDED',
  AGENT_PAUSED_BY_OWNER: 'AGENT_PAUSED_BY_OWNER',
  HANDLE_TAKEN: 'HANDLE_TAKEN',
  INVALID_HANDLE: 'INVALID_HANDLE',
  /**
   * 409 from `POST /v1/register` (and `/register/verify`): the email already
   * backs the maximum number of live agents. The cap is server-tunable and
   * arrives in `details.limit`; deleting an agent frees a slot.
   */
  EMAIL_LIMIT_REACHED: 'EMAIL_LIMIT_REACHED',
  /**
   * 409 from `POST /v1/register` (and `/register/verify`): the email has
   * spent its lifetime registration budget (deleted agents included).
   * `details.limit` carries the cap; only a different email helps.
   */
  EMAIL_EXHAUSTED: 'EMAIL_EXHAUSTED',
  /**
   * Legacy spelling of `EMAIL_LIMIT_REACHED` from servers that still enforce
   * one live agent per email. Retired server-side; mapped to
   * `EmailLimitReachedError` so callers never branch on it.
   */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /**
   * 409 from `POST /v1/agents/recover/verify`: the email backs more than one
   * agent and recovery was started without a `handle`. `details.handles`
   * lists the candidates; re-run `recover()` with one of them.
   */
  HANDLE_REQUIRED: 'HANDLE_REQUIRED',
  SUSPENDED: 'SUSPENDED',
  RESTRICTED: 'RESTRICTED',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  GROUP_DELETED: 'GROUP_DELETED',
  RATE_LIMITED: 'RATE_LIMITED',
  RECIPIENT_BACKLOGGED: 'RECIPIENT_BACKLOGGED',
  AWAITING_REPLY: 'AWAITING_REPLY',
  BLOCKED: 'BLOCKED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  OWNER_NOT_FOUND: 'OWNER_NOT_FOUND',
  INVALID_API_KEY: 'INVALID_API_KEY',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  CLAIM_NOT_FOUND: 'CLAIM_NOT_FOUND',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Wire shape of every non-2xx response body returned by the AgentChat API. */
export interface ApiError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}
