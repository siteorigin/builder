import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import { ATTACHED_PX, MARKER, markerTop, OUTLINE_INK, OUTLINE_REACH, OUTLINE_SELECT, OUTLINE_WHITE, outlineBottoms, readFrame, summarizeOffsets, type FrameReading, type Pixels, type ReadingGeometry, type Rgb } from '../../scripts/perf/outline';
import { compareResults, formatValue, noiseBand, summarize, summarizeCase, Trace, type CaseResult, type Iteration, type RunResult } from '../../scripts/perf/results';
import { chainFor, outlineScroll } from '../../scripts/perf/scenarios';
import { FIXTURES } from '../../scripts/perf/fixtures';

const PAGE: Rgb = [251, 250, 247];
const HOVER: Rgb = [20, 67, 124];

/** A frame `width` × `height` of the page's colour, with `paint` drawing rows of a column range. */
function frame(width: number, height: number, paint: (put: (x0: number, x1: number, y: number, c: Rgb) => void) => void): Pixels {
  const data = new Uint8Array(width * height * 4);
  const put = (x0: number, x1: number, y: number, c: Rgb) => {
    for (let x = x0; x < x1; x++) data.set([...c, 255], (y * width + x) * 4);
  };
  for (let y = 0; y < height; y++) put(0, width, y, PAGE);
  paint(put);
  return { width, height, channels: 4, data };
}
/** The selection outline's bottom keylines ending above row `bottom`, `k` device rows per CSS pixel. */
function outlineBottom(put: (x0: number, x1: number, y: number, c: Rgb) => void, x0: number, x1: number, bottom: number, k = 1) {
  const rows: Rgb[] = [OUTLINE_WHITE, OUTLINE_SELECT, OUTLINE_SELECT, OUTLINE_INK];
  rows.forEach((c, i) => {
    for (let j = 0; j < k; j++) put(x0, x1, bottom - (4 - i) * k + j, c);
  });
}
function marker(put: (x0: number, x1: number, y: number, c: Rgb) => void, x0: number, x1: number, top: number, height: number) {
  for (let y = top; y < top + height; y++) put(x0, x1, y, MARKER);
}

