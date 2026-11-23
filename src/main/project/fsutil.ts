import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, realpathSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Resolve a project-relative path, rejecting traversal and symlink escape. */
export function safeJoin(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('Invalid path.');
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new Error(`Path escapes the project: ${rel}`);
  // Walk up to the nearest existing ancestor and make sure its real path is inside the project.
  let probe = abs;
  while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  const realRoot = realpathSync(root);
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new Error(`Path escapes the project through a link: ${rel}`);
  return abs;
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
export async function atomicWrite(path: string, data: string | Buffer, opts: { mode?: number; durable?: boolean; beforeReplace?: () => Promise<boolean> } = {}): Promise<boolean> {
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
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  if (durable) await syncDir(dir);
  return true;
}

/** Remove a file and flush its folder, so the removal is on disk before anything that depends on it. */
export async function removeDurable(path: string): Promise<void> {
  await fs.rm(path, { force: true });
  await syncDir(dirname(path));
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as T;
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** A file's bytes, for comparing files that may not be text. */
export async function readBytesIfExists(path: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path);
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
