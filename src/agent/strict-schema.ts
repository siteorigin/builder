/**
 * Converts tool parameter schemas to a strict JSON Schema subset that grammar-constrained decoders
 * (llama.cpp GBNF, XGrammar, Outlines) can compile. The output is built from an allow-list of keywords, so
 * nothing open-ended can leak through: every object is closed and every position has a concrete type.
 *
 * A value the source schema leaves open (`{}`, a record) cannot be described to a grammar. Plain scalars stay
 * as they are, and anything structured is carried as a JSON-encoded string in a one-key `{ "$json": "…" }`
 * object, which `decodeStrictValue` turns back into the real value before the arguments are validated.
 */

export type JsonSchema = Record<string, unknown>;

/** Reserved key for a JSON-encoded value at an open position. No tool schema declares it. */
export const OPEN_VALUE_KEY = '$json';

/** Longer limits expand into very large grammars; the app's own validation still enforces them. */
const MAX_GRAMMAR_LENGTH = 512;
const MAX_GRAMMAR_ITEMS = 64;

const openObject = (): JsonSchema => ({
  type: 'object',
  properties: { [OPEN_VALUE_KEY]: { type: 'string' } },
  required: [OPEN_VALUE_KEY],
  additionalProperties: false
});

const openValue = (): JsonSchema => ({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, openObject()] });

const isRecord = (v: unknown): v is JsonSchema => !!v && typeof v === 'object' && !Array.isArray(v);

function anyOf(branches: JsonSchema[]): JsonSchema {
  const seen = new Set<string>();
  const flat: JsonSchema[] = [];
  for (const b of branches)
    for (const x of Array.isArray(b.anyOf) ? (b.anyOf as JsonSchema[]) : [b]) {
      const key = JSON.stringify(x);
      if (!seen.has(key)) {
        seen.add(key);
        flat.push(x);
      }
    }
  return flat.length === 1 ? flat[0] : { anyOf: flat };
}

/** Resolve a local JSON Pointer such as `#/$defs/name`. */
function pointer(root: JsonSchema, ref: string): unknown {
  let target: unknown = root;
  try {
    for (const raw of ref.slice(1).split('/').slice(1)) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(target)) target = target[Number(key)];
      else if (isRecord(target) && Object.hasOwn(target, key)) target = target[key];
      else return undefined;
    }
  } catch {
    return undefined;
  }
  return target;
}

/** Combine schemas that must all hold: properties and required lists add up, and a union is distributed. */
function intersect(parts: JsonSchema[], root: JsonSchema, refs: string[]): JsonSchema {
  const at = parts.findIndex((p) => Array.isArray(p.anyOf ?? p.oneOf));
  if (at >= 0) {
    const { anyOf: a, oneOf: o, ...rest } = parts[at];
    const others = [...parts.slice(0, at), rest, ...parts.slice(at + 1)];
    return { anyOf: ((a ?? o) as unknown[]).map((b) => intersect([...others, (isRecord(b) && flatten(b, root, refs)?.schema) || {}], root, refs)) };
  }
  let out: JsonSchema = {};
  const properties = new Map<string, unknown>();
  const required = new Set<string>();
  let declares = false;
  for (const { properties: props, required: req, ...rest } of parts) {
    out = { ...out, ...rest };
    if (isRecord(props)) {
      declares = true;
      for (const [k, v] of Object.entries(props)) properties.set(k, properties.has(k) ? { allOf: [properties.get(k), v] } : v);
    }
    if (Array.isArray(req)) for (const k of req as string[]) required.add(k);
  }
  if (declares) out.properties = Object.fromEntries(properties);
  if (required.size) out.required = [...required];
  return out;
}

/**
 * Resolve `$ref` (with its sibling keywords) and `allOf` into one schema, with the references followed to get
 * there. Returns null for a cycle or a reference that cannot be resolved: neither has a finite grammar.
 */
function flatten(input: JsonSchema, root: JsonSchema, refs: string[]): { schema: JsonSchema; refs: string[] } | null {
  const { $ref, allOf, $defs: _defs, definitions: _definitions, ...rest } = input;
  if ($ref === undefined && !Array.isArray(allOf)) return { schema: rest, refs };
  const parts: JsonSchema[] = [];
  const seen = new Set(refs);
  const add = (member: JsonSchema, path: string[]) => {
    const f = flatten(member, root, path);
    if (!f) return false;
    parts.push(f.schema);
    for (const r of f.refs) seen.add(r);
    return true;
  };
  if ($ref !== undefined) {
    if (typeof $ref !== 'string' || !$ref.startsWith('#') || refs.includes($ref)) return null;
    const target = pointer(root, $ref);
    if (!isRecord(target) || !add(target, [...refs, $ref])) return null;
  }
  if (Array.isArray(allOf)) for (const member of allOf) if (isRecord(member) && !add(member, refs)) return null;
  if (Object.keys(rest).length) parts.push(rest);
  const path = [...seen];
  return { schema: intersect(parts, root, path), refs: path };
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  switch (type) {
    case 'string':
    case 'boolean':
    case 'number':
      return typeof value === type;
    case 'integer':
      return Number.isInteger(value);
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
  }
  return true;
}

