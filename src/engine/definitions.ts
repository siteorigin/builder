/**
 * Definition-level editing of project components: removal, property schema, parts, variants, slots and
 * property bindings. Every operation keeps instances consistent with the definition it changes.
 */
import type { ComponentDefinition, Comparison, GraphNode, InstanceNode, ListItem, OwnerRef, ProjectState, PropSchema, ScalarPropSchema, SlotDef, StateAction } from '@shared/types';
import { slotDecl, slotDeclProblem, slotFill } from './slots';
import { propBindingName, propBindingSchema } from '@shared/bindings';
import { isArticleDate } from '@shared/articles';
import { ELEMENT_ACTIONS, ELEMENT_TAGS, ICON_POSITIONS, TEXT_TAGS, isBinding, isBindingRef, isEntryBinding, isStateRef, slotChildren } from '@shared/types';
import { ENTRY_CONTENT_FIELDS, ENTRY_DATE_FIELDS, entryChoiceProblem, entryFieldSchema } from '@shared/entry-fields';
import type { Op } from '@shared/ops';
import { STYLE_PROP_MAP, styleSetFor } from '@shared/styles';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { axesOf, findVariant, variantOptions } from '@shared/variants';
import { defKey } from '@generator/index';
import { EngineError, fail, findParent, getNode, getTree, instancesOf, subtreeIds } from './tree';
import { clone, placedDefaultItems, placedItemId } from './install';
import { bindingSource, requiredValueProblems } from './required';
import { REQUIRED_REFUSAL, isEmptyPropValue, optionalSchema, requiredGap, shownValue } from '@shared/required';
import { normalizeProp } from './values';
import { releaseKept } from '@shared/site-name';
import {
  MAX_UI_STATES,
  STATE_FIELDS,
  acceptedTypes,
  bindingProblem,
  bindingSites,
  boundSchema,
  checkPropName,
  checkStateName,
  enclosingList,
  isProtoKey,
  normalizeProperties,
  normalizePropSchema,
  damagedState,
  normalizeUiState,
  stateActionProblem,
  uiStateProblem,
  stateRefProblem,
  stateUsers,
  withState,
  type BindField
} from './schema';
import { defFile } from '@generator/index';

type OpResult = Record<string, unknown>;

function own<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
  return rec && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

function projectDef(state: ProjectState, id: string): ComponentDefinition {
  const def = own(state.components, id) ?? fail(`Component "${id}" does not exist.`);
  if (def.owner !== 'project') throw new EngineError('SCOPE_MISMATCH', `"${def.name}" belongs to the theme. Fork it first with component.fork, then edit the returned project definition.`);
  return def;
}

const ID_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const validId = (id: string, re = ID_RE) => re.test(id) && !isProtoKey(id);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Dependencies and removal
// ---------------------------------------------------------------------------

/**
 * Code components whose source still needs `defId`: declared dependencies, an import of its file, and code
 * converted before conversions carried their own CSS. (Managed trees are covered by `instancesOf`.)
 */
export function dependentsOf(state: ProjectState, defId: string): ComponentDefinition[] {
  return Object.values(state.components).filter((d) => codeNeeds(state, d, defId));
}

/** Whether a code component's source needs `defId` (see `dependentsOf`). */
export function codeNeeds(state: ProjectState, d: ComponentDefinition, defId: string): boolean {
  if (d.id === defId || d.kind !== 'code') return false;
  const target = own(state.components, defId);
  const legacyClass = `so-${defKey(defId)}__`;
  const file = target ? `/${defFile(target).split('/').pop()}` : null;
  return (d.dependencies ?? []).includes(defId) || (d.provenance?.forkedFrom === defId && !!d.source?.includes(legacyClass)) || (!!file && !!d.source?.includes(file));
}

/**
 * Whether a code component imports `defId`'s file (an import of it, not a comment or string that mentions it) or declares
 * it as a dependency: it then renders it, which `codeNeeds` (a looser reading, for what removal must not break) cannot say.
 */
