/**
 * Several layers selected together in Layers: sibling layers of one list (the same parent and slot), picked with
 * Shift (a range) or Cmd/Ctrl (one more). The editor's `selection` stays the one layer everything else follows
 * (the inspector, the canvas, the breadcrumb); the set only adds its siblings to it, for moving, copying,
 * duplicating and deleting them together as one change. Pure functions over the project state, so what a group
 * action does can be tested without rendering Layers.
 */
import type { EditOperation } from '@shared/ops';
import type { ElementRef, NodeTree, OwnerRef } from '@shared/types';
import { sameRef } from '@shared/types';
import { findParent } from '@engine/tree';

/** The layers selected together: always in one list of `owner`'s tree, in the order they were picked. */
export interface LayerSet {
  owner: OwnerRef;
  ids: string[];
  /** Where a Shift range starts: the layer picked before the Shift click or key. */
  anchor: string;
}

/** Selected layers that share one list, in that list's order. */
export interface Group {
  owner: OwnerRef;
  parentId: string | null;
  slot?: string;
  /** The list they share, as the project has it now. */
  list: string[];
  /** The selected layers, in the list's order. */
  ids: string[];
  /** Where each one sits in the list, in the same order. */
  indexes: number[];
}

const sameOwner = (a: OwnerRef, b: OwnerRef) => a.kind === b.kind && a.id === b.id;

/** The layers as one group, when every one of them is in the tree and they all share one list; null otherwise. */
export function groupOf(tree: NodeTree, owner: OwnerRef, ids: string[]): Group | null {
  if (!ids.length) return null;
  const first = findParent(tree, ids[0]);
  if (!first) return null;
  const indexes: number[] = [];
  for (const id of new Set(ids)) {
    const i = first.list.indexOf(id);
    if (i < 0) return null;
    indexes.push(i);
  }
  indexes.sort((a, b) => a - b);
  return { owner, parentId: first.parentId, ...(first.slot !== undefined ? { slot: first.slot } : {}), list: first.list, ids: indexes.map((i) => first.list[i]), indexes };
}

/**
 * The set as it stands in the project now, or null when it no longer applies: the selection has moved off it, or
 * has gone. Layers it had that are gone, or are no longer beside the selection (an Undo or the AI moved them), are
 * left out; a set left with one layer is no set.
 */
export function liveSet(tree: NodeTree | undefined, selection: ElementRef | null, set: LayerSet | null): Group | null {
  if (!tree || !set || !selection || selection.instancePath.length || selection.slot !== undefined || !sameOwner(selection.owner, set.owner)) return null;
  if (!set.ids.includes(selection.nodeId)) return null;
  const here = findParent(tree, selection.nodeId);
  if (!here) return null;
  const ids = set.ids.filter((id) => here.list.includes(id));
  if (ids.length < 2) return null;
  return groupOf(tree, set.owner, ids);
}

/** The layers from `anchor` to `target`, both included, in list order; null when they are not siblings. */
export function rangeOf(tree: NodeTree, anchor: string, target: string): string[] | null {
  const a = findParent(tree, anchor);
  const b = findParent(tree, target);
  if (!a || !b || a.list !== b.list) return null;
  const [lo, hi] = a.index <= b.index ? [a.index, b.index] : [b.index, a.index];
  return a.list.slice(lo, hi + 1);
}

/** Whether a layer can join the set: a sibling of its layers, in the same tree. */
export function joins(tree: NodeTree, set: { owner: OwnerRef; ids: string[] }, ref: ElementRef): boolean {
  if (ref.instancePath.length || !sameOwner(ref.owner, set.owner) || !set.ids.length) return false;
  const a = findParent(tree, set.ids[0]);
  const b = findParent(tree, ref.nodeId);
  return !!a && !!b && a.list === b.list;
}

/** Whether `ref` is one of the group's layers, as the project has them now (liveSet), not as they were picked. */
export function inGroup(g: Group | null, ref: ElementRef): boolean {
  return !!g && !ref.instancePath.length && sameOwner(g.owner, ref.owner) && g.ids.includes(ref.nodeId);
}

/** A row's reference, for comparing with the selection. */
export const layerRef = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });

