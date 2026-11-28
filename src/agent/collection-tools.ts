/**
 * Posts and other collection entries, for every model (#400): list a collection's entries a page at a time, read one
 * entry with its text as Markdown a part at a time, and write one entry (a new draft, or the fields given of one that
 * exists) with the categories it is filed under, in one call. The write compiles to `collection.createTerm` for each
 * category the collection lacks and one `entry.create` or `entry.update`, applied as one batch with a grant that lets
 * exactly that batch through (see shared/collection-grant), so it goes through the same scope check, validation and
 * undo group as any other edit. Every schema is closed and plain, so a grammar-constrained local model can call them.
 */
import { z } from 'zod';
import type { Collection, CollectionFieldSchema, CollectionFieldValue, EntryDoc, ProjectState } from '@shared/types';
import { COLLECTION_FIELD_TYPES, MAX_GALLERY_PHOTOS } from '@shared/types';
import { galleryRows } from '@shared/gallery-field';
import { TEXT_LIMITS } from '@shared/text-limits';
import type { EditOperation } from '@shared/ops';
import { assignedTermIds, collectionKind, entryRoute, hasDetailPages, inSiteFeed, isCollectionId, isSyncedCollection, orderedEntries, termIdFor } from '@shared/collections';
import { syncedRefusal } from '@shared/collection-grant';
import { ENTRY_LINK_PREFIX, entryTarget, isImageBlock, richTextToMarkdown, type RichBlock, type RichText } from '@shared/richtext';
import { sha256Hex } from '@shared/sha256';
import { MAX_CAPTION, MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS, normalizeRichText } from '@engine/values';
import { fieldError, type FieldIssue } from './macros';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';
import { applyFailure, toolError } from './result';

/** Entries listed per call: enough to find a post by its title, few enough for a small window. */
export const ENTRY_LIST_PAGE = 10;
/** How much of an entry's text one read shows, measured as the result carries it (escaped). */
export const ENTRY_PART_CHARS = 4000;
/** The most lines a call writes as an entry's text, and the longest line: what an entry's text may hold, so any post
 *  that can be read can be written back with its paragraphs whole. */
const MAX_BODY_LINES = MAX_ENTRY_BLOCKS;
const MAX_BODY_LINE = MAX_ENTRY_CHARS;

const collectionId = z.string().min(1).max(60).describe('From read_project collections.');
/** The most groupings, and custom fields, one call writes: every one a collection may have. */
const MAX_GROUPINGS = 10;
const MAX_VALUES = 40;
/** A custom field's value as a call sends it, read as the field's type takes it (see entryValue). */
/** One photo of a gallery field as a call sends it: its picture, its own words, and its ID to keep the one it edits or moves. */
const GALLERY_PHOTO = z
  .object({
    id: z.string().min(1).max(64).optional().describe('The photo\'s ID as values shows it, to keep that photo (its place, words, description); leave it out for a new photo.'),
    assetId: z.string().min(1).max(80).describe('A library image\'s assetId.'),
    alt: z.string().max(TEXT_LIMITS.imageAlt).optional().describe('Its description; left out, a kept photo keeps its own and a new one shows the library\'s suggestion.'),
    caption: z.string().max(MAX_CAPTION).optional().describe('"" or left out for none.')
  })
  .strict();
type GalleryPhoto = z.infer<typeof GALLERY_PHOTO>;
const FIELD_VALUE = z.union([z.string().max(MAX_ENTRY_CHARS), z.number(), z.boolean(), z.array(z.string().max(MAX_ENTRY_CHARS)).max(50), z.array(GALLERY_PHOTO).max(MAX_GALLERY_PHOTOS), z.null()]);
const VALUE_FORMAT =
  'Each value as its field\'s type takes it: text, number or true/false; an enum field one of its options; a date "YYYY-MM-DD" ("" for none); an image field a library image\'s assetId ("" for none; the one it shows, sent back, keeps its alt text); a link "https://…", a page route, "mailto:…", "tel:…" or "entry:en_…"; richtext Markdown; a reference an entry ID of its collection ("" for none), a list of them when it takes several; a gallery every photo in order, each { id?, assetId, alt?, caption? } ([] for none). null goes back to the field\'s default.';
const entryId = z.string().min(1).max(40).describe('en_… from list_collection_entries.');
const offset = z.number().int().min(0).optional().describe('Go on from the next a previous call returned.');

export const LIST_ENTRIES_ARGS = z.object({ collectionId, offset }).strict();
export const READ_ENTRY_ARGS = z
  .object({ collectionId, entryId, offset, field: z.string().min(1).max(60).optional().describe('A custom field to read whole in place of the text (long text a part at a time): one that values shows cut short (clipped), or any other.') })
  .strict();
export const UPSERT_ENTRY_ARGS = z
  .object({
    collectionId,
    entryId: z.string().min(1).max(40).optional().describe('The entry to edit; leave it out to create a new draft.'),
    title: z.string().min(1).max(200).optional().describe('Required for a new entry.'),
    publishedAt: z.string().max(10).optional().describe('YYYY-MM-DD.'),
    updatedAt: z.string().max(10).optional().describe('When it was last revised, YYYY-MM-DD. "" removes it.'),
    draft: z.boolean().optional().describe('false publishes it.'),
    author: z.string().max(80).optional().describe('The byline. "" removes it.'),
    excerpt: z.string().max(320).optional().describe('"" removes it.'),
    categories: z.array(z.string().min(1).max(80)).max(20).optional().describe('Category names; replaces its categories, [] removes them. A name the collection lacks is added.'),
    terms: z
      .array(z.object({ taxonomyId: z.string().min(1).max(60).describe('A grouping other than categories, from read_project collections taxonomies ("tags", say).'), names: z.array(z.string().min(1).max(80)).max(20) }).strict())
      .max(MAX_GROUPINGS)
      .optional()
      .describe('Terms of its other groupings, by name: each grouping given replaces its terms, names: [] removes them; others stay. A name the grouping lacks is added.'),
    featuredImage: z.string().min(1).max(80).nullable().optional().describe('A library image\'s assetId (an image attached to the request, or from search_assets); null removes it.'),
    values: z
      .array(z.object({ field: z.string().min(1).max(60).describe('A custom field\'s name, from read_project collections fields.'), value: FIELD_VALUE }).strict())
      .max(MAX_VALUES)
      .optional()
      .describe(`Custom field values: only the fields given change. ${VALUE_FORMAT}`),
    body: z
      .array(z.string().max(MAX_BODY_LINE))
      .max(MAX_BODY_LINES)
      .optional()
      .describe('The whole text, replacing it: one block per line.'),
    blockEdit: z
      .object({
        block: z.number().int().min(0).max(MAX_BODY_LINES).describe('The block to change: its number in blocks, from read_collection_entry.'),
        hash: z.string().min(1).max(16).describe("That block's hash, as read."),
        revision: z.number().int().min(0).describe('The revision of that read (or of a block edit of this entry since, whose result names it).'),
        // Markdown escapes literal marks, so a block the engine holds can take up to twice its length to send back.
        text: z.string().min(1).max(2 * MAX_BODY_LINE).describe('The whole block again as Markdown, with the change made: one paragraph, heading, quote or list.')
      })
      .strict()
      .optional()
      .describe('Change one block of the text alone, in place of body: every other block, pictures included, stays as it is.')
  })
  .strict();
