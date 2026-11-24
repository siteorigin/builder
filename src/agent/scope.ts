/**
 * Scope authority for AI runs. The application decides what a run may change; the model cannot widen it
 * by declaring a different scope. A request sent with a selection attached is limited to that element
 * until the user explicitly approves a wider change.
 */
import type { ComponentDefinition, ElementRef, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation, OperationType } from '@shared/ops';
import { getTree, settledRoot, subtreeIds } from '@engine/tree';

/**
 * - site: anything the request needs.
 * - selection: one element and what is inside it.
 * - component: one component's whole design, edited everywhere: every node of it (all its top-level nodes) and its
 *   own contract (properties, defaults, parts, variants and slots). Every change applies to every placement.
 */
export type Authority =
  | { kind: 'site' }
  | { kind: 'selection'; owner: OwnerRef; nodeId: string; label: string }
  | { kind: 'component'; definitionId: string; label: string };

/** `component`: the component the author is editing everywhere; a selection inside it narrows the run further. */
export function authorityFor(selection: ElementRef | null, label: string | null, component?: { id: string; name: string } | null): Authority {
  if (selection) return { kind: 'selection', owner: selection.owner, nodeId: selection.instancePath[0] ?? selection.nodeId, label: label ?? 'the selection' };
  if (component) return { kind: 'component', definitionId: component.id, label: component.name };
  return { kind: 'site' };
}

/** Whether a run may change a component's own contract (its properties, parts, variants, slots and bindings). These
 *  are visual edits to a managed component, never code, so they do not depend on Developer mode. */
