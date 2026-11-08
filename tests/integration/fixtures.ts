import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** `conformance/v1/`: the cases every AgentChat SDK must pass, byte-identical across the SDK repos. */
export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../conformance/v1')

export function raw(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8')
}

export function json<T>(name: string): T {
  return JSON.parse(raw(name)) as T
}
