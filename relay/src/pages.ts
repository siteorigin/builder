import { statusPage, type StatusPage } from '../../src/shared/status-page';

/**
 * What a guest's browser is shown when the relay turns it away. A browser opening an address in a tab gets a page
 * (src/shared/status-page.ts) that says what happened and what to do now; the app, the viewer's script and every other
 * client keep the plain line textResponse answers with. Status codes and the answer's own headers never change.
 *
 * Which page is chosen by the refusal, never by its words: the Worker names its own by where it turned the request
 * away (refusalKind), and a room names its answers to the preview with INTERNAL_HEADERS.page.
 */
export type RefusalKind = 'invite-not-found' | 'room-address' | 'not-found' | 'preview-private' | 'access-ended' | 'session-ended' | 'host-away' | 'busy' | 'unavailable';

const PAGES: Record<RefusalKind, Pick<StatusPage, 'title' | 'heading' | 'text' | 'next' | 'action' | 'icon' | 'tone'>> = {
  'invite-not-found': {
    title: 'Invite link not found',
    heading: 'This invite link doesn’t work',
    text: 'Part of it may be missing or mistyped. Open it exactly as the host sent it.',
    next: 'If it still doesn’t work, ask the host for a new invite link.',
    icon: 'unlink',
    tone: 'amber'
  },
  // An address of a real live session that is not its invite link (its socket, a path under it).
  'room-address': {
    title: 'Not the invite link',
    heading: 'This isn’t the invite link',
    text: 'Use the invite link to open the live session.',
    icon: 'unlink'
  },
  'not-found': {
    title: 'Page not found',
    heading: 'Page not found',
    text: 'There’s nothing to open at this address.',
    next: 'If you were invited to a live session, open the link the host sent you.',
    icon: 'unlink'
  },
  'preview-private': {
    title: 'Preview is private',
    heading: 'This preview is private',
    text: 'It’s a website being shown in a live session, and only guests the host lets in can see it.',
    next: 'To ask to join, open the invite link the host sent you.',
    icon: 'lock'
  },
  'access-ended': {
    title: 'Access changed',
    heading: 'Your access has changed',
    text: 'You need to join the live session again to see this preview.',
    next: 'Open the invite link again. If you still can’t see the preview, ask the host to let you back in.',
    icon: 'clock'
  },
  'session-ended': {
    title: 'Session ended',
    heading: 'This session has ended',
    text: 'There’s no live session at this address any more.',
    next: 'Ask the host for a new invite link to meet again.',
    icon: 'done'
  },
  'host-away': {
    title: 'Host not connected',
    heading: 'The host isn’t connected',
    text: 'The host needs to reconnect before you can see the preview again.',
    action: { label: 'Try again', href: '' },
    icon: 'host',
    tone: 'amber'
  },
  busy: {
    title: 'Preview busy',
    heading: 'The preview is busy',
    text: 'It’s loading too many pages at once.',
    action: { label: 'Try again', href: '' },
    icon: 'alert',
    tone: 'amber'
  },
  unavailable: {
    title: 'Live sessions unavailable',
    heading: 'Live sessions aren’t available here',
    text: 'This address can’t open live sessions right now.',
    next: 'Try again later, or let the host know.',
    icon: 'alert',
    tone: 'red'
  }
};

/**
 * Whether a request is a browser opening a page, which is shown one rather than a line of text. With Fetch Metadata,
 * only a top-level navigation is; without it (an older browser, plain HTTP to a remote host), only a request that
 * asks for HTML by name. `*∕*`, the app's own requests and every other destination keep the text.
 */
export function wantsPage(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.has('upgrade')) return false;
  const dest = request.headers.get('sec-fetch-dest');
  if (dest !== null) return dest === 'document';
  return (request.headers.get('accept') ?? '').split(',').some((range) => {
    const [type, ...params] = range.split(';').map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith('q='));
    return type === 'text/html' && (q === undefined || Number(q.slice(2)) > 0);
  });
}

/** Both answers to a negotiated request say what they were chosen by, so no cache hands one to the other. */
export const NEGOTIATED_BY = 'Sec-Fetch-Dest, Accept';

/** Add the negotiation's fields to a response's Vary, keeping any it already has (CORS's Origin). */
export function varyByNegotiation(headers: Headers): void {
  const vary = headers.get('vary');
  headers.set('vary', vary ? `${vary}, ${NEGOTIATED_BY}` : NEGOTIATED_BY);
}

/**
 * The page for a refusal, with the refusal's status and headers (Allow, Retry-After) kept. `mark` is the relay's own
 * mark as this page's origin reaches it: the relay's host serves it, and a room's preview origin names the relay's.
 */
export function refusalPage(request: Request, refusal: Response, kind: RefusalKind, mark: string | null, action?: StatusPage['action']): Response {
  const body = statusPage({ ...PAGES[kind], ...(action ? { action } : {}), brand: mark ? { mark } : {} });
  // No frame-ancestors: a browser without Fetch Metadata asking for the viewer's frame with Accept: text/html is shown
  // this page there, and the page is harmless anywhere.
  return pageResponse(request, refusal, body, `default-src 'none'; style-src 'unsafe-inline'; img-src ${mark ? `${new URL(mark).origin} ` : ''}data:; base-uri 'none'; form-action 'none'`);
}

/** A page in place of a refusal: its status and its own headers (Allow, Retry-After, Upgrade, Vary) kept. */
function pageResponse(request: Request, refusal: { status: number; headers: Headers }, body: string, csp: string): Response {
  const headers = new Headers(refusal.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('content-security-policy', csp);
  if (!headers.get('vary')?.includes(NEGOTIATED_BY)) varyByNegotiation(headers);
  headers.delete('content-length');
  return new Response(request.method === 'HEAD' ? null : body, { status: refusal.status, headers });
}

/**
 * Inside the viewer's frame, the guest is already in the session, so access the relay no longer grants is said as the
 * preview being unavailable, with the way on from where they are.
 */
const FRAMED_ACCESS: Pick<StatusPage, 'title' | 'heading' | 'next' | 'icon'> = {
  title: 'Preview unavailable',
  heading: 'The preview isn’t available',
  next: 'Reload this page to try again. If it still doesn’t open, ask the host to let you back in.',
  icon: 'lock'
};

/**
 * The relay's answer to a page the viewer's frame asked for, drawn as the viewer's notice over its frame (which
 * already names the product). For a refusal, `bridge` is the reload bridge, marked data-refused: the viewer covers
 * this page with its own notice as soon as the bridge tells it, so the page shows only where the bridge does not run.
 */
export function framedRefusalPage(request: Request, refusal: { status: number; headers: Headers }, kind: RefusalKind, bridge: string | null): Response {
  const copy =
    kind === 'preview-private'
      ? { ...FRAMED_ACCESS, text: 'This page couldn’t confirm you’re still in the live session.' }
      : kind === 'access-ended'
        ? { ...FRAMED_ACCESS, text: 'Your access to this preview has changed.' }
        : PAGES[kind];
  const body = statusPage({ ...copy, framed: true, head: bridge ? `<script src="${bridge}" data-refused></script>\n` : undefined });
  return pageResponse(request, refusal, body, `default-src 'none';${bridge ? ` script-src ${new URL(bridge).origin};` : ''} style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`);
}

/** Whether a refusal is for the viewer's frame, which is shown the viewer's notice rather than a line of text. */
export function wantsFramedPage(request: Request): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('upgrade') && request.headers.get('sec-fetch-dest') === 'iframe';
}
