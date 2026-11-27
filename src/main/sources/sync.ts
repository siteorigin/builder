/**
 * Syncing an external source into its collection: the sync worker reads every record (signed in with the secrets the
 * source names, sent to it and nowhere else), the records are reconciled with the collection's entries, their new
 * pictures become library images (checked, with their responsive copies), and the result lands as one change made
 * against the very revision of the project the sync began from, or nothing does. A sync is no step of History: the
 * source is where its entries change, and undoing one would only be put back by the next.
 */
import type { AssetRecord, ProjectState, SourceDoc } from '@shared/types';
import type { SourceSampleResult, SourceSettingsDraft, SourceSyncResult } from '@shared/api';
import { converterProblems, converterProblemText } from './converter';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { validateOperation, type ApplyResult, type EditOperation } from '@shared/ops';
import { randomBytes } from 'node:crypto';
import { holdsSecretValue, MIN_SECRET_LENGTH, sourceSecretNames } from '@shared/sources';
import type { SourceSyncGrant } from '@engine/sources';
import { SyncError, syncFailureMessage, type SyncRunner } from './client';
import type { SecretStore } from './secrets';
import type { ApprovalStore } from './approvals';
import { SAMPLE_SIZE, type FieldKinds, type NormalizedRecord } from './protocol';
import { openSpool, type Spool } from './spool';
import { knownHashes, planIsEmpty, planSourceSync, SyncPlanError, syncOperations, type SyncPlan } from './reconcile';
import { redactSecrets } from './redact';
import { pngTextValues } from '../project/photo-metadata';

/** The project session as a sync uses it. */
export interface SyncSession {
  readonly state: ProjectState;
  readonly revision: number;
  apply(batch: { operations: EditOperation[]; expectedRevision?: number }, opts: { label: string; source: 'system'; history: false; sourceSync: SourceSyncGrant; stillWanted: () => boolean }): Promise<ApplyResult>;
  /** Run `fn` while the session holds off sweeping files no record names (pictures written before their records). */
  withImport<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SyncDeps {
  session: SyncSession;
  runner: SyncRunner;
  secrets: SecretStore;
  /** The settings the user approved (by saving them here) to sign in with their secrets. */
  approvals: Pick<ApprovalStore, 'approved'>;
  /** Bring a fetched picture into the library: its record, and whether the library had it already (the same bytes). */
  importImage(image: { name: string; mime: string; ext: string; bytes: Buffer }, known: AssetRecord[], createdAt: string): Promise<{ record: AssetRecord; existing: boolean }>;
  /** Where a sync's pictures wait, each in a file, between the worker fetching them and the library taking them (spool.ts). */
  spoolRoot: string;
  /** Whether the project the sync began in is still the one open, and wanted. */
  current(): boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export type { SourceSampleResult, SourceSyncResult } from '@shared/api';

const counts = (p: SyncPlan, revision: number, images: number): SourceSyncResult => ({
  ok: true,
  revision,
  created: p.creates.length,
  updated: p.updates.length + p.republish.length,
  unchanged: p.unchanged,
  unpublished: p.unpublish.length,
  removed: p.remove.length,
  kept: p.kept,
  images
});

/** Every piece of text what a source sent holds, one to a line, the names of its details too (a token echoed as a key). */
function textOf(v: unknown): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out.push(String(x));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object')
      for (const [k, y] of Object.entries(x)) {
        out.push(k);
        walk(y);
      }
  };
  walk(v);
  return out.join('\n');
}

/** Text as an address or a file name made from it reads: accents taken off, lowercased, and words joined by hyphens. */
const folded = (t: string) => t.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const slugged = (t: string) => folded(t).replace(/[^\p{L}\p{N}]+/gu, '-');

/**
 * Whether `text` holds a secret, as written or as the slug or file name the engine or the library would make of it:
 * a title "Éxample Token" becomes the address example-token.
 */
