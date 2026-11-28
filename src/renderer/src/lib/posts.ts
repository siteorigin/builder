/**
 * The Posts workspace: a collection's entries listed for finding and sorting, and the operations its buttons send.
 * Plain functions over the project, tested without a renderer; the panel and the writer call them.
 */
import { TEXT_LIMITS } from '@shared/text-limits';
import type { Collection, EntryDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, entryRoute, hasDetailPages, isSyncedCollection, orderedEntries, siteEntries } from '@shared/collections';
import { newId } from '@shared/ids';
import { formatArticleDate, isArticleDate } from '@shared/articles';
import { fold } from './fold';
import { entryLinkUses } from '@engine/page-links';
import { canReplaceEntry, entryReferenceUses } from '@engine/collections';
import { deleteDestinations } from './content';
import { resolveRedirects } from '@shared/redirects';

/** A collection entry the Posts workspace has open. */
export interface PostRef {
  collectionId: string;
  entryId: string;
}

export type PostSort = 'order' | 'newest' | 'oldest' | 'title';
export const POST_SORTS: Array<{ id: PostSort; label: string }> = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'title', label: 'Title' },
  { id: 'order', label: 'Collection order' }
];

/** Which posts the list shows by whether they are on the website. */
export type PostStatus = 'all' | 'published' | 'drafts';
export const POST_STATUSES: Array<{ id: PostStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'published', label: 'Published' },
  { id: 'drafts', label: 'Drafts' }
];

/** What the list narrows to besides its words: posts on the website or drafts, and posts filed under one category. */
export interface PostFilter {
  status?: PostStatus;
  /** A term ID of the collection's categories; empty or absent for every post. */
  category?: string;
}

/** One post as the list shows it. */
export interface PostRow {
  id: string;
  title: string;
  date: string;
  draft: boolean;
  route: string;
  /** While finding: the first of title, address, author and excerpt that has the words (the list shows that field). */
  matched?: PostField;
  /** While finding, the text of the field that matched, as written (the byline, the address or slug, the excerpt). */
  matchedText?: string;
}

/** The fields the find looks in, in the order a match is reported. */
export type PostField = 'title' | 'route' | 'author' | 'excerpt';

/** The longest title an entry takes (entry.create and entry.update). */
export const MAX_POST_TITLE = 200;

/** The collection the workspace shows: the one asked for while it exists, else the blog, else the first. */
export function postsCollection(state: ProjectState, wanted?: string | null): Collection | undefined {
  const all = state.collections ?? {};
  if (wanted && Object.hasOwn(all, wanted)) return all[wanted];
  if (Object.hasOwn(all, POSTS_COLLECTION_ID)) return all[POSTS_COLLECTION_ID];
  const first = Object.keys(all).sort()[0];
  return first ? all[first] : undefined;
}

/**
 * The collection the Content list shows: the open entry's (the list turns to it, and turning the list elsewhere lets
 * the entry go), else the one it was turned to (`listed`, the store's contentCollection), else the blog, else the
 * first. Read from the open entry first, an entry opened from anywhere is named with its own collection in the same
 * render. The list's head, the toolbar, the Inspector, the composer and the writer all name this one, so the window
 * gives one answer to which collection is in front.
 */
export function listedCollection(state: ProjectState, listed: string | null | undefined, post: PostRef | null | undefined): Collection | undefined {
  const all = state.collections ?? {};
  return postsCollection(state, post && Object.hasOwn(all, post.collectionId) ? post.collectionId : listed);
}

/** The entry a reference names, while it is still in that collection. */
export function postAt(state: ProjectState, ref: PostRef | null | undefined): EntryDoc | undefined {
  if (!ref) return undefined;
  const c = Object.hasOwn(state.collections ?? {}, ref.collectionId) ? state.collections[ref.collectionId] : undefined;
  return c && Object.hasOwn(c.entries, ref.entryId) ? c.entries[ref.entryId] : undefined;
}

