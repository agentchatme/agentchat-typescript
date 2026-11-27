import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { integration } from '../../src/index.js'
import {
  LISTENER_REPORT_MIN_INTERVAL_MS,
  ListenerReporter,
  isListenerInstanceId,
  listenerInstanceId,
} from '../../src/integration/listener-reporter.js'
import { createAgentChatError } from '../../src/errors.js'
import type { CallOptions } from '../../src/client.js'
import type { ListenerReport, ReportListenerOptions } from '../../src/types/index.js'

// ─── The listener report, kept current (contract v1 §3.13) ───

const ID = 'inst_0123456789abcdef'
const MIN = 60_000

type Answer = 'ok' | Error

/** A client whose `reportListener` answers in turn (the last answer repeats), recording each call. */
function fakeClient(answers: Answer[] = ['ok']) {
  const calls: Array<ReportListenerOptions & CallOptions> = []
  let i = 0
  const reportListener = vi.fn(async (opts: ReportListenerOptions & CallOptions): Promise<ListenerReport> => {
    calls.push(opts)
    const answer = answers[Math.min(i, answers.length - 1)]!
    i += 1
    if (answer instanceof Error) throw answer
    return {
      instance_id: opts.instanceId,
      state: opts.state,
      reason_kind: opts.reasonKind ?? null,
      state_since: new Date().toISOString(),
      reported_at: new Date().toISOString(),
    }
  })
  return { client: { reportListener }, calls }
}

/** What reached the server, without the call options. */
const sent = (calls: Array<ReportListenerOptions & CallOptions>) =>
  calls.map(({ state, reasonKind }) => (reasonKind === undefined ? { state } : { state, reasonKind }))

