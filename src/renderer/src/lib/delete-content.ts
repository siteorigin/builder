import type { NodeTree } from '@shared/types';
import { childLists, subtreeIds } from '@engine/tree';

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