describe('reading the outline and its element off a drawn frame', () => {
  it('finds a selection outline’s bottom edge by its keylines, at any device pixel ratio', () => {
    const one = frame(20, 100, (put) => outlineBottom(put, 0, 20, 50));
    expect(outlineBottoms(one, 5, 0, 100, 1)).toEqual([50]);
    const two = frame(20, 200, (put) => outlineBottom(put, 0, 20, 120, 2));
    expect(outlineBottoms(two, 5, 0, 200, 2)).toEqual([120]);
    // Two outlines (one trailing the other) are both found.
    const both = frame(20, 100, (put) => {
      outlineBottom(put, 0, 20, 40);
      outlineBottom(put, 0, 20, 70);
    });
    expect(outlineBottoms(both, 5, 0, 100, 1)).toEqual([40, 70]);
  });

  it('finds an outline drawn between pixels by the middle of its blended keylines', () => {
    // The keylines (white, the colour, ink) over the page, their bottom edge `edge` rows down, each row the average
    // of what covers it: as a ring drawn in a page that sits a fraction of a pixel off the grid comes out.
    const blended = (edge: number) =>
      frame(20, 100, (put) => {
        const layers: Array<[number, number, Rgb]> = [[edge - 4, edge - 3, OUTLINE_WHITE], [edge - 3, edge - 1, OUTLINE_SELECT], [edge - 1, edge, OUTLINE_INK]];
        for (let y = Math.floor(edge) - 6; y < Math.ceil(edge) + 2; y++) {
          const c = [0, 0, 0];
          let covered = 0;
          for (const [a, b, rgb] of layers) {
            const part = Math.max(0, Math.min(b, y + 1) - Math.max(a, y));
            covered += part;
            rgb.forEach((v, i) => (c[i] += v * part));
          }
          put(0, 20, y, c.map((v, i) => Math.round(v + PAGE[i] * (1 - covered))) as unknown as Rgb);
        }
      });
    for (const edge of [50.3, 50.5, 50.7, 61.2]) {
      const got = outlineBottoms(blended(edge), 5, 0, 100, 1);
      expect(got).toHaveLength(1);
      expect(Math.abs(got[0] - edge)).toBeLessThan(0.3);
    }
    // Between two whole pixels the blends move the edge with it, not to either pixel.
    const [a] = outlineBottoms(blended(50.25), 5, 0, 100, 1);
    const [b] = outlineBottoms(blended(50.75), 5, 0, 100, 1);
    expect(b - a).toBeGreaterThan(0.25);
  });

  it('reads blended keylines at two device pixels a CSS pixel', () => {
    // Each keyline twice as tall, the edge between device pixels.
    const img = frame(20, 200, (put) => {
      const edge = 120.5;
      const layers: Array<[number, number, Rgb]> = [[edge - 8, edge - 6, OUTLINE_WHITE], [edge - 6, edge - 2, OUTLINE_SELECT], [edge - 2, edge, OUTLINE_INK]];
      for (let y = 108; y < 124; y++) {
        const c = [0, 0, 0];
        let covered = 0;
        for (const [lo, hi, rgb] of layers) {
          const part = Math.max(0, Math.min(hi, y + 1) - Math.max(lo, y));
          covered += part;
          rgb.forEach((v, i) => (c[i] += v * part));
        }
        put(0, 20, y, c.map((v, i) => Math.round(v + PAGE[i] * (1 - covered))) as unknown as Rgb);
      }
    });
    const [got] = outlineBottoms(img, 5, 0, 200, 2);
    expect(Math.abs(got - 120.5)).toBeLessThan(0.3);
  });

  it('takes nothing else for the outline: a hover’s hairline, its top edge, a field of the colour, or rows out of range', () => {
    const hover = frame(20, 100, (put) => {
      put(0, 20, 40, OUTLINE_WHITE);
      put(0, 20, 41, HOVER);
    });
    expect(outlineBottoms(hover, 5, 0, 100, 1)).toEqual([]);
    const top = frame(20, 100, (put) => [OUTLINE_INK, OUTLINE_SELECT, OUTLINE_SELECT, OUTLINE_WHITE].forEach((c, i) => put(0, 20, 30 + i, c)));
    expect(outlineBottoms(top, 5, 0, 100, 1)).toEqual([]);
    const field = frame(20, 100, (put) => {
      for (let y = 20; y < 60; y++) put(0, 20, y, OUTLINE_SELECT);
      put(0, 20, 60, OUTLINE_INK);
    });
    expect(outlineBottoms(field, 5, 0, 100, 1)).toEqual([]);
    const outside = frame(20, 100, (put) => outlineBottom(put, 0, 20, 50));
    expect(outlineBottoms(outside, 5, 60, 100, 1)).toEqual([]);
  });

  it('finds a marker’s first row, and the element’s edge from the marker an overlay left whole', () => {
    const img = frame(30, 200, (put) => {
      marker(put, 0, 10, 100, 30);
      marker(put, 10, 20, 120, 30);
      marker(put, 20, 30, 140, 30);
      // An outline drawn over the first marker's first rows, and a hover's hairline over the second's.
      outlineBottom(put, 0, 10, 104);
      put(10, 20, 120, OUTLINE_WHITE);
      put(10, 20, 121, HOVER);
    });
    expect(markerTop(img, 5, 0, 200)).toBe(104);
    expect(markerTop(img, 15, 0, 200)).toBe(122);
    expect(markerTop(img, 25, 0, 200)).toBe(140);
    expect(markerTop(img, 25, 150, 200)).toBe(150);
    expect(markerTop(img, 25, 171, 200)).toBeNull();
    const geo: ReadingGeometry = { dpr: 1, outlineX: 5, markers: [{ x: 5, below: 0 }, { x: 15, below: 20 }, { x: 25, below: 40 }], top: 0, bottom: 200 };
    expect(readFrame(img, geo, 7)).toEqual({ t: 7, element: 100, outlines: [104] });
    // The selection colour far from the element's edge is not its outline.
    const far = frame(30, 400, (put) => {
      marker(put, 0, 10, 100, 30);
      outlineBottom(put, 0, 10, 104);
      outlineBottom(put, 0, 10, 104 + OUTLINE_REACH + 50);
    });
    expect(readFrame(far, { ...geo, bottom: 400 }, 0).outlines).toEqual([104]);
    // In CSS pixels at two device pixels each.
    const two = frame(30, 200, (put) => {
      marker(put, 0, 10, 100, 30);
      outlineBottom(put, 20, 30, 108, 2);
    });
    expect(readFrame(two, { dpr: 2, outlineX: 12.5, markers: [{ x: 2.5, below: 0 }], top: 0, bottom: 100 }, 0)).toEqual({ t: 0, element: 50, outlines: [54] });
  });
});

/** Frames 10 ms apart (a 10 ms frame period) with the element and outline at these places. */
const frames = (rows: Array<[number | null, number[]]>): FrameReading[] => rows.map(([element, outlines], i) => ({ t: i * 10, element, outlines }));

