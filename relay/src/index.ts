import { newRoomId, PREVIEW_HOST_LABEL_RE, previewHostLabel } from '../../src/shared/live/crypto';
import { DISPLAY_NAME_MAX, LIVE_PROTOCOL_VERSION, MAX_PREVIEW_HEADERS, ROOM_ID_RE } from '../../src/shared/live/limits';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewTarget } from '../../src/shared/live/preview';
import { formatInviteLink, HOST_SOCKET_PATH, PREVIEW_ADMISSION_PATH, relaySocketUrl, roomPreviewOrigin, roomSocketPath } from '../../src/shared/live/relay-url';
import { MAX_ADMISSION_BODY_BYTES, previewCookieName, previewCookieValues } from './admission';
import { hasSigningKey, relayOrigin, type Env } from './config';
import { escapeHtml } from '../../src/shared/status-page';
import { INTERNAL_HEADERS, isRefusal, readBoundedText, roomRequest, textResponse } from './http';
import { framedRefusalPage, refusalPage, varyByNegotiation, wantsFramedPage, wantsPage, type RefusalKind } from './pages';

export { SessionRoom } from './session-room';

/**
 * The relay's front door. It allocates rooms, sends each room's traffic to that room's SessionRoom object, and turns
 * away anything malformed before an object is woken. It holds no state of its own: rooms live in their objects, and
 * nothing about a project, a person or an account is stored anywhere.
 *
 * Its refusals are a line of text for the app and the viewer's script, and a page (pages.ts) for a browser opening the
 * address in a tab: a guest following a mistyped or ended link, or opening the preview on its own.
 *
 * Two kinds of host, and each serves only its own routes (src/shared/live/relay-url.ts names them):
 * - The relay's own host, where the viewer lives:
 *   - `GET /ws/host` (WebSocket): open a new room; the host's first frame is room:create.
 *   - `GET /s/:roomId/ws` (WebSocket): a host reconnecting, or a guest joining.
 *   - `GET /s/:roomId`: the invite link: the guest's viewer, a waiting room and then the live preview.
 *   - `GET /_viewer/*`: the viewer's script and styles (VIEWER_FILES).
 * - Each room's preview origin, `p-<label>.<relay host>` (previewHostLabel), where the host's site sits at the root:
 *   - `POST /__siteorigin/admission`: an admitted guest's page redeems its preview ticket for the preview cookie.
 *   - `GET /__siteorigin/live.js`: the reload bridge the relay adds to the preview's pages in the viewer's frame.
 *   - `GET|HEAD /*`: the host's preview, tunnelled over the host's socket, for admitted guests.
 *
 * Every room's preview is its own origin so that the site code running in it, which its host controls, can reach
 * neither another room's preview nor the viewer's pages. Both kinds of host share one registrable domain, used for
 * nothing else, so the preview cookie is first-party to the viewer's iframe in every browser.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = relayOrigin(env);
    const preview = origin === false ? null : previewHost(url, origin);
    const response = await route(request, env, url, origin, preview);
    if (!isRefusal(response) || !negotiable(request)) return response;
    varyByNegotiation(response.headers);
    // A host the relay does not answer for has no invite links, whatever its path looks like.
    const kind = refusalKind(url, preview, response.status, !origin || url.origin === origin);
    if (wantsFramedPage(request)) return framedRefusalPage(request, response, kind, null);
    if (!wantsPage(request)) return response;
    const room = !preview && kind === 'room-address' ? `/s/${url.pathname.split('/')[2]}` : null;
    return refusalPage(request, response, kind, markFor(url, origin, preview), room ? { label: 'Open the invite link', href: room } : undefined);
  }
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL, origin: string | null | false, preview: PreviewHost | null): Promise<Response> {
  if (origin === false) return textResponse(503, 'This relay’s RELAY_ORIGIN is not an origin.');
  if (preview) return previewRoute(request, env, url, preview);
  if (origin && url.origin !== origin) return textResponse(404, 'Not found.');
  if (url.pathname === HOST_SOCKET_PATH) return openRoom(request, env);
  if (Object.hasOwn(VIEWER_FILES, url.pathname)) return viewerFile(request, env, VIEWER_FILES[url.pathname]);
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match || !ROOM_ID_RE.test(match[1])) return textResponse(404, 'Not found.');
  const roomId = match[1];
  const rest = match[2] ?? '';
  if (rest === '' || rest === '/') return guestPage(request, origin ?? url.origin, roomId);
  if (rest === '/ws') return connect(request, env, roomId);
  return textResponse(404, 'Not found.');
}

/** A request a page could answer: one a browser can open, as against a socket, a form or the viewer's ticket. */
function negotiable(request: Request): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('upgrade');
}

