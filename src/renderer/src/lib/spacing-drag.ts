/**
 * Padding and margin dragged on the canvas: which style each handle writes, how far a drag moves it at the canvas
 * zoom, and the site spacing style it snaps to. Pure, for the canvas overlay to drive.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementRef, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles, StyleValue, TokenGroup } from '@shared/types';
import { CONTAINER_SCOPES } from '@shared/types';
import { MEDIA_QUERIES, STYLE_PROP_MAP, tokenVar } from '@shared/styles';
import { liveItemStyles, repeatedPartList } from '@shared/item-styles';
import { effectiveTokens } from '@generator/index';
import { styleSelection, type ReachChoice } from './style-copy';
import { treeFor } from './model';

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

/** Half a spacing grip's thickness across its edge, in screen pixels (.ov-space-handle is a 24px square, WCAG 2.5.8). */
export const GRIP_HALF = 12;

/**
 * Where a padding handle is drawn, in screen pixels: centred in its padding band, so it marks the space it sets
 * without covering what the box holds. In a band thinner than the grip, the grip's inner edge meets the content's
 * edge and the rest stands out over the box's own edge, never over its text or a small button's label (#905).
 * `box` is the selected box on screen; `border` and `padding` are in page pixels, at zoom `z`. With `frame` (the
 * visible page's size on screen), a grip that would stand out past the page's edge (a full-width section with no
 * side padding) is kept inside it, so it can still be reached.
 */
export function paddingGripAt(box: { left: number; top: number; width: number; height: number }, border: Record<SpacingSide, number>, padding: Record<SpacingSide, number>, side: SpacingSide, z: number, from?: number, frame?: { width: number; height: number }): { x: number; y: number } {
  const midX = box.left + box.width / 2;
  const midY = box.top + box.height / 2;
  // From the box's outer edge inwards, for a padding of `pad`: the middle of its band, kept clear of the content.
  const depthAt = (pad: number) => Math.min(((border[side] + border[side] + pad) * z) / 2, (border[side] + pad) * z - GRIP_HALF);
  const inner = (border[side] + padding[side]) * z;
  // While a drag that started at a padding of `from` runs, the grip keeps the distance from the content's edge it had
  // then: it moves with that edge, as the pointer does, and never onto the content.
  const depth = from === undefined ? depthAt(padding[side]) : inner - ((border[side] + from) * z - depthAt(from));
  // Kept inside the page only where the box's own edge is on it: an edge scrolled out of view keeps its grip with it.
  const inside = (v: number, edge: number, size: number | undefined) => (size === undefined || edge < 0 || edge > size ? v : Math.max(GRIP_HALF, Math.min(v, size - GRIP_HALF)));
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (side === 'top') return { x: midX, y: inside(box.top + depth, box.top, frame?.height) };
  if (side === 'bottom') return { x: midX, y: inside(bottom - depth, bottom, frame?.height) };
  if (side === 'left') return { x: inside(box.left + depth, box.left, frame?.width), y: midY };
  return { x: inside(right - depth, right, frame?.width), y: midY };
}
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
  /** Leave the box as it is: the drag went past where any value could change what the page shows. */
  keep?: boolean;
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

/** The HUD's words for where a drag is: the site style's name and its size in whole pixels, or the size alone. */
export function dragLabel(v: DragValue): string {
  const px = `${Math.round(v.px)}px`;
  return v.stop ? `${v.stop.label} · ${px}` : px;
}

/**
 * The words for a value a box has now, before any drag: the site style it is set to (`stored`, named from `stops` as
 * the page measured them, or `names` until it has) and its size, or the size alone when it is set in pixels or its
 * setting is not known. A size is never named after a site style it only happens to match.
 */
export function restLabel(stored: StyleValue | undefined, px: number, stops: SpaceStop[], names: Array<{ token: string; label: string }> = []): string {
  const token = typeof stored === 'object' && stored !== null && typeof stored.token === 'string' ? stored.token : null;
  const measured = token ? stops.find((s) => s.token === token) : undefined;
  const named = measured ?? (token ? names.find((n) => n.token === token) : undefined);
  // The size it is set to, where that is known (a style the page measured, or pixels as written), over the size the
  // box happens to show (a max width its container holds narrower).
  const literal = typeof stored === 'string' ? /^(-?\d+(?:\.\d+)?)px$/.exec(stored.trim()) : null;
  const size = measured ? measured.px : literal ? Number(literal[1]) : px;
  return dragLabel({ value: '', px: size, ...(named ? { stop: { token: named.token, label: named.label, px: size } } : {}) });
}

/** The site styles of one group a drag snaps to, with the CSS variable the page holds each one's size in. */
export function groupTokens(state: ProjectState, group: TokenGroup): Array<{ token: string; label: string; cssVar: string }> {
  return effectiveTokens(state)
    .filter((t) => t.group === group)
    .map((t) => ({ token: t.id, label: t.label, cssVar: tokenVar(t.id) }));
}

