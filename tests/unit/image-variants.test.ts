import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleVariantRequest, isOpaque, isReadable, keepsAvif, renderVariants, renderWebCopy } from '../../src/main/project/image-variants';
import { cleanPhoto, creditText, textCreditsAsTiff } from '../../src/main/project/photo-metadata';
import { createVariantClient, webCopySize, type VariantReply, type VariantRequest, type WorkerHandle } from '../../src/main/project/media-client';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'ascii'), data, u32(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])))]);

/** Split a PNG into its chunks. */
function chunksOf(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) out.push({ type: png.toString('ascii', i + 4, i + 8), data: png.subarray(i + 8, i + 8 + png.readUInt32BE(i)) });
  return out;
}

/** A real two-frame animated PNG: the picture's own pixels as both frames. */
async function animatedPng(width: number, height: number): Promise<Buffer> {
  const png = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
  const [ihdr, ...rest] = chunksOf(png);
  const idat = rest.filter((c) => c.type === 'IDAT');
  const fctl = (seq: number) => chunk('fcTL', Buffer.concat([u32(seq), u32(width), u32(height), u32(0), u32(0), Buffer.from([0, 10, 0, 100, 0, 0])]));
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr.data),
    chunk('acTL', Buffer.concat([u32(2), u32(0)])),
    fctl(0),
    ...idat.map((c) => chunk('IDAT', c.data)),
    fctl(1),
    ...idat.map((c, i) => chunk('fdAT', Buffer.concat([u32(2 + i), c.data]))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A stored picture: left half red, right half blue, optionally tagged with an EXIF orientation. */
async function halves(width: number, height: number, format: 'jpeg' | 'png', orientation?: number): Promise<Buffer> {
  const half = (r: number, b: number) => sharp({ create: { width: width / 2, height, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
  let img = sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite([
    { input: await half(255, 0), left: 0, top: 0 },
    { input: await half(0, 255), left: width / 2, top: 0 }
  ]);
  img = format === 'png' ? img.png() : img.jpeg({ quality: 95 });
  const flat = await img.toBuffer();
  return orientation ? sharp(flat).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer() : flat;
}

async function pixel(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return { r: data[at], g: data[at + 1], b: data[at + 2], a: info.channels === 4 ? data[at + 3] : 255 };
}

/** Copies as "width format" pairs, in the order they come. */
const pairs = (variants: Array<{ width: number; mime: string }>) => variants.map((v) => `${v.width} ${v.mime.slice('image/'.length)}`);
/** One format's copies, as their widths. */
const widthsOf = (variants: Array<{ width: number; mime: string }>, mime: string) => variants.filter((v) => v.mime === mime).map((v) => v.width);

/** A real photo (the Business starter's hero) cut to a size, on which AVIF saves well over WebP. */
async function photo(width: number, height: number, format: 'jpeg' | 'png' | 'webp' | 'avif' = 'jpeg'): Promise<Buffer> {
  const img = sharp(readFileSync('resources/starter-assets/hero.jpg')).resize(width, height, { fit: 'cover' });
  return (format === 'jpeg' ? img.jpeg({ quality: 92 }) : format === 'png' ? img.png() : format === 'webp' ? img.webp({ quality: 90 }) : img.avif({ quality: 70 })).toBuffer();
}

describe('responsive copies', () => {
  it('makes each width meaningfully smaller than the picture as JPEG without metadata, and WebP and AVIF sets to its full width', async () => {
    const variants = await renderVariants(await photo(2000, 1000), 'image/jpeg', 2000);
    // Narrowest first; at one width the picture's own format, then WebP, then AVIF.
    expect(pairs(variants)).toEqual(['160 jpeg', '160 webp', '160 avif', '480 jpeg', '480 webp', '480 avif', '960 jpeg', '960 webp', '960 avif', '1440 jpeg', '1440 webp', '1440 avif', '2000 webp', '2000 avif']);
    for (const v of variants) {
      const m = await sharp(v.data).metadata();
      expect(m, `${v.width} ${v.mime}`).toMatchObject({ format: v.mime === 'image/avif' ? 'heif' : v.mime.slice(6), width: v.width, height: v.width / 2 });
      // Nothing to credit on this photo, so no copy carries metadata of any kind.
      expect(m.exif, `${v.width} ${v.mime}`).toBeUndefined();
      expect(m.xmp, `${v.width} ${v.mime}`).toBeUndefined();
    }
    // A copy is made only when it is under 90% of the picture's width: 1440 is not, at 1600, in any format.
    const at1600 = await renderVariants(await photo(1600, 800), 'image/jpeg', 1600);
    expect(widthsOf(at1600, 'image/jpeg')).toEqual([160, 480, 960]);
    expect(widthsOf(at1600, 'image/webp')).toEqual([160, 480, 960, 1600]);
    expect(widthsOf(at1600, 'image/avif')).toEqual([160, 480, 960, 1600]);
    expect(widthsOf(await renderVariants(await halves(1602, 800, 'jpeg'), 'image/jpeg', 1602), 'image/jpeg')).toEqual([160, 480, 960, 1440]);
    // A header that overstates the width gets copies for the picture's real width, each labelled as it is.
    const small = await renderVariants(await halves(600, 300, 'jpeg'), 'image/jpeg', 2000);
    expect(widthsOf(small, 'image/jpeg')).toEqual([160, 480]);
    expect(widthsOf(small, 'image/webp')).toEqual([160, 480, 600]);
    expect((await sharp(small.find((v) => v.width === 480 && v.mime === 'image/jpeg')!.data).metadata()).width).toBe(480);
    expect((await sharp(small.find((v) => v.width === 600)!.data).metadata()).width).toBe(600);
  });

  it('turns every copy the way its EXIF orientation says, sized by its displayed width', async () => {
    // Stored 1200x600 on its side (orientation 6: turn clockwise), so displayed 600x1200 with red on top.
    const variants = await renderVariants(await halves(1200, 600, 'jpeg', 6), 'image/jpeg', 600);
    expect(widthsOf(variants, 'image/jpeg')).toEqual([160, 480]);
    expect(widthsOf(variants, 'image/webp')).toEqual([160, 480, 600]);
    for (const copy of variants) {
      const m = await sharp(copy.data).metadata();
      // A JPEG copy carries no orientation; a WebP or AVIF one may say "as stored", which turns nothing.
      expect([m.width, m.height, copy.mime === 'image/jpeg' ? m.orientation : (m.orientation ?? 1)], `${copy.width} ${copy.mime}`).toEqual([copy.width, copy.width * 2, copy.mime === 'image/jpeg' ? undefined : 1]);
      const top = await pixel(copy.data, copy.width / 2, copy.width / 5);
      const bottom = await pixel(copy.data, copy.width / 2, copy.width * 2 - copy.width / 5);
      expect(top.r, copy.mime).toBeGreaterThan(200);
      expect(top.b, copy.mime).toBeLessThan(60);
      expect(bottom.b, copy.mime).toBeGreaterThan(200);
      expect(bottom.r, copy.mime).toBeLessThan(60);
    }
    // Orientation 2 mirrors: red ends up on the right, in every format.
    const mirrored = await renderVariants(await halves(1200, 600, 'jpeg', 2), 'image/jpeg', 1200, (['image/jpeg', 'image/webp', 'image/avif'] as const).map((mime) => ({ width: 480, mime })));
    expect(pairs(mirrored)).toEqual(['480 jpeg', '480 webp', '480 avif']);
    for (const m of mirrored) {
      expect((await pixel(m.data, 400, 100)).r, m.mime).toBeGreaterThan(200);
      expect((await pixel(m.data, 80, 100)).b, m.mime).toBeGreaterThan(200);
    }
  });

  it('keeps a PNG a PNG, transparency included, in every format', async () => {
    const clear = await sharp({ create: { width: 1200, height: 600, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0 } } }).png().toBuffer();
    const variants = await renderVariants(clear, 'image/png', 1200);
    const v = variants.find((c) => c.width === 480 && c.mime === 'image/png')!;
    expect(await sharp(v.data).metadata()).toMatchObject({ format: 'png', width: 480, height: 240, hasAlpha: true });
    expect((await pixel(v.data, 10, 10)).a).toBe(0);
    const webp = variants.find((c) => c.width === 480 && c.mime === 'image/webp')!;
    expect(await sharp(webp.data).metadata()).toMatchObject({ format: 'webp', hasAlpha: true });
    expect((await pixel(webp.data, 10, 10)).a).toBe(0);
    const [avif] = await renderVariants(clear, 'image/png', 1200, [{ width: 480, mime: 'image/avif' }]);
    expect(await sharp(avif.data).metadata()).toMatchObject({ format: 'heif', hasAlpha: true });
    expect((await pixel(avif.data, 10, 10)).a).toBe(0);
  });

  it('gives a WebP smaller WebP copies, the original serving its full width, and an AVIF its AVIF copies and a WebP set', async () => {
    const webp = await renderVariants(await photo(1600, 800, 'webp'), 'image/webp', 1600);
    expect(widthsOf(webp, 'image/webp')).toEqual([160, 480, 960]);
    expect(widthsOf(webp, 'image/avif')).toEqual([160, 480, 960, 1600]);
    expect(widthsOf(webp, 'image/jpeg')).toEqual([]);
    const avif = await renderVariants(await photo(1600, 800, 'avif'), 'image/avif', 1600);
    expect(widthsOf(avif, 'image/avif')).toEqual([160, 480, 960]);
    expect(widthsOf(avif, 'image/webp')).toEqual([160, 480, 960, 1600]);
    for (const v of [...webp, ...avif]) expect(await sharp(v.data).metadata(), `${v.width} ${v.mime}`).toMatchObject({ width: v.width, format: v.mime === 'image/avif' ? 'heif' : 'webp' });
  });

  it('keeps an AVIF set only when it is at least 10% smaller than the WebP one', async () => {
    expect([keepsAvif(90, 100), keepsAvif(91, 100), keepsAvif(9, 10), keepsAvif(0, 0)]).toEqual([true, false, true, true]);
    // A photo: AVIF is far smaller.
    const photoCopies = await renderVariants(await photo(1200, 800), 'image/jpeg', 1200);
    const bytes = (list: typeof photoCopies, mime: string) => list.filter((v) => v.mime === mime).reduce((n, v) => n + v.data.length, 0);
    expect(bytes(photoCopies, 'image/avif')).toBeGreaterThan(0);
    expect(bytes(photoCopies, 'image/avif')).toBeLessThanOrEqual(bytes(photoCopies, 'image/webp') * 0.9);
    // Two flat colours, small: AVIF's larger container outweighs what it saves, so its set is left out whole. (Larger,
    // how much AVIF saves on flat colour varies with the encoder's build: Linux's makes a 1200px set smaller than WebP's.)
    const flat = await renderVariants(await halves(600, 300, 'png'), 'image/png', 600);
    expect(widthsOf(flat, 'image/webp')).toEqual([160, 480, 600]);
    expect(widthsOf(flat, 'image/avif')).toEqual([]);
    const avifOfFlat = await renderVariants(await halves(600, 300, 'png'), 'image/png', 600, [160, 480, 600].map((width) => ({ width, mime: 'image/avif' as const })));
    expect(avifOfFlat.reduce((n, v) => n + v.data.length, 0)).toBeGreaterThan(bytes(flat, 'image/webp') * 0.9);
  });

  it('writes the original’s credits into its WebP and AVIF copies, and nothing private', async () => {
    const credited = await sharp(await photo(1000, 500))
      .withExif({ IFD0: { Artist: 'Ana Field', Copyright: 'Field Studio 2026', Make: 'Acme Phones', Model: 'Pocket 9' } })
      .jpeg({ quality: 92 })
      .toBuffer();
    const variants = await renderVariants(credited, 'image/jpeg', 1000);
    for (const v of variants) {
      const text = v.data.toString('latin1');
      expect(text, `${v.width} ${v.mime}`).not.toContain('Acme Phones');
      // JPEG copies get theirs when the site is exported (see addCredits); the encoder writes the others'.
      if (v.mime === 'image/jpeg') expect(text).not.toContain('Ana Field');
      else {
        expect(text, `${v.width} ${v.mime}`).toContain('Ana Field');
        expect(text, `${v.width} ${v.mime}`).toContain('Field Studio 2026');
        expect(cleanPhoto(v.data)?.credits.tiff?.toString('latin1'), `${v.width} ${v.mime}`).toContain('Ana Field');
      }
    }
    // A PNG's Author text, an IPTC by-line and an XMP creator are carried the same way.
    expect(creditText({ text: [Buffer.from('tEXtAuthor\0Bo Lens', 'latin1')] })).toEqual({ artist: 'Bo Lens', xmp: expect.stringContaining('<dc:creator><rdf:Seq><rdf:li>Bo Lens</rdf:li></rdf:Seq></dc:creator>') });
    const iptc = Buffer.concat([Buffer.from([0x1c, 2, 80, 0, 7]), Buffer.from('Cy Shot'), Buffer.from([0x1c, 2, 116, 0, 8]), Buffer.from('Shot Ltd')]);
    const block = Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([4, 4, 0, 0]), u32(iptc.length), iptc]);
    expect(creditText({ iptc: block })).toEqual({ artist: 'Cy Shot', copyright: 'Shot Ltd', xmp: expect.stringContaining('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Shot Ltd</rdf:li></rdf:Alt></dc:rights>') });
    // The photo's own XMP credits come first; what they leave unsaid comes from its EXIF and IPTC, exactly as written.
    const ownXmp = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>');
    expect(creditText({ tiff: Buffer.from('MM\0*\0\0\0\x08\0\0\0\0\0\0', 'latin1'), xmp: Buffer.from('<x:xmpmeta/>') })).toEqual({});
    const rights = textCreditsAsTiff([Buffer.from('tEXtAuthor\0Ana Field', 'latin1')])!;
    const dataset = (n: number, value: string) => Buffer.concat([Buffer.from([0x1c, 2, n, 0, Buffer.byteLength(value)]), Buffer.from(value, 'utf8')]);
    const credit = Buffer.concat([Buffer.from([0x1c, 1, 90, 0, 3, 0x1b, 0x25, 0x47]), dataset(116, '© Zoë'), dataset(110, 'Agence Zoë')]);
    const merged = creditText({ tiff: rights, xmp: ownXmp, iptc: Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([4, 4, 0, 0]), u32(credit.length), credit]) });
    expect(merged.artist).toBe('Ana Field');
    expect(merged.copyright).toBe('© Zoë');
    expect(merged.xmp).toContain('<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>');
    expect(merged.xmp).not.toContain('Ana Field');
    expect(merged.xmp).toContain('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Zoë</rdf:li></rdf:Alt></dc:rights>');
    expect(merged.xmp).toContain('<photoshop:Credit>Agence Zoë</photoshop:Credit>');
    // Text no XML document may hold is left out, so the packet stays one a reader can parse.
    const control = Buffer.concat([Buffer.from([0x1c, 1, 90, 0, 3, 0x1b, 0x25, 0x47]), dataset(110, 'Agence\u000b Zoë'), dataset(80, 'A<B>\u0001')]);
    const cleanXmp = creditText({ iptc: Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([4, 4, 0, 0]), u32(control.length), control]) }).xmp!;
    expect(cleanXmp).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(cleanXmp).toContain('<photoshop:Credit>Agence Zoë</photoshop:Credit>');
    expect(cleanXmp).toContain('<rdf:li>A&lt;B&gt;</rdf:li>');
    // EXIF first, IPTC where EXIF has nothing; IPTC is UTF-8 only when its character set says so.
    const exifArtist = textCreditsAsTiff([Buffer.from('tEXtAuthor\0Ana Field', 'latin1')])!;
    const mixed = creditText({ tiff: exifArtist, iptc: block });
    expect([mixed.artist, mixed.copyright]).toEqual(['Ana Field', 'Shot Ltd']);
    const latin = Buffer.concat([Buffer.from([0x1c, 2, 80, 0, 3]), Buffer.from('Zo\xeb', 'latin1')]);
    const latinBlock = Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([4, 4, 0, 0]), u32(latin.length), latin]);
    expect(creditText({ iptc: latinBlock }).artist).toBe('Zoë');
    const utf = Buffer.concat([Buffer.from([0x1c, 1, 90, 0, 3, 0x1b, 0x25, 0x47, 0x1c, 2, 80, 0, 4]), Buffer.from('Zoë', 'utf8'), Buffer.from([0x1c, 2, 110, 0, 5]), Buffer.from('Fotos')]);
    const utfBlock = Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([4, 4, 0, 0]), u32(utf.length), utf]);
    const utfCredits = creditText({ iptc: utfBlock });
    expect(utfCredits.artist).toBe('Zoë');
    // A photo with no XMP credits gets a packet saying them exactly, the IPTC credit line too.
    expect(utfCredits.xmp).toContain('<dc:creator><rdf:Seq><rdf:li>Zoë</rdf:li></rdf:Seq></dc:creator>');
    expect(utfCredits.xmp).toContain('<photoshop:Credit>Fotos</photoshop:Credit>');
  });

  it('keeps a credit’s own words in the copies: brackets in the EXIF, every letter in the XMP', async () => {
    const png = await photo(800, 400, 'png');
    const text = (keyword: string, value: string) => chunk('tEXt', Buffer.from(`${keyword}\0${value}`, 'latin1'));
    // After the header chunk: Author and Copyright text, in Latin-1 as tEXt holds it.
    const credited = Buffer.concat([png.subarray(0, 33), text('Author', 'José Núñez (Studio)'), text('Copyright', '© 2026 Núñez & Co'), png.subarray(33)]);
    const [webp, avif] = await renderVariants(credited, 'image/png', 800, [
      { width: 480, mime: 'image/webp' },
      { width: 480, mime: 'image/avif' }
    ]);
    for (const copy of [webp, avif]) {
      const c = cleanPhoto(copy.data)!.credits;
      // EXIF text is ASCII only, but nothing of it is dropped.
      expect(c.tiff?.toString('latin1'), copy.mime).toContain('Jose Nunez (Studio)');
      expect(c.xmp?.toString('utf8'), copy.mime).toContain('<rdf:li>José Núñez (Studio)</rdf:li>');
      expect(c.xmp?.toString('utf8'), copy.mime).toContain('© 2026 Núñez &amp; Co');
    }
  });

  it('makes no copies of a moving picture, whose resized copies would each be one still frame', async () => {
    const moving = await animatedPng(1200, 600);
    expect(chunksOf(moving).map((c) => c.type)).toContain('acTL');
    expect(await renderVariants(moving, 'image/png', 1200)).toEqual([]);
    // The same pixels as an ordinary still PNG are still resized.
    const still = await sharp(moving).png().toBuffer();
    expect(chunksOf(still).map((c) => c.type)).not.toContain('acTL');
    expect(widthsOf(await renderVariants(still, 'image/png', 1200), 'image/png')).toEqual([160, 480, 960]);
    // An animated WebP, and an AVIF sequence, are left to the browser too.
    const frame = (r: number, b: number) => sharp({ create: { width: 1200, height: 600, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
    const animatedWebp = await sharp([await frame(200, 0), await frame(0, 200)], { join: { animated: true } }).webp({ loop: 0 }).toBuffer();
    expect((await sharp(animatedWebp).metadata()).pages).toBe(2);
    expect(await renderVariants(animatedWebp, 'image/webp', 1200)).toEqual([]);
    const sequence = Buffer.from(await photo(1200, 600, 'avif'));
    sequence.write('avis', 8, 'latin1');
    expect(await renderVariants(sequence, 'image/avif', 1200)).toEqual([]);
    // A sequence brand among the compatible ones says the same, whatever the major brand.
    const listed = Buffer.from(await photo(1200, 600, 'avif'));
    expect(listed.toString('latin1', 8, 12)).toBe('avif');
    listed.write('avis', 16, 'latin1');
    expect(await renderVariants(listed, 'image/avif', 1200)).toEqual([]);
  });

  it('leaves an AVIF image sequence to the browser, but not an AVIF whose brands nothing knows', async () => {
    const avif = await sharp({ create: { width: 32, height: 16, channels: 3, background: { r: 9, g: 9, b: 9 } } }).avif().toBuffer();
    expect(avif.toString('latin1', 4, 12)).toBe('ftypavif');
    expect(await isReadable(avif, 'image/avif')).toBe(true);
    const branded = (brand: string) => {
      const b = Buffer.from(avif);
      const end = b.readUInt32BE(0);
      for (let p = 8; p + 4 <= end; p += 4) if (p !== 12) b.write(brand, p, 'latin1');
      return b;
    };
    expect(await isReadable(branded('zzzz'), 'image/avif')).toBe(false);
    expect(await isReadable(branded('avis'), 'image/avif')).toBe(true);
    // A still with an unusual major brand that still declares itself AVIF.
    const still = branded('zzzz');
    still.write('MA1B', 8, 'latin1');
    still.write('avif', 16, 'latin1');
    expect(await isReadable(still, 'image/avif')).toBe(true);
  });

  it('makes exactly the copies asked for, in their formats, never wider than the picture', async () => {
    const asked = [
      { width: 960, mime: 'image/jpeg' as const },
      { width: 1000, mime: 'image/webp' as const },
      { width: 480, mime: 'image/avif' as const },
      { width: 1440, mime: 'image/webp' as const },
      { width: 0, mime: 'image/jpeg' as const },
      { width: 480.5, mime: 'image/webp' as const }
    ];
    const variants = await renderVariants(await halves(1000, 500, 'jpeg'), 'image/jpeg', 1000, asked);
    expect(pairs(variants)).toEqual(['960 jpeg', '1000 webp', '480 avif']);
    for (const v of variants) expect(await sharp(v.data).metadata(), `${v.width} ${v.mime}`).toMatchObject({ width: v.width, format: v.mime === 'image/avif' ? 'heif' : v.mime.slice(6) });
  });

  it('leaves out only the copies an encoder cannot make: a whole modern set, or one copy asked for', async () => {
    const proto = Object.getPrototypeOf(sharp()) as { avif: () => unknown };
    const broken = vi.spyOn(proto, 'avif').mockImplementation(() => {
      throw new Error('no AV1 encoder');
    });
    try {
      const picture = await photo(1200, 600);
      const all = await renderVariants(picture, 'image/jpeg', 1200);
      expect(widthsOf(all, 'image/jpeg')).toEqual([160, 480, 960]);
      expect(widthsOf(all, 'image/webp')).toEqual([160, 480, 960, 1200]);
      expect(widthsOf(all, 'image/avif')).toEqual([]);
      const asked = await renderVariants(picture, 'image/jpeg', 1200, [{ width: 480, mime: 'image/jpeg' }, { width: 480, mime: 'image/avif' }, { width: 960, mime: 'image/webp' }]);
      expect(pairs(asked)).toEqual(['480 jpeg', '960 webp']);
    } finally {
      broken.mockRestore();
    }
  });

  it('is deterministic, and leaves other formats alone', async () => {
    const picture = await photo(2000, 1000);
    const [a, b] = [await renderVariants(picture, 'image/jpeg', 2000), await renderVariants(picture, 'image/jpeg', 2000)];
    expect(pairs(a)).toHaveLength(14);
    expect(pairs(a)).toEqual(pairs(b));
    expect(a.every((v, i) => v.data.equals(b[i].data))).toBe(true);
    for (const mime of ['image/gif', 'image/svg+xml', 'image/heic']) expect(await renderVariants(picture, mime, 2000)).toEqual([]);
  });
});

/** A stand-in for the utility process: records what it is sent and replies when the test says. */
class FakeWorker implements WorkerHandle {
  sent: VariantRequest[] = [];
  killed = false;
  /** Whether the process has started; kill() fails before then, as Electron's does. */
  started = true;
  failSend = false;
  private listeners: Record<'message' | 'exit' | 'error' | 'spawn', Array<(arg?: never) => void>> = { message: [], exit: [], error: [], spawn: [] };
  postMessage(m: VariantRequest) {
    if (this.failSend) throw new Error('channel closed');
    this.sent.push(m);
  }
  on(event: 'message' | 'exit' | 'error' | 'spawn', listener: never) {
    this.listeners[event].push(listener);
    return this;
  }
  kill() {
    if (!this.started) return false;
    this.killed = true;
    return true;
  }
  emit(event: 'message' | 'exit' | 'error' | 'spawn', arg?: unknown) {
    for (const l of this.listeners[event]) l(arg as never);
  }
  reply(m: VariantReply) {
    this.emit('message', m);
  }
  exit(code = 1) {
    this.emit('exit', code);
  }
}

describe('media worker client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const spawner = () => {
    const workers: FakeWorker[] = [];
    return { workers, spawn: () => (workers.push(new FakeWorker()), workers[workers.length - 1]) };
  };
  const tick = () => new Promise((r) => setImmediate(r));

  it('sends the picture to the worker and returns its copies as buffers', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const p = client.variants(Buffer.from('photo'), 'image/jpeg', 2000);
    await tick();
    expect(workers).toHaveLength(1);
    const [req] = workers[0].sent;
    expect([Buffer.from(req.data).toString(), req.mime, req.width]).toEqual(['photo', 'image/jpeg', 2000]);
    workers[0].reply({ id: req.id, ok: true, variants: [{ width: 480, mime: 'image/jpeg', data: new Uint8Array([1, 2, 3]) }] });
    const out = await p;
    expect(out).toHaveLength(1);
    expect(Buffer.isBuffer(out[0].data) && [...out[0].data]).toEqual([1, 2, 3]);
    client.stop();
  });

  it('handles one picture at a time, so a batch never holds every photo decoded at once', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const first = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    const second = client.variants(Buffer.from('b'), 'image/png', 2000);
    await tick();
    expect(workers[0].sent).toHaveLength(1);
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, error: 'unsupported image' });
    expect(await first).toEqual([]);
    await tick();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent.map((r) => r.mime)).toEqual(['image/jpeg', 'image/png']);
    workers[0].reply({ id: workers[0].sent[1].id, ok: true, variants: [] });
    expect(await second).toEqual([]);
    client.stop();
  });

  it('gives up on a worker that takes too long, and starts a fresh one for the next picture', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { timeoutMs: 1000 });
    const slow = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await slow).toEqual([]);
    expect(workers[0].killed).toBe(true);
    // A late answer from the stopped worker belongs to no request.
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [{ width: 480, mime: 'image/jpeg', data: new Uint8Array([9]) }] });
    const next = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [{ width: 480, mime: 'image/jpeg', data: new Uint8Array([7]) }] });
    expect((await next).map((v) => [...v.data])).toEqual([[7]]);
    client.stop();
  });

  it('imports without copies when the worker crashes or cannot start', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const crashed = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await tick();
    workers[0].exit(1);
    expect(await crashed).toEqual([]);
    const after = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [] });
    expect(await after).toEqual([]);
    client.stop();
    const broken = createVariantClient(() => {
      throw new Error('no utility process');
    });
    expect(await broken.variants(Buffer.from('c'), 'image/jpeg', 2000)).toEqual([]);
  });

  it('says a picture is unreadable only when the decoder refused it, never because the worker failed', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { timeoutMs: 1000 });
    const refused = client.inspect(Buffer.from('a'), 'image/png', 100);
    await tick();
    expect(workers[0].sent[0]).toMatchObject({ check: true });
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, error: 'The picture could not be decoded.', unreadable: true });
    expect(await refused).toEqual({ unreadable: true, variants: [] });
    const failed = client.inspect(Buffer.from('b'), 'image/png', 100);
    await tick();
    workers[0].reply({ id: workers[0].sent[1].id, ok: false, error: 'out of memory' });
    expect(await failed).toEqual({ unreadable: false, variants: [] });
    const crashed = client.inspect(Buffer.from('c'), 'image/png', 100);
    await tick();
    workers[0].exit(1);
    expect(await crashed).toEqual({ unreadable: false, variants: [] });
    client.stop();
    expect(await createVariantClient(() => { throw new Error('no utility process'); }).inspect(Buffer.from('d'), 'image/png', 100)).toEqual({ unreadable: false, variants: [] });
  });

  it('gives a picture’s copies two minutes, and any other request half a minute, before the worker counts as stuck', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const copies = client.variants(Buffer.from('a'), 'image/jpeg', 10_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workers[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await copies).toEqual([]);
    expect(workers[0].killed).toBe(true);
    const opaque = client.opaque(Buffer.from('b'), 'image/png');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await opaque).toBeNull();
    expect(workers[1].killed).toBe(true);
    client.stop();
  });

  it('asks for exactly the copies a library image lists when making them again, and returns each with its format', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const p = client.variants(Buffer.from('a'), 'image/jpeg', 1000, [{ width: 960, mime: 'image/webp' }, { width: 960, mime: 'image/jpeg' }]);
    await tick();
    expect(workers[0].sent[0]).toMatchObject({ targets: [{ width: 960, mime: 'image/webp' }, { width: 960, mime: 'image/jpeg' }] });
    expect(workers[0].sent[0].check).toBeUndefined();
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [{ width: 960, mime: 'image/jpeg', data: new Uint8Array([4]) }, { width: 960, mime: 'image/webp', data: new Uint8Array([5]) }] });
    expect((await p).map((v) => [v.width, v.mime, [...v.data]])).toEqual([[960, 'image/jpeg', [4]], [960, 'image/webp', [5]]]);
    client.stop();
  });

  it('reads copies that sit inside a larger buffer, and survives a failed send or a fatal worker error', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const sliced = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await tick();
    const backing = new Uint8Array([0, 0, 5, 6, 7, 0]);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [{ width: 480, mime: 'image/jpeg', data: backing.subarray(2, 5) }] });
    expect((await sliced).map((v) => [...v.data])).toEqual([[5, 6, 7]]);
    // An error event (a fatal failure in the worker) settles the request instead of being thrown.
    const failing = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await tick();
    workers[0].emit('error');
    expect(await failing).toEqual([]);
    expect(workers[0].killed).toBe(true);
    workers[0].exit(1);
    // A send that fails gives up on that worker.
    const unsent = client.variants(Buffer.from('c'), 'image/jpeg', 2000);
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].failSend = true;
    const next = client.variants(Buffer.from('d'), 'image/jpeg', 2000);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [] });
    expect(await unsent).toEqual([]);
    expect(await next).toEqual([]);
    expect(workers[1].killed).toBe(true);
    client.stop();
  });

  it('ends a worker that is stopped before it has started, once it starts', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = createVariantClient(() => {
      const w = new FakeWorker();
      w.started = false;
      workers.push(w);
      return w;
    }, { timeoutMs: 1000 });
    const p = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual([]);
    expect(workers[0].killed).toBe(false);
    workers[0].started = true;
    workers[0].emit('spawn');
    expect(workers[0].killed).toBe(true);
    client.stop();
  });

  it('keeps a reused worker past the idle time of an earlier request, and ignores an old worker’s exit', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { idleMs: 5000, timeoutMs: 8000 });
    const first = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [] });
    await first;
    await vi.advanceTimersByTimeAsync(4000);
    // Reused before the idle time ran out: the idle stop and the first request's deadline must not end it.
    const second = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(workers[0].killed).toBe(false);
    workers[0].reply({ id: workers[0].sent[1].id, ok: true, variants: [{ width: 480, mime: 'image/jpeg', data: new Uint8Array([1]) }] });
    expect(await second).toHaveLength(1);
    // A worker that timed out exits late, while its replacement is busy: the replacement's request is unaffected.
    const slow = client.variants(Buffer.from('c'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await slow).toEqual([]);
    const fresh = client.variants(Buffer.from('d'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    workers[0].exit(1);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [{ width: 480, mime: 'image/jpeg', data: new Uint8Array([2]) }] });
    expect(await fresh).toHaveLength(1);
    client.stop();
  });

  it('stops an idle worker, and settles a request in flight when stopped', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { idleMs: 5000 });
    const p = client.variants(Buffer.from('a'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [] });
    await p;
    await vi.advanceTimersByTimeAsync(4999);
    expect(workers[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].killed).toBe(true);
    const pending = client.variants(Buffer.from('b'), 'image/jpeg', 2000);
    const queued = client.variants(Buffer.from('c'), 'image/jpeg', 2000);
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    expect(await pending).toEqual([]);
    expect(workers[1].killed).toBe(true);
    // Stopped for good: what was queued gets no copies and starts no new worker.
    expect(await queued).toEqual([]);
    expect(workers).toHaveLength(2);
  });
});

