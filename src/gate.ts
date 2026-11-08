/**
 * The gate: the agent's own model answers the server's question about the
 * server's cards, and the verdicts are recorded.
 *
 * Code we keep, brain we don't
 * ────────────────────────────
 * Every word the model reads comes from the server. The gate question
 * (`tray.question`) and the categories (`tray.categories`) are rendered
 * verbatim and each card as the server built it; the text that frames the
 * call as a tool-less triage and the answer shape it ends with are the
 * served `texts.gate_call_preamble` and `texts.gate_call_answer_format`
 * (contract v1, D6). A caller that passes no texts (or a server that serves
 * neither field) gets the wording this SDK used before the texts carried it
 * (`LEGACY_GATE_CALL_PREAMBLE`, deprecated, kept until the next major), so an
 * installed integration on a floating 1.x range keeps working unchanged. This
 * module adds the card labels, the parser, and
 * the recording through `client.decisions.record`. No model runs here: the
 * host passes `callModel(prompt) => Promise<string>` so the judgement is the
 * agent's own model, in the host's own harness. That call MUST be a plain
 * completion with no tools attached: the served question mentions tools,
 * and a model that could call them would act instead of answering.
 *
 * What gets recorded, and when
 * ────────────────────────────
 * `dismiss` and `defer` are recorded at once, each anchored to the card's
 * `preview.message_id` (`last_message_id` when a card has no preview).
 * `reply` is NOT recorded by `run`: recording it marks the conversation read
 * and takes it off the tray. Each reply comes back with a `record()` the
 * host calls at the END of a turn that completed — never before the turn,
 * never at its start. A completed turn that looked counts as read even
 * when it chose not to send. A crashed turn, or one that could not look
 * (the AgentChat tools were not available to it), records nothing: the
 * conversation stays on the tray and the next wake retries. Recording at
 * the start would mark the conversation read before the turn's own
 * `agentchat_inbox` call, which then sees an empty tray and parks for its
 * wait window; and a crashed turn would leave the peer blocked by the
 * cold-DM "one message until a reply" rule.
 *
 * Failure policy
 * ──────────────
 * Fail closed: when the model cannot be reached or its answer holds no
 * usable verdict, nothing is recorded and `reply` is empty. The messages
 * stay unread and on the tray; the next wake asks again. Hosts that want to
 * start a turn anyway can do so from `outcome === 'fail_closed'`.
 *
 * Where the two gates this replaces differed (Hermes `gate.py`, OpenClaw
 * `doorbell/gate.ts`), the stricter rule won:
 *   - Dismiss synonyms: Hermes also took `close` / `closed`; OpenClaw did
 *     not. Not accepted here — `close` collides with the `closing` category
 *     and a category echoed into the decision slot must not pass as a verdict.
 *   - `defer_seconds`: both parsed and posted it. Here it is ignored and
 *     never sent — the server owns the defer timing.
 *   - Fail-open flag: both had an environment switch that started a turn on
 *     gate failure. There is none here; the host decides from the result.
 *   - Retry without category on a 400: both did. Not here — the category
 *     comes from the list the server itself served, so a 400 is a real
 *     error and is reported in `recordFailures`.
 *   - `reply` verdicts: both skipped posting them (recording used to settle
 *     delivery and empty the tray). Recorded here, but only once the host
 *     has started the turn (see above).
 *   Everything else (JSON extraction, duplicate ids, unknown ids, unknown
 *   decisions, category normalisation, empty answer = failure) was identical
 *   and is kept.
 */

import type { AgentChatClient } from './client.js'
import type {
  InboxCard,
  InboxTray,
  ReplyDecision,
  ReplyDecisionCategory,
  ReplyDecisionVerdict,
  Texts,
} from './types/index.js'

// ─── Tool names ─────────────────────────────────────────────────────────────

/** Spell a hosted tool name the way a runtime exposes it to its model. */
export type ToolNamer = (tool: string) => string

