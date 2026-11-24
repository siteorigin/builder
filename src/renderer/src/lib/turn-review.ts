/** The words of an AI turn's review in History (issue 164): each change, and what each way of undoing it does. */
import type { AiTurnReview, HistoryInfo, StepChange } from '@shared/api';
import { appliedCount, historyStep, type HistoryStep } from './history-steps';

type Entry = HistoryInfo['entries'][number];

const q = (v: string) => `“${v}”`;
const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/** One change as the review lists it: where, what, and the value it had and was given when there is one. */
export function stepChangeText(c: StepChange): string {
  const what = `${c.owner} · ${c.property}`;
  if (c.before !== undefined && c.after !== undefined) return `${what}: ${q(c.before)} → ${q(c.after)}`;
  if (c.change === 'added') return c.after !== undefined ? `${what}: added ${q(c.after)}` : `${what}: added`;
  if (c.change === 'removed') return c.before !== undefined ? `${what}: removed ${q(c.before)}` : `${what}: removed`;
  return `${what}: ${c.detail ?? 'changed'}`;
}

/** An AI step's label without the "AI:" it is recorded with. */
export const turnName = (label: string) => label.replace(/^AI(?: \(partial\))?: /, '');

/**
 * What the review offers, worked out from it and History as shown. `revert` undoes the turn on its own and keeps
 * every later change; `step` is History's step to it, which takes back (or puts back) every change in between, in
 * order, so it is always there as the safe way. Each says exactly what it takes and what it keeps.
 */
export interface TurnReviewPlan {
  revert: { ok: true; text: string; keeps: string[]; lost?: string } | { ok: false; reason: string };
  step: (HistoryStep & { index: number; takes: string[]; note: string }) | null;
}

export function reviewPlan(review: AiTurnReview, entries: readonly Entry[]): TurnReviewPlan {
  const index = entries.findIndex((e) => e.id === review.entryId);
  const kept = review.later.map((l) => l.label);
  const revert: TurnReviewPlan['revert'] = review.revert.ok
    ? {
        ok: true,
        text: kept.length ? `Takes back what this turn changed and keeps the ${changes(kept.length)} made after it.` : 'Takes back what this turn changed.',
        keeps: kept,
        ...(review.redoable ? { lost: `${changes(review.redoable)} you undid can no longer be redone.` } : {})
      }
    : { ok: false, reason: review.revert.reason };
  if (index < 0) return { revert, step: null };
  const step = historyStep(entries, index);
  const cursor = appliedCount(entries);
  // Newest first, the order they are taken back in; oldest first when they are put back.
  const takes = (step.direction === 'undo' ? entries.slice(index, cursor).reverse() : entries.slice(cursor, index + 1)).map((e) => e.label);
  const note =
    step.direction === 'undo'
      ? step.count === 1
        ? 'Undoes this turn. You can redo it until you make a new change.'
        : `Undoes this turn and the ${changes(step.count - 1)} after it, newest first. You can redo them until you make a new change.`
      : step.count === 1
        ? 'Redoes this turn.'
        : `Redoes the ${changes(step.count - 1)} before it, then this turn.`;
  return { revert, step: { ...step, index, takes, note } };
}
