/**
 * A managed component's contract as Edit everywhere changes it: which content each placement fills in (its
 * properties, and the design's fields bound to them), which inner elements each placement may style (its parts), and
 * the looks a placement chooses between (its variants). Every helper plans operations; the engine checks them.
 */
import type { ComponentDefinition, GraphNode, PartDef, ProjectState, PropSchema, ScalarPropSchema, VariantAxis } from '@shared/types';
import { isBinding } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { acceptedTypes, bindingProblem, bindingSites, isProtoKey, type BindField } from '@engine/schema';
import { instancesOf } from '@engine/tree';
import { richTextToPlain, toRichText } from '@shared/richtext';
import { axesOf } from '@shared/variants';
import { toCodeName } from './prop-schema';
import type { ContentField } from './design-content';

/** The most properties a component can have (see applyPropSchema). */
export const MAX_PROPERTIES = 60;

const owner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });

/** What authors call a node of a design, by what it is. */
export function nodeWord(node: GraphNode): string {
  switch (node.kind) {
    case 'text':
      if (node.rich) return 'Text';
      if (typeof node.tag === 'string' && /^h[1-6]$/.test(node.tag)) return 'Heading';
      return node.tag === 'p' ? 'Paragraph' : 'Text';
    case 'image':
      return 'Image';
    case 'link':
      return node.appearance === 'primary' || node.appearance === 'secondary' ? 'Button' : 'Link';
    case 'icon':
      return 'Icon';
    case 'element':
      return 'Container';
    case 'instance':
      return 'Component';
    case 'repeat':
      return 'Repeat';
    case 'slot':
      return 'Slot';
    default:
      return 'Element';
  }
}

/** A node's own name, or what it is. */
export const nodeName = (node: GraphNode): string => node.name?.trim() || nodeWord(node);

/**
 * Names never given to something new: the ones an operation refuses wherever it names something (see
 * validateOperation), and `slot`, which Svelte reads as slot syntax on a component placed in another's slot.
 */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'slot']);

/** `base`, or `base2`, `base3`… as a valid camelCase name that `taken` does not hold, never longer than 40. */
export function freeName(base: string, taken: Set<string>, valid: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : String(n);
    const name = base.slice(0, 40 - suffix.length) + suffix;
    // A base no suffix makes valid is the engine's to refuse, with its reason.
    if ((!taken.has(name) && valid(name)) || n > 9999) return name;
  }
}

export const validPropName = (name: string) => toCodeName(name) === name && !RESERVED_IDS.has(name);

/**
 * Names a new property must not take: the component's properties and UI state, and every name a placement or an
 * example still stores a value under. A placement keeps values for properties removed long ago, and a new property
 * by that name would show that old value instead of the design's.
 */
export function takenPropNames(state: ProjectState, def: ComponentDefinition): Set<string> {
  const out = new Set<string>([...Object.keys(def.properties), ...Object.keys(def.state ?? {})]);
  for (const { node } of instancesOf(state, def.id)) for (const k of Object.keys(node.props ?? {})) out.add(k);
  for (const ex of def.examples ?? []) for (const k of Object.keys(ex.props ?? {})) out.add(k);
  return out;
}

