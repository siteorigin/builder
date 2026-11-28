/**
 * Collection archives: the pages that list a collection's published entries, newest first, a page size at a time.
 * Each collection has an index at its own address (`/blog/`, then `/blog/page/2/`, `/blog/page/3/`...) and, unless it
 * says otherwise, each of its categories and tags with a published entry has an archive (`/blog/category/news/`, then
 * `/blog/category/news/page/2/`...; `/blog/tag/nitrogen/`...). They are static pages the generator writes from these lists: nothing is looked up
 * in the visitor's browser. Which pages exist is decided here, once, so every file, Previous/Next link and sitemap
 * line agrees about it.
 */
import type { Collection, EntryDoc, ProjectState } from './types';
import { archivePageSize, findEntry, hasArchivePages, hasTermArchives, isDraftEntry, isTermId, siteEntries } from './collections';
import { hasTerm, publishedEntries } from './entry-feed';
import { validateRoute } from './routes';
import { siteLanguage } from './languages';
import { visitorTextFor } from './visitor-text';

/** The groupings whose terms have archives of their own, each with the folder under the collection's address they are in. */
export const ARCHIVE_TAXONOMIES = { categories: 'category', tags: 'tag' } as const;
export type ArchiveTaxonomy = keyof typeof ARCHIVE_TAXONOMIES;

/** Whether a grouping's terms have archives of their own. */
export const isArchiveTaxonomy = (id: unknown): id is ArchiveTaxonomy => id === 'categories' || id === 'tags';

/** A term whose archive a page is of: its grouping and its ID there. */
export interface ArchiveTerm {
  taxonomy: ArchiveTaxonomy;
  id: string;
}

/** Whether two archive pages are of the same series: both the index (no term), or both of one term of one grouping. */
export const sameTerm = (a: ArchiveTerm | undefined, b: ArchiveTerm | undefined): boolean => (a && b ? a.taxonomy === b.taxonomy && a.id === b.id : !a && !b);

/** One page of a collection's index or of one of its category or tag archives. */
export interface ArchivePage {
  collectionId: string;
  /** The category or tag the page lists; absent on the collection's index. */
  term?: ArchiveTerm;
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

/** The address of page `n` of a collection's index (no `term`) or of one category's or tag's archive. */
export function archiveRoute(prefix: string, term: ArchiveTerm | undefined, n: number): string {
  const first = term ? `${prefix}${ARCHIVE_TAXONOMIES[term.taxonomy]}/${term.id}/` : prefix;
  return n <= 1 ? first : `${first}page/${n}/`;
}

/** The terms of one of a collection's groupings, by ID, in the order they are offered: only those a valid address can name. */
export function archiveTerms(collection: Collection, taxonomy: ArchiveTaxonomy): Array<{ id: string; label: string }> {
  const terms = collection.settings?.taxonomies?.[taxonomy]?.terms;
  if (!terms || typeof terms !== 'object') return [];
  return Object.keys(terms)
    .filter((id) => isTermId(id))
    .map((id) => ({ id, label: typeof terms[id]?.label === 'string' && terms[id].label.trim() ? terms[id].label.trim() : id }));
}

/**
 * Every archive page of the site, collections by ID, each one's index first, then its categories and then its tags,
 * each in the order they are offered. A collection's index always has its first page, even with nothing to list yet;
 * a category's or tag's archive exists only while it has a published entry. An archive page never takes an address something the website
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
    // One leading to another address holds nothing here: where it ends can be an archive page, and an archive page
    // takes its address instead (see shared/redirects.ts), so the series is the same with drafts or without.
    if (page || (entry && !isDraftEntry(entry.entry))) held.add(r.from.toLowerCase());
  }
  // Each collection's own address is its index's, whichever collection's series comes first.
  const indexes = new Set(
    Object.values(state.collections ?? {})
      .filter((c) => hasArchivePages(c?.settings))
      .map((c) => c?.settings?.route)
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.toLowerCase())
  );
  const out: ArchivePage[] = [];
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const collection = state.collections[id];
    const prefix: unknown = collection?.settings?.route;
    if (!collection?.entries || collection.settings?.id !== id || !hasArchivePages(collection.settings) || typeof prefix !== 'string' || prefix === '/' || validateRoute(prefix)) continue;
    const size = archivePageSize(collection.settings);
    const all = publishedEntries(state, collection);
    const series = (term: ArchiveTerm | undefined, entries: EntryDoc[]) => {
      const wanted = Math.max(1, Math.ceil(entries.length / size));
      // The series ends before the first address something else holds.
      let pages = 0;
      const free = (route: string) => !held.has(route.toLowerCase()) && (!indexes.has(route.toLowerCase()) || route.toLowerCase() === prefix.toLowerCase());
      while (pages < wanted && free(archiveRoute(prefix, term, pages + 1))) pages++;
      for (let n = 1; n <= pages; n++) {
        const route = archiveRoute(prefix, term, n);
        held.add(route.toLowerCase());
        out.push({
          collectionId: id,
          ...(term ? { term } : {}),
          page: n,
          pages,
          route,
          ...(n > 1 ? { prev: archiveRoute(prefix, term, n - 1) } : {}),
          ...(n < pages ? { next: archiveRoute(prefix, term, n + 1) } : {}),
          entryIds: entries.slice((n - 1) * size, n * size).map((e) => e.id)
        });
      }
    };
    series(undefined, all);
    if (!hasTermArchives(collection.settings)) continue;
    for (const taxonomy of Object.keys(ARCHIVE_TAXONOMIES) as ArchiveTaxonomy[]) {
      for (const { id: term } of archiveTerms(collection, taxonomy)) {
        const listed = all.filter((e) => hasTerm(e, taxonomy, term));
        if (listed.length) series({ taxonomy, id: term }, listed);
      }
    }
  }
  return out;
}

/** The key a term's archive is known by in termArchiveRoutes: its collection, grouping and ID. */
export const termArchiveKey = (collectionId: string, term: ArchiveTerm): string => `${collectionId}\n${term.taxonomy}\n${term.id}`;

/**
 * The address of the first page of every category's and tag's archive the website has, by termArchiveKey: a plain
 * record, so a cached run sees the same addresses as the same value.
 */
export function termArchiveRoutes(pages: readonly ArchivePage[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pages) if (p.term && p.page === 1) out[termArchiveKey(p.collectionId, p.term)] = p.route;
  return out;
}

/** Wording with each `{name}` it has a value for filled in, in one pass, so a value is written as it is ("{site}", "$&"). */
export const fillWords = (text: string, values: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? String(values[k]) : m));

