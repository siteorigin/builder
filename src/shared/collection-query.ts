/**
 * Collection queries (#674): a serializable description of which entries of one collection a page, a component, a
 * template or the assistant wants, worked out against the project's documents the same way every time. A query names
 * its collection (or `$current`, the one whose entry's page it is on), filters the entries by every clause of `where`,
 * sorts them and takes a slice of them.
 *
 * Fields are named as a layout's bindings name them: the built-in fields (`title`, `publishedAt`, ...), plus `id` and
 * `slug`, a grouping as `terms.<taxonomy>` (`categories` is `terms.categories`) and a custom field as `field.<name>`.
 * The previous and next entries (`prevEntry`, `nextEntry`) belong to one entry's page, not to a list: no query reads them.
 * A clause reads each value as stored: a date as YYYY-MM-DD, a grouping or a reference as the IDs it holds (a clause may
 * name a term by its label too), rich text as its words, a picture as its asset ID and a link as its target; a custom
 * field an entry leaves unset reads as its default.
 *
 * - `eq`, `ne`: the value is (is not) this one; a list holds (does not hold) it.
 * - `in`: the value is one of these; a list holds any of them. Terms it names that the grouping lacks are passed over.
 * - `contains`: the text holds this text, ignoring case; a list holds it.
 * - `gt`, `gte`, `lt`, `lte`: numbers by size, texts (dates among them) in UTF-16 code-unit order. A list or a blank text
 *   compares with nothing.
 * - `exists`: the entry has a value there: anything but blank text, an empty list or none (`0` and no are values).
 *   `value: false` asks for none.
 *
 * Values are compared as they are, so `true` never equals `"true"` and `10` never equals `"10"`. Drafts are left out,
 * and so is an entry whose collection gives it a page at an
 * address the site cannot have. A query naming a collection, field or term the project lacks finds nothing, and none
 * ever throws. Nothing here runs in the exported site.
 */
import type { Collection, EntryDoc, ProjectState, RichText } from './types';
import { hasDetailPages, isDraftEntry, siteEntries } from './collections';
import { entryFieldSchema, entryFieldValue, type EntryReadContext } from './entry-fields';
import { termNamed } from './entry-feed';
import { isRichBlock, richTextToPlain } from './richtext';

/** The collection whose entry's page a query is on. */
export const CURRENT_COLLECTION = '$current';

