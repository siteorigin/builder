/**
 * Scope authority for AI runs. The application decides what a run may change; the model cannot widen it
 * by declaring a different scope. A request sent with a selection attached is limited to that element
 * until the user explicitly approves a wider change.
 */
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { findParent, getTree, subtreeIds } from '@engine/tree';

export type Authority = { kind: 'site' } | { kind: 'selection'; owner: OwnerRef; nodeId: string; label: string };

export function authorityFor(selection: ElementRef | null, label: string | null): Authority {
  if (!selection) return { kind: 'site' };
  return { kind: 'selection', owner: selection.owner, nodeId: selection.instancePath[0] ?? selection.nodeId, label: label ?? 'the selection' };
}

const NODE_OPS = new Set([
  'node.remove',
  'node.move',
  'node.duplicate',
  'node.rename',
  'node.setStyle',
  'node.resetStyles',
  'node.setContent',
  'instance.setProp',
  'instance.listInsert',
  'instance.listRemove',
  'instance.listMove',
  'instance.setVariant',
  'component.makeUnique',
  'component.convertToCode'
]);
const ALWAYS_ALLOWED = new Set<string>();

/** Returns null when every operation stays within the authority, otherwise a reason. */
export function checkAuthority(state: ProjectState, ops: EditOperation[], authority: Authority): string | null {
  if (authority.kind === 'site') return null;
  let allowed: Set<string>;
  try {
    const tree = getTree(state, authority.owner);
    allowed = new Set(subtreeIds(tree, authority.nodeId));
    void findParent;
  } catch {
    return 'The selected element no longer exists.';
  }
  const sameOwner = (o: OwnerRef) => o.kind === authority.owner.kind && o.id === authority.owner.id;
  for (const op of ops) {
    if (ALWAYS_ALLOWED.has(op.type)) continue;
    if (NODE_OPS.has(op.type)) {
      const o = op as unknown as { owner: OwnerRef; nodeId: string; parentId?: string | null };
      if (!sameOwner(o.owner) || !allowed.has(o.nodeId)) return `${op.type} targets something outside ${authority.label}.`;
      if (op.type === 'node.move' && (!o.parentId || !allowed.has(o.parentId))) return `node.move would move content outside ${authority.label}.`;
      if (op.type === 'node.move' && o.nodeId === authority.nodeId) return `node.move would move ${authority.label} itself.`;
      if (op.type === 'node.duplicate' && o.nodeId === authority.nodeId) return `node.duplicate would add a new section outside ${authority.label}.`;
      continue;
    }
    if (op.type === 'node.insert') {
      if (!sameOwner(op.owner) || !op.parentId || !allowed.has(op.parentId)) return `node.insert adds content outside ${authority.label}.`;
      continue;
    }
    return `${op.type} changes more than ${authority.label}.`;
  }
  return null;
}

export const WIDEN_YES = 'Yes, allow changes beyond the selection';
export const WIDEN_NO = 'No, only change the selection';
