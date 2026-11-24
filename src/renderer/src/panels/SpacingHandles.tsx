import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ElementRef, ProjectState, ResponsiveScope } from '@shared/types';
import { scopeForWidth } from '@shared/styles';
import { api, commitOps, getState, useStore } from '../store';
import type { BridgeDesc } from '../lib/model';
import type { FrameSpacing } from '../lib/payload';
import { trackApply } from '../lib/pending';
import { chosenReach, reachVersion, subscribeReach } from '../lib/item-reach';
import {
  SPACING_HANDLES,
  dragLabel,
  dragValue,
  draggedSize,
  planHandle,
  previewDecls,
  previewMedia,
  sameStyleValue,
  spaceSignature,
  spaceTokens,
  spacingOp,
  spacingTarget,
  storedSpacing,
  type DragValue,
  type HandlePlan,
  type SpaceStop,
  type SpacingHandle,
  type SpacingTarget
} from '../lib/spacing-drag';

/** Screen pixels a press must travel before it is a drag rather than a click. */
const DRAG_START = 3;
const altName = api.platform === 'darwin' ? 'Option' : 'Alt';
const keyOf = (h: SpacingHandle) => `${h.box}-${h.side}`;

interface Drag {
  id: string;
  pointer: number;
  el: HTMLElement;
  plan: HandlePlan;
  target: SpacingTarget;
  scope: ResponsiveScope;
  rtl: boolean;
  /** The dragged side's size when the press began, in frame pixels. */
  start: number;
  x: number;
  y: number;
  zoom: number;
  /** The spacing scale as the page measured it; null until it answers. */
  stops: SpaceStop[] | null;
  at: { x: number; y: number; exact: boolean };
  moved: boolean;
  /** What the page is showing now. */
  value: DragValue | null;
  raf: number;
  desc: BridgeDesc;
  /** Settles once the page has said how large its spacing styles are (or did not answer in time). */
  measured: Promise<void>;
  revision: number;
  opening: string | undefined;
  stop: () => void;
}

/**
 * Handles on the selected box for dragging its padding (each side) and its margin (above and below). A drag shows
 * on the page as it moves, snapping to the site's spacing styles (Alt or Option for exact pixels), and is saved as
 * one `node.setStyle` edit at the size being edited when it is released: one Undo takes it back. Escape puts the
 * page back and saves nothing. Handles show only for what the inspector offers here, and only at the size the
 * canvas is showing, so a drag always shows what it saves.
 */
