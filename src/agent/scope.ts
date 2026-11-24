/**
 * Scope authority for AI runs. The application decides what a run may change; the model cannot widen it
 * by declaring a different scope. A request sent with a selection attached is limited to that element
 * until the user explicitly approves a wider change. A part selected inside a placement (its heading, one card) is
 * limited to that part: its own content and styles, never the rest of the placement.
 */
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import type { EditOperation, OperationType } from '@shared/ops';
import { enclosingRepeatProp, findParent, getTree, itemLinkPairs, settledRoot, subtreeIds } from '@engine/tree';
import { repeatedPartList } from '@shared/item-styles';
import { bindingSites } from '@engine/schema';
import { walkOperations } from '@engine/apply';

/** A part selected inside a placement: the run may change only what that part shows. */
export interface PartAuthority {
  /** The node of the placement's definition the selection is in: the selected node, or the nested placement it is inside. */
  regionNodeId: string;
  /** The selected public part, when the selection is one. */
  partId?: string;
  /** The selected list item, when the part is shown once per item. */
  itemId?: string;
  /** Inside a component placed in this one: its parts cannot be changed from the outer placement on their own. */
  nested?: boolean;
}

/**
 * - site: anything the request needs.
 * - selection: one element and what is inside it; with `part`, only what that part of a placement shows.
 * - component: one component's whole design, edited everywhere: every node of it (all its top-level nodes) and its
 *   own contract (properties, defaults, parts, variants and slots). Every change applies to every placement.
 */
export type Authority =
  | { kind: 'site' }
  | { kind: 'selection'; owner: OwnerRef; nodeId: string; label: string; part?: PartAuthority }
  | { kind: 'component'; definitionId: string; label: string };

/**
 * `component`: the component the author is editing everywhere; a selection inside it narrows the run further.
 * `state` is the project the selection was made in: it tells a part apart from the whole placement.
 */
export function authorityFor(selection: ElementRef | null, label: string | null, component?: { id: string; name: string } | null, state?: ProjectState): Authority {
  if (!selection) return component ? { kind: 'component', definitionId: component.id, label: component.name } : { kind: 'site' };
  const authority: Extract<Authority, { kind: 'selection' }> = { kind: 'selection', owner: selection.owner, nodeId: selection.instancePath[0] ?? selection.nodeId, label: label ?? 'the selection' };
  if (!selection.instancePath.length) return authority;
  const part: PartAuthority = {
    regionNodeId: selection.instancePath[1] ?? selection.nodeId,
    ...(selection.instancePath.length === 1 && selection.partId ? { partId: selection.partId } : {}),
    ...(selection.itemPath?.length ? { itemId: selection.itemPath[selection.itemPath.length - 1] } : {}),
    ...(selection.instancePath.length > 1 ? { nested: true } : {})
  };
  // Without the project, a part is assumed; with it, a selection that is really the whole placement is one.
  return !state || selectedPart(state, { ...authority, part }) ? { ...authority, part } : authority;
}

/** What a part of a definition shows, read from the definition's bindings. */
export interface PartReach {
  /** Properties shown only inside the part, wherever they are used (conditions included): changing one changes nothing else. */
  props: Set<string>;
  /** For a part inside a repeated item: each list, and the item fields shown only inside the part. */
  itemFields: Map<string, Set<string>>;
  /** The definition's nodes inside the part. */
  nodes: Set<string>;
  /** The part is shown once per item of a list: a placement property shown inside it shows in every item. */
  repeated: boolean;
  /** The declared slots the part renders: content placed in them is inside it. */
  slots: Set<string>;
}

const NOTHING: PartReach = { props: new Set(), itemFields: new Map(), nodes: new Set(), repeated: false, slots: new Set() };

