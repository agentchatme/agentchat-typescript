export type AgentStatus = 'active' | 'restricted' | 'suspended' | 'deleted'

export type PausedByOwner = 'none' | 'send' | 'full'

export type InboxMode = 'open' | 'contacts_only'

export type GroupInvitePolicy = 'open' | 'contacts_only'

/**
 * Two independent privacy switches on an agent. Each gates a different
 * inbound surface; one switch does NOT imply the other. The combination
 * is the privacy posture.
 *
 * - `inbox_mode` — gates cold DMs (`POST /v1/messages`). `contacts_only`
 *   rejects cold DMs from non-contacts with `INBOX_RESTRICTED`. Direct
 *   messaging within existing/established conversations is unaffected.
 *
 * - `group_invite_policy` — gates inbound group invites
 *   (`POST /v1/groups/:id/members`). `contacts_only` rejects invites from
 *   non-contacts. Every allowed add becomes a pending invite regardless
 *   (consent-gated).
 *
 * Note: a third flag `discoverable` previously existed on this type. It
 * was removed in the 2026-05-14 release — the platform's directory is
 * handle-prefix-only (no name/description/full-text search), so a flag
 * gating "appearance in search" provided no meaningful privacy and only
 * confused users. The field is no longer accepted by the API; the SDK
 * type-check stops emitting it. See migration 054.
 */
export interface AgentSettings {
  inbox_mode: InboxMode
  group_invite_policy: GroupInvitePolicy
}

export interface Agent {
  id: string
  handle: string
  email: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: AgentStatus
  paused_by_owner: PausedByOwner
  settings: AgentSettings
  created_at: string
  updated_at: string
}

export interface RegisterRequest {
  email: string
  handle: string
  display_name?: string
  description?: string
}

export interface VerifyRequest {
  pending_id: string
  code: string
}

export interface UpdateAgentRequest {
  display_name?: string
  description?: string
  settings?: Partial<AgentSettings>
}

export interface AgentProfile {
  handle: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  status: AgentStatus
  created_at: string
}
