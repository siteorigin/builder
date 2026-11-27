/**
 * The versions repository of one project (#1152), on the bundled pure-JavaScript Git. It runs in the Git worker
 * (worker.ts), never in the editor's main process: hashing and compressing a folder of pictures takes a while.
 *
 * Writing objects moves nothing: a blob, tree or commit is only ever added, under the name of its content, and the
 * objects of one write are named together once all are on the disk (fs.ts), so a write that is refused or cancelled
 * leaves nothing, and one stopped by the worker being killed at most some whole objects nothing points at.
 * A branch moves only in `advanceRef`, under Git's own lock for it (`<ref>.lock`, made exclusively, written, flushed and
 * renamed into place, as `git update-ref` does), and only from the commit the caller expected, so two writers can never
 * silently overwrite each other and a stock Git honours the same lock.
 *
 * Every write of the app's also holds the app's own lock on the repository (`siteorigin-writer.lock`), which names the
 * process holding it. A process that died holding it (the app quit or crashed mid-save, the computer lost power) is
 * seen to be gone by the next writer, which then finishes what it may have left half done: the branch lock it took,
 * known by the commit it holds, is cleared, the folders its objects were named in are flushed, and its temporary
 * objects removed. A lock of Git's that no dead writer of the app's took is never cleared, however old: it is another
 * Git's, which may still be running.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, type BigIntStats, type Stats } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { constants as zlibConstants, createDeflate, deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { eachAtMost, ensureDir, renameReplacing, safeJoinLooking, syncDir } from '../project/fsutil';
import { openRegularFile, readAtMost } from '../regular-file';
import { repoFs, TMP_PREFIX, type Fault } from './fs';
import { BRANCH_RE, GIT_LIMITS, GitError, OID_RE, VERSIONS_BRANCH, VERSIONS_GITDIR, type BlobInput, type CommitInfo, type CommitInput, type FileInput, type GitLimits, type Identity, type Oid, type TreeEntry } from './protocol';

/** Set when the caller no longer wants the result: checked between files and before a branch moves. */
export interface CancelToken {
  readonly cancelled: boolean;
}
const NEVER: CancelToken = { cancelled: false };

export interface RepoOptions {
  limits?: Partial<GitLimits>;
  /** How long to wait for another writer's lock before giving up. */
  lockWaitMs?: number;
  /** Whether a process is still running; for tests, which stop a write without ending their own process. */
  processAlive?: (pid: number) => boolean;
  /** For tests: a point in a write to stop at. */
  fault?: Fault;
}

const LOCK_WAIT_MS = 5000;
/** A writer's lock with nothing readable in it (its writer stopped as it took it) is taken as abandoned this long after. */
const UNREADABLE_LOCK_MS = 2000;
/** The app's own lock on the repository, beside Git's files, which Git leaves alone. */
const WRITER_LOCK = 'siteorigin-writer.lock';
/** Left when a write failed after naming some objects whose folders may not be on the disk: the next write flushes them. */
const UNFLUSHED = 'siteorigin-unflushed';
/** Another Git's temporary objects are its own until they are this old: the age `git gc` clears them at. */
const ABANDONED_TMP_MS = 14 * 86_400_000;
/** A writer still running whose lock is older than the computer's start by more than this has another's process ID. */
const BOOT_MARGIN_MS = 60_000;
/** How much of a file is compressed to see whether compressing it is worth it. */
const SAMPLE_BYTES = 64 * 1024;
/** The longest name a folder can hold on macOS, Windows and Linux alike. */
const MAX_NAME_BYTES = 255;
/** A branch's name with room for its `.lock` within that. */
const MAX_REF_LENGTH = 200;
/**
 * Already compressed (a photo, a video, a font): stored as it is, since compressing it again saves nothing and costs
 * most of the time a version of pictures takes. Git reads an object stored either way.
 */
const incompressible = (bytes: Uint8Array) => bytes.byteLength >= SAMPLE_BYTES && deflateSync(bytes.subarray(0, SAMPLE_BYTES), { level: 1 }).byteLength > SAMPLE_BYTES * 0.97;

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const check = (token: CancelToken) => {
  if (token.cancelled) throw new GitError('cancelled', 'The versions repository write was stopped.');
};
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Running, as another user's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Characters macOS's file system ignores in names, which Git therefore ignores too when it looks for `.git`. */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;
/** A UTF-16 half with no other half: no UTF-8 spelling, so two such names could become one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * A name as Git compares it with `.git` (its is_hfs_dotgit and is_ntfs_dotgit, which the bundled Git's tree reader
 * follows too): ignored characters dropped, a Windows stream name cut off, case and trailing dots and spaces ignored.
 */