export function SpacingHandles({ state, selection, desc, box, spacing, zoom, post, measureSpace, onDragging, focusCanvas }: {
  state: ProjectState;
  selection: ElementRef;
  desc: BridgeDesc;
  /** The selected element's border box on screen, inside the overlay. */
  box: { left: number; top: number; width: number; height: number };
  spacing: FrameSpacing;
  zoom: number;
  post: (type: string, payload?: unknown) => void;
  measureSpace: (vars: string[], desc: BridgeDesc) => Promise<Array<number | null> | null>;
  onDragging: (on: boolean) => void;
  focusCanvas: () => void;
}) {
  const scope = useStore((s) => s.styleScope);
  const viewport = useStore((s) => s.viewport);
  const [hot, setHot] = useState<string | null>(null);
  const [live, setLive] = useState<{ key: string; text: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  /** The spacing scale as the page last measured it for this box, with the site styles it was measured for. */
  const known = useRef<{ sig: string; stops: SpaceStop[] } | null>(null);
  /** The last scale measured, while the site's spacing styles are still what it was measured for. */
  const current = (): SpaceStop[] | null => {
    const st = getState().snapshot?.state;
    return st && known.current?.sig === spaceSignature(st) ? known.current.stops : null;
  };
  // The inspector's choice of one card or every card changes what the handles write.
  useSyncExternalStore(subscribeReach, reachVersion);
  const shown = scopeForWidth(viewport);
  const rtl = spacing.rtl;
  const target = spacingTarget(state, selection, chosenReach);
  const plans = target ? SPACING_HANDLES.flatMap((h) => planHandle(h, target, scope, shown, rtl) ?? []) : [];

  /** Ask the page how large its spacing styles are on this box: no answer in time leaves exact pixels. */
  const measure = (): Promise<SpaceStop[]> => {
    const st = getState().snapshot?.state;
    const tokens = st ? spaceTokens(st).slice(0, 500) : [];
    const sig = st ? spaceSignature(st) : '';
    return measureSpace(
      tokens.map((x) => x.cssVar),
      desc
    ).then((px) => {
      if (!px) return current() ?? [];
      const stops = tokens.flatMap((x, i) => (px[i] === null ? [] : [{ token: x.token, label: x.label, px: px[i]! }]));
      known.current = { sig, stops };
      return stops;
    });
  };
  // Measured as the handles appear, so a drag rarely waits for it (and again when one starts, in case the site's
  // styles changed since).
  useEffect(() => void measure(), []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Note whether the pointer has gone far enough to be a drag; its travel along the handle's axis. */
  const advance = (d: Drag): number => {
    const travel = d.plan.handle.axis === 'y' ? d.at.y - d.y : d.at.x - d.x;
    if (Math.abs(travel) >= DRAG_START) d.moved = true;
    return travel;
  };

  /** Work out where a drag has got to and show it on the page. False while there is nothing to show yet. */
  const place = (d: Drag): boolean => {
    const h = d.plan.handle;
    const travel = advance(d);
    // Snapped values wait for the page to say how large its spacing styles are.
    if (!d.moved || (!d.stops && !d.at.exact)) return false;
    const signed = h.box === 'margin';
    const v = dragValue(draggedSize(d.start, travel, d.zoom, h.grow, signed), d.stops ?? [], d.at.exact, signed);
    // Preview shows the page as saved: a drag let go just before it shows nothing there.
    if ((!d.value || !sameStyleValue(d.value.value, v.value)) && getState().mode === 'edit')
      post('spacingPreview', { drag: d.id, desc: d.desc, media: previewMedia(d.scope), decls: previewDecls(d.plan, v.value, d.rtl) });
    d.value = v;
    return true;
  };

  /** Show where the drag in progress has got to, on the page and in the HUD. */
  const update = () => {
    const d = drag.current;
    if (d && place(d)) setLive({ key: keyOf(d.plan.handle), text: dragLabel(d.value!) });
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
   * page has said how large its spacing styles are waits for that, so the edit is where the pointer let go.
   */
  const finish = async (d: Drag) => {
    const clear = () => post('spacingPreview', { drag: d.id, clear: true });
    advance(d);
    if (d.moved && !d.stops && !d.at.exact) await d.measured;
    place(d);
    const { property } = d.plan;
    const v = d.value;
    // A click, or a drag that ends on what is saved already, changes nothing.
    if (!d.moved || !v || sameStyleValue(storedSpacing(d.target, d.scope, property), v.value) || getState().snapshot?.workspaceKey !== d.opening) return clear();
    try {
      const r = await commitOps([spacingOp(d.target, d.scope, property, v.value)], `Set ${d.plan.label.toLowerCase()}`, undefined, d.revision);
      if (r?.ok) post('spacingPreview', { drag: d.id, handoff: r.revision });
      else clear();
    } catch {
      clear();
    }
  };

  const begin = (e: React.PointerEvent<HTMLDivElement>, drawn: HandlePlan) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    const s = getState();
    const st = s.snapshot?.state;
    // Read again now: the card's reach may have been chosen in the inspector since this was drawn.
    const t = st ? spacingTarget(st, selection, chosenReach) : null;
    const plan = t && planHandle(drawn.handle, t, scope, shown, rtl);
    if (!st || !t || !plan || !s.snapshot) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    // Escape reaches the editor, not a page that had the keyboard.
    focusCanvas();
    const h = plan.handle;
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
        // Holding or letting go of Alt switches between exact pixels and the spacing styles where the pointer is.
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
    const start = h.box === 'padding' ? spacing.padding[h.side] : spacing.margin[h.side];
    const d: Drag = {
      id,
      pointer: e.pointerId,
      el,
      plan,
      target: t,
      scope,
      rtl,
      start,
      x: e.clientX,
      y: e.clientY,
      zoom,
      stops: current(),
      at: { x: e.clientX, y: e.clientY, exact: e.altKey },
      moved: false,
      value: null,
      raf: 0,
      // A change for every card shows on every card.
      desc: t.everyItem ? { ...desc, items: '' } : desc,
      measured: Promise.resolve(),
      revision: s.snapshot.revision,
      opening: s.snapshot.workspaceKey,
      stop
    };
    drag.current = d;
    d.measured = measure().then((stops) => {
      d.stops = stops;
      if (drag.current === d) update();
    });
    onDragging(true);
    setLive({ key: keyOf(h), text: dragLabel({ value: '', px: start }) });
  };

  // Whatever takes the handles away (another selection, size, zoom or page; the frame restarting) ends the drag.
  useEffect(() => () => cancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!plans.length && !live) return null;
  const z = zoom;
  const { padding: pd, border: bd, margin: mg } = spacing;
  const midX = box.left + box.width / 2;
  const midY = box.top + box.height / 2;
  // Margin handles sit beside the padding ones, so both can be reached when there is no space between them.
  const aside = Math.min(28, box.width / 4);
  const at = (h: SpacingHandle) => {
    if (h.box === 'margin') return h.side === 'top' ? { x: midX + aside, y: box.top - mg.top * z } : { x: midX + aside, y: box.top + box.height + mg.bottom * z };
    if (h.side === 'top') return { x: midX, y: box.top + (bd.top + pd.top) * z };
    if (h.side === 'bottom') return { x: midX, y: box.top + box.height - (bd.bottom + pd.bottom) * z };
    if (h.side === 'left') return { x: box.left + (bd.left + pd.left) * z, y: midY };
    return { x: box.left + box.width - (bd.right + pd.right) * z, y: midY };
  };
  const band = (b: SpacingHandle['box'], side: SpacingHandle['side']) => {
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
  const activeKey = live?.key ?? hot;
  const active = plans.find((p) => keyOf(p.handle) === activeKey) ?? (drag.current && keyOf(drag.current.plan.handle) === activeKey ? drag.current.plan : undefined);
  const hud = live && active ? at(active.handle) : null;
  return (
    <>
      {active?.sides.map((side) => <div key={`band-${side}`} className={`ov-space-band ${active.handle.box}`} style={band(active.handle.box, side)} aria-hidden="true" />)}
      {plans.map((p) => {
        const h = p.handle;
        const k = keyOf(h);
        const { x, y } = at(h);
        return (
          <div
            key={k}
            className={`ov-space-handle ${h.box} ${h.axis}${k === live?.key ? ' active' : ''}`}
            style={{ left: x, top: y }}
            data-testid={`spacing-${k}`}
            title={`Drag to change ${p.label.toLowerCase()}. Hold ${altName} for exact pixels.`}
            aria-hidden="true"
            onPointerDown={(e) => begin(e, p)}
            onPointerEnter={() => setHot(k)}
            onPointerLeave={() => setHot((v) => (v === k ? null : v))}
          />
        );
      })}
      {hud && active && (
        <div className={`ov-space-hud ${active.handle.axis}`} style={{ left: hud.x, top: hud.y }} role="status" data-testid="spacing-hud">
          <span className="what">{active.label}</span>
          <span className="val">{live!.text}</span>
        </div>
      )}
    </>
  );
}
