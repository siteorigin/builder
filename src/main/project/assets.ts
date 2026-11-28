import { promises as fs } from 'node:fs';
import { availableParallelism } from 'node:os';
import { utilityProcess } from 'electron';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportReviewRow, WebCopyPlan } from '@shared/api';
import type { AssetRecord } from '@shared/types';
import { newId } from '@shared/ids';
import { slugify } from '@shared/routes';
import { DOCUMENT_EXTENSIONS, DOCUMENT_FORMATS, documentFormat } from '@shared/document-files';
import { COPY_EXTENSIONS, copyMime, isCopyMime, type CopyMime } from '@shared/picture-formats';
import { atomicWrite, safeJoin, sha } from './fsutil';
import { countMediaRead, perf } from '../perf';
import { readRegularFile } from '../packs/files';
import { sanitizeSvg } from './svg';
import { fontInfo, heifBrands, heifHasAlpha, imageInfo, imageProblem, isAnimatedPng, type ImageProblem } from './media';
import { createVariantClient, MAX_VARIANT_PIXELS, WEB_EDGE, webCopySize, type WebCopyResult } from './media-client';
import type { SiteIconRenderer } from './site-icons';

export { WEB_EDGE, webCopySize };
import { addCredits, cleanPhoto, hasCredits, sniffImageType, textCreditsAsTiff, type PhotoCredits, type PhotoMetadata } from './photo-metadata';
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
  '.woff': 'font/woff',
  ...Object.fromEntries(DOCUMENT_EXTENSIONS.map((ext) => [`.${ext}`, DOCUMENT_FORMATS[ext].mime]))
};
const MAX_BYTES = 25 * 1024 * 1024;
/** File extensions of the images the library stores (for file pickers that need one as it is). */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'];
/** The type of a picture the library takes, by its extension (".jpg"), or undefined for anything else. */
export const pictureMime = (ext: string): string | undefined => (IMAGE_EXTENSIONS.includes(ext.slice(1).toLowerCase()) ? MIME[ext.toLowerCase()] : undefined);
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
export { DOCUMENT_EXTENSIONS };

export type AssetKind = AssetRecord['kind'];
const kindOfMime = (mime: string): AssetKind => (mime.startsWith('font/') ? 'font' : mime.startsWith('image/') ? 'image' : 'document');

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
export function isAssetOfKind(path: string, kind: AssetKind): boolean {
  if (isPhotoToConvert(path)) return kind === 'image';
  const mime = MIME[extname(path).toLowerCase()];
  return !!mime && kindOfMime(mime) === kind;
}

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OOXML_PARTS: Record<string, string> = { docx: 'word/', xlsx: 'xl/', pptx: 'ppt/' };

/**
 * Whether a document's bytes are what its name says: a PDF has the PDF header, Office and OpenDocument files are
 * the archives (or, for the older Office formats, the compound files) those formats are, and text has no binary
 * zeros (unless it starts with a UTF-16 byte order mark). The bytes are kept as they are; nothing is converted.
 */
function documentMatches(buf: Buffer, ext: string): boolean {
  switch (ext) {
    case 'pdf':
      return buf.subarray(0, 1024).includes('%PDF-');
    case 'doc':
    case 'xls':
    case 'ppt':
      return buf.subarray(0, OLE.length).equals(OLE);
    case 'txt':
    case 'csv': {
      const head = buf.subarray(0, 8192);
      return (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff) || !head.includes(0);
    }
    case 'odt':
    case 'ods':
    case 'odp': {
      // An OpenDocument file is an archive whose first entry, stored as it is, is "mimetype" naming the format.
      if (!buf.subarray(0, ZIP.length).equals(ZIP) || buf.subarray(30, 38).toString('latin1') !== 'mimetype') return false;
      const at = 38 + buf.readUInt16LE(28);
      const mime = DOCUMENT_FORMATS[ext].mime;
      return buf.subarray(at, at + mime.length).toString('latin1') === mime;
    }
    case 'docx':
    case 'xlsx':
    case 'pptx':
      // An Office Open XML file is an archive that lists its parts' types, with its main part in the folder of its
      // kind: a workbook renamed .docx is no Word document.
      return buf.subarray(0, ZIP.length).equals(ZIP) && buf.includes('[Content_Types].xml') && buf.includes(OOXML_PARTS[ext]);
    default:
      return buf.subarray(0, ZIP.length).equals(ZIP);
  }
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
  /** The bytes are a picture this app just made (a web-sized copy, a converted photo), so they need no check that they decode. */
  made?: true;
}

/** "{file} was not imported because …", or "{file} can't be used because …" when locating a library file. */
type Refusal = (reason: string) => Error;
const refusal = (sourcePath: string, verb: string): Refusal => (reason) => new Error(`${basename(sourcePath)} ${verb} because ${reason}`);