describe('web-sized copies', () => {
  it('turns a photo upright, fits it inside the edge without enlarging it, and drops its metadata', async () => {
    // Stored 3000x1500 on its side (orientation 6), so displayed 1500x3000 with red on top.
    const photo = await sharp(await halves(3000, 1500, 'jpeg', 6)).withExif({ IFD0: { Artist: 'Ana' } }).jpeg({ quality: 95 }).toBuffer();
    const copy = await renderWebCopy(photo, 2560);
    expect([copy.mime, copy.width, copy.height]).toEqual(['image/jpeg', 1280, 2560]);
    const m = await sharp(copy.data).metadata();
    expect([m.format, m.width, m.height, m.orientation, m.exif]).toEqual(['jpeg', 1280, 2560, undefined, undefined]);
    expect((await pixel(copy.data, 640, 200)).r).toBeGreaterThan(200);
    expect((await pixel(copy.data, 640, 2300)).b).toBeGreaterThan(200);
    const small = await renderWebCopy(await halves(800, 600, 'png'), 2560);
    expect([small.mime, small.width, small.height]).toEqual(['image/jpeg', 800, 600]);
    const edge = await renderWebCopy(photo, 1000);
    expect([edge.width, edge.height]).toEqual([500, 1000]);
  });

  it('makes the copy exactly the size an import review shows, whatever the decoder shrinks on load', async () => {
    // A JPEG this size is decoded at half size first: resized from there, sharp alone would make it 2560 x 1501.
    const wide = await halves(7680, 4505, 'jpeg');
    const copy = await renderWebCopy(wide, 2560);
    expect([copy.width, copy.height]).toEqual([2560, webCopySize(7680, 4505).height]);
    expect((await sharp(copy.data).metadata()).height).toBe(copy.height);
  });

  it('keeps a picture with see-through pixels a PNG, and makes an opaque one with an alpha channel a JPEG', async () => {
    const clear = await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0.5 } } }).png().toBuffer();
    const copy = await renderWebCopy(clear, 2560);
    expect([copy.mime, copy.width, copy.height]).toEqual(['image/png', 2560, 853]);
    expect((await sharp(copy.data).metadata()).hasAlpha).toBe(true);
    const a = (await pixel(copy.data, 10, 10)).a;
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(160);
    const solid = await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 1 } } }).png().toBuffer();
    expect((await renderWebCopy(solid, 2560)).mime).toBe('image/jpeg');
    expect([await isOpaque(clear), await isOpaque(solid), await isOpaque(await halves(100, 50, 'jpeg'))]).toEqual([false, true, true]);
  });

  it('is deterministic', async () => {
    const photo = await halves(3000, 2000, 'jpeg');
    expect((await renderWebCopy(photo)).data.equals((await renderWebCopy(photo)).data)).toBe(true);
  });

  it('reads a decoded photo from a file when asked, and says when the decoder refuses the picture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-web-copy-'));
    try {
      const file = join(dir, 'photo.tiff');
      writeFileSync(file, await sharp(await halves(3000, 1500, 'jpeg', 6)).tiff().toBuffer());
      const r = await handleVariantRequest({ id: 1, kind: 'web', path: file, data: new Uint8Array(0), mime: '', width: 0, maxEdge: 2560 });
      expect(r).toMatchObject({ id: 1, ok: true, web: { mime: 'image/jpeg', width: 1280, height: 2560 } });
      const broken = await handleVariantRequest({ id: 2, kind: 'web', data: new Uint8Array(Buffer.from('not a picture')), mime: 'image/jpeg', width: 0, maxEdge: 2560 });
      expect(broken).toMatchObject({ id: 2, ok: false, unreadable: true });
      const opaque = await handleVariantRequest({ id: 3, kind: 'opaque', data: new Uint8Array(await halves(100, 50, 'png')), mime: 'image/png', width: 0 });
      expect(opaque).toMatchObject({ id: 3, ok: true, opaque: true });
      const seeThrough = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
      expect(await handleVariantRequest({ id: 4, kind: 'opaque', data: new Uint8Array(seeThrough), mime: 'image/png', width: 0 })).toMatchObject({ id: 4, ok: true, opaque: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('media worker client: web-sized copies', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const spawner = () => {
    const workers: FakeWorker[] = [];
    return { workers, spawn: () => (workers.push(new FakeWorker()), workers[workers.length - 1]) };
  };

  it('asks for a copy from bytes or a file, and says when it could not be made rather than giving nothing', async () => {
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn);
    const fromBytes = client.webCopy({ data: Buffer.from('photo'), mime: 'image/png' }, 2560);
    await vi.waitFor(() => expect(workers[0]?.sent).toHaveLength(1));
    expect(workers[0].sent[0]).toMatchObject({ kind: 'web', mime: 'image/png', maxEdge: 2560 });
    expect(Buffer.from(workers[0].sent[0].data).toString()).toBe('photo');
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, variants: [], web: { data: new Uint8Array([4, 5]), mime: 'image/jpeg', width: 10, height: 5 } });
    const made = await fromBytes;
    expect(made.ok && [made.copy.mime, made.copy.width, [...made.copy.data]]).toEqual(['image/jpeg', 10, [4, 5]]);
    const fromFile = client.webCopy({ path: '/tmp/photo.tiff' }, 2560);
    await vi.waitFor(() => expect(workers[0].sent).toHaveLength(2));
    expect(workers[0].sent[1]).toMatchObject({ kind: 'web', path: '/tmp/photo.tiff' });
    workers[0].reply({ id: workers[0].sent[1].id, ok: false, error: 'bad', unreadable: true });
    expect(await fromFile).toEqual({ ok: false, unreadable: true });
    // A worker that crashes proves nothing about the picture, and the next request still runs.
    const crashed = client.webCopy({ path: '/tmp/photo.tiff' }, 2560);
    await vi.waitFor(() => expect(workers[0].sent).toHaveLength(3));
    workers[0].exit(1);
    expect(await crashed).toEqual({ ok: false, unreadable: false });
    const opaque = client.opaque(Buffer.from('png'), 'image/png');
    await vi.waitFor(() => expect(workers[1]?.sent).toHaveLength(1));
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, variants: [], opaque: false });
    expect(await opaque).toBe(false);
    client.stop();
  });

  it('gives a web-sized copy longer than responsive copies before giving up on the worker', async () => {
    vi.useFakeTimers();
    const { workers, spawn } = spawner();
    const client = createVariantClient(spawn, { timeoutMs: 1000, webTimeoutMs: 5000 });
    const slow = client.webCopy({ data: Buffer.from('a'), mime: 'image/jpeg' }, 2560);
    await vi.advanceTimersByTimeAsync(1000);
    expect(workers[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await slow).toEqual({ ok: false, unreadable: false });
    expect(workers[0].killed).toBe(true);
    client.stop();
  });
});
