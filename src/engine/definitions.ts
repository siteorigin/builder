/**
 * Definition-level editing of project components: removal, property schema, parts, variants, slots and
 * property bindings. Every operation keeps instances consistent with the definition it changes.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import type { Op } from '@shared/ops';
import { STYLE_PROP_MAP, styleSetFor } from '@shared/styles';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { findVariant } from '@shared/variants';
import { defKey } from '@generator/index';
import { EngineError, fail, findParent, getNode, instancesOf } from './tree';
import { clone } from './install';
import { normalizeProp } from './values';
import { acceptedTypes, bindingSites, boundSchema, checkPropName, enclosingList, isProtoKey, normalizeProperties, normalizePropSchema, type BindField } from './schema';
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

/** Overrides of a part that no longer exists style nothing; drop them from every placement. */
export function dropPartOverrides(state: ProjectState, defId: string, partId: string) {
  for (const { node } of instancesOf(state, defId)) {
    if (!node.overrides || !Object.hasOwn(node.overrides, partId)) continue;
    delete node.overrides[partId];
    if (!Object.keys(node.overrides).length) delete node.overrides;
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

/**
 * The name a separate copy of a component gets when the author gives none: "Card (unique)", then "Card (unique 2)"
 * and so on. Suffixes an earlier copy added are replaced rather than stacked, and the name is one no installed
 * component has yet, so every variant in the library can be told apart.
 */
export function uniqueCopyName(state: ProjectState, name: string): string {
  let base = name.trim();
  while (UNIQUE_SUFFIX.test(base)) base = base.replace(UNIQUE_SUFFIX, '');
  base ||= 'Component';
  const taken = new Set(Object.values(state.components).map((d) => d.name.trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? ' (unique)' : ` (unique ${i})`;
    const candidate = `${base.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
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

/** Put a property schema in place, moving every instance's content to it. Content that no longer fits blocks the change. */
function applyPropSchema(state: ProjectState, def: ComponentDefinition, name: string, schema: PropSchema) {
  const prev = own(def.properties, name);
  if (!prev && Object.keys(def.properties).length >= 60) fail('A component can have at most 60 properties.');
  for (const site of bindingSites(def)) {
    const b = site.binding;
    if ('$prop' in b && b.$prop === name) {
      const nested = site.field === 'prop' ? state.components[(site.node as InstanceNode).definitionId]?.properties[site.prop!] : undefined;
      const ok = acceptedTypes(site.node, site.field as BindField, nested);
      if (ok && !ok.includes(schema.type)) fail(`"${name}" is shown by ${describeNode(site.node)} as its ${site.field === 'prop' ? site.prop : site.field}, which needs a ${ok.join(' or ')} property. Unbind it first.`);
    }
    if ('$item' in b && enclosingRepeatProp(def, site.node.id) === name) {
      if (schema.type !== 'list') fail(`"${name}" is repeated in the design, so it must stay a list.`);
      const f = own(schema.fields, b.$item);
      if (!f) fail(`List items of "${name}" are shown using the field "${b.$item}". Keep that field, or unbind it first.`);
      const nested = site.field === 'prop' ? state.components[(site.node as InstanceNode).definitionId]?.properties[site.prop!] : undefined;
      const ok = acceptedTypes(site.node, site.field as BindField, nested);
      if (ok && !ok.includes(f.type)) fail(`The list field "${b.$item}" is shown by ${describeNode(site.node)}, which needs a ${ok.join(' or ')} field.`);
    }
  }
  // Changing the type of a property that has content keeps that content only where the conversion is lossless.
  const lossless: Record<string, string[]> = { string: ['richtext', 'enum', 'number'], richtext: ['string'], enum: ['string'], number: ['string'] };
  const retyped = prev && prev.type !== schema.type;
  for (const { node, label, owner } of instancesOf(state, def.id)) {
    if (!Object.hasOwn(node.props, name)) continue;
    const v = node.props[name];
    if (isBinding(v)) {
      // Bound straight through from an enclosing component: both ends must keep the same type.
      const parent = owner.kind === 'component' ? state.components[owner.id] : undefined;
      const from = parent ? boundSchema(parent, node.id, v) : undefined;
      if (from && from.type !== schema.type) fail(`"${parent!.name}" passes its ${from.type} property to "${name}". Change both together, or unbind it there first.`);
      continue;
    }
    // Placements start with every default filled in; an untouched default is not content to keep.
    if (retyped && JSON.stringify(v) === JSON.stringify(prev!.default)) {
      node.props[name] = clone(schema.default);
      continue;
    }
    if (retyped && !(lossless[prev!.type] ?? []).includes(schema.type)) fail(`${label}: "${name}" has content that a ${schema.type} property cannot keep. Remove the property and add it again to start over.`);
    try {
      // Rich text kept as a plain string keeps its words.
      const kept = retyped && prev!.type === 'richtext' && schema.type === 'string' ? richTextToPlain(toRichText(v)) : v;
      node.props[name] = normalizeProp(schema, kept, state, `${def.name} → ${schema.label}`);
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      fail(`${label}: ${e.message} Change that content first, or remove the property and add it again.`);
    }
  }
  def.properties[name] = schema;
}

function enclosingRepeatProp(def: ComponentDefinition, nodeId: string): string | null {
  const tree = def.tree!;
  let cur = findParent(tree, nodeId);
  while (cur?.parentId) {
    const p = tree.nodes[cur.parentId];
    if (p?.kind === 'repeat') return p.list.$prop;
    cur = findParent(tree, cur.parentId);
  }
  return null;
}

function removeProp(state: ProjectState, def: ComponentDefinition, name: string) {
  const sites = bindingSites(def).filter((s) => '$prop' in s.binding && s.binding.$prop === name);
  if (sites.length) fail(`"${name}" is still shown by ${sites.map((s) => describeNode(s.node)).join(', ')}. Unbind or remove those elements first.`);
  delete def.properties[name];
  for (const { node } of instancesOf(state, def.id)) delete node.props[name];
}

export function setPropSchema(state: ProjectState, op: Op<'component.setPropSchema'>): OpResult {
  const def = projectDef(state, op.definitionId);
  checkPropName(op.prop);
  applyPropSchema(state, def, op.prop, normalizePropSchema(op.schema, state, op.prop));
  return {};
}

export function removePropSchema(state: ProjectState, op: Op<'component.removePropSchema'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (!own(def.properties, op.prop)) fail(`"${def.name}" has no property "${op.prop}".`);
  removeProp(state, def, op.prop);
  return {};
}

/** Replace a definition's whole property schema (used when saving a code component's manifest). */
export function replaceProperties(state: ProjectState, def: ComponentDefinition, raw: Record<string, unknown>) {
  const next = normalizeProperties(raw, state);
  for (const name of Object.keys(def.properties)) if (!Object.hasOwn(next, name)) removeProp(state, def, name);
  const ordered: Record<string, PropSchema> = {};
  for (const [name, schema] of Object.entries(next)) {
    applyPropSchema(state, def, name, schema);
    ordered[name] = def.properties[name];
  }
  // Keep the order the caller gave, so an edited manifest reads the way it was written.
  def.properties = ordered;
}

// ---------------------------------------------------------------------------
// Parts, variants and slots
// ---------------------------------------------------------------------------

export function setPart(state: ProjectState, op: Op<'component.setPart'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (!validId(op.partId)) fail(`Part IDs must be camelCase identifiers ("${op.partId}").`);
  const prev = own(def.parts, op.partId);
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
  if (!validId(op.variant, /^[a-z][a-z0-9-]{0,39}$/)) fail(`Variant IDs use lowercase letters, numbers and hyphens ("${op.variant}").`);
  const existing = Object.keys(def.variantAxes ?? {});
  const holding = existing.filter((a) => Object.hasOwn(def.variantAxes![a].options, op.variant));
  // Without a named axis: the axis that already has this option, the only axis, or a first one.
  const axisId = op.axis ?? (holding.length === 1 ? holding[0] : existing.length === 1 ? existing[0] : existing.length ? fail(`"${def.name}" has several variant axes (${existing.join(', ')}). Name the axis.`) : 'style');
  if (!validId(axisId)) fail(`Variant axis names must be camelCase identifiers ("${axisId}").`);
  def.variantAxes ??= {};
  const axis = own(def.variantAxes, axisId) ?? (def.variantAxes[axisId] = { label: axisId.charAt(0).toUpperCase() + axisId.slice(1), default: op.variant, options: {} });
  if (op.axisLabel) axis.label = op.axisLabel.trim();
  axis.options[op.variant] = { ...(own(axis.options, op.variant) ?? {}), label: op.label.trim() };
  if (op.makeDefault) axis.default = op.variant;
  return {};
}

export function removeVariant(state: ProjectState, op: Op<'component.removeVariant'>): OpResult {
  const def = projectDef(state, op.definitionId);
  const found = findVariant(def, op.variant, op.axis);
  if ('error' in found) fail(found.error);
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
  def.slots[op.slot] = { ...(own(def.slots, op.slot) ?? {}), label: op.label.trim() };
  return {};
}

export function removeSlot(state: ProjectState, op: Op<'component.removeSlot'>): OpResult {
  const def = projectDef(state, op.definitionId);
  if (!own(def.slots, op.slot)) fail(`"${def.name}" has no slot "${op.slot}".`);
  const filled = instancesOf(state, def.id).filter((u) => u.node.slots?.[op.slot]?.length);
  if (filled.length) fail(`The "${def.slots![op.slot].label}" slot has content in ${plural(filled.length, 'place')} (${[...new Set(filled.map((u) => u.label))].join(', ')}). Move or remove it first.`);
  // The placeholder that rendered the slot goes with it.
  if (def.tree) {
    for (const n of Object.values(def.tree.nodes)) {
      if (n.kind !== 'slot' || n.slot !== op.slot) continue;
      const info = findParent(def.tree, n.id);
      if (info) info.list.splice(info.index, 1);
      delete def.tree.nodes[n.id];
    }
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
// Bindings
// ---------------------------------------------------------------------------

const FIELD_KINDS: Record<BindField, GraphNode['kind'][] | null> = {
  text: ['text'],
  image: ['image'],
  fallbackAlt: ['image'],
  link: ['link'],
  label: ['link'],
  appearance: ['link'],
  icon: ['icon'],
  list: ['repeat'],
  prop: ['instance'],
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
      return typeof d === 'string' && /^[a-z0-9-]{1,40}$/.test(d) ? d : 'sparkles';
    case 'image':
      return schema?.type === 'image' ? clone(d) : { assetId: null, alt: '' };
    case 'link':
      return schema?.type === 'link' ? clone(d) : { type: 'none', target: '' };
    case 'prop':
      return clone(schema && nested && schema.type === nested.type ? d : nested?.default);
    default:
      return undefined;
  }
}

export function nodeSetBinding(state: ProjectState, op: Op<'node.setBinding'>): OpResult {
  if (op.owner.kind !== 'component') fail('Bindings only exist inside component definitions. Edit the component first.');
  const def = projectDef(state, op.owner.id);
  if (def.kind !== 'managed' || !def.tree) fail(`"${def.name}" is a code component; its properties are used in source.`);
  const node = getNode(def.tree, op.nodeId);
  const field = op.field as BindField;
  const kinds = FIELD_KINDS[field];
  if (kinds && !kinds.includes(node.kind)) fail(`${describeNode(node)} has no "${field}" to bind.`);
  let nested: PropSchema | undefined;
  if (field === 'prop') {
    if (!op.prop) fail('Name the nested property to bind with "prop".');
    const nd = state.components[(node as InstanceNode).definitionId];
    nested = own(nd?.properties, op.prop) ?? fail(`"${nd?.name ?? 'This component'}" has no property "${op.prop}".`);
  }
  const holder = (field === 'prop' ? (node as InstanceNode).props : node) as Record<string, unknown>;
  const key = field === 'prop' ? op.prop! : field;
  const current = holder[key];
  if (op.binding === null) {
    if (field === 'when' || field === 'unless' || field === 'fallbackAlt') delete holder[key];
    else if (field === 'list') fail('Repeated items always come from a list property. Remove the repeat instead.');
    else if (isBinding(current)) holder[key] = literalFor(field, node, boundSchema(def, node.id, current), nested);
    return {};
  }
  const b = op.binding;
  if ('$item' in b && field === 'list') fail('A repeat must use a list property ($prop), not a list item field.');
  const schema = boundSchema(def, node.id, b);
  if (!schema) {
    if ('$prop' in b) fail(`"${def.name}" has no property "${b.$prop}". Add it with component.setPropSchema first.`);
    fail(enclosingList(def, node.id) ? `The list has no field "${b.$item}".` : 'Only elements inside a repeat can show list item fields.');
  }
  const ok = acceptedTypes(node, field, nested);
  if (ok && !ok.includes(schema.type)) fail(`A ${schema.type} property cannot be used as ${field === 'prop' ? `"${op.prop}"` : `the ${field}`}. It needs a ${ok.join(' or ')} property.`);
  if (field === 'list' && '$prop' in b && enclosingRepeatProp(def, node.id) === b.$prop) fail('A repeat cannot repeat the list it is already inside.');
  const before = holder[key];
  holder[key] = clone(b);
  if (field === 'list') {
    // Everything inside the repeat that shows an item field must find it, with a fitting type, in the new list.
    for (const site of bindingSites(def)) {
      if (!('$item' in site.binding) || !isInside(def, site.node.id, node.id)) continue;
      const f = boundSchema(def, site.node.id, site.binding);
      const nestedSchema = site.field === 'prop' ? state.components[(site.node as InstanceNode).definitionId]?.properties[site.prop!] : undefined;
      const ok = acceptedTypes(site.node, site.field, nestedSchema);
      if (!f || (ok && !ok.includes(f.type))) {
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
