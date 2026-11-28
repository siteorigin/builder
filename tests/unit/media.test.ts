import { describe, expect, it } from 'vitest';
import { brotliCompressSync, constants as zlib, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmapLookup, fontCoverage, fontInfo, heifBrands, heifHasAlpha, heifHasImageData, imageInfo, imageProblem, isAnimatedPng } from '../../src/main/project/media';
import { scriptLabels } from '@shared/font-scripts';

const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
const u32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

/** A JPEG header: SOI, optional EXIF orientation, and a baseline frame of the given stored size. */
function jpeg(width: number, height: number, orientation?: number): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.concat([Buffer.from('II*\0', 'binary'), Buffer.from([8, 0, 0, 0]), Buffer.from([1, 0]), Buffer.from([0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0]), Buffer.alloc(4)]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    parts.push(Buffer.from([0xff, 0xe1]), u16(payload.length + 2), payload);
  }
  parts.push(Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(height), u16(width), Buffer.alloc(10));
  return Buffer.concat(parts);
}

const box = (type: string, ...body: Buffer[]) => {
  const b = Buffer.concat(body);
  return Buffer.concat([u32(b.length + 8), Buffer.from(type, 'ascii'), b]);
};
const full = (type: string, ...body: Buffer[]) => box(type, Buffer.alloc(4), ...body);

/** An AVIF whose primary item (1) has a 1200x800 extent, with a 200x100 thumbnail item (2) listed first. */
function avif(rotate = 0): Buffer {
  const props = [full('ispe', u32(200), u32(100)), full('ispe', u32(1200), u32(800)), ...(rotate ? [box('irot', Buffer.from([rotate]))] : [])];
  const assoc = (item: number, idx: number[]) => Buffer.concat([u16(item), Buffer.from([idx.length]), Buffer.from(idx)]);
  const ipma = full('ipma', u32(2), assoc(2, [1]), assoc(1, rotate ? [2, 3] : [2]));
  return Buffer.concat([box('ftyp', Buffer.from('avifmif1', 'ascii')), full('meta', full('pitm', u16(1)), box('iprp', box('ipco', ...props), ipma))]);
}

describe('whether an AVIF holds image data (#1459)', () => {
  it('finds it in a media data box of any size form, or inside the metadata, and not in a file cut before it', () => {
    const data = Buffer.from([1, 2, 3, 4]);
    expect(heifHasImageData(avif())).toBe(false);
    expect(imageProblem(avif(), 'image/avif')).toBeNull();
    expect(heifHasImageData(Buffer.concat([avif(), box('mdat', data)]))).toBe(true);
    expect(heifHasImageData(Buffer.concat([avif(), box('mdat')]))).toBe(false);
    // Size 0: to the end of the file; size 1: a 64-bit size after the type.
    expect(heifHasImageData(Buffer.concat([avif(), u32(0), Buffer.from('mdat', 'ascii'), data]))).toBe(true);
    expect(heifHasImageData(Buffer.concat([avif(), u32(1), Buffer.from('mdat', 'ascii'), u32(0), u32(20), data]))).toBe(true);
    const withIdat = Buffer.concat([box('ftyp', Buffer.from('avifmif1', 'ascii')), full('meta', full('pitm', u16(1)), box('idat', data))]);
    expect(heifHasImageData(withIdat)).toBe(true);
    expect(heifHasImageData(Buffer.concat([box('ftyp', Buffer.from('avifmif1', 'ascii')), full('meta', full('pitm', u16(1)), box('idat'))]))).toBe(false);
  });
});

