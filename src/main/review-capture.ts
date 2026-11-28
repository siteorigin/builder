/**
 * Review edition pictures (#1133) taken in the app: each page at each width in a window of its own that is never
 * shown or focused, opened for the one picture and destroyed after it (main/hidden-page). The steps of the picture
 * are main/review-shot's, spoken through the window's DevTools session.
 */
import type { BrowserWindow } from 'electron';
import { guardedSession, inHiddenPage, within } from './hidden-page';
import { shootReviewPage, type ReviewShot } from './review-shot';

/** The windows' own session: in memory, shared with nothing else. */
const PARTITION = 'siteorigin-review-capture';

export interface ReviewShooter {
  /** Photograph the page at `url` laid out `width` CSS pixels wide. */
  shoot(url: string, width: number, signal?: AbortSignal): Promise<ReviewShot>;
  /** Destroy every window still taking a picture. */
  dispose(): void;
}

export function createReviewShooter(): ReviewShooter {
  const open = new Set<BrowserWindow>();
  /** How many times the windows were disposed of: a picture that began before the last one opens none. */
  let disposals = 0;
  /** The last clear of the windows' stored state, finished or not. */
  let lastClear: Promise<unknown> = Promise.resolve();

  const shoot = async (url: string, width: number, signal?: AbortSignal): Promise<ReviewShot> => {
    if (signal?.aborted) return { ok: false, reason: 'failed', detail: 'The capture was stopped.' };
    const ses = guardedSession(PARTITION);
    const generation = disposals;
    // Each picture starts as a first visit: nothing a page stored, and no worker it registered, at another width.
    // One clear at a time, each after the last (chained before anything is awaited): an earlier one still running,
    // its picture called off, would wipe this one's page.
    const prior = lastClear;
    const clear = within(prior.then(() => true), false).then((free) => (free ? ses.clearStorageData().then(() => true, () => false) : false));
    // The next waits for this clear and for every earlier one still running, even one this picture gave up waiting for.
    lastClear = Promise.all([prior, clear]);
    const cleared = await within(clear, false);
    // Called off, or the windows disposed of, meanwhile: no window is made for it.
    if (signal?.aborted || generation !== disposals) return { ok: false, reason: 'failed', detail: 'The capture was stopped.' };
    if (!cleared) return { ok: false, reason: 'failed', detail: 'What an earlier page stored could not be cleared, so the page would not be shown as a first visit.' };
    const done = await inHiddenPage({ session: ses, width, signal, open }, (page, gone) => shootReviewPage(page, url, width, { signal: gone }));
    if (done.ok) {
      if (!done.value.ok && done.lost && !signal?.aborted) return { ok: false, reason: 'failed', detail: 'The page stopped responding.' };
      return done.value;
    }
    if (done.why === 'not-opened') return { ok: false, reason: done.ended ? 'failed' : 'timeout', detail: signal?.aborted ? 'The capture was stopped.' : 'The capture window did not open.' };
    return { ok: false, reason: 'failed', detail: `The page could not be captured: ${done.error instanceof Error ? done.error.message : String(done.error)}` };
  };

  return {
    shoot,
    dispose() {
      disposals++;
      for (const w of open) if (!w.isDestroyed()) w.destroy();
      open.clear();
    }
  };
}
