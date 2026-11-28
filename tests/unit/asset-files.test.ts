/**
 * Media the site cannot use (issue #48). An image file no browser can show is refused at import with its name and a
 * reason, while the good files of the same batch still arrive. A library image whose files leave the project folder
 * keeps its uses; Project health and Assets name it, the author can locate the file or make the copies again, and a
 * website export stops naming it instead of failing in the build.
 */
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

const { importAsset, importAssetBatch, locateAssetFile, restoreAssetFiles, stopMediaWorker } = await import('../../src/main/project/assets');
const { findMissingAssetFiles, missingFileDiagnostics } = await import('../../src/main/project/asset-files');
const { isReadable } = await import('../../src/main/project/image-variants');
const { imageProblem } = await import('../../src/main/project/media');
const { missingAssetsStop, missingSourceWarnings, missingUnusedWarnings, missingWebsiteAssets } = await import('../../src/main/export');
const { ProjectSession } = await import('../../src/main/project/session');
const { Controller } = await import('../../src/main/controller');
const { applyOperations, assetUsages } = await import('@engine/apply');
const { createStarterState, STARTER_ASSETS } = await import('@catalogue/starters');
const { validateOperation } = await import('@shared/ops');
const { sha } = await import('../../src/main/project/fsutil');
const { altChecks } = await import('../../src/renderer/src/lib/alt-review');
type AssetRecord = import('@shared/types').AssetRecord;
type ProjectState = import('@shared/types').ProjectState;

const dirs: string[] = [];
const temp = (name = 'files') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-asset-${name}-`)));
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

const picture = (format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif', width = 64, height = 48, colour = { r: 200, g: 120, b: 40 }) => {
  const img = sharp({ create: { width, height, channels: 3, background: colour } });
  return (format === 'jpeg' ? img.jpeg() : format === 'png' ? img.png() : format === 'webp' ? img.webp() : format === 'gif' ? img.gif() : img.avif()).toBuffer();
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

/** Write `data` as `name` in a fresh folder, and return its path. */
function sourceFile(name: string, data: Buffer): string {
  const src = temp('source');
  writeFileSync(join(src, name), data);
  return join(src, name);
}

/** Write `data` as `name` in a fresh folder and import it into a fresh project. */
const importFile = (name: string, data: Buffer, project = temp('project')) => importAsset(project, sourceFile(name, data), []);

/** A 1x1 PNG whose chunks are all whole and correctly checksummed, but whose image data no decoder can unpack. */
async function damagedPng(): Promise<Buffer> {
  const png = Buffer.from(await picture('png', 1, 1));
  for (let i = 8; i < png.length; ) {
    const len = png.readUInt32BE(i);
    if (png.toString('latin1', i + 4, i + 8) === 'IDAT') {
      // A zlib header naming no compression method there is.
      png[i + 8] = 0x00;
      png[i + 9] = 0x00;
      png.writeUInt32BE(crc32(png.subarray(i + 4, i + 8 + len)), i + 8 + len);
      return png;
    }
    i += 12 + len;
  }
  throw new Error('no IDAT');
}

describe('importing a picture no browser can show', () => {
  it('refuses an empty file, naming it', async () => {
    await expect(importFile('empty.jpg', Buffer.alloc(0))).rejects.toThrow(/^empty\.jpg was not imported because the file is empty\./);
  });

  it('refuses a photo that was cut short, at any point', async () => {
    const jpeg = await picture('jpeg', 400, 300);
    for (const at of [jpeg.length - 2, Math.floor(jpeg.length / 2), 300, 20]) await expect(importFile('cut.jpg', jpeg.subarray(0, at)), `JPEG cut at ${at}`).rejects.toThrow(/^cut\.jpg was not imported because it is incomplete/);
    const png = await picture('png', 400, 300);
    for (const at of [png.length - 1, png.length - 20, 40]) await expect(importFile('cut.png', png.subarray(0, at)), `PNG cut at ${at}`).rejects.toThrow(/^cut\.png .*incomplete/);
    for (const format of ['gif', 'webp', 'avif'] as const) {
      const whole = await picture(format, 400, 300);
      await expect(importFile(`cut.${format}`, whole.subarray(0, whole.length - 10)), format).rejects.toThrow(/incomplete/);
    }
  });

  it('refuses a file whose contents are not the format its name says', async () => {
    await expect(importFile('notes.png', Buffer.from('just some text, not a picture'))).rejects.toThrow(/^notes\.png was not imported because it is not a PNG image/);
    await expect(importFile('photo.png', await picture('jpeg'))).rejects.toThrow(/not a PNG/);
  });

  it('refuses an SVG cut short, which would otherwise import as a blank picture', async () => {
    const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n';
    await expect(importFile('cut.svg', Buffer.from(svg.slice(0, svg.indexOf('<rect'))))).rejects.toThrow(/^cut\.svg was not imported because it is incomplete/);
    expect((await importFile('whole.svg', Buffer.from(svg))).record.mime).toBe('image/svg+xml');
    expect((await importFile('closed.svg', Buffer.from('<!-- logo --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'))).record.mime).toBe('image/svg+xml');
    const doctype = '\ufeff<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><!-- a --><!-- b -->';
    expect((await importFile('doctype.svg', Buffer.from(`${doctype}<svg xmlns="http://www.w3.org/2000/svg" data-x="a>b" viewBox="0 0 1 1"/>`))).record.mime).toBe('image/svg+xml');
    expect((await importFile('nested.svg', Buffer.from('<SVG xmlns="http://www.w3.org/2000/svg"><svg><rect/></svg></SVG>\n<!-- end -->'))).record.mime).toBe('image/svg+xml');
    // What a comment or a stylesheet holds is not markup, whatever it looks like.
    const css = '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[ /* <!-- old hack */ rect { fill: red } ]]></style><!-- see <?xml-stylesheet in the docs --><rect width="1"/></svg>';
    expect((await importFile('styled.svg', Buffer.from(css))).record.mime).toBe('image/svg+xml');
    // A closing tag inside a comment, or one that closes an inner SVG, does not finish the file.
    await expect(importFile('comment.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><!-- </svg> --><rect width="1"'))).rejects.toThrow(/incomplete/);
    await expect(importFile('inner.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><svg><rect/></svg><rect'))).rejects.toThrow(/incomplete/);
    await expect(importFile('child.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/><svg viewBox="0 0 1 1"/><rect'))).rejects.toThrow(/incomplete/);
    await expect(importFile('open-comment.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/><!-- unfinished</svg>'))).rejects.toThrow(/incomplete/);
    // Many comments before a cut-short root are read in a moment.
    const started = Date.now();
    await expect(importFile('comments.svg', Buffer.from(`${'<!-- x -->'.repeat(5000)}<svg xmlns="http://www.w3.org/2000/svg"`))).rejects.toThrow();
    await expect(importFile('openers.svg', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<!--'.repeat(200_000)}`))).rejects.toThrow(/incomplete/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('writes nothing once the project may no longer be written to', async () => {
    const project = temp('project');
    const closed = async () => false;
    await expect(importAsset(project, sourceFile('late.png', await picture('png')), [], closed)).rejects.toThrow(/^late\.png was not imported because the project was closed, or another app took it over/);
    const { dir, record, source } = await photoProject();
    rmSync(join(dir, 'static/assets'), { recursive: true });
    await expect(locateAssetFile(dir, record, source, closed)).rejects.toThrow(/was not restored because the project was closed/);
    await expect(locateAssetFile(dir, record, sourceFile('other.png', await picture('png', 900, 600)), closed)).rejects.toThrow(/can't be used because the project was closed/);
    expect(existsSync(join(project, 'static'))).toBe(false);
    expect(existsSync(join(dir, 'static/assets'))).toBe(false);
  });

  it('never writes through an assets folder that links out of the project', async () => {
    const project = temp('project');
    const elsewhere = temp('elsewhere');
    mkdirSync(join(project, 'static'));
    symlinkSync(elsewhere, join(project, 'static/assets'));
    await expect(importFile('photo.png', await picture('png'), project)).rejects.toThrow(/escapes the project/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a picture whose data cannot be decoded, before writing anything', async () => {
    const png = await damagedPng();
    expect(imageProblem(png, 'image/png')).toBeNull();
    expect(await isReadable(png)).toBe(false);
    const project = temp('project');
    await expect(importFile('broken.png', png, project)).rejects.toThrow(/^broken\.png was not imported because it is damaged/);
    expect(existsSync(join(project, 'static'))).toBe(false);
  });

  it('still imports every readable format, a small still one with only its WebP and AVIF copies', async () => {
    for (const [name, format, ext] of [['a.jpg', 'jpeg', 'jpg'], ['b.png', 'png', 'png'], ['c.webp', 'webp', 'webp'], ['e.avif', 'avif', 'avif']] as const) {
      const { record } = await importFile(name, await picture(format));
      expect(record, name).toMatchObject({ kind: 'image', width: 64, height: 48 });
      // No smaller copy, but the same size in the formats a page offers first.
      expectCopies(record, ext, [], 64);
    }
    // A GIF may move: it is left to the browser as it is.
    const gif = (await importFile('d.gif', await picture('gif'))).record;
    expect(gif).toMatchObject({ kind: 'image', width: 64, height: 48 });
    expect(gif.variants).toBeUndefined();
    const { record } = await importFile('f.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'));
    expect(record).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    // A WebP gets smaller WebP copies, the original serving its full width.
    const big = await importFile('wide.webp', await picture('webp', 2000, 1000));
    expect(big.record).toMatchObject({ width: 2000, height: 1000 });
    expectCopies(big.record, 'webp', [160, 480, 960, 1440], 2000);
    expect(big.record.variants!.map((v) => v.file).filter((f) => f.endsWith('-2000w.webp'))).toEqual([]);
  });

  it('accepts every picture bundled with the Business starter, which new projects import', async () => {
    for (const a of STARTER_ASSETS) expect(imageProblem(readFileSync(join('resources/starter-assets', a.source)), 'image/jpeg'), a.source).toBeNull();
  });

  it('keeps the good files of a batch while naming each refused one', async () => {
    const { c, dir } = await openProject();
    const good = sourceFile('good.png', await picture('png'));
    const r = await c.importAssets([sourceFile('empty.jpg', Buffer.alloc(0)), good, sourceFile('cut.png', (await picture('png')).subarray(0, 30))]);
    expect(r.ok).toBe(false);
    expect(r.assetIds).toHaveLength(1);
    expect(c.session!.state.assets.assets[r.assetIds[0]]).toMatchObject({ name: 'good' });
    expect(r.message).toMatch(/empty\.jpg was not imported because the file is empty\..*cut\.png was not imported because it is incomplete/);
    expect(existsSync(join(dir, c.session!.state.assets.assets[r.assetIds[0]].file))).toBe(true);
  }, 60_000);
});

