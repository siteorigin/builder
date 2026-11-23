import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process: tests decide what the worker says and when it exits. */
class FakeWorker extends EventEmitter {
  stderr = new EventEmitter();
  posted: unknown[] = [];
  killed = false;
  /** A worker that ignores being killed (hung in native code). */
  stubborn = false;
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  kill() {
    this.killed = true;
    if (!this.stubborn) queueMicrotask(() => this.emit('exit', null));
    return true;
  }
}
const workers: FakeWorker[] = [];
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0.0.0' },
  utilityProcess: {
    fork: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }
  }
}));

const { BUILD_LIMITS, buildProject } = await import('../../src/main/runtime/manager');

afterEach(() => {
  workers.splice(0);
  vi.useRealTimers();
});

describe('production build worker', () => {
  it('returns the build result and stops the worker', async () => {
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'built', ok: true, logs: ['done'] });
    expect(await p).toEqual({ ok: true, error: undefined, logs: ['done'] });
    expect(workers[0].killed).toBe(true);
  });

  it('keeps what a failed build wrote to stderr', async () => {
    const p = buildProject('/project');
    workers[0].stderr.emit('data', 'no element with id="gone" exists on /contact/\n');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: ['vite warning'] });
    expect(await p).toEqual({ ok: false, error: 'Prerendering failed', logs: ['vite warning', 'no element with id="gone" exists on /contact/'] });
  });

  it('keeps stderr that arrives after the worker reports a failure', async () => {
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: [] });
    workers[0].stderr.emit('data', 'The following pages contain links to /contact/#gone, ');
    workers[0].stderr.emit('data', 'but no element with id="gone" exists on /contact/');
    expect((await p).logs).toEqual(['The following pages contain links to /contact/#gone, but no element with id="gone" exists on /contact/']);
  });

  it('fails promptly when the worker reports an error and never exits', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'error', message: 'Error: plugin crashed\n    at stack' });
    await vi.advanceTimersByTimeAsync(BUILD_LIMITS.errorGraceMs);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/plugin crashed/);
    expect(workers[0].killed).toBe(true);
  });

  it('still takes a result that arrives just after a reported error', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'error', message: 'a stray rejection' });
    workers[0].emit('message', { type: 'built', ok: true, logs: [] });
    expect((await p).ok).toBe(true);
  });

  it('gives up on a build that takes too long', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    await vi.advanceTimersByTimeAsync(BUILD_LIMITS.timeoutMs);
    expect((await p).error).toMatch(/too long/);
    expect(workers[0].killed).toBe(true);
  });

  it('waits for the worker to exit before settling, but not forever', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    workers[0].stubborn = true;
    let settled = false;
    void p.then(() => (settled = true));
    workers[0].emit('message', { type: 'built', ok: true, logs: [] });
    await vi.advanceTimersByTimeAsync(BUILD_LIMITS.exitWaitMs - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
  });

  it('reports a worker that exits without a result', async () => {
    const p = buildProject('/project');
    workers[0].stderr.emit('data', 'Segmentation fault');
    workers[0].emit('exit', 139);
    expect((await p).error).toMatch(/exited \(139\).*Segmentation/);
  });
});
