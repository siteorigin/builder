/**
 * The main process's side of the assistant's source tools (#680): read the first few records a source the author
 * connected has, as its kind of source reads them, and test a mapping or converter the assistant wrote against every
 * record it has now, as Connect external source's Test does, writing nothing. A source signs in with the user's
 * secrets only where the author approved its settings, and a tested change that lands keeps that approval only when it
 * reads nothing its own way: where the source is read and with which secrets never comes from the assistant.
 */
import { randomUUID } from 'node:crypto';
import type { ProjectState, SourceDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { SourceSettingsDraft } from '@shared/api';
import { sourceConversionKey, sourceFingerprint, sourceSecretNames } from '@shared/sources';
import type { SourceInspectResult, SourceToolHost, SourceToolIssue, SourceVerifyResult } from '@agent/source-tools';
import { converterProblems, readsItsOwnWay } from './converter';
import { holdsSecret, inspectSource, sampleSource, signInApproved, sourceDraftState, unapprovedMessage } from './sync';
import type { SyncRunner } from './client';
import type { SecretStore } from './secrets';
import type { ApprovalStore } from './approvals';

/** The open project as the tools read it. */
export interface AgentSourceProject {
  readonly state: ProjectState;
  /** The folder it is open in: its secrets and approvals are that folder's. */
  readonly dir: string;
}

export interface AgentSourceDeps {
  /** The project open now, or null. A read or test that outlives it says so. */
  project(): AgentSourceProject | null;
  runner: SyncRunner;
  /** The secrets and approvals of `project`, in its own folder. */
  stores(project: AgentSourceProject): { secrets: SecretStore; approvals: ApprovalStore };
  /** Hold `abort` with the project's other syncs, which its closing ends; the returned function lets it go. */
  track?(abort: AbortController): () => void;
}

/** Whether a source is read where its own code says: its converter's fetchAll, or a converter that is missing. */
const readByItsCode = (source: SourceDoc) => !!source.converter && (typeof source.converter.code !== 'string' || readsItsOwnWay(source.converter.code));

/** The tools' host for each run, ended with its signal. */
export function createAgentSources(deps: AgentSourceDeps): (signal: AbortSignal) => SourceToolHost {
  /** Tested changes waiting to land, by the ticket the tool holds: only the latest few. Each names its project weakly,
   *  so a ticket never used keeps no closed project (#1039); one whose project has gone approves nothing. */
  const tickets = new Map<string, { project: WeakRef<AgentSourceProject>; sourceId: string; candidate: string }>();

  const linked = async <T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const abort = new AbortController();
    const stop = () => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', stop, { once: true });
    const release = deps.track?.(abort);
    try {
      return await fn(abort.signal);
    } finally {
      signal.removeEventListener('abort', stop);
      release?.();
    }
  };

  /**
   * The saved source named, or why the tools leave it alone. Settings that hold one of the user's secrets are refused
   * first, by ID, so no later word about the source can show it.
   */
  const named = async (sourceId: string): Promise<{ project: AgentSourceProject; source: SourceDoc } | { code?: string; message: string }> => {
    const project = deps.project();
    if (!project) return { message: 'No project is open.' };
    const source = Object.hasOwn(project.state.sources ?? {}, sourceId) ? project.state.sources![sourceId] : undefined;
    if (!source) return { message: 'That source is no longer in the project.' };
    const leaked = await holdsUserSecret(project, source);
    if (leaked) return leaked;
    // Neither the source's own reader nor a converter in place of that code may sign in where the approved settings never did.
    if (readByItsCode(source))
      return { code: 'converter', message: `“${source.name}” is read by its converter’s own fetchAll${typeof source.converter?.code !== 'string' ? ', which is missing' : ''}: only the author changes how it is read, in Connect external source.` };
    return { project, source };
  };

  const inspect = async (sourceId: string, fingerprint: string, signal: AbortSignal): Promise<SourceInspectResult> => {
    const found = await named(sourceId);
    if ('message' in found) return { ok: false, ...(found.code ? { code: found.code } : {}), message: found.message };
    // Read for the settings the run read: records of other settings would be shown beside these.
    const stale = { ok: false as const, code: 'stale', message: `The source ${sourceId} changed while it was being read. Read the project again.` };
    if (sourceFingerprint(found.source) !== fingerprint) return stale;
    const r = await inspectSource({ runner: deps.runner, ...deps.stores(found.project), signal }, found.project.state, found.source);
    if (deps.project() !== found.project) return { ok: false, message: 'The project was closed before the source was read.' };
    const now = Object.hasOwn(found.project.state.sources ?? {}, sourceId) ? found.project.state.sources![sourceId] : undefined;
    return now && sourceFingerprint(now) === fingerprint ? r : stale;
  };

  /**
   * Why a source's saved settings cannot be shown or tested by the assistant when they hold one of the user's secrets
   * (settings edited outside the app can hold anything, its name and its converter included), or null. Said by its ID.
   */
  const holdsUserSecret = async (project: AgentSourceProject, source: SourceDoc): Promise<{ ok: false; code: string; message: string } | null> => {
    let values: string[];
    try {
      values = await deps.stores(project).secrets.values(project.state.manifest.projectId);
    } catch (e) {
      return { ok: false, code: 'secrets', message: `${(e as Error).message} The source cannot be checked for them.` };
    }
    return holdsSecret(sourceFingerprint(source), values) ? { ok: false, code: 'secret', message: `The settings of the source ${source.id} hold one of your secrets, which is never shown. The author takes it out in Connect external source.` } : null;
  };

  const verify: (sourceId: string, change: Parameters<SourceToolHost['verify']>[1], signal: AbortSignal) => Promise<SourceVerifyResult> = async (sourceId, change, signal) => {
    const fail = (message: string, issues: SourceToolIssue[] = [], recoverable = true): SourceVerifyResult => ({ ok: false, message, ...(issues.length ? { issues } : {}), recoverable });
    const found = await named(sourceId);
    if ('message' in found) return { ...fail(found.message, [], false), ...(found.code ? { code: found.code } : {}) };
    const { project, source } = found;
    if ('converter' in change) {
      const problems = converterProblems(change.converter);
      if (problems.length) return fail('The converter cannot be run.', problems.map((p) => ({ stage: 'check' as const, ...p })));
      if (readsItsOwnWay(change.converter)) return fail('The converter cannot be saved.', [{ stage: 'check', message: 'It names fetchAll: a converter the assistant writes is given the records the source’s settings read, and only puts them in shape.' }]);
    }
    // Only how its records are put in shape changes: where it is read, and with which secrets, stay as the author saved them.
    const draft = {
      sourceId,
      name: source.name,
      adapter: source.adapter,
      collectionId: source.collectionId,
      config: structuredClone(source.config),
      ...('converter' in change ? { converter: change.converter } : { mapping: change.mapping }),
      ...(source.removal !== undefined ? { removal: source.removal } : {})
    } as SourceSettingsDraft;
    const { secrets, approvals } = deps.stores(project);
    if (!(await signInApproved(approvals, project.state.manifest.projectId, source))) return fail(unapprovedMessage(source), [], false);
    const made = await sourceDraftState(project.state, draft, secrets);
    if ('message' in made) return fail(made.message, [{ stage: 'settings', message: made.message }]);
    const base = sourceFingerprint(source);
    // Offline: no name a picture's address gives is looked up while nothing is saved.
    const r = await sampleSource({ runner: deps.runner, secrets, signal }, made.state, made.source, { offline: true });
    if (deps.project() !== project) return fail('The project was closed before the source was tested.', [], false);
    if (!r.ok) {
      // What can be put right by writing it again: its code, the records it gives, or how they fit the collection.
      const recoverable = r.code === 'converter' || r.code === 'invalid' || r.code === 'image';
      const stage: SourceToolIssue['stage'] = r.code === 'converter' ? 'run' : /could not be synced as it is/.test(r.message) ? 'collection' : 'records';
      const line = /\(line (\d+)\)/.exec(r.message)?.[1];
      return fail(r.message, recoverable ? [{ stage, message: r.message, ...(line ? { line: Number(line) } : {}) }] : [], recoverable);
    }
    // Records read and records given: one that makes up an entry shows nothing of the source, and one that gives none
    // would have its next sync draft or remove every entry the source has.
    if (r.raw.length && !r.total) return fail(`The ${'converter' in change ? 'converter' : 'mapping'} gives no entries for the ${r.raw.length === 1 ? 'record' : 'records'} “${source.name}” has, so its next sync would take away every entry it synced.`, [{ stage: 'records', message: 'It gives no entries.' }]);
    if (!r.raw.length) return fail(`“${source.name}” has no records now, so nothing shows the ${'converter' in change ? 'converter' : 'mapping'} is right. Ask the author to add one at the source first.`, [], false);
    const ticket = randomUUID();
    tickets.set(ticket, { project: new WeakRef(project), sourceId, candidate: sourceFingerprint(made.source) });
    // A run that never applied what it tested leaves nothing behind for long.
    while (tickets.size > 20) tickets.delete(tickets.keys().next().value!);
    return { ok: true, operation: { ...draft, type: 'source.upsert' } as EditOperation, grant: { sourceId, base, change: sourceConversionKey(draft) }, ticket, records: r.records, total: r.total, created: r.created, updated: r.updated, unchanged: r.unchanged, unpublished: r.unpublished, removed: r.removed, kept: r.kept, ...(r.droppedLinks ? { droppedLinks: r.droppedLinks } : {}) };
  };

  /**
   * Once the change a ticket names has landed exactly as it was tested, the source goes on signing in with the user's
   * secrets: its settings were approved before it (checked when it was tested), and what changed reads nothing its own
   * way. False when there is nothing to approve it for, or the approval could not be kept.
   */
  const approve = async (ticket: string): Promise<boolean> => {
    const t = tickets.get(ticket);
    tickets.delete(ticket);
    const project = t?.project.deref();
    if (!t || !project || deps.project() !== project) return false;
    const now = Object.hasOwn(project.state.sources ?? {}, t.sourceId) ? project.state.sources![t.sourceId] : undefined;
    if (!now || sourceFingerprint(now) !== t.candidate || readByItsCode(now)) return false;
    if (!sourceSecretNames(now).length) return true;
    try {
      await deps.stores(project).approvals.approve(project.state.manifest.projectId, now);
      return true;
    } catch {
      return false;
    }
  };

  return (signal) => ({
    inspect: (sourceId, fingerprint) => linked(signal, (s) => inspect(sourceId, fingerprint, s)),
    verify: (sourceId, change) => linked(signal, (s) => verify(sourceId, change, s)),
    approve
  });
}
