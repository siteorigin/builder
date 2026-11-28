/**
 * Reconciling a source's records with the entries of the collection they are synced into, written nowhere: each
 * record is matched to the entry that says it came from it (its `source.externalId`), so an entry keeps its `en_` ID,
 * and with it every link to it, across syncs. A record whose content hash is the one its entry was last written from
 * is left alone, its file untouched. An entry whose record the source no longer has is drafted (saved links to it keep
 * their target in the project; the website leaves the draft out), deleted, or kept, as the source says.
 */
import { createHash } from 'node:crypto';
import type { Collection, EntrySource, ProjectState, SourceDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { findEntry } from '@shared/collections';
import { sourceRemoval } from '@shared/sources';
import { TEXT_LIMITS } from '@shared/text-limits';
import { recordHash } from './hash';
import { oneLine } from './mapping';
import { imageKey, isImageRef, recordImages, TEXT_IMAGE, textImages, type NormalizedRecord, type SourceImage } from './protocol';

export class SyncPlanError extends Error {}

export interface PlannedEntry {
  entryId: string;
  record: NormalizedRecord;
  hash: string;
}

export interface SyncPlan {
  sourceId: string;
  collectionId: string;
  /** Whether the sync attaches the collection to the source (its first sync). */
  attach: boolean;
  creates: PlannedEntry[];
  updates: PlannedEntry[];
  /** Records that are back as they were, whose entries an earlier sync drafted when the source lacked them. */
  republish: PlannedEntry[];
  /** Entries drafted, or deleted, because the source no longer has their records. */
  unpublish: string[];
  remove: string[];
  /** Records unchanged since they were last synced, and entries kept although their records are gone. */
  unchanged: number;
  kept: number;
  /** The pictures the new and changed records show, by identity. */
  images: Map<string, SourceImage>;
  /** Where each entry the sync writes came from, by entry ID. */
  provenance: Record<string, EntrySource>;
}

/** Whether the plan changes nothing at all. */
export const planIsEmpty = (p: SyncPlan) => !p.attach && !p.creates.length && !p.updates.length && !p.republish.length && !p.unpublish.length && !p.remove.length;

/**
 * A new entry's ID for a record: the same for the same source and record every time (so two syncs of one source plan
 * the same), numbered past any the project already has.
 */
export function syncedEntryId(sourceId: string, externalId: string, taken: (id: string) => boolean): string {
  for (let n = 0; ; n++) {
    const id = `en_${createHash('sha256').update(JSON.stringify([sourceId, externalId, n])).digest('hex').slice(0, 16)}`;
    if (!taken(id)) return id;
  }
}

/** The entries of collection `c` synced from source `sourceId`, by external ID. Refused when two say they are one record, or one is not the source's. */
function syncedIndex(c: Collection, source: SourceDoc): Map<string, string> {
  const index = new Map<string, string>();
  for (const e of Object.values(c.entries).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const src = e.source;
    if (!src || src.sourceId !== source.id || typeof src.externalId !== 'string')
      throw new SyncPlanError(`“${e.title}” in ${c.settings.name} was not synced from “${source.name}”, so the collection cannot be synced. Sync into an empty collection instead.`);
    if (index.has(src.externalId)) throw new SyncPlanError(`Two entries of ${c.settings.name} say they come from the same record of “${source.name}”. Detach the collection, or delete one of them.`);
    index.set(src.externalId, e.id);
  }
  return index;
}

/**
 * What a sync of `source` would do with `records`, the whole of what it has, at `syncedAt` (ISO 8601). Refuses
 * (SyncPlanError) a collection that is not there, is synced from another source, or holds entries the source never
 * wrote: the first sync attaches only an empty collection.
 */
export function planSourceSync(state: ProjectState, source: SourceDoc, records: readonly NormalizedRecord[], syncedAt: string): SyncPlan {
  const c = Object.hasOwn(state.collections ?? {}, source.collectionId) ? state.collections[source.collectionId] : undefined;
  if (!c) throw new SyncPlanError(`“${source.name}” syncs into a collection that does not exist. Add the collection first.`);
  const attached = c.settings.sourceId === source.id;
  if (c.settings.sourceId !== undefined && !attached) throw new SyncPlanError(`The ${c.settings.name} collection is synced from another source.`);
  if (!attached && Object.keys(c.entries).length) throw new SyncPlanError(`The ${c.settings.name} collection has entries of its own, so “${source.name}” cannot sync into it. Choose an empty collection.`);
  // A collection is synced from one source, and a source into one collection: an attachment left inconsistent (a hand
  // edit) would otherwise let this sync claim a second collection, or two sources one.
  const other = Object.values(state.collections ?? {}).find((x) => x.settings.id !== c.settings.id && x.settings.sourceId === source.id);
  if (other) throw new SyncPlanError(`The ${other.settings.name} collection is synced from “${source.name}” too. Detach it before syncing.`);
  const rival = Object.values(state.sources ?? {}).find((s) => s.id !== source.id && s.collectionId === source.collectionId);
  if (rival) throw new SyncPlanError(`“${rival.name}” syncs into the ${c.settings.name} collection too. Remove one of them before syncing.`);
  const index = syncedIndex(c, source);
  const plan: SyncPlan = { sourceId: source.id, collectionId: c.settings.id, attach: !attached, creates: [], updates: [], republish: [], unpublish: [], remove: [], unchanged: 0, kept: 0, images: new Map(), provenance: {} };
  const planned = new Set<string>();
  const seen = new Set<string>();
  const stamp = (entryId: string, externalId: string, hash: string) => (plan.provenance[entryId] = { sourceId: source.id, externalId, syncedAt, contentHash: hash });
  // In the same order whatever order the source lists them in, so the same records always plan the same.
  for (const r of [...records].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0))) {
    if (seen.has(r.externalId)) throw new SyncPlanError(`“${source.name}” sent two records with the same ID.`);
    seen.add(r.externalId);
    const hash = recordHash(r);
    const entryId = index.get(r.externalId);
    if (entryId === undefined) {
      const id = syncedEntryId(source.id, r.externalId, (x) => planned.has(x) || !!findEntry(state, x));
      planned.add(id);
      plan.creates.push({ entryId: id, record: r, hash });
      stamp(id, r.externalId, hash);
      for (const img of recordImages(r)) plan.images.set(imageKey(img), img);
      continue;
    }
    const entry = c.entries[entryId];
    if (entry.source!.contentHash === hash) {
      // Back as it was when last written: only what an earlier sync did to it for its absence is undone.
      if (entry.draft === (r.draft === true)) plan.unchanged++;
      else {
        plan.republish.push({ entryId, record: r, hash });
        stamp(entryId, r.externalId, hash);
      }
      continue;
    }
    plan.updates.push({ entryId, record: r, hash });
    stamp(entryId, r.externalId, hash);
    for (const img of recordImages(r)) plan.images.set(imageKey(img), img);
  }
  const removal = sourceRemoval(source);
  for (const [externalId, entryId] of [...index].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (seen.has(externalId)) continue;
    if (removal === 'keep') plan.kept++;
    else if (removal === 'remove') plan.remove.push(entryId);
    // Drafted once: an entry already a draft is left as it is, its file untouched.
    else if (c.entries[entryId].draft) plan.kept++;
    else plan.unpublish.push(entryId);
  }
  return plan;
}

