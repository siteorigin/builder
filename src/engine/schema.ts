/**
 * Property schema validation for component definitions, and where a managed definition binds its properties.
 */
import type { Binding, ComponentDefinition, GraphNode, ListProp, NodeTree, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { fail, findParent } from './tree';
import { normalizeProp } from './values';

const PROP_TYPES = ['string', 'richtext', 'number', 'boolean', 'enum', 'link', 'image', 'icon', 'list'] as const;

/** Names generated code already uses (props, helpers, repeat variables), or that cannot be a destructured identifier. */
const RESERVED = new Set([
  'variant', 'class', 'className', 'children', 'item', 'props', 'has', 'id', 'page',
  'await', 'break', 'case', 'catch', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'arguments', 'eval', 'undefined'
]);

/** Names that would resolve to an inherited object member when used as a lookup key. */
export const isProtoKey = (name: string) => name in Object.prototype;

export function checkPropName(name: string, what = 'Property') {
  if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(name)) fail(`${what} names must be camelCase identifiers ("${name}").`);
  // Repeat item variables are item, item2, item3…
  if (RESERVED.has(name) || /^item\d+$/.test(name) || isProtoKey(name)) fail(`"${name}" is a reserved name. Choose another ${what.toLowerCase()} name.`);
}

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, label: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${label} must be a number.`);
  return n;
};
const count = (v: unknown, label: string): number | undefined => {
  const n = num(v, label);
  if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 1000)) fail(`${label} must be a whole number from 0 to 1000.`);
  return n;
};

/**
 * Validate and normalize a full property schema supplied by a person or the AI. Unknown keys are dropped;
 * the default is checked against the schema itself (and list items get stable IDs).
 */
export function normalizePropSchema(raw: unknown, state: ProjectState, name: string, inList = false): PropSchema {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Property "${name}" needs a schema object with a type.`);
  const r = raw as Record<string, unknown>;
  const type = String(r.type) as (typeof PROP_TYPES)[number];
  const allowed = inList ? PROP_TYPES.filter((t) => t !== 'list') : PROP_TYPES;
  if (!(allowed as readonly string[]).includes(type)) fail(`Property "${name}" needs a type of ${allowed.join(', ')}.`);
  const out: Record<string, unknown> = { type, label: text(r.label, 80) ?? name };
  const description = text(r.description, 300);
  if (description) out.description = description;
  const group = text(r.group, 40);
  if (group) out.group = group;
  const label = `Property "${name}"`;
  switch (type) {
    case 'string': {
      if (r.multiline !== undefined) out.multiline = !!r.multiline;
      const maxLength = count(r.maxLength, `${label} maxLength`);
      if (maxLength) out.maxLength = maxLength;
      out.default = '';
      break;
    }
    case 'richtext':
      if (r.plainAs !== undefined) {
        if (typeof r.plainAs !== 'string' || !['ul', 'ol', 'check'].includes(r.plainAs)) fail(`${label}: plainAs must be ul, ol or check.`);
        out.plainAs = r.plainAs;
      }
      out.default = [];
      break;
    case 'number': {
      const min = num(r.min, `${label} min`);
      const max = num(r.max, `${label} max`);
      const step = num(r.step, `${label} step`);
      if (min !== undefined && max !== undefined && min > max) fail(`${label}: min is greater than max.`);
      if (step !== undefined && step <= 0) fail(`${label}: step must be greater than 0.`);
      if (min !== undefined) out.min = min;
      if (max !== undefined) out.max = max;
      if (step !== undefined) out.step = step;
      out.default = min ?? (max !== undefined && max < 0 ? max : 0);
      break;
    }
    case 'boolean':
      out.default = false;
      break;
    case 'enum': {
      if (!Array.isArray(r.options) || !r.options.length || r.options.length > 50) fail(`${label}: an enum needs 1 to 50 options.`);
      const seen = new Set<string>();
      out.options = r.options.map((o) => {
        const value = typeof o === 'string' ? o : String((o as { value?: unknown })?.value ?? '');
        if (!value || value.length > 60) fail(`${label}: every option needs a value of up to 60 characters.`);
        if (seen.has(value)) fail(`${label}: option "${value}" is listed twice.`);
        seen.add(value);
        return { value, label: (typeof o === 'object' && text((o as { label?: unknown }).label, 80)) || value };
      });
      out.default = (out.options as Array<{ value: string }>)[0].value;
      break;
    }
    case 'link':
      out.default = { type: 'none', target: '' };
      break;
    case 'image':
      out.default = { assetId: null, alt: '' };
      break;
    case 'icon':
      out.default = 'sparkles';
      break;
    case 'list': {
      if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields)) fail(`${label}: a list needs fields.`);
      const entries = Object.entries(r.fields as Record<string, unknown>);
      if (!entries.length || entries.length > 20) fail(`${label}: a list needs 1 to 20 fields.`);
      const fields: Record<string, ScalarPropSchema> = {};
      for (const [k, f] of entries) {
        checkPropName(k, 'Field');
        fields[k] = normalizePropSchema(f, state, `${name}.${k}`, true) as ScalarPropSchema;
      }
      out.fields = fields;
      out.itemLabel = text(r.itemLabel, 40) ?? 'Item';
      const titleField = text(r.titleField, 40);
      if (titleField) {
        if (!Object.hasOwn(fields, titleField)) fail(`${label}: titleField "${titleField}" is not one of its fields.`);
        out.titleField = titleField;
      }
      const min = count(r.min, `${label} min`);
      const max = count(r.max, `${label} max`);
      if (min !== undefined && max !== undefined && min > max) fail(`${label}: min is greater than max.`);
      if (min !== undefined) out.min = min;
      if (max !== undefined) out.max = max;
      out.default = [];
      break;
    }
  }
  const schema = out as unknown as PropSchema;
  const value = r.default === undefined ? (schema.type === 'list' && schema.min ? Array.from({ length: schema.min }, () => ({})) : schema.default) : r.default;
  (schema as { default: unknown }).default = normalizeProp(schema, value, state, `${label} default`);
  return schema;
}

