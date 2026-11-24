import type { PropSchema } from '@shared/types';
import { checkPropName } from '@engine/schema';

/**
 * The editable property schema (manifest) of a code component, as rows. Each row is one property: its name and the
 * schema it is saved with. A list property's item fields are rows of their own, so each keeps its identity while it
 * is renamed or retyped. The engine validates the whole schema when it is saved; these checks catch what a row would
 * otherwise lose on the way there.
 */
export interface SchemaRow {
  key: string;
  name: string;
  /** The name the property was stored under, to tell a rename from a new property. */
  orig?: string;
  /** The schema; a list's `fields` in it are as stored, since `fields` below holds the edited ones. */
  schema: Record<string, unknown>;
  /** Text a setting refused, by setting, kept so it can be corrected. Saving is held until it is fixed. */
  drafts?: Record<string, { text: string; message: string }>;
  /** A list's item fields. */
  fields?: SchemaRow[];
}

export type PropType = PropSchema['type'];

export const TYPES: Array<[PropType, string]> = [
  ['string', 'Text'],
  ['richtext', 'Rich text'],
  ['number', 'Number'],
  ['boolean', 'On/off'],
  ['enum', 'Choice'],
  ['link', 'Link'],
  ['image', 'Image'],
  ['icon', 'Icon'],
  ['list', 'List'],
  ['table', 'Table']
];
/** A list item's fields are single values: no lists or tables inside one, but several choices can be. */
const ITEM_TYPES: Array<[PropType, string]> = [...TYPES.filter(([t]) => t !== 'list' && t !== 'table'), ['choices', 'Multiple choice']];
/** The most item fields a list can have. */
export const MAX_ITEM_FIELDS = 20;

/** The types a row can pick from, plus its own type when they leave it out (several choices, set in code). */
export function typeOptions(type: PropType, inList: boolean): Array<[PropType, string]> {
  const types = inList ? ITEM_TYPES : TYPES;
  return types.some(([t]) => t === type) ? types : [[type, type === 'choices' ? 'Multiple choice' : type], ...types];
}

let rowSeq = 0;
export const rowKey = () => `r${++rowSeq}`;

function toRow(name: string, raw: unknown, stored: boolean): SchemaRow {
  const schema = structuredClone(raw) as Record<string, unknown>;
  const row: SchemaRow = { key: rowKey(), name, ...(stored ? { orig: name } : {}), schema };
  if (schema.type === 'list') row.fields = Object.entries((schema.fields ?? {}) as Record<string, unknown>).map(([k, f]) => toRow(k, f, stored));
  return row;
}

/** Rows for a schema. `stored` is false for one that was never saved (a new component), so nothing is a rename. */
export function rowsFromProperties(props: Record<string, unknown>, stored = true): SchemaRow[] {
  return Object.entries(props).map(([name, schema]) => toRow(name, schema, stored));
}

function schemaOf(row: SchemaRow): Record<string, unknown> {
  let out = row.schema;
  if (row.fields) {
    // Replacing the stored `fields` keeps its place, so an unedited schema reads exactly as it was saved.
    out = { ...out, fields: Object.fromEntries(row.fields.map((f) => [f.name.trim(), schemaOf(f)])), ...listSettings(row) };
    for (const k of ['titleField', 'pageTeaser', 'default']) if (out[k] === undefined) delete out[k];
  }
  // Refused text counts as an unsaved change, so a host's dirty check and its schemaProblems gate both see it. That
  // gate stops any save while it is there, so the marker never reaches the engine.
  return row.drafts ? { ...out, refusedDrafts: row.drafts } : out;
}

export function propertiesFromRows(rows: SchemaRow[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((r) => [r.name.trim(), schemaOf(r)]));
}

/** Stored properties saved under a new name, so their placement content moves with them. */
export function renamesFromRows(rows: SchemaRow[]): Array<{ from: string; to: string }> {
  return rows.filter((r) => r.orig !== undefined && r.orig !== r.name.trim()).map((r) => ({ from: r.orig!, to: r.name.trim() }));
}

