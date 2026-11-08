/**
 * Connect budget (contract v1, D8). Over its per-agent connect budget the
 * server answers the WebSocket upgrade with HTTP 429 and `Retry-After`, or
 * closes the socket with 1013 ("try again later") and a retry hint in the
 * close reason after the HELLO (`rate_limited; retry_after=<seconds>`).
 * Either way the client backs off for the server's delay; it never goes
 * `blocked`. A 1013 without the hint (the slow-consumer `overload` close)
 * keeps the ordinary backoff. Conformance: `connect-budget.cases.json`.
 */

import { parseRetryAfter } from './http-retry-after.js'

/** Close code the server uses when the connect budget is spent. */
export const CONNECT_BUDGET_CLOSE_CODE = 1013
/** Delay for a 429 that gave no usable Retry-After (the budget's shortest window is a minute). */
export const CONNECT_BUDGET_DEFAULT_DELAY_MS = 60_000
export const CONNECT_BUDGET_MIN_DELAY_MS = 1_000
export const CONNECT_BUDGET_MAX_DELAY_MS = 3_600_000

export type ConnectBudgetEvent =
  | { readonly kind: 'close'; readonly code: number; readonly reason: string }
  | {
      readonly kind: 'upgrade'
      readonly status: number
      /** The `Retry-After` header as received, or null. */
      readonly retryAfter: string | null
      /** Epoch ms an HTTP-date `Retry-After` is measured from. Default: now. */
      readonly now?: number
    }

const HINT_RE = /retry[_-]after(?:\s*[=:]\s*|\s+)(\d+)/i

/**
 * How long to wait before the next attempt when the server said "over
 * budget", in ms; null when the event is not a budget answer (the ordinary
 * reconnect backoff applies). Pure.
 */
export function connectBudgetDelayMs(event: ConnectBudgetEvent): number | null {
  let ms: number | null
  if (event.kind === 'close') {
    if (event.code !== CONNECT_BUDGET_CLOSE_CODE) return null
    // Only a 1013 that carries the hint is a budget answer. The server also
    // closes a slow consumer with 1013 "overload", which has always taken the
    // ordinary reconnect backoff and still does.
    const match = HINT_RE.exec(typeof event.reason === 'string' ? event.reason : '')
    if (match?.[1] === undefined) return null
    ms = Number(match[1]) * 1000
  } else {
    if (event.status !== 429) return null
    ms = parseRetryAfter(event.retryAfter, event.now)
  }
  if (ms === null || !Number.isFinite(ms)) ms = CONNECT_BUDGET_DEFAULT_DELAY_MS
  return Math.min(CONNECT_BUDGET_MAX_DELAY_MS, Math.max(CONNECT_BUDGET_MIN_DELAY_MS, Math.round(ms)))
}
