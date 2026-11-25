/**
 * A slot of a placed component picked as the place Insert fills, in Layers (and on the canvas): the placement and the
 * slot's name, in the tree of the page, component or layout that holds the placement. A slot is not an element, so
 * nothing is selected while one is picked: the Inspector, Delete and the AI see no element, and a tile clicked in
 * Insert goes into that slot.
 */
import type { OwnerRef, ProjectState } from '@shared/types';
import { treeFor } from './model';

export type SlotTarget = { owner: OwnerRef; parentId: string; slot: string };

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The slots a placed component shows, in the order it declares them: those its design places (a declared slot left
 *  out is never seen), every declared one for code, which renders its own. */
export function shownSlots(state: ProjectState, definitionId: string): string[] {
  const def = own(state.components, definitionId);
  const names = Object.keys(def?.slots ?? {});
  if (def?.kind !== 'managed' || !def.tree) return names;
  const placed = new Set(Object.values(def.tree.nodes).flatMap((n) => (n.kind === 'slot' ? [n.slot] : [])));
  return names.filter((n) => placed.has(n));
}

/** Whether `t` still names a slot that its placement's component shows, in `state`. */
export function slotTargetHolds(state: ProjectState | null | undefined, t: SlotTarget): boolean {
  const n = state ? own(treeFor(state, t.owner)?.nodes, t.parentId) : undefined;
  return n?.kind === 'instance' && shownSlots(state!, n.definitionId).includes(t.slot);
}

export const sameSlotTarget = (a: SlotTarget | null | undefined, b: SlotTarget | null | undefined): boolean =>
  !!a && !!b && a.owner.kind === b.owner.kind && a.owner.id === b.owner.id && a.parentId === b.parentId && a.slot === b.slot;

/** The slot's name as its component declares it ("Sidebar"), or its key when it has none. */
export function slotLabel(state: ProjectState, t: SlotTarget): string {
  const n = own(treeFor(state, t.owner)?.nodes, t.parentId);
  const def = n?.kind === 'instance' ? own(state.components, n.definitionId) : undefined;
  return own(def?.slots, t.slot)?.label ?? t.slot;
}
