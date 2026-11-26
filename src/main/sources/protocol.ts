/**
 * What the main process and the sync worker say to each other (see client.ts and worker.ts), and the records a kind of
 * source reads: each external record put in the shape of a collection entry, with its pictures as addresses the worker
 * fetches. Nothing here is the project's: the worker is given a source's settings and the secrets they name, and
 * nothing else.
 */
import type { RichText, SourceConfig, SourceMapping } from '@shared/types';

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
export type SyncFailure = 'adapter-unavailable' | 'auth' | 'network' | 'invalid' | 'too-large' | 'image' | 'converter' | 'failed';

/** The kind of value each of a collection's custom fields holds, by field name: what a mapped value is read as. */
export type FieldKinds = Record<string, string>;

export interface SyncRequest {
  id: number;
  adapter: string;
  config: SourceConfig;
  /** Where its records' details are read from, over its kind's own reading. */
  mapping?: SourceMapping;
  /** The text of its converter, which puts the records in shape instead of the mapping. */
  converter?: string;
  /** The custom fields of the collection it syncs into. */
  fields?: FieldKinds;
  /**
   * `sample`: the records read and put in shape, and the first few as the source sent them, with no picture fetched.
   * `inspect`: only the first few as the kind of source reads them, and how many it has, put in no shape at all (its
   * mapping or converter is not run): what the assistant reads to write one (#680).
   */
  mode?: 'sync' | 'sample' | 'inspect';
  /** The secrets the source's settings name, by name: only these. */
  secrets: Record<string, string>;
  /** The content hash each record had when it was last synced, by external ID: their pictures are not fetched again. */
  known: Record<string, string>;
}

/** How many records a sample shows as the source sent them. */
export const SAMPLE_SIZE = 3;

export type SyncReply =
  | { id: number; ok: true; records: NormalizedRecord[]; images: SyncImage[]; raw?: unknown[]; total?: number }
  | { id: number; ok: false; code: SyncFailure; detail?: string };

/** The most records a sync reads, and the most a record's or a picture's bytes may be. */
export const MAX_RECORDS = 5000;
export const MAX_RECORDS_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** The most picture bytes one sync brings across. */
export const MAX_IMAGES_BYTES = 128 * 1024 * 1024;
/** The longest a reason's detail may be. */
export const MAX_DETAIL = 300;

/**
 * Why a picture's address is not one a sync fetches, or null: only the web, never this computer or the local network
 * (a source cannot have the app read the author's router or another service on their machine), by the address as
 * written. A name that only resolves to such an address is not caught here.
 */
export function imageAddressProblem(url: string): string | null {
  const local = 'a picture is on this computer or the local network, which a sync never reads';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'a picture’s address cannot be read';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'a picture is not at a web address';
  if (u.username || u.password) return 'a picture’s address signs in';
  // Without the root's dot: "localhost." is localhost.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)?.slice(1).map(Number);
  const isLocal =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') && !host.includes(':') ||
    (v4 && (v4[0] === 0 || v4[0] === 10 || v4[0] === 127 || (v4[0] === 169 && v4[1] === 254) || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127))) ||
    (host.includes(':') && isLocalAddress(host));
  return isLocal ? local : null;
}

/** Whether an IP address (as a name resolves to it) is this computer's or the local network's. */
export function isLocalAddress(ip: string): boolean {
  const a = ip.toLowerCase();
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a)?.slice(1).map(Number);
  if (v4) return v4[0] === 0 || v4[0] === 10 || v4[0] === 127 || (v4[0] === 169 && v4[1] === 254) || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127);
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:');
}

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

/**
 * How a picture in a record's text is written until a sync brings it into the library: an image block whose asset is
 * `$image:` and the picture's web address.
 */
export const TEXT_IMAGE = '$image:';

/** The pictures in text a record holds, by their image blocks. */
export function textImages(blocks: unknown): SourceImage[] {
  if (!Array.isArray(blocks)) return [];
  const out: SourceImage[] = [];
  for (const b of blocks as Array<{ type?: unknown; assetId?: unknown; alt?: unknown }>) {
    if (!b || b.type !== 'image' || typeof b.assetId !== 'string' || !b.assetId.startsWith(TEXT_IMAGE)) continue;
    // Whatever address it gives: one that is no picture on the web is refused where every picture's address is.
    out.push({ url: b.assetId.slice(TEXT_IMAGE.length), ...(typeof b.alt === 'string' && b.alt ? { alt: b.alt } : {}) });
  }
  return out;
}

/** The pictures a record shows: its featured image, its image fields', and those in its text and rich text fields. */
export function recordImages(r: NormalizedRecord): SourceImage[] {
  const out: SourceImage[] = [];
  if (isImageRef(r.featuredImage)) out.push(r.featuredImage.$image);
  for (const v of Object.values(r.values ?? {})) {
    if (isImageRef(v)) out.push(v.$image);
    else out.push(...textImages(v));
  }
  out.push(...textImages(r.body));
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
  // A picture in a record's text is one the source has, at its address: never the project's own library image.
  const ownPicture = (blocks: unknown) => Array.isArray(blocks) && blocks.some((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'image' && !String((b as { assetId?: unknown }).assetId ?? '').startsWith(TEXT_IMAGE));
  if (ownPicture(o.body) || (o.values && typeof o.values === 'object' && Object.values(o.values).some(ownPicture))) return 'a record’s text shows a picture by a library ID: give its web address with helpers.image or $image:';
  for (const k of Object.keys(o)) if (!RECORD_KEYS.has(k)) return 'a record has a detail no entry has';
  return null;
}

const RECORD_KEYS = new Set(['externalId', 'title', 'slug', 'publishedAt', 'updatedAt', 'draft', 'author', 'excerpt', 'featuredImage', 'terms', 'values', 'body']);