export function partReach(def: ComponentDefinition, regionNodeId: string): PartReach {
  const tree = def.tree;
  const nodes = new Set(tree && Object.hasOwn(tree.nodes, regionNodeId) ? subtreeIds(tree, regionNodeId) : []);
  // Whether every use of a property, or of an item field of a list, is inside the part.
  const only = new Map<string, boolean>();
  const fields = new Map<string, Map<string, boolean>>();
  /** A node's ancestors in the definition, nearest first. */
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    let at = tree ? findParent(tree, id)?.parentId : null;
    // Never longer than the tree, however deep it nests.
    for (let guard = 0; at && tree && guard <= Object.keys(tree.nodes).length; guard++) {
      out.push(at);
      at = findParent(tree, at)?.parentId;
    }
    return out;
  };
  // A list repeated inside another repeat shows the same items in every outer item: one of its items is not one place.
  const insideAnotherRepeat = (id: string) => [id, ...ancestors(id)].filter((a) => tree?.nodes[a]?.kind === 'repeat').length > 1;
  const around = new Set(nodes.size ? ancestors(regionNodeId) : []);
  /** Where each property is used, by node: a list's items change wherever the list is used, not only where it repeats. */
  const propSites = new Map<string, string[]>();
  for (const site of bindingSites(def)) {
    const inside = nodes.has(site.node.id);
    if ('$prop' in site.binding) {
      only.set(site.binding.$prop, (only.get(site.binding.$prop) ?? true) && inside);
      propSites.set(site.binding.$prop, [...(propSites.get(site.binding.$prop) ?? []), site.node.id]);
      continue;
    }
    const list = enclosingRepeatProp(def, site.node.id);
    if (!list) continue;
    const uses = fields.get(list) ?? new Map<string, boolean>();
    uses.set(site.binding.$item, (uses.get(site.binding.$item) ?? true) && inside && !insideAnotherRepeat(site.node.id));
    fields.set(list, uses);
  }
  const itemFields = new Map<string, Set<string>>();
  for (const [list, uses] of fields) {
    // An item of a list also passed on or shown elsewhere (another component given the same list) changes there too.
    if ((propSites.get(list) ?? []).some((id) => !nodes.has(id) && !(around.has(id) && tree?.nodes[id]?.kind === 'repeat'))) continue;
    const own = new Set([...uses].filter(([, inside]) => inside).map(([f]) => f));
    // A visible text that carries its link along when it changes (an email and its mailto) is inside only with the link.
    for (const { text, link } of itemLinkPairs(def, list)) if (own.has(text) && !own.has(link)) own.delete(text);
    // A page card's link also decides the title, text and picture its empty fields show from the linked page.
    const schema = def.properties[list];
    const teaser = schema?.type === 'list' ? schema.pageTeaser : undefined;
    if (teaser && own.has(teaser.link) && [teaser.title, teaser.description, teaser.image].some((f) => f && uses.has(f) && !own.has(f))) own.delete(teaser.link);
    if (own.size) itemFields.set(list, own);
  }
  // A slot placeholder shown twice (in a duplicated container, say) shows its content in both: only one inside is the part's.
  const placeholders = (name: string) => Object.values(tree?.nodes ?? {}).filter((n) => n.kind === 'slot' && n.slot === name).map((n) => n.id);
  const slots = new Set<string>();
  for (const id of nodes) {
    const n = tree!.nodes[id];
    if (n?.kind === 'slot' && placeholders(n.slot).every((p) => nodes.has(p))) slots.add(n.slot);
  }
  return { props: new Set([...only].filter(([, inside]) => inside).map(([p]) => p)), itemFields, nodes, repeated: nodes.size > 0 && !!enclosingRepeatProp(def, regionNodeId), slots };
}

/**
 * The placement a part authority is in, its definition and what the part reaches, or null for the whole placement (its
 * definition's root). A part inside a nested component, or of a code component (which has no tree to say what its parts
 * show), reaches nothing but its own styles: anything more needs the user's approval.
 */
function selectedPart(state: ProjectState, authority: Extract<Authority, { kind: 'selection' }>): { def: ComponentDefinition; inst: InstanceNode; reach: PartReach; part: PartAuthority } | null {
  const part = authority.part;
  if (!part) return null;
  let inst: GraphNode | undefined;
  try {
    inst = getTree(state, authority.owner).nodes[authority.nodeId];
  } catch {
    return null;
  }
  const def = inst?.kind === 'instance' ? state.components[inst.definitionId] : undefined;
  if (!def || inst?.kind !== 'instance') return null;
  // A code component's root part is the placement itself.
  if (!part.nested && !def.tree && part.partId === 'root') return null;
  if (part.nested || !def.tree) return { def, inst, reach: NOTHING, part };
  // Only the first top-level node is the placement itself; another is a part like any other.
  if (def.tree.rootIds[0] === part.regionNodeId) return null;
  return { def, inst, reach: partReach(def, part.regionNodeId), part };
}

