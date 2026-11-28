/**
 * The files a snapshot of a project holds (#1151): an allowlist that never lets a private file into a tree, external
 * sources' settings kept apart as attachments, and a capture that fails rather than mix two states of a project that
 * changes while it is read. And the starter's .gitignore, which keeps the same private files out of the author's own
 * repository.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { stateToDocs } from '../../src/main/project/documents';
import { SYNC_SCRIPT } from '../../src/main/export';
import { captureSnapshotInventory, developerOnly, foldName, GENERATED_MANIFEST, MAX_SNAPSHOT_FILE, nameClash, SnapshotCaptureError, snapshotPlace, SNAPSHOT_SYNC_SCRIPT, windowsCanHold, type SnapshotExclusion } from '../../src/main/project/snapshot-inventory';

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-snapshot-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const write = (root: string, rel: string, data: string | Buffer = rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const template = join(__dirname, '../../templates/sveltekit-brochure/files');
const posix = process.platform !== 'win32';

/** A small project as the app leaves one: documents, generated source, public files and the starter's files. */
function smallProject(): string {
  const root = temp();
  write(root, 'siteorigin.project.json', '{"name":"Cafe"}');
  write(root, 'siteorigin/site.json', '{}');
  write(root, 'siteorigin/pages/home.json', '{}');
  write(root, GENERATED_MANIFEST, '{"files":{}}');
  write(root, 'src/routes/+page.svelte', '<h1>Cafe</h1>');
  write(root, 'static/assets/photo-1234abcd.jpg', Buffer.alloc(2048, 7));
  write(root, 'package.json', '{"name":"cafe"}');
  write(root, 'package-lock.json', '{}');
  return root;
}

const failure = async (run: Promise<unknown>) => {
  const e = await run.then(
    () => null,
    (err: unknown) => err
  );
  expect(e).toBeInstanceOf(SnapshotCaptureError);
  return e as SnapshotCaptureError;
};

