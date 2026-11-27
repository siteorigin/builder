/**
 * Responsive copies of an imported picture. Runs in the media worker (a utility process), never on the
 * editor's main process: decoding and resizing a large photo takes long enough to freeze the window.
 */
import { readFile } from 'node:fs/promises';
import sharp, { type Sharp } from 'sharp';
import { MAX_VARIANT_PIXELS, WEB_EDGE, webCopySize, type IconSpec, type MediaStats, type VariantReply, type VariantRequest } from './media-client';
import { isAnimatedPng } from './media';
import { cleanPhoto, creditText, type CreditText } from './photo-metadata';
import { sanitizeSvg } from './svg';
import { isCopyMime, type CopyMime } from '@shared/picture-formats';

/**
 * Widths of the smaller copies, each made only when it is meaningfully smaller than the picture. The 160px copy
 * serves small placements (a logo, an avatar) at twice their size on high-density screens.
 */
export const VARIANT_WIDTHS = [160, 480, 960, 1440];

/** One copy to make: its width and format. */
export interface VariantTarget {
  width: number;
  mime: CopyMime;
}

export interface Variant extends VariantTarget {
  data: Buffer;
}

// One picture at a time goes through the worker, so libvips' operation cache would only hold memory.
sharp.cache(false);

/** What a request's pictures cost, counted as they are made (for MediaStats). */
export type Tally = Pick<MediaStats, 'decodes' | 'encodes' | 'decodeMs' | 'webCopyMs' | 'formatMs' | 'readBytes'>;
export const newTally = (): Tally => ({ decodes: 0, encodes: 0, decodeMs: 0, webCopyMs: 0, formatMs: {}, readBytes: 0 });

/** `work`, timed into `tally` (when there is one) by `into`, as one decode of an encoded picture. */
async function tallied<T>(tally: Tally | undefined, into: (t: Tally, ms: number) => void, work: () => Promise<T>): Promise<T> {
  if (!tally) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    tally.decodes++;
    into(tally, performance.now() - start);
  }
}
const asDecode = (t: Tally, ms: number) => void (t.decodeMs += ms);

/**
 * AVIF copies are made one at a time, whichever requests they belong to: the encoder is threaded already, so several
 * at once are hardly faster, and each holds about 150 MB for a 2560-pixel copy. The worker's other encodes go on beside it.
 */
let avifTurn: Promise<unknown> = Promise.resolve();
function inAvifTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = avifTurn.then(work, work);
  avifTurn = mine.catch(() => undefined);
  return mine;
}

/**
 * How each format is written: JPEG and PNG as they always were, WebP and AVIF at qualities that look like the JPEG
 * copies. AVIF's effort trades import time for size: on the starter photos, effort 2 makes copies about half the size
 * of the WebP ones in a fifth of the time effort 4 takes, which saves only 5% more.
 */
const ENCODE: Record<CopyMime, (img: Sharp) => Sharp> = {
  'image/jpeg': (img) => img.jpeg({ quality: 82 }),
  'image/png': (img) => img.png(),
  'image/webp': (img) => img.webp({ quality: 80 }),
  'image/avif': (img) => img.avif({ quality: 50, effort: 2 })
};

/** The largest picture whose copies are made from pixels decoded once per width: a slot of the media worker's budget. */
const SHARED_PIXELS = 16_000_000;

/** Formats in the order a record lists copies of one width: the picture's own first, then the modern ones. */
const rank = (mime: CopyMime, own: CopyMime) => (mime === own ? 0 : mime === 'image/webp' ? 1 : 2);

/** Whether an AVIF set is worth offering: at least 10% smaller than the WebP set of the same widths. */
export const keepsAvif = (avifBytes: number, webpBytes: number) => avifBytes * 10 <= webpBytes * 9;

/** The type note libvips writes after EXIF text when it reads it back, which it drops again when it writes the text. */
const EXIF_TEXT_NOTE = '(ASCII, 1 components, 1 bytes)';

