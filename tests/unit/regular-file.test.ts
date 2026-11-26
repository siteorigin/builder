/**
 * Reading a regular file never through a link, on every platform: Windows has no O_NOFOLLOW and its open follows a
 * link, so these tests open files that way everywhere (the flag dropped) to prove the link is refused regardless.
 */
import { constants as fsConstants, mkdirSync, mkdtempSync, promises as fsp, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readRegularFile } from '../../src/main/packs/files';
import { openRegularFile } from '../../src/main/regular-file';

const scratch = mkdtempSync(join(tmpdir(), 'regular-file-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Opening follows links, as on Windows; the file at `swap.path`, when set, becomes a link just before it is opened. */
function openLikeWindows(swap: { path: string | null; to: string } = { path: null, to: '' }) {
  const open = fsp.open;
  return vi.spyOn(fsp, 'open').mockImplementation(async (p, flags, mode) => {
    if (swap.path && p === swap.path) {
      rmSync(swap.path);
      symlinkSync(swap.to, swap.path);
    }
    return open(p, typeof flags === 'number' ? flags & ~(fsConstants.O_NOFOLLOW ?? 0) : flags, mode);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('reading a regular file', () => {
  it('refuses a link where opening a file follows one, as on Windows, and reads the file it leads to only by its own path', async () => {
    const dir = mkdtempSync(join(scratch, 'link-'));
    writeFileSync(join(dir, 'card.json'), '{"ok":true}');
    symlinkSync(join(dir, 'card.json'), join(dir, 'alias.json'));
    openLikeWindows();
    await expect(readRegularFile(join(dir, 'alias.json'), 1000)).rejects.toThrow('it is a link, not a file.');
    expect((await readRegularFile(join(dir, 'card.json'), 1000)).toString()).toBe('{"ok":true}');
  });

  it('refuses a file swapped for a link between the check and the open', async () => {
    const dir = mkdtempSync(join(scratch, 'swap-'));
    writeFileSync(join(dir, 'card.json'), 'mine');
    writeFileSync(join(dir, 'secret.json'), 'not yours');
    openLikeWindows({ path: join(dir, 'card.json'), to: join(dir, 'secret.json') });
    await expect(readRegularFile(join(dir, 'card.json'), 1000)).rejects.toThrow('it changed while it was being read.');
  });

  it('refuses a folder before opening it, and a file past the limit', async () => {
    const dir = mkdtempSync(join(scratch, 'kinds-'));
    mkdirSync(join(dir, 'folder'));
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(10));
    await expect(openRegularFile(join(dir, 'folder'))).rejects.toThrow('it is not a file.');
    await expect(readRegularFile(join(dir, 'big.bin'), 9)).rejects.toThrow('is larger than expected.');
    expect((await readRegularFile(join(dir, 'big.bin'), 10)).length).toBe(10);
  });
});