function literal(values: unknown[], type: unknown): JsonSchema {
  const kept = values.filter((v) => matchesType(v, type));
  const list = kept.length ? kept : values;
  // A structured literal is matched exactly, so it needs no object or array rule around it.
  const scalar = list.every((v) => v === null || typeof v !== 'object');
  return { ...(typeof type === 'string' && scalar ? { type } : {}), enum: [...list] };
}

function convert(input: unknown, root: JsonSchema, inherited: string[]): JsonSchema {
  if (!isRecord(input)) return openValue();
  const flat = flatten(input, root, inherited);
  if (!flat) return openValue();
  const { schema, refs } = flat;
  const next = (s: unknown) => convert(s, root, refs);

  const union = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(union) && union.length) return anyOf(union.map(next));

  if ('const' in schema) return literal([schema.const], schema.type);
  if (Array.isArray(schema.enum) && schema.enum.length) return literal(schema.enum, schema.type);

  if (Array.isArray(schema.type)) return anyOf((schema.type as string[]).map((type) => next({ ...schema, type })));

  switch (schema.type) {
    case 'object':
      return strictObject(schema, next);
    case 'array':
      return strictArray(schema, next);
    case 'string': {
      const out: JsonSchema = { type: 'string' };
      if (typeof schema.minLength === 'number' && schema.minLength <= MAX_GRAMMAR_LENGTH) out.minLength = schema.minLength;
      if (typeof schema.maxLength === 'number' && schema.maxLength <= MAX_GRAMMAR_LENGTH) out.maxLength = schema.maxLength;
      return out;
    }
    case 'integer': {
      const out: JsonSchema = { type: 'integer' };
      if (Number.isSafeInteger(schema.minimum)) out.minimum = schema.minimum;
      if (Number.isSafeInteger(schema.maximum)) out.maximum = schema.maximum;
      return out;
    }
    case 'number':
    case 'boolean':
    case 'null':
      return { type: schema.type };
  }
  // No usable type. Properties still imply an object; anything else is an open value.
  if (isRecord(schema.properties)) return strictObject(schema, next);
  return openValue();
}

function strictObject(schema: JsonSchema, next: (s: unknown) => JsonSchema): JsonSchema {
  // A record, or an object with keys beyond those it declares, has keys no grammar can list.
  const extra = schema.additionalProperties;
  if (!isRecord(schema.properties) || extra === true || isRecord(extra)) return openObject();
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, next(v)]));
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((k) => Object.hasOwn(properties, k)) : [];
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function strictArray(schema: JsonSchema, next: (s: unknown) => JsonSchema): JsonSchema {
  const tuple = Array.isArray(schema.prefixItems) ? (schema.prefixItems as unknown[]) : [];
  const rest = schema.items;
  // Positions cannot all be kept in the subset, so a tuple offers its item types; validation checks the order.
  const items = tuple.length ? anyOf([...tuple, ...(rest === undefined || rest === false ? [] : [rest])].map(next)) : next(rest);
  const out: JsonSchema = { type: 'array', items };
  const max = schema.maxItems ?? (tuple.length && rest === false ? tuple.length : undefined);
  if (typeof schema.minItems === 'number' && schema.minItems <= MAX_GRAMMAR_ITEMS) out.minItems = schema.minItems;
  if (typeof max === 'number' && max <= MAX_GRAMMAR_ITEMS) out.maxItems = max;
  return out;
}

/** Convert a tool parameter schema to the strict, grammar-compilable subset. The input is not modified. */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  return convert(schema, schema, []);
}

const FORBIDDEN_KEYWORDS = [
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  '$defs',
  'definitions',
  'propertyNames',
  'patternProperties',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'pattern',
  'format'
];

/** Every shape in a schema that a grammar compiler cannot handle, as `path: problem`. Empty means strict. */
export function findForbiddenShapes(schema: unknown, path = '$'): string[] {
  if (!isRecord(schema)) return [`${path}: not a schema object`];
  const problems: string[] = [];
  if (Object.keys(schema).length === 0) problems.push(`${path}: empty schema`);
  for (const k of FORBIDDEN_KEYWORDS) if (k in schema) problems.push(`${path}: forbidden keyword ${k}`);
  if (Array.isArray(schema.anyOf)) (schema.anyOf as unknown[]).forEach((s, i) => problems.push(...findForbiddenShapes(s, `${path}.anyOf[${i}]`)));
  else if (!('enum' in schema) && !('type' in schema)) problems.push(`${path}: no type`);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) problems.push(`${path}: object is not closed`);
    if (!isRecord(schema.properties)) problems.push(`${path}: object declares no properties`);
    else for (const [k, v] of Object.entries(schema.properties)) problems.push(...findForbiddenShapes(v, `${path}.${k}`));
  } else if ('additionalProperties' in schema) problems.push(`${path}: additionalProperties outside an object`);
  if (schema.type === 'array') {
    if (!('items' in schema)) problems.push(`${path}: array without items`);
    else problems.push(...findForbiddenShapes(schema.items, `${path}[]`));
  }
  return problems;
}

/**
 * Restore the values carried as `{ "$json": "…" }`. Throws a SyntaxError when one does not parse, so a broken
 * value can never reach a tool as if it were content.
 */
export function decodeStrictValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStrictValue);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === OPEN_VALUE_KEY && typeof value[OPEN_VALUE_KEY] === 'string') return JSON.parse(value[OPEN_VALUE_KEY] as string);
  return Object.fromEntries(keys.map((k) => [k, decodeStrictValue(value[k])]));
}