/** Why an operation on the placement itself reaches beyond its selected part, or null when it stays inside. */
function outsidePart(op: EditOperation, sel: NonNullable<ReturnType<typeof selectedPart>>, label: string): string | null {
  const { def, reach, part } = sel;
  const beyond = `${op.type} changes more of ${label} than the selected part.`;
  if (part.nested) return `${op.type} changes more than the selected part, which is inside another component placed in ${label}.`;
  // A placement property shown in a repeated part shows in every item, not only the selected one.
  const whole = (prop: string) => reach.props.has(prop) && !(part.itemId !== undefined && reach.repeated);
  switch (op.type) {
    case 'node.setStyle':
    case 'node.resetStyles': {
      const partId = op.partId ?? 'root';
      const own = Object.hasOwn(def.parts, partId) ? def.parts[partId] : undefined;
      if (partId !== part.partId && !(own && reach.nodes.has(own.nodeId))) return `${op.type} styles a part of ${label} other than the selected one.`;
      // With one item selected, a part shown for every item is styled for that item alone: its shared style is every item's.
      const shownPerItem = !!own && !!def.tree && !!enclosingRepeatProp(def, own.nodeId);
      if (part.itemId !== undefined && shownPerItem) {
        if (!repeatedPartList(def, partId)) return `${op.type} would style every item of ${label}: this part cannot be styled for one item alone, so ask the user first.`;
        if (op.itemId !== part.itemId) return `${op.type} styles ${op.itemId === undefined ? 'every item' : 'another item'} of ${label}, not only the selected one: pass itemId "${part.itemId}", or ask the user before styling more.`;
      }
      return null;
    }
    case 'instance.setProp': {
      // The engine treats an empty item ID as none: the whole list.
      if (!op.itemId) return whole(op.prop) ? null : beyond;
      if (whole(op.prop)) return null;
      const fields = reach.itemFields.get(op.prop);
      if (!fields) return beyond;
      if (part.itemId !== undefined && op.itemId !== part.itemId) return `${op.type} changes an item of ${label} other than the selected one.`;
      const sent = op.field ? [op.field] : op.value && typeof op.value === 'object' && !Array.isArray(op.value) ? Object.keys(op.value) : [];
      return sent.every((f) => fields.has(f)) ? null : `${op.type} changes fields of the item that the selected part does not show.`;
    }
    case 'instance.listInsert':
    case 'instance.listRemove':
    case 'instance.listMove':
    case 'instance.editTable':
      return whole(op.prop) ? null : beyond;
    default:
      return beyond;
  }
}

/** Content placed in the slots a selected part renders, in the owner's tree: it is inside the part. */
function slotContent(state: ProjectState, owner: OwnerRef, sel: NonNullable<ReturnType<typeof selectedPart>>): Set<string> {
  const out = new Set<string>();
  // A slot inside a repeated part shows the same content in every item: not one selected item's.
  if (!sel.reach.slots.size || (sel.part.itemId !== undefined && sel.reach.repeated)) return out;
  const tree = getTree(state, owner);
  for (const name of sel.reach.slots) for (const child of sel.inst.slots?.[name] ?? []) for (const id of subtreeIds(tree, child)) out.add(id);
  return out;
}

/** Whether a destination is inside a selected part: content in a slot it renders, or that slot of the placement itself. */
function inPartSlot(parentId: string | null | undefined, slot: string | undefined, sel: NonNullable<ReturnType<typeof selectedPart>>, placed: Set<string>): boolean {
  // A slot inside a repeated part shows the same content in every item: not one selected item's.
  if (!parentId || (sel.part.itemId !== undefined && sel.reach.repeated)) return false;
  if (parentId === sel.inst.id) return slot !== undefined && sel.reach.slots.has(slot);
  return placed.has(parentId);
}

