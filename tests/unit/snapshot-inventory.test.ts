/**
 * The files a snapshot of a project holds (#1151): an allowlist that never lets a private file into a tree, external
 * sources' settings kept apart as attachments, and a capture that fails rather than mix two states of a project that
 * changes while it is read. And the starter's .gitignore, which keeps the same private files out of the author's own
 * repository.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { stateToDocs } from '../../src/main/project/documents';
import { SYNC_SCRIPT } from '../../src/main/export';
import { captureSnapshotInventory, GENERATED_MANIFEST, SnapshotCaptureError, snapshotPlace, SNAPSHOT_SYNC_SCRIPT, type SnapshotExclusion } from '../../src/main/project/snapshot-inventory';

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
  });

  it('keeps external sources’ settings and converters apart, as attachments, and nothing else of their folder', () => {
    expect(snapshotPlace('siteorigin/sources/cms/source.json')).toEqual({ kind: 'attachment', sourceId: 'cms', part: 'settings' });
    expect(snapshotPlace('siteorigin/sources/cms/converter.mjs')).toEqual({ kind: 'attachment', sourceId: 'cms', part: 'converter' });
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
        'static/id_rsa.d/readme.txt'
      ],
      'local-state': ['.siteorigin/history/1.json', '.siteorigin/versions.git/HEAD', '.SiteOrigin/versions/versions.json', '.git/config', '.git', 'src/lib/vendor/.git', 'static/old/.GIT/HEAD', 'src/lib/.siteorigin/x.json'],
      cache: ['node_modules/svelte/package.json', 'src/node_modules/x.js', '.svelte-kit/output/x.js', 'static/.vite/deps.json', 'build/index.html', 'Build/index.html'],
      clutter: ['static/.DS_Store', 'static/assets/Thumbs.db', 'src/desktop.ini', 'static/._photo.jpg', 'siteorigin/.a1b2c3.tmp', 'static/upload.TMP'],
      'unsafe-path': ['', '/etc/passwd', '../outside.json', 'static/../../outside.json', 'src/./app.html', 'static//photo.jpg', 'static\\photo.jpg', 'C:/Windows/win.ini', 'static/a\u0000b', 'static/'],
      source: ['siteorigin/sources/cms/secrets.json'],
      outside: ['notes.txt', 'tsconfig.json', 'Package.json', 'scripts/deploy.sh', 'scripts/sync-sources.mjs.bak', 'siteorigin/notes.txt', 'siteorigin/site.json~', 'siteorigin/pages/home.json.bak', 'docs/readme.md', 'SRC/app.html']
    };
    for (const [reason, list] of Object.entries(cases)) for (const p of list) expect(snapshotPlace(p), p).toEqual({ kind: 'excluded', reason });
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

  it('refuses a project that is not a folder', async () => {
    const root = temp();
    write(root, 'file', 'x');
    expect((await failure(captureSnapshotInventory(join(root, 'file')))).reason).toBe('unreadable');
    expect((await failure(captureSnapshotInventory(join(root, 'missing')))).reason).toBe('unreadable');
  });

  it.runIf(posix)('refuses two files only a case-sensitive disk can tell apart', async () => {
    const root = smallProject();
    write(root, 'static/Logo.png', 'a');
    // A case-insensitive disk (macOS, Windows) holds only one of them: nothing to refuse.
    if (existsSync(join(root, 'static', 'logo.png'))) return;
    write(root, 'static/logo.png', 'b');
    const e = await failure(captureSnapshotInventory(root));
    expect(e.reason).toBe('collision');
    expect(e.message).toMatch(/static\/Logo\.png and static\/logo\.png/);
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
    expect(e).toMatchObject({ reason: 'changed', path: 'static/assets' });
  });

  it.runIf(posix)('fails when a file is swapped for a pipe once the files are listed', async () => {
    const root = smallProject();
    const e = await during(root, 'listed', () => {
      unlinkSync(join(root, 'package.json'));
      expect(spawnSync('mkfifo', [join(root, 'package.json')]).status).toBe(0);
    });
    expect(e).toMatchObject({ reason: 'changed', path: 'package.json' });
  });

  it('hashes again a file changed only just now, so a change its stat cannot show is still caught', async () => {
    const root = smallProject();
    const opened = vi.spyOn(fsp, 'open');
    const opens = () => opened.mock.calls.filter(([p]) => p === join(root, 'package.json')).length;
    // Left alone long enough: its stat stands for its bytes, and it is read once.
    await new Promise((r) => setTimeout(r, 50));
    await captureSnapshotInventory(root, { settleMs: 10 });
    expect(opens()).toBe(1);
    opened.mockClear();
    // Changed within the time it takes to trust a stat: read again once the project is listed again.
    await captureSnapshotInventory(root, { settleMs: 60 * 60_000 });
    expect(opens()).toBe(2);
    opened.mockRestore();
  });

  it('reads a file back only while it is still the one captured', async () => {
    const root = smallProject();
    const inventory = await captureSnapshotInventory(root, { settleMs: 0 });
    const file = (p: string) => inventory.tree.find((f) => f.path === p)!;
    expect((await file('siteorigin/site.json').read()).toString()).toBe('{}');
    writeFileSync(join(root, 'siteorigin/site.json'), '{}');
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
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    const r = spawnSync('git', ['-c', 'core.ignoreCase=false', 'check-ignore', '--no-index', '--stdin'], { cwd: repo, input: list.join('\n'), encoding: 'utf8' });
    return new Set(r.stdout.split('\n').filter(Boolean));
  };

  it('keeps the brief, external sources’ settings, credentials and local state out of the author’s repository, and the site in', () => {
    const kept = ['siteorigin.project.json', 'siteorigin/site.json', 'siteorigin/pages/home.json', 'siteorigin/pages/brief.json', 'src/routes/+page.svelte', 'src/lib/siteorigin/custom/Hero.svelte', 'static/assets/photo.jpg', 'package.json', 'package-lock.json', 'vite.config.js', 'README.md', '.gitignore', '.env.example'];
    const left = [
      'siteorigin/brief.json',
      'siteorigin/brief.json~',
      'siteorigin/brief.json.bak',
      'siteorigin/.brief.json.swp',
      'siteorigin/#brief.json#',
      'siteorigin/sources/cms/source.json',
      'siteorigin/sources/cms/converter.mjs',
      '.siteorigin/versions.git/HEAD',
      '.siteorigin/history/1.json',
      '.env',
      '.env.local',
      '.npmrc',
      '.NETRC',
      '.git-credentials',
      'src/lib/id_rsa',
      'src/lib/ID_ED25519.pub',
      'static/certs/client.PEM',
      'static/certs/site.key',
      'static/bundle.p12',
      'static/api-keys.json',
      'static/api-keys (1).json',
      'Copy of source-secrets.json',
      'siteorigin/Source-Secrets.json~',
      'node_modules/svelte/package.json',
      'build/index.html'
    ];
    const out = ignored([...kept, ...left]);
    for (const p of left) expect(out.has(p), p).toBe(true);
    for (const p of kept) expect(out.has(p), p).toBe(false);
  });
});
