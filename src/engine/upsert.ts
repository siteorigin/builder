/**
 * `component.upsert`: a managed project component created, or rebuilt, from one description of its properties, its
 * design, its parts, slots and variants. The design names its nodes by IDs of its own, so nodes refer to each other
 * before any of them exists, and a rebuild that names a node again keeps it. The whole description is checked as the
 * finished component before anything changes; a rebuild then moves every placement to the new contract with the same
 * code the single-step edits use, and refuses (leaving everything as it was) where a placement holds what the new
 * contract can no longer take.
 */
import { isBackgroundImageValue } from '@shared/background-image';
import type { Binding, ComponentDefinition, DividerNode, ElementNode, GraphNode, InstanceNode, LinkNode, LinkValue, ListProp, NodeTree, ObjectProp, OverlayMode, PartDef, ProjectState, PropSchema, SlotDef, StateAction, StyleValue, TextNode, UiStateSchema, VariantAxis } from '@shared/types';
import { ELEMENT_ACTIONS, ICON_POSITIONS, SCHEMA_VERSION, isAppearPreset, isBinding, isStateRef, parseStyleScopeKey } from '@shared/types';
import type { Op } from '@shared/ops';
import { STYLE_PROP_MAP, styleSetFor } from '@shared/styles';
import { slugify } from '@shared/routes';
import { isArticleDate } from '@shared/articles';
import { placementItems, repeatedPartList } from '@shared/item-styles';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { findVariant } from '@shared/variants';
import { PROJECT_DEFINITION_ID, projectDefinitionId } from '@shared/component-ids';
import { isCarouselTrack } from '@generator/card-links';
import { ICONS } from '@catalogue/foundation/icons';
import { EngineError, RESERVED_ANCHORS, enclosingRepeatProp, fail, instancesOf } from './tree';
import { clone } from './install';
import { normalizeImage, normalizeLink, normalizeRichText } from './values';
import { tagKindProblem } from './semantic-tags';
import { slotDeclProblem } from './slots';
import {
  MAX_UI_STATES,
  acceptedTypes,
  bindingProblem,
  bindingSites,
  boundSchema,
  checkStateName,
  damagedState,
  enclosingList,
  isProtoKey,
  normalizeProperties,
  normalizeUiState,
  overlayProblem,
  repeatFilterProblem,
  stateActionProblem,
  stateRefProblem,
  stateUsers,
  itemStateProblems,
  type BindingSite
} from './schema';
import { dropPartOverrides, removeSlot, removeVariant, replaceProperties, setSlot } from './definitions';
import { shownSlots } from './theme-updates';

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
const ANCHOR_RE = /^[A-Za-z][\w-]{0,60}$/;
const APPEARANCES = ['primary', 'secondary', 'text', 'light', 'link', 'plain'];
const quoted = (s: string) => `"${s}"`;

