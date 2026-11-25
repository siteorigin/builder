import type { NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { variantOptions } from '@shared/variants';
import { childLists, instancesOf, subtreeIds } from '@engine/tree';

/** What a node deleted from the editor takes with it that the author is asked about first (#662). */
export interface HeldContent {
  /** What it holds directly, in order: a container's children, or what its slots hold, slot by slot. */
  items: string[];
  /** The component placements anywhere inside it, each with its own content and overrides. */
  placements: number;
}

/**
 * What deleting `nodeId` of `tree` would take with it that is worth a question (#662), or null to delete it at once:
 * a leaf, an empty container, a placement whose slots hold nothing, or a container holding only plain elements. A
 * placement holding anything in its slots is asked about, and so is a container with a placement anywhere inside it.
 * What a placed component's own design shows is not counted: it stays with the component, in the library.
 */
export function heldContent(tree: NodeTree, nodeId: string): HeldContent | null {
  const node = Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
  if (!node) return null;
  const items = childLists(node).flatMap((l) => l.ids);
  if (!items.length) return null;
  const placements = subtreeIds(tree, nodeId).filter((id) => id !== nodeId && tree.nodes[id]?.kind === 'instance').length;
  return node.kind === 'instance' || placements ? { items, placements } : null;
}

/**
 * Everything deleting `nodeId` of `owner` takes with it, as it stands now: its nodes and, in a component's design, the
 * parts naming them, their variant styles, and what each placement of the component sets for those parts. Two reads
 * compare equal only while none of it has changed, so a deletion planned again goes ahead only on what was chosen.
 */
export function removalKey(state: ProjectState, owner: OwnerRef, tree: NodeTree, nodeId: string): string {
  const ids = subtreeIds(tree, nodeId);
  const def = owner.kind === 'component' && Object.hasOwn(state.components, owner.id) ? state.components[owner.id] : undefined;
  if (!def) return JSON.stringify(ids.map((id) => tree.nodes[id]));
  const removed = new Set(ids);
  const parts = Object.entries(def.parts).filter(([pid, p]) => pid !== 'root' && removed.has(p.nodeId));
  // Only what is set on what goes: an option or a placement setting nothing there is not part of what it takes.
  const variants = variantOptions(def).flatMap(({ axis, id, option }) => {
    const styled = ids.filter((n) => option.styles?.[n] !== undefined).map((n) => [n, option.styles![n]]);
    return styled.length ? [[axis, id, styled]] : [];
  });
  const set = instancesOf(state, def.id).flatMap(({ owner: at, node }) => {
    const own = parts.filter(([pid]) => node.overrides?.[pid] !== undefined || node.itemOverrides?.[pid] !== undefined).map(([pid]) => [pid, node.overrides?.[pid] ?? null, node.itemOverrides?.[pid] ?? null]);
    return own.length ? [[at.kind, at.id, node.id, own]] : [];
  });
  return JSON.stringify([ids.map((id) => tree.nodes[id]), parts, variants, set]);
}
