/**
 * Desktop fonts (#1460): a TrueType or OpenType file chosen for a font is taken, and the library stores the WOFF2 web
 * font made of it; a file that can't be taken says why, instead of calling a font "not a font".
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: { fork: () => ({}) }
}));

const { FONT_EXTENSIONS, importAsset, isAssetOfKind, locateAssetFile, stopMediaWorker } = await import('../../src/main/project/assets');
const { sfntToWoff2, DesktopFontError } = await import('../../src/main/project/woff2');
const { fontInfo } = await import('../../src/main/project/media');

const FIXTURES = join(__dirname, 'fixtures/fonts');
const TTF = readFileSync(join(FIXTURES, 'fixture-sans-bold.ttf'));
const OTF = readFileSync(join(FIXTURES, 'fixture-sans-bold.otf'));

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-desktop-fonts-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
afterAll(() => stopMediaWorker());

const fence = async (write: () => Promise<void>) => (await write(), true);
const write = (name: string, data: Buffer) => {
  const p = join(temp(), name);
  writeFileSync(p, data);
  return p;
};

/** The sfnt tables of a font file, by tag. */
function sfntTables(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let k = 0; k < buf.readUInt16BE(4); k++) {
    const r = 12 + k * 16;
    out.set(buf.toString('latin1', r, r + 4), buf.subarray(buf.readUInt32BE(r + 8), buf.readUInt32BE(r + 8) + buf.readUInt32BE(r + 12)));
  }
  return out;
}

/** The tables a null-transformed WOFF2 file holds, read back by its directory: what a browser's decoder does first. */
function woff2Tables(buf: Buffer): { flavor: number; tags: string[]; tables: Map<string, Buffer>; flags: number[]; totalSfntSize: number } {
  const n = buf.readUInt16BE(12);
  let p = 48;
  const tags: string[] = [];
  const lengths: number[] = [];
  const flags: number[] = [];
  const base128 = () => {
    let v = 0;
    for (;;) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
  };
  const known = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF '];
  for (let k = 0; k < n; k++) {
    const f = buf[p++];
    flags.push(f);
    let tag = known[f & 0x3f];
    if ((f & 0x3f) === 63) {
      tag = buf.toString('latin1', p, p + 4);
      p += 4;
    }
    tags.push(tag);
    lengths.push(base128());
  }
  const data = brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
  const tables = new Map<string, Buffer>();
  let at = 0;
  tags.forEach((t, k) => {
    tables.set(t, data.subarray(at, at + lengths[k]));
    at += lengths[k];
  });
  expect(at).toBe(data.length);
  return { flavor: buf.readUInt32BE(4), tags, tables, flags, totalSfntSize: buf.readUInt32BE(16) };
}

describe('sfntToWoff2', () => {
  it('keeps every table of a TrueType font as it is, glyf and loca null-transformed, in a file of the length it declares', async () => {
    const web = await sfntToWoff2(TTF);
    expect(web.toString('latin1', 0, 4)).toBe('wOF2');
    expect(web.readUInt32BE(8)).toBe(web.length);
    expect(web.length % 4).toBe(0);
    const { flavor, tags, tables, flags, totalSfntSize } = woff2Tables(web);
    expect(flavor).toBe(0x00010000);
    const original = sfntTables(TTF);
    expect(tags).toEqual([...original.keys()].sort());
    for (const [tag, table] of original) expect(tables.get(tag)!.equals(table), tag).toBe(true);
    // Transform version 3 on glyf and loca (their null transform), 0 on the rest.
    tags.forEach((t, k) => expect(flags[k] >> 6, t).toBe(t === 'glyf' || t === 'loca' ? 3 : 0));
    expect(tags.indexOf('loca')).toBeGreaterThan(tags.indexOf('glyf'));
    expect(totalSfntSize).toBe(12 + 16 * tags.length + [...original.values()].reduce((s, t) => s + ((t.length + 3) & ~3), 0));
  });

  it('makes an OpenType (CFF) font a WOFF2 font of that flavour, and the same bytes each time', async () => {
    const web = await sfntToWoff2(OTF);
    expect(woff2Tables(web).flavor).toBe(0x4f54544f);
    expect(woff2Tables(web).tables.get('CFF ')!.equals(sfntTables(OTF).get('CFF ')!)).toBe(true);
    expect((await sfntToWoff2(OTF)).equals(web)).toBe(true);
  });

  it('reads back as the face the desktop file declares', async () => {
    await expect(fontInfo(await sfntToWoff2(TTF))).resolves.toEqual({ family: 'Fixture Sans', weight: '700', style: 'normal', category: 'sans-serif' });
    await expect(fontInfo(await sfntToWoff2(OTF))).resolves.toEqual({ family: 'Fixture Sans', weight: '700', style: 'normal', category: 'sans-serif' });
  });

  it('leaves out a digital signature, which would no longer match', async () => {
    // The fixture with a DSIG table added at the end of its directory.
    const n = TTF.readUInt16BE(4);
    const dsig = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]);
    const head = Buffer.from(TTF.subarray(0, 12));
    head.writeUInt16BE(n + 1, 4);
    const records = Buffer.from(TTF.subarray(12, 12 + n * 16));
    for (let k = 0; k < n; k++) records.writeUInt32BE(records.readUInt32BE(k * 16 + 8) + 16, k * 16 + 8);
    const record = Buffer.alloc(16);
    record.write('DSIG', 0, 'latin1');
    record.writeUInt32BE(TTF.length + 16, 8);
    record.writeUInt32BE(dsig.length, 12);
    const signed = Buffer.concat([head, records, record, TTF.subarray(12 + n * 16), dsig]);
    const { tags } = woff2Tables(await sfntToWoff2(signed));
    expect(tags).not.toContain('DSIG');
    expect(tags).toEqual([...sfntTables(TTF).keys()].sort());
  });

  it('refuses a collection, a file that is no font, and one whose tables run past its end, saying which', async () => {
    const reason = (buf: Buffer) => sfntToWoff2(buf).then(() => '', (e: Error) => (expect(e).toBeInstanceOf(DesktopFontError), e.message));
    expect(await reason(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(40)]))).toMatch(/^it is a font collection/);
    expect(await reason(Buffer.from('just some text, not a font at all'))).toMatch(/^it is not a TrueType or OpenType font, although its name says it is/);
    expect(await reason(Buffer.alloc(0))).toMatch(/^the file is empty/);
    expect(await reason(TTF.subarray(0, 200))).toMatch(/^it is damaged/);
  });
});

