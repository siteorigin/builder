/**
 * The worker a Node.js server export's checks run the built server in (#1481, main/runtime/manager.ts
 * serveBuiltServer): asked to serve the build, from the folder it is given to run in, with the project processes' own
 * environment; settled on its answer, its exit, a time limit or being called off, with the worker gone; and stopped
 * outright when it does not leave when asked.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Behaviour = 'serve' | 'exit' | 'silent' | 'error' | 'stubborn';
const env = vi.hoisted(() => ({ behaviour: 'serve' as Behaviour, forks: [] as Array<{ cwd?: string; env?: Record<string, string>; worker: unknown }> }));

class FakeCheck extends EventEmitter {
  pid = 424242;
  killed = 0;
  exited = false;
  sent: unknown[] = [];
  postMessage(m: { type: string; dir?: string }) {
    this.sent.push(m);
    if (m.type !== 'serve-built') return;
    if (env.behaviour === 'serve' || env.behaviour === 'stubborn') queueMicrotask(() => this.emit('message', { type: 'serving', url: 'http://127.0.0.1:4321' }));
    if (env.behaviour === 'exit') queueMicrotask(() => this.exit(1));
    if (env.behaviour === 'error') queueMicrotask(() => this.emit('message', { type: 'error', message: 'Error: Cannot find module nanoid\n    at x' }));
  }
  exit(code: number) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
  }
  kill() {
    this.killed++;
    if (env.behaviour !== 'stubborn') queueMicrotask(() => this.exit(0));
    return true;
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  utilityProcess: {
    fork: (_path: string, _args: string[], opts: { cwd?: string; env?: Record<string, string> }) => {
      const worker = new FakeCheck();
      env.forks.push({ cwd: opts.cwd, env: opts.env, worker });
      return worker;
    }
  }
}));

const { serveBuiltServer, SERVE_BUILT_LIMITS } = await import('../../src/main/runtime/manager');
const limits = { ...SERVE_BUILT_LIMITS };
afterEach(() => {
  Object.assign(SERVE_BUILT_LIMITS, limits);
  env.forks = [];
  env.behaviour = 'serve';
  delete process.env.SO_TEST_SECRET;
  vi.restoreAllMocks();
});
const worker = () => env.forks[0].worker as FakeCheck;

describe('the check server’s worker', () => {
  it('serves the build from the folder it is given to run in, with no credential of the app’s, and is gone once stopped', async () => {
    process.env.SO_TEST_SECRET = 'sk_live_should_not_pass';
    const server = await serveBuiltServer('/stage/project/build', { cwd: '/tmp/check-cwd' });
    expect(server.url).toBe('http://127.0.0.1:4321');
    expect(env.forks[0].cwd).toBe('/tmp/check-cwd');
    expect(env.forks[0].env).toMatchObject({ NODE_ENV: 'production' });
    expect(JSON.stringify(env.forks[0].env)).not.toContain('sk_live_should_not_pass');
    expect(worker().sent).toEqual([{ type: 'serve-built', dir: '/stage/project/build' }]);
    await server.stop();
    expect(worker().killed).toBe(1);
    expect(worker().exited).toBe(true);
  });

  it('says why when the server cannot start, or the worker leaves first', async () => {
    env.behaviour = 'error';
    await expect(serveBuiltServer('/b')).rejects.toThrow('could not start: Error: Cannot find module nanoid');
    expect(worker().exited).toBe(true);
    env.forks = [];
    env.behaviour = 'exit';
    await expect(serveBuiltServer('/b')).rejects.toThrow('stopped before it started (1)');
  });

  it('gives up on a server that does not start in time, and stops its worker', async () => {
    env.behaviour = 'silent';
    SERVE_BUILT_LIMITS.startMs = 30;
    await expect(serveBuiltServer('/b')).rejects.toThrow('took too long to start');
    expect(worker().killed).toBe(1);
    expect(worker().exited).toBe(true);
  });

  it('is called off while it starts, and never once it was before it began', async () => {
    env.behaviour = 'silent';
    const job = new AbortController();
    const starting = serveBuiltServer('/b', { signal: job.signal });
    job.abort();
    await expect(starting).rejects.toThrow('called off');
    expect(worker().exited).toBe(true);
    env.forks = [];
    await expect(serveBuiltServer('/b', { signal: job.signal })).rejects.toThrow('called off');
    expect(env.forks).toEqual([]);
  });

  it('ends a worker outright when it does not leave as it is asked', async () => {
    env.behaviour = 'stubborn';
    SERVE_BUILT_LIMITS.exitWaitMs = 20;
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const server = await serveBuiltServer('/b');
    await server.stop();
    expect(worker().killed).toBe(1);
    expect(kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });
});
