/** Typed messaging with the preview bridge running inside the site iframe. */
export const PROTOCOL = 1;

export interface BridgeMessage<T = Record<string, unknown>> {
  protocolVersion: number;
  sessionId: string;
  navigationId: string;
  revision: number;
  type: string;
  payload: T;
}

/**
 * What the frame shows, as the editor last learned it: the navigation its page arrived by (each load of a page, and
 * each move to another page in place, has its own) and the latest revision the page reported it shows.
 */
export interface FrameView {
  navigationId: string;
  revision: number;
}

/** The parts of an iframe and a message event the bridge reads (an HTMLIFrameElement and a MessageEvent are these). */
export interface BridgeFrame {
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}
export interface BridgeEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

const MAX_MESSAGE_CHARS = 200_000;
const MAX_NAVIGATION_CHARS = 100;

/**
 * Reports about the page as the frame shows it (picks, the pointer, geometry, an inspection): one from a navigation the
 * editor has moved past, or from a revision older than the page has since reported showing, describes something no
 * longer there and is dropped. A measurement the editor waits on (`measured`, `spaceMeasured`, `pointed`) is let
 * through for its waiter to settle as unmeasured when `staleFor` says so, so nothing waits on an answer never coming.
 * Everything else keeps its own checks: an inline edit's commit or cancel is matched to the edit it ends and checked
 * against the project before it is applied, so it is kept for recovery whatever page or revision it comes from.
 */
const VIEW_MESSAGES = new Set(['select', 'dblclick', 'contextmenu', 'hover', 'key', 'rects', 'inspectResult']);
/** Reports that move the view on within the document the frame shows: only that document's count. */
const VIEW_UPDATES = new Set(['navigated', 'revisionApplied']);

export function newSessionId(): string {
  return 'so-' + crypto.getRandomValues(new Uint32Array(3)).join('-');
}

/** The document a navigation ID belongs to: the frame names each navigation `{document}.{n}`. */
export function documentOf(navigationId: string): string {
  const at = navigationId.lastIndexOf('.');
  return at > 0 ? navigationId.slice(0, at) : navigationId;
}

/** How many times the document had moved to another page in place when it sent the ID (-1 for an unnumbered one). */
function stepOf(navigationId: string): number {
  const n = Number(navigationId.slice(navigationId.lastIndexOf('.') + 1));
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}

/** Whether `navigationId` is the navigation `view` shows or a later one of the same document. */
function sameOrLater(navigationId: string, view: FrameView): boolean {
  return documentOf(navigationId) === documentOf(view.navigationId) && stepOf(navigationId) >= stepOf(view.navigationId);
}

/** Whether `m`, a report about the page, comes from a navigation or revision other than the one `view` shows. */
export function staleFor(m: BridgeMessage, view: FrameView | null): boolean {
  return !view || m.navigationId !== view.navigationId || m.revision < view.revision;
}

/** The view a report establishes or moves on to: `ready` starts one, `navigated` and `revisionApplied` advance it. */
export function viewAfter(m: BridgeMessage, view: FrameView | null): FrameView | null {
  if (m.type === 'ready') return { navigationId: m.navigationId, revision: m.revision };
  if (!view || !VIEW_UPDATES.has(m.type) || !sameOrLater(m.navigationId, view)) return view;
  if (m.type === 'navigated') return { navigationId: m.navigationId, revision: Math.max(view.revision, m.revision) };
  return { navigationId: view.navigationId, revision: Math.max(view.revision, m.revision) };
}

/**
 * Validate sender window, origin, session, envelope and size. Returns the message or null.
 *
 * Given the `view` the caller holds (null before the frame reported any), also drops a report about the page from a
 * navigation or revision that view has moved past, and a `navigated` or `revisionApplied` from another document or an
 * earlier navigation of this one. A caller that passes no view does its own matching.
 */
export function acceptMessage(e: BridgeEvent, frame: BridgeFrame | null, origin: string | null, sessionId: string, view?: FrameView | null): BridgeMessage | null {
  if (!frame || e.source !== frame.contentWindow) return null;
  if (!origin || e.origin !== origin) return null;
  const m = e.data as BridgeMessage;
  if (!m || typeof m !== 'object' || m.protocolVersion !== PROTOCOL || m.sessionId !== sessionId || typeof m.type !== 'string') return null;
  if (typeof m.navigationId !== 'string' || !m.navigationId || m.navigationId.length > MAX_NAVIGATION_CHARS) return null;
  if (!Number.isSafeInteger(m.revision) || m.revision < 0) return null;
  // Handlers read fields off the payload: it must be a plain object.
  if (!m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) return null;
  try {
    if (JSON.stringify(m).length > MAX_MESSAGE_CHARS) return null;
  } catch {
    return null;
  }
  if (view !== undefined) {
    if (VIEW_MESSAGES.has(m.type) && staleFor(m, view)) return null;
    if (VIEW_UPDATES.has(m.type) && (!view || !sameOrLater(m.navigationId, view))) return null;
  }
  return m;
}

/**
 * Send a command to the frame, stamped with the navigation and revision the editor last knew it to show (`view`), so
 * the frame can tell a command meant for a page it has since left.
 */
export function postToFrame(frame: BridgeFrame | null, origin: string | null, sessionId: string, type: string, payload: unknown = {}, view?: FrameView | null) {
  if (!frame?.contentWindow || !origin) return;
  frame.contentWindow.postMessage({ protocolVersion: PROTOCOL, sessionId, navigationId: view?.navigationId ?? '', revision: view?.revision ?? 0, type, payload }, origin);
}