export type ListEntriesArgs = z.infer<typeof LIST_ENTRIES_ARGS>;
export type ReadEntryArgs = z.infer<typeof READ_ENTRY_ARGS>;
export type UpsertEntryArgs = z.infer<typeof UPSERT_ENTRY_ARGS>;

/** How one block is changed alone (#1120): the locator a read returns, checked against the revision it was read at. */
const BLOCK_EDIT_FORMAT =
  "To change one paragraph, heading, quote or list alone, send blockEdit: its block and hash from the read's blocks, that read's revision, and the whole block again as Markdown with the change made, once you have read it to its end. Every other block, pictures included, stays as it is, with its block and hash, at the revision the result gives; text after the block moves, so read again for any part not yet read. After STALE_REVISION, read that part again and use what it returns.";
const BODY_FORMAT =
  'Each line of body is a block: a paragraph, "## " or "### " a heading, "- " or "1. " a list item, "> " a quote, with **bold**, *italic* and [label](/route/, https://… or entry:en_…) links. A picture line (![…](asset:…)) is placed by the author: keep each one exactly as read (its alt text and caption cannot be changed here), on a line of its own, where it belongs.';

export const LIST_ENTRIES_DESCRIPTION = `List a collection's entries (blog posts, projects), ${ENTRY_LIST_PAGE} at a time in the collection's order, drafts included: each entry's ID, title, date and whether it is a draft. Call again with offset set to next for more.`;
export const LIST_ENTRIES_BRIEF = `${ENTRY_LIST_PAGE} entries at a time: ID, title, date, draft. More: offset=next.`;
export const READ_ENTRY_DESCRIPTION =
  "Read one entry of a collection: its title, date, last-revised date and author when it has them, draft status, excerpt, featured image, categories, other terms and custom field values, and its text as Markdown a part at a time. blocks locates each block of the part in the text (from start to end), with a hash for each one blockEdit can change. Call again with offset set to next until next is null before rewriting the text: body replaces it whole. A value shown cut short (clipped) is read whole with field, the same way, before it is rewritten; one marked editorOnly is the author's to change in the editor: leave it out of values to keep it.";
export const READ_ENTRY_BRIEF = 'Its details, and its text as Markdown a part at a time, with blocks (number, start, end, hash): offset=next until next is null, before rewriting it whole. A clipped value: field, the same way. editorOnly: leave it out.';
export const UPSERT_ENTRY_DESCRIPTION = `Create a draft entry of a collection (a blog post, a team member), or change one by its entryId: only the fields given change, the rest stays as it is. categories files it under categories by name, adding any the collection lacks, and terms under the terms of its other groupings, by name too. values sets its custom fields (read_project collections lists them); featuredImage is its picture. ${BODY_FORMAT} Send body only to rewrite the whole text, after reading all of it. ${BLOCK_EDIT_FORMAT} A collection synced from an external source (readOnly) cannot be written.`;
export const UPSERT_ENTRY_BRIEF = `Only the fields given change. categories and terms by name; values for custom fields. ${BODY_FORMAT} Send body only after reading all the text; blockEdit (block, hash, revision, text) changes one block alone. Never for a readOnly collection.`;
/** The same tool in a run limited to one post, which may not create an entry or add a category (scope.ts). */
const PINNED_CATEGORIES = 'Category names the collection already has; replaces its categories, [] removes them. A new category is more than this request may change: ask to widen the scope first.';
const PINNED_TERMS = 'Terms its other groupings already have, by name: each grouping given replaces its terms. A new term is more than this request may change: ask to widen the scope first.';
export const UPSERT_PINNED_ENTRY_DESCRIPTION = `Change this post: only the fields given change, the rest stays as it is. categories files it under categories its collection already has, by name. ${BODY_FORMAT} Send body only to rewrite the whole text, after reading all of it. ${BLOCK_EDIT_FORMAT}`;
export const UPSERT_PINNED_ENTRY_BRIEF = `Only the fields given change; categories only by names the collection has. ${BODY_FORMAT} Send body only after reading all the text; blockEdit (block, hash, revision, text) changes one block alone.`;

/** The collection a call names, with its IDs listed when there is none. */
function collectionFor(state: ProjectState, id: string): { collection: Collection } | { error: FieldIssue } {
  if (Object.hasOwn(state.collections ?? {}, id)) return { collection: state.collections[id] };
  const ids = Object.keys(state.collections ?? {}).sort();
  return { error: { field: 'collectionId', message: ids.length ? `there is no collection "${id}". Collections: ${ids.join(', ')}` : 'this project has no collections yet. The author adds one in the Posts panel' } };
}

/** The entry a call names in its collection. */
function entryFor(collection: Collection, id: string): { entry: EntryDoc } | { error: FieldIssue } {
  if (Object.hasOwn(collection.entries, id)) return { entry: collection.entries[id] };
  return { error: { field: 'entryId', message: `the ${collection.settings.name} collection has no entry "${id}". Use an entryId list_collection_entries returns` } };
}

/** An entry's terms of one grouping by name, in the order it was filed under them. */
function termNames(collection: Collection, entry: EntryDoc, taxonomyId: string): string[] {
  const terms = (Object.hasOwn(collection.settings.taxonomies ?? {}, taxonomyId) ? collection.settings.taxonomies[taxonomyId].terms : undefined) ?? {};
  const ids = entry.terms && Object.hasOwn(entry.terms, taxonomyId) && Array.isArray(entry.terms[taxonomyId]) ? entry.terms[taxonomyId] : [];
  return ids.map((id) => (Object.hasOwn(terms, id) ? terms[id].label : id));
}

/** Its terms of every grouping but categories, by name: as `terms` writes them. */
function otherTerms(collection: Collection, entry: EntryDoc): Array<{ taxonomyId: string; names: string[] }> {
  return Object.keys(collection.settings.taxonomies ?? {})
    .filter((t) => t !== 'categories')
    .map((taxonomyId) => ({ taxonomyId, names: termNames(collection, entry, taxonomyId) }))
    .filter((t) => t.names.length);
}

/** Most characters a custom text or rich text value shows in a read, and most entries a list of them; more are read whole with `field`. */
const VALUE_CHARS = 400;
const REFERENCES_SHOWN = 10;

/** A custom text or rich text value as text: rich text as its Markdown. */
function valueText(schema: CollectionFieldSchema, v: CollectionFieldValue, pages: ProjectState['pages']): string | null {
  if (schema.type === 'richtext') return richTextToMarkdown(Array.isArray(v) ? (v as RichText) : [], pages);
  return schema.type === 'string' && typeof v === 'string' ? v : null;
}

/**
 * A link as values writes it back: a page by its route (with its section), an entry as "entry:en_…", an address as
 * itself. Null for one the tool cannot write as it is (a document, one opening in a new tab, a sponsored link): the
 * author sets those in the editor.
 */