export const QUERY_OPERATORS = ['eq', 'ne', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists'] as const;
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

/** A value a clause compares with. */
export type QueryScalar = string | number | boolean;

/** One filter: the entries whose `field` passes `op` with `value`. */
export interface QueryClause {
  field: string;
  op: QueryOperator;
  /** A list for `in`; a yes/no for `exists` (absent: yes); one value for the rest. */
  value?: QueryScalar | QueryScalar[];
}

export type SortDirection = 'asc' | 'desc';

/** The field sorting by the collection's chosen editorial order reads. */
export const ENTRY_ORDER_FIELD = 'entryOrder';

/** One sort key: a field, or `entryOrder` for the collection's editorial order. */
export interface QuerySort {
  field: string;
  /** Absent: ascending. */
  direction?: SortDirection;
}

/** Which entries of one collection, in what order, and how many. */
export interface CollectionQuery {
  /** A collection's ID, or `$current` for the one whose entry's page the query is on. */
  collectionId: string;
  /** Filters every entry must pass (all of them). */
  where?: QueryClause[];
  /** Sort keys, the first deciding first; ties go by entry ID. Absent: the collection's own order. */
  sort?: QuerySort[];
  /** How many entries at most. */
  limit?: number;
  /** How many of the sorted entries to skip first. */
  offset?: number;
  /** Leave out the entry whose page the query is on. */
  excludeCurrent?: boolean;
}

/** Where a query runs: on an entry's page (its collection's layout), or anywhere else. */
export interface QueryPlace {
  entry?: { collectionId: string; entryId: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);
const isScalar = (v: unknown): v is QueryScalar => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/**
 * The query `raw` describes, in one canonical form (keys in a fixed order, defaults left out), or null when it is no
 * query: no collection, a clause or sort key of the wrong shape, an operator this version does not know, or a limit or
 * offset that is not a whole number of zero or more.
 */
export function normalizeCollectionQuery(raw: unknown): CollectionQuery | null {
  try {
    return normalize(raw);
  } catch {
    // A value that throws when read (a getter, a revoked proxy) is no query.
    return null;
  }
}

/** The place `raw` describes, read once into plain text: an entry's page only when both IDs are text. */
export function normalizePlace(raw: unknown): QueryPlace {
  try {
    const entry = isObj(raw) ? raw.entry : undefined;
    if (!isObj(entry)) return {};
    const collectionId = entry.collectionId;
    const entryId = entry.entryId;
    return typeof collectionId === 'string' && typeof entryId === 'string' ? { entry: { collectionId, entryId } } : {};
  } catch {
    return {};
  }
}

function normalize(raw: unknown): CollectionQuery | null {
  if (!isObj(raw) || typeof raw.collectionId !== 'string' || !raw.collectionId) return null;
  const where: QueryClause[] = [];
  if (raw.where !== undefined) {
    if (!Array.isArray(raw.where)) return null;
    for (const c of raw.where) {
      if (!isObj(c) || typeof c.field !== 'string' || !(QUERY_OPERATORS as readonly unknown[]).includes(c.op)) return null;
      const op = c.op as QueryOperator;
      if (op === 'exists') {
        if (c.value !== undefined && typeof c.value !== 'boolean') return null;
        where.push({
          field: c.field,
          op,
          ...(c.value === false ? { value: false } : {})
        });
      } else if (op === 'in') {
        // Read item by item, so a hole in the list is a value of the wrong kind rather than skipped.
        const values = Array.isArray(c.value) ? Array.from(c.value as unknown[]) : null;
        if (!values || !values.every(isScalar)) return null;
        where.push({ field: c.field, op, value: values });
      } else {
        if (!isScalar(c.value)) return null;
        where.push({ field: c.field, op, value: c.value });
      }
    }
  }
  const sort: QuerySort[] = [];
  if (raw.sort !== undefined) {
    if (!Array.isArray(raw.sort)) return null;
    for (const s of raw.sort) {
      if (!isObj(s) || typeof s.field !== 'string' || (s.direction !== undefined && s.direction !== 'asc' && s.direction !== 'desc')) return null;
      sort.push({
        field: s.field,
        ...(s.direction === 'desc' ? { direction: 'desc' as const } : {})
      });
    }
  }
  const limit = count(raw.limit);
  const offset = count(raw.offset);
  if ((raw.limit !== undefined && limit === undefined) || (raw.offset !== undefined && offset === undefined)) return null;
  if (raw.excludeCurrent !== undefined && typeof raw.excludeCurrent !== 'boolean') return null;
  return {
    collectionId: raw.collectionId,
    ...(where.length ? { where } : {}),
    ...(sort.length ? { sort } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset ? { offset } : {}),
    ...(raw.excludeCurrent === true ? { excludeCurrent: true } : {})
  };
}

/**
 * A stable key for a query where it runs: the same for every query that finds the same entries by the same rules
 * (however its keys are ordered), and naming the entry whose page it is on only when the query reads it. A derived
 * value of the generator can be named by it (see generator/collection-query.ts). Null for no query.
 */
export function collectionQueryKey(raw: unknown, place: QueryPlace = {}): string | null {
  const q = normalizeCollectionQuery(raw);
  if (!q) return null;
  const reads = q.collectionId === CURRENT_COLLECTION || q.excludeCurrent;
  const entry = reads ? normalizePlace(place).entry : undefined;
  const here = entry ? [entry.collectionId, entry.entryId] : null;
  return JSON.stringify([
    q.collectionId,
    (q.where ?? []).map((c) => [c.field, c.op, c.value ?? null]),
    (q.sort ?? []).map((s) => [s.field, s.direction ?? 'asc']),
    q.limit ?? null,
    q.offset ?? 0,
    !!q.excludeCurrent,
    here
  ]);
}

/** The collection a query reads: the one it names, or for `$current` the one whose entry's page it is on. */
export function queryCollection(state: ProjectState, query: Pick<CollectionQuery, 'collectionId'>, place: QueryPlace = {}): Collection | undefined {
  const id = query.collectionId === CURRENT_COLLECTION ? normalizePlace(place).entry?.collectionId : query.collectionId;
  const c = typeof id === 'string' ? own(state.collections, id) : undefined;
  return c && isObj(c.settings) && c.settings.id === id && isObj(c.entries) ? c : undefined;
}

/** A field's value as a query reads it: one value, a list of IDs, or undefined for a field the collection lacks. */
type Read = QueryScalar | string[] | undefined;

/** The custom field kinds whose stored value a clause reads as it is. */
const PLAIN = new Set(['string', 'number', 'boolean', 'enum']);

/** Whether a collection has a field a query can read: the reader for it, or undefined. */
function fieldReader(state: ProjectState, collection: Collection, field: string): ((entry: EntryDoc) => Read) | undefined {
  const ctx = (entry: EntryDoc): EntryReadContext => ({
    state,
    collection,
    entry,
    neighbours: {}
  });
  const terms = (taxonomy: string) =>
    own(collection.settings.taxonomies, taxonomy)
      ? (entry: EntryDoc): string[] => {
          const ids = own(entry.terms, taxonomy);
          return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
        }
      : undefined;
  switch (field) {
    case 'id':
      return (e) => e.id;
    case 'slug':
      return (e) => (typeof e.slug === 'string' ? e.slug : '');
    case 'categories':
      return terms('categories');
    case 'featuredImage':
      return (e) => {
        const v = entryFieldValue(ctx(e), field) as { assetId?: unknown };
        return typeof v?.assetId === 'string' ? v.assetId : '';
      };
    case 'body':
    case 'title':
    case 'author':
    case 'excerpt':
    case 'publishedAt':
    case 'updatedAt':
    case 'readingTime': {
      // A field the collection's entries lack (the text of entries without any) is none.
      if (!entryFieldSchema(collection, field)) return undefined;
      return (e) => scalar(entryFieldValue(ctx(e), field, 'raw'));
    }
  }
  if (field.startsWith('terms.')) return terms(field.slice(6));
  if (field.startsWith('field.')) {
    const schema = own(collection.settings.fields, field.slice(6));
    if (!isObj(schema)) return undefined;
    if (schema.type === 'reference')
      return (e) => {
        const v = entryFieldValue(ctx(e), field, 'raw');
        return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : typeof v === 'string' ? v : '';
      };
    if (schema.type === 'image')
      return (e) => {
        const v = entryFieldValue(ctx(e), field) as { assetId?: unknown };
        return typeof v?.assetId === 'string' ? v.assetId : '';
      };
    if (schema.type === 'link')
      return (e) => {
        const v = entryFieldValue(ctx(e), field) as {
          type?: unknown;
          target?: unknown;
        };
        return isObj(v) && v.type !== 'none' && typeof v.target === 'string' ? v.target : '';
      };
    if (schema.type === 'date' || schema.type === 'richtext' || PLAIN.has(schema.type as string)) return (e) => scalar(entryFieldValue(ctx(e), field, 'raw'));
    return undefined;
  }
  return undefined;
}

/** A value read as one a clause can compare: rich text as its words; anything else of no comparable kind as nothing. */
function scalar(v: unknown): QueryScalar | undefined {
  if (Array.isArray(v)) return v.every(isRichBlock) ? richTextToPlain(v as RichText) : undefined;
  return isScalar(v) ? v : undefined;
}

/** The term ID a clause's value names in `taxonomy`: by ID or label. A value naming none names nothing. */
function termValue(collection: Collection, taxonomy: string, v: QueryScalar): string | undefined {
  return typeof v === 'string' ? termNamed(collection, taxonomy, v.trim()) : undefined;
}

/** How two comparable values order, or null when they cannot be compared (a number against a text, a yes/no). */
function order(a: QueryScalar, b: QueryScalar): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** Whether a value counts as there: anything but blank text, an empty list or none. */
function present(v: Read): boolean {
  if (v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return !Array.isArray(v) || v.length > 0;
}

/** Whether one value passes a clause whose values (term IDs, for a grouping) are `want`. */
function passes(read: Read, op: QueryOperator, want: QueryScalar[], exists: boolean): boolean {
  if (op === 'exists') return present(read) === exists;
  if (Array.isArray(read)) {
    const has = want.some((v) => read.includes(v as string));
    if (op === 'ne') return !has;
    return (op === 'eq' || op === 'in' || op === 'contains') && has;
  }
  if (read === undefined) return op === 'ne';
  switch (op) {
    case 'eq':
      return read === want[0];
    case 'ne':
      return read !== want[0];
    case 'in':
      return want.includes(read);
    case 'contains':
      return typeof read === 'string' && typeof want[0] === 'string' && read.toLowerCase().includes(want[0].toLowerCase());
  }
  // A value left blank (a date not set) is no value to compare.
  const o = present(read) ? order(read, want[0]) : null;
  if (o === null) return false;
  return op === 'gt' ? o > 0 : op === 'gte' ? o >= 0 : op === 'lt' ? o < 0 : o <= 0;
}

/**
 * A collection's entries in its own order, each once: the editorial order when one is chosen (anything it misses after
 * it), otherwise newest first by publication date, then by ID. As `orderedEntries` orders them, but an entry a hand
 * edit left without a date of text, or listed twice, still has one place, whatever order the files were read in.
 */
function editorialOrder(collection: Collection): EntryDoc[] {
  const all = Object.values(collection.entries).filter((e): e is EntryDoc => isObj(e) && typeof e.id === 'string');
  const date = (e: EntryDoc) => (typeof e.publishedAt === 'string' ? e.publishedAt : '');
  const byDate = all.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order: unknown = collection.settings.entryOrder;
  if (!Array.isArray(order)) return byDate;
  const listed: EntryDoc[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const e = own(collection.entries, id);
    if (!isObj(e) || e.id !== id) continue;
    seen.add(id);
    listed.push(e);
  }
  return [...listed, ...byDate.filter((e) => !seen.has(e.id))];
}

/** The entries of a collection a query may list: those with a page on the site, when its entries have pages; every one otherwise. */
function candidates(state: ProjectState, collection: Collection, ordered: EntryDoc[]): EntryDoc[] {
  if (!hasDetailPages(collection.settings)) return ordered;
  const id = collection.settings.id;
  return siteEntries(state)
    .filter((s) => s.collection.settings.id === id)
    .map((s) => s.entry);
}

/** How two sort values order: as `order` compares them, no before yes, and values of different kinds by kind. */
function rank(a: QueryScalar, b: QueryScalar): number {
  const o = order(a, b);
  if (o !== null) return o;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return typeof a < typeof b ? -1 : typeof a > typeof b ? 1 : 0;
}

/** Entries without a value go last, whichever way the key sorts; null when both have one. */
const ABSENT_LAST = (a: QueryScalar | undefined, b: QueryScalar | undefined): number | null => {
  const ma = !present(a);
  const mb = !present(b);
  return ma && mb ? 0 : ma ? 1 : mb ? -1 : null;
};

/**
 * The entries a query finds, in its order, after its offset and at most its limit. A malformed query, one naming a
 * collection the project lacks (or `$current` off an entry's page), a field the collection lacks or a term none of its
 * groupings has finds nothing.
 */
export function queryEntries(state: ProjectState, raw: unknown, rawPlace: QueryPlace = {}): EntryDoc[] {
  const query = normalizeCollectionQuery(raw);
  if (!query) return [];
  const place = normalizePlace(rawPlace);
  try {
    return evaluate(state, query, place);
  } catch {
    // Documents damaged past what the readers expect (rich text holding no words where words go) find nothing,
    // rather than stopping whatever asked.
    return [];
  }
}

function evaluate(state: ProjectState, query: CollectionQuery, place: QueryPlace): EntryDoc[] {
  const collection = queryCollection(state, query, place);
  if (!collection) return [];

  const filters: Array<(e: EntryDoc) => boolean> = [];
  for (const clause of query.where ?? []) {
    const read = fieldReader(state, collection, clause.field);
    if (!read) return [];
    const { op } = clause;
    let want = op === 'exists' ? [] : op === 'in' ? (clause.value as QueryScalar[]) : [clause.value as QueryScalar];
    const taxonomy = clause.field === 'categories' ? 'categories' : clause.field.startsWith('terms.') ? clause.field.slice(6) : undefined;
    if (taxonomy && op !== 'exists') {
      // A term the grouping does not have matches nothing, whatever the clause asks of it; `in` passes it over and
      // matches nothing only when it names no term the grouping has.
      const ids = want.map((v) => termValue(collection, taxonomy, v));
      const known = ids.filter((id): id is string => id !== undefined);
      if (op === 'in' ? !known.length : known.length !== ids.length) return [];
      want = known;
    }
    const exists = clause.value !== false;
    filters.push((e) => passes(read(e), op, want, exists));
  }

  // The collection's editorial order: each entry's place in it, those it leaves out after it in the fallback order.
  const ordered = editorialOrder(collection);
  const position = new Map(ordered.map((e, i) => [e.id, i]));
  const keys: Array<{
    read: (e: EntryDoc) => QueryScalar | undefined;
    desc: boolean;
  }> = [];
  for (const s of query.sort ?? []) {
    const desc = s.direction === 'desc';
    if (s.field === ENTRY_ORDER_FIELD) {
      keys.push({
        read: (e) => position.get(e.id) ?? Number.MAX_SAFE_INTEGER,
        desc
      });
      continue;
    }
    const read = fieldReader(state, collection, s.field);
    if (!read) return [];
    // A list sorts by its items in turn (U+0000 sorts before every character an ID has).
    keys.push({
      read: (e) => {
        const v = read(e);
        return Array.isArray(v) ? v.join('\u0000') : v;
      },
      desc
    });
  }

  const except = query.excludeCurrent ? place.entry?.entryId : undefined;
  let found = candidates(state, collection, ordered).filter((e) => !isDraftEntry(e) && e.id !== except && filters.every((f) => f(e)));
  if (keys.length) {
    const rows = found.map((e) => ({ e, k: keys.map((key) => key.read(e)) }));
    rows.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const x = a.k[i];
        const y = b.k[i];
        const missing = ABSENT_LAST(x, y);
        if (missing !== null) {
          if (missing) return missing;
          continue;
        }
        const o = rank(x!, y!);
        if (o) return keys[i].desc ? -o : o;
      }
      return a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0;
    });
    found = rows.map((r) => r.e);
  } else {
    found.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  }
  const start = query.offset ?? 0;
  return found.slice(start, query.limit === undefined ? undefined : start + query.limit);
}
