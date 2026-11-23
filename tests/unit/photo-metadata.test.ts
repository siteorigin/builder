import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { addCredits, cleanPhoto, photoMetadata, sniffImageType } from '../../src/main/project/photo-metadata';
import { imageInfo } from '../../src/main/project/media';
import { CAMERA_XMP, EOI, IDAT, IEND, IHDR, IMAGE_DATA, JFIF, PNG_SIG, SOI, app, ascii, be16, be32, cameraExif, chunk, exifSeg, geotaggedJpeg, icc, iccSeg, iccTags, le32, photoshopSeg, pngChunks, rationals, readTiff, seg, segments, short, tiff, undef, xmpPacket, xmpSeg } from './fixtures/photos';

// ---------------------------------------------------------------------------

describe('photo metadata in JPEG', () => {
  it('keeps orientation, colour and credits and drops location, device details, thumbnails and trailers', () => {
    const input = geotaggedJpeg();
    const r = cleanPhoto(input)!;
    expect(r).toMatchObject({ changed: true, location: true, device: true });
    const out = r.data;
    const text = out.toString('latin1');
    for (const secret of ['Acme', 'Phone X', 'SERIAL-12345', 'MAKERNOTE', 'Firmware', 'Springfield', 'GPSLatitude', '12 Main St', 'THUMBNAIL', 'MOTION-PHOTO', 'client’s house', 'meta-DATA', 'dmdd-DATA']) expect(text).not.toContain(secret);

    const exif = readTiff(app(out, 0xe1, 'Exif\0\0')!);
    expect(exif.short(exif.ifd0, 0x0112)).toBe(6);
    expect(exif.text(exif.ifd0, 0x013b)).toBe('Jane Doe Photography');
    expect(exif.text(exif.ifd0, 0x8298)).toBe('(c) 2026 Jane Doe');
    expect([...exif.ifd0.keys()].sort()).toEqual([0x0112, 0x013b, 0x8298, 0x8769]);
    expect(exif.thumbnail).toBe(false);
    // The colour space (uncalibrated) and its interoperability index (R03, Adobe RGB) stay.
    expect(exif.short(exif.exif, 0xa001)).toBe(0xffff);
    expect([...exif.exif!.keys()].sort()).toEqual([0x9000, 0xa001, 0xa005]);
    expect(exif.text(exif.interop, 0x0001)).toBe('R03');
    expect(imageInfo(out, 'image/jpeg')?.orientation).toBe(6);

    const xmp = app(out, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8');
    expect(xmp).toContain('<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>');
    expect(xmp).toContain('<rdf:li xml:lang="x-default">© Jane Doe</rdf:li>');
    expect(xmp).toContain('<photoshop:Credit>Jane Doe Studio</photoshop:Credit>');

    const iptc = app(out, 0xed, 'Photoshop 3.0\0')!.toString('latin1');
    expect(iptc).toContain('Jane Doe');
    expect(iptc).toContain('(c) Jane Doe');

    const profile = app(out, 0xe2, 'ICC_PROFILE\0')!.subarray(2);
    expect(iccTags(profile)).toEqual(['desc', 'rXYZ']);
    expect(profile.toString('latin1')).toContain('Display P3');
    expect(profile.readUInt32BE(0)).toBe(profile.length);
    // The header no longer names the device, the software or the old digest; the colour data is untouched.
    expect(profile.subarray(48, 56).every((b) => b === 0)).toBe(true);
    expect(profile.subarray(80, 100).every((b) => b === 0)).toBe(true);
    expect(profile.toString('latin1', 36, 40)).toBe('acsp');
    expect(profile.toString('latin1')).toContain('rXYZ-DATA');

    expect(segments(out).some((s) => s.marker === 0xfe)).toBe(false);
    // The coded picture is untouched, byte for byte, and the file ends at its end-of-image marker.
    expect(out.subarray(out.length - IMAGE_DATA.length - 2).equals(Buffer.concat([IMAGE_DATA, EOI]))).toBe(true);
    expect(out.subarray(0, JFIF.length + 2).equals(Buffer.concat([SOI, JFIF]))).toBe(true);
  });

  it('cleans big-endian EXIF the same way, and a cleaned file again changes nothing', () => {
    const out = cleanPhoto(geotaggedJpeg(false, 3))!.data;
    const exif = readTiff(app(out, 0xe1, 'Exif\0\0')!);
    expect(out.toString('latin1')).toContain('MM\0*');
    expect(exif.short(exif.ifd0, 0x0112)).toBe(3);
    expect(exif.text(exif.ifd0, 0x013b)).toBe('Jane Doe Photography');
    const again = cleanPhoto(out)!;
    expect(again).toMatchObject({ changed: false, location: false, device: false });
    expect(again.data).toBe(out);
  });

  it('leaves a JPEG with nothing private exactly as it is', () => {
    const plain = Buffer.concat([SOI, JFIF, IMAGE_DATA, EOI]);
    const r = cleanPhoto(plain)!;
    expect(r).toMatchObject({ changed: false, location: false, device: false });
    expect(r.data).toBe(plain);
    expect(photoMetadata(plain)).toEqual({ location: false, device: false });
  });

  it('drops the JFIF thumbnail but keeps its density', () => {
    const withThumb = seg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 1, 1]), Buffer.from([1, 2, 3])]));
    const out = cleanPhoto(Buffer.concat([SOI, withThumb, IMAGE_DATA, EOI]))!.data;
    expect(app(out, 0xe0, 'JFIF\0')).toEqual(Buffer.from([1, 2, 1, 0, 72, 0, 72, 0, 0]));
  });

  it('reports location and device details from each place they can be, and nothing for credits alone', () => {
    const jpeg = (...segs: Buffer[]) => Buffer.concat([SOI, ...segs, IMAGE_DATA, EOI]);
    expect(photoMetadata(jpeg(xmpSeg(xmpPacket('', ' exif:GPSLatitude="1,2N"'))))).toEqual({ location: true, device: false });
    expect(photoMetadata(jpeg(photoshopSeg()))).toEqual({ location: true, device: false });
    const gpsOnly = tiff(true, { ifd0: [{ tag: 0x8825, ptr: 'gps' }], gps: [ascii(0x0001, 'N'), { tag: 0x0002, type: 5, count: 1, value: Buffer.alloc(8, 1) }] });
    expect(photoMetadata(jpeg(exifSeg(gpsOnly)))).toEqual({ location: true, device: false });
    expect(photoMetadata(jpeg(exifSeg(tiff(false, { ifd0: [ascii(0x0110, 'Phone X')] }))))).toEqual({ location: false, device: true });
    expect(photoMetadata(jpeg(exifSeg(tiff(true, { ifd0: [ascii(0x013b, 'Jane')] })), xmpSeg(xmpPacket('<dc:creator><rdf:Seq><rdf:li>Jane</rdf:li></rdf:Seq></dc:creator>'))))).toEqual({ location: false, device: false });
  });

  it('refuses a JPEG whose segments cannot be followed, or whose image data has no end', () => {
    const broken = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x40, 0x00]), Buffer.from('Exif')]);
    expect(cleanPhoto(broken)).toBeNull();
    expect(cleanPhoto(Buffer.from('not a jpeg'))).toBeNull();
    // Without its end marker, image data cannot be told from text appended after it.
    expect(cleanPhoto(Buffer.concat([SOI, exifSeg(cameraExif()), IMAGE_DATA.subarray(0, IMAGE_DATA.length - 4), Buffer.from('Shot at 12 Main St')]))).toBeNull();
  });

  it('keeps the resolution and pixel size that let browsers show a high-density image at its intended size', () => {
    const le = true;
    const t = tiff(le, {
      ifd0: [rationals(le, 0x011a, 144), rationals(le, 0x011b, 144), short(le, 0x0128, 2), ascii(0x010f, 'Acme'), { tag: 0x8769, ptr: 'exif' }],
      exif: [{ tag: 0xa002, type: 4, count: 1, value: le32(2880) }, short(le, 0xa003, 1800), ascii(0xa431, 'SERIAL-1')]
    });
    const out = cleanPhoto(Buffer.concat([SOI, exifSeg(t), IMAGE_DATA, EOI]))!.data;
    const exif = readTiff(app(out, 0xe1, 'Exif\0\0')!);
    expect([...exif.ifd0.keys()].sort((a, b) => a - b)).toEqual([0x011a, 0x011b, 0x0128, 0x8769]);
    expect(exif.ifd0.get(0x011a)!.readUInt32LE(0)).toBe(144);
    expect(exif.short(exif.ifd0, 0x0128)).toBe(2);
    expect([...exif.exif!.keys()].sort((a, b) => a - b)).toEqual([0xa002, 0xa003]);
    expect(exif.exif!.get(0xa002)!.readUInt32LE(0)).toBe(2880);
    expect(out.toString('latin1')).not.toMatch(/Acme|SERIAL/);
  });

  it('keeps the Adobe colour-transform marker to its defined length', () => {
    const adobe = Buffer.concat([Buffer.from('Adobe', 'latin1'), Buffer.from([0, 100, 0, 0, 0, 0, 1])]);
    const out = cleanPhoto(Buffer.concat([SOI, seg(0xee, Buffer.concat([adobe, Buffer.from('SERIAL-777')])), IMAGE_DATA, EOI]))!.data;
    expect(app(out, 0xee, 'Adobe')).toEqual(adobe.subarray(5));
    expect(out.toString('latin1')).not.toContain('SERIAL');
  });

  it('replaces a profile description that is not a standard colour space’s name', () => {
    const jpeg = (p: Buffer) => Buffer.concat([SOI, iccSeg(p), IMAGE_DATA, EOI]);
    const custom = cleanPhoto(jpeg(icc('desc:Cam A12345', 'rXYZ')))!;
    expect(custom.device).toBe(true);
    const profile = app(custom.data, 0xe2, 'ICC_PROFILE\0')!.subarray(2);
    expect(profile.toString('latin1')).not.toContain('A12345');
    expect(profile.toString('latin1')).toContain('ICC profile');
    expect(iccTags(profile)).toEqual(['desc', 'rXYZ']);
    expect(profile.readUInt32BE(0)).toBe(profile.length);
    // A standard name stays as it is, and so does every other tag.
    const standard = app(cleanPhoto(jpeg(icc('desc:sRGB IEC61966-2.1', 'rXYZ')))!.data, 0xe2, 'ICC_PROFILE\0')!.subarray(2);
    expect(standard.toString('latin1')).toContain('sRGB IEC61966-2.1');
  });

  it('never revives text hidden in a processing instruction or CDATA, and finds fields under any prefix', () => {
    const hidden = xmpPacket(`<?editor <dc:creator>SERIAL-123</dc:creator> ?><![CDATA[<dc:rights>SERIAL-456</dc:rights>]]>`);
    expect(cleanPhoto(Buffer.concat([SOI, xmpSeg(hidden), IMAGE_DATA, EOI]))!.data.toString('latin1')).not.toMatch(/SERIAL|dc:creator|dc:rights/);
    const odd =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description r:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:camera="http://ns.adobe.com/tiff/1.0/" camera:Model="Pixel 9">` +
      `<dc:creator><r:Seq><r:li>Jane Doe</r:li></r:Seq></dc:creator></r:Description></r:RDF></x:xmpmeta>`;
    const r = cleanPhoto(Buffer.concat([SOI, xmpSeg(odd), IMAGE_DATA, EOI]))!;
    expect(r.device).toBe(true);
    expect(app(r.data, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8')).toContain('<rdf:li>Jane Doe</rdf:li>');
    expect(r.data.toString('latin1')).not.toContain('Pixel 9');
  });

  it('refuses a TIFF, which it cannot rewrite', () => {
    const t = tiff(true, { ifd0: [ascii(0x0110, 'Phone X')] });
    expect(sniffImageType(t)).toBe('image/tiff');
    expect(cleanPhoto(t)).toBeNull();
  });

  it('trusts no prefix that is bound to another namespace elsewhere in the packet', () => {
    const x =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:u="http://ns.adobe.com/photoshop/1.0/"/>` +
      `<rdf:Description rdf:about="" xmlns:u="urn:camera"><u:Credit>SERIAL-987</u:Credit></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const out = cleanPhoto(Buffer.concat([SOI, xmpSeg(x), IMAGE_DATA, EOI]))!.data;
    expect(out.toString('latin1')).not.toContain('SERIAL');
  });

  it('keeps only the HDR headroom from an Apple maker note', () => {
    const rational = (n: number, d: number) => Buffer.concat([be32(n), be32(d)]);
    const entry = (tag: number, type: number, value: Buffer) => Buffer.concat([be16(tag), be16(type), be32(1), value]);
    // Header, version 1, big-endian; three entries: a serial (tag 11), headroom (33) and gain (48), values after.
    const head = 16 + 3 * 12 + 4;
    const note = Buffer.concat([Buffer.from('Apple iOS\0', 'latin1'), be16(1), Buffer.from('MM'), be16(3), entry(0x000b, 2, be32(head + 16)), entry(0x0021, 10, be32(head)), entry(0x0030, 10, be32(head + 8)), be32(0), rational(1, 2), rational(3, 4), Buffer.from('SERIAL-APPLE-1\0\0')]);
    const t = tiff(false, { ifd0: [ascii(0x0110, 'iPhone'), { tag: 0x8769, ptr: 'exif' }], exif: [undef(0x927c, note)] });
    const r = cleanPhoto(Buffer.concat([SOI, exifSeg(t), IMAGE_DATA, EOI]))!;
    expect(r.device).toBe(true);
    const exif = readTiff(app(r.data, 0xe1, 'Exif\0\0')!);
    const kept = exif.exif!.get(0x927c)!;
    expect(kept.toString('latin1')).not.toContain('SERIAL');
    expect(kept.readUInt16BE(14)).toBe(2);
    expect([kept.readUInt16BE(16), kept.readUInt16BE(28)]).toEqual([0x0021, 0x0030]);
    expect(kept.subarray(kept.readUInt32BE(24), kept.readUInt32BE(24) + 8)).toEqual(rational(1, 2));
    expect(kept.subarray(kept.readUInt32BE(36), kept.readUInt32BE(36) + 8)).toEqual(rational(3, 4));
    // Reduced to the headroom, the note identifies nothing, and cleaning again changes nothing.
    expect(cleanPhoto(r.data)).toMatchObject({ changed: false, device: false });
  });

  it('reads credits whatever prefix they use, and never from a comment or an unknown entity', () => {
    const x =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:d="http://purl.org/dc/elements/1.1/" xmlns:ps="http://ns.adobe.com/photoshop/1.0/" xmlns:xr="http://ns.adobe.com/xap/1.0/rights/" xr:Certificate="https://example.com/licence">` +
      `<d:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></d:creator><!-- <ps:Credit>SERIAL-999</ps:Credit> --><d:rights><rdf:Alt><rdf:li xml:lang="x-default">&secret; Jane</rdf:li></rdf:Alt></d:rights></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const out = app(cleanPhoto(Buffer.concat([SOI, xmpSeg(x), IMAGE_DATA, EOI]))!.data, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8');
    expect(out).toContain('<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>');
    expect(out).toContain('<xmpRights:Certificate>https://example.com/licence</xmpRights:Certificate>');
    expect(out).not.toMatch(/SERIAL|Credit|secret|dc:rights/);
  });

  it('reads credits held only in extended XMP, and drops the extension', () => {
    const guid = 'A'.repeat(32);
    const ext = Buffer.from(xmpPacket('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Licensed to Client Co</rdf:li></rdf:Alt></dc:rights><exif:GPSLatitude>9,9N</exif:GPSLatitude>'));
    const half = Math.ceil(ext.length / 2);
    const chunk = (at: number, part: Buffer) => seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1'), Buffer.from(guid, 'latin1'), be32(ext.length), be32(at), part]));
    // A decoy reference in a comment comes first; only the real one counts.
    // Decoys come first: a reference in a comment, and one under a prefix that is not xmpNote's namespace.
    const main = xmpPacket(`<!-- xmpNote:HasExtendedXMP="${'B'.repeat(32)}" -->`, ` xmlns:other="urn:other" other:HasExtendedXMP="${'C'.repeat(32)}" xmlns:xmpNote="http://ns.adobe.com/xmp/note/" xmpNote:HasExtendedXMP="${guid}"`);
    const r = cleanPhoto(Buffer.concat([SOI, xmpSeg(main), chunk(half, ext.subarray(half)), chunk(0, ext.subarray(0, half)), IMAGE_DATA, EOI]))!;
    expect(r.location).toBe(true);
    expect(app(r.data, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8')).toContain('<rdf:li xml:lang="x-default">Licensed to Client Co</rdf:li>');
    expect(r.data.toString('latin1')).not.toMatch(/xmp\/extension|GPS/);
    // Chunks that overlap, even if their lengths add up, are not an extension.
    const overlapping = cleanPhoto(Buffer.concat([SOI, xmpSeg(main), chunk(0, ext.subarray(0, half)), chunk(half - 1, ext.subarray(half - 1, ext.length - 1)), IMAGE_DATA, EOI]))!;
    expect(overlapping.data.toString('latin1')).not.toContain('Licensed to Client Co');
  });
});

describe('HDR gain maps in JPEG', () => {
  /** A primary image indexed by MPF, its gain map after it, then a motion-photo video. */
  function ultraHdr(gainMapOffsetDelta = 0): { file: Buffer; gainMap: Buffer } {
    const gainMap = Buffer.concat([
      SOI,
      exifSeg(tiff(true, { ifd0: [ascii(0x010f, 'Acme')], gps: [] })),
      xmpSeg(xmpPacket('<hdrgm:GainMapMax><rdf:Seq><rdf:li>2.5</rdf:li><rdf:li>2.4</rdf:li><rdf:li>2.3</rdf:li></rdf:Seq></hdrgm:GainMapMax>', ' xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/" apdi:AuxiliaryImageType="urn:com:apple:photo:2020:aux:hdrgainmap" xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/" HDRGainMap:HDRGainMapHeadroom="8" hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:HDRCapacityMax="2.3" exif:GPSLatitude="5,5N"')),
      seg(0xe2, Buffer.concat([Buffer.from('urn:iso:std:iso:ts:21496:-1\0', 'latin1'), Buffer.from([0, 0, 0, 0])])),
      IMAGE_DATA,
      EOI
    ]);
    const container = (len: number) =>
      `<Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${len}"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="20"/></rdf:li></rdf:Seq></Container:Directory>`;
    const mpf = (primaryLen: number, offset: number) => {
      // The primary lists the gain map (entry 2) as its dependent image.
      const entries = Buffer.concat([le32(0x030000), le32(primaryLen), le32(0), Buffer.from([2, 0, 0, 0]), le32(0), le32(gainMap.length), le32(offset), Buffer.alloc(4)]);
      return seg(0xe2, Buffer.concat([Buffer.from('MPF\0', 'latin1'), tiff(true, { ifd0: [undef(0xb000, Buffer.from('0100')), { tag: 0xb001, type: 4, count: 1, value: le32(2) }, undef(0xb002, entries)] })]));
    };
    const head = Buffer.concat([SOI, exifSeg(cameraExif()), xmpSeg(xmpPacket(container(gainMap.length) + '<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>', ' hdrgm:Version="1.0" exif:GPSLatitude="51,30N"'))]);
    const tiffAt = head.length + 8;
    const primaryLen = head.length + mpf(0, 0).length + IMAGE_DATA.length + 2;
    const file = Buffer.concat([head, mpf(primaryLen, primaryLen - tiffAt + gainMapOffsetDelta), IMAGE_DATA, EOI, gainMap, Buffer.from('MP4-VIDEO-WITH-GPS')]);
    return { file, gainMap };
  }

  /** The images an MPF index points at, read back from a cleaned file. */
  function mpfImages(out: Buffer): Buffer[] {
    const i = out.indexOf(Buffer.from('MPF\0', 'latin1'));
    if (i < 0) return [];
    const t = readTiff(out.subarray(i + 4));
    const list = t.ifd0.get(0xb002)!;
    return Array.from({ length: list.length / 16 }, (_, k) => {
      const size = list.readUInt32LE(k * 16 + 4);
      const at = k === 0 ? 0 : i + 4 + list.readUInt32LE(k * 16 + 8);
      return out.subarray(at, at + size);
    });
  }

  it('keeps the gain map, cleaned, and points the index and the XMP directory at it', () => {
    const r = cleanPhoto(ultraHdr().file)!;
    expect(r.location).toBe(true);
    const out = r.data;
    expect(out.toString('latin1')).not.toMatch(/GPSLatitude|Acme|MP4-VIDEO|SERIAL/);
    const [primary, gainMap] = mpfImages(out);
    const index = readTiff(out.subarray(out.indexOf(Buffer.from('MPF\0', 'latin1')) + 4)).ifd0.get(0xb002)!;
    expect(index.readUInt16LE(12)).toBe(2);
    expect(primary.length + gainMap.length).toBe(out.length);
    expect(primary.subarray(primary.length - 2).equals(EOI)).toBe(true);
    expect(gainMap.subarray(0, 2).equals(SOI)).toBe(true);
    const gainXmp = app(gainMap, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8');
    expect(gainXmp).toContain('hdrgm:Version="1.0"');
    expect(gainXmp).toContain('hdrgm:HDRCapacityMax="2.3"');
    expect(gainXmp).toContain('apdi:AuxiliaryImageType="urn:com:apple:photo:2020:aux:hdrgainmap"');
    expect(gainXmp).toContain('HDRGainMap:HDRGainMapHeadroom="8"');
    expect(gainXmp).toContain('<hdrgm:GainMapMax><rdf:Seq><rdf:li>2.5</rdf:li><rdf:li>2.4</rdf:li><rdf:li>2.3</rdf:li></rdf:Seq></hdrgm:GainMapMax>');
    expect(app(gainMap, 0xe2, 'urn:iso:std:iso:ts:21496:-1\0')).toBeDefined();
    const primaryXmp = app(primary, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8');
    expect(primaryXmp).toContain('hdrgm:Version="1.0"');
    expect(primaryXmp).toContain(`Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMap.length}"`);
    expect(primaryXmp).not.toContain('MotionPhoto');
    expect(primaryXmp).toContain('Jane Doe');
    expect(cleanPhoto(out)!.changed).toBe(false);
  });

  it('falls back to the plain picture when the index points somewhere that is not an image', () => {
    const out = cleanPhoto(ultraHdr(3).file)!.data;
    expect(out.indexOf(Buffer.from('MPF\0', 'latin1'))).toBe(-1);
    expect(out.subarray(out.length - 2).equals(EOI)).toBe(true);
    const xmp = app(out, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8');
    expect(xmp).not.toMatch(/hdrgm|Container/);
  });
});

// ---------------------------------------------------------------------------

describe('photo metadata in PNG', () => {
  it('keeps picture and colour chunks, credits and orientation, and drops the rest', () => {
    const png = Buffer.concat([
      PNG_SIG,
      IHDR,
      chunk('iCCP', Buffer.concat([Buffer.from('Monitor\0\0', 'latin1'), deflateSync(icc('desc', 'meta'))])),
      chunk('gAMA', be32(45455)),
      chunk('tEXt', Buffer.from('Author\0Jane Doe', 'latin1')),
      chunk('tEXt', Buffer.from('Comment\0Taken at 12 Main St', 'latin1')),
      chunk('eXIf', cameraExif(false, 8)),
      chunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\x01\0\0\0', 'latin1'), deflateSync(Buffer.from(CAMERA_XMP))])),
      chunk('tIME', Buffer.alloc(7)),
      chunk('iDOT', Buffer.alloc(28)),
      IDAT,
      IEND,
      Buffer.from('TRAILING')
    ]);
    const r = cleanPhoto(png)!;
    expect(r).toMatchObject({ changed: true, location: true, device: true });
    const chunks = pngChunks(r.data);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'iCCP', 'gAMA', 'tEXt', 'eXIf', 'iTXt', 'IDAT', 'IEND']);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    expect(r.data.toString('latin1')).not.toMatch(/Main St|SERIAL|TRAILING/);
    const exif = readTiff(chunks.find((c) => c.type === 'eXIf')!.data);
    expect(exif.short(exif.ifd0, 0x0112)).toBe(8);
    expect(exif.ifd0.has(0x8825)).toBe(false);
    expect(chunks.find((c) => c.type === 'iTXt')!.data.toString('utf8')).toContain('<rdf:li>Jane Doe</rdf:li>');
    expect(chunks.find((c) => c.type === 'tEXt')!.data.toString('latin1')).toBe('Author\0Jane Doe');
    expect(cleanPhoto(r.data)!.changed).toBe(false);
  });

  it('drops chunks whose checksum fails, notices the device that made it, and renames the profile', () => {
    const bad = chunk('eXIf', cameraExif(false, 6));
    bad.writeUInt32BE(bad.readUInt32BE(bad.length - 4) ^ 1, bad.length - 4);
    const png = Buffer.concat([PNG_SIG, IHDR, chunk('iCCP', Buffer.concat([Buffer.from('DELL U2720Q SN 4471\0\0', 'latin1'), deflateSync(icc('desc'))])), bad, chunk('tEXt', Buffer.from('Source\0Acme Camera 2.1', 'latin1')), chunk('iTXt', Buffer.from('Copyright\0\0\0en\0SERIAL-55\0(c) Jane', 'latin1')), IDAT, IEND]);
    const r = cleanPhoto(png)!;
    expect(r).toMatchObject({ location: false, device: true });
    const chunks = pngChunks(r.data);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'iCCP', 'iTXt', 'IDAT', 'IEND']);
    expect(chunks[1].data.toString('latin1', 0, 12)).toBe('ICC profile\0');
    // The copyright stays; the free text in its translated-keyword field does not.
    expect(chunks[2].data.toString('latin1')).toBe('Copyright\0\0\0\0\0(c) Jane');
    expect(r.data.toString('latin1')).not.toMatch(/DELL|Acme|SERIAL/);
    // A software name is dropped too, but it names a program, not a device.
    expect(photoMetadata(Buffer.concat([PNG_SIG, IHDR, chunk('tEXt', Buffer.from('Software\0Editor 2', 'latin1')), IDAT, IEND]))).toEqual({ location: false, device: false });
  });

  it('refuses a PNG with a critical chunk it does not know', () => {
    expect(cleanPhoto(Buffer.concat([PNG_SIG, IHDR, chunk('ZZZZ', Buffer.alloc(2)), IDAT, IEND]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function riff(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, 'latin1'), le32(data.length), data, Buffer.alloc(data.length & 1)]);
}
function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(body.length), body]);
}
function riffChunks(buf: Buffer, start: number, end: number): Array<{ type: string; data: Buffer }> {
  const out = [];
  for (let p = start; p < end; ) {
    const len = buf.readUInt32LE(p + 4);
    out.push({ type: buf.toString('latin1', p, p + 4), data: buf.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len & 1);
  }
  return out;
}

describe('photo metadata in WebP', () => {
  it('rebuilds EXIF, drops XMP without credits, and keeps the header flags and size true', () => {
    // ICC, EXIF, XMP and animation flagged, with two bytes past the header's defined ten.
    const vp8x = Buffer.from([0x2e, 0, 0, 0, 3, 0, 0, 2, 0, 0, 0x53, 0x4e]);
    const frameHeader = Buffer.from([1, 0, 0, 2, 0, 0, 3, 0, 0, 2, 0, 0, 100, 0, 0, 2]);
    const frame = Buffer.concat([frameHeader, riff('VP8L', Buffer.alloc(7, 9)), riff('XYZW', Buffer.from('GPS in a frame'))]);
    const input = webp(riff('VP8X', vp8x), riff('ICCP', icc('desc')), riff('ANIM', Buffer.alloc(6)), riff('ANMF', frame), riff('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), cameraExif()])), riff('XMP ', Buffer.from(xmpPacket('', ' exif:GPSLatitude="1,1N"'))), riff('UNKN', Buffer.from('private')));
    const r = cleanPhoto(input)!;
    expect(r.location).toBe(true);
    const out = r.data;
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    const chunks = riffChunks(out, 12, out.length);
    expect(chunks.map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'ANIM', 'ANMF', 'EXIF']);
    expect(chunks[0].data).toEqual(Buffer.from([0x2a, 0, 0, 0, 3, 0, 0, 2, 0, 0])); // ICC, EXIF and animation; no XMP
    expect(chunks[3].data.subarray(0, 16)).toEqual(frameHeader);
    expect(chunks[3].data.toString('latin1')).not.toContain('GPS');
    expect(chunks[3].data.subarray(16).equals(riff('VP8L', Buffer.alloc(7, 9)))).toBe(true);
    const exif = readTiff(chunks[4].data);
    expect(exif.short(exif.ifd0, 0x0112)).toBe(6);
    expect(out.toString('latin1')).not.toMatch(/private|SERIAL/);
    expect(cleanPhoto(out)!.changed).toBe(false);
  });

  it('leaves a simple WebP as it is', () => {
    const simple = webp(riff('VP8L', Buffer.alloc(9, 4)));
    expect(cleanPhoto(simple)).toMatchObject({ changed: false });
  });
});

// ---------------------------------------------------------------------------

describe('photo metadata in GIF', () => {
  it('keeps frames, timing and looping, and drops comments, XMP and trailing bytes', () => {
    const header = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([2, 0, 2, 0, 0x80, 0, 0]), Buffer.alloc(6, 1)]);
    const sub = (s: Buffer) => Buffer.concat([Buffer.from([s.length]), s]);
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe]), sub(Buffer.from('Taken at 12 Main St')), Buffer.from([0])]);
    const loop = Buffer.concat([Buffer.from([0x21, 0xff]), sub(Buffer.from('NETSCAPE2.0')), sub(Buffer.from([1, 0, 0])), Buffer.from([0])]);
    const xmp = Buffer.concat([Buffer.from([0x21, 0xff]), sub(Buffer.from('XMP DataXMP')), sub(Buffer.from('<x exif:GPSLatitude="1,1N"/>')), Buffer.from([0])]);
    const gce = Buffer.from([0x21, 0xf9, 4, 1, 10, 0, 0, 0]);
    const image = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0]), Buffer.from([2]), sub(Buffer.from([0x44, 0x01])), Buffer.from([0])]);
    const gif = Buffer.concat([header, comment, loop, xmp, gce, image, gce, image, Buffer.from([0x3b]), Buffer.from('junk')]);
    const r = cleanPhoto(gif)!;
    expect(r.location).toBe(true);
    expect(r.data.equals(Buffer.concat([header, loop, gce, image, gce, image, Buffer.from([0x3b])]))).toBe(true);
  });
});