/** Whether the selection is the layer `nodeId` of `owner` (a row in Layers). */
export const isSelected = (selection: ElementRef | null, owner: OwnerRef, nodeId: string) => sameRef(selection, layerRef(owner, nodeId));

// ---------------------------------------------------------------------------
// Each action on a group, as the operations of one change. Every operation in a batch sees the project as the
// ones before it left it, so the indexes below are counted that way.
// ---------------------------------------------------------------------------

/**
 * Move each selected layer one place up (or down), past the layer beside it, keeping their order: a run of
 * selected layers moves as a block. Null when the first (or last) is already at the end of its list.
 */
export function moveStepOps(g: Group, dir: -1 | 1): EditOperation[] | null {
  if (dir < 0 ? g.indexes[0] === 0 : g.indexes[g.indexes.length - 1] === g.list.length - 1) return null;
  // Upwards from the top, each one moves above the layer that was above it; downwards, from the bottom. The
  // moves before it only trade places above it (or below it), so each still starts where it was.
  const order = g.ids.map((id, i) => ({ id, at: g.indexes[i] }));
  if (dir > 0) order.reverse();
  return order.map(({ id, at }) => ({ type: 'node.move', owner: g.owner, nodeId: id, parentId: g.parentId, ...(g.slot !== undefined ? { slot: g.slot } : {}), index: at + dir }));
}

/** Move the group into another list (a container, a slot, or the top level), at `index`, in their order. */
export function moveIntoOps(g: Group, to: { parentId: string | null; slot?: string; index: number }): EditOperation[] {
  return g.ids.map((id, i) => ({ type: 'node.move', owner: g.owner, nodeId: id, parentId: to.parentId, ...(to.slot !== undefined ? { slot: to.slot } : {}), index: to.index + i }));
}

/** Delete every selected layer. */
export function removeOps(g: Group): EditOperation[] {
  return g.ids.map((id) => ({ type: 'node.remove', owner: g.owner, nodeId: id }));
}

/** Duplicate the group: the copies go together after its last layer, in its order, and leave every original where it is. */
export function duplicateOps(g: Group): EditOperation[] {
  const after = g.indexes[g.indexes.length - 1] + 1;
  return g.ids.map((id, i) => ({ type: 'node.duplicate', owner: g.owner, nodeId: id, index: after + i }));
}

/**
 * Move sections of a page to another page, at `index` of its sections (its end by default), in their order: each
 * is copied there (new IDs; a section ID the page already uses is left off the copy), then taken off this page.
 */
export function moveToPageOps(g: Group, pageId: string, index: number): EditOperation[] {
  const to: OwnerRef = { kind: 'page', id: pageId };
  return [
    ...g.ids.map((id, i): EditOperation => ({ type: 'node.copy', owner: g.owner, nodeId: id, toOwner: to, parentId: null, index: index + i })),
    ...g.ids.map((id): EditOperation => ({ type: 'node.remove', owner: g.owner, nodeId: id }))
  ];
}

// ---------------------------------------------------------------------------
// Picking several layers: what a Shift or Cmd/Ctrl pick in Layers selects, or why it selects nothing more.
// ---------------------------------------------------------------------------

/** What a pick selects: the one layer everything follows, and the layers selected with it; or why it was refused. */
export type PickResult = { selection: ElementRef | null; layerSet: LayerSet | null } | { refused: string };

/** Why a layer can't be picked together with others, or null when it can. */
export function cannotGroup(tree: NodeTree, ref: ElementRef): string | null {
  if (ref.owner.kind === 'shell') return 'The shared header and footer can’t be moved, copied or deleted here, so their layers are selected one at a time.';
  if (ref.instancePath.length) return 'Parts of a component are selected one at a time.';
  if (ref.owner.kind === 'component' && tree.rootIds[0] === ref.nodeId) return 'This is the component itself. Pick layers inside it to select several.';
  return null;
}

export const NOT_SIBLINGS = 'Only layers side by side in the same place can be selected together. Pick layers that share a parent.';

