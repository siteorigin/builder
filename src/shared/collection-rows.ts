/**
 * Collection rows (#677): an entry read as one item of a list. A list property connected to a collection (a placed
 * section's `listSources`) and a collection loop (a repeat over `{ $query }` or `{ $archive }`) both show entries,
 * each read field by field by the names a layout's bindings use (see shared/entry-fields.ts): `title`, `excerpt`,
 * `publishedAt`, `featuredImage`, `categories`, `terms.<taxonomy>`, `field.<name>`, `body`, `readingTime`, and three
 * a row has of its own: `id`, `slug` and `entryLink` (a link to the entry's page, which goes nowhere for an entry
 * without one). The entries before and after one entry belong to its own page, not to a list: no row reads them.
 *
 * A field fills an item field (or a place in an element) of a type that can show it: a picture a picture, a link a
 * link, a number or a yes/no a number or a yes/no, a choice a choice that offers every one of its options, and text
 * (a date written out, a grouping's labels, the titles of the entries a reference names) text or rich text. Nothing
 * here runs in the exported site: the rows are written into it when it is generated.
 */
import type { Collection, EntryDoc, ImageValue, LinkValue, ListConnection, PropSchema, ProjectState, RichText } from './types';
import { hasDetailPages } from './collections';
import { entryChoiceProblem, entryFieldSchema, entryFieldSchemas, entryFieldValue, type EntryValueForm } from './entry-fields';
import { isRichBlock, richTextToPlain } from './richtext';
import { normalizeCollectionQuery } from './collection-query';

/** The row field that links to the entry's page. */
export const ENTRY_LINK_FIELD = 'entryLink';

/** The fields of one entry's page that no list reads. */
const NEIGHBOUR_FIELDS: ReadonlySet<string> = new Set(['prevEntry', 'prevEntry.title', 'prevEntry.label', 'nextEntry', 'nextEntry.title', 'nextEntry.label', 'entryNavLabel']);

const NO_LINK: LinkValue = { type: 'none', target: '' };
const EMPTY_IMAGE: ImageValue = { assetId: null, alt: '' };

/** The fields a row has of its own, beside the entry's. */
const ROW_FIELDS: Record<string, PropSchema> = {
  id: { type: 'string', label: 'Entry ID', default: '' },
  slug: { type: 'string', label: 'Slug', default: '' },
  [ENTRY_LINK_FIELD]: { type: 'link', label: 'Link to its page', default: NO_LINK }
};

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The schema of a field a row of `collection` reads, or undefined for one it does not have. */
export function rowFieldSchema(collection: Pick<Collection, 'settings'>, field: string): PropSchema | undefined {
  if (typeof field !== 'string' || NEIGHBOUR_FIELDS.has(field)) return undefined;
  return own(ROW_FIELDS, field) ?? entryFieldSchema(collection, field);
}

/** Every field a row of `collection` reads, by name, in the order they are offered: the entry's, then the row's own. */
export function rowFieldSchemas(collection: Pick<Collection, 'settings'>): Record<string, PropSchema> {
  const out: Record<string, PropSchema> = {};
  for (const [name, schema] of Object.entries(entryFieldSchemas(collection))) if (!NEIGHBOUR_FIELDS.has(name)) out[name] = schema;
  return { ...out, ...ROW_FIELDS };
}

/** The value one field has in an entry's row, as entryFieldValue reads it (a date written out unless `raw`). */
export function rowFieldValue(state: Pick<ProjectState, 'site' | 'assets' | 'collections'>, collection: Collection, entry: EntryDoc, field: string, form: EntryValueForm = 'shown'): unknown {
  switch (field) {
    case 'id':
      return entry.id;
    case 'slug':
      return typeof entry.slug === 'string' ? entry.slug : '';
    case ENTRY_LINK_FIELD:
      // A record without a page of its own links nowhere: the item shows its words alone.
      return hasDetailPages(collection.settings) ? { type: 'entry', target: entry.id } : NO_LINK;
  }
  if (NEIGHBOUR_FIELDS.has(field)) return undefined;
  return entryFieldValue({ state, collection, entry, neighbours: {} }, field, form);
}

