/**
 * Verify a wake the platform POSTed to your wake webhook
 * (`client.wakeWebhook.set`), for the dialects whose receiver is code you
 * run. Conformance: `wake-webhook.cases.json`.
 *
 * - `agentchat` — `Authorization: Bearer <secret>`, the JSON wake payload.
 * - `hermes` — `X-Webhook-Timestamp` + `X-Webhook-Signature-V2` = hex
 *   HMAC-SHA256(secret, "<timestamp>.<body>").
 * - `standard-webhooks` — `webhook-id`, `webhook-timestamp` and
 *   `webhook-signature` ("v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>",
 *   possibly several, space-separated); a `whsec_` secret is base64-decoded,
 *   any other is used as its UTF-8 bytes.
 *
 * The other dialects (`claude-code`, `openclaw`, `poke`) are received by the
 * runtime's own endpoint, which checks its own credential.
 *
 * A wake carries no message content and proves nothing about delivery: on a
 * verified wake, read the tray. Pass the body exactly as received — the
 * signature is over those bytes. Comparisons are constant-time; nothing
 * about the secret or the expected signature is put in an error.
 *
 * Not the internal system-agent webhook (`t=…,v1=…` signatures), which is
 * deliberately not part of the public SDK.
 */

import type { WakeWebhookPayload } from './types/index.js'

export type WakeWebhookVerifyDialect = 'agentchat' | 'hermes' | 'standard-webhooks'

export type WakeWebhookVerifyReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'timestamp_skew'
  | 'bad_signature'
  | 'malformed_payload'

export class WakeWebhookVerificationError extends Error {
  readonly reason: WakeWebhookVerifyReason
  constructor(reason: WakeWebhookVerifyReason, message?: string) {
    super(message ?? `wake webhook verification failed: ${reason}`)
    this.name = 'WakeWebhookVerificationError'
    this.reason = reason
  }
}

/** Request headers: a fetch `Headers`, or a plain record (Node's `IncomingHttpHeaders` works). */
export type WakeWebhookHeaders =
  | { get(name: string): string | null }
  | Record<string, string | readonly string[] | undefined>

export interface VerifyWakeWebhookOptions {
  readonly dialect: WakeWebhookVerifyDialect
  /** The raw body, exactly as received. */
  readonly body: string | Uint8Array
  readonly headers: WakeWebhookHeaders
  /** The secret you registered with `client.wakeWebhook.set`. */
  readonly secret: string
  /** Replay window for the signed dialects, in seconds. Default 300; 0 disables the check. */
  readonly toleranceSeconds?: number
  /** Clock for the replay window, epoch ms. Default `Date.now`. */
  readonly now?: () => number
}

const DEFAULT_TOLERANCE_S = 300
const DIGITS = /^\d+$/
const HEX = /^[0-9a-fA-F]+$/

/**
 * Check the wake's credential for `dialect` and return the parsed payload.
 * Throws `WakeWebhookVerificationError` (with `reason`) on any failure.
 */
