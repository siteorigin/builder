/**
 * What one batch of an AI run may change of a collection. The project refuses every collection change from an AI run,
 * its layouts included, unless the batch comes with one of these grants and is exactly the shape it allows:
 * - entry: the assistant's entry tool (upsert_collection_entry, #400): new terms of the collection, each one filed on
 *   the entry, then that one entry written.
 * - schema: its collection tool (define_collection, #679): one collection created, or one changed without losing a
 *   field, an option or a term it has.
 * - layout: a request sent while a collection's layout is open (#679): every operation changes that one layout.
 * The model never sets a grant: only the tool's own call, or the run's own authority, does, so a raw batch of
 * operations reaches no collection.
 */
import type { EditOperation } from './ops';
import type { Collection } from './types';
import { isSyncedCollection } from './collections';

/** A collection's layout as an owner of nodes: its entry pages' layout (template) or its index layout (archive). */
export interface LayoutOwner {
  kind: 'template' | 'archive';
  /** The collection's ID. */
  id: string;
}

export type CollectionWriteGrant =
  | {
      kind: 'entry';
      collectionId: string;
      /** The entry the call updates; absent when it creates one. */
      entryId?: string;
    }
  | { kind: 'schema'; collectionId: string; action: 'create' | 'update' }
  | { kind: 'layout'; owner: LayoutOwner };

/** Fields the entry tool never sends: a new address and an old one kept working reach the site's addresses. */
const NEVER_SENT = ['slug', 'redirectFrom', 'entryId'] as const;

/** Settings the collection tool never sends: a sync is detached, and a layout is edited, only by the author or in the layout itself. */
const NEVER_SET = ['sourceId', 'archiveTemplate'] as const;

/** How a synced collection's refusal is said, wherever it is met. */
export const syncedRefusal = (name: string) => `The ${name} collection is synced from an external source, so its entries and settings are read-only here. The author can detach it from its source in the editor to edit it.`;

type Collections = Record<string, Collection> | undefined;
const collectionIn = (collections: Collections, id: string) => (collections && Object.hasOwn(collections, id) ? collections[id] : undefined);

function entryRefusal(ops: readonly EditOperation[], grant: Extract<CollectionWriteGrant, { kind: 'entry' }>, collections: Collections): string | null {
  const write = ops.at(-1);
  const terms = ops.slice(0, -1);
  if (!write) return 'The entry tool sent nothing to change.';
  if (write.type !== 'entry.create' && write.type !== 'entry.update') return 'The entry tool may write only the one entry it was asked to.';
  if (grant.entryId === undefined ? write.type !== 'entry.create' : write.type !== 'entry.update' || write.entryId !== grant.entryId) return 'The entry tool may write only the one entry it was asked to.';
  if (write.collectionId !== grant.collectionId) return 'The entry tool may write only an entry of the collection it named.';
  const c = collectionIn(collections, grant.collectionId);
  if (c && isSyncedCollection(c.settings)) return syncedRefusal(c.settings.name);
  // An update names its entry, which the check above holds to the grant; nothing else of these is the tool's.
  if (NEVER_SENT.some((k) => k in write && (k !== 'entryId' || write.type === 'entry.create') && (write as Record<string, unknown>)[k] !== undefined)) return 'The entry tool never changes an entry’s address.';
  for (const op of terms) {
    if (op.type !== 'collection.createTerm' || op.collectionId !== grant.collectionId) return 'The entry tool may add only terms of the entry’s own collection.';
    // A term the entry is not filed under would be one the tool was never asked for.
    const filed = write.terms && Object.hasOwn(write.terms, op.taxonomyId) ? write.terms[op.taxonomyId] : [];
    if (op.termId === undefined || !Array.isArray(filed) || !filed.includes(op.termId)) return 'The entry tool adds a term only to file the entry under it.';
  }
  return null;
}

type SchemaOp = Extract<EditOperation, { type: 'collection.create' | 'collection.update' }>;

/** A value as text whatever order its keys were written in, so two field definitions compare by what they say. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

/**
 * What an update would lose or change of a collection's fields and groupings: each field it has stays as it is but for
 * its label and choices added after its own, and each grouping keeps every term it has, under the same name.
 */
