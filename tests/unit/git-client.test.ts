/**
 * The main process's side of the Git worker (#1152): one worker, one request at a time and in order, a bounded queue,
 * cancellation and timeouts that end a worker that will not stop, and a worker that goes down replaced only once it
 * has exited. A request lost while it was moving a branch says so (`outcome-unknown`) rather than claiming either way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitClient, type GitWorkerHandle } from '../../src/main/git/client';
import { createGitService } from '../../src/main/git/service';
import { gitRuntimeStatus } from '../../src/main/git/runtime';
import { VERSIONS_BRANCH, type GitReply, type GitRequest, type Identity } from '../../src/main/git/protocol';

const APP: Identity = { name: 'SiteOrigin Builder', email: 'versions@siteorigin.invalid', timestamp: 1_790_000_000, timezoneOffset: 0 };
const ROOT = '/project';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface Fake {
  sent: GitRequest[];
  killed: boolean;
  exited: boolean;
  reply(r: GitReply): void;
  exit(): void;
}

/**
 * Stand-in workers: `answer` decides what each one does with a request (reply now, later, never). A killed worker
 * exits only when the test says (`exitOnKill: false`), as a real process takes a moment to.
 */
function fakeWorkers(answer: (m: GitRequest, w: Fake) => void, opts: { exitOnKill?: boolean } = {}) {
  const spawned: Fake[] = [];
  const spawn = (): GitWorkerHandle => {
    const listeners: Record<string, Array<(x?: unknown) => void>> = {};
    const emit = (e: string, x?: unknown) => (listeners[e] ?? []).forEach((l) => l(x));
    const fake: Fake = {
      sent: [],
      killed: false,
      exited: false,
      reply: (r) => !fake.exited && emit('message', structuredClone(r)),
      exit: () => {
        if (fake.exited) return;
        fake.exited = true;
        emit('exit', 0);
      }
    };
    spawned.push(fake);
    return {
      postMessage: (m) => {
        if (fake.exited) throw new Error('gone');
        const copy = structuredClone(m);
        fake.sent.push(copy);
        setTimeout(() => answer(copy, fake));
      },
      on: (e: string, l: (x?: unknown) => void) => ((listeners[e] ??= []).push(l), undefined),
      kill: () => {
        fake.killed = true;
        if (opts.exitOnKill !== false) setTimeout(() => fake.exit());
        return true;
      }
    } as GitWorkerHandle;
  };
  return { spawn, spawned };
}

const ok = (m: GitRequest, value: unknown = null): GitReply => ({ id: m.id, ok: true, value });

