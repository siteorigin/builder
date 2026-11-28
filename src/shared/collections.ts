/**
 * Collections: groups of entries (blog posts, projects, case studies) kept apart from the site's pages, each entry a
 * file of its own under `siteorigin/collections/<collectionId>/entries/`. An entry's address is its collection's
 * route prefix plus its slug, and those addresses share one namespace with the pages and the old page addresses kept
 * working, so nothing here lets two of them claim the same address.
 */
import type { Collection, CollectionKind, EntryDoc, ProjectState } from './types';
import { numberedSlug, slugify, validateRoute, validateSegment } from './routes';
import { keptPublishedAddresses } from './published';

/** A collection's ID and folder name: a lowercase slug ("posts", "case-studies"). */
export const COLLECTION_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** An entry's ID: `en_` and a short random suffix, unique across the project. */
export const ENTRY_ID_RE = /^en_[a-z0-9]{4,32}$/;
/** A taxonomy's or term's ID, unique within its collection or taxonomy. */
export const TERM_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** The ID the ready-made blog collection takes. */
export const POSTS_COLLECTION_ID = 'posts';
/** How many entries a page of a collection's index or category archive lists, unless the collection says otherwise. */
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

/** How many entries each page of a collection's index and archives lists: its own page size, or the default for anything else a hand-edited document holds. */
export function archivePageSize(settings: { pageSize?: unknown } | undefined): number {
  const n = settings?.pageSize;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_SIZE ? n : DEFAULT_PAGE_SIZE;
}

/** Whether a collection's categories get archive pages of their own: yes unless it says no. */
export function hasCategoryArchives(settings: { categoryArchives?: unknown } | undefined): boolean {
  return settings?.categoryArchives !== false;
}

/** What a collection holds: structured records when it says so, otherwise dated articles, as every blog is. */
export function collectionKind(settings: { kind?: unknown } | undefined): CollectionKind {
  return settings?.kind === 'structured' ? 'structured' : 'editorial';
}

/** Whether a collection of this kind is in the site's RSS feed when it says nothing of its own: dated articles are, records are not. */
export const feedsByDefault = (kind: CollectionKind): boolean => kind === 'editorial';

/** Whether a collection's entries are listed in the site's RSS feed: as it says, otherwise as its kind does. */
export function inSiteFeed(settings: { kind?: unknown; rss?: unknown } | undefined): boolean {
  return typeof settings?.rss === 'boolean' ? settings.rss : feedsByDefault(collectionKind(settings));
}

const pagesOf = (settings: { pages?: unknown } | undefined) => (settings?.pages && typeof settings.pages === 'object' ? (settings.pages as { detail?: unknown; archive?: unknown }) : {});

/** Whether each of a collection's entries has a page of its own: yes unless it says no. */
export function hasDetailPages(settings: { pages?: unknown } | undefined): boolean {
  return pagesOf(settings).detail !== false;
}

/**
 * Whether a collection has an index (and category archives) at its own address: yes unless it says no, and never
 * without entry pages for it to link to (a hand edit that asks for one anyway is reported, and has none).
 */
export function hasArchivePages(settings: { pages?: unknown } | undefined): boolean {
  return hasDetailPages(settings) && pagesOf(settings).archive !== false;
}

/** Whether a collection is data only: records other pages show, with no page of its own anywhere. */
export function isDataOnly(settings: { pages?: unknown } | undefined): boolean {
  return !hasDetailPages(settings) && !hasArchivePages(settings);
}

/** Whether a collection's entries have text of their own: yes unless it says no. */
export function collectionHasBody(settings: { hasBody?: unknown } | undefined): boolean {
  return settings?.hasBody !== false;
}

/**
 * The address prefix a collection's pages use: its route, while it has pages and a route that is text. Undefined for
 * a data-only collection, whatever route it keeps.
 */
export function pagesPrefix(collection: Collection): string | undefined {
  const s = collection?.settings;
  return hasDetailPages(s) && typeof s?.route === 'string' ? s.route : undefined;
}

/** Whether a collection is synced from an external source, which makes its entries read-only to manual edits. */
export function isSyncedCollection(settings: { sourceId?: unknown } | undefined): boolean {
  return typeof settings?.sourceId === 'string';
}

/** Names a folder may not have on every system that may open the project. */
const DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** Object-prototype names, which no operation may name as an ID (see `validateOperation`). */
const PROTO_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export function isCollectionId(id: unknown): boolean {
  return typeof id === 'string' && id.length <= 60 && COLLECTION_ID_RE.test(id) && !DEVICE_NAMES.test(id) && !PROTO_NAMES.has(id) && !(id in Object.prototype);
}

export function isEntryId(id: unknown): boolean {
  return typeof id === 'string' && ENTRY_ID_RE.test(id);
}

export function isTermId(id: unknown): boolean {
  return typeof id === 'string' && TERM_ID_RE.test(id) && !PROTO_NAMES.has(id) && !(id in Object.prototype);
}

