import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync, crc32 } from 'node:zlib';
import { createStarterState } from '@catalogue/starters';
import { zipDirectory } from '../../src/main/zip';
import {
  copyProjectSource,
  editedGeneratedFile,
  exportedAssetFilter,
  finishExportedSource,
  isGeneratedReadme,
  projectFingerprint,
  projectReadme,
  publishFolder,
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

describe('source export helpers', () => {
  it('copies only referenced images and never private files or links', async () => {
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
