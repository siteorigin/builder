import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPerf, perf, PERF_OFF, perfFile, timed } from '../../src/main/perf';
import { PERF_ENV, readSent, type PerfRecord } from '../../src/shared/perf';

function memory(stallMs = 0) {
  const lines: string[] = [];
  let clock = 1000;
  const p = createPerf({ write: (l) => lines.push(l), now: () => clock, pid: 7, stallMs });
  return { p, lines, records: () => lines.map((l) => JSON.parse(l) as PerfRecord), tick: (ms: number) => (clock += ms) };
}

describe('timing marks', () => {
  it('are off outside the Electron main process, and when no file is named', () => {
    // The unit suite runs with marks off, like every launch without SITEORIGIN_PERF_FILE.
    expect(perf).toBe(PERF_OFF);
    expect(perf.on).toBe(false);
    expect(perfFile({ [PERF_ENV]: '/tmp/x.ndjson' }, { type: 'browser' })).toBe('/tmp/x.ndjson');
    expect(perfFile({}, { type: 'browser' })).toBeNull();
    expect(perfFile({ [PERF_ENV]: '' }, { type: 'browser' })).toBeNull();
    // A worker, a script or a test never writes, even with the variable set.
    expect(perfFile({ [PERF_ENV]: '/tmp/x.ndjson' }, { type: 'utility' })).toBeNull();
    expect(perfFile({ [PERF_ENV]: '/tmp/x.ndjson' }, {})).toBeNull();
  });

  it('do nothing when off, and wrapping a function with them returns the function itself', async () => {
    const fn = async () => 42;
    expect(timed('x', fn, undefined, PERF_OFF)).toBe(fn);
    PERF_OFF.mark('a');
    PERF_OFF.count('b');
    PERF_OFF.span('c')();
    expect(PERF_OFF.take({ kind: 'mark', name: 'x', t: 1 }, { proc: 'renderer', pid: 1 })).toBe(false);
  });

  it('write one complete line per record, numbered, with the counters marks carry and spans gained', () => {
    const { p, lines, records, tick } = memory();
    p.count('fs.writes');
    p.mark('first', { revision: 3 });
    const end = p.span('work', { kind: 'edit' });
    tick(25);
    p.count('fs.writes', 2);
    p.count('files.read');
    end({ ok: true });
    end({ ok: false });
    p.mark('backdated', undefined, 10);
    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    const [meta, first, work, backdated] = records();
    expect(meta).toMatchObject({ kind: 'meta', name: 'perf.start', proc: 'main', pid: 7, seq: 1 });
    expect(first).toMatchObject({ kind: 'mark', name: 'first', t: 1000, attrs: { revision: 3 }, c: { 'fs.writes': 1 }, seq: 2 });
    // Ended once: a second call is ignored. Its counters are what it gained, never their totals.
    expect(work).toMatchObject({ kind: 'span', name: 'work', ms: 25, t: 1025, attrs: { kind: 'edit', ok: true }, dc: { 'fs.writes': 2, 'files.read': 1 } });
    expect(backdated).toMatchObject({ name: 'backdated', t: 10, c: { 'fs.writes': 3, 'files.read': 1 } });
    expect(records()).toHaveLength(4);
  });

  it('time an async function as a span, also when it throws', async () => {
    const { p, records, tick } = memory();
    await expect(timed('ok', async () => (tick(5), 'done'), (r) => ({ got: r ?? null }), p)()).resolves.toBe('done');
    await expect(timed('bad', async () => { tick(2); throw new Error('no'); }, (r) => ({ got: r ?? null }), p)()).rejects.toThrow('no');
    const spans = records().filter((r) => r.kind === 'span');
    expect(spans.map((s) => [s.name, s.ms, s.attrs?.got])).toEqual([['ok', 5, 'done'], ['bad', 2, null]]);
  });

  it('write a record the editor sent only when it is well formed, as the editor’s', () => {
    const { p, records } = memory();
    expect(p.take({ kind: 'mark', name: 'canvas.ready', t: 1234.5, attrs: { revision: 4, mode: 'edit' }, c: { 'react.commits': 9 } }, { proc: 'renderer', pid: 99 })).toBe(true);
    for (const bad of [null, 'x', { kind: 'meta', name: 'a', t: 1 }, { kind: 'mark', name: 'Bad name', t: 1 }, { kind: 'mark', name: 'a', t: -1 }, { kind: 'span', name: 'a', t: 1 }, { kind: 'mark', name: 'a', t: 1, attrs: { deep: { x: 1 } } }, { kind: 'mark', name: 'a', t: 1, c: { n: 'many' } }])
      expect(p.take(bad, { proc: 'renderer', pid: 99 })).toBe(false);
    const sent = records().filter((r) => r.proc === 'renderer');
    expect(sent).toEqual([{ kind: 'mark', name: 'canvas.ready', t: 1234.5, attrs: { revision: 4, mode: 'edit' }, c: { 'react.commits': 9 }, proc: 'renderer', pid: 99, seq: 2 }]);
    expect(readSent({ kind: 'mark', name: 'a', t: 1, attrs: { s: 'x'.repeat(500) } })?.attrs?.s).toHaveLength(200);
  });

  it('never let a failed write reach the work being timed', () => {
    const p = createPerf({ write: () => { throw new Error('ENOSPC'); }, now: () => 1, pid: 1 });
    expect(() => p.mark('a')).not.toThrow();
    expect(() => p.span('b')()).not.toThrow();
  });

  it('report main-process stalls as spans', async () => {
    let clock = performance.now();
    const lines: string[] = [];
    const p = createPerf({ write: (l) => lines.push(l), now: () => clock, pid: 1, stallMs: 50 });
    try {
      // The watch looks every 20 ms; the clock jumping 200 ms between two looks is a stall of 180 ms.
      await new Promise((r) => setTimeout(r, 30));
      clock += 200;
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      p.stop();
    }
    const stalls = lines.map((l) => JSON.parse(l) as PerfRecord).filter((r) => r.name === 'main.stall');
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].ms).toBeGreaterThanOrEqual(150);
  });

  describe('a real file', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    it('is appended to, and nothing is written for a process with marks off', () => {
      dir = mkdtempSync(join(tmpdir(), 'perf-marks-'));
      const file = join(dir, 'trace.ndjson');
      const p = createPerf({ write: (l) => appendFileSync(file, l), now: () => 5, pid: 3 });
      p.mark('a');
      p.mark('b');
      expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).name)).toEqual(['perf.start', 'a', 'b']);
      const off = join(dir, 'off.ndjson');
      PERF_OFF.mark('a');
      expect(existsSync(off)).toBe(false);
    });
  });
});
