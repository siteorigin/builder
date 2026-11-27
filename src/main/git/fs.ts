/**
 * The file system the bundled Git is given (#1152). Its own writes go straight to the final name, so a worker that
 * stopped part way through would leave a truncated object under the name of a whole one, which it then never
 * rewrites because the name exists. Here an object is written whole to a temporary name beside its place (TMP_PREFIX)
 * and flushed to the disk, and only `flush` gives it its name.
 *
 * A write may rely only on objects that are on the disk, folder entry and all. So `flush`, before the write it ends
 * answers, renames every object it staged into place, and then flushes the folder of every object the write named or
 * found already there (an object named by a write that failed, or by a worker that was killed, can be seen before its
 * folder is on the disk), and `objects/` itself, once each, unless this worker flushed the folder since anything was
 * last named in it. Objects found already there are also given the time now, as Git does, once a day old, so a
 * `git gc` meanwhile takes them for new rather than long unused.
 *
 * Windows cannot flush a folder (fsutil.ts syncDir): there an object's own flush and NTFS's journal of its rename are
 * what there is, as for every durable write of the app's.
 *
 * Nothing is read or written outside the repository's folder, and nothing through a link: a folder of the repository
 * that turns out to be a link (to the project's own `.git/`, say) is refused rather than followed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { PromiseFsClient } from 'isomorphic-git';
import { eachAtMost, renameReplacing, syncDir } from '../project/fsutil';
import { GitError } from './protocol';

/** Points in a write where a test stops the worker, to see what a crash there leaves. */
export type FaultPoint = 'files-checked' | 'file-written' | 'object-written' | 'lock-written' | 'ref-renamed';
export type Fault = (point: FaultPoint, path: string) => void | Promise<void>;

/** Folder flushes run side by side: the disk takes several at once faster than one after another. */
const FLUSHES_AT_ONCE = 4;
/** An object used again is given the time now once it is older than this: well inside the two weeks `git gc` keeps one. */
const FRESHEN_AFTER_MS = 86_400_000;
/** This computer, as the names of temporary objects and locks carry it: a shared folder can be written from several. */
export const HOST = createHash('sha1').update(hostname()).digest('hex').slice(0, 8);
/**
 * The start of a temporary object's name: Git's own (`tmp_obj_`, which `git fsck` passes over and `git gc` clears), then
 * the computer and process writing it, so those of a process that has exited can be cleared (repo.ts).
 */
export const TMP_PREFIX = 'tmp_obj_';
const OBJECT_PATH = /^objects[\\/][0-9a-f]{2}[\\/][0-9a-f]{38}$/;

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '');

