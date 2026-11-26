/**
 * One sync, as the sync worker runs it: read every record of the source with its kind's reader, check each, and fetch
 * the pictures of the records that changed since they were last synced. The reply is all or nothing: a reader that
 * fails part way, a record that cannot be an entry or a picture that will not load fails the whole sync, so no entry
 * is ever drafted for a record that was only not read. Kept apart from the process so it can be tested.
 */
import { redactSecrets } from './redact';
import { recordHash } from './hash';
import { AdapterError, type SourceAdapter } from './registry';
import {
  imageKey,
  MAX_DETAIL,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_BYTES,
  MAX_RECORDS,
  MAX_RECORDS_BYTES,
  recordImages,
  recordProblem,
  type NormalizedRecord,
  type SourceImage,
  type SyncFailure,
  type SyncImage,
  type SyncReply,
  type SyncRequest
} from './protocol';

/** A picture's bytes and type, fetched from its address (see worker.ts's fetchImage). */
export type ImageFetcher = (url: string, maxBytes: number, signal: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>;

export interface RunDeps {
  adapters: Readonly<Record<string, SourceAdapter>>;
  fetchImage: ImageFetcher;
  signal?: AbortSignal;
}

/** The pictures the library takes from a sync, by type. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

export async function runSync(req: SyncRequest, deps: RunDeps): Promise<SyncReply> {
  const secrets = Object.values(req.secrets ?? {});
  const failed = (code: SyncFailure, detail?: string): SyncReply => ({
    id: req.id,
    ok: false,
    code,
    // Taken out before it is cut short, so no part of a secret is left at the cut.
    ...(detail ? { detail: redactSecrets(detail, secrets).slice(0, MAX_DETAIL) } : {})
  });
  const signal = deps.signal ?? new AbortController().signal;
  const adapter = Object.hasOwn(deps.adapters, req.adapter) ? deps.adapters[req.adapter] : undefined;
  if (!adapter) return failed('adapter-unavailable');
  let records: NormalizedRecord[];
  try {
    records = await adapter.read(req.config, Object.freeze({ ...req.secrets }), signal);
  } catch (e) {
    // What a reader throws is never passed on as it is: it may hold what the server echoed back.
    return e instanceof AdapterError ? failed(e.code, e.detail) : failed('failed');
  }
  if (!Array.isArray(records)) return failed('invalid', 'the reader gave no list of records');
  if (records.length > MAX_RECORDS) return failed('too-large', `it has more than ${MAX_RECORDS} records`);
  const ids = new Set<string>();
  for (const r of records) {
    const problem = recordProblem(r);
    if (problem) return failed('invalid', problem);
    if (ids.has(r.externalId)) return failed('invalid', 'two records have the same ID');
    ids.add(r.externalId);
  }
  let size: number;
  try {
    size = JSON.stringify(records).length;
  } catch {
    return failed('invalid', 'a record cannot be read');
  }
  if (size > MAX_RECORDS_BYTES) return failed('too-large', 'its records are too large to sync');
  // Only the pictures of records that changed: an unchanged record's are in the library already.
  const wanted = new Map<string, SourceImage>();
  for (const r of records) {
    if (Object.hasOwn(req.known ?? {}, r.externalId) && req.known[r.externalId] === recordHash(r)) continue;
    for (const img of recordImages(r)) if (!wanted.has(imageKey(img))) wanted.set(imageKey(img), img);
  }
  const images: SyncImage[] = [];
  let total = 0;
  for (const [key, img] of wanted) {
    let got: { bytes: Uint8Array; mime: string };
    try {
      got = await deps.fetchImage(img.url, Math.min(MAX_IMAGE_BYTES, MAX_IMAGES_BYTES - total), signal);
    } catch (e) {
      return failed(e instanceof AdapterError ? e.code : 'image', e instanceof AdapterError ? e.detail : undefined);
    }
    const mime = got.mime.split(';')[0].trim().toLowerCase();
    const ext = Object.hasOwn(IMAGE_EXTENSIONS, mime) ? IMAGE_EXTENSIONS[mime] : undefined;
    if (!ext) return failed('image', 'a picture is not a JPEG, PNG, WebP, GIF or AVIF image');
    total += got.bytes.byteLength;
    if (got.bytes.byteLength > MAX_IMAGE_BYTES || total > MAX_IMAGES_BYTES) return failed('too-large', 'its pictures are too large to sync');
    images.push({ key, mime, ext, bytes: got.bytes });
  }
  return { id: req.id, ok: true, records, images };
}
