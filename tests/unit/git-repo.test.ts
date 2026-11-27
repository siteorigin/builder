/**
 * The versions repository on the bundled Git (#1152): a bare repository at .siteorigin/versions.git that only ever
 * adds whole objects, and moves a branch only under its lock and only from the commit the caller expected. A write that
 * is refused, cancelled or stopped part way (the worker killed) leaves no damaged object and no branch moved, and the
 * repository opens again as it was. The project's own .git is never touched.
 *
 * A crash is a write stopped at a point and never resumed (its promise never settles, so nothing after it runs, not
 * even its clean-up), and the repository opened again by a fresh instance, as a restarted worker would.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo, type RepoOptions } from '../../src/main/git/repo';
import { GitError, VERSIONS_BRANCH, type FileInput, type Identity } from '../../src/main/git/protocol';
import type { FaultPoint } from '../../src/main/git/fs';

const APP: Identity = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };
const PUBLISH = 'refs/heads/siteorigin-publish';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-git-repo-'));
  // The developer's own repository, which nothing here may touch.
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'index.lock'), 'held by the developer');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const gitdir = () => join(root, '.siteorigin', 'versions.git');
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
/** A Git object's name, computed here rather than by the code under test. */
const blobOid = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
/** A promise that never settles: the worker stopped here and never ran another line. */
const crash = () => new Promise<never>(() => undefined);
const crashAt = (point: FaultPoint): RepoOptions['fault'] => (p) => (p === point ? crash() : undefined);
const later = <T>(p: Promise<T>) => Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 100))]);