/**
 * Edits the built schema cannot show: two rows with one name, at either depth, which building the schema collapses
 * into one. They are unsaved, and saving refuses them until they are fixed.
 */
export function hiddenEdits(rows: SchemaRow[]): boolean {
  const names = rows.map((r) => r.name.trim());
  return new Set(names).size !== names.length || rows.some((r) => hiddenEdits(r.fields ?? []));
}

export const RANGE_PROBLEM = 'Maximum must be at least the minimum.';

/** What is wrong with a row's settings: text they refused, and a range that cannot hold a value. */
export function settingProblems(row: SchemaRow): string[] {
  const s = row.schema;
  const out = Object.values(row.drafts ?? {}).map((d) => d.message);
  if (s.type === 'number' && typeof s.min === 'number' && typeof s.max === 'number' && s.min > s.max) out.push(RANGE_PROBLEM);
  return out;
}

/** Problems with a list's item fields: their names, their number, and fields a page list still needs. */
function fieldProblems(row: SchemaRow, at: string): string[] {
  const fields = row.fields ?? [];
  const out: string[] = [];
  if (!fields.length) out.push(`${at}: add at least one item field.`);
  if (fields.length > MAX_ITEM_FIELDS) out.push(`${at}: a list can have up to ${MAX_ITEM_FIELDS} item fields.`);
  const seen = new Set<string>();
  for (const f of fields) {
    const n = f.name.trim();
    try {
      checkPropName(n, 'Field');
      if (seen.has(n)) out.push(`${at}: the field name "${n}" is used twice.`);
    } catch (e) {
      out.push(`${at}: ${(e as Error).message}`);
    }
    seen.add(n);
    for (const message of settingProblems(f)) out.push(`${at} → ${n}: ${message}`);
  }
  const teaser = listSettings(row).pageTeaser as Record<string, string> | undefined;
  for (const what of ['link', 'title'])
    if (teaser && !seen.has(teaser[what])) out.push(`${at}: its items show pages, using the field "${teaser[what]}" as the ${what}. Keep that field as it was, or revert.`);
  return out;
}

/** Problems the person can fix before saving; the engine checks everything else. */
export function schemaProblems(rows: SchemaRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const n = r.name.trim();
    try {
      checkPropName(n);
      if (seen.has(n)) out.push(`The property name "${n}" is used twice.`);
    } catch (e) {
      out.push((e as Error).message);
    }
    seen.add(n);
    for (const message of settingProblems(r)) out.push(`${n}: ${message}`);
    if (r.schema.type === 'list') out.push(...fieldProblems(r, n));
  }
  return out;
}

/** Defaults that make sense when a property changes type, so the engine never receives a mismatched default. */
export function retype(row: SchemaRow, type: PropType): SchemaRow {
  const s = row.schema;
  const schema: Record<string, unknown> = { type, label: s.label };
  if (s.description) schema.description = s.description;
  if (s.group) schema.group = s.group;
  if (type === 'enum') schema.options = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }];
  const next: SchemaRow = { key: row.key, name: row.name, ...(row.orig !== undefined ? { orig: row.orig } : {}), schema };
  if (type === 'list') {
    schema.itemLabel = 'Item';
    next.fields = [{ key: rowKey(), name: 'title', schema: { type: 'string', label: 'Title', default: '' } }];
  }
  return next;
}

// ---------------------------------------------------------------------------
// List item fields
// ---------------------------------------------------------------------------

type Items = Array<Record<string, unknown>>;

/** Whether a default item's value still fits a field: a choice still offered, a number still in range. */
function fits(field: Record<string, unknown>, v: unknown): boolean {
  if (field.type === 'enum') return Array.isArray(field.options) && field.options.some((o: unknown) => (typeof o === 'string' ? o : (o as { value?: unknown })?.value) === v);
  if (field.type === 'number' && typeof v === 'number') return !(typeof field.min === 'number' && v < field.min) && !(typeof field.max === 'number' && v > field.max);
  return true;
}

/**
 * A list's title field, page teaser and default items, following each item field from the name it was stored under
 * to the name it has now. Worked out from the stored list when the schema is built, so names typed in between (a
 * name another field still has, a blank one) never move anything. A field that is new, retyped or removed has no
 * stored values: the default items leave it out and the engine fills its default.
 */
