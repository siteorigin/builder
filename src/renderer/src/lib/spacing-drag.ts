/**
 * Padding and margin dragged on the canvas: which style each handle writes, how far a drag moves it at the canvas
 * zoom, and the site spacing style it snaps to. Pure, for the canvas overlay to drive.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementRef, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles, StyleValue } from '@shared/types';
import { MEDIA_QUERIES, STYLE_PROP_MAP, tokenVar } from '@shared/styles';
import { itemStylesOf, liveItemStyles, repeatedPartList } from '@shared/item-styles';
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

/** The spacing stops in size order, without a stop within half a pixel of one already kept (the earlier one stays). */
export function spaceScale(stops: SpaceStop[]): SpaceStop[] {
  const kept: SpaceStop[] = [];
  for (const s of stops.filter((x) => finite(x.px) && x.px > 0).sort((a, b) => a.px - b.px)) if (!kept.length || s.px - kept[kept.length - 1].px >= 0.5) kept.push(s);
  return kept;
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

/** What the spacing scale is made of: a scale measured for one value of this is stale once it changes. */
export const spaceSignature = (state: ProjectState) => JSON.stringify(effectiveTokens(state).filter((t) => t.group === 'space').map((t) => [t.id, t.value]));

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
  /** For a change to every card: each card's own styles, by item ID, which beat the shared ones. */
  items?: Record<string, ResponsiveStyles>;
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
  // Something picked in one copy of a list (a card, or an article a computed list shows) is styled for every copy.
  const inList = !!ref.itemPath?.length;
  if (!t.partId) return ref.instancePath.length === 0 && t.nodeId === ref.nodeId ? { owner: t.owner, nodeId: t.nodeId, styles: t.styles, offered: t.offered, everyItem: inList } : null;
  const base: SpacingTarget = { owner: t.owner, nodeId: t.nodeId, partId: t.partId, styles: t.styles, offered: t.offered, everyItem: inList };
  const inst = treeFor(state, t.owner)?.nodes[t.nodeId];
  const def = inst?.kind === 'instance' && Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  if (inst?.kind !== 'instance' || !def || !repeatedPartList(def, t.partId)) return base;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const own = itemId ? itemStylesOf(def, inst, t.partId, itemId) : undefined;
  const chosen = itemId ? (reach(itemReachKey(t.owner, t.nodeId, itemId)) ?? (own ? 'item' : 'all')) : 'all';
  if (chosen === 'item') return { ...base, itemId, styles: own, everyItem: false };
  const items = liveItemStyles(def, inst, t.partId)?.items;
  return { ...base, everyItem: true, ...(items ? { items: { ...items } } : {}) };
}

/** What one handle does for a selection: the style it writes, its name, and the sides that move on the page. */
export interface HandlePlan {
  handle: SpacingHandle;
  property: string;
  label: string;
  sides: SpacingSide[];
}

const at = (styles: ResponsiveStyles | undefined, scope: ResponsiveScope) => (styles && Object.hasOwn(styles, scope) ? styles[scope] : undefined) ?? {};

/** The CSS properties Custom CSS can set one side's padding or margin with: the shorthand, its axis, and the side's
 *  logical name (physical names such as padding-top are not written there). */
function cssNames(box: SpacingBox, side: SpacingSide, rtl: boolean): string[] {
  const axis = side === 'top' || side === 'bottom' ? 'block' : 'inline';
  const logical = side === 'top' ? 'block-start' : side === 'bottom' ? 'block-end' : (side === 'left') !== rtl ? 'inline-start' : 'inline-end';
  return [box, `${box}-${axis}`, `${box}-${logical}`];
}

/** Whether Custom CSS sets one of these properties: it is written after the named styles, so it wins. */
const customSets = (css: StyleValue | undefined, names: string[]) => typeof css === 'string' && css.split(';').some((d) => names.includes(d.split(':')[0].trim().toLowerCase()));

/** Whether one set of rules gives a side a value of its own: by its edge, its pair or Custom CSS. */
const setsSide = (rules: Record<string, StyleValue>, edge: string, pair: string | null, names: string[]) => rules[edge] !== undefined || (!!pair && rules[pair] !== undefined) || customSets(rules.customCss, names);

/**
 * Whether a value written at `scope` would be beaten on one side at the previewed size: by that size's own value
 * for the side, by Custom CSS in the same rule, or within one scope by the side's own value over a pair being
 * written.
 */
function beaten(styles: ResponsiveStyles | undefined, scope: ResponsiveScope, shown: Size, edge: string, pair: string | null, writes: string, names: string[]): boolean {
  if (scope === 'base' && setsSide(at(styles, shown), edge, pair, names)) return true;
  const here = at(styles, scope);
  return (writes !== edge && here[edge] !== undefined) || customSets(here.customCss, names);
}

/**
 * What a handle writes: its own side's style when the selection offers it, otherwise the style for both sides.
 * Null when the selection offers neither, when the edit is for another size than the canvas shows, when a value
 * already set would keep the dragged side where it is at the size shown, or for a change to every card when some
 * card keeps a moving side of its own there (the drag would show on it, and not hold): the inspector edits those.
 */
export function planHandle(h: SpacingHandle, target: SpacingTarget, scope: ResponsiveScope, shown: Size, rtl: boolean): HandlePlan | null {
  if (scope !== 'base' && scope !== shown) return null;
  const edge = edgeOf(h, rtl);
  const property = target.offered.includes(edge) ? edge : h.pair && target.offered.includes(h.pair) ? h.pair : null;
  if (!property || beaten(target.styles, scope, shown, edge, h.pair, property, cssNames(h.box, h.side, rtl))) return null;
  const sides: SpacingSide[] = [h.side];
  if (property === h.pair) {
    const other = handleAt(h.box, OPPOSITE[h.side]);
    if (!beaten(target.styles, scope, shown, edgeOf(other, rtl), h.pair, property, cssNames(h.box, other.side, rtl))) sides.push(other.side);
  }
  const cardKeeps = (own: ResponsiveStyles) =>
    sides.some((side) => [at(own, 'base'), at(own, shown)].some((r) => setsSide(r, edgeOf(handleAt(h.box, side), rtl), h.pair, cssNames(h.box, side, rtl))));
  if (target.everyItem && target.items && Object.values(target.items).some(cardKeeps)) return null;
  return { handle: h, property, label: STYLE_PROP_MAP[property]?.label ?? property, sides };
}

const handleAt = (box: SpacingBox, side: SpacingSide) => SPACING_HANDLES.find((o) => o.box === box && o.side === side)!;

/** The media query a preview applies under: the edited size's own, so it never shows at another size. */
export const previewMedia = (scope: ResponsiveScope): string | null => (scope === 'base' ? null : MEDIA_QUERIES[scope]);

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
