/** Where an AI turn's change stands in the site now, read from History rather than from what the turn said. */
import type { ChatMessage, HistoryInfo } from './api';

type TurnResult = NonNullable<ChatMessage['result']>;

/** The part of History a turn's standing is read from. */
export type TurnHistory = { entries: ReadonlyArray<Pick<HistoryInfo['entries'][number], 'runId' | 'applied'>>; droppedRuns?: HistoryInfo['droppedRuns'] };

/** Applied: the change is in the site. Undone: it is not. Unknown: History has no record of the turn's step. */
export type TurnStanding = 'applied' | 'undone' | 'unknown';

/** What earlier versions appended to a turn's summary when it was undone from chat. */
const UNDONE_MARK = ' (Undone.)';

/**
 * A result as the assistant gave it. Earlier versions recorded Undo turn by appending "(Undone.)" to the summary and
 * clearing canUndo, which no Redo ever took back (issue 276). Read back, that is the original summary, a turn that
 * did change the site, and `undoneOnce`: it was undone at least once, whatever it is now. Nothing is rewritten.
 */
export function resultAsSaid(r: TurnResult): { result: TurnResult; undoneOnce: boolean } {
  if (r.status !== 'completed' || r.canUndo !== false || typeof r.summary !== 'string' || !r.summary.endsWith(UNDONE_MARK)) return { result: r, undoneOnce: false };
  return { result: { ...r, summary: r.summary.slice(0, -UNDONE_MARK.length), canUndo: true }, undoneOnce: true };
}

/** Where a run's step stands: from History's step while it holds one, else from what it noted when letting it go. */
export function runStanding(runId: string | undefined, history: TurnHistory | null | undefined): TurnStanding {
  if (!runId || !history) return 'unknown';
  for (let i = history.entries.length - 1; i >= 0; i--) if (history.entries[i].runId === runId) return history.entries[i].applied ? 'applied' : 'undone';
  const dropped = history.droppedRuns && Object.hasOwn(history.droppedRuns, runId) ? history.droppedRuns[runId] : undefined;
  return dropped === 'applied' || dropped === 'undone' ? dropped : 'unknown';
}

export interface TurnState {
  /** The result as it was said. */
  result: TurnResult;
  /** Where the turn's change stands; unknown for a turn that changed nothing. */
  standing: TurnStanding;
  /**
   * Undone once, by what an earlier version recorded, and History no longer shows whether it was redone since: the
   * turn is not called either applied or undone.
   */
  undoneEarlier: boolean;
}

/** An assistant turn's result as it was said, and where its change stands in the site now. */
export function turnState(m: Pick<ChatMessage, 'runId' | 'result'>, history: TurnHistory | null | undefined): TurnState | null {
  if (!m.result) return null;
  const { result, undoneOnce } = resultAsSaid(m.result);
  const standing = result.canUndo ? runStanding(m.runId, history) : 'unknown';
  return { result, standing, undoneEarlier: undoneOnce && standing === 'unknown' };
}
