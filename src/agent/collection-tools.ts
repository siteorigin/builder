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
import { COLLECTION_FIELD_TYPES } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { assignedTermIds, collectionKind, entryRoute, hasDetailPages, isCollectionId, isSyncedCollection, orderedEntries, termIdFor } from '@shared/collections';
import { syncedRefusal } from '@shared/collection-grant';
import { ENTRY_LINK_PREFIX, isImageBlock, richTextToMarkdown, type RichBlock, type RichText } from '@shared/richtext';
import { MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS } from '@engine/values';
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
const FIELD_VALUE = z.union([z.string().max(MAX_ENTRY_CHARS), z.number(), z.boolean(), z.array(z.string().max(MAX_ENTRY_CHARS)).max(50), z.null()]);
const VALUE_FORMAT =
  'Each value as its field\'s type takes it: text, number or true/false; an enum field one of its options; a date "YYYY-MM-DD" ("" for none); an image field a library image\'s assetId; a link "https://…", a page route, "mailto:…", "tel:…" or "entry:en_…"; richtext Markdown, one block per line in a list; a reference an entry ID of its collection ("" for none), a list of them when it takes several. null goes back to the field\'s default.';
const entryId = z.string().min(1).max(40).describe('en_… from list_collection_entries.');
const offset = z.number().int().min(0).optional().describe('Go on from the next a previous call returned.');

export const LIST_ENTRIES_ARGS = z.object({ collectionId, offset }).strict();
export const READ_ENTRY_ARGS = z
  .object({ collectionId, entryId, offset, field: z.string().min(1).max(60).optional().describe('A custom field to read whole, a part at a time, in place of the text: one that values shows cut short (clipped).') })
  .strict();
export const UPSERT_ENTRY_ARGS = z
  .object({
    collectionId,
    entryId: z.string().min(1).max(40).optional().describe('The entry to edit; leave it out to create a new draft.'),
    title: z.string().min(1).max(200).optional().describe('Required for a new entry.'),
    publishedAt: z.string().max(10).optional().describe('YYYY-MM-DD.'),
    draft: z.boolean().optional().describe('false publishes it.'),
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
      .describe('The whole text, replacing it: one block per line.')
  })
  .strict();
export type ListEntriesArgs = z.infer<typeof LIST_ENTRIES_ARGS>;
export type ReadEntryArgs = z.infer<typeof READ_ENTRY_ARGS>;
export type UpsertEntryArgs = z.infer<typeof UPSERT_ENTRY_ARGS>;

const BODY_FORMAT =
  'Each line of body is a block: a paragraph, "## " or "### " a heading, "- " or "1. " a list item, "> " a quote, with **bold**, *italic* and [label](/route/, https://… or entry:en_…) links. A picture line (![…](asset:…)) is placed by the author: keep each one as read, where it belongs.';

export const LIST_ENTRIES_DESCRIPTION = `List a collection's entries (blog posts, projects), ${ENTRY_LIST_PAGE} at a time in the collection's order, drafts included: each entry's ID, title, date and whether it is a draft. Call again with offset set to next for more.`;
export const LIST_ENTRIES_BRIEF = `${ENTRY_LIST_PAGE} entries at a time: ID, title, date, draft. More: offset=next.`;
export const READ_ENTRY_DESCRIPTION =
  "Read one entry of a collection: its title, date, draft status, excerpt, featured image, categories, other terms and custom field values, and its text as Markdown a part at a time. Call again with offset set to next until next is null before rewriting the text: body replaces it whole. A value shown cut short (clipped) is read whole with field, the same way, before it is rewritten; one marked editorOnly is the author's to change in the editor: leave it out of values to keep it.";
