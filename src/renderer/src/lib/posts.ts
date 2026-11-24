/**
 * The Posts workspace: a collection's entries listed for finding and sorting, and the operations its buttons send.
 * Plain functions over the project, tested without a renderer; the panel and the writer call them.
 */
import type { Collection, EditOperation, EntryDoc, ProjectState } from '@shared/types';
import { POSTS_COLLECTION_ID, entryRoute, orderedEntries } from '@shared/collections';
import { newId } from '@shared/ids';
import type { PostRef } from '../store';

export type PostSort = 'order' | 'newest' | 'oldest' | 'title';
export const POST_SORTS: Array<{ id: PostSort; label: string }> = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'title', label: 'Title' },
  { id: 'order', label: 'Collection order' }
];

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

const words = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');

/**
 * The collection's posts that match `query` (in the title, slug, author or excerpt, ignoring case), in `sort`'s
 * order. Ties keep the collection's own order, so rows never trade places on their own.
 */
export function postRows(collection: Collection, query: string, sort: PostSort): PostRow[] {
  const q = query.trim().toLowerCase();
  const ordered = orderedEntries(collection).filter((e) => !!e && typeof e === 'object');
  const rank = new Map(ordered.map((e, i) => [e.id, i]));
  const found = q ? ordered.filter((e) => [e.title, e.slug, e.author, e.excerpt].some((f) => words(f).includes(q))) : ordered;
  const byRank = (a: EntryDoc, b: EntryDoc) => rank.get(a.id)! - rank.get(b.id)!;
  const date = (e: EntryDoc) => (typeof e.publishedAt === 'string' ? e.publishedAt : '');
  const sorted = [...found];
  if (sort === 'newest') sorted.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? 1 : -1) : byRank(a, b)));
  else if (sort === 'oldest') sorted.sort((a, b) => (date(a) !== date(b) ? (date(a) < date(b) ? -1 : 1) : byRank(a, b)));
  else if (sort === 'title') sorted.sort((a, b) => words(a.title).localeCompare(words(b.title)) || byRank(a, b));
  return sorted.map((e) => ({ id: e.id, title: typeof e.title === 'string' && e.title ? e.title : 'Untitled', date: date(e), draft: e.draft !== false, route: entryRoute(collection, e) }));
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
 * A copy of a post, as a new draft dated today: its text, byline, excerpt, pictures, groupings and field values, under
 * a title that says it is a copy. Its address is a new one the engine picks from that title.
 */
export function duplicatePostOps(state: ProjectState, ref: PostRef): { ops: EditOperation[]; ref: PostRef } | null {
  const e = postAt(state, ref);
  if (!e) return null;
  const entryId = newId('en', 10);
  const title = `${e.title} (copy)`.slice(0, MAX_POST_TITLE);
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
    ...(e.featuredImage ? { featuredImage: e.featuredImage } : {})
  };
  return { ops: [op], ref: { collectionId: ref.collectionId, entryId } };
}
