/**
 * Runtime-dependent WebSocket resolution.
 *
 * - On Node, the `ws` package (an optional peer dependency) is preferred
 *   whenever it is installed: it exposes the server's ping frames
 *   (`on('ping')`) and `terminate()`, which the realtime client's liveness
 *   watchdog needs to tell a quiet-but-healthy socket from a dead pipe.
 *   Node's native `WebSocket` (22+) shows neither, so a long-lived
 *   integration on it would get no idle watchdog at all. Without `ws`, the
 *   native socket is used. Node 20 has no native socket: `ws` is required.
 * - Browsers, Deno, Bun and edge runtimes ship a native `WebSocket` on
 *   `globalThis`; it is used directly, with `ws` only as a last resort.
 * - No implementation anywhere is a configuration error: the caller's
 *   `connect()` rejects and nothing retries it.
 *
 * Deliberately stateless: the module system already caches the dynamic
 * import, and a module-level memo would be the one piece of process-wide
 * state in an SDK that is meant to run as a guest inside a host process.
 */

type WebSocketCtor = typeof globalThis.WebSocket

function isNode(): boolean {
  const versions = (globalThis as { process?: { versions?: { node?: unknown } } }).process
    ?.versions
  return typeof versions?.node === 'string'
}

async function importWs(): Promise<WebSocketCtor> {
  // Built as an ESM dynamic import. tsup preserves the expression so
  // bundlers / runtimes that can't resolve `ws` simply reject here and the
  // caller falls through to the native socket.
  const mod = (await import('ws')) as unknown as {
    default?: WebSocketCtor
    WebSocket?: WebSocketCtor
  }
  const ctor = mod.default ?? mod.WebSocket
  if (!ctor) {
    throw new Error('The `ws` package loaded but did not export a WebSocket constructor.')
  }
  return ctor
}

export async function resolveWebSocket(): Promise<WebSocketCtor> {
  const native = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  // Order: on Node `ws`, then native; everywhere else native, then `ws`.
  if (!isNode() && native) return native

  let wsFailure: unknown
  try {
    return await importWs()
  } catch (err) {
    wsFailure = err
  }
  if (native) return native

  const reason = wsFailure instanceof Error ? wsFailure.message : String(wsFailure)
  throw new Error(
    `AgentChat SDK: no WebSocket implementation available. ${reason}\n` +
      'Install the `ws` package: Node 20 has no native WebSocket, and on Node 22+ `ws` ' +
      'also gives the realtime client ping-frame liveness.',
  )
}