describe('the Git worker client', () => {
  it('sends one request at a time, in the order they were made', async () => {
    let inWorker = 0;
    let most = 0;
    const order: string[] = [];
    const { spawn, spawned } = fakeWorkers((m, w) => {
      if (m.op === 'cancel') return;
      inWorker++;
      most = Math.max(most, inWorker);
      order.push(m.op);
      setTimeout(() => {
        inWorker--;
        w.reply(ok(m, m.op === 'resolveRef' ? null : 'v'));
      }, 5);
    });
    const repo = createGitClient(spawn).repository(ROOT);
    await Promise.all([repo.init(), repo.resolveRef(VERSIONS_BRANCH), repo.listCommits(VERSIONS_BRANCH, 5)]);
    expect(most).toBe(1);
    expect(order).toEqual(['init', 'resolveRef', 'listCommits']);
    expect(spawned).toHaveLength(1);
  });

  it('refuses requests past the queue’s bounds before sending them, and copies a view’s bytes rather than its whole buffer', async () => {
    const { spawn, spawned } = fakeWorkers(() => undefined);
    const repo = createGitClient(spawn, { maxQueued: 2, maxQueuedBytes: 100, timeoutMs: 60_000 }).repository(ROOT);
    const pending = [repo.init(), repo.writeBlob({ bytes: new Uint8Array(60) }), repo.writeBlob({ bytes: new Uint8Array(30) })];
    pending.forEach((p) => p.catch(() => undefined));
    // One in the worker and two waiting: a third waiting is too many, and 60 + 30 + 20 bytes too much.
    await expect(repo.writeBlob({ bytes: new Uint8Array(20) })).rejects.toMatchObject({ code: 'busy' });
    await tick(5);
    expect(spawned[0].sent.map((m) => m.op)).toEqual(['init']);
    const big = new Uint8Array(4096);
    const sent: GitRequest[] = [];
    const watching = createGitClient(() => {
      const h = fakeWorkers((m, w) => w.reply(ok(m, 'oid'))).spawn();
      const post = h.postMessage.bind(h);
      h.postMessage = (m) => (sent.push(m), post(m));
      return h;
    });
    await watching.repository(ROOT).writeFiles([{ path: 'a.txt', bytes: big.subarray(10, 20) }]);
    const bytes = (sent[0] as Extract<GitRequest, { op: 'writeFiles' }>).files[0] as { bytes: Uint8Array };
    expect(bytes.bytes.byteLength).toBe(10);
    expect(bytes.bytes.buffer.byteLength).toBe(10);
  });

  it('drops a cancelled request that is still waiting, without the worker ever seeing it', async () => {
    const { spawn, spawned } = fakeWorkers((m, w) => m.op !== 'cancel' && setTimeout(() => w.reply(ok(m)), 20));
    const repo = createGitClient(spawn).repository(ROOT);
    const first = repo.init();
    const controller = new AbortController();
    const second = repo.writeFiles([], { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    await first;
    expect(spawned[0].sent.map((m) => m.op)).toEqual(['init']);
    // Already cancelled: never queued.
    await expect(repo.init({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('tells the worker to stop a request in progress, and keeps the worker when it does', async () => {
    const { spawn, spawned } = fakeWorkers((m, w) => {
      if (m.op === 'cancel') w.reply({ id: m.target, ok: false, code: 'cancelled', message: 'stopped' });
    });
    const repo = createGitClient(spawn).repository(ROOT);
    const controller = new AbortController();
    const writing = repo.writeFiles([{ path: 'a', bytes: new Uint8Array(1) }], { signal: controller.signal });
    await tick(5);
    controller.abort();
    await expect(writing).rejects.toMatchObject({ code: 'cancelled' });
    expect(spawned[0].sent.map((m) => m.op)).toEqual(['writeFiles', 'cancel']);
    expect(spawned[0].killed).toBe(false);
    // The worker that stopped in time serves the next request.
    const next = repo.init();
    await tick(5);
    spawned[0].reply(ok(spawned[0].sent[2]));
    await next;
    expect(spawned).toHaveLength(1);
  });

  it('ends a worker that does not stop in time, and a branch move lost with it is outcome-unknown', async () => {
    const { spawn, spawned } = fakeWorkers(() => undefined);
    const repo = createGitClient(spawn, { cancelGraceMs: 20 }).repository(ROOT);
    const controller = new AbortController();
    const writing = repo.writeFiles([], { signal: controller.signal });
    await tick(5);
    controller.abort();
    await expect(writing).rejects.toMatchObject({ code: 'cancelled' });
    expect(spawned[0].killed).toBe(true);
    const moving = repo.advanceRef(VERSIONS_BRANCH, 'a'.repeat(40), null, { timeoutMs: 10 });
    await expect(moving).rejects.toMatchObject({ code: 'outcome-unknown' });
    expect(spawned[1].sent.map((m) => m.op)).toEqual(['advanceRef', 'cancel']);
  });

  it('times out a request that waits too long, in the worker or for its turn', async () => {
    const { spawn, spawned } = fakeWorkers(() => undefined);
    const repo = createGitClient(spawn, { cancelGraceMs: 10 }).repository(ROOT);
    const slow = repo.writeFiles([], { timeoutMs: 30 });
    const waiting = repo.readTree('b'.repeat(40), { timeoutMs: 15 });
    await expect(waiting).rejects.toMatchObject({ code: 'timeout' });
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });
    expect(spawned[0].sent.map((m) => m.op)).toEqual(['writeFiles', 'cancel']);
  });

  it('starts the next worker only once the one it ended has exited, and ignores what the old one says after', async () => {
    const { spawn, spawned } = fakeWorkers(() => undefined, { exitOnKill: false });
    const repo = createGitClient(spawn, { cancelGraceMs: 5 }).repository(ROOT);
    const lost = repo.advanceRef(VERSIONS_BRANCH, 'a'.repeat(40), null, { timeoutMs: 5 });
    await expect(lost).rejects.toMatchObject({ code: 'outcome-unknown' });
    const next = repo.resolveRef(VERSIONS_BRANCH);
    await tick(30);
    // The ended worker has not exited yet: nothing else starts.
    expect(spawned).toHaveLength(1);
    spawned[0].reply({ id: spawned[0].sent[0].id, ok: true, value: null });
    spawned[0].exit();
    await tick(5);
    expect(spawned).toHaveLength(2);
    const request = spawned[1].sent[0];
    // A late answer from the old worker to the new worker's request id belongs to nothing.
    spawned[0].reply({ id: request.id, ok: true, value: 'stale' });
    spawned[1].reply(ok(request, 'c'.repeat(40)));
    await expect(next).resolves.toBe('c'.repeat(40));
  });

  it('a worker that crashes fails the request it had, and the next request gets a new worker', async () => {
    let n = 0;
    const { spawn, spawned } = fakeWorkers((m, w) => (n++ === 0 ? w.exit() : w.reply(ok(m, true))));
    const repo = createGitClient(spawn).repository(ROOT);
    await expect(repo.writeFiles([])).rejects.toMatchObject({ code: 'crashed' });
    await expect(repo.exists()).resolves.toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it('ends an idle worker, and starts one again when asked', async () => {
    const { spawn, spawned } = fakeWorkers((m, w) => w.reply(ok(m, true)));
    const repo = createGitClient(spawn, { idleMs: 10 }).repository(ROOT);
    await repo.exists();
    await tick(40);
    expect(spawned[0].killed).toBe(true);
    await repo.exists();
    expect(spawned).toHaveLength(2);
  });

  it('refuses everything once stopped', async () => {
    const { spawn, spawned } = fakeWorkers(() => undefined);
    const client = createGitClient(spawn);
    const repo = client.repository(ROOT);
    const moving = repo.advanceRef(VERSIONS_BRANCH, 'a'.repeat(40), null);
    const waiting = repo.init();
    await tick(5);
    client.stop();
    await expect(moving).rejects.toMatchObject({ code: 'outcome-unknown' });
    await expect(waiting).rejects.toMatchObject({ code: 'stopped' });
    await expect(repo.exists()).rejects.toMatchObject({ code: 'stopped' });
    expect(spawned[0].killed).toBe(true);
  });
});

describe('the client and the worker’s service together', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'so-git-client-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Workers that run the real service, each a fresh one: a worker restarted knows only what is on the disk. */
  const serviceWorkers = () => {
    const services = new WeakMap<Fake, ReturnType<typeof createGitService>>();
    return fakeWorkers((m, w) => {
      if (!services.has(w)) services.set(w, createGitService((r) => w.reply(r)));
      void services.get(w)!.handle(m);
    });
  };

  it('saves a version through the worker and reads it back after the worker restarted', async () => {
    const { spawn, spawned } = serviceWorkers();
    const client = createGitClient(spawn, { idleMs: 5 });
    const repo = client.repository(root);
    await repo.init();
    const tree = await repo.writeFiles([{ path: 'siteorigin/site.json', bytes: new TextEncoder().encode('{}\n') }]);
    const commit = await repo.writeCommit({ tree, parents: [], author: APP, committer: APP, message: 'First\n' });
    await repo.advanceRef(VERSIONS_BRANCH, commit, null);
    await expect(repo.advanceRef(VERSIONS_BRANCH, commit, null)).rejects.toMatchObject({ code: 'conflict', actual: commit });
    await tick(30);
    expect(spawned[0].killed).toBe(true);
    expect(await repo.resolveRef(VERSIONS_BRANCH)).toBe(commit);
    expect(new TextDecoder().decode(await repo.readBlob(commit, 'siteorigin/site.json'))).toBe('{}\n');
    expect(spawned).toHaveLength(2);
    await expect(client.version()).resolves.toMatch(/^\d+\.\d+\.\d+$/);
    const status = await gitRuntimeStatus(client, async () => ({ status: 'missing' }));
    expect(status).toEqual({ bundled: { engine: 'isomorphic-git', ready: true, version: expect.stringMatching(/^\d+\./) }, system: { status: 'missing' } });
    client.stop();
    expect(await gitRuntimeStatus(client, async () => ({ status: 'missing' }))).toMatchObject({ bundled: { ready: false } });
  });
});