/**
 * What the Posts workspace puts in front of the editor (#578): its writer, over the canvas (also with no post chosen,
 * and while a Preview waits for what was typed to save), or the post it opened, previewed on the canvas whichever panel
 * the sidebar shows. Null while neither is: the editor shows its page. The toolbar and the Inspector speak of the post
 * meanwhile, never of the page under the writer, so nothing changed there lands on that page.
 */
export function postWorkspace(s: { leftTab: string | null; postView: 'write' | 'preview'; mode: 'edit' | 'preview'; post: PostRef | null }): 'write' | 'preview' | null {
  if (s.leftTab === 'posts' && s.postView === 'write') return 'write';
  return s.postView === 'preview' && s.mode === 'preview' && s.post ? 'preview' : null;
}

/**
 * What becomes of a post's preview chosen in the toolbar while it waits for the writer's save (#700), asked of every
 * change of the editor's state: it waits while the writer is in front in Preview in the opening it was asked in. It
 * ends once a mode is chosen, the post is previewed some other way or another opening starts, and once the writer is
 * left with Preview still on it is undone (Edit comes back), since no preview began.
 */
export function waitingPreview(s: { leftTab: string | null; postView: 'write' | 'preview'; mode: 'edit' | 'preview'; workspaceKey: string | undefined }, askedIn: string | undefined): 'waits' | 'ends' | 'undone' {
  if (s.workspaceKey !== askedIn || s.mode !== 'preview' || s.postView !== 'write') return 'ends';
  return s.leftTab === 'posts' ? 'waits' : 'undone';
}

/**
 * What the editor shows while the Posts workspace is in front: the post written or previewed (none chosen yet in the
 * writer), or where a visitor went on to from its preview, as the canvas last reported (`at`, null until it has: the
 * post is still on its way). That is another post, a page of the site, or an address that is neither (an old one, the
 * not-found page).
 */
export type PostShown = { kind: 'post'; ref: PostRef | null; title: string; draft: boolean } | { kind: 'page'; pageId: string } | { kind: 'address'; path: string };

const named = (ref: PostRef, e: EntryDoc): PostShown => ({ kind: 'post', ref, title: typeof e.title === 'string' && e.title ? e.title : 'Untitled', draft: e.draft !== false });

export function postShown(state: ProjectState, workspace: 'write' | 'preview', post: PostRef | null, at: string | null, listed: string | null = null): PostShown {
  if (workspace === 'preview' && at !== null) {
    // As the canvas resolves an address (lib/template-view viewAt): an entry's page first, then the site's pages.
    const same = (route: string) => route === at || route === `${at}/`;
    const hit = siteEntries(state).find((e) => same(e.route));
    if (hit) return named({ collectionId: hit.collection.settings.id, entryId: hit.entry.id }, hit.entry);
    const page = Object.values(state.pages).find((p) => same(p.route));
    return page ? { kind: 'page', pageId: page.id } : { kind: 'address', path: at };
  }
  const entry = postAt(state, post);
  if (entry && post) return named(post, entry);
  // None open: the workspace, named as its list's head names it (the collection it shows, by its own name, or Content
  // while the project has no collection yet).
  const collection = listedCollection(state, listed, post);
  return { kind: 'post', ref: null, title: collection ? collection.settings.name : 'Content', draft: false };
}

/** Text as the find compares it, character by character as the list's marks do (lib/fold). */
const words = (s: unknown) => (typeof s === 'string' ? fold(s) : '');

/** Whether a post is one the filter keeps: of the chosen status, and filed under the chosen category. */
function kept(e: EntryDoc, filter: PostFilter): boolean {
  const draft = e.draft !== false;
  if ((filter.status === 'published' && draft) || (filter.status === 'drafts' && !draft)) return false;
  if (!filter.category) return true;
  const ids: unknown = e.terms && typeof e.terms === 'object' && Object.hasOwn(e.terms, 'categories') ? e.terms.categories : undefined;
  return Array.isArray(ids) && ids.includes(filter.category);
}

/** How many of a collection's posts are published and how many are drafts, for the status filter. */
export function postCounts(collection: Collection): Record<PostStatus, number> {
  const all = Object.values(collection.entries).filter((e) => !!e && typeof e === 'object');
  const drafts = all.filter((e) => e.draft !== false).length;
  return { all: all.length, published: all.length - drafts, drafts };
}