export const READ_ENTRY_BRIEF = 'Its details, and its text as Markdown a part at a time: offset=next until next is null, before rewriting it whole. A clipped value: field, the same way. editorOnly: leave it out.';
export const UPSERT_ENTRY_DESCRIPTION = `Create a draft entry of a collection (a blog post, a team member), or change one by its entryId: only the fields given change, the rest stays as it is. categories files it under categories by name, adding any the collection lacks, and terms under the terms of its other groupings, by name too. values sets its custom fields (read_project collections lists them); featuredImage is its picture. ${BODY_FORMAT} Send body only to change the text, after reading all of it. A collection synced from an external source (readOnly) cannot be written.`;
export const UPSERT_ENTRY_BRIEF = `Only the fields given change. categories and terms by name; values for custom fields. ${BODY_FORMAT} Send body only after reading all the text. Never for a readOnly collection.`;
/** The same tool in a run limited to one post, which may not create an entry or add a category (scope.ts). */
const PINNED_CATEGORIES = 'Category names the collection already has; replaces its categories, [] removes them. A new category is more than this request may change: ask to widen the scope first.';
const PINNED_TERMS = 'Terms its other groupings already have, by name: each grouping given replaces its terms. A new term is more than this request may change: ask to widen the scope first.';
export const UPSERT_PINNED_ENTRY_DESCRIPTION = `Change this post: only the fields given change, the rest stays as it is. categories files it under categories its collection already has, by name. ${BODY_FORMAT} Send body only to change the text, after reading all of it.`;
export const UPSERT_PINNED_ENTRY_BRIEF = `Only the fields given change; categories only by names the collection has. ${BODY_FORMAT} Send body only after reading all the text.`;

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

/** Most characters a custom text or rich text value shows in a read; a longer one is read whole with `field`. */
const VALUE_CHARS = 400;

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
      return anchor ? null : `${ENTRY_LINK_PREFIX}${l.target}`;
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
  if (schema.type === 'image') return { value: v && typeof v === 'object' && 'assetId' in v ? v.assetId : null };
  if (schema.type === 'link') {
    const shown = linkShown(v, pages);
    return shown === null ? { value: null, editorOnly: true } : { value: shown };
  }
  const text = valueText(schema, v, pages);
  if (text !== null && text.length > VALUE_CHARS) return { value: `${text.slice(0, VALUE_CHARS)}…`, clipped: true };
  return { value: text ?? v };
}

/** The custom values an entry has of its own, by field: those it leaves to the field's default are not listed. */
function entryValues(collection: Collection, entry: EntryDoc, pages: ProjectState['pages']): Array<{ field: string; value: unknown; clipped?: true; editorOnly?: true }> {
  const fields = collection.settings.fields ?? {};
  const values = entry.values && typeof entry.values === 'object' ? entry.values : {};
  return Object.keys(fields)
    .filter((f) => Object.hasOwn(values, f))
    .map((field) => ({ field, ...valueShown(fields[field], values[field], pages) }));
}

/**
 * Why a run limited to one post may not read what a call names, or null. Such a run reads only its post: another
 * post's words are not what the author asked about, and stay out of the request until the author allows more.
 */
function outsidePost(host: ToolHost, collectionId: string, entryId?: string): FieldIssue | null {
  const limit = host.entryLimit?.() ?? null;
  if (!limit || (collectionId === limit.collectionId && entryId === limit.entryId)) return null;
  return { field: entryId === undefined ? 'collectionId' : 'entryId', message: `this request is about ${limit.label} (${limit.collectionId}/${limit.entryId}) alone, so only it can be read` };
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
    const whole = schema ? valueText(schema, stored as CollectionFieldValue, state.pages) : null;
    if (whole === null) return fieldError([{ field: 'field', message: schema ? `“${args.field}” is a ${schema.type} field, which values shows whole` : `the ${collection.settings.name} collection has no text field "${args.field}"` }], 'Nothing was read.');
    const at = textPart(whole, args.offset ?? 0, ENTRY_PART_CHARS);
    return { ok: true, content: { revision: host.revision(), collectionId: collection.settings.id, entryId: entry.id, field: args.field, format: schema!.type === 'richtext' ? 'markdown' : 'text', length: whole.length, offset: at.start, next: at.next, text: whole.slice(at.start, at.end) } };
  }
  const text = richTextToMarkdown(Array.isArray(entry.body) ? entry.body : [], state.pages);
  const part = textPart(text, args.offset ?? 0, ENTRY_PART_CHARS);
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
            draft: entry.draft !== false,
            ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
            ...(entry.featuredImage ? { featuredImage: entry.featuredImage } : {}),
            categories: termNames(collection, entry, 'categories'),
            ...(otherTerms(collection, entry).length ? { terms: otherTerms(collection, entry) } : {}),
            ...(entryValues(collection, entry, state.pages).length ? { values: entryValues(collection, entry, state.pages) } : {}),
            // Every custom field it can fill in, those it leaves to their default included, so a run limited to it can name them.
            ...(Object.keys(collection.settings.fields ?? {}).length ? { fields: Object.entries(collection.settings.fields ?? {}).flatMap(([name, f]) => (f && typeof f === 'object' ? [{ name, type: f.type }] : [])) } : {}),
            ...(entryRoute(collection, entry) !== undefined ? { route: entryRoute(collection, entry) } : {}),
            ...(isSyncedCollection(collection.settings) ? { readOnly: true } : {})
          }
        : {}),
      format: 'markdown',
      length: text.length,
      offset: part.start,
      next: part.next,
      text: text.slice(part.start, part.end)
    }
  };
}

