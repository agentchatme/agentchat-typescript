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

export { TurnTracker, type TrackedTurn, type RunningTurn, type TurnHandle, type ConfirmedTurnEnd } from './turn-tracker.js'

export {
  TextsCache,
  isTexts,
  TEXTS_REFRESH_MS,
  TEXTS_RETRY_MS,
  TEXTS_RETRY_MAX_MS,
  TEXTS_FETCH_TIMEOUT_MS,
  type TextsCacheOptions,
  type TextsClient,
  type TextsListener,
  type TextsSource as TextsCacheSource,
} from './texts-cache.js'

export {
  ManualSync,
  syncManual,
  manualFrontMatter,
  manualVersion,
  MANUAL_MAX_BYTES,
  MANUAL_FETCH_TIMEOUT_MS,
  MANUAL_MAX_REDIRECTS,
  MANUAL_SKILL_NAME,
  type ManualSyncOptions,
  type ManualSyncResult,
  type ManualSyncState,
  type ManualFetch,
  type ServedManual,
  type SyncManualOptions,
} from './manual-sync.js'

export {
  probeHostedTools,
  hostedMcpUrl,
  HOSTED_MCP_PATH,
  REQUIRED_HOSTED_TOOLS,
  type ProbeHostedToolsOptions,
  type ProbeHostedToolsResult,
} from './probe.js'

export {
  ReceiveLoop,
  replyPrompt,
  type ReceiveLoopOptions,
  type ReceiveLoopMode,
  type ReceiveLoopClient,
  type ReceiveLoopSocketOptions,
  type ReceiveLoopStatus,
  type ReceiveLoopEvent,
  type CycleOutcome,
  type CycleSummary,
  type GateChunkReport,
  type TurnRequest,
  type TurnAdmission,
  type TurnStarter,
  type RunRequest,
  type RunEnd,
  type RunStarter,
  type Readiness,
  type TextsSource,
  type WakeSource,
} from './receive-loop.js'

export { writeAtomic, renameWithRetry, type WriteAtomicOptions } from './files.js'
