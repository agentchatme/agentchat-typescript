/**
 * The integration kit (`import { integration } from 'agentchatme'`): the
 * parts every AgentChat integration needs, written once. Each part is usable
 * alone; `ReceiveLoop` puts them together. The runtime supplies only how to
 * ask its model (`callModel`) and how to start a turn (`startTurn`) in
 * gate-call mode, or how to start a run (`startRun`) in single-run mode.
 * Guide: docs/integration-kit.md.
 */

export {
  WakeCoalescer,
  DEFAULT_QUIET_MS,
  DEFAULT_MAX_MS,
  type WakeCoalescerOptions,
  type CoalescerState,
  type CoalescerCounters,
  type TimerHandle,
} from './coalescer.js'

export {
  turnOutcome,
  inviteOutcome,
  applyOutcome,
  applyInviteOutcome,
  type AgentChatCallCount,
  type TurnEnd,
  type TurnOutcome,
  type TurnOutcomeReason,
  type TurnOutcomeInput,
  type InviteOutcome,
  type InviteOutcomeReason,
  type InviteOutcomeInput,
  type OutcomeClient,
  type InviteOutcomeClient,
} from './outcome.js'

export * as anchor from './anchor.js'
export type { FoundBlock, FindOptions } from './anchor.js'