const apiError = (status: number, body: { code: string; message: string; details?: Record<string, unknown> }, headers?: Record<string, string>) =>
  createAgentChatError(body, status, new Headers(headers))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-28T12:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('ListenerReporter: when it sends', () => {
  it('a change is one report, about a second later, with the instance id and the reason', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('runs_failing', 'runtime_check_failed')
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ instanceId: ID, state: 'runs_failing', reasonKind: 'runtime_check_failed' })
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(reporter.status()).toMatchObject({ state: 'runs_failing', pending: false, failures: 0, lastError: null })
    expect(reporter.status().reported).toEqual({
      state: 'runs_failing',
      reasonKind: 'runtime_check_failed',
      at: '2026-11-28T12:00:01.000Z',
    })
    reporter.stop()
  })

  it('the same state again is no report; ok and stopped send no reason; a failing state without one sends other', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('ok', 'runtime_missing')
    await vi.advanceTimersByTimeAsync(2_000)
    reporter.set('ok')
    reporter.set('ok', 'other')
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(sent(calls)).toEqual([{ state: 'ok' }])

    reporter.set('not_ready')
    await vi.advanceTimersByTimeAsync(MIN)
    reporter.set('not_ready', 'other') // the same report
    await vi.advanceTimersByTimeAsync(5 * MIN)
    reporter.set('stopped', 'not_signed_in')
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sent(calls)).toEqual([{ state: 'ok' }, { state: 'not_ready', reasonKind: 'other' }, { state: 'stopped' }])
    reporter.stop()
  })

  it('a new reason for the same failing state is a change', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('not_ready', 'not_signed_in')
    await vi.advanceTimersByTimeAsync(5 * MIN)
    reporter.set('not_ready', 'runtime_outdated')
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(sent(calls)).toEqual([
      { state: 'not_ready', reasonKind: 'not_signed_in' },
      { state: 'not_ready', reasonKind: 'runtime_outdated' },
    ])
    reporter.stop()
  })

  it('while not ok it re-sends every 30 minutes; ok is never re-sent', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('runs_failing', 'runtime_check_failed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30 * MIN - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(calls).toHaveLength(3)
    expect(sent(calls).every((c) => c.state === 'runs_failing')).toBe(true)

    reporter.set('ok')
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sent(calls).at(-1)).toEqual({ state: 'ok' })
    const afterOk = calls.length
    await vi.advanceTimersByTimeAsync(5 * 60 * MIN)
    expect(calls).toHaveLength(afterOk)
    expect(vi.getTimerCount()).toBe(0)
    reporter.stop()
  })

  it('rapid changes are one report, of the latest state', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('not_ready', 'runtime_missing')
    await vi.advanceTimersByTimeAsync(300)
    reporter.set('runs_failing')
    await vi.advanceTimersByTimeAsync(300)
    reporter.set('not_ready', 'not_signed_in')
    await vi.advanceTimersByTimeAsync(400)
    expect(sent(calls)).toEqual([{ state: 'not_ready', reasonKind: 'not_signed_in' }])
    reporter.stop()
  })

  it('a state that keeps changing is still reported: the wait runs from the first change of a burst', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    const flapping = ['not_ready', 'runs_failing'] as const
    for (let i = 0; i < 20; i++) {
      reporter.set(flapping[i % 2]!)
      await vi.advanceTimersByTimeAsync(200)
    }
    // t = 4 s: one report, at t = 1 s, of the state then (set at 0.8 s); the
    // next waits for the minute and carries the latest (set at 3.8 s).
    expect(sent(calls)).toEqual([{ state: 'not_ready', reasonKind: 'other' }])
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sent(calls)).toEqual([
      { state: 'not_ready', reasonKind: 'other' },
      { state: 'runs_failing', reasonKind: 'other' },
    ])
    reporter.stop()
  })

  it('a change back to what the server holds, before it was sent, is no report', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('ok')
    await vi.advanceTimersByTimeAsync(5 * MIN)
    reporter.set('runs_failing')
    await vi.advanceTimersByTimeAsync(500)
    reporter.set('ok')
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(sent(calls)).toEqual([{ state: 'ok' }])
    expect(reporter.status().pending).toBe(false)
    reporter.stop()
  })

  it('at most one attempt a minute: a change soon after a report waits for the minute', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('runs_failing')
    await vi.advanceTimersByTimeAsync(1_000) // sent at t = 1 s
    reporter.set('ok')
    await vi.advanceTimersByTimeAsync(LISTENER_REPORT_MIN_INTERVAL_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent(calls)).toEqual([{ state: 'runs_failing', reasonKind: 'other' }, { state: 'ok' }])
    reporter.stop()
  })

  it('a change while a report is under way is sent after it, not lost', async () => {
    let release!: () => void
    const { client, calls } = fakeClient()
    const slow = vi.fn(async (opts: ReportListenerOptions & CallOptions) => {
      if (calls.length === 0) await new Promise<void>((r) => (release = r))
      return client.reportListener(opts)
    })
    const reporter = new ListenerReporter({ client: { reportListener: slow }, instanceId: ID })
    reporter.set('not_ready')
    await vi.advanceTimersByTimeAsync(1_000)
    reporter.set('ok') // while the first is under way
    release()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sent(calls)).toEqual([{ state: 'not_ready', reasonKind: 'other' }, { state: 'ok' }])
    expect(reporter.status().pending).toBe(false)
    reporter.stop()
  })
})

