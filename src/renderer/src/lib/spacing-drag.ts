/**
 * Padding and margin dragged on the canvas: which style each handle writes, how far a drag moves it at the canvas
 * zoom, and the site spacing style it snaps to. Pure, for the canvas overlay to drive.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementRef, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles, StyleValue } from '@shared/types';
import { STYLE_PROP_MAP, tokenVar } from '@shared/styles';
import { itemStylesOf, repeatedPartList } from '@shared/item-styles';
import { effectiveTokens } from '@generator/index';
import { styleSelection } from './style-copy';
import { treeFor } from './model';
import { itemReachKey } from './item-reach';

export type SpacingSide = 'top' | 'bottom' | 'left' | 'right';
export type SpacingBox = 'padding' | 'margin';
type Size = Exclude<ResponsiveScope, 'base'>;

export interface SpacingHandle {
  box: SpacingBox;
  side: SpacingSide;
  /** The style this one side writes on a left-to-right page. */
  edge: string;
  /** The style that sets this side and the one opposite it together, when there is one. */
  pair: string | null;
  axis: 'x' | 'y';
  /** Which way along the axis the pointer moves to make it larger. */
  grow: 1 | -1;
}

export const SPACING_HANDLES: SpacingHandle[] = [
  { box: 'padding', side: 'top', edge: 'paddingBlockStart', pair: 'paddingBlock', axis: 'y', grow: 1 },
  { box: 'padding', side: 'bottom', edge: 'paddingBlockEnd', pair: 'paddingBlock', axis: 'y', grow: -1 },
  { box: 'padding', side: 'left', edge: 'paddingInlineStart', pair: 'paddingInline', axis: 'x', grow: 1 },
  { box: 'padding', side: 'right', edge: 'paddingInlineEnd', pair: 'paddingInline', axis: 'x', grow: -1 },
  { box: 'margin', side: 'top', edge: 'marginBlockStart', pair: null, axis: 'y', grow: -1 },
  { box: 'margin', side: 'bottom', edge: 'marginBlockEnd', pair: null, axis: 'y', grow: 1 }
];

const OPPOSITE: Record<SpacingSide, SpacingSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const INLINE_FLIP: Record<string, string> = { paddingInlineStart: 'paddingInlineEnd', paddingInlineEnd: 'paddingInlineStart' };

/** The style a handle's own side writes: on a right-to-left page the left side is where a line ends. */
export const edgeOf = (h: SpacingHandle, rtl: boolean) => (rtl && h.axis === 'x' ? (INLINE_FLIP[h.edge] ?? h.edge) : h.edge);

/** One stop a drag snaps to: a spacing site style and its size on the page now, in frame pixels. */
export interface SpaceStop {
  token: string;
  label: string;
  px: number;
}

/** Where a drag has got to: the value it writes, its size in frame pixels, and the site style it snapped to. */
export interface DragValue {
  value: StyleValue;
  px: number;
  stop?: SpaceStop;
}

const finite = (n: number) => typeof n === 'number' && Number.isFinite(n);

/**
 * The size a drag reaches, in frame pixels: where it started plus the pointer's travel in screen pixels, taken back
 * through the canvas zoom, toward the side that makes it larger. Never below zero unless `signed` (a margin).
 */
export function draggedSize(start: number, travel: number, zoom: number, grow: 1 | -1, signed = false): number {
  const z = finite(zoom) && zoom > 0 ? zoom : 1;
  const v = (finite(start) ? start : 0) + ((finite(travel) ? travel : 0) * grow) / z;
  return signed ? v : Math.max(0, v);
}

/** A frame-pixel length as the canvas draws it at a zoom, in screen pixels. */
export const onScreen = (px: number, zoom: number) => px * (finite(zoom) && zoom > 0 ? zoom : 1);

