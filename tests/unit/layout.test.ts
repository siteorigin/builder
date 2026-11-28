import { describe, expect, it } from 'vitest';
import { CANVAS_MIN, DEFAULT_VIEWPORT, FRAME_KEY_STEP, INSERT_NARROW_MAX, PANEL_DEFAULTS, PANEL_LIMITS, RAIL_WIDTH, VIEWPORT_LIMITS, ZOOM_LEVELS, clampViewport, fitPanels, frameKeyResize, narrowLayout, panelMax, resizePanel, restorePanelWidth, restoreViewport, restoreZoom, toolbarTier } from '../../src/renderer/src/lib/layout';

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
  it('compacts the toolbar at the 1100px minimum on macOS, and shows it all from 1344px', () => {
    expect(toolbarTier(1100, true)).toBe('compact');
    expect(toolbarTier(1343, true)).toBe('compact');
    expect(toolbarTier(1344, true)).toBe('full');
    expect(toolbarTier(1440, true)).toBe('full');
  });

  it('shows a live session’s wider toolbar in full only once it fits (#1342)', () => {
    // A host's live Share pill, with its time, people and waiting counts.
    expect(toolbarTier(1463, true, 'hosting')).toBe('compact');
    expect(toolbarTier(1464, true, 'hosting')).toBe('full');
    // A guest's Notes, session pill and Leave session: a 1440px window gives Leave session its icon, not its words.
    expect(toolbarTier(1440, true, 'guest')).toBe('compact');
    expect(toolbarTier(1527, true, 'guest')).toBe('compact');
    expect(toolbarTier(1528, true, 'guest')).toBe('full');
    // The compact toolbar has room for either at the minimum window, so the More menu comes no sooner.
    for (const session of ['hosting', 'guest'] as const) {
      expect(toolbarTier(1100, true, session)).toBe('compact');
      expect(toolbarTier(1080, true, session)).toBe('compact');
      expect(toolbarTier(1079, true, session)).toBe('overflow');
    }
  });

  it('moves controls into the More menu only below the compact toolbar’s room', () => {
    expect(toolbarTier(1080, true)).toBe('compact');
    expect(toolbarTier(1079, true)).toBe('overflow');
    // A zoomed-in interface at the minimum window: 1100px at 110% is 1000 CSS pixels.
    expect(toolbarTier(1000, true)).toBe('overflow');
  });

  it('gives Windows and Linux the room macOS keeps for its window buttons: 70px compact, 30px in full', () => {
    expect(toolbarTier(1314, false)).toBe('full');
    expect(toolbarTier(1313, false)).toBe('compact');
    expect(toolbarTier(1434, false, 'hosting')).toBe('full');
    expect(toolbarTier(1433, false, 'hosting')).toBe('compact');
    expect(toolbarTier(1498, false, 'guest')).toBe('full');
    expect(toolbarTier(1497, false, 'guest')).toBe('compact');
    expect(toolbarTier(1100, false)).toBe('compact');
    expect(toolbarTier(1010, false)).toBe('compact');
    expect(toolbarTier(1009, false)).toBe('overflow');
  });
});

describe('preview width and zoom', () => {
  it('gives the frame handles the width field’s range, so a drag moves on from any width the field allows', () => {
    expect(VIEWPORT_LIMITS).toEqual({ min: 240, max: 2560 });
    // The reported jumps: a few pixels of drag from 2400 or 280 snapped the frame to 1920 or 320.
    expect(clampViewport(2400 + 3)).toBe(2403);
    expect(clampViewport(280 - 3)).toBe(277);
    expect(clampViewport(2600)).toBe(2560);
    expect(clampViewport(100)).toBe(240);
    expect(clampViewport(1280.4)).toBe(1280);
    expect(clampViewport(1280.6)).toBe(1281);
    expect(clampViewport(1280.5)).toBe(1281);
  });

  it('resizes the frame from the keyboard, each handle in the direction it is dragged', () => {
    // Each press changes the width by the splitters' 16px step.
    expect(FRAME_KEY_STEP).toBe(16);
    expect(frameKeyResize('right', 'ArrowRight', 1280)).toBe(1296);
    expect(frameKeyResize('right', 'ArrowLeft', 1280)).toBe(1264);
    expect(frameKeyResize('left', 'ArrowLeft', 1280)).toBe(1296);
    expect(frameKeyResize('left', 'ArrowRight', 1280)).toBe(1264);
    // Up to each limit, then no further.
    expect(frameKeyResize('right', 'ArrowRight', 2550)).toBe(2560);
    expect(frameKeyResize('right', 'ArrowRight', 2560)).toBeNull();
    expect(frameKeyResize('right', 'ArrowLeft', 245)).toBe(240);
    expect(frameKeyResize('left', 'ArrowLeft', 2550)).toBe(2560);
    expect(frameKeyResize('left', 'ArrowRight', 245)).toBe(240);
    expect(frameKeyResize('left', 'ArrowRight', 240)).toBeNull();
    expect(frameKeyResize('right', 'ArrowUp', 1280)).toBeNull();
  });

  it('restores a saved width and zoom only when the editor could have chosen them', () => {
    expect(restoreViewport(2400)).toBe(2400);
    expect(restoreViewport(240)).toBe(240);
    expect(restoreViewport(2560)).toBe(2560);
    for (const bad of [undefined, null, '834', 239, 2561, 834.5, Number.NaN]) expect(restoreViewport(bad)).toBe(DEFAULT_VIEWPORT);
    expect(DEFAULT_VIEWPORT).toBe(1280);
    expect(restoreZoom('fit')).toBe('fit');
    expect(ZOOM_LEVELS).toEqual([0.5, 0.75, 1, 1.25]);
    for (const z of [0.5, 0.75, 1, 1.25]) expect(restoreZoom(z)).toBe(z);
    // The canvas divides by the zoom: nothing else is restored, not even a level between the menu's.
    for (const bad of [undefined, 0, -1, 0.6, 1.5, 3, '0.5', Number.NaN]) expect(restoreZoom(bad)).toBe('fit');
  });
});

describe('Insert panel layout', () => {
  it('is narrow at its own width or under, scrollbar included', () => {
    expect(narrowLayout(INSERT_NARROW_MAX, false)).toBe(true);
    expect(narrowLayout(INSERT_NARROW_MAX + 1, true)).toBe(false);
    // The sidebar at its usual width, as Windows draws it at 125%: not narrow.
    expect(narrowLayout(PANEL_DEFAULTS.left - 1, false)).toBe(false);
  });

  it('keeps its layout while hidden, so opening it never shows the narrow one first', () => {
    // Mounted behind another sidebar tab, the panel has no width: that is not a narrow panel.
    expect(narrowLayout(0, false)).toBe(false);
    expect(narrowLayout(0, true)).toBe(true);
  });
});
