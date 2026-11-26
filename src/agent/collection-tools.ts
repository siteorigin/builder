/**
 * Posts and other collection entries, for every model (#400): list a collection's entries a page at a time, read one
 * entry with its text as Markdown a part at a time, and write one entry (a new draft, or the fields given of one that
 * exists) with the categories it is filed under, in one call. The write compiles to `collection.createTerm` for each
 * category the collection lacks and one `entry.create` or `entry.update`, applied as one batch with a grant that lets
 * exactly that batch through (see shared/collection-grant), so it goes through the same scope check, validation and
 * undo group as any other edit. Every schema is closed and plain, so a grammar-constrained local model can call them.
 */
import { z } from 'zod';
import type { Collection, EntryDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { assignedTermIds, orderedEntries, termIdFor } from '@shared/collections';
import { isImageBlock, richTextToMarkdown, type RichBlock, type RichText } from '@shared/richtext';
import { MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS } from '@engine/values';
import { fieldError, type FieldIssue } from './macros';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';
import { applyFailure } from './result';

/** Entries listed per call: enough to find a post by its title, few enough for a small window. */
export const ENTRY_LIST_PAGE = 10;
/** How much of an entry's text one read shows, measured as the result carries it (escaped). */
export const ENTRY_PART_CHARS = 4000;
/** The most lines a call writes as an entry's text, and the longest line: what an entry's text may hold, so any post
 *  that can be read can be written back with its paragraphs whole. */
const MAX_BODY_LINES = MAX_ENTRY_BLOCKS;
const MAX_BODY_LINE = MAX_ENTRY_CHARS;

const collectionId = z.string().min(1).max(60).describe('From read_project collections.');
const entryId = z.string().min(1).max(40).describe('en_… from list_collection_entries.');
const offset = z.number().int().min(0).optional().describe('Go on from the next a previous call returned.');

export const LIST_ENTRIES_ARGS = z.object({ collectionId, offset }).strict();
export const READ_ENTRY_ARGS = z.object({ collectionId, entryId, offset }).strict();
export const UPSERT_ENTRY_ARGS = z
  .object({
    collectionId,
    entryId: z.string().min(1).max(40).optional().describe('The entry to edit; leave it out to create a new draft.'),
    title: z.string().min(1).max(200).optional().describe('Required for a new entry.'),
    publishedAt: z.string().max(10).optional().describe('YYYY-MM-DD.'),
    draft: z.boolean().optional().describe('false publishes it.'),
    excerpt: z.string().max(320).optional().describe('"" removes it.'),
    categories: z.array(z.string().min(1).max(80)).max(20).optional().describe('Category names; replaces its categories, [] removes them. A name the collection lacks is added.'),
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
  "Read one entry of a collection: its title, date, draft status, excerpt and categories, and its text as Markdown a part at a time. Call again with offset set to next until next is null before rewriting the text: body replaces it whole.";
export const READ_ENTRY_BRIEF = 'Its details, and its text as Markdown a part at a time: offset=next until next is null, before rewriting it whole.';
export const UPSERT_ENTRY_DESCRIPTION = `Create a draft entry of a collection (a blog post, say), or change one by its entryId: only the fields given change, the rest stays as it is. categories files it under categories by name, adding any the collection lacks. ${BODY_FORMAT} Send body only to change the text, after reading all of it.`;
export const UPSERT_ENTRY_BRIEF = `Only the fields given change. ${BODY_FORMAT} Send body only after reading all the text.`;

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

/** An entry's categories by name, in the order it was filed under them. */
function categoryNames(collection: Collection, entry: EntryDoc): string[] {
  const terms = collection.settings.taxonomies?.categories?.terms ?? {};
  const ids = Array.isArray(entry.terms?.categories) ? entry.terms.categories : [];
  return ids.map((id) => (Object.hasOwn(terms, id) ? terms[id].label : id));
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
        ? { title: entry.title, publishedAt: entry.publishedAt, draft: entry.draft !== false, ...(entry.excerpt ? { excerpt: entry.excerpt } : {}), categories: categoryNames(collection, entry), route: `${collection.settings.route}${entry.slug}/` }
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

/** The categories named, as term IDs: one the collection has (by name, ignoring case), else a new one's planned ID. */
function categoryIds(collection: Collection, names: string[], issues: FieldIssue[]): { ids: string[]; create: Array<{ label: string; termId: string }> } {
  // A collection without categories yet gets them with its first one, as collection.createTerm adds the grouping.
  const taxonomy = collection.settings.taxonomies?.categories;
  const known = Object.entries(taxonomy?.terms ?? {});
  // Each new ID is kept from the next, so two names that read the same as a slug get IDs of their own.
  const taken = assignedTermIds(collection, 'categories');
  const planned: Record<string, unknown> = { ...taxonomy?.terms };
  const ids: string[] = [];
  const create: Array<{ label: string; termId: string }> = [];
  const fold = (s: string) => s.trim().toLowerCase();
  for (const [i, raw] of names.entries()) {
    const label = raw.trim();
    // A blank name is never a category: [] is how every category is taken off.
    if (!label) {
      issues.push({ field: `categories[${i}]`, message: 'a category needs a name' });
      continue;
    }
    const existing = known.find(([, t]) => fold(t.label) === fold(label)) ?? create.map((c) => [c.termId, { label: c.label }] as const).find(([, t]) => fold(t.label) === fold(label));
    const id = existing ? existing[0] : termIdFor(planned, label, undefined, taken);
    if (!existing) {
      planned[id] = { label };
      create.push({ label, termId: id });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, create };
}

const given = <T extends object>(v: T): Partial<T> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;

export async function runUpsertEntry(args: UpsertEntryArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const revision = host.revision();
  const found = collectionFor(state, args.collectionId);
  if ('error' in found) return fieldError([found.error], 'Nothing was applied.');
  const { collection } = found;
  const { collectionId: _c, entryId: id, categories, body, title, ...rest } = args;
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
  const terms = categories ? categoryIds(collection, categories, issues) : null;
  if (terms) fields.terms = { categories: terms.ids };
  if (body) fields.body = bodyValue(body, Array.isArray(entry?.body) ? entry.body : [], state.pages, issues);
  if (entry && !Object.keys(fields).length) issues.push({ field: 'arguments', message: 'send at least one field to change' });
  if (issues.length) return fieldError(issues, 'Nothing was applied.');

  const ops: EditOperation[] = [
    ...(terms?.create ?? []).map((t): EditOperation => ({ type: 'collection.createTerm', collectionId: collection.settings.id, taxonomyId: 'categories', label: t.label, termId: t.termId })),
    (entry ? { type: 'entry.update', collectionId: collection.settings.id, entryId: entry.id, ...fields } : { type: 'entry.create', collectionId: collection.settings.id, title: fields.title, ...fields }) as EditOperation
  ];
  const label = entry ? `Edit post “${String(fields.title ?? entry.title).slice(0, 60)}”` : `Draft post “${String(fields.title).slice(0, 60)}”`;
  const res = await host.apply(ops, revision, label, callId, { collectionWrite: { collectionId: collection.settings.id, ...(entry ? { entryId: entry.id } : {}) } });
  if (!res.ok) return applyFailure(res);
  const written = (res.results?.at(-1) ?? {}) as { entryId?: string; slug?: string; route?: string };
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
      ...(terms?.create.length ? { addedCategories: terms.create.map((t) => t.label) } : {}),
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
  }
  return { list, read, upsert };
}