export function componentUpsert(state: ProjectState, given: UpsertOp, helpers: UpsertHelpers): OpResult {
  // The project keeps nothing of the caller's own objects.
  const op = clone(given);
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
  // UI state the description gives replaces the component's whole ({} removes it); left out, what a rebuild's
  // component declares stays (checked again against the new properties), unless its design used it: a description
  // that does not say what becomes of working tabs or toggles is refused rather than dropping them unseen.
  const uiState = op.state !== undefined ? designState(op, candidate) : was && keptState(was, candidate);
  if (uiState !== undefined) candidate.state = uiState;
  else delete candidate.state;
  // An item state holds an item of one of the design's own lists, read and selected inside repeats of that list.
  const itemProblem = itemStateProblems(candidate).values().next().value;
  if (itemProblem) throw new EngineError('INVALID_ARGUMENT', itemProblem.message, itemProblem.nodeId ? { owner: { kind: 'component', id: candidate.id }, nodeId: itemProblem.nodeId } : undefined);
  checkBindings(state, candidate, bindingSites(candidate));
  // A filter, a button's state action or a dialog that would not work is refused here, where load validation would
  // only report it.
  for (const n of Object.values(tree.nodes)) {
    const problem = repeatFilterProblem(candidate, n) ?? (n.kind === 'link' && n.stateAction !== undefined ? actionProblem(candidate, n.stateAction, n.id) : null) ?? overlayProblem(candidate, n);
    if (problem) fail(`${describeNode(n)} ${problem}`);
  }

  const id = was?.id ?? candidate.id;
  const before = was ? clone(was) : undefined;
  // The filled slots each placement shows now, worked out before its values move.
  const shownBefore = new Map(was ? instancesOf(state, id).map(({ node }) => [node, shownSlots(was, node)] as const) : []);
  if (was) {
    // Options and slots the new contract leaves out go first, as their own removals would: a placement that chooses an
    // option keeps the default instead, and content in a removed slot, or a component around it that can still choose
    // the option, refuses the rebuild.
    const keptAxes = variantAxes ?? {};
    for (const [axis, a] of Object.entries(was.variantAxes ?? {}))
      for (const option of Object.keys(a.options)) {
        if (own(own(keptAxes, axis)?.options, option)) continue;
        // An option saved under an ID no variant can have is ignored already: only placements that name it forget it.
        if ('error' in findVariant(was, option, axis)) forgetOption(state, id, axis, option);
        else removeVariant(state, { type: 'component.removeVariant', definitionId: id, variant: option, axis });
      }
    // The new design replaces the tree and its parts whole, so nothing of the old one is cleaned up here.
    for (const slot of Object.keys(was.slots ?? {})) if (!own(slots, slot)) removeSlot(state, { type: 'component.removeSlot', definitionId: id, slot }, { designReplaced: true });
    keepFieldContent(state, was, properties);
  } else state.components[id] = { ...candidate, properties: {}, slots: undefined };
  const def = state.components[id];
  Object.assign(def, metadata(op, name));
  if (op.insertAs === null) delete def.insertAs;
  def.tree = tree;
  def.parts = parts;
  if (variantAxes) def.variantAxes = variantAxes;
  else delete def.variantAxes;
  if (uiState !== undefined) def.state = uiState;
  else delete def.state;
  delete def.slots;
  // Every placement's values move to the new schema: kept where they still fit, refused where they no longer do. The
  // design's bindings were checked against it above.
  replaceProperties(state, def, op.properties, [], { bindingsChecked: true });
  // Each slot is declared as setSlot declares it, which refuses one that no longer takes what a placement put there.
  for (const [slot, d] of Object.entries(slots ?? {}))
    setSlot(state, { type: 'component.setSlot', definitionId: id, slot, label: d.label, description: d.description ?? null, categories: d.categories ?? null, componentIds: d.componentIds ?? null, primitives: d.primitives ?? null, max: d.max ?? null });
  // Styles go through node.setStyle, so each rule is checked and stored as one set by hand would be.
  for (const n of op.nodes) if (n.styles) applyStyles(state, id, n.id, n.styles, helpers);
  for (const [axis, a] of Object.entries(op.variantAxes ?? {}))
    for (const [option, o] of Object.entries(a.options)) for (const [nodeId, styles] of Object.entries(o.styles ?? {})) applyStyles(state, id, nodeId, styles, helpers, { variant: option, axis });
  if (before) settlePlacements(state, before, def, shownBefore);
  return { definitionId: id, rootNodeId: rootId };
}

/** Placements that choose an option the component no longer has show the axis's default instead. */
function forgetOption(state: ProjectState, defId: string, axis: string, option: string) {
  for (const { node } of instancesOf(state, defId)) {
    if (node.variants?.[axis] !== option) continue;
    delete node.variants[axis];
    if (!Object.keys(node.variants).length) delete node.variants;
  }
}

/** A field type a value can move to keeping what it says, as a property's own type change allows. */
const LOSSLESS: Record<string, readonly string[]> = { string: ['richtext', 'enum', 'number'], richtext: ['string'], enum: ['string'], number: ['string'] };

/**
 * A list's or an object's field that changes type keeps each placement's value only where the change is lossless (and
 * the value then fits, as normalizing it checks); a value still at the old field's default starts at the new one.
 * Anything else refuses the rebuild, rather than emptying content a placement holds. A field the new schema leaves out
 * goes with its values, as a removed property does.
 */
