/**
 * What the host records after a gate-call turn (contract v1, D5).
 *
 * In gate-call mode the gate call records `dismiss` / `defer` at once and
 * starts one turn per `reply`. After that turn the host records from what
 * actually happened, read on a fresh tray, never from the runtime's "turn
 * ok":
 *
 * | After the turn                                        | Host does                              |
 * |-------------------------------------------------------|----------------------------------------|
 * | runtime has not confirmed the end                      | nothing; the turn keeps its card          |
 * | runtime reports failure                                | the card rules below that need no look (gone, own verdict, answer sent); otherwise nothing, the card stays (server re-wakes) |
 * | the turn recorded its own verdict (card gone, or `your_last_decision` moved) | nothing |
 * | the card shows the answer went out                    | `reply` through the anchor the gate saw |
 * | 0 AgentChat calls, or all failed (when countable)     | nothing (it could not look)            |
 * | it looked, sent nothing, recorded nothing             | 1st time nothing; 2nd time for the same anchor `dismiss` (`no_action_needed`) when its AgentChat calls are known and all succeeded, else `defer` |
 *
 * `turnOutcome` is the pure decision (conformance `turn-outcome.cases.json`);
 * `applyOutcome` makes the one recording call. Invites follow the same rule
 * (`inviteOutcome` / `applyInviteOutcome`): an invite still pending after two
 * turns that looked is dismissed — seen, left pending, not shown again.
 *
 * Where the copies this replaces differed: OpenClaw recorded `reply` on any
 * turn whose run ended `ok`, Hermes on any completed turn (zero AgentChat
 * calls counted as success); both recorded `reply` when the post-turn tray
 * read failed. Here a failed read records nothing (the server's re-wake
 * covers it), "answer went out" is read from `your_last_message_at` moving
 * (clock-free, and true even when the peer has written again since), and a
 * verdict the turn recorded is recognised by `your_last_decision` changing
 * against the card the gate saw (clock-free, as both copies did; no local
 * clock is compared with a server time).
 */

import type { InboxCard, InboxTray, ReplyDecisionCategory, TrayInvite } from '../types/index.js'
import type { AgentChatClient } from '../client.js'
import { anchorOf, cardsOf } from '../gate.js'

/**
 * How many AgentChat calls a turn made, when the runtime can tell. `null`
 * (unknown) is treated as "it looked".
 */
export interface AgentChatCallCount {
  made: number
  failed: number
}

/**
 * What the runtime reports about a turn. A wait that timed out is not an
 * end: report `still_running` (with `next` when the runtime can say when it
 * really ends) and the turn keeps its conversation.
 */
export type TurnEnd =
  | { status: 'completed'; agentchatCalls?: AgentChatCallCount | null; detail?: string }
  | { status: 'failed'; agentchatCalls?: AgentChatCallCount | null; detail?: string }
  | { status: 'still_running'; next?: Promise<TurnEnd>; detail?: string }

export type TurnOutcomeReason =
  | 'turn_failed'
  | 'turn_running'
  | 'card_unknown'
  | 'card_left_tray'
  | 'turn_recorded_verdict'
  | 'answer_sent'
  | 'could_not_look'
  | 'silent_first'
  | 'silent_again'

export type TurnOutcome =
  | { action: 'none'; reason: Exclude<TurnOutcomeReason, 'answer_sent' | 'silent_again'>; conversationId: string }
  | {
      action: 'record_reply'
      reason: 'answer_sent'
      conversationId: string
      throughMessageId: string | null
      category: ReplyDecisionCategory | null
    }
  | {
      action: 'record_dismiss'
      reason: 'silent_again'
      conversationId: string
      throughMessageId: string | null
      category: 'no_action_needed'
    }
  | {
      /** The second silent look when the turn's AgentChat calls are unknown or some failed: unread, back on the reminder ladder. */
      action: 'record_defer'
      reason: 'silent_again'
      conversationId: string
      throughMessageId: string | null
      category: null
    }

