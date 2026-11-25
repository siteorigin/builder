/**
 * What stands in the way of removing a slot placements fill, or a component still in use (#663): each placement, named
 * where it is so the author can go to it, and for a slot, the one change that removes it with what placements hold in
 * it. The engine refuses either removal while anything is in the way; this says where, and plans the way through.
 */
import type { ComponentDefinition, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { childLists, findParent, instancesOf, subtreeIds } from '@engine/tree';
import { applyOperations } from '@engine/apply';
import { shownSlots } from '@engine/theme-updates';
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

/** A slot's name for the author: its label, or its code name when a hand edit left it without one. */
const slotName = (label: unknown, slot: string) => (typeof label === 'string' && label.trim() ? label : slot);

/** Code that places a component and fills one of its slots, which it reads by the slot's prop. */
const codeCaller = (state: ProjectState, defId: string, slot: string) => Object.values(state.components).find((d) => codeImports(state, d, defId) && !!d.source?.includes(slotIdent(slot)));

/**
 * Content a change to designs would stop showing while it stays in the project (`after` is the project with the change
 * made): a slot of a changed design, other than `removed`, that a placement which stays fills and the design showed it
 * before but not after, its last place having gone with the change; or such a slot that code placing the design fills.
 */
function hiddenElsewhere(state: ProjectState, after: ProjectState, designs: Iterable<string>, removed: { defId: string; slot: string; label: string }): string | undefined {
  for (const id of designs) {
    const was = own(state.components, id);
    const next = own(after.components, id);
    if (was?.kind !== 'managed' || !was.tree || next?.kind !== 'managed' || !next.tree) continue;
    const counted = (x: string) => !(id === removed.defId && x === removed.slot);
    const say = (x: string, where: string) => {
      const name = slotName(own(was.slots, x)?.label, x);
      return id === removed.defId
        ? `The “${removed.label}” slot shows ${was.name}’s “${name}” slot while it is empty, and “${name}” holds content ${where}. Removed, that content would no longer show. Move the “${name}” slot out of the “${removed.label}” slot in the design first.`
        : `Inside ${was.name}, the “${removed.label}” slot holds the place where ${was.name} shows its own “${name}” slot, which holds content ${where}. Removed, that content would no longer show. Go to that placement and move the “${name}” slot out first.`;
    };
    for (const u of instancesOf(after, id)) {
      const beforeTree = treeFor(state, u.owner);
      const before = beforeTree && own(beforeTree.nodes, u.node.id);
      if (before?.kind !== 'instance' || before.definitionId !== id) continue;
      // As the site shows it: past repeats empty for this placement, and fallbacks of the slots it fills.
      const shownBefore = shownSlots(was, before, beforeTree);
      const shownAfter = shownSlots(next, u.node, treeFor(after, u.owner));
      const x = Object.keys(u.node.slots ?? {}).find((k) => counted(k) && fillsSlot(u.node, k) && shownBefore.has(k) && !shownAfter.has(k));
      if (x) return say(x, `on ${u.label}`);
    }
    // Code placing the design is read for the slot's prop alone, so it counts any slot the design no longer shows at all.
    const blank = { kind: 'instance', id: '', definitionId: id, props: {} } as InstanceNode;
    const shownAfter = shownSlots(next, blank);
    for (const x of shownSlots(was, blank)) {
      const caller = counted(x) && !shownAfter.has(x) ? codeCaller(state, id, x) : undefined;
      if (caller) return say(x, `where the code of ${caller.name} places ${was.name}`);
    }
  }
  return undefined;
}

/**
 * Remove a slot together with what placements hold in it, as one change (so one Undo puts it all back): each piece of
 * content is removed where it is, then the slot with its placeholder and what that shows while the slot is empty. A
 * placement inside content that goes goes with it, so it is not removed twice. Content a hand edit damaged is left for
 * the author to look at. So is a removal that would stop a design showing another of its slots that a placement which
 * stays (or code placing it) fills: that content would no longer show anywhere. Null when there is no such slot.
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
  const caller = codeCaller(state, def.id, slot);
  if (caller) return { rows, items: 0, problem: `The code of ${caller.name} places ${def.name} and fills its “${label}” slot. Removed, what that code puts there would no longer show. Change that code first.` };
  const operations: EditOperation[] = [];
  for (const { owner, tree, held } of byOwner.values()) {
    // A piece inside another that goes (a placement held in the slot, holding more there itself) goes with it.
    const inside = new Set<string>();
    for (const id of held) for (const sub of subtreeIds(tree, id).slice(1)) inside.add(sub);
    const roots = held.filter((id) => !inside.has(id));
    if (!roots.length) return { rows, items: 0, problem: `What the “${label}” slot holds is damaged (it holds itself), so it can’t be removed from here. Undo the change that damaged it.` };
    for (const nodeId of roots) operations.push({ type: 'node.remove', owner, nodeId });
  }
  operations.push({ type: 'component.removeSlot', definitionId, slot });
  // Tried on a copy of the project, so what the engine would refuse is said before anything is sent, and so is
  // content of another slot the change would stop showing: in the designs it changes, the component's own and those
  // holding content that goes.
  let after: ProjectState;
  try {
    after = applyOperations(state, operations).state;
  } catch (e) {
    // Said as the engine says it, without the step of the batch it came from.
    return { rows, items: 0, problem: e instanceof Error ? e.message.replace(/^Operation \d+ \([\w.]+\): /, '') : `The “${label}” slot can’t be removed with its content.` };
  }
  const designs = new Set([def.id, ...[...byOwner.values()].flatMap((o) => (o.owner.kind === 'component' ? [o.owner.id] : []))]);
  const hidden = hiddenElsewhere(state, after, designs, { defId: def.id, slot, label });
  if (hidden) return { rows, items: 0, problem: hidden };
  return { rows, items: operations.length - 1, operations };
}