describe('which files a snapshot holds', () => {
  it('takes the canonical documents, authored code, generated source, the starter’s files and public media', () => {
    for (const p of [
      'siteorigin.project.json',
      'siteorigin/site.json',
      'siteorigin/tokens.json',
      'siteorigin/assets.json',
      'siteorigin/theme-lock.json',
      'siteorigin/published.json',
      'siteorigin/pages/home.json',
      // A page whose ID happens to be "brief" is a page, not the brief.
      'siteorigin/pages/brief.json',
      'siteorigin/components/hero/component.json',
      'siteorigin/collections/posts/collection.json',
      'siteorigin/collections/posts/entries/en_hello1.json',
      GENERATED_MANIFEST,
      'src/lib/siteorigin/custom/Hero.svelte',
      'src/routes/+page.svelte',
      'src/routes/about/+page.svelte',
      'src/app.html',
      'src/hooks.server.js',
      // The author's own hook, which takes the generated one's place.
      'src/hooks.server.ts',
      'src/lib/siteorigin/fonts/inter.woff2',
      // Named like a copy of a private file only in part: a folder, a canonical document, another kind of file.
      'siteorigin/components/docs.key.old/component.json',
      'siteorigin/pages/api-keys-guide.json',
      'static/docs/api-keys.jsonld',
      'src/lib/siteorigin/fonts/api-keys-guide.json.woff2',
      'static/assets/photo-1234abcd.jpg',
      'static/assets/photo-1234abcd-640w.webp',
      'static/robots.txt',
      'static/favicon.svg',
      'package.json',
      'package-lock.json',
      'jsconfig.json',
      'vite.config.js',
      'vite.config.ts',
      'svelte.config.js',
      'vercel.json',
      '.gitignore',
      'README.md',
      'NOTICE.md',
      SNAPSHOT_SYNC_SCRIPT
    ])
      expect(snapshotPlace(p), p).toEqual({ kind: 'tree' });
    expect(SNAPSHOT_SYNC_SCRIPT).toBe(SYNC_SCRIPT);
    expect(GENERATED_MANIFEST).toBe('siteorigin/generated-manifest.json');
  });

  it('takes the developer’s own setup files at the project’s top and the tests under tests/ (#1484)', () => {
    const developers = [
      'tsconfig.json',
      'tsconfig.node.json',
      'tsconfig.app.json',
      'tsconfig.web.prod.json',
      'wrangler.toml',
      'wrangler.json',
      'wrangler.jsonc',
      'netlify.toml',
      'vitest.config.ts',
      'vitest.config.mts',
      'vitest.config.unit.ts',
      'playwright.config.ts',
      'playwright.config.e2e.ts',
      'tool.config.cts',
      'eslint.config.js',
      'eslint.config.mjs',
      'postcss.config.cjs',
      'tailwind.config.js',
      'searchsocket.config.ts',
      'some-tool.config.json',
      'tests/api.test.js',
      'tests/e2e/home.spec.ts',
      'tests/fixtures/sample.json',
      'tests/fixtures/coverage.json',
      // A fixture's folder may be named like coverage: only the tests' own is a test run's.
      'tests/fixtures/coverage/expected.json',
      'tests/coverage',
      'tests/.gitkeep'
    ];
    for (const p of developers) {
      expect(snapshotPlace(p), p).toEqual({ kind: 'tree' });
      expect(developerOnly(p), p).toBe(true);
    }
    // A folder named like a test run's output is one only under tests/.
    for (const p of ['src/coverage/index.html', 'static/test-results/x.png', 'static/coverage/badge.svg']) expect(snapshotPlace(p), p).toEqual({ kind: 'tree' });
    // The starter's own files and the site's are the site's, which a publication carries.
    for (const p of ['notes.txt', 'package.json', 'jsconfig.json', 'vite.config.js', 'vite.config.ts', 'svelte.config.js', 'vercel.json', '.gitignore', 'README.md', 'src/routes/+page.svelte', 'src/lib/api.test.js', 'static/robots.txt', SNAPSHOT_SYNC_SCRIPT, 'siteorigin/site.json']) expect(developerOnly(p), p).toBe(false);
  });

  it('keeps external sources’ settings and converters apart, as attachments, and nothing else of their folder', () => {
    expect(snapshotPlace('siteorigin/sources/cms/source.json')).toEqual({ kind: 'attachment', sourceId: 'cms', part: 'settings' });
    expect(snapshotPlace('siteorigin/sources/cms/converter.mjs')).toEqual({ kind: 'attachment', sourceId: 'cms', part: 'converter' });
    expect(snapshotPlace('siteorigin/sources/team-api/source.json')).toEqual({ kind: 'attachment', sourceId: 'team-api', part: 'settings' });
    expect(snapshotPlace('siteorigin/sources/team-api/converter.mjs')).toEqual({ kind: 'attachment', sourceId: 'team-api', part: 'converter' });
    for (const p of ['siteorigin/sources/cms/source.json~', 'siteorigin/sources/cms/.source.json.swp', 'siteorigin/sources/cms/notes.txt', 'siteorigin/sources/Bad_Id/source.json', 'siteorigin/Sources/cms/source.json', 'siteorigin/SOURCES/cms/converter.mjs', 'siteorigin/sources/source.json'])
      expect(snapshotPlace(p), p).toEqual({ kind: 'excluded', reason: 'source' });
  });

  it('never takes a private file, whatever its case or however deep, nor another repository, the editor’s state or caches', () => {
    const cases: Record<SnapshotExclusion, string[]> = {
      brief: ['siteorigin/brief.json', 'siteorigin/Brief.JSON', 'siteorigin/brief.json~', 'siteorigin/.brief.json.swp', 'siteorigin/#brief.json#', 'siteorigin/brief.json.bak', 'siteorigin/.#brief.json', 'siteorigin/brief (1).json', 'siteorigin/Copy of brief.json', 'SiteOrigin/BRIEF.json'],
      private: [
        '.env',
        '.env.example',
        '.npmrc',
        'static/.env.local',
        'src/lib/id_rsa',
        'static/certs/client.PEM',
        'static/keys/site.key',
        'static/api-keys.json',
        'static/api-keys (1).json',
        'src/Copy of source-secrets.json',
        'siteorigin/source-secrets.json~',
        'siteorigin/pages/.api-keys.json.swp',
        // A folder named like a key leaves everything in it out.
        'static/id_rsa.d/readme.txt',
        // The same name to a case-insensitive disk: `K` here is a Kelvin sign.
        'static/client.\u212Aey',
        // Copies an editor or a sync tool makes of one, and anything named after the app's credential files.
        'static/client.pem~',
        'src/.env~',
        'static/.client.pem.swp',
        'src/#.npmrc#',
        'static/id_rsa.bak',
        'static/api-keys (conflicted copy).json',
        'static/Source-Secrets (Someone’s conflicted copy 2026-11-27).json',
        'static/api-keys-guide.json',
        // In the tests' folder too, and direnv's file wherever it is (#1484).
        'tests/.env.test',
        'tests/fixtures/client.pem',
        'tests/fixtures/api-keys.json',
        'src/.envrc',
        'tests/.envrc',
        'tests/.envrc.local',
        'api-keys.config.json',
        // A test tool's signed-in browser state.
        'tests/.auth/user.json',
        'src/.auth/state.json',
        'tests/.Auth/state.json'
      ],
      // `ſ` is a long s, which APFS takes for an s; HFS+ ignores a zero-width non-joiner.
      // Git reads a `.gitmodules` as its settings, wherever it is (a test's fixture of a repository).
      'local-state': ['.gitmodules', 'tests/fixtures/source/.gitmodules', 'src/lib/.GitModules', '.siteorigin/history/1.json', '.siteorigin/versions.git/HEAD', '.SiteOrigin/versions/versions.json', '.git/config', '.git', 'src/lib/vendor/.git', 'static/old/.GIT/HEAD', 'src/lib/.siteorigin/x.json', 'static/.\u017Fiteorigin/history/1.json', 'src/lib/.g\u200Cit/config'],
      cache: [
        'node_modules/svelte/package.json',
        'src/node_modules/x.js',
        '.svelte-kit/output/x.js',
        'static/.vite/deps.json',
        'build/index.html',
        'Build/index.html',
        // Wrangler's local state, wherever a Worker is, and what a test run writes beside the tests (#1484).
        '.wrangler/state/d1/db.sqlite',
        'src/worker/.wrangler/tmp/bundle.js',
        'tests/.Wrangler/state/db.sqlite',
        'tests/node_modules/x.js',
        'tests/playwright-report/index.html',
        'tests/e2e/test-results/home/trace.zip',
        'tests/Coverage/lcov.info',
        'tests/blob-report/report.zip',
        'tests/unit/playwright-report/index.html'
      ],
      clutter: ['static/.DS_Store', 'static/assets/Thumbs.db', 'src/desktop.ini', 'static/._photo.jpg', 'siteorigin/.a1b2c3.tmp', 'static/upload.TMP'],
      'unsafe-path': [
        '',
        '/etc/passwd',
        '../outside.json',
        'static/../../outside.json',
        'src/./app.html',
        'static//photo.jpg',
        'static\\photo.jpg',
        'C:/Windows/win.ini',
        'static/a\u0000b',
        'static/'
      ],
      source: ['siteorigin/sources/cms/secrets.json'],
      outside: ['notes.txt', 'tsconfig', 'TSConfig.json', 'tsconfig.json.bak', 'wrangler.yaml', 'Wrangler.toml', 'netlify.yml', 'eslint.config.yaml', 'vitest.config.ts.orig', '.config.js', 'config.js', 'vite.config.ts.timestamp-1732780000000-1a2b3c.mjs', 'vite.config.js.timestamp-1732780000000.mjs', 'tools/vitest.config.ts', 'src.config/x.js', 'Tests/api.test.js', 'test/api.test.js', 'Package.json', 'scripts/deploy.sh', 'scripts/sync-sources.mjs.bak', 'scripts/old/sync-sources.mjs', 'siteorigin/notes.txt', 'siteorigin/site.json~', 'siteorigin/pages/home.json.bak', 'docs/readme.md', 'SRC/app.html']
    };
    for (const [reason, list] of Object.entries(cases)) for (const p of list) expect(snapshotPlace(p), p).toEqual({ kind: 'excluded', reason });
    // Only spellings a disk takes for the same name: fullwidth letters are other letters, and a fullwidth slash is no slash.
    for (const p of ['static/guide.\uff54\uff4d\uff50', 'src/.\uff56\uff49\uff54\uff45/x.js', 'static/photos\uff0f.git/banner.png']) expect(snapshotPlace(p), p).toEqual({ kind: 'tree' });
  });

  it('folds a name as a case-insensitive disk compares it', () => {
    expect(foldName('.\u017Fiteorigin')).toBe('.siteorigin');
    expect(foldName('client.\u212Aey')).toBe('client.key');
    expect(foldName('STRA\u1E9EE')).toBe(foldName('Stra\u00dfe'));
    expect(foldName('.g\u200Cit')).toBe('.git');
    expect(foldName('cafe\u0301')).toBe('caf\u00e9');
    expect(foldName('CAF\u00c9')).toBe('caf\u00e9');
    // What HFS+ ignores is taken out before the accents are composed.
    expect(foldName('cafe\u200C\u0301')).toBe('caf\u00e9');
    for (const c of ['\u200d', '\u200f', '\u202a', '\u202e', '\u206a', '\u206f', '\ufeff']) expect(foldName(`.g${c}it`), JSON.stringify(c)).toBe('.git');
    expect(foldName('\uff47')).not.toBe('g');
  });

  it('tells a restore which names Windows cannot hold as they are', () => {
    for (const p of ['static/before:after.png', 'static/photo.jpg:preview', 'static/con.png', 'src/routes/aux/+page.svelte', 'static/CONIN$', 'static/conout$.txt', 'static/photo.jpg.', 'static/photo.jpg ', 'static/banner?.svg', 'static/a|b.png', 'static/"quoted".png', 'static/a*.png', 'static/<b>.png', 'static/a>b.png'])
      expect(windowsCanHold(p), p).toBe(false);
    for (const p of ['static/photo.jpg', 'src/routes/about/+page.svelte', 'static/console.png', 'static/.well-known/x.json', 'siteorigin/pages/home.json']) expect(windowsCanHold(p), p).toBe(true);
  });
});