function linkShown(v: CollectionFieldValue, pages: ProjectState['pages']): string | null {
  const l = v && typeof v === 'object' && 'type' in v ? v : null;
  if (!l || l.type === 'none') return '';
  if (l.newTab || l.rel?.length || l.type === 'document') return null;
  const anchor = l.anchor ? `#${l.anchor}` : '';
  switch (l.type) {
    case 'page':
      return `${Object.hasOwn(pages, l.target) ? pages[l.target].route : l.target}${anchor}`;
    case 'entry':
      return anchor ? null : `${ENTRY_LINK_PREFIX}${l.target}${l.query ?? ''}`;
    case 'email':
      return `mailto:${l.target}`;
    case 'tel':
      return `tel:${l.target}`;
    case 'anchor':
      return `#${l.target}`;
    default:
      return l.target;
  }
}

/** A custom field's value as values writes it back, and whether it was cut short or is the editor's to change. */
function valueShown(schema: CollectionFieldSchema, v: CollectionFieldValue, pages: ProjectState['pages']): { value: unknown; clipped?: true; editorOnly?: true } {
  // A gallery's photos in order, each by its ID, so a call sending them back edits or moves the ones it names.
  if (schema.type === 'gallery') return { value: galleryRows(v).map((r) => ({ id: r.id, assetId: r.image.assetId, ...(r.image.alt ? { alt: r.image.alt } : {}), ...(r.caption ? { caption: r.caption } : {}) })) };
  // An image by its asset ID ("" for one emptied on purpose); written back as read, it keeps its alt text as it is.
  if (schema.type === 'image') return { value: v && typeof v === 'object' && 'assetId' in v ? (v.assetId ?? '') : null };
  // A long list of entries is shown in part, and read whole with field.
  if (schema.type === 'reference' && Array.isArray(v) && v.length > REFERENCES_SHOWN) return { value: v.slice(0, REFERENCES_SHOWN), clipped: true };
  if (schema.type === 'link') {
    const shown = linkShown(v, pages);
    return shown === null ? { value: null, editorOnly: true } : { value: shown };
  }
  const text = valueText(schema, v, pages);
  if (text !== null && text.length > VALUE_CHARS) return { value: `${text.slice(0, VALUE_CHARS)}…`, clipped: true };
  return { value: text ?? v };
}

/** One custom value whole (read with field): a list of entries in full. */
function valueShownWhole(schema: CollectionFieldSchema, v: CollectionFieldValue, pages: ProjectState['pages']): { value: unknown; editorOnly?: true } {
  if (schema.type === 'reference') return { value: v };
  const { clipped: _c, ...shown } = valueShown(schema, v, pages);
  return shown;
}

/** The custom values an entry has of its own, by field: those it leaves to the field's default are not listed. */
function entryValues(collection: Collection, entry: EntryDoc, pages: ProjectState['pages']): Array<{ field: string; value: unknown; clipped?: true; editorOnly?: true }> {
  const fields = collection.settings.fields ?? {};
  const values = entry.values && typeof entry.values === 'object' ? entry.values : {};
  return Object.keys(fields)
    .filter((f) => Object.hasOwn(values, f) && !!fields[f] && typeof fields[f] === 'object')
    .map((field) => ({ field, ...valueShown(fields[field], values[field], pages) }));
}

/**
 * Why a run limited to one post may not read what a call names, or null. Such a run reads only its post: another
 * post's words are not what the author asked about, and stay out of the request until the author allows more.
 */
function outsidePost(host: ToolHost, collectionId: string, entryId?: string, verb = 'read'): FieldIssue | null {
  const limit = host.entryLimit?.() ?? null;
  if (!limit || (collectionId === limit.collectionId && entryId === limit.entryId)) return null;
  return { field: entryId === undefined ? 'collectionId' : 'entryId', message: `this request is about ${limit.label} (${limit.collectionId}/${limit.entryId}) alone, so only it can be ${verb}` };
}

export function runListEntries(args: ListEntriesArgs, host: ToolHost): ToolOutcome {
  const outside = outsidePost(host, args.collectionId);
  if (outside) return fieldError([outside], 'Nothing was read.');
  const state = host.state();
  const found = collectionFor(state, args.collectionId);
  if ('error' in found) return fieldError([found.error], 'Nothing was read.');
  const all = orderedEntries(found.collection).filter((e) => !!e && typeof e === 'object');
  const start = Math.min(args.offset ?? 0, all.length);
  const rows = all.slice(start, start + ENTRY_LIST_PAGE).map((e) => ({ entryId: e.id, title: e.title, publishedAt: e.publishedAt, ...(e.draft !== false ? { draft: true } : {}) }));
  const end = start + rows.length;
  return { ok: true, content: { revision: host.revision(), collectionId: found.collection.settings.id, total: all.length, offset: start, next: end < all.length ? end : null, entries: rows } };
}

/** One part of `text` from `offset`, about `room` characters long as a tool result carries it, never between the two halves of a character. */
export function textPart(text: string, offset: number, room: number): { start: number; end: number; next: number | null } {
  let start = Math.min(Math.max(0, offset), text.length);
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(start)) && /[\uD800-\uDBFF]/.test(text.charAt(start - 1))) start--;
  let end = Math.min(text.length, start + room);
  while (end > start + 1 && JSON.stringify(text.slice(start, end)).length - 2 > room) end = start + Math.floor((end - start) * 0.9);
  if (end < text.length && end > start + 1 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return { start, end, next: end < text.length ? end : null };
}

/** JSON with object keys in order, so a block stored with its keys in another order hashes the same. */
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * The hash a read gives one block of an entry's text, and a block edit sends back (#1120): of the block as stored, at its
 * place in its entry, so a hash read for one of two identical paragraphs never passes for the other, nor for a block of
 * another entry.
 */
export function entryBlockHash(collectionId: string, entryId: string, index: number, block: RichBlock): string {
  return sha256Hex(sortedJson([collectionId, entryId, index, block])).slice(0, 16);
}

/** Where one block of an entry's text sits in its Markdown, as a read lists it: a prose block with its hash, a picture marked as one. */
type BlockRow = { block: number; start: number; end: number; hash: string } | { block: number; start: number; end: number; picture: true };

/**
 * One part of an entry's text from `offset`, with a row for each block it shows any of. The rows count toward the part's
 * size with the text, so a text of many short paragraphs still reads in parts of about the same size.
 */
export function bodyPart(body: RichText, pages: ProjectState['pages'], collectionId: string, entryId: string, offset: number): { text: string; length: number; start: number; end: number; next: number | null; blocks: BlockRow[] } {
  // The text is its blocks' Markdown joined by a blank line, as richTextToMarkdown writes it whole.
  const ranges: BlockRow[] = [];
  let at = 0;
  const shown = body.map((b, i) => {
    const md = richTextToMarkdown([b], pages);
    ranges.push(isImageBlock(b) ? { block: i, start: at, end: at + md.length, picture: true } : { block: i, start: at, end: at + md.length, hash: entryBlockHash(collectionId, entryId, i, b) });
    at += md.length + 2;
    return md;
  });
  const text = shown.join('\n\n');
  // A block whose text is empty is shown by the part it starts in.
  const rowsFor = (start: number, end: number) => ranges.filter((r) => r.start < end && (r.end > start || r.start >= start));
  let room = ENTRY_PART_CHARS;
  for (;;) {
    const part = textPart(text, offset, room);
    const blocks = rowsFor(part.start, part.end);
    const size = JSON.stringify(text.slice(part.start, part.end)).length - 2 + JSON.stringify(blocks).length;
    if (size <= ENTRY_PART_CHARS || room <= 1) return { text: text.slice(part.start, part.end), length: text.length, ...part, blocks };
    room = Math.max(1, Math.min(room - 1, Math.floor((room * ENTRY_PART_CHARS) / size)));
  }
}

