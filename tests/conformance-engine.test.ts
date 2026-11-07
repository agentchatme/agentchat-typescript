import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { RealtimeClient } from '../src/realtime.js'
import type { AgentChatClient } from '../src/client.js'
import { MockWebSocket, MockWebSocketCtor, settle } from './helpers/mock-websocket.js'

// ─── conformance/v1/engine-scenarios.json ───────────────────────────────────
//
// The realtime engine's delivery rules (drain cursor, parked frames across a
// close, below-anchor repeats), as scenarios both SDKs run byte for byte.
// The fixture holds the steps and the expected outcomes; this file only
// interprets them. See the fixture's `about`, `ops` and `invariants`.

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../conformance/v1/engine-scenarios.json',
)

type Mode = 'default' | 'ack_on_receipt'
const MODES: Mode[] = ['default', 'ack_on_receipt']

interface Payload {
  id: string
  conversation_id: string
  seq: number
  [key: string]: unknown
}
interface Row extends Payload {
  delivery_id: string | null
}
type Step =
  | { op: 'connect' }
  | { op: 'drain' }
  | { op: 'close' }
  | { op: 'frame'; payload: Payload }
  | { op: 'wait_handler'; message_id: string }
  | { op: 'release'; message_id: string }
interface Expectation {
  cursor_acks?: string[]
  dispatched?: string[]
  dispatched_includes?: string[]
  ws_acks?: string[]
}
interface Scenario {
  name: string
  why: string
  hold?: string[]
  fail?: string[]
  sync_pages?: Row[][]
  steps: Step[]
  expect: Record<Mode, Expectation>
}
interface EngineDoc {
  ops: Record<string, string>
  expectations: Record<string, string>
  invariants: Record<string, string>
  scenarios: Scenario[]
}

const doc = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngineDoc

const OPS = ['close', 'connect', 'drain', 'frame', 'release', 'wait_handler']
const EXPECTATIONS = ['cursor_acks', 'dispatched', 'dispatched_includes', 'ws_acks']
const INVARIANTS = ['acked_was_handled', 'acks_follow_handling', 'dispatched_once', 'seq_order']

// One entry per thing the client did that the scenario can observe, in order.
type Event =
  | { kind: 'handled'; id: string }
  | { kind: 'ws_ack'; id: string }
  | { kind: 'cursor'; deliveryId: string }

interface Outcome {
  dispatched: Payload[]
  events: Event[]
  served: Row[]
}

async function run(scenario: Scenario, mode: Mode): Promise<Outcome> {
  const events: Event[] = []
  const dispatched: Payload[] = []
  const served: Row[] = []
  const pages = (scenario.sync_pages ?? []).map((page) => [...page])
  const client = {
    sync: async () => {
      const page = pages.shift() ?? []
      served.push(...page)
      return page
    },
    syncAck: async (deliveryId: string) => {
      events.push({ kind: 'cursor', deliveryId })
      return { acked: 1 }
    },
    getMessages: async () => [],
  } as unknown as AgentChatClient

  const releases = new Map<string, () => void>()
  const held = new Map<string, Promise<void>>()
  for (const id of scenario.hold ?? []) {
    held.set(id, new Promise<void>((r) => releases.set(id, r)))
  }
  const failing = new Set(scenario.fail ?? [])

  let rt: RealtimeClient | null = null
  let ws: MockWebSocket | null = null
  const drains: Promise<void>[] = []

  for (const step of scenario.steps) {
    switch (step.op) {
      case 'connect': {
        rt = new RealtimeClient({
          apiKey: 'k',
          webSocket: MockWebSocketCtor,
          reconnect: false,
          autoDrainOnConnect: false,
          ackOnReceipt: mode === 'ack_on_receipt',
          client,
        })
        rt.onError(() => undefined)
        rt.on('message.new', async (message) => {
          const payload = message.payload as unknown as Payload
          dispatched.push(payload)
          const hold = held.get(payload.id)
          if (hold) await hold
          if (failing.has(payload.id)) throw new Error(`scenario handler fails ${payload.id}`)
          events.push({ kind: 'handled', id: payload.id })
        })
        await rt.connect()
        const socket = MockWebSocket.latest()
        const send = socket.send.bind(socket)
        socket.send = (data: string) => {
          const frame = JSON.parse(data) as { type?: string; message_id?: string }
          if (frame.type === 'ack') events.push({ kind: 'ws_ack', id: String(frame.message_id) })
          send(data)
        }
        socket.simulateOpen()
        socket.simulateMessage({ type: 'hello.ok', capabilities: ['ack'] })
        ws = socket
        break
      }
      case 'frame':
        ws!.simulateMessage({ type: 'message.new', payload: step.payload })
        break
      case 'drain':
        drains.push(rt!.drainOfflineEnvelopes())
        break
      case 'wait_handler':
        for (let i = 0; i < 100 && !dispatched.some((p) => p.id === step.message_id); i++) {
          await settle(1)
        }
        expect(dispatched.map((p) => p.id), `handler entered for ${step.message_id}`).toContain(
          step.message_id,
        )
        break
      case 'close':
        ws!.simulateClose(1006, 'abnormal', false)
        break
      case 'release':
        releases.get(step.message_id)!()
        break
      default:
        throw new Error(`unknown op ${(step as { op: string }).op}`)
    }
    await settle()
  }
  await Promise.all(drains)
  await settle()
  const outcome = { dispatched: [...dispatched], events: [...events], served: [...served] }
  rt?.disconnect()
  return outcome
}

