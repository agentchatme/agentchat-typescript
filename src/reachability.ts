import type { Reachability } from './types/index.js'

/**
 * An answer's `reachability` (contract v1 §3.12), as the server sent it,
 * when it is an object with a string `state` and a string `text` (the two
 * fields every reader needs); undefined otherwise: absent (an older server,
 * a read the server could not make) or not one. Fields and values it does
 * not know are kept. The Python SDK's `reachability_of` keeps the same
 * answers. Shared by the client's sign-up results and `integration.account`.
 */
export function reachabilityOf(body: unknown): Reachability | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>).reachability
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return typeof record.state === 'string' && typeof record.text === 'string' ? (value as Reachability) : undefined
}
