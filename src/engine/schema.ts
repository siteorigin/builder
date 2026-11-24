/**
 * Property schema validation for component definitions, and where a managed definition binds its properties.
 */
import type { BindingRef, ComponentDefinition, Comparison, GraphNode, ListFeed, ListProp, NodeTree, PageTeaser, ProjectState, PropSchema, ScalarPropSchema, StateRef, TokenGroup, UiStateSchema } from '@shared/types';
import { ELEMENT_ACTIONS, ELEMENT_TAGS, ICON_POSITIONS, LIST_FEEDS, RICH_CODE_FORMS, STATE_ACTION_OPS, TEXT_TAGS, UI_STATE_TYPES, conditionRef, isBinding, isBindingRef, isComparison, isStateRef } from '@shared/types';
import { ARTICLE_ROW_FIELDS } from '@shared/articles';
import { PAGE_TEASER_TYPES, type PageTeaserValue } from '@shared/page-teasers';
import { axesOf } from '@shared/variants';
import { propBindingSchema } from '@shared/bindings';
import { fail, findParent } from './tree';
import { normalizeProp } from './values';
import { declaredTokens } from './tokens';

const PROP_TYPES = ['string', 'richtext', 'number', 'boolean', 'enum', 'link', 'image', 'icon', 'choices', 'token', 'list', 'table', 'object'] as const;
/** Token groups a token property can choose from. A text style is several values at once, so no style can bind one. */
const TOKEN_PROP_GROUPS: readonly TokenGroup[] = ['color', 'font', 'space', 'container', 'radius', 'shadow', 'border'];

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
  // A list item's or an object's fields are single values: a list, a table or an object inside one has no editor or
  // tool shape.
  const allowed = inList ? PROP_TYPES.filter((t) => t !== 'list' && t !== 'table' && t !== 'object') : PROP_TYPES;
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
    case 'token': {
      const group = r.tokenGroup;
      if (typeof group !== 'string' || !(TOKEN_PROP_GROUPS as readonly string[]).includes(group)) fail(`${label}: tokenGroup must be one of ${TOKEN_PROP_GROUPS.join(', ')}.`);
      out.tokenGroup = group;
      const first = declaredTokens(state).find((t) => t.group === group);
      if (!first) fail(`${label}: the site has no ${group} tokens to choose from.`);
      out.default = { token: first.id };
      break;
    }
    case 'object': {
      out.fields = fieldSchemas(r.fields, state, name, label, 'an object');
      out.default = {};
      break;
    }
    case 'table':
      out.default = { columns: [{ label: 'Column 1' }, { label: 'Column 2' }], rows: [] };
      break;
    case 'list': {
      const fields = fieldSchemas(r.fields, state, name, label, 'a list');
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

/** The named single-value fields of a list item or an object: 1 to 20, each a camelCase name. */
function fieldSchemas(raw: unknown, state: ProjectState, name: string, label: string, what: string): Record<string, ScalarPropSchema> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label}: ${what} needs fields.`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > 20) fail(`${label}: ${what} needs 1 to 20 fields.`);
  const fields: Record<string, ScalarPropSchema> = {};
  for (const [k, f] of entries) {
    checkPropName(k, 'Field');
    fields[k] = normalizePropSchema(f, state, `${name}.${k}`, true) as ScalarPropSchema;
  }
  return fields;
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
  /** A property, a list item field, or (in a condition or a nested variant axis) the definition's UI state. */
  binding: BindingRef;
  /** The comparison a `when` or `unless` makes with its binding, if it is not a plain presence test. */
  comparison?: Comparison;
}

/** Every binding in a managed definition's tree, including the binding a compared condition reads. */
export function bindingSites(def: ComponentDefinition): BindingSite[] {
  const out: BindingSite[] = [];
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    for (const slot of bindingSlots(n)) {
      const condition = slot.field === 'when' || slot.field === 'unless';
      const binding = condition ? conditionRef(slot.value) : isBindingRef(slot.value) ? slot.value : undefined;
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
export function bindingProblem(state: ProjectState, site: Pick<BindingSite, 'node' | 'field' | 'prop' | 'comparison'>, schema: PropSchema, what: 'property' | 'state' = 'property'): string | null {
  const { node, field, comparison } = site;
  if (comparison) {
    const value = 'eq' in comparison ? comparison.eq : comparison.ne;
    const shown = JSON.stringify(value);
    switch (schema.type) {
      case 'boolean':
        return typeof value === 'boolean' ? null : `compares a yes/no ${what} with ${shown}; compare it with true or false.`;
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
  // A whole object or token passed on to a nested component must mean the same there: the same fields, the same group.
  if (field === 'prop' && node.kind === 'instance' && (schema.type === 'object' || schema.type === 'token')) {
    const nested = state.components[node.definitionId];
    const to = nested && site.prop !== undefined && Object.hasOwn(nested.properties, site.prop) ? nested.properties[site.prop] : undefined;
    if (to?.type === 'object' && schema.type === 'object' && fieldShape(to) !== fieldShape(schema))
      return `passes "${schema.label}" to "${to.label}" of "${nested!.name}", whose fields differ (${fieldShape(to) || 'none'}).`;
    if (to?.type === 'token' && schema.type === 'token' && to.tokenGroup !== schema.tokenGroup)
      return `passes the ${schema.tokenGroup} token "${schema.label}" to "${to.label}" of "${nested!.name}", which takes a ${to.tokenGroup} token.`;
  }
  // A whole list passed on: its token fields must take tokens of the same group as the fields they arrive in.
  if (field === 'prop' && node.kind === 'instance' && schema.type === 'list') {
    const nested = state.components[node.definitionId];
    const to = nested && site.prop !== undefined && Object.hasOwn(nested.properties, site.prop) ? nested.properties[site.prop] : undefined;
    if (to?.type === 'list')
      for (const [k, f] of Object.entries(to.fields)) {
        const from = Object.hasOwn(schema.fields, k) ? schema.fields[k] : undefined;
        if (f.type === 'token' && from && (from.type !== 'token' || from.tokenGroup !== f.tokenGroup))
          return `passes "${schema.label}" to "${to.label}" of "${nested!.name}", whose "${k}" takes ${f.tokenGroup} tokens, not ${from.type === 'token' ? `${from.tokenGroup} tokens` : `a ${from.type}`}.`;
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
  if (!ok.includes(schema.type)) return `shows a ${schema.type} ${what} as its ${field}, which needs a ${ok.join(' or ')} ${what}.`;
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

/** An object's fields and their types, in a form two objects can be compared by ("label:string, link:link"). */
const fieldShape = (o: { fields: Record<string, ScalarPropSchema> }) =>
  Object.keys(o.fields)
    .sort()
    .map((k) => {
      const f = o.fields[k];
      // A choice's options and a token's group are part of what the field can hold.
      const detail = f.type === 'token' ? `(${f.tokenGroup})` : f.type === 'enum' ? JSON.stringify((Array.isArray(f.options) ? f.options : []).map((x) => x?.value).sort()) : '';
      return `${k}:${f.type}${detail}`;
    })
    .join(', ');

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

/**
 * The schema a binding at this node resolves to, or undefined when it does not resolve. UI state reads as the yes/no
 * or choice property it behaves like, with its initial value as the default.
 */
export function boundSchema(def: ComponentDefinition, nodeId: string, b: BindingRef): PropSchema | undefined {
  // Only a read of state alone: a value that also names a property or an item field is refused as malformed.
  if (isStateRef(b)) {
    const s = declaredState(def, b.$state);
    return s ? stateAsProp(s) : undefined;
  }
  if ('$prop' in b) return propBindingSchema(def.properties, b);
  if (!('$item' in b)) return undefined;
  const list = enclosingList(def, nodeId);
  return list && Object.hasOwn(list.fields, b.$item) ? list.fields[b.$item] : undefined;
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

/** At most this many UI state variables per component, and this many options per choice. */
export const MAX_UI_STATES = 20;
const MAX_STATE_OPTIONS = 50;

/** Fields that may read UI state: conditions, and the variant axes of a nested component. */
export const STATE_FIELDS: ReadonlySet<BindField> = new Set<BindField>(['when', 'unless', 'variant']);

/** A UI state variable as the yes/no or choice property it behaves like, starting at its initial value. */
export function stateAsProp(s: UiStateSchema): PropSchema {
  return s.type === 'boolean' ? { type: 'boolean', label: s.label, default: s.initial } : { type: 'enum', label: s.label, default: s.initial, options: s.options };
}

/** What is wrong with a stored UI state declaration, or null. Shared by load validation and the theme pack loader. */
export function uiStateProblem(def: Pick<ComponentDefinition, 'properties'>, name: string, raw: unknown): string | null {
  if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(name) || RESERVED.has(name) || /^item\d+$/.test(name) || isProtoKey(name) || name === 'prototype') return `"${name.slice(0, 40)}" is not a name UI state can have.`;
  if (Object.hasOwn(def.properties ?? {}, name)) return `"${name}" is both a property and UI state.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `the UI state "${name}" is not a declaration.`;
  const r = raw as Record<string, unknown>;
  if (!(UI_STATE_TYPES as readonly unknown[]).includes(r.type)) return `the UI state "${name}" is neither yes/no (boolean) nor a choice (enum).`;
  if (typeof r.label !== 'string') return `the UI state "${name}" has no label.`;
  if (r.type === 'boolean') return typeof r.initial === 'boolean' ? null : `the UI state "${name}" starts as ${JSON.stringify(r.initial) ?? 'nothing'}; a yes/no state starts as true or false.`;
  const options = r.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > MAX_STATE_OPTIONS) return `the UI state "${name}" needs 2 to ${MAX_STATE_OPTIONS} options.`;
  const values = new Set<string>();
  for (const o of options) {
    const value = (o as { value?: unknown } | null)?.value;
    if (typeof value !== 'string' || !value || value.length > 60 || typeof (o as { label?: unknown }).label !== 'string') return `the UI state "${name}" has an option that is not a value of up to 60 characters with a label.`;
    if (values.has(value)) return `the UI state "${name}" lists the option "${value}" twice.`;
    values.add(value);
  }
  return typeof r.initial === 'string' && values.has(r.initial) ? null : `the UI state "${name}" starts as ${JSON.stringify(r.initial) ?? 'nothing'}, which is not one of its options.`;
}