describe('image dimensions', () => {
  it('reports a JPEG as displayed, turning it by its EXIF orientation', () => {
    expect(imageInfo(jpeg(4000, 3000), 'image/jpeg')).toEqual({ width: 4000, height: 3000, orientation: 1 });
    expect(imageInfo(jpeg(4000, 3000, 6), 'image/jpeg')).toEqual({ width: 3000, height: 4000, orientation: 6 });
    expect(imageInfo(jpeg(4000, 3000, 3), 'image/jpeg')).toEqual({ width: 4000, height: 3000, orientation: 3 });
  });

  it('reads the primary AVIF item’s extent, not a thumbnail’s, and applies its rotation', () => {
    expect(imageInfo(avif(), 'image/avif')).toMatchObject({ width: 1200, height: 800 });
    expect(imageInfo(avif(1), 'image/avif')).toMatchObject({ width: 800, height: 1200 });
    // HEIC shares the container: its primary item is read the same way, a thumbnail first or not.
    const heic = Buffer.from(avif(1));
    heic.write('heic', 8, 'ascii');
    expect(imageInfo(heic, 'image/heic')).toMatchObject({ width: 800, height: 1200 });
    expect(heifBrands(heic)).toEqual(['heic']);
    const photo = readFileSync(join(import.meta.dirname, 'fixtures/portrait-rotated.heic'));
    expect(imageInfo(photo, 'image/heic')).toMatchObject({ width: 1200, height: 1600 });
    expect(heifBrands(photo).slice(0, 2)).toEqual(['heic', 'mif1']);
    expect([heifHasAlpha(photo), imageProblem(photo, 'image/heic'), imageProblem(photo.subarray(0, photo.length - 10), 'image/heic')]).toEqual([false, null, 'incomplete']);
    const withAlpha = Buffer.concat([box('ftyp', Buffer.from('heic\0\0\0\0mif1', 'latin1')), full('meta', box('auxC', Buffer.from('\0\0\0\0urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0', 'latin1')))]);
    expect(heifHasAlpha(withAlpha)).toBe(true);
    // HEVC names its alpha plane by an older URN.
    expect(heifHasAlpha(Buffer.concat([box('ftyp', Buffer.from('heic\0\0\0\0mif1', 'latin1')), full('meta', box('auxC', Buffer.from('\0\0\0\0urn:mpeg:hevc:2015:auxid:1\0', 'latin1')))]))).toBe(true);
  });

  it('turns a PNG by the orientation in its eXIf chunk', async () => {
    const sharp = (await import('sharp')).default;
    const turned = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#c00' } }).withMetadata({ orientation: 6 }).png().toBuffer();
    expect(imageInfo(turned, 'image/png')).toEqual({ width: 600, height: 1200, orientation: 6 });
    const plain = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#c00' } }).png().toBuffer();
    expect(imageInfo(plain, 'image/png')).toEqual({ width: 1200, height: 600, orientation: 1 });
  });

  it('reads past fill bytes and damaged EXIF to the frame header', () => {
    const j = jpeg(800, 600);
    const padded = Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0xff, 0xff]), j.subarray(2)]);
    expect(imageInfo(padded, 'image/jpeg')).toMatchObject({ width: 800, height: 600 });
    const brokenExif = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), u16(10), Buffer.from('Exif\0\0II', 'binary'), jpeg(800, 600).subarray(2)]);
    expect(imageInfo(brokenExif, 'image/jpeg')).toEqual({ width: 800, height: 600, orientation: 1 });
  });

  it('trusts a header only behind its format’s signature', () => {
    const fake = Buffer.alloc(32);
    fake.writeUInt32BE(0x49484452, 12);
    fake.writeUInt32BE(10, 16);
    fake.writeUInt32BE(10, 20);
    expect(imageInfo(fake, 'image/png')).toBeNull();
    expect(imageInfo(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), fake.subarray(8)]), 'image/png')).toMatchObject({ width: 10, height: 10 });
    expect(imageInfo(Buffer.from('NOTAGIF12345'), 'image/gif')).toBeNull();
    expect(imageInfo(jpeg(10, 10).subarray(1), 'image/jpeg')).toBeNull();
  });

  it('refuses a truncated AVIF primary-item box', () => {
    const cut = Buffer.concat([box('ftyp', Buffer.from('avifmif1', 'ascii')), full('meta', box('pitm', Buffer.alloc(4)), box('iprp', box('ipco', full('ispe', u32(9), u32(9))), full('ipma', u32(1), Buffer.concat([u16(0), Buffer.from([1, 1])]))))]);
    expect(imageInfo(cut, 'image/avif')).toBeNull();
  });

  it('never takes an AVIF size from another item or past a box end', () => {
    const noPrimaryAssoc = Buffer.concat([
      box('ftyp', Buffer.from('avifmif1', 'ascii')),
      full('meta', full('pitm', u16(1)), box('iprp', box('ipco', full('ispe', u32(200), u32(100))), full('ipma', u32(1), Buffer.concat([u16(2), Buffer.from([1, 1])]))))
    ]);
    expect(imageInfo(noPrimaryAssoc, 'image/avif')).toBeNull();
    // An empty irot box must not read the next box's bytes as a rotation.
    const emptyIrot = Buffer.concat([
      box('ftyp', Buffer.from('avifmif1', 'ascii')),
      full('meta', full('pitm', u16(1)), box('iprp', box('ipco', full('ispe', u32(1200), u32(800)), box('irot'), box('pixi', Buffer.from([1]))), full('ipma', u32(1), Buffer.concat([u16(1), Buffer.from([2, 1, 2])]))))
    ]);
    expect(imageInfo(emptyIrot, 'image/avif')).toMatchObject({ width: 1200, height: 800 });
  });
});

