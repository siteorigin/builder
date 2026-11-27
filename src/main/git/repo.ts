/**
 * The versions repository of one project (#1152), on the bundled pure-JavaScript Git. It runs in the Git worker
 * (worker.ts), never in the editor's main process: hashing and compressing a folder of pictures takes a while.
 *
 * Writing objects moves nothing: a blob, tree or commit is only ever added, under the name of its content, and the
 * objects of one write are named together once all are on the disk (fs.ts), so a write that is refused or cancelled
 * leaves nothing, and one stopped by the worker being killed at most some whole objects nothing points at.
 * A branch moves only in `advanceRef`, under Git's own lock for it (`<ref>.lock`, made exclusively, renamed into place,
 * as `git update-ref` does), and only from the commit the caller expected, so two writers can never silently overwrite
 * each other and a stock Git honours the same lock.
 *
 * The app makes its branch lock as a second name (a hard link) for a file of its own beside the repository's, whose
 * name says which computer, process and branch it is for (`siteorigin-lock.<computer>.<process>.<branch>.<random>`),
 * so the lock is whole from its first moment and known for the app's own by being that very file. A lock left by a
 * process of the app's that has exited (the app quit or crashed mid-save) is cleared by the next save of the branch; a
 * lock that is not one of those files is another Git's, which may still be running, and is never cleared. Where the
 * disk has no hard links (a FAT drive), the lock is made the plain way, and one left behind stays until removed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { constants as zlibConstants, createDeflate, deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { eachAtMost, ensureDir, renameReplacing, safeJoinLooking, syncDir } from '../project/fsutil';
import { openRegularFile, readAtMost } from '../regular-file';
import { HOST, repoFs, TMP_PREFIX, type Fault } from './fs';
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
/** The file each of the app's branch locks is a second name for, beside Git's files, which Git leaves alone. */
const LOCK_FILE = /^siteorigin-lock\.([0-9a-f]{8})\.(\d+)\.([a-z0-9-]+)\.[0-9a-f]+$/;
/** Errors of a disk that has no hard links, where a lock is made the plain way. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR', 'UNKNOWN']);
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

const SHA256_RE = /^[0-9a-f]{64}$/;
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
const HFS_IGNORED = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;
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
  /** Whether this worker has cleared its exited predecessors' temporary objects yet. */
  let swept = false;
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
   * Remove what this computer's processes of the app that have exited (a save stopped part way, a worker killed) left,
   * once per worker: their branch locks and lock files (clearAbandoned), and their temporary objects. They are the
   * app's own, and nothing writes them any more. Another's are left to `git gc`. Only folders of the repository's own
   * are looked in.
   */
  const sweep = async () => {
    if (swept) return;
    swept = true;
    const branches = new Set<string>();
    for (const name of await fs.readdir(gitdir).catch(() => [] as string[])) {
      const m = LOCK_FILE.exec(name);
      if (m && m[1] === HOST && !alive(Number(m[2]))) branches.add(m[3]);
    }
    for (const branch of branches) {
      const ref = `refs/heads/${branch}`;
      if (BRANCH_RE.test(ref) && ref.length <= MAX_REF_LENGTH) await clearAbandoned(ref, `${join(gitdir, ...ref.split('/'))}.lock`, '');
    }
    const objects = join(gitdir, 'objects');
    const fans = (await fs.readdir(objects).catch(() => [] as string[])).filter((d) => /^[0-9a-f]{2}$/.test(d));
    await eachAtMost(4, fans, async (fan) => {
      const dir = join(objects, fan);
      if (!(await fs.lstat(dir).catch(() => null))?.isDirectory()) return;
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        const m = name.startsWith(`${TMP_PREFIX}${HOST}_`) ? /^(\d+)_/.exec(name.slice(TMP_PREFIX.length + HOST.length + 1)) : null;
        if (m && !alive(Number(m[1]))) await fs.rm(join(dir, name), { force: true }).catch(() => undefined);
      }
    });
  };

  /**
   * A write of objects, one at a time in this worker: what it staged is made durable and named, and what it relies on
   * made durable, before it answers, and what it staged removed if it fails, so its objects are all there or none is.
   */
  const writing = <T>(f: () => Promise<T>): Promise<T> =>
    io(() =>
      serial(async () => {
        await sweep();
        try {
          const result = await f();
          await gfs.flush();
          return result;
        } catch (e) {
          await gfs.discard();
          throw e;
        }
      })
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
    if (!(await realDir(dirname(objectPath(oid)), `objects/${oid.slice(0, 2)}`))) return null;
    const st = await fs.lstat(objectPath(oid)).catch(() => null);
    if (st && !st.isFile()) throw new GitError('corrupt', `The versions repository is damaged: object ${oid} is not a file.`);
    return st;
  };

  /** A loose object a write relies on without writing it: made durable by the write's flush (fs.ts reuse). */
  const relyOn = (oid: Oid) => looseExists(oid).then((st) => st && gfs.reuse(objectPath(oid), st.mtimeMs));
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
    const there = await looseExists(oid);
    if (there) {
      gfs.reuse(path, there.mtimeMs);
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

  /**
   * Clear the branch locks of this computer's processes of the app that have exited: each file the app makes its lock
   * a second name for, named for this branch and an exited process, goes, and the lock with it only when the lock is
   * that very file. Whether anything was cleared.
   */
  const clearAbandoned = async (ref: string, lock: string, own: string): Promise<boolean> => {
    const branch = ref.slice('refs/heads/'.length);
    let cleared = false;
    for (const name of await fs.readdir(gitdir)) {
      const m = LOCK_FILE.exec(name);
      if (!m || name === own || m[1] !== HOST || m[3] !== branch || alive(Number(m[2]))) continue;
      const file = join(gitdir, name);
      const look = (f: string) => fs.lstat(f, { bigint: true }).catch((e) => (isMissing(e) ? null : Promise.reject(e)));
      const [mine, held] = await Promise.all([look(file), look(lock)]);
      // The lock first, while the file still says whose it is.
      if (mine && held && mine.dev === held.dev && mine.ino === held.ino) await fs.unlink(lock).catch((e) => (isMissing(e) ? undefined : Promise.reject(e)));
      await fs.unlink(file).catch((e) => (isMissing(e) ? undefined : Promise.reject(e)));
      cleared = true;
    }
    return cleared;
  };

  /**
   * Take `<ref>.lock`, holding `content` from its first moment: a file of the app's (LOCK_FILE) written, flushed and
   * recorded in the repository's folder, then linked as the lock, which fails if any lock is there. Waits a while for
   * another Git that holds it, clearing one an exited process of the app's left; throws `locked` when it stays. Gives
   * back what releases it: the lock removed unless it was renamed onto the branch, then the file.
   */
  const takeLock = async (ref: string, lock: string, content: string): Promise<(renamed: boolean) => Promise<void>> => {
    const file = join(gitdir, `siteorigin-lock.${HOST}.${process.pid}.${ref.slice('refs/heads/'.length)}.${randomBytes(6).toString('hex')}`);
    const handle = await fs.open(file, 'wx');
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const removeFile = () => fs.rm(file, { force: true }).catch(() => undefined);
    try {
      await syncDir(gitdir);
      const deadline = performance.now() + lockWait;
      for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
        try {
          await fs.link(file, lock);
          return async (renamed) => {
            // The lock before its file: a lock whose file is gone could never again be known for the app's.
            if (!renamed) await fs.unlink(lock).catch(() => undefined);
            await removeFile();
          };
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? '';
          if (code !== 'EEXIST') {
            if (!NO_LINKS.has(code)) throw e;
            await removeFile();
            return plainLock(lock, content, deadline);
          }
        }
        if (await clearAbandoned(ref, lock, basename(file))) continue;
        if (performance.now() >= deadline) throw new GitError('locked', 'Another Git is moving this branch of the versions repository; it was not moved.');
        await sleep(wait);
      }
    } catch (e) {
      await removeFile();
      throw e;
    }
  };

  /** A lock made the plain way, on a disk with no hard links: made exclusively, then written. */
  const plainLock = async (lock: string, content: string, deadline: number): Promise<(renamed: boolean) => Promise<void>> => {
    for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await fs.open(lock, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (handle) {
        try {
          await handle.writeFile(content);
          await handle.sync();
        } catch (e) {
          await handle.close().catch(() => undefined);
          await fs.unlink(lock).catch(() => undefined);
          throw e;
        }
        await handle.close();
        return async (renamed) => {
          if (!renamed) await fs.unlink(lock).catch(() => undefined);
        };
      }
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
            if (f.sha256 !== undefined && (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256))) throw new GitError('invalid', `${f.path} has a hash that is not a SHA-256.`);
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
          const bytes = 'bytes' in f ? f.bytes : await readSource(f.source, seen[index]);
          if ('source' in f && f.sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new GitError('changed', `${f.source} changed while the version was being saved.`);
          oids[index] = await blob(bytes);
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
        for (const oid of [c.tree, ...c.parents]) await relyOn(oid);
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
        return serial(async () => {
          await sweep();
          if ((await typeOf(next)) !== 'commit') throw new GitError('not-found', 'The commit to publish is not in the versions repository.');
          await relyOn(next).then(() => gfs.flush());
          check(token);
          const path = join(gitdir, ...ref.split('/'));
          const dir = dirname(path);
          if (!(await realDir(join(gitdir, 'refs'), 'refs')) || !(await realDir(dir, dirname(ref)))) throw new GitError('corrupt', 'The versions repository is damaged: it has no refs/heads folder.');
          const lock = `${path}.lock`;
          const release = await takeLock(ref, lock, `${next}\n`);
          let renamed = false;
          try {
            if (opts.fault) await opts.fault('lock-written', lock);
            const actual = await readRef(ref);
            if (actual !== expected) throw new GitError('conflict', 'The branch moved since it was read; it was not moved again.', actual);
            check(token);
            await renameReplacing(lock, path);
            renamed = true;
            if (opts.fault) await opts.fault('ref-renamed', path);
            try {
              await syncDir(dir);
            } catch {
              throw new GitError('outcome-unknown', 'The branch was moved, but the disk did not confirm it: read it again.');
            }
          } finally {
            await release(renamed);
          }
        });
      })
  };
}