export function runReadEntry(args: ReadEntryArgs, host: ToolHost): ToolOutcome {
  const outside = outsidePost(host, args.collectionId, args.entryId);
  if (outside) return fieldError([outside], 'Nothing was read.');
  const state = host.state();
  const found = collectionFor(state, args.collectionId);
  if ('error' in found) return fieldError([found.error], 'Nothing was read.');
  const hit = entryFor(found.collection, args.entryId);
  if ('error' in hit) return fieldError([hit.error], 'Nothing was read.');
  const { collection } = found;
  const { entry } = hit;
  // One custom field's value whole, a part at a time: one too long to show beside the rest.
  if (args.field !== undefined) {
    const fields = collection.settings.fields ?? {};
    const schema = Object.hasOwn(fields, args.field) ? fields[args.field] : undefined;
    const stored = entry.values && Object.hasOwn(entry.values, args.field) ? entry.values[args.field] : schema?.default;
    if (!schema || typeof schema !== 'object') return fieldError([{ field: 'field', message: `the ${collection.settings.name} collection has no field "${args.field}"` }], 'Nothing was read.');
    const whole = valueText(schema, stored as CollectionFieldValue, state.pages);
    // Anything but text is read whole at once, as values writes it.
    if (whole === null) return { ok: true, content: { revision: host.revision(), collectionId: collection.settings.id, entryId: entry.id, field: args.field, type: schema.type, ...valueShownWhole(schema, stored as CollectionFieldValue, state.pages) } };
    const at = textPart(whole, args.offset ?? 0, ENTRY_PART_CHARS);
    return { ok: true, content: { revision: host.revision(), collectionId: collection.settings.id, entryId: entry.id, field: args.field, format: schema!.type === 'richtext' ? 'markdown' : 'text', length: whole.length, offset: at.start, next: at.next, text: whole.slice(at.start, at.end) } };
  }
  const body = Array.isArray(entry.body) ? entry.body : [];
  const part = bodyPart(body, state.pages, collection.settings.id, entry.id, args.offset ?? 0);
  return {
    ok: true,
    content: {
      revision: host.revision(),
      collectionId: collection.settings.id,
      entryId: entry.id,
      // The details come with the first part: a later part is only more of the text.
      ...(part.start === 0
        ? {
            title: entry.title,
            publishedAt: entry.publishedAt,
            ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
            ...(entry.author ? { author: entry.author } : {}),
            draft: entry.draft !== false,
            ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
            ...(entry.featuredImage ? { featuredImage: entry.featuredImage } : {}),
            categories: termNames(collection, entry, 'categories'),
            ...(otherTerms(collection, entry).length ? { terms: otherTerms(collection, entry) } : {}),
            // Every custom field it can fill in, those it leaves to their default included, so a run limited to it can name
            // them: ahead of the values, which a long result may lose first.
            ...(Object.keys(collection.settings.fields ?? {}).length ? { fields: Object.entries(collection.settings.fields ?? {}).flatMap(([name, f]) => (f && typeof f === 'object' ? [{ name, type: f.type }] : [])) } : {}),
            ...(entryValues(collection, entry, state.pages).length ? { values: entryValues(collection, entry, state.pages) } : {}),
            ...(entryRoute(collection, entry) !== undefined ? { route: entryRoute(collection, entry) } : {}),
            ...(isSyncedCollection(collection.settings) ? { readOnly: true } : {})
          }
        : {}),
      format: 'markdown',
      length: part.length,
      offset: part.start,
      next: part.next,
      text: part.text,
      blocks: part.blocks
    }
  };
}

/**
 * The asset an element of the text places as a picture, or null where it places none. Looser than a read writes it, so a line
 * retyped with other quotes, text around it or a block marker is still caught. A read escapes the brackets of literal
 * text, so its own words never match.
 */