/** sfnt tables a font's metadata comes from. */
function nameTable(family: string, more: Record<number, string> = {}): Buffer {
  const names = [[1, family] as const, ...Object.entries(more).map(([id, v]) => [Number(id), v] as const)];
  const strings = names.map(([, v]) => Buffer.from(v, 'utf16le').swap16());
  let at = 0;
  const records = names.map(([id], k) => {
    const r = Buffer.concat([u16(3), u16(1), u16(0x409), u16(id), u16(strings[k].length), u16(at)]);
    at += strings[k].length;
    return r;
  });
  return Buffer.concat([u16(0), u16(names.length), u16(6 + names.length * 12), ...records, ...strings]);
}
function os2Table(weight: number, italic: boolean): Buffer {
  const t = Buffer.alloc(78);
  t.writeUInt16BE(weight, 4);
  t.writeUInt16BE(italic ? 1 : 0x40, 62);
  return t;
}
function fvarTable(min: number, max: number): Buffer {
  const t = Buffer.alloc(16 + 20);
  t.writeUInt16BE(1, 0);
  t.writeUInt16BE(16, 4);
  t.writeUInt16BE(1, 8);
  t.writeUInt16BE(20, 10);
  t.write('wght', 16, 'ascii');
  t.writeInt32BE(min * 65536, 20);
  t.writeInt32BE(400 * 65536, 24);
  t.writeInt32BE(max * 65536, 28);
  return t;
}

function woff(tables: Array<[string, Buffer]>): Buffer {
  const header = Buffer.alloc(44);
  header.write('wOFF', 0, 'ascii');
  header.writeUInt16BE(tables.length, 12);
  let offset = 44 + tables.length * 20;
  const dir: Buffer[] = [];
  const data: Buffer[] = [];
  for (const [tag, raw] of tables) {
    const deflated = deflateSync(raw);
    // WOFF stores a table uncompressed when compressing it would not make it smaller.
    const packed = deflated.length < raw.length ? deflated : raw;
    const e = Buffer.alloc(20);
    e.write(tag, 0, 'ascii');
    e.writeUInt32BE(offset, 4);
    e.writeUInt32BE(packed.length, 8);
    e.writeUInt32BE(raw.length, 12);
    dir.push(e);
    data.push(packed);
    offset += packed.length;
  }
  return Buffer.concat([header, ...dir, ...data]);
}

/** WOFF2's UIntBase128: seven bits a byte, most significant first, the high bit set on all but the last. */
function base128(n: number): number[] {
  const out = [n & 127];
  for (let rest = Math.floor(n / 128); rest > 0; rest = Math.floor(rest / 128)) out.unshift(0x80 | (rest & 127));
  return out;
}

function woff2(tables: Array<[number, Buffer]>): Buffer {
  const dir = Buffer.concat(tables.map(([index, raw]) => Buffer.from([index, ...base128(raw.length)])));
  // Quality 1: the fixtures only need a valid stream, and the default (11) takes seconds on the bomb's 70 MB.
  const packed = brotliCompressSync(Buffer.concat(tables.map(([, raw]) => raw)), { params: { [zlib.BROTLI_PARAM_QUALITY]: 1 } });
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'ascii');
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(packed.length, 20);
  return Buffer.concat([header, dir, packed]);
}

