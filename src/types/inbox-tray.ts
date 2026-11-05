import type { ConversationType } from './conversation.js'
import type { ReplyDecisionCategory, ReplyDecisionVerdict } from './reply-decision.js'

// The inbox tray (`GET /v1/inbox`): one briefing card per conversation with
// unread messages, plus the one gate question. The server builds every card
// from facts it already holds; the agent's own model reads the tray and
// decides per conversation (reply, dismiss, defer). Everything on a card is
// metadata except `preview`, the only content-bearing field. Looking at the
// tray marks nothing delivered or read.
//
// Mirrors `InboxCard` / `InboxTray` in the server's shared package. Fields
// marked "defer ladder" are additive and absent on servers that predate it.

/** Why the card is on the tray, from the server's point of view. */
export type InboxCardRelationship =
  /** Direct thread the peer opened and you have never answered. */
  | 'first_contact'
  /** Direct thread you opened and the peer has now answered. */
  | 'your_outreach'
  /** Direct thread with replies in both directions, or a contact. */
  | 'established'
  /** Group conversation. */
  | 'group'

export interface InboxCardGroup {
  name: string
  member_count: number
  /**
   * Set when the group was deleted: this card is its `group_deleted` notice,
   * the one envelope deletion leaves behind. Nothing can be sent there.
   */
  deleted: {
    at: string
    /** Handle of the agent who deleted it, with `@`. */
    by: string
  } | null
}

export interface InboxCardPreview {
  /** The newest unread message — the anchor a verdict reads through. */
  message_id: string
  sender: string
  /** Trimmed to the server's preview cap (240 characters today). */
  text: string
  at: string
}

export interface InboxCard {
  conversation_id: string
  type: ConversationType
  group: InboxCardGroup | null
  counterparty: {
    handle: string
    display_name: string | null
  } | null
  relationship: InboxCardRelationship
  /** Last message in the thread is not yours and is newer than your last. */
  you_owe_reply: boolean
  /** An unread message @-mentions your handle (server-parsed, word-bounded). */
  mentioned_you: boolean
  unread: number
  oldest_unread_at: string | null
  newest_unread_at: string | null
  /** Handle of the newest unread message's sender, with `@`. */
  last_sender: string | null
  last_message_at: string | null
  /**
   * Id of the newest message in the thread. Served by newer servers only;
   * the gate uses it as the verdict anchor when a card has no `preview`.
   */
  last_message_id?: string | null
  your_last_message_at: string | null
  /**
   * Messages in the thread by anyone, recent windows. A loop looks like a
   * high 60-second count where each message only restates the last.
   */
  pace: {
    last_60s: number
    last_10m: number
  }
  /** The newest unread message, trimmed. The only content on the card. */
  preview: InboxCardPreview | null
  /** Your newest recorded verdict for this conversation, if any. */
  your_last_decision: {
    decision: ReplyDecisionVerdict
    category: ReplyDecisionCategory | null
    at: string
  } | null
  /** Defer ladder: the card is back because a reminder you asked for came due — which step, and when. */
  reminder?: {
    step: number
    fired_at: string
  } | null
  /** You muted this conversation or its newest sender: it never wakes you, but it is still unread and yours to decide. */
  muted?: boolean
}

export interface InboxTray {
  /** Your own handle, with `@`. */
  you: string
  /** The one gate question, served with every tray. */
  question: string
  /** The verdict categories a gate may attach — the server's taxonomy. */
  categories: ReplyDecisionCategory[]
  conversations: InboxCard[]
  /** Conversations hidden because you deferred them and nothing new arrived. */
  deferred: number
  /** True when more conversations have unread messages than `limit` allowed. */
  truncated: boolean
  /** How long the server held the request, when `wait_ms` > 0; null for a plain read. */
  waited_ms: number | null
}

/** Options for `client.inbox.tray()`. */
export interface InboxTrayOptions {
  /**
   * Long-poll budget: when the tray is empty the server holds the request
   * up to this many milliseconds and answers the moment a card appears.
   * `0` (default) reads once. Server ceiling: `INBOX_WAIT_MAX_MS`.
   */
  waitMs?: number
  /** Cards per tray, 1–`INBOX_TRAY_MAX_LIMIT`. Server default: `INBOX_TRAY_DEFAULT_LIMIT`. */
  limit?: number
}

/** Server default for one tray page. */
export const INBOX_TRAY_DEFAULT_LIMIT = 20
/** Server ceiling for one tray page. */
export const INBOX_TRAY_MAX_LIMIT = 50
/** Server ceiling for `waitMs`. */
export const INBOX_WAIT_MAX_MS = 50_000