export interface TurnOutcomeInput {
  turn: TurnEnd
  /** When the host started the turn (an ISO string, epoch ms or a Date). Informational: the rule compares no clocks. */
  turnStartedAt: string | number | Date
  /** The card the gate saw when it decided `reply`. */
  gateCard: InboxCard
  /** The category the gate attached to the reply. */
  category?: ReplyDecisionCategory | null
  /** The tray read after the turn; `null` when that read failed. */
  freshTray: Pick<InboxTray, 'conversations' | 'truncated'> | null
  /** Earlier turns for the same anchor that looked and did nothing. Default 0. */
  silentBefore?: number
}

/** The D5 decision for one finished reply turn. Pure. */
export function turnOutcome(input: TurnOutcomeInput): TurnOutcome {
  const conversationId = input.gateCard.conversation_id
  const none = (reason: Extract<TurnOutcome, { action: 'none' }>['reason']): TurnOutcome => ({
    action: 'none',
    reason,
    conversationId,
  })
  const turn = input.turn
  if (turn.status === 'still_running') return none('turn_running')
  const failed = turn.status !== 'completed'
  const tray = input.freshTray
  // A failed turn is still read on the fresh card: one that sent its answer
  // and then failed (an error or its time limit after the send) must not be
  // gated again, or the peer gets the answer twice.
  if (tray === null || tray === undefined) return none(failed ? 'turn_failed' : 'card_unknown')

  const fresh = cardsOf(tray as InboxTray).find((card) => card.conversation_id === conversationId)
  if (!fresh) return none(tray.truncated === true ? 'card_unknown' : 'card_left_tray')

  if (verdictRecordedSince(input.gateCard, fresh)) return none('turn_recorded_verdict')

  const anchor = anchorOf(input.gateCard) ?? null
  if (answerWentOut(input.gateCard, fresh)) {
    return {
      action: 'record_reply',
      reason: 'answer_sent',
      conversationId,
      throughMessageId: anchor,
      category: input.category ?? null,
    }
  }

  if (failed) return none('turn_failed')
  const calls = turn.status === 'completed' ? turn.agentchatCalls : null
  if (couldNotLook(calls)) return none('could_not_look')
  if ((input.silentBefore ?? 0) <= 0) return none('silent_first')
  // Dismiss marks the conversation read: only when the turn's AgentChat calls
  // are known and all succeeded. An unknown count (or a failed call) may mean
  // the tools were unusable — defer instead: unread, back on the reminder ladder.
  if (callsAllSucceeded(calls)) {
    return {
      action: 'record_dismiss',
      reason: 'silent_again',
      conversationId,
      throughMessageId: anchor,
      category: 'no_action_needed',
    }
  }
  return { action: 'record_defer', reason: 'silent_again', conversationId, throughMessageId: anchor, category: null }
}

function callsAllSucceeded(calls: AgentChatCallCount | null | undefined): boolean {
  if (!calls || typeof calls !== 'object') return false
  const made = Number(calls.made)
  const failed = Number(calls.failed)
  return Number.isFinite(made) && made > 0 && Number.isFinite(failed) && failed === 0
}

export type InviteOutcomeReason =
  | 'turn_failed'
  | 'turn_running'
  | 'invite_unknown'
  | 'invite_answered'
  | 'could_not_look'
  | 'silent_first'
  /** Looked again, but the call count cannot confirm the tools worked: nothing recorded. */
  | 'silent_unconfirmed'
  | 'silent_again'

export type InviteOutcome =
  | { action: 'none'; reason: Exclude<InviteOutcomeReason, 'silent_again'>; inviteId: string }
  | { action: 'dismiss_invite'; reason: 'silent_again'; inviteId: string }

export interface InviteOutcomeInput {
  turn: TurnEnd
  invite: TrayInvite
  /** The tray read after the turn; `null` when that read failed. */
  freshTray: Pick<InboxTray, 'invites' | 'invites_truncated'> | null
  /** Earlier turns for this invite that looked and left it pending. Default 0. */
  silentBefore?: number
  /**
   * Dismiss only after a turn whose AgentChat calls are known and none
   * failed (default `true`). Single-run mode passes `false`: a run reports
   * no counts, and its own invite rule applies (`single_run_invite_cases`).
   */
  requireKnownCalls?: boolean
}