function keepFieldContent(state: ProjectState, was: ComponentDefinition, next: Record<string, PropSchema>) {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !isBinding(v);
  for (const [name, now] of Object.entries(next)) {
    const prev = own(was.properties, name);
    if (!prev || prev.type !== now.type || (now.type !== 'list' && now.type !== 'object') || (now.type === 'list' && (now.feed || (prev as ListProp).feed))) continue;
    const prevFields = (prev as ListProp | ObjectProp).fields;
    for (const [field, schema] of Object.entries(now.fields)) {
      const old = own(prevFields, field);
      if (!old || old.type === schema.type) continue;
      // What a placement starts with: an object's own default for the field, or what a new list item gets.
      const objectDefault = prev.type === 'object' ? (prev.default as Record<string, unknown> | undefined) : undefined;
      const start = JSON.stringify(objectDefault && Object.hasOwn(objectDefault, field) ? objectDefault[field] : old.default);
      for (const { node, label } of instancesOf(state, was.id)) {
        const v = own(node.props, name);
        const holders = now.type === 'list' ? (Array.isArray(v) ? v.filter(record) : []) : record(v) ? [v] : [];
        for (const holder of holders) {
          if (!Object.hasOwn(holder, field) || isBinding(holder[field])) continue;
          if (JSON.stringify(holder[field]) === start) holder[field] = clone(schema.default);
          else if (!LOSSLESS[old.type]?.includes(schema.type))
            fail(`${label}: "${old.label}" in "${prev.label}" holds content that a ${schema.type} field cannot keep. Give the new field a name of its own to start it over.`);
          else if (old.type === 'richtext') holder[field] = richTextToPlain(toRichText(holder[field]));
        }
      }
    }
  }
}

/** The component a rebuild replaces: a managed design of the project's own, in a form the description can say whole. */
function rebuildTarget(state: ProjectState, id: string): ComponentDefinition {
  const def = own(state.components, id) ?? fail(`Component "${id}" does not exist.`);
  if (def.owner !== 'project') throw new EngineError('SCOPE_MISMATCH', `"${def.name}" belongs to the theme. Fork it first with component.fork, then rebuild the returned project definition.`);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is a code component. Change its code with component.updateSource.`);
  if (def.category === 'shell') fail(`"${def.name}" is the site's shared header or footer, which is changed one element at a time.`);
  // What the description cannot say yet would be lost without a word: refused until it can.
  if (Object.values(def.tree.nodes).some((n) => n.kind === 'instance')) fail(`"${def.name}" places other components in its design, which component.upsert cannot describe yet. Change it with the node operations instead.`);
  return def;
}

/**
 * The UI state the description declares, each variable checked and settled as component.setState settles one: a name
 * no property has, a label (the name when left out), its options and the value every placement starts at. Undefined
 * when it declares none.
 */
function designState(op: UpsertOp, candidate: ComponentDefinition): Record<string, UiStateSchema> | undefined {
  const entries = Object.entries(op.state ?? {});
  if (!entries.length) return undefined;
  if (entries.length > MAX_UI_STATES) fail(`A component can have at most ${MAX_UI_STATES} UI state variables.`);
  const out: Record<string, UiStateSchema> = {};
  for (const [name, decl] of entries) {
    checkStateName(candidate, name);
    out[name] = normalizeUiState(decl, name);
  }
  return out;
}

/**
 * What is wrong with a described button's state action: state the component keeps in a form a hand edit damaged (which
 * validation would only report, while the button did nothing) is refused here, as node.setStateAction refuses it.
 */
function actionProblem(def: ComponentDefinition, action: unknown, nodeId: string): string | null {
  const name = (action as { state?: unknown }).state;
  if (typeof name === 'string' && damagedState(def, name)) return `changes the UI state "${name}", which is damaged. Describe it again with state.`;
  return stateActionProblem(def, action, nodeId);
}