export function codeImports(state: ProjectState, d: ComponentDefinition, defId: string): boolean {
  if (d.id === defId || d.kind !== 'code') return false;
  if ((d.dependencies ?? []).includes(defId)) return true;
  const target = own(state.components, defId);
  if (!target || !d.source) return false;
  const file = defFile(target).split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)['"][^'"\\n]*/${file}['"]`).test(d.source);
}

/** Overrides of a part that no longer exists style nothing; drop them, shared and per item, from every placement. */
export function dropPartOverrides(state: ProjectState, defId: string, partId: string) {
  for (const { node } of instancesOf(state, defId)) {
    if (node.overrides && Object.hasOwn(node.overrides, partId)) {
      delete node.overrides[partId];
      if (!Object.keys(node.overrides).length) delete node.overrides;
    }
    if (node.itemOverrides && Object.hasOwn(node.itemOverrides, partId)) {
      delete node.itemOverrides[partId];
      if (!Object.keys(node.itemOverrides).length) delete node.itemOverrides;
    }
  }
}

/** Definitions a definition's tree places directly. */
export function directDependencies(def: ComponentDefinition): string[] {
  const ids = new Set<string>();
  for (const n of Object.values(def.tree?.nodes ?? {})) if (n.kind === 'instance') ids.add(n.definitionId);
  return [...ids].sort();
}

/** The longest component name an operation accepts. */
const NAME_MAX = 60;
/** One trailing "(unique)" or "(unique 3)" that an earlier separate copy added. */
const UNIQUE_SUFFIX = /\s*\(unique(?:\s+\d+)?\)\s*$/i;
/** Room kept for the suffixes most series reach, up to " (unique 99)", so every copy in a series has the same stem. */
const STEM_MAX = NAME_MAX - ' (unique 99)'.length;

/** A name without the suffixes earlier copies added, cut to `max` without splitting a character in two. */
function copyStem(name: string, max = STEM_MAX): string {
  let stem = name.trim();
  for (;;) {
    while (UNIQUE_SUFFIX.test(stem)) stem = stem.replace(UNIQUE_SUFFIX, '');
    if (stem.length <= max) break;
    // A cut can expose a suffix that was mid-name, so the loop looks again.
    stem = stem.slice(0, /[\uD800-\uDBFF]/.test(stem[max - 1]) ? max - 1 : max).trimEnd();
  }
  return stem || 'Component';
}

/**
 * The name a separate copy of a component gets when the author gives none: "Card (unique)", then "Card (unique 2)"
 * and so on. Suffixes an earlier copy added are replaced rather than stacked, and the name is one no installed
 * component has yet, so every variant in the library can be told apart.
 */
export function uniqueCopyName(state: ProjectState, name: string): string {
  const stem = copyStem(name);
  const taken = new Set(Object.values(state.components).map((d) => d.name.trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? ' (unique)' : ` (unique ${i})`;
    const candidate = `${copyStem(stem, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function componentRemove(state: ProjectState, op: Op<'component.remove'>): OpResult {
  const def = own(state.components, op.definitionId) ?? fail(`Component "${op.definitionId}" does not exist.`);
  const uses = instancesOf(state, def.id);
  if (uses.length) fail(`"${def.name}" is used ${plural(uses.length, 'time')} (${[...new Set(uses.map((u) => u.label))].join(', ')}). Remove those uses first.`);
  const dependents = dependentsOf(state, def.id);
  if (dependents.length) fail(`"${def.name}" is needed by ${dependents.map((d) => `"${d.name}"`).join(', ')}.`);
  delete state.components[def.id];
  delete state.themeLock.components[def.id];
  return {};
}

// ---------------------------------------------------------------------------
// Property schema
// ---------------------------------------------------------------------------

function describeNode(n: GraphNode): string {
  return n.name ?? (n.kind === 'link' ? 'a button' : n.kind === 'instance' ? 'a nested component' : `a ${n.kind} element`);
}

/**
 * Put a property schema in place, moving every instance's content to it. Content that no longer fits blocks the change.
 * `bindingsChecked`: the design's bindings were already checked against the whole new schema (a design built whole).
 */
function applyPropSchema(state: ProjectState, def: ComponentDefinition, name: string, schema: PropSchema, bindingsChecked = false) {
  const prev = own(def.properties, name);
  if (own(def.state, name)) fail(`"${def.name}" already has UI state "${name}". A property needs a name of its own.`);
  if (!prev && Object.keys(def.properties).length >= 60) fail('A component can have at most 60 properties.');
  for (const site of bindingsChecked ? [] : bindingSites(def)) {
    const b = site.binding;
    if ('$prop' in b && b.$prop === name) {
      // A binding to one field of an object reads that field's schema.
      const bound = propBindingSchema({ [name]: schema }, b);
      if (!bound) fail(`"${name}" is shown by ${describeNode(site.node)} through its field "${b.field}". Keep that field in an object property, or unbind it first.`);
      const nested = site.field === 'prop' ? state.components[(site.node as InstanceNode).definitionId]?.properties[site.prop!] : undefined;
      const ok = acceptedTypes(site.node, site.field as BindField, nested);
      if (ok && !ok.includes(bound.type)) fail(`"${propBindingName(b)}" is shown by ${describeNode(site.node)} as its ${site.field === 'prop' ? site.prop : site.field}, which needs a ${ok.join(' or ')} property. Unbind it first.`);
      const problem = bindingProblem(state, site, bound);
      if (problem) fail(`"${name}" cannot change this way: ${describeNode(site.node)} ${problem}`);
    }
    if ('$item' in b && enclosingRepeatProp(def, site.node.id) === name) {
      if (schema.type !== 'list') fail(`"${name}" is repeated in the design, so it must stay a list.`);
      const f = own(schema.fields, b.$item);
      if (!f) fail(`List items of "${name}" are shown using the field "${b.$item}". Keep that field, or unbind it first.`);
      const nested = site.field === 'prop' ? state.components[(site.node as InstanceNode).definitionId]?.properties[site.prop!] : undefined;
      const ok = acceptedTypes(site.node, site.field as BindField, nested);
      if (ok && !ok.includes(f.type)) fail(`The list field "${b.$item}" is shown by ${describeNode(site.node)}, which needs a ${ok.join(' or ')} field.`);
      const problem = bindingProblem(state, site, f);
      if (problem) fail(`The list field "${b.$item}" cannot change this way: ${describeNode(site.node)} ${problem}`);
    }
  }
  // Changing the type of a property that has content keeps that content only where the conversion is lossless.
  const lossless: Record<string, string[]> = { string: ['richtext', 'enum', 'number'], richtext: ['string'], enum: ['string'], number: ['string'] };
  const retyped = prev && prev.type !== schema.type;
  // List items carry IDs, and each placement needs its own, as a new placement gets them. A property that starts
  // holding items now gives every placement without a value its own copy of the default items, so no two share an
  // item's ID and the items the Inspector shows are the ones its edits find. A computed list stores nothing.
  const startsList = schema.type === 'list' && !schema.feed && (prev?.type !== 'list' || !!prev.feed);
  const ownItems = (owner: OwnerRef, node: InstanceNode) => {
    // Item styles kept for the default items (from before the property was removed) move to the placement's copies.
    const defaults = new Set((schema.default as ListItem[]).map((it) => it.id));
    for (const entry of Object.values(node.itemOverrides ?? {})) {
      if (entry?.list !== name || !entry.items || typeof entry.items !== 'object' || Array.isArray(entry.items)) continue;
      entry.items = Object.fromEntries(Object.entries(entry.items).map(([id, rs]) => [defaults.has(id) ? placedItemId(owner, node.id, id) : id, rs]));
    }
    return placedDefaultItems(owner, node, schema.default);
  };
  // A computed list showed the site's pages whatever a placement held for it: an empty list held there is not content.
  const fromFeed = prev?.type === 'list' && !!prev.feed;
  const placeholder = (v: unknown) => fromFeed && !isBinding(v) && (!Array.isArray(v) || !v.length);
  for (const { node, label, owner } of instancesOf(state, def.id)) {
    if (!Object.hasOwn(node.props, name) || (startsList && placeholder(node.props[name]))) {
      if (startsList) node.props[name] = ownItems(owner, node);
      continue;
    }
    const v = node.props[name];
    if (isBinding(v)) {
      // Bound straight through from an enclosing component: both ends must keep the same type.
      const parent = owner.kind === 'component' ? state.components[owner.id] : undefined;
      const from = parent ? boundSchema(parent, node.id, v) : undefined;
      if (from && from.type !== schema.type) fail(`"${parent!.name}" passes its ${from.type} property to "${name}". Change both together, or unbind it there first.`);
      // What arrives through the binding must never be empty where the property now requires a value.
      const source = from ?? bindingSource(state, owner, node, v);
      const gap = source ? requiredGap(source, schema) : null;
      if (gap) fail(`${label}: ${describeNode(node)} takes “${source!.label}” as “${schema.label}”: ${gap}. Make it required there first, or unbind it.`);
      continue;
    }
    // Placements start with every default filled in; an untouched default is not content to keep.
    if (retyped && JSON.stringify(v) === JSON.stringify(prev!.default)) {
      node.props[name] = schema.type === 'list' ? ownItems(owner, node) : clone(schema.default);
      continue;
    }
    if (retyped && !(lossless[prev!.type] ?? []).includes(schema.type)) fail(`${label}: "${name}" has content that a ${schema.type} property cannot keep. Remove the property and add it again to start over.`);
    try {
      // Rich text kept as a plain string keeps its words.
      const kept = retyped && prev!.type === 'richtext' && schema.type === 'string' ? richTextToPlain(toRichText(v)) : v;
      // A value left empty stays: a property made required now reports each placement still missing it, never refusing
      // the change. One the change itself would empty (content the new type cannot keep) is refused, as an edit is.
      const next = normalizeProp(optionalSchema(schema), kept, state, `${def.name} → ${schema.label}`);
      const emptied = emptiedByChange(prev, schema, v, next, `${def.name} → ${schema.label}`);
      if (emptied) fail(emptied, REQUIRED_REFUSAL);
      node.props[name] = next;
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      fail(`${label}: ${e.message} Change that content first, or remove the property and add it again.`, e.details);
    }
  }
  def.properties[name] = schema;
}

/**
 * The first required value a schema change would leave empty that held something before it (under the old schema):
 * its message, or null. One that was empty already, or new with the change, is reported instead (requiredProblems).
 */
function emptiedByChange(prev: PropSchema | undefined, schema: PropSchema, before: unknown, after: unknown, label: string): string | null {
  if (!prev) return null;
  const row = (list: unknown, id: string) => (Array.isArray(list) ? (list as Array<Record<string, unknown> | null>).find((it) => !!it && typeof it === 'object' && it.id === id) : undefined);
  for (const p of requiredValueProblems(schema, after, label)) {
    let was: unknown;
    let wasSchema: PropSchema | ScalarPropSchema | undefined;
    if (!p.key) [was, wasSchema] = [shownValue(prev, before), prev];
    else if (!p.key.includes('|')) {
      // One field of an object, as the placement held it (a field it left out showed a default, and still does).
      const o = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
      if (!Object.hasOwn(o, p.key)) continue;
      [was, wasSchema] = [o[p.key], prev.type === 'object' && Object.hasOwn(prev.fields, p.key) ? prev.fields[p.key] : undefined];
    } else {
      const at = p.key.lastIndexOf('|');
      const item = row(before, p.key.slice(0, at));
      const field = p.key.slice(at + 1);
      if (!item || !Object.hasOwn(item, field)) continue;
      [was, wasSchema] = [item[field], prev.type === 'list' && Object.hasOwn(prev.fields, field) ? prev.fields[field] : undefined];
    }
    if (wasSchema && !isEmptyPropValue(wasSchema as PropSchema, was)) return p.message;
  }
  return null;
}

function enclosingRepeatProp(def: ComponentDefinition, nodeId: string): string | null {
  const tree = def.tree!;
  // A tree damaged by hand can list a node under itself: each parent is visited once.
  const seen = new Set<string>([nodeId]);
  let cur = findParent(tree, nodeId);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const p = tree.nodes[cur.parentId];
    if (p?.kind === 'repeat') return p.list.$prop;
    cur = findParent(tree, cur.parentId);
  }
  return null;
}

function removeProp(state: ProjectState, def: ComponentDefinition, name: string, bindingsChecked = false) {
  const sites = bindingsChecked ? [] : bindingSites(def).filter((s) => '$prop' in s.binding && s.binding.$prop === name);
  const filtering = sites.find((s) => s.field === 'filter');
  if (filtering) fail(`"${name}" turns on the category filter of ${describeNode(filtering.node)}. Change the design without that filter first.`);
  if (sites.length) fail(`"${name}" is still shown by ${sites.map((s) => describeNode(s.node)).join(', ')}. Unbind or remove those elements first.`);
  delete def.properties[name];
  for (const { node } of instancesOf(state, def.id)) {
    delete node.props[name];
    releaseKept(node, name);
  }
}

/**
 * A schema as JSON without its label, its own settings in any order. What they hold keeps its order: a list's or an
 * object's fields in another order are another schema.
 */
const settingsJson = (schema: object): string => {
  const rec = schema as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(rec)
      .filter((k) => k !== 'label' && rec[k] !== undefined)
      .sort()
      .map((k) => [k, rec[k]])
  );
};