describe('photo metadata in GIF, rights and colour', () => {
  it('keeps the rights from XMP in Adobe’s framing, and a cleaned colour profile', () => {
    const header = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([2, 0, 2, 0, 0, 0, 0])]);
    const trailer = Buffer.from([0x01, ...Array.from({ length: 256 }, (_, k) => 255 - k), 0x00]);
    const xmpExt = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('XMP DataXMP'), Buffer.from(xmpPacket('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Licensed to Client Co</rdf:li></rdf:Alt></dc:rights>', ' exif:GPSLatitude="1,1N"')), trailer]);
    const profile = icc('desc', 'rXYZ', 'meta');
    const sub = (d: Buffer) => Buffer.concat([...Array.from({ length: Math.ceil(d.length / 255) }, (_, k) => Buffer.concat([Buffer.from([Math.min(255, d.length - k * 255)]), d.subarray(k * 255, k * 255 + 255)])), Buffer.from([0])]);
    const iccExt = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from('ICCRGBG1012'), sub(profile)]);
    const image = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0]), Buffer.from([2]), Buffer.from([2, 0x44, 0x01, 0])]);
    const r = cleanPhoto(Buffer.concat([header, iccExt, xmpExt, image, Buffer.from([0x3b])]))!;
    expect(r).toMatchObject({ location: true, device: true });
    const text = r.data.toString('latin1');
    expect(text).toContain('Licensed to Client Co');
    expect(text).not.toMatch(/GPS|meta-DATA|APPL/);
    expect(text).toContain('rXYZ-DATA');
    // A reader walking the XMP extension as sub-blocks lands exactly on its terminator.
    const at = r.data.indexOf(Buffer.from('XMP DataXMP')) + 11;
    let w = at;
    while (r.data[w] !== 0) w += 1 + r.data[w];
    expect(r.data.subarray(w - 256, w + 1).equals(trailer.subarray(1))).toBe(true);
    expect(cleanPhoto(r.data)!.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('photo metadata in AVIF and HEIC', () => {
  const box = (type: string, ...body: Buffer[]) => {
    const b = Buffer.concat(body);
    return Buffer.concat([be32(b.length + 8), Buffer.from(type, 'latin1'), b]);
  };
  const full = (type: string, ...body: Buffer[]) => box(type, Buffer.alloc(4), ...body);

  /** Image item 1, Exif item 2 and XMP item 3 in mdat, with a stale XMP copy no item points at. */
  type HeifOpts = { overlap?: boolean; extra?: Buffer; prop?: Buffer; contentType?: string; xmp?: Buffer; openXmp?: boolean; method2?: boolean; colr?: Buffer; imageName?: string; xmpName?: string; image?: Buffer; imageType?: string; handlerName?: string };
  function heif(opts: HeifOpts = {}): { file: Buffer; image: Buffer } {
    const image = opts.image ?? Buffer.alloc(40, 0xab);
    const exif = Buffer.concat([be32(6), Buffer.from('Exif\0\0', 'latin1'), cameraExif()]);
    const xmp = opts.xmp ?? Buffer.from(CAMERA_XMP);
    const stale = Buffer.from(xmpPacket('', ' exif:GPSLatitude="9,9N"'));
    const infe = (id: number, type: string, extra = Buffer.alloc(0)) => box('infe', Buffer.from([2, 0, 0, 0]), be16(id), be16(0), Buffer.from(type, 'latin1'), extra);
    const iinf = full('iinf', be16(3), infe(1, opts.imageType ?? 'av01', Buffer.from(`${opts.imageName ?? ''}\0`, 'utf8')), infe(2, 'Exif'), infe(3, 'mime', Buffer.from(`${opts.xmpName ?? ''}\0${opts.contentType ?? 'application/rdf+xml'}\0`, 'latin1')));
    // Version 1 carries a construction method per item: item 1 can then claim to be built from other items.
    const v1 = !!opts.method2;
    const iloc = (base: number) => {
      const item = (id: number, off: number, len: number, method = 0) => Buffer.concat([be16(id), ...(v1 ? [be16(method)] : []), be16(0), be16(1), be32(off), be32(len)]);
      return box('iloc', Buffer.from([v1 ? 1 : 0, 0, 0, 0]), Buffer.from([0x44, 0x00]), be16(3), item(1, base, image.length, opts.method2 ? 2 : 0), item(2, opts.overlap ? base + 10 : base + image.length, exif.length), item(3, base + image.length + exif.length, opts.openXmp ? 0 : xmp.length));
    };
    const ftyp = box('ftyp', Buffer.from('avif\0\0\0\0avifmif1', 'latin1'));
    const props = [full('ispe', be32(4), be32(4)), ...(opts.colr ? [box('colr', Buffer.from('prof', 'latin1'), opts.colr)] : []), ...(opts.prop ? [opts.prop] : [])];
    const meta = (base: number) => full('meta', full('hdlr', Buffer.alloc(4), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from(`${opts.handlerName ?? ''}\0`, 'latin1')), full('pitm', be16(1)), iloc(base), iinf, box('iprp', box('ipco', ...props)));
    const base = ftyp.length + meta(0).length + 8;
    const file = Buffer.concat([ftyp, meta(base), box('mdat', image, exif, xmp, ...(opts.openXmp ? [] : [stale])), ...(opts.openXmp ? [] : [box('free', Buffer.from('GPS old copy'))]), ...(opts.extra ? [opts.extra] : [])]);
    return { file, image };
  }

  it('rewrites Exif and XMP items in place and clears bytes no item refers to', () => {
    const { file, image } = heif();
    expect(sniffImageType(file)).toBe('image/heif');
    const r = cleanPhoto(file)!;
    expect(r).toMatchObject({ changed: true, location: true, device: true });
    expect(r.data.length).toBe(file.length);
    const text = r.data.toString('latin1');
    expect(text).not.toMatch(/GPSLatitude|SERIAL|Acme|Springfield|old copy/);
    expect(text).toContain('Jane Doe Photography');
    expect(text).toContain('<rdf:li>Jane Doe</rdf:li>');
    const at = file.indexOf(image);
    expect(r.data.subarray(at, at + image.length).equals(image)).toBe(true);
    // The Exif item still starts with its header offset, now 0, then a TIFF block that keeps the orientation.
    const exifAt = at + image.length;
    expect(r.data.readUInt32BE(exifAt)).toBe(0);
    const exif = readTiff(r.data.subarray(exifAt + 4));
    expect(exif.short(exif.ifd0, 0x0112)).toBe(6);
    expect(cleanPhoto(r.data)!.changed).toBe(false);
  });

  it('clears a colour profile’s identifying header fields and description in place', () => {
    const { file } = heif({ colr: icc('desc', 'rXYZ') });
    const r = cleanPhoto(file)!;
    expect(r.data.length).toBe(file.length);
    expect(r.data.toString('latin1')).not.toMatch(/APPLMDL9|lcms/);
    expect(r.data.toString('latin1')).toContain('rXYZ-DATA');
    expect(r.data.toString('latin1')).toContain('Display P3');
    const custom = heif({ colr: icc('desc:Studio monitor SN 4471 calibrated', 'rXYZ') }).file;
    const c = cleanPhoto(custom)!;
    expect(c.data.length).toBe(custom.length);
    expect(c.data.toString('latin1')).not.toContain('4471');
    expect(c.data.toString('latin1')).toContain('ICC profile');
  });

  it('clears an item name that says more than what the item is, and refuses one on a document item', () => {
    const { file } = heif({ imageName: '12 Main St' });
    const r = cleanPhoto(file)!;
    expect(r.data.length).toBe(file.length);
    expect(r.data.toString('latin1')).not.toContain('Main St');
    expect(cleanPhoto(heif({ imageName: 'Color' }).file)!.data.toString('latin1')).toContain('Color');
    expect(cleanPhoto(heif({ xmpName: '12 Main St' }).file)).toBeNull();
  });

  it('refuses a JPEG-coded item that carries metadata, and clears a free-text handler name', () => {
    expect(cleanPhoto(heif({ imageType: 'jpeg', image: geotaggedJpeg() }).file)).toBeNull();
    expect(cleanPhoto(heif({ imageType: 'jpeg', image: Buffer.concat([SOI, JFIF, IMAGE_DATA, EOI]) }).file)).not.toBeNull();
    const { file } = heif({ handlerName: 'Shot at 51.5N 0.12W' });
    const r = cleanPhoto(file)!;
    expect(r.data.length).toBe(file.length);
    expect(r.data.toString('latin1')).not.toContain('51.5N');
  });

  it('fits credits into a small XMP item by leaving out the packet wrapper', () => {
    const tight = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:Credit="Studio"/></rdf:RDF></x:xmpmeta>`.padEnd(330));
    const r = cleanPhoto(heif({ xmp: tight }).file)!;
    expect(r.data.toString('latin1')).toContain('photoshop:Credit="Studio"/>');
    expect(r.data.toString('latin1')).not.toContain('xpacket');
  });

  it('cleans an XMP item too small for any rebuilt packet, losing only its credit', () => {
    const tiny = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:p="http://ns.adobe.com/photoshop/1.0/" p:Credit="Jane Doe"/></rdf:RDF></x:xmpmeta>`);
    const { file } = heif({ xmp: tiny });
    const r = cleanPhoto(file)!;
    expect(r).not.toBeNull();
    expect(r.data.length).toBe(file.length);
    expect(r.data.toString('latin1')).toContain('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
  });

  it('refuses what it cannot rewrite in place: descriptions, other documents, open-ended or derived extents', () => {
    expect(cleanPhoto(heif({ prop: box('udes', Buffer.alloc(4), Buffer.from('en\0Front door\x0012 Main St\0\0', 'latin1')) }).file)).toBeNull();
    expect(cleanPhoto(heif({ contentType: 'application/json' }).file)).toBeNull();
    expect(cleanPhoto(heif({ openXmp: true }).file)).toBeNull();
    expect(cleanPhoto(heif({ method2: true }).file)).toBeNull();
    // Each refusal is the option's doing: the same file without it cleans.
    expect(cleanPhoto(heif({ prop: full('pixi', Buffer.from([3, 8, 8, 8])) }).file)).not.toBeNull();
  });

  it('refuses overlapping items, image sequences and unknown boxes', () => {
    expect(cleanPhoto(heif({ overlap: true }).file)).toBeNull();
    const moov = Buffer.concat([be32(16), Buffer.from('moov', 'latin1'), be32(8), Buffer.from('udta', 'latin1')]);
    expect(cleanPhoto(heif({ extra: moov }).file)).toBeNull();
    expect(cleanPhoto(heif({ extra: Buffer.concat([be32(12), Buffer.from('uuid', 'latin1'), Buffer.from('GPS!')]) }).file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('credits on responsive copies', () => {
  it('copies the original’s credits, without its orientation, onto a JPEG copy', () => {
    const { credits } = cleanPhoto(geotaggedJpeg())!;
    const variant = Buffer.concat([SOI, JFIF, IMAGE_DATA, EOI]);
    const out = addCredits(variant, credits);
    expect(out.subarray(0, 2 + JFIF.length).equals(Buffer.concat([SOI, JFIF]))).toBe(true);
    const exif = readTiff(app(out, 0xe1, 'Exif\0\0')!);
    expect([...exif.ifd0.keys()].sort()).toEqual([0x013b, 0x8298]);
    expect(app(out, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8')).toContain('Jane Doe');
    expect(app(out, 0xed, 'Photoshop 3.0\0')!.toString('latin1')).toContain('(c) Jane Doe');
    const again = cleanPhoto(out)!;
    expect(again).toMatchObject({ changed: false, location: false, device: false });
    expect(imageInfo(out, 'image/jpeg')?.orientation).toBe(1);
  });

  it('copies credits onto a PNG copy right after its header', () => {
    const original = Buffer.concat([PNG_SIG, IHDR, chunk('tEXt', Buffer.from('Copyright\0(c) Jane Doe', 'latin1')), chunk('eXIf', cameraExif()), IDAT, IEND]);
    const { credits } = cleanPhoto(original)!;
    const out = addCredits(Buffer.concat([PNG_SIG, IHDR, IDAT, IEND]), credits);
    const chunks = pngChunks(out);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'eXIf', 'tEXt', 'IDAT', 'IEND']);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const exif = readTiff(chunks[1].data);
    expect(exif.ifd0.has(0x0112)).toBe(false);
    expect(cleanPhoto(out)!.changed).toBe(false);
  });

  it('leaves metadata a copy already has as it is, without a second block', () => {
    const { credits } = cleanPhoto(geotaggedJpeg())!;
    const turned = Buffer.concat([SOI, JFIF, exifSeg(tiff(true, { ifd0: [short(true, 0x0112, 6)] })), IMAGE_DATA, EOI]);
    const out = addCredits(turned, credits);
    expect(segments(out).filter((s) => s.marker === 0xe1 && s.payload.toString('latin1', 0, 6) === 'Exif\0\0')).toHaveLength(1);
    expect(imageInfo(out, 'image/jpeg')?.orientation).toBe(6);
    expect(app(out, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8')).toContain('Jane Doe');
    const png = Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', tiff(false, { ifd0: [short(false, 0x0112, 3)] })), IDAT, IEND]);
    const pngCredits = cleanPhoto(Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', cameraExif()), chunk('tEXt', Buffer.from('Author\0Jane', 'latin1')), IDAT, IEND]))!.credits;
    const pngOut = pngChunks(addCredits(png, pngCredits));
    expect(pngOut.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'eXIf', 'IDAT', 'IEND']);
  });

  it('adds nothing when there are no credits', () => {
    const variant = Buffer.concat([SOI, JFIF, IMAGE_DATA, EOI]);
    expect(addCredits(variant, {})).toBe(variant);
  });
});