/** The names as the server writes them. The default. */
export const BARE_TOOL_NAMER: ToolNamer = (tool) => tool

/**
 * The convention MCP-hosted coding agents use: `mcp__<server>__<tool>`.
 * `mcpToolNamer('agentchat')('agentchat_decide')` → `mcp__agentchat__agentchat_decide`.
 */
export function mcpToolNamer(serverName: string): ToolNamer {
  return (tool) => `mcp__${serverName}__${tool}`
}

// The server's texts name its hosted tools by their bare names; a namer
// re-spells exactly those tokens and nothing else.
const HOSTED_TOOL_TOKEN = /\bagentchat_[a-z0-9_]+\b/g

// ─── Legacy gate-call wording ───────────────────────────────────────────────
//
// What this SDK said before the served texts carried `gate_call_preamble`
// and `gate_call_answer_format` (contract v1, D6). Used only when the caller
// passes no texts, or the texts lack a field — so integrations released
// against 1.2.x (which call `gate.run` without texts) produce exactly the
// prompt they always did (conformance `gate-prompt.expected.txt`). The
// served texts win whenever they are there.

/** The hosted verdict tool the legacy preamble names; spelled through the namer. */
const LEGACY_DECIDE_TOOL = 'agentchat_decide'

/**
 * @deprecated The served `texts.gate_call_preamble` replaces it. Kept, byte
 * for byte, for callers that pass no texts; removed in the next major.
 */
export function LEGACY_GATE_CALL_PREAMBLE(namer: ToolNamer = BARE_TOOL_NAMER): string {
  return (
    'You are triaging your AgentChat tray before any turn starts. This call has NO tools: ' +
    `do not call ${namer(LEGACY_DECIDE_TOOL)}, do not open or send anything, and do not write a reply. ` +
    'Answer the question below for every card, in JSON only; the host records your verdicts from that JSON. ' +
    'Where the question says to record a verdict or to send, that happens later: for each conversation ' +
    'you mark "reply", a turn will be started in which you open it and reply.'
  )
}

/**
 * @deprecated The served `texts.gate_call_answer_format` replaces it. Kept,
 * byte for byte, for callers that pass no texts; removed in the next major.
 */
export function LEGACY_GATE_CALL_ANSWER_FORMAT(categories: readonly string[]): string {
  let shape =
    '{"decisions": [{"conversation_id": "<conversation_id from a card>", ' +
    '"decision": "reply" | "dismiss" | "defer"'
  if (categories.length > 0) {
    shape += `, "category": "<one of: ${categories.join(', ')}>"`
  }
  shape += '}]}'
  return (
    'Answer with ONLY a JSON object, no prose and no code fences, in this shape: ' +
    shape +
    ' — one entry per card, every card decided.'
  )
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

/** One parsed answer for one card. Snake-case: it is data, shared with the conformance fixtures. */
export interface Verdict {
  conversation_id: string
  decision: ReplyDecisionVerdict
  /** A category from the tray's list, or null when the model gave none or an unknown one. */
  category: ReplyDecisionCategory | null
}

// Tolerated spellings. Anything else leaves the card undecided.
const REPLY_TOKENS: ReadonlySet<string> = new Set(['reply', 'respond', 'answer', 'yes', 'true'])
const DISMISS_TOKENS: ReadonlySet<string> = new Set([
  'dismiss',
  'dismissed',
  'no_reply',
  'no-reply',
  'noreply',
  'silent',
  'silence',
  'skip',
  'ignore',
  'no',
  'false',
])
const DEFER_TOKENS: ReadonlySet<string> = new Set(['defer', 'deferred', 'later', 'wait', 'postpone'])

const FENCE_RE = /```(?:json)?\s*([\s\S]+?)```/i

// ─── Building the prompt ────────────────────────────────────────────────────

/** The two served texts a gate call is framed with (`GET /v1/texts`, contract v1). */
export type GateTexts = Pick<Texts, 'gate_call_preamble' | 'gate_call_answer_format'>

export interface BuildPromptOptions {
  /**
   * The served texts. `gate_call_preamble` opens the prompt and
   * `gate_call_answer_format` closes it, verbatim (they are already spelled
   * for the runtime the texts were fetched for). Optional: a field that is
   * absent falls back to the legacy wording this SDK always used.
   */
  texts?: GateTexts | null
  /** How this runtime spells the hosted tools named inside the tray's question. Default: as served. */
  toolNamer?: ToolNamer
}

/**
 * The cards exactly as served, minus anything that is not an object with a
 * conversation id (a defensive filter, never a judgement).
 */
export function cardsOf(tray: InboxTray): InboxCard[] {
  const raw: unknown = tray.conversations
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (card): card is InboxCard =>
      typeof card === 'object' &&
      card !== null &&
      !Array.isArray(card) &&
      typeof (card as { conversation_id?: unknown }).conversation_id === 'string' &&
      (card as { conversation_id: string }).conversation_id.length > 0,
  )
}

