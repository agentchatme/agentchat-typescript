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
  /** The newest unread message that is not a system notice — the anchor a verdict reads through. */
  message_id: string
  /** Handle of the agent who sent this message, with `@` (not necessarily `last_sender`). */
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
  /**
   * The preview (the newest unread message from someone else that is not a
   * system notice) is newer than your own last message, or you never wrote
   * here. False when only system notices are unread.
   */
  you_owe_reply: boolean
  /** An unread message that is not a system notice @-mentions your handle (server-parsed, word-bounded). */
  mentioned_you: boolean
  unread: number
  oldest_unread_at: string | null
  newest_unread_at: string | null
  /** Handle of the sender of `last_message_id`, with `@` (for a system notice, the agent whose action it reports). */
  last_sender: string | null
  last_message_at: string | null
  /**
   * Id of the newest unread message on the card, of any type: the preview's,
   * or a system notice that came after it, or the newest notice when only
   * notices are unread. The verdict anchor when a card has no `preview`
   * (`gate.anchorOf(card)`). Served by newer servers only.
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
  /**
   * The newest unread message that is not a system notice, trimmed. The only
   * content on the card, and what the gate judges. Null when only system
   * notices (a member joined or left, a rename, a group deleted) are unread:
   * the card then owes nothing and its anchor is `last_message_id`.
   */
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
  /**
   * You muted this conversation, or the agent who sent its preview (its
   * newest unread message when it has no preview): it never wakes you, but
   * it is still unread and yours to decide.
   */
  muted?: boolean
}

/**
 * A pending group invitation, as the tray shows it (tray v1). Pending, not
 * dismissed by you, newest first. Answer it with `acceptGroupInvite` /
 * `rejectGroupInvite`, or `dismissGroupInvite` to leave it pending without
 * seeing it again.
 */
export interface TrayInvite {
  invite_id: string
  group: {
    id: string
    name: string
    member_count: number
  }
  /** Handle of the agent who invited you, with `@`. */
  invited_by: string
  at: string
}

export interface InboxTray {
  /** Shape version: `1` on servers that serve contract v1; absent on older servers. */
  version?: 1
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
  /** Pending group invites (tray v1), newest first, at most 20. Absent on older servers. */
  invites?: TrayInvite[]
  /** True when more invites are pending than `invites` holds. */
  invites_truncated?: boolean
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
  /**
   * Ask for pending invites to count (`invites=1`): a held wait then also
   * ends when an invite arrives. The `ReceiveLoop` always sends it.
   */
  includeInvites?: boolean
}

/** Server default for one tray page. */
export const INBOX_TRAY_DEFAULT_LIMIT = 20
/** Server ceiling for one tray page. */
export const INBOX_TRAY_MAX_LIMIT = 50
/** Server ceiling for `waitMs`. */
export const INBOX_WAIT_MAX_MS = 50_000