/** A state map a hand edit made into something else is reported once, on its own, not again by everything that reads it. */
const stateMapDamaged = (def: Pick<ComponentDefinition, 'state'>) => def.state !== undefined && (!def.state || typeof def.state !== 'object' || Array.isArray(def.state));

/** Whether a definition declares this state, but in a form a hand edit damaged (reported on its own). */
export function damagedState(def: Pick<ComponentDefinition, 'state' | 'properties'>, name: string): boolean {
  if (stateMapDamaged(def)) return true;
  return !!def.state && Object.hasOwn(def.state, name) && !declaredState(def, name);
}

/** A declared, well-formed UI state variable of a definition (one a hand edit damaged is reported on its own). */
export function declaredState(def: Pick<ComponentDefinition, 'state' | 'properties'>, name: string): UiStateSchema | undefined {
  const s = def.state && Object.hasOwn(def.state, name) ? def.state[name] : undefined;
  return s !== undefined && !uiStateProblem(def, name, s) ? s : undefined;
}

/** The name UI state may take: a property-style name that no property of the component already has. */
export function checkStateName(def: ComponentDefinition, name: string) {
  checkPropName(name, 'State');
  if (name === 'prototype') fail('"prototype" is a reserved name. Choose another state name.');
  if (Object.hasOwn(def.properties, name)) fail(`"${def.name}" already has a property "${name}". UI state needs a name of its own.`);
}

