/**
 * External sources: where a synced collection's entries come from (a CMS, an API), each described by
 * `siteorigin/sources/<sourceId>/source.json`. A source's settings are part of the project and travel with it, so they
 * never hold a credential: a credential is named (`{ "$secret": "team-read" }`) and its value is kept in the user's
 * own `source-secrets.json`, outside the project (see main/sources/secrets.ts).
 */
import type { SourceDoc, SourceRemoval } from './types';
import { isCollectionId } from './collections';

/** A source's ID and folder name: a lowercase slug, like a collection's. */
export const isSourceId = (id: unknown): id is string => isCollectionId(id);

/** What happens to an entry whose record the source no longer has. Absent: `unpublish`. */
export const SOURCE_REMOVALS: readonly SourceRemoval[] = ['unpublish', 'remove', 'keep'];

/** The removal a source asks for: its own, or `unpublish`, which keeps every link to the entry working. */
export function sourceRemoval(doc: { removal?: unknown } | undefined): SourceRemoval {
  return SOURCE_REMOVALS.includes(doc?.removal as SourceRemoval) ? (doc!.removal as SourceRemoval) : 'unpublish';
}

/** A kind of source, as a source names it: a lowercase word ("rest", "contentful"). */
export const isAdapterId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(id);

/** A secret's name, and a credential slot's: a letter, then letters, numbers, hyphens and underscores. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const isSecretName = (name: unknown): name is string => typeof name === 'string' && NAME_RE.test(name) && !(name in Object.prototype);

/** A setting that names a secret instead of holding its value: exactly `{ "$secret": "<name>" }`. */
export function isSecretRef(v: unknown): v is { $secret: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && isSecretName((v as { $secret?: unknown }).$secret);
}

/** Every secret a source's settings name, once each, sorted. */
export function sourceSecretNames(doc: Pick<SourceDoc, 'config'>): string[] {
  const creds = doc.config?.credentials ?? {};
  return [...new Set(Object.values(creds).flatMap((r) => (isSecretRef(r) ? [r.$secret] : [])))].sort();
}

/** The longest name a source shows. */
export const MAX_SOURCE_NAME = 120;
/** The most credentials a source names. */
const MAX_CREDENTIALS = 20;
const SOURCE_DOC_KEYS = new Set(['schemaVersion', 'id', 'name', 'adapter', 'collectionId', 'config', 'removal']);
const CONFIG_KEYS = new Set(['credentials']);

/**
 * What is wrong with a source's settings document (null when nothing), worded to follow "it". Only settings the project
 * can keep and share pass: a credential is only ever named, slot by slot, so one written into the document by any name
 * stops it, and so does any setting no source takes yet. `folder` is the folder it was read from. The problem never
 * quotes what a setting holds, which may be the very credential.
 */
export function sourceDocProblem(doc: unknown, folder?: string): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'it is not a source’s settings.';
  const d = doc as Record<string, unknown>;
  if (!isSourceId(d.id) || (folder !== undefined && d.id !== folder)) return folder !== undefined ? `its id is not "${folder}", its folder’s name.` : 'its id is not a lowercase name.';
  for (const k of Object.keys(d)) if (!SOURCE_DOC_KEYS.has(k)) return 'it has a setting no source takes.';
  if (typeof d.schemaVersion !== 'number') return 'it has no schema version.';
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > MAX_SOURCE_NAME) return 'its name is missing or too long.';
  if (!isAdapterId(d.adapter)) return 'it names no kind of source.';
  if (!isCollectionId(d.collectionId)) return 'it names no collection to sync into.';
  if (d.removal !== undefined && !SOURCE_REMOVALS.includes(d.removal as SourceRemoval)) return `what happens to an entry the source no longer has is not ${SOURCE_REMOVALS.join(', ')}.`;
  const config = d.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'its settings are damaged.';
  for (const k of Object.keys(config)) if (!CONFIG_KEYS.has(k)) return 'its settings have one no source takes.';
  const creds = (config as { credentials?: unknown }).credentials;
  if (creds !== undefined) {
    if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return 'its credentials are damaged.';
    const slots = Object.entries(creds);
    if (slots.length > MAX_CREDENTIALS) return 'it names too many credentials.';
    for (const [slot, ref] of slots) {
      if (!isSecretName(slot)) return 'one of its credentials has a name a credential cannot have.';
      // The value itself, whatever its shape, is never kept here.
      if (!isSecretRef(ref)) return `its credential "${slot}" holds a value instead of naming a secret. Keep the value as a secret, and name it here with { "$secret": "<name>" }.`;
    }
  }
  return null;
}

/**
 * Whether `text` (a document as it will be written, or what a sync brings) holds any of the user's secret `values`:
 * as written, or escaped as JSON writes it.
 */
export function holdsSecretValue(text: string, values: readonly string[]): boolean {
  return values.some((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH && secretForms(v).some((f) => text.includes(f)));
}

/** A secret as text may carry it: as written, escaped as JSON writes it, and encoded as an address or a form does. */
export function secretForms(v: string): string[] {
  const forms = new Set([v, JSON.stringify(v).slice(1, -1)]);
  try {
    const encoded = encodeURIComponent(v);
    forms.add(encoded);
    forms.add(encoded.replace(/%20/g, '+'));
  } catch {
    // Text no address can carry (a lone surrogate) is only ever written as it is.
  }
  return [...forms];
}

/** The shortest secret kept. Shorter is no credential, and looking for it in text would find ordinary words. */
export const MIN_SECRET_LENGTH = 4;