/** The spacing stops in size order, without duplicates of a size an earlier (smaller-named) stop already has. */
export function spaceScale(stops: SpaceStop[]): SpaceStop[] {
  const sorted = stops.filter((s) => finite(s.px) && s.px > 0).sort((a, b) => a.px - b.px);
  return sorted.filter((s, i) => i === 0 || Math.abs(s.px - sorted[i - 1].px) >= 0.5);
}

/**
 * What a drag to `px` writes. Snapped, it is the nearest spacing site style, or none at all when zero is nearer
 * (an even split goes to the smaller); exact, or with no styles to snap to, it is a whole number of pixels, which
 * only a `signed` (margin) drag takes below zero.
 */
export function dragValue(px: number, stops: SpaceStop[], exact: boolean, signed = false): DragValue {
  const raw = finite(px) ? px : 0;
  const at = Math.max(0, raw);
  const scale = spaceScale(stops);
  if (exact || !scale.length) {
    const whole = Math.round(signed ? raw : at);
    return { value: whole === 0 ? '0' : `${whole}px`, px: whole === 0 ? 0 : whole };
  }
  let best: SpaceStop | null = null;
  let gap = at;
  for (const s of scale) {
    const d = Math.abs(s.px - at);
    if (d < gap) {
      best = s;
      gap = d;
    }
  }
  return best ? { value: { token: best.token }, px: best.px, stop: best } : { value: '0', px: 0 };
}

/** The HUD's words for where a drag is: the site style's name and its size, or the size alone. */
export function dragLabel(v: DragValue): string {
  const px = `${Math.round(v.px * 10) / 10}px`;
  return v.stop ? `${v.stop.label} · ${px}` : px;
}

/** The spacing site styles a drag snaps to, with the CSS variable the page holds each one's size in. */
export function spaceTokens(state: ProjectState): Array<{ token: string; label: string; cssVar: string }> {
  return effectiveTokens(state)
    .filter((t) => t.group === 'space')
    .map((t) => ({ token: t.id, label: t.label, cssVar: tokenVar(t.id) }));
}

/** Where a selection's spacing is written: one set of styles, and the properties the inspector offers there. */
export interface SpacingTarget {
  owner: OwnerRef;
  nodeId: string;
  partId?: string;
  /** Set when one card of a list is styled on its own ("This card"). */
  itemId?: string;
  styles: ResponsiveStyles | undefined;
  offered: string[];
  /** Every copy of a repeated part takes the change, not only the one picked. */
  everyItem: boolean;
}

/**
 * Where dragging the selected box's spacing writes, as the inspector would: a section's own styles, a part's
 * (or one card's, when "This card" is chosen for it), or an element's. Null when the selection takes no style
 * changes of its own here (an element inside a section's design that is not one of its parts, a component's
 * design being edited everywhere).
 */
export function spacingTarget(state: ProjectState, ref: ElementRef, reach: (key: string) => 'all' | 'item' | undefined = () => undefined): SpacingTarget | null {
  const sel = styleSelection(state, ref);
  if (!sel) return null;
  // A section is resolved only from its own box (the placement, or its design's root element), never from
  // something inside it, which resolves to a part or to nothing.
  if (sel.kind === 'section') {
    const t = sel.targets.find((x) => x.part === 'root');
    return t ? { owner: t.owner, nodeId: t.nodeId, partId: t.partId, styles: t.styles, offered: t.offered, everyItem: false } : null;
  }
  const t = sel.targets[0];
  if (!t) return null;
  if (!t.partId) return ref.instancePath.length === 0 && t.nodeId === ref.nodeId ? { owner: t.owner, nodeId: t.nodeId, styles: t.styles, offered: t.offered, everyItem: !!ref.itemPath?.length } : null;
  const base: SpacingTarget = { owner: t.owner, nodeId: t.nodeId, partId: t.partId, styles: t.styles, offered: t.offered, everyItem: false };
  const inst = treeFor(state, t.owner)?.nodes[t.nodeId];
  const def = inst?.kind === 'instance' && Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  if (inst?.kind !== 'instance' || !def || !repeatedPartList(def, t.partId)) return base;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const own = itemId ? itemStylesOf(def, inst, t.partId, itemId) : undefined;
  const chosen = itemId ? (reach(itemReachKey(t.owner, t.nodeId, itemId)) ?? (own ? 'item' : 'all')) : 'all';
  return chosen === 'item' ? { ...base, itemId, styles: own, everyItem: false } : { ...base, everyItem: true };
}

