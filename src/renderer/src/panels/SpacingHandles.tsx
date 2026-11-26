import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ElementRef, ProjectState, ResponsiveScope, StyleValue, TokenGroup } from '@shared/types';
import { gridTemplateShares, scopeForWidth } from '@shared/styles';
import { api, commitOps, getState, useStore } from '../store';
import type { BridgeDesc } from '../lib/model';
import type { FrameRect, FrameSpacing } from '../lib/payload';
import { trackApply } from '../lib/pending';
import { forLabel, partName, refTo } from '../lib/edit-label';
import { chosenReach, reachVersion, subscribeReach } from '../lib/item-reach';
import {
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
  sameStyleValue,
  spacingOp,
  spacingTarget,
  storedSpacing,
  type DragValue,
  type SpaceStop,
  type SpacingHandle,
  type SpacingTarget
} from '../lib/spacing-drag';
import {
  columnBoxes,
  contentBox,
  freeSpot,
  gapDecls,
  gutters,
  planGap,
  planSplit,
  planWidth,
  sameSplit,
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
  property: string;
  axis: 'x' | 'y';
  /** Where it sits, and what it lights while pointed at or dragged, in overlay pixels. */
  at: { x: number; y: number };
  bands: Rect[];
  /** The site styles it snaps to, measured on the page; none for column sizes. */
  scale: Scale | null;
  /** Its size when the press began, in frame pixels, for the HUD until the drag moves. */
  start: number;
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
export function SpacingHandles({ state, selection, desc, box, spacing, zoom, post, measureSpace, onDragging, focusCanvas, pageBehind }: {
  state: ProjectState;
  selection: ElementRef;
  desc: BridgeDesc;
  /** The selected element's border box on screen, inside the overlay. */
  box: { left: number; top: number; width: number; height: number };
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
  const [live, setLive] = useState<{ id: string; text: string } | null>(null);
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
    const { padding: pd, border: bd, margin: mg } = spacing;
    const midX = box.left + box.width / 2;
    // Margin handles sit beside the padding ones, so both can be reached when there is no space between them.
    const aside = Math.min(28, box.width / 4);
    const dragged = drag.current?.grip;
    const spaceAt = (h: SpacingHandle) => {
      if (h.box === 'margin') return h.side === 'top' ? { x: midX + aside, y: box.top - mg.top * z } : { x: midX + aside, y: box.top + box.height + mg.bottom * z };
      // The padding being dragged keeps its grip by its content's edge, as the pointer moves it, rather than in the
      // middle of the new band, which would leave the pointer behind.
      return paddingGripAt(box, bd, pd, h.side, z, dragged?.id === `spacing-padding-${h.side}` ? dragged.start : undefined);
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
      out.push({
        id: `spacing-${h.box}-${h.side}`,
        kind: h.box,
        label: plan.label,
        property: plan.property,
        axis: h.axis,
        at: spaceAt(h),
        bands: plan.sides.map((side) => band(h.box, side)),
        scale: 'space',
        start: h.box === 'padding' ? pd[h.side] : mg[h.side],
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
    const wanted: Array<{ grip: Omit<Grip, 'at'>; prefer: { x: number; y: number }; slide: { along: 'x' | 'y'; from: number; to: number } }> = [];
    const put = (grip: Omit<Grip, 'at'>, prefer: { x: number; y: number }, slide: { along: 'x' | 'y'; from: number; to: number }) => void wanted.push({ grip, prefer, slide });
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
        put(
          {
            id: `layout-split-${i}`,
            kind: 'split',
            label: split.label,
            property: split.property,
            axis: 'x',
            bands: [onScreen(cols[i]), onScreen(cols[i + 1])],
            scale: null,
            start: 0,
            reach: (travel, zm, _stops, exact) => {
              const v = splitDragValue(split.shares, i, a, b, travel / (zm > 0 ? zm : 1), exact, rtl);
              return v && { value: v.value, px: 0 };
            },
            decls: (v) => splitDecls(String(v)),
            media: splitMedia(scope),
            unchanged: (v) => sameSplit(gridTemplateShares(v), split.shares),
            text: (v) => String(v.value),
            split
          },
          { x: r.left + r.width / 2, y: r.top + 12 },
          // Above the grid when its gutter has no room.
          { along: 'y', from: r.top - 24, to: r.top + r.height }
        );
      }
    }
    for (const axis of ['x', 'y'] as const) {
      const plan = planGap(axis, t, scope, shown);
      const start = axis === 'x' ? layout.columnGap : layout.rowGap;
      const mine = all.filter((g) => g.axis === axis);
      if (!plan || start === null || !mine.length) continue;
      const bands = mine.map((g) => onScreen(g.rect));
      for (const g of mine) {
        const r = onScreen(g.rect);
        put(
          {
            id: `layout-gap-${axis}-${g.index}`,
            kind: 'gap',
            label: plan.label,
            property: plan.property,
            axis,
            bands,
            scale: axis === 'x' ? 'gapX' : 'gapY',
            start,
            reach: (travel, zm, stops, exact) => dragValue(draggedSize(start, travel, zm, 1), stops, exact),
            decls: (v) => gapDecls(plan, v),
            media: previewMedia(scope),
            unchanged: stored(plan.property),
            text: dragLabel
          },
          { x: r.left + r.width / 2, y: r.top + r.height / 2 },
          // Just past either end of a gutter with no room in it (a short row whose padding handles fill its height).
          axis === 'x' ? { along: 'y', from: r.top - 24, to: r.top + r.height + 24 } : { along: 'x', from: r.left - 24, to: r.left + r.width + 24 }
        );
      }
    }
    const width = planWidth(t, scope, shown, layout);
    const wr = width && widthReach(layout, edges);
    if (width && wr) {
      for (const side of ['left', 'right'] as const) {
        const grow = side === 'right' ? 1 : -1;
        put(
          {
            id: `layout-width-${side}`,
            kind: 'width',
            label: width.label,
            property: width.property,
            axis: 'x',
            bands: [],
            scale: 'width',
            start: wr.start,
            // Centred: both edges move, so the width changes twice as far as the pointer goes.
            reach: (travel, zm, stops, exact) => widthDragValue(draggedSize(wr.start, travel * 2, zm, grow), stops, exact, wr),
            decls: widthDecls,
            media: previewMedia(scope),
            unchanged: stored(width.property),
            text: dragLabel
          },
          { x: side === 'left' ? box.left : box.left + box.width, y: box.top + Math.min(box.height / 4, 40) },
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
      const at = held.axis === 'x' ? { x: mine.prefer.x, y: held.at.y } : { x: held.at.x, y: mine.prefer.y };
      placed.push({ ...at, axis: held.axis });
      out.push({ ...mine.grip, at });
    } else if (held && held.kind !== 'padding' && held.kind !== 'margin') placed.push({ ...held.at, axis: held.axis });
    for (const w of wanted) {
      if (w === mine) continue;
      const at = freeSpot(placed, { ...w.prefer, axis: w.grip.axis }, w.slide);
      if (!at) continue;
      placed.push(at);
      out.push({ ...w.grip, at: { x: at.x, y: at.y } });
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
    if (place(d)) setLive({ id: d.grip.id, text: d.grip.text(d.value!) });
    // Somewhere it cannot go: the HUD says nothing will be saved, as the page shows.
    else if (d.moved && !d.value && (d.stops || d.at.exact)) setLive({ id: d.grip.id, text: '—' });
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
      stop
    };
    drag.current = d;
    if (grip.scale)
      d.measured = measure(grip.scale).then((stops) => {
        d.stops = stops;
        if (drag.current === d) update();
      });
    onDragging(true);
    setLive({ id: grip.id, text: grip.kind === 'split' ? '' : dragLabel({ value: '', px: grip.start }) });
  };

  // Whatever takes the handles away (another selection, size, zoom or page; the frame restarting) ends the drag.
  useEffect(() => () => cancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The handle being dragged stays while its own preview moves things about (a stack wrapping onto another line can
  // take its gutter away), so the pointer it holds is not lost.
  // It is drawn first, so React never moves its element (a moved element loses the pointer it holds), whatever the
  // others do.
  const dragged = drag.current?.grip;
  const shownDragged = dragged ? (grips.find((g) => g.id === dragged.id) ?? dragged) : null;
  const held = shownDragged ? [shownDragged, ...grips.filter((g) => g.id !== shownDragged.id)] : grips;
  if (!held.length && !live) return null;
  const activeId = live?.id ?? hot;
  const active = held.find((g) => g.id === activeId);
  return (
    <>
      {active?.bands.map((b, i) => <div key={`band-${i}`} className={`ov-space-band ${active.kind}`} style={b} aria-hidden="true" />)}
      {held.map((g) => (
        <div
          key={g.id}
          className={`ov-space-handle ${g.kind} ${g.axis}${g.id === live?.id ? ' active' : ''}`}
          style={{ left: g.at.x, top: g.at.y }}
          data-testid={g.id}
          title={`Drag to change ${g.label.toLowerCase()}. Hold ${altName} for ${g.kind === 'split' ? 'any split' : 'exact pixels'}.`}
          aria-hidden="true"
          onPointerDown={(e) => begin(e, g)}
          onPointerEnter={() => setHot(g.id)}
          onPointerLeave={() => setHot((v) => (v === g.id ? null : v))}
        />
      ))}
      {live && active && (
        <div className={`ov-space-hud ${active.axis}`} style={{ left: active.at.x, top: active.at.y }} role="status" data-testid="spacing-hud">
          <span className="what">{active.label}</span>
          <span className="val">{live.text}</span>
        </div>
      )}
    </>
  );
}