/**
 * Validate and normalize a UI state declaration supplied by a person or the AI. The label defaults to the name, an
 * option may be given as just its value, and the initial value defaults to false or the first option; anything
 * else that does not fit is refused rather than guessed.
 */
export function normalizeUiState(raw: unknown, name: string): UiStateSchema {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`UI state "${name}" needs a declaration with a type.`);
  const r = raw as Record<string, unknown>;
  const label = text(r.label, 80) ?? name;
  if (r.type === 'boolean') {
    if (r.options !== undefined) fail(`UI state "${name}" is yes/no, so it has no options.`);
    if (r.initial !== undefined && typeof r.initial !== 'boolean') fail(`UI state "${name}" is yes/no: it starts as true or false, not ${JSON.stringify(r.initial)}.`);
    return { type: 'boolean', label, initial: r.initial === true };
  }
  if (r.type !== 'enum') fail(`UI state "${name}" needs a type of boolean or enum.`);
  if (!Array.isArray(r.options) || r.options.length < 2 || r.options.length > MAX_STATE_OPTIONS) fail(`UI state "${name}": a choice needs 2 to ${MAX_STATE_OPTIONS} options.`);
  const seen = new Set<string>();
  const options = r.options.map((o) => {
    const value = typeof o === 'string' ? o : (o as { value?: unknown } | null)?.value;
    if (typeof value !== 'string' || !value || value.length > 60) fail(`UI state "${name}": every option needs a value of up to 60 characters.`);
    if (seen.has(value)) fail(`UI state "${name}": option "${value}" is listed twice.`);
    seen.add(value);
    return { value, label: (typeof o === 'object' && text((o as { label?: unknown }).label, 80)) || value };
  });
  if (r.initial !== undefined && (typeof r.initial !== 'string' || !seen.has(r.initial)))
    fail(`UI state "${name}" starts as ${JSON.stringify(r.initial)}, which is not one of its options (${listed(options.map((o) => o.value))}).`);
  return { type: 'enum', label, options, initial: (r.initial as string | undefined) ?? options[0].value };
}

