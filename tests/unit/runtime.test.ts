import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process: tests decide what the worker says and when it exits. */
class FakeWorker extends EventEmitter {
  stderr = new EventEmitter();
  posted: unknown[] = [];
  killed = false;
  pid?: number;
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

const { BUILD_LIMITS, STOP_LIMITS, DevServer, buildProject, prepareDependencies } = await import('../../src/main/runtime/manager');

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

describe('preview worker', () => {
  it('kills a worker that ignores both stop and terminate, and waits for it to exit', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const dev = new DevServer('/project');
      const started = dev.start();
      const w = workers[0];
      w.pid = 4242;
      w.stubborn = true;
      w.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' });
      await started;
      let stopped = false;
      void dev.stop().then(() => (stopped = true));
      expect(w.posted.at(-1)).toEqual({ type: 'stop' });
      await vi.advanceTimersByTimeAsync(STOP_LIMITS.termMs);
      expect(w.killed).toBe(true);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(STOP_LIMITS.killMs - STOP_LIMITS.termMs);
      expect(kill).toHaveBeenCalledWith(4242, 'SIGKILL');
      // A replacement must not start beside it: stopping waits for the exit.
      expect(stopped).toBe(false);
      w.emit('exit', null);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      expect(dev.status).toEqual({ state: 'idle' });
    } finally {
      kill.mockRestore();
    }
  });

  it('stops waiting for a worker that never exits, after the last limit', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const dev = new DevServer('/project');
      const started = dev.start();
      const w = workers[0];
      w.pid = 4343;
      w.stubborn = true;
      w.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' });
      await started;
      let stopped = false;
      void dev.stop().then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(STOP_LIMITS.giveUpMs - 1);
      expect(kill).toHaveBeenCalledWith(4343, 'SIGKILL');
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it('ends a start still waiting for its process when the server is stopped', async () => {
    vi.useFakeTimers();
    const dev = new DevServer('/project');
    let started = false;
    void dev.start().then(() => (started = true));
    const w = workers[0];
    void dev.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
    expect(w.posted.at(-1)).toEqual({ type: 'stop' });
  });

  it('does not start a crashed preview again where it may no longer run', async () => {
    const dev = new DevServer('/project', async () => false);
    const started = dev.start();
    workers[0].emit('message', { type: 'ready', url: 'http://127.0.0.1:1' });
    await started;
    workers[0].emit('exit', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(workers).toHaveLength(1);
    expect(dev.status.state).toBe('error');
  });
});

describe('installing the website tools', () => {
  it('runs nothing in a project that is no longer this app’s to write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-install-'));
    try {
      await expect(prepareDependencies(dir, () => undefined, undefined, async () => false)).rejects.toThrow('Cancelled');
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
