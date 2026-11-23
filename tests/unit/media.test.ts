import { describe, expect, it } from 'vitest';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { fontInfo, imageInfo, orientPixels } from '../../src/main/project/media';

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

describe('image dimensions', () => {
  it('reports a JPEG as displayed, turning it by its EXIF orientation', () => {
    expect(imageInfo(jpeg(4000, 3000), 'image/jpeg')).toEqual({ width: 4000, height: 3000, orientation: 1 });
    expect(imageInfo(jpeg(4000, 3000, 6), 'image/jpeg')).toEqual({ width: 3000, height: 4000, orientation: 6 });
    expect(imageInfo(jpeg(4000, 3000, 3), 'image/jpeg')).toEqual({ width: 4000, height: 3000, orientation: 3 });
  });

  it('reads the primary AVIF item’s extent, not a thumbnail’s, and applies its rotation', () => {
    expect(imageInfo(avif(), 'image/avif')).toMatchObject({ width: 1200, height: 800 });
    expect(imageInfo(avif(1), 'image/avif')).toMatchObject({ width: 800, height: 1200 });
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

  it('turns pixels the way EXIF orientations describe', () => {
    // 2x1 image: red, green. Orientation 6 (rotate 90° clockwise) gives a 1x2 image: red on top.
    const px = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
    const six = orientPixels(px, 2, 1, 6);
    expect([six.width, six.height]).toEqual([1, 2]);
    expect([...six.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const eight = orientPixels(px, 2, 1, 8);
    expect([...eight.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    const mirrored = orientPixels(px, 2, 1, 2);
    expect([...mirrored.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    expect(orientPixels(px, 2, 1, 1).data).toBe(px);
  });
});

/** sfnt tables a font's metadata comes from. */
function nameTable(family: string): Buffer {
  const s = Buffer.from(family, 'utf16le').swap16();
  return Buffer.concat([u16(0), u16(1), u16(18), u16(3), u16(1), u16(0x409), u16(1), u16(s.length), u16(0), s]);
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

function woff2(tables: Array<[number, Buffer]>): Buffer {
  const dir = Buffer.concat(tables.map(([index, raw]) => Buffer.from([index, ...(raw.length < 128 ? [raw.length] : [0x80 | (raw.length >> 7), raw.length & 127])])));
  const packed = brotliCompressSync(Buffer.concat(tables.map(([, raw]) => raw)));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'ascii');
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(packed.length, 20);
  return Buffer.concat([header, dir, packed]);
}

describe('web font metadata', () => {
  it('reads family, weight and style from a WOFF font', () => {
    expect(fontInfo(woff([['name', nameTable('Brand Sans')], ['OS/2', os2Table(700, true)]]))).toEqual({ family: 'Brand Sans', weight: '700', style: 'italic' });
  });

  it('reads a variable WOFF2 font’s weight range', () => {
    // Table indexes from the WOFF2 known-tag list: name 5, OS/2 6, fvar 47.
    expect(fontInfo(woff2([[5, nameTable('Brand Serif')], [6, os2Table(400, false)], [47, fvarTable(100, 900)]]))).toEqual({ family: 'Brand Serif', weight: '100 900', style: 'normal' });
  });

  it('refuses files that are not web fonts or do not name a family', () => {
    expect(() => fontInfo(Buffer.from('OTTO not a web font'))).toThrow(/WOFF/);
    expect(() => fontInfo(woff([['OS/2', os2Table(400, false)]]))).toThrow(/family/);
  });

  it('refuses decompression bombs, collections and damaged files with a readable reason', () => {
    // A WOFF table claiming far more than a metadata table can be.
    const big = Buffer.alloc(8 * 1024 * 1024);
    expect(() => fontInfo(woff([['name', big]]))).toThrow(/damaged/);
    // A WOFF2 stream that unpacks past the budget.
    expect(() => fontInfo(woff2([[5, Buffer.alloc(70 * 1024 * 1024)]]))).toThrow(/too large|damaged/);
    const collection = woff2([[5, nameTable('X')]]);
    collection.write('ttcf', 4, 'latin1');
    expect(() => fontInfo(collection)).toThrow(/collection/);
    const good = woff2([[5, nameTable('Brand')], [6, os2Table(400, false)]]);
    for (const cut of [10, 40, 52, good.length - 3]) expect(() => fontInfo(good.subarray(0, cut))).toThrow(/damaged/);
    // A name table whose record points past its end is damaged, not a crash with a raw Node error.
    const badName = nameTable('Brand');
    badName.writeUInt16BE(0xfff0, 16);
    expect(() => fontInfo(woff([['name', badName]]))).toThrow(/damaged|family/);
  });

  it('keeps only characters that are safe in a CSS family name', () => {
    expect(fontInfo(woff([['name', nameTable("Evil'; } body{x")]]))).toMatchObject({ family: 'Evil bodyx' });
  });
});