/**
 * Deterministic responsive copies of a still JPEG, PNG, WebP or AVIF. `width` is the displayed width; the copies are
 * turned the way the picture's EXIF orientation says. A picture gets three sets of copies, one per format a page offers:
 *
 * - its own format at each of VARIANT_WIDTHS meaningfully smaller than it, the original serving its full width;
 * - WebP at those widths and its full width (none for a WebP, whose own set is that);
 * - AVIF the same way, kept only when the whole set is at least 10% smaller than the WebP one (keepsAvif; an AVIF's
 *   own set is always kept). AVIF is not always the smaller: flat graphics and small pictures often favour WebP.
 *
 * JPEG and PNG copies are written without metadata (an export gives them the original's credits); WebP and AVIF ones
 * carry the original's credits, which an export cannot add to them, and nothing else. A modern set that cannot be
 * made is left out whole, so a page never offers a set missing its widest copy. A moving picture (animated PNG or
 * WebP, an AVIF sequence) gets none: a resized copy would be a single frame, and its srcset would mix the moving
 * original with stills. `targets` asks for exactly those copies (making again the ones a library image already
 * lists), each never wider than the picture, with no choosing between sets; one that fails is left out alone.
 */
export async function renderVariants(buf: Buffer, mime: string, width: number, targets?: VariantTarget[], tally?: Tally): Promise<Variant[]> {
  if (!isCopyMime(mime)) return [];
  if (mime === 'image/png' && isAnimatedPng(buf)) return [];
  if (mime === 'image/avif' && avifBrands(buf).includes('avis')) return [];
  // The decoder's own reading of the displayed width wins over the header's: a copy is never labelled wider
  // than the picture it was made from.
  const meta = await sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS }).metadata();
  if ((meta.pages ?? 1) > 1) return [];
  const displayed = Math.min(width, meta.autoOrient?.width ?? meta.width ?? width);
  let credits: CreditText | undefined;
  // Each width is decoded, turned and resized once, and the copies at that width are encoded from those pixels (#979):
  // the same bytes as a pipeline of its own for each copy. Only for an 8-bit RGB picture (its colour profile, if any, is
  // applied by the decode) of at most a slot of the worker's pixel budget (the pixels of each width are held until its
  // last copy), whose copies carry no credits (the encoder writes credits onto pixels with no metadata of their own with
  // more EXIF fields than onto the picture's own); and never a PNG copy, which keeps the picture's resolution only when
  // made from the picture.
  credits = creditText(cleanPhoto(buf)?.credits ?? {});
  const shared = meta.depth === 'uchar' && meta.space === 'srgb' && (meta.channels === 3 || meta.channels === 4) && (meta.width ?? Infinity) * (meta.height ?? Infinity) <= SHARED_PIXELS && !targets && !credits.artist && !credits.copyright && !credits.xmp;
  const sized = new Map<number, Promise<{ data: Buffer; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } }>>();
  const pixelsAt = (w: number) => {
    let p = sized.get(w);
    // Never enlarged: a picture smaller than its header claimed keeps the size it has.
    if (!p) sized.set(w, (p = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS }).autoOrient().resize({ width: w, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true })));
    return p;
  };
  const encode = async (t: VariantTarget): Promise<Variant> => {
    let img = shared && t.mime !== 'image/png'
      ? await pixelsAt(t.width).then(({ data, info }) => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }))
      : // Never enlarged: a picture smaller than its header claimed keeps the size it has.
        sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS }).autoOrient().resize({ width: t.width, withoutEnlargement: true });
    if (t.mime === 'image/webp' || t.mime === 'image/avif') {
      credits ??= creditText(cleanPhoto(buf)?.credits ?? {});
      // libvips reads a trailing " (…)" in EXIF text as its own type note and drops it: one is added for it to drop, so a
      // credit such as "Ana Field (Studio)" keeps its own.
      const exif = (v: string) => `${v} ${EXIF_TEXT_NOTE}`;
      if (credits.artist || credits.copyright) img = img.withExif({ IFD0: { ...(credits.artist ? { Artist: exif(credits.artist) } : {}), ...(credits.copyright ? { Copyright: exif(credits.copyright) } : {}) } });
      if (credits.xmp) img = img.withXmp(credits.xmp);
    }
    const made = () => tallied(tally, (n, ms) => ((n.encodes++), (n.formatMs[t.mime] = (n.formatMs[t.mime] ?? 0) + ms)), () => ENCODE[t.mime](img).toBuffer());
    const data = await (t.mime === 'image/avif' ? inAvifTurn(made) : made());
    return { ...t, data };
  };
  const out: Variant[] = [];
  if (targets) {
    // Each copy on its own: one that cannot be made is left out (and reported missing), never the others with it.
    for (const t of targets) if (isCopyMime(t.mime) && Number.isInteger(t.width) && t.width > 0 && t.width <= displayed) out.push(...(await encode(t).then((v) => [v], () => [])));
    return out;
  }
  const smaller = VARIANT_WIDTHS.filter((w) => w < displayed * 0.9);
  for (const w of smaller) out.push(await encode({ width: w, mime }));
  /** A modern format's whole set (its full width too), or null when any copy of it cannot be made. */
  const set = async (format: 'image/webp' | 'image/avif'): Promise<Variant[] | null> => {
    try {
      const made: Variant[] = [];
      for (const w of [...smaller, displayed]) made.push(await encode({ width: w, mime: format }));
      return made;
    } catch {
      return null;
    }
  };
  const bytes = (list: Variant[]) => list.reduce((n, v) => n + v.data.length, 0);
  // A WebP's own copies, with the original at its full width, are its WebP set.
  const webp = mime === 'image/webp' ? out : await set('image/webp');
  const webpBytes = webp && bytes(webp) + (mime === 'image/webp' ? buf.length : 0);
  if (webp && mime !== 'image/webp') out.push(...webp);
  if (mime !== 'image/avif') {
    const avif = await set('image/avif');
    if (avif && webpBytes !== null && keepsAvif(bytes(avif), webpBytes)) out.push(...avif);
  }
  return out.sort((a, b) => a.width - b.width || rank(a.mime, mime) - rank(b.mime, mime));
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
export async function renderWebCopy(buf: Buffer, maxEdge = WEB_EDGE, tally?: Tally): Promise<WebCopy> {
  const open = () => sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error' });
  // An alpha channel that is fully opaque everywhere (screenshots, many exported photos) is no reason to stay a PNG.
  const clear = !(await isOpaque(buf, tally));
  const meta = await open().metadata();
  const shown = { width: meta.autoOrient?.width ?? meta.width ?? 0, height: meta.autoOrient?.height ?? meta.height ?? 0 };
  // Exactly the size webCopySize gives (as an import review shows it), never enlarged.
  const size = webCopySize(shown.width, shown.height, maxEdge);
  const img = open().autoOrient();
  if (size.width !== shown.width || size.height !== shown.height) img.resize({ width: size.width, height: size.height, fit: 'fill' });
  const { data, info } = await tallied(tally, (t, ms) => ((t.encodes++), (t.webCopyMs += ms)), () => (clear ? img.png() : img.flatten({ background: '#ffffff' }).jpeg({ quality: 82 })).toBuffer({ resolveWithObject: true }));
  return { data, mime: clear ? 'image/png' : 'image/jpeg', width: info.width, height: info.height };
}

