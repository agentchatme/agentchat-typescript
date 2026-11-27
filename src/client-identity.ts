import { VERSION } from './version.js'
import { isPlatformValue, platformFacts, type PlatformFacts } from './runtime.js'

/**
 * Server-owned, low-cardinality client taxonomy used for product analytics.
 * Integrations built on this SDK should identify themselves instead of being
 * counted as the generic TypeScript SDK.
 */
export type AgentChatClientKind =
  | 'typescript_sdk'
  | 'openclaw'
  | 'mcp'
  | 'coding_agents'

export interface AgentChatClientIdentity {
  name: AgentChatClientKind
  version?: string
  /**
   * The runtime this client runs inside and its version, as
   * `<runtime>/<version>` (`claude-code/2.0.31`). Sent as `host` in
   * `X-AgentChat-Platform`; a value of another shape is left out.
   */
  host?: string
  /**
   * The install id: `ins_` and 22 base64url characters, generated once per
   * install (random, never derived from the machine). Sent as `install`.
   */
  installId?: string
  /** How this client was installed (`npx`, `marketplace`, …), only when known for sure. Sent as `method`. */
  installMethod?: string
}

export const DEFAULT_CLIENT_IDENTITY: Readonly<AgentChatClientIdentity> = {
  name: 'typescript_sdk',
  version: VERSION,
}

/** The header that names the platform a request comes from (and the socket HELLO's `platform` field). */
export const PLATFORM_HEADER = 'X-AgentChat-Platform'

const INSTALL_ID = /^ins_[A-Za-z0-9_-]{22}$/

/**
 * The `X-AgentChat-Platform` value: an RFC 8941 dictionary of strings,
 * members in this order, each only when it has its shape:
 *
 * - `host` (the identity's `host`), `os`, `arch`, `runtime` (computed by the
 *   SDK, `facts`), `install` (`installId`), `method` (`installMethod`).
 * - Every value `^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$`; `install`
 *   `^ins_[A-Za-z0-9_-]{22}$`. A value of another shape is left out, never
 *   repaired. So nothing needs escaping, and the whole value stays under 512
 *   bytes (at most 454).
 *
 * `null` when no member is left: then nothing is sent.
 */
export function platformHeaderValue(
  identity: AgentChatClientIdentity = DEFAULT_CLIENT_IDENTITY,
  facts: PlatformFacts = platformFacts(),
): string | null {
  const members: ReadonlyArray<readonly [string, unknown, (value: unknown) => value is string]> = [
    ['host', identity.host, isPlatformValue],
    ['os', facts.os, isPlatformValue],
    ['arch', facts.arch, isPlatformValue],
    ['runtime', facts.runtime, isPlatformValue],
    ['install', identity.installId, isInstallId],
    ['method', identity.installMethod, isPlatformValue],
  ]
  const kept: string[] = []
  for (const [key, value, valid] of members) if (valid(value)) kept.push(`${key}="${value}"`)
  return kept.length > 0 ? kept.join(', ') : null
}

function isInstallId(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_ID.test(value)
}

export function clientIdentityHeaders(
  identity: AgentChatClientIdentity = DEFAULT_CLIENT_IDENTITY,
): Record<string, string> {
  const platform = platformHeaderValue(identity)
  return {
    'X-AgentChat-Client': identity.name,
    ...(identity.version
      ? { 'X-AgentChat-Client-Version': identity.version }
      : {}),
    ...(platform !== null ? { [PLATFORM_HEADER]: platform } : {}),
  }
}
