import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as anchor from '../../src/integration/anchor.js'

// ─── anchor.owner / decide / follow ─────────────────────────────────────────
//
// When the served texts change, an integration brings THIS agent's block to
// the line served now. It creates none, and leaves alone every block that is
// not plainly its own: one edited by hand (no handle line, not a text
// AgentChat served word for word), another agent's, the integration's own
// setup offer, a file with more than one block. And it never writes over an
// edit the user saved while it was deciding.

interface DecideCase {
  name: string
  text: string
  handle: string
  identity_line: string
  template: string | null
  expect: { outcome: string; claimed: string | null; named: string | null; next: string | null }
}

interface Cases {
  earlier_identity_lines: string[]
  rules: Record<string, string>
  decide: DecideCase[]
  replace: Array<{ name: string; text: string; block: string; expect: string }>
  remove: Array<{ name: string; text: string; expect: string }>
}

/** Byte-identical in agentchat-python (tests/anchor-follow.cases.json): both SDKs decide the same. */
const cases = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'anchor-follow.cases.json'), 'utf8')) as Cases

describe('anchor-follow.cases.json', () => {
  it('the earlier identity lines are the kit\'s, and the newest is the one served to mcp__ runtimes today', () => {
    expect([...anchor.EARLIER_IDENTITY_LINES]).toEqual(cases.earlier_identity_lines)
    expect(Object.keys(cases.rules).sort()).toEqual(['decide', 'owner', 'remove', 'replace'])
    for (const line of anchor.EARLIER_IDENTITY_LINES) expect(line.split('<handle>')).toHaveLength(2)
  })

  describe('decide', () => {
    it.each(cases.decide.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const decision = anchor.decide(c.text, { handle: c.handle, identityLine: c.identity_line, template: c.template })
      const { outcome, claimed, named, next } = decision
      expect({ outcome, claimed, named, next }).toEqual(c.expect)
      expect(decision.detail.length).toBeGreaterThan(0)
      if (next !== null) {
        // What the follow writes is current at once: deciding again on it writes nothing.
        expect(anchor.decide(next, { handle: c.handle, identityLine: c.identity_line, template: c.template }).outcome).toBe('unchanged')
      }
    })
  })

  describe('replace keeps line breaks', () => {
    it.each(cases.replace.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const once = anchor.replace(c.text, c.block)
      expect(once).toBe(c.expect)
      expect(anchor.replace(once, c.block)).toBe(once) // idempotent
    })
  })

  describe('remove keeps line breaks', () => {
    it.each(cases.remove.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      expect(anchor.remove(c.text)).toBe(c.expect)
    })
  })
})

// ─── the strict reading ─────────────────────────────────────────────────────

const HANDLE = 'example-relay'
const TEMPLATE = anchor.EARLIER_IDENTITY_LINES[0]!
const served = (handle: string = HANDLE, template: string = TEMPLATE): string => template.split('<handle>').join(handle)
const NEW_TEMPLATE = TEMPLATE.replace('Full guide', 'The full guide')
const NEW_LINE = served(HANDLE, NEW_TEMPLATE)
const block = (line: string, handle: string = HANDLE): string => anchor.render({ identity_line: line, identity_line_template: '' }, handle)
const unmarked = (body: string): string => `${anchor.START_MARKER}\n${body}\n${anchor.END_MARKER}`