/**
 * The ID a term called `label` takes among `terms`: its name in plain letters ("Arts & Crafts" is "arts-and-crafts"),
 * or "term" for a name with none (a name in another script), numbered while another term has it. `except` is the
 * term being renamed, whose own ID stays free to it, and `taken` IDs posts are still filed under though no term has
 * them (written by hand), which a new term would gather up. The ID is the term's address in its archive (`category/<ID>/`).
 */
export function termIdFor(terms: Record<string, unknown>, label: string, except?: string, taken: ReadonlySet<string> = new Set()): string {
  const stem = slugify(label) || 'term';
  const free = (id: string) => isTermId(id) && (id === except || (!Object.hasOwn(terms, id) && !taken.has(id)));
  if (free(stem)) return stem;
  for (let n = 2; ; n++) {
    const id = numberedSlug(stem, n);
    if (free(id)) return id;
  }
}

/** Every ID the collection's entries are filed under in a grouping, whether or not a term still has it. */
export function assignedTermIds(collection: Collection, taxonomyId: string): Set<string> {
  const out = new Set<string>();
  for (const e of Object.values(collection.entries)) {
    const ids: unknown = e?.terms && typeof e.terms === 'object' && Object.hasOwn(e.terms, taxonomyId) ? e.terms[taxonomyId] : undefined;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') out.add(id);
  }
  return out;
}

/** The entries of a collection filed under a term, drafts included. */
export function entriesWithTerm(collection: Collection, taxonomyId: string, termId: string): EntryDoc[] {
  return Object.values(collection.entries).filter((e) => {
    const ids: unknown = e?.terms && typeof e.terms === 'object' && Object.hasOwn(e.terms, taxonomyId) ? e.terms[taxonomyId] : undefined;
    return Array.isArray(ids) && ids.includes(termId);
  });
}

/** An entry's address: its collection's prefix and its slug. Undefined for an entry with no page (see pagesPrefix). */
export function entryRoute(collection: Collection, entry: EntryDoc): string | undefined {
  const prefix = pagesPrefix(collection);
  return prefix === undefined ? undefined : `${prefix}${entry.slug}/`;
}

/** The entry with this ID, wherever it is, with the collection that holds it. */
export function findEntry(state: ProjectState, entryId: string): { collection: Collection; entry: EntryDoc } | undefined {
  for (const collection of Object.values(state.collections ?? {})) {
    if (Object.hasOwn(collection.entries, entryId)) return { collection, entry: collection.entries[entryId] };
  }
  return undefined;
}

/**
 * A collection's entries in order: the editorial order when one is chosen (anything it misses after it), otherwise
 * newest first by publication date, entries of the same day by ID so they never trade places on their own.
 */