/**
 * Whether the decoder can read the picture's image data, not just its header: a file whose structure is whole can
 * still hold pixel data no browser can decode. Decoded small, so a large photo costs little.
 */
export async function isReadable(buf: Buffer, mime?: string, tally?: Tally): Promise<boolean> {
  const decode = (pages?: number) => tallied(tally, asDecode, () => sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error', ...(pages ? { pages } : {}) }).resize(16, 16, { fit: 'inside' }).raw().toBuffer());
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
export async function isOpaque(buf: Buffer, tally?: Tally): Promise<boolean> {
  const img = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error' });
  if (!(await img.metadata()).hasAlpha) return true;
  return (await tallied(tally, asDecode, () => img.stats())).isOpaque;
}

/**
 * The website's square icons from a picture (the favicon, or the monogram's SVG), one for each of `icons`, a PNG or
 * an ICO of PNGs: turned
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
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const square = (size: number, background?: string) => {
    const img = sharp(buf, { limitInputPixels: MAX_VARIANT_PIXELS, failOn: 'error', pages: 1, page: 0, ...(density ? { density } : {}) })
      .autoOrient()
      .resize(size, size, { fit: 'contain', position: 'centre', background: background ?? clear });
    return (background ? img.flatten({ background }) : img).toColourspace('srgb');
  };
  // The PNGs in an ICO are 32-bit RGBA (Windows reads no others), whatever channels the picture has.
  const draw = (size: number, icon: IconSpec) => (icon.ico ? square(size, icon.background).ensureAlpha() : square(size, icon.background)).png().toBuffer();
  // Every image is drawn from the picture on its own, so the bytes are the same however many are drawn at a time. An
  // SVG (the monogram, a logo) is drawn at the largest icon's density for each of them: all at once, the set takes as
  // long as its slowest image rather than all of them together. A photo is decoded once per image, so one at a time.
  const at = density ? <T>(items: readonly T[], fn: (item: T) => Promise<Buffer>) => Promise.all(items.map(fn)) : async <T>(items: readonly T[], fn: (item: T) => Promise<Buffer>) => {
    const out: Buffer[] = [];
    for (const item of items) out.push(await fn(item));
    return out;
  };
  return at(icons, async (icon) => {
    if (!icon.ico) return draw(icon.size, icon);
    const sizes = icon.ico;
    const pngs = await at(sizes, (size) => draw(size, icon));
    return packIco(sizes.map((size, n) => ({ size, png: pngs[n] })));
  });
}

/** An ICO file of square PNG images of at most 256 pixels: a header, one directory entry for each, then the images. */
function packIco(images: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2); // an icon, not a cursor
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, png }, n) => {
    const at = 6 + 16 * n;
    // A side of 256 is written as 0.
    directory.writeUInt8(size % 256, at);
    directory.writeUInt8(size % 256, at + 1);
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...images.map((i) => i.png)]);
}

