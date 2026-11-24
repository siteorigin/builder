/**
 * `component.upsert`: a managed project component created, or rebuilt, from one description of its properties, its
 * design, its parts, slots and variants. The design names its nodes by IDs of its own, so nodes refer to each other
 * before any of them exists, and a rebuild that names a node again keeps it. The whole description is checked as the
 * finished component before anything changes; a rebuild then moves every placement to the new contract with the same
 * code the single-step edits use, and refuses (leaving everything as it was) where a placement holds what the new
 * contract can no longer take.
 */
import type { ComponentDefinition, ElementNode, GraphNode, LinkNode, LinkValue, NodeTree, PartDef, ProjectState, SlotDef, StyleValue, TextNode, VariantAxis } from '@shared/types';
import { ELEMENT_ACTIONS, ICON_POSITIONS, SCHEMA_VERSION, isAppearPreset, isBinding, isStateRef, parseStyleScopeKey } from '@shared/types';
import type { Op } from '@shared/ops';
import { STYLE_PROP_MAP, styleSetFor } from '@shared/styles';
import { slugify } from '@shared/routes';
import { isArticleDate } from '@shared/articles';
import { repeatedPartList } from '@shared/item-styles';
import { PROJECT_DEFINITION_ID, projectDefinitionId } from '@shared/component-ids';
import { isCarouselTrack } from '@generator/card-links';
import { EngineError, RESERVED_ANCHORS, enclosingRepeatProp, fail, instancesOf } from './tree';
import { clone } from './install';
import { normalizeImage, normalizeLink, normalizeRichText } from './values';
import { tagKindProblem } from './semantic-tags';
import { slotDeclProblem } from './slots';
import { acceptedTypes, bindingProblem, bindingSites, boundSchema, enclosingList, isProtoKey, normalizeProperties, stateUsers, type BindingSite } from './schema';
import { dropPartOverrides, removeSlot, removeVariant, replaceProperties, setSlot } from './definitions';
import { hiddenSlotContent } from './theme-updates';

type OpResult = Record<string, unknown>;
type UpsertOp = Op<'component.upsert'>;
type DesignNode = UpsertOp['nodes'][number];

