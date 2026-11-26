import type { SessionRoom } from './session-room';

/** What the Worker and its SessionRoom objects are given: wrangler.toml's bindings and vars, and the signing secret. */
export interface Env {
  ROOMS: DurableObjectNamespace<SessionRoom>;
  /** The viewer's static files (relay/viewer/), which the Worker serves at the paths it names. */
  ASSETS: Fetcher;
  ROOM_CREATION_LIMITER: RateLimit;
  ROOM_CONNECT_LIMITER: RateLimit;
  /** Signs guests' preview cookies. A secret: never in wrangler.toml. */
  SESSION_SIGNING_KEY?: string;
  HOST_RECONNECT_GRACE_MS?: string;
  GUEST_RECONNECT_GRACE_MS?: string;
  HANDSHAKE_TIMEOUT_MS?: string;
  PREVIEW_HEAD_TIMEOUT_MS?: string;
  PREVIEW_IDLE_TIMEOUT_MS?: string;
  /**
   * The relay's public origin, such as `https://siteorigin.live`, set in production. The viewer's routes are served
   * only there and preview origins only directly under it. Unset (local development, tests), any host serves them.
   */
  RELAY_ORIGIN?: string;
}

export interface RelayConfig {
  /** How long a room waits for its host to prove itself again after its socket drops, before the room closes. */
  hostGraceMs: number;
  /** How long a guest's place is kept after its socket drops, for it to resume with its token. */
  guestGraceMs: number;
  /** How long a new socket has to open a room, join, or answer the host challenge. */
  handshakeTimeoutMs: number;
  /** How long a preview request waits for the host's response head. */
  previewHeadTimeoutMs: number;
  /** How long a preview response may go without a frame from the host before it is stopped. */
  previewIdleTimeoutMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A tunable as a whole number of milliseconds within bounds; anything else falls back to the default. */
function millis(raw: string | undefined, fallback: number, max: number): number {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value >= 1 && value <= max ? value : fallback;
}

export function relayConfig(env: Env): RelayConfig {
  return {
    hostGraceMs: millis(env.HOST_RECONNECT_GRACE_MS, 2 * MINUTE, 15 * MINUTE),
    guestGraceMs: millis(env.GUEST_RECONNECT_GRACE_MS, 2 * MINUTE, 15 * MINUTE),
    handshakeTimeoutMs: millis(env.HANDSHAKE_TIMEOUT_MS, 30 * SECOND, 5 * MINUTE),
    previewHeadTimeoutMs: millis(env.PREVIEW_HEAD_TIMEOUT_MS, 30 * SECOND, 5 * MINUTE),
    previewIdleTimeoutMs: millis(env.PREVIEW_IDLE_TIMEOUT_MS, 30 * SECOND, 5 * MINUTE)
  };
}

/** The shortest signing key the relay accepts, in characters. */
export const MIN_SIGNING_KEY_LENGTH = 32;

/** Whether the signing secret is set to something usable. Without it the relay opens no rooms and serves no preview. */
export function hasSigningKey(env: Env): boolean {
  return typeof env.SESSION_SIGNING_KEY === 'string' && env.SESSION_SIGNING_KEY.trim().length >= MIN_SIGNING_KEY_LENGTH;
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

/** The HMAC-SHA256 key preview cookies are signed with, or null when the secret is missing or too short. */
export function signingKey(env: Env): Promise<CryptoKey> | null {
  if (!hasSigningKey(env)) return null;
  const secret = env.SESSION_SIGNING_KEY!.trim();
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

/**
 * RELAY_ORIGIN as a canonical origin, null when it is unset, or `false` when it is set to something that is not an
 * origin (a path, a query, another scheme). A bad value never turns pinning off: the relay then serves nothing.
 */
export function relayOrigin(env: Env): string | null | false {
  const raw = env.RELAY_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return url.origin;
  } catch {
    return false;
  }
}