/** Read and check a file for the library, before anything is written to the project. */
async function prepareFile(sourcePath: string, refuse: Refusal): Promise<PreparedFile> {
  const ext = extname(sourcePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`${basename(sourcePath)}: only JPEG, PNG, WebP, GIF, AVIF, SVG and HEIC images, WOFF2 or WOFF fonts, and PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP documents can be imported.`);
  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 25 MB.`);
  const bytes = await fs.readFile(sourcePath);
  countMediaRead(bytes.length);
  return prepareBytes(sourcePath, bytes, mime, ext, refuse);
}

/** Check a file's bytes for the library as `mime`, stored with `ext`. */
async function prepareBytes(sourcePath: string, bytes: Buffer, mime: string, ext: string, refuse: Refusal): Promise<PreparedFile> {
  let buf = bytes;
  // A document is copied as it is, once it is the kind of file its name says.
  if (kindOfMime(mime) === 'document') {
    if (buf.length > MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 25 MB.`);
    if (!buf.length) throw refuse('the file is empty. Choose the original file, or save or download it again.');
    const format = documentFormat(sourcePath)!;
    if (!documentMatches(buf, format.ext)) throw refuse(`it is not a${/^[aeiou]/i.test(format.label) ? 'n' : ''} ${format.label}, although its name says it is. Open it in the app that made it and save or export it again.`);
    return { source: sourcePath, stem: basename(sourcePath, extname(sourcePath)), ext, mime, buf, hash: sha(buf) };
  }
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
  /**
   * When the import began. Every file one import adds shares it, so how fast each file was read or converted never
   * decides their order: images added together are listed by name (see compareAssets).
   */
  createdAt?: string;
  /** Hand back the files the import wrote, the picture's copies included (a new project's sample photos keep them). */
  keepFiles?: boolean;
  /**
   * Store a picture's own file and record it as waiting for its copies (copiesPending), which makePendingCopies makes
   * once it has landed (#979), instead of making them first.
   */
  copiesLater?: boolean;
}

/** A web-sized copy as a file for the library, carrying the source's credits (author, copyright) and nothing else. */
function preparedCopy(sourcePath: string, sourceCredits: PhotoCredits | undefined, copy: { data: Buffer; mime: 'image/jpeg' | 'image/png' }): PreparedFile {
  // The source's credits, as cleanPhoto reads them.
  let credits = sourceCredits;
  // A PNG's author and copyright text has no place in a JPEG but its EXIF, merged field by field with what is there.
  if (credits?.text?.length && copy.mime === 'image/jpeg') credits = { ...credits, tiff: textCreditsAsTiff(credits.text, credits.tiff) ?? credits.tiff };
  const buf = credits && hasCredits(credits) ? addCredits(copy.data, credits) : copy.data;
  return { source: sourcePath, stem: basename(sourcePath, extname(sourcePath)), ext: copy.mime === 'image/png' ? '.png' : '.jpg', mime: copy.mime, buf, hash: sha(buf), made: true };
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
      // Its name never said what it holds, so a picture that can't be read is only called damaged.
      if (problem) return { kind: 'refuse', reason: unusableReason(problem === 'unreadable' ? 'damaged' : problem, type.stored) };
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
  countMediaRead(buf.length);
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
      result = await opts.decoder!.decode(buf, (tiff) => mediaWorker.webCopy({ path: tiff }, WEB_EDGE, c.info ? c.info.width * c.info.height : undefined));
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
    result = await mediaWorker.webCopy({ data: buf, mime: c.mime }, WEB_EDGE, c.info ? c.info.width * c.info.height : undefined);
    if (!result.ok) {
      if (result.unreadable) throw refuse(unusableReason('damaged', c.mime));
      return keep('a web-sized copy could not be made.');
    }
    const p = preparedCopy(sourcePath, cleanPhoto(buf)?.credits, result.copy);
    if (p.buf.length >= buf.length) return keep('a web-sized copy would be no smaller.');
    if (p.buf.length > MAX_BYTES) throw refuse('even a web-sized copy of it is larger than 25 MB.');
    return p;
  }
  const p = preparedCopy(sourcePath, cleanPhoto(buf)?.credits, result.copy);
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
  if (!stat.isFile()) return row;
  // A plain image is read too, so a file that can't be added (a text file named .png, an empty .jpg, one over 25 MB)
  // is counted out here instead of in a count of files added.
  if (!heic && !large && !mime) return row;
  // Named as the format is, not as its extension is spelled: a .jpg file is a JPEG, like the rows that read it.
  const ext = extname(sourcePath).slice(1).toUpperCase();
  const label = heic ? 'HEIC' : ext === 'JPG' ? 'JPEG' : ext || 'Image';
  if (!heic && !large && stat.size > MAX_BYTES) return { ...row, action: 'refuse', format: label, reason: 'it is larger than 25 MB.' };
  if (stat.size > CONVERT_MAX_BYTES) return { ...row, action: 'refuse', format: label, reason: 'it is larger than 64 MB.' };
  const buf = await fs.readFile(sourcePath).catch(() => null);
  if (!buf) return row;
  countMediaRead(buf.length);
  // Everything the row says is about the bytes just read, which its fingerprint names.
  row.bytes = buf.length;
  const c = classify(sourcePath, buf, opts.converter);
  const fingerprint = sha(buf);
  // What the import would refuse, the review says now, with the same reason.
  const refused = (reason: string) => ({ ...row, action: 'refuse' as const, format: label, fingerprint, reason });
  if (c.kind === 'refuse') return refused(c.whole ? c.reason.replace(`${name} is`, 'it is') : c.reason);
  if (c.kind === 'heic') {
    const size = c.info ? webCopySize(c.info.width, c.info.height) : { width: 0, height: 0 };
    // A HEIC with an alpha plane may or may not have see-through pixels: only its copy will tell.
    const format = heifHasAlpha(buf) ? copyFormat(null) : copyFormat(false);
    return { ...row, action: 'convert', format: 'HEIC', fingerprint, ...(c.info ? { width: c.info.width, height: c.info.height } : {}), copy: { format, ...size } };
  }
  // An ordinary file that can be read is added as it is: only a large photo is offered a copy.
  if (heic || !large) return row;
  if (!c.offer || !c.info) return buf.length > MAX_BYTES ? refused('it is larger than 25 MB.') : row;
  Object.assign(row, { format: mime === 'image/png' ? 'PNG' : 'JPEG', width: c.info.width, height: c.info.height });
  // Only a PNG that may be see-through is decoded here, so its copy's format is the one the review shows.
  const clear = mime === 'image/png' && pngMayBeClear(buf) ? await opts.opaque(buf, mime).then((o) => (o === null ? null : !o)) : false;
  return { ...row, action: 'offer', fingerprint, copy: { format: copyFormat(clear), ...webCopySize(c.info.width, c.info.height) }, ...(buf.length > MAX_BYTES ? { copyOnly: true } : {}) };
}

