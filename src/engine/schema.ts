/**
 * Property schema validation for component definitions, and where a managed definition binds its properties.
 */
import type { Binding, ComponentDefinition, Comparison, GraphNode, ListFeed, ListProp, NodeTree, PageTeaser, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { ELEMENT_ACTIONS, ELEMENT_TAGS, ICON_POSITIONS, LIST_FEEDS, RICH_CODE_FORMS, TEXT_TAGS, conditionRef, isBinding, isComparison } from '@shared/types';
import { ARTICLE_ROW_FIELDS } from '@shared/articles';
import { PAGE_TEASER_TYPES, type PageTeaserValue } from '@shared/page-teasers';
import { axesOf } from '@shared/variants';
import { fail, findParent } from './tree';
import { normalizeProp } from './values';

const PROP_TYPES = ['string', 'richtext', 'number', 'boolean', 'enum', 'link', 'image', 'icon', 'choices', 'list', 'table'] as const;

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
 * A page list's mapping: a link field, and distinct fields of the right type for the page's title, description and
 * image. Deleting a page removes the items linked to it, so the list must be allowed to have none.
 */
function pageTeaserSchema(raw: unknown, fields: Record<string, ScalarPropSchema>, min: number | undefined, label: string): PageTeaser {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label}: pageTeaser needs an object naming the item's link field and the fields the page fills.`);
  const r = raw as Record<string, unknown>;
  if (min) fail(`${label}: a page list cannot have a minimum, since deleting a page removes its items.`);
  const used = new Set<string>();
  const pick = (key: 'link' | PageTeaserValue, type: ScalarPropSchema['type'], required: boolean): string | undefined => {
    if (r[key] === undefined && !required) return undefined;
    const f = typeof r[key] === 'string' ? (r[key] as string) : '';
    if (!Object.hasOwn(fields, f)) fail(`${label}: pageTeaser.${key} "${f}" is not one of its fields.`);
    if (fields[f].type !== type) fail(`${label}: pageTeaser.${key} "${f}" must be a ${type} field.`);
    if (used.has(f)) fail(`${label}: pageTeaser uses the field "${f}" more than once.`);
    used.add(f);
    return f;
  };
  const out: PageTeaser = { link: pick('link', 'link', true)!, title: pick('title', PAGE_TEASER_TYPES.title, true)! };
  for (const what of ['description', 'image'] as const) {
    const f = pick(what, PAGE_TEASER_TYPES[what], false);
    if (f) out[what] = f;
  }
  return out;
}

/**
 * A computed list (see shared/articles.ts): which pages it holds, and fields of the right type for the row values
 * it fills by name. Its items come and go with the site's pages, so it cannot ask for a minimum.
 */
function feedSchema(raw: unknown, fields: Record<string, ScalarPropSchema>, min: number | undefined, label: string): ListFeed {
  if (typeof raw !== 'string' || !(LIST_FEEDS as readonly string[]).includes(raw)) fail(`${label}: feed must be one of ${LIST_FEEDS.map((f) => `"${f}"`).join(', ')}.`);
  if (min) fail(`${label}: a computed list cannot have a minimum, since its items come from the site's pages.`);
  for (const [f, type] of Object.entries(ARTICLE_ROW_FIELDS)) {
    if (Object.hasOwn(fields, f) && fields[f].type !== type) fail(`${label}: the field "${f}" of a computed list must be a ${type} field.`);
  }
  if (!Object.keys(fields).some((f) => Object.hasOwn(ARTICLE_ROW_FIELDS, f))) fail(`${label}: a computed list needs at least one field it fills (${Object.keys(ARTICLE_ROW_FIELDS).join(', ')}).`);
  return raw as ListFeed;
}

/**
 * Validate and normalize a full property schema supplied by a person or the AI. Unknown keys are dropped;
 * the default is checked against the schema itself (and list items get stable IDs).
 */
export function normalizePropSchema(raw: unknown, state: ProjectState, name: string, inList = false): PropSchema {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Property "${name}" needs a schema object with a type.`);
  const r = raw as Record<string, unknown>;
  const type = String(r.type) as (typeof PROP_TYPES)[number];
  // A list item's fields are single values: a list or a table inside one has no editor or tool shape.
  const allowed = inList ? PROP_TYPES.filter((t) => t !== 'list' && t !== 'table') : PROP_TYPES;
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
      if (r.codeForm !== undefined) {
        if (typeof r.codeForm !== 'string' || !(RICH_CODE_FORMS as readonly string[]).includes(r.codeForm)) fail(`${label}: codeForm must be ${RICH_CODE_FORMS.join(' or ')}.`);
        out.codeForm = r.codeForm;
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
    case 'choices':
      out.default = [];
      break;
    case 'table':
      out.default = { columns: [{ label: 'Column 1' }, { label: 'Column 2' }], rows: [] };
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
      if (r.pageTeaser !== undefined) out.pageTeaser = pageTeaserSchema(r.pageTeaser, fields, min, label);
      if (r.feed !== undefined) {
        out.feed = feedSchema(r.feed, fields, min, label);
        if (out.pageTeaser) fail(`${label}: a list is either computed from the site's pages (feed) or a page list (pageTeaser), not both.`);
        // A computed list stores nothing: whatever default was sent would never show.
        out.default = [];
        break;
      }
      out.default = [];
      break;
    }
  }
  const schema = out as unknown as PropSchema;
  if (schema.type === 'list' && schema.feed) return schema;
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

