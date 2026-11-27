import { release } from 'node:os'
import { describe, expect, it } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import {
  DEFAULT_CLIENT_IDENTITY,
  PLATFORM_HEADER,
  clientIdentityHeaders,
  platformHeaderValue,
  type AgentChatClientIdentity,
} from '../src/client-identity.js'
import { RealtimeClient } from '../src/realtime.js'
import { platformFacts, platformFactsOf } from '../src/runtime.js'
import { integration } from '../src/index.js'
import { MockWebSocket } from './helpers/mock-websocket.js'

// X-AgentChat-Platform: an RFC 8941 dictionary of strings, host / os / arch /
// runtime / install / method, each only when it has its shape. The socket
// carries the same value as the HELLO's `platform` field.

const FACTS = { os: 'darwin/25.6.0', arch: 'arm64', runtime: 'node/22.11.0' }
const INSTALL = 'ins_AbCdEfGhIjKlMnOpQrSt_-'
const FULL: AgentChatClientIdentity = {
  name: 'coding_agents',
  version: '0.8.0',
  host: 'claude-code/2.0.31',
  installId: INSTALL,
  installMethod: 'npx',
}

/** An RFC 8941 dictionary whose every member is a string, parsed strictly (no parameters, no inner lists). */
function parseStringDictionary(value: string): Record<string, string> {
  const member = /^([a-z*][a-z0-9_.*-]*)="((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"/
  const out: Record<string, string> = {}
  let rest = value
  while (rest.length > 0) {
    const m = member.exec(rest)
    if (!m) throw new Error(`not a string dictionary: ${JSON.stringify(value)}`)
    out[m[1]!] = m[2]!.replace(/\\(["\\])/g, '$1')
    rest = rest.slice(m[0].length)
    if (rest.length === 0) break
    if (!rest.startsWith(', ') || rest.length === 2) throw new Error(`bad separator in ${JSON.stringify(value)}`)
    rest = rest.slice(2)
  }
  return out
}

describe('platformHeaderValue', () => {
  it('serializes every member, in a fixed order, as an RFC 8941 dictionary of strings', () => {
    const value = platformHeaderValue(FULL, FACTS)
    expect(value).toBe(
      `host="claude-code/2.0.31", os="darwin/25.6.0", arch="arm64", runtime="node/22.11.0", install="${INSTALL}", method="npx"`,
    )
    expect(parseStringDictionary(value!)).toEqual({
      host: 'claude-code/2.0.31',
      os: 'darwin/25.6.0',
      arch: 'arm64',
      runtime: 'node/22.11.0',
      install: INSTALL,
      method: 'npx',
    })
  })

  it('keeps the order whatever order the fields were given in', () => {
    const shuffled = { installMethod: 'npx', installId: INSTALL, host: 'codex/0.63.0', name: 'coding_agents' } as const
    const facts = { runtime: 'node/22.11.0', arch: 'x64', os: 'linux/6.8.0-48-generic' }
    expect(Object.keys(parseStringDictionary(platformHeaderValue(shuffled, facts)!))).toEqual([
      'host', 'os', 'arch', 'runtime', 'install', 'method',
    ])
  })

  it('carries only the SDK facts for the default identity', () => {
    expect(platformHeaderValue(DEFAULT_CLIENT_IDENTITY, FACTS)).toBe(
      'os="darwin/25.6.0", arch="arm64", runtime="node/22.11.0"',
    )
  })

  it.each([
    ['empty', ''],
    ['a leading dot', '.claude/1'],
    ['a leading dash', '-x'],
    ['a leading slash', '/x'],
    ['a space', 'claude code/1'],
    ['a double quote', 'claude"/1'],
    ['a backslash', 'claude\\1'],
    ['a comma', 'a,b'],
    ['an equals sign', 'a=b'],
    ['a semicolon', 'a;b'],
    ['a non-ASCII letter', 'cläude/1'],
    ['a trailing newline', 'claude/1\n'],
    ['65 characters', `a${'b'.repeat(64)}`],
  ])('leaves out a value with %s, and keeps the rest', (_name, bad) => {
    const value = platformHeaderValue({ name: 'typescript_sdk', host: bad, installMethod: bad }, FACTS)
    expect(value).toBe('os="darwin/25.6.0", arch="arm64", runtime="node/22.11.0"')
    expect(platformHeaderValue({ name: 'typescript_sdk' }, { os: bad, arch: bad, runtime: bad })).toBeNull()
  })

  it('keeps a value of exactly 64 characters', () => {
    const host = `a${'b'.repeat(63)}`
    expect(platformHeaderValue({ name: 'typescript_sdk', host }, {})).toBe(`host="${host}"`)
  })

  it('leaves out a value that is not a string', () => {
    const identity = { name: 'typescript_sdk', host: 42, installId: null, installMethod: {} } as unknown as AgentChatClientIdentity
    expect(platformHeaderValue(identity, { os: 1, arch: true } as unknown as typeof FACTS)).toBeNull()
  })

  it.each([
    ['another prefix', `inst_${'a'.repeat(22)}`],
    ['21 characters after the prefix', `ins_${'a'.repeat(21)}`],
    ['23 characters after the prefix', `ins_${'a'.repeat(23)}`],
    ['a dot', `ins_${'a'.repeat(21)}.`],
    ['a plus', `ins_${'a'.repeat(21)}+`],
    ['a trailing newline', `${INSTALL}\n`],
  ])('leaves out an install id with %s', (_name, installId) => {
    expect(platformHeaderValue({ name: 'typescript_sdk', installId }, {})).toBeNull()
  })

  it('stays under 512 bytes with every member at its longest', () => {
    const longest = `a${'b'.repeat(63)}`
    const value = platformHeaderValue(
      { name: 'typescript_sdk', host: longest, installId: INSTALL, installMethod: longest },
      { os: longest, arch: longest, runtime: longest },
    )!
    expect(Object.keys(parseStringDictionary(value))).toHaveLength(6)
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(512)
  })

  it('is null when no member is left (the header itself: tests/platform-header-browser.test.ts)', () => {
    expect(platformHeaderValue({ name: 'typescript_sdk' }, {})).toBeNull()
    expect(platformHeaderValue({ name: 'typescript_sdk', version: '1.0.0', host: 'not valid' }, {})).toBeNull()
  })

  it('is the header clientIdentityHeaders builds', () => {
    expect(clientIdentityHeaders(FULL)).toEqual({
      'X-AgentChat-Client': 'coding_agents',
      'X-AgentChat-Client-Version': '0.8.0',
      [PLATFORM_HEADER]: platformHeaderValue(FULL),
    })
  })
})

describe('platformFactsOf', () => {
  const os = (release: unknown) => ({ release: () => release })
  const node = (extra: Record<string, unknown> = {}) => ({
    process: {
      versions: { node: '22.11.0' },
      platform: 'darwin',
      arch: 'arm64',
      getBuiltinModule: (id: string) => (id === 'node:os' ? os('25.6.0') : undefined),
      ...extra,
    },
  })

  it('reads os (platform/release), arch and runtime in Node', () => {
    expect(platformFactsOf(node())).toEqual({ os: 'darwin/25.6.0', arch: 'arm64', runtime: 'node/22.11.0' })
  })

  it('gives the platform alone without process.getBuiltinModule (Node before 20.16)', () => {
    expect(platformFactsOf(node({ getBuiltinModule: undefined }))).toEqual({ os: 'darwin', arch: 'arm64', runtime: 'node/22.11.0' })
  })

  it('gives the platform alone when the release does not have the value shape, or reading it throws', () => {
    expect(platformFactsOf(node({ getBuiltinModule: () => os('25.6.0 custom') })).os).toBe('darwin')
    expect(platformFactsOf(node({ getBuiltinModule: () => os('') })).os).toBe('darwin')
    expect(platformFactsOf(node({ getBuiltinModule: () => { throw new Error('no') } })).os).toBe('darwin')
    expect(platformFactsOf(node({ getBuiltinModule: () => os(undefined) })).os).toBe('darwin')
  })

  it('never asks Deno for the release (it would prompt for a permission)', () => {
    let asked = false
    const facts = platformFactsOf({
      ...node({
        platform: 'linux',
        arch: 'x64',
        getBuiltinModule: () => {
          asked = true
          return os('6.8.0')
        },
      }),
      Deno: { version: { deno: '2.1.4' } },
    })
    expect(asked).toBe(false)
    expect(facts).toEqual({ os: 'linux', arch: 'x64', runtime: 'deno/2.1.4' })
  })

  it('names Bun as the runtime', () => {
    expect(platformFactsOf({ ...node(), Bun: { version: '1.1.38' } }).runtime).toBe('bun/1.1.38')
  })

  it('knows nothing in a browser, nor behind a bundler process polyfill', () => {
    expect(platformFactsOf({ navigator: { userAgent: 'Mozilla/5.0' } })).toEqual({})
    expect(platformFactsOf({ process: { versions: {}, platform: 'browser' } as never, navigator: { userAgent: 'Mozilla/5.0' } })).toEqual({})
    expect(platformFactsOf({})).toEqual({})
  })

  it('reads the facts of this process once', () => {
    const facts = platformFacts()
    expect(platformFacts()).toBe(facts)
    expect(facts.arch).toBe(process.arch)
    expect(facts.runtime).toBe(`node/${process.versions.node}`)
    expect(facts.os).toBe(typeof process.getBuiltinModule === 'function' ? `${process.platform}/${release()}` : process.platform)
  })
})

// ─── Where the value goes ───────────────────────────────────────────────────

interface Seen {
  url: string
  headers: Headers
  body: unknown
}

function recording(status = 200, body: unknown = {}) {
  const seen: Seen[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { seen, fetch: fetchImpl }
}

const API = 'https://api.test'

describe('X-AgentChat-Platform on REST', () => {
  it('goes on every client request: the SDK facts by default', async () => {
    const srv = recording(200, [])
    await new AgentChatClient({ apiKey: 'k', baseUrl: API, fetch: srv.fetch }).listConversations()
    expect(srv.seen[0]!.headers.get('x-agentchat-platform')).toBe(platformHeaderValue())
    expect(parseStringDictionary(srv.seen[0]!.headers.get('x-agentchat-platform')!)).toMatchObject({
      runtime: `node/${process.versions.node}`,
      arch: process.arch,
    })
  })

  it('carries the integration\'s host, install id and install method', async () => {
    const srv = recording(200, [])
    await new AgentChatClient({ apiKey: 'k', baseUrl: API, fetch: srv.fetch, clientIdentity: FULL }).listConversations()
    expect(parseStringDictionary(srv.seen[0]!.headers.get('x-agentchat-platform')!)).toMatchObject({
      host: 'claude-code/2.0.31',
      install: INSTALL,
      method: 'npx',
    })
    expect(srv.seen[0]!.headers.get('x-agentchat-client')).toBe('coding_agents')
  })

  it('goes on the unauthenticated calls (register)', async () => {
    const srv = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    await AgentChatClient.register({ email: 'a@example.com', handle: 'alice', baseUrl: API, fetch: srv.fetch, clientIdentity: FULL })
    expect(srv.seen[0]!.headers.get('x-agentchat-platform')).toBe(platformHeaderValue(FULL))
  })

  it('goes on integration.account calls', async () => {
    const srv = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    await integration.account.start('register', { email: 'a@example.com', handle: 'alice' }, { clientIdentity: FULL, apiBase: API, fetch: srv.fetch })
    expect(srv.seen[0]!.headers.get('x-agentchat-platform')).toBe(platformHeaderValue(FULL))
  })

  it('goes on the hosted-tools probe', async () => {
    const srv = recording(401, {})
    await integration.probeHostedTools({ apiBase: API, apiKey: 'k', clientIdentity: FULL, fetch: srv.fetch })
    expect(srv.seen[0]!.url).toBe(`${API}/mcp`)
    expect(srv.seen[0]!.headers.get('x-agentchat-platform')).toBe(platformHeaderValue(FULL))
  })
})

describe('the platform value on the socket', () => {
  const MockWebSocketCtor = MockWebSocket as unknown as typeof globalThis.WebSocket

  it('rides the HELLO as `platform`, the same string as the header', async () => {
    MockWebSocket.reset()
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocketCtor, reconnect: false, clientIdentity: FULL })
    await rt.connect()
    const ws = MockWebSocket.latest()
    ws.simulateOpen()
    const hello = JSON.parse(ws.sent[0]!) as Record<string, unknown>
    expect(hello).toMatchObject({ type: 'hello', client: 'coding_agents', client_version: '0.8.0' })
    expect(hello.platform).toBe(platformHeaderValue(FULL))
    expect(parseStringDictionary(hello.platform as string)).toMatchObject({ host: 'claude-code/2.0.31', install: INSTALL, method: 'npx' })
    rt.disconnect()
  })
})

// ─── B5: what an agent declares at sign-up ──────────────────────────────────

describe('declared sign-up fields', () => {
  const declared = { runtime: 'claude-code', heard_from: 'agent', referred_by: 'some-agent' } as const

  it('AgentChatClient.register sends them in the body', async () => {
    const srv = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    await AgentChatClient.register({ email: 'a@example.com', handle: 'alice', ...declared, baseUrl: API, fetch: srv.fetch })
    expect(srv.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice', ...declared })
  })

  it('AgentChatClient.register leaves the body as it was without them', async () => {
    const srv = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    await AgentChatClient.register({ email: 'a@example.com', handle: 'alice', display_name: 'Alice', baseUrl: API, fetch: srv.fetch })
    expect(srv.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice', display_name: 'Alice' })
  })

  it('a value the SDK does not know is sent as given: the server judges it', async () => {
    const srv = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    await AgentChatClient.register({
      email: 'a@example.com',
      handle: 'alice',
      heard_from: 'a friend' as never,
      baseUrl: API,
      fetch: srv.fetch,
    })
    expect(srv.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice', heard_from: 'a friend' })
  })

  it('integration.account.start sends them with register, and recover sends none', async () => {
    const opts = (srv: ReturnType<typeof recording>) => ({ clientIdentity: FULL, apiBase: API, fetch: srv.fetch })
    const reg = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    await integration.account.start('register', { email: 'a@example.com', handle: 'alice', ...declared }, opts(reg))
    expect(reg.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice', ...declared })

    const rec = recording(200, { pending_id: 'pnd_2', message: 'sent' })
    await integration.account.start(
      'recover',
      { email: 'a@example.com', handle: 'alice', ...declared } as unknown as { email: string; handle: string },
      opts(rec),
    )
    expect(rec.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice' })
  })

  it('integration.account.run sends them with the register call', async () => {
    const srv = recording(200, { pending_id: 'pnd_1', message: 'sent' })
    const result = await integration.account.run({
      kind: 'register',
      input: { email: 'a@example.com', handle: 'alice', ...declared },
      clientIdentity: FULL,
      apiBase: API,
      fetch: srv.fetch,
      show: () => {},
      ask: async () => ({ answer: 'cancel' }),
    })
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(srv.seen[0]!.url).toBe(`${API}/v1/register`)
    expect(srv.seen[0]!.body).toEqual({ email: 'a@example.com', handle: 'alice', ...declared })
  })
})
