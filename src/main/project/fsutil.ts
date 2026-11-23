import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, realpathSync } from 'node:fs';
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

/** Write via a temporary file and rename, so readers never see a partial file. */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, path);
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
