import { describe, expect, it } from 'vitest';
import { EDGE_BAND, EDGE_MAX_SPEED, dropLineBox, edgeSpeed } from '../../src/renderer/src/lib/edge-scroll';

const view = { left: 100, top: 50, right: 900, bottom: 750 };

describe('edgeSpeed (#904)', () => {
  it('scrolls up within the band along the top and down within the band along the bottom', () => {
    expect(edgeSpeed(500, view.top + 4, view)).toBeLessThan(0);
    expect(edgeSpeed(500, view.bottom - 4, view)).toBeGreaterThan(0);
  });

  it('holds still away from the edges and off the view', () => {
    expect(edgeSpeed(500, 400, view)).toBe(0);
    expect(edgeSpeed(500, view.top + EDGE_BAND + 1, view)).toBe(0);
    expect(edgeSpeed(500, view.bottom - EDGE_BAND - 1, view)).toBe(0);
    expect(edgeSpeed(500, view.top - 1, view)).toBe(0);
    expect(edgeSpeed(500, view.bottom + 1, view)).toBe(0);
    expect(edgeSpeed(view.left - 1, view.bottom - 4, view)).toBe(0);
    expect(edgeSpeed(view.right + 1, view.top + 4, view)).toBe(0);
    expect(edgeSpeed(NaN, view.top + 4, view)).toBe(0);
  });

  it('quickens toward the edge, up to its fastest at the edge itself', () => {
    const slow = edgeSpeed(500, view.bottom - EDGE_BAND + 4, view);
    const fast = edgeSpeed(500, view.bottom - 2, view);
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
    expect(edgeSpeed(500, view.bottom, view)).toBe(EDGE_MAX_SPEED);
    expect(edgeSpeed(500, view.top, view)).toBe(-EDGE_MAX_SPEED);
  });

  it('splits a view too short for two bands between them', () => {
    const short = { left: 0, top: 0, right: 100, bottom: 60 };
    expect(edgeSpeed(50, 10, short)).toBeLessThan(0);
    expect(edgeSpeed(50, 50, short)).toBeGreaterThan(0);
    expect(edgeSpeed(50, 29, short)).toBeLessThan(0);
    expect(edgeSpeed(50, 31, short)).toBeGreaterThan(0);
    expect(edgeSpeed(50, 30, short)).toBe(0);
  });

  it('starts slow and quickens more toward the edge than a straight ramp would', () => {
    const half = edgeSpeed(500, view.bottom - EDGE_BAND / 2, view);
    expect(half).toBeLessThan(EDGE_MAX_SPEED / 2);
    expect(edgeSpeed(500, view.bottom - EDGE_BAND + 0.5, view)).toBeGreaterThan(100);
    expect(edgeSpeed(500, view.top + 4, { ...view, top: NaN })).toBe(0);
  });
});

describe('dropLineBox (#904)', () => {
  const frame = { left: 0, top: 0, right: 1000, bottom: 375 };
  // The frame's top sits 42px down a 320px canvas, so the canvas shows its first 278px.
  const shown = { left: 0, top: 0, right: 1000, bottom: 278 };
  const gap = { left: 0, top: 368, width: 1000, height: 0 };

  it('pins a gap past the bottom of what the canvas shows to that edge, where the whole frame would leave it out of sight', () => {
    expect(dropLineBox(gap, frame).top).toBe(367);
    expect(dropLineBox(gap, shown).top).toBe(270);
  });

  it('pins a gap scrolled above what the canvas shows to its top edge', () => {
    const below = { left: 0, top: 120, right: 1000, bottom: 375 };
    expect(dropLineBox({ left: 0, top: 40, width: 1000, height: 0 }, below).top).toBe(126);
  });

  it('draws a gap the canvas shows exactly where it is, as it always was', () => {
    expect(dropLineBox({ left: 20, top: 100, width: 600, height: 0 }, shown)).toEqual({ left: 27, top: 99, width: 591, height: 2, vertical: false });
    expect(dropLineBox({ left: 300, top: 20, width: 0, height: 200 }, shown)).toEqual({ left: 299, top: 27, width: 2, height: 191, vertical: true });
  });

  it('cuts a line to the part of it the canvas shows', () => {
    const narrow = { left: 200, top: 0, right: 500, bottom: 278 };
    const line = dropLineBox({ left: 0, top: 100, width: 1000, height: 0 }, narrow);
    expect(line.left).toBe(207);
    expect(line.left + line.width).toBe(498);
  });
});

describe('dropLineBox when none of the line shows (#904)', () => {
  const shown = { left: 0, top: 0, right: 500, bottom: 278 };

  it('draws a short stretch at the edge a gap off to the side is past', () => {
    const right = dropLineBox({ left: 600, top: 100, width: 140, height: 0 }, shown);
    expect(right.left + right.width).toBe(498);
    expect(right.width).toBe(24);
    const left = dropLineBox({ left: 600, top: 100, width: 140, height: 0 }, { left: 800, top: 0, right: 1300, bottom: 278 });
    expect(left.left).toBe(807);
  });

  it('does the same along a gap between items in a row that is out of sight above or below', () => {
    const below = dropLineBox({ left: 200, top: 400, width: 0, height: 120 }, shown);
    expect(below.vertical).toBe(true);
    expect(below.top + below.height).toBe(276);
    const above = dropLineBox({ left: 200, top: -300, width: 0, height: 120 }, { left: 0, top: 50, right: 500, bottom: 278 });
    expect(above.top).toBe(57);
  });
});
