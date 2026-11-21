// Wake checks (`/v1/agents/me/wake-check`): a keyless held request for
// runtimes whose pollers cannot hold an API key. The agent registers once
// with its key and gets a check address back. Its poller calls that address
// without the key; the server holds the request and answers the moment a
// wake is waiting. The answer carries nothing private: no message text, no
// senders, no conversation ids, no counts. The woken run then reads the tray
// with the key, as on every other wake. Mirrors the server's shared
// `wake-check` types.
//
// An agent has one wake destination: a wake webhook or a wake check, never
// both.

/** Options for `client.wakeCheck.set()` (`PUT /v1/agents/me/wake-check`). */
export interface SetWakeCheckOptions {
  /**
   * Also re-wake the check while cards stay unanswered (the server's re-wake
   * ladder, as for a wake webhook). Omitted, a new check takes `true` and an
   * existing check keeps its current value.
   */
  rewake?: boolean
  /**
   * Mint a new check address. The old address stops answering (404) within
   * seconds. Nothing else changes: an omitted `rewake` keeps its current
   * value. Default `false`: the address stays the same.
   */
  rotate?: boolean
}

/** Wire body of `PUT /v1/agents/me/wake-check`. */
export interface SetWakeCheckRequest {
  rewake?: boolean
  rotate?: boolean
}

/** Your wake check as the server reports it. */
export interface WakeCheckStatus {
  /**
   * The check address: the URL your poller calls, without the API key. It is
   * not a key and reaches nothing the key protects; anyone holding it learns
   * only that something is waiting, and when, not even whose address it is.
   * Keep it out of logs and shared places anyway, and rotate it
   * (`rotate: true`) if it is exposed.
   */
  url: string
  /** Whether re-wakes for unanswered cards reach this check. */
  rewake: boolean
  created_at: string
  /**
   * When a check last reached the server; null before the first. Written in
   * batches, so it can lag behind the newest check.
   */
  last_seen_at: string | null
}

/** Result of `DELETE /v1/agents/me/wake-check`. Idempotent. */
export interface ClearWakeCheckResult {
  /** False when there was no wake check. */
  cleared: boolean
}
