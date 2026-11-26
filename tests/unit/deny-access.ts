import { chmodSync, existsSync, promises as fsp, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * What a test takes away from the current user on a file or folder:
 * - `read`: a file's contents cannot be read; a folder cannot be listed, nor anything in it reached;
 * - `write`: nothing can be added to, removed from or renamed in a folder;
 * - `delete`: nothing directly in a folder can be removed or moved out of it.
 */
export type DeniedAccess = 'read' | 'write' | 'delete';

const POSIX_MODE: Record<DeniedAccess, number> = { read: 0o000, write: 0o500, delete: 0o500 };

/**
 * Take `access` away from the current user on `path`, returning a function that gives it back.
 *
 * On macOS and Linux this is the item's real permissions. Windows has no equivalent a test can rely on: `chmod`
 * there only sets the read-only attribute, which neither stops a read nor protects a folder's contents, and a deny
 * entry in the access control list does not hold for an administrator, whose backup and restore privileges let Node
 * open anything. There the denial is injected instead, failing the app's `fs.promises` calls that need the access
 * as Windows fails them when access is denied (EPERM).
 */
export function denyAccess(path: string, access: DeniedAccess): () => void {
  if (process.platform === 'win32') return injectDenial(path, access);
  const mode = statSync(path).mode & 0o7777;
  chmodSync(path, POSIX_MODE[access]);
  return () => chmodSync(path, mode);
}

/** The `fs.promises` calls that reach a path, by which of their arguments are paths. */
const CALLS: Record<string, number[]> = {
  readFile: [0],
  open: [0],
  readdir: [0],
  opendir: [0],
  stat: [0],
  lstat: [0],
  access: [0],
  realpath: [0],
  readlink: [0],
  writeFile: [0],
  appendFile: [0],
  truncate: [0],
  utimes: [0],
  chmod: [0],
  mkdir: [0],
  mkdtemp: [0],
  copyFile: [0, 1],
  cp: [0, 1],
  symlink: [1],
  link: [0, 1],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  unlink: [0]
};
const REMOVES = new Set(['rm', 'rmdir', 'unlink']);

/** Whether an `open` flag can create the file. */
const creates = (flags: unknown) => (typeof flags === 'number' ? (flags & 0o3) !== 0 : typeof flags === 'string' && /[wa+]/.test(flags));

function injectDenial(target: string, access: DeniedAccess): () => void {
  const at = resolve(target);
  const isFile = statSync(at).isFile();
  const under = (p: string) => p.startsWith(at + sep);
  const directlyIn = (p: string) => dirname(p) === at;
  /** `at`, or a folder that holds it: removing it removes what `at` holds. */
  const holds = (p: string) => p === at || at.startsWith(p + sep);

  const deniedAt = (method: string, index: number, p: string, args: unknown[]): boolean => {
    if (access === 'read') {
      if (!isFile) return under(p) || (p === at && (method === 'readdir' || method === 'opendir'));
      return p === at && (method === 'readFile' || method === 'open' || ((method === 'copyFile' || method === 'cp') && index === 0));
    }
    if (REMOVES.has(method)) return directlyIn(p) || holds(p);
    if (access === 'delete') return method === 'rename' && index === 0 && directlyIn(p);
    // Write: an entry made in the folder, or one renamed into or out of it. Writing to a file already there
    // changes no entry of the folder.
    switch (method) {
      case 'open':
        return creates(args[1]) && directlyIn(p) && !existsSync(p);
      case 'writeFile':
      case 'appendFile':
        return directlyIn(p) && !existsSync(p);
      case 'mkdir':
      case 'mkdtemp': {
        if (directlyIn(p)) return true;
        // A recursive mkdir of a path below makes the first missing folder here.
        return under(p) && !existsSync(join(at, p.slice(at.length + 1).split(sep)[0]));
      }
      case 'rename':
        return directlyIn(p);
      case 'copyFile':
      case 'cp':
      case 'link':
      case 'symlink':
        return index === CALLS[method].at(-1) && directlyIn(p);
      default:
        return false;
    }
  };

  const fs = fsp as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = new Map(Object.keys(CALLS).map((m) => [m, fs[m]]));
  for (const [method, real] of originals) {
    fs[method] = function (this: unknown, ...args: unknown[]) {
      for (const i of CALLS[method]) {
        const arg = args[i];
        if (typeof arg !== 'string' && !Buffer.isBuffer(arg)) continue;
        const p = resolve(String(arg));
        if (deniedAt(method, i, p, args)) return Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, ${method} '${p}'`), { code: 'EPERM', errno: -4048, syscall: method, path: p }));
      }
      return real.apply(this, args);
    };
  }
  return () => {
    for (const [method, real] of originals) fs[method] = real;
  };
}