function pictureIn(text: string): string | null {
  const open = text.indexOf('![');
  const m = open < 0 ? null : /\]\(\s*<?\s*asset:([^\s)"'>]*)/.exec(text.slice(open + 2));
  return m ? m[1] : null;
}

/**
 * The text a call sent, as the operation takes it: a picture line exactly as read from the entry becomes that picture
 * again (a picture is placed with the library picker, never typed), in the order the lines put them. Any other picture
 * line is refused: one altered would otherwise lose its change, or be written as text in the picture's place.
 */
function bodyValue(lines: string[], current: RichText, pages: ProjectState['pages'], issues: FieldIssue[]): Array<string | RichBlock> {
  const pictures = current.filter(isImageBlock);
  // Each picture as a read wrote it: the same image placed twice, with its own caption, is told apart by its line.
  const read = pictures.map((p) => richTextToMarkdown([p], pages));
  const used = new Set<number>();
  return lines.map((raw, i) => {
    const line = raw.trim();
    const at = read.findIndex((r, j) => !used.has(j) && r === line);
    if (at >= 0) {
      used.add(at);
      return structuredClone(pictures[at]);
    }
    // The whole element, however its lines fall: the engine would write any of it as text.
    const assetId = pictureIn(raw);
    if (assetId === null) return raw;
    issues.push({
      field: `body[${i}]`,
      message: pictures.some((p) => p.assetId === assetId)
        ? "this picture line does not match a picture of the entry that is still to be placed. A picture's alt text and caption are changed by the author in the editor: send each picture line exactly as read, once, as a body line of its own, or leave it out to remove that picture"
        : `the entry has no picture "${assetId}" to keep here. Pictures are added by the author; keep each picture line as read, or leave it out to remove that picture`
    });
    return raw;
  });
}

/**
 * The text with one block replaced (#1120): every other block exactly as stored, and the new one as the engine will
 * store it. Null, with the problem said, when the Markdown is not one prose block, or when storing it would also change
 * a neighbour (a list sent between two lists joins them into one).
 */
function blockEditValue(edit: NonNullable<UpsertEntryArgs['blockEdit']>, body: RichText, state: ProjectState, issues: FieldIssue[]): RichText | null {
  const issue = (message: string) => (issues.push({ field: 'blockEdit.text', message }), null);
  if (pictureIn(edit.text) !== null) return issue('a picture is placed by the author, never typed: send the block of text alone, and leave the pictures to stay where they are');
  const store = (v: unknown): RichText | string => {
    try {
      return normalizeRichText(v, state, 'the block', undefined, { entries: true });
    } catch (e) {
      return (e as Error).message;
    }
  };
  const made = store(edit.text);
  if (typeof made === 'string') return issue(made.replace(/\.$/, ''));
  if (!made.length) return issue('the block is empty. To take a block out, send body with the whole text without it');
  if (made.length > 1) return issue(`this Markdown makes ${made.length} blocks, and blockEdit changes one. Send the one block (its lines are one block when they are items of one list), or body to add blocks`);
  const next = body.slice();
  next[edit.block] = made[0];
  const stored = store(next);
  if (typeof stored === 'string') return issue(stored.replace(/\.$/, ''));
  // Every other block as any write stores it: one kept in a form the engine writes more simply (two spans with the same
  // marks, left by a link pointed elsewhere) is no change of the author's, and does not stand in the way.
  const was = store(body);
  const expected = typeof was === 'string' || was.length !== body.length ? null : was.map((b, i) => (i === edit.block ? made[0] : b));
  if (!expected || sortedJson(stored) !== sortedJson(expected)) return issue('stored there, this block would join or change the block next to it (a list beside a list becomes one). Send another kind of block, or body with the whole text');
  return stored;
}

/**
 * The terms of one grouping named, as term IDs: one the grouping has (by name, ignoring case), else a new one's planned
 * ID. `field`: where a problem is said ("categories", "terms[0].names").
 */
function termIds(collection: Collection, taxonomyId: string, names: string[], issues: FieldIssue[], field: string): { ids: string[]; create: Array<{ taxonomyId: string; label: string; termId: string }> } {
  // A collection without categories or tags yet gets the grouping with its first term, as collection.createTerm adds it.
  const taxonomy = Object.hasOwn(collection.settings.taxonomies ?? {}, taxonomyId) ? collection.settings.taxonomies[taxonomyId] : undefined;
  const known = Object.entries(taxonomy?.terms ?? {});
  // Each new ID is kept from the next, so two names that read the same as a slug get IDs of their own.
  const taken = assignedTermIds(collection, taxonomyId);
  const planned: Record<string, unknown> = { ...taxonomy?.terms };
  const ids: string[] = [];
  const create: Array<{ taxonomyId: string; label: string; termId: string }> = [];
  const fold = (s: string) => s.trim().toLowerCase();
  for (const [i, raw] of names.entries()) {
    const label = raw.trim();
    // A blank name is never a term: [] is how every term of the grouping is taken off.
    if (!label) {
      issues.push({ field: `${field}[${i}]`, message: taxonomyId === 'categories' ? 'a category needs a name' : 'a term needs a name' });
      continue;
    }
    const existing = known.find(([, t]) => fold(t.label) === fold(label)) ?? create.map((c) => [c.termId, { label: c.label }] as const).find(([, t]) => fold(t.label) === fold(label));
    const id = existing ? existing[0] : termIdFor(planned, label, undefined, taken);
    if (!existing) {
      planned[id] = { label };
      create.push({ taxonomyId, label, termId: id });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, create };
}

/** The groupings a call files the entry under: categories by name, and every other grouping it names in `terms`. */
function termsValue(collection: Collection, categories: string[] | undefined, terms: UpsertEntryArgs['terms'], issues: FieldIssue[]): { terms: Record<string, string[]>; create: Array<{ taxonomyId: string; label: string; termId: string }> } | null {
  if (categories === undefined && terms === undefined) return null;
  const out: Record<string, string[]> = {};
  const create: Array<{ taxonomyId: string; label: string; termId: string }> = [];
  const add = (taxonomyId: string, names: string[], field: string) => {
    // Clearing a grouping the collection does not have yet changes nothing: there is nothing to take off.
    if (!names.length && !Object.hasOwn(collection.settings.taxonomies ?? {}, taxonomyId)) return;
    const r = termIds(collection, taxonomyId, names, issues, field);
    out[taxonomyId] = r.ids;
    create.push(...r.create);
  };
  if (categories) add('categories', categories, 'categories');
  const groupings = collection.settings.taxonomies ?? {};
  for (const [i, t] of (terms ?? []).entries()) {
    const id = t.taxonomyId.trim();
    if (id === 'categories') issues.push({ field: `terms[${i}].taxonomyId`, message: 'categories are sent as categories, by name' });
    else if (Object.hasOwn(out, id)) issues.push({ field: `terms[${i}].taxonomyId`, message: `"${id}" is given twice` });
    // Tags come with their first term, as categories do; any other grouping is one the collection already has.
    else if (id !== 'tags' && !Object.hasOwn(groupings, id)) {
      const ids = Object.keys(groupings).filter((g) => g !== 'categories');
      issues.push({ field: `terms[${i}].taxonomyId`, message: `the ${collection.settings.name} collection has no grouping "${id}"${ids.length ? `. Its other groupings: ${ids.join(', ')}` : ''}` });
    } else add(id, t.names, `terms[${i}].names`);
  }
  return { terms: out, create };
}

/**
 * One custom field's value as the operation takes it, read as the field's type takes it: the engine checks the rest
 * (an enum's options, a reference's entries, an image in the library). Null goes back to the field's default.
 */
function entryValue(field: string, schema: CollectionFieldSchema, v: string | number | boolean | string[] | GalleryPhoto[] | null, issues: FieldIssue[], at: string, stored?: CollectionFieldValue, library?: ProjectState['assets']['assets']): unknown {
  if (v === null) return null;
  const wrong = (wants: string) => (issues.push({ field: at, message: `“${field}” is a ${schema.type} field: ${wants}` }), undefined);
  switch (schema.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : wrong('send a number');
    case 'boolean':
      return typeof v === 'boolean' ? v : wrong('send true or false');
    case 'reference':
      if (schema.multiple) return Array.isArray(v) && v.every((id) => typeof id === 'string') ? v : wrong('send a list of entry IDs ([] for none)');
      return typeof v === 'string' ? v : wrong('send one entry ID ("" for none)');
    case 'gallery': {
      if (!Array.isArray(v) || !v.every((p) => p && typeof p === 'object')) return wrong('send every photo in order, each { id?, assetId, alt?, caption? } ([] for none)');
      // A photo sent with its ID and the picture it shows keeps its description and whether it is decorative unless
      // the call gives another; the engine checks the rest (the ID, the picture in the library).
      const before = new Map(galleryRows(stored).map((r) => [r.id, r]));
      return (v as GalleryPhoto[]).map((p) => {
        const was = p.id !== undefined ? before.get(p.id) : undefined;
        const kept = was && was.image.assetId === p.assetId ? was.image : undefined;
        const image = p.alt !== undefined ? { assetId: p.assetId, alt: p.alt } : kept ? structuredClone(kept) : { assetId: p.assetId, alt: '' };
        return { ...(p.id !== undefined ? { id: p.id } : {}), image, caption: p.caption ?? '' };
      });
    }
    case 'richtext':
      // Markdown as read: one string, which the field reads as its text is written (a hard break stays in its block),
      // or one block per line.
      return typeof v === 'string' || (Array.isArray(v) && v.every((line) => typeof line === 'string')) ? v : wrong('send its text as Markdown');
    case 'link':
      if (typeof v !== 'string') return wrong('send an address: "https://…", a page route, "mailto:…", "tel:…" or "entry:en_…"');
      return v.trim().startsWith(ENTRY_LINK_PREFIX) ? { type: 'entry', ...entryTarget(v.trim().slice(ENTRY_LINK_PREFIX.length)) } : v.trim();
    case 'image': {
      if (typeof v !== 'string') return wrong("send a library image's assetId (\"\" for none)");
      const id = v.trim();
      if (!id) return { assetId: null, alt: '' };
      // The picture it already shows keeps its alt text and whether it is decorative, as the author set them, while
      // the library still has it as a picture; otherwise the ID is checked as any other.
      const kept = !!stored && typeof stored === 'object' && 'assetId' in stored && stored.assetId === id && library?.[id]?.kind === 'image';
      return kept ? structuredClone(stored) : id;
    }
    default:
      return typeof v === 'string' ? v : wrong(schema.type === 'enum' ? `send one of its options (${schema.options.map((o) => o.value).join(', ')})` : schema.type === 'date' ? 'send a date written YYYY-MM-DD ("" for none)' : 'send text');
  }
}

/** The custom field values a call sends, by field name, as entry.create and entry.update take them. */
function valuesOf(collection: Collection, values: NonNullable<UpsertEntryArgs['values']>, issues: FieldIssue[], entry?: EntryDoc, library?: ProjectState['assets']['assets']): Record<string, unknown> {
  const fields = collection.settings.fields ?? {};
  const out: Record<string, unknown> = {};
  for (const [i, { field, value }] of values.entries()) {
    const at = `values[${i}]`;
    if (Object.hasOwn(out, field)) {
      issues.push({ field: at, message: `“${field}” is given twice` });
      continue;
    }
    if (!Object.hasOwn(fields, field)) {
      const names = Object.keys(fields);
      issues.push({ field: `${at}.field`, message: names.length ? `the ${collection.settings.name} collection has no field "${field}". Its fields: ${names.join(', ')}` : `the ${collection.settings.name} collection has no custom fields: define_collection adds them` });
      continue;
    }
    const stored = entry?.values && Object.hasOwn(entry.values, field) ? entry.values[field] : undefined;
    const v = entryValue(field, fields[field], value, issues, `${at}.value`, stored, library);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

const given = <T extends object>(v: T): Partial<T> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;

/** What one entry of a collection is called where a change is labelled: "Team member" of Team, else "post" of a blog. */
const entryNoun = (collection: Collection) => (collection.settings.singularName?.trim() || (collectionKind(collection.settings) === 'structured' ? 'entry' : 'post')).toLowerCase();

export async function runUpsertEntry(args: UpsertEntryArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  // A block edit in a run limited to one post names that post, before anything says whether another has such a block.
  const outside = args.blockEdit ? outsidePost(host, args.collectionId, args.entryId, 'changed') : null;
  if (outside) return toolError('SCOPE_MISMATCH', `${outside.field}: ${outside.message}. Nothing was applied. Change this post's blocks, or ask with request_clarification (widenScope: true) to change another.`);
  const state = host.state();
  const revision = host.revision();
  const found = collectionFor(state, args.collectionId);
  if ('error' in found) return fieldError([found.error], 'Nothing was applied.');
  const { collection } = found;
  // A synced collection's entries are its source's: nothing is planned for them, and the author detaches it to edit them.
  if (isSyncedCollection(collection.settings)) return toolError('SCOPE_MISMATCH', `${syncedRefusal(collection.settings.name)} Nothing was applied.`, { details: { collectionId: collection.settings.id, sourceId: collection.settings.sourceId } });
  const { collectionId: _c, entryId: id, categories, terms: groupings, values, body, blockEdit, title, ...rest } = args;
  const issues: FieldIssue[] = [];
  let entry: EntryDoc | undefined;
  if (id !== undefined) {
    const hit = entryFor(collection, id);
    if ('error' in hit) return fieldError([hit.error], 'Nothing was applied.');
    entry = hit.entry;
  } else if (!title?.trim()) issues.push({ field: 'title', message: 'a new entry needs a title' });
  let edited: RichText | null = null;
  if (blockEdit) {
    if (!entry) return fieldError([{ field: 'blockEdit', message: 'a block edit changes a block of an entry that exists: send its entryId, or body for a new entry' }], 'Nothing was applied.');
    if (body) return fieldError([{ field: 'blockEdit', message: 'send blockEdit or body, not both: body replaces the whole text' }], 'Nothing was applied.');
    const where = `block ${blockEdit.block} of ${collection.settings.id}/${entry.id}`;
    const reread = 'Nothing was applied. Read that part of the entry again with read_collection_entry, and send the block, hash and revision it returns.';
    if (blockEdit.revision !== revision) return toolError('STALE_REVISION', `The read of ${where} was at revision ${blockEdit.revision}, and the project is at ${revision} now. ${reread}`, { revision });
    const current = Array.isArray(entry.body) ? entry.body : [];
    if (!current.some((b) => !isImageBlock(b))) return fieldError([{ field: 'blockEdit', message: `the entry's text has no block of text to change: send body with the whole text${current.length ? ', keeping each picture line as read' : ''}` }], 'Nothing was applied.');
    if (blockEdit.block >= current.length) return fieldError([{ field: 'blockEdit.block', message: `the entry's text has ${current.length} block${current.length === 1 ? '' : 's'} (0 to ${current.length - 1}): use a block number its blocks list` }], 'Nothing was applied.');
    if (isImageBlock(current[blockEdit.block])) return fieldError([{ field: 'blockEdit.block', message: `${where} is a picture, which the author changes in the editor: choose a block of text` }], 'Nothing was applied.');
    if (entryBlockHash(collection.settings.id, entry.id, blockEdit.block, current[blockEdit.block]) !== blockEdit.hash) return toolError('STALE_REVISION', `${where} does not have the hash "${blockEdit.hash}". ${reread}`, { revision });
    edited = blockEditValue(blockEdit, current, state, issues);
  }
  const fields: Record<string, unknown> = given(rest);
  if (title !== undefined) fields.title = title.trim();
  if (fields.publishedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(fields.publishedAt))) issues.push({ field: 'publishedAt', message: `"${String(fields.publishedAt)}" is not a date written YYYY-MM-DD` });
  if (fields.updatedAt !== undefined) {
    // "" removes the revision date: the operation's null.
    if (!String(fields.updatedAt).trim()) fields.updatedAt = null;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields.updatedAt))) issues.push({ field: 'updatedAt', message: `"${String(fields.updatedAt)}" is not a date written YYYY-MM-DD` });
  }
  // An emptied author or excerpt is the operation's null: the entry keeps none.
  if (fields.excerpt !== undefined && !String(fields.excerpt).trim()) fields.excerpt = null;
  if (fields.author !== undefined) fields.author = String(fields.author).trim() || null;
  const terms = termsValue(collection, categories, groupings, issues);
  if (terms) fields.terms = terms.terms;
  if (values?.length) fields.values = valuesOf(collection, values, issues, entry, state.assets.assets);
  if (body) fields.body = bodyValue(body, Array.isArray(entry?.body) ? entry.body : [], state.pages, issues);
  if (edited) fields.body = edited;
  if (entry && !Object.keys(fields).length) issues.push({ field: 'arguments', message: 'send at least one field to change' });
  if (issues.length) return fieldError(issues, 'Nothing was applied.');

  const ops: EditOperation[] = [
    ...(terms?.create ?? []).map((t): EditOperation => ({ type: 'collection.createTerm', collectionId: collection.settings.id, taxonomyId: t.taxonomyId, label: t.label, termId: t.termId })),
    (entry ? { type: 'entry.update', collectionId: collection.settings.id, entryId: entry.id, ...fields } : { type: 'entry.create', collectionId: collection.settings.id, title: fields.title, ...fields }) as EditOperation
  ];
  const noun = entryNoun(collection);
  const label = entry ? `Edit ${noun} “${String(fields.title ?? entry.title).slice(0, 60)}”` : `Draft ${noun} “${String(fields.title).slice(0, 60)}”`;
  const res = await host.apply(ops, revision, label, callId, { collectionWrite: { kind: 'entry', collectionId: collection.settings.id, ...(entry ? { entryId: entry.id } : {}) } });
  if (!res.ok) return applyFailure(res, blockEdit && res.error?.code === 'STALE_REVISION' ? 'Read that part of the entry again with read_collection_entry, and send the block, hash and revision it returns.' : undefined);
  const written = (res.results?.at(-1) ?? {}) as { entryId?: string; slug?: string; route?: string };
  const added = (taxonomyId: string) => (terms?.create ?? []).filter((t) => t.taxonomyId === taxonomyId).map((t) => t.label);
  const addedTerms = Object.fromEntries([...new Set((terms?.create ?? []).map((t) => t.taxonomyId))].filter((t) => t !== 'categories').map((t) => [t, added(t)]));
  return {
    ok: true,
    mutated: true,
    ops,
    results: res.results,
    content: {
      ok: true,
      revision: res.revision,
      collectionId: collection.settings.id,
      entryId: written.entryId ?? entry?.id,
      ...(written.route ? { route: written.route } : {}),
      ...(added('categories').length ? { addedCategories: added('categories') } : {}),
      ...(Object.keys(addedTerms).length ? { addedTerms } : {}),
      // The block as it is now: the entry's other blocks keep the number and hash they were read with, at this revision.
      ...(blockEdit && edited ? { block: { block: blockEdit.block, hash: entryBlockHash(collection.settings.id, entry!.id, blockEdit.block, edited[blockEdit.block]) } } : {}),
      ...(!entry ? { draft: fields.draft === false ? false : true } : {})
    }
  };
}

