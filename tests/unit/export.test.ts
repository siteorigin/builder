import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, promises as fsPromises, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync, inflateRawSync, crc32 } from 'node:zlib';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, assetUsages } from '@engine/apply';
import { defFile, generateProject, publishedState, RUNTIME_DIR } from '@generator/index';
import { SEARCH_INDEX_FILE } from '@generator/search';
import type { AssetRecord, ComponentDefinition, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { zipDirectory } from '../../src/main/zip';
import { isPrivateFileName } from '../../src/main/project/private-files';
import {
  builtPhotosMessage,
  cleanBuiltSite,
  cleanWebsitePhotos,
  copyProjectSource,
  copyTree,
  draftOnlyAssetFiles,
  heldDraftAssetsNote,
  inProjectSource,
  editedGeneratedFile,
  explainBuildFailure,
  finishExportedSource,
  leaveOutDrafts,
  isGeneratedReadme,
  leaveOutRetiredAssets,
  locatedPhotos,
  locationKeptNote,
  locationRemovedNote,
  namesFile,
  NameMatcher, namesIn,
  namesWholeFile,
  omittedAssetsWarning,
  readLibraryImage,
  projectFingerprint,
  projectInventory,
  inventoryChanged,
  projectReadme,
  type ExportHashes,
  pruneWebsiteAssets,
  publishFolder,
  sectionLinkWarnings,
  uncleanablePhotosMessage,
  uniqueChild,
  variantCredits
} from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';
import { cleanPhoto } from '../../src/main/project/photo-metadata';
import { EOI, IMAGE_DATA, JFIF, PNG_SIG, IHDR, IDAT, IEND, SOI, app, ascii, cameraExif, chunk, exifSeg, geotaggedJpeg, readTiff, seg, tiff } from './fixtures/photos';

/**
 * The ZIP writer's compressor runs as normal, but a test can see every input it was given and hold one: `hold`
 * returns true to take over that call, and the export then waits until the test calls `finish`.
 */
const compressor = vi.hoisted(() => ({
  inputs: [] as Buffer[],
  hold: null as null | ((input: Buffer, finish: (error?: Error) => void) => boolean)
}));
vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  const deflateRaw = (input: Buffer, ...rest: unknown[]) => {
    const callback = rest.pop() as (error: Error | null, result?: Buffer) => void;
    const run = () => zlib.deflateRaw(input, (rest[0] ?? {}) as import('node:zlib').ZlibOptions, callback);
    compressor.inputs.push(input);
    if (!compressor.hold?.(input, (error) => (error ? callback(error) : run()))) run();
  };
  return { ...zlib, deflateRaw };
});

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-export-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  compressor.inputs = [];
  compressor.hold = null;
});
const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/**
 * A minimal reader: every entry's name and inflated content, checked against its CRC and sizes, with the local
 * header agreeing with the central one. `methods` collects each entry's compression method.
 */
function readZip(buf: Buffer, methods = new Map<string, number>()): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(offset + 26);
    const data = buf.subarray(offset + 30 + localNameLen, offset + 30 + localNameLen + csize);
    const body = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(crc32(body) >>> 0).toBe(crc);
    expect(body.length).toBe(size);
    const local = [buf.readUInt16LE(offset + 8), buf.readUInt32LE(offset + 14), buf.readUInt32LE(offset + 18), buf.readUInt32LE(offset + 22)];
    expect(local, `${name}: the local header agrees with the central one`).toEqual([method, crc, csize, size]);
    out.set(name, body);
    methods.set(name, method);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

describe('ZIP export', () => {
  it('writes a valid archive with nested and UTF-8 paths', async () => {
    const src = temp();
    write(src, 'index.html', '<h1>Hello</h1>'.repeat(50));
    write(src, 'about/index.html', 'About');
    write(src, 'assets/café.txt', 'crème');
    write(src, 'empty.txt', '');
    const noise = randomBytes(4096);
    writeFileSync(join(src, 'noise.bin'), noise);
    const zip = join(temp(), 'site.zip');
    const r = await zipDirectory(src, zip);
    expect(r.files).toBe(5);
    const methods = new Map<string, number>();
    const entries = readZip(readFileSync(zip), methods);
    expect([...entries.keys()].sort()).toEqual(['about/index.html', 'assets/café.txt', 'empty.txt', 'index.html', 'noise.bin']);
    expect(entries.get('index.html')!.toString()).toBe('<h1>Hello</h1>'.repeat(50));
    expect(entries.get('assets/café.txt')!.toString()).toBe('crème');
    expect(entries.get('noise.bin')!.equals(noise)).toBe(true);
    // Deflated where it shrinks the file, stored where it wouldn't.
    expect(methods.get('index.html')).toBe(8);
    expect(methods.get('noise.bin')).toBe(0);
    expect(methods.get('empty.txt')).toBe(0);
    // The system's own unzip agrees, where one is available.
    const check = spawnSync('unzip', ['-tq', zip], { encoding: 'utf8' });
    if (!check.error) expect(check.status, check.stdout + check.stderr).toBe(0);
  });

  it('puts entries under a top-level folder and leaves no temporary file behind', async () => {
    const src = temp();
    write(src, 'package.json', '{}');
    const out = temp();
    const zip = join(out, 'project.zip');
    await zipDirectory(src, zip, 'my-site-source');
    expect([...readZip(readFileSync(zip)).keys()]).toEqual(['my-site-source/package.json']);
    expect(readdirSync(out)).toEqual(['project.zip']);
  });

  it('keeps an existing ZIP intact and leaves nothing behind when the export fails', async () => {
    const out = temp();
    const zip = join(out, 'site.zip');
    writeFileSync(zip, 'previous export');
    await expect(zipDirectory(join(out, 'missing'), zip)).rejects.toThrow();
    await expect(zipDirectory(temp(), zip, '../escape')).rejects.toThrow(/folder name/);
    expect(readFileSync(zip, 'utf8')).toBe('previous export');
    expect(readdirSync(out)).toEqual(['site.zip']);
  });

  it('compresses off the main thread, publishing nothing until the archive is complete', async () => {
    const src = temp();
    const text = JSON.stringify({ text: 'compressible '.repeat(10000) });
    write(src, 'data.json', text);
    const out = temp();
    const zip = join(out, 'site.zip');
    writeFileSync(zip, 'previous export');
    let finish!: (error?: Error) => void;
    const compressing = new Promise<string>((resolve) => {
      compressor.hold = (_, f) => ((finish = f), resolve('compressing'), true);
    });
    const exporting = zipDirectory(src, zip);
    // A synchronous compressor would finish the whole export before handing anything off.
    expect(await Promise.race([compressing, exporting.then(() => 'finished')])).toBe('compressing');
    expect(readFileSync(zip, 'utf8')).toBe('previous export');
    finish();
    await exporting;
    const methods = new Map<string, number>();
    expect(readZip(readFileSync(zip), methods).get('data.json')!.toString()).toBe(text);
    expect(methods.get('data.json')).toBe(8);
    expect(readdirSync(out)).toEqual(['site.zip']);
  });

  it('keeps an existing ZIP intact when compression fails partway through', async () => {
    const src = temp();
    write(src, 'a.txt', 'first entry, written before the failure');
    write(src, 'b.txt', 'second entry');
    const out = temp();
    const zip = join(out, 'site.zip');
    writeFileSync(zip, 'previous export');
    compressor.hold = (input, finish) => input.toString() === 'second entry' && (setImmediate(() => finish(new Error('compressor failed'))), true);
    await expect(zipDirectory(src, zip)).rejects.toThrow('compressor failed');
    expect(compressor.inputs.map(String)).toEqual(['first entry, written before the failure', 'second entry']);
    expect(readFileSync(zip, 'utf8')).toBe('previous export');
    expect(readdirSync(out)).toEqual(['site.zip']);
  });

  it('stores already-compressed media as it is and compresses everything else', async () => {
    const src = temp();
    // Deliberately compressible content, so only the file type decides. Each file starts with its own name.
    const body = (f: string) => `${f}\n${'x'.repeat(20000)}`;
    const media = ['photo.png', 'PHOTO.JPG', 'img/hero.jpeg', 'img/hero-480.webp', 'img/hero.avif', 'anim.gif', 'fonts/inter.woff2', 'fonts/old.woff', 'clip.mp4', 'clip.webm', 'audio.mp3', 'data.json.gz', 'app.js.br'];
    // A ZIP may hold stored entries, so it is compressed like any other file.
    const text = ['index.html', 'logo.svg', 'app.css', 'data.json', 'bundle.zip'];
    for (const f of [...media, ...text]) write(src, f, body(f));
    const zip = join(temp(), 'media.zip');
    await zipDirectory(src, zip);
    const methods = new Map<string, number>();
    const entries = readZip(readFileSync(zip), methods);
    for (const f of [...media, ...text]) expect(entries.get(f)!.toString(), f).toBe(body(f));
    for (const f of media) expect(methods.get(f), f).toBe(0);
    for (const f of text) expect(methods.get(f), f).toBe(8);
    // Media never reaches the compressor at all.
    expect(compressor.inputs.map((b) => b.toString().split('\n')[0]).sort()).toEqual([...text].sort());
    const check = spawnSync('unzip', ['-tq', zip], { encoding: 'utf8' });
    if (!check.error) expect(check.status, check.stdout + check.stderr).toBe(0);
  });

  it('keeps executable scripts executable', async () => {
    const src = temp();
    write(src, 'run.sh', '#!/bin/sh');
    chmodSync(join(src, 'run.sh'), 0o755);
    write(src, 'index.html', 'x');
    const zip = join(temp(), 'p.zip');
    await zipDirectory(src, zip);
    const list = spawnSync('unzip', ['-Z', zip], { encoding: 'utf8' });
    if (!list.error) {
      expect(list.stdout).toMatch(/-rwxr-xr-x.*run\.sh/);
      expect(list.stdout).toMatch(/-rw-r--r--.*index\.html/);
    }
  });
});

