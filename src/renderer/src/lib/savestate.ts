import type { RunStatus } from '@shared/api';
import type { SaveStatus } from './announce';

/**
 * Where the toolbar's save state settles. `stopping`: the AI is being stopped to apply a held edit.
 * `handoff`: a held edit is being checked or saved. `held`: one waits for the author.
 */
export function settledState(s: { conflict: boolean; runStatus: RunStatus | null; stopping: boolean; handoff: boolean; held: boolean; drafting: boolean; pending: boolean }): SaveStatus {
  if (s.conflict) return 'conflict';
  if (s.runStatus || s.stopping) return 'ai';
  // Saving a held edit is a save like any other, on the way from the AI (or the held edit) to saved.
  if (s.handoff) return 'busy';
  if (s.held) return 'held';
  return s.drafting || s.pending ? 'busy' : 'saved';
}
