/**
 * Tool signatures for a grammar-constrained local model. A grammar holds the output to the schema, but the model
 * never sees that schema: the signature is how it learns each tool's fields, once, in as few bytes as it can read,
 * because a local model reads every byte before its first token.
 *
 * The notation: a field is an optional string unless it says otherwise, `!` marks a required field, `a|b` lists
 * the allowed values (a bare word is a string), `T[]` is a list and `...T` stands for the fields of `T`. A type that
 * repeats is named once and used by that name. A list of objects told apart by one field (a page's sections, by
 * componentId) is a table: one row per value, with the fields that value takes.
 */
import { OPEN_VALUE_KEY, type JsonSchema } from './strict-schema';

export const SIGNATURE_LEGEND = 'Signatures: a field is an optional string unless typed; ! required; a|b allowed values (bare words are strings); T[] a list; ...T the fields of T.';

/** Words the notation uses itself: an allowed value spelled the same is quoted. */
const RESERVED = new Set(['string', 'int', 'number', 'bool', 'boolean', 'null', 'json', 'json-object', 'true', 'false']);
const BARE_VALUE = /^[A-Za-z][\w.\-/]*$/;
const BARE_FIELD = /^[A-Za-z_][\w-]*$/;
/** A union smaller than this reads as well written out. */
const MIN_TABLE_ROWS = 3;

const key = (schema: JsonSchema) => JSON.stringify(schema);
const isPlainString = (schema: JsonSchema) => schema.type === 'string' && !Array.isArray(schema.enum);

export function isOpenObject(schema: JsonSchema): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  return schema.type === 'object' && !!props && Object.keys(props).length === 1 && OPEN_VALUE_KEY in props;
}

const fieldsOf = (schema: JsonSchema) => Object.entries(schema.properties as Record<string, JsonSchema>);
const requiredOf = (schema: JsonSchema) => new Set((schema.required as string[] | undefined) ?? []);

/** The field every branch of a union starts with, required, holding one word that tells the branches apart. */
function discriminator(schema: JsonSchema): string | null {
  const branches = schema.anyOf;
  if (!Array.isArray(branches) || branches.length < MIN_TABLE_ROWS) return null;
  const objects = branches as JsonSchema[];
  if (!objects.every((b) => b.type === 'object' && !isOpenObject(b) && fieldsOf(b).length > 0)) return null;
  const field = fieldsOf(objects[0])[0][0];
  const values = new Set<string>();
  for (const b of objects) {
    const [name, value] = fieldsOf(b)[0];
    const only = Array.isArray(value.enum) && value.enum.length === 1 ? value.enum[0] : undefined;
    if (name !== field || !requiredOf(b).has(name) || typeof only !== 'string' || !BARE_VALUE.test(only) || values.has(only)) return null;
    values.add(only);
  }
  return field;
}

/** Whether `text` offers alternatives at its top level, outside any braces, brackets or quotes. */
function hasTopLevelChoice(text: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === '|' && depth === 0) return true;
  }
  return false;
}

class Renderer {
  /** Named types, by the schema they stand for. */
  readonly names = new Map<string, string>();
  /** The names in the order they were chosen, with what each stands for. */
  readonly order: Array<{ name: string; schema: JsonSchema }> = [];
  private taken = new Set<string>();
  /** Runs of fields written as `...Name`, in the order they were chosen. */
  readonly groups: Array<{ name: string; fields: string[]; defined: boolean }> = [];
  /** Every field list written, after the groups so far, while choosing the next group. */
  recorded: string[][] | null = null;

  add(name: string, schema: JsonSchema) {
    this.names.set(key(schema), name);
    this.taken.add(name);
    this.order.push({ name, schema });
  }

  freeName(base: string): string {
    let name = base;
    for (let n = 2; this.taken.has(name) || RESERVED.has(name.toLowerCase()); n++) name = `${base}${n}`;
    return name;
  }

  private value(v: unknown): string {
    return typeof v === 'string' && BARE_VALUE.test(v) && !RESERVED.has(v) && !this.taken.has(v) ? v : JSON.stringify(v);
  }

  /** An enum, starting with the longest named enum it extends, such as `Tone|brand`. */
  private choices(values: unknown[]): string {
    let best: { name: string; length: number } | null = null;
    for (const { name, schema } of this.order) {
      const base = schema.enum;
      if (!Array.isArray(base) || base.length < 2 || base.length >= values.length || (best && base.length <= best.length)) continue;
      if (base.every((v, i) => v === values[i])) best = { name, length: base.length };
    }
    const rest = values.slice(best?.length ?? 0).map((v) => this.value(v));
    return [...(best ? [best.name] : []), ...rest].join('|');
  }

  /** `defined`: the name is already a type with exactly these fields, so it needs no line of its own. */
  addGroup(name: string, fields: string[], defined: boolean) {
    this.taken.add(name);
    this.groups.push({ name, fields, defined });
  }