// Message ids an event acknowledges: an ack frame names one; a cursor covers
// every row served so far up to and including the row that carries it.
function acknowledged(event: Event, served: Row[]): string[] {
  if (event.kind === 'ws_ack') return [event.id]
  if (event.kind !== 'cursor') return []
  const index = served.findIndex((row) => row.delivery_id === event.deliveryId)
  expect(index, `cursor ${event.deliveryId} names a served row`).toBeGreaterThanOrEqual(0)
  return served.slice(0, index + 1).map((row) => row.id)
}

function checkInvariants(outcome: Outcome, mode: Mode): void {
  const { dispatched, events, served } = outcome
  const handledAt = new Map<string, number>()
  events.forEach((event, at) => {
    if (event.kind === 'handled' && !handledAt.has(event.id)) handledAt.set(event.id, at)
  })

  events.forEach((event, at) => {
    for (const id of acknowledged(event, served)) {
      // acked_was_handled
      expect(handledAt.has(id), `${id} acknowledged but never handled`).toBe(true)
      // acks_follow_handling
      if (event.kind === 'cursor' || mode === 'default') {
        expect(handledAt.get(id)!, `${id} acknowledged before it was handled`).toBeLessThan(at)
      }
    }
  })

  // dispatched_once
  const ids = dispatched.map((p) => p.id)
  expect(new Set(ids).size, `a message reached the handler twice: ${ids.join(', ')}`).toBe(ids.length)

  // seq_order
  const last = new Map<string, number>()
  for (const p of dispatched) {
    const previous = last.get(p.conversation_id)
    if (previous !== undefined) {
      expect(p.seq, `${p.conversation_id}: seq ${p.seq} after ${previous}`).toBeGreaterThan(previous)
    }
    last.set(p.conversation_id, p.seq)
  }
}

function checkExpectations(outcome: Outcome, expected: Expectation): void {
  const ids = outcome.dispatched.map((p) => p.id)
  if (expected.dispatched) expect(ids).toEqual(expected.dispatched)
  if (expected.dispatched_includes) {
    for (const id of expected.dispatched_includes) expect(ids).toContain(id)
  }
  if (expected.ws_acks) {
    const acks = outcome.events.flatMap((e) => (e.kind === 'ws_ack' ? [e.id] : []))
    expect(acks).toEqual(expected.ws_acks)
  }
  if (expected.cursor_acks) {
    const cursors = outcome.events.flatMap((e) => (e.kind === 'cursor' ? [e.deliveryId] : []))
    expect(cursors).toEqual(expected.cursor_acks)
  }
}

describe('conformance — engine-scenarios.json', () => {
  beforeEach(() => MockWebSocket.reset())

  it('names only ops, expectations and invariants this harness implements', () => {
    expect(Object.keys(doc.ops).sort()).toEqual(OPS)
    expect(Object.keys(doc.expectations).sort()).toEqual(EXPECTATIONS)
    expect(Object.keys(doc.invariants).sort()).toEqual(INVARIANTS)
    for (const scenario of doc.scenarios) {
      for (const step of scenario.steps) expect(OPS).toContain(step.op)
      expect(Object.keys(scenario.expect).sort()).toEqual([...MODES].sort())
      for (const mode of MODES) {
        for (const key of Object.keys(scenario.expect[mode])) expect(EXPECTATIONS).toContain(key)
      }
    }
  })

  it('has unique scenario names', () => {
    const names = doc.scenarios.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  for (const scenario of doc.scenarios) {
    for (const mode of MODES) {
      it(`${scenario.name} (${mode})`, async () => {
        const outcome = await run(scenario, mode)
        checkInvariants(outcome, mode)
        checkExpectations(outcome, scenario.expect[mode])
      })
    }
  }
})
