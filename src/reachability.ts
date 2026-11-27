import type { Reachability } from './types/index.js'

/**
 * An answer's `reachability` (contract v1 §3.12), as the server sent it,
 * when it is an object; undefined when it is absent (an older server, a
 * read the server could not make) or not an object. Shared by the client's
 * sign-up results and `integration.account`.
 */
export function reachabilityOf(body: unknown): Reachability | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>).reachability
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Reachability) : undefined
}
