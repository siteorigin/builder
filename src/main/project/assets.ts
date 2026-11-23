import { promises as fs } from 'node:fs';
import { utilityProcess } from 'electron';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetRecord } from '@shared/types';
import { newId } from '@shared/ids';
import { slugify } from '@shared/routes';
import { atomicWrite, safeJoin, sha } from './fsutil';
import { sanitizeSvg } from './svg';
import { fontInfo, imageInfo, imageProblem, type ImageProblem } from './media';
import { createVariantClient, MAX_VARIANT_PIXELS } from './media-client';

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
/** File extensions the importer accepts (for file pickers). */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg'];
export const FONT_EXTENSIONS = ['woff2', 'woff'];

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

/** Is this a file of the given kind, going by its extension? */
export function isAssetOfKind(path: string, kind: 'image' | 'font'): boolean {
  const mime = MIME[extname(path).toLowerCase()];
  return !!mime && mime.startsWith('font/') === (kind === 'font');
}

/** A file checked for the library: what it is, and the bytes the project keeps (a rebuilt SVG, say). */
interface PreparedFile {
  source: string;
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
  if (!mime) throw new Error(`${basename(sourcePath)}: only JPEG, PNG, WebP, GIF, AVIF and SVG images, and WOFF2 or WOFF fonts, can be imported.`);
  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 25 MB.`);
  let buf = await fs.readFile(sourcePath);
  // A picture no browser can show never becomes a library image an author could choose.
  const problem = mime.startsWith('image/') ? imageProblem(buf, mime) : buf.length ? null : 'empty';
  if (problem) throw refuse(unusableReason(problem, mime));
  if (mime === 'image/svg+xml') {
    // Save a rebuilt, allowlisted SVG rather than the original bytes.
    try {
      buf = Buffer.from(sanitizeSvg(buf), 'utf8');
    } catch (e) {
      throw refuse(`${(e as Error).message}. Export a plain SVG or use a PNG instead.`);
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
  return { source: sourcePath, ext, mime, buf, hash: sha(buf), ...(font ? { font } : {}) };
}

/** Where a library file lives and what it is: the part of an asset record a new file replaces. */
export type StoredFile = Pick<AssetRecord, 'file' | 'mime' | 'bytes' | 'hash' | 'width' | 'height' | 'variants'>;

/**
 * Write a checked file into static/assets/ under the importer's name, with a picture's responsive copies. A picture
 * the decoder cannot read is refused before anything is written.
 */
async function storeFile(projectDir: string, p: PreparedFile, refuse: Refusal): Promise<StoredFile> {
  const isFont = p.mime.startsWith('font/');
  const info = isFont ? null : imageInfo(p.buf, p.mime);
  // Decoding allocates by pixel count, which a small file can inflate: very large pictures are not decoded at all
  // and keep only the original.
  const decodable = !!info && p.mime !== 'image/svg+xml' && info.width * info.height <= MAX_VARIANT_PIXELS;
  const { unreadable, variants } = decodable ? await mediaWorker.inspect(p.buf, p.mime, info.width) : { unreadable: false, variants: [] };
  if (unreadable) throw refuse(unusableReason('damaged', p.mime));
  const base = slugify(basename(p.source, p.ext)) || (isFont ? 'font' : 'image');
  const stem = `static/assets/${base}-${p.hash.slice(0, 8)}`;
  const file = `${stem}${p.ext === '.jpeg' ? '.jpg' : p.ext}`;
  await atomicWrite(join(projectDir, file), p.buf);
  const copies: Array<{ width: number; file: string }> = [];
  for (const v of variants) {
    const copy = `${stem}-${v.width}w.${p.mime === 'image/png' ? 'png' : 'jpg'}`;
    await atomicWrite(join(projectDir, copy), v.data);
    copies.push({ width: v.width, file: copy });
  }
  return { file, mime: p.mime, bytes: p.buf.length, hash: p.hash, ...(info ? { width: info.width, height: info.height } : {}), ...(copies.length ? { variants: copies } : {}) };
}

export async function importAsset(projectDir: string, sourcePath: string, existing: AssetRecord[]): Promise<{ record: AssetRecord; existing: boolean; font?: AssetRecord['font'] }> {
  const refuse = refusal(sourcePath, 'was not imported');
  const p = await prepareFile(sourcePath, refuse);
  const dup = existing.find((a) => a.hash === p.hash);
  // A font imported before metadata was recorded gets it now.
  if (dup) return { record: dup, existing: true, ...(p.font && !dup.font ? { font: p.font } : {}) };
  const isFont = p.mime.startsWith('font/');
  const stored = await storeFile(projectDir, p, refuse);
  const record: AssetRecord = {
    id: newId('a'),
    name: isFont ? fontName(p.font!) : basename(sourcePath, p.ext).replace(/[-_]+/g, ' ').trim() || 'Image',
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
  return { record, existing: false };
}

/** A file the importer named, inside static/assets/: the only kind a library image may be restored to. */
const LIBRARY_FILE = /^static\/assets\/[a-z0-9][a-z0-9-]*\.(jpg|png|webp|gif|avif|svg)$/;
const isFile = (path: string) => fs.lstat(path).then((s) => s.isFile(), () => false);

/**
 * Put back what a library image is missing in the project folder: its original, from `original` when that is
 * the same picture, and the smaller copies it lists, made again from the original at their recorded widths and
 * names. Files already there are left alone. Returns the files written and the copies that could not be made.
 */
export async function restoreAssetFiles(projectDir: string, record: AssetRecord, original?: Buffer): Promise<{ written: string[]; failed: string[] }> {
  const name = record.name.trim() || 'This image';
  if (!LIBRARY_FILE.test(record.file)) throw new Error(`${name} has a file name SiteOrigin Builder did not give it, so it cannot be restored. Choose another image instead.`);
  const at = safeJoin(projectDir, record.file);
  const written: string[] = [];
  const failed: string[] = [];
  let buf = original;
  if (buf && !(await isFile(at))) {
    await atomicWrite(at, buf);
    written.push(record.file);
  } else {
    buf = await fs.readFile(at).catch(() => undefined);
    if (!buf) throw new Error(`The original file of ${name} is missing. Locate it first.`);
  }
  // Copies of a different picture would show the wrong image at smaller sizes.
  if (sha(buf) !== record.hash) throw new Error(`The original file of ${name} is not the picture the library recorded, so its copies were not made again. Locate the original, or choose another image.`);
  const missing: Array<{ width: number; file: string }> = [];
  for (const v of record.variants ?? []) {
    if (!LIBRARY_FILE.test(v.file)) failed.push(v.file);
    else if (!(await isFile(safeJoin(projectDir, v.file)))) missing.push(v);
  }
  if (!missing.length) return { written, failed };
  const info = imageInfo(buf, record.mime);
  const made = info && info.width * info.height <= MAX_VARIANT_PIXELS ? await mediaWorker.variants(buf, record.mime, info.width, missing.map((v) => v.width)) : [];
  for (const v of missing) {
    const copy = made.find((c) => c.width === v.width);
    if (!copy) {
      failed.push(v.file);
      continue;
    }
    await atomicWrite(safeJoin(projectDir, v.file), copy.data);
    written.push(v.file);
  }
  return { written, failed };
}

/**
 * The file an author located for a library image whose original is missing. The same picture goes back where the
 * library expects it, with its copies, and nothing else changes. A different picture is stored as an import would
 * store it, and what the image record should now say is returned for asset.relink.
 */
export async function locateAssetFile(projectDir: string, record: AssetRecord, sourcePath: string): Promise<{ same: true; written: string[]; failed: string[] } | { same: false; stored: StoredFile }> {
  const refuse = refusal(sourcePath, "can't be used");
  if (!isAssetOfKind(sourcePath, 'image')) throw refuse('it is not an image. Choose a JPEG, PNG, WebP, GIF, AVIF or SVG file.');
  const p = await prepareFile(sourcePath, refuse);
  if (p.hash === record.hash) return { same: true, ...(await restoreAssetFiles(projectDir, record, p.buf)) };
  return { same: false, stored: await storeFile(projectDir, p, refuse) };
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
