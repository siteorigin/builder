import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ElementRef, ProjectState, ResponsiveScope, StyleValue, TokenGroup } from '@shared/types';
import { gridTemplateShares, scopeForWidth } from '@shared/styles';
import { api, commitOps, getState, useStore } from '../store';
import type { BridgeDesc } from '../lib/model';
import type { FrameRect, FrameSpacing } from '../lib/payload';
import { trackApply } from '../lib/pending';
import { forLabel, partName, refTo } from '../lib/edit-label';
import { chosenReach, reachVersion, subscribeReach } from '../lib/item-reach';
import {
  GRIP_HALF,
  SPACING_HANDLES,
  dragLabel,
  dragValue,
  draggedSize,
  groupSignature,
  groupTokens,
  paddingGripAt,
  planHandle,
  previewDecls,
  previewMedia,
  restLabel,
  sameStyleValue,
  spaceScale,
  spacingOp,
  spacingTarget,
  storedSpacing,
  type DragValue,
  type SpaceStop,
  type SpacingHandle,
  type SpacingTarget
} from '../lib/spacing-drag';
import {
  MIN_SPLIT,
  RATIO_STOPS,
  WIDTH_STEP,
  columnBoxes,
  contentBox,
  freeSpot,
  gapDecls,
  gutters,
  planGap,
  planSplit,
  planWidth,
  sameSplit,
  sharesPercent,
  shownSpacing,
  splitDecls,
  splitDragValue,
  splitMedia,
  widthDecls,
  widthDragValue,
  widthReach,
  type Spot,
  type SplitPlan
} from '../lib/layout-drag';

/** Screen pixels a press must travel before it is a drag rather than a click. */
const DRAG_START = 3;
const altName = api.platform === 'darwin' ? 'Option' : 'Alt';
/** Overlay pixels between a handle's centre and the readout beside it, and the readout's inset from the page's edge. */
const HUD_OFF = 18;
const HUD_INSET = 4;
/** How far apart, centre to centre, a margin handle stands outside the padding handle on its side. */
const STACK = 26;
/** The readout's hint on the value's line: the gap and margin before its rule, and the rule and space after it. */
const HINT_GAP = 6 + 2 + 9;
const HINT_RULE = 9;

/** Where a measured scale is taken: spacing styles on the page, a column gap against the box's width and a row gap
 *  against its height (as percentages of each are), widths in its container. */
type Scale = 'space' | 'gapX' | 'gapY' | 'width';
type Basis = 'page' | 'box' | 'boxHeight' | 'parent';
const SCALE_GROUP: Record<Scale, TokenGroup> = { space: 'space', gapX: 'space', gapY: 'space', width: 'container' };
const SCALE_BASIS: Record<Scale, Basis> = { space: 'page', gapX: 'box', gapY: 'boxHeight', width: 'parent' };

type Rect = { left: number; top: number; width: number; height: number };

/** One handle on the selected box: what it writes, where it sits, and where a drag of it gets to. */
interface Grip {
  /** Its test ID and key, the same for as long as the selection keeps it. */
  id: string;
  kind: 'padding' | 'margin' | 'gap' | 'width' | 'split';
  label: string;
  /** Which of the selection's handles of that name this is, for its accessible name ("top", "between columns 1 and 2"). */
  where: string;
  property: string;
  axis: 'x' | 'y';
  /** Where it sits, and what it lights while pointed at or dragged, in overlay pixels. */
  at: { x: number; y: number };
  bands: Rect[];
  /** The site styles it snaps to, measured on the page; none for column sizes. */
  scale: Scale | null;
  /** Its size when the press began, in frame pixels, for the HUD until the drag moves. */
  start: number;
  /** The value it has now, in words ("Large · 24px", "60% · 40%"): the readout before a drag moves, and "was" after. */
  rest: string;
  /** The pointer's travel along its axis that makes the value larger (a column divider: moves it right). */
  dir: 1 | -1;
  /** Its value now and its least and largest, as a slider announces them: pixels, or a divider's first column in percent. */
  now: number;
  least: number;
  most: number;
  /** Where the keyboard steps it: its value now as an amount (pixels, or a divider's first column's share of its pair),
   *  the amounts it stops at (site styles, width steps, clean splits), and the pointer travel that reaches an amount. */
  amount: number;
  stopsAt: (stops: SpaceStop[]) => number[];
  travelFor: (amount: number) => number;
  /** Where a drag of `travel` screen pixels along its axis gets to; null for nothing to show. */
  reach: (travel: number, zoom: number, stops: SpaceStop[], exact: boolean) => DragValue | null;
  decls: (value: StyleValue) => Array<[string, string]>;
  media: string | null;
  /** Whether a value is what the selection already has, so saving it changes nothing. */
  unchanged: (value: StyleValue) => boolean;
  text: (v: DragValue) => string;
  /** A column divider's columns as they were when it was drawn. */
  split?: SplitPlan;
}

interface Drag {
  id: string;
  pointer: number;
  el: HTMLElement;
  grip: Grip;
  target: SpacingTarget;
  scope: ResponsiveScope;
  x: number;
  y: number;
  zoom: number;
  /** The scale as the page measured it; null until it answers (and always for a grip with none). */
  stops: SpaceStop[] | null;
  at: { x: number; y: number; exact: boolean };
  moved: boolean;
  /** What the page is showing now. */
  value: DragValue | null;
  raf: number;
  desc: BridgeDesc;
  /** Settles once the page has said how large its site styles are (or did not answer in time). */
  measured: Promise<void>;
  revision: number;
  /** Begun on a page still showing the project before a save. */
  behind: boolean;
  /** Driven from the keyboard (arrow keys on a focused handle), not a pointer: saved on Enter or leaving the handle. */
  keyboard: boolean;
  opening: string | undefined;
  stop: () => void;
}

/**
 * Handles on the selected box for dragging its padding (each side), its margin (above and below), the gaps between
 * what it holds (in a stack or a grid), its max width (on a box centred in its container) and its columns' sizes (on
 * a grid of fr columns). A drag shows on the page as it moves, snapping to the site's spacing or page-width styles or
 * to clean column splits (Alt or Option for exact values), and is saved as one `node.setStyle` edit at the size being
 * edited when it is released: one Undo takes it back. Escape puts the page back and saves nothing. Handles show only
 * for what the inspector offers here, and only at the size the canvas is showing, so a drag always shows what it saves.
 */
