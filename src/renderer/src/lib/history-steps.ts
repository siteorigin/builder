import type { HistoryInfo } from '@shared/api';

type Entry = HistoryInfo['entries'][number];

/**
 * What choosing an entry in History does (#199): an applied one is undone with every applied change after it, an
 * undone one is redone with every undone change before it. `text` is the short action shown on the row, `name` says
 * the whole of it for a screen reader, and `done` says what happened once it has.
 */
export interface HistoryStep {
  direction: 'undo' | 'redo';
  /** How many changes it undoes or redoes. */
  count: number;
  text: string;
  name: string;
  done: string;
}

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/** The step for `entries[index]` (entries oldest first, as History keeps them). */
export function historyStep(entries: readonly Entry[], index: number): HistoryStep {
  const cursor = appliedCount(entries);
  const label = `“${entries[index].label}”`;
  if (index < cursor) {
    const count = cursor - index;
    return count === 1
      ? { direction: 'undo', count, text: 'Undo', name: `Undo ${label}`, done: `Undid ${label}.` }
      : { direction: 'undo', count, text: `Undo ${changes(count)}`, name: `Undo ${label} and ${changes(count - 1)} after it`, done: `Undid ${changes(count)}, back to before ${label}.` };
  }
  const count = index + 1 - cursor;
  return count === 1
    ? { direction: 'redo', count, text: 'Redo', name: `Redo ${label}`, done: `Redid ${label}.` }
    : { direction: 'redo', count, text: `Redo ${changes(count)}`, name: `Redo ${changes(count)}, up to ${label}`, done: `Redid ${changes(count)}, up to ${label}.` };
}

/** How many entries are applied: they come first, so this is History's undo position. */
export function appliedCount(entries: readonly Entry[]): number {
  const i = entries.findIndex((e) => !e.applied);
  return i < 0 ? entries.length : i;
}
