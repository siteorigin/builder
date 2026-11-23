const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random identifier with a readable prefix, e.g. "n_k3j9x2ab". */
export function newId(prefix = 'n', length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function stableHash(text: string): string {
  // FNV-1a 32-bit, used only for deterministic short keys (not security).
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