const gitName = (s: string) => s.replace(HFS_IGNORED, '').split(':')[0].toLowerCase().replace(/[. ]+$/, '');

/**
 * Whether a part of a path is one a version cannot hold: empty, `.` or `..`, a backslash, a NUL, a broken character,
 * `.git` in any spelling Git or a checkout would take as it, `.gitmodules` (which Git reads as settings and checks), or
 * a folder named as one of Git's own files. Each would make a tree that stock Git refuses or the bundled Git cannot read.
 */
function badSegment(s: string, folder: boolean): boolean {
  if (s === '' || /[\\/\0]/.test(s) || LONE_SURROGATE.test(s)) return true;
  const visible = s.replace(HFS_IGNORED, '');
  if (visible === '.' || visible === '..') return true;
  const name = gitName(s);
  if (name === '.git' || /^\.?git~[1-9]$/.test(name) || name === '.gitmodules' || /^(gitmod|gi7eba)~[1-9]$/.test(name)) return true;
  return folder && (['.gitattributes', '.gitignore', '.mailmap'].includes(name) || /^(gitatt|gi7d29|gitign|gi250a|mailma|maba30)~[1-9]$/.test(name));
}

/** A path as a tree holds it, or throws: relative, forward slashes, and no part a version cannot hold (badSegment). */
export function checkTreePath(path: unknown, limits: GitLimits): string[] {
  if (typeof path !== 'string' || !path) throw new GitError('invalid', 'A file in a version has no path.');
  if (utf8Bytes(path) > limits.maxPathBytes) throw new GitError('too-large', `The path of ${path.slice(0, 80)}… is too long for a version.`);
  const parts = path.split('/');
  if (parts.some((p, i) => badSegment(p, i < parts.length - 1))) throw new GitError('invalid', `${path} is not a path a version can hold.`);
  if (parts.length > limits.maxDepth) throw new GitError('too-large', `${path} is in too many folders for a version.`);
  if (parts.some((p) => utf8Bytes(p) > MAX_NAME_BYTES)) throw new GitError('too-large', `A name in ${path.slice(0, 80)} is too long for a file.`);
  return parts;
}

/**
 * The name two spellings share when a Mac or Windows checkout would put them in one file: `Logo.png` and `logo.png`,
 * composed and decomposed accents, `σ` and `ς`, `logo` and `logo.`.
 */
const folded = (name: string) => name.replace(HFS_IGNORED, '').normalize('NFC').toUpperCase().toLowerCase().replace(/[. ]+$/, '');

type Dir = { kind: 'dir'; name: string; children: Map<string, Dir | File> };
type File = { kind: 'file'; name: string; index: number };

function identityOk(i: unknown): i is Identity {
  const o = i as Identity;
  // Git's header lines end at a line break, and the bundled Git's reader at any of Unicode's.
  const text = (s: unknown, max: number) => typeof s === 'string' && s.length <= max && !/[\0-\x1f\x7f<>\u2028\u2029]/.test(s);
  return !!o && text(o.name, 256) && o.name.trim() !== '' && text(o.email, 256) && Number.isSafeInteger(o.timestamp) && o.timestamp >= 0 && Number.isInteger(o.timezoneOffset) && Math.abs(o.timezoneOffset) <= 24 * 60;
}

/** isomorphic-git's errors in the app's terms. */
function asGitError(e: unknown): GitError {
  if (e instanceof GitError) return e;
  const code = (e as { code?: string })?.code;
  if (code === 'NotFoundError') return new GitError('not-found', 'That is not in the versions repository.');
  if (code === 'ObjectTypeError' || code === 'InvalidOidError' || code === 'InvalidFilepathError') return new GitError('invalid', 'That is not the kind of object asked for.');
  if (['InternalError', 'ParseError', 'DecompressionError', 'UnsafeFilepathError', 'UnknownTransportError'].includes(code ?? '')) return new GitError('corrupt', 'Part of the versions repository is damaged.');
  return new GitError('failed', `The versions repository could not be used: ${e instanceof Error ? e.message : String(e)}`);
}

/** What the app's lock on a repository says: who holds it, since when, and for a branch move, which and to what. */
interface Writer {
  pid: number;
  host: string;
  at: number;
  ref?: string;
  next?: Oid;
}

