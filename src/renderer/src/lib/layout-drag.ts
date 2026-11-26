/**
 * Gaps, max widths and column sizes dragged on the canvas (#385), beside spacing-drag's padding and margin: where
 * each handle sits on the selected box, which style it writes, and the value a drag reaches. Pure, for the canvas
 * overlay to drive.
 */
import type { InstanceNode, ProjectState, ResponsiveScope, StyleValue } from '@shared/types';
import { STYLE_PROP_MAP, cascadeStyles, gridTemplateShares, styleToCss, tokenVar, type StyleLayer } from '@shared/styles';
import { designLayers } from '@shared/variants';
import type { FrameLayout, FrameRect, FrameSides } from './payload';
import { treeFor } from './model';
import { beaten, customSets, previewMedia, rulesAt, setsSide, spaceScale, type DragValue, type SpaceStop, type SpacingTarget } from './spacing-drag';

type Size = Exclude<ResponsiveScope, 'base'>;
/** The sides of the selected box that hold its content in: its border and padding, in frame pixels. */
export interface BoxEdges {
  padding: FrameSides;
  border: FrameSides;
}

const finite = (n: number) => typeof n === 'number' && Number.isFinite(n);
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

/** A value as the stylesheet writes it: a site style by its CSS variable, anything else as it is. */
const cssOf = (value: StyleValue) => (typeof value === 'object' && value !== null ? (typeof value.token === 'string' ? `var(${tokenVar(value.token)})` : '') : String(value));

/** The box inside the selected box's border and padding, in frame pixels: where the page says its content box is
 *  (a scrollbar on either side takes room from it), or else its border box less its border and padding. */
export function contentBox(layout: FrameLayout, edges: BoxEdges): FrameRect {
  const { box, inner } = layout;
  if (inner) return { ...inner };
  const { padding: p, border: b } = edges;
  return { x: box.x + b.left + p.left, y: box.y + b.top + p.top, width: Math.max(0, box.width - b.left - b.right - p.left - p.right), height: Math.max(0, box.height - b.top - b.bottom - p.top - p.bottom) };
}

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Which gap a gutter is: between things side by side (the column gap, dragged across) or stacked (the row gap, dragged down). */
export type GapAxis = 'x' | 'y';
const LONGHAND: Record<GapAxis, 'columnGap' | 'rowGap'> = { x: 'columnGap', y: 'rowGap' };
const LONGHAND_CSS: Record<GapAxis, string> = { x: 'column-gap', y: 'row-gap' };

/** The space between two neighbours, in frame pixels, and which gap it is. `index` counts gutters of its axis. */
export interface Gutter {
  axis: GapAxis;
  index: number;
  rect: FrameRect;
}

/** The most gutters of one axis that get a handle. */
const MAX_GUTTERS = 24;

/**
 * A grid's columns (or rows) as the page lays them out: each one's start and size along the axis, in frame pixels,
 * in track order. Null where they cannot be placed for certain: spare room that alignment spreads or centres.
 */
function trackSpans(sizes: number[], gap: number | null, start: number, end: number, packed: boolean, reverse: boolean): Array<{ from: number; size: number }> | null {
  if (!sizes.length || gap === null) return null;
  const total = sum(sizes) + gap * (sizes.length - 1);
  if (!packed && Math.abs(total - (end - start)) > 1) return null;
  let at = 0;
  return sizes.map((size) => {
    const from = reverse ? end - at - size : start + at;
    at += size + gap;
    return { from, size };
  });
}

/** A grid's columns as boxes, in track order (the first is on the right of a right-to-left page); null where unknown. */
export function columnBoxes(layout: FrameLayout, edges: BoxEdges, rtl: boolean): FrameRect[] | null {
  if (layout.kind !== 'grid') return null;
  const c = contentBox(layout, edges);
  const cols = trackSpans(layout.cols, layout.columnGap, c.x, c.x + c.width, layout.packedCols, rtl);
  if (!cols) return null;
  const rows = layout.rows.length && layout.rowGap !== null ? sum(layout.rows) + layout.rowGap * (layout.rows.length - 1) : c.height;
  return cols.map((t) => ({ x: t.from, y: c.y, width: t.size, height: rows }));
}

