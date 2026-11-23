/** Hand-built image files for the photo metadata tests, written independently of the code under test. */
import { crc32, deflateSync } from 'node:zlib';

export const be16 = (n: number) => Buffer.from([n >> 8, n & 255]);
export const be32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
export const le32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

export type Entry = { tag: number; type: number; count: number; value: Buffer } | { tag: number; ptr: 'exif' | 'gps' | 'interop' };
export type Dirs = { ifd0: Entry[]; exif?: Entry[]; gps?: Entry[]; interop?: Entry[]; ifd1?: Entry[] };
const ORDER = ['ifd0', 'exif', 'gps', 'interop', 'ifd1'] as const;

/** A TIFF block with the given directories; IFD1 (the thumbnail) is chained from IFD0. */
export function tiff(le: boolean, dirs: Dirs): Buffer {
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    if (le) b.writeUInt16LE(n);
    else b.writeUInt16BE(n);
    return b;
  };
  const u32 = (n: number) => (le ? le32(n) : be32(n));
  const present = ORDER.filter((d) => dirs[d]);
  const size = (entries: Entry[]) => 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + ('value' in e && e.value.length > 4 ? e.value.length + (e.value.length & 1) : 0), 0);
  const starts: Record<string, number> = {};
  let at = 8;
  for (const d of present) {
    starts[d] = at;
    at += size(dirs[d]!);
  }
  const parts: Buffer[] = [Buffer.from(le ? 'II' : 'MM', 'latin1'), u16(42), u32(8)];
  for (const d of present) {
    const entries = [...dirs[d]!].sort((a, b) => a.tag - b.tag);
    const head: Buffer[] = [u16(entries.length)];
    const data: Buffer[] = [];
    let dataAt = starts[d] + 2 + entries.length * 12 + 4;
    for (const e of entries) {
      if ('ptr' in e) {
        head.push(u16(e.tag), u16(4), u32(1), u32(starts[e.ptr]));
        continue;
      }
      head.push(u16(e.tag), u16(e.type), u32(e.count));
      if (e.value.length <= 4) head.push(Buffer.concat([e.value, Buffer.alloc(4 - e.value.length)]));
      else {
        head.push(u32(dataAt));
        data.push(e.value, Buffer.alloc(e.value.length & 1));
        dataAt += e.value.length + (e.value.length & 1);
      }
    }
    head.push(u32(d === 'ifd0' && dirs.ifd1 ? starts.ifd1 : 0));
    parts.push(...head, ...data);
  }
  return Buffer.concat(parts);
}

export const ascii = (tag: number, s: string) => ({ tag, type: 2, count: s.length + 1, value: Buffer.from(s + '\0', 'latin1') });
export const short = (le: boolean, tag: number, n: number) => ({ tag, type: 3, count: 1, value: le ? Buffer.from([n & 255, n >> 8]) : be16(n) });
export const undef = (tag: number, value: Buffer) => ({ tag, type: 7, count: value.length, value });
export const rationals = (le: boolean, tag: number, ...n: number[]) => ({ tag, type: 5, count: n.length, value: Buffer.concat(n.flatMap((v) => (le ? [le32(v), le32(1)] : [be32(v), be32(1)]))) });

/** Camera EXIF with everything a phone writes: place, device, serials, maker notes, a thumbnail, and credits. */
export function cameraExif(le = true, orientation = 6): Buffer {
  return tiff(le, {
    ifd0: [ascii(0x010f, 'Acme'), ascii(0x0110, 'Phone X'), short(le, 0x0112, orientation), ascii(0x013b, 'Jane Doe Photography'), ascii(0x8298, '(c) 2026 Jane Doe'), ascii(0x0131, 'Firmware 1.2.3'), { tag: 0x8769, ptr: 'exif' }, { tag: 0x8825, ptr: 'gps' }],
    exif: [undef(0x9000, Buffer.from('0232')), short(le, 0xa001, 0xffff), ascii(0xa431, 'SERIAL-12345'), ascii(0xa434, 'Acme 24mm'), undef(0x927c, Buffer.from('MAKERNOTE-PRIVATE-DATA')), { tag: 0xa005, ptr: 'interop' }],
    gps: [ascii(0x0001, 'N'), rationals(le, 0x0002, 51, 30, 12), ascii(0x0003, 'W'), rationals(le, 0x0004, 0, 7, 39)],
    interop: [ascii(0x0001, 'R03'), undef(0x0002, Buffer.from('0100'))],
    ifd1: [{ tag: 0x0201, type: 4, count: 1, value: le ? le32(0) : be32(0) }]
  });
}

