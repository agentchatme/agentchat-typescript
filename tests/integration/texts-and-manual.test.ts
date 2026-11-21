import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextsCache } from '../../src/integration/texts-cache.js'
import { ManualSync, manualVersion, syncManual, type ManualFetch } from '../../src/integration/manual-sync.js'
import { renameWithRetry, writeAtomic } from '../../src/integration/files.js'
import type { Texts } from '../../src/types/index.js'
import { json } from './fixtures.js'

const texts = json<Texts>('texts.sample.json')
const dir = () => mkdtempSync(join(tmpdir(), 'agentchat-kit-'))
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.useRealTimers())

function textsClient(answers: Array<Texts | Error | unknown>) {
  let i = 0
  const get = vi.fn(async (_opts: unknown) => {
    const answer = answers[Math.min(i, answers.length - 1)]
    i += 1
    if (answer instanceof Error) throw answer
    return answer as Texts
  })
  return { client: { texts: { get }, baseUrl: 'https://api.agentchat.me' }, get }
}

describe('TextsCache', () => {
  it('start: one fetch, kept in hand and in the file (v1 shape, mode 0600), one change event', async () => {
    const d = dir()
    const file = join(d, 'state', 'texts.json')
    const { client, get } = textsClient([texts])
    const cache = new TextsCache({ client, runtime: 'generic', filePath: file })
    const changes: string[] = []
    cache.onChange((_t, source) => changes.push(source))
    await expect(cache.start()).resolves.toEqual(texts)
    expect(cache.current()).toEqual(texts)
    expect(cache.source).toBe('server')
    expect(get).toHaveBeenCalledWith({ runtime: 'generic', timeoutMs: 10_000, retry: 'never' })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ version: 1, runtime: 'generic', texts })
    expect(typeof saved.fetched_at).toBe('string')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(d, 'state'))).toEqual(['texts.json']) // no temp file left
    expect(changes).toEqual(['server'])
    // The same texts again: no change event.
    await cache.refresh()
    expect(changes).toEqual(['server'])
    cache.stop()
  })

  it('offline start: the file is used, the failure said once, and the server copy replaces it when it answers', async () => {
    const d = dir()
    const file = join(d, 'texts.json')
    writeFileSync(file, JSON.stringify({ version: 1, runtime: 'generic', fetched_at: '2026-11-01T00:00:00.000Z', texts }))
    const newer = { ...texts, wake_instruction: `${texts.wake_instruction} (new)` }
    const { client } = textsClient([new Error('offline'), new Error('offline'), newer])
    const errors: string[] = []
    const cache = new TextsCache({ client, runtime: 'generic', filePath: file, onError: (e) => errors.push(e.message) })
    const changes: string[] = []
    cache.onChange((t, source) => changes.push(`${source}:${t.wake_instruction.endsWith('(new)')}`))
    await cache.start()
    expect(cache.source).toBe('cache')
    expect(cache.fetchedAt).toBe('2026-11-01T00:00:00.000Z')
    await cache.refresh()
    expect(errors).toHaveLength(1) // once per condition, not once per retry
    expect(cache.lastError).toBe('offline')
    await cache.refresh()
    expect(cache.source).toBe('server')
    expect(cache.lastError).toBeNull()
    expect(changes).toEqual(['cache:false', 'server:true'])
    cache.stop()
  })

  it('keeps reply_turn_template as served: in hand, in the file, and from the file on an offline start', async () => {
    const d = dir()
    const file = join(d, 'texts.json')
    const served = { ...texts, reply_turn_template: 'Answer conversation <conversation_id> only.' }
    const online = new TextsCache({ client: textsClient([served]).client, runtime: 'generic', filePath: file })
    await online.start()
    expect(online.current()?.reply_turn_template).toBe(served.reply_turn_template)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { texts: Texts }
    expect(saved.texts.reply_turn_template).toBe(served.reply_turn_template)
    online.stop()
    const offline = new TextsCache({ client: textsClient([new Error('offline')]).client, runtime: 'generic', filePath: file })
    await offline.start()
    expect(offline.source).toBe('cache')
    expect(offline.current()?.reply_turn_template).toBe(served.reply_turn_template)
    offline.stop()
    // Texts without it (an older server) are still a text set.
    const { reply_turn_template: _absent, ...older } = served
    const old = new TextsCache({ client: textsClient([older]).client, runtime: 'generic' })
    await old.start()
    expect(old.source).toBe('server')
    expect(old.current()?.reply_turn_template).toBeUndefined()
    old.stop()
  })

  it('a file written for another runtime, or a damaged one, is not used', async () => {
    const d = dir()
    const other = join(d, 'other.json')
    writeFileSync(other, JSON.stringify({ version: 1, runtime: 'hermes', fetched_at: 'x', texts }))
    const damaged = join(d, 'damaged.json')
    writeFileSync(damaged, '{"version": 1, "runtime": "gen')
    for (const file of [other, damaged]) {
      const { client } = textsClient([new Error('offline')])
      const cache = new TextsCache({ client, runtime: 'generic', filePath: file })
      await cache.start()
      expect(cache.current()).toBeNull()
      expect(cache.source).toBe('none')
      cache.stop()
    }
  })

  it('a failed refresh keeps the served copy (never the file); retries back off 5 min → 1 h; success returns to 24 h', async () => {
    vi.useFakeTimers()
    const answers: Array<Texts | Error> = [texts, ...Array<Error>(5).fill(new Error("503")), texts]
    const { client, get } = textsClient(answers)
    const cache = new TextsCache({ client, runtime: 'generic' })
    await cache.start()
    const at = () => get.mock.calls.length
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(at()).toBe(2) // the daily refresh, failed
    expect(cache.current()).toEqual(texts)
    expect(cache.source).toBe('server')
    const gaps = [5, 10, 20, 40, 60]
    for (const minutes of gaps) {
      const before = at()
      await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1)
      expect(at()).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(at()).toBe(before + 1)
    }
    // The last answer succeeded: the next is a day away.
    const before = at()
    await vi.advanceTimersByTimeAsync(23 * 3_600_000)
    expect(at()).toBe(before)
    cache.stop()
  })

  it('an answer that is not a text set, or texts for another runtime, is a failed fetch', async () => {
    for (const bad of [{ version: '1' }, { ...texts, runtime: 'hermes' }, { ...texts, identity_line: '' }]) {
      const { client } = textsClient([bad])
      const cache = new TextsCache({ client, runtime: 'generic' })
      await cache.start()
      expect(cache.current()).toBeNull()
      expect(cache.lastError).toMatch(/GET \/v1\/texts/)
      cache.stop()
    }
  })

  it('ensure() fetches once when the server has not answered yet; concurrent refreshes are one fetch', async () => {
    const { client, get } = textsClient([texts])
    const cache = new TextsCache({ client, runtime: 'generic' })
    const [a, b] = await Promise.all([cache.ensure(), cache.ensure()])
    expect(a).toEqual(texts)
    expect(b).toEqual(texts)
    expect(get).toHaveBeenCalledTimes(1)
    await cache.ensure()
    expect(get).toHaveBeenCalledTimes(1)
    expect(cache.apiBase).toBe('https://api.agentchat.me')
  })
})

