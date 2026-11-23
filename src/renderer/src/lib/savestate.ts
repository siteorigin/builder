import type { RunStatus } from '@shared/api';
import type { SaveStatus } from './announce';

/**
 * What the AI is doing while a request runs, as the toolbar and screen readers say it. `asking`: it waits for
 * the author's answer, so nothing moves until they act. `checking`: its changes are being validated or
 * repaired. `stopping`: it is being stopped and its changes undone. `working`: everything else.
 */
export function runPhase(runStatus: RunStatus | null): 'working' | 'asking' | 'checking' | 'stopping' | null {
  if (!runStatus) return null;
  if (runStatus === 'awaiting-input') return 'asking';
  if (runStatus === 'stopping') return 'stopping';
  return runStatus === 'validating' || runStatus === 'repairing' ? 'checking' : 'working';
}

/**
 * Where the toolbar's save state settles. `stopping`: the AI is being stopped to apply a held edit.
 * `handoff`: a held edit is being checked or saved. `held`: one waits for the author.
 */
export function settledState(s: { conflict: boolean; runStatus: RunStatus | null; stopping: boolean; handoff: boolean; held: boolean; drafting: boolean; pending: boolean }): SaveStatus {
  if (s.conflict) return 'conflict';
  if (s.stopping) return 'stopping';
  const phase = runPhase(s.runStatus);
  if (phase) return phase;
  // Saving a held edit is a save like any other, on the way from the AI (or the held edit) to saved.
  if (s.handoff) return 'busy';
  if (s.held) return 'held';
  return s.drafting || s.pending ? 'busy' : 'saved';
}
