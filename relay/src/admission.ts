import { fromBase64Url, toBase64Url } from '../../src/shared/live/crypto';
import { GUEST_ID_RE, GUEST_ROLES, ROOM_ID_RE, type GuestRole } from '../../src/shared/live/limits';
import { roomPreviewPath } from '../../src/shared/live/relay-url';

/**
 * How an admitted guest's browser gets into the room's preview. The guest's socket is sent a short-lived single-use
 * ticket; the guest's page redeems it at the room's admission path, and the relay answers with a signed cookie scoped
 * to the room's preview path. The cookie names the room, the guest, its role, when its access ends and which version
 * of its grant it was minted for, so the relay can check every preview request against the guest's grant as it is now.
 */

/** How long a preview ticket can be redeemed for after it is issued. */
export const PREVIEW_TICKET_TTL_MS = 60_000;
export const PREVIEW_COOKIE_NAME = 'so_preview';
/** Ticket redemption bodies are tiny: `{"ticket":"…"}`. */
export const MAX_ADMISSION_BODY_BYTES = 1024;
const COOKIE_VERSION = 'v1';
const MAC_BYTES = 32;
/** A ticket as the protocol carries it (messages.ts). */
export const TICKET_RE = /^[A-Za-z0-9_-]{16,256}$/;

export interface PreviewGrant {
  roomId: string;
  guestId: string;
  role: GuestRole;
  /** When the guest's access ends, in milliseconds since the epoch. The cookie stops working then. */
  expiresAt: number;
  grantVersion: number;
}

/** The signed cookie value: `v1.<payload>.<mac>`, both parts unpadded base64url. */
export async function signPreviewCookie(key: CryptoKey, grant: PreviewGrant): Promise<string> {
  const tuple = [grant.roomId, grant.guestId, grant.role, grant.expiresAt, grant.grantVersion];
  const signed = `${COOKIE_VERSION}.${toBase64Url(new TextEncoder().encode(JSON.stringify(tuple)))}`;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)));
  return `${signed}.${toBase64Url(mac)}`;
}

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The grant a cookie value carries, or null unless it is exactly one this relay signed. Expiry is the caller's to check. */
export async function verifyPreviewCookie(key: CryptoKey, value: string): Promise<PreviewGrant | null> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION || parts[1].length > 512) return null;
  const mac = fromBase64Url(parts[2]);
  const payload = fromBase64Url(parts[1]);
  if (!mac || mac.length !== MAC_BYTES || !payload) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  let tuple: unknown;
  try {
    tuple = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload));
  } catch {
    return null;
  }
  if (!Array.isArray(tuple) || tuple.length !== 5) return null;
  const [roomId, guestId, role, expiresAt, grantVersion] = tuple as unknown[];
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId) || typeof guestId !== 'string' || !GUEST_ID_RE.test(guestId)) return null;
  if (typeof role !== 'string' || !(GUEST_ROLES as readonly string[]).includes(role) || !isWhole(expiresAt) || !isWhole(grantVersion)) return null;
  return { roomId, guestId, role: role as GuestRole, expiresAt, grantVersion };
}

/**
 * The Set-Cookie header for a grant: host-only, scoped to the room's preview path, unreadable by scripts, sent on
 * top-level navigation but not cross-site subrequests, Secure when the relay is reached over HTTPS, and gone from the
 * browser once the guest's access ends.
 */
export function previewCookieHeader(value: string, grant: PreviewGrant, now: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.ceil((grant.expiresAt - now) / 1000));
  return [`${PREVIEW_COOKIE_NAME}=${value}`, `Path=${roomPreviewPath(grant.roomId)}`, `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
}

/** Every value the request's Cookie header gives the preview cookie, at most a few. */
export function previewCookieValues(header: string | null): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== PREVIEW_COOKIE_NAME) continue;
    values.push(part.slice(at + 1).trim());
    if (values.length === 4) break;
  }
  return values;
}