/** A rebuilt component's own UI state, when the description leaves it out: kept while its design does not use it. */
function keptState(was: ComponentDefinition, candidate: ComponentDefinition): Record<string, UiStateSchema> | undefined {
  if (was.state === undefined) return undefined;
  // A map a hand edit damaged stays as it was, for validation to report.
  if (!was.state || typeof was.state !== 'object' || Array.isArray(was.state)) return clone(was.state);
  const used = Object.keys(was.state).filter((name) => stateUsers(was, name).length);
  if (used.length) fail(`"${was.name}" has UI state its design reads or its buttons change (${used.join(', ')}). Describe it again with state (state: {} removes it) when rebuilding the design.`);
  const taken = Object.keys(was.state).find((name) => Object.hasOwn(candidate.properties, name));
  if (taken) fail(`"${taken}" is both a new property and UI state "${was.name}" keeps. Rename the property, or describe the state again with state.`);
  return Object.keys(was.state).length ? clone(was.state) : undefined;
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
  // Each item of a list is shown once: a repeat never repeats the list of the nearest repeat around it.
  for (const s of specs) {
    if (s.kind !== 'repeat') continue;
    let at = parentOf.get(s.id);
    while (at !== undefined && byId.get(at)!.kind !== 'repeat') at = parentOf.get(at);
    const outer = at === undefined ? undefined : byId.get(at);
    if (outer?.kind === 'repeat' && outer.list === s.list) fail(`"${s.id}" repeats "${s.list}" inside "${outer.id}", a repeat of the same list.`);
  }
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
  // A value that names a property or item field ("$prop", "$item") is a binding, and only a well-formed one is kept.
  const bound = (v: unknown): v is Binding => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).some((k) => k.startsWith('$'))) return false;
    const r = v as Record<string, unknown>;
    const keys = Object.keys(r).sort().join(',');
    const ok = (keys === '$prop' || keys === '$prop,field') && typeof r.$prop === 'string' && (r.field === undefined || typeof r.field === 'string');
    if (!ok && !(keys === '$item' && typeof r.$item === 'string')) refuse('a binding is {"$prop": name}, {"$prop": name, "field": objectField} or {"$item": field}.');
    return true;
  };
  const text = (v: unknown, max = 200) => (bound(v) ? clone(v) : String(v ?? '').trim().slice(0, max));
  const oneOf = (v: unknown, values: readonly string[], what: string) => {
    if (bound(v)) return clone(v);
    if (typeof v !== 'string' || !values.includes(v)) refuse(`${what} must be ${values.join(', ')}.`);
    return v as string;
  };
  const link = (v: unknown) => (bound(v) ? clone(v) : normalizeLink(v, state, label));
  // An unknown name would render a stand-in icon, so a literal one is refused as an icon property's value is.
  const icon = (v: string) => {
    if (!Object.hasOwn(ICONS, v)) refuse(`"${v.slice(0, 40)}" is not an available icon. Use one of: ${Object.keys(ICONS).join(', ')}.`);
    return v;
  };
  switch (s.kind) {
    case 'element': {
      const n = { ...base, kind: 'element', tag: 'div', children: [...(s.children ?? [])] } as ElementNode;
      if (s.tag !== undefined) n.tag = (bound(s.tag) ? clone(s.tag) : tagged(n, s.tag, refuse)) as ElementNode['tag'];
      if (s.link !== undefined) {
        const l = link(s.link);
        // A container with no destination is no card.
        if (isBinding(l) || l.type !== 'none') n.link = l;
      }
      if (s.action !== undefined) n.action = oneOf(s.action, ELEMENT_ACTIONS, 'What a click does') as ElementNode['action'];
      if (s.ariaLabel !== undefined && text(s.ariaLabel)) n.ariaLabel = text(s.ariaLabel) as ElementNode['ariaLabel'];
      if (s.collapseEmpty) n.collapseEmpty = true;
      if (s.interactionGroup) n.interactionGroup = true;
      if (s.appear !== undefined && s.appear !== 'none' && s.appear !== '') {
        if (!isAppearPreset(s.appear)) refuse('an entrance is fade, lift, scale-subtle or none.');
        n.appear = s.appear as ElementNode['appear'];
      }
      if (s.carousel) {
        n.carousel = true;
        if (!isCarouselTrack(n)) refuse('only a bulleted list (ul) that is not itself a link can be a carousel.');
      }
      // Checked against the finished component (overlayProblem), which knows the UI state that opens it.
      if (s.overlay !== undefined) n.overlay = s.overlay as OverlayMode;
      return n;
    }
    case 'text': {
      const rich = s.rich === true;
      const n = { ...base, kind: 'text', tag: rich ? 'div' : 'p', text: '' } as TextNode;
      if (rich) {
        n.rich = true;
        if (s.tag !== undefined && s.tag !== 'div') refuse('rich text keeps its paragraph structure, so it takes no tag.');
        n.text = bound(s.text) ? clone(s.text) : normalizeRichText(s.text, state, label);
        if (s.datetime !== undefined) refuse('rich text cannot state a date; only plain text can.');
        return n;
      }
      if (s.tag !== undefined) n.tag = (bound(s.tag) ? clone(s.tag) : tagged(n, s.tag, refuse)) as TextNode['tag'];
      const plain = s.text;
      if (bound(plain)) n.text = clone(plain);
      else if (typeof plain === 'string') n.text = plain;
      else refuse('plain text is one string. Make it rich text (rich: true) for paragraphs and lists.');
      if (s.datetime !== undefined) {
        const d = s.datetime;
        if (bound(d)) n.datetime = clone(d);
        else if (d.trim() && !isArticleDate(d.trim())) refuse('a date is written YYYY-MM-DD.');
        else if (d.trim()) n.datetime = d.trim();
      }
      return n;
    }
    case 'image': {
      const n: GraphNode = { ...base, kind: 'image', image: bound(s.image) ? clone(s.image) : normalizeImage(s.image, state, label) } as GraphNode;
      if (s.fallbackAlt !== undefined && text(s.fallbackAlt, 300)) (n as { fallbackAlt?: unknown }).fallbackAlt = text(s.fallbackAlt, 300);
      return n;
    }
    case 'link': {
      const n = { ...base, kind: 'link', link: link(s.link) as LinkValue, label: bound(s.label) ? clone(s.label) : String(s.label), appearance: s.appearance === undefined ? 'primary' : oneOf(s.appearance, APPEARANCES, 'A button\'s appearance') } as LinkNode;
      // A button without an icon leaves it out.
      if (s.icon !== undefined && (bound(s.icon) || s.icon.trim())) n.icon = bound(s.icon) ? clone(s.icon) : icon(s.icon.trim());
      if (s.iconPosition !== undefined) n.iconPosition = oneOf(s.iconPosition, ICON_POSITIONS, 'The icon\'s side') as LinkNode['iconPosition'];
      if (s.ariaLabel !== undefined && text(s.ariaLabel)) n.ariaLabel = text(s.ariaLabel) as LinkNode['ariaLabel'];
      // Checked against the finished component (stateActionProblem), which declares the state it changes.
      if (s.stateAction !== undefined) n.stateAction = clone(s.stateAction) as StateAction;
      return n;
    }
    case 'icon': {
      const n = { ...base, kind: 'icon', icon: bound(s.icon) ? clone(s.icon) : icon(s.icon) } as GraphNode;
      if (s.ariaLabel !== undefined && text(s.ariaLabel)) (n as { ariaLabel?: unknown }).ariaLabel = text(s.ariaLabel);
      return n;
    }
    case 'divider': {
      const n = { ...base, kind: 'divider' } as DividerNode;
      // The schema has checked the shape; a plain rule is stored without one, and only an icon divider has an icon.
      if (s.shape !== undefined && s.shape !== 'line') n.shape = s.shape;
      if (s.icon !== undefined && s.icon.trim()) {
        if (n.shape !== 'icon') refuse('Only a divider of shape "icon" shows an icon.');
        n.icon = icon(s.icon.trim());
      }
      return n;
    }
    case 'repeat':
      return {
        ...base,
        kind: 'repeat',
        list: { $prop: s.list },
        children: [...(s.children ?? [])],
        ...(s.appearStagger ? { appearStagger: true } : {}),
        ...(s.filter ? { filter: { field: s.filter.field, ...(s.filter.when !== undefined ? { when: { $prop: s.filter.when } } : {}) } } : {})
      } as GraphNode;
    case 'slot':
      return { ...base, kind: 'slot', slot: s.slot, ...(s.children?.length ? { children: [...s.children] } : {}) } as GraphNode;
  }
}