/** What a new property for one field of a node is called at first: "Heading", "Button label", "Card link". */
export function suggestedPropLabel(def: ComponentDefinition, node: GraphNode, field: ContentField): string {
  const name = nodeName(node);
  const base = field === 'text' || (field === 'image' && node.kind === 'image') || (field === 'icon' && node.kind === 'icon') ? name : `${name} ${field}`;
  const labels = new Set(Object.values(def.properties).map((p) => p.label.trim().toLowerCase()));
  if (!labels.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!labels.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/**
 * The schema of a new property for one field of a node, with the field's current value as its default, so every
 * placement shows what it showed before: each has no value of its own for a property it never had.
 */
export function newPropSchema(node: GraphNode, field: ContentField, value: unknown, label: string): Record<string, unknown> {
  switch (field) {
    case 'text': {
      if (node.kind === 'text' && node.rich) return { type: 'richtext', label, default: toRichText(value) };
      // A plain text that holds blocks (an older document) shows them as plain text, as the generator does.
      const text = Array.isArray(value) ? richTextToPlain(toRichText(value)) : String(value ?? '');
      return { type: 'string', label, default: text, ...(text.includes('\n') ? { multiline: true } : {}) };
    }
    case 'label': {
      const text = String(value ?? '');
      return { type: 'string', label, default: text, ...(text.includes('\n') ? { multiline: true } : {}) };
    }
    case 'link':
      return { type: 'link', label, default: value ?? { type: 'none', target: '' } };
    case 'image':
      return { type: 'image', label, default: value ?? { assetId: null, alt: '' } };
    case 'icon':
      return { type: 'icon', label, default: value };
  }
}

/**
 * Turn one field fixed in the design into a new property each placement fills in, starting from what the design
 * shows: the property, then the binding, in one change (one Undo). Null when the field is not fixed in the design (a
 * property or a list item fills it in already) or the component has no room for another property.
 */
export function bindNewProperty(state: ProjectState, def: ComponentDefinition, node: GraphNode, field: ContentField, label: string): { prop: string; operations: EditOperation[] } | null {
  if (Object.keys(def.properties).length >= MAX_PROPERTIES) return null;
  if (isBinding((node as unknown as Record<string, unknown>)[field])) return null;
  const text = label.trim() || suggestedPropLabel(def, node, field);
  const base = toCodeName(text) ?? toCodeName(`${nodeWord(node)} ${field}`) ?? field;
  const prop = freeName(base, takenPropNames(state, def), validPropName);
  const value = (node as unknown as Record<string, unknown>)[field];
  return {
    prop,
    operations: [
      { type: 'component.setPropSchema', definitionId: def.id, prop, schema: newPropSchema(node, field, value, text) },
      { type: 'node.setBinding', owner: owner(def), nodeId: node.id, field, binding: { $prop: prop } }
    ]
  };
}

/** A property (or one field of an object property) that a node's field can show. */
export interface BindChoice {
  binding: { $prop: string; field?: string };
  label: string;
}

/** The properties a field of a node can show, in the component's order: the type fits and every value it can hold does. */
export function bindChoices(state: ProjectState, def: ComponentDefinition, node: GraphNode, field: ContentField): BindChoice[] {
  const ok = acceptedTypes(node, field as BindField) ?? [];
  const fits = (schema: PropSchema) => ok.includes(schema.type) && !bindingProblem(state, { node, field: field as BindField }, schema);
  const current = (node as unknown as Record<string, unknown>)[field];
  const now = isBinding(current) && '$prop' in current ? current : undefined;
  const out: BindChoice[] = [];
  for (const [name, schema] of Object.entries(def.properties)) {
    if (schema.type === 'object') {
      for (const [f, fs] of Object.entries(schema.fields))
        if (fits(fs) && !(now?.$prop === name && now.field === f)) out.push({ binding: { $prop: name, field: f }, label: `${schema.label} → ${fs.label}` });
    } else if (fits(schema) && !(now?.$prop === name && now.field === undefined)) out.push({ binding: { $prop: name }, label: schema.label });
  }
  return out;
}

/** Show an existing property (or one field of an object property) in a field of the design. */
export function bindExistingOp(def: ComponentDefinition, nodeId: string, field: ContentField, binding: BindChoice['binding']): EditOperation {
  return { type: 'node.setBinding', owner: owner(def), nodeId, field, binding };
}

/** Make a bound field the same in every placement again: it keeps the property's default, and the property stays. */
export function unbindOp(def: ComponentDefinition, nodeId: string, field: ContentField): EditOperation {
  return { type: 'node.setBinding', owner: owner(def), nodeId, field, binding: null };
}

const USE_WORDS: Partial<Record<BindField, string>> = {
  text: 'text',
  label: 'text',
  link: 'link',
  image: 'image',
  icon: 'icon',
  fallbackAlt: 'alt text',
  appearance: 'look',
  iconPosition: 'icon side',
  ariaLabel: 'accessible name',
  datetime: 'date',
  tag: 'tag',
  action: 'action',
  when: 'visibility',
  unless: 'visibility',
  list: 'items',
  variant: 'style choice'
};

/** Where the design shows a property: "Heading text", "Card visibility". Empty when nothing does, so it can be removed. */
export function propertyUses(def: ComponentDefinition, prop: string): string[] {
  const out: string[] = [];
  for (const site of bindingSites(def)) {
    if (!('$prop' in site.binding) || site.binding.$prop !== prop) continue;
    const what = site.field === 'prop' ? `“${site.prop}” input` : (USE_WORDS[site.field] ?? site.field);
    const text = `${nodeName(site.node)} ${what}`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** A heading level: a choice of h1 to h6. It changes the page outline, not the look. */
export const isHeadingLevel = (schema: PropSchema | ScalarPropSchema) => schema.type === 'enum' && schema.options.length > 1 && schema.options.every((o) => /^h[1-6]$/.test(o.value));

/**
 * The component's properties in the order each placement's Content lists them: in the component's order, with heading
 * levels after the content rather than between a heading and the words under it.
 */
export function placementOrder(def: Pick<ComponentDefinition, 'properties'>): string[] {
  const keys = Object.keys(def.properties);
  return [...keys.filter((k) => !isHeadingLevel(def.properties[k])), ...keys.filter((k) => isHeadingLevel(def.properties[k]))];
}

/**
 * Move a property up (-1) or down (1) the list placements show. Null where that would not change what they show: at
 * either end, or across from the content to the heading levels, which always come last.
 */
export function movePropOp(def: ComponentDefinition, prop: string, delta: -1 | 1): EditOperation | null {
  const order = placementOrder(def);
  const i = order.indexOf(prop);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return null;
  if (isHeadingLevel(def.properties[order[i]]) !== isHeadingLevel(def.properties[order[j]])) return null;
  [order[i], order[j]] = [order[j], order[i]];
  return { type: 'component.orderProperties', definitionId: def.id, order };
}

/** Rename what authors see a property called; its name in the design and every placement's value stay. */
export function renamePropOp(def: ComponentDefinition, prop: string, label: string): EditOperation | null {
  const schema = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
  const text = label.trim();
  if (!schema || !text || text === schema.label) return null;
  return { type: 'component.setPropSchema', definitionId: def.id, prop, schema: { ...(schema as unknown as Record<string, unknown>), label: text } };
}

/** The part a node of the design is, if any. */
export function partOf(def: ComponentDefinition, nodeId: string): { id: string; part: PartDef } | null {
  for (const [id, part] of Object.entries(def.parts)) if (part.nodeId === nodeId) return { id, part };
  return null;
}

/**
 * Whether a node can be offered as a part each placement may style: an element of its own (not a slot or repeat, which
 * render none), not the root (always the whole component), and not one already.
 */
export function canExposePart(def: ComponentDefinition, node: GraphNode): boolean {
  if (def.kind !== 'managed' || !def.tree) return false;
  if (node.kind === 'slot' || node.kind === 'repeat') return false;
  return def.tree.rootIds[0] !== node.id && !partOf(def, node.id);
}

/**
 * Let each placement style a node of the design, as a part called `label`. Its name is one no placement still keeps
 * styles under (for a part removed long ago), so none of them restyles it before the author does.
 */
export function exposePartOp(state: ProjectState, def: ComponentDefinition, node: GraphNode, label: string): EditOperation {
  const text = label.trim() || nodeName(node);
  const base = toCodeName(text) ?? toCodeName(nodeWord(node)) ?? 'part';
  const taken = new Set([...Object.keys(def.parts), 'root']);
  for (const { node: p } of instancesOf(state, def.id)) for (const k of [...Object.keys(p.overrides ?? {}), ...Object.keys(p.itemOverrides ?? {})]) taken.add(k);
  const partId = freeName(base, taken, validPropName);
  return { type: 'component.setPart', definitionId: def.id, partId, nodeId: node.id, label: text };
}

/** Rename a part; its styles on every placement stay. */
export function renamePartOp(def: ComponentDefinition, partId: string, label: string): EditOperation | null {
  const part = Object.hasOwn(def.parts, partId) ? def.parts[partId] : undefined;
  const text = label.trim();
  if (!part || !text || text === part.label) return null;
  return { type: 'component.setPart', definitionId: def.id, partId, nodeId: part.nodeId, label: text };
}

/** "Dark tone" becomes dark-tone: a variant option's ID. */
function optionSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 37)
    .replace(/-+$/, '');
}

/**
 * A free option ID from a label, never "default" (which an axis falls back to) or a name an operation refuses, and
 * at most 40 characters with its suffix.
 */
function freeOption(label: string, taken: Set<string>): string {
  const base = optionSlug(label) || 'option';
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if ((!taken.has(id) && id !== 'default' && !isProtoKey(id) && !RESERVED_IDS.has(id)) || n > 9999) return id;
  }
}

/** What placements of the component still choose on each axis, valid or not: a new axis or option must not take a name one of them holds. */
function storedChoices(state: ProjectState, def: ComponentDefinition): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { node } of instancesOf(state, def.id))
    for (const [axis, v] of Object.entries(node.variants ?? {})) {
      if (!out.has(axis)) out.set(axis, new Set());
      if (typeof v === 'string') out.get(axis)!.add(v);
    }
  return out;
}