/** A picture line as an entry's Markdown writes it (see richTextToMarkdown). */
const PICTURE_LINE = /^!\[[^\n]*\]\(asset:([^\s)"]+)(?:\s+"[^\n]*")?\)$/;

/**
 * The text a call sent, as the operation takes it: a picture line read from the entry becomes that picture again (a
 * picture is placed with the library picker, never typed), in the order the lines put them. A picture line the entry
 * does not have is refused, as an empty line would otherwise hide a lost picture.
 */
function bodyValue(lines: string[], current: RichText, pages: ProjectState['pages'], issues: FieldIssue[]): Array<string | RichBlock> {
  const pictures = current.filter(isImageBlock);
  // Each picture as a read wrote it: the same image placed twice, with its own caption, is told apart by its line.
  const read = pictures.map((p) => richTextToMarkdown([p], pages));
  const used = new Set<number>();
  return lines.map((raw, i) => {
    const line = raw.trim();
    const m = PICTURE_LINE.exec(line);
    if (!m) return raw;
    const exact = read.findIndex((r, j) => !used.has(j) && r === line);
    const at = exact >= 0 ? exact : pictures.findIndex((p, j) => !used.has(j) && p.assetId === m[1]);
    if (at < 0) {
      issues.push({ field: `body[${i}]`, message: `the entry has no picture "${m[1]}" to keep here. Pictures are added by the author; keep each picture line as read, or leave it out to remove that picture` });
      return raw;
    }
    used.add(at);
    return structuredClone(pictures[at]);
  });
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
function entryValue(field: string, schema: CollectionFieldSchema, v: string | number | boolean | string[] | null, issues: FieldIssue[], at: string): unknown {
  if (v === null) return null;
  const wrong = (wants: string) => (issues.push({ field: at, message: `“${field}” is a ${schema.type} field: ${wants}` }), undefined);
  switch (schema.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : wrong('send a number');
    case 'boolean':
      return typeof v === 'boolean' ? v : wrong('send true or false');
    case 'reference':
      if (schema.multiple) return Array.isArray(v) ? v : wrong('send a list of entry IDs ([] for none)');
      return typeof v === 'string' ? v : wrong('send one entry ID ("" for none)');
    case 'richtext':
      // Markdown as read: one string, which the field reads as its text is written (a hard break stays in its block),
      // or one block per line.
      return typeof v === 'string' || Array.isArray(v) ? v : wrong('send its text as Markdown');
    case 'link':
      if (typeof v !== 'string') return wrong('send an address: "https://…", a page route, "mailto:…", "tel:…" or "entry:en_…"');
      return v.trim().startsWith(ENTRY_LINK_PREFIX) ? { type: 'entry', target: v.trim().slice(ENTRY_LINK_PREFIX.length) } : v.trim();
    case 'image':
      return typeof v === 'string' ? v.trim() : wrong("send a library image's assetId");
    default:
      return typeof v === 'string' ? v : wrong(schema.type === 'enum' ? `send one of its options (${schema.options.map((o) => o.value).join(', ')})` : schema.type === 'date' ? 'send a date written YYYY-MM-DD ("" for none)' : 'send text');
  }
}

/** The custom field values a call sends, by field name, as entry.create and entry.update take them. */
function valuesOf(collection: Collection, values: NonNullable<UpsertEntryArgs['values']>, issues: FieldIssue[]): Record<string, unknown> {
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
    const v = entryValue(field, fields[field], value, issues, `${at}.value`);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

const given = <T extends object>(v: T): Partial<T> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;

/** What one entry of a collection is called where a change is labelled: "Team member" of Team, else "post" of a blog. */
const entryNoun = (collection: Collection) => (collection.settings.singularName?.trim() || (collectionKind(collection.settings) === 'structured' ? 'entry' : 'post')).toLowerCase();

export async function runUpsertEntry(args: UpsertEntryArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const revision = host.revision();
  const found = collectionFor(state, args.collectionId);
  if ('error' in found) return fieldError([found.error], 'Nothing was applied.');
  const { collection } = found;
  // A synced collection's entries are its source's: nothing is planned for them, and the author detaches it to edit them.
  if (isSyncedCollection(collection.settings)) return toolError('SCOPE_MISMATCH', `${syncedRefusal(collection.settings.name)} Nothing was applied.`, { details: { collectionId: collection.settings.id, sourceId: collection.settings.sourceId } });
  const { collectionId: _c, entryId: id, categories, terms: groupings, values, body, title, ...rest } = args;
  const issues: FieldIssue[] = [];
  let entry: EntryDoc | undefined;
  if (id !== undefined) {
    const hit = entryFor(collection, id);
    if ('error' in hit) return fieldError([hit.error], 'Nothing was applied.');
    entry = hit.entry;
  } else if (!title?.trim()) issues.push({ field: 'title', message: 'a new entry needs a title' });
  const fields: Record<string, unknown> = given(rest);
  if (title !== undefined) fields.title = title.trim();
  if (fields.publishedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(fields.publishedAt))) issues.push({ field: 'publishedAt', message: `"${String(fields.publishedAt)}" is not a date written YYYY-MM-DD` });
  // An emptied excerpt is the operation's null: the entry keeps none.
  if (fields.excerpt !== undefined && !String(fields.excerpt).trim()) fields.excerpt = null;
  const terms = termsValue(collection, categories, groupings, issues);
  if (terms) fields.terms = terms.terms;
  if (values?.length) fields.values = valuesOf(collection, values, issues);
  if (body) fields.body = bodyValue(body, Array.isArray(entry?.body) ? entry.body : [], state.pages, issues);
  if (entry && !Object.keys(fields).length) issues.push({ field: 'arguments', message: 'send at least one field to change' });
  if (issues.length) return fieldError(issues, 'Nothing was applied.');

  const ops: EditOperation[] = [
    ...(terms?.create ?? []).map((t): EditOperation => ({ type: 'collection.createTerm', collectionId: collection.settings.id, taxonomyId: t.taxonomyId, label: t.label, termId: t.termId })),
    (entry ? { type: 'entry.update', collectionId: collection.settings.id, entryId: entry.id, ...fields } : { type: 'entry.create', collectionId: collection.settings.id, title: fields.title, ...fields }) as EditOperation
  ];
  const noun = entryNoun(collection);
  const label = entry ? `Edit ${noun} “${String(fields.title ?? entry.title).slice(0, 60)}”` : `Draft ${noun} “${String(fields.title).slice(0, 60)}”`;
  const res = await host.apply(ops, revision, label, callId, { collectionWrite: { kind: 'entry', collectionId: collection.settings.id, ...(entry ? { entryId: entry.id } : {}) } });
  if (!res.ok) return applyFailure(res);
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
  'Create a collection (a Team, Projects or Events: entries kept apart from the pages), or change one: its name, what one entry is called, its kind, pages and address, and its custom fields and groupings. An update only adds and relabels: every field, option, grouping and term the collection has stays, with every entry\'s values. Then write its entries with upsert_collection_entry (custom fields as values), show them on a page with connect_collection_list, or in a section placed by upsert_page_with_sections. A collection synced from an external source (readOnly) cannot be changed.';
export const DEFINE_COLLECTION_BRIEF = 'Create a collection, or update one: an update only adds or relabels fields and groupings, keeping every one it has. Then its entries with upsert_collection_entry. Never a readOnly one.';

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
  const settings: Record<string, unknown> = given({ name: args.name?.trim(), kind: args.kind, hasBody: args.hasBody, pages: args.pages, route: args.route?.trim() });
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
      ...(now ? { name: now.name, kind: collectionKind(now), fields: Object.keys(now.fields ?? {}), taxonomies: Object.keys(now.taxonomies ?? {}), ...(hasDetailPages(now) && now.route ? { route: now.route } : {}) } : {})
    }
  };
}

/** define_collection's schema for one run. */
export function defineCollectionSchema(): JsonSchema {
  return schemaOf(DEFINE_COLLECTION_ARGS);
}
