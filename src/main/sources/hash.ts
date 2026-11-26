/**
 * A record's content hash: what tells a sync whether a record changed since it was last written. It reads what the
 * entry would say, whatever order the source lists keys in, and a picture by its identity rather than the address it
 * was read at this time, so a signed link that changes on every read changes nothing.
 */
import { createHash } from 'node:crypto';
import { imageKey, isImageRef, type NormalizedRecord } from './protocol';

/** `v` as JSON with every object's keys sorted, and each picture as its identity. */
function canonical(v: unknown): string {
  if (isImageRef(v)) return JSON.stringify({ $image: imageKey(v.$image), alt: v.$image.alt ?? '' });
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The content hash of a record: `sha256:` and its canonical form's SHA-256. Its publication counts: draft absent is false. */
export function recordHash(r: NormalizedRecord): string {
  return `sha256:${createHash('sha256')
    .update(canonical({ ...r, draft: r.draft === true }))
    .digest('hex')}`;
}
