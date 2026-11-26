/**
 * Required properties (`PropBase.required`): a value the component cannot render without. A required property's
 * value is never empty, whether it comes from the definition's default, a placement's own value or a binding.
 *
 * What counts as empty, per property type:
 * - string: no character other than white space.
 * - richtext: no text other than white space in any paragraph, heading or list item.
 * - number: never empty once it is a number (0 is a value); clearing one (null, "") is refused.
 * - boolean: never empty: false is a value.
 * - enum: an option of only white space, such as "" (a choice of nothing, like an icon's None).
 * - link: no destination (type none, or a blank target).
 * - image: no asset. A description without a picture is still empty.
 * - icon: no icon name.
 * - choices: no choices.
 * - token: no token named.
 * - list: no items. Its items' own required fields are checked on every item, whether the list is required or not.
 * - table: no rows.
 * - object: every field empty. Its own required fields are checked on their own, whether the object is required or not.
 */
import type { PropSchema, RichText, ScalarPropSchema } from './types';
import { isImageBlock, spanRuns } from './richtext';

const blank = (v: unknown) => typeof v !== 'string' || !v.trim();

/** Whether a run of spans has any text; a damaged run (a hand edit) has none. */
const runText = (run: unknown) => Array.isArray(run) && run.some((s) => !blank((s as { text?: unknown } | null)?.text));

function richEmpty(v: unknown): boolean {
  if (!Array.isArray(v)) return blank(v);
  return !(v as RichText).some((b) => !!b && typeof b === 'object' && (isImageBlock(b) || (Array.isArray(spanRuns(b)) && spanRuns(b).some(runText))));
}

/** Whether a stored value of `schema` is empty, by the rules above. A binding is never a stored value: check its source instead. */
export function isEmptyPropValue(schema: PropSchema, v: unknown): boolean {
  if (v === undefined || v === null) return true;
  switch (schema.type) {
    case 'string':
    case 'icon':
      return blank(v);
    case 'richtext':
      return richEmpty(v);
    case 'number':
      return typeof v !== 'number' || !Number.isFinite(v);
    case 'boolean':
      return typeof v !== 'boolean';
    case 'enum':
      return blank(v);
    case 'link': {
      const l = v as { type?: unknown; target?: unknown };
      return typeof v !== 'object' || !l.type || l.type === 'none' || blank(l.target);
    }
    case 'image':
      return typeof v !== 'object' || blank((v as { assetId?: unknown }).assetId);
    case 'choices':
      return !Array.isArray(v) || !v.length;
    case 'token':
      return typeof v !== 'object' || blank((v as { token?: unknown }).token);
    case 'list':
      return !Array.isArray(v) || !v.length;
    case 'table':
      return typeof v !== 'object' || !Array.isArray((v as { rows?: unknown }).rows) || !(v as { rows: unknown[] }).rows.length;
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return true;
      const o = v as Record<string, unknown>;
      return fieldsOf(schema).every(([k, f]) => !Object.hasOwn(o, k) || isEmptyPropValue(f, o[k]));
    }
  }
}

/** What a required property of this type needs, in words, for messages and the AI's descriptions. */
export function requiredHint(schema: PropSchema): string {
  switch (schema.type) {
    case 'string':
    case 'richtext':
      return 'it needs some text';
    case 'link':
      return 'it needs a destination';
    case 'image':
      return 'it needs a picture from the library';
    case 'icon':
      return 'it needs an icon';
    case 'enum':
      return 'it needs one of its options other than none';
    case 'choices':
      return 'it needs at least one choice';
    case 'list':
      return `it needs at least one ${schema.itemLabel.toLowerCase()}`;
    case 'table':
      return 'it needs at least one row';
    case 'object':
      return 'at least one of its fields needs a value';
    default:
      return 'it needs a value';
  }
}

/** The message a required value that is empty fails with: `label` is the property's path. */
export const requiredMessage = (schema: PropSchema, label: string) => `${label} is required: ${requiredHint(schema)}.`;

