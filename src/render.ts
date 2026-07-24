import type { Message } from './types/message.js'

// ─── Canonical "render a message for a model" helper ────────────────────────
//
// The single, drift-proof way to turn a received message into the compact
// context block an LLM agent reads. Every AgentChat integration (Hermes,
// OpenClaw, the coding-agent daemon/hooks) surfaces the same facts; this is the
// reference so a NEW integration built on the raw SDK gets the rich path by
// default instead of re-inventing (and re-dropping fields).
//
// A stateless agent has no clock and no social memory, so the block states
// WHEN the message arrived, WHO sent it (resolved identity + kind), WHERE
// (DM vs group + the group's name), whether it @-mentioned you, and the body.
// Pass `selfHandle` to enable the mention line; omit it to suppress it.

export interface RenderOptions {
  /** This agent's handle; enables the "you were @-mentioned" line in groups. */
  selfHandle?: string
  /** Wall-clock override (epoch ms) for deterministic relative time in tests. */
  now?: number
}

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function relativeAge(ms: number): string {
  if (ms < 45 * SEC) return 'just now'
  if (ms < 90 * SEC) return '1 minute ago'
  if (ms < 45 * MIN) return `${Math.round(ms / MIN)} minutes ago`
  if (ms < 90 * MIN) return '1 hour ago'
  if (ms < 22 * HOUR) return `${Math.round(ms / HOUR)} hours ago`
  if (ms < 36 * HOUR) return '1 day ago'
  return `${Math.round(ms / DAY)} days ago`
}

/** "3 minutes ago (2026-07-24 14:57 UTC)", or just the absolute stamp when the
 *  value is unparseable. */
function formatReceived(createdAt: string, now: number): string {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return 'an unknown time'
  const iso = new Date(t).toISOString()
  const abs = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
  return `${relativeAge(Math.max(0, now - t))} (${abs})`
}

/**
 * Render a received message's trusted context + body into a model-facing block.
 * Degrades gracefully when the server sent no `context` (falls back to the bare
 * `sender` handle and omits identity/room lines it can't assert).
 */
export function renderMessageContext(
  message: Pick<Message, 'sender' | 'created_at' | 'content' | 'context'>,
  opts: RenderOptions = {},
): string {
  const now = opts.now ?? Date.now()
  const ctx = message.context
  const lines: string[] = []

  const handle = ctx?.sender.handle ?? message.sender
  const name = ctx?.sender.display_name
  const who = name ? `${name} (@${handle})` : `@${handle}`
  lines.push(`From: ${ctx?.sender.kind === 'system' ? `${who}, a system agent` : who}`)

  const conv = ctx?.conversation
  if (conv) {
    if (conv.type === 'group') {
      let label = conv.group_name ? `group "${conv.group_name}"` : 'group'
      if (conv.member_count != null) {
        label += ` (${conv.member_count} member${conv.member_count === 1 ? '' : 's'})`
      }
      lines.push(`Conversation: ${label}`)
    } else {
      lines.push('Conversation: direct message')
    }
  }

  lines.push(`Received: ${formatReceived(message.created_at, now)}`)

  const self = opts.selfHandle?.replace(/^@/, '').toLowerCase()
  if (self && conv?.type === 'group' && (ctx?.mentions ?? []).includes(self)) {
    lines.push('You were @-mentioned in this message.')
  }

  const text = message.content?.text
  lines.push('', text ? text : `(a ${'non-text'} message — no text body)`)
  return lines.join('\n')
}
