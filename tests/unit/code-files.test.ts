/**
 * The code workspace's file access (#1483): which project files it reaches, and that a save only ever replaces the
 * file it read, as it read it, while the project still holds it as its own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { pageFile } from '@generator/index';
import { MAX_CODE_FILE_BYTES, codeLanguage, codePathProblem } from '@shared/code-workspace';
import { codeFilePath, editorText, fileBytes, listCodeFiles, readCodeFile, saveCodeFile, type SaveCodeFileOptions } from '../../src/main/project/code-files';
import { sha } from '../../src/main/project/fsutil';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'so-code-files-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const none = () => false;
const opts = (over: Partial<SaveCodeFileOptions> = {}): SaveCodeFileOptions => ({ appWrites: none, fence: async (write) => (await write(), true), open: () => true, ...over });
const caseInsensitive = (dir: string) => existsSync(join(dir, 'SRC'));

describe('codePathProblem', () => {
  it('takes plain code paths under src/ outside the app’s folder', () => {
    for (const p of ['src/lib/util.js', 'src/routes/api/+server.ts', 'src/hooks.server.js', 'src/params/slug.mts', 'src/lib/theme.css', 'src/lib/data.json', 'src/routes/(app)/[id]/+page.svelte']) expect(codePathProblem(p), p).toBeNull();
  });

  it('refuses anything else, however it is spelled', () => {
    for (const p of [
      '',
      'package.json',
      'vite.config.js',
      'siteorigin/site.json',
      'src',
      'src/../package.json',
      'src/lib/./util.js',
      'src//util.js',
      '/src/util.js',
      'src\\lib\\util.js',
      'C:/src/util.js',
      'src/lib/util.js:stream',
      'src/lib/con.js',
      'src/lib/AUX.svelte',
      'src/lib/util.js.',
      'src/lib/util.js ',
      'src/lib/siteorigin/custom/hero.svelte',
      'src/lib/SiteOrigin/generated/x.svelte',
      'src/lib/picture.png',
      'src/lib/util\0.js'
    ])
      expect(codePathProblem(p), JSON.stringify(p)).not.toBeNull();
    expect(codePathProblem(42)).not.toBeNull();
  });

  it('names each file’s language by its extension', () => {
    expect(codeLanguage('src/lib/a.svelte')).toBe('svelte');
    expect(codeLanguage('src/lib/a.MJS')).toBe('javascript');
    expect(codeLanguage('src/lib/a.cts')).toBe('typescript');
    expect(codeLanguage('src/lib/a.css')).toBe('css');
    expect(codeLanguage('src/lib/a.json')).toBe('json');
    expect(codeLanguage('src/lib.d/readme')).toBeNull();
  });
});

describe('editorText and fileBytes', () => {
  it('give the editor plain line breaks, and the file back its own', () => {
    const crlf = Buffer.from('\uFEFFa\r\nb\r\n');
    expect(editorText(crlf)).toBe('a\nb\n');
    expect(fileBytes('a\nb\nc\n', crlf).equals(Buffer.from('\uFEFFa\r\nb\r\nc\r\n'))).toBe(true);
    const lf = Buffer.from('x\ny\n');
    expect(fileBytes('x\nz\n', lf).toString()).toBe('x\nz\n');
    // A file with no line break yet keeps plain ones.
    expect(fileBytes('one\ntwo', Buffer.from('one')).toString()).toBe('one\ntwo');
  });

  it('take no binary or broken text for text', () => {
    expect(editorText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBeNull();
    expect(editorText(Buffer.from([0xc3, 0x28]))).toBeNull();
    expect(editorText(Buffer.from('a\0b'))).toBeNull();
  });

  it('write a file with mixed line breaks the way its first line ends', () => {
    expect(fileBytes('a\nb\n', Buffer.from('a\nb\r\n')).toString()).toBe('a\nb\n');
    expect(fileBytes('a\nb\n', Buffer.from('a\r\nb\n')).toString()).toBe('a\r\nb\r\n');
  });
});

describe('listCodeFiles', () => {
  it('lists the project’s own code and nothing of the app’s, hidden, private or linked', async () => {
    const dir = project({
      'src/lib/util.js': 'export const a = 1;\n',
      'src/lib/format/date.ts': 'export {};\n',
      'src/routes/api/hello/+server.js': 'export function GET() {}\n',
      'src/routes/+page.svelte': '<p>generated</p>\n',
      'src/hooks.server.ts': 'export {};\n',
      'src/lib/siteorigin/generated/Hero.svelte': '<p/>\n',
      'src/lib/siteorigin/custom/mine.svelte': '<p/>\n',
      'src/lib/.secret.js': 'x\n',
      'src/lib/node_modules/dep/index.js': 'x\n',
      'src/lib/picture.png': 'x',
      'src/lib/api-keys.json': '{}\n',
      'src/lib/cert.pem': 'x\n',
      'package.json': '{}\n'
    });
    symlinkSync(join(dir, 'src/lib/util.js'), join(dir, 'src/lib/link.js'));
    symlinkSync(join(dir, 'src/lib/format'), join(dir, 'src/lib/linked-dir'));
    const { files, truncated } = await listCodeFiles(dir, (p) => p === 'src/routes/+page.svelte');
    expect(truncated).toBe(false);
    expect(files.map((f) => f.path)).toEqual(['src/hooks.server.ts', 'src/lib/format/date.ts', 'src/lib/util.js', 'src/routes/api/hello/+server.js']);
    expect(files.find((f) => f.path === 'src/lib/util.js')?.size).toBe(20);
  });
});

describe('listCodeFiles when src/ is a link', () => {
  it('lists nothing through it', async () => {
    const outside = project({ 'src/lib/elsewhere.js': 'x\n' });
    const dir = project({ 'package.json': '{}' });
    symlinkSync(join(outside, 'src'), join(dir, 'src'));
    expect(await listCodeFiles(dir, none)).toEqual({ files: [], truncated: false });
    expect(await readCodeFile(dir, 'src/lib/elsewhere.js', none)).toMatchObject({ ok: false, reason: 'refused' });
  });
});

describe('readCodeFile', () => {
  it('reads a file of the project’s own as the editor holds it, with the hash of its bytes', async () => {
    const bytes = Buffer.from('\uFEFFexport const a = 1;\r\n');
    const dir = project({ 'src/lib/util.js': bytes });
    const r = await readCodeFile(dir, 'src/lib/util.js', none);
    expect(r).toEqual({ ok: true, path: 'src/lib/util.js', text: 'export const a = 1;\n', hash: sha(bytes) });
  });

  it('refuses a file the app writes, a link, another spelling, a binary and a large file', async () => {
    const dir = project({ 'src/lib/util.js': 'a\n', 'src/lib/blob.js': Buffer.from([0, 1, 2]), 'src/lib/big.js': 'x'.repeat(MAX_CODE_FILE_BYTES + 1), 'src/routes/+page.svelte': '<p/>\n', 'siteorigin/site.json': '{}' });
    symlinkSync(join(dir, 'siteorigin/site.json'), join(dir, 'src/lib/site.json'));
    expect(await readCodeFile(dir, 'src/routes/+page.svelte', (p) => p === 'src/routes/+page.svelte')).toMatchObject({ ok: false, reason: 'claimed' });
    expect(await readCodeFile(dir, 'src/lib/site.json', none)).toMatchObject({ ok: false, reason: 'refused' });
    expect(await readCodeFile(dir, 'src/lib/blob.js', none)).toMatchObject({ ok: false, reason: 'binary' });
    expect(await readCodeFile(dir, 'src/lib/big.js', none)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await readCodeFile(dir, 'src/lib/gone.js', none)).toMatchObject({ ok: false, reason: 'gone' });
    expect(await readCodeFile(dir, '../outside.js', none)).toMatchObject({ ok: false, reason: 'refused' });
    // A disk that ignores case would open the file under another spelling: the workspace never does.
    if (caseInsensitive(dir)) expect(await readCodeFile(dir, 'src/Lib/util.js', none)).toMatchObject({ ok: false, reason: 'gone' });
  });

  it('never reaches by name what the listing passes by: credentials, hidden folders, installed packages', async () => {
    const dir = project({ 'src/lib/api-keys.json': '{"key":"x"}\n', 'src/.auth/session.json': '{}\n', 'src/lib/node_modules/dep/index.js': 'x\n', 'src/lib/keys/id_rsa/a.js': 'x\n' });
    for (const path of ['src/lib/api-keys.json', 'src/.auth/session.json', 'src/lib/node_modules/dep/index.js', 'src/lib/keys/id_rsa/a.js']) {
      expect(await readCodeFile(dir, path, none), path).toMatchObject({ ok: false, reason: 'refused' });
      expect(await saveCodeFile(dir, path, 'mine', sha(readFileSync(join(dir, path))), opts()), path).toMatchObject({ ok: false, reason: 'refused' });
      expect(await codeFilePath(dir, path, none), path).toMatchObject({ ok: false });
    }
    expect(readFileSync(join(dir, 'src/lib/api-keys.json'), 'utf8')).toBe('{"key":"x"}\n');
  });

  it('hands over no file the app writes', async () => {
    const dir = project({ 'src/routes/+page.svelte': '<p/>\n' });
    expect(await codeFilePath(dir, 'src/routes/+page.svelte', (p) => p === 'src/routes/+page.svelte')).toMatchObject({ ok: false, reason: 'claimed' });
    expect(await codeFilePath(dir, 'src/routes/+page.svelte', none)).toMatchObject({ ok: true, abs: join(dir, 'src/routes/+page.svelte') });
  });

  it('never reaches the app’s folder through a link inside the project', async () => {
    const dir = project({ 'src/lib/siteorigin/custom/hero.svelte': '<p/>\n' });
    symlinkSync(join(dir, 'src/lib/siteorigin/custom'), join(dir, 'src/lib/parts'));
    expect(await readCodeFile(dir, 'src/lib/parts/hero.svelte', none)).toMatchObject({ ok: false, reason: 'refused' });
    expect(await codeFilePath(dir, 'src/lib/parts/hero.svelte', none)).toMatchObject({ ok: false });
  });
});

describe('saveCodeFile', () => {
  it('saves over the file it read, keeping its line breaks, byte order mark and mode', async () => {
    const was = Buffer.from('\uFEFFconst a = 1;\r\n');
    const dir = project({ 'src/lib/util.js': was });
    chmodSync(join(dir, 'src/lib/util.js'), 0o640);
    const r = await saveCodeFile(dir, 'src/lib/util.js', 'const a = 2;\nconst b = 3;\n', sha(was), opts());
    const now = readFileSync(join(dir, 'src/lib/util.js'));
    expect(now.equals(Buffer.from('\uFEFFconst a = 2;\r\nconst b = 3;\r\n'))).toBe(true);
    expect(r).toEqual({ ok: true, hash: sha(now) });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'src/lib/util.js')).mode & 0o777).toBe(0o640);
    if (process.platform !== 'win32') {
      chmodSync(join(dir, 'src/lib/util.js'), 0o751);
      await saveCodeFile(dir, 'src/lib/util.js', 'again\n', sha(readFileSync(join(dir, 'src/lib/util.js'))), opts());
      expect(statSync(join(dir, 'src/lib/util.js')).mode & 0o777).toBe(0o751);
    }
  });

  it('refuses to save over a file changed since it was read, and only one of two saves from the same read lands', async () => {
    const dir = project({ 'src/lib/util.js': 'one\n' });
    const read = sha(Buffer.from('one\n'));
    writeFileSync(join(dir, 'src/lib/util.js'), 'changed outside\n');
    expect(await saveCodeFile(dir, 'src/lib/util.js', 'mine\n', read, opts())).toMatchObject({ ok: false, reason: 'changed' });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('changed outside\n');
    const base = sha(Buffer.from('changed outside\n'));
    const [a, b] = await Promise.all([saveCodeFile(dir, 'src/lib/util.js', 'first\n', base, opts()), saveCodeFile(dir, 'src/lib/util.js', 'second\n', base, opts())]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(['first\n', 'second\n']).toContain(readFileSync(join(dir, 'src/lib/util.js'), 'utf8'));
  });

  it('checks again just before the new file takes its place', async () => {
    const dir = project({ 'src/lib/util.js': 'one\n' });
    const read = sha(Buffer.from('one\n'));
    // Changed outside after the first look, while the write is being made.
    const r = await saveCodeFile(dir, 'src/lib/util.js', 'mine\n', read, opts({ fence: async (write) => (writeFileSync(join(dir, 'src/lib/util.js'), 'theirs\n'), await write(), true) }));
    expect(r).toMatchObject({ ok: false, reason: 'changed' });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('theirs\n');
    // Another file put in its place meanwhile, holding the very same bytes: it is not the file that was read.
    const same = sha(Buffer.from('theirs\n'));
    // The one read is moved aside, not deleted, so the new file can never be given its number on the disk.
    const swapped = await saveCodeFile(dir, 'src/lib/util.js', 'mine\n', same, opts({ fence: async (write) => (renameSync(join(dir, 'src/lib/util.js'), join(dir, 'src/lib/util.was.js')), writeFileSync(join(dir, 'src/lib/util.js'), 'theirs\n'), await write(), true) }));
    expect(swapped).toMatchObject({ ok: false, reason: 'changed' });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('theirs\n');
    // The app started writing the path meanwhile (a page took that route).
    let claimed = false;
    const late = await saveCodeFile(dir, 'src/lib/util.js', 'mine\n', sha(Buffer.from('theirs\n')), opts({ appWrites: () => claimed, fence: async (write) => ((claimed = true), await write(), true) }));
    expect(late).toMatchObject({ ok: false, reason: 'claimed' });
    // The opening closed meanwhile.
    let open = true;
    const closed = await saveCodeFile(dir, 'src/lib/util.js', 'mine\n', sha(Buffer.from('theirs\n')), opts({ open: () => open, fence: async (write) => ((open = false), await write(), true) }));
    expect(closed).toMatchObject({ ok: false, reason: 'closed' });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('theirs\n');
  });

  it('writes nothing when the project is no longer this app’s, never makes a file that is gone, and refuses the app’s', async () => {
    const dir = project({ 'src/lib/util.js': 'one\n', 'src/routes/+page.svelte': '<p/>\n' });
    const read = sha(Buffer.from('one\n'));
    expect(await saveCodeFile(dir, 'src/lib/util.js', 'mine\n', read, opts({ fence: async () => false }))).toMatchObject({ ok: false, reason: 'closed' });
    expect(await saveCodeFile(dir, 'src/lib/new.js', 'mine\n', read, opts())).toMatchObject({ ok: false, reason: 'gone' });
    expect(existsSync(join(dir, 'src/lib/new.js'))).toBe(false);
    expect(await saveCodeFile(dir, 'src/routes/+page.svelte', '<p>mine</p>\n', sha(Buffer.from('<p/>\n')), opts({ appWrites: (p) => p === 'src/routes/+page.svelte' }))).toMatchObject({ ok: false, reason: 'claimed' });
    expect(await saveCodeFile(dir, 'src/lib/util.js', 'x'.repeat(MAX_CODE_FILE_BYTES + 1), read, opts())).toMatchObject({ ok: false, reason: 'too-large' });
    expect(readFileSync(join(dir, 'src/lib/util.js'), 'utf8')).toBe('one\n');
  });
});

describe('ProjectSession.appWrites', () => {
  it('holds what the app generates, will generate and keeps as its own, and leaves the project’s own files to it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-code-session-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, createStarterState('blank', 'Code', false));
    try {
      writeFileSync(join(dir, 'src/helpers.js'), 'export {};\n');
      const owns = s.appWrites();
      expect(owns('src/routes/+page.svelte')).toBe(true);
      expect(owns('src/routes/+layout.svelte')).toBe(true);
      expect(owns('src/app.html')).toBe(true);
      expect(owns('src/lib/siteorigin/custom/anything.svelte')).toBe(true);
      expect(owns('src/helpers.js')).toBe(false);
      expect(owns('src/routes/about/+page.server.js')).toBe(false);
      // A page added takes its route, which a hand-written file of the same name would have been shadowing.
      const r = await s.apply({ operations: [{ type: 'page.create', title: 'About' }] }, { label: 'Add page' });
      expect(r.ok).toBe(true);
      const page = Object.values(s.state.pages).find((p) => p.title === 'About')!;
      expect(s.appWrites()(pageFile(page))).toBe(true);
    } finally {
      await s.close();
    }
  });
});