describe('capturing a project', () => {
  it('captures a whole starter project: every document and generated file, no private one, sources beside the tree', async () => {
    const state = createStarterState('business', 'Cafe', false);
    const root = temp();
    const expected: string[] = [];
    for (const [rel, text] of stateToDocs(state)) {
      write(root, rel, text);
      expected.push(rel);
    }
    for (const [rel, text] of generateProject(state)) {
      write(root, rel, text);
      expected.push(rel);
    }
    write(root, GENERATED_MANIFEST, '{"files":{}}');
    for (const f of ['.gitignore', 'jsconfig.json', 'package.json', 'package-lock.json', 'vite.config.js']) copyFileSync(join(template, f), join(root, f));
    write(root, 'README.md', '# Cafe');
    expected.push(GENERATED_MANIFEST, '.gitignore', 'jsconfig.json', 'package.json', 'package-lock.json', 'vite.config.js', 'README.md');
    // What must never reach a tree.
    const brief = '{"notes":"the owner’s private plans"}';
    write(root, 'siteorigin/brief.json', brief);
    write(root, 'siteorigin/brief.json~', brief);
    write(root, 'siteorigin/sources/cms/source.json', '{"adapter":"rest","token":{"$secret":"cms"}}');
    write(root, 'siteorigin/sources/cms/converter.mjs', 'export default (r) => r;');
    write(root, 'siteorigin/sources/cms/source.json.bak', '{"token":"pasted-by-hand"}');
    write(root, 'static/.env', 'TOKEN=secret');
    write(root, 'static/api-keys (copy).json', '{"openai":"sk-secret"}');
    write(root, 'src/lib/certs/server.Pem', 'PRIVATE');
    write(root, '.siteorigin/history/1.json', brief);
    write(root, '.siteorigin/versions.git/HEAD', 'ref: refs/heads/siteorigin-versions');
    write(root, '.git/config', '[remote "origin"]');
    write(root, 'src/lib/vendor/.git', 'gitdir: ../../../.git/modules/vendor');
    write(root, 'node_modules/svelte/package.json', '{}');
    write(root, '.svelte-kit/generated/root.js', '');
    write(root, 'build/index.html', '');
    write(root, 'notes.txt', 'mine');
    write(root, 'static/.DS_Store', '');
    const inventory = await captureSnapshotInventory(root, { settleMs: 0 });
    const tree = inventory.tree.map((f) => f.path);
    expect(tree).toEqual([...new Set(expected)].filter((p) => p !== 'siteorigin/brief.json' && !p.startsWith('siteorigin/sources/')).sort());
    expect(inventory.attachments.map(({ path, sourceId, part }) => ({ path, sourceId, part }))).toEqual([
      { path: 'siteorigin/sources/cms/converter.mjs', sourceId: 'cms', part: 'converter' },
      { path: 'siteorigin/sources/cms/source.json', sourceId: 'cms', part: 'settings' }
    ]);
    // Each file read again is exactly what was hashed, and no tree file holds a private file's bytes.
    for (const f of [...inventory.tree, ...inventory.attachments]) {
      const bytes = await f.read();
      expect(sha(bytes), f.path).toBe(f.sha256);
      expect(bytes.length, f.path).toBe(f.size);
      expect(bytes.equals(readFileSync(join(root, f.path))), f.path).toBe(true);
    }
    const settings = inventory.attachments.find((a) => a.part === 'settings')!;
    expect((await settings.read()).toString()).toContain('{"$secret":"cms"}');
  });

  it('captures the developer’s setup files and tests an editable export keeps, and none of their private files or caches (#1484)', async () => {
    const root = smallProject();
    const kept = ['tsconfig.json', 'wrangler.toml', 'wrangler.jsonc', 'netlify.toml', 'searchsocket.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'eslint.config.js', 'tests/api.test.js', 'tests/e2e/home.spec.ts', 'tests/fixtures/nested/sample.json'];
    for (const rel of kept) write(root, rel, `// ${rel}\n`);
    // A repository a test uses as its fixture is another repository's work; a lone `.gitmodules` no version can hold.
    write(root, 'tests/fixtures/repo/.git', 'gitdir: ../../../.git/modules/repo');
    write(root, 'tests/fixtures/repo/index.js', 'theirs');
    for (const rel of ['tests/fixtures/source/.gitmodules', 'tests/.auth/user.json', 'tests/.envrc.local', 'tests/.env.local', 'tests/fixtures/client.pem', 'tests/.envrc', '.envrc', '.wrangler/state/d1/db.sqlite', 'tests/.Wrangler/state/db.sqlite', 'tests/node_modules/x/index.js', 'tests/playwright-report/index.html', 'tests/test-results/home/trace.zip', 'tests/coverage/lcov.info', 'tsconfig.tsbuildinfo', 'wrangler.yaml']) write(root, rel, 'TOKEN=secret');
    const readdir = vi.spyOn(fsp, 'readdir');
    const inventory = await captureSnapshotInventory(root, { settleMs: 0 });
    const looked = readdir.mock.calls.map(([dir]) => String(dir));
    readdir.mockRestore();
    expect(looked).toContain(join(root, 'tests/fixtures/nested'));
    // A test run's reports are never even looked in.
    expect(looked.filter((dir) => /playwright-report|test-results|coverage|\.wrangler|\.auth/.test(dir))).toEqual([]);
    const tree = inventory.tree.map((f) => f.path);
    expect(tree).toEqual(['package-lock.json', 'package.json', 'siteorigin.project.json', GENERATED_MANIFEST, 'siteorigin/pages/home.json', 'siteorigin/site.json', 'src/routes/+page.svelte', 'static/assets/photo-1234abcd.jpg', ...kept].sort());
    for (const f of inventory.tree) expect((await f.read()).equals(readFileSync(join(root, f.path))), f.path).toBe(true);
  });

  it('takes drafts and unused library media, keeps a file’s executable bit, and leaves links and special files out', async () => {
    const root = smallProject();
    write(root, 'siteorigin/pages/draft.json', '{"draft":true}');
    write(root, 'static/assets/unused-0badf00d.png', Buffer.alloc(16, 1));
    write(root, SNAPSHOT_SYNC_SCRIPT, '#!/usr/bin/env node');
    if (posix) {
      chmodSync(join(root, SNAPSHOT_SYNC_SCRIPT), 0o755);
      write(root, 'siteorigin/brief.json', 'private');
      // A link to the brief, to a file outside the project, and to a folder, under public names.
      symlinkSync(join(root, 'siteorigin', 'brief.json'), join(root, 'static', 'brief.txt'));
      symlinkSync('/etc/hosts', join(root, 'static', 'hosts'));
      symlinkSync(join(root, 'siteorigin'), join(root, 'static', 'docs'));
      expect(spawnSync('mkfifo', [join(root, 'static', 'feed')]).status).toBe(0);
    }
    const inventory = await captureSnapshotInventory(root, { settleMs: 0 });
    expect(inventory.tree.map((f) => f.path)).toEqual([
      'package-lock.json',
      'package.json',
      'scripts/sync-sources.mjs',
      'siteorigin.project.json',
      GENERATED_MANIFEST,
      'siteorigin/pages/draft.json',
      'siteorigin/pages/home.json',
      'siteorigin/site.json',
      'src/routes/+page.svelte',
      'static/assets/photo-1234abcd.jpg',
      'static/assets/unused-0badf00d.png'
    ]);
    const mode = (p: string) => inventory.tree.find((f) => f.path === p)!.mode;
    expect(mode('package.json')).toBe('100644');
    expect(mode(SNAPSHOT_SYNC_SCRIPT)).toBe(posix ? '100755' : '100644');
  });

  it('reads nothing of a nested repository’s work, a submodule or a checkout inside the project (#1153)', async () => {
    const root = smallProject();
    // A submodule's worktree, marked by its `.git` file, and a nested checkout with a `.git` folder.
    write(root, 'src/vendor/lib/.git', 'gitdir: ../../../.git/modules/lib');
    write(root, 'src/vendor/lib/index.js', 'export const lib = 1;');
    write(root, 'static/kit/.git/HEAD', 'ref: refs/heads/main\n');
    write(root, 'static/kit/logo.svg', '<svg/>');
    // However its marker is spelled: a case-insensitive disk takes `.GIT` for `.git`.
    write(root, 'static/kit2/.GIT', 'gitdir: elsewhere');
    write(root, 'static/kit2/icon.svg', '<svg/>');
    write(root, 'src/vendor/own.js', 'export const own = 1;');
    // A bare repository kept in the project, with no `.git` of its own.
    write(root, 'src/vendor/kept.git/HEAD', 'ref: refs/heads/main\n');
    write(root, 'src/vendor/kept.git/objects/ab/cdef', 'an old object');
    write(root, 'src/vendor/kept.git/refs/heads/main', '0'.repeat(40));
    // The project's own repository leaves the project as it is.
    write(root, '.git/HEAD', 'ref: refs/heads/main\n');
    const paths = (await captureSnapshotInventory(root, { settleMs: 0 })).tree.map((f) => f.path);
    expect(paths).toContain('src/vendor/own.js');
    expect(paths).toContain('src/routes/+page.svelte');
    expect(paths.filter((p) => p.startsWith('src/vendor/lib') || p.startsWith('src/vendor/kept.git') || p.startsWith('static/kit'))).toEqual([]);
    expect(paths).toContain('static/assets/photo-1234abcd.jpg');
    // A site folder that merely has entries of those names is the site's own.
    write(root, 'static/docs/HEAD', 'Heading notes');
    write(root, 'static/docs/objects/list.txt', 'a list');
    write(root, 'static/docs/refs/index.txt', 'references');
    expect((await captureSnapshotInventory(root, { settleMs: 0 })).tree.map((f) => f.path)).toEqual(expect.arrayContaining(['static/docs/HEAD', 'static/docs/objects/list.txt', 'static/docs/refs/index.txt']));
  });

  it('refuses a project that is not a folder', async () => {
    const root = temp();
    write(root, 'file', 'x');
    expect((await failure(captureSnapshotInventory(join(root, 'file')))).reason).toBe('unreadable');
    expect((await failure(captureSnapshotInventory(join(root, 'missing')))).reason).toBe('unreadable');
  });

  it('tells which names some computers cannot tell apart', () => {
    expect(nameClash(['static/Logo.png', 'static/logo.png'])).toEqual(['static/Logo.png', 'static/logo.png']);
    // A file whose name such a disk takes for a folder another file is in.
    expect(nameClash(['static/Logo', 'static/logo/thumb.png'])).toEqual(['static/Logo', 'static/logo/thumb.png']);
    expect(nameClash(['static/logo/thumb.png', 'static/LOGO'])).toEqual(['static/LOGO', 'static/logo/thumb.png']);
    expect(nameClash(['static/Logo', 'static/logo/a/b.png'])).toEqual(['static/Logo', 'static/logo/a/b.png']);
    expect(nameClash(['static/a/b/Logo', 'static/a/b/logo/c/d.png'])).toEqual(['static/a/b/Logo', 'static/a/b/logo/c/d.png']);
    expect(nameClash(['static/Stra\u00dfe.png', 'static/STRA\u1E9EE.png'])).not.toBeNull();
    // Accents composed and decomposed, and a long s, are the same names to APFS.
    expect(nameClash(['static/caf\u00e9.png', 'static/cafe\u0301.png'])).not.toBeNull();
    expect(nameClash(['static/\u017Fun.png', 'static/sun.png'])).not.toBeNull();
    expect(nameClash(['static/logo.png', 'static/logo.svg', 'static/Icons/a.png', 'static/icons/b.png', 'src/lib/a.js'])).toBeNull();
  });

  it.runIf(posix)('refuses two files only a case-sensitive disk can tell apart', async () => {
    const root = smallProject();
    write(root, 'static/Logo.png', 'a');
    // A case-insensitive disk (macOS, Windows) holds only one of them: nothing to refuse.
    if (existsSync(join(root, 'static', 'logo.png'))) return;
    write(root, 'static/logo.png', 'b');
    const e = await failure(captureSnapshotInventory(root));
    expect(e).toMatchObject({ reason: 'name', path: 'static/logo.png' });
  });

  it.runIf(posix)('keeps a name only Windows cannot hold, as a Finder name with a slash or a page at /aux/ has', async () => {
    const root = smallProject();
    const names = ['static/before:after.png', 'src/routes/aux/+page.svelte', 'static/photo.jpg ', 'static/notes.', 'static/what?.png'];
    for (const name of names) write(root, name, 'x');
    const tree = (await captureSnapshotInventory(root, { settleMs: 0 })).tree.map((f) => f.path);
    for (const name of names) expect(tree, name).toContain(name);
  });

  it.runIf(posix)('refuses a file larger than a version can hold, rather than leave it out or hold it whole', async () => {
    const root = smallProject();
    // Sparse: as large as it says, with nothing written.
    const video = join(root, 'static/assets/film-1234abcd.mp4');
    writeFileSync(video, '');
    truncateSync(video, MAX_SNAPSHOT_FILE + 1);
    const opened = vi.spyOn(fsp, 'open');
    try {
      expect(await failure(captureSnapshotInventory(root, { settleMs: 0 }))).toMatchObject({ reason: 'too-large', path: 'static/assets/film-1234abcd.mp4' });
      // Refused before anything is read.
      expect(opened).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
    }
    truncateSync(video, 1024);
    expect((await captureSnapshotInventory(root, { settleMs: 0 })).tree.map((f) => f.path)).toContain('static/assets/film-1234abcd.mp4');
  });

  it.runIf(posix)('refuses a file whose name is not valid text, rather than miss it', async () => {
    const root = smallProject();
    try {
      writeFileSync(Buffer.concat([Buffer.from(`${join(root, 'static')}/photo-`), Buffer.from([0xff]), Buffer.from('.jpg')]), 'x');
    } catch {
      // APFS refuses such a name itself: nothing to miss.
      return;
    }
    expect(await failure(captureSnapshotInventory(root))).toMatchObject({ reason: 'name', path: 'static/photo-\ufffd.jpg' });
    // A folder by such a name is refused too.
    const folder = smallProject();
    mkdirSync(Buffer.concat([Buffer.from(`${join(folder, 'static')}/dir-`), Buffer.from([0xff])]));
    expect(await failure(captureSnapshotInventory(folder))).toMatchObject({ reason: 'name', path: 'static/dir-\ufffd' });
    // A link by such a name is left out like any link, with nothing to refuse.
    const other = smallProject();
    const link = Buffer.concat([Buffer.from(`${join(other, 'static')}/link-`), Buffer.from([0xff])]);
    symlinkSync(join(other, 'package.json'), link);
    expect((await captureSnapshotInventory(other, { settleMs: 0 })).tree.map((f) => f.path)).not.toContain('static/link-\ufffd');
    // One that cannot be looked at, so cannot be told to be a link, fails the capture rather than be passed over.
    const real = fsp.lstat.bind(fsp);
    const denied = vi.spyOn(fsp, 'lstat').mockImplementation((async (p: Parameters<typeof fsp.lstat>[0], ...rest: unknown[]) => {
      if (Buffer.isBuffer(p) && p.equals(link)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (real as (...a: unknown[]) => ReturnType<typeof fsp.lstat>)(p, ...rest);
    }) as typeof fsp.lstat);
    try {
      expect(await failure(captureSnapshotInventory(other))).toMatchObject({ reason: 'unreadable', path: 'static/link-\ufffd' });
    } finally {
      denied.mockRestore();
    }
  });

  it.runIf(posix && process.getuid?.() !== 0)('never looks in a folder that can hold no file of a snapshot’s', async () => {
    const root = smallProject();
    for (const dir of ['scripts/archive', 'siteorigin/old', 'siteorigin/pages/old']) {
      write(root, `${dir}/x.json`, '{}');
      chmodSync(join(root, dir), 0o000);
    }
    try {
      const inventory = await captureSnapshotInventory(root, {
        settleMs: 0,
        // Nor does a folder made in one of those meanwhile count as a change.
        paused: (at) => void (at === 'hashed' && mkdirSync(join(root, 'siteorigin/notes'))),
      });
      expect(inventory.tree.map((f) => f.path)).toContain('siteorigin/pages/home.json');
    } finally {
      for (const dir of ['scripts/archive', 'siteorigin/old', 'siteorigin/pages/old']) chmodSync(join(root, dir), 0o755);
    }
  });
});

describe('a project that changes while it is captured', () => {
  /** Change the project at `at` during a capture, and say what the capture made of it. */
  const during = (root: string, at: 'listed' | 'hashed', change: () => void) =>
    failure(
      captureSnapshotInventory(root, {
        settleMs: 0,
        paused: (now) => {
          if (now === at) change();
        }
      })
    );

  for (const at of ['listed', 'hashed'] as const) {
    it(`fails when the root configuration is edited once the files are ${at}`, async () => {
      const root = smallProject();
      const e = await during(root, at, () => writeFileSync(join(root, 'package.json'), '{"name":"cafe","scripts":{"postinstall":"curl evil"}}'));
      expect(e).toMatchObject({ reason: 'changed', path: 'package.json' });
    });

    it(`fails when a file is edited in place to the same length once the files are ${at}`, async () => {
      const root = smallProject();
      const e = await during(root, at, () => writeFileSync(join(root, 'siteorigin/site.json'), '[]'));
      expect(e).toMatchObject({ reason: 'changed', path: 'siteorigin/site.json' });
    });

    it(`fails when an asset is replaced by another of the same size and time once the files are ${at}`, async () => {
      const root = smallProject();
      const asset = join(root, 'static/assets/photo-1234abcd.jpg');
      const { atime, mtime } = statSync(asset);
      const e = await during(root, at, () => {
        writeFileSync(`${asset}.new`, Buffer.alloc(2048, 9));
        utimesSync(`${asset}.new`, atime, mtime);
        renameSync(`${asset}.new`, asset);
      });
      expect(e).toMatchObject({ reason: 'changed', path: 'static/assets/photo-1234abcd.jpg' });
    });

    it(`fails when a file is deleted once the files are ${at}`, async () => {
      const root = smallProject();
      const e = await during(root, at, () => unlinkSync(join(root, 'siteorigin/pages/home.json')));
      expect(e).toMatchObject({ reason: 'changed', path: 'siteorigin/pages/home.json' });
    });

    it.runIf(posix)(`fails when a file is swapped for a link to the brief once the files are ${at}`, async () => {
      const root = smallProject();
      write(root, 'siteorigin/brief.json', 'private');
      const e = await during(root, at, () => {
        unlinkSync(join(root, 'siteorigin/pages/home.json'));
        symlinkSync(join(root, 'siteorigin/brief.json'), join(root, 'siteorigin/pages/home.json'));
      });
      expect(e).toMatchObject({ reason: 'changed', path: 'siteorigin/pages/home.json' });
    });
  }

  it('fails when a file is added once the files are hashed', async () => {
    const root = smallProject();
    const e = await during(root, 'hashed', () => write(root, 'siteorigin/pages/new.json', '{}'));
    expect(e).toMatchObject({ reason: 'changed', path: 'siteorigin/pages/new.json' });
  });

  it.runIf(posix)('fails when a file is made executable, or a folder swapped for a link, once the files are hashed', async () => {
    let root = smallProject();
    expect(await during(root, 'hashed', () => chmodSync(join(root, 'package.json'), 0o755))).toMatchObject({ reason: 'changed', path: 'package.json' });
    root = smallProject();
    const elsewhere = temp();
    write(elsewhere, 'photo-1234abcd.jpg', Buffer.alloc(2048, 7));
    const e = await during(root, 'hashed', () => {
      renameSync(join(root, 'static/assets'), join(root, 'static/assets-old'));
      symlinkSync(elsewhere, join(root, 'static/assets'));
    });
    // Seen by the second reading of a file inside it, or else by the last listing.
    expect(e.reason).toBe('changed');
    expect(e.path).toMatch(/^static\/assets(\/|$)/);
  });

  it.runIf(posix)('fails when a file is swapped for a pipe once the files are listed', async () => {
    const root = smallProject();
    const e = await during(root, 'listed', () => {
      unlinkSync(join(root, 'package.json'));
      expect(spawnSync('mkfifo', [join(root, 'package.json')]).status).toBe(0);
    });
    expect(e).toMatchObject({ reason: 'changed', path: 'package.json' });
  });

  /**
   * Opens of `abs` from the `nth` on (counting from 1) hand back a handle that reads `bytes` in place of the file's own,
   * its stat untouched: a change no stat can show. `then` runs at that open.
   */
  const alteredFrom = (abs: string, nth: number, bytes: Buffer, then?: () => void) => {
    const real = fsp.open.bind(fsp);
    let seen = 0;
    return vi.spyOn(fsp, 'open').mockImplementation((async (path: Parameters<typeof fsp.open>[0], ...rest: unknown[]) => {
      const handle = await (real as (...a: unknown[]) => ReturnType<typeof fsp.open>)(path, ...rest);
      if (path !== abs || ++seen < nth) return handle;
      then?.();
      // Read from where the last read ended unless told where, as a file handle reads.
      let offset = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'read')
            return async (buf: Buffer, off: number, len: number, pos: number | null) => {
              const at = pos ?? offset;
              const n = Math.max(0, Math.min(len, bytes.length - at));
              bytes.copy(buf, off, at, at + n);
              if (pos === null || pos === undefined) offset = at + n;
              return { bytesRead: n, buffer: buf };
            };
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        }
      });
    }) as typeof fsp.open);
  };

  it('hashes again a file changed only just now, so a change its stat cannot show is still caught', async () => {
    const root = smallProject();
    const pkg = join(root, 'package.json');
    const opened = vi.spyOn(fsp, 'open');
    const opens = () => opened.mock.calls.filter(([p]) => p === pkg).length;
    // Left alone long enough: its stat stands for its bytes, and it is read once.
    await new Promise((r) => setTimeout(r, 50));
    await captureSnapshotInventory(root, { settleMs: 10 });
    expect(opens()).toBe(1);
    opened.mockRestore();
    // Changed within the time it takes to trust a stat: read again, and bytes that differ under the same stat fail it.
    const same = readFileSync(pkg);
    const altered = alteredFrom(pkg, 2, Buffer.from(same.toString().replace('cafe', 'evil')));
    try {
      expect(await failure(captureSnapshotInventory(root, { settleMs: 60 * 60_000 }))).toMatchObject({ reason: 'changed', path: 'package.json' });
    } finally {
      altered.mockRestore();
    }
  });

  it('lists the project again after the second reading, so a file added meanwhile is caught', async () => {
    const root = smallProject();
    const pkg = join(root, 'package.json');
    const added = alteredFrom(pkg, 2, readFileSync(pkg), () => write(root, 'siteorigin/pages/new.json', '{}'));
    try {
      expect(await failure(captureSnapshotInventory(root, { settleMs: 60 * 60_000 }))).toMatchObject({ reason: 'changed', path: 'siteorigin/pages/new.json' });
    } finally {
      added.mockRestore();
    }
  });

  it('reads a file back only while it is still the one captured', async () => {
    const root = smallProject();
    const inventory = await captureSnapshotInventory(root, { settleMs: 0 });
    const file = (p: string) => inventory.tree.find((f) => f.path === p)!;
    expect((await file('siteorigin/site.json').read()).toString()).toBe('{}');
    // Other bytes under the same stat are refused by their hash.
    const site = join(root, 'siteorigin/site.json');
    const altered = alteredFrom(site, 1, Buffer.from('[]'));
    try {
      await expect(file('siteorigin/site.json').read()).rejects.toMatchObject({ reason: 'changed', path: 'siteorigin/site.json' });
    } finally {
      altered.mockRestore();
    }
    writeFileSync(site, '{}');
    await expect(file('siteorigin/site.json').read()).rejects.toMatchObject({ reason: 'changed', path: 'siteorigin/site.json' });
    unlinkSync(join(root, 'package.json'));
    await expect(file('package.json').read()).rejects.toMatchObject({ reason: 'changed', path: 'package.json' });
  });
});