describe('ListenerReporter: failures', () => {
  it('an error is retried with capped backoff (1, 2, 4, 8, 15, 15 min), told once, and never thrown', async () => {
    const down = new Error('fetch failed')
    const { client, calls } = fakeClient([down])
    const errors: string[] = []
    const reporter = new ListenerReporter({ client, instanceId: ID, onError: (e) => errors.push(e.message) })
    expect(() => reporter.set('runs_failing')).not.toThrow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(1)
    const gaps = [1, 2, 4, 8, 15, 15].map((m) => m * MIN)
    for (const gap of gaps) {
      const before = calls.length
      await vi.advanceTimersByTimeAsync(gap - 1)
      expect(calls).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(before + 1)
    }
    expect(errors).toEqual(['listener report (runs_failing): fetch failed; trying again later'])
    expect(reporter.status()).toMatchObject({ pending: true, failures: 7, lastError: 'fetch failed', reported: null })
    reporter.stop()
  })

  it('a success after failures resets the backoff and clears the error; a new failure is told again', async () => {
    const { client, calls } = fakeClient([new Error('down'), 'ok', new Error('down')])
    const errors: string[] = []
    const reporter = new ListenerReporter({ client, instanceId: ID, onError: (e) => errors.push(e.message) })
    reporter.set('not_ready')
    await vi.advanceTimersByTimeAsync(1_000 + MIN) // fails, then succeeds a minute later
    expect(calls).toHaveLength(2)
    expect(reporter.status()).toMatchObject({ pending: false, failures: 0, lastError: null })
    await vi.advanceTimersByTimeAsync(30 * MIN) // the re-send fails
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(MIN - 1)
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1) // retried after 1 min again, not 2
    expect(calls).toHaveLength(4)
    expect(errors).toHaveLength(2)
    reporter.stop()
  })

  it('a 429 waits as the server says (Retry-After), even past the backoff cap', async () => {
    const limited = apiError(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'Retry-After': '1800' })
    const { client, calls } = fakeClient([limited, 'ok'])
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('runs_failing')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(30 * MIN - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    expect(reporter.status().pending).toBe(false)
    reporter.stop()
  })

  it('a 503 LISTENER_REPORTS_UNAVAILABLE backs off; a 503 that names retry_after_s waits that long', async () => {
    const unavailable = apiError(503, { code: 'LISTENER_REPORTS_UNAVAILABLE', message: 'Listener reports are not available right now' })
    const busy = apiError(503, { code: 'SERVICE_UNAVAILABLE', message: 'busy', details: { retry_after_s: 300 } })
    const { client, calls } = fakeClient([unavailable, busy, 'ok'])
    const errors: string[] = []
    const reporter = new ListenerReporter({ client, instanceId: ID, onError: (e) => errors.push(e.message) })
    reporter.set('not_ready', 'runtime_missing')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(errors[0]).toContain('503 LISTENER_REPORTS_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(MIN) // the backoff's first minute
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5 * MIN - 1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(3)
    expect(reporter.status().pending).toBe(false)
    reporter.stop()
  })

  it('an onError that throws does not break the reporter', async () => {
    const { client, calls } = fakeClient([new Error('down'), 'ok'])
    const reporter = new ListenerReporter({
      client,
      instanceId: ID,
      onError: () => {
        throw new Error('observer bug')
      },
    })
    reporter.set('not_ready')
    await vi.advanceTimersByTimeAsync(1_000 + MIN)
    expect(calls).toHaveLength(2)
    expect(reporter.status().pending).toBe(false)
    reporter.stop()
  })
})

