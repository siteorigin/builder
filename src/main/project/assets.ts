import { promises as fs } from 'node:fs';
import { nativeImage } from 'electron';
import { basename, extname, join } from 'node:path';
import type { AssetRecord } from '@shared/types';
import { newId } from '@shared/ids';
import { slugify } from '@shared/routes';
import { atomicWrite, sha } from './fsutil';
import { sanitizeSvg } from './svg';

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

/** Read pixel dimensions from common raster headers without decoding the image. */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.readUInt32BE(12) === 0x49484452) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === 'image/svg+xml') {
      const t = buf.toString('utf8', 0, 2000);
      const vb = t.match(/viewBox=["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
      if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
    }
  } catch {
    return null;
  }
  return null;
}

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

export async function importAsset(projectDir: string, sourcePath: string, existing: AssetRecord[]): Promise<{ record: AssetRecord; existing: boolean }> {
  const ext = extname(sourcePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`${basename(sourcePath)}: only JPEG, PNG, WebP, GIF, AVIF and SVG images can be imported.`);
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
  const hash = sha(buf);
  const dup = existing.find((a) => a.hash === hash);
  if (dup) return { record: dup, existing: true };
  const base = slugify(basename(sourcePath, ext)) || 'image';
  const file = `static/assets/${base}-${hash.slice(0, 8)}${ext === '.jpeg' ? '.jpg' : ext}`;
  await atomicWrite(join(projectDir, file), buf);
  const size = imageSize(buf, mime);
  const variants = size ? await makeVariants(projectDir, buf, mime, size.width, `static/assets/${base}-${hash.slice(0, 8)}`) : [];
  const record: AssetRecord = {
    id: newId('a'),
    name: basename(sourcePath, ext).replace(/[-_]+/g, ' ').trim() || 'Image',
    file,
    mime,
    bytes: buf.length,
    hash,
    kind: mime.startsWith('font/') ? 'font' : 'image',
    createdAt: new Date().toISOString(),
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(variants.length ? { variants } : {})
  };
  return { record, existing: false };
}

const VARIANT_WIDTHS = [480, 960, 1440];

/** Deterministic smaller copies for responsive images (JPEG and PNG); originals are preserved. */
async function makeVariants(projectDir: string, buf: Buffer, mime: string, width: number, stem: string): Promise<Array<{ width: number; file: string }>> {
  if (mime !== 'image/jpeg' && mime !== 'image/png') return [];
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return [];
  const out: Array<{ width: number; file: string }> = [];
  for (const w of VARIANT_WIDTHS) {
    if (w >= width * 0.9) continue;
    const resized = img.resize({ width: w, quality: 'best' });
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const file = `${stem}-${w}w.${ext}`;
    await atomicWrite(join(projectDir, file), ext === 'png' ? resized.toPNG() : resized.toJPEG(82));
    out.push({ width: w, file });
  }
  return out;
}
