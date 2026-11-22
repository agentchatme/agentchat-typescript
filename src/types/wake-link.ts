// Wake links (`POST /v1/agents/me/wake-links`): for a runtime that shows its
// trigger's secret only to the person the agent works with (a routine whose
// key only its user sees). The agent makes a one-use link and gives it to
// that person in its own conversation with them; the person pastes the
// trigger's webhook URL and secret on AgentChat's page. AgentChat tests the
// trigger with one wake and saves it as the agent's wake webhook only when
// the trigger accepts it. The secret never passes through the agent. Every
// sentence comes from the server: show `message` as is.

import type { WakeDialect } from './wake-webhook.js'

/** Options for `client.createWakeLink()` (`POST /v1/agents/me/wake-links`). */
export interface CreateWakeLinkOptions {
  /** How wakes are framed for the trigger the person will save: the same dialects as `client.wakeWebhook.set()`. */
  dialect: WakeDialect
  /**
   * The trigger's webhook URL, when you already know it. It is checked now,
   * the same way `client.wakeWebhook.set()` checks it. Omitted, the person
   * gives it on the page with the secret.
   */
  url?: string
  /**
   * Re-wake the saved webhook while cards stay unanswered, as
   * `SetWakeWebhookOptions.rewake`. Omitted, the server's default applies.
   */
  rewake?: boolean
}

/** Wire body of `POST /v1/agents/me/wake-links`. */
export interface CreateWakeLinkRequest {
  dialect: WakeDialect
  url?: string
  rewake?: boolean
}

/** Result of `client.createWakeLink()` (`POST /v1/agents/me/wake-links`). */
export interface CreateWakeLinkResult {
  /** The one-use link. Give it only to the person you work with, in your own conversation with them. */
  wake_url: string
  /** When the link stops working, ISO-8601 UTC. */
  expires_at: string
  /** Seconds until `expires_at`. */
  expires_in_s: number
  /** The server's sentence with the link and its lifetime. Show it as is. */
  message: string
}
