/** Buttons without a destination, as the Inspector flags them: the site leaves them out. */
import type { OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { unlinkedButtonsAt, type PlacementField, type UnlinkedButton } from '@generator/checks';
import { treeFor } from './model';

/** Said under a button's link and on a closed list item whose button has none; "hide" only when it can be. */
export const unlinkedNote = (b: Pick<UnlinkedButton, 'hide'>) => `No link yet, so visitors won’t see this button. Choose where it goes${b.hide ? ', or hide it' : ''}.`;

/**
 * The unlinked buttons a page or header/footer node renders and reports as its own: a placed component's buttons
 * (each with the field that sets it, when the placement's content does), or the node itself when it is a button.
 */
export function unlinkedAt(state: ProjectState, owner: OwnerRef, nodeId: string): UnlinkedButton[] {
  if (owner.kind === 'component') return [];
  const tree = treeFor(state, owner);
  return tree ? unlinkedButtonsAt(state, tree, nodeId).filter((b) => b.nodeId === nodeId) : [];
}

/** The finding for one link field of a placement: a property, or one item's field in a list property. */
export function unlinkedField(found: UnlinkedButton[], prop: string, itemId?: string, field?: string): UnlinkedButton | undefined {
  return found.find((b) => b.link?.prop === prop && b.link.itemId === itemId && b.link.field === field);
}

/**
 * The finding whose Hide may be offered at a field of one list item (`itemId`) or of the whole placement (none):
 * only when its label belongs to that same scope, so hiding never reaches another item's button.
 */
export function hideAt(b: UnlinkedButton | undefined, itemId?: string): UnlinkedButton | undefined {
  return b?.hide && b.hide.itemId === itemId ? b : undefined;
}

/** Hides a button by clearing the label that decides whether it shows. */
export function hideButtonOp(owner: OwnerRef, nodeId: string, label: PlacementField): EditOperation {
  return label.itemId && label.field
    ? { type: 'instance.setProp', owner, nodeId, prop: label.prop, itemId: label.itemId, field: label.field, value: '' }
    : { type: 'instance.setProp', owner, nodeId, prop: label.prop, value: '' };
}