describe('web font metadata', async () => {
  it('reads family, weight and style from a WOFF font', async () => {
    await expect(fontInfo(woff([['name', nameTable('Brand Sans')], ['OS/2', os2Table(700, true)]]))).resolves.toEqual({ family: 'Brand Sans', weight: '700', style: 'italic' });
  });

  it('reads a variable WOFF2 font’s weight range', async () => {
    // Table indexes from the WOFF2 known-tag list: name 5, OS/2 6, fvar 47.
    await expect(fontInfo(woff2([[5, nameTable('Brand Serif')], [6, os2Table(400, false)], [47, fvarTable(100, 900)]]))).resolves.toEqual({ family: 'Brand Serif', weight: '100 900', style: 'normal' });
  });

  it('refuses files that are not web fonts or do not name a family', async () => {
    await expect(fontInfo(Buffer.from('OTTO not a web font'))).rejects.toThrow(/WOFF/);
    await expect(fontInfo(woff([['OS/2', os2Table(400, false)]]))).rejects.toThrow(/family/);
  });

  it('refuses decompression bombs, collections and damaged files with a readable reason', async () => {
    // A WOFF table claiming far more than a metadata table can be.
    const big = Buffer.alloc(8 * 1024 * 1024);
    await expect(fontInfo(woff([['name', big]]))).rejects.toThrow(/damaged/);
    // A WOFF2 stream that unpacks past the budget is stopped by the output limit, not read to the end.
    await expect(fontInfo(woff2([[5, Buffer.alloc(70 * 1024 * 1024)]]))).rejects.toThrow(/too large/);
    // A real font's tables fit well within it: a 3 MB layout table (GSUB, index 28) reads fine.
    await expect(fontInfo(woff2([[5, nameTable('Brand')], [6, os2Table(400, false)], [28, Buffer.alloc(3 * 1024 * 1024)]]))).resolves.toMatchObject({ family: 'Brand' });
    const collection = woff2([[5, nameTable('X')]]);
    collection.write('ttcf', 4, 'latin1');
    await expect(fontInfo(collection)).rejects.toThrow(/collection/);
    const good = woff2([[5, nameTable('Brand')], [6, os2Table(400, false)]]);
    for (const cut of [10, 40, 52, good.length - 3]) await expect(fontInfo(good.subarray(0, cut))).rejects.toThrow(/damaged/);
    // A name table whose record points past its end is damaged, not a crash with a raw Node error.
    const badName = nameTable('Brand');
    badName.writeUInt16BE(0xfff0, 16);
    await expect(fontInfo(woff([['name', badName]]))).rejects.toThrow(/damaged|family/);
  });

  it('offers the family a legacy-named static font is a weight or style of, when its own weight and slant agree (#1469)', async () => {
    const info = (family: string, weight: number, italic = false, more: Record<number, string> = {}) => fontInfo(woff2([[5, nameTable(family, { 2: 'Regular', ...more })], [6, os2Table(weight, italic)]]));
    // The family stays as the file names it; the importer decides whether it joins another.
    await expect(info('IBM Plex Mono Medium', 500)).resolves.toEqual({ family: 'IBM Plex Mono Medium', weight: '500', style: 'normal', joins: ['IBM Plex Mono'] });
    await expect(info('Source Code Pro Semi Bold', 600)).resolves.toMatchObject({ joins: ['Source Code Pro'] });
    await expect(info('Brand ExtraLight', 200)).resolves.toMatchObject({ joins: ['Brand'] });
    // Older fonts give Thin and Extra Light the weights 250 and 275, which Windows once needed.
    await expect(info('Brand Thin', 250)).resolves.toMatchObject({ weight: '250', joins: ['Brand'] });
    await expect(info('Brand Extra-Light', 275)).resolves.toMatchObject({ joins: ['Brand'] });
    await expect(info('Brand Light Italic', 300, true)).resolves.toMatchObject({ family: 'Brand Light Italic', style: 'italic', joins: ['Brand', 'Brand Light'] });
    await expect(info('Brand Italic', 400, true)).resolves.toMatchObject({ joins: ['Brand'] });
    // A word the font's own weight or slant does not bear out is part of its name: Archivo Black is a regular weight.
    for (const [family, weight, italic] of [['Archivo Black', 400, false], ['Brand Italic', 400, false], ['Brand Bold', 400, false], ['Roboto Condensed', 400, false], ['Medium', 500, false], ['Brand Medium', 450, false], ['Brand Thin', 300, false], ['Gotham Book', 400, false], ['Brand Regular', 400, false], ['Brand Normal', 400, false]] as const) {
      expect(await info(family, weight, italic)).not.toHaveProperty('joins');
    }
    // A typographic family (name ID 16) is already the whole family.
    await expect(info('Source Serif 4 Black', 900, false, { 16: 'Source Serif 4' })).resolves.toEqual({ family: 'Source Serif 4', weight: '900', style: 'normal' });
    // A font with no OS/2 table has no weight of its own to bear the word out.
    expect(await fontInfo(woff2([[5, nameTable('Brand Italic', { 2: 'Italic' })]]))).not.toHaveProperty('joins');
    // A variable font holds every weight, so a word in its name says nothing about one.
    expect(await fontInfo(woff2([[5, nameTable('Brand Medium')], [6, os2Table(500, false)], [47, fvarTable(100, 900)]]))).not.toHaveProperty('joins');
    // Even one whose weight axis is a single weight: its other axes (slant, width) still vary.
    expect(await fontInfo(woff2([[5, nameTable('Brand Medium')], [6, os2Table(500, false)], [47, fvarTable(500, 500)]]))).toMatchObject({ weight: '500' });
    expect(await fontInfo(woff2([[5, nameTable('Brand Medium')], [6, os2Table(500, false)], [47, fvarTable(500, 500)]]))).not.toHaveProperty('joins');
    // A weight class of 0 is no weight, though it is read as 400.
    expect(await fontInfo(woff2([[5, nameTable('Brand Light')], [6, os2Table(0, false)]]))).not.toHaveProperty('joins');
  });

  it('keeps only characters that are safe in a CSS family name', async () => {
    await expect(fontInfo(woff([['name', nameTable("Evil'; } body{x")]]))).resolves.toMatchObject({ family: 'Evil bodyx' });
  });
});

