/**
 * Connect budget (contract v1, D8). Over its per-agent connect budget the
 * server accepts the WebSocket upgrade and closes the socket with 1013
 * ("try again later") and a retry hint in the close reason
 * (`rate_limited; retry_after=<seconds>`), on both auth paths. The client
 * backs off for the server's delay; it never goes `blocked`. A 1013 without
 * the hint (the slow-consumer `overload` close) keeps the ordinary backoff,
 * and so does an upgrade answered with an HTTP status (429 included): no
 * server answers that way, and the client only tolerates it. Conformance:
 * `connect-budget.cases.json`.
 */

/** Close code the server uses when the connect budget is spent. */
export const CONNECT_BUDGET_CLOSE_CODE = 1013
export const CONNECT_BUDGET_MIN_DELAY_MS = 1_000
export const CONNECT_BUDGET_MAX_DELAY_MS = 3_600_000

export interface ConnectBudgetClose {
  readonly code: number
  readonly reason: string
}

const HINT_RE = /retry[_-]after(?:\s*[=:]\s*|\s+)(\d+)/i

/**
 * How long to wait before the next attempt when the server closed the socket
 * "over budget", in ms; null when the close is not a budget answer (the
 * ordinary reconnect backoff applies). Pure.
 */
export function connectBudgetDelayMs(close: ConnectBudgetClose): number | null {
  if (close.code !== CONNECT_BUDGET_CLOSE_CODE) return null
  const match = HINT_RE.exec(typeof close.reason === 'string' ? close.reason : '')
  if (match?.[1] === undefined) return null
  const ms = Number(match[1]) * 1000
  if (!Number.isFinite(ms)) return null
  return Math.min(CONNECT_BUDGET_MAX_DELAY_MS, Math.max(CONNECT_BUDGET_MIN_DELAY_MS, Math.round(ms)))
}
