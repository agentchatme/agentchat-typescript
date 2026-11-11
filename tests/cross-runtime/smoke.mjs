// Cross-runtime smoke test: the BUILT package (dist/, what npm ships, loaded
// by its own name through package.json "exports") on Bun and Deno. The
// vitest suite covers Node against the sources; this covers the runtimes the
// README promises, through their own fetch, WebSocket, WebCrypto, timers and
// node:fs, against a fake server on 127.0.0.1.
//
//   pnpm install && pnpm run build
//   bun tests/cross-runtime/smoke.mjs <work dir>
//   deno run --allow-read --allow-net=127.0.0.1 --allow-write=<work dir> \
//     --allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE tests/cross-runtime/smoke.mjs <work dir>
//
// Deno's permissions double as the network guard: nothing but loopback. The
// two env names are the ones the `ws` package reads at import; without them
// `import('ws')` fails on Deno. The work dir is where the atomic-write check
// writes (it must exist). Run weekly and on demand by .github/workflows/weekly.yml.

import { readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as sdk from 'agentchatme'

const RUNTIME = typeof globalThis.Bun !== 'undefined' ? 'bun' : typeof globalThis.Deno !== 'undefined' ? 'deno' : null
const exit = (code) => (globalThis.Deno ? globalThis.Deno.exit(code) : globalThis.process.exit(code))
const args = globalThis.Deno ? globalThis.Deno.args : globalThis.process.argv.slice(2)

if (RUNTIME === null) {
  console.error('Run this under Bun or Deno. Node is covered by the vitest suite (pnpm run test).')
  exit(2)
}
const WORK_DIR = args[0]
if (!WORK_DIR) {
  console.error('usage: smoke.mjs <work dir>')
  exit(2)
}

const API_KEY = 'smoke-test-key'
const FIXTURES = new URL('../../conformance/v1/', import.meta.url)
const fixture = async (name) => readFile(new URL(name, FIXTURES), 'utf8')
const fixtureJson = async (name) => JSON.parse(await fixture(name))

// ─── tiny harness ───────────────────────────────────────────────────────────

function check(cond, what) {
  if (!cond) throw new Error(what)
}

// Key order does not matter, as with vitest's toEqual; undefined fields drop out.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    )
  }
  return value
}
function checkEqual(actual, expected, what) {
  const a = JSON.stringify(canonical(actual))
  const e = JSON.stringify(canonical(expected))
  if (a !== e) throw new Error(`${what}\n    expected: ${e}\n    actual:   ${a}`)
}