/** What one handle does for a selection: the style it writes, its name, and the sides that move on the page. */
export interface HandlePlan {
  handle: SpacingHandle;
  property: string;
  label: string;
  sides: SpacingSide[];
}

const at = (styles: ResponsiveStyles | undefined, scope: ResponsiveScope) => (styles && Object.hasOwn(styles, scope) ? styles[scope] : undefined) ?? {};

/**
 * Whether a value written at `scope` would be beaten on one side at the previewed size: by that size's own value
 * for the side (its edge or its pair), or, within one scope, by the side's own value over a pair being written.
 */
function beaten(styles: ResponsiveStyles | undefined, scope: ResponsiveScope, shown: Size, edge: string, pair: string | null, writes: string): boolean {
  if (scope === 'base') {
    const s = at(styles, shown);
    if (s[edge] !== undefined || (pair && s[pair] !== undefined)) return true;
  }
  return writes !== edge && at(styles, scope)[edge] !== undefined;
}

/**
 * What a handle writes: its own side's style when the selection offers it, otherwise the style for both sides.
 * Null when the selection offers neither, when the edit is for another size than the canvas shows, or when a
 * value already set would keep the dragged side where it is at the size shown.
 */
export function planHandle(h: SpacingHandle, target: SpacingTarget, scope: ResponsiveScope, shown: Size, rtl: boolean): HandlePlan | null {
  if (scope !== 'base' && scope !== shown) return null;
  const edge = edgeOf(h, rtl);
  const property = target.offered.includes(edge) ? edge : h.pair && target.offered.includes(h.pair) ? h.pair : null;
  if (!property || beaten(target.styles, scope, shown, edge, h.pair, property)) return null;
  const sides: SpacingSide[] = [h.side];
  if (property === h.pair) {
    const other = SPACING_HANDLES.find((o) => o.box === h.box && o.side === OPPOSITE[h.side])!;
    if (!beaten(target.styles, scope, shown, edgeOf(other, rtl), h.pair, property)) sides.push(other.side);
  }
  return { handle: h, property, label: STYLE_PROP_MAP[property]?.label ?? property, sides };
}

/** The CSS a preview gives the dragged box: each side that moves, as the stylesheet names it, set to the value. */
export function previewDecls(plan: HandlePlan, value: StyleValue, rtl: boolean): Array<[string, string]> {
  const css = typeof value === 'object' && value !== null ? `var(${tokenVar(value.token)})` : String(value);
  const box = plan.handle.box;
  return plan.sides.map((side) => {
    const prop = side === 'top' ? `${box}-block-start` : side === 'bottom' ? `${box}-block-end` : `${box}-inline-${(side === 'left') !== rtl ? 'start' : 'end'}`;
    return [prop, css];
  });
}

/** The value a target holds for a property at a scope now. */
export const storedSpacing = (target: SpacingTarget, scope: ResponsiveScope, property: string): StyleValue | undefined => at(target.styles, scope)[property];

export const sameStyleValue = (a: StyleValue | undefined, b: StyleValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The one edit a drag saves. */
export function spacingOp(target: SpacingTarget, scope: ResponsiveScope, property: string, value: StyleValue): EditOperation {
  return {
    type: 'node.setStyle',
    owner: target.owner,
    nodeId: target.nodeId,
    ...(target.partId ? { partId: target.partId } : {}),
    ...(target.itemId ? { itemId: target.itemId } : {}),
    scope,
    property,
    value
  };
}