export interface RepoFs {
  /** The fs client isomorphic-git takes: an object with an enumerable `promises`. */
  promises: PromiseFsClient['promises'];
  /** Write an object's bytes to a temporary name beside `path`; it takes the name at the next flush. */
  stage(path: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  /** Whether an object is staged for `path`. */
  staged(path: string): boolean;
  /** An object already there, last changed at `mtimeMs`, that the write relies on: made durable at the next flush. */
  reuse(path: string, mtimeMs: number): void;
  /** Make every staged object durable and named, and every object relied on durable, before the write answers. */
  flush(): Promise<void>;
  /** Remove every staged object (the write they belong to was refused or cancelled). */
  discard(): Promise<void>;
  /** Forget which folders were seen to be real folders: each operation looks again. */
  reset(): void;
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

  /** Objects staged since the last flush: the final name of each, and its temporary one. */
  const pending = new Map<string, string>();
  /** Objects already there that the write relies on, with the time each was last changed. */
  const reused = new Map<string, number>();
  /**
   * Folders this worker flushed, with their modification time as it was just before: one unchanged since (nothing
   * named in it since, by anyone, since a rename into a folder changes its time) need not be flushed again.
   */
  const flushed = new Map<string, bigint>();
  /** Flush a folder unless it is unchanged since this worker last flushed it (`always`: it has just been written to). */
  const flushDir = async (dir: string, always: boolean) => {
    const before = (await fs.lstat(dir, { bigint: true })).mtimeNs;
    if (!always && flushed.get(dir) === before) return false;
    await syncDir(dir);
    flushed.set(dir, before);
    return true;
  };
  /**
   * Staged objects' flushes, still going: an object's bytes are flushed while the next is read and compressed, a few at
   * a time, since each takes a few milliseconds of the disk's time and very little of the worker's.
   */
  const syncing = new Set<Promise<void>>();
  /** The first such flush that failed since the last flush or discard: nothing more is staged once one has. */
  let syncFailed: { error: unknown } | null = null;

  async function stage(path: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    inside(path);
    if (syncFailed) throw syncFailed.error;
    if (pending.has(path)) return;
    const dir = dirname(path);
    await realDir(dir);
    await fs.mkdir(dir, { recursive: true });
    await realDir(dir);
    const tmp = join(dir, `${TMP_PREFIX}${HOST}_${process.pid}_${randomBytes(6).toString('hex')}`);
    const handle = await fs.open(tmp, 'wx');
    try {
      for await (const chunk of chunks) {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as string);
        // A write may take only part of what it is given: the rest is written until all is, or the disk refuses.
        for (let at = 0; at < bytes.byteLength; ) {
          const { bytesWritten } = await handle.write(bytes, at, bytes.byteLength - at);
          if (bytesWritten <= 0) throw new GitError('failed', 'The disk took none of an object being written.');
          at += bytesWritten;
        }
      }
    } catch (e) {
      await handle.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    pending.set(path, tmp);
    const entry: Promise<void> = handle
      .sync()
      .finally(() => handle.close())
      .then(
        () => void syncing.delete(entry),
        (error) => {
          syncing.delete(entry);
          syncFailed ??= { error };
        }
      );
    syncing.add(entry);
    while (syncing.size >= FLUSHES_AT_ONCE) await Promise.race(syncing);
  }

  /** Wait for every staged object's flush to settle; the first that failed is thrown. */
  const synced = async () => {
    await Promise.all(syncing);
    const failed = syncFailed;
    syncFailed = null;
    if (failed) throw failed.error;
  };

  async function flush() {
    const batch = [...pending];
    pending.clear();
    const reliedOn = [...reused];
    reused.clear();
    let named = 0;
    try {
      await synced();
      const relied = [...reliedOn];
      for (const [path, tmp] of batch) {
        if (fault) await fault('object-written', path);
        try {
          await renameReplacing(tmp, path);
        } catch (e) {
          // An object is named by its content: one already there as a file (a reader holding it open on Windows) is
          // this one. Anything else under its name is not.
          if (!(await fs.lstat(path).catch(() => null))?.isFile()) throw e;
          await fs.rm(tmp, { force: true });
        }
        named++;
      }
      const now = new Date();
      // Each is still there (a `git gc` meanwhile may have taken it for unused, and then this write cannot rely on it),
      // and one a day old is given the time now.
      await eachAtMost(FLUSHES_AT_ONCE * 4, relied, ([path, mtimeMs]) =>
        (now.getTime() - mtimeMs < FRESHEN_AFTER_MS ? fs.lstat(path) : fs.utimes(path, now, now)).catch((e) => {
          if (isMissing(e)) throw new GitError('changed', 'An object of the versions repository was removed while the version was being saved; save it again.');
          throw e;
        })
      );
      const written = new Set(batch.map(([path]) => dirname(path)));
      const dirs = new Set([...written, ...relied.map(([path]) => dirname(path))]);
      if (dirs.size) {
        await eachAtMost(FLUSHES_AT_ONCE, [...dirs], (dir) => flushDir(dir, written.has(dir)));
        await flushDir(join(gitdir, 'objects'), false);
      }
    } catch (e) {
      await Promise.all(batch.slice(named).map(([, tmp]) => fs.rm(tmp, { force: true }).catch(() => undefined)));
      throw e;
    }
  }

  async function discard() {
    const batch = [...pending.values()];
    pending.clear();
    reused.clear();
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
    reuse: (path, mtimeMs) => void reused.set(path, mtimeMs),
    flush,
    discard,
    reset: () => checked.clear(),
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
      // isomorphic-git asks whether an object is there before writing it, and writes nothing when it is: the write
      // then relies on it, so it is made durable and given the time now at the flush (reuse), and must be a plain file
      // in a folder of the repository's own.
      stat: guarded(async (p: string, o?: unknown) => {
        const objectPath = OBJECT_PATH.test(relative(gitdir, p));
        if (objectPath) await realDir(dirname(p));
        const st = await fs.stat(p, o as Parameters<typeof fs.stat>[1]);
        if (objectPath) {
          const own = await fs.lstat(p);
          if (!own.isFile()) throw new GitError('corrupt', `The versions repository is damaged: ${relative(gitdir, p)} is not a file.`);
          reused.set(p, own.mtimeMs);
        }
        return st;
      }),
      lstat: guarded((p: string, o?: unknown) => fs.lstat(p, o as Parameters<typeof fs.lstat>[1])),
      readdir: guarded(async (p: string, o?: unknown) => {
        await realDir(p);
        return fs.readdir(p, o as Parameters<typeof fs.readdir>[1]);
      }),
      readlink: guarded(noLinks('EINVAL')),
      symlink: guarded(noLinks('EPERM')),
      chmod: guarded((p: string, m: number) => fs.chmod(p, m))
    } satisfies RepoFs['promises']
  };
}