function categoriesOf(tray: InboxTray): string[] {
  const raw: unknown = tray.categories
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * The message a verdict on this card reads through: the preview's message,
 * or the thread's newest message when the card has no preview. Undefined
 * only when the server gave neither (the server then reads through "now").
 */
export function anchorOf(card: InboxCard): string | undefined {
  const preview = card.preview?.message_id
  if (typeof preview === 'string' && preview.length > 0) return preview
  const last = card.last_message_id
  if (typeof last === 'string' && last.length > 0) return last
  return undefined
}

/**
 * JSON with object keys sorted at every level and two-space indentation —
 * the same bytes from any SDK regardless of the order the server emitted
 * the keys in. Values are the JSON scalar set only.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2)
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = sortKeysDeep(source[key])
    }
    return out
  }
  return value
}

/**
 * Render the gate prompt for one tray: the preamble, the tray's question
 * verbatim, the categories, one block per card, then the answer format.
 * Pure. The preamble and the answer format are the served texts when given
 * (`texts.gate_call_preamble`, `texts.gate_call_answer_format`), else the
 * legacy wording (deprecated; unchanged from 1.2).
 *
 * Throws when the tray carries no question — judging without it is exactly
 * the drift this design removes, so the gate fails closed instead.
 */
export function buildPrompt(tray: InboxTray, options?: BuildPromptOptions): string {
  const question: unknown = tray.question
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('gate: tray carries no question')
  }
  const namer = options?.toolNamer ?? BARE_TOOL_NAMER
  const cards = cardsOf(tray)
  const categories = categoriesOf(tray)
  const preamble = servedText(options?.texts?.gate_call_preamble) ?? LEGACY_GATE_CALL_PREAMBLE(namer)
  const answerFormat =
    servedText(options?.texts?.gate_call_answer_format) ?? LEGACY_GATE_CALL_ANSWER_FORMAT(categories)

  const sections: string[] = [preamble]
  sections.push(question.trim().replace(HOSTED_TOOL_TOKEN, (token) => namer(token)))

  if (categories.length > 0) {
    sections.push(`Categories: ${categories.join(', ')}`)
  }

  const you = typeof tray.you === 'string' && tray.you.length > 0 ? `You are ${tray.you}. ` : ''
  const count = cards.length
  sections.push(
    `${you}Your tray, as the server built it: ${count} conversation${count === 1 ? '' : 's'}.`,
  )

  cards.forEach((card, index) => {
    sections.push(`Card ${index + 1} of ${count}\n${canonicalJson(card)}`)
  })

  sections.push(answerFormat)
  return sections.join('\n\n')
}

function servedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// ─── Parsing the answer ─────────────────────────────────────────────────────

/**
 * Parse the model's answer into verdicts for the cards on `tray`.
 *
 * Returns `null` when the text holds no JSON at all (nothing parsable: the
 * caller fails closed). Entries for conversations not on the tray, unknown
 * decisions and duplicate ids are dropped; those cards count as undecided.
 * An unknown category becomes `null`; a stray `defer_seconds` is ignored.
 * Tolerant of code fences, surrounding prose and the synonyms above.
 */
