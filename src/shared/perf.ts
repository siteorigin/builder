/**
 * Timing marks for the performance harness (scripts/perf/README.md). With SITEORIGIN_PERF_FILE naming a file, the main
 * process appends one JSON record per line to it, its own and the editor's, which sends them over IPC. Off by default:
 * then no file is opened, no IPC channel is registered and every hook is a call to an empty function.
 *
 * Times are epoch milliseconds with sub-millisecond precision (`performance.timeOrigin + performance.now()`), taken in
 * the process the event happened in, so main and renderer records sit on one clock. A span is written once, when it
 * ends: `t` is its end and `ms` its length on that process's monotonic clock.
 *
 * Counters are kept per process and never reset. A mark carries every counter of its process as it stands (`c`), and
 * a span what each counter gained while it ran (`dc`), so a count over any window is the difference between two marks
 * of the same process, or a span's own delta.
 */

/** The environment variable that names the trace file; unset (or empty) turns marks off. */
export const PERF_ENV = 'SITEORIGIN_PERF_FILE';
/** The argument the editor window gets when marks are on, which tells its preload to offer the perf bridge. */
export const PERF_ARG = '--siteorigin-perf';
/**
 * What the counters count, as a version: raised whenever an existing counter starts counting something else (another
 * read site, another kind of write), so results whose counts mean different things are never compared.
 */
export const PERF_COUNTERS_VERSION = 1;
/** Where the main process exposes its perf hooks to a driver (`app.evaluate`), only when marks are on. */
export const PERF_GLOBAL = 'siteorigin.perf';

export type PerfValue = string | number | boolean | null;
export type PerfAttrs = Record<string, PerfValue>;
export type PerfProc = 'main' | 'renderer';

export interface PerfRecord {
  /** When it happened (a span's end), in epoch ms. */
  t: number;
  /** `meta` describes the process that wrote it, once at the start. */
  kind: 'meta' | 'mark' | 'span';
  name: string;
  proc: PerfProc;
  pid: number;
  /** The order records reached the file in, from 1. */
  seq: number;
  /** A span's length in ms. */
  ms?: number;
  attrs?: PerfAttrs;
  /** A mark's process counters, cumulative. */
  c?: Record<string, number>;
  /** What a span's process counters gained while it ran. */
  dc?: Record<string, number>;
}

/** What the editor sends for each of its records; the main process adds `proc`, `pid` and `seq`. */
export type PerfSent = Pick<PerfRecord, 't' | 'name' | 'ms' | 'attrs' | 'c'> & { kind: 'mark' | 'span' };

const NAME = /^[a-z][a-zA-Z0-9._:-]{0,99}$/;
const MAX_ATTRS = 16;
const MAX_COUNTERS = 32;

/** A mark or counter name: lowercase first, then letters, digits and `._:-`, at most 100 characters. */
export const perfName = (name: unknown): name is string => typeof name === 'string' && NAME.test(name);

/** The entries of a plain object of at most `max` keys, or null: anything else is refused before it is walked. */
function plainEntries(raw: unknown, max: number): Array<[string, unknown]> | null {
  if (!raw || typeof raw !== 'object') return null;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return null;
  const entries: Array<[string, unknown]> = [];
  for (const k in raw) {
    if (!Object.hasOwn(raw, k)) continue;
    if (entries.length === max) return null;
    entries.push([k, (raw as Record<string, unknown>)[k]]);
  }
  return entries;
}

function attrsOf(raw: unknown): PerfAttrs | undefined | null {
  if (raw === undefined) return undefined;
  const entries = plainEntries(raw, MAX_ATTRS);
  if (!entries) return null;
  const out: PerfAttrs = {};
  for (const [k, v] of entries) {
    if (!perfName(k)) return null;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) out[k] = v;
    else return null;
  }
  return out;
}

function countersOf(raw: unknown): Record<string, number> | undefined | null {
  if (raw === undefined) return undefined;
  const entries = plainEntries(raw, MAX_COUNTERS);
  if (!entries) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!perfName(k) || typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

/** A record the editor sent, as far as it is well formed; null when it is not one. */
export function readSent(raw: unknown): PerfSent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if ((r.kind !== 'mark' && r.kind !== 'span') || !perfName(r.name) || typeof r.t !== 'number' || !Number.isFinite(r.t) || r.t <= 0) return null;
  if (r.kind === 'span' ? typeof r.ms !== 'number' || !Number.isFinite(r.ms) || r.ms < 0 : r.ms !== undefined) return null;
  const attrs = attrsOf(r.attrs);
  const c = countersOf(r.c);
  if (attrs === null || c === null) return null;
  return { kind: r.kind, name: r.name, t: r.t, ...(r.kind === 'span' ? { ms: r.ms as number } : {}), ...(attrs ? { attrs } : {}), ...(c ? { c } : {}) };
}