export type BindField =
  | 'text'
  | 'image'
  | 'fallbackAlt'
  | 'link'
  | 'label'
  | 'appearance'
  | 'icon'
  | 'iconPosition'
  | 'ariaLabel'
  | 'datetime'
  | 'tag'
  | 'action'
  | 'when'
  | 'unless'
  | 'list'
  | 'prop'
  | 'variant';

/** Property types each bindable node field accepts. `null` means any type (visibility conditions). */
export function acceptedTypes(node: GraphNode, field: BindField, nested?: PropSchema): readonly string[] | null {
  switch (field) {
    case 'when':
    case 'unless':
      return null;
    case 'text':
      return node.kind === 'text' && node.rich ? ['richtext'] : ['string', 'number', 'enum'];
    case 'label':
    case 'fallbackAlt':
      return ['string', 'number', 'enum'];
    case 'appearance':
      return ['enum', 'string'];
    case 'icon':
      return ['icon', 'enum', 'string'];
    case 'ariaLabel':
      return ['string', 'enum'];
    case 'datetime':
      return ['string'];
    // Each option must be a value the field can take (see `bindingProblem`), so only a choice fits.
    case 'tag':
    case 'variant':
    case 'iconPosition':
    case 'action':
      return ['enum'];
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

/** One place a node can hold a binding: the field, its current value, and a way to replace that value. */
export interface BindingSlot {
  field: BindField;
  /** For `prop`, the nested property; for `variant`, the axis. */
  prop?: string;
  value: unknown;
  set: (v: unknown) => void;
}

/** Every place a node can hold a binding, bound or not. Conditions are listed as they are (plain or compared). */
export function bindingSlots(n: GraphNode): BindingSlot[] {
  const r = n as unknown as Record<string, unknown>;
  const field = (f: BindField, key: string = f): BindingSlot => ({ field: f, value: r[key], set: (v) => (r[key] = v) });
  const out: BindingSlot[] = [field('when'), field('unless')];
  switch (n.kind) {
    case 'element':
      out.push(field('tag'), field('link'), field('action'), field('ariaLabel'));
      break;
    case 'text':
      out.push(field('text'), field('tag'), field('datetime'));
      break;
    case 'image':
      out.push(field('image'), field('fallbackAlt'));
      break;
    case 'link':
      out.push(field('link'), field('label'), field('appearance'), field('icon'), field('iconPosition'), field('ariaLabel'));
      break;
    case 'icon':
      out.push(field('icon'), field('ariaLabel'));
      break;
    case 'repeat':
      out.push(field('list'));
      break;
    case 'instance':
      for (const k of Object.keys(n.props)) out.push({ field: 'prop', prop: k, value: n.props[k], set: (v) => (n.props[k] = v) });
      for (const k of Object.keys(n.variants ?? {})) out.push({ field: 'variant', prop: k, value: n.variants![k], set: (v) => (n.variants![k] = v as string) });
      break;
  }
  return out;
}

export interface BindingSite {
  node: GraphNode;
  field: BindField;
  /** For `prop`, the nested property; for `variant`, the axis. */
  prop?: string;
  binding: Binding;
  /** The comparison a `when` or `unless` makes with its binding, if it is not a plain presence test. */
  comparison?: Comparison;
}

/** Every binding in a managed definition's tree, including the binding a compared condition reads. */
export function bindingSites(def: ComponentDefinition): BindingSite[] {
  const out: BindingSite[] = [];
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    for (const slot of bindingSlots(n)) {
      const condition = slot.field === 'when' || slot.field === 'unless';
      const binding = condition ? conditionRef(slot.value) : isBinding(slot.value) ? slot.value : undefined;
      if (!binding) continue;
      out.push({ node: n, field: slot.field, prop: slot.prop, binding, ...(condition && isComparison(slot.value) ? { comparison: slot.value } : {}) });
    }
  }
  return out;
}

const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);
const ELEMENT_TAG_SET = new Set<string>(ELEMENT_TAGS);
const optionValues = (schema: PropSchema) => (schema.type === 'enum' ? schema.options.map((o) => o.value) : []);
const listed = (values: string[]) => values.map((v) => `"${v}"`).join(', ');

