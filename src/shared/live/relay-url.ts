import { ROOM_ID_RE } from './limits';

/**
 * Where the live session relay is, and the invite links it serves. The production relay is the default; an
 * environment variable (for tests and local development, such as `wrangler dev` on http://127.0.0.1:8787) or the
 * advanced setting points the app at another one without a code change.
 */

export const DEFAULT_RELAY_URL = 'https://live.siteorigin.com';
export const RELAY_URL_ENV = 'SITEORIGIN_LIVE_RELAY_URL';
/** The path under the relay that a room's invite link, guest shell and sockets live at: `/s/<roomId>`. */
export const ROOM_PATH_PREFIX = '/s/';

export type RelayUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/**
 * A relay base URL as it is kept and used: http or https, with no credentials, query or fragment, and no trailing
 * slash, so `https://live.example.com/` and `https://live.example.com` are the same relay. A relay may live under a
 * path (`https://example.com/live`), but never under a room's own path.
 */
export function checkRelayUrl(raw: unknown): RelayUrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: 'Enter the relay’s address, such as https://live.siteorigin.com.' };
  const text = raw.trim();
  // The URL parser drops tabs and line breaks inside an address; one holding any is refused instead of mended.
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, message: 'The relay’s address cannot contain spaces or line breaks.' };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, message: 'Enter the relay’s full address, such as https://live.siteorigin.com.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'The relay’s address must start with http:// or https://.' };
  if (u.username || u.password) return { ok: false, message: 'The relay’s address cannot include a username or password.' };
  if (u.search || u.hash || text.includes('?') || text.includes('#')) return { ok: false, message: 'The relay’s address cannot include a query string or fragment.' };
  const path = u.pathname.replace(/\/+$/, '');
  if (`${path}/`.includes(ROOM_PATH_PREFIX)) return { ok: false, message: 'Enter the relay’s address, not a session’s invite link.' };
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

export type RelayUrlSource = 'env' | 'setting' | 'default';
export type ResolvedRelayUrl = { ok: true; url: string; source: RelayUrlSource } | { ok: false; source: Exclude<RelayUrlSource, 'default'>; message: string };

/**
 * The relay the app uses: the environment variable when it is set, then the advanced setting, then the production
 * relay. A blank value counts as unset. A value that is set but unusable is reported, never passed over for the next
 * one: a test pointed at a local relay must not reach the real one by mistake.
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

/** A room's invite link under the relay: `<relay>/s/<roomId>`. Throws on a relay or room ID that is not valid. */
export function formatInviteLink(relayUrl: string, roomId: string): string {
  const relay = checkRelayUrl(relayUrl);
  if (!relay.ok) throw new Error(relay.message);
  if (!ROOM_ID_RE.test(roomId)) throw new Error('Not a live session room ID.');
  return `${relay.url}${ROOM_PATH_PREFIX}${roomId}`;
}

export type InviteLink = { relayUrl: string; roomId: string };

/**
 * The relay and room an invite link names, or null when the text is not one. Surrounding spaces, one trailing
 * slash, and a query or fragment a chat app may add are ignored; anything after the room ID in its path is not.
 */
export function parseInviteLink(text: unknown): InviteLink | null {
  if (typeof text !== 'string') return null;
  const link = text.trim();
  if (/[\s\u0000-\u001f\u007f]/.test(link)) return null;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const at = u.pathname.lastIndexOf(ROOM_PATH_PREFIX);
  if (at < 0) return null;
  const roomId = u.pathname.slice(at + ROOM_PATH_PREFIX.length).replace(/\/$/, '');
  if (!ROOM_ID_RE.test(roomId)) return null;
  const relay = checkRelayUrl(`${u.protocol}//${u.host}${u.pathname.slice(0, at)}`);
  return relay.ok ? { relayUrl: relay.url, roomId } : null;
}
