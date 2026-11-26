/**
 * What the main process and the sync worker say to each other (see client.ts and worker.ts), and the records a kind of
 * source reads: each external record put in the shape of a collection entry, with its pictures as addresses the worker
 * fetches. Nothing here is the project's: the worker is given a source's settings and the secrets they name, and
 * nothing else.
 */
import type { RichText, SourceConfig } from '@shared/types';

/** A picture a record shows, at an address on the web. */
export interface SourceImage {
  url: string;
  /** Who it is, when its address changes on every read (a signed link): a version or digest. Absent: its address. */
  id?: string;
  /** What to call it in the library. */
  name?: string;
  /** Its alternative text, for an image field. */
  alt?: string;
}

/** A picture in a record's fields: `featuredImage`, or the value of an image field. */
export interface SourceImageRef {
  $image: SourceImage;
}

/**
 * One external record, as an entry of the collection it is synced into. Every detail it leaves out is cleared on the
 * entry (a sync writes the whole record), except its address and date, which a new entry is given and an entry keeps.
 */
export interface NormalizedRecord {
  /** Its ID in the source: what the entry is matched to on every sync. */
  externalId: string;
  title: string;
  slug?: string;
  /** YYYY-MM-DD. */
  publishedAt?: string;
  updatedAt?: string;
  /** Whether the source keeps it unpublished. Absent: it is published. */
  draft?: boolean;
  author?: string;
  excerpt?: string;
  featuredImage?: SourceImageRef;
  /** Term IDs by taxonomy ID, among the collection's own terms. */
  terms?: Record<string, string[]>;
  /** Custom field values by field name; an image field's is a SourceImageRef. */
  values?: Record<string, unknown>;
  body?: RichText;
}

/** A picture the worker fetched for the records that changed: its identity (see imageKey), and its bytes. */
export interface SyncImage {
  key: string;
  mime: string;
  ext: string;
  bytes: Uint8Array;
}

/**
 * Why a sync failed, as the worker reports it: fixed reasons, chosen by the main process's words (see client.ts), and
 * never what the source's server said, which may echo the credential it was sent.
 */
export type SyncFailure = 'adapter-unavailable' | 'auth' | 'network' | 'invalid' | 'too-large' | 'image' | 'failed';

export interface SyncRequest {
  id: number;
  adapter: string;
  config: SourceConfig;
  /** The secrets the source's settings name, by name: only these. */
  secrets: Record<string, string>;
  /** The content hash each record had when it was last synced, by external ID: their pictures are not fetched again. */
  known: Record<string, string>;
}

export type SyncReply = { id: number; ok: true; records: NormalizedRecord[]; images: SyncImage[] } | { id: number; ok: false; code: SyncFailure; detail?: string };

/** The most records a sync reads, and the most a record's or a picture's bytes may be. */
export const MAX_RECORDS = 5000;
export const MAX_RECORDS_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** The most picture bytes one sync brings across. */
export const MAX_IMAGES_BYTES = 256 * 1024 * 1024;
/** The longest a reason's detail may be. */
export const MAX_DETAIL = 300;

/** A picture's identity: what it is called by whatever address it is read at. */
export const imageKey = (img: SourceImage): string => `${img.id !== undefined ? 'id' : 'url'}:${img.id ?? img.url}`;

/** Whether a value is a picture reference. */
export function isImageRef(v: unknown): v is SourceImageRef {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1) return false;
  const img = (v as { $image?: unknown }).$image as Partial<SourceImage> | undefined;
  return (
    !!img &&
    typeof img === 'object' &&
    typeof img.url === 'string' &&
    /^https?:\/\//i.test(img.url) &&
    img.url.length <= 4096 &&
    (img.id === undefined || (typeof img.id === 'string' && img.id.length > 0 && img.id.length <= 512)) &&
    (img.name === undefined || typeof img.name === 'string') &&
    (img.alt === undefined || typeof img.alt === 'string')
  );
}

/** The pictures a record shows: its featured image, and its image fields'. */
export function recordImages(r: NormalizedRecord): SourceImage[] {
  const out: SourceImage[] = [];
  if (isImageRef(r.featuredImage)) out.push(r.featuredImage.$image);
  for (const v of Object.values(r.values ?? {})) if (isImageRef(v)) out.push(v.$image);
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);

/** What is wrong with a record as a kind of source read it, or null. Never quotes what it holds. */
export function recordProblem(r: unknown): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'a record is not an object';
  const o = r as Record<string, unknown>;
  if (typeof o.externalId !== 'string' || !o.externalId.trim() || o.externalId.length > 512) return 'a record has no ID';
  if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 200) return 'a record has no title, or one too long';
  if (!text(o.slug, 400) || !text(o.author, 80) || !text(o.excerpt, 320)) return 'a record has a detail too long';
  for (const k of ['publishedAt', 'updatedAt'] as const) if (o[k] !== undefined && (typeof o[k] !== 'string' || !DAY.test(o[k] as string))) return 'a record has a date not written YYYY-MM-DD';
  if (o.draft !== undefined && typeof o.draft !== 'boolean') return 'a record says it is published in a way that is not true or false';
  if (o.featuredImage !== undefined && !isImageRef(o.featuredImage)) return 'a record has a featured image that is not a web address';
  if (o.terms !== undefined && (!o.terms || typeof o.terms !== 'object' || Array.isArray(o.terms) || !Object.values(o.terms).every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))))
    return 'a record has terms that are not lists of term IDs';
  if (o.values !== undefined && (!o.values || typeof o.values !== 'object' || Array.isArray(o.values))) return 'a record has field values that are damaged';
  if (o.body !== undefined && !Array.isArray(o.body)) return 'a record has text that is damaged';
  for (const k of Object.keys(o)) if (!RECORD_KEYS.has(k)) return 'a record has a detail no entry has';
  return null;
}

const RECORD_KEYS = new Set(['externalId', 'title', 'slug', 'publishedAt', 'updatedAt', 'draft', 'author', 'excerpt', 'featuredImage', 'terms', 'values', 'body']);
