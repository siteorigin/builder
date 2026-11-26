import { newRoomId, PREVIEW_HOST_LABEL_RE, previewHostLabel } from '../../src/shared/live/crypto';
import { MAX_PREVIEW_HEADERS, ROOM_ID_RE } from '../../src/shared/live/limits';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewTarget } from '../../src/shared/live/preview';
import { HOST_SOCKET_PATH, PREVIEW_ADMISSION_PATH } from '../../src/shared/live/relay-url';
import { MAX_ADMISSION_BODY_BYTES, previewCookieName, previewCookieValues } from './admission';
import { hasSigningKey, relayOrigin, type Env } from './config';
import { INTERNAL_HEADERS, readBoundedText, roomRequest, textResponse } from './http';

export { SessionRoom } from './session-room';

/**
 * The relay's front door. It allocates rooms, sends each room's traffic to that room's SessionRoom object, and turns
 * away anything malformed before an object is woken. It holds no state of its own: rooms live in their objects, and
 * nothing about a project, a person or an account is stored anywhere.
 *
 * Two kinds of host, and each serves only its own routes (src/shared/live/relay-url.ts names them):
 * - The relay's own host, where the viewer lives:
 *   - `GET /ws/host` (WebSocket): open a new room; the host's first frame is room:create.
 *   - `GET /s/:roomId/ws` (WebSocket): a host reconnecting, or a guest joining.
 *   - `GET /s/:roomId`: the invite link, where the guest's page will live.
 * - Each room's preview origin, `p-<label>.<relay host>` (previewHostLabel), where the host's site sits at the root:
 *   - `POST /__siteorigin/admission`: an admitted guest's page redeems its preview ticket for the preview cookie.
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
    if (origin === false) return textResponse(503, 'This relay’s RELAY_ORIGIN is not an origin.');
    const preview = previewHost(url, origin);
    if (preview) return previewRoute(request, env, url, preview);
    if (origin && url.origin !== origin) return textResponse(404, 'Not found.');
    if (url.pathname === HOST_SOCKET_PATH) return openRoom(request, env);
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !ROOM_ID_RE.test(match[1])) return textResponse(404, 'Not found.');
    const roomId = match[1];
    const rest = match[2] ?? '';
    if (rest === '' || rest === '/') return guestPage(request, roomId);
    if (rest === '/ws') return connect(request, env, roomId);
    return textResponse(404, 'Not found.');
  }
} satisfies ExportedHandler<Env>;

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
  if (values.length === 0) return textResponse(401, 'Join this live session to see its preview.');
  const name = previewCookieName(secure);
  const headers: Record<string, string> = { cookie: values.map((value) => `${name}=${value}`).join('; '), [INTERNAL_HEADERS.method]: request.method, [INTERNAL_HEADERS.target]: target, [INTERNAL_HEADERS.secure]: secure ? '1' : '0' };
  let passed = 0;
  for (const [headerName, value] of request.headers) {
    if (passed < MAX_PREVIEW_HEADERS && isPreviewHeaderName(headerName, 'request') && isPreviewHeaderValue(value)) {
      headers[headerName] = value;
      passed++;
    }
  }
  return env.ROOMS.get(env.ROOMS.idFromName(host.label)).fetch(roomRequest('/preview', null, { headers, signal: request.signal }));
}

/** The invite link's page. The guest's viewer replaces this placeholder; the route and its headers stay. */
function guestPage(request: Request, roomId: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Not allowed.', { allow: 'GET, HEAD' });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>SiteOrigin Builder live session</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#222}main{max-width:32rem;padding:2rem}</style>
</head>
<body>
<main id="live-session" data-room-id="${roomId}">
<h1>SiteOrigin Builder live session</h1>
<p>You have been invited to a live session. The viewer for live sessions is not available yet.</p>
</main>
</body>
</html>
`;
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}