const schemaOf = (args: z.ZodType): JsonSchema & { properties: Record<string, unknown>; required?: string[] } => {
  const schema = z.toJSONSchema(args, { unrepresentable: 'any', io: 'input' }) as JsonSchema & { properties: Record<string, unknown>; required?: string[] };
  delete schema.$schema;
  return schema;
};

/** The project's collections, by ID, as a closed choice: a small model then never names one it does not have. */
function collectionChoice(state: ProjectState, only?: string): Record<string, unknown> {
  const ids = only !== undefined ? [only] : Object.keys(state.collections ?? {}).sort();
  return { type: 'string', enum: ids, ...(only !== undefined ? { description: 'This request may change only this post.' } : {}) };
}

/**
 * The three tools' schemas for one run. `pin`: the one entry a run limited to a post reads and writes, with no way to
 * name another, nor to create one.
 */
export function collectionToolSchemas(state: ProjectState, pin?: { collectionId: string; entryId: string }): { list: JsonSchema; read: JsonSchema; upsert: JsonSchema } {
  const list = schemaOf(LIST_ENTRIES_ARGS);
  const read = schemaOf(READ_ENTRY_ARGS);
  const upsert = schemaOf(UPSERT_ENTRY_ARGS);
  const choice = collectionChoice(state, pin?.collectionId);
  list.properties.collectionId = choice;
  read.properties.collectionId = choice;
  upsert.properties.collectionId = choice;
  if (pin) {
    const only = { type: 'string', enum: [pin.entryId], description: 'This request may change only this post.' };
    read.properties.entryId = only;
    upsert.properties.entryId = only;
    upsert.required = [...new Set([...(upsert.required ?? []), 'entryId'])];
    upsert.properties.categories = { ...(upsert.properties.categories as object), description: PINNED_CATEGORIES };
    upsert.properties.terms = { ...(upsert.properties.terms as object), description: PINNED_TERMS };
  }
  return { list, read, upsert };
}

