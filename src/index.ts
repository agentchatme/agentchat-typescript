export {
  AgentChatClient,
  type AgentChatClientOptions,
  type BacklogWarning,
  type BacklogWarningHandler,
  type CallOptions,
  type ConversationsResource,
  type DecisionsResource,
  type InboxResource,
  type RecoverOptions,
  type RecoverResult,
  type SendMessageResult,
  type SyncEnvelope,
  type MuteEntry,
  type MuteTargetKind,
  type TextsResource,
  type GroupsResource,
  type WakeWebhookResource,
  type SyncOptions,
  type SyncPage,
  type StaticCallOptions,
} from './client.js'

export {
  RealtimeClient,
  isAuthRejectionClose,
  wakePayloadOf,
  type RealtimeOptions,
  type RealtimeState,
  type MessageHandler,
  type WakeHandler,
  type HeartbeatHandler,
  type ErrorHandler,
  type ConnectHandler,
  type DisconnectInfo,
  type DisconnectHandler,
  type StateHandler,
  type BlockedInfo,
  type BlockedHandler,
  type StoppedHandler,
  type SequenceGapInfo,
  type SequenceGapHandler,
} from './realtime.js'

export * as gate from './gate.js'
export * as integration from './integration/index.js'
export {
  type BuildPromptOptions,
  type GateClient,
  type GateModelCall,
  type GateOutcome,
  type GateRecordFailure,
  type GateReply,
  type GateResult,
  type GateTexts,
  type RunGateOptions,
  type ToolNamer,
  type Verdict,
} from './gate.js'

export {
  AgentChatError,
  AwaitingReplyError,
  BlockedError,
  ConnectionError,
  EmailExhaustedError,
  EmailLimitReachedError,
  ForbiddenError,
  GroupDeletedError,
  HandleRequiredError,
  NotFoundError,
  RateLimitedError,
  RecipientBackloggedError,
  RestrictedError,
  ServerError,
  SuspendedError,
  UnauthorizedError,
  ValidationError,
  createAgentChatError,
  type AgentChatErrorResponse,
} from './errors.js'

export {
  HttpTransport,
  DEFAULT_RETRY_POLICY,
  type HttpMethod,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransportOptions,
  type RetryPolicy,
  type RetryOption,
  type RequestHooks,
  type RequestInfo,
  type ResponseInfo,
  type ErrorInfo,
  type RetryInfo,
} from './http.js'

export { paginate } from './pagination.js'

export { parseRetryAfter } from './http-retry-after.js'

export {
  connectBudgetDelayMs,
  CONNECT_BUDGET_CLOSE_CODE,
  CONNECT_BUDGET_MAX_DELAY_MS,
  CONNECT_BUDGET_MIN_DELAY_MS,
  type ConnectBudgetClose,
} from './connect-budget.js'

export {
  verifyWakeWebhook,
  WakeWebhookVerificationError,
  type VerifyWakeWebhookOptions,
  type WakeWebhookHeaders,
  type WakeWebhookVerifyDialect,
  type WakeWebhookVerifyReason,
} from './wake-webhook-verify.js'

export { renderMessageContext, type RenderOptions } from './render.js'

export { VERSION } from './version.js'

export {
  type AgentChatClientIdentity,
  type AgentChatClientKind,
} from './client-identity.js'

export * from './types/index.js'
