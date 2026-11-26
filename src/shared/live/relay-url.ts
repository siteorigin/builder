import { previewHostLabel } from './crypto';
import { ROOM_ID_RE } from './limits';

/**
 * Where the live session relay is, the routes it serves, and its invite links. The production relay is the default;
 * an environment variable (for tests and local development, such as `wrangler dev` on http://127.0.0.1:8787) or the
 * advanced setting points the app at another one without a code change. A relay is always a whole origin: every
 * route below sits at its root.
 */

/**
 * The production relay. It must move to a registrable domain used for nothing else before it is deployed (#767): each
 * room's preview runs its host's site code under this host, and that code may set cookies for the parent domain.
 */
export const DEFAULT_RELAY_URL = 'https://live.siteorigin.com';
export const RELAY_URL_ENV = 'SITEORIGIN_LIVE_RELAY_URL';

/** The relay's routes. A host opens a new room on HOST_SOCKET_PATH; everything else is under its room's path. */
export const HOST_SOCKET_PATH = '/ws/host';
/** A room's invite link and guest page: `/s/<roomId>`. */
export const roomPath = (roomId: string) => `/s/${roomId}`;
/** The socket a host reconnects on and guests join on. */
export const roomSocketPath = (roomId: string) => `${roomPath(roomId)}/ws`;
/**
 * Where, on the room's preview origin, an admitted guest redeems its preview ticket for the preview cookie (POST,
 * `{ ticket }`). Every other path on that origin is the host's site; a first segment starting with `__` is never one a
 * guest may ask the preview for (preview.ts), so this one cannot hide a page of the site.
 */
export const PREVIEW_ADMISSION_PATH = '/__siteorigin/admission';