// ---------------------------------------------------------------------------
// define_collection (#679): a collection's shape, made or changed in one call
// ---------------------------------------------------------------------------

const FIELD_ROW = z
  .object({
    name: z.string().min(1).max(40).describe('Stable camelCase name ("role", "photo"): what values and bindings call it ("field.role").'),
    type: z.enum(COLLECTION_FIELD_TYPES),
    label: z.string().min(1).max(80).optional().describe('What the author reads. Defaults to the name.'),
    options: z.array(z.string().min(1).max(60)).min(1).max(50).optional().describe('enum only: its choices, in order.'),
    collection: z.string().min(1).max(60).optional().describe('reference only: the ID of the collection whose entries it names (this one, or another).'),
    multiple: z.boolean().optional().describe('reference only: a list of entries rather than one.')
  })
  .strict();

export const DEFINE_COLLECTION_ARGS = z
  .object({
    action: z.enum(['create', 'update']).describe('create a new collection, or update one read_project lists.'),
    collectionId: z.string().min(1).max(60).describe('Its stable lowercase ID and folder name ("team", "case-studies"); for update, from read_project collections. "posts" is the ready-made blog.'),
    name: z.string().min(1).max(80).optional().describe('What it is called ("Team"). Defaults to one made from the ID.'),
    singularName: z.string().max(80).optional().describe('What one entry is called ("Team member"). "" removes it.'),
    kind: z.enum(['editorial', 'structured']).optional().describe('"editorial": dated articles such as blog posts (the default); "structured": records such as team members, projects or events.'),
    hasBody: z.boolean().optional().describe('Whether entries have text of their own besides their fields. Default true.'),
    pages: z
      .object({ detail: z.boolean(), archive: z.boolean() })
      .strict()
      .optional()
      .describe('Its pages on the website: one per entry (detail) and an index (archive, which needs detail). Default both; neither makes it data that other pages show.'),
    route: z.string().min(1).max(200).optional().describe('The address its pages start with ("/team/"). Only with pages.'),
    rss: z.boolean().nullable().optional().describe('Whether its published entries are listed in the website\'s RSS feed. Default: editorial yes, structured no (so staff or listings never join a blog\'s feed); null goes back to that default.'),
    fields: z.array(FIELD_ROW).max(30).optional().describe('Custom fields each entry fills in. update: a field named here is added, or relabelled (an enum also gains the options given); every field it has stays, with its values.'),
    taxonomies: z
      .array(z.object({ id: z.string().min(1).max(60).describe('Stable lowercase ID ("departments").'), label: z.string().min(1).max(60) }).strict())
      .max(10)
      .optional()
      .describe('Groupings its entries are filed under (categories, tags, or its own). update: one named here is added or relabelled; every grouping and term it has stays.')
  })
  .strict();
export type DefineCollectionArgs = z.infer<typeof DEFINE_COLLECTION_ARGS>;

export const DEFINE_COLLECTION_DESCRIPTION =
  'Create a collection (a Team, Projects or Events: entries kept apart from the pages), or change one. A blog is the ready-made collection "posts": create it with only collectionId "posts", which brings its index at /blog/, categories, tags and the RSS feed. A change sets its name, what one entry is called, its kind, pages and address, and its custom fields and groupings. An update only adds and relabels: every field, option, grouping and term the collection has stays, with every entry\'s values. Then write its entries with upsert_collection_entry (custom fields as values), show them on a page with connect_collection_list, or in a section placed by upsert_page_with_sections. A collection synced from an external source (readOnly) cannot be changed.';
