/**
 * Collection queries in a generator run (#674): the entries a query finds, worked out once per state and named by the
 * query's key, so a file that lists them depends on which entries they are, not on every document the query looked
 * at. An edit that changes no query's result regenerates nothing that reads it.
 */
import type { EntryDoc, ProjectState } from "@shared/types";
import {
  collectionQueryKey,
  normalizeCollectionQuery,
  queryCollection,
  queryEntries,
  type QueryPlace,
} from "@shared/collection-query";
import { derived } from "./cache";

/** The IDs of the entries a query finds where it runs, in its order: the derived value a file depends on. */
export function queriedEntryIds(
  state: ProjectState,
  query: unknown,
  place: QueryPlace = {},
): readonly string[] {
  // The key and the work are made from one detached copy: a run keeps the first way it was given to work out a key,
  // so a query edited in place afterwards must not change what that way finds.
  const q = normalizeCollectionQuery(query);
  const key = q && collectionQueryKey(q, place);
  if (!q || key === null) return [];
  const here: QueryPlace = place.entry
    ? {
        entry: {
          collectionId: place.entry.collectionId,
          entryId: place.entry.entryId,
        },
      }
    : {};
  return derived(state, `collectionQuery:${key}`, (s) =>
    queryEntries(s, q, here).map((e) => e.id),
  );
}

/** The entries a query finds where it runs, in its order, read from the state the file is made from. */
export function queriedEntries(
  state: ProjectState,
  query: unknown,
  place: QueryPlace = {},
): EntryDoc[] {
  const ids = queriedEntryIds(state, query, place);
  if (!ids.length) return [];
  const q = normalizeCollectionQuery(query);
  const collection = q ? queryCollection(state, q, place) : undefined;
  return collection
    ? ids.flatMap((id) =>
        Object.hasOwn(collection.entries, id) ? [collection.entries[id]] : [],
      )
    : [];
}
