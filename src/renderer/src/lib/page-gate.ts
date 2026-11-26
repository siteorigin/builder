/**
 * While a save is publishing to the preview, the page can still show the project as it was before it (spec §18.2).
 * Picks and edits made through the page wait for it: until the page says it shows the editor's revision, until the
 * page reports that the update failed, or, for a page that never says either, PAGE_CATCH_UP_MS after the editor took
 * the revision. Nothing else waits (§18.1): navigating, scrolling, widths, Layers and the Inspector go on as usual.
 *
 * A click held meanwhile is taken again once the gate opens, and resolves against the project as it is then (or picks
 * nothing when what was clicked is gone). Only the latest click is kept.
 */

/** How long picks and canvas edits wait for the page to show a save before going ahead on the page as it is. */
export const PAGE_CATCH_UP_MS = 4000;

export type GateClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export type PageGate = {
  /** The page shows `revision`: it loaded with it, or says it has applied it. */
  shown(revision: number): void;
  /** The page reported a failure while it was behind: the update it was waiting for is not coming whole. */
  failed(): void;
  /** The editor has taken `revision` (it is counted as behind from now). */
  took(revision: number): void;
  /** Whether picks and edits through the page wait now. */
  behind(): boolean;
  /** Take `pick` once the gate opens, in place of any pick held before it. */
  hold(pick: () => void): void;
  /** Forget a held pick and its timer (the page it was made on went away, or the canvas closed). */
  drop(): void;
};

/**
 * What the gate does with a message from the page while it is shut: a click is held and taken again once it opens; a
 * double-click (an inline edit on text about to be replaced) or a context menu (placed by where the old page drew the
 * element) is dropped. Everything else passes: an inline edit already open hands its text back as usual, and the
 * visitor's own clicks in Preview are not picks.
 */
export function gatedPick(type: string, mode: 'edit' | 'preview'): 'hold' | 'drop' | null {
  if (mode !== 'edit') return null;
  if (type === 'select') return 'hold';
  if (type === 'dblclick' || type === 'contextmenu') return 'drop';
  return null;
}

/** A save failure as the editor last saw it: with the revision the project was at, and the failure's own text. */
export type SeenFailure = { revision: number; failure: string | null };

/**
 * Whether the project's latest snapshot reports a save that failed once its revision was taken (its files had reached
 * the preview, which is sent no revision for it): a new failure that arrives with a new revision. A failure before the
 * revision moved leaves the one still publishing to be waited for, and one still shown from an earlier save says
 * nothing about a later revision.
 */
export function failedWithRevision(seen: SeenFailure, now: SeenFailure): boolean {
  return now.failure !== null && now.revision !== seen.revision && now.failure !== seen.failure;
}

/** A gate for the editor's revision, read from `revision()` whenever it is asked about. */
export function createPageGate(revision: () => number, clock: GateClock = realClock, waitMs = PAGE_CATCH_UP_MS): PageGate {
  let shownRevision = 0;
  /** The revision a failure was reported for: the gate is open for it, and shut again for the next one. */
  let failedRevision: number | null = null;
  let since = { revision: 0, at: 0 };
  let held: (() => void) | null = null;
  let timer: unknown = null;

  const took = (r: number) => {
    if (since.revision !== r) since = { revision: r, at: clock.now() };
  };
  const behind = (): boolean => {
    const r = revision();
    if (shownRevision >= r || failedRevision === r) return false;
    took(r);
    return clock.now() - since.at < waitMs;
  };
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  /** Take the held pick if the gate has opened; otherwise look again when the fallback would open it. */
  const settle = () => {
    clearTimer();
    if (!held) return;
    if (behind()) {
      timer = clock.setTimeout(settle, Math.max(0, waitMs - (clock.now() - since.at)) + 1);
      return;
    }
    const pick = held;
    held = null;
    pick();
  };

  return {
    shown(r) {
      shownRevision = r;
      settle();
    },
    failed() {
      if (!behind()) return;
      failedRevision = revision();
      settle();
    },
    took(r) {
      took(r);
      // The editor moved on again: a held pick waits for this revision instead, from now.
      if (held) settle();
    },
    behind,
    hold(pick) {
      held = pick;
      settle();
    },
    drop() {
      held = null;
      clearTimer();
    }
  };
}