/** A cmap table holding the given subtables, each under (platform, encoding). */
function cmapTable(subtables: Array<[number, number, Buffer]>): Buffer {
  let offset = 4 + subtables.length * 8;
  const records: Buffer[] = [];
  for (const [platform, encoding, t] of subtables) {
    records.push(Buffer.concat([u16(platform), u16(encoding), u32(offset)]));
    offset += t.length;
  }
  return Buffer.concat([u16(0), u16(subtables.length), ...records, ...subtables.map(([, , t]) => t)]);
}
/** Format 4: each segment maps by `delta`, or through its own `glyphs` (a 0 there is a missing character). */
function cmap4(segments: Array<{ start: number; end: number; delta?: number; glyphs?: number[] }>): Buffer {
  const all = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
  const n = all.length;
  const glyphArray: number[] = [];
  const rangeOffsets = all.map((seg, i) => {
    if (!seg.glyphs) return 0;
    const at = (n - i) * 2 + glyphArray.length * 2;
    glyphArray.push(...seg.glyphs);
    return at;
  });
  const body = Buffer.concat([
    ...all.map((x) => u16(x.end)),
    u16(0),
    ...all.map((x) => u16(x.start)),
    ...all.map((x) => u16((x.delta ?? 0) & 0xffff)),
    ...rangeOffsets.map(u16),
    ...glyphArray.map(u16)
  ]);
  return Buffer.concat([u16(4), u16(14 + body.length), u16(0), u16(n * 2), u16(0), u16(0), u16(0), body]);
}
/** Format 12: groups of consecutive code points mapped to consecutive glyphs. */
function cmap12(groups: Array<[number, number, number]>): Buffer {
  const body = Buffer.concat(groups.map(([a, b, g]) => Buffer.concat([u32(a), u32(b), u32(g)])));
  return Buffer.concat([u16(12), u16(0), u32(16 + body.length), u32(0), u32(groups.length), body]);
}

