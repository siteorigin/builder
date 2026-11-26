/**
 * External sources' settings (`siteorigin/sources/<id>/source.json`), changed only in the editor: what kind of source
 * each is, the collection its records are synced into, the secrets it signs in with (by name), and what a sync does
 * with an entry the source no longer has. A sync itself is no edit: it writes the collection's entries under a grant
 * only the main process gives (see `SourceSyncGrant`).
 */
import type { Diagnostic } from '@shared/api';
import type { EntryDoc, EntrySource, ProjectState, SourceDoc } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation, Op } from '@shared/ops';
import { isSourceId, sourceDocProblem } from '@shared/sources';
import { EngineError, fail } from './tree';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

export function sourceUpsert(state: ProjectState, op: Op<'source.upsert'>) {
  if (!isSourceId(op.sourceId)) fail(`"${String(op.sourceId).slice(0, 60)}" cannot be a source's ID: use lowercase letters, numbers and single hyphens.`);
  const was = own(state.sources, op.sourceId);
  const doc: SourceDoc = {
    schemaVersion: SCHEMA_VERSION,
    id: op.sourceId,
    name: op.name.trim(),
    adapter: op.adapter,
    collectionId: op.collectionId,
    config: op.credentials !== undefined ? (Object.keys(op.credentials).length ? { credentials: { ...op.credentials } } : {}) : (was?.config ?? {}),
    ...(op.removal !== undefined ? { removal: op.removal } : was?.removal !== undefined ? { removal: was.removal } : {})
  };
  const problem = sourceDocProblem(doc);
  if (problem) fail(`The source ${doc.name ? `“${doc.name}”` : op.sourceId} cannot be saved: ${problem}`);
  const target = own(state.collections, op.collectionId);
  if (!target) fail(`The collection "${op.collectionId.slice(0, 60)}" does not exist. Add it before a source syncs into it.`);
  // A collection is synced from one source only, so its entries' origin is never in doubt.
  const rival = Object.values(state.sources ?? {}).find((s) => s.id !== doc.id && s.collectionId === doc.collectionId);
  if (rival) fail(`The ${target!.settings.name} collection is already synced from “${rival.name}”. Choose another collection.`);
  // Entries already synced say where they came from: moving their source elsewhere would leave them claimed by nothing.
  if (was && was.collectionId !== doc.collectionId && own(state.collections, was.collectionId)?.settings.sourceId === was.id)
    fail(`“${was.name}” is synced into the ${state.collections[was.collectionId].settings.name} collection. Detach that collection from it before choosing another.`);
  state.sources = { ...(state.sources ?? {}), [doc.id]: doc };
  return { sourceId: doc.id };
}

export function sourceRemove(state: ProjectState, op: Op<'source.remove'>) {
  const was = own(state.sources, op.sourceId) ?? fail(`There is no source "${op.sourceId.slice(0, 60)}".`);
  const attached = Object.values(state.collections ?? {}).find((c) => c.settings.sourceId === was.id);
  if (attached) fail(`The ${attached.settings.name} collection is synced from “${was.name}”. Detach it from the source first, keeping its entries as local ones.`);
  const rest = { ...state.sources };
  delete rest[was.id];
  if (Object.keys(rest).length) state.sources = rest;
  else delete state.sources;
  return { sourceId: was.id };
}

/**
 * What is wrong with the project's sources, as hand edits leave them: settings no source can have, a collection that is
 * not there, two sources for one collection, or a collection synced from a source the project has no settings for.
 */
export function sourceDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const claimed = new Map<string, string>();
  for (const [id, s] of Object.entries(state.sources ?? {})) {
    const owner = { kind: 'source', id };
    const problem = sourceDocProblem(s, id);
    if (problem) {
      out.push({ severity: 'error', code: 'SOURCE_INVALID', message: `The source ${id}: ${problem}`, owner });
      continue;
    }
    const target = own(state.collections, s.collectionId);
    if (!target) out.push({ severity: 'error', code: 'SOURCE_TARGET_MISSING', message: `The source “${s.name}” syncs into a collection that no longer exists.`, owner });
    else if (claimed.has(s.collectionId))
      out.push({ severity: 'error', code: 'SOURCE_TARGET_SHARED', message: `“${s.name}” and “${claimed.get(s.collectionId)}” both sync into the ${target.settings.name} collection.`, owner });
    claimed.set(s.collectionId, s.name);
  }
  for (const c of Object.values(state.collections ?? {})) {
    const sid = c.settings?.sourceId;
    if (typeof sid !== 'string') continue;
    const s = own(state.sources, sid);
    if (!s || s.collectionId !== c.settings.id)
      out.push({ severity: 'error', code: 'SOURCE_ATTACHMENT', message: `The ${c.settings.name} collection is synced from a source the project has no settings for. Detach it to edit its entries here.`, owner: { kind: 'collection', id: c.settings.id } });
  }
  return out;
}

/**
 * What a sync may write, given only by the main process's sync of source `sourceId` (never an edit, never the
 * assistant, never the renderer): the entries of collection `collectionId`, each one it writes taking `provenance`'s
 * record of where it came from. The collection is attached to the source as the batch ends.
 */
export interface SourceSyncGrant {
  sourceId: string;
  collectionId: string;
  /** Where each entry the batch writes came from, by entry ID. */
  provenance: Record<string, EntrySource>;
}