export async function verifyWakeWebhook(options: VerifyWakeWebhookOptions): Promise<WakeWebhookPayload> {
  const bytes = typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_S
  const nowSeconds = (options.now ?? Date.now)() / 1000

  switch (options.dialect) {
    case 'agentchat': {
      const auth = header(options.headers, 'authorization')
      if (auth === null || auth.trim() === '') throw new WakeWebhookVerificationError('missing_signature')
      const match = /^Bearer\s+(\S+)\s*$/i.exec(auth.trim())
      if (!match?.[1]) throw new WakeWebhookVerificationError('malformed_signature')
      if (!(await sameSecret(match[1], options.secret))) throw new WakeWebhookVerificationError('bad_signature')
      break
    }
    case 'hermes': {
      const ts = header(options.headers, 'x-webhook-timestamp')
      const sig = header(options.headers, 'x-webhook-signature-v2')
      if (ts === null || sig === null) throw new WakeWebhookVerificationError('missing_signature')
      const timestamp = ts.trim()
      const signature = sig.trim()
      if (!DIGITS.test(timestamp) || !HEX.test(signature)) throw new WakeWebhookVerificationError('malformed_signature')
      checkSkew(Number(timestamp), nowSeconds, tolerance)
      const expected = toHex(await hmac(utf8(options.secret), concat(utf8(`${timestamp}.`), bytes)))
      if (!constantTimeEqual(expected, signature.toLowerCase())) throw new WakeWebhookVerificationError('bad_signature')
      break
    }
    case 'standard-webhooks': {
      const id = header(options.headers, 'webhook-id')
      const ts = header(options.headers, 'webhook-timestamp')
      const sig = header(options.headers, 'webhook-signature')
      if (id === null || ts === null || sig === null) throw new WakeWebhookVerificationError('missing_signature')
      const timestamp = ts.trim()
      if (!DIGITS.test(timestamp)) throw new WakeWebhookVerificationError('malformed_signature')
      const candidates = sig
        .trim()
        .split(/\s+/)
        .flatMap((entry) => {
          const comma = entry.indexOf(',')
          return comma > 0 && entry.slice(0, comma) === 'v1' ? [entry.slice(comma + 1)] : []
        })
      if (candidates.length === 0) throw new WakeWebhookVerificationError('malformed_signature')
      checkSkew(Number(timestamp), nowSeconds, tolerance)
      const key = options.secret.startsWith('whsec_') ? fromBase64(options.secret.slice('whsec_'.length)) : utf8(options.secret)
      const expected = toBase64(await hmac(key, concat(utf8(`${id.trim()}.${timestamp}.`), bytes)))
      let matched = false
      for (const candidate of candidates) {
        // Every candidate is compared: the loop's time does not depend on which one matched.
        if (constantTimeEqual(expected, candidate)) matched = true
      }
      if (!matched) throw new WakeWebhookVerificationError('bad_signature')
      break
    }
    default:
      throw new WakeWebhookVerificationError('malformed_signature', `wake webhook verification: unknown dialect ${String(options.dialect)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new WakeWebhookVerificationError('malformed_payload')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || (parsed as { type?: unknown }).type !== 'agentchat.wake') {
    throw new WakeWebhookVerificationError('malformed_payload')
  }
  return parsed as WakeWebhookPayload
}

function header(headers: WakeWebhookHeaders, name: string): string | null {
  const getter = (headers as { get?: unknown }).get
  if (typeof getter === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name)
    return typeof value === 'string' ? value : null
  }
  const record = headers as Record<string, string | readonly string[] | undefined>
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== name) continue
    const value = record[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value.join(', ')
  }
  return null
}

function checkSkew(timestamp: number, nowSeconds: number, tolerance: number): void {
  if (tolerance > 0 && Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new WakeWebhookVerificationError('timestamp_skew')
  }
}

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
  if (!subtle) {
    throw new WakeWebhookVerificationError('bad_signature', 'Web Crypto (globalThis.crypto.subtle) is not available in this runtime')
  }
  return subtle
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const subtle = subtleCrypto()
  const cryptoKey = await subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, data as BufferSource))
}

/** Bearer check: compare digests, so neither the time nor a length check says anything about the secret. */
async function sameSecret(given: string, secret: string): Promise<boolean> {
  const subtle = subtleCrypto()
  const [a, b] = await Promise.all([
    subtle.digest('SHA-256', utf8(given) as BufferSource),
    subtle.digest('SHA-256', utf8(secret) as BufferSource),
  ])
  return constantTimeEqual(toHex(new Uint8Array(a)), toHex(new Uint8Array(b)))
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!
    out += c === undefined ? '=' : B64[n & 63]!
  }
  return out
}

function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const index = B64.indexOf(char)
    if (index < 0) continue
    buffer = ((buffer & 0xfff) << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}
