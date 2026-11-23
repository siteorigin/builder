import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync, crc32 } from 'node:zlib';
import { createStarterState } from '@catalogue/starters';
import { assetUsages } from '@engine/apply';
import { generateProject } from '@generator/index';
import type { AssetRecord, ProjectState } from '@shared/types';
import { zipDirectory } from '../../src/main/zip';
import {
  copyProjectSource,
  editedGeneratedFile,
  explainBuildFailure,
  exportedAssetFilter,
  finishExportedSource,
  isGeneratedReadme,
  omittedAssetsWarning,
  projectFingerprint,
  projectReadme,
  pruneWebsiteAssets,
  publishFolder,
  sectionLinkWarnings,
  uniqueChild
} from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-export-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** A minimal reader: every entry's name and inflated content, checked against its CRC. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(offset + 26);
    const data = buf.subarray(offset + 30 + localNameLen, offset + 30 + localNameLen + csize);
    const body = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(crc32(body) >>> 0).toBe(crc);
    out.set(name, body);
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
    const zip = join(temp(), 'site.zip');
    const r = await zipDirectory(src, zip);
    expect(r.files).toBe(4);
    const entries = readZip(readFileSync(zip));
    expect([...entries.keys()].sort()).toEqual(['about/index.html', 'assets/café.txt', 'empty.txt', 'index.html']);
    expect(entries.get('index.html')!.toString()).toBe('<h1>Hello</h1>'.repeat(50));
    expect(entries.get('assets/café.txt')!.toString()).toBe('crème');
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

