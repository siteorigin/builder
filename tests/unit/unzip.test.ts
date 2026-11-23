/**
 * Reading a ZIP file someone sent (#263): Builder's own editable-project and website ZIPs are told apart, and an
 * archive that would write outside its folder, overwrite one of its own files, or lie about its contents is refused.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { zipDirectory } from '../../src/main/zip';
import { classifyZip, extractEntries, readZipEntries, safeEntryPath, ZipError } from '../../src/main/unzip';

const dirs: string[] = [];
const temp = (p = 'so-unzip-') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

interface RawEntry {
  name: string;
  data?: Buffer | string;
  deflate?: boolean;
  /** Unix mode for the external attributes (made on Unix). */
  mode?: number;
  flags?: number;
  method?: number;
  /** Overrides for the recorded values. */
  crc?: number;
  size?: number;
}

/** Write a ZIP file entry by entry, so tests can make archives no well-behaved tool would. */
function rawZip(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(data) : data;
    const method = e.method ?? (e.deflate ? 8 : 0);
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    parts.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const zipFile = (entries: RawEntry[]) => {
  const f = join(temp(), 'test.zip');
  writeFileSync(f, rawZip(entries));
  return f;
};

/** Every file under `dir`, relative, with forward slashes. */
const tree = (dir: string, base = ''): string[] =>
  readdirSync(join(dir, base))
    .flatMap((n) => (statSync(join(dir, base, n)).isDirectory() ? tree(dir, base ? `${base}/${n}` : n) : [base ? `${base}/${n}` : n]))
    .sort();

describe('telling ZIP files apart', () => {
  it('finds the editable project in a ZIP file Builder exported, under its one folder', async () => {
    const src = temp();
    writeFileSync(join(src, 'siteorigin.project.json'), '{"name":"Cafe"}');
    mkdirSync(join(src, 'siteorigin', 'pages'), { recursive: true });
    writeFileSync(join(src, 'siteorigin', 'pages', 'home.json'), '{}');
    mkdirSync(join(src, 'static', 'assets'), { recursive: true });
    writeFileSync(join(src, 'static', 'assets', 'photo.jpg'), Buffer.alloc(4096, 7));
    const zip = join(temp(), 'cafe-source.zip');
    await zipDirectory(src, zip, 'cafe-source');
    const contents = classifyZip(await readZipEntries(zip));
    expect(contents.kind).toBe('project');
    if (contents.kind !== 'project') return;
    expect(contents.root).toBe('cafe-source/');
    const dest = temp();
    expect(await extractEntries(zip, contents.entries, contents.root, dest)).toBe(3);
    expect(tree(dest)).toEqual(['siteorigin.project.json', 'siteorigin/pages/home.json', 'static/assets/photo.jpg']);
    expect(readFileSync(join(dest, 'static', 'assets', 'photo.jpg'))).toEqual(Buffer.alloc(4096, 7));
  });

  it('finds a project at the root, and one re-zipped with the Finder, leaving its clutter behind', async () => {
    const atRoot = classifyZip(await readZipEntries(zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'src/app.html', data: 'x' }])));
    expect(atRoot).toMatchObject({ kind: 'project', root: '' });
    const finder = zipFile([
      { name: 'Cafe/', mode: 0o40755 },
      { name: 'Cafe/siteorigin.project.json', data: '{}', deflate: true },
      { name: 'Cafe/.DS_Store', data: 'junk' },
      { name: '__MACOSX/Cafe/._siteorigin.project.json', data: 'junk' },
      { name: 'Cafe/static/._logo.png', data: 'junk' }
    ]);
    const contents = classifyZip(await readZipEntries(finder));
    expect(contents).toMatchObject({ kind: 'project', root: 'Cafe/' });
    if (contents.kind !== 'project') return;
    const dest = temp();
    await extractEntries(finder, contents.entries, contents.root, dest);
    expect(tree(dest)).toEqual(['siteorigin.project.json']);
  });

  it('recognizes a website ZIP, and says when it is neither', async () => {
    expect(classifyZip(await readZipEntries(zipFile([{ name: 'index.html', data: '<h1>' }, { name: '_app/x.js', data: '' }])))).toEqual({ kind: 'website' });
    expect(classifyZip(await readZipEntries(zipFile([{ name: 'cafe-site/index.html', data: '<h1>' }])))).toEqual({ kind: 'website' });
    expect(classifyZip(await readZipEntries(zipFile([{ name: 'notes.txt', data: 'hi' }])))).toEqual({ kind: 'other' });
    expect(classifyZip(await readZipEntries(zipFile([{ name: 'a/siteorigin.project.json', data: '{}' }, { name: 'b/siteorigin.project.json', data: '{}' }])))).toEqual({ kind: 'several' });
  });

  it('refuses a file that is not a ZIP file, or one cut short', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.zip'), 'not a zip at all, just some text that is long enough');
    await expect(readZipEntries(join(dir, 'a.zip'))).rejects.toThrow(ZipError);
    const whole = rawZip([{ name: 'siteorigin.project.json', data: '{}' }]);
    writeFileSync(join(dir, 'b.zip'), whole.subarray(0, whole.length - 30));
    await expect(readZipEntries(join(dir, 'b.zip'))).rejects.toThrow(/damaged or incomplete/);
  });
});

