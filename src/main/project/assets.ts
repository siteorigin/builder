import { promises as fs } from 'node:fs';
import { utilityProcess } from 'electron';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportReviewRow } from '@shared/api';
import type { AssetRecord } from '@shared/types';
import { newId } from '@shared/ids';
import { slugify } from '@shared/routes';
import { atomicWrite, safeJoin, sha } from './fsutil';
import { sanitizeSvg } from './svg';
import { fontInfo, heifBrands, heifHasAlpha, imageInfo, imageProblem, isAnimatedPng, type ImageProblem } from './media';
import { createVariantClient, MAX_VARIANT_PIXELS, WEB_EDGE, webCopySize, type WebCopyResult } from './media-client';

export { WEB_EDGE, webCopySize };
import { addCredits, cleanPhoto, hasCredits, sniffImageType, textCreditsAsTiff } from './photo-metadata';
import type { PhotoDecoder } from './photo-convert';

export { imageSize } from './media';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};
const MAX_BYTES = 25 * 1024 * 1024;
/** File extensions of the images the library stores (for file pickers that need one as it is). */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'];
export const FONT_EXTENSIONS = ['woff2', 'woff'];
/** Phone photos browsers can't show: the importer stores a web-sized copy of each instead. */
const PHOTO_EXTENSIONS = ['heic', 'heif'];
/** File extensions the import chooser offers: every image the library stores, and the photos it converts. */
export const IMPORT_IMAGE_EXTENSIONS = [...IMAGE_EXTENSIONS, ...PHOTO_EXTENSIONS];
/** Above this a JPEG or PNG is offered a web-sized copy at import: the size Assets flags as a large file. */
export const LARGE_PHOTO_BYTES = 1_500_000;
/** The largest photo the importer reads to make a web-sized copy of; what it stores is still held to MAX_BYTES. */
const CONVERT_MAX_BYTES = 64 * 1024 * 1024;

const isPhotoToConvert = (path: string) => PHOTO_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());

