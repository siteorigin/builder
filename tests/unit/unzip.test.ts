/**
 * Reading a ZIP file someone sent (#263): Builder's own editable-project and website ZIPs are told apart, and an
 * archive that would write outside its folder, overwrite one of its own files, or lie about its contents is refused.
 */
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipDirectory } from '../../src/main/zip';
import { classifyZip, decodeName, extractEntries, readZipEntries, safeEntryPath, unpackProject, ZipError } from '../../src/main/unzip';

const dirs: string[] = [];
const temp = (p = 'so-unzip-') => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

interface RawEntry {
  name: string | Buffer;
  data?: Buffer | string;
  deflate?: boolean;
  /** Unix mode for the external attributes. */
  mode?: number;
  /** The system the archive says made it: 3 Unix (the default), 19 macOS, 0 MS-DOS. */
  host?: number;
  /** Whether the entry says its name is UTF-8 (the default). */
  utf8?: boolean;
  extra?: Buffer;
  flags?: number;
  method?: number;
  /** Overrides for the recorded values. */
  crc?: number;
  size?: number;
  /** The compressed size recorded, whatever the data is. */
  csize?: number;
  /** Point the entry at another entry's bytes (its index). */
  sameDataAs?: number;
}

/** Write a ZIP file entry by entry, so tests can make archives no well-behaved tool would. */
function rawZip(entries: RawEntry[], comment: Buffer = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(data) : data;
    const method = e.method ?? (e.deflate ? 8 : 0);
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const extra = e.extra ?? Buffer.alloc(0);
    const flags = (e.flags ?? 0) | (e.utf8 === false ? 0 : 0x800);
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.csize ?? body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(((e.host ?? 3) << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(e.csize ?? body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    const isDir = name.toString('latin1').endsWith('/');
    header.writeUInt32LE(((e.mode ?? (isDir ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    header.writeUInt32LE(e.sameDataAs === undefined ? offset : offsets[e.sameDataAs], 42);
    offsets.push(offset);
    central.push(header, name, extra);
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
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, end, comment]);
}

const zipFile = (entries: RawEntry[], comment?: Buffer) => {
  const f = join(temp(), 'test.zip');
  writeFileSync(f, rawZip(entries, comment));
  return f;
};

/** Every file under `dir`, relative, with forward slashes. */
const tree = (dir: string, base = ''): string[] =>
  readdirSync(join(dir, base))
    .flatMap((n) => (statSync(join(dir, base, n)).isDirectory() ? tree(dir, base ? `${base}/${n}` : n) : [base ? `${base}/${n}` : n]))
    .sort();

const project = async (zip: string) => {
  const c = classifyZip(await readZipEntries(zip));
  if (c.kind !== 'project') throw new Error(c.kind);
  return c;
};
const kind = async (entries: RawEntry[]) => classifyZip(await readZipEntries(zipFile(entries))).kind;

describe('telling ZIP files apart', () => {
  it('finds the editable project in a ZIP file Builder exported, under its one folder', async () => {
    const src = temp();
    writeFileSync(join(src, 'siteorigin.project.json'), '{"name":"Cafe"}');
    mkdirSync(join(src, 'siteorigin', 'pages'), { recursive: true });
    writeFileSync(join(src, 'siteorigin', 'pages', 'home.json'), '{"title":"Home"}');
    mkdirSync(join(src, 'static', 'assets'), { recursive: true });
    writeFileSync(join(src, 'static', 'assets', 'photo.jpg'), Buffer.alloc(4096, 7));
    const zip = join(temp(), 'cafe-source.zip');
    await zipDirectory(src, zip, 'cafe-source');
    const contents = await project(zip);
    expect(contents.root).toBe('cafe-source/');
    const dest = temp();
    expect(await extractEntries(zip, contents.entries, contents.root, dest)).toBe(3);
    expect(tree(dest)).toEqual(['siteorigin.project.json', 'siteorigin/pages/home.json', 'static/assets/photo.jpg']);
    for (const f of tree(dest)) expect(readFileSync(join(dest, f)), f).toEqual(readFileSync(join(src, f)));
  });

  it('finds a project at the root, and one re-zipped with the Finder, leaving its clutter behind and keeping empty folders', async () => {
    expect(await project(zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'src/app.html', data: 'x' }]))).toMatchObject({ root: '' });
    const finder = zipFile([
      { name: 'Cafe/', host: 19 },
      { name: 'Cafe/siteorigin.project.json', data: '{}', deflate: true, host: 19 },
      { name: 'Cafe/static/fonts/', host: 19 },
      { name: 'Cafe/.DS_Store', data: 'junk', host: 19 },
      { name: '__MACOSX/Cafe/._siteorigin.project.json', data: 'junk', host: 19 },
      { name: 'Cafe/static/._logo.png', data: 'junk', host: 19 }
    ]);
    const contents = await project(finder);
    expect(contents.root).toBe('Cafe/');
    // The extractor leaves the clutter out on its own, given every entry.
    const dest = temp();
    await extractEntries(finder, await readZipEntries(finder), contents.root, dest);
    expect(tree(dest)).toEqual(['siteorigin.project.json']);
    expect(statSync(join(dest, 'static', 'fonts')).isDirectory()).toBe(true);
  });

  it('recognizes a website ZIP, and says when it is neither', async () => {
    expect(await kind([{ name: 'index.html', data: '<h1>' }, { name: '_app/x.js', data: '' }])).toBe('website');
    expect(await kind([{ name: 'cafe-site/index.html', data: '<h1>' }, { name: 'cafe-site/_app/x.js', data: '' }])).toBe('website');
    // A page on its own, an _app folder on its own, or a folder of notes is not a website export.
    expect(await kind([{ name: 'cafe-site/index.html', data: '<h1>' }])).toBe('other');
    expect(await kind([{ name: '_app/x.js', data: '' }, { name: 'about.html', data: '' }])).toBe('other');
    expect(await kind([{ name: 'notes.txt', data: 'hi' }])).toBe('other');
  });

  it('takes a project only at the top or inside the one folder, never one of several or one buried deeper', async () => {
    expect(await kind([{ name: 'a/siteorigin.project.json', data: '{}' }, { name: 'b/siteorigin.project.json', data: '{}' }])).toBe('other');
    expect(await kind([{ name: 'Downloads/cafe/siteorigin.project.json', data: '{}' }])).toBe('other');
    expect(await kind([{ name: 'cafe/siteorigin.project.json', data: '{}' }, { name: 'readme.txt', data: 'x' }])).toBe('other');
    // A project in the wrong place is not mistaken for a website either.
    expect(await kind([{ name: 'index.html', data: '' }, { name: '_app/x.js', data: '' }, { name: 'a/b/siteorigin.project.json', data: '{}' }])).toBe('other');
    // The Finder's own folder beside the project's one folder does not count as a second folder.
    expect(await kind([{ name: 'cafe/siteorigin.project.json', data: '{}' }, { name: '__MACOSX/cafe/._x', data: '' }])).toBe('project');
  });

  it('reads names older Windows tools write in code page 437, and Info-ZIP’s Unicode names', async () => {
    const cp437 = Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x70, 0x6e, 0x67]);
    expect(decodeName(cp437, false)).toBe('café.png');
    expect((await readZipEntries(zipFile([{ name: cp437, utf8: false, data: 'x', host: 0 }])))[0].path).toBe('café.png');
    // A legacy name with the real one beside it in the Unicode path field, which names the legacy name by its CRC-32.
    const legacy = Buffer.from('c\x88a\x97.png', 'latin1');
    const real = Buffer.from('ĉaŭ.png', 'utf8');
    const field = (forName: Buffer) => {
      const f = Buffer.alloc(9 + real.length);
      f.writeUInt16LE(0x7075, 0);
      f.writeUInt16LE(5 + real.length, 2);
      f[4] = 1;
      f.writeUInt32LE(crc32(forName), 5);
      real.copy(f, 9);
      return f;
    };
    expect((await readZipEntries(zipFile([{ name: legacy, utf8: false, extra: field(legacy), data: 'x' }])))[0].path).toBe('ĉaŭ.png');
    // A field written for some other name (the legacy name was changed since) is not trusted.
    expect((await readZipEntries(zipFile([{ name: legacy, utf8: false, extra: field(Buffer.from('other')), data: 'x' }])))[0].path).toBe('cêaù.png');
    // A plain ASCII stand-in gives way to the real name too.
    expect((await readZipEntries(zipFile([{ name: 'cau.png', utf8: false, extra: field(Buffer.from('cau.png')), data: 'x' }])))[0].path).toBe('ĉaŭ.png');
    // Only the first Unicode field is read: a matching one after a mismatched one is not looked for.
    expect((await readZipEntries(zipFile([{ name: legacy, utf8: false, extra: Buffer.concat([field(Buffer.from('other')), field(legacy)]), data: 'x' }])))[0].path).toBe('cêaù.png');
  });

  it('refuses a file that is not a ZIP file, one cut short, and one whose list of files is damaged', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.zip'), 'not a zip at all, just some text that is long enough');
    await expect(readZipEntries(join(dir, 'a.zip'))).rejects.toThrow(ZipError);
    const whole = rawZip([{ name: 'siteorigin.project.json', data: '{}' }]);
    writeFileSync(join(dir, 'b.zip'), whole.subarray(0, whole.length - 30));
    await expect(readZipEntries(join(dir, 'b.zip'))).rejects.toThrow(/damaged or incomplete/);
    const broken = Buffer.from(whole);
    // The central header's signature, just after the one entry's local header, name and data.
    broken.writeUInt32LE(0x12345678, 30 + 'siteorigin.project.json'.length + 2);
    writeFileSync(join(dir, 'c.zip'), broken);
    await expect(readZipEntries(join(dir, 'c.zip'))).rejects.toThrow(/damaged or incomplete/);
  });

  it('finds the real end of a ZIP file whose comment holds what looks like one', async () => {
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    for (const comment of [Buffer.concat([Buffer.from('note '), fake, Buffer.from(' end')]), Buffer.concat([Buffer.from('note '), fake])]) {
      const entries = await readZipEntries(zipFile([{ name: 'siteorigin.project.json', data: '{}' }], comment));
      expect(entries.map((e) => e.path)).toEqual(['siteorigin.project.json']);
    }
  });
});

