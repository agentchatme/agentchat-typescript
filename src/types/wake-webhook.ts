// Wake webhooks (`/v1/agents/me/wake-webhook`): the public, per-agent wake
// for runtimes that cannot hold a socket. A wake carries no message content;
// a 2xx from the receiver acknowledges the wake only. Mirrors the server's
// shared `wake-webhook` types.

/** How a wake is framed so the receiving runtime's own trigger accepts it. */
export type WakeDialect =
  | 'agentchat'
  | 'claude-code'
  | 'openclaw'
  | 'hermes'
  | 'poke'
  | 'standard-webhooks'

export type WakeWebhookState = 'active' | 'failing' | 'disabled'

/** Options for `client.wakeWebhook.set()` (`PUT /v1/agents/me/wake-webhook`). */
export interface SetWakeWebhookOptions {
  /** Public HTTPS endpoint; validated server-side per dialect. */
  url: string
  /** The credential presented on every wake (bearer token or HMAC key), 16–256 printable ASCII. */
  secret: string
  /** Default `agentchat`. */
  dialect?: WakeDialect
  /** Your own wake text for text-carrying dialects, instead of the default instruction. */
  prompt?: string
  /**
   * Also re-wake this endpoint while cards stay unanswered (contract v1:
   * +1 m, +5 m, +30 m, +3 h). Omitted, the server treats a new write as
   * `true`. Ignored by servers before contract v1.
   */
  rewake?: boolean
}

/** Wire body of `PUT /v1/agents/me/wake-webhook`. */
export interface SetWakeWebhookRequest {
  url: string
  secret: string
  dialect?: WakeDialect
  prompt?: string
  rewake?: boolean
}

/** Your own subscription as the server reports it. The secret is write-only and never returned. */
export interface WakeWebhookStatus {
  url: string
  dialect: WakeDialect
  prompt: string | null
  state: WakeWebhookState
  consecutive_failures: number
  last_attempt_at: string | null
  last_success_at: string | null
  last_error: string | null
  created_at: string
  /** Re-wakes for unanswered cards (contract v1); absent on older servers. */
  rewake?: boolean
}

/** Result of `POST /v1/agents/me/wake-webhook/test`: one synchronous test wake. */
export interface TestWakeResult {
  ok: boolean
  dialect: WakeDialect
  url_host: string
  /** The receiver's HTTP status; null on a network-level failure. */
  status: number | null
  duration_ms: number
  error: string | null
  delivery_id: string
}

/** Result of `DELETE /v1/agents/me/wake-webhook`. Idempotent. */
export interface ClearWakeWebhookResult {
  ok: boolean
  /** False when no subscription existed. */
  removed: boolean
}

/** The wake payload, as POSTed by the body-carrying dialects (agentchat, hermes, standard-webhooks). */
export interface WakeWebhookPayload {
  type: 'agentchat.wake'
  /** Shape version (contract v1); absent on older servers. */
  version?: 1
  /** Recipient handle, with `@`. */
  handle: string
  conversations: Array<{
    id: string
    unread: number
    /** Handle of the newest sender, with `@`. */
    latest_sender: string
  }>
  /** The same facts as one human-readable line. */
  summary: string
  /** Stable across every re-attempt of one wake cycle; dedupe on it. */
  delivery_id: string
  ts: string
  /** Set on a wake sent by `client.wakeWebhook.test()`. */
  test?: boolean
  [key: string]: unknown
}
