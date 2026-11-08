import { describe, expect, it, vi } from 'vitest'
import {
  applyInviteOutcome,
  applyOutcome,
  inviteOutcome,
  turnOutcome,
  type TurnEnd,
} from '../../src/integration/outcome.js'
import type { InboxCard, InboxTray, TrayInvite } from '../../src/types/index.js'
import { json } from './fixtures.js'

// ─── conformance/v1/turn-outcome.cases.json ─────────────────────────────────

interface WireTurn {
  status: 'completed' | 'failed' | 'still_running'
  agentchat_calls: { made: number; failed: number } | null
}
interface Case {
  name: string
  why: string
  input: {
    turn: WireTurn
    turn_started_at: string
    gate_card: InboxCard
    category: string | null
    fresh_tray: InboxTray | null
    silent_before: number
  }
  expect: { action: string; reason: string; through_message_id?: string | null; category?: string | null }
}
interface InviteCase {
  name: string
  why: string
  input: { turn: WireTurn; invite: TrayInvite; fresh_tray: InboxTray | null; silent_before: number }
  expect: { action: string; reason: string; invite_id?: string }
}
interface Doc {
  rules: string[]
  cases: Case[]
  invite_cases: InviteCase[]
  single_run_invite_cases: Array<{ name: string }>
}

const doc = json<Doc>('turn-outcome.cases.json')

function turnOf(wire: WireTurn): TurnEnd {
  if (wire.status === 'still_running') return { status: 'still_running' }
  return { status: wire.status, agentchatCalls: wire.agentchat_calls }
}

describe('conformance — turn-outcome.cases.json', () => {
  it('has unique case names', () => {
    const names = [...doc.cases, ...doc.invite_cases, ...doc.single_run_invite_cases].map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(doc.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const outcome = turnOutcome({
      turn: turnOf(c.input.turn),
      turnStartedAt: c.input.turn_started_at,
      gateCard: c.input.gate_card,
      category: c.input.category,
      freshTray: c.input.fresh_tray,
      silentBefore: c.input.silent_before,
    })
    const wire: Record<string, unknown> = { action: outcome.action, reason: outcome.reason }
    if (outcome.action !== 'none') {
      wire.through_message_id = outcome.throughMessageId
      wire.category = outcome.category
    }
    expect(wire).toEqual(c.expect)
    expect(outcome.conversationId).toBe(c.input.gate_card.conversation_id)
  })

  it.each(doc.invite_cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const outcome = inviteOutcome({
      turn: turnOf(c.input.turn),
      invite: c.input.invite,
      freshTray: c.input.fresh_tray,
      silentBefore: c.input.silent_before,
    })
    const wire: Record<string, unknown> = { action: outcome.action, reason: outcome.reason }
    if (outcome.action !== 'none') wire.invite_id = outcome.inviteId
    expect(wire).toEqual(c.expect)
  })
})

describe('applyOutcome / applyInviteOutcome', () => {
  it('records reply and dismiss through the anchor; none makes no call', async () => {
    const record = vi.fn(async () => ({}) as never)
    const client = { decisions: { record } }
    expect(await applyOutcome(client, { action: 'none', reason: 'silent_first', conversationId: 'c1' })).toBe(false)
    expect(
      await applyOutcome(client, {
        action: 'record_reply',
        reason: 'answer_sent',
        conversationId: 'c1',
        throughMessageId: 'msg_1',
        category: 'open_request',
      }),
    ).toBe(true)
    expect(
      await applyOutcome(client, {
        action: 'record_dismiss',
        reason: 'silent_again',
        conversationId: 'c2',
        throughMessageId: null,
        category: 'no_action_needed',
      }),
    ).toBe(true)
    expect(
      await applyOutcome(client, {
        action: 'record_defer',
        reason: 'silent_again',
        conversationId: 'c3',
        throughMessageId: 'msg_3',
        category: null,
      }),
    ).toBe(true)
    expect(record.mock.calls).toEqual([
      ['c1', { decision: 'reply', category: 'open_request', throughMessageId: 'msg_1' }],
      ['c2', { decision: 'dismiss', category: 'no_action_needed' }],
      ['c3', { decision: 'defer', throughMessageId: 'msg_3' }],
    ])
  })

  it('dismisses an invite only when told to', async () => {
    const dismissInvite = vi.fn(async () => ({ dismissed: true }))
    const client = { groups: { dismissInvite } }
    expect(await applyInviteOutcome(client, { action: 'none', reason: 'silent_first', inviteId: 'i1' })).toBe(false)
    expect(await applyInviteOutcome(client, { action: 'dismiss_invite', reason: 'silent_again', inviteId: 'i1' })).toBe(true)
    expect(dismissInvite.mock.calls).toEqual([['i1']])
  })
})
