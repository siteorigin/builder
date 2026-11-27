/**
 * The file system the bundled Git is given (#1152). Its own writes go straight to the final name, so a worker that
 * stopped part way through would leave a truncated object under the name of a whole one, which it then never
 * rewrites because the name exists. Here an object is written whole to a temporary name beside its place (named as
 * Git names its own, `tmp_obj_`, which `git fsck` passes over and `git gc` clears) and flushed to the disk, and only
 * `flush` gives it its name: every object staged since the last flush is renamed into place, and the folders they
 * landed in flushed once each, so an object either is complete and on disk or is not there. Flushing the folders
 * together is what keeps a version of a few hundred pictures quick: a folder flush after every object costs far more
 * than writing the objects.
 *
 * Nothing is read or written outside the repository's folder, and nothing through a link: a folder of the repository
 * that turns out to be a link (to the project's own `.git/`, say) is refused rather than followed.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { eachAtMost, renameReplacing, syncDir } from '../project/fsutil';
import { GitError } from './protocol';

/** Points in a write where a test stops the worker, to see what a crash there leaves. */
export type FaultPoint = 'files-checked' | 'file-written' | 'object-written' | 'lock-written' | 'ref-renamed';
export type Fault = (point: FaultPoint, path: string) => void | Promise<void>;

/** Folder flushes run side by side: the disk takes several at once faster than one after another. */
const FLUSHES_AT_ONCE = 4;

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '');