describe('web font character coverage', () => {
  const lora = (file: string) => readFileSync(join(__dirname, '../../node_modules/@fontsource-variable/lora/files', file));

  it('reads format 4, honouring glyph-array holes and a delta that lands on no glyph', async () => {
    const cmap = cmapTable([[3, 1, cmap4([{ start: 0x21, end: 0x21, delta: 0x10000 - 0x21 }, { start: 0x41, end: 0x5a, delta: 3 }, { start: 0x61, end: 0x63, glyphs: [40, 0, 42] }])]]);
    const has = cmapLookup(cmap)!;
    expect(['!', 'A', 'Z', 'a', 'b', 'c', 'd'].map((c) => has(c.codePointAt(0)!))).toEqual([false, true, true, true, false, true, false]);
    // Capitals alone are no alphabet: the file is shown in characters it has.
    const font = woff([['name', nameTable('Brand Caps')], ['OS/2', os2Table(400, false)], ['cmap', cmap]]);
    await expect(fontCoverage(font)).resolves.toEqual({ scripts: [], sample: 'A B C D E F G H' });
    await expect(fontInfo(font)).resolves.toEqual({ family: 'Brand Caps', weight: '400', style: 'normal' });
  });

  it('reads format 12 in a WOFF2 font, beyond the Basic Multilingual Plane', async () => {
    const cmap = cmapTable([[3, 10, cmap12([[0x30, 0x31, 0], [0x410, 0x44f, 1], [0x1f600, 0x1f600, 70]])]]);
    expect(cmapLookup(cmap)!(0x1f600)).toBe(true);
    expect(cmapLookup(cmap)!(0x1f601)).toBe(false);
    // A group starting at glyph 0 maps its first code point to no glyph, and the next to glyph 1.
    expect([0x30, 0x31, 0x32].map(cmapLookup(cmap)!)).toEqual([false, true, false]);
    await expect(fontCoverage(woff2([[0, cmap], [5, nameTable('Brand Cyr')], [6, os2Table(400, false)]]))).resolves.toEqual({ scripts: ['cyrillic'], sample: 'Аа Бб Жж' });
  });

  it('never refuses a font over a character map it cannot read', async () => {
    const broken = cmapTable([[3, 1, cmap4([{ start: 0x41, end: 0x5a, delta: 3 }])]]);
    broken.writeUInt32BE(0xfff0, 8);
    const font = woff([['name', nameTable('Brand')], ['OS/2', os2Table(700, false)], ['cmap', broken]]);
    await expect(fontInfo(font)).resolves.toEqual({ family: 'Brand', weight: '700', style: 'normal' });
    await expect(fontCoverage(font)).resolves.toBeNull();
    // Nor over one that will not unpack, or one only a Mac subtable describes.
    const packed = woff([['name', nameTable('Brand')], ['cmap', Buffer.alloc(400)]]);
    // Its directory entry (the second) claims twice the size it unpacks to.
    packed.writeUInt32BE(800, 44 + 20 + 12);
    await expect(fontInfo(packed)).resolves.toMatchObject({ family: 'Brand' });
    await expect(fontCoverage(woff([['name', nameTable('Brand')], ['cmap', cmapTable([[1, 0, cmap4([{ start: 0x41, end: 0x5a, delta: 3 }])]])]]))).resolves.toBeNull();
    await expect(fontCoverage(woff([['name', nameTable('Brand')]]))).resolves.toBeNull();
    // A compressed character map whose data is garbage.
    const garbled = woff([['name', nameTable('Brand')], ['cmap', Buffer.alloc(400)]]);
    garbled.fill(0xff, garbled.length - 8);
    await expect(fontInfo(garbled)).resolves.toMatchObject({ family: 'Brand' });
    await expect(fontCoverage(garbled)).resolves.toBeNull();
    // A WOFF2 font that lists its character map twice keeps the first.
    const latin = cmapTable([[3, 1, cmap4([{ start: 0x41, end: 0x5a, delta: 3 }, { start: 0x61, end: 0x7a, delta: 3 }])]]);
    const twice = woff2([[5, nameTable('Brand')], [0, latin], [0, cmapTable([[3, 1, cmap4([{ start: 0x410, end: 0x44f, delta: 3 }])]])]]);
    await expect(fontInfo(twice)).resolves.toMatchObject({ family: 'Brand' });
    await expect(fontCoverage(twice)).resolves.toMatchObject({ scripts: ['latin'] });
  });

  it('reads every Unicode subtable, and shows a file only in letters it has', async () => {
    // Latin through the Windows subtable, Cyrillic only through the Unicode-platform one.
    const both = cmapTable([
      [0, 3, cmap4([{ start: 0x410, end: 0x44f, delta: 100 }])],
      [3, 1, cmap4([{ start: 0x41, end: 0x5a, delta: 3 }, { start: 0x61, end: 0x7a, delta: 3 }])]
    ]);
    await expect(fontCoverage(woff([['name', nameTable('Brand')], ['cmap', both]]))).resolves.toEqual({ scripts: ['latin', 'cyrillic'], sample: 'Aa Gg Rr' });
    // Most of Latin, but not A, G or R: its sample is drawn from letters it does have.
    const gaps = cmapTable([[3, 1, cmap4([{ start: 0x42, end: 0x46, delta: 3 }, { start: 0x48, end: 0x51, delta: 3 }, { start: 0x53, end: 0x5a, delta: 3 }, { start: 0x61, end: 0x7a, delta: 3 }])]]);
    await expect(fontCoverage(woff([['name', nameTable('Brand')], ['cmap', gaps]]))).resolves.toEqual({ scripts: ['latin'], sample: 'B C D E F H' });
  });

  it('tells apart the files of one face split by alphabet, as web fonts often are', async () => {
    const cases: Array<[string, string[]]> = [
      ['lora-latin-wght-normal.woff2', ['Latin']],
      ['lora-latin-wght-italic.woff2', ['Latin']],
      ['lora-cyrillic-wght-normal.woff2', ['Cyrillic']],
      ['lora-latin-ext-wght-normal.woff2', ['Latin Extended']],
      ['lora-vietnamese-wght-normal.woff2', ['Vietnamese']]
    ];
    for (const [file, labels] of cases) expect(scriptLabels((await fontCoverage(lora(file)))?.scripts), file).toEqual(labels);
    // The two upright files declare the same face: only what they cover tells them apart.
    await expect(fontInfo(lora('lora-cyrillic-wght-normal.woff2'))).resolves.toEqual({ family: 'Lora', weight: '400 700', style: 'normal' });
    await expect(fontInfo(lora('lora-latin-wght-normal.woff2'))).resolves.toEqual({ family: 'Lora', weight: '400 700', style: 'normal' });
    await expect(fontInfo(lora('lora-latin-wght-italic.woff2'))).resolves.toEqual({ family: 'Lora', weight: '400 700', style: 'italic' });
  });
});

