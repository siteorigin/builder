/**
 * Shape checks for what the preview frame sends. The previewed site runs project code (custom components
 * included), so its messages are read as untrusted input: anything malformed is dropped, never thrown on.
 */
import type { BridgeDesc } from './model';

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_RECTS = 500;
const MAX_CHAIN = 1000;
const MAX_FIELD = 2000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = MAX_FIELD): v is string => typeof v === 'string' && v.length <= max;

export function isRect(v: unknown): v is FrameRect {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width >= 0 && r.height >= 0;
}

/**
 * `next`, or `was` when it holds the same boxes in the same order: what is drawn from the boxes is left alone while the
 * page reports them unmoved (it reports every frame while anything on it moves).
 */
export function sameRects<T extends FrameRect>(next: T[], was: T[]): T[] {
  return next.length === was.length && next.every((r, i) => r.x === was[i].x && r.y === was[i].y && r.width === was[i].width && r.height === was[i].height) ? was : next;
}

/** A list of element boxes; anything that is not one is left out. */
export function rectList(v: unknown): FrameRect[] {
  if (!Array.isArray(v)) return [];
  return Array.from(v.slice(0, MAX_RECTS)).filter(isRect).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
}

export interface FrameSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The selected element's padding, border widths and margin, in frame pixels, its writing direction, and the
 *  selection it was measured for. */
export interface FrameSpacing {
  padding: FrameSides;
  border: FrameSides;
  margin: FrameSides;
  rtl: boolean;
  desc: BridgeDesc;
  /** How the box lays out what it holds and sits in its container, for its gap, width and column handles. */
  layout: FrameLayout | null;
}

/** The most children a stack's gap handles are placed between, and the most rows a grid's are. */
export const MAX_LAYOUT_ITEMS = 50;
const MAX_COLUMNS = 12;

/**
 * The selected box's layout, in frame pixels, as its gap, max width and column handles need it. `box` is its
 * border box, measured with the rest, so the other boxes can be placed against the outline the editor draws.
 */
export interface FrameLayout {
  box: FrameRect;
  /** Its content box: inside its padding, border and any scrollbar (on either side). Null when the page did not say. */
  inner: FrameRect | null;
  kind: 'flex' | 'grid' | 'block';
  /** The gaps the page uses now, in pixels (0 for `normal`); null where it could not say (one worked out with calc()). */
  rowGap: number | null;
  columnGap: number | null;
  /** A stack: its items run top to bottom, and may wrap onto more lines. */
  column: boolean;
  wrap: boolean;
  /** A stack spreads its spare room between its items (space between, around or evenly), so a gap may not show. */
  spread: boolean;
  /** A stack's items in the page's order, each one's border box. */
  items: FrameRect[];
  /** A grid's columns and rows as the page sizes them, in order (the first column is on the right of a right-to-left page). */
  cols: number[];
  rows: number[];
  /** A grid's columns and rows start at its start edge: its spare room, if any, is after them. */
  packedCols: boolean;
  packedRows: boolean;
  /**
   * How wide it may be: centred in its container by margins on both sides (`auto`), its max width (null for none),
   * whether that width leaves out its padding and border, and the width its container gives it.
   */
  width: { centered: boolean; max: number | null; content: boolean; basis: number } | null;
}

const size = (n: unknown): n is number => finite(n) && n >= 0 && n < 100000;
// Array.from visits holes too (every and map would skip them, and let a sparse list through).
const list = (v: unknown, max: number): unknown[] | null => (Array.isArray(v) && v.length <= max ? Array.from(v) : null);
const sizes = (v: unknown, max: number): number[] | null => {
  const l = list(v, max);
  return l && l.every(size) ? (l as number[]) : null;
};
const gapOf = (v: unknown): number | null | undefined => (v === null ? null : size(v) ? v : undefined);

/** The layout the frame reports for the selection; null for anything malformed. A malformed list is dropped whole:
 *  one column left out would put every handle after it on the wrong gap. */
