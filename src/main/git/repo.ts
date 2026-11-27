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
 * A lock is held for milliseconds. One left by a worker that stopped while holding it is cleared by a later worker,
 * once it is older than that worker and a moment old: the app runs one Git worker at a time, starts the next only
 * after the last has exited, and runs as a single instance, so such a lock belongs to no writer still running.
 */
import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { constants as zlibConstants, createDeflate, deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { ensureDir, renameReplacing, safeJoin, syncDir } from '../project/fsutil';
import { openRegularFile, readAtMost } from '../regular-file';
import { repoFs, type Fault } from './fs';
import { BRANCH_RE, GIT_LIMITS, GitError, OID_RE, VERSIONS_BRANCH, VERSIONS_GITDIR, type BlobInput, type CommitInfo, type CommitInput, type FileInput, type GitLimits, type Identity, type Oid, type TreeEntry } from './protocol';

/** Set when the caller no longer wants the result: checked between files and before a branch moves. */
export interface CancelToken {
  readonly cancelled: boolean;
}
const NEVER: CancelToken = { cancelled: false };

export interface RepoOptions {
  limits?: Partial<GitLimits>;
  /** When this worker started (ms since 1970): a lock older than this was left by a worker that has exited. */
  startedAt?: number;
  /** How old an abandoned lock must be before it is cleared, for file systems that keep coarse times. */
  lockMinAgeMs?: number;
  /** How long to wait for another writer's lock before giving up. */
  lockWaitMs?: number;
  /** For tests: a point in a write to stop at. */
  fault?: Fault;
}

const LOCK_MIN_AGE_MS = 2000;
const LOCK_WAIT_MS = 5000;
/** How much of a file is compressed to see whether compressing it is worth it. */
const SAMPLE_BYTES = 64 * 1024;
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

/** A part of a path a repository could not hold, or that Git and its checkouts treat as special (`.git` in any spelling). */
function badSegment(s: string): boolean {
  return s === '' || s === '.' || s === '..' || /[\\\0]/.test(s) || /^\.git[. ]*$/i.test(s) || /^git~\d+$/i.test(s);
}

/** A path as a tree holds it, or throws: relative, forward slashes, and no part that is empty, `.`, `..` or `.git`. */
export function checkTreePath(path: unknown, limits: GitLimits): string[] {
  if (typeof path !== 'string' || !path) throw new GitError('invalid', 'A file in a version has no path.');
  if (utf8Bytes(path) > limits.maxPathBytes) throw new GitError('too-large', `The path of ${path.slice(0, 80)}… is too long for a version.`);
  const parts = path.split('/');
  if (parts.some(badSegment)) throw new GitError('invalid', `${path} is not a path a version can hold.`);
  if (parts.length > limits.maxDepth) throw new GitError('too-large', `${path} is in too many folders for a version.`);
  return parts;
}

/** The name two spellings share when a Mac or Windows checkout would put them in one file (`Logo.png`, `logo.png`). */
const folded = (name: string) => name.normalize('NFC').toLowerCase();

type Node = { kind: 'file'; index: number } | { kind: 'dir'; name: string; children: Map<string, Node & { name: string }> };
type Named = Node & { name: string };

function identityOk(i: unknown): i is Identity {
  const o = i as Identity;
  const text = (s: unknown, max: number) => typeof s === 'string' && s.length <= max && !/[<>\n\0]/.test(s);
  return !!o && text(o.name, 256) && o.name.trim() !== '' && text(o.email, 256) && Number.isSafeInteger(o.timestamp) && o.timestamp >= 0 && Number.isInteger(o.timezoneOffset) && Math.abs(o.timezoneOffset) <= 24 * 60;
}

/** isomorphic-git's errors in the app's terms. */
function asGitError(e: unknown): GitError {
  if (e instanceof GitError) return e;
  const code = (e as { code?: string })?.code;
  if (code === 'NotFoundError') return new GitError('not-found', 'That is not in the versions repository.');
  if (code === 'ObjectTypeError' || code === 'InvalidOidError' || code === 'InvalidFilepathError') return new GitError('invalid', 'That is not the kind of object asked for.');
  if (code === 'InternalError' || code === 'ParseError' || code === 'UnknownTransportError') return new GitError('corrupt', 'Part of the versions repository is damaged.');
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
  const startedAt = opts.startedAt ?? performance.timeOrigin;
  const lockMinAge = opts.lockMinAgeMs ?? LOCK_MIN_AGE_MS;
  const lockWait = opts.lockWaitMs ?? LOCK_WAIT_MS;
  let known = false;
  // Writes that move something (making the repository, moving a branch) one at a time in this worker.
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
  /** Whether the repository is there; throws when something is there that is not one the app made. */
  const present = async (): Promise<boolean> => {
    if (known) return true;
    if (!(await realDir(siteorigin, '.siteorigin'))) return false;
    // A file here could point Git at another repository (the project's own); only a folder of its own will do.
    if (!(await realDir(gitdir, VERSIONS_GITDIR))) return false;
    const config = await fs.readFile(join(gitdir, 'config'), 'utf8').catch(() => '');
    const head = await fs.readFile(join(gitdir, 'HEAD'), 'utf8').catch(() => '');
    if (!/^\s*bare\s*=\s*true\s*$/m.test(config) || !/^ref: refs\/heads\/\S+\n?$/.test(head)) throw new GitError('corrupt', 'The versions repository is damaged: it is not a repository the app made.');
    for (const d of ['objects', 'refs', 'refs/heads']) if (!(await realDir(join(gitdir, ...d.split('/')), d))) throw new GitError('corrupt', `The versions repository is damaged: it has no ${d} folder.`);
    known = true;
    return true;
  };
  const need = async () => {
    if (!(await present())) throw new GitError('not-found', 'This project has no versions repository yet.');
  };
  const io = async <T>(f: () => Promise<T>): Promise<T> => {
    await need();
    try {
      return await f();
    } catch (e) {
      throw asGitError(e);
    }
  };
  /**
   * A write of objects, one at a time in this worker: what it staged is made durable and named before it answers, and
   * removed if it fails, so its objects are all there or none is.
   */
  const writing = <T>(f: () => Promise<T>): Promise<T> =>
    io(() =>
      serial(async () => {
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
  const looseExists = async (oid: Oid) => !!(await fs.lstat(objectPath(oid)).catch(() => null));

  /** A file's bytes, read only as far as the size it had when it was checked, and refused if it changed meanwhile. */
  const readSource = async (source: string, seen?: Stats): Promise<Uint8Array> => {
    checkTreePath(source, limits);
    let abs: string;
    try {
      abs = safeJoin(root, source);
    } catch {
      throw new GitError('invalid', `${source} is not a file of this project.`);
    }
    let opened: Awaited<ReturnType<typeof openRegularFile>>;
    try {
      opened = await openRegularFile(abs);
    } catch (e) {
      if (isMissing(e)) throw new GitError('not-found', `${source} is not there.`);
      throw new GitError('invalid', `${source} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { handle, stat } = opened;
    try {
      if (stat.size > limits.maxBlobBytes) throw new GitError('too-large', `${source} is too large for a version.`);
      if (seen && (stat.size !== seen.size || stat.ino !== seen.ino || stat.mtimeMs !== seen.mtimeMs)) throw new GitError('changed', `${source} changed while the version was being saved.`);
      const data = await readAtMost(handle, stat.size, stat.size);
      const after = await handle.stat();
      if (!data || data.byteLength !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new GitError('changed', `${source} changed while the version was being saved.`);
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
    if (gfs.staged(path) || (await looseExists(oid))) return oid;
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
    if (typeof ref !== 'string' || !BRANCH_RE.test(ref)) throw new GitError('invalid', `${String(ref)} is not a branch the app writes.`);
    return ref;
  };
  const checkOid = (oid: unknown): Oid => {
    if (typeof oid !== 'string' || !OID_RE.test(oid)) throw new GitError('invalid', `${String(oid)} is not an object name.`);
    return oid;
  };

  /** Take `<ref>.lock`, clearing one left by a worker that has exited; throws `locked` when a live writer keeps it. */
  const takeLock = async (lock: string) => {
    const deadline = performance.now() + lockWait;
    for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
      try {
        return await fs.open(lock, 'wx', 0o666);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const st = await fs.lstat(lock).catch(() => null);
      if (st && st.mtimeMs < startedAt && Date.now() - st.mtimeMs >= lockMinAge) {
        await fs.unlink(lock).catch((e) => (isMissing(e) ? undefined : Promise.reject(e)));
        continue;
      }
      if (performance.now() >= deadline) throw new GitError('locked', 'Another save is moving this branch of the versions repository; it was not moved.');
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
    exists: () => present(),

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
        known = false;
        if (!(await present())) throw new GitError('failed', 'The versions repository could not be made.');
      }).catch((e) => Promise.reject(asGitError(e))),

    writeBlob: (input, token = NEVER) =>
      writing(async () => {
        check(token);
        if ('bytes' in input) {
          if (!(input.bytes instanceof Uint8Array)) throw new GitError('invalid', 'A file in a version has no bytes.');
          if (input.bytes.byteLength > limits.maxBlobBytes) throw new GitError('too-large', 'The file is too large for a version.');
          return blob(input.bytes);
        }
        return blob(await readSource(input.source));
      }),

    writeFiles: (files, token = NEVER) =>
      writing(async () => {
        if (!Array.isArray(files)) throw new GitError('invalid', 'A version needs a list of files.');
        if (files.length > limits.maxEntries) throw new GitError('too-large', `A version can hold ${limits.maxEntries} files at most.`);
        // Everything is checked before anything is written: a refused version leaves nothing behind.
        const top: Named = { kind: 'dir', name: '', children: new Map() };
        const seen: Array<Stats | undefined> = [];
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
            checkTreePath(f.source, limits);
            let st: Stats;
            try {
              st = await fs.lstat(safeJoin(root, f.source));
            } catch (e) {
              if (isMissing(e)) throw new GitError('not-found', `${f.source} is not there.`);
              throw new GitError('invalid', `${f.source} is not a file of this project.`);
            }
            if (!st.isFile()) throw new GitError('invalid', `${f.source} is not a file.`);
            if (st.size > limits.maxBlobBytes) throw new GitError('too-large', `${f.source} is too large for a version.`);
            total += st.size;
            seen.push(st);
          } else throw new GitError('invalid', `${String(f?.path)} has no content.`);
          if (inline > limits.maxInlineBytes || total > limits.maxTotalBytes) throw new GitError('too-large', 'The files are too large together for one version.');
          let dir = top as Extract<Named, { kind: 'dir' }>;
          for (const [i, name] of parts.entries()) {
            const leaf = i === parts.length - 1;
            const key = folded(name);
            const there = dir.children.get(key);
            if (there && (there.name !== name || leaf || there.kind === 'file')) throw new GitError('invalid', `${f.path} clashes with another file of the version${there.name !== name ? ` (${there.name})` : ''}.`);
            if (leaf) dir.children.set(key, { kind: 'file', index, name });
            else {
              if (!there) dir.children.set(key, { kind: 'dir', name, children: new Map() });
              dir = dir.children.get(key) as Extract<Named, { kind: 'dir' }>;
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
        const writeDir = async (dir: Extract<Named, { kind: 'dir' }>): Promise<Oid> => {
          const entries: TreeEntry[] = [];
          for (const child of dir.children.values()) {
            check(token);
            if (child.kind === 'file') entries.push({ mode: '100644', path: child.name, oid: oids[child.index], type: 'blob' });
            else entries.push({ mode: '040000', path: child.name, oid: await writeDir(child as Extract<Named, { kind: 'dir' }>), type: 'tree' });
          }
          return git.writeTree({ fs: gfs, gitdir, tree: entries });
        };
        return writeDir(top as Extract<Named, { kind: 'dir' }>);
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
      io(() =>
        serial(async () => {
          checkRef(ref);
          checkOid(next);
          if (expected !== null) checkOid(expected);
          if ((await typeOf(next)) !== 'commit') throw new GitError('not-found', 'The commit to publish is not in the versions repository.');
          check(token);
          const path = join(gitdir, ...ref.split('/'));
          const dir = dirname(path);
          const lock = `${path}.lock`;
          const handle = await takeLock(lock);
          let owned = true;
          try {
            try {
              await handle.writeFile(`${next}\n`);
              await handle.sync();
            } finally {
              await handle.close();
            }
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
        })
      )
  };
}
