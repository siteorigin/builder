/**
 * Entry feeds: computed lists that show a collection's published entries (blog posts, case studies), newest first by
 * publication date, worked out each time the site is generated. A placement chooses what it shows through its own
 * properties, read by name: `collection` (a collection's ID; empty for the one whose entry's page it is on, else the
 * blog, else the first), `category` and `tag` (a term of the collection's `categories` or `tags`, by ID or label;
 * empty for every entry) and `count` (how many at most). On an entry's page it leaves that entry out, so a "Related
 * posts" strip never lists the post it is under. Drafts are never listed. Nothing here runs in the exported site.
 */
import type { Collection, EntryDoc, ImageValue, LinkValue, ListProp, PropSchema, ProjectState } from './types';
import { POSTS_COLLECTION_ID, isDraftEntry, siteEntries } from './collections';
import { entryFieldValue, type EntryReadContext } from './entry-fields';
import { ARTICLE_ROW_FIELDS, articleRows, feedLimit } from './articles';

/** The properties a placement of an entry feed chooses its entries with. */
export const ENTRY_QUERY_PROPS = ['collection', 'category', 'tag', 'count'] as const;

/** What an entry feed shows: one collection's entries, optionally of one category and one tag, and at most `count`. */
export interface EntryQuery {
  /** A collection's ID, or empty for the one whose entry's page the list is on (else the blog, else the first by ID). */
  collection: string;
  /** A term of the collection's `categories`, by ID or label (or several, separated by commas), or empty for every entry. */
  category: string;
  /** A term of the collection's `tags`, by ID or label (or several, separated by commas), or empty for every entry. */
  tag: string;
  /** How many entries at most; undefined for no limit of the placement's own. */
  count?: number;
}

/** Where a computed list renders. */
export interface FeedPlace {
  /** The page whose own content it is (news lists, an article's header); absent in the shared header and footer and on an entry's page. */
  pageId?: string;
  /** The entry whose page it is on (a collection's layout): an entry feed defaults to its collection and leaves it out. */
  entry?: { collectionId: string; entryId: string };
  /** For an entry feed: what the placement chose. */
  query?: EntryQuery;
}

/** One row of an entry feed: an entry as list item fields. */
export interface EntryRow {
  /** The entry's ID, so a row keeps its identity (and the editor's selection) when the order changes. */
  id: string;
  /** The entry's page, by ID, so the link follows a new slug or collection address. */
  pageLink: LinkValue;
  title: string;
  /** YYYY-MM-DD, for the `datetime` of a time element. */
  date: string;
  /** The date as readers of the site's language write it. */
  dateLabel: string;
  /** Who wrote it. */
  byline: string;
  excerpt: string;
  /** Its featured picture, described as the library describes it. */
  image: ImageValue;
  /** Its categories' labels, in the order they were assigned. */
  category: string;
}

/** The field names an entry feed's rows fill, and the property type each needs. */
export const ENTRY_ROW_FIELDS = { pageLink: 'link', title: 'string', date: 'string', dateLabel: 'string', byline: 'string', excerpt: 'string', image: 'image', category: 'string' } as const;

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * What a placement of an entry feed shows: each query property's own value where it holds one of the right kind (a
 * value bound from further out counts as unset), else the property's default.
 */
export function entryQuery(properties: Record<string, PropSchema>, props: Record<string, unknown>): EntryQuery {
  const pick = (name: string): unknown => {
    const v = own(props, name);
    const fallback = (own(properties, name) as { default?: unknown } | undefined)?.default;
    return typeof v === 'string' || typeof v === 'number' ? v : fallback;
  };
  const text = (name: string) => {
    const v = pick(name);
    return typeof v === 'string' ? v.trim() : '';
  };
  const n = pick('count');
  const count = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  return { collection: text('collection'), category: text('category'), tag: text('tag'), ...(count !== undefined ? { count } : {}) };
}

/** A stable key for a query and a limit, for handing rows to a design and for caching them. */
export function entryQueryKey(query: EntryQuery, max?: number): string {
  return JSON.stringify([query.collection, query.category, query.tag, query.count ?? null, max ?? null]);
}

/** The collection an entry feed reads: the one it names (none when it names one the project lacks), else the one whose entry's page it is on, else the blog, else the first by ID. */
export function feedCollection(state: ProjectState, query: Pick<EntryQuery, 'collection'>, place: Pick<FeedPlace, 'entry'> = {}): Collection | undefined {
  const collections = state.collections ?? {};
  if (query.collection) return own(collections, query.collection);
  const here = place.entry ? own(collections, place.entry.collectionId) : undefined;
  if (here) return here;
  return own(collections, POSTS_COLLECTION_ID) ?? own(collections, Object.keys(collections).sort()[0] ?? '');
}

/** The ID of the term of `taxonomy` that `wanted` names, by ID or (ignoring case) by label; undefined when none does. */
export function termNamed(collection: Collection, taxonomy: string, wanted: string): string | undefined {
  const terms = own(collection.settings?.taxonomies, taxonomy)?.terms;
  if (!terms || typeof terms !== 'object') return undefined;
  if (own(terms, wanted)) return wanted;
  const key = wanted.toLowerCase();
  return Object.keys(terms).find((id) => id.toLowerCase() === key || (typeof terms[id]?.label === 'string' && terms[id].label.trim().toLowerCase() === key));
}

/**
 * The terms of `taxonomy` that `wanted` names: one term by ID or label, or several separated by commas (an entry's
 * categories as a layout reads them, "News, Craft"), any of which an entry may have. Those the collection lacks are
 * left out.
 */