/** Content fields the engine writes to a property's default when they are bound in a definition (see nodeSetContent). */
const BOUND_FIELDS = new Set(['text', 'image', 'link', 'label', 'icon', 'iconPosition', 'action', 'ariaLabel', 'tag']);

/** Whether an edit inside a definition writes a property's default, which every placement without its own value shows. */
function writesDefault(state: ProjectState, op: EditOperation): string | null {
  if (op.type !== 'node.setContent' || op.owner.kind !== 'component' || !BOUND_FIELDS.has(op.field)) return null;
  let node: GraphNode | undefined;
  try {
    node = getTree(state, op.owner).nodes[op.nodeId];
  } catch {
    return null;
  }
  const current = node ? (node as unknown as Record<string, unknown>)[op.field] : undefined;
  return isBinding(current) && '$prop' in current ? `node.setContent changes the default of the "${current.$prop}" property, which every placement of this component without its own value shows.` : null;
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

/**
 * Returns null when every operation stays within the authority, otherwise a reason. Within a selection, each operation
 * is checked against the project as the operations before it leave it, so a batch cannot bind a field and then write
 * the default it bound.
 */
export function checkAuthority(state: ProjectState, ops: EditOperation[], authority: Authority): string | null {
  if (authority.kind === 'site') return null;
  if (authority.kind === 'component') return checkComponentAuthority(state, ops, authority);
  return walkOperations(state, ops, (draft, op) => checkOne(draft, op, authority));
}

function checkOne(state: ProjectState, op: EditOperation, authority: Extract<Authority, { kind: 'selection' }>): string | null {
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
  const part = selectedPart(state, authority);
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
      if (part) {
        if (o.nodeId === authority.nodeId) return outsidePart(op, part, authority.label);
        // Content placed in a slot the part renders is inside it, and may move only within such content.
        const placed = slotContent(state, authority.owner, part);
        if (!placed.has(o.nodeId)) return `${op.type} changes content of ${authority.label} outside the selected part.`;
        if (op.type === 'node.move' && !inPartSlot(o.parentId, (op as { slot?: string }).slot, part, placed)) return `node.move would move content outside the selected part of ${authority.label}.`;
      }
      return writesDefault(state, op);
    }
    case 'insert': {
      const o = op as Extract<EditOperation, { type: 'node.insert' }>;
      if (!sameOwner(o.owner) || !o.parentId || !allowed.has(o.parentId)) return `node.insert adds content outside ${authority.label}.`;
      if (part && !inPartSlot(o.parentId, o.slot, part, slotContent(state, authority.owner, part))) return `node.insert adds content outside the selected part of ${authority.label}.`;
      return null;
    }
    case 'copy': {
      // The source is only read, so it may be anywhere; the copy must land inside the selection.
      const o = op as Extract<EditOperation, { type: 'node.copy' }>;
      if (!sameOwner(o.toOwner) || !o.parentId || !allowed.has(o.parentId)) return `node.copy adds content outside ${authority.label}.`;
      if (part && !inPartSlot(o.parentId, (o as { slot?: string }).slot, part, slotContent(state, authority.owner, part))) return `node.copy adds content outside the selected part of ${authority.label}.`;
      return null;
    }
    case 'definition':
      // The selected part's component contract is shown in every placement: more than the part.
      if (part) return `${op.type} changes the contract of the component the selected part is in, which is more than the part.`;
      return definitionOpAllowed(state, op, authority, allowed) ? null : `${op.type} changes more than ${authority.label}.`;
    default:
      return `${op.type} changes more than ${authority.label}.`;
  }
}

export const WIDEN_YES = 'Yes, allow changes beyond the selection';
export const WIDEN_NO = 'No, only change the selection';

/** The two answers to a request for more than the authority allows: the first allows it. */
export function widenChoices(authority: Authority): [string, string] {
  if (authority.kind === 'component') return [`Yes, allow changes beyond ${authority.label}`, `No, only change ${authority.label}`];
  return [WIDEN_YES, WIDEN_NO];
}