describe('the starter’s .gitignore', () => {
  /** Which of `paths` Git ignores under the starter's rules, with case mattering (as on Linux). */
  const ignored = (list: string[]) => {
    const repo = temp();
    copyFileSync(join(template, '.gitignore'), join(repo, '.gitignore'));
    // No template and no excludes of this computer's own, so only the starter's rules decide.
    expect(spawnSync('git', ['init', '-q', '--template='], { cwd: repo }).status).toBe(0);
    const r = spawnSync('git', ['-c', 'core.ignoreCase=false', '-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], { cwd: repo, input: list.join('\n'), encoding: 'utf8' });
    return new Set(r.stdout.split('\n').filter(Boolean));
  };

  it('keeps the brief, external sources’ settings, credentials and local state out of the author’s repository, and the site in', () => {
    const kept = [
      'siteorigin.project.json',
      'siteorigin/site.json',
      'siteorigin/pages/home.json',
      'siteorigin/pages/brief.json',
      // A file, not the sources' folder.
      'siteorigin/sources',
      'src/routes/+page.svelte',
      'src/lib/siteorigin/custom/Hero.svelte',
      'static/assets/photo.jpg',
      'package.json',
      'package-lock.json',
      'vite.config.js',
      'README.md',
      '.gitignore',
      '.env.example'
    ];
    const left = [
      'siteorigin/brief.json',
      'siteorigin/brief.json~',
      'siteorigin/brief.json.bak',
      'siteorigin/.brief.json.swp',
      'siteorigin/#brief.json#',
      'siteorigin/.#brief.json',
      'siteorigin/brief (1).json',
      'siteorigin/Copy of brief.json',
      'siteorigin/Brief.JSON',
      'siteorigin/sources/cms/source.json',
      'siteorigin/sources/cms/converter.mjs',
      '.siteorigin/versions.git/HEAD',
      '.siteorigin/history/1.json',
      '.env',
      '.ENV',
      '.env.local',
      'static/.EnV.local',
      '.npmrc',
      '.NETRC',
      '.git-credentials',
      'src/lib/id_rsa',
      'src/lib/ID_ED25519.pub',
      'src/lib/Id_Ecdsa',
      'src/lib/ID_DSA',
      'static/certs/client.PEM',
      'static/certs/site.Key',
      'static/bundle.P12',
      'static/bundle.Pfx',
      'static/putty.PPK',
      'static/release.KeyStore',
      'static/release.JKS',
      'static/signing.ASC',
      'static/backup.Gpg',
      'static/api-keys.json',
      'static/API-KEYS.json.bak',
      'static/api-keys (1).json',
      'static/api-keys copy.json',
      'static/api-keys - Copy.json',
      'static/.api-keys.json.swp',
      'static/.#api-keys.json',
      'static/#api-keys.json#',
      'static/source-secrets-2.json',
      'static/api-keys_copy.json',
      'static/api-keys (1).json.bak',
      'Copy of api-keys.json',
      'Copy of source-secrets.json',
      'siteorigin/Source-Secrets.json~',
      'src/.source-secrets.json.swp',
      'node_modules/svelte/package.json',
      'build/index.html'
    ];
    const out = ignored([...kept, ...left]);
    for (const p of left) expect(out.has(p), p).toBe(true);
    for (const p of kept) expect(out.has(p), p).toBe(false);
  });
});
