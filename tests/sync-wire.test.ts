import { describe, it, expect, vi } from 'vitest'
import { AgentChatClient } from '../src/client.js'
import type { SyncEnvelope } from '../src/client.js'

// ─── /v1/messages/sync wire contract ────────────────────────────────────────
//
// AUTHORITY: docs/realtime-delivery-ack.md (server repo), section "Wire
// contract for /v1/messages/sync (restated, authoritative)":
//
//   - `GET /v1/messages/sync?after=<delivery_id>&limit=<n>` → **bare JSON
//     array**, oldest first, keyset-paginated on `(created_at, id)`.
//     Non-destructive.
//   - `POST /v1/messages/sync/ack` `{"last_delivery_id":"del_<32hex>"}` →
//     `{"acked": <int>}`. Marks all `stored` envelopes at-or-before the
//     cursor.
//   - `delivery_id` is an **opaque string**. Clients MUST NOT compare it
//     numerically; batch order is positional.
//
// SDK v1.0.2 typed this endpoint as `{envelopes: [{delivery_id: number,
// message}]}` — a shape production never returned, which made the realtime
// offline drain a silent zero-row no-op. These tests pin the SDK to the
// real wire so that regression cannot come back.

function scriptedFetch(
  responses: Array<
    Response | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>)
  >,
): typeof fetch {
  let i = 0
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = responses[i++]
    if (!entry) throw new Error(`scriptedFetch: unexpected call #${i}`)
    return typeof entry === 'function' ? await entry(input, init) : entry
  }) as unknown as typeof fetch
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

// Fixture captured from the production wire shape (field set per the
// reference client schema: id, conversation_id, delivery_id string|null,
// sender — handle string, with sender_handle only as a legacy fallback —
// type, content, created_at, plus passthrough fields like seq / status /
// metadata that the SDK must tolerate and preserve, not strip).
const WIRE_FIXTURE = [
  {
    id: 'msg_9f2c1b7a5e304d18',
    conversation_id: 'conv_51c9aa02f7d84b33',
    delivery_id: 'del_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    sender: 'aleph-null',
    client_msg_id: '3f6f0a52-6f3d-4bfb-9a91-1f0f0f8f2a11',
    seq: 41,
    type: 'text',
    content: { text: 'offline while you were away' },
    metadata: {},
    status: 'stored',
    created_at: '2026-07-12T18:04:11.512Z',
    delivered_at: null,
    read_at: null,
  },
  {
    id: 'msg_c4d0e6f2a8b1479c',
    conversation_id: 'conv_51c9aa02f7d84b33',
    delivery_id: 'del_ffeeddccbbaa99887766554433221100',
    sender: 'tessera-rho',
    client_msg_id: '7f1d9f04-2c5e-49ab-8d3a-52f7f9b0c644',
    seq: 42,
    type: 'structured',
    content: { data: { kind: 'ping' } },
    metadata: { trace_id: 'trc_123' },
    status: 'stored',
    created_at: '2026-07-12T18:05:02.007Z',
    delivered_at: null,
    read_at: null,
    // Forward-compat: servers add fields without notice — passthrough.
    priority: 'normal',
  },
  {
    id: 'msg_5b6a79c8d0e1f234',
    conversation_id: 'conv_e00f11223344a9b8',
    // Nullable on the wire — cursor computation must skip null rows.
    delivery_id: null,
    sender: 'chatfather',
    seq: 7,
    type: 'system',
    content: { text: 'group settings updated' },
    created_at: '2026-07-12T18:06:40.901Z',
  },
]

describe('client.sync() — bare-array wire', () => {
  it('returns the bare array of rows exactly as the server sent them', async () => {
    let calledUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        calledUrl = typeof input === 'string' ? input : input.toString()
        return json(200, WIRE_FIXTURE)
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const rows = await client.sync()

    expect(calledUrl).toBe('https://api.test/v1/messages/sync')
    // Bare array — NOT an {envelopes} wrapper.
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(3)

    const first: SyncEnvelope = rows[0]
    expect(first.id).toBe('msg_9f2c1b7a5e304d18')
    expect(first.conversation_id).toBe('conv_51c9aa02f7d84b33')
    // Opaque STRING cursor, del_<32 hex> in production.
    expect(first.delivery_id).toBe('del_0a1b2c3d4e5f60718293a4b5c6d7e8f9')
    expect(first.delivery_id).toMatch(/^del_[0-9a-f]{32}$/)
    expect(first.sender).toBe('aleph-null')
    expect(first.seq).toBe(41)

    // Passthrough: unknown fields survive untouched.
    expect(rows[1].priority).toBe('normal')
    // Nullable cursor rows come through as-is.
    expect(rows[2].delivery_id).toBeNull()
  })

  it('passes after + limit as query params (after is the opaque string cursor)', async () => {
    let calledUrl = ''
    const fetch = scriptedFetch([
      (input) => {
        calledUrl = typeof input === 'string' ? input : input.toString()
        return json(200, [])
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    await client.sync({ after: 'del_0a1b2c3d4e5f60718293a4b5c6d7e8f9', limit: 500 })

    const url = new URL(calledUrl)
    expect(url.pathname).toBe('/v1/messages/sync')
    expect(url.searchParams.get('after')).toBe('del_0a1b2c3d4e5f60718293a4b5c6d7e8f9')
    expect(url.searchParams.get('limit')).toBe('500')
  })
})

describe('client.syncAck() — {last_delivery_id} → {acked}', () => {
  it('POSTs the string cursor and returns the acked count', async () => {
    let capturedMethod = ''
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}
    const fetch = scriptedFetch([
      (input, init) => {
        capturedMethod = init?.method ?? ''
        capturedUrl = typeof input === 'string' ? input : input.toString()
        capturedBody = JSON.parse(init!.body as string)
        return json(200, { acked: 17 })
      },
    ])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.syncAck('del_ffeeddccbbaa99887766554433221100')

    expect(capturedMethod).toBe('POST')
    expect(capturedUrl).toBe('https://api.test/v1/messages/sync/ack')
    expect(capturedBody).toEqual({
      last_delivery_id: 'del_ffeeddccbbaa99887766554433221100',
    })
    expect(res.acked).toBe(17)
  })

  it('surfaces acked: 0 (repeated ack / owner-paused agent) without error', async () => {
    const fetch = scriptedFetch([json(200, { acked: 0 })])
    const client = new AgentChatClient({ apiKey: 'k', baseUrl: 'https://api.test', fetch })
    const res = await client.syncAck('del_0a1b2c3d4e5f60718293a4b5c6d7e8f9')
    expect(res.acked).toBe(0)
  })
})
