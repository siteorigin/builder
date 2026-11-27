import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { perf } from '../perf';

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * `fn` over every item, a few at a time: enough to overlap the disk's waits, never so many open files that one fails
 * to open (and an unreadable file would look like a missing one).
 */
export async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R> | R, size = 16): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** How many durable writes are made at once where their order does not matter: one flush need not wait for another. */
export const WRITES_AT_ONCE = 8;

/**
 * `fn` for each item, at most `limit` at a time. On the first failure nothing more is started, and that failure is
 * thrown once every call already started has settled, so nothing is still writing when the caller cleans up.
 */
export async function eachAtMost<T>(limit: number, items: readonly T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  let failed: { error: unknown } | null = null;
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed) throw (failed as { error: unknown }).error;
}

/**
 * Make the folders the project-relative `paths` go in, durably, one after another in the order they first appear,
 * each checked to be inside `root` just before it is made: files then written into them at the same time each return
 * only once the file, and every folder on its way, is on disk.
 */
export async function ensureParents(root: string, paths: readonly string[]): Promise<void> {
  const made = new Set<string>();
  for (const p of paths) {
    const dir = posix.dirname(p.split(sep).join('/'));
    if (dir === '.' || made.has(dir)) continue;
    made.add(dir);
    await ensureDir(safeJoin(root, dir));
  }
}

/** Resolve a project-relative path, rejecting traversal and symlink escape. */
export function safeJoin(root: string, rel: string): string {
  return contain(root, rel);
}

/**
 * What `safeJoinLooking` saw at the path itself: its own stat (never through a link) when it is a regular file reached
 * with no link on the way, null when nothing is there, and undefined when the check cannot say (a link on the way, a
 * folder or anything else at the path), so the caller looks for itself.
 */
export type Looked = BigIntStats | null | undefined;

/**
 * `safeJoin`, with what the check saw at the path itself (`Looked`): the check looks at every part of the path on its
 * way down, the file included, so a caller that only needs to know whether a file is still as it was need not look at
 * it again. Compared only with a stat taken by path (`fs.stat`), which for a regular file says the same.
 *
 * `pass` is for checking many paths together in one synchronous pass (FolderPass).
 */
export function safeJoinLooking(root: string, rel: string, pass?: FolderPass): { abs: string; st: Looked } {
  const leaf: { st: Looked } = { st: undefined };
  const abs = contain(root, rel, leaf, pass);
  return { abs, st: leaf.st };
}

/** How many folders in one folder a pass looks at one by one before it reads that folder whole instead. */
const READ_FOLDER_AT = 8;

/**
 * The folders on the way to many paths below one root, checked together in one synchronous pass (safeJoinLooking): a
 * folder found to be a folder of its own (no link) on the way to one of them is not looked at again on the way to the
 * next, and once the pass has looked at several folders in one folder, that folder is read whole, its entries saying
 * which of the rest are folders of their own instead of each being looked at. Anything its entries do not show as a
 * folder (a link, a file, a name written another way) is looked at as ever. Made for one pass and dropped with it: a
 * path about to be written or removed is checked again first, on its own (safeJoin).
 */
export class FolderPass {
  /** Folders found to be folders of their own. */
  private own = new Set<string>();
  /** Per folder: how many folders in it were looked at one by one, or the names of its entries that are folders of their own once it has been read whole. */
  private inside = new Map<string, number | Set<string>>();

  /** Whether `at`, the entry `name` of the folder `dir` (one found to be its own already), is known to be a folder of its own. */
  isOwn(dir: string, name: string, at: string): boolean {
    if (this.own.has(at)) return true;
    let names = this.inside.get(dir);
    if (names === undefined || typeof names === 'number') {
      if ((names ?? 0) < READ_FOLDER_AT) return false;
      names = new Set();
      perf.count('fs.syncCalls');
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name);
      } catch {
        // A folder that cannot be read says nothing: each entry is looked at on its own.
      }
      this.inside.set(dir, names);
    }
    if (!names.has(name)) return false;
    this.own.add(at);
    return true;
  }

  /** `at`, an entry of `dir`, was looked at, and is a folder of its own. */
  found(dir: string, at: string): void {
    this.own.add(at);
    const n = this.inside.get(dir);
    if (n === undefined || typeof n === 'number') this.inside.set(dir, (n ?? 0) + 1);
  }
}

/** Roots already found to be normalized absolute folders other than a disk's top: a part is joined to one by a separator. */
const plainRoots = new Map<string, boolean>();
function isPlainRoot(root: string): boolean {
  let plain = plainRoots.get(root);
  if (plain === undefined) {
    plain = isAbsolute(root) && resolve(root) === root && !root.endsWith(sep);
    if (plainRoots.size < 64) plainRoots.set(root, plain);
  }
  return plain;
}

