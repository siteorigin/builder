/**
 * Phone and camera photos (issue #230). A HEIC photo becomes an upright JPEG copy where the platform can decode it,
 * and is refused with a specific way forward where it can't. A large JPEG or PNG can be added, or replaced in the
 * library, as a web-sized copy. The review says what each file will become before anything is written, and the
 * author's own files are only ever read.
 */
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, promises, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VariantRequest } from '../../src/main/project/media-client';

const env = vi.hoisted(() => ({ userData: '' }));

/** The preview's worker: ready at once, gone when asked to stop. */
class FakeRuntime extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (!this.exited) queueMicrotask(() => this.emit('exit', 0));
    this.exited = true;
    return true;
  }
}

/** While `held` is set, the copies an import makes once its pictures have landed (#979) wait for it to settle. */
const later = vi.hoisted(() => ({ held: null as Promise<void> | null, asked: 0, requests: [] as Array<{ kind: string; bytes: number; weighed?: boolean }>, failLibrary: false, copyHeld: null as Promise<void> | null, releaseCopy: null as (() => void) | null }));

/** The media worker, run in this process by the code the real worker runs. */
class InlineMediaWorker extends EventEmitter {
  postMessage(m: VariantRequest) {
    later.requests.push({ kind: m.kind ?? 'variants', bytes: m.data.byteLength, ...(m.library ? { weighed: m.library.known.includes(m.library.expect) } : {}) });
    if (m.kind === 'library' && later.failLibrary) return void queueMicrotask(() => this.emit('message', { id: m.id, ok: false, error: 'The worker failed.' }));
    // A picture's whole set of copies, with no check first and no copies named: what makePendingCopies asks for.
    const copies = (!m.kind || m.kind === 'variants') && !m.check && !m.targets;
    if (copies) later.asked++;
    void (copies && later.held ? later.held : Promise.resolve())
      .then(() => import('../../src/main/project/image-variants'))
      .then(({ handleVariantRequest }) => handleVariantRequest(m, (early) => this.emit('message', early)))
      // While `copyHeld` is set, a library image's copy is held back once what it says has gone ahead.
      .then(async (r) => (m.kind === 'library' && later.copyHeld && r.ok && r.web ? (await later.copyHeld, r) : r))
      .then((r) => this.emit('message', r));
  }
  kill() {
    return true;
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: (path: string) => (path.endsWith('media-worker.js') ? new InlineMediaWorker() : new FakeRuntime()) }
}));

const { checkPixels, importAsset, importAssetBatch, importPackageImage, locateAssetFile, makePendingCopies, MEDIA_PARALLEL, noConverterReason, reviewImportFile, isOpaquePicture, stopMediaWorker, webCopySize, WEB_EDGE, LIGHTER_SHARE } = await import('../../src/main/project/assets');
const { generateProject } = await import('../../src/generator/index');
const { heicDecoder } = await import('../../src/main/project/photo-convert');
const { WEB_EDGE: WORKER_WEB_EDGE } = await import('../../src/main/project/image-variants');
const { cleanPhoto, photoMetadata } = await import('../../src/main/project/photo-metadata');
const { ProjectSession } = await import('../../src/main/project/session');
const { Controller } = await import('../../src/main/controller');
const { assetUsages } = await import('@engine/apply');
const { createStarterState, STARTER_ASSETS } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');

const HEIC = readFileSync(join(import.meta.dirname, 'fixtures/portrait-rotated.heic'));
/** sips is part of macOS: the real conversion runs only there. */
const canConvert = process.platform === 'darwin' && existsSync('/usr/bin/sips');

