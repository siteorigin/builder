import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/**
 * The heights a grid's rows had when last drawn, by row, for one layout of it (`key`: its columns, width, the caller's
 * layout key and the tile count), and the height rows not yet drawn are taken to have: the first one measured, so an
 * estimate never moves the rows above the view as more are measured. Kept by whoever shows the grid, so a grid drawn
 * again (Back from an image's details) starts from them.
 */
export interface GridMeasures {
  key: string;
  heights: Map<number, number>;
  guess: number;
}
export const gridMeasures = (): GridMeasures => ({ key: '', heights: new Map(), guess: 0 });

export interface WindowedGridApi {
  /** Tiles to a row, as the grid is laid out now (1 before it has been). */
  columns(): number;
  /**
   * Put tile `index` in the page now, at its place in the grid, so it can be focused or scrolled to (the browser's own
   * focus and scrollIntoView then move the view to it). `scrollTop` first moves the scroller there, once the scroller
   * is as tall as the whole grid. Not for use while React renders or runs effects: it commits synchronously.
   */
  reveal(index: number, opts?: { scrollTop?: number }): void;
}

type Props = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** How many tiles the grid holds, and the one at an index. Each tile is one element, keyed by the caller. */
  count: number;
  tile: (index: number) => ReactNode;
  /** The element that scrolls the grid: an ancestor, or the grid itself when left out. */
  scroller?: RefObject<HTMLElement | null>;
  /** Tiles whose rows stay in the page wherever the view is: the grid's Tab stop, the tile with the focus. */
  keep?: ReadonlyArray<number | null | undefined>;
  measures?: GridMeasures;
  /** Changes when what the tiles are, or their size, changes without their number, the columns or the width changing
   *  (a new order or search, a density toggle): the rows measured before no longer apply. */
  layoutKey?: string;
  api?: Ref<WindowedGridApi | null>;
  /** The grid element, for a caller that reads it (its scroll position, the option with the focus). */
  gridRef?: RefObject<HTMLDivElement | null>;
};

/** Tiles drawn before the grid has been laid out once, so its first frame is never empty. */
const FIRST_TILES = 24;
/** Before any row has been measured. */
const ROW_GUESS = 120;
/** Marks the spacers standing in for rows not drawn. */
const GAP_ATTR = 'data-grid-gap';

interface Layout {
  cols: number;
  gap: number;
  /** The top of the first row, and the view's top and bottom, in the scroller's content (CSS px). */
  top: number;
  viewTop: number;
  viewBottom: number;
  width: number;
}

/** The grid's columns, row gap and place in its scroller's view; null while it has no layout (hidden, not drawn). */
function readLayout(grid: HTMLElement, scroller: HTMLElement): Layout | null {
  if (!grid.isConnected || !scroller.clientHeight || !grid.clientWidth) return null;
  const cs = getComputedStyle(grid);
  // Once laid out, the columns are told as one length each ("80px 80px 80px").
  const tracks = cs.gridTemplateColumns.trim().split(/\s+/).filter((t) => /^[\d.]+px$/.test(t));
  const cols = Math.max(1, tracks.length);
  const gap = parseFloat(cs.rowGap) || 0;
  const pad = parseFloat(cs.paddingTop) || 0;
  const top = scroller === grid ? pad : grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop + grid.clientTop + pad;
  return { cols, gap, top, viewTop: scroller.scrollTop, viewBottom: scroller.scrollTop + scroller.clientHeight, width: grid.clientWidth };
}

/** Each row's top from the first's, with the gap after it: `tops[r]`, and `tops[rows]` past the last row's gap. */
function rowTops(rows: number, gap: number, m: GridMeasures): Float64Array {
  const guess = m.guess || ROW_GUESS;
  const tops = new Float64Array(rows + 1);
  for (let r = 0; r < rows; r++) tops[r + 1] = tops[r] + (m.heights.get(r) ?? guess) + gap;
  return tops;
}