export interface Repo {
  readonly gitdir: string;
  init(): Promise<void>;
  exists(): Promise<boolean>;
  writeBlob(input: BlobInput, token?: CancelToken): Promise<Oid>;
  writeFiles(files: readonly FileInput[], token?: CancelToken): Promise<Oid>;
  writeCommit(commit: CommitInput, token?: CancelToken): Promise<Oid>;
  readBlob(oid: Oid, filepath?: string): Promise<Uint8Array>;
  readTree(oid: Oid): Promise<TreeEntry[]>;
  readCommit(oid: Oid): Promise<CommitInfo>;
  listCommits(ref: string, limit: number): Promise<CommitInfo[]>;
  resolveRef(ref: string): Promise<Oid | null>;
  advanceRef(ref: string, next: Oid, expected: Oid | null, token?: CancelToken): Promise<void>;
}

/** The repository of the project at `root` (absolute). Opening it reads and writes nothing. */
export function openRepo(root: string, opts: RepoOptions = {}): Repo {
  const limits: GitLimits = { ...GIT_LIMITS, ...opts.limits };
  const siteorigin = join(root, '.siteorigin');
  const gitdir = join(root, ...VERSIONS_GITDIR.split('/'));
  const gfs = repoFs(gitdir, opts.fault);
  const lockWait = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const alive = opts.processAlive ?? isAlive;
  /** Set when a write failed after naming some of its objects: the next write flushes their folders first. */
  let unflushed = false;
  // Writes one at a time in this worker: what one stages is flushed or discarded before the next begins.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };

  const realDir = async (path: string, what: string): Promise<boolean> => {
    const st = await fs.lstat(path).catch((e) => (isMissing(e) ? null : Promise.reject(e)));
    if (!st) return false;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new GitError('corrupt', `The versions repository is damaged: ${what} is not a folder of its own.`);
    return true;
  };
  /**
   * Whether the repository is there; throws when something is there that is not one the app made. Looked at afresh for
   * every operation, as are the folders below it (fs.ts), so one removed or replaced by a link meanwhile is seen.
   */
  const present = async (): Promise<boolean> => {
    gfs.reset();
    if (!(await realDir(siteorigin, '.siteorigin'))) return false;
    // A file here could point Git at another repository (the project's own); only a folder of its own will do.
    if (!(await realDir(gitdir, VERSIONS_GITDIR))) return false;
    const config = await fs.readFile(join(gitdir, 'config'), 'utf8').catch(() => '');
    const head = await fs.readFile(join(gitdir, 'HEAD'), 'utf8').catch(() => '');
    if (!/^\s*bare\s*=\s*true\s*$/m.test(config) || !/^ref: refs\/heads\/\S+\n?$/.test(head)) throw new GitError('corrupt', 'The versions repository is damaged: it is not a repository the app made.');
    for (const d of ['objects', 'refs', 'refs/heads']) if (!(await realDir(join(gitdir, ...d.split('/')), d))) throw new GitError('corrupt', `The versions repository is damaged: it has no ${d} folder.`);
    return true;
  };
  const need = async () => {
    if (!(await present())) throw new GitError('not-found', 'This project has no versions repository yet.');
  };
  const io = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      await need();
      return await f();
    } catch (e) {
      throw asGitError(e);
    }
  };

  /**
   * Finish what a writer of the app's that stopped part way may have left: flush the folders its objects were named in
   * (an object can be seen before its folder is on the disk, and must not be relied on until it is), and the branches'
   * folder, and remove its temporary objects, and anyone's long abandoned.
   */
  const recover = async (dead?: number) => {
    const objects = join(gitdir, 'objects');
    if (dead !== undefined)
      for (const name of await fs.readdir(gitdir).catch(() => [] as string[])) if (name.startsWith(`siteorigin-${dead}-`) && name.endsWith('.tmp')) await fs.rm(join(gitdir, name), { force: true });
    const fans = (await fs.readdir(objects).catch(() => [] as string[])).filter((d) => /^[0-9a-f]{2}$/.test(d));
    await eachAtMost(4, fans, async (fan) => {
      const dir = join(objects, fan);
      // A folder linked elsewhere is not the repository's: nothing in it is touched (and reading through it is refused).
      if (!(await fs.lstat(dir).catch(() => null))?.isDirectory()) return;
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!name.startsWith(TMP_PREFIX)) continue;
        const own = dead !== undefined && name.startsWith(`${TMP_PREFIX}${dead}_`);
        const st = own ? null : await fs.lstat(join(dir, name)).catch(() => null);
        if (own || (st && Date.now() - st.mtimeMs > ABANDONED_TMP_MS)) await fs.rm(join(dir, name), { force: true }).catch(() => undefined);
      }
      await syncDir(dir);
    });
    await syncDir(objects);
    await syncDir(join(gitdir, 'refs', 'heads'));
    unflushed = false;
  };

  /**
   * Make `path` exclusively, holding `content` from its first moment: written whole to a temporary file and linked into
   * place, which fails if anything is there, so a lock is never seen empty or half written, even by a writer that stops
   * as it takes it. Where the disk has no hard links (a FAT drive), it is made exclusively and then written. False when
   * something is there already.
   */
  const createWhole = async (path: string, content: string): Promise<boolean> => {
    const tmp = join(gitdir, `siteorigin-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    try {
      const t = await fs.open(tmp, 'wx');
      try {
        await t.writeFile(content);
        await t.sync();
      } finally {
        await t.close();
      }
      try {
        await fs.link(tmp, path);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      }
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(path, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  };

  /** The app's lock as it is now, or null when it is not there. A read that fails is thrown: it says nothing either way. */
  const readWriter = async (file: string): Promise<{ writer: Writer | null; st: Stats } | null> => {
    const st = await fs.lstat(file).catch((e) => (isMissing(e) ? null : Promise.reject(e)));
    if (!st) return null;
    if (!st.isFile()) throw new GitError('corrupt', `The versions repository is damaged: ${WRITER_LOCK} is not a file.`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    try {
      const w = JSON.parse(text) as Writer;
      return { writer: Number.isSafeInteger(w?.pid) && typeof w.host === 'string' && Number.isFinite(w.at) ? w : null, st };
    } catch {
      return { writer: null, st };
    }
  };
  /**
   * Whether the writer that holds the app's lock has stopped: its process has exited, or still runs but only under a
   * number reused since the computer last started. Another computer's (a project on a shared folder) cannot be told, so
   * it is waited for. A lock with nothing readable in it (made where there are no hard links, by a writer that stopped
   * as it took it) is taken as abandoned a moment after it was made.
   */
  const stopped = (held: { writer: Writer | null; st: Stats }) => {
    const w = held.writer;
    if (!w) return Date.now() - held.st.mtimeMs >= UNREADABLE_LOCK_MS;
    if (w.host !== hostname()) return false;
    if (!alive(w.pid)) return true;
    return w.at < Date.now() - uptime() * 1000 - BOOT_MARGIN_MS;
  };

  /**
   * Hold the app's own lock on the repository while `f` writes, clearing one a stopped writer left and finishing its
   * work (recover). `move` is the branch move about to be made, recorded first, and made durable, so a stopped move's
   * branch lock can be told from another Git's.
   */
  const asWriter = async <T>(f: () => Promise<T>, move?: { ref: string; next: Oid }): Promise<T> => {
    const file = join(gitdir, WRITER_LOCK);
    const unflushedMark = join(gitdir, UNFLUSHED);
    const deadline = performance.now() + lockWait;
    for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
      const mine: Writer = { pid: process.pid, host: hostname(), at: Date.now(), ...move };
      if (await createWhole(file, JSON.stringify(mine))) {
        try {
          // The lock is in place before a branch lock is taken, so a stopped move's branch lock is known by it.
          if (move) await syncDir(gitdir);
          if (unflushed || (await fs.lstat(unflushedMark).catch(() => null))) {
            await recover();
            await fs.rm(unflushedMark, { force: true });
          }
          return await f();
        } finally {
          // Removed only if it is still this writer's.
          const now = await readWriter(file).catch(() => null);
          if (now?.writer?.pid === mine.pid && now.writer.at === mine.at && now.writer.host === mine.host) await fs.unlink(file).catch(() => undefined);
        }
      }
      const held = await readWriter(file);
      if (held && stopped(held)) {
        // Its branch lock first, while its own lock still keeps every other writer of the app's out; then its objects. A
        // branch lock is its only if it holds the very commit it was moving the branch to: another Git's never does.
        const w = held.writer;
        if (w?.ref && w.next && BRANCH_RE.test(w.ref) && w.ref.length <= MAX_REF_LENGTH) {
          const lock = `${join(gitdir, ...w.ref.split('/'))}.lock`;
          const text = await fs.readFile(lock, 'utf8').catch((e) => (isMissing(e) ? null : Promise.reject(e)));
          if (text === `${w.next}\n`) await fs.unlink(lock).catch((e) => (isMissing(e) ? undefined : Promise.reject(e)));
        }
        await recover(w && w.host === hostname() ? w.pid : undefined);
        // Removed only if it is still the one found stopped; a removal refused is thrown, never retried for ever.
        const again = await readWriter(file);
        if (again && again.st.ino === held.st.ino && again.st.mtimeMs === held.st.mtimeMs) await fs.unlink(file).catch((e) => (isMissing(e) ? undefined : Promise.reject(e)));
      }
      if (performance.now() >= deadline) throw new GitError('locked', 'Another save is writing to the versions repository; nothing was written.');
      if (!held || !stopped(held)) await sleep(wait);
    }
  };

  /**
   * A write of objects, one at a time and as the app's writer: what it staged is made durable and named before it
   * answers, and removed if it fails, so its objects are all there or none is.
   */
  const writing = <T>(f: () => Promise<T>): Promise<T> =>
    io(() =>
      serial(() =>
        asWriter(async () => {
          try {
            const result = await f();
            await gfs.flush();
            return result;
          } catch (e) {
            // Some may have been named before the failure, their folders not yet flushed: the next write, whichever worker
            // makes it, flushes them before relying on any.
            if (gfs.named()) {
              unflushed = true;
              await fs.writeFile(join(gitdir, UNFLUSHED), String(Date.now())).catch(() => undefined);
            }
            await gfs.discard();
            throw e;
          }
        })
      )
    );

  /** The object's type, or null when it is not there. Reads the whole object: for trees and commits, which are small. */
  const typeOf = async (oid: Oid): Promise<string | null> => {
    try {
      return (await git.readObject({ fs: gfs, gitdir, oid, format: 'content' })).type;
    } catch (e) {
      if ((e as { code?: string })?.code === 'NotFoundError') return null;
      throw e;
    }
  };
  const objectPath = (oid: Oid) => join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
  /**
   * Whether a loose object is there, as a file in a folder of the repository's own: anything else under its name, or a
   * folder linked elsewhere, is damage, never taken for it.
   */
  const looseExists = async (oid: Oid) => {
    if (!(await realDir(dirname(objectPath(oid)), `objects/${oid.slice(0, 2)}`))) return false;
    const st = await fs.lstat(objectPath(oid)).catch(() => null);
    if (st && !st.isFile()) throw new GitError('corrupt', `The versions repository is damaged: object ${oid} is not a file.`);
    return !!st;
  };

  /**
   * A project file to read, and its stat: a plain file reached with no link on the way, so nothing outside the project,
   * and nothing of its own `.git` through a folder linked to it, can be taken into a version.
   */
  const sourceFile = async (source: unknown): Promise<{ abs: string; st: BigIntStats }> => {
    checkTreePath(source, limits);
    let found: ReturnType<typeof safeJoinLooking>;
    try {
      found = safeJoinLooking(root, source as string);
    } catch {
      throw new GitError('invalid', `${String(source)} is not a file of this project.`);
    }
    // The very look that found no link on the way is the one kept: a folder swapped for a link after it is a different
    // file when it is opened (readSource).
    if (found.st) return { abs: found.abs, st: found.st };
    if (found.st === null || !(await fs.lstat(found.abs).catch(() => null))) throw new GitError('not-found', `${String(source)} is not there.`);
    throw new GitError('invalid', `${String(source)} is not a plain file of this project: it is a link, a folder, or reached through a link.`);
  };
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

  /** A file's bytes, read only as far as the size it had when it was checked, and refused if it changed meanwhile. */
  const readSource = async (source: string, seen?: { abs: string; st: BigIntStats }): Promise<Uint8Array> => {
    const { abs, st: checked } = seen ?? (await sourceFile(source));
    if (checked.size > BigInt(limits.maxBlobBytes)) throw new GitError('too-large', `${source} is too large for a version.`);
    let opened: Awaited<ReturnType<typeof openRegularFile>>;
    try {
      opened = await openRegularFile(abs);
    } catch (e) {
      if (isMissing(e)) throw new GitError('changed', `${source} was removed while the version was being saved.`);
      throw new GitError('invalid', `${source} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { handle, stat } = opened;
    try {
      if (!same(await handle.stat({ bigint: true }), checked)) throw new GitError('changed', `${source} changed while the version was being saved.`);
      const data = await readAtMost(handle, stat.size, stat.size);
      if (!data || data.byteLength !== stat.size || !same(await handle.stat({ bigint: true }), checked)) throw new GitError('changed', `${source} changed while the version was being saved.`);
      return data;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  /**
   * A blob of these bytes, staged unless it is there already. Hashed and compressed by Node's own SHA-1 and zlib, which
   * are several times quicker than the bundled Git's, and compressed as it is written, so it is never held twice over.
   */
  const blob = async (bytes: Uint8Array): Promise<Oid> => {
    const header = Buffer.from(`blob ${bytes.byteLength}\0`);
    const oid = createHash('sha1').update(header).update(bytes).digest('hex');
    const path = objectPath(oid);
    if (gfs.staged(path)) return oid;
    if (await looseExists(oid)) {
      // Used again, as Git does: given the time now, so a `git gc` meanwhile takes it for new, not long unused.
      const now = new Date();
      await fs.utimes(path, now, now).catch(() => undefined);
      return oid;
    }
    const deflate = createDeflate({ level: incompressible(bytes) ? 0 : zlibConstants.Z_DEFAULT_COMPRESSION });
    await gfs.stage(path, Readable.from([header, bytes], { objectMode: false }).pipe(deflate));
    return oid;
  };

  /** The commit a branch points at, exactly as written (never a shorthand or a link to another), or null. */
  const readRef = async (ref: string): Promise<Oid | null> => {
    const path = join(gitdir, ...ref.split('/'));
    const st = await fs.lstat(path).catch((e) => (isMissing(e) ? null : Promise.reject(e)));
    if (st) {
      if (!st.isFile()) throw new GitError('corrupt', `The versions repository is damaged: ${ref} is not a branch.`);
      const m = /^([0-9a-f]{40})\n?$/.exec(await fs.readFile(path, 'utf8'));
      if (!m) throw new GitError('corrupt', `The versions repository is damaged: ${ref} names no commit.`);
      return m[1];
    }
    // A stock Git may have packed its branches into one file (`git pack-refs`); the loose file, when there, wins.
    const packed = await fs.readFile(join(gitdir, 'packed-refs'), 'utf8').catch((e) => (isMissing(e) ? '' : Promise.reject(e)));
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const space = line.indexOf(' ');
      if (line.slice(space + 1).trim() !== ref) continue;
      const oid = line.slice(0, space);
      if (!OID_RE.test(oid)) throw new GitError('corrupt', `The versions repository is damaged: ${ref} names no commit.`);
      return oid;
    }
    return null;
  };
  const checkRef = (ref: unknown): string => {
    if (typeof ref !== 'string' || ref.length > MAX_REF_LENGTH || !BRANCH_RE.test(ref)) throw new GitError('invalid', `${String(ref).slice(0, 80)} is not a branch the app writes.`);
    return ref;
  };
  const checkOid = (oid: unknown): Oid => {
    if (typeof oid !== 'string' || !OID_RE.test(oid)) throw new GitError('invalid', `${String(oid)} is not an object name.`);
    return oid;
  };

  /** Take `<ref>.lock` holding `content`, waiting a while for another Git that holds it; throws `locked` when it keeps it. */
  const takeLock = async (lock: string, content: string) => {
    const deadline = performance.now() + lockWait;
    for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
      if (await createWhole(lock, content)) return;
      if (performance.now() >= deadline) throw new GitError('locked', 'Another Git is moving this branch of the versions repository; it was not moved.');
      await sleep(wait);
    }
  };

  const listing = (oid: Oid, c: { message: string; tree: Oid; parent: Oid[]; author: Identity; committer: Identity }): CommitInfo => ({
    oid,
    tree: c.tree,
    parents: [...c.parent],
    message: c.message,
    author: { name: c.author.name, email: c.author.email, timestamp: c.author.timestamp, timezoneOffset: c.author.timezoneOffset },
    committer: { name: c.committer.name, email: c.committer.email, timestamp: c.committer.timestamp, timezoneOffset: c.committer.timezoneOffset }
  });

  return {
    gitdir,
    exists: () => present().catch((e) => Promise.reject(asGitError(e))),

    init: () =>
      serial(async () => {
        if (await present()) return;
        await ensureDir(siteorigin);
        if (!(await realDir(siteorigin, '.siteorigin'))) throw new GitError('failed', 'The versions repository could not be made.');
        // Made whole beside its place and renamed into it, so an interrupted start leaves no half-made repository that
        // Git would then take as made (it stops at an existing config).
        const tmp = join(siteorigin, `versions.git.tmp-${Math.random().toString(36).slice(2, 10)}`);
        try {
          await git.init({ fs: repoFs(tmp), gitdir: tmp, bare: true, defaultBranch: VERSIONS_BRANCH.slice('refs/heads/'.length) });
          await syncDir(tmp);
          try {
            await renameReplacing(tmp, gitdir);
          } catch (e) {
            // Another made it first: theirs is the repository.
            if (!(await realDir(gitdir, VERSIONS_GITDIR).catch(() => false))) throw e;
          }
          await syncDir(siteorigin);
        } finally {
          await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        }
        if (!(await present())) throw new GitError('failed', 'The versions repository could not be made.');
      }).catch((e) => Promise.reject(asGitError(e))),

    writeBlob: (input, token = NEVER) =>
      writing(async () => {
        check(token);
        if (input && 'bytes' in input) {
          if (!(input.bytes instanceof Uint8Array)) throw new GitError('invalid', 'A file in a version has no bytes.');
          if (input.bytes.byteLength > limits.maxBlobBytes) throw new GitError('too-large', 'The file is too large for a version.');
          return blob(input.bytes);
        }
        return blob(await readSource(String(input?.source)));
      }),

    writeFiles: (files, token = NEVER) =>
      writing(async () => {
        if (!Array.isArray(files)) throw new GitError('invalid', 'A version needs a list of files.');
        if (files.length > limits.maxEntries) throw new GitError('too-large', `A version can hold ${limits.maxEntries} files at most.`);
        // Everything is checked before anything is written: a refused version leaves nothing behind.
        const top: Dir = { kind: 'dir', name: '', children: new Map() };
        const seen: Array<{ abs: string; st: BigIntStats } | undefined> = [];
        let total = 0;
        let inline = 0;
        for (const [index, f] of files.entries()) {
          const parts = checkTreePath(f?.path, limits);
          if ('bytes' in f) {
            if (!(f.bytes instanceof Uint8Array)) throw new GitError('invalid', `${f.path} has no bytes.`);
            if (f.bytes.byteLength > limits.maxBlobBytes) throw new GitError('too-large', `${f.path} is too large for a version.`);
            inline += f.bytes.byteLength;
            total += f.bytes.byteLength;
            seen.push(undefined);
          } else if (typeof f?.source === 'string') {
            const file = await sourceFile(f.source);
            if (file.st.size > BigInt(limits.maxBlobBytes)) throw new GitError('too-large', `${f.source} is too large for a version.`);
            total += Number(file.st.size);
            seen.push(file);
          } else throw new GitError('invalid', `${String(f?.path)} has no content.`);
          if (inline > limits.maxInlineBytes || total > limits.maxTotalBytes) throw new GitError('too-large', 'The files are too large together for one version.');
          let dir = top;
          for (const [i, name] of parts.entries()) {
            const leaf = i === parts.length - 1;
            const key = folded(name);
            const there = dir.children.get(key);
            if (there && (there.name !== name || leaf || there.kind === 'file')) throw new GitError('invalid', `${f.path} clashes with another file of the version${there.name !== name ? ` (${there.name})` : ''}.`);
            if (leaf) dir.children.set(key, { kind: 'file', index, name });
            else {
              if (!there) dir.children.set(key, { kind: 'dir', name, children: new Map() });
              dir = dir.children.get(key) as Dir;
            }
          }
        }
        if (opts.fault) await opts.fault('files-checked', gitdir);
        // One file at a time, each let go once written, so the memory held is one file's, however many there are.
        const oids: Oid[] = [];
        for (const [index, f] of files.entries()) {
          check(token);
          oids[index] = await blob('bytes' in f ? f.bytes : await readSource(f.source, seen[index]));
          if (opts.fault) await opts.fault('file-written', f.path);
        }
        const writeDir = async (dir: Dir): Promise<Oid> => {
          const entries: TreeEntry[] = [];
          for (const child of dir.children.values()) {
            check(token);
            if (child.kind === 'file') entries.push({ mode: '100644', path: child.name, oid: oids[child.index], type: 'blob' });
            else entries.push({ mode: '040000', path: child.name, oid: await writeDir(child), type: 'tree' });
          }
          return git.writeTree({ fs: gfs, gitdir, tree: entries });
        };
        return writeDir(top);
      }),

    writeCommit: (commit, token = NEVER) =>
      writing(async () => {
        const c = commit ?? ({} as CommitInput);
        checkOid(c.tree);
        if (!Array.isArray(c.parents) || c.parents.length > 8) throw new GitError('invalid', 'A version’s commit has a list of at most 8 parents.');
        c.parents.forEach(checkOid);
        if (!identityOk(c.author) || !identityOk(c.committer)) throw new GitError('invalid', 'A version’s commit needs a name, an address, a time and a time zone for who made it.');
        if (typeof c.message !== 'string' || c.message.includes('\0')) throw new GitError('invalid', 'A version’s commit needs a message.');
        if (utf8Bytes(c.message) > limits.maxMessageBytes) throw new GitError('too-large', 'The message is too long for a version’s commit.');
        // A commit names only what is there: its tree, and earlier commits.
        if ((await typeOf(c.tree)) !== 'tree') throw new GitError('not-found', 'The tree of the commit is not in the versions repository.');
        for (const p of c.parents) if ((await typeOf(p)) !== 'commit') throw new GitError('not-found', 'An earlier commit is not in the versions repository.');
        check(token);
        const person = (i: Identity) => ({ name: i.name, email: i.email, timestamp: i.timestamp, timezoneOffset: i.timezoneOffset });
        return git.writeCommit({ fs: gfs, gitdir, commit: { message: c.message, tree: c.tree, parent: [...c.parents], author: person(c.author), committer: person(c.committer) } });
      }),

    readBlob: (oid, filepath) =>
      io(async () => {
        checkOid(oid);
        if (filepath !== undefined) checkTreePath(filepath, limits);
        return (await git.readBlob({ fs: gfs, gitdir, oid, ...(filepath !== undefined ? { filepath } : {}) })).blob;
      }),

    readTree: (oid) =>
      io(async () => {
        checkOid(oid);
        return (await git.readTree({ fs: gfs, gitdir, oid })).tree.map((e) => ({ mode: e.mode, path: e.path, oid: e.oid, type: e.type }));
      }),

    readCommit: (oid) =>
      io(async () => {
        checkOid(oid);
        const { commit } = await git.readCommit({ fs: gfs, gitdir, oid });
        return listing(oid, commit);
      }),

    listCommits: (ref, limit) =>
      io(async () => {
        checkRef(ref);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new GitError('invalid', 'A listing needs a number of commits.');
        const tip = await readRef(ref);
        if (!tip) return [];
        const log = await git.log({ fs: gfs, gitdir, ref: tip, depth: Math.min(limit, limits.maxLogDepth) });
        return log.map((c) => listing(c.oid, c.commit));
      }),

    resolveRef: (ref) =>
      io(async () => {
        checkRef(ref);
        return readRef(ref);
      }),

    advanceRef: (ref, next, expected, token = NEVER) =>
      io(() => {
        checkRef(ref);
        checkOid(next);
        if (expected !== null) checkOid(expected);
        return serial(() =>
          asWriter(
            async () => {
              if ((await typeOf(next)) !== 'commit') throw new GitError('not-found', 'The commit to publish is not in the versions repository.');
              check(token);
              const path = join(gitdir, ...ref.split('/'));
              const dir = dirname(path);
              if (!(await realDir(join(gitdir, 'refs'), 'refs')) || !(await realDir(dir, dirname(ref)))) throw new GitError('corrupt', 'The versions repository is damaged: it has no refs/heads folder.');
              const lock = `${path}.lock`;
              await takeLock(lock, `${next}\n`);
              let owned = true;
              try {
                if (opts.fault) await opts.fault('lock-written', lock);
                const actual = await readRef(ref);
                if (actual !== expected) throw new GitError('conflict', 'The branch moved since it was read; it was not moved again.', actual);
                check(token);
                await renameReplacing(lock, path);
                owned = false;
                if (opts.fault) await opts.fault('ref-renamed', path);
                try {
                  await syncDir(dir);
                } catch {
                  throw new GitError('outcome-unknown', 'The branch was moved, but the disk did not confirm it: read it again.');
                }
              } finally {
                if (owned) await fs.unlink(lock).catch(() => undefined);
              }
            },
            { ref, next }
          )
        );
      })
  };
}