/**
 * `rel` below `root` as resolve() would give it, worked out without it, when `rel` is a plain relative path (parts
 * joined by `/`, none of them empty, `.` or `..`; on Windows, no `\` or `:` either) and `root` is plain too: such a
 * path's parts are the path itself, so resolving it changes nothing. Null for anything else, which is resolved.
 */
function plainBelow(root: string, rel: string): string | null {
  if (!rel || !isPlainRoot(root)) return null;
  if (sep === '\\' && (rel.includes('\\') || rel.includes(':'))) return null;
  for (let i = 0, j; i <= rel.length; i = j + 1) {
    j = rel.indexOf('/', i);
    if (j < 0) j = rel.length;
    if (j === i || (rel[i] === '.' && (j === i + 1 || (j === i + 2 && rel[i + 1] === '.')))) return null;
  }
  return root + sep + (sep === '/' ? rel : rel.replaceAll('/', sep));
}

function contain(root: string, rel: string, leaf?: { st: Looked }, pass?: FolderPass): string {
  if (rel.includes('\0')) throw new Error('Invalid path.');
  const plain = plainBelow(root, rel);
  const abs = plain ?? resolve(root, rel);
  const r = plain ? plain.slice(root.length + 1) : relative(root, abs);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new Error(`Path escapes the project: ${rel}`);
  // With no link on the way down from the project's folder, the path's real location is inside the project's, wherever
  // that is: nothing more to check. Looking costs one lstat a part, where the real paths below cost one for every
  // folder from the top of the disk, and a project's files are looked up by the thousand as it opens.
  // Only for the very path returned: on Windows, relative() matches folder names whatever their case, so `r` could
  // name a sibling folder whose name differs from the project's by case alone.
  if ((plain || join(root, r) === abs) && noLinkBelow(root, r, leaf, pass)) return abs;
  if (leaf) leaf.st = undefined;
  // Walk up to the nearest existing ancestor and make sure its real path is inside the project.
  let probe = abs;
  for (;;) {
    perf.count('fs.syncCalls');
    if (existsSync(probe) || probe === root) break;
    probe = dirname(probe);
  }
  perf.count('fs.syncCalls', 2);
  const realRoot = realpathSync(root);
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new Error(`Path escapes the project through a link: ${rel}`);
  return abs;
}

/**
 * Whether each part of `rel` (relative to `root`, normalized) that is there is a folder or file of its own, not a link
 * or a junction: looked at from the top down, without following any. Once one part is not there, the parts below it
 * cannot be either. Anything else (a link, a part that cannot be looked at, a project folder that is not there) is
 * left to the full check of real paths, which then decides as it always has. With `leaf`, says what is at the path
 * itself (`Looked`), from the very look that found it no link. A folder `pass` knows to be one of its own is not
 * looked at again; each one found is told to it.
 */
function noLinkBelow(root: string, rel: string, leaf?: { st: Looked }, pass?: FolderPass): boolean {
  let at = root;
  const parts = rel.split(sep);
  // Below a plain root, each part (normalized already, as `rel` is) is joined to the path so far by a separator.
  const plain = isPlainRoot(root);
  for (let i = 0; i < parts.length; i++) {
    const dir = at;
    at = plain ? at + sep + parts[i] : join(at, parts[i]);
    const last = i === parts.length - 1;
    if (!last && pass?.isOwn(dir, parts[i], at)) continue;
    perf.count('fs.syncCalls');
    try {
      const st = last && leaf ? lstatSync(at, { bigint: true }) : lstatSync(at);
      if (st.isSymbolicLink()) return false;
      if (last && leaf) leaf.st = st.isFile() ? (st as BigIntStats) : undefined;
      else if (!last && st.isDirectory()) pass?.found(dir, at);
    } catch (e) {
      // Below a part that is there (the project's own folder, past its first part): nothing further is.
      const gone = i > 0 && (e as NodeJS.ErrnoException).code === 'ENOENT';
      if (gone && leaf) leaf.st = null;
      return gone;
    }
  }
  return true;
}

/**
 * Flush a folder's entries (a file created, renamed or removed in it) to disk, so the change survives a power loss.
 * Some platforms cannot open or sync a folder (Windows): there a file's own sync is the only guarantee available.
 */
