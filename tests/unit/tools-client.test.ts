/**
 * The website tools check in a process of its own (#961): the New project dialog's check and the new project's own
 * are answered by one process, one at a time, which goes once idle; one that stops or stalls fails its check, and the
 * next check starts a new one.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolsChecker, type ToolsCheckReply, type ToolsCheckRequest, type ToolsWorkerHandle } from '../../src/main/runtime/tools-client';

/** A check's process: answers each request as `answer` says, or not at all. */
class FakeWorker extends EventEmitter implements ToolsWorkerHandle {
  asked: ToolsCheckRequest[] = [];
  killed = false;
  constructor(private answer: (m: ToolsCheckRequest) => ToolsCheckReply | null) {
    super();
  }
  postMessage(m: ToolsCheckRequest) {
    this.asked.push(m);
    const r = this.answer(m);
    if (r) setTimeout(() => this.emit('message', r), 5);
  }
  kill() {
    this.killed = true;
    setTimeout(() => this.emit('exit', 0), 0);
    return true;
  }
}

const req = { npmDir: '/npm', dir: '/starter', cache: '/cache', caches: ['/cache'] };
const ok = (m: ToolsCheckRequest): ToolsCheckReply => ({ id: m.id, ok: true, packages: [{ location: `node_modules/${m.dir.slice(1)}` }], offline: true, missing: 0, needed: 1 });

afterEach(() => vi.useRealTimers());

describe('the website tools check’s process', () => {
  it('answers each check in turn from one process, which goes once it has been idle a while', async () => {
    const made: FakeWorker[] = [];
    const checker = createToolsChecker(() => (made.push(new FakeWorker(ok)), made.at(-1)!), { idleMs: 50 });
    const [a, b] = await Promise.all([checker.check(req), checker.check({ ...req, dir: '/project' })]);
    expect(a).toEqual({ offline: true, missing: 0, needed: 1, packages: [{ location: 'node_modules/starter' }] });
    expect(b.packages).toEqual([{ location: 'node_modules/project' }]);
    expect(made).toHaveLength(1);
    expect(made[0].asked.map((m) => m.dir)).toEqual(['/starter', '/project']);
    await new Promise((r) => setTimeout(r, 120));
    expect(made[0].killed).toBe(true);
    // The next check starts a process again.
    await checker.check(req);
    expect(made).toHaveLength(2);
    checker.stop();
  });

  it('fails a check whose process stops or says it failed, and starts afresh for the next', async () => {
    let mode: 'exit' | 'fail' | 'ok' = 'exit';
    const made: FakeWorker[] = [];
    const checker = createToolsChecker(() => {
      const w = new FakeWorker((m) => {
        if (mode === 'exit') {
          setTimeout(() => w.emit('exit', 1), 1);
          return null;
        }
        return mode === 'fail' ? { id: m.id, ok: false, error: 'no lock' } : ok(m);
      });
      made.push(w);
      return w;
    });
    // A process that stops under a check is replaced once, for the same check; one that stops again fails it.
    await expect(checker.check(req)).rejects.toThrow('stopped');
    expect(made).toHaveLength(2);
    mode = 'fail';
    await expect(checker.check(req)).rejects.toThrow('no lock');
    expect(made).toHaveLength(3);
    mode = 'ok';
    await expect(checker.check(req)).resolves.toMatchObject({ offline: true });
    // The one that said the check failed answers the next.
    expect(made).toHaveLength(3);
    checker.stop();
  });

  it('asks a check once more of a new process when its own stopped under it', async () => {
    const made: FakeWorker[] = [];
    const checker = createToolsChecker(() => {
      const first = !made.length;
      const w = new FakeWorker((m) => {
        if (first) {
          setTimeout(() => w.emit('exit', 1), 1);
          return null;
        }
        return ok(m);
      });
      made.push(w);
      return w;
    });
    await expect(checker.check(req)).resolves.toMatchObject({ packages: [{ location: 'node_modules/starter' }] });
    expect(made).toHaveLength(2);
    checker.stop();
  });

  it('gives a check called off its answer at once, whether under way or waiting, and goes on with the next', async () => {
    const made: FakeWorker[] = [];
    let answer = false;
    const checker = createToolsChecker(() => (made.push(new FakeWorker((m) => (answer ? ok(m) : null))), made.at(-1)!), { timeoutMs: 10_000 });
    const running = new AbortController();
    const waiting = new AbortController();
    const first = checker.check(req, running.signal);
    const second = checker.check({ ...req, dir: '/project' }, waiting.signal);
    await new Promise((r) => setTimeout(r, 5));
    waiting.abort();
    running.abort();
    await expect(first).rejects.toThrow('Canceled');
    await expect(second).rejects.toThrow('Canceled');
    // Neither was asked of another process, and the next check is answered by the same one.
    expect(made[0].asked.map((m) => m.dir)).toEqual(['/starter']);
    answer = true;
    await expect(checker.check(req)).resolves.toMatchObject({ offline: true });
    expect(made).toHaveLength(1);
    checker.stop();
  });

  it('ends a process that does not answer, and an answer to an earlier check is no answer to this one', async () => {
    const made: FakeWorker[] = [];
    let silent = true;
    const checker = createToolsChecker(() => (made.push(new FakeWorker((m) => (silent ? null : { ...ok(m), id: m.id + 100 }))), made.at(-1)!), { timeoutMs: 40 });
    // Ended, and asked once more of a new process, which does not answer either.
    await expect(checker.check(req)).rejects.toThrow('stopped');
    expect(made).toHaveLength(2);
    expect(made[0].killed).toBe(true);
    silent = false;
    await expect(checker.check(req)).rejects.toThrow('stopped');
    expect(made).toHaveLength(4);
  });

  it('gives a waiting check called off its answer at once, while the one before it is still being worked out', async () => {
    const made: FakeWorker[] = [];
    const checker = createToolsChecker(() => (made.push(new FakeWorker(() => null)), made.at(-1)!), { timeoutMs: 10_000 });
    const first = checker.check(req);
    const waiting = new AbortController();
    const second = checker.check({ ...req, dir: '/project' }, waiting.signal);
    let settled = false;
    void first.catch(() => (settled = true));
    await new Promise((r) => setTimeout(r, 5));
    waiting.abort();
    await expect(second).rejects.toThrow('Canceled');
    expect(settled).toBe(false);
    checker.stop();
    await expect(first).rejects.toThrow('stopped');
  });

  it('fails the check in progress and those waiting when the app stops it, and starts nothing again', async () => {
    const made: FakeWorker[] = [];
    const quitting = createToolsChecker(() => (made.push(new FakeWorker(() => null)), made.at(-1)!));
    const active = quitting.check(req);
    const queued = quitting.check({ ...req, dir: '/project' });
    await new Promise((r) => setTimeout(r, 5));
    quitting.stop();
    await expect(active).rejects.toThrow('stopped');
    await expect(queued).rejects.toThrow('stopped');
    await expect(quitting.check(req)).rejects.toThrow('stopped');
    // Nothing started again once it was stopped.
    expect(made).toHaveLength(1);
    expect(made[0].killed).toBe(true);
  });
});
