import { newRoomId } from '../../src/shared/live/crypto';
import { MAX_PREVIEW_HEADERS, ROOM_ID_RE } from '../../src/shared/live/limits';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewTarget } from '../../src/shared/live/preview';
import { HOST_SOCKET_PATH, roomPreviewPath } from '../../src/shared/live/relay-url';
import { MAX_ADMISSION_BODY_BYTES, PREVIEW_COOKIE_NAME, previewCookieValues } from './admission';
import { hasSigningKey, type Env } from './config';
import { INTERNAL_HEADERS, readBoundedText, roomRequest, textResponse } from './http';

export { SessionRoom } from './session-room';

/**
 * The relay's front door. It allocates rooms, sends each room's traffic to that room's SessionRoom object, and turns
 * away anything malformed before an object is woken. It holds no state of its own: rooms live in their objects, and
 * nothing about a project, a person or an account is stored anywhere.
 *
 * Routes (src/shared/live/relay-url.ts names them):
 * - `GET /ws/host` (WebSocket): open a new room; the host's first frame is room:create.
 * - `GET /s/:roomId/ws` (WebSocket): a host reconnecting, or a guest joining.
 * - `POST /s/:roomId/admission`: an admitted guest redeems its preview ticket for the room's preview cookie.
 * - `GET|HEAD /s/:roomId/preview/*`: the host's preview, tunnelled over the host's socket, for admitted guests.
 * - `GET /s/:roomId`: the invite link, where the guest's page will live.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === HOST_SOCKET_PATH) return openRoom(request, env);
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !ROOM_ID_RE.test(match[1])) return textResponse(404, 'Not found.');
    const roomId = match[1];
    const rest = match[2] ?? '';
    if (rest === '' || rest === '/') return guestPage(request, roomId);
    if (rest === '/ws') return connect(request, env, roomId);
    if (rest === '/admission') return admission(request, env, roomId, url);
    // The preview's root is `/preview/`: at `/preview` a page's relative links would resolve outside the tunnel.
    if (rest === '/preview') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'The preview is read-only.', { allow: 'GET, HEAD' });
      return new Response(null, { status: 308, headers: { location: `${roomPreviewPath(roomId)}/${url.search}`, 'cache-control': 'no-store' } });
    }
    if (rest.startsWith('/preview/')) return preview(request, env, roomId, url);
    return textResponse(404, 'Not found.');
  }
} satisfies ExportedHandler<Env>;

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
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(roomRequest('/create', roomId, { headers: { upgrade: 'websocket' } }));
}

async function connect(request: Request, env: Env, roomId: string): Promise<Response> {
  const problem = upgradeProblem(request);
  if (problem) return problem;
  // Per address and room, so one invitee opening socket after socket cannot crowd out the rest of the room.
  const { success } = await env.ROOM_CONNECT_LIMITER.limit({ key: `${roomId}:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
  if (!success) return textResponse(429, 'Too many connections to this live session from this address. Try again in a minute.', { 'retry-after': '60' });
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(roomRequest('/connect', roomId, { headers: { upgrade: 'websocket' } }));
}

async function admission(request: Request, env: Env, roomId: string, url: URL): Promise<Response> {
  if (request.method !== 'POST') return textResponse(405, 'Redeem a preview ticket with POST.', { allow: 'POST' });
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return textResponse(415, 'Send the ticket as JSON.');
  const body = await readBoundedText(request, MAX_ADMISSION_BODY_BYTES);
  if (body === null) return textResponse(413, 'That request is too large.');
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(
    roomRequest('/admission', roomId, { method: 'POST', headers: { 'content-type': 'application/json', [INTERNAL_HEADERS.secure]: isHttps(request, url) ? '1' : '0' }, body })
  );
}

/**
 * Whether the guest reached the relay over HTTPS, so its cookie is marked Secure. Cloudflare sets X-Forwarded-Proto
 * itself; either signal only ever adds Secure, so a client claiming HTTPS over plain HTTP only loses its own cookie.
 */
function isHttps(request: Request, url: URL): boolean {
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto')?.toLowerCase() === 'https';
}

async function preview(request: Request, env: Env, roomId: string, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'The preview is read-only.', { allow: 'GET, HEAD' });
  // The path below the room's preview, with its query: what the host's own preview server is asked for.
  const target = `${url.pathname.slice(roomPreviewPath(roomId).length)}${url.search}`;
  if (!isPreviewTarget(target)) return textResponse(404, 'Not found.');
  const cookie = request.headers.get('cookie');
  if (previewCookieValues(cookie).length === 0) return textResponse(401, 'Join this live session to see its preview.');
  const headers: Record<string, string> = { cookie: `${PREVIEW_COOKIE_NAME}=${previewCookieValues(cookie).join(`; ${PREVIEW_COOKIE_NAME}=`)}`, [INTERNAL_HEADERS.method]: request.method, [INTERNAL_HEADERS.target]: target };
  let passed = 0;
  for (const [name, value] of request.headers) {
    if (passed < MAX_PREVIEW_HEADERS && isPreviewHeaderName(name, 'request') && isPreviewHeaderValue(value)) {
      headers[name] = value;
      passed++;
    }
  }
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(roomRequest('/preview', roomId, { headers, signal: request.signal }));
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
