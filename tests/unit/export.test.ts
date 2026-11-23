import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';
import { createStarterState } from '@catalogue/starters';
import { assetUsages } from '@engine/apply';
import { generateProject } from '@generator/index';
import type { AssetRecord, ProjectState } from '@shared/types';
import { zipDirectory } from '../../src/main/zip';
import {
  builtPhotosMessage,
  cleanBuiltSite,
  cleanWebsitePhotos,
  copyProjectSource,
  editedGeneratedFile,
  explainBuildFailure,
  exportedAssetFilter,
  finishExportedSource,
  isGeneratedReadme,
  locatedPhotos,
  locationKeptNote,
  locationRemovedNote,
  omittedAssetsWarning,
  readLibraryImage,
  projectFingerprint,
  projectReadme,
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
  const image = (id: string, file: string, variants: string[] = []): AssetRecord => ({ id, name: `${id}.svg`, file, mime: 'image/svg+xml', bytes: 1, width: 1000, height: 500, hash: 'x', kind: 'image', variants: variants.map((f, i) => ({ width: 480 * (i + 1), file: f })), createdAt: '' });
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
      image('placed', 'static/assets/big-sketch-12345678.svg', ['static/assets/big-sketch-12345678-480w.svg']),
      // Never placed: its name is part of the placed file's name, which must not count as a use.
      image('draft', 'static/assets/sketch-12345678.svg', ['static/assets/sketch-12345678-480w.svg']),
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
    write(dir, 'siteorigin.project.json', JSON.stringify({ cover: 'static/assets/sketch-12345678.svg' }));
    write(dir, 'README.md', 'Drafts: sketch-12345678.svg, old-draft.svg');

    const omitted = await pruneWebsiteAssets(dir, state);
    const left = (f: string) => existsSync(join(dir, f));
    expect(omitted.map((a) => a.id).sort()).toEqual(['draft', 'legacy']);
    for (const f of ['static/assets/sketch-12345678.svg', 'static/assets/sketch-12345678-480w.svg', 'static/assets/old-draft.svg', 'static/assets/deleted-99999999.svg', 'static/assets/banner-77777777.svg'])
      expect(left(f), f).toBe(false);
    for (const f of [
      'static/assets/big-sketch-12345678.svg',
      'static/assets/big-sketch-12345678-480w.svg',
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
    expect(omittedAssetsWarning(omitted)).toBe("Left out of the website because no page or code refers to them: draft.svg, legacy.svg. They stay in the project's assets.");
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
});

describe('website photo privacy', () => {
  const photo = (id: string, name: string, file: string, variants: string[] = []): AssetRecord => ({ id, name, file, mime: 'image/jpeg', bytes: 1, width: 2000, height: 1200, hash: 'x', kind: 'image', variants: variants.map((f, i) => ({ width: 480 * (i + 1), file: f })), createdAt: '' });
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
    // A camera model only, percent-encoded; and one the parser cannot read.
    const modelOnly = Buffer.concat([SOI, exifSeg(tiff(true, { ifd0: [ascii(0x0110, 'Phone X')] })), JFIF, IMAGE_DATA, EOI]);
    write(dir, 'styles/device.css', `.y{background:url(data:image/jpeg;base64,${modelOnly.toString('base64').replace(/\//g, '%2F')})}`);
    write(dir, 'unreadable.html', `<img src="data:image/png;base64,${Buffer.from('not a png').toString('base64')}">`);
    write(dir, 'index.html', '<html></html>');
    const failed = await cleanBuiltSite(dir);
    expect(failed.sort()).toEqual(['_app/immutable/chunks/inline.js', 'assets/broken.png', 'styles/device.css', 'unreadable.html']);
    expect(readFileSync(join(dir, '_app/immutable/assets/pkg.abc123.jpg')).toString('latin1')).not.toContain('Main St');
    expect(readFileSync(join(dir, 'downloads/photo')).toString('latin1')).not.toMatch(/GPS|SERIAL/);
    expect(readFileSync(join(dir, 'assets/already-clean.jpg')).equals(clean)).toBe(true);
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
    state.components['code.x'] = { ...Object.values(state.components)[0], id: 'code.x', kind: 'code', source: '<img src="/assets/used-by-code-cccccccc.png" alt="" />' };
    const src = temp();
    for (const f of ['static/assets/kept-aaaaaaaa.jpg', 'static/assets/kept-aaaaaaaa-480w.jpg', 'static/assets/deleted-bbbbbbbb.jpg', 'static/assets/deleted-bbbbbbbb-480w.jpg', 'static/assets/used-by-code-cccccccc.png', 'static/assets/my-own-file.pdf', 'static/assets/docs/guide-dddddddd.pdf', 'static/favicon.svg', 'src/routes/+page.svelte', '.env', 'package.json'])
      write(src, f, f);
    symlinkSync(join(src, 'package.json'), join(src, 'static', 'linked.json'));
    const dest = join(temp(), 'out');
    await copyProjectSource(src, dest, { keepAsset: exportedAssetFilter(state) });
    expect(existsSync(join(dest, 'static/assets/kept-aaaaaaaa.jpg'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/kept-aaaaaaaa-480w.jpg'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/deleted-bbbbbbbb.jpg'))).toBe(false);
    expect(existsSync(join(dest, 'static/assets/deleted-bbbbbbbb-480w.jpg'))).toBe(false);
    // Files nobody imported through the app are the owner's, and code components may use any public file.
    expect(existsSync(join(dest, 'static/assets/used-by-code-cccccccc.png'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/my-own-file.pdf'))).toBe(true);
    expect(existsSync(join(dest, 'static/assets/docs/guide-dddddddd.pdf'))).toBe(true);
    expect(existsSync(join(dest, 'static/favicon.svg'))).toBe(true);
    expect(existsSync(join(dest, '.env'))).toBe(false);
    expect(existsSync(join(dest, 'static/linked.json'))).toBe(false);
    expect(existsSync(join(dest, '.npmrc'))).toBe(false);
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

  it('refreshes an untouched README, adds the sample image notice and relaxes old engines', async () => {
    const state = createStarterState('business', 'New Name', true);
    state.assets.assets['a_hero'] = { id: 'a_hero', name: 'Hero', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, hash: 'x', kind: 'image', createdAt: '' };
    const dest = temp();
    const legacy = readFileSync(join(__dirname, 'fixtures', 'legacy-readme.md'), 'utf8');
    write(dest, 'README.md', legacy);
    write(dest, 'package.json', JSON.stringify({ name: 'x', engines: { node: '^22.22.2 || ^24.15.0 || >=26.0.0' } }));
    write(dest, 'package-lock.json', JSON.stringify({ packages: { '': { engines: { node: '^22.22.2 || ^24.15.0 || >=26.0.0' } } } }));
    const notice = join(temp(), 'NOTICE.md');
    writeFileSync(notice, 'sample images');
    await finishExportedSource(dest, state, notice);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(projectReadme('New Name'));
    expect(readFileSync(join(dest, 'NOTICE.md'), 'utf8')).toBe('sample images');
    expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).engines.node).toBe('>=22.17.0');
    expect(JSON.parse(readFileSync(join(dest, 'package-lock.json'), 'utf8')).packages[''].engines.node).toBe('>=22.17.0');
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
  const prerender = 'Error: The following pages contain links to /contact/#get-in-touch-with-us, but no element with id="get-in-touch-with-us" exists on /contact/ - see the `handleMissingId` option';

  it('names the links when the build refuses a missing section', () => {
    const r = explainBuildFailure(broken(), [prerender, 'at prerender']);
    expect(r.message).toMatch(/a link goes to a section its page does not have/);
    expect(r.warnings[0]).toContain('the “Book a call” link goes to #get-in-touch-with-us on Contact');
    expect(r.warnings).toContain(prerender);
  });

  it('says so plainly when the build finds a missing section Project health does not', () => {
    const r = explainBuildFailure(createStarterState('business', 'Studio', false), [prerender]);
    expect(r.message).toMatch(/a link goes to a section its page does not have/);
    expect(r.message).not.toMatch(/Project health/);
    expect(r.warnings).toEqual([prerender]);
  });

  it('puts the missing ID first, however long the build log', () => {
    const log = [...Array.from({ length: 12 }, (_, i) => `vite warning ${i}`), 'Error: [prerender_missing_id] no element with id="gone" exists on /contact/'].join('\n');
    const r = explainBuildFailure(createStarterState('business', 'Studio', false), ['Prerendering failed', log]);
    expect(r.warnings[0]).toBe('Error: [prerender_missing_id] no element with id="gone" exists on /contact/');
  });

  it('keeps the build line in view when Project health lists many links', () => {
    const s = broken();
    const banner = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'features.grid') as { props: Record<string, unknown> };
    banner.props.items = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, icon: 'star', title: `T${i}`, description: '', linkLabel: 'More', link: { type: 'anchor', target: `gone${i}` } }));
    const r = explainBuildFailure(s, ['Prerendering failed', prerender]);
    expect(r.warnings).toHaveLength(8);
    expect(r.warnings).toContain(prerender);
  });

  it('does not take an unrelated build error for a missing section', () => {
    expect(explainBuildFailure(broken(), ["Error: Cannot find module './missing_id.js'"]).message).toBe('The production build failed.');
  });

  it('leaves other build failures as they are', () => {
    expect(explainBuildFailure(broken(), ['Error: Cannot find module x'])).toEqual({ message: 'The production build failed.', warnings: ['Error: Cannot find module x'] });
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
