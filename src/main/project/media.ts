/**
 * Reading what an imported file is without decoding it: image dimensions and orientation, and the family,
 * weight and style a web font declares. Pure functions over bytes, so they are tested without Electron.
 * Font tables are unpacked on Node's thread pool, never on the editor's main thread.
 */
import { promisify } from 'node:util';
import { brotliDecompress, inflate } from 'node:zlib';

const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

export interface ImageInfo {
  /** Dimensions as the image is displayed (after EXIF orientation or AVIF rotation). */
  width: number;
  height: number;
  /** EXIF orientation (1–8) of a JPEG or PNG; 1 when absent. Orientations 5–8 swap width and height. */
  orientation: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read pixel dimensions from common raster headers without decoding the image. */
export function imageInfo(buf: Buffer, mime: string): ImageInfo | null {
  try {
    // Each format is confirmed by its signature: the decoder goes by the bytes, whatever the file is named.
    if (mime === 'image/png' && buf.subarray(0, 8).equals(PNG_SIGNATURE) && buf.readUInt32BE(12) === 0x49484452) return pngInfo(buf);
    if (mime === 'image/gif' && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), orientation: 1 };
    if (mime === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) return jpegInfo(buf);
    if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), orientation: 1 };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, orientation: 1 };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, orientation: 1 };
      }
    }
    if (mime === 'image/avif') return avifInfo(buf);
    if (mime === 'image/svg+xml') {
      const t = buf.toString('utf8', 0, 2000);
      const vb = t.match(/viewBox=["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
      if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])), orientation: 1 };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Is this PNG animated (an APNG)? It has an animation control chunk (acTL) before its image data. Resizing
 * decodes one frame, so a resized copy of such a picture would be a still. Any acTL counts, even a malformed
 * one: wrongly calling a still animated only costs its copies, while missing an animation serves stills.
 * Reads chunk headers only.
 */
export function isAnimatedPng(buf: Buffer): boolean {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

/**
 * Why a raster image cannot be shown, without decoding it: 'empty' (no bytes), 'incomplete' (cut short: a part its
 * own structure says follows is missing) or 'unreadable' (not the format its type names). null when the file
 * holds a whole picture as far as its structure goes. SVG is only checked for its end here; the sanitizer checks the rest.
 */
export type ImageProblem = 'empty' | 'incomplete' | 'unreadable';

export function imageProblem(buf: Buffer, mime: string): ImageProblem | null {
  if (!buf.length) return 'empty';
  // The sanitizer would close what a cut-short SVG left open, so its end is looked for here: the root element's
  // closing tag, or a root that closes itself.
  if (mime === 'image/svg+xml') return /<\/svg\s*>|^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b[^>]*\/>/i.test(buf.toString('utf8')) ? null : 'incomplete';
  let problem: ImageProblem | null;
  try {
    problem =
      mime === 'image/jpeg' ? jpegProblem(buf) : mime === 'image/png' ? pngProblem(buf) : mime === 'image/gif' ? gifProblem(buf) : mime === 'image/webp' ? webpProblem(buf) : mime === 'image/avif' ? avifProblem(buf) : 'unreadable';
  } catch {
    // A read past the end: the structure promised more bytes than the file has.
    return 'incomplete';
  }
  if (problem) return problem;
  const info = imageInfo(buf, mime);
  return info && info.width > 0 && info.height > 0 ? null : 'unreadable';
}

/** Markers up to the first scan, then the end-of-image marker after it. Inside scan data 0xff is always escaped. */
function jpegProblem(buf: Buffer): ImageProblem | null {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return 'unreadable';
  let i = 2;
  let frame = false;
  for (;;) {
    if (i + 2 > buf.length) return 'incomplete';
    if (buf[i] !== 0xff) return 'unreadable';
    while (buf[i + 1] === 0xff && i + 2 < buf.length) i++;
    const marker = buf[i + 1];
    if (marker === 0xd9) return 'unreadable';
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) return 'incomplete';
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return 'unreadable';
    if (i + 2 + len > buf.length) return 'incomplete';
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) frame = true;
    if (marker === 0xda) return !frame ? 'unreadable' : buf.indexOf(JPEG_END, i + 2 + len) >= 0 ? null : 'incomplete';
    i += 2 + len;
  }
}
const JPEG_END = Buffer.from([0xff, 0xd9]);

