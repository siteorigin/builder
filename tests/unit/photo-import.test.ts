/**
 * Phone and camera photos (issue #230). A HEIC photo becomes an upright JPEG copy where the platform can decode it,
 * and is refused with a specific way forward where it can't. A large JPEG or PNG can be added, or replaced in the
 * library, as a web-sized copy. The review says what each file will become before anything is written, and the
 * author's own files are only ever read.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

/** The media worker, run in this process by the code the real worker runs. */
class InlineMediaWorker extends EventEmitter {
  postMessage(m: VariantRequest) {
    void import('../../src/main/project/image-variants').then(({ handleVariantRequest }) => handleVariantRequest(m)).then((r) => this.emit('message', r));
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

const { importAsset, noConverterReason, reviewImportFile, isOpaquePicture, stopMediaWorker, webCopySize, WEB_EDGE } = await import('../../src/main/project/assets');
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
    // An ordinary photo is never read for the review: just its name and size.
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    expect(await reviewOf(sourceFile('ordinary.jpg', small))).toMatchObject({ action: 'import', bytes: small.length });
    expect((await reviewOf(sourceFile('ordinary.jpg', small))).format).toBeUndefined();
    // A large picture of a kind that gets no web copy (WebP, GIF, SVG) imports as it is.
    expect((await reviewOf(sourceFile('big.webp', Buffer.alloc(2_000_000)))).action).toBe('import');
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
  }, 30_000);

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
    const path = sourceFile('portrait-rotated.heic', HEIC);
    const { record, existing } = await importAsset(project, path, [], undefined, { decoder: heicDecoder() });
    expect(existing).toBe(false);
    expect(record).toMatchObject({ name: 'portrait rotated', mime: 'image/jpeg', width: 1200, height: 1600, kind: 'image' });
    expect(record.file).toMatch(/^static\/assets\/portrait-rotated-[0-9a-f]{8}\.jpg$/);
    expect(record.variants?.map((v) => v.width)).toEqual([160, 480, 960]);
    const stored = readFileSync(join(project, record.file));
    expect(sha(stored)).toBe(record.hash);
    await expectUpright(stored, 1200, 1600);
    // Upright pixels, so no orientation, location or device details travel with the copy.
    expect(photoMetadata(stored)).toMatchObject({ location: false, device: false });
    for (const v of record.variants!) await expectUpright(readFileSync(join(project, v.file)), v.width, Math.round((v.width * 4) / 3));
    expect(readFileSync(path).equals(HEIC)).toBe(true);
    // The same photo again is the same copy, so it is the same asset.
    const again = await importAsset(project, sourceFile('again.heic', HEIC), [record], undefined, { decoder: heicDecoder() });
    expect(again).toMatchObject({ existing: true, record: { id: record.id } });
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
    expect(record).toMatchObject({ name: 'field visit', mime: 'image/jpeg', width: 2560, height: 1920 });
    expect(record.bytes).toBeLessThan(original.length);
    expect(record.variants?.map((v) => v.width)).toEqual([160, 480, 960, 1440]);
    const stored = readFileSync(join(project, record.file));
    const credits = cleanPhoto(stored)?.credits.tiff?.toString('latin1');
    expect(credits).toContain('Ana Field');
    expect(credits).toContain('Field Studio 2026');
    expect(readFileSync(path).equals(original)).toBe(true);
    // Without the choice the original is stored, as before.
    expect((await importAsset(temp('project'), path, [])).record).toMatchObject({ width: 4000, hash: sha(original) });
  });

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
    expect(record.mime).toBe('image/jpeg');
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
  });

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
async function openProject(): Promise<{ c: InstanceType<typeof Controller>; dir: string }> {
  const dir = temp('project');
  const state = createStarterState('business', 'Field Notes', true);
  for (const a of STARTER_ASSETS) {
    const { record } = await importAsset(dir, join('resources/starter-assets', a.source), []);
    state.assets.assets[a.id] = { ...record, id: a.id, name: a.name, altSuggestion: a.alt };
  }
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
  });

  it('refuses choices made in another opening of the project, and opens no chooser for an empty list', async () => {
    const { c } = await openProject();
    const scan = sourceFile('scan.png', await noisy(3000, 2000, 'png'));
    const before = Object.keys(c.session!.state.assets.assets).length;
    expect(await c.importAssets([scan], 'image', { opening: 'elsewhere#1', files: [] })).toMatchObject({ ok: false, message: 'The project was closed before the files could be added.' });
    expect(await c.importAssets([], 'image', { opening: c.openingKey!, files: [] })).toEqual({ ok: true, assetIds: [] });
    expect(Object.keys(c.session!.state.assets.assets)).toHaveLength(before);
  });

  it('adds the same photo dropped twice at once as one asset', async () => {
    const { c } = await openProject();
    const photo = await noisy(1200, 900, 'jpeg');
    const [a, b] = await Promise.all([c.importAssets([sourceFile('one.jpg', photo)]), c.importAssets([sourceFile('two.jpg', photo)])]);
    expect(a.assetIds).toHaveLength(1);
    expect(b.assetIds).toEqual(a.assetIds);
  });
});

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
    expect(copy.variants?.map((v) => v.width)).toEqual([160, 480, 960, 1440]);
    expect(existsSync(join(dir, copy.file))).toBe(true);
    const usage = assetUsages(c.session!.state);
    expect(usage[copy.id]).toBe(used);
    expect(usage[bigId] ?? 0).toBe(0);
    expect(assets[bigId]).toBeDefined();
    await c.session!.undo();
    expect(c.session!.state.assets.assets[copy.id]).toBeUndefined();
    expect(assetUsages(c.session!.state)[bigId]).toBe(used);
  });

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
  });

  it('offers nothing for a picture it cannot copy, and leaves an image alone when a copy would be no smaller', async () => {
    const { c } = await openProject();
    const gif = await c.importAssets([sourceFile('moving.gif', await sharp({ create: { width: 64, height: 48, channels: 3, background: '#000' } }).gif().toBuffer())]);
    expect(await c.webCopyPlan(gif.assetIds[0])).toBeNull();
    const tight = await c.importAssets([sourceFile('tight.jpg', await sharp(await noisy(1000, 800, 'jpeg')).jpeg({ quality: 20 }).toBuffer())]);
    const before = c.session!.revision;
    expect(await c.makeWebCopy(tight.assetIds[0], { replace: false, opening: c.openingKey! })).toEqual({ ok: false, message: 'A web-sized copy of tight would be no smaller, so it was left as it is.' });
    expect(c.session!.revision).toBe(before);
  });
});
