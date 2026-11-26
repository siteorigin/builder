/**
 * The main process's timing marks (src/shared/perf.ts has the format; scripts/perf/README.md how they are used). On
 * only in the Electron main process, and only when SITEORIGIN_PERF_FILE names a file: anywhere else (a worker, a unit
 * test, a script) `perf` is the inert PERF_OFF, whose hooks do nothing and allocate nothing.
 *
 * Each record is one synchronous append of one complete line, so everything written survives the app being killed,
 * and nothing is buffered to flush at exit. A record that cannot be written is dropped: a trace never makes a save,
 * an open or a launch fail.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { serialize } from 'node:v8';
import { PERF_ENV, readSent, type PerfAttrs, type PerfProc, type PerfRecord } from '@shared/perf';

export interface Perf {
  readonly on: boolean;
  /** A point in time, now or (with `at`, epoch ms) earlier. */
  mark(name: string, attrs?: PerfAttrs, at?: number): void;
  /** Start a span; call what it returns once, when the span ends, with any attributes learned meanwhile. */
  span(name: string, attrs?: PerfAttrs): (more?: PerfAttrs) => void;
  /** Add to one of this process's counters. */
  count(name: string, by?: number): void;
  /** Write a record another process sent (the editor), once it is checked. False when it was not a record. */
  take(raw: unknown, from: { proc: PerfProc; pid: number }): boolean;
  /** Stop timers the trace started (the stall watch). */
  stop(): void;
}

const ENDED = () => {};
export const PERF_OFF: Perf = Object.freeze({ on: false, mark() {}, span: () => ENDED, count() {}, take: () => false, stop() {} });

export interface PerfSink {
  write(line: string): void;
  /** Epoch ms with sub-ms precision. */
  now(): number;
  pid: number;
  /** What the meta record says about the process. */
  meta?: PerfAttrs;
  /** Report main-process stalls of at least this many ms as `main.stall` spans; 0 turns the watch off. */
  stallMs?: number;
}

/** How often the stall watch looks at the event loop. */
const STALL_TICK_MS = 20;

export function createPerf(sink: PerfSink): Perf {
  const counters = new Map<string, number>();
  let seq = 0;
  const snapshot = () => (counters.size ? Object.fromEntries(counters) : undefined);
  const emit = (r: Omit<PerfRecord, 'seq'>) => {
    try {
      sink.write(JSON.stringify({ ...r, seq: ++seq }) + '\n');
    } catch {
      // A full disk or a removed folder costs the trace, never the work being timed.
    }
  };
  const base = { proc: 'main' as const, pid: sink.pid };
  emit({ t: sink.now(), kind: 'meta', name: 'perf.start', ...base, ...(sink.meta ? { attrs: sink.meta } : {}) });

  let watch: ReturnType<typeof setInterval> | null = null;
  if (sink.stallMs) {
    let last = sink.now();
    watch = setInterval(() => {
      const now = sink.now();
      const late = now - last - STALL_TICK_MS;
      last = now;
      if (late >= sink.stallMs!) {
        counters.set('main.stalls', (counters.get('main.stalls') ?? 0) + 1);
        emit({ t: now, kind: 'span', name: 'main.stall', ms: late, ...base });
      }
    }, STALL_TICK_MS);
    watch.unref?.();
  }

  return {
    on: true,
    mark(name, attrs, at) {
      const c = snapshot();
      emit({ t: at ?? sink.now(), kind: 'mark', name, ...base, ...(attrs ? { attrs } : {}), ...(c ? { c } : {}) });
    },
    span(name, attrs) {
      const started = sink.now();
      const before = new Map(counters);
      let ended = false;
      return (more) => {
        if (ended) return;
        ended = true;
        const t = sink.now();
        const dc: Record<string, number> = {};
        for (const [k, v] of counters) if (v !== (before.get(k) ?? 0)) dc[k] = v - (before.get(k) ?? 0);
        const all = attrs || more ? { ...attrs, ...more } : undefined;
        emit({ t, kind: 'span', name, ms: t - started, ...base, ...(all ? { attrs: all } : {}), ...(Object.keys(dc).length ? { dc } : {}) });
      };
    },
    count(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    take(raw, from) {
      const r = readSent(raw);
      if (!r) return false;
      emit({ ...r, proc: from.proc, pid: from.pid });
      return true;
    },
    stop() {
      if (watch) clearInterval(watch);
      watch = null;
    }
  };
}

/**
 * `fn` timed as the span `name`, with attributes from its result (undefined when it threw), while marks are on; `fn`
 * itself when they are off, so wrapping a hot path costs nothing then.
 */
export function timed<T>(name: string, fn: () => Promise<T>, attrs?: (result: T | undefined) => PerfAttrs, on: Perf = perf): () => Promise<T> {
  if (!on.on) return fn;
  return async () => {
    const end = on.span(name);
    let result: T | undefined;
    try {
      return (result = await fn());
    } finally {
      end(attrs?.(result));
    }
  };
}

/** Now, on the trace's clock (epoch ms with sub-ms precision). */
export const perfNow = () => performance.timeOrigin + performance.now();

/** The size of `payload` as IPC serializes it, or null when it cannot be told: sizing never fails what it measures. */
export function serializedSize(payload: unknown): number | null {
  try {
    return serialize(payload).byteLength;
  } catch {
    return null;
  }
}

/**
 * A writer appending to `file`, opened once: null when it cannot be opened without waiting, or is not a regular file (a
 * pipe nobody reads, a folder), so a trace never holds up the app. Each line is one write to a descriptor opened for
 * appending, so it lands whole even when the app is killed after it.
 */
export function openTraceSink(file: string): ((line: string) => void) | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NONBLOCK ?? 0), 0o644);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a file');
  } catch {
    closeSync(fd);
    return null;
  }
  return (line) => void writeSync(fd, line);
}

/** The trace file this process writes, or null when marks are off for it. */
export function perfFile(env: NodeJS.ProcessEnv = process.env, proc: { type?: string } = process as { type?: string }): string | null {
  const file = env[PERF_ENV];
  return file && proc.type === 'browser' ? file : null;
}

const file = perfFile();
const sink = file ? openTraceSink(file) : null;
/** This process's marks: PERF_OFF unless this is the Electron main process with SITEORIGIN_PERF_FILE naming a file it can write. */
export const perf: Perf = sink
  ? createPerf({
      write: sink,
      now: perfNow,
      pid: process.pid,
      meta: { platform: process.platform, arch: process.arch, electron: process.versions.electron ?? null, node: process.versions.node },
      stallMs: 50
    })
  : PERF_OFF;
