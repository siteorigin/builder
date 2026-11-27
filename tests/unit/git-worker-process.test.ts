/**
 * The Git worker as a real process (#1152): what one worker wrote, the next reads after it has exited; and a worker
 * killed at each point of a write (an object half on disk, the branch's lock taken, the branch just moved) leaves every
 * object whole, the branch either where it was or where it was moved, and the next worker able to go on. Every object
 * is checked against its name here, by hashing it again, not by asking the code under test.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitClient, type GitClient, type GitWorkerHandle } from '../../src/main/git/client';
import { HOST } from '../../src/main/git/fs';
import { VERSIONS_BRANCH, type GitReply, type Identity } from '../../src/main/git/protocol';

const BUNDLED = (JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> }).dependencies['isomorphic-git'];

const FIXTURE = resolve('tests/unit/fixtures/git-node-worker.ts');
const APP: Identity = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };

let root: string;
let children: ChildProcess[] = [];
let client: GitClient | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'so-git-process-'));
});
afterEach(() => {
  client?.stop();
  for (const c of children) c.kill('SIGKILL');
  children = [];
  rmSync(root, { recursive: true, force: true });
});

/**
 * Workers in Node processes, each started with the environment `next.env` holds when it starts. `stopped` resolves
 * with the worker that reached its stopping point.
 */