/**
 * The collection's posts that match `query` (in the title, address, author or excerpt, ignoring case) and `filter`, in
 * `sort`'s order. Ties keep the collection's own order, so rows never trade places on their own.
 */
export function postRows(collection: Collection, query: string, sort: PostSort, filter: PostFilter = {}): PostRow[] {
  const q = words(query.trim());
  const ordered = orderedEntries(collection).filter((e) => !!e && typeof e === 'object' && kept(e, filter));
  const rank = new Map(ordered.map((e, i) => [e.id, i]));
  // The address as the writer shows it ("/blog/winter-hours/"), so a pasted address finds its post.
  const fields = (e: EntryDoc): Record<PostField, unknown> => ({ title: e.title, route: entryRoute(collection, e) ?? e.slug, author: e.author, excerpt: e.excerpt });
  const matchOf = (e: EntryDoc): PostField | undefined => {
    const f = fields(e);
    return (['title', 'route', 'author', 'excerpt'] as const).find((k) => words(f[k]).includes(q));
  };
  const matched = new Map<string, { field: PostField; text: string }>();
  if (q)
    for (const e of ordered) {
      const m = matchOf(e);
      const v = m && fields(e)[m];
      if (m) matched.set(e.id, { field: m, text: typeof v === 'string' ? v : '' });
    }
  const found = q ? ordered.filter((e) => matched.has(e.id)) : ordered;
  const byRank = (a: EntryDoc, b: EntryDoc) => rank.get(a.id)! - rank.get(b.id)!;
  const date = (e: EntryDoc) => (typeof e.publishedAt === 'string' ? e.publishedAt : '');
  const sorted = [...found];
  if (sort === 'newest') sorted.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? 1 : -1) : byRank(a, b)));
  else if (sort === 'oldest') sorted.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? -1 : 1) : byRank(a, b)));
  else if (sort === 'title') sorted.sort((a, b) => words(a.title).localeCompare(words(b.title)) || byRank(a, b));
  return sorted.map((e) => ({
    id: e.id,
    title: typeof e.title === 'string' && e.title ? e.title : 'Untitled',
    date: date(e),
    draft: e.draft !== false,
    route: entryRoute(collection, e) ?? '',
    ...(matched.has(e.id) ? { matched: matched.get(e.id)!.field, matchedText: matched.get(e.id)!.text } : {})
  }));
}

/**
 * A new draft post: the blog is created first when the project has no collection to put it in. The entry's ID is
 * chosen here, so the writer opens it as soon as it lands.
 */
export function newPostOps(state: ProjectState, collectionId: string | null, title: string): { ops: EditOperation[]; ref: PostRef } {
  const entryId = newId('en', 10);
  const target = postsCollection(state, collectionId);
  const id = target?.settings.id ?? POSTS_COLLECTION_ID;
  const ops: EditOperation[] = [];
  if (!target) ops.push({ type: 'collection.create', collectionId: POSTS_COLLECTION_ID });
  ops.push({ type: 'entry.create', collectionId: id, entryId, title: title.trim().slice(0, MAX_POST_TITLE) || 'Untitled post' });
  return { ops, ref: { collectionId: id, entryId } };
}

/**
 * A copy of a post, as a new draft dated today: its text, byline, excerpt, pictures and their descriptions, groupings
 * and field values, and its search description, sharing image and search switches, under a title that says it is a
 * copy. Its address is a new one the engine picks from that title. Its own browser title and canonical URL say which post it is, so the
 * copy starts without them.
 */