export function SpacingHandles({ state, selection, desc, box, frame, spacing, zoom, post, measureSpace, onDragging, focusCanvas, pageBehind }: {
  state: ProjectState;
  selection: ElementRef;
  desc: BridgeDesc;
  /** The selected element's border box on screen, inside the overlay. */
  box: { left: number; top: number; width: number; height: number };
  /** The visible page's size on screen, which a grip stays inside. */
  frame?: { width: number; height: number };
  spacing: FrameSpacing;
  zoom: number;
  post: (type: string, payload?: unknown) => void;
  measureSpace: (vars: string[], desc: BridgeDesc, basis: Basis) => Promise<Array<number | null> | null>;
  onDragging: (on: boolean) => void;
  focusCanvas: () => void;
  /** The page still shows the project before a save the editor has (#755): its spacing was measured before the save. */
  pageBehind: () => boolean;
}) {
  const scope = useStore((s) => s.styleScope);
  const viewport = useStore((s) => s.viewport);
  const [hot, setHot] = useState<string | null>(null);
  /** The handle with keyboard focus, and whether Escape has put its readout away (until focus moves). */
  const [focused, setFocused] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(false);
  /** The drag in progress, as the readout says it: where it has got to, and whether it is exact or from the keyboard. */
  const [live, setLive] = useState<{ id: string; text: string; was: string; exact: boolean; keyboard: boolean } | null>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  /** A pointed-at handle's readout stays while the pointer crosses to it (WCAG 1.4.13): leaving clears it after this. */
  const leaving = useRef(0);
  const descId = useId();
  /** The readout's size as last drawn, so it can be kept on the page and off what it measures. */
  const [hudSize, setHudSize] = useState({ w: 0, h: 0, hint: 0 });
  const drag = useRef<Drag | null>(null);
  /** Each scale as the page last measured it for this box, with what it was measured for. */
  const known = useRef<Partial<Record<Scale, { sig: string; stops: SpaceStop[] }>>>({});
  /** What a scale is measured for: the site styles it is made of, and the width a percentage of them is taken of. */
  const signature = (scale: Scale): string | null => {
    const st = getState().snapshot?.state;
    if (!st) return null;
    const layout = spacing.layout;
    // The content box the page measured, as the bridge takes a percentage of it.
    const inner = layout && contentBox(layout, spacing);
    const basis = scale === 'gapX' ? inner?.width : scale === 'gapY' ? inner?.height : scale === 'width' ? layout?.width?.basis : 0;
    return `${groupSignature(st, SCALE_GROUP[scale])}|${Math.round(basis ?? -1)}`;
  };
  /** The last scale measured, while what it was measured for still holds. */
  const current = (scale: Scale): SpaceStop[] | null => {
    const k = known.current[scale];
    return k && k.sig === signature(scale) ? k.stops : null;
  };
  // The inspector's choice of one card or every card changes what the handles write.
  useSyncExternalStore(subscribeReach, reachVersion);
  const shown = scopeForWidth(viewport);
  const rtl = spacing.rtl;
  const target = spacingTarget(state, selection, chosenReach);
  const z = zoom;

  /** Ask the page how large a group of site styles is on this box: no answer in time leaves exact values. */
  const measure = (scale: Scale): Promise<SpaceStop[]> => {
    const st = getState().snapshot?.state;
    const group = SCALE_GROUP[scale];
    const tokens = st ? groupTokens(st, group).slice(0, 500) : [];
    const sig = signature(scale) ?? '';
    return measureSpace(
      tokens.map((x) => x.cssVar),
      desc,
      SCALE_BASIS[scale]
    ).then((px) => {
      if (!px) return current(scale) ?? [];
      const stops = tokens.flatMap((x, i) => (px[i] === null ? [] : [{ token: x.token, label: x.label, px: px[i]! }]));
      known.current[scale] = { sig, stops };
      return stops;
    });
  };

  /** The handles this selection has now, with where each sits on screen. */
  const gripsFor = (t: SpacingTarget): Grip[] => {
    const out: Grip[] = [];
    const stored = (property: string) => (v: StyleValue) => sameStyleValue(storedSpacing(t, scope, property), v);
    const st = getState().snapshot?.state;
    /** A value in words: its site style (as measured, or by name until it is) and size. */
    const said = (properties: string[], px: number, scale: Scale) => restLabel(st ? shownSpacing(st, t, shown, properties) : undefined, px, current(scale) ?? [], st ? groupTokens(st, SCALE_GROUP[scale]) : []);
    /** A spacing scale's stops as amounts, from none up. */
    const spaceStops = (stops: SpaceStop[]) => [0, ...spaceScale(stops).map((x) => x.px)];
    /** The largest a slider goes: the scale's largest stop, or the value now if that is larger. */
    const top = (px: number, scale: Scale) => Math.round(Math.max(px, ...(current(scale) ?? []).map((x) => x.px)));
    const { padding: pd, border: bd, margin: mg } = spacing;
    const midX = box.left + box.width / 2;
    const dragged = drag.current?.grip;
    // Kept inside the page only where the box's own edge is on it, as padding handles are (see paddingGripAt).
    const inside = (v: number, edge: number, size: number | undefined) => (size === undefined || edge < 0 || edge > size ? v : Math.max(GRIP_HALF, Math.min(v, size - GRIP_HALF)));
    const padAt: Partial<Record<SpacingHandle['side'], { x: number; y: number }>> = {};
    const spaceAt = (h: SpacingHandle) => {
      if (h.box === 'margin') {
        // On the margin's outer edge, in line with the padding handle on that side, and always outside it: margin is
        // drawn outside padding, as the box model has it, however thin either is.
        const pad = padAt[h.side];
        const edge = h.side === 'top' ? box.top : box.top + box.height;
        const outer = h.side === 'top' ? box.top - mg.top * z : edge + mg.bottom * z;
        const y = pad ? (h.side === 'top' ? Math.min(outer, pad.y - STACK) : Math.max(outer, pad.y + STACK)) : outer;
        return { x: midX, y: inside(y, edge, frame?.height) };
      }
      // The padding being dragged keeps its grip by its content's edge, as the pointer moves it, rather than in the
      // middle of the new band, which would leave the pointer behind.
      const at = paddingGripAt(box, bd, pd, h.side, z, dragged?.id === `spacing-padding-${h.side}` ? dragged.start : undefined, frame);
      padAt[h.side] = at;
      return at;
    };
    const band = (b: SpacingHandle['box'], side: SpacingHandle['side']): Rect => {
      const innerW = box.width - (bd.left + bd.right) * z;
      const innerH = box.height - (bd.top + bd.bottom) * z;
      if (b === 'margin') {
        const m = (side === 'top' ? mg.top : mg.bottom) * z;
        return { left: box.left, width: box.width, top: side === 'top' ? box.top - Math.max(0, m) : box.top + box.height + Math.min(0, m), height: Math.abs(m) };
      }
      if (side === 'top') return { left: box.left + bd.left * z, top: box.top + bd.top * z, width: innerW, height: pd.top * z };
      if (side === 'bottom') return { left: box.left + bd.left * z, top: box.top + box.height - (bd.bottom + pd.bottom) * z, width: innerW, height: pd.bottom * z };
      if (side === 'left') return { left: box.left + bd.left * z, top: box.top + bd.top * z, width: pd.left * z, height: innerH };
      return { left: box.left + box.width - (bd.right + pd.right) * z, top: box.top + bd.top * z, width: pd.right * z, height: innerH };
    };
    for (const h of SPACING_HANDLES) {
      const plan = planHandle(h, t, scope, shown, rtl);
      if (!plan) continue;
      const signed = h.box === 'margin';
      const start = h.box === 'padding' ? pd[h.side] : mg[h.side];
      let at = spaceAt(h);
      // Padding handles on a box smaller than two of them slide along their edges, clear of each other (the one held
      // stays under the pointer).
      if (h.box === 'padding') {
        if (dragged?.id === `spacing-padding-${h.side}`) at = h.axis === 'y' ? { ...at, x: dragged.at.x } : { ...at, y: dragged.at.y };
        else {
          // Along its edge, as far as the page lets a whole target sit.
          const keep = (v: number, size: number | undefined) => (size === undefined ? v : Math.max(GRIP_HALF, Math.min(v, size - GRIP_HALF)));
          const along =
            h.axis === 'y'
              ? { along: 'x' as const, from: keep(box.left - 60, frame?.width), to: keep(box.left + box.width + 60, frame?.width) }
              : { along: 'y' as const, from: keep(box.top - 60, frame?.height), to: keep(box.top + box.height + 60, frame?.height) };
          at = freeSpot(out.map((g) => ({ ...g.at, axis: g.axis })), { ...at, axis: h.axis }, along) ?? at;
        }
        padAt[h.side] = at;
      }
      // A margin handle that would still touch one already drawn (a box shorter than two handles) slides along its
      // edge to the nearest clear place, past the box's corners if need be.
      if (h.box === 'margin') {
        const edge = (v: number) => (frame ? Math.max(GRIP_HALF, Math.min(v, frame.width - GRIP_HALF)) : v);
        at = freeSpot(out.map((g) => ({ ...g.at, axis: g.axis })), { ...at, axis: 'y' }, { along: 'x', from: edge(box.left - 40), to: edge(box.left + box.width + 40) }) ?? at;
      }
      out.push({
        id: `spacing-${h.box}-${h.side}`,
        kind: h.box,
        label: plan.label,
        where: h.side,
        property: plan.property,
        axis: h.axis,
        at,
        bands: plan.sides.map((side) => band(h.box, side)),
        scale: 'space',
        start,
        rest: said([plan.property, ...(h.pair ? [h.pair] : [])], start, 'space'),
        dir: h.grow,
        now: Math.round(start),
        least: Math.min(0, Math.round(start)),
        most: top(start, 'space'),
        amount: start,
        stopsAt: spaceStops,
        travelFor: (px) => (px - start) * z * h.grow,
        reach: (travel, zm, stops, exact) => dragValue(draggedSize(h.box === 'padding' ? pd[h.side] : mg[h.side], travel, zm, h.grow, signed), stops, exact, signed),
        decls: (v) => previewDecls(plan, v, rtl),
        media: previewMedia(scope),
        unchanged: stored(plan.property),
        text: dragLabel
      });
    }
    const layout = spacing.layout;
    if (!layout) return out;
    // The page's boxes on screen: frame pixels from the selected box's corner, at the zoom.
    const sx = (x: number) => box.left + (x - layout.box.x) * z;
    const sy = (y: number) => box.top + (y - layout.box.y) * z;
    const onScreen = (r: FrameRect): Rect => ({ left: sx(r.x), top: sy(r.y), width: r.width * z, height: r.height * z });
    const edges = { padding: pd, border: bd };
    const all = gutters(layout, edges, rtl);
    // Each layout handle takes the nearest place along its gutter or edge that leaves every handle already drawn
    // reachable: padding and margin first, then the one being dragged, then dividers, gaps and widths. One with no
    // room left is not drawn.
    // Layout handles are gathered first and placed once all are known (see `place` below).
    type Slide = { along: 'x' | 'y'; from: number; to: number };
    // `also`: other places it may go where the first has no room (the other stretches of a gutter items interrupt).
    const wanted: Array<{ grip: Omit<Grip, 'at'>; prefer: { x: number; y: number }; slide: Slide; also?: Array<{ prefer: { x: number; y: number }; slide: Slide }> }> = [];
    const put = (grip: Omit<Grip, 'at'>, prefer: { x: number; y: number }, slide: Slide, also?: Array<{ prefer: { x: number; y: number }; slide: Slide }>) => void wanted.push({ grip, prefer, slide, also });
    // A divider being dragged keeps its columns while its own preview resizes them (the page no longer shows the split
    // they say), so it is drawn where its gutter has moved to.
    const split = planSplit(state, t, scope, shown, layout, edges) ?? drag.current?.grip.split ?? null;
    const cols = split && columnBoxes(layout, edges, rtl);
    if (split && cols) {
      for (const g of all.filter((x) => x.axis === 'x')) {
        const i = g.index;
        const r = onScreen(g.rect);
        const [a, b] = [layout.cols[i], layout.cols[i + 1]];
        // Near the top of its gutter, below the top padding's handle where that is in the way.
        const first = split.shares[i] / (split.shares[i] + split.shares[i + 1]);
        put(
          {
            id: `layout-split-${i}`,
            kind: 'split',
            label: split.label,
            where: `between columns ${i + 1} and ${i + 2}`,
            property: split.property,
            axis: 'x',
            bands: [onScreen(cols[i]), onScreen(cols[i + 1])],
            scale: null,
            start: 0,
            rest: sharesPercent(split.shares),
            dir: 1,
            now: Math.round(first * 100),
            least: Math.round(MIN_SPLIT * 100),
            most: Math.round((1 - MIN_SPLIT) * 100),
            amount: first,
            stopsAt: () => [MIN_SPLIT, ...RATIO_STOPS, 1 - MIN_SPLIT],
            // The first column's share of the pair, as the pointer would set it: its edge, moved across.
            travelFor: (f) => (f * (a + b) - a) * z * (rtl ? -1 : 1),
            reach: (travel, zm, _stops, exact) => {
              const v = splitDragValue(split.shares, i, a, b, travel / (zm > 0 ? zm : 1), exact, rtl);
              return v && { value: v.value, px: 0 };
            },
            decls: (v) => splitDecls(String(v)),
            media: splitMedia(scope),
            unchanged: (v) => sameSplit(gridTemplateShares(v), split.shares),
            text: (v) => sharesPercent(gridTemplateShares(v.value) ?? []),
            split
          },
          { x: r.left + r.width / 2, y: r.top + 12 },
          // Above the grid when its gutter has no room; on the stretch it sits on where items span the rest.
          { along: 'y', from: r.top - (g.pieces ? 0 : 24), to: r.top + r.height }
        );
      }
    }
    for (const axis of ['x', 'y'] as const) {
      const plan = planGap(axis, t, scope, shown);
      const start = axis === 'x' ? layout.columnGap : layout.rowGap;
      const mine = all.filter((g) => g.axis === axis);
      if (!plan || start === null || !mine.length) continue;
      // Every gutter the edit moves: Gap moves the other axis's too, where nothing keeps that one.
      const bands = all.filter((g) => plan.axes.includes(g.axis)).flatMap((g) => (g.pieces ?? [g.rect]).map(onScreen));
      const scale = axis === 'x' ? 'gapX' : 'gapY';
      // A stretch's middle, and the length of it a gap handle may slide along.
      const spotOn = (r: Rect) => ({ prefer: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, slide: axis === 'x' ? { along: 'y' as const, from: r.top, to: r.top + r.height } : { along: 'x' as const, from: r.left, to: r.left + r.width } });
      for (const g of mine) {
        const r = onScreen(g.rect);
        const past = g.pieces ? 0 : 24;
        put(
          {
            id: `layout-gap-${axis}-${g.index}`,
            kind: 'gap',
            label: plan.label,
            where: axis === 'x' ? 'between columns' : 'between rows',
            property: plan.property,
            axis,
            bands,
            scale,
            start,
            rest: said([plan.property, 'gap'], start, scale),
            dir: 1,
            now: Math.round(start),
            least: 0,
            most: top(start, scale),
            amount: start,
            stopsAt: spaceStops,
            travelFor: (px) => (px - start) * z,
            reach: (travel, zm, stops, exact) => dragValue(draggedSize(start, travel, zm, 1), stops, exact),
            decls: (v) => gapDecls(plan, v),
            media: previewMedia(scope),
            unchanged: stored(plan.property),
            text: dragLabel
          },
          { x: r.left + r.width / 2, y: r.top + r.height / 2 },
          // Just past either end of a gutter with no room in it (a short row whose padding handles fill its height), but
          // never past the stretch it sits on onto an item spanning the rest.
          axis === 'x' ? { along: 'y', from: r.top - past, to: r.top + r.height + past } : { along: 'x', from: r.left - past, to: r.left + r.width + past },
          g.pieces?.filter((p) => p !== g.rect).map((p) => spotOn(onScreen(p)))
        );
      }
    }
    const width = planWidth(t, scope, shown, layout);
    const wr = width && widthReach(layout, edges);
    if (width && wr) {
      // Both edges move: each is marked, so the one not held is seen to move too.
      const edgeMarks = [box.left, box.left + box.width].map((x) => ({ left: x, top: box.top, width: 0, height: box.height }));
      for (const side of ['left', 'right'] as const) {
        const grow = side === 'right' ? 1 : -1;
        put(
          {
            id: `layout-width-${side}`,
            kind: 'width',
            label: width.label,
            where: `${side} edge`,
            property: width.property,
            axis: 'x',
            bands: edgeMarks,
            scale: 'width',
            start: wr.start,
            rest: said([width.property], wr.start, 'width'),
            dir: grow,
            now: Math.round(wr.start),
            least: 0,
            most: Math.round(wr.most),
            amount: wr.start,
            // Page-width styles and the width steps between them, up to the container's width.
            stopsAt: (stops) => [...new Set([...spaceScale(stops).map((x) => x.px), ...Array.from({ length: Math.floor(wr.most / WIDTH_STEP) + 1 }, (_, k) => k * WIDTH_STEP), wr.most])].filter((v) => v <= wr.most).sort((m, n) => m - n),
            // Centred: both edges move, so the pointer goes half as far as the width changes.
            travelFor: (px) => ((px - wr.start) * z * grow) / 2,
            // Centred: both edges move, so the width changes twice as far as the pointer goes.
            reach: (travel, zm, stops, exact) => widthDragValue(draggedSize(wr.start, travel * 2, zm, grow), stops, exact, wr),
            decls: widthDecls,
            media: previewMedia(scope),
            unchanged: stored(width.property),
            text: dragLabel
          },
          // On its edge, kept on the page so the whole target can be reached.
          { x: frame ? Math.max(GRIP_HALF, Math.min(side === 'left' ? box.left : box.left + box.width, frame.width - GRIP_HALF)) : side === 'left' ? box.left : box.left + box.width, y: box.top + Math.min(box.height / 4, 40) },
          { along: 'y', from: box.top, to: box.top + box.height }
        );
      }
    }
    // The handle being dragged goes first, where it is shown: across its drag where it was pressed, along it where its
    // gutter or edge is now; the rest keep clear of it and of padding and margin, in order (dividers, gaps, widths).
    const held = drag.current?.grip;
    const placed: Spot[] = out.map((g) => ({ ...g.at, axis: g.axis }));
    const mine = held ? wanted.find((w) => w.grip.id === held.id) : undefined;
    if (held && mine) {
      // Kept on its gutter's stretch, which an item spanning the rest may move as the drag resizes it.
      const was = held.axis === 'x' ? held.at.y : held.at.x;
      const { slide } = [mine, ...(mine.also ?? [])].find((o) => was >= o.slide.from && was <= o.slide.to) ?? mine;
      const keep = (v: number) => Math.max(slide.from, Math.min(v, slide.to));
      const at = held.axis === 'x' ? { x: mine.prefer.x, y: keep(held.at.y) } : { x: keep(held.at.x), y: mine.prefer.y };
      placed.push({ ...at, axis: held.axis });
      out.push({ ...mine.grip, at });
    } else if (held && held.kind !== 'padding' && held.kind !== 'margin') placed.push({ ...held.at, axis: held.axis });
    for (const w of wanted) {
      if (w === mine) continue;
      const at = [{ prefer: w.prefer, slide: w.slide }, ...(w.also ?? [])].reduce<Spot | null>((got, o) => got ?? freeSpot(placed, { ...o.prefer, axis: w.grip.axis }, o.slide), null);
      if (!at) continue;
      placed.push(at);
      out.push({ ...w.grip, at: { x: at.x, y: at.y } });
    }
    // From the keyboard the held handle is placed first but listed in its own place, so Tab order never changes.
    if (drag.current?.keyboard) {
      const rank = new Map([...out.filter((g) => g.kind === 'padding' || g.kind === 'margin'), ...wanted.map((w) => w.grip)].map((g, i) => [g.id, i]));
      out.sort((m, n) => (rank.get(m.id) ?? 0) - (rank.get(n.id) ?? 0));
    }
    return out;
  };
  const grips = target ? gripsFor(target) : [];

  // Measured as the handles appear, so a drag rarely waits for it (and again when one starts, in case the site's
  // styles changed since).
  useEffect(() => {
    for (const s of new Set(grips.flatMap((g) => (g.scale ? [g.scale] : [])))) void measure(s);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Note whether the pointer has gone far enough to be a drag; its travel along the handle's axis. */
  const advance = (d: Drag): number => {
    const travel = d.grip.axis === 'y' ? d.at.y - d.y : d.at.x - d.x;
    if (Math.abs(travel) >= DRAG_START) d.moved = true;
    return travel;
  };

  /** Work out where a drag has got to and show it on the page. False while there is nothing to show yet. */
  const place = (d: Drag): boolean => {
    const travel = advance(d);
    // Snapped values wait for the page to say how large its site styles are.
    if (!d.moved || (!d.stops && !d.at.exact)) return false;
    const v = d.grip.reach(travel, d.zoom, d.stops ?? [], d.at.exact);
    if (!v) {
      // Nowhere this drag can go (a column with no share left): the page goes back, and a release saves nothing.
      if (d.value && !d.value.keep) post('spacingPreview', { drag: d.id, clear: true });
      d.value = null;
      return false;
    }
    // Preview shows the page as saved: a drag let go just before it shows nothing there.
    if ((!d.value || !!d.value.keep !== !!v.keep || !sameStyleValue(d.value.value, v.value)) && getState().mode === 'edit')
      post('spacingPreview', v.keep ? { drag: d.id, clear: true } : { drag: d.id, desc: d.desc, media: d.grip.media, decls: d.grip.decls(v.value) });
    d.value = v;
    return true;
  };

  /** Show where the drag in progress has got to, on the page and in the HUD. */
  const update = () => {
    const d = drag.current;
    if (!d) return;
    // "Was" is the value when the drag began: the handles' own words follow the page as the preview changes it.
    const say = (text: string) => setLive({ id: d.grip.id, text, was: d.grip.rest, exact: d.at.exact, keyboard: d.keyboard });
    // A value that leaves the box as it is (a max width dragged out past its container) reads as what it shows.
    if (place(d)) say(d.value!.keep ? d.grip.rest : d.grip.text(d.value!));
    // Somewhere it cannot go: the HUD says nothing will be saved, as the page shows.
    else if (d.moved && !d.value && (d.stops || d.at.exact)) say('No change');
    else say(d.grip.rest);
  };

  /** End the drag: listeners off, the pointer let go. What the page shows is the caller's to keep or put back. */
  const release = (): Drag | null => {
    const d = drag.current;
    if (!d) return null;
    drag.current = null;
    d.stop();
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.el.isConnected && d.el.hasPointerCapture(d.pointer)) d.el.releasePointerCapture(d.pointer);
    onDragging(false);
    setLive(null);
    return d;
  };

  /** Put the page back as it was and save nothing. */
  const cancel = () => {
    const d = release();
    if (d) post('spacingPreview', { drag: d.id, clear: true });
  };

  /**
   * Save the drag as one edit, and hand what the page shows over to it once the page has it. A release before the
   * page has said how large its site styles are waits for that, so the edit is where the pointer let go.
   */
  const finish = async (d: Drag) => {
    const clear = () => post('spacingPreview', { drag: d.id, clear: true });
    advance(d);
    if (d.moved && !d.stops && !d.at.exact) await d.measured;
    place(d);
    const { property } = d.grip;
    const v = d.value;
    // A click, or a drag that ends on what is saved already, changes nothing.
    if (!d.moved || !v || v.keep || d.grip.unchanged(v.value) || getState().snapshot?.workspaceKey !== d.opening) return clear();
    // Dragged from spacing the page measured before a save it had not shown yet: the value was read from the old page.
    if (d.behind || pageBehind()) return clear();
    try {
      const st = getState().snapshot?.state;
      const { owner, nodeId, partId } = d.target;
      // The part dragged, when it is not the placement itself: "Set vertical padding for Panel in Call to action on Home".
      const label = st ? forLabel(st, `Set ${d.grip.label.toLowerCase()}`, refTo(owner, nodeId), partName(st, owner, nodeId, partId)) : `Set ${d.grip.label.toLowerCase()}`;
      const r = await commitOps([spacingOp(d.target, d.scope, property, v.value)], label, undefined, d.revision);
      if (r?.ok) post('spacingPreview', { drag: d.id, handoff: r.revision });
      else clear();
    } catch {
      clear();
    }
  };

  const begin = (e: React.PointerEvent<HTMLDivElement>, drawn: Grip) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    const s = getState();
    const st = s.snapshot?.state;
    // Read again now: the card's reach may have been chosen in the inspector since this was drawn.
    const t = st ? spacingTarget(st, selection, chosenReach) : null;
    const grip = t && gripsFor(t).find((g) => g.id === drawn.id);
    if (!st || !t || !grip || !s.snapshot) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    // Escape reaches the editor, not a page that had the keyboard.
    focusCanvas();
    const id = Math.random().toString(36).slice(2);
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (d?.pointer !== ev.pointerId) return;
      d.at = { x: ev.clientX, y: ev.clientY, exact: ev.altKey };
      if (!d.raf)
        d.raf = requestAnimationFrame(() => {
          d.raf = 0;
          update();
        });
    };
    const up = (ev: PointerEvent) => {
      const d = drag.current;
      if (d?.pointer !== ev.pointerId) return;
      d.at = { x: ev.clientX, y: ev.clientY, exact: ev.altKey };
      release();
      // Followed as a save from here, so closing the project or saving waits for it.
      trackApply(finish(d).then(() => ({ ok: true })));
    };
    const lost = (ev: PointerEvent) => {
      if (drag.current?.pointer === ev.pointerId) cancel();
    };
    const key = (ev: KeyboardEvent) => {
      const d = drag.current;
      if (!d) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      } else if (ev.key === 'Alt' && d.at.exact !== (ev.type === 'keydown')) {
        // Holding or letting go of Alt switches between exact values and the snapped ones where the pointer is.
        d.at = { ...d.at, exact: ev.type === 'keydown' };
        update();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', lost);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    el.addEventListener('lostpointercapture', lost);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', lost);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      el.removeEventListener('lostpointercapture', lost);
    };
    const d: Drag = {
      id,
      pointer: e.pointerId,
      el,
      grip,
      target: t,
      scope,
      x: e.clientX,
      y: e.clientY,
      zoom,
      stops: grip.scale ? current(grip.scale) : [],
      at: { x: e.clientX, y: e.clientY, exact: e.altKey },
      moved: false,
      value: null,
      raf: 0,
      // A change for every card shows on every card.
      desc: t.everyItem ? { ...desc, items: '' } : desc,
      measured: Promise.resolve(),
      revision: s.snapshot.revision,
      opening: s.snapshot.workspaceKey,
      behind: pageBehind(),
      keyboard: false,
      stop
    };
    drag.current = d;
    if (grip.scale)
      d.measured = measure(grip.scale).then((stops) => {
        d.stops = stops;
        if (drag.current === d) update();
      });
    onDragging(true);
    // Until it moves, the readout says what the box has now, by its site style's name where it has one.
    setLive({ id: grip.id, text: grip.rest, was: grip.rest, exact: e.altKey, keyboard: false });
  };

  /**
   * Begin adjusting a focused handle from the keyboard: a drag with no pointer, moved by the arrow keys. It previews
   * on the page as a drag does, and is saved as one edit on Enter or when focus leaves the handle; Escape puts the
   * page back.
   */
  const beginKeys = (el: HTMLElement, drawn: Grip): Drag | null => {
    if (drag.current) return null;
    const s = getState();
    const st = s.snapshot?.state;
    const t = st ? spacingTarget(st, selection, chosenReach) : null;
    const grip = t && gripsFor(t).find((g) => g.id === drawn.id);
    if (!st || !t || !grip || !s.snapshot) return null;
    const d: Drag = {
      id: Math.random().toString(36).slice(2),
      pointer: -1,
      el,
      grip,
      target: t,
      scope,
      x: grip.at.x,
      y: grip.at.y,
      zoom,
      stops: grip.scale ? current(grip.scale) : [],
      at: { x: grip.at.x, y: grip.at.y, exact: false },
      // Changed only once a key has moved it: a key that goes nowhere leaves nothing to save.
      moved: false,
      value: null,
      raf: 0,
      desc: t.everyItem ? { ...desc, items: '' } : desc,
      measured: Promise.resolve(),
      revision: s.snapshot.revision,
      opening: s.snapshot.workspaceKey,
      behind: pageBehind(),
      keyboard: true,
      stop: () => undefined
    };
    drag.current = d;
    if (grip.scale)
      d.measured = measure(grip.scale).then((stops) => {
        d.stops = stops;
      });
    onDragging(true);
    return d;
  };

  /** Where a value sits along its scale: pixels, or a divider's first column's share of its pair. */
  const amountOf = (g: Grip, v: DragValue | null): number | null => {
    if (!v) return null;
    if (g.kind !== 'split' || !g.split) return v.px;
    const shares = gridTemplateShares(v.value);
    const i = Number(g.id.slice('layout-split-'.length));
    return shares && shares[i] + shares[i + 1] > 0 ? shares[i] / (shares[i] + shares[i + 1]) : null;
  };

  /**
   * Step a keyboard adjustment `times` stops in `way` (1 larger, -1 smaller; for a divider, its first column), or to
   * the end that way (`times` Infinity): to the next site style, width step or clean split, or with `exact` the next
   * whole pixel (or percent). The value is placed where the pointer would put it, so the drag's own rules (a width's
   * magnet, a split's rounding) decide what is shown and saved, as they do for a drag.
   */
  const step = async (el: HTMLElement, drawn: Grip, way: 1 | -1, times: number, exact: boolean) => {
    const d = drag.current ?? beginKeys(el, drawn);
    if (!d || !d.keyboard) return;
    if (!d.stops && d.grip.scale) await d.measured;
    if (drag.current !== d) return;
    const g = d.grip;
    const stops = d.stops ?? [];
    const split = g.kind === 'split';
    const unit = split ? 0.01 : 1;
    // Where it can go: a divider keeps each column a share; a max width stays within its container; padding and gaps
    // stop at none; a margin can go below none in exact pixels, as a drag can. Exact steps go past the largest style.
    const lo = split ? MIN_SPLIT : g.kind === 'margin' && exact ? -Infinity : 0;
    const hi = split ? 1 - MIN_SPLIT : g.kind === 'width' ? g.most : exact ? Infinity : Math.max(g.most, g.amount);
    const ends = times === Infinity;
    // A step is placed where the pointer would put it, so the drag's own rules (a width's magnet, a split's rounding)
    // decide what is shown and saved, as they do for a drag. An end goes straight there, whichever way the value is
    // now: none, or the largest site style (kept as that style); a divider's ends exactly; a width its container's.
    const exactly = ends ? split : exact;
    const reached = (amount: number) => amountOf(g, g.reach(g.travelFor(amount), d.zoom, stops, exactly));
    const past = (a: number | null, from: number) => a !== null && (way > 0 ? a > from + 1e-6 : a < from - 1e-6);
    const list = g.stopsAt(stops);
    let now = amountOf(g, d.value) ?? g.amount;
    let target: number | null = ends ? (way > 0 ? (split ? 1 - MIN_SPLIT : g.kind === 'width' ? g.most : Math.max(...list)) : split ? MIN_SPLIT : 0) : null;
    for (let n = 0; n < (ends ? 0 : times); n++) {
      // The candidates that way, nearest first; the first the drag's rules do not pull back is taken.
      const ahead = exact
        ? [Math.round(now / unit) * unit + way * unit]
        : way > 0
          ? list.filter((v) => v > now + 1e-6)
          : list.filter((v) => v < now - 1e-6).reverse();
      const next = ahead.map((v) => Math.min(hi, Math.max(lo, v))).find((v) => past(reached(v), now));
      if (next === undefined) break;
      target = next;
      now = reached(next)!;
    }
    // A width's end is its container's width: a page-width style where one fills it, else that many whole pixels
    // (not rounded to a width step).
    const endExact = ends && g.kind === 'width' && target !== null ? !g.reach(g.travelFor(target), d.zoom, stops, false)?.stop : exactly;
    // An end that would save what is set already (compared as a setting, so a pixel size the largest style matches
    // is still bound to that style) changes nothing.
    const ended = ends && target !== null ? g.reach(g.travelFor(target), d.zoom, stops, endExact) : null;
    const same = !!ended && (ended.keep || (d.value ? sameStyleValue(d.value.value, ended.value) && !!d.value.keep === !!ended.keep : g.unchanged(ended.value)));
    // Nowhere to go: a session this key began is let go at once, so the pointer can still take the handle.
    if (target === null || same) {
      if (!d.moved) release();
      return;
    }
    const travel = g.travelFor(target);
    d.moved = true;
    const ex = ends ? endExact : exactly;
    d.at = g.axis === 'y' ? { x: d.x, y: d.y + travel, exact: ex } : { x: d.x + travel, y: d.y, exact: ex };
    update();
  };

  /** Save a keyboard adjustment, as a drag released. */
  const saveKeys = () => {
    if (!drag.current?.keyboard) return;
    const d = release();
    if (d) trackApply(finish(d).then(() => ({ ok: true })));
  };

  const keyDown = (e: React.KeyboardEvent<HTMLDivElement>, g: Grip) => {
    const k = e.key;
    const keying = !!drag.current?.keyboard;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === 'Escape' && keying) return done(), cancel();
    // A focused handle's readout goes with the first Escape, focus staying; the next reaches the editor.
    if (k === 'Escape' && !drag.current && focused === g.id && !quiet) return done(), setQuiet(true);
    if (k === 'Enter' && keying) return done(), saveKeys();
    // A divider moves the way the arrow points; a value grows with Up or Right, as a slider does.
    const way: Record<string, [1 | -1, number]> = { ArrowUp: [1, 1], ArrowRight: [1, 1], ArrowDown: [-1, 1], ArrowLeft: [-1, 1], PageUp: [1, 3], PageDown: [-1, 3], End: [1, Infinity], Home: [-1, Infinity] };
    const w = way[k];
    if (!w || e.metaKey || e.ctrlKey || (drag.current && !keying)) return;
    done();
    // A divider moves the way the arrow points: on a right-to-left page its first column is on the right.
    if (g.kind === 'split' && (k === 'ArrowLeft' || k === 'ArrowRight')) return void step(e.currentTarget, g, (w[0] * (rtl ? -1 : 1)) as 1 | -1, 1, e.altKey);
    if (g.kind === 'split' && (k === 'ArrowUp' || k === 'ArrowDown')) return;
    void step(e.currentTarget, g, w[0], w[1], e.altKey);
  };

  // Whatever takes the handles away (another selection, size, zoom or page; the frame restarting) ends the drag.
  useEffect(() => () => cancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The handle being dragged stays while its own preview moves things about (a stack wrapping onto another line can
  // take its gutter away), so the pointer it holds is not lost.
  // It is drawn first, so React never moves its element (a moved element loses the pointer it holds), whatever the
  // others do.
  const dragged = drag.current?.grip;
  const shownDragged = dragged ? (grips.find((g) => g.id === dragged.id) ?? dragged) : null;
  // From the keyboard the handles keep their order, so Tab goes on from the one adjusted; a pointer holds no capture there.
  const held = !shownDragged ? grips : drag.current?.keyboard ? (grips.some((g) => g.id === shownDragged.id) ? grips : [...grips, shownDragged]) : [shownDragged, ...grips.filter((g) => g.id !== shownDragged.id)];
  // A handle pointed at is described over one with keyboard focus (whose ring stays); a readout put away with Escape
  // stays away for that handle, pointed at or focused, until focus moves.
  const hotShown = hot && !(quiet && hot === focused) ? hot : null;
  const activeId = live?.id ?? hotShown ?? (quiet ? null : focused);
  const active = held.find((g) => g.id === activeId);

  // The readout's size, measured once drawn, places it: beside its handle on whichever side keeps it on the page and
  // clear of the box a divider or max width measures.
  useLayoutEffect(() => {
    const el = hudRef.current;
    // From its parts, on one line or two, so either size is known whichever it is drawn as: the value line and the
    // hint (its text, without the rule that divides it from the value on one line).
    if (!el) return;
    const main = el.querySelector<HTMLElement>('.main');
    const hintEl = el.querySelector<HTMLElement>('.hint');
    if (!main) return;
    const stacked = el.classList.contains('stacked');
    const hint = hintEl ? hintEl.offsetWidth - (stacked ? 0 : HINT_RULE) : 0;
    const size = { w: 16 + main.offsetWidth + (hint ? HINT_GAP + hint : 0), h: main.offsetHeight + 4, hint };
    if (size.w !== hudSize.w || size.h !== hudSize.h || size.hint !== hudSize.hint) setHudSize(size);
  });
  // A pointed-at readout goes with Escape, as the page's other hover labels do, without moving the pointer.
  const hovering = !live && !!hotShown && hotShown !== focused;
  useEffect(() => {
    if (!hovering) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setHot(null);
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [hovering]);
  useEffect(() => () => clearTimeout(leaving.current), []);
  const stay = () => clearTimeout(leaving.current);
  const leave = (id: string) => {
    clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setHot((v) => (v === id ? null : v)), 600);
  };

  if (!held.length && !live) return null;
  /**
   * Where the readout goes: the first place, in the handle's own order, that is on the page and off what the handle
   * measures. A padding handle with room keeps it in its own band; otherwise it goes outside the selected box on the
   * handle's side, then beside the handle. A place along a row slides along it to stay on the page before it is given
   * up. Failing all, the first place, kept on the page.
   */
  const hudAt = (g: Grip): { left: number; top: number; stacked: boolean } => {
    const { w: wide, h: high, hint } = hudSize;
    // Two lines, the hint under the value: narrower, for a place that is deep enough but not wide enough.
    const tall = { w: Math.max(wide - HINT_GAP - hint, hint + 16), h: high + 22 };
    let w = wide;
    let h = high;
    const { x, y } = g.at;
    const fw = frame?.width ?? Infinity;
    const fh = frame?.height ?? Infinity;
    type Spot = { left: number; top: number; slide: 'x' | 'y'; stacked?: boolean };
    const right: Spot = { left: x + HUD_OFF, top: y - h / 2, slide: 'y' };
    const left: Spot = { left: x - HUD_OFF - w, top: y - h / 2, slide: 'y' };
    const below: Spot = { left: x - w / 2, top: y + HUD_OFF, slide: 'x' };
    const above: Spot = { left: x - w / 2, top: y - HUD_OFF - h, slide: 'x' };
    const overBox: Spot = { left: x - w / 2, top: box.top - 8 - h, slide: 'x' };
    const underBox: Spot = { left: x - w / 2, top: box.top + box.height + 8, slide: 'x' };
    const leftOfBox: Spot = { left: box.left - 8 - w, top: y - h / 2, slide: 'y' };
    const rightOfBox: Spot = { left: box.left + box.width + 8, top: y - h / 2, slide: 'y' };
    // Inside its own band, beside the handle on the side away from the box's edge, where the band is deep enough.
    const band = g.kind === 'padding' ? g.bands.find((r) => (g.axis === 'y' ? r.top <= y && y <= r.top + r.height : r.left <= x && x <= r.left + r.width)) : undefined;
    const inBand: Spot[] = !band
      ? []
      : g.axis === 'y'
        ? [
            ...(band.top + band.height - y >= HUD_OFF + h + 4 ? [below] : []),
            ...(y - band.top >= HUD_OFF + h + 4 ? [above] : []),
            // In the band's own row, beside the handle, where the band is at least the readout's height: on one line,
            // or on two where only that fits beside it.
            ...(band.height >= h + 8 ? [right, left].map((p) => ({ ...p, top: Math.max(band.top + 4, Math.min(p.top, band.top + band.height - 4 - h)) })) : []),
            ...(hint && band.height >= tall.h + 8
              ? [
                  { left: x + HUD_OFF, top: Math.max(band.top + 4, Math.min(y - tall.h / 2, band.top + band.height - 4 - tall.h)), slide: 'y' as const, stacked: true },
                  { left: x - HUD_OFF - tall.w, top: Math.max(band.top + 4, Math.min(y - tall.h / 2, band.top + band.height - 4 - tall.h)), slide: 'y' as const, stacked: true }
                ]
              : [])
          ]
        : band.width >= w + 16
          ? [{ left: band.left + band.width / 2 - w / 2, top: y + HUD_OFF, slide: 'y' as const }]
          : [];
    // Just past its own focus ring on the box's outer side: where a keyboard adjustment's readout stays near the
    // focus readout it replaces, rather than crossing to the far side of the box.
    const RING_OFF = GRIP_HALF + 9;
    const pastRing: Spot = { left: x - w / 2, top: y - RING_OFF - h, slide: 'x' };
    const pastRingBelow: Spot = { left: x - w / 2, top: y + RING_OFF, slide: 'x' };
    // Side padding: inside the box's own top padding, which holds no content, when it is deep enough.
    const { padding: pd, border: bd } = spacing;
    const strip: Spot[] = pd.top * z >= high + 8 ? [{ left: g.where === 'left' ? box.left + bd.left * z + 8 : box.left + box.width - bd.right * z - 8 - w, top: box.top + bd.top * z + (pd.top * z - high) / 2, slide: 'x' }] : [];
    const order: Record<string, Spot[]> = {
      'padding top': [...inBand, ...(live?.keyboard ? [pastRing] : []), overBox, right, left, underBox],
      'padding bottom': [...inBand, ...(live?.keyboard ? [pastRingBelow] : []), underBox, right, left, overBox],
      'padding left': [...inBand, ...strip, leftOfBox, overBox, underBox, below],
      'padding right': [...inBand, ...strip, rightOfBox, overBox, underBox, below],
      // Beside the handle, drawn toward the box, so it sits in the space the margin makes rather than on what follows.
      'margin top': [{ ...right, top: y - 4 }, { ...left, top: y - 4 }, right, left, above],
      'margin bottom': [{ ...right, top: y - h + 4 }, { ...left, top: y - h + 4 }, right, left, below],
      'gap x': [underBox, overBox, below, above],
      'gap y': [rightOfBox, leftOfBox, overBox, underBox, right, left],
      'width left': [leftOfBox, overBox, underBox, below],
      'width right': [rightOfBox, overBox, underBox, below],
      split: [overBox, underBox, below]
    };
    const key = g.kind === 'split' ? 'split' : g.kind === 'gap' ? `gap ${g.axis}` : `${g.kind} ${g.where.split(' ')[0]}`;
    const spots = order[key] ?? [right, left, below, above];
    const clampX = (l: number) => Math.max(HUD_INSET, Math.min(l, fw - HUD_INSET - w));
    const clampY = (t: number) => Math.max(HUD_INSET, Math.min(t, fh - HUD_INSET - h));
    // Never over its own handle and focus ring. At rest, never over another handle either: the readout would hide
    // it, and a pointed-at one (which takes the pointer) would block it. During a drag the others cannot be used.
    const RING = GRIP_HALF + 5;
    const keep = [{ at: g.at, r: RING }, ...(live ? [] : held.filter((o) => o.id !== g.id).map((o) => ({ at: o.at, r: GRIP_HALF })))];
    const clear = (at: { left: number; top: number }) => keep.every(({ at: o, r }) => o.x + r <= at.left || o.x - r >= at.left + w || o.y + r <= at.top || o.y - r >= at.top + h);
    const onPage = (at: { left: number; top: number }) => at.left >= HUD_INSET && at.top >= HUD_INSET && at.left + w <= fw - HUD_INSET && at.top + h <= fh - HUD_INSET;
    // A place along a row slides along it, to stay on the page and then to step round a handle in the way.
    const along = (p: Spot) => {
      const base = p.slide === 'x' ? clampX(p.left) : clampY(p.top);
      const steps = keep.flatMap(({ at: o, r }) => (p.slide === 'x' ? [o.x + r + 4, o.x - r - 4 - w] : [o.y + r + 4, o.y - r - 4 - h]));
      return [base, ...steps.sort((m, n) => Math.abs(m - base) - Math.abs(n - base))].map((v) => (p.slide === 'x' ? { left: v, top: p.top } : { left: p.left, top: v }));
    };
    for (const p of spots) {
      w = p.stacked ? tall.w : wide;
      h = p.stacked ? tall.h : high;
      for (const at of along(p)) if (onPage(at) && clear(at)) return { ...at, stacked: !!p.stacked };
    }
    w = wide;
    h = high;
    // Nowhere off the content: by the handle, kept on the page and clear of the handles.
    for (const p of [below, above, right, left]) for (const at of along({ ...p, left: clampX(p.left), top: clampY(p.top) })) if (onPage(at) && clear(at)) return { ...at, stacked: false };
    return { left: clampX(spots[0].left), top: clampY(spots[0].top), stacked: false };
  };
  // While dragging: the value it has got to, what it was, and how to get exact values. At rest, pointed at or
  // focused: its name and value now, and how to change it.
  const peek = !live && active ? (focused === active.id && !quiet ? 'focus' : 'hover') : null;
  const moved = !!live && live.text !== live.was;
  const hudPlace = active && (live || peek) ? hudAt(active) : null;
  const exactKey = active?.kind === 'split' ? 'any split' : 'exact pixels';
  return (
    <>
      {active?.bands.map((b, i) => {
        // A side with no space (padding of 0, or a moving edge) is drawn as a line along that edge.
        const edge = b.width < 2 ? { ...b, left: b.left - 1, width: 2 } : b.height < 2 ? { ...b, top: b.top - 1, height: 2 } : null;
        return <div key={`band-${i}`} className={`ov-space-band ${active.kind}${edge ? ' edge' : ''}`} style={edge ?? b} aria-hidden="true" />;
      })}
      <div className="ov-space-group" role="group" aria-label="Spacing handles">
        {held.map((g) => {
          const keyed = live?.keyboard && live.id === g.id;
          return (
            <div
              key={g.id}
              className={`ov-space-handle ${g.kind} ${g.axis}${g.id === live?.id ? ' active' : ''}`}
              style={{ left: g.at.x, top: g.at.y }}
              data-testid={g.id}
              tabIndex={0}
              role={g.kind === 'split' ? 'separator' : 'slider'}
              aria-label={`${g.label}, ${g.where}`}
              aria-orientation={g.kind === 'split' ? 'vertical' : g.axis === 'y' ? 'vertical' : 'horizontal'}
              aria-valuemin={g.kind === 'margin' && keyed && drag.current?.value ? Math.min(g.least, Math.round(drag.current.value.px)) : g.least}
              aria-valuemax={Math.max(g.most, keyed && drag.current?.value ? Math.round(drag.current.value.px) : g.now)}
              aria-valuenow={keyed && drag.current?.value ? Math.round(g.kind === 'split' ? (amountOf(g, drag.current.value) ?? 0) * 100 : drag.current.value.px) : g.now}
              aria-valuetext={keyed ? live!.text : g.rest}
              onPointerDown={(e) => begin(e, g)}
              aria-describedby={descId + (g.kind === 'split' ? 'split' : 'value')}
              onPointerEnter={() => {
                stay();
                setHot(g.id);
              }}
              onPointerLeave={() => leave(g.id)}
              onKeyDown={(e) => keyDown(e, g)}
              onFocus={(e) => {
                setQuiet(false);
                if (e.currentTarget.matches(':focus-visible')) setFocused(g.id);
              }}
              onBlur={() => {
                if (drag.current?.keyboard && drag.current.grip.id === g.id) saveKeys();
                setFocused((v) => (v === g.id ? null : v));
              }}
            />
          );
        })}
        <span id={`${descId}value`} hidden>
          Arrow keys step through the site's styles, {altName} with an arrow by one pixel. Enter saves, Escape cancels.
        </span>
        <span id={`${descId}split`} hidden>
          Left and right arrow keys move the divider to the next clean split, {altName} with an arrow by one percent. Enter saves, Escape cancels.
        </span>
      </div>
      {active && hudPlace && (
        <div
          ref={hudRef}
          className={`ov-space-hud${peek ? ` peek ${peek}` : ''}${hudPlace.stacked ? ' stacked' : ''}`}
          // No wider than the page: a long readout wraps rather than running off it.
          style={{ left: hudPlace.left, top: hudPlace.top, ...(frame ? { maxWidth: frame.width - 2 * HUD_INSET } : {}) }}
          // Pointed at, it can be moved onto and read; it goes when the pointer leaves both it and its handle.
          {...(peek === 'hover' ? { onPointerEnter: stay, onPointerLeave: () => leave(active.id) } : {})}
          // A pointer drag is announced as it goes; a focused handle announces its own value.
          {...(live && !live.keyboard ? { role: 'status' } : { 'aria-hidden': true })}
          data-testid="spacing-hud"
        >
          <span className="main">
            <span className="what">{active.label}</span>
            <span className="val">{live ? live.text : active.rest}</span>
            {moved && <span className="was">was {live!.was}</span>}
          </span>
          {live && !live.keyboard && (active.scale || active.kind === 'split') && (
            <span className={`hint${live.exact ? ' on' : ''}`}>
              {live.exact ? (active.kind === 'split' ? 'Any split' : 'Exact pixels') : (
                <>
                  <kbd>{altName}</kbd> for {exactKey}
                </>
              )}
            </span>
          )}
          {live?.keyboard && <span className="hint">Enter saves · Esc cancels</span>}
          {peek === 'focus' && (
            <span className="hint">
              Arrow keys, <kbd>{altName}</kbd> 1{active.kind === 'split' ? '%' : 'px'}
            </span>
          )}
          {peek === 'hover' && <span className="hint">Drag to change</span>}
        </div>
      )}
    </>
  );
}
