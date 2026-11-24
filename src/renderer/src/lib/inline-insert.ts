/**
 * The canvas's own Add buttons (#387): a + on the top and bottom edges of a selected or hovered section, for a section
 * above or below it, and one inside a selected container or placed component's slot (or a hovered empty one), for an
 * element in it. Each opens a short searchable list of what fits there, and what is chosen goes exactly there. Worked
 * out on a project's state alone; the canvas draws them on the outline of what they belong to.
 */
import type { ElementRef, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { Diagnostic } from '@engine/validate';
import { childLists } from '@engine/tree';
import { catalogueEntries, CATEGORY_LABELS } from '@catalogue/index';
import { definitionRole, heldSlots, insertOps, shownOnceSlots, type InsertAt, type InsertRole } from './insert-at';
import { dropRefusal, savingProblems } from './insert-drop';
import { BASICS, basicHay, basicSpec, type InsertSpec } from './insert-search';
import { refLabel, treeFor } from './model';

/** Which side of its node a + sits on: above or below a section of the page, or inside a container. */
export type AddSide = 'before' | 'after' | 'inside';

/**
 * A place the canvas offers a + for. It is kept by the node it belongs to, not by index, so the place is worked out
 * again from the project as it is when something is chosen (resolvePoint).
 */
export interface AddPoint {
  /** The place itself (its list and index), so two buttons for one gap (below one section, above the next) are one. */
  key: string;
  side: AddSide;
  /** What goes there: a section between the page's sections, an element inside a container. */
  role: InsertRole;
  owner: OwnerRef;
  /** The section it is above or below, or the container (or placed component) it goes into. */
  nodeId: string;
  /** The placed component's slot it goes into. */
  slot?: string;
  /** What the author sees it on, by name ("Hero", "Row"), for the button's name and the list's heading. */
  name: string;
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

const sameOwner = (a: OwnerRef, b: OwnerRef) => a.kind === b.kind && a.id === b.id;

/** A place's key: its list and its index there (the end when none). */
const keyOf = (at: InsertAt) => JSON.stringify([at.parentId, at.slot ?? null, at.index ?? null]);

/**
 * The Add buttons for `ref`, selected or (`hovered`) under the pointer, on a page or a collection's layout. A section of
 * the page itself (not one placed inside another) gets one above and one below it. A container gets one inside, and so
 * does a placed component that shows one slot (once, not inside a repeat), or a part of a placement that holds exactly one of its slots (a
 * Section's Container holds its Content, #185); hovered, only while that list is empty, so moving over a filled page
 * does not scatter buttons over it. Where the slot it would fill is not plain (a component showing several, a part
 * holding two), there is none: what is chosen must go where the button is. Nothing for a repeated item, the shared
 * header or footer, a component being edited, or anything else.
 */
export function addPoints(state: ProjectState, owner: OwnerRef, ref: ElementRef | null, hovered = false): AddPoint[] {
  if (!ref || ref.itemPath?.length || !sameOwner(ref.owner, owner) || (owner.kind !== 'page' && owner.kind !== 'template')) return [];
  const tree = treeFor(state, owner);
  if (!tree) return [];
  const points: AddPoint[] = [];
  const name = refLabel(state, ref);
  if (!ref.instancePath.length) {
    const i = tree.rootIds.indexOf(ref.nodeId);
    if (i >= 0)
      for (const side of ['before', 'after'] as const) points.push({ key: keyOf({ owner, parentId: null, index: side === 'before' ? i : i + 1 }), side, role: 'section', owner, nodeId: ref.nodeId, name });
  }
  const inside = insideOf(state, tree, ref);
  if (!inside) return points;
  const node = own(tree.nodes, inside.nodeId);
  const list = node ? childLists(node).find((l) => (inside.slot ? l.slot === inside.slot : !l.slot)) : undefined;
  if (hovered && list?.ids.length) return points;
  const at: InsertAt = { owner, parentId: inside.nodeId, ...(inside.slot ? { slot: inside.slot } : {}) };
  points.push({ key: keyOf(at), side: 'inside', role: 'element', owner, nodeId: inside.nodeId, ...(inside.slot ? { slot: inside.slot } : {}), name });
  return points;
}

/** The list an element goes into from inside `ref`, when there is exactly one: a container's children, the one slot a
 *  placement shows, or the one slot a part of it holds. */
function insideOf(state: ProjectState, tree: NodeTree, ref: ElementRef): { nodeId: string; slot?: string } | null {
  if (ref.instancePath.length > 1) return null;
  if (ref.instancePath.length === 1) {
    const held = heldSlots(state, ref);
    return held.length === 1 && own(tree.nodes, ref.instancePath[0]) ? { nodeId: ref.instancePath[0], slot: held[0] } : null;
  }
  const node = own(tree.nodes, ref.nodeId);
  if (node?.kind === 'element') return { nodeId: node.id };
  if (node?.kind !== 'instance') return null;
  const shown = shownOnceSlots(state, node.definitionId);
  return shown.length === 1 ? { nodeId: node.id, slot: shown[0] } : null;
}

/**
 * Where something chosen from a + goes, in the project as it is now: above or below its section wherever that section
 * is now, or at the end of its container. Null when the section or container has gone, has stopped being one of the
 * page's sections, or no longer has the slot.
 */
export function resolvePoint(state: ProjectState, p: AddPoint): InsertAt | null {
  const tree = treeFor(state, p.owner);
  const node = tree ? own(tree.nodes, p.nodeId) : undefined;
  if (!tree || !node) return null;
  if (p.side === 'inside') {
    if (p.slot) return node.kind === 'instance' && Object.hasOwn(own(state.components, node.definitionId)?.slots ?? {}, p.slot) ? { owner: p.owner, parentId: node.id, slot: p.slot } : null;
    return node.kind === 'element' ? { owner: p.owner, parentId: node.id } : null;
  }
  const i = tree.rootIds.indexOf(p.nodeId);
  return i < 0 ? null : { owner: p.owner, parentId: null, index: p.side === 'before' ? i : i + 1 };
}

/** What a + says it does, for its accessible name and tooltip, and the list's heading. */
export function pointLabel(p: AddPoint): string {
  if (p.side === 'inside') return `Add inside ${p.name}`;
  return `Add a section ${p.side === 'before' ? 'above' : 'below'} ${p.name}`;
}

/** Something a +'s list offers: a section of the theme, a basic element, or one of the project's own components. */
export interface QuickItem {
  key: string;
  kind: 'section' | 'element' | 'component';
  name: string;
  /** What search reads: the name, then its description, tags and kind. */
  hay: string;
  /** Its group, said beside it: "Sections", "Basic elements", "Your components". */
  group: string;
  spec: InsertSpec;
  /** A Lucide icon name. */
  icon?: string;
}

/**
 * What a + offers, in the order it lists them: between sections, the theme's sections and then the project's
 * components that go in as sections; inside a container, the basic elements and then the project's components made
 * from something inside a layout (a card), as Insert places each (insertRole). The shared header and footer are not
 * offered, nor code components outside Developer mode, as in the Insert panel.
 */
export function quickItems(state: ProjectState, role: InsertRole, dev = false): QuickItem[] {
  const mine: QuickItem[] = Object.values(state.components)
    .filter((d) => d.owner === 'project' && d.category !== 'shell' && (dev || d.kind !== 'code') && definitionRole(state, d.id) === role)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map((d) => ({ key: `c:${d.id}`, kind: 'component', name: d.name, hay: `${d.name} ${d.description ?? ''} ${d.kind === 'code' ? 'code ' : ''}component`.toLowerCase(), group: 'Your components', spec: { definitionId: d.id } }));
  if (role === 'element')
    return [...BASICS.map((b): QuickItem => ({ key: `e:${b.id}`, kind: 'element', name: b.name, hay: basicHay(b), group: 'Basic elements', spec: basicSpec(b), icon: b.icon })), ...mine];
  const sections = catalogueEntries(state.site.themeId).map(
    (e): QuickItem => ({
      key: `s:${e.componentId}`,
      kind: 'section',
      name: e.name,
      hay: `${e.name} ${e.description} ${e.tags.join(' ')} ${CATEGORY_LABELS[e.category] ?? e.category} section`.toLowerCase(),
      group: 'Sections',
      spec: { componentId: e.componentId },
      icon: e.icon
    })
  );
  return [...sections, ...mine];
}

/**
 * What a + offers at `at` (see quickItems), less what the place would refuse (see fitting). Between sections the
 * theme's own sections are not tried, since a page's top level takes any of them and trying each would check the whole
 * project some thirty times; the project's components are, since one can be made from something that cannot stand
 * there (a list item). Whatever is chosen is tried again as it is added.
 */
export function offeredAt(state: ProjectState, at: InsertAt, role: InsertRole, dev = false): QuickItem[] {
  const items = quickItems(state, role, dev);
  const tried = new Set(fitting(state, at, role, items.filter((it) => role === 'element' || it.kind === 'component')).map((it) => it.key));
  return items.filter((it) => (role === 'section' && it.kind !== 'component') || tried.has(it.key));
}

/**
 * The items that can go at `at`, each tried once on a copy of the project against the problems it already has (see
 * dropRefusal): a Button is not offered inside a card that is itself a link, nor anything a slot does not take.
 */
export function fitting(state: ProjectState, at: InsertAt, role: InsertRole, items: QuickItem[]): QuickItem[] {
  let before: Diagnostic[] | null = null;
  return items.filter((it) => !dropRefusal(state, insertOps(at, it.spec, role), () => (before ??= savingProblems(state))));
}
