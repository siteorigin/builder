/**
 * JSON Schema for component properties, generated from the component's own contract. Every object is closed
 * and every value has a concrete type, so the same schema works for native tool calling and for
 * grammar-constrained decoding on a local model.
 */
import type { ComponentDefinition, PropSchema, ScalarPropSchema } from '@shared/types';
import { teaserFields } from '@shared/page-teasers';
import { MAX_CHOICES } from '@engine/values';

export type JsonSchema = Record<string, unknown>;

const LINK_HELP = 'An internal route such as /about/, an https:// URL, mailto:, tel:, #anchor, or "" for no link.';

/** The same image shape, shared by reference where one schema covers many components. */
export const IMAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { assetId: { type: ['string', 'null'], description: 'An ID from search_assets, or null.' }, alt: { type: 'string', maxLength: 300 } },
  required: ['assetId', 'alt'],
  additionalProperties: false
};

/** A set of choices: `{ label }` adds one, and a saved `{ id, label, value }` keeps it (renamed or not). */
function choicesSchema(description?: string): JsonSchema {
  return {
    type: 'array',
    maxItems: MAX_CHOICES,
    ...(description ? { description } : {}),
    items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string', maxLength: 200 }, value: { type: 'string', maxLength: 200 } }, required: ['label'], additionalProperties: false }
  };
}

/** Types only, for a schema that lists every component: labels there would cost more than the rest together. */
function compactScalar(s: ScalarPropSchema): JsonSchema {
  switch (s.type) {
    case 'choices':
      return choicesSchema();
    case 'number':
      return { type: 'number', ...(s.min !== undefined ? { minimum: s.min } : {}), ...(s.max !== undefined ? { maximum: s.max } : {}) };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', enum: s.options.map((o) => o.value) };
    case 'image':
      return { $ref: '#/$defs/image' };
    default:
      return { type: 'string' };
  }
}

function scalarSchema(s: ScalarPropSchema): JsonSchema {
  const description = s.label;
  switch (s.type) {
    case 'string':
      return { type: 'string', maxLength: s.maxLength ?? 2000, description };
    case 'richtext':
      // A plain string is the smallest form the value normalizer accepts, whatever the stored shape is.
      return { type: 'string', description: `${description}. Separate paragraphs with a blank line; **bold** and *italic* are allowed.` };
    case 'number':
      return { type: 'number', ...(s.min !== undefined ? { minimum: s.min } : {}), ...(s.max !== undefined ? { maximum: s.max } : {}), description };
    case 'boolean':
      return { type: 'boolean', description };
    case 'enum':
      return { type: 'string', enum: s.options.map((o) => o.value), description };
    case 'link':
      return { type: 'string', description: `${description}. ${LINK_HELP}` };
    case 'image':
      return { ...IMAGE_SCHEMA, description };
    case 'icon':
      return { type: 'string', maxLength: 40, description: `${description}. An icon name such as sparkles, compass, leaf, phone or mail.` };
    case 'choices':
      return choicesSchema(
        `${description}, in the order shown. Add a choice as { label }. Keep a saved choice by sending its id, label and value as read: renaming it keeps its id and value, so earlier answers stay together. Leave a choice out to remove it.`
      );
  }
}

export function propJsonSchema(s: PropSchema): JsonSchema {
  if (s.type !== 'list') return scalarSchema(s);
  const properties: Record<string, JsonSchema> = { id: { type: 'string', description: 'Keep the existing item ID when editing an item. Omit it for a new item.' } };
  // A page list's fields left empty show the linked page's own values, which follow that page's later edits.
  const follows = new Map(s.pageTeaser ? teaserFields(s.pageTeaser) : []);
  for (const [k, f] of Object.entries(s.fields)) {
    const field = scalarSchema(f);
    const what = follows.get(k);
    if (what)
      field.description =
        what === 'image'
          ? `${field.description}. Leave assetId null to show the linked page's sharing image; choose one only to override it on this card.`
          : `${field.description}. Leave empty ("") to show the linked page's ${what}; set it only to override it on this card.`;
    else if (k === s.pageTeaser?.link) field.description = `${field.description}. The page this card stands for, by its route.`;
    properties[k] = field;
  }
  return {
    type: 'array',
    description: s.pageTeaser ? `${s.label}. One card per page, in the order shown; deleting a page removes its card.` : s.label,
    ...(s.min !== undefined ? { minItems: s.min } : {}),
    ...(s.max !== undefined ? { maxItems: s.max } : {}),
    items: { type: 'object', properties, additionalProperties: false }
  };
}

/** The closed object of a component's properties. */
export function propsJsonSchema(def: Pick<ComponentDefinition, 'properties'>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [k, s] of Object.entries(def.properties)) properties[k] = propJsonSchema(s);
  return { type: 'object', properties, additionalProperties: false };
}

/** Closed props with types only. The caller's schema must define #/$defs/image (IMAGE_SCHEMA). */
export function compactPropsSchema(def: Pick<ComponentDefinition, 'properties'>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [k, s] of Object.entries(def.properties)) {
    if (s.type !== 'list') {
      properties[k] = compactScalar(s);
      continue;
    }
    const fields: Record<string, JsonSchema> = { id: { type: 'string' } };
    for (const [f, x] of Object.entries(s.fields)) fields[f] = compactScalar(x);
    properties[k] = { type: 'array', ...(s.min !== undefined ? { minItems: s.min } : {}), ...(s.max !== undefined ? { maxItems: s.max } : {}), items: { type: 'object', properties: fields, additionalProperties: false } };
  }
  return { type: 'object', properties, additionalProperties: false };
}

/** Whether a schema has an object that accepts anything, or a value with no type. */
export function hasOpenSchema(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasOpenSchema);
  if (!v || typeof v !== 'object') return true;
  const o = v as Record<string, unknown>;
  if (!('type' in o || 'enum' in o || 'const' in o || 'oneOf' in o || 'anyOf' in o || '$ref' in o)) return true;
  if (o.type === 'object' && o.additionalProperties !== false) return true;
  for (const key of ['properties', '$defs'])
    if (o[key] && Object.values(o[key] as object).some(hasOpenSchema)) return true;
  for (const key of ['items', 'oneOf', 'anyOf'])
    if (o[key] !== undefined && hasOpenSchema(o[key])) return true;
  return false;
}