export function duplicatePostOps(state: ProjectState, ref: PostRef): { ops: EditOperation[]; ref: PostRef } | null {
  const e = postAt(state, ref);
  if (!e) return null;
  const entryId = newId('en', 10);
  const title = `${e.title} (copy)`.slice(0, MAX_POST_TITLE);
  const seo = e.seo && typeof e.seo === 'object' ? e.seo : {};
  const op: EditOperation = {
    type: 'entry.create',
    collectionId: ref.collectionId,
    entryId,
    title,
    draft: true,
    body: structuredClone(e.body),
    terms: structuredClone(e.terms ?? {}),
    values: structuredClone(e.values ?? {}),
    ...(e.author ? { author: e.author } : {}),
    ...(e.excerpt ? { excerpt: e.excerpt } : {}),
    ...(e.featuredImage ? { featuredImage: e.featuredImage } : {}),
    // Its own words for the picture, never the library's suggestion, which the copy follows as the post does.
    ...(e.featuredImage && typeof e.featuredImageAlt === 'string' && e.featuredImageAlt.trim() && e.featuredImageAlt.length <= TEXT_LIMITS.imageAlt ? { featuredImageAlt: e.featuredImageAlt } : {}),
    // Only what the copy can be made with: a description over the limit or an image gone from the library (written
    // by hand) would refuse the whole copy, so it starts without them.
    ...(typeof seo.description === 'string' && seo.description.trim() && seo.description.length <= TEXT_LIMITS.pageDescription ? { description: seo.description } : {}),
    ...(typeof seo.socialImage === 'string' && Object.hasOwn(state.assets.assets, seo.socialImage) && state.assets.assets[seo.socialImage].kind === 'image' ? { socialImage: seo.socialImage } : {}),
    ...(seo.noindex === true ? { noindex: true } : {}),
    ...(seo.searchHidden === true ? { searchHidden: true } : {})
  };
  return { ops: [op], ref: { collectionId: ref.collectionId, entryId } };
}

/** The question Publish asks before a future-dated post goes on the website, in the shape the app's dialog takes. */
export interface FuturePublishQuestion {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'neutral';
  icon: 'warning';
  subject: string;
  details: Array<{ kind: 'risk' | 'keep'; text: string }>;
}

/** Whether `publishedAt` is a calendar date after `today`. Days compare as YYYY-MM-DD text, which orders them. */
function isFutureDay(publishedAt: unknown, today: string): publishedAt is string {
  return isArticleDate(publishedAt) && isArticleDate(today) && publishedAt > today;
}

/**
 * What the Publication date of an entry already on the website says when it is after `today` (#1317): moving the date
 * ahead holds nothing back. Null for a draft, which Publish asks about itself, and for a date today or earlier.
 */
export function futureDateWarning(entry: Pick<EntryDoc, 'draft' | 'publishedAt'>, noun: string, language: string | undefined, today: string): string | null {
  if (entry.draft !== false || !isFutureDay(entry.publishedAt, today)) return null;
  return `This ${noun} is published, so it is still in the next export, dated ${formatArticleDate(entry.publishedAt, language)}.`;
}

/**
 * What Publish asks first when the post is dated after `today` (#1115): nothing makes the website wait for that day,
 * so a post published now is included in the next export. Null for a post dated today or earlier,
 * or without a valid date.
 */
export function futurePublishQuestion(publishedAt: unknown, noun: string, language: string | undefined, today: string): FuturePublishQuestion | null {
  if (!isFutureDay(publishedAt, today)) return null;
  const day = formatArticleDate(publishedAt, language);
  return {
    title: `Publish this ${noun} dated ${day}?`,
    body: `This ${noun} is dated ${day}, which has not come yet. Nothing holds it back until then: published now, it is included in the next export.`,
    confirmLabel: 'Publish now',
    cancelLabel: 'Keep as draft',
    tone: 'neutral',
    icon: 'warning',
    subject: day,
    details: [
      { kind: 'risk', text: `It is included in the next export, dated ${day}.` },
      { kind: 'keep', text: 'Kept as a draft, it stays off the website until you publish it.' }
    ]
  };
}

/** What an answer to `futurePublishQuestion` does: publish, keep the post as a draft, or nothing (the dialog dismissed). */
export function futurePublishChoice(answer: boolean | null): 'publish' | 'keep-draft' | 'stay' {
  return answer === true ? 'publish' : answer === false ? 'keep-draft' : 'stay';
}

/** Where the links and old addresses of a deleted entry, and the references naming it, go instead. */
export type DeleteChoice = { kind: 'page' | 'entry'; id: string; label: string; group: string };