export function setPropSchema(state: ProjectState, op: Op<'component.setPropSchema'>): OpResult {
  const def = projectDef(state, op.definitionId);
  // A schema that differs from the stored one only in its label renames what authors see and nothing else: the
  // property keeps its name (even one older rules allowed), its bindings and every placement's value as stored.
  const prev = own(def.properties, op.prop);
  if (prev && settingsJson(op.schema) === settingsJson(prev)) {
    const label = typeof op.schema.label === 'string' ? op.schema.label.trim().slice(0, 80) : '';
    prev.label = label || op.prop;
    return {};
  }
  checkPropName(op.prop);
  applyPropSchema(state, def, op.prop, normalizePropSchema(op.schema, state, op.prop));
  return {};
}

/**
 * Put a managed component's properties in a new order: what each placement's Content lists them in. Every property
 * keeps its schema, its bindings and each placement's value; only the order changes.
 */
export function orderProperties(state: ProjectState, op: Op<'component.orderProperties'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (def.kind !== 'managed') fail(`"${def.name}" is a code component; its properties are ordered in its source.`);
  const keys = Object.keys(def.properties);
  const seen = new Set<string>();
  for (const name of op.order) {
    if (!own(def.properties, name)) fail(`"${def.name}" has no property "${name}".`);
    if (seen.has(name)) fail(`"${name}" is listed twice.`);
    seen.add(name);
  }
  const missing = keys.filter((k) => !seen.has(k));
  if (missing.length) fail(`The order leaves out ${missing.map((k) => `"${k}"`).join(', ')}. List every property of "${def.name}".`);
  def.properties = Object.fromEntries(op.order.map((name) => [name, def.properties[name]]));
  return {};
}

/**
 * Change only a property's default: what placements without a value of their own show, and what new placements start
 * with. Its schema and every placement's own value stay as they are.
 */
export function setPropDefault(state: ProjectState, op: Op<'component.setPropDefault'>): OpResult {
  const def = projectDef(state, op.definitionId);
  const schema = own(def.properties, op.prop) ?? fail(`"${def.name}" has no property "${op.prop}".`);
  // An object's default can change one field at a time; the fields left out keep theirs.
  (schema as { default: unknown }).default = normalizeProp(schema, op.value, state, `${def.name} → ${schema.label}`, schema.type === 'object' ? schema.default : undefined);
  return {};
}

export function removePropSchema(state: ProjectState, op: Op<'component.removePropSchema'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (!own(def.properties, op.prop)) fail(`"${def.name}" has no property "${op.prop}".`);
  removeProp(state, def, op.prop);
  return {};
}

/** A stored property that goes by another name in a replaced schema. */
export interface PropRename {
  from: string;
  to: string;
}