/** Ask the media worker whether a picture is opaque throughout (for an import review). */
export const isOpaquePicture = (buf: Buffer, mime: string) => {
  const info = imageInfo(buf, mime);
  return mediaWorker.opaque(buf, mime, info ? info.width * info.height : undefined);
};

/**
 * The pixels the worker decodes to check a picture: every frame of a GIF or an animated WebP (whose frames are not
 * counted here, so it is given the worker to itself), the one frame of anything else.
 */
export function checkPixels(buf: Buffer, mime: string, info: { width: number; height: number }): number {
  const animatedWebp = mime === 'image/webp' && buf.toString('latin1', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0;
  return mime === 'image/gif' || animatedWebp ? MEDIA_PIXEL_BUDGET : info.width * info.height;
}

/** Where a library file lives and what it is: the part of an asset record a new file replaces. */
export type StoredFile = Pick<AssetRecord, 'file' | 'mime' | 'bytes' | 'hash' | 'width' | 'height' | 'variants' | 'originalName'>;

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
 * Write a planned import. A document's name holds only eight characters of its hash, which another file can share:
 * when a different file already has the name (one kept for undo, say), or another library record claims it (its
 * file moved away for now), this one takes the next free numbered name, so a link never starts serving other bytes.
 * Pictures and fonts keep the name they were planned with. `library` is the records already in the project.
 */
async function writePlanned(projectDir: string, stored: StoredFile, files: PendingFile[], library: AssetRecord[] = []): Promise<void> {
  if (files.length === 1 && kindOfMime(stored.mime) === 'document') {
    const data = files[0].data;
    const claimed = new Map(library.filter((a) => typeof a?.file === 'string').map((a) => [a.file, a.hash]));
    for (let n = 1; ; n++) {
      const rel = n === 1 ? stored.file : stored.file.replace(/-([a-f0-9]{8})(\.[a-z0-9]+)$/, `-${n}-$1$2`);
      const at = safeJoin(projectDir, rel);
      const other = claimed.has(rel) && claimed.get(rel) !== stored.hash;
      const there = !other && (await isFile(at)) ? await fs.readFile(at).catch(() => null) : null;
      // The same bytes are already in place: nothing to write.
      if (there?.equals(data)) {
        stored.file = rel;
        return;
      }
      if (!other && !there && !(await fs.lstat(at).then(() => true, () => false))) {
        stored.file = files[0].rel = rel;
        break;
      }
      if (n >= 50) throw new Error('every name for this file is taken in the assets folder');
    }
  }
  await writeFiles(projectDir, files);
}

/**
 * A checked file as the importer stores it in static/assets/: its record details, and the files to write, a
 * picture's responsive copies included. A picture the decoder cannot read is refused here.
 */
async function planStore(p: PreparedFile, refuse: Refusal, later = false): Promise<{ stored: StoredFile; files: PendingFile[]; copiesPending?: true }> {
  const kind = kindOfMime(p.mime);
  if (kind === 'document') {
    const file = `static/assets/${slugify(p.stem) || 'document'}-${p.hash.slice(0, 8)}${p.ext}`;
    return { stored: { file, mime: p.mime, bytes: p.buf.length, hash: p.hash }, files: [{ rel: file, data: p.buf }] };
  }
  const isFont = kind === 'font';
  const info = isFont ? null : imageInfo(p.buf, p.mime);
  // Decoding allocates by pixel count, which a small file can inflate: very large pictures are not decoded at all
  // and keep only the original.
  const decodable = !!info && p.mime !== 'image/svg+xml' && info.width * info.height <= MAX_VARIANT_PIXELS;
  // Copies made later are made of a picture that is first proved to decode, unless this app just made it.
  const pending = later && decodable && isCopyMime(p.mime);
  const pixels = info ? checkPixels(p.buf, p.mime, info) : 0;
  const { unreadable, variants } = !decodable ? { unreadable: false, variants: [] } : pending ? (p.made ? { unreadable: false, variants: [] } : await mediaWorker.check(p.buf, p.mime, pixels)) : await mediaWorker.inspect(p.buf, p.mime, info.width, pixels);
  if (unreadable) throw refuse(unusableReason('damaged', p.mime));
  const base = slugify(p.stem) || (isFont ? 'font' : 'image');
  const stem = `static/assets/${base}-${p.hash.slice(0, 8)}`;
  const file = `${stem}${p.ext === '.jpeg' ? '.jpg' : p.ext}`;
  const files: PendingFile[] = [{ rel: file, data: p.buf }];
  const copies: Array<{ width: number; file: string }> = [];
  for (const v of variants) {
    const copy = `${stem}-${v.width}w.${COPY_EXTENSIONS[v.mime]}`;
    files.push({ rel: copy, data: v.data });
    copies.push({ width: v.width, file: copy });
  }
  return { stored: { file, mime: p.mime, bytes: p.buf.length, hash: p.hash, ...(info ? { width: info.width, height: info.height } : {}), ...(copies.length ? { variants: copies } : {}) }, files, ...(pending ? { copiesPending: true as const } : {}) };
}

/** A library file's responsive copy at `width` in `mime`, as the importer names it: beside the file, by its width. */
const copyFile = (file: string, width: number, mime: CopyMime) => `${file.replace(/\.[a-z0-9]+$/, '')}-${width}w.${COPY_EXTENSIONS[mime]}`;

/**
 * Make the responsive copies of a library image that was added before them (copiesPending, #979), from its file in the
 * project: read, held to the content the record names, its copies made as an import makes them (the same set, sizes and
 * bytes) and written while `fence` allows, leaving any already there alone. Returns the copies, for the session to give
 * the record (ProjectSession.fillCopies); none when the worker could make none, as an import stores a picture then;
 * null when they can't be made from what is in the project (its file is missing or is not the picture recorded, or the
 * project was closed). Rejects when a copy cannot be written.
 */
export async function makePendingCopies(projectDir: string, record: AssetRecord, fence: WriteFence): Promise<Array<{ width: number; file: string }> | null> {
  if (record.kind !== 'image' || !LIBRARY_FILE.test(record.file)) return null;
  const at = safeJoin(projectDir, record.file);
  const buf = (await isFile(at)) ? await readRegularFile(at, CONVERT_MAX_BYTES).catch(() => null) : null;
  if (!buf || sha(buf) !== record.hash) return null;
  const info = imageInfo(buf, record.mime);
  if (!info || !isCopyMime(record.mime) || info.width * info.height > MAX_VARIANT_PIXELS) return [];
  const made = await mediaWorker.variants(buf, record.mime, info.width, undefined, checkPixels(buf, record.mime, info));
  const files: PendingFile[] = made.map((v) => ({ rel: copyFile(record.file, v.width, v.mime), data: v.data }));
  // A copy already there (written before the app stopped, or put back) is left as it is, as restoring copies leaves it.
  if (files.length && !(await fence(async () => void (await writeFiles(projectDir, files, true))))) return null;
  return made.map((v, i) => ({ width: v.width, file: files[i].rel }));
}

/** The name a file had where it was read from, extension included, as its asset record keeps it. */
export const originalNameOf = (sourcePath: string) => basename(sourcePath).slice(0, 255);

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
): Promise<{ record: AssetRecord; existing: boolean; font?: AssetRecord['font']; note?: string; files?: ReadonlyArray<{ rel: string; data: Buffer }> }> {
  const refuse = refusal(sourcePath, 'was not imported');
  const { note, ...p } = await prepareImport(sourcePath, refuse, opts);
  const noted = note ? { note } : {};
  const dup = sameFile(existing, p);
  // A font imported before metadata was recorded gets it now.
  if (dup) return { record: dup, existing: true, ...(p.font && !dup.font ? { font: p.font } : {}), ...noted };
  return { ...(await storePrepared(projectDir, sourcePath, p, existing, fence, opts, refuse)), ...noted };
}

