import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ProjectState, ResponsiveScope } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateOperation } from '@shared/ops';
import { dragLabel, dragValue, draggedSize, groupSignature, groupTokens, spacingOp, spacingTarget, type SpaceStop, type SpacingTarget } from '../../src/renderer/src/lib/spacing-drag';
import {
  RATIO_STOPS,
  WIDE_MEDIA,
  columnBoxes,
  gapDecls,
  gutters,
  planGap,
  planSplit,
  planWidth,
  sameSplit,
  shownShares,
  splitDecls,
  splitDragValue,
  splitMedia,
  widthDecls,
  widthDragValue,
  widthReach,
  type BoxEdges
} from '../../src/renderer/src/lib/layout-drag';
import { layoutOf, spacingOf, type FrameLayout } from '../../src/renderer/src/lib/payload';

// The foundation theme's spacing scale at a desktop width, and its page widths.
const SCALE: SpaceStop[] = [
  { token: 'space.xs', label: 'XS', px: 8 },
  { token: 'space.sm', label: 'Small', px: 12 },
  { token: 'space.md', label: 'Medium', px: 16 },
  { token: 'space.lg', label: 'Large', px: 24 },
  { token: 'space.xl', label: 'XL', px: 32 },
  { token: 'space.2xl', label: '2XL', px: 48 }
];
const WIDTHS: SpaceStop[] = [
  { token: 'container.gutter', label: 'Page gutter', px: 40 },
  { token: 'container.reading', label: 'Reading width', px: 720 },
  { token: 'container.content', label: 'Content width', px: 1200 }
];

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const EDGES: BoxEdges = { padding: NONE, border: NONE };
const layout = (over: Partial<FrameLayout> = {}): FrameLayout => ({
  box: { x: 0, y: 0, width: 1000, height: 200 },
  kind: 'block',
  rowGap: 0,
  columnGap: 0,
  column: false,
  wrap: false,
  spread: false,
  items: [],
  cols: [],
  rows: [],
  packedCols: true,
  packedRows: true,
  width: null,
  ...over
});
const element = (offered: string[], styles: SpacingTarget['styles'] = {}, more: Partial<SpacingTarget> = {}): SpacingTarget => ({ owner: { kind: 'page', id: 'p' }, nodeId: 'n', styles, offered, everyItem: false, ...more });
const GAPS = ['gap', 'rowGap', 'columnGap'];

// ---------------------------------------------------------------------------
// Where the gap handles sit
// ---------------------------------------------------------------------------

