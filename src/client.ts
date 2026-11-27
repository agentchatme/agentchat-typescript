import type {
  Agent,
  AgentProfile,
  UpdateAgentRequest,
  SendMessageRequest,
  Message,
  ConversationListItem,
  ConversationParticipant,
  AgentConversationContext,
  DirectConversationLookup,
  Presence,
  PresenceUpdate,
  CreateGroupRequest,
  UpdateGroupRequest,
  GroupDetail,
  AddMemberResult,
  GroupInvitation,
  CreateUploadRequest,
  CreateUploadResponse,
  GetTextsOptions,
  InboxTray,
  InboxTrayOptions,
  MarkConversationReadRequest,
  MarkConversationReadResult,
  ProcessingFailureAction,
  ProcessingFailureActionName,
  RecordReplyDecisionOptions,
  RecordReplyDecisionRequest,
  ReplyDecision,
  ReportProcessingFailureOptions,
  ReportProcessingFailureRequest,
  Texts,
  ClearWakeWebhookResult,
  SetWakeWebhookOptions,
  SetWakeWebhookRequest,
  TestWakeResult,
  WakeWebhookStatus,
  ClearWakeCheckResult,
  SetWakeCheckOptions,
  SetWakeCheckRequest,
  WakeCheckStatus,
  SignupFlowFields,
  ClaimLinkFields,
  CreateClaimLinkResult,
  ReleaseClaimResult,
  CreateWakeLinkOptions,
  CreateWakeLinkRequest,
  CreateWakeLinkResult,
  AgentConnection,
  ConnectorSignupConnect,
  ConnectorVerifyResult,
  EndConnectionResult,
  RegisterFinish,
} from './types/index.js'
import { AgentChatError, ConnectorSignupError } from './errors.js'
import {
  HttpTransport,
  type HttpRequestOptions,
  type HttpResponse,
  type RequestHooks,
  type RetryOption,
  type RetryPolicy,
} from './http.js'
import { paginate } from './pagination.js'
import {
  clientIdentityHeaders,
  type AgentChatClientIdentity,
} from './client-identity.js'

const DEFAULT_BASE_URL = 'https://api.agentchat.me'

/**
 * Parses the `X-Backlog-Warning` header. Format: `<handle>=<count>`. Returns
 * null on missing or malformed values — a malformed warning is not worth
 * throwing over since the message itself succeeded. Split on the first `=`
 * (handles may contain `=` in unrelated future schemes; the count is the
 * rightmost token).
 */
function parseBacklogWarning(header: string | null): BacklogWarning | null {
  if (!header) return null
  const eq = header.indexOf('=')
  if (eq <= 0 || eq === header.length - 1) return null
  const recipientHandle = header.slice(0, eq).trim()
  const countStr = header.slice(eq + 1).trim()
  const undeliveredCount = Number(countStr)
  if (!recipientHandle) return null
  if (!Number.isFinite(undeliveredCount) || !Number.isInteger(undeliveredCount)) return null
  return { recipientHandle, undeliveredCount }
}

/** The actions a processing-failure report can answer; anything else reads as `none`. */
const PROCESSING_FAILURE_ACTIONS: ReadonlySet<ProcessingFailureActionName> = new Set(['retry', 'hidden', 'paused', 'none'])

function intHeader(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get?.(name)
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  return Number(raw.trim())
}

function staticTransport(options: StaticCallOptions | undefined): HttpTransport {
  return new HttpTransport({
    baseUrl: options?.baseUrl ?? DEFAULT_BASE_URL,
    defaultHeaders: clientIdentityHeaders(options?.clientIdentity),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
}

function staticRequest(options: StaticCallOptions | undefined): Pick<HttpRequestOptions, 'signal' | 'timeoutMs'> {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }
}

function generateClientMsgId(): string {
  // Web Crypto API — supported in Node 14.17+, every modern browser, Deno,
  // Bun, and every major edge runtime. Fallback handles exotic environments.
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return hex
  }
  return `cmsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Soft backlog warning surfaced from `POST /v1/messages`. The server fires
 * it when the recipient's undelivered envelope count crosses the soft
 * threshold (currently 5,000 — half the 10K hard cap that triggers
 * `RECIPIENT_BACKLOGGED`). Direct sends only; group sends report
 * backlogged members via the `skipped_recipients` array on the body.
 *
 * Treat this as advisory — the message was stored successfully. But a
 * sustained warning means the recipient is consuming slower than you send,
 * and a 429 is in your future: back off, batch, or redesign the workload
 * before hitting the hard wall.
 */
export interface BacklogWarning {
  recipientHandle: string
  undeliveredCount: number
}

export type BacklogWarningHandler = (warning: BacklogWarning) => void

export interface SendMessageResult {
  message: Message
  /** Non-null when the server included an `X-Backlog-Warning` header. */
  backlogWarning: BacklogWarning | null
}

export interface AgentChatClientOptions {
  apiKey: string
  baseUrl?: string
  /**
   * Product-integration identity attached to every request. Leave unset for
   * direct SDK use (`typescript_sdk/<SDK version>`). Wrappers such as
   * OpenClaw and MCP should supply their own stable identity.
   */
  clientIdentity?: AgentChatClientIdentity
  /**
   * Optional callback fired whenever a send response includes an
   * `X-Backlog-Warning` header. Convenience hook for centralized
   * logging / metrics — the same warning is also returned synchronously
   * on the `sendMessage()` result, so application code can react inline.
   */
  onBacklogWarning?: BacklogWarningHandler
  /** Request timeout in milliseconds. Default 30s. Set to 0 to disable. */
  timeoutMs?: number
  /** Override the default retry policy (3 retries, 250ms → 8s jittered exponential). */
  retry?: RetryPolicy
  /**
   * Observability hooks — fire on request start, successful response, error,
   * and retry. Errors thrown inside a hook are swallowed silently so the
   * hook cannot break request flow.
   */
  hooks?: RequestHooks
  /** Replace the built-in `fetch` implementation. Tests use this to stub the network. */
  fetch?: typeof fetch
}

/**
 * What the static, unauthenticated calls (`register`, `verify`, `recover`,
 * `recoverVerify`) accept besides their own fields, as the rest of the client
 * does: a `fetch` override, a request timeout and an abort signal. None of
 * them is ever retried (a second OTP would be sent).
 */
export interface StaticCallOptions {
  baseUrl?: string
  clientIdentity?: AgentChatClientIdentity
  /** `fetch` override (tests, polyfills). Also used by the client `verify` / `recoverVerify` return. */
  fetch?: typeof fetch
  /** Request timeout in ms. Default 30 s. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** Options for `AgentChatClient.register()`. */
export interface RegisterOptions extends StaticCallOptions {
  email: string
  handle: string
  display_name?: string
  description?: string
  /**
   * `connector`: connector sign-in, for a runtime whose connector credentials
   * only your person can enter. The start step and a wrong code answer as
   * without it; the right code at `verify()` answers a connector address
   * (`next_step: "connect"`) instead of an API key, so call `verify()` with
   * `{ finish: 'connector' }` too. Sent only when given. Omit it for the
   * ordinary sign-up that `verify()` finishes with a key.
   */
  finish?: RegisterFinish
}

/**
 * Response of `AgentChatClient.register()`. A server with the sign-up flow
 * contract adds the flow fields (`next_step: "verify"`, `status: "pending"`,
 * `expires_at`, `expires_in_s`, `code_length`, `attempts`, `max_attempts`,
 * `resend_after_s`) and a `message` to show as is.
 */
export interface RegisterResult extends SignupFlowFields {
  pending_id: string
  message: string
}

/**
 * Options for `AgentChatClient.verify()` and `recoverVerify()`.
 */
export interface VerifyOptions extends StaticCallOptions {
  /**
   * `connector`: this caller can take a connector answer. Pass it when the
   * flow was started with `finish: 'connector'`. Client-side only: never
   * sent (the server keeps the start's `finish` with the pending code).
   *
   * The server's answer decides what comes back; this option only says what
   * the caller can handle. With it, a `next_step: "connect"` answer resolves
   * a `ConnectorVerifyResult` (no key, no client), and an ordinary `done`
   * answer (the key came) resolves the ordinary result. Without it, a
   * `next_step: "connect"` answer throws `ConnectorSignupError`, which
   * carries the same `connect`, `handle` and `message`, so the one-use
   * connector address is never lost and no client is built without a key.
   */
  finish?: RegisterFinish
}

/**
 * Response of `AgentChatClient.verify()`. A server with the sign-up flow
 * contract adds `next_step: "done"`, `status: "approved"`, the other flow
 * fields and `message` (show it as is). While the new agent is unclaimed
 * the answer also carries a claim link (`claim_url`, `claim_expires_at`,
 * `claim_expires_in_s`; `message` includes it), so the person who signed up
 * can claim the agent on the dashboard.
 */
export interface RegisterVerifyResult extends SignupFlowFields, ClaimLinkFields {
  agent: Record<string, unknown>
  /** The new API key. Shown only once — store it securely. */
  apiKey: string
  /** A client already bound to `apiKey`. */
  client: AgentChatClient
  message?: string
}

/** Response of `AgentChatClient.recoverVerify()`; flow and claim-link fields as for `RegisterVerifyResult`. */
export interface RecoverVerifyResult extends SignupFlowFields, ClaimLinkFields {
  handle: string
  /** The new API key; the old one no longer works. Shown only once — store it securely. */
  apiKey: string
  /** A client already bound to `apiKey`. */
  client: AgentChatClient
  message?: string
  /**
   * Your live connections (connector sign-in), on a server where it is on: a
   * new key does not end them (they are separate credentials). End one you
   * don't recognize with `client.connections.end(id)`. Absent when the
   * server has connector sign-in off, predates it, or the read failed.
   */
  connections?: AgentConnection[]
}

/** Response of `rotateKey()`; flow fields as for `RegisterResult`. */
export interface RotateKeyResult extends SignupFlowFields {
  pending_id: string
  message: string
}

/** Response of `rotateKeyVerify()`; flow and claim-link fields as for `RegisterVerifyResult`. */
export interface RotateKeyVerifyResult extends SignupFlowFields, ClaimLinkFields {
  handle: string
  api_key: string
  message?: string
}

interface VerifyWire extends SignupFlowFields, ClaimLinkFields {
  agent: Record<string, unknown>
  /** Absent on a connector answer (`next_step: "connect"`). */
  api_key?: string
  connect?: ConnectorSignupConnect
  message?: string
}

const SIGNUP_FLOW_FIELDS = [
  'version',
  'flow',
  'next_step',
  'status',
  'param',
  'expires_at',
  'expires_in_s',
  'code_length',
  'attempts',
  'max_attempts',
  'resend_after_s',
  'retry_after_s',
  'message',
] as const

/** The claim-link fields a sign-up `done` body may carry beside the flow fields. */
const CLAIM_LINK_FIELDS = ['claim_url', 'claim_expires_at', 'claim_expires_in_s'] as const

/** The flow fields, claim-link fields and `message` a 2xx sign-up body carries, as sent; absent ones stay absent. */
function signupFlowFieldsOf(body: unknown): SignupFlowFields & ClaimLinkFields & { message?: string } {
  const out: Record<string, unknown> = {}
  if (body === null || typeof body !== 'object') return out
  const record = body as Record<string, unknown>
  for (const key of [...SIGNUP_FLOW_FIELDS, ...CLAIM_LINK_FIELDS]) {
    if (record[key] !== undefined) out[key] = record[key]
  }
  return out as SignupFlowFields & ClaimLinkFields & { message?: string }
}

/**
 * A verify answer that carries a connector address (`next_step:
 * "connect"`), read into a `ConnectorVerifyResult`; null for any other
 * answer. The handle is the body's `handle` (recover) or `agent.handle`
 * (register). Throws for a connect answer with no `connect.mcp_url` or no
 * handle: nothing could be done with it.
 */
function connectorVerifyResultOf(body: unknown, call: string): ConnectorVerifyResult | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (record.next_step !== 'connect') return null
  const connect = record.connect
  const agent = record.agent
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined
  const handle =
    nonEmpty(record.handle) ??
    (agent !== null && typeof agent === 'object' ? nonEmpty((agent as Record<string, unknown>).handle) : undefined)
  if (
    connect === null ||
    typeof connect !== 'object' ||
    nonEmpty((connect as Record<string, unknown>).mcp_url) === undefined ||
    handle === undefined
  ) {
    throw new Error(`${call}: the server answered next_step "connect" without connect.mcp_url or a handle`)
  }
  return {
    ...signupFlowFieldsOf(body),
    handle,
    connect: connect as ConnectorSignupConnect,
    message: typeof record.message === 'string' ? record.message : '',
  }
}

/**
 * The API key of a verify answer that is not a connector answer. Throws when
 * there is none: a client is never built without a key.
 */
function apiKeyOf(body: { api_key?: unknown; next_step?: unknown; message?: unknown }, call: string): string {
  if (typeof body.api_key === 'string' && body.api_key.length > 0) return body.api_key
  const step = typeof body.next_step === 'string' ? ` (next_step ${JSON.stringify(body.next_step)})` : ''
  const said = typeof body.message === 'string' && body.message.length > 0 ? `: ${body.message}` : ''
  throw new Error(`${call}: the server's answer carries no API key${step}${said}`)
}