describe('animated PNG detection', () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Chunk checksums are not read, so a zeroed one is enough here.
  const chunk = (type: string, len = 0) => Buffer.concat([u32(len), Buffer.from(type, 'ascii'), Buffer.alloc(len), u32(0)]);

  it('is true when an animation control chunk comes before the image data', () => {
    expect(isAnimatedPng(Buffer.concat([sig, chunk('IHDR', 13), chunk('acTL', 8), chunk('IDAT', 4), chunk('IEND')]))).toBe(true);
    expect(isAnimatedPng(Buffer.concat([sig, chunk('IHDR', 13), chunk('tEXt', 5), chunk('pHYs', 9), chunk('acTL', 8), chunk('IDAT', 4)]))).toBe(true);
    // A malformed one still counts: a browser may skip it and play the next, and a wrong call only costs the copies.
    expect(isAnimatedPng(Buffer.concat([sig, chunk('IHDR', 13), chunk('acTL', 4), chunk('acTL', 8), chunk('IDAT', 4)]))).toBe(true);
  });

  it('is false for a still PNG, an acTL after the image data, and anything that is not a PNG', () => {
    expect(isAnimatedPng(Buffer.concat([sig, chunk('IHDR', 13), chunk('IDAT', 4), chunk('IEND')]))).toBe(false);
    expect(isAnimatedPng(Buffer.concat([sig, chunk('IHDR', 13), chunk('IDAT', 4), chunk('acTL', 8), chunk('IEND')]))).toBe(false);
    expect(isAnimatedPng(jpeg(10, 10))).toBe(false);
    expect(isAnimatedPng(Buffer.alloc(0))).toBe(false);
  });

  it('does not throw on truncated or lying chunks', () => {
    expect(isAnimatedPng(Buffer.concat([sig, chunk('IHDR', 13)]).subarray(0, 25))).toBe(false);
    expect(isAnimatedPng(Buffer.concat([sig, u32(0xfffffff0), Buffer.from('tEXt', 'ascii')]))).toBe(false);
    expect(isAnimatedPng(sig)).toBe(false);
  });
});
