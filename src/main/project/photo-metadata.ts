/**
 * Keeping private photo metadata out of public website files: where a photo was taken, and the camera, lens,
 * software and owner that made it. Files are rebuilt from an allowlist rather than scrubbed of a blocklist, so a
 * tag nobody thought of never slips through. What a visitor needs to see the picture as the author does stays:
 * orientation, colour profiles and colour-space hints, and HDR gain maps. Credit and rights statements stay too.
 * Pure functions over bytes, so they are tested without Electron.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface PhotoMetadata {
  /** The file records where it was taken: GPS coordinates, or a place name in IPTC or XMP. */
  location: boolean;
  /** The file names the device or software that made it: make, model, serial numbers, lens, maker notes. */
  device: boolean;
}

/** Credit and rights metadata, kept so it can be copied onto the smaller copies of a photo. */
export interface PhotoCredits {
  /** A TIFF block holding only Artist and Copyright. */
  tiff?: Buffer;
  /** An XMP packet holding only credit and rights properties. */
  xmp?: Buffer;
  /** A Photoshop resource block holding only the IPTC credit datasets (JPEG). */
  iptc?: Buffer;
  /** PNG text chunks (type and data) for Author and Copyright. */
  text?: Buffer[];
}

export interface CleanedPhoto extends PhotoMetadata {
  /** The bytes to publish. The input buffer itself when there was nothing to remove. */
  data: Buffer;
  /** Whether anything was removed. */
  changed: boolean;
  credits: PhotoCredits;
}

/**
 * The raster type of an image going by its bytes, whatever its name or recorded type says. HEIF covers AVIF
 * and HEIC, which share one container.
 */
export function sniffImageType(head: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heif' | 'image/tiff' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.test(head.toString('latin1', 8, Math.min(head.length, 64)))) return 'image/heif';
  // TIFF carries EXIF and GPS natively and cannot be rewritten here: recognised so it is refused, not passed on.
  if (head.length >= 4 && /^(II\*\0|MM\0\*)$/.test(head.toString('latin1', 0, 4))) return 'image/tiff';
  return null;
}

/**
 * A copy of the image without location, device and other private metadata, or null when the file is not an
 * image this understands or its structure cannot be followed safely. Null never means "nothing to remove": the
 * caller must not publish the file as it is on the strength of it.
 */
export function cleanPhoto(buf: Buffer): CleanedPhoto | null {
  try {
    const r = cleanByType(buf);
    if (!r) return null;
    if (r.data.equals(buf)) return { ...r, data: buf, changed: false };
    return { ...r, changed: true };
  } catch {
    return null;
  }
}

function cleanByType(buf: Buffer): Omit<CleanedPhoto, 'changed'> | null {
  switch (sniffImageType(buf)) {
    case 'image/jpeg':
      return cleanJpeg(buf, false);
    case 'image/png':
      return cleanPng(buf);
    case 'image/webp':
      return cleanWebp(buf);
    case 'image/gif':
      return cleanGif(buf);
    case 'image/heif':
      return cleanHeif(buf);
    default:
      return null;
  }
}

/** What private metadata an image carries; null when it cannot be read. */
export function photoMetadata(buf: Buffer): PhotoMetadata | null {
  const r = cleanPhoto(buf);
  return r && { location: r.location, device: r.device };
}

export function hasCredits(c: PhotoCredits): boolean {
  return !!(c.tiff || c.xmp || c.iptc || c.text?.length);
}

/**
 * Copy credits onto a cleaned JPEG or PNG: a responsive copy of a photo, which the resizer wrote without
 * metadata. Orientation is never copied, because the copy's pixels are already upright. A kind of metadata the
 * copy already carries is left as it is rather than given a second block, which readers would ignore or which
 * would hide the first.
 */
export function addCredits(buf: Buffer, credits: PhotoCredits): Buffer {
  const type = sniffImageType(buf);
  const has = type === 'image/jpeg' || type === 'image/png' ? creditContainers(buf, type) : null;
  if (!has) return buf;
  if (type === 'image/jpeg') {
    const segs = [
      credits.tiff && !has.tiff && segment(0xe1, Buffer.concat([EXIF_HEADER, credits.tiff])),
      credits.xmp && !has.xmp && segment(0xe1, Buffer.concat([XMP_HEADER, credits.xmp])),
      credits.iptc && !has.iptc && segment(0xed, Buffer.concat([PHOTOSHOP_HEADER, credits.iptc]))
    ].filter((s): s is Buffer => !!s);
    if (!segs.length) return buf;
    // After the JFIF header when there is one, which must come first.
    let at = 2;
    if (buf[2] === 0xff && buf[3] === 0xe0) at = 4 + buf.readUInt16BE(4);
    return Buffer.concat([buf.subarray(0, at), ...segs, buf.subarray(at)]);
  }
  const chunks = [
    credits.tiff && !has.tiff && pngChunk('eXIf', credits.tiff),
    credits.xmp && !has.xmp && pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), credits.xmp])),
    ...(credits.text ?? []).filter((c) => !has.text.has(textKeyword(c.subarray(4)))).map((c) => pngChunk(c.toString('latin1', 0, 4), c.subarray(4)))
  ].filter((s): s is Buffer => !!s);
  if (!chunks.length) return buf;
  // Directly after IHDR, which is always first.
  const at = 8 + 12 + buf.readUInt32BE(8);
  return Buffer.concat([buf.subarray(0, at), ...chunks, buf.subarray(at)]);
}

const textKeyword = (data: Buffer) => {
  const nul = data.indexOf(0);
  return nul > 0 ? data.toString('latin1', 0, nul) : '';
};

/** The credit-bearing metadata a JPEG (before its first scan) or PNG already has; null when it cannot be walked. */
function creditContainers(buf: Buffer, type: 'image/jpeg' | 'image/png'): { tiff: boolean; xmp: boolean; iptc: boolean; text: Set<string> } | null {
  const has = { tiff: false, xmp: false, iptc: false, text: new Set<string>() };
  if (type === 'image/jpeg') {
    for (let i = 2; buf[i + 1] !== 0xda; ) {
      if (i + 4 > buf.length || buf[i] !== 0xff) return null;
      const len = buf.readUInt16BE(i + 2);
      const payload = buf.subarray(i + 4, i + 2 + len);
      if (buf[i + 1] === 0xe1 && startsWith(payload, EXIF_HEADER)) has.tiff = true;
      if (buf[i + 1] === 0xe1 && startsWith(payload, XMP_HEADER)) has.xmp = true;
      if (buf[i + 1] === 0xed && startsWith(payload, PHOTOSHOP_HEADER)) has.iptc = true;
      i += 2 + len;
    }
    return has;
  }
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const chunkType = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (chunkType === 'eXIf') has.tiff = true;
    if (chunkType === 'tEXt' || chunkType === 'zTXt' || chunkType === 'iTXt') {
      const keyword = textKeyword(data);
      if (keyword === 'XML:com.adobe.xmp') has.xmp = true;
      else has.text.add(keyword);
    }
    if (chunkType === 'IEND') break;
    p += 12 + len;
  }
  return has;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIF_BRANDS = /avif|avis|mif1|miaf|msf1|heic|heix|heim|heis|hevc/;
const MAX_TEXT = 4096;
/** How far a compressed profile or text chunk may expand. */
const MAX_INFLATE = 16 * 1024 * 1024;

const empty = (): Omit<CleanedPhoto, 'changed' | 'data'> => ({ location: false, device: false, credits: {} });
function merge(into: PhotoMetadata, from: PhotoMetadata) {
  into.location ||= from.location;
  into.device ||= from.device;
}

// ---------------------------------------------------------------------------
// EXIF (TIFF structure), shared by JPEG APP1, PNG eXIf, WebP EXIF and HEIF Exif items
// ---------------------------------------------------------------------------

/** TIFF field types and their sizes in bytes. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

const TAG = {
  orientation: 0x0112,
  artist: 0x013b,
  copyright: 0x8298,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  interopIfd: 0xa005,
  exifVersion: 0x9000,
  colorSpace: 0xa001,
  pixelX: 0xa002,
  pixelY: 0xa003,
  xResolution: 0x011a,
  yResolution: 0x011b,
  resolutionUnit: 0x0128,
  interopIndex: 0x0001,
  interopVersion: 0x0002
};
/**
 * Tags that identify the camera, lens, computer or owner. The software name (0x0131) is dropped like any other
 * unlisted tag but does not count: it identifies a program, not a device.
 */
const DEVICE_TAGS = new Set([0x010f, 0x0110, 0x013c, 0x927c, 0xa420, 0xa430, 0xa431, 0xa432, 0xa433, 0xa434, 0xa435]);
/** Apple maker-note tags for HDR headroom, which Apple's gain-map rendering reads. */
const APPLE_HDR_TAGS = new Set([0x0021, 0x0030]);
const APPLE_NOTE = Buffer.from('Apple iOS\0', 'latin1');

/**
 * A maker note holding only Apple's HDR headroom tags, rebuilt from an Apple maker note, and whether the original
 * held nothing else. Null when the note is not Apple's or has neither tag. The note is big-endian, with offsets
 * from its own start.
 */
function appleHdrNote(note: Buffer): { note: Buffer; only: boolean } | null {
  if (note.length < 16 || !startsWith(note, APPLE_NOTE) || note.toString('latin1', 12, 14) !== 'MM') return null;
  const n = note.readUInt16BE(14);
  if (16 + n * 12 > note.length) return null;
  const kept: Array<{ tag: number; type: number; value: Buffer }> = [];
  for (let k = 0; k < n; k++) {
    const e = 16 + k * 12;
    const tag = note.readUInt16BE(e);
    const type = note.readUInt16BE(e + 2);
    if (!APPLE_HDR_TAGS.has(tag) || ![5, 10, 11, 12].includes(type) || note.readUInt32BE(e + 4) !== 1) continue;
    const size = TYPE_SIZE[type];
    const at = size <= 4 ? e + 8 : note.readUInt32BE(e + 8);
    if (at + size > note.length) continue;
    kept.push({ tag, type, value: note.subarray(at, at + size) });
  }
  if (!kept.length) return null;
  const head = 16 + kept.length * 12 + 4;
  const out = Buffer.alloc(head + kept.reduce((t, f) => t + (f.value.length > 4 ? f.value.length : 0), 0));
  APPLE_NOTE.copy(out, 0);
  note.copy(out, 10, 10, 14); // version and byte order
  out.writeUInt16BE(kept.length, 14);
  let data = head;
  kept.forEach((f, k) => {
    const e = 16 + k * 12;
    out.writeUInt16BE(f.tag, e);
    out.writeUInt16BE(f.type, e + 2);
    out.writeUInt32BE(1, e + 4);
    if (f.value.length <= 4) f.value.copy(out, e + 8);
    else {
      out.writeUInt32BE(data, e + 8);
      f.value.copy(out, data);
      data += f.value.length;
    }
  });
  return { note: out, only: kept.length === n };
}
/** GPS tags that place the photo: latitude, longitude, altitude, area or destination. */
const GPS_PLACE_TAGS = new Set([0x0002, 0x0004, 0x0006, 0x0014, 0x0016, 0x001c]);

