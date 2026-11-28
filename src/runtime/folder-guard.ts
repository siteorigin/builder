/**
 * The project folder going away under the preview's process (#1454). Vite and SvelteKit name every file by its
 * absolute path, and SvelteKit writes its generated files with a recursive mkdir: once the folder has been moved,
 * renamed or deleted, a watcher event (the folder's own files going) would make a folder at the old address again,
 * holding only `.svelte-kit`. So inside this process no folder is made in a project folder that is not there. The
 * editor notices the folder gone on its own (the controller's folder check) and stops the preview.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Mkdir = (path: fs.PathLike, ...rest: unknown[]) => unknown;

/** The path a file system call was given, made absolute, or null for one no folder could be made at. */
function pathOf(p: unknown): string | null {
  try {
    if (typeof p === 'string') return resolve(p);
    if (p instanceof URL) return resolve(fileURLToPath(p));
    if (Buffer.isBuffer(p)) return resolve(p.toString());
  } catch {
    /* not a path */
  }
  return null;
}

/** Whether `path` is `root` or anything inside it (a child named `..cache` included). */
export function within(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

const refusal = (path: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, the project folder is gone: mkdir '${path}'`), { code: 'ENOENT', errno: -2, syscall: 'mkdir', path });

/**
 * From now on, in this process, a folder is never made at or inside `root` once `root` itself has been found missing:
 * the call fails as it would without the recursive option. Like the editor's own session, the guard stays on once
 * the folder has gone, even if a folder appears at that address again. Returns the undo.
 */
export function guardProjectFolder(root: string): () => void {
  const base = resolve(root);
  let gone = false;
  // Gone as the editor's session judges it: not there (a folder it cannot read is not gone).
  const missing = () => {
    try {
      fs.statSync(base);
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
  };
  const refuses = (p: unknown): string | null => {
    const path = pathOf(p);
    if (path === null || !within(base, path)) return null;
    if (!gone && missing()) gone = true;
    return gone ? path : null;
  };
  const sync = fs.mkdirSync as unknown as Mkdir;
  const callback = fs.mkdir as unknown as Mkdir;
  const promised = fs.promises.mkdir as unknown as Mkdir;
  fs.mkdirSync = function (this: unknown, path: fs.PathLike, ...rest: unknown[]) {
    const refused = refuses(path);
    if (refused) throw refusal(refused);
    return sync.call(this, path, ...rest);
  } as typeof fs.mkdirSync;
  fs.mkdir = function (this: unknown, path: fs.PathLike, ...rest: unknown[]) {
    const refused = refuses(path);
    const done = rest.at(-1);
    if (refused && typeof done === 'function') {
      process.nextTick(() => (done as (e: Error) => void)(refusal(refused)));
      return;
    }
    return callback.call(this, path, ...rest);
  } as typeof fs.mkdir;
  fs.promises.mkdir = async function (this: unknown, path: fs.PathLike, ...rest: unknown[]) {
    const refused = refuses(path);
    if (refused) throw refusal(refused);
    return promised.call(this, path, ...rest);
  } as typeof fs.promises.mkdir;
  // Named imports of node:fs and node:fs/promises (`import { mkdirSync } from 'node:fs'`) see the guarded calls too.
  syncBuiltinESMExports();
  return () => {
    fs.mkdirSync = sync as unknown as typeof fs.mkdirSync;
    fs.mkdir = callback as unknown as typeof fs.mkdir;
    fs.promises.mkdir = promised as unknown as typeof fs.promises.mkdir;
    syncBuiltinESMExports();
  };
}
