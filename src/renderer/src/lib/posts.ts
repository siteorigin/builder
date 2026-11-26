/**
 * The Posts workspace: a collection's entries listed for finding and sorting, and the operations its buttons send.
 * Plain functions over the project, tested without a renderer; the panel and the writer call them.
 */
import { TEXT_LIMITS } from '@shared/text-limits';
import type { Collection, EntryDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, entryRoute, orderedEntries, siteEntries } from '@shared/collections';
import { newId } from '@shared/ids';

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
}

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

export function postShown(state: ProjectState, workspace: 'write' | 'preview', post: PostRef | null, at: string | null): PostShown {
  if (workspace === 'preview' && at !== null) {
    // As the canvas resolves an address (lib/template-view viewAt): an entry's page first, then the site's pages.
    const same = (route: string) => route === at || route === `${at}/`;
    const hit = siteEntries(state).find((e) => same(e.route));
    if (hit) return named({ collectionId: hit.collection.settings.id, entryId: hit.entry.id }, hit.entry);
    const page = Object.values(state.pages).find((p) => same(p.route));
    return page ? { kind: 'page', pageId: page.id } : { kind: 'address', path: at };
  }
  const entry = postAt(state, post);
  return entry && post ? named(post, entry) : { kind: 'post', ref: null, title: 'Posts', draft: false };
}

const words = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');

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
 * The collection's posts that match `query` (in the title, slug, author or excerpt, ignoring case) and `filter`, in
 * `sort`'s order. Ties keep the collection's own order, so rows never trade places on their own.
 */
export function postRows(collection: Collection, query: string, sort: PostSort, filter: PostFilter = {}): PostRow[] {
  const q = query.trim().toLowerCase();
  const ordered = orderedEntries(collection).filter((e) => !!e && typeof e === 'object' && kept(e, filter));
  const rank = new Map(ordered.map((e, i) => [e.id, i]));
  const found = q ? ordered.filter((e) => [e.title, e.slug, e.author, e.excerpt].some((f) => words(f).includes(q))) : ordered;
  const byRank = (a: EntryDoc, b: EntryDoc) => rank.get(a.id)! - rank.get(b.id)!;
  const date = (e: EntryDoc) => (typeof e.publishedAt === 'string' ? e.publishedAt : '');
  const sorted = [...found];
  if (sort === 'newest') sorted.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? 1 : -1) : byRank(a, b)));
  else if (sort === 'oldest') sorted.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? -1 : 1) : byRank(a, b)));
  else if (sort === 'title') sorted.sort((a, b) => words(a.title).localeCompare(words(b.title)) || byRank(a, b));
  return sorted.map((e) => ({ id: e.id, title: typeof e.title === 'string' && e.title ? e.title : 'Untitled', date: date(e), draft: e.draft !== false, route: entryRoute(collection, e) ?? '' }));
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
 * A copy of a post, as a new draft dated today: its text, byline, excerpt, pictures, groupings and field values, and
 * its search description, sharing image and search switches, under a title that says it is a copy. Its address is a
 * new one the engine picks from that title. Its own browser title and canonical URL say which post it is, so the
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
    // Only what the copy can be made with: a description over the limit or an image gone from the library (written
    // by hand) would refuse the whole copy, so it starts without them.
    ...(typeof seo.description === 'string' && seo.description.trim() && seo.description.length <= TEXT_LIMITS.pageDescription ? { description: seo.description } : {}),
    ...(typeof seo.socialImage === 'string' && Object.hasOwn(state.assets.assets, seo.socialImage) && state.assets.assets[seo.socialImage].kind === 'image' ? { socialImage: seo.socialImage } : {}),
    ...(seo.noindex === true ? { noindex: true } : {}),
    ...(seo.searchHidden === true ? { searchHidden: true } : {})
  };
  return { ops: [op], ref: { collectionId: ref.collectionId, entryId } };
}
