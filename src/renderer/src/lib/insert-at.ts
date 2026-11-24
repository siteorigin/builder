/**
 * Where Insert puts something new, worked out on a project's state alone: a click on a tile, the Insert panel's line
 * saying where it goes, and a drop on the canvas all read it from here, so they agree on the place.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { newId } from '@shared/ids';
import { allTrees, childLists, findParent } from '@engine/tree';
import { ownerLabel, refLabel, treeFor } from './model';
import type { InsertSpec } from './insert-search';

/** Where an inserted node goes: into a parent's list (or one of an instance's slots), or the owner's top level. */
export type InsertAt = { owner: OwnerRef; parentId: string | null; slot?: string; index?: number };

/** How a new thing is placed: as one of a page's sections, or as an element inside a layout. */
export type InsertRole = 'section' | 'element';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The slot an element put inside a component goes in: the first one its design shows (a declared slot can be left out
 *  of the design, and what is put in it is then never seen), else the first declared. None when it has no slots. */
export function slotFor(state: ProjectState, definitionId: string): string | undefined {
  const def = own(state.components, definitionId);
  const names = Object.keys(def?.slots ?? {});
  const nodes = Object.values(def?.tree?.nodes ?? {});
  return names.find((name) => nodes.some((n) => n.kind === 'slot' && n.slot === name)) ?? names[0];
}

/** Whether a definition has a placement inside a layout or inside another component's design. (One among a page's
 *  sections says little: Insert used to put every component there.) */
function placedInside(state: ProjectState, definitionId: string): boolean {
  for (const t of allTrees(state))
    for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance' && n.definitionId === definitionId && (t.owner.kind === 'component' || !t.tree.rootIds.includes(n.id))) return true;
  return false;
}

/**
 * Whether a component inserts as one of a page's sections or as an element inside a layout. Create component records
 * it (a card made inside a grid is an element); copies carry it on. A definition from before that placed inside a
 * layout anywhere is an element. Otherwise it is read from what it is: a theme's component, or a design whose root is
 * one, is a section, and so is a root that is a section element; a design rooted in any other element (a card, a
 * paragraph) is an element. Code with nothing to go on stays a section.
 */
export function definitionRole(state: ProjectState, definitionId: string, seen = new Set<string>()): InsertRole {
  const def = own(state.components, definitionId);
  if (!def || seen.has(def.id)) return 'section';
  seen.add(def.id);
  if (def.insertAs === 'section' || def.insertAs === 'element') return def.insertAs;
  if (def.owner === 'theme') return 'section';
  if (placedInside(state, def.id)) return 'element';
  const from = def.provenance?.forkedFrom;
  if (from && own(state.components, from)) return definitionRole(state, from, seen);
  const root = def.kind === 'managed' && def.tree ? own(def.tree.nodes, def.tree.rootIds[0] ?? '') : undefined;
  if (!root) return 'section';
  if (root.kind === 'instance') return definitionRole(state, root.definitionId, seen);
  if (root.kind === 'element' && root.tag === 'section') return 'section';
  return 'element';
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
  if (ref?.instancePath.length !== 1) return undefined;
  const inst = own(treeFor(state, ref.owner)?.nodes, ref.instancePath[0]);
  const def = inst?.kind === 'instance' ? own(state.components, inst.definitionId) : undefined;
  const tree = def?.tree;
  if (!def || !tree || ref.nodeId === tree.rootIds[0]) return undefined;
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
  return Object.keys(def.slots ?? {}).find((name) => held.has(name));
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
      if (node.kind === 'element') return { owner, parentId: node.id };
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
      return { owner, parentId: info.parentId, slot: info.slot, index: info.index + 1 };
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
  if (node?.kind === 'element') return { owner: at.owner, parentId: node.id };
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

/** Where something placed as `role` at `at` goes, in words. */
export const whereFor = (st: ProjectState, at: InsertAt | null, role: InsertRole): Where => (role === 'element' ? elementWhere(st, at) : sectionWhere(st, at));
