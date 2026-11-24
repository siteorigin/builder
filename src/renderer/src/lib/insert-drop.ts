/**
 * Dropping something new from Insert onto a page on the canvas: which lists on the page can take it, and, as the
 * pointer moves, the list and the gap it points at. Geometry is in page pixels, as the preview measures it. Sections go
 * between the page's sections; elements (and components made from one) go into a container or a placed component's
 * slot, or between sections in a new Section of their own.
 */
import type { OwnerRef, ProjectState } from '@shared/types';
import { childLists } from '@engine/tree';
import type { InsertSpec } from './insert-search';
import { dropAt, shownOrder, type Box } from './reorder';
import { type InsertRole } from './insert-at';
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

/** A node as the canvas measured it: its box, its CSS order among its siblings, and whether more than one copy shows. */
export type Measured = Box & { order: number; many?: boolean };

/** A list as measured: its own box (none for the page's top level), and each child's measure (null: not shown here). */
export interface DropList extends ListSpec {
  box: Box | null;
  children: Array<Measured | null>;
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
  if (!tree || owner.kind !== 'page') return [];
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
  return specs.flatMap((l): DropList[] => {
    const children = l.childIds.map(at);
    const holder = l.parentId ? at(l.parentId) : null;
    const box = !l.parentId ? null : l.byChildren ? union(children.filter((c): c is Measured => !!c)) : holder;
    if (l.parentId && !box) return [];
    // Content a component shows more than once is only measured where it first shows: a drop there is not one place.
    const many = !!holder?.many || children.some((c) => c?.many);
    return [{ ...l, box, children, ...(many && !l.refused ? { refused: 'This content shows more than once on the page. Select a place inside it and click the tile instead.' } : {}) }];
  });
}

/**
 * The full-list index a new node lands at to show in gap `to` of the shown order (`shown` holds visible siblings'
 * full indexes in the order the page lays them out; `order` their CSS order). `own` is the new node's CSS order (null
 * when it changes with the screen size). The page lays items out by order, then document order, so the gap is
 * reached only when the new node's order sits between its neighbours'. Null when no index reaches it.
 */
export function insertIndex(shown: number[], to: number, order: (i: number) => number, own: number | null, length = shown.length ? Math.max(...shown) + 1 : 0): number | null {
  if (!shown.length) return own === null && length ? null : length;
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

/** Whether (x, y) is inside `b`, `edge` pixels clear of its top and bottom. */
const within = (b: Box, x: number, y: number, edge: number) => {
  const e = Math.min(edge, b.height / 4);
  return x >= b.x && x <= b.x + b.width && y >= b.y + e && y <= b.y + b.height - e;
};

/**
 * Where a drop at (x, y) goes. A section goes in the page's top level. An element goes in the innermost list whose box
 * holds the pointer, more than `edge` from its top and bottom: near an edge it goes beside that container instead, and
 * outside every container, between the page's sections. `own` is the new node's CSS order (see insertIndex).
 */
export function dropTarget(lists: DropList[], role: InsertRole, x: number, y: number, edge: number, own: number | null): DropTarget | null {
  const top = lists.find((l) => l.parentId === null);
  if (!top) return null;
  const nested = role === 'element' ? lists.filter((l) => l.box && within(l.box, x, y, edge)) : [];
  const area = (b: Box) => b.width * b.height;
  // The innermost: the smallest box, and of two the same size (a grid filling its section), the deeper one.
  const list = nested.sort((a, b) => area(a.box!) - area(b.box!) || b.depth - a.depth)[0] ?? top;
  if (list.refused) return { list, index: null, line: null, refused: list.refused };
  const visible = list.children.flatMap((c, i) => (c ? [i] : []));
  const order = (i: number) => list.children[i]?.order ?? 0;
  const shown = shownOrder(visible, order);
  const length = list.childIds.length;
  if (!shown.length) {
    // Nothing shows in it: the new node goes at its end, and the list's own outline shows where.
    const index = own === null && length ? null : length;
    return { list, index, line: null, ...(index === null ? { refused: ORDER } : {}) };
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
 *  one on its root (null when it changes with the screen size). */
export function incomingOrder(state: ProjectState, spec: InsertSpec): number | null {
  if (!spec.definitionId) return 0;
  const def = own(state.components, spec.definitionId);
  const root = def?.kind === 'managed' && def.tree ? own(def.tree.nodes, def.tree.rootIds[0] ?? '') : undefined;
  const styles = root && 'styles' in root ? root.styles : undefined;
  const values = Object.entries(styles ?? {}).flatMap(([scope, props]) => (props && Object.hasOwn(props, 'order') ? [[scope, props.order] as const] : []));
  if (!values.length) return 0;
  if (values.length > 1 || values[0][0] !== 'base') return null;
  const n = Number(values[0][1]);
  return Number.isSafeInteger(n) ? n : null;
}
