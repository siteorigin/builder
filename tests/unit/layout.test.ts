import { describe, expect, it } from 'vitest';
import { CANVAS_MIN, PANEL_DEFAULTS, PANEL_LIMITS, RAIL_WIDTH, fitPanels, panelMax, resizePanel, restorePanelWidth, toolbarTier } from '../../src/renderer/src/lib/layout';

const canvas = (win: number, w: { left: number; right: number }) => win - RAIL_WIDTH - w.left - w.right;

describe('editor width budget', () => {
  it('keeps the default panel widths at the 1100px minimum window', () => {
    const w = fitPanels(1100, { left: 260, right: 340 });
    expect(w).toEqual({ left: 260, right: 340 });
    expect(canvas(1100, w)).toBeGreaterThanOrEqual(CANVAS_MIN);
  });

  it('keeps the canvas minimum when both panels were left at their maxima', () => {
    // The reported case: both splitters at their maxima in an 1100px window left the preview 76px wide.
    // The left panel gives way first, then the right dock.
    expect(fitPanels(1100, { left: 420, right: 560 })).toEqual({ left: 200, right: 412 });
    expect(fitPanels(1440, { left: 420, right: 560 })).toEqual({ left: 392, right: 560 });
    expect(fitPanels(1468, { left: 420, right: 560 })).toEqual({ left: 420, right: 560 });
  });

  it('gives the preferred widths back in a wider window', () => {
    const prefs = { left: 400, right: 500 };
    expect(fitPanels(1100, prefs)).toEqual({ left: 200, right: 412 });
    expect(prefs).toEqual({ left: 400, right: 500 });
    expect(fitPanels(1600, prefs)).toEqual(prefs);
  });

  it('lets one open panel use the room a closed one leaves', () => {
    expect(fitPanels(1100, { left: 420, right: null })).toEqual({ left: 420, right: 0 });
    expect(fitPanels(1100, { left: null, right: 560 })).toEqual({ left: 0, right: 560 });
    expect(fitPanels(900, { left: null, right: 560 })).toEqual({ left: 0, right: 900 - RAIL_WIDTH - CANVAS_MIN });
    expect(fitPanels(1100, { left: null, right: null })).toEqual({ left: 0, right: 0 });
    // A lone sidebar still leaves the canvas its minimum.
    expect(fitPanels(800, { left: 420, right: null })).toEqual({ left: 800 - RAIL_WIDTH - CANVAS_MIN, right: 0 });
  });

  it('keeps panels at their minimums when even those leave less than the canvas minimum', () => {
    // 48 + 200 + 300 + 440 = 988 is the narrowest window where all three floors hold.
    expect(fitPanels(988, { left: 300, right: 400 })).toEqual({ left: 200, right: 300 });
    expect(fitPanels(800, { left: 300, right: 400 })).toEqual({ left: 200, right: 300 });
  });

  it('clamps preferences outside the panel limits', () => {
    expect(fitPanels(2000, { left: 9999, right: 10 })).toEqual({ left: 420, right: 300 });
    expect(fitPanels(2000, { left: 10, right: 9999 })).toEqual({ left: 200, right: 560 });
  });

  it('never squeezes the canvas below its minimum at a supported size, whatever the preferences', () => {
    for (let win = 988; win <= 1700; win += 7)
      for (let l = 200; l <= 420; l += 13)
        for (let r = 300; r <= 560; r += 17) {
          const w = fitPanels(win, { left: l, right: r });
          expect(Number.isInteger(w.left) && Number.isInteger(w.right)).toBe(true);
          expect(w.left).toBeGreaterThanOrEqual(200);
          expect(w.right).toBeGreaterThanOrEqual(300);
          expect(w.left).toBeLessThanOrEqual(l);
          expect(w.right).toBeLessThanOrEqual(r);
          expect(canvas(win, w)).toBeGreaterThanOrEqual(CANVAS_MIN);
          // A panel only gives way when the canvas is at its minimum.
          if (w.left < l || w.right < r) expect(canvas(win, w)).toBe(CANVAS_MIN);
        }
  });
});

describe('restoring saved widths', () => {
  it('uses the saved width within the panel limits', () => {
    expect(restorePanelWidth('left', 333)).toBe(333);
    expect(restorePanelWidth('right', 9000)).toBe(PANEL_LIMITS.right.max);
    expect(restorePanelWidth('left', 12.6)).toBe(PANEL_LIMITS.left.min);
    expect(restorePanelWidth('left', 300.6)).toBe(301);
  });

  it('falls back to the default for a project saved before widths were kept, or a broken value', () => {
    expect(restorePanelWidth('left', undefined)).toBe(PANEL_DEFAULTS.left);
    expect(restorePanelWidth('right', '400')).toBe(PANEL_DEFAULTS.right);
    expect(restorePanelWidth('right', Number.NaN)).toBe(PANEL_DEFAULTS.right);
    expect(restorePanelWidth('left', Number.POSITIVE_INFINITY)).toBe(PANEL_DEFAULTS.left);
    expect(restorePanelWidth('right', Number.NEGATIVE_INFINITY)).toBe(PANEL_DEFAULTS.right);
  });

  it('a saved wide layout opened in a small window still leaves the canvas its minimum', () => {
    const prefs = { left: restorePanelWidth('left', 420), right: restorePanelWidth('right', 560) };
    expect(canvas(1100, fitPanels(1100, prefs))).toBe(CANVAS_MIN);
  });
});

