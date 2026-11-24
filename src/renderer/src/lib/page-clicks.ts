/**
 * How long a click on a page row waits for a second click before it opens the page. Short of the 500 ms most systems
 * allow for a double click, so an ordinary click is not held long; a slower double click opens the page and then
 * renames it, as every double click once did.
 */
export const DOUBLE_CLICK_MS = 400;

/** Pointer clicks on the rows of the Pages list, told apart (see pageClicks). */
export interface PageClicks {
  /** A click on a row, with its click count (the event's `detail`: 0 when no pointer made it). */
  click: (id: string, count: number) => void;
  /** Open the page waiting for a second click now: whatever the author did instead shows the click was single. */
  settle: () => void;
  /** Forget the page waiting for a second click without opening it (the list went, or another project opened). */
  drop: () => void;
  /** Stop the clock on the page waiting: a press on its row is held until its click (a second one, or the row's
   *  options) says what it was, so the page never opens, and the list never moves, under a button being pressed. */
  hold: () => void;
  /** Whether the row waiting is pressed (see hold). */
  held: () => boolean;
  /** The row waiting for a second click, if any. */
  waiting: () => string | null;
}

interface Timers {
  set: (run: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
}
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/**
 * A page row's clicks: one opens its page, two rename it where it is, as F2 does. The first click waits `wait` ms for a
 * second before opening, so a double click never opens the page first: that would leave Edit everywhere, or move the
 * preview to another page, for a rename that may well be cancelled. A click no pointer made (assistive technology)
 * opens at once. A second click that comes after the page has opened still renames it.
 */
export function pageClicks({ open, rename, wait = DOUBLE_CLICK_MS, timers = realTimers }: { open: (id: string) => void; rename: (id: string) => void; wait?: number; timers?: Timers }): PageClicks {
  let pending: { id: string; timer: unknown; held?: boolean } | null = null;
  const drop = () => {
    if (pending) timers.clear(pending.timer);
    pending = null;
  };
  const settle = () => {
    const id = pending?.id;
    drop();
    if (id) open(id);
  };
  return {
    click: (id, count) => {
      if (count >= 2) {
        // The second click: the rename replaces the open it waited on. A third lands on the rename field.
        if (pending?.id === id) drop();
        else settle();
        if (count === 2) rename(id);
        return;
      }
      const was = pending?.id;
      settle();
      // A click no pointer made opens its page at once, once: settling may just have opened it.
      if (count === 0) return void (was !== id && open(id));
      pending = { id, timer: timers.set(settle, wait) };
    },
    settle,
    drop,
    hold: () => {
      if (!pending) return;
      timers.clear(pending.timer);
      pending.held = true;
    },
    held: () => !!pending?.held,
    waiting: () => pending?.id ?? null
  };
}

/** The Pages list's clicks while the list is there (see PagesPanel), for the canvas to settle before a pick. */
let listed: PageClicks | null = null;

/** Make `clicks` the Pages list's; the function returned lets them go. */
export function listPageClicks(clicks: PageClicks): () => void {
  listed = clicks;
  return () => {
    if (listed === clicks) listed = null;
  };
}

/**
 * Open the page a click in the Pages list is waiting to open, if any: true when there was one. Not while its row is
 * pressed: the pointer is on the row, so whatever else happened then is not the author's next step.
 */
export function settlePageClick(): boolean {
  if (!listed?.waiting() || listed.held()) return false;
  listed.settle();
  return true;
}