describe('an archive that could do harm', () => {
  it.each(['../evil.txt', 'a/../../evil.txt', '/etc/evil', 'C:/evil.txt', 'C:evil.txt'])('refuses %j before writing anything', async (name) => {
    await expect(readZipEntries(zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name, data: 'x' }]))).rejects.toThrow(/outside its folder/);
  });

  it.each(['..\\evil.txt', 'static\\..\\..\\evil.txt'])('treats backslashes in an archive made on Windows as folders, so %j is refused too', async (name) => {
    await expect(readZipEntries(zipFile([{ name, data: 'x', host: 0 }]))).rejects.toThrow(/outside its folder/);
    expect((await readZipEntries(zipFile([{ name: 'static\\logo.png', data: 'x', host: 0 }])))[0].path).toBe('static/logo.png');
  });

  it('keeps a backslash that is part of a name on macOS and Linux, and refuses it on Windows, which would read it as a folder', async () => {
    expect(safeEntryPath('static/draft\\cover.svg', false, false)).toBe('static/draft\\cover.svg');
    expect(safeEntryPath('..\\evil.txt', false, false)).toBe('..\\evil.txt');
    expect(() => safeEntryPath('static/draft\\cover.svg', false, true)).toThrow(/cannot be used safely/);
    if (process.platform !== 'win32') {
      // A name may end in one too: it is still a file, not a folder.
      const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'static/draft\\cover.svg', data: 'x' }, { name: 'static/note\\', data: 'y' }]);
      const dest = temp();
      await extractEntries(zip, await readZipEntries(zip), '', dest);
      expect(readFileSync(join(dest, 'static', 'draft\\cover.svg'), 'utf8')).toBe('x');
      expect(readFileSync(join(dest, 'static', 'note\\'), 'utf8')).toBe('y');
    }
  });

  it.each(['a\u0000b', 'static/CON', 'static/nul.txt', 'static/com1.js', 'static/LPT¹', 'static/photo.jpg:stream', 'static/trailing.', 'static/trailing ', 'x'.repeat(4200)])(
    'refuses the file name %j, which this computer or Windows could not use safely',
    async (name) => {
      await expect(readZipEntries(zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name, data: 'x' }]))).rejects.toThrow(/cannot be used safely/);
    }
  );

  it('keeps ordinary names as they are, decomposed accents and deep folders included', () => {
    expect(safeEntryPath('./a//b/')).toBe('a/b');
    expect(safeEntryPath(`${'a/'.repeat(300)}x`)).toBe(`${'a/'.repeat(300)}x`);
    expect(safeEntryPath('a\\b.txt', true)).toBe('a/b.txt');
    expect(safeEntryPath('cafe\u0301.svg')).toBe('cafe\u0301.svg');
    expect(() => safeEntryPath('./')).toThrow(ZipError);
  });

  it('refuses two names one folder cannot tell apart', async () => {
    const refuses = (entries: RawEntry[], message: RegExp) => expect(readZipEntries(zipFile(entries))).rejects.toThrow(message);
    await refuses([{ name: 'p/Logo.png', data: 'a' }, { name: 'p/logo.png', data: 'b' }], /two files named/);
    await refuses([{ name: 'p/caf\u00e9.png', data: 'a' }, { name: 'p/cafe\u0301.png', data: 'b' }], /two files named/);
    await refuses([{ name: 'p\\logo.png', data: 'a', host: 0 }, { name: 'p/logo.png', data: 'b', host: 0 }], /two files named/);
    await refuses([{ name: 'P/a', data: 'a' }, { name: 'p/a/b', data: 'b' }], /both as a file and as a folder/);
    await refuses([{ name: 'p/a/b', data: 'b' }, { name: 'P/a', data: 'a' }], /both as a file and as a folder/);
    // The same folder spelled two ways is one folder, written the way it was first spelled on every disk.
    const entries = await readZipEntries(zipFile([{ name: 'p/' }, { name: 'P/a', data: 'a' }, { name: 'p/b', data: 'b' }, { name: 'P/Q/' }, { name: 'p/q/c', data: 'c' }]));
    expect(entries.map((e) => e.path)).toEqual(['p', 'p/a', 'p/b', 'p/Q', 'p/Q/c']);
  });

  it('never writes a link, whether made on Unix or on a Mac', async () => {
    for (const host of [3, 19]) {
      const zip = zipFile([
        { name: 'siteorigin.project.json', data: '{}', host },
        { name: 'static/escape', data: '/etc', mode: 0o120777, host }
      ]);
      const all = await readZipEntries(zip);
      expect(all.find((e) => e.path === 'static/escape')?.special).toBe(true);
      // Left out when the project is found, and by the extractor on its own.
      expect((await project(zip)).entries.map((e) => e.path)).toEqual(['siteorigin.project.json']);
      const dest = temp();
      await extractEntries(zip, all, '', dest);
      expect(tree(dest)).toEqual(['siteorigin.project.json']);
    }
  });

  it('refuses encrypted entries and compression it cannot read', async () => {
    await expect(readZipEntries(zipFile([{ name: 'a.txt', data: 'x', flags: 1 }]))).rejects.toThrow(/password-protected/);
    await expect(readZipEntries(zipFile([{ name: 'a.txt', data: 'x', flags: 0x40 }]))).rejects.toThrow(/password-protected/);
    await expect(readZipEntries(zipFile([{ name: 'a.txt', data: 'x', method: 12 }]))).rejects.toThrow(/compression/);
  });

  it('stops writing a file at the size the archive gives for it, and checks its CRC-32', async () => {
    const bad = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'big.txt', data: 'x'.repeat(200_000), deflate: true, size: 10 }]);
    const contents = await project(bad);
    const dest = temp();
    await expect(extractEntries(bad, contents.entries, contents.root, dest)).rejects.toThrow(/big\.txt in that ZIP file is damaged/);
    expect(statSync(join(dest, 'big.txt')).size).toBeLessThanOrEqual(10);
    const crc = zipFile([{ name: 'siteorigin.project.json', data: '{}', crc: 1234 }]);
    const c2 = await project(crc);
    await expect(extractEntries(crc, c2.entries, c2.root, temp())).rejects.toThrow(/damaged/);
  });

  it('refuses more folders than a project could have, however few entries name them', async () => {
    const deep = Array.from({ length: 80 }, (_, k) => ({ name: `d${k}/${'a/'.repeat(255)}` }));
    await expect(readZipEntries(zipFile([{ name: 'siteorigin.project.json', data: '{}' }, ...deep]))).rejects.toThrow(/more folders than a project can/);
  });

  it('never reads past an entry into the next one', async () => {
    // The first file says it holds 10 bytes; its 3 bytes are followed by the next entry's header.
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'a.txt', data: 'abc', size: 10, csize: 10 }, { name: 'b.txt', data: 'b' }]);
    const contents = await project(zip);
    await expect(extractEntries(zip, contents.entries, contents.root, temp())).rejects.toThrow(/damaged or incomplete/);
  });

  it('refuses entries that share their bytes, rather than writing them over and over', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'a.txt', data: 'x'.repeat(1000), deflate: true }, { name: 'b.txt', data: 'x'.repeat(1000), deflate: true, sameDataAs: 1 }]);
    const contents = await project(zip);
    await expect(extractEntries(zip, contents.entries, contents.root, temp())).rejects.toThrow(/damaged or incomplete/);
  });

  it('stops between files once the signal aborts, leaving the rest unwritten', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'a/one.txt', data: 'a' }, { name: 'b/two.txt', data: 'b' }]);
    const contents = await project(zip);
    const abort = new AbortController();
    const dest = temp();
    const mkdir = fsp.mkdir.bind(fsp);
    vi.spyOn(fsp, 'mkdir').mockImplementation(async (p, o) => {
      // The second file's folder: the first file is written by now.
      if (/[\\/]a$/.test(String(p))) abort.abort();
      return mkdir(p, o as never);
    });
    await expect(extractEntries(zip, contents.entries, contents.root, dest, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(dest, 'siteorigin.project.json'))).toBe(true);
    expect(existsSync(join(dest, 'a', 'one.txt'))).toBe(false);
    expect(existsSync(join(dest, 'b'))).toBe(false);
  });
});