/** What a group's scale is made of: a scale measured for one value of this is stale once it changes. */
export const groupSignature = (state: ProjectState, group: TokenGroup) => JSON.stringify(effectiveTokens(state).filter((t) => t.group === group).map((t) => [t.id, t.value]));

/** The spacing site styles a drag snaps to, with the CSS variable the page holds each one's size in. */
export const spaceTokens = (state: ProjectState) => groupTokens(state, 'space');

/** What the spacing scale is made of: a scale measured for one value of this is stale once it changes. */
export const spaceSignature = (state: ProjectState) => groupSignature(state, 'space');

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
export function spacingTarget(state: ProjectState, ref: ElementRef, reach: ReachChoice = () => undefined): SpacingTarget | null {
  // Which card a part picked in one card writes to is Paste style's rule too (styleSelection), so the two never differ.
  const sel = styleSelection(state, ref, reach);
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
  if (t.itemId) return { ...base, itemId: t.itemId, everyItem: false };
  const inst = treeFor(state, t.owner)?.nodes[t.nodeId];
  const def = inst?.kind === 'instance' && Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  if (inst?.kind !== 'instance' || !def || !repeatedPartList(def, t.partId)) return base;
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

/** One scope's rules in a set of styles (none when it has none). */
export const rulesAt = (styles: ResponsiveStyles | undefined, scope: ResponsiveScope): Record<string, StyleValue> => (styles && Object.hasOwn(styles, scope) ? styles[scope] : undefined) ?? {};
const at = rulesAt;

/** The CSS properties Custom CSS can set one side's padding or margin with: the shorthand, its axis, and the side's
 *  logical name (physical names such as padding-top are not written there). */
function cssNames(box: SpacingBox, side: SpacingSide, rtl: boolean): string[] {
  const axis = side === 'top' || side === 'bottom' ? 'block' : 'inline';
  const logical = side === 'top' ? 'block-start' : side === 'bottom' ? 'block-end' : (side === 'left') !== rtl ? 'inline-start' : 'inline-end';
  return [box, `${box}-${axis}`, `${box}-${logical}`];
}

/** Whether Custom CSS sets one of these properties: it is written after the named styles, so it wins. */
export const customSets = (css: StyleValue | undefined, names: string[]) => typeof css === 'string' && css.split(';').some((d) => names.includes(d.split(':')[0].trim().toLowerCase()));

/** Whether one set of rules gives a side a value of its own: by its edge, its pair or Custom CSS. */
export const setsSide = (rules: Record<string, StyleValue>, edge: string, pair: string | null, names: string[]) => rules[edge] !== undefined || (!!pair && rules[pair] !== undefined) || customSets(rules.customCss, names);

/**
 * Whether a value written at `scope` would be beaten on one side at the previewed size: by that size's own value
 * for the side, by Custom CSS in the same rule, or within one scope by the side's own value over a pair being
 * written.
 */
export function beaten(styles: ResponsiveStyles | undefined, scope: ResponsiveScope, shown: Size, edge: string, pair: string | null, writes: string, names: string[]): boolean {
  if (scope === 'base' && setsSide(at(styles, shown), edge, pair, names)) return true;
  // A container width's value beats every screen size wherever that width holds, which the canvas cannot tell here.
  if (CONTAINER_SCOPES.some((c) => setsSide(styles?.[c] ?? {}, edge, pair, names))) return true;
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
    sides.some((side) => [at(own, 'base'), at(own, shown), ...CONTAINER_SCOPES.map((c) => own?.[c] ?? {})].some((r) => setsSide(r, edgeOf(handleAt(h.box, side), rtl), h.pair, cssNames(h.box, side, rtl))));
  if (target.everyItem && target.items && Object.values(target.items).some(cardKeeps)) return null;
  return { handle: h, property, label: STYLE_PROP_MAP[property]?.label ?? property, sides };
}

const handleAt = (box: SpacingBox, side: SpacingSide) => SPACING_HANDLES.find((o) => o.box === box && o.side === side)!;

/** The media query a preview applies under: the edited size's own, so it never shows at another size. */
export const previewMedia = (scope: ResponsiveScope): string | null => (scope === 'base' ? null : MEDIA_QUERIES[scope]);

/** The CSS a preview gives the dragged box: each side that moves, as the stylesheet names it, set to the value. */
export function previewDecls(plan: HandlePlan, value: StyleValue, rtl: boolean): Array<[string, string]> {
  const css = typeof value === 'object' && value !== null ? (typeof value.token === 'string' ? `var(${tokenVar(value.token)})` : '') : String(value);
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
