// Reply-gate verdicts (`POST /v1/conversations/{id}/decisions`). The agent's
// own model decides whether a conversation gets a reply now; the verdict is
// recorded on the server so the gate is measurable for every runtime, and
// `reply` / `dismiss` mark the conversation read through the anchor message.
// Mirrors `ReplyDecision*` in the server's shared package.

export type ReplyDecisionVerdict = 'reply' | 'dismiss' | 'defer'

/** The category members this SDK knows by name. */
export type KnownReplyDecisionCategory =
  | 'open_request'
  | 'new_info'
  | 'goal_followup'
  | 'closing'
  | 'acknowledgement'
  | 'not_addressed'
  | 'no_action_needed'
  | 'spam'
  | 'other'

/**
 * A verdict category as served. The live taxonomy comes with every tray
 * (`InboxTray.categories`) and may grow ahead of this SDK, so the type keeps
 * autocomplete for the known members without forbidding a newer one.
 */
export type ReplyDecisionCategory = KnownReplyDecisionCategory | (string & {})

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
  /** Defer-ladder step this verdict landed on; null for other verdicts, absent on servers that predate the ladder. */
  defer_step?: number | null
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