describe('unpacking a project into a new folder', () => {
  it('moves on to the next name when someone else fills the folder it claimed, keeping their files', async () => {
    const zip = zipFile([{ name: 'cafe/siteorigin.project.json', data: '{}' }]);
    const parent = temp();
    let claims = 0;
    const dest = await unpackProject(zip, await project(zip), parent, 'cafe', {
      beforePublish: async (dir) => {
        if (claims++ === 0) writeFileSync(join(dir, 'theirs.txt'), 'mine');
      }
    });
    expect(dest).toBe(join(parent, 'cafe-2'));
    expect(readFileSync(join(parent, 'cafe', 'theirs.txt'), 'utf8')).toBe('mine');
    expect(tree(parent)).toEqual(['cafe-2/siteorigin.project.json', 'cafe/theirs.txt']);
  });

  it('gives up on a move that fails with the name still free, instead of trying name after name', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }]);
    const parent = temp();
    let claims = 0;
    // What Windows does when a file in the private folder is held open: the claim is gone and the move is refused.
    const held = Object.assign(new Error('EPERM, reported as taken'), { code: 'EEXIST' });
    const run = unpackProject(zip, await project(zip), parent, 'cafe', {
      beforePublish: async (dir) => {
        claims++;
        rmdirSync(dir);
        throw held;
      }
    });
    await expect(run).rejects.toBe(held);
    expect(claims).toBe(1);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('publishes nothing when called off after the folder is claimed', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }]);
    const parent = temp();
    const abort = new AbortController();
    const run = unpackProject(zip, await project(zip), parent, 'cafe', { signal: abort.signal, beforePublish: async () => abort.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('gives a project named like a Windows device a folder Windows can use', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }]);
    const parent = temp();
    expect(await unpackProject(zip, await project(zip), parent, 'con')).toBe(join(parent, 'con-site'));
  });

  it('removes what it wrote when a file turns out damaged', async () => {
    const zip = zipFile([{ name: 'siteorigin.project.json', data: '{}' }, { name: 'z.txt', data: 'zzz', crc: 1 }]);
    const parent = temp();
    await expect(unpackProject(zip, await project(zip), parent, 'cafe')).rejects.toThrow(/z\.txt in that ZIP file is damaged/);
    expect(readdirSync(parent)).toEqual([]);
  });
});
