import { describe, expect, it, vi } from 'vitest'

// A runtime the SDK knows nothing about (a browser): no SDK facts. With no
// integration fields either, no X-AgentChat-Platform header is sent (so a
// browser request needs nothing new from the server's CORS allow-list), and
// the HELLO carries no `platform`.
vi.mock('../src/runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime.js')>()),
  platformFacts: () => ({}),
}))

const { AgentChatClient } = await import('../src/client.js')
const { RealtimeClient } = await import('../src/realtime.js')
const { MockWebSocket } = await import('./helpers/mock-websocket.js')

function recording() {
  const seen: Headers[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers as HeadersInit))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { seen, fetch: fetchImpl }
}

describe('X-AgentChat-Platform where the SDK knows nothing', () => {
  it('sends no header and no HELLO field without integration fields', async () => {
    const srv = recording()
    await new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch: srv.fetch }).listConversations()
    expect(srv.seen[0]!.has('x-agentchat-platform')).toBe(false)
    expect(srv.seen[0]!.get('x-agentchat-client')).toBe('typescript_sdk')

    MockWebSocket.reset()
    const rt = new RealtimeClient({ apiKey: 'k', webSocket: MockWebSocket as unknown as typeof WebSocket, reconnect: false })
    await rt.connect()
    MockWebSocket.latest().simulateOpen()
    expect(JSON.parse(MockWebSocket.latest().sent[0]!)).not.toHaveProperty('platform')
    rt.disconnect()
  })

  it('sends no header when every integration field is malformed', async () => {
    const srv = recording()
    await new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: srv.fetch,
      clientIdentity: { name: 'coding_agents', host: 'claude code', installId: 'ins_short', installMethod: '' },
    }).listConversations()
    expect(srv.seen[0]!.has('x-agentchat-platform')).toBe(false)
  })

  it('sends what the integration gives', async () => {
    const srv = recording()
    await new AgentChatClient({
      apiKey: 'k',
      baseUrl: 'https://api.test',
      fetch: srv.fetch,
      clientIdentity: { name: 'coding_agents', host: 'claude-code/2.0.31' },
    }).listConversations()
    expect(srv.seen[0]!.get('x-agentchat-platform')).toBe('host="claude-code/2.0.31"')
  })
})
