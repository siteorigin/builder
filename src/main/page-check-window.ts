/**
 * The website export's check that each built page still shows its content once it starts in a browser (#1534), run in
 * the app: each page in a window of its own that is never shown or focused, opened for the one check and destroyed
 * after it (main/hidden-page). The steps of the check are main/page-check's, spoken through the window's DevTools
 * session.
 */
import type { BrowserWindow } from 'electron';
import { guardedSession, inHiddenPage, within } from './hidden-page';
import { checkBuiltPage, type PageCheck } from './page-check';
import { quietRequest } from '@shared/integrations';

/** The windows' own sessions, one for each check under way at once: in memory, shared with nothing else. */
const PARTITION = 'siteorigin-export-check';
/** The width pages are opened at, as a laptop's. */
const WIDTH = 1280;

export interface PageChecker {
  /** Open the built page at `url` and say whether it still shows its content once started, measuring it until `measureUntil` (see checkBuiltPage). */
  check(url: string, signal?: AbortSignal, measureUntil?: number): Promise<PageCheck>;
  /** Destroy every window still checking a page. */
  dispose(): void;
}

export function createPageChecker(): PageChecker {
  const open = new Set<BrowserWindow>();
  /**
   * The sessions free for a check, by number. Each check takes one of its own, so pages opened at once never see
   * what another stored, and empties it first, so each page is a first visit (cookies ignore the port, so another
   * export's would be read too). One whose clear never finished is never given out again.
   */
  const free: number[] = [];
  let made = 0;
  /** How many times the windows were disposed of: a check that began before the last one opens none. */
  let disposals = 0;
  const stopped = (): PageCheck => ({ status: 'unchecked', detail: 'The check was stopped.' });

  const check = async (url: string, signal?: AbortSignal, measureUntil?: number): Promise<PageCheck> => {
    if (signal?.aborted) return stopped();
    const generation = disposals;
    const lane = free.pop() ?? made++;
    const ses = guardedSession(`${PARTITION}-${lane}`);
    // Another site's frames are left out: its embed cannot change whether the page's own components start, and one
    // that asks to be printed would open a print dialog the page's guard (main/page-check) never reaches. The site's
    // own frames run in the page's process, where the guard does.
    const origin = new URL(url).origin;
    // Nor does the check count as a visit to the site's analytics (quietRequest, as every hidden window has it).
    ses.webRequest.onBeforeRequest((details, done) => done({ cancel: quietRequest(details.url, details.resourceType) || (details.resourceType === 'subFrame' && !details.url.startsWith(`${origin}/`)) }));
    const cleared = await within(ses.clearStorageData().then(() => true, () => false), false);
    if (!cleared) return { status: 'unchecked', detail: 'What an earlier page stored could not be cleared, so the page would not be opened as a first visit.' };
    try {
      // Called off, or the windows disposed of (the editor closed), meanwhile: no window is made for it.
      if (signal?.aborted || generation !== disposals) return stopped();
      const done = await inHiddenPage({ session: ses, width: WIDTH, signal, open }, (page, gone) => checkBuiltPage(page, url, { signal: gone, measureUntil }));
      if (done.ok) {
        if (done.value.status === 'unchecked' && done.lost && !signal?.aborted) return { status: 'unchecked', detail: 'The page stopped responding.' };
        return done.value;
      }
      if (signal?.aborted) return stopped();
      if (done.why === 'not-opened') return { status: 'unchecked', detail: 'The window to check the page in did not open.' };
      return { status: 'unchecked', detail: `The page could not be checked: ${done.error instanceof Error ? done.error.message : String(done.error)}` };
    } finally {
      free.push(lane);
    }
  };

  return {
    check,
    dispose() {
      disposals++;
      for (const w of open) if (!w.isDestroyed()) w.destroy();
      open.clear();
    }
  };
}
