/**
 * Where Insert puts something new, worked out on a project's state alone: a click on a tile, the Insert panel's line
 * saying where it goes, and a drop on the canvas all read it from here, so they agree on the place.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementNode, ElementRef, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { newId } from '@shared/ids';
import { childLists, findParent } from '@engine/tree';
import { ownerLabel, refLabel, treeFor } from './model';
import type { InsertSpec } from './insert-search';
import { definitionRole, type InsertRole } from '@engine/insert-role';

/** How a new thing is placed (as one of a page's sections, or as an element inside a layout), and how a component is. */
export { definitionRole, type InsertRole };

/** Where an inserted node goes: into a parent's list (or one of an instance's slots), or the owner's top level. */
export type InsertAt = { owner: OwnerRef; parentId: string | null; slot?: string; index?: number };

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The slot an element put inside a component goes in: the first one its design shows (a declared slot can be left out
 *  of the design, and what is put in it is then never seen), else the first declared. None when it has no slots. */
export function slotFor(state: ProjectState, definitionId: string): string | undefined {
  const def = own(state.components, definitionId);
  const names = Object.keys(def?.slots ?? {});
  const nodes = Object.values(def?.tree?.nodes ?? {});
  return names.find((name) => nodes.some((n) => n.kind === 'slot' && n.slot === name)) ?? names[0];
}

/** How `spec` is placed: a basic element as an element, a theme section as a section, a project component as it was made. */
export function insertRole(state: ProjectState, spec: InsertSpec): InsertRole {
  if (spec.primitive) return 'element';
  if (spec.definitionId) return definitionRole(state, spec.definitionId);
  return 'section';
}

/**
 * What Insert reads a selection as. A part of a placed component, or anything inside its design, counts as the
 * placement, so what is inserted goes into its slot or beside it, as with the placement itself selected: a card
 * inserted with a Section's Container picked in Layers goes into that Section, not the page's last one.
 */
export const placementOf = (ref: ElementRef | null): ElementRef | null => (ref?.instancePath.length ? { owner: ref.owner, instancePath: [], nodeId: ref.instancePath[0] } : ref);

/**
 * The slot of a placement that a part picked inside it holds (a Section's Container holds its Content), so what is
 * inserted goes there rather than into the placement's first slot. Only a slot the part shows once, through its own
 * elements, counts: not one inside a repeat (shown once per item, or never) or handed to a component placed in it
 * (which may not show it). Of several, the first the component declares, as for the placement itself (slotFor). None
 * for the placement's own root, for a part that holds no slot, or for anything inside a component placed in its
 * design, whose slots the page does not fill.
 */
export function heldSlot(state: ProjectState, ref: ElementRef | null): string | undefined {
  return heldSlots(state, ref)[0];
}

/** Every slot of its placement that a part holds, as heldSlot counts them, in the order the component declares them. */
export function heldSlots(state: ProjectState, ref: ElementRef | null): string[] {
  if (ref?.instancePath.length !== 1) return [];
  const inst = own(treeFor(state, ref.owner)?.nodes, ref.instancePath[0]);
  const def = inst?.kind === 'instance' ? own(state.components, inst.definitionId) : undefined;
  const tree = def?.tree;
  if (!def || !tree || ref.nodeId === tree.rootIds[0]) return [];
  const held = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    const n = own(tree.nodes, id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'slot') held.add(n.slot);
    else if (n.kind === 'element') n.children.forEach(walk);
  };
  walk(ref.nodeId);
  return Object.keys(def.slots ?? {}).filter((name) => held.has(name));
}

/** How often what is put in a slot shows: not at all, once, or MANY (more than once, or a number no one can tell). */
const MANY = 2;

/**
 * The slots a component's design shows exactly once, so what is put in one shows once: through its own elements, or
 * handed to a component placed in it that shows it once itself; not inside a repeat (once per item, or never), nor from
 * two places. In the order it declares them. A code component renders its slots as its code likes, so none counts.
 */
export function shownOnceSlots(state: ProjectState, definitionId: string): string[] {
  const counts = slotCounts(state, definitionId, new Map(), new Set());
  return Object.keys(own(state.components, definitionId)?.slots ?? {}).filter((name) => counts.get(name) === 1);
}

