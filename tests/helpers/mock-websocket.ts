// Test double for the browser WebSocket surface the SDK uses: constructor,
// four event-handler slots, `send()`, `close()`, `readyState`. Injected via
// `RealtimeOptions.webSocket`. One instance list per class — tests call
// `reset()` in `beforeEach`.

type Listener = (event: Event) => void

export class MockWebSocket {
  static readonly instances: MockWebSocket[] = []
  static latest(): MockWebSocket {
    const last = MockWebSocket.instances.at(-1)
    if (!last) throw new Error('MockWebSocket.latest(): no instance yet')
    return last
  }
  static reset(): void {
    MockWebSocket.instances.length = 0
  }

  readonly url: string
  readyState = 0 // CONNECTING
  readonly sent: string[] = []
  closed: { code: number; reason: string } | null = null

  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  simulateOpen(): void {
    this.readyState = 1 // OPEN
    this.onopen?.({ type: 'open' } as Event)
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({
      type: 'message',
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as unknown as Event)
  }

  simulateClose(code = 1006, reason = 'abnormal', wasClean = false): void {
    this.readyState = 3 // CLOSED
    this.onclose?.({ type: 'close', code, reason, wasClean } as unknown as Event)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3
    this.closed = { code, reason }
  }
}

export const MockWebSocketCtor = MockWebSocket as unknown as typeof globalThis.WebSocket

/** Parsed frames of one type the client sent on a mock socket. */
export function sentFrames(ws: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return ws.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === type)
}

/** Let a handful of macrotask ticks run so async settlement completes. Real timers only. */
export async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** A `message.new` envelope for one conversation and seq. */
export function messageNew(
  conversationId: string,
  seq: number,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'message.new',
    payload: {
      id: `msg_${seq}`,
      conversation_id: conversationId,
      sender: '@other',
      client_msg_id: `c_${seq}`,
      seq,
      type: 'text',
      content: { text: `hi ${seq}` },
      metadata: {},
      status: 'stored',
      created_at: '2026-01-01T00:00:00Z',
      delivered_at: null,
      read_at: null,
      ...extra,
    },
  }
}
