/**
 * Collection queries in a generator run (#674): the entries a query finds, worked out once per state and named by the
 * query's key, so a file that lists them depends on which entries they are, not on every document the query looked
 * at. An edit that changes no query's result regenerates nothing that reads it.
 */
import type { EntryDoc, ProjectState } from '@shared/types';
import { CURRENT_COLLECTION, collectionQueryKey, normalizeCollectionQuery, normalizePlace, queryCollection, queryEntries, type CollectionQuery, type QueryPlace } from '@shared/collection-query';
import { derived } from './cache';

/** A query read once, the place it reads (none when it reads none) and the key both are named by. */
interface Detached {
  q: CollectionQuery;
  here: QueryPlace;
  key: string;
}

/**
 * A query and its place, each read once into a detached plain copy, the place kept only when the query reads it: a
 * run keeps the first way it was given to work out a key, so the key and that way must be made from the same copy,
 * which nothing edited afterwards (or a getter answering differently) can change.
 */
function detached(query: unknown, place: unknown): Detached | null {
  const q = normalizeCollectionQuery(query);
  if (!q) return null;
  const here = q.collectionId === CURRENT_COLLECTION || q.excludeCurrent ? normalizePlace(place) : {};
  const key = collectionQueryKey(q, here);
  return key === null ? null : { q, here, key };
}

// One for each place a query excluding it is shown (every entry's page of a layout), each reading the whole collection:
// worked out for every state.
const idsOf = (state: ProjectState, d: Detached): readonly string[] => derived(state, `collectionQuery:${d.key}`, (s) => queryEntries(s, d.q, d.here).map((e) => e.id), { opaque: true });

/** The IDs of the entries a query finds where it runs, in its order: the derived value a file depends on. */
export function queriedEntryIds(state: ProjectState, query: unknown, place: QueryPlace = {}): readonly string[] {
  const d = detached(query, place);
  return d ? idsOf(state, d) : [];
}

/** The entries a query finds where it runs, in its order, read from the state the file is made from. */
export function queriedEntries(state: ProjectState, query: unknown, place: QueryPlace = {}): EntryDoc[] {
  const d = detached(query, place);
  if (!d) return [];
  const ids = idsOf(state, d);
  if (!ids.length) return [];
  const collection = queryCollection(state, d.q, d.here);
  return collection ? ids.flatMap((id) => (Object.hasOwn(collection.entries, id) ? [collection.entries[id]] : [])) : [];
}