export function holdsSecret(text: string, values: readonly string[]): boolean {
  const long = values.filter((v) => v.length >= MIN_SECRET_LENGTH);
  return holdsSecretValue(text, long) || holdsSecretValue(folded(text), long.map(folded)) || holdsSecretValue(slugged(text), long.map(slugged).filter((v) => v.replace(/-/g, '').length >= MIN_SECRET_LENGTH));
}

/**
 * Whether a picture's bytes hold one of `values`: as they are, and in its PNG text chunks, compressed ones included
 * (a PNG whose text cannot all be read counts as one that does). The library keeps a picture's bytes as they are, so
 * none may carry a secret.
 */
export function pictureHoldsSecret(bytes: Buffer, values: readonly string[]): boolean {
  if (values.some((v) => v.length >= MIN_SECRET_LENGTH && bytes.includes(v))) return true;
  const text = pngTextValues(bytes);
  return text === null || holdsSecret(text.join('\n'), values);
}

/** What to call a picture in the library: the name the source gives it, or its file's name. */
export function pictureName(given: string | undefined, url: string): string {
  let file = '';
  try {
    file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    // An address that cannot be read names nothing.
  }
  return (given ?? file.replace(/\.[A-Za-z0-9]+$/, '')).replace(/[-_]+/g, ' ').trim().slice(0, 80) || 'Image';
}

/** The kinds of value the collection's custom fields hold, by name: how a mapping reads a record's values. */
export function fieldKinds(state: ProjectState, collectionId: string): FieldKinds {
  const c = Object.hasOwn(state.collections ?? {}, collectionId) ? state.collections[collectionId] : undefined;
  return Object.fromEntries(Object.entries(c?.settings.fields ?? {}).map(([k, f]) => [k, f.type]));
}

/** What the worker is asked for a source: its kind, settings, how its records are put in shape, and its collection's fields. */
export function sourceRequest(state: ProjectState, source: SourceDoc) {
  return {
    adapter: source.adapter,
    config: source.config,
    ...(source.mapping ? { mapping: source.mapping } : {}),
    ...(typeof source.converter?.code === 'string' ? { converter: source.converter.code } : {}),
    fields: fieldKinds(state, source.collectionId)
  };
}

/**
 * Why `records` cannot be written into the project as a sync of `source` would write them, or null: planned, given a
 * library image for every picture they show, and applied to a copy of the project with the sync's own grant, then
 * checked as a saved change is. Nothing is fetched or written: what a picture is never stops a sync here.
 */
export function syncPreflight(state: ProjectState, source: SourceDoc, records: readonly NormalizedRecord[], syncedAt: string, values: readonly string[] = []): string | null {
  let plan: SyncPlan;
  try {
    plan = planSourceSync(state, source, records, syncedAt);
  } catch (e) {
    if (e instanceof SyncPlanError) return e.message;
    throw e;
  }
  const copy = structuredClone(state);
  const assetIds = new Map<string, string>();
  // Named so no record could name one itself: a record's own reference to a library image is checked as it is.
  const tag = randomBytes(8).toString('hex');
  let n = 0;
  for (const key of plan.images.keys()) {
    const id = `preflight_${tag}_${++n}`;
    copy.assets.assets[id] = { id, name: 'Picture', file: `static/assets/${id}.png`, mime: 'image/png', bytes: 1, width: 1, height: 1, hash: id, kind: 'image', createdAt: syncedAt };
    assetIds.set(key, id);
  }
  let next: ProjectState;
  try {
    const ops = syncOperations(plan, copy, assetIds);
    // Each checked as the session checks every operation it is given, before the engine.
    for (const op of ops) {
      const checked = validateOperation(op);
      if (!checked.ok) return `a record cannot be written as an entry: ${checked.message}`;
    }
    next = applyOperations(copy, ops, { sourceSync: { sourceId: source.id, collectionId: plan.collectionId, provenance: plan.provenance } }).state;
  } catch (e) {
    if (e instanceof SyncPlanError || e instanceof EngineError) return (e as Error).message.replace(/^Operation \d+ \([\w.]+\): /, '');
    throw e;
  }
  const saving = (st: ProjectState) => validateState(st, { sectionLinks: false }).filter(blocksSaving);
  const introduced = introducedDiagnostics(saving(copy), saving(next));
  if (introduced.length) return introduced.map((d) => d.message).join(' ');
  // The entries as they would be written, text runs joined and all: no secret is ever put together from its parts.
  const written = Object.hasOwn(next.collections, plan.collectionId) ? next.collections[plan.collectionId].entries : {};
  if (holdsSecret(textOf(written), values)) return SECRET_IN_RECORDS;
  return null;
}