/** The library record already holding a prepared file's bytes. The same bytes under another format's name (a .txt and a .csv) are a file of their own. */
const sameFile = (library: AssetRecord[], p: PreparedFile) => library.find((a) => a.hash === p.hash && a.mime === p.mime);

/** Store a prepared file the library does not have yet: its copies made, its files written while `fence` allows. */
async function storePrepared(projectDir: string, sourcePath: string, p: PreparedFile, existing: AssetRecord[], fence: WriteFence, opts: ImportOptions, refuse: Refusal): Promise<{ record: AssetRecord; existing: false; files?: ReadonlyArray<{ rel: string; data: Buffer }> }> {
  const kind = kindOfMime(p.mime);
  const { stored, files, copiesPending } = await planStore(p, refuse, !!opts.copiesLater);
  if (!(await fence(() => writePlanned(projectDir, stored, files, existing)))) throw refuse(`${NOT_WRITTEN}.`);
  const record: AssetRecord = {
    id: newId('a'),
    name: kind === 'font' ? fontName(p.font!) : p.stem.replace(/[-_]+/g, ' ').trim().slice(0, 200) || (kind === 'document' ? 'Document' : 'Image'),
    file: stored.file,
    mime: stored.mime,
    bytes: stored.bytes,
    hash: stored.hash,
    kind,
    originalName: originalNameOf(sourcePath),
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(stored.width !== undefined ? { width: stored.width, height: stored.height } : {}),
    ...(stored.variants ? { variants: stored.variants } : {}),
    ...(copiesPending ? { copiesPending } : {}),
    ...(p.font ? { font: p.font } : {})
  };
  // The files as written, the picture's copies included, for a caller that keeps them (starter-samples.ts).
  return { record, existing: false, ...(opts.keepFiles ? { files } : {}) };
}

/** One file of a batch, as importAsset returns it, or why it was not imported. */
export type BatchOutcome = Awaited<ReturnType<typeof importAsset>> | { error: Error };

