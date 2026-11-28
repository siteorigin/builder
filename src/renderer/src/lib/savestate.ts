import type { RunStatus, SaveFailure } from '@shared/api';
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
 * Where the toolbar's save state settles. `failed`: a save failed, and none has succeeded since. `stopping`: the AI is
 * being stopped to apply a held edit. `handoff`: a held edit is being checked or saved. `held`: one waits for the author.
 */
export function settledState(s: { failed?: boolean; conflict: boolean; runStatus: RunStatus | null; stopping: boolean; handoff: boolean; held: boolean; drafting: boolean; pending: boolean }): SaveStatus {
  // Leads every other state: until a save succeeds again, what is on screen is not what is on disk.
  if (s.failed) return 'failed';
  if (s.conflict) return 'conflict';
  if (s.stopping) return 'stopping';
  const phase = runPhase(s.runStatus);
  if (phase) return phase;
  // Saving a held edit is a save like any other, on the way from the AI (or the held edit) to saved.
  if (s.handoff) return 'busy';
  if (s.held) return 'held';
  return s.drafting || s.pending ? 'busy' : 'saved';
}

/**
 * What the save indicator says about a save that failed: its words beside the glyph, its hover title, and, in Project
 * health (where activating it leads), what failed and what to do about it.
 */
export function saveFailureNotice(f: SaveFailure): { text: string; title: string; what: string; next: string } {
  const named = f.label ? `“${f.label}”` : null;
  if (f.kind === 'unfinished')
    return {
      text: 'Save not finished',
      title: 'A save did not finish, so nothing more is saved. Open Project health for what to do',
      what: `${named ? `Saving ${named}` : 'A save'} did not finish, so nothing more is saved for now.`,
      // Reopening finishes the save it names from its journal (#1435): what it was saving is kept, but changes made after it
      // are not. One it cannot name may have left nothing to finish, so nothing is promised of it.
      next: `Check that the project folder can be written to, then close and reopen the project${named ? ` to finish saving ${named}` : ''}. Changes you make until then are not saved.`
    };
  return {
    text: 'Save failed',
    title: 'Your last change was not saved. Open Project health for what to do',
    what: `${named ?? 'A change'} could not be saved to this computer. Everything saved before it is unchanged.`,
    next: 'Check that the disk has room and the project folder can be written to, then make the change again. This clears once a change is saved.'
  };
}