describe('ListenerReporter: flush and stop', () => {
  it('flush sends now and resolves whether the server holds it; never rejects', async () => {
    const { client, calls } = fakeClient(['ok', new Error('down')])
    const reporter = new ListenerReporter({ client, instanceId: ID })
    await expect(reporter.flush()).resolves.toBe(true) // nothing set: nothing pending
    reporter.set('stopped')
    await expect(reporter.flush()).resolves.toBe(true)
    expect(sent(calls)).toEqual([{ state: 'stopped' }])
    await expect(reporter.flush()).resolves.toBe(true) // already held: no second report
    expect(calls).toHaveLength(1)
    reporter.set('ok')
    await expect(reporter.flush()).resolves.toBe(false) // inside the minute, but flush does not wait; the server fails
    expect(calls).toHaveLength(2)
    reporter.stop()
    await expect(reporter.flush()).resolves.toBe(false)
  })

  it('flush keeps a wait the server named', async () => {
    const limited = apiError(429, { code: 'RATE_LIMITED', message: 'Too many requests' }, { 'Retry-After': '600' })
    const { client, calls } = fakeClient([limited, 'ok'])
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('stopped')
    await expect(reporter.flush()).resolves.toBe(false)
    await expect(reporter.flush()).resolves.toBe(false)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(calls).toHaveLength(2)
    await expect(reporter.flush()).resolves.toBe(true)
    reporter.stop()
  })

  it('stop() stops: no report after it, no timer left, a report under way abandoned', async () => {
    const { client, calls } = fakeClient()
    let signal: AbortSignal | undefined
    const hanging = vi.fn(async (opts: ReportListenerOptions & CallOptions) => {
      signal = opts.signal
      await new Promise((_resolve, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      return client.reportListener(opts)
    })
    const errors: string[] = []
    const reporter = new ListenerReporter({ client: { reportListener: hanging }, instanceId: ID, onError: (e) => errors.push(e.message) })
    reporter.set('runs_failing')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hanging).toHaveBeenCalledTimes(1)
    reporter.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(true)
    expect(errors).toEqual([]) // an abandoned report is not a failure to tell
    reporter.set('ok')
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    expect(hanging).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(reporter.status().stopped).toBe(true)
  })

  it('stop() clears a pending report and its timer', async () => {
    const { client, calls } = fakeClient()
    const reporter = new ListenerReporter({ client, instanceId: ID })
    reporter.set('not_ready')
    expect(vi.getTimerCount()).toBe(1)
    reporter.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(calls).toHaveLength(0)
  })

  it('its timers never keep the process alive (unref)', async () => {
    const { client } = fakeClient()
    const unref = vi.fn()
    const reporter = new ListenerReporter({
      client,
      instanceId: ID,
      setTimeout: (fn, ms) => ({ ...setTimeout(fn, ms), unref }) as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: () => undefined,
    })
    reporter.set('runs_failing')
    expect(unref).toHaveBeenCalledTimes(1)
    reporter.stop()
  })
})

describe('ListenerReporter: misuse', () => {
  it('throws a TypeError for a bad instance id, state or reason', () => {
    const { client } = fakeClient()
    expect(() => new ListenerReporter({ client, instanceId: 'short' })).toThrow(TypeError)
    expect(() => new ListenerReporter({ client, instanceId: 'has space in it' })).toThrow(TypeError)
    const reporter = new ListenerReporter({ client, instanceId: ID })
    expect(() => reporter.set('broken' as 'ok')).toThrow(TypeError)
    expect(() => reporter.set('not_ready', 'tired' as 'other')).toThrow(TypeError)
    expect(reporter.status().state).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is on the kit', () => {
    expect(integration.ListenerReporter).toBe(ListenerReporter)
    expect(integration.listenerInstanceId).toBe(listenerInstanceId)
    expect(integration.isListenerInstanceId('a'.repeat(8))).toBe(true)
    expect(integration.isListenerInstanceId('a'.repeat(65))).toBe(false)
  })
})

describe('listenerInstanceId', () => {
  beforeEach(() => vi.useRealTimers())
  const dir = () => mkdtempSync(join(tmpdir(), 'agentchat-listener-'))

  it('makes a 22-character URL-safe id once (mode 0600, no temp file left), and reuses it', async () => {
    const d = dir()
    const file = join(d, 'state', 'listener-instance')
    const id = await listenerInstanceId(file)
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(isListenerInstanceId(id)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(`${id}\n`)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(d, 'state'))).toEqual(['listener-instance'])
    await expect(listenerInstanceId(file)).resolves.toBe(id)
    expect(await listenerInstanceId(join(dir(), 'other'))).not.toBe(id)
  })

  it('keeps an id already in the file, surrounding whitespace aside', async () => {
    const file = join(dir(), 'listener-instance')
    writeFileSync(file, '  kept_id-from-an-older-install \n')
    await expect(listenerInstanceId(file)).resolves.toBe('kept_id-from-an-older-install')
    expect(readFileSync(file, 'utf8')).toBe('  kept_id-from-an-older-install \n')
  })

  it('replaces a file that holds no valid id', async () => {
    const file = join(dir(), 'listener-instance')
    writeFileSync(file, 'not an id!\n')
    const id = await listenerInstanceId(file)
    expect(isListenerInstanceId(id)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(`${id}\n`)
  })

  it('callers that start together all get the one id that was written', async () => {
    const d = dir()
    const file = join(d, 'listener-instance')
    const ids = await Promise.all(Array.from({ length: 8 }, () => listenerInstanceId(file)))
    expect(new Set(ids).size).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(`${ids[0]}\n`)
    expect(readdirSync(d)).toEqual(['listener-instance'])
  })
})