/** Why a sync wrote nothing when what a source sent holds one of the user's secrets. */
export const SECRET_IN_RECORDS = 'what it sent holds one of your secrets, which is never written into the project';

/** Why a source whose settings name a converter cannot be read without it, or null. */
function converterMissing(source: SourceDoc): string | null {
  return source.converter && typeof source.converter.code !== 'string' ? `“${source.name}” is read by its ${source.converter.file}, which is missing. Put it back, or choose where its details are read from instead.` : null;
}


/**
 * Test source settings `source` (as they would be saved, in the project `state` with them in it) against what the
 * source has now: every record is read and put in shape, as a sync does, and checked as a sync would write it into
 * its collection. Nothing is written and no picture fetched. The records are shown only once nothing in them is one of
 * the user's secrets.
 */
export async function sampleSource(deps: Pick<SyncDeps, 'runner' | 'secrets' | 'signal' | 'now'>, state: ProjectState, source: SourceDoc, opts: { offline?: boolean } = {}): Promise<SourceSampleResult> {
  const missing = converterMissing(source);
  if (missing) return { ok: false, code: 'converter', message: missing };
  const projectId = state.manifest.projectId;
  let secrets: Record<string, string>;
  let values: string[];
  try {
    secrets = await deps.secrets.resolve(projectId, sourceSecretNames(source));
    values = [...new Set([...Object.values(secrets), ...(await deps.secrets.values(projectId))])];
  } catch (e) {
    return { ok: false, code: 'secrets', message: syncFailureMessage(source.name, 'failed', (e as Error).message.replace(/\.$/, '')).replace('was not synced', 'could not be tested') };
  }
  let result;
  try {
    result = await deps.runner.run(source.name, { ...sourceRequest(state, source), mode: 'sample', secrets, known: {}, ...(opts.offline ? { offline: true } : {}) }, { signal: deps.signal, timeoutMs: SAMPLE_TIMEOUT_MS });
  } catch (e) {
    const message = e instanceof SyncError ? redactSecrets(e.message, values) : syncFailureMessage(source.name, 'failed');
    return { ok: false, ...(e instanceof SyncError ? { code: e.code } : {}), message: message.replace('was not synced', 'could not be tested') };
  }
  if (holdsSecret(textOf(result.records), values) || holdsSecret(textOf(result.raw ?? []), values))
    return { ok: false, code: 'secret', message: `“${source.name}” could not be tested: what it sent holds one of your secrets, which is never shown or written into the project.` };
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const problem = syncPreflight(state, source, result.records, now, values);
  if (problem === SECRET_IN_RECORDS) return { ok: false, code: 'secret', message: `“${source.name}” could not be tested: ${SECRET_IN_RECORDS}.` };
  if (problem) return { ok: false, code: 'invalid', message: `“${source.name}” could not be synced as it is: ${redactSecrets(problem, values)}` };
  const plan = planSourceSync(state, source, result.records, now);
  const c = counts(plan, 0, 0) as Extract<SourceSyncResult, { ok: true }>;
  return { ok: true, raw: result.raw ?? [], records: result.records.slice(0, SAMPLE_SIZE), total: result.records.length, created: c.created, updated: c.updated, unchanged: c.unchanged, unpublished: c.unpublished, removed: c.removed, kept: c.kept };
}

/**
 * Whether `source`'s settings may sign in with the user's secrets: they name none, or the user approved them as they
 * are, by saving them here. Settings changed outside the app (a collaborator's commit pointing them elsewhere) are not.
 */