/** The D5 rule applied to a group-invite turn. Pure. */
export function inviteOutcome(input: InviteOutcomeInput): InviteOutcome {
  const inviteId = input.invite.invite_id
  const none = (reason: Extract<InviteOutcome, { action: 'none' }>['reason']): InviteOutcome => ({
    action: 'none',
    reason,
    inviteId,
  })
  const turn = input.turn
  if (turn.status === 'still_running') return none('turn_running')
  if (turn.status !== 'completed') return none('turn_failed')
  const tray = input.freshTray
  if (tray === null || tray === undefined) return none('invite_unknown')
  const invites = Array.isArray(tray.invites) ? tray.invites : []
  const still = invites.some((invite) => invite?.invite_id === inviteId)
  if (!still) return none(tray.invites_truncated === true ? 'invite_unknown' : 'invite_answered')
  if (couldNotLook(turn.agentchatCalls)) return none('could_not_look')
  if ((input.silentBefore ?? 0) <= 0) return none('silent_first')
  // As for a card: dismiss on a second look only when the turn's calls are
  // known and all succeeded. Otherwise the invite stays on the tray; the
  // server's re-wakes and the loop's pacing bound what that costs.
  if (input.requireKnownCalls !== false && !callsAllSucceeded(turn.agentchatCalls)) return none('silent_unconfirmed')
  return { action: 'dismiss_invite', reason: 'silent_again', inviteId }
}

/** The client surface `applyOutcome` needs; `AgentChatClient` satisfies it. */
export type OutcomeClient = Pick<AgentChatClient, 'decisions'>

/**
 * Make the one recording call an outcome asks for: `reply` or `dismiss`
 * through the gate's anchor. `none` makes no call. Returns whether a verdict
 * was recorded; a server error is thrown to the caller (the card stays on
 * the tray and the server re-wakes).
 */
export async function applyOutcome(client: OutcomeClient, outcome: TurnOutcome): Promise<boolean> {
  if (outcome.action === 'none') return false
  await client.decisions.record(outcome.conversationId, {
    decision: outcome.action === 'record_reply' ? 'reply' : outcome.action === 'record_defer' ? 'defer' : 'dismiss',
    ...(outcome.category ? { category: outcome.category } : {}),
    ...(outcome.throughMessageId ? { throughMessageId: outcome.throughMessageId } : {}),
  })
  return true
}

/** The client surface `applyInviteOutcome` needs. */
export type InviteOutcomeClient = Pick<AgentChatClient, 'groups'>

/** Dismiss the invite when the outcome says so. Returns whether a call was made. */
export async function applyInviteOutcome(client: InviteOutcomeClient, outcome: InviteOutcome): Promise<boolean> {
  if (outcome.action !== 'dismiss_invite') return false
  await client.groups.dismissInvite(outcome.inviteId)
  return true
}

// ─── the facts the rule reads ───────────────────────────────────────────────

function instant(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function decisionKey(card: InboxCard): string | null {
  const last = card.your_last_decision
  if (!last || typeof last !== 'object') return null
  return `${String(last.decision)}|${String(last.category ?? '')}|${String(last.at ?? '')}`
}

/**
 * The fresh card's verdict is not the one the gate saw. Clock-free: the two
 * values are the same server field, so no local clock is compared.
 */
function verdictRecordedSince(gate: InboxCard, fresh: InboxCard): boolean {
  const now = decisionKey(fresh)
  return now !== null && now !== decisionKey(gate)
}

/** Your last message moved since the gate's card, or the reply the gate saw owed is no longer owed. */
function answerWentOut(gate: InboxCard, fresh: InboxCard): boolean {
  const before = instant(gate.your_last_message_at)
  const after = instant(fresh.your_last_message_at)
  if (after !== null && (before === null || after > before)) return true
  return gate.you_owe_reply === true && fresh.you_owe_reply === false
}

function couldNotLook(calls: AgentChatCallCount | null | undefined): boolean {
  if (!calls || typeof calls !== 'object') return false
  const made = Number(calls.made)
  const failed = Number(calls.failed)
  if (!Number.isFinite(made)) return false
  return made <= 0 || (Number.isFinite(failed) && failed >= made)
}
