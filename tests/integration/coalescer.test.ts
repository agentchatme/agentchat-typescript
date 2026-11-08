import { describe, expect, it } from 'vitest'
import { WakeCoalescer, type TimerHandle } from '../../src/integration/coalescer.js'
import { json } from './fixtures.js'

// ─── conformance/v1/coalescer.cases.json ────────────────────────────────────
//
// A deterministic clock: timers and cycle ends are entries in one queue,
// applied in time order with the fixture's rule for an instant — first what
// is due by then, then the events at it, then timers they armed for it.

interface Case {
  name: string
  quiet_ms: number
  max_ms: number
  cycle_ms: number | number[]
  events: Array<{ at: number; op: 'wake' | 'stop' }>
  run_until: number
  expect_cycles: number[]
}
interface Doc {
  rules: Record<string, string>
  cases: Case[]
}

const doc = json<Doc>('coalescer.cases.json')

interface Entry {
  id: number
  at: number
  fn: () => void
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function simulate(c: Case): Promise<number[]> {
  let now = 0
  let nextId = 1
  const queue: Entry[] = []
  const starts: number[] = []
  const durations = Array.isArray(c.cycle_ms) ? c.cycle_ms : [c.cycle_ms]

  const schedule = (fn: () => void, ms: number): TimerHandle => {
    const entry = { id: nextId++, at: now + Math.max(0, ms), fn }
    queue.push(entry)
    return entry.id as unknown as TimerHandle
  }
  const cancel = (handle: TimerHandle): void => {
    const index = queue.findIndex((e) => e.id === (handle as unknown as number))
    if (index >= 0) queue.splice(index, 1)
  }

  const coalescer = new WakeCoalescer({
    quietMs: c.quiet_ms,
    maxMs: c.max_ms,
    now: () => now,
    setTimeout: schedule,
    clearTimeout: cancel,
    onCycle: () => {
      const index = starts.length
      starts.push(now)
      const ms = durations[Math.min(index, durations.length - 1)] ?? 0
      return new Promise<void>((resolveCycle) => {
        schedule(resolveCycle, ms)
      })
    },
  })

  // Run every queued entry due at or before `t`, oldest deadline first.
  const runDue = async (t: number): Promise<void> => {
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id)
      const head = queue[0]
      if (!head || head.at > t) return
      queue.shift()
      now = head.at
      head.fn()
      await flush()
    }
  }

  const events = [...c.events].sort((a, b) => a.at - b.at)
  for (const event of events) {
    await runDue(event.at)
    now = event.at
    if (event.op === 'wake') coalescer.wake()
    else coalescer.stop()
    await flush()
    await runDue(event.at)
  }
  await runDue(c.run_until)
  return starts
}

describe('conformance — coalescer.cases.json', () => {
  it('names only the rules this harness knows', () => {
    expect(Object.keys(doc.rules).sort()).toEqual(['during_cycle', 'stop', 'validation', 'window'])
    expect(new Set(doc.cases.map((c) => c.name)).size).toBe(doc.cases.length)
  })

  it.each(doc.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    expect(await simulate(c)).toEqual(c.expect_cycles)
  })

  it('validation: max below quiet, or a negative quiet, is a configuration error', () => {
    expect(() => new WakeCoalescer({ onCycle: () => undefined, quietMs: 2000, maxMs: 1000 })).toThrow(RangeError)
    expect(() => new WakeCoalescer({ onCycle: () => undefined, quietMs: -1 })).toThrow(RangeError)
  })
})

describe('WakeCoalescer', () => {
  it('a cycle that throws or rejects ends the cycle and is reported; the next wake still runs', async () => {
    const errors: unknown[] = []
    let calls = 0
    const coalescer = new WakeCoalescer({
      quietMs: 0,
      maxMs: 0,
      onError: (err) => errors.push(err),
      onCycle: () => {
        calls += 1
        if (calls === 1) throw new Error('sync boom')
        return Promise.reject(new Error('async boom'))
      },
    })
    coalescer.wake()
    await new Promise((r) => setTimeout(r, 5))
    expect(coalescer.state).toBe('idle')
    coalescer.wake()
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toBe(2)
    expect(errors.map((e) => (e as Error).message)).toEqual(['sync boom', 'async boom'])
    expect(coalescer.counters()).toEqual({ wakes: 2, absorbed: 0, cycles: 2 })
  })

  it('reports its state and counts absorbed wakes', async () => {
    let release: () => void = () => undefined
    const coalescer = new WakeCoalescer({
      quietMs: 0,
      maxMs: 0,
      onCycle: () => new Promise<void>((r) => (release = r)),
    })
    expect(coalescer.state).toBe('idle')
    coalescer.wake()
    expect(coalescer.state).toBe('waiting')
    await new Promise((r) => setTimeout(r, 5))
    expect(coalescer.state).toBe('running')
    coalescer.wake()
    coalescer.wake()
    coalescer.wake()
    expect(coalescer.pending).toBe(true)
    expect(coalescer.counters()).toEqual({ wakes: 4, absorbed: 2, cycles: 1 })
    release()
    await new Promise((r) => setTimeout(r, 5))
    expect(coalescer.counters().cycles).toBe(2)
    release()
    await coalescer.settled()
    coalescer.stop()
    expect(coalescer.state).toBe('stopped')
  })
})
