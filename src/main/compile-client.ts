/**
 * The main process's side of the compile workers: the files a build check must compile again are shared between a
 * few utility processes, which compile them at the same time, so checking a large site neither holds up the editor's
 * main process nor takes as long as one process would. Each worker starts with the first batch it is given and stops
 * once it has been idle for a while. A worker that fails, crashes or takes too long gives no outcomes for its share:
 * the check then compiles those files itself, so none is skipped and none answered from anything but its own source.
 */
import type { CompileFailure, CompileReply, CompileRequest } from './compile-file';

/** A worker process as the pool uses it: Electron's UtilityProcess, or a stand-in in tests. */
export interface CompileWorkerHandle {
  postMessage(message: CompileRequest): void;
  on(event: 'message', listener: (message: CompileReply) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  /** A fatal error in the worker (an exit follows), or the worker having started. */
  on(event: 'error' | 'spawn', listener: () => void): unknown;
  /** False when the process has not started yet, or has already ended. */
  kill(): boolean;
}

export interface CompiledBatch {
  /** Each file's outcome, in the order the files were given; undefined for a file no worker answered for. */
  outcomes: Array<CompileFailure | null | undefined>;
  /** The compiler runs made for the outcomes given. */
  runs: number;
}

export interface CompilePool {
  /** Compile `files` (`[path, source]`) in the workers. Never rejects. */
  compile(files: Array<[string, string]>): Promise<CompiledBatch>;
  /** Stop the workers for good (the app is quitting): a batch in flight or still to come is answered for no file. */
  stop(): void;
}

/**
 * A worker is used for each this many files of a batch, up to the pool's size: a check of a few changed files goes to
 * the first worker, already running, and a whole site's is shared between them all (a small site's too, whose first
 * check is the workers' cold start).
 */
export const FILES_PER_WORKER = 8;

interface Slot {
  worker: CompileWorkerHandle | null;
  current: { id: number; resolve: (reply: CompileReply | null) => void; timer: ReturnType<typeof setTimeout> } | null;
  /** Ends the worker once it has had nothing to do for the idle time. */
  idle: ReturnType<typeof setTimeout> | null;
}

export function createCompilePool(spawn: () => CompileWorkerHandle, opts: { size: number; timeoutMs?: number; idleMs?: number }): CompilePool {
  // A cold worker compiles a large site's thousand-odd builds in a few seconds; a slow machine gets far longer.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const idleMs = opts.idleMs ?? 60_000;
  const slots: Slot[] = Array.from({ length: Math.max(1, Math.floor(opts.size)) }, () => ({ worker: null, current: null, idle: null }));
  let nextId = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const settle = (slot: Slot, id: number, reply: CompileReply | null) => {
    if (slot.current?.id !== id) return;
    clearTimeout(slot.current.timer);
    const { resolve } = slot.current;
    slot.current = null;
    resolve(reply);
  };
  const kill = (slot: Slot) => {
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    const w = slot.worker;
    slot.worker = null;
    if (!w) return;
    try {
      // A process that has not started yet cannot be ended; end it as soon as it starts.
      if (!w.kill()) w.on('spawn', () => w.kill());
    } catch {
      // Already gone.
    }
  };
  const ensure = (slot: Slot): CompileWorkerHandle => {
    if (slot.worker) return slot.worker;
    const w = spawn();
    slot.worker = w;
    // Messages and exits from a worker that has been replaced belong to no batch.
    w.on('message', (m) => {
      if (slot.worker !== w || !slot.current || m.id !== slot.current.id) return;
      settle(slot, m.id, m);
    });
    w.on('exit', () => {
      if (slot.worker !== w) return;
      slot.worker = null;
      if (slot.current) settle(slot, slot.current.id, null);
    });
    // Unhandled, an 'error' event would be thrown in the main process.
    w.on('error', () => {
      if (slot.worker !== w) return;
      kill(slot);
      if (slot.current) settle(slot, slot.current.id, null);
    });
    return w;
  };
  const ask = (slot: Slot, files: Array<[string, string]>) =>
    new Promise<CompileReply | null>((resolve) => {
      if (slot.idle) clearTimeout(slot.idle);
      slot.idle = null;
      const id = ++nextId;
      slot.current = { id, resolve, timer: setTimeout(() => (kill(slot), settle(slot, id, null)), timeoutMs) };
      try {
        ensure(slot).postMessage({ id, files });
      } catch {
        kill(slot);
        settle(slot, id, null);
      }
    }).finally(() => {
      // Each worker keeps its own idle time: one that only a large check needed ends while the first goes on working.
      if (stopped || !slot.worker) return;
      slot.idle = setTimeout(() => {
        slot.idle = null;
        if (!slot.current) kill(slot);
      }, idleMs);
      slot.idle.unref?.();
    });
  const run = async (files: Array<[string, string]>): Promise<CompiledBatch> => {
    const outcomes: Array<CompileFailure | null | undefined> = new Array(files.length).fill(undefined);
    if (stopped || !files.length) return { outcomes, runs: 0 };
    // As few workers as keep each busy (the first ones, already running, before any other is started), the files
    // dealt out in turn so they get alike shares of a site's pages, entries and components.
    const n = Math.min(slots.length, Math.ceil(files.length / FILES_PER_WORKER));
    const parts = Array.from({ length: n }, () => [] as Array<[string, string]>);
    files.forEach((f, i) => parts[i % n].push(f));
    const replies = await Promise.all(parts.map((part, i) => ask(slots[i], part)));
    let runs = 0;
    for (let i = 0; i < n; i++) {
      const r = replies[i];
      // A worker that failed, or answered for other files than it was given, has said nothing about its share.
      if (!r || !r.ok || r.outcomes.length !== parts[i].length) continue;
      r.outcomes.forEach((o, j) => (outcomes[j * n + i] = o));
      runs += r.runs;
    }
    return { outcomes, runs };
  };

  return {
    compile(files) {
      const p = queue.then(() => run(files)).catch(() => ({ outcomes: new Array<undefined>(files.length).fill(undefined), runs: 0 }));
      queue = p;
      return p;
    },
    stop() {
      stopped = true;
      for (const s of slots) {
        const pending = s.current;
        kill(s);
        if (pending) settle(s, pending.id, null);
      }
    }
  };
}