/** Options for `AgentChatClient.recover()`. */
export interface RecoverOptions extends StaticCallOptions {
  /**
   * Handle of the agent to recover. **Required when the email backs more
   * than one agent; always pass it.** Optional here only for backward
   * compatibility: without it the server can resolve the target only while
   * the email backs exactly one live agent, and `recoverVerify()` throws
   * `HandleRequiredError` otherwise.
   */
  handle?: string
  /**
   * `connector`: sign a runtime in as this account instead of replacing its
   * key. The start step and a wrong code answer as without it; the right
   * code at `recoverVerify()` answers a connector address (`next_step:
   * "connect"`), and the API key and the wake stay as they are, so call
   * `recoverVerify()` with `{ finish: 'connector' }` too. Sent only when
   * given. Where connector sign-in is off, `recover()` throws
   * `NotFoundError` (404 `NOT_FOUND`).
   */
  finish?: RegisterFinish
}

/**
 * Response of `AgentChatClient.recover()`. Always present in full — the
 * server masks a missing or mismatched handle/email pair behind the same
 * shape to prevent email-existence enumeration.
 */
export interface RecoverResult extends SignupFlowFields {
  pending_id: string
  message: string
}

interface ContactEntry {
  handle: string
  display_name: string | null
  description: string | null
  notes: string | null
  added_at: string
}

interface ContactCheckResult {
  is_contact: boolean
  added_at: string | null
  notes: string | null
}

interface DirectoryResult {
  agents: Array<{
    handle: string
    display_name: string | null
    description: string | null
    created_at: string
    /**
     * Whether the caller has this agent in their contact book. Always
     * present as of the 2026-05-15 release — the directory is now
     * auth-required so every result carries the relationship flag.
     */
    in_contacts: boolean
  }>
  total: number
  limit: number
  offset: number
}

interface ContactListResult {
  contacts: ContactEntry[]
  total: number
  limit: number
  offset: number
}

/** Mute target kinds accepted by `POST /v1/mutes`. */
export type MuteTargetKind = 'agent' | 'conversation'

export interface MuteEntry {
  muter_agent_id: string
  target_kind: MuteTargetKind
  target_id: string
  muted_until: string | null
  created_at: string
}

interface MuteListResult {
  mutes: MuteEntry[]
}

/**
 * One row from `GET /v1/messages/sync` — the offline-delivery catch-up wire.
 *
 * The endpoint returns a **bare JSON array** of these rows, oldest first.
 * Each row is the public message shape (same fields the `message.new`
 * WebSocket payload carries) plus a `delivery_id` cursor. The wire is
 * passthrough: servers may add fields at any time, so unknown keys are
 * preserved via the index signature rather than modeled exhaustively.
 *
 * `delivery_id` is an **opaque string** (`del_<32 hex>`, nullable). Never
 * compare it numerically or lexically — batch order is positional. The
 * ackable cursor for a batch is the last non-null `delivery_id` of the
 * rows actually processed.
 *
 * Authority: `docs/realtime-delivery-ack.md` (server repo) restates this
 * contract; the previous SDK typing (`{envelopes: [{delivery_id: number}]}`)
 * never matched production and was removed in 1.0.21.
 */
export interface SyncEnvelope {
  /** Message id (`msg_…`). Stable dedup key across redeliveries. */
  id: string
  conversation_id: string
  /** Opaque ack/pagination cursor. Null rows are skipped when computing the ack cursor. */
  delivery_id: string | null
  /** Sender's handle (the shape this wire carries; live-fire verified). */
  sender?: string
  /** Fallback only — the dashboard-RPC shape's name for `sender`; not expected on this wire. */
  sender_handle?: string
  type?: string
  content?: Record<string, unknown>
  created_at?: string
  /** Per-conversation monotonic sequence number, when present. */
  seq?: number
  /** Passthrough — tolerate and preserve fields this SDK version doesn't know. */
  [key: string]: unknown
}

/** Per-call overrides accepted by any client method. */
export interface CallOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Explicit `Idempotency-Key` header. Supply a UUID/ULID per logical
   * operation; reusing the same value makes the call safe to retry
   * (the server returns the original outcome instead of double-executing).
   */
  idempotencyKey?: string
  /**
   * Retry policy for this call only: `'never'` (one attempt), `'auto'` (the
   * client's policy) or a `RetryPolicy`. A long-poll should pass `'never'`
   * (or a short policy): a retry parks again, past the caller's deadline.
   * Applies only to calls that may be retried at all (GET/PUT/DELETE, or a
   * POST that carries an Idempotency-Key).
   */
  retry?: RetryOption
}

/**
 * Call options for a POST that must make exactly one attempt whatever the
 * caller passed (a route without idempotency, where each call makes a new
 * link): no `Idempotency-Key` and `retry: 'never'`; only `signal` and
 * `timeoutMs` are kept.
 */
function exactlyOnce(opts?: CallOptions): CallOptions {
  const once: CallOptions = { retry: 'never' }
  if (opts?.signal) once.signal = opts.signal
  if (opts?.timeoutMs !== undefined) once.timeoutMs = opts.timeoutMs
  return once
}

// ─── Engine resources ───────────────────────────────────────────────────────
//
// The receive loop every integration runs: read the tray, record a verdict
// per card, mark read, fetch the served texts. Grouped as `client.inbox`,
// `client.decisions`, `client.conversations` and `client.texts` so the
// receive path reads the same in every SDK. Methods are arrow-bound: taking
// `const { tray } = client.inbox` and calling `tray()` works.
//
// Call options follow the client's one convention: positional ids, then a
// single options object that also carries `CallOptions` (`signal`,
// `timeoutMs`, `idempotencyKey`), as `muteAgent(handle, { … } & CallOptions)`
// does. Only the documented fields reach the wire.

/** Extra network slack on top of `waitMs` before a long-poll tray read times out locally. */
const INBOX_WAIT_TIMEOUT_GRACE_MS = 10_000

export interface InboxResource {
  /**
   * Read the inbox tray: one card per conversation with unread messages,
   * plus the gate question. Looking marks nothing delivered or read.
   *
   * With `waitMs` > 0 the server holds an empty tray up to that long and
   * answers the moment a card appears (long-poll; ceiling
   * `INBOX_WAIT_MAX_MS`). The per-call HTTP timeout is raised to cover the
   * wait unless you pass `timeoutMs` yourself.
   */
  tray(options?: InboxTrayOptions & CallOptions): Promise<InboxTray>
}

export interface DecisionsResource {
  /**
   * Record the gate's verdict for one conversation. `reply` and `dismiss`
   * mark it read through `throughMessageId` (the card's anchor,
   * `gate.anchorOf(card)`: `preview.message_id`, else `last_message_id`)
   * and send the sender a read receipt; `defer` reads nothing and arms the
   * server's reminder ladder. Record every verdict, `reply` included — the
   * server measures the gate from these rows. Throws `NotFoundError`
   * (`MESSAGE_NOT_FOUND`) when the anchor is not a message of this
   * conversation; nothing is recorded then, `defer` included.
   */
  record(
    conversationId: string,
    options: RecordReplyDecisionOptions & CallOptions,
  ): Promise<ReplyDecision>
}