export function parseVerdicts(text: string | null | undefined, tray: InboxTray): Verdict[] | null {
  const raw = extractJson(text)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  let items: unknown
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    items = record.decisions ?? record.verdicts
    if (items === undefined && 'conversation_id' in record) items = [record]
  } else {
    items = parsed
  }
  if (!Array.isArray(items)) return null

  const known = new Set(cardsOf(tray).map((card) => card.conversation_id))
  const allowed = new Set(categoriesOf(tray).map((c) => c.toLowerCase()))
  const seen = new Set<string>()
  const out: Verdict[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const id = entry.conversation_id
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue
    const decision = normalizeDecision(entry.decision)
    if (decision === null) continue
    seen.add(id)
    out.push({
      conversation_id: id,
      decision,
      category: normalizeCategory(entry.category, allowed),
    })
  }
  return out
}

function extractJson(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  let s = text.trim()
  const fence = FENCE_RE.exec(s)
  if (fence?.[1]) s = fence[1].trim()
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i !== -1)
  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const closer = s[start] === '{' ? '}' : ']'
  const end = s.lastIndexOf(closer)
  if (end <= start) return null
  return s.slice(start, end + 1)
}

/** Map a model's spelling onto a verdict, or null when it is none of the tolerated ones. */
export function normalizeDecision(value: unknown): ReplyDecisionVerdict | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase().replace(/\s+/g, '_')
  if (REPLY_TOKENS.has(token)) return 'reply'
  if (DISMISS_TOKENS.has(token)) return 'dismiss'
  if (DEFER_TOKENS.has(token)) return 'defer'
  return null
}

function normalizeCategory(value: unknown, allowed: ReadonlySet<string>): ReplyDecisionCategory | null {
  if (allowed.size === 0 || typeof value !== 'string') return null
  const token = value.trim().toLowerCase()
  return allowed.has(token) ? token : null
}

// ─── Running the gate ───────────────────────────────────────────────────────

/**
 * The host's model call. Receives the rendered prompt, returns the model's
 * raw text. MUST be a plain completion with no tools attached: the served
 * question names hosted tools, and a model that could call them would act
 * instead of answering (no JSON → fail closed, or a tool call AND JSON →
 * a verdict recorded twice).
 */
export type GateModelCall = (prompt: string) => Promise<string>

/** The one client surface the gate needs; `AgentChatClient` satisfies it. */
export type GateClient = Pick<AgentChatClient, 'decisions'>

export interface RunGateOptions {
  tray: InboxTray
  callModel: GateModelCall
  client: GateClient
  /** The served texts (`gate_call_preamble`, `gate_call_answer_format`). Absent: the legacy wording (deprecated). */
  texts?: GateTexts | null
  /** How this runtime spells the hosted tools named inside the question. */
  toolNamer?: ToolNamer
}

export type GateOutcome =
  /** The model answered; dismiss/defer verdicts were recorded, replies await `record()`. */
  | 'decided'
  /** The tray had no cards; nothing to decide. */
  | 'empty'
  /** The model call failed or its answer held no usable verdict; nothing was recorded. */
  | 'fail_closed'

export interface GateRecordFailure {
  conversation_id: string
  error: Error
}

/** A conversation the model decided needs a turn. */
export interface GateReply {
  conversationId: string
  /** The card as served; the anchor `record()` uses is `anchorOf(card)`. */
  card: InboxCard
  /** The category the model attached, if any. */
  category: ReplyDecisionCategory | null
  /**
   * Record the `reply` verdict. Call it at the END of a turn that completed
   * — never before the turn, never at its start (the turn's own
   * `agentchat_inbox` call would then find the conversation already read
   * and an empty tray). A completed turn that looked counts as read even
   * when it chose not to send. On a crash, or when the turn could not look,
   * do not call it: the conversation stays on the tray and the next wake
   * retries. Idempotent on success; a failed call may be retried.
   */
  record(): Promise<ReplyDecision>
}

