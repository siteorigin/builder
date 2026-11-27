/**
 * The versions repository on the bundled Git (#1152): a bare repository at .siteorigin/versions.git that only ever
 * adds whole objects, and moves a branch only under its lock and only from the commit the caller expected. A write that
 * is refused, cancelled or stopped part way (the worker killed) leaves no damaged object and no branch moved, and the
 * repository opens again as it was. The project's own .git is never touched.
 *
 * A crash is a write stopped at a point and never resumed (its promise never settles, so nothing after it runs, not
 * even its clean-up), and the repository opened again by a fresh instance, as a restarted worker would, told that the
 * stopped one's process is gone (the stopped write ran in this test's own process, which is still running).
 */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo, type RepoOptions } from '../../src/main/git/repo';
import { GitError, VERSIONS_BRANCH, type FileInput, type Identity } from '../../src/main/git/protocol';
import { HOST, type FaultPoint } from '../../src/main/git/fs';

const APP: Identity = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };
const PUBLISH = 'refs/heads/siteorigin-publish';
/** A restarted worker: the stopped one's process is gone. */
const RESTARTED: RepoOptions = { processAlive: () => false };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-git-repo-'));
  // The developer's own repository, which nothing here may touch.
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'config'), '[core]\n\tbare = false\n');
  writeFileSync(join(root, '.git', 'index.lock'), 'held by the developer');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const gitdir = () => join(root, '.siteorigin', 'versions.git');
const refLock = () => join(gitdir(), 'refs', 'heads', 'siteorigin-versions.lock');
/** The files the app's branch locks are second names for, in the repository's folder. */
const lockFiles = () => readdirSync(gitdir()).filter((n) => n.startsWith('siteorigin-lock.'));
/** A lock file as an exited (or live) process of the app's on this computer leaves it, and its branch lock with it. */
const appLock = (pid: number, content: string, host = HOST) => {
  const file = join(gitdir(), `siteorigin-lock.${host}.${pid}.siteorigin-versions.0123456789ab`);
  writeFileSync(file, content);
  linkSync(file, refLock());
  return file;
};
const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
/** Every file under the project's own .git, with its bytes: it must be the same after everything. */
const userGit = () => readdirSync(join(root, '.git'), { recursive: true }).map(String).sort().map((p) => [p, lstatSync(join(root, '.git', p)).isFile() ? readFileSync(join(root, '.git', p), 'utf8') : '/']);
/** The objects the repository holds by name (not Git's temporary files). */
const objects = () =>
  existsSync(join(gitdir(), 'objects'))
    ? readdirSync(join(gitdir(), 'objects'))
        .filter((d) => /^[0-9a-f]{2}$/.test(d))
        .flatMap((d) => readdirSync(join(gitdir(), 'objects', d)).filter((f) => /^[0-9a-f]{38}$/.test(f)).map((f) => d + f))
        .sort()
    : [];
const temporaries = () => (existsSync(join(gitdir(), 'objects')) ? readdirSync(join(gitdir(), 'objects'), { recursive: true }).map(String).filter((f) => f.includes('tmp_obj_')) : []);
/** A Git object's name, computed here rather than by the code under test. */
const blobOid = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

/** A write that stops for good at `point`: `reached` resolves there, and nothing after it ever runs. */
function crashAt(point: FaultPoint) {
  let reached: (path: string) => void = () => undefined;
  const at = new Promise<string>((r) => (reached = r));
  const fault: RepoOptions['fault'] = (p, path) => (p === point ? (reached(path), new Promise<never>(() => undefined)) : undefined);
  return { fault, at };
}

async function snapshot(repo = openRepo(root), files: FileInput[] = [{ path: 'siteorigin/site.json', bytes: text('{"name":"Site"}\n') }], parents: string[] = []) {
  const tree = await repo.writeFiles(files);
  return repo.writeCommit({ tree, parents, author: APP, committer: APP, message: 'Saved version\n' });
}

