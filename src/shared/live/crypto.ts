import { ROOM_ID_ALPHABET, ROOM_ID_LENGTH, ROOM_ID_RE } from './limits';

/**
 * The host's proof of who it is, with no accounts: each live session makes an Ed25519 key pair in memory, registers
 * the public key when it creates the room, and proves it holds the private key when it reconnects by signing a fresh
 * single-use nonce from the relay. Everything here is Web Crypto only, so the Electron main process, the renderer and
 * the Cloudflare Worker run the same code. Keys are never written anywhere.
 */

// CryptoKey is a global type in the DOM library but only a value in Node's types; both name it through `crypto`.
type Subtle = typeof globalThis.crypto.subtle;
export type LiveCryptoKey = Awaited<ReturnType<Subtle['importKey']>>;

const ED25519 = { name: 'Ed25519' } as const;
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
  globalThis.crypto.getRandomValues(bytes);
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

export interface HostKeyPair {
  /** Never leaves the process that made it: it cannot be exported. */
  privateKey: LiveCryptoKey;
  /** The raw 32-byte public key as base64url, as it is registered with the relay. */
  publicKey: string;
}

/** A new Ed25519 key pair for one live session, held in memory only. */
export async function generateHostKeyPair(): Promise<HostKeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey(ED25519, false, ['sign', 'verify']);
  if (!('privateKey' in pair) || !('publicKey' in pair)) throw new Error('Ed25519 key generation did not make a key pair.');
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
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
  if (!challenge || !ROOM_ID_RE.test(challenge.roomId) || !NONCE_RE.test(challenge.nonce)) return null;
  const encoded = new TextEncoder().encode(`${HOST_CHALLENGE_CONTEXT}\n${challenge.roomId}\n${challenge.nonce}`);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

/** Sign a relay's challenge with the session's private key: the signature as base64url. */
export async function signHostChallenge(privateKey: LiveCryptoKey, challenge: HostChallenge): Promise<string> {
  const bytes = hostChallengeBytes(challenge);
  if (!bytes) throw new Error('Not a valid host challenge.');
  return toBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign(ED25519, privateKey, bytes)));
}

/** A registered public key ready to verify with, or null when it is not a 32-byte Ed25519 key. */
export async function importHostPublicKey(publicKey: string): Promise<LiveCryptoKey | null> {
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) return null;
  const raw = fromBase64Url(publicKey);
  if (!raw || raw.length !== PUBLIC_KEY_BYTES) return null;
  try {
    return await globalThis.crypto.subtle.importKey('raw', raw, ED25519, false, ['verify']);
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
    return await globalThis.crypto.subtle.verify(ED25519, key, sig, bytes);
  } catch {
    return false;
  }
}
