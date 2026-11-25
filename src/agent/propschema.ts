/**
 * JSON Schema for component properties, generated from the component's own contract. Every object is closed
 * and every value has a concrete type, so the same schema works for native tool calling and for
 * grammar-constrained decoding on a local model.
 */
import type { ComponentDefinition, PropSchema, ScalarPropSchema } from '@shared/types';
import { teaserFields } from '@shared/page-teasers';
import { MAX_CHOICES } from '@engine/values';
import { TABLE_LIMITS } from '@engine/table';
import { TEXT_LIMITS } from '@shared/text-limits';
import { requiredHint } from '@shared/required';

export type JsonSchema = Record<string, unknown>;

const LINK_HELP = 'An internal route such as /about/, an https:// URL, mailto:, tel:, #anchor, or "" for no link.';

/** The same image shape, shared by reference where one schema covers many components. */
export const IMAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { assetId: { type: ['string', 'null'], description: 'An ID from search_assets, or null.' }, alt: { type: 'string', maxLength: TEXT_LIMITS.imageAlt } },
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

/** A required image: its assetId is a library image's ID, never null. */
export const REQUIRED_IMAGE_SCHEMA: JsonSchema = {
  ...IMAGE_SCHEMA,
  properties: { ...(IMAGE_SCHEMA.properties as Record<string, JsonSchema>), assetId: { type: 'string', minLength: 1, description: 'An ID from search_assets. Required: never null.' } }
};

/**
 * What a required property (see shared/required.ts) adds to a value's schema: no empty text, no missing picture, no
 * empty list, and the word in its description. The keys stay optional in their object: a patch leaves out what it
 * keeps.
 */
function requiring(s: PropSchema, schema: JsonSchema, compact = false): JsonSchema {
  if (!s.required) return schema;
  const out: JsonSchema = { ...schema };
  switch (s.type) {
    case 'string':
    case 'richtext':
    case 'link':
    case 'icon':
      out.minLength = 1;
      break;
    case 'enum':
      out.enum = s.options.map((o) => o.value).filter((v) => v.trim());
      break;
    case 'image':
      return compact ? { $ref: '#/$defs/requiredImage' } : { ...REQUIRED_IMAGE_SCHEMA, ...(schema.description ? { description: schema.description } : {}) };
    case 'choices':
    case 'list':
      out.minItems = Math.max(1, (schema.minItems as number | undefined) ?? 0);
      break;
    case 'table':
      out.properties = { ...(schema.properties as Record<string, JsonSchema>), rows: { ...((schema.properties as Record<string, JsonSchema>).rows ?? {}), minItems: 1 } };
      break;
  }
  if (typeof out.description === 'string') out.description = `${out.description}. Required: ${requiredHint(s)}.`;
  return out;
}

/** Types only, for a schema that lists every component: labels there would cost more than the rest together. */
function compactScalar(s: ScalarPropSchema): JsonSchema {
  return requiring(s, compactScalarType(s), true);
}

function compactScalarType(s: ScalarPropSchema): JsonSchema {
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
      // Text, links and icons are written as strings, and so is a token: its ID.
      return { type: 'string' };
  }
}

function scalarSchema(s: ScalarPropSchema): JsonSchema {
  return requiring(s, scalarType(s));
}

function scalarType(s: ScalarPropSchema): JsonSchema {
  const description = s.label;
  switch (s.type) {
    case 'string':
      return { type: 'string', maxLength: s.maxLength ?? 2000, description };
    case 'richtext':
      // A plain string is the smallest form the value normalizer accepts, whatever the stored shape is.
      return { type: 'string', description: `${description}. Separate paragraphs with a blank line; **bold** and *italic* are allowed. End a line with \\ for a line break inside a paragraph.` };
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
    case 'token':
      return { type: 'string', maxLength: 80, description: `${description}. The ID of one of the site's ${s.tokenGroup} tokens, such as ${TOKEN_EXAMPLES[s.tokenGroup] ?? `${s.tokenGroup}.name`}.` };
  }
}

/** A token ID of each group, as an example in a token property's description. */
const TOKEN_EXAMPLES: Partial<Record<string, string>> = { color: 'color.brand', space: 'space.md', radius: 'radius.md', shadow: 'shadow.md', font: 'font.body', container: 'container.content', border: 'border.default' };

/** An object's fields, each a single value. Fields left out keep their current values. */
function objectSchema(s: Extract<PropSchema, { type: 'object' }>, compact: boolean): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [k, f] of Object.entries(s.fields)) properties[k] = compact ? compactScalar(f) : scalarSchema(f);
  return {
    type: 'object',
    ...(compact ? {} : { description: `${s.label}. Send the fields to change; fields left out keep their values.` }),
    properties,
    additionalProperties: false
  };
}

/**
 * A whole table in its short form: column names, then each row's texts in column order. Writing it replaces
 * the table; one cell, row or column is changed by ID with instance.editTable instead.
 */
function tableSchema(description?: string): JsonSchema {
  const text = (max: number): JsonSchema => (description ? { type: 'string', maxLength: max } : { type: 'string' });
  return {
    type: 'object',
    ...(description ? { description: `${description}. Column names, then one row per entry with one text per column, in column order. Replaces the whole table.` } : {}),
    properties: {
      columns: { type: 'array', minItems: 1, maxItems: TABLE_LIMITS.columns, items: text(TABLE_LIMITS.label) },
      rows: { type: 'array', maxItems: TABLE_LIMITS.rows, items: { type: 'array', maxItems: TABLE_LIMITS.columns, items: text(TABLE_LIMITS.cell) } }
    },
    required: ['columns', 'rows'],
    additionalProperties: false
  };
}

export function propJsonSchema(s: PropSchema): JsonSchema {
  if (s.type === 'table') return requiring(s, tableSchema(s.label));
  if (s.type === 'object') return requiring(s, objectSchema(s, false));
  if (s.type !== 'list') return scalarSchema(s);
  return requiring(s, listSchema(s));
}

function listSchema(s: Extract<PropSchema, { type: 'list' }>): JsonSchema {
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
/** Whether the model may write a property: a computed list (news, an article header) is filled from the site's pages. */
export function writableProp(s: PropSchema): boolean {
  return !(s.type === 'list' && s.feed);
}

export function propsJsonSchema(def: Pick<ComponentDefinition, 'properties'>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [k, s] of Object.entries(def.properties)) if (writableProp(s)) properties[k] = propJsonSchema(s);
  return { type: 'object', properties, additionalProperties: false };
}

/** Closed props with types only. The caller's schema must define #/$defs/image (IMAGE_SCHEMA), and #/$defs/requiredImage (REQUIRED_IMAGE_SCHEMA) when a component has a required image. */
export function compactPropsSchema(def: Pick<ComponentDefinition, 'properties'>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [k, s] of Object.entries(def.properties)) {
    if (!writableProp(s)) continue;
    if (s.type === 'table') {
      properties[k] = requiring(s, tableSchema(), true);
      continue;
    }
    if (s.type === 'object') {
      properties[k] = requiring(s, objectSchema(s, true), true);
      continue;
    }
    if (s.type !== 'list') {
      properties[k] = compactScalar(s);
      continue;
    }
    const fields: Record<string, JsonSchema> = { id: { type: 'string' } };
    for (const [f, x] of Object.entries(s.fields)) fields[f] = compactScalar(x);
    properties[k] = requiring(s, { type: 'array', ...(s.min !== undefined ? { minItems: s.min } : {}), ...(s.max !== undefined ? { maxItems: s.max } : {}), items: { type: 'object', properties: fields, additionalProperties: false } }, true);
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