export function termsNamed(collection: Collection, taxonomy: string, wanted: string): string[] {
  const whole = termNamed(collection, taxonomy, wanted.trim());
  if (whole) return [whole];
  // A label may hold a comma itself ("Arts, Culture"): the longest run of pieces that names a term is taken first.
  const pieces = wanted.split(',').map((w) => w.trim());
  const found = new Set<string>();
  for (let i = 0; i < pieces.length; ) {
    let j = pieces.length;
    let term: string | undefined;
    for (; j > i; j--) if ((term = termNamed(collection, taxonomy, pieces.slice(i, j).join(', ')))) break;
    if (term) found.add(term);
    i = term ? j : i + 1;
  }
  return [...found];
}

/** Whether an entry has the term `termId` of `taxonomy`. */
export function hasTerm(entry: EntryDoc, taxonomy: string, termId: string): boolean {
  const ids = own(entry.terms, taxonomy);
  return Array.isArray(ids) && ids.includes(termId);
}

/** Newest first by publication date; entries of the same day by ID, which nothing about them changes, so they never trade places on their own. */
export function byPublication(a: EntryDoc, b: EntryDoc): number {
  const da = typeof a.publishedAt === 'string' ? a.publishedAt : '';
  const db = typeof b.publishedAt === 'string' ? b.publishedAt : '';
  if (da !== db) return da < db ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The published entries of `collection` the website has a page for, newest first: drafts, and entries at an address
 * the site cannot have, are left out.
 */
export function publishedEntries(state: ProjectState, collection: Collection): EntryDoc[] {
  return siteEntries(state)
    .filter((e) => e.collection.settings.id === collection.settings?.id && !isDraftEntry(e.entry))
    .map((e) => e.entry)
    .sort(byPublication);
}

/** The entries an entry feed lists, newest first, at most `max` (the list's own limit) and the query's `count`. */
export function listedEntries(state: ProjectState, query: EntryQuery, place: Pick<FeedPlace, 'entry'> = {}, max?: number): { collection?: Collection; entries: EntryDoc[] } {
  const limit = Math.min(max ?? Infinity, query.count ?? Infinity);
  const collection = feedCollection(state, query, place);
  if (!collection || limit <= 0) return { collection, entries: [] };
  const categories = query.category ? termsNamed(collection, 'categories', query.category) : [];
  const tags = query.tag ? termsNamed(collection, 'tags', query.tag) : [];
  // A term the collection does not have matches nothing, rather than every entry.
  if ((query.category && !categories.length) || (query.tag && !tags.length)) return { collection, entries: [] };
  const except = place.entry?.entryId;
  const entries = publishedEntries(state, collection).filter(
    (e) => e.id !== except && (!categories.length || categories.some((t) => hasTerm(e, 'categories', t))) && (!tags.length || tags.some((t) => hasTerm(e, 'tags', t)))
  );
  return { collection, entries: Number.isFinite(limit) ? entries.slice(0, limit) : entries };
}

/** One entry as a feed's row. */
export function entryRow(state: ProjectState, collection: Collection, entry: EntryDoc): EntryRow {
  const ctx: EntryReadContext = { state, collection, entry, neighbours: {} };
  const text = (field: string) => {
    const v = entryFieldValue(ctx, field);
    return typeof v === 'string' ? v : '';
  };
  const date = entryFieldValue(ctx, 'publishedAt', 'raw');
  return {
    id: entry.id,
    pageLink: { type: 'entry', target: entry.id },
    title: text('title'),
    date: typeof date === 'string' ? date : '',
    dateLabel: text('publishedAt'),
    byline: text('author'),
    excerpt: text('excerpt'),
    image: entryFieldValue(ctx, 'featuredImage') as ImageValue,
    category: text('categories')
  };
}

/** The rows an entry feed holds where it is placed. */
export function entryRows(state: ProjectState, query: EntryQuery, place: Pick<FeedPlace, 'entry'> = {}, max?: number): EntryRow[] {
  const { collection, entries } = listedEntries(state, query, place, max);
  return collection ? entries.map((e) => entryRow(state, collection, e)) : [];
}

/** Whether a definition lists a collection's entries (a list of posts). */
export function listsEntries(def: { properties: Record<string, PropSchema> }): boolean {
  return Object.values(def.properties ?? {}).some((p) => p?.type === 'list' && p.feed === 'entries');
}

/** Whether a project has a collection, so a section that lists posts has something to show. */
export function hasCollections(state: Pick<ProjectState, 'collections'>): boolean {
  return Object.keys(state.collections ?? {}).length > 0;
}

/** The query an entry feed uses without a placement of its own: every entry of the default collection. */
export const NO_QUERY: EntryQuery = { collection: '', category: '', tag: '' };

/**
 * The rows any computed list holds where it is placed, at most its own limit: the site's articles or the page itself
 * (see shared/articles.ts), or a collection's entries as the placement chose them. A feed this version does not know
 * holds nothing.
 */
export function feedRows(state: ProjectState, schema: Pick<ListProp, 'feed' | 'max'>, place: FeedPlace): Array<Record<string, unknown>> {
  const limit = feedLimit(schema);
  const max = Number.isFinite(limit) ? limit : undefined;
  if (schema.feed === 'entries') return entryRows(state, place.query ?? NO_QUERY, place, max) as unknown as Array<Record<string, unknown>>;
  if (schema.feed === 'articles' || schema.feed === 'currentPage') return articleRows(state, schema.feed, place.pageId, max) as unknown as Array<Record<string, unknown>>;
  return [];
}

/** The field names a computed list's rows fill, with the property type each needs, by feed. */
export function feedRowFields(feed: unknown): Readonly<Record<string, string>> {
  return feed === 'entries' ? ENTRY_ROW_FIELDS : feed === 'articles' || feed === 'currentPage' ? ARTICLE_ROW_FIELDS : {};
}
