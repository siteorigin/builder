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
import { sourceFingerprint, sourceSecretNames } from '@shared/sources';
import type { SourceInspectResult, SourceToolHost, SourceToolIssue, SourceVerifyResult } from '@agent/source-tools';
import { converterProblems, readsItsOwnWay } from './converter';
import { inspectSource, sampleSource, signInApproved, sourceDraftState, unapprovedMessage } from './sync';
import type { SyncRunner } from './client';
import type { SecretStore } from './secrets';
import type { ApprovalStore } from './approvals';

/** The open project as the tools read it. */
export interface AgentSourceProject {
  readonly state: ProjectState;
}

export interface AgentSourceDeps {
  /** The project open now, or null. A read or test that outlives it says so. */
  project(): AgentSourceProject | null;
  runner: SyncRunner;
  secrets: SecretStore;
  approvals: ApprovalStore;
  /** Hold `abort` with the project's other syncs, which its closing ends; the returned function lets it go. */
  track?(abort: AbortController): () => void;
}

/** Whether a source is read where its own code says: its converter's fetchAll, or a converter that is missing. */
const readByItsCode = (source: SourceDoc) => !!source.converter && (typeof source.converter.code !== 'string' || readsItsOwnWay(source.converter.code));

/** The tools' host for each run, ended with its signal. */
export function createAgentSources(deps: AgentSourceDeps): (signal: AbortSignal) => SourceToolHost {
  /** Tested changes waiting to land, by the ticket the tool holds: only the latest few. */
  const tickets = new Map<string, { project: AgentSourceProject; sourceId: string; candidate: string }>();

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

  /** The saved source named, or why the tools leave it alone. */
  const named = (sourceId: string): { project: AgentSourceProject; source: SourceDoc } | { code?: string; message: string } => {
    const project = deps.project();
    if (!project) return { message: 'No project is open.' };
    const source = Object.hasOwn(project.state.sources ?? {}, sourceId) ? project.state.sources![sourceId] : undefined;
    if (!source) return { message: 'That source is no longer in the project.' };
    // Neither the source's own reader nor a converter in place of that code may sign in where the approved settings never did.
    if (readByItsCode(source))
      return { code: 'converter', message: `“${source.name}” is read by its converter’s own fetchAll${typeof source.converter?.code !== 'string' ? ', which is missing' : ''}: only the author changes how it is read, in Connect external source.` };
    return { project, source };
  };

  const inspect = async (sourceId: string, signal: AbortSignal): Promise<SourceInspectResult> => {
    const found = named(sourceId);
    if ('message' in found) return { ok: false, ...(found.code ? { code: found.code } : {}), message: found.message };
    const r = await inspectSource({ runner: deps.runner, secrets: deps.secrets, approvals: deps.approvals, signal }, found.project.state, found.source);
    return deps.project() === found.project ? r : { ok: false, message: 'The project was closed before the source was read.' };
  };

  const verify: (sourceId: string, change: Parameters<SourceToolHost['verify']>[1], signal: AbortSignal) => Promise<SourceVerifyResult> = async (sourceId, change, signal) => {
    const fail = (message: string, issues: SourceToolIssue[] = [], recoverable = true): SourceVerifyResult => ({ ok: false, message, ...(issues.length ? { issues } : {}), recoverable });
    const found = named(sourceId);
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
    if (!(await signInApproved(deps.approvals, project.state.manifest.projectId, source))) return fail(unapprovedMessage(source), [], false);
    const made = await sourceDraftState(project.state, draft, deps.secrets);
    if ('message' in made) return fail(made.message, [{ stage: 'settings', message: made.message }]);
    const base = sourceFingerprint(source);
    const r = await sampleSource({ runner: deps.runner, secrets: deps.secrets, signal }, made.state, made.source);
    if (deps.project() !== project) return fail('The project was closed before the source was tested.', [], false);
    if (!r.ok) {
      // What can be put right by writing it again: its code, the records it gives, or how they fit the collection.
      const recoverable = r.code === 'converter' || r.code === 'invalid' || r.code === 'image';
      const stage: SourceToolIssue['stage'] = r.code === 'converter' ? 'run' : /could not be synced as it is/.test(r.message) ? 'collection' : 'records';
      const line = /\(line (\d+)\)/.exec(r.message)?.[1];
      return fail(r.message, recoverable ? [{ stage, message: r.message, ...(line ? { line: Number(line) } : {}) }] : [], recoverable);
    }
    if (!r.total) return fail(`“${source.name}” has no records now, so nothing shows the ${'converter' in change ? 'converter' : 'mapping'} is right. Ask the author to add one at the source first.`, [], false);
    const ticket = randomUUID();
    tickets.set(ticket, { project, sourceId, candidate: sourceFingerprint(made.source) });
    // A run that never applied what it tested leaves nothing behind for long.
    while (tickets.size > 20) tickets.delete(tickets.keys().next().value!);
    return { ok: true, operation: { ...draft, type: 'source.upsert' } as EditOperation, base, ticket, records: r.records, total: r.total, created: r.created, updated: r.updated, unchanged: r.unchanged, unpublished: r.unpublished, removed: r.removed, kept: r.kept };
  };

  /**
   * Once the change a ticket names has landed exactly as it was tested, the source goes on signing in with the user's
   * secrets: its settings were approved before it (checked when it was tested), and what changed reads nothing its own
   * way. False when there is nothing to approve it for, or the approval could not be kept.
   */
  const approve = async (ticket: string): Promise<boolean> => {
    const t = tickets.get(ticket);
    tickets.delete(ticket);
    if (!t || deps.project() !== t.project) return false;
    const now = Object.hasOwn(t.project.state.sources ?? {}, t.sourceId) ? t.project.state.sources![t.sourceId] : undefined;
    if (!now || sourceFingerprint(now) !== t.candidate || readByItsCode(now)) return false;
    if (!sourceSecretNames(now).length) return true;
    try {
      await deps.approvals.approve(t.project.state.manifest.projectId, now);
      return true;
    } catch {
      return false;
    }
  };

  return (signal) => ({
    inspect: (sourceId) => linked(signal, (s) => inspect(sourceId, s)),
    verify: (sourceId, change) => linked(signal, (s) => verify(sourceId, change, s)),
    approve
  });
}