/** The layers selected now, in a tree: the set while it applies, the selection alone when it is a layer of this tree. */
function current(tree: NodeTree, selection: ElementRef | null, set: LayerSet | null, owner: OwnerRef): { ids: string[]; anchor: string } | null {
  const live = liveSet(tree, selection, set);
  if (live && set) return { ids: live.ids, anchor: live.ids.includes(set.anchor) ? set.anchor : selection!.nodeId };
  // A slot picked by its empty box is not its placement's layer: it is never taken into a range.
  if (selection && !selection.instancePath.length && selection.slot === undefined && sameOwner(selection.owner, owner) && Object.hasOwn(tree.nodes, selection.nodeId)) return { ids: [selection.nodeId], anchor: selection.nodeId };
  return null;
}

const setOf = (owner: OwnerRef, ids: string[], anchor: string): LayerSet | null => (ids.length > 1 ? { owner, ids, anchor } : null);

/**
 * A pick that can't add `ref` to what is selected: refused, saying why, while a layer is selected (so the pick never
 * silently replaces it); with nothing selected, or only a part, `ref` alone.
 */
const cannot = (selection: ElementRef | null, ref: ElementRef, why: string): PickResult => (selection && !selection.instancePath.length && selection.slot === undefined ? { refused: why } : { selection: ref, layerSet: null });

/**
 * Shift: select every layer from the anchor (the layer picked before) to `ref`, which becomes the selection. With
 * nothing picked before, `ref` alone.
 */
export function extendTo(tree: NodeTree, selection: ElementRef | null, set: LayerSet | null, ref: ElementRef): PickResult {
  const now = current(tree, selection, set, ref.owner);
  if (now?.anchor === ref.nodeId) return { selection: ref, layerSet: null };
  const why = cannotGroup(tree, ref) ?? (now ? cannotGroup(tree, layerRef(ref.owner, now.anchor)) : NOT_SIBLINGS);
  if (why) return cannot(selection, ref, why);
  const ids = rangeOf(tree, now!.anchor, ref.nodeId);
  if (!ids) return cannot(selection, ref, NOT_SIBLINGS);
  return { selection: ref, layerSet: setOf(ref.owner, ids, now!.anchor) };
}

/**
 * Cmd/Ctrl: `ref` joins the layers selected, becoming the selection and the anchor of the next Shift pick; or, when
 * it is one of them, leaves them. The selection leaving passes to the nearest one left, the one above it first.
 */
export function toggle(tree: NodeTree, selection: ElementRef | null, set: LayerSet | null, ref: ElementRef): PickResult {
  const now = current(tree, selection, set, ref.owner);
  if (now?.ids.includes(ref.nodeId)) {
    const ids = now.ids.filter((id) => id !== ref.nodeId);
    if (!ids.length) return { selection: null, layerSet: null };
    let primary = selection?.nodeId ?? ref.nodeId;
    if (primary === ref.nodeId) {
      const list = findParent(tree, ref.nodeId)!.list;
      const at = list.indexOf(ref.nodeId);
      primary = ids.reduce((best, id) => {
        const d = Math.abs(list.indexOf(id) - at);
        const bd = Math.abs(list.indexOf(best) - at);
        return d < bd || (d === bd && list.indexOf(id) < list.indexOf(best)) ? id : best;
      });
    }
    return { selection: layerRef(ref.owner, primary), layerSet: setOf(ref.owner, ids, ids.includes(now.anchor) ? now.anchor : primary) };
  }
  const why = cannotGroup(tree, ref) ?? (now ? cannotGroup(tree, layerRef(ref.owner, now.ids[0])) : NOT_SIBLINGS);
  if (why) return cannot(selection, ref, why);
  if (!joins(tree, { owner: ref.owner, ids: now!.ids }, ref)) return cannot(selection, ref, NOT_SIBLINGS);
  const ids = groupOf(tree, ref.owner, [...now!.ids, ref.nodeId])!.ids;
  return { selection: ref, layerSet: setOf(ref.owner, ids, ref.nodeId) };
}

/** The layer beside `nodeId` in its list (`dir` -1 above, 1 below), for Shift+↑/↓; null at either end. */
export function besideOf(tree: NodeTree, nodeId: string, dir: -1 | 1): string | null {
  const p = findParent(tree, nodeId);
  return p ? (p.list[p.index + dir] ?? null) : null;
}
