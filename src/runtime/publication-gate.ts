/**
 * Holds the preview's hot updates while the editor publishes a batch of files, so the page takes the whole batch as
 * one update (spec §18.2, issue #735). Files land one rename at a time, and Vite would otherwise send each its own
 * update: a page could render a new component with the old page around it, or import a file not written yet.
 *
 * While a batch is held, the file watcher's events wait here instead of reaching Vite. Once the batch is released
 * and every file it changed has been reported by the watcher (which lags the rename), the events are handed to Vite
 * together, and what Vite would send the page for each file is gathered and sent as one update per environment.
 * Anything to run after the batch (the revision the editor waits on) runs once that update has gone.
 *
 * Kept apart from the worker so it can be tested without a dev server.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The watcher's file events: these wait while a batch is held. */
const FILE_EVENTS = new Set(['add', 'change', 'unlink', 'addDir', 'unlinkDir', 'all']);
/** The events Vite turns into one hot update each. */
const UPDATE_EVENTS = new Set(['add', 'change', 'unlink']);

export const GATE_LIMITS = {
  /** A hold the editor never releases (it stopped part way) ends on its own after this. */
  holdMs: 60000,
  /** How long a released batch waits for the watcher to report files it has not reported yet (then they are reported for it). */
  settleMs: 1000,
  /** How long the updates of a batch's files are gathered before the page is reloaded instead. */
  collectMs: 3000,
  /** How often a new hold looks again whether the batch before it has reached the page. */
  pollMs: 10
};

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;
type Send = (...args: unknown[]) => void;
type Payload = { type?: unknown; updates?: unknown; path?: unknown; triggeredBy?: unknown };
type Update = { type: string; path: string; acceptedPath: string; timestamp: number; isWithinCircularImport?: boolean };

/** What the gate uses of a Vite dev server. */
export type GateServer = {
  watcher: { emit: Emit };
  environments: Record<string, { hot: { send: Send } } | undefined>;
};
type Hmr = (environment: never) => Promise<void>;

/** A reload of whatever page is open: what a batch the gate could not gather whole is shown with. */
const RELOAD = { type: 'full-reload', path: '*' };

/**
 * Many sends of one environment as few as say the same: every update in one message (the page then applies them
 * together), and anything else after, in order. A reload of every page (or of a module runner's entries) stands in
 * for everything; a reload of one HTML page applies only on that page, so it goes beside the updates, never in place
 * of them.
 */
export function mergeHotPayloads(sent: unknown[][]): unknown[][] {
  const payload = (args: unknown[]): Payload | null => (args.length === 1 && args[0] && typeof args[0] === 'object' ? (args[0] as Payload) : null);
  const reloads = sent.filter((args) => payload(args)?.type === 'full-reload');
  const whole = reloads.filter((args) => {
    const path = payload(args)!.path;
    return typeof path !== 'string' || !path.endsWith('.html');
  });
  if (whole.length) {
    const first = payload(whole[0])!;
    // Reloaded for files of its own, a runner goes over every entry again.
    const by = new Set(whole.map((args) => payload(args)!.triggeredBy));
    const { triggeredBy: _, ...rest } = first;
    return [[{ ...rest, path: '*', ...(by.size === 1 && first.triggeredBy !== undefined ? { triggeredBy: first.triggeredBy } : {}) }]];
  }
  // The same module updated for two files of the batch is fetched once, at the later timestamp.
  const updates = new Map<string, Update>();
  for (const args of sent) {
    const p = payload(args);
    if (p?.type !== 'update' || !Array.isArray(p.updates)) continue;
    for (const u of p.updates as Update[]) {
      const key = JSON.stringify([u.type, u.path, u.acceptedPath]);
      const was = updates.get(key);
      const circular = !!was?.isWithinCircularImport || !!u.isWithinCircularImport;
      const kept = !was || u.timestamp > was.timestamp ? u : was;
      updates.set(key, circular ? { ...kept, isWithinCircularImport: true } : kept);
    }
  }
  const seenReloads = new Set<string>();
  const rest = sent.filter((args) => {
    const p = payload(args);
    if (p?.type === 'update') return false;
    if (p?.type !== 'full-reload') return true;
    const key = String(p.path);
    return !seenReloads.has(key) && !!seenReloads.add(key);
  });
  return [...(updates.size ? [[{ type: 'update', updates: [...updates.values()] }]] : []), ...rest];
}