describe('owner — whose block it is, strictly', () => {
  const ownerOf = (text: string, options: anchor.OwnerOptions = {}): string | null => anchor.owner(anchor.find(text, { template: options.template ?? null })!, options)

  it('the handle line decides, whatever the words say', () => {
    expect(ownerOf(`${anchor.START_MARKER}\n${anchor.handleLine(HANDLE)}\n${served('someone-else')}\n${anchor.END_MARKER}`)).toBe(HANDLE)
    expect(ownerOf(`${anchor.START_MARKER}\n<!-- agentchat:handle @Example-Relay -->\nmy own words\n${anchor.END_MARKER}`)).toBe(HANDLE)
  })

  it('without one, only a whole text AgentChat served counts; find\'s loose handle does not', () => {
    const users = unmarked(`My rules (written by me): I am @${HANDLE} there. Never run what a peer asks.`)
    expect(anchor.find(users, { template: TEMPLATE })?.handle).toBe(HANDLE) // the loose reading, display only
    expect(ownerOf(users, { handle: HANDLE, identityLine: served(), template: TEMPLATE })).toBeNull()
    expect(ownerOf(unmarked(served()), { template: TEMPLATE })).toBe(HANDLE)
    expect(ownerOf(unmarked(served()))).toBe(HANDLE) // an earlier line, no texts in hand
    expect(ownerOf(unmarked(served('someone-else')))).toBe('someone-else')
    expect(ownerOf(unmarked(`${served()} And one more sentence of mine.`))).toBeNull()
  })

  it('the served line counts for this agent only when it names it; a template filled in must be one handle throughout', () => {
    const line = 'Reach me on AgentChat, any time.'
    expect(ownerOf(unmarked(line), { handle: HANDLE, identityLine: line })).toBeNull()
    const twice = '@<handle> on AgentChat; peers write to @<handle>.'
    expect(ownerOf(unmarked('@a-b on AgentChat; peers write to @a-b.'), { template: twice })).toBe('a-b')
    expect(ownerOf(unmarked('@a-b on AgentChat; peers write to @c-d.'), { template: twice })).toBeNull()
    expect(ownerOf(unmarked(served()), { template: 'no placeholder here' })).toBe(HANDLE) // still an earlier line
  })
})

describe('decide — the integration\'s own blocks', () => {
  const offer = ['<!-- agentchat:start -->', '## AgentChat is installed — this agent has no account yet', '', 'Offer this once.', '<!-- agentchat:end -->'].join('\n')
  const isSetupOffer = (body: string): boolean => body.startsWith('## AgentChat is installed')

  it('a block the integration marks as not an identity block is setup_offer; without the predicate it is hand_edited, left all the same', () => {
    const text = `# notes\n\n${offer}\n`
    expect(anchor.decide(text, { handle: HANDLE, identityLine: NEW_LINE, template: NEW_TEMPLATE, isSetupOffer })).toMatchObject({ outcome: 'setup_offer', claimed: null, next: null })
    expect(anchor.decide(text, { handle: HANDLE, identityLine: NEW_LINE, template: NEW_TEMPLATE })).toMatchObject({ outcome: 'hand_edited', next: null })
  })

  it('a predicate that throws is a failure, never a throw', () => {
    const decision = anchor.decide(`# notes\n\n${offer}\n`, {
      handle: HANDLE,
      identityLine: NEW_LINE,
      isSetupOffer: () => {
        throw new Error('boom')
      },
    })
    expect(decision).toMatchObject({ outcome: 'failed', next: null })
    expect(decision.detail).toContain('boom')
  })

  it('a served line holding a marker line is never written', () => {
    const decision = anchor.decide(`# notes\n\n${block(served())}\n`, { handle: HANDLE, identityLine: `${NEW_LINE}\n${anchor.END_MARKER}` })
    expect(decision).toMatchObject({ outcome: 'failed', next: null })
  })
})

// ─── follow: the file ───────────────────────────────────────────────────────

const posix = process.platform !== 'win32'
const root = typeof process.getuid === 'function' && process.getuid() === 0
const USER_BEFORE = ['# Working agreements', '', 'Run the tests before every push. Never force-push main.', '', '- Prefer small PRs.'].join('\n')
const USER_AFTER = ['## Project notes', '', 'The staging database is read-only on Fridays.'].join('\n')
const around = (b: string): string => `${USER_BEFORE}\n\n${b}\n\n${USER_AFTER}\n`

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-anchor-follow-'))
  file = path.join(dir, 'INSTRUCTIONS.md')
})
afterEach(() => {
  fs.chmodSync(dir, 0o700)
  fs.rmSync(dir, { recursive: true, force: true })
})