/** The page for one of the Worker's own refusals, by where it turned the request away. */
function refusalKind(url: URL, preview: PreviewHost | null, status: number, onRelay: boolean): RefusalKind {
  if (status >= 500) return 'unavailable';
  if (preview && status === 401) return 'preview-private';
  if (!preview && url.pathname.startsWith('/s/')) return status === 404 && !onRelay ? 'not-found' : ROOM_ID_RE.test(url.pathname.split('/')[2]) ? 'room-address' : 'invite-not-found';
  return 'not-found';
}

/**
 * The relay's mark, by an address the page's origin can load it from: a room's preview names the relay's own host.
 * None when the relay is misconfigured, which answers every address with the same refusal, the mark's included.
 */
function markFor(url: URL, origin: string | null | false, preview: PreviewHost | null): string | null {
  return origin === false ? null : `${preview?.viewerOrigin ?? (origin || url.origin)}${VIEWER_MARK_PATH}`;
}

interface PreviewHost {
  /** The host's first label, which names the room's object. */
  label: string;
  /** The relay origin the room's viewer runs on: the preview's own origin less its first label. */
  viewerOrigin: string;
}

/**
 * The preview origin a request is for, or null for any other host. With RELAY_ORIGIN set (in production), only
 * a `p-<label>` directly under that host, on its scheme and port, is one; without it (local development and tests),
 * any host whose first label has that form is.
 */
function previewHost(url: URL, origin: string | null): PreviewHost | null {
  const dot = url.hostname.indexOf('.');
  if (dot < 0 || !PREVIEW_HOST_LABEL_RE.test(url.hostname.slice(0, dot))) return null;
  const rest = url.hostname.slice(dot + 1);
  // The viewer is never itself a preview: `p-<b>.p-<a>.…` would let room A's pages redeem tickets as B's viewer.
  if (/^p-/.test(rest)) return null;
  const viewer = new URL(url.origin);
  viewer.hostname = rest;
  if (origin && viewer.origin !== origin) return null;
  return { label: url.hostname.slice(0, dot), viewerOrigin: viewer.origin };
}

async function previewRoute(request: Request, env: Env, url: URL, host: PreviewHost): Promise<Response> {
  if (request.headers.get('upgrade')) return textResponse(404, 'Not found.');
  if (url.pathname === PREVIEW_BRIDGE_PATH) return viewerFile(request, env, 'preview-bridge.js');
  if (url.pathname === PREVIEW_ADMISSION_PATH) {
    if (request.method === 'OPTIONS') return admissionPreflight(request, host);
    if (request.method === 'POST') return admission(request, env, url, host);
    return textResponse(405, 'Redeem a preview ticket with POST.', { allow: 'POST, OPTIONS' });
  }
  return preview(request, env, url, host);
}

/** Whether a request is a WebSocket upgrade, or the answer to give one that is not. */
function upgradeProblem(request: Request): Response | null {
  if (request.method !== 'GET') return textResponse(405, 'Open this address as a WebSocket.', { allow: 'GET' });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return textResponse(426, 'Open this address as a WebSocket.', { upgrade: 'websocket' });
  return null;
}

async function openRoom(request: Request, env: Env): Promise<Response> {
  const problem = upgradeProblem(request);
  if (problem) return problem;
  if (!hasSigningKey(env)) return textResponse(503, 'This relay is not configured to open rooms.');
  // Cloudflare sets the client's address; a request with none (only possible locally) shares one allowance.
  const { success } = await env.ROOM_CREATION_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!success) return textResponse(429, 'Too many new live sessions from this address. Try again in a minute.', { 'retry-after': '60' });
  const roomId = newRoomId();
  return (await roomObject(env, roomId)).fetch(roomRequest('/create', roomId, { headers: { upgrade: 'websocket' } }));
}

