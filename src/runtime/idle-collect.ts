/**
 * Gives the preview's dev server memory back once it has gone quiet (issue #1035). The server works in bursts (a page
 * opened, a save's update, a component preview), each leaving garbage, then sits idle while the author works. V8
 * collects a quiet process's heap only late, and its own memory reducer spends its few collections on the first
 * burst, so the server would hold most of a burst's leftovers for the rest of the session. Once nothing has happened
 * for a while after some work, one collection that hands memory back to the system is made.
 *
 * Kept apart from the worker so it can be tested without a dev server.
 */
import { getHeapStatistics } from 'node:v8';

export const IDLE_COLLECT = {
  /** How long the server must have been quiet after its last work before it collects. */
  quietMs: 3000,
  /** How much the heap must have grown since the last collection for another to be worth its pause. */
  growthBytes: 16 * 2 ** 20
};

export interface IdleCollector {
  /** Something happened that may have left garbage: collect once the server has been quiet for `quietMs`. */
  activity(): void;
  /** Work that must not be paused by a collection has started; the function returned says it has ended (once). */
  begin(): () => void;
  /** No collection from here on. */
  dispose(): void;
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // A timer of its own never keeps the process alive.
    t.unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
};

/**
 * Collect with `collect` once, `quietMs` after the last activity or the end of the last work, while nothing is under
 * way and `blocked` (a save's files being published) says nothing else is. A quiet server that did nothing since the
 * last collection is left alone.
 */
export function createIdleCollector(opts: { quietMs: number; collect: () => Promise<void> | void; blocked?: () => boolean; worth?: () => boolean; timers?: Timers }): IdleCollector {
  const timers = opts.timers ?? realTimers;
  let timer: unknown = null;
  let busy = 0;
  let dirty = false;
  let collecting = false;
  let disposed = false;
  const stop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const arm = () => {
    stop();
    if (!disposed && dirty && !busy) timer = timers.set(fire, opts.quietMs);
  };
  const fire = () => {
    timer = null;
    if (disposed || busy || !dirty || collecting) return;
    // Still working (a save landing): look again once it has been quiet for as long again.
    if (opts.blocked?.()) return arm();
    dirty = false;
    // Too little left behind to be worth a collection: the next work may leave more.
    if (opts.worth && !opts.worth()) return;
    collecting = true;
    const done = () => {
      collecting = false;
      // Work that came in meanwhile is collected after in turn.
      arm();
    };
    try {
      Promise.resolve(opts.collect()).then(done, done);
    } catch {
      done();
    }
  };
  return {
    activity() {
      dirty = true;
      arm();
    },
    begin() {
      busy++;
      dirty = true;
      stop();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        busy--;
        arm();
      };
    },
    dispose() {
      disposed = true;
      stop();
    }
  };
}

/** Whether the heap holds `bytes` more than when `reset` was last called (or when this was made). */
export function heapGrowth(bytes: number, size: () => number = () => getHeapStatistics().total_heap_size) {
  let base = size();
  return {
    grown: () => size() - base >= bytes,
    reset: () => {
      base = size();
    }
  };
}

type InspectorSession = { connect(): void; disconnect(): void; post(method: string, done: () => void): void };

/**
 * A full collection that hands what it frees back to the system, as V8 makes when memory runs low: asked through
 * the process's own inspector, so no V8 flag is set and no `gc` is put where the site's own code would see it. A
 * process without an inspector collects nothing.
 */
export function collectGarbage(): Promise<void> {
  return new Promise<void>((resolve) => {
    let session: InspectorSession | null = null;
    const end = () => {
      // Disconnected on the next turn: disconnecting inside the answer's own callback leaves the event loop stuck.
      setImmediate(() => {
        try {
          session?.disconnect();
        } catch {
          // Only memory is at stake.
        }
        resolve();
      });
    };
    try {
      const { Session } = process.getBuiltinModule('node:inspector') as typeof import('node:inspector');
      session = new Session() as unknown as InspectorSession;
      session.connect();
      session.post('HeapProfiler.collectGarbage', end);
    } catch {
      end();
    }
  });
}

type Res = { once(event: 'finish' | 'close', fn: () => void): unknown };
type IdleServer = {
  httpServer: { prependListener(event: 'request', fn: (req: unknown, res: Res) => void): unknown } | null;
  watcher: { on(event: 'all', fn: () => void): unknown };
};

/**
 * A Vite plugin that tells `idle` of the server's work: each request from when it arrives until its answer has gone
 * (or its connection closed), and each file the watcher reports. Set up for every server Vite makes, a restart's too.
 */
export function idleCollectPlugin(idle: IdleCollector) {
  return {
    name: 'siteorigin-idle-collect',
    configureServer(server: IdleServer) {
      // Ahead of every middleware, so a request another plugin answers on its own is counted too.
      server.httpServer?.prependListener('request', (_req, res) => {
        const end = idle.begin();
        res.once('finish', end);
        res.once('close', end);
      });
      server.watcher.on('all', () => idle.activity());
    }
  };
}
