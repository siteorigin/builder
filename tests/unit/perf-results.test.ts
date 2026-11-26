import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import { changeMarkdown, changeTables, compareResults, median, noiseBand, summarize, summarizeCase, Trace, type CaseResult, type Iteration, type RunResult } from '../../scripts/perf/results';
import { chainFor, edit, launch } from '../../scripts/perf/scenarios';

let seq = 0;
const rec = (name: string, t: number, extra: Partial<PerfRecord> = {}): PerfRecord => ({ kind: 'mark', name, t, proc: 'main', pid: 1, seq: ++seq, ...extra });
const r = (name: string, t: number, extra: Partial<PerfRecord> = {}) => rec(name, t, { proc: 'renderer', pid: 2, ...extra });

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

const passed = (metrics: Record<string, { unit: 'ms' | 'count' | 'bytes'; values: number[] }>, fixtureHash = 'f1'): CaseResult => {
  const n = Object.values(metrics)[0].values.length;
  const iterations: Iteration[] = Array.from({ length: n }, (_, i) => ({ index: i + 1, ok: true, trace: `t${i}`, metrics: Object.fromEntries(Object.entries(metrics).map(([k, m]) => [k, { unit: m.unit, value: m.values[i] }])) }));
  return { scenario: 'edit', fixture: 'small', fixtureHash, status: 'passed', iterations, metrics: summarizeCase(iterations)! };
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

  it('call a duration inside three times the spread noise, and any change in a count a change', () => {
    const a = result([passed({ d: { unit: 'ms', values: [100, 104, 96] }, n: { unit: 'count', values: [9, 9, 9] } })]);
    const b = result([passed({ d: { unit: 'ms', values: [108, 112, 104] }, n: { unit: 'count', values: [10, 10, 10] } })]);
    const [c] = compareResults(a, b);
    const d = c.metrics.find((m) => m.metric === 'd')!;
    const n = c.metrics.find((m) => m.metric === 'n')!;
    expect(d).toMatchObject({ before: 100, after: 108, delta: 8, verdict: 'noise', noise: 12 });
    expect(n).toMatchObject({ delta: 1, verdict: 'changed', noise: 0 });
    expect(noiseBand(summarize('ms', [5, 5, 5]), summarize('ms', [5, 5, 5]))).toBe(1);
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
    expect(md).toContain('| edit.previewApplied | 200 ms | 201 ms | −0.3% (noise) |');
    expect(md).toContain('| Predicate | pass | pass | ok |');
  });
});

