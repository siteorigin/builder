import { describe, expect, it } from 'vitest';
import { EDGE_BAND, EDGE_MAX_SPEED, edgeSpeed } from '../../src/renderer/src/lib/edge-scroll';

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
  });
});
