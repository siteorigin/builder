/**
 * Repeat as list… (#369): one static container of a managed component's design (a card, a step, a team member)
 * becomes the item of a new list property, in one change and so one Undo. Its text, rich text, images, icons and links
 * become the list's item fields, its current content the first of the starter items, and the container itself the
 * one child of a new repeat over the list, where it was. Every helper plans operations; the engine checks them.
 */
import type { ComponentDefinition, ElementRef, GraphNode, ListItem, NodeTree, ProjectState } from '@shared/types';
import { isBinding, isStateRef } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { newId } from '@shared/ids';
import { ICONS } from '@shared/icons';
import { childLists, findParent, instancesOf, settledRoot } from '@engine/tree';
import { slotDecl } from '@engine/slots';
import { applyOperations } from '@engine/apply';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { isCardLink } from '@generator/card-links';
import { designContent, type ContentField } from './design-content';
import { MAX_PROPERTIES, freeName, newPropSchema, nodeWord, takenPropNames, validPropName } from './component-contract';
import { toCodeName } from './prop-schema';
import { treeFor } from './model';

/** How many items a new list starts with: the container as it is, and copies of it to show it repeats. */
export const STARTER_ITEMS = 3;
/** The most fields a list item can have (see fieldSchemas). */
const MAX_FIELDS = 20;

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** One content value of the container that becomes an item field. */
export interface RepeatField {
  nodeId: string;
  field: ContentField;
  /** The item field's name: title, description, image, icon, link or label, numbered from the second of a kind. */
  name: string;
  label: string;
  schema: Record<string, unknown>;
}

export interface RepeatPlan {
  prop: string;
  label: string;
  itemLabel: string;
  fields: RepeatField[];
  /** Content that stays the same in every item: bound to one of the component's properties, or kept in the design. */
  shared: number;
  items: ListItem[];
  repeatId: string;
  operations: EditOperation[];
}

const LABELS: Record<string, string> = { title: 'Title', description: 'Description', image: 'Image', icon: 'Icon', link: 'Link', label: 'Label' };

const isHeading = (tag: unknown) => typeof tag === 'string' && /^h[1-6]$/.test(tag);

/** A plain text whose tag is a heading, or a choice of headings only, gives an item its title. */
function headingText(def: ComponentDefinition, node: GraphNode): boolean {
  if (node.kind !== 'text' || node.rich) return false;
  if (!isBinding(node.tag)) return isHeading(node.tag);
  const schema = '$prop' in node.tag ? own(def.properties, node.tag.$prop) : undefined;
  const options = schema?.type === 'enum' ? schema.options : [];
  return options.length > 0 && options.every((o) => isHeading(o.value));
}

function baseName(def: ComponentDefinition, node: GraphNode, field: ContentField): string {
  if (field === 'text') return headingText(def, node) ? 'title' : 'description';
  return field;
}

/** A condition, or one compared, that reads the component's UI state. */
const readsStateRef = (c: unknown) => isStateRef(c) || (!!c && typeof c === 'object' && isStateRef((c as { ref?: unknown }).ref));

/**
 * Whether a node takes part in what the component's UI state shows (a tab, a panel, a button that opens something):
 * the generator recognises those only where they render once per placement, never in a list. A nested component's
 * look chosen by the state reads it the same way in every item, so it repeats.
 */
function readsState(n: GraphNode): boolean {
  if (readsStateRef(n.when) || readsStateRef(n.unless)) return true;
  return n.kind === 'link' && !!n.stateAction;
}

/**
 * Whether a component's design, or one placed in it, carries an anchor of its own: every copy would share it. `known`
 * holds the answers worked out so far, so each design is read once.
 */
function designAnchored(state: ProjectState, defId: string, known: Map<string, boolean>): boolean {
  const had = known.get(defId);
  if (had !== undefined) return had;
  // Until it is answered, a design that (through a hand-edited loop) places itself adds nothing.
  known.set(defId, false);
  const def = own(state.components, defId);
  const anchored = Object.values(def?.tree?.nodes ?? {}).some((n) => n.anchor !== undefined || (n.kind === 'instance' && designAnchored(state, n.definitionId, known)));
  known.set(defId, anchored);
  return anchored;
}

/** The elements around a node, nearest first, each once (a tree damaged by hand can list one under itself). */
function ancestors(tree: NodeTree, nodeId: string): Array<{ node: GraphNode; slot?: string }> {
  const out: Array<{ node: GraphNode; slot?: string }> = [];
  const seen = new Set<string>([nodeId]);
  for (let at = findParent(tree, nodeId); at?.parentId && !seen.has(at.parentId); at = findParent(tree, at.parentId)) {
    seen.add(at.parentId);
    const n = own(tree.nodes, at.parentId);
    if (n) out.push({ node: n, slot: at.slot });
  }
  return out;
}

