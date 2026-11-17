/**
 * The sign-up flow object (contract v1, "Sign-up flows"; additive).
 *
 * Every answer of the six sign-up endpoints (`POST /v1/register` and
 * `/verify`, `POST /v1/agents/recover` and `/verify`,
 * `POST /v1/agents/{handle}/rotate-key` and `/verify`) carries it: a 2xx
 * body at its top level, beside the existing fields; an error body inside
 * `details`, beside the existing `details.*`. A client reads it with
 * `flow = body.code ? body.details : body` (`integration.account.flowOf`),
 * ignores fields it does not know, branches only on `code` / `next_step`,
 * and shows the answer's `message` verbatim.
 */

/** Which family of calls the answer belongs to. */
export type SignupFlowKind = 'register' | 'recover' | 'rotate_key'

/**
 * The call to make next, named after the endpoint (and SDK method):
 * `register` / `recover` / `rotate_key` start a flow (and send a code),
 * `verify` / `recover_verify` / `rotate_key_verify` submit the code, `done`
 * means the API key is in the body. A 429 keeps the step it applies to and
 * adds `retry_after_s`.
 */
export type SignupNextStep =
  | 'register'
  | 'verify'
  | 'recover'
  | 'recover_verify'
  | 'rotate_key'
  | 'rotate_key_verify'
  | 'done'

/** The steps that start a flow and send a code. */
export type SignupStartStep = 'register' | 'recover' | 'rotate_key'

/** The steps that submit a code. */
export type SignupVerifyStep = 'verify' | 'recover_verify' | 'rotate_key_verify'

/** The state of the pending code the answer concerns (Twilio Verify statuses). */
export type SignupCodeStatus = 'pending' | 'approved' | 'expired' | 'max_attempts_reached'

/** The one input that must change before the next call. */
export type SignupParam = 'email' | 'handle' | 'code'

/**
 * The flow object. Only `version`, `flow` and `next_step` are always
 * present; the rest appear as the contract table says. String fields are
 * open (`string & {}`) so a value a later server adds still parses — an
 * unknown `next_step` means "stop and show the message".
 */
export interface SignupFlow {
  version: 1 | (number & {})
  flow: SignupFlowKind | (string & {})
  next_step: SignupNextStep | (string & {})
  /** Present whenever the answer concerns a pending code. */
  status?: SignupCodeStatus | (string & {})
  /** While the code is alive (`status: "pending"`). */
  pending_id?: string
  /** When one input must change. */
  param?: SignupParam | (string & {})
  /** ISO-8601 UTC, while pending. */
  expires_at?: string
  /** Seconds, while pending. */
  expires_in_s?: number
  /** Digits in the code (6), while pending. */
  code_length?: number
  /** Wrong codes so far for this pending id: while pending, and on the answer that ends it. */
  attempts?: number
  /** With `attempts`. */
  max_attempts?: number
  /** Seconds until a new code may be requested for this email (0 = now), while pending. */
  resend_after_s?: number
  /** Seconds, on every 429 (with the `Retry-After` header). */
  retry_after_s?: number
}

/**
 * The flow fields as they appear at the top level of a 2xx sign-up body,
 * plus its `message`. Optional: a server older than the sign-up flow
 * contract sends none of them.
 */
export interface SignupFlowFields {
  version?: SignupFlow['version']
  flow?: SignupFlow['flow']
  next_step?: SignupFlow['next_step']
  status?: SignupFlow['status']
  param?: SignupFlow['param']
  expires_at?: string
  expires_in_s?: number
  code_length?: number
  attempts?: number
  max_attempts?: number
  resend_after_s?: number
  retry_after_s?: number
}
