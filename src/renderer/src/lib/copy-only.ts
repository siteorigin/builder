import type { CopyOnlyGrant, ProjectSnapshot } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import { isBinding, type ElementRef, type ProjectState } from '@shared/types';
import { copyEditorOperationProblem } from '@shared/live/copy-editor';
import { shownOnceIn } from '@engine/slots';

/**
 * A live session's copy editor (#1318): the host's project is read-only to it but for the words of the text on its
 * pages and the copy and pictures of the components placed there that the host's grant names. This is what its editor
 * offers and lets through to the host; the host checks every edit again, against the project as the edit would leave
 * it (engine/copy-editor.ts), and is the one that decides.
 */

type Snap = Pick<ProjectSnapshot, 'readOnly'> | null | undefined;

/** The copy editor's grant on the project shown, paused or not: null for anyone else. */
export const copyGrant = (snap: Snap): CopyOnlyGrant | null => snap?.readOnly?.copyOnly ?? null;
/** The copy editor's grant while it can edit now: null for anyone else, or while editing is paused. */
export const copyEditing = (snap: Snap): CopyOnlyGrant | null => {
  const grant = copyGrant(snap);
  return grant && !grant.paused ? grant : null;
};

const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => (record && Object.hasOwn(record, key) ? record[key] : undefined);

/** A page's own element, placed on it at the top (not inside a placed component), shown once: what a copy editor can reach. */
function pageNode(state: ProjectState, ref: Pick<ElementRef, 'owner' | 'instancePath' | 'nodeId' | 'itemPath' | 'partId' | 'slot'>) {
  if (ref.owner.kind !== 'page' || ref.instancePath.length || ref.itemPath?.length || ref.partId !== undefined || ref.slot !== undefined) return null;
  const page = own(state.pages, ref.owner.id);
  const node = page ? own(page.nodes, ref.nodeId) : undefined;
  return page && node && shownOnceIn(state, page, node.id) ? node : null;
}

/** Whether a copy editor may change the words of this element: a text element of a page's own, with words written in it. */
export function copyEditableText(state: ProjectState, ref: ElementRef): boolean {
  const node = pageNode(state, ref);
  return node?.kind === 'text' && !isBinding(node.text);
}

/**
 * The properties of this placement a copy editor may change, in the design's order: those the grant names for its
 * design, on a component placed on a page, each with a value of its own or its design's default, never one that
 * comes from elsewhere.
 */
export function copyEditablePropsOf(state: ProjectState, grant: CopyOnlyGrant, ref: ElementRef): string[] {
  const node = pageNode(state, ref);
  if (node?.kind !== 'instance') return [];
  const def = own(state.components, node.definitionId);
  const granted = own(grant.props, node.definitionId);
  if (!def || !Array.isArray(granted)) return [];
  return Object.keys(def.properties).filter((prop) => granted.includes(prop) && !isBinding(own(node.props, prop)));
}

/**
 * Why a copy editor's editor does not send this batch to the host, naming the operation, or null when it goes: every
 * operation must be one the host lets a copy editor make (shared/live/copy-editor.ts), to text or a property this
 * editor offers. What the host checks against the project as the edit would leave it (a link retargeted in rich text,
 * a picture removed) is the host's to refuse.
 */
export function copyBatchProblem(state: ProjectState, grant: CopyOnlyGrant, operations: readonly EditOperation[]): { message: string; operationIndex: number } | null {
  for (const [operationIndex, op] of operations.entries()) {
    const shape = copyEditorOperationProblem(op);
    if (shape) return { message: shape, operationIndex };
    const ref: ElementRef = { owner: op.owner, instancePath: [], nodeId: (op as { nodeId: string }).nodeId };
    if (op.type === 'node.setContent' && !copyEditableText(state, ref)) return { message: 'A copy editor changes only the written words of a text element on a page.', operationIndex };
    if (op.type === 'instance.setProp' && !copyEditablePropsOf(state, grant, ref).includes(op.prop)) return { message: 'Only the host can change that.', operationIndex };
  }
  return null;
}
