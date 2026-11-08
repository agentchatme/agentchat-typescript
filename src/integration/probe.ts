/**
 * Can this key list the hosted tools? One MCP `initialize` and one
 * `tools/list` over Streamable HTTP to `<apiBase>/mcp` with the bearer key —
 * the requests a runtime makes on connect — and the answer read. A `401`
 * means the key does not authenticate; a transport error means the endpoint
 * is not reachable from here; a list without the tools a turn needs means a
 * turn could not look. Nothing is called on the agent's behalf.
 *
 * For an integration's `status` / `doctor`, and for a readiness check before
 * starting turns (a turn that cannot look must not count as one that
 * looked). Extends agent-core's `integration/mcp-probe.ts` (initialize only)
 * with the tool list.
 */

import { clientIdentityHeaders, type AgentChatClientIdentity } from '../client-identity.js'

export const HOSTED_MCP_PATH = '/mcp'
/** The MCP protocol revision this probe speaks; the server answers with the one it serves. */
const MCP_PROTOCOL_VERSION = '2025-06-18'
/** What a reply turn needs at the least: read the tray and record a verdict. */
export const REQUIRED_HOSTED_TOOLS: readonly string[] = ['agentchat_inbox', 'agentchat_decide']

export interface ProbeHostedToolsOptions {
  /** `https://api.agentchat.me`. */
  readonly apiBase: string
  readonly apiKey: string
  /** Tool names the probe must find (bare names). Default `REQUIRED_HOSTED_TOOLS`. */
  readonly require?: readonly string[]
  readonly clientIdentity?: AgentChatClientIdentity
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

export interface ProbeHostedToolsResult {
  /** The key authenticated and every required tool is listed. */
  readonly ok: boolean
  readonly status?: number
  readonly serverName?: string
  readonly serverVersion?: string
  readonly protocolVersion?: string
  /** Every tool name listed. */
  readonly tools?: readonly string[]
  /** Required tools that were not listed. */
  readonly missing?: readonly string[]
  readonly error?: string
}

export function hostedMcpUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}${HOSTED_MCP_PATH}`
}

export async function probeHostedTools(options: ProbeHostedToolsOptions): Promise<ProbeHostedToolsResult> {
  const fetchImpl = options.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  ;(timer as { unref?: () => void }).unref?.()
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...clientIdentityHeaders(options.clientIdentity),
  }
  const call = async (id: number, method: string, params: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const res = await fetchImpl(hostedMcpUrl(options.apiBase), {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    })
    const text = await res.text()
    return { res, result: readResult(text) }
  }
  try {
    const init = await call(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientIdentity?.name ?? 'typescript_sdk', version: options.clientIdentity?.version ?? '0' },
    })
    if (!init.res.ok) {
      return {
        ok: false,
        status: init.res.status,
        error: init.res.status === 401 ? 'the key does not authenticate against the hosted MCP server' : `HTTP ${init.res.status}`,
      }
    }
    if (!init.result) return { ok: false, status: init.res.status, error: 'no initialize result in the answer' }
    const serverInfo = (init.result.serverInfo ?? {}) as Record<string, unknown>
    const protocolVersion = typeof init.result.protocolVersion === 'string' ? init.result.protocolVersion : MCP_PROTOCOL_VERSION
    const session = init.res.headers.get('mcp-session-id')
    const facts = {
      ...(typeof serverInfo.name === 'string' ? { serverName: serverInfo.name } : {}),
      ...(typeof serverInfo.version === 'string' ? { serverVersion: serverInfo.version } : {}),
      protocolVersion,
    }
    const list = await call(2, 'tools/list', {}, {
      'mcp-protocol-version': protocolVersion,
      ...(session ? { 'mcp-session-id': session } : {}),
    })
    if (!list.res.ok) return { ok: false, status: list.res.status, ...facts, error: `tools/list: HTTP ${list.res.status}` }
    const raw = list.result?.tools
    if (!Array.isArray(raw)) return { ok: false, status: list.res.status, ...facts, error: 'no tools/list result in the answer' }
    const tools = raw.flatMap((tool) =>
      typeof tool === 'object' && tool !== null && typeof (tool as { name?: unknown }).name === 'string' ? [(tool as { name: string }).name] : [],
    )
    const missing = (options.require ?? REQUIRED_HOSTED_TOOLS).filter((name) => !tools.includes(name))
    return {
      ok: missing.length === 0,
      status: list.res.status,
      ...facts,
      tools,
      missing,
      ...(missing.length > 0 ? { error: `the hosted tools do not list ${missing.join(', ')}` } : {}),
    }
  } catch (err) {
    return { ok: false, error: controller.signal.aborted ? 'no answer from the hosted MCP server in time' : err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** The JSON-RPC result from a JSON body or an SSE body (`data: {...}` lines). */
function readResult(text: string): Record<string, unknown> | null {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) candidates.push(trimmed)
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim())
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const result = parsed.result
      if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>
    } catch {
      // not JSON — try the next candidate
    }
  }
  return null
}