/**
 * The gutters a gap handle can sit in: in a stack, between each item and the next one along the same line (never
 * from the end of one line to the start of the next); in a grid, between its columns and between its rows. None for
 * a stack that spreads its spare room between its items, where a gap may not show, nor for a gap the page could not
 * say the size of.
 */
export function gutters(layout: FrameLayout, edges: BoxEdges, rtl: boolean): Gutter[] {
  const out: Gutter[] = [];
  const push = (axis: GapAxis, rect: FrameRect) => {
    const index = out.filter((g) => g.axis === axis).length;
    if (index < MAX_GUTTERS) out.push({ axis, index, rect });
  };
  if (layout.kind === 'flex') {
    const across = !layout.column;
    if (layout.spread || (across ? layout.columnGap : layout.rowGap) === null) return out;
    const start = (r: FrameRect) => (across ? r.x : r.y);
    const end = (r: FrameRect) => (across ? r.x + r.width : r.y + r.height);
    const lo = (r: FrameRect) => (across ? r.y : r.x);
    const hi = (r: FrameRect) => (across ? r.y + r.height : r.x + r.width);
    const items = [...layout.items].sort((a, b) => start(a) - start(b));
    // On one line every item is the next one's neighbour, however each is aligned across it; wrapped, only items
    // that share a line are.
    const sameLine = (a: FrameRect, b: FrameRect) => !layout.wrap || Math.min(hi(a), hi(b)) - Math.max(lo(a), lo(b)) > 0;
    for (const a of items) {
      // Its neighbour: the nearest item after it on its line.
      let next: FrameRect | null = null;
      for (const b of items) {
        if (b === a || start(b) < end(a) - 0.5 || !sameLine(a, b)) continue;
        if (!next || start(b) < start(next)) next = b;
      }
      if (!next) continue;
      const from = end(a);
      const size = Math.max(0, start(next) - from);
      // Across the line: where the two overlap, or (on one line, not overlapping) all the way from one to the other.
      const shared = Math.min(hi(a), hi(next)) - Math.max(lo(a), lo(next)) > 0;
      const top = shared ? Math.max(lo(a), lo(next)) : Math.min(lo(a), lo(next));
      const length = (shared ? Math.min(hi(a), hi(next)) : Math.max(hi(a), hi(next))) - top;
      push(across ? 'x' : 'y', across ? { x: from, y: top, width: size, height: length } : { x: top, y: from, width: length, height: size });
    }
    return out;
  }
  if (layout.kind !== 'grid') return out;
  const c = contentBox(layout, edges);
  const cols = trackSpans(layout.cols, layout.columnGap, c.x, c.x + c.width, layout.packedCols, rtl);
  const rows = trackSpans(layout.rows, layout.rowGap, c.y, c.y + c.height, layout.packedRows, false);
  const colsAcross = cols ? { from: Math.min(...cols.map((t) => t.from)), to: Math.max(...cols.map((t) => t.from + t.size)) } : { from: c.x, to: c.x + c.width };
  const rowsDown = rows ? { from: rows[0].from, to: rows[rows.length - 1].from + rows[rows.length - 1].size } : { from: c.y, to: c.y + c.height };
  cols?.slice(0, -1).forEach((t, i) => {
    const after = cols[i + 1];
    const x = rtl ? after.from + after.size : t.from + t.size;
    push('x', { x, y: rowsDown.from, width: layout.columnGap!, height: rowsDown.to - rowsDown.from });
  });
  rows?.slice(0, -1).forEach((t) => push('y', { x: colsAcross.from, y: t.from + t.size, width: colsAcross.to - colsAcross.from, height: layout.rowGap! }));
  return out;
}

/** What a gap handle writes for a selection, and which of the page's gaps that moves. */
export interface GapPlan {
  axis: GapAxis;
  property: 'gap' | 'columnGap' | 'rowGap';
  label: string;
  /** The gaps it moves on the page: its own, and with Gap the other one too where nothing keeps that one. */
  axes: GapAxis[];
}

const GAP_NAMES: Record<GapAxis, string[]> = { x: ['gap', 'column-gap'], y: ['gap', 'row-gap'] };
const OTHER: Record<GapAxis, GapAxis> = { x: 'y', y: 'x' };

