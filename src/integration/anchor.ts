/**
 * The identity block: the served identity line, fenced, in the file the
 * runtime loads on every turn (`AGENTS.md`, `SOUL.md`, `CLAUDE.md`, …).
 * Pure string functions — which file, and when to write it, is the
 * integration's business (a shared function that picked the file once
 * stamped one agent's handle into another agent's file).
 *
 * The words are the server's (`texts.identity_line`). This module adds the
 * fences and one handle line, so a block is recognised whatever the served
 * wording becomes:
 *
 *     <!-- agentchat:start -->
 *     <!-- agentchat:handle relay-bot -->
 *     I am @relay-bot on AgentChat …
 *     <!-- agentchat:end -->
 *
 * Blocks written before the handle line are recognised by the served
 * template's words and by the two wordings earlier releases wrote, and the
 * legacy `agentchat-skill` markers are still found and replaced
 * (conformance `anchor.cases.json`).
 *
 * Where the copies this replaces differed (agent-core `anchor/block.ts`,
 * OpenClaw `binding/agents-anchor.ts`, Hermes `soul_anchor.py`), the
 * stricter behaviour is kept: markers count only as whole lines (agent-core;
 * a marker quoted in prose is not a fence); every duplicate and legacy block
 * is removed (agent-core) while the block keeps its place in the file
 * (OpenClaw, Hermes); the handle line and the template-based recognition
 * (Hermes); a wrong handle is read back rather than ignored (agent-core).
 * New: a start marker with no end before the next start is ignored instead
 * of fencing everything up to a later block.
 */

import type { Texts } from '../types/index.js'

export const START_MARKER = '<!-- agentchat:start -->'
export const END_MARKER = '<!-- agentchat:end -->'
export const LEGACY_START_MARKER = '<!-- agentchat-skill:start -->'
export const LEGACY_END_MARKER = '<!-- agentchat-skill:end -->'

const HANDLE_PLACEHOLDER = '<handle>'
const HANDLE_LINE_RE = /^<!-- agentchat:handle @?([A-Za-z0-9][A-Za-z0-9_-]*) -->$/
const HANDLE_CAPTURE = '@?([A-Za-z0-9][A-Za-z0-9_-]*)'
/** Wordings earlier releases wrote without a handle line. */
const OLD_WORDINGS: readonly RegExp[] = [
  new RegExp(`I am ${HANDLE_CAPTURE} on AgentChat`),
  new RegExp(`You are \\*\\*${HANDLE_CAPTURE}\\*\\* on AgentChat`),
]

/** Handles are canonical lowercase on the wire; a leading `@` is display only. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').trim().toLowerCase()
}

export function handleLine(handle: string): string {
  return `<!-- agentchat:handle ${normalizeHandle(handle)} -->`
}

/**
 * The block for `handle`: the fences, the handle line and the served line.
 * Uses `texts.identity_line` when it names `@handle`, else fills
 * `texts.identity_line_template`. Throws when the handle is empty or no
 * served text names it — a silently wrong identity is worse than a loud
 * failure: the agent would hand peers an address that reaches someone else.
 */
export function render(texts: Pick<Texts, 'identity_line' | 'identity_line_template'>, handle: string): string {
  const bare = normalizeHandle(handle)
  if (bare.length === 0) throw new Error('anchor.render: the handle is empty')
  let line = typeof texts.identity_line === 'string' ? texts.identity_line.trim() : ''
  if (!namesHandle(line, bare)) {
    const template = typeof texts.identity_line_template === 'string' ? texts.identity_line_template : ''
    line = template.includes(HANDLE_PLACEHOLDER) ? template.split(HANDLE_PLACEHOLDER).join(bare).trim() : ''
  }
  if (!namesHandle(line, bare)) {
    throw new Error(`anchor.render: no served identity text names @${bare}`)
  }
  return [START_MARKER, handleLine(bare), line, END_MARKER].join('\n')
}

export interface FoundBlock {
  /** Offset of the start marker's line. */
  readonly start: number
  /** Offset just past the end marker (before its line break). */
  readonly end: number
  /** The handle the block claims, lower-cased; null for a block in a shape not recognised (hand-edited). */
  readonly handle: string | null
  /** The block carries a handle line. */
  readonly marked: boolean
  /** The block uses the legacy `agentchat-skill` markers. */
  readonly legacy: boolean
  /** Between the markers, without the handle line; CRLF read as LF; trimmed. */
  readonly body: string
}

export interface FindOptions {
  /** The served `identity_line_template`: recognises an unmarked block by its words. */
  readonly template?: string | null
}

/** The first current block, else the first legacy block, else null. */
export function find(text: string, options: FindOptions = {}): FoundBlock | null {
  const spans = blocksOf(text)
  const span = spans.find((s) => !s.legacy) ?? spans[0]
  if (!span) return null
  const inner = text.slice(span.innerStart, span.innerEnd).replace(/\r\n/g, '\n')
  let handle: string | null = null
  let marked = false
  const kept: string[] = []
  for (const line of inner.split('\n')) {
    const match = !marked ? HANDLE_LINE_RE.exec(line.trim()) : null
    if (match) {
      marked = true
      handle = (match[1] ?? '').toLowerCase()
      continue
    }
    kept.push(line)
  }
  const body = kept.join('\n').trim()
  if (handle === null) handle = handleFromWording(body, options.template ?? null)
  return { start: span.start, end: span.end, handle, marked, legacy: span.legacy, body }
}