describe('splitter limits', () => {
  const defaults = { left: 260, right: 340 };

  it('stops a drag where the canvas would drop below its minimum', () => {
    expect(panelMax('left', 1100, defaults)).toBe(1100 - RAIL_WIDTH - CANVAS_MIN - 340);
    expect(resizePanel('left', 999, 1100, defaults)).toBe(272);
    expect(resizePanel('left', 265, 1100, defaults)).toBe(265);
    // The dock may take the sidebar down to its minimum, as a smaller window would.
    expect(resizePanel('right', 999, 1100, defaults)).toBe(1100 - RAIL_WIDTH - CANVAS_MIN - PANEL_LIMITS.left.min);
    expect(fitPanels(1100, { left: 260, right: 412 })).toEqual({ left: 200, right: 412 });
  });

  it('lets the dock retrace a step after the sidebar took the room back', () => {
    // At 1100 with both preferences at their maxima, the panels show 200 and 412, each at its limit.
    const prefs = { left: 420, right: 560 };
    expect(fitPanels(1100, prefs)).toEqual({ left: 200, right: 412 });
    expect(panelMax('right', 1100, prefs)).toBe(412);
    expect(panelMax('left', 1100, prefs)).toBe(200);
    // Narrowing the dock gives the sidebar the room at once...
    const narrower = resizePanel('right', 412 - 16, 1100, prefs);
    expect(narrower).toBe(396);
    expect(fitPanels(1100, { left: 420, right: narrower })).toEqual({ left: 216, right: 396 });
    // ...and the reverse step is still allowed: the dock takes it back from the sidebar.
    expect(panelMax('right', 1100, { left: 420, right: narrower })).toBe(412);
    expect(resizePanel('right', 396 + 16, 1100, { left: 420, right: narrower })).toBe(412);
  });

  it('keeps the panel limits in a wide window', () => {
    expect(resizePanel('left', 999, 2400, { left: 300, right: 560 })).toBe(420);
    expect(resizePanel('right', 10, 2400, { left: 420, right: 400 })).toBe(300);
    expect(resizePanel('right', 450, 2400, { left: 420, right: 400 })).toBe(450);
  });

  it('never goes below the panel minimum, even with no room left', () => {
    expect(panelMax('left', 900, { left: 300, right: 560 })).toBe(200);
    expect(resizePanel('left', 150, 900, { left: 300, right: 560 })).toBe(200);
    expect(resizePanel('left', 250, 900, { left: 300, right: 560 })).toBe(200);
    expect(panelMax('right', 900, { left: 300, right: 400 })).toBe(300);
    expect(resizePanel('right', 250, 900, { left: 300, right: 400 })).toBe(300);
    expect(panelMax('right', 900, { left: null, right: 400 })).toBe(900 - RAIL_WIDTH - CANVAS_MIN);
  });

  it('uses the whole budget when the other panel is closed', () => {
    expect(resizePanel('right', 999, 1100, { left: null, right: 340 })).toBe(560);
    expect(resizePanel('right', 999, 1000, { left: null, right: 340 })).toBe(1000 - RAIL_WIDTH - CANVAS_MIN);
    expect(resizePanel('left', 999, 800, { left: 260, right: null })).toBe(800 - RAIL_WIDTH - CANVAS_MIN);
  });
});

describe('toolbar tiers', () => {
  it('compacts the toolbar at the 1100px minimum on macOS, and shows it all from 1232px', () => {
    expect(toolbarTier(1100, true)).toBe('compact');
    expect(toolbarTier(1231, true)).toBe('compact');
    expect(toolbarTier(1232, true)).toBe('full');
    expect(toolbarTier(1440, true)).toBe('full');
  });

  it('moves controls into the More menu only below the compact toolbar’s room', () => {
    expect(toolbarTier(1080, true)).toBe('compact');
    expect(toolbarTier(1079, true)).toBe('overflow');
    // A zoomed-in interface at the minimum window: 1100px at 110% is 1000 CSS pixels.
    expect(toolbarTier(1000, true)).toBe('overflow');
  });

  it('gives Windows and Linux the 70px macOS keeps for its window buttons', () => {
    expect(toolbarTier(1162, false)).toBe('full');
    expect(toolbarTier(1161, false)).toBe('compact');
    expect(toolbarTier(1100, false)).toBe('compact');
    expect(toolbarTier(1010, false)).toBe('compact');
    expect(toolbarTier(1009, false)).toBe('overflow');
  });
});