export async function syncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
    perf.count('fs.fsyncs');
  } catch (e) {
    if (!DIR_SYNC_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
const DIR_SYNC_UNSUPPORTED = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP']);

/** Create a folder and any missing parents, each recorded durably in its own parent. */
export async function ensureDir(dir: string, opts: { durable?: boolean } = {}): Promise<void> {
  const first = await fs.mkdir(dir, { recursive: true });
  if (!first || opts.durable === false) return;
  for (let d = dir; dirname(d) !== d; d = dirname(d)) {
    await syncDir(dirname(d));
    if (d.length <= first.length) break;
  }
}

export interface RenameReplacingOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to keep retrying a rename the system refuses for a moment. */
  budgetMs?: number;
  /**
   * Asked again before each retry: what decided the rename may no longer hold by then (a caller's `beforeReplace`).
   * When it says no, nothing is renamed and RenameWithdrawn is thrown.
   */
  again?: () => Promise<boolean>;
}

/** A rename called off between its tries (RenameReplacingOptions.again): nothing was replaced. */
export class RenameWithdrawn extends Error {
  constructor() {
    super('The rename was called off.');
    this.name = 'RenameWithdrawn';
  }
}

/** The codes Windows gives a rename while something (a sync client, an antivirus scan, the indexer) has a file open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_BUDGET_MS = 3000;
const RENAME_FIRST_WAIT_MS = 10;
const RENAME_MAX_WAIT_MS = 250;

/**
 * Rename `from` onto `to`, replacing it, as `fs.rename` does. On Windows, a rename is refused for a moment while
 * another program (OneDrive, Defender, the search indexer) holds the target or source open, so a refusal is retried
 * with a short, growing wait until the budget runs out; anywhere else, and for any other error, it fails at once.
 */
export async function renameReplacing(from: string, to: string, opts: RenameReplacingOptions = {}): Promise<void> {
  // Looked up at each call, so a stand-in for `fs.rename` (a test's injected fault) is still the one used.
  const rename = opts.rename ?? ((a: string, b: string) => fs.rename(a, b));
  if ((opts.platform ?? process.platform) !== 'win32') return rename(from, to);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.budgetMs ?? RENAME_BUDGET_MS);
  for (let wait = RENAME_FIRST_WAIT_MS; ; wait = Math.min(wait * 2, RENAME_MAX_WAIT_MS)) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (!TRANSIENT_RENAME_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      const left = deadline - now();
      if (left <= 0) throw e;
      await sleep(Math.min(wait, left));
      if (opts.again && !(await opts.again())) throw new RenameWithdrawn();
    }
  }
}

/**
 * Write via a temporary file and rename, so readers never see a partial file. A `mode` is applied when the
 * temporary file is created, so a private file is never readable by others, even briefly.
 *
 * Durable by default: the data is flushed before the rename and the folder after it, so when this returns the new
 * file survives a power loss, and a later write that depends on it cannot reach the disk first. `durable: false`
 * is for files that are rebuilt from others anyway (the preview's editor variants).
 *
 * `beforeReplace` runs once the new file is ready, immediately before it takes the path; when it says no, nothing
 * is replaced. It says whether the file was replaced.
 */
export async function atomicWrite(path: string, data: string | Buffer, opts: { mode?: number; durable?: boolean; beforeReplace?: () => Promise<boolean>; retryCheck?: () => Promise<boolean> } = {}): Promise<boolean> {
  const durable = opts.durable !== false;
  const dir = dirname(path);
  await ensureDir(dir, { durable });
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    if (durable) {
      const handle = await fs.open(tmp, 'wx', opts.mode ?? 0o666);
      try {
        await handle.writeFile(data);
        // The umask can only remove bits from the requested mode, never add them; chmod makes it exact.
        if (opts.mode !== undefined) await handle.chmod(opts.mode);
        await handle.sync();
        perf.count('fs.fsyncs');
      } finally {
        await handle.close();
      }
    } else {
      await fs.writeFile(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
      if (opts.mode !== undefined) await fs.chmod(tmp, opts.mode);
    }
    if (opts.beforeReplace && !(await opts.beforeReplace())) {
      await fs.rm(tmp, { force: true });
      return false;
    }
    // A rename Windows refuses for a moment is retried; `retryCheck`, when given, is asked again before each try.
    await renameReplacing(tmp, path, opts.retryCheck ? { again: opts.retryCheck } : {});
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (e instanceof RenameWithdrawn) return false;
    throw e;
  }
  if (durable) await syncDir(dir);
  // Counted once it is in place (src/shared/perf.ts): a durable one has reached the disk, its folder entry too.
  perf.count('fs.writes');
  if (durable) perf.count('fs.durableWrites');
  return true;
}