/**
 * What a gap handle writes: Gap, unless the selection keeps its own value for this one gap (Column gap or Row gap)
 * where the edit lands, which is then edited in its place; the one gap alone when Gap is not offered. Null when the
 * selection offers neither, the edit is for another size than the canvas shows, or a value already set (at the size
 * shown, in Custom CSS, or a card's own for a change to every card) would keep the gap where it is.
 */
export function planGap(axis: GapAxis, target: SpacingTarget, scope: ResponsiveScope, shown: Size): GapPlan | null {
  if (scope !== 'base' && scope !== shown) return null;
  const long = LONGHAND[axis];
  const offered = target.offered;
  const keepsOwn = rulesAt(target.styles, scope)[long] !== undefined || (scope === 'base' && rulesAt(target.styles, shown)[long] !== undefined);
  const order: Array<GapPlan['property']> = keepsOwn ? [long, 'gap'] : ['gap', long];
  const property = order.find((p) => offered.includes(p) && !beaten(target.styles, scope, shown, long, 'gap', p, GAP_NAMES[axis]));
  if (!property) return null;
  const axes: GapAxis[] = [axis];
  const other = OTHER[axis];
  if (property === 'gap' && !beaten(target.styles, scope, shown, LONGHAND[other], 'gap', 'gap', GAP_NAMES[other])) axes.push(other);
  const cardKeeps = (own: SpacingTarget['styles']) => axes.some((a) => [rulesAt(own, 'base'), rulesAt(own, shown)].some((r) => setsSide(r, LONGHAND[a], 'gap', GAP_NAMES[a])));
  if (target.everyItem && target.items && Object.values(target.items).some(cardKeeps)) return null;
  return { axis, property, label: STYLE_PROP_MAP[property]?.label ?? property, axes };
}

/** The CSS a gap preview gives the box: each gap that moves, set to the value. */
export const gapDecls = (plan: GapPlan, value: StyleValue): Array<[string, string]> => plan.axes.map((a) => [LONGHAND_CSS[a], cssOf(value)]);

// ---------------------------------------------------------------------------
// Max width
// ---------------------------------------------------------------------------

/** Within this many frame pixels of a page-width site style, a width drag takes the style. */
export const WIDTH_MAGNET = 16;
/** Otherwise it moves in steps of this many frame pixels (Alt or Option for whole pixels). */
export const WIDTH_STEP = 8;

/**
 * Whether the selection's max width can be dragged: offered here, at the size the canvas shows, on a box centred by
 * its margins, with nothing set that would keep it where it is (a value of the size shown, Custom CSS, or a card's
 * own for a change to every card).
 */
export function planWidth(target: SpacingTarget, scope: ResponsiveScope, shown: Size, layout: FrameLayout | null): { property: 'maxWidth'; label: string } | null {
  if (scope !== 'base' && scope !== shown) return null;
  if (!target.offered.includes('maxWidth') || !layout?.width?.centered) return null;
  const names = ['max-width'];
  if (beaten(target.styles, scope, shown, 'maxWidth', null, 'maxWidth', names)) return null;
  if (target.everyItem && target.items && Object.values(target.items).some((own) => [rulesAt(own, 'base'), rulesAt(own, shown)].some((r) => setsSide(r, 'maxWidth', null, names)))) return null;
  return { property: 'maxWidth', label: STYLE_PROP_MAP.maxWidth?.label ?? 'Max width' };
}

/**
 * Where a width drag starts and how far it can go, in the box max width sizes (its content box, unless it sizes its
 * border box): the width it shows, and the most its container gives it. Null for a box its max width does not size
 * now (narrower than both, as one sized to its content is), where a drag would not show what it saves.
 */
export function widthReach(layout: FrameLayout, edges: BoxEdges): { start: number; most: number; max: number | null } | null {
  const w = layout.width;
  if (!w) return null;
  const { padding: p, border: b } = edges;
  const extra = w.content ? p.left + p.right + b.left + b.right : 0;
  const start = layout.box.width - extra;
  const most = w.basis - extra;
  if (!(most > 0) || !(start >= 0)) return null;
  const capped = w.max !== null && Math.abs(start - w.max) < 1;
  const full = Math.abs(start - most) < 1;
  return capped || full ? { start, most, max: w.max } : null;
}