/** Conservative SVG check: reject anything executable or externally referenced. */
export function svgProblem(text: string): string | null {
  if (/<script\b/i.test(text)) return 'it contains scripts';
  if (/\son[a-z]+\s*=/i.test(text)) return 'it contains event handlers';
  if (/<foreignObject\b/i.test(text)) return 'it contains embedded HTML';
  if (/(href|src)\s*=\s*["']\s*(?!#|data:image\/(png|jpeg|gif|webp))/i.test(text)) return 'it references external files';
  if (/javascript:/i.test(text)) return 'it contains a javascript: URL';
  if (/<!ENTITY/i.test(text)) return 'it declares XML entities';
  return null;
}

const FORMAT_NAMES: Record<string, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/avif': 'AVIF', 'image/svg+xml': 'SVG' };

/** The end of "{file} was not imported because …": what is wrong with the file, and what to do about it. */
function unusableReason(problem: ImageProblem | 'damaged', mime: string): string {
  if (problem === 'damaged') return 'it is damaged: its picture data cannot be read, so no browser could show it. Open the original in an image editor and save a new copy.';
  if (problem === 'empty') return 'the file is empty. Choose the original file, or save or download it again.';
  if (problem === 'incomplete') return 'it is incomplete: the end of the picture is missing, so the copy or download was probably cut short. Copy or download it again, then import the new copy.';
  const format = FORMAT_NAMES[mime] ?? 'picture';
  return `it is not a ${format} image, although its name says it is. Open it in an image editor and save it as JPEG, PNG or WebP.`;
}

/** Is this a file of the given kind, going by its extension? A HEIC photo is an image: it is imported as a copy. */
export function isAssetOfKind(path: string, kind: 'image' | 'font'): boolean {
  if (isPhotoToConvert(path)) return kind === 'image';
  const mime = MIME[extname(path).toLowerCase()];
  return !!mime && mime.startsWith('font/') === (kind === 'font');
}

/** The end of "{file} was not imported because …" for a HEIC photo this computer cannot convert: what to do instead. */
export function noConverterReason(platform: NodeJS.Platform = process.platform): string {
  const how =
    platform === 'win32'
      ? 'Export it as a JPEG on the phone it came from, or open it in the Photos app (which needs Microsoft’s HEIF Image Extensions and HEVC Video Extensions), choose Save as and pick JPEG. Then add the JPEG here.'
      : 'Export it as a JPEG on the phone or computer it came from (on a Mac, open it in Preview and choose File › Export › JPEG), then add the JPEG here.';
  return `it is a HEIC photo, which browsers can’t show, and this computer has no converter for it. ${how}`;
}

/** The end of "{file} was not imported because …" for a HEIC photo the converter could not turn into a copy. */
const CONVERT_FAILED = 'it could not be converted. Open it in Preview, choose File › Export › JPEG, then add the JPEG here.';


/** A PNG declaring an alpha channel or a transparent colour: whether it really has see-through pixels needs a decode. */
function pngMayBeClear(buf: Buffer): boolean {
  const colourType = buf[25];
  if (colourType === 4 || colourType === 6) return true;
  for (let i = 8; i + 8 <= buf.length; ) {
    const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + buf.readUInt32BE(i);
  }
  return false;
}

/**
 * What a HEIC/HEIF file really holds, going by its bytes: a HEVC photo to convert, or a picture the library stores
 * as it is (an AVIF, or a JPEG given a .heic name). An AVIF brand wins over the generic HEIF ones.
 */
function photoType(buf: Buffer): { stored: string; ext: string } | 'heic' | null {
  const brands = heifBrands(buf);
  if (brands.some((b) => b === 'avif' || b === 'avis')) return { stored: 'image/avif', ext: '.avif' };
  if (brands.length) return 'heic';
  const sniffed = sniffImageType(buf.subarray(0, 64));
  const ext = sniffed && { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[sniffed as string];
  return ext ? { stored: sniffed!, ext } : null;
}

/** A file checked for the library: what it is, and the bytes the project keeps (a rebuilt SVG, say). */
interface PreparedFile {
  source: string;
  /** The source file's name without its extension: the record's name and the stored file's are made from it. */
  stem: string;
  ext: string;
  mime: string;
  buf: Buffer;
  hash: string;
  font?: AssetRecord['font'];
}

/** "{file} was not imported because …", or "{file} can't be used because …" when locating a library file. */
type Refusal = (reason: string) => Error;
const refusal = (sourcePath: string, verb: string): Refusal => (reason) => new Error(`${basename(sourcePath)} ${verb} because ${reason}`);

/** Read and check a file for the library, before anything is written to the project. */
async function prepareFile(sourcePath: string, refuse: Refusal): Promise<PreparedFile> {
  const ext = extname(sourcePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`${basename(sourcePath)}: only JPEG, PNG, WebP, GIF, AVIF, SVG and HEIC images, and WOFF2 or WOFF fonts, can be imported.`);
  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 25 MB.`);
  return prepareBytes(sourcePath, await fs.readFile(sourcePath), mime, ext, refuse);
}

/** Check a file's bytes for the library as `mime`, stored with `ext`. */
async function prepareBytes(sourcePath: string, bytes: Buffer, mime: string, ext: string, refuse: Refusal): Promise<PreparedFile> {
  let buf = bytes;
  // A picture no browser can show never becomes a library image an author could choose.
  const problem = mime.startsWith('image/') ? imageProblem(buf, mime) : buf.length ? null : 'empty';
  if (problem) throw refuse(unusableReason(problem, mime));
  if (mime === 'image/svg+xml') {
    // Save a rebuilt, allowlisted SVG rather than the original bytes.
    try {
      buf = Buffer.from(sanitizeSvg(buf), 'utf8');
    } catch (e) {
      const reason = (e as Error).message;
      throw refuse(reason.startsWith('it is incomplete') ? `${reason}.` : `${reason}. Export a plain SVG or use a PNG instead.`);
    }
  }
  // A font is only useful with its family, weight and style, so a file that does not declare them is refused.
  let font: AssetRecord['font'];
  if (mime.startsWith('font/')) {
    try {
      font = await fontInfo(buf);
    } catch (e) {
      throw refuse(`${(e as Error).message}. Use a WOFF2 or WOFF web font.`);
    }
  }
  return { source: sourcePath, stem: basename(sourcePath, extname(sourcePath)), ext, mime, buf, hash: sha(buf), ...(font ? { font } : {}) };
}

/** How a file is imported: as it is, or as a web-sized copy, and with what decoder for HEIC photos. */
export interface ImportOptions {
  /** Store a web-sized copy of a JPEG or PNG instead of the original. HEIC photos always become one. */
  webCopy?: boolean;
  /** The platform's HEIC decoder; without one a HEIC photo is refused with a way forward. */
  decoder?: PhotoDecoder | null;
  /** The file's content as the author's review saw it (its SHA-256): a file that has changed since is skipped. */
  fingerprint?: string;
}

/** A web-sized copy as a file for the library, carrying the source's credits (author, copyright) and nothing else. */
function preparedCopy(sourcePath: string, source: Buffer, copy: { data: Buffer; mime: 'image/jpeg' | 'image/png' }): PreparedFile {
  let credits = cleanPhoto(source)?.credits;
  // A PNG's author and copyright text has no place in a JPEG but its EXIF, merged field by field with what is there.
  if (credits?.text?.length && copy.mime === 'image/jpeg') credits = { ...credits, tiff: textCreditsAsTiff(credits.text, credits.tiff) ?? credits.tiff };
  const buf = credits && hasCredits(credits) ? addCredits(copy.data, credits) : copy.data;
  return { source: sourcePath, stem: basename(sourcePath, extname(sourcePath)), ext: copy.mime === 'image/png' ? '.png' : '.jpg', mime: copy.mime, buf, hash: sha(buf) };
}

/** What a file chosen for import is, read once: what the review shows and the import does both come from here. */
type Classified =
  /** Stored as it is (or offered a copy when `offer`). */
  | { kind: 'stored'; mime: string; ext: string; info: ReturnType<typeof imageInfo>; offer: boolean }
  /** A HEIC photo: converted when there is a decoder. */
  | { kind: 'heic'; info: ReturnType<typeof imageInfo> }
  /** Refused, with the end of "{file} was not imported because …", or a whole message (`whole`). */
  | { kind: 'refuse'; reason: string; whole?: boolean };

/**
 * What a HEIC photo or a JPEG or PNG read for a web-sized copy is, going by its bytes. A .heic file holding an AVIF
 * or a JPEG is that picture. `converter` says whether this computer can decode HEIC.
 */
function classify(sourcePath: string, buf: Buffer, converter: boolean): Classified {
  const name = basename(sourcePath);
  const tooLarge = { kind: 'refuse' as const, reason: 'it is over 100 megapixels, too large to resize here. Export a smaller JPEG copy of it, then add that.' };
  if (buf.length > CONVERT_MAX_BYTES) return { kind: 'refuse', reason: `${name} is larger than 64 MB.`, whole: true };
  if (isPhotoToConvert(sourcePath)) {
    const type = photoType(buf);
    if (!type) return { kind: 'refuse', reason: buf.length ? 'it is not a HEIC photo, although its name says it is. Open it in an image editor and save it as JPEG.' : 'the file is empty. Choose the original file, or save or download it again.' };
    if (type !== 'heic') {
      if (buf.length > MAX_BYTES) return { kind: 'refuse', reason: `${name} is larger than 25 MB.`, whole: true };
      const problem = imageProblem(buf, type.stored);
      if (problem) return { kind: 'refuse', reason: unusableReason(problem, type.stored) };
      return { kind: 'stored', mime: type.stored, ext: type.ext, info: null, offer: false };
    }
    const problem = imageProblem(buf, 'image/heic');
    if (problem === 'incomplete') return { kind: 'refuse', reason: unusableReason('incomplete', 'image/heic') };
    if (problem) return { kind: 'refuse', reason: 'it is damaged: its picture data cannot be read. Open the original in Photos or Preview and export a new copy as JPEG.' };
    if (!converter) return { kind: 'refuse', reason: noConverterReason() };
    const info = imageInfo(buf, 'image/heic');
    if (info && info.width * info.height > MAX_VARIANT_PIXELS) return tooLarge;
    return { kind: 'heic', info };
  }
  const ext = extname(sourcePath).toLowerCase();
  const mime = MIME[ext];
  const problem = imageProblem(buf, mime);
  if (problem) return { kind: 'refuse', reason: unusableReason(problem, mime) };
  const info = imageInfo(buf, mime);
  if (info && info.width * info.height > MAX_VARIANT_PIXELS) return buf.length > MAX_BYTES ? tooLarge : { kind: 'stored', mime, ext, info, offer: false };
  // A resized animation would be one still frame.
  const offer = !!info && !(mime === 'image/png' && isAnimatedPng(buf));
  return { kind: 'stored', mime, ext, info, offer };
}

/**
 * Read and check a file for the library, making the web-sized copy that is stored instead when it is a HEIC photo
 * or `webCopy` asks for one. `note` says when the original was kept although a copy was asked for.
 */
async function prepareImport(sourcePath: string, refuse: Refusal, opts: ImportOptions): Promise<PreparedFile & { note?: string }> {
  const ext = extname(sourcePath).toLowerCase();
  const heic = isPhotoToConvert(sourcePath);
  const copyOf = opts.webCopy && (MIME[ext] === 'image/jpeg' || MIME[ext] === 'image/png') ? MIME[ext] : null;
  // An ordinary file the author was not asked about is read and checked as before.
  if (!heic && !copyOf && !opts.fingerprint) return prepareFile(sourcePath, refuse);
  const stat = await fs.stat(sourcePath);
  if (stat.size > CONVERT_MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 64 MB.`);
  const buf = await fs.readFile(sourcePath);
  if (opts.fingerprint && sha(buf) !== opts.fingerprint) throw refuse('it changed while it was being reviewed. Add it again.');
  if (!heic && !copyOf) {
    if (!MIME[ext]) return prepareFile(sourcePath, refuse);
    if (buf.length > MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 25 MB.`);
    return prepareBytes(sourcePath, buf, MIME[ext], ext, refuse);
  }
  const c = classify(sourcePath, buf, !!opts.decoder);
  if (c.kind === 'refuse') throw c.whole ? new Error(c.reason) : refuse(c.reason);
  let result: WebCopyResult;
  if (c.kind === 'heic') {
    try {
      result = await opts.decoder!.decode(buf, (tiff) => mediaWorker.webCopy({ path: tiff }, WEB_EDGE));
    } catch {
      throw refuse(CONVERT_FAILED);
    }
    if (!result.ok) throw refuse(CONVERT_FAILED);
  } else {
    // A .heic holding a JPEG or an AVIF, or a JPEG or PNG no copy can be made of, is stored as it is.
    const keep = (note?: string) =>
      buf.length > MAX_BYTES
        ? Promise.reject(note ? refuse(`${note[0].toLowerCase()}${note.slice(1)}`) : new Error(`${basename(sourcePath)} is larger than 25 MB.`))
        : prepareBytes(sourcePath, buf, c.mime, c.ext, refuse).then((p) => ({ ...p, ...(note ? { note: `${basename(sourcePath)} was added as it is: ${note}` } : {}) }));
    if (heic) return keep();
    if (!c.offer) return keep('a web-sized copy of it can’t be made.');
    result = await mediaWorker.webCopy({ data: buf, mime: c.mime }, WEB_EDGE);
    if (!result.ok) {
      if (result.unreadable) throw refuse(unusableReason('damaged', c.mime));
      return keep('a web-sized copy could not be made.');
    }
    const p = preparedCopy(sourcePath, buf, result.copy);
    if (p.buf.length >= buf.length) return keep('a web-sized copy would be no smaller.');
    if (p.buf.length > MAX_BYTES) throw refuse('even a web-sized copy of it is larger than 25 MB.');
    return p;
  }
  const p = preparedCopy(sourcePath, buf, result.copy);
  if (p.buf.length > MAX_BYTES) throw refuse('even a web-sized copy of it is larger than 25 MB.');
  return p;
}

/** The format a web-sized copy takes: JPEG, PNG for see-through pixels, or either when that is not known yet. */
type CopyFormat = 'JPEG' | 'PNG' | 'JPEG or PNG';
const copyFormat = (clear: boolean | null): CopyFormat => (clear === null ? 'JPEG or PNG' : clear ? 'PNG' : 'JPEG');

/**
 * What importing a file would produce, for the author to confirm before anything is converted or written. Reads
 * no more than a file's name and size unless it is a HEIC photo or a JPEG or PNG large enough to be offered a
 * web-sized copy; `opaque` asks the media worker whether a PNG with an alpha channel really has see-through pixels.
 * The rows the author is asked about carry a fingerprint of the content they describe.
 */
export async function reviewImportFile(sourcePath: string, opts: { converter: boolean; opaque: (buf: Buffer, mime: string) => Promise<boolean | null> }): Promise<ImportReviewRow> {
  const name = basename(sourcePath);
  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    return { path: sourcePath, name, bytes: 0, action: 'import' };
  }
  const row: ImportReviewRow = { path: sourcePath, name, bytes: stat.size, action: 'import' };
  const heic = isPhotoToConvert(sourcePath);
  const mime = MIME[extname(sourcePath).toLowerCase()];
  const large = (mime === 'image/jpeg' || mime === 'image/png') && stat.size > LARGE_PHOTO_BYTES;
  if (!stat.isFile() || (!heic && !large)) return row;
  if (stat.size > CONVERT_MAX_BYTES) return { ...row, action: 'refuse', format: heic ? 'HEIC' : mime === 'image/png' ? 'PNG' : 'JPEG', reason: 'it is larger than 64 MB.' };
  const buf = await fs.readFile(sourcePath).catch(() => null);
  if (!buf) return row;
  // Everything the row says is about the bytes just read, which its fingerprint names.
  row.bytes = buf.length;
  const c = classify(sourcePath, buf, opts.converter);
  const fingerprint = sha(buf);
  // What the import would refuse, the review says now, with the same reason.
  const refused = (reason: string) => ({ ...row, action: 'refuse' as const, format: heic ? 'HEIC' : mime === 'image/png' ? 'PNG' : 'JPEG', fingerprint, reason });
  if (c.kind === 'refuse') return refused(c.whole ? c.reason.replace(`${name} is`, 'it is') : c.reason);
  if (c.kind === 'heic') {
    const size = c.info ? webCopySize(c.info.width, c.info.height) : { width: 0, height: 0 };
    // A HEIC with an alpha plane may or may not have see-through pixels: only its copy will tell.
    const format = heifHasAlpha(buf) ? copyFormat(null) : copyFormat(false);
    return { ...row, action: 'convert', format: 'HEIC', fingerprint, ...(c.info ? { width: c.info.width, height: c.info.height } : {}), copy: { format, ...size } };
  }
  if (heic) return row;
  if (!c.offer || !c.info) return buf.length > MAX_BYTES ? refused('it is larger than 25 MB.') : row;
  Object.assign(row, { format: mime === 'image/png' ? 'PNG' : 'JPEG', width: c.info.width, height: c.info.height });
  // Only a PNG that may be see-through is decoded here, so its copy's format is the one the review shows.
  const clear = mime === 'image/png' && pngMayBeClear(buf) ? await opts.opaque(buf, mime).then((o) => (o === null ? null : !o)) : false;
  return { ...row, action: 'offer', fingerprint, copy: { format: copyFormat(clear), ...webCopySize(c.info.width, c.info.height) }, ...(buf.length > MAX_BYTES ? { copyOnly: true } : {}) };
}

/** Ask the media worker whether a picture is opaque throughout (for an import review). */
export const isOpaquePicture = (buf: Buffer, mime: string) => mediaWorker.opaque(buf, mime);

/** Where a library file lives and what it is: the part of an asset record a new file replaces. */
export type StoredFile = Pick<AssetRecord, 'file' | 'mime' | 'bytes' | 'hash' | 'width' | 'height' | 'variants'>;

/** A file to put in the project, made (checked, decoded, resized) before anything is written. */
interface PendingFile {
  rel: string;
  data: Buffer;
}

/**
 * Runs the writes into the project only while they may still happen (the project is open and this app owns it),
 * and says whether they ran. The work that can take a while is done before, so a fence is held only briefly.
 */
export type WriteFence = (write: () => Promise<void>) => Promise<boolean>;
const unfenced: WriteFence = async (write) => {
  await write();
  return true;
};
const NOT_WRITTEN = 'the project was closed, or another app took it over, before it could be written';

const isFile = (path: string) => fs.lstat(path).then((s) => s.isFile(), () => false);

/**
 * Write prepared files into the project, never through a link that leads out of it. `onlyMissing` leaves a file
 * that is already there alone (one put back meanwhile). Returns the files written.
 */
async function writeFiles(projectDir: string, files: PendingFile[], onlyMissing = false): Promise<string[]> {
  const written: string[] = [];
  for (const f of files) {
    const at = safeJoin(projectDir, f.rel);
    if (onlyMissing && (await isFile(at))) continue;
    await atomicWrite(at, f.data);
    written.push(f.rel);
  }
  return written;
}

/**
 * A checked file as the importer stores it in static/assets/: its record details, and the files to write, a
 * picture's responsive copies included. A picture the decoder cannot read is refused here.
 */
async function planStore(p: PreparedFile, refuse: Refusal): Promise<{ stored: StoredFile; files: PendingFile[] }> {
  const isFont = p.mime.startsWith('font/');
  const info = isFont ? null : imageInfo(p.buf, p.mime);
  // Decoding allocates by pixel count, which a small file can inflate: very large pictures are not decoded at all
  // and keep only the original.
  const decodable = !!info && p.mime !== 'image/svg+xml' && info.width * info.height <= MAX_VARIANT_PIXELS;
  const { unreadable, variants } = decodable ? await mediaWorker.inspect(p.buf, p.mime, info.width) : { unreadable: false, variants: [] };
  if (unreadable) throw refuse(unusableReason('damaged', p.mime));
  const base = slugify(p.stem) || (isFont ? 'font' : 'image');
  const stem = `static/assets/${base}-${p.hash.slice(0, 8)}`;
  const file = `${stem}${p.ext === '.jpeg' ? '.jpg' : p.ext}`;
  const files: PendingFile[] = [{ rel: file, data: p.buf }];
  const copies: Array<{ width: number; file: string }> = [];
  for (const v of variants) {
    const copy = `${stem}-${v.width}w.${p.mime === 'image/png' ? 'png' : 'jpg'}`;
    files.push({ rel: copy, data: v.data });
    copies.push({ width: v.width, file: copy });
  }
  return { stored: { file, mime: p.mime, bytes: p.buf.length, hash: p.hash, ...(info ? { width: info.width, height: info.height } : {}), ...(copies.length ? { variants: copies } : {}) }, files };
}

/**
 * `fence` holds the writes while the project may be written to; the starter's own pictures need none. A HEIC
 * photo, or a JPEG or PNG with `opts.webCopy`, is stored as its web-sized copy; `note` says when the original was
 * kept instead. The source file is only read.
 */
export async function importAsset(
  projectDir: string,
  sourcePath: string,
  existing: AssetRecord[],
  fence: WriteFence = unfenced,
  opts: ImportOptions = {}
): Promise<{ record: AssetRecord; existing: boolean; font?: AssetRecord['font']; note?: string }> {
  const refuse = refusal(sourcePath, 'was not imported');
  const { note, ...p } = await prepareImport(sourcePath, refuse, opts);
  const noted = note ? { note } : {};
  const dup = existing.find((a) => a.hash === p.hash);
  // A font imported before metadata was recorded gets it now.
  if (dup) return { record: dup, existing: true, ...(p.font && !dup.font ? { font: p.font } : {}), ...noted };
  const isFont = p.mime.startsWith('font/');
  const { stored, files } = await planStore(p, refuse);
  if (!(await fence(async () => void (await writeFiles(projectDir, files))))) throw refuse(`${NOT_WRITTEN}.`);
  const record: AssetRecord = {
    id: newId('a'),
    name: isFont ? fontName(p.font!) : p.stem.replace(/[-_]+/g, ' ').trim() || 'Image',
    file: stored.file,
    mime: stored.mime,
    bytes: stored.bytes,
    hash: stored.hash,
    kind: isFont ? 'font' : 'image',
    createdAt: new Date().toISOString(),
    ...(stored.width !== undefined ? { width: stored.width, height: stored.height } : {}),
    ...(stored.variants ? { variants: stored.variants } : {}),
    ...(p.font ? { font: p.font } : {})
  };
  return { record, existing: false, ...noted };
}

/** A file the importer named, inside static/assets/: the only kind a library image may be restored to. */
const LIBRARY_FILE = /^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png|webp|gif|avif|svg)$/;

/**
 * Put back what a library image is missing in the project folder: its original, from `original` when that is
 * the same picture, and the smaller copies it lists, made again from the original at their recorded widths and
 * names. Files already there are left alone, even ones put back while the copies were being made. Returns the
 * files written and the copies that could not be made.
 */
export async function restoreAssetFiles(projectDir: string, record: AssetRecord, original?: Buffer, fence: WriteFence = unfenced): Promise<{ written: string[]; failed: string[] }> {
  const name = record.name.trim() || 'This image';
  if (!LIBRARY_FILE.test(record.file)) throw new Error(`${name} has a file name SiteOrigin Builder did not give it, so it cannot be restored. Choose another image instead.`);
  const at = safeJoin(projectDir, record.file);
  const files: PendingFile[] = [];
  const failed: string[] = [];
  // Copies of a different picture would show the wrong image at smaller sizes, whichever file they are made from.
  const mismatch = () => new Error(`The original file of ${name} is not the picture the library recorded, so its copies were not made again. Locate the original, or choose another image.`);
  const onDisk = (await isFile(at)) ? await fs.readFile(at).catch(() => undefined) : undefined;
  if (onDisk && sha(onDisk) !== record.hash) throw mismatch();
  const buf = onDisk ?? original;
  if (!buf) throw new Error(`The original file of ${name} is missing. Locate it first.`);
  if (sha(buf) !== record.hash) throw mismatch();
  if (!onDisk) files.push({ rel: record.file, data: buf });
  const missing: Array<{ width: number; file: string }> = [];
  for (const v of record.variants ?? []) {
    if (!LIBRARY_FILE.test(v.file)) failed.push(v.file);
    else if (!(await isFile(safeJoin(projectDir, v.file)))) missing.push(v);
  }
  if (missing.length) {
    const info = imageInfo(buf, record.mime);
    const made = info && info.width * info.height <= MAX_VARIANT_PIXELS ? await mediaWorker.variants(buf, record.mime, info.width, missing.map((v) => v.width)) : [];
    for (const v of missing) {
      const copy = made.find((c) => c.width === v.width);
      if (copy) files.push({ rel: v.file, data: copy.data });
      else failed.push(v.file);
    }
  }
  const out = { written: [] as string[], failed };
  if (files.length && !(await fence(async () => void (out.written = await writeFiles(projectDir, files, true))))) throw new Error(`${name} was not restored because ${NOT_WRITTEN}.`);
  return out;
}

/**
 * The file an author located for a library image whose original is missing. The same picture goes back where the
 * library expects it, with its copies, and nothing else changes. A different picture is stored as an import would
 * store it, and what the image record should now say is returned for asset.relink.
 */
export async function locateAssetFile(projectDir: string, record: AssetRecord, sourcePath: string, fence: WriteFence = unfenced): Promise<{ same: true; written: string[]; failed: string[] } | { same: false; stored: StoredFile }> {
  const refuse = refusal(sourcePath, "can't be used");
  if (isPhotoToConvert(sourcePath)) throw refuse('it is a HEIC photo, which browsers can’t show. Add it to Assets with Add images, which makes a JPEG copy, then use Replace everywhere.');
  if (!isAssetOfKind(sourcePath, 'image')) throw refuse('it is not an image. Choose a JPEG, PNG, WebP, GIF, AVIF or SVG file.');
  const p = await prepareFile(sourcePath, refuse);
  if (p.hash === record.hash) return { same: true, ...(await restoreAssetFiles(projectDir, record, p.buf, fence)) };
  const { stored, files } = await planStore(p, refuse);
  if (!(await fence(async () => void (await writeFiles(projectDir, files))))) throw refuse(`${NOT_WRITTEN}.`);
  return { same: false, stored };
}

/** What a web-sized copy of a library image (its original's bytes) would be, or null when none can be made from it. */
export async function libraryWebCopyPlan(record: AssetRecord, buf: Buffer): Promise<{ format: CopyFormat; width: number; height: number } | null> {
  if (record.kind !== 'image' || (record.mime !== 'image/jpeg' && record.mime !== 'image/png')) return null;
  if (record.mime === 'image/png' && isAnimatedPng(buf)) return null;
  const info = imageInfo(buf, record.mime);
  if (!info || imageProblem(buf, record.mime) || info.width * info.height > MAX_VARIANT_PIXELS) return null;
  const clear = record.mime === 'image/png' && pngMayBeClear(buf) ? await mediaWorker.opaque(buf, record.mime).then((o) => (o === null ? null : !o)) : false;
  return { format: copyFormat(clear), ...webCopySize(info.width, info.height) };
}

/**
 * Make a web-sized copy of a library image from its original's bytes and store it in the project, with its
 * responsive copies, as an import of it would be. A copy that would be no smaller is not made (`smaller: false`).
 * The record returned is new (named after the image, with its description and suggested alt text) or the library
 * image that already has those bytes (`existing`).
 */
export async function storeLibraryWebCopy(
  projectDir: string,
  record: AssetRecord,
  buf: Buffer,
  existing: AssetRecord[],
  fence: WriteFence = unfenced
): Promise<{ record: AssetRecord; existing: boolean } | { smaller: false }> {
  const name = record.name.trim() || 'Image';
  const refuse = refusal(`${name}.${record.file.split('.').pop()}`, "couldn't be copied");
  if (sha(buf) !== record.hash) throw refuse('its file is not the picture the library recorded. Locate the original first.');
  const result = await mediaWorker.webCopy({ data: buf, mime: record.mime }, WEB_EDGE);
  if (!result.ok) throw refuse(result.unreadable ? unusableReason('damaged', record.mime) : 'the web-sized copy could not be made. Try again.');
  const p = { ...preparedCopy(`${name} web`, buf, result.copy), stem: `${name} web` };
  if (p.buf.length >= buf.length) return { smaller: false };
  if (p.buf.length > MAX_BYTES) throw refuse('even its web-sized copy is larger than 25 MB.');
  const dup = existing.find((a) => a.hash === p.hash);
  if (dup) {
    // The same copy is already in the library: its files are put back first if they have left the project folder,
    // so the places it is about to fill never point at a missing file.
    const back = await restoreAssetFiles(projectDir, dup, p.buf, fence);
    const there = await fs.readFile(safeJoin(projectDir, dup.file)).catch(() => null);
    if (back.failed.length || !there || sha(there) !== dup.hash) throw refuse(`its web-sized copy is already in Assets as ${dup.name.trim() || 'another image'}, whose files could not be put back. Make its copies again in Assets.`);
    return { record: dup, existing: true };
  }
  const { stored, files } = await planStore(p, refuse);
  if (!(await fence(async () => void (await writeFiles(projectDir, files))))) throw refuse(`${NOT_WRITTEN}.`);
  const copy: AssetRecord = {
    id: newId('a'),
    name: `${name} (web-sized)`,
    file: stored.file,
    mime: stored.mime,
    bytes: stored.bytes,
    hash: stored.hash,
    kind: 'image',
    createdAt: new Date().toISOString(),
    ...(stored.width !== undefined ? { width: stored.width, height: stored.height } : {}),
    ...(stored.variants ? { variants: stored.variants } : {}),
    ...(record.description ? { description: record.description } : {}),
    ...(record.altSuggestion ? { altSuggestion: record.altSuggestion } : {})
  };
  return { record: copy, existing: false };
}

const WEIGHT_NAMES: Record<string, string> = { '100': 'Thin', '200': 'Extra Light', '300': 'Light', '400': 'Regular', '500': 'Medium', '600': 'Semibold', '700': 'Bold', '800': 'Extra Bold', '900': 'Black' };
/** "Inter Bold Italic", "Inter Variable". */
function fontName(f: NonNullable<AssetRecord['font']>): string {
  const weight = f.weight.includes(' ') ? 'Variable' : WEIGHT_NAMES[f.weight] ?? f.weight;
  return [f.family, weight === 'Regular' && f.style === 'italic' ? '' : weight, f.style === 'italic' ? 'Italic' : ''].filter(Boolean).join(' ');
}

/**
 * Only the editor's own code runs in the media worker, but it decodes files from anywhere: it gets no secrets.
 * The map is never empty, because Electron passes the whole environment on when it is.
 */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = { SITEORIGIN_MEDIA_WORKER: '1' };
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** Decoding and resizing happen in a utility process: on the main process a large photo freezes the window. */
const mediaWorker = createVariantClient(() =>
  utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'media-worker.js'), [], { serviceName: 'SiteOrigin media', env: workerEnv() })
);

/** Stop the media worker (when the app quits). */
export const stopMediaWorker = () => mediaWorker.stop();