describe('gutters: where gap handles sit', () => {
  it('puts one between each item of a row and the next', () => {
    const row = layout({ kind: 'flex', columnGap: 20, items: [{ x: 0, y: 0, width: 100, height: 40 }, { x: 120, y: 0, width: 100, height: 40 }, { x: 240, y: 10, width: 100, height: 20 }] });
    expect(gutters(row, EDGES, false)).toEqual([
      { axis: 'x', index: 0, rect: { x: 100, y: 0, width: 20, height: 40 } },
      { axis: 'x', index: 1, rect: { x: 220, y: 10, width: 20, height: 20 } }
    ]);
  });

  it('follows the order items show in, and never joins the end of one line to the start of the next', () => {
    // A wrapped row in reverse: the second line starts under the first.
    const row = layout({ kind: 'flex', wrap: true, items: [{ x: 200, y: 0, width: 100, height: 40 }, { x: 0, y: 0, width: 180, height: 40 }, { x: 0, y: 60, width: 100, height: 40 }] });
    const g = gutters(row, EDGES, false);
    expect(g).toHaveLength(1);
    expect(g[0].rect).toEqual({ x: 180, y: 0, width: 20, height: 40 });
  });

  it('runs down a stack, and leaves out a stack that spreads its room between its items', () => {
    const items = [{ x: 0, y: 0, width: 300, height: 50 }, { x: 0, y: 66, width: 200, height: 50 }];
    expect(gutters(layout({ kind: 'flex', column: true, items }), EDGES, false)).toEqual([{ axis: 'y', index: 0, rect: { x: 0, y: 50, width: 200, height: 16 } }]);
    expect(gutters(layout({ kind: 'flex', column: true, spread: true, items }), EDGES, false)).toEqual([]);
  });

  it('gives a gap of nothing a handle all the same, and none between items that overlap', () => {
    const touching = layout({ kind: 'flex', items: [{ x: 0, y: 0, width: 100, height: 40 }, { x: 100, y: 0, width: 100, height: 40 }] });
    expect(gutters(touching, EDGES, false)[0].rect.width).toBe(0);
    const overlapping = layout({ kind: 'flex', items: [{ x: 0, y: 0, width: 100, height: 40 }, { x: 60, y: 0, width: 100, height: 40 }] });
    expect(gutters(overlapping, EDGES, false)).toEqual([]);
  });

  it('places a grid’s column and row gutters inside its padding, from the right on a right-to-left page', () => {
    const pad = { top: 10, right: 20, bottom: 10, left: 20 };
    const grid = layout({ kind: 'grid', columnGap: 24, rowGap: 16, box: { x: 0, y: 0, width: 1000, height: 236 }, cols: [304, 304, 304], rows: [100, 100] });
    const g = gutters(grid, { padding: pad, border: NONE }, false);
    expect(g.filter((x) => x.axis === 'x').map((x) => x.rect)).toEqual([
      { x: 324, y: 10, width: 24, height: 216 },
      { x: 652, y: 10, width: 24, height: 216 }
    ]);
    expect(g.filter((x) => x.axis === 'y').map((x) => x.rect)).toEqual([{ x: 20, y: 110, width: 960, height: 16 }]);
    expect(columnBoxes(grid, { padding: pad, border: NONE }, false)!.map((c) => c.x)).toEqual([20, 348, 676]);
    // The first column is on the right: the first gutter is the one nearer the right.
    expect(gutters(grid, { padding: pad, border: NONE }, true).filter((x) => x.axis === 'x').map((x) => x.rect.x)).toEqual([652, 324]);
    expect(columnBoxes(grid, { padding: pad, border: NONE }, true)!.map((c) => c.x)).toEqual([676, 348, 20]);
  });

  it('places no column gutters where alignment spreads a grid’s spare room, as their places are not certain', () => {
    const grid = layout({ kind: 'grid', columnGap: 24, cols: [200, 200], rows: [100], packedCols: false });
    expect(gutters(grid, EDGES, false).filter((g) => g.axis === 'x')).toEqual([]);
    expect(columnBoxes(grid, EDGES, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What a gap handle writes
// ---------------------------------------------------------------------------

describe('planGap: what a gap handle writes', () => {
  it('writes Gap, moving both gaps, when nothing keeps either', () => {
    expect(planGap('x', element(GAPS, { base: { gap: '16px' } }), 'base', 'desktop')).toEqual({ axis: 'x', property: 'gap', label: 'Gap', axes: ['x', 'y'] });
    expect(planGap('y', element(['gap']), 'base', 'desktop')).toMatchObject({ property: 'gap', axes: ['y', 'x'] });
  });

  it('edits the one gap the selection keeps its own value for where the edit lands', () => {
    expect(planGap('x', element(GAPS, { base: { gap: '16px', columnGap: '40px' } }), 'base', 'desktop')).toMatchObject({ property: 'columnGap', label: 'Column gap', axes: ['x'] });
    // Under All sizes, a value of the size shown counts as its own too.
    expect(planGap('x', element(GAPS, { desktop: { columnGap: '40px' } }), 'base', 'desktop')).toBeNull();
    expect(planGap('x', element(GAPS, { desktop: { columnGap: '40px' } }), 'desktop', 'desktop')).toMatchObject({ property: 'columnGap' });
  });

  it('writes Gap for the other gap only where that one is not kept by a value of its own', () => {
    const t = element(['gap'], { base: { rowGap: '8px' } });
    expect(planGap('x', t, 'base', 'desktop')).toMatchObject({ property: 'gap', axes: ['x'] });
    // Gap alone can't move the row gap past the Row gap set beside it, and Row gap is not offered.
    expect(planGap('y', t, 'base', 'desktop')).toBeNull();
    expect(gapDecls(planGap('x', t, 'base', 'desktop')!, { token: 'space.lg' })).toEqual([['column-gap', 'var(--so-space-lg)']]);
  });

  it('shows no handle for another size than the canvas shows, or one Custom CSS or a size’s own value would keep', () => {
    expect(planGap('x', element(GAPS), 'phone', 'desktop')).toBeNull();
    expect(planGap('x', element(GAPS), 'phone', 'phone')).toMatchObject({ property: 'gap' });
    expect(planGap('x', element(['gap'], { base: { customCss: 'column-gap: 3px' } }), 'base', 'desktop')).toBeNull();
    expect(planGap('x', element(['gap'], { desktop: { gap: '4px' } }), 'base', 'desktop')).toBeNull();
    expect(planGap('x', element(['gap'], { desktop: { gap: '4px' } }), 'base', 'tablet')).toMatchObject({ property: 'gap' });
    expect(planGap('x', element(['paddingBlock']), 'base', 'desktop')).toBeNull();
  });

  it('shows no handle for a change to every card when a card keeps a gap of its own', () => {
    const t = element(['gap'], {}, { everyItem: true, items: { a: { base: { gap: '2px' } } } });
    expect(planGap('x', t, 'base', 'desktop')).toBeNull();
    expect(planGap('x', { ...t, items: { a: { base: { color: 'red' } } } }, 'base', 'desktop')).toMatchObject({ property: 'gap' });
  });

  it('snaps a drag to the spacing scale at any zoom, or whole pixels with Alt', () => {
    // From a 16px gap, 9 screen pixels at half zoom is 18 page pixels: 34px, nearest the XL style.
    const v = dragValue(draggedSize(16, 9, 0.5, 1), SCALE, false);
    expect(v).toMatchObject({ value: { token: 'space.xl' }, px: 32 });
    expect(dragLabel(v)).toBe('XL · 32px');
    expect(dragValue(draggedSize(16, 9, 0.5, 1), SCALE, true).value).toBe('34px');
    // At twice the size, the same page distance takes twice the travel.
    expect(dragValue(draggedSize(16, 36, 2, 1), SCALE, false).value).toEqual({ token: 'space.xl' });
    expect(dragValue(draggedSize(16, -40, 1, 1), SCALE, false).value).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Max width
// ---------------------------------------------------------------------------

describe('max width handles', () => {
  const centred = (over: Partial<NonNullable<FrameLayout['width']>> = {}) => layout({ box: { x: 100, y: 0, width: 800, height: 400 }, width: { centered: true, max: 800, content: false, basis: 1000, ...over } });

  it('show on a box centred by its margins that offers Max width, at the size shown', () => {
    expect(planWidth(element(['maxWidth']), 'base', 'desktop', centred())).toEqual({ property: 'maxWidth', label: 'Max width' });
    expect(planWidth(element(['maxWidth']), 'base', 'desktop', centred({ centered: false }))).toBeNull();
    expect(planWidth(element(['gap']), 'base', 'desktop', centred())).toBeNull();
    expect(planWidth(element(['maxWidth']), 'tablet', 'desktop', centred())).toBeNull();
    expect(planWidth(element(['maxWidth'], { desktop: { maxWidth: '600px' } }), 'base', 'desktop', centred())).toBeNull();
    expect(planWidth(element(['maxWidth'], { base: { customCss: 'max-width: 50%' } }), 'base', 'desktop', centred())).toBeNull();
    expect(planWidth(element(['maxWidth']), 'base', 'desktop', null)).toBeNull();
  });

  it('start from the width shown, in the box Max width sizes, and only where it sizes it now', () => {
    expect(widthReach(centred(), EDGES)).toEqual({ start: 800, most: 1000, max: 800 });
    // Sized by its content box: padding and border are left out.
    const pad = { top: 0, right: 20, bottom: 0, left: 20 };
    expect(widthReach(centred({ content: true, max: 760 }), { padding: pad, border: NONE })).toEqual({ start: 760, most: 960, max: 760 });
    // Filling its container, under a wider cap.
    expect(widthReach(layout({ box: { x: 0, y: 0, width: 1000, height: 1 }, width: { centered: true, max: 1200, content: false, basis: 1000 } }), EDGES)).toMatchObject({ start: 1000, most: 1000 });
    // Narrower than both: sized by its content, where a drag would not show what it saves.
    expect(widthReach(centred({ max: 900 }), EDGES)).toBeNull();
  });

  it('snap to a page-width style within reach, or the nearest 8px, or whole pixels with Alt', () => {
    const reach = { most: 1000, max: 800 };
    // Both edges move: 40 screen pixels inward on the right at zoom 1 takes 80 off the width.
    expect(widthDragValue(draggedSize(800, -40 * 2, 1, 1), WIDTHS, false, reach)).toMatchObject({ value: { token: 'container.reading' }, px: 720 });
    expect(widthDragValue(draggedSize(800, 35 * 2, 1, -1), WIDTHS, false, reach)).toMatchObject({ value: { token: 'container.reading' } });
    // Further than the magnet reaches, it moves in 8px steps.
    expect(widthDragValue(draggedSize(800, 30 * 2, 1, -1), WIDTHS, false, reach)).toEqual({ value: '744px', px: 744 });
    expect(widthDragValue(651, WIDTHS, false, reach)).toEqual({ value: '648px', px: 648 });
    expect(widthDragValue(651.4, WIDTHS, true, reach)).toEqual({ value: '651px', px: 651 });
    expect(dragLabel(widthDragValue(726, WIDTHS, false, reach))).toBe('Reading width · 720px');
  });

  it('stop at the width the container gives, where a style wider than it counts as that wide', () => {
    const reach = { most: 900, max: 700 };
    // Past the container: Content width (1200px) shows as wide as the container does, and is what a drag out to it saves.
    expect(widthDragValue(1500, WIDTHS, false, reach)).toMatchObject({ value: { token: 'container.content' }, px: 1200 });
    expect(widthDragValue(1500, [], false, reach)).toEqual({ value: '900px', px: 900 });
    expect(widthDragValue(-50, WIDTHS, true, reach)).toEqual({ value: '0', px: 0 });
  });

  it('leave a box that already fills its container as it is when dragged out past it', () => {
    expect(widthDragValue(1100, WIDTHS, false, { most: 1000, max: 1200 })).toMatchObject({ keep: true });
    expect(widthDragValue(1100, WIDTHS, false, { most: 1000, max: null })).toMatchObject({ keep: true });
    expect(widthDragValue(990, WIDTHS, false, { most: 1000, max: null }).keep).toBeUndefined();
    expect(widthDecls({ token: 'container.reading' })).toEqual([['max-width', 'var(--so-container-reading)']]);
  });
});

// ---------------------------------------------------------------------------
// Column sizes
// ---------------------------------------------------------------------------

const fresh = () => createStarterState('business', 'Test Studio', true);
const homeOwner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const placed = (s: ProjectState, componentId: string) => {
  const p = s.pages[s.site.homePageId];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const partRef = (s: ProjectState, n: InstanceNode, partId: string): ElementRef => ({ owner: homeOwner(s), instancePath: [n.id], nodeId: s.components[n.definitionId].parts[partId].nodeId, partId });
/** A business site with an empty Section added to Home, and its Container part. */
function withSection(overrides?: Record<string, unknown>) {
  let s = fresh();
  const r = applyOperations(s, [{ type: 'node.insert', owner: homeOwner(s), parentId: null, index: 0, componentId: 'layout.section' }]);
  s = r.state;
  const id = r.results[0].nodeId as string;
  for (const [property, value] of Object.entries(overrides ?? {})) s = applyOperations(s, [{ type: 'node.setStyle', owner: homeOwner(s), nodeId: id, partId: 'container', scope: 'base', property, value } as never]).state;
  const n = s.pages[s.site.homePageId].nodes[id] as InstanceNode;
  return { s, n, t: spacingTarget(s, partRef(s, n, 'container'))! };
}
const grid = (cols: number[]) => layout({ kind: 'grid', cols, rows: [80], columnGap: 24 });

describe('planSplit: column dividers', () => {
  it('reads the columns a grid shows from its column count or its column sizes, through its design', () => {
    const { s, t } = withSection({ layout: 'grid', columns: 2 });
    expect(shownShares(s, t, 'desktop')).toEqual([1, 1]);
    const sized = withSection({ layout: 'grid', columns: 2, gridTemplate: '1fr 2fr' });
    expect(shownShares(sized.s, sized.t, 'desktop')).toEqual([1, 2]);
    // A placement's columns for All sizes leave phones the design's own layout.
    expect(shownShares(sized.s, sized.t, 'phone')).toBeNull();
    const fixed = withSection({ layout: 'grid', gridTemplate: '16rem 1fr' });
    expect(shownShares(fixed.s, fixed.t, 'desktop')).toBeNull();
  });

  it('shows dividers on a two-column Section container at tablet and desktop, writing Column sizes', () => {
    const { s, t } = withSection({ layout: 'grid', columns: 2 });
    expect(planSplit(s, t, 'base', 'desktop', grid([488, 488]))).toEqual({ property: 'gridTemplate', label: 'Column sizes', shares: [1, 1] });
    expect(planSplit(s, t, 'tablet', 'tablet', grid([300, 300]))).toMatchObject({ shares: [1, 1] });
    // Phones keep their own layout; another size than the canvas shows edits nothing here.
    expect(planSplit(s, t, 'base', 'phone', grid([300, 300]))).toBeNull();
    expect(planSplit(s, t, 'phone', 'phone', grid([300, 300]))).toBeNull();
    expect(planSplit(s, t, 'desktop', 'tablet', grid([300, 300]))).toBeNull();
  });

  it('shows none where Column sizes is not offered, or the page does not split the columns as they say', () => {
    const s = fresh();
    const features = placed(s, 'features.grid');
    const cards = spacingTarget(s, partRef(s, features, 'grid'))!;
    expect(cards.offered).toContain('columns');
    expect(cards.offered).not.toContain('gridTemplate');
    expect(planSplit(s, cards, 'base', 'desktop', grid([300, 300, 300]))).toBeNull();
    const { s: s2, t } = withSection({ layout: 'grid', columns: 2 });
    expect(planSplit(s2, t, 'base', 'desktop', grid([300, 300, 300]))).toBeNull();
    expect(planSplit(s2, t, 'base', 'desktop', grid([200, 400]))).toBeNull();
    expect(planSplit(s2, t, 'base', 'desktop', layout({ cols: [300, 300] }))).toBeNull();
  });

  it('shows none under All sizes where the size shown has column sizes of its own, or Custom CSS sets them', () => {
    const { s, t } = withSection({ layout: 'grid', columns: 2 });
    const own = { ...t, styles: { ...t.styles, desktop: { gridTemplate: '1fr 1fr' } } };
    expect(planSplit(s, own, 'base', 'desktop', grid([488, 488]))).toBeNull();
    expect(planSplit(s, own, 'desktop', 'desktop', grid([488, 488]))).toMatchObject({ shares: [1, 1] });
    // A column count of the size shown gives way to column sizes for All sizes, as the stylesheet writes them.
    expect(planSplit(s, { ...t, styles: { ...t.styles, desktop: { columns: 2 } } }, 'base', 'desktop', grid([488, 488]))).not.toBeNull();
    expect(planSplit(s, { ...t, styles: { ...t.styles, base: { ...t.styles?.base, customCss: 'grid-template-columns: 1fr 1fr' } } }, 'base', 'desktop', grid([488, 488]))).toBeNull();
  });

  it('saves one valid edit for the Section container that the page then shows', () => {
    const { s, n, t } = withSection({ layout: 'grid', columns: 2 });
    const op = spacingOp(t, 'base', 'gridTemplate', '1fr 2fr');
    expect(validateOperation(op).ok).toBe(true);
    const after = applyOperations(s, [op]).state;
    expect((after.pages[after.site.homePageId].nodes[n.id] as InstanceNode).overrides?.container?.base?.gridTemplate).toBe('1fr 2fr');
    expect(shownShares(after, spacingTarget(after, partRef(after, n, 'container'))!, 'desktop')).toEqual([1, 2]);
  });
});

describe('splitDragValue: where a divider gets to', () => {
  it('snaps two columns to clean splits, the narrower written as 1fr', () => {
    // Two 500px columns: a third of the way across is 1:2.
    expect(splitDragValue([1, 1], 0, 500, 500, -167, false, false)).toEqual({ value: '1fr 2fr', shares: [1, 2] });
    expect(splitDragValue([1, 1], 0, 500, 500, 100, false, false)?.value).toBe('1.5fr 1fr');
    expect(splitDragValue([1, 1], 0, 500, 500, -100, false, false)?.value).toBe('1fr 1.5fr');
    expect(splitDragValue([1, 1], 0, 500, 500, 240, false, false)?.value).toBe('3fr 1fr');
    expect(splitDragValue([1, 1], 0, 500, 500, 8, false, false)?.value).toBe('1fr 1fr');
    expect(RATIO_STOPS).toHaveLength(9);
  });

  it('follows the pointer in hundredths with Alt, and never takes a column below its least share', () => {
    expect(splitDragValue([1, 1], 0, 500, 500, -130, true, false)?.value).toBe('1fr 1.7fr');
    expect(splitDragValue([1, 1], 0, 500, 500, 2000, true, false)?.value).toBe('19fr 1fr');
  });

  it('moves the other way on a right-to-left page, where the first column is on the right', () => {
    expect(splitDragValue([1, 1], 0, 500, 500, 167, false, true)?.value).toBe('1fr 2fr');
  });

  it('keeps the pair’s share and the other columns when there are more than two', () => {
    // The first divider of 1fr 1fr 2fr, a quarter of the way across its pair: 1:3.
    expect(splitDragValue([1, 1, 2], 0, 250, 250, -125, false, false)).toEqual({ value: '0.5fr 1.5fr 2fr', shares: [0.5, 1.5, 2] });
    expect(splitDragValue([1, 1, 2], 1, 250, 500, 0, false, false)?.value).toBe('1fr 1fr 2fr');
    // Two columns that do not fill the grid keep their total.
    expect(splitDragValue([0.25, 0.25], 0, 100, 100, -50, false, false)?.value).toBe('0.13fr 0.37fr');
  });

  it('counts returning to where a drag began as no change', () => {
    expect(sameSplit([1, 1], [2, 2])).toBe(true);
    expect(sameSplit([1, 2], [1, 1])).toBe(false);
    expect(sameSplit([0.25, 0.25], [1, 1])).toBe(false);
    expect(sameSplit([1, 1], null)).toBe(false);
  });

  it('previews columns as the stylesheet writes them, for All sizes from tablet up', () => {
    expect(splitDecls('1fr 2fr')).toEqual([['grid-template-columns', 'minmax(0, 1fr) minmax(0, 2fr)']]);
    expect(splitMedia('base')).toBe(WIDE_MEDIA);
    expect(splitMedia('desktop')).toBe('(min-width: 1024px)');
  });
});

// ---------------------------------------------------------------------------
// What the page reports
// ---------------------------------------------------------------------------

describe('layoutOf: the selected box’s layout from the page', () => {
  const report = {
    box: { x: 1, y: 2, width: 300, height: 100 },
    kind: 'grid',
    rowGap: 16,
    columnGap: 24,
    cols: [138, 138],
    rows: [100],
    packedCols: true,
    packedRows: true,
    width: { centered: true, max: 800, content: false, basis: 960 }
  };

  it('reads a grid’s report', () => {
    expect(layoutOf(report)).toEqual({ ...report, kind: 'grid', column: false, wrap: false, spread: false, items: [] });
  });

  it('drops a malformed track list whole, and a malformed report altogether', () => {
    expect(layoutOf({ ...report, cols: [138, 'x'] })?.cols).toEqual([]);
    expect(layoutOf({ ...report, cols: Array.from({ length: 13 }, () => 10) })?.cols).toEqual([]);
    expect(layoutOf({ ...report, width: { centered: true, max: -1, basis: 960 } })?.width).toBeNull();
    expect(layoutOf({ ...report, kind: 'table' })).toBeNull();
    expect(layoutOf({ ...report, rowGap: Number.NaN })).toBeNull();
    expect(layoutOf(null)).toBeNull();
  });

  it('keeps a stack’s items, and comes with the spacing report (null when the page sends none)', () => {
    const items = [{ x: 0, y: 0, width: 10, height: 10 }];
    expect(layoutOf({ ...report, kind: 'flex', column: true, items })).toMatchObject({ kind: 'flex', column: true, items, cols: [] });
    const sides = { top: 0, right: 0, bottom: 0, left: 0 };
    const base = { padding: sides, border: sides, margin: sides, ctx: 'page:p', node: 'n', items: '' };
    expect(spacingOf(base)?.layout).toBeNull();
    expect(spacingOf({ ...base, layout: report })?.layout?.cols).toEqual([138, 138]);
  });
});

describe('the scales a layout drag snaps to', () => {
  it('measures gaps on the spacing styles and widths on the page-width styles', () => {
    const s = fresh();
    expect(groupTokens(s, 'container').map((t) => t.token)).toEqual(expect.arrayContaining(['container.reading', 'container.content']));
    expect(groupTokens(s, 'container').every((t) => t.cssVar.startsWith('--so-container-'))).toBe(true);
    expect(groupSignature(s, 'container')).not.toBe(groupSignature(s, 'space'));
  });

  it('writes a scope the edit can carry', () => {
    const { t } = withSection();
    for (const scope of ['base', 'tablet', 'desktop'] as ResponsiveScope[]) expect(validateOperation(spacingOp(t, scope, 'maxWidth', { token: 'container.reading' })).ok).toBe(true);
  });
});