export function canEditContracts(authority: Authority): boolean {
  return authority.kind !== 'selection' || authority.owner.kind === 'component';
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
  'instance.editTable': 'node',
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
  // A new default changes every placement without a value of its own.
  'component.setPropDefault': 'wider',
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
  'asset.replace': 'wider',
  'asset.relink': 'wider'
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

/**
 * Contract edits a run on a component's whole design may make to that component. Changing or removing an existing
 * property, default, part, variant or slot is what editing a component everywhere is for; the engine still
 * validates each one.
 */
const CONTRACT_EDITS = new Set<OperationType>([
  'component.setPropSchema',
  'component.removePropSchema',
  'component.setPropDefault',
  'component.setPart',
  'component.removePart',
  'component.setVariant',
  'component.removeVariant',
  'component.setSlot',
  'component.removeSlot'
]);

/** Returns null when every operation stays within one component's own design, otherwise a reason. */
function checkComponentAuthority(state: ProjectState, ops: EditOperation[], authority: Extract<Authority, { kind: 'component' }>): string | null {
  const def = state.components[authority.definitionId];
  if (!def?.tree) return `${authority.label} is no longer in the site.`;
  const nodes = def.tree.nodes;
  // The first top-level node is the component's own root: placements' classes and variants style it, so it stays
  // first. The engine keeps anything else from joining it at the top level (a design from an older version may still
  // have other top-level nodes after it).
  const root = def.tree.rootIds[0];
  const beforeRoot = (parentId: string | null | undefined, index: number | undefined) => !parentId && !!root && index === 0;
  // A design from an older version without its one root is put right by a container that goes first and holds the
  // others, the old first root included (see the engine's `settledRoot`).
  const unsettled = !settledRoot(def.tree);
  const insideRoot = new Set(root ? subtreeIds(def.tree, root) : []);
  const repair = (op: EditOperation) =>
    unsettled &&
    ((op.type === 'node.insert' && !op.parentId && !!op.primitive && ['container', 'stack', 'row', 'grid'].includes(op.primitive)) ||
      (op.type === 'node.move' && op.nodeId === root && !!op.parentId && !insideRoot.has(op.parentId)));
  const rootFirst = `The first top-level node of ${authority.label} is its root, which every placement and variant styles: keep it first, and put new content inside it.`;
  const mine = (o: OwnerRef) => o.kind === 'component' && o.id === def.id;
  /** A node of the design, or its top level (null). */
  const inside = (id: string | null | undefined) => !id || Object.hasOwn(nodes, id);
  const outside = (op: EditOperation) => `${op.type} changes something outside ${authority.label}.`;
  for (const op of ops) {
    if (CONTRACT_EDITS.has(op.type)) {
      if ((op as { definitionId?: string }).definitionId !== def.id) return outside(op);
      // Removing a slot removes its placeholder too, which may be the root.
      const first = root ? nodes[root] : undefined;
      if (op.type === 'component.removeSlot' && first?.kind === 'slot' && first.slot === op.slot) return `component.removeSlot: ${rootFirst}`;
      continue;
    }
    // Both add a new component to the site, for one placement inside the design.
    if (op.type === 'component.makeUnique' || op.type === 'component.convertToCode') return `${op.type} adds a new component to the site, which changes more than ${authority.label}.`;
    switch (OP_REACH[op.type] ?? 'wider') {
      case 'node': {
        const o = op as unknown as { owner: OwnerRef; nodeId: string; parentId?: string | null; index?: number };
        if (!mine(o.owner) || !Object.hasOwn(nodes, o.nodeId)) return outside(op);
        if (op.type === 'node.move' && !inside(o.parentId)) return `node.move would move content outside ${authority.label}.`;
        if (op.type === 'node.move' && !repair(op) && (o.nodeId === root ? !(!o.parentId && o.index === 0) : beforeRoot(o.parentId, o.index))) return `node.move: ${rootFirst}`;
        if (op.type === 'node.remove' && o.nodeId === root) return `node.remove: ${rootFirst}`;
        break;
      }
      case 'insert': {
        const o = op as Extract<EditOperation, { type: 'node.insert' }>;
        if (!mine(o.owner) || !inside(o.parentId)) return `node.insert adds content outside ${authority.label}.`;
        if (!repair(op) && beforeRoot(o.parentId, o.index)) return `node.insert: ${rootFirst}`;
        break;
      }
      case 'copy': {
        // The source is only read, so it may be anywhere; the copy must land in the design.
        const o = op as Extract<EditOperation, { type: 'node.copy' }>;
        if (!mine(o.toOwner) || !inside(o.parentId)) return `node.copy adds content outside ${authority.label}.`;
        if (beforeRoot(o.parentId, o.index)) return `node.copy: ${rootFirst}`;
        break;
      }
      default:
        return `${op.type} changes more than ${authority.label}.`;
    }
  }
  return null;
}

/** Returns null when every operation stays within the authority, otherwise a reason. */
export function checkAuthority(state: ProjectState, ops: EditOperation[], authority: Authority): string | null {
  if (authority.kind === 'site') return null;
  if (authority.kind === 'component') return checkComponentAuthority(state, ops, authority);
  let allowed: Set<string>;
  try {
    const tree = getTree(state, authority.owner);
    allowed = new Set(subtreeIds(tree, authority.nodeId));
  } catch {
    return 'The selected element no longer exists.';
  }
  // Gone since it was selected (or never there): nothing is limited to it, not even an addition to its contract.
  if (!allowed.size) return 'The selected element no longer exists.';
  const sameOwner = (o: OwnerRef) => o.kind === authority.owner.kind && o.id === authority.owner.id;
  for (const op of ops) {
    // Inside a component's design, a placement made unique or turned into code adds a new component to the site.
    if (authority.owner.kind === 'component' && (op.type === 'component.makeUnique' || op.type === 'component.convertToCode')) return `${op.type} adds a new component to the site, which changes more than ${authority.label}.`;
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

/** The two answers to a request for more than the authority allows: the first allows it. */
export function widenChoices(authority: Authority): [string, string] {
  if (authority.kind === 'component') return [`Yes, allow changes beyond ${authority.label}`, `No, only change ${authority.label}`];
  return [WIDEN_YES, WIDEN_NO];
}
