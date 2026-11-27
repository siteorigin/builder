// Where a sync's pictures wait (#1045, src/main/sources/spool.ts): a private folder per sync, read back only as regular
// files of the size the worker gave in that very folder, removed when the sync ends, and swept when an earlier one
// never ended. Nothing is read or removed through a link.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSpool, sweepSpools } from '../../src/main/sources/spool';
import { spoolFile } from '../../src/main/sources/protocol';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-spool-test-'));
  dirs.push(d);
  return d;
};

describe('a sync’s spool', () => {
  it('is a private folder of its own, read back as whole files of the size given, and gone once released', async () => {
    const root = join(temp(), 'source-sync');
    const spool = await openSpool(root);
    expect(readdirSync(spool.dir)).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(spool.dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(spool.dir, spoolFile(0)), Buffer.from('picture'));
    expect(await spool.holds(0, 7)).toBe(true);
    expect((await spool.read(0, 7)).toString()).toBe('picture');
    // Not the size the worker said, or not there at all.
    expect(await spool.holds(0, 6)).toBe(false);
    await expect(spool.read(0, 6)).rejects.toThrow('not the size');
    expect(await spool.holds(1, 7)).toBe(false);
    await expect(spool.read(1, 7)).rejects.toThrow();
    await expect(spool.read(-1, 7)).rejects.toThrow('no such picture');
    await spool.release();
    await spool.release();
    expect(existsSync(spool.dir)).toBe(false);
  });

  it('never reads through a link, nor from a folder put in place of its own', async () => {
    const root = join(temp(), 'source-sync');
    const outside = join(temp(), 'picture');
    writeFileSync(outside, 'picture');
    const spool = await openSpool(root);
    symlinkSync(outside, join(spool.dir, spoolFile(0)));
    expect(await spool.holds(0, 7)).toBe(false);
    await expect(spool.read(0, 7)).rejects.toThrow('link');
    // The whole folder swapped for another holding the same file.
    const other = join(temp(), 'other');
    mkdirSync(other);
    writeFileSync(join(other, spoolFile(1)), 'picture');
    renameSync(spool.dir, join(temp(), 'moved'));
    renameSync(other, spool.dir);
    expect(await spool.holds(1, 7)).toBe(false);
    await expect(spool.read(1, 7)).rejects.toThrow('changed');
    await spool.release();
    expect(readFileSafe(outside)).toBe('picture');
  });

  it('sweeps what earlier syncs left, never one in progress, and never through a link', async () => {
    const base = temp();
    const root = join(base, 'source-sync');
    mkdirSync(join(root, 'sync-left'), { recursive: true });
    writeFileSync(join(root, 'sync-left', spoolFile(0)), 'old');
    writeFileSync(join(root, 'keep.txt'), 'not a spool');
    // A link named like a spool, leading to a folder elsewhere: the link goes, the folder and its files stay.
    const elsewhere = join(temp(), 'sync-elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'theirs'), 'theirs');
    symlinkSync(elsewhere, join(root, 'sync-link'), 'dir');
    const live = await openSpool(root);
    expect(readdirSync(root).sort()).toEqual(['keep.txt', live.dir.split(/[\\/]/).pop()!].sort());
    expect(readFileSafe(join(elsewhere, 'theirs'))).toBe('theirs');
    // The app starting again (or another sync) leaves the one in progress alone.
    await sweepSpools(root);
    expect(existsSync(live.dir)).toBe(true);
    await live.release();
    mkdirSync(join(root, 'sync-crashed'));
    await sweepSpools(root);
    expect(readdirSync(root)).toEqual(['keep.txt']);
    // A root that does not exist yet is nothing to sweep.
    await expect(sweepSpools(join(base, 'none'))).resolves.toBeUndefined();
  });

  it('refuses a root that is a link, and sweeps nothing through it', async () => {
    const real = join(temp(), 'real');
    mkdirSync(join(real, 'sync-theirs'), { recursive: true });
    const root = join(temp(), 'source-sync');
    symlinkSync(real, root, 'dir');
    await expect(openSpool(root)).rejects.toThrow('not a folder of the app');
    await sweepSpools(root);
    expect(readdirSync(real)).toEqual(['sync-theirs']);
  });
});

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
