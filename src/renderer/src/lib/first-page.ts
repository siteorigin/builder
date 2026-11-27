import type { RuntimeState } from '@shared/api';

/** What the canvas knows about a project's first page while it waits for it (Canvas). */
export interface FirstPageWait {
  /** This opening's first page has not been shown yet, and nothing has gone wrong with it: no page problem, no retry. */
  pending: boolean;
  runtime: RuntimeState['state'];
  /** The start, or the wait for it to begin, has run past what it usually takes (useSlowWait). */
  slow: boolean;
  /** The frame is given a page to load: a ready server and a route to show. */
  frameShown: boolean;
  frameReady: boolean;
  /** Editing, as a project opens: not Preview, nor a layout or a component shown in the page's place. */
  onPage: boolean;
}

/**
 * Whether the canvas outlines the project's first page: from the editor showing, through the preview starting, to the
 * page ready to edit, as one wait that continues the outline the window showed from the click (EditorSkeleton). A wait
 * with something to say keeps its card instead: the website tools being set up, a start running long, a stop, a page
 * that failed; so does one the author has moved on from, to Preview, a layout or Component Studio.
 */
export function outlinesFirstPage(w: FirstPageWait): boolean {
  if (!w.pending || !w.onPage) return false;
  if (w.runtime === 'idle' || w.runtime === 'starting') return !w.slow;
  return w.runtime === 'ready' && w.frameShown && !w.frameReady;
}
