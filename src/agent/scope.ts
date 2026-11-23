/**
 * Scope authority for AI runs. The application decides what a run may change; the model cannot widen it
 * by declaring a different scope. A request sent with a selection attached is limited to that element
 * until the user explicitly approves a wider change.
 */
import type { ComponentDefinition, ElementRef, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation, OperationType } from '@shared/ops';
import { getTree, subtreeIds } from '@engine/tree';

export type Authority = { kind: 'site' } | { kind: 'selection'; owner: OwnerRef; nodeId: string; label: string };

export function authorityFor(selection: ElementRef | null, label: string | null): Authority {
  if (!selection) return { kind: 'site' };
  return { kind: 'selection', owner: selection.owner, nodeId: selection.instancePath[0] ?? selection.nodeId, label: label ?? 'the selection' };
}

/**
 * How far each operation reaches, for a run limited to a selection:
 * - node: changes one node, which must be inside the selection.
 * - insert / copy: adds content, whose destination must be inside the selection.
 * - definition: adds to the contract of the component being edited, when the selection is inside it.
 * - wider: changes pages, site styles, shared definitions or assets, so it needs the user's approval.
 * Typed over every operation, so a new operation does not compile until it is classified here.
 */
export type OpReach = 'node' | 'insert' | 'copy' | 'definition' | 'wider';

export const OP_REACH: Record<OperationType, OpReach> = {
  'page.create': 'wider',
  'page.update': 'wider',
  'page.duplicate': 'wider',
  'page.reorder': 'wider',
  'page.remove': 'wider',
  'page.setHome': 'wider',
  'node.insert': 'insert',
  'node.remove': 'node',
  'node.move': 'node',
  'node.duplicate': 'node',
  'node.copy': 'copy',
  // The editor's own clipboard; the session refuses it from an AI run.
  'node.paste': 'wider',
  'node.rename': 'node',
  'node.setStyle': 'node',
  'node.resetStyles': 'node',
  'node.setContent': 'node',
  'node.setBinding': 'node',
  'instance.setProp': 'node',
  'instance.listInsert': 'node',
  'instance.listRemove': 'node',
  'instance.listMove': 'node',
  'instance.setVariant': 'node',
  'token.set': 'wider',
  'token.create': 'wider',
  'token.rename': 'wider',
  'token.remove': 'wider',
  'token.replace': 'wider',
  'site.update': 'wider',
  'component.createFromNode': 'wider',
  'component.makeUnique': 'node',
  'component.duplicate': 'wider',
  'component.rename': 'wider',
  'component.fork': 'wider',
  'component.convertToCode': 'node',
  'component.createCode': 'wider',
  'component.updateSource': 'wider',
  'component.remove': 'wider',
  'component.setPropSchema': 'definition',
  'component.removePropSchema': 'wider',
  'component.setPart': 'definition',
  'component.removePart': 'wider',
  'component.setVariant': 'definition',
  'component.removeVariant': 'wider',
  'component.setSlot': 'definition',
  'component.removeSlot': 'wider',
  'theme.apply': 'wider',
  'theme.refresh': 'wider',
  'asset.add': 'wider',
  'asset.update': 'wider',
  'asset.remove': 'wider',
  'asset.replace': 'wider'
};

/**
 * Whether a contract edit stays within a selection inside that component. Only additions qualify: changing
 * or removing an existing property, part, variant or slot affects content outside the selected element.
 */
function definitionOpAllowed(state: ProjectState, op: EditOperation, authority: Extract<Authority, { kind: 'selection' }>, allowed: Set<string>): boolean {
  if (authority.owner.kind !== 'component') return false;
  const def = state.components[authority.owner.id];
  if (!def) return false;
  switch (op.type) {
    case 'component.setPropSchema':
      return op.definitionId === def.id && !Object.hasOwn(def.properties, op.prop);
    case 'component.setPart':
      return op.definitionId === def.id && !Object.hasOwn(def.parts, op.partId) && allowed.has(op.nodeId);
    case 'component.setVariant':
      // The first variant becomes the default for every placement, so it is not a local addition.
      return op.definitionId === def.id && !op.makeDefault && addsOptionToExistingAxis(def, op.variant, op.axis, op.axisLabel);
    case 'component.setSlot':
      return op.definitionId === def.id && !Object.hasOwn(def.slots ?? {}, op.slot);
    default:
      return false;
  }
}

/** A new option on an axis that already exists changes no placement; a new axis gives every placement a default. */
function addsOptionToExistingAxis(def: ComponentDefinition, option: string, axis?: string, axisLabel?: string): boolean {
  const axes = Object.keys(def.variantAxes ?? {});
  const id = axis ?? (axes.length === 1 ? axes[0] : undefined);
  const target = id !== undefined && Object.hasOwn(def.variantAxes ?? {}, id) ? def.variantAxes![id] : undefined;
  // Renaming the axis shows in every placement's Inspector.
  if (axisLabel !== undefined && axisLabel.trim() !== target?.label) return false;
  return !!target && !Object.hasOwn(target.options, option);
}

/** Returns null when every operation stays within the authority, otherwise a reason. */
export function checkAuthority(state: ProjectState, ops: EditOperation[], authority: Authority): string | null {
  if (authority.kind === 'site') return null;
  let allowed: Set<string>;
  try {
    const tree = getTree(state, authority.owner);
    allowed = new Set(subtreeIds(tree, authority.nodeId));
  } catch {
    return 'The selected element no longer exists.';
  }
  const sameOwner = (o: OwnerRef) => o.kind === authority.owner.kind && o.id === authority.owner.id;
  for (const op of ops) {
    // Anything not classified (an operation from a newer document) is treated as the widest reach.
    switch (OP_REACH[op.type] ?? 'wider') {
      case 'node': {
        const o = op as unknown as { owner: OwnerRef; nodeId: string; parentId?: string | null };
        if (!sameOwner(o.owner) || !allowed.has(o.nodeId)) return `${op.type} targets something outside ${authority.label}.`;
        if (op.type === 'node.move' && (!o.parentId || !allowed.has(o.parentId))) return `node.move would move content outside ${authority.label}.`;
        if (op.type === 'node.move' && o.nodeId === authority.nodeId) return `node.move would move ${authority.label} itself.`;
        if (op.type === 'node.duplicate' && o.nodeId === authority.nodeId) return `node.duplicate would add a new section outside ${authority.label}.`;
        break;
      }
      case 'insert': {
        const o = op as Extract<EditOperation, { type: 'node.insert' }>;
        if (!sameOwner(o.owner) || !o.parentId || !allowed.has(o.parentId)) return `node.insert adds content outside ${authority.label}.`;
        break;
      }
      case 'copy': {
        // The source is only read, so it may be anywhere; the copy must land inside the selection.
        const o = op as Extract<EditOperation, { type: 'node.copy' }>;
        if (!sameOwner(o.toOwner) || !o.parentId || !allowed.has(o.parentId)) return `node.copy adds content outside ${authority.label}.`;
        break;
      }
      case 'definition':
        if (!definitionOpAllowed(state, op, authority, allowed)) return `${op.type} changes more than ${authority.label}.`;
        break;
      default:
        return `${op.type} changes more than ${authority.label}.`;
    }
  }
  return null;
}

export const WIDEN_YES = 'Yes, allow changes beyond the selection';
export const WIDEN_NO = 'No, only change the selection';