/** Read back a TIFF block: tags of each directory by number, and whether a GPS directory or a thumbnail exists. */
export function readTiff(buf: Buffer) {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  const dir = (off: number) => {
    const tags = new Map<number, Buffer>();
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      const len = sizes[u16(e + 2)] * u32(e + 4);
      const at = len <= 4 ? e + 8 : u32(e + 8);
      tags.set(u16(e), buf.subarray(at, at + len));
    }
    return { tags, next: u32(off + 2 + n * 12) };
  };
  const ifd0 = dir(u32(4));
  const ptr = (t: Map<number, Buffer>, tag: number) => (t.has(tag) ? (le ? t.get(tag)!.readUInt32LE(0) : t.get(tag)!.readUInt32BE(0)) : null);
  const exifAt = ptr(ifd0.tags, 0x8769);
  const exif = exifAt === null ? null : dir(exifAt);
  const interopAt = exif && ptr(exif.tags, 0xa005);
  return {
    ifd0: ifd0.tags,
    thumbnail: ifd0.next !== 0,
    exif: exif?.tags ?? null,
    interop: interopAt ? dir(interopAt).tags : null,
    text: (t: Map<number, Buffer> | null, tag: number) => t?.get(tag)?.toString('latin1').replace(/\0+$/, ''),
    short: (t: Map<number, Buffer> | null, tag: number) => (t?.has(tag) ? u16(t.get(tag)!.byteOffset - buf.byteOffset) : undefined)
  };
}

export const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), be16(payload.length + 2), payload]);
export const SOI = Buffer.from([0xff, 0xd8]);
export const EOI = Buffer.from([0xff, 0xd9]);
export const JFIF = seg(0xe0, Buffer.from([...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0]));
export const exifSeg = (t: Buffer) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]));
export const xmpSeg = (x: string) => seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(x, 'utf8')]));

/** Frame, tables and two scans of entropy-coded data with stuffed bytes, restart markers and fill. */
export const IMAGE_DATA = Buffer.concat([
  seg(0xdb, Buffer.alloc(65, 1)),
  seg(0xc2, Buffer.from([8, 0, 4, 0, 6, 1, 1, 0x11, 0])),
  seg(0xc4, Buffer.alloc(20, 2)),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00]),
  seg(0xc4, Buffer.alloc(20, 3)),
  seg(0xda, Buffer.from([1, 1, 0, 1, 63, 0])),
  Buffer.from([0x78, 0xff, 0x00, 0x9a, 0xff, 0xff])
]);

export function xmpPacket(body: string, attrs = ''): string {
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"${attrs}>${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}
export const CAMERA_XMP = xmpPacket(
  '<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator><dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Jane Doe</rdf:li></rdf:Alt></dc:rights><photoshop:City>Springfield</photoshop:City><tiff:Model>Phone X</tiff:Model>',
  ' exif:GPSLatitude="51,30.2N" exif:GPSLongitude="0,7.65W" photoshop:Credit="Jane Doe Studio"'
);

/** IPTC inside a Photoshop resource block: city, by-line and copyright, plus a thumbnail resource. */
export function photoshopSeg(): Buffer {
  const ds = (rec: number, id: number, s: string) => Buffer.concat([Buffer.from([0x1c, rec, id]), be16(Buffer.byteLength(s)), Buffer.from(s)]);
  const iptc = Buffer.concat([ds(1, 90, '\x1b%G'), ds(2, 0, '\0\x04'), ds(2, 90, 'Springfield'), ds(2, 80, 'Jane Doe'), ds(2, 116, '(c) Jane Doe'), ds(2, 120, 'Our client’s house')]);
  const res = (id: number, data: Buffer) => Buffer.concat([Buffer.from('8BIM'), be16(id), Buffer.from([0, 0]), be32(data.length), data, Buffer.alloc(data.length & 1)]);
  return seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), res(0x040c, Buffer.from('THUMBNAIL')), res(0x0404, iptc)]));
}

