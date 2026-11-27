/**
 * What a collection's layout template can show of the entry it is shown for: `{ $entry: field }` reads one of these.
 * Each field behaves as a component property of its type would (a text, a date written as text, a picture, a link,
 * rich text), so a template's elements and the sections placed in it take them where they would take such a property.
 *
 * - `title`, `slug`, `author`, `excerpt`: the entry's own text (`slug` is its address segment, read-only).
 * - `publishedAt`, `updatedAt`: the dates, written as readers of the site's language write them; a text's `datetime`
 *   reads the date itself (YYYY-MM-DD).
 * - `featuredImage`: the entry's library picture, with the library's suggested alt text.
 * - `body`: the entry's text, as rich text.
 * - `categories`: the labels of the entry's categories, in the order they were assigned; `terms.<taxonomy>` reads
 *   any other grouping the same way.
 * - `readingTime`: how many minutes the text takes to read, shown as the site words it ("4 min read"); 0, and nothing
 *   shown, for an entry with no text. A condition compares the minutes, whatever the wording.
 * - `prevEntry`, `nextEntry`: links to the published entries listed just before and just after it, in the
 *   collection's order (`prevEntry.title`, `nextEntry.title`: their titles; `prevEntry.label`, `nextEntry.label`:
 *   their titles said to be the previous or next, as the site words it, "Previous: …"). Empty for the first and the
 *   last. `entryNavLabel` is the site's name for the two links together; empty with neither.
 * - `field.<name>`: the value of one of the collection's custom fields, or its default. A date field is a date as
 *   `publishedAt` is; a reference field shows the titles of the entries it names, separated by commas, and a condition
 *   reads their IDs.
 *
 * A collection whose entries have no text of their own (`hasBody: false`) has no `body` or `readingTime`.
 */
import type { Collection, CollectionFieldSchema, EntryDoc, ImageValue, LinkValue, PropSchema, ProjectState, ReferenceFieldSchema, RichText } from './types';
import { collectionHasBody } from './collections';
import { libraryAlt } from './asset-alt';
import { formatArticleDate, isArticleDate } from './articles';
import { siteLanguage } from './languages';
import { richTextToPlain, isRichBlock } from './richtext';
import { visitorTextFor } from './visitor-text';

/** The fields every entry has, in the order they are offered. */
export const ENTRY_FIELD_NAMES = [
  'title',
  'slug',
  'publishedAt',
  'updatedAt',
  'author',
  'excerpt',
  'featuredImage',
  'categories',
  'body',
  'readingTime',
  'prevEntry',
  'prevEntry.title',
  'prevEntry.label',
  'nextEntry',
  'nextEntry.title',
  'nextEntry.label',
  'entryNavLabel'
] as const;

/**
 * The places of an element in a layout that can show an entry's field: its content. Its tag, a button's style, an
 * icon and what clicking does are the layout's own, the same on every entry, so the page's structure never depends on
 * one entry's value. A placed section's properties (`prop`) and the conditions (`when`, `unless`) can read fields too.
 */
export const ENTRY_CONTENT_FIELDS: ReadonlySet<string> = new Set(['text', 'datetime', 'image', 'fallbackAlt', 'link', 'label', 'ariaLabel', 'prop', 'when', 'unless']);

/** The built-in fields whose value is a date (YYYY-MM-DD). A collection's date fields are too (see isEntryDateField). */
export const ENTRY_DATE_FIELDS: ReadonlySet<string> = new Set(['publishedAt', 'updatedAt']);

/** The fields an entry without text of its own does not have. */
const BODY_FIELDS: ReadonlySet<string> = new Set(['body', 'readingTime']);

/** The taxonomy `categories` reads. */
const CATEGORIES = 'categories';

const text = (label: string, description?: string): PropSchema => ({ type: 'string', label, default: '', ...(description ? { description } : {}) });

