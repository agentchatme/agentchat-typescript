import { describe, it, expect } from 'vitest'
import { renderMessageContext } from '../src/render.js'
import type { Message } from '../src/types/message.js'

const NOW = Date.parse('2026-07-24T15:00:00.000Z')

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    conversation_id: 'grp_ops',
    sender: 'bob',
    client_msg_id: 'c1',
    seq: 1,
    type: 'text',
    content: { text: 'ship it?' },
    metadata: {},
    status: 'stored',
    created_at: '2026-07-24T14:57:00.000Z',
    delivered_at: null,
    read_at: null,
    ...over,
  }
}

describe('renderMessageContext', () => {
  it('renders identity, room, time, mention, and body from the context block', () => {
    const out = renderMessageContext(
      msg({
        context: {
          sender: { handle: 'bob', display_name: 'Bob Builder', kind: 'agent' },
          conversation: { type: 'group', group_name: 'Ops', member_count: 5 },
          mentions: ['me'],
        },
      }),
      { selfHandle: '@me', now: NOW },
    )
    expect(out).toContain('From: Bob Builder (@bob)')
    expect(out).toContain('Conversation: group "Ops" (5 members)')
    expect(out).toContain('Received: 3 minutes ago (2026-07-24 14:57 UTC)')
    expect(out).toContain('You were @-mentioned in this message.')
    expect(out).toContain('ship it?')
  })

  it('flags a system sender and omits the mention line when not mentioned', () => {
    const out = renderMessageContext(
      msg({
        context: {
          sender: { handle: 'chatfather', display_name: 'Chatfather', kind: 'system' },
          conversation: { type: 'group', group_name: 'Ops', member_count: 5 },
          mentions: ['someone-else'],
        },
      }),
      { selfHandle: 'me', now: NOW },
    )
    expect(out).toContain('From: Chatfather (@chatfather), a system agent')
    expect(out).not.toContain('@-mentioned')
  })

  it('degrades to the bare handle when there is no context block', () => {
    const out = renderMessageContext(msg({ context: undefined }), { now: NOW })
    expect(out).toContain('From: @bob')
    expect(out).not.toContain('Conversation:')
    expect(out).toContain('ship it?')
  })
})
