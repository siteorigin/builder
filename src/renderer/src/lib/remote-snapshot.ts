import type { ApplyResult, ProjectSnapshot, RemoteState, RuntimeState } from '@shared/api';
import type { ToolErrorCode } from '@shared/ops';
import type { RpcError } from '@shared/live/messages';
import type { LiveApplyResult, LiveProjectSnapshot } from '@shared/live/snapshot';

/**
 * The host's project, as the remote shell's editor shows it (#766). A guest is sent the host's documents and what it
 * needs to know about editing them now (shared/live/snapshot.ts), never the host's own snapshot; this makes the
 * editor's snapshot from it, with everything that is the host's alone (its folder, history, diagnostics, conflicts,
 * versions, exports and the place it left each page) empty, and the project read-only whenever this guest cannot
 * edit it now. Pure, so it is tested on its own.
 */

/** The opening of the host's project the editor shows for one join: never one of this computer's own. */
export const remoteOpening = (joinId: string) => `remote:${joinId}`;
export const isRemoteOpening = (key: string | null | undefined) => typeof key === 'string' && key.startsWith('remote:');

export type AdmittedRemote = Extract<RemoteState, { phase: 'admitted' }>;

/** Why this guest cannot edit the host's project right now, or null when it can. */
export function remoteReadOnly(remote: AdmittedRemote, live: LiveProjectSnapshot): string | null {
  if (remote.role !== 'collaborator') return 'You joined this live session as a viewer: you can follow the host’s work, but not edit it. Ask the host to make you a collaborator.';
  if (!remote.hostConnected) return 'The host is reconnecting to the live session. Editing resumes when they are back.';
  if (remote.reconnecting) return 'Your connection to the live session dropped. Editing resumes once it is back.';
  if (remote.tooLarge) return 'The host’s project has grown too large to share in a live session, so what you see may be out of date and editing is paused.';
  if (live.readOnly) return 'The host’s project is open read-only, so nobody can edit it right now.';
  if (live.aiBusy) return 'The host’s AI is making changes. Editing resumes when it finishes.';
  return null;
}

/** The host's preview as the canvas loads it: from this computer's loopback server, once the host's is running. */
export function remoteRuntime(remote: AdmittedRemote): RuntimeState {
  switch (remote.hostRuntime) {
    case 'error':
      return { state: 'error', message: 'The host’s preview has a problem. It shows again once the host fixes it.' };
    case 'unavailable':
      return { state: 'unavailable', message: 'The host’s project has no preview that can be shared.' };
    case 'ready':
      if (remote.previewUrl) return { state: 'ready', url: remote.previewUrl };
      return remote.previewProblem ? { state: 'error', message: remote.previewProblem } : { state: 'starting' };
    default:
      return { state: 'starting' };
  }
}

/**
 * The editor's snapshot of the host's project. The guest edits only through the host, so nothing here can undo,
 * export, version or save anything locally; the host's AI never shows as this editor's own (it would offer a Stop
 * for a run that is not this computer's), only as a reason editing waits.
 */
export function remoteSnapshot(remote: AdmittedRemote, live: LiveProjectSnapshot): ProjectSnapshot {
  const reason = remoteReadOnly(remote, live);
  return {
    dir: '',
    state: live.state,
    revision: live.revision,
    history: { canUndo: false, canRedo: false, entries: [] },
    diagnostics: [],
    runtime: remoteRuntime(remote),
    recoveryNotes: [],
    aiBusy: false,
    aiRunId: null,
    assetUsage: {},
    missingAssets: [],
    conflicts: [],
    readOnly: reason ? { reason, canUnlock: false } : null,
    localState: {},
    workspaceKey: remoteOpening(remote.joinId),
    recentExports: []
  };
}

/** Engine refusals the editor knows by their own code; a live session's own are said in words. */
const EDITOR_CODES: ReadonlySet<string> = new Set<ToolErrorCode>(['INVALID_ARGUMENT', 'STALE_REVISION', 'SCOPE_MISMATCH', 'PATH_DENIED', 'VALIDATION_FAILED', 'CONFLICT', 'CANCELLED', 'BUSY']);

/** A refusal from the host or the relay as the editor's own: the engine's codes as they are, the rest as a conflict, with what they said. */
export function remoteToolError(error: RpcError): NonNullable<ApplyResult['error']> {
  // A host busy with its AI is no reason to offer this guest a Stop: it is said as a refusal like the rest.
  const code = (EDITOR_CODES.has(error.code) && error.code !== 'BUSY' ? error.code : 'CONFLICT') as ToolErrorCode;
  return { code, message: error.message, recoverable: error.recoverable, ...(error.operationIndex !== undefined ? { operationIndex: error.operationIndex } : {}) };
}

/** The host's answer to an edit, as the editor reads an edit's result. A refusal keeps the revision the editor holds. */
export function remoteApplyResult(result: LiveApplyResult, revision: number): ApplyResult {
  if (result.ok) return { ok: true, revision: result.revision, results: result.results };
  return { ok: false, revision, error: remoteToolError(result.error) };
}