/** Why a sync's batch asks for more than its grant allows, or null: library images, and its own collection's entries. */
export function sourceSyncRefusal(ops: readonly EditOperation[], grant: SourceSyncGrant): string | null {
  for (const op of ops) {
    if (op.type === 'asset.add') {
      if (op.asset.kind !== 'image') return 'A sync adds only pictures to the library.';
      continue;
    }
    if (op.type !== 'entry.create' && op.type !== 'entry.update' && op.type !== 'entry.remove') return `A sync cannot ${op.type}.`;
    if (op.collectionId !== grant.collectionId) return 'A sync writes only the collection its source syncs into.';
    if (op.type === 'entry.create' && (op.entryId === undefined || !Object.hasOwn(grant.provenance, op.entryId))) return 'A sync names every entry it adds, and where it came from.';
    // Nothing outside its collection: no link elsewhere pointed at another entry, no old address claimed.
    if (op.type === 'entry.create' && op.redirectFrom !== undefined) return 'A sync keeps no old address for an entry.';
    if (op.type === 'entry.remove' && (op.replacementEntryId !== undefined || op.replacementPageId !== undefined)) return 'A sync points no link elsewhere.';
  }
  return null;
}

/**
 * The end of a sync's batch: its collection is attached to the source (refused when another source holds it, or local
 * entries it never synced are there), and each entry the sync wrote says where it came from.
 */
export function finishSourceSync(state: ProjectState, grant: SourceSyncGrant, before: ProjectState) {
  // Every entry it had is the source's, as the batch found them: a local one would be edited by nobody once the
  // collection is read-only, and removing or stamping it within the batch makes it no less the author's.
  const had = own(before.collections, grant.collectionId);
  const local = Object.values(had?.entries ?? {}).find((e) => e.source?.sourceId !== grant.sourceId);
  if (local) fail(`“${local.title}” in ${had!.settings.name} was not synced from this source. Sync into an empty collection, or one already synced from it.`);
  const source = own(state.sources, grant.sourceId);
  if (!source || source.collectionId !== grant.collectionId) throw new EngineError('VALIDATION_FAILED', 'The source changed while it was being synced. Sync it again.');
  const c = own(state.collections, grant.collectionId) ?? fail(`The collection "${grant.collectionId}" does not exist.`);
  if (c.settings.sourceId !== undefined && c.settings.sourceId !== grant.sourceId) fail(`The ${c.settings.name} collection is synced from another source.`);
  c.settings.sourceId = grant.sourceId;
  for (const [id, prov] of Object.entries(grant.provenance)) {
    const entry = own(c.entries, id);
    if (entry) entry.source = { ...prov };
  }
  const foreign = Object.values(c.entries).find((e) => e.source?.sourceId !== grant.sourceId);
  if (foreign) fail(`“${foreign.title}” in ${c.settings.name} was not synced from “${source.name}”. Sync into an empty collection, or one already synced from it.`);
}

/** What an entry depends on, anywhere in it: the library images it shows and the entries and pages it links or refers to. */
function entryNeeds(e: EntryDoc, refs: readonly string[]): { assets: Set<string>; entries: Set<string>; pages: Set<string> } {
  const out = { assets: new Set<string>(), entries: new Set<string>(), pages: new Set<string>() };
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key === 'assetId' || key === 'featuredImage' || key === 'socialImage') out.assets.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x));
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    // A link: { type, target }.
    if (typeof o.target === 'string' && (o.type === 'entry' || o.type === 'page')) (o.type === 'entry' ? out.entries : out.pages).add(o.target);
    for (const [k, x] of Object.entries(o)) walk(x, k);
  };
  walk(e);
  for (const f of refs) for (const id of [e.values?.[f]].flat()) if (typeof id === 'string' && id) out.entries.add(id);
  return out;
}

/**
 * Why going from `before` to `after` takes away something a synced collection's entry depends on, or null: a library
 * image it shows, an entry or a page it links or refers to. A sync is no step of History, so an undo of an earlier
 * step (the import of a picture a sync then found in the library, the entry a synced record refers to) could otherwise
 * take it from an entry no edit may change. Worded to follow "it".
 */
export function syncedDependencyLoss(before: ProjectState, after: ProjectState): string | null {
  const entryIds = (s: ProjectState) => new Set(Object.values(s.collections ?? {}).flatMap((c) => Object.keys(c.entries)));
  const [had, has] = [entryIds(before), entryIds(after)];
  for (const c of Object.values(after.collections ?? {})) {
    if (typeof c?.settings?.sourceId !== 'string') continue;
    const refs = Object.entries(c.settings.fields ?? {}).flatMap(([name, f]) => (f?.type === 'reference' ? [name] : []));
    for (const e of Object.values(c.entries)) {
      const needs = entryNeeds(e, refs);
      const where = `“${e.title}” in the ${c.settings.name} collection`;
      const why = ' That collection is synced from an external source, so its entries are read-only here.';
      const asset = [...needs.assets].find((id) => Object.hasOwn(before.assets.assets, id) && !Object.hasOwn(after.assets.assets, id));
      if (asset) return `would take “${before.assets.assets[asset].name}” from the library, which ${where} shows.${why}`;
      if ([...needs.entries].some((id) => had.has(id) && !has.has(id))) return `would remove an entry ${where} refers to.${why}`;
      if ([...needs.pages].some((id) => Object.hasOwn(before.pages, id) && !Object.hasOwn(after.pages, id))) return `would remove a page ${where} links to.${why}`;
    }
  }
  return null;
}

/**
 * Why going from `before` to `after` leaves the project's sources inconsistent in a way they were not (a collection
 * synced from a source that is gone, two sources for one collection), or null. Worded to follow "it".
 */
export function sourceIntegrityChange(before: ProjectState, after: ProjectState): string | null {
  const was = new Set(sourceDiagnostics(before).map((d) => `${d.code}|${d.owner?.kind}:${d.owner?.id}`));
  const now = sourceDiagnostics(after).find((d) => !was.has(`${d.code}|${d.owner?.kind}:${d.owner?.id}`));
  return now ? `would leave the project's sources inconsistent: ${now.message}` : null;
}
