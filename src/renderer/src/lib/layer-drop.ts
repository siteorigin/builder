/**
 * Where a layer dragged in Layers lands: the moves that put it (and the layers picked with it) in a list, and the
 * slots of a placed component that Layers lists as places to drop into or pick for Insert.
 */
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { slotChildren, slotFallback } from '@shared/types';
import { findParent } from '@engine/tree';
import { shownSlots } from './slot-target';

/** Where a drop puts the dragged layers: a list (a parent and slot), and the layer they go before (null: its end). */
export type Place = { parentId: string | null; slot?: string; before: string | null };

/**
 * The moves that put `ids` (siblings, in their list's order) together at `to`, as one change: each one taken out
 * and put back after the one before it, the first before `to.before`. The engine takes a layer out before it puts
 * it back, so each index is counted in the list as it stands without that layer. Null when nothing would move.
 */
export function placeOps(tree: NodeTree, owner: OwnerRef, ids: string[], to: Place): EditOperation[] | null {
  const from = findParent(tree, ids[0]);
  if (!from) return null;
  const target = to.parentId === null ? tree.rootIds : (() => {
    const n = tree.nodes[to.parentId!];
    return n?.kind === 'instance' ? slotChildren(n, to.slot!) : n?.kind === 'slot' ? slotFallback(n) : n && 'children' in n ? n.children : [];
  })();
  const same = from.list === target;
  const source = [...from.list];
  const list = same ? source : [...target];
  const ops: EditOperation[] = [];
  ids.forEach((id, i) => {
    source.splice(source.indexOf(id), 1);
    const at = i === 0 ? (to.before ? list.indexOf(to.before) : list.length) : list.indexOf(ids[i - 1]) + 1;
    list.splice(at, 0, id);
    ops.push({ type: 'node.move', owner, nodeId: id, parentId: to.parentId, ...(to.slot !== undefined ? { slot: to.slot } : {}), index: at });
  });
  if (same && list.join() === from.list.join()) return null;
  return ops;
}

/** A slot of a placement as Layers lists it: its name, its content, and whether the component's design shows it. */
export type LayerSlot = { slot: string; label: string; ids: string[]; shown: boolean };

/**
 * A placement's slots as Layers lists them, in the order its component declares them: every one it shows, empty or
 * not, and one its design no longer shows only while it still holds something, so that content can still be reached.
 */
export function layerSlots(state: ProjectState, n: InstanceNode): LayerSlot[] {
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  const shown = new Set(shownSlots(state, n.definitionId));
  return Object.entries(def?.slots ?? {})
    .map(([slot, info]) => ({ slot, label: info?.label || slot, ids: slotChildren(n, slot), shown: shown.has(slot) }))
    .filter((l) => l.shown || l.ids.length);
}