/** Every chunk whole, from the header through the image data to the end chunk. */
function pngProblem(buf: Buffer): ImageProblem | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'unreadable';
  let data = false;
  for (let i = 8; ; ) {
    if (i + 12 > buf.length) return 'incomplete';
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (len > 0x7fffffff || (i === 8) !== (type === 'IHDR')) return 'unreadable';
    if (i + 12 + len > buf.length) return 'incomplete';
    if (type === 'IDAT') data = true;
    if (type === 'IEND') return data ? null : 'unreadable';
    i += 12 + len;
  }
}

/** Blocks from the screen descriptor to the trailer; a file that ends cleanly after a whole picture is accepted. */
function gifProblem(buf: Buffer): ImageProblem | null {
  if (buf.length < 13 || !/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'unreadable';
  const table = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  let p = 13 + table(buf[10]);
  let picture = false;
  /** Data sub-blocks up to their terminator; false when the file ends first. */
  const subBlocks = () => {
    for (;;) {
      if (p >= buf.length) return false;
      const n = buf[p++];
      if (!n) return true;
      p += n;
    }
  };
  for (;;) {
    if (p >= buf.length) return p === buf.length && picture ? null : 'incomplete';
    const block = buf[p++];
    if (block === 0x3b) return picture ? null : 'unreadable';
    if (block === 0x21) {
      p++;
      if (!subBlocks()) return 'incomplete';
    } else if (block === 0x2c) {
      if (p + 9 > buf.length) return 'incomplete';
      p += 9 + table(buf[p + 8]) + 1;
      if (!subBlocks()) return 'incomplete';
      picture = true;
    } else return 'unreadable';
  }
}

/** The RIFF container says how long the file is. */
function webpProblem(buf: Buffer): ImageProblem | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return 'unreadable';
  return buf.readUInt32LE(4) + 8 > buf.length ? 'incomplete' : null;
}

/** Top-level boxes, starting with the file type, each ending inside the file. */
function avifProblem(buf: Buffer): ImageProblem | null {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return 'unreadable';
  for (let p = 0; p < buf.length; ) {
    if (p + 8 > buf.length) return 'incomplete';
    let size = buf.readUInt32BE(p);
    if (size === 1) {
      if (p + 16 > buf.length) return 'incomplete';
      size = Number(buf.readBigUInt64BE(p + 8));
    } else if (size === 0) size = buf.length - p;
    if (size < 8) return 'unreadable';
    if (p + size > buf.length) return 'incomplete';
    p += size;
  }
  return null;
}

/** Back-compatible dimensions only. */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  const info = imageInfo(buf, mime);
  return info ? { width: info.width, height: info.height } : null;
}

/** PNG: the header's size, turned by the orientation in an eXIf chunk (before the image data) if there is one. */
function pngInfo(buf: Buffer): ImageInfo {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let orientation = 1;
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT' || type === 'IEND' || i + 12 + len > buf.length) break;
    if (type === 'eXIf') {
      try {
        orientation = exifOrientation(buf.subarray(i + 8, i + 8 + len)) ?? 1;
      } catch {
        // Damaged metadata does not make the picture unreadable.
      }
      break;
    }
    i += 12 + len;
  }
  return orientation >= 5 ? { width: height, height: width, orientation } : { width, height, orientation };
}

function jpegInfo(buf: Buffer): ImageInfo | null {
  let i = 2;
  let orientation = 1;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    // A marker may be padded with any number of 0xff fill bytes.
    while (buf[i + 1] === 0xff && i + 4 < buf.length) i++;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // APP1 "Exif\0\0": a TIFF block whose first directory may hold the orientation tag (0x0112).
    if (marker === 0xe1 && buf.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
      try {
        orientation = exifOrientation(buf.subarray(i + 10, i + 2 + len)) ?? orientation;
      } catch {
        // Damaged metadata does not make the picture unreadable.
      }
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return orientation >= 5 ? { width: height, height: width, orientation } : { width, height, orientation };
    }
    i += 2 + len;
  }
  return null;
}

function exifOrientation(tiff: Buffer): number | null {
  const le = tiff.toString('ascii', 0, 2) === 'II';
  if (!le && tiff.toString('ascii', 0, 2) !== 'MM') return null;
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** ISO-BMFF boxes between `start` and `end`. */
function* boxes(buf: Buffer, start: number, end: number): Generator<{ type: string; body: number; end: number }> {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(buf.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) return;
    yield { type, body, end: p + size };
    p += size;
  }
}