async function snapshot(repo = openRepo(root), files: FileInput[] = [{ path: 'siteorigin/site.json', bytes: text('{"name":"Site"}\n') }]) {
  const tree = await repo.writeFiles(files);
  return repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'Saved version\n' });
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
    await openRepo(root).init();
    await expect(openRepo(root).readCommit(commit)).resolves.toMatchObject({ oid: commit });
  });

  it('two at once make one repository', async () => {
    await Promise.all([openRepo(root).init(), openRepo(root).init(), openRepo(root).init()]);
    expect(readdirSync(join(root, '.siteorigin'))).toEqual(['versions.git']);
    await expect(openRepo(root).exists()).resolves.toBe(true);
  });

  it('refuses a versions.git that points elsewhere or is a link, and never follows it into the project’s .git', async () => {
    const before = userGit();
    mkdirSync(join(root, '.siteorigin'));
    writeFileSync(join(gitdir()), `gitdir: ${join(root, '.git')}\n`);
    await expect(openRepo(root).init()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(openRepo(root).resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'corrupt' });
    rmSync(gitdir());
    symlinkSync(join(root, '.git'), gitdir(), 'dir');
    await expect(openRepo(root).exists()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(snapshot()).rejects.toMatchObject({ code: 'corrupt' });
    expect(userGit()).toEqual(before);
  });

  it('refuses to write through an object folder that is a link to another repository', async () => {
    await openRepo(root).init();
    const bytes = text('hello');
    const fan = blobOid(bytes).slice(0, 2);
    mkdirSync(join(root, '.git', 'objects', fan), { recursive: true });
    const before = userGit();
    symlinkSync(join(root, '.git', 'objects', fan), join(gitdir(), 'objects', fan), 'dir');
    await expect(openRepo(root).writeBlob({ bytes })).rejects.toMatchObject({ code: 'corrupt' });
    expect(userGit()).toEqual(before);
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
      { path: 'static/café ünïcode.txt', bytes: text('naïve') }
    ];
    const tree = await repo.writeFiles(files);
    expect((await repo.readTree(tree)).map((e) => [e.path, e.type, e.mode])).toEqual([
      ['siteorigin', 'tree', '040000'],
      ['static', 'tree', '040000']
    ]);
    const photoOid = blobOid(photo);
    expect(objects()).toContain(photoOid);
    const commit = await repo.writeCommit({ tree, parents: [], author: APP, committer: { ...APP, timestamp: APP.timestamp + 1, timezoneOffset: -600 }, message: 'Saved version\n' });
    // A fresh repository object is a restarted worker: everything is read back from the disk.
    const again = openRepo(root);
    expect(Buffer.from(await again.readBlob(commit, 'static/assets/photo.jpg')).equals(photo)).toBe(true);
    expect(decode(await again.readBlob(commit, 'siteorigin/pages/home.json'))).toBe('{"title":"Home"}\n');
    expect(decode(await again.readBlob(commit, 'static/café ünïcode.txt'))).toBe('naïve');
    expect(await again.readBlob(commit, 'static/empty.txt')).toHaveLength(0);
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

  it('publishes commits to a branch, lists them newest first, and keeps a second history with its own root', async () => {
    const repo = openRepo(root);
    await repo.init();
    await expect(repo.listCommits(VERSIONS_BRANCH, 10)).resolves.toEqual([]);
    const first = await snapshot(repo);
    await repo.advanceRef(VERSIONS_BRANCH, first, null);
    const tree2 = await repo.writeFiles([{ path: 'siteorigin/site.json', bytes: text('{"name":"Renamed"}\n') }]);
    const second = await repo.writeCommit({ tree: tree2, parents: [first], author: APP, committer: APP, message: 'Second\n' });
    await repo.advanceRef(VERSIONS_BRANCH, second, first);
    const publish = await snapshot(repo, [{ path: 'build/index.html', bytes: text('<h1>Site</h1>') }]);
    await repo.advanceRef(PUBLISH, publish, null);
    const reopened = openRepo(root);
    expect(await reopened.resolveRef(VERSIONS_BRANCH)).toBe(second);
    expect((await reopened.listCommits(VERSIONS_BRANCH, 10)).map((c) => [c.oid, c.parents])).toEqual([
      [second, [first]],
      [first, []]
    ]);
    expect((await reopened.listCommits(VERSIONS_BRANCH, 1)).map((c) => c.oid)).toEqual([second]);
    expect((await reopened.listCommits(PUBLISH, 10)).map((c) => c.oid)).toEqual([publish]);
    expect(readFileSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions'), 'utf8')).toBe(`${second}\n`);
  });

  it('writes nothing new for a file it already holds, and writes the same names for the same content', async () => {
    const repo = openRepo(root);
    await repo.init();
    const files: FileInput[] = [{ path: 'siteorigin/site.json', bytes: text('{}\n') }];
    const a = await repo.writeFiles(files);
    const held = objects();
    expect(await repo.writeFiles(files)).toBe(a);
    expect(objects()).toEqual(held);
  });

  it('refuses commits that name a tree or parent it does not hold, or an identity it cannot write', async () => {
    const repo = openRepo(root);
    await repo.init();
    const tree = await repo.writeFiles([]);
    const missing = 'a'.repeat(40);
    await expect(repo.writeCommit({ tree: missing, parents: [], author: APP, committer: APP, message: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(repo.writeCommit({ tree, parents: [missing], author: APP, committer: APP, message: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(repo.writeCommit({ tree, parents: [], author: { ...APP, email: 'a>b' }, committer: APP, message: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.writeCommit({ tree, parents: [], author: { ...APP, timestamp: 1.5 }, committer: APP, message: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.writeCommit({ tree: 'HEAD', parents: [], author: APP, committer: APP, message: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.advanceRef(VERSIONS_BRANCH, tree, null)).rejects.toMatchObject({ code: 'not-found' });
    await expect(repo.advanceRef('refs/heads/main', await snapshot(repo), null)).rejects.toMatchObject({ code: 'invalid' });
    await expect(repo.resolveRef('HEAD')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('refusing what a version cannot hold, before writing anything', () => {
  it.each<[string, FileInput[], string]>([
    ['a parent folder', [{ path: '../outside.txt', bytes: text('x') }], 'invalid'],
    ['an absolute path', [{ path: '/etc/passwd', bytes: text('x') }], 'invalid'],
    ['a .git folder', [{ path: 'static/.git/config', bytes: text('x') }], 'invalid'],
    ['a .GIT spelling', [{ path: '.GIT ', bytes: text('x') }], 'invalid'],
    ['a backslash', [{ path: 'static\\a.txt', bytes: text('x') }], 'invalid'],
    ['a NUL', [{ path: 'a\0b', bytes: text('x') }], 'invalid'],
    ['an empty part', [{ path: 'static//a.txt', bytes: text('x') }], 'invalid'],
    ['the same file twice', [{ path: 'a.txt', bytes: text('x') }, { path: 'a.txt', bytes: text('y') }], 'invalid'],
    ['two spellings a Mac would make one file', [{ path: 'static/Logo.png', bytes: text('x') }, { path: 'static/logo.png', bytes: text('y') }], 'invalid'],
    ['two Unicode spellings of one name', [{ path: 'café.txt', bytes: text('x') }, { path: 'café.txt', bytes: text('y') }], 'invalid'],
    ['a file where a folder is', [{ path: 'static', bytes: text('x') }, { path: 'static/a.txt', bytes: text('y') }], 'invalid'],
    ['a folder where a file is', [{ path: 'static/a.txt', bytes: text('y') }, { path: 'Static', bytes: text('x') }], 'invalid'],
    ['a file outside the project', [{ path: 'x', source: '../x' }], 'invalid'],
    ['a missing file', [{ path: 'x', source: 'static/missing.png' }], 'not-found'],
    ['a file over the limit', [{ path: 'big.bin', bytes: new Uint8Array(2049) }], 'too-large'],
    ['files over the limit together', [{ path: 'a.bin', bytes: new Uint8Array(1500) }, { path: 'b.bin', bytes: new Uint8Array(1500) }, { path: 'c.bin', bytes: new Uint8Array(1500) }], 'too-large'],
    ['too many files', Array.from({ length: 6 }, (_, i) => ({ path: `f${i}`, bytes: text('x') })), 'too-large'],
    ['too long a path', [{ path: 'x'.repeat(200), bytes: text('x') }], 'too-large'],
    ['too deep a path', [{ path: Array.from({ length: 9 }, () => 'd').join('/'), bytes: text('x') }], 'too-large']
  ])('%s', async (_what, files, code) => {
    const repo = openRepo(root, { limits: { maxBlobBytes: 2048, maxTotalBytes: 4000, maxEntries: 5, maxPathBytes: 100, maxDepth: 8 } });
    await repo.init();
    // A good file first: it is not written either.
    const held = objects();
    await expect(repo.writeFiles([{ path: 'first.txt', bytes: text('written first?') }, ...files])).rejects.toMatchObject({ code });
    expect(objects()).toEqual(held);
  });

  it('refuses a picture larger than the limit, read from the disk, by its size alone', async () => {
    const repo = openRepo(root, { limits: { maxBlobBytes: 1024 } });
    await repo.init();
    mkdirSync(join(root, 'static'));
    writeFileSync(join(root, 'static', 'huge.mp4'), new Uint8Array(4096));
    const held = objects();
    await expect(repo.writeFiles([{ path: 'static/huge.mp4', source: 'static/huge.mp4' }])).rejects.toMatchObject({ code: 'too-large' });
    await expect(repo.writeBlob({ source: 'static/huge.mp4' })).rejects.toMatchObject({ code: 'too-large' });
    expect(objects()).toEqual(held);
  });

  it('refuses a picture that is a link, and one that changes while the version is saved', async () => {
    mkdirSync(join(root, 'static'));
    writeFileSync(join(root, 'static', 'a.png'), 'first');
    symlinkSync(join(root, '.git', 'HEAD'), join(root, 'static', 'linked.png'));
    const changing = openRepo(root, { fault: (p) => (p === 'files-checked' ? writeFileSync(join(root, 'static', 'a.png'), 'second, longer') : undefined) });
    await changing.init();
    await expect(changing.writeFiles([{ path: 'static/linked.png', source: 'static/linked.png' }])).rejects.toMatchObject({ code: 'invalid' });
    const held = objects();
    await expect(changing.writeFiles([{ path: 'static/a.png', source: 'static/a.png' }])).rejects.toMatchObject({ code: 'changed' });
    expect(objects()).toEqual(held);
  });
});

describe('moving a branch', () => {
  it('moves a branch only from the commit expected, and says where it is when it is not there', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    const b = await snapshot(repo, [{ path: 'b.txt', bytes: text('b') }]);
    await repo.advanceRef(VERSIONS_BRANCH, a, null);
    const refused = await repo.advanceRef(VERSIONS_BRANCH, b, null).catch((e: GitError) => e);
    expect(refused).toBeInstanceOf(GitError);
    expect(refused).toMatchObject({ code: 'conflict', actual: a });
    await expect(repo.advanceRef(VERSIONS_BRANCH, b, b)).rejects.toMatchObject({ code: 'conflict', actual: a });
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(a);
    expect(existsSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions.lock'))).toBe(false);
  });

  it('lets exactly one of two writers from the same commit win, in one repository or two', async () => {
    const one = openRepo(root);
    await one.init();
    const base = await snapshot(one);
    await one.advanceRef(VERSIONS_BRANCH, base, null);
    const x = await snapshot(one, [{ path: 'x', bytes: text('x') }]);
    const y = await snapshot(one, [{ path: 'y', bytes: text('y') }]);
    // Two workers on one repository: neither waits for the other in memory, only on the disk's lock.
    const results = await Promise.allSettled([one.advanceRef(VERSIONS_BRANCH, x, base), openRepo(root).advanceRef(VERSIONS_BRANCH, y, base)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? x : y;
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: 'conflict', actual: winner });
    expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(winner);
  });

  it('waits for a live writer’s lock and then gives up, leaving its lock and the branch alone', async () => {
    const repo = openRepo(root, { lockWaitMs: 150, startedAt: Date.now() - 60_000 });
    await repo.init();
    const a = await snapshot(repo);
    // Taken after this worker started: a writer that is still running.
    const lock = join(gitdir(), 'refs', 'heads', 'siteorigin-versions.lock');
    writeFileSync(lock, `${'b'.repeat(40)}\n`);
    await expect(repo.advanceRef(VERSIONS_BRANCH, a, null)).rejects.toMatchObject({ code: 'locked' });
    expect(readFileSync(lock, 'utf8')).toBe(`${'b'.repeat(40)}\n`);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).resolves.toBeNull();
  });

  it('clears a lock left by a worker that stopped, once it is older than this worker, and only then', async () => {
    const setup = openRepo(root);
    await setup.init();
    const a = await snapshot(setup);
    const lock = join(gitdir(), 'refs', 'heads', 'siteorigin-versions.lock');
    writeFileSync(lock, `${'b'.repeat(40)}\n`);
    const madeAt = Date.now() / 1000 - 30;
    utimesSync(lock, madeAt, madeAt);
    // A worker started before the lock was taken cannot tell it from a live writer's.
    await expect(openRepo(root, { lockWaitMs: 100, startedAt: madeAt * 1000 - 1000 }).advanceRef(VERSIONS_BRANCH, a, null)).rejects.toMatchObject({ code: 'locked' });
    // One started after it knows its writer has exited.
    await openRepo(root, { lockWaitMs: 100, startedAt: Date.now() }).advanceRef(VERSIONS_BRANCH, a, null);
    expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(a);
    expect(existsSync(lock)).toBe(false);
  });

  it('reads a branch a stock Git packed, and the loose one when both are there', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    const b = await snapshot(repo, [{ path: 'b', bytes: text('b') }]);
    writeFileSync(join(gitdir(), 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${a} ${VERSIONS_BRANCH}\n`);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(a);
    await expect(repo.advanceRef(VERSIONS_BRANCH, b, null)).rejects.toMatchObject({ code: 'conflict', actual: a });
    await repo.advanceRef(VERSIONS_BRANCH, b, a);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(b);
    writeFileSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions'), 'ref: refs/heads/other\n');
    await expect(repo.resolveRef(VERSIONS_BRANCH)).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('a write stopped part way', () => {
  it('cancelled between files: no tree, no branch moved, and the repository writes on', async () => {
    const repo = openRepo(root);
    await repo.init();
    const token = { cancelled: false };
    const files: FileInput[] = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, bytes: text(`file ${i}`) }));
    const cancelling = openRepo(root, { fault: (p) => void (p === 'object-written' && (token.cancelled = true)) });
    await expect(cancelling.writeFiles(files, token)).rejects.toMatchObject({ code: 'cancelled' });
    // Only whole blobs of the files before the cancel are left, and nothing points at them.
    expect(objects()).toEqual([blobOid(text('file 0'))]);
    await expect(repo.resolveRef(VERSIONS_BRANCH)).resolves.toBeNull();
    const commit = await snapshot(repo, files);
    await repo.advanceRef(VERSIONS_BRANCH, commit, null);
  });

  it('cancelled before the branch moves: the branch stays and its lock is gone', async () => {
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    const token = { cancelled: false };
    const cancelling = openRepo(root, { fault: (p) => void (p === 'lock-written' && (token.cancelled = true)) });
    await expect(cancelling.advanceRef(VERSIONS_BRANCH, a, null, token)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(repo.resolveRef(VERSIONS_BRANCH)).resolves.toBeNull();
    expect(readdirSync(join(gitdir(), 'refs', 'heads'))).toEqual([]);
  });

  it('killed while writing an object: no object under its name, and the next worker writes it whole', async () => {
    await openRepo(root).init();
    const bytes = text('a picture, half written');
    const dying = openRepo(root, { fault: crashAt('object-written') });
    expect(await later(dying.writeBlob({ bytes }))).toBe('pending');
    // The bytes are in a temporary file Git itself passes over; no object has the name.
    const fan = join(gitdir(), 'objects', blobOid(bytes).slice(0, 2));
    expect(readdirSync(fan).every((f) => f.startsWith('tmp_obj_'))).toBe(true);
    expect(objects()).toEqual([]);
    const next = openRepo(root);
    expect(await next.writeBlob({ bytes })).toBe(blobOid(bytes));
    expect(decode(await next.readBlob(blobOid(bytes)))).toBe('a picture, half written');
  });

  it('killed holding the branch’s lock: the branch is where it was, and a later worker clears the lock and moves it', async () => {
    const setup = openRepo(root);
    await setup.init();
    const a = await snapshot(setup);
    await setup.advanceRef(VERSIONS_BRANCH, a, null);
    const b = await snapshot(setup, [{ path: 'b', bytes: text('b') }]);
    const dying = openRepo(root, { fault: crashAt('lock-written') });
    expect(await later(dying.advanceRef(VERSIONS_BRANCH, b, a))).toBe('pending');
    expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(a);
    const next = openRepo(root, { startedAt: Date.now() + 1, lockMinAgeMs: 0, lockWaitMs: 100 });
    // It moves the branch from where it is, never from where the stopped worker was taking it.
    await expect(next.advanceRef(VERSIONS_BRANCH, b, b)).rejects.toMatchObject({ code: 'conflict', actual: a });
    await next.advanceRef(VERSIONS_BRANCH, b, a);
    expect(await openRepo(root).resolveRef(VERSIONS_BRANCH)).toBe(b);
  });

  it('killed just after the branch moved: the move stands, and a writer from the old commit cannot overwrite it', async () => {
    const setup = openRepo(root);
    await setup.init();
    const a = await snapshot(setup);
    await setup.advanceRef(VERSIONS_BRANCH, a, null);
    const b = await snapshot(setup, [{ path: 'b', bytes: text('b') }]);
    const c = await snapshot(setup, [{ path: 'c', bytes: text('c') }]);
    const dying = openRepo(root, { fault: crashAt('ref-renamed') });
    expect(await later(dying.advanceRef(VERSIONS_BRANCH, b, a))).toBe('pending');
    const next = openRepo(root, { startedAt: Date.now() + 1, lockMinAgeMs: 0 });
    expect(await next.resolveRef(VERSIONS_BRANCH)).toBe(b);
    await expect(next.advanceRef(VERSIONS_BRANCH, c, a)).rejects.toMatchObject({ code: 'conflict', actual: b });
    expect(existsSync(join(gitdir(), 'refs', 'heads', 'siteorigin-versions.lock'))).toBe(false);
  });

  it('leaves the project’s own .git exactly as it was through all of it', async () => {
    const before = userGit();
    const repo = openRepo(root);
    await repo.init();
    const a = await snapshot(repo);
    await repo.advanceRef(VERSIONS_BRANCH, a, null);
    await repo.listCommits(VERSIONS_BRANCH, 5);
    expect(userGit()).toEqual(before);
  });
});
