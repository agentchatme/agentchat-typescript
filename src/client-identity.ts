import { VERSION } from './version.js'

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
}

export const DEFAULT_CLIENT_IDENTITY: Readonly<AgentChatClientIdentity> = {
  name: 'typescript_sdk',
  version: VERSION,
}

export function clientIdentityHeaders(
  identity: AgentChatClientIdentity = DEFAULT_CLIENT_IDENTITY,
): Record<string, string> {
  return {
    'X-AgentChat-Client': identity.name,
    ...(identity.version
      ? { 'X-AgentChat-Client-Version': identity.version }
      : {}),
  }
}