export async function signInApproved(approvals: Pick<ApprovalStore, 'approved'>, projectId: string, source: SourceDoc): Promise<boolean> {
  if (!sourceSecretNames(source).length) return true;
  try {
    return await approvals.approved(projectId, source);
  } catch {
    return false;
  }
}

/** Why a source whose settings were changed outside the app does not sign in with the user's secrets. */
export const unapprovedMessage = (source: SourceDoc) =>
  `“${source.name}” was changed outside SiteOrigin Builder since it was last saved here, so it does not sign in with your secrets. Open its settings, test them and save them again.`;

/** What a source has, as its kind of source reads it, before any mapping or converter puts it in shape. */
export type SourceInspection = { ok: true; raw: unknown[]; total: number } | { ok: false; code?: string; message: string };

/**
 * The first few records source `sourceId` of the project `state` has, exactly as its kind of source reads them (links
 * resolved, the list found in the reply), and how many it has (#680): what the assistant reads to write its mapping or
 * converter, which are not run. Its saved settings are read as they are, signed in only when the user approved them.
 * Nothing is written and no picture fetched, and nothing comes back that holds one of the user's secrets.
 */
export async function inspectSource(deps: Pick<SyncDeps, 'runner' | 'secrets' | 'approvals' | 'signal'>, state: ProjectState, source: SourceDoc): Promise<SourceInspection> {
  const projectId = state.manifest.projectId;
  const refused = (message: string) => message.replace('was not synced', 'could not be read');
  if (!(await signInApproved(deps.approvals, projectId, source))) return { ok: false, code: 'unapproved', message: unapprovedMessage(source) };
  let secrets: Record<string, string>;
  let values: string[];
  try {
    secrets = await deps.secrets.resolve(projectId, sourceSecretNames(source));
    values = [...new Set([...Object.values(secrets), ...(await deps.secrets.values(projectId))])];
  } catch (e) {
    return { ok: false, code: 'secrets', message: refused(syncFailureMessage(source.name, 'failed', (e as Error).message.replace(/\.$/, ''))) };
  }
  let result;
  try {
    result = await deps.runner.run(source.name, { adapter: source.adapter, config: source.config, fields: fieldKinds(state, source.collectionId), mode: 'inspect', secrets, known: {} }, { signal: deps.signal, timeoutMs: SAMPLE_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, ...(e instanceof SyncError ? { code: e.code } : {}), message: refused(e instanceof SyncError ? redactSecrets(e.message, values) : syncFailureMessage(source.name, 'failed')) };
  }
  // Only what is shown goes anywhere, and none of it may hold a secret (a server echoing its token).
  if (holdsSecret(textOf(result.raw ?? []), values)) return { ok: false, code: 'secret', message: `“${source.name}” could not be read: what it sent holds one of your secrets, which is never shown.` };
  return { ok: true, raw: result.raw ?? [], total: result.total ?? 0 };
}

/**
 * The project `state` with source settings `draft` saved in it, as `source.upsert` saves them, or why they cannot be:
 * the engine's own reasons, a converter that may not run (each problem by its line), or one of the user's saved
 * secrets written into them.
 */
export async function sourceDraftState(state: ProjectState, draft: SourceSettingsDraft, secrets: Pick<SecretStore, 'values'>): Promise<{ state: ProjectState; source: SourceDoc } | { message: string }> {
  const op = { ...draft, type: 'source.upsert' } as EditOperation;
  const checked = validateOperation(op);
  if (!checked.ok) return { message: `The source cannot be saved: ${checked.message}` };
  let values: string[];
  try {
    values = await secrets.values(state.manifest.projectId);
  } catch (e) {
    return { message: `${(e as Error).message} The source’s settings cannot be checked for them.` };
  }
  // A source's settings never hold one of the user's saved secrets themselves (a token pasted into its name).
  if (holdsSecretValue(JSON.stringify(draft), values)) return { message: 'A source’s settings may not hold one of your secrets. Name it with ${secret:NAME} or a credential instead.' };
  if (typeof draft.converter === 'string') {
    const problems = converterProblems(draft.converter);
    if (problems.length) return { message: `Its converter cannot be run:\n${converterProblemText(problems)}` };
  }
  try {
    const next = applyOperations(state, [op]).state;
    return { state: next, source: next.sources![draft.sourceId] };
  } catch (e) {
    return { message: (e as Error).message };
  }
}

/** How long a Test may take: less than a sync, as someone is waiting on it. */
export const SAMPLE_TIMEOUT_MS = 90_000;

/** Sync source `sourceId` of the open project. Resolves with what changed, or why nothing did. */
export async function syncSource(deps: SyncDeps, sourceId: string): Promise<SourceSyncResult> {
  const { session } = deps;
  const closed: SourceSyncResult = { ok: false, code: 'closed', message: 'The project was closed before the source was synced.' };
  const state = session.state;
  const revision = session.revision;
  const source = Object.hasOwn(state.sources ?? {}, sourceId) ? state.sources![sourceId] : undefined;
  if (!source) return { ok: false, message: 'That source is no longer in the project.' };
  const stale: SourceSyncResult = { ok: false, code: 'stale', message: `The project changed while “${source.name}” was being synced, so nothing was changed. Sync it again.` };
  // Checked before anything is read, so a sync that could never land never signs in anywhere.
  try {
    planSourceSync(state, source, [], new Date(0).toISOString());
  } catch (e) {
    if (e instanceof SyncPlanError) return { ok: false, message: e.message };
    throw e;
  }
  // Never read another way than its settings say: without its converter, its records would be other entries.
  const missing = converterMissing(source);
  if (missing) return { ok: false, code: 'converter', message: missing };
  const projectId = state.manifest.projectId;
  // Settings changed outside the app (its address, say) never take the user's secrets anywhere until saved here.
  if (!(await signInApproved(deps.approvals, projectId, source)))
    return { ok: false, code: 'unapproved', message: unapprovedMessage(source) };
  let secrets: Record<string, string>;
  let values: string[];
  try {
    secrets = await deps.secrets.resolve(projectId, sourceSecretNames(source));
    // Those sent, whatever the store holds by the time it is read again (a secret changed meanwhile), and every other.
    values = [...new Set([...Object.values(secrets), ...(await deps.secrets.values(projectId))])];
  } catch (e) {
    return { ok: false, code: 'secrets', message: syncFailureMessage(source.name, 'failed', (e as Error).message.replace(/\.$/, '')) };
  }
  // The pictures wait in a folder of their own, one file each, never all in memory; it goes when the sync ends.
  let spool: Spool;
  try {
    spool = await openSpool(deps.spoolRoot);
  } catch {
    return { ok: false, message: syncFailureMessage(source.name, 'failed', 'its pictures have nowhere to wait while they are fetched') };
  }
  try {
    return await syncWithSpool(deps, { source, state, revision, secrets, values, closed, stale }, spool);
  } finally {
    await spool.release();
  }
}

/** syncSource's work once its secrets are known, its pictures fetched into `spool`. */
async function syncWithSpool(
  deps: SyncDeps,
  sync: { source: SourceDoc; state: ProjectState; revision: number; secrets: Record<string, string>; values: string[]; closed: SourceSyncResult; stale: SourceSyncResult },
  spool: Spool
): Promise<SourceSyncResult> {
  const { session } = deps;
  const { source, state, revision, secrets, values, closed, stale } = sync;
  let result;
  try {
    result = await deps.runner.run(source.name, { ...sourceRequest(state, source), secrets, known: knownHashes(state, source), spool: spool.dir }, { signal: deps.signal });
  } catch (e) {
    if (e instanceof SyncError) return { ok: false, code: e.code, message: redactSecrets(e.message, values) };
    return { ok: false, message: syncFailureMessage(source.name, 'failed') };
  }
  if (!deps.current()) return closed;
  if (session.revision !== revision) return stale;
  // A source that sends back one of the user's secrets (a server echoing its token into a record) never has it written
  // into the project.
  const leaked: SourceSyncResult = { ok: false, code: 'secret', message: `“${source.name}” was not synced: what it sent holds one of your secrets, which is never written into the project.` };
  if (holdsSecret(textOf(result.records), values)) return leaked;
  const now = (deps.now ?? (() => new Date()))();
  let plan: SyncPlan;
  try {
    plan = planSourceSync(state, source, result.records, now.toISOString());
  } catch (e) {
    if (e instanceof SyncPlanError) return { ok: false, message: e.message };
    throw e;
  }
  if (planIsEmpty(plan)) return counts(plan, revision, 0);
  // Checked as written before any picture is brought into the library: a record its collection cannot hold stops the
  // sync with nothing imported.
  const refused = syncPreflight(state, source, result.records, now.toISOString(), values);
  if (refused === SECRET_IN_RECORDS) return leaked;
  if (refused) return { ok: false, code: 'invalid', message: `“${source.name}” was not synced: ${redactSecrets(refused, values)}` };
  const grant: SourceSyncGrant = { sourceId: source.id, collectionId: plan.collectionId, provenance: plan.provenance };
  const label = `Sync “${source.name}”`;
  // Each picture by its identity, with its place in the spool.
  const fetched = new Map(result.images.map((img, index) => [img.key, { img, index }]));
  // Every picture the sync brings is there whole before the first is imported: one the worker never fetched, or whose
  // file is missing or not the size it was fetched at, stops the sync with nothing imported.
  for (const key of plan.images.keys()) {
    const at = fetched.get(key);
    if (!at || !(await spool.holds(at.index, at.img.size))) return { ok: false, message: syncFailureMessage(source.name, 'image') };
  }
  return session.withImport(async (): Promise<SourceSyncResult> => {
    const known = Object.values(session.state.assets.assets);
    const createdAt = now.toISOString();
    const assetIds = new Map<string, string>();
    const added: AssetRecord[] = [];
    for (const [key, wanted] of plan.images) {
      if (!deps.current()) return closed;
      if (session.revision !== revision) return stale;
      const at = fetched.get(key);
      if (!at) return { ok: false, message: syncFailureMessage(source.name, 'image') };
      const name = pictureName(wanted.name, wanted.url);
      // Read from its file only now, one picture at a time: the bytes the worker fetched, of the size it said.
      let bytes: Buffer;
      try {
        bytes = await spool.read(at.index, at.img.size);
      } catch {
        return { ok: false, message: syncFailureMessage(source.name, 'image') };
      }
      if (!deps.current()) return closed;
      if (session.revision !== revision) return stale;
      // Nor in what a picture brings: its name, as an address may carry it, or its bytes (a text chunk), which the
      // library keeps as they are.
      if (holdsSecret(name, values) || pictureHoldsSecret(bytes, values)) return leaked;
      try {
        const { record, existing } = await deps.importImage({ name, mime: at.img.mime, ext: at.img.ext, bytes }, known, createdAt);
        // The file name the library made of it ("Arts & Crafts" is arts-and-crafts): never one that holds a secret.
        if (holdsSecret(record.file, values)) return leaked;
        if (!existing) {
          added.push(record);
          known.push(record);
        }
        assetIds.set(key, record.id);
      } catch (e) {
        return { ok: false, message: syncFailureMessage(source.name, 'image', redactSecrets((e as Error).message, values).replace(/\.$/, '')) };
      }
    }
    if (!deps.current()) return closed;
    let operations: EditOperation[];
    try {
      operations = [...added.map((asset) => ({ type: 'asset.add', asset }) as EditOperation), ...syncOperations(plan, state, assetIds)];
    } catch (e) {
      if (e instanceof SyncPlanError) return { ok: false, message: e.message };
      throw e;
    }
    const r = await session.apply({ operations, expectedRevision: revision }, { label, source: 'system', history: false, sourceSync: grant, stillWanted: deps.current });
    if (!r.ok) {
      if (r.error?.code === 'STALE_REVISION') return stale;
      return { ok: false, code: r.error?.code, message: `“${source.name}” was not synced: ${redactSecrets((r.error?.message ?? 'its records could not be written.').replace(/^Operation \d+ \([\w.]+\): /, ''), values)}` };
    }
    return counts(plan, r.revision, added.length);
  });
}