/** A project folder holding one imported photo big enough for smaller copies. */
async function photoProject(): Promise<{ dir: string; record: AssetRecord; source: string }> {
  const dir = temp('project');
  const source = sourceFile('reading-nook.jpg', await picture('jpeg', 1200, 800));
  const { record } = await importAsset(dir, source, []);
  return { dir, record, source };
}

describe('finding image files that left the project folder', () => {
  it('reports a missing original, missing copies, or both, and nothing for files that are there', async () => {
    const { dir, record } = await photoProject();
    // A flat colour picture: its AVIF set is the smaller.
    expectCopies(record, 'jpg', [160, 480, 960], 1200, true);
    const assets = { [record.id]: record };
    expect(await findMissingAssetFiles(dir, assets)).toEqual([]);
    const original = readFileSync(join(dir, record.file));
    unlinkSync(join(dir, record.file));
    expect(await findMissingAssetFiles(dir, assets)).toEqual([{ assetId: record.id, original: true, variants: [], damaged: [] }]);
    writeFileSync(join(dir, record.file), original);
    unlinkSync(join(dir, record.variants![1].file));
    expect(await findMissingAssetFiles(dir, assets)).toEqual([{ assetId: record.id, original: false, variants: [record.variants![1].file], damaged: [] }]);
    unlinkSync(join(dir, record.file));
    expect(await findMissingAssetFiles(dir, assets)).toEqual([{ assetId: record.id, original: true, variants: [record.variants![1].file], damaged: [] }]);
    rmSync(join(dir, 'static/assets'), { recursive: true });
    expect((await findMissingAssetFiles(dir, assets))[0]).toEqual({ assetId: record.id, original: true, variants: record.variants!.map((v) => v.file), damaged: [] });
  });

  it('does not count a folder or a link in place of a file, and reports a font or a picture without copies by its file alone', async () => {
    const { dir, record } = await photoProject();
    const gif = (await importFile('logo.gif', await picture('gif'), dir)).record;
    const font = { ...gif, id: 'a_font', kind: 'font' as const, file: 'static/assets/gone-00000000.woff2' };
    const assets = { [record.id]: record, [gif.id]: gif, [font.id]: font };
    unlinkSync(join(dir, record.file));
    mkdirSync(join(dir, record.file));
    const outside = sourceFile('elsewhere.jpg', await picture('jpeg'));
    unlinkSync(join(dir, record.variants![0].file));
    symlinkSync(outside, join(dir, record.variants![0].file));
    expect(await findMissingAssetFiles(dir, assets)).toEqual([
      { assetId: record.id, original: true, variants: [record.variants![0].file], damaged: [] },
      { assetId: font.id, original: true, variants: [], damaged: [] }
    ]);
    unlinkSync(join(dir, gif.file));
    expect((await findMissingAssetFiles(dir, assets)).map((m) => m.assetId)).toEqual([record.id, gif.id, font.id]);
  });

  it('names the image in Project health, as a problem while the site uses it, without mentioning how often', () => {
    const state = createStarterState('business', 'Health', true);
    for (const a of STARTER_ASSETS) state.assets.assets[a.id] = { id: a.id, name: a.name, file: `static/assets/${a.id.slice(2)}-00000000.jpg`, mime: 'image/jpeg', bytes: 1, hash: a.id, kind: 'image', createdAt: 'now' };
    const missing = [
      { assetId: 'a_reading', original: true, variants: ['static/assets/reading-00000000-480w.jpg', 'static/assets/reading-00000000-960w.jpg'], damaged: [] },
      { assetId: 'a_person3', original: false, variants: ['static/assets/person3-00000000-480w.jpg'], damaged: [] }
    ];
    // Used with only a copy gone is a problem; unused with the original gone is a warning.
    const unused = structuredClone(state);
    walkImages(unused, (v) => v.assetId === 'a_reading' && (v.assetId = null));
    expect(assetUsages(unused).a_reading).toBeUndefined();
    expect(missingFileDiagnostics(unused, missing)).toEqual([
      { severity: 'warning', code: 'ASSET_FILE_MISSING', message: 'Reading nook is missing its original file and 2 smaller copies in the project folder. Locate the file or choose another image in Assets.', owner: { kind: 'asset', id: 'a_reading' } },
      { severity: 'error', code: 'ASSET_FILE_MISSING', message: 'Portrait 3 is missing a smaller copy in the project folder. Make the copies again in Assets.', owner: { kind: 'asset', id: 'a_person3' } }
    ]);
    // A second use changes nothing in what Project health says.
    const twice = structuredClone(state);
    twice.site.socialImage = 'a_reading';
    expect([assetUsages(state).a_reading, assetUsages(twice).a_reading]).toEqual([1, 2]);
    expect(missingFileDiagnostics(twice, missing)).toEqual(missingFileDiagnostics(state, missing));
    expect(missingFileDiagnostics(state, missing)[0].severity).toBe('error');
  });
});

