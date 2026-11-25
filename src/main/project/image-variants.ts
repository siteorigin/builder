/**
 * Responsive copies of an imported picture. Runs in the media worker (a utility process), never on the
 * editor's main process: decoding and resizing a large photo takes long enough to freeze the window.
 */
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { MAX_VARIANT_PIXELS, WEB_EDGE, webCopySize, type IconSpec, type VariantReply, type VariantRequest } from './media-client';
import { isAnimatedPng } from './media';
import { sanitizeSvg } from './svg';

/**
 * Widths of the smaller copies, each made only when it is meaningfully smaller than the picture. The 160px copy
 * serves small placements (a logo, an avatar) at twice their size on high-density screens.
 */
export const VARIANT_WIDTHS = [160, 480, 960, 1440];

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

export { WEB_EDGE };

export interface WebCopy {
  data: Buffer;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

/**
 * A copy of a photo a browser can show and a page can carry: turned the way its orientation says, no larger than
 * WEB_EDGE on its longest side (never enlarged), in sRGB and without metadata. A picture with see-through pixels
 * stays a PNG; any other becomes a JPEG at the quality of the responsive copies. Deterministic.
 */
export async function renderWebCopy(buf: Buffer, maxEdge = WEB_EDGE): Promise<WebCopy> {
  const open = () => sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error' });
  // An alpha channel that is fully opaque everywhere (screenshots, many exported photos) is no reason to stay a PNG.
  const clear = !(await isOpaque(buf));
  const meta = await open().metadata();
  const shown = { width: meta.autoOrient?.width ?? meta.width ?? 0, height: meta.autoOrient?.height ?? meta.height ?? 0 };
  // Exactly the size webCopySize gives (as an import review shows it), never enlarged.
  const size = webCopySize(shown.width, shown.height, maxEdge);
  const img = open().autoOrient();
  if (size.width !== shown.width || size.height !== shown.height) img.resize({ width: size.width, height: size.height, fit: 'fill' });
  const { data, info } = await (clear ? img.png() : img.flatten({ background: '#ffffff' }).jpeg({ quality: 82 })).toBuffer({ resolveWithObject: true });
  return { data, mime: clear ? 'image/png' : 'image/jpeg', width: info.width, height: info.height };
}

/**
 * Whether the decoder can read the picture's image data, not just its header: a file whose structure is whole can
 * still hold pixel data no browser can decode. Decoded small, so a large photo costs little.
 */
export async function isReadable(buf: Buffer, mime?: string): Promise<boolean> {
  const decode = (pages?: number) => sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error', ...(pages ? { pages } : {}) }).resize(16, 16, { fit: 'inside' }).raw().toBuffer();
  // Too many pixels to decode here says nothing about the file. Nor does an AVIF the decoder does not recognise (an
  // image sequence, an unusual major brand); a file declaring no AVIF brand is not the picture it claimed to be.
  const unknown = (e: unknown) => /pixel limit/i.test((e as Error).message) || (/unsupported image format/i.test((e as Error).message) && mime === 'image/avif' && avifBrands(buf).some((b) => b === 'avif' || b === 'avis'));
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

/** Whether every pixel is opaque: a picture without an alpha channel always is. */
export async function isOpaque(buf: Buffer): Promise<boolean> {
  const img = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error' });
  if (!(await img.metadata()).hasAlpha) return true;
  return (await img.stats()).isOpaque;
}

/**
 * The website's square PNG icons from a picture (the favicon, or the monogram's SVG), one for each of `icons`: turned
 * the way its orientation says, its first frame if it moves, fitted whole inside the square (enlarged when it is
 * smaller) and centred. An icon with a background has every see-through pixel filled with it, as the one iOS shows
 * must be; the others keep their transparency. An SVG is drawn at the size of the largest icon, never enlarged from a
 * small raster. Written as sRGB without metadata; the same picture always makes the same bytes here. An `untrusted`
 * SVG (a file of the project's, maybe replaced outside the app since it was imported) is cleaned first, as an import
 * cleans one: here, in the worker, so a file that takes long to clean never holds up the editor.
 */
export async function renderSiteIcons(buf: Buffer, mime: string, icons: IconSpec[], opts: { untrusted?: boolean } = {}): Promise<Buffer[]> {
  if (opts.untrusted && mime === 'image/svg+xml') buf = Buffer.from(sanitizeSvg(buf));
  let density: number | undefined;
  if (mime === 'image/svg+xml') {
    const meta = await sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error' }).metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
    const largest = Math.max(...icons.map((i) => i.size));
    // 72 dpi draws the SVG at its own size; librsvg takes no more than this.
    if (edge > 0) density = Math.min(2400, Math.max(72, Math.ceil((72 * largest) / edge)));
  }
  const out: Buffer[] = [];
  for (const icon of icons) {
    const clear = { r: 0, g: 0, b: 0, alpha: 0 };
    let img = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error', pages: 1, page: 0, ...(density ? { density } : {}) })
      .autoOrient()
      .resize(icon.size, icon.size, { fit: 'contain', position: 'centre', background: icon.background ?? clear });
    if (icon.background) img = img.flatten({ background: icon.background });
    out.push(await img.toColourspace('srgb').png().toBuffer());
  }
  return out;
}

/** What the media worker does with one request; the worker process only carries messages to and from it. */
export async function handleVariantRequest(m: VariantRequest): Promise<VariantReply> {
  try {
    const buf = m.path ? await readFile(m.path) : Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength);
    if (m.kind === 'opaque') return { id: m.id, ok: true, variants: [], opaque: await isOpaque(buf) };
    if (m.kind === 'icons') {
      // Whatever stops the drawing here (a picture the decoder refuses, or too many pixels to decode) is the picture's
      // doing, and would be the same every time: the icons are then made from the monogram instead.
      const unreadable = (e?: unknown) => ({ id: m.id, ok: false as const, error: e ? (e as Error).message : 'The picture could not be decoded.', unreadable: true });
      // An SVG is cleaned before anything decodes it, so it is checked as it is drawn.
      if (!(m.untrusted && m.mime === 'image/svg+xml') && !(await isReadable(buf, m.mime))) return unreadable();
      const icons = await renderSiteIcons(buf, m.mime, m.icons ?? [], { untrusted: m.untrusted }).catch((e: unknown) => e as Error);
      if (icons instanceof Error) return unreadable(icons);
      return { id: m.id, ok: true, variants: [], icons: icons.map((d) => new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) };
    }
    if (m.kind === 'web') {
      // A picture the decoder refuses is said to be unreadable; anything failing after that is the copy failing.
      if (!(await isReadable(buf, m.path ? 'image/tiff' : m.mime))) return { id: m.id, ok: false, error: 'The picture could not be decoded.', unreadable: true };
      const web = await renderWebCopy(buf, m.maxEdge);
      return { id: m.id, ok: true, variants: [], web: { ...web, data: new Uint8Array(web.data.buffer, web.data.byteOffset, web.data.byteLength) } };
    }
    if (m.check && !(await isReadable(buf, m.mime))) return { id: m.id, ok: false, error: 'The picture could not be decoded.', unreadable: true };
    const variants = await renderVariants(buf, m.mime, m.width, m.widths);
    return { id: m.id, ok: true, variants: variants.map((v) => ({ width: v.width, data: new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength) })) };
  } catch (e) {
    return { id: m.id, ok: false, error: (e as Error).message };
  }
}