function within(ms, promise, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const results = []
async function step(name, fn) {
  try {
    await within(15_000, Promise.resolve().then(fn), name)
    results.push({ name, ok: true })
    console.log(`ok - ${name}`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`not ok - ${name}\n    ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  }
}

// ─── a fake AgentChat on 127.0.0.1, in the runtime's own server API ─────────

// handlers: { http(req) -> Response, socketOpen(peer), socketMessage(peer, text) }
// peer: { send(text), close() }
async function serve(handlers) {
  if (RUNTIME === 'bun') {
    const server = globalThis.Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/v1/ws') {
          return srv.upgrade(req) ? undefined : new Response('upgrade refused', { status: 400 })
        }
        return handlers.http(req)
      },
      websocket: {
        open(ws) {
          handlers.socketOpen({ send: (t) => ws.send(t), close: () => ws.close() })
        },
        message(ws, data) {
          handlers.socketMessage({ send: (t) => ws.send(t), close: () => ws.close() }, String(data))
        },
      },
    })
    return { port: server.port, close: async () => server.stop(true) }
  }
  const abort = new AbortController()
  let listening
  const ready = new Promise((resolve) => (listening = resolve))
  const server = globalThis.Deno.serve(
    { hostname: '127.0.0.1', port: 0, signal: abort.signal, onListen: ({ port }) => listening(port) },
    (req) => {
      if (new URL(req.url).pathname === '/v1/ws') {
        const { socket, response } = globalThis.Deno.upgradeWebSocket(req)
        const peer = { send: (t) => socket.send(t), close: () => socket.close() }
        socket.onopen = () => handlers.socketOpen(peer)
        socket.onmessage = (event) => handlers.socketMessage(peer, String(event.data))
        return response
      }
      return handlers.http(req)
    },
  )
  const port = await ready
  return {
    port,
    close: async () => {
      abort.abort()
      await server.finished
    },
  }
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const AGENT = {
  id: 'agt_smoke0000000001',
  handle: 'smoke-relay',
  email: 'smoke@example.com',
  display_name: 'Smoke relay',
  description: null,
  avatar_url: null,
  status: 'active',
  paused_by_owner: 'none',
  settings: { inbox_mode: 'open', group_invite_policy: 'open' },
  is_system: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function messageRow(id, body) {
  return {
    id,
    conversation_id: 'conv_smoke000000001',
    sender: '@smoke-peer',
    client_msg_id: body?.client_msg_id ?? 'c_smoke',
    seq: 1,
    type: 'text',
    content: { text: 'hello from the fake server' },
    metadata: {},
    status: 'stored',
    created_at: '2026-01-01T00:00:00.000Z',
    delivered_at: null,
    read_at: null,
  }
}

const seen = { userAgents: [], sends: [], sendTimes: [], hellos: [], acks: [] }
let ackWaiter = null

const server = await serve({
  async http(req) {
    const url = new URL(req.url)
    seen.userAgents.push(req.headers.get('user-agent') ?? '')
    if (req.headers.get('authorization') !== `Bearer ${API_KEY}`) {
      return json(401, { code: 'UNAUTHORIZED', message: 'bad key' })
    }
    if (req.method === 'GET' && url.pathname === '/v1/agents/me') return json(200, AGENT)
    if (req.method === 'GET' && url.pathname === '/v1/agents/nobody-here') {
      return json(404, { code: 'AGENT_NOT_FOUND', message: 'No agent has the handle @nobody-here.' })
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const body = await req.json()
      seen.sends.push(body)
      seen.sendTimes.push(performance.now())
      // The first attempt fails retryably: the SDK waits the Retry-After
      // (1 s, far above its own 250 ms backoff) and replays with the same
      // client_msg_id.
      if (seen.sends.length === 1) return json(503, { code: 'INTERNAL_ERROR', message: 'try again' }, { 'retry-after': '1' })
      return json(201, messageRow('msg_smoke_sent00001', body))
    }
    return json(404, { code: 'NOT_FOUND', message: `no route ${req.method} ${url.pathname}` })
  },
  socketOpen() {},
  socketMessage(peer, text) {
    const frame = JSON.parse(text)
    if (frame.type === 'hello') {
      seen.hellos.push(frame)
      peer.send(JSON.stringify({ type: 'hello.ok', capabilities: ['ack'] }))
      peer.send(JSON.stringify({ type: 'message.new', payload: messageRow(`msg_smoke_live0000${seen.hellos.length}`) }))
    } else if (frame.type === 'ack') {
      seen.acks.push(frame.message_id)
      ackWaiter?.(frame.message_id)
    }
  },
})
const HTTP_BASE = `http://127.0.0.1:${server.port}`
const WS_BASE = `ws://127.0.0.1:${server.port}`

// ─── the checks ─────────────────────────────────────────────────────────────

await step('the ESM and CommonJS builds load and export the same names', async () => {
  const cjs = createRequire(import.meta.url)('agentchatme')
  checkEqual(Object.keys(cjs).sort(), Object.keys(sdk).sort(), 'ESM and CJS export lists differ')
  for (const name of ['AgentChatClient', 'RealtimeClient', 'verifyWakeWebhook', 'gate', 'integration', 'VERSION']) {
    check(name in sdk, `missing export ${name}`)
  }
  check(typeof sdk.VERSION === 'string' && sdk.VERSION !== '0.0.0-dev', `VERSION was not injected at build: ${sdk.VERSION}`)
})

const client = new sdk.AgentChatClient({ apiKey: API_KEY, baseUrl: HTTP_BASE })

await step('REST: a request over the runtime fetch, with the runtime in the User-Agent', async () => {
  const me = await client.getMe()
  check(me.handle === AGENT.handle, `getMe returned ${JSON.stringify(me)}`)
  const ua = seen.userAgents.at(-1)
  check(ua.startsWith(`agentchat-ts/${sdk.VERSION} ${RUNTIME}/`), `User-Agent was "${ua}"`)
})

await step('REST: an error answer becomes its typed error class', async () => {
  const err = await client.getAgent('nobody-here').then(
    () => null,
    (e) => e,
  )
  check(err instanceof sdk.NotFoundError, `expected NotFoundError, got ${err?.constructor?.name}: ${err}`)
  check(err instanceof sdk.AgentChatError, 'NotFoundError is not an AgentChatError')
  check(err.name === 'NotFoundError' && err.code === 'AGENT_NOT_FOUND' && err.status === 404, `got ${err.name} ${err.code} ${err.status}`)
})

await step('REST: a 503 is retried after Retry-After with the same client_msg_id', async () => {
  const { message } = await client.sendMessage({ to: '@smoke-peer', content: { text: 'hi' } })
  check(message.id === 'msg_smoke_sent00001', `send returned ${JSON.stringify(message)}`)
  check(seen.sends.length === 2, `expected 2 attempts, the server saw ${seen.sends.length}`)
  check(seen.sends[0].client_msg_id === seen.sends[1].client_msg_id, 'the replay changed client_msg_id')
  const waited = seen.sendTimes[1] - seen.sendTimes[0]
  check(waited >= 900, `the replay came ${Math.round(waited)} ms after the 503, not after its Retry-After (1 s)`)
  check(/^[0-9a-f-]{36}$/i.test(seen.sends[0].client_msg_id), `client_msg_id is not a UUID: ${seen.sends[0].client_msg_id}`)
})

async function socketRoundTrip(options) {
  const rt = new sdk.RealtimeClient({ apiKey: API_KEY, baseUrl: WS_BASE, reconnect: false, ...options })
  const errors = []
  rt.onError((e) => errors.push(e))
  const received = new Promise((resolve) => rt.on('message.new', (frame) => resolve(frame.payload)))
  const acked = new Promise((resolve) => (ackWaiter = resolve))
  try {
    await rt.connect()
    const message = await within(5_000, received, 'message.new')
    const ackedId = await within(5_000, acked, 'the ack frame')
    check(ackedId === message.id, `acked ${ackedId}, received ${message.id}`)
    const hello = seen.hellos.at(-1)
    check(hello.api_key === API_KEY, 'HELLO carried another key')
    check(hello.capabilities.includes('ack'), `HELLO offered ${JSON.stringify(hello.capabilities)}`)
    check(errors.length === 0, `errors: ${errors.map(String).join('; ')}`)
  } finally {
    rt.disconnect()
    ackWaiter = null
  }
}

// Both sockets the SDK can pick on these runtimes, each named explicitly
// (which one it picks by default depends on whether `ws` resolves).
await step('socket: HELLO, hello.ok, a live message, its ack, over the `ws` package', async () => {
  const { default: WebSocketFromWs } = await import('ws')
  check(typeof WebSocketFromWs === 'function', 'the ws package exported no WebSocket')
  await socketRoundTrip({ webSocket: WebSocketFromWs })
})

await step("socket: the same round trip over the runtime's native WebSocket", async () => {
  check(typeof globalThis.WebSocket === 'function', 'no native WebSocket')
  await socketRoundTrip({ webSocket: globalThis.WebSocket })
})

await step('wake webhook: every wake-webhook.cases.json case verifies on WebCrypto', async () => {
  const doc = await fixtureJson('wake-webhook.cases.json')
  // Built at run time: no secret-shaped literal is committed.
  const standardSecret = ['whsec', doc.standard_webhooks_secret_base64].join('_')
  for (const c of doc.cases) {
    const body = c.body ?? doc.body
    const run = sdk.verifyWakeWebhook({
      dialect: c.dialect,
      body,
      headers: c.headers,
      secret: c.secret ?? (c.dialect === 'standard-webhooks' ? standardSecret : doc.secret),
      toleranceSeconds: doc.tolerance_s,
      now: () => doc.now * 1000,
    })
    if (c.expect.ok) {
      checkEqual(await run, JSON.parse(body), `${c.name}: payload`)
    } else {
      const err = await run.then(
        () => null,
        (e) => e,
      )
      check(err instanceof sdk.WakeWebhookVerificationError, `${c.name}: expected a verification error, got ${err}`)
      check(err.reason === c.expect.reason, `${c.name}: reason ${err.reason}, expected ${c.expect.reason}`)
    }
  }
})

await step('gate: the prompt renders byte for byte (gate-prompt.expected.txt)', async () => {
  const tray = await fixtureJson('tray.sample.json')
  const texts = await fixtureJson('texts.sample.json')
  const expected = await fixture('gate-prompt.expected.txt')
  check(sdk.gate.buildPrompt(tray, { texts }) + '\n' === expected, 'the rendered prompt differs from gate-prompt.expected.txt')
})

await step('gate: every verdict-parse.cases.json case parses as expected', async () => {
  const tray = await fixtureJson('tray.sample.json')
  for (const c of await fixtureJson('verdict-parse.cases.json')) {
    checkEqual(sdk.gate.parseVerdicts(c.text, tray), c.expected, c.name)
  }
})

await step('socket: every connect-budget.cases.json delay', async () => {
  const doc = await fixtureJson('connect-budget.cases.json')
  for (const c of doc.cases) {
    const delay = sdk.connectBudgetDelayMs({ code: c.event.code, reason: c.event.reason })
    check(delay === c.expect.delay_ms, `${c.name}: ${delay}, expected ${c.expect.delay_ms}`)
  }
})

await step('kit: writeAtomic writes through node:fs and leaves no temp file', async () => {
  const dir = new URL(`smoke-${Date.now()}/`, pathToFileURL(WORK_DIR.endsWith('/') ? WORK_DIR : `${WORK_DIR}/`))
  const file = new URL('texts.json', dir)
  try {
    await sdk.integration.writeAtomic(fileURLToPath(file), '{"version":"1"}\n')
    await sdk.integration.writeAtomic(fileURLToPath(file), '{"version":"2"}\n')
    check((await readFile(file, 'utf8')) === '{"version":"2"}\n', 'the second write did not replace the first')
    checkEqual(await readdir(dir), ['texts.json'], 'files left in the directory')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A check that timed out may still hold a socket open: never wait long for the server.
await within(5_000, server.close(), 'the fake server to close').catch((err) => console.log(`# ${err.message}`))

const failed = results.filter((r) => !r.ok)
console.log(`\n${RUNTIME}: ${results.length - failed.length} of ${results.length} checks passed`)
exit(failed.length === 0 ? 0 : 1)