/** Every image value in the state (`{ assetId, alt }`), for a test to change in place. */
function walkImages(state: ProjectState, fn: (v: { assetId: string | null; alt?: string }) => unknown) {
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    if ('assetId' in v) fn(v as { assetId: string | null });
    Object.values(v).forEach(visit);
  };
  visit(state.pages);
  visit(state.site.shell);
  visit(state.components);
}

describe('the original file name of an image', () => {
  it('is the name of the file as it was on disk, beside a display name tidied from it', async () => {
    const { record } = await importFile('team_photo-final_v2.jpg', await picture('jpeg'));
    expect(record).toMatchObject({ kind: 'image', name: 'team photo final v2', originalName: 'team_photo-final_v2.jpg' });
    let s = createStarterState('blank', 'Names', false);
    s = applyOperations(s, [{ type: 'asset.add', asset: record }]).state;
    s = applyOperations(s, [{ type: 'asset.update', assetId: record.id, name: 'Team' }]).state;
    expect(s.assets.assets[record.id]).toMatchObject({ name: 'Team', originalName: 'team_photo-final_v2.jpg' });
  });

  it('follows a different located picture, through the relink', async () => {
    const { dir, record } = await photoProject();
    unlinkSync(join(dir, record.file));
    const r = await locateAssetFile(dir, record, sourceFile('New_Nook-2.PNG', await picture('png', 900, 600)));
    expect(r.same).toBe(false);
    if (r.same) return;
    let s = createStarterState('blank', 'Names', false);
    s = applyOperations(s, [{ type: 'asset.add', asset: record }]).state;
    s = applyOperations(s, [{ type: 'asset.relink', assetId: record.id, ...r.stored }]).state;
    expect(s.assets.assets[record.id]).toMatchObject({ name: record.name, originalName: 'New_Nook-2.PNG' });
  });
});