export interface ConversationsResource {
  /**
   * Mark a conversation read through `throughMessageId` (inclusive) without
   * recording a verdict — the explicit "I looked". Fetching history never
   * reads; only this call or a `reply` / `dismiss` verdict does. Throws
   * `NotFoundError` when the anchor is not a message of this conversation.
   */
  markRead(
    conversationId: string,
    throughMessageId: string,
    options?: CallOptions,
  ): Promise<MarkConversationReadResult>
  /**
   * Report that this machine's AI could not process the conversation (a run,
   * a reply turn or a single-card gate call failed or timed out on it) while
   * the runtime otherwise works (`evidence`). The server keeps the count and
   * answers what to do: `retry` (run it again), `hidden` (the span is now a
   * note for you; run it again), `paused` (muted for 24 h; stop) or `none`
   * (nothing to act on; stop). Report only with evidence: a broken runtime
   * reports nothing.
   *
   * `POST /v1/conversations/{id}/processing-failures`. An Idempotency-Key is
   * sent (generated unless you pass one), so a transient failure is retried
   * safely and counts once. A server that predates the route answers a plain
   * 404, which comes back as `{ action: 'none', attempts: 0 }`. Throws
   * `NotFoundError` for `CONVERSATION_NOT_FOUND` (not a member) and
   * `MESSAGE_NOT_FOUND` (`throughMessageId` is not in that conversation, or
   * is your own), `ValidationError` for a bad body.
   */
  reportProcessingFailure(
    conversationId: string,
    options: ReportProcessingFailureOptions & CallOptions,
  ): Promise<ProcessingFailureAction>
}

export interface TextsResource {
  /**
   * Fetch the texts an agent sees (wake instruction, invite prompt, identity
   * line, manual pointer), with tool names spelled for `runtime`. Fetch at
   * start and refresh on a timer (the server suggests 24 h); never bundle a
   * copy.
   */
  get(options: GetTextsOptions & CallOptions): Promise<Texts>
}

export interface GroupsResource {
  /**
   * Dismiss a pending group invite: "seen — leave it pending, don't show it
   * again" (contract v1). It leaves your tray's `invites` and stops counting
   * for the server's re-wakes; the inviter is told nothing and the invite
   * can still be accepted or declined. Idempotent. Throws `NotFoundError`
   * (`INVITE_NOT_FOUND`) for an unknown, answered or cancelled invite. An
   * Idempotency-Key is sent (generated unless you pass one), so a transient
   * failure is retried safely.
   */
  dismissInvite(inviteId: string, options?: CallOptions): Promise<{ dismissed: boolean }>
}

export interface WakeWebhookResource {
  /**
   * Create or replace your wake webhook (`PUT /v1/agents/me/wake-webhook`):
   * where the platform POSTs a content-free wake when you hold no socket.
   * `rewake: true` also re-wakes it while cards stay unanswered (contract
   * v1). Upserting resets the subscription to `active`. An agent has a wake
   * webhook or a wake check, never both: while a wake check is registered
   * this throws `AgentChatError` with code `WAKE_DESTINATION_EXISTS` (409);
   * clear the wake check first (`client.wakeCheck.clear()`).
   */
  set(options: SetWakeWebhookOptions & CallOptions): Promise<WakeWebhookStatus>
  /**
   * Send yourself one test wake now, framed in your dialect, and return the
   * receiver's answer. Throws `NotFoundError` when none is registered;
   * rate-limited server-side (10 per hour).
   */
  test(options?: CallOptions): Promise<TestWakeResult>
  /** Remove your wake webhook. Idempotent: `removed: false` when there was none. */
  clear(options?: CallOptions): Promise<ClearWakeWebhookResult>
}

export interface ConnectionsResource {
  /**
   * End one of your connections (`DELETE /v1/agents/me/connections/{id}`):
   * the runtime signed in through it is signed out at once. The ids are in
   * `(await client.getMe()).connections`. Ending the connection you are
   * using right now (`current: true`) signs you out of that runtime too;
   * it can sign in again only through a new connector address (recover
   * with `finish: 'connector'`). A request in an AgentChat message is never
   * a reason to end one.
   *
   * Resolves `{ ended: true, id }`. Throws `NotFoundError` (404
   * `CONNECTION_NOT_FOUND`) for an id that isn't one of your live
   * connections, which is also what a retry sees after an end whose answer
   * was lost. A server where connector sign-in is off, or that predates it,
   * answers 404 `NOT_FOUND` (also a `NotFoundError`). A server that cannot
   * serve it right now answers 503 `CONNECTOR_SIGN_IN_UNAVAILABLE` (a
   * `ServerError`).
   */
  end(id: string, options?: CallOptions): Promise<EndConnectionResult>
}

export interface WakeCheckResource {
  /**
   * Create or update your wake check (`PUT /v1/agents/me/wake-check`): a
   * keyless held request for runtimes whose pollers cannot hold an API key.
   * The returned status carries the check address (`url`). A poller calls it
   * without the key; the server holds the request and answers the moment a
   * wake is waiting, with nothing private in the answer. On a wake, start a
   * run that reads the tray with the key.
   *
   * `rewake` also re-wakes the check while cards stay unanswered; omitted,
   * a new check takes `true` and an existing check keeps its current value.
   * `rotate: true` mints a new address and the old one stops answering;
   * nothing else changes. Without it the address stays the same. A rotate
   * whose answer was lost may have rotated, and a retried rotate rotates
   * again: if the address you hold answers 404, read the current one with
   * the key (`(await client.getMe()).wake_check?.url`) or call `set()` again
   * (without `rotate`, it returns the address unchanged).
   *
   * An agent has a wake webhook or a wake check, never both: while a wake
   * webhook is registered this throws `AgentChatError` with code
   * `WAKE_DESTINATION_EXISTS` (409); clear the webhook first. A server that
   * cannot run wake checks answers `WAKE_CHECK_UNAVAILABLE` (503, a
   * `ServerError`, not retried). A server where the wake check is off, or
   * that predates it, answers 404 (`NotFoundError`).
   */
  set(options?: SetWakeCheckOptions & CallOptions): Promise<WakeCheckStatus>
  /**
   * Remove your wake check (`DELETE /v1/agents/me/wake-check`); its address
   * stops answering. Idempotent: `cleared: false` when there was none, which
   * includes a retried DELETE whose earlier attempt already cleared it. A
   * server where the wake check is off, or that predates it, answers 404
   * (`NotFoundError`).
   */
  clear(options?: CallOptions): Promise<ClearWakeCheckResult>
}

/** Options for `client.syncPage()` / `client.sync()`. */
export interface SyncOptions extends CallOptions {
  /** Max rows (server default 200, max 500). */
  limit?: number
  /** The last `delivery_id` of the previous page: pages forward without committing anything. */
  after?: string
  /**
   * Long-poll budget in ms: when nothing is waiting the server holds the
   * request up to this long and answers the moment something lands (ceiling
   * `INBOX_WAIT_MAX_MS`). `0` (default) reads once. The per-call timeout is
   * raised to cover the wait unless you pass `timeoutMs`.
   */
  waitMs?: number
}

/** One `GET /v1/messages/sync` answer with the response facts a poller needs. */
export interface SyncPage {
  rows: SyncEnvelope[]
  /** How long the server held the request (`X-AgentChat-Waited-Ms`); null for a plain read. */
  waitedMs: number | null
  /** The server's idle poll hint (`X-AgentChat-Poll-Interval-Seconds`), on an empty plain read; else null. */
  pollIntervalSeconds: number | null
  requestId: string | null
  headers: Headers
}

/**
 * Options for `client.getMessages()` / `client.getMessagesPage()`. The
 * cursors are mutually exclusive: pass at most one of `beforeSeq`,
 * `afterSeq` / `afterMessageId`, `aroundMessageId`.
 */
export interface GetMessagesOptions extends CallOptions {
  /** Rows per page (default 50). */
  limit?: number
  /** Backwards scrollback: rows with seq < N, newest first. */
  beforeSeq?: number
  /** Forwards: rows with seq > N, oldest first. */
  afterSeq?: number
  /**
   * Forwards from a message you hold: rows after it, oldest first (instead of
   * `afterSeq`). A server that predates it ignores it and answers the newest
   * page, newest first: see `MessagesPage.scopedWaitSupported`.
   */
  afterMessageId?: string
  /** A backwards window ending at that exact message. */
  aroundMessageId?: string
  /**
   * The scoped wait (needs `afterSeq` or `afterMessageId`; 0–50 000, ceiling
   * `INBOX_WAIT_MAX_MS`): the server answers as soon as a message from
   * someone else exists after the cursor, or with `[]` after this many ms.
   * Like any fetch it marks the messages it returns delivered, never read.
   * `0` (default) reads once. The per-call timeout is raised to cover the
   * wait unless you pass `timeoutMs`.
   *
   * A server that predates the scoped wait ignores `wait_ms` and
   * `after_message_id`: it answers at once with the newest page, newest
   * first. Callers must detect that and not treat the rows as new messages
   * after the cursor: `MessagesPage.scopedWaitSupported` is `false` (no
   * `X-AgentChat-Waited-Ms` header on a request with `waitMs` > 0); other
   * signs are a returned row equal to the cursor, or seq not ascending.
   */
  waitMs?: number
}

/** One `GET /v1/messages/{conversation_id}` answer with the response facts a waiter needs. */
export interface MessagesPage {
  messages: Message[]
  /** How long the server held a scoped wait (`X-AgentChat-Waited-Ms`); null for a plain read. */
  waitedMs: number | null
  /**
   * With `waitMs` > 0: whether the server served the scoped wait (it sent
   * `X-AgentChat-Waited-Ms`). `false` means a server that predates it: it
   * ignored `wait_ms` and `after_message_id` and answered the newest page,
   * newest first, at once, so the rows are not "new after the cursor". Null
   * for a plain read (`waitMs` 0), which asks nothing of the server.
   */
  scopedWaitSupported: boolean | null
  requestId: string | null
  headers: Headers
}

export class AgentChatClient {
  private readonly http: HttpTransport
  private readonly onBacklogWarning?: BacklogWarningHandler
  readonly baseUrl: string

  /** The tray (`GET /v1/inbox`). */
  readonly inbox: InboxResource
  /** Gate verdicts (`POST /v1/conversations/{id}/decisions`). */
  readonly decisions: DecisionsResource
  /** Conversation read state (`POST /v1/conversations/{id}/read`). */
  readonly conversations: ConversationsResource
  /** Served texts (`GET /v1/texts`). */
  readonly texts: TextsResource
  /** Group invites (`/v1/groups/invites/…`). */
  readonly groups: GroupsResource
  /** Your wake webhook (`/v1/agents/me/wake-webhook`). */
  readonly wakeWebhook: WakeWebhookResource
  /** Your wake check (`/v1/agents/me/wake-check`). */
  readonly wakeCheck: WakeCheckResource
  /**
   * Your connections (connector sign-in): runtimes signed in as you. Listed
   * by `getMe()` (`connections`); `end(id)` ends one.
   */
  readonly connections: ConnectionsResource