interface Field {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes, in the source byte order. */
  value: Buffer;
}

class Tiff {
  readonly le: boolean;
  constructor(readonly buf: Buffer) {
    const order = buf.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') throw new Error('not TIFF');
    this.le = order === 'II';
    if (this.u16(2) !== 42) throw new Error('not TIFF');
  }
  u16(o: number) {
    return this.le ? this.buf.readUInt16LE(o) : this.buf.readUInt16BE(o);
  }
  u32(o: number) {
    return this.le ? this.buf.readUInt32LE(o) : this.buf.readUInt32BE(o);
  }
  /** The fields of the directory at `offset`. Throws past the end of the buffer. */
  ifd(offset: number): Field[] {
    if (offset < 8 || offset + 2 > this.buf.length) throw new Error('bad IFD');
    const n = this.u16(offset);
    if (offset + 2 + n * 12 > this.buf.length) throw new Error('bad IFD');
    const out: Field[] = [];
    for (let k = 0; k < n; k++) {
      const e = offset + 2 + k * 12;
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      // An unknown type cannot be measured; it can still be recognised by its tag.
      const at = size <= 4 ? e + 8 : this.u32(e + 8);
      const value = TYPE_SIZE[type] && at + size <= this.buf.length ? this.buf.subarray(at, at + size) : Buffer.alloc(0);
      out.push({ tag: this.u16(e), type, count, value });
    }
    return out;
  }
  /** A pointer field's target, or null. */
  pointer(fields: Field[], tag: number): number | null {
    const f = fields.find((x) => x.tag === tag);
    if (!f || f.value.length !== 4 || (f.type !== 4 && f.type !== 13)) return null;
    return this.le ? f.value.readUInt32LE(0) : f.value.readUInt32BE(0);
  }
}

interface ExifResult extends PhotoMetadata {
  /** The rebuilt TIFF block, or null when nothing in it is worth keeping. */
  tiff: Buffer | null;
  /** Artist and Copyright alone, for copying onto smaller copies. */
  credits: Buffer | null;
}

/**
 * Rebuild an EXIF TIFF block keeping only orientation, artist and copyright in the first directory, and the
 * colour space (with its interoperability index, which marks Adobe RGB) in the EXIF directory. GPS, maker
 * notes, camera and lens fields and the embedded thumbnail are all left behind. A block whose first directory
 * cannot be read keeps nothing: a browser could not read its orientation either.
 */
function filterExif(tiffBytes: Buffer): ExifResult {
  let t: Tiff;
  let ifd0: Field[];
  try {
    t = new Tiff(tiffBytes);
    ifd0 = t.ifd(t.u32(4));
  } catch {
    return { tiff: null, credits: null, location: false, device: false };
  }
  const read = (offset: number | null): Field[] => {
    if (offset === null) return [];
    try {
      return t.ifd(offset);
    } catch {
      return [];
    }
  };
  const exif = read(t.pointer(ifd0, TAG.exifIfd));
  const gps = read(t.pointer(ifd0, TAG.gpsIfd));
  const interop = read(t.pointer(exif, TAG.interopIfd));
  const location = gps.some((f) => GPS_PLACE_TAGS.has(f.tag));
  // Apple's HDR headroom lives in its maker note; a note reduced to those tags no longer identifies anything.
  const makerNote = exif.find((f) => f.tag === 0x927c);
  const apple = makerNote ? appleHdrNote(makerNote.value) : null;
  const device = [...ifd0, ...exif].some((f) => DEVICE_TAGS.has(f.tag) && !(f === makerNote && apple?.only));

  const short = (f: Field | undefined) => (f && f.type === 3 && f.count === 1 && f.value.length === 2 ? (t.le ? f.value.readUInt16LE(0) : f.value.readUInt16BE(0)) : null);
  const text = (f: Field | undefined) => (f && f.type === 2 && f.count > 1 && f.count <= MAX_TEXT && f.value.length === f.count ? f : null);
  const raw4 = (f: Field | undefined) => (f && f.type === 7 && f.count === 4 && f.value.length === 4 ? f : null);
  const find = (fields: Field[], tag: number) => fields.find((f) => f.tag === tag);

  const rational = (f: Field | undefined) => (f && f.type === 5 && f.count === 1 && f.value.length === 8 ? f : null);
  const dimension = (f: Field | undefined) => (f && (f.type === 3 || f.type === 4) && f.count === 1 && f.value.length === TYPE_SIZE[f.type] ? f : null);
  const credit = [TAG.artist, TAG.copyright].map((tag) => text(find(ifd0, tag))).filter((f): f is Field => !!f);
  const keep0 = [...credit];
  const o = short(find(ifd0, TAG.orientation));
  if (o !== null && o >= 1 && o <= 8) keep0.push(find(ifd0, TAG.orientation)!);
  // Resolution with the pixel dimensions lets browsers show a high-density image (a 144 dpi screenshot) at its
  // intended size. It names nothing.
  for (const f of [rational(find(ifd0, TAG.xResolution)), rational(find(ifd0, TAG.yResolution)), short(find(ifd0, TAG.resolutionUnit)) !== null ? find(ifd0, TAG.resolutionUnit)! : null]) if (f) keep0.push(f);
  const keepExif = [dimension(find(exif, TAG.pixelX)), dimension(find(exif, TAG.pixelY))].filter((f): f is Field => !!f);
  const keepInterop: Field[] = [];
  if (short(find(exif, TAG.colorSpace)) !== null) keepExif.push(find(exif, TAG.colorSpace)!);
  if (apple) keepExif.push({ tag: 0x927c, type: 7, count: apple.note.length, value: apple.note });
  if (keepExif.length) {
    const version = raw4(find(exif, TAG.exifVersion));
    if (version) keepExif.push(version);
  }
  if (short(find(exif, TAG.colorSpace)) !== null) {
    const index = text(find(interop, TAG.interopIndex));
    if (index) {
      keepInterop.push(index);
      const iv = raw4(find(interop, TAG.interopVersion));
      if (iv) keepInterop.push(iv);
    }
  }
  return {
    tiff: keep0.length || keepExif.length ? writeTiff(t.le, keep0, keepExif, keepInterop) : null,
    credits: credit.length ? writeTiff(t.le, credit, [], []) : null,
    location,
    device
  };
}

