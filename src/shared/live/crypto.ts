import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH, ROOM_ID_RE } from './limits';

/**
 * The host's proof of who it is, with no accounts: each live session makes an Ed25519 key pair in memory, registers
 * the public key when it creates the room, and proves it holds the private key when it reconnects by signing a fresh
 * single-use nonce from the relay. Everything here is Web Crypto only, so the Electron main process, the renderer and
 * the Cloudflare Worker run the same code. Keys are never written anywhere.
 */

// CryptoKey is a global type in the DOM library but only a value in Node's types; all of them name it through
// `crypto`. The bare global, never `globalThis.crypto`: Cloudflare's Worker types declare it as a constant, which
// is not a property of globalThis.
export type LiveCryptoKey = Parameters<typeof crypto.subtle.sign>[1];

// The name alone: an object holding only `name` also matches one of Node's symmetric-key overloads.
const ED25519 = 'Ed25519';
/** Ed25519 keys and signatures have fixed sizes; anything else is refused before Web Crypto sees it. */
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const NONCE_BYTES = 32;
/** Every signed challenge starts with this line, so a host's signature is never valid for anything else. */
export const HOST_CHALLENGE_CONTEXT = 'siteorigin-live/host-challenge/v1';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const left = bytes.length - i;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (left > 1) out += B64URL[(n >> 6) & 63];
    if (left > 2) out += B64URL[n & 63];
  }
  return out;
}

/**
 * Unpadded base64url as bytes, or null when the text is not exactly that: padding, other characters, an impossible
 * length, or stray bits after the last byte are all refused, so each byte string has one spelling only.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || !B64URL_RE.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of text) {
    value = ((value << 6) | B64URL.indexOf(ch)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

/** The base64url length of `bytes` bytes, unpadded. */
const encodedLength = (bytes: number) => Math.ceil((bytes * 4) / 3);
export const PUBLIC_KEY_RE = new RegExp(`^[A-Za-z0-9_-]{${encodedLength(PUBLIC_KEY_BYTES)}}$`);
export const SIGNATURE_RE = new RegExp(`^[A-Za-z0-9_-]{${encodedLength(SIGNATURE_BYTES)}}$`);
export const NONCE_RE = new RegExp(`^[A-Za-z0-9_-]{${encodedLength(NONCE_BYTES)}}$`);

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** A fresh single-use challenge nonce, as the relay issues it. */
export function newNonce(): string {
  return toBase64Url(randomBytes(NONCE_BYTES));
}

/** A fresh unguessable room ID. Each character is drawn without bias from the 32-letter alphabet. */
export function newRoomId(): string {
  let out = '';
  // 32 letters divide 256 evenly, so taking the low five bits of each random byte is uniform.
  for (const b of randomBytes(ROOM_ID_LENGTH)) out += ROOM_ID_ALPHABET[b & 31];
  return out;
}

/** The first line hashed into a preview host's label, so the digest is never one made for anything else. */
export const PREVIEW_HOST_CONTEXT = 'siteorigin-live/preview-host/v1';
/** A preview host's first DNS label: `p-` and 32 letters of the room ID alphabet (160 bits of the digest). */
export const PREVIEW_HOST_LABEL_RE = /^p-[23456789abcdefghijkmnpqrstuvwxyz]{32}$/;

/**
 * The first DNS label of a room's preview origin, `p-<32 letters>`: a one-way digest of the room ID. Each room's
 * preview is its own origin, so one room's site code can never read another room's preview or the viewer's pages. The
 * label is not the room ID because a host name is not private: it travels in DNS lookups and TLS SNI, and in the
 * `Origin` header of every font and CDN request the preview makes, and the room ID is the invite. The room ID's 120
 * random bits make the digest impossible to walk back. It needs no secret, so the relay, the viewer and the app all
 * work it out alike, and the relay names each room's object by it, so a preview request finds its room by host alone.
 */
