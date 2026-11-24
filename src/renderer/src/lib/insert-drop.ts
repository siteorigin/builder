/**
 * Dropping something new from Insert onto a page on the canvas: which lists on the page can take it, and, as the
 * pointer moves, the list and the gap it points at. Geometry is in page pixels, as the preview measures it. Sections go
 * between the page's sections; elements (and components made from one) go into a container or a placed component's
 * slot, or between sections in a new Section of their own.
 */
import type { EditOperation } from '@shared/ops';
import type { OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles } from '@shared/types';
import { applyOperations } from '@engine/apply';
import { childLists } from '@engine/tree';
import { blocksSaving, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';
import type { InsertSpec } from './insert-search';
import { dropAt, shownOrder, type Box } from './reorder';
import { whereFor, type InsertAt, type InsertRole, type Where } from './insert-at';
import { treeFor } from './model';

/** A list a drop can go into, before it is measured: the page's top level (`parentId` null), an element's children,
 *  or one slot of a placed component. `refused` says why nothing goes here (a component that shows several slots,
 *  where the pointer is on none of them). `byChildren`: its box is where its children are (one of several slots). */
export interface ListSpec {
  parentId: string | null;
  slot?: string;
  childIds: string[];
  refused?: string;
  byChildren?: boolean;
  /** How deep its holder sits on the page (0: a top-level section), so of two the same size the inner one wins. */
  depth: number;
}

/** A node as the canvas measured it: its box, its CSS order among its siblings (`ordered`: its container lays its items
 *  out by order, a flex or grid one), and whether more than one copy shows. */
export type Measured = Box & { order: number; ordered?: boolean; many?: boolean };

/** A list as measured: its own box (none for the page's top level), and each child's measure (null: not shown here). */
export interface DropList extends ListSpec {
  box: Box | null;
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

/** The slots a placed component shows: those its design places (a declared slot left out is never seen), every declared
 *  one for code, which renders its own. */
function shownSlots(state: ProjectState, definitionId: string): string[] {
  const def = own(state.components, definitionId);
  const names = Object.keys(def?.slots ?? {});
  if (def?.kind !== 'managed' || !def.tree) return names;
  const placed = new Set(Object.values(def.tree.nodes).flatMap((n) => (n.kind === 'slot' ? [n.slot] : [])));
  return names.filter((n) => placed.has(n));
}

/** Every list on a page that a drop can go into: its top level first, then each container and component slot. */
export function dropListSpecs(state: ProjectState, owner: OwnerRef): ListSpec[] {
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
        // Each slot is found by what is in it; the rest of the component names no one slot.
        for (const slot of slots) if (filled(slot).length) lists.push({ parentId: id, slot, childIds: filled(slot), byChildren: true, depth: d + 0.5 });
        lists.push({ parentId: id, childIds: [], refused: 'It has more than one place for content. Drop it onto what is already in one, or select a place and click the tile.', depth: d });
      }
    }
  }
  return lists;
}

/** The node IDs a set of lists needs measured: each list's holder and each child, once each. */
export function measureIds(specs: ListSpec[]): string[] {
  const ids = new Set<string>();
  for (const l of specs) {
    if (l.parentId) ids.add(l.parentId);
    for (const c of l.childIds) ids.add(c);
  }
  return [...ids];
}

const union = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
};

/** The lists with their measures. A nested list that does not show (its holder hidden at this width) is left out. */
export function measuredLists(specs: ListSpec[], measured: Map<string, Measured | null>): DropList[] {
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
    const box = !l.parentId ? null : l.byChildren ? union(children.filter((c): c is Measured => !!c)) : holder;
    if (l.parentId && !box) return [];
    // Content a component shows more than once is only measured where it first shows: a drop there is not one place.
    const many = !!holder?.many || children.some((c) => c?.many);
    return [
      {
        ...l,
        box,
        children,
        ...(l.parentId && holder && besideSibling(l.parentId, holder) ? { sideways: true } : {}),
        ...(many && !l.refused ? { refused: 'This content shows more than once on the page. Select a place inside it and click the tile instead.' } : {})
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
  const top = lists.find((l) => l.parentId === null);
  if (!top) return null;
  const nested = role === 'element' ? lists.filter((l) => l.box && within(l.box, x, y, edge, l.sideways, !l.children.some(Boolean))) : [];
  const area = (b: Box) => b.width * b.height;
  // The innermost: the smallest box, and of two the same size (a grid filling its section), the deeper one.
  const list = nested.sort((a, b) => area(a.box!) - area(b.box!) || b.depth - a.depth)[0] ?? top;
  if (list.refused) return { list, index: null, line: null, refused: list.refused };
  // An element at the page's top level goes in a new Section of its own, which has no Order style.
  if (role === 'element' && list.parentId === null) own = 0;
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

/** The CSS order a new node of `spec` has: none for a basic element or a theme section; a component's design can set
 *  one on its root, and so can the variant options it is inserted with (null when it changes with the screen size). */
export function incomingOrder(state: ProjectState, spec: InsertSpec): number | null {
  if (!spec.definitionId) return 0;
  const def = own(state.components, spec.definitionId);
  const rootId = def?.kind === 'managed' && def.tree ? def.tree.rootIds[0] : undefined;
  const root = rootId ? own(def!.tree!.nodes, rootId) : undefined;
  const sources: ResponsiveStyles[] = [root && 'styles' in root && root.styles ? root.styles : {}];
  for (const [axis, a] of Object.entries(def?.variantAxes ?? {})) {
    const chosen = own(a.options, spec.variants?.[axis] ?? a.default);
    const styles = rootId ? own(chosen?.styles, rootId) : undefined;
    if (styles) sources.push(styles);
  }
  // At each screen size, the last source that sets it there wins (a variant's over the design's own); a size that sets
  // none takes the base one, and no Order at all is 0.
  const at = (scope: ResponsiveScope): unknown => sources.reduce<unknown>((v, styles) => (styles[scope] && Object.hasOwn(styles[scope]!, 'order') ? styles[scope]!.order : v), undefined);
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
  let next: ProjectState;
  try {
    next = applyOperations(state, ops).state;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const introduced = introducedDiagnostics(before(), savingProblems(next));
  return introduced.length ? introduced.map((d) => d.message).join(' ') : null;
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
 * (`own`: its CSS order, see incomingOrder): the lists that can take it, for the canvas to measure, and once they are
 * measured, what a drop at a point in page pixels does, the page drawn at `scale`. Whether the project takes it in a
 * list (`ops` there, the change the drop would make) is tried once per list, on a copy, against the problems the
 * project already has.
 */
export function insertDestination(state: ProjectState, owner: OwnerRef, role: InsertRole, own: number | null, ops: (at: InsertAt) => EditOperation[]) {
  const specs = dropListSpecs(state, owner);
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
  return { specs, aim };
}
