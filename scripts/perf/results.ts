/**
 * Reading traces, summarising iterations and comparing two results (scripts/perf/README.md). Nothing here launches the
 * app: the runner (run.ts) and the compare command (compare.ts) share it, and the unit tests drive it on fixed input.
 */
import type { PerfRecord } from '../../src/shared/perf';
import { MEMORY_PROTOCOL, readingPrefix, type MemoryReading } from './memory';

/**
 * `bytes` are sizes (IPC payloads, files), exact; `memory` is resident or heap memory, in bytes, with a noise band;
 * `share` is one duration as a fraction of another (0 to 1, shown as a percentage), with a noise band as durations have.
 */
export type Unit = 'ms' | 'count' | 'bytes' | 'memory' | 'share';

/** One iteration's value of a metric. */
export interface Measured {
  unit: Unit;
  value: number;
}

export interface Summary {
  unit: Unit;
  n: number;
  median: number;
  min: number;
  max: number;
  /** Median absolute deviation from the median. */
  mad: number;
  values: number[];
}

export interface Iteration {
  index: number;
  ok: boolean;
  /** The trace file, relative to the result file. */
  trace: string;
  metrics?: Record<string, Measured>;
  error?: { stage: string; message: string };
  /** A memory scenario's readings in full: every process with its role, and how each reading was taken. */
  memory?: MemoryReading[];
}

export interface CaseResult {
  scenario: string;
  fixture: string;
  fixtureHash: string;
  /** The starter template the fixture's website tools were installed from. */
  templateHash?: string;
  status: 'passed' | 'failed';
  iterations: Iteration[];
  /** Only when every iteration passed: a case that failed once has no timings at all. */
  metrics?: Record<string, Summary>;
}

export interface RunResult {
  schemaVersion: 1;
  createdAt: string;
  /** `counters`: what the app's counters count (PERF_COUNTERS_VERSION), as its trace said. */
  build: { commit: string | null; builtAt: string | null; fingerprint: string; head: string | null; dirty: boolean | null; appDir: string; counters?: number | null };
  machine: Record<string, string | number | null>;
  /** `memoryProtocol` and `memorySource`: how and from what memory was read (memory.ts), on a run of memory scenarios. */
  config: { iterations: number; scenarios: string[]; fixtures: string[]; settleMs: number; cold?: boolean; memoryProtocol?: number; memorySource?: string };
  cases: CaseResult[];
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/** A trace file's records, in event-time order. `incomplete` when a line could not be read (a write cut short). */
export class Trace {
  constructor(
    readonly records: PerfRecord[],
    readonly incomplete = false
  ) {}

  static parse(text: string): Trace {
    const records: PerfRecord[] = [];
    let incomplete = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as PerfRecord | null;
        // A line that is JSON but not a record is as unreadable as one cut short.
        if (r && typeof r === 'object' && typeof r.name === 'string' && typeof r.kind === 'string' && typeof r.proc === 'string' && typeof r.t === 'number' && Number.isFinite(r.t)) records.push(r);
        else incomplete = true;
      } catch {
        incomplete = true;
      }
    }
    records.sort((a, b) => a.t - b.t || a.seq - b.seq);
    return new Trace(records, incomplete);
  }

  /** Every record named `name` (and matching `where`) whose time is in [from, to]. */
  all(name: string, where: (r: PerfRecord) => boolean = () => true, from = -Infinity, to = Infinity): PerfRecord[] {
    return this.records.filter((r) => r.name === name && r.t >= from && r.t <= to && where(r));
  }

  /** The first such record, or undefined. */
  first(name: string, where?: (r: PerfRecord) => boolean, from?: number, to?: number): PerfRecord | undefined {
    return this.all(name, where, from, to)[0];
  }

  /** The build the trace came from, as the app stamped it. */
  build(): { commit: string | null; builtAt: string | null } {
    const r = this.first('launch.build');
    return { commit: (r?.attrs?.commit as string | null) ?? null, builtAt: (r?.attrs?.builtAt as string | null) ?? null };
  }
}