interface Win {
  cols: number;
  gap: number;
  /** Rows drawn, as sorted ranges [from, to) that neither touch nor overlap. */
  ranges: Array<[number, number]>;
  /** Moves on when a measured height changes what the spacers say. */
  v: number;
}

const sameRanges = (a: Win['ranges'], b: Win['ranges']) => a.length === b.length && a.every((r, i) => r[0] === b[i][0] && r[1] === b[i][1]);

/** `ranges` with the rows of the tiles kept, sorted and merged. */
function withKept(ranges: ReadonlyArray<[number, number]>, keep: ReadonlyArray<number | null | undefined>, cols: number, count: number): Array<[number, number]> {
  const all = ranges.map((r): [number, number] => [r[0], r[1]]);
  for (const i of keep) if (typeof i === 'number' && i >= 0 && i < count) all.push([Math.floor(i / cols), Math.floor(i / cols) + 1]);
  all.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

/** The rows in and around the view (half a view each side, a row at least), and the rows of the tiles kept. */
export function windowFor(l: Layout, count: number, m: GridMeasures, keep: ReadonlyArray<number | null | undefined>): Array<[number, number]> {
  const rows = Math.ceil(count / l.cols);
  if (!rows) return [];
  const tops = rowTops(rows, l.gap, m);
  const over = Math.max((l.viewBottom - l.viewTop) / 2, tops[1]);
  const from = l.viewTop - l.top - over;
  const to = l.viewBottom - l.top + over;
  let a = 0;
  while (a < rows - 1 && tops[a + 1] - l.gap <= from) a++;
  let b = a + 1;
  while (b < rows && tops[b] < to) b++;
  return withKept([[a, b]], keep, l.cols, count);
}

/**
 * A CSS grid of many tiles that puts in the page only the rows in or near its scroller's view, and the rows of the tiles
 * it keeps (#973): a library of 1,000 images is a few dozen tiles in the page, and only their pictures are held. The
 * rows left out are spacers of the height they had when last drawn (an estimate before then), so the scroller's height
 * and scroll position are the whole grid's, and the browser's focus, scrollIntoView and scroll anchoring work on it as
 * on the whole grid. Its CSS (columns, gaps, padding) is the caller's, as for any grid; its children are the tiles and
 * the spacers alone.
 */
export function WindowedGrid({ count, tile, scroller, keep = [], measures, layoutKey = '', api, gridRef, ...rest }: Props) {
  const own = useRef<HTMLDivElement>(null);
  const el = gridRef ?? own;
  const local = useRef<GridMeasures>(gridMeasures());
  const cache = measures ?? local.current;
  const [win, setWin] = useState<Win>({ cols: 0, gap: 0, ranges: [], v: 0 });
  // What the event handlers and the API read: the last committed render's.
  const now = useRef({ count, keep, layoutKey, win, cache, drawn: [] as number[] });
  // The tile last revealed, kept in the page until another is or the tiles change.
  const revealed = useRef<number | null>(null);
  const order: number[] = [];

  // An ancestor's ref is set only after this grid's first layout effect: until then there is no view to fit.
  const scrollerOf = () => (scroller ? scroller.current : el.current);
  /** The window for the layout now, measuring the rows drawn first; null when it is the one drawn, or there is no layout. */
  const next = (): Win | null => {
    const grid = el.current;
    const box = scrollerOf();
    if (!grid || !box) return null;
    const l = readLayout(grid, box);
    if (!l) return null;
    const { count, keep, layoutKey, win, cache, drawn } = now.current;
    const key = `${l.cols}|${Math.round(l.width)}|${layoutKey}|${count}`;
    let changed = false;
    if (cache.key !== key) {
      cache.key = key;
      cache.heights.clear();
      cache.guess = 0;
      changed = true;
    }
    if (win.cols === l.cols) {
      // A tile fills its row's height (grid items stretch), so a row's first tile tells it.
      let k = 0;
      for (const child of grid.children) {
        if (child.hasAttribute(GAP_ATTR)) continue;
        const i = drawn[k++];
        if (i === undefined || i % l.cols) continue;
        // Its layout height, untransformed (a popover opening scales its contents) and to the fraction of a pixel.
        const h = parseFloat(getComputedStyle(child).height) || (child as HTMLElement).offsetHeight;
        const r = i / l.cols;
        if (!h || Math.abs((cache.heights.get(r) ?? -1) - h) < 0.01) continue;
        // What the spacers took the row to be: drawn again only when that was off (the first row measured sets the
        // estimate for every row not yet drawn).
        const used = cache.heights.get(r) ?? (cache.guess || ROW_GUESS);
        cache.heights.set(r, h);
        if (!cache.guess) {
          cache.guess = h;
          changed = true;
        } else if (Math.abs(used - h) >= 0.5) changed = true;
      }
    }
    const ranges = windowFor(l, count, cache, [...keep, revealed.current]);
    if (!changed && win.cols === l.cols && win.gap === l.gap && sameRanges(ranges, win.ranges)) return null;
    return { cols: l.cols, gap: l.gap, ranges, v: win.v + (changed ? 1 : 0) };
  };
  const move = () => {
    const w = next();
    if (w) setWin(w);
  };

  // After every render: what was drawn is what the handlers read, its rows are measured and the window moves to the
  // view, before the frame is painted. A reveal is for the tiles it was made among.
  const last = useRef({ count, layoutKey });
  useLayoutEffect(() => {
    if (last.current.count !== count || last.current.layoutKey !== layoutKey) revealed.current = null;
    last.current = { count, layoutKey };
    now.current = { count, keep, layoutKey, win, cache, drawn: order };
    move();
  });
  // Scrolling and resizing (the view, the grid, a row drawn again at another height) move the window.
  const box = scroller ? scroller.current : null;
  useEffect(() => {
    const target = scrollerOf();
    const grid = el.current;
    if (!target || !grid) return;
    move();
    target.addEventListener('scroll', move, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(move);
    ro?.observe(target);
    ro?.observe(grid);
    return () => {
      target.removeEventListener('scroll', move);
      ro?.disconnect();
    };
  }, [box]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(api, () => ({
    columns: () => Math.max(1, now.current.win.cols),
    reveal(index, opts) {
      const target = scrollerOf();
      if (index < 0 || index >= now.current.count) return;
      if (target && opts?.scrollTop !== undefined) {
        // Laid out first (the first frame draws a few tiles and no spacers), so the scroller can go that far.
        const w = next();
        if (w) flushSync(() => setWin(w));
        target.scrollTop = opts.scrollTop;
      }
      revealed.current = index;
      const w = next();
      if (w) flushSync(() => setWin(w));
    }
  }));

  const out: ReactNode[] = [];
  if (!win.cols) {
    // Not laid out yet: the first tiles, until the layout effect knows the columns and the view.
    for (let i = 0; i < Math.min(count, FIRST_TILES); i++) {
      out.push(tile(i));
      order.push(i);
    }
  } else {
    const rows = Math.ceil(count / win.cols);
    const tops = rowTops(rows, win.gap, cache);
    let end = 0;
    const spacer = (to: number) => {
      const h = tops[to] - tops[end] - win.gap;
      if (h > 0) out.push(<div key={`gap-${end}-${to}`} {...{ [GAP_ATTR]: '' }} aria-hidden="true" style={{ gridColumn: '1 / -1', height: h }} />);
    };
    // The tiles kept are drawn in this render, wherever the list put them: one the focus is on never leaves the page,
    // even for the render that first shows a list in which it has moved.
    for (const [a, b] of withKept(win.ranges, [...keep, revealed.current], win.cols, count)) {
      if (a >= rows) break;
      if (a > end) spacer(a);
      const to = Math.min(b, rows);
      for (let i = a * win.cols; i < Math.min(count, to * win.cols); i++) {
        out.push(tile(i));
        order.push(i);
      }
      end = to;
    }
    if (end < rows) spacer(rows);
  }
  return (
    <div ref={el} {...rest}>
      {out}
    </div>
  );
}