/** Exactly the fields given, in a fresh TIFF block: first directory, then EXIF, then interoperability. No thumbnail. */
function writeTiff(le: boolean, ifd0: Field[], exif: Field[], interop: Field[]): Buffer {
  const pointer = (tag: number): Field => ({ tag, type: 4, count: 1, value: Buffer.alloc(4) });
  const dirs = [[...ifd0, ...(exif.length ? [pointer(TAG.exifIfd)] : [])], [...exif, ...(exif.length && interop.length ? [pointer(TAG.interopIfd)] : [])], exif.length ? interop : []];
  for (const d of dirs) d.sort((a, b) => a.tag - b.tag);
  // Each directory is followed by its out-of-line values. The first is always written, even when empty.
  const starts: number[] = [];
  let at = 8;
  dirs.forEach((d, n) => {
    starts.push(at);
    if (!d.length && n > 0) return;
    at += 2 + d.length * 12 + 4;
    for (const f of d) if (f.value.length > 4) at += f.value.length + (f.value.length & 1);
  });
  const out = Buffer.alloc(at);
  const w16 = (o: number, v: number) => (le ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const w32 = (o: number, v: number) => (le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  out.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(2, 42);
  w32(4, 8);
  dirs.forEach((d, n) => {
    if (!d.length && n > 0) return;
    const start = starts[n];
    w16(start, d.length);
    let data = start + 2 + d.length * 12 + 4;
    d.forEach((f, k) => {
      const e = start + 2 + k * 12;
      w16(e, f.tag);
      w16(e + 2, f.type);
      w32(e + 4, f.count);
      if (n === 0 && f.tag === TAG.exifIfd) w32(e + 8, starts[1]);
      else if (n === 1 && f.tag === TAG.interopIfd) w32(e + 8, starts[2]);
      else if (f.value.length <= 4) f.value.copy(out, e + 8);
      else {
        w32(e + 8, data);
        f.value.copy(out, data);
        data += f.value.length + (f.value.length & 1);
      }
    });
    // The next-directory offset stays 0: the thumbnail directory is never written.
  });
  return out;
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

const XMP_NS: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  hdrgm: 'http://ns.adobe.com/hdr-gain-map/1.0/',
  apdi: 'http://ns.apple.com/pixeldatainfo/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xmpNote: 'http://ns.adobe.com/xmp/note/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/',
  aux: 'http://ns.adobe.com/exif/1.0/aux/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  Iptc4xmpExt: 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/',
  HDRGainMap: 'http://ns.apple.com/HDRGainMap/1.0/',
  Container: 'http://ns.google.com/photos/1.0/container/',
  Item: 'http://ns.google.com/photos/1.0/container/item/'
};
/** The credit and rights properties an XMP packet keeps, and the shape each is written in. */
const XMP_CREDITS: Array<{ prefix: string; name: string; kind: 'text' | 'Seq' | 'Alt' | 'Bag' }> = [
  { prefix: 'dc', name: 'creator', kind: 'Seq' },
  { prefix: 'dc', name: 'rights', kind: 'Alt' },
  { prefix: 'photoshop', name: 'Credit', kind: 'text' },
  { prefix: 'xmpRights', name: 'Marked', kind: 'text' },
  { prefix: 'xmpRights', name: 'WebStatement', kind: 'text' },
  { prefix: 'xmpRights', name: 'Certificate', kind: 'text' },
  { prefix: 'xmpRights', name: 'UsageTerms', kind: 'Alt' },
  { prefix: 'xmpRights', name: 'Owner', kind: 'Bag' }
];
/** Gain-map rendering parameters (Adobe/Google Ultra HDR): numbers and flags only. */
const HDRGM_PROPS = ['Version', 'BaseRenditionIsHDR', 'GainMapMin', 'GainMapMax', 'Gamma', 'OffsetSDR', 'OffsetHDR', 'HDRCapacityMin', 'HDRCapacityMax'];
const XMP_LOCATION = /GPS(Latitude|Longitude|Altitude|AreaInformation|DestLatitude|DestLongitude)\b|Location(Created|Shown)\b|\b(photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode)|Iptc4xmpExt:(City|Sublocation|ProvinceState|CountryName))\b/;
const XMP_DEVICE = /\b(tiff:(Make|Model)|exifEX:(BodySerialNumber|LensMake|LensModel|LensSerialNumber|CameraOwnerName)|exif:(BodySerialNumber|CameraOwnerName|LensModel)|aux:(SerialNumber|Lens|LensID|LensSerialNumber|OwnerName))\b/;

interface XmpOptions {
  /** A gain-map image: keep its rendering parameters. */
  gainMap?: boolean;
  /** A primary image whose gain maps are kept: the new byte lengths of those images, in file order. */
  container?: number[];
  /** Leave out the xpacket wrapper, for a packet that must fit where the old one was. */
  compact?: boolean;
}

interface XmpResult extends PhotoMetadata {
  /** A new packet with the credit, rights and rendering properties kept, or null when there are none. */
  packet: Buffer | null;
  /** Credit and rights alone. */
  credits: Buffer | null;
}

/** Text that may stand in an XML text node or attribute as it was read: no markup, and no entity but XML's own. */
const PLAIN = /^[^<>]*$/;
const FOREIGN_ENTITY = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Every prefix the packet binds to a namespace's URI: "dc" usually, but any prefix is legal. */
function prefixesFor(xmp: string, ns: string): string[] {
  const uri = escapeRe(XMP_NS[ns]);
  const bound = [...new Set([...xmp.matchAll(new RegExp(`xmlns:([\\w.-]+)\\s*=\\s*["']${uri}["']`, 'g'))].map((m) => m[1]))];
  // A prefix bound to another namespace somewhere else in the packet cannot be read without scoping, so it is not.
  return bound.filter((p) => [...xmp.matchAll(new RegExp(`xmlns:${escapeRe(p)}\\s*=\\s*["']([^"']*)["']`, 'g'))].every((m) => m[1] === XMP_NS[ns]));
}

/** Fields that place the photo, or name the device that took it, by namespace and local name. */
const XMP_PLACE_FIELDS: Array<[string, string[]]> = [
  ['exif', ['GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSAreaInformation', 'GPSDestLatitude', 'GPSDestLongitude']],
  ['photoshop', ['City', 'State', 'Country']],
  ['Iptc4xmpCore', ['Location', 'CountryCode']],
  ['Iptc4xmpExt', ['LocationCreated', 'LocationShown', 'City', 'Sublocation', 'ProvinceState', 'CountryName']]
];
const XMP_DEVICE_FIELDS: Array<[string, string[]]> = [
  ['tiff', ['Make', 'Model']],
  ['exifEX', ['BodySerialNumber', 'LensMake', 'LensModel', 'LensSerialNumber', 'CameraOwnerName']],
  ['exif', ['BodySerialNumber', 'CameraOwnerName', 'LensModel']],
  ['aux', ['SerialNumber', 'Lens', 'LensID', 'LensSerialNumber', 'OwnerName']]
];

/** Whether any of the fields appears, under its usual prefix or any prefix the packet binds its namespace to. */
function mentions(xmp: string, fields: Array<[string, string[]]>, usual: RegExp): boolean {
  if (usual.test(xmp)) return true;
  return fields.some(([ns, names]) => {
    const prefixes = [...xmp.matchAll(new RegExp(`xmlns:([\\w.-]+)\\s*=\\s*["']${escapeRe(XMP_NS[ns])}["']`, 'g'))].map((m) => escapeRe(m[1]));
    return prefixes.length > 0 && new RegExp(`(?:^|[^\\w.-])(?:${prefixes.join('|')}):(?:${names.join('|')})\\b`).test(xmp);
  });
}

/** Comments, processing instructions and CDATA: markup whose text is not a property, and never becomes one. */
const XML_HIDDEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g;

/** A property's values, written as an element (simple or an rdf array) or as an attribute. */
function xmpValues(xmp: string, qname: string, rdf = 'rdf'): Array<{ lang?: string; text: string }> {
  const element = xmp.match(new RegExp(`<${qname}(\\s[^>]*)?>([\\s\\S]*?)</${qname}>`));
  let items: Array<{ lang?: string; text: string }> = [];
  if (element) {
    const lis = [...element[2].matchAll(new RegExp(`<(?:${rdf}):li(\\s[^>]*)?>([^<]*)</(?:${rdf}):li>`, 'g'))];
    if (lis.length) items = lis.map((m) => ({ lang: m[1]?.match(/xml:lang\s*=\s*["']([^"']*)["']/)?.[1], text: m[2] }));
    else items = [{ text: element[2] }];
  } else {
    const attr = xmp.match(new RegExp(`\\s${qname}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
    if (attr) items = [{ text: attr[1] ?? attr[2] }];
  }
  return items.filter((i) => i.text.trim() && PLAIN.test(i.text) && !FOREIGN_ENTITY.test(i.text) && i.text.length <= MAX_TEXT && (!i.lang || /^[A-Za-z0-9-]+$/.test(i.lang)));
}

/** A property's values under whichever prefix the packet binds its namespace to. */
function nsValues(xmp: string, ns: string, name: string): Array<{ lang?: string; text: string }> {
  // Array items are rdf:li under whatever prefix the packet gives RDF.
  const rdf = [...new Set(['rdf', ...prefixesFor(xmp, 'rdf')])].map(escapeRe).join('|');
  for (const prefix of prefixesFor(xmp, ns)) {
    const items = xmpValues(xmp, `${escapeRe(prefix)}:${name}`, rdf);
    if (items.length) return items;
  }
  return [];
}

function packet(ns: Set<string>, attrs: string, body: string, compact = false): Buffer {
  const decl = [...ns].filter((p) => p !== 'rdf').map((p) => ` xmlns:${p}="${XMP_NS[p]}"`).join('');
  const description = compact && !body ? `<rdf:Description rdf:about=""${decl}${attrs}/>` : `<rdf:Description rdf:about=""${decl}${attrs}>${body}</rdf:Description>`;
  const rdf = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta>`;
  return Buffer.from(compact ? rdf : `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>${rdf}<?xpacket end="w"?>`, 'utf8');
}

/**
 * Rebuild an XMP packet from the credit, rights and (for HDR photos) gain-map properties it holds. Comments are
 * removed first, so text hidden in one never becomes a live property.
 */
function filterXmp(bytes: Buffer, opts: XmpOptions = {}): XmpResult {
  const raw = bytes.toString('utf8');
  const location = mentions(raw, XMP_PLACE_FIELDS, XMP_LOCATION);
  const device = mentions(raw, XMP_DEVICE_FIELDS, XMP_DEVICE);
  const xmp = raw.replace(XML_HIDDEN, '');
  const compact = !!opts.compact;
  const props: string[] = [];
  // In a compact packet, single values are written as attributes, the shortest form RDF allows.
  const propAttrs: string[] = [];
  const ns = new Set<string>();
  for (const p of XMP_CREDITS) {
    const items = nsValues(xmp, p.prefix, p.name);
    if (!items.length) continue;
    const qname = `${p.prefix}:${p.name}`;
    ns.add(p.prefix);
    if (p.kind === 'text' && compact && !items[0].text.includes('"')) propAttrs.push(` ${qname}="${items[0].text}"`);
    else if (p.kind === 'text') props.push(`<${qname}>${items[0].text}</${qname}>`);
    else {
      const li = items.map((i) => (p.kind === 'Alt' ? `<rdf:li xml:lang="${i.lang ?? 'x-default'}">${i.text}</rdf:li>` : `<rdf:li>${i.text}</rdf:li>`)).join('');
      props.push(`<${qname}><rdf:${p.kind}>${li}</rdf:${p.kind}></${qname}>`);
    }
  }
  const credits = props.length || propAttrs.length ? packet(ns, propAttrs.join(''), props.join(''), compact) : null;
  // Rendering parameters: numbers, flags and the version, never free text.
  const attrs: string[] = [...propAttrs];
  const render: string[] = [];
  const renderNs = new Set(ns);
  if (opts.gainMap || opts.container?.length) {
    for (const name of opts.gainMap ? HDRGM_PROPS : ['Version']) {
      const values = nsValues(xmp, 'hdrgm', name).filter((v) => /^[\w.+-]+$/.test(v.text));
      if (!values.length) continue;
      renderNs.add('hdrgm');
      if (values.length === 1) attrs.push(` hdrgm:${name}="${values[0].text}"`);
      else render.push(`<hdrgm:${name}><rdf:Seq>${values.map((v) => `<rdf:li>${v.text}</rdf:li>`).join('')}</rdf:Seq></hdrgm:${name}>`);
    }
  }
  // Apple's gain map says what it is in its own XMP, which its rendering needs.
  if (opts.gainMap) {
    const kind = nsValues(xmp, 'apdi', 'AuxiliaryImageType').find((v) => /^urn:com:apple:photo:\d{4}:aux:hdrgainmap$/.test(v.text));
    const version = nsValues(xmp, 'HDRGainMap', 'HDRGainMapVersion').find((v) => /^[\w.+-]+$/.test(v.text));
    const headroom = nsValues(xmp, 'HDRGainMap', 'HDRGainMapHeadroom').find((v) => /^[\w.+-]+$/.test(v.text));
    if (headroom) {
      attrs.push(` HDRGainMap:HDRGainMapHeadroom="${headroom.text}"`);
      renderNs.add('HDRGainMap');
    }
    if (kind) {
      attrs.push(` apdi:AuxiliaryImageType="${kind.text}"`);
      renderNs.add('apdi');
    }
    if (version) {
      attrs.push(` HDRGainMap:HDRGainMapVersion="${version.text}"`);
      renderNs.add('HDRGainMap');
    }
  }
  const [container] = prefixesFor(xmp, 'Container');
  const [item] = prefixesFor(xmp, 'Item');
  if (opts.container?.length && container && item) {
    // The directory that tells readers where each embedded image starts, with the lengths after cleaning.
    const attr = (text: string, name: string) => text.match(new RegExp(`${escapeRe(item)}:${name}\\s*=\\s*["']([\\w/+.-]+)["']`))?.[1];
    const items = [...xmp.matchAll(new RegExp(`<${escapeRe(container)}:Item\\s([^>]*?)\\/?>`, 'g'))].map((m) => ({ semantic: attr(m[1], 'Semantic'), mime: attr(m[1], 'Mime') }));
    const embedded = items.filter((i) => i.semantic !== 'Primary' && i.mime === 'image/jpeg');
    if (items[0]?.semantic === 'Primary' && embedded.length === opts.container.length && embedded.every((i) => i.semantic && /^\w+$/.test(i.semantic))) {
      renderNs.add('Container').add('Item');
      const li = [`<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>`];
      embedded.forEach((i, k) => li.push(`<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="${i.semantic}" Item:Mime="image/jpeg" Item:Length="${opts.container![k]}"/></rdf:li>`));
      render.push(`<Container:Directory><rdf:Seq>${li.join('')}</rdf:Seq></Container:Directory>`);
    }
  }
  const full = attrs.length || props.length || render.length ? packet(renderNs, attrs.join(''), props.join('') + render.join(''), compact) : null;
  return { packet: full, credits, location, device };
}

// ---------------------------------------------------------------------------
// IPTC (inside a Photoshop resource block)
// ---------------------------------------------------------------------------

/** IPTC datasets kept: the character set, the record version, and the by-line, credit, source and copyright. */
const IPTC_KEEP = new Set(['1:90', '2:0', '2:80', '2:85', '2:110', '2:115', '2:116']);
/** City, sub-location, province or state, country code and country. */
const IPTC_LOCATION = new Set(['2:90', '2:92', '2:95', '2:100', '2:101']);

function filterIptc(iptc: Buffer, found: PhotoMetadata): Buffer | null {
  const keep: Buffer[] = [];
  let credit = false;
  let p = 0;
  while (p + 5 <= iptc.length && iptc[p] === 0x1c) {
    const id = `${iptc[p + 1]}:${iptc[p + 2]}`;
    let len = iptc.readUInt16BE(p + 3);
    let head = 5;
    if (len & 0x8000) {
      // Extended length: the next (len & 0x7fff) bytes hold the size. None of the datasets kept uses it.
      const n = len & 0x7fff;
      if (n < 1 || n > 4 || p + 5 + n > iptc.length) break;
      len = iptc.readUIntBE(p + 5, n);
      head += n;
    }
    if (p + head + len > iptc.length) break;
    if (IPTC_LOCATION.has(id) && len) found.location = true;
    if (IPTC_KEEP.has(id) && head === 5) {
      keep.push(iptc.subarray(p, p + head + len));
      if (id !== '1:90' && id !== '2:0' && len) credit = true;
    }
    p += head + len;
  }
  return credit ? Buffer.concat(keep) : null;
}

/** Rebuild a Photoshop "8BIM" resource block keeping only its filtered IPTC record. */
function filterPhotoshop(block: Buffer, found: PhotoMetadata): Buffer | null {
  let p = 0;
  let iptc: Buffer | null = null;
  while (p + 12 <= block.length && block.toString('latin1', p, p + 4) === '8BIM') {
    const id = block.readUInt16BE(p + 4);
    const nameLen = block[p + 6];
    const nameEnd = p + 6 + 1 + nameLen + ((1 + nameLen) & 1);
    if (nameEnd + 4 > block.length) break;
    const size = block.readUInt32BE(nameEnd);
    const start = nameEnd + 4;
    if (start + size > block.length) break;
    if (id === 0x0404) iptc ??= filterIptc(block.subarray(start, start + size), found);
    p = start + size + (size & 1);
  }
  if (!iptc) return null;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(iptc.length);
  return Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from([0x04, 0x04, 0, 0]), size, iptc, Buffer.alloc(iptc.length & 1)]);
}

// ---------------------------------------------------------------------------
// ICC profiles
// ---------------------------------------------------------------------------

/**
 * Profile tags that can identify a device or the person who made the profile: the monitor's EDID serial in a
 * calibration tool's metadata dictionary, manufacturer and model descriptions, the measurement target and the
 * profile sequence. None of them takes part in converting colour.
 */
const ICC_PRIVATE = new Set(['meta', 'dmnd', 'dmdd', 'mmod', 'targ', 'pseq']);

function parseIcc(p: Buffer): { size: number; tags: Array<{ sig: string; off: number; len: number }> } | null {
  if (p.length < 132 || p.toString('latin1', 36, 40) !== 'acsp') return null;
  const size = p.readUInt32BE(0);
  if (size < 132 || size > p.length) return null;
  const n = p.readUInt32BE(128);
  if (132 + n * 12 > size) return null;
  const tags: Array<{ sig: string; off: number; len: number }> = [];
  for (let k = 0; k < n; k++) {
    const e = 132 + k * 12;
    const t = { sig: p.toString('latin1', e, e + 4), off: p.readUInt32BE(e + 4), len: p.readUInt32BE(e + 8) };
    if (t.off + t.len > size) return null;
    tags.push(t);
  }
  return { size, tags };
}

/**
 * Header fields that name the device the profile describes (manufacturer and model, bytes 48–55) and the software
 * that made it (bytes 80–83), and the profile ID (84–99), a digest of the original bytes. None affects colour.
 */
const ICC_HEADER_IDENTITY: Array<[number, number]> = [
  [48, 56],
  [80, 100]
];
const iccHeaderClear = (p: Buffer) => ICC_HEADER_IDENTITY.every(([a, b]) => p.subarray(a, b).every((x) => x === 0));
/** Zero the header's identifying fields in place. */
function clearIccHeader(p: Buffer) {
  for (const [a, b] of ICC_HEADER_IDENTITY) p.fill(0, a, b);
}

/** Descriptions that name a standard colour space, which say nothing about who or what made the picture. */
const STANDARD_DESC = /^(sRGB( IEC61966-2[.-]1)?|sRGB built-in|Display P3|DCI-P3|DCI\(P3\) RGB|P3-D65|Adobe RGB \(1998\)|ProPhoto RGB|ROMM-RGB|Generic (RGB|Gray|CMYK) Profile|Generic Gray Gamma 2\.2 Profile|Gray Gamma 2\.2|Dot Gain \d{1,2}%|Linear (RGB|Gray|sRGB)|(ITU-R )?(BT\.|Rec\.? ?)(709|2020|2100)( [\w-]+)?|Apple RGB|ColorMatch RGB|eciRGB v2|scRGB|ACES( ?CG)?|uRGB|c2|Wide Gamut RGB|Coated FOGRA39 \(ISO 12647-2:2004\)|U\.S\. Web Coated \(SWOP\) v2|Japan Color 2001 Coated)$/i;

/** Every text a profile description holds (one per language), or null when it cannot be read. */
function iccDescTexts(d: Buffer): string[] | null {
  const type = d.toString('latin1', 0, 4);
  if (type === 'desc' && d.length >= 12) {
    const n = d.readUInt32BE(8);
    return 12 + n <= d.length ? [d.toString('latin1', 12, 12 + n).replace(/\0+$/, '')] : null;
  }
  if (type === 'mluc' && d.length >= 16) {
    const count = d.readUInt32BE(8);
    if (count < 1 || count > 64 || 16 + count * 12 > d.length) return null;
    const out: string[] = [];
    for (let k = 0; k < count; k++) {
      const len = d.readUInt32BE(16 + k * 12 + 4);
      const off = d.readUInt32BE(16 + k * 12 + 8);
      if (len & 1 || off + len > d.length) return null;
      out.push(Buffer.from(d.subarray(off, off + len)).swap16().toString('utf16le'));
    }
    return out;
  }
  return null;
}

/** A description reading only "ICC profile", in the type the original used. */
function neutralDesc(type: string): Buffer {
  const text = 'ICC profile';
  if (type === 'mluc') {
    const utf16 = Buffer.from(text, 'utf16le').swap16();
    const head = Buffer.alloc(28);
    head.write('mluc', 0, 'latin1');
    head.writeUInt32BE(1, 8);
    head.writeUInt32BE(12, 12);
    head.write('enUS', 16, 'latin1');
    head.writeUInt32BE(utf16.length, 20);
    head.writeUInt32BE(28, 24);
    return Buffer.concat([head, utf16]);
  }
  // The version 2 layout: ASCII, then empty Unicode and ScriptCode parts.
  const ascii = Buffer.from(`${text}\0`, 'latin1');
  const head = Buffer.alloc(12);
  head.write('desc', 0, 'latin1');
  head.writeUInt32BE(ascii.length, 8);
  return Buffer.concat([head, ascii, Buffer.alloc(4 + 4 + 2 + 1 + 67)]);
}

/**
 * Overwrite a description's text where it is, keeping every length: "ICC profile" when it fits, padded with what
 * each form uses for nothing (NULs in ASCII, spaces in UTF-16). Standard names are left alone. False when the
 * description cannot be read, so the profile cannot be trusted.
 */
function neutralDescInPlace(d: Buffer, found: PhotoMetadata): boolean {
  const texts = iccDescTexts(d);
  if (!texts) return false;
  if (texts.every((t) => STANDARD_DESC.test(t.trim()))) return true;
  found.device = true;
  const text = 'ICC profile';
  if (d.toString('latin1', 0, 4) === 'desc') {
    const n = d.readUInt32BE(8);
    d.fill(0, 12, 12 + n);
    if (n > text.length) d.write(text, 12, 'latin1');
    // The Unicode part after it can hold the same text: it is emptied, within its stated length.
    const u = 12 + n;
    if (u + 8 <= d.length) d.fill(0, u + 8, Math.min(d.length, u + 8 + d.readUInt32BE(u + 4) * 2));
    return true;
  }
  for (let k = 0; k < d.readUInt32BE(8); k++) {
    const len = d.readUInt32BE(16 + k * 12 + 4);
    const off = d.readUInt32BE(16 + k * 12 + 8);
    Buffer.from(text.padEnd(len / 2).slice(0, len / 2), 'utf16le').swap16().copy(d, off);
  }
  return true;
}

/**
 * The profile without identifying tags or header fields; the same buffer when it has none; null when it is not
 * a usable profile. A description other than a standard colour space's name (a monitor's model and calibration
 * date, a camera's) is replaced with a neutral one; the description tag itself is required.
 */
function cleanIcc(p: Buffer, found: PhotoMetadata): Buffer | null {
  const icc = parseIcc(p);
  if (!icc) return null;
  const { size, tags } = icc;
  const desc = tags.find((t) => t.sig === 'desc');
  const texts = desc ? iccDescTexts(p.subarray(desc.off, desc.off + desc.len)) : [];
  const replaceDesc = !!desc && !(texts && texts.every((t) => STANDARD_DESC.test(t.trim())));
  if (!tags.some((t) => ICC_PRIVATE.has(t.sig)) && !replaceDesc) {
    if (size === p.length && iccHeaderClear(p)) return p;
    const out = Buffer.from(p.subarray(0, size));
    clearIccHeader(out);
    return out;
  }
  found.device = true;
  const keep = tags.filter((t) => !ICC_PRIVATE.has(t.sig));
  const descData = replaceDesc ? neutralDesc(p.toString('latin1', desc!.off, desc!.off + 4)) : null;
  const dataOf = (t: { sig: string; off: number; len: number }) => (t.sig === 'desc' && descData ? descData : p.subarray(t.off, t.off + t.len));
  // Tags may share data; each distinct block is written once, on a four-byte boundary.
  const blocks = new Map<string, number>();
  const keyOf = (t: { sig: string; off: number; len: number }) => (t.sig === 'desc' && descData ? 'desc' : `${t.off}:${t.len}`);
  let at = 132 + keep.length * 12;
  const layout: Array<{ data: Buffer; dst: number }> = [];
  for (const t of keep) {
    const key = keyOf(t);
    if (blocks.has(key)) continue;
    at = (at + 3) & ~3;
    blocks.set(key, at);
    const data = dataOf(t);
    layout.push({ data, dst: at });
    at += data.length;
  }
  const out = Buffer.alloc((at + 3) & ~3);
  p.copy(out, 0, 0, 128);
  out.writeUInt32BE(out.length, 0);
  // A zero profile ID means "not computed".
  clearIccHeader(out);
  out.writeUInt32BE(keep.length, 128);
  keep.forEach((t, k) => {
    const e = 132 + k * 12;
    out.write(t.sig, e, 'latin1');
    out.writeUInt32BE(blocks.get(keyOf(t))!, e + 4);
    out.writeUInt32BE(dataOf(t).length, e + 8);
  });
  for (const b of layout) b.data.copy(out, b.dst);
  return out;
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const PHOTOSHOP_HEADER = Buffer.from('Photoshop 3.0\0', 'latin1');
const ICC_HEADER = Buffer.from('ICC_PROFILE\0', 'latin1');
const MPF_HEADER = Buffer.from('MPF\0', 'latin1');
const XMP_EXTENSION_HEADER = Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1');
/** ISO 21496-1 gain-map metadata: rendering parameters only. */
const ISO_GAINMAP_HEADER = Buffer.from('urn:iso:std:iso:ts:21496:-1\0', 'latin1');
const ICC_CHUNK = 65519;

function segment(marker: number, payload: Buffer): Buffer | null {
  if (payload.length + 2 > 0xffff) return null;
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function startsWith(buf: Buffer, prefix: Buffer): boolean {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

/** A placeholder in the rebuilt segment list, filled once everything it depends on is known. */
type Slot = Buffer | 'xmp' | 'icc' | 'mpf';

/**
 * Walk a JPEG's segments, keeping image data, JFIF (without its thumbnail), ICC profiles, the Adobe
 * colour-transform marker and gain-map metadata, and rebuilding EXIF, XMP and IPTC from their allowlists.
 * Comments, maker segments (FlashPix, JUMBF and the like) and anything after the end-of-image marker are
 * dropped, except the gain-map images a Multi-Picture Format index points at, which are cleaned in turn and
 * re-indexed. A Pixel motion photo's video, which can carry its own location, is not one of those.
 */
function cleanJpeg(buf: Buffer, secondary: boolean): Omit<CleanedPhoto, 'changed'> | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const found = empty();
  const out: Slot[] = [buf.subarray(0, 2)];
  const xmps: Buffer[] = [];
  const extended: Buffer[] = [];
  const icc: Buffer[] = [];
  let mpf: { payload: Buffer; tiffAt: number } | null = null;
  let end = -1;
  let i = 2;
  while (end < 0) {
    if (i + 2 > buf.length || buf[i] !== 0xff) return null;
    // A marker may be padded with any number of 0xff fill bytes.
    while (buf[i + 1] === 0xff && i + 2 < buf.length) i++;
    const marker = buf[i + 1];
    if (marker === 0xd9) {
      out.push(buf.subarray(i, i + 2));
      end = i + 2;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0x00 || i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const seg = buf.subarray(i, i + 2 + len);
    const payload = buf.subarray(i + 4, i + 2 + len);
    const at = i;
    i += 2 + len;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (marker === 0xe0 && startsWith(payload, Buffer.from('JFIF\0', 'latin1'))) {
        // Density and version only; the optional thumbnail goes.
        if (payload.length >= 14) out.push(payload.length === 14 && payload[12] === 0 && payload[13] === 0 ? seg : segment(0xe0, Buffer.concat([payload.subarray(0, 12), Buffer.from([0, 0])]))!);
      } else if (marker === 0xee && startsWith(payload, Buffer.from('Adobe', 'latin1'))) {
        // The colour-transform flag decides how the channels decode. Its fields end at byte 12.
        out.push(payload.length > 12 ? segment(0xee, payload.subarray(0, 12))! : seg);
      }
      else if (marker === 0xe2 && startsWith(payload, ISO_GAINMAP_HEADER)) out.push(seg);
      else if (marker === 0xe2 && startsWith(payload, ICC_HEADER)) {
        if (!icc.length) out.push('icc');
        icc.push(payload);
      } else if (marker === 0xe2 && startsWith(payload, MPF_HEADER) && !secondary && !mpf) {
        mpf = { payload: payload.subarray(MPF_HEADER.length), tiffAt: at + 4 + MPF_HEADER.length };
        out.push('mpf');
      } else if (marker === 0xe1 && startsWith(payload, EXIF_HEADER)) {
        const r = filterExif(payload.subarray(EXIF_HEADER.length));
        merge(found, r);
        if (r.tiff) {
          const rebuilt = segment(0xe1, Buffer.concat([EXIF_HEADER, r.tiff]));
          if (rebuilt) out.push(rebuilt);
        }
        if (r.credits) found.credits.tiff ??= r.credits;
      } else if (marker === 0xe1 && startsWith(payload, XMP_HEADER)) {
        if (!xmps.length) out.push('xmp');
        xmps.push(payload.subarray(XMP_HEADER.length));
      } else if (marker === 0xe1 && startsWith(payload, XMP_EXTENSION_HEADER)) {
        // Extended XMP: read for its credits, folded into the main packet, then left out.
        extended.push(payload.subarray(XMP_EXTENSION_HEADER.length));
      } else if (marker === 0xed && startsWith(payload, PHOTOSHOP_HEADER)) {
        const r = filterPhotoshop(payload.subarray(PHOTOSHOP_HEADER.length), found);
        const rebuilt = r && segment(0xed, Buffer.concat([PHOTOSHOP_HEADER, r]));
        if (rebuilt) out.push(rebuilt);
        if (r) found.credits.iptc ??= r;
      } else {
        // Anything else (comments, extended XMP, FlashPix, maker segments, JUMBF) is not needed to show the
        // picture. Its text is still searched, so the author hears about a location it carried.
        const text = payload.toString('latin1');
        if (XMP_LOCATION.test(text)) found.location = true;
      }
      continue;
    }
    out.push(seg);
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed byte, a restart or fill.
      let j = i;
      while (j + 1 < buf.length && !(buf[j] === 0xff && buf[j + 1] !== 0 && buf[j + 1] !== 0xff && !(buf[j + 1] >= 0xd0 && buf[j + 1] <= 0xd7))) j++;
      // No end-of-image marker: a truncated file, where image data cannot be told from anything after it.
      if (j + 1 >= buf.length) return null;
      out.push(buf.subarray(i, j));
      i = j;
    }
  }

  // Gain maps and other images the Multi-Picture index lists, each cleaned on its own.
  const embedded = mpf ? embeddedImages(buf, mpf, end) : null;
  const cleaned = embedded?.map((e) => ({ ...e, clean: cleanJpeg(buf.subarray(e.at, e.at + e.size), true) }));
  const kept = cleaned?.every((e) => e.clean) ? cleaned : [];
  for (const e of kept) merge(found, e.clean!);

  const xmpText = xmps.length ? Buffer.concat([...xmps, extendedXmp(Buffer.concat(xmps).toString('utf8'), extended)]) : null;
  const xmpOpts = { gainMap: secondary, container: kept.map((e) => e.clean!.data.length) };
  let xmp = xmpText ? filterXmp(xmpText, xmpOpts) : null;
  // A packet too large for one segment (long rights from extended XMP): the main packet's alone, compactly.
  if (xmp?.packet && xmp.packet.length + XMP_HEADER.length + 2 > 0xffff) {
    const fallback = filterXmp(Buffer.concat(xmps), { ...xmpOpts, compact: true });
    xmp = { ...fallback, location: xmp.location || fallback.location, device: xmp.device || fallback.device };
  }
  if (xmp) {
    merge(found, xmp);
    if (xmp.credits) found.credits.xmp = xmp.credits;
  }
  const iccProfile = icc.length ? joinIcc(icc) : null;
  const iccClean = iccProfile && cleanIcc(iccProfile, found);

  const fill = (mpfSegment: Buffer | null): Buffer[] =>
    out.flatMap((s) => {
      if (s === 'xmp') return xmp?.packet ? [segment(0xe1, Buffer.concat([XMP_HEADER, xmp.packet]))].filter((x): x is Buffer => !!x) : [];
      if (s === 'icc') return !iccClean ? [] : iccClean === iccProfile ? icc.map((p) => segment(0xe2, p)!) : splitIcc(iccClean);
      if (s === 'mpf') return mpfSegment ? [mpfSegment] : [];
      return [s];
    });
  if (!kept.length) return { ...found, data: Buffer.concat(fill(null)) };
  // The index records each image's size and its offset from the index itself, so it is written last.
  const placeholder = writeMpf(true, kept.length + 1);
  const primary = fill(placeholder);
  const before = primary.slice(0, primary.indexOf(placeholder)).reduce((n, b) => n + b.length, 0);
  const tiffAt = before + 4 + MPF_HEADER.length;
  const primaryLength = primary.reduce((n, b) => n + b.length, 0);
  let offset = primaryLength - tiffAt;
  // Every image is kept, in order, so entry numbers in the dependency fields still point at the same images.
  const entries = [{ ...embedded![0].primary, size: primaryLength, offset: 0 }];
  for (const e of kept) {
    entries.push({ attr: e.attr, size: e.clean!.data.length, offset, dep1: e.dep1, dep2: e.dep2 });
    offset += e.clean!.data.length;
  }
  const realMpf = writeMpf(true, entries.length, entries);
  return { ...found, data: Buffer.concat([...fill(realMpf), ...kept.map((e) => e.clean!.data)]) };
}

/**
 * The extended XMP the main packet points at (xmpNote:HasExtendedXMP), joined from its chunks: a 32-character
 * GUID, the full length and this chunk's offset, then the data. Empty when it is absent or incomplete.
 */
function extendedXmp(main: string, chunks: Buffer[]): Buffer {
  const visible = main.replace(XML_HIDDEN, '');
  const note = prefixesFor(visible, 'xmpNote').map(escapeRe).join('|');
  const guid = note ? visible.match(new RegExp(`(?:${note}):HasExtendedXMP\\s*(?:=\\s*["']|>)([0-9A-Fa-f]{32})`))?.[1] : undefined;
  if (!guid) return Buffer.alloc(0);
  const parts = chunks.filter((c) => c.length >= 40 && c.toString('latin1', 0, 32) === guid);
  if (!parts.length) return Buffer.alloc(0);
  const total = parts[0].readUInt32BE(32);
  if (total > MAX_INFLATE) return Buffer.alloc(0);
  const out = Buffer.alloc(total);
  // The chunks must tile the whole length exactly: in order, no gaps, no overlaps.
  let filled = 0;
  for (const c of [...parts].sort((a, b) => a.readUInt32BE(36) - b.readUInt32BE(36))) {
    const data = c.subarray(40);
    if (c.readUInt32BE(32) !== total || c.readUInt32BE(36) !== filled || filled + data.length > total) return Buffer.alloc(0);
    data.copy(out, filled);
    filled += data.length;
  }
  return filled === total ? out : Buffer.alloc(0);
}

/** ICC profile chunks joined in sequence order, or null when the set is incomplete (browsers then ignore it). */
function joinIcc(chunks: Buffer[]): Buffer | null {
  const count = chunks[0][ICC_HEADER.length + 1];
  if (!count || chunks.length !== count) return null;
  const bySeq = new Map<number, Buffer>();
  for (const c of chunks) {
    if (c[ICC_HEADER.length + 1] !== count || bySeq.has(c[ICC_HEADER.length])) return null;
    bySeq.set(c[ICC_HEADER.length], c.subarray(ICC_HEADER.length + 2));
  }
  const parts: Buffer[] = [];
  for (let s = 1; s <= count; s++) {
    const part = bySeq.get(s);
    if (!part) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function splitIcc(profile: Buffer): Buffer[] {
  const count = Math.ceil(profile.length / ICC_CHUNK);
  if (count > 255) return [];
  const out: Buffer[] = [];
  for (let s = 0; s < count; s++) out.push(segment(0xe2, Buffer.concat([ICC_HEADER, Buffer.from([s + 1, count]), profile.subarray(s * ICC_CHUNK, (s + 1) * ICC_CHUNK)]))!);
  return out;
}

interface MpEntry {
  attr: number;
  dep1: number;
  dep2: number;
}

interface Embedded extends MpEntry {
  at: number;
  size: number;
  /** The primary image's own entry, kept with each so the index can be rebuilt. */
  primary: MpEntry;
}

/**
 * The images a Multi-Picture Format index lists after the primary one, when every entry is a whole JPEG lying
 * after the primary image without overlapping another. Null when the index cannot be trusted.
 */
function embeddedImages(buf: Buffer, mpf: { payload: Buffer; tiffAt: number }, primaryEnd: number): Embedded[] | null {
  let t: Tiff;
  let fields: Field[];
  try {
    t = new Tiff(mpf.payload);
    fields = t.ifd(t.u32(4));
  } catch {
    return null;
  }
  const count = fields.find((f) => f.tag === 0xb001);
  const list = fields.find((f) => f.tag === 0xb002);
  if (!count || !list || count.value.length !== 4) return null;
  const n = t.le ? count.value.readUInt32LE(0) : count.value.readUInt32BE(0);
  if (n < 2 || n > 64 || list.value.length !== n * 16) return null;
  const u32 = (o: number) => (t.le ? list.value.readUInt32LE(o) : list.value.readUInt32BE(o));
  const u16 = (o: number) => (t.le ? list.value.readUInt16LE(o) : list.value.readUInt16BE(o));
  const entry = (k: number): MpEntry => ({ attr: u32(k * 16), dep1: u16(k * 16 + 12), dep2: u16(k * 16 + 14) });
  const out: Embedded[] = [];
  let last = primaryEnd;
  for (let k = 1; k < n; k++) {
    const size = u32(k * 16 + 4);
    const at = mpf.tiffAt + u32(k * 16 + 8);
    if (at < last || at + size > buf.length || size < 4 || buf[at] !== 0xff || buf[at + 1] !== 0xd8) return null;
    out.push({ ...entry(k), at, size, primary: entry(0) });
    last = at + size;
  }
  return out;
}

/** A Multi-Picture Format APP2 segment: version, image count and the entry list. */
function writeMpf(le: boolean, n: number, entries: Array<{ attr: number; size: number; offset: number; dep1: number; dep2: number }> = []): Buffer {
  const list = Buffer.alloc(n * 16);
  entries.forEach((e, k) => {
    const w32 = (o: number, v: number) => (le ? list.writeUInt32LE(v, o) : list.writeUInt32BE(v, o));
    const w16 = (o: number, v: number) => (le ? list.writeUInt16LE(v, o) : list.writeUInt16BE(v, o));
    w32(k * 16, e.attr);
    w32(k * 16 + 4, e.size);
    w32(k * 16 + 8, e.offset);
    w16(k * 16 + 12, e.dep1);
    w16(k * 16 + 14, e.dep2);
  });
  const countValue = Buffer.alloc(4);
  if (le) countValue.writeUInt32LE(n);
  else countValue.writeUInt32BE(n);
  const tiff = writeTiff(
    le,
    [
      { tag: 0xb000, type: 7, count: 4, value: Buffer.from('0100', 'latin1') },
      { tag: 0xb001, type: 4, count: 1, value: countValue },
      { tag: 0xb002, type: 7, count: list.length, value: list }
    ],
    [],
    []
  );
  return segment(0xe2, Buffer.concat([MPF_HEADER, tiff]))!;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/** Chunks that decide how the picture looks or animates. Every other ancillary chunk is left behind. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT']);
const PNG_CREDIT_KEYWORDS = new Set(['Author', 'Copyright']);
const ICC_PNG_NAME = 'ICC profile';

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))));
  return Buffer.concat([head, data, crc]);
}

function cleanPng(buf: Buffer): Omit<CleanedPhoto, 'changed'> | null {
  if (!startsWith(buf, PNG_SIGNATURE)) return null;
  const found = empty();
  const out: Buffer[] = [PNG_SIGNATURE];
  const text: Buffer[] = [];
  let p = 8;
  let ended = false;
  while (!ended) {
    if (p + 12 > buf.length) return null;
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || p + 12 + len > buf.length) return null;
    const chunk = buf.subarray(p, p + 12 + len);
    const typeAndData = buf.subarray(p + 4, p + 8 + len);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IEND') ended = true;
    const critical = /^[A-Z]/.test(type);
    // Decoders discard an ancillary chunk whose checksum fails, so it is left out rather than revived with a new one.
    if (!critical && crc32(typeAndData) !== buf.readUInt32BE(p - 4)) continue;
    if (PNG_KEEP.has(type)) {
      out.push(chunk);
      continue;
    }
    // A critical chunk this does not know cannot be dropped without breaking the image.
    if (critical) return null;
    if (type === 'iCCP') {
      const nul = data.indexOf(0);
      if (nul < 1 || nul > 79 || data[nul + 1] !== 0) continue;
      const profile = inflateSync(data.subarray(nul + 2), { maxOutputLength: MAX_INFLATE });
      const clean = cleanIcc(profile, found);
      // The profile's name is free text (often the monitor's), so a neutral one replaces it.
      if (clean === profile && data.toString('latin1', 0, nul) === ICC_PNG_NAME) out.push(chunk);
      else if (clean) out.push(pngChunk('iCCP', Buffer.concat([Buffer.from(`${ICC_PNG_NAME}\0\0`, 'latin1'), deflateSync(clean)])));
    } else if (type === 'eXIf') {
      const r = filterExif(data);
      merge(found, r);
      if (r.tiff) out.push(pngChunk('eXIf', r.tiff));
      if (r.credits) found.credits.tiff ??= r.credits;
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const nul = data.indexOf(0);
      const keyword = nul > 0 ? data.toString('latin1', 0, nul) : '';
      if (type === 'iTXt' && keyword === 'XML:com.adobe.xmp') {
        const r = filterXmp(pngItxtText(data, nul));
        merge(found, r);
        if (r.packet) out.push(pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), r.packet])));
        if (r.credits) found.credits.xmp = r.credits;
      } else if (PNG_CREDIT_KEYWORDS.has(keyword)) {
        // An international text chunk keeps its keyword, compression and text, but not its free-text language
        // tag or translated keyword.
        const rebuilt = type === 'iTXt' ? itxtCredit(data, nul) : null;
        if (type === 'iTXt' && !rebuilt) continue;
        const body = rebuilt ?? data;
        out.push(rebuilt ? pngChunk('iTXt', rebuilt) : chunk);
        text.push(Buffer.concat([Buffer.from(type, 'latin1'), body]));
      } else if (/^(Raw profile type (exif|APP1|xmp|iptc)|Source)$/i.test(keyword)) {
        // The device that made the picture, or ImageMagick's hex copies of camera metadata.
        found.device = true;
      }
    }
  }
  if (text.length) found.credits.text = text;
  return { ...found, data: Buffer.concat(out) };
}

/** An iTXt chunk's keyword, flags and text with an empty language tag and translated keyword; null if malformed. */
function itxtCredit(data: Buffer, nul: number): Buffer | null {
  const language = data.indexOf(0, nul + 3);
  const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
  if (translated < 0) return null;
  return Buffer.concat([data.subarray(0, nul + 3), Buffer.from([0, 0]), data.subarray(translated + 1)]);
}

/** The text of an iTXt chunk, inflated when it is compressed. */
function pngItxtText(data: Buffer, nul: number): Buffer {
  const compressed = data[nul + 1] === 1;
  const language = data.indexOf(0, nul + 3);
  const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
  if (translated < 0) return Buffer.alloc(0);
  const body = data.subarray(translated + 1);
  return compressed ? inflateSync(body, { maxOutputLength: MAX_INFLATE }) : body;
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

function riffChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

function* riffChunks(buf: Buffer, start: number, end: number): Generator<{ type: string; data: Buffer }> {
  let p = start;
  while (p < end) {
    if (p + 8 > end) throw new Error('truncated chunk');
    const type = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (p + 8 + len > end) throw new Error('truncated chunk');
    yield { type, data: buf.subarray(p + 8, p + 8 + len) };
    p += 8 + len + (len & 1);
  }
}

function cleanWebp(buf: Buffer): Omit<CleanedPhoto, 'changed'> | null {
  const size = buf.readUInt32LE(4);
  if (size < 4 || 8 + size > buf.length) return null;
  const found = empty();
  const chunks: Buffer[] = [];
  let vp8x: Buffer | null = null;
  let exif = false;
  let xmp = false;
  let iccKept = false;
  for (const c of riffChunks(buf, 12, 8 + size)) {
    if (c.type === 'VP8X') {
      if (vp8x || c.data.length < 10) return null;
      // Flags, reserved bytes and the canvas size; anything after them is not part of the header.
      vp8x = Buffer.from(c.data.subarray(0, 10));
      chunks.push(vp8x);
    } else if (c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ALPH' || c.type === 'ANIM') chunks.push(riffChunk(c.type, c.data));
    else if (c.type === 'ANMF') {
      // A frame's header, then its own image chunks; nothing else belongs inside.
      if (c.data.length < 16) return null;
      const inner = [...riffChunks(c.data, 16, c.data.length)].filter((f) => f.type === 'ALPH' || f.type === 'VP8 ' || f.type === 'VP8L');
      chunks.push(riffChunk('ANMF', Buffer.concat([c.data.subarray(0, 16), ...inner.map((f) => riffChunk(f.type, f.data))])));
    } else if (c.type === 'ICCP') {
      const clean = cleanIcc(c.data, found);
      if (clean) {
        chunks.push(riffChunk('ICCP', clean));
        iccKept = true;
      }
    } else if (c.type === 'EXIF') {
      const r = filterExif(startsWith(c.data, EXIF_HEADER) ? c.data.subarray(EXIF_HEADER.length) : c.data);
      merge(found, r);
      if (r.tiff) {
        chunks.push(riffChunk('EXIF', r.tiff));
        exif = true;
      }
    } else if (c.type === 'XMP ') {
      const r = filterXmp(c.data);
      merge(found, r);
      if (r.packet) {
        chunks.push(riffChunk('XMP ', r.packet));
        xmp = true;
      }
    }
  }
  if (vp8x) {
    // The header's flags say which optional chunks follow: ICC 0x20, EXIF 0x08, XMP 0x04.
    vp8x[0] = (vp8x[0] & ~(0x20 | 0x08 | 0x04)) | (iccKept ? 0x20 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0);
    chunks[chunks.indexOf(vp8x)] = riffChunk('VP8X', vp8x);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { ...found, data: Buffer.concat([head, body]) };
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

/** Application extensions kept: looping (two spellings) and an ICC profile. */
const GIF_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

/** 0x01, then 0xff down to 0x00, then the block terminator. */
const GIF_XMP_TRAILER = Buffer.from([0x01, ...Array.from({ length: 256 }, (_, k) => 255 - k), 0x00]);

/** Data as GIF sub-blocks of at most 255 bytes, with the terminator. */
function subBlocks(data: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let k = 0; k < data.length; k += 255) {
    const part = data.subarray(k, k + 255);
    out.push(Buffer.from([part.length]), part);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

/** A GIF application extension: the 11-byte identifier, then its body (sub-blocks, or XMP's raw form). */
function gifApplication(id: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from(id, 'latin1'), body]);
}

function cleanGif(buf: Buffer): Omit<CleanedPhoto, 'changed'> | null {
  if (buf.length < 13) return null;
  const found = empty();
  const table = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  let p = 13 + table(buf[10]);
  const out: Buffer[] = [buf.subarray(0, p)];
  /** The end of a run of data sub-blocks starting at `q`. */
  const blocks = (q: number) => {
    for (;;) {
      if (q >= buf.length) throw new Error('truncated GIF');
      const n = buf[q];
      q += 1 + n;
      if (n === 0) return q;
    }
  };
  for (;;) {
    if (p >= buf.length) return null;
    const b = buf[p];
    if (b === 0x3b) {
      out.push(buf.subarray(p, p + 1));
      break;
    }
    if (b === 0x2c) {
      if (p + 10 > buf.length) return null;
      const q = blocks(p + 10 + table(buf[p + 9]) + 1);
      out.push(buf.subarray(p, q));
      p = q;
    } else if (b === 0x21) {
      const label = buf[p + 1];
      const q = blocks(p + 2);
      if (label === 0xf9 || label === 0x01) out.push(buf.subarray(p, q));
      else if (label === 0xff && buf[p + 2] === 11) {
        const app = buf.toString('latin1', p + 3, p + 14);
        if (app === 'ICCRGBG1012') {
          // The profile, joined from its sub-blocks, is cleaned like any other and written back the same way.
          const parts: Buffer[] = [];
          for (let r = p + 14; buf[r] !== 0; r += 1 + buf[r]) parts.push(buf.subarray(r + 1, r + 1 + buf[r]));
          const profile = Buffer.concat(parts);
          const clean = cleanIcc(profile, found);
          if (clean === profile) out.push(buf.subarray(p, q));
          else if (clean) out.push(gifApplication('ICCRGBG1012', subBlocks(clean)));
        } else if (app === 'XMP DataXMP') {
          // XMP is stored raw, followed by a "magic trailer" that lets readers skip it as sub-blocks.
          const raw = q - p >= 14 + GIF_XMP_TRAILER.length && buf.subarray(q - GIF_XMP_TRAILER.length, q).equals(GIF_XMP_TRAILER) ? buf.subarray(p + 14, q - GIF_XMP_TRAILER.length) : buf.subarray(p + 14, q);
          const r = filterXmp(raw);
          merge(found, r);
          if (r.credits) {
            found.credits.xmp = r.credits;
            const ext = gifApplication('XMP DataXMP', Buffer.concat([r.credits, GIF_XMP_TRAILER]));
            // Written only if a reader walking it as sub-blocks lands exactly on its end.
            let w = 14;
            while (w < ext.length && ext[w] !== 0) w += 1 + ext[w];
            if (w === ext.length - 1) out.push(ext);
          }
        } else if (GIF_APPS.has(app)) out.push(buf.subarray(p, q));
        else {
          const text = buf.toString('latin1', p, q);
          if (XMP_LOCATION.test(text)) found.location = true;
          if (XMP_DEVICE.test(text)) found.device = true;
        }
      }
      p = q;
    } else return null;
  }
  return { ...found, data: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------
// HEIF (AVIF, HEIC)
// ---------------------------------------------------------------------------

/** ISO-BMFF boxes between `start` and `end`. */
function* isoBoxes(buf: Buffer, start: number, end: number): Generator<{ type: string; at: number; body: number; end: number }> {
  let p = start;
  while (p < end) {
    if (p + 8 > end) throw new Error('truncated box');
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error('truncated box');
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) size = end - p;
    if (size < body - p || p + size > end) throw new Error('bad box');
    yield { type, at: p, body, end: p + size };
    p += size;
  }
}

const EMPTY_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
const HEIF_TOP = new Set(['ftyp', 'meta', 'mdat', 'free', 'skip']);
const HEIF_META = new Set(['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat', 'dinf', 'grpl', 'free', 'skip']);
/** Items that hold or assemble pictures, plus the two metadata items this rewrites. Anything else is refused. */
const HEIF_ITEMS = new Set(['av01', 'hvc1', 'hev1', 'vvc1', 'avc1', 'jpeg', 'j2k1', 'unci', 'grid', 'iovl', 'iden', 'tmap', 'Exif', 'xmp']);
/**
 * Item properties that describe how to decode and show a picture. Descriptive ones ('udes' user descriptions,
 * 'altt' text) and anything unknown make the file unsupported, since they cannot be shrunk in place.
 */
const HEIF_PROPS = new Set(['ispe', 'pixi', 'colr', 'av1C', 'hvcC', 'vvcC', 'avcC', 'jpgC', 'irot', 'imir', 'clap', 'pasp', 'auxC', 'clli', 'mdcv', 'cclv', 'amve', 'a1op', 'lsel', 'a1lx', 'rloc', 'iscl', 'uncC', 'cmpd', 'free', 'skip']);

/**
 * AVIF and HEIC are cleaned in place, so no offset moves: each Exif or XMP item is overwritten with its filtered
 * version and padding, and every byte no item refers to (inside media data and idat, and free or skip boxes) is
 * zeroed, which also clears a stale copy an editor left behind. Image sequences, external data, items built from
 * other items' bytes, overlapping extents and unknown boxes make the file unsupported rather than guessed at.
 */
function cleanHeif(buf: Buffer): Omit<CleanedPhoto, 'changed'> | null {
  const found = empty();
  const out = Buffer.from(buf);
  const top = [...isoBoxes(buf, 0, buf.length)];
  if (top.some((b) => !HEIF_TOP.has(b.type)) || top.filter((b) => b.type === 'meta').length !== 1) return null;
  const meta = top.find((b) => b.type === 'meta')!;
  const children = [...isoBoxes(buf, meta.body + 4, meta.end)];
  if (children.some((b) => !HEIF_META.has(b.type))) return null;
  const iloc = children.find((b) => b.type === 'iloc');
  const iinf = children.find((b) => b.type === 'iinf');
  const idat = children.find((b) => b.type === 'idat');
  if (!iloc || !iinf) return null;
  const items = heifItemTypes(buf, iinf);
  const types = items?.types;
  const locations = heifLocations(buf, iloc, idat ?? null);
  if (!items || !types || !locations || [...types.values()].some((t) => !HEIF_ITEMS.has(t))) return null;
  // Item names are free text. One that says more than what the item is gets cleared in place; a document item's
  // name cannot be, since its content type follows it.
  for (const n of items.names) {
    if (HEIF_NAMES.has(buf.toString('utf8', n.start, n.end))) continue;
    if (n.type === 'mime') return null;
    out.fill(0, n.start, n.end);
  }
  // Colour profiles live in item properties: their identifying header fields are cleared in place, but
  // identifying tags cannot be removed without moving bytes.
  const iprp = children.find((b) => b.type === 'iprp');
  if (iprp)
    for (const c of isoBoxes(buf, iprp.body, iprp.end)) {
      if (c.type !== 'ipco') continue;
      for (const prop of isoBoxes(buf, c.body, c.end)) {
        if (!HEIF_PROPS.has(prop.type)) return null;
        const kind = prop.type === 'colr' && prop.body + 4 <= prop.end ? buf.toString('latin1', prop.body, prop.body + 4) : '';
        if (kind !== 'prof' && kind !== 'rICC') continue;
        const icc = parseIcc(buf.subarray(prop.body + 4, prop.end));
        if (!icc || icc.tags.some((t) => ICC_PRIVATE.has(t.sig))) return null;
        const profile = out.subarray(prop.body + 4, prop.end);
        clearIccHeader(profile);
        const desc = icc.tags.find((t) => t.sig === 'desc');
        if (desc && !neutralDescInPlace(profile.subarray(desc.off, desc.off + desc.len), found)) return null;
      }
    }
  const ranges = [...locations.values()].flat();
  // A JPEG-coded item is a whole JPEG, with room for its own EXIF: it must carry nothing the cleaner would remove.
  for (const [id, loc] of locations) {
    if (types.get(id) !== 'jpeg') continue;
    if (loc.length !== 1) return null;
    const bytes = buf.subarray(loc[0].start, loc[0].end);
    const r = cleanJpeg(bytes, false);
    if (!r || !r.data.equals(bytes)) return null;
  }
  // The handler's name is free text.
  const hdlr = children.find((b) => b.type === 'hdlr');
  if (hdlr && hdlr.body + 24 < hdlr.end) {
    const nul = buf.indexOf(0, hdlr.body + 24);
    out.fill(0, hdlr.body + 24, nul >= 0 && nul < hdlr.end ? nul : hdlr.end);
  }
  // Where media data may be rewritten: inside an mdat or idat body, never across a box header.
  const bodies = [...top.filter((b) => b.type === 'mdat'), ...(idat ? [idat] : [])];
  for (const [id, loc] of locations) {
    const kind = types.get(id);
    if (kind !== 'Exif' && kind !== 'xmp') continue;
    if (loc.length !== 1) return null;
    const [r] = loc;
    if (r.open || r.end <= r.start || !bodies.some((b) => r.start >= b.body && r.end <= b.end)) return null;
    if (ranges.some((o) => o !== r && o.start < r.end && r.start < o.end)) return null;
    const payload = buf.subarray(r.start, r.end);
    let replacement: Buffer;
    if (kind === 'Exif') {
      if (payload.length < 4) return null;
      const skip = payload.readUInt32BE(0);
      if (4 + skip > payload.length) return null;
      const f = filterExif(payload.subarray(4 + skip));
      merge(found, f);
      if (f.credits) found.credits.tiff ??= f.credits;
      replacement = Buffer.concat([Buffer.alloc(4), f.tiff ?? writeTiff(false, [], [], [])]);
    } else {
      const f = filterXmp(payload);
      merge(found, f);
      if (f.credits) found.credits.xmp = f.credits;
      // A compact packet, without the wrapper, when the full one does not fit where the old one was. An item too
      // small even for that loses its credit rather than stopping the export: it holds nothing private.
      let packet = f.packet && f.packet.length > payload.length ? filterXmp(payload, { compact: true }).packet : f.packet;
      if (packet && packet.length > payload.length) packet = null;
      replacement = packet ?? Buffer.from(payload.length >= EMPTY_XMP.length ? EMPTY_XMP : '', 'utf8');
    }
    if (replacement.length > payload.length) return null;
    // EXIF is padded with zeros after its block; XMP with the whitespace its packets are designed to carry.
    out.fill(kind === 'xmp' ? 0x20 : 0, r.start, r.end);
    replacement.copy(out, r.start);
  }
  // Bytes no item refers to.
  const zeroUnreferenced = (start: number, end: number) => {
    const inside = ranges.filter((r) => r.end > start && r.start < end).sort((a, b) => a.start - b.start);
    let at = start;
    for (const r of inside) {
      if (r.start > at) out.fill(0, at, r.start);
      at = Math.max(at, r.end);
    }
    if (at < end) out.fill(0, at, end);
  };
  for (const b of top) if (b.type === 'mdat') zeroUnreferenced(b.body, b.end);
  if (idat) zeroUnreferenced(idat.body, idat.end);
  for (const b of [...top, ...children]) if (b.type === 'free' || b.type === 'skip') out.fill(0, b.body, b.end);
  return { ...found, data: out };
}

/** Item names that say only what an item is. Any other name is free text, and is cleared. */
const HEIF_NAMES = new Set(['', 'Color', 'Alpha', 'Exif', 'XMP', 'Depth', 'GainMap', 'Gain map', 'Primary', 'Thumbnail']);

/**
 * Item types by ID ('Exif', 'xmp' for an XMP mime item, or the four-character type), and where each item's name
 * is. Null if unsupported.
 */
function heifItemTypes(buf: Buffer, iinf: { body: number; end: number }): { types: Map<number, string>; names: Array<{ start: number; end: number; type: string }> } | null {
  const version = buf[iinf.body];
  const count = version === 0 ? buf.readUInt16BE(iinf.body + 4) : buf.readUInt32BE(iinf.body + 4);
  const first = iinf.body + 4 + (version === 0 ? 2 : 4);
  const out = new Map<number, string>();
  const names: Array<{ start: number; end: number; type: string }> = [];
  let entries = 0;
  for (const b of isoBoxes(buf, first, iinf.end)) {
    if (b.type !== 'infe') return null;
    entries++;
    const v = buf[b.body];
    if (v !== 2 && v !== 3) return null;
    let p = b.body + 4;
    const id = v === 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
    p += (v === 2 ? 2 : 4) + 2;
    let type = buf.toString('latin1', p, p + 4);
    p += 4;
    const nameEnd = buf.indexOf(0, p);
    names.push({ start: p, end: nameEnd >= 0 && nameEnd < b.end ? nameEnd : b.end, type });
    if (type === 'mime') {
      const cstr = () => {
        const z = buf.indexOf(0, p);
        if (z < 0 || z >= b.end) {
          const s = buf.toString('utf8', p, b.end);
          p = b.end;
          return s;
        }
        const s = buf.toString('utf8', p, z);
        p = z + 1;
        return s;
      };
      cstr(); // item name
      const contentType = cstr();
      const encoding = p < b.end ? cstr() : '';
      // Only XMP is understood; any other document item (JSON, text) could say anything.
      if (contentType !== 'application/rdf+xml' || encoding) return null;
      type = 'xmp';
    }
    if (out.has(id)) return null;
    out.set(id, type);
  }
  return entries === count ? { types: out, names } : null;
}

/** Where each item's bytes are, as absolute file ranges. Null if a layout is unsupported. */
/** An item's bytes as an absolute file range; `open` when its length was given as "to the end". */
interface Extent {
  start: number;
  end: number;
  open: boolean;
}

function heifLocations(buf: Buffer, iloc: { body: number; end: number }, idat: { body: number; end: number } | null): Map<number, Array<Extent>> | null {
  let p = iloc.body;
  /** An unsigned big-endian field of 0, 2, 4 or 8 bytes. */
  const read = (n: number) => {
    if (p + n > iloc.end) throw new Error('truncated iloc');
    const v = n === 0 ? 0 : n === 2 ? buf.readUInt16BE(p) : n === 4 ? buf.readUInt32BE(p) : n === 8 ? Number(buf.readBigUInt64BE(p)) : NaN;
    if (!Number.isSafeInteger(v)) throw new Error('bad iloc field');
    p += n;
    return v;
  };
  const version = read(4) >>> 24;
  if (version > 2) return null;
  const sizes = read(2);
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 15;
  const baseSize = (sizes >> 4) & 15;
  const indexSize = version >= 1 ? sizes & 15 : 0;
  const count = read(version < 2 ? 2 : 4);
  const out = new Map<number, Array<Extent>>();
  for (let k = 0; k < count; k++) {
    const id = read(version < 2 ? 2 : 4);
    const method = version >= 1 ? read(2) & 15 : 0;
    if (read(2) !== 0) return null; // data in another file
    // Built from other items' bytes: which bytes those are depends on references this does not follow.
    if (method > 1 || out.has(id)) return null;
    const base = read(baseSize);
    const extents = read(2);
    const list: Array<Extent> = [];
    for (let e = 0; e < extents; e++) {
      if (indexSize) read(indexSize);
      const off = read(offsetSize);
      const len = read(lengthSize);
      const origin = method === 1 ? idat?.body : 0;
      const limit = method === 1 ? idat?.end : buf.length;
      if (origin === undefined || limit === undefined) return null;
      const start = origin + base + off;
      const end = len === 0 ? limit : start + len;
      if (start > limit || end > limit) return null;
      list.push({ start, end, open: len === 0 });
    }
    out.set(id, list);
  }
  return out;
}
