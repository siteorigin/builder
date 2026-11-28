/**
 * Images pasted into the AI Chat composer with no file of their own (#1410): each paste's pictures are written to a
 * private folder for the importer, refused when they are not pictures the library takes, and removed once released
 * or when the app quits.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PASTED_BATCHES, MAX_PASTED_BYTES, PastedImages, readPasted } from '../../src/main/pasted-images';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const store = () => {
  const root = mkdtempSync(join(tmpdir(), 'so-paste-test-'));
  roots.push(root);
  return { root, pasted: new PastedImages(() => root) };
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('pasted images written for the importer (#1410)', () => {
  it('writes each picture under a name Assets lists, and removes the folder once released', async () => {
    const { root, pasted } = store();
    const one = await pasted.stage([{ type: 'image/png', bytes: png }]);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.paths.map((p) => basename(p))).toEqual(['Pasted image.png']);
    expect(new Uint8Array(readFileSync(one.paths[0]))).toEqual(png);
    if (process.platform !== 'win32') expect(statSync(one.paths[0]).mode & 0o777).toBe(0o600);
    const two = await pasted.stage([{ type: 'image/jpeg', bytes: png }, { type: 'image/webp', bytes: png }]);
    expect(two.ok && two.paths.map((p) => basename(p))).toEqual(['Pasted image 1.jpg', 'Pasted image 2.webp']);
    // Each paste has a folder of its own.
    expect(two.ok && dirname(two.paths[0])).not.toBe(dirname(one.paths[0]));
    await pasted.release(one.batch);
    expect(existsSync(dirname(one.paths[0]))).toBe(false);
    // Released twice, or never staged, is nothing to remove.
    await pasted.release(one.batch);
    await pasted.release('unknown');
    await pasted.release(7);
    expect(readdirSync(root)).toHaveLength(1);
    // Quitting removes what is left at once.
    pasted.removeAll();
    expect(readdirSync(root)).toHaveLength(0);
  });

  it('refuses what is not a picture the library takes, before writing anything', async () => {
    const { root, pasted } = store();
    expect(readPasted([])).toMatch(/no image/);
    expect(readPasted('x')).toMatch(/no image/);
    expect(readPasted([{ type: 'image/png', bytes: 'not bytes' }])).toMatch(/could not be read/);
    expect(readPasted([{ type: 'image/tiff', bytes: png }])).toMatch(/Only PNG, JPEG, GIF, WebP and AVIF/);
    expect(readPasted([{ type: 'image/svg+xml', bytes: png }])).toMatch(/Only PNG/);
    expect(readPasted([{ type: 'image/png', bytes: new Uint8Array() }])).toMatch(/empty/);
    expect(readPasted([{ type: 'image/png', bytes: new Uint8Array(MAX_PASTED_BYTES + 1) }])).toMatch(/larger than 64 MB/);
    expect(readPasted(Array.from({ length: 5 }, () => ({ type: 'image/png', bytes: png })))).toMatch(/at most 4/);
    expect(await pasted.stage([{ type: 'image/tiff', bytes: png }])).toEqual({ ok: false, message: expect.stringMatching(/Only PNG/) });
    expect(readdirSync(root)).toHaveLength(0);
  });

  it('writes no more pastes than a renderer has left unreleased room for', async () => {
    const { root, pasted } = store();
    const staged = [];
    for (let i = 0; i < MAX_PASTED_BATCHES; i++) staged.push(await pasted.stage([{ type: 'image/png', bytes: png }]));
    expect(staged.every((r) => r.ok)).toBe(true);
    expect(await pasted.stage([{ type: 'image/png', bytes: png }])).toEqual({ ok: false, message: expect.stringMatching(/Too many pasted images/) });
    expect(readdirSync(root)).toHaveLength(MAX_PASTED_BATCHES);
    // Released, there is room again.
    if (staged[0].ok) await pasted.release(staged[0].batch);
    expect((await pasted.stage([{ type: 'image/png', bytes: png }])).ok).toBe(true);
  });

  it('keeps a paste an import is reading until it is done, when the editor that would release it goes', async () => {
    const { root, pasted } = store();
    const staged = await pasted.stage([{ type: 'image/png', bytes: png }]);
    const idle = await pasted.stage([{ type: 'image/gif', bytes: png }]);
    if (!staged.ok || !idle.ok) throw new Error('not staged');
    let finish!: () => void;
    let seen = false;
    const importing = pasted.reading(staged.paths, async () => {
      await new Promise<void>((r) => (finish = r));
      seen = existsSync(staged.paths[0]);
    });
    // The editor reloads: the paste no import is reading goes now, the other once its import is done.
    pasted.releaseAll();
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(dirname(idle.paths[0]))).toBe(false);
    expect(existsSync(staged.paths[0])).toBe(true);
    finish();
    await importing;
    expect(seen).toBe(true);
    expect(readdirSync(root)).toHaveLength(0);
  });

  it('counts a paste from the moment it is asked for, and removes one released while it is still being written', async () => {
    const { root, pasted } = store();
    // Every one asked for at once: the cap holds before any folder exists.
    const all = await Promise.all(Array.from({ length: MAX_PASTED_BATCHES + 2 }, () => pasted.stage([{ type: 'image/png', bytes: png }])));
    expect(all.filter((r) => r.ok)).toHaveLength(MAX_PASTED_BATCHES);
    pasted.removeAll();
    // Released while its folder is being made: nothing of it is left, and it is not handed out.
    const writing = pasted.stage([{ type: 'image/png', bytes: png }]);
    pasted.releaseAll();
    expect(await writing).toEqual({ ok: false, message: expect.stringMatching(/reloaded/) });
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(root)).toHaveLength(0);
  });
});