/** A literal tag of the node's kind. */
function tagged(node: GraphNode, tag: unknown, refuse: (message: string) => never): unknown {
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
      ...(d.componentIds ? { componentIds: [...new Set(d.componentIds.map((c) => c.trim()))] } : {}),
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
      // An option kept under an ID no variant can have (an older save) is ignored already; it is not kept.
      const kept = !!own(prev?.options, id) && !('error' in findVariant(was!, id, axis));
      if (isProtoKey(id) || (!kept && !OPTION_RE.test(id))) fail(`Variant IDs use lowercase letters, numbers and hyphens ("${id}").`);
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
    if (isStateRef(b)) {
      // A design built whole never reads state in a form a hand edit damaged: it would show only where it starts.
      if (!where && damagedState(def, b.$state)) fail(`${at} reads the UI state "${b.$state}", which is damaged. Describe it again with state.`);
      const problem = stateRefProblem(state, def, site, b);
      if (problem) fail(`${at} ${problem}`);
      continue;
    }
    // An entry's fields are a collection layout's alone: a component has no entry to read them from.
    if ('$entry' in b) fail(`${at} shows the entry field "${b.$entry}", which only a collection's layout can.`);
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
    // A computed list is filled from the site's pages where it is placed; items handed to it would be ignored.
    if (nested?.type === 'list' && nested.feed) fail(`${at} passes "${'$prop' in b ? b.$prop : b.$item}" to "${nested.label}", which fills itself from the site's pages and cannot take a property.`);
    const ok = acceptedTypes(node, field, nested);
    if (ok && !ok.includes(schema.type)) fail(`${at} cannot show a ${schema.type} as its ${field === 'prop' ? quoted(site.prop!) : field}: it needs a ${ok.join(' or ')}.`);
    // A whole list passed on: each field the two lists share must hold the same kind of value at both ends.
    if (nested?.type === 'list' && schema.type === 'list')
      for (const [k, f] of Object.entries(nested.fields)) {
        const from = own(schema.fields, k);
        if (from && from.type !== f.type) fail(`${at} passes "${schema.label}" to "${nested.label}", whose "${k}" takes a ${f.type}, not a ${from.type}.`);
      }
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
      // A link names its token, and for a colour may give a strength ({"token", "alpha"}); a background image names a
      // library image ({"assetId", ...}): node.setStyle checks the rest.
      const token = !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((k) => k === 'token' || k === 'alpha') && typeof (value as { token?: unknown }).token === 'string';
      if (!token && !isBackgroundImageValue(value) && !['string', 'number', 'boolean'].includes(typeof value)) fail(`${at}: "${property}" needs a value or {"token": "..."}.`);
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
function settlePlacements(state: ProjectState, was: ComponentDefinition, def: ComponentDefinition, shownBefore: ReadonlyMap<InstanceNode, Set<string>>) {
  for (const partId of Object.keys(was.parts)) if (!Object.hasOwn(def.parts, partId)) dropPartOverrides(state, def.id, partId);
  for (const { node, label, owner } of instancesOf(state, def.id)) {
    for (const [partId, entry] of Object.entries(node.itemOverrides ?? {})) {
      if (!entry || typeof entry !== 'object' || typeof entry.list !== 'string' || !entry.items || typeof entry.items !== 'object') continue;
      if (entry.list !== repeatedPartList(def, partId)) {
        delete node.itemOverrides![partId];
        continue;
      }
      // Styles of an item the placement no longer shows (a default item the new defaults leave out) go with it.
      const shown = new Set(placementItems(def, node, entry.list).map((i) => i.id));
      for (const itemId of Object.keys(entry.items)) if (!shown.has(itemId)) delete entry.items[itemId];
      if (!Object.keys(entry.items).length) delete node.itemOverrides![partId];
    }
    if (node.itemOverrides && !Object.keys(node.itemOverrides).length) delete node.itemOverrides;
    // Content a placement shows now must still show: a slot the new design puts inside a list it holds no items of
    // would hide it.
    const shown = shownSlots(def, node);
    const hidden = Object.entries(node.slots ?? {}).find(([slot, ids]) => Array.isArray(ids) && ids.length && shownBefore.get(node)?.has(slot) && !shown.has(slot));
    if (hidden) fail(`${label}: ${def.name} would no longer show the content in its "${hidden[0]}" slot. Move that content out first, or show the slot outside the list.`);
    const around = owner.kind === 'component' ? own(state.components, owner.id) : undefined;
    if (around) checkBindings(state, around, bindingSites(around).filter((s) => s.node === node), `"${around.name}" places "${def.name}" as `);
  }
}