/**
 * How often `definitionId`'s design shows each of its slots (0, 1 or MANY). Each definition is worked out once per
 * question (`done`), so a design that places another twice, which places another twice, costs no more than its parts;
 * one placed inside itself (`path`) shows its slots MANY times.
 */
function slotCounts(state: ProjectState, definitionId: string, done: Map<string, Map<string, number>>, path: ReadonlySet<string>): Map<string, number> {
  const known = done.get(definitionId);
  if (known) return known;
  const def = own(state.components, definitionId);
  const counts = new Map<string, number>();
  if (!def) return counts;
  if (def.kind !== 'managed' || !def.tree || path.has(def.id)) {
    for (const name of Object.keys(def.slots ?? {})) counts.set(name, MANY);
    return counts;
  }
  const tree = def.tree;
  const within = new Set(path).add(def.id);
  const seen = new Set<string>();
  const walk = (id: string, times: number) => {
    const n = own(tree.nodes, id);
    if (!n || !times || seen.has(id)) return;
    seen.add(id);
    // An outlet for a slot it no longer declares is given nothing (the generator passes declared slots only).
    if (n.kind === 'slot') {
      if (Object.hasOwn(def.slots ?? {}, n.slot)) counts.set(n.slot, Math.min(MANY, (counts.get(n.slot) ?? 0) + times));
    }
    else if (n.kind === 'element') n.children.forEach((c) => walk(c, times));
    else if (n.kind === 'repeat') n.children.forEach((c) => walk(c, MANY));
    else if (n.kind === 'instance') {
      // What the design hands a component placed in it shows as often as that component shows the slot it fills.
      const fills = Object.entries(n.slots ?? {}).filter(([, ids]) => Array.isArray(ids) && ids.length);
      if (!fills.length) return;
      const inner = slotCounts(state, n.definitionId, done, within);
      for (const [slot, ids] of fills) ids.forEach((c) => walk(c, Math.min(MANY, times * (inner.get(slot) ?? 0))));
    }
  };
  tree.rootIds.forEach((id) => walk(id, 1));
  done.set(def.id, counts);
  return counts;
}

/**
 * Inside a figure whose caption ends it, new content goes before the caption, which must stay its first or last child.
 * Anywhere else, at the end (no index).
 */
function beforeCaption(tree: NodeTree, node: ElementNode): { index?: number } {
  const index = captionSafe(tree, node.id, node.children.length);
  return index === node.children.length ? {} : { index };
}

/** A place among `parentId`'s children, moved before a figure's trailing caption when it would follow it. */
function captionSafe(tree: NodeTree, parentId: string | null | undefined, index: number): number {
  const parent = parentId ? own(tree.nodes, parentId) : undefined;
  if (parent?.kind !== 'element' || parent.tag !== 'figure' || !parent.children.length) return index;
  const end = parent.children.length;
  const last = own(tree.nodes, parent.children[end - 1]);
  return last?.kind === 'text' && last.tag === 'figcaption' && index >= end ? end - 1 : index;
}

/**
 * Where something placed as `role` goes in `owner`, relative to `sel` (a node of the owner's own tree, see
 * structuralTarget). An element goes inside a selected container or a placed component's slot, else just after the
 * selection, in its own list; with nothing selected on a page it goes into the last section that holds content. A
 * section goes after the top-level section that holds the selection. `definitionId`: the component being inserted,
 * whose own selected placement asks for another beside it (a second card), never one inside it. `held`: the slot of
 * the selected placement that the selection picked (see heldSlot), in place of its first.
 */
