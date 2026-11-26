import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import { changeMarkdown, changeTables, compareMetric, compareResults, median, noiseBand, summarize, summarizeCase, Trace, type CaseResult, type Iteration, type RunResult } from '../../scripts/perf/results';

let seq = 0;
const rec = (name: string, t: number, extra: Partial<PerfRecord> = {}): PerfRecord => ({ kind: 'mark', name, t, proc: 'main', pid: 1, seq: ++seq, ...extra });

function result(cases: CaseResult[], iterations = 3): RunResult {
  return {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    build: { commit: 'abc1234', builtAt: null, fingerprint: 'sha256:x', head: 'abc1234', dirty: false, appDir: '/app' },
    machine: {},
    config: { iterations, scenarios: ['edit'], fixtures: ['small'], settleMs: 1500 },
    cases
  };
}

const passed = (metrics: Record<string, { unit: 'ms' | 'count' | 'bytes'; values: number[] }>, fixtureHash = 'f1', scenario = 'edit', fixture = 'small'): CaseResult => {
  const n = Object.values(metrics)[0].values.length;
  const iterations: Iteration[] = Array.from({ length: n }, (_, i) => ({ index: i + 1, ok: true, trace: `t${i}`, metrics: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, { unit: m.unit, value: m.values[i] }])) }));
  return { scenario, fixture, fixtureHash, status: 'passed', iterations, metrics: summarizeCase(iterations)! };
};

describe('benchmark results', () => {
  it('read a trace in event-time order, and say when a line was cut short', () => {
    const text = [JSON.stringify(rec('b', 20)), JSON.stringify(rec('a', 10)), '{"t":3'].join('\n');
    const t = Trace.parse(text);
    expect(t.records.map((x) => x.name)).toEqual(['a', 'b']);
    expect(t.incomplete).toBe(true);
    expect(Trace.parse(JSON.stringify(rec('a', 1)) + '\n').incomplete).toBe(false);
  });

  it('summarise with the median and the median absolute deviation', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(summarize('ms', [10, 12, 11, 30, 11])).toMatchObject({ n: 5, median: 11, min: 10, max: 30, mad: 1 });
  });

  it('never summarise a case with a failed iteration or a metric some iteration lacks', () => {
    const ok = (i: number, value: number): Iteration => ({ index: i, ok: true, trace: '', metrics: { x: { unit: 'ms', value } } });
    expect(summarizeCase([ok(1, 5), ok(2, 7)])?.x.median).toBe(6);
    expect(summarizeCase([ok(1, 5), { index: 2, ok: false, trace: '', error: { stage: 'edit', message: 'predicate: no heading' } }])).toBeNull();
    expect(summarizeCase([ok(1, 5), { index: 2, ok: true, trace: '', metrics: {} }])).toBeNull();
    expect(summarizeCase([])).toBeNull();
  });

  it('compare a result with itself as exactly zero for every metric', () => {
    const a = result([passed({ 'edit.previewApplied': { unit: 'ms', values: [140, 152, 147] }, 'edit.durableWrites': { unit: 'count', values: [9, 9, 9] }, 'edit.snapshotBytes': { unit: 'bytes', values: [120_000, 120_000, 120_000] } })]);
    const [c] = compareResults(a, a);
    expect(c.status).toBe('compared');
    for (const m of c.metrics) expect([m.delta, m.changePct, m.verdict]).toEqual([0, 0, 'same']);
  });

  it('call a duration inside three times the spread (and at least 10%) noise, and any change in a count a change', () => {
    const a = result([passed({ d: { unit: 'ms', values: [100, 104, 96] }, n: { unit: 'count', values: [9, 9, 9] } })]);
    const b = result([passed({ d: { unit: 'ms', values: [108, 112, 104] }, n: { unit: 'count', values: [10, 10, 10] } })]);
    const [c] = compareResults(a, b);
    const d = c.metrics.find((m) => m.metric === 'd')!;
    const n = c.metrics.find((m) => m.metric === 'n')!;
    expect(d).toMatchObject({ before: 100, after: 108, delta: 8, verdict: 'noise', noise: 12 });
    expect(n).toMatchObject({ delta: 1, verdict: 'changed', noise: 0 });
    expect(noiseBand(summarize('ms', [5, 5, 5]), summarize('ms', [5, 5, 5]))).toBe(1);
    // A steady metric still gets the 10% floor: five iterations understate the spread between two runs.
    expect(noiseBand(summarize('ms', [500, 500, 501]), summarize('ms', [540, 540, 540]))).toBe(50);
    const far = compareResults(a, result([passed({ d: { unit: 'ms', values: [60, 61, 59] }, n: { unit: 'count', values: [2, 2, 2] } })]))[0].metrics;
    expect(far.find((m) => m.metric === 'd')).toMatchObject({ verdict: 'changed', changePct: -40 });
  });

  it('say zero to zero is no change, and a count from zero is new', () => {
    const [c] = compareResults(result([passed({ z: { unit: 'count', values: [0, 0, 0] }, y: { unit: 'count', values: [0, 0, 0] } })]), result([passed({ z: { unit: 'count', values: [0, 0, 0] }, y: { unit: 'count', values: [3, 3, 3] } })]));
    expect(c.metrics.find((m) => m.metric === 'z')).toMatchObject({ changePct: 0, verdict: 'same' });
    expect(c.metrics.find((m) => m.metric === 'y')).toMatchObject({ changePct: null, delta: 3, verdict: 'changed' });
  });

  it('report a failed case as failed, not as timings, and refuse fixtures that differ', () => {
    const good = passed({ d: { unit: 'ms', values: [1, 2, 3] } });
    const failed: CaseResult = { ...good, status: 'failed', metrics: undefined, iterations: [{ index: 1, ok: false, trace: '', error: { stage: 'edit', message: 'predicate: the preview never showed the heading' } }] };
    expect(compareResults(result([good]), result([failed]))[0]).toMatchObject({ status: 'failed-after', metrics: [] });
    expect(compareResults(result([failed]), result([good]))[0].status).toBe('failed-before');
    expect(compareResults(result([good]), result([passed({ d: { unit: 'ms', values: [1, 2, 3] } }, 'f2')]))[0].status).toBe('fixture-differs');
    expect(compareResults(result([good]), result([]))[0].status).toBe('missing-after');
    expect(changeTables(compareResults(result([good]), result([failed])))).toContain('not compared (failed-after)');
  });

  it('print the pull request table with improvement positive when a number fell', () => {
    const a = result([passed({ 'edit.durableWrites': { unit: 'count', values: [16, 16, 16] }, 'edit.previewApplied': { unit: 'ms', values: [200, 201, 199] } })]);
    const b = result([passed({ 'edit.durableWrites': { unit: 'count', values: [2, 2, 2] }, 'edit.previewApplied': { unit: 'ms', values: [200.5, 201, 200] } })]);
    const md = changeMarkdown(compareResults(a, b), a, b);
    expect(md).toContain('### edit · small');
    expect(md).toContain('| Metric | Before | After | Improvement |');
    expect(md).toContain('| edit.durableWrites | 16 | 2 | 87.5% |');
    expect(md).toContain('| edit.previewApplied | 200 ms | 201 ms | (noise) |');
    expect(md).toContain('Trees: abc1234 → abc1234, both built with `npm run build`');
    expect(md).toContain('| Predicate | pass | pass | ok |');
  });
});

