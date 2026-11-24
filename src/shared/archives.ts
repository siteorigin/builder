/**
 * Collection archives: the pages that list a collection's published entries, newest first, a page size at a time.
 * Each collection has an index at its own address (`/blog/`, then `/blog/page/2/`, `/blog/page/3/`...) and, unless it
 * says otherwise, each of its categories with a published entry has an archive (`/blog/category/news/`, then
 * `/blog/category/news/page/2/`...). They are static pages the generator writes from these lists: nothing is looked up
 * in the visitor's browser. Which pages exist is decided here, once, so every file, Previous/Next link and sitemap
 * line agrees about it.
 */
import type { Collection, EntryDoc, ProjectState } from './types';
import { archivePageSize, findEntry, hasCategoryArchives, isDraftEntry, isTermId, siteEntries } from './collections';
import { hasTerm, publishedEntries } from './entry-feed';
import { validateRoute } from './routes';

/** One page of a collection's index or of one of its category archives. */
export interface ArchivePage {
  collectionId: string;
  /** The category the page lists, by term ID; absent on the collection's index. */
  category?: string;
  /** Its number in its series, from 1. */
  page: number;
  /** How many pages its series has. */
  pages: number;
  route: string;
  /** The addresses of the pages before and after it in its series. */
  prev?: string;
  next?: string;
  /** The entries it lists, newest first, by ID. */
  entryIds: string[];
}

/** The address of page `n` of a collection's index (no `category`) or of one category's archive. */
export function archiveRoute(prefix: string, category: string | undefined, n: number): string {
  const first = category ? `${prefix}category/${category}/` : prefix;
  return n <= 1 ? first : `${first}page/${n}/`;
}

/** The terms of a collection's `categories`, by ID, in the order they are offered: only those a valid address can name. */
export function categoryTerms(collection: Collection): Array<{ id: string; label: string }> {
  const terms = collection.settings?.taxonomies?.categories?.terms;
  if (!terms || typeof terms !== 'object') return [];
  return Object.keys(terms)
    .filter((id) => isTermId(id))
    .map((id) => ({ id, label: typeof terms[id]?.label === 'string' && terms[id].label.trim() ? terms[id].label.trim() : id }));
}

/**
 * Every archive page of the site, collections by ID, each one's index first and then its categories in the order they
 * are offered. A collection's index always has its first page, even with nothing to list yet; a category archive
 * exists only while the category has a published entry. An archive page never takes an address something the website
 * has holds (a page, an entry, an old address kept working, another collection's own address, another archive page,
 * as a project made before archives or edited by hand may have): its series stops before it, so no Previous or Next
 * link leads somewhere else. A draft holds nothing here: the website leaves it out, and its archive page shows there.
 */
export function archivePages(state: ProjectState): ArchivePage[] {
  // Only what the website has holds an address: a draft (or an old address leading to one) is left out of it, so the
  // series is the same whether drafts are in the state or not, and an archive page shows where a draft is kept back.
  const homeId = state.site?.homePageId;
  const draftPage = (id: unknown) => typeof id === 'string' && Object.hasOwn(state.pages ?? {}, id) && state.pages[id].draft === true && id !== homeId;
  const held = new Set<string>();
  for (const p of Object.values(state.pages ?? {})) if (typeof p?.route === 'string' && !draftPage(p.id)) held.add(p.route.toLowerCase());
  for (const e of siteEntries(state)) if (!isDraftEntry(e.entry)) held.add(e.route.toLowerCase());
  const kept: unknown = state.site?.redirects;
  for (const r of Array.isArray(kept) ? (kept as Array<{ from?: unknown; pageId?: unknown; entryId?: unknown }>) : []) {
    if (typeof r?.from !== 'string') continue;
    // Only an old address the website keeps: one leading to a published page or entry (not a draft, nor one that is gone).
    const page = typeof r.pageId === 'string' && Object.hasOwn(state.pages ?? {}, r.pageId) && !draftPage(r.pageId);
    const entry = typeof r.entryId === 'string' ? findEntry(state, r.entryId) : undefined;
    if (page || (entry && !isDraftEntry(entry.entry))) held.add(r.from.toLowerCase());
  }
  // Each collection's own address is its index's, whichever collection's series comes first.
  const indexes = new Set(
    Object.values(state.collections ?? {})
      .map((c) => c?.settings?.route)
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.toLowerCase())
  );
  const out: ArchivePage[] = [];
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const collection = state.collections[id];
    const prefix: unknown = collection?.settings?.route;
    if (!collection?.entries || collection.settings?.id !== id || typeof prefix !== 'string' || prefix === '/' || validateRoute(prefix)) continue;
    const size = archivePageSize(collection.settings);
    const all = publishedEntries(state, collection);
    const series = (category: string | undefined, entries: EntryDoc[]) => {
      const wanted = Math.max(1, Math.ceil(entries.length / size));
      // The series ends before the first address something else holds.
      let pages = 0;
      const free = (route: string) => !held.has(route.toLowerCase()) && (!indexes.has(route.toLowerCase()) || route.toLowerCase() === prefix.toLowerCase());
      while (pages < wanted && free(archiveRoute(prefix, category, pages + 1))) pages++;
      for (let n = 1; n <= pages; n++) {
        const route = archiveRoute(prefix, category, n);
        held.add(route.toLowerCase());
        out.push({
          collectionId: id,
          ...(category ? { category } : {}),
          page: n,
          pages,
          route,
          ...(n > 1 ? { prev: archiveRoute(prefix, category, n - 1) } : {}),
          ...(n < pages ? { next: archiveRoute(prefix, category, n + 1) } : {}),
          entryIds: entries.slice((n - 1) * size, n * size).map((e) => e.id)
        });
      }
    };
    series(undefined, all);
    if (!hasCategoryArchives(collection.settings)) continue;
    for (const { id: term } of categoryTerms(collection)) {
      const listed = all.filter((e) => hasTerm(e, 'categories', term));
      if (listed.length) series(term, listed);
    }
  }
  return out;
}

/** The address of a category's archive, while it has one. */
export function categoryArchiveRoute(state: ProjectState, collectionId: string, term: string): string | undefined {
  return archivePages(state).find((p) => p.collectionId === collectionId && p.category === term && p.page === 1)?.route;
}
