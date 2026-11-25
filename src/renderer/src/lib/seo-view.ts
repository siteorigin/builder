/**
 * The SEO view (#700): a workspace opened from the rail that takes the canvas's place, as the post writer does, where
 * the author chooses one of the site's documents (a page or a collection entry) to work on how it reads in search
 * results and link previews. Plain functions over the project, tested without a renderer; the view and its list call
 * them.
 */
import type { SeoSubject } from '@shared/seo';
import type { Collection, EntryDoc, ProjectState } from '@shared/types';
import { entryRoute, orderedEntries } from '@shared/collections';

/** One document the view lists: what it is, its title and the address it is published at. */
export interface SeoDocument {
  subject: SeoSubject;
  /** Tells documents apart in a list (seoSubjectKey). */
  key: string;
  title: string;
  /** `/` for the home page, a page's route, or an entry's collection address and slug. */
  address: string;
  /** Left out of the website: a draft page (never Home) or a draft entry. */
  draft: boolean;
  home: boolean;
}

/** The site's pages, or one collection's entries, as the view lists them. */
export interface SeoDocumentGroup {
  /** `pages`, or `collection-` and the collection's ID (a collection may be called "pages"). */
  id: string;
  label: string;
  documents: SeoDocument[];
}

/** A stable key for a document, unique across pages and entries. */
export const seoSubjectKey = (s: SeoSubject): string => (s.kind === 'page' ? `page:${s.pageId}` : `entry:${s.collectionId}:${s.entryId}`);

export const sameSubject = (a: SeoSubject | null | undefined, b: SeoSubject | null | undefined): boolean => !!a && !!b && seoSubjectKey(a) === seoSubjectKey(b);

const own = <T>(record: Record<string, T> | undefined, id: string): T | undefined => (record && Object.hasOwn(record, id) ? record[id] : undefined);

const titled = (title: unknown, fallback: string) => (typeof title === 'string' && title.trim() ? title : fallback);

function pageDocument(state: ProjectState, pageId: string): SeoDocument | undefined {
  const page = own(state.pages, pageId);
  if (!page || typeof page !== 'object') return undefined;
  const home = pageId === state.site.homePageId;
  return { subject: { kind: 'page', pageId }, key: `page:${pageId}`, title: titled(page.title, 'Untitled page'), address: home ? '/' : page.route, draft: page.draft === true && !home, home };
}

function entryDocument(collection: Collection, entry: EntryDoc): SeoDocument {
  const subject: SeoSubject = { kind: 'entry', collectionId: collection.settings.id, entryId: entry.id };
  return { subject, key: seoSubjectKey(subject), title: titled(entry.title, 'Untitled'), address: entryRoute(collection, entry), draft: entry.draft !== false, home: false };
}

/** The collections whose entries the view lists, by ID: each one's settings name its own ID. */
function listedCollections(state: ProjectState): Collection[] {
  const all = state.collections ?? {};
  return Object.keys(all)
    .sort()
    .flatMap((id) => {
      const c = all[id];
      return c && c.entries && typeof c.entries === 'object' && c.settings?.id === id ? [c] : [];
    });
}

/**
 * Every document of the site the view lists: the pages first, in the site's page order, then each collection's
 * entries in the collection's own order, drafts included. A collection with no entries is left out.
 */
export function seoDocuments(state: ProjectState): SeoDocumentGroup[] {
  const pages = state.site.pageOrder.flatMap((id) => pageDocument(state, id) ?? []);
  const groups: SeoDocumentGroup[] = [{ id: 'pages', label: 'Pages', documents: pages }];
  for (const c of listedCollections(state)) {
    const documents = orderedEntries(c)
      .filter((e) => !!e && typeof e === 'object')
      .map((e) => entryDocument(c, e));
    if (documents.length) groups.push({ id: `collection-${c.settings.id}`, label: titled(c.settings.name, c.settings.id), documents });
  }
  return groups;
}

/** The document a subject names, while the project still has it; undefined once it is gone (deleted, undone away). */
export function seoDocument(state: ProjectState | null | undefined, subject: SeoSubject | null | undefined): SeoDocument | undefined {
  if (!state || !subject) return undefined;
  if (subject.kind === 'page') return pageDocument(state, subject.pageId);
  const c = own(state.collections, subject.collectionId);
  const e = c && c.settings?.id === subject.collectionId ? own(c.entries, subject.entryId) : undefined;
  return c && e && typeof e === 'object' ? entryDocument(c, e) : undefined;
}

/**
 * The SEO view's choice kept valid with a new copy of the project, in the same update as the snapshot: a document that
 * went (deleted, undone away, removed outside the app) is let go, so the view falls back to none chosen and a Redo that
 * brings it back never chooses it again on its own.
 */
export function keepSeoSubject(state: ProjectState, subject: SeoSubject | null): { seoSubject?: null } {
  return subject && !seoDocument(state, subject) ? { seoSubject: null } : {};
}
