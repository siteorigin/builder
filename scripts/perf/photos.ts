/**
 * The photographs the `import` scenario adds (#979): 20 camera-sized JPEGs of about 12 megapixels, drawn here from a
 * seed so every run imports the same pictures. They are made the way a phone makes them: 4032 × 3024, a Display P3
 * colour profile, some turned by their EXIF orientation (a portrait shot held upright), some carrying an author and
 * copyright, and texture enough to weigh what a photo weighs (about 3 to 5 MB). Made once per machine, keyed by this
 * file's recipe and the encoder's version, under `.tmp/perf/photos/`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures';

/** How many photos the scenario imports, and their size. */
export const PHOTO_COUNT = 20;
export const PHOTO_WIDTH = 4032;
export const PHOTO_HEIGHT = 3024;
/** Bumped when the recipe below changes, so photos drawn by an older one are never reused. */
const RECIPE = 1;

/** The photo `i` (from 1): its file name, and whether it is turned or credited. */
export function photoSpec(i: number): { name: string; turned: boolean; credited: boolean } {
  return { name: `photo-${String(i).padStart(2, '0')}.jpg`, turned: i % 4 === 0, credited: i % 5 === 0 };
}

/** A seeded xorshift32 stream. */
function stream(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

/**
 * Photo `i`'s pixels, RGB: a sky-to-ground gradient in its own colours, large soft shapes, fine texture and sensor
 * noise. Separable sums of sines keep it quick to draw while giving the encoder a photo's worth of detail.
 */
function draw(i: number, width: number, height: number): Buffer {
  const next = stream(createHash('sha256').update(`siteorigin-perf-photo:${i}`).digest().readUInt32LE(0));
  const r = () => next() / 0xffffffff;
  const top = [80 + r() * 140, 90 + r() * 130, 120 + r() * 120];
  const bottom = [30 + r() * 120, 40 + r() * 110, 20 + r() * 90];
  const waves = Array.from({ length: 6 }, () => ({ fx: 0.002 + r() * 0.03, fy: 0.002 + r() * 0.03, px: r() * 6.28, py: r() * 6.28, a: 6 + r() * 18, c: Math.floor(r() * 3) }));
  const fine = Array.from({ length: 3 }, () => ({ f: 0.15 + r() * 0.6, p: r() * 6.28, a: 2 + r() * 5 }));
  const colX = waves.map((w) => Float32Array.from({ length: width }, (_, x) => Math.sin(x * w.fx + w.px)));
  const colY = waves.map((w) => Float32Array.from({ length: height }, (_, y) => Math.sin(y * w.fy + w.py)));
  const fineX = fine.map((w) => Float32Array.from({ length: width }, (_, x) => w.a * Math.sin(x * w.f + w.p)));
  const fineY = fine.map((w) => Float32Array.from({ length: height }, (_, y) => w.a * Math.sin(y * w.f * 0.7 + w.p)));
  const out = Buffer.alloc(width * height * 3);
  const add = [0, 0, 0];
  let o = 0;
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const base = [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v, top[2] + (bottom[2] - top[2]) * v];
    let texY = 0;
    for (const f of fineY) texY += f[y];
    for (let x = 0; x < width; x++) {
      add[0] = add[1] = add[2] = 0;
      for (let k = 0; k < waves.length; k++) add[waves[k].c] += waves[k].a * colX[k][x] * colY[k][y];
      let tex = texY;
      for (const f of fineX) tex += f[x];
      const n = next();
      for (let c = 0; c < 3; c++) {
        const noise = ((n >>> (c * 8)) & 0xff) / 10 - 12.8;
        const value = base[c] + add[c] + tex * (0.6 + 0.2 * c) + noise;
        out[o++] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
  }
  return out;
}

/**
 * The folder of the scenario's photos, drawn and encoded the first time on this machine. Every file is written whole
 * before the folder takes its name, so a run that stops half way never leaves a set short.
 */
export async function scenarioPhotos(): Promise<{ dir: string; files: string[]; hash: string }> {
  const sharp = (await import('sharp')).default;
  const key = createHash('sha256').update(`${RECIPE}:${PHOTO_COUNT}:${PHOTO_WIDTH}x${PHOTO_HEIGHT}:${sharp.versions.vips}:${sharp.versions.sharp ?? ''}`).digest('hex').slice(0, 12);
  const dir = join(ROOT, '.tmp', 'perf', 'photos', key);
  const names = Array.from({ length: PHOTO_COUNT }, (_, n) => photoSpec(n + 1).name);
  if (!existsSync(dir)) {
    const part = `${dir}.part-${process.pid}`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    for (let i = 1; i <= PHOTO_COUNT; i++) {
      const spec = photoSpec(i);
      // A portrait shot is stored as the sensor saw it, on its side, and shown upright by its orientation (6).
      const img = sharp(draw(i, PHOTO_WIDTH, PHOTO_HEIGHT), { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 3 } });
      const exif = { IFD0: { Make: 'Benchmark', Model: 'Photo 12MP', ...(spec.credited ? { Artist: 'Ana Field', Copyright: '© 2026 Ana Field' } : {}) } };
      const bytes = await img
        .withIccProfile('p3')
        .withExif(exif)
        .withMetadata({ orientation: spec.turned ? 6 : 1 })
        .jpeg({ quality: 90 })
        .toBuffer();
      writeFileSync(join(part, spec.name), bytes);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  }
  const listed = readdirSync(dir).filter((f) => names.includes(f));
  if (listed.length !== PHOTO_COUNT) throw new Error(`The scenario's photos in ${dir} are incomplete: remove the folder to draw them again.`);
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update('\0').update(readFileSync(join(dir, name))).update('\0');
  return { dir, files: names.map((n) => join(dir, n)), hash: hash.digest('hex').slice(0, 16) };
}

/** The system's image converter on macOS, which the app decodes HEIC photos with too (src/main/project/photo-convert.ts). */
const SIPS = '/usr/bin/sips';

/**
 * The `importHeic` scenario's photos: the same 20 pictures as HEIC files, as an iPhone saves them, converted from the
 * JPEGs by macOS's own encoder (which turns the pixels upright and keeps the credits). Made once per machine, keyed by
 * the JPEGs and the encoder's version, under `.tmp/perf/photos/`; only on macOS, which has the encoder and the decoder
 * the app converts HEIC with.
 */
export async function scenarioHeicPhotos(): Promise<{ dir: string; files: string[]; hash: string }> {
  if (process.platform !== 'darwin' || !existsSync(SIPS)) throw new Error('The HEIC photos are made with macOS’s sips, and only macOS can import them: run importHeic on a Mac.');
  const jpegs = await scenarioPhotos();
  const version = execFileSync(SIPS, ['--version'], { encoding: 'utf8' }).trim();
  const key = createHash('sha256').update(`heic:${jpegs.hash}:${version}`).digest('hex').slice(0, 12);
  const dir = join(ROOT, '.tmp', 'perf', 'photos', `${key}-heic`);
  const names = Array.from({ length: PHOTO_COUNT }, (_, n) => photoSpec(n + 1).name.replace(/\.jpg$/, '.heic'));
  if (!existsSync(dir)) {
    const part = `${dir}.part-${process.pid}`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    for (const [n, jpeg] of jpegs.files.entries()) execFileSync(SIPS, ['-s', 'format', 'heic', jpeg, '--out', join(part, names[n])], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  }
  const listed = readdirSync(dir).filter((f) => names.includes(f));
  if (listed.length !== PHOTO_COUNT) throw new Error(`The scenario's HEIC photos in ${dir} are incomplete: remove the folder to make them again.`);
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update('\0').update(readFileSync(join(dir, name))).update('\0');
  return { dir, files: names.map((n) => join(dir, n)), hash: hash.digest('hex').slice(0, 16) };
}

/**
 * The `previewImages` scenario's gallery (#1037): 20 photographs as an import stores them, each a web-sized copy of a
 * 12-megapixel photo (2560 × 1920, a JPEG at the quality the app writes) with the responsive copies the media worker
 * makes of it (src/main/project/image-variants.ts renderVariants: JPEG at each smaller width, WebP at those and its
 * full width, AVIF the same when smaller), named as the library names them. Drawn as the import's photos are, from
 * seeds of their own. Made once per machine, keyed by this recipe, the encoder's version and the copies' rule, under
 * `.tmp/perf/photos/`.
 */
export const GALLERY_COUNT = 20;
export const GALLERY_WIDTH = 2560;
export const GALLERY_HEIGHT = 1920;
const GALLERY_RECIPE = 1;

/** One gallery photo: its file in the project and the copies beside it, each as the library records them. */
export interface GalleryPhoto {
  name: string;
  file: string;
  width: number;
  height: number;
  variants: Array<{ width: number; file: string }>;
}

/** The gallery's photos, and the folder holding their files under the names they take in a project's `static/assets/`. */
export async function galleryPhotos(): Promise<{ dir: string; photos: GalleryPhoto[]; hash: string }> {
  const sharp = (await import('sharp')).default;
  const { renderVariants, VARIANT_WIDTHS } = await import('../../src/main/project/image-variants');
  const { COPY_EXTENSIONS } = await import('../../src/shared/picture-formats');
  const key = createHash('sha256').update(`gallery:${GALLERY_RECIPE}:${GALLERY_COUNT}:${GALLERY_WIDTH}x${GALLERY_HEIGHT}:${VARIANT_WIDTHS.join(',')}:${sharp.versions.vips}:${sharp.versions.sharp ?? ''}`).digest('hex').slice(0, 12);
  const dir = join(ROOT, '.tmp', 'perf', 'photos', `${key}-gallery`);
  const manifest = join(dir, 'gallery.json');
  if (!existsSync(manifest)) {
    const part = `${dir}.part-${process.pid}`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    const photos: GalleryPhoto[] = [];
    for (let i = 1; i <= GALLERY_COUNT; i++) {
      const data = await sharp(draw(100 + i, GALLERY_WIDTH, GALLERY_HEIGHT), { raw: { width: GALLERY_WIDTH, height: GALLERY_HEIGHT, channels: 3 } })
        .jpeg({ quality: 82 })
        .toBuffer();
      // As planStore names a stored picture and its copies (src/main/project/assets.ts).
      const stem = `gallery-${String(i).padStart(2, '0')}-${createHash('sha256').update(data).digest('hex').slice(0, 8)}`;
      writeFileSync(join(part, `${stem}.jpg`), data);
      const variants: GalleryPhoto['variants'] = [];
      for (const v of await renderVariants(data, 'image/jpeg', GALLERY_WIDTH)) {
        const name = `${stem}-${v.width}w.${COPY_EXTENSIONS[v.mime]}`;
        writeFileSync(join(part, name), v.data);
        variants.push({ width: v.width, file: `static/assets/${name}` });
      }
      photos.push({ name: `Gallery photo ${String(i).padStart(2, '0')}`, file: `static/assets/${stem}.jpg`, width: GALLERY_WIDTH, height: GALLERY_HEIGHT, variants });
    }
    writeFileSync(join(part, 'gallery.json'), JSON.stringify(photos, null, 2) + '\n');
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  }
  const photos = JSON.parse(readFileSync(manifest, 'utf8')) as GalleryPhoto[];
  const hash = createHash('sha256');
  for (const p of photos) for (const f of [p.file, ...p.variants.map((v) => v.file)]) hash.update(f).update('\0').update(readFileSync(join(dir, f.replace(/^static\/assets\//, '')))).update('\0');
  return { dir, photos, hash: hash.digest('hex').slice(0, 16) };
}

/**
 * The `sourceSync` scenario's photos (#1045): 40 camera-sized JPEGs (4032 × 3024, about 3 MB each), as a source's
 * records might show at full size, drawn as the import's photos are, from seeds of their own, and plain (no profile,
 * orientation or credits, which a CMS's originals often lack). Made once per machine, keyed by this recipe and the
 * encoder's version, under `.tmp/perf/photos/`.
 */
export const SYNC_PHOTO_COUNT = 40;
const SYNC_RECIPE = 1;

/** Sync photo `i` (from 1): its file name as the source's server gives it. */
export const syncPhotoName = (i: number) => `sync-photo-${String(i).padStart(2, '0')}.jpg`;

export async function syncPhotos(): Promise<{ dir: string; files: string[]; hash: string }> {
  const sharp = (await import('sharp')).default;
  const key = createHash('sha256').update(`sync:${SYNC_RECIPE}:${SYNC_PHOTO_COUNT}:${PHOTO_WIDTH}x${PHOTO_HEIGHT}:${sharp.versions.vips}:${sharp.versions.sharp ?? ''}`).digest('hex').slice(0, 12);
  const dir = join(ROOT, '.tmp', 'perf', 'photos', `${key}-sync`);
  const names = Array.from({ length: SYNC_PHOTO_COUNT }, (_, n) => syncPhotoName(n + 1));
  if (!existsSync(dir)) {
    const part = `${dir}.part-${process.pid}`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    for (let i = 1; i <= SYNC_PHOTO_COUNT; i++) {
      const bytes = await sharp(draw(200 + i, PHOTO_WIDTH, PHOTO_HEIGHT), { raw: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT, channels: 3 } })
        .jpeg({ quality: 90 })
        .toBuffer();
      writeFileSync(join(part, syncPhotoName(i)), bytes);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  }
  const listed = readdirSync(dir).filter((f) => names.includes(f));
  if (listed.length !== SYNC_PHOTO_COUNT) throw new Error(`The scenario's sync photos in ${dir} are incomplete: remove the folder to draw them again.`);
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update('\0').update(readFileSync(join(dir, name))).update('\0');
  return { dir, files: names.map((n) => join(dir, n)), hash: hash.digest('hex').slice(0, 16) };
}

/** One photo of the `photoReads` library: its file in the project, its bytes, and what it carries. */
export interface LibraryPhoto {
  name: string;
  file: string;
  bytes: Buffer;
  /** Its XMP names the city it was taken in, so Assets says it records where it was taken. */
  located: boolean;
  /** Stored on its side and shown upright by its orientation (portrait). */
  turned: boolean;
}

/** An XMP packet as a photo editor writes one, naming the city when there is one, else only a title. */
function xmpPacket(i: number, city: string | null): Buffer {
  const what = city ? ` photoshop:City="${city}"` : ` dc:format="image/jpeg"`;
  const ns = city ? ' xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"' : ' xmlns:dc="http://purl.org/dc/elements/1.1/"';
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""${ns}${what} xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Label="Library ${i}"/></rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;
  return Buffer.from(xml, 'utf8');
}

/** `jpeg` with an XMP segment after its JFIF header (or its start), as an editor adds one: nothing is encoded again. */
export function withXmpSegment(jpeg: Buffer, xmp: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), xmp]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  const at = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  return Buffer.concat([jpeg.subarray(0, at), head, payload, jpeg.subarray(at)]);
}

export const LIBRARY_COUNT = PHOTO_COUNT;

/**
 * The `photoReads` scenario's library (#1046): the import's 20 photos of 12 megapixels as originals an author kept,
 * every other one (the odd ones) naming the city it was taken in, and a favicon that is a 12-megapixel photo too (the
 * second, with a packet of its own so its bytes are not a library photo's). Made from the import's JPEGs by adding an
 * XMP segment, so nothing is encoded again and the same bytes come out on every machine with the same JPEGs.
 */
export async function libraryPhotos(): Promise<{ photos: LibraryPhoto[]; favicon: { file: string; bytes: Buffer }; hash: string }> {
  const jpegs = await scenarioPhotos();
  const two = (i: number) => String(i).padStart(2, '0');
  const photos = jpegs.files.map((f, n): LibraryPhoto => {
    const i = n + 1;
    const located = i % 2 === 1;
    return { name: `Library photo ${two(i)}`, file: `static/assets/library-photo-${two(i)}.jpg`, bytes: withXmpSegment(readFileSync(f), xmpPacket(i, located ? 'Cape Town' : null)), located, turned: photoSpec(i).turned };
  });
  const favicon = { file: 'static/assets/perf-large-favicon.jpg', bytes: withXmpSegment(readFileSync(jpegs.files[1]), xmpPacket(0, null)) };
  const hash = createHash('sha256');
  for (const p of [...photos, favicon]) hash.update(p.file).update('\0').update(p.bytes).update('\0');
  return { photos, favicon, hash: hash.digest('hex').slice(0, 16) };
}