/**
 * A durable write split in two, so several can share their waits: the data is already in a flushed temporary file
 * beside `path`; `replace` renames it into place, and the folder it lands in is flushed by `syncStaged`, once for all the
 * files replaced there, before anything depends on them.
 */
export interface StagedWrite {
  readonly path: string;
  /** Rename into place once `beforeReplace` agrees (see atomicWrite); says whether it was replaced. */
  replace(beforeReplace?: () => Promise<boolean>): Promise<boolean>;
  /** Remove the temporary file of a write that will not be replaced. */
  discard(): Promise<void>;
  readonly replaced: boolean;
}

/**
 * The first half of a durable atomicWrite: the folders on the way made and recorded in their parents, the data written to
 * a temporary file beside `path` and flushed. Several staged at once flush together.
 */
export async function stageWrite(path: string, data: string | Buffer, opts: { mode?: number } = {}): Promise<StagedWrite> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await fs.open(tmp, 'wx', opts.mode ?? 0o666);
    try {
      await handle.writeFile(data);
      // The umask can only remove bits from the requested mode, never add them; chmod makes it exact.
      if (opts.mode !== undefined) await handle.chmod(opts.mode);
      await handle.sync();
      perf.count('fs.fsyncs');
    } finally {
      await handle.close();
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  let state: 'staged' | 'replaced' | 'gone' = 'staged';
  return {
    path,
    get replaced() {
      return state === 'replaced';
    },
    async replace(beforeReplace) {
      if (state !== 'staged') throw new Error(`A staged write of ${path} was already used.`);
      try {
        if (beforeReplace && !(await beforeReplace())) {
          state = 'gone';
          await fs.rm(tmp, { force: true });
          return false;
        }
        await renameReplacing(tmp, path);
      } catch (e) {
        state = 'gone';
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
      state = 'replaced';
      perf.count('fs.writes');
      return true;
    },
    async discard() {
      if (state !== 'staged') return;
      state = 'gone';
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  };
}

/** How many files are written or flushed at once: enough to overlap their flushes, few enough to keep handles free. */
const AT_ONCE = 16;

/** Run `fn` on each item, `AT_ONCE` at a time; once one fails no more are started, and the first failure is thrown. */
async function eachAtOnce<T>(items: readonly T[], fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { reason: unknown } | null = null;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (!failure && next < items.length) {
        const i = next++;
        await fn(items[i], i).catch((reason: unknown) => {
          failure ??= { reason };
        });
      }
    })
  );
  if (failure) throw (failure as { reason: unknown }).reason;
}

/**
 * Stage the writes in `files` together, so their flushes overlap. All or none: when one cannot be staged, the others'
 * temporary files are removed and its error thrown.
 */
export async function stageWrites(files: ReadonlyArray<{ path: string; data: string | Buffer }>): Promise<StagedWrite[]> {
  const staged: StagedWrite[] = new Array(files.length);
  try {
    await eachAtOnce(files, async (f, i) => {
      staged[i] = await stageWrite(f.path, f.data);
    });
  } catch (e) {
    await Promise.all(staged.map((s) => s?.discard()));
    throw e;
  }
  return staged;
}

/**
 * Flush, together, the folder of every staged write that was replaced, each folder once, so the renames survive a power
 * loss. Each is then counted as a durable write (src/shared/perf.ts): its data and its folder entry are on disk.
 */
export async function syncStaged(staged: Iterable<StagedWrite>): Promise<void> {
  const done = [...staged].filter((s) => s.replaced);
  await eachAtOnce([...new Set(done.map((s) => dirname(s.path)))], (dir) => syncDir(dir));
  for (let i = 0; i < done.length; i++) perf.count('fs.durableWrites');
}

/** Remove a file and flush its folder, so the removal is on disk before anything that depends on it. */
export async function removeDurable(path: string): Promise<void> {
  await fs.rm(path, { force: true });
  await syncDir(dirname(path));
}

export async function readJson<T>(path: string): Promise<T> {
  const text = await fs.readFile(path, 'utf8');
  perf.count('files.read');
  return JSON.parse(text) as T;
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path, 'utf8');
    perf.count('files.read');
    return text;
  } catch {
    return null;
  }
}

/** A file's bytes, for comparing files that may not be text. */
export async function readBytesIfExists(path: string): Promise<Buffer | null> {
  try {
    const bytes = await fs.readFile(path);
    perf.count('files.read');
    return bytes;
  } catch {
    return null;
  }
}

export async function removeEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      const entries = await fs.readdir(cur);
      if (entries.length) return;
      await fs.rmdir(cur);
    } catch {
      return;
    }
    cur = dirname(cur);
  }
}

export const toJson = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
