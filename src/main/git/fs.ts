/**
 * The file system the bundled Git is given (#1152). Its own writes go straight to the final name, so a worker that
 * stopped part way through would leave a truncated object under the name of a whole one, which it then never
 * rewrites because the name exists. Here every file is written whole to a temporary name beside it, flushed, and
 * renamed into place, and the folder is flushed after it, so an object either is complete and on disk or is not there.
 * Temporary objects are named as Git names its own (`tmp_obj_`), which `git fsck` passes over and `git gc` clears.
 *
 * Nothing is read or written outside the repository's folder, and nothing through a link: a folder of the repository
 * that turns out to be a link (to the project's own `.git/`, say) is refused rather than followed.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { renameReplacing, syncDir } from '../project/fsutil';
import { GitError } from './protocol';

/** Points in a write where a test stops the worker, to see what a crash there leaves. */
export type FaultPoint = 'files-checked' | 'object-written' | 'lock-written' | 'ref-renamed';
export type Fault = (point: FaultPoint, path: string) => void | Promise<void>;

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '');

/**
 * The fs client isomorphic-git takes (an object with an enumerable `promises`), confined to `gitdir`. `fault` is for
 * tests only.
 */
export function repoFs(gitdir: string, fault?: Fault) {
  const inside = (path: string) => {
    const rel = relative(gitdir, path);
    if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel))) return path;
    throw new GitError('invalid', 'The repository tried to reach a file outside its folder.');
  };
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

  async function writeFile(path: string, data: Uint8Array | string, options?: unknown) {
    inside(path);
    const dir = dirname(path);
    await realDir(dir);
    const objects = relative(gitdir, path).split(sep)[0] === 'objects';
    const tmp = join(dir, `${objects ? 'tmp_obj_' : '.tmp-'}${randomBytes(6).toString('hex')}`);
    const mode = typeof options === 'object' && options && 'mode' in options ? (options as { mode?: number }).mode : undefined;
    try {
      const handle = await fs.open(tmp, 'wx', mode ?? 0o666);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (fault) await fault('object-written', path);
      try {
        await renameReplacing(tmp, path);
      } catch (e) {
        // An object is named by its content: one already there (a reader holding it open on Windows) is this one.
        if (!objects || !(await fs.stat(path).catch(() => null))) throw e;
        await fs.rm(tmp, { force: true });
      }
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
    // A folder made for an object is recorded in its parent before the object in it is relied on.
    await syncDir(dirname(path));
  }

  const guarded =
    <A extends unknown[], R>(f: (path: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      inside(path);
      return f(path, ...rest);
    };

  return {
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
      readlink: guarded(async () => {
        throw Object.assign(new Error('The versions repository holds no links.'), { code: 'EINVAL' });
      }),
      symlink: guarded(async () => {
        throw Object.assign(new Error('The versions repository holds no links.'), { code: 'EPERM' });
      }),
      chmod: guarded((p: string, m: number) => fs.chmod(p, m))
    }
  };
}