describe('website export assets', () => {
  const image = (id: string, file: string, variants: string[] = []): AssetRecord => ({ id, name: `${id}.${file.split('.').pop()}`, file, mime: file.endsWith('.jpg') ? 'image/jpeg' : 'image/svg+xml', bytes: 1, width: 1000, height: 500, hash: 'x', kind: 'image', variants: variants.map((f, i) => ({ width: Number(/-(\d+)w\./.exec(f)?.[1] ?? 480 * (i + 1)), file: f })), createdAt: '' });
  /** Put an asset into the first image slot of the home page. */
  const place = (state: ProjectState, assetId: string) => {
    const home = state.pages[state.site.homePageId];
    const slot = JSON.stringify(home.nodes).includes('"assetId":null');
    expect(slot, 'the starter has an empty image slot').toBe(true);
    const walk = (v: unknown): boolean => {
      if (!v || typeof v !== 'object') return false;
      const o = v as Record<string, unknown>;
      if ('assetId' in o && o.assetId === null) return ((o.assetId = assetId), true);
      return Object.values(o).some(walk);
    };
    walk(home.nodes);
  };

  it('leaves library files no page uses out of the website, and says which', async () => {
    const state = createStarterState('business', 'Test', false);
    state.site.baseUrl = 'https://example.com';
    const assets: AssetRecord[] = [
      // Its WebP set, which the page offers before the JPEG copies, ships with it.
      image('placed', 'static/assets/big-sketch-12345678.jpg', ['static/assets/big-sketch-12345678-480w.jpg', 'static/assets/big-sketch-12345678-480w.webp', 'static/assets/big-sketch-12345678-1000w.webp']),
      // Never placed: its name is part of the placed file's name, which must not count as a use.
      image('draft', 'static/assets/sketch-12345678.jpg', ['static/assets/sketch-12345678-480w.jpg', 'static/assets/sketch-12345678-1000w.webp']),
      image('favicon', 'static/assets/mark-aaaaaaaa.svg'),
      image('social', 'static/assets/share-bbbbbbbb.svg'),
      image('coded', 'static/assets/gallery-cccccccc.svg'),
      image('manifest', 'static/assets/app-icon-dddddddd.svg'),
      // Code uses only its narrow copy: the original goes, the record still ships.
      image('partial', 'static/assets/banner-77777777.svg', ['static/assets/banner-77777777-480w.svg']),
      // A library file named before the importer added hashes: still the library's, so still left out when unused.
      image('legacy', 'static/assets/old-draft.svg'),
      { id: 'font', name: 'Brand Sans', file: 'static/assets/brand-sans-eeeeeeee.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font', createdAt: '', font: { family: 'Brand Sans', weight: '400', style: 'normal' } }
    ];
    for (const a of assets) state.assets.assets[a.id] = a;
    place(state, 'placed');
    state.site.favicon = 'favicon';
    state.site.socialImage = 'social';
    state.components['code.x'] = { ...Object.values(state.components)[0], id: 'code.x', kind: 'code', sourcePath: 'src/lib/siteorigin/custom/Gallery.svelte', source: '<img src="/assets/gallery-cccccccc.svg" alt="" /><img src="/assets/no-record-ffffffff.svg" alt="" /><img src="/assets/banner-77777777-480w.svg" alt="" />' };
    expect(assetUsages(state).draft, 'the panel shows the draft as not used').toBeUndefined();

    const dir = temp();
    for (const [path, text] of generateProject(state)) write(dir, path, text);
    for (const a of assets) for (const f of [a.file, ...(a.variants ?? []).map((v) => v.file)]) write(dir, f, '<svg/>');
    for (const f of ['static/assets/no-record-ffffffff.svg', 'static/assets/deleted-99999999.svg', 'static/assets/my-own-file.pdf']) write(dir, f, 'x');
    write(dir, 'static/site.webmanifest', JSON.stringify({ icons: [{ src: '/assets/app-icon-dddddddd.svg' }] }));
    // The authoring documents list every asset, and the README is not part of the site: neither is a use.
    write(dir, 'siteorigin/assets.json', JSON.stringify(state.assets));
    write(dir, 'siteorigin.project.json', JSON.stringify({ cover: 'static/assets/sketch-12345678.jpg' }));
    write(dir, 'README.md', 'Drafts: sketch-12345678.jpg, old-draft.svg');

    const omitted = await pruneWebsiteAssets(dir, state);
    const left = (f: string) => existsSync(join(dir, f));
    expect(omitted.map((a) => a.id).sort()).toEqual(['draft', 'legacy']);
    for (const f of ['static/assets/sketch-12345678.jpg', 'static/assets/sketch-12345678-480w.jpg', 'static/assets/sketch-12345678-1000w.webp', 'static/assets/old-draft.svg', 'static/assets/deleted-99999999.svg', 'static/assets/banner-77777777.svg'])
      expect(left(f), f).toBe(false);
    for (const f of [
      'static/assets/big-sketch-12345678.jpg',
      'static/assets/big-sketch-12345678-480w.jpg',
      'static/assets/big-sketch-12345678-480w.webp',
      'static/assets/big-sketch-12345678-1000w.webp',
      'static/assets/mark-aaaaaaaa.svg',
      'static/assets/share-bbbbbbbb.svg',
      'static/assets/gallery-cccccccc.svg',
      'static/assets/app-icon-dddddddd.svg',
      'static/assets/banner-77777777-480w.svg',
      'static/assets/brand-sans-eeeeeeee.woff2',
      'static/assets/no-record-ffffffff.svg',
      'static/assets/my-own-file.pdf',
      'siteorigin/assets.json'
    ])
      expect(left(f), f).toBe(true);
    expect(omittedAssetsWarning(omitted)).toBe("Left out of the website because no page or code refers to them: draft.jpg, legacy.svg. They stay in the project's assets.");
  });

  it('lists every asset it left out, and says nothing when it left none out', () => {
    expect(omittedAssetsWarning([])).toBeUndefined();
    expect(omittedAssetsWarning([image('a', 'static/assets/a-aaaaaaaa.svg')])).toBe("Left out of the website because no page or code refers to it: a.svg. It stays in the project's assets.");
    const many = ['g', 'b', 'f', 'a', 'e', 'c', 'd'].map((n) => image(n, `static/assets/${n}-aaaaaaaa.svg`));
    expect(omittedAssetsWarning(many)).toBe("Left out of the website because no page or code refers to them: a.svg, b.svg, c.svg, d.svg, e.svg, f.svg, g.svg. They stay in the project's assets.");
  });

  it('reads nothing and removes nothing when the library is empty', async () => {
    const dir = temp();
    write(dir, 'static/assets/my-own-file.pdf', 'x');
    expect(await pruneWebsiteAssets(dir, createStarterState('blank', 'Test', false))).toEqual([]);
    expect(existsSync(join(dir, 'static/assets/my-own-file.pdf'))).toBe(true);
  });

  it('#1450: names the files only drafts use, a draft photo whole, and never one the website or nothing uses', async () => {
    let state = createStarterState('business', 'Test', false);
    state.site.baseUrl = 'https://example.com';
    const doc = (id: string, file: string, mime: string): AssetRecord => ({ id, name: `${id} file`, file, mime, bytes: 1, hash: 'x', kind: 'document', createdAt: '' });
    const assets: AssetRecord[] = [
      // On the draft only: held whole, with the AVIF copy its page never names (there is no full-width AVIF to offer).
      image('sketch', 'static/assets/sketch-12345678.jpg', ['static/assets/sketch-12345678-480w.jpg', 'static/assets/sketch-12345678-480w.webp', 'static/assets/sketch-12345678-1000w.webp', 'static/assets/sketch-12345678-480w.avif']),
      // On the draft, and public code shows its narrow copy: that copy stays for the website, the rest is held.
      image('banner', 'static/assets/banner-77777777.jpg', ['static/assets/banner-77777777-480w.webp', 'static/assets/banner-77777777-1000w.webp']),
      // Nothing uses it: it stays, as the editable project keeps its library.
      image('spare', 'static/assets/spare-aaaaaaaa.svg'),
      // Linked from the draft; the older format beside it, with the same name before its extension, is used by nothing.
      doc('offer', 'static/assets/offer-1a2b3c4d.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      doc('old', 'static/assets/offer-1a2b3c4d.doc', 'application/msword'),
      // Shown only by a component of the project's own that the draft alone places.
      image('boxed', 'static/assets/gallery-cccccccc.svg'),
      // Used by nothing by its ID; only one of its copies is named below, by the drafts' text alone.
      image('leaflet', 'static/assets/leaflet-dddddddd.jpg', ['static/assets/leaflet-dddddddd-480w.webp', 'static/assets/leaflet-dddddddd-1000w.webp'])
    ];
    const draft = { kind: 'page' as const, id: 'pg_draft01' };
    state = applyOperations(state, [
      ...assets.map((asset) => ({ type: 'asset.add' as const, asset })),
      { type: 'page.create', pageId: 'pg_draft01', title: 'Soon' },
      { type: 'page.update', pageId: 'pg_draft01', draft: true },
      { type: 'node.insert', owner: draft, primitive: 'image', newNodeId: 'n_sketch' },
      { type: 'node.setContent', owner: draft, nodeId: 'n_sketch', field: 'image', value: { assetId: 'sketch', alt: 'Sketch' } },
      { type: 'node.insert', owner: draft, primitive: 'image', newNodeId: 'n_banner' },
      { type: 'node.setContent', owner: draft, nodeId: 'n_banner', field: 'image', value: { assetId: 'banner', alt: 'Banner' } },
      { type: 'node.insert', owner: draft, primitive: 'button', newNodeId: 'n_offer', text: 'Offer' },
      { type: 'node.setContent', owner: draft, nodeId: 'n_offer', field: 'link', value: { type: 'document', target: 'offer' } },
      { type: 'node.insert', owner: draft, primitive: 'container', newNodeId: 'n_box' },
      { type: 'node.insert', owner: draft, parentId: 'n_box', primitive: 'image', newNodeId: 'n_boxed' },
      { type: 'node.setContent', owner: draft, nodeId: 'n_boxed', field: 'image', value: { assetId: 'boxed', alt: 'Gallery' } },
      { type: 'component.createFromNode', owner: draft, nodeId: 'n_box', name: 'Gallery box' }
    ] as EditOperation[]).state;
    const base = { ...Object.values(state.components)[0], kind: 'code', tree: undefined };
    state.components['code.public'] = { ...base, id: 'code.public', name: 'Strip', sourcePath: 'src/lib/siteorigin/custom/Strip.svelte', source: '<img src="/assets/banner-77777777-480w.webp" alt="" />' } as ComponentDefinition;
    state = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: state.site.homePageId }, definitionId: 'code.public', newNodeId: 'n_strip' }] as EditOperation[]).state;

    // The project's generated files, with the drafts, left out as an export leaves them: what the drafts add to them
    // is what leaveOutDrafts gives back.
    const dir = temp();
    const full = generateProject(state, { instrument: false });
    for (const [path, text] of full) write(dir, path, text);
    write(dir, 'siteorigin/generated-manifest.json', JSON.stringify({ files: Object.fromEntries([...full].map(([path, text]) => [path, sha(text)])) }));
    for (const a of assets) for (const f of [a.file, ...(a.variants ?? []).map((v) => v.file)]) write(dir, f, 'x');
    write(dir, 'siteorigin/assets.json', JSON.stringify(state.assets));
    const drafts = new Map<string, string>();
    await leaveOutDrafts(dir, state, undefined, drafts);
    expect(existsSync(join(dir, 'src/routes/soon/+page.svelte')), 'the copy has no page for the draft').toBe(false);
    expect(drafts.get('src/routes/soon/+page.svelte'), 'the draft’s page is among what the drafts add').toBe(full.get('src/routes/soon/+page.svelte'));

    const held = [
      'static/assets/banner-77777777-1000w.webp',
      'static/assets/banner-77777777.jpg',
      'static/assets/gallery-cccccccc.svg',
      'static/assets/offer-1a2b3c4d.docx',
      'static/assets/sketch-12345678-1000w.webp',
      'static/assets/sketch-12345678-480w.avif',
      'static/assets/sketch-12345678-480w.jpg',
      'static/assets/sketch-12345678-480w.webp',
      'static/assets/sketch-12345678.jpg'
    ];
    expect(await draftOnlyAssetFiles(dir, state, drafts)).toEqual(held);
    // Without the drafts' text, the same: the records the draft uses by their IDs, and the picture of the component
    // only it places, whose file the website never reaches. The component's picture is in its definition, which the
    // published site keeps, so only its file says the draft alone shows it.
    expect(await draftOnlyAssetFiles(dir, state, new Map())).toEqual(held);
    // A file the drafts' text names, and no draft uses by its ID, is held too, with the rest of its record; the search
    // index's words are no use, and a file no record lists is never held, since an opening would never put it back.
    write(dir, 'static/assets/stray-eeeeeeee.svg', 'x');
    const named = new Map([
      ['src/routes/soon/+page.svelte', '<a href="/assets/spare-aaaaaaaa.svg">Spare</a><img src="/assets/leaflet-dddddddd-480w.webp" alt="" /><img src="/assets/stray-eeeeeeee.svg" alt="" />'],
      [`${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`, 'export default ["offer-1a2b3c4d.doc"];']
    ]);
    expect(await draftOnlyAssetFiles(dir, state, named)).toEqual(
      [...held, 'static/assets/leaflet-dddddddd-1000w.webp', 'static/assets/leaflet-dddddddd-480w.webp', 'static/assets/leaflet-dddddddd.jpg', 'static/assets/spare-aaaaaaaa.svg'].sort()
    );
    // Code of the published site's that imports the component only the draft places makes it the website's, and its picture too.
    const box = Object.values(state.components).find((d) => d.name === 'Gallery box')!;
    write(dir, 'src/lib/Showcase.svelte', `<script>\n\timport Box from '$lib/${defFile(box).replace(/^src\/lib\//, '')}';\n</script>\n\n<Box />\n`);
    expect(await draftOnlyAssetFiles(dir, state, drafts)).toEqual(held.filter((f) => f !== 'static/assets/gallery-cccccccc.svg'));
    rmSync(join(dir, 'src/lib/Showcase.svelte'));
    // On a disk that ignores case, the copy may spell a record's file otherwise: it is still that record's.
    if (existsSync(join(dir, 'STATIC/ASSETS/OFFER-1A2B3C4D.DOCX'))) {
      const { renameSync } = await import('node:fs');
      renameSync(join(dir, 'static/assets/offer-1a2b3c4d.docx'), join(dir, 'static/assets/Offer-1a2b3c4d.docx'));
      expect(await draftOnlyAssetFiles(dir, state, drafts)).toContain('static/assets/Offer-1a2b3c4d.docx');
    }
    // A project without drafts holds nothing back.
    expect(await draftOnlyAssetFiles(dir, publishedState(state), new Map())).toEqual([]);
    expect(heldDraftAssetsNote(state, ['static/assets/offer-1a2b3c4d.docx', 'static/assets/banner-77777777.jpg'])).toBe(
      'Files only drafts use are kept in siteorigin/draft-assets/ rather than static/assets/, so a build of the exported project leaves them out: banner.jpg and offer file. Opening the project in SiteOrigin Builder puts them back.'
    );
    expect(heldDraftAssetsNote(state, [])).toBeNull();
  });
});