const BUILT_IN: Record<(typeof ENTRY_FIELD_NAMES)[number], PropSchema> = {
  // Every entry has a title: a layout can pass it on to a property that requires one.
  title: { ...text('Title'), required: true },
  slug: text('Slug', 'The last segment of the entry\'s address.'),
  publishedAt: text('Publication date'),
  updatedAt: text('Last updated'),
  author: text('Author'),
  excerpt: text('Excerpt'),
  featuredImage: { type: 'image', label: 'Featured image', default: { assetId: null, alt: '' } },
  categories: text('Categories'),
  body: { type: 'richtext', label: 'Text', default: [] },
  readingTime: { type: 'number', label: 'Reading time', default: 0, min: 0, description: 'Minutes the text takes to read, shown as "4 min read".' },
  prevEntry: { type: 'link', label: 'Previous entry', default: { type: 'none', target: '' } },
  'prevEntry.title': text("Previous entry's title"),
  'prevEntry.label': text("Previous entry's link text"),
  nextEntry: { type: 'link', label: 'Next entry', default: { type: 'none', target: '' } },
  'nextEntry.title': text("Next entry's title"),
  'nextEntry.label': text("Next entry's link text"),
  entryNavLabel: text('Name of the previous and next links')
};

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * The property a custom field behaves as: a date or a reference as text (a date written out, the titles of the entries
 * named), every other kind as the property of its kind.
 */
function fieldAsProp(f: CollectionFieldSchema): PropSchema {
  if (f.type === 'date' || f.type === 'reference') return text(typeof f.label === 'string' ? f.label : '', f.description);
  return f;
}

/** Whether a built-in field is one the collection's entries have: all of them, but the text's for entries without text. */
const hasBuiltIn = (collection: Pick<Collection, 'settings'>, field: string) => Object.hasOwn(BUILT_IN, field) && (!BODY_FIELDS.has(field) || collectionHasBody(collection.settings));

/**
 * Every field a collection's template can read, by the name a binding gives it, with the property schema it
 * behaves as: the built-in fields, one per grouping (`terms.<id>`) and one per custom field (`field.<name>`).
 */
export function entryFieldSchemas(collection: Pick<Collection, 'settings'>): Record<string, PropSchema> {
  const out: Record<string, PropSchema> = {};
  for (const name of ENTRY_FIELD_NAMES) if (hasBuiltIn(collection, name)) out[name] = BUILT_IN[name];
  for (const [id, t] of Object.entries(collection.settings.taxonomies ?? {})) out[`terms.${id}`] = text(typeof t?.label === 'string' ? t.label : id);
  for (const [name, f] of Object.entries(collection.settings.fields ?? {})) if (f && typeof f === 'object') out[`field.${name}`] = fieldAsProp(f);
  return out;
}

/** The schema of one field a collection's template can read, or undefined when it has no such field. */
export function entryFieldSchema(collection: Pick<Collection, 'settings'>, field: string): PropSchema | undefined {
  if (typeof field !== 'string') return undefined;
  if (Object.hasOwn(BUILT_IN, field)) return hasBuiltIn(collection, field) ? BUILT_IN[field as keyof typeof BUILT_IN] : undefined;
  if (field.startsWith('terms.')) {
    const t = own(collection.settings.taxonomies, field.slice(6));
    return t ? text(typeof t.label === 'string' ? t.label : field.slice(6)) : undefined;
  }
  if (field.startsWith('field.')) {
    const f = customField(collection, field);
    return f ? fieldAsProp(f) : undefined;
  }
  return undefined;
}

/** The custom field a `field.<name>` binding reads, as the collection declares it. */
function customField(collection: Pick<Collection, 'settings'>, field: string): CollectionFieldSchema | undefined {
  const f = field.startsWith('field.') ? own(collection.settings.fields, field.slice(6)) : undefined;
  return f && typeof f === 'object' ? f : undefined;
}

/** Whether a field's value is a date (YYYY-MM-DD): the only ones a text's `datetime` can read. */
export function isEntryDateField(collection: Pick<Collection, 'settings'>, field: string): boolean {
  return ENTRY_DATE_FIELDS.has(field) || customField(collection, field)?.type === 'date';
}

/**
 * Why a condition cannot compare a field with one value: a reference naming several entries is a list of them, which
 * equals no single value. Null when it can.
 */
export function entryComparisonProblem(collection: Pick<Collection, 'settings'>, field: string): string | null {
  const f = customField(collection, field);
  return f?.type === 'reference' && f.multiple ? `"${f.label}" names several entries, so it equals no single value: test whether it names any instead.` : null;
}

/** How a binding is named to authors: the field's label ("Title", "Price"). */
export function entryFieldLabel(collection: Pick<Collection, 'settings'>, field: string): string {
  return entryFieldSchema(collection, field)?.label ?? field;
}

