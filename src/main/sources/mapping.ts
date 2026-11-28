/**
 * Putting a record a source sent in the shape of an entry, by its mapping: each detail is read at its path, and made
 * what an entry holds there (text, a calendar day, a picture by its address, the text of an article), by what its
 * collection's field holds for a custom field. What a record does not have is left out; what cannot be read as its
 * detail is said, by record and detail, never by what it holds.
 */
import type { LinkValue, RichText, SourceMapping } from '@shared/types';
import { readPath } from '@shared/source-paths';
import { TEXT_LIMITS } from '@shared/text-limits';
import { isArticleDate } from '@shared/articles';
import { contentfulRichText, htmlRichText, markdownRichText, plainRichText, type LinkRead } from './richtext';
import { decodeEntities } from '../posts-import/html';
import type { FieldKinds, NormalizedRecord, SourceImageRef } from './protocol';

/** A mapping problem, by the record's place in the list and the detail. */
export class MappingError extends Error {}

/** A day, alone or followed by its time (`2026-11-18`, `2026-11-18T13:30:00Z`, `2026-11-18 13:30`). */
const DAY = /^(\d{4}-\d{2}-\d{2})(?:$|[Tt ]\d{2}:\d{2})/;

/** Text as one line, cut to `max` characters at a word where it can be, and never inside a character. */
export function oneLine(v: string, max: number): string {
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let cut = '';
  for (const ch of t) {
    if (cut.length + ch.length > max - 1) break;
    cut += ch;
  }
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : cut.length).trimEnd()}…`;
}

/** HTML as plain text: tags gone, character references read. */
export function plainText(v: string): string {
  return decodeEntities(v.replace(/<[^>]*>/g, ' '));
}

/** A scalar as text, or undefined for anything else (an object, a list). */
function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return undefined;
}

/** A calendar day (YYYY-MM-DD) from a date or a date and time, or undefined. A day the calendar lacks is none. */
export function calendarDay(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(new Date(v).getTime())) return new Date(v).toISOString().slice(0, 10);
  const t = text(v);
  const m = t ? DAY.exec(t.trim()) : null;
  return m && isArticleDate(m[1]) ? m[1] : undefined;
}

/** How a date is said to be written, where one cannot be read. */
const DATE_WORDS = 'a date written YYYY-MM-DD, such as 2026-11-18';

/** Whether a record has nothing at a path: no value, or only blank text. */
const absent = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && !v.trim());

/** A web address as a picture's, from the address itself or an object holding one (a CMS's asset). */
function imageUrl(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('//')) return `https:${t}`;
    return /^https?:\/\//i.test(t) ? t : undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  // Contentful's asset, Sanity's, Strapi's and WordPress's media: each says where the file is in its own way.
  for (const path of ['url', 'src', 'source_url', 'fields.file.url', 'file.url', 'asset.url']) {
    const u = readPath(o, path);
    if (typeof u === 'string') return imageUrl(u);
  }
  return undefined;
}

function imageAlt(v: unknown): string | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  for (const path of ['alt', 'alternativeText', 'alt_text', 'fields.description', 'fields.title', 'description']) {
    const a = readPath(v, path);
    if (typeof a === 'string' && a.trim()) return oneLine(a, TEXT_LIMITS.imageAlt);
  }
  return undefined;
}

/** A picture reference for an address, with what the source calls it. */
export function imageRef(v: unknown, alt?: string): SourceImageRef | undefined {
  const url = imageUrl(v);
  if (!url) return undefined;
  const given = alt ?? imageAlt(v);
  return { $image: { url, ...(given ? { alt: given } : {}) } };
}

/** Formatted text as an entry's text, in the format given or the one it is plainly in, its links read as `read` says. */
export function richTextOf(v: unknown, format: SourceMapping['bodyFormat'], read: LinkRead = { dropped: 0 }): RichText | undefined {
  if (v === undefined || v === null) return undefined;
  if (v && typeof v === 'object' && (v as { nodeType?: unknown }).nodeType === 'document') return contentfulRichText(v, read);
  const t = text(v);
  if (t === undefined) return undefined;
  if (format === 'html') return htmlRichText(t, read);
  if (format === 'markdown') return markdownRichText(t, read);
  if (format === 'contentful') return contentfulRichText(t, read);
  return plainRichText(t);
}

const KIND_WORDS: Record<string, string> = { number: 'a number', boolean: 'true or false', date: DATE_WORDS, image: 'a picture’s web address', link: 'a web, email or phone address', richtext: 'text' };

/** A value as the kind of custom field it is synced into holds it, or undefined when it cannot be. */
export function fieldValue(v: unknown, kind: string | undefined, read: LinkRead = { dropped: 0 }): unknown {
  if (v === undefined || v === null) return undefined;
  switch (kind) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 'true' || v === 1 || v === '1' ? true : v === 'false' || v === 0 || v === '0' ? false : undefined;
    case 'date':
      return calendarDay(v);
    case 'image':
      return imageRef(v);
    case 'link': {
      const t = (text(v) ?? (v && typeof v === 'object' ? text((v as { url?: unknown }).url) : undefined))?.trim();
      return t && /^(https?:\/\/|mailto:|tel:)/i.test(t) ? ({ type: /^mailto:/i.test(t) ? 'email' : /^tel:/i.test(t) ? 'tel' : 'url', target: t.replace(/^(mailto|tel):/i, '') } satisfies LinkValue) : undefined;
    }
    // A rich text field holds words, never pictures (an entry's own text does).
    case 'richtext':
      return richTextOf(v, typeof v === 'string' && /<\/?[a-z][^>]*>/i.test(v) ? 'html' : 'text', read)?.filter((b) => b.type !== 'image');
    case 'reference':
      return undefined;
    default: {
      const t = text(v);
      return t === undefined ? undefined : t;
    }
  }
}

/** Why a mapping cannot be read into the collection's fields, or null: one it lacks, or one that names other entries. */
export function mappingFieldsProblem(mapping: SourceMapping, fields: FieldKinds): string | null {
  for (const field of Object.keys(mapping.values ?? {})) {
    if (!Object.hasOwn(fields, field)) return `the collection has no field “${field.slice(0, 60)}”, which its mapping reads`;
    // Which entries a record names is not synced (records are matched to entries by their own IDs).
    if (fields[field] === 'reference') return `the ${field.slice(0, 60)} field names other entries, which a sync does not fill in`;
  }
  return null;
}

/**
 * A record as an entry: each detail read where the mapping says, else where the kind of source reads it. `fields` are
 * the collection's custom fields: a value the mapping reads for a field the collection lacks is refused, so a typo is
 * said instead of dropped. `read` is where the record's formatted text was shown, for its relative links, and counts
 * the links in it whose address cannot be kept.
 */
export function mapRecord(item: unknown, mapping: SourceMapping, fields: FieldKinds, index: number, read: LinkRead = { dropped: 0 }): NormalizedRecord {
  const where = `record ${index + 1}`;
  const at = (k: keyof Omit<SourceMapping, 'values' | 'bodyFormat'>) => (mapping[k] !== undefined ? readPath(item, mapping[k]!) : undefined);
  const id = text(at('externalId'));
  if (!id?.trim()) throw new MappingError(`${where} has no ID at ${mapping.externalId ?? 'the path its ID is read from'}`);
  const title = text(at('title'));
  if (!title?.trim()) throw new MappingError(`${where} has no title at ${mapping.title ?? 'the path its title is read from'}`);
  // An ID is never cut short: two records whose IDs began alike would be one entry.
  const r: NormalizedRecord = { externalId: id.trim(), title: oneLine(plainText(title), 200) };
  const slug = text(at('slug'));
  if (slug?.trim()) r.slug = slug.trim().slice(0, 400);
  // A date there that cannot be read is said, never left for the sync's own day to stand in for it.
  for (const [k, words] of [['publishedAt', 'published date'], ['updatedAt', 'updated date']] as const) {
    const raw = at(k);
    if (absent(raw)) continue;
    const day = calendarDay(raw);
    if (!day) throw new MappingError(`${where}’s ${words} at ${mapping[k]!.slice(0, 60)} is not ${DATE_WORDS}`);
    r[k] = day;
  }
  const draft = at('draft');
  // Anything that says draft, in any of the ways a source writes true, keeps it a draft.
  if (draft !== undefined && draft !== null) r.draft = draft === true || draft === 1 || (typeof draft === 'string' && /^(true|1|yes|draft)$/i.test(draft.trim()));
  const author = text(at('author'));
  if (author?.trim()) r.author = oneLine(author, 80);
  const excerpt = text(at('excerpt'));
  if (excerpt?.trim()) r.excerpt = oneLine(plainText(excerpt), 320);
  const image = at('featuredImageUrl');
  if (image !== undefined && image !== null && image !== '') {
    const alt = text(at('featuredImageAlt'));
    const ref = imageRef(image, alt?.trim() ? oneLine(alt, TEXT_LIMITS.imageAlt) : undefined);
    // An address there that is not a picture's on the web is said, never cleared from the entry.
    if (!ref) throw new MappingError(`${where}’s featured image at ${mapping.featuredImageUrl!.slice(0, 60)} is not a picture’s web address`);
    r.featuredImage = ref;
  }
  const body = richTextOf(at('body'), mapping.bodyFormat, read);
  if (body?.length) r.body = body;
  const values: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(mapping.values ?? {})) {
    if (!Object.hasOwn(fields, field)) throw new MappingError(`the collection has no field “${field.slice(0, 60)}” for ${where}’s ${path.slice(0, 60)}`);
    // Which entries a record names is not synced (records are matched to entries by their own IDs), so a mapping to it
    // is said rather than left empty.
    if (fields[field] === 'reference') throw new MappingError(`the ${field.slice(0, 60)} field names other entries, which a sync does not fill in`);
    const raw = readPath(item, path);
    const v = fieldValue(raw, fields[field], read);
    // A value there that is not one its field holds is said, never cleared from the entry.
    if (v === undefined && raw !== undefined && raw !== null) throw new MappingError(`${where}’s ${field.slice(0, 60)} at ${path.slice(0, 60)} is not ${KIND_WORDS[fields[field]] ?? 'text'}`);
    if (v !== undefined) values[field] = v;
  }
  if (Object.keys(values).length) r.values = values;
  return r;
}

/**
 * What a converter gave, put right where it plainly means a picture: an address given for the featured image or an
 * image field becomes a picture reference. Anything else is checked as it is.
 */
export function shapeConverted(r: unknown, fields: FieldKinds): unknown {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  const o = { ...(r as Record<string, unknown>) };
  if (typeof o.externalId === 'number') o.externalId = String(o.externalId);
  if (typeof o.featuredImage === 'string') o.featuredImage = imageRef(o.featuredImage);
  if (o.values && typeof o.values === 'object' && !Array.isArray(o.values)) {
    const values = { ...(o.values as Record<string, unknown>) };
    for (const [k, v] of Object.entries(values)) if (Object.hasOwn(fields, k) && fields[k] === 'image' && typeof v === 'string') values[k] = imageRef(v);
    o.values = values;
  }
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
