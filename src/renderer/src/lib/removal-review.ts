/**
 * What stands in the way of removing a slot placements fill, or a component still in use (#663): each placement, named
 * where it is so the author can go to it, and for a slot, the one change that removes it with what placements hold in
 * it. The engine refuses either removal while anything is in the way; this says where, and plans the way through.
 */
import type { ComponentDefinition, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { childLists, findParent, instancesOf, subtreeIds } from '@engine/tree';
import { codeImports, dependentsOf } from '@engine/definitions';
import { slotIdent } from '@generator/index';
import { nodeLabel } from './insert-at';
import { treeFor } from './model';
import { fillsSlot } from './slot-contract';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** One placement of a component, as a review lists it. */
export interface PlacementRow {
  owner: OwnerRef;
  nodeId: string;
  /** Where it is, as the library's menu names it: a page's title (with its address when another page shares the title), "Shared header", a collection's layout, "Inside Pricing table". */
  place: string;
  /** Told apart from others in the same place, in the order they appear there: "in Team · 2 of 3". */
  where?: string;
}

/** A tree's nodes in the order they appear on the page. */
export function documentOrder(tree: NodeTree): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    const n = tree.nodes[id];
    if (n) for (const l of childLists(n)) l.ids.forEach(walk);
  };
  tree.rootIds.forEach(walk);
  return out;
}

/** Where a placement sits, for telling several on one page apart: "in Team", "after Intro", "at the top". */
export function whereIn(st: ProjectState, owner: OwnerRef, tree: NodeTree, nodeId: string): string {
  const at = findParent(tree, nodeId);
  if (!at) return 'on the page';
  if (at.parentId) return `in ${nodeLabel(st, owner, at.parentId)}`;
  return at.index ? `after ${nodeLabel(st, owner, at.list[at.index - 1])}` : 'at the top';
}

/**
 * Each placement of a component that `holds` content (every one, by default), in site order: the shared header and
 * footer, then pages in the site's order, collection layouts, and other components' designs. Several in one place
 * follow the order they appear there, each named by where it sits.
 */
export function placementRows(state: ProjectState, definitionId: string, holds: (node: InstanceNode) => boolean = () => true): PlacementRow[] {
  const groups: Array<{ owner: OwnerRef; label: string; nodeIds: string[] }> = [];
  for (const u of instancesOf(state, definitionId)) {
    if (!holds(u.node)) continue;
    const last = groups.at(-1);
    if (last && last.owner.kind === u.owner.kind && last.owner.id === u.owner.id) last.nodeIds.push(u.node.id);
    else groups.push({ owner: u.owner, label: u.label, nodeIds: [u.node.id] });
  }
  // Pages that share a title are told apart by their address.
  const titles = groups.filter((g) => g.owner.kind === 'page').map((g) => g.label);
  const placeName = (g: (typeof groups)[number]) => {
    if (g.owner.kind === 'shell') return `Shared ${g.label.toLowerCase()}`;
    if (g.owner.kind === 'component') return `Inside ${g.label}`;
    if (g.owner.kind === 'page' && titles.indexOf(g.label) !== titles.lastIndexOf(g.label)) return `${g.label} (${state.pages[g.owner.id]?.route ?? ''})`;
    return g.label;
  };
  return groups.flatMap((g): PlacementRow[] => {
    const place = placeName(g);
    if (g.nodeIds.length === 1) return [{ owner: g.owner, nodeId: g.nodeIds[0], place }];
    const tree = treeFor(state, g.owner);
    const order = tree ? documentOrder(tree) : [];
    const ids = [...g.nodeIds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return ids.map((nodeId, i) => ({ owner: g.owner, nodeId, place, where: `${tree ? `${whereIn(state, g.owner, tree, nodeId)} · ` : ''}${i + 1} of ${ids.length}` }));
  });
}

/** What keeps a component from being deleted: each placement, and the code components whose source needs it. */
export function componentRemovalReview(state: ProjectState, definitionId: string): { rows: PlacementRow[]; dependents: ComponentDefinition[] } {
  return { rows: placementRows(state, definitionId), dependents: dependentsOf(state, definitionId) };
}

export interface SlotRemovalPlan {
  /** The placements holding content in the slot. */
  rows: PlacementRow[];
  /** The content that goes, counted once: what each placement holds directly in the slot, less anything inside another piece that goes. */
  items: number;
  /** The one change: what each placement holds in the slot, then the slot. Absent when it can't be made from here. */
  operations?: EditOperation[];
  /** Why the content can't go with the slot from here, naming where; the author goes there and moves it first. */
  problem?: string;
}

/**
 * The slot placeholders a design shows: those reached from its root other than through what another placeholder
 * shows while its slot is empty (a placement filling that slot never shows them).
 */
function shownOutlets(tree: NodeTree): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    const n = own(tree.nodes, id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'slot') return void out.add(id);
    for (const l of childLists(n)) l.ids.forEach(walk);
  };
  tree.rootIds.forEach(walk);
  return out;
}

/** A slot's name for the author: its label, or its code name when a hand edit left it without one. */
const slotName = (label: unknown, slot: string) => (typeof label === 'string' && label.trim() ? label : slot);

