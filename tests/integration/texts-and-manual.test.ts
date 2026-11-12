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