export function placeFor(state: ProjectState, owner: OwnerRef, role: InsertRole, sel: ElementRef | null, definitionId?: string, held?: string): InsertAt | null {
  const tree = treeFor(state, owner);
  if (!tree) return null;
  if (sel && sel.owner.kind === owner.kind && sel.owner.id === owner.id) {
    const node = own(tree.nodes, sel.nodeId);
    const same = node?.kind === 'instance' && !!definitionId && node.definitionId === definitionId;
    if (role === 'element' && node && !same) {
      if (node.kind === 'element') return { owner, parentId: node.id, ...beforeCaption(tree, node) };
      const slot = node.kind === 'instance' ? (held ?? slotFor(state, node.definitionId)) : undefined;
      if (slot) return { owner, parentId: node.id, slot };
    }
    const info = findParent(tree, sel.nodeId);
    if (info) {
      if (role === 'section' && info.parentId) {
        // After the top-level section holding the selection.
        let top = sel.nodeId;
        const seen = new Set<string>();
        for (let p = findParent(tree, top); p?.parentId && !seen.has(p.parentId); p = findParent(tree, top)) {
          seen.add(p.parentId);
          top = p.parentId;
        }
        return { owner, parentId: null, index: tree.rootIds.indexOf(top) + 1 };
      }
      // Just after the selection; after a figure's caption, before it instead.
      return { owner, parentId: info.parentId, slot: info.slot, index: captionSafe(tree, info.parentId, info.index + 1) };
    }
  }
  if (role === 'element' && owner.kind === 'page') {
    // Loose elements go inside the last section that holds content, when there is one.
    const last = [...tree.rootIds].reverse().map((id) => own(tree.nodes, id)).find((n) => n?.kind === 'instance' && slotFor(state, n.definitionId));
    if (last?.kind === 'instance') return { owner, parentId: last.id, slot: slotFor(state, last.definitionId) };
  }
  return { owner, parentId: null };
}

/**
 * A component has one top-level element, the component itself: what would go beside it goes at the end of it, and
 * nothing can be inserted into one that holds nothing (a paragraph). A design from an older version without its one
 * root keeps the top level, where an element can be inserted to hold the others.
 */
export function insideComponent(state: ProjectState, at: InsertAt | null): InsertAt | null {
  if (!at || at.owner.kind !== 'component' || at.parentId) return at;
  const tree = treeFor(state, at.owner);
  if (tree?.rootIds.length !== 1) return at;
  const node = own(tree.nodes, tree.rootIds[0]);
  if (node?.kind === 'element') return { owner: at.owner, parentId: node.id, ...beforeCaption(tree, node) };
  const slot = node?.kind === 'instance' ? slotFor(state, node.definitionId) : undefined;
  if (slot) return { owner: at.owner, parentId: node!.id, slot };
  return node?.kind === 'repeat' || node?.kind === 'slot' ? at : null;
}

/**
 * Where something placed as `role` goes in `owner`, for the selection as the editor holds it: a part of a placed
 * component counts as the placement (placementOf), and one that holds a slot of it picks that slot (heldSlot).
 */
export const insertAt = (state: ProjectState, owner: OwnerRef, role: InsertRole, from: ElementRef | null, definitionId?: string): InsertAt | null =>
  insideComponent(state, placeFor(state, owner, role, placementOf(from), definitionId, heldSlot(state, from)));

/**
 * The operations that insert `spec` at `at`, as one change: an element placed on a page's top level goes into a new
 * Section made for it. What `spec` names is the last one inserted; `nodeId` names it, for operations in the same batch
 * that fill it.
 */
export function insertOps(at: InsertAt, spec: InsertSpec, role: InsertRole, nodeId?: string): EditOperation[] {
  const { columns, ...rest } = spec;
  const starter = rest.primitive === 'grid' && columns !== undefined ? starterColumns(columns) : 0;
  // A Grid that starts with its columns is named here, so the same change can fill it.
  const id = nodeId ?? (starter ? newId('n') : undefined);
  const named = id ? { newNodeId: id } : {};
  const what = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as InsertSpec;
  const fill = starter ? columnOps(at.owner, id!, starter) : [];
  if (role === 'element' && at.owner.kind === 'page' && !at.parentId) {
    const sectionId = newId('n');
    return [
      { type: 'node.insert', newNodeId: sectionId, owner: at.owner, parentId: null, index: at.index, componentId: 'layout.section' },
      { type: 'node.insert', ...named, owner: at.owner, parentId: sectionId, slot: 'content', ...what },
      ...fill
    ];
  }
  return [{ type: 'node.insert', ...named, owner: at.owner, parentId: at.parentId, slot: at.slot, index: at.index, ...what }, ...fill];
}

/**
 * What an insert selects once it has landed: the node it inserted (named `nodeId` in `ops`), or a column layout's
 * first column, so the next element inserted fills that column rather than adding a cell beside the columns.
 */
export function insertSelection(ops: EditOperation[], nodeId: string): string {
  const first = ops.find((op) => op.type === 'node.insert' && op.parentId === nodeId);
  return (first?.type === 'node.insert' && first.newNodeId) || nodeId;
}