/**
 * Import `files` as importAsset imports each, up to `parallel` at a time (as many pictures as the media worker makes at
 * once), with each file's outcome in its place. Which file stores a picture is settled in the files' order: before
 * storing, a file waits until every file before it has been read and prepared, so the same picture given twice is one
 * asset, stored by the first file that could store it, exactly as when the files are imported one after another.
 * `known` is the library before the batch and gains each record stored. `go` is asked before each file starts; once it
 * says no, no more start, and the files not started have no outcome.
 */
export async function importAssetBatch(
  projectDir: string,
  files: ReadonlyArray<{ path: string; opts: ImportOptions }>,
  known: AssetRecord[],
  fence: WriteFence,
  batch: { parallel: number; go: () => boolean }
): Promise<Array<BatchOutcome | undefined>> {
  const out: Array<BatchOutcome | undefined> = new Array(files.length);
  // Each picture's store so far, by content: the record a later file with the same bytes takes (null when it failed).
  const stores = new Map<string, Promise<AssetRecord | null>>();
  // Settled once the file started last has claimed its picture (or failed before it could), so claims go in order.
  let turn: Promise<void> = Promise.resolve();
  let next = 0;
  let stopped = false;
  const one = async (i: number, after: Promise<void>, claimed: () => void): Promise<BatchOutcome> => {
    const { path, opts } = files[i];
    const refuse = refusal(path, 'was not imported');
    let prepared: Awaited<ReturnType<typeof prepareImport>>;
    try {
      prepared = await prepareImport(path, refuse, opts);
    } catch (e) {
      await after;
      claimed();
      return { error: e as Error };
    }
    await after;
    const { note, ...p } = prepared;
    const noted = note ? { note } : {};
    const dup = sameFile(known, p);
    if (dup) {
      claimed();
      return { record: dup, existing: true, ...(p.font && !dup.font ? { font: p.font } : {}), ...noted };
    }
    // A file before this one with the same bytes is storing them: its record is this one's too, unless it failed.
    const key = `${p.hash}\0${p.mime}`;
    const earlier = stores.get(key) ?? Promise.resolve(null);
    const mine = earlier.then((record): Promise<BatchOutcome> | BatchOutcome => (record ? { record, existing: true, ...noted } : storePrepared(projectDir, path, p, known, fence, opts, refuse).then((r) => ((known.push(r.record), { ...r, ...noted })))));
    stores.set(key, mine.then((r) => ('record' in r ? r.record : null), () => null));
    claimed();
    return mine.catch((e: unknown) => ({ error: e as Error }));
  };
  const lane = async () => {
    while (!stopped && next < files.length) {
      if (!batch.go()) {
        stopped = true;
        break;
      }
      const i = next++;
      const after = turn;
      let claimed!: () => void;
      turn = new Promise<void>((resolve) => (claimed = resolve));
      const end = perf.span('import.file', { i });
      out[i] = await one(i, after, claimed);
      end();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(batch.parallel, files.length)) }, lane));
  return out;
}

/**
 * Store an image a component package carries, as the library stores a file it imports: checked, resized copies made,
 * and written only while `fence` allows. The same picture already in the library is that record. An SVG is stored
 * only when it is already as the library would rebuild it: one the rebuild would change holds something (a script, an
 * event handler, a remote file) that no site image may, and is refused rather than quietly changed.
 */
export async function importPackageImage(
  projectDir: string,
  image: { name: string; mime: string; ext: string; bytes: Buffer },
  existing: AssetRecord[],
  fence: WriteFence = unfenced,
  createdAt = new Date().toISOString()
): Promise<{ record: AssetRecord; existing: boolean }> {
  const shown = `${image.name.trim().slice(0, 80) || 'Image'}${image.ext}`;
  const refuse = refusal(shown, 'was not imported');
  if (!image.mime.startsWith('image/') || !MIME[image.ext] || MIME[image.ext] !== image.mime) throw refuse('it is not a picture the library takes.');
  if (image.bytes.length > MAX_BYTES) throw new Error(`${shown} is larger than 25 MB.`);
  const p = await prepareBytes(shown, image.bytes, image.mime, image.ext, refuse);
  if (image.mime === 'image/svg+xml' && !p.buf.equals(image.bytes)) throw refuse('it holds scripts, links or other content a site’s images may not have.');
  // The same picture already in the library is that record, while its file is still the picture. One whose file has
  // gone gets a record of its own; one whose file now holds something else is left alone, never written over.
  let changed: AssetRecord | undefined;
  for (const dup of existing.filter((a) => a.hash === p.hash && a.mime === p.mime)) {
    const at = safeJoin(projectDir, dup.file);
    const there = await fs.lstat(at).then((st) => (st.isFile() ? readRegularFile(at, MAX_BYTES).catch(() => null) : null), () => 'missing' as const);
    if (Buffer.isBuffer(there) && sha(there) === dup.hash) return { record: dup, existing: true };
    if (there !== 'missing') changed ??= dup;
  }
  if (changed) throw refuse(`the library's own copy of it (“${changed.name}”) has changed in the project folder. Locate it in Assets, then import again.`);
  const { stored, files } = await planStore(p, refuse);
  // A file already at a planned name is never replaced: the same bytes (left by an import that was then refused) are
  // used as they are, and anything else is someone else's file.
  const pending: PendingFile[] = [];
  for (const f of files) {
    const at = safeJoin(projectDir, f.rel);
    const there = await fs.lstat(at).then(() => readRegularFile(at, Math.max(f.data.length, 1)).catch(() => null), () => 'missing' as const);
    if (there === 'missing') pending.push(f);
    else if (!Buffer.isBuffer(there) || !there.equals(f.data)) throw refuse(`a different file already has its name (${f.rel.split('/').pop()}) in the project folder.`);
  }
  if (!(await fence(() => writePlanned(projectDir, stored, pending, existing)))) throw refuse(`${NOT_WRITTEN}.`);
  const record: AssetRecord = {
    id: newId('a'),
    name: image.name.trim().slice(0, 200) || 'Image',
    file: stored.file,
    mime: stored.mime,
    bytes: stored.bytes,
    hash: stored.hash,
    kind: 'image',
    createdAt,
    ...(stored.width !== undefined ? { width: stored.width, height: stored.height } : {}),
    ...(stored.variants ? { variants: stored.variants } : {})
  };
  return { record, existing: false };
}