describe('an archive that could do harm', () => {
  it.each(['../evil.txt', 'a/../../evil.txt', '/etc/evil', 'C:/evil.txt', 'C:evil.txt', '..\\evil.txt', 'a\u0000b'])('refuses %j before writing anything', async (name) => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name, data: 'x' }]);
    await expect(readZipEntries(zip)).rejects.toThrow(/outside its folder/);
  });

  it('keeps ordinary names as they are, and treats backslashes as folders', () => {
    expect(safeEntryPath('a\\b.txt')).toBe('a/b.txt');
    expect(safeEntryPath('./a//b/')).toBe('a/b');
    expect(() => safeEntryPath('./')).toThrow(ZipError);
  });

  it('refuses two names one folder cannot tell apart', async () => {
    await expect(readZipEntries(zipFile([{ name: 'p/Logo.png', data: 'a' }, { name: 'p/logo.png', data: 'b' }]))).rejects.toThrow(/two files named/);
    await expect(readZipEntries(zipFile([{ name: 'p/a', data: 'a' }, { name: 'p/a/b', data: 'b' }]))).rejects.toThrow(/both as a file and as a folder/);
  });

  it('never writes a link', async () => {
    const zip = zipFile([
      { name: 'siteorigin.project.json', data: '{}' },
      { name: 'static/escape', data: '/etc', mode: 0o120777 }
    ]);
    const contents = classifyZip(await readZipEntries(zip));
    if (contents.kind !== 'project') throw new Error(contents.kind);
    const dest = temp();
    await extractEntries(zip, contents.entries, contents.root, dest);
    expect(tree(dest)).toEqual(['siteorigin.project.json']);
  });

  it('refuses encrypted entries and compression it cannot read', async () => {
    await expect(readZipEntries(zipFile([{ name: 'a.txt', data: 'x', flags: 1 }]))).rejects.toThrow(/password-protected/);
    await expect(readZipEntries(zipFile([{ name: 'a.txt', data: 'x', method: 12 }]))).rejects.toThrow(/compression/);
  });

  it('stops at a file whose contents do not match what the archive says', async () => {
    const bad = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'big.txt', data: 'x'.repeat(5000), deflate: true, size: 10 }]);
    const contents = classifyZip(await readZipEntries(bad));
    if (contents.kind !== 'project') throw new Error(contents.kind);
    await expect(extractEntries(bad, contents.entries, contents.root, temp())).rejects.toThrow(/big\.txt in that ZIP file is damaged/);
    const crc = zipFile([{ name: 'siteorigin.project.json', data: '{}', crc: 1234 }]);
    const c2 = classifyZip(await readZipEntries(crc));
    if (c2.kind !== 'project') throw new Error(c2.kind);
    await expect(extractEntries(crc, c2.entries, c2.root, temp())).rejects.toThrow(/damaged/);
  });

  it('stops between files once the signal aborts', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'a.txt', data: 'a' }]);
    const contents = classifyZip(await readZipEntries(zip));
    if (contents.kind !== 'project') throw new Error(contents.kind);
    const abort = new AbortController();
    abort.abort();
    await expect(extractEntries(zip, contents.entries, contents.root, temp(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