/**
 * What a width drag to `px` writes, kept between nothing and the width the container gives (`most`). Snapped, the
 * nearest page-width site style within WIDTH_MAGNET of it (of two that close, the narrower), otherwise the nearest
 * WIDTH_STEP; exact, whole pixels. A style wider than the container shows as wide as the container, so it is taken
 * only by a drag out to the container's edge: short of it, the box would not show the width it saves. Past the
 * container's width with no narrower max width to lift, it leaves the box as it is.
 */
export function widthDragValue(px: number, stops: SpaceStop[], exact: boolean, reach: { most: number; max: number | null }): DragValue {
  const { most, max } = reach;
  const raw = finite(px) ? px : 0;
  const v = Math.min(most, Math.max(0, raw));
  if (raw >= most - 0.5 && (max === null || max >= most - 0.5)) return { value: '', px: max ?? most, keep: true };
  if (exact) {
    const whole = Math.round(v);
    return { value: whole === 0 ? '0' : `${whole}px`, px: whole };
  }
  let best: SpaceStop | null = null;
  let gap = WIDTH_MAGNET;
  const atEdge = v >= most - 0.5;
  for (const s of spaceScale(stops)) {
    const d = s.px >= most - 0.5 ? (atEdge ? 0 : Infinity) : Math.abs(s.px - v);
    if (d < gap) {
      best = s;
      gap = d;
    }
  }
  if (best) return { value: { token: best.token }, px: best.px, stop: best };
  const step = Math.round(v / WIDTH_STEP) * WIDTH_STEP;
  const whole = step > most ? Math.floor(most) : step;
  return { value: whole === 0 ? '0' : `${whole}px`, px: whole };
}

export const widthDecls = (value: StyleValue): Array<[string, string]> => [['max-width', cssOf(value)]];

// ---------------------------------------------------------------------------
// Column sizes
// ---------------------------------------------------------------------------

/** The splits a column divider snaps to, as the left column's part of the two: 1:4, 1:3, 1:2, 2:3, 1:1 and back. */
export const RATIO_STOPS = [1 / 5, 1 / 4, 1 / 3, 2 / 5, 1 / 2, 3 / 5, 2 / 3, 3 / 4, 4 / 5];
/** The narrowest either column of a pair gets, as its part of the two. */
/** The least share of its pair a column keeps when a divider is dragged. */
export const MIN_SPLIT = 0.05;
/** Where column sizes for All sizes apply: from tablet up, as the stylesheet writes them. */
export const WIDE_MEDIA = '(min-width: 768px)';

/** The rules on a target, weakest first, as the stylesheet cascades them: its design's, then its own. */
function targetLayers(state: ProjectState, target: SpacingTarget): StyleLayer[] {
  if (!target.partId) return [{ styles: target.styles, strength: 1 }];
  const node = treeFor(state, target.owner)?.nodes[target.nodeId];
  if (node?.kind !== 'instance') return [];
  const inst = node as InstanceNode;
  const def = Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  if (!def) return [];
  const part = Object.hasOwn(def.parts, target.partId) ? def.parts[target.partId] : undefined;
  const nodeId = part?.nodeId ?? (target.partId === 'root' ? def.tree?.rootIds[0] : undefined);
  const layers: StyleLayer[] = nodeId ? designLayers(def, nodeId, inst.variants) : [];
  // One card's own styles beat the placement's for every card.
  layers.push({ styles: target.itemId ? inst.overrides?.[target.partId] : target.styles, strength: 3, wideColumns: true });
  if (target.itemId) layers.push({ styles: target.styles, strength: 4, wideColumns: true });
  return layers;
}

/**
 * The value a selection shows at a size for the first of `properties` set, as the stylesheet cascades it (its design
 * with its variants, the placement, a card's own): what the readout names before a drag. Undefined when none of
 * these sets it (the theme's own CSS does), so a size is never named after a style it was not given.
 */
export function shownSpacing(state: ProjectState, target: SpacingTarget, shown: Size, properties: string[]): StyleValue | undefined {
  const at = cascadeStyles(targetLayers(state, target))[shown] ?? {};
  for (const p of properties) if (at[p] !== undefined) return at[p];
  return undefined;
}

/** The columns a target's grid has at a size, as fr shares: from its column sizes, or its column count. Null for
 *  anything else (a fixed or content-sized column, as many as fit). */
export function shownShares(state: ProjectState, target: SpacingTarget, shown: Size): number[] | null {
  const at = cascadeStyles(targetLayers(state, target))[shown] ?? {};
  if (at.gridTemplate !== undefined) return gridTemplateShares(at.gridTemplate);
  if (at.columns === undefined) return null;
  const n = Number(at.columns);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? Array.from({ length: n }, () => 1) : null;
}