/** What the operation borrows from apply.ts: node.setStyle, which checks and settles one style rule, a variant's too. */
export interface UpsertHelpers {
  setStyle: (state: ProjectState, op: Op<'node.setStyle'>) => void;
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
/** Part, slot and axis names, as the single-step edits take them. */
const NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const OPTION_RE = /^[a-z][a-z0-9-]{0,39}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const ANCHOR_RE = /^[A-Za-z][\w-]{0,60}$/;
const APPEARANCES = ['primary', 'secondary', 'text', 'light', 'link', 'plain'];
const quoted = (s: string) => `"${s}"`;

export function componentUpsert(state: ProjectState, op: UpsertOp, helpers: UpsertHelpers): OpResult {
  if (op.definitionId !== undefined && op.newDefinitionId !== undefined) fail('Give definitionId to rebuild a component, or newDefinitionId to create one, not both.');
  const was = op.definitionId !== undefined ? rebuildTarget(state, op.definitionId) : undefined;
  const name = op.name.trim();
  if (!name) fail('A component needs a name.');
  // Everything is checked as the finished component first, so nothing changes until all of it holds.
  const tree = designTree(state, op.nodes);
  const rootId = tree.rootIds[0];
  const properties = normalizeProperties(op.properties, state);
  const parts = designParts(op, tree, was);
  const slots = designSlots(op, tree);
  const variantAxes = designAxes(op, tree, was);
  const candidate: ComponentDefinition = { ...(was ?? newDefinition(state, op, name)), properties, parts, tree, slots, variantAxes };
  checkBindings(state, candidate, bindingSites(candidate));

  const id = was?.id ?? candidate.id;
  const before = was ? clone(was) : undefined;
  if (was) {
    // Options and slots the new contract leaves out go first, as their own removals would: a placement that chooses an
    // option keeps the default instead, and content in a removed slot, or a component around it that can still choose
    // the option, refuses the rebuild.
    const keptAxes = variantAxes ?? {};
    for (const [axis, a] of Object.entries(was.variantAxes ?? {}))
      for (const option of Object.keys(a.options)) if (!own(own(keptAxes, axis)?.options, option)) removeVariant(state, { type: 'component.removeVariant', definitionId: id, variant: option, axis });
    for (const slot of Object.keys(was.slots ?? {})) if (!own(slots, slot)) removeSlot(state, { type: 'component.removeSlot', definitionId: id, slot });
  } else state.components[id] = { ...candidate, properties: {}, slots: undefined };
  const def = state.components[id];
  Object.assign(def, metadata(op, name));
  if (op.insertAs === null) delete def.insertAs;
  def.tree = tree;
  def.parts = parts;
  if (variantAxes) def.variantAxes = variantAxes;
  else delete def.variantAxes;
  delete def.slots;
  // Every placement's values move to the new schema: kept where they still fit, refused where they no longer do.
  replaceProperties(state, def, op.properties);
  // Each slot is declared as setSlot declares it, which refuses one that no longer takes what a placement put there.
  for (const [slot, d] of Object.entries(slots ?? {}))
    setSlot(state, { type: 'component.setSlot', definitionId: id, slot, label: d.label, description: d.description ?? null, categories: d.categories ?? null, primitives: d.primitives ?? null, max: d.max ?? null });
  // Styles go through node.setStyle, so each rule is checked and stored as one set by hand would be.
  for (const n of op.nodes) if (n.styles) applyStyles(state, id, n.id, n.styles, helpers);
  for (const [axis, a] of Object.entries(op.variantAxes ?? {}))
    for (const [option, o] of Object.entries(a.options)) for (const [nodeId, styles] of Object.entries(o.styles ?? {})) applyStyles(state, id, nodeId, styles, helpers, { variant: option, axis });
  if (before) settlePlacements(state, before, def);
  return { definitionId: id, rootNodeId: rootId };
}

/** The component a rebuild replaces: a managed design of the project's own, in a form the description can say whole. */
function rebuildTarget(state: ProjectState, id: string): ComponentDefinition {
  const def = own(state.components, id) ?? fail(`Component "${id}" does not exist.`);
  if (def.owner !== 'project') throw new EngineError('SCOPE_MISMATCH', `"${def.name}" belongs to the theme. Fork it first with component.fork, then rebuild the returned project definition.`);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is a code component. Change its code with component.updateSource.`);
  if (def.category === 'shell') fail(`"${def.name}" is the site's shared header or footer, which is changed one element at a time.`);
  // What the description cannot say yet would be lost without a word: refused until it can.
  if (Object.values(def.tree.nodes).some((n) => n.kind === 'instance')) fail(`"${def.name}" places other components in its design, which component.upsert cannot describe yet. Change it with the node operations instead.`);
  const reads = Object.keys(def.state ?? {}).filter((s) => stateUsers(def, s).length);
  if (reads.length) fail(`"${def.name}" has UI state its design reads or its buttons change (${reads.join(', ')}), which component.upsert cannot describe yet. Change it with the node operations instead.`);
  return def;
}

/** A new component's identity: the ID the batch named for it, or a fresh one. */
function newDefinition(state: ProjectState, op: UpsertOp, name: string): ComponentDefinition {
  let id = op.newDefinitionId;
  if (id !== undefined) {
    if (!PROJECT_DEFINITION_ID.test(id)) fail(`"${id}" is not a project component ID.`);
    if (Object.hasOwn(state.components, id)) fail(`Component "${id}" already exists.`);
  } else {
    id = projectDefinitionId(name);
    // A random suffix can repeat one already in use: never put the new design in place of an existing one.
    while (Object.hasOwn(state.components, id)) id = projectDefinitionId(name);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    componentId: `project.${slugify(name) || 'component'}`,
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name,
    description: 'Project component.',
    category: 'custom',
    tags: ['custom', 'project'],
    icon: 'component',
    properties: {},
    parts: {},
    provenance: { createdBy: 'user' },
    license: 'Project'
  };
}

/** Name, description and the Insert panel's details: what the description leaves out stays as it was. */
function metadata(op: UpsertOp, name: string): Partial<ComponentDefinition> {
  return {
    name,
    ...(op.description !== undefined ? { description: op.description.trim() || 'Project component.' } : {}),
    ...(op.category !== undefined ? { category: op.category as ComponentDefinition['category'] } : {}),
    ...(op.tags ? { tags: [...new Set(op.tags.map((t) => t.trim()).filter(Boolean))] } : {}),
    ...(op.icon !== undefined ? { icon: op.icon } : {}),
    ...(op.insertAs ? { insertAs: op.insertAs } : {})
  };
}

// ---------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------

/** The described nodes as one tree: each in one place, all inside one root that shows an element of its own. */
function designTree(state: ProjectState, specs: DesignNode[]): NodeTree {
  const byId = new Map<string, DesignNode>();
  for (const s of specs) {
    if (isProtoKey(s.id)) fail(`"${s.id}" cannot be a node ID.`);
    if (byId.has(s.id)) fail(`Two nodes have the ID "${s.id}". Give each node an ID of its own.`);
    byId.set(s.id, s);
  }
  const parentOf = new Map<string, string>();
  for (const s of specs) {
    for (const c of 'children' in s ? (s.children ?? []) : []) {
      if (!byId.has(c)) fail(`"${s.id}" holds "${c}", which is not one of the nodes.`);
      if (parentOf.has(c)) fail(`"${c}" is inside both "${parentOf.get(c)}" and "${s.id}". A node goes in one place.`);
      parentOf.set(c, s.id);
    }
  }
  const roots = specs.filter((s) => !parentOf.has(s.id));
  if (roots.length > 1) fail(`The design has ${roots.length} top-level nodes (${roots.map((r) => quoted(r.id)).join(', ')}). Put them inside one root element, which carries the component.`);
  const root = roots[0] ?? fail('Every node of the design is inside another, so it has no root. Leave the root out of every node\'s children.');
  if (root.kind === 'repeat' || root.kind === 'slot') fail(`The root "${root.id}" is a ${root.kind}, which shows no element of its own to carry the component. Put it inside a container.`);
  // Each node has one parent and the root none, so a node the root never reaches sits inside itself.
  const reached = new Set<string>();
  const stack = [root.id];
  while (stack.length) {
    const id = stack.pop()!;
    reached.add(id);
    const s = byId.get(id)!;
    if ('children' in s) for (const c of s.children ?? []) if (!reached.has(c)) stack.push(c);
  }
  const lost = specs.find((s) => !reached.has(s.id));
  if (lost) fail(`"${lost.id}" is inside itself, through the nodes around it, so it is never shown.`);
  const anchors = new Set<string>();
  const nodes: Record<string, GraphNode> = {};
  for (const s of specs) {
    const n = designNode(state, s);
    if (n.anchor) {
      if (anchors.has(n.anchor)) fail(`Two nodes use the anchor "${n.anchor}".`);
      anchors.add(n.anchor);
    }
    nodes[s.id] = n;
  }
  return { rootIds: [root.id], nodes };
}

/** One described node as the design stores it: literal values checked and settled as the single-step edits settle them. */
function designNode(state: ProjectState, s: DesignNode): GraphNode {
  const label = s.name?.trim() || s.id;
  const refuse = (message: string): never => fail(`${quoted(label)}: ${message}`);
  const base: Partial<GraphNode> = { id: s.id };
  if (s.name?.trim()) base.name = s.name.trim();
  if (s.when !== undefined) base.when = clone(s.when);
  if (s.unless !== undefined) base.unless = clone(s.unless);
  if (s.anchor !== undefined) {
    const a = s.anchor.replace(/^#/, '');
    if (s.kind === 'repeat' || s.kind === 'slot') refuse('anchors can be set on elements, text, images, buttons, icons and dividers.');
    if (a && !ANCHOR_RE.test(a)) refuse('anchors start with a letter and use letters, numbers, - and _.');
    if (RESERVED_ANCHORS.has(a)) refuse(`"${a}" is used by the site itself. Choose another anchor.`);
    if (a) base.anchor = a;
  }
  const text = (v: unknown, max = 200) => (isBinding(v) ? clone(v) : String(v ?? '').trim().slice(0, max));
  const oneOf = (v: unknown, values: readonly string[], what: string) => {
    if (isBinding(v)) return clone(v);
    if (typeof v !== 'string' || !values.includes(v)) refuse(`${what} must be ${values.join(', ')}.`);
    return v as string;
  };
  const link = (v: unknown) => (isBinding(v) ? clone(v) : normalizeLink(v, state, label));
  switch (s.kind) {
    case 'element': {
      const n = { ...base, kind: 'element', tag: 'div', children: [...(s.children ?? [])] } as ElementNode;
      if (s.tag !== undefined) n.tag = tagged(n, s.tag, refuse) as ElementNode['tag'];
      if (s.link !== undefined) {
        const l = link(s.link);
        // A container with no destination is no card.
        if (isBinding(l) || l.type !== 'none') n.link = l;
      }
      if (s.action !== undefined) n.action = oneOf(s.action, ELEMENT_ACTIONS, 'What a click does') as ElementNode['action'];
      if (s.ariaLabel !== undefined && text(s.ariaLabel)) n.ariaLabel = text(s.ariaLabel) as ElementNode['ariaLabel'];
      if (s.collapseEmpty) n.collapseEmpty = true;
      if (s.appear !== undefined && s.appear !== 'none') {
        if (!isAppearPreset(s.appear)) refuse('an entrance is fade, lift, scale-subtle or none.');
        n.appear = s.appear as ElementNode['appear'];
      }
      if (s.carousel) {
        n.carousel = true;
        if (!isCarouselTrack(n)) refuse('only a bulleted list (ul) that is not itself a link can be a carousel.');
      }
      return n;
    }
    case 'text': {
      const rich = s.rich === true;
      const n = { ...base, kind: 'text', tag: rich ? 'div' : 'p', text: '' } as TextNode;
      if (rich) {
        n.rich = true;
        if (s.tag !== undefined && s.tag !== 'div') refuse('rich text keeps its paragraph structure, so it takes no tag.');
        n.text = isBinding(s.text) ? clone(s.text) : normalizeRichText(s.text, state, label);
        if (s.datetime !== undefined) refuse('rich text cannot state a date; only plain text can.');
        return n;
      }
      if (s.tag !== undefined) n.tag = tagged(n, s.tag, refuse) as TextNode['tag'];
      if (!isBinding(s.text) && typeof s.text !== 'string') refuse('plain text is one string. Make it rich text (rich: true) for paragraphs and lists.');
      n.text = isBinding(s.text) ? clone(s.text) : (s.text as string);
      if (s.datetime !== undefined) {
        const d = isBinding(s.datetime) ? s.datetime : s.datetime.trim();
        if (!isBinding(d) && d && !isArticleDate(d)) refuse('a date is written YYYY-MM-DD.');
        if (isBinding(d) || d) n.datetime = isBinding(d) ? clone(d) : d;
      }
      return n;
    }
    case 'image': {
      const n: GraphNode = { ...base, kind: 'image', image: isBinding(s.image) ? clone(s.image) : normalizeImage(s.image, state, label) } as GraphNode;
      if (s.fallbackAlt !== undefined && text(s.fallbackAlt, 300)) (n as { fallbackAlt?: unknown }).fallbackAlt = text(s.fallbackAlt, 300);
      return n;
    }
    case 'link': {
      const n = { ...base, kind: 'link', link: link(s.link) as LinkValue, label: isBinding(s.label) ? clone(s.label) : String(s.label), appearance: s.appearance === undefined ? 'primary' : oneOf(s.appearance, APPEARANCES, 'A button\'s appearance') } as LinkNode;
      if (s.icon !== undefined) {
        if (!isBinding(s.icon) && s.icon.trim() && !ICON_RE.test(s.icon.trim())) refuse(`"${s.icon}" is not an icon name.`);
        if (isBinding(s.icon) || s.icon.trim()) n.icon = isBinding(s.icon) ? clone(s.icon) : s.icon.trim();
      }
      if (s.iconPosition !== undefined) n.iconPosition = oneOf(s.iconPosition, ICON_POSITIONS, 'The icon\'s side') as LinkNode['iconPosition'];
      if (s.ariaLabel !== undefined && text(s.ariaLabel)) n.ariaLabel = text(s.ariaLabel) as LinkNode['ariaLabel'];
      return n;
    }
    case 'icon': {
      if (!isBinding(s.icon) && !ICON_RE.test(s.icon)) refuse(`"${s.icon}" is not an icon name.`);
      const n = { ...base, kind: 'icon', icon: isBinding(s.icon) ? clone(s.icon) : s.icon } as GraphNode;
      if (s.ariaLabel !== undefined && text(s.ariaLabel)) (n as { ariaLabel?: unknown }).ariaLabel = text(s.ariaLabel);
      return n;
    }
    case 'divider':
      return { ...base, kind: 'divider' } as GraphNode;
    case 'repeat':
      return { ...base, kind: 'repeat', list: { $prop: s.list }, children: [...(s.children ?? [])], ...(s.appearStagger ? { appearStagger: true } : {}) } as GraphNode;
    case 'slot':
      return { ...base, kind: 'slot', slot: s.slot } as GraphNode;
  }
}

/** A literal tag of the node's kind, or the choice it is bound to (checked with the other bindings). */
function tagged(node: GraphNode, tag: unknown, refuse: (message: string) => never): unknown {
  if (isBinding(tag)) return clone(tag);
  const problem = tagKindProblem(node, tag);
  if (problem) refuse(problem);
  return tag;
}

/** The parts placements can style: `root` is always the root node, and each other part one element of its own. */
function designParts(op: UpsertOp, tree: NodeTree, was: ComponentDefinition | undefined): Record<string, PartDef> {
  const rootId = tree.rootIds[0];
  const given = Object.entries(op.parts ?? {});
  const root = given.find(([pid]) => pid === 'root')?.[1] ?? { nodeId: rootId, label: own(was?.parts, 'root')?.label ?? 'Root' };
  const out: Record<string, PartDef> = {};
  const byNode = new Map<string, string>();
  for (const [pid, p] of [['root', root] as const, ...given.filter(([pid]) => pid !== 'root')]) {
    const prev = own(was?.parts, pid);
    // A part the component has keeps the name it was saved with; a new one needs a plain name.
    if (isProtoKey(pid) || (!prev && !NAME_RE.test(pid))) fail(`Part IDs must be camelCase identifiers ("${pid}").`);
    if (pid === 'root' && p.nodeId !== rootId) fail(`The root part is always the root node ("${rootId}").`);
    const node = own(tree.nodes, p.nodeId) ?? fail(`The part "${pid}" is "${p.nodeId}", which is not one of the nodes.`);
    if (node.kind === 'slot' || node.kind === 'repeat') fail(`The part "${pid}" is a ${node.kind}, which renders no element of its own. Make the element inside it the part.`);
    if (byNode.has(p.nodeId)) fail(`"${p.nodeId}" is both the "${byNode.get(p.nodeId)}" and the "${pid}" part. Each part is an element of its own.`);
    byNode.set(p.nodeId, pid);
    const label = p.label.trim() || fail(`The part "${pid}" needs a label.`);
    let controls: string[] | undefined;
    if ('styleControls' in p && p.styleControls) {
      const bad = p.styleControls.filter((c) => !Object.hasOwn(STYLE_PROP_MAP, c));
      if (bad.length) fail(`The part "${pid}" offers unknown style properties: ${bad.join(', ')}.`);
      controls = [...new Set(p.styleControls)];
    } else {
      // The controls it offered stay while it is the same element; another element offers what its kind takes.
      const same = prev && prev.nodeId === p.nodeId && own(was?.tree?.nodes, prev.nodeId)?.kind === node.kind;
      controls = same ? prev.styleControls : styleSetFor(node);
    }
    out[pid] = { nodeId: p.nodeId, label, ...(controls ? { styleControls: controls } : {}) };
  }
  return out;
}

/** The slots each placement fills, each shown by exactly one slot node of the design. */
function designSlots(op: UpsertOp, tree: NodeTree): Record<string, SlotDef> | undefined {
  const out: Record<string, SlotDef> = {};
  for (const [slot, d] of Object.entries(op.slots ?? {})) {
    if (isProtoKey(slot) || !NAME_RE.test(slot)) fail(`Slot names must be camelCase identifiers ("${slot}").`);
    const description = d.description?.trim();
    const decl: SlotDef = {
      label: d.label.trim(),
      ...(description ? { description } : {}),
      ...(d.categories ? { categories: [...new Set(d.categories)] as SlotDef['categories'] } : {}),
      ...(d.primitives ? { primitives: [...new Set(d.primitives)] as SlotDef['primitives'] } : {}),
      ...(d.max !== undefined ? { max: d.max } : {})
    };
    const problem = slotDeclProblem(decl);
    if (problem) fail(`The slot "${slot}" ${problem}.`);
    out[slot] = decl;
  }
  const shown = new Map<string, string>();
  for (const n of Object.values(tree.nodes)) {
    if (n.kind !== 'slot') continue;
    if (!Object.hasOwn(out, n.slot)) fail(`"${n.id}" shows the slot "${n.slot}", which the component does not declare.`);
    if (shown.has(n.slot)) fail(`The slot "${n.slot}" is shown by both "${shown.get(n.slot)}" and "${n.id}". Each slot is shown once.`);
    shown.set(n.slot, n.id);
  }
  const unshown = Object.keys(out).find((s) => !shown.has(s));
  if (unshown) fail(`The slot "${unshown}" is declared but no slot node shows it, so content put there would never appear.`);
  return Object.keys(out).length ? out : undefined;
}

/** The variant axes, each with the option placements show until they choose. Style rules are set once the design is in place. */
function designAxes(op: UpsertOp, tree: NodeTree, was: ComponentDefinition | undefined): Record<string, VariantAxis> | undefined {
  const out: Record<string, VariantAxis> = {};
  for (const [axis, a] of Object.entries(op.variantAxes ?? {})) {
    // An axis or option the component has keeps the ID it was saved with; a new one needs a plain ID.
    const prev = own(was?.variantAxes, axis);
    if (isProtoKey(axis) || (!prev && !NAME_RE.test(axis))) fail(`Variant axis names must be camelCase identifiers ("${axis}").`);
    const options: VariantAxis['options'] = {};
    for (const [id, o] of Object.entries(a.options)) {
      if (isProtoKey(id) || (!own(prev?.options, id) && !OPTION_RE.test(id))) fail(`Variant IDs use lowercase letters, numbers and hyphens ("${id}").`);
      for (const nodeId of Object.keys(o.styles ?? {})) if (!Object.hasOwn(tree.nodes, nodeId)) fail(`The ${axis} option "${id}" styles "${nodeId}", which is not one of the nodes.`);
      options[id] = { label: o.label.trim() || fail(`The ${axis} option "${id}" needs a label.`) };
    }
    const fallback = a.default ?? Object.keys(options)[0];
    if (!Object.hasOwn(options, fallback)) fail(`The default of the "${axis}" axis ("${fallback}") is not one of its options.`);
    out[axis] = { label: a.label.trim() || fail(`The "${axis}" axis needs a label.`), default: fallback, options };
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Bindings, styles and placements
// ---------------------------------------------------------------------------

const describeNode = (n: GraphNode) => quoted(n.name ?? n.id);

/**
 * Every binding in `sites` must resolve where it sits, to a property or item field of a type its field takes, as
 * node.setBinding requires one at a time. The design is checked whole, so its repeats and their item fields can be
 * described in any order.
 */
function checkBindings(state: ProjectState, def: ComponentDefinition, sites: BindingSite[], where = '') {
  for (const site of sites) {
    const { node, field, binding: b } = site;
    const at = `${where}${describeNode(node)}`;
    if (isStateRef(b)) fail(`${at} reads UI state, which component.upsert cannot describe yet.`);
    const schema = boundSchema(def, node.id, b);
    if (!schema) {
      if ('$prop' in b) {
        const p = own(def.properties, b.$prop);
        if (!p) fail(`${at} shows "${b.$prop}", which is not one of the component's properties.`);
        fail(p.type === 'object' ? `${at} shows the field "${b.field}" of "${b.$prop}", which has no such field. Fields: ${Object.keys(p.fields).join(', ')}.` : `${at} shows the field "${b.field}" of "${b.$prop}", which is not an object property.`);
      }
      fail(enclosingList(def, node.id) ? `${at} shows the item field "${b.$item}", which the list it repeats does not have.` : `${at} shows the item field "${b.$item}" outside any repeat.`);
    }
    const nested = field === 'prop' && node.kind === 'instance' ? own(state.components[node.definitionId]?.properties, site.prop!) : undefined;
    const ok = acceptedTypes(node, field, nested);
    if (ok && !ok.includes(schema.type)) fail(`${at} cannot show a ${schema.type} as its ${field === 'prop' ? quoted(site.prop!) : field}: it needs a ${ok.join(' or ')}.`);
    if (field === 'list' && '$prop' in b && enclosingRepeatProp(def, node.id) === b.$prop) fail(`${at} repeats "${b.$prop}" inside a repeat of the same list.`);
    const problem = bindingProblem(state, site, schema);
    if (problem) fail(`${at} ${problem}`);
  }
}

/** One node's described styles (plain rules, or rules by size and state), set rule by rule with node.setStyle. */
function applyStyles(state: ProjectState, defId: string, nodeId: string, raw: Record<string, unknown>, helpers: UpsertHelpers, variant?: { variant: string; axis: string }) {
  const at = variant ? `The ${variant.axis} option "${variant.variant}" on "${nodeId}"` : quoted(nodeId);
  const keys = Object.keys(raw);
  const rules = keys.length && keys.every((k) => parseStyleScopeKey(k)) ? raw : { base: raw };
  for (const [key, props] of Object.entries(rules)) {
    const scope = parseStyleScopeKey(key);
    if (!scope) fail(`${at}: "${key}" is neither a screen size (base, phone, tablet, desktop) nor one with a state ("base:hover").`);
    if (!props || typeof props !== 'object' || Array.isArray(props)) fail(`${at}: the rules for "${key}" are not a set of style properties.`);
    for (const [property, value] of Object.entries(props as Record<string, unknown>)) {
      const token = !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { token?: unknown }).token === 'string';
      if (!token && !['string', 'number', 'boolean'].includes(typeof value)) fail(`${at}: "${property}" needs a value or {"token": "..."}.`);
      try {
        helpers.setStyle(state, { type: 'node.setStyle', owner: { kind: 'component', id: defId }, nodeId, scope: scope!.scope, ...(scope!.state ? { state: scope!.state } : {}), property, value: value as StyleValue, ...(variant ?? {}) });
      } catch (e) {
        if (e instanceof EngineError) e.message = `${at}: ${e.message}`;
        throw e;
      }
    }
  }
}

/**
 * What placements hold beyond their values, once a rebuild is in place: style changes to a part the component no
 * longer has go, and single-item styles go where their part no longer repeats over the same list; filled slots the new
 * design would hide refuse the rebuild, and so do components that place this one and pass it what it no longer takes.
 */
function settlePlacements(state: ProjectState, was: ComponentDefinition, def: ComponentDefinition) {
  for (const partId of Object.keys(was.parts)) if (!Object.hasOwn(def.parts, partId)) dropPartOverrides(state, def.id, partId);
  for (const { node, label, owner } of instancesOf(state, def.id)) {
    for (const [partId, entry] of Object.entries(node.itemOverrides ?? {})) {
      if (!entry || typeof entry !== 'object' || typeof entry.list !== 'string') continue;
      if (entry.list !== repeatedPartList(def, partId)) delete node.itemOverrides![partId];
    }
    if (node.itemOverrides && !Object.keys(node.itemOverrides).length) delete node.itemOverrides;
    const hidden = hiddenSlotContent(was, def, node, label);
    if (hidden.length) fail(`${hidden[0]} Move that content out first, or show the slot outside the list.`);
    const around = owner.kind === 'component' ? own(state.components, owner.id) : undefined;
    if (around) checkBindings(state, around, bindingSites(around).filter((s) => s.node === node), `"${around.name}" places "${def.name}" as `);
  }
}