async function connect(request: Request, env: Env, roomId: string): Promise<Response> {
  const problem = upgradeProblem(request);
  if (problem) return problem;
  // Per address and room, so one invitee opening socket after socket cannot crowd out the rest of the room.
  const { success } = await env.ROOM_CONNECT_LIMITER.limit({ key: `${roomId}:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
  if (!success) return textResponse(429, 'Too many connections to this live session from this address. Try again in a minute.', { 'retry-after': '60' });
  return (await roomObject(env, roomId)).fetch(roomRequest('/connect', roomId, { headers: { upgrade: 'websocket' } }));
}

/**
 * A room's object. Each is named by its preview host's label rather than by the room ID, so a preview request finds
 * its room from the host it came to, and the relay's own routes, which carry the room ID, reach the same object.
 */
async function roomObject(env: Env, roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(await previewHostLabel(roomId)));
}

/** CORS for ticket redemption, which only the room's own viewer may make: the viewer's origin, with credentials. */
function admissionCors(host: PreviewHost): Record<string, string> {
  return { 'access-control-allow-origin': host.viewerOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}

/** The viewer's redemption is a JSON POST from its own origin to the preview's, so the browser asks first. */
function admissionPreflight(request: Request, host: PreviewHost): Response {
  const asked = request.headers.get('access-control-request-method');
  if (request.headers.get('origin') !== host.viewerOrigin || asked !== 'POST') return textResponse(403, 'Only this live session’s viewer can redeem its preview tickets.', { vary: 'Origin' });
  return new Response(null, {
    status: 204,
    headers: { ...admissionCors(host), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', 'cache-control': 'no-store' }
  });
}

async function admission(request: Request, env: Env, url: URL, host: PreviewHost): Promise<Response> {
  // A browser always names the page asking; any page but the room's viewer is refused. A client with no Origin (the
  // app's own main process, the tests) holds the ticket itself, and the ticket is what is checked.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== host.viewerOrigin) return textResponse(403, 'Only this live session’s viewer can redeem its preview tickets.', { vary: 'Origin' });
  const cors = origin === null ? {} : admissionCors(host);
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return textResponse(415, 'Send the ticket as JSON.', cors);
  const body = await readBoundedText(request, MAX_ADMISSION_BODY_BYTES);
  if (body === null) return textResponse(413, 'That request is too large.', cors);
  const response = await env.ROOMS.get(env.ROOMS.idFromName(host.label)).fetch(
    roomRequest('/admission', null, { method: 'POST', headers: { 'content-type': 'application/json', [INTERNAL_HEADERS.secure]: isHttps(request, url) ? '1' : '0' }, body })
  );
  if (origin === null) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Whether the guest reached the relay over HTTPS, so its cookie is marked Secure. Cloudflare sets X-Forwarded-Proto
 * itself; either signal only ever adds Secure, so a client claiming HTTPS over plain HTTP only loses its own cookie.
 */
function isHttps(request: Request, url: URL): boolean {
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto')?.toLowerCase() === 'https';
}

/**
 * Why a browser's request is not one the preview serves, from its Fetch Metadata, or null when it is. The preview's
 * own pages load what they like from it, and any page may navigate to it (it still needs the cookie); nothing else
 * may load its files, so another room's preview, which is same-site and so is sent this room's cookie, cannot pull
 * them in as scripts, images or fetches. A preview may not install a service worker either: one would go on
 * answering for the site after the guest's access ends. Requests without the headers (old browsers, non-browser
 * clients) are left to the cookie.
 */
function fetchMetadataProblem(headers: Headers): string | null {
  if (headers.has('service-worker')) return 'A live session’s preview cannot install a service worker.';
  const site = headers.get('sec-fetch-site');
  if (site === null || site === 'same-origin' || headers.get('sec-fetch-mode') === 'navigate') return null;
  return 'Only the preview’s own pages can load its files.';
}

async function preview(request: Request, env: Env, url: URL, host: PreviewHost): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'The preview is read-only.', { allow: 'GET, HEAD' });
  // The path and query as the browser asked for them: the site is at the preview origin's root.
  const target = `${url.pathname}${url.search}`;
  if (!isPreviewTarget(target)) return textResponse(404, 'Not found.');
  const problem = fetchMetadataProblem(request.headers);
  if (problem) return textResponse(403, problem);
  const secure = isHttps(request, url);
  const values = previewCookieValues(request.headers.get('cookie'), secure);
  // A page for the viewer's frame is always asked for whole, so what comes back is a page the bridge can be added to:
  // never a 304 that would bring back a copy the browser kept without it, nor part of one.
  const framed = request.headers.get('sec-fetch-dest') === 'iframe';
  if (values.length === 0) return framed ? framedRefusalPage(request, { status: 401, headers: new Headers() }, 'preview-private', bridgeUrl(url)) : textResponse(401, 'Join this live session to see its preview.');
  const name = previewCookieName(secure);
  const headers: Record<string, string> = { cookie: values.map((value) => `${name}=${value}`).join('; '), [INTERNAL_HEADERS.method]: request.method, [INTERNAL_HEADERS.target]: target, [INTERNAL_HEADERS.secure]: secure ? '1' : '0' };
  let passed = 0;
  for (const [headerName, value] of request.headers) {
    if (framed && FRAMED_DROPPED_HEADERS.has(headerName)) continue;
    if (passed < MAX_PREVIEW_HEADERS && isPreviewHeaderName(headerName, 'request') && isPreviewHeaderValue(value)) {
      headers[headerName] = value;
      passed++;
    }
  }
  const response = await env.ROOMS.get(env.ROOMS.idFromName(host.label)).fetch(roomRequest('/preview', null, { headers, signal: request.signal }));
  // The room names the page each of its own answers is shown as, so a host's own 401 or 404 page is never taken for
  // one, and marks the refusals among them (a cookie it no longer honours, access that ended), which the viewer's frame
  // reports as such. The marks are the relay's own and never leave it.
  const kind = response.headers.get(INTERNAL_HEADERS.page) as RefusalKind | null;
  if (kind !== null) {
    const refused = response.headers.get(INTERNAL_HEADERS.refused) === '1';
    const answer = new Response(response.body, { status: response.status, headers: response.headers });
    answer.headers.delete(INTERNAL_HEADERS.refused);
    answer.headers.delete(INTERNAL_HEADERS.page);
    varyByNegotiation(answer.headers);
    if (framed) return framedRefusalPage(request, answer, kind, refused ? bridgeUrl(url) : null);
    return wantsPage(request) ? refusalPage(request, answer, kind, `${host.viewerOrigin}${VIEWER_MARK_PATH}`) : answer;
  }
  return framed ? withReloadBridge(request, url, response) : response;
}

/**
 * The reload bridge's address on this preview origin. On the relay's refusal of a page the viewer's frame asked for
 * (pages.ts, framedRefusalPage) it is marked data-refused, so it tells the viewer the preview was refused rather than
 * that a page is ready, and the viewer says so with its way to try again instead of showing that page as live.
 */
function bridgeUrl(url: URL): string {
  return `${url.origin}${PREVIEW_BRIDGE_PATH}`;
}

/** The request headers a page for the viewer's frame goes without (see preview()). */
const FRAMED_DROPPED_HEADERS = new Set(['if-none-match', 'if-modified-since', 'if-range', 'range']);

/**
 * Where, on a room's preview origin, the relay serves the reload bridge. A first segment starting with `__` is never
 * one a guest may ask the preview for (preview.ts), so it cannot hide a file of the site.
 */
const PREVIEW_BRIDGE_PATH = '/__siteorigin/live.js';

/**
 * A page of the preview loaded in the viewer's frame, with the relay's reload bridge (viewer/preview-bridge.js) added
 * to it: when the host's project changes, the viewer asks the bridge to reload the page the guest is on, where it is
 * scrolled to, which the viewer cannot do itself across origins. Every HTML page with a body is changed, an error page
 * too (the guest may be on one when the host fixes it); anything else passes as it is, and so does a page in an
 * encoding other than UTF-8, which the rewriter cannot read. The page's own validators and length describe the host's
 * bytes, not these, so they go. The bridge's address is absolute, so a `<base>` the page sets cannot send it elsewhere.
 */
function withReloadBridge(request: Request, url: URL, response: Response): Response {
  const type = response.headers.get('content-type') ?? '';
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1].toLowerCase();
  const bodyless = response.status < 200 || response.status === 204 || response.status === 206 || (response.status >= 300 && response.status < 400);
  if (request.method !== 'GET' || bodyless || !/^text\/html\s*(;|$)/i.test(type) || (charset !== undefined && charset !== 'utf-8' && charset !== 'utf8')) return response;
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'etag', 'last-modified', 'accept-ranges']) headers.delete(name);
  const tag = `<script src="${url.origin}${PREVIEW_BRIDGE_PATH}"></script>`;
  // In the head when the page has one, else at the start of its body, else at its end.
  let added = false;
  const add = {
    element(element: Element) {
      if (added) return;
      added = true;
      element.prepend(tag, { html: true });
    }
  };
  return new HTMLRewriter()
    .on('head', add)
    .on('body', add)
    .onDocument({
      end(end) {
        if (!added) end.append(tag, { html: true });
      }
    })
    .transform(new Response(response.body, { status: response.status, headers }));
}

/** The app's mark, which the relay's own pages show beside its name (VIEWER_FILES). */
const VIEWER_MARK_PATH = '/_viewer/mark.svg';

/**
 * The viewer's own files, by the path the guest's page loads them from on the relay's host. Each is served only at
 * its path here, from the Worker's assets (relay/viewer/), so the asset directory's layout is never itself a route.
 */
const VIEWER_FILES: Record<string, string> = {
  '/_viewer/viewer.js': 'viewer.js',
  '/_viewer/shared.js': 'shared.js',
  '/_viewer/viewer.css': 'viewer.css',
  '/_viewer/mark.svg': 'mark.svg'
};

/** One of the viewer's files from the Worker's assets, never cached past a deploy and never sniffed as another type. */
async function viewerFile(request: Request, env: Env, file: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Not allowed.', { allow: 'GET, HEAD' });
  const asset = await env.ASSETS.fetch(new Request(new URL(`/${file}`, request.url), { method: request.method }));
  if (!asset.ok) return textResponse(404, 'Not found.');
  const headers = new Headers(asset.headers);
  headers.set('cache-control', 'no-cache');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers });
}

/**
 * The invite link's page: the guest's viewer. It is the same for every well-formed room ID, whether or not the room is
 * open, so the page never says which rooms exist; the viewer finds out on the room's socket. Everything the page needs
 * to reach its room (the socket, the room's preview origin, the invite link) is worked out here and written into it,
 * and its Content Security Policy names exactly those: it may connect to its room's socket and preview origin, frame
 * that preview, and load nothing but the viewer's own files.
 */
async function guestPage(request: Request, relay: string, roomId: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Not allowed.', { allow: 'GET, HEAD' });
  let previewOrigin: string;
  try {
    previewOrigin = await roomPreviewOrigin(relay, roomId);
  } catch (error) {
    return textResponse(503, `This relay cannot serve live sessions at this address: ${error instanceof Error ? error.message : String(error)}`);
  }
  const socketUrl = relaySocketUrl(relay, roomSocketPath(roomId));
  const attrs = {
    'data-room-id': roomId,
    'data-socket-url': socketUrl,
    'data-preview-origin': previewOrigin,
    'data-invite-link': formatInviteLink(relay, roomId),
    'data-protocol-version': String(LIVE_PROTOCOL_VERSION),
    'data-name-max': String(DISPLAY_NAME_MAX)
  };
  const data = Object.entries(attrs)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(' ');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>Live session · SiteOrigin Builder</title>
<link rel="icon" href="/_viewer/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="/_viewer/viewer.css">
<script type="module" src="/_viewer/viewer.js"></script>
</head>
<body>
<div class="app" id="live-session" ${data} data-phase="name">
<header class="bar" id="bar" hidden>
  <div class="bar-title"><img class="mark" src="/_viewer/mark.svg" alt="" width="24" height="24"><span class="site-stack"><span class="site" id="site-title" tabindex="-1"></span><span class="site-role" id="site-role" hidden>Collaborator</span></span><span class="pill" id="connection"></span></div>
  <div class="bar-meta"><span class="badge" id="role"></span><span class="badge time" id="time" hidden></span></div>
  <button type="button" class="icon-btn bar-more" id="bar-more" aria-expanded="false" aria-controls="bar-controls" aria-label="View options"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg></button>
  <div class="bar-controls" id="bar-controls">
    <p class="panel-role" id="panel-role"></p>
    <div class="control">
      <span class="control-label" id="width-label">Width</span>
      <div class="segmented" role="group" aria-labelledby="width-label">
        <button type="button" data-viewport="host" aria-pressed="false">Host’s</button>
        <button type="button" data-viewport="desktop" aria-pressed="false">Desktop</button>
        <button type="button" data-viewport="tablet" aria-pressed="false">Tablet</button>
        <button type="button" data-viewport="mobile" aria-pressed="false">Mobile</button>
      </div>
    </div>
    <label class="switch-row"><input type="checkbox" role="switch" id="follow" checked><span>Follow host’s page</span></label>
    <button type="button" class="btn" id="point" aria-pressed="false" disabled title="Click something on the site to point it out to the host"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg><span>Point</span></button>
    <button type="button" class="btn" id="copy-invite" aria-expanded="false" aria-controls="handoff" hidden>How to edit</button>
  </div>
</header>
<section class="handoff" id="handoff" aria-labelledby="handoff-title" aria-describedby="handoff-text" hidden>
  <div class="handoff-head"><h2 id="handoff-title" tabindex="-1">Edit with the host</h2><button type="button" class="icon-btn" id="handoff-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
  <p id="handoff-text"></p>
  <div class="handoff-row"><input type="text" class="input" id="handoff-link" readonly aria-label="Invite link"><button type="button" class="btn btn-primary" id="handoff-copy">Copy link</button></div>
</section>
<p class="host-note" id="host-note" hidden></p>
<main class="stage" id="stage" hidden>
  <p class="point-hint" id="point-hint" hidden>Click anything on the site to point it out to the host. <kbd>Esc</kbd> cancels.</p>
  <div class="frame" id="frame"></div>
  <div class="veil" id="veil" hidden>
    <div class="notice"><span class="glyph" id="veil-glyph" aria-hidden="true"></span><h2 id="veil-title" tabindex="-1"></h2><p id="veil-text"></p><p class="veil-time" id="veil-time" hidden></p><button type="button" class="btn btn-primary" id="veil-action" hidden>Try again</button></div>
  </div>
</main>
<section class="screen" id="screen">
  <div class="screen-inner">
    <p class="brand"><img class="mark" src="/_viewer/mark.svg" alt="" width="32" height="32">SiteOrigin Builder</p>
    <div class="card" id="card">
      <span class="glyph" id="screen-glyph" aria-hidden="true" hidden></span>
      <h1 id="screen-title" tabindex="-1">Join the live session</h1>
      <p id="screen-text">You’ve been invited to watch a website being designed, live. The host sees your name and decides whether to let you in; you’ll see which site once you’re in.</p>
      <form id="join" novalidate>
        <label for="name">Your name</label>
        <input id="name" class="input" name="name" autocomplete="name" autocapitalize="words" spellcheck="false" required aria-describedby="name-error">
        <p class="error" id="name-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-block" id="join-button">Ask to join</button>
        <p class="hint">No account or download needed. Not sure about this link? Check with the person who sent it.</p>
      </form>
      <p class="next" id="screen-next" hidden></p>
      <div class="actions" id="screen-actions" hidden><button type="button" class="btn btn-primary" id="screen-action" hidden></button><button type="button" class="btn" id="screen-cancel" hidden>Cancel request</button></div>
    </div>
  </div>
</section>
<p class="sr-only" id="announce" role="status"></p>
<noscript><p class="noscript">This page needs JavaScript to join a live session.</p></noscript>
</div>
</body>
</html>
`;
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${socketUrl} ${previewOrigin}`,
    `frame-src ${previewOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}
