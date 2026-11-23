import { promises as fs } from 'node:fs';
import { utilityProcess } from 'electron';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetRecord } from '@shared/types';
import { newId } from '@shared/ids';
import { slugify } from '@shared/routes';
import { atomicWrite, sha } from './fsutil';
import { sanitizeSvg } from './svg';
import { fontInfo, imageInfo } from './media';
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

/** Is this a file of the given kind, going by its extension? */
export function isAssetOfKind(path: string, kind: 'image' | 'font'): boolean {
  const mime = MIME[extname(path).toLowerCase()];
  return !!mime && mime.startsWith('font/') === (kind === 'font');
}

export async function importAsset(projectDir: string, sourcePath: string, existing: AssetRecord[]): Promise<{ record: AssetRecord; existing: boolean; font?: AssetRecord['font'] }> {
  const ext = extname(sourcePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`${basename(sourcePath)}: only JPEG, PNG, WebP, GIF, AVIF and SVG images, and WOFF2 or WOFF fonts, can be imported.`);
  const stat = await fs.stat(sourcePath);
  if (stat.size > MAX_BYTES) throw new Error(`${basename(sourcePath)} is larger than 25 MB.`);
  let buf = await fs.readFile(sourcePath);
  if (mime === 'image/svg+xml') {
    // Save a rebuilt, allowlisted SVG rather than the original bytes.
    try {
      buf = Buffer.from(sanitizeSvg(buf), 'utf8');
    } catch (e) {
      throw new Error(`${basename(sourcePath)} was not imported because ${(e as Error).message}. Export a plain SVG or use a PNG instead.`);
    }
  }
  const isFont = mime.startsWith('font/');
  // A font is only useful with its family, weight and style, so a file that does not declare them is refused.
  let font: AssetRecord['font'];
  if (isFont) {
    try {
      font = await fontInfo(buf);
    } catch (e) {
      throw new Error(`${basename(sourcePath)} was not imported because ${(e as Error).message}. Use a WOFF2 or WOFF web font.`);
    }
  }
  const hash = sha(buf);
  const dup = existing.find((a) => a.hash === hash);
  // A font imported before metadata was recorded gets it now.
  if (dup) return { record: dup, existing: true, ...(font && !dup.font ? { font } : {}) };
  const base = slugify(basename(sourcePath, ext)) || (isFont ? 'font' : 'image');
  const file = `static/assets/${base}-${hash.slice(0, 8)}${ext === '.jpeg' ? '.jpg' : ext}`;
  await atomicWrite(join(projectDir, file), buf);
  const info = isFont ? null : imageInfo(buf, mime);
  // Decoding allocates by pixel count, which a small file can inflate: very large pictures keep only the original.
  const decodable = !!info && info.width * info.height <= MAX_VARIANT_PIXELS;
  const variants = decodable ? await makeVariants(projectDir, buf, mime, info.width, `static/assets/${base}-${hash.slice(0, 8)}`) : [];
  const record: AssetRecord = {
    id: newId('a'),
    name: isFont ? fontName(font!) : basename(sourcePath, ext).replace(/[-_]+/g, ' ').trim() || 'Image',
    file,
    mime,
    bytes: buf.length,
    hash,
    kind: isFont ? 'font' : 'image',
    createdAt: new Date().toISOString(),
    ...(info ? { width: info.width, height: info.height } : {}),
    ...(variants.length ? { variants } : {}),
    ...(font ? { font } : {})
  };
  return { record, existing: false };
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

/**
 * Deterministic smaller copies for responsive images (JPEG and PNG); originals are preserved. `width` is the
 * displayed width; a JPEG's EXIF orientation is applied to the copies, which are written without EXIF. A
 * picture the worker cannot resize keeps only its original.
 */
async function makeVariants(projectDir: string, buf: Buffer, mime: string, width: number, stem: string): Promise<Array<{ width: number; file: string }>> {
  if (mime !== 'image/jpeg' && mime !== 'image/png') return [];
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const out: Array<{ width: number; file: string }> = [];
  for (const v of await mediaWorker.variants(buf, mime, width)) {
    const file = `${stem}-${v.width}w.${ext}`;
    await atomicWrite(join(projectDir, file), v.data);
    out.push({ width: v.width, file });
  }
  return out;
}