/**
 * Where a node of a tree is shown: inside a card that links somewhere (one of the elements around it is, or it is
 * content of a nested component's slot that the nested design shows inside one), elsewhere, or nowhere (content of a
 * slot the nested design doesn't show).
 */
function cardPlace(state: ProjectState, tree: NodeTree, nodeId: string, seen = new Set<string>()): 'card' | 'shown' | 'unshown' {
  for (const { node, slot } of ancestors(tree, nodeId)) {
    if (isCardLink(node)) return 'card';
    if (node.kind !== 'instance' || slot === undefined) continue;
    const inner = own(state.components, node.definitionId)?.tree;
    const shownBy = Object.values(inner?.nodes ?? {}).filter((n) => n.kind === 'slot' && n.slot === slot);
    if (!shownBy.length) return 'unshown';
    if (seen.has(node.definitionId)) continue;
    seen.add(node.definitionId);
    if (shownBy.some((n) => cardPlace(state, inner!, n.id, seen) === 'card')) return 'card';
  }
  return 'shown';
}

/** Whether a component's design is shown inside a card that links somewhere, wherever it is placed and shown. */
function placedInCard(state: ProjectState, defId: string, seen = new Set<string>()): boolean {
  if (seen.has(defId)) return false;
  seen.add(defId);
  return instancesOf(state, defId).some(({ owner, node }) => {
    const tree = treeFor(state, owner);
    const place = tree ? cardPlace(state, tree, node.id) : 'shown';
    // A placement in a slot its component never shows is shown nowhere, wherever that component is placed.
    return place === 'card' || (place === 'shown' && owner.kind === 'component' && placedInCard(state, owner.id, seen));
  });
}

/**
 * Why a node of a design can't be repeated as a list, or null when it can: a container below the design's root, in a
 * project component built in the editor, not in or around another list, holding nothing every item would have to
 * share (a slot's content, an anchor, a dialog, the tabs and panels the component's UI state shows), not holding the
 * image a container around it opens, and with at least one text, image, icon or link of its own.
 */
export function repeatAsListProblem(state: ProjectState, def: ComponentDefinition, nodeId: string): string | null {
  if (def.owner !== 'project' || def.kind !== 'managed' || !def.tree) return `“${def.name}” isn’t built in the editor, so it can’t repeat elements as a list.`;
  const tree = def.tree;
  if (!settledRoot(tree)) return `“${def.name}” has no single top element yet.`;
  const node = own(tree.nodes, nodeId);
  if (!node || node.kind !== 'element') return 'Pick a container (a Stack, Row, Grid or Container) to repeat.';
  if (tree.rootIds[0] === nodeId) return 'This is the whole component. Pick a container inside it to repeat.';
  const at = findParent(tree, nodeId);
  if (!at?.parentId) return 'This container isn’t inside the component.';
  const name = `“${node.name?.trim() || nodeWord(node)}”`;
  const around = ancestors(tree, nodeId).map((a) => a.node);
  if (around.some((a) => a.kind === 'repeat')) return `${name} is already repeated by a list.`;
  const sub = subtree(def, nodeId);
  const anchors = new Map<string, boolean>();
  for (const n of sub) {
    if (n.kind === 'repeat') return `${name} holds a list of its own.`;
    if (n.kind === 'slot') return `${name} shows a slot’s content, which every item would repeat.`;
    if (n.anchor !== undefined || (n.kind === 'instance' && designAnchored(state, n.definitionId, anchors))) return `${name} holds an anchor, which every item would share. Remove the anchor first.`;
    if (Object.hasOwn(n, 'overlay') && (n as { overlay?: unknown }).overlay !== undefined) return `${name} holds a dialog or drawer, which every item would share.`;
    if (readsState(n)) return `${name} holds tabs, panels or buttons that change what the component shows, which only work outside a list.`;
  }
  // A container that opens its image full size finds it among its own elements (not in a nested component's slot), never
  // inside a list: only the elements around the card up to the first nested component's slot can be looking for it.
  const edge = around.findIndex((a) => a.kind !== 'element');
  const elementsAround = edge < 0 ? around : around.slice(0, edge);
  const viewer = holdsImage(tree, nodeId) ? elementsAround.find((a) => a.kind === 'element' && (a.action === 'image' || isBinding(a.action))) : undefined;
  if (viewer) return `${name} holds the image that “${viewer.name?.trim() || nodeWord(viewer)}” opens full size, which it can’t find inside a list.`;
  const parent = own(tree.nodes, at.parentId);
  // A group that hides when empty would test whether the list has items instead of the container's own conditions.
  if (parent?.kind === 'element' && parent.collapseEmpty && (node.when || node.unless || node.collapseEmpty)) return `${name} hides by its own conditions inside a group that hides when empty, so it can’t be repeated there.`;
  if (parent?.kind === 'instance' && at.slot !== undefined) {
    const decl = slotDecl(state, parent, at.slot);
    if (decl?.max !== undefined) return `${name} is in the “${decl.label}” slot, which holds at most ${decl.max === 1 ? 'one item' : `${decl.max} items`}.`;
  }
  if (Object.keys(def.properties).length >= MAX_PROPERTIES) return `“${def.name}” already has ${MAX_PROPERTIES} properties, the most a component can have.`;
  const { fields } = itemFields(state, def, nodeId);
  if (!fields.length) return `${name} has no text, images, icons or links of its own to repeat.`;
  if (fields.length > MAX_FIELDS) return `${name} holds ${fields.length} texts, images, icons and links; a list item can have at most ${MAX_FIELDS}.`;
  return null;
}

