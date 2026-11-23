/**
 * Responsive copies of an imported picture. Runs in the media worker (a utility process), never on the
 * editor's main process: decoding and resizing a large photo takes long enough to freeze the window.
 */
import sharp from 'sharp';
import { MAX_VARIANT_PIXELS } from './media-client';

/** Widths of the smaller copies, each made only when it is meaningfully smaller than the picture. */
export const VARIANT_WIDTHS = [480, 960, 1440];

export interface Variant {
  width: number;
  data: Buffer;
}

// One picture at a time goes through the worker, so libvips' operation cache would only hold memory.
sharp.cache(false);

/**
 * Deterministic smaller copies of a JPEG or PNG. `width` is the displayed width; the copies are turned the
 * way the picture's EXIF orientation says and written without metadata.
 */
export async function renderVariants(buf: Buffer, mime: string, width: number): Promise<Variant[]> {
  if (mime !== 'image/jpeg' && mime !== 'image/png') return [];
  const out: Variant[] = [];
  for (const w of VARIANT_WIDTHS) {
    if (w >= width * 0.9) continue;
    // Never enlarged: a picture smaller than its header claimed keeps the size it has.
    const img = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS }).autoOrient().resize({ width: w, withoutEnlargement: true });
    out.push({ width: w, data: await (mime === 'image/png' ? img.png() : img.jpeg({ quality: 82 })).toBuffer() });
  }
  return out;
}
