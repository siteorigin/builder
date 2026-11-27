/**
 * The versions repository is plain Git (#1152): what the bundled Git writes, a stock Git checks with `fsck --strict`
 * and checks out byte for byte; what a stock Git writes or repacks, the bundled Git reads; and the lock the bundled Git
 * takes on a branch is the one a stock Git honours. Stock Git is only the judge here: the app never runs it.
 *
 * Skipped where no Git is installed, except on CI, where it must be there.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../../src/main/git/repo';
import { detectSystemGit } from '../../src/main/git/system-git';
import { VERSIONS_BRANCH, type FileInput, type Identity } from '../../src/main/git/protocol';

// Found the way the app finds one, so on a Mac without Apple's tools the stand-in that offers to install them never runs.
const found = await detectSystemGit();
const GIT = found.status === 'present' ? found.path : null;
const APP: Identity = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: -60 };

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-git-interop-'));
  home = mkdtempSync(join(tmpdir(), 'so-git-home-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Stock Git with none of this computer's settings, and an identity of its own for what it commits. */
function git(args: string[], opts: { cwd?: string; allowFail?: boolean; input?: string } = {}) {
  if (!GIT) throw new Error('No stock Git to check the repository with: CI must have one.');
  const r = spawnSync(GIT, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    input: opts.input,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Stock Git',
      GIT_AUTHOR_EMAIL: 'stock@example.invalid',
      GIT_COMMITTER_NAME: 'Stock Git',
      GIT_COMMITTER_EMAIL: 'stock@example.invalid',
      GIT_AUTHOR_DATE: '1790000500 +0000',
      GIT_COMMITTER_DATE: '1790000500 +0000'
    }
  });
  if (!opts.allowFail && r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
}
const gitdir = () => join(root, '.siteorigin', 'versions.git');
const text = (s: string) => new TextEncoder().encode(s);
const photo = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 104729) % 256));
/** Bytes that do not compress, as a camera's or a video's: the bundled Git stores them uncompressed. */
const video = randomBytes(300_000);
const MEDIA: Record<string, Buffer> = { 'static/assets/photo.jpg': photo, 'static/assets/video.mp4': video };

const FILES: FileInput[] = [
  { path: 'siteorigin/site.json', bytes: text('{"name":"Site"}\n') },
  { path: 'siteorigin/pages/home.json', bytes: text('{"title":"Home"}\n') },
  { path: 'siteorigin/pages/about-us.json', bytes: text('{"title":"About"}\n') },
  { path: 'siteorigin/pages-list.json', bytes: text('[]\n') },
  { path: 'static/assets/photo.jpg', source: 'static/assets/photo.jpg' },
  { path: 'static/assets/video.mp4', source: 'static/assets/video.mp4' },
  { path: 'static/empty.txt', bytes: new Uint8Array(0) },
  { path: 'static/café.txt', bytes: text('naïve') }
];

async function save(files = FILES) {
  mkdirSync(join(root, 'static', 'assets'), { recursive: true });
  for (const [path, bytes] of Object.entries(MEDIA)) writeFileSync(join(root, path), bytes);
  const repo = openRepo(root);
  await repo.init();
  const tree = await repo.writeFiles(files);
  const first = await repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'Saved version\n\nThe first one.\n' });
  await repo.advanceRef(VERSIONS_BRANCH, first, null);
  return { repo, first };
}

/** Every file under a folder, by its path, with its bytes. */
const files = (dir: string, skip = '.git') =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split('\\').join('/'))
    .filter((p) => !p.split('/').includes(skip))
    .sort()
    .map((p) => [p, readFileSync(join(dir, p)).toString('base64')]);