/** Renames that each move one stored property to one property of the new schema. */
function checkRenames(def: ComponentDefinition, next: Record<string, PropSchema>, renames: PropRename[]) {
  if (!renames.length) return;
  // A design binds properties by name; only code components, which have none, rename this way.
  if (def.tree) fail(`"${def.name}" shows its properties in its design, so they cannot be renamed this way.`);
  const from = new Set<string>();
  const to = new Set<string>();
  for (const r of renames) {
    if (!own(def.properties, r.from)) fail(`"${def.name}" has no property "${r.from}" to rename.`);
    if (!Object.hasOwn(next, r.to)) fail(`"${r.from}" is renamed to "${r.to}", which is not one of the new properties.`);
    if (r.from === r.to) fail(`"${r.from}" is renamed to itself.`);
    if (from.has(r.from)) fail(`"${r.from}" is renamed twice.`);
    if (to.has(r.to)) fail(`More than one property is renamed to "${r.to}".`);
    from.add(r.from);
    to.add(r.to);
  }
}

/**
 * Move renamed properties all at once (so two names can swap): the schema, every placement's value, bound or not,
 * and the examples. A destination that held another property's value has had it removed already.
 */
function moveProps(state: ProjectState, def: ComponentDefinition, renames: PropRename[]) {
  const move = (rec: Record<string, unknown>) => {
    const held = renames.filter((r) => Object.hasOwn(rec, r.from)).map((r) => [r.to, rec[r.from]] as const);
    for (const r of renames) {
      delete rec[r.from];
      delete rec[r.to];
    }
    for (const [to, v] of held) rec[to] = v;
  };
  move(def.properties as Record<string, unknown>);
  for (const { node } of instancesOf(state, def.id)) {
    move(node.props);
    // A brand text kept through renames is the old property's: the one now under its name starts afresh.
    for (const r of renames) {
      releaseKept(node, r.from);
      releaseKept(node, r.to);
    }
  }
  for (const ex of def.examples ?? []) if (ex.props) move(ex.props);
}

/**
 * Replace a definition's whole property schema (used when saving a code component's manifest, and by a design built
 * whole). `renames` names the stored properties that the new schema keeps under another name, so their content moves
 * instead of being removed. `bindingsChecked`: the design in place has had every binding checked against `raw` already,
 * so only the placements' content is moved and checked here.
 */