export const DEFINE_COLLECTION_BRIEF = 'Create a collection, or update one. A blog is the ready-made "posts" (create with only that collectionId). An update only adds or relabels fields and groupings, keeping every one it has. Then its entries with upsert_collection_entry. Never a readOnly one.';

/** A field row as collection.create and collection.update take it: the new field, or the field it has with what the row adds. */
function fieldSchema(row: z.infer<typeof FIELD_ROW>, was: CollectionFieldSchema | undefined, issues: FieldIssue[], at: string): Record<string, unknown> | null {
  if (row.options !== undefined && row.type !== 'enum') issues.push({ field: `${at}.options`, message: 'only an enum field has options' });
  if ((row.collection !== undefined || row.multiple !== undefined) && row.type !== 'reference') issues.push({ field: `${at}.collection`, message: 'only a reference field names a collection' });
  if (!was) {
    if (row.type === 'enum' && !row.options?.length) issues.push({ field: `${at}.options`, message: 'an enum field needs its options' });
    if (row.type === 'reference' && !row.collection) issues.push({ field: `${at}.collection`, message: 'a reference field names the collection whose entries it holds' });
    return {
      type: row.type,
      label: row.label?.trim() || row.name,
      ...(row.type === 'enum' ? { options: (row.options ?? []).map((v) => ({ value: v.trim(), label: v.trim() })) } : {}),
      ...(row.type === 'reference' ? { collection: row.collection, ...(row.multiple ? { multiple: true } : {}) } : {})
    };
  }
  // A field it has keeps what it is: its type, the entries it names, its default and every option.
  if (row.type !== was.type) {
    issues.push({ field: `${at}.type`, message: `“${row.name}” is a ${was.type} field, and its type stays: add a new field instead` });
    return null;
  }
  if (was.type === 'reference' && ((row.collection !== undefined && row.collection !== was.collection) || (row.multiple !== undefined && row.multiple !== !!was.multiple))) {
    issues.push({ field: `${at}.collection`, message: `“${row.name}” names entries of ${was.collection}${was.multiple ? ', several at a time' : ''}, and that stays: add a new field instead` });
    return null;
  }
  const next: Record<string, unknown> = { ...structuredClone(was), ...(row.label?.trim() ? { label: row.label.trim() } : {}) };
  if (was.type === 'enum' && row.options) {
    const have = new Set(was.options.map((o) => o.value));
    next.options = [...was.options, ...row.options.map((v) => v.trim()).filter((v) => !have.has(v)).map((v) => ({ value: v, label: v }))];
  }
  return next;
}

export async function runDefineCollection(args: DefineCollectionArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const revision = host.revision();
  const id = args.collectionId.trim();
  const exists = Object.hasOwn(state.collections ?? {}, id);
  const ids = () => Object.keys(state.collections ?? {}).sort();
  if (args.action === 'create' && exists) return fieldError([{ field: 'collectionId', message: `there is already a collection "${id}": use action "update" to change it, or choose another ID` }], 'Nothing was applied.');
  if (args.action === 'create' && !isCollectionId(id)) return fieldError([{ field: 'collectionId', message: `"${id}" is not a collection ID: lowercase letters, numbers and hyphens, starting with a letter` }], 'Nothing was applied.');
  if (args.action === 'update' && !exists) return fieldError([{ field: 'collectionId', message: ids().length ? `there is no collection "${id}". Collections: ${ids().join(', ')}` : 'this project has no collections yet: use action "create"' }], 'Nothing was applied.');
  const collection = exists ? state.collections[id] : undefined;
  if (collection && isSyncedCollection(collection.settings)) return toolError('SCOPE_MISMATCH', `${syncedRefusal(collection.settings.name)} Nothing was applied.`, { details: { collectionId: id, sourceId: collection.settings.sourceId } });

  const issues: FieldIssue[] = [];
  const settings: Record<string, unknown> = given({ name: args.name?.trim(), kind: args.kind, hasBody: args.hasBody, pages: args.pages, route: args.route?.trim(), rss: args.rss });
  if (args.singularName !== undefined) settings.singularName = args.singularName.trim() || (collection ? null : undefined);
  if (settings.singularName === undefined) delete settings.singularName;
  if (args.fields) {
    const have = collection?.settings.fields ?? {};
    const fields: Record<string, unknown> = structuredClone(have) as Record<string, unknown>;
    const named = new Set<string>();
    for (const [i, row] of args.fields.entries()) {
      const name = row.name.trim();
      if (named.has(name)) {
        issues.push({ field: `fields[${i}].name`, message: `“${name}” is listed twice` });
        continue;
      }
      named.add(name);
      const schema = fieldSchema({ ...row, name }, Object.hasOwn(have, name) ? have[name] : undefined, issues, `fields[${i}]`);
      if (schema) fields[name] = schema;
    }
    settings.fields = fields;
  }
  if (args.taxonomies) {
    const have = collection?.settings.taxonomies ?? {};
    const taxonomies: Record<string, { label: string; terms: Record<string, { label: string }> }> = structuredClone(have);
    const named = new Set<string>();
    for (const [i, t] of args.taxonomies.entries()) {
      const tid = t.id.trim();
      if (named.has(tid)) issues.push({ field: `taxonomies[${i}].id`, message: `“${tid}” is listed twice` });
      named.add(tid);
      taxonomies[tid] = { label: t.label.trim(), terms: Object.hasOwn(have, tid) ? structuredClone(have[tid].terms ?? {}) : {} };
    }
    settings.taxonomies = taxonomies;
  }
  if (collection && !Object.keys(settings).length) issues.push({ field: 'arguments', message: 'send at least one setting, field or grouping to change' });
  if (issues.length) return fieldError(issues, 'Nothing was applied.');

  const op = { type: args.action === 'create' ? 'collection.create' : 'collection.update', collectionId: id, ...settings } as EditOperation;
  const name = String(settings.name ?? collection?.settings.name ?? id);
  const label = collection ? `Change collection “${name.slice(0, 60)}”` : `Add collection “${name.slice(0, 60)}”`;
  const res = await host.apply([op], revision, label, callId, { collectionWrite: { kind: 'schema', collectionId: id, action: args.action } });
  if (!res.ok) return applyFailure(res);
  const now = host.state().collections?.[id]?.settings;
  return {
    ok: true,
    mutated: true,
    ops: [op],
    results: res.results,
    content: {
      ok: true,
      revision: res.revision,
      collectionId: id,
      ...(now ? { name: now.name, kind: collectionKind(now), inRss: hasDetailPages(now) && inSiteFeed(now), fields: Object.keys(now.fields ?? {}), taxonomies: Object.keys(now.taxonomies ?? {}), ...(hasDetailPages(now) && now.route ? { route: now.route } : {}) } : {})
    }
  };
}

/** define_collection's schema for one run. */
export function defineCollectionSchema(): JsonSchema {
  return schemaOf(DEFINE_COLLECTION_ARGS);
}
