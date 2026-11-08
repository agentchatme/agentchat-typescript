/**
 * The few file operations the kit needs (the texts cache, the manual), for
 * Node, Bun and Deno. `node:` modules are imported lazily, on first use, so
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