/**
 * What deleting an entry has to deal with first (#1461): the links pointing to it, its old addresses kept working, and
 * the references naming it, by the entries holding them; and the places all of those can go instead. A reference names
 * an entry of its own field's collection, so with one only another entry of the deleted entry's collection can take its
 * place: no page, nor an entry of another collection. Links and old addresses send visitors on, so they go only where
 * visitors can (deleteDestinations, canReplaceEntry). With references alone, a draft can take its place too. `synced`
 * names a holder whose collection is synced from a source, so read-only here: while one holds a link or reference to
 * it, nothing can take its place.
 */
export function deleteHolds(
  state: ProjectState,
  ref: PostRef
): { links: number; linkedFrom: string[]; kept: number; references: number; referencedFrom: string[]; synced: string | null; choices: DeleteChoice[] } {
  const uses = entryLinkUses(state, ref.entryId);
  const kept: unknown = state.site.redirects;
  const keptN = Array.isArray(kept) ? kept.filter((r) => (r as { entryId?: unknown })?.entryId === ref.entryId).length : 0;
  const refs = entryReferenceUses(state, ref.entryId);
  const all = state.collections ?? {};
  let choices: DeleteChoice[];
  if (refs.length) {
    const from = Object.hasOwn(all, ref.collectionId) ? all[ref.collectionId] : undefined;
    // With links or old addresses as well, it must be somewhere visitors can go, as the engine asks (canReplaceEntry):
    // published, unless its collection has no pages, when no entry of it has one and any may take its place.
    const visitors = uses.length > 0 || keptN > 0;
    const pageless = !!from && !hasDetailPages(from.settings);
    choices = from
      ? orderedEntries(from)
          .filter((x) => x.id !== ref.entryId && (!visitors || ((x.draft === false || pageless) && canReplaceEntry(from, { collection: from, entry: x }, true))))
          .map((x): DeleteChoice => ({ kind: 'entry', id: x.id, label: x.draft === false ? x.title : `${x.title} (draft)`, group: from.settings.name }))
      : [];
  } else {
    const { pages, groups } = deleteDestinations(state, ref);
    const choice = (value: string, label: string, group: string): DeleteChoice => ({ kind: value.startsWith('page:') ? 'page' : 'entry', id: value.slice(value.indexOf(':') + 1), label, group });
    choices = [...pages.map((p) => choice(p.value, p.label, 'Pages')), ...groups.flatMap((g) => g.entries.map((x) => choice(x.value, x.label, g.name)))];
  }
  const syncedLink = uses.find((u) => u.owner.kind === 'entry' && isSyncedCollection(all[u.owner.collectionId]?.settings));
  const syncedRef = refs.find((r) => isSyncedCollection(r.collection.settings));
  return {
    links: uses.length,
    linkedFrom: [...new Set(uses.map((u) => u.where))],
    kept: keptN,
    references: refs.length,
    referencedFrom: [...new Set(refs.map((r) => `${r.entry.title} (${r.collection.settings.name})`))],
    synced: syncedRef ? `${syncedRef.entry.title} (${syncedRef.collection.settings.name})` : (syncedLink?.where ?? null),
    choices
  };
}

/** Whether deleting the entry asks what takes its place, rather than only whether to delete it. */
export function deleteAsksWhere(state: ProjectState, ref: PostRef): boolean {
  const h = deleteHolds(state, ref);
  return h.links > 0 || h.kept > 0 || h.references > 0;
}

/**
 * What a delete was checked against: each link to the entry by its holder and label, each old address it keeps, and
 * each reference by its entry and field. The same means the author's choice still covers everything it changes.
 */
export function deleteFingerprint(state: ProjectState, ref: PostRef): string {
  const kept: unknown = state.site.redirects;
  const addresses = Array.isArray(kept) ? kept.filter((r) => (r as { entryId?: unknown })?.entryId === ref.entryId).map((r) => String((r as { from?: unknown }).from)) : [];
  const links = entryLinkUses(state, ref.entryId).map((u) => `${JSON.stringify(u.owner)}:${u.where}:${u.label}`);
  const refs = entryReferenceUses(state, ref.entryId).map((r) => `${r.collection.settings.id}:${r.entry.id}:${r.field}`);
  return JSON.stringify([links.sort(), addresses.sort(), refs.sort()]);
}

