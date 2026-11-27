/**
 * Property schema validation for component definitions, and where a managed definition binds its properties.
 */
import type { BindingRef, ComponentDefinition, Comparison, GraphNode, ListFeed, ListProp, NodeTree, PageTeaser, ProjectState, PropSchema, RepeatFilter, ScalarPropSchema, StateRef, TokenGroup, UiStateSchema } from '@shared/types';
import { repeatProp, DIVIDER_SHAPES, ELEMENT_ACTIONS, ELEMENT_TAGS, ICON_POSITIONS, LIST_FEEDS, OVERLAY_MODES, RICH_CODE_FORMS, STATE_ACTION_OPS, TEXT_TAGS, UI_STATE_TYPES, conditionRef, isBinding, isBindingRef, isComparison, isStateRef } from '@shared/types';
import { feedRowFields } from '@shared/entry-feed';
import { PAGE_TEASER_TYPES, PAGE_TEASER_VALUES, type PageTeaserValue } from '@shared/page-teasers';
import { axesOf } from '@shared/variants';
import { propBindingSchema } from '@shared/bindings';
import { requiredGap } from '@shared/required';
import { fail, findParent } from './tree';
import { normalizeProp } from './values';
import { declaredTokens } from './tokens';
import { ICONS } from '@shared/icons';

const PROP_TYPES = ['string', 'richtext', 'number', 'boolean', 'enum', 'link', 'image', 'icon', 'choices', 'token', 'list', 'table', 'object'] as const;
/** The property types a live session's Copy Editor may be allowed to change (see engine/copy-editor.ts). */
const COPY_EDITABLE_TYPES: readonly string[] = ['string', 'richtext', 'image'];
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
/** The most characters a text property may be limited to: a web address takes up to 2,048, a long text far more. */
const MAX_TEXT_LENGTH = 20_000;
const length = (v: unknown, label: string): number | undefined => {
  const n = num(v, label);
  if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > MAX_TEXT_LENGTH)) fail(`${label} must be a whole number from 0 to ${MAX_TEXT_LENGTH.toLocaleString('en')}.`);
  return n;
};

/**
 * A page list's mapping: a link field, and distinct fields of the right type for the page's title, description and
 * image. Deleting a page removes the items linked to it, so the list must be allowed to have none.
 */
function pageTeaserSchema(raw: unknown, fields: Record<string, ScalarPropSchema>, min: number | undefined, label: string, required: boolean): PageTeaser {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${label}: pageTeaser needs an object naming the item's link field and the fields the page fills.`);
  const r = raw as Record<string, unknown>;
  if (min) fail(`${label}: a page list cannot have a minimum, since deleting a page removes its items.`);
  if (required) fail(`${label}: a page list cannot be required, since deleting a page removes its items.`);
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
  // Left empty, such a field shows the linked page's own value: being empty is how it follows the page.
  for (const what of PAGE_TEASER_VALUES) {
    const f = out[what];
    if (f && fields[f].required) fail(`${label}: the field "${f}" shows the linked page's ${what} while it is empty, so it cannot be required.`);
  }
  return out;
}

/**
 * A computed list (see shared/articles.ts and shared/entry-feed.ts): which pages or entries it holds, and fields of
 * the right type for the row values it fills by name. Its items come and go with the site's pages and entries, so it
 * cannot ask for a minimum.
 */
