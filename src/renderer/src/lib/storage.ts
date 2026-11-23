import type { ReclaimPlan } from '@shared/api';

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function formatBytes(b: number): string {
  if (b < 1024) return plural(b, 'byte', 'bytes');
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** At most this many history steps are named; the rest are counted. */
const SHOWN_STEPS = 4;

/** One side of history that freeing space trims: what is said before the steps, the steps named, and after. */
export interface TrimmedSide {
  lead: string;
  steps: string[];
  more: string | null;
  after: string;
}

/**
 * What freeing up space does to Undo and Redo, in the dialog's words. Undo loses its oldest steps, newest of those
 * named first, since those are the ones the author remembers; Redo loses its furthest steps, nearest named first.
 */
export function describeTrim(plan: ReclaimPlan): { undo: TrimmedSide | null; redo: TrimmedSide | null } {
  const side = (labels: string[], verb: 'undone' | 'redone', kept: number, earlier: string): TrimmedSide | null => {
    if (!labels.length) return null;
    const n = labels.length;
    const rest = n - SHOWN_STEPS;
    return {
      lead: `${n === 1 ? 'This step' : `These ${n} steps`} can no longer be ${verb}:`,
      steps: labels.slice(0, SHOWN_STEPS),
      more: rest > 0 ? `and ${plural(rest, `${earlier} step`, `${earlier} steps`)}` : null,
      after: verb === 'undone'
        ? kept ? `Your ${plural(kept, 'latest step', 'latest steps')} can still be undone.` : 'Nothing will be left to undo.'
        : kept ? `${plural(kept, 'step', 'steps')} before ${n === 1 ? 'it' : 'them'} can still be redone.` : 'Nothing will be left to redo.'
    };
  };
  return { undo: side([...plan.undo].reverse(), 'undone', plan.keptUndo, 'earlier'), redo: side(plan.redo, 'redone', plan.keptRedo, 'later') };
}
