/**
 * Where a sync's pictures wait between the sync worker fetching them and the library taking them (#1045), so neither
 * process ever holds the whole batch: a private folder for each sync, under a root of the user's own outside every
 * project (userData/source-sync). The worker writes each picture there as it arrives (protocol.ts spoolFile), and the
 * sync reads them back one at a time as it imports them: only a regular file, never through a link, of exactly the
 * size the reply gave, in the very folder made for the sync. A folder is removed when its sync ends, however it ends;
 * one left by a sync that never ended (the app stopped) is removed when the app next starts, and when the next sync
 * does. Nothing is ever removed or read through a link: a root that is one is refused, and only real folders under it
 * are swept.
 */
import { promises as fs, type Stats } from 'node:fs';
import { join } from 'node:path';
import { openRegularFile, readAtMost } from '../regular-file';
import { spoolFile } from './protocol';

export interface Spool {
  /** The folder, empty when it is made: what the sync's request names. */
  readonly dir: string;
  /** Whether the picture at `index` of the reply is there whole: a regular file of `size` bytes. Reads nothing. */
  holds(index: number, size: number): Promise<boolean>;
  /** The bytes of the picture at `index` of the reply, which said it is `size` bytes. Rejects for anything else. */
  read(index: number, size: number): Promise<Buffer>;
  /** Remove the folder and what is in it. Once is enough; it never rejects. */
  release(): Promise<void>;
}

/** The folders of syncs in progress in this process, which no sweep may take. */
const inUse = new Set<string>();

const PREFIX = 'sync-';

const same = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;

/** Remove the folders under `root` that no sync in progress is using. A root that is not a real folder is left alone. */
export async function sweepSpools(root: string): Promise<void> {
  const st = await fs.lstat(root).catch(() => null);
  if (!st?.isDirectory()) return;
  const names = (await fs.readdir(root).catch(() => [] as string[])).filter((name) => name.startsWith(PREFIX) && !inUse.has(join(root, name)));
  await Promise.all(
    names.map(async (name) => {
      const at = join(root, name);
      // Only a folder this module made: a link (to anywhere) is taken away itself, never what it leads to.
      const entry = await fs.lstat(at).catch(() => null);
      if (entry?.isDirectory() || entry?.isSymbolicLink()) await fs.rm(at, { recursive: entry.isDirectory(), force: true, maxRetries: 3 }).catch(() => undefined);
    })
  );
}

/** A new spool under `root`, once the folders earlier syncs left there are gone. */
export async function openSpool(root: string): Promise<Spool> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) throw new Error('the folder for a sync’s pictures is not a folder of the app’s own.');
  await sweepSpools(root);
  // Made for this sync alone, readable by this user alone (mkdtemp's 0700).
  const dir = await fs.mkdtemp(join(root, PREFIX));
  inUse.add(dir);
  const made = await fs.lstat(dir);
  /** The folder is still the one made for this sync, not one put in its place. */
  const intact = async () => {
    const now = await fs.lstat(dir).catch(() => null);
    return !!now?.isDirectory() && same(now, made);
  };
  const valid = (index: number, size: number) => Number.isSafeInteger(index) && index >= 0 && Number.isSafeInteger(size) && size >= 0;
  let released: Promise<void> | null = null;
  return {
    dir,
    async holds(index, size) {
      if (!valid(index, size) || !(await intact())) return false;
      const st = await fs.lstat(join(dir, spoolFile(index))).catch(() => null);
      return !!st?.isFile() && st.size === size;
    },
    async read(index, size) {
      if (!valid(index, size)) throw new Error('there is no such picture.');
      if (!(await intact())) throw new Error('the folder it was kept in has changed.');
      const { handle, stat } = await openRegularFile(join(dir, spoolFile(index)));
      try {
        if (stat.size !== size) throw new Error('it is not the size it was fetched at.');
        const bytes = await readAtMost(handle, size, size);
        if (!bytes || bytes.length !== size) throw new Error('it is not the size it was fetched at.');
        return bytes;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    release() {
      // A folder that will not go (a file the worker still had open on Windows) is swept later.
      released ??= (async () => {
        if (await intact()) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
        inUse.delete(dir);
      })();
      return released;
    }
  };
}