export async function previewHostLabel(roomId: string): Promise<string> {
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) throw new Error('Not a live session room ID.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${PREVIEW_HOST_CONTEXT}\n${roomId}`)));
  // Five bits a letter from the digest's first 20 bytes, most significant first.
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of digest.subarray(0, 20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ROOM_ID_ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return `p-${out}`;
}

export interface HostKeyPair {
  /** Never leaves the process that made it: it cannot be exported. */
  privateKey: LiveCryptoKey;
  /** The raw 32-byte public key as base64url, as it is registered with the relay. */
  publicKey: string;
}

/** A new Ed25519 key pair for one live session, held in memory only. */
export async function generateHostKeyPair(): Promise<HostKeyPair> {
  const pair = await crypto.subtle.generateKey(ED25519, false, ['sign', 'verify']);
  if (!('privateKey' in pair) || !('publicKey' in pair)) throw new Error('Ed25519 key generation did not make a key pair.');
  // Worker types say exportKey may give a JWK; a raw export never does.
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error('Ed25519 public key export did not give raw bytes.');
  return { privateKey: pair.privateKey, publicKey: toBase64Url(new Uint8Array(raw)) };
}

export interface HostChallenge {
  roomId: string;
  /** The relay's single-use nonce, base64url. */
  nonce: string;
}

/**
 * The exact bytes a host signs to prove it holds a room's key: a fixed context line, the room and the relay's nonce,
 * one per line. Null when either is malformed, so nothing ambiguous is ever signed.
 */
export function hostChallengeBytes(challenge: HostChallenge): Uint8Array<ArrayBuffer> | null {
  if (!challenge || typeof challenge.roomId !== 'string' || !ROOM_ID_RE.test(challenge.roomId)) return null;
  if (typeof challenge.nonce !== 'string' || !NONCE_RE.test(challenge.nonce) || fromBase64Url(challenge.nonce)?.length !== NONCE_BYTES) return null;
  const encoded = new TextEncoder().encode(`${HOST_CHALLENGE_CONTEXT}\n${challenge.roomId}\n${challenge.nonce}`);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

/** Sign a relay's challenge with the session's private key: the signature as base64url. */
export async function signHostChallenge(privateKey: LiveCryptoKey, challenge: HostChallenge): Promise<string> {
  const bytes = hostChallengeBytes(challenge);
  if (!bytes) throw new Error('Not a valid host challenge.');
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(ED25519, privateKey, bytes)));
}

/**
 * The encodings of Ed25519's small-order points (with the sign bit cleared), including the non-canonical spellings
 * of 0 and 1. A key that is one of them can make signatures that verify for many messages on some implementations,
 * so none is ever accepted as a host's key, whatever the platform's own checks.
 */
const SMALL_ORDER_KEYS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
];

/** A host public key's raw bytes, or null unless it is canonical base64url of 32 bytes that are not a small-order point. */
function hostKeyBytes(publicKey: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) return null;
  const raw = fromBase64Url(publicKey);
  if (!raw || raw.length !== PUBLIC_KEY_BYTES) return null;
  const hex = Array.from(raw, (b, i) => (i === PUBLIC_KEY_BYTES - 1 ? b & 0x7f : b).toString(16).padStart(2, '0')).join('');
  return SMALL_ORDER_KEYS.includes(hex) ? null : raw;
}

/** Whether `publicKey` can be registered as a host's key: see hostKeyBytes. */
export function isHostPublicKey(publicKey: unknown): publicKey is string {
  return hostKeyBytes(publicKey) !== null;
}

/** A registered public key ready to verify with, or null when it is not a usable 32-byte Ed25519 key. */
export async function importHostPublicKey(publicKey: string): Promise<LiveCryptoKey | null> {
  const raw = hostKeyBytes(publicKey);
  if (!raw) return null;
  try {
    return await crypto.subtle.importKey('raw', raw, ED25519, false, ['verify']);
  } catch {
    return null;
  }
}

/**
 * Whether `signature` is the room's registered key signing this challenge. Never throws: a malformed key, nonce,
 * room or signature, or any refusal from Web Crypto, is simply not a match.
 */
export async function verifyHostChallenge(publicKey: string, challenge: HostChallenge, signature: string): Promise<boolean> {
  const bytes = hostChallengeBytes(challenge);
  if (!bytes || typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return false;
  const sig = fromBase64Url(signature);
  if (!sig || sig.length !== SIGNATURE_BYTES) return false;
  const key = await importHostPublicKey(publicKey);
  if (!key) return false;
  try {
    return await crypto.subtle.verify(ED25519, key, sig, bytes);
  } catch {
    return false;
  }
}