/** How many empty columns a column layout starts with: two to four, or none for a count that is not one. */
function starterColumns(n: number): number {
  return Number.isInteger(n) && n >= 2 && n <= 4 ? n : 0;
}

/**
 * The rest of a column layout, once its Grid is in: that many columns side by side on desktop (one above the other
 * on smaller screens, as any Grid starts), each an empty Stack named for its place, so Layers and Insert's line say
 * which column is which and a click on the column's frame on the canvas selects it for Insert to fill.
 */
function columnOps(owner: OwnerRef, gridId: string, n: number): EditOperation[] {
  const ops: EditOperation[] = [
    { type: 'node.rename', owner, nodeId: gridId, name: 'Columns' },
    { type: 'node.setStyle', owner, nodeId: gridId, scope: 'desktop', property: 'columns', value: n }
  ];
  for (let i = 1; i <= n; i++) {
    const column = newId('n');
    ops.push({ type: 'node.insert', newNodeId: column, owner, parentId: gridId, primitive: 'stack' }, { type: 'node.rename', owner, nodeId: column, name: `Column ${i}` });
  }
  return ops;
}

/** Where an insert lands, in words: "after" + "Split hero". `node`: the target is an element, not the page itself.
 *  `within`: the container it goes into beside `target`, named so the place is plain ("after Card" in "Grid"). */
export type Where = { lead: string; target: string; node?: boolean; within?: string } | null;

/** The node just before an insertion index, in the list that index counts in. */
export function nodeBefore(st: ProjectState, owner: OwnerRef, parentId: string | null, slot: string | undefined, index: number | undefined): string | null {
  if (!index) return null;
  const tree = treeFor(st, owner);
  if (!tree) return null;
  if (!parentId) return tree.rootIds[index - 1] ?? null;
  const parent = own(tree.nodes, parentId);
  if (!parent) return null;
  const lists = childLists(parent);
  return ((slot ? lists.find((l) => l.slot === slot) : lists[0])?.ids ?? [])[index - 1] ?? null;
}

export const nodeLabel = (st: ProjectState, owner: OwnerRef, nodeId: string) => refLabel(st, { owner, instancePath: [], nodeId });

/** Where an element inserted at `at` goes. On a page with nowhere to put it, insertOps wraps it in a new section. */
export function elementWhere(st: ProjectState, at: InsertAt | null): Where {
  if (!at) return null;
  const before = nodeBefore(st, at.owner, at.parentId, at.slot, at.index);
  if (at.owner.kind === 'page' && !at.parentId)
    return before ? { lead: 'in a new section after', target: nodeLabel(st, at.owner, before), node: true } : { lead: at.index === 0 ? 'in a new section at the top of' : 'in a new section at the end of', target: ownerLabel(st, at.owner) };
  if (before) return { lead: 'after', target: nodeLabel(st, at.owner, before), node: true, ...(at.parentId ? { within: nodeLabel(st, at.owner, at.parentId) } : {}) };
  if (at.parentId) return { lead: 'inside', target: nodeLabel(st, at.owner, at.parentId), node: true };
  return { lead: 'at the end of', target: ownerLabel(st, at.owner) };
}

/** Where a section inserted at `at` goes: after the section before it, else at the top or end of the page. */
export function sectionWhere(st: ProjectState, at: InsertAt | null): Where {
  if (!at) return null;
  const before = nodeBefore(st, at.owner, at.parentId, at.slot, at.index);
  if (before) return { lead: 'after', target: nodeLabel(st, at.owner, before), ...(at.parentId ? { within: nodeLabel(st, at.owner, at.parentId) } : {}) };
  if (at.parentId) return { lead: 'inside', target: nodeLabel(st, at.owner, at.parentId) };
  return { lead: at.index === 0 ? 'at the top of' : 'at the end of', target: ownerLabel(st, at.owner) };
}

/** A place in words, after what goes there: "after Card in Grid", "in a new section at the top of Home". */
export const whereText = (w: NonNullable<Where>): string => `${w.lead} ${w.within ? `${w.target} in ${w.within}` : w.target}`;

/** Where something placed as `role` at `at` goes, in words. */
export const whereFor = (st: ProjectState, at: InsertAt | null, role: InsertRole): Where => (role === 'element' ? elementWhere(st, at) : sectionWhere(st, at));