describe('summing up a scroll’s frames', () => {
  it('measures an outline a frame behind a moving element', () => {
    // The element moves 12 px a frame for four frames; the outline is where it was the frame before, then catches up.
    const s = summarizeOffsets(frames([[100, [100]], [88, [100]], [76, [88]], [64, [76]], [52, [64]], [52, [52]]]), 10);
    expect(s).toMatchObject({ frames: 6, moving: 4, offsetPx: 12, trailing: 4, speedPx: 12, restBefore: 0, restAfter: 0, unread: 0 });
    expect(s.lagFrames).toBeCloseTo(1);
  });

  it('measures an outline that keeps up as attached, and one shown twice by the one that trails', () => {
    const kept = summarizeOffsets(frames([[100, [100]], [88, [88]], [76, [76]], [88, [88]], [100, [100]]]), 10);
    expect(kept).toMatchObject({ moving: 4, offsetPx: 0, lagFrames: 0, trailing: 0 });
    // Two outlines in one frame: the one off the element is what is seen trailing.
    const twice = summarizeOffsets(frames([[100, [100]], [88, [88, 100]], [76, [64, 76]], [76, [76]]]), 10);
    expect(twice).toMatchObject({ moving: 2, offsetPx: 12, trailing: 2 });
    // Within the 1.5 px an outline may be off, it is on its element.
    const near = summarizeOffsets(frames([[100, [100]], [88, [89.2]], [76, [75]]]), 10);
    expect(near).toMatchObject({ lagFrames: 0, trailing: 0 });
    expect(near.offsetPx).toBeCloseTo(1.1);
  });

  it('counts a frame with no outline or no element as unread, and the steps between frames as speed per period', () => {
    const s = summarizeOffsets(frames([[100, [100]], [80, []], [null, [80]], [80, [80]]]), 10);
    expect(s.unread).toBe(2);
    // Two periods between frames 20 px apart: 10 px a period.
    expect(summarizeOffsets([{ t: 0, element: 100, outlines: [100] }, { t: 20, element: 80, outlines: [100] }], 10)).toMatchObject({ speedPx: 10, offsetPx: 20 });
    // Where the element was between two frames is worked out along its path: half a frame behind a 24 px step.
    expect(summarizeOffsets(frames([[100, [100]], [76, [88]]]), 10).lagFrames).toBeCloseTo(0.5);
    // Not from before it turned back: an outline where it was on the way down says nothing of the way up. (On the way
    // up, one frame on it and one half a frame behind: a median of a quarter.)
    expect(summarizeOffsets(frames([[100, [100]], [88, [88]], [100, [94]]]), 10).lagFrames).toBeCloseTo(0.25);
    // Up from 76 to 88, the outline at 94, where the element was only on the way down: no lag, not a third of a frame.
    expect(summarizeOffsets(frames([[100, [100]], [76, []], [88, [94]]]), 10).lagFrames).toBeNaN();
    // An outline ahead of its element was never where the element had been: no lag for it.
    expect(summarizeOffsets(frames([[100, [100]], [88, [80]]]), 10).lagFrames).toBeNaN();
    expect(ATTACHED_PX).toBe(1.5);
  });
});