/** What is wrong with a read of UI state at a binding site, or null: state the definition lacks, a field that cannot read it, or a value it never holds. */
export function stateRefProblem(state: ProjectState, def: ComponentDefinition, site: Pick<BindingSite, 'node' | 'field' | 'prop' | 'comparison'>, ref: StateRef): string | null {
  if (!STATE_FIELDS.has(site.field)) return `reads the UI state "${ref.$state}" as its ${site.field}; only conditions and the variants of a nested component read UI state.`;
  // A declaration a hand edit damaged is reported once, on its own.
  if (damagedState(def, ref.$state)) return null;
  const declared = declaredState(def, ref.$state);
  if (!declared) return `reads the UI state "${ref.$state}", which the component does not declare.`;
  return bindingProblem(state, site, stateAsProp(declared), 'state');
}

/** What is wrong with what a button does to UI state, or null. Shared by load validation and node.setStateAction. */
export function stateActionProblem(def: ComponentDefinition, action: unknown): string | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return 'has a UI state action that is not one.';
  const a = action as Record<string, unknown>;
  if (typeof a.state !== 'string' || !(STATE_ACTION_OPS as readonly unknown[]).includes(a.op)) return 'has a UI state action that names no state, or does something other than set, toggle, next or prev.';
  const keys = Object.keys(a).filter((k) => k !== 'state' && k !== 'op');
  const allowed = a.op === 'set' ? ['value'] : a.op === 'toggle' ? [] : ['wrap'];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return `has a "${a.op}" UI state action that also says ${extra.map((k) => `"${k}"`).join(', ')}, which only ${extra.includes('value') ? 'set' : extra.includes('wrap') ? 'next and prev' : 'other actions'} take.`;
  if (damagedState(def, a.state)) return null;
  const declared = declaredState(def, a.state);
  if (!declared) return `changes the UI state "${a.state}", which the component does not declare.`;
  switch (a.op) {
    case 'toggle':
      return declared.type === 'boolean' ? null : `toggles the choice "${a.state}"; set it, or step it to the next or previous option.`;
    case 'next':
    case 'prev':
      if (a.wrap !== undefined && typeof a.wrap !== 'boolean') return `steps "${a.state}" with a wrap that is not true or false.`;
      return declared.type === 'enum' ? null : `steps the yes/no state "${a.state}" to its ${a.op} option; set or toggle it instead.`;
    default:
      if (declared.type === 'boolean') return typeof a.value === 'boolean' ? null : `sets the yes/no state "${a.state}" to ${JSON.stringify(a.value) ?? 'nothing'}; set it to true or false.`;
      return typeof a.value === 'string' && declared.options.some((o) => o.value === a.value)
        ? null
        : `sets "${a.state}" to ${JSON.stringify(a.value) ?? 'nothing'}, which is not one of its options (${listed(declared.options.map((o) => o.value))}).`;
  }
}

/** Every node of a design that reads or changes one UI state variable, with what it does. */
export function stateUsers(def: ComponentDefinition, name: string): Array<{ node: GraphNode; field: BindField | 'stateAction'; prop?: string }> {
  const out: Array<{ node: GraphNode; field: BindField | 'stateAction'; prop?: string }> = [];
  for (const site of bindingSites(def)) if (isStateRef(site.binding) && site.binding.$state === name) out.push({ node: site.node, field: site.field, prop: site.prop });
  for (const n of Object.values(def.tree?.nodes ?? {})) if (n.kind === 'link' && n.stateAction?.state === name) out.push({ node: n, field: 'stateAction' });
  return out;
}

/** Whether any node of these reads or changes UI state. */
export function usesState(nodes: GraphNode[]): boolean {
  return nodes.some((n) => (n.kind === 'link' && n.stateAction !== undefined) || bindingSlots(n).some((slot) => isStateRef(slot.field === 'when' || slot.field === 'unless' ? conditionRef(slot.value) : slot.value)));
}

/** A copy of a definition with one UI state variable replaced (or removed with `undefined`), for checking a change before making it. */
export function withState(def: ComponentDefinition, name: string, schema: UiStateSchema | undefined): ComponentDefinition {
  const next = { ...(def.state ?? {}) };
  if (schema) next[name] = schema;
  else delete next[name];
  return { ...def, state: next };
}
