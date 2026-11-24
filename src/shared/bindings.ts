/**
 * What a `$prop` binding reads: a whole property, or one field of an object property (`{ $prop, field }`).
 * Everything that resolves a binding to its schema or value goes through these, so a field binding reads the
 * field everywhere: the generator, the content checks, the canvas and the engine.
 */
import type { PropSchema } from './types';

type PropRef = { $prop: string; field?: string };

/**
 * The schema a property binding shows: the property's own, or its object field's. A field's default is what the
 * object's default gives it, which is what an element bound to it shows. Undefined when it does not resolve.
 */
export function propBindingSchema(properties: Record<string, PropSchema>, b: PropRef): PropSchema | undefined {
  const schema = Object.hasOwn(properties, b.$prop) ? properties[b.$prop] : undefined;
  if (b.field === undefined) return schema;
  if (schema?.type !== 'object' || !Object.hasOwn(schema.fields, b.field)) return undefined;
  const field = schema.fields[b.field];
  const d = schema.default;
  return d && typeof d === 'object' && Object.hasOwn(d, b.field) ? ({ ...field, default: d[b.field] } as PropSchema) : field;
}

/** The value a property binding shows, given its property's value. */
export function propBindingValue(value: unknown, b: { field?: string }): unknown {
  if (b.field === undefined) return value;
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, b.field) ? (value as Record<string, unknown>)[b.field] : undefined;
}

/** A binding to the same property, keeping the field it reads (property renames and extraction rebuild bindings). */
export const withProp = (b: PropRef, name: string): PropRef => (b.field === undefined ? { $prop: name } : { $prop: name, field: b.field });

/** How a binding is named in messages: `primary.label` for an object field. */
export const propBindingName = (b: PropRef): string => (b.field === undefined ? b.$prop : `${b.$prop}.${b.field}`);