/** Text the author set, when there is any beyond spaces. */
const ownText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * What an index (no `term`) or a category's or tag's archive says of itself when the author has not said: an index the
 * site's description, else a sentence naming the collection and the site; a category or tag a sentence naming it, the
 * collection and the site, in the site's language.
 */
export function defaultArchiveDescription(state: Pick<ProjectState, 'site' | 'collections'>, collectionId: string, term?: ArchiveTerm): string {
  const site = state.site;
  const words = visitorTextFor(site, siteLanguage(site));
  const collection = Object.hasOwn(state.collections ?? {}, collectionId) ? state.collections[collectionId] : undefined;
  const fills = { collection: ownText(collection?.settings?.name) || collectionId, site: typeof site.name === 'string' ? site.name : '' };
  if (!term) return ownText(site.description) || fillWords(words.archiveDescription, fills);
  const found = collection ? archiveTerms(collection, term.taxonomy).find((t) => t.id === term.id) : undefined;
  const label = found?.label ?? term.id;
  return term.taxonomy === 'tags' ? fillWords(words.archiveTagDescription, { ...fills, tag: label }) : fillWords(words.archiveCategoryDescription, { ...fills, category: label });
}

/**
 * What one archive page is called and says of itself, in the site's language: its heading (the collection's name, or
 * the category's or tag's), its name in a trail (the heading, then its page number after the first), its browser
 * title (that name and the site's), and its description for search engines and link previews: the collection's, the
 * category's or the tag's own, else the default (defaultArchiveDescription). Every page of a series says the same.
 */
export function archiveWords(state: Pick<ProjectState, 'site' | 'collections'>, archive: Pick<ArchivePage, 'collectionId' | 'term' | 'page' | 'pages'>): { heading: string; name: string; title: string; description: string } {
  const site = state.site;
  const words = visitorTextFor(site, siteLanguage(site));
  const collection = Object.hasOwn(state.collections ?? {}, archive.collectionId) ? state.collections[archive.collectionId] : undefined;
  const settings = collection?.settings;
  const term = archive.term;
  const found = term && collection ? archiveTerms(collection, term.taxonomy).find((t) => t.id === term.id) : undefined;
  const heading = term ? (found?.label ?? term.id) : ownText(settings?.name) || archive.collectionId;
  const name = `${heading}${archive.page > 1 ? ` – ${fillWords(words.archivePageOf, { page: archive.page, count: archive.pages })}` : ''}`;
  const own = term ? (found ? ownText(settings!.taxonomies[term.taxonomy].terms[found.id]?.description) : '') : ownText(settings?.description);
  return { heading, name, title: `${name} · ${typeof site.name === 'string' ? site.name : ''}`, description: own || defaultArchiveDescription(state, archive.collectionId, term) };
}

/**
 * The address of each collection's index (the first page of its list of entries), by collection ID, for the
 * collections whose index the website has: a link to a collection (`{ type: 'collection' }`) goes there, and a link
 * to one without an index (data only, entry pages alone, or its address held by something else) shows its words alone.
 */
export function collectionIndexRoutes(state: ProjectState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of archivePages(state)) if (p.term === undefined && p.page === 1) out[p.collectionId] = p.route;
  return out;
}

/** The collections a link can go to the index of, by ID, each with its name and its index's address. */
export function linkableIndexes(state: ProjectState): Array<{ id: string; name: string; route: string }> {
  const routes = collectionIndexRoutes(state);
  return Object.keys(routes)
    .sort()
    .map((id) => ({ id, name: typeof state.collections[id]?.settings?.name === 'string' && state.collections[id].settings.name.trim() ? state.collections[id].settings.name.trim() : id, route: routes[id] }));
}