const dirs: string[] = [];
const temp = (name = 'files') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-photo-${name}-`)));
  dirs.push(d);
  return d;
};
const controllers: Array<InstanceType<typeof Controller>> = [];
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  // A copy held back by a test that did not finish is let go, so no later test waits behind it.
  later.releaseCopy?.();
  later.copyHeld = later.releaseCopy = null;
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
afterAll(() => stopMediaWorker());

/** Write `data` as `name` in a fresh folder, and return its path. */
function sourceFile(name: string, data: Buffer): string {
  const src = temp('source');
  writeFileSync(join(src, name), data);
  return join(src, name);
}

/** A photo-like picture (noise) that is large in bytes, so it is offered a web-sized copy; `alpha` adds an opaque alpha channel. */
const noisy = async (width: number, height: number, format: 'jpeg' | 'png', alpha = false) => {
  const raw = await sharp({ create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).png().toBuffer();
  const img = alpha ? sharp(raw).ensureAlpha(1) : sharp(raw);
  return (format === 'png' ? img.png({ compressionLevel: 1 }) : img.jpeg({ quality: 95 })).toBuffer();
};

/** A record's copies in one format (by their files' extension), as their widths. */
const widthsIn = (r: { variants?: Array<{ width: number; file: string }> }, ext: string) => (r.variants ?? []).filter((v) => v.file.endsWith(`.${ext}`)).map((v) => v.width);

/**
 * A picture's copies, exactly: `smaller` in its own format (`ext`), a WebP set reaching `full` (a WebP's own copies are
 * its set), and an AVIF set the same widths, which only an AVIF always has; any other picture has it or not
 * (`avif`, when the test knows). Nothing else.
 */
function expectCopies(r: { variants?: Array<{ width: number; file: string }> }, ext: string, smaller: number[], full: number, avif?: boolean) {
  const listed = (r.variants ?? []).map((v) => `${v.width} ${v.file.split('.').pop()}`);
  const set = (e: string) => [...smaller, full].map((w) => `${w} ${e}`);
  const own = smaller.map((w) => `${w} ${ext}`);
  const without = ext === 'webp' ? own : ext === 'avif' ? [...own, ...set('webp')] : [...own, ...set('webp')];
  const withAvif = ext === 'avif' ? without : [...without, ...set('avif')];
  const sorted = (l: string[]) => [...l].sort();
  const expected = ext === 'avif' || avif === true ? [withAvif] : avif === false ? [without] : [without, withAvif];
  expect(expected.map(sorted), `${ext} copies`).toContainEqual(sorted(listed));
  // Narrowest first.
  expect((r.variants ?? []).map((v) => v.width), 'narrowest first').toEqual([...(r.variants ?? [])].map((v) => v.width).sort((a, b) => a - b));
}

async function pixel(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return { r: data[at], g: data[at + 1], b: data[at + 2] };
}

/** The fixture shows red on top, blue below and a green strip down its right edge once turned upright. */
async function expectUpright(buf: Buffer, width: number, height: number) {
  const m = await sharp(buf).metadata();
  expect([m.width, m.height, m.orientation]).toEqual([width, height, undefined]);
  const top = await pixel(buf, Math.round(width * 0.3), Math.round(height * 0.2));
  const bottom = await pixel(buf, Math.round(width * 0.3), Math.round(height * 0.8));
  const right = await pixel(buf, width - 4, Math.round(height * 0.5));
  expect(top.r).toBeGreaterThan(200);
  expect(top.b).toBeLessThan(60);
  expect(bottom.b).toBeGreaterThan(200);
  expect(bottom.r).toBeLessThan(60);
  expect(right.g).toBeGreaterThan(200);
}

const reviewOf = (path: string, converter = canConvert) => reviewImportFile(path, { converter, opaque: isOpaquePicture });

describe('reviewing an import before anything is written', () => {
  it('says a HEIC photo becomes an upright JPEG of its displayed size, or why it cannot be added', async () => {
    const path = sourceFile('IMG_0042.HEIC', HEIC);
    const row = await reviewOf(path, true);
    expect(row).toMatchObject({ name: 'IMG_0042.HEIC', action: 'convert', format: 'HEIC', width: 1200, height: 1600, copy: { format: 'JPEG', width: 1200, height: 1600 }, bytes: HEIC.length, fingerprint: sha(HEIC) });
    const none = await reviewOf(path, false);
    expect(none).toMatchObject({ action: 'refuse', format: 'HEIC', reason: noConverterReason() });
    expect(noConverterReason('win32')).toMatch(/phone it came from.*Photos app .*HEIF Image Extensions and HEVC Video Extensions.*Save as.*JPEG/);
    expect(noConverterReason('linux')).toMatch(/Export it as a JPEG .*then add the JPEG here/);
    // What the import would say, the review says first, in the same order: a damaged photo is damaged anywhere.
    const cut = sourceFile('cut.heic', HEIC.subarray(0, HEIC.length - 100));
    expect(await reviewOf(cut, false)).toMatchObject({ action: 'refuse', reason: expect.stringMatching(/^it is incomplete/) });
    await expect(importAsset(temp('project'), cut, [], undefined, { decoder: null })).rejects.toThrow(/^cut\.heic was not imported because it is incomplete/);
  });

  it('offers a large JPEG or PNG a web-sized copy, and leaves ordinary files to import as they are', async () => {
    const big = await noisy(3000, 2000, 'png');
    expect(big.length).toBeGreaterThan(1_500_000);
    expect(await reviewOf(sourceFile('scan.png', big))).toMatchObject({ action: 'offer', format: 'PNG', width: 3000, height: 2000, copy: { format: 'JPEG', width: 2560, height: 1707 }, fingerprint: sha(big) });
    const camera = await noisy(3000, 4000, 'jpeg');
    expect(camera.length).toBeGreaterThan(1_500_000);
    expect(await reviewOf(sourceFile('camera.jpg', camera))).toMatchObject({ action: 'offer', format: 'JPEG', copy: { format: 'JPEG', width: 1920, height: 2560 } });
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    expect(await reviewOf(sourceFile('ordinary.jpg', small))).toMatchObject({ action: 'import', bytes: small.length });
    expect((await reviewOf(sourceFile('ordinary.jpg', small))).format).toBeUndefined();
    // A large picture of a kind that gets no web copy (WebP, GIF, SVG) imports as it is.
    const webp = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).webp().toBuffer();
    expect((await reviewOf(sourceFile('big.webp', webp))).action).toBe('import');
  });

  it('refuses a picture over 100 megapixels however small its file, saying so first, and writes or decodes nothing (#1444)', async () => {
    const poster = await sharp({ create: { width: 20_000, height: 6_000, channels: 3, background: '#335577' } }).png({ palette: true, compressionLevel: 9 }).toBuffer();
    expect(poster.length).toBeLessThan(1_500_000);
    const reason = 'it is over 100 megapixels, too large to make web-sized copies of. Save a smaller copy of it in an image editor, then add that.';
    const path = sourceFile('poster.png', poster);
    expect(await reviewOf(path)).toMatchObject({ action: 'refuse', format: 'PNG', reason, fingerprint: sha(poster) });
    const project = temp('project');
    later.requests = [];
    const refused = new RegExp(`^poster\\.png was not imported because ${reason.replace(/\./g, '\\.')}$`);
    await expect(importAsset(project, path, [])).rejects.toThrow(refused);
    await expect(importAsset(project, path, [], undefined, { fingerprint: sha(poster) })).rejects.toThrow(refused);
    await expect(importAsset(project, path, [], undefined, { webCopy: true })).rejects.toThrow(refused);
    // The same picture as a WebP, and a JPEG named .heic, are refused alike.
    const webp = sourceFile('poster.webp', await sharp({ create: { width: 12_000, height: 9_000, channels: 3, background: '#335577' } }).webp().toBuffer());
    await expect(importAsset(project, webp, [])).rejects.toThrow(/^poster\.webp was not imported because it is over 100 megapixels/);
    const disguised = sourceFile('poster.heic', await sharp({ create: { width: 12_000, height: 9_000, channels: 3, background: '#335577' } }).jpeg().toBuffer());
    expect(await reviewOf(disguised, false)).toMatchObject({ action: 'refuse', reason });
    expect(later.requests).toEqual([]);
    expect(existsSync(join(project, 'static/assets')) ? readdirSync(join(project, 'static/assets')) : []).toEqual([]);
    // Nor can one stand in for a library image whose file is missing.
    const lost = { id: 'a_lost', name: 'Lost', kind: 'image', file: 'static/assets/lost-00000000.png', mime: 'image/png', bytes: 10, hash: 'other', createdAt: '2026-01-01T00:00:00.000Z' } as const;
    await expect(locateAssetFile(project, lost, path)).rejects.toThrow(/^poster\.png can't be used because it is over 100 megapixels/);
    // A sync or a package bringing one stores it as it is, with no copies, rather than hold up everything else it
    // brings: Project health names it instead.
    const synced = await importPackageImage(project, { name: 'Poster', mime: 'image/png', ext: '.png', bytes: poster }, []);
    expect(synced.record).toMatchObject({ width: 20_000, height: 6_000 });
    expect(synced.record.variants).toBeUndefined();
    expect(later.requests).toEqual([]);
    // At the cap a picture is still added, with its copies.
    const atCap = sourceFile('square.png', await sharp({ create: { width: 10_000, height: 10_000, channels: 3, background: '#335577' } }).png().toBuffer());
    expect((await reviewOf(atCap)).action).toBe('import');
  }, 60_000);

  it('counts out an ordinary-looking file that cannot be added, so the review never overcounts', async () => {
    expect(await reviewOf(sourceFile('notes.png', Buffer.from('just some text, not a picture')))).toMatchObject({ action: 'refuse', format: 'PNG', reason: expect.any(String) });
    expect(await reviewOf(sourceFile('empty.jpg', Buffer.alloc(0)))).toMatchObject({ action: 'refuse', format: 'JPEG', reason: expect.any(String) });
    expect(await reviewOf(sourceFile('huge.webp', Buffer.alloc(26 * 1024 * 1024)))).toMatchObject({ action: 'refuse', format: 'WEBP', reason: 'it is larger than 25 MB.' });
  });

  it('names the copy of a PNG by whether it really has see-through pixels, as the copy itself is made', async () => {
    const opaque = await noisy(3000, 2000, 'png', true);
    expect((await sharp(opaque).metadata()).hasAlpha).toBe(true);
    expect((await reviewOf(sourceFile('screenshot.png', opaque))).copy?.format).toBe('JPEG');
    // One see-through corner keeps it a PNG.
    const corner = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const clear = await sharp(opaque).composite([{ input: corner, left: 0, top: 0, blend: 'dest-out' }]).png({ compressionLevel: 1 }).toBuffer();
    expect((await reviewOf(sourceFile('cutout.png', clear))).copy?.format).toBe('PNG');
    const imported = await importAsset(temp('project'), sourceFile('cutout.png', clear), [], undefined, { webCopy: true });
    expect(imported.record.mime).toBe('image/png');
    // A palette PNG declares its see-through colour in a tRNS chunk, with no alpha channel.
    const hole = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const small = await sharp(await noisy(1500, 1100, 'png', true)).composite([{ input: hole, left: 0, top: 0, blend: 'dest-out' }]).png().toBuffer();
    const palette = await sharp(small).png({ palette: true, colours: 256, compressionLevel: 0 }).toBuffer();
    expect(palette.length).toBeGreaterThan(1_500_000);
    expect(palette[25]).toBe(3);
    expect(palette.includes(Buffer.from('tRNS'))).toBe(true);
    expect((await reviewOf(sourceFile('palette.png', palette))).copy?.format).toBe('PNG');
  }, 60_000);

  it('works out the size of a copy as the resizer does, never enlarging', async () => {
    expect(WEB_EDGE).toBe(WORKER_WEB_EDGE);
    expect(webCopySize(6000, 4000)).toEqual({ width: 2560, height: 1707 });
    expect(webCopySize(3024, 4032)).toEqual({ width: 1920, height: 2560 });
    expect(webCopySize(1200, 900)).toEqual({ width: 1200, height: 900 });
    expect(webCopySize(1, 10_000)).toEqual({ width: 1, height: 2560 });
  });
});

describe('importing a HEIC photo', () => {
  it.runIf(canConvert)('stores an upright JPEG copy with its responsive copies, and leaves the photo alone', async () => {
    const project = temp('project');
    const path = sourceFile('portrait-rotated.HEIC', HEIC);
    const { record, existing } = await importAsset(project, path, [], undefined, { decoder: heicDecoder() });
    expect(existing).toBe(false);
    expect(record).toMatchObject({ name: 'portrait rotated', originalName: 'portrait-rotated.HEIC', mime: 'image/jpeg', width: 1200, height: 1600, kind: 'image' });
    expect(record.file).toMatch(/^static\/assets\/portrait-rotated-[0-9a-f]{8}\.jpg$/);
    expectCopies(record, 'jpg', [160, 480, 960], 1200);
    const stored = readFileSync(join(project, record.file));
    expect(sha(stored)).toBe(record.hash);
    await expectUpright(stored, 1200, 1600);
    // Upright pixels, so no orientation, location or device details travel with the copy.
    expect(photoMetadata(stored)).toMatchObject({ location: false, device: false });
    for (const v of record.variants!) await expectUpright(readFileSync(join(project, v.file)), v.width, Math.round((v.width * 4) / 3));
    expect(readFileSync(path).equals(HEIC)).toBe(true);
    // The same photo again is the same copy, so it is the same asset.
    const again = await importAsset(project, sourceFile('again.heic', HEIC), [record], undefined, { decoder: heicDecoder() });
    // And keeps the name it first arrived under.
    expect(again).toMatchObject({ existing: true, record: { id: record.id, originalName: 'portrait-rotated.HEIC' } });
  });

  it('refuses a HEIC photo with a way forward where there is no converter, writing nothing', async () => {
    const project = temp('project');
    await expect(importAsset(project, sourceFile('IMG_0042.heic', HEIC), [], undefined, { decoder: null })).rejects.toThrow(/^IMG_0042\.heic was not imported because it is a HEIC photo, which browsers can’t show, and this computer has no converter for it\. .*JPEG/);
    expect(existsSync(join(project, 'static'))).toBe(false);
  });

  it('says how to recover when the converter fails or the file is not a photo', async () => {
    const failing = { decode: async () => Promise.reject(new Error('sips: exit 13')) };
    await expect(importAsset(temp('project'), sourceFile('broken.heic', HEIC), [], undefined, { decoder: failing })).rejects.toThrow(/^broken\.heic was not imported because it could not be converted\. Open it in Preview, choose File › Export › JPEG/);
    await expect(importAsset(temp('project'), sourceFile('notes.heic', Buffer.from('not a photo at all')), [], undefined, { decoder: failing })).rejects.toThrow(/^notes\.heic was not imported because it is not a HEIC photo/);
    await expect(importAsset(temp('project'), sourceFile('cut.heic', HEIC.subarray(0, HEIC.length - 100)), [], undefined, { decoder: failing })).rejects.toThrow(/^cut\.heic was not imported because it is incomplete/);
  });

  it('imports a .heic file that really holds a JPEG or an AVIF as that picture, with no converter', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c08040' } }).jpeg().toBuffer();
    const fromJpeg = await importAsset(temp('project'), sourceFile('exported.heic', jpeg), [], undefined, { decoder: null });
    expect(fromJpeg.record).toMatchObject({ mime: 'image/jpeg', name: 'exported', hash: sha(jpeg) });
    expect(fromJpeg.record.file).toMatch(/\/exported-[0-9a-f]{8}\.jpg$/);
    const avif = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c08040' } }).avif().toBuffer();
    expect((await importAsset(temp('project'), sourceFile('still.heif', avif), [], undefined, { decoder: null })).record).toMatchObject({ mime: 'image/avif' });
  });
});

describe('a web-sized copy of a large photo', () => {
  it('is stored instead of the original when asked for, capped and carrying the photo’s credits', async () => {
    const project = temp('project');
    const original = await sharp(await noisy(4000, 3000, 'jpeg')).withExif({ IFD0: { Artist: 'Ana Field', Copyright: 'Field Studio 2026' } }).jpeg({ quality: 95 }).toBuffer();
    const path = sourceFile('field-visit.jpg', original);
    const { record } = await importAsset(project, path, [], undefined, { webCopy: true });
    expect(record).toMatchObject({ name: 'field visit', originalName: 'field-visit.jpg', mime: 'image/jpeg', width: 2560, height: 1920 });
    expect(record.bytes).toBeLessThan(original.length);
    expectCopies(record, 'jpg', [160, 480, 960, 1440], 2560);
    const stored = readFileSync(join(project, record.file));
    const credits = cleanPhoto(stored)?.credits.tiff?.toString('latin1');
    expect(credits).toContain('Ana Field');
    expect(credits).toContain('Field Studio 2026');
    expect(readFileSync(path).equals(original)).toBe(true);
    // Without the choice the original is stored, as before.
    expect((await importAsset(temp('project'), path, [])).record).toMatchObject({ width: 4000, hash: sha(original) });
  }, 60_000);

  it('carries a PNG’s author and copyright text onto its JPEG copy', async () => {
    const png = await noisy(3000, 2000, 'png');
    const text = (keyword: string, value: string) => {
      const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`${keyword}\0${value}`, 'latin1')]);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length - 4);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    // After the header chunk: Author and Copyright text, as some editors save them.
    const end = 8 + 25;
    const credited = Buffer.concat([png.subarray(0, end), text('Author', 'Ana Field'), text('Copyright', 'Field Studio 2026'), png.subarray(end)]);
    const project = temp('project');
    const { record } = await importAsset(project, sourceFile('scan.png', credited), [], undefined, { webCopy: true });
    // Named after the PNG that was read, not the JPEG copy that is stored.
    expect(record).toMatchObject({ mime: 'image/jpeg', originalName: 'scan.png' });
    const credits = cleanPhoto(readFileSync(join(project, record.file)))?.credits.tiff?.toString('latin1');
    expect(credits).toContain('Ana Field');
    expect(credits).toContain('Field Studio 2026');
    // An artist in the PNG's EXIF and a copyright only in its text: both are carried, field by field.
    const exifPng = await sharp(png).withExif({ IFD0: { Artist: 'Bo Lens' } }).png({ compressionLevel: 1 }).toBuffer();
    const both = Buffer.concat([exifPng.subarray(0, end), text('Copyright', 'Lens & Co'), exifPng.subarray(end)]);
    const mixedProject = temp('project');
    const mixed = await importAsset(mixedProject, sourceFile('mixed.png', both), [], undefined, { webCopy: true });
    expect(mixed.record.mime).toBe('image/jpeg');
    const merged = cleanPhoto(readFileSync(join(mixedProject, mixed.record.file)))?.credits.tiff?.toString('latin1');
    expect(merged).toContain('Bo Lens');
    expect(merged).toContain('Lens & Co');
  }, 60_000);

  it('keeps the original, saying so, when a copy would be no smaller', async () => {
    const tiny = await sharp(await noisy(1000, 800, 'jpeg')).jpeg({ quality: 20 }).toBuffer();
    const r = await importAsset(temp('project'), sourceFile('tight.jpg', tiny), [], undefined, { webCopy: true });
    expect(r.record.hash).toBe(sha(tiny));
    expect(r.note).toBe('tight.jpg was added as it is: a web-sized copy would be no smaller.');
  });

  it('skips a reviewed file whose content changed before the author confirmed, even at the same size and time', async () => {
    const path = sourceFile('scan.png', await noisy(3000, 2000, 'png'));
    const row = await reviewOf(path);
    const seen = statSync(path);
    const changed = readFileSync(path);
    changed[changed.length - 20] ^= 0xff;
    writeFileSync(path, changed);
    utimesSync(path, seen.atime, seen.mtime);
    expect(statSync(path).size).toBe(seen.size);
    await expect(importAsset(temp('project'), path, [], undefined, { webCopy: true, fingerprint: row.fingerprint })).rejects.toThrow(/^scan\.png was not imported because it changed while it was being reviewed\. Add it again\./);
    // An unticked offer (added as it is) is held to what the review saw as well.
    await expect(importAsset(temp('project'), path, [], undefined, { webCopy: false, fingerprint: row.fingerprint })).rejects.toThrow(/changed while it was being reviewed/);
  });
});

/** A Business site opened in the Controller, with its sample pictures in use on its pages. */
/**
 * The starter photos as a project's library holds them, with all their copies. They are the same for every project
 * here, so they are imported once for the whole file and their files copied into each project: importing them again
 * for every test encodes the same nine WebP and AVIF sets each time, which under the whole suite's load on a small CI
 * runner left too little of a test's time for the work it is about.
 */
let starterDir: string | null = null;
let starterLibrary: Promise<Record<string, Awaited<ReturnType<typeof importAsset>>['record']>> | null = null;
const starterFiles = () =>
  (starterLibrary ??= (async () => {
    const dir = (starterDir = realpathSync(mkdtempSync(join(tmpdir(), 'so-photo-starter-'))));
    const records: Record<string, Awaited<ReturnType<typeof importAsset>>['record']> = {};
    for (const a of STARTER_ASSETS) {
      const { record } = await importAsset(dir, join('resources/starter-assets', a.source), []);
      records[a.id] = { ...record, id: a.id, name: a.name, altSuggestion: a.alt };
    }
    return records;
  })());
afterAll(() => {
  if (starterDir) rmSync(starterDir, { recursive: true, force: true });
});

async function openProject(): Promise<{ c: InstanceType<typeof Controller>; dir: string }> {
  const dir = temp('project');
  const state = createStarterState('business', 'Field Notes', true);
  const starter = await starterFiles();
  cpSync(starterDir!, dir, { recursive: true });
  for (const a of STARTER_ASSETS) state.assets.assets[a.id] = structuredClone(starter[a.id]);
  const created = await ProjectSession.create(dir, state);
  await created.close();
  const pkg = '{"name":"site","type":"module"}';
  writeFileSync(join(dir, 'package.json'), pkg);
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  mkdirSync(join(dir, 'node_modules/@sveltejs/kit'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@sveltejs/kit/package.json'), '{"name":"@sveltejs/kit"}');
  writeFileSync(join(dir, '.siteorigin/cache/deps.json'), JSON.stringify({ lockHash: sha('' + pkg), preparedAt: '2026-01-01T00:00:00.000Z' }));
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  return { c, dir };
}

describe('importing a reviewed batch', () => {
  it('adds a mixed batch in order, converting and copying what the author chose and naming what was refused', async () => {
    const { c } = await openProject();
    c.photoDecoder = canConvert ? heicDecoder() : { decode: async () => Promise.reject(new Error('no converter here')) };
    const heic = sourceFile('IMG_0042.heic', HEIC);
    const scan = sourceFile('scan.png', await noisy(3000, 2000, 'png'));
    const kept = sourceFile('kept.png', await noisy(3000, 2000, 'png'));
    const plain = sourceFile('plain.jpg', await sharp({ create: { width: 640, height: 480, channels: 3, background: '#406080' } }).jpeg().toBuffer());
    const notes = sourceFile('notes.md', Buffer.from('hello'));
    const review = await c.reviewImport([heic, scan, kept, plain, notes]);
    expect(review?.rows.map((r) => r.action)).toEqual(['convert', 'offer', 'offer', 'import', 'refuse']);
    expect(review?.rows[4].reason).toMatch(/^only JPEG, PNG, WebP, GIF, AVIF, SVG and HEIC images/);
    const files = review!.rows.filter((r) => r.action === 'convert' || r.action === 'offer').map((r) => ({ path: r.path, fingerprint: r.fingerprint!, webCopy: r.path !== kept }));
    const opening = c.openingKey!;
    const r = await c.importAssets(review!.paths, undefined, { opening, files });
    const assets = c.session!.state.assets.assets;
    expect(r.message).toMatch(/notes\.md: only JPEG, PNG, WebP, GIF, AVIF, SVG and HEIC images/);
    expect(r.ok).toBe(false);
    if (!canConvert) expect(r.message).toMatch(/IMG_0042\.heic was not imported because it could not be converted/);
    const added = r.assetIds.map((id) => assets[id]);
    expect(added.map((a) => [a.name, a.mime, a.width])).toEqual([...(canConvert ? [['IMG 0042', 'image/jpeg', 1200]] : []), ['scan', 'image/jpeg', 2560], ['kept', 'image/png', 3000], ['plain', 'image/jpeg', 640]]);
    // One step adds them all, and one Undo takes them all away.
    await c.session!.undo();
    expect(r.assetIds.some((id) => id in c.session!.state.assets.assets)).toBe(false);
  }, 60_000);

  it('refuses choices made in another opening of the project, and opens no chooser for an empty list', async () => {
    const { c } = await openProject();
    const scan = sourceFile('scan.png', await noisy(3000, 2000, 'png'));
    const before = Object.keys(c.session!.state.assets.assets).length;
    expect(await c.importAssets([scan], 'image', { opening: 'elsewhere#1', files: [] })).toMatchObject({ ok: false, message: 'The project was closed before the files could be added.' });
    expect(await c.importAssets([], 'image', { opening: c.openingKey!, files: [] })).toEqual({ ok: true, assetIds: [] });
    expect(Object.keys(c.session!.state.assets.assets)).toHaveLength(before);
  }, 60_000);

  it('gives every image one import adds the same time, keeps the order the files came in, and leaves an image already here as it was', async () => {
    const { c } = await openProject();
    const png = (background: string) => sharp({ create: { width: 40, height: 30, channels: 3, background } }).png().toBuffer();
    const seven = await png('#111111');
    const earlier = (await c.importAssets([sourceFile('Swatch 7.png', seven)])).assetIds[0];
    const earlierAt = c.session!.state.assets.assets[earlier].createdAt;
    // A clock that moves on every time it is read: each file of the import reads it at a different moment.
    let tick = 0;
    const clock = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => `2026-11-24T10:00:00.${String(++tick).padStart(3, '0')}Z`);
    let r: Awaited<ReturnType<typeof c.importAssets>>;
    let files: string[];
    try {
      // Two different pictures with the same file name, from two folders, the swatch already in the library, and one
      // file given twice.
      const three = sourceFile('Swatch 3.png', await png('#00aa00'));
      files = [sourceFile('Swatch 120.png', await png('#aa0000')), sourceFile('Swatch 7.png', seven), three, sourceFile('Swatch 120.png', await png('#0000aa')), three];
      r = await c.importAssets(files);
    } finally {
      clock.mockRestore();
    }
    expect(r.ok).toBe(true);
    const assets = c.session!.state.assets.assets;
    expect(r.assetIds).toHaveLength(4);
    expect(r.assetIds[1]).toBe(earlier);
    expect(r.assetIds.map((id) => assets[id].name)).toEqual(['Swatch 120', 'Swatch 7', 'Swatch 3', 'Swatch 120']);
    // The two Swatch 120s are the two pictures, in the order their files were given.
    expect(r.assetIds.map((id) => assets[id].hash)).toEqual(files!.slice(0, 4).map((f) => sha(readFileSync(f))));
    const added = r.assetIds.filter((id) => id !== earlier);
    expect(new Set(added.map((id) => assets[id].createdAt)).size).toBe(1);
    // One time for this import, not one for every import.
    expect(assets[added[0]].createdAt).toMatch(/^2026-11-24T10:00:00\.\d{3}Z$/);
    expect(assets[earlier].createdAt).toBe(earlierAt);
    // Undo takes the import away and Redo brings back the same records, time included.
    const records = added.map((id) => structuredClone(assets[id]));
    await c.session!.undo();
    expect(added.some((id) => id in c.session!.state.assets.assets)).toBe(false);
    await c.session!.redo();
    expect(added.map((id) => c.session!.state.assets.assets[id])).toEqual(records);
  }, 60_000);

  it('adds the same photo dropped twice at once as one asset', async () => {
    const { c } = await openProject();
    const photo = await noisy(1200, 900, 'jpeg');
    const [a, b] = await Promise.all([c.importAssets([sourceFile('one.jpg', photo)]), c.importAssets([sourceFile('two.jpg', photo)])]);
    expect(a.assetIds).toHaveLength(1);
    expect(b.assetIds).toEqual(a.assetIds);
  }, 60_000);
});

describe('importing a batch a few files at a time', () => {
  const fence = async (write: () => Promise<void>) => (await write(), true);
  const swatch = (background: string) => sharp({ create: { width: 40, height: 30, channels: 3, background } }).png().toBuffer();
  /** Reads of the files named, held back by `delays` ms each, counting how many are under way at once. */
  async function slowReads(delays: Record<string, number>) {
    const fsp = (await import('node:fs')).promises;
    const read = fsp.readFile.bind(fsp);
    const seen = { now: 0, most: 0 };
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (path: string, ...rest: unknown[]) => {
      const wait = delays[String(path)];
      if (wait === undefined) return (read as (...a: unknown[]) => Promise<Buffer>)(path, ...rest);
      seen.most = Math.max(seen.most, ++seen.now);
      try {
        await new Promise((r) => setTimeout(r, wait));
        return await (read as (...a: unknown[]) => Promise<Buffer>)(path, ...rest);
      } finally {
        seen.now--;
      }
    }) as typeof fsp.readFile);
    return { seen, restore: () => spy.mockRestore() };
  }

  it('stores the same picture given under two names once, named for the first file, even when the second is read first', async () => {
    const project = temp('project');
    const same = await swatch('#335577');
    const first = sourceFile('First.png', same);
    const second = sourceFile('Second.png', same);
    const other = sourceFile('Other.png', await swatch('#aa5500'));
    const reads = await slowReads({ [first]: 300, [second]: 10, [other]: 10 });
    let out;
    try {
      out = await importAssetBatch(project, [first, second, other].map((path) => ({ path, opts: {} })), [], fence, { parallel: 3, go: () => true });
    } finally {
      reads.restore();
    }
    // All three were read at once.
    expect(reads.seen.most).toBe(3);
    const [a, b, c] = out.map((o) => (o && 'record' in o ? o : null));
    expect([a?.existing, a?.record.name, a?.record.originalName]).toEqual([false, 'First', 'First.png']);
    expect([b?.existing, b?.record.id]).toEqual([true, a?.record.id]);
    expect([c?.existing, c?.record.name]).toEqual([false, 'Other']);
    expect(readdirSync(join(project, 'static', 'assets')).filter((f) => f.startsWith('second'))).toEqual([]);
  }, 60_000);

  it('counts an animation’s check, which decodes every frame, as the whole budget, and a still picture by its size', () => {
    const budget = MEDIA_PARALLEL * 16_000_000;
    // A WebP's extended header, with its flags: 0x02 says it moves, 0x10 that it has alpha.
    const vp8x = (flags: number) => {
      const b = Buffer.alloc(30);
      b.write('RIFF', 0, 'latin1');
      b.write('WEBP', 8, 'latin1');
      b.write('VP8X', 12, 'latin1');
      b[20] = flags;
      return b;
    };
    const size = { width: 300, height: 200 };
    expect(checkPixels(vp8x(0x02), 'image/webp', size)).toBe(budget);
    expect(checkPixels(vp8x(0x12), 'image/webp', size)).toBe(budget);
    expect(checkPixels(vp8x(0x10), 'image/webp', size)).toBe(60_000);
    expect(checkPixels(Buffer.from('GIF89a'), 'image/gif', size)).toBe(budget);
    expect(checkPixels(Buffer.alloc(30), 'image/png', size)).toBe(60_000);
    expect(checkPixels(Buffer.alloc(30), 'image/jpeg', { width: 4032, height: 3024 })).toBe(4032 * 3024);
  });

  it('lets the next file with the same bytes store them when the first could not, and starts no file once told to stop', async () => {
    const project = temp('project');
    const same = await swatch('#123456');
    const files = ['One.png', 'Two.png', 'Three.png'].map((n) => sourceFile(n, same));
    let writes = 0;
    // The first write is refused, as for a project closed meanwhile.
    const refusing = async (write: () => Promise<void>) => (++writes === 1 ? false : (await write(), true));
    const out = await importAssetBatch(project, files.map((path) => ({ path, opts: {} })), [], refusing, { parallel: 3, go: () => true });
    expect(out[0] && 'error' in out[0] && out[0].error.message).toMatch(/^One\.png was not imported because the project was closed/);
    const [two, three] = [out[1], out[2]].map((o) => (o && 'record' in o ? o : null));
    expect([two?.existing, two?.record.name]).toEqual([false, 'Two']);
    expect([three?.existing, three?.record.id]).toEqual([true, two?.record.id]);
    let asked = 0;
    const stopped = await importAssetBatch(temp('project'), files.map((path) => ({ path, opts: {} })), [], fence, { parallel: 2, go: () => ++asked <= 1 });
    expect(Array.from(stopped, (o) => (o ? ('record' in o ? 'stored' : 'error') : 'not started'))).toEqual(['stored', 'not started', 'not started']);
  }, 60_000);
});

/**
 * The time a test gets that adds a 3000 × 2000 noise photo to a project and makes a web-sized copy of it: the import's
 * own copies of the photo and the copy's, in JPEG, WebP and AVIF, are 4 to 9 CPU-seconds on a fast Mac, and the CI
 * runner (4 vCPUs shared by up to 6 test files) has taken five to six times as long.
 */
const LARGE_PHOTO_MS = 120_000;

describe('making a web-sized copy of a large library image', () => {
  it('shows the copy everywhere the image was used, in one step that can be undone, and keeps the original', async () => {
    const { c, dir } = await openProject();
    const big = await c.importAssets([sourceFile('big-hero.png', await noisy(3000, 2000, 'png'))]);
    expect(big.ok).toBe(true);
    const bigId = big.assetIds[0];
    expect((await c.session!.apply({ operations: [{ type: 'asset.update', assetId: bigId, description: 'Our front room', altSuggestion: 'The front room at dusk' }] }, { label: 'Describe', source: 'user' })).ok).toBe(true);
    const hero = STARTER_ASSETS[0].id;
    const used = assetUsages(c.session!.state)[hero];
    expect(used).toBeGreaterThan(0);
    expect((await c.session!.apply({ operations: [{ type: 'asset.replace', assetId: hero, withAssetId: bigId }] }, { label: 'Use big', source: 'user' })).ok).toBe(true);
    expect(await c.webCopyPlan(bigId)).toEqual({ format: 'JPEG', width: 2560, height: 1707 });
    expect(await c.makeWebCopy(bigId, { replace: true, opening: 'elsewhere#1' })).toMatchObject({ ok: false });
    const r = await c.makeWebCopy(bigId, { replace: true, opening: c.openingKey! });
    expect(r.ok).toBe(true);
    const assets = c.session!.state.assets.assets;
    const copy = assets[r.assetId!];
    expect(copy).toMatchObject({ name: 'big hero (web-sized)', mime: 'image/jpeg', width: 2560, height: 1707, description: 'Our front room', altSuggestion: 'The front room at dusk' });
    expectCopies(copy, 'jpg', [160, 480, 960, 1440], 2560);
    expect(existsSync(join(dir, copy.file))).toBe(true);
    const usage = assetUsages(c.session!.state);
    expect(usage[copy.id]).toBe(used);
    expect(usage[bigId] ?? 0).toBe(0);
    expect(assets[bigId]).toBeDefined();
    await c.session!.undo();
    expect(c.session!.state.assets.assets[copy.id]).toBeUndefined();
    expect(assetUsages(c.session!.state)[bigId]).toBe(used);
  }, LARGE_PHOTO_MS);

  it('puts back the files of a copy already in Assets before using it', async () => {
    const { c, dir } = await openProject();
    const bigId = (await c.importAssets([sourceFile('big.png', await noisy(3000, 2000, 'png'))])).assetIds[0];
    const first = await c.makeWebCopy(bigId, { replace: false, opening: c.openingKey! });
    const copy = c.session!.state.assets.assets[first.assetId!];
    unlinkSync(join(dir, copy.file));
    unlinkSync(join(dir, copy.variants![0].file));
    const again = await c.makeWebCopy(bigId, { replace: false, opening: c.openingKey! });
    expect(again).toMatchObject({ ok: true, assetId: copy.id });
    expect(sha(readFileSync(join(dir, copy.file)))).toBe(copy.hash);
    expect((await sharp(readFileSync(join(dir, copy.variants![0].file))).metadata()).width).toBe(copy.variants![0].width);
  }, LARGE_PHOTO_MS);

  it('keeps every use’s alt text when it uses a copy already in Assets, whatever that copy suggests', async () => {
    const { c } = await openProject();
    const bigId = (await c.importAssets([sourceFile('big.png', await noisy(3000, 2000, 'png'))])).assetIds[0];
    const describe = (assetId: string, altSuggestion: string) => c.session!.apply({ operations: [{ type: 'asset.update', assetId, altSuggestion }] }, { label: 'Describe', source: 'user' });
    expect((await describe(bigId, 'The front room at dusk')).ok).toBe(true);
    const first = await c.makeWebCopy(bigId, { replace: false, opening: c.openingKey! });
    expect((await describe(first.assetId!, 'Notes for the copy')).ok).toBe(true);
    expect((await c.session!.apply({ operations: [{ type: 'asset.replace', assetId: STARTER_ASSETS[0].id, withAssetId: bigId }] }, { label: 'Use big', source: 'user' })).ok).toBe(true);
    /** The alt text of every use of an image, in page order. */
    const altsOf = (id: string) => {
      const out: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== 'object') return;
        if ((v as { assetId?: unknown }).assetId === id) out.push(String((v as { alt?: unknown }).alt));
        Object.values(v).forEach(walk);
      };
      walk(c.session!.state.site.shell);
      walk(c.session!.state.pages);
      return out;
    };
    const before = altsOf(bigId);
    expect(before).toContain('The front room at dusk');
    const r = await c.makeWebCopy(bigId, { replace: true, opening: c.openingKey! });
    expect(r).toMatchObject({ ok: true, assetId: first.assetId });
    expect(altsOf(first.assetId!)).toEqual(before);
  }, LARGE_PHOTO_MS);

  it('answers both of Assets’ questions about a photo from one read, and again from none while its file is as it was (#1046)', async () => {
    const { c, dir } = await openProject();
    const id = (await c.importAssets([sourceFile('field.png', await noisy(3000, 2000, 'png'))])).assetIds[0];
    await c.copiesMade();
    const file = join(dir, c.session!.state.assets.assets[id].file);
    // Its stat stands for its bytes once the file has been left alone this long.
    c.session!.settleMs = 0;
    await new Promise((r) => setTimeout(r, 20));
    const opened = vi.spyOn(promises, 'open');
    const reads = () => opened.mock.calls.filter(([p]) => p === file).length;
    try {
      const [meta, plan] = await Promise.all([c.photoMetadata(id), c.webCopyPlan(id)]);
      expect(meta).toEqual(photoMetadata(readFileSync(file)));
      expect(plan).toEqual({ format: 'JPEG', width: 2560, height: 1707 });
      expect(reads()).toBe(1);
      // Shown again: the same answers, and nothing read.
      expect(await Promise.all([c.photoMetadata(id), c.webCopyPlan(id)])).toEqual([meta, plan]);
      expect(reads()).toBe(1);
      // Replaced outside the app by other bytes of the same size, its times put back: read again, and no longer the
      // picture the library recorded, so no copy is offered.
      const st = statSync(file);
      const other = readFileSync(file);
      other[other.length - 20] ^= 0xff;
      writeFileSync(file, other);
      utimesSync(file, st.atime, st.mtime);
      expect(await c.webCopyPlan(id)).toBeNull();
      expect(reads()).toBe(2);
      // A file still settling is read every time.
      c.session!.settleMs = 60_000;
      writeFileSync(file, readFileSync(file));
      await c.photoMetadata(id);
      await c.photoMetadata(id);
      expect(reads()).toBe(4);
    } finally {
      opened.mockRestore();
    }
  }, LARGE_PHOTO_MS);

  it('looks at a large photo in the media worker, which is sent no bytes of it, and answers its metadata though the worker fails (#1046)', async () => {
    const { c, dir } = await openProject();
    const photo = await noisy(3000, 2000, 'jpeg');
    const id = (await c.importAssets([sourceFile('field.jpg', photo)])).assetIds[0];
    await c.copiesMade();
    const file = join(dir, c.session!.state.assets.assets[id].file);
    // Nothing remembered by the file's stat, so every question is put to the worker, however long the import took.
    c.session!.settleMs = Infinity;
    later.requests = [];
    const [meta, plan] = await Promise.all([c.photoMetadata(id), c.webCopyPlan(id)]);
    expect(meta).toEqual(photoMetadata(readFileSync(file)));
    expect(plan).toEqual({ format: 'JPEG', width: 2560, height: 1707 });
    // One look for both questions, its copy made there: no picture crossed to the worker.
    expect(later.requests).toEqual([{ kind: 'library', bytes: 0, weighed: false }]);
    // The same picture under another record: the worker is told its copy was weighed, and the answer is the same.
    later.requests = [];
    const twin = { ...c.session!.state.assets.assets[id], id: 'a_twin', name: 'Twin' };
    expect((await c.session!.apply({ operations: [{ type: 'asset.add', asset: twin }] }, { label: 'Twin', source: 'user' })).ok).toBe(true);
    expect(await c.webCopyPlan('a_twin')).toEqual(plan);
    expect(later.requests).toEqual([{ kind: 'library', bytes: 0, weighed: true }]);
    // A worker that fails: both are answered from a read here, the copy already weighed for these bytes standing.
    later.failLibrary = true;
    try {
      writeFileSync(file, readFileSync(file));
      expect(await c.photoMetadata(id)).toEqual(meta);
      expect(await c.webCopyPlan(id)).toEqual(plan);
    } finally {
      later.failLibrary = false;
    }
  }, LARGE_PHOTO_MS);

  it('looks again at a large photo replaced while a look at it was under way, rather than give the old answers (#1046)', async () => {
    const { c, dir } = await openProject();
    const photo = await noisy(3000, 2000, 'jpeg');
    const id = (await c.importAssets([sourceFile('swap.jpg', photo)])).assetIds[0];
    await c.copiesMade();
    const file = join(dir, c.session!.state.assets.assets[id].file);
    // The same picture, now saying where it was taken, put in its place as an editor saves: a new file renamed over it.
    const xmp = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="Cape Town"/></rdf:RDF></x:xmpmeta>', 'utf8');
    const payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), xmp]);
    const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const placed = Buffer.concat([photo.subarray(0, 2), segment, photo.subarray(2)]);
    later.copyHeld = new Promise<void>((r) => (later.releaseCopy = r));
    const plan = c.webCopyPlan(id);
    expect(await c.photoMetadata(id)).toEqual(photoMetadata(photo));
    writeFileSync(`${file}.new`, placed);
    renameSync(`${file}.new`, file);
    // Asked again while the first look still holds its copy back: a look of its own, about the file now there (with one
    // worker slot it waits for the first look's copy, so that is let go before its answer is awaited).
    const again = c.photoMetadata(id);
    later.releaseCopy!();
    expect(await again).toMatchObject({ location: true });
    expect(await plan).toEqual({ format: 'JPEG', width: 2560, height: 1707 });
    // No longer the recorded picture: no copy is offered for it.
    expect(await c.webCopyPlan(id)).toBeNull();
  }, LARGE_PHOTO_MS);

  it('says what a large photo records as soon as the worker has read it, before its copy is made (#1046)', async () => {
    const { c, dir } = await openProject();
    const id = (await c.importAssets([sourceFile('later.jpg', await noisy(3000, 2000, 'jpeg'))])).assetIds[0];
    await c.copiesMade();
    const file = join(dir, c.session!.state.assets.assets[id].file);
    later.copyHeld = new Promise<void>((r) => (later.releaseCopy = r));
    later.requests = [];
    let planned = false;
    const plan = c.webCopyPlan(id).then((p) => ((planned = true), p));
    expect(await c.photoMetadata(id)).toEqual(photoMetadata(readFileSync(file)));
    expect(planned).toBe(false);
    later.releaseCopy!();
    expect(await plan).toEqual({ format: 'JPEG', width: 2560, height: 1707 });
    // Both answers came from that one look, not from a read here after the worker gave up on it.
    expect(later.requests).toEqual([{ kind: 'library', bytes: 0, weighed: false }]);
  }, LARGE_PHOTO_MS);

  it('never offers a lighter copy of its own web-sized copy, or of a photo a copy would hardly lighten', async () => {
    const { c } = await openProject();
    const bigId = (await c.importAssets([sourceFile('big.png', await noisy(3000, 2000, 'png'))])).assetIds[0];
    const made = await c.makeWebCopy(bigId, { replace: false, opening: c.openingKey! });
    const copy = c.session!.state.assets.assets[made.assetId!];
    // The copy is still large: noise does not compress.
    expect(copy.bytes).toBeGreaterThan(1_500_000);
    expect(await c.webCopyPlan(copy.id)).toEqual({ lighter: false });
    const before = c.session!.revision;
    expect(await c.makeWebCopy(copy.id, { replace: false, opening: c.openingKey! })).toEqual({ ok: false, message: 'A web-sized copy of big (web-sized) would be less than a third lighter, so it was left as it is.' });
    expect(c.session!.revision).toBe(before);
  }, LARGE_PHOTO_MS);

  it('offers no copy that saves less than a third, though it would be smaller', async () => {
    const { c } = await openProject();
    const photo = await sharp(await noisy(1400, 1000, 'png')).jpeg({ quality: 86 }).toBuffer();
    // As the copy would be made (JPEG at quality 82, the same size): smaller, but not by a third.
    const share = (await sharp(photo).jpeg({ quality: 82 }).toBuffer()).length / photo.length;
    expect(share).toBeGreaterThan(LIGHTER_SHARE);
    expect(share).toBeLessThan(1);
    const id = (await c.importAssets([sourceFile('grain.jpg', photo)])).assetIds[0];
    expect(await c.webCopyPlan(id)).toEqual({ lighter: false });
    expect(await c.makeWebCopy(id, { replace: false, opening: c.openingKey! })).toMatchObject({ ok: false, message: 'A web-sized copy of grain would be less than a third lighter, so it was left as it is.' });
  }, 60_000);

  it('offers nothing for a picture it cannot copy, and leaves an image alone when a copy would be no smaller', async () => {
    const { c } = await openProject();
    const gif = await c.importAssets([sourceFile('moving.gif', await sharp({ create: { width: 64, height: 48, channels: 3, background: '#000' } }).gif().toBuffer())]);
    expect(await c.webCopyPlan(gif.assetIds[0])).toBeNull();
    const tight = await c.importAssets([sourceFile('tight.jpg', await sharp(await noisy(1000, 800, 'jpeg')).jpeg({ quality: 20 }).toBuffer())]);
    expect(await c.webCopyPlan(tight.assetIds[0])).toEqual({ lighter: false });
    // The import's own copies land after it answers (#979): the copy refused below is what must change nothing.
    await c.copiesMade();
    const before = c.session!.revision;
    expect(await c.makeWebCopy(tight.assetIds[0], { replace: false, opening: c.openingKey! })).toEqual({ ok: false, message: 'A web-sized copy of tight would be less than a third lighter, so it was left as it is.' });
    expect(c.session!.revision).toBe(before);
  }, 60_000);
});

describe('photos usable before their copies are made (#979)', () => {
  /** Hold the copies imports make after their pictures land, until the returned function is called. */
  const hold = () => {
    let release!: () => void;
    later.held = new Promise<void>((r) => (release = r));
    return () => {
      later.held = null;
      release();
    };
  };
  afterEach(() => {
    later.held = null;
  });
  /** The copies a library file has in the project folder, by their names. */
  const copiesOnDisk = (dir: string, file: string) => readdirSync(join(dir, 'static/assets')).filter((f) => f.startsWith(`${file.split('/').pop()!.replace(/\.[a-z]+$/, '')}-`)).sort();

  it('answers once the photos have landed, shown from their own files, and gives them the copies an import always made with no step of their own', async () => {
    const { c, dir } = await openProject();
    const bytes = await noisy(2000, 1500, 'jpeg');
    const photo = sourceFile('harbour.jpg', bytes);
    const steps = c.session!.historyInfo().entries.length;
    const release = hold();
    let r: Awaited<ReturnType<typeof c.importAssets>>;
    try {
      r = await c.importAssets([photo]);
      expect(r.ok).toBe(true);
      const rec = c.session!.state.assets.assets[r.assetIds[0]];
      // In the project with its own file, and no copy yet.
      expect(rec).toMatchObject({ kind: 'image', name: 'harbour', width: 2000, height: 1500, copiesPending: true });
      expect(rec.variants).toBeUndefined();
      expect(readFileSync(join(dir, rec.file)).equals(bytes)).toBe(true);
      expect(copiesOnDisk(dir, rec.file)).toEqual([]);
      // Placed at once, a page shows it from its own file.
      expect((await c.session!.apply({ operations: [{ type: 'asset.replace', assetId: STARTER_ASSETS[0].id, withAssetId: rec.id }] }, { label: 'Use it', source: 'user' })).ok).toBe(true);
      const site = [...generateProject(c.session!.state, { instrument: false }).values()].join('\n');
      expect(site).toContain(rec.file.replace(/^static\//, ''));
      expect(site).not.toContain(`${rec.file.replace(/^static\/|\.jpg$/g, '')}-160w`);
    } finally {
      release();
    }
    await c.copiesMade();
    const rec = c.session!.state.assets.assets[r!.assetIds[0]];
    expect(rec.copiesPending).toBeUndefined();
    expectCopies(rec, 'jpg', [160, 480, 960, 1440], 2000);
    expect(copiesOnDisk(dir, rec.file)).toEqual(rec.variants!.map((v) => v.file.split('/').pop()).sort());
    // The very copies an import made before they came later: the same set, sizes and bytes.
    const eager = temp('eager');
    const { record: before } = await importAsset(eager, photo, []);
    expect(before.variants).toEqual(rec.variants);
    for (const v of rec.variants!) expect(readFileSync(join(dir, v.file)).equals(readFileSync(join(eager, v.file)))).toBe(true);
    // Two steps: the import and the placement. Undo takes both back, the image with its copies, and Redo brings them back.
    expect(c.session!.historyInfo().entries.length).toBe(steps + 2);
    expect(c.session!.historyInfo().entries.at(-2)?.label).toBe('Import image');
    expect((await c.session!.undo()).ok).toBe(true);
    expect((await c.session!.undo()).ok).toBe(true);
    expect(rec.id in c.session!.state.assets.assets).toBe(false);
    expect((await c.session!.redo()).ok).toBe(true);
    expect(c.session!.state.assets.assets[rec.id]).toEqual(rec);
  }, 60_000);

  it('makes the copies of a batch a few at a time, and gives them together', async () => {
    const { c } = await openProject();
    const photos = await Promise.all(Array.from({ length: 6 }, async (_, i) => sourceFile(`photo-${i}.jpg`, await noisy(1000 + i * 10, 750, 'jpeg'))));
    const release = hold();
    // Copies made so far are also given every few seconds while a batch is made: the clock stands still here, so how
    // long the copies take on a busy machine can never bring one of those in, and only the last is given.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const fills = vi.spyOn(c.session!, 'fillCopies');
    try {
      const asked = later.asked;
      const r = await c.importAssets(photos);
      const revision = c.session!.revision;
      expect(r.assetIds.every((id) => c.session!.state.assets.assets[id].copiesPending)).toBe(true);
      // Every photo waits its turn in the worker, a few at a time, with nothing else asked of it.
      await vi.waitFor(() => expect(later.asked - asked).toBe(Math.min(MEDIA_PARALLEL, photos.length)));
      release();
      await c.copiesMade();
      expect(later.asked - asked).toBe(photos.length);
      for (const id of r.assetIds) expect(c.session!.state.assets.assets[id].variants?.length).toBeGreaterThan(0);
      // Given together once the last is made: one fill carrying every photo, one change.
      expect(fills.mock.calls.map(([batch]) => batch.map((f) => f.assetId).sort())).toEqual([[...r.assetIds].sort()]);
      expect(c.session!.revision - revision).toBeLessThanOrEqual(2);
      expect(c.session!.historyInfo().entries.at(-1)?.label).toBe('Import 6 images');
    } finally {
      release();
      clock.mockRestore();
      fills.mockRestore();
    }
  }, 60_000);

  it('makes the copies a close left unmade when the project opens again, in the same window while the old ones finish', async () => {
    const { c, dir } = await openProject();
    const release = hold();
    const r = await c.importAssets([sourceFile('pier.jpg', await noisy(1200, 900, 'jpeg'))]);
    const id = r.assetIds[0];
    // The copies come back from the worker as the project closes: closing still ends, and leaves the image waiting.
    const closed = c.close();
    release();
    await closed;
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/assets.json'), 'utf8')).assets[id]).toMatchObject({ copiesPending: true });
    // Opened again while the closed opening's copies may still be in the worker: they are this opening's to make.
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await vi.waitFor(() => expect(c.session!.state.assets.assets[id].copiesPending).toBeUndefined(), { timeout: 30_000 });
    expectCopies(c.session!.state.assets.assets[id], 'jpg', [160, 480, 960], 1200);
    // Folded into the import's step, which Undo takes back whole.
    expect(c.session!.historyInfo().entries.at(-1)?.label).toBe('Import image');
  }, 60_000);

  it('keeps the copies written before the app stopped, and gives them to the image when the project opens again', async () => {
    const { c, dir } = await openProject();
    const bytes = await noisy(1200, 900, 'jpeg');
    // The app stops after the copies are written, before the image is given them.
    const stop = vi.spyOn(ProjectSession.prototype, 'fillCopies').mockRejectedValue(new Error('the app stopped'));
    const r = await c.importAssets([sourceFile('quay.jpg', bytes)]);
    await c.copiesMade();
    const id = r.assetIds[0];
    const rec = c.session!.state.assets.assets[id];
    expect(rec.copiesPending).toBe(true);
    const written = copiesOnDisk(dir, rec.file);
    expect(written.length).toBeGreaterThan(0);
    const before = new Map(written.map((f) => [f, statSync(join(dir, 'static/assets', f)).mtimeMs]));
    await c.close();
    stop.mockRestore();
    const again = new Controller(() => null);
    again.send = () => undefined;
    controllers.push(again);
    expect((await again.trustAndOpen(dir)).ok).toBe(true);
    await vi.waitFor(() => expect(again.session!.state.assets.assets[id].copiesPending).toBeUndefined(), { timeout: 30_000 });
    const filled = again.session!.state.assets.assets[id];
    expectCopies(filled, 'jpg', [160, 480, 960], 1200);
    // The very files written before, left as they were.
    expect(filled.variants!.map((v) => v.file.split('/').pop()).sort()).toEqual(written);
    for (const [f, at] of before) expect(statSync(join(dir, 'static/assets', f)).mtimeMs).toBe(at);
    expect((await again.session!.undo()).ok).toBe(true);
    expect(id in again.session!.state.assets.assets).toBe(false);
  }, 60_000);

  it('makes no copies of a file that is no longer the picture recorded, and lands no picture that cannot be decoded', async () => {
    const dir = temp('project');
    const bytes = await noisy(800, 600, 'jpeg');
    const { record } = await importAsset(dir, sourceFile('gone.jpg', bytes), [], undefined, { copiesLater: true });
    expect(record).toMatchObject({ copiesPending: true });
    expect(record.variants).toBeUndefined();
    const fence = async (write: () => Promise<void>) => (await write(), true);
    writeFileSync(join(dir, record.file), await noisy(800, 600, 'jpeg'));
    expect(await makePendingCopies(dir, record, fence)).toBeNull();
    unlinkSync(join(dir, record.file));
    expect(await makePendingCopies(dir, record, fence)).toBeNull();
    writeFileSync(join(dir, record.file), bytes);
    expectCopies({ variants: (await makePendingCopies(dir, record, fence))! }, 'jpg', [160, 480], 800);
    // A picture whose data cannot be decoded is refused before it lands, as when its copies were made first.
    const png = Buffer.from(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#808080' } }).png().toBuffer());
    for (let i = 8; i < png.length; ) {
      const len = png.readUInt32BE(i);
      if (png.toString('latin1', i + 4, i + 8) === 'IDAT') {
        png[i + 8] = 0x00;
        png[i + 9] = 0x00;
        png.writeUInt32BE(crc32(png.subarray(i + 4, i + 8 + len)), i + 8 + len);
        break;
      }
      i += 12 + len;
    }
    const project = temp('project');
    await expect(importAsset(project, sourceFile('broken.png', png), [], undefined, { copiesLater: true })).rejects.toThrow(/^broken\.png was not imported because it is damaged/);
    expect(existsSync(join(project, 'static'))).toBe(false);
  }, 60_000);
});