function feedSchema(raw: unknown, fields: Record<string, ScalarPropSchema>, min: number | undefined, label: string, required: boolean): ListFeed {
  if (typeof raw !== 'string' || !(LIST_FEEDS as readonly string[]).includes(raw)) fail(`${label}: feed must be one of ${LIST_FEEDS.map((f) => `"${f}"`).join(', ')}.`);
  if (min) fail(`${label}: a computed list cannot have a minimum, since its items come from the site's pages.`);
  // Its items and what they hold come from the site's pages or entries, which may have none or leave a value empty.
  if (required) fail(`${label}: a computed list cannot be required, since its items come from the site's pages.`);
  const req = Object.keys(fields).find((f) => fields[f].required);
  if (req) fail(`${label}: the field "${req}" of a computed list cannot be required, since the site's pages fill it.`);
  const filled = feedRowFields(raw);
  for (const [f, type] of Object.entries(filled)) {
    if (Object.hasOwn(fields, f) && fields[f].type !== type) fail(`${label}: the field "${f}" of a computed list must be a ${type} field.`);
  }
  if (!Object.keys(fields).some((f) => Object.hasOwn(filled, f))) fail(`${label}: a computed list needs at least one field it fills (${Object.keys(filled).join(', ')}).`);
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
  if (r.required !== undefined && typeof r.required !== 'boolean') fail(`${label}: required must be true or false.`);
  if (r.required) out.required = true;
  if (r.copyEditable !== undefined && r.copyEditable !== false) {
    // Copy a live session's Copy Editor may change: a component's own text or picture, never a field of a list or object.
    if (r.copyEditable !== true) fail(`${label}: copyEditable must be true or false.`);
    if (inList || !COPY_EDITABLE_TYPES.includes(type)) fail(`${label}: only a component's own text, rich text or image property can be copyEditable.`);
    out.copyEditable = true;
  }
  switch (type) {
    case 'string': {
      if (r.multiline !== undefined) out.multiline = !!r.multiline;
      const maxLength = length(r.maxLength, `${label} maxLength`);
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
        const named = typeof o === 'object' && o !== null ? text((o as { label?: unknown }).label, 80) : '';
        // An empty value is a choice of nothing (an icon's None), so it needs a label to be offered by.
        if (value.length > 60 || (!value && (typeof o !== 'object' || o === null || (o as { value?: unknown }).value !== '' || !named)))
          fail(`${label}: every option needs a value of up to 60 characters; an empty one ("") needs a label, such as { "value": "", "label": "None" }.`);
        if (seen.has(value)) fail(`${label}: option "${value}" is listed twice.`);
        seen.add(value);
        return { value, label: named || value };
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
      if (r.pageTeaser !== undefined) out.pageTeaser = pageTeaserSchema(r.pageTeaser, fields, min, label, !!out.required);
      if (r.feed !== undefined) {
        out.feed = feedSchema(r.feed, fields, min, label, !!out.required);
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
  | 'variant'
  /** The yes/no property that turns a repeat's category filter on (RepeatNode.filter.when). */
  | 'filter';

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
    case 'filter':
      return ['boolean'];
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
    case 'repeat': {
      out.push(field('list'));
      // The filter's switch is a binding like any other: a property change or removal, a copy into a new component and
      // load validation all see it. A filter without one has no slot, so nothing binds one in where there was none.
      const f = n.filter as unknown;
      if (f && typeof f === 'object' && !Array.isArray(f) && (f as RepeatFilter).when !== undefined) {
        const filter = f as RepeatFilter;
        out.push({ field: 'filter', value: filter.when, set: (v) => (filter.when = v as RepeatFilter['when']) });
      }
      break;
    }
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
  // A required property of the nested component must never receive an empty value, on any placement.
  if (field === 'prop' && node.kind === 'instance') {
    const nested = state.components[node.definitionId];
    const to = nested && site.prop !== undefined && Object.hasOwn(nested.properties, site.prop) ? nested.properties[site.prop] : undefined;
    const gap = to ? requiredGap(schema, to) : null;
    if (gap) return `passes “${schema.label}” to “${to!.label}” of “${nested!.name}”: ${gap}. Make it required too, or unbind it.`;
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
      const schema = def.properties[repeatProp(p) ?? ''];
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

/**
 * Whether a UI state can hold a value: true or false for a yes/no state, one of the options of a choice, or (an item
 * state) the position of an item, counting from 0.
 */
export function stateValueFits(s: UiStateSchema, value: unknown): boolean {
  if (s.type === 'boolean') return typeof value === 'boolean';
  if (s.type === 'item') return Number.isSafeInteger(value) && (value as number) >= 0;
  return typeof value === 'string' && s.options.some((o) => o.value === value);
}

/** At most this many UI state variables per component, and this many options per choice. */
export const MAX_UI_STATES = 20;
const MAX_STATE_OPTIONS = 50;

/** Fields that may read UI state: conditions, and the variant axes of a nested component. */
export const STATE_FIELDS: ReadonlySet<BindField> = new Set<BindField>(['when', 'unless', 'variant']);

/** A UI state variable as the yes/no or choice property it behaves like, starting at its initial value. */
export function stateAsProp(s: UiStateSchema): PropSchema {
  // An item state reads, inside a repeat of its list, as whether the item is the active one.
  if (s.type === 'item') return { type: 'boolean', label: s.label, default: false };
  return s.type === 'boolean' ? { type: 'boolean', label: s.label, default: s.initial } : { type: 'enum', label: s.label, default: s.initial, options: s.options };
}

/** What is wrong with a stored UI state declaration, or null. Shared by load validation and the theme pack loader. */
export function uiStateProblem(def: Pick<ComponentDefinition, 'properties'>, name: string, raw: unknown): string | null {
  if (!/^[a-z][a-zA-Z0-9]{0,39}$/.test(name) || RESERVED.has(name) || /^item\d+$/.test(name) || isProtoKey(name) || name === 'prototype') return `"${name.slice(0, 40)}" is not a name UI state can have.`;
  if (Object.hasOwn(def.properties ?? {}, name)) return `"${name}" is both a property and UI state.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `the UI state "${name}" is not a declaration.`;
  const r = raw as Record<string, unknown>;
  if (!(UI_STATE_TYPES as readonly unknown[]).includes(r.type)) return `the UI state "${name}" is neither yes/no (boolean), a choice (enum) nor the active item of a list (item).`;
  if (typeof r.label !== 'string') return `the UI state "${name}" has no label.`;
  if (r.type === 'boolean') return typeof r.initial === 'boolean' ? null : `the UI state "${name}" starts as ${JSON.stringify(r.initial) ?? 'nothing'}; a yes/no state starts as true or false.`;
  if (r.type === 'item') {
    const list = typeof r.list === 'string' && Object.hasOwn(def.properties ?? {}, r.list) ? def.properties[r.list] : undefined;
    if (list?.type !== 'list') return `the UI state "${name}" holds the active item of ${typeof r.list === 'string' ? `"${r.list.slice(0, 40)}", which is not a list property of the component` : 'no list'}.`;
    return Number.isSafeInteger(r.initial) && (r.initial as number) >= 0 ? null : `the UI state "${name}" starts at ${JSON.stringify(r.initial) ?? 'nothing'}; an item state starts at the position of an item, counting from 0.`;
  }
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
  if (r.type === 'item') {
    if (r.options !== undefined) fail(`UI state "${name}" holds the active item of a list, so it has no options.`);
    if (typeof r.list !== 'string' || !r.list) fail(`UI state "${name}" needs the list property whose active item it holds ("list").`);
    if (r.initial !== undefined && !(Number.isSafeInteger(r.initial) && (r.initial as number) >= 0))
      fail(`UI state "${name}" starts at the position of an item, counting from 0, not ${JSON.stringify(r.initial)}.`);
    return { type: 'item', label, list: r.list, initial: (r.initial as number | undefined) ?? 0 };
  }
  if (r.list !== undefined) fail(`UI state "${name}" is not an item state, so it names no list.`);
  if (r.type !== 'enum') fail(`UI state "${name}" needs a type of boolean, enum or item.`);
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
  if (declared.type === 'item') {
    if (site.field === 'variant') return `chooses a variant from the active item "${ref.$state}"; only conditions read which item is active.`;
    if (site.comparison) return `compares the active item "${ref.$state}" with a value; read it plainly, as whether this item is the active one.`;
    return itemScopeProblem(def, site.node.id, ref.$state, declared, 'reads');
  }
  return bindingProblem(state, site, stateAsProp(declared), 'state');
}

/**
 * What keeps a node from reading or selecting the active item of an item state, or null when it can: it must be
 * inside a repeat of the state's own list, the only repeat it is inside (where "this item" is one item of that list in
 * every placement), and that repeat must show every item (no category filter, which could hide the active one).
 */
export function itemScopeProblem(def: ComponentDefinition, nodeId: string, name: string, declared: { list: string }, does: 'reads' | 'selects'): string | null {
  const what = does === 'reads' ? `reads whether its item is the active one of "${name}"` : `selects its item as the active one of "${name}"`;
  const tree = def.tree;
  const repeats: GraphNode[] = [];
  if (tree) {
    const seen = new Set<string>([nodeId]);
    for (let at = findParent(tree, nodeId); at?.parentId && !seen.has(at.parentId); at = findParent(tree, at.parentId)) {
      seen.add(at.parentId);
      const a = tree.nodes[at.parentId];
      if (a?.kind === 'repeat') repeats.push(a);
    }
  }
  const listLabel = def.properties?.[declared.list]?.label ?? declared.list;
  if (!repeats.length) return `${what}, but is not inside a repeat of "${listLabel}".`;
  if (repeats.length > 1) return `${what} from inside a repeat within another repeat; it needs to be in a repeat of "${listLabel}" alone.`;
  const r = repeats[0] as GraphNode & { kind: 'repeat' };
  if (repeatProp(r) !== declared.list) return `${what}, but is inside a repeat of "${def.properties?.[repeatProp(r) ?? '']?.label ?? repeatProp(r) ?? 'a collection'}", not of "${listLabel}".`;
  if (r.filter !== undefined) return `${what} inside a repeat with a category filter, which could hide the active item.`;
  return null;
}

/** What is wrong with what a button does to UI state, or null. Shared by load validation and node.setStateAction. */
export function stateActionProblem(def: ComponentDefinition, action: unknown, nodeId?: string): string | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return 'has a UI state action that is not one.';
  const a = action as Record<string, unknown>;
  if (typeof a.state !== 'string' || !(STATE_ACTION_OPS as readonly unknown[]).includes(a.op)) return 'has a UI state action that names no state, or does something other than set, toggle, next, prev or select.';
  const keys = Object.keys(a).filter((k) => k !== 'state' && k !== 'op');
  const allowed = a.op === 'set' ? ['value'] : a.op === 'toggle' || a.op === 'select' ? [] : ['wrap'];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return `has a "${a.op}" UI state action that also says ${extra.map((k) => `"${k}"`).join(', ')}, which only ${extra.includes('value') ? 'set' : extra.includes('wrap') ? 'next and prev' : 'other actions'} take.`;
  if (damagedState(def, a.state)) return null;
  const declared = declaredState(def, a.state);
  if (!declared) return `changes the UI state "${a.state}", which the component does not declare.`;
  if (declared.type === 'item') {
    if (a.op === 'set' || a.op === 'toggle') return `${a.op === 'set' ? 'sets' : 'toggles'} the active item "${a.state}"; select a button's own item, or step to the next or previous item.`;
    if ((a.op === 'next' || a.op === 'prev') && a.wrap !== undefined && typeof a.wrap !== 'boolean') return `steps "${a.state}" with a wrap that is not true or false.`;
    // Where the button is decides which item it selects; a check made without knowing that leaves it to the one made with it.
    return a.op === 'select' && nodeId !== undefined ? itemScopeProblem(def, nodeId, a.state, declared, 'selects') : null;
  }
  switch (a.op) {
    case 'select':
      return `selects an item of "${a.state}", which is not the active item of a list; set it to one of its values instead.`;
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

/**
 * Whether a button's state action works in the generated site: the state is declared well formed (one a hand edit
 * damaged is left out of the component, so its buttons do nothing) and the action is one it can make.
 */
export function stateActionRuns(def: ComponentDefinition, action: unknown, nodeId?: string): boolean {
  const name = action && typeof action === 'object' && !Array.isArray(action) ? (action as { state?: unknown }).state : undefined;
  return typeof name === 'string' && !!declaredState(def, name) && !stateActionProblem(def, action, nodeId);
}

/**
 * What is wrong with a repeat's category filter (RepeatNode.filter), as words that follow the repeat's name, or null when
 * it works or there is none. The pills go just above the element holding the repeat, so that element must hold the
 * repeat alone, inside the design's top element, where a row of buttons may go (not in a list, a carousel's slides or a
 * card that links somewhere). Each item must render as one element the filter can hide. Shared by load validation, the
 * pack loader, whole-design writes and the generator, which renders a repeat whose filter has a problem as a plain one.
 */
export function repeatFilterProblem(def: ComponentDefinition, node: GraphNode): string | null {
  if (node.kind !== 'repeat' || node.filter === undefined) return null;
  const f: unknown = node.filter;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'has a category filter that is not one.';
  const extra = Object.keys(f).filter((k) => k !== 'field' && k !== 'when');
  if (extra.length) return `has a category filter that also says ${extra.map((k) => `"${k}"`).join(', ')}; a filter names only its field and the property that turns it on.`;
  const { field, when } = f as RepeatFilter;
  const listName = repeatProp(node);
  const list = typeof listName === 'string' && Object.hasOwn(def.properties, listName) ? def.properties[listName] : undefined;
  if (list?.type !== 'list') return 'filters a list the component does not have.';
  if (typeof field !== 'string' || !field) return 'has a category filter that names no item field.';
  const schema = Object.hasOwn(list.fields, field) ? list.fields[field] : undefined;
  if (!schema) return `filters by "${field}", which items of "${list.label}" do not have.`;
  if (schema.type !== 'string' && schema.type !== 'enum') return `filters by "${schema.label}", a ${schema.type} field; a category is a text or choice field.`;
  if (schema.type === 'enum' && !(Array.isArray(schema.options) && schema.options.every((o) => !!o && typeof o === 'object' && typeof o.value === 'string' && typeof o.label === 'string')))
    return `filters by "${schema.label}", a choice whose options cannot be read.`;
  if (when !== undefined) {
    const prop = when && typeof when === 'object' && !Array.isArray(when) && Object.keys(when).length === 1 && typeof when.$prop === 'string' ? when.$prop : undefined;
    if (prop === undefined) return 'has a category filter turned on by something other than a property.';
    const p = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
    if (!p) return `has a category filter turned on by "${prop}", which the component does not have.`;
    if (p.type !== 'boolean') return `has a category filter turned on by "${p.label}", which is not a yes/no property.`;
  }
  const tree = def.tree;
  if (!tree) return null;
  const roots = new Set(tree.rootIds);
  const seen = new Set<string>([node.id]);
  const ancestors: GraphNode[] = [];
  for (let at = findParent(tree, node.id); at?.parentId && !seen.has(at.parentId); at = findParent(tree, at.parentId)) {
    seen.add(at.parentId);
    const n = tree.nodes[at.parentId];
    if (n) ancestors.push(n);
  }
  const host = ancestors[0];
  if (ancestors.some((a) => a.kind === 'repeat')) return 'is inside another list, where every row would share its pills.';
  // Content handed to a nested component's slot shows wherever that component puts it: inside a link, a paragraph, or
  // once for each of its own items.
  if (ancestors.some((a) => a.kind === 'instance')) return 'is in content placed in a nested component, which decides where (and how often) it shows; filter a list the design holds itself.';
  if (!host || host.kind !== 'element' || roots.has(host.id)) return 'needs an element of its own, inside the design’s top element, to hold it: its pills go just above that element.';
  if (host.children.length !== 1) return 'shares the element holding it with other content; its pills go just above that element, so it must hold the list alone.';
  if (host.carousel) return 'is a carousel’s slides, which scroll sideways rather than filter.';
  if (host.overlay !== undefined) return 'is held by a dialog or drawer itself, beside which its pills would stay on the page; hold the list in an element of its own inside it.';
  const inside = ancestors.slice(1);
  if (mayLink(host)) return 'is held by an element that links somewhere or opens something, which its items could not be filtered inside.';
  if (inside.some(mayLink)) return 'is inside a card that links somewhere, where its pills could not be buttons.';
  // The pills are a block of their own beside the holding element, which only an element that takes such blocks can hold.
  const tags = (n: GraphNode): string[] => {
    if (n.kind !== 'element') return [];
    if (typeof n.tag === 'string') return [n.tag];
    const bound = isBindingRef(n.tag) && '$prop' in n.tag ? propBindingSchema(def.properties, n.tag) : undefined;
    return bound?.type === 'enum' ? bound.options.map((o) => o.value) : [];
  };
  const holder = inside[0];
  if (holder && tags(holder).some((t) => FILTER_BAR_REFUSES.has(t))) return 'is held by an element inside a list, a paragraph or a summary, where a row of buttons cannot go.';
  if (tags(host).some((t) => t === 'li' || t === 'dt' || t === 'dd' || t === 'summary')) return 'is held by a list item, term or summary, beside which a row of buttons cannot go.';
  const items = node.children.map((c) => tree.nodes[c]);
  const acts = (c: GraphNode) => c.kind === 'element' && c.action !== undefined && c.action !== null && c.action !== 'none';
  if (!items.length || items.some((c) => !c || c.kind !== 'element' || acts(c) || c.carousel !== undefined))
    return 'shows items that are not one element each; the filter hides an item by its element, such as a list item or a card.';
  return null;
}
/**
 * The yes/no UI state a node's one condition shows it for, and the value it shows at: `when: { $state }` shows it while
 * the state is on, `unless` while it is off, and a comparison with true or false at the value it names. Null for any
 * other condition, two of them, or state the design does not declare as yes/no.
 */
export function booleanStateGuard(def: Pick<ComponentDefinition, 'state' | 'properties'>, n: GraphNode): { state: string; shows: boolean } | null {
  if (!n.when === !n.unless) return null;
  const c: unknown = n.when ?? n.unless;
  const negate = !n.when;
  const ref = conditionRef(c);
  if (!isStateRef(ref) || typeof ref.$state !== 'string' || declaredState(def, ref.$state)?.type !== 'boolean') return null;
  if (!isComparison(c)) return { state: ref.$state, shows: !negate };
  const value = 'eq' in c ? c.eq : c.ne;
  if (typeof value !== 'boolean') return null;
  return { state: ref.$state, shows: 'eq' in c !== negate ? value : !value };
}

/**
 * What is wrong with a divider's shape and icon as stored, or null: a hand-edited document can name a shape there is
 * no drawing for, or an icon the bundled set lacks. The site still shows a plain rule, or the default icon.
 */
export function dividerProblem(node: GraphNode): string | null {
  if (node.kind !== 'divider') return null;
  const { shape, icon } = node as { shape?: unknown; icon?: unknown };
  if (shape !== undefined && (typeof shape !== 'string' || !(DIVIDER_SHAPES as readonly string[]).includes(shape)))
    return `has a shape that is not one of ${DIVIDER_SHAPES.join(', ')}, so it shows as a plain line.`;
  if (icon === undefined) return null;
  if (shape !== 'icon') return 'names an icon, which only a divider of shape "icon" shows.';
  if (typeof icon !== 'string' || !Object.hasOwn(ICONS, icon)) return 'names an icon that is not available, so it shows the default icon.';
  return null;
}

/**
 * What is wrong with a container shown over the page (ElementNode.overlay), as words that follow its name, or null when
 * it works or is no overlay. It is a plain `div` of a managed design, below the top element, shown by one yes/no UI
 * state of its own (no other dialog or drawer reads that state, whose buttons open and close it), and rendered exactly
 * once per placement: not inside a list, content handed to a nested component, a card that links somewhere, a carousel,
 * or anything shown only on a condition, where its buttons could name a dialog that is not there. It keeps no anchor of
 * its own, since each placement names its dialog. Shared by load validation, the pack loader, the editor's operation
 * and the generator, which renders an overlay with a problem as an ordinary container with its condition.
 */
export function overlayProblem(def: ComponentDefinition, node: GraphNode): string | null {
  if (!Object.hasOwn(node, 'overlay')) return null;
  const mode: unknown = (node as { overlay?: unknown }).overlay;
  if (mode === undefined) return null;
  if (node.kind !== 'element') return 'shows over the page as a dialog or drawer, which only a container can.';
  if (def.kind !== 'managed' || !def.tree) return 'shows over the page as a dialog or drawer, which only a container in a component’s design can.';
  if (typeof mode !== 'string' || !(OVERLAY_MODES as readonly string[]).includes(mode)) return `shows over the page as ${JSON.stringify(mode)?.slice(0, 40) ?? 'nothing'}, which is not ${listed([...OVERLAY_MODES])}.`;
  const tree = def.tree;
  if (tree.rootIds.includes(node.id)) return 'is the component’s top element, which stays in its place; put the dialog or drawer inside it.';
  const guard = booleanStateGuard(def, node);
  if (!guard) return 'is a dialog or drawer that no yes/no UI state of the component opens: show it only while one is on (its one condition).';
  if (node.tag !== 'div') return 'is a dialog or drawer, which is a plain div container (its tag is fixed).';
  if (mayLink(node)) return 'is a dialog or drawer that links somewhere or opens something, where nothing inside it could be used.';
  if (node.carousel !== undefined) return 'is a dialog or drawer, which cannot also be a carousel’s slides.';
  if (node.collapseEmpty) return 'is a dialog or drawer, which stays in the page while closed and cannot hide when everything inside it is hidden.';
  if (node.anchor !== undefined) return 'is a dialog or drawer with an anchor of its own, which each placement would share; its buttons open it instead.';
  if (node.appear !== undefined) return 'is a dialog or drawer, which opens rather than entering as the page scrolls, so it takes no entrance.';
  const roots = new Set(tree.rootIds);
  const seen = new Set<string>([node.id]);
  for (let at = findParent(tree, node.id); at?.parentId && !seen.has(at.parentId); at = findParent(tree, at.parentId)) {
    seen.add(at.parentId);
    const a = tree.nodes[at.parentId];
    if (!a) continue;
    if (a.kind === 'repeat') return 'is inside a list, where every item would share one dialog or drawer.';
    if (a.kind === 'instance') return 'is in content placed in a nested component, which decides where (and how often) it shows; put it in the design itself.';
    if (a.kind !== 'element') continue;
    if (mayLink(a)) return 'is inside a card that links somewhere, where nothing inside could be used.';
    if (a.carousel !== undefined) return 'is inside a carousel’s slides.';
    if (!roots.has(a.id) && (a.when || a.unless || a.collapseEmpty)) return 'is inside content shown only on a condition, which can leave it out while its buttons still name it.';
  }
  const sharing = Object.values(tree.nodes).some(
    (o) => o && o.id !== node.id && o.kind === 'element' && typeof o.overlay === 'string' && (OVERLAY_MODES as readonly string[]).includes(o.overlay) && booleanStateGuard(def, o)?.state === guard.state
  );
  if (sharing) return `is one of two dialogs or drawers opened by the UI state "${guard.state}"; each needs a yes/no state of its own.`;
  return null;
}

/** A link value that goes somewhere, or may (a binding). */
const linkSet = (l: unknown) => l !== undefined && l !== null && (isBinding(l) || (l as { type?: unknown }).type !== 'none');
/**
 * Whether an element may render as a link around its content (a card) or be wrapped in one (an action that opens its
 * image or follows its link), as the generator decides (generator/card-links isCardLink); an action fixed at `none`,
 * or a link to nowhere, makes none.
 */
const mayLink = (n: GraphNode) => n.kind === 'element' && (n.action === undefined || n.action === null ? linkSet(n.link) : n.action !== 'none' && (n.action !== 'link' || linkSet(n.link)));
/** Elements whose children a row of filter buttons cannot sit among. */
const FILTER_BAR_REFUSES = new Set(['ul', 'ol', 'dl', 'p', 'summary', 'span']);

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

/**
 * Every problem of a design's item states (see ItemUiState), keyed by where it is: a declaration whose list is gone or
 * is no list, and each read or select of one from outside a repeat of its list alone. An edit that adds one (moving a
 * button out of its repeat, removing or retyping the list, repeating another list) is refused.
 */
export function itemStateProblems(def: ComponentDefinition): Map<string, ItemStateProblem> {
  const out = new Map<string, ItemStateProblem>();
  const raw = def.state && typeof def.state === 'object' && !Array.isArray(def.state) ? (def.state as Record<string, unknown>) : {};
  const items = Object.keys(raw).filter((k) => (raw[k] as { type?: unknown } | null)?.type === 'item');
  if (!items.length || def.kind !== 'managed') return out;
  for (const name of items) {
    const problem = uiStateProblem(def, name, raw[name]);
    if (problem) out.set(`state:${name}`, { message: problem });
  }
  if (!def.tree) return out;
  const names = new Set(items);
  for (const site of bindingSites(def)) {
    if (!isStateRef(site.binding) || !names.has(site.binding.$state)) continue;
    const declared = declaredState(def, site.binding.$state);
    if (declared?.type !== 'item') continue;
    const condition = site.field === 'when' || site.field === 'unless';
    const value = condition ? (site.node as unknown as Record<string, unknown>)[site.field] : undefined;
    const problem = stateRefProblem({} as ProjectState, def, { node: site.node, field: site.field, prop: site.prop, comparison: isComparison(value) ? value : undefined }, site.binding);
    if (problem) out.set(JSON.stringify([site.node.id, site.field, site.prop ?? null]), { message: `${nodeName(site.node)} ${problem}`, nodeId: site.node.id });
  }
  for (const n of Object.values(def.tree.nodes)) {
    if (n?.kind !== 'link' || !n.stateAction || !names.has(n.stateAction.state)) continue;
    const problem = stateActionProblem(def, n.stateAction, n.id);
    if (problem) out.set(JSON.stringify([n.id, 'stateAction']), { message: `${nodeName(n)} ${problem}`, nodeId: n.id });
  }
  return out;
}

const nodeName = (n: GraphNode) => (typeof n.name === 'string' && n.name.trim() ? `"${n.name.trim()}"` : `The ${n.kind} "${n.id}"`);

/** One item state problem: what is wrong, and the node it is at (none for a declaration's). */
export interface ItemStateProblem {
  message: string;
  nodeId?: string;
}

/** A copy of a definition with one UI state variable replaced (or removed with `undefined`), for checking a change before making it. */
export function withState(def: ComponentDefinition, name: string, schema: UiStateSchema | undefined): ComponentDefinition {
  const next = { ...(def.state ?? {}) };
  if (schema) next[name] = schema;
  else delete next[name];
  return { ...def, state: next };
}
