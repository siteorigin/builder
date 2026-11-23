/**
 * Media the site cannot use (issue #48): an image file no browser can show is refused at import with its name and
 * a reason, while the good files of the same batch still arrive.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  // No media worker in unit tests: pictures import without their responsive copies.
  utilityProcess: {
    fork: () => {
      throw new Error('no worker in unit tests');
    }
  }
}));

const { importAsset } = await import('../../src/main/project/assets');

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-asset-files-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const photo = (format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif') => {
  const img = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } });
  return (format === 'jpeg' ? img.jpeg() : format === 'png' ? img.png() : format === 'webp' ? img.webp() : format === 'gif' ? img.gif() : img.avif()).toBuffer();
};

/** Write `data` as `name` in a fresh folder and import it into a fresh project. */
async function importFile(name: string, data: Buffer) {
  const src = temp();
  writeFileSync(join(src, name), data);
  return importAsset(temp(), join(src, name), []);
}

describe('importing a picture no browser can show', () => {
  it('refuses an empty file, naming it', async () => {
    await expect(importFile('empty.jpg', Buffer.alloc(0))).rejects.toThrow(/^empty\.jpg .*empty/);
  });

  it('refuses a photo that was cut short', async () => {
    const jpeg = await photo('jpeg');
    await expect(importFile('cut.jpg', jpeg.subarray(0, Math.floor(jpeg.length / 2)))).rejects.toThrow(/^cut\.jpg .*incomplete/);
    const png = await photo('png');
    await expect(importFile('cut.png', png.subarray(0, png.length - 20))).rejects.toThrow(/^cut\.png .*incomplete/);
  });

  it('refuses a file whose contents are not the format its name says', async () => {
    await expect(importFile('notes.png', Buffer.from('just some text, not a picture'))).rejects.toThrow(/^notes\.png .*not a PNG/);
  });

  it('still imports every readable format, including those that get no smaller copies', async () => {
    for (const [name, format] of [['a.jpg', 'jpeg'], ['b.png', 'png'], ['c.webp', 'webp'], ['d.gif', 'gif'], ['e.avif', 'avif']] as const) {
      const { record } = await importFile(name, await photo(format));
      expect(record, name).toMatchObject({ kind: 'image', width: 64, height: 48 });
    }
    const { record } = await importFile('f.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'));
    expect(record).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
  });
});