export function replaceProperties(state: ProjectState, def: ComponentDefinition, raw: Record<string, unknown>, renames: PropRename[] = [], { bindingsChecked = false } = {}) {
  const next = normalizeProperties(raw, state);
  checkRenames(def, next, renames);
  const from = new Set(renames.map((r) => r.from));
  const to = new Set(renames.map((r) => r.to));
  // Removed: a stored property the new schema leaves out, or whose name a renamed one takes over.
  for (const name of Object.keys(def.properties)) if (!from.has(name) && (!Object.hasOwn(next, name) || to.has(name))) removeProp(state, def, name, bindingsChecked);
  if (renames.length) moveProps(state, def, renames);
  // Each property then takes its new schema, checked against the content it moved with.
  const ordered: Record<string, PropSchema> = {};
  for (const [name, schema] of Object.entries(next)) {
    applyPropSchema(state, def, name, schema, bindingsChecked);
    ordered[name] = def.properties[name];
  }
  // Keep the order the caller gave, so an edited manifest reads the way it was written.
  def.properties = ordered;
  // Examples keep only the properties the component has, with values their schemas accept.
  for (const ex of def.examples ?? []) {
    for (const [name, v] of Object.entries(ex.props ?? {})) {
      const schema = own(def.properties, name);
      try {
        if (schema) ex.props[name] = normalizeProp(schema, v, state, `${def.name} example`);
        else delete ex.props[name];
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        delete ex.props[name];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parts, variants and slots
// ---------------------------------------------------------------------------

export function setPart(state: ProjectState, op: Op<'component.setPart'>): OpResult {
  const def = projectDef(state, op.definitionId);
  const prev = own(def.parts, op.partId);
  // A part the component has keeps the name it was loaded with; a new one needs a plain name.
  if (!prev && !validId(op.partId)) fail(`Part IDs must be camelCase identifiers ("${op.partId}").`);
  let node: GraphNode | undefined;
  if (def.kind === 'managed' && def.tree) {
    node = getNode(def.tree, op.nodeId);
    if (op.partId === 'root' && op.nodeId !== def.tree.rootIds[0]) fail('The root part is always the outermost element.');
    if (node.kind === 'slot' || node.kind === 'repeat') fail('Slots and repeats render no element of their own, so they cannot be parts.');
    const other = Object.entries(def.parts).find(([pid, p]) => pid !== op.partId && p.nodeId === op.nodeId);
    if (other) fail(`That element is already the "${other[0]}" part.`);
  } else {
    if (op.partId === 'root' && op.nodeId !== 'root') fail('The root part of a code component is always "root".');
    if (!/^[a-z][\w-]{0,40}$/.test(op.nodeId)) fail(`"${op.nodeId}" is not a valid part name.`);
  }
  let controls: string[] | undefined;
  if (op.styleControls) {
    const bad = op.styleControls.filter((c) => !Object.hasOwn(STYLE_PROP_MAP, c));
    if (bad.length) fail(`Unknown style properties: ${bad.join(', ')}.`);
    controls = [...new Set(op.styleControls)];
  } else controls = prev && prev.nodeId === op.nodeId ? prev.styleControls : node ? styleSetFor(node) : undefined;
  def.parts[op.partId] = { nodeId: op.nodeId, label: op.label.trim(), ...(controls ? { styleControls: controls } : {}) };
  return {};
}

/** A part or slot name as its label: "priceTotal" is "Price total". */
const labelOf = (id: string) => id.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/**
 * Declares the parts and slots a code component's code shows (as the code check reads them from its syntax tree) that
 * its contract does not have yet, each under its own name: "total" is the "Total" part, "content" the "Content" slot.
 * Names that are not plain camelCase words are left to the code check to report. Nothing is taken away: a part or slot
 * the code no longer shows keeps its placements' styles and content until it is removed.
 */
export function declareCodeNames(def: Pick<ComponentDefinition, 'kind' | 'parts' | 'slots'>, names: { parts: readonly string[]; slots: readonly string[] }): void {
  if (def.kind !== 'code') return;
  for (const id of names.parts) if (id !== 'root' && validId(id) && !own(def.parts, id)) def.parts[id] = { nodeId: id, label: labelOf(id) };
  for (const name of names.slots) if (validId(name) && !own(def.slots, name)) (def.slots ??= {})[name] = { label: labelOf(name) };
}

/** The declared slots of a component that hold content in at least one of its placements. */
export function filledSlots(state: ProjectState, def: ComponentDefinition): string[] {
  const uses = instancesOf(state, def.id);
  return Object.keys(def.slots ?? {}).filter((slot) => uses.some((u) => slotChildren(u.node, slot).length > 0));
}

export function removePart(state: ProjectState, op: Op<'component.removePart'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (op.partId === 'root') fail('Every component keeps its root part.');
  if (!own(def.parts, op.partId)) fail(`"${def.name}" has no part "${op.partId}".`);
  delete def.parts[op.partId];
  dropPartOverrides(state, def.id, op.partId);
  return {};
}

export function setVariant(state: ProjectState, op: Op<'component.setVariant'>): OpResult {
  const def = projectDef(state, op.definitionId);
  const existing = Object.keys(def.variantAxes ?? {});
  const holding = existing.filter((a) => Object.hasOwn(def.variantAxes![a].options, op.variant));
  // Without a named axis: the axis that already has this option, the only axis, or a first one.
  const axisId = op.axis ?? (holding.length === 1 ? holding[0] : existing.length === 1 ? existing[0] : existing.length ? fail(`"${def.name}" has several variant axes (${existing.join(', ')}). Name the axis.`) : 'style');
  // An axis or option the component has keeps the ID it was loaded with; a new one needs a plain ID.
  const had = own(def.variantAxes, axisId);
  if (!had && !validId(axisId)) fail(`Variant axis names must be camelCase identifiers ("${axisId}").`);
  if (!(had && own(had.options, op.variant)) && !validId(op.variant, /^[a-z][a-z0-9-]{0,39}$/)) fail(`Variant IDs use lowercase letters, numbers and hyphens ("${op.variant}").`);
  def.variantAxes ??= {};
  // A new axis starts with a plain base option as its default, so placements keep the look they had and can choose the
  // new option (a picker needs two to choose between).
  const axis =
    own(def.variantAxes, axisId) ??
    (def.variantAxes[axisId] = { label: axisId.charAt(0).toUpperCase() + axisId.slice(1), default: 'default', options: op.variant === 'default' ? {} : { default: { label: 'Default' } } });
  if (op.axisLabel) axis.label = op.axisLabel.trim();
  axis.options[op.variant] = { ...(own(axis.options, op.variant) ?? {}), label: op.label.trim() };
  if (op.makeDefault) axis.default = op.variant;
  return {};
}

export function removeVariant(state: ProjectState, op: Op<'component.removeVariant'>): OpResult {
  const def = projectDef(state, op.definitionId);
  const found = findVariant(def, op.variant, op.axis);
  if ('error' in found) fail(found.error);
  // A placement inside another component that chooses this option through a property would lose it.
  for (const { node, owner } of instancesOf(state, def.id)) {
    const chosen = node.variants?.[found.axis];
    const parent = owner.kind === 'component' ? state.components[owner.id] : undefined;
    if (parent && isStateRef(chosen) && damagedState(parent, chosen.$state)) fail(`"${parent.name}" chooses the ${found.axis} through its UI state "${chosen.$state}", which is damaged. Declare it again there first.`);
    const from = parent && isBindingRef(chosen) ? boundSchema(parent, node.id, chosen) : undefined;
    if (from?.type === 'enum' && from.options.some((o) => o.value === found.id))
      fail(`"${parent!.name}" can choose the ${found.axis} "${found.id}" through its "${from.label}" ${isStateRef(chosen) ? 'UI state' : 'choice'}. Remove that option there first.`);
  }
  const axis = def.variantAxes![found.axis];
  delete axis.options[found.id];
  const left = Object.keys(axis.options);
  if (!left.length) delete def.variantAxes![found.axis];
  else if (axis.default === found.id) axis.default = left[0];
  if (!Object.keys(def.variantAxes!).length) delete def.variantAxes;
  for (const { node } of instancesOf(state, def.id)) {
    if (node.variants?.[found.axis] !== found.id) continue;
    delete node.variants[found.axis];
    if (!Object.keys(node.variants).length) delete node.variants;
  }
  return {};
}

export function setSlot(state: ProjectState, op: Op<'component.setSlot'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (!validId(op.slot)) fail(`Slot names must be camelCase identifiers ("${op.slot}").`);
  def.slots ??= {};
  // What the operation leaves out stays as it was; null takes it away.
  const next: SlotDef = { ...(own(def.slots, op.slot) ?? {}), label: op.label.trim() };
  const description = op.description?.trim();
  if (op.componentIds?.some((c) => !c.trim())) fail('Name each component the slot takes by its ID.');
  for (const [key, value] of [
    ['description', op.description === undefined ? undefined : description || null],
    ['categories', op.categories === undefined ? undefined : op.categories === null ? null : [...new Set(op.categories)]],
    ['componentIds', op.componentIds === undefined ? undefined : op.componentIds === null ? null : [...new Set(op.componentIds.map((c) => c.trim()))]],
    ['primitives', op.primitives === undefined ? undefined : op.primitives === null ? null : [...new Set(op.primitives)]],
    ['max', op.max]
  ] as const) {
    if (value === null) delete next[key];
    else if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  // Where this design passes the slot's content on to a component inside it, that component's slot must still take
  // what it can now bring: measured before and after, so content already over a limit is never made worse.
  const forwards = Object.values(def.tree?.nodes ?? {}).flatMap((n) =>
    // Directly, or inside the fallback of another slot handed on there.
    n.kind !== 'instance' ? [] : Object.keys(n.slots ?? {}).filter((k) => slotChildren(n, k).some((c) => subtreeIds(def.tree!, c).some((id) => def.tree!.nodes[id]?.kind === 'slot' && (def.tree!.nodes[id] as { slot: string }).slot === op.slot))).map((k) => ({ inst: n, slot: k }))
  );
  const fillOf = (f: (typeof forwards)[number]) => {
    const decl = slotDecl(state, f.inst, f.slot);
    return decl ? { decl, fill: slotFill(state, def.tree!, slotChildren(f.inst, f.slot), decl, def) } : undefined;
  };
  const before = forwards.map(fillOf);
  def.slots[op.slot] = next;
  forwards.forEach((f, i) => {
    const now = fillOf(f);
    if (!now) return;
    // An inner slot already over its limit reports the same problem however much more it takes, so the save would not
    // notice more; anything else this change breaks there is refused when the whole edit is saved.
    const was = before[i];
    if (now.decl.max !== undefined && was && was.fill.count > now.decl.max && now.fill.count > was.fill.count) fail(`The “${now.decl.label}” slot it passes this content to holds at most ${now.decl.max}.`);
  });
  // Placements keep their content: a contract it no longer fits is refused until that content moves.
  for (const { node, owner, label } of instancesOf(state, def.id)) {
    const placed = node.slots?.[op.slot];
    if (!Array.isArray(placed) || !placed.length) continue;
    // Every tree a placement can sit in (a collection's layout too), as instancesOf found it.
    const tree = owner.kind === 'component' ? state.components[owner.id]?.tree : getTree(state, owner);
    if (!tree || slotDeclProblem(next)) continue;
    const design = owner.kind === 'component' ? state.components[owner.id] : undefined;
    const fill = slotFill(state, tree, placed, next, design);
    if (fill.refused) fail(`${label}: the “${next.label}” slot already holds ${fill.refused.what}, which it would no longer take. Move it out first.`);
    if (next.max !== undefined && fill.count > next.max) fail(`${label}: the “${next.label}” slot already holds more than ${next.max}. Move some of it out first.`);
  }
  return {};
}

/** `designReplaced`: the caller replaces the design's tree and parts itself (a rebuild), so they are left as they are. */
export function removeSlot(state: ProjectState, op: Op<'component.removeSlot'>, opts: { designReplaced?: boolean } = {}): OpResult {
  const def = projectDef(state, op.definitionId);
  if (!own(def.slots, op.slot)) fail(`"${def.name}" has no slot "${op.slot}".`);
  const filled = instancesOf(state, def.id).filter((u) => u.node.slots?.[op.slot]?.length);
  if (filled.length) fail(`The "${def.slots![op.slot].label}" slot has content in ${plural(filled.length, 'place')} (${[...new Set(filled.map((u) => u.label))].join(', ')}). Move or remove it first.`);
  // The placeholder that rendered the slot goes with it, and its fallback content, with the parts and variant styles
  // of that content.
  if (def.tree && !opts.designReplaced) {
    const removed = new Set<string>();
    for (const n of Object.values(def.tree.nodes)) {
      if (n.kind !== 'slot' || n.slot !== op.slot || removed.has(n.id)) continue;
      const info = findParent(def.tree, n.id);
      if (info) info.list.splice(info.index, 1);
      for (const id of subtreeIds(def.tree, n.id)) removed.add(id);
    }
    for (const id of removed) delete def.tree.nodes[id];
    for (const [pid, part] of Object.entries(def.parts))
      if (pid !== 'root' && removed.has(part.nodeId)) {
        delete def.parts[pid];
        dropPartOverrides(state, def.id, pid);
      }
    for (const { option: v } of variantOptions(def)) for (const nid of Object.keys(v.styles ?? {})) if (removed.has(nid)) delete v.styles![nid];
  }
  delete def.slots![op.slot];
  if (!Object.keys(def.slots!).length) delete def.slots;
  for (const { node } of instancesOf(state, def.id)) {
    if (!node.slots || !(op.slot in node.slots)) continue;
    delete node.slots[op.slot];
    if (!Object.keys(node.slots).length) delete node.slots;
  }
  return {};
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

/** The project-owned managed definition whose design UI state belongs to. */
function stateDef(state: ProjectState, id: string): ComponentDefinition & { tree: NonNullable<ComponentDefinition['tree']> } {
  const def = projectDef(state, id);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is a code component; it keeps its UI state in its source.`);
  return def as ComponentDefinition & { tree: NonNullable<ComponentDefinition['tree']> };
}

const STATE_USES: Partial<Record<BindField | 'stateAction', string>> = { when: 'shows only when it', unless: 'hides when it', variant: 'chooses a variant from it', stateAction: 'changes it' };

/** "the Monthly button (changes it), the Annual panel (shows only when it)". */
function describeUsers(users: ReturnType<typeof stateUsers>): string {
  return users.map((u) => `${describeNode(u.node)} (${STATE_USES[u.field] ?? `reads it as its ${u.field}`})`).join(', ');
}

/**
 * Add a UI state variable, or change one. Every node that reads or changes it must still fit: a comparison with a
 * value it can hold, a nested variant whose options include all of its own, a button action of the right kind.
 */
export function setState(state: ProjectState, op: Op<'component.setState'>): OpResult {
  const def = stateDef(state, op.definitionId);
  checkStateName(def, op.state);
  if (!own(def.state, op.state) && Object.keys(def.state ?? {}).length >= MAX_UI_STATES) fail(`A component can have at most ${MAX_UI_STATES} UI state variables.`);
  const schema = normalizeUiState(op.schema, op.state);
  // A change that leaves out the label or the starting value keeps the ones the state has, where they still fit:
  // relabelling a choice never moves every placement to its first option.
  const prev = own(def.state, op.state);
  if ((op.schema.label === undefined || !op.schema.label.trim()) && typeof prev?.label === 'string' && prev.label.trim()) schema.label = prev.label;
  if (prev && op.schema.initial === undefined && !damagedState(def, op.state) && prev.type === schema.type && (schema.type !== 'enum' || schema.options.some((o) => o.value === prev.initial)))
    schema.initial = prev.initial as never;
  const next = withState(def, op.state, schema);
  // An item state holds an item of one of the component's own lists.
  const declaration = uiStateProblem(next, op.state, schema);
  if (declaration) fail(`"${op.state}" cannot change this way: ${declaration}`);
  for (const site of bindingSites(next)) {
    if (!isStateRef(site.binding) || site.binding.$state !== op.state) continue;
    const problem = stateRefProblem(state, next, site, site.binding);
    if (problem) fail(`"${op.state}" cannot change this way: ${describeNode(site.node)} ${problem}`);
  }
  for (const n of Object.values(def.tree.nodes)) {
    if (n.kind !== 'link' || n.stateAction?.state !== op.state) continue;
    const problem = stateActionProblem(next, n.stateAction, n.id);
    if (problem) fail(`"${op.state}" cannot change this way: ${describeNode(n)} ${problem}`);
  }
  def.state = next.state;
  return {};
}

/** Remove a UI state variable that nothing reads or changes any more. */
export function removeState(state: ProjectState, op: Op<'component.removeState'>): OpResult {
  const def = stateDef(state, op.definitionId);
  const declared = own(def.state, op.state) ?? fail(`"${def.name}" has no UI state "${op.state}".`);
  const users = stateUsers(def, op.state);
  if (users.length) fail(`"${declared.label || op.state}" is still used by ${describeUsers(users)}. Unbind those or remove what they do first.`);
  delete def.state![op.state];
  if (!Object.keys(def.state!).length) delete def.state;
  return {};
}

/** Set or clear what a button in a component's design does to the component's UI state. Its link stays as it is. */
export function nodeSetStateAction(state: ProjectState, op: Op<'node.setStateAction'>): OpResult {
  if (op.owner.kind !== 'component') fail("Buttons change UI state only inside a component's design. Edit the component first.");
  const def = stateDef(state, op.owner.id);
  const node = getNode(def.tree, op.nodeId);
  if (node.kind !== 'link') fail(`${describeNode(node)} is not a button, so it cannot change UI state.`);
  if (op.action === null) {
    delete node.stateAction;
    return {};
  }
  const action = clone(op.action) as StateAction;
  if (damagedState(def, action.state)) fail(`The UI state "${action.state}" of "${def.name}" is damaged. Declare it again with component.setState first.`);
  const problem = stateActionProblem(def, action, node.id);
  if (problem) fail(`${describeNode(node)} ${problem}`);
  node.stateAction = action;
  return {};
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

const FIELD_KINDS: Record<BindField, GraphNode['kind'][] | null> = {
  text: ['text'],
  image: ['image'],
  fallbackAlt: ['image'],
  link: ['link', 'element'],
  label: ['link'],
  appearance: ['link'],
  icon: ['icon', 'link'],
  iconPosition: ['link'],
  ariaLabel: ['element', 'icon', 'link'],
  datetime: ['text'],
  tag: ['element', 'text'],
  action: ['element'],
  list: ['repeat'],
  // Set with the rest of the filter (component.upsert); node.setBinding cannot name it.
  filter: ['repeat'],
  prop: ['instance'],
  variant: ['instance'],
  when: null,
  unless: null
};
const APPEARANCES = ['primary', 'secondary', 'text', 'light', 'link', 'plain'];

/** The literal a field keeps when it is unbound: the bound property's current default where it fits. */
function literalFor(field: BindField, node: GraphNode, schema: PropSchema | undefined, nested: PropSchema | undefined): unknown {
  const d = schema?.default;
  switch (field) {
    case 'text':
      if (node.kind === 'text' && node.rich) return toRichText(d);
      return Array.isArray(d) ? richTextToPlain(toRichText(d)) : String(d ?? '');
    case 'label':
      return String(d ?? '');
    case 'appearance':
      return APPEARANCES.includes(String(d)) ? String(d) : 'primary';
    case 'icon':
      // A button showed no icon while its property was empty, and keeps showing none.
      if (node.kind === 'link' && !(typeof d === 'string' && d.trim())) return undefined;
      return typeof d === 'string' && /^[a-z0-9-]{1,40}$/.test(d) ? d : 'sparkles';
    case 'image':
      return schema?.type === 'image' ? clone(d) : { assetId: null, alt: '' };
    case 'link':
      // A card without a destination is just its container.
      if (node.kind === 'element') return schema?.type === 'link' && (d as { type?: string })?.type !== 'none' ? clone(d) : undefined;
      return schema?.type === 'link' ? clone(d) : { type: 'none', target: '' };
    case 'ariaLabel':
      return typeof d === 'string' && d.trim() ? d : undefined;
    // The date the text stated by default stays its date; anything else leaves the text undated.
    case 'datetime':
      return isArticleDate(typeof d === 'string' ? d.trim() : d) ? (d as string).trim() : undefined;
    case 'iconPosition':
      return (ICON_POSITIONS as unknown[]).includes(d) ? d : undefined;
    case 'action':
      // Explicitly nothing: without an action, a destination the container keeps would make it a card again.
      return (ELEMENT_ACTIONS as unknown[]).includes(d) ? d : 'none';
    case 'tag': {
      const tags: readonly string[] = node.kind === 'text' ? TEXT_TAGS : ELEMENT_TAGS;
      return typeof d === 'string' && tags.includes(d) ? d : node.kind === 'text' ? 'p' : 'div';
    }
    case 'prop':
      return clone(schema && nested && schema.type === nested.type ? d : nested?.default);
    default:
      return undefined;
  }
}

/**
 * node.setBinding in a collection's layout: an element (or a section placed there) shows one of the entry's fields,
 * or stops showing it and keeps an empty value of its own. Only entry fields can be bound there.
 */
function templateSetBinding(state: ProjectState, op: Op<'node.setBinding'>): OpResult {
  const collection = Object.hasOwn(state.collections ?? {}, op.owner.id) ? state.collections[op.owner.id] : fail(`Collection "${op.owner.id}" does not exist.`);
  const node = getNode(collection.settings.template, op.nodeId);
  const field = op.field as BindField;
  const kinds = FIELD_KINDS[field];
  if (kinds && !kinds.includes(node.kind)) fail(`${describeNode(node)} has no "${field}" to bind.`);
  if (!ENTRY_CONTENT_FIELDS.has(field)) fail(`A layout's ${field === 'list' ? 'repeats' : field === 'variant' ? 'section variants' : `${field}s`} are the same for every entry; only content can show an entry's fields.`);
  const condition = field === 'when' || field === 'unless';
  if (op.eq !== undefined && op.ne !== undefined) fail('A condition compares with "eq" or "ne", not both.');
  if ((op.eq !== undefined || op.ne !== undefined) && (!condition || op.binding === null)) fail('Only a "when" or "unless" binding compares its value, with "eq" or "ne".');
  let nested: PropSchema | undefined;
  if (field === 'prop') {
    if (!op.prop) fail('Name the property of the placed section to bind with "prop".');
    const nd = state.components[(node as InstanceNode).definitionId];
    nested = own(nd?.properties, op.prop) ?? fail(`"${nd?.name ?? 'This component'}" has no property "${op.prop}".`);
  }
  const holder = (field === 'prop' ? (node as InstanceNode).props : node) as Record<string, unknown>;
  const key = field === 'prop' ? op.prop! : field;
  const current = holder[key];
  if (op.binding === null) {
    if (condition || field === 'fallbackAlt') delete holder[key];
    else if (isBindingRef(current)) {
      // What is left is empty, never one entry's value: the layout is every entry's.
      const literal = field === 'prop' ? clone(nested?.default) : literalFor(field, node, undefined, nested);
      if (literal === undefined) delete holder[key];
      else holder[key] = literal;
    }
    return {};
  }
  const b = op.binding;
  if (!isEntryBinding(b)) fail(`A collection's layout shows the entry's fields: bind to { "$entry": field }. Properties, list items and UI state belong to components.`);
  const schema = entryFieldSchema(collection, b.$entry) ?? fail(`Entries of ${collection.settings.name} have no field "${String(b.$entry).slice(0, 60)}".`);
  if (schema.type === 'enum' && !Array.isArray((schema as { options?: unknown }).options)) fail(`"${schema.label}" is damaged: it has no choices. Set its choices in the collection's settings first.`);
  if (field === 'datetime' && !ENTRY_DATE_FIELDS.has(b.$entry)) fail(`"${schema.label}" is not a date: a text can state the publication date (publishedAt) or the last update (updatedAt).`);
  const ok = acceptedTypes(node, field, nested);
  if (ok && !ok.includes(schema.type)) fail(`"${schema.label}" cannot be shown as ${field === 'prop' ? `"${op.prop}"` : `the ${field}`}: it needs a ${ok.join(' or ')} field.`);
  const choice = entryChoiceProblem(schema, nested);
  if (choice) fail(`"${schema.label}" ${choice}`);
  const comparison = op.eq !== undefined ? ({ ref: clone(b), eq: op.eq } as Comparison) : op.ne !== undefined ? ({ ref: clone(b), ne: op.ne } as Comparison) : undefined;
  const problem = bindingProblem(state, { node, field, prop: op.prop, comparison }, schema);
  if (problem) fail(`${describeNode(node)} ${problem}`);
  holder[key] = comparison ?? clone(b);
  return {};
}

export function nodeSetBinding(state: ProjectState, op: Op<'node.setBinding'>): OpResult {
  if (op.owner.kind === 'template') return templateSetBinding(state, op);
  if (op.owner.kind !== 'component') fail('Bindings only exist inside component definitions. Edit the component first.');
  const def = projectDef(state, op.owner.id);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is a code component; its properties are used in source.`);
  const node = getNode(def.tree, op.nodeId);
  const field = op.field as BindField;
  const kinds = FIELD_KINDS[field];
  if (kinds && !kinds.includes(node.kind)) fail(`${describeNode(node)} has no "${field}" to bind.`);
  const condition = field === 'when' || field === 'unless';
  if (op.eq !== undefined && op.ne !== undefined) fail('A condition compares with "eq" or "ne", not both.');
  if ((op.eq !== undefined || op.ne !== undefined) && (!condition || op.binding === null)) fail('Only a "when" or "unless" binding compares its value, with "eq" or "ne".');
  let nested: PropSchema | undefined;
  if (field === 'prop') {
    if (!op.prop) fail('Name the nested property to bind with "prop".');
    const nd = state.components[(node as InstanceNode).definitionId];
    nested = own(nd?.properties, op.prop) ?? fail(`"${nd?.name ?? 'This component'}" has no property "${op.prop}".`);
    // A computed list is filled from the site's pages where it is placed; handing it items would replace them.
    if (op.binding !== null && nested.type === 'list' && nested.feed) fail(`"${nested.label}" of "${nd!.name}" fills itself from the site's pages and cannot be bound to a property.`);
  }
  const nestedDef = node.kind === 'instance' ? state.components[node.definitionId] : undefined;
  const axis = field === 'variant' ? (op.axis ?? fail('Name the variant axis to bind with "axis".')) : undefined;
  const axisDef = axis !== undefined ? (axesOf(nestedDef ?? {}).find(([a]) => a === axis)?.[1] ?? fail(`"${nestedDef?.name ?? 'This component'}" has no variant axis "${axis}".`)) : undefined;
  const inst = node as InstanceNode;
  const holder = (field === 'prop' ? inst.props : field === 'variant' ? (inst.variants ?? {}) : node) as Record<string, unknown>;
  const key = field === 'prop' ? op.prop! : (axis ?? field);
  const current = holder[key];
  if (op.binding === null) {
    if (condition || field === 'fallbackAlt') delete holder[key];
    else if (field === 'list') fail('Repeated items always come from a list property. Remove the repeat instead.');
    else if (field === 'variant' && isBindingRef(current)) {
      // The placement keeps the option the property showed by default, where the nested component has it.
      const d = boundSchema(def, node.id, current)?.default;
      if (typeof d === 'string' && Object.hasOwn(axisDef!.options, d)) holder[key] = d;
      else delete holder[key];
      if (inst.variants && !Object.keys(inst.variants).length) delete inst.variants;
    } else if (isBindingRef(current)) {
      // A field the node may leave out (a card destination, an accessible name) goes when nothing usable is left.
      // State read where content belongs (a hand edit) leaves the value it starts at.
      const literal = literalFor(field, node, boundSchema(def, node.id, current), nested);
      if (literal === undefined) delete holder[key];
      else holder[key] = literal;
    }
    return {};
  }
  const b = op.binding;
  if ('$item' in b && field === 'list') fail('A repeat must use a list property ($prop), not a list item field.');
  if ('$state' in b) {
    if (!STATE_FIELDS.has(field)) fail(`${describeNode(node)} cannot read UI state as its ${field}: only "when", "unless" and a nested component's "variant" read UI state.`);
    if (!own(def.state, b.$state)) fail(`"${def.name}" has no UI state "${b.$state}". Add it with component.setState first.`);
  }
  const schema = boundSchema(def, node.id, b);
  if (!schema) {
    if ('$state' in b) fail(`The UI state "${b.$state}" of "${def.name}" is damaged. Declare it again with component.setState.`);
    if ('$prop' in b && b.field !== undefined && own(def.properties, b.$prop)) {
      const p = def.properties[b.$prop];
      fail(p.type === 'object' ? `"${p.label}" has no field "${b.field}". Fields: ${Object.keys(p.fields).join(', ')}.` : `"${p.label}" is not an object property, so it has no field "${b.field}".`);
    }
    if ('$prop' in b) fail(`"${def.name}" has no property "${b.$prop}". Add it with component.setPropSchema first.`);
    if ('$entry' in b) fail('Only a collection layout reads entry fields.');
    fail(enclosingList(def, node.id) ? `The list has no field "${b.$item}".` : 'Only elements inside a repeat can show list item fields.');
  }
  const ok = acceptedTypes(node, field, nested);
  const what = '$state' in b ? 'state' : 'property';
  if (ok && !ok.includes(schema.type)) fail(`A ${schema.type} ${what} cannot be used as ${field === 'prop' ? `"${op.prop}"` : `the ${field}`}. It needs a ${ok.join(' or ')} ${what}.`);
  if (field === 'list' && '$prop' in b && enclosingRepeatProp(def, node.id) === b.$prop) fail('A repeat cannot repeat the list it is already inside.');
  const comparison = op.eq !== undefined ? ({ ref: clone(b), eq: op.eq } as Comparison) : op.ne !== undefined ? ({ ref: clone(b), ne: op.ne } as Comparison) : undefined;
  const site = { node, field, prop: axis ?? op.prop, comparison };
  const problem = '$state' in b ? stateRefProblem(state, def, site, b) : bindingProblem(state, site, schema);
  if (problem) fail(`${describeNode(node)} ${problem}`);
  const before = holder[key];
  holder[key] = comparison ?? clone(b);
  if (field === 'variant') inst.variants = holder as Record<string, string>;
  if (field === 'list') {
    // Everything inside the repeat that shows an item field must find it, with a fitting type, in the new list.
    for (const site of bindingSites(def)) {
      if (!('$item' in site.binding) || !isInside(def, site.node.id, node.id)) continue;
      const f = boundSchema(def, site.node.id, site.binding);
      const nestedSchema = site.field === 'prop' ? state.components[(site.node as InstanceNode).definitionId]?.properties[site.prop!] : undefined;
      const ok = acceptedTypes(site.node, site.field, nestedSchema);
      if (!f || (ok && !ok.includes(f.type)) || bindingProblem(state, site, f)) {
        holder[key] = before;
        fail(`${describeNode(site.node)} inside the repeat shows "${site.binding.$item}", which "${(b as { $prop: string }).$prop}" items do not have${f ? ' in a fitting type' : ''}.`);
      }
    }
  }
  return {};
}

/** Whether `nodeId` sits below `ancestorId` in a definition's tree. */
function isInside(def: ComponentDefinition, nodeId: string, ancestorId: string): boolean {
  let cur = findParent(def.tree!, nodeId);
  while (cur?.parentId) {
    if (cur.parentId === ancestorId) return true;
    cur = findParent(def.tree!, cur.parentId);
  }
  return false;
}
