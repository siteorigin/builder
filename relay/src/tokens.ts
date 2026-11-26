import { toBase64Url } from '../../src/shared/live/crypto';

/** A random unguessable token of `bytes` bytes, as unpadded base64url. */
export function randomToken(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return toBase64Url(raw);
}

/** Whether two secrets are the same, in time that does not depend on where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