/**
 * Remove a slot together with what placements hold in it, as one change (so one Undo puts it all back): each piece of
 * content is removed where it is, then the slot with its placeholder and what that shows while the slot is empty. A
 * placement inside content that goes goes with it, so it is not removed twice. Content a hand edit damaged is left for
 * the author to look at. So is anything that would take away the last place a design shows one of its own slots while
 * a placement that stays fills it: that content would no longer show anywhere. Null when there is no such slot.
 */
export function planSlotRemoval(state: ProjectState, definitionId: string, slot: string): SlotRemovalPlan | null {
  const def = own(state.components, definitionId);
  const decl = def && own(def.slots, slot);
  if (!def || !decl) return null;
  const label = slotName(decl.label, slot);
  const rows = placementRows(state, definitionId, (n) => fillsSlot(n, slot));
  const damaged = (at: string) => ({ rows, items: 0, problem: `What the “${label}” slot holds on ${at} is damaged, so it can’t be removed from here. Go to that placement and remove what it holds, or undo the change that damaged it.` });
  // The content each place holds in the slot, by place. A piece listed twice (in one slot or two) is a hand edit's.
  const byOwner = new Map<string, { owner: OwnerRef; tree: NodeTree; held: string[] }>();
  for (const r of rows) {
    const tree = treeFor(state, r.owner);
    const node = tree && own(tree.nodes, r.nodeId);
    const held = node?.kind === 'instance' ? own(node.slots, slot) : undefined;
    const at = `${r.place}${r.where ? ` (${r.where})` : ''}`;
    const key = `${r.owner.kind}:${r.owner.id}`;
    const entry = byOwner.get(key) ?? (tree ? { owner: r.owner, tree, held: [] } : undefined);
    if (!entry || !Array.isArray(held) || new Set(held).size !== held.length || held.some((id) => typeof id !== 'string' || !own(entry.tree.nodes, id) || entry.held.includes(id))) return damaged(at);
    entry.held.push(...held);
    byOwner.set(key, entry);
  }
  // Code that places the component and fills the slot reads it by its prop: removed, what it puts there would not show.
  const caller = Object.values(state.components).find((d) => codeImports(state, d, def.id) && !!d.source?.includes(slotIdent(slot)));
  if (caller) return { rows, items: 0, problem: `The code of ${caller.name} places ${def.name} and fills its “${label}” slot. Removed, what that code puts there would no longer show. Change that code first.` };
  // What goes, by place: each piece with everything inside it.
  const gone = new Map<string, Set<string>>();
  const operations: EditOperation[] = [];
  for (const [key, { owner, tree, held }] of byOwner) {
    // A piece inside another that goes (a placement held in the slot, holding more there itself) goes with it.
    const inside = new Set<string>();
    for (const id of held) for (const sub of subtreeIds(tree, id).slice(1)) inside.add(sub);
    const roots = held.filter((id) => !inside.has(id));
    if (!roots.length) return { rows, items: 0, problem: `What the “${label}” slot holds is damaged (it holds itself), so it can’t be removed from here. Undo the change that damaged it.` };
    gone.set(key, new Set(roots.flatMap((id) => subtreeIds(tree, id))));
    for (const nodeId of roots) operations.push({ type: 'node.remove', owner, nodeId });
  }
  // The slot's own placeholders go from the design too, with what they show while it is empty.
  const ownKey = `component:${def.id}`;
  if (def.tree) {
    const set = gone.get(ownKey) ?? new Set<string>();
    for (const n of Object.values(def.tree.nodes)) if (n.kind === 'slot' && n.slot === slot) for (const id of subtreeIds(def.tree, n.id)) set.add(id);
    gone.set(ownKey, set);
  }
  // A design whose last placeholder for one of its own slots goes, while a placement that stays fills that slot.
  const stays = (owner: OwnerRef, nodeId: string) => !gone.get(`${owner.kind}:${owner.id}`)?.has(nodeId);
  for (const [key, set] of gone) {
    const design = key.startsWith('component:') ? own(state.components, key.slice('component:'.length)) : undefined;
    const tree = design?.tree;
    if (!design || !tree) continue;
    const shown = shownOutlets(tree);
    for (const id of set) {
      const n = own(tree.nodes, id);
      if (n?.kind !== 'slot' || (key === ownKey && n.slot === slot)) continue;
      // Another placeholder the design shows keeps that content showing; one only inside what another shows while empty
      // does not, for a placement filling that other slot.
      if (Object.values(tree.nodes).some((m) => m.kind === 'slot' && m.slot === n.slot && !set.has(m.id) && shown.has(m.id))) continue;
      const filled = instancesOf(state, design.id).find((u) => fillsSlot(u.node, n.slot) && stays(u.owner, u.node.id));
      if (!filled) continue;
      const name = slotName(own(design.slots, n.slot)?.label, n.slot);
      return {
        rows,
        items: 0,
        problem:
          key === ownKey
            ? `The “${label}” slot shows ${design.name}’s “${name}” slot while it is empty, and “${name}” holds content on ${filled.label}. Removed, that content would no longer show. Move the “${name}” slot out of the “${label}” slot in the design first.`
            : `Inside ${design.name}, the “${label}” slot holds the place where ${design.name} shows its own “${name}” slot, which holds content on ${filled.label}. Removed, that content would no longer show. Go to that placement and move the “${name}” slot out first.`
      };
    }
  }
  operations.push({ type: 'component.removeSlot', definitionId, slot });
  return { rows, items: operations.length - 1, operations };
}