/** AVIF: the primary item's image spatial extent ('ispe'), turned by its rotation ('irot') if it has one. */
function avifInfo(buf: Buffer): ImageInfo | null {
  const meta = [...boxes(buf, 0, buf.length)].find((b) => b.type === 'meta');
  if (!meta) return null;
  let primary: number | null = null;
  const props: Array<{ type: string; body: number; end: number }> = [];
  const assoc = new Map<number, number[]>();
  for (const b of boxes(buf, meta.body + 4, meta.end)) {
    if (b.type === 'pitm') {
      const wide = buf[b.body] !== 0;
      if (b.body + (wide ? 8 : 6) > b.end) return null;
      primary = wide ? buf.readUInt32BE(b.body + 4) : buf.readUInt16BE(b.body + 4);
    }
    if (b.type !== 'iprp') continue;
    for (const c of boxes(buf, b.body, b.end)) {
      if (c.type === 'ipco')
        for (const p of boxes(buf, c.body, c.end)) {
          // Real files have a few dozen properties; a file claiming far more is not worth walking.
          if (props.length >= 4096) return null;
          props.push({ type: p.type, body: p.body, end: p.end });
        }
      if (c.type === 'ipma') {
        if (c.body + 8 > c.end) return null;
        const version = buf[c.body];
        const flags = buf.readUIntBE(c.body + 1, 3);
        let p = c.body + 4;
        const entries = buf.readUInt32BE(p);
        p += 4;
        for (let e = 0; e < entries; e++) {
          if (p + (version < 1 ? 3 : 5) > c.end) return null;
          const item = version < 1 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
          p += version < 1 ? 2 : 4;
          const n = buf[p++];
          if (p + n * (flags & 1 ? 2 : 1) > c.end) return null;
          const list: number[] = [];
          for (let k = 0; k < n; k++) {
            const index = flags & 1 ? buf.readUInt16BE(p) & 0x7fff : buf[p] & 0x7f;
            p += flags & 1 ? 2 : 1;
            list.push(index);
          }
          assoc.set(item, list);
        }
      }
    }
  }
  // Only the primary item's own properties count: another item's extent may be a thumbnail.
  if (primary === null || !assoc.has(primary)) return null;
  const mine = assoc.get(primary)!.map((i) => props[i - 1]).filter(Boolean);
  const ispe = mine.find((p) => p.type === 'ispe');
  if (!ispe || ispe.body + 12 > ispe.end) return null;
  const width = buf.readUInt32BE(ispe.body + 4);
  const height = buf.readUInt32BE(ispe.body + 8);
  if (!width || !height) return null;
  const irot = mine.find((p) => p.type === 'irot' && p.body < p.end);
  const quarterTurns = irot ? buf[irot.body] & 3 : 0;
  return quarterTurns % 2 ? { width: height, height: width, orientation: 1 } : { width, height, orientation: 1 };
}

// ---------------------------------------------------------------------------
// Web fonts
// ---------------------------------------------------------------------------

export interface FontInfo {
  family: string;
  /** A CSS font-weight: one weight ("700") or a variable font's range ("100 900"). */
  weight: string;
  style: 'normal' | 'italic';
}

const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
];

/** The metadata tables are small; anything larger is not a real font's. */
const MAX_META_TABLE = 2 * 1024 * 1024;
/** What a WOFF2 stream may expand to. It holds the whole font, and real web fonts are far smaller. */
const MAX_WOFF2_OUTPUT = 64 * 1024 * 1024;

/** A message the import dialog can show. Anything else thrown while parsing means the file is damaged. */
class FontFileError extends Error {}