/**
 * What the media worker does with one request; the worker process only carries messages to and from it. With `stats`
 * asked for, the reply says what the request cost (MediaStats).
 */
export async function handleVariantRequest(m: VariantRequest): Promise<VariantReply> {
  if (!m.stats) return handle(m);
  const tally = newTally();
  const start = performance.now();
  const cpu = process.cpuUsage();
  const reply = await handle(m, tally);
  const used = process.cpuUsage();
  const ms = (u: NodeJS.CpuUsage) => (u.user + u.system) / 1000;
  const stats = { pid: process.pid, ms: performance.now() - start, cpuMs: ms(used) - ms(cpu), cpuStartMs: ms(cpu), cpuEndMs: ms(used), peakRss: process.resourceUsage().maxRSS * 1024, ...tally };
  return { ...reply, stats };
}

async function handle(m: VariantRequest, tally?: Tally): Promise<VariantReply> {
  try {
    const buf = m.path ? await readFile(m.path) : Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength);
    if (tally && m.path) tally.readBytes += buf.length;
    if (m.kind === 'opaque') return { id: m.id, ok: true, variants: [], opaque: await isOpaque(buf, tally) };
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
      if (!(await isReadable(buf, m.path ? 'image/tiff' : m.mime, tally))) return { id: m.id, ok: false, error: 'The picture could not be decoded.', unreadable: true };
      const web = await renderWebCopy(buf, m.maxEdge, tally);
      return { id: m.id, ok: true, variants: [], web: { ...web, data: new Uint8Array(web.data.buffer, web.data.byteOffset, web.data.byteLength) } };
    }
    if (m.check && !(await isReadable(buf, m.mime, tally))) return { id: m.id, ok: false, error: 'The picture could not be decoded.', unreadable: true };
    const variants = await renderVariants(buf, m.mime, m.width, m.targets, tally);
    return { id: m.id, ok: true, variants: variants.map((v) => ({ width: v.width, mime: v.mime, data: new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength) })) };
  } catch (e) {
    return { id: m.id, ok: false, error: (e as Error).message };
  }
}
