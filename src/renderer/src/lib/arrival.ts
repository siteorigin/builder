import type { ElementRef } from '@shared/types';

/**
 * The arrival cue (issue #509): an element just inserted is outlined on the canvas with a brief highlight once the page
 * shows it, so an insertion is seen to land, whether it went in view or off the bottom of the page (scrolled to as the
 * site mounts it).
 */

/**
 * How long an insertion waits for the page to show it in view; one that takes longer arrives without the cue. Longer
 * than the page waits for it to mount (the bridge's SCROLL_WAIT_MS), whose wait starts only once the canvas asks it to
 * scroll there, which a frame still loading its page does later.
 */
export const ARRIVAL_WAIT_MS = 6000;
/** How long the cue shows (its animation in styles.css runs as long). */
export const ARRIVAL_MS = 1200;

/** The selection made as an element was inserted, until the page shows it or `until` (performance.now()) passes. */
let arriving: { ref: ElementRef; until: number } | null = null;

/** `ref`, selected as it was inserted (in the same step), gets the cue once the page shows it. */
export function markArrival(ref: ElementRef, now = performance.now()): void {
  arriving = { ref, until: now + ARRIVAL_WAIT_MS };
}

/** Preview shows the page as visitors see it: an insertion still waiting arrives without the cue, also back in Edit. */
export function endArrival(): void {
  arriving = null;
}

/**
 * Whether the cue starts now, for `selection` with the page showing it (`shown`): true once, for the very selection
 * that was marked. Any other selection (the author picked something else, another page, another project), or a wait
 * that ran out, ends it.
 */
export function takeArrival(selection: ElementRef | null, shown: boolean, now = performance.now()): boolean {
  const a = arriving;
  if (!a) return false;
  if (a.ref !== selection || now > a.until) {
    arriving = null;
    return false;
  }
  if (!shown) return false;
  arriving = null;
  return true;
}

type Desc = { ctx: string; node: string; items?: string };
type Box = { x: number; y: number; width: number; height: number };

/**
 * Whether a report from the page shows the selection: measured for the selection's own element (`measured`, what the
 * page had been told was selected, never a report from before it was), and part of its first box in the frame's view.
 */
export function arrivalShown(measured: Desc | null, selected: Desc | null, box: Box | undefined, viewport: unknown): boolean {
  if (!measured || !selected || !box) return false;
  if (measured.ctx !== selected.ctx || measured.node !== selected.node || (measured.items ?? '') !== (selected.items ?? '')) return false;
  // The frame's own report of its size: anything else is no size at all.
  const v = viewport && typeof viewport === 'object' ? (viewport as Record<string, unknown>) : {};
  const w = v.width;
  const h = v.height;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return box.y < h && box.y + box.height > 0 && box.x < w && box.x + box.width > 0;
}
