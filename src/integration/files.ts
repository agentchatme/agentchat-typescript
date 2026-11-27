/**
 * The few file operations the kit needs (the texts cache, the manual, the
 * identity block's follow), for Node, Bun and Deno. `node:` modules are imported lazily, on first use, so
 * the SDK still loads in a browser or an edge runtime that never asks for a
 * file.
 *
 * `writeAtomic` is "never worse than before": a temp file beside the target
 * with an unguessable name, created exclusively (`wx`: a planted name or
 * symlink is refused, never followed), its mode set on the open descriptor,
 * flushed (fsync) and renamed over the target. A failed write removes its
 * temp file and leaves the old file exactly as it was. On Windows a rename
 * onto a file another process holds open fails transiently (EPERM / EBUSY /
 * EACCES while a scanner or an editor has it), so the rename is retried for
 * about 100 ms. Ported from agent-core `util/fsutil.ts`.
 */

type FsPromises = typeof import('node:fs/promises')
type PathModule = typeof import('node:path')

interface NodeModules {
  fs: FsPromises
  path: PathModule
}

let modules: Promise<NodeModules> | null = null

// The specifiers are not literals on purpose, and the imports carry the
// bundlers' ignore comments: a browser or edge bundle of this SDK must never
// try to resolve (or fail on) Node's built-ins it never calls.
const FS_MODULE = 'node:fs/promises'
const PATH_MODULE = 'node:path'

function nodeModules(): Promise<NodeModules> {
  modules ??= Promise.all([
    import(/* webpackIgnore: true */ /* @vite-ignore */ FS_MODULE) as Promise<FsPromises>,
    import(/* webpackIgnore: true */ /* @vite-ignore */ PATH_MODULE) as Promise<PathModule>,
  ]).then(([fs, path]) => ({
    fs: (fs as { default?: FsPromises }).default ?? fs,
    path: (path as { default?: PathModule }).default ?? path,
  }))
  return modules
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 6
const RENAME_DELAY_MS = 20

function isWindows(): boolean {
  return (globalThis as { process?: { platform?: string } }).process?.platform === 'win32'
}

function randomSuffix(): string {
  const bytes = new Uint8Array(6)
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface RenameOptions {
  /** Defaults to `fs.rename`; injectable for tests. */
  readonly rename?: (from: string, to: string) => Promise<void>
  /** Defaults to Windows only, where the transient sharing errors happen. */
  readonly retry?: boolean
}

/** `rename`, retried a few times over ~100 ms on a transient EPERM / EBUSY / EACCES. */
export async function renameWithRetry(from: string, to: string, options: RenameOptions = {}): Promise<void> {
  const { fs } = await nodeModules()
  const rename = options.rename ?? ((a: string, b: string) => fs.rename(a, b))
  const attempts = (options.retry ?? isWindows()) ? RENAME_ATTEMPTS : 1
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (attempt >= attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, RENAME_DELAY_MS))
    }
  }
}

export interface WriteAtomicOptions extends RenameOptions {
  /** Exact file mode, whatever the umask. Default: the umask's (as a plain write). */
  readonly mode?: number
}