/** Characters no relay address or invite link may hold: spaces and controls (which the URL parser drops or mends) and backslashes (which it reads as slashes). */
const UNSAFE = /[\s\u0000-\u001f\u007f\\]/;
/** An http(s) origin, with nothing but slashes after it. The authority holds no credentials or percent-escapes. */
const ORIGIN_SYNTAX = /^([hH][tT][tT][pP][sS]?:\/\/[^/?#@%]+)\/*$/;
/** An invite link: an origin, then exactly `/s/<roomId>` (its path as written, in lowercase), with at most one slash after it. */
const INVITE_SYNTAX = /^([hH][tT][tT][pP][sS]?:\/\/[^/?#@%]+)\/s\/([^/?#]+)\/?$/;

export type RelayUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/**
 * A relay address as it is kept and used: an http or https origin, in its normal form, with no trailing slash, so
 * `https://Live.SiteOrigin.com/` and `https://live.siteorigin.com` are the same relay. The text is checked as written,
 * before the URL parser normalizes it, so nothing the parser would rewrite (a dot segment, a backslash, an empty
 * query) is accepted for what it becomes.
 */
export function checkRelayUrl(raw: unknown): RelayUrlCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, message: 'Enter the relay’s address, such as https://live.siteorigin.com.' };
  if (UNSAFE.test(text)) return { ok: false, message: 'The relay’s address cannot contain spaces, line breaks or backslashes.' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') return { ok: false, message: 'The relay’s address must start with http:// or https://.' };
  const match = ORIGIN_SYNTAX.exec(text);
  if (!match) return { ok: false, message: 'Enter only the relay’s address, such as https://live.siteorigin.com, with no path, query, fragment, username or password.' };
  let u: URL;
  try {
    u = new URL(match[1]);
  } catch {
    return { ok: false, message: 'Enter the relay’s full address, such as https://live.siteorigin.com.' };
  }
  if (!u.hostname) return { ok: false, message: 'Enter the relay’s full address, such as https://live.siteorigin.com.' };
  return { ok: true, url: u.origin };
}

export type RelayUrlSource = 'env' | 'setting' | 'default';
export type ResolvedRelayUrl = { ok: true; url: string; source: RelayUrlSource } | { ok: false; source: Exclude<RelayUrlSource, 'default'>; message: string };

/**
 * The relay the app uses: the environment variable (`SITEORIGIN_LIVE_RELAY_URL`) when it is set, then the advanced
 * setting, then the production relay. A blank value counts as unset. A value that is set but unusable is reported,
 * never passed over for the next one: a test pointed at a local relay must not reach the real one by mistake. The
 * caller reads the environment; this never touches `process`, so the renderer and the relay can use it too.
 */
export function resolveRelayUrl(sources: { env?: string | null; setting?: string | null }): ResolvedRelayUrl {
  for (const source of ['env', 'setting'] as const) {
    const value = sources[source];
    if (typeof value !== 'string' || !value.trim()) continue;
    const check = checkRelayUrl(value);
    return check.ok ? { ok: true, url: check.url, source } : { ok: false, source, message: check.message };
  }
  return { ok: true, url: DEFAULT_RELAY_URL, source: 'default' };
}

/**
 * The WebSocket address of one of the relay's sockets (HOST_SOCKET_PATH, or a room's roomSocketPath): wss:// on an
 * https relay, ws:// on an http one. Throws on a relay or a path that is not one of them.
 */
export function relaySocketUrl(relayUrl: string, path: string): string {
  const relay = checkRelayUrl(relayUrl);
  if (!relay.ok) throw new Error(relay.message);
  const room = /^\/s\/([^/]+)\/ws$/.exec(path)?.[1];
  if (path !== HOST_SOCKET_PATH && !(room && ROOM_ID_RE.test(room))) throw new Error('Not one of the relay’s sockets.');
  return `${relay.url.replace(/^http/, 'ws')}${path}`;
}

/** A room's invite link on the relay: `<relay>/s/<roomId>`. Throws on a relay or room ID that is not valid. */
export function formatInviteLink(relayUrl: string, roomId: string): string {
  const relay = checkRelayUrl(relayUrl);
  if (!relay.ok) throw new Error(relay.message);
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) throw new Error('Not a live session room ID.');
  return `${relay.url}${roomPath(roomId)}`;
}

export type InviteLink = { relayUrl: string; roomId: string };

/**
 * The relay and room an invite link names, or null when the text is not exactly one: surrounding spaces and a single
 * trailing slash are all it may add to `<relay>/s/<roomId>`.
 */
export function parseInviteLink(text: unknown): InviteLink | null {
  const link = typeof text === 'string' ? text.trim() : '';
  if (!link || UNSAFE.test(link)) return null;
  const match = INVITE_SYNTAX.exec(link);
  if (!match || !ROOM_ID_RE.test(match[2])) return null;
  const relay = checkRelayUrl(match[1]);
  return relay.ok ? { relayUrl: relay.url, roomId: match[2] } : null;
}

/**
 * A room's preview origin: the host's site at its own root, on `p-<label>.<relay host>` with the relay's scheme and
 * port (see previewHostLabel). The relay's host is the viewer's, so the two are the same site and the preview cookie
 * (SameSite=Lax, host-only) goes with the viewer's iframe in every browser, Safari included. That needs a relay host
 * of at least two labels: an IP address has no subdomains, and `p-….localhost` is a different site from `localhost`.
 * Point local development at `http://relay.localhost:8787`.
 */
export async function roomPreviewOrigin(relayUrl: string, roomId: string): Promise<string> {
  const relay = checkRelayUrl(relayUrl);
  if (!relay.ok) throw new Error(relay.message);
  const url = new URL(relay.url);
  if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) throw new Error('A relay on an IP address cannot give rooms their own preview origins. Use a host name, such as relay.localhost.');
  if (!url.hostname.includes('.')) throw new Error('A relay needs a host name with a dot, such as relay.localhost, for its previews to share its site.');
  url.hostname = `${await previewHostLabel(roomId)}.${url.hostname}`;
  return url.origin;
}
