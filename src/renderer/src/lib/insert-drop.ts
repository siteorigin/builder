/**
 * Dropping something new from Insert onto a page on the canvas: which lists on the page can take it, and, as the
 * pointer moves, the list and the gap it points at. Geometry is in page pixels, as the preview measures it. Sections go
 * between the page's sections; elements (and components made from one) go into a container or a placed component's
 * slot, or between sections in a new Section of their own.
 */
import type { EditOperation } from '@shared/ops';
import type { GraphNode, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles } from '@shared/types';
import { CONTAINER_SCOPES } from '@shared/types';
import { applyOperations } from '@engine/apply';
import { childLists, findParent, subtreeIds } from '@engine/tree';
import { blocksSaving, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';
import type { InsertSpec } from './insert-search';
import { dropAt, dropReaches, moveIndex, shownOrder, type Box } from './reorder';
import { whereFor, type InsertAt, type InsertRole, type Where } from './insert-at';
import { treeFor } from './model';
import { shownSlots } from './slot-target';
import { catalogueComponent } from '@catalogue/index';

/** A list a drop can go into, before it is measured: the page's top level (`parentId` null), an element's children,
 *  or one slot of a placed component. `refused` says why nothing goes here (a component that shows several slots,
 *  where the pointer is on none of them). `byChildren`: its box is where its children are (one of several slots), or
 *  while none of them shows, the slot's placeholder. `byPlaceholder`: its box is the placeholder the slot shows while
 *  it is empty (#652). */
export interface ListSpec {
  parentId: string | null;
  slot?: string;
  childIds: string[];
  refused?: string;
  byChildren?: boolean;
  byPlaceholder?: boolean;
  /** How deep its holder sits on the page (0: a top-level section), so of two the same size the inner one wins. */
  depth: number;
}

/** A node as the canvas measured it: its box, its CSS order among its siblings (`ordered`: its container lays its items
 *  out by order, a flex or grid one), and whether more than one copy shows. `cssOrder`: the Order its own styles give
 *  it, which a container that ignores Order leaves out of `order` but one it is moved into would lay it out by. */
export type Measured = Box & { order: number; ordered?: boolean; many?: boolean; cssOrder?: number };

/** A list as measured: its own box (none for the page's top level), and each child's measure (null: not shown here). */
export interface DropList extends ListSpec {
  box: Box | null;
  /** An empty slot's placeholder as the page shows it, where `box` is made bigger (see measuredLists). */
  core?: Box;
  children: Array<Measured | null>;
  /** Its holder sits beside a sibling in a row (a column of a two-column grid): near its left or right edge, the drop
   *  goes between them rather than into it. */
  sideways?: boolean;
}

/** Where the pointer drops: the list, the index in its full list (null: no index there can be reached), the line that
 *  shows the gap, and why it is refused. */
export interface DropTarget {
  list: DropList;
  index: number | null;
  line: Box | null;
  refused?: string;
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** How a refusal says to put something in a place a drop can't reach: for a tile from Insert, by clicking it. */
const BY_CLICK = 'click the tile';

/** Every list on a page that a drop can go into: its top level first, then each container and component slot. `how`
 *  says how a refusal tells the author to put it in a place a drop can't reach. */
export function dropListSpecs(state: ProjectState, owner: OwnerRef, how = BY_CLICK): ListSpec[] {
  const tree = treeFor(state, owner);
  // A page, or a collection's layout, which is laid out like one.
  if (!tree || (owner.kind !== 'page' && owner.kind !== 'template')) return [];
  const lists: ListSpec[] = [{ parentId: null, childIds: [...tree.rootIds], depth: -1 }];
  // Each node attached to the page, from the top, once.
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = tree.rootIds.map((id) => [id, 0]);
  for (let i = 0; i < queue.length; i++) {
    const [id, d] = queue[i];
    const n = own(tree.nodes, id);
    if (!n || depth.has(id)) continue;
    depth.set(id, d);
    for (const l of childLists(n)) for (const c of l.ids) queue.push([c, d + 1]);
    if (n.kind === 'element') lists.push({ parentId: id, childIds: [...n.children], depth: d });
    else if (n.kind === 'instance') {
      const slots = shownSlots(state, n.definitionId);
      const filled = (slot: string) => (Array.isArray(n.slots?.[slot]) ? [...n.slots![slot]] : []);
      if (slots.length === 1) lists.push({ parentId: id, slot: slots[0], childIds: filled(slots[0]), depth: d });
      else if (slots.length > 1) {
        // Each slot is found by what is in it, or while it is empty by its placeholder; the rest of the component names
        // no one slot.
        for (const slot of slots) {
          const ids = filled(slot);
          lists.push(ids.length ? { parentId: id, slot, childIds: ids, byChildren: true, depth: d + 0.5 } : { parentId: id, slot, childIds: [], byPlaceholder: true, depth: d + 0.5 });
        }
        lists.push({ parentId: id, childIds: [], refused: `It has more than one place for content. Drop it onto one of them, or select one and ${how}.`, depth: d });
      }
    }
  }
  return lists;
}

/** What a set of lists needs measured: each list's holder and each child, once each, by node ID, and each empty slot's
 *  placeholder, by its slotKey. */
export function measureIds(specs: ListSpec[]): string[] {
  const ids = new Set<string>();
  for (const l of specs) {
    if (l.parentId) ids.add(l.parentId);
    for (const c of l.childIds) ids.add(c);
    if ((l.byPlaceholder || l.byChildren) && l.parentId && l.slot !== undefined) ids.add(slotKey(l.parentId, l.slot));
  }
  return [...ids];
}

/** How an empty slot's placeholder is measured among node IDs: a key no node ID is (they never start with "["). */
export const slotKey = (parentId: string, slot: string): string => JSON.stringify([parentId, slot]);

/** The placement and slot a measure key names, or null for a node ID. */
export function slotOfKey(key: string): { parentId: string; slot: string } | null {
  if (!key.startsWith('[')) return null;
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? { parentId: v[0], slot: v[1] } : null;
  } catch {
    return null;
  }
}

/** The least an empty slot's drop surface measures, in page pixels, however its container lays it out (#652). */
export const SLOT_DROP_MIN = 72;

/** An empty slot's placeholder box, at least SLOT_DROP_MIN tall from its top, and no wider than its component shows it
 *  (what spills sideways out of a narrow column is the next column's place). */
function slotSurface(b: Box, holder: Box | null): Box {
  const x = holder ? Math.max(b.x, holder.x) : b.x;
  const right = holder ? Math.min(b.x + b.width, holder.x + holder.width) : b.x + b.width;
  return { x, y: b.y, width: Math.max(0, right - x), height: Math.max(b.height, SLOT_DROP_MIN) };
}

/** The part of `b` inside `within` (none: an empty box at `b`'s top left). */
function clip(b: Box, within: Box | null): Box {
  if (!within) return b;
  const x = Math.max(b.x, within.x);
  const y = Math.max(b.y, within.y);
  const right = Math.min(b.x + b.width, within.x + within.width);
  const bottom = Math.min(b.y + b.height, within.y + within.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : { x: b.x, y: b.y, width: 0, height: 0 };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const union = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
};

/**
 * The lists with their measures. A nested list that does not show (its holder hidden at this width) is left out, and so
 * is an empty slot whose component does not show it. An empty slot's box is its placeholder's, made at least
 * SLOT_DROP_MIN tall (its container may be collapsed); two of one component that would then cover each other (two
 * collapsed columns, one above the other) are laid out one below the other, so each can be reached. Its `core` is
 * what the page shows of the placeholder: the part inside its component's own box.
 */
export function measuredLists(specs: ListSpec[], measured: Map<string, Measured | null>, how = BY_CLICK): DropList[] {
  const lists = measuredBoxes(specs, measured, how);
  const placed = new Map<string, Box[]>();
  return lists.map((l) => {
    if (!l.byPlaceholder || !l.box || !l.parentId) return l;
    const others = placed.get(l.parentId) ?? [];
    let box = l.box;
    for (let moved = true; moved; ) {
      moved = false;
      for (const p of others)
        if (overlaps(box, p)) {
          box = { ...box, y: p.y + p.height };
          moved = true;
        }
    }
    placed.set(l.parentId, [...others, box]);
    return box === l.box ? l : { ...l, box };
  });
}

function measuredBoxes(specs: ListSpec[], measured: Map<string, Measured | null>, how: string): DropList[] {
  const at = (id: string) => measured.get(id) ?? null;
  // The list each node sits in, for whether a holder shares a row with a sibling.
  const inList = new Map<string, ListSpec>();
  for (const l of specs) for (const c of l.childIds) inList.set(c, l);
  const besideSibling = (id: string, box: Box) =>
    (inList.get(id)?.childIds ?? []).some((other) => {
      const b = other === id ? null : at(other);
      return !!b && b.y < box.y + box.height && b.y + b.height > box.y && (b.x + b.width <= box.x + 1 || b.x >= box.x + box.width - 1);
    });
  return specs.flatMap((l): DropList[] => {
    const children = l.childIds.map(at);
    const holder = l.parentId ? at(l.parentId) : null;
    const placeholder = (l.byPlaceholder || l.byChildren) && l.parentId && l.slot !== undefined ? at(slotKey(l.parentId, l.slot)) : null;
    const shown = l.byChildren ? union(children.filter((c): c is Measured => !!c)) : null;
    // A slot whose content all hides here (a layout's entry it is not shown for) shows its placeholder instead.
    const byPlaceholder = !!placeholder && (l.byPlaceholder || (l.byChildren && !shown));
    const mark = byPlaceholder ? { x: placeholder!.x, y: placeholder!.y, width: placeholder!.width, height: placeholder!.height } : undefined;
    const core = mark && clip(mark, holder);
    const box = !l.parentId ? null : mark ? slotSurface(mark, holder) : l.byChildren ? shown : l.byPlaceholder ? null : holder;
    if (l.parentId && !box) return [];
    // Content a component shows more than once is only measured where it first shows: a drop there is not one place.
    const many = !!holder?.many || !!placeholder?.many || children.some((c) => c?.many);
    return [
      {
        ...l,
        ...(byPlaceholder ? { byPlaceholder: true, core } : {}),
        box,
        children,
        ...(l.parentId && holder && besideSibling(l.parentId, holder) ? { sideways: true } : {}),
        ...(many && !l.refused ? { refused: `This content shows more than once on the page. Select a place inside it and ${how} instead.` } : {})
      }
    ];
  });
}

/**
 * The full-list index a new node lands at to show in gap `to` of the shown order (`shown` holds visible siblings'
 * full indexes in the order the page lays them out; `order` their CSS order). `own` is the new node's CSS order (null
 * when it changes with the screen size). The page lays items out by order, then document order, so the gap is
 * reached only when the new node's order sits between its neighbours'. Null when no index reaches it.
 */
export function insertIndex(shown: number[], to: number, order: (i: number) => number, own: number | null, length = shown.length ? Math.max(...shown) + 1 : 0): number | null {
  // Nothing else shows: it is the only one there, wherever it goes.
  if (!shown.length) return length;
  if (own === null) return null;
  const prev = to > 0 ? shown[to - 1] : undefined;
  const next = to < shown.length ? shown[to] : undefined;
  const prevO = prev === undefined ? -Infinity : order(prev);
  const nextO = next === undefined ? Infinity : order(next);
  if (prevO > own || nextO < own) return null;
  if (next !== undefined && nextO === own) return next;
  if (prev !== undefined) return prev + 1;
  return next ?? length;
}

/**
 * Whether (x, y) is inside `b`, clear of its top and bottom by `edge` pixels or a quarter of its height (and of its
 * left and right, `sideways`). An empty container thinner than `edge` (a new row is a line) takes the pointer within
 * half an `edge` of its middle.
 */
const within = (b: Box, x: number, y: number, edge: number, sideways = false, empty = false) => {
  const ex = sideways ? Math.min(edge, b.width / 4) : 0;
  if (x < b.x + ex || x > b.x + b.width - ex) return false;
  if (empty && b.height < edge) return Math.abs(y - (b.y + b.height / 2)) <= edge / 2;
  const e = Math.min(edge, b.height / 4);
  return y >= b.y + e && y <= b.y + b.height - e;
};

/**
 * Where a drop at (x, y) goes. A section goes in the page's top level. An element goes in the innermost list whose box
 * holds the pointer, more than `edge` from its top and bottom: near an edge it goes beside that container instead, and
 * outside every container, between the page's sections. `own` is the new node's CSS order (see insertIndex).
 */
export function dropTarget(lists: DropList[], role: InsertRole, x: number, y: number, edge: number, own: number | null): DropTarget | null {
  const list = listAt(lists, role, x, y, edge);
  if (!list) return null;
  if (list.refused) return { list, index: null, line: null, refused: list.refused };
  // An element at the page's top level goes in a new Section of its own, which has no Order style.
  if (role === 'element' && list.parentId === null) own = 0;
  return gapFor(list, x, y, own);
}

/** The list a drop at (x, y) goes into (see dropTarget): the innermost one under the pointer, or the page's top level;
 *  null when there are no lists at all. */
function listAt(lists: DropList[], role: InsertRole, x: number, y: number, edge: number): DropList | null {
  const top = lists.find((l) => l.parentId === null);
  if (!top) return null;
  // An empty slot's surface takes the pointer anywhere on it: it is a place of its own, with nothing to go beside.
  const hit = role === 'element' ? lists.filter((l) => l.box && within(l.box, x, y, l.byPlaceholder ? 0 : edge, l.sideways, !l.children.some(Boolean))) : [];
  // A slot's surface made bigger than what the page shows of its placeholder (see measuredLists) gives way, there, to
  // what the page shows beside it (a filled slot, a container, the next section): only what holds the placeholder
  // stays behind it.
  const real = (l: DropList) => !l.core || (x >= l.core.x && x <= l.core.x + l.core.width && y >= l.core.y && y <= l.core.y + l.core.height);
  const holds = (b: Box, c: Box) => b.x <= c.x + 0.5 && b.y <= c.y + 0.5 && b.x + b.width >= c.x + c.width - 0.5 && b.y + b.height >= c.y + c.height - 0.5;
  const onPage = hit.filter((l) => real(l) || !hit.some((o) => o !== l && real(o) && !holds(o.box!, l.core!)));
  // On one of a component's slots, the rest of the component (which names no slot) is not under the pointer.
  const onSlot = new Set(onPage.flatMap((l) => (l.slot !== undefined && l.parentId ? [l.parentId] : [])));
  const nested = onPage.filter((l) => !(l.refused && l.slot === undefined && l.parentId && onSlot.has(l.parentId)));
  // On what the page shows of a slot's placeholder, the slot counts by that part, which its surface can outgrow (see
  // measuredLists); off it, by its whole surface.
  const area = (l: DropList) => {
    const b = l.core && l.core.width * l.core.height > 0 && real(l) ? l.core : l.box!;
    return b.width * b.height;
  };
  // The innermost: the smallest box, and of two the same size (a grid filling its section), the deeper one.
  return nested.sort((a, b) => area(a) - area(b) || b.depth - a.depth)[0] ?? top;
}

/** The gap at (x, y) in `list` for a node of CSS order `own` that is not in it yet (see insertIndex). */
function gapFor(list: DropList, x: number, y: number, own: number | null): DropTarget {
  const visible = list.children.flatMap((c, i) => (c ? [i] : []));
  // A container that lays its items out as they come (not flex or grid) ignores Order: the new node's too.
  if (visible.length && !visible.some((i) => list.children[i]?.ordered)) own = 0;
  const order = (i: number) => list.children[i]?.order ?? 0;
  const shown = shownOrder(visible, order);
  const length = list.childIds.length;
  if (!shown.length) {
    // Nothing shows in it: the new node goes at its end, the only one shown there, and the list's own outline shows where.
    return { list, index: length, line: null };
  }
  const drop = dropAt(
    shown.map((i) => list.children[i]!),
    x,
    y
  );
  const index = insertIndex(shown, drop.to, order, own, length);
  return { list, index, line: index === null ? null : drop.line, ...(index === null ? { refused: ORDER } : {}) };
}

const ORDER = 'An Order style puts the elements here in another order than the page shows, so it can’t go in that spot at this size.';

/** The CSS order a new node of `spec` has: none for a basic element; a component's design (a theme's, as the project
 *  has it once installed) can set one on its root, and so can the variant options it is inserted with (null when it
 *  changes with the screen size). */
export function incomingOrder(state: ProjectState, spec: InsertSpec): number | null {
  const themed = !spec.definitionId && spec.componentId !== undefined ? catalogueComponent(state.site.themeId, spec.componentId) : undefined;
  const def = spec.definitionId ? own(state.components, spec.definitionId) : themed ? (own(state.components, themed.id) ?? themed) : undefined;
  if (!def) return 0;
  const rootId = def?.kind === 'managed' && def.tree ? def.tree.rootIds[0] : undefined;
  const root = rootId ? own(def.tree!.nodes, rootId) : undefined;
  const sources: ResponsiveStyles[] = [root && 'styles' in root && root.styles ? root.styles : {}];
  for (const [axis, a] of Object.entries(def.variantAxes ?? {})) {
    const chosen = own(a.options, spec.variants?.[axis] ?? a.default);
    const styles = rootId ? own(chosen?.styles, rootId) : undefined;
    if (styles) sources.push(styles);
  }
  // At each screen size, the last source that sets it there wins (a variant's over the design's own); a size that sets
  // none takes the base one, and no Order at all is 0.
  const at = (scope: ResponsiveScope): unknown => sources.reduce<unknown>((v, styles) => (styles[scope] && Object.hasOwn(styles[scope]!, 'order') ? styles[scope]!.order : v), undefined);
  // An Order for a width of the container around it changes with where it lands: not known either.
  if (sources.some((styles) => CONTAINER_SCOPES.some((scope) => styles[scope] && Object.hasOwn(styles[scope]!, 'order')))) return null;
  const base = at('base') ?? 0;
  const sizes = (['base', 'phone', 'tablet', 'desktop'] as const).map((scope) => Number(at(scope) ?? base));
  // One Order at every size is that Order; one that changes with the size is not known.
  return sizes.every((n) => Number.isSafeInteger(n) && n === sizes[0]) ? sizes[0] : null;
}

/**
 * Why the project would refuse `ops`, tried on a copy, or null when it takes them: what the operations themselves
 * refuse (a slot that takes only some things, a full one), and, as the project checks before it saves, a problem
 * they bring that stops saving (a button inside a card that is itself a link). `before` is the project's own
 * problems of that kind, worked out once (see savingProblems).
 */
export function dropRefusal(state: ProjectState, ops: EditOperation[], before: () => Diagnostic[]): string | null {
  return tryDrop(state, ops, before).refused;
}

/** dropRefusal, with the project as `ops` leave it when it takes them. */
function tryDrop(state: ProjectState, ops: EditOperation[], before: () => Diagnostic[]): { refused: string; next?: undefined } | { refused: null; next: ProjectState } {
  let next: ProjectState;
  try {
    next = applyOperations(state, ops).state;
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
  const introduced = introducedDiagnostics(before(), savingProblems(next));
  return introduced.length ? { refused: introduced.map((d) => d.message).join(' ') } : { refused: null, next };
}

/** The problems that stop a project being saved, as the project counts them before a change. */
export const savingProblems = (state: ProjectState): Diagnostic[] => validateState(state, { sectionLinks: false }).filter(blocksSaving);

/** How near a container's top or bottom edge (in screen pixels) a drop goes beside it rather than into it. */
export const INSERT_EDGE = 10;

/**
 * What a drop at a point does, as a drag shows it: the place (null where nothing goes), why nothing can go there, the
 * gap's line and the outline of the list it goes into (in page pixels), and the place in words.
 */
export interface InsertAim {
  at: InsertAt | null;
  refused: string | null;
  line: Box | null;
  outline: Box | null;
  where: Where;
}

/**
 * The canvas drop destination every drag of something new shares, so an Insert tile (#52) and an Assets image dropped
 * between content (#506) go to the same place and show it the same way. For something placed as `role` on `owner`
 * (`own`: its CSS order, see incomingOrder): the lists that can take it, for the canvas to measure (`specs`, then
 * `lists` with their measures), and what a drop at a point in page pixels does, the page drawn at `scale`. Whether the
 * project takes it in a list (`ops` there, the change the drop would make) is tried once per list, on a copy, against
 * the problems the project already has. `how` says how to put it where a drop can't reach (see dropListSpecs).
 * `surfaces` are the empty slots of components that show several, as the drag draws them while it runs: each one's box
 * (at least SLOT_DROP_MIN each way, see measuredLists) and label, less those the project would refuse it in.
 */
export function insertDestination(state: ProjectState, owner: OwnerRef, role: InsertRole, own: number | null, ops: (at: InsertAt) => EditOperation[], how = BY_CLICK) {
  const specs = dropListSpecs(state, owner, how);
  const lists = (measured: Map<string, Measured | null>) => measuredLists(specs, measured, how);
  const checked = new Map<string, string | null>();
  let problems: Diagnostic[] | null = null;
  const refusal = (at: InsertAt) => {
    const key = JSON.stringify([at.parentId, at.slot ?? null]);
    if (!checked.has(key)) checked.set(key, dropRefusal(state, ops(at), () => (problems ??= savingProblems(state))));
    return checked.get(key) ?? null;
  };
  const aim = (lists: DropList[], x: number, y: number, scale: number): InsertAim | null => {
    const t = dropTarget(lists, role, x, y, INSERT_EDGE / scale, own);
    if (!t) return null;
    const at: InsertAt = { owner, parentId: t.list.parentId, ...(t.list.slot ? { slot: t.list.slot } : {}), ...(t.index !== null ? { index: t.index } : {}) };
    const refused = t.refused ?? (t.index === null ? null : refusal(at));
    // An empty row measures as a line: its outline is drawn at least 4 screen pixels tall.
    const box = t.list.box;
    const outline = box && box.height * scale < 4 ? { ...box, y: box.y - 2 / scale, height: 4 / scale } : box;
    if (refused || t.index === null) return { at: null, refused, line: null, outline, where: null };
    return { at, refused: null, line: t.line, outline, where: whereFor(state, at, role) };
  };
  const surfaces = (lists: DropList[]): SlotSurface[] =>
    role !== 'element'
      ? []
      : lists.flatMap((l) => {
          if (!l.byPlaceholder || !l.box || l.refused || !l.parentId || l.slot === undefined) return [];
          if (refusal({ owner, parentId: l.parentId, slot: l.slot, index: l.childIds.length })) return [];
          return [{ key: slotKey(l.parentId, l.slot), box: l.box, label: slotLabel(state, owner, l.parentId, l.slot) }];
        });
  return { specs, lists, aim, surfaces };
}

/** An empty slot a drag can drop into, as it is drawn while the drag runs (see insertDestination). */
export interface SlotSurface {
  key: string;
  box: Box;
  label: string;
}

/** The label a placement's slot is shown by. */
function slotLabel(state: ProjectState, owner: OwnerRef, parentId: string, slot: string): string {
  const node = own(treeFor(state, owner)?.nodes, parentId);
  const label = node?.kind === 'instance' ? own(own(state.components, node.definitionId)?.slots, slot)?.label : undefined;
  return typeof label === 'string' && label.trim() ? label.trim() : slot;
}

/** How a refusal tells the author to move something to a place a drag on the canvas can't reach. */
const IN_LAYERS = 'use Layers';

/** Why a node can't go into a list inside itself. */
export const INSIDE_ITSELF = 'It can’t go inside itself.';

/** Why an element can't be moved between the page's sections: a move takes no new Section around it. */
export const MOVE_TOP = 'Only sections go between sections. Drop it into a section, a container or a component’s slot.';

/** Why a node the page shows more than once (content a component repeats), or not at all here, is not dragged on the
 *  canvas: a move would take every copy, from a place the drag can't show. */
export const MOVE_UNSHOWN = 'It doesn’t show once on the page at this size, so a drag can’t move it. Use Layers instead.';

/** Where the node being moved is, for a drag of it: its list, everything inside it (and itself), and its own CSS order
 *  (null: it changes with the width of the container it would land in, so no gap in another list is known to show it). */
export interface MoveSource {
  nodeId: string;
  parentId: string | null;
  slot?: string;
  inside: ReadonlySet<string>;
  own: number | null;
}

/**
 * Where a drop at (x, y) moves an existing node (#658): into the list under the pointer as dropTarget finds it, never
 * one inside itself, and for an element never between the page's sections. In its own list the gap is counted as
 * node.move counts it, with the node taken out first (see moveIndex): a gap either side of where it is moves nothing
 * (`index` null, nothing refused), and one an Order style keeps it out of is refused. In another list it lands as a new
 * node of its own CSS order would (see insertIndex).
 */
export function moveTarget(lists: DropList[], role: InsertRole, src: MoveSource, x: number, y: number, edge: number): DropTarget | null {
  const list = listAt(lists, role, x, y, edge);
  if (!list) return null;
  if (list.parentId !== null && src.inside.has(list.parentId)) return { list, index: null, line: null, refused: INSIDE_ITSELF };
  if (list.refused) return { list, index: null, line: null, refused: list.refused };
  if (role === 'element' && list.parentId === null) return { list, index: null, line: null, refused: MOVE_TOP };
  if (list.parentId !== src.parentId || list.slot !== src.slot) return gapFor(list, x, y, src.own);
  const from = list.childIds.indexOf(src.nodeId);
  const order = (i: number) => list.children[i]?.order ?? 0;
  const shown = shownOrder(
    list.children.flatMap((c, i) => (c ? [i] : [])),
    order
  );
  // Not shown where it is (the page did not answer for it): nowhere among its siblings is known to be another place.
  if (!shown.includes(from)) return { list, index: null, line: null };
  const drop = dropAt(
    shown.map((i) => list.children[i]!),
    x,
    y
  );
  if (!dropReaches(shown, from, drop.to, order)) return { list, index: null, line: null, refused: ORDER };
  const index = moveIndex(shown, from, drop.to, order);
  return { list, index, line: index === null ? null : drop.line };
}

/** What a drop at a point does with the node being moved, as a drag shows it (see InsertAim): `op` is the one node.move
 *  a release applies, null where it changes nothing or is refused. */
export interface MoveAim {
  op: Extract<EditOperation, { type: 'node.move' }> | null;
  refused: string | null;
  line: Box | null;
  outline: Box | null;
  where: Where;
}

/**
 * The canvas destination for dragging an existing node of `owner`'s tree (#658), shaped like insertDestination: a
 * section moves among the page's sections; an element into any container or component slot on the page that shows
 * once, as its own list does. Each move a drop would make is tried once, on a copy, as node.move itself checks it (a
 * slot's contract, a node inside itself) and with what it would bring that stops saving (a link inside a card that is
 * itself a link). Null when the node is not one a drag finds the list of (the page's top level, a container or a
 * shown slot of a placement), for the caller to keep it among its siblings.
 */
export function moveDestination(state: ProjectState, owner: OwnerRef, nodeId: string) {
  const tree = treeFor(state, owner);
  const info = tree && findParent(tree, nodeId);
  if (!tree || !info) return null;
  const role: InsertRole = info.parentId === null ? 'section' : 'element';
  const all = dropListSpecs(state, owner, IN_LAYERS);
  if (!all.some((l) => l.parentId === info.parentId && l.slot === info.slot && !l.refused)) return null;
  const specs = role === 'section' ? all.filter((l) => l.parentId === null) : all;
  const inside = new Set(subtreeIds(tree, nodeId));
  // An Order for a width of the container around it changes with where it lands: not known.
  const varies = rootStyles(state, own(tree.nodes, nodeId)).some((styles) => CONTAINER_SCOPES.some((scope) => styles[scope] && Object.hasOwn(styles[scope]!, 'order')));
  const lists = (measured: Map<string, Measured | null>) => measuredLists(specs, measured, IN_LAYERS);
  // Where the page shows it: once, or the drag refuses everywhere (see MOVE_UNSHOWN).
  const shownAt = (lists: DropList[]): Measured | null => {
    const list = lists.find((l) => l.parentId === info.parentId && l.slot === info.slot);
    const at = list?.children[info.index];
    return list && !list.refused && at && !at.many ? at : null;
  };
  const source = (at: Measured): MoveSource => ({ nodeId, parentId: info.parentId, ...(info.slot !== undefined ? { slot: info.slot } : {}), inside, own: varies ? null : (at.cssOrder ?? at.order) });
  const checked = new Map<string, { refused: string | null; where: Where }>();
  let problems: Diagnostic[] | null = null;
  const check = (op: NonNullable<MoveAim['op']>) => {
    const key = JSON.stringify([op.parentId, op.slot ?? null, op.index]);
    let out = checked.get(key);
    if (!out) {
      const tried = tryDrop(state, [op], () => (problems ??= savingProblems(state)));
      // Named in the project as the move leaves it, so the node before the gap is never the one moved.
      out = tried.refused !== null ? { refused: tried.refused, where: null } : { refused: null, where: whereFor(tried.next, { owner, parentId: op.parentId ?? null, ...(op.slot !== undefined ? { slot: op.slot } : {}), index: op.index }, role) };
      checked.set(key, out);
    }
    return out;
  };
  const moveOp = (parentId: string | null, slot: string | undefined, index: number): NonNullable<MoveAim['op']> => ({ type: 'node.move', owner, nodeId, parentId, ...(slot !== undefined ? { slot } : {}), index });
  const aim = (lists: DropList[], x: number, y: number, scale: number): MoveAim | null => {
    const at = shownAt(lists);
    if (!at) return { op: null, refused: MOVE_UNSHOWN, line: null, outline: null, where: null };
    const t = moveTarget(lists, role, source(at), x, y, INSERT_EDGE / scale);
    if (!t) return null;
    const box = t.list.box;
    const outline = box && box.height * scale < 4 ? { ...box, y: box.y - 2 / scale, height: 4 / scale } : box;
    if (t.refused || t.index === null) return { op: null, refused: t.refused ?? null, line: null, outline, where: null };
    const op = moveOp(t.list.parentId, t.list.slot, t.index);
    const { refused, where } = check(op);
    if (refused) return { op: null, refused, line: null, outline, where: null };
    return { op, refused: null, line: t.line, outline, where };
  };
  const surfaces = (lists: DropList[]): SlotSurface[] =>
    role !== 'element' || !shownAt(lists)
      ? []
      : lists.flatMap((l) => {
          if (!l.byPlaceholder || !l.box || l.refused || !l.parentId || l.slot === undefined || inside.has(l.parentId)) return [];
          if (check(moveOp(l.parentId, l.slot, l.childIds.length)).refused) return [];
          return [{ key: slotKey(l.parentId, l.slot), box: l.box, label: slotLabel(state, owner, l.parentId, l.slot) }];
        });
  return { role, specs, lists, aim, surfaces };
}

/** The styles that reach what a node lays out as: its own, and for a placement its component's root, the variant
 *  options it is placed with (every one, for a choice bound to content), and the placement's overrides of it. */
function rootStyles(state: ProjectState, node: GraphNode | undefined): ResponsiveStyles[] {
  if (!node) return [];
  const out: ResponsiveStyles[] = 'styles' in node && node.styles ? [node.styles as ResponsiveStyles] : [];
  if (node.kind !== 'instance') return out;
  const def = own(state.components, node.definitionId);
  const rootId = def?.kind === 'managed' && def.tree ? def.tree.rootIds[0] : undefined;
  const root = rootId ? own(def!.tree!.nodes, rootId) : undefined;
  if (root && 'styles' in root && root.styles) out.push(root.styles as ResponsiveStyles);
  for (const [name, axis] of Object.entries(def?.variantAxes ?? {})) {
    const chosen = own(node.variants ?? {}, name) ?? axis.default;
    for (const option of typeof chosen === 'string' ? [own(axis.options ?? {}, chosen)] : Object.values(axis.options ?? {})) {
      const styles = rootId && option ? own(option.styles, rootId) : undefined;
      if (styles) out.push(styles);
    }
  }
  const over = own(node.overrides, 'root');
  if (over) out.push(over);
  return out;
}