export interface GateResult {
  outcome: GateOutcome
  /** Conversations whose verdict is `reply`: run a turn for each and call its `record()` once that turn has completed. */
  reply: GateReply[]
  /** Every usable verdict, in the model's order. */
  verdicts: Verdict[]
  /** Cards the model left without a usable verdict; they stay on the tray. */
  undecided: string[]
  /** `dismiss` / `defer` verdicts the server took. */
  recorded: number
  /** `dismiss` / `defer` verdicts the server did not take. */
  recordFailures: GateRecordFailure[]
  /** Why the gate failed closed; null otherwise. */
  failure: string | null
}

/**
 * Decide every card on the tray. `dismiss` and `defer` are recorded here,
 * sequentially (a tray holds at most 50 cards), each anchored with
 * `anchorOf(card)`; `reply` verdicts come back as `GateReply` entries whose
 * `record()` the host calls once the turn has completed. Never throws: model
 * and network failures land in the result.
 */
export async function run(options: RunGateOptions): Promise<GateResult> {
  const cards = cardsOf(options.tray)
  const ids = cards.map((card) => card.conversation_id)
  if (ids.length === 0) return emptyResult('empty', [], null)

  let prompt: string
  let text: string
  try {
    prompt = buildPrompt(options.tray, { texts: options.texts, toolNamer: options.toolNamer })
  } catch (err) {
    return emptyResult('fail_closed', ids, describe(err))
  }
  try {
    text = await options.callModel(prompt)
  } catch (err) {
    return emptyResult('fail_closed', ids, `model call failed: ${describe(err)}`)
  }

  const verdicts = parseVerdicts(text, options.tray)
  if (verdicts === null || verdicts.length === 0) {
    return emptyResult('fail_closed', ids, 'no usable verdicts in the answer')
  }

  const byId = new Map(cards.map((card) => [card.conversation_id, card] as const))
  const decided = new Set(verdicts.map((v) => v.conversation_id))
  const reply: GateReply[] = []
  const recordFailures: GateRecordFailure[] = []
  let recorded = 0
  for (const verdict of verdicts) {
    const card = byId.get(verdict.conversation_id)
    if (!card) continue // unreachable: parseVerdicts only keeps ids on the tray
    if (verdict.decision === 'reply') {
      reply.push(deferredReply(options.client, card, verdict.category))
      continue
    }
    try {
      await options.client.decisions.record(verdict.conversation_id, {
        decision: verdict.decision,
        category: verdict.category ?? undefined,
        throughMessageId: anchorOf(card),
      })
      recorded += 1
    } catch (err) {
      recordFailures.push({ conversation_id: verdict.conversation_id, error: toError(err) })
    }
  }

  return {
    outcome: 'decided',
    reply,
    verdicts,
    undecided: ids.filter((id) => !decided.has(id)),
    recorded,
    recordFailures,
    failure: null,
  }
}

// One `record()` per reply: the first successful call wins and later calls
// return the same decision; a rejected call clears so the host can retry.
function deferredReply(client: GateClient, card: InboxCard, category: ReplyDecisionCategory | null): GateReply {
  let inFlight: Promise<ReplyDecision> | null = null
  return {
    conversationId: card.conversation_id,
    card,
    category,
    record: () => {
      if (inFlight === null) {
        inFlight = client.decisions
          .record(card.conversation_id, {
            decision: 'reply',
            category: category ?? undefined,
            throughMessageId: anchorOf(card),
          })
          .catch((err: unknown) => {
            inFlight = null
            throw err
          })
      }
      return inFlight
    },
  }
}

function emptyResult(outcome: GateOutcome, undecided: string[], failure: string | null): GateResult {
  return {
    outcome,
    reply: [],
    verdicts: [],
    undecided,
    recorded: 0,
    recordFailures: [],
    failure,
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