describe('benchmark scenarios', () => {
  it('run each scenario after the ones it follows', () => {
    expect(chainFor(['edit']).map((s) => s.name)).toEqual(['launch', 'open', 'edit']);
    expect(chainFor(['launch']).map((s) => s.name)).toEqual(['launch']);
    expect(chainFor(['edit', 'launch', 'open']).map((s) => s.name)).toEqual(['launch', 'open', 'edit']);
    expect(() => chainFor(['nope'])).toThrow('Unknown scenario');
  });

  it('time launch from the process being created', () => {
    const t = new Trace([
      rec('launch.processStart', 1000),
      rec('launch.mainLoaded', 1150),
      rec('launch.appReady', 1200),
      rec('launch.loadPacks', 1350, { kind: 'span', ms: 140 }),
      rec('launch.windowCreated', 1400, { c: { 'files.read': 40, 'files.hashed': 38 } }),
      rec('launch.readyToShow', 1600),
      r('launch.firstRender', 1620),
      r('launch.firstInteractive', 1640),
      r('launch.recentsShown', 1660, { c: { 'react.commits': 5 } }),
      rec('main.stall', 1300, { kind: 'span', ms: 80 })
    ]);
    const m = launch.measure(t);
    expect(m.missing).toEqual([]);
    expect(m.metrics['launch.windowCreated']).toEqual({ unit: 'ms', value: 400 });
    expect(m.metrics['launch.firstInteractive'].value).toBe(640);
    expect(m.metrics['launch.loadPacks'].value).toBe(140);
    expect(m.metrics['launch.filesHashedBeforeWindow']).toEqual({ unit: 'count', value: 38 });
    expect(m.metrics['launch.rendererCommits'].value).toBe(5);
    expect(m.metrics['launch.mainStallMax'].value).toBe(80);
  });

  function editTrace(opts: { drop?: string } = {}) {
    const all = [
      r('scenario.start', 9000, { attrs: { scenario: 'edit' }, c: { 'react.commits': 100 } }),
      rec('scenario.start', 9000, { attrs: { scenario: 'edit' } }),
      // An older revision's acknowledgement, before this edit: never taken for it.
      r('canvas.revisionApplied', 9005, { attrs: { revision: 4 } }),
      r('edit.requested', 10_000, { attrs: { revision: 4, operations: 1 }, c: { 'react.commits': 110 } }),
      rec('session.validateOperations', 10_010, { kind: 'span', ms: 1 }),
      rec('session.applyOperations', 10_012, { kind: 'span', ms: 2 }),
      rec('session.validateState', 10_020, { kind: 'span', ms: 5 }),
      rec('session.generate', 10_030, { kind: 'span', ms: 4, attrs: { variant: 'clean' } }),
      rec('session.generate', 10_034, { kind: 'span', ms: 3, attrs: { variant: 'dev' } }),
      rec('session.publish', 10_080, { kind: 'span', ms: 30, dc: { 'files.read': 1, 'files.hashed': 13, 'fs.writes': 5 } }),
      rec('runtime.release', 10_082),
      rec('session.persist', 10_100, { kind: 'span', ms: 70 }),
      rec('session.changed', 10_101, { attrs: { revision: 5 } }),
      rec('controller.snapshotSent', 10_105, { attrs: { revision: 5, bytes: 120_000 } }),
      rec('session.apply', 10_106, { kind: 'span', ms: 95, attrs: { revision: 5 } }),
      rec('controller.apply', 10_107, { kind: 'span', ms: 105, attrs: { revision: 5 }, dc: { 'fs.durableWrites': 9, 'fs.fsyncs': 19, 'fs.writes': 11 } }),
      r('renderer.snapshotReceived', 10_108, { attrs: { revision: 5 } }),
      r('renderer.commit', 10_115, { attrs: { revision: 5 } }),
      rec('runtime.published', 10_110, { attrs: { revision: 5 } }),
      r('canvas.revisionApplied', 10_140, { attrs: { revision: 5 } }),
      rec('session.reloadFromDisk', 10_500),
      rec('scenario.end', 11_640, { attrs: { scenario: 'edit' } }),
      r('scenario.end', 11_641, { attrs: { scenario: 'edit' }, c: { 'react.commits': 160 } })
    ];
    return new Trace(all.filter((x) => !(x.name === opts.drop && x.attrs?.revision === 5) && x.name !== `${opts.drop}!`));
  }

  it('time an edit from the editor sending it, by the revision it made', () => {
    const m = edit.measure(editTrace());
    expect(m.missing).toEqual([]);
    expect(m.metrics['edit.previewApplied']).toEqual({ unit: 'ms', value: 140 });
    expect(m.metrics['edit.rendererCommit'].value).toBe(115);
    expect(m.metrics['edit.generate'].value).toBe(7);
    expect(m.metrics['edit.publish'].value).toBe(30);
    expect(m.metrics['edit.apply'].value).toBe(105);
    expect(m.metrics['edit.durableWrites']).toEqual({ unit: 'count', value: 9 });
    expect(m.metrics['edit.publishFilesHashed'].value).toBe(13);
    expect(m.metrics['edit.snapshotBytes']).toEqual({ unit: 'bytes', value: 120_000 });
    expect(m.metrics['edit.reloadFromDisk'].value).toBe(1);
    expect(m.metrics['edit.rendererCommits'].value).toBe(50);
  });

  it('name a mark that is missing instead of reporting a time without it', () => {
    const m = edit.measure(editTrace({ drop: 'canvas.revisionApplied' }));
    expect(m.missing).toEqual(['canvas.revisionApplied']);
    expect(m.metrics['edit.previewApplied']).toBeUndefined();
    expect(edit.measure(editTrace({ drop: 'session.changed' })).missing).toEqual(['session.changed']);
  });
});
