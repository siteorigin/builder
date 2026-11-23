import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process: tests decide what the worker says and when it exits. */
class FakeWorker extends EventEmitter {
  /** Streams that are still open when the worker exits, as a real process's pipes can be. */
  static pipesOpen = false;
  stdout = Object.assign(new EventEmitter(), { readable: FakeWorker.pipesOpen });
  stderr = Object.assign(new EventEmitter(), { readable: FakeWorker.pipesOpen });
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
  FakeWorker.pipesOpen = false;
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

  it('keeps what a failed build wrote to stdout, where SvelteKit prints why prerendering failed', async () => {
    const p = buildProject('/project');
    // The cause arrives in pieces on stdout, ahead of the generic error and a pile of progress lines.
    const noise = Array.from({ length: 300 }, (_, i) => `progress ${i}`).join('\n');
    workers[0].stdout.emit('data', `Error: Cannot read properties of undefined (reading 'title')\n    at Contact (src/routes/contact/+pag`);
    workers[0].stdout.emit('data', `e.svelte:9:5)\n${noise}\n`);
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: ['vite warning'] });
    // The route is printed on stderr after the worker has reported, and before it exits.
    workers[0].stderr.emit('data', '500 /contact/ (linked from /)\n');
    const r = await p;
    expect(r.error).toBe('Prerendering failed');
    expect(r.logs[0]).toBe('vite warning');
    expect(r.logs).toContain('500 /contact/ (linked from /)');
    // The cause and its stack frame outlive the 300 progress lines that follow, which are cut down to the last ones.
    expect(r.logs).toContain("Error: Cannot read properties of undefined (reading 'title')");
    expect(r.logs).toContain('    at Contact (src/routes/contact/+page.svelte:9:5)');
    expect(r.logs).toContain('progress 299');
    expect(r.logs).not.toContain('progress 10');
    expect(r.logs.filter((l) => /^… \d+ lines omitted$/.test(l))).toHaveLength(1);
    expect(r.logs.length).toBeLessThan(260);
  });

  it('keeps output that arrives after the worker has already exited', async () => {
    FakeWorker.pipesOpen = true;
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: [] });
    await vi.waitFor(() => expect(workers[0].killed).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    // The worker has exited, and its pipes still deliver what it wrote.
    workers[0].stdout.emit('data', 'Error: the real cause\n');
    workers[0].stderr.emit('data', '500 GET /contact/\n');
    workers[0].stdout.emit('end');
    workers[0].stderr.emit('end');
    expect((await p).logs).toEqual(['Error: the real cause', '500 GET /contact/']);
  });

  it('stops waiting for pipes that never end', async () => {
    vi.useFakeTimers();
    FakeWorker.pipesOpen = true;
    const p = buildProject('/project');
    workers[0].stdout.emit('data', 'Error: before the report\n');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: [] });
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(BUILD_LIMITS.streamWaitMs - 50);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect((await p).logs).toEqual(['Error: before the report']);
  });

  it('keeps the exception a worker reported when it then exits before the grace period ends', async () => {
    const failure = { message: 'the root cause', stack: 'Error: the root cause\n    at x' };
    const p = buildProject('/project');
    workers[0].stderr.emit('data', 'stderr detail\n');
    workers[0].emit('message', { type: 'error', message: 'Error: the root cause\n    at x', failure });
    workers[0].emit('exit', 139);
    const r = await p;
    expect(r.failure).toEqual(failure);
    expect(r.error).toMatch(/^The build stopped with an error: Error: the root cause/);
    expect(r.logs).toEqual(['Build process exited (139).', 'stderr detail']);
  });

  it('keeps the first exception a worker reports as the cause, and the later ones as context, under one timer', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    const first = { message: 'the plugin failed' };
    workers[0].emit('message', { type: 'error', message: 'Error: the plugin failed', failure: first });
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(BUILD_LIMITS.errorGraceMs - 1000);
    workers[0].emit('message', { type: 'error', message: 'Error: cleanup rejected', failure: { message: 'cleanup rejected' } });
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.failure).toEqual(first);
    expect(r.error).toBe('The build stopped with an error: Error: the plugin failed');
    expect(r.logs).toEqual(['Error: cleanup rejected']);
  });

  it('stops reading the pipes once the result is out', async () => {
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: [] });
    await p;
    expect(workers[0].stdout.listenerCount('data')).toBe(0);
    expect(workers[0].stderr.listenerCount('data')).toBe(0);
  });

  it('lists what the worker said, then stdout, then stderr', async () => {
    const p = buildProject('/project');
    workers[0].stderr.emit('data', 'from stderr\n');
    workers[0].stdout.emit('data', 'from stdout\n');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: ['from the worker'] });
    expect((await p).logs).toEqual(['from the worker', 'from stdout', 'from stderr']);
  });

  it('hides a credential a build printed as it is read, before any line is cut', async () => {
    const p = buildProject('/project');
    workers[0].stdout.emit('data', 'const apiKey = "sk-live_abcdefgh12345678";\n');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: [] });
    expect((await p).logs).toEqual(['const apiKey = "…";']);
  });

  it('uses an exception the worker reported earlier when the result only says the build failed', async () => {
    const root = { message: 'the root cause', stack: 'Error: the root cause\n    at x' };
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'error', message: 'Error: the root cause', failure: root });
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', failure: { message: 'Prerendering failed' }, logs: [] });
    expect((await p).failure).toEqual({ message: 'Prerendering failed', cause: root });
    // A build that goes on to succeed is not failed by it.
    const q = buildProject('/project');
    workers[1].emit('message', { type: 'error', message: 'a stray rejection', failure: root });
    workers[1].emit('message', { type: 'built', ok: true, logs: [] });
    expect((await q).ok).toBe(true);
  });

  it('keeps an error printed in colour, and the last error of a long build, among a flood of progress lines', async () => {
    const p = buildProject('/project');
    const progress = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `progress ${from + i}`).join('\n');
    // Eighty early errors would fill the room kept for the first ones; the last error must still be kept.
    for (let i = 0; i < 90; i++) workers[0].stdout.emit('data', `Error: early ${i}\n`);
    workers[0].stdout.emit('data', `${progress(0, 400)}\n`);
    workers[0].stdout.emit('data', '\x1b[31mTypeError: the last cause\x1b[39m\n');
    workers[0].stdout.emit('data', `${progress(400, 800)}\n`);
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', logs: [] });
    const r = await p;
    expect(r.logs).toContain('Error: early 0');
    expect(r.logs).toContain('\x1b[31mTypeError: the last cause\x1b[39m');
    expect(r.logs).toContain('progress 799');
  });

  it('ignores what a worker says after the build has settled, and leaves no timer running', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'built', ok: false, error: 'first', logs: [] });
    workers[0].emit('message', { type: 'error', message: 'a stray rejection' });
    workers[0].emit('message', { type: 'built', ok: true, logs: [] });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('first');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands back what the worker threw, causes included', async () => {
    const failure = { message: 'Prerendering failed', cause: { message: 'title is undefined', plugin: 'sveltekit' } };
    const p = buildProject('/project');
    workers[0].emit('message', { type: 'built', ok: false, error: 'Prerendering failed', failure, logs: [] });
    expect(await p).toEqual({ ok: false, error: 'Prerendering failed', failure, logs: [] });
  });

  it('keeps a successful build free of what it printed', async () => {
    const p = buildProject('/project');
    workers[0].stdout.emit('data', 'vite v7 building for production...\n');
    workers[0].emit('message', { type: 'built', ok: true, logs: ['a warning'] });
    expect(await p).toEqual({ ok: true, error: undefined, logs: ['a warning'] });
  });

  it('keeps what the build printed when the worker exits without a result', async () => {
    const p = buildProject('/project');
    workers[0].stdout.emit('data', 'Error: out of memory\n');
    workers[0].emit('exit', 134);
    const r = await p;
    expect(r.error).toMatch(/exited \(134\)/);
    expect(r.logs).toEqual(['Error: out of memory']);
  });

  it('keeps the exception the worker reported with an error it could not return as a result', async () => {
    vi.useFakeTimers();
    const p = buildProject('/project');
    const failure = { message: 'plugin crashed', stack: 'Error: plugin crashed\n    at x' };
    workers[0].stderr.emit('data', 'extra detail\n');
    workers[0].emit('message', { type: 'error', message: 'Error: plugin crashed\n    at x', failure });
    await vi.advanceTimersByTimeAsync(BUILD_LIMITS.errorGraceMs);
    const r = await p;
    expect(r.failure).toEqual(failure);
    expect(r.logs).toEqual(['extra detail']);
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
    const r = await p;
    expect(r.error).toBe('Build process exited (139).');
    expect(r.logs).toEqual(['Segmentation fault']);
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
