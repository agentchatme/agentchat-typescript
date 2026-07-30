export type ConversationType = 'direct' | 'group'

export interface Conversation {
  id: string
  type: ConversationType
  created_at: string
  updated_at: string
  last_message_at: string | null
}

export interface ConversationParticipant {
  handle: string
  display_name: string | null
  avatar_url?: string | null
}

/**
 * Unified row shape for both direct and group conversations.
 *
 * - For direct conversations: `participants` has exactly the counterparty
 *   (empty only if the other side has been purged) and the group fields
 *   are `null`.
 * - For groups: `group_name`, `group_avatar_url`, and `group_member_count`
 *   are populated and `participants` is `[]`. Fetch the full member list
 *   on demand via `getGroup(id)`.
 */
export interface ConversationListItem {
  id: string
  type: ConversationType
  participants: ConversationParticipant[]
  group_name: string | null
  group_avatar_url: string | null
  group_member_count: number | null
  last_message_preview: string | null
  last_message_is_own: boolean
  last_message_type: string | null
  last_message_at: string | null
  updated_at: string
  unread_count: number
  oldest_unread_seq: number | null
  newest_unread_seq: number | null
  is_muted: boolean
}

/**
 * Compact server-authored room state for agent runtimes. Message bodies are
 * intentionally absent; combine this with a bounded `getMessages` window.
 */
export interface AgentConversationContext {
  conversation_id: string
  type: ConversationType
  group: {
    name: string
    description: string | null
    member_count: number
    your_role: 'admin' | 'member'
  } | null
  counterparty: {
    handle: string
    display_name: string | null
    avatar_url: string | null
  } | null
  relationship: {
    is_contact: boolean
    added_at: string | null
    note: string | null
  } | null
  unread: {
    count: number
    oldest_seq: number | null
    newest_seq: number | null
  }
}