  /** A field list with each run a group stands for written as `...Name`. */
  spread(tokens: string[]): string[] {
    let out = tokens;
    for (const g of this.groups) {
      const at = indexOfRun(out, g.fields);
      // A list that is exactly the group is that type: it is written by its name, not spread.
      if (at >= 0 && g.fields.length < out.length) out = [...out.slice(0, at), `...${g.name}`, ...out.slice(at + g.fields.length)];
    }
    this.recorded?.push(out);
    return out;
  }

  /** The fields of an object, each as `name`, `name!`, `name:type` or `name!:type`. */
  fields(schema: JsonSchema, skip = 0): string[] {
    const required = requiredOf(schema);
    return fieldsOf(schema)
      .slice(skip)
      .map(([k, v]) => {
        const name = `${BARE_FIELD.test(k) ? k : JSON.stringify(k)}${required.has(k) ? '!' : ''}`;
        return isPlainString(v) && !this.names.has(key(v)) ? name : `${name}:${this.render(v)}`;
      });
  }

  render(schema: JsonSchema, top = false): string {
    const named = top ? undefined : this.names.get(key(schema));
    if (named) return named;
    if (Array.isArray(schema.enum)) return this.choices(schema.enum);
    if (Array.isArray(schema.anyOf)) {
      const branches = schema.anyOf as JsonSchema[];
      if (branches.some(isOpenObject)) return 'json';
      return branches.map((b) => this.render(b)).join('|');
    }
    if (isOpenObject(schema)) return 'json-object';
    if (schema.type === 'array') {
      const inner = this.render(schema.items as JsonSchema);
      return hasTopLevelChoice(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    if (schema.type === 'object') return `{${this.spread(this.fields(schema)).join(',')}}`;
    if (schema.type === 'integer') return 'int';
    if (schema.type === 'boolean') return 'bool';
    return String(schema.type);
  }

  /** What a name stands for, as its line in the list of types. */
  definition(name: string, schema: JsonSchema): string {
    const field = discriminator(schema);
    if (!field) return `${name}=${this.render(schema, true)}`;
    const rows = (schema.anyOf as JsonSchema[]).map((b) => {
      const value = fieldsOf(b)[0][1].enum as string[];
      const rest = this.fields(b, 1);
      return { value: value[0], rest };
    });
    // Fields every row starts with, the same way, are said once for all of them, keeping the order they go in.
    let shared = 0;
    while (shared < rows[0].rest.length && rows.every((r) => r.rest[shared] === rows[0].rest[shared])) shared++;
    const lines = rows.map((r) => `${r.value} {${this.spread(r.rest.slice(shared)).join(',')}}`);
    return `${name}=one of these, by ${field}!${shared ? `, each then with ${rows[0].rest.slice(0, shared).join(',')}` : ''}:\n${lines.join('\n')}`;
  }
}

function indexOfRun(list: string[], run: string[]): number {
  for (let i = 0; i + run.length <= list.length; i++) if (run.every((t, j) => list[i + j] === t)) return i;
  return -1;
}

/** The schemas directly inside a node, each with the field it describes. */
function parts(schema: JsonSchema, field: string): Array<[JsonSchema, string]> {
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as JsonSchema[]).map((b) => [b, field]);
  if (schema.type === 'array') return [[schema.items as JsonSchema, field]];
  if (schema.type === 'object' && !isOpenObject(schema)) return fieldsOf(schema).map(([k, v]) => [v, k]);
  return [];
}

/** `headingFont` and `bodyFont` share `Font`; fields with nothing in common are named after the first. */
function nameFor(fields: string[], fallback: string): string {
  const words = fields.filter((f) => BARE_FIELD.test(f)).map((f) => f.replace(/-/g, '').split(/(?=[A-Z])/));
  if (!words.length) return fallback;
  let common = words[0];
  for (const w of words.slice(1)) {
    let n = 0;
    while (n < common.length && n < w.length && common[common.length - 1 - n].toLowerCase() === w[w.length - 1 - n].toLowerCase()) n++;
    common = common.slice(common.length - n);
  }
  const chosen = common.length ? common : words[0];
  return chosen.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

/**
 * Each tool's signature, and the named types they share, for a set of strict argument schemas. A type is named when
 * writing it once and using its name is shorter than repeating it; a union of objects told apart by one field is
 * always named, so it can be written as a table.
 */
export function signatures(schemas: JsonSchema[]): { types: string[]; tools: string[] } {
  const r = new Renderer();
  // Tables first, from the outside in: their rows are what the other names are counted within.
  const findTables = (node: JsonSchema, field: string) => {
    if (r.names.has(key(node))) return;
    if (discriminator(node)) {
      const singular = field.length > 3 && field.endsWith('s') ? field.slice(0, -1) : field;
      r.add(r.freeName(nameFor([singular], 'Choice')), node);
    }
    for (const [child, f] of parts(node, field)) findTables(child, f);
  };
  for (const s of schemas) for (const [child, f] of parts(s, '')) findTables(child, f);

  for (;;) {
    const seen = new Map<string, { node: JsonSchema; uses: number; fields: string[] }>();
    const visit = (node: JsonSchema, field: string) => {
      const k = key(node);
      if (r.names.has(k)) return;
      const entry = seen.get(k);
      if (entry) {
        entry.uses++;
        entry.fields.push(field);
      } else seen.set(k, { node, uses: 1, fields: [field] });
      for (const [child, f] of parts(node, field)) visit(child, f);
    };
    // A tool's own arguments and a named type's body are written out once whatever happens.
    for (const root of [...schemas, ...r.order.map((o) => o.schema)]) for (const [child, f] of parts(root, '')) visit(child, f);
    let best: { node: JsonSchema; name: string; saving: number } | null = null;
    for (const { node, uses, fields } of seen.values()) {
      // A primitive is as short as any name it could have.
      if (uses < 2 || !(Array.isArray(node.enum) || Array.isArray(node.anyOf) || node.type === 'object' || node.type === 'array')) continue;
      const name = r.freeName(nameFor(fields, 'Type'));
      const length = r.render(node).length;
      const saving = uses * length - uses * name.length - (name.length + length + 2);
      if (saving > 0 && (!best || saving > best.saving)) best = { node, name, saving };
    }
    if (!best) break;
    r.add(best.name, best.node);
  }
  chooseGroups(r, schemas);
  // Plain types come before the tables that use them.
  const lines = [...r.order.map(({ name, schema }) => ({ name, text: r.definition(name, schema) })), ...r.groups.filter((g) => !g.defined).map((g) => ({ name: g.name, text: groupLine(g) }))];
  return { types: dependencyOrder(lines), tools: schemas.map((s) => r.render(s, true)) };
}

/** Everything the signatures write, as text, so a choice can be measured by what it saves. */
function writeAll(r: Renderer, schemas: JsonSchema[]): string {
  return [...r.order.map(({ name, schema }) => r.definition(name, schema)), ...groupLines(r), ...schemas.map((s) => r.render(s, true))].join('\n');
}

const groupLine = (g: { name: string; fields: string[] }) => `${g.name}={${g.fields.join(',')}}`;

function groupLines(r: Renderer): string[] {
  return r.groups.filter((g) => !g.defined).map(groupLine);
}

/** Each type after the types it uses, so the model never meets a name before its definition. */
function dependencyOrder(lines: Array<{ name: string; text: string }>): string[] {
  const out: string[] = [];
  const placed = new Set<string>();
  const uses = (text: string, name: string) => new RegExp(`(?<![\\w.-])${name}(?![\\w-])`).test(text);
  const place = (line: { name: string; text: string }, path: string[]) => {
    if (placed.has(line.name) || path.includes(line.name)) return;
    const body = line.text.slice(line.name.length + 1);
    for (const other of lines) if (other.name !== line.name && uses(body, other.name)) place(other, [...path, line.name]);
    placed.add(line.name);
    out.push(line.text);
  };
  for (const line of lines) place(line, []);
  return out;
}

/**
 * Name each run of fields that several objects share, whenever `...Name` and one definition are shorter than the
 * repeats. A run that is a named object's whole field list uses that name, which is already defined.
 */
function chooseGroups(r: Renderer, schemas: JsonSchema[]) {
  for (;;) {
    r.recorded = [];
    writeAll(r, schemas);
    const lists = r.recorded;
    r.recorded = null;
    const named = new Map<string, string>();
    for (const { name, schema } of r.order) if (schema.type === 'object' && !isOpenObject(schema)) named.set(r.fields(schema).join(','), name);
    const uses = new Map<string, { tokens: string[]; n: number }>();
    for (const list of lists) {
      const seen = new Set<string>();
      for (let i = 0; i < list.length; i++)
        for (let j = i + 2; j <= list.length; j++) {
          // A whole list is its own type, which naming would not shorten.
          if (i === 0 && j === list.length) continue;
          const tokens = list.slice(i, j);
          const run = tokens.join(',');
          if (seen.has(run)) continue;
          seen.add(run);
          const entry = uses.get(run);
          if (entry) entry.n++;
          else uses.set(run, { tokens, n: 1 });
        }
    }
    let best: { tokens: string[]; name: string; defined: boolean; saving: number } | null = null;
    for (const [run, { tokens, n }] of uses) {
      const existing = named.get(run);
      if (n < 2 && !existing) continue;
      const name = existing ?? r.freeName(`${nameFor([tokens[0].replace(/[!:].*$/, '')], 'Group')}Fields`);
      const saving = n * (run.length - name.length - 3) - (existing ? 0 : name.length + run.length + 4);
      if (saving > 0 && (!best || saving > best.saving)) best = { tokens, name, defined: !!existing, saving };
    }
    if (!best) return;
    r.addGroup(best.name, best.tokens, best.defined);
  }
}

/** The signature of one strict schema on its own, with nothing named. */
export function signature(schema: JsonSchema): string {
  return new Renderer().render(schema, true);
}