/**
 * The operations that carry out `plan` in the project as it is in `state`, with each picture as the library image
 * `assetIds` gives for its identity. A sync writes a record whole: every detail it leaves out is cleared on its entry,
 * except its address and date, which a new entry is given and an entry keeps. Removals come last, once every surviving
 * entry says what it now says.
 */
export function syncOperations(plan: SyncPlan, state: ProjectState, assetIds: ReadonlyMap<string, string>): EditOperation[] {
  const c = state.collections[plan.collectionId];
  const asset = (img: SourceImage) => {
    const id = assetIds.get(imageKey(img));
    if (!id) throw new SyncPlanError('A picture of the source was not brought into the library.');
    return id;
  };
  // A picture in text, given the library image its address brought in.
  const text = (blocks: unknown) =>
    Array.isArray(blocks)
      ? blocks.map((b: { type?: unknown; assetId?: unknown; alt?: unknown }) =>
          b && b.type === 'image' && typeof b.assetId === 'string' && b.assetId.startsWith(TEXT_IMAGE) ? { ...b, assetId: asset(textImages([b])[0] ?? { url: '' }) } : b
        )
      : blocks;
  const fields = (r: NormalizedRecord) => {
    // Own keys whatever they are named, so a record's "__proto__" reaches the engine, which refuses it, rather than nothing.
    const terms = Object.fromEntries([...Object.keys(c.settings.taxonomies ?? {}).map((tax): [string, string[]] => [tax, []]), ...Object.entries(r.terms ?? {}).map(([tax, ids]): [string, string[]] => [tax, [...ids]])]);
    const values = Object.fromEntries([
      ...Object.keys(c.settings.fields ?? {}).map((name): [string, unknown] => [name, null]),
      ...Object.entries(r.values ?? {}).map(([name, v]): [string, unknown] => [name, isImageRef(v) ? { assetId: asset(v.$image), alt: v.$image.alt ?? '' } : text(v)])
    ]);
    return {
      title: r.title,
      ...(r.slug !== undefined ? { slug: r.slug } : {}),
      ...(r.publishedAt !== undefined ? { publishedAt: r.publishedAt } : {}),
      updatedAt: r.updatedAt ?? null,
      draft: r.draft === true,
      author: r.author ?? null,
      excerpt: r.excerpt ?? null,
      featuredImage: r.featuredImage ? asset(r.featuredImage.$image) : null,
      // The record's own words for its picture, from the record and never the picture's (two records may show one file
      // and say different things of it); none clears yesterday's, the file unchanged. One line within the limit,
      // whatever a converter gave.
      featuredImageAlt: r.featuredImage?.$image.alt?.trim() ? oneLine(r.featuredImage.$image.alt, TEXT_LIMITS.imageAlt) : null,
      terms,
      values,
      body: text(r.body ?? [])
    };
  };
  const ops: EditOperation[] = [];
  const collectionId = plan.collectionId;
  // Surviving entries first, so a link one no longer holds never stops a removal; new entries last, so an address a
  // removed one gave up is free for them.
  for (const p of plan.updates) ops.push({ type: 'entry.update', collectionId, entryId: p.entryId, ...fields(p.record) } as EditOperation);
  for (const p of plan.republish) ops.push({ type: 'entry.update', collectionId, entryId: p.entryId, draft: p.record.draft === true });
  for (const id of plan.unpublish) ops.push({ type: 'entry.update', collectionId, entryId: id, draft: true });
  for (const id of plan.remove) ops.push({ type: 'entry.remove', collectionId, entryId: id });
  for (const p of plan.creates) ops.push({ type: 'entry.create', collectionId, entryId: p.entryId, ...fields(p.record) } as EditOperation);
  return ops;
}

/** The content hash each record had when last synced into the collection, by external ID: the worker fetches no picture of one unchanged. */
export function knownHashes(state: ProjectState, source: SourceDoc): Record<string, string> {
  const c = Object.hasOwn(state.collections ?? {}, source.collectionId) ? state.collections[source.collectionId] : undefined;
  if (c?.settings.sourceId !== source.id) return {};
  const known = new Map<string, string>();
  for (const e of Object.values(c.entries)) if (e.source?.sourceId === source.id && typeof e.source.externalId === 'string' && !known.has(e.source.externalId)) known.set(e.source.externalId, e.source.contentHash);
  // Own keys whatever they are named ("__proto__" included).
  return Object.fromEntries(known);
}