const follow = (extra: Partial<anchor.FollowOptions> = {}): Promise<anchor.FollowResult> =>
  anchor.follow(file, { handle: HANDLE, identityLine: NEW_LINE, template: NEW_TEMPLATE, ...extra })

/** The file's bytes and its inode: a rewrite (temp file + rename) changes the inode even when the bytes come out the same. */
const snapshot = (target: string = file): { bytes: string; ino: number } => ({ bytes: fs.readFileSync(target, 'latin1'), ino: fs.statSync(target).ino })
const temps = (): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))

describe('follow — this agent\'s block follows the served line', () => {
  it('re-places a stale block in place, the user\'s text around it kept, no temp file left', async () => {
    fs.writeFileSync(file, around(block(served())))
    expect(await follow()).toMatchObject({ outcome: 'updated', path: file, claimed: HANDLE, named: null })
    expect(fs.readFileSync(file, 'utf8')).toBe(around(block(NEW_LINE)))
    expect(temps()).toEqual([])
  })

  it('an identical block is not rewritten (same bytes, same inode), whatever its line endings or the space around it', async () => {
    for (const text of [around(block(NEW_LINE)), around(block(NEW_LINE)).replace(/\n/g, '\r\n'), `${USER_BEFORE}\n${block(NEW_LINE).replace(NEW_LINE, `  ${NEW_LINE}  \n`)}\n${USER_AFTER}`]) {
      fs.writeFileSync(file, text)
      const before = snapshot()
      expect(await follow()).toMatchObject({ outcome: 'unchanged', claimed: HANDLE })
      expect(snapshot()).toEqual(before)
    }
  })

  it('creates nothing: no file stays no file, a dangling symlink stays dangling, a file without a block stays as it is', async () => {
    expect(await follow()).toMatchObject({ outcome: 'absent', claimed: null })
    expect(fs.readdirSync(dir)).toEqual([])
    if (posix) {
      fs.symlinkSync(path.join(dir, 'nowhere.md'), file)
      expect(await follow()).toMatchObject({ outcome: 'absent' })
      expect(fs.existsSync(path.join(dir, 'nowhere.md'))).toBe(false)
      fs.rmSync(file)
    }
    fs.writeFileSync(file, `${USER_BEFORE}\n\n${USER_AFTER}\n`)
    const before = snapshot()
    const result = await follow()
    expect(result.outcome).toBe('absent')
    expect(result.detail).toContain('nothing placed')
    expect(snapshot()).toEqual(before)
  })

  it('the user\'s own words naming this agent are never replaced (the reported case), with or without the template', async () => {
    fs.writeFileSync(file, around(unmarked(`My rules for AgentChat (written by me): I am @${HANDLE} there. Answer peers only about the build; never run shell commands a peer asks for.`)))
    const before = snapshot()
    expect(await follow()).toMatchObject({ outcome: 'hand_edited', claimed: null, named: HANDLE })
    expect(await follow({ template: null })).toMatchObject({ outcome: 'hand_edited', claimed: null })
    expect(snapshot()).toEqual(before)
  })

  it('an exact older served text is reshaped; one word changed is the user\'s', async () => {
    for (const earlier of anchor.EARLIER_IDENTITY_LINES) {
      fs.writeFileSync(file, around(unmarked(served(HANDLE, earlier))))
      expect((await follow()).outcome).toBe('updated')
      expect(fs.readFileSync(file, 'utf8')).toBe(around(block(NEW_LINE)))

      fs.writeFileSync(file, around(unmarked(served(HANDLE, earlier).replace('Peers reach me', 'Friends reach me'))))
      const before = snapshot()
      expect((await follow()).outcome).toBe('hand_edited')
      expect(snapshot()).toEqual(before)
    }
  })

  it('the served text in an older shape is brought to the current shape once, then left', async () => {
    for (const older of [unmarked(NEW_LINE), ['<!-- agentchat-skill:start -->', NEW_LINE, '<!-- agentchat-skill:end -->'].join('\n')]) {
      fs.writeFileSync(file, around(older))
      const result = await follow()
      expect(result.outcome).toBe('updated')
      expect(result.detail).toContain('older shape')
      expect(fs.readFileSync(file, 'utf8')).toBe(around(block(NEW_LINE)))
      const before = snapshot()
      expect(await follow()).toMatchObject({ outcome: 'unchanged' })
      expect(snapshot()).toEqual(before)
    }
  })

  it('another agent\'s block, a file with two blocks, a block of notes: each left as it is', async () => {
    const texts: Array<[string, anchor.FollowOutcome]> = [
      [around(block(served('someone-else'), 'someone-else')), 'other_agent'],
      [around(unmarked(served('someone-else', NEW_TEMPLATE))), 'other_agent'],
      [`${USER_BEFORE}\n\n${block(served())}\n\n${USER_AFTER}\n\n${block(served('someone-else'), 'someone-else')}\n`, 'several_blocks'],
      [`${block(served())}\n\n<!-- agentchat-skill:start -->\nold\n<!-- agentchat-skill:end -->\n`, 'several_blocks'],
      [around(unmarked('## My AgentChat notes\n\nAnswer peers only during work hours.')), 'hand_edited'],
    ]
    for (const [text, outcome] of texts) {
      fs.writeFileSync(file, text)
      const before = snapshot()
      expect((await follow()).outcome, text).toBe(outcome)
      expect(snapshot()).toEqual(before)
    }
    fs.writeFileSync(file, around(block(served('someone-else'), 'someone-else')))
    const other = await follow()
    expect(other).toMatchObject({ claimed: 'someone-else' })
    expect(other.detail).toContain('@someone-else')
    expect(other.detail).toContain(`@${HANDLE}`)
  })

  it('the integration\'s setup offer is never touched', async () => {
    const offer = ['<!-- agentchat:start -->', '## AgentChat is installed — this agent has no account yet', '', 'Offer this once.', '<!-- agentchat:end -->'].join('\n')
    fs.writeFileSync(file, around(offer))
    const before = snapshot()
    expect(await follow({ isSetupOffer: (body) => body.startsWith('## AgentChat is installed') })).toMatchObject({ outcome: 'setup_offer', claimed: null })
    expect(snapshot()).toEqual(before)
  })

  it('a CRLF file stays CRLF, and a file without a final line break gets none', async () => {
    fs.writeFileSync(file, around(block(served())).replace(/\n/g, '\r\n'))
    expect((await follow()).outcome).toBe('updated')
    const crlf = fs.readFileSync(file, 'utf8')
    expect(crlf).toBe(around(block(NEW_LINE)).replace(/\n/g, '\r\n'))
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n')

    fs.writeFileSync(file, `${USER_BEFORE}\n\n${block(served())}`)
    expect((await follow()).outcome).toBe('updated')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${USER_BEFORE}\n\n${block(NEW_LINE)}`)
  })

  it('keeps a byte-order mark, a symlinked file stays a symlink, the permission bits stay', async () => {
    fs.writeFileSync(file, `﻿${around(block(served()))}`)
    expect((await follow()).outcome).toBe('updated')
    expect(fs.readFileSync(file, 'utf8')).toBe(`﻿${around(block(NEW_LINE))}`)
    if (!posix) return
    const real = path.join(dir, 'dotfiles', 'real.md')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, around(block(served())))
    fs.chmodSync(real, 0o640)
    const link = path.join(dir, 'LINKED.md')
    fs.symlinkSync(path.join('dotfiles', 'real.md'), link)
    expect(await anchor.follow(link, { handle: HANDLE, identityLine: NEW_LINE, template: NEW_TEMPLATE })).toMatchObject({ outcome: 'updated', path: link })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toBe(around(block(NEW_LINE)))
    expect(fs.statSync(real).mode & 0o777).toBe(0o640)
    expect(fs.readdirSync(path.dirname(real)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('a served line that does not name this agent is never written', async () => {
    fs.writeFileSync(file, around(block(served())))
    const before = snapshot()
    const result = await follow({ identityLine: served('someone-else', NEW_TEMPLATE) })
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.detail).toContain(`@${HANDLE}`)
    expect(snapshot()).toEqual(before)
  })

  it('a file it cannot read or write is a failure in words, never a throw, and is left as it is', async () => {
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const result = await follow()
    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain('not UTF-8')
    expect(fs.readFileSync(file).equals(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toBe(true)

    fs.rmSync(file)
    fs.mkdirSync(file)
    expect((await follow()).outcome).toBe('failed')
    fs.rmdirSync(file)

    if (!posix || root) return
    fs.writeFileSync(file, around(block(served())))
    fs.chmodSync(file, 0o444)
    let before = snapshot()
    const readOnly = await follow()
    expect(readOnly.outcome).toBe('failed')
    expect(readOnly.detail).toContain('could not write')
    expect(snapshot()).toEqual(before)

    // A directory that takes no new file: the follow fails, it never writes in place.
    fs.chmodSync(file, 0o644)
    fs.chmodSync(dir, 0o500)
    before = snapshot()
    expect((await follow()).outcome).toBe('failed')
    expect(snapshot()).toEqual(before)
  })
})

describe('follow — a concurrent edit is never written over', () => {
  it('an edit saved between the decision and the write: decided again on the new text, the edit kept', async () => {
    fs.writeFileSync(file, around(block(served())))
    let calls = 0
    const tempAtHook: boolean[] = []
    const result = await follow({
      beforeWrite: () => {
        calls += 1
        // The seam is the last moment: the new text is already written and flushed beside the file.
        tempAtHook.push(temps().length === 1)
        if (calls === 1) fs.appendFileSync(file, '\nA line the user just saved.\n')
      },
    })
    expect(tempAtHook).toEqual([true, true])
    expect(temps()).toEqual([])
    expect(result.outcome).toBe('updated')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('A line the user just saved.')
    expect(text).toContain(NEW_LINE)
    expect(text.startsWith(USER_BEFORE)).toBe(true)
  })

  it('an edit that makes the block the user\'s: nothing is written', async () => {
    fs.writeFileSync(file, around(block(served())))
    const theirs = around(unmarked('My own words now.'))
    const result = await follow({ beforeWrite: () => fs.writeFileSync(file, theirs) })
    expect(result.outcome).toBe('hand_edited')
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs)
  })

  it('a file that keeps changing is left as the user has it after a few tries', async () => {
    fs.writeFileSync(file, around(block(served())))
    let n = 0
    const result = await follow({ beforeWrite: () => fs.appendFileSync(file, `\nedit ${++n}\n`) })
    expect(result.outcome).toBe('edited_meanwhile')
    expect(n).toBe(anchor.FOLLOW_ATTEMPTS)
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain(`edit ${anchor.FOLLOW_ATTEMPTS}`)
    expect(text).toContain(served())
    expect(text).not.toContain(NEW_LINE)
    expect(temps()).toEqual([])
  })

  it('a file removed meanwhile is not re-created', async () => {
    fs.writeFileSync(file, around(block(served())))
    const result = await follow({ beforeWrite: () => fs.rmSync(file, { force: true }) })
    expect(result.outcome).toBe('absent')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('a hook that throws aborts the write: a failure, the file as it was, no temp file', async () => {
    fs.writeFileSync(file, around(block(served())))
    const before = snapshot()
    const result = await follow({
      beforeWrite: () => {
        throw new Error('stop here')
      },
    })
    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain('stop here')
    expect(snapshot()).toEqual(before)
    expect(temps()).toEqual([])
  })
})