/**
 * A new group of looks placements choose between ("Tone"), with its first option ("Dark"). The group starts with a
 * plain Default option that every placement keeps, so nothing changes until a placement picks the new one.
 */
export function addVariantGroupOp(state: ProjectState, def: ComponentDefinition, groupLabel: string, optionLabel: string): EditOperation {
  const group = groupLabel.trim() || 'Style';
  const axis = freeName(toCodeName(group) ?? 'style', new Set([...Object.keys(def.variantAxes ?? {}), ...storedChoices(state, def).keys()]), validPropName);
  const label = optionLabel.trim() || 'Option';
  return { type: 'component.setVariant', definitionId: def.id, axis, axisLabel: group, variant: freeOption(label, new Set()), label };
}

/** A new option of a group. */
export function addVariantOp(state: ProjectState, def: ComponentDefinition, axis: string, label: string): EditOperation | null {
  const a = def.variantAxes?.[axis];
  if (!a) return null;
  const text = label.trim() || 'Option';
  const taken = new Set([...Object.keys(a.options), ...(storedChoices(state, def).get(axis) ?? [])]);
  return { type: 'component.setVariant', definitionId: def.id, axis, variant: freeOption(text, taken), label: text };
}

/** Rename an option; its styles and every placement's choice of it stay. */
export function renameVariantOp(def: ComponentDefinition, axis: string, id: string, label: string): EditOperation | null {
  const option = def.variantAxes?.[axis]?.options[id];
  const text = label.trim();
  if (!option || !text || text === option.label) return null;
  return { type: 'component.setVariant', definitionId: def.id, axis, variant: id, label: text };
}

