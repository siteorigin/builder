// The list item open in the inspector, shown where it is on the page while it is edited: its disclosure (an FAQ
// answer) opened and outlined, and the text being typed shown in place of the saved text. An editing aid only: it
// never changes the project, so visitors and exports see the site as saved. Plain functions, tested without a
// renderer.
import type { ElementRef, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import { enclosingRepeatProp, findParent, subtreeIds } from '@engine/tree';
import { nodeAt } from './model';

/** Typed text is shown on the page up to this length; the bridge refuses longer text. */
export const MAX_DRAFT_CHARS = 20000;

/** Which list an inspector list editor edits: the section's placement (an instance reference) and its property. */
export interface ListPlace {
  ref: ElementRef;
  list: string;
}

/** The item a list editor has open. `owner` names that list editor, so only it can clear or change the item. */
export interface RevealedItem extends ListPlace {
  owner: string;
  itemId: string;
  /** Text typed into one of the item's fields and not saved yet. */
  draft: { field: string; text: string } | null;
  /** The field whose typing was cancelled (Escape): the page shows its own text there again at once. */
  cancelled?: string;
}

/**
 * What the preview bridge reveals: the item's elements under the placement's context (`ctx`), found by the stable
 * item id, never by label or position. The item is the same one while `ctx`, `list` and `items` are; a change to the
 * design only changes how it is found. `nodes` are what the list's repeats render for each item (outlined and
 * scrolled to). `within` maps every node inside those repeats to how many other repeats enclose its repeat (0 at the
 * top of the design), which says where the item's id sits among that node's item ids; only these nodes' elements are
 * the item's (another list can reuse its id). `text` is typed text for the plain text nodes bound to the field being
 * edited; `restore` names the plain text nodes whose own text the page shows again at once (typing was cancelled).
 */
export interface RevealTarget {
  ctx: string;
  list: string;
  items: string;
  nodes: string[];
  within: Record<string, number>;
  text?: { nodes: string[]; value: string };
  restore?: string[];
}

/**
 * The bridge target for a revealed item, or null when the page can't show it: the placement is not a designed
 * component (a code component has no tree to read), or its design does not repeat the list. `ctx` is the context the
 * placement's own nodes carry on the page (see descOf).
 */
export function revealTarget(state: ProjectState, item: RevealedItem, ctx: string): RevealTarget | null {
  const inst = nodeAt(state, item.ref);
  if (inst?.kind !== 'instance' || !item.itemId) return null;
  const def = Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  if (def?.kind !== 'managed' || !def.tree) return null;
  const tree = def.tree;
  // Every repeat of the list: a menu can be listed twice (once for each width), and a list repeated inside another
  // list's rows shows each item once per row. The page finds all of them by the item's own id.
  const repeats = Object.values(tree.nodes).filter((n) => n.kind === 'repeat' && n.list.$prop === item.list);
  const nodes = repeats.flatMap((n) => (n.kind === 'repeat' ? n.children : []));
  if (!nodes.length) return null;
  const depthOf = (id: string) => {
    let n = 0;
    for (let p = findParent(tree, id)?.parentId, guard = 0; p && guard < 50; p = findParent(tree, p)?.parentId, guard++) if (tree.nodes[p]?.kind === 'repeat') n++;
    return n;
  };
  // Shallowest first, so a node inside two repeats of the list keeps the depth of the nearer one. No prototype: a
  // node can be called anything, "__proto__" included.
  const within: Record<string, number> = Object.create(null);
  for (const [r, depth] of repeats.map((r) => [r, depthOf(r.id)] as const).sort((x, y) => x[1] - y[1])) {
    for (const id of subtreeIds(tree, r.id)) if (id !== r.id) within[id] = depth;
  }
  const target: RevealTarget = { ctx, list: item.list, items: item.itemId, nodes, within };
  const fields = def.properties[item.list]?.type === 'list' ? (def.properties[item.list] as { fields: Record<string, { type: string }> }).fields : {};
  // Only plain text is shown as typed: rich text and links are rendered by components of their own.
  const textNodes = (field: string) =>
    fields[field]?.type !== 'string'
      ? []
      : Object.values(tree.nodes)
          .filter((n) => n.kind === 'text' && !n.rich && isBinding(n.text) && '$item' in n.text && n.text.$item === field && enclosingRepeatProp(def, n.id) === item.list)
          .map((n) => n.id);
  const draft = item.draft;
  if (draft && draft.text.length <= MAX_DRAFT_CHARS) {
    const nodes = textNodes(draft.field);
    if (nodes.length) target.text = { nodes, value: draft.text };
  }
  if (!draft && item.cancelled) {
    const nodes = textNodes(item.cancelled);
    if (nodes.length) target.restore = nodes;
  }
  return target;
}

/** The same item revealed in the same way: nothing to send to the page again. */
export function sameTarget(a: RevealTarget | null, b: RevealTarget | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