/** The sfnt tables a font's metadata comes from, out of a WOFF or WOFF2 file. */
async function fontTables(buf: Buffer): Promise<Map<string, Buffer>> {
  const want = new Set(['name', 'OS/2', 'fvar']);
  const tables = new Map<string, Buffer>();
  const sig = buf.toString('ascii', 0, 4);
  if (sig === 'wOFF') {
    const n = buf.readUInt16BE(12);
    if (44 + n * 20 > buf.length) throw new FontFileError('it is damaged');
    for (let k = 0; k < n; k++) {
      const e = 44 + k * 20;
      const tag = buf.toString('ascii', e, e + 4);
      if (!want.has(tag)) continue;
      if (tables.has(tag)) throw new FontFileError('it is damaged');
      const offset = buf.readUInt32BE(e + 4);
      const comp = buf.readUInt32BE(e + 8);
      const orig = buf.readUInt32BE(e + 12);
      if (orig > MAX_META_TABLE || comp > orig || offset + comp > buf.length) throw new FontFileError('it is damaged');
      const raw = buf.subarray(offset, offset + comp);
      const table = comp < orig ? await inflateAsync(raw, { maxOutputLength: orig }) : raw;
      if (table.length !== orig) throw new FontFileError('it is damaged');
      tables.set(tag, table);
    }
    return tables;
  }
  if (sig !== 'wOF2') throw new FontFileError('it is not a WOFF or WOFF2 font');
  if (buf.length < 48) throw new FontFileError('it is damaged');
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new FontFileError('it is a font collection; use a single font file');
  const n = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new FontFileError('it is damaged');
  };
  const dir: Array<{ tag: string; length: number }> = [];
  for (let k = 0; k < n; k++) {
    const flags = buf[p++];
    let tag = WOFF2_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = buf.toString('ascii', p, p + 4);
      p += 4;
    }
    const version = flags >> 6;
    const orig = base128();
    // glyf and loca are transformed unless marked 3; any other table is transformed when marked non-zero.
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    const length = transformed ? base128() : orig;
    dir.push({ tag, length });
  }
  if (p + compressed > buf.length) throw new FontFileError('it is damaged');
  const data = await brotliDecompressAsync(buf.subarray(p, p + compressed), { maxOutputLength: MAX_WOFF2_OUTPUT });
  let at = 0;
  for (const t of dir) {
    if (at + t.length > data.length) throw new FontFileError('it is damaged');
    if (want.has(t.tag)) {
      if (tables.has(t.tag) || t.length > MAX_META_TABLE) throw new FontFileError('it is damaged');
      tables.set(t.tag, data.subarray(at, at + t.length));
    }
    at += t.length;
  }
  return tables;
}

function nameString(name: Buffer, ids: number[]): string | null {
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  for (const id of ids) {
    let mac: string | null = null;
    for (let k = 0; k < count; k++) {
      const r = 6 + k * 12;
      const platform = name.readUInt16BE(r);
      const nameId = name.readUInt16BE(r + 6);
      if (nameId !== id) continue;
      const length = name.readUInt16BE(r + 8);
      const offset = strings + name.readUInt16BE(r + 10);
      const raw = name.subarray(offset, offset + length);
      if (platform === 3 || platform === 0) {
        const swapped = Buffer.from(raw);
        swapped.swap16();
        return swapped.toString('utf16le').trim();
      }
      if (platform === 1) mac = raw.toString('latin1').trim();
    }
    if (mac) return mac;
  }
  return null;
}

/** Family, weight and style declared by a WOFF or WOFF2 font. Throws with a user-facing reason. */
export async function fontInfo(buf: Buffer): Promise<FontInfo> {
  try {
    return await readFontInfo(buf);
  } catch (e) {
    if (e instanceof FontFileError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new FontFileError('it is too large once unpacked');
    // Out-of-range reads and failed decompression: the file is not what its header claims.
    throw new FontFileError('it is damaged');
  }
}

async function readFontInfo(buf: Buffer): Promise<FontInfo> {
  const tables = await fontTables(buf);
  const name = tables.get('name');
  // Typographic family (16) first: "Inter", not "Inter Bold".
  const family = name ? nameString(name, [16, 1]) : null;
  if (!family) throw new FontFileError('it does not name its font family');
  const os2 = tables.get('OS/2');
  let weight = os2 && os2.length >= 6 ? String(os2.readUInt16BE(4) || 400) : '400';
  const italic = os2 && os2.length >= 64 ? (os2.readUInt16BE(62) & 0x201) !== 0 : /italic|oblique/i.test(name ? nameString(name, [17, 2]) ?? '' : '');
  // A variable font with a weight axis covers a range of weights.
  const fvar = tables.get('fvar');
  if (fvar && fvar.length >= 16) {
    const axes = fvar.readUInt16BE(4);
    const count = fvar.readUInt16BE(8);
    const size = fvar.readUInt16BE(10);
    for (let k = 0; k < count; k++) {
      const a = axes + k * size;
      if (fvar.toString('ascii', a, a + 4) !== 'wght') continue;
      const min = Math.round(fvar.readInt32BE(a + 4) / 65536);
      const max = Math.round(fvar.readInt32BE(a + 12) / 65536);
      if (min > 0 && max >= min) weight = min === max ? String(min) : `${min} ${max}`;
    }
  }
  return { family: family.replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Custom font', weight, style: italic ? 'italic' : 'normal' };
}