/** The published entries listed just before and just after an entry, in the collection's order. */
export interface EntryNeighbours {
  prev?: EntryDoc;
  next?: EntryDoc;
}

/** Everything a template's binding reads beyond the entry itself. */
export interface EntryReadContext {
  state: Pick<ProjectState, 'site' | 'assets' | 'collections'>;
  collection: Collection;
  entry: EntryDoc;
  neighbours: EntryNeighbours;
}

/** How a value is wanted: as stored (`raw`: a date as YYYY-MM-DD, for conditions and `datetime`), or as shown. */
export type EntryValueForm = 'raw' | 'shown';

/** The words in a rich text value, for its reading time. */
function wordCount(body: unknown): number {
  if (!Array.isArray(body) || !body.every(isRichBlock)) return 0;
  const plain = richTextToPlain(body as RichText);
  return plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Minutes to read `body` at 200 words a minute, rounded up; 0 for text with no words. */
export function readingMinutes(body: unknown): number {
  const words = wordCount(body);
  return words ? Math.max(1, Math.ceil(words / 200)) : 0;
}

/** A library picture as an image value, with the library's suggested alt text; an empty image without one. */
function pictureValue(state: Pick<ProjectState, 'assets'>, assetId: unknown): ImageValue {
  const a = typeof assetId === 'string' && Object.hasOwn(state.assets.assets, assetId) ? state.assets.assets[assetId] : undefined;
  if (!a || a.kind !== 'image') return { assetId: null, alt: '' };
  return { assetId: a.id, alt: libraryAlt(a) };
}

/**
 * A custom picture field's value as the entry stores it: its own description, or that it is decorative, kept; the
 * library's suggested alt text only for one left without words. A picture the library no longer has shows nothing.
 */
function storedPicture(state: Pick<ProjectState, 'assets'>, value: unknown): ImageValue {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<ImageValue>;
  const found = pictureValue(state, v.assetId ?? null);
  if (!found.assetId) return found;
  if (v.decorative === true) return { assetId: found.assetId, alt: '', decorative: true };
  return { assetId: found.assetId, alt: typeof v.alt === 'string' && v.alt.trim() ? v.alt : found.alt };
}

const entryLink = (e: EntryDoc | undefined): LinkValue => (e ? { type: 'entry', target: e.id } : { type: 'none', target: '' });
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const siteWords = (state: Pick<ProjectState, 'site'>) => visitorTextFor(state.site, siteLanguage(state.site));

/** A neighbour's title in the site's wording for its link; wording that leaves the title out has it after. */
function neighbourLabel(wording: string, neighbour: EntryDoc | undefined): string {
  const title = str(neighbour?.title);
  if (!title) return '';
  // A function, so a title is put in as it is written ("$&" included).
  return wording.includes('{title}') ? wording.replaceAll('{title}', () => title) : `${wording} ${title}`;
}

/**
 * What a reference field holds: the IDs it names (`raw`, one or a list as the field takes them), or the titles of the
 * entries of its collection it names, in its order, separated by commas. An ID the collection has no entry for shows
 * nothing.
 */
function referenceValue(state: Pick<ProjectState, 'collections'>, schema: ReferenceFieldSchema, value: unknown, form: EntryValueForm): unknown {
  const ids = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === 'string' && id !== '');
  if (form === 'raw') return schema.multiple ? ids : (ids[0] ?? '');
  const target = own(state.collections, schema.collection);
  return ids
    .map((id) => str(own(target?.entries, id)?.title))
    .filter(Boolean)
    .join(', ');
}

/**
 * The value one field has for the entry: the type its schema says (text, a picture, a link, rich text, a custom
 * field's number or yes/no), or undefined for a field the collection does not have. A date is written as readers of
 * the site's language write it, unless the `raw` form is asked for.
 */