export interface SplitPlan {
  property: 'gridTemplate';
  label: string;
  /** Each column's fr share now. */
  shares: number[];
}

const GRID_NAMES = ['grid-template-columns', 'grid-template', 'grid'];

/**
 * Whether a grid's columns can be resized by their dividers: Column sizes offered here, at the size the canvas shows
 * (under All sizes not on a phone, which column sizes for All sizes leave its own layout), on a grid of two or more fr
 * columns (or a column count) that the page shows as wide as those shares make them, with nothing set that would keep
 * them (column sizes of the size shown under a change for All sizes, Custom CSS, or a card's own for a change to every
 * card).
 */
export function planSplit(state: ProjectState, target: SpacingTarget, scope: ResponsiveScope, shown: Size, layout: FrameLayout | null, edges: BoxEdges): SplitPlan | null {
  if (scope === 'base' ? shown === 'phone' : scope !== shown) return null;
  if (!target.offered.includes('gridTemplate') || layout?.kind !== 'grid' || layout.columnGap === null) return null;
  const shares = shownShares(state, target, shown);
  if (!shares || shares.length < 2 || shares.length !== layout.cols.length) return null;
  // The page shows each column as wide as its share makes it, so nothing else (Custom CSS, a stronger rule) sizes
  // them: fr shares of less than 1 in all take only that part of the room.
  const room = contentBox(layout, edges).width - layout.columnGap * (shares.length - 1);
  const parts = Math.max(1, sum(shares));
  if (!(room > 0) || layout.cols.some((c, i) => Math.abs(c - (room * shares[i]) / parts) > 1.5)) return null;
  const own = (sc: ResponsiveScope) => rulesAt(target.styles, sc);
  if (scope === 'base' && (own(shown).gridTemplate !== undefined || customSets(own(shown).customCss, GRID_NAMES))) return null;
  if (customSets(own(scope).customCss, GRID_NAMES)) return null;
  const cardKeeps = (r: Record<string, StyleValue>) => r.gridTemplate !== undefined || r.columns !== undefined || customSets(r.customCss, GRID_NAMES);
  if (target.everyItem && target.items && Object.values(target.items).some((s) => cardKeeps(rulesAt(s, 'base')) || cardKeeps(rulesAt(s, shown)))) return null;
  return { property: 'gridTemplate', label: STYLE_PROP_MAP.gridTemplate?.label ?? 'Column sizes', shares };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** A share rounded to at least four places, and to four significant figures of a pair that small. */
const roundIn = (n: number, pair: number) => {
  const places = Math.min(10, Math.max(4, 4 - Math.floor(Math.log10(pair))));
  return Math.round(n * 10 ** places) / 10 ** places;
};

/** Column sizes as written: each share as fr. */
export const sharesText = (shares: number[]) => shares.map((n) => `${n}fr`).join(' ');

/** Column sizes as a person reads them: each column's part of the row, in whole percent ("60% · 40%"). */
export function sharesPercent(shares: number[]): string {
  const total = sum(shares);
  return total > 0 ? shares.map((n) => `${Math.round((n / total) * 100)}%`).join(' · ') : '';
}

/**
 * Where dragging the divider after column `index` by `travel` frame pixels gets to, from columns `a` and `b` pixels
 * wide. The two columns trade width and keep their total share; the others stay. Snapped, the split is the nearest of
 * RATIO_STOPS or the split it started at; exact, where the pointer is, in hundredths. Back where it started, the
 * columns are as they were, however narrow one of them was. Two columns that fill the grid are written with the
 * narrower one as 1fr (1fr 2fr, 1.5fr 1fr); otherwise each share is kept to four significant figures of the pair, so
 * the pair keeps its total and the split its ratio. Null when a column would get no share.
 */
export function splitDragValue(shares: number[], index: number, a: number, b: number, travel: number, exact: boolean, rtl: boolean): { value: string; shares: number[] } | null {
  if (index < 0 || index + 1 >= shares.length || !(a + b > 0)) return null;
  const d = (finite(travel) ? travel : 0) * (rtl ? -1 : 1);
  const from = a / (a + b);
  const f = Math.min(1 - MIN_SPLIT, Math.max(MIN_SPLIT, (a + d) / (a + b)));
  const pick = exact ? f : [...RATIO_STOPS, from].reduce((best, s) => (Math.abs(s - f) < Math.abs(best - f) ? s : best));
  if (exact ? Math.abs(d) < 0.5 : pick === from) return { value: sharesText(shares), shares: [...shares] };
  const pair = shares[index] + shares[index + 1];
  let next = [...shares];
  if (shares.length === 2 && pair >= 1) {
    const r = pick / (1 - pick);
    next = r >= 1 ? [round2(r), 1] : [1, round2(1 / r)];
  } else {
    const left = roundIn(pair * pick, pair);
    next[index] = left;
    next[index + 1] = roundIn(pair - left, pair);
  }
  return next.every((n) => n > 0) ? { value: sharesText(next), shares: next } : null;
}

/** Whether two splits lay columns out alike: the same parts, and (where they do not fill the grid) the same total. */
export function sameSplit(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  const sa = sum(a);
  const sb = sum(b);
  if ((sa < 1 || sb < 1) && Math.abs(sa - sb) > 1e-3) return false;
  return a.every((n, i) => Math.abs(n / sa - b[i] / sb) < 1e-3);
}

/** The CSS a column preview gives the grid: its columns as the stylesheet writes these sizes. */
export function splitDecls(value: string): Array<[string, string]> {
  const decl = styleToCss('gridTemplate', value)[0];
  return decl ? [['grid-template-columns', decl.slice(decl.indexOf(':') + 1).trim()]] : [];
}

/** The media query a column preview applies under: for All sizes, tablet up, where the stylesheet applies it. */
export const splitMedia = (scope: ResponsiveScope): string | null => (scope === 'base' ? WIDE_MEDIA : previewMedia(scope));

// ---------------------------------------------------------------------------
// Keeping handles apart
// ---------------------------------------------------------------------------

/** A handle on the overlay: where it sits and which way it drags. */
export interface Spot {
  x: number;
  y: number;
  axis: 'x' | 'y';
}
/** Each handle's hit box in overlay pixels, as .ov-space-handle draws it: 24px square either way (WCAG 2.5.8). */
const HIT = { x: { w: 24, h: 24 }, y: { w: 24, h: 24 } };
const overlaps = (a: Spot, b: Spot) => Math.abs(a.x - b.x) * 2 < HIT[a.axis].w + HIT[b.axis].w && Math.abs(a.y - b.y) * 2 < HIT[a.axis].h + HIT[b.axis].h;

/**
 * Where a handle can sit clear of those already placed, so a press always reaches the handle it was aimed at: at
 * `prefer`, or the nearest point to it along `slide` (a stretch of its gutter or edge, `from` to `to` along one axis)
 * where it touches none of them (of two as near, the later one along). Null when the whole stretch is taken.
 */
export function freeSpot(placed: Spot[], prefer: Spot, slide: { along: 'x' | 'y'; from: number; to: number }): Spot | null {
  if (!(slide.to >= slide.from)) return null;
  const down = slide.along === 'y';
  const across = down ? prefer.x : prefer.y;
  const size = (s: Spot) => (down ? HIT[s.axis].h : HIT[s.axis].w);
  const width = (s: Spot) => (down ? HIT[s.axis].w : HIT[s.axis].h);
  // Each handle level with the moving one keeps it out of the open stretch around it.
  const blocked = placed.flatMap((p) => {
    if (Math.abs((down ? p.x : p.y) - across) * 2 >= width(p) + width(prefer)) return [];
    const at = down ? p.y : p.x;
    const half = (size(p) + size(prefer)) / 2;
    return [[at - half, at + half] as const];
  });
  const start = Math.min(slide.to, Math.max(slide.from, down ? prefer.y : prefer.x));
  const free = (v: number) => v >= slide.from && v <= slide.to && blocked.every(([a, b]) => v <= a || v >= b);
  const spots = [start, ...blocked.flat()].filter(free);
  if (!spots.length) return null;
  const best = spots.reduce((m, v) => {
    const d = Math.abs(v - start);
    const dm = Math.abs(m - start);
    return d < dm || (d === dm && v > m) ? v : m;
  });
  return down ? { ...prefer, y: best } : { ...prefer, x: best };
}
