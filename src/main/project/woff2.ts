/**
 * Desktop fonts (TrueType .ttf and OpenType .otf) as web fonts: the importer stores a WOFF2 copy of each, the way a
 * HEIC photo is stored as a JPEG. The copy holds the font's tables as they are (WOFF2's null transform), compressed
 * with Brotli, so every glyph, hint and feature survives and the same file always makes the same bytes.
 * Pure Node: no native encoder, no worker.
 */
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';
import { WOFF2_TAGS } from './media';

const brotliCompressAsync = promisify(brotliCompress);

/** The file extensions of the desktop fonts the importer converts. */
export const DESKTOP_FONT_EXTENSIONS = ['ttf', 'otf'];

/** Why a desktop font cannot be converted, as the end of "{file} was not imported because …". */
export class DesktopFontError extends Error {}

const round4 = (n: number) => (n + 3) & ~3;

/** A WOFF2 UIntBase128: big-endian groups of seven bits, the high bit set on every byte but the last. */
function base128(n: number): Buffer {
  const out: number[] = [n & 0x7f];
  for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
  return Buffer.from(out);
}

/** What a desktop font file's first four bytes say it is. */
export function sfntKind(buf: Buffer): 'truetype' | 'opentype' | 'collection' | 'woff' | 'woff2' | null {
  if (buf.length < 4) return null;
  const sig = buf.toString('latin1', 0, 4);
  if (sig === 'OTTO') return 'opentype';
  if (sig === 'true' || buf.readUInt32BE(0) === 0x00010000) return 'truetype';
  if (sig === 'ttcf') return 'collection';
  if (sig === 'wOFF') return 'woff';
  if (sig === 'wOF2') return 'woff2';
  return null;
}

/**
 * A WOFF2 web font holding the tables of a TrueType or OpenType font. Throws DesktopFontError when the bytes are not a
 * single, whole TrueType or OpenType font. A digital signature (DSIG) is left out: it signs the desktop file, and
 * would no longer match.
 */
export async function sfntToWoff2(buf: Buffer): Promise<Buffer> {
  const kind = sfntKind(buf);
  if (kind === 'collection') throw new DesktopFontError('it is a font collection, which holds several fonts in one file. Export each font in it as a TTF or OTF file of its own, then add those.');
  if (kind !== 'truetype' && kind !== 'opentype') throw new DesktopFontError(buf.length ? 'it is not a TrueType or OpenType font, although its name says it is. Choose the font file from the font’s download again.' : 'the file is empty. Choose the original file, or download the font again.');
  const damaged = () => new DesktopFontError('it is damaged: its font tables cannot be read. Download the font again.');
  if (buf.length < 12) throw damaged();
  const n = buf.readUInt16BE(4);
  if (!n || 12 + n * 16 > buf.length) throw damaged();
  const tables: Array<{ tag: string; data: Buffer }> = [];
  const seen = new Set<string>();
  for (let k = 0; k < n; k++) {
    const r = 12 + k * 16;
    const tag = buf.toString('latin1', r, r + 4);
    const offset = buf.readUInt32BE(r + 8);
    const length = buf.readUInt32BE(r + 12);
    if (seen.has(tag) || offset + length > buf.length) throw damaged();
    seen.add(tag);
    if (tag !== 'DSIG') tables.push({ tag, data: buf.subarray(offset, offset + length) });
  }
  // A TrueType font's outlines come in two tables that a decoder rebuilds together: neither is any use alone.
  if (seen.has('glyf') !== seen.has('loca')) throw damaged();
  // The order an sfnt lists its tables in (by tag, byte by byte), which puts loca after glyf as WOFF2 requires.
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const directory = Buffer.concat(
    tables.map(({ tag, data }) => {
      const known = WOFF2_TAGS.indexOf(tag);
      // Transform version 3 is glyf and loca's null transform; 0 is every other table's.
      const version = tag === 'glyf' || tag === 'loca' ? 3 << 6 : 0;
      const flags = Buffer.from([(known < 0 ? 63 : known) | version]);
      return Buffer.concat([flags, ...(known < 0 ? [Buffer.from(tag, 'latin1')] : []), base128(data.length)]);
    })
  );
  const stream = Buffer.concat(tables.map((t) => t.data));
  const compressed = await brotliCompressAsync(stream, {
    params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT, [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: stream.length }
  });
  const length = round4(48 + directory.length + compressed.length);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  // An old Mac TrueType font says 'true': the web knows its outlines as 0x00010000.
  header.writeUInt32BE(kind === 'opentype' ? 0x4f54544f : 0x00010000, 4);
  header.writeUInt32BE(length, 8);
  header.writeUInt16BE(tables.length, 12);
  // The size of the font a browser rebuilds: its header, its table records and each table padded to four bytes.
  header.writeUInt32BE(12 + 16 * tables.length + tables.reduce((s, t) => s + round4(t.data.length), 0), 16);
  header.writeUInt32BE(compressed.length, 20);
  header.writeUInt16BE(1, 24);
  const out = Buffer.alloc(length);
  Buffer.concat([header, directory, compressed]).copy(out);
  return out;
}