describe('website photo privacy', () => {
  const photo = (id: string, name: string, file: string, variants: string[] = []): AssetRecord => ({ id, name, file, mime: 'image/jpeg', bytes: 1, width: 2000, height: 1200, hash: 'x', kind: 'image', variants: variants.map((f, i) => ({ width: Number(/-(\d+)w\./.exec(f)?.[1] ?? 480 * (i + 1)), file: f })), createdAt: '' });
  const plainJpeg = () => Buffer.concat([SOI, JFIF, IMAGE_DATA, EOI]);
  const writeBytes = (root: string, rel: string, data: Buffer) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), data);
  };

  it('cleans every image visitors can download, gives copies their credits, and leaves the rest alone', async () => {
    const state = createStarterState('blank', 'Test', false);
    const hero = photo('hero', 'Client house', 'static/assets/house-11111111.jpg', ['static/assets/house-11111111-480w.jpg', 'static/assets/house-11111111-960w.jpg']);
    const plain = photo('plain', 'Logo photo', 'static/assets/logo-22222222.jpg');
    state.assets.assets = { hero, plain };
    const dir = temp();
    writeBytes(dir, hero.file, geotaggedJpeg());
    for (const v of hero.variants!) writeBytes(dir, v.file, plainJpeg());
    writeBytes(dir, plain.file, plainJpeg());
    // A file outside the library, a picture imported by code under src/, and one named by its bytes alone.
    writeBytes(dir, 'static/og.png', Buffer.concat([PNG_SIG, IHDR, chunk('eXIf', cameraExif()), IDAT, IEND]));
    writeBytes(dir, 'src/lib/siteorigin/custom/team.jpeg', geotaggedJpeg(false, 1));
    writeBytes(dir, 'static/downloads/photo', geotaggedJpeg());
    // The page uses the photo itself; a code component uses only the narrow copy of another photo.
    const banner = photo('banner', 'Client garden', 'static/assets/garden-33333333.jpg', ['static/assets/garden-33333333-480w.jpg']);
    state.assets.assets.banner = banner;
    writeBytes(dir, banner.file, geotaggedJpeg());
    writeBytes(dir, banner.variants![0].file, plainJpeg());
    write(dir, 'src/routes/+page.svelte', '<img src="/assets/house-11111111.jpg" srcset="/assets/house-11111111-480w.jpg 480w, /assets/house-11111111-960w.jpg 960w" alt="" /><img src="/assets/logo-22222222.jpg" alt="" />');
    write(dir, 'src/lib/siteorigin/custom/Banner.svelte', '<img src="/assets/garden-33333333-480w.jpg" alt="" />');

    // The order the website export uses: credits first, then pruning, which removes the garden original.
    const credits = await variantCredits(dir, state);
    await pruneWebsiteAssets(dir, state);
    expect(existsSync(join(dir, banner.file))).toBe(false);
    const before = readFileSync(join(dir, plain.file));
    const result = await cleanWebsitePhotos(dir, state, credits);
    expect(result).toEqual({ located: ['Client house', 'src/lib/siteorigin/custom/team.jpeg', 'static/downloads/photo', 'static/og.png'], failed: [] });

    for (const f of [hero.file, 'static/og.png', 'src/lib/siteorigin/custom/team.jpeg', 'static/downloads/photo']) {
      const bytes = readFileSync(join(dir, f));
      expect(bytes.toString('latin1'), f).not.toMatch(/GPS|SERIAL|Acme|Springfield/);
      expect(cleanPhoto(bytes)!.changed, f).toBe(false);
    }
    const original = readTiff(app(readFileSync(join(dir, hero.file)), 0xe1, 'Exif\0\0')!);
    expect(original.short(original.ifd0, 0x0112)).toBe(6);
    for (const v of [...hero.variants!, ...banner.variants!]) {
      const copy = readFileSync(join(dir, v.file));
      const exif = readTiff(app(copy, 0xe1, 'Exif\0\0')!);
      expect(exif.text(exif.ifd0, 0x013b), v.file).toBe('Jane Doe Photography');
      expect(exif.ifd0.has(0x0112), v.file).toBe(false);
      expect(app(copy, 0xe1, 'http://ns.adobe.com/xap/1.0/\0')!.toString('utf8')).toContain('Jane Doe');
    }
    // Nothing private and no credits to give: left byte for byte.
    expect(readFileSync(join(dir, plain.file)).equals(before)).toBe(true);
    expect(readFileSync(join(dir, 'src/lib/siteorigin/custom/Banner.svelte'), 'utf8')).toBe('<img src="/assets/garden-33333333-480w.jpg" alt="" />');
  });

  it('names every image it could not clean, by asset name or path', async () => {
    const state = createStarterState('blank', 'Test', false);
    const broken = photo('broken', 'Broken scan', 'static/assets/scan-33333333.jpg');
    state.assets.assets = { broken };
    const dir = temp();
    writeBytes(dir, broken.file, Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x40, 0x00]), Buffer.from('Exif')]));
    write(dir, 'static/notes.jpg', 'this is text, not a picture');
    write(dir, 'static/readme.txt', 'plain text');
    const result = await cleanWebsitePhotos(dir, state, new Map());
    expect(result.failed).toEqual(['Broken scan', 'static/notes.jpg']);
    expect(uncleanablePhotosMessage(result.failed)).toBe('Photo location and camera details couldn’t be removed from Broken scan and static/notes.jpg, so the website was not exported. Replace them with a JPEG, PNG or WebP copy and export again.');
  });

  it('cleans every image in a finished build, and names what it cannot clean or rewrite', async () => {
    const dir = temp();
    const clean = cleanPhoto(geotaggedJpeg())!.data;
    // From a package: a comment holding an address, which no flag would report, still goes.
    writeBytes(dir, '_app/immutable/assets/pkg.abc123.jpg', Buffer.concat([SOI, seg(0xfe, Buffer.from('12 Main St')), JFIF, IMAGE_DATA, EOI]));
    writeBytes(dir, 'assets/already-clean.jpg', clean);
    writeBytes(dir, 'downloads/photo', geotaggedJpeg());
    write(dir, 'assets/broken.png', 'not a png');
    const dataUrl = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;
    write(dir, '_app/immutable/chunks/inline.js', `const a = "${dataUrl(geotaggedJpeg())}";`);
    write(dir, '_app/immutable/assets/fine.css', `.x{background:url(${dataUrl(clean)})}`);
    // A camera model only, percent-encoded; one behind character references; base64 broken over lines, which
    // reads as damaged and stops the export rather than guessing where the URL ends; and one the parser cannot read.
    const modelOnly = Buffer.concat([SOI, exifSeg(tiff(true, { ifd0: [ascii(0x0110, 'Phone X')] })), JFIF, IMAGE_DATA, EOI]);
    write(dir, 'styles/device.css', `.y{background:url(data:image/jpeg;base64,${modelOnly.toString('base64').replace(/\//g, '%2F')})}`);
    write(dir, 'entity.html', `<img src="data&#58;image&#x2F;jpeg;base64,${geotaggedJpeg().toString('base64')}">`);
    const wrapped = (clean.toString('base64').match(/.{1,76}/g) ?? []).join('\n');
    write(dir, 'styles/wrapped.css', `.z{background:url("data:image/jpeg;base64,${wrapped}")}`);
    write(dir, 'unreadable.html', `<img src="data:image/png;base64,${Buffer.from('not a png').toString('base64')}">`);
    write(dir, 'static-photo.tiff', 'II*\0 a TIFF this cannot rewrite');
    write(dir, 'index.html', '<html></html>');
    const failed = await cleanBuiltSite(dir);
    expect(failed.sort()).toEqual(['assets/broken.png', 'static-photo.tiff', 'styles/wrapped.css', 'unreadable.html']);
    // Inline images are cleaned where they are, and written back as plain base64.
    for (const f of ['_app/immutable/chunks/inline.js', 'styles/device.css', 'entity.html']) {
      const text = readFileSync(join(dir, f), 'utf8');
      const b64 = text.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)?.[1];
      expect(b64, f).toBeDefined();
      const bytes = Buffer.from(b64!, 'base64');
      expect(bytes.toString('latin1'), f).not.toMatch(/GPS|SERIAL|Phone X|Acme/);
      expect(cleanPhoto(bytes)!.changed, f).toBe(false);
    }
    expect(readFileSync(join(dir, 'styles/wrapped.css'), 'utf8')).toContain(wrapped);
    expect(readFileSync(join(dir, '_app/immutable/assets/pkg.abc123.jpg')).toString('latin1')).not.toContain('Main St');
    expect(readFileSync(join(dir, 'downloads/photo')).toString('latin1')).not.toMatch(/GPS|SERIAL/);
    expect(readFileSync(join(dir, 'assets/already-clean.jpg')).equals(clean)).toBe(true);
  });

  it('rewrites a page’s precompressed copies with it, and keeps its other bytes exactly', async () => {
    const dir = temp();
    const page = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>Caf\xe9</p><img src="data:image/jpeg;base64,', 'latin1'), Buffer.from(geotaggedJpeg().toString('base64')), Buffer.from('">')]);
    writeBytes(dir, 'index.html', page);
    writeBytes(dir, 'index.html.br', brotliCompressSync(page));
    writeBytes(dir, 'index.html.gz', gzipSync(page));
    expect(await cleanBuiltSite(dir)).toEqual([]);
    const cleaned = readFileSync(join(dir, 'index.html'));
    expect(cleaned.subarray(0, 41).equals(page.subarray(0, 41))).toBe(true);
    expect(cleaned.toString('latin1')).not.toContain(geotaggedJpeg().toString('base64').slice(0, 200));
    expect(brotliDecompressSync(readFileSync(join(dir, 'index.html.br'))).equals(cleaned)).toBe(true);
    expect(gunzipSync(readFileSync(join(dir, 'index.html.gz'))).equals(cleaned)).toBe(true);
  });

  it('reads each built file once, showing every page and script as the build wrote it, and cleans a picture named as a page', async () => {
    const dir = temp();
    const page = `<html lang="en"><img src="data:image/jpeg;base64,${geotaggedJpeg().toString('base64')}"></html>`;
    write(dir, 'index.html', page);
    write(dir, '_app/start.js', 'console.log(1)');
    write(dir, 'robots.txt', 'User-agent: *');
    // A photo the build wrote under a page's name: cleaned as a photo, and then as a page.
    writeBytes(dir, 'disguised.html', geotaggedJpeg());
    const seen: Array<[string, string]> = [];
    expect(await cleanBuiltSite(dir, (rel, bytes) => seen.push([rel, bytes.toString('latin1')]))).toEqual([]);
    expect(seen.map(([rel]) => rel).sort()).toEqual(['_app/start.js', 'disguised.html', 'index.html']);
    // What the checks see is the build's own, before any picture in it is cleaned.
    expect(seen.find(([rel]) => rel === 'index.html')![1]).toBe(page);
    expect(seen.find(([rel]) => rel === 'disguised.html')![1]).toBe(geotaggedJpeg().toString('latin1'));
    expect(readFileSync(join(dir, 'index.html'), 'latin1')).not.toContain(geotaggedJpeg().toString('base64').slice(0, 200));
    expect(readFileSync(join(dir, 'disguised.html')).toString('latin1')).not.toContain('SERIAL');
  });

  it.skipIf(process.platform === 'win32')('names a built file it cannot read as an image first, then as a file that can hold one', async () => {
    const dir = temp();
    write(dir, 'a.png', 'not a png');
    write(dir, 'b.css', `.x{background:url(data:image/png;base64,${Buffer.from('not a png').toString('base64')})}`);
    write(dir, 'c.html', '<html></html>');
    chmodSync(join(dir, 'c.html'), 0o000);
    try {
      expect(await cleanBuiltSite(dir)).toEqual(process.getuid?.() === 0 ? ['a.png', 'b.css'] : ['a.png', 'c.html', 'b.css', 'c.html']);
    } finally {
      chmodSync(join(dir, 'c.html'), 0o644);
    }
  });

  it('replaces a built file linked from elsewhere instead of writing through the link', async () => {
    const dir = temp();
    const outside = join(temp(), 'original.jpg');
    writeFileSync(outside, geotaggedJpeg());
    mkdirSync(join(dir, 'assets'));
    linkSync(outside, join(dir, 'assets/linked.jpg'));
    expect(await cleanBuiltSite(dir)).toEqual([]);
    expect(readFileSync(outside).equals(geotaggedJpeg())).toBe(true);
    expect(readFileSync(join(dir, 'assets/linked.jpg')).toString('latin1')).not.toContain('SERIAL');
    expect(builtPhotosMessage(['a.png'])).toBe('a.png in the built website couldn’t be checked for photo location and camera details, so the website was not exported.');
  });

  it('reads a library image only from a regular file directly in static/assets', async () => {
    const dir = temp();
    writeBytes(dir, 'static/assets/ok-11111111.jpg', geotaggedJpeg());
    writeBytes(dir, 'outside.jpg', geotaggedJpeg());
    symlinkSync(join(dir, 'outside.jpg'), join(dir, 'static/assets/link-22222222.jpg'));
    const at = (file: string, kind: 'image' | 'font' = 'image') => readLibraryImage(dir, { ...photo('x', 'X', file), kind });
    expect(await at('static/assets/ok-11111111.jpg')).not.toBeNull();
    expect(await at('static/assets/../../outside.jpg')).toBeNull();
    expect(await at('static/assets/link-22222222.jpg')).toBeNull();
    expect(await at('outside.jpg')).toBeNull();
    expect(await at('static/assets/ok-11111111.jpg', 'font')).toBeNull();
  });

  it('names the library photos an editable project keeps with their location', async () => {
    const state = createStarterState('blank', 'Test', false);
    state.assets.assets = { a: photo('a', 'Kitchen', 'static/assets/kitchen-44444444.jpg'), b: photo('b', 'Logo', 'static/assets/logo-55555555.jpg') };
    const dir = temp();
    writeBytes(dir, 'static/assets/kitchen-44444444.jpg', geotaggedJpeg());
    writeBytes(dir, 'static/assets/logo-55555555.jpg', plainJpeg());
    expect(await locatedPhotos(dir, state)).toEqual(['Kitchen']);
  });

  it('words the export notes for one photo and for several', () => {
    expect(locationRemovedNote([])).toBeUndefined();
    expect(locationRemovedNote(['Kitchen'])).toBe('The website leaves out where Kitchen was taken. The original in your project keeps its location.');
    expect(locationRemovedNote(['Hall', 'Kitchen', 'Patio'])).toBe('The website leaves out where these photos were taken: Hall, Kitchen and Patio. The originals in your project keep their locations.');
    expect(locationKeptNote([])).toBeUndefined();
    expect(locationKeptNote(['Kitchen'])).toBe('Kitchen still records where it was taken. The editable project keeps photos exactly as imported; export Website files to leave locations out.');
    expect(locationKeptNote(['Hall', 'Kitchen'])).toBe('Hall and Kitchen still record where they were taken. The editable project keeps photos exactly as imported; export Website files to leave locations out.');
  });
});