/** Records of one process. */
export const inProc =
  (proc: 'main' | 'renderer') =>
  (r: PerfRecord): boolean =>
    r.proc === proc;
/** Records of one scenario's boundary marks. */
export const forScenario =
  (scenario: string, proc: 'main' | 'renderer') =>
  (r: PerfRecord): boolean =>
    r.proc === proc && r.attrs?.scenario === scenario;
/** Records carrying a revision. */
export const atRevision =
  (revision: number) =>
  (r: PerfRecord): boolean =>
    r.attrs?.revision === revision;

/** A counter on a mark (cumulative), 0 when it never moved. */
export const counter = (r: PerfRecord | undefined, name: string): number => r?.c?.[name] ?? 0;
/** What a counter gained during a span. */
export const delta = (r: PerfRecord | undefined, name: string): number => r?.dc?.[name] ?? 0;

/**
 * Collects one iteration's metrics from a trace and the names of the records it needed but did not find. A metric
 * whose records are missing is left out, so a missing mark is never reported as a zero.
 */
export class Collector {
  readonly metrics: Record<string, Measured> = {};
  readonly missing: string[] = [];

  /** `record`, or a note that it was required and is not there. */
  need<T extends PerfRecord | undefined>(what: string, record: T): T {
    if (!record && !this.missing.includes(what)) this.missing.push(what);
    return record;
  }

  ms(name: string, value: number | undefined) {
    if (value === undefined) return;
    if (Number.isFinite(value)) this.metrics[name] = { unit: 'ms', value };
    else this.need(`${name} (a finite time)`, undefined);
  }

  /** The time from `from` to `to`, when both are there. */
  since(name: string, from: PerfRecord | undefined, to: PerfRecord | undefined) {
    if (from && to) this.ms(name, to.t - from.t);
  }

  span(name: string, r: PerfRecord | undefined) {
    if (!r) return;
    if (typeof r.ms !== 'number' || !Number.isFinite(r.ms)) this.need(`${r.name} (a span with a length)`, undefined);
    else this.ms(name, r.ms);
  }

  count(name: string, value: number, unit: 'count' | 'bytes' | 'memory' = 'count') {
    this.metrics[name] = { unit, value };
  }