describe('the outlineScroll scenario', () => {
  let seq = 0;
  const r = (name: string, t: number, extra: Partial<PerfRecord> = {}): PerfRecord => ({ kind: 'mark', name, t, proc: 'renderer', pid: 2, seq: ++seq, ...extra });
  const facts = { spec: FIXTURES.large, pages: 3, entries: 0, assets: 0, projectComponents: 0, homePageId: 'pg', homeRoute: '/', heroId: 'n', heading: 'h' };
  const read = { scenario: 'outlineScroll', edge: 'read', frames: 80, moving: 48, offsetPx: 11.5, lagFrames: 1.02, trailing: 46, speedPx: 12, restBefore: 0, restAfter: 0.3, unread: 0 };
  const trace = (drop?: (x: PerfRecord) => boolean) =>
    new Trace(
      [
        r('scenario.start', 100, { attrs: { scenario: 'outlineScroll', periodMs: 16.7 } }),
        // A first attempt a reload disturbed, done again.
        r('outlineScroll.window', 200, { attrs: { scenario: 'outlineScroll', edge: 'start', attempt: 1 }, c: { 'canvas.rectReports': 1, 'canvas.renders': 1, 'react.commits': 1 } }),
        r('outlineScroll.window', 900, { attrs: { scenario: 'outlineScroll', edge: 'end', attempt: 1 }, c: { 'canvas.rectReports': 99, 'canvas.renders': 99, 'react.commits': 99 } }),
        r('outlineScroll.read', 1000, { attrs: { ...read, attempt: 1, offsetPx: 99 } }),
        r('outlineScroll.window', 2000, { attrs: { scenario: 'outlineScroll', edge: 'start', attempt: 2 }, c: { 'canvas.rectReports': 100, 'canvas.renders': 200, 'react.commits': 300 } }),
        r('outlineScroll.window', 4100, { attrs: { scenario: 'outlineScroll', edge: 'end', attempt: 2 }, c: { 'canvas.rectReports': 148, 'canvas.renders': 250, 'react.commits': 352 } }),
        r('outlineScroll.read', 4500, { attrs: { ...read, attempt: 2 } })
      ].filter((x) => !drop?.(x))
    );

  it('follows open', () => {
    expect(chainFor(['outlineScroll']).map((s) => s.name)).toEqual(['launch', 'open', 'outlineScroll']);
  });

  it('reports the last attempt’s reading of the frames, with the editor’s work over its window', () => {
    const got = outlineScroll.measure(trace(), facts);
    expect(got.missing).toEqual([]);
    expect(got.metrics).toEqual({
      'outlineScroll.framePeriodMs': { unit: 'ms', value: 16.7 },
      'outlineScroll.ms': { unit: 'ms', value: 2100 },
      'outlineScroll.rectReports': { unit: 'count', value: 48 },
      'outlineScroll.canvasRenders': { unit: 'count', value: 50 },
      'outlineScroll.rendererCommits': { unit: 'count', value: 52 },
      'outlineScroll.offsetPx': { unit: 'px', value: 11.5 },
      'outlineScroll.lagMs': { unit: 'ms', value: 1.02 * 16.7 },
      'outlineScroll.speedPx': { unit: 'px', value: 12 },
      'outlineScroll.restAfterPx': { unit: 'px', value: 0.3 },
      'outlineScroll.trailingFrames': { unit: 'count', value: 46 },
      'outlineScroll.movingFrames': { unit: 'count', value: 48 },
      'outlineScroll.frames': { unit: 'count', value: 80 }
    });
  });

  it('names what is missing: the frame period, the window’s end, or its reading', () => {
    expect(outlineScroll.measure(trace((x) => x.name === 'outlineScroll.read' && x.attrs?.attempt === 2), facts).missing).toEqual(['outlineScroll.read']);
    expect(outlineScroll.measure(trace((x) => x.name === 'outlineScroll.window' && x.attrs?.edge === 'end' && x.attrs?.attempt === 2), facts).missing).toEqual(['outlineScroll.window end']);
    // Without the frame period the lag cannot be put in milliseconds either.
    expect(outlineScroll.measure(trace((x) => x.name === 'scenario.start'), facts).missing).toEqual(['scenario.start (renderer)', 'scenario.start (renderer, with the frame period)', 'outlineScroll.lagMs (a finite time)']);
    // A reading with no moving frame has no offset: missing, never zero.
    const still = new Trace([r('scenario.start', 1, { attrs: { scenario: 'outlineScroll', periodMs: 16.7 } }), r('outlineScroll.window', 2, { attrs: { scenario: 'outlineScroll', edge: 'start', attempt: 1 } }), r('outlineScroll.window', 3, { attrs: { scenario: 'outlineScroll', edge: 'end', attempt: 1 } }), r('outlineScroll.read', 4, { attrs: { ...read, attempt: 1, offsetPx: null, lagFrames: null } })]);
    expect(outlineScroll.measure(still, facts).missing).toEqual(['outlineScroll.offsetPx (a finite distance)', 'outlineScroll.lagMs (a finite time)']);
  });
});

describe('distances on screen in results', () => {
  it('are judged against a band of three MADs, 10% and a pixel, and printed in pixels', () => {
    expect(noiseBand(summarize('px', [12, 12, 12]), summarize('px', [0, 0, 0]))).toBeCloseTo(1.2);
    expect(noiseBand(summarize('px', [2, 2]), summarize('px', [2]))).toBe(1);
    expect(formatValue(12, 'px')).toBe('12.0 px');
    const result = (values: number[]): RunResult => {
      const iterations: Iteration[] = values.map((value, i) => ({ index: i + 1, ok: true, trace: `t${i}`, metrics: { d: { unit: 'px', value } } }));
      const cases: CaseResult[] = [{ scenario: 'outlineScroll', fixture: 'large', fixtureHash: 'f', status: 'passed', iterations, metrics: summarizeCase(iterations)! }];
      return { schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', build: { commit: 'a', builtAt: null, fingerprint: 'x', head: 'a', dirty: false, appDir: '/app' }, machine: {}, config: { iterations: values.length, scenarios: ['outlineScroll'], fixtures: ['large'], settleMs: 1500 }, cases };
    };
    expect(compareResults(result([12, 12, 12]), result([0, 0, 0]))[0].metrics[0].verdict).toBe('changed');
    expect(compareResults(result([12, 12, 12]), result([11.5, 11.5, 12]))[0].metrics[0].verdict).toBe('noise');
  });
});