// ─── ManualSync (port of agent-core skill/served-manual.ts) ─────────────────

const manual = (version: string, body = 'How to use AgentChat.\n') => `---\nname: agentchat\nversion: ${version}\n---\n\n${body}`
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const served = (version: string, text?: string) => ({
  url: 'https://agentchat.me/skill.md',
  version,
  ...(text !== undefined ? { sha256: sha(text) } : {}),
})

function fetchOf(routes: Record<string, () => Response>): { fetch: ManualFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch: ManualFetch = async (url, init) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`unexpected ${url}`)
    return route()
  }
  return { fetch, calls }
}
const ok = (text: string, headers: Record<string, string> = {}) => () => new Response(text, { status: 200, headers })
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } })

describe('syncManual', () => {
  it('a file at the announced version (and hash) is current: nothing fetched', async () => {
    const file = join(dir(), 'SKILL.md')
    writeFileSync(file, manual('2.2.2'))
    const { fetch, calls } = fetchOf({})
    const result = await syncManual({ path: file, served: served('2.2.2', manual('2.2.2')), apiBase: 'https://api.agentchat.me', fetch })
    expect(result).toMatchObject({ state: 'current', upToDate: true, written: false })
    expect(calls).toEqual([])
  })

  it('a different version is downloaded (no credentials, redirect: manual) and written over the old file', async () => {
    const file = join(dir(), 'skills', 'agentchat', 'SKILL.md')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, manual('2.2.1'))
    const { fetch, calls } = fetchOf({ 'https://agentchat.me/skill.md': ok(manual('2.2.2')) })
    const result = await syncManual({ path: file, served: served('2.2.2', manual('2.2.2')), apiBase: 'https://api.agentchat.me', fetch })
    expect(result).toMatchObject({ state: 'updated', source: 'download', previous: '2.2.1', version: '2.2.2', upToDate: true })
    expect(readFileSync(file, 'utf8')).toBe(manual('2.2.2'))
    expect(calls[0]!.init.redirect).toBe('manual')
    expect(new Headers(calls[0]!.init.headers).has('authorization')).toBe(false)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  it.each([
    ['a 404', () => new Response('nope', { status: 404 }), /HTTP 404/],
    ['the wrong version', ok(manual('2.2.3')), /version 2\.2\.3/],
    ['another skill', ok('---\nname: other\nversion: 2.2.2\n---\n'), /not the agentchat skill/],
    ['no front matter', ok('just text'), /no front matter/],
    ['a body over the cap', ok(manual('2.2.2', 'x'.repeat(600 * 1024))), /cap/],
    ['a declared length over the cap', ok(manual('2.2.2'), { 'content-length': String(10 * 1024 * 1024) }), /declared/],
    ['a NUL byte', ok(manual('2.2.2', 'a\u0000b')), /not text/],
    ['a sha256 that does not match', ok(manual('2.2.2', 'tampered\n')), /sha256/],
  ])('%s: the old file is kept byte for byte, the reason said', async (_what, route, reason) => {
    const file = join(dir(), 'SKILL.md')
    writeFileSync(file, manual('2.2.1'))
    const { fetch } = fetchOf({ 'https://agentchat.me/skill.md': route })
    const result = await syncManual({ path: file, served: served('2.2.2', manual('2.2.2')), apiBase: 'https://api.agentchat.me', fetch })
    expect(result.state).toBe('kept')
    expect(result.error).toMatch(reason)
    expect(readFileSync(file, 'utf8')).toBe(manual('2.2.1'))
  })

  it('every redirect hop is checked: https → http is refused at the plaintext hop, which is never requested', async () => {
    const file = join(dir(), 'SKILL.md')
    const { fetch, calls } = fetchOf({ 'https://agentchat.me/skill.md': redirect('http://agentchat.me/skill.md') })
    const result = await syncManual({ path: file, served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch })
    expect(result.state).toBe('failed')
    expect(result.error).toMatch(/HTTPS only/)
    expect(calls.map((c) => c.url)).toEqual(['https://agentchat.me/skill.md'])
  })

  it('three checked redirects are followed; a fourth is refused; a hop off the allowed hosts is refused', async () => {
    const a = 'https://agentchat.me/a'
    const b = 'https://cdn.agentchat.me/b'
    const c = 'https://api.agentchat.me/c'
    const d = 'https://agentchat.me/d'
    const three = fetchOf({ 'https://agentchat.me/skill.md': redirect(a), [a]: redirect(b), [b]: redirect(c), [c]: ok(manual('2.2.2')) })
    const file = join(dir(), 'SKILL.md')
    expect((await syncManual({ path: file, served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch: three.fetch })).state).toBe('updated')
    const four = fetchOf({ 'https://agentchat.me/skill.md': redirect(a), [a]: redirect(b), [b]: redirect(c), [c]: redirect(d), [d]: ok(manual('2.2.2')) })
    const r4 = await syncManual({ path: join(dir(), 'SKILL.md'), served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch: four.fetch })
    expect(r4.error).toMatch(/more than 3 redirects/)
    const off = fetchOf({ 'https://agentchat.me/skill.md': redirect('https://agentchat.me.evil.example/skill.md') })
    const r5 = await syncManual({ path: join(dir(), 'SKILL.md'), served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch: off.fetch })
    expect(r5.error).toMatch(/neither agentchat\.me nor the API's own host/)
    expect(off.calls).toHaveLength(1)
  })

  it('refuses before any request: another host, credentials in the URL, a plain-HTTP API base off loopback, no API base', async () => {
    const cases: Array<[string, string | null, RegExp]> = [
      ['https://example.com/skill.md', 'https://api.agentchat.me', /neither/],
      ['https://user:pw@agentchat.me/skill.md', 'https://api.agentchat.me', /credentials/],
      ['https://agentchat.me/skill.md', 'http://api.agentchat.me', /not HTTPS/],
      ['https://agentchat.me/skill.md', null, /no API base/],
    ]
    for (const [url, apiBase, reason] of cases) {
      const { fetch, calls } = fetchOf({})
      const result = await syncManual({ path: join(dir(), 'SKILL.md'), served: { url, version: '2.2.2' }, apiBase, fetch })
      expect(result.error).toMatch(reason)
      expect(calls).toEqual([])
    }
  })

  it('a development server: plain HTTP to loopback only from a loopback API base', async () => {
    const { fetch } = fetchOf({ 'http://localhost:3000/skill.md': ok(manual('2.2.2')) })
    const file = join(dir(), 'SKILL.md')
    const result = await syncManual({ path: file, served: { url: 'http://localhost:3000/skill.md', version: '2.2.2' }, apiBase: 'http://localhost:3000', fetch })
    expect(result.state).toBe('updated')
    const fromTls = await syncManual({ path: join(dir(), 'SKILL.md'), served: { url: 'http://localhost:3000/skill.md', version: '2.2.2' }, apiBase: 'https://localhost:3000', fetch })
    expect(fromTls.error).toMatch(/HTTPS only/)
  })

  it('a tampered file carrying the right version is not current, and a sync repairs it', async () => {
    const file = join(dir(), 'SKILL.md')
    writeFileSync(file, manual('2.2.2', 'edited by someone\n'))
    const { fetch } = fetchOf({ 'https://agentchat.me/skill.md': ok(manual('2.2.2')) })
    const result = await syncManual({ path: file, served: served('2.2.2', manual('2.2.2')), apiBase: 'https://api.agentchat.me', fetch })
    expect(result).toMatchObject({ state: 'updated', tampered: true })
    expect(readFileSync(file, 'utf8')).toBe(manual('2.2.2'))
  })

  it('a malformed announced hash is refused, never ignored', async () => {
    const file = join(dir(), 'SKILL.md')
    writeFileSync(file, manual('2.2.1'))
    const { fetch, calls } = fetchOf({})
    const result = await syncManual({ path: file, served: { ...served('2.2.2'), sha256: 'nothex' }, apiBase: 'https://api.agentchat.me', fetch })
    expect(result).toMatchObject({ state: 'kept', error: 'the announced sha256 is not a hex sha256' })
    expect(calls).toEqual([])
  })

  it('a BOM and CRLF are read as LF for the version, and the exact bytes are placed', async () => {
    const text = `﻿${manual('2.2.2').replace(/\n/g, '\r\n')}`
    expect(manualVersion(text)).toBe('2.2.2')
    const bytes = new TextEncoder().encode(text)
    const { fetch } = fetchOf({ 'https://agentchat.me/skill.md': () => new Response(bytes, { status: 200 }) })
    const file = join(dir(), 'SKILL.md')
    const result = await syncManual({ path: file, served: { ...served('2.2.2'), sha256: sha(bytes) }, apiBase: 'https://api.agentchat.me', fetch })
    expect(result.state).toBe('updated')
    expect(sha(readFileSync(file))).toBe(sha(bytes))
    const again = await syncManual({ path: file, served: { ...served('2.2.2'), sha256: sha(bytes) }, apiBase: 'https://api.agentchat.me', fetch })
    expect(again.state).toBe('current')
  })

  it('no file and nothing verified: the integration fallback is written; without one, failed', async () => {
    const { fetch } = fetchOf({ 'https://agentchat.me/skill.md': () => new Response('x', { status: 500 }) })
    const file = join(dir(), 'SKILL.md')
    const result = await syncManual({ path: file, served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch, fallback: manual('2.2.0') })
    expect(result).toMatchObject({ state: 'fallback', version: '2.2.0', upToDate: false })
    const none = await syncManual({ path: join(dir(), 'SKILL.md'), served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch })
    expect(none.state).toBe('failed')
  })

  it('a fallback that is the announced manual is placed without a download', async () => {
    const { fetch, calls } = fetchOf({})
    const result = await syncManual({ path: join(dir(), 'SKILL.md'), served: served('2.2.2', manual('2.2.2')), apiBase: 'https://api.agentchat.me', fetch, fallback: manual('2.2.2') })
    expect(result).toMatchObject({ state: 'updated', source: 'fallback' })
    expect(calls).toEqual([])
  })

  it('a write that fails leaves the old file intact and no temp file behind', async () => {
    const d = dir()
    const file = join(d, 'SKILL.md')
    writeFileSync(file, manual('2.2.1'))
    const { fetch } = fetchOf({ 'https://agentchat.me/skill.md': ok(manual('2.2.2')) })
    const rename = vi.fn(async () => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    })
    const result = await syncManual({ path: file, served: served('2.2.2'), apiBase: 'https://api.agentchat.me', fetch, rename })
    expect(result.state).toBe('kept')
    expect(result.error).toMatch(/could not write/)
    expect(readFileSync(file, 'utf8')).toBe(manual('2.2.1'))
    expect(readdirSync(d)).toEqual(['SKILL.md'])
  })
})

describe('ManualSync', () => {
  it('follows the texts: syncs at start and on every change, serialised; stop aborts', async () => {
    const file = join(dir(), 'SKILL.md')
    let listener: ((t: Texts) => void) | null = null
    let current: Texts | null = { ...texts, manual: served('2.2.1') }
    const source = {
      current: () => current,
      onChange: (fn: (t: Texts) => void) => {
        listener = fn
        return () => (listener = null)
      },
      apiBase: 'https://api.agentchat.me',
    }
    const { fetch, calls } = fetchOf({
      'https://agentchat.me/skill.md': () => new Response(manual(current!.manual.version), { status: 200 }),
    })
    const results: string[] = []
    const sync = new ManualSync({ texts: source, targetPath: file, fetch, onResult: (r) => results.push(`${r.state}:${r.version}`) })
    await sync.start()
    expect(manualVersion(readFileSync(file, 'utf8'))).toBe('2.2.1')
    current = { ...texts, manual: served('2.2.2') }
    listener!(current)
    await sync.sync() // queued behind the change: same version, nothing fetched
    expect(manualVersion(readFileSync(file, 'utf8'))).toBe('2.2.2')
    expect(calls).toHaveLength(2)
    expect(results).toEqual(['updated:2.2.1', 'updated:2.2.2', 'current:2.2.2'])
    sync.stop()
    expect(listener).toBeNull()
    await expect(sync.sync()).resolves.toBeNull()
  })
})

// ─── ManualSync: retries while the file is not current ─────────────────────

// The retry tests wait on real file I/O (see `until`): a slow runner gets a
// longer budget than vitest's default 5 s per test.
describe('ManualSync retries', { timeout: 30_000 }, () => {
  const MIN = 60_000
  /** Real time `until` gives a condition, well inside the suite's 30 s per test. */
  const UNTIL_BUDGET_MS = 10_000
  const MANUAL_URL = 'https://agentchat.me/skill.md'

  // Only the timers are fake: setImmediate stays real, so the real file I/O
  // a sync does can finish while the clock stands still.
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const timeouts = () => vi.spyOn(globalThis, 'setTimeout')

  // The spies first, then the clock: restoring a spy on the fake setTimeout
  // after the real one is back would put the fake back.
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /**
   * Wait for `condition`, for up to `UNTIL_BUDGET_MS` of real time. A sync
   * reads and writes real files on the libuv threadpool, which on a slow or
   * busy runner can take longer than any fixed number of event-loop turns,
   * so the bound is elapsed time (`performance.now()`, which the fake timers
   * leave alone), never a count. Each turn is a real `setImmediate`, so the
   * file I/O completes while the fake clock stands still.
   */
  async function until(what: string, condition: () => boolean): Promise<void> {
    const deadline = performance.now() + UNTIL_BUDGET_MS
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`never happened within ${UNTIL_BUDGET_MS} ms: ${what}`)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** A texts source announcing `manual`, whose change the test fires. */
  function announcing(manualServed: Texts['manual'] | null) {
    const listeners = new Set<(t: Texts) => void>()
    let current: Texts | null = manualServed === null ? null : { ...texts, manual: manualServed }
    return {
      source: {
        current: () => current,
        onChange: (fn: (t: Texts) => void) => {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
        apiBase: 'https://api.agentchat.me',
      },
      change(next: Texts['manual']): void {
        const changed = { ...texts, manual: next }
        current = changed
        for (const fn of listeners) fn(changed)
      },
    }
  }

  /** For a real `TextsCache` whose own timer the test stands in for. */
  const noCacheTimer = {
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
  }

  /** The manual address: offline while `offline()` says so, else the manual at the version asked. */
  function download(offline: () => boolean, version: () => string) {
    const calls: string[] = []
    const fetch: ManualFetch = async (url) => {
      calls.push(url)
      if (offline()) throw new TypeError('fetch failed')
      return new Response(manual(version()), { status: 200 })
    }
    return { fetch, calls }
  }

  it('offline start with cached texts announcing a newer manual: the retry places it, with no texts change', async () => {
    fakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // no jitter: the steps exactly
    const d = dir()
    const textsFile = join(d, 'texts.json')
    const skill = join(d, 'SKILL.md')
    const announced = served('2.2.2', manual('2.2.2'))
    writeFileSync(textsFile, JSON.stringify({ version: 1, runtime: 'generic', fetched_at: '2026-11-01T00:00:00.000Z', texts: { ...texts, manual: announced } }))
    writeFileSync(skill, manual('2.2.1'))
    // The API is offline at start, then answers the same texts it announced before. The
    // cache's own timer is left out: the test refreshes where it would.
    const { client, get } = textsClient([new Error('offline'), { ...texts, manual: announced }])
    const cache = new TextsCache({ client, runtime: 'generic', filePath: textsFile, ...noCacheTimer })
    const changes: string[] = []
    cache.onChange((_t, source) => changes.push(source))
    let offline = true
    const { fetch, calls } = download(() => offline, () => '2.2.2')
    const results: string[] = []
    const sync = new ManualSync({ texts: cache, targetPath: skill, fetch, onResult: (r) => results.push(`${r.state}:${r.error ?? ''}`) })

    await cache.start()
    expect(cache.source).toBe('cache')
    const first = await sync.start()
    expect(first).toMatchObject({ state: 'kept', version: '2.2.1', served: '2.2.2', upToDate: false })
    expect(readFileSync(skill, 'utf8')).toBe(manual('2.2.1')) // never worse than before

    // The texts come back unchanged: no change event, so only the retry can help.
    await expect(cache.refresh()).resolves.toBe(true)
    expect(cache.source).toBe('server')
    expect(changes).toEqual(['cache'])

    // 5 min: the retry refreshes the texts (the same again) and syncs against them; still offline.
    await vi.advanceTimersByTimeAsync(5 * MIN - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await until('the first retry', () => calls.length === 2 && sync.result !== first)
    expect(get).toHaveBeenCalledTimes(3)
    expect(changes).toEqual(['cache'])
    expect(sync.result).toMatchObject({ state: 'kept', upToDate: false })

    // 10 min later the network is back: the retry places the announced manual.
    offline = false
    await vi.advanceTimersByTimeAsync(10 * MIN - 1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await until('the second retry', () => sync.result?.state === 'updated')
    expect(get).toHaveBeenCalledTimes(4)
    expect(readFileSync(skill, 'utf8')).toBe(manual('2.2.2'))
    expect(sync.result).toMatchObject({ state: 'updated', version: '2.2.2', upToDate: true })
    expect(changes).toEqual(['cache'])
    expect(results).toEqual(['kept:fetch failed', 'updated:']) // the repeated failure said once

    // Current: nothing more is fetched.
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN)
    expect(calls).toEqual([MANUAL_URL, MANUAL_URL, MANUAL_URL])
    sync.stop()
    cache.stop()
  })

  it('repeated failures back off 5 → 10 → 20 → 40 → 60 → 60 min, each within ±20 %, one at a time', async () => {
    fakeTimers()
    const armed = timeouts()
    const skill = join(dir(), 'SKILL.md')
    writeFileSync(skill, manual('2.2.1'))
    const { source } = announcing(served('2.2.2'))
    const { fetch, calls } = download(() => true, () => '2.2.2')
    const results: string[] = []
    const sync = new ManualSync({ texts: source, targetPath: skill, fetch, onResult: (r) => results.push(r.state) })
    await sync.start()
    const delays = () => armed.mock.calls.map((call) => call[1] as number)
    for (const [i, minutes] of [5, 10, 20, 40, 60, 60].entries()) {
      await until(`retry ${i + 1} armed`, () => delays().length === i + 1)
      expect(vi.getTimerCount()).toBe(1)
      const ms = delays()[i]!
      expect(ms).toBeGreaterThanOrEqual(Math.floor(minutes * MIN * 0.8))
      expect(ms).toBeLessThanOrEqual(Math.ceil(minutes * MIN * 1.2))
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(calls).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      await until(`retry ${i + 1} ran`, () => calls.length === i + 2)
    }
    expect(results).toEqual(['kept']) // one report for one condition, as before
    sync.stop()
  })

  it('the jitter spans 0.8× to 1.2× of the step', async () => {
    fakeTimers()
    const armed = timeouts()
    const skill = join(dir(), 'SKILL.md')
    for (const [random, expected] of [
      [0, 4 * MIN],
      [0.999_999, Math.floor(5 * MIN * (0.8 + 0.999_999 * 0.4))],
    ] as const) {
      armed.mockClear()
      vi.spyOn(Math, 'random').mockReturnValue(random)
      const { fetch } = download(() => true, () => '2.2.2')
      const sync = new ManualSync({ texts: announcing(served('2.2.2')).source, targetPath: skill, fetch })
      await sync.start()
      expect(armed.mock.calls.map((call) => call[1])).toEqual([expected])
      sync.stop()
    }
  })

  it('a success stops the retries', async () => {
    fakeTimers()
    const skill = join(dir(), 'SKILL.md')
    writeFileSync(skill, manual('2.2.1'))
    let offline = true
    const { fetch, calls } = download(() => offline, () => '2.2.2')
    const sync = new ManualSync({ texts: announcing(served('2.2.2')).source, targetPath: skill, fetch })
    await sync.start()
    expect(vi.getTimerCount()).toBe(1)
    offline = false
    await vi.advanceTimersByTimeAsync(6 * MIN)
    await until('the retry placed it', () => sync.result?.state === 'updated')
    expect(readFileSync(skill, 'utf8')).toBe(manual('2.2.2'))
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN)
    expect(calls).toHaveLength(2)
    sync.stop()
  })

  it('a texts change during the backoff syncs at once and starts the backoff over', async () => {
    fakeTimers()
    const armed = timeouts()
    const skill = join(dir(), 'SKILL.md')
    writeFileSync(skill, manual('2.2.1'))
    const announcer = announcing(served('2.2.2'))
    let offline = true
    let version = '2.2.2'
    const { fetch, calls } = download(() => offline, () => version)
    const sync = new ManualSync({ texts: announcer.source, targetPath: skill, fetch })
    await sync.start()
    const delays = () => armed.mock.calls.map((call) => call[1] as number)
    // Two retries fail: the third waits about 20 min.
    for (let i = 0; i < 2; i++) {
      await until(`retry ${i + 1} armed`, () => delays().length === i + 1)
      await vi.advanceTimersByTimeAsync(delays()[i]!)
      await until(`retry ${i + 1} ran`, () => calls.length === i + 2)
    }
    await until('retry 3 armed', () => delays().length === 3)
    expect(delays()[2]).toBeGreaterThanOrEqual(16 * MIN)

    // A new announcement, still offline: synced now, with no time passing; the backoff is back at 5 min.
    version = '2.2.3'
    announcer.change(served('2.2.3'))
    await until('the change synced', () => calls.length === 4)
    await until('the next retry armed', () => delays().length === 4)
    expect(vi.getTimerCount()).toBe(1) // the 20 min retry was cancelled, not added to
    expect(delays()[3]).toBeGreaterThanOrEqual(4 * MIN)
    expect(delays()[3]).toBeLessThanOrEqual(6 * MIN)
    expect(sync.result).toMatchObject({ state: 'kept', served: '2.2.3', upToDate: false })

    // Online again: the retry places the new announcement.
    offline = false
    await vi.advanceTimersByTimeAsync(delays()[3]!)
    await until('the retry placed it', () => sync.result?.state === 'updated')
    expect(readFileSync(skill, 'utf8')).toBe(manual('2.2.3'))
    expect(vi.getTimerCount()).toBe(0)
    sync.stop()
  })

  it('stop() cancels the pending retry, and a sync in flight at stop arms none', async () => {
    fakeTimers()
    const skill = join(dir(), 'SKILL.md')
    writeFileSync(skill, manual('2.2.1'))
    const { fetch, calls } = download(() => true, () => '2.2.2')
    const sync = new ManualSync({ texts: announcing(served('2.2.2')).source, targetPath: skill, fetch })
    await sync.start()
    expect(vi.getTimerCount()).toBe(1)
    sync.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    expect(calls).toHaveLength(1)
    await expect(sync.sync()).resolves.toBeNull()

    // A download still in flight when stop() is called arms nothing after it.
    let release = (): void => undefined
    const blocked: string[] = []
    const slow: ManualFetch = async (url) => {
      blocked.push(url)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      throw new TypeError('fetch failed')
    }
    const other = new ManualSync({ texts: announcing(served('2.2.2')).source, targetPath: skill, fetch: slow })
    const first = other.start()
    await until('the download started', () => blocked.length === 1)
    other.stop()
    release()
    await first
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    expect(blocked).toHaveLength(1)
  })

  it('the pending retry does not keep the process alive (a real timer, unref)', async () => {
    const armed = timeouts()
    const { fetch } = download(() => true, () => '2.2.2')
    const sync = new ManualSync({ texts: announcing(served('2.2.2')).source, targetPath: join(dir(), 'SKILL.md'), fetch })
    await sync.start()
    expect(armed).toHaveBeenCalledTimes(1)
    const handle = armed.mock.results[0]!.value as ReturnType<typeof setTimeout>
    expect(handle.hasRef()).toBe(false)
    sync.stop()
  })

  it('nothing announced, or not following (sync() without start()): no retry', async () => {
    fakeTimers()
    const skill = join(dir(), 'SKILL.md')
    const { fetch, calls } = download(() => true, () => '2.2.2')
    const none = new ManualSync({ texts: announcing(null).source, targetPath: skill, fetch })
    await expect(none.start()).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    expect(calls).toEqual([])
    none.stop()

    const once = new ManualSync({ texts: announcing(served('2.2.2')).source, targetPath: skill, fetch })
    await expect(once.sync()).resolves.toMatchObject({ state: 'failed', upToDate: false })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
    expect(calls).toHaveLength(1)
  })

  // ─── each retry refreshes the texts first ────────────────────────────────

  describe('refreshing the texts', () => {
    /**
     * `GET /v1/texts` for a real `TextsCache` (its own timer left out): it
     * announces `manual`, fails while `down`, and while `hold` is set waits
     * for `release()` before it answers.
     */
    function textsServer(manualServed: Texts['manual']) {
      const state = { manual: manualServed, down: false, hold: false }
      let releases: Array<() => void> = []
      const get = vi.fn(async (_opts: unknown) => {
        if (state.hold) await new Promise<void>((resolve) => releases.push(resolve))
        if (state.down) throw new Error('503')
        return { ...texts, manual: state.manual }
      })
      const cache = new TextsCache({ client: { texts: { get }, baseUrl: 'https://api.agentchat.me' }, runtime: 'generic', ...noCacheTimer })
      const release = (): void => {
        const waiting = releases
        releases = []
        state.hold = false
        for (const resolve of waiting) resolve()
      }
      return { state, get, cache, release }
    }

    /** Real time for real file I/O to finish (only setTimeout is fake): to see that nothing more happens. */
    async function settle(ms = 50): Promise<void> {
      const end = performance.now() + ms
      while (performance.now() < end) await new Promise((resolve) => setImmediate(resolve))
    }

    /** The manual address, serving `version()` unless offline. */
    function address(version: () => string, offline: () => boolean = () => false) {
      return download(offline, version)
    }

    it('the lab case: a new manual announced during the backoff is placed by the next retry, not refused until the daily refetch', async () => {
      fakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2')))
      let published = '2.4.2'
      let offline = true
      const { fetch, calls } = address(() => published, () => offline)
      const results: string[] = []
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch, onResult: (r) => results.push(`${r.state}:${r.served}`) })
      await server.cache.start()
      await expect(sync.start()).resolves.toMatchObject({ state: 'kept', served: '2.4.2', upToDate: false })
      expect(vi.getTimerCount()).toBe(1) // the retry, pending

      // The server ships 2.4.3: the address and the announcement both move on.
      published = '2.4.3'
      server.state.manual = served('2.4.3', manual('2.4.3'))
      offline = false

      await vi.advanceTimersByTimeAsync(5 * MIN)
      await until('the retry placed 2.4.3', () => sync.result?.state === 'updated')
      expect(readFileSync(skill, 'utf8')).toBe(manual('2.4.3'))
      expect(sync.result).toMatchObject({ state: 'updated', served: '2.4.3', version: '2.4.3', upToDate: true })
      await settle()
      expect(server.get).toHaveBeenCalledTimes(2) // start, and the retry's refresh
      expect(calls).toHaveLength(2) // no download synced against the old announcement
      expect(results).toEqual(['kept:2.4.2', 'updated:2.4.3']) // the change's sync only, no second one
      expect(vi.getTimerCount()).toBe(0)
      sync.stop()
      server.cache.stop()
    })

    it('a download that is another manual refreshes the texts at once; the new announcement is placed with no time passing', async () => {
      fakeTimers()
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2')))
      await server.cache.start()
      // The texts in hand are behind: the server already ships 2.4.3.
      server.state.manual = served('2.4.3', manual('2.4.3'))
      const { fetch, calls } = address(() => '2.4.3')
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch })
      const first = await sync.start()
      expect(first).toMatchObject({ state: 'kept', version: '2.4.1', served: '2.4.2' })
      expect(first?.error).toMatch(/the body is version 2\.4\.3, the server announced 2\.4\.2/)
      await until('the refreshed announcement placed', () => sync.result?.state === 'updated')
      expect(readFileSync(skill, 'utf8')).toBe(manual('2.4.3'))
      expect(server.get).toHaveBeenCalledTimes(2)
      expect(calls).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
      sync.stop()
    })

    it('an address ahead of the announcement: one refresh at once, then the backoff; the body is never accepted', async () => {
      fakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const armed = timeouts()
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2'))) // keeps announcing 2.4.2
      await server.cache.start()
      const { fetch, calls } = address(() => '2.4.3')
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch })
      await sync.start()
      await until('the refresh at once', () => server.get.mock.calls.length === 2)
      await vi.advanceTimersByTimeAsync(0)
      expect(armed.mock.calls.map((call) => call[1])).toEqual([5 * MIN])
      expect(calls).toHaveLength(1)

      // The retry refreshes (the same texts) and syncs; that sync's refusal asks for no second refresh.
      await vi.advanceTimersByTimeAsync(5 * MIN)
      await until('the retry', () => armed.mock.calls.length === 2)
      expect(server.get).toHaveBeenCalledTimes(3)
      expect(calls).toHaveLength(2)
      expect(armed.mock.calls[1]![1]).toBe(10 * MIN)
      expect(sync.result).toMatchObject({ state: 'kept', served: '2.4.2' })
      expect(readFileSync(skill, 'utf8')).toBe(manual('2.4.1'))
      sync.stop()
    })

    it('a retry whose refresh finds the texts unchanged still syncs against them', async () => {
      fakeTimers()
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2')))
      const changes: string[] = []
      server.cache.onChange((_t, source) => changes.push(source))
      await server.cache.start()
      let offline = true
      const { fetch, calls } = address(() => '2.4.2', () => offline)
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch })
      await sync.start()
      offline = false
      await vi.advanceTimersByTimeAsync(6 * MIN)
      await until('the retry placed it', () => sync.result?.state === 'updated')
      expect(readFileSync(skill, 'utf8')).toBe(manual('2.4.2'))
      expect(server.get).toHaveBeenCalledTimes(2)
      expect(changes).toEqual(['server']) // the start only: the retry's refresh changed nothing
      expect(calls).toHaveLength(2)
      sync.stop()
    })

    it('a refresh that fails lets the retry go on with the texts in hand; a failing cache is left to its own backoff', async () => {
      fakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2')))
      await server.cache.start()
      let offline = true
      const { fetch, calls } = address(() => '2.4.2', () => offline)
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch })
      await sync.start()

      server.state.down = true
      await vi.advanceTimersByTimeAsync(5 * MIN)
      await until('the first retry', () => calls.length === 2)
      expect(server.get).toHaveBeenCalledTimes(2) // the refresh, failed
      expect(server.cache.lastError).toBe('503')
      await until('the next retry armed', () => vi.getTimerCount() === 1)

      // The cache is failing: the next retry asks it nothing and syncs against what it holds.
      offline = false
      await vi.advanceTimersByTimeAsync(10 * MIN)
      await until('the second retry placed it', () => sync.result?.state === 'updated')
      expect(server.get).toHaveBeenCalledTimes(2)
      expect(readFileSync(skill, 'utf8')).toBe(manual('2.4.2'))
      sync.stop()
    })

    it("a retry's refresh joins the cache's fetch in flight: never two fetches at once", async () => {
      fakeTimers()
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2')))
      await server.cache.start()
      let offline = true
      const { fetch, calls } = address(() => '2.4.2', () => offline)
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch })
      await sync.start()

      server.state.hold = true
      const inFlight = server.cache.refresh() // the cache's own fetch, not answered yet
      expect(server.get).toHaveBeenCalledTimes(2)
      offline = false
      await vi.advanceTimersByTimeAsync(6 * MIN)
      await settle()
      expect(server.get).toHaveBeenCalledTimes(2) // joined, not a second fetch
      expect(calls).toHaveLength(1) // and it waits for that answer before it syncs
      server.release()
      await expect(inFlight).resolves.toBe(true)
      await until('the retry placed it', () => sync.result?.state === 'updated')
      expect(server.get).toHaveBeenCalledTimes(2)
      sync.stop()
    })

    it("stop() during the retry's refresh: nothing syncs after it, not even a change it brings", async () => {
      fakeTimers()
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      const server = textsServer(served('2.4.2', manual('2.4.2')))
      await server.cache.start()
      const { fetch, calls } = address(() => '2.4.3', () => true)
      const sync = new ManualSync({ texts: server.cache, targetPath: skill, fetch })
      await sync.start()

      server.state.hold = true
      server.state.manual = served('2.4.3', manual('2.4.3'))
      await vi.advanceTimersByTimeAsync(6 * MIN)
      expect(server.get).toHaveBeenCalledTimes(2) // the retry's refresh, waiting
      sync.stop()
      server.release()
      await until('the refresh answered', () => server.cache.current()?.manual.version === '2.4.3')
      await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
      await settle()
      expect(calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(sync.result).toMatchObject({ served: '2.4.2', state: 'kept' })
      expect(readFileSync(skill, 'utf8')).toBe(manual('2.4.1'))

      // And a stop with the retry still pending: the texts are not even asked.
      const other = textsServer(served('2.4.2', manual('2.4.2')))
      await other.cache.start()
      const pending = new ManualSync({ texts: other.cache, targetPath: skill, fetch })
      await pending.start()
      expect(vi.getTimerCount()).toBe(1)
      pending.stop()
      await vi.advanceTimersByTimeAsync(2 * 60 * MIN)
      expect(other.get).toHaveBeenCalledTimes(1)
    })

    it('a texts source without refresh() is synced against as before', async () => {
      fakeTimers()
      const skill = join(dir(), 'SKILL.md')
      writeFileSync(skill, manual('2.4.1'))
      let offline = true
      const { fetch, calls } = address(() => '2.4.2', () => offline)
      const sync = new ManualSync({ texts: announcing(served('2.4.2')).source, targetPath: skill, fetch })
      await sync.start()
      offline = false
      await vi.advanceTimersByTimeAsync(6 * MIN)
      await until('the retry placed it', () => sync.result?.state === 'updated')
      expect(calls).toHaveLength(2)
      sync.stop()
    })
  })
})

describe('files', () => {
  it('renameWithRetry retries a transient EPERM/EBUSY/EACCES when asked (Windows), and only then', async () => {
    let n = 0
    const flaky = async () => {
      n += 1
      if (n < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    await renameWithRetry('a', 'b', { rename: flaky, retry: true })
    expect(n).toBe(3)
    n = 0
    await expect(renameWithRetry('a', 'b', { rename: flaky, retry: false })).rejects.toThrow('busy')
    const other = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    })
    await expect(renameWithRetry('a', 'b', { rename: other, retry: true })).rejects.toThrow('nope')
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('writeAtomic refuses nothing it should not: replaces the file, leaves no temp file', async () => {
    const d = dir()
    const file = join(d, 'f.txt')
    await writeAtomic(file, 'one')
    await writeAtomic(file, 'two')
    await tick()
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(readdirSync(d)).toEqual(['f.txt'])
  })
})