export function layoutOf(v: unknown): FrameLayout | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const rowGap = gapOf(r.rowGap);
  const columnGap = gapOf(r.columnGap);
  if (!isRect(r.box) || (r.kind !== 'flex' && r.kind !== 'grid' && r.kind !== 'block') || rowGap === undefined || columnGap === undefined) return null;
  const listed = list(r.items, MAX_LAYOUT_ITEMS);
  const items = listed && listed.every(isRect) ? (listed as FrameRect[]).map((i) => ({ x: i.x, y: i.y, width: i.width, height: i.height })) : [];
  const w = r.width && typeof r.width === 'object' ? (r.width as Record<string, unknown>) : null;
  const width = w && size(w.basis) && (w.max === null || size(w.max)) ? { centered: w.centered === true, max: w.max as number | null, content: w.content === true, basis: w.basis } : null;
  const i = r.inner && typeof r.inner === 'object' ? (r.inner as Record<string, unknown>) : null;
  const inner = i && finite(i.x) && finite(i.y) && size(i.width) && size(i.height) ? { x: i.x, y: i.y, width: i.width, height: i.height } : null;
  return {
    box: { x: r.box.x, y: r.box.y, width: r.box.width, height: r.box.height },
    inner,
    kind: r.kind,
    rowGap,
    columnGap,
    column: r.column === true,
    wrap: r.wrap === true,
    spread: r.spread === true,
    items: r.kind === 'flex' ? items : [],
    cols: (r.kind === 'grid' && sizes(r.cols, MAX_COLUMNS)) || [],
    rows: (r.kind === 'grid' && sizes(r.rows, MAX_LAYOUT_ITEMS)) || [],
    packedCols: r.packedCols === true,
    packedRows: r.packedRows === true,
    width
  };
}

function sidesOf(v: unknown, signed: boolean): FrameSides | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => finite(n) && Math.abs(n) < 100000 && (signed || n >= 0);
  return ok(r.top) && ok(r.right) && ok(r.bottom) && ok(r.left) ? { top: r.top, right: r.right, bottom: r.bottom, left: r.left } : null;
}

/** The spacing the frame reports for the selection; null for anything malformed (or none sent). */
export function spacingOf(v: unknown): FrameSpacing | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const padding = sidesOf(r.padding, false);
  const border = sidesOf(r.border, false);
  const margin = sidesOf(r.margin, true);
  if (!padding || !border || !margin || !str(r.ctx) || !str(r.node) || !str(r.items)) return null;
  return { padding, border, margin, rtl: r.rtl === true, desc: { ctx: r.ctx, node: r.node, items: r.items }, layout: layoutOf(r.layout) };
}

/** The room an empty page keeps for its first step, in frame pixels, with the page it was asked for. */
export interface FrameEmptyArea {
  key: string;
  top: number;
  height: number;
  headerBottom: number;
}

export function emptyAreaOf(v: unknown): FrameEmptyArea | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!str(r.key) || !finite(r.top) || !finite(r.height) || r.height < 0 || !finite(r.headerBottom)) return null;
  return { key: r.key, top: r.top, height: r.height, headerBottom: r.headerBottom };
}

/** Spacing site style sizes in request order, null where one has none; null for a malformed list. */
export function spaceSizes(v: unknown, expected: number): Array<number | null> | null {
  if (!Array.isArray(v) || v.length !== expected) return null;
  return Array.from(v, (n) => (finite(n) && n >= 0 && n < 100000 ? n : null));
}

/** Measured boxes in request order, where a missing (hidden) element is null; null for a malformed list. Each
 *  box has its element's CSS order (0 unless an Order style moves it among its siblings). */
