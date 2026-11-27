/**
 * The website tools check in a process of its own (tools-worker.ts, #961): npm's dependency resolver takes a while to
 * load and to work a lock out, and on the main process that held up everything the editor asked for meanwhile (the
 * New project dialog opening). One process answers one check at a time and stays a while for the next (the dialog's,
 * then the new project's own); it is started again when it has gone.
 */
import type { LockedPackage, ToolsAvailability } from './availability';

export interface ToolsCheckRequest {
  id: number;
  /** The npm whose resolver works the packages out: the one that installs them. */
  npmDir: string;
  /** The folder with the lock. */
  dir: string;
  /** The npm cache folder that npm will use. */
  cache: string;
  /** The caches a package counts as on this computer in. */
  caches: string[];
}

export type ToolsCheckReply = ({ id: number; ok: true; packages: LockedPackage[] } & ToolsAvailability) | { id: number; ok: false; error: string };

export type ToolsCheckResult = ToolsAvailability & { packages: LockedPackage[] };

/** The worker as the client uses it: an Electron UtilityProcess, or a stand-in in tests. */
export interface ToolsWorkerHandle {
  postMessage(m: ToolsCheckRequest): void;
  on(event: 'message', fn: (m: ToolsCheckReply) => void): unknown;
  on(event: 'exit' | 'error' | 'spawn', fn: () => void): unknown;
  kill(): boolean;
}

export interface ToolsChecker {
  /** One check; `signal` calls it off (the creation that asked was cancelled), whether it is under way or waiting. */
  check(req: Omit<ToolsCheckRequest, 'id'>, signal?: AbortSignal): Promise<ToolsCheckResult>;
  /** Drop the warm process when its project closes; a later check may start a new one. */
  release(): void;
  /** End the process now (the app is quitting): a check in progress, and any asked for from now on, fail. */
  stop(): void;
}

/** A check that got no answer: its process stopped, did not start, or took too long. */
class NoAnswer extends Error {}

export function createToolsChecker(spawn: () => ToolsWorkerHandle, opts: { timeoutMs?: number; idleMs?: number } = {}): ToolsChecker {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const idleMs = opts.idleMs ?? 60_000;
  let worker: ToolsWorkerHandle | null = null;
  let current: { id: number; settle: (r: ToolsCheckReply | null) => void } | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let ids = 0;
  let stopped = false;
  const kill = () => {
    const w = worker;
    worker = null;
    if (!w) return;
    try {
      // A process that has not started yet cannot be ended; end it as soon as it starts.
      if (!w.kill()) w.on('spawn', () => w.kill());
    } catch {
      // Already gone.
    }
  };
  const ensure = (): ToolsWorkerHandle => {
    if (worker) return worker;
    const w = spawn();
    worker = w;
    // Messages and exits from a process that has been replaced belong to no check.
    w.on('message', (m) => {
      if (worker === w && current && m?.id === current.id) current.settle(m);
    });
    w.on('exit', () => {
      if (worker !== w) return;
      worker = null;
      current?.settle(null);
    });
    w.on('error', () => {
      if (worker !== w) return;
      kill();
      current?.settle(null);
    });
    return w;
  };
  const ask = (req: Omit<ToolsCheckRequest, 'id'>, signal?: AbortSignal) =>
    new Promise<ToolsCheckResult>((resolve, reject) => {
      if (stopped) return reject(new Error('The website tools check was stopped.'));
      if (signal?.aborted) return reject(new Error('Canceled'));
      if (idle) clearTimeout(idle);
      idle = null;
      const id = ++ids;
      // Called off: this check gives up its answer, and the process, which may still be working it out, is left for
      // the next check (it answers each by its ID).
      const onAbort = () => current?.id === id && current.settle({ id, ok: false, error: 'Canceled' });
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        // A check that does not answer is ended with its process, so the next one starts afresh.
        kill();
        current?.settle(null);
      }, timeoutMs);
      current = {
        id,
        settle: (r) => {
          if (current?.id !== id) return;
          current = null;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (worker && !stopped) {
            idle = setTimeout(kill, idleMs);
            idle.unref?.();
          }
          if (r?.ok) resolve({ offline: r.offline, missing: r.missing, needed: r.needed, packages: r.packages });
          else reject(r ? new Error(r.error) : new NoAnswer('The website tools check stopped.'));
        }
      };
      try {
        ensure().postMessage({ id, ...req });
      } catch {
        kill();
        current.settle(null);
      }
    });
  return {
    check(req, signal) {
      // A check whose process stopped under it is asked once more of a new one, so a crash is no answer about the tools.
      const run = queue.then(() => ask(req, signal).catch((e) => (e instanceof NoAnswer && !stopped && !signal?.aborted ? ask(req, signal) : Promise.reject(e))));
      queue = run.catch(() => undefined);
      if (!signal) return run;
      // Called off while it waits its turn: given up at once, and passed over when its turn comes (ask, above).
      return new Promise<ToolsCheckResult>((resolve, reject) => {
        const onAbort = () => reject(new Error('Canceled'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    },
    release() {
      if (idle) clearTimeout(idle);
      idle = null;
      kill();
      if (current) current.settle({ id: current.id, ok: false, error: 'Canceled' });
    },
    stop() {
      stopped = true;
      if (idle) clearTimeout(idle);
      idle = null;
      kill();
      current?.settle(null);
    }
  };
}