export function createPublicationGate(opts: { root: string; ignored: (path: string) => boolean }) {
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  /** Releases that arrived before their hold (the editor stopped waiting for it): that hold is never opened. */
  const releasedEarly = new Set<string>();
  /** Watcher events waiting while a batch is held or settling, in the order the watcher sent them. */
  let buffer: Array<[string | symbol, ...unknown[]]> = [];
  /** Paths the waiting events name. */
  const seen = new Set<string>();
  /** Files a released batch changed that the watcher has not reported yet. */
  const expected = new Set<string>();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The waiting events may not be a whole batch: a hold ran out with the batch maybe still landing. The page is then
   * reloaded once they are handed over, rather than shown part of a batch.
   */
  let partial = false;
  /** Updates of files Vite was already working on when a batch was held: they go with that batch. */
  let waiting: Array<() => void> = [];
  /**
   * While the updates of handed-over events are gathered: how many of them are still on their way, the updates that
   * have arrived (theirs, and any other file's that arrives meanwhile), the holds they cover (every hold opened before
   * they were handed over), and whether the page is reloaded instead.
   */
  type Collecting = { due: number; ready: Array<() => void>; timer: ReturnType<typeof setTimeout>; covers: number; reload: boolean };
  let collecting: Collecting | null = null;
  /**
   * Which handing-over an update comes from: Vite works on each file asynchronously from the watcher's event, so the
   * event is handed over inside this context, and the file's update finds it there. An update Vite was already
   * working on when the batch was handed over, or one for a file the watcher reports meanwhile, is not one of them.
   */
  const handedOver = new AsyncLocalStorage<Collecting>();
  /** Holds opened so far, and how many of the first of them have reached the page. */
  let opened = 0;
  let delivered = 0;
  /** What waits for the holds opened before it to reach the page, in order. */
  const after: Array<{ fn: () => void; holds: number }> = [];
  /**
   * The batches whose revision has been sent to the pages, and the latest a page has said it shows. Counted apart from
   * the project's revision, which a restored file is sent again under.
   */
  let sentBatch = 0;
  let appliedBatch = 0;
  let server: GateServer | null = null;
  let emit: Emit | null = null;

  /**
   * A batch is held, released and waiting for files the watcher has not reported, or waiting for the batch before it
   * to reach the page: the watcher's events wait, in order, behind it.
   */
  const closed = () => holds.size > 0 || settleTimer !== null || buffer.length > 0;
  /** Nothing held, gathered or waiting to be sent. */
  const idle = () => !closed() && !collecting && !waiting.length && delivered >= opened && !after.length;

  function runAfter() {
    while (after.length && after[0].holds <= delivered) {
      try {
        after.shift()!.fn();
      } catch {
        // One failure never keeps the rest back.
      }
    }
  }

  /**
   * Run the updates Vite made of a batch's files with each environment's sends caught, then send them as one update
   * per environment, or have the page load the whole batch from disk when `reload`.
   */
  function sendReady(ready: Array<() => void>, reload: boolean) {
    const envs = Object.entries(server?.environments ?? {}).filter((e): e is [string, { hot: { send: Send } }] => !!e[1]?.hot);
    const sent = new Map<object, unknown[][]>();
    const sends = envs.map(([, env]) => {
      const own = env.hot.send;
      sent.set(env, []);
      env.hot.send = (...args: unknown[]) => void sent.get(env)!.push(args);
      return own;
    });
    try {
      for (const run of ready) run();
    } finally {
      envs.forEach(([, env], i) => (env.hot.send = sends[i]));
    }
    envs.forEach(([name, env], i) => {
      // Part of a batch is never applied to the page: it loads the whole batch from disk instead.
      const payloads = reload && name === 'client' ? [[RELOAD]] : mergeHotPayloads(sent.get(env)!);
      for (const args of payloads) {
        try {
          sends[i].apply(env.hot, args);
        } catch {
          // A page that cannot be told keeps what it shows.
        }
      }
    });
  }

  /** Every file of the released batches has been reported (or waited for long enough): hand the events to Vite. */
  function settle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    // One batch's updates at a time: the next waits for the page to get this one, and a batch held meanwhile joins.
    if (collecting || holds.size) return;
    const events = buffer;
    buffer = [];
    // A file the watcher has not reported (a change it dropped as a repeat of one just before, say) is reported
    // here, so Vite reads it again with the rest of the batch; it saying so later only repeats an update. One that is
    // there is reported as added: Vite then also retries what failed to import it, as for a new file.
    for (const abs of expected) {
      const event = existsSync(abs) ? 'add' : 'unlink';
      events.push([event, abs], ['all', event, abs]);
    }
    expected.clear();
    seen.clear();
    const reload = partial;
    partial = false;
    const due = events.filter(([event]) => typeof event === 'string' && UPDATE_EVENTS.has(event)).length;
    if (!due || !emit || !server) {
      if (emit) for (const args of events) emit(...args);
      if (waiting.length || reload) sendReady(waiting.splice(0), reload);
      delivered = opened;
      return runAfter();
    }
    const c: Collecting = { due, ready: waiting.splice(0), timer: setTimeout(() => ((c.reload = true), sendUpdates()), GATE_LIMITS.collectMs), covers: opened, reload };
    collecting = c;
    for (const args of events) {
      const event = args[0];
      if (typeof event === 'string' && UPDATE_EVENTS.has(event)) handedOver.run(c, () => emit!(...args));
      else emit(...args);
    }
  }

  function maybeSettle() {
    if (holds.size) return;
    if (!expected.size) return settle();
    settleTimer ??= setTimeout(() => settle(), GATE_LIMITS.settleMs);
  }

  /** Send what Vite made of the batch's files as one update per environment, then what waited for it. */
  function sendUpdates() {
    const c = collecting;
    if (!c) return;
    clearTimeout(c.timer);
    collecting = null;
    // A batch held meanwhile is landing: sent now, the page could fetch its files part way. This one goes with it.
    if (holds.size) {
      waiting.push(...c.ready);
      if (c.reload) partial = true;
      return;
    }
    sendReady(c.ready, c.reload);
    delivered = Math.max(delivered, c.covers);
    runAfter();
    // Events held for the next batch while this one was gathered, or a batch released with nothing to hand over.
    if (!holds.size) maybeSettle();
  }

  function release(id: string, files: string[]) {
    const timer = holds.get(id);
    if (timer === undefined) {
      releasedEarly.add(id);
      if (releasedEarly.size > 100) releasedEarly.delete(releasedEarly.values().next().value!);
      return;
    }
    clearTimeout(timer);
    holds.delete(id);
    for (const rel of files) {
      if (typeof rel !== 'string' || !rel) continue;
      const abs = join(opts.root, ...rel.split('/'));
      if (!opts.ignored(abs) && !seen.has(abs)) expected.add(abs);
    }
    maybeSettle();
  }

  return {
    /** Vite's `server.hotUpdateEnvironments`: holds each file's update while a batch's updates are gathered. */
    hotUpdateEnvironments(viteServer: unknown, hmr: Hmr): Promise<void> {
      const all = () => Promise.all(Object.values((viteServer as GateServer).environments).map((env) => hmr(env as never))).then(() => undefined);
      const c = collecting;
      if (!c && !closed()) return all();
      return new Promise<void>((resolve, reject) => {
        // Vite's hmr() sends synchronously when called, so every file's update is sent inside sendReady.
        const run = () => void all().then(resolve, reject);
        // Worked on since before a batch was held: sent now, the page could fetch files the batch is replacing.
        if (!c) return void waiting.push(run);
        c.ready.push(run);
        if (handedOver.getStore() === c && --c.due <= 0) sendUpdates();
      });
    },

    /** Take the server's watcher events through the gate. */
    attach(s: GateServer) {
      server = s;
      const own = s.watcher.emit.bind(s.watcher) as Emit;
      emit = own;
      s.watcher.emit = (event: string | symbol, ...args: unknown[]) => {
        if (typeof event === 'string' && FILE_EVENTS.has(event) && closed()) {
          buffer.push([event, ...args]);
          // 'all' names the event first, then the path.
          const path = event === 'all' ? args[1] : args[0];
          if (typeof path === 'string') {
            seen.add(path);
            if (expected.delete(path) && !expected.size) maybeSettle();
          }
          return true;
        }
        // A file a plugin reports while working on one handed over (a dependency it read): its update is due too.
        const c = collecting;
        if (c && typeof event === 'string' && UPDATE_EVENTS.has(event) && handedOver.getStore() === c) c.due++;
        return own(event, ...args);
      };
    },

    /** Hold the watcher's events until `release(id)`; a hold never released ends after GATE_LIMITS.holdMs. */
    hold(id: string) {
      if (holds.has(id) || releasedEarly.delete(id)) return;
      opened++;
      holds.set(
        id,
        setTimeout(() => {
          // Ran out with the batch maybe still landing: what it holds is not a whole batch.
          partial = true;
          release(id, []);
        }, GATE_LIMITS.holdMs)
      );
    },

    /** The batch is on disk: `files` (project-relative, `/`-separated) are the ones it wrote, removed or touched. */
    release,

    /** Run `fn` once every batch held so far has reached the page, or now when they all have. */
    afterBatch(fn: () => void) {
      after.push({ fn, holds: opened });
      runAfter();
    },

    /**
     * Send a revision to the pages with `send`, once every batch held so far has reached them. `send` is given the
     * batch's number, which a page hands back to `applied` once it shows the batch.
     */
    revision(send: (batch: number) => void) {
      this.afterBatch(() => send(++sentBatch));
    },

    /** A page says it shows `batch`. */
    applied(batch: number) {
      if (Number.isSafeInteger(batch) && batch <= sentBatch) appliedBatch = Math.max(appliedBatch, batch);
    },

    /**
     * Resolves once the batches before have reached the pages and a page shows their revision (or none is open to),
     * or after `capMs`: a new batch then replaces no file the page may still be fetching for the last one.
     */
    caughtUp(capMs: number, pages: () => number): Promise<void> {
      const end = Date.now() + capMs;
      return new Promise<void>((resolve) => {
        const look = () => {
          if ((idle() && (appliedBatch >= sentBatch || pages() === 0)) || Date.now() >= end) return resolve();
          setTimeout(look, GATE_LIMITS.pollMs);
        };
        look();
      });
    },

    /** Let everything through: the server is stopping. */
    close() {
      for (const timer of holds.values()) clearTimeout(timer);
      holds.clear();
      expected.clear();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      if (collecting) sendUpdates();
      const events = buffer;
      buffer = [];
      if (emit) for (const args of events) emit(...args);
      if (waiting.length) sendReady(waiting.splice(0), false);
      delivered = opened;
      runAfter();
    }
  };
}

export type PublicationGate = ReturnType<typeof createPublicationGate>;