/** Whether an image is among a container's own elements, the way a container that opens its image looks for one. */
function holdsImage(tree: NodeTree, nodeId: string, seen = new Set<string>()): boolean {
  const n = own(tree.nodes, nodeId);
  if (!n || seen.has(nodeId)) return false;
  seen.add(nodeId);
  if (n.kind === 'image') return true;
  return n.kind === 'element' && n.children.some((c) => holdsImage(tree, c, seen));
}

/** The node and everything below it in the design, the content placed in nested components' slots included. */
function subtree(def: ComponentDefinition, nodeId: string): GraphNode[] {
  const out: GraphNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    const n = own(def.tree!.nodes, id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    out.push(n);
    for (const cl of childLists(n)) cl.ids.forEach(walk);
  };
  walk(nodeId);
  return out;
}

/**
 * The content fixed in the container that becomes item fields, in the order the design shows it, and how many values
 * stay the same in every item (a property fills them in, or items can't hold them). A nested component keeps what it is given: only this design's own
 * elements are read, not the content placed in its slots.
 */
function itemFields(state: ProjectState, def: ComponentDefinition, nodeId: string): { fields: RepeatField[]; shared: number } {
  const fields: RepeatField[] = [];
  const counts = new Map<string, number>();
  let shared = 0;
  const seen = new Set<string>();
  // Rich text bound to an item can hold links, which can't sit inside a card that links somewhere: inside one (in this
  // design, in a nested design's slot, or around a placement of this one), it stays in the design. Worked out only
  // when the container holds rich text, since it reads every placement.
  let card: boolean | undefined;
  const inCard = () => (card ??= cardPlace(state, def.tree!, nodeId) === 'card' || placedInCard(state, def.id));
  const walk = (id: string, linkedAbove: boolean) => {
    const node = own(def.tree!.nodes, id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const linked = linkedAbove || isCardLink(node);
    for (const c of designContent(def, node)) {
      if (c.source === 'default') shared++;
      if (c.source !== 'design') continue;
      // What items can't hold stays in the design, the same in every item: an icon from before the icon set (or none
      // on a button), rich text in a linking card, and a container's link that goes nowhere (bound, it would make the
      // container a card, and what is inside it would be a link in a link).
      const fixed =
        (c.field === 'icon' && !(typeof c.value === 'string' && Object.hasOwn(ICONS, c.value))) ||
        (c.field === 'text' && node.kind === 'text' && !!node.rich && (linked || inCard())) ||
        (c.field === 'link' && node.kind === 'element' && !isCardLink(node));
      if (fixed) {
        shared++;
        continue;
      }
      const base = baseName(def, node, c.field);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      const name = n === 1 ? base : `${base}${n}`;
      const label = node.kind === 'link' && (c.field === 'label' || c.field === 'link') ? `${nodeWord(node)} ${c.field}` : LABELS[base];
      const numbered = n === 1 ? label : `${label} ${n}`;
      fields.push({ nodeId: node.id, field: c.field, name, label: numbered, schema: newPropSchema(node, c.field, c.value, numbered) });
    }
    if (node.kind === 'element') for (const c of node.children) walk(c, linked);
  };
  walk(nodeId, false);
  return { fields, shared };
}

/** "Cards" for a container named Card, else "Items". */
function defaultLabel(node: GraphNode): string {
  const name = node.name?.trim();
  if (!name) return 'Items';
  return /s$/i.test(name) ? name : `${name}s`;
}

/**
 * The change that repeats a container as a list, or why it can't: the list property with its fields and starter items
 * (the container's own content, then copies of it), a repeat over it where the container was, the container moved
 * into it, and each of its content values bound to its item field. `label` names the list; `repeatId` and `itemIds`
 * fix the new IDs, for a change planned twice to come out the same.
 */
export function planRepeatAsList(state: ProjectState, def: ComponentDefinition, nodeId: string, opts: { label?: string; repeatId?: string; itemIds?: string[] } = {}): RepeatPlan | { problem: string } {
  const problem = repeatAsListProblem(state, def, nodeId);
  if (problem) return { problem };
  const tree = def.tree!;
  const node = tree.nodes[nodeId];
  const at = findParent(tree, nodeId)!;
  const { fields, shared } = itemFields(state, def, nodeId);
  const label = (opts.label?.trim() || defaultLabel(node)).slice(0, 80);
  const prop = freeName(toCodeName(label) ?? 'items', takenPropNames(state, def), validPropName);
  const itemLabel = (node.name?.trim() || 'Item').slice(0, 40);
  const first = Object.fromEntries(fields.map((f) => [f.name, structuredClone(f.schema.default)]));
  const ids = Array.from({ length: STARTER_ITEMS }, (_, i) => opts.itemIds?.[i] ?? newId('i'));
  const items: ListItem[] = ids.map((id) => ({ id, ...structuredClone(first) }));
  const titleField = (fields.find((f) => f.name === 'title') ?? fields.find((f) => f.name === 'label') ?? fields.find((f) => f.schema.type === 'string'))?.name;
  const schema = {
    type: 'list',
    label,
    itemLabel,
    ...(titleField ? { titleField } : {}),
    fields: Object.fromEntries(fields.map((f) => [f.name, f.schema])),
    default: items
  };
  const repeatId = opts.repeatId ?? newId('n');
  const owner = { kind: 'component' as const, id: def.id };
  const operations: EditOperation[] = [
    { type: 'component.setPropSchema', definitionId: def.id, prop, schema },
    { type: 'node.insert', owner, newNodeId: repeatId, parentId: at.parentId, ...(at.slot !== undefined ? { slot: at.slot } : {}), index: at.index, primitive: 'repeat', bind: prop },
    { type: 'node.move', owner, nodeId, parentId: repeatId, index: 0 },
    ...fields.map((f): EditOperation => ({ type: 'node.setBinding', owner, nodeId: f.nodeId, field: f.field, binding: { $item: f.name } }))
  ];
  return { prop, label, itemLabel, fields, shared, items, repeatId, operations };
}

/**
 * Why a planned change would be refused, or null when it lands: the operations tried on a copy of the project, and
 * the problems that would stop it from saving that it doesn't have now (content an item field can't hold, such as
 * text longer than a field takes, or a placement that shows the design somewhere items can't go). The same check the
 * project makes when the change is applied, so the dialog can say why before the author confirms.
 */
export function repeatAsListPreflight(state: ProjectState, plan: RepeatPlan): string | null {
  let next: ProjectState;
  try {
    next = applyOperations(state, plan.operations).state;
  } catch (e) {
    return (e as Error).message.replace(/^Operation \d+ \([^)]*\): /, '');
  }
  try {
    const saving = (st: ProjectState) => validateState(st, { sectionLinks: false }).filter(blocksSaving);
    const introduced = introducedDiagnostics(saving(state), saving(next));
    return introduced.length ? introduced.map((d) => d.message).join(' ') : null;
  } catch {
    // A project these checks can't read is the project's own to refuse when the change is applied.
    return null;
  }
}

/**
 * What Repeat as list… acts on, if anything: a container of a project component's design, reached as the design's own
 * node (Edit everywhere and Component Studio name it so), while the project can be edited. Canvas, Layers and the
 * inspector all ask this, so the command is offered on the same things everywhere.
 */
export function repeatAsListTarget(snap: { state: ProjectState; readOnly?: unknown } | null | undefined, ref: ElementRef | null): ElementRef | null {
  if (!snap || !ref || snap.readOnly || ref.owner.kind !== 'component' || ref.instancePath.length) return null;
  const def = own(snap.state.components, ref.owner.id);
  if (!def || repeatAsListProblem(snap.state, def, ref.nodeId)) return null;
  return { owner: ref.owner, instancePath: [], nodeId: ref.nodeId };
}