describe('making and opening the repository', () => {
  it('makes a bare repository only when asked, and checks rather than replaces one that is there', async () => {
    const repo = openRepo(root);
    await expect(repo.exists()).resolves.toBe(false);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'not-found' });
    expect(existsSync(join(root, '.siteorigin'))).toBe(false);
    await repo.init();
    await expect(repo.exists()).resolves.toBe(true);
    expect(readFileSync(join(gitdir(), 'HEAD'), 'utf8')).toBe('ref: refs/heads/siteorigin-versions\n');
    expect(readFileSync(join(gitdir(), 'config'), 'utf8')).toMatch(/bare = true/);
    // Nothing of the half-made copy it was built in is left.
    expect(readdirSync(join(root, '.siteorigin'))).toEqual(['versions.git']);
    const commit = await snapshot(repo);
    // Made again: what is there is kept as it is.
    writeFileSync(join(gitdir(), 'config'), `${readFileSync(join(gitdir(), 'config'), 'utf8')}\t# kept\n`);
    const config = readFileSync(join(gitdir(), 'config'), 'utf8');
    await openRepo(root).init();
    expect(readFileSync(join(gitdir(), 'config'), 'utf8')).toBe(config);
    await expect(openRepo(root).readCommit(commit)).resolves.toMatchObject({ oid: commit });
  });

  it('two at once make one repository', async () => {
    await Promise.all([openRepo(root).init(), openRepo(root).init(), openRepo(root).init()]);
    expect(readdirSync(join(root, '.siteorigin'))).toEqual(['versions.git']);
    await expect(openRepo(root).exists()).resolves.toBe(true);
  });

  it('sees the repository removed or replaced while it is open', async () => {
    const repo = openRepo(root);
    await repo.init();
    await expect(repo.exists()).resolves.toBe(true);
    rmSync(gitdir(), { recursive: true });
    await expect(repo.exists()).resolves.toBe(false);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'not-found' });
    await repo.init();
    await expect(repo.exists()).resolves.toBe(true);
  });

  it('refuses a versions.git that points elsewhere or is a link, and never follows it into the project’s .git', async () => {
    const before = userGit();
    mkdirSync(join(root, '.siteorigin'));
    writeFileSync(join(gitdir()), `gitdir: ${join(root, '.git')}\n`);
    await expect(openRepo(root).init()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(openRepo(root).resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'corrupt' });
    rmSync(gitdir());
    // A link to a whole bare repository of the app's own making is refused just the same.
    const elsewhere = mkdtempSync(join(tmpdir(), 'so-git-elsewhere-'));
    await openRepo(elsewhere).init();
    symlinkSync(join(elsewhere, '.siteorigin', 'versions.git'), gitdir(), 'dir');
    await expect(openRepo(root).exists()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(snapshot()).rejects.toMatchObject({ code: 'corrupt' });
    rmSync(elsewhere, { recursive: true, force: true });
    expect(userGit()).toEqual(before);
  });

  it('refuses to write through an object folder that is a link to another repository, even for an object it holds', async () => {
    await openRepo(root).init();
    const bytes = text('hello');
    const oid = blobOid(bytes);
    mkdirSync(join(root, '.git', 'objects', oid.slice(0, 2)), { recursive: true });
    writeFileSync(join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), 'not really it');
    const before = userGit();
    symlinkSync(join(root, '.git', 'objects', oid.slice(0, 2)), join(gitdir(), 'objects', oid.slice(0, 2)), 'dir');
    await expect(openRepo(root).writeBlob({ bytes })).rejects.toMatchObject({ code: 'corrupt' });
    await expect(openRepo(root).writeFiles([{ path: 'a.txt', bytes }])).rejects.toMatchObject({ code: 'corrupt' });
    expect(userGit()).toEqual(before);
  });

  it('takes nothing that is not a file under an object’s name for the object', async () => {
    const repo = openRepo(root);
    await repo.init();
    const bytes = text('dangling');
    const oid = blobOid(bytes);
    mkdirSync(join(gitdir(), 'objects', oid.slice(0, 2)));
    symlinkSync(join(root, 'nowhere'), join(gitdir(), 'objects', oid.slice(0, 2), oid.slice(2)));
    await expect(repo.writeFiles([{ path: 'a.txt', bytes }])).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('writing and reading versions', () => {
  it('writes a tree of documents and media from its file map, and reads every file back as it was', async () => {
    const repo = openRepo(root);
    await repo.init();
    mkdirSync(join(root, 'static', 'assets'), { recursive: true });
    const photo = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7919) % 256));
    writeFileSync(join(root, 'static', 'assets', 'photo.jpg'), photo);
    const files: FileInput[] = [
      { path: 'siteorigin/site.json', bytes: text('{"name":"Site"}\n') },
      { path: 'siteorigin/pages/home.json', bytes: text('{"title":"Home"}\n') },
      { path: 'static/assets/photo.jpg', source: 'static/assets/photo.jpg' },
      { path: 'static/empty.txt', bytes: new Uint8Array(0) },
      { path: 'static/café ünïcode.txt', bytes: text('naïve') },
      // The same name in two folders is two files.
      { path: 'static/assets/home.json', bytes: text('not the page') }
    ];
    const tree = await repo.writeFiles(files);
    expect((await repo.readTree(tree)).map((e) => [e.path, e.type, e.mode])).toEqual([
      ['siteorigin', 'tree', '040000'],
      ['static', 'tree', '040000']
    ]);
    const photoOid = blobOid(photo);
    expect(objects()).toContain(photoOid);
    const commit = await repo.writeCommit({ tree, parents: [], author: APP, committer: { ...APP, timestamp: APP.timestamp + 1, timezoneOffset: -600 }, message: 'Saved version\n' });
    // A fresh repository object is a restarted worker: everything is read back from the disk, through the commit.
    const again = openRepo(root);
    for (const f of files) {
      const want = 'bytes' in f ? Buffer.from(f.bytes) : photo;
      expect(Buffer.from(await again.readBlob(commit, f.path)).equals(want), f.path).toBe(true);
    }
    expect(decode(await again.readBlob(blobOid(text('{"name":"Site"}\n'))))).toBe('{"name":"Site"}\n');
    await expect(again.readBlob(commit, 'static/missing.txt')).rejects.toMatchObject({ code: 'not-found' });
    expect(await again.readCommit(commit)).toEqual({
      oid: commit,
      tree,
      parents: [],
      message: 'Saved version\n',
      author: APP,
      committer: { ...APP, timestamp: APP.timestamp + 1, timezoneOffset: -600 }
    });
  });

  it('stores a project file only while it holds the bytes the caller hashed (#1153)', async () => {
    const repo = openRepo(root);
    await repo.init();
    mkdirSync(join(root, 'static', 'assets'), { recursive: true });
    const before = Buffer.from('picture A, as it was hashed');
    const sha256 = createHash('sha256').update(before).digest('hex');
    writeFileSync(join(root, 'static', 'assets', 'photo.jpg'), before);
    const tree = await repo.writeFiles([{ path: 'static/assets/photo.jpg', source: 'static/assets/photo.jpg', sha256 }]);
    expect(Buffer.from(await repo.readBlob(tree, 'static/assets/photo.jpg')).equals(before)).toBe(true);
    // Replaced in place by a picture of the same size after it was hashed: refused, and nothing of it stored.
    const after = Buffer.from('picture B, put there later!');
    expect(after.length).toBe(before.length);
    writeFileSync(join(root, 'static', 'assets', 'photo.jpg'), after);
    const held = objects();
    await expect(repo.writeFiles([{ path: 'static/assets/photo.jpg', source: 'static/assets/photo.jpg', sha256 }])).rejects.toMatchObject({ code: 'changed' });
    expect(objects()).toEqual(held);
    expect(objects()).not.toContain(blobOid(after));
    await expect(repo.writeFiles([{ path: 'x', source: 'static/assets/photo.jpg', sha256: 'not-a-hash' }])).rejects.toMatchObject({ code: 'invalid' });
  });

  it('writes again an object it would reuse when the copy there is damaged, and keeps a file’s executable mode (#1153)', async () => {
    const repo = openRepo(root);
    await repo.init();
    const bytes = text('a picture, stored once');
    const tree = await repo.writeFiles([{ path: 'static/photo.jpg', bytes }]);
    const oid = blobOid(bytes);
    const path = join(gitdir(), 'objects', oid.slice(0, 2), oid.slice(2));
    // Cut short in place, as a disk that lost its last write would leave it.
    writeFileSync(path, readFileSync(path).subarray(0, 6));
    // A worker that has not read it back yet (a fresh one) finds it damaged and stores it again.
    const again = openRepo(root);
    expect(await again.writeFiles([{ path: 'static/photo.jpg', bytes }])).toBe(tree);
    expect(Buffer.from(await again.readBlob(tree, 'static/photo.jpg')).equals(Buffer.from(bytes))).toBe(true);
    const run = await again.writeFiles([{ path: 'scripts/run.sh', bytes: text('#!/bin/sh'), mode: '100755' }, { path: 'scripts/notes.txt', bytes: text('notes') }]);
    const [scripts] = await again.readTree(run);
    expect((await again.readTree(scripts.oid)).map((e) => [e.path, e.mode])).toEqual([
      ['notes.txt', '100644'],
      ['run.sh', '100755']
    ]);
    await expect(again.writeFiles([{ path: 'x', bytes: text('x'), mode: '120000' as '100644' }])).rejects.toMatchObject({ code: 'invalid' });
    // Whole, but other content under its name (it inflates, and is still not this object): written again too, by the
    // same worker that found it whole before, since the file is not the one it read back then.
    writeFileSync(path, deflateSync(Buffer.from('blob 5\0other')));
    expect(await again.writeFiles([{ path: 'static/photo.jpg', bytes }])).toBe(tree);
    expect(Buffer.from(await openRepo(root).readBlob(tree, 'static/photo.jpg')).equals(Buffer.from(bytes))).toBe(true);
  });

  it('writes again a folder’s tree it would reuse when the copy there is damaged (#1153)', async () => {
    const repo = openRepo(root);
    await repo.init();
    const files: FileInput[] = [
      { path: 'siteorigin/pages/home.json', bytes: text('{"title":"Home"}') },
      { path: 'siteorigin/site.json', bytes: text('{"name":"Site"}') }
    ];
    const top = await repo.writeFiles(files);
    const siteorigin = (await repo.readTree(top)).find((e) => e.path === 'siteorigin')!.oid;
    const pages = (await repo.readTree(siteorigin)).find((e) => e.path === 'pages')!.oid;
    const path = join(gitdir(), 'objects', pages.slice(0, 2), pages.slice(2));
    writeFileSync(path, readFileSync(path).subarray(0, 4));
    // Another save of the same pages, by a fresh worker: the tree is whole again, and every page reads back.
    const again = openRepo(root);
    expect(await again.writeFiles(files)).toBe(top);
    expect(decode(await openRepo(root).readBlob(top, 'siteorigin/pages/home.json'))).toBe('{"title":"Home"}');
  });

  it('publishes commits to a branch, lists them newest first, and keeps a second history with its own root', async () => {
    const repo = openRepo(root, { limits: { maxLogDepth: 3 } });
    await repo.init();
    await expect(repo.listCommits(VERSIONS_BRANCH, 10)).resolves.toEqual([]);
    const first = await snapshot(repo);
    await repo.advanceRef(VERSIONS_BRANCH, first, null);
    const commits = [first];
    for (const name of ['Second', 'Third', 'Fourth']) {
      const tree = await repo.writeFiles([{ path: 'siteorigin/site.json', bytes: text(`{"name":"${name}"}\n`) }]);
      const next = await repo.writeCommit({ tree, parents: [commits[0]], author: APP, committer: APP, message: `${name}\n` });
      await repo.advanceRef(VERSIONS_BRANCH, next, commits[0]);
      commits.unshift(next);
    }
    const publish = await snapshot(repo, [{ path: 'build/index.html', bytes: text('<h1>Site</h1>') }]);
    await repo.advanceRef(PUBLISH, publish, null);
    const reopened = openRepo(root, { limits: { maxLogDepth: 3 } });
    expect(await reopened.resolveRef(VERSIONS_BRANCH)).toBe(commits[0]);
    // At most the limit asked for, and never more than the repository's own.
    expect((await reopened.listCommits(VERSIONS_BRANCH, 10)).map((c) => c.oid)).toEqual(commits.slice(0, 3));
    expect((await reopened.listCommits(VERSIONS_BRANCH, 1)).map((c) => [c.oid, c.parents, c.message])).toEqual([[commits[0], [commits[1]], 'Fourth\n']]);
    expect((await reopened.listCommits(PUBLISH, 10)).map((c) => [c.oid, c.parents])).toEqual([[publish, []]]);
    expect(readFileSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions'), 'utf8')).toBe(`${commits[0]}\n`);
  });

  it('writes nothing again for a file it already holds, giving one a day old the time now as Git does, and the same names for the same content', async () => {
    const repo = openRepo(root);
    await repo.init();
    const bytes = text('{}\n');
    const files: FileInput[] = [{ path: 'siteorigin/site.json', bytes }];
    const a = await repo.writeFiles(files);
    const held = objects();
    const at = (o: string) => join(gitdir(), 'objects', o.slice(0, 2), o.slice(2));
    const inodes = held.map((o) => statSync(at(o)).ino);
    const old = Date.now() / 1000 - 2 * 86_400;
    for (const o of held) utimesSync(at(o), old, old);
    const started = Date.now();
    expect(await repo.writeFiles(files)).toBe(a);
    expect(objects()).toEqual(held);
    // Not one rewritten (a rewrite is a new file in its place); the file used again was told it is in use.
    expect(held.map((o) => statSync(at(o)).ino)).toEqual(inodes);
    expect(statSync(at(blobOid(bytes))).mtimeMs).toBeGreaterThanOrEqual(started - 1000);
    expect(temporaries()).toEqual([]);
    // Different content at the same path is another tree.
    expect(await repo.writeFiles([{ path: 'siteorigin/site.json', bytes: text('{"x":1}\n') }])).not.toBe(a);
  });

  it('refuses commits that name a tree or parent it does not hold, or an identity it could not read back', async () => {
    const repo = openRepo(root);
    await repo.init();
    const tree = await repo.writeFiles([{ path: 'a.txt', bytes: text('a') }]);
    const blob = blobOid(text('a'));
    const missing = 'a'.repeat(40);
    const commit = (c: Partial<Parameters<typeof repo.writeCommit>[0]>) => repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'x', ...c });
    await expect(commit({ tree: missing })).rejects.toMatchObject({ code: 'not-found' });
    await expect(commit({ tree: blob })).rejects.toMatchObject({ code: 'not-found' });
    await expect(commit({ parents: [missing] })).rejects.toMatchObject({ code: 'not-found' });
    await expect(commit({ parents: [tree] })).rejects.toMatchObject({ code: 'not-found' });
    await expect(commit({ parents: Array.from({ length: 9 }, () => missing) })).rejects.toMatchObject({ code: 'invalid' });
    for (const bad of [{ email: 'a>b' }, { name: 'A\rB' }, { name: 'A B' }, { name: 'A B' }, { name: '  ' }, { timestamp: 1.5 }, { timezoneOffset: 24 * 60 + 1 }]) {
      await expect(commit({ author: { ...APP, ...bad } }), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid' });
      await expect(commit({ committer: { ...APP, ...bad } }), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(commit({ message: 'a\0b' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(openRepo(root, { limits: { maxMessageBytes: 10 } }).writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'éééééé' })).rejects.toMatchObject({ code: 'too-large' });
    await expect(commit({ tree: 'HEAD' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.advanceRef(VERSIONS_BRANCH, tree, null)).rejects.toMatchObject({ code: 'not-found' });
    await expect(repo.advanceRef(VERSIONS_BRANCH, missing, null)).rejects.toMatchObject({ code: 'not-found' });
    const ok = await commit({});
    await expect(repo.advanceRef(VERSIONS_BRANCH, ok, 'HEAD')).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.advanceRef('refs/heads/main', ok, null)).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.advanceRef(`refs/heads/siteorigin-${'a'.repeat(240)}`, ok, null)).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.resolveRef('HEAD')).rejects.toMatchObject({ code: 'invalid' });
    expect(readdirSync(join(gitdir(), 'refs', 'heads'))).toEqual([]);
  });
});

describe('refusing what a version cannot hold, before writing anything', () => {
  it.each<[string, FileInput[], string]>([
    ['a parent folder', [{ path: '../outside.txt', bytes: text('x') }], 'invalid'],
    ['a dot folder', [{ path: 'a/./b', bytes: text('x') }], 'invalid'],
    ['an absolute path', [{ path: '/etc/passwd', bytes: text('x') }], 'invalid'],
    ['a trailing slash', [{ path: 'static/', bytes: text('x') }], 'invalid'],
    ['a .git folder', [{ path: 'static/.git/config', bytes: text('x') }], 'invalid'],
    ['a .GIT spelling', [{ path: '.GIT ', bytes: text('x') }], 'invalid'],
    ['.git with a character macOS ignores', [{ path: '.gi‍t/config', bytes: text('x') }], 'invalid'],
    ['.git with a Windows stream', [{ path: '.git::$INDEX_ALLOCATION/config', bytes: text('x') }], 'invalid'],
    ['.git’s Windows short name', [{ path: 'git~1./config', bytes: text('x') }], 'invalid'],
    ['.git~1', [{ path: '.git~1', bytes: text('x') }], 'invalid'],
    ['a .gitmodules file', [{ path: '.gitmodules', bytes: text('[submodule]') }], 'invalid'],
    ['.gitmodules’s Windows short name', [{ path: 'gitmod~1/x', bytes: text('x') }], 'invalid'],
    ['a .gitattributes short-name folder', [{ path: 'gi7d29~1/x', bytes: text('x') }], 'invalid'],
    ['a .gitattributes folder', [{ path: '.gitattributes/x', bytes: text('x') }], 'invalid'],
    ['a backslash', [{ path: 'static\\a.txt', bytes: text('x') }], 'invalid'],
    ['a NUL', [{ path: 'a\0b', bytes: text('x') }], 'invalid'],
    ['a broken character', [{ path: '\ud800.txt', bytes: text('x') }], 'invalid'],
    ['an empty part', [{ path: 'static//a.txt', bytes: text('x') }], 'invalid'],
    ['the same file twice', [{ path: 'a.txt', bytes: text('x') }, { path: 'a.txt', bytes: text('y') }], 'invalid'],
    ['two spellings a Mac would make one file', [{ path: 'static/Logo.png', bytes: text('x') }, { path: 'static/logo.png', bytes: text('y') }], 'invalid'],
    ['two spellings a Mac would make one folder', [{ path: 'Logo/x', bytes: text('x') }, { path: 'logo/y', bytes: text('y') }], 'invalid'],
    ['two Unicode spellings of one name', [{ path: 'café.txt', bytes: text('x') }, { path: 'café.txt', bytes: text('y') }], 'invalid'],
    ['two Unicode spellings of one folder', [{ path: 'café/x', bytes: text('x') }, { path: 'café/y', bytes: text('y') }], 'invalid'],
    ['two Greek sigmas', [{ path: 'σ.txt', bytes: text('x') }, { path: 'ς.txt', bytes: text('y') }], 'invalid'],
    ['a name and the same with a trailing dot', [{ path: 'logo', bytes: text('x') }, { path: 'logo.', bytes: text('y') }], 'invalid'],
    ['a file where a folder is', [{ path: 'static', bytes: text('x') }, { path: 'static/a.txt', bytes: text('y') }], 'invalid'],
    ['a folder where a file is', [{ path: 'static/a.txt', bytes: text('y') }, { path: 'static', bytes: text('x') }], 'invalid'],
    ['a file outside the project', [{ path: 'x', source: '../x' }], 'invalid'],
    ['a project file through a parent folder', [{ path: 'x', source: 'static/../present.txt' }], 'invalid'],
    ['the project’s .git as a file', [{ path: 'x', source: '.git/config' }], 'invalid'],
    ['a missing file', [{ path: 'x', source: 'static/missing.png' }], 'not-found'],
    ['a file over the limit', [{ path: 'big.bin', bytes: new Uint8Array(2049) }], 'too-large'],
    ['files over the limit together', [{ path: 'a.bin', bytes: new Uint8Array(1500) }, { path: 'b.bin', bytes: new Uint8Array(1500) }, { path: 'c.bin', bytes: new Uint8Array(1500) }], 'too-large'],
    ['too many files', Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, bytes: text('x') })), 'too-large'],
    ['too long a path', [{ path: 'é'.repeat(51), bytes: text('x') }], 'too-large'],
    ['too deep a path', [{ path: Array.from({ length: 9 }, () => 'd').join('/'), bytes: text('x') }], 'too-large']
  ])('%s', async (_what, files, code) => {
    writeFileSync(join(root, 'present.txt'), 'present');
    await openRepo(root).init();
    // A good file first: it is not written either, nor is anything read or staged.
    let reached = false;
    const watched = openRepo(root, { limits: { maxBlobBytes: 2048, maxTotalBytes: 4000, maxEntries: 5, maxPathBytes: 101, maxDepth: 8 }, fault: () => void (reached = true) });
    const held = objects();
    await expect(watched.writeFiles([{ path: 'first.txt', bytes: text('written first?') }, ...files])).rejects.toMatchObject({ code });
    expect(reached).toBe(false);
    expect(objects()).toEqual(held);
    expect(temporaries()).toEqual([]);
  });

  it('refuses a name longer than a folder can hold, and takes one exactly as long', async () => {
    const repo = openRepo(root);
    await repo.init();
    await expect(repo.writeFiles([{ path: `static/${'x'.repeat(256)}`, bytes: text('x') }])).rejects.toMatchObject({ code: 'too-large' });
    await repo.writeFiles([{ path: `static/${'x'.repeat(255)}`, bytes: text('x') }]);
  });

  it('takes a version at exactly each limit', async () => {
    const repo = openRepo(root, { limits: { maxBlobBytes: 2048, maxTotalBytes: 4096, maxEntries: 3, maxPathBytes: 100, maxDepth: 3 } });
    await repo.init();
    await repo.writeFiles([
      { path: 'a.bin', bytes: new Uint8Array(2048) },
      { path: 'b/c/' + 'é'.repeat(46), bytes: new Uint8Array(2048) },
      { path: 'x'.repeat(100), bytes: new Uint8Array(0) }
    ]);
  });

  it('refuses a picture larger than the limit, read from the disk, by its size alone', async () => {
    const repo = openRepo(root, { limits: { maxBlobBytes: 1024 } });
    await repo.init();
    mkdirSync(join(root, 'static'));
    writeFileSync(join(root, 'static', 'huge.mp4'), new Uint8Array(4096));
    let checked = false;
    const watched = openRepo(root, { limits: { maxBlobBytes: 1024 }, fault: (p) => void (p === 'files-checked' && (checked = true)) });
    const held = objects();
    await expect(watched.writeFiles([{ path: 'first.txt', bytes: text('first') }, { path: 'static/huge.mp4', source: 'static/huge.mp4' }])).rejects.toMatchObject({ code: 'too-large' });
    expect(checked).toBe(false);
    await expect(repo.writeBlob({ source: 'static/huge.mp4' })).rejects.toMatchObject({ code: 'too-large' });
    expect(objects()).toEqual(held);
  });

  it('refuses a picture that is a link, or reached through a folder linked to the project’s .git', async () => {
    mkdirSync(join(root, 'static'));
    symlinkSync(join(root, '.git', 'HEAD'), join(root, 'static', 'linked.png'));
    symlinkSync(join(root, '.git'), join(root, 'static', 'alias'), 'dir');
    const repo = openRepo(root);
    await repo.init();
    const held = objects();
    for (const source of ['static/linked.png', 'static/alias/config', 'static/alias/HEAD']) {
      await expect(repo.writeFiles([{ path: 'x.txt', source }]), source).rejects.toMatchObject({ code: 'invalid' });
      await expect(repo.writeBlob({ source }), source).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(objects()).toEqual(held);
    expect(objects()).not.toContain(blobOid(readFileSync(join(root, '.git', 'config'))));
  });

  it('refuses a picture whose folder is swapped for a link to the project’s .git while the version is saved', async () => {
    mkdirSync(join(root, 'static'));
    writeFileSync(join(root, 'static', 'config'), 'a picture named config');
    const swapping = openRepo(root, {
      fault: (p) => {
        if (p !== 'files-checked') return;
        rmSync(join(root, 'static'), { recursive: true });
        symlinkSync(join(root, '.git'), join(root, 'static'), 'dir');
      }
    });
    await swapping.init();
    await expect(swapping.writeFiles([{ path: 'static/config', source: 'static/config' }])).rejects.toMatchObject({ code: 'changed' });
    expect(objects()).not.toContain(blobOid(readFileSync(join(root, '.git', 'config'))));
  });

  it('refuses a picture that changes while the version is saved, even to bytes of the same size and time', async () => {
    mkdirSync(join(root, 'static'));
    const file = join(root, 'static', 'a.png');
    const changes: Array<() => void> = [
      () => writeFileSync(file, 'second, longer'),
      () => {
        // Same size, and its time put back: only the change time tells.
        const { atime, mtime } = statSync(file);
        writeFileSync(file, 'FIRST');
        utimesSync(file, atime, mtime);
      },
      () => {
        rmSync(file);
        writeFileSync(file, 'other');
      }
    ];
    for (const change of changes) {
      writeFileSync(file, 'first');
      const at = Date.now() / 1000 - 120;
      utimesSync(file, at, at);
      const changing = openRepo(root, { fault: (p) => (p === 'files-checked' ? change() : undefined) });
      await changing.init();
      const held = objects();
      await expect(changing.writeFiles([{ path: 'static/a.png', source: 'static/a.png' }])).rejects.toMatchObject({ code: 'changed' });
      expect(objects()).toEqual(held);
    }
  });
});