/** Replace `file` with `data` atomically. Creates the directory (0700) when missing. Throws on failure; the old file is untouched then. */
export async function writeAtomic(file: string, data: string | Uint8Array, options: WriteAtomicOptions = {}): Promise<void> {
  const { fs, path } = await nodeModules()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomSuffix()}.tmp`)
  try {
    const handle = await fs.open(tmp, 'wx', options.mode ?? 0o666)
    try {
      if (options.mode !== undefined) await handle.chmod(options.mode)
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, file, options)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Create `file` with `data` unless it exists: true when this call created
 * it, false when a file was already there (it is left untouched). The data
 * is written and flushed to a temp file beside it first and then linked into
 * place, so a reader never sees a part of it, and of two processes racing
 * to create the same file exactly one wins. Where a hard link cannot be
 * made (a file system without them) it is renamed into place instead, where
 * such a race ends with the last writer's file. Creates the directory
 * (0700) when missing. Throws on failure.
 */
export async function createOnce(file: string, data: string | Uint8Array, options: WriteAtomicOptions = {}): Promise<boolean> {
  const { fs, path } = await nodeModules()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomSuffix()}.tmp`)
  let created = false
  try {
    const handle = await fs.open(tmp, 'wx', options.mode ?? 0o666)
    created = true
    try {
      if (options.mode !== undefined) await handle.chmod(options.mode)
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.link(tmp, file)
      return true
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') return false
    }
    // No hard link here: an existing file still wins, else the rename (which
    // throws the real error, if there is one).
    if (await exists(file)) return false
    await renameWithRetry(tmp, file, options)
    created = false
    return true
  } finally {
    if (created) await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** The file's bytes, or null when it does not exist or cannot be read. */
export async function readBytes(file: string): Promise<Uint8Array | null> {
  const { fs } = await nodeModules()
  try {
    return new Uint8Array(await fs.readFile(file))
  } catch {
    return null
  }
}

/** Whether a file exists at `file`. */
export async function exists(file: string): Promise<boolean> {
  const { fs } = await nodeModules()
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

// ─── Replacing a file someone else owns ─────────────────────────────────────
//
// For a file the kit did not create and must not damage: the user's
// instruction file (`anchor.follow`). Never creates one, keeps what an
// in-place write would have kept, and replaces it only if it still holds the
// bytes the caller decided on, looked at again at the last moment.

/** A file as it was read for a replacement: where it really is, its bytes, and what a replacement keeps. */
export interface ReadForReplace {
  /** The file at the end of any symlinks: the one replaced (a symlink stays a symlink). */
  readonly target: string
  readonly bytes: Uint8Array
  /** Permission bits (`mode & 0o7777`). */
  readonly mode: number
  readonly uid: number
  readonly gid: number
}

/**
 * The file at `file` (through any symlinks), or null when there is none (a
 * dangling symlink included). Throws when it is not a regular file or cannot
 * be read.
 */
export async function readForReplace(file: string): Promise<ReadForReplace | null> {
  const { fs } = await nodeModules()
  let target: string
  try {
    target = await fs.realpath(file)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
  let stat: Awaited<ReturnType<FsPromises['stat']>>
  try {
    stat = await fs.stat(target)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await fs.readFile(target))
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
  return { target, bytes, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isRoot(): boolean {
  const getuid = (globalThis as { process?: { getuid?: () => number } }).process?.getuid
  return typeof getuid === 'function' && getuid() === 0
}

export interface ReplaceIfUnchangedOptions extends RenameOptions {
  /** Called once the new text is written and flushed beside the file, right before it is read again for the rename. */
  readonly beforeRename?: () => void | Promise<void>
}

/**
 * Replace `original.target` with `data`, but only if it still holds
 * `original.bytes`: a temp file beside it (unguessable name, created
 * exclusively, the original's permission bits, under root its owner), the
 * data written and flushed, then the file read again and renamed over only
 * if it is byte for byte what was decided on. `changed`: it is not (an edit
 * saved meanwhile); `gone`: it was removed meanwhile, and is not made again.
 * Throws (the file as it was, the temp file removed) when the file is not
 * writable (a file the user made read-only is refused, not replaced) or the
 * temp file or the rename fails. Never an in-place write: one that fails
 * halfway would leave the user's file cut short.
 */
export async function replaceIfUnchanged(original: ReadForReplace, data: string, options: ReplaceIfUnchangedOptions = {}): Promise<'replaced' | 'changed' | 'gone'> {
  const { fs, path } = await nodeModules()
  const { target } = original
  await fs.access(target, fs.constants.W_OK)
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomSuffix()}.tmp`)
  // Only a temp file this call created is ever removed: `wx` refuses a name that exists.
  let created = false
  let renamed = false
  try {
    const handle = await fs.open(tmp, 'wx', original.mode)
    created = true
    try {
      await handle.chmod(original.mode)
      if (isRoot() && (original.uid !== 0 || original.gid !== 0)) {
        await handle.chown(original.uid, original.gid).catch(() => undefined)
      }
      await handle.writeFile(data, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await options.beforeRename?.()
    let now: Uint8Array
    try {
      now = new Uint8Array(await fs.readFile(target))
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return 'gone'
      throw err
    }
    if (!sameBytes(now, original.bytes)) return 'changed'
    await renameWithRetry(tmp, target, options)
    renamed = true
    return 'replaced'
  } finally {
    if (created && !renamed) await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}