/** A file the importer named, inside static/assets/: the only kind a library image or document may be restored to. */
const LIBRARY_FILE = new RegExp(`^static/assets/[a-z0-9][a-z0-9-]*\\.(jpg|png|webp|gif|avif|svg|${DOCUMENT_EXTENSIONS.join('|')})$`);

/**
 * Put back what a library image is missing in the project folder: its original, from `original` when that is
 * the same picture, and the copies it lists, made again from the original at their recorded widths, formats (their
 * names' extensions) and names. Only the missing copies are made. Files already there are left alone, even ones put
 * back while the copies were being made. Returns the files written and the copies that could not be made.
 */
export async function restoreAssetFiles(projectDir: string, record: AssetRecord, original?: Buffer, fence: WriteFence = unfenced): Promise<{ written: string[]; failed: string[] }> {
  const document = record.kind === 'document';
  const name = record.name.trim() || (document ? 'This document' : 'This image');
  if (!LIBRARY_FILE.test(record.file)) throw new Error(`${name} has a file name SiteOrigin Builder did not give it, so it cannot be restored. Choose another ${document ? 'file' : 'image'} instead.`);
  const at = safeJoin(projectDir, record.file);
  const files: PendingFile[] = [];
  const failed: string[] = [];
  // Copies of a different picture would show the wrong image at smaller sizes, whichever file they are made from.
  const mismatch = () =>
    new Error(
      document
        ? `The file of ${name} in the project folder is not the one the library recorded. Give the document its file again in Assets.`
        : `The original file of ${name} is not the picture the library recorded, so its copies were not made again. Locate the original, or choose another image.`
    );
  const onDisk = (await isFile(at)) ? await fs.readFile(at).catch(() => undefined) : undefined;
  if (onDisk && sha(onDisk) !== record.hash) throw mismatch();
  const buf = onDisk ?? original;
  if (!buf) throw new Error(`The original file of ${name} is missing. Locate it first.`);
  if (sha(buf) !== record.hash) throw mismatch();
  if (!onDisk) files.push({ rel: record.file, data: buf });
  const missing: Array<{ width: number; file: string; mime: CopyMime }> = [];
  for (const v of record.variants ?? []) {
    const mime = copyMime(v.file);
    if (!LIBRARY_FILE.test(v.file)) failed.push(v.file);
    else if (await isFile(safeJoin(projectDir, v.file))) continue;
    // A copy in a format no copy is made in cannot be made again.
    else if (!mime) failed.push(v.file);
    else missing.push({ ...v, mime });
  }
  if (missing.length) {
    const info = imageInfo(buf, record.mime);
    const made = info && info.width * info.height <= MAX_VARIANT_PIXELS ? await mediaWorker.variants(buf, record.mime, info.width, missing.map((v) => ({ width: v.width, mime: v.mime })), info.width * info.height) : [];
    for (const v of missing) {
      // By width and format: copies of one width in two formats are two different files.
      const copy = made.find((c) => c.width === v.width && c.mime === v.mime);
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
export async function locateAssetFile(projectDir: string, record: AssetRecord, sourcePath: string, fence: WriteFence = unfenced, library: AssetRecord[] = []): Promise<{ same: true; written: string[]; failed: string[] } | { same: false; stored: StoredFile }> {
  const refuse = refusal(sourcePath, "can't be used");
  const document = record.kind === 'document';
  if (document && !isAssetOfKind(sourcePath, 'document')) throw refuse('it is not a document. Choose a PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV or ZIP file.');
  if (!document && isPhotoToConvert(sourcePath)) throw refuse('it is a HEIC photo, which browsers can’t show. Add it to Assets with Add images, which makes a JPEG copy, then use Replace everywhere.');
  if (!document && !isAssetOfKind(sourcePath, 'image')) throw refuse('it is not an image. Choose a JPEG, PNG, WebP, GIF, AVIF or SVG file.');
  const p = await prepareFile(sourcePath, refuse);
  if (p.hash === record.hash && p.mime === record.mime) return { same: true, ...(await restoreAssetFiles(projectDir, record, p.buf, fence)) };
  const { stored, files } = await planStore(p, refuse);
  if (!(await fence(() => writePlanned(projectDir, stored, files, library)))) throw refuse(`${NOT_WRITTEN}.`);
  return { same: false, stored: { ...stored, originalName: originalNameOf(sourcePath) } };
}

/**
 * A web-sized copy is worth making only when it is at most this share of the original's bytes. A copy that saves
 * less, such as the app's own web-sized copy made again (which can save a quarter on a sharp-edged picture), would
 * mostly lose detail.
 */
export const LIGHTER_SHARE = 2 / 3;
const worthwhile = (copy: Buffer, originalBytes: number) => copy.length <= originalBytes * LIGHTER_SHARE;

/**
 * Plans measured or being measured, by the original's content: opening the same picture again, or going back to it
 * before its answer came, never encodes it again. Only answers already in are let go to keep the map small: one
 * still queued is never asked for a second time.
 */
const measured = new Map<string, { plan: Promise<WebCopyPlan>; done: boolean }>();
const MEASURED_MAX = 32;

/**
 * What a web-sized copy of a library image (its original's bytes) would be, found by making it and weighing it as it
 * would be stored. A copy that could not be made this time is not remembered, so it is tried again next time.
 */
export async function libraryWebCopyPlan(record: AssetRecord, buf: Buffer, read?: { hash: string; credits: PhotoCredits | undefined }): Promise<WebCopyPlan> {
  if (record.kind !== 'image' || (record.mime !== 'image/jpeg' && record.mime !== 'image/png')) return null;
  if (record.mime === 'image/png' && isAnimatedPng(buf)) return null;
  const info = imageInfo(buf, record.mime);
  if (!info || imageProblem(buf, record.mime) || info.width * info.height > MAX_VARIANT_PIXELS) return null;
  // `read` is what the caller already found in these very bytes: their SHA-256 and credits.
  const key = `${read?.hash ?? sha(buf)}:${record.mime}`;
  const known = measured.get(key);
  if (known) return known.plan;
  const entry = { plan: measureWebCopy(record, buf, read).catch(() => null), done: false };
  measured.set(key, entry);
  trimMeasured();
  void entry.plan.then((p) => {
    entry.done = true;
    if (p === null && measured.get(key) === entry) measured.delete(key);
    trimMeasured();
  });
  return entry.plan;
}

/**
 * The plan measured (or being measured) for a library image whose bytes hash to `hash`, without its bytes; undefined
 * when there is none. Only bytes that passed libraryWebCopyPlan's checks under the record's type have one, so it is
 * the answer libraryWebCopyPlan gives for them.
 */
export function measuredWebCopyPlan(record: AssetRecord, hash: string): Promise<WebCopyPlan> | undefined {
  if (record.kind !== 'image' || (record.mime !== 'image/jpeg' && record.mime !== 'image/png')) return undefined;
  return measured.get(`${hash}:${record.mime}`)?.plan;
}

/** Lets go of the oldest answers already in until the map is back to its size. */
function trimMeasured() {
  for (const [k, e] of measured) {
    if (measured.size <= MEASURED_MAX) return;
    if (e.done) measured.delete(k);
  }
}

async function measureWebCopy(record: AssetRecord, buf: Buffer, read?: { credits: PhotoCredits | undefined }): Promise<WebCopyPlan> {
  const result = await mediaWorker.webCopy({ data: buf, mime: record.mime }, WEB_EDGE, record.width && record.height ? record.width * record.height : undefined);
  if (!result.ok) return null;
  return weighCopy(record, buf.length, result.copy, read ? read.credits : cleanPhoto(buf)?.credits);
}

/** What a web-sized copy made of a library image's bytes (`sourceBytes` long, carrying `credits`) would be, as stored. */
function weighCopy(record: AssetRecord, sourceBytes: number, copy: { data: Buffer; mime: 'image/jpeg' | 'image/png'; width: number; height: number }, credits: PhotoCredits | undefined): WebCopyPlan {
  const p = preparedCopy(record.file, credits, copy);
  // Checked in the order making the copy checks them, so the two always agree.
  if (!worthwhile(p.buf, sourceBytes)) return { lighter: false };
  return p.buf.length > MAX_BYTES ? null : { format: p.mime === 'image/png' ? 'PNG' : 'JPEG', width: copy.width, height: copy.height };
}

/**
 * A large library photo read and looked at in the media worker, so the editor's main process never holds it (#1046):
 * what its bytes are and say, the stat of the file they were read from, and with `plan` what a web-sized copy of it
 * would be, exactly as libraryWebCopyPlan answers for those bytes (null when they are not the picture the record names).
 * A copy already weighed for the same bytes is not made again. Null when the file could not be read or the worker failed.
 * `early` is told what the bytes say as soon as the worker has read them, before their copy is made.
 */
export async function inspectLibraryImage(
  path: string,
  record: AssetRecord,
  plan: boolean,
  early?: (facts: { hash: string; metadata: PhotoMetadata | null; credits: PhotoCredits | undefined }, stamp: string) => void
): Promise<{ facts: { hash: string; metadata: PhotoMetadata | null; credits: PhotoCredits | undefined }; stamp: string; plan: WebCopyPlan } | null> {
  const weighs = plan && record.kind === 'image' && (record.mime === 'image/jpeg' || record.mime === 'image/png');
  const pixels = record.width && record.height ? record.width * record.height : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // The bytes whose copies have been weighed under this type: the worker makes no copy of those.
    const known = weighs && attempt === 0 ? [...measured.keys()].filter((k) => k.endsWith(`:${record.mime}`)).map((k) => k.slice(0, k.indexOf(':'))) : [];
    const r = await mediaWorker.library(path, record.mime, { expect: record.hash, plan: weighs, known }, WEB_EDGE, pixels, early && ((f) => early({ hash: f.hash, metadata: f.metadata, credits: f.credits }, f.stamp)));
    if (!r) return null;
    const facts = { hash: r.found.hash, metadata: r.found.metadata, credits: r.found.credits };
    const answer = (p: WebCopyPlan) => ({ facts, stamp: r.found.stamp, plan: p });
    if (!weighs || r.found.hash !== record.hash || !r.found.checked) return answer(null);
    const key = `${r.found.hash}:${record.mime}`;
    const was = measured.get(key);
    if (was) {
      // What the bytes say is not held up by a copy of them still being weighed for another look.
      early?.(facts, r.found.stamp);
      return answer(await was.plan);
    }
    if (r.copy) {
      const p = weighCopy(record, r.found.bytes, r.copy, r.found.credits);
      // As libraryWebCopyPlan keeps them: a copy that could not be made this time is not remembered.
      if (p !== null) {
        measured.set(key, { plan: Promise.resolve(p), done: true });
        trimMeasured();
      }
      return answer(p);
    }
    // No copy: it could not be made, or one weighed meanwhile has been let go since (asked again, without it).
    if (!known.includes(r.found.hash)) return answer(null);
  }
  return null;
}

/**
 * Make a web-sized copy of a library image from its original's bytes and store it in the project, with its
 * responsive copies, as an import of it would be. A copy that would hardly be lighter (see LIGHTER_SHARE) is not
 * made (`lighter: false`).
 * The record returned is new (named after the image, with its description and suggested alt text) or the library
 * image that already has those bytes (`existing`).
 */
export async function storeLibraryWebCopy(
  projectDir: string,
  record: AssetRecord,
  buf: Buffer,
  existing: AssetRecord[],
  fence: WriteFence = unfenced
): Promise<{ record: AssetRecord; existing: boolean } | { lighter: false }> {
  const name = record.name.trim() || 'Image';
  const refuse = refusal(`${name}.${record.file.split('.').pop()}`, "couldn't be copied");
  if (sha(buf) !== record.hash) throw refuse('its file is not the picture the library recorded. Locate the original first.');
  const result = await mediaWorker.webCopy({ data: buf, mime: record.mime }, WEB_EDGE, record.width && record.height ? record.width * record.height : undefined);
  if (!result.ok) throw refuse(result.unreadable ? unusableReason('damaged', record.mime) : 'the web-sized copy could not be made. Try again.');
  const p = { ...preparedCopy(`${name} web`, cleanPhoto(buf)?.credits, result.copy), stem: `${name} web` };
  if (!worthwhile(p.buf, buf.length)) return { lighter: false };
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
const spawnMediaWorker = () => utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), 'media-worker.js'), [], { serviceName: 'SiteOrigin media', env: workerEnv() });
/**
 * How many pictures the media worker makes at once: about one for every four cores (each keeps two or three of them
 * busy, AVIF encoding being threaded), at most four. An import goes through its files as many at a time.
 */
