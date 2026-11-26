import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import { changeMarkdown, changeTables, compareMetric, compareResults, median, memoryMetric, noiseBand, protocolDifference, summarize, summarizeCase, Trace, withAbsentRoles, type CaseResult, type Iteration, type RunResult, type Unit } from '../../scripts/perf/results';
import { MEMORY_PROTOCOL, type MemoryReading } from '../../scripts/perf/memory';

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

const passed = (metrics: Record<string, { unit: Unit; values: number[] }>, fixtureHash = 'f1', scenario = 'edit', fixture = 'small'): CaseResult => {
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

describe('memory in results', () => {
  const MiB = 2 ** 20;
  const unitOf = (name: string): Unit => (/\.processes(\.|$)/.test(name) ? 'count' : 'memory');
  const iteration = (metrics: Record<string, number>, index = 1): Iteration => ({ index, ok: true, trace: '', metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { unit: unitOf(k), value: v }])) });
  /** A memory case of `values` per metric (MiB for memory, plain numbers for counts), and the readings its iterations took. */
  const memoryCase = (metrics: Record<string, number[]>, labels: Array<[string, 'rest' | 'peak']> = []): CaseResult => {
    const n = Object.values(metrics)[0].length;
    const iterations = Array.from({ length: n }, (_, i) => ({
      ...iteration(Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, unitOf(k) === 'memory' ? v[i] * MiB : v[i]])), i + 1),
      memory: labels.map(([label, kind]) => ({ label, kind }) as MemoryReading)
    }));
    return { scenario: 'memory', fixture: 'small', fixtureHash: 'f1', status: 'passed', iterations, metrics: summarizeCase(withAbsentRoles(iterations))! };
  };

  it('know a memory metric’s reading and what it is of it', () => {
    expect(memoryMetric('memory.canvas.total')).toEqual({ reading: 'memory.canvas', field: 'total' });
    expect(memoryMetric('memory.canvas.processes')).toEqual({ reading: 'memory.canvas', field: 'processes' });
    expect(memoryMetric('memory.canvas.processes.media')).toEqual({ reading: 'memory.canvas', field: 'roleProcesses', role: 'media' });
    expect(memoryMetric('memory.open.peak.mem.devServer.esbuild')).toEqual({ reading: 'memory.open.peak', field: 'mem', role: 'devServer.esbuild' });
    // A role whose name holds a field's word keeps all of it.
    expect(memoryMetric('memory.canvas.mem.devServer.bytes.agent')).toEqual({ reading: 'memory.canvas', field: 'mem', role: 'devServer.bytes.agent' });
    expect(memoryMetric('memory.edits.growth.heap.main')).toEqual({ reading: 'memory.edits.growth', field: 'heap', role: 'main' });
    expect(memoryMetric('edit.previewApplied')).toBeNull();
    expect(memoryMetric('memory.canvas')).toBeNull();
  });

  it('count a role some launches lacked as none in those, and never fill a reading that was not taken', () => {
    const iterations = [
      iteration({ 'memory.canvas.total': 300, 'memory.canvas.processes': 2, 'memory.canvas.mem.main': 200, 'memory.canvas.processes.main': 1, 'memory.canvas.mem.media': 100, 'memory.canvas.processes.media': 1 }),
      iteration({ 'memory.canvas.total': 200, 'memory.canvas.processes': 1, 'memory.canvas.mem.main': 200, 'memory.canvas.processes.main': 1 })
    ];
    expect(summarizeCase(iterations)).toBeNull();
    const s = summarizeCase(withAbsentRoles(iterations))!;
    expect(s['memory.canvas.mem.media']).toMatchObject({ unit: 'memory', values: [100, 0], median: 50 });
    expect(s['memory.canvas.processes.media']).toMatchObject({ unit: 'count', values: [1, 0] });
    // The stored iterations are left as they were taken.
    expect(iterations[1].metrics!['memory.canvas.mem.media']).toBeUndefined();
    // A launch that did not take the reading at all fails the case: its total is missing, and nothing of it is filled in.
    const lacking = withAbsentRoles([iterations[0], iteration({ 'memory.welcome.total': 1 })]);
    expect(Object.keys(lacking[1].metrics!)).toEqual(['memory.welcome.total']);
    expect(summarizeCase(lacking)).toBeNull();
    // Nothing else is filled in.
    const timing: Iteration[] = [
      { index: 1, ok: true, trace: '', metrics: { 'edit.x': { unit: 'count', value: 1 }, 'memory.canvas.total': { unit: 'memory', value: 1 } } },
      { index: 2, ok: true, trace: '', metrics: { 'memory.canvas.total': { unit: 'memory', value: 1 } } }
    ];
    expect(withAbsentRoles(timing)[1].metrics!['edit.x']).toBeUndefined();
    expect(summarizeCase(withAbsentRoles(timing))).toBeNull();
  });

  it('judge memory against max(3 × MAD, 10%, 8 MiB), and process counts exactly', () => {
    const at = (mib: number[]) => summarize('memory', mib.map((v) => v * MiB));
    expect(noiseBand(at([200, 200, 200]), at([200]))).toBe(20 * MiB);
    expect(compareMetric('m', at([200, 200, 200]), at([220, 220, 220])).verdict).toBe('noise');
    expect(compareMetric('m', at([200, 200, 200]), [220 * MiB + 1].map((v) => summarize('memory', [v]))[0]).verdict).toBe('changed');
    expect(compareMetric('m', at([200, 200, 200]), [180 * MiB - 1].map((v) => summarize('memory', [v]))[0]).verdict).toBe('changed');
    // Small figures (a heap, a growth near zero) have the 8 MiB floor; a wide spread widens the band.
    expect(noiseBand(at([20]), at([20]))).toBe(8 * MiB);
    expect(compareMetric('m', at([0]), at([8])).verdict).toBe('noise');
    expect(compareMetric('m', at([-4]), at([5])).verdict).toBe('changed');
    expect(noiseBand(at([100, 115, 85]), at([100]))).toBe(45 * MiB);
    // The larger spread of the two, whichever side it is on, and 10% of a growth below zero.
    expect(noiseBand(at([100]), at([100, 115, 85]))).toBe(45 * MiB);
    expect(noiseBand(at([-200]), at([-200]))).toBe(20 * MiB);
    expect(compareMetric('n', summarize('count', [7, 7, 7]), summarize('count', [8, 8, 8]))).toMatchObject({ verdict: 'changed', noise: 0 });
  });

  it('compare a memory result with itself as no change, and a role on one side only as none on the other', () => {
    const a = result([memoryCase({ 'memory.canvas.total': [400, 402, 398], 'memory.canvas.processes': [2, 2, 2], 'memory.canvas.mem.main': [200, 201, 199], 'memory.canvas.processes.main': [1, 1, 1], 'memory.canvas.mem.editor': [200, 201, 199], 'memory.canvas.processes.editor': [1, 1, 1] })]);
    const self = compareResults(a, a)[0];
    expect([self.status, self.metrics.length]).toEqual(['compared', 6]);
    for (const m of self.metrics) expect([m.metric, m.delta, m.verdict]).toEqual([m.metric, 0, 'same']);
    const b = result([memoryCase({ 'memory.canvas.total': [430, 432, 428], 'memory.canvas.processes': [3, 3, 3], 'memory.canvas.mem.main': [200, 201, 199], 'memory.canvas.processes.main': [1, 1, 1], 'memory.canvas.mem.editor': [200, 201, 199], 'memory.canvas.processes.editor': [1, 1, 1], 'memory.canvas.mem.devServer.esbuild': [30, 30, 30], 'memory.canvas.processes.devServer.esbuild': [1, 1, 1] })]);
    const got = Object.fromEntries(compareResults(a, b)[0].metrics.map((m) => [m.metric, m]));
    expect(got['memory.canvas.mem.devServer.esbuild']).toMatchObject({ before: 0, after: 30 * MiB, verdict: 'changed' });
    expect(got['memory.canvas.processes.devServer.esbuild']).toMatchObject({ before: 0, after: 1, verdict: 'changed' });
    expect(got['memory.canvas.processes']).toMatchObject({ before: 2, after: 3, verdict: 'changed' });
    expect(got['memory.canvas.mem.main'].verdict).toBe('same');
    // The other way round, the role is gone to none.
    expect(Object.fromEntries(compareResults(b, a)[0].metrics.map((m) => [m.metric, m]))['memory.canvas.mem.devServer.esbuild']).toMatchObject({ before: 30 * MiB, after: 0, verdict: 'changed' });
  });

  it('refuse memory read differently, or from another source', () => {
    const with_ = (config: Partial<RunResult['config']>) => ({ ...result([memoryCase({ 'memory.canvas.total': [400] })]), config: { ...result([]).config, ...config } });
    const P = MEMORY_PROTOCOL;
    const b = with_({ memoryProtocol: P, memorySource: 'ps rss' });
    expect(protocolDifference(b, b)).toBeNull();
    expect(protocolDifference(b, with_({ memoryProtocol: P + 1, memorySource: 'ps rss' }))).toBe(`their memory was read differently (memory protocols ${P} and ${P + 1})`);
    expect(protocolDifference(result([]), b)).toBe(`their memory was read differently (memory protocols none and ${P})`);
    // Two results of a protocol this harness no longer reads are not compared with each other either.
    const old = with_({ memoryProtocol: P - 1, memorySource: 'ps rss' });
    expect(protocolDifference(old, old)).toBe(`their memory was read by memory protocol ${P - 1}, which this harness does not read (it reads ${P})`);
    const windows = with_({ memoryProtocol: P, memorySource: 'CIM WorkingSetSize' });
    expect(protocolDifference(b, windows)).toBe('their memory was read from different sources (ps rss and CIM WorkingSetSize)');
    expect(compareResults(b, windows)).toEqual([{ scenario: 'memory', fixture: 'small', status: 'protocol-differs', metrics: [] }]);
  });

  it('never read growth as a percentage of itself, and keep a timing table’s percentages as they were', () => {
    const grew = (v: number[]) => result([memoryCase({ 'memory.edits.growth.total': v, 'memory.edits.growth.processes': [0, 0, 0] })]);
    const [a, b] = [grew([-20, -20, -20]), grew([-5, -5, -5])];
    const change = compareResults(a, b)[0].metrics.find((m) => m.metric === 'memory.edits.growth.total')!;
    expect([change.delta, change.changePct, change.verdict]).toEqual([15 * MiB, null, 'changed']);
    expect(changeTables(compareResults(a, b))).toMatch(/memory\.edits\.growth\.total\s+-20\.0 MiB\s+-5\.0 MiB\s+15\.0 MiB\s+–\s+±8\.0 MiB\s+changed/);
    const md = changeMarkdown(compareResults(grew([10, 10, 10]), grew([-20, -20, -20])), grew([10, 10, 10]), grew([-20, -20, -20]));
    expect(md).toContain('| **All processes** | 0 | 10.0 MiB | -20.0 MiB | -30.0 MiB | changed |');
    // A count that is below zero in a timing case keeps its percentage.
    const x = result([passed({ 'edit.delta': { unit: 'count', values: [-5, -5, -5] } })]);
    const y = result([passed({ 'edit.delta': { unit: 'count', values: [-3, -3, -3] } })]);
    expect(changeMarkdown(compareResults(x, y), x, y)).toContain('| edit.delta | -5 | -3 | 40.0% |');
  });

  it('print a table per reading, a row per process, in the order the readings were taken, then each growth', () => {
    const labels: Array<[string, 'rest' | 'peak']> = [['welcome', 'rest'], ['open', 'peak'], ['canvas', 'rest']];
    const metrics = (main: number, preview: number[]) => ({
      'memory.welcome.total': [300, 300, 300],
      'memory.welcome.processes': [2, 2, 2],
      'memory.welcome.mem.main': [190, 190, 190],
      'memory.welcome.processes.main': [1, 1, 1],
      'memory.welcome.mem.editor': [110, 110, 110],
      'memory.welcome.processes.editor': [1, 1, 1],
      'memory.welcome.heap.main': [15, 15, 15],
      'memory.welcome.heap.editor': [14, 14, 14],
      'memory.open.peak.total': [700, 700, 700],
      'memory.open.peak.processes': [3, 3, 3],
      'memory.open.peak.mem.main': [main + 60, main + 60, main + 60],
      'memory.open.peak.processes.main': [1, 1, 1],
      'memory.canvas.total': [600, 600, 600],
      'memory.canvas.processes': [3, 3, 3],
      'memory.canvas.mem.main': [main, main, main],
      'memory.canvas.processes.main': [1, 1, 1],
      'memory.canvas.mem.preview': preview,
      'memory.canvas.processes.preview': preview.map((v) => (v ? 1 : 0)),
      'memory.close.growth.total': [-2, -2, -2],
      'memory.close.growth.processes': [0, 0, 0],
      'memory.close.growth.mem.main': [-2, -2, -2],
      'memory.close.growth.processes.main': [0, 0, 0]
    });
    const a = result([memoryCase(metrics(200, [170, 170, 170]), labels)]);
    // The after run took its readings in another order: the tables follow the before run's.
    const b = result([memoryCase({ ...metrics(240, [170, 172, 168]), 'memory.canvas.processes.main': [2, 2, 2] }, [...labels].reverse())]);
    const md = changeMarkdown(compareResults(a, b), a, b);
    expect(md).toContain('### memory · small');
    const order = ['#### welcome', '#### open.peak', '#### canvas', '#### close.growth'].map((h) => md.indexOf(h));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(md).toContain('| Process | Processes | Before | After | Change | Improvement |');
    expect(md).toContain('| main | 1 → 2 | 200.0 MiB | 240.0 MiB | +40.0 MiB | −20.0% |');
    expect(md).toContain('| preview | 1 | 170.0 MiB | 170.0 MiB | 0.0 MiB | (noise) |');
    expect(md).toContain('| **All processes** | 2 | 300.0 MiB | 300.0 MiB | 0.0 MiB | (noise) |');
    expect(md).toContain('| JS heap, main |  | 15.0 MiB | 15.0 MiB | 0.0 MiB | (noise) |');
    // Growth is read in MiB, not as a share of it.
    expect(md).toContain('| main | 0 | -2.0 MiB | -2.0 MiB | 0.0 MiB | (noise) |');
    expect(md).toContain('noise band max(3 × MAD, 10%, 8 MiB) for memory, process counts exact');
    expect(md).toContain('Predicate: pass → pass.');
    expect(md).not.toContain('| Metric | Before | After | Improvement |');
  });
});
