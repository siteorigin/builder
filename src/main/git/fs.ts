/**
 * The file system the bundled Git is given (#1152). Its own writes go straight to the final name, so a worker that
 * stopped part way through would leave a truncated object under the name of a whole one, which it then never
 * rewrites because the name exists. Here an object is written whole to a temporary name beside its place (TMP_PREFIX)
 * and flushed to the disk, and only
 * `flush` gives it its name: every object staged since the last flush is renamed into place, and the folders they
 * landed in flushed once each, so an object either is complete and on disk or is not there. Flushing the folders
 * together is what keeps a version of a few hundred pictures quick: a folder flush after every object costs far more
 * than writing the objects.
 *
 * Windows cannot flush a folder (fsutil.ts syncDir): there an object's own flush and NTFS's journal of its rename are
 * what there is, as for every durable write of the app's.
 *
 * Nothing is read or written outside the repository's folder, and nothing through a link: a folder of the repository
 * that turns out to be a link (to the project's own `.git/`, say) is refused rather than followed.
 */
import { randomBytes } from 'node:crypto';
import type { PromiseFsClient } from 'isomorphic-git';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { eachAtMost, renameReplacing, syncDir } from '../project/fsutil';
import { GitError } from './protocol';

/** Points in a write where a test stops the worker, to see what a crash there leaves. */
export type FaultPoint = 'files-checked' | 'file-written' | 'object-written' | 'lock-written' | 'ref-renamed';
export type Fault = (point: FaultPoint, path: string) => void | Promise<void>;

/** Folder flushes run side by side: the disk takes several at once faster than one after another. */
const FLUSHES_AT_ONCE = 4;
/**
 * The start of a temporary object's name: Git's own (`tmp_obj_`, which `git fsck` passes over and `git gc` clears), then
 * the process writing it, so the temporary objects of a writer found stopped can be told from another's (repo.ts).
 */
export const TMP_PREFIX = 'tmp_obj_';

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '');

export interface RepoFs {
  /** The fs client isomorphic-git takes: an object with an enumerable `promises`. */
  promises: PromiseFsClient['promises'];
  /** Write an object's bytes to a temporary name beside `path`; it takes the name at the next flush. */
  stage(path: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  /** Whether an object is staged for `path`. */
  staged(path: string): boolean;
  /** Make every staged object durable and give it its name. */
  flush(): Promise<void>;
  /** Remove every staged object (the write they belong to was refused or cancelled). */
  discard(): Promise<void>;
  /** Whether the last flush failed after naming some objects, whose folders may not be on the disk yet; asking clears it. */
  named(): boolean;
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
  let syncing = new Set<Promise<void>>();
  /** The first flush that failed since the last flush or discard: no more is staged once one has. */
  let syncFailed: { error: unknown } | null = null;
  /** Whether the last flush failed after naming some of its objects. */
  let partly = false;

  async function stage(path: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    inside(path);
    if (syncFailed) throw syncFailed.error;
    if (pending.has(path)) return;
    await objectDir(dirname(path));
    const tmp = join(dirname(path), `${TMP_PREFIX}${process.pid}_${randomBytes(6).toString('hex')}`);
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

  /** Wait for every object's flush to settle; the first that failed is thrown. */
  const synced = async () => {
    await Promise.all(syncing);
    const failed = syncFailed;
    syncFailed = null;
    if (failed) throw failed.error;
  };

  async function flush() {
    const batch = [...pending];
    pending.clear();
    const dirs = [...madeDirs];
    let named = 0;
    partly = false;
    try {
      await synced();
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
      // The folders the objects were named in, and those the new folders were made in: then every one is on the disk.
      await eachAtMost(FLUSHES_AT_ONCE, [...new Set([...batch.map(([path]) => dirname(path)), ...dirs.map((d) => dirname(d))])], syncDir);
      for (const d of dirs) madeDirs.delete(d);
    } catch (e) {
      partly = named > 0;
      await Promise.all(batch.slice(named).map(([, tmp]) => fs.rm(tmp, { force: true }).catch(() => undefined)));
      throw e;
    }
  }

  async function discard() {
    const batch = [...pending.values()];
    pending.clear();
    await synced().catch(() => undefined);
    await Promise.all(batch.map((tmp) => fs.rm(tmp, { force: true }).catch(() => undefined)));
    // Folders made for them are kept, and recorded in their parent now: a later write, perhaps another worker's, may
    // name an object in one without making it.
    const dirs = [...madeDirs];
    madeDirs.clear();
    await eachAtMost(FLUSHES_AT_ONCE, [...new Set(dirs.map((d) => dirname(d)))], syncDir).catch(() => undefined);
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
    named: () => {
      const was = partly;
      partly = false;
      return was;
    },
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
      stat: guarded((p: string, o?: unknown) => fs.stat(p, o as Parameters<typeof fs.stat>[1])),
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
