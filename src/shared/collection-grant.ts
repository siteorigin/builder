/**
 * What one call of the assistant's post tool (upsert_collection_entry, #400) may write. The project refuses every
 * collection change from an AI run, its layouts included, unless the batch comes with this grant and is exactly the
 * shape that tool builds: new categories of the collection, each one filed on the entry, then that one entry written.
 * The model never sets a grant: only the tool's own call does, so a raw batch of operations reaches no collection.
 */
import type { EditOperation } from './ops';

export interface CollectionWriteGrant {
  collectionId: string;
  /** The entry the call updates; absent when it creates one. */
  entryId?: string;
}

/** Why a batch is not what the grant allows, or null when it is. */
export function collectionGrantRefusal(ops: readonly EditOperation[], grant: CollectionWriteGrant): string | null {
  const write = ops.at(-1);
  const terms = ops.slice(0, -1);
  if (!write) return 'The post tool sent nothing to change.';
  if (grant.entryId === undefined ? write.type !== 'entry.create' : write.type !== 'entry.update' || write.entryId !== grant.entryId) return 'The post tool may write only the one post it was asked to.';
  if (write.collectionId !== grant.collectionId) return 'The post tool may write only a post of the collection it named.';
  const filed = new Set(write.terms?.categories ?? []);
  for (const op of terms) {
    if (op.type !== 'collection.createTerm' || op.collectionId !== grant.collectionId || op.taxonomyId !== 'categories') return 'The post tool may add only categories of the post’s own collection.';
    // A category the post is not filed under would be one the tool was never asked for.
    if (op.termId === undefined || !filed.has(op.termId)) return 'The post tool adds a category only to file the post under it.';
  }
  return null;
}
