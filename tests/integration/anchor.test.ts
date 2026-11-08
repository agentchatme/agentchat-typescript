import { describe, expect, it } from 'vitest'
import * as anchor from '../../src/integration/anchor.js'
import { json } from './fixtures.js'

// ─── conformance/v1/anchor.cases.json ───────────────────────────────────────

interface Doc {
  markers: Record<string, string>
  rules: Record<string, string>
  render: Array<{
    name: string
    texts: { identity_line: string; identity_line_template: string }
    handle: string
    expect: string | null
    error?: boolean
  }>
  find: Array<{
    name: string
    text: string
    template: string | null
    expect: { handle: string | null; marked: boolean; legacy: boolean; body: string } | null
  }>
  replace: Array<{ name: string; text: string; block: string; expect: string }>
  remove: Array<{ name: string; text: string; expect: string }>
}

const doc = json<Doc>('anchor.cases.json')

describe('conformance — anchor.cases.json', () => {
  it('uses the markers this SDK writes', () => {
    expect(doc.markers).toEqual({
      start: anchor.START_MARKER,
      end: anchor.END_MARKER,
      handle_line: anchor.handleLine('<handle>').replace('<handle>', '<handle>'),
      legacy_start: anchor.LEGACY_START_MARKER,
      legacy_end: anchor.LEGACY_END_MARKER,
    })
    expect(Object.keys(doc.rules).sort()).toEqual(['find', 'remove', 'render', 'replace'])
  })

  describe('render', () => {
    it.each(doc.render.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      if (c.error) {
        expect(() => anchor.render(c.texts, c.handle)).toThrow()
      } else {
        expect(anchor.render(c.texts, c.handle)).toBe(c.expect)
      }
    })
  })

  describe('find', () => {
    it.each(doc.find.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const found = anchor.find(c.text, { template: c.template })
      if (c.expect === null) {
        expect(found).toBeNull()
        return
      }
      expect(found).not.toBeNull()
      const { handle, marked, legacy, body } = found!
      expect({ handle, marked, legacy, body }).toEqual(c.expect)
      expect(c.text.slice(found!.start, found!.end).trim().startsWith('<!-- agentchat')).toBe(true)
    })
  })

  describe('replace', () => {
    it.each(doc.replace.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const once = anchor.replace(c.text, c.block)
      expect(once).toBe(c.expect)
      expect(anchor.replace(once, c.block)).toBe(once) // idempotent
    })
  })

  describe('remove', () => {
    it.each(doc.remove.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      expect(anchor.remove(c.text)).toBe(c.expect)
    })
  })

  it('a rendered block is found again as itself', () => {
    const c = doc.render[0]!
    const block = anchor.render(c.texts, c.handle)
    const found = anchor.find(anchor.replace('# notes\n', block))
    expect(found).toMatchObject({ handle: 'relay-bot', marked: true, legacy: false, body: c.texts.identity_line })
  })
})
