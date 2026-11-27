/**
 * The Git worker as a real process (#1152): what one worker wrote, the next reads after it has exited; and a worker
 * killed at each point of a write (an object half on disk, the branch's lock taken, the branch just moved) leaves every
 * object whole, the branch either where it was or where it was moved, and the next worker able to go on. Every object
 * is checked against its name here, by hashing it again, not by asking the code under test.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitClient, type GitClient, type GitWorkerHandle } from '../../src/main/git/client';
import { VERSIONS_BRANCH, type GitReply, type Identity } from '../../src/main/git/protocol';

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
  let reached: (c: ChildProcess) => void = () => undefined;
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
          child.on('message', (m: GitReply | { stoppedAt: string } | { ready: true }) => {
            if ('stoppedAt' in m) reached(child);
            else if (!('ready' in m)) listener(m);
          });
        else if (event === 'exit') child.on('exit', (code) => listener(code ?? 1));
        else child.on(event, () => listener());
        return undefined;
      },
      kill: () => child.kill('SIGKILL')
    } as GitWorkerHandle;
  };
  const stopped = () => new Promise<ChildProcess>((r) => (reached = r));
  return { spawn, next, stopped };
}

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
    await expect(client.version()).resolves.toMatch(/^1\.\d+\.\d+$/);
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
    next.env = { GIT_TEST_STOP_AT: point, GIT_TEST_LOCK_MIN_AGE_MS: '0' };
    const write = point === 'object-written' ? dying.writeFiles([{ path: 'c.txt', bytes: text('c') }]) : dying.advanceRef(VERSIONS_BRANCH, b, a);
    write.catch(() => undefined);
    const victim = await stopped();
    next.env = { GIT_TEST_LOCK_MIN_AGE_MS: '0' };
    victim.kill('SIGKILL');
    await expect(write).rejects.toMatchObject({ code: point === 'object-written' ? 'crashed' : 'outcome-unknown' });
    const gitdir = join(root, '.siteorigin', 'versions.git');
    expect(checkObjects(gitdir)).toBeGreaterThan(0);
    const tip = await dying.resolveRef(VERSIONS_BRANCH);
    expect(tip).toBe(point === 'ref-renamed' ? b : a);
    if (point === 'lock-written') expect(existsSync(join(gitdir, 'refs', 'heads', 'siteorigin-versions.lock'))).toBe(true);
    // The next worker never moves the branch from where the killed one was taking it, only from where it is.
    const other = tip === a ? b : a;
    await expect(dying.advanceRef(VERSIONS_BRANCH, other, other)).rejects.toMatchObject({ code: 'conflict', actual: tip });
    const treeC = await dying.writeFiles([{ path: 'c.txt', bytes: text('c') }]);
    const c = await dying.writeCommit({ tree: treeC, parents: [tip!], author: APP, committer: APP, message: 'C\n' });
    await dying.advanceRef(VERSIONS_BRANCH, c, tip);
    expect(await dying.resolveRef(VERSIONS_BRANCH)).toBe(c);
    expect(readdirSync(join(gitdir, 'refs', 'heads'))).toEqual(['siteorigin-versions']);
    checkObjects(gitdir);
  });
});
