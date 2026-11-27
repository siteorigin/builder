import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { collectGarbage, createIdleCollector, heapGrowth, idleCollectPlugin } from '../../src/runtime/idle-collect';

const QUIET = 3000;

function collector(blocked = () => false) {
  const collect = vi.fn(async () => {});
  const idle = createIdleCollector({ quietMs: QUIET, collect, blocked: () => blocked() });
  return { idle, collect };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the dev server’s idle collection', () => {
  it('collects once, a quiet period after the last activity, and not again until something happens', async () => {
    vi.useFakeTimers();
    const { idle, collect } = collector();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).not.toHaveBeenCalled();
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET - 1);
    expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).toHaveBeenCalledTimes(1);
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('waits out a burst: each activity starts the quiet period again', async () => {
    vi.useFakeTimers();
    const { idle, collect } = collector();
    for (let i = 0; i < 10; i++) {
      idle.activity();
      await vi.advanceTimersByTimeAsync(QUIET - 100);
    }
    expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('never collects while work is under way, and counts the quiet from the end of the last of it', async () => {
    vi.useFakeTimers();
    const { idle, collect } = collector();
    const first = idle.begin();
    const second = idle.begin();
    await vi.advanceTimersByTimeAsync(QUIET * 4);
    first();
    // Ending twice (a response's finish, then its close) counts once.
    first();
    await vi.advanceTimersByTimeAsync(QUIET * 4);
    expect(collect).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(QUIET - 1);
    expect(collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('waits for a save being published, then collects once it has been quiet for as long again', async () => {
    vi.useFakeTimers();
    let holding = true;
    const { idle, collect } = collector(() => holding);
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET * 3);
    expect(collect).not.toHaveBeenCalled();
    holding = false;
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('runs one collection at a time, and collects again for work that came in meanwhile', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const collect = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const idle = createIdleCollector({ quietMs: QUIET, collect });
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(1);
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET * 2);
    expect(collect).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('keeps going when a collection fails, and stops for good once disposed', async () => {
    vi.useFakeTimers();
    const collect = vi.fn(() => {
      throw new Error('no inspector');
    });
    const idle = createIdleCollector({ quietMs: QUIET, collect });
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(2);
    idle.activity();
    idle.dispose();
    idle.activity();
    const end = idle.begin();
    end();
    await vi.advanceTimersByTimeAsync(QUIET * 10);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('skips a collection the heap has not grown enough for, and waits for the next work', async () => {
    vi.useFakeTimers();
    let size = 100;
    const growth = heapGrowth(16, () => size);
    const collect = vi.fn(async () => growth.reset());
    const idle = createIdleCollector({ quietMs: QUIET, collect, worth: growth.grown });
    size = 110;
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET * 3);
    expect(collect).not.toHaveBeenCalled();
    size = 116;
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(1);
    // Measured again from the heap the collection left.
    size = 120;
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(1);
    size = 132;
    idle.activity();
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('counts each request of every server Vite makes as work until its answer has gone or its connection closed, and each watched file as activity', async () => {
    vi.useFakeTimers();
    const { idle, collect } = collector();
    const plugin = idleCollectPlugin(idle);
    const serverOf = () => {
      const http = new EventEmitter();
      const watcher = new EventEmitter();
      plugin.configureServer({ httpServer: { prependListener: (e, fn) => http.prependListener(e, fn as never) }, watcher: { on: (e, fn) => watcher.on(e, fn) } });
      return { http, watcher };
    };
    const first = serverOf();
    const res = new EventEmitter();
    first.http.emit('request', {}, res);
    await vi.advanceTimersByTimeAsync(QUIET * 3);
    expect(collect).not.toHaveBeenCalled();
    res.emit('finish');
    res.emit('close');
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(1);
    // A restarted server's own requests and files.
    const second = serverOf();
    const aborted = new EventEmitter();
    second.http.emit('request', {}, aborted);
    await vi.advanceTimersByTimeAsync(QUIET * 3);
    expect(collect).toHaveBeenCalledTimes(1);
    aborted.emit('close');
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(2);
    second.watcher.emit('all', 'change', '/p/src/a.svelte');
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it('collects through the process’s inspector and leaves the process running: its timers fire, it exits, no gc is left for the site', async () => {
    // In a process of its own: a collection that left the event loop stuck would stop this one's too, timeouts and all.
    const script = `
      import { collectGarbage } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/runtime/idle-collect.ts')).href)};
      let garbage = [];
      for (let i = 0; i < 200; i++) garbage.push(new Array(5000).fill({ i }));
      garbage = null;
      const used = process.memoryUsage().heapUsed;
      await collectGarbage();
      await collectGarbage();
      setTimeout(() => console.log(JSON.stringify({ freed: used > process.memoryUsage().heapUsed, gc: 'gc' in globalThis })), 20);
    `;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.node.json' }, stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the process did not finish after collecting: ${text}`));
      }, 15_000);
      child.on('exit', () => {
        clearTimeout(deadline);
        resolve(text);
      });
    });
    expect(JSON.parse(out.trim())).toEqual({ freed: true, gc: false });
  }, 20_000);
});