  /** A fraction of one duration that another took (0 to 1). */
  share(name: string, value: number) {
    if (Number.isFinite(value)) this.metrics[name] = { unit: 'share', value };
    else this.need(`${name} (a finite share)`, undefined);
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarize(unit: Unit, values: number[]): Summary {
  const m = median(values);
  return { unit, n: values.length, median: m, min: Math.min(...values), max: Math.max(...values), mad: median(values.map((v) => Math.abs(v - m))), values };
}

/**
 * The case's summary of every metric, when every iteration passed and reported the same metrics; null otherwise. A
 * failure is never averaged away: a run that sometimes does less is not a faster run.
 */
export function summarizeCase(iterations: Iteration[]): Record<string, Summary> | null {
  if (!iterations.length || iterations.some((i) => !i.ok || !i.metrics)) return null;
  const names = [...new Set(iterations.flatMap((i) => Object.keys(i.metrics!)))].sort();
  const out: Record<string, Summary> = {};
  for (const name of names) {
    const got = iterations.map((i) => i.metrics![name]);
    if (got.some((g) => !g)) return null;
    out[name] = summarize(got[0].unit, got.map((g) => g.value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Memory metrics
// ---------------------------------------------------------------------------

/**
 * What a memory metric is (scripts/perf/memory.ts names them): its reading (`memory.canvas`, `memory.open.peak`,
 * `memory.edits.growth`), and whether it is the reading's total, its process count, one role's resident bytes or
 * process count, or a heap. Null for any other metric.
 */
export function memoryMetric(name: string): { reading: string; field: 'total' | 'processes' | 'mem' | 'roleProcesses' | 'heap'; role?: string } | null {
  const m = /^(memory\..+?)\.(?:(total)|(processes)|mem\.(.+)|processes\.(.+)|heap\.(.+))$/.exec(name);
  if (!m) return null;
  if (m[2]) return { reading: m[1], field: 'total' };
  if (m[3]) return { reading: m[1], field: 'processes' };
  if (m[4]) return { reading: m[1], field: 'mem', role: m[4] };
  if (m[5]) return { reading: m[1], field: 'roleProcesses', role: m[5] };
  return { reading: m[1], field: 'heap', role: m[6] };
}

/** A difference of two readings: signed, so never read as a percentage of itself. */
export const isGrowthMetric = (name: string) => !!memoryMetric(name)?.reading.endsWith('.growth');

const isRoleMetric = (name: string) => {
  const m = memoryMetric(name);
  return !!m && (m.field === 'mem' || m.field === 'roleProcesses');
};
/** Whether a role metric's reading was taken, in `metrics`: then a role missing from it had no process. */
const readingTaken = (metrics: Record<string, unknown> | undefined, name: string) => !!metrics?.[`${memoryMetric(name)!.reading}.total`];

/**
 * The iterations with every role any of them saw in a reading filled in as none (0 bytes, 0 processes) in those whose
 * same reading lacks it: a helper that ran in some launches and not others is a real difference, not a missing
 * measurement. A reading that was not taken at all is never filled: its total is missing too, and the case fails.
 */
export function withAbsentRoles(iterations: Iteration[]): Iteration[] {
  const roles = new Map<string, Unit>();
  for (const i of iterations) for (const [name, v] of Object.entries(i.metrics ?? {})) if (isRoleMetric(name)) roles.set(name, v.unit);
  if (!roles.size) return iterations;
  return iterations.map((i) => {
    if (!i.metrics) return i;
    const metrics = { ...i.metrics };
    for (const [name, unit] of roles) if (!metrics[name] && readingTaken(metrics, name)) metrics[name] = { unit, value: 0 };
    return { ...i, metrics };
  });
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/**
 * The band inside which a duration's change is not shown to be real: three times the larger spread (MAD) of the two
 * runs, and never under 10% of the before median or 1 ms. Two runs of the same build on a quiet machine stay inside it
 * (scripts/perf/README.md); five iterations alone understate the spread between runs. Counts and sizes have none: any
 * change in them is a change.
 */
export const NOISE_RULE = 'max(3 × MAD, 10%, 1 ms)';
/**
 * The band for memory (each process's figure, heaps, peaks and growth): three times the larger MAD, and never under 10%
 * of the before median or 8 MiB (scripts/perf/README.md says how it was arrived at). Process counts have none.
 */
export const MEMORY_NOISE_RULE = 'max(3 × MAD, 10%, 8 MiB)';
const MEMORY_FLOOR = 8 * 2 ** 20;
export function noiseBand(a: Summary, b: Summary): number {
  if (a.unit === 'ms') return Math.max(1, 3 * Math.max(a.mad, b.mad), 0.1 * Math.abs(a.median));
  if (a.unit === 'memory') return Math.max(MEMORY_FLOOR, 3 * Math.max(a.mad, b.mad), 0.1 * Math.abs(a.median));
  // A share moves with the durations it is made of: the same band, its floor one percentage point.
  if (a.unit === 'share') return Math.max(0.01, 3 * Math.max(a.mad, b.mad), 0.1 * Math.abs(a.median));
  return 0;
}
/** Units whose changes are judged against a noise band. */
const banded = (unit: Unit) => unit === 'ms' || unit === 'memory' || unit === 'share';

export interface MetricChange {
  metric: string;
  unit: Unit;
  before: number | null;
  after: number | null;
  delta: number | null;
  /** (after − before) / before × 100; null where before is 0 or either side is missing. */
  changePct: number | null;
  noise: number;
  /** The after side's unit, when it differs (an `incompatible` change). */
  afterUnit?: Unit;
  /** `noise` for a duration that moved less than the band; `new` / `gone` for a metric on one side only. */
  verdict: 'same' | 'changed' | 'noise' | 'new' | 'gone' | 'incompatible';
}

export interface CaseChange {
  scenario: string;
  fixture: string;
  status: 'compared' | 'failed-before' | 'failed-after' | 'missing-before' | 'missing-after' | 'fixture-differs' | 'protocol-differs';
  metrics: MetricChange[];
}

export function compareMetric(metric: string, a: Summary | undefined, b: Summary | undefined): MetricChange {
  const unit = (a ?? b)!.unit;
  if (!a || !b) return { metric, unit, before: a?.median ?? null, after: b?.median ?? null, delta: null, changePct: null, noise: 0, verdict: a ? 'gone' : 'new' };
  if (a.unit !== b.unit) return { metric, unit, afterUnit: b.unit, before: a.median, after: b.median, delta: null, changePct: null, noise: 0, verdict: 'incompatible' };
  const d = b.median - a.median;
  const noise = noiseBand(a, b);
  const changePct = isGrowthMetric(metric) ? null : a.median === 0 ? (b.median === 0 ? 0 : null) : (d / a.median) * 100;
  const verdict = d === 0 ? 'same' : banded(unit) && Math.abs(d) <= noise ? 'noise' : 'changed';
  return { metric, unit, before: a.median, after: b.median, delta: d, changePct, noise, verdict };
}

/** Why two results cannot be compared at all (they were measured differently), or null. */
export function protocolDifference(before: RunResult, after: RunResult): string | null {
  if (!!before.config.cold !== !!after.config.cold) return `one used a cold profile and the other a warm one`;
  if (before.config.settleMs !== after.config.settleMs) return `they waited ${before.config.settleMs} and ${after.config.settleMs} ms after each scenario`;
  const [a, b] = [before.build.counters ?? null, after.build.counters ?? null];
  if (a !== b) return `their counters count different things (counter versions ${a ?? 'unknown'} and ${b ?? 'unknown'})`;
  const [x, y] = [before.config.memoryProtocol ?? null, after.config.memoryProtocol ?? null];
  if (x !== y) return `their memory was read differently (memory protocols ${x ?? 'none'} and ${y ?? 'none'})`;
  if (x !== null && x !== MEMORY_PROTOCOL) return `their memory was read by memory protocol ${x}, which this harness does not read (it reads ${MEMORY_PROTOCOL})`;
  const [u, v] = [before.config.memorySource ?? null, after.config.memorySource ?? null];
  if (u !== v) return `their memory was read from different sources (${u ?? 'none'} and ${v ?? 'none'})`;
  return null;
}

/** How the machines two results were measured on differ, or null: their counts compare, their durations do not. */
export function machineDifference(before: RunResult, after: RunResult): string | null {
  const id = (r: RunResult) => `${r.machine.cpu ?? '?'} (${r.machine.platform ?? '?'} ${r.machine.osRelease ?? '?'})`;
  return id(before) === id(after) ? null : `measured on ${id(before)} and ${id(after)}`;
}

/** Every case of either result, metric by metric. Results measured differently compare nothing. */
export function compareResults(before: RunResult, after: RunResult): CaseChange[] {
  const protocol = protocolDifference(before, after);
  const key = (c: CaseResult) => `${c.scenario}\0${c.fixture}`;
  const a = new Map(before.cases.map((c) => [key(c), c]));
  const b = new Map(after.cases.map((c) => [key(c), c]));
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys.map((k) => {
    const x = a.get(k);
    const y = b.get(k);
    const [scenario, fixture] = k.split('\0');
    const status: CaseChange['status'] = !x ? 'missing-before' : !y ? 'missing-after' : x.status === 'failed' ? 'failed-before' : y.status === 'failed' ? 'failed-after' : x.fixtureHash !== y.fixtureHash ? 'fixture-differs' : protocol ? 'protocol-differs' : 'compared';
    if (status !== 'compared') return { scenario, fixture, status, metrics: [] };
    const names = [...new Set([...Object.keys(x!.metrics ?? {}), ...Object.keys(y!.metrics ?? {})])].sort();
    // A role in a reading of one side only had no process in that reading on the other: none, not missing.
    const side = (c: CaseResult, other: CaseResult, n: string): Summary | undefined => {
      const s = c.metrics?.[n];
      if (s || !isRoleMetric(n) || !readingTaken(c.metrics, n)) return s;
      const unit = other.metrics![n].unit;
      return summarize(unit, Array<number>(c.metrics![`${memoryMetric(n)!.reading}.total`].n).fill(0));
    };
    return { scenario, fixture, status, metrics: names.map((n) => compareMetric(n, side(x!, y!, n), side(y!, x!, n))) };
  });
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function formatValue(value: number | null, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) return '–';
  if (unit === 'ms') return `${value >= 100 ? Math.round(value).toLocaleString('en-US') : value.toFixed(1)} ms`;
  if (unit === 'share') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'memory') return `${(value / 2 ** 20).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MiB`;
  if (unit === 'bytes') return value >= 10_240 ? `${(value / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} KiB` : `${value} B`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

const pct = (v: number | null) => (v === null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

/** A plain table with its columns padded, for the terminal. */
export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** One case's summary as a terminal table. */
export function caseTable(c: CaseResult): string {
  const title = `${c.scenario} · ${c.fixture}`;
  if (c.status === 'failed') {
    const failed = c.iterations.filter((i) => !i.ok);
    return `${title}: FAILED (${failed.length} of ${c.iterations.length} iterations)\n${failed.map((i) => `  #${i.index} ${i.error?.stage ?? '?'}: ${i.error?.message ?? 'unknown'}`).join('\n')}`;
  }
  const rows = Object.entries(c.metrics ?? {}).map(([name, s]) => [name, formatValue(s.median, s.unit), formatValue(s.min, s.unit), formatValue(s.max, s.unit), formatValue(s.mad, s.unit)]);
  return `${title} (${c.iterations.length} iterations, all passed)\n${table(['metric', 'median', 'min', 'max', 'MAD'], rows)}`;
}

/** The comparison as terminal tables, one per case. */
export function changeTables(changes: CaseChange[]): string {
  return changes
    .map((c) => {
      const title = `${c.scenario} · ${c.fixture}`;
      if (c.status !== 'compared') return `${title}: not compared (${c.status})`;
      const rows = c.metrics.map((m) => [m.metric, formatValue(m.before, m.unit), formatValue(m.after, m.afterUnit ?? m.unit), m.delta === null ? '–' : formatValue(m.delta, m.unit), pct(m.changePct), banded(m.unit) ? `±${formatValue(m.noise, m.unit)}` : 'exact', m.verdict]);
      return `${title}\n${table(['metric', 'before', 'after', 'delta', 'change', 'noise', 'verdict'], rows)}`;
    })
    .join('\n\n');
}

/**
 * The comparison as Markdown, one table per case, in the form the optimize skill's pull requests carry: Improvement is
 * (before − after) / before, positive when the number fell, and a duration inside the noise band shows "(noise)". A
 * case with memory metrics has a table per reading instead, a row per process role, in the order the readings were
 * taken, then each growth.
 */
export function changeMarkdown(changes: CaseChange[], before: RunResult, after: RunResult): string {
  const signed = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
  const improvement = (m: MetricChange) => {
    if (m.before === null || m.after === null) return m.verdict;
    if (m.verdict === 'incompatible') return 'incompatible (units differ)';
    // A duration or a memory figure that did not move past the noise band has no percentage to defend.
    if (banded(m.unit) && (m.verdict === 'noise' || m.verdict === 'same')) return '(noise)';
    // Growth is signed: its change is read in MiB (or processes), never as a share of it.
    if (isGrowthMetric(m.metric)) return m.verdict;
    if (m.before === 0) return m.after === 0 ? '0.0%' : 'new';
    const v = ((m.before - m.after) / m.before) * 100;
    // A duration inside the noise band has not been shown to move: no percentage is claimed for it.
    return m.verdict === 'noise' ? '(noise)' : signed(v);
  };
  const m = after.machine;
  const profile = (r: RunResult) => (r.config.cold ? 'cold profile' : 'warm profile');
  const footer = (memory: boolean) =>
    [
      `Machine: ${m.cpu ?? '?'}, ${m.platform ?? '?'} ${m.osRelease ?? ''}`.trim() +
        ` · ${before.config.iterations} → ${after.config.iterations} iterations, 1 warm-up · ${profile(after)} · median · ${memory ? `noise band ${MEMORY_NOISE_RULE} for memory, process counts exact` : `noise band ${NOISE_RULE}`}`,
      `Trees: ${before.build.commit ?? before.build.head ?? '?'} → ${after.build.commit ?? after.build.head ?? '?'}, both built with \`npm run build\``,
      ...(machineDifference(before, after) ? [`${memory ? 'Memory figures' : 'Durations'} are not comparable: ${machineDifference(before, after)}.`] : [])
    ].join('  \n');
  const mib = (d: number | null) => (d === null ? '–' : `${d > 0 ? '+' : ''}${formatValue(d, 'memory')}`);
  const counts = (c: MetricChange | undefined) => (!c ? '' : c.before === c.after ? formatValue(c.before, 'count') : `${formatValue(c.before, 'count')} → ${formatValue(c.after, 'count')}`);
  /** The readings in the order the before run took them (its first iteration that has them), then the growths. */
  const order = (c: CaseChange) => (before.cases.find((x) => x.scenario === c.scenario && x.fixture === c.fixture)?.iterations.find((i) => i.memory?.length)?.memory ?? []).map(readingPrefix);
  const memoryTables = (c: CaseChange, metrics: MetricChange[]) => {
    const groups = new Map<string, MetricChange[]>();
    for (const x of metrics) {
      const reading = memoryMetric(x.metric)!.reading;
      groups.set(reading, [...(groups.get(reading) ?? []), x]);
    }
    const taken = order(c);
    const rank = (r: string) => (taken.includes(r) ? taken.indexOf(r) : taken.length);
    return [...groups.keys()]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((reading) => {
        const ms = groups.get(reading)!;
        const get = (field: string, role?: string) => ms.find((x) => memoryMetric(x.metric)!.field === field && memoryMetric(x.metric)!.role === role);
        const roles = [...new Set(ms.flatMap((x) => (memoryMetric(x.metric)!.field === 'mem' ? [memoryMetric(x.metric)!.role!] : [])))].sort();
        const row = (label: string, mem: MetricChange | undefined, n?: MetricChange) => `| ${label} | ${counts(n)} | ${formatValue(mem?.before ?? null, 'memory')} | ${formatValue(mem?.after ?? null, 'memory')} | ${mib(mem?.delta ?? null)} | ${mem ? improvement(mem) : '–'} |`;
        const rows = [
          ...roles.map((r) => row(r, get('mem', r), get('roleProcesses', r))),
          row('**All processes**', get('total'), get('processes')),
          ...['main', 'editor'].flatMap((h) => (get('heap', h) ? [row(`JS heap, ${h}`, get('heap', h))] : []))
        ];
        return `#### ${reading.replace(/^memory\./, '')}\n\n| Process | Processes | Before | After | Change | Improvement |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}`;
      })
      .join('\n\n');
  };
  return changes
    .map((c) => {
      const head = `### ${c.scenario} · ${c.fixture}`;
      if (c.status !== 'compared') return `${head}\n\nNot compared: ${c.status}.`;
      const memory = c.metrics.filter((x) => memoryMetric(x.metric));
      const others = c.metrics.filter((x) => !memoryMetric(x.metric));
      const rows = others.map((x) => `| ${x.metric} | ${formatValue(x.before, x.unit)} | ${formatValue(x.after, x.afterUnit ?? x.unit)} | ${improvement(x)} |`);
      if (!memory.length) return `${head}\n\n| Metric | Before | After | Improvement |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n| Predicate | pass | pass | ok |\n\n${footer(false)}`;
      const table = others.length ? `| Metric | Before | After | Improvement |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\n` : '';
      return `${head}\n\n${table}${memoryTables(c, memory)}\n\nPredicate: pass → pass.\n\n${footer(true)}`;
    })
    .join('\n\n');
}
