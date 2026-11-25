/**
 * A placed component's slots as the Inspector lists them (#654): what each takes, what it holds, and why nothing
 * more can be added to it, with the changes that take a slot's content out again. Worked out on a project's state
 * alone, counting content as the engine's contracts do.
 */
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState, SlotDef } from '@shared/types';
import { slotChildren } from '@shared/types';
import { newId } from '@shared/ids';
import { definitionRole } from '@engine/insert-role';
import { slotAccepts, slotDeclProblem, slotFill } from '@engine/slots';
import { findParent } from '@engine/tree';
import { treeFor } from './model';
import { placedSlots, slotLimitWords } from './slot-contract';

export interface SlotOverview {
  /** The name the component declares it under. */
  slot: string;
  label: string;
  description: string;
  /** "Takes media components and text · At most 2". */
  contract: string;
  /** The nodes placed in it, in order. */
  children: string[];
  /** How many items it shows, as its limit counts them. */
  count: number;
  /** Why nothing more can be added to it (its contract, or a design that never shows it), or null. */
  closed: string | null;
  /** What is wrong with a declaration a hand edit damaged (it then has no contract to show or fill), or null. */
  damaged: string | null;
}

const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);

/** What a slot's contract says, in the words Edit everywhere's own Slots section uses. */
const contractWords = (state: ProjectState, d: SlotDef): string => (d.max === 0 ? slotLimitWords(d) : `Takes ${slotAccepts(d, state)} · ${slotLimitWords(d)}`);

function closedWords(state: ProjectState, d: SlotDef, count: number): string | null {
  if (d.max === 0 || slotAccepts(d, state) === 'nothing') return 'This slot takes no content.';
  if (d.max !== undefined && count >= d.max) return `Full: it holds at most ${items(d.max)}. Take something out to add more.`;
  return null;
}

/** The slots the component placed as `node` declares, in the order it declares them; none when it has none. */
export function slotOverviews(state: ProjectState, owner: OwnerRef, node: InstanceNode): SlotOverview[] {
  const def = Object.hasOwn(state.components, node.definitionId) ? state.components[node.definitionId] : undefined;
  const tree = treeFor(state, owner);
  if (!def || !tree) return [];
  // A design shows a slot only where it places it; code renders its slots as it likes.
  const shown = def.kind === 'managed' ? placedSlots(def) : null;
  return Object.entries(def.slots ?? {}).map(([slot, decl]) => {
    const children = slotChildren(node, slot).filter((id) => Object.hasOwn(tree.nodes, id));
    const damaged = slotDeclProblem(decl);
    if (damaged) return { slot, label: slot, description: '', contract: '', children, count: children.length, closed: null, damaged };
    const count = slotFill(state, tree, children, decl).count;
    const closed = closedWords(state, decl, count) ?? (shown && !shown.has(slot) ? 'This design doesn’t show this slot, so nothing added to it would appear.' : null);
    return { slot, label: decl.label, description: decl.description ?? '', contract: contractWords(state, decl), children, count, closed, damaged: null };
  });
}

/** "Empty", "1 item", "3 items". A slot that can show any number says so. */
export const slotCountWords = (count: number): string => (!Number.isFinite(count) ? 'Any number of items' : count === 0 ? 'Empty' : items(count));

/**
 * Why a slot's content can't be moved out of a placement in `owner`, or null. The editor neither moves nor deletes
 * anything in the shared header or footer, so what was moved out of a slot there could not be taken away again.
 */
export const moveOutRefusal = (owner: OwnerRef): string | null =>
  owner.kind === 'shell' ? `Content can’t be moved around in the shared ${owner.id === 'footer' ? 'footer' : 'header'}. Clear removes it.` : null;

/** The operations that delete what a placement's slot holds, as one change. None when it holds nothing. */
export function clearSlotOps(state: ProjectState, owner: OwnerRef, nodeId: string, slot: string): EditOperation[] {
  return slotContent(state, owner, nodeId, slot).map((id) => ({ type: 'node.remove', owner, nodeId: id }));
}

/**
 * The operations that move what a placement's slot holds to just after the placement, in order, as one change: into
 * the list holding the placement, which must take it all (the engine refuses the whole change otherwise). The
 * placement stays, with its other slots. A page's top level holds sections: a section lands there as it is, and each
 * run of anything else goes into a new Section, as node.removeKeepContent places what it keeps. None when the slot
 * holds nothing, or in the shared header or footer (see moveOutRefusal).
 */
export function moveOutOps(state: ProjectState, owner: OwnerRef, nodeId: string, slot: string): EditOperation[] {
  const tree = treeFor(state, owner);
  const at = tree ? findParent(tree, nodeId) : null;
  const held = slotContent(state, owner, nodeId, slot);
  if (!tree || !at || !held.length || moveOutRefusal(owner)) return [];
  const move = (id: string, parentId: string | null, into: string | undefined, index: number): EditOperation => ({ type: 'node.move', owner, nodeId: id, parentId, ...(into !== undefined ? { slot: into } : {}), index });
  if (owner.kind !== 'page' || at.parentId !== null) return held.map((id, i) => move(id, at.parentId, at.slot, at.index + 1 + i));
  const ops: EditOperation[] = [];
  let index = at.index + 1;
  let wrapper: { id: string; count: number } | null = null;
  for (const id of held) {
    const n = tree.nodes[id];
    // Read before anything moves: a component's role can follow from where it is placed (see definitionRole).
    if (n.kind === 'instance' && definitionRole(state, n.definitionId) === 'section') {
      ops.push(move(id, null, undefined, index++));
      wrapper = null;
      continue;
    }
    if (!wrapper) {
      wrapper = { id: newId('n'), count: 0 };
      ops.push({ type: 'node.insert', newNodeId: wrapper.id, owner, parentId: null, index: index++, componentId: 'layout.section' });
    }
    ops.push(move(id, wrapper.id, 'content', wrapper.count++));
  }
  return ops;
}

/** What a placement's slot holds, in order: the nodes the project has. */
function slotContent(state: ProjectState, owner: OwnerRef, nodeId: string, slot: string): string[] {
  const tree = treeFor(state, owner);
  const node = tree && Object.hasOwn(tree.nodes, nodeId) ? tree.nodes[nodeId] : undefined;
  return tree && node?.kind === 'instance' ? slotChildren(node, slot).filter((id) => Object.hasOwn(tree.nodes, id)) : [];
}