export const MEDIA_PARALLEL = Math.min(4, Math.max(1, Math.round(availableParallelism() / 4)));
/**
 * The pixels the pictures in flight may add up to: 16 megapixels for each. A larger picture waits for the others and is
 * made with the worker to itself, so a batch of very large ones holds no more in memory than one does.
 */
const MEDIA_PIXEL_BUDGET = MEDIA_PARALLEL * 16_000_000;

/**
 * With marks on, each request the worker answers is marked with what it cost there (scripts/perf/README.md, the `import`
 * scenario): its time, CPU, the worker's peak memory, and its decodes and encodes.
 */
const mediaWorker = createVariantClient(spawnMediaWorker, {
  parallel: MEDIA_PARALLEL,
  pixelBudget: MEDIA_PIXEL_BUDGET,
  ...(perf.on
    ? {
        onStats: (kind, s, ms) =>
          perf.mark('media.request', {
            kind,
            ms,
            workMs: s.ms,
            cpuMs: s.cpuMs,
            cpuStart: s.cpuStartMs,
            cpuEnd: s.cpuEndMs,
            peakRss: s.peakRss,
            worker: s.pid,
            decodes: s.decodes,
            encodes: s.encodes,
            decodeMs: s.decodeMs,
            webCopyMs: s.webCopyMs,
            jpegMs: s.formatMs['image/jpeg'] ?? 0,
            pngMs: s.formatMs['image/png'] ?? 0,
            webpMs: s.formatMs['image/webp'] ?? 0,
            avifMs: s.formatMs['image/avif'] ?? 0,
            readBytes: s.readBytes
          })
      }
    : {})
});
/**
 * The website's icons (see site-icons.ts) are drawn by a worker of their own: a save that needs new ones never waits
 * behind the photos of an import in progress. It starts when icons are first needed and stops once idle.
 */
const iconWorker = createVariantClient(spawnMediaWorker);

/** Draws the website's icons in the media worker: the renderer the app registers with setSiteIconRenderer. */
export const renderSiteIconsInWorker: SiteIconRenderer = (data, mime, icons, opts) => iconWorker.icons(data, mime, icons, opts);

/**
 * End the media workers once they have nothing left to do (a project closed), so none waits out its idle time at
 * Welcome. Work already asked for still finishes (a project being created beside the one closing makes its pictures
 * here), and the next request starts a worker again.
 */
export const releaseMediaWorkers = () => {
  mediaWorker.release();
  iconWorker.release();
};

/** Stop the media workers (when the app quits). */
export const stopMediaWorker = () => {
  mediaWorker.stop();
  iconWorker.stop();
};
