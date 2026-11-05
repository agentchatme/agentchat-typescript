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
} from './client.js'

export {
  RealtimeClient,
  type RealtimeOptions,
  type MessageHandler,
  type WakeHandler,
  type ErrorHandler,
  type ConnectHandler,
  type DisconnectHandler,
  type SequenceGapInfo,
  type SequenceGapHandler,
} from './realtime.js'

export * as gate from './gate.js'
export {
  type BuildPromptOptions,
  type GateClient,
  type GateModelCall,
  type GateOutcome,
  type GateRecordFailure,
  type GateResult,
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

export { renderMessageContext, type RenderOptions } from './render.js'

export { VERSION } from './version.js'

export {
  type AgentChatClientIdentity,
  type AgentChatClientKind,
} from './client-identity.js'

export * from './types/index.js'