describe('moving a branch', () => {
  it('moves a branch only from the commit expected, and says where it is when it is not there', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    const b = await snapshot(repo, [{ path: 'b.txt', bytes: text('b') }], [a]);
    await repo.advanceRef(VERSIONS_BRANCH, a, null);
    const refused = await repo.advanceRef(VERSIONS_BRANCH, b, null).catch((e: GitError) => e);
    expect(refused).toBeInstanceOf(GitError);
    expect(refused).toMatchObject({ code: 'conflict', actual: a });
    await expect(repo.advanceRef(VERSIONS_BRANCH, b, b)).rejects.toMatchObject({ code: 'conflict', actual: a });
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(a);
    await repo.advanceRef(VERSIONS_BRANCH, b, a);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(b);
    expect(readdirSync(join(gitdir(), 'refs', 'heads'))).toEqual(['siteorigin-versions']);
    expect(lockFiles()).toEqual([]);
  });

  it('lets exactly one of two writers from the same commit win, in one repository object or two', async () => {
    for (const second of [() => openRepo(root), (one: ReturnType<typeof openRepo>) => one]) {
      rmSync(join(root, '.siteorigin'), { recursive: true, force: true });
      const one = openRepo(root);
      await one.init();
      const base = await snapshot(one);
      await one.advanceRef(VERSIONS_BRANCH, base, null);
      const x = await snapshot(one, [{ path: 'x', bytes: text('x') }], [base]);
      const y = await snapshot(one, [{ path: 'y', bytes: text('y') }], [base]);
      const results = await Promise.allSettled([one.advanceRef(VERSIONS_BRANCH, x, base), second(one).advanceRef(VERSIONS_BRANCH, y, base)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const winner = results[0].status === 'fulfilled' ? x : y;
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict', actual: winner });
      expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(winner);
    }
  });

  it('keeps a second writer out while the first holds the branch, its lock a second name for a file saying whose it is', async () => {
    const setup = openRepo(root);
    await setup.init();
    const a = await snapshot(setup);
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((r) => (held = r));
    const first = openRepo(root, { fault: (p) => (p === 'lock-written' ? (held(), new Promise<void>((r) => (release = r))) : undefined) });
    const moving = first.advanceRef(VERSIONS_BRANCH, a, null);
    await holding;
    // While it holds it: the lock holds its commit, whole, and is the very file named for this computer, process and branch.
    expect(readFileSync(refLock(), 'utf8')).toBe(`${a}\n`);
    const files = lockFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^siteorigin-lock\\.${HOST}\\.${process.pid}\\.siteorigin-versions\\.[0-9a-f]+$`));
    expect(statSync(join(gitdir(), files[0])).ino).toBe(statSync(refLock()).ino);
    // Its process is running: another writer waits for it rather than clear it.
    await expect(openRepo(root, { lockWaitMs: 100 }).advanceRef(VERSIONS_BRANCH, a, null)).rejects.toMatchObject({ code: 'locked' });
    release();
    await moving;
    expect(await setup.resolveRef(VERSIONS_BRANCH)).toBe(a);
    expect(lockFiles()).toEqual([]);
    expect(existsSync(refLock())).toBe(false);
  });

  it('waits for another Git’s lock and moves the branch once it is let go, or gives up and leaves it', async () => {
    const repo = openRepo(root, { lockWaitMs: 2000 });
    await repo.init();
    const a = await snapshot(repo);
    writeFileSync(refLock(), `${'b'.repeat(40)}\n`);
    setTimeout(() => rmSync(refLock()), 100);
    await repo.advanceRef(VERSIONS_BRANCH, a, null);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(a);
    const b = await snapshot(repo, [{ path: 'b', bytes: text('b') }], [a]);
    writeFileSync(refLock(), `${'b'.repeat(40)}\n`);
    await expect(openRepo(root, { lockWaitMs: 100 }).advanceRef(VERSIONS_BRANCH, b, a)).rejects.toMatchObject({ code: 'locked' });
    expect(readFileSync(refLock(), 'utf8')).toBe(`${'b'.repeat(40)}\n`);
    expect(lockFiles()).toEqual([]);
  });

  it('never clears another Git’s branch lock, however old, empty, or holding the same commit, even beside a dead process’s lock file', async () => {
    const repo = openRepo(root, { ...RESTARTED, lockWaitMs: 100 });
    await repo.init();
    const a = await snapshot(repo);
    for (const content of [`${'b'.repeat(40)}\n`, '', `${a}\n`]) {
      // A process of the app's died holding a lock file for this branch, but the lock there now is another file.
      const dead = join(gitdir(), `siteorigin-lock.${HOST}.999999.siteorigin-versions.0123456789ab`);
      writeFileSync(dead, `${a}\n`);
      writeFileSync(refLock(), content);
      const old = Date.now() / 1000 - 86_400;
      utimesSync(refLock(), old, old);
      await expect(repo.advanceRef(VERSIONS_BRANCH, a, null), JSON.stringify(content)).rejects.toMatchObject({ code: 'locked' });
      expect(readFileSync(refLock(), 'utf8')).toBe(content);
      // The dead process's file is cleared, being its; the lock is not.
      expect(existsSync(dead)).toBe(false);
      rmSync(refLock());
    }
  });

  it('clears a branch lock an exited process of the app’s on this computer left, and only such a one', async () => {
    const repo = openRepo(root, { lockWaitMs: 100 });
    await repo.init();
    const a = await snapshot(repo);
    // Exited: cleared, lock and file, and the branch moves.
    const file = appLock(999_999, `${'c'.repeat(40)}\n`);
    await openRepo(root, { ...RESTARTED, lockWaitMs: 100 }).advanceRef(VERSIONS_BRANCH, a, null);
    expect(existsSync(file)).toBe(false);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(a);
    const b = await snapshot(repo, [{ path: 'b', bytes: text('b') }], [a]);
    // Still running (this test's own process), or another computer's: waited for, never cleared.
    for (const [pid, host, options] of [
      [process.pid, HOST, {}],
      [999_999, 'ffffffff', RESTARTED]
    ] as const) {
      const held = appLock(pid, `${'c'.repeat(40)}\n`, host);
      await expect(openRepo(root, { ...options, lockWaitMs: 100 }).advanceRef(VERSIONS_BRANCH, b, a)).rejects.toMatchObject({ code: 'locked' });
      expect(existsSync(held)).toBe(true);
      expect(existsSync(refLock())).toBe(true);
      rmSync(refLock());
      rmSync(held);
    }
  });

  it('reads a branch a stock Git packed, and the loose one when both are there', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    const b = await snapshot(repo, [{ path: 'b', bytes: text('b') }]);
    writeFileSync(join(gitdir(), 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${b} refs/heads/siteorigin-other\n${a} ${VERSIONS_BRANCH}\n^${b}\n`);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(a);
    expect(await repo.resolveRef('refs/heads/siteorigin-other')).toBe(b);
    await expect(repo.advanceRef(VERSIONS_BRANCH, b, null)).rejects.toMatchObject({ code: 'conflict', actual: a });
    await repo.advanceRef(VERSIONS_BRANCH, b, a);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(b);
    writeFileSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions'), 'ref: refs/heads/other\n');
    await expect(repo.resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'corrupt' });
    rmSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions'));
    writeFileSync(join(gitdir(), 'packed-refs'), `zz ${VERSIONS_BRANCH}\n`);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('a write stopped part way', () => {
  it('cancelled between files: nothing written, no branch moved, and the repository writes on', async () => {
    const repo = openRepo(root);
    await repo.init();
    const token = { cancelled: false };
    const files: FileInput[] = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, bytes: text(`file ${i}`) }));
    const written: string[] = [];
    const cancelling = openRepo(root, { fault: (p, path) => void (p === 'file-written' && (written.push(path), (token.cancelled = true))) });
    await expect(cancelling.writeFiles(files, token)).rejects.toMatchObject({ code: 'cancelled' });
    // It stopped at the next file, and kept not even the one written before it, under any name.
    expect(written).toEqual(['f0.txt']);
    expect(objects()).toEqual([]);
    expect(temporaries()).toEqual([]);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).resolves.toBeNull();
    const commit = await snapshot(repo, files);
    await repo.advanceRef(VERSIONS_BRANCH, commit, null);
  });

  it('cancelled before the branch moves: the branch stays and both locks are gone', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    const token = { cancelled: false };
    let lockHeld = '';
    const cancelling = openRepo(root, { fault: (p, path) => void (p === 'lock-written' && ((lockHeld = readFileSync(path, 'utf8')), (token.cancelled = true))) });
    await expect(cancelling.advanceRef(VERSIONS_BRANCH, a, null, token)).rejects.toMatchObject({ code: 'cancelled' });
    expect(lockHeld).toBe(`${a}\n`);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).resolves.toBeNull();
    expect(readdirSync(join(gitdir(), 'refs', 'heads'))).toEqual([]);
    expect(lockFiles()).toEqual([]);
  });

  it('killed while naming its objects: none named, and the next worker clears its temporary ones and writes them whole', async () => {
    await openRepo(root).init();
    const bytes = text('a picture, half written');
    const { fault, at } = crashAt('object-written');
    void openRepo(root, { fault }).writeBlob({ bytes });
    await at;
    // The bytes are in a temporary file, whole and named for this process, which Git itself passes over.
    const fan = join(gitdir(), 'objects', blobOid(bytes).slice(0, 2));
    const tmp = readdirSync(fan);
    expect(tmp).toHaveLength(1);
    expect(tmp[0]).toMatch(new RegExp(`^tmp_obj_${HOST}_${process.pid}_`));
    expect(statSync(join(fan, tmp[0])).size).toBeGreaterThan(0);
    expect(objects()).toEqual([]);
    // Another's recent temporary object is left alone.
    writeFileSync(join(fan, 'tmp_obj_another'), 'theirs');
    const next = openRepo(root, RESTARTED);
    expect(await next.writeBlob({ bytes })).toBe(blobOid(bytes));
    expect(decode(await next.readBlob(blobOid(bytes)))).toBe('a picture, half written');
    expect(readdirSync(fan).sort()).toEqual([blobOid(bytes).slice(2), 'tmp_obj_another']);
  });

  it('killed holding the branch’s lock: the branch is where it was, and the next worker clears both locks and moves it', async () => {
    const setup = openRepo(root);
    await setup.init();
    const a = await snapshot(setup);
    await setup.advanceRef(VERSIONS_BRANCH, a, null);
    const b = await snapshot(setup, [{ path: 'b', bytes: text('b') }], [a]);
    const { fault, at } = crashAt('lock-written');
    void openRepo(root, { fault }).advanceRef(VERSIONS_BRANCH, b, a);
    await at;
    expect(readFileSync(refLock(), 'utf8')).toBe(`${b}\n`);
    expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(a);
    // Still running as far as anyone can tell: a later writer waits for it rather than clear its locks.
    await expect(openRepo(root, { lockWaitMs: 100 }).advanceRef(VERSIONS_BRANCH, b, a)).rejects.toMatchObject({ code: 'locked' });
    const next = openRepo(root, RESTARTED);
    // It moves the branch from where it is, never from where the stopped worker was taking it.
    await expect(next.advanceRef(VERSIONS_BRANCH, b, b)).rejects.toMatchObject({ code: 'conflict', actual: a });
    expect(existsSync(refLock())).toBe(false);
    await next.advanceRef(VERSIONS_BRANCH, b, a);
    expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(b);
  });

  it('killed just after the branch moved: the move stands, and a writer from the old commit cannot overwrite it', async () => {
    const setup = openRepo(root);
    await setup.init();
    const a = await snapshot(setup);
    await setup.advanceRef(VERSIONS_BRANCH, a, null);
    const b = await snapshot(setup, [{ path: 'b', bytes: text('b') }], [a]);
    const c = await snapshot(setup, [{ path: 'c', bytes: text('c') }], [a]);
    const { fault, at } = crashAt('ref-renamed');
    void openRepo(root, { fault }).advanceRef(VERSIONS_BRANCH, b, a);
    await at;
    expect(existsSync(refLock())).toBe(false);
    const next = openRepo(root, RESTARTED);
    expect(await next.resolveRef(VERSIONS_BRANCH)).toBe(b);
    await expect(next.advanceRef(VERSIONS_BRANCH, c, a)).rejects.toMatchObject({ code: 'conflict', actual: b });
    // Its lock file (a second name for the branch now) is cleared; the branch is left as it is.
    expect(lockFiles()).toEqual([]);
    expect(readFileSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions'), 'utf8')).toBe(`${b}\n`);
  });

  it('a write that relies on objects a failed write named makes them its own: on the disk, and given the time now', async () => {
    await openRepo(root).init();
    let named = 0;
    const failing = openRepo(root, {
      fault: (p) => {
        if (p === 'object-written' && named++ === 1) throw new Error('the disk refused');
      }
    });
    await expect(failing.writeFiles([{ path: 'a', bytes: text('a') }, { path: 'b', bytes: text('b') }])).rejects.toMatchObject({ code: 'failed' });
    const left = objects();
    expect(left).toHaveLength(1);
    const path = join(gitdir(), 'objects', left[0].slice(0, 2), left[0].slice(2));
    const old = Date.now() / 1000 - 2 * 86_400;
    utimesSync(path, old, old);
    const started = Date.now();
    await openRepo(root).writeFiles([{ path: 'a', bytes: text('a') }, { path: 'b', bytes: text('b') }]);
    expect(statSync(path).mtimeMs).toBeGreaterThanOrEqual(started - 1000);
    expect(temporaries()).toEqual([]);
  });

  it('cannot rely on an object removed while it saves (a git gc meanwhile): the save fails, to be made again', async () => {
    const repo = openRepo(root);
    await repo.init();
    const bytes = text('reused');
    await repo.writeBlob({ bytes });
    const path = join(gitdir(), 'objects', blobOid(bytes).slice(0, 2), blobOid(bytes).slice(2));
    const gc = openRepo(root, { fault: (p) => (p === 'file-written' ? rmSync(path) : undefined) });
    await expect(gc.writeFiles([{ path: 'x', bytes }])).rejects.toMatchObject({ code: 'changed' });
    expect(await repo.writeBlob({ bytes })).toBe(blobOid(bytes));
    expect(existsSync(path)).toBe(true);
  });

  it('clearing an exited process’s temporary objects touches nothing through a folder linked elsewhere', async () => {
    await openRepo(root).init();
    const outside = mkdtempSync(join(tmpdir(), 'so-git-outside-'));
    writeFileSync(join(outside, `tmp_obj_${HOST}_999999_x`), 'someone else’s');
    symlinkSync(outside, join(gitdir(), 'objects', 'ab'), 'dir');
    await openRepo(root, RESTARTED).writeFiles([]);
    expect(readdirSync(outside)).toEqual([`tmp_obj_${HOST}_999999_x`]);
    rmSync(outside, { recursive: true, force: true });
  });

  it('leaves the project’s own .git exactly as it was through all of it', async () => {
    const before = userGit();
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    await repo.advanceRef(VERSIONS_BRANCH, a, null);
    await repo.listCommits(VERSIONS_BRANCH, 5);
    await expect(repo.writeFiles([{ path: 'x', source: '.git/config' }])).rejects.toMatchObject({ code: 'invalid' });
    expect(userGit()).toEqual(before);
    // Hard links are not followed into anything: a second name for a project file is that file.
    linkSync(join(root, '.git', 'HEAD'), join(root, 'head-copy'));
    await repo.writeFiles([{ path: 'head-copy', source: 'head-copy' }]);
    expect(userGit()).toEqual(before);
  });
});