/** Rename a group. */
export function renameVariantGroupOp(def: ComponentDefinition, axis: string, label: string): EditOperation | null {
  const a = axesOf(def).find(([id]) => id === axis)?.[1];
  const text = label.trim();
  if (!a || !text || text === a.label) return null;
  return { type: 'component.setVariant', definitionId: def.id, axis, axisLabel: text, variant: a.default, label: a.options[a.default].label };
}

/** The option placements that have not chosen one show. */
export function defaultVariantOp(def: ComponentDefinition, axis: string, id: string): EditOperation | null {
  const option = def.variantAxes?.[axis]?.options[id];
  return option ? { type: 'component.setVariant', definitionId: def.id, axis, variant: id, label: option.label, makeDefault: true } : null;
}

/** Remove an option: placements that chose it go back to the group's default. */
export function removeVariantOp(def: ComponentDefinition, axis: string, id: string): EditOperation {
  return { type: 'component.removeVariant', definitionId: def.id, axis, variant: id };
}

/** Which option of which group Edit everywhere styles: the base design when null. */
export type StyleTarget = { axis: string; variant: string } | null;

/** The target as it still is in the definition: an option that was removed (an Undo, the AI) falls back to the base. */
export function liveStyleTarget(def: Pick<ComponentDefinition, 'variantAxes'>, target: StyleTarget): StyleTarget {
  if (!target) return null;
  const a: VariantAxis | undefined = axesOf(def).find(([id]) => id === target.axis)?.[1];
  return a && Object.hasOwn(a.options, target.variant) ? target : null;
}

/** Whether a node of the design can carry a variant's styles: the engine refuses repeats, slots and later top-level nodes. */
export function variantStylable(def: ComponentDefinition, node: GraphNode): boolean {
  if (node.kind === 'repeat' || node.kind === 'slot') return false;
  return (def.tree?.rootIds.indexOf(node.id) ?? -1) <= 0;
}