function nodeWorkers() {
  const next: { env: Record<string, string> } = { env: {} };
  let reached: (r: { child: ChildProcess; path: string }) => void = () => undefined;
  const spawn = (): GitWorkerHandle => {
    const child = fork(FIXTURE, [], {
      execArgv: ['--import', 'tsx'],
      serialization: 'advanced',
      env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.node.json', ...next.env },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    children.push(child);
    return {
      postMessage: (m) => void child.send(m),
      on: (event: string, listener: (x?: unknown) => void) => {
        if (event === 'message')
          child.on('message', (m: GitReply | { stoppedAt: string; path: string } | { ready: true }) => {
            if ('stoppedAt' in m) reached({ child, path: m.path });
            else if (!('ready' in m)) listener(m);
          });
        else if (event === 'exit') child.on('exit', (code) => listener(code ?? 1));
        else child.on(event, () => listener());
        return undefined;
      },
      kill: () => child.kill('SIGKILL')
    } as GitWorkerHandle;
  };
  const stopped = () => new Promise<{ child: ChildProcess; path: string }>((r) => (reached = r));
  return { spawn, next, stopped };
}

const listObjects = (gitdir: string) =>
  readdirSync(join(gitdir, 'objects'))
    .filter((d) => /^[0-9a-f]{2}$/.test(d))
    .flatMap((d) => readdirSync(join(gitdir, 'objects', d)).filter((f) => /^[0-9a-f]{38}$/.test(f)).map((f) => d + f));
const blobOid = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');

/** Every loose object, inflated and hashed again: its name must be the SHA-1 of what it holds. */
function checkObjects(gitdir: string): number {
  let n = 0;
  for (const fan of readdirSync(join(gitdir, 'objects')).filter((d) => /^[0-9a-f]{2}$/.test(d)))
    for (const f of readdirSync(join(gitdir, 'objects', fan)).filter((x) => /^[0-9a-f]{38}$/.test(x))) {
      const raw = inflateSync(readFileSync(join(gitdir, 'objects', fan, f)));
      expect(createHash('sha1').update(raw).digest('hex'), `${fan}${f}`).toBe(fan + f);
      n++;
    }
  return n;
}

const text = (s: string) => new TextEncoder().encode(s);

describe('the Git worker in a process of its own', { timeout: 60_000 }, () => {
  it('reads what a worker that has exited wrote', async () => {
    const { spawn } = nodeWorkers();
    client = createGitClient(spawn, { idleMs: 10 });
    const repo = client.repository(root);
    await repo.init();
    const tree = await repo.writeFiles([{ path: 'siteorigin/site.json', bytes: text('{"name":"Site"}\n') }]);
    const commit = await repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'First\n' });
    await repo.advanceRef(VERSIONS_BRANCH, commit, null);
    await expect.poll(() => children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(commit);
    expect(new TextDecoder().decode(await repo.readBlob(commit, 'siteorigin/site.json'))).toBe('{"name":"Site"}\n');
    expect(children).toHaveLength(2);
    await expect(client.version()).resolves.toBe(BUNDLED);
  });

  it.each(['object-written', 'lock-written', 'ref-renamed'] as const)('killed at %s: every object whole, the branch moved or not, and the next worker goes on', async (point) => {
    const { spawn, next, stopped } = nodeWorkers();
    client = createGitClient(spawn);
    const repo = client.repository(root);
    await repo.init();
    const tree = await repo.writeFiles([{ path: 'a.txt', bytes: text('a') }]);
    const a = await repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'A\n' });
    await repo.advanceRef(VERSIONS_BRANCH, a, null);
    const treeB = await repo.writeFiles([{ path: 'b.txt', bytes: text('b') }]);
    const b = await repo.writeCommit({ tree: treeB, parents: [a], author: APP, committer: APP, message: 'B\n' });
    // The worker in use is ended; the next starts with the stopping point, and the one after without it.
    client.stop();
    client = createGitClient(spawn);
    const dying = client.repository(root);
    const gitdir = join(root, '.siteorigin', 'versions.git');
    const before = new Set(listObjects(gitdir));
    next.env = { GIT_TEST_STOP_AT: point };
    const unsaved = text('c, never committed');
    const write = point === 'object-written' ? dying.writeFiles([{ path: 'c.txt', bytes: unsaved }]) : dying.advanceRef(VERSIONS_BRANCH, b, a);
    write.catch(() => undefined);
    const victim = await stopped();
    // What is on the disk at the moment it is killed.
    const lock = join(gitdir, 'refs', 'heads', 'siteorigin-versions.lock');
    if (point === 'object-written') {
      expect(victim.path).toBe(join(gitdir, 'objects', blobOid(unsaved).slice(0, 2), blobOid(unsaved).slice(2)));
      expect(existsSync(victim.path)).toBe(false);
      expect(readdirSync(dirname(victim.path)).some((f) => f.startsWith(`tmp_obj_${HOST}_${victim.child.pid}_`))).toBe(true);
    } else if (point === 'lock-written') {
      expect(readFileSync(lock, 'utf8')).toBe(`${b}\n`);
      expect(readFileSync(join(gitdir, 'refs', 'heads', 'siteorigin-versions'), 'utf8')).toBe(`${a}\n`);
      // The lock is a second name for the killed process's own lock file.
      const file = readdirSync(gitdir).find((n) => n.startsWith(`siteorigin-lock.${HOST}.${victim.child.pid}.siteorigin-versions.`));
      expect(file && statSync(join(gitdir, file)).ino).toBe(statSync(lock).ino);
    } else {
      expect(existsSync(lock)).toBe(false);
      expect(readFileSync(join(gitdir, 'refs', 'heads', 'siteorigin-versions'), 'utf8')).toBe(`${b}\n`);
    }
    next.env = {};
    victim.child.kill('SIGKILL');
    await expect(write).rejects.toMatchObject({ code: point === 'object-written' ? 'crashed' : 'outcome-unknown' });
    checkObjects(gitdir);
    expect(new Set(listObjects(gitdir))).toEqual(before);
    const tip = await dying.resolveRef(VERSIONS_BRANCH);
    expect(tip).toBe(point === 'ref-renamed' ? b : a);
    // The next worker never moves the branch from where the killed one was taking it, only from where it is.
    const other = tip === a ? b : a;
    await expect(dying.advanceRef(VERSIONS_BRANCH, other, other)).rejects.toMatchObject({ code: 'conflict', actual: tip });
    const treeC = await dying.writeFiles([{ path: 'c.txt', bytes: text('c') }]);
    const c = await dying.writeCommit({ tree: treeC, parents: [tip!], author: APP, committer: APP, message: 'C\n' });
    await dying.advanceRef(VERSIONS_BRANCH, c, tip);
    expect(await dying.resolveRef(VERSIONS_BRANCH)).toBe(c);
    expect(readdirSync(join(gitdir, 'refs', 'heads'))).toEqual(['siteorigin-versions']);
    // The killed worker's lock files and temporary objects are gone.
    expect(readdirSync(gitdir).filter((n) => n.startsWith('siteorigin-lock.'))).toEqual([]);
    expect(readdirSync(join(gitdir, 'objects'), { recursive: true }).map(String).filter((f) => f.includes(`tmp_obj_${HOST}_${victim.child.pid}_`))).toEqual([]);
    checkObjects(gitdir);
  });
});
