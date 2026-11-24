/**
 * Collections: groups of entries (blog posts, projects, case studies) kept apart from the site's pages, each entry a
 * file of its own under `siteorigin/collections/<collectionId>/entries/`. An entry's address is its collection's
 * route prefix plus its slug, and those addresses share one namespace with the pages and the old page addresses kept
 * working, so nothing here lets two of them claim the same address.
 */
import type { Collection, EntryDoc, ProjectState } from './types';

/** A collection's ID and folder name: a lowercase slug ("posts", "case-studies"). */
export const COLLECTION_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** An entry's ID: `en_` and a short random suffix, unique across the project. */
export const ENTRY_ID_RE = /^en_[a-z0-9]{4,32}$/;
/** A taxonomy's or term's ID, unique within its collection or taxonomy. */
export const TERM_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** The ID the ready-made blog collection takes. */
export const POSTS_COLLECTION_ID = 'posts';

/** Names a folder may not have on every system that may open the project. */
const DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/;

export function isCollectionId(id: unknown): boolean {
  return typeof id === 'string' && id.length <= 60 && COLLECTION_ID_RE.test(id) && !DEVICE_NAMES.test(id) && !(id in Object.prototype);
}

export function isEntryId(id: unknown): boolean {
  return typeof id === 'string' && ENTRY_ID_RE.test(id);
}

export function isTermId(id: unknown): boolean {
  return typeof id === 'string' && TERM_ID_RE.test(id) && !(id in Object.prototype);
}

/** An entry's address: its collection's prefix and its slug. */
export function entryRoute(collection: Collection, entry: EntryDoc): string {
  return `${collection.settings.route}${entry.slug}/`;
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
  const byDate = all.sort((a, b) => (a.publishedAt !== b.publishedAt ? (a.publishedAt < b.publishedAt ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = collection.settings.entryOrder;
  if (!Array.isArray(order)) return byDate;
  const listed = order.filter((id) => Object.hasOwn(collection.entries, id)).map((id) => collection.entries[id]);
  const seen = new Set(listed);
  return [...listed, ...byDate.filter((e) => !seen.has(e))];
}

/** Something that holds an address of the site. */
export type RouteOwner =
  | { kind: 'page'; route: string; pageId: string; label: string }
  | { kind: 'redirect'; route: string; pageId: string; label: string }
  | { kind: 'collection'; route: string; collectionId: string; label: string }
  | { kind: 'entry'; route: string; collectionId: string; entryId: string; label: string };

/** The addresses the site's collections and their entries hold, drafts included: a draft keeps its address. */
export function collectionRoutes(state: ProjectState): RouteOwner[] {
  const out: RouteOwner[] = [];
  for (const c of Object.values(state.collections ?? {})) {
    const route = c.settings?.route;
    if (typeof route !== 'string') continue;
    out.push({ kind: 'collection', route, collectionId: c.settings.id, label: `the ${c.settings.name} collection` });
    for (const e of Object.values(c.entries)) {
      if (typeof e?.slug !== 'string') continue;
      out.push({ kind: 'entry', route: entryRoute(c, e), collectionId: c.settings.id, entryId: e.id, label: `the entry “${e.title}”` });
    }
  }
  return out;
}

/** Every address of the site: pages, old page addresses kept working, collections and entries. */
export function routeOwners(state: ProjectState): RouteOwner[] {
  const out: RouteOwner[] = Object.values(state.pages).map((p) => ({ kind: 'page' as const, route: p.route, pageId: p.id, label: `the page “${p.title}”` }));
  const kept: unknown = state.site.redirects;
  for (const r of Array.isArray(kept) ? (kept as Array<{ from?: unknown; pageId?: unknown }>) : [])
    if (typeof r?.from === 'string' && typeof r.pageId === 'string') out.push({ kind: 'redirect', route: r.from, pageId: r.pageId, label: `the old address of “${state.pages[r.pageId]?.title ?? r.pageId}”` });
  return [...out, ...collectionRoutes(state)];
}

/** The collection or entry holding `route` (compared as case-insensitive file systems do), if any. */
export function collectionRouteOwner(state: ProjectState, route: string): RouteOwner | undefined {
  const key = route.toLowerCase();
  return collectionRoutes(state).find((o) => o.route.toLowerCase() === key);
}