export interface RepoFs {
  /** The fs client isomorphic-git takes: an object with an enumerable `promises`. */
  promises: Record<string, (...args: never[]) => Promise<unknown>>;
  /** Write an object's bytes to a temporary name beside `path`; it takes the name at the next flush. */
  stage(path: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  /** Whether an object is staged for `path`. */
  staged(path: string): boolean;
  /** Make every staged object durable and give it its name. */
  flush(): Promise<void>;
  /** Remove every staged object (the write they belong to was refused or cancelled). */
  discard(): Promise<void>;
}

/** The repository's files, confined to `gitdir`. `fault` is for tests only. */
export function repoFs(gitdir: string, fault?: Fault): RepoFs {
  const inside = (path: string) => {
    const rel = relative(gitdir, path);
    if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))) return path;
    throw new GitError('invalid', 'The repository tried to reach a file outside its folder.');
  };
  const isObject = (path: string) => relative(gitdir, path).split(sep)[0] === 'objects';
  // Folders already seen to be real folders inside the repository (not links), so each is looked at once.
  const checked = new Set<string>();
  /** Refuse a folder of the repository, between it and `dir`, that is a link. */
  const realDir = async (dir: string) => {
    for (let d = dir; d.length > gitdir.length && !checked.has(d); d = dirname(d)) {
      const st = await fs.lstat(d).catch((e) => (isMissing(e) ? null : Promise.reject(e)));
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isDirectory()) throw new GitError('corrupt', `The versions repository is damaged: ${relative(gitdir, d)} is not a folder of its own.`);
      checked.add(d);
    }
  };
  /** Folders made for objects since the last flush, recorded in their parent by it. */
  const madeDirs = new Set<string>();
  /** A folder for an object, made if it is not there. */
  const objectDir = async (dir: string) => {
    if (checked.has(dir)) return;
    await realDir(dir);
    if (!checked.has(dir) && (await fs.mkdir(dir, { recursive: true }))) madeDirs.add(dir);
    await realDir(dir);
  };

  /** Objects staged since the last flush: the final name of each, and its temporary one. */
  const pending = new Map<string, string>();
  /**
   * Their flushes, still going: an object's bytes are flushed while the next is read and compressed, a few at a time,
   * since each takes a few milliseconds of the disk's time and very little of the worker's.
   */
  let syncing: Array<Promise<void>> = [];

  async function stage(path: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    inside(path);
    if (pending.has(path)) return;
    await objectDir(dirname(path));
    const tmp = join(dirname(path), `tmp_obj_${randomBytes(6).toString('hex')}`);
    const handle = await fs.open(tmp, 'wx');
    try {
      for await (const chunk of chunks) await handle.write(chunk);
    } catch (e) {
      await handle.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    pending.set(path, tmp);
    const done = handle.sync().finally(() => handle.close());
    // Settled flushes leave the list; a failed one is kept, for the flush to report.
    const entry: Promise<void> = done.then(() => void (syncing = syncing.filter((p) => p !== entry)));
    entry.catch(() => undefined);
    syncing.push(entry);
    if (syncing.length >= FLUSHES_AT_ONCE) await Promise.race(syncing).catch(() => undefined);
  }

  /** Wait for every object's flush; the first that failed is thrown once all have settled. */
  const synced = async () => {
    const all = syncing;
    syncing = [];
    const failed = (await Promise.allSettled(all)).find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  };

  async function flush() {
    const batch = [...pending];
    pending.clear();
    const dirs = [...madeDirs];
    madeDirs.clear();
    let named = 0;
    try {
      await synced();
      for (const [path, tmp] of batch) {
        if (fault) await fault('object-written', path);
        try {
          await renameReplacing(tmp, path);
        } catch (e) {
          // An object is named by its content: one already there (a reader holding it open on Windows) is this one.
          if (!(await fs.stat(path).catch(() => null))) throw e;
          await fs.rm(tmp, { force: true });
        }
        named++;
      }
      // The folders the objects were named in, and those the new folders were made in: then every one is on the disk.
      await eachAtMost(FLUSHES_AT_ONCE, [...new Set([...batch.map(([path]) => dirname(path)), ...dirs.map((d) => dirname(d))])], syncDir);
    } catch (e) {
      await Promise.all(batch.slice(named).map(([, tmp]) => fs.rm(tmp, { force: true }).catch(() => undefined)));
      throw e;
    }
  }

  async function discard() {
    const batch = [...pending.values()];
    pending.clear();
    madeDirs.clear();
    await synced().catch(() => undefined);
    await Promise.all(batch.map((tmp) => fs.rm(tmp, { force: true }).catch(() => undefined)));
  }

  /** isomorphic-git's writes: objects are staged; anything else (a new repository's config) is written durably at once. */
  async function writeFile(path: string, data: Uint8Array | string) {
    inside(path);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (isObject(path)) return stage(path, [bytes]);
    const dir = dirname(path);
    await realDir(dir);
    const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      const handle = await fs.open(tmp, 'wx', 0o666);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameReplacing(tmp, path);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    await syncDir(dir);
  }

  async function mkdir(path: string, options?: unknown) {
    inside(path);
    await realDir(dirname(path));
    await fs.mkdir(path, options as Parameters<typeof fs.mkdir>[1]);
    await syncDir(dirname(path));
  }

  const guarded =
    <A extends unknown[], R>(f: (path: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      inside(path);
      return f(path, ...rest);
    };
  const noLinks = (code: string) => async () => {
    throw Object.assign(new Error('The versions repository holds no links.'), { code });
  };

  return {
    stage,
    staged: (path) => pending.has(path),
    flush,
    discard,
    promises: {
      // isomorphic-git calls readFile() with nothing to learn whether this is a promise fs: that must reject, not throw.
      readFile: async (path: string, options?: unknown) => {
        inside(path);
        await realDir(dirname(path));
        return fs.readFile(path, options as Parameters<typeof fs.readFile>[1]);
      },
      writeFile,
      mkdir,
      rmdir: guarded((p: string) => fs.rmdir(p)),
      unlink: guarded((p: string) => fs.unlink(p)),
      stat: guarded((p: string, o?: unknown) => fs.stat(p, o as Parameters<typeof fs.stat>[1])),
      lstat: guarded((p: string, o?: unknown) => fs.lstat(p, o as Parameters<typeof fs.lstat>[1])),
      readdir: guarded(async (p: string, o?: unknown) => {
        await realDir(p);
        return fs.readdir(p, o as Parameters<typeof fs.readdir>[1]);
      }),
      readlink: guarded(noLinks('EINVAL')),
      symlink: guarded(noLinks('EPERM')),
      chmod: guarded((p: string, m: number) => fs.chmod(p, m))
    } as unknown as RepoFs['promises']
  };
}