/** What a refused edit that would empty a required value carries as its details, so the field it came from can say so. */
export const REQUIRED_REFUSAL = { required: true } as const;

/** Whether a refusal's details say it would have emptied a required value. */
export const isRequiredRefusal = (details: unknown): boolean => !!details && typeof details === 'object' && (details as { required?: unknown }).required === true;

/**
 * Whether every value `from` can hold satisfies a required `to`, so a binding of `to` to `from` can never hand it an
 * empty value: `from` is required too, or its type always has a value (a yes/no, a number, a token, a choice with no
 * empty option), or an object with such a field.
 */
export function guaranteesValue(from: PropSchema | ScalarPropSchema): boolean {
  if (from.required) return true;
  switch (from.type) {
    case 'boolean':
    case 'number':
    case 'token':
      return true;
    case 'enum':
      return Array.isArray(from.options) && from.options.every((o) => !blank(o?.value));
    // A list's minimum is not enforced on what a binding passes into it, so only `required` speaks for its items.
    case 'object':
      return fieldsOf(from).some(([, f]) => guaranteesValue(f));
    default:
      return false;
  }
}

/**
 * `schema` with no value required, its fields' included: what a default, or a value a placement already holds, is
 * checked against. Either may be empty, and is reported (`requiredProblems`) rather than refused; only an edit that
 * empties a value is refused.
 */
export function optionalSchema<T extends PropSchema | ScalarPropSchema>(schema: T): T {
  if (!hasRequired(schema as PropSchema)) return schema;
  const { required: _required, ...rest } = schema as PropSchema;
  if ((rest.type === 'list' || rest.type === 'object') && rest.fields && typeof rest.fields === 'object')
    return { ...rest, fields: Object.fromEntries(Object.entries(rest.fields).map(([k, f]) => [k, f && typeof f === 'object' ? optionalSchema(f) : f])) } as unknown as T;
  return rest as unknown as T;
}

/** Whether a property or any of its fields is required. */
export const hasRequired = (schema: PropSchema): boolean =>
  !!schema.required || ((schema.type === 'list' || schema.type === 'object') && fieldsOf(schema).some(([, f]) => !!f?.required));

/** A list's or an object's fields, as entries; none for a schema edited by hand into one without them. */
export const fieldsOf = (schema: PropSchema): Array<[string, ScalarPropSchema]> =>
  (schema.type === 'list' || schema.type === 'object') && schema.fields && typeof schema.fields === 'object' ? Object.entries(schema.fields).filter(([, f]) => !!f && typeof f === 'object') : [];

/**
 * Why a binding of a property `to` to a value of `from` could hand `to` an empty value where it is required, or null
 * when it never can: `to` is required and `from` may be empty, or a list's or an object's required field arrives from
 * a field that may be empty (or is missing).
 */
export function requiredGap(from: PropSchema, to: PropSchema): string | null {
  if (to.required && !guaranteesValue(from)) return `“${to.label}” is required, but “${from.label}” can be empty`;
  if ((to.type === 'list' && from.type === 'list') || (to.type === 'object' && from.type === 'object')) {
    const fields = Object.fromEntries(fieldsOf(from));
    for (const [k, f] of fieldsOf(to)) {
      if (!f.required) continue;
      const src = Object.hasOwn(fields, k) ? fields[k] : undefined;
      if (!src) return `its field “${f.label}” is required, but “${from.label}” has no field “${k}”`;
      // A value of another type is no value for it, however sure it is to be set (a number is no picture).
      if (src.type !== f.type) return `its field “${f.label}” is required, but “${src.label}” of “${from.label}” is a ${src.type}, not a ${f.type}`;
      if (!guaranteesValue(src)) return `its field “${f.label}” is required, but “${src.label}” of “${from.label}” can be empty`;
    }
  }
  return null;
}