export function entryFieldValue(ctx: EntryReadContext, field: string, form: EntryValueForm = 'shown'): unknown {
  const { state, collection, entry, neighbours } = ctx;
  if (typeof field !== 'string') return undefined;
  const date = (d: unknown) => (typeof d === 'string' && isArticleDate(d) ? (form === 'raw' ? d : formatArticleDate(d, siteLanguage(state.site))) : '');
  switch (field) {
    case 'title':
      return str(entry.title);
    case 'slug':
      return str(entry.slug);
    case 'publishedAt':
      return date(entry.publishedAt);
    case 'updatedAt':
      return date(entry.updatedAt);
    case 'author':
      return str(entry.author);
    case 'excerpt':
      return str(entry.excerpt);
    case 'featuredImage':
      return pictureValue(state, entry.featuredImage);
    case 'categories':
      return termLabels(collection, entry, CATEGORIES);
    case 'body':
      if (!collectionHasBody(collection.settings)) return undefined;
      return Array.isArray(entry.body) ? entry.body : [];
    case 'readingTime': {
      if (!collectionHasBody(collection.settings)) return undefined;
      const minutes = readingMinutes(entry.body);
      if (form === 'raw') return minutes;
      if (!minutes) return '';
      const wording = siteWords(state).readingTime;
      return wording.replaceAll('{count}', String(minutes));
    }
    case 'prevEntry':
      return entryLink(neighbours.prev);
    case 'nextEntry':
      return entryLink(neighbours.next);
    case 'prevEntry.title':
      return str(neighbours.prev?.title);
    case 'nextEntry.title':
      return str(neighbours.next?.title);
    case 'prevEntry.label':
      return neighbourLabel(siteWords(state).entryPrevious, neighbours.prev);
    case 'nextEntry.label':
      return neighbourLabel(siteWords(state).entryNext, neighbours.next);
    case 'entryNavLabel':
      return neighbours.prev || neighbours.next ? siteWords(state).entryNav : '';
  }
  if (field.startsWith('terms.')) return own(collection.settings.taxonomies, field.slice(6)) ? termLabels(collection, entry, field.slice(6)) : undefined;
  if (field.startsWith('field.')) {
    const name = field.slice(6);
    const schema = own(collection.settings.fields, name);
    if (!schema) return undefined;
    const v = own(entry.values, name);
    const value = v === undefined ? schema.default : v;
    if (schema.type === 'image') return storedPicture(state, value);
    if (schema.type === 'date') return date(value);
    // A reference names no entry unless the entry chooses one, whatever a damaged default says.
    if (schema.type === 'reference') return referenceValue(state, schema, v, form);
    // A rich text field's text is no article: a section heading or a picture a hand edit put there is left out.
    if (schema.type === 'richtext') return Array.isArray(value) ? value.filter((b) => b && typeof b === 'object' && b.type !== 'h2' && b.type !== 'image') : [];
    return value;
  }
  return undefined;
}

/** The labels of an entry's terms in one grouping, in the order they were assigned, separated by commas. */
function termLabels(collection: Collection, entry: EntryDoc, taxonomy: string): string {
  return entryTermLabels(collection, entry, taxonomy).join(', ');
}

/** The labels of an entry's terms in one grouping, in the order they were assigned: one each, none blank. */
export function entryTermLabels(collection: Collection, entry: EntryDoc, taxonomy: string): string[] {
  const t = own(collection.settings?.taxonomies, taxonomy);
  const ids = own(entry.terms, taxonomy);
  if (!t || !Array.isArray(ids)) return [];
  return ids.map((id) => own(t.terms, id)?.label).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
}

/** Whether an entry's value counts as there, as the generated site's `has` judges a value a condition reads. */
export function entryValuePresent(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') {
    if ('assetId' in v) return typeof (v as ImageValue).assetId === 'string' && !!(v as ImageValue).assetId;
    if ('type' in v && 'target' in v) return (v as LinkValue).type !== 'none' && !!(v as LinkValue).target;
    return true;
  }
  return !!v;
}

/**
 * Why a choice field cannot fill a placed section's choice: an option the section does not offer, which every entry
 * choosing it would show as the section's fallback. Null when it fits (or either is not a choice).
 */
export function entryChoiceProblem(field: PropSchema, target: PropSchema | undefined): string | null {
  if (field.type !== 'enum' || target?.type !== 'enum') return null;
  // A choice damaged by a hand edit (no options) is reported with the collection's settings, not here.
  const values = (s: PropSchema) => (Array.isArray((s as { options?: unknown }).options) ? (s as { options: Array<{ value?: unknown }> }).options.map((o) => o?.value) : []);
  const offered = new Set(values(target));
  const missing = values(field).filter((v): v is string => typeof v === 'string' && !offered.has(v));
  return missing.length ? `offers ${missing.map((v) => `"${v}"`).join(', ')}, which "${target.label}" does not have.` : null;
}