function schemaLoss(op: SchemaOp, c: Collection): string | null {
  const name = c.settings.name;
  if (op.fields !== undefined) {
    const next = op.fields as Record<string, Record<string, unknown>>;
    for (const [field, was] of Object.entries(c.settings.fields ?? {})) {
      const now = Object.hasOwn(next, field) ? next[field] : undefined;
      if (!now) return `The collection tool never removes a field: ${name} would lose “${field}”.`;
      if (now.type !== was.type) return `The collection tool never changes a field’s type: “${field}” is ${was.type}.`;
      if (was.type === 'enum') {
        const options = Array.isArray(now.options) ? now.options : [];
        if (was.options.some((o, i) => canonical(o) !== canonical(options[i]))) return `The collection tool never removes or changes a choice of “${field}”, only adds them after its own.`;
      }
      const { label: _a, options: _b, ...rest } = now;
      const { label: _c, options: _d, ...before } = was as unknown as Record<string, unknown>;
      if (canonical(rest) !== canonical(before)) return `The collection tool changes no more of “${field}” than its label and new choices.`;
    }
  }
  if (op.taxonomies !== undefined) {
    const next = op.taxonomies;
    for (const [id, was] of Object.entries(c.settings.taxonomies ?? {})) {
      const now = Object.hasOwn(next, id) ? next[id] : undefined;
      if (!now) return `The collection tool never removes a grouping: ${name} would lose “${id}”.`;
      for (const [term, t] of Object.entries(was.terms ?? {})) {
        const kept = now.terms && Object.hasOwn(now.terms, term) ? now.terms[term] : undefined;
        if (!kept) return `The collection tool never removes a term: “${id}” would lose “${term}”.`;
        if (kept.label !== t.label) return `The collection tool never renames a term: “${term}” of “${id}” is “${t.label}”.`;
      }
    }
  }
  return null;
}

function schemaRefusal(ops: readonly EditOperation[], grant: Extract<CollectionWriteGrant, { kind: 'schema' }>, collections: Collections): string | null {
  const [op, ...rest] = ops;
  if (!op || rest.length || op.type !== (grant.action === 'create' ? 'collection.create' : 'collection.update') || op.collectionId !== grant.collectionId) return 'The collection tool may change only the one collection it was asked to.';
  if (NEVER_SET.some((k) => k in op && (op as Record<string, unknown>)[k] !== undefined)) return 'The collection tool never detaches a collection from its source, nor sets its index layout.';
  if (op.type === 'collection.create') return null;
  const c = collectionIn(collections, op.collectionId);
  if (!c) return null;
  if (isSyncedCollection(c.settings)) return syncedRefusal(c.settings.name);
  return schemaLoss(op, c);
}

/**
 * The operations a layout's run may send, each changing one node of the layout its `owner` names (an insertion adds one
 * there). Every other operation is refused, whatever its payload holds: a page's sharing image, a new component made
 * from a placement, the site's styles or another document are never a layout's to change.
 */
const LAYOUT_OPERATIONS = new Set<EditOperation['type']>([
  'node.insert',
  'node.remove',
  'node.removeKeepContent',
  'node.move',
  'node.wrap',
  'node.unwrap',
  'node.duplicate',
  'node.rename',
  'node.setStyle',
  'node.resetStyles',
  'node.setContent',
  'node.setBinding',
  'instance.setProp',
  'instance.setListSource',
  'node.setRepeatSource',
  'instance.listInsert',
  'instance.listRemove',
  'instance.listMove',
  'instance.editTable',
  'instance.setVariant',
  'instance.swapComponent'
]);

function layoutRefusal(ops: readonly EditOperation[], grant: Extract<CollectionWriteGrant, { kind: 'layout' }>): string | null {
  const where = grant.owner.kind === 'archive' ? 'index layout' : 'layout';
  for (const op of ops) {
    if (op.type.startsWith('collection.') || op.type.startsWith('entry.')) return `${op.type} changes the collection itself: this request may change only its ${where}.`;
    // Its own target, never anything else its payload happens to hold, decides whose node it changes.
    const owner = LAYOUT_OPERATIONS.has(op.type) ? (op as { owner?: { kind?: unknown; id?: unknown } }).owner : undefined;
    if (!owner || owner.kind !== grant.owner.kind || owner.id !== grant.owner.id) return `${op.type} changes something outside the ${where} this request may change.`;
  }
  return null;
}

/**
 * Why a batch is not what the grant allows, or null when it is. `collections`: the project's collections as the batch
 * finds them, which an entry or schema grant is checked against (a synced collection's are read-only, and an update
 * keeps every field, option and term).
 */
export function collectionGrantRefusal(ops: readonly EditOperation[], grant: CollectionWriteGrant, collections?: Collections): string | null {
  switch (grant.kind) {
    case 'entry':
      return entryRefusal(ops, grant, collections);
    case 'schema':
      return schemaRefusal(ops, grant, collections);
    case 'layout':
      return layoutRefusal(ops, grant);
  }
}
