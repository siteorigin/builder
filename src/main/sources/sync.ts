/**
 * Syncing an external source into its collection: the sync worker reads every record (signed in with the secrets the
 * source names, sent to it and nowhere else), the records are reconciled with the collection's entries, their new
 * pictures become library images (checked, with their responsive copies), and the result lands as one change made
 * against the very revision of the project the sync began from, or nothing does. A sync is no step of History: the
 * source is where its entries change, and undoing one would only be put back by the next.
 */
import type { AssetRecord, ProjectState } from '@shared/types';
import type { ApplyResult, EditOperation } from '@shared/ops';
import { holdsSecretValue, MIN_SECRET_LENGTH, sourceSecretNames } from '@shared/sources';
import type { SourceSyncGrant } from '@engine/sources';
import { SyncError, syncFailureMessage, type SyncRunner } from './client';
import type { SecretStore } from './secrets';
import type { SyncImage } from './protocol';
import { knownHashes, planIsEmpty, planSourceSync, SyncPlanError, syncOperations, type SyncPlan } from './reconcile';
import { redactSecrets } from './redact';

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
  /** Bring a fetched picture into the library: its record, and whether the library had it already (the same bytes). */
  importImage(image: SyncImage & { name: string }, known: AssetRecord[], createdAt: string): Promise<{ record: AssetRecord; existing: boolean }>;
  /** Whether the project the sync began in is still the one open, and wanted. */
  current(): boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export type SourceSyncResult =
  | { ok: true; revision: number; created: number; updated: number; unchanged: number; unpublished: number; removed: number; kept: number; images: number }
  | { ok: false; message: string; code?: string };

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

/** Every piece of text records hold, one to a line: what a sync writes, never the names of their own details. */
function textOf(v: unknown): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out.push(String(x));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
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
function holdsSecret(text: string, values: readonly string[]): boolean {
  const long = values.filter((v) => v.length >= MIN_SECRET_LENGTH);
  return holdsSecretValue(text, long) || holdsSecretValue(folded(text), long.map(folded)) || holdsSecretValue(slugged(text), long.map(slugged).filter((v) => v.replace(/-/g, '').length >= MIN_SECRET_LENGTH));
}

/** What to call a picture in the library: the name the source gives it, or its file's name. */
function pictureName(given: string | undefined, url: string): string {
  let file = '';
  try {
    file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    // An address that cannot be read names nothing.
  }
  return (given ?? file.replace(/\.[A-Za-z0-9]+$/, '')).replace(/[-_]+/g, ' ').trim().slice(0, 80) || 'Image';
}

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
  const projectId = state.manifest.projectId;
  let secrets: Record<string, string>;
  let values: string[];
  try {
    secrets = await deps.secrets.resolve(projectId, sourceSecretNames(source));
    // Those sent, whatever the store holds by the time it is read again (a secret changed meanwhile), and every other.
    values = [...new Set([...Object.values(secrets), ...(await deps.secrets.values(projectId))])];
  } catch (e) {
    return { ok: false, code: 'secrets', message: syncFailureMessage(source.name, 'failed', (e as Error).message.replace(/\.$/, '')) };
  }
  let result;
  try {
    result = await deps.runner.run(source.name, { adapter: source.adapter, config: source.config, secrets, known: knownHashes(state, source) }, { signal: deps.signal });
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
  const grant: SourceSyncGrant = { sourceId: source.id, collectionId: plan.collectionId, provenance: plan.provenance };
  const label = `Sync “${source.name}”`;
  const fetched = new Map(result.images.map((img) => [img.key, img]));
  return session.withImport(async (): Promise<SourceSyncResult> => {
    const known = Object.values(session.state.assets.assets);
    const createdAt = now.toISOString();
    const assetIds = new Map<string, string>();
    const added: AssetRecord[] = [];
    for (const [key, wanted] of plan.images) {
      if (!deps.current()) return closed;
      if (session.revision !== revision) return stale;
      const img = fetched.get(key);
      if (!img) return { ok: false, message: syncFailureMessage(source.name, 'image') };
      const name = pictureName(wanted.name, wanted.url);
      // Nor in what a picture brings: its name, as an address may carry it, or its bytes (a text chunk), which the
      // library keeps as they are.
      const bytes = Buffer.from(img.bytes);
      if (holdsSecret(name, values) || values.some((v) => v.length >= MIN_SECRET_LENGTH && bytes.includes(v))) return leaked;
      try {
        const { record, existing } = await deps.importImage({ ...img, name }, known, createdAt);
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