/**
 * The rows a click picks in the list (#1507), as in a file manager: Shift picks every row from the anchor to the one
 * clicked, in the order the list shows them, in place of what was picked; Cmd/Ctrl adds the row or takes it out. An
 * anchor no longer shown starts the range at the row clicked.
 */
export function pickRows(shown: readonly string[], picked: ReadonlySet<string>, anchor: string | null, id: string, how: 'range' | 'toggle'): Set<string> {
  if (how === 'toggle') {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  const from = anchor === null ? -1 : shown.indexOf(anchor);
  const to = shown.indexOf(id);
  if (to < 0) return new Set(picked);
  const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  return new Set(shown.slice(a, b + 1));
}

/** The picked entries still in the collection, in the order given; none of a synced one, whose entries change there. */
function pickedEntries(state: ProjectState, collectionId: string, ids: readonly string[]): EntryDoc[] {
  const c = Object.hasOwn(state.collections, collectionId) ? state.collections[collectionId] : undefined;
  if (!c || isSyncedCollection(c.settings)) return [];
  return [...new Set(ids)].flatMap((id) => (Object.hasOwn(c.entries, id) && c.entries[id] && typeof c.entries[id] === 'object' ? [c.entries[id]] : []));
}

/**
 * Publishing the picked entries, or moving them to drafts, as one change: only those not already so. `future` names
 * the drafts dated after `today`, which Publish asks about first (#1115).
 */
export function bulkStatusOps(state: ProjectState, collectionId: string, ids: readonly string[], draft: boolean, today = ''): { ops: EditOperation[]; future: Array<{ id: string; title: string; date: string }> } {
  const changing = pickedEntries(state, collectionId, ids).filter((e) => (e.draft !== false) !== draft);
  return {
    ops: changing.map((e) => ({ type: 'entry.update', collectionId, entryId: e.id, draft })),
    future: draft ? [] : changing.flatMap((e) => (isFutureDay(e.publishedAt, today) ? [{ id: e.id, title: e.title, date: e.publishedAt }] : []))
  };
}

/** The most terms of one grouping an entry can be filed under (the operation's limit). */
export const MAX_ENTRY_TERMS = 50;

/** A term of one of a collection's groupings to file the picked entries under (`on`), or take them out of. */
export interface TermChange {
  taxonomyId: string;
  termId: string;
  on: boolean;
}

/**
 * Filing the picked entries under terms of the collection's groupings, or taking them out of them, as one change: one
 * update for each entry it changes, with every change to it. Each keeps its other terms; one gone from its grouping
 * (deleted, undone away) is dropped, since the engine refuses a list naming it. Terms the collection does not have
 * change nothing. `full` names the entries that would be filed under more terms of one grouping than an entry can
 * hold; they are left as they are, and the caller says so rather than sending a change that leaves them out.
 */
export function bulkTermOps(state: ProjectState, collectionId: string, ids: readonly string[], changes: readonly TermChange[]): { ops: EditOperation[]; full: string[] } {
  const c = Object.hasOwn(state.collections, collectionId) ? state.collections[collectionId] : undefined;
  const termsIn = (tax: string) => {
    const t = c?.settings.taxonomies && Object.hasOwn(c.settings.taxonomies, tax) ? c.settings.taxonomies[tax] : undefined;
    return t?.terms && typeof t.terms === 'object' ? t.terms : undefined;
  };
  const real = changes.filter((x) => {
    const terms = termsIn(x.taxonomyId);
    return !!terms && Object.hasOwn(terms, x.termId);
  });
  const taxonomies = [...new Set(real.map((x) => x.taxonomyId))];
  const full: string[] = [];
  const ops = pickedEntries(state, collectionId, ids).flatMap((e): EditOperation[] => {
    const next: Record<string, string[]> = {};
    for (const tax of taxonomies) {
      const terms = termsIn(tax)!;
      const filed: unknown = e.terms && Object.hasOwn(e.terms, tax) ? e.terms[tax] : undefined;
      const had = Array.isArray(filed) ? filed.filter((x): x is string => typeof x === 'string') : [];
      let ids = [...new Set(had.filter((x) => Object.hasOwn(terms, x)))];
      // Taken out first, so a term added in place of one taken out fits; one past the most an entry can hold is not added.
      for (const x of real) if (x.taxonomyId === tax && !x.on) ids = ids.filter((id) => id !== x.termId);
      for (const x of real) if (x.taxonomyId === tax && x.on && !ids.includes(x.termId)) ids = [...ids, x.termId];
      // More than an entry can hold (one written by hand may hold more already): it is named, and left as it is.
      if (ids.length > MAX_ENTRY_TERMS) {
        full.push(e.title);
        return [];
      }
      if (ids.length !== had.length || ids.some((id, i) => id !== had[i])) next[tax] = ids;
    }
    return Object.keys(next).length ? [{ type: 'entry.update', collectionId, entryId: e.id, terms: next }] : [];
  });
  return { ops, full };
}

/**
 * Deleting the picked entries as one change (#1507): those nothing links to or names, and with no old address kept
 * working, go at once. The rest (`held`) ask what takes their place, so they are left for the author to delete one at a
 * time, where that is asked. A link or reference from another picked entry holds one too: the engine removes them in
 * turn, so two naming each other would refuse the whole change. One pass over the project for all of them, however
 * many are picked.
 */
export function bulkDeletePlan(state: ProjectState, collectionId: string, ids: readonly string[]): { ops: EditOperation[]; free: Array<{ id: string; title: string }>; held: Array<{ id: string; title: string }> } {
  const entries = pickedEntries(state, collectionId, ids);
  const set = new Set(entries.map((e) => e.id));
  const holds = new Set<string>();
  for (const u of entryLinkUses(state, set)) holds.add(u.link.target);
  const kept: unknown = state.site.redirects;
  if (Array.isArray(kept)) for (const r of kept) if (typeof (r as { entryId?: unknown })?.entryId === 'string') holds.add((r as { entryId: string }).entryId);
  // An old address kept by the address it goes to rather than by the entry, through other old addresses or not.
  for (const view of ['website', 'preview'] as const) for (const r of resolveRedirects(state, view).live) if (r.entry) holds.add(r.entry.entry.id);
  for (const r of entryReferenceUses(state, set)) {
    const v: unknown = r.entry.values?.[r.field];
    for (const id of Array.isArray(v) ? v : [v]) if (typeof id === 'string') holds.add(id);
  }
  // Both pass over holders among the picked themselves: their links and references to one another, here. Any link
  // value anywhere in one of them counts, which may hold more than the engine would, never less.
  const linksIn = (x: unknown, self: string): void => {
    if (Array.isArray(x)) return x.forEach((y) => linksIn(y, self));
    if (!x || typeof x !== 'object') return;
    const l = x as { type?: unknown; target?: unknown };
    if (l.type === 'entry' && typeof l.target === 'string' && l.target !== self && set.has(l.target)) holds.add(l.target);
    for (const y of Object.values(x)) linksIn(y, self);
  };
  for (const e of entries) linksIn(e, e.id);
  for (const c of Object.values(state.collections ?? {})) {
    const refs = Object.entries(c.settings?.fields ?? {}).filter(([, f]) => f?.type === 'reference').map(([name]) => name);
    if (!refs.length) continue;
    for (const e of Object.values(c.entries)) {
      if (!set.has(e.id)) continue;
      for (const field of refs) {
        const v: unknown = e.values && Object.hasOwn(e.values, field) ? e.values[field] : undefined;
        for (const id of Array.isArray(v) ? v : [v]) if (typeof id === 'string' && id !== e.id) holds.add(id);
      }
    }
  }
  const row = (e: EntryDoc) => ({ id: e.id, title: e.title });
  const free = entries.filter((e) => !holds.has(e.id)).map(row);
  return { ops: free.map((f) => ({ type: 'entry.remove', collectionId, entryId: f.id })), free, held: entries.filter((e) => holds.has(e.id)).map(row) };
}