/**
 * `text` with `block` in place of the first block (current or legacy) and
 * every other block removed; appended after one blank line when there is
 * none. Idempotent.
 */
export function replace(text: string, block: string): string {
  const spans = blocksOf(text)
  if (spans.length === 0) {
    const trimmed = text.replace(/\n+$/, '')
    return trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`
  }
  return rebuild(text, spans, block)
}

/** `text` without any block (current or legacy); unchanged when there is none. */
export function remove(text: string): string {
  const spans = blocksOf(text)
  if (spans.length === 0) return text
  return rebuild(text, spans, null)
}

// ─── internals ──────────────────────────────────────────────────────────────

interface Span {
  readonly start: number
  readonly end: number
  readonly innerStart: number
  readonly innerEnd: number
  readonly legacy: boolean
}

interface Line {
  readonly start: number
  /** Offset of the line break (or the text end). */
  readonly end: number
  readonly next: number
  readonly trimmed: string
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let at = 0
  while (at <= text.length) {
    const nl = text.indexOf('\n', at)
    const end = nl === -1 ? text.length : nl
    lines.push({ start: at, end, next: nl === -1 ? text.length + 1 : nl + 1, trimmed: text.slice(at, end).trim() })
    if (nl === -1) break
    at = nl + 1
  }
  return lines
}

/** Every complete block, in order. One open start at a time: a second start drops the first. */
function blocksOf(text: string): Span[] {
  const spans: Span[] = []
  let open: { line: Line; legacy: boolean } | null = null
  for (const line of linesOf(text)) {
    if (line.trimmed === START_MARKER || line.trimmed === LEGACY_START_MARKER) {
      open = { line, legacy: line.trimmed === LEGACY_START_MARKER }
      continue
    }
    const closes = open !== null && line.trimmed === (open.legacy ? LEGACY_END_MARKER : END_MARKER)
    if (open !== null && closes) {
      spans.push({
        start: open.line.start,
        end: line.end,
        innerStart: Math.min(open.line.next, line.start),
        innerEnd: line.start,
        legacy: open.legacy,
      })
      open = null
    }
  }
  return spans
}

function rebuild(text: string, spans: readonly Span[], replacement: string | null): string {
  const parts: string[] = []
  const first = spans[0]
  const last = spans[spans.length - 1]
  if (!first || !last) return text
  parts.push(text.slice(0, first.start).replace(/\n+$/, ''))
  if (replacement !== null) parts.push(replacement)
  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1]
    const current = spans[i]
    if (!previous || !current) continue
    parts.push(text.slice(previous.end, current.start).replace(/^\n+/, '').replace(/\n+$/, ''))
  }
  parts.push(text.slice(last.end).replace(/^\n+/, ''))
  const kept = parts.filter((part) => part.length > 0)
  if (kept.length === 0) return ''
  const out = kept.join('\n\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `@bare` as a whole handle (not the prefix of a longer one). */
function namesHandle(line: string, bare: string): boolean {
  if (line.length === 0) return false
  return new RegExp(`@${escapeRegExp(bare)}(?![A-Za-z0-9_-])`).test(line)
}

/** The served template's words before `<handle>` (whitespace-insensitive), else the first words after it. */
function templatePattern(template: string | null): RegExp | null {
  if (!template || !template.includes(HANDLE_PLACEHOLDER)) return null
  const index = template.indexOf(HANDLE_PLACEHOLDER)
  const head = template.slice(0, index).split(/\s+/).filter(Boolean)
  const tail = template.slice(index + HANDLE_PLACEHOLDER.length).split(/\s+/).filter(Boolean)
  if (head.length > 0) {
    const words = head.map(escapeRegExp).join('\\s+')
    // `@` closes the head when the template writes `@<handle>`; the capture
    // takes an optional one, so drop a trailing `@` from the head.
    return new RegExp(`${words.replace(/@$/, '')}\\s*${HANDLE_CAPTURE}`)
  }
  if (tail.length > 0) {
    const words = tail.slice(0, 3).map(escapeRegExp).join('\\s+')
    return new RegExp(`${HANDLE_CAPTURE}\\s*${words}`)
  }
  return null
}

function handleFromWording(body: string, template: string | null): string | null {
  const patterns: RegExp[] = []
  const fromTemplate = templatePattern(template)
  if (fromTemplate) patterns.push(fromTemplate)
  patterns.push(...OLD_WORDINGS)
  const flat = body.split(/\s+/).filter(Boolean).join(' ')
  for (const pattern of patterns) {
    const match = pattern.exec(flat) ?? pattern.exec(body)
    if (match?.[1]) return match[1].toLowerCase()
  }
  return null
}
