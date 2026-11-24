/**
 * Which of the preview frame's page reports the editor follows. The editor asks the frame for a page (the page
 * picker, Pages, an Undo that took the page shown away), and the frame reports each page it lands on: the one
 * the editor asked for, or while previewing one a visitor's link or Back went to. Reports from one frame arrive
 * in order, but one sent before the editor's latest request reached the frame is about a page the author has
 * since left: following it would switch the page back, if only until the request lands.
 */
export interface FrameNav {
  seq: number;
  /** The editor's latest request, until the frame reports landing on it. */
  request: { path: string; id: number } | null;
  /** The page the frame was last asked for or followed to. A different page shown in the editor was chosen
   *  there and has not been asked for yet (its request follows the render that shows it). */
  asked: string | null;
  /** The address last asked for or followed: while editing, the frame goes nowhere else. */
  route: string | null;
}

export const newFrameNav = (): FrameNav => ({ seq: 0, request: null, asked: null, route: null });

/** Whether two site addresses name the same page (one may have the trailing slash the other lacks). */
export const samePath = (a: string, b: string | null) => !!b && (a === b || a === b + '/' || a + '/' === b);

/** The editor shows `pageId`: ask the frame to open `path`, or with null, note that it is already there. Returns
 *  the request's id, which the frame sends back with its report of landing there. */
export function askFrame(nav: FrameNav, pageId: string, path: string | null): number | null {
  nav.asked = pageId;
  if (path === null) return null;
  nav.route = path;
  nav.request = { path, id: ++nav.seq };
  return nav.request.id;
}

/**
 * Whether to follow the frame's report that it is now at `path` (`navId`: the editor request it landed for, or
 * null for the frame's own navigation). `pageId` is the page the editor shows. A followed report settles the
 * request it answers.
 */
export function followReport(nav: FrameNav, path: string, navId: number | null, pageId: string | null, previewing: boolean): boolean {
  // A page chosen in the editor that the frame has not been asked for yet wins.
  if (pageId !== nav.asked) return false;
  // A report for an earlier request is about a page the author has since left.
  if (navId !== null && navId !== nav.request?.id) return false;
  if (nav.request) {
    // While the editor's latest request is on its way, only the frame's report of landing there counts: not an
    // earlier request's, nor a visitor's link the author's choice overtook.
    if (navId !== nav.request.id) return false;
    nav.request = null;
  } else if (!previewing && nav.route !== null && !samePath(path, nav.route)) return false;
  nav.route = path;
  return true;
}

/** The page the editor shows after following a report (unchanged when the address is not one of the site's). */
export function followed(nav: FrameNav, pageId: string | null): void {
  nav.asked = pageId;
}