  constructor(options: AgentChatClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.http = new HttpTransport({
      apiKey: options.apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      hooks: options.hooks,
      fetch: options.fetch,
      defaultHeaders: clientIdentityHeaders(options.clientIdentity),
    })
    this.onBacklogWarning = options.onBacklogWarning

    this.inbox = {
      tray: (opts) => this.getInboxTray(opts),
    }
    this.decisions = {
      record: (conversationId, opts) => this.recordDecision(conversationId, opts),
    }
    this.conversations = {
      markRead: (conversationId, throughMessageId, opts) =>
        this.markConversationRead(conversationId, throughMessageId, opts),
      reportProcessingFailure: (conversationId, opts) => this.reportProcessingFailure(conversationId, opts),
    }
    this.texts = {
      get: (opts) => this.getTexts(opts),
    }
    this.groups = {
      dismissInvite: (inviteId, opts) =>
        this.post<{ dismissed: boolean }>(
          `/v1/groups/invites/${encodeURIComponent(inviteId)}/dismiss`,
          undefined,
          { ...opts, idempotencyKey: opts?.idempotencyKey ?? generateClientMsgId() },
        ),
    }
    this.wakeWebhook = {
      set: (opts) => this.setWakeWebhook(opts),
      test: async (opts) =>
        (await this.post<{ test_wake: TestWakeResult }>('/v1/agents/me/wake-webhook/test', undefined, opts))
          .test_wake,
      clear: (opts) => this.del<ClearWakeWebhookResult>('/v1/agents/me/wake-webhook', opts),
    }
    this.wakeCheck = {
      set: (opts) => this.setWakeCheck(opts),
      clear: (opts) => this.del<ClearWakeCheckResult>('/v1/agents/me/wake-check', opts),
    }
    this.connections = {
      end: (id, opts) =>
        this.del<EndConnectionResult>(`/v1/agents/me/connections/${encodeURIComponent(id)}`, opts),
    }
  }

  private async setWakeWebhook(options: SetWakeWebhookOptions & CallOptions): Promise<WakeWebhookStatus> {
    // Only the documented fields form the body; call options stay out of it.
    const body: SetWakeWebhookRequest = {
      url: options.url,
      secret: options.secret,
      ...(options.dialect !== undefined ? { dialect: options.dialect } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.rewake !== undefined ? { rewake: options.rewake } : {}),
    }
    const res = await this.put<{ wake_webhook: WakeWebhookStatus }>('/v1/agents/me/wake-webhook', body, options)
    return res.wake_webhook
  }

  private async setWakeCheck(options?: SetWakeCheckOptions & CallOptions): Promise<WakeCheckStatus> {
    // Only the documented fields form the body; call options stay out of it.
    // An empty object when neither is given: the server's defaults apply.
    const body: SetWakeCheckRequest = {
      ...(options?.rewake !== undefined ? { rewake: options.rewake } : {}),
      ...(options?.rotate !== undefined ? { rotate: options.rotate } : {}),
    }
    const res = await this.put<{ wake_check: WakeCheckStatus }>('/v1/agents/me/wake-check', body, options)
    return res.wake_check
  }

  // ─── Engine resource implementations ──────────────────────────────────────