export function measuredRects(v: unknown, expected: number): Array<(FrameRect & { order: number; ordered?: true; many?: true; cssOrder?: number }) | null> | null {
  if (!Array.isArray(v) || v.length !== expected) return null;
  // Array.from visits holes too (map would skip them and leave them empty). `ordered`: its container lays its items out
  // by CSS order. `many`: more than one copy shows. `cssOrder`: its own Order, where that is not the one it is laid out
  // by (its container ignores Order).
  return Array.from(v, (r) => {
    if (!isRect(r)) return null;
    const f = r as { order?: unknown; ordered?: unknown; many?: unknown; cssOrder?: unknown };
    const own = typeof f.cssOrder === 'number' && Number.isSafeInteger(f.cssOrder) ? { cssOrder: f.cssOrder } : {};
    return { x: r.x, y: r.y, width: r.width, height: r.height, order: orderOf(f.order), ...(f.ordered === true ? { ordered: true as const } : {}), ...(f.many === true ? { many: true as const } : {}), ...own };
  });
}
const orderOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);

function isDesc(v: unknown): v is BridgeDesc {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    str(d.ctx) &&
    str(d.node) &&
    str(d.items) &&
    (d.tag === undefined || str(d.tag, 200)) &&
    (d.text === undefined || str(d.text, 400)) &&
    (d.code === undefined || typeof d.code === 'boolean') &&
    (d.part === undefined || str(d.part, 200)) &&
    (d.slot === undefined || str(d.slot, 200))
  );
}

/** The element chain under the pointer, innermost first. A chain with any malformed entry is empty. */
export function chainOf(v: unknown): BridgeDesc[] {
  if (!Array.isArray(v) || v.length > MAX_CHAIN || !Array.from(v).every(isDesc)) return [];
  // A code component's marked part keeps its ID, and a placement's empty slot its name; every other entry is as it
  // always was.
  return v.map((d: BridgeDesc) => ({ ctx: d.ctx, node: d.node, items: d.items, tag: d.tag, text: d.text, code: d.code, ...(d.part !== undefined ? { part: d.part } : {}), ...(d.slot !== undefined ? { slot: d.slot } : {}) }));
}

/** What the page says is at a point while something is dragged over it (see the bridge's pointAt), or null. */
export function pointedAt(v: unknown): { chain: BridgeDesc[]; rect: FrameRect | null; picture: { rect: FrameRect | null; src: string; own: boolean } | null; scroll: string } | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const box = (r: unknown) => (isRect(r) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
  // Where the page was scrolled to, as a key: boxes measured at another scroll no longer hold.
  const scroll = Array.isArray(p.scroll) && p.scroll.length === 2 && p.scroll.every(finite) ? p.scroll.join(',') : '';
  const pic = p.picture && typeof p.picture === 'object' ? (p.picture as Record<string, unknown>) : null;
  const picture = pic ? { rect: box(pic.rect), src: str(pic.src) ? pic.src : '', own: pic.own === true } : null;
  return { chain: chainOf(p.chain), rect: box(p.rect), picture, scroll };
}

/** An element descriptor the editor sent back (an edit's target), or null. */
export function descOrNull(v: unknown): BridgeDesc | null {
  return isDesc(v) ? v : null;
}

/** A placement's empty slot the page was asked to track, and where it shows (#657). */
export interface SlotBox {
  desc: BridgeDesc;
  box: FrameRect;
}

const MAX_SLOTS = 50;

/** The empty slots' boxes a page reports with its outlines (see the bridge's sendRects); a malformed entry is left out. */
export function slotBoxes(v: unknown): SlotBox[] {
  if (!Array.isArray(v)) return [];
  // Sliced by the array's own prototype: a page's array can carry a `slice` of its own.
  return (Array.prototype.slice.call(v, 0, MAX_SLOTS) as unknown[]).flatMap((e): SlotBox[] => {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : null;
    if (!o || !isDesc(o.desc) || typeof o.desc.slot !== 'string' || !isRect(o.box)) return [];
    const { ctx, node, items, slot } = o.desc;
    return [{ desc: { ctx, node, items, slot }, box: { x: o.box.x, y: o.box.y, width: o.box.width, height: o.box.height } }];
  });
}
