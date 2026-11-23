import type { NodeTree } from '@shared/types';
import { childLists, findParent, subtreeIds } from './tree';

/** A subtree one removal took out of a tree, and where it was. */
export interface Removal {
  rootId: string;
  /** The root and everything inside it. */
  ids: string[];
  /** The element or instance it sat in (null: a top-level section). */
  parentId: string | null;
  slot?: string;
  /** Its siblings in that list before it was removed, nearest first on each side. */
  left: string[];
  right: string[];
}

/** `gap`: sections now stand where it was, and no version of the tree given showed its order among them. */
export type RestoreResult = { ok: true; tree: NodeTree; rootId: string } | { ok: false; reason: string; gap?: boolean };

/**
 * The single subtree `before` had and `after` lost, when removing it is the only difference between the two
 * documents (anything else, such as a title, must be equal too). Null when the change was anything more.
 */
export function findRemoval<T extends NodeTree>(before: T, after: T): Removal | null {
  const removed = Object.keys(before.nodes).filter((id) => !Object.hasOwn(after.nodes, id));
  if (!removed.length || Object.keys(after.nodes).some((id) => !Object.hasOwn(before.nodes, id))) return null;
  const gone = new Set(removed);
  const roots = removed.filter((id) => {
    const p = findParent(before, id);
    return p !== null && (p.parentId === null || !gone.has(p.parentId));
  });
  if (roots.length !== 1) return null;
  const rootId = roots[0];
  const ids = subtreeIds(before, rootId);
  if (ids.length !== gone.size || ids.some((id) => !gone.has(id))) return null;
  const at = findParent(before, rootId)!;
  // The rest of the document must be exactly what `after` holds: the removal and nothing else.
  const expected = structuredClone(before);
  findParent(expected, rootId)!.list.splice(at.index, 1);
  for (const id of ids) delete expected.nodes[id];
  if (!sameValue(expected, after)) return null;
  return { rootId, ids, parentId: at.parentId, slot: at.slot, left: at.list.slice(0, at.index).reverse(), right: at.list.slice(at.index + 1) };
}

/**
 * Put a removed subtree back into `current`, with its original IDs and content, in the list it came from and
 * between the same surviving neighbours. When other sections have come to stand in that gap since (one put back
 * after a deletion just before it, say), its order among them is taken from an `earlier` version of the tree that
 * held them all. Refused, with the reason in plain words, when later edits leave no single right place for it or
 * the tree has reused any of its IDs.
 */
export function restoreRemoval<T extends NodeTree>(before: T, removal: Removal, current: T, earlier: NodeTree[] = []): RestoreResult {
  if (removal.ids.some((id) => Object.hasOwn(current.nodes, id))) return { ok: false, reason: 'Part of it is back on the page already.' };
  const tree = structuredClone(current);
  let list: string[] | undefined;
  if (removal.parentId === null) list = tree.rootIds;
  else {
    const parent = tree.nodes[removal.parentId];
    const reachable = parent && tree.rootIds.flatMap((id) => subtreeIds(tree, id)).includes(parent.id);
    if (!parent || !reachable) return { ok: false, reason: 'What it was inside has been deleted.' };
    list = childLists(parent).find((cl) => cl.slot === removal.slot)?.ids;
    if (!list) return { ok: false, reason: 'What it was inside has changed.' };
  }
  // The nearest neighbours still in the list mark the gap it left. Neighbours that have moved across it or into it
  // make its place a guess, and so do sections that arrived in it since, unless an earlier version shows the order.
  const leftAnchor = removal.left.find((id) => list.includes(id));
  const rightAnchor = removal.right.find((id) => list.includes(id));
  const from = leftAnchor === undefined ? 0 : list.indexOf(leftAnchor) + 1;
  const to = rightAnchor === undefined ? list.length : list.indexOf(rightAnchor);
  const changed = 'The sections around where it was have changed.';
  const gap = list.slice(from, to);
  if (from > to || gap.some((id) => removal.left.includes(id) || removal.right.includes(id))) return { ok: false, reason: changed };
  const ahead = gap.length ? orderInGap(removal, gap, earlier, leftAnchor, rightAnchor) : 0;
  if (ahead === null) return { ok: false, reason: changed, gap: true };
  list.splice(from + ahead, 0, removal.rootId);
  // Defined, not assigned, so even an ID such as "__proto__" (from a hand-edited document) lands as a node.
  for (const id of removal.ids) Object.defineProperty(tree.nodes, id, { value: structuredClone(before.nodes[id]), enumerable: true, writable: true, configurable: true });
  return { ok: true, tree, rootId: removal.rootId };
}

/** How many of the sections that arrived in the gap since go before the removed one: from the first version of the
 *  tree whose same list holds it and all of them between the same neighbours, in the order they stand in now. Null
 *  when no version shows it. */
function orderInGap(removal: Removal, gap: string[], earlier: NodeTree[], leftAnchor?: string, rightAnchor?: string): number | null {
  for (const v of earlier) {
    const list = removal.parentId === null ? v.rootIds : v.nodes[removal.parentId] && childLists(v.nodes[removal.parentId]).find((cl) => cl.slot === removal.slot)?.ids;
    if (!list) continue;
    const lo = leftAnchor === undefined ? -1 : list.indexOf(leftAnchor);
    const hi = rightAnchor === undefined ? list.length : list.indexOf(rightAnchor);
    const at = list.indexOf(removal.rootId);
    // A version where a neighbour is missing, or where they stood elsewhere, says nothing about this gap.
    if ((leftAnchor !== undefined && lo < 0) || hi < 0 || at <= lo || at >= hi) continue;
    const pos = gap.map((id) => list.indexOf(id));
    if (pos.some((p, i) => p <= lo || p >= hi || (i > 0 && p < pos[i - 1]))) continue;
    return pos.filter((p) => p < at).length;
  }
  return null;
}

/** Deep equality of JSON values, ignoring the order of object keys. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameValue(v, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