describe('bringing missing files back', () => {
  it('puts the same picture back where the library expects it, with its copies, under its recorded names', async () => {
    const { dir, record, source } = await photoProject();
    const original = readFileSync(join(dir, record.file));
    rmSync(join(dir, 'static/assets'), { recursive: true });
    // Found again under another name: what matters is that it is the same picture.
    const renamed = sourceFile('IMG_2041.JPG', readFileSync(source));
    const r = await locateAssetFile(dir, record, renamed);
    // Nothing about the record changes, so it keeps the name it was added under.
    expect(r).toEqual({ same: true, written: [record.file, ...record.variants!.map((v) => v.file)], failed: [] });
    expect(readFileSync(join(dir, record.file)).equals(original)).toBe(true);
    for (const v of record.variants!) expect((await sharp(join(dir, v.file)).metadata()).width).toBe(v.width);
    expect(await findMissingAssetFiles(dir, { [record.id]: record })).toEqual([]);
  });

  it('stores a different picture as an import would, for the record to point at', async () => {
    const { dir, record } = await photoProject();
    unlinkSync(join(dir, record.file));
    const other = await picture('png', 1000, 500, { r: 10, g: 90, b: 200 });
    const r = await locateAssetFile(dir, record, sourceFile('new-nook.png', other));
    expect(r.same).toBe(false);
    if (r.same) return;
    expect(r.stored).toMatchObject({ mime: 'image/png', width: 1000, height: 500, hash: sha(other), bytes: other.length });
    expect(r.stored.file).toMatch(/^static\/assets\/new-nook-[0-9a-f]{8}\.png$/);
    expectCopies(r.stored, 'png', [160, 480], 1000);
    for (const f of [r.stored.file, ...r.stored.variants!.map((v) => v.file)]) expect(existsSync(join(dir, f))).toBe(true);
  });

  it('tells pictures apart by their content, not their format', async () => {
    const { dir, record } = await photoProject();
    unlinkSync(join(dir, record.file));
    const r = await locateAssetFile(dir, record, sourceFile('reading-nook.jpg', await picture('jpeg', 1200, 800, { r: 1, g: 2, b: 3 })));
    expect(r.same).toBe(false);
    if (!r.same) expect(r.stored.file).not.toBe(record.file);
    expect(existsSync(join(dir, record.file))).toBe(false);
  });

  it('refuses a located file that is not a usable picture, writing nothing', async () => {
    const { dir, record } = await photoProject();
    rmSync(join(dir, 'static/assets'), { recursive: true });
    await expect(locateAssetFile(dir, record, sourceFile('nook.png', await damagedPng()))).rejects.toThrow(/^nook\.png can't be used because it is damaged/);
    await expect(locateAssetFile(dir, record, sourceFile('nook.jpg', Buffer.alloc(0)))).rejects.toThrow(/^nook\.jpg can't be used because the file is empty/);
    await expect(locateAssetFile(dir, record, sourceFile('nook.woff2', Buffer.from('wOF2')))).rejects.toThrow(/not an image/);
    expect(existsSync(join(dir, 'static/assets'))).toBe(false);
  });

  it('makes missing copies again at the widths the library lists, even ones a new import would not make', async () => {
    const dir = temp('project');
    const photo = await picture('jpeg', 1000, 600);
    const { record } = await importAsset(dir, sourceFile('wide.jpg', photo), []);
    // Imported by an older version, which also made a 960px copy of a 1000px picture.
    const stem = record.file.replace(/\.jpg$/, '');
    expectCopies(record, 'jpg', [160, 480], 1000);
    const older: AssetRecord = { ...record, variants: [{ width: 480, file: `${stem}-480w.jpg` }, { width: 960, file: `${stem}-960w.jpg` }] };
    const r = await restoreAssetFiles(dir, older);
    expect(r).toEqual({ written: [`${stem}-960w.jpg`], failed: [] });
    expect((await sharp(join(dir, `${stem}-960w.jpg`)).metadata()).width).toBe(960);
    // Copies already there are left alone.
    expect(await restoreAssetFiles(dir, older)).toEqual({ written: [], failed: [] });
  });

  it('makes again only the missing copies, each in the format its name says, even two of one width', async () => {
    const { dir, record } = await photoProject();
    const at480 = record.variants!.filter((v) => v.width === 480);
    expect(at480.map((v) => v.file.split('.').pop())).toEqual(['jpg', 'webp', ...(widthsIn(record, 'avif').length ? ['avif'] : [])]);
    const [jpg, webp] = at480;
    const kept = Object.fromEntries(record.variants!.map((v) => [v.file, readFileSync(join(dir, v.file))]));
    unlinkSync(join(dir, jpg.file));
    unlinkSync(join(dir, webp.file));
    expect(await restoreAssetFiles(dir, record)).toEqual({ written: [jpg.file, webp.file], failed: [] });
    expect(await sharp(join(dir, jpg.file)).metadata()).toMatchObject({ format: 'jpeg', width: 480 });
    expect(await sharp(join(dir, webp.file)).metadata()).toMatchObject({ format: 'webp', width: 480 });
    // The same bytes the import made, and every other copy left as it was.
    for (const [file, bytes] of Object.entries(kept)) expect(readFileSync(join(dir, file)).equals(bytes), file).toBe(true);
  });

  it('leaves a copy in a format it cannot make alone while it is there, and says so once it is gone', async () => {
    const { dir, record } = await photoProject();
    const gif = `${record.file.replace(/\.jpg$/, '')}-480w.gif`;
    writeFileSync(join(dir, gif), 'GIF89a');
    const odd: AssetRecord = { ...record, variants: [...record.variants!, { width: 480, file: gif }] };
    expect(await restoreAssetFiles(dir, odd)).toEqual({ written: [], failed: [] });
    unlinkSync(join(dir, gif));
    expect(await restoreAssetFiles(dir, odd)).toEqual({ written: [], failed: [gif] });
  });

  it('makes no copies when another picture sits where the original belongs, even if the original is located', async () => {
    const { dir, record, source } = await photoProject();
    const other = await picture('jpeg', 1200, 800, { r: 0, g: 0, b: 0 });
    writeFileSync(join(dir, record.file), other);
    unlinkSync(join(dir, record.variants![0].file));
    await expect(locateAssetFile(dir, record, source)).rejects.toThrow(/not the picture the library recorded/);
    expect(readFileSync(join(dir, record.file)).equals(other)).toBe(true);
    expect(existsSync(join(dir, record.variants![0].file))).toBe(false);
  });

  it('makes no copies from an original that is no longer the recorded picture', async () => {
    const { dir, record } = await photoProject();
    writeFileSync(join(dir, record.file), await picture('jpeg', 1200, 800, { r: 0, g: 0, b: 0 }));
    unlinkSync(join(dir, record.variants![0].file));
    await expect(restoreAssetFiles(dir, record)).rejects.toThrow(/not the picture the library recorded/);
    expect(existsSync(join(dir, record.variants![0].file))).toBe(false);
  });
});

describe('a smaller copy that is there but damaged (#1459)', () => {
  /** Cut a photo's first copy in `ext` to its first 24 bytes in place, as the issue found it. */
  const cut = (dir: string, record: AssetRecord, ext: string) => {
    const file = record.variants!.find((v) => v.file.endsWith(`.${ext}`))!.file;
    const whole = readFileSync(join(dir, file));
    writeFileSync(join(dir, file), whole.subarray(0, 24));
    return { file, whole };
  };
  /** The record's copies among `files`, in the order the record lists them. */
  const listed = (record: AssetRecord, files: string[]) => record.variants!.map((v) => v.file).filter((f) => files.includes(f));

  it('is found among the copies to make again, named as damaged, and found whole once it is', async () => {
    const { dir, record } = await photoProject();
    const assets = { [record.id]: record };
    const { file: avif, whole } = cut(dir, record, 'avif');
    expect(await findMissingAssetFiles(dir, assets)).toEqual([{ assetId: record.id, original: false, variants: [avif], damaged: [avif] }]);
    // Looked at again, it is still damaged; put back whole, it is not.
    expect(await findMissingAssetFiles(dir, assets)).toEqual([{ assetId: record.id, original: false, variants: [avif], damaged: [avif] }]);
    writeFileSync(join(dir, avif), whole);
    expect(await findMissingAssetFiles(dir, assets)).toEqual([]);
    // A whole copy found whole, then overwritten with as many bytes that are no picture, is looked at again.
    const webp = record.variants!.find((v) => v.file.endsWith('.webp'))!.file;
    writeFileSync(join(dir, webp), Buffer.alloc(readFileSync(join(dir, webp)).length));
    // Beside a copy that is gone: both are to be made again, and only the one there is damaged.
    const gone = record.variants![0].file;
    unlinkSync(join(dir, gone));
    expect(await findMissingAssetFiles(dir, assets)).toEqual([{ assetId: record.id, original: false, variants: listed(record, [gone, webp]), damaged: [webp] }]);
  });

  it('is said in Project health by its file name, beside what is missing', () => {
    const state = createStarterState('business', 'Health', true);
    for (const a of STARTER_ASSETS) state.assets.assets[a.id] = { id: a.id, name: a.name, file: `static/assets/${a.id.slice(2)}-00000000.jpg`, mime: 'image/jpeg', bytes: 1, hash: a.id, kind: 'image', createdAt: 'now' };
    const avif = 'static/assets/person3-00000000-480w.avif';
    const webp = 'static/assets/person3-00000000-960w.webp';
    expect(missingFileDiagnostics(state, [{ assetId: 'a_person3', original: false, variants: [avif], damaged: [avif] }])[0].message).toBe('Portrait 3 has a damaged smaller copy (person3-00000000-480w.avif) in the project folder. Make the copies again in Assets.');
    expect(missingFileDiagnostics(state, [{ assetId: 'a_person3', original: true, variants: ['static/assets/person3-00000000-160w.jpg', avif, webp], damaged: [avif, webp] }])[0].message).toBe(
      'Portrait 3 is missing its original file and a smaller copy and has 2 damaged smaller copies (person3-00000000-480w.avif, person3-00000000-960w.webp) in the project folder. Locate the file or choose another image in Assets.'
    );
  });

  it('is made again from the original in its place, leaving the original and every other copy as they were', async () => {
    const { dir, record } = await photoProject();
    const { file: avif } = cut(dir, record, 'avif');
    const others = [record.file, ...record.variants!.map((v) => v.file).filter((f) => f !== avif)];
    const kept = Object.fromEntries(others.map((f) => [f, readFileSync(join(dir, f))]));
    expect(await restoreAssetFiles(dir, record)).toEqual({ written: [avif], failed: [] });
    expect(await sharp(join(dir, avif)).metadata()).toMatchObject({ format: 'heif', width: record.variants!.find((v) => v.file === avif)!.width });
    for (const [file, bytes] of Object.entries(kept)) expect(readFileSync(join(dir, file)).equals(bytes), file).toBe(true);
    expect(await findMissingAssetFiles(dir, { [record.id]: record })).toEqual([]);
    expect(await restoreAssetFiles(dir, record)).toEqual({ written: [], failed: [] });
  });

  it('in an open project, shows in Project health, is made again from Assets, and stops a website export that uses it', async () => {
    const { c, dir } = await openProject();
    const s = c.session!;
    const hero = s.state.assets.assets.a_hero;
    expect(c.snapshot()!.assetUsage.a_hero).toBeGreaterThan(0);
    const { file: webp } = cut(dir, hero, 'webp');
    const name = webp.split('/').pop()!;
    await s.refreshAssetFiles();
    const snap = c.snapshot()!;
    expect(snap.missingAssets).toEqual([{ assetId: 'a_hero', original: false, variants: [webp], damaged: [webp] }]);
    expect(snap.diagnostics.find((d) => d.code === 'ASSET_FILE_MISSING')).toEqual({ severity: 'error', code: 'ASSET_FILE_MISSING', message: `Hero interior has a damaged smaller copy (${name}) in the project folder. Make the copies again in Assets.`, owner: { kind: 'asset', id: 'a_hero' } });
    // A website export stops before it gets to the photos' details, saying how to repair the copy; an editable one
    // goes ahead and says it carries the damaged copy.
    const site = await c.buildStaticTo(join(temp('dest'), 'site'));
    expect(site).toMatchObject({ ok: false, assetId: 'a_hero', message: `Hero interior has a damaged smaller copy (${name}) in the project folder, and the website uses it. Make the copies again in Assets, then export again.`, warnings: [`Hero interior: ${webp} damaged.`] });
    const source = await c.exportSourceTo(join(temp('dest'), 'source'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toContain(`Hero interior has a damaged smaller copy (${name}) in the project folder, so the exported project has the damaged copy as it is. Make the copies again in Assets and export again.`);
    // Make the copy again: the copy is whole, and nothing is wrong any more.
    expect(await c.regenerateAssetCopies('a_hero')).toEqual({ ok: true, message: 'Made a smaller copy of Hero interior again.' });
    expect(await sharp(join(dir, webp)).metadata()).toMatchObject({ format: 'webp', width: hero.variants!.find((v) => v.file === webp)!.width });
    expect(c.snapshot()!.missingAssets).toEqual([]);
    expect(c.snapshot()!.diagnostics.some((d) => d.code === 'ASSET_FILE_MISSING')).toBe(false);
  }, 60_000);
});

describe('giving a library image a new file', () => {
  const record = (): AssetRecord => ({ id: 'a_pic', name: 'Pic', file: 'static/assets/pic-11111111.jpg', mime: 'image/jpeg', bytes: 10, width: 1200, height: 800, hash: 'old', kind: 'image', originalName: 'pic_final.JPG', createdAt: 'then', description: 'Our studio', altSuggestion: 'A studio', variants: [{ width: 480, file: 'static/assets/pic-11111111-480w.jpg' }] });
  const relink = { type: 'asset.relink' as const, assetId: 'a_pic', file: 'static/assets/new-22222222.webp', mime: 'image/webp', bytes: 20, hash: 'new', width: 300, height: 200 };
  const named = { ...relink, originalName: 'new_pic.webp' };

  it('keeps the image, its details and every use with its alt text, and replaces the file details (and the old picture’s suggested alt text) as a whole', () => {
    let s = createStarterState('blank', 'Relink', false);
    s = applyOperations(s, [{ type: 'asset.add', asset: record() }]).state;
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Pic', source: '<p>x</p>\n', properties: { photo: { type: 'image', label: 'Photo' } } }]);
    s = applyOperations(c.state, [{ type: 'node.insert', owner: { kind: 'page', id: c.state.site.homePageId }, definitionId: c.results[0].definitionId as string, props: { photo: { assetId: 'a_pic', alt: 'The studio at dusk' } } }]).state;
    const withCopies = applyOperations(s, [{ ...relink, file: 'static/assets/new-22222222.jpg', mime: 'image/jpeg', variants: [{ width: 480, file: 'static/assets/new-22222222-480w.jpg' }] }]).state.assets.assets.a_pic;
    expect(withCopies.variants).toEqual([{ width: 480, file: 'static/assets/new-22222222-480w.jpg' }]);
    // The old file's name never stands for a file that came without one.
    expect(withCopies.originalName).toBeUndefined();
    const after = applyOperations(s, [named]).state;
    expect(after.assets.assets.a_pic).toEqual({ originalName: 'new_pic.webp',  id: 'a_pic', name: 'Pic', file: relink.file, mime: 'image/webp', bytes: 20, width: 300, height: 200, hash: 'new', kind: 'image', createdAt: 'then', description: 'Our studio' });
    expect(JSON.stringify(after.pages)).toContain('{"assetId":"a_pic","alt":"The studio at dusk"}');
    expect(assetUsages(after).a_pic).toBe(1);
    const svg = applyOperations(s, [{ ...relink, file: 'static/assets/new-22222222.svg', mime: 'image/svg+xml', width: undefined, height: undefined }]).state.assets.assets.a_pic;
    expect([svg.width, svg.height, svg.variants]).toEqual([undefined, undefined, undefined]);
  });

  it('takes only importer file names, for images', () => {
    expect(validateOperation({ ...relink, file: 'static/assets/../../secret.jpg' }).ok).toBe(false);
    expect(validateOperation({ ...relink, file: 'src/routes/+page.svelte' }).ok).toBe(false);
    expect(validateOperation({ ...relink, mime: 'font/woff2' }).ok).toBe(false);
    expect(validateOperation({ ...relink, variants: [{ width: 480, file: 'static/assets/../x-480w.jpg' }] }).ok).toBe(false);
    expect(validateOperation({ ...relink, variants: [{ width: 480, file: 'static/assets/x-480w.gif' }] }).ok).toBe(false);
    expect(validateOperation({ ...relink, variants: [{ width: 0, file: 'static/assets/x-480w.jpg' }] }).ok).toBe(false);
    expect(validateOperation({ ...relink, variants: [{ width: 480.5, file: 'static/assets/x-480w.jpg' }] }).ok).toBe(false);
    for (const ext of ['jpg', 'png', 'webp', 'avif']) expect(validateOperation({ ...relink, variants: [{ width: 480, file: `static/assets/x-480w.${ext}` }] }).ok, ext).toBe(true);
    const s = applyOperations(createStarterState('blank', 'Font', false), [{ type: 'asset.add', asset: { ...record(), kind: 'font' } }]).state;
    expect(() => applyOperations(s, [relink])).toThrow(/not an image/);
  });

  it('is the editor’s alone: an AI change cannot point an image at another file', async () => {
    const dir = temp('project');
    const s = await ProjectSession.create(dir, createStarterState('blank', 'AI', false));
    try {
      expect((await s.apply({ operations: [{ type: 'asset.add', asset: record() }] }, { label: 'Import', source: 'user' })).ok).toBe(true);
      const ai = await s.apply({ operations: [relink] }, { label: 'Relink', source: 'ai' });
      expect(ai).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      // Nor a change made as part of an AI run, whatever it calls itself.
      expect(await s.beginRun('run_relink')).toBeNull();
      expect(await s.apply({ operations: [relink] }, { label: 'Relink', source: 'user', runId: 'run_relink' })).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      expect(s.state.assets.assets.a_pic.file).toBe(record().file);
    } finally {
      await s.close();
    }
  });
});

/** A Business site with its sample pictures imported, its preview tools in place, opened in the Controller. */
async function openProject(): Promise<{ c: InstanceType<typeof Controller>; dir: string }> {
  const dir = temp('project');
  const state = createStarterState('business', 'Reading Room', true);
  for (const a of STARTER_ASSETS) {
    const { record } = await importAsset(dir, join('resources/starter-assets', a.source), []);
    state.assets.assets[a.id] = { ...record, id: a.id, name: a.name, altSuggestion: a.alt };
  }
  const created = await ProjectSession.create(dir, state);
  await created.close();
  const pkg = '{"name":"site","type":"module"}';
  const lock = JSON.stringify({ name: 'site', lockfileVersion: 3, requires: true, packages: { '': { name: 'site' } } }, null, 2) + '\n';
  writeFileSync(join(dir, 'package.json'), pkg);
  writeFileSync(join(dir, 'package-lock.json'), lock);
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  mkdirSync(join(dir, 'node_modules/@sveltejs/kit'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@sveltejs/kit/package.json'), '{"name":"@sveltejs/kit"}');
  writeFileSync(join(dir, '.siteorigin/cache/deps.json'), JSON.stringify({ lockHash: sha(lock + pkg), preparedAt: '2026-01-01T00:00:00.000Z' }));
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  return { c, dir };
}

async function until(check: () => boolean, what: string, ms = 3000) {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

describe('a project whose picture was moved out of its folder', () => {
  it('lists it in Project health with its uses kept, and relinks a new picture in one step that can be undone', async () => {
    const { c, dir } = await openProject();
    const s = c.session!;
    const nook = s.state.assets.assets.a_reading;
    const uses = c.snapshot()!.assetUsage.a_reading;
    expect(uses).toBeGreaterThan(0);
    expect(c.snapshot()!.missingAssets).toEqual([]);
    // A check still running from opening the project would report the files it reached before they went; a newer
    // check makes it change nothing.
    await s.refreshAssetFiles();
    // macOS can start delivering a newly installed watch after the opening has returned. Prove it is listening
    // before removing the pictures whose disappearance this test expects it to report.
    const watched = vi.spyOn(s, 'refreshAssetFiles');
    const probe = join(dir, 'static/assets', 'watch-probe.txt');
    for (let attempt = 0; attempt < 20 && !watched.mock.calls.length; attempt++) {
      writeFileSync(probe, String(attempt));
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(watched).toHaveBeenCalled();
    watched.mockRestore();
    unlinkSync(probe);
    const outside = temp('moved');
    for (const f of [nook.file, ...(nook.variants ?? []).map((v) => v.file)]) {
      copyFileSync(join(dir, f), join(outside, f.split('/').pop()!));
      unlinkSync(join(dir, f));
    }
    // The folder watcher notices; the library entry and its uses stay. It can report while files are still going, so
    // wait for all of them.
    const gone = 1 + (nook.variants ?? []).length;
    await until(() => c.snapshot()!.missingAssets.some((m) => m.assetId === 'a_reading' && (m.original ? 1 : 0) + m.variants.length === gone), 'the missing files to be noticed', 10_000);
    const snap = c.snapshot()!;
    expect(snap.missingAssets).toEqual([{ assetId: 'a_reading', original: true, variants: (nook.variants ?? []).map((v) => v.file), damaged: [] }]);
    expect(snap.diagnostics.find((d) => d.code === 'ASSET_FILE_MISSING')).toMatchObject({ severity: 'error', owner: { kind: 'asset', id: 'a_reading' }, message: expect.stringMatching(/^Reading nook is missing its original file/) });
    expect(snap.assetUsage.a_reading).toBe(uses);
    // The AI's own checks never see it: it cannot bring the file back.
    expect(s.diagnostics().some((d) => d.code === 'ASSET_FILE_MISSING')).toBe(false);
    // A website export stops before the build, naming the image; an editable one goes ahead and says what it lacks.
    const site = await c.buildStaticTo(join(temp('dest'), 'site'));
    expect(site).toMatchObject({ ok: false, assetId: 'a_reading', message: expect.stringMatching(/^Reading nook is missing its original file and \d+ smaller copies in the project folder, and the website uses them\. Locate the file in Assets, then export again\.$/) });
    const source = await c.exportSourceTo(join(temp('dest'), 'source'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toContainEqual(expect.stringMatching(/^Reading nook is missing its original file/));
    const alts = JSON.stringify(s.state.pages).match(/"assetId":"a_reading","alt":"[^"]*"/g);

    // A different picture becomes this image's file, everywhere it is used.
    const replacement = sourceFile('new-nook.png', await picture('png', 900, 600, { r: 40, g: 160, b: 90 }));
    const r = await c.locateAsset('a_reading', replacement);
    expect(r).toMatchObject({ ok: true, message: 'new-nook.png now shows wherever Reading nook is used.', entryId: expect.any(String), revision: s.revision });
    expect(c.snapshot()!.history.entries.find((e) => e.id === r.entryId)).toMatchObject({ applied: true });
    const relinked = s.state.assets.assets.a_reading;
    expect(relinked.originalName).toBe('new-nook.png');
    expect(relinked).toMatchObject({ id: 'a_reading', name: 'Reading nook', mime: 'image/png', width: 900 });
    // The suggestion described the old picture (#1385): it goes, and every use keeps its alt text, listed to check.
    expect(relinked.altSuggestion).toBeUndefined();
    expect(JSON.stringify(s.state.pages).match(/"assetId":"a_reading","alt":"[^"]*"/g)).toEqual(alts);
    expect(r.altReview?.length).toBeGreaterThan(0);
    expect(r.altReview?.length).toBe(altChecks(s.state, 'a_reading', r.altReview!).length);
    expect(r.altReview!.every((x) => (x.reason === 'custom' ? !!x.alt.trim() : !x.alt.trim()))).toBe(true);
    await until(() => !c.snapshot()!.missingAssets.length, 'the relinked image to be found');
    expect(c.snapshot()!.diagnostics.some((d) => d.code === 'ASSET_FILE_MISSING')).toBe(false);

    // Undo points the image back at the old files, which are still missing.
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.assets.assets.a_reading).toEqual(nook);
    await until(() => !!c.snapshot()!.missingAssets.length, 'the old files to be missing again');

    // Putting the original back (located under any name) restores it in place, with no change to the project.
    const revision = s.revision;
    const r2 = await c.locateAsset('a_reading', join(outside, nook.file.split('/').pop()!));
    // The same picture is no new one to describe: nothing to check.
    expect(r2).toEqual({ ok: true, message: 'Reading nook is back in the project folder.' });
    expect(s.revision).toBe(revision);
    expect(c.snapshot()!.missingAssets).toEqual([]);
  }, 60_000);

  it('lets only one of two Locates for the same image change it', async () => {
    const { c, dir } = await openProject();
    const s = c.session!;
    const nook = s.state.assets.assets.a_reading;
    unlinkSync(join(dir, nook.file));
    const first = sourceFile('first.png', await picture('png', 900, 600, { r: 200, g: 10, b: 10 }));
    const second = sourceFile('second.png', await picture('png', 900, 600, { r: 10, g: 10, b: 200 }));
    const [a, b] = await Promise.all([c.locateAsset('a_reading', first), c.locateAsset('a_reading', second)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = a.ok ? b : a;
    expect(lost.message).toMatch(/changed while|was left as it is/);
    const won = a.ok ? first : second;
    expect(s.state.assets.assets.a_reading.hash).toBe(sha(readFileSync(won)));
  }, 60_000);

  it('makes missing copies again, and refuses to work on a project open read-only', async () => {
    const { c, dir } = await openProject();
    const hero = c.session!.state.assets.assets.a_hero;
    expect(hero.variants?.length).toBeGreaterThan(0);
    for (const v of hero.variants!) unlinkSync(join(dir, v.file));
    const r = await c.regenerateAssetCopies('a_hero');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Made \d+ smaller copies of Hero interior again\.$|^Made a smaller copy of Hero interior again\.$/);
    for (const v of hero.variants!) expect(existsSync(join(dir, v.file))).toBe(true);
    expect(c.snapshot()!.missingAssets).toEqual([]);
    expect(await c.locateAsset('a_nope', sourceFile('x.png', await picture('png')))).toEqual({ ok: false, message: 'That image is no longer in the library.' });
  }, 60_000);
});

describe('exporting with missing image files', () => {
  /** A staged project: a page naming one image's files, and another image nothing names. */
  async function staged() {
    const dir = temp('staged');
    const state = createStarterState('blank', 'Staged', false);
    const { record: used } = await importAsset(dir, sourceFile('reading-nook.jpg', await picture('jpeg', 1200, 800)), []);
    const { record: spare } = await importAsset(dir, sourceFile('spare.png', await picture('png')), []);
    state.assets.assets[used.id] = { ...used, name: 'Reading nook' };
    state.assets.assets[spare.id] = { ...spare, name: 'Spare' };
    mkdirSync(join(dir, 'src/routes'), { recursive: true });
    const name = (f: string) => f.split('/').pop();
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<img src="/assets/${name(used.file)}" srcset="${used.variants!.map((v) => `/assets/${name(v.file)} ${v.width}w`).join(', ')}" alt="">`);
    return { dir, state, used: state.assets.assets[used.id], spare: state.assets.assets[spare.id] };
  }

  it('stops a website export for a picture the site uses, naming it, and lets one it does not use pass', async () => {
    const { dir, state, used, spare } = await staged();
    expect(await missingWebsiteAssets(dir, state)).toEqual([]);
    unlinkSync(join(dir, spare.file));
    expect(await missingWebsiteAssets(dir, state)).toEqual([{ asset: spare, missing: { assetId: spare.id, original: true, variants: [], damaged: [] }, used: false }]);
    expect(missingUnusedWarnings(await missingWebsiteAssets(dir, state))).toEqual(['Spare is missing its original file in the project folder. No page or code names it, so the website was exported without it.']);
    // A copy the site does not name (only the original is, as a favicon would be) blocks nothing.
    const page = readFileSync(join(dir, 'src/routes/+page.svelte'), 'utf8');
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<link rel="icon" href="/assets/${used.file.split('/').pop()}">`);
    const copy = readFileSync(join(dir, used.variants![0].file));
    unlinkSync(join(dir, used.variants![0].file));
    expect((await missingWebsiteAssets(dir, state)).find((m) => m.asset.id === used.id)?.used).toBe(false);
    writeFileSync(join(dir, used.variants![0].file), copy);
    writeFileSync(join(dir, 'src/routes/+page.svelte'), page);
    unlinkSync(join(dir, used.variants![1].file));
    const copyGone = (await missingWebsiteAssets(dir, state)).filter((m) => m.used);
    expect(missingAssetsStop(copyGone).message).toBe('Reading nook is missing a smaller copy in the project folder, and the website uses it. Make the copies again in Assets, then export again.');
    unlinkSync(join(dir, used.file));
    const stop = missingAssetsStop((await missingWebsiteAssets(dir, state)).filter((m) => m.used));
    expect(stop.message).toBe('Reading nook is missing its original file and a smaller copy in the project folder, and the website uses them. Locate the file in Assets, then export again.');
    expect(stop.warnings).toEqual([`Reading nook: ${used.file}, ${used.variants![1].file} not found.`]);
  });

  it('judges a missing copy by the names it asks about alone, whatever a damaged copy beside it says', async () => {
    const { dir, state, used } = await staged();
    // Edited by hand, one more copy names no file: the search for missing files passes it by, and so does the answer.
    const damaged = { ...used, variants: [...used.variants!, { ...used.variants![0], file: 17 } as unknown as NonNullable<typeof used.variants>[number]] };
    state.assets.assets[used.id] = damaged;
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<link rel="icon" href="/assets/${used.file.split('/').pop()}">`);
    unlinkSync(join(dir, used.variants![0].file));
    const found = await missingWebsiteAssets(dir, state);
    expect(found).toEqual([{ asset: damaged, missing: { assetId: used.id, original: false, variants: [used.variants![0].file], damaged: [] }, used: false }]);
    // The missing copy named by the site is used, the damaged copy beside it still no name.
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<img src="/assets/${used.variants![0].file.split('/').pop()}" alt="">`);
    expect((await missingWebsiteAssets(dir, state))[0].used).toBe(true);
    // With the original gone too, its JPEG and PNG copies are asked about, and a copy that names a list of files is none.
    state.assets.assets[used.id] = { ...damaged, variants: [...damaged.variants!, { ...used.variants![0], file: [used.variants![0].file] } as unknown as NonNullable<typeof used.variants>[number]] };
    unlinkSync(join(dir, used.file));
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<img src="/assets/${used.variants![1].file.split('/').pop()}" alt="">`);
    const gone = await missingWebsiteAssets(dir, state);
    expect(gone.map((m) => [m.missing.original, m.used])).toEqual([[true, /\.(jpg|png)$/.test(used.variants![1].file)]]);
  });

  it('counts an image as used when the site names any of its files, and only whole file names', async () => {
    const { dir, state, used } = await staged();
    const name = (f: string) => f.split('/').pop();
    // Only a copy is named, and the original (where the copy's credits come from) is the file that went.
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<img src="/assets/${name(used.variants![0].file)}" alt="">`);
    unlinkSync(join(dir, used.file));
    expect((await missingWebsiteAssets(dir, state)).map((m) => [m.asset.name, m.used])).toEqual([['Reading nook', true]]);
    // A WebP or AVIF copy carries its own credits: naming only those, the missing original stops nothing.
    const modern = used.variants!.filter((v) => /\.(webp|avif)$/.test(v.file)).map((v) => `/assets/${name(v.file)} ${v.width}w`);
    expect(modern.length).toBeGreaterThan(0);
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<picture><source type="image/webp" srcset="${modern.join(', ')}"></picture>`);
    expect((await missingWebsiteAssets(dir, state)).map((m) => [m.asset.name, m.used])).toEqual([['Reading nook', false]]);
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<img src="/assets/${name(used.variants![0].file)}" alt="">`);
    // A longer file name that starts with this one is another file.
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<a href="/downloads/${name(used.file)}.webp">Download</a> <img src="/assets/${name(used.file)}-old.jpg" alt="">`);
    expect((await missingWebsiteAssets(dir, state)).map((m) => m.used)).toEqual([false]);
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<p>See ${name(used.file)}.</p><img src="/assets/${name(used.file)}?v=2" alt="">`);
    expect((await missingWebsiteAssets(dir, state)).map((m) => m.used)).toEqual([true]);
  });

  it('stops a website export for a damaged copy the site uses, names one it does not use, and notes it in an editable export', async () => {
    const { dir, state, used } = await staged();
    const copy = used.variants!.find((v) => v.file.endsWith('.webp'))!.file;
    const name = copy.split('/').pop()!;
    writeFileSync(join(dir, copy), readFileSync(join(dir, copy)).subarray(0, 24));
    const found = await missingWebsiteAssets(dir, state);
    expect(found).toEqual([{ asset: used, missing: { assetId: used.id, original: false, variants: [copy], damaged: [copy] }, used: true }]);
    expect(missingAssetsStop(found)).toEqual({ message: `Reading nook has a damaged smaller copy (${name}) in the project folder, and the website uses it. Make the copies again in Assets, then export again.`, warnings: [`Reading nook: ${copy} damaged.`] });
    expect(missingSourceWarnings(state, found.map((m) => m.missing))).toEqual([`Reading nook has a damaged smaller copy (${name}) in the project folder, so the exported project has the damaged copy as it is. Make the copies again in Assets and export again.`]);
    // Beside a missing copy, each is said for what it is.
    const gone = used.variants![0].file;
    unlinkSync(join(dir, gone));
    const both = await missingWebsiteAssets(dir, state);
    expect(missingAssetsStop(both).warnings).toEqual([`Reading nook: ${gone} not found; ${copy} damaged.`]);
    expect(missingSourceWarnings(state, both.map((m) => m.missing))).toEqual([`Reading nook is missing a smaller copy and has a damaged smaller copy (${name}) in the project folder, so the exported project is missing the same files and has the damaged copy as it is. Make the copies again in Assets and export again.`]);
    // Named by no page, the website goes without it, and says so.
    writeFileSync(join(dir, 'src/routes/+page.svelte'), `<link rel="icon" href="/assets/${used.file.split('/').pop()}">`);
    writeFileSync(join(dir, gone), await picture('jpeg', 160, 107));
    expect(missingUnusedWarnings(await missingWebsiteAssets(dir, state))).toEqual([`Reading nook has a damaged smaller copy (${name}) in the project folder. No page or code names it, so the website was exported without it.`]);
  });

  it('notes in an editable export which pictures it does not have', async () => {
    const { dir, state, used } = await staged();
    unlinkSync(join(dir, used.file));
    expect(missingSourceWarnings(state, await findMissingAssetFiles(dir, state.assets.assets))).toEqual(['Reading nook is missing its original file in the project folder, so the exported project does not have it either. Fix it in Assets and export again.']);
  });
});

describe('a font whose file left the project folder (#1425)', () => {
  const LORA = 'node_modules/@fontsource-variable/lora/files/lora-latin-wght-normal.woff2';
  const LORA_ITALIC = 'node_modules/@fontsource-variable/lora/files/lora-latin-wght-italic.woff2';
  const fileName = (r: AssetRecord) => r.file.split('/').pop()!;

  it('is found missing, and named by its file in Project health and the editable export notes', async () => {
    const dir = temp('project');
    const { record } = await importAsset(dir, sourceFile('Lora.woff2', readFileSync(LORA)), []);
    expect(record.kind).toBe('font');
    const assets = { [record.id]: record };
    expect(await findMissingAssetFiles(dir, assets)).toEqual([]);
    unlinkSync(join(dir, record.file));
    const missing = await findMissingAssetFiles(dir, assets);
    expect(missing).toEqual([{ assetId: record.id, original: true, variants: [], damaged: [] }]);
    const state = createStarterState('blank', 'Fonts', false);
    state.assets.assets[record.id] = record;
    const said = `${record.name} is missing its font file (${fileName(record)}) in the project folder.`;
    // A warning while no style uses the family, a problem once one does.
    expect(missingFileDiagnostics(state, missing, () => ({}))).toEqual([{ severity: 'warning', code: 'ASSET_FILE_MISSING', message: `${said} Locate the file in Assets, or remove the font.`, owner: { kind: 'asset', id: record.id } }]);
    expect(missingFileDiagnostics(state, missing, () => ({ [record.id]: 1 }))[0].severity).toBe('error');
    expect(missingSourceWarnings(state, missing)).toEqual([`${record.name} is missing its font file (${fileName(record)}) in the project folder, so the exported project does not have it either. Fix it in Assets and export again.`]);
  });

  it('stops a website export whose styles name the missing font, naming the face', async () => {
    const dir = temp('staged');
    const state = createStarterState('blank', 'Staged', false);
    const { record } = await importAsset(dir, sourceFile('Lora.woff2', readFileSync(LORA)), []);
    state.assets.assets[record.id] = record;
    mkdirSync(join(dir, 'src/lib'), { recursive: true });
    writeFileSync(join(dir, 'src/lib/tokens.css'), `@font-face { font-family: 'Lora'; src: url('/assets/${fileName(record)}') format('woff2'); }`);
    expect(await missingWebsiteAssets(dir, state)).toEqual([]);
    unlinkSync(join(dir, record.file));
    const found = await missingWebsiteAssets(dir, state);
    expect(found).toEqual([{ asset: record, missing: { assetId: record.id, original: true, variants: [], damaged: [] }, used: true }]);
    expect(missingAssetsStop(found).message).toBe(`${record.name} is missing its font file (${fileName(record)}) in the project folder, and the website uses it. Locate the file in Assets, then export again.`);
    // Named nowhere, it lets the export pass with a note.
    writeFileSync(join(dir, 'src/lib/tokens.css'), '');
    expect(missingUnusedWarnings(await missingWebsiteAssets(dir, state))).toEqual([`${record.name} is missing its font file (${fileName(record)}) in the project folder. No page or code names it, so the website was exported without it.`]);
  });

  it('puts the very same file back, from Add fonts or Locate, under its recorded name and nothing else', async () => {
    const dir = temp('project');
    const original = readFileSync(LORA);
    const { record } = await importAsset(dir, sourceFile('Lora.woff2', original), []);
    unlinkSync(join(dir, record.file));
    // Added again under another name, it is the record already there, and its file is back.
    const again = await importAsset(dir, sourceFile('lora-renamed.woff2', original), [record]);
    expect(again).toMatchObject({ record, existing: true, restored: true });
    expect(readFileSync(join(dir, record.file)).equals(original)).toBe(true);
    // A healthy duplicate is only the record.
    const twice = await importAsset(dir, sourceFile('lora-renamed.woff2', original), [record]);
    expect(twice.existing).toBe(true);
    expect(twice).not.toHaveProperty('restored');
    // Located under any name, the same bytes go back; another face of the family, or an image, is refused.
    unlinkSync(join(dir, record.file));
    await expect(locateAssetFile(dir, record, sourceFile('Lora.woff2', readFileSync(LORA_ITALIC)))).rejects.toThrow(/^Lora\.woff2 can't be used because it is not the file of /);
    await expect(locateAssetFile(dir, record, sourceFile('lora.png', await picture('png')))).rejects.toThrow(/^lora\.png can't be used because it is not a font/);
    expect(existsSync(join(dir, record.file))).toBe(false);
    expect(await locateAssetFile(dir, record, sourceFile('downloaded.woff2', original))).toEqual({ same: true, written: [record.file], failed: [] });
    expect(readFileSync(join(dir, record.file)).equals(original)).toBe(true);
    // Nothing is written once the project may no longer be written to.
    unlinkSync(join(dir, record.file));
    const closed = async () => false;
    await expect(importAsset(dir, sourceFile('lora.woff2', original), [record], closed)).rejects.toThrow(/was not restored because the project was closed/);
    await expect(locateAssetFile(dir, record, sourceFile('lora.woff2', original), closed)).rejects.toThrow(/was not restored because the project was closed/);
    expect(existsSync(join(dir, record.file))).toBe(false);
    // In a batch, the same font given twice is put back once, through the fence for its own record: one that refuses
    // (the record changed meanwhile) writes nothing, and says why for each file.
    const twiceOver = [sourceFile('a.woff2', original), sourceFile('b.woff2', original)].map((path) => ({ path, opts: {} }));
    const fenced: string[] = [];
    const changed = (r: AssetRecord) => async () => (fenced.push(r.id), Promise.reject(new Error(`${r.name} changed while its file was being put back.`)));
    const refused = await importAssetBatch(dir, twiceOver, [record], async (w) => (await w(), true), { parallel: 2, go: () => true, repair: changed });
    expect(refused.map((o) => (o && 'error' in o ? o.error.message : o))).toEqual([`${record.name} changed while its file was being put back.`, `${record.name} changed while its file was being put back.`]);
    expect(fenced).toEqual([record.id]);
    expect(existsSync(join(dir, record.file))).toBe(false);
    let writes = 0;
    const counted = () => async (w: () => Promise<void>) => (writes++, await w(), true);
    const back = await importAssetBatch(dir, twiceOver, [record], closed, { parallel: 2, go: () => true, repair: counted });
    expect(back.map((o) => o && !('error' in o) && [o.record.id, o.existing, o.restored])).toEqual([[record.id, true, true], [record.id, true, true]]);
    expect(writes).toBe(1);
    expect(readFileSync(join(dir, record.file)).equals(original)).toBe(true);
    unlinkSync(join(dir, record.file));
    // A font lists no smaller copies: one that names some (assets.json edited by hand) is missing only its own file.
    expect(await findMissingAssetFiles(dir, { [record.id]: { ...record, variants: [{ width: 480, file: 'static/assets/lora-00000000-480w.woff2' }] } })).toEqual([{ assetId: record.id, original: true, variants: [], damaged: [] }]);
  });

  it('in an open project, shows in Project health, comes back through Add fonts with its styles kept, and stops a website export', async () => {
    const { c, dir } = await openProject();
    const s = c.session!;
    const added = await c.importAssets([sourceFile('Lora.woff2', readFileSync(LORA))], 'font');
    expect(added.ok).toBe(true);
    const id = added.assetIds[0];
    const font = s.state.assets.assets[id];
    expect((await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: "'Lora', system-ui, sans-serif" }] }, { label: 'Use font', source: 'user' })).ok).toBe(true);
    expect(c.snapshot()!.assetUsage[id]).toBeGreaterThan(0);
    unlinkSync(join(dir, font.file));
    await until(() => c.snapshot()!.missingAssets.some((m) => m.assetId === id), 'the missing font to be noticed', 10_000);
    expect(c.snapshot()!.diagnostics.find((d) => d.code === 'ASSET_FILE_MISSING' && d.owner?.id === id)).toMatchObject({ severity: 'error', message: expect.stringMatching(new RegExp(`^${font.name} is missing its font file`)) });
    // A website export stops before the build, naming the face; an editable one goes ahead and says which face it lacks.
    const site = await c.buildStaticTo(join(temp('dest'), 'site'));
    expect(site).toMatchObject({ ok: false, assetId: id, message: `${font.name} is missing its font file (${fileName(font)}) in the project folder, and the website uses it. Locate the file in Assets, then export again.` });
    const source = await c.exportSourceTo(join(temp('dest'), 'source'));
    expect(source.ok).toBe(true);
    expect(source.warnings).toContainEqual(expect.stringMatching(new RegExp(`^${font.name} is missing its font file \\(${fileName(font).replace('.', '\\.')}\\)`)));
    // Added again, the original goes back where the record says, with no change to the project.
    const revision = s.revision;
    const tokens = JSON.stringify(s.state.tokens);
    const back = await c.importAssets([sourceFile('Lora-Variable.woff2', readFileSync(LORA))], 'font');
    expect(back).toMatchObject({ ok: true, assetIds: [id], restoredAssetIds: [id] });
    expect(readFileSync(join(dir, font.file)).equals(readFileSync(LORA))).toBe(true);
    expect(s.revision).toBe(revision);
    expect(s.state.assets.assets[id]).toEqual(font);
    expect(JSON.stringify(s.state.tokens)).toBe(tokens);
    expect(c.snapshot()!.missingAssets).toEqual([]);
    // Locate file does the same.
    unlinkSync(join(dir, font.file));
    await until(() => c.snapshot()!.missingAssets.some((m) => m.assetId === id), 'the missing font to be noticed again', 10_000);
    expect(await c.locateAsset(id, sourceFile('somewhere.woff2', readFileSync(LORA)))).toEqual({ ok: true, message: `${font.name} is back in the project folder.` });
    expect(s.revision).toBe(revision);
    expect(c.snapshot()!.missingAssets).toEqual([]);
  }, 60_000);
});