/** Normalize a whole `{ name: schema }` map. */
export function normalizeProperties(raw: Record<string, unknown> | undefined, state: ProjectState): Record<string, PropSchema> {
  const out: Record<string, PropSchema> = {};
  const entries = Object.entries(raw ?? {});
  if (entries.length > 60) fail('A component can have at most 60 properties.');
  for (const [k, v] of entries) {
    checkPropName(k);
    out[k] = normalizePropSchema(v, state, k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binding sites
// ---------------------------------------------------------------------------

export type BindField = 'text' | 'image' | 'link' | 'label' | 'appearance' | 'icon' | 'when' | 'unless' | 'list' | 'prop';

/** Property types each bindable node field accepts. `null` means any type (visibility conditions). */
export function acceptedTypes(node: GraphNode, field: BindField, nested?: PropSchema): readonly string[] | null {
  switch (field) {
    case 'when':
    case 'unless':
      return null;
    case 'text':
      return node.kind === 'text' && node.rich ? ['richtext'] : ['string', 'number', 'enum'];
    case 'label':
      return ['string', 'number', 'enum'];
    case 'appearance':
      return ['enum', 'string'];
    case 'icon':
      return ['icon', 'enum', 'string'];
    case 'image':
      return ['image'];
    case 'link':
      return ['link'];
    case 'list':
      return ['list'];
    case 'prop':
      return nested ? [nested.type] : null;
  }
}

export interface BindingSite {
  node: GraphNode;
  field: BindField;
  prop?: string;
  binding: Binding;
}

/** Every binding in a managed definition's tree. */
export function bindingSites(def: ComponentDefinition): BindingSite[] {
  const out: BindingSite[] = [];
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    const add = (field: BindField, v: unknown, prop?: string) => isBinding(v) && out.push({ node: n, field, binding: v, prop });
    add('when', n.when);
    add('unless', n.unless);
    if (n.kind === 'text') add('text', n.text);
    if (n.kind === 'image') add('image', n.image);
    if (n.kind === 'link') (add('link', n.link), add('label', n.label), add('appearance', n.appearance));
    if (n.kind === 'icon') add('icon', n.icon);
    if (n.kind === 'repeat') add('list', n.list);
    if (n.kind === 'instance') for (const [k, v] of Object.entries(n.props)) add('prop', v, k);
  }
  return out;
}

/** The list property repeated by the nearest repeat above a node, or null outside any repeat. */
export function enclosingList(def: ComponentDefinition, nodeId: string): ListProp | null {
  const tree = def.tree as NodeTree;
  let cur = findParent(tree, nodeId);
  while (cur && cur.parentId) {
    const p = tree.nodes[cur.parentId];
    if (p?.kind === 'repeat') {
      const schema = def.properties[p.list.$prop];
      return schema?.type === 'list' ? schema : null;
    }
    cur = findParent(tree, cur.parentId);
  }
  return null;
}

/** The schema a binding at this node resolves to, or undefined when it does not resolve. */
export function boundSchema(def: ComponentDefinition, nodeId: string, b: Binding): PropSchema | undefined {
  if ('$prop' in b) return Object.hasOwn(def.properties, b.$prop) ? def.properties[b.$prop] : undefined;
  const list = enclosingList(def, nodeId);
  return list && Object.hasOwn(list.fields, b.$item) ? list.fields[b.$item] : undefined;
}