function listSettings(row: SchemaRow): Record<string, unknown> {
  const stored = (row.schema.fields ?? {}) as Record<string, { type?: unknown }>;
  const fields = row.fields ?? [];
  const now = (name: unknown) => {
    const f = typeof name === 'string' ? fields.find((x) => x.orig === name && Object.hasOwn(stored, name) && stored[name].type === x.schema.type) : undefined;
    return f?.name.trim();
  };
  const out: Record<string, unknown> = {};
  // Any type of field can title an item, so the title follows its field through a retype too.
  if (row.schema.titleField !== undefined) out.titleField = fields.find((x) => x.orig === row.schema.titleField)?.name.trim();
  if (row.schema.pageTeaser && typeof row.schema.pageTeaser === 'object') {
    const teaser: Record<string, unknown> = {};
    // The link and title must stay: one that is gone keeps its old name, for schemaProblems to explain.
    for (const [k, v] of Object.entries(row.schema.pageTeaser as Record<string, unknown>)) teaser[k] = now(v) ?? (k === 'link' || k === 'title' ? v : undefined);
    for (const k of Object.keys(teaser)) if (teaser[k] === undefined) delete teaser[k];
    out.pageTeaser = teaser;
  }
  const items = row.schema.default;
  if (!Array.isArray(items)) return out;
  // Fields that are all as stored, holding values that all still fit, keep the default items exactly as stored.
  const same = fields.length === Object.keys(stored).length && fields.every((f) => f.orig === f.name.trim() && now(f.orig) !== undefined);
  if (same && (items as Items).every((item) => !!item && fields.every((f) => !Object.hasOwn(item, f.name.trim()) || fits(f.schema, item[f.name.trim()])))) out.default = items;
  else
    out.default = (items as Items).map((item) => {
      if (!item || typeof item !== 'object') return item;
      const next: Record<string, unknown> = Object.hasOwn(item, 'id') ? { id: item.id } : {};
      for (const f of fields) {
        const from = f.orig;
        if (from !== undefined && now(from) !== undefined && Object.hasOwn(item, from) && fits(f.schema, item[from])) next[f.name.trim()] = item[from];
      }
      return next;
    });
  return out;
}

/** Replace item field `index` of a list row. */
export function setItemField(row: SchemaRow, index: number, field: SchemaRow): SchemaRow {
  return { ...row, fields: (row.fields ?? []).map((f, i) => (i === index ? field : f)) };
}

export function addItemField(row: SchemaRow): SchemaRow {
  const fields = row.fields ?? [];
  const used = new Set(fields.map((f) => f.name.trim()));
  let n = fields.length + 1;
  while (used.has(`field${n}`)) n++;
  return { ...row, fields: [...fields, { key: rowKey(), name: `field${n}`, schema: { type: 'string', label: `Field ${n}`, default: '' } }] };
}

export function removeItemField(row: SchemaRow, index: number): SchemaRow {
  return { ...row, fields: (row.fields ?? []).filter((_, i) => i !== index) };
}

/** What saving loses that the author may not expect: item content under a stored item field that was renamed. */
export function itemFieldNote(field: SchemaRow): string | null {
  const name = field.name.trim();
  if (field.orig === undefined || field.orig === name) return null;
  return `Renamed from “${field.orig}”. Items already placed lose what they hold in it: list content stays with a field’s name.`;
}

/** Shown on a renamed property: its content moves, but the source is the author's to change. */
export function renameNote(row: SchemaRow): string | null {
  const name = row.name.trim();
  if (row.orig === undefined || row.orig === name) return null;
  return `Renamed from “${row.orig}”. Placements keep their content; update the source to read ${name}.`;
}

export const optionsText = (o: unknown) => (Array.isArray(o) ? o.map((x: { value: string; label: string }) => (x.label && x.label !== x.value ? `${x.value} | ${x.label}` : x.value)).join('\n') : '');
export const parseOptions = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [value, ...rest] = l.split('|');
      return { value: value.trim(), label: rest.join('|').trim() || value.trim() };
    });