describe.skipIf(!GIT && !process.env.CI)('the versions repository read by stock Git', () => {
  it('passes git fsck --strict, and checks out every file byte for byte', async () => {
    const { repo, first } = await save();
    const tree2 = await repo.writeFiles([...FILES.filter((f) => f.path !== 'static/empty.txt'), { path: 'static/new.txt', bytes: text('new') }]);
    const second = await repo.writeCommit({ tree: tree2, parents: [first], author: APP, committer: APP, message: 'Second\n' });
    await repo.advanceRef(VERSIONS_BRANCH, second, first);
    // Some whole objects nothing points at, as a cancelled save leaves: dangling, not damage.
    await repo.writeFiles([{ path: 'unused.txt', bytes: text('never committed') }]);
    const fsck = git(['--git-dir', gitdir(), 'fsck', '--strict', '--full', '--no-progress']);
    expect(fsck.stderr).not.toMatch(/error|warning|bad sha1|missing|broken/i);
    expect(git(['--git-dir', gitdir(), 'rev-parse', 'refs/heads/siteorigin-versions']).stdout.trim()).toBe(second);
    expect(git(['--git-dir', gitdir(), 'log', '--format=%H %an <%ae> %at %ai|%s', 'siteorigin-versions']).stdout.trim().split('\n')).toEqual([
      `${second} SiteOrigin Builder <versions@siteorigin.invalid> 1790000000 2026-09-21 15:13:20 +0100|Second`,
      `${first} SiteOrigin Builder <versions@siteorigin.invalid> 1790000000 2026-09-21 15:13:20 +0100|Saved version`
    ]);
    const out = join(root, 'checkout');
    git(['clone', '--no-local', '--branch', 'siteorigin-versions', gitdir(), out]);
    mkdirSync(join(root, 'expected', 'static', 'assets'), { recursive: true });
    const expected = join(root, 'expected');
    for (const f of [...FILES.filter((f) => f.path !== 'static/empty.txt'), { path: 'static/new.txt', bytes: text('new') }]) {
      mkdirSync(join(expected, f.path, '..'), { recursive: true });
      writeFileSync(join(expected, f.path), 'bytes' in f ? f.bytes : 'source' in f ? MEDIA[f.source] : '');
    }
    expect(files(out)).toEqual(files(expected));
    git(['checkout', '--quiet', first], { cwd: out });
    expect(readFileSync(join(out, 'static', 'empty.txt'))).toHaveLength(0);
  });

  it('passes fsck with the temporary object a killed write leaves behind', async () => {
    await save();
    const dying = openRepo(root, { fault: (p) => (p === 'object-written' ? new Promise<never>(() => undefined) : undefined) });
    void dying.writeBlob({ bytes: text('half written') });
    await expect.poll(() => readdirSync(join(gitdir(), 'objects'), { recursive: true }).some((f) => String(f).includes('tmp_obj_'))).toBe(true);
    const fsck = git(['--git-dir', gitdir(), 'fsck', '--strict', '--full', '--no-progress']);
    expect(fsck.stderr).not.toMatch(/error|warning|bad sha1|garbage/i);
  });

  it('reads a commit stock Git made, and its objects once stock Git has packed them and its branches', async () => {
    const { repo, first } = await save();
    // Stock Git adds a commit on top of the bundled one's.
    const blob = git(['--git-dir', gitdir(), 'hash-object', '-w', '--stdin'], { input: 'written by stock Git\n' }).stdout.trim();
    expect(blob).toMatch(/^[0-9a-f]{40}$/);
    const tree = git(['--git-dir', gitdir(), 'mktree'], { input: `100644 blob ${blob}\tstock.txt\n` }).stdout.trim();
    const stock = git(['--git-dir', gitdir(), 'commit-tree', tree, '-p', first, '-m', 'By stock Git']).stdout.trim();
    git(['--git-dir', gitdir(), 'update-ref', 'refs/heads/siteorigin-versions', stock, first]);
    git(['--git-dir', gitdir(), 'gc', '--quiet', '--prune=now']);
    git(['--git-dir', gitdir(), 'pack-refs', '--all', '--prune']);
    expect(readdirSync(join(gitdir(), 'refs', 'heads'))).toEqual([]);
    // Every object is in a pack now, none loose.
    expect(readdirSync(join(gitdir(), 'objects', 'pack')).filter((f) => f.endsWith('.pack'))).toHaveLength(1);
    expect(existsSync(join(gitdir(), 'objects', first.slice(0, 2), first.slice(2)))).toBe(false);
    const fresh = openRepo(root);
    expect(await fresh.resolveRef(VERSIONS_BRANCH)).toBe(stock);
    expect(await fresh.readCommit(stock)).toMatchObject({ parents: [first], message: 'By stock Git\n', author: { name: 'Stock Git', email: 'stock@example.invalid', timestamp: 1790000500 } });
    expect(new TextDecoder().decode(await fresh.readBlob(stock, 'stock.txt'))).toBe('written by stock Git\n');
    expect(Buffer.from(await fresh.readBlob(first, 'static/assets/photo.jpg')).equals(photo)).toBe(true);
    expect(Buffer.from(await fresh.readBlob(first, 'static/assets/video.mp4')).equals(video)).toBe(true);
    expect((await fresh.listCommits(VERSIONS_BRANCH, 10)).map((c) => c.oid)).toEqual([stock, first]);
    // The bundled Git moves the packed branch; the loose branch it writes is the one stock Git reads.
    const tree2 = await repo.writeFiles([{ path: 'after.txt', bytes: text('after') }]);
    const after = await repo.writeCommit({ tree: tree2, parents: [stock], author: APP, committer: APP, message: 'After\n' });
    await expect(fresh.advanceRef(VERSIONS_BRANCH, after, first)).rejects.toMatchObject({ code: 'conflict', actual: stock });
    await fresh.advanceRef(VERSIONS_BRANCH, after, stock);
    expect(git(['--git-dir', gitdir(), 'rev-parse', 'refs/heads/siteorigin-versions']).stdout.trim()).toBe(after);
    git(['--git-dir', gitdir(), 'fsck', '--strict', '--no-progress']);
  });

  it('holds the same lock stock Git does: neither moves the branch while the other holds it', async () => {
    const { repo, first } = await save();
    const tree2 = await repo.writeFiles([{ path: 'b.txt', bytes: text('b') }]);
    const second = await repo.writeCommit({ tree: tree2, parents: [first], author: APP, committer: APP, message: 'B\n' });
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((r) => (held = r));
    const slow = openRepo(root, { fault: (p) => (p === 'lock-written' ? (held(), new Promise<void>((r) => (release = r))) : undefined) });
    const moving = slow.advanceRef(VERSIONS_BRANCH, second, first);
    await holding;
    const refused = git(['--git-dir', gitdir(), 'update-ref', 'refs/heads/siteorigin-versions', second, first], { allowFail: true });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/lock/i);
    release();
    await moving;
    expect(git(['--git-dir', gitdir(), 'rev-parse', 'refs/heads/siteorigin-versions']).stdout.trim()).toBe(second);
    // And the other way round: a lock stock Git holds (left here as it leaves one mid-update) is honoured, and once
    // it is let go the branch moves.
    const third = await repo.writeCommit({ tree: tree2, parents: [second], author: APP, committer: APP, message: 'C\n' });
    const lock = join(gitdir(), 'refs', 'heads', 'siteorigin-versions.lock');
    writeFileSync(lock, `${first}\n`);
    await expect(openRepo(root, { lockWaitMs: 50 }).advanceRef(VERSIONS_BRANCH, third, second)).rejects.toMatchObject({ code: 'locked' });
    expect(git(['--git-dir', gitdir(), 'rev-parse', 'refs/heads/siteorigin-versions']).stdout.trim()).toBe(second);
    rmSync(lock);
    await openRepo(root).advanceRef(VERSIONS_BRANCH, third, second);
    expect(git(['--git-dir', gitdir(), 'rev-parse', 'refs/heads/siteorigin-versions']).stdout.trim()).toBe(third);
  });
});