describe('benchmark results, at their edges', () => {
  const ok = (i: number, metrics: Record<string, number>): Iteration => ({ index: i, ok: true, trace: '', metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { unit: 'ms' as const, value: v }])) });

  it('never summarise a case whose failed iteration still has metrics, or whose iterations report different metrics', () => {
    const failedWithMetrics: Iteration = { ...ok(2, { x: 1 }), ok: false, error: { stage: 'edit', message: 'predicate: no heading' } };
    expect(summarizeCase([ok(1, { x: 5 }), failedWithMetrics])).toBeNull();
    expect(summarizeCase([ok(1, { x: 5 }), ok(2, { x: 6, y: 1 })])).toBeNull();
    expect(summarizeCase([ok(1, { x: 5, y: 1 }), ok(2, { x: 6, y: 2 })])).toMatchObject({ x: { median: 5.5, values: [5, 6] }, y: { median: 1.5 } });
  });

  it('take the larger spread of the two runs, inside the band and just past it', () => {
    const a = summarize('ms', [99, 100, 101]); // MAD 1
    const b = summarize('ms', [92, 100, 108]); // MAD 8
    expect(noiseBand(a, b)).toBe(24);
    expect(noiseBand(b, a)).toBe(24);
    const at = (median: number) => compareMetric('d', a, { ...b, median });
    expect(at(124).verdict).toBe('noise');
    expect(at(76).verdict).toBe('noise');
    expect(at(124.5).verdict).toBe('changed');
    expect(compareMetric('b', summarize('bytes', [100, 100]), summarize('bytes', [101, 101]))).toMatchObject({ verdict: 'changed', noise: 0, delta: 1 });
    expect(compareMetric('u', summarize('ms', [1]), summarize('count', [1])).verdict).toBe('incompatible');
  });

  it('show a metric on one side only as new or gone', () => {
    const [c] = compareResults(result([passed({ kept: { unit: 'count', values: [1] }, old: { unit: 'count', values: [2] } })]), result([passed({ kept: { unit: 'count', values: [1] }, fresh: { unit: 'ms', values: [3] } })]));
    expect(c.metrics.map((m) => [m.metric, m.verdict, m.before, m.after, m.delta, m.changePct])).toEqual([
      ['fresh', 'new', null, 3, null, null],
      ['kept', 'same', 1, 1, 0, 0],
      ['old', 'gone', 2, null, null, null]
    ]);
  });

  it('match cases by scenario and fixture together', () => {
    const before = result([passed({ m: { unit: 'count', values: [1] } }, 'f', 'open', 'small'), passed({ m: { unit: 'count', values: [2] } }, 'g', 'edit', 'large')]);
    const after = result([passed({ m: { unit: 'count', values: [5] } }, 'g', 'edit', 'large'), passed({ m: { unit: 'count', values: [1] } }, 'f', 'edit', 'small')]);
    const got = compareResults(before, after).map((c) => [c.scenario, c.fixture, c.status, c.metrics[0]?.delta ?? null]);
    expect(got).toEqual([
      ['open', 'small', 'missing-after', null],
      ['edit', 'large', 'compared', 3],
      ['edit', 'small', 'missing-before', null]
    ]);
  });

  it('refuse results measured differently', () => {
    const warm = result([passed({ d: { unit: 'ms', values: [1, 2, 3] } })]);
    const cold = { ...warm, config: { ...warm.config, cold: true } };
    const settled = { ...warm, config: { ...warm.config, settleMs: 0 } };
    expect(compareResults(warm, cold)[0]).toMatchObject({ status: 'protocol-differs', metrics: [] });
    expect(compareResults(warm, settled)[0].status).toBe('protocol-differs');
    // Counters that count different things (another version of their definitions) are not compared either.
    const counted = (n: number) => ({ ...warm, build: { ...warm.build, counters: n } });
    expect(compareResults(counted(1), counted(2))[0].status).toBe('protocol-differs');
    expect(compareResults(counted(1), counted(1))[0].status).toBe('compared');
    const elsewhere = { ...warm, machine: { cpu: 'Other CPU', platform: 'linux', osRelease: '6' } };
    expect(changeMarkdown(compareResults(warm, elsewhere), warm, elsewhere)).toContain('Durations are not comparable');
  });

  it('print a number that grew as a negative improvement, and an unmoved duration as noise', () => {
    const a = result([passed({ n: { unit: 'count', values: [4, 4, 4] }, d: { unit: 'ms', values: [50, 50, 50] } })]);
    const b = result([passed({ n: { unit: 'count', values: [5, 5, 5] }, d: { unit: 'ms', values: [50, 50, 50] } })]);
    const md = changeMarkdown(compareResults(a, b), a, b);
    expect(md).toContain('| n | 4 | 5 | −25.0% |');
    expect(md).toContain('| d | 50.0 ms | 50.0 ms | (noise) |');
  });

  it('keep a record’s sequence for equal times, and the records after a broken line', () => {
    const t = Trace.parse([JSON.stringify(rec('second', 5, { seq: 2 })), 'broken', JSON.stringify(rec('first', 5, { seq: 1 })), JSON.stringify(rec('later', 9))].join('\n'));
    expect(t.records.map((x) => x.name)).toEqual(['first', 'second', 'later']);
    expect(t.incomplete).toBe(true);
    // JSON that is not a record is as unreadable as a line cut short.
    const odd = Trace.parse(['null', '{"name":"x"}', '{"name":"x","t":1}', JSON.stringify(rec('kept', 1))].join('\n'));
    expect([odd.records.map((x) => x.name), odd.incomplete]).toEqual([['kept'], true]);
  });

  it('never print an improvement for a metric whose unit changed', () => {
    const a = result([passed({ x: { unit: 'ms', values: [100] } })]);
    const b = result([passed({ x: { unit: 'count', values: [2] } })]);
    expect(changeMarkdown(compareResults(a, b), a, b)).toContain('| x | 100 ms | 2 | incompatible (units differ) |');
  });
});