/**
 * What is wrong with a binding site whose binding resolves to `schema`, beyond the property type (which
 * `acceptedTypes` covers): a compared value the property can never hold, or a choice with an option the field
 * cannot take (a tag that is not one, a variant the nested component lacks, an icon side other than start or end).
 * Null when it fits. Shared by load validation, binding and property changes, so every path refuses the same.
 */
export function bindingProblem(state: ProjectState, site: Pick<BindingSite, 'node' | 'field' | 'prop' | 'comparison'>, schema: PropSchema): string | null {
  const { node, field, comparison } = site;
  if (comparison) {
    const value = 'eq' in comparison ? comparison.eq : comparison.ne;
    const shown = JSON.stringify(value);
    switch (schema.type) {
      case 'boolean':
        return typeof value === 'boolean' ? null : `compares a yes/no property with ${shown}; compare it with true or false.`;
      case 'number':
        return typeof value === 'number' && Number.isFinite(value) ? null : `compares a number property with ${shown}; compare it with a number.`;
      case 'string':
      case 'icon':
        return typeof value === 'string' ? null : `compares a text property with ${shown}; compare it with text.`;
      case 'enum':
        return typeof value === 'string' && optionValues(schema).includes(value) ? null : `compares a choice with ${shown}, which is not one of its options (${listed(optionValues(schema))}).`;
      default:
        return `compares a ${schema.type} property with a value; a ${schema.type} can only be tested for being set.`;
    }
  }
  // Older fields are type-checked where they are bound; documents saved before these checks keep loading as they did.
  // Rich text has only ever been bindable to rich text properties, so only a hand-edited document shows anything else.
  const fresh =
    ['tag', 'variant', 'iconPosition', 'ariaLabel', 'action', 'datetime'].includes(field) ||
    (field === 'link' && node.kind === 'element') ||
    (field === 'icon' && node.kind === 'link') ||
    (field === 'text' && node.kind === 'text' && !!node.rich);
  const ok = acceptedTypes(node, field, undefined);
  if (!fresh || !ok) return null;
  if (!ok.includes(schema.type)) return `shows a ${schema.type} property as its ${field}, which needs a ${ok.join(' or ')} property.`;
  const options = optionValues(schema);
  switch (field) {
    case 'datetime':
      return node.kind === 'text' && node.rich ? 'gives rich text a date; only plain text can state one.' : null;
    case 'tag': {
      if (node.kind === 'text' && node.rich) return 'binds the tag of rich text, which keeps its own paragraph structure.';
      const allowed = node.kind === 'text' ? TEXT_TAG_SET : ELEMENT_TAG_SET;
      const bad = options.filter((o) => !allowed.has(o));
      return bad.length ? `takes its tag from a choice whose options ${listed(bad)} are not ${node.kind === 'text' ? 'text' : 'element'} tags.` : null;
    }
    case 'variant': {
      const nested = node.kind === 'instance' ? state.components[node.definitionId] : undefined;
      const axis = nested ? axesOf(nested).find(([a]) => a === site.prop)?.[1] : undefined;
      if (!nested || !axis) return `binds the variant axis "${site.prop}", which ${nested ? `"${nested.name}"` : 'the nested component'} does not have.`;
      const bad = options.filter((o) => !Object.hasOwn(axis.options, o));
      return bad.length ? `takes its ${axis.label ?? site.prop} from a choice whose options ${listed(bad)} are not options of "${nested.name}".` : null;
    }
    case 'iconPosition': {
      const bad = options.filter((o) => !(ICON_POSITIONS as string[]).includes(o));
      return bad.length ? `takes its icon side from a choice whose options ${listed(bad)} are not ${listed(ICON_POSITIONS)}.` : null;
    }
    case 'action': {
      const bad = options.filter((o) => !(ELEMENT_ACTIONS as string[]).includes(o));
      return bad.length ? `takes what a click does from a choice whose options ${listed(bad)} are not ${listed(ELEMENT_ACTIONS)}.` : null;
    }
    default:
      return null;
  }
}

/** The list property repeated by the nearest repeat above a node, or null outside any repeat. */
export function enclosingList(def: ComponentDefinition, nodeId: string): ListProp | null {
  const tree = def.tree as NodeTree;
  // A hand-edited tree can list a node under itself; each ancestor is visited once.
  const seen = new Set<string>([nodeId]);
  let cur = findParent(tree, nodeId);
  while (cur && cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
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