describe('source export helpers', () => {
  it('keeps every library image, used or not, but no deleted image, private file or link', async () => {
    const state = createStarterState('business', 'Test', false);
    state.assets.assets['a1'] = { id: 'a1', name: 'Kept', file: 'static/assets/kept-aaaaaaaa.jpg', mime: 'image/jpeg', bytes: 1, width: 1000, height: 500, hash: 'x', kind: 'image', variants: [{ width: 480, file: 'static/assets/kept-aaaaaaaa-480w.jpg' }], createdAt: '' };
    const src = temp();
    for (const f of ['static/assets/kept-aaaaaaaa.jpg', 'static/assets/kept-aaaaaaaa-480w.jpg', 'static/assets/deleted-bbbbbbbb.jpg', 'static/assets/deleted-bbbbbbbb-480w.jpg', 'static/assets/used-by-code-cccccccc.png', 'static/assets/drafted-eeeeeeee.png', 'static/assets/fed-ffffffff.png', 'static/assets/my-own-file.pdf', 'static/assets/docs/guide-dddddddd.pdf', 'static/favicon.svg', 'src/routes/+page.svelte', '.env', 'package.json'])
      write(src, f, f);
    write(src, 'src/lib/components/X.svelte', '<img src="/assets/used-by-code-cccccccc.png" alt="" />');
    // A draft's authoring document names one deleted image, a source's converter another (#1391).
    write(src, 'siteorigin/pages/draft.json', '{"background":"/assets/drafted-eeeeeeee.png"}');
    symlinkSync(join(src, 'package.json'), join(src, 'static', 'linked.json'));
    const dest = join(temp(), 'out');
    await copyProjectSource(src, dest);
    write(dest, 'siteorigin/sources/feed/converter.mjs', "export default (item) => ({ ...item, image: '/assets/fed-ffffffff.png' });");
    expect((await leaveOutRetiredAssets(dest, state, { authoring: false })).sort()).toEqual(['static/assets/deleted-bbbbbbbb-480w.jpg', 'static/assets/deleted-bbbbbbbb.jpg', 'static/assets/drafted-eeeeeeee.png']);
    expect(existsSync(join(dest, 'static/assets/kept-aaaaaaaa.jpg'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/kept-aaaaaaaa-480w.jpg'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/deleted-bbbbbbbb.jpg'))).toBe(false);
    expect(existsSync(join(dest, 'static/assets/deleted-bbbbbbbb-480w.jpg'))).toBe(false);
    expect(existsSync(join(dest, 'static/assets/drafted-eeeeeeee.png'))).toBe(false);
    // Files nobody imported through the app are the owner's, and the site's code and converters may use any public file.
    expect(existsSync(join(dest, 'static/assets/used-by-code-cccccccc.png'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/fed-ffffffff.png'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/my-own-file.pdf'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/docs/guide-dddddddd.pdf'))).toBe(true);
    expect(existsSync(join(dest, 'static/favicon.svg'))).toBe(true);
    expect(existsSync(join(dest, '.env'))).toBe(false);
    expect(existsSync(join(dest, 'static/linked.json'))).toBe(false);
    expect(existsSync(join(dest, '.npmrc'))).toBe(false);
  });

  it('leaves out of a duplicate only the imported files no record lists and nothing it carries names (#1378)', async () => {
    const state = createStarterState('blank', 'Test', false);
    // Documents are named for the hash of their bytes, as the importer names them.
    const doc = (slug: string, text: string, ext = 'pdf') => ({ rel: `static/assets/${slug}-${sha(text).slice(0, 8)}.${ext}`, text });
    const current = doc('guide', 'Second edition.');
    const retired = doc('guide', 'First edition.');
    const briefing = doc('briefing', 'Press briefing.');
    const prices = doc('price-list', 'Prices.');
    const offer = doc('offer', 'Offer.', 'doc');
    const card = doc('rate-card', 'Rate card.');
    const catalogued = doc('catalogue', 'Catalogue.');
    const redirected = doc('old-terms', 'Old terms.');
    // A catalogue no record lists any more, which a page still fetches, and the download it lists; and one nothing
    // names, whose download goes with it.
    const listing = doc('listed', 'Listed download.');
    const catalogue = doc('catalogue-feed', `title,file\nListed,/assets/${basename(listing.rel)}\n`, 'csv');
    const unlisted = doc('unlisted', 'Unlisted download.');
    const stale = doc('stale-feed', `title,file\nUnlisted,/assets/${basename(unlisted.rel)}\n`, 'csv');
    const record = (id: string, file: string, variants?: string[]) => ({ id, name: id, file, mime: 'application/pdf', bytes: 1, hash: 'x', kind: 'document' as const, createdAt: '', ...(variants ? { variants: variants.map((f) => ({ width: 480, file: f })) } : {}) });
    // The project holds the guide, the price list, a picture (without the copy it has on disk) and one recorded under
    // another spelling of the folder; the folder's asset document (the one the copy carries) the guide, the briefing
    // and a picture with its copies, one of them by other hash characters. Its original name is a file on the
    // author's computer, which happens to share a retired picture's name.
    state.assets.assets = { g: record('g', current.rel), p: record('p', prices.rel), l: record('l', 'static/assets/lib-8192a3b4.jpg'), u: record('u', 'static/Assets/upper-c5d6e7f8.jpg') };
    const src = temp();
    write(src, 'siteorigin/assets.json', JSON.stringify({ assets: { g: { ...record('g', current.rel), originalName: 'old-5e6f7081.png' }, b: record('b', briefing.rel), h: record('h', 'static/assets/hall2-92a3b4c5.jpg', ['static/assets/hall2-92a3b4c5-480w.webp', 'static/assets/hall2-small-b4c5d6e7-480w.webp']) } }));
    for (const d of [current, retired, briefing, prices, offer, card, catalogued, redirected, listing, catalogue, unlisted, stale]) write(src, d.rel, d.text);
    const media = ['icon-1a2b3c4d.png', 'hall-2b3c4d5e.jpg', 'map-3c4d5e6f.svg', 'sketch-4d5e6f70.png', 'old-5e6f7081.png', 'deleted-6f708192.jpg', 'deleted-6f708192-480w.webp', 'linked-708192a3.png', 'lib-8192a3b4.jpg', 'lib-8192a3b4-960w.webp', 'hall2-92a3b4c5.jpg', 'hall2-92a3b4c5-480w.webp', 'photo-9a8b7c6d.jpg', 'photo-9a8b7c6d-480w.webp', 'binary-a3b4c5d6.png', 'hall2-small-b4c5d6e7-480w.webp', 'upper-c5d6e7f8.jpg', 'feed-d6e7f809.png', 'texture-e7f8091a.png'];
    for (const f of media) write(src, `static/assets/${f}`, f);
    // An owner's dated file that only looks imported (a catalogue a page fetches), one named otherwise, and one in a
    // folder of its own that has the hash its name gives.
    const nested = `static/assets/docs/manual-${sha('Manual.').slice(0, 8)}.pdf`;
    write(src, 'static/assets/downloads-20240131.csv', `title,file\nCatalogue,/assets/${basename(catalogued.rel)}\n`);
    for (const f of ['static/assets/rates-20240131.pdf', 'static/assets/my-own-file.pdf']) write(src, f, f);
    write(src, nested, 'Manual.');
    // Named by a public file, an authoring document, hand-written source (the offer as a .docx only, and a picture by
    // the parts of its address), and a rule with no extension.
    write(src, 'static/site.webmanifest', '{"icons":[{"src":"/assets/icon-1a2b3c4d.png"}]}');
    write(src, 'siteorigin/pages/home.json', '{"background":"/assets/hall-2b3c4d5e.jpg"}');
    write(src, 'src/routes/visit/+page.svelte', `<img src="/assets/map-3c4d5e6f.svg" alt="" /><a href="/assets/${basename(offer.rel)}x">Offer</a><a href="/assets/${basename(card.rel)}">Rates</a>\n<script>const base = '/assets/photo-' + '9a8b7c6d'; fetch('/assets/${basename(catalogue.rel)}');</script>`);
    write(src, 'static/_redirects', `/terms /assets/${basename(redirected.rel)} 301\n`);
    write(src, 'src/styles/site.scss', 'body { background: url(/assets/texture-e7f8091a.png); }');
    // Named only by the brief, by a file through a link (which no copy takes), by a file that isn't text, and by the
    // editor's own data: none of them goes with the copy.
    write(src, 'siteorigin/brief.json', '{"notes":"Try /assets/sketch-4d5e6f70.png"}');
    const outside = temp();
    write(outside, 'linked/page.svelte', '<img src="/assets/linked-708192a3.png" alt="" />');
    symlinkSync(join(outside, 'linked'), join(src, 'src/routes/linked'));
    write(src, 'static/brochure.png', '/assets/binary-a3b4c5d6.png');
    write(src, '.siteorigin/history.json', `["${basename(retired.rel)}"]`);

    const stage = async () => {
      const dest = join(temp(), 'copy');
      await copyProjectSource(src, dest, { keepBrief: true });
      // A source's converter, which the copy has written from the project's own settings before anything is left out.
      write(dest, 'siteorigin/sources/feed/converter.mjs', "export default (item) => ({ ...item, image: '/assets/feed-d6e7f809.png' });");
      return { dest, removed: await leaveOutRetiredAssets(dest, state) };
    };
    const { dest, removed } = await stage();
    const has = (rel: string) => existsSync(join(dest, rel));
    const at = (f: string) => `static/assets/${f}`;
    const kept = [current, briefing, prices, card, catalogued, redirected, catalogue, listing].map((d) => d.rel);
    kept.push(...['icon-1a2b3c4d.png', 'hall-2b3c4d5e.jpg', 'map-3c4d5e6f.svg', 'lib-8192a3b4.jpg', 'lib-8192a3b4-960w.webp', 'hall2-92a3b4c5.jpg', 'hall2-92a3b4c5-480w.webp', 'hall2-small-b4c5d6e7-480w.webp', 'upper-c5d6e7f8.jpg', 'photo-9a8b7c6d.jpg', 'photo-9a8b7c6d-480w.webp', 'feed-d6e7f809.png', 'texture-e7f8091a.png'].map(at));
    kept.push('static/assets/downloads-20240131.csv', 'static/assets/rates-20240131.pdf', 'static/assets/my-own-file.pdf', nested, 'static/site.webmanifest', 'static/_redirects', 'siteorigin/brief.json');
    for (const rel of kept) expect(has(rel), rel).toBe(true);
    const gone = [retired.rel, offer.rel, stale.rel, unlisted.rel, ...['sketch-4d5e6f70.png', 'old-5e6f7081.png', 'deleted-6f708192.jpg', 'deleted-6f708192-480w.webp', 'linked-708192a3.png', 'binary-a3b4c5d6.png'].map(at)];
    for (const rel of gone) expect(has(rel), rel).toBe(false);
    expect(removed.sort()).toEqual([...gone].sort());
    // The original keeps them all.
    for (const rel of gone) expect(existsSync(join(src, rel)), rel).toBe(true);

    // On a disk that tells case apart, a file of the site's own spelled like an imported one is searched as itself.
    const probe = temp();
    writeFileSync(join(probe, 'case'), '');
    if (!existsSync(join(probe, 'CASE'))) {
      const own = `static/assets/${basename(stale.rel).replace(/^stale/, 'Stale')}`;
      write(src, own, `/assets/${basename(unlisted.rel)}`);
      expect((await stage()).removed.sort()).toEqual(gone.filter((rel) => rel !== unlisted.rel).sort());
      rmSync(join(src, own));
    }

    // An asset document that can't be read for its files, or a file the search can't read, leaves every file.
    const everything = async () => expect((await stage()).removed).toEqual([]);
    write(src, 'siteorigin/assets.json', '{"assets":');
    await everything();
    write(src, 'siteorigin/assets.json', '{"assets":{}}');
    expect((await stage()).removed).toContain(retired.rel);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const copied = join(temp(), 'copy');
      await copyProjectSource(src, copied, { keepBrief: true });
      for (const rel of ['siteorigin/assets.json', 'src/routes/visit/+page.svelte']) {
        chmodSync(join(copied, rel), 0o000);
        try {
          expect(await leaveOutRetiredAssets(copied, state), rel).toEqual([]);
        } finally {
          chmodSync(join(copied, rel), 0o644);
        }
      }
      // A folder the original keeps read-only, or that its owner can't look into, is copied so, and still loses its
      // retired files, keeping its mode.
      for (const mode of [0o555, 0o655]) {
        write(copied, retired.rel, retired.text);
        chmodSync(join(copied, 'static/assets'), mode);
        try {
          expect(await leaveOutRetiredAssets(copied, state)).toContain(retired.rel);
          expect(statSync(join(copied, 'static/assets')).mode & 0o777).toBe(mode);
        } finally {
          chmodSync(join(copied, 'static/assets'), 0o755);
        }
        expect(existsSync(join(copied, retired.rel))).toBe(false);
      }
    }
  });

  it('finds generated files changed outside the app', async () => {
    const dir = temp();
    write(dir, 'src/routes/+page.svelte', 'page');
    write(dir, 'siteorigin/generated-manifest.json', JSON.stringify({ files: { 'src/routes/+page.svelte': sha('page') } }));
    expect(await editedGeneratedFile(dir)).toBeNull();
    write(dir, 'src/routes/+page.svelte', 'edited');
    expect(await editedGeneratedFile(dir)).toBe('src/routes/+page.svelte');
    rmSync(join(dir, 'siteorigin/generated-manifest.json'));
    expect(await editedGeneratedFile(dir)).toBe('siteorigin/generated-manifest.json');
  });

  it('publishes into a new folder only, and never touches one that already exists', async () => {
    const from = temp();
    write(from, 'index.html', 'new');
    const parent = temp();
    await publishFolder(from, join(parent, 'site'));
    expect(readFileSync(join(parent, 'site/index.html'), 'utf8')).toBe('new');
    write(parent, 'taken/keep.txt', 'mine');
    await expect(publishFolder(from, join(parent, 'taken'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(join(parent, 'taken/keep.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(parent, 'taken/index.html'))).toBe(false);
  });

  it('fingerprints static files as well as source', async () => {
    const dir = temp();
    write(dir, 'src/a.js', 'a');
    write(dir, 'static/robots.txt', 'x');
    const before = await projectFingerprint(dir);
    write(dir, 'static/robots.txt', 'y');
    expect(await projectFingerprint(dir)).not.toBe(before);
  });

  it.skipIf(process.platform === 'win32')('copies the source with its files’ and folders’ modes, into a folder already there, as fs.cp does', async () => {
    const src = temp();
    write(src, 'static/run.sh', '#!/bin/sh');
    chmodSync(join(src, 'static/run.sh'), 0o755);
    write(src, 'src/private/x.js', 'x');
    chmodSync(join(src, 'src/private'), 0o700);
    write(src, 'src/routes/+page.svelte', 'page');
    write(src, '.env', 'SECRET=1');
    symlinkSync(join(src, 'src/routes/+page.svelte'), join(src, 'src/linked.svelte'));
    const dest = temp();
    write(dest, '.siteorigin/preview-copy.json', '{}');
    await copyProjectSource(src, dest);
    expect(readFileSync(join(dest, 'src/routes/+page.svelte'), 'utf8')).toBe('page');
    expect(statSync(join(dest, 'static/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, 'src/private')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dest, 'src/private/x.js'), 'utf8')).toBe('x');
    expect(existsSync(join(dest, '.env'))).toBe(false);
    expect(existsSync(join(dest, 'src/linked.svelte'))).toBe(false);
    expect(readFileSync(join(dest, '.siteorigin/preview-copy.json'), 'utf8')).toBe('{}');
  });

  it('leaves Wrangler’s local secrets and state out of the source, folder and ZIP alike, and keeps the function and its settings (#1126)', async () => {
    const src = temp();
    for (const f of ['functions/api/hello.ts', 'wrangler.toml', 'wrangler.jsonc', 'worker/wrangler.json', 'worker/src/index.ts']) write(src, f, f);
    // Harmless sentinels standing in for local secrets and Wrangler's own state, at the top and beside a worker.
    const secret = ['.dev.vars', '.dev.vars.production', '.DEV.VARS.staging', 'worker/.dev.vars', 'functions/.dev.vars.preview', '.wrangler/state/v3/d1/db.sqlite', '.wrangler/tmp/bundle.js', 'worker/.wrangler/state/kv.bin', 'site/.Wrangler/cache/x.json'];
    for (const f of secret) write(src, f, 'SENTINEL_1126');
    for (const f of ['static/dev.vars.txt', 'static/my.wrangler']) write(src, f, f);
    const dest = join(temp(), 'out');
    await copyProjectSource(src, dest);
    for (const f of secret) expect(existsSync(join(dest, f)), f).toBe(false);
    for (const f of ['.wrangler', 'worker/.wrangler']) expect(existsSync(join(dest, f)), f).toBe(false);
    for (const f of ['functions/api/hello.ts', 'wrangler.toml', 'wrangler.jsonc', 'worker/wrangler.json', 'worker/src/index.ts', 'static/dev.vars.txt', 'static/my.wrangler']) expect(readFileSync(join(dest, f), 'utf8'), f).toBe(f);
    const zip = join(temp(), 'site.zip');
    await zipDirectory(dest, zip);
    const entries = readZip(readFileSync(zip));
    expect([...entries.keys()].filter((name) => /(^|\/)\.(dev\.vars|wrangler\/)/i.test(name))).toEqual([]);
    expect([...entries.values()].some((b) => b.toString('utf8').includes('SENTINEL_1126'))).toBe(false);
    for (const f of ['functions/api/hello.ts', 'wrangler.toml', 'wrangler.jsonc']) expect(entries.has(f), f).toBe(true);
    // Only those names: a file whose name merely contains one is the owner's.
    expect(inProjectSource(src, join(src, 'static/dev.vars.txt'))).toBe(true);
    expect(inProjectSource(src, join(src, 'static/my.wrangler'))).toBe(true);
    expect(inProjectSource(src, join(src, 'worker/.wrangler/state/kv.bin'))).toBe(false);
    expect(inProjectSource(src, join(src, 'worker/.dev.vars'))).toBe(false);
    // A line break in the name hides nothing.
    for (const name of ['.dev.vars.\nx', '.env.\nlocal', 'id_rsa\n.pub']) expect(isPrivateFileName(name), JSON.stringify(name)).toBe(true);
    for (const name of ['.dev.varsbackup', 'dev.vars', 'my.dev.vars.txt']) expect(isPrivateFileName(name), name).toBe(false);
  });

  it('checks generated files against the hashes the fingerprint took, and reads only those it did not take', async () => {
    const dir = temp();
    write(dir, 'src/routes/+page.svelte', 'page');
    write(dir, 'src/lib/x.js', 'x');
    write(dir, 'vercel.json', '{}');
    write(dir, 'siteorigin/generated-manifest.json', JSON.stringify({ files: { 'src/routes/+page.svelte': sha('page'), 'src/lib/x.js': sha('x'), 'vercel.json': sha('{}') } }));
    const { hashes } = await projectInventory(dir);
    expect([...hashes.keys()].sort()).toEqual(['siteorigin/generated-manifest.json', 'src/lib/x.js', 'src/routes/+page.svelte', 'vercel.json']);
    expect(await editedGeneratedFile(dir, hashes)).toBeNull();
    // A hash the fingerprint took is what is compared with the manifest's.
    expect(await editedGeneratedFile(dir, new Map([...hashes, ['src/routes/+page.svelte', sha('other')]]))).toBe('src/routes/+page.svelte');
    // A file it did not take is read.
    write(dir, 'src/lib/x.js', 'edited');
    const known = new Map(hashes);
    known.delete('src/lib/x.js');
    expect(await editedGeneratedFile(dir, known)).toBe('src/lib/x.js');
  });

  it('refreshes an untouched README and adds the sample image notice', async () => {
    const state = createStarterState('business', 'New Name', true);
    state.assets.assets['a_hero'] = { id: 'a_hero', name: 'Hero', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, hash: 'x', kind: 'image', createdAt: '' };
    const dest = temp();
    write(dest, 'README.md', projectReadme('Old Name'));
    const notice = join(temp(), 'NOTICE.md');
    writeFileSync(notice, 'sample images');
    await finishExportedSource(dest, state, notice);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(projectReadme('New Name'));
    expect(readFileSync(join(dest, 'NOTICE.md'), 'utf8')).toBe('sample images');
  });

  it("keeps a README the owner has edited", async () => {
    const dest = temp();
    expect(isGeneratedReadme(projectReadme('Old').replace(/\n/g, '\r\n'))).toBe(true);
    const own = projectReadme('Old') + '\nOur deployment notes.\n';
    expect(isGeneratedReadme(own)).toBe(false);
    write(dest, 'README.md', own);
    await finishExportedSource(dest, createStarterState('blank', 'New', false), join(dest, 'missing.md'));
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(own);
    expect(existsSync(join(dest, 'NOTICE.md'))).toBe(false);
  });

  it('tells whoever receives the project how to serve its not-found page and what its folders hold', () => {
    const readme = projectReadme('Old');
    expect(readme).toContain('## Deploying');
    expect(readme).toContain('`build/404.html`');
    expect(readme).toContain('Cloudflare Pages, Netlify and Vercel use it automatically');
    expect(readme).toContain('if the host has a 404 error document setting, set it to `/404.html`');
    expect(readme).toContain('`/my-site/404.html`');
    expect(readme).toContain('`src/lib/siteorigin/paths.json`');
    for (const entry of ['`src/`', '`static/`', '`siteorigin/`', '`robots.txt`', '`sitemap.xml`', '`rss.xml`', '`llms.txt`']) expect(readme).toContain(entry);
  });

  it('writes the redirect rules of the host the site names into the README, and still knows it as its own', async () => {
    const readmes = (['cloudflare', 'netlify', 'vercel'] as const).map((host) => projectReadme('Old', false, undefined, false, host));
    const [cloudflare, netlify, vercel] = readmes;
    expect(projectReadme('Old')).toBe(cloudflare);
    expect(cloudflare).toContain('written for Cloudflare Pages');
    expect(netlify).toContain('written for Netlify');
    expect(netlify).toContain('`301!`');
    expect(netlify).toContain('Netlify uses it automatically');
    expect(vercel).toContain('copy `vercel.json` into `build/` after each build');
    expect(vercel).toContain('Vercel uses it automatically');
    for (const other of [cloudflare, netlify]) expect(other).not.toContain('vercel.json');
    for (const readme of readmes) {
      expect(readme).toContain('HTTP 301');
      expect(isGeneratedReadme(readme)).toBe(true);
    }
    expect(vercel).toContain('Output Directory to `build`');
    // Each host's README is the app's with its drafts too.
    for (const host of ['cloudflare', 'netlify', 'vercel'] as const)
      for (const [drafts, entries] of [[true, false], [false, true], [true, true]]) expect(isGeneratedReadme(projectReadme('Old', drafts, undefined, entries, host))).toBe(true);
    // The host chosen since the README was written replaces it on export.
    for (const host of ['netlify', 'vercel'] as const) {
      const state = createStarterState('blank', 'Old', false);
      state.site.redirectHost = host;
      const dest = temp();
      write(dest, 'README.md', cloudflare);
      await finishExportedSource(dest, state, join(dest, 'missing.md'));
      expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(projectReadme('Old', false, undefined, false, host));
    }
  });

  it('gives a new project a .gitignore without the library packaging folder it never makes', () => {
    const ignored = readFileSync(join(__dirname, '../../templates/sveltekit-brochure/files/.gitignore'), 'utf8').split('\n');
    expect(ignored).toContain('/build');
    expect(ignored).not.toContain('/package');
  });

  it('picks a new folder name instead of replacing an existing one', () => {
    const parent = temp();
    expect(uniqueChild(parent, 'site')).toBe(join(parent, 'site'));
    mkdirSync(join(parent, 'site'));
    mkdirSync(join(parent, 'site-2'));
    expect(uniqueChild(parent, 'site')).toBe(join(parent, 'site-3'));
  });
});

describe('links to missing sections', () => {
  const broken = () => {
    const s = createStarterState('business', 'Studio', false);
    const contact = s.site.pageOrder.find((id) => s.pages[id].route === '/contact/')!;
    const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as { props: Record<string, unknown> };
    header.props.ctaLink = { type: 'page', target: contact, anchor: 'get-in-touch-with-us' };
    return s;
  };
  /** A failed build as the worker reports it: the message it ended with, then what it printed. */
  const build = (error: string, ...logs: string[]) => ({ error, logs });
  const prerender = 'Error: The following pages contain links to /contact/#get-in-touch-with-us, but no element with id="get-in-touch-with-us" exists on /contact/ - see the `handleMissingId` option';

  it('names the links when the build refuses a missing section', () => {
    const r = explainBuildFailure(broken(), build(prerender, 'at prerender'));
    expect(r.message).toMatch(/a link goes to a section its page does not have/);
    expect(r.warnings[0]).toContain('the “Book a call” link goes to #get-in-touch-with-us on Contact');
    expect(r.warnings).toContain(prerender);
  });

  it('says so plainly when the build finds a missing section Project health does not', () => {
    const r = explainBuildFailure(createStarterState('business', 'Studio', false), build(prerender));
    expect(r.message).toMatch(/a link goes to a section its page does not have/);
    expect(r.message).not.toMatch(/Project health/);
    expect(r.warnings).toEqual([prerender]);
  });

  it('puts the missing ID first, however long the build log', () => {
    const log = [...Array.from({ length: 12 }, (_, i) => `vite warning ${i}`), 'Error: [prerender_missing_id] no element with id="gone" exists on /contact/'].join('\n');
    const r = explainBuildFailure(createStarterState('business', 'Studio', false), build('Prerendering failed', log));
    expect(r.warnings[0]).toBe('Error: [prerender_missing_id] no element with id="gone" exists on /contact/');
  });

  it('keeps the build line in view when Project health lists many links', () => {
    const s = broken();
    const banner = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'features.grid') as { props: Record<string, unknown> };
    banner.props.items = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, icon: 'star', title: `T${i}`, description: '', linkLabel: 'More', link: { type: 'anchor', target: `gone${i}` } }));
    const r = explainBuildFailure(s, build('Prerendering failed', prerender));
    expect(r.warnings).toHaveLength(8);
    expect(r.warnings).toContain(prerender);
  });

  it('does not take an unrelated build error for a missing section', () => {
    expect(explainBuildFailure(broken(), build("Error: Cannot find module './missing_id.js'")).message).toBe('The production build failed.');
  });

  it('leaves other build failures as they are', () => {
    const r = explainBuildFailure(broken(), build('Error: Cannot find module x'));
    expect(r.message).toBe('The production build failed.');
    expect(r.warnings).toEqual(['Error: Cannot find module x']);
    expect(r.details).toContain('Error: Cannot find module x');
  });

  it('warns a source export that will not build', () => {
    expect(sectionLinkWarnings(createStarterState('business', 'Studio', false))).toEqual([]);
    const w = sectionLinkWarnings(broken());
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/^Project health found a link .* Fix it before building/);
    expect(w[1]).toContain('the “Book a call” link goes to #get-in-touch-with-us on Contact');
  });
});

describe('an export called off just before it is put in place', () => {
  it('leaves an existing ZIP file as it was, with no temporary file beside it', async () => {
    const src = temp();
    write(src, 'index.html', '<h1>New</h1>');
    const out = temp();
    const zip = join(out, 'site.zip');
    writeFileSync(zip, 'the previous export');
    // Asked once the archive is written in full, right before it would replace the previous one.
    const check = async () => {
      const [tmp] = readdirSync(out).filter((f) => f.endsWith('.tmp'));
      // The archive is complete: it ends with its end-of-directory record.
      const bytes = readFileSync(join(out, tmp));
      expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
      throw new Error('taken over');
    };
    await expect(zipDirectory(src, zip, '', check)).rejects.toThrow('taken over');
    expect(readFileSync(zip, 'utf8')).toBe('the previous export');
    expect(readdirSync(out)).toEqual(['site.zip']);
  });

  it('removes the folder it was copying into', async () => {
    const from = temp();
    write(from, 'index.html', '<h1>Site</h1>');
    write(from, 'about/index.html', '<h1>About</h1>');
    mkdirSync(join(from, 'empty'));
    const parent = temp();
    const check = async () => {
      // Copied in full beside the folder, which stays empty until the export is allowed to finish.
      const [tmp] = readdirSync(parent).filter((f) => f.endsWith('.tmp'));
      expect(readFileSync(join(parent, tmp, 'about', 'index.html'), 'utf8')).toBe('<h1>About</h1>');
      expect(readdirSync(join(parent, 'site'))).toEqual([]);
      throw new Error('taken over');
    };
    await expect(publishFolder(from, join(parent, 'site'), check)).rejects.toThrow('taken over');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('puts the export in place once allowed', async () => {
    const from = temp();
    write(from, 'about/index.html', '<h1>About</h1>');
    mkdirSync(join(from, 'empty'));
    const parent = temp();
    await publishFolder(from, join(parent, 'site'), async () => undefined);
    expect(readdirSync(parent)).toEqual(['site']);
    expect(readFileSync(join(parent, 'site', 'about', 'index.html'), 'utf8')).toBe('<h1>About</h1>');
    expect(existsSync(join(parent, 'site', 'empty'))).toBe(true);
  });

  it('moves a folder it may give up when the disk allows, and copies it when it cannot move it', async () => {
    const from = temp();
    write(from, 'about/index.html', '<h1>About</h1>');
    const parent = temp();
    await publishFolder(from, join(parent, 'site'), async () => undefined, { move: true });
    expect(existsSync(from)).toBe(false);
    expect(readdirSync(parent)).toEqual(['site']);
    expect(readFileSync(join(parent, 'site', 'about', 'index.html'), 'utf8')).toBe('<h1>About</h1>');
    // On another disk it cannot be moved: it is copied, and left where it was.
    const other = temp();
    write(other, 'index.html', 'x');
    const rename = vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
    try {
      await publishFolder(other, join(parent, 'copied'), async () => undefined, { move: true });
    } finally {
      rename.mockRestore();
    }
    expect(readFileSync(join(parent, 'copied', 'index.html'), 'utf8')).toBe('x');
    expect(readFileSync(join(other, 'index.html'), 'utf8')).toBe('x');
    expect(readdirSync(parent).sort()).toEqual(['copied', 'site']);
  });

  it('copies rather than moves a folder holding a file another name shares, so a change there never reaches the export', async () => {
    const from = temp();
    write(from, 'index.html', '<h1>Site</h1>');
    const outside = join(temp(), 'shared.css');
    writeFileSync(outside, 'body{}');
    linkSync(outside, join(from, 'shared.css'));
    const parent = temp();
    await publishFolder(from, join(parent, 'site'), async () => undefined, { move: true });
    expect(existsSync(join(from, 'index.html'))).toBe(true);
    writeFileSync(outside, 'body{color:red}');
    expect(readFileSync(join(parent, 'site', 'shared.css'), 'utf8')).toBe('body{}');
  });

  it('removes a folder it moved when the export is called off, and the claimed folder with it', async () => {
    const from = temp();
    write(from, 'index.html', '<h1>Site</h1>');
    const parent = temp();
    await expect(publishFolder(from, join(parent, 'site'), async () => Promise.reject(new Error('taken over')), { move: true })).rejects.toThrow('taken over');
    expect(readdirSync(parent)).toEqual([]);
  });

  it('keeps anything else that was put in the folder meanwhile', async () => {
    const from = temp();
    write(from, 'index.html', '<h1>Site</h1>');
    const parent = temp();
    const dest = join(parent, 'site');
    const check = async () => {
      write(dest, 'notes.txt', 'mine');
      write(dest, 'index.html', 'my own page');
      throw new Error('taken over');
    };
    await expect(publishFolder(from, dest, check)).rejects.toThrow('taken over');
    expect(readdirSync(dest).sort()).toEqual(['index.html', 'notes.txt']);
    expect(readFileSync(join(dest, 'index.html'), 'utf8')).toBe('my own page');
    expect(readdirSync(parent)).toEqual(['site']);
  });

  it('still clears the claimed folder, and reports the real reason, when its own copy cannot be removed', async () => {
    const from = temp();
    write(from, 'locked/index.html', '<h1>Site</h1>');
    chmodSync(join(from, 'locked'), 0o555);
    const parent = temp();
    try {
      await expect(publishFolder(from, join(parent, 'site'), async () => Promise.reject(new Error('taken over')))).rejects.toThrow('taken over');
      expect(readdirSync(parent).filter((f) => !f.endsWith('.tmp'))).toEqual([]);
    } finally {
      chmodSync(join(from, 'locked'), 0o755);
      for (const f of readdirSync(parent)) {
        chmodSync(join(parent, f, 'locked'), 0o755);
        rmSync(join(parent, f), { recursive: true, force: true });
      }
    }
  });

  it('never replaces a folder someone put files in while the export ran', async () => {
    const from = temp();
    write(from, 'index.html', '<h1>Site</h1>');
    const parent = temp();
    const dest = join(parent, 'site');
    await expect(publishFolder(from, dest, async () => write(dest, 'index.html', 'my own page'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readdirSync(dest)).toEqual(['index.html']);
    expect(readFileSync(join(dest, 'index.html'), 'utf8')).toBe('my own page');
    expect(readdirSync(parent)).toEqual(['site']);
  });
});

describe('the export’s fingerprint, remembered by each file’s stamp', () => {
  /** Long enough that a file just written was changed before the next pass looked at it (settleMs 0). */
  const settle = () => new Promise((r) => setTimeout(r, 25));

  it('takes a settled file’s hash from the last pass while its stamp stands, and reads it again once it changes', async () => {
    const dir = temp();
    write(dir, 'src/a.js', 'aaaa');
    write(dir, 'static/robots.txt', 'x');
    await settle();
    const cache: ExportHashes = new Map();
    const first = await projectInventory(dir, { cache, settleMs: 0 });
    expect(first.fingerprint).toBe(await projectFingerprint(dir));
    expect([...cache.keys()].sort()).toEqual([join(dir, 'src/a.js'), join(dir, 'static/robots.txt')]);
    // What the cache holds under the stamp the file still has stands for its bytes: the file is not read again.
    const abs = join(dir, 'src/a.js');
    cache.set(abs, { ...cache.get(abs)!, hash: 'remembered' });
    expect((await projectInventory(dir, { cache, settleMs: 0 })).hashes.get('src/a.js')).toBe('remembered');
    // An edit outside the app that keeps the size and puts the old modification time back still changes the stamp.
    const { mtime } = statSync(abs);
    writeFileSync(abs, 'bbbb');
    utimesSync(abs, mtime, mtime);
    const after = await projectInventory(dir, { cache, settleMs: 0 });
    expect(after.hashes.get('src/a.js')).toBe(sha('bbbb'));
    expect(after.fingerprint).toBe(await projectFingerprint(dir));
    expect(after.fingerprint).not.toBe(first.fingerprint);
    // So does a file put in its place.
    write(dir, 'src/a.next', 'cccc');
    rmSync(abs);
    writeFileSync(abs, readFileSync(join(dir, 'src/a.next')));
    rmSync(join(dir, 'src/a.next'));
    expect((await projectInventory(dir, { cache, settleMs: 0 })).hashes.get('src/a.js')).toBe(sha('cccc'));
  });

  it('sees a file written and put back as it was between two passes, which the fingerprint alone cannot', async () => {
    const dir = temp();
    write(dir, 'src/a.js', 'same');
    write(dir, 'src/b.js', 'other');
    await settle();
    const cache: ExportHashes = new Map();
    const first = await projectInventory(dir, { cache, settleMs: 0 });
    expect([...first.stamps.values()].every((s) => s.trusted)).toBe(true);
    expect(inventoryChanged(first, await projectInventory(dir, { cache, settleMs: 0 }))).toBe(false);
    writeFileSync(join(dir, 'src/a.js'), 'edited');
    writeFileSync(join(dir, 'src/a.js'), 'same');
    const second = await projectInventory(dir, { cache, settleMs: 0 });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(inventoryChanged(first, second)).toBe(true);
    // A file the first pass could not trust (changed too recently) is compared by its bytes alone, as before.
    const fresh = await projectInventory(dir, { cache: new Map(), settleMs: 60_000 });
    writeFileSync(join(dir, 'src/b.js'), 'other');
    expect(inventoryChanged(fresh, await projectInventory(dir, { cache: new Map(), settleMs: 60_000 }))).toBe(false);
  });

  it('keeps no hash of a file changed too recently for its stamp to stand for it, nor of one no longer there', async () => {
    const dir = temp();
    write(dir, 'src/a.js', 'a');
    write(dir, 'src/b.js', 'b');
    const cache: ExportHashes = new Map();
    await projectInventory(dir, { cache, settleMs: 60_000 });
    expect(cache.size).toBe(0);
    await settle();
    await projectInventory(dir, { cache, settleMs: 0 });
    expect(cache.size).toBe(2);
    rmSync(join(dir, 'src/b.js'));
    await projectInventory(dir, { cache, settleMs: 0 });
    expect([...cache.keys()]).toEqual([join(dir, 'src/a.js')]);
  });

  it('fingerprints many files the same with or without what it remembers', async () => {
    const dir = temp();
    for (let i = 0; i < 60; i++) write(dir, `${['src', 'static', 'siteorigin'][i % 3]}/d${i % 7}/f${i}.txt`, `file ${i}`);
    write(dir, 'src/skip.tmp', 'never');
    await settle();
    const cache: ExportHashes = new Map();
    const plain = await projectFingerprint(dir);
    expect((await projectInventory(dir, { cache, settleMs: 0 })).fingerprint).toBe(plain);
    expect((await projectInventory(dir, { cache, settleMs: 0 })).fingerprint).toBe(plain);
    expect(cache.size).toBe(60);
  });
});

describe('finding the library files a website names', () => {
  it('reads many names over one text exactly as it searches for each on its own', () => {
    let x = 0x9e3779b9;
    const rand = (n: number) => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) % n;
    };
    const pick = (chars: string, length: number) => Array.from({ length }, () => chars[rand(chars.length)]).join('');
    const NAME = 'ab1-_.';
    const AROUND = 'ab1-_./ "\'<>=(),é\n';
    for (let round = 0; round < 3000; round++) {
      const names = Array.from({ length: 1 + rand(5) }, () => (rand(8) === 0 ? `${pick(NAME, 1 + rand(3))} ${pick(NAME, 1 + rand(3))}` : rand(10) === 0 ? `caf\u00e9-${pick(NAME, 2)}` : pick(NAME, 1 + rand(6))));
      let text = pick(AROUND, rand(12));
      for (let k = rand(6); k > 0; k--) text += pick(AROUND, rand(3)) + names[rand(names.length)] + pick(AROUND, rand(3));
      const found = namesIn(text, names);
      for (const name of names) {
        expect(found.file(name), `${JSON.stringify(name)} in ${JSON.stringify(text)}`).toBe(namesFile(text, name));
        expect(found.whole(name), `${JSON.stringify(name)} whole in ${JSON.stringify(text)}`).toBe(namesWholeFile(text, name));
      }
    }
  });
});

describe('finding the library files a website names, a file at a time', () => {
  it('finds over several texts searched in turn what one search of them joined finds', () => {
    let x = 0x2545f491;
    const rand = (n: number) => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) % n;
    };
    const pick = (chars: string, length: number) => Array.from({ length }, () => chars[rand(chars.length)]).join('');
    const NAME = 'ab1-_.';
    const AROUND = 'ab1-_./ "\'<>=(),é\n';
    for (let round = 0; round < 3000; round++) {
      const names = Array.from({ length: 1 + rand(5) }, () => (rand(8) === 0 ? `${pick(NAME, 1 + rand(3))} ${pick(NAME, 1 + rand(3))}` : rand(10) === 0 ? `caf\u00e9-${pick(NAME, 2)}` : pick(NAME, 1 + rand(6))));
      const texts = Array.from({ length: 1 + rand(4) }, () => {
        let text = pick(AROUND, rand(8));
        for (let k = rand(4); k > 0; k--) text += pick(AROUND, rand(3)) + names[rand(names.length)] + pick(AROUND, rand(3));
        return text;
      });
      const matcher = new NameMatcher(names);
      for (const text of texts) matcher.scan(text);
      const joined = texts.join('\n');
      for (const name of names) {
        expect(matcher.file(name), `${JSON.stringify(name)} in ${JSON.stringify(texts)}`).toBe(namesFile(joined, name));
        expect(matcher.whole(name), `${JSON.stringify(name)} whole in ${JSON.stringify(texts)}`).toBe(namesWholeFile(joined, name));
      }
    }
  });
});

describe('copying a folder entry by entry', () => {
  it('judges an entry again when it is no longer what it was listed as, and copies a folder in its place entry by entry', async () => {
    const src = temp();
    write(src, 'a.txt', 'a');
    write(src, 'b.txt', 'b');
    write(src, 'secret.txt', 'never');
    const dest = join(temp(), 'out');
    let swapped = false;
    const kept = (p: string, e: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) => {
      // Once a.txt has been listed as a file, it becomes a link and b.txt a folder, before either is copied.
      if (!swapped && p.endsWith('b.txt')) {
        swapped = true;
        rmSync(join(src, 'a.txt'));
        symlinkSync(join(src, 'secret.txt'), join(src, 'a.txt'));
        rmSync(join(src, 'b.txt'));
        write(src, 'b.txt/inside.txt', 'in');
        write(src, 'b.txt/secret.txt', 'never');
      }
      return !e.isSymbolicLink() && !p.endsWith('secret.txt');
    };
    await copyTree(src, dest, kept);
    expect(existsSync(join(dest, 'a.txt'))).toBe(false);
    expect(readFileSync(join(dest, 'b.txt', 'inside.txt'), 'utf8')).toBe('in');
    expect(existsSync(join(dest, 'b.txt', 'secret.txt'))).toBe(false);
    expect(existsSync(join(dest, 'secret.txt'))).toBe(false);
  });

  it('replaces a file already in the folder it copies into rather than writing through it, and leaves that folder’s own folders as they are', async () => {
    const src = temp();
    write(src, 'sub/page.html', 'new');
    const dest = temp();
    const outside = join(temp(), 'theirs.html');
    writeFileSync(outside, 'theirs');
    mkdirSync(join(dest, 'sub'));
    chmodSync(join(dest, 'sub'), 0o750);
    linkSync(outside, join(dest, 'sub', 'page.html'));
    await copyTree(src, dest, () => true);
    expect(readFileSync(join(dest, 'sub', 'page.html'), 'utf8')).toBe('new');
    expect(readFileSync(outside, 'utf8')).toBe('theirs');
    if (process.platform !== 'win32') expect(statSync(join(dest, 'sub')).mode & 0o777).toBe(0o750);
  });
});
