/**
 * Reading traces, summarising iterations and comparing two results (scripts/perf/README.md). Nothing here launches the
 * app: the runner (run.ts) and the compare command (compare.ts) share it, and the unit tests drive it on fixed input.
 */
import type { PerfRecord } from '../../src/shared/perf';

export type Unit = 'ms' | 'count' | 'bytes';

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
}

export interface CaseResult {
  scenario: string;
  fixture: string;
  fixtureHash: string;
  status: 'passed' | 'failed';
  iterations: Iteration[];
  /** Only when every iteration passed: a case that failed once has no timings at all. */
  metrics?: Record<string, Summary>;
}

export interface RunResult {
  schemaVersion: 1;
  createdAt: string;
  build: { commit: string | null; builtAt: string | null; fingerprint: string; head: string | null; dirty: boolean | null; appDir: string };
  machine: Record<string, string | number | null>;
  config: { iterations: number; scenarios: string[]; fixtures: string[]; settleMs: number; cold?: boolean };
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
        records.push(JSON.parse(line) as PerfRecord);
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
    if (value !== undefined && Number.isFinite(value)) this.metrics[name] = { unit: 'ms', value };
  }

  /** The time from `from` to `to`, when both are there. */
  since(name: string, from: PerfRecord | undefined, to: PerfRecord | undefined) {
    if (from && to) this.ms(name, to.t - from.t);
  }

  span(name: string, r: PerfRecord | undefined) {
    if (r) this.ms(name, r.ms);
  }

  count(name: string, value: number, unit: 'count' | 'bytes' = 'count') {
    this.metrics[name] = { unit, value };
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
// Comparing
// ---------------------------------------------------------------------------

/**
 * The band inside which a duration's change is not shown to be real: three times the larger spread (MAD) of the two
 * runs, and never under 10% of the before median or 1 ms. Two runs of the same build on a quiet machine stay inside it
 * (scripts/perf/README.md); five iterations alone understate the spread between runs. Counts and sizes have none: any
 * change in them is a change.
 */
export const NOISE_RULE = 'max(3 × MAD, 10%, 1 ms)';
export function noiseBand(a: Summary, b: Summary): number {
  return a.unit === 'ms' ? Math.max(1, 3 * Math.max(a.mad, b.mad), 0.1 * Math.abs(a.median)) : 0;
}

export interface MetricChange {
  metric: string;
  unit: Unit;
  before: number | null;
  after: number | null;
  delta: number | null;
  /** (after − before) / before × 100; null where before is 0 or either side is missing. */
  changePct: number | null;
  noise: number;
  /** `noise` for a duration that moved less than the band; `new` / `gone` for a metric on one side only. */
  verdict: 'same' | 'changed' | 'noise' | 'new' | 'gone';
}

export interface CaseChange {
  scenario: string;
  fixture: string;
  status: 'compared' | 'failed-before' | 'failed-after' | 'missing-before' | 'missing-after' | 'fixture-differs';
  metrics: MetricChange[];
}

export function compareMetric(metric: string, a: Summary | undefined, b: Summary | undefined): MetricChange {
  const unit = (a ?? b)!.unit;
  if (!a || !b) return { metric, unit, before: a?.median ?? null, after: b?.median ?? null, delta: null, changePct: null, noise: 0, verdict: a ? 'gone' : 'new' };
  const d = b.median - a.median;
  const noise = noiseBand(a, b);
  const changePct = a.median === 0 ? (b.median === 0 ? 0 : null) : (d / a.median) * 100;
  const verdict = d === 0 ? 'same' : unit === 'ms' && Math.abs(d) <= noise ? 'noise' : 'changed';
  return { metric, unit, before: a.median, after: b.median, delta: d, changePct, noise, verdict };
}

/** Every case of either result, metric by metric. */
export function compareResults(before: RunResult, after: RunResult): CaseChange[] {
  const key = (c: CaseResult) => `${c.scenario}\0${c.fixture}`;
  const a = new Map(before.cases.map((c) => [key(c), c]));
  const b = new Map(after.cases.map((c) => [key(c), c]));
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys.map((k) => {
    const x = a.get(k);
    const y = b.get(k);
    const [scenario, fixture] = k.split('\0');
    const status: CaseChange['status'] = !x ? 'missing-before' : !y ? 'missing-after' : x.status === 'failed' ? 'failed-before' : y.status === 'failed' ? 'failed-after' : x.fixtureHash !== y.fixtureHash ? 'fixture-differs' : 'compared';
    if (status !== 'compared') return { scenario, fixture, status, metrics: [] };
    const names = [...new Set([...Object.keys(x!.metrics ?? {}), ...Object.keys(y!.metrics ?? {})])].sort();
    return { scenario, fixture, status, metrics: names.map((n) => compareMetric(n, x!.metrics?.[n], y!.metrics?.[n])) };
  });
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function formatValue(value: number | null, unit: Unit): string {
  if (value === null || !Number.isFinite(value)) return '–';
  if (unit === 'ms') return `${value >= 100 ? Math.round(value).toLocaleString('en-US') : value.toFixed(1)} ms`;
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
      const rows = c.metrics.map((m) => [m.metric, formatValue(m.before, m.unit), formatValue(m.after, m.unit), m.delta === null ? '–' : formatValue(m.delta, m.unit), pct(m.changePct), m.unit === 'ms' ? `±${formatValue(m.noise, 'ms')}` : 'exact', m.verdict]);
      return `${title}\n${table(['metric', 'before', 'after', 'delta', 'change', 'noise', 'verdict'], rows)}`;
    })
    .join('\n\n');
}

/**
 * The comparison as Markdown, one table per case, in the form the optimize skill's pull requests carry: Improvement is
 * (before − after) / before, positive when the number fell, and a duration inside the noise band shows "(noise)".
 */
export function changeMarkdown(changes: CaseChange[], before: RunResult, after: RunResult): string {
  const signed = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
  const improvement = (m: MetricChange) => {
    if (m.before === null || m.after === null) return m.verdict;
    if (m.before === 0) return m.after === 0 ? '0.0%' : 'new';
    const v = ((m.before - m.after) / m.before) * 100;
    // A duration inside the noise band has not been shown to move: no percentage is claimed for it.
    return m.verdict === 'noise' ? '(noise)' : signed(v);
  };
  const m = after.machine;
  const profile = (r: RunResult) => (r.config.cold ? 'cold profile' : 'warm profile');
  const footer = [
    `Machine: ${m.cpu ?? '?'}, ${m.platform ?? '?'} ${m.osRelease ?? ''}`.trim() + ` · ${before.config.iterations} → ${after.config.iterations} iterations, 1 warm-up · ${profile(after)} · median · noise band ${NOISE_RULE}`,
    `Trees: ${before.build.commit ?? before.build.head ?? '?'} → ${after.build.commit ?? after.build.head ?? '?'}, both built with \`npm run build\``
  ].join('  \n');
  return changes
    .map((c) => {
      const head = `### ${c.scenario} · ${c.fixture}`;
      if (c.status !== 'compared') return `${head}\n\nNot compared: ${c.status}.`;
      const rows = c.metrics.map((m) => `| ${m.metric} | ${formatValue(m.before, m.unit)} | ${formatValue(m.after, m.unit)} | ${improvement(m)} |`);
      return `${head}\n\n| Metric | Before | After | Improvement |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n| Predicate | pass | pass | ok |\n\n${footer}`;
    })
    .join('\n\n');
}