export function orderedEntries(collection: Collection): EntryDoc[] {
  const all = Object.values(collection.entries);
  // Each entry's date and ID read once, and compared as they are: a sort compares each entry many times over. A
  // damaged entry (written by hand) is compared as it always was.
  const byDate = all.every((e) => e && typeof e === 'object')
    ? all
        .map((entry) => ({ entry, at: entry.publishedAt, id: entry.id }))
        .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((k) => k.entry)
    : all.sort((a, b) => (a.publishedAt !== b.publishedAt ? (a.publishedAt < b.publishedAt ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = collection.settings.entryOrder;
  if (!Array.isArray(order)) return byDate;
  // Each entry once, where the order first lists it (a hand-edited order may repeat one).
  const listed = [...new Set(order)].filter((id) => Object.hasOwn(collection.entries, id)).map((id) => collection.entries[id]);
  const seen = new Set(listed);
  return [...listed, ...byDate.filter((e) => !seen.has(e))];
}

/**
 * Told of each walk of every entry for the site's addresses (`siteEntries`), for the performance harness
 * (scripts/perf/README.md): set only while the editor's timing marks are on, so otherwise a walk costs one look at an
 * empty variable.
 */
let countWalk: (() => void) | null = null;
export function countSiteEntryWalks(count: typeof countWalk): void {
  countWalk = count;
}

/** A collection entry the site has a page for, and that page's address. */
export interface SiteEntry {
  collection: Collection;
  entry: EntryDoc;
  route: string;
}

/** Whether an entry's address is one the site can have: its collection's prefix and one valid segment. */
export function isEntryPath(collection: Collection, entry: EntryDoc): boolean {
  const prefix = pagesPrefix(collection);
  if (prefix === undefined || prefix === '/' || validateRoute(prefix)) return false;
  return typeof entry?.slug === 'string' && !validateSegment(entry.slug) && !validateRoute(`${prefix}${entry.slug}/`);
}

/**
 * The entries the site has a page for, drafts included (as draft pages are, until the website leaves them out): the
 * collections by ID, and each one's entries in its own order. An entry at an address the site cannot have (a slug or
 * prefix edited by hand), or at one a page or an earlier entry holds, has none, so no two files share a place.
 */
export function siteEntries(state: ProjectState): SiteEntry[] {
  countWalk?.();
  const used = new Set(Object.values(state.pages).map((p) => p.route.toLowerCase()));
  const out: SiteEntry[] = [];
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const collection = state.collections[id];
    if (!collection?.entries || typeof collection.entries !== 'object' || collection.settings?.id !== id) continue;
    for (const entry of orderedEntries(collection)) {
      if (!entry || typeof entry !== 'object' || !isEntryPath(collection, entry)) continue;
      const route = entryRoute(collection, entry)!;
      if (used.has(route.toLowerCase())) continue;
      used.add(route.toLowerCase());
      out.push({ collection, entry, route });
    }
  }
  return out;
}

/** Is the entry a draft, left out of the website? */
export function isDraftEntry(entry: EntryDoc): boolean {
  return entry.draft !== false;
}

/** Something that holds an address of the site. */
export type RouteOwner =
  | { kind: 'page'; route: string; pageId: string; label: string }
  | { kind: 'redirect'; route: string; pageId: string; entryId?: undefined; label: string }
  | { kind: 'redirect'; route: string; entryId: string; pageId?: undefined; label: string }
  | { kind: 'redirect'; route: string; to: string; pageId?: undefined; entryId?: undefined; label: string }
  | { kind: 'collection'; route: string; collectionId: string; label: string }
  | { kind: 'entry'; route: string; collectionId: string; entryId: string; label: string };

/**
 * The addresses the site's collections and their entries hold, drafts included: a draft keeps its address. A
 * collection holds its own address only with an archive there, and its entries theirs only with pages of their own.
 */
export function collectionRoutes(state: ProjectState): RouteOwner[] {
  const out: RouteOwner[] = [];
  for (const c of Object.values(state.collections ?? {})) {
    const route = pagesPrefix(c);
    if (route === undefined) continue;
    if (hasArchivePages(c.settings)) out.push({ kind: 'collection', route, collectionId: c.settings.id, label: `the ${c.settings.name} collection` });
    for (const e of Object.values(c.entries)) {
      if (typeof e?.slug !== 'string') continue;
      out.push({ kind: 'entry', route: `${route}${e.slug}/`, collectionId: c.settings.id, entryId: e.id, label: `the entry “${e.title}”` });
    }
  }
  return out;
}

/** Every address of the site: pages, old addresses kept working (of pages and of entries), collections and entries. */
export function routeOwners(state: ProjectState): RouteOwner[] {
  const out: RouteOwner[] = Object.values(state.pages).map((p) => ({ kind: 'page' as const, route: p.route, pageId: p.id, label: `the page “${p.title}”` }));
  const kept: unknown = state.site.redirects;
  // With the addresses exports delivered for pages that have left them, which the site keeps working too (#1382).
  for (const r of [...(Array.isArray(kept) ? (kept as Array<{ from?: unknown; pageId?: unknown; entryId?: unknown; to?: unknown }>) : []), ...keptPublishedAddresses(state)]) {
    if (typeof r?.from !== 'string') continue;
    if (typeof r.pageId === 'string') out.push({ kind: 'redirect', route: r.from, pageId: r.pageId, label: `the old address of “${state.pages[r.pageId]?.title ?? r.pageId}”` });
    else if (typeof r.entryId === 'string') out.push({ kind: 'redirect', route: r.from, entryId: r.entryId, label: `the old address of “${findEntry(state, r.entryId)?.entry.title ?? r.entryId}”` });
    else if (typeof r.to === 'string') out.push({ kind: 'redirect', route: r.from, to: r.to, label: `a redirect to ${r.to}` });
  }
  return [...out, ...collectionRoutes(state)];
}

/**
 * The folders under a collection's address that its archive pages live in: `page/` for the later pages of its index
 * (`/blog/page/2/`) and `category/` for each category's archive (`/blog/category/news/`, `/blog/category/news/page/2/`).
 * Everything under them belongs to the collection, so no page, old address or other collection can sit there; the
 * folder's own address stays free (an entry may be called "page").
 */
export const ARCHIVE_FOLDERS = ['page', 'category'] as const;

/** Whether `route` is under one of the archive folders of a collection at `prefix` (both compared in lowercase). */
export function underArchiveFolder(prefix: string, route: string): boolean {
  const p = prefix.toLowerCase();
  const r = route.toLowerCase();
  return ARCHIVE_FOLDERS.some((f) => r.startsWith(`${p}${f}/`) && r.length > p.length + f.length + 1);
}

/** The collection whose archive pages may use `route`, if any (see ARCHIVE_FOLDERS). */
export function archiveRouteOwner(state: ProjectState, route: string, exceptCollectionId?: string): RouteOwner | undefined {
  for (const c of Object.values(state.collections ?? {})) {
    const prefix: unknown = c?.settings?.route;
    if (typeof prefix !== 'string' || c.settings.id === exceptCollectionId || !hasArchivePages(c.settings)) continue;
    if (underArchiveFolder(prefix, route)) return { kind: 'collection', route, collectionId: c.settings.id, label: `the ${c.settings.name} collection's archive pages` };
  }
  return undefined;
}

/** The collection or entry holding `route`, or the collection whose archive pages may use it (compared as case-insensitive file systems do), if any. */
export function collectionRouteOwner(state: ProjectState, route: string): RouteOwner | undefined {
  const key = route.toLowerCase();
  return collectionRoutes(state).find((o) => o.route.toLowerCase() === key) ?? archiveRouteOwner(state, route);
}