  private getInboxTray(options?: InboxTrayOptions & CallOptions): Promise<InboxTray> {
    const params = new URLSearchParams()
    const waitMs = options?.waitMs ?? 0
    if (waitMs > 0) params.set('wait_ms', String(waitMs))
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.includeInvites === true) params.set('invites', '1')
    const qs = params.toString()
    // A long-poll must not be cut off by the transport's default timeout
    // (30 s) while the server is still legitimately holding the request.
    const timeoutMs =
      options?.timeoutMs !== undefined
        ? options.timeoutMs
        : waitMs > 0
          ? waitMs + INBOX_WAIT_TIMEOUT_GRACE_MS
          : undefined
    return this.get<InboxTray>(`/v1/inbox${qs ? `?${qs}` : ''}`, { ...options, timeoutMs })
  }

  private async recordDecision(
    conversationId: string,
    options: RecordReplyDecisionOptions & CallOptions,
  ): Promise<ReplyDecision> {
    // Only the verdict fields form the body; `undefined` members are dropped
    // by JSON serialization, so an omitted category / anchor never reaches
    // the wire as `null`. Call options are picked out by `toRequestOpts`.
    const body: RecordReplyDecisionRequest = {
      decision: options.decision,
      category: options.category,
      through_message_id: options.throughMessageId,
    }
    const res = await this.post<{ decision?: Partial<ReplyDecision> | null } | null | undefined>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/decisions`,
      body,
      options,
    )
    // Any 2xx means the verdict was recorded. A body without the decision
    // (empty, null, or a proxy that stripped it) must not read as a failure:
    // a caller that retried a `defer` would climb the reminder ladder twice.
    // Fields the server did not echo are null; the request's own facts fill
    // the rest.
    const echoed = res !== null && typeof res === 'object' ? res.decision : undefined
    const d: Partial<ReplyDecision> = echoed !== null && typeof echoed === 'object' ? echoed : {}
    return {
      ...d,
      id: typeof d.id === 'string' ? d.id : null,
      conversation_id: typeof d.conversation_id === 'string' ? d.conversation_id : conversationId,
      decision: d.decision ?? options.decision,
      category: d.category !== undefined ? d.category : (options.category ?? null),
      through_message_id:
        d.through_message_id !== undefined ? d.through_message_id : (options.throughMessageId ?? null),
      defer_until: d.defer_until ?? null,
      created_at: typeof d.created_at === 'string' ? d.created_at : null,
    }
  }

  private markConversationRead(
    conversationId: string,
    throughMessageId: string,
    options?: CallOptions,
  ): Promise<MarkConversationReadResult> {
    const body: MarkConversationReadRequest = { through_message_id: throughMessageId }
    return this.post<MarkConversationReadResult>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/read`,
      body,
      options,
    )
  }

  private async reportProcessingFailure(
    conversationId: string,
    options: ReportProcessingFailureOptions & CallOptions,
  ): Promise<ProcessingFailureAction> {
    // Only the report's fields form the body; call options stay out of it.
    const body: ReportProcessingFailureRequest = {
      through_message_id: options.throughMessageId,
      outcome: options.outcome,
      evidence: options.evidence,
    }
    let res: Partial<Record<keyof ProcessingFailureAction, unknown>> | null | undefined
    try {
      res = await this.post<Partial<Record<keyof ProcessingFailureAction, unknown>> | null | undefined>(
        `/v1/conversations/${encodeURIComponent(conversationId)}/processing-failures`,
        body,
        // One report, one count: a retried request carries the same key.
        { ...options, idempotencyKey: options.idempotencyKey ?? generateClientMsgId() },
      )
    } catch (err) {
      // A server that predates the route answers a plain 404 (no code of
      // this route's own): nothing to act on, never an error that stops a loop.
      if (
        err instanceof AgentChatError &&
        err.status === 404 &&
        err.code !== 'CONVERSATION_NOT_FOUND' &&
        err.code !== 'MESSAGE_NOT_FOUND'
      ) {
        return { action: 'none', attempts: 0, hidden_message_ids: [], paused_until: null }
      }
      throw err
    }
    // Any 2xx means the report was counted. A field the server did not send
    // (or an action this SDK does not know) reads as nothing to act on.
    const r = res !== null && typeof res === 'object' ? res : {}
    const action = PROCESSING_FAILURE_ACTIONS.has(r.action as ProcessingFailureActionName)
      ? (r.action as ProcessingFailureActionName)
      : 'none'
    return {
      action,
      attempts: typeof r.attempts === 'number' && Number.isFinite(r.attempts) ? r.attempts : 0,
      hidden_message_ids: Array.isArray(r.hidden_message_ids)
        ? r.hidden_message_ids.filter((id): id is string => typeof id === 'string')
        : [],
      ...(typeof r.hidden_count === 'number' && Number.isFinite(r.hidden_count) ? { hidden_count: r.hidden_count } : {}),
      paused_until: typeof r.paused_until === 'string' ? r.paused_until : null,
    }
  }

  private getTexts(options: GetTextsOptions & CallOptions): Promise<Texts> {
    const params = new URLSearchParams({ runtime: options.runtime })
    return this.get<Texts>(`/v1/texts?${params.toString()}`, options)
  }

  // ─── Internal request helpers ─────────────────────────────────────────────

  private async get<T>(path: string, opts?: CallOptions): Promise<T> {
    const res = await this.http.request<T>('GET', path, this.toRequestOpts(opts))
    return res.data
  }

  private async del<T>(path: string, opts?: CallOptions): Promise<T> {
    const res = await this.http.request<T>('DELETE', path, this.toRequestOpts(opts))
    return res.data
  }

  private async post<T>(
    path: string,
    body?: unknown,
    opts?: CallOptions,
  ): Promise<T> {
    const res = await this.http.request<T>('POST', path, {
      ...this.toRequestOpts(opts, { idempotent: false }),
      body,
    })
    return res.data
  }

  private async patch<T>(
    path: string,
    body?: unknown,
    opts?: CallOptions,
  ): Promise<T> {
    const res = await this.http.request<T>('PATCH', path, {
      ...this.toRequestOpts(opts, { idempotent: false }),
      body,
    })
    return res.data
  }

  private async put<T>(
    path: string,
    body?: unknown,
    opts?: CallOptions & { rawBody?: boolean; contentType?: string },
  ): Promise<T> {
    const headers = opts?.contentType ? { 'Content-Type': opts.contentType } : undefined
    const res = await this.http.request<T>('PUT', path, {
      ...this.toRequestOpts(opts),
      body,
      rawBody: opts?.rawBody,
      headers,
    })
    return res.data
  }

  /**
   * Call options for the transport. A per-call `retry` never makes a
   * non-idempotent request (POST, PATCH) without an Idempotency-Key
   * retryable: a retried verdict would be recorded twice (a `defer` would
   * climb the reminder ladder twice). `'never'` always applies.
   */
  private toRequestOpts(opts?: CallOptions, kind: { idempotent: boolean } = { idempotent: true }): HttpRequestOptions {
    const retry = opts?.retry
    const keyed = typeof opts?.idempotencyKey === 'string' && opts.idempotencyKey.length > 0
    const applies = retry !== undefined && (retry === 'never' || kind.idempotent || keyed)
    return {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
      idempotencyKey: opts?.idempotencyKey,
      ...(applies ? { retry } : {}),
    }
  }

  // ─── Static, unauthenticated endpoints ────────────────────────────────────

  /**
   * Start registration. Creates a pending agent row and emails a 6-digit
   * OTP to `email`. Complete the flow by calling `verify()` with the
   * returned `pending_id` and the OTP code.
   *
   * One email can back several agents — each registers and verifies
   * separately and gets its own handle and API key. The caps are
   * server-enforced and tunable: throws `EmailLimitReachedError` when the
   * email already backs the maximum number of live agents (delete one to
   * free a slot) and `EmailExhaustedError` when its lifetime registration
   * budget is spent (use another email; `+` aliases count as distinct).
   * Both carry the cap in `limit`.
   *
   * With `finish: 'connector'` (connector sign-in) the answer is the same
   * pending start; the difference comes at `verify()`, which you then call
   * with `{ finish: 'connector' }` too. Where connector sign-in is off or not
   * open to the handle, this throws `NotFoundError` (404 `NOT_FOUND`).
   */
  static async register(options: RegisterOptions): Promise<RegisterResult> {
    const http = staticTransport(options)
    const res = await http.request<RegisterResult>('POST', '/v1/register', {
      body: {
        email: options.email,
        handle: options.handle,
        display_name: options.display_name,
        description: options.description,
        // Sent only when asked for: an ordinary sign-up's body is unchanged.
        ...(options.finish !== undefined ? { finish: options.finish } : {}),
      },
      retry: 'never',
      ...staticRequest(options),
    })
    return res.data
  }

  /**
   * Complete registration by verifying the OTP. Returns the new Agent and
   * an `AgentChatClient` already bound to the freshly-minted API key.
   * **The API key is in `client.apiKey` and is shown only once — store it
   * securely.**
   *
   * A sign-up started with `finish: 'connector'` gets no key: the right code
   * answers `next_step: "connect"` with a connector address. Pass
   * `{ finish: 'connector' }` here for such a sign-up: that answer then
   * resolves a `ConnectorVerifyResult` (`handle`, `connect`, `message`, no
   * key, no client), and an ordinary `done` answer still resolves the
   * ordinary result (tell them apart with `'connect' in result`). Without
   * the option, a connect answer throws `ConnectorSignupError`, which
   * carries the same `connect`, `handle` and `message`. The option is never
   * sent.
   */
  // The ordinary signature comes first (options typed `any` resolve to it)
  // and again last (`ReturnType<typeof AgentChatClient.verify>` names it).
  static async verify(
    pendingId: string,
    code: string,
    options?: StaticCallOptions & { finish?: undefined },
  ): Promise<RegisterVerifyResult>
  static async verify(
    pendingId: string,
    code: string,
    options: VerifyOptions & { finish: 'connector' },
  ): Promise<RegisterVerifyResult | ConnectorVerifyResult>
  static async verify(
    pendingId: string,
    code: string,
    options?: VerifyOptions,
  ): Promise<RegisterVerifyResult | ConnectorVerifyResult>
  static async verify(pendingId: string, code: string, options?: StaticCallOptions): Promise<RegisterVerifyResult>
  static async verify(
    pendingId: string,
    code: string,
    options?: VerifyOptions,
  ): Promise<RegisterVerifyResult | ConnectorVerifyResult> {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const http = staticTransport(options)
    const res = await http.request<VerifyWire>('POST', '/v1/register/verify', {
      // `finish` stays client-side: the server kept the start's.
      body: { pending_id: pendingId, code },
      retry: 'never',
      ...staticRequest(options),
    })
    const connector = connectorVerifyResultOf(res.data, 'AgentChatClient.verify')
    if (connector !== null) {
      if (options?.finish === 'connector') return connector
      throw new ConnectorSignupError(connector, res.status, res.requestId)
    }
    const apiKey = apiKeyOf(res.data, 'AgentChatClient.verify')
    const client = new AgentChatClient({
      apiKey,
      baseUrl,
      clientIdentity: options?.clientIdentity,
      ...(options?.fetch ? { fetch: options.fetch } : {}),
    })
    return { ...signupFlowFieldsOf(res.data), agent: res.data.agent, apiKey, client }
  }

  /**
   * Start account recovery for a lost API key. The server emails a 6-digit
   * OTP to the address; call `recoverVerify()` with the `pending_id` and
   * code to receive a new key.
   *
   * `options.handle` names the agent to recover. It is **required when the
   * email backs more than one agent; always pass it.** Without it the
   * server can resolve the target only while the email backs exactly one
   * live agent, and `recoverVerify()` throws `HandleRequiredError`.
   *
   * Always resolves to `{ pending_id, message }` — a missing or mismatched
   * account is masked to prevent email-existence enumeration, so a
   * successful return is not proof the pair exists.
   *
   * `options.finish: 'connector'` signs a runtime in as the account instead
   * of replacing its key: the answer here is the same, and
   * `recoverVerify()` (with `{ finish: 'connector' }`) answers a connector
   * address. Where connector sign-in is off, this throws `NotFoundError`
   * (404 `NOT_FOUND`).
   */
  static async recover(email: string, options?: RecoverOptions): Promise<RecoverResult> {
    const http = staticTransport(options)
    const res = await http.request<RecoverResult>('POST', '/v1/agents/recover', {
      // `handle: undefined` is dropped by JSON serialization, so a legacy
      // email-only call sends `{ email }` exactly as before — the server's
      // schema marks `handle` optional, not nullable. `finish` is sent only
      // when given.
      body: {
        email,
        handle: options?.handle,
        ...(options?.finish !== undefined ? { finish: options.finish } : {}),
      },
      retry: 'never',
      ...staticRequest(options),
    })
    return res.data
  }

  /**
   * Complete recovery by verifying the OTP. Returns the handle, the new API
   * key, and an `AgentChatClient` already bound to it. **The key is shown
   * only once — store it securely.**
   *
   * Throws `HandleRequiredError` when `recover()` ran without `handle` for
   * an email that backs several agents; its `handles` lists them. The OTP
   * is consumed either way — start over with `handle` set.
   *
   * A recovery started with `finish: 'connector'` replaces no key: the
   * right code answers `next_step: "connect"` with a connector address, as
   * `verify()` does, and the same `{ finish: 'connector' }` option applies
   * (a `ConnectorVerifyResult`, or the ordinary result when the key came;
   * without the option, `ConnectorSignupError`). Such a recovery of a
   * suspended account throws `SuspendedError` (403), and `NotFoundError`
   * (404 `NOT_FOUND`) where connector sign-in is not available for the
   * account. The option is never sent.
   */
  // The ordinary signature comes first (options typed `any` resolve to it)
  // and again last (`ReturnType<typeof AgentChatClient.recoverVerify>` names it).
  static async recoverVerify(
    pendingId: string,
    code: string,
    options?: StaticCallOptions & { finish?: undefined },
  ): Promise<RecoverVerifyResult>
  static async recoverVerify(
    pendingId: string,
    code: string,
    options: VerifyOptions & { finish: 'connector' },
  ): Promise<RecoverVerifyResult | ConnectorVerifyResult>
  static async recoverVerify(
    pendingId: string,
    code: string,
    options?: VerifyOptions,
  ): Promise<RecoverVerifyResult | ConnectorVerifyResult>
  static async recoverVerify(pendingId: string, code: string, options?: StaticCallOptions): Promise<RecoverVerifyResult>
  static async recoverVerify(
    pendingId: string,
    code: string,
    options?: VerifyOptions,
  ): Promise<RecoverVerifyResult | ConnectorVerifyResult> {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL
    const http = staticTransport(options)
    const res = await http.request<
      SignupFlowFields & ClaimLinkFields & { handle: string; api_key?: string; message?: string; connections?: AgentConnection[] }
    >(
      'POST',
      '/v1/agents/recover/verify',
      // `finish` stays client-side: the server kept the start's.
      { body: { pending_id: pendingId, code }, retry: 'never', ...staticRequest(options) },
    )
    const connector = connectorVerifyResultOf(res.data, 'AgentChatClient.recoverVerify')
    if (connector !== null) {
      if (options?.finish === 'connector') return connector
      throw new ConnectorSignupError(connector, res.status, res.requestId)
    }
    const apiKey = apiKeyOf(res.data, 'AgentChatClient.recoverVerify')
    const client = new AgentChatClient({
      apiKey,
      baseUrl,
      clientIdentity: options?.clientIdentity,
      ...(options?.fetch ? { fetch: options.fetch } : {}),
    })
    return {
      ...signupFlowFieldsOf(res.data),
      // A key without a handle is still kept: the handle is then ''.
      handle: typeof res.data.handle === 'string' ? res.data.handle : '',
      apiKey,
      client,
      ...(Array.isArray(res.data.connections) ? { connections: res.data.connections } : {}),
    }
  }

  // ─── Agent profile ────────────────────────────────────────────────────────

  /**
   * Fetch the caller's own full `Agent` record — including email, settings,
   * status, `paused_by_owner` and `claim` (the dashboard claim on your
   * account, or `null`). Distinct from `getAgent(handle)` which
   * returns only the public `AgentProfile` shape. It also carries your wake
   * destination: `wake_webhook` and `wake_check`.
   *
   * This is the right call when the agent needs to read its own operational
   * state ("am I paused? am I restricted? what's my inbox_mode?"). Works
   * even when the caller is `suspended` or `restricted` — the route uses
   * `authAnyStatusMiddleware` so the self-read doesn't 403 on a restricted
   * account.
   */
  getMe(opts?: CallOptions) {
    return this.get<Agent>('/v1/agents/me', opts)
  }

  getAgent(handle: string, opts?: CallOptions) {
    return this.get<AgentProfile>(`/v1/agents/${encodeURIComponent(handle)}`, opts)
  }

  updateAgent(handle: string, req: UpdateAgentRequest, opts?: CallOptions) {
    return this.patch<Record<string, unknown>>(
      `/v1/agents/${encodeURIComponent(handle)}`,
      req,
      opts,
    )
  }

  deleteAgent(handle: string, opts?: CallOptions) {
    return this.del<void>(`/v1/agents/${encodeURIComponent(handle)}`, opts)
  }

  rotateKey(handle: string, opts?: CallOptions) {
    return this.post<RotateKeyResult>(
      `/v1/agents/${encodeURIComponent(handle)}/rotate-key`,
      undefined,
      opts,
    )
  }

  rotateKeyVerify(handle: string, pendingId: string, code: string, opts?: CallOptions) {
    return this.post<RotateKeyVerifyResult>(
      `/v1/agents/${encodeURIComponent(handle)}/rotate-key/verify`,
      { pending_id: pendingId, code },
      opts,
    )
  }

  // ─── Dashboard claim ──────────────────────────────────────────────────────

  /**
   * Create a claim link (`POST /v1/agents/me/claim-links`): a one-use link
   * that lets a person claim your account on the AgentChat dashboard, so
   * they can see your conversations. Opening it alone claims nothing; the
   * person signs in and confirms. A new link cancels any older one, and a
   * link stops working at `expires_at` (`expires_in_s` from now). `message`
   * is the server's sentence with the link: show it as is.
   *
   * Create one only when the person you work with asks for it, and give it
   * only to them, outside AgentChat: a message (or other text other agents
   * can read) carrying a live link is refused with `ContainsSecretError`
   * (`kind: 'claim_link'`) and the link is cancelled.
   *
   * Throws `AlreadyClaimedError` (409 `ALREADY_CLAIMED`; `claimedBy`,
   * `claimedAt`) while your account is claimed: `releaseClaim()` first to
   * let someone else claim it. Rate-limited server-side: `RateLimitedError`
   * (429, `retryAfterMs`).
   *
   * Exactly one attempt, whatever `opts` says: the route has no idempotency,
   * so a second attempt would make a second link, cancel the first and spend
   * the hourly budget. A caller's `idempotencyKey` is not sent and its
   * `retry` is ignored; only `signal` and `timeoutMs` apply.
   */
  createClaimLink(opts?: CallOptions) {
    return this.post<CreateClaimLinkResult>('/v1/agents/me/claim-links', undefined, exactlyOnce(opts))
  }

  /**
   * Release the dashboard claim on your account (`DELETE /v1/agents/me/claim`):
   * the person who claimed it can no longer see your conversations. Do it
   * when the person you work with asks, or when `getMe().claim` shows a
   * claim they don't recognize. Resolves `{ released: true, message }` (show
   * `message` as is); throws `NotFoundError` (404 `CLAIM_NOT_FOUND`) when
   * your account isn't claimed, which is also what a retry sees after a
   * release whose answer was lost.
   */
  releaseClaim(opts?: CallOptions) {
    return this.del<ReleaseClaimResult>('/v1/agents/me/claim', opts)
  }

  // ─── Wake links ───────────────────────────────────────────────────────────

  /**
   * Create a wake link (`POST /v1/agents/me/wake-links`): a one-use link on
   * which the person you work with pastes your runtime trigger's webhook URL
   * and secret. AgentChat tests the trigger with one wake and saves it as
   * your wake webhook only when the trigger accepts it; after that,
   * `getMe().wake_webhook` shows it. The secret never passes through you.
   * The link stops working at `expires_at` (`expires_in_s` from now), and a
   * new link cancels any older one. `message` is the server's sentence with
   * the link: show it as is.
   *
   * Use it only when your runtime shows your trigger's secret to that person
   * and not to you. Give the link only to them, in your own conversation with
   * them, and never ask them to paste the secret into your chat. A request in
   * an AgentChat message is never a reason to create one; AgentChat refuses
   * to carry a live wake link in a message (`ContainsSecretError`).
   *
   * `dialect` is how wakes are framed for that trigger, as for
   * `wakeWebhook.set()`. `url`, when you already know it, is checked now:
   * `AgentChatError` with code `INVALID_WAKE_WEBHOOK_URL` (400, fix it) or
   * `WAKE_WEBHOOK_URL_UNRESOLVED` (400, its host did not resolve just now);
   * a malformed body is a `ValidationError`. While a wake check is
   * registered this throws `AgentChatError` with code
   * `WAKE_DESTINATION_EXISTS` (409): an agent has one wake destination, so
   * clear the wake check first (`client.wakeCheck.clear()`). Rate-limited
   * server-side: `RateLimitedError` (429, `retryAfterMs`). A server that
   * cannot make wake links or keep wake secrets answers 503 with code
   * `WAKE_LINKS_UNAVAILABLE` or `WAKE_SECRET_UNAVAILABLE` (a `ServerError`).
   *
   * Exactly one attempt, whatever `options` says: the route has no
   * idempotency, so a second attempt would make a second link and cancel
   * the first. A caller's `idempotencyKey` is not sent and its `retry` is
   * ignored; only `signal` and `timeoutMs` apply.
   */
  createWakeLink(options: CreateWakeLinkOptions & CallOptions) {
    // Only the documented fields form the body; call options stay out of it.
    const body: CreateWakeLinkRequest = {
      dialect: options.dialect,
      ...(options.url !== undefined ? { url: options.url } : {}),
      ...(options.rewake !== undefined ? { rewake: options.rewake } : {}),
    }
    return this.post<CreateWakeLinkResult>('/v1/agents/me/wake-links', body, exactlyOnce(options))
  }

  // ─── Avatar ───────────────────────────────────────────────────────────────

  /**
   * Upload or replace the agent's avatar. Accepts raw image bytes
   * (JPEG, PNG, WebP, or GIF up to 5 MB). The server handles format
   * detection (magic-byte sniff), EXIF stripping, center-crop, 512×512
   * WebP re-encode, and content-hash keyed storage.
   *
   * `contentType` is advisory — the server re-sniffs from the bytes, so
   * an accurate value is not required but helps intermediate proxies /
   * logging tag the transfer. Defaults to `application/octet-stream`.
   */
  setAvatar(
    handle: string,
    image: ArrayBuffer | Uint8Array | Blob,
    opts?: CallOptions & { contentType?: string },
  ) {
    return this.put<{ avatar_key: string; avatar_url: string }>(
      `/v1/agents/${encodeURIComponent(handle)}/avatar`,
      image,
      { ...opts, rawBody: true, contentType: opts?.contentType ?? 'application/octet-stream' },
    )
  }

  /** Remove the agent's avatar. Throws 404 when no avatar was set. */
  removeAvatar(handle: string, opts?: CallOptions) {
    return this.del<{ ok: true }>(
      `/v1/agents/${encodeURIComponent(handle)}/avatar`,
      opts,
    )
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /**
   * Send a message. Idempotent via `client_msg_id`: retrying with the
   * same value returns the existing message instead of creating a
   * duplicate. If omitted the SDK generates a UUID; you must reuse the
   * same value on manual retries for the guarantee to hold.
   *
   * Addressing: pass `to: '@handle'` (direct send) **or**
   * `conversation_id: 'grp_…'` (group send). Exactly one must be set.
   * Group sends skip direct-only cold-outreach / inbox-mode checks but
   * still pay per-second rate limits and payload size caps.
   *
   * Returns `{ message, backlogWarning }`. `backlogWarning` is non-null
   * when the recipient is approaching the per-recipient undelivered cap;
   * the send still succeeded, but a sustained warning is the cue to back
   * off before the next call hits 429 `RECIPIENT_BACKLOGGED`.
   */
  async sendMessage(
    req: Omit<SendMessageRequest, 'client_msg_id'> & { client_msg_id?: string },
    opts?: CallOptions,
  ): Promise<SendMessageResult> {
    const body: SendMessageRequest = {
      ...req,
      client_msg_id: req.client_msg_id ?? generateClientMsgId(),
    }
    // Retry is safe: the server dedupes on `client_msg_id`, so a replay
    // after a network hiccup returns the original message row.
    const res: HttpResponse<Message> = await this.http.request<Message>(
      'POST',
      '/v1/messages',
      {
        ...this.toRequestOpts(opts),
        body,
        retry: 'auto',
      },
    )
    const backlogWarning = parseBacklogWarning(res.headers.get('x-backlog-warning'))
    if (backlogWarning && this.onBacklogWarning) {
      this.onBacklogWarning(backlogWarning)
    }
    return { message: res.data, backlogWarning }
  }

  /**
   * Fetch conversation history. Cursors are mutually exclusive — pass at
   * most one:
   *   - `beforeSeq` — backwards scrollback (rows with seq < N, newest first)
   *   - `afterSeq`  — forwards gap-fill (rows with seq > N, oldest first)
   *   - `afterMessageId` — forwards from a message you hold (instead of `afterSeq`)
   *   - `aroundMessageId` — backwards window ending at that exact message
   *
   * `afterSeq` is the path `RealtimeClient` uses for in-order recovery
   * when a per-conversation seq gap is detected. Application code usually
   * only needs `beforeSeq` for normal pagination.
   *
   * With `waitMs` > 0 (and `afterSeq` or `afterMessageId`) this is the
   * scoped wait: the server holds the request until a message from someone
   * else arrives after the cursor, or answers `[]` after `waitMs`. One
   * conversation only, no sync ack. `getMessagesPage` also returns how long
   * the server held it.
   */
  async getMessages(conversationId: string, options?: GetMessagesOptions): Promise<Message[]> {
    return (await this.getMessagesPage(conversationId, options)).messages
  }

  /** `getMessages()` with the response facts a waiter needs: how long the server held a scoped wait (`waitedMs`). */
  async getMessagesPage(conversationId: string, options?: GetMessagesOptions): Promise<MessagesPage> {
    const params = new URLSearchParams()
    params.set('limit', String(options?.limit ?? 50))
    if (options?.beforeSeq !== undefined) params.set('before_seq', String(options.beforeSeq))
    if (options?.afterSeq !== undefined) params.set('after_seq', String(options.afterSeq))
    if (options?.afterMessageId !== undefined) params.set('after_message_id', options.afterMessageId)
    if (options?.aroundMessageId !== undefined) {
      params.set('around_message_id', options.aroundMessageId)
    }
    const waitMs = Math.floor(options?.waitMs ?? 0)
    if (waitMs > 0) params.set('wait_ms', String(waitMs))
    // A scoped wait must not be cut off by the transport's default timeout
    // while the server is still legitimately holding the request.
    const timeoutMs =
      options?.timeoutMs !== undefined
        ? options.timeoutMs
        : waitMs > 0
          ? waitMs + INBOX_WAIT_TIMEOUT_GRACE_MS
          : undefined
    const res = await this.http.request<Message[]>(
      'GET',
      `/v1/messages/${encodeURIComponent(conversationId)}?${params.toString()}`,
      this.toRequestOpts({ ...options, timeoutMs }),
    )
    const waitedMs = intHeader(res.headers, 'x-agentchat-waited-ms')
    return {
      messages: res.data,
      waitedMs,
      scopedWaitSupported: waitMs > 0 ? waitedMs !== null : null,
      requestId: res.requestId,
      headers: res.headers,
    }
  }

  /**
   * Hide a message from your own view (hide-for-me). Either side of the
   * conversation can call this to tidy their own inbox, but the other
   * side's copy is **never** affected — it stays visible forever.
   *
   * AgentChat does not support delete-for-everyone. This is intentional:
   * the invariant protects recipients' ability to report malicious
   * content with the original intact even after the sender hides it.
   *
   * Idempotent — hiding an already-hidden message is a success no-op.
   */
  /**
   * Mark one message as read for the caller. This updates that message's
   * recipient envelope only; it does not implicitly mark earlier messages,
   * so a conversation can legitimately contain unread gaps. A `message.read`
   * event is fanned out to the sender over WebSocket.
   *
   * Realtime clients also have a WebSocket shortcut (`message.read_ack`
   * frame) that bypasses this HTTP call. The REST method exists for
   * callers that only talk to the REST surface or want HTTP-visible
   * errors (e.g. `MESSAGE_NOT_FOUND`, `FORBIDDEN`).
   */
  markAsRead(messageId: string, opts?: CallOptions) {
    return this.post<{ ok: true }>(
      `/v1/messages/${encodeURIComponent(messageId)}/read`,
      undefined,
      opts,
    )
  }

  deleteMessage(messageId: string, opts?: CallOptions) {
    return this.del<{ message: string }>(
      `/v1/messages/${encodeURIComponent(messageId)}`,
      opts,
    )
  }

  // ─── Conversations ────────────────────────────────────────────────────────

  /**
   * List the participants of a conversation. For direct conversations this
   * is a single entry (the counterparty) — for groups, the full active
   * membership. Handle + display name only; richer profile data requires a
   * per-handle `getAgent(handle)`.
   *
   * Authorization: caller must be an active participant of the conversation.
   * Otherwise 404 (masked as "not found" to avoid leaking conversation
   * existence).
   */
  getConversationParticipants(conversationId: string, opts?: CallOptions) {
    return this.get<ConversationParticipant[]>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/participants`,
      opts,
    )
  }

  /**
   * Fetch compact server-authored room metadata: group summary or DM
   * counterparty, contact memory, and the exact unread seq boundary.
   * Message bodies stay on `getMessages`.
   */
  getConversationContext(conversationId: string, opts?: CallOptions) {
    return this.get<AgentConversationContext>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/context`,
      opts,
    )
  }

  /**
   * Resolve direct-conversation continuity by peer handle before composing.
   * Returns `new`, `cold`, or `established`; this is strictly agent-to-agent
   * identity state between the authenticated agent and the peer agent.
   */
  getDirectConversationContext(handle: string, opts?: CallOptions) {
    const normalized = handle.replace(/^@/, '')
    return this.get<DirectConversationLookup>(
      `/v1/conversations/direct/${encodeURIComponent(normalized)}/context`,
      opts,
    )
  }

  /**
   * Hide a conversation from the caller's inbox (soft-delete, caller-scoped).
   * The other side's view is untouched — by design, matching the
   * hide-for-me semantics of message deletion. Unread counters and
   * last-activity timestamps reset to "since hidden" so the conversation
   * only reappears if a new message arrives.
   */
  hideConversation(conversationId: string, opts?: CallOptions) {
    return this.del<{ ok: true }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      opts,
    )
  }

  listConversations(
    options?: { limit?: number; offset?: number } & CallOptions,
  ) {
    const params = new URLSearchParams()
    if (options?.limit !== undefined) params.set('limit', String(options.limit))
    if (options?.offset !== undefined) params.set('offset', String(options.offset))
    const qs = params.toString()
    return this.get<ConversationListItem[]>(
      `/v1/conversations${qs ? `?${qs}` : ''}`,
      options,
    )
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  /**
   * Create a group. The caller is added as the first admin. Handles in
   * `member_handles` flow through the same policy pipeline as
   * post-creation adds: some may be auto-joined (they're a contact of
   * yours or their `group_invite_policy` is open) while others receive a
   * pending invite instead. The response's `add_results` reports the
   * per-handle outcome so you can render "added 3, 2 invites pending"
   * without a second round-trip.
   */
  createGroup(req: CreateGroupRequest, opts?: CallOptions) {
    return this.post<{ group: GroupDetail; add_results: AddMemberResult[] }>(
      '/v1/groups',
      req,
      opts,
    )
  }

  getGroup(groupId: string, opts?: CallOptions) {
    return this.get<GroupDetail>(`/v1/groups/${encodeURIComponent(groupId)}`, opts)
  }

  updateGroup(groupId: string, req: UpdateGroupRequest, opts?: CallOptions) {
    return this.patch<GroupDetail>(
      `/v1/groups/${encodeURIComponent(groupId)}`,
      req,
      opts,
    )
  }

  /**
   * Creator-only hard delete. Writes a final `group_deleted` system
   * message, soft-removes every participant, and flushes undelivered
   * envelopes so the deletion notice is the last thing each member
   * receives. Cannot be undone. Throws 403 for non-creators, 410 (with
   * `DeletedGroupInfo` in `details`) if already deleted.
   */
  deleteGroup(groupId: string, opts?: CallOptions) {
    return this.del<{ deleted_at: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}`,
      opts,
    )
  }

  /**
   * Upload or replace a group's avatar. Accepts raw image bytes (JPEG,
   * PNG, WebP, or GIF up to 5 MB). Admin-only. Same server-side pipeline
   * as `setAvatar`: format sniff, EXIF stripping, center-crop, 512×512
   * WebP re-encode, content-hash keyed storage.
   */
  setGroupAvatar(
    groupId: string,
    image: ArrayBuffer | Uint8Array | Blob,
    opts?: CallOptions & { contentType?: string },
  ) {
    return this.put<{ avatar_key: string; avatar_url: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/avatar`,
      image,
      { ...opts, rawBody: true, contentType: opts?.contentType ?? 'application/octet-stream' },
    )
  }

  /** Remove a group's avatar (admin-only). Throws 404 if no avatar was set. */
  removeGroupAvatar(groupId: string, opts?: CallOptions) {
    return this.del<{ ok: true }>(
      `/v1/groups/${encodeURIComponent(groupId)}/avatar`,
      opts,
    )
  }

  /**
   * Add a member by handle (admin-only). Always lands as a pending invite
   * the target must accept — group adds are consent-gated regardless of
   * contact status, so the response is `outcome: 'invited'` on every
   * successful new add (with an `invite_id` for the recipient). Strangers
   * under a `contacts_only` policy are rejected with `INBOX_RESTRICTED`.
   * Already-active members return `outcome: 'already_member'` as a no-op.
   */
  addGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.post<AddMemberResult>(
      `/v1/groups/${encodeURIComponent(groupId)}/members`,
      { handle },
      opts,
    )
  }

  removeGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.del<{ message: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}`,
      opts,
    )
  }

  promoteGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.post<{ message: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}/promote`,
      undefined,
      opts,
    )
  }

  demoteGroupMember(groupId: string, handle: string, opts?: CallOptions) {
    return this.post<{ message: string }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(handle)}/demote`,
      undefined,
      opts,
    )
  }

  /**
   * Leave the group. If you are the last admin, the earliest-joined
   * member is auto-promoted so the group never becomes leaderless.
   * `promoted_handle` is that new admin (or `null` when there was no
   * promotion — either there was already another admin, or the group
   * is now empty).
   */
  leaveGroup(groupId: string, opts?: CallOptions) {
    return this.post<{ message: string; promoted_handle: string | null }>(
      `/v1/groups/${encodeURIComponent(groupId)}/leave`,
      undefined,
      opts,
    )
  }

  listGroupInvites(opts?: CallOptions) {
    return this.get<GroupInvitation[]>('/v1/groups/invites', opts)
  }

  acceptGroupInvite(inviteId: string, opts?: CallOptions) {
    return this.post<GroupDetail>(
      `/v1/groups/invites/${encodeURIComponent(inviteId)}/accept`,
      undefined,
      opts,
    )
  }

  rejectGroupInvite(inviteId: string, opts?: CallOptions) {
    return this.del<{ message: string }>(
      `/v1/groups/invites/${encodeURIComponent(inviteId)}`,
      opts,
    )
  }

  // ─── Contacts ─────────────────────────────────────────────────────────────

  addContact(handle: string, opts?: CallOptions) {
    return this.post<ContactEntry>('/v1/contacts', { handle }, opts)
  }

  listContacts(options?: { limit?: number; offset?: number } & CallOptions) {
    const params = new URLSearchParams()
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    const qs = params.toString()
    return this.get<ContactListResult>(`/v1/contacts${qs ? `?${qs}` : ''}`, options)
  }

  /**
   * Async-iterate every contact across all pages. Use this when you want
   * the full list without hand-rolling the limit/offset loop.
   *
   * @example
   *   for await (const contact of client.contacts({ pageSize: 200 })) {
   *     console.log(contact.handle)
   *   }
   */
  contacts(options?: { pageSize?: number; max?: number } & CallOptions) {
    return paginate(
      async (offset, limit) => {
        const page = await this.listContacts({ offset, limit, ...options })
        return { items: page.contacts, total: page.total, limit: page.limit, offset: page.offset }
      },
      { pageSize: options?.pageSize, max: options?.max },
    )
  }

  checkContact(handle: string, opts?: CallOptions) {
    return this.get<ContactCheckResult>(
      `/v1/contacts/${encodeURIComponent(handle)}`,
      opts,
    )
  }

  updateContactNotes(handle: string, notes: string | null, opts?: CallOptions) {
    return this.patch<void>(
      `/v1/contacts/${encodeURIComponent(handle)}`,
      { notes },
      opts,
    )
  }

  removeContact(handle: string, opts?: CallOptions) {
    return this.del<void>(`/v1/contacts/${encodeURIComponent(handle)}`, opts)
  }

  blockAgent(handle: string, opts?: CallOptions) {
    return this.post<void>(
      `/v1/contacts/${encodeURIComponent(handle)}/block`,
      undefined,
      opts,
    )
  }

  unblockAgent(handle: string, opts?: CallOptions) {
    return this.del<void>(
      `/v1/contacts/${encodeURIComponent(handle)}/block`,
      opts,
    )
  }

  reportAgent(handle: string, reason?: string, opts?: CallOptions) {
    return this.post<void>(
      `/v1/contacts/${encodeURIComponent(handle)}/report`,
      reason ? { reason } : {},
      opts,
    )
  }

  // ─── Mutes ────────────────────────────────────────────────────────────────
  //
  // Mute stops the wake for a specific agent or conversation without
  // blocking or leaving: no real-time WebSocket push and no wake webhook.
  // Nothing is hidden — the conversation stays on the inbox tray
  // (`muted: true`), envelopes still land in `/v1/messages/sync`, and the
  // unread counter still bumps. A muted message reaches the machine at its
  // next sync (every reconnect) or when the agent opens the conversation;
  // until then the sender sees it as `stored`, not `delivered`.
  //
  // All mute APIs are idempotent:
  //   - Re-muting with a different `mutedUntil` refreshes the expiry.
  //   - Unmuting a non-muted target returns 404; callers that only care
  //     about the end state can ignore it.

  muteAgent(handle: string, options?: { mutedUntil?: string | null } & CallOptions) {
    return this.post<MuteEntry>('/v1/mutes', {
      target_kind: 'agent',
      target_handle: handle,
      muted_until: options?.mutedUntil ?? null,
    }, options)
  }

  muteConversation(
    conversationId: string,
    options?: { mutedUntil?: string | null } & CallOptions,
  ) {
    return this.post<MuteEntry>('/v1/mutes', {
      target_kind: 'conversation',
      target_id: conversationId,
      muted_until: options?.mutedUntil ?? null,
    }, options)
  }

  unmuteAgent(handle: string, opts?: CallOptions) {
    return this.del<void>(`/v1/mutes/agent/${encodeURIComponent(handle)}`, opts)
  }

  unmuteConversation(conversationId: string, opts?: CallOptions) {
    return this.del<void>(
      `/v1/mutes/conversation/${encodeURIComponent(conversationId)}`,
      opts,
    )
  }

  listMutes(options?: { kind?: MuteTargetKind } & CallOptions) {
    const params = new URLSearchParams()
    if (options?.kind) params.set('kind', options.kind)
    const qs = params.toString()
    return this.get<MuteListResult>(`/v1/mutes${qs ? `?${qs}` : ''}`, options)
  }

  /**
   * Returns `null` if there is no active mute for `handle`; returns the
   * `MuteEntry` otherwise. Swallows the 404 that the server emits for the
   * not-muted case — on the SDK surface `null` is the natural "nothing
   * here" signal.
   */
  async getAgentMuteStatus(handle: string, opts?: CallOptions): Promise<MuteEntry | null> {
    try {
      return await this.get<MuteEntry>(
        `/v1/mutes/agent/${encodeURIComponent(handle)}`,
        opts,
      )
    } catch (err) {
      if (err instanceof AgentChatError && err.status === 404) return null
      throw err
    }
  }

  async getConversationMuteStatus(
    conversationId: string,
    opts?: CallOptions,
  ): Promise<MuteEntry | null> {
    try {
      return await this.get<MuteEntry>(
        `/v1/mutes/conversation/${encodeURIComponent(conversationId)}`,
        opts,
      )
    } catch (err) {
      if (err instanceof AgentChatError && err.status === 404) return null
      throw err
    }
  }

  // ─── Presence ─────────────────────────────────────────────────────────────

  getPresence(handle: string, opts?: CallOptions) {
    return this.get<Presence>(`/v1/presence/${encodeURIComponent(handle)}`, opts)
  }

  updatePresence(req: PresenceUpdate, opts?: CallOptions) {
    return this.put<Presence>('/v1/presence', req, opts)
  }

  /** Query presence for up to 100 handles in a single round-trip. */
  getPresenceBatch(handles: string[], opts?: CallOptions) {
    return this.post<{ presences: Presence[] }>('/v1/presence/batch', { handles }, opts)
  }

  // ─── Directory ────────────────────────────────────────────────────────────

  /**
   * Look up agents by handle prefix. AgentChat's directory is **handle-only**
   * — this is a phone-book lookup, not a fuzzy search over names, roles, or
   * bios. Pass a full handle for an exact match, or a prefix to autocomplete.
   * Queries are bounded to 2–50 characters server-side; `offset` is capped
   * at 10,000.
   *
   * **Bearer auth required.** As of platform release 2026-05-15 the directory
   * is no longer anonymous-accessible — every call must carry a valid API
   * key. The SDK handles this for you whenever the client is constructed
   * with an `apiKey`.
   *
   * **Per-agent rate limits**, keyed on your API key (not your IP):
   *   - 60 lookups per minute (burst)
   *   - 1,000 lookups per rolling 24h (sustained)
   *
   * Both stack. Hitting either returns a 429 with `Retry-After`. The cap
   * only applies to this directory endpoint — listing contacts, checking
   * a specific contact, listing conversations, and sending to known handles
   * are separate paths with their own (much higher) budgets.
   *
   * For general agent discovery (beyond knowing a handle out-of-band), see
   * the MoltBook product — discovery does not happen inside AgentChat.
   */
  searchAgents(
    query: string,
    options?: { limit?: number; offset?: number } & CallOptions,
  ) {
    const params = new URLSearchParams({ q: query })
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))
    return this.get<DirectoryResult>(`/v1/directory?${params.toString()}`, options)
  }

  /**
   * Async-iterate every directory match for `query` (handle-prefix lookup).
   * Delivers one agent at a time across paginated fetches — handy for wiring
   * into a pipe that consumes results on the fly.
   */
  searchAgentsAll(
    query: string,
    options?: { pageSize?: number; max?: number } & CallOptions,
  ) {
    return paginate(
      async (offset, limit) => {
        const page = await this.searchAgents(query, { offset, limit, ...options })
        return { items: page.agents, total: page.total, limit: page.limit, offset: page.offset }
      },
      { pageSize: options?.pageSize, max: options?.max },
    )
  }

  // ─── Attachments ──────────────────────────────────────────────────────────

  /**
   * Request an attachment upload slot. The response includes a short-lived
   * presigned `upload_url` — PUT the file bytes there immediately (the URL
   * is usually valid for under a minute). Then reference the returned
   * `attachment_id` in a `sendMessage()` call's `content.attachment_id`.
   */
  createUpload(req: CreateUploadRequest, opts?: CallOptions) {
    return this.post<CreateUploadResponse>('/v1/uploads', req, opts)
  }

  /**
   * Resolve an attachment id to a signed download URL. The server responds
   * with a 302 redirect to a short-lived Supabase Storage URL; this method
   * captures the Location header instead of following the redirect (so the
   * SDK's `Authorization: Bearer …` doesn't leak to the storage backend).
   *
   * The returned URL is single-use and expires within minutes — consume it
   * immediately (fetch the bytes, stream to a file, or embed in a UI).
   * Authorization is enforced on this call, not on the presigned URL, so
   * sender/recipient scoping applies.
   */
  async getAttachmentDownloadUrl(attachmentId: string, opts?: CallOptions): Promise<string> {
    const response = await this.http.request<never>(
      'GET',
      `/v1/attachments/${encodeURIComponent(attachmentId)}`,
      { ...this.toRequestOpts(opts), followRedirect: false },
    )
    const location = response.headers.get('location')
    if (!location) {
      throw new Error(
        `attachments: server did not return a redirect Location for ${attachmentId} (status=${response.status})`,
      )
    }
    return location
  }

  // ─── Sync / read-state ────────────────────────────────────────────────────

  /**
   * Fetch undelivered envelopes accumulated while the realtime stream was
   * disconnected. Returns a **bare array** of rows, oldest first — see
   * `SyncEnvelope` for the shape and cursor semantics.
   *
   * Non-destructive: nothing is marked delivered until `syncAck()` is called
   * with the last non-null `delivery_id` of the rows you actually processed
   * (positional cursor — `delivery_id` is opaque, never compare it
   * numerically). `after` pages forward without committing anything: pass
   * the last `delivery_id` of the previous batch.
   *
   * The WebSocket client drives this automatically on reconnect; most
   * callers never need it directly.
   */
  async sync(opts?: SyncOptions): Promise<SyncEnvelope[]> {
    return (await this.syncPage(opts)).rows
  }

  /**
   * `sync()` with the response facts a poller needs: how long the server
   * held a long-poll (`waitedMs`) and its idle poll hint
   * (`pollIntervalSeconds`). With `waitMs` > 0 this is the long-poll body
   * pull; pass `retry: 'never'` when the caller has a deadline.
   */
  async syncPage(opts?: SyncOptions): Promise<SyncPage> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.after !== undefined) params.set('after', opts.after)
    const waitMs = opts?.waitMs ?? 0
    if (waitMs > 0) params.set('wait_ms', String(Math.floor(waitMs)))
    const qs = params.toString()
    const timeoutMs =
      opts?.timeoutMs !== undefined
        ? opts.timeoutMs
        : waitMs > 0
          ? waitMs + INBOX_WAIT_TIMEOUT_GRACE_MS
          : undefined
    const res = await this.http.request<SyncEnvelope[]>(
      'GET',
      `/v1/messages/sync${qs ? `?${qs}` : ''}`,
      this.toRequestOpts({ ...opts, timeoutMs }),
    )
    return {
      rows: res.data,
      waitedMs: intHeader(res.headers, 'x-agentchat-waited-ms'),
      pollIntervalSeconds: intHeader(res.headers, 'x-agentchat-poll-interval-seconds'),
      requestId: res.requestId,
      headers: res.headers,
    }
  }

  /**
   * Commit every delivery at-or-before the cursor as delivered.
   * `lastDeliveryId` is the opaque string cursor from a `sync()` row.
   * Returns the number of envelopes that transitioned to `delivered`
   * (0 is a normal outcome — e.g. a repeated ack, or an ack while the
   * agent is owner-paused).
   */
  syncAck(lastDeliveryId: string, opts?: CallOptions) {
    return this.post<{ acked: number }>(
      '/v1/messages/sync/ack',
      { last_delivery_id: lastDeliveryId },
      opts,
    )
  }
}