/**
 * A minimal ICC profile with the given tags, each holding its signature as data, except "desc", which holds a
 * real version 2 description ("desc:Text" sets its text; "Display P3" otherwise).
 */
export function icc(...sigs: string[]): Buffer {
  const header = Buffer.alloc(128);
  header.write('acsp', 36, 'latin1');
  // Device manufacturer and model, the profile's creator, and its ID.
  header.write('APPLMDL9', 48, 'latin1');
  header.write('lcms', 80, 'latin1');
  header.fill(7, 84, 100);
  const tags = sigs.map((spec) => {
    const [sig, text] = spec.split(':');
    if (sig !== 'desc') return { sig, data: Buffer.from(`${sig}-DATA-${sig}`.padEnd(12, '.').slice(0, 12), 'latin1') };
    const ascii = Buffer.from(`${text ?? 'Display P3'}\0`, 'latin1');
    const data = Buffer.concat([Buffer.from('desc', 'latin1'), Buffer.alloc(4), be32(ascii.length), ascii, Buffer.alloc(78)]);
    return { sig, data: Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]) };
  });
  let at = 132 + tags.length * 12;
  const table: Buffer[] = [be32(tags.length)];
  for (const t of tags) {
    table.push(Buffer.from(t.sig, 'latin1'), be32(at), be32(t.data.length));
    at += t.data.length;
  }
  const profile = Buffer.concat([header, ...table, ...tags.map((t) => t.data)]);
  profile.writeUInt32BE(profile.length, 0);
  return profile;
}
export const iccTags = (p: Buffer) => Array.from({ length: p.readUInt32BE(128) }, (_, k) => p.toString('latin1', 132 + k * 12, 136 + k * 12));
export const iccSeg = (p: Buffer) => seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), p]));

/** Segments of a JPEG up to its first scan, by marker and payload. */
export function segments(buf: Buffer): Array<{ marker: number; payload: Buffer }> {
  const out: Array<{ marker: number; payload: Buffer }> = [];
  let i = 2;
  while (i < buf.length && buf[i + 1] !== 0xda) {
    const len = buf.readUInt16BE(i + 2);
    out.push({ marker: buf[i + 1], payload: buf.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}
export const app = (buf: Buffer, marker: number, prefix: string) => segments(buf).find((s) => s.marker === marker && s.payload.toString('latin1', 0, prefix.length) === prefix)?.payload.subarray(prefix.length);

export function geotaggedJpeg(le = true, orientation = 6): Buffer {
  return Buffer.concat([SOI, JFIF, exifSeg(cameraExif(le, orientation)), xmpSeg(CAMERA_XMP), iccSeg(icc('desc', 'rXYZ', 'meta', 'dmdd')), photoshopSeg(), seg(0xfe, Buffer.from('Shot at 12 Main St')), IMAGE_DATA, EOI, Buffer.from('MOTION-PHOTO-VIDEO GPSLatitude 51.5')]);
}

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function chunk(type: string, data: Buffer): Buffer {
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([be32(data.length), td, be32(crc32(td))]);
}
export function pngChunks(buf: Buffer): Array<{ type: string; data: Buffer; crcOk: boolean }> {
  const out = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len), crcOk: crc32(buf.subarray(p + 4, p + 8 + len)) === buf.readUInt32BE(p + 8 + len) });
    p += 12 + len;
  }
  return out;
}
export const IHDR = chunk('IHDR', Buffer.from([0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0, 0]));
export const IDAT = chunk('IDAT', deflateSync(Buffer.alloc(3 * 17)));
export const IEND = chunk('IEND', Buffer.alloc(0));