/** A value as a property of type `type` takes it: an entry's value of a kind that fits (see fieldFits), else an empty one. */
export function asType(type: PropSchema['type'], v: unknown): unknown {
  switch (type) {
    case 'string':
    case 'enum':
    case 'icon':
      if (Array.isArray(v)) return v.every(isRichBlock) ? richTextToPlain(v as RichText) : '';
      return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    case 'boolean':
      return v === true;
    case 'image':
      return v && typeof v === 'object' && 'assetId' in v ? v : EMPTY_IMAGE;
    case 'link':
      return v && typeof v === 'object' && 'type' in v ? v : NO_LINK;
    case 'richtext':
      return Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [{ type: 'p', spans: [{ text: v }] }] : typeof v === 'number' ? [{ type: 'p', spans: [{ text: String(v) }] }] : [];
    default:
      return v;
  }
}

/** The entry field types each item field type can show. */
const FITS: Partial<Record<PropSchema['type'], readonly string[]>> = {
  string: ['string', 'enum', 'number', 'richtext'],
  richtext: ['richtext', 'string', 'enum'],
  icon: ['string', 'enum'],
  enum: ['enum'],
  number: ['number'],
  boolean: ['boolean'],
  image: ['image'],
  link: ['link']
};

/**
 * Why an entry field cannot fill an item field: a kind the item field cannot show, or a choice offering an option the
 * item field lacks. Null when it fits.
 */
export function fieldFitProblem(source: PropSchema, target: PropSchema): string | null {
  const ok = FITS[target.type];
  if (!ok) return `"${target.label}" is a ${target.type === 'choices' ? 'set of choices' : target.type}, which no entry field fills.`;
  if (!ok.includes(source.type)) return `"${source.label}" (${kindWord(source.type)}) cannot fill "${target.label}", which shows ${ok.map(kindWord).join(' or ')}.`;
  const choice = entryChoiceProblem(source, target);
  return choice ? `"${source.label}" ${choice}` : null;
}

const kindWord = (t: string) => (t === 'string' ? 'text' : t === 'richtext' ? 'rich text' : t === 'enum' ? 'a choice' : t === 'boolean' ? 'yes/no' : t);

/** One entry field's value as an item field of `target`'s type shows it: a number or yes/no as it is, the rest as shown. */
export function projectField(state: Pick<ProjectState, 'site' | 'assets' | 'collections'>, collection: Collection, entry: EntryDoc, field: string, target: PropSchema): unknown {
  const raw = target.type === 'number' || target.type === 'boolean';
  return asType(target.type, rowFieldValue(state, collection, entry, field, raw ? 'raw' : 'shown'));
}

/**
 * A connected list's items: one per entry, keyed by the entry's ID, each item field the map fills read from the
 * entry, and every other one its default. Fields the map names that the list no longer has are left out.
 */
export function connectedItems(state: Pick<ProjectState, 'site' | 'assets' | 'collections'>, fields: Record<string, PropSchema>, connection: Pick<ListConnection, 'fields'>, collection: Collection | undefined, entries: readonly EntryDoc[]): Array<Record<string, unknown>> {
  if (!collection) return [];
  const map = connection.fields && typeof connection.fields === 'object' ? connection.fields : {};
  return entries.map((entry) => {
    const item: Record<string, unknown> = { id: entry.id };
    for (const [name, schema] of Object.entries(fields)) {
      const source = own(map, name);
      item[name] = typeof source === 'string' && rowFieldSchema(collection, source) ? projectField(state, collection, entry, source, schema) : structuredClone(schema.default);
    }
    return item;
  });
}

/** A connection read into its canonical form, or null when it is none: a query that is no query, or a map that is not text to text. */
export function normalizeConnection(raw: unknown): ListConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { query, fields } = raw as { query?: unknown; fields?: unknown };
  const q = normalizeCollectionQuery(query);
  if (!q || !fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const map: Record<string, string> = {};
  for (const k of Object.keys(fields).sort()) {
    const v = (fields as Record<string, unknown>)[k];
    if (typeof v !== 'string') return null;
    if (v) map[k] = v;
  }
  return { query: q, fields: map };
}