describe('adding a TTF or OTF font (#1460)', () => {
  it('is offered by the font chooser and counted as a font', () => {
    expect(FONT_EXTENSIONS).toEqual(expect.arrayContaining(['woff2', 'woff', 'ttf', 'otf']));
    for (const name of ['Brand.ttf', 'Brand.OTF']) {
      expect(isAssetOfKind(name, 'font')).toBe(true);
      expect(isAssetOfKind(name, 'image')).toBe(false);
      expect(isAssetOfKind(name, 'document')).toBe(false);
    }
  });

  it('stores the WOFF2 web font made of the file, named for it, with the face it declares', async () => {
    for (const [name, data] of [['Fixture Sans Bold.ttf', TTF], ['FixtureSans-Bold.otf', OTF]] as const) {
      const project = temp();
      const { record, existing } = await importAsset(project, write(name, data), [], fence);
      expect(existing).toBe(false);
      expect(record).toMatchObject({ kind: 'font', mime: 'font/woff2', originalName: name, font: { family: 'Fixture Sans', weight: '700', style: 'normal' } });
      expect(record.file).toMatch(/^static\/assets\/fixture-?sans-bold-[a-f0-9]{8}\.woff2$/);
      const stored = readFileSync(join(project, record.file));
      expect(stored.equals(await sfntToWoff2(data))).toBe(true);
      expect(record.bytes).toBe(stored.length);
    }
  });

  it('finds the same font already in the library when the same file is added again, and puts its file back from it', async () => {
    const project = temp();
    const source = write('Brand.ttf', TTF);
    const { record } = await importAsset(project, source, [], fence);
    const again = await importAsset(project, source, [record], fence);
    expect(again).toMatchObject({ existing: true, record: { id: record.id } });
    rmSync(join(project, record.file));
    const located = await locateAssetFile(project, record, source, fence);
    expect(located).toEqual({ same: true, written: [record.file], failed: [] });
    expect(existsSync(join(project, record.file))).toBe(true);
  });

  it('names what is wrong with a file it cannot take, never calling it not a font', async () => {
    const refused = (name: string, data: Buffer) => importAsset(temp(), write(name, data), [], fence).then(() => '', (e: Error) => e.message);
    expect(await refused('Brand.ttf', Buffer.from('not really a font'))).toBe('Brand.ttf was not imported because it is not a TrueType or OpenType font, although its name says it is. Choose the font file from the font’s download again.');
    expect(await refused('Family.ttf', Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(40)]))).toMatch(/^Family\.ttf was not imported because it is a font collection/);
  });

  it('takes a web font that was given a desktop font’s name as the web font it is', async () => {
    const web = await sfntToWoff2(TTF);
    const { record } = await importAsset(temp(), write('Renamed.ttf', web), [], fence);
    expect(record).toMatchObject({ mime: 'font/woff2', hash: expect.any(String) });
    expect(record.file).toMatch(/\.woff2$/);
  });
});
