/**
 * Responsive copies of an imported picture. Runs in the media worker (a utility process), never on the
 * editor's main process: decoding and resizing a large photo takes long enough to freeze the window.
 */
import sharp from 'sharp';
import { MAX_VARIANT_PIXELS, type VariantReply, type VariantRequest } from './media-client';
import { isAnimatedPng } from './media';

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
 * way the picture's EXIF orientation says and written without metadata. An animated PNG gets none: a resized
 * copy would be a single frame, and its srcset would mix the moving original with stills. `widths` asks for
 * exactly those copies (making again the ones a library image already lists), each never wider than the picture.
 */
export async function renderVariants(buf: Buffer, mime: string, width: number, widths?: number[]): Promise<Variant[]> {
  if (mime !== 'image/jpeg' && mime !== 'image/png') return [];
  if (mime === 'image/png' && isAnimatedPng(buf)) return [];
  // The decoder's own reading of the displayed width wins over the header's: a copy is never labelled wider
  // than the picture it was made from.
  const meta = await sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS }).metadata();
  const displayed = Math.min(width, meta.autoOrient?.width ?? meta.width ?? width);
  const out: Variant[] = [];
  for (const w of widths ?? VARIANT_WIDTHS) {
    if (widths ? !(w > 0 && w <= displayed) : w >= displayed * 0.9) continue;
    // Never enlarged: a picture smaller than its header claimed keeps the size it has.
    const img = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS }).autoOrient().resize({ width: w, withoutEnlargement: true });
    out.push({ width: w, data: await (mime === 'image/png' ? img.png() : img.jpeg({ quality: 82 })).toBuffer() });
  }
  return out;
}

/**
 * Whether the decoder can read the picture's image data, not just its header: a file whose structure is whole can
 * still hold pixel data no browser can decode. Decoded small, so a large photo costs little.
 */
export async function isReadable(buf: Buffer, mime?: string): Promise<boolean> {
  const decode = (pages?: number) => sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error', ...(pages ? { pages } : {}) }).resize(16, 16, { fit: 'inside' }).raw().toBuffer();
  // Too many pixels to decode here says nothing about the file. Nor does an AVIF image sequence, which browsers show
  // and this decoder does not know; any other file it does not know is not the picture its structure claimed.
  const unknown = (e: unknown) => /pixel limit/i.test((e as Error).message) || (/unsupported image format/i.test((e as Error).message) && mime === 'image/avif' && avifBrands(buf).includes('avis'));
  // Every frame of an animation, so a damaged later frame is found too. Frames that are too many pixels together
  // are checked by the first alone.
  if (mime === 'image/gif' || mime === 'image/webp') {
    try {
      await decode(-1);
      return true;
    } catch (e) {
      if (!/pixel limit/i.test((e as Error).message)) return unknown(e);
    }
  }
  try {
    await decode();
    return true;
  } catch (e) {
    return unknown(e);
  }
}

/** The brands an AVIF's file-type box declares: its major brand and the compatible ones. */
function avifBrands(buf: Buffer): string[] {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return [];
  const end = Math.min(buf.readUInt32BE(0), buf.length);
  const brands = [buf.toString('latin1', 8, 12)];
  for (let p = 16; p + 4 <= end; p += 4) brands.push(buf.toString('latin1', p, p + 4));
  return brands;
}

/** What the media worker does with one request; the worker process only carries messages to and from it. */
export async function handleVariantRequest(m: VariantRequest): Promise<VariantReply> {
  try {
    const buf = Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength);
    if (m.check && !(await isReadable(buf, m.mime))) return { id: m.id, ok: false, error: 'The picture could not be decoded.', unreadable: true };
    const variants = await renderVariants(buf, m.mime, m.width, m.widths);
    return { id: m.id, ok: true, variants: variants.map((v) => ({ width: v.width, data: new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength) })) };
  } catch (e) {
    return { id: m.id, ok: false, error: (e as Error).message };
  }
}
