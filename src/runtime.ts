import { VERSION } from './version.js'

interface RuntimeGlobals {
  process?: {
    versions?: Record<string, string | undefined>
    version?: string
    platform?: unknown
    arch?: unknown
    getBuiltinModule?: (id: string) => unknown
  }
  Deno?: { version?: { deno?: string } }
  Bun?: { version?: string }
  navigator?: { userAgent?: string }
  EdgeRuntime?: string
}

/**
 * Returns a short "<runtime>/<version>" token (e.g. `node/20.12.1`,
 * `bun/1.1.0`, `deno/1.42.0`). Falls back to `'unknown'` when nothing
 * identifiable is in scope. Used to build the default `User-Agent`
 * header — the server uses it to attribute traffic to specific SDK +
 * runtime combinations and correlate bug reports.
 */
export function detectRuntime(g: RuntimeGlobals = globalThis as RuntimeGlobals): string {
  // Order matters: Bun and Deno both shim `process`, so check them first.
  if (typeof g.Bun?.version === 'string') return `bun/${g.Bun.version}`
  if (typeof g.Deno?.version?.deno === 'string') return `deno/${g.Deno.version.deno}`
  if (typeof g.EdgeRuntime === 'string') return `edge/${g.EdgeRuntime}`
  if (typeof g.process?.versions?.node === 'string') return `node/${g.process.versions.node}`

  const ua = g.navigator?.userAgent
  if (typeof ua === 'string' && ua.length > 0) {
    // Browser UA strings are already rich — short-circuit with a marker so
    // the server knows the SDK is running in a browser context without us
    // re-emitting the entire UA twice.
    return 'browser'
  }

  return 'unknown'
}

/**
 * Default `User-Agent` string emitted on every request. Format is
 * deliberately close to Stripe's / Twilio's / OpenAI's convention so
 * log analyzers that already parse those will pick it up without fuss.
 */
export function defaultUserAgent(): string {
  return `agentchat-ts/${VERSION} ${detectRuntime()}`
}

/** What the SDK knows about the process it runs in (the `X-AgentChat-Platform` members it computes itself). */
export interface PlatformFacts {
  /** `<platform>/<release>` (`darwin/25.6.0`), or the platform alone when the release is not known. */
  readonly os?: string
  /** `process.arch` (`arm64`, `x64`, …). */
  readonly arch?: string
  /** `detectRuntime()`'s token (`node/22.11.0`, `bun/1.1.0`, `deno/2.0.0`). */
  readonly runtime?: string
}

/**
 * The platform facts of a runtime, read from its globals. Nothing that names
 * a machine or a person: the OS name and kernel release, the CPU architecture
 * and the JavaScript runtime.
 *
 * - os and arch only where `process.versions.node` is set (Node, Bun, Deno 2).
 *   A browser, or a bundler's `process` polyfill, gives neither.
 * - The OS release comes from `process.getBuiltinModule('node:os')` (Node
 *   20.16+ / 22.3+, Bun): synchronous, and invisible to bundlers. Without it
 *   the os is the platform alone. Deno is never asked: its `os.release()`
 *   needs `--allow-sys` and would put a permission prompt in front of the
 *   person.
 * - runtime is `detectRuntime()`'s token for Node, Bun and Deno; nothing elsewhere
 *   (a browser, an edge runtime).
 */
export function platformFactsOf(g: RuntimeGlobals): PlatformFacts {
  const facts: { os?: string; arch?: string; runtime?: string } = {}
  const runtime = detectRuntime(g)
  if (/^(?:node|bun|deno)\//.test(runtime)) facts.runtime = runtime
  const proc = g.process
  if (typeof proc?.versions?.node !== 'string') return facts
  if (typeof proc.arch === 'string') facts.arch = proc.arch
  if (typeof proc.platform === 'string') {
    const release = typeof g.Deno === 'object' && g.Deno !== null ? undefined : osRelease(proc)
    const withRelease = release === undefined ? undefined : `${proc.platform}/${release}`
    facts.os = isPlatformValue(withRelease) ? withRelease : proc.platform
  }
  return facts
}

function osRelease(proc: NonNullable<RuntimeGlobals['process']>): string | undefined {
  try {
    const os = proc.getBuiltinModule?.('node:os') as { release?: () => unknown } | undefined
    const release = os?.release?.()
    return typeof release === 'string' && release.length > 0 ? release : undefined
  } catch {
    return undefined
  }
}

/** The shape every `X-AgentChat-Platform` value but `install` must have. */
export const PLATFORM_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$/

export function isPlatformValue(value: unknown): value is string {
  return typeof value === 'string' && PLATFORM_VALUE.test(value)
}

let cachedFacts: PlatformFacts | null = null

/** This process's platform facts: read once, then kept (they cannot change while it runs). */
export function platformFacts(): PlatformFacts {
  cachedFacts ??= Object.freeze(platformFactsOf(globalThis as RuntimeGlobals))
  return cachedFacts
}
