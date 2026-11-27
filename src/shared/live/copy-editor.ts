import type { EditOperation, OperationType } from '../ops';

/**
 * A live session's Copy Editor: a client who changes the words and pictures on the site's pages and nothing else. It
 * edits the text of a page's own text elements, and the properties a design marks `copyEditable` (its copy, its
 * pictures) on the components placed on a page. It never changes what is on a page or how it is arranged, the shared
 * header and footer, a design, the site's styles or settings, a collection, the asset library, or where a contact
 * form sends its messages.
 *
 * This is the half of the policy that reads only the operations, so it can turn an edit away before anything runs. The
 * host's check against the project (engine/copy-editor.ts) holds every operation, and the project the batch would
 * leave, to the rest.
 */
export const COPY_EDITOR_OPERATIONS = ['node.setContent', 'instance.setProp'] as const satisfies readonly OperationType[];

/** How deep a value is looked into for a binding: rich text is blocks of runs of spans, a link value one more. */
const MAX_VALUE_DEPTH = 8;

/** Whether a value carries a binding (`$prop`, `$item`, `$entry`, `$state`, `$query`...) anywhere in it. */
function carriesBinding(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false;
  if (depth > MAX_VALUE_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => carriesBinding(v, depth + 1));
  return Object.keys(value).some((k) => k.startsWith('$') || carriesBinding((value as Record<string, unknown>)[k], depth + 1));
}

/**
 * Why a Copy Editor may not make this edit, from the operation alone, or null when the project still has to decide
 * (engine/copy-editor.ts). Only a page's own content: the text of a text element, or one whole property of a placed
 * component (never a list item's field or an object's), to a written value, never a binding.
 */
export function copyEditorOperationProblem(op: EditOperation): string | null {
  if (!(COPY_EDITOR_OPERATIONS as readonly string[]).includes(op.type)) return `A copy editor cannot make "${op.type.slice(0, 60)}" edits.`;
  if (op.type !== 'node.setContent' && op.type !== 'instance.setProp') return 'A copy editor changes only text and pictures.';
  if (op.owner.kind !== 'page') return 'A copy editor changes only what is on the site’s pages.';
  if (op.type === 'node.setContent' && op.field !== 'text') return 'A copy editor changes only the words of a text element.';
  if (op.type === 'instance.setProp' && (op.itemId !== undefined || op.field !== undefined)) return 'A copy editor changes a component’s own text and pictures, not a list’s or a group’s.';
  if (carriesBinding(op.value)) return 'A copy editor writes text and pictures, never a connection to other content.';
  return null;
}
