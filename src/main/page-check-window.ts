/**
 * The website export's check that each built page still shows its content once it starts in a browser (#1534), run in
 * the app: each page in a window of its own that is never shown or focused, opened for the one check and destroyed
 * after it (main/hidden-page). The steps of the check are main/page-check's, spoken through the window's DevTools
 * session.
 */
import type { BrowserWindow } from 'electron';
import { guardedSession, inHiddenPage } from './hidden-page';
import { checkBuiltPage, type PageCheck } from './page-check';

/** The windows' own session: in memory, shared with nothing else. */
const PARTITION = 'siteorigin-export-check';
/** The width pages are opened at, as a laptop's. */
const WIDTH = 1280;

export interface PageChecker {
  /** Open the built page at `url` and say whether it still shows its content once started. */
  check(url: string, signal?: AbortSignal): Promise<PageCheck>;
  /** Destroy every window still checking a page. */
  dispose(): void;
}

export function createPageChecker(): PageChecker {
  const open = new Set<BrowserWindow>();
  const stopped = (): PageCheck => ({ status: 'unchecked', detail: 'The check was stopped.' });

  const check = async (url: string, signal?: AbortSignal): Promise<PageCheck> => {
    if (signal?.aborted) return stopped();
    const done = await inHiddenPage({ session: guardedSession(PARTITION), width: WIDTH, signal, open }, (page, gone) => checkBuiltPage(page, url, { signal: gone }));
    if (done.ok) {
      if (done.value.status === 'unchecked' && done.lost && !signal?.aborted) return { status: 'unchecked', detail: 'The page stopped responding.' };
      return done.value;
    }
    if (signal?.aborted) return stopped();
    if (done.why === 'not-opened') return { status: 'unchecked', detail: 'The window to check the page in did not open.' };
    return { status: 'unchecked', detail: `The page could not be checked: ${done.error instanceof Error ? done.error.message : String(done.error)}` };
  };

  return {
    check,
    dispose() {
      for (const w of open) if (!w.isDestroyed()) w.destroy();
      open.clear();
    }
  };
}
