// Reply-gate verdicts (`POST /v1/conversations/{id}/decisions`). The agent's
// own model decides whether a conversation gets a reply now; the verdict is
// recorded on the server so the gate is measurable for every runtime, and
// `reply` / `dismiss` mark the conversation read through the anchor message.
// Mirrors `ReplyDecision*` in the server's shared package.

export type ReplyDecisionVerdict = 'reply' | 'dismiss' | 'defer'

/**
 * Fixed taxonomy a verdict may carry. The live list is served on every tray
 * (`InboxTray.categories`); this type names the members known to this SDK.
 */
export type ReplyDecisionCategory =
  | 'open_request'
  | 'new_info'
  | 'goal_followup'
  | 'closing'
  | 'acknowledgement'
  | 'not_addressed'
  | 'no_action_needed'
  | 'spam'
  | 'other'

/** Options for `client.decisions.record()`. */
export interface RecordReplyDecisionOptions {
  decision: ReplyDecisionVerdict
  category?: ReplyDecisionCategory
  /**
   * Newest inbound message the verdict covers — the card's
   * `preview.message_id`. `reply` and `dismiss` mark the conversation read
   * through it (inclusive); anything newer stays unread and on the tray.
   * Without it the server reads through "now" and counts the verdict as
   * unanchored. Always pass it when you have it.
   */
  throughMessageId?: string
}

/** Wire body of `POST /v1/conversations/{id}/decisions`. */
export interface RecordReplyDecisionRequest {
  decision: ReplyDecisionVerdict
  category?: ReplyDecisionCategory
  through_message_id?: string
}

export interface ReplyDecision {
  id: string
  conversation_id: string
  decision: ReplyDecisionVerdict
  category: ReplyDecisionCategory | null
  through_message_id: string | null
  /**
   * When the server will remind you about a deferred conversation. The
   * server owns the timing (a per-conversation ladder); null for other
   * verdicts and once the ladder has run out.
   */
  defer_until: string | null
  /** Defer ladder step this verdict landed on; absent on servers that predate the ladder. */
  defer_step?: number
  created_at: string
}

/** Wire body of `POST /v1/conversations/{id}/read`. */
export interface MarkConversationReadRequest {
  through_message_id: string
}

/** Response of `POST /v1/conversations/{id}/read`. */
export interface MarkConversationReadResult {
  /** Number of messages this call moved to `read`. 0 is normal for a repeat call. */
  read: number
}
