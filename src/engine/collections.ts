/**
 * Collection and entry operations, and the checks that keep collections consistent with the rest of the project:
 * every address held once across pages, old page addresses, collections and entries; links to entries kept or
 * pointed elsewhere when an entry goes; pictures and links in entries pointing at things that exist.
 */
import type { Collection, CollectionDoc, CollectionFieldSchema, CollectionFieldValue, CollectionPages, CollectionTaxonomy, EntryDoc, EntrySeo, GraphNode, LinkValue, NodeTree, ProjectState, ReferenceFieldSchema, RichText, SiteRedirect } from '@shared/types';
import { COLLECTION_FIELD_TYPES, COLLECTION_KINDS, SCHEMA_VERSION, conditionRef, isEntryBinding } from '@shared/types';
import type { Op } from '@shared/ops';
import {
  ARCHIVE_FOLDERS,
  MAX_PAGE_SIZE,
  POSTS_COLLECTION_ID,
  archiveRouteOwner,
  collectionHasBody,
  collectionKind,
  entryRoute,
  findEntry,
  hasArchivePages,
  hasDetailPages,
  isCollectionId,
  isEntryId,
  isEntryPath,
  isSyncedCollection,
  isTermId,
  pagesPrefix,
  routeOwners,
  underArchiveFolder,
  type RouteOwner
} from '@shared/collections';
import { isArticleDate, todayArticleDate } from '@shared/articles';
import { checkCanonicalUrl, storedCanonical } from '@shared/seo';
import { addressSlug, normalizeRoute, numberedSlug, validateRoute, validateSegment } from '@shared/routes';
import { isImageBlock, isRichBlock } from '@shared/richtext';
import { newId } from '@shared/ids';
import { TEXT_LIMITS } from '@shared/text-limits';
import { EngineError, allTrees, fail } from './tree';
import { starterArchiveLayout } from './collection-sources';
import { normalizeLink, normalizeRichText, normalizeScalar } from './values';
import { bindingSlots, checkPropName, normalizePropSchema } from './schema';
import { collectionLinkUses, entryLinkUses, type LinkHolder, type PageLinkUse } from './page-links';
import { defaultLayout, isDefaultLayout } from './collection-layouts';

type OpResult = Record<string, unknown>;

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The most a project holds, so one collection can never make the project too big to open and save. */
const MAX_COLLECTIONS = 20;
export const MAX_TAXONOMIES = 10;
export const MAX_TERMS = 200;
const MAX_FIELDS = 30;
/** The most entries one reference field names, as many as an entry can be filed under in one grouping. */
export const MAX_REFERENCES = 50;
/** A collection's prefix leaves one level for its entries under the four levels an address may have. */
const MAX_PREFIX_DEPTH = 3;

export function getCollection(state: ProjectState, id: string): Collection {
  return own(state.collections, id) ?? fail(`Collection "${id.slice(0, 60)}" does not exist.`);
}

function getEntry(collection: Collection, id: string): EntryDoc {
  return own(collection.entries, id) ?? fail(`The ${collection.settings.name} collection has no entry "${id.slice(0, 60)}".`);
}

/**
 * Whether `owner` is one of the claims `except` names: a collection's own, or one entry's, its old addresses kept
 * working included (an entry can take those back; another entry's it cannot).
 */
type Except = { collectionId?: string; entryIds?: ReadonlySet<string> };
const excepted = (o: RouteOwner, except: Except) =>
  (o.kind === 'collection' && o.collectionId === except.collectionId) ||
  (o.kind === 'entry' && (o.collectionId === except.collectionId || !!except.entryIds?.has(o.entryId))) ||
  (o.kind === 'redirect' && o.entryId !== undefined && !!except.entryIds?.has(o.entryId));

/**
 * What holds each address of the site, built once for an operation that checks many (moving a collection, numbering
 * a slug), so the check is one lookup per address. Compared as case-insensitive file systems do.
 */
function routeIndex(state: ProjectState): (route: string, except?: Except) => RouteOwner | undefined {
  const byRoute = new Map<string, RouteOwner[]>();
  for (const o of routeOwners(state)) {
    const key = o.route.toLowerCase();
    byRoute.set(key, [...(byRoute.get(key) ?? []), o]);
  }
  return (route, except = {}) => byRoute.get(route.toLowerCase())?.find((o) => !excepted(o, except));
}

/** What already holds `route`, apart from the claims `except` names. */
function routeHolder(state: ProjectState, route: string, except: Except = {}): RouteOwner | undefined {
  return routeIndex(state)(route, except);
}

/** A collection's address prefix, as given: valid, not Home's, and shallow enough to leave a level for entries. */
function prefixRoute(input: string): string {
  const route = normalizeRoute(input);
  if (route === '/') fail('A collection cannot use "/": that is the Home page\'s address. Give it an address such as "/blog/".');
  const err = validateRoute(route);
  if (err) fail(err);
  if (route.slice(1, -1).split('/').length > MAX_PREFIX_DEPTH) fail(`A collection's address can be at most ${MAX_PREFIX_DEPTH} levels deep, so its entries' addresses fit in four.`);
  return route;
}

/** A slug as given: one segment of an address, spelled as addresses are (see normalizeRoute). */
function explicitSlug(input: string): string {
  const slug = normalizeRoute(input).slice(1, -1);
  if (!slug || slug.includes('/') || validateSegment(slug)) fail(`"${input.slice(0, 80)}" is not a slug: use up to 60 lowercase letters, numbers and hyphens, starting with a letter or number.`);
  return slug;
}

/**
 * The slug an entry titled `title` gets automatically: a slug of its title, numbered when its address is held by
 * anything else (a page, an old page address, a collection, another entry), kept within 60 characters.
 */
function autoSlug(state: ProjectState, collection: Collection, title: string, entryId: string): string {
  const stem = addressSlug(title) || 'entry';
  const prefix = pagesPrefix(collection);
  // An entry without a page holds no address: its slug only needs to be its own among the collection's.
  const holder = prefix === undefined ? undefined : routeIndex(state);
  const free = (slug: string) => (holder ? !holder(`${prefix}${slug}/`, { entryIds: new Set([entryId]) }) : !siblingWithSlug(collection, slug, entryId));
  let slug = stem;
  for (let i = 2; !free(slug); i++) slug = numberedSlug(stem, i);
  return slug;
}

/** Refuses an address something else holds, naming it. */
function refuseTaken(state: ProjectState, route: string, except: Except, what: string) {
  const holder = routeHolder(state, route, except);
  if (holder) fail(`${route} is already the address of ${holder.label}. Choose another ${what}.`);
}

/** Another entry of the collection with this slug (compared as addresses are, ignoring case), if any. */
const siblingWithSlug = (c: Collection, slug: string, entryId: string) => Object.values(c.entries).find((e) => e.id !== entryId && typeof e.slug === 'string' && e.slug.toLowerCase() === slug.toLowerCase());

/**
 * Refuses a slug for an entry: one whose address something else holds, or for an entry without a page (which holds
 * none), one another entry of its collection has.
 */
function refuseSlugTaken(state: ProjectState, c: Collection, slug: string, entryId: string) {
  const prefix = pagesPrefix(c);
  if (prefix !== undefined) return refuseTaken(state, `${prefix}${slug}/`, { entryIds: new Set([entryId]) }, 'slug');
  const other = siblingWithSlug(c, slug, entryId);
  if (other) fail(`“${other.title}” of ${c.settings.name} already has the slug "${slug}". Choose another slug.`);
}

/**
 * Refuses an address for collection `collectionId`'s pages where an archive's could not have theirs: one inside
 * another collection's archive folders, or, when it has an archive (`archive`), one whose own archive folders (`page/`,
 * `category/`) already hold a page, an old address or another collection's pages (see ARCHIVE_FOLDERS).
 */
function refuseArchiveClash(state: ProjectState, route: string, collectionId: string, archive = true) {
  const key = route.toLowerCase();
  for (const c of Object.values(state.collections)) {
    if (c.settings.id === collectionId || typeof c.settings.route !== 'string' || !hasArchivePages(c.settings)) continue;
    const folder = ARCHIVE_FOLDERS.find((f) => key.startsWith(`${c.settings.route!.toLowerCase()}${f}/`));
    if (folder) fail(`${route} is inside ${c.settings.route}${folder}/, which is kept for the ${c.settings.name} collection's archive pages. Choose another address for the collection.`);
  }
  const inside = archiveRouteOwner(state, route, collectionId);
  if (inside) fail(`${route} is inside ${inside.label}. Choose another address for the collection.`);
  if (!archive) return;
  const mine = (o: RouteOwner) => (o.kind === 'collection' || o.kind === 'entry') && o.collectionId === collectionId;
  // Another collection may not sit at an archive folder itself either: its entries would be in it.
  const inFolder = (o: RouteOwner) => underArchiveFolder(route, o.route) || (o.kind === 'collection' && ARCHIVE_FOLDERS.some((f) => o.route.toLowerCase() === `${key}${f}/`));
  const clash = routeOwners(state).find((o) => !mine(o) && inFolder(o));
  if (clash)
    fail(`${clash.route} is the address of ${clash.label}, and the addresses under ${route}page/ and ${route}category/ are kept for the collection's archive pages. Choose another address for the collection, or move that first.`);
  // Nor one whose entries have pages there, with or without an archive of its own, or entries yet.
  const nested = Object.values(state.collections).find((c) => c.settings.id !== collectionId && ARCHIVE_FOLDERS.some((f) => pagesPrefix(c)?.toLowerCase().startsWith(`${key}${f}/`)));
  if (nested)
    fail(`${nested.settings.route} is the address of the ${nested.settings.name} collection's pages, and the addresses under ${route}page/ and ${route}category/ are kept for the collection's archive pages. Choose another address for the collection, or move that first.`);
}

/** A page size as given: a whole number of entries from 1 to MAX_PAGE_SIZE. */
function pageSizeOf(input: number): number {
  if (!Number.isInteger(input) || input < 1 || input > MAX_PAGE_SIZE) fail(`A collection's page size must be a whole number from 1 to ${MAX_PAGE_SIZE}.`);
  return input;
}

// ---------------------------------------------------------------------------
// Old addresses
// ---------------------------------------------------------------------------

const keptAddresses = (state: ProjectState): SiteRedirect[] => (Array.isArray(state.site.redirects) ? state.site.redirects : []);

function setKeptAddresses(state: ProjectState, list: SiteRedirect[]) {
  if (list.length) state.site.redirects = list;
  else delete state.site.redirects;
}

/** An address visitors reached an entry at: the entry's ID, and whether it was an old address kept working for it. */
export interface EntryAddress {
  entryId: string;
  old: boolean;
}

/**
 * The addresses visitors reached each entry at, lowercased: every published entry's own, and the old addresses kept
 * working for an entry. Taken when a batch begins: an address an entry only passed through during the batch, or had
 * while it was a draft, is one no visitor has, so nothing is kept at it.
 */
export function entryAddressesInUse(state: ProjectState): Map<string, EntryAddress> {
  const out = new Map<string, EntryAddress>();
  for (const c of Object.values(state.collections ?? {}))
    for (const e of Object.values(c?.entries ?? {})) {
      const route = e?.draft === false && typeof e.slug === 'string' ? entryRoute(c, e) : undefined;
      if (route !== undefined) out.set(route.toLowerCase(), { entryId: e.id, old: false });
    }
  for (const r of keptAddresses(state)) if (typeof r?.from === 'string' && typeof r.entryId === 'string') out.set(r.from.toLowerCase(), { entryId: r.entryId, old: true });
  return out;
}

/** Entries answer at these addresses again (lowercased, by entry ID): an old address of each one's own kept there stops sending visitors on. */
function claimOwnAddresses(state: ProjectState, routes: ReadonlyMap<string, string>) {
  const list = keptAddresses(state);
  const rest = list.filter((r) => !(typeof r?.entryId === 'string' && typeof r.from === 'string' && routes.get(r.from.toLowerCase()) === r.entryId));
  if (rest.length !== list.length) setKeptAddresses(state, rest);
}

/**
 * Whether `from`, an address an entry has just left, is one to keep working for it: an address visitors reached that
 * entry at when the batch began, or that an entry removed in the batch handed on to it (`atStart`), whatever the
 * entry's draft flag says in between. Without a batch to go by, an address the entry had while published. Never one
 * an address cannot be, or one anything else holds now.
 */
function keepsAddress(entryId: string, from: string, published: boolean, atStart: ReadonlyMap<string, EntryAddress> | undefined, holder: ReturnType<typeof routeIndex>): boolean {
  if (from === '/' || validateRoute(from) || holder(from)) return false;
  return atStart ? atStart.get(from.toLowerCase())?.entryId === entryId : published;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** "case-studies" → "Case studies". */
const nameFromId = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');

/** The ready-made blog's name, which a header link to its index shows as "Blog". */
export const POSTS_PRESET_NAME = 'Posts';

/** The ready-made blog's settings, used for whatever a new "posts" collection is not given. */
const POSTS_PRESET = {
  name: POSTS_PRESET_NAME,
  route: '/blog/',
  taxonomies: { categories: { label: 'Categories', terms: {} }, tags: { label: 'Tags', terms: {} } }
};

/** A description as stored: trimmed, and none when it says nothing. */
const descriptionOf = (text: string | undefined) => text?.trim() || undefined;

/**
 * The groupings as given, each term keeping the description it has in `previous` when it is given without one: an
 * editor that sends the terms' names alone never erases what a category's archive says of itself.
 */
function normalizeTaxonomies(
  raw: Record<string, { label: string; terms?: Record<string, { label: string; description?: string }> }>,
  previous: Record<string, CollectionTaxonomy> = {}
): Record<string, CollectionTaxonomy> {
  const entries = Object.entries(raw);
  if (entries.length > MAX_TAXONOMIES) fail(`A collection can have at most ${MAX_TAXONOMIES} groupings.`);
  const out: Record<string, CollectionTaxonomy> = {};
  for (const [id, t] of entries) {
    if (!isTermId(id)) fail(`"${id.slice(0, 60)}" is not a grouping ID: use lowercase letters, numbers and hyphens.`);
    const terms = Object.entries(t.terms ?? {});
    if (terms.length > MAX_TERMS) fail(`${t.label} can have at most ${MAX_TERMS} terms.`);
    const seen = new Set<string>();
    out[id] = { label: t.label.trim(), terms: {} };
    for (const [termId, term] of terms) {
      if (!isTermId(termId)) fail(`${t.label}: "${termId.slice(0, 60)}" is not a term ID: use lowercase letters, numbers and hyphens.`);
      const label = term.label.trim();
      if (!label) fail(`${t.label}: every term needs a name.`);
      // Two terms readers cannot tell apart would split the same entries between them.
      if (seen.has(label.toLowerCase())) fail(`${t.label}: there are two terms called “${label}”.`);
      seen.add(label.toLowerCase());
      const kept = Object.hasOwn(previous, id) && Object.hasOwn(previous[id]?.terms ?? {}, termId) ? previous[id].terms[termId]?.description : undefined;
      const description = term.description !== undefined ? descriptionOf(term.description) : typeof kept === 'string' ? descriptionOf(kept) : undefined;
      out[id].terms[termId] = description ? { label, description } : { label };
    }
  }
  return out;
}

/** A field's or term's words as given, trimmed and cut to `max`, or undefined for none. */
const words = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * One custom field's schema as given. A date or a reference is a collection's own kind; every other kind is the
 * property kind a list item's field is. `collectionId` is the collection the field is for, which a reference may
 * name while it is being created.
 */
function normalizeField(name: string, raw: Record<string, unknown>, state: ProjectState, collectionId: string): CollectionFieldSchema {
  checkPropName(name, 'Field');
  const type = raw?.type;
  if (!(COLLECTION_FIELD_TYPES as readonly unknown[]).includes(type)) fail(`Field "${name}" needs a type of ${COLLECTION_FIELD_TYPES.join(', ')}.`);
  if (type !== 'date' && type !== 'reference') return normalizePropSchema(raw, state, name, true) as CollectionFieldSchema;
  const what = `Field "${name}"`;
  const description = words(raw.description, 300);
  const group = words(raw.group, 40);
  const base = { label: words(raw.label, 80) ?? name, ...(description ? { description } : {}), ...(group ? { group } : {}) };
  if (type === 'date') {
    const d = raw.default ?? '';
    if (d !== '' && !(typeof d === 'string' && isArticleDate(d))) fail(`${what}: its default must be a calendar date written YYYY-MM-DD, or "" for none.`);
    return { type: 'date', ...base, default: d as string };
  }
  const target = raw.collection;
  if (typeof target !== 'string' || (target !== collectionId && !Object.hasOwn(state.collections, target)))
    fail(`${what}: name the collection whose entries it refers to with "collection": ${[...new Set([collectionId, ...Object.keys(state.collections)])].map((id) => `"${id}"`).join(', ')}.`);
  const multiple = raw.multiple === true;
  const empty: string | string[] = multiple ? [] : '';
  // Which entries it names is each entry's own: a default naming one would follow every new entry, and guard it.
  if (raw.default !== undefined && JSON.stringify(raw.default) !== JSON.stringify(empty)) fail(`${what}: a reference names no entry until an entry chooses one, so its default is ${multiple ? '[]' : '""'}.`);
  return { type: 'reference', ...base, collection: target, ...(multiple ? { multiple: true } : {}), default: empty };
}

function normalizeFields(raw: Record<string, Record<string, unknown>>, state: ProjectState, collectionId: string): Record<string, CollectionFieldSchema> {
  const entries = Object.entries(raw);
  if (entries.length > MAX_FIELDS) fail(`A collection can have at most ${MAX_FIELDS} custom fields.`);
  const out: Record<string, CollectionFieldSchema> = {};
  for (const [name, schema] of entries) out[name] = normalizeField(name, schema, state, collectionId);
  return out;
}

/**
 * The entries a reference field names, as given: one entry ID of its collection ('' for none), or with `multiple` a
 * list of them, each once.
 */
function referenceValue(state: ProjectState, schema: ReferenceFieldSchema, v: unknown, label: string): string | string[] {
  const target = own(state.collections, schema.collection);
  const check = (id: unknown): string => {
    if (typeof id !== 'string' || !isEntryId(id)) fail(`${label}: ${JSON.stringify(id)?.slice(0, 60)} is not an entry ID.`);
    if (!target || !Object.hasOwn(target.entries, id as string)) fail(`${label}: the ${target?.settings.name ?? schema.collection} collection has no entry "${String(id).slice(0, 60)}".`);
    return id as string;
  };
  if (!schema.multiple) return v === '' ? '' : check(v);
  if (!Array.isArray(v)) fail(`${label}: expected a list of entry IDs.`);
  const ids = v as unknown[];
  if (ids.length > MAX_REFERENCES) fail(`${label}: name at most ${MAX_REFERENCES} entries.`);
  if (new Set(ids).size !== ids.length) fail(`${label}: an entry is named twice.`);
  return ids.map(check);
}

/**
 * A value an entry gives one of its collection's custom fields, as stored. `stored` is the value it has now, kept while
 * it is unchanged (see normalizeScalar). Its links may go to entries, as the entry's own text's may; its rich text is
 * not an article (no section headings or pictures).
 */
function fieldValue(state: ProjectState, schema: CollectionFieldSchema, v: unknown, label: string, stored?: unknown): CollectionFieldValue {
  const unchanged = stored !== undefined && JSON.stringify(v) === JSON.stringify(stored);
  switch (schema.type) {
    case 'date':
      if (v !== '' && !(typeof v === 'string' && isArticleDate(v))) fail(`${label}: ${JSON.stringify(v)?.slice(0, 40)} is not a calendar date written YYYY-MM-DD.`);
      return v as string;
    case 'reference':
      return referenceValue(state, schema, v, label);
    case 'link':
      return unchanged && v && typeof v === 'object' ? (v as LinkValue) : normalizeLink(v, state, label, { entries: true });
    case 'richtext':
      return unchanged && Array.isArray(v) && !v.some(isArticleBlock) ? (v as RichText) : normalizeRichText(v, state, label, schema.plainAs, { entries: true, article: false });
    default:
      return normalizeScalar(schema, v, state, label, stored) as CollectionFieldValue;
  }
}

/**
 * Settles every entry on new groupings and fields. A grouping, term or field that is gone takes its assignments and
 * values with it; a field that stays keeps each entry's value, which must still be one the field takes: an option
 * removed from a choice, say, is refused while an entry has chosen it, so no entry's choice changes on its own.
 */
function settleEntries(state: ProjectState, collection: Collection, taxonomies: Record<string, CollectionTaxonomy>, fields: Record<string, CollectionFieldSchema>) {
  for (const entry of Object.values(collection.entries)) {
    const terms: Record<string, string[]> = {};
    for (const [tax, ids] of Object.entries(entry.terms ?? {})) {
      if (!Object.hasOwn(taxonomies, tax)) continue;
      const kept = ids.filter((t) => Object.hasOwn(taxonomies[tax].terms, t));
      if (kept.length) terms[tax] = kept;
    }
    entry.terms = terms;
    const values: Record<string, CollectionFieldValue> = {};
    for (const [name, v] of Object.entries(entry.values ?? {})) {
      if (!Object.hasOwn(fields, name)) continue;
      // Kept exactly as stored: a value the new field would read differently (a number as text, lines run together)
      // is refused like one it does not take at all.
      // A value kept while unchanged is only kept by a field of the same kind: under another, it is read again.
      const before = own(collection.settings.fields ?? {}, name);
      let kept: unknown;
      try {
        kept = fieldValue(state, fields[name], v, name, before?.type === fields[name].type ? v : undefined);
      } catch {
        kept = undefined;
      }
      if (kept === undefined || JSON.stringify(kept) !== JSON.stringify(v))
        fail(`“${entry.title}” has a value for ${fields[name].label} that the changed field would not keep as it is. Change that entry first, or remove the field and add it again.`);
      values[name] = v;
    }
    entry.values = values;
  }
}

/** The pages a collection asks for, as given: an archive lists its entries' pages, so it needs them. */
function pagesOf(input: CollectionPages): CollectionPages {
  if (input.archive && !input.detail) fail("A collection's archive lists links to its entries' pages, so it needs them: turn on entry pages (detail) too, or turn off the archive.");
  return { detail: input.detail, archive: input.archive };
}

/** The settings that say what a collection is, as given: its kind, what one entry is called, and what its index says of itself. */
function applyIdentity(settings: CollectionDoc, op: Pick<Op<'collection.update'>, 'kind' | 'singularName' | 'description'>) {
  if (op.description !== undefined) {
    const description = descriptionOf(op.description);
    if (description) settings.description = description;
    else delete settings.description;
  }
  if (op.kind !== undefined) {
    if (!COLLECTION_KINDS.includes(op.kind)) fail(`A collection's kind is ${COLLECTION_KINDS.join(' or ')}.`);
    settings.kind = op.kind;
  }
  if (op.singularName !== undefined) {
    const name = op.singularName?.trim();
    if (name) settings.singularName = name;
    else delete settings.singularName;
  }
}

export function collectionCreate(state: ProjectState, op: Op<'collection.create'>): OpResult {
  if (!isCollectionId(op.collectionId)) fail(`"${op.collectionId.slice(0, 60)}" is not a collection ID: use lowercase letters, numbers and single hyphens, such as "posts" or "case-studies".`);
  if (Object.hasOwn(state.collections, op.collectionId)) fail(`The collection "${op.collectionId}" already exists.`);
  if (Object.keys(state.collections).length >= MAX_COLLECTIONS) fail(`A project can have at most ${MAX_COLLECTIONS} collections.`);
  const preset = op.collectionId === POSTS_COLLECTION_ID ? POSTS_PRESET : undefined;
  const pages = op.pages !== undefined ? pagesOf(op.pages) : undefined;
  // A data-only collection needs no address; one it is given is kept for when it has pages, and claims nothing.
  const routed = pages?.detail !== false;
  const given = op.route ?? (routed ? (preset?.route ?? `/${op.collectionId}/`) : undefined);
  const route = given !== undefined ? prefixRoute(given) : undefined;
  if (route !== undefined && routed) {
    if (pages?.archive !== false) refuseTaken(state, route, {}, 'address for the collection');
    refuseArchiveClash(state, route, op.collectionId, pages?.archive !== false);
  }
  const settings: CollectionDoc = {
    schemaVersion: SCHEMA_VERSION,
    id: op.collectionId,
    name: (op.name ?? preset?.name ?? nameFromId(op.collectionId)).trim(),
    ...(route !== undefined ? { route } : {}),
    taxonomies: normalizeTaxonomies(op.taxonomies ?? preset?.taxonomies ?? {}),
    fields: normalizeFields(op.fields ?? {}, state, op.collectionId),
    template: { rootIds: [], nodes: {} }
  };
  applyIdentity(settings, op);
  if (op.hasBody !== undefined) settings.hasBody = op.hasBody;
  // Articles start with the theme's article layout, records with a page of their own fields (see collection-layouts).
  settings.template = defaultLayout(state, settings);
  if (pages) settings.pages = pages;
  if (op.pageSize !== undefined) settings.pageSize = pageSizeOf(op.pageSize);
  if (op.categoryArchives !== undefined) settings.categoryArchives = op.categoryArchives;
  if (typeof op.rss === 'boolean') settings.rss = op.rss;
  state.collections[op.collectionId] = { settings, entries: {} };
  if (op.archiveTemplate) setArchiveLayout(state, state.collections[op.collectionId], op.archiveTemplate);
  return { collectionId: op.collectionId, ...(route !== undefined ? { route } : {}) };
}

export function collectionUpdate(state: ProjectState, op: Op<'collection.update'>, atStart?: ReadonlyMap<string, EntryAddress>): OpResult {
  const c = getCollection(state, op.collectionId);
  if (op.name !== undefined) c.settings.name = op.name.trim() || c.settings.name;
  // A records layout nobody has edited keeps up with the collection: its fields, its text and its kind (see the end).
  // An article's stays the theme's as it is, and an edited layout is the author's.
  const follows = (collectionKind(c.settings) === 'structured' || op.kind === 'structured') && isDefaultLayout(state, c.settings);
  applyIdentity(c.settings, op);
  // Detached, its entries are local: edited here, and left alone by syncs. Nothing says they came from the source any
  // more, so no later sync of it can claim them.
  if (op.sourceId === null) {
    delete c.settings.sourceId;
    for (const e of Object.values(c.entries)) delete e.source;
  }
  const name = c.settings.name;
  const was = { route: c.settings.route, detail: hasDetailPages(c.settings), archive: hasArchivePages(c.settings) };
  const pages = op.pages !== undefined ? pagesOf(op.pages) : { detail: was.detail, archive: was.archive };
  const route = op.route !== undefined && op.route !== c.settings.route ? prefixRoute(op.route) : was.route;
  // Its index can't go while anything links to it: text edited on the page keeps a link only by its address, so one
  // shown as words alone meanwhile would be lost, and a post's text holding one could no longer be saved.
  if (was.archive && !pages.archive) {
    const held = collectionLinkUses(state, c.settings.id);
    if (held.length)
      fail(`${held.length} link${held.length === 1 ? '' : 's'} go${held.length === 1 ? 'es' : ''} to the ${name} index (in ${[...new Set(held.map((u) => u.where))].slice(0, 3).join(', ')}). Point ${held.length === 1 ? 'it' : 'them'} elsewhere before turning the index off.`);
  }
  if (pages.detail && route === undefined) fail(`The ${name} collection needs an address for its pages, such as "/${c.settings.id}/".`);
  // The collection's pages take every address they did not have: moved, or turned on.
  const moved = route !== was.route;
  if (pages.detail && (moved || !was.detail || (pages.archive && !was.archive))) {
    const prefix = route!;
    // The collection and every entry move together: each new address must be free of everything else, apart from
    // an old address of the entry's own, which it takes back.
    const except = { collectionId: c.settings.id };
    const held = routeIndex(state);
    if (pages.archive) {
      const taken = held(prefix, except);
      if (taken) fail(`${prefix} is already the address of ${taken.label}. Choose another address for the collection.`);
      // Nor one of its own entries' addresses, which the collection would take from under it.
      const under = was.detail ? Object.values(c.entries).find((e) => `${was.route}${e.slug}/`.toLowerCase() === prefix.toLowerCase()) : undefined;
      if (under) fail(`${prefix} is the address of the entry “${under.title}”. Choose another address for the collection.`);
    }
    refuseArchiveClash(state, prefix, c.settings.id, pages.archive);
    for (const e of Object.values(c.entries)) {
      const holder = held(`${prefix}${e.slug}/`, { ...except, entryIds: new Set([e.id]) });
      if (holder)
        fail(`${moved ? `Moving the collection to ${prefix}` : 'Giving its entries pages'} would give “${e.title}” the address ${prefix}${e.slug}/, which is ${holder.label}'s. Change that entry's slug first, or choose another address.`);
    }
    // Addresses its entries had, which visitors may have reached them at: where they were, or for entries whose pages
    // this batch turned off before, where they were as it began.
    const startOf = new Map<string, string>();
    if (!was.detail) for (const [route, a] of atStart ?? []) if (!a.old) startOf.set(a.entryId, route);
    const left = Object.values(c.entries).flatMap((e) => {
      const from = was.detail ? (moved ? `${was.route}${e.slug}/` : undefined) : startOf.get(e.id);
      return from !== undefined && from.toLowerCase() !== `${prefix}${e.slug}/`.toLowerCase() ? [{ e, from }] : [];
    });
    c.settings.route = prefix;
    c.settings.pages = pages;
    claimOwnAddresses(state, new Map(Object.values(c.entries).map((e) => [`${prefix}${e.slug}/`.toLowerCase(), e.id])));
    // Each published entry's address keeps working, sending visitors on to the entry's new one.
    const holder = routeIndex(state);
    // Never one another collection's archive pages have by now (one turned on in the same batch).
    const kept = left
      .filter(({ e, from }) => keepsAddress(e.id, from, e.draft === false, atStart, holder) && !archiveRouteOwner(state, from, c.settings.id))
      .map(({ e, from }): SiteRedirect => ({ from, entryId: e.id }));
    // An address kept working is never in the archive folders the move gives the collection: it would stop its index there.
    const stranded = pages.archive ? kept.find((k) => underArchiveFolder(prefix, k.from)) : undefined;
    if (stranded) {
      const folder = ARCHIVE_FOLDERS.find((f) => stranded.from.toLowerCase().startsWith(`${prefix.toLowerCase()}${f}/`));
      fail(`Moving the collection to ${prefix} would keep “${c.entries[stranded.entryId!].title}”'s address ${stranded.from} working inside ${prefix}${folder}/, which is kept for the collection's archive pages. Choose another address for the collection.`);
    }
    if (kept.length) setKeptAddresses(state, [...keptAddresses(state), ...kept]);
  } else {
    // Pages turned off, or an address kept for when they are on again: nothing new is claimed. Links to its entries
    // show their words alone meanwhile, as links to drafts do.
    if (route !== undefined) c.settings.route = route;
    if (op.pages !== undefined) c.settings.pages = pages;
  }
  if (op.archiveTemplate !== undefined) {
    // The archive pages' own layout, a fresh one to design, or back to the ready-made cards.
    if (op.archiveTemplate === null) delete c.settings.archiveTemplate;
    else setArchiveLayout(state, c, op.archiveTemplate);
  }
  if (op.pageSize !== undefined) c.settings.pageSize = pageSizeOf(op.pageSize);
  if (op.categoryArchives !== undefined) c.settings.categoryArchives = op.categoryArchives;
  // In or out of the site's RSS feed, or back to what its kind says.
  if (op.rss === null) delete c.settings.rss;
  else if (op.rss !== undefined) c.settings.rss = op.rss;
  if (op.hasBody !== undefined) {
    if (!op.hasBody && collectionHasBody(c.settings)) {
      // Nothing is dropped on its own: each entry's text, and the layout's showing it, are cleared first.
      const written = Object.values(c.entries).find((e) => Array.isArray(e.body) && e.body.length);
      if (written) fail(`“${written.title}” has text of its own. Clear the text of every entry of ${name} before turning entry text off.`);
      const shown = [...(follows ? [] : layoutReads(c))].find((f) => f === 'body' || f === 'readingTime');
      if (shown) fail(`The ${name} layout shows the entries' ${shown === 'body' ? 'text' : 'reading time'}. Unbind it in the layout before turning entry text off.`);
    }
    c.settings.hasBody = op.hasBody;
  }
  if (op.taxonomies !== undefined || op.fields !== undefined) {
    const taxonomies = op.taxonomies !== undefined ? normalizeTaxonomies(op.taxonomies, c.settings.taxonomies) : c.settings.taxonomies;
    const fields = op.fields !== undefined ? normalizeFields(op.fields, state, c.settings.id) : c.settings.fields;
    // A custom field the layout shows can't go, or become another kind, while it does: every entry's value would be
    // dropped below, even if a later change in the same batch brought the field back. A layout that follows the
    // collection drops it along with the field.
    for (const f of follows ? [] : layoutReads(c)) {
      if (!f.startsWith('field.')) continue;
      const before = own(c.settings.fields ?? {}, f.slice(6));
      const after = own(fields, f.slice(6));
      if (before && (!after || after.type !== before.type))
        fail(`The ${name} layout shows ${before.label}. Unbind it in the layout before ${after ? 'changing its kind' : 'removing it'}.`);
    }
    settleEntries(state, c, taxonomies, fields);
    c.settings.taxonomies = taxonomies;
    c.settings.fields = fields;
  }
  if (follows && !isDefaultLayout(state, c.settings)) c.settings.template = defaultLayout(state, c.settings);
  if (op.categoryDescription !== undefined) {
    const { termId } = op.categoryDescription;
    const terms = c.settings.taxonomies?.categories?.terms;
    if (!terms || !Object.hasOwn(terms, termId)) fail(`${name} has no category "${termId.slice(0, 60)}".`);
    const description = descriptionOf(op.categoryDescription.description);
    terms[termId] = description ? { ...terms[termId], description } : { label: terms[termId].label };
  }
  return { collectionId: c.settings.id, ...(c.settings.route !== undefined ? { route: c.settings.route } : {}) };
}

/** The entry fields a collection's layout shows or tests, by the name a binding gives them. */
function layoutReads(c: Collection): Set<string> {
  const out = new Set<string>();
  const nodes = c.settings.template?.nodes;
  for (const n of Object.values(nodes && typeof nodes === 'object' ? nodes : {})) {
    if (!n || typeof n !== 'object') continue;
    for (const slot of bindingSlots(n)) {
      const b = conditionRef(slot.value) ?? slot.value;
      if (isEntryBinding(b) && typeof b.$entry === 'string') out.add(b.$entry);
    }
  }
  return out;
}

export function collectionRemove(state: ProjectState, op: Op<'collection.remove'>, atStart?: Map<string, EntryAddress>): OpResult {
  const c = getCollection(state, op.collectionId);
  // Its entries are the source's: it is detached first, so a collection made again under its ID is never mistaken for it.
  if (isSyncedCollection(c.settings))
    throw new EngineError('VALIDATION_FAILED', `The ${c.settings.name} collection is synced from an external source, so its entries are read-only here. Detach it from the source before removing it.`);
  // Another collection's reference field names its entries, even while no entry has chosen one yet.
  for (const other of Object.values(state.collections)) {
    if (other.settings.id === c.settings.id) continue;
    const field = Object.values(other.settings.fields ?? {}).find((f) => f?.type === 'reference' && f.collection === c.settings.id);
    if (field) throw new EngineError('VALIDATION_FAILED', `${field.label} of the ${other.settings.name} collection refers to entries of ${c.settings.name}. Remove that field first.`);
  }
  const members = new Set(Object.keys(c.entries));
  // Links its own entries, layouts and fields' defaults hold go with them; any other link to one of its entries, or to
  // its list, would be left going nowhere.
  const mine = (u: PageLinkUse) => ((u.owner.kind === 'template' || u.owner.kind === 'archive') && u.owner.id === c.settings.id) || (u.owner.kind === 'entry' && 'collectionId' in u.owner && u.owner.collectionId === c.settings.id);
  const toIndex = collectionLinkUses(state, c.settings.id).filter((u) => !mine(u));
  const outside = [...entryLinkUses(state, members).filter((u) => !mine(u)), ...toIndex];
  if (outside.length) {
    const n = outside.length;
    throw new EngineError('VALIDATION_FAILED', `${n} link${n === 1 ? '' : 's'} outside the ${c.settings.name} collection point to ${toIndex.length ? 'its list or its entries' : 'its entries'} (in ${[...new Set(outside.map((u) => u.where))].slice(0, 3).join(', ')}). Point them elsewhere first.`, { references: n });
  }
  delete state.collections[c.settings.id];
  // Their old addresses go with them: nothing is left there to send visitors on to.
  const kept = keptAddresses(state);
  const rest = kept.filter((r) => !(typeof r?.entryId === 'string' && members.has(r.entryId)));
  if (rest.length !== kept.length) setKeptAddresses(state, rest);
  // Nothing else of the batch reaches them through these IDs, even created again.
  if (atStart) for (const [key, a] of [...atStart]) if (members.has(a.entryId)) atStart.delete(key);
  return { collectionId: c.settings.id, removedEntries: members.size };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * Refuses a manual change to the entries of a synced collection: the source is where they change, and the next sync
 * would put back what it says. Detaching the collection makes them local entries again.
 */
function refuseSynced(c: Collection, what: string, sync?: { collectionId: string }) {
  // Only the sync of its own source may write them (see SourceSyncGrant).
  if (sync?.collectionId === c.settings.id) return;
  if (isSyncedCollection(c.settings))
    throw new EngineError('VALIDATION_FAILED', `The ${c.settings.name} collection is synced from an external source, so its entries are read-only here and cannot be ${what}. Change them in the source, or detach the collection from it to edit them here.`);
}

/**
 * Refuses a change that would point links held by entries of a synced collection somewhere else (removing what they go
 * to): the next sync would bring back what the source says, going nowhere. `holders` are the stored links' places.
 */
export function refuseSyncedHolders(state: ProjectState, holders: ReadonlyArray<{ owner: LinkHolder; where: string }>, what: string) {
  const synced = holders.find((u) => u.owner.kind === 'entry' && isSyncedCollection(own(state.collections, u.owner.collectionId)?.settings));
  if (synced)
    throw new EngineError('VALIDATION_FAILED', `${synced.where} links to ${what}, and its collection is synced from an external source, so its entries are read-only here. Change that link in the source, or detach the collection first.`);
}

/** Whether two stored values say the same, whatever order their keys are in. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValue(x, (b as unknown[])[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Why going from `before` to `after` changes what a synced collection's entries say, or null: a collection synced
 * afterwards whose entries differ from what they were (a field or grouping taken from them, a term renamed on them, a
 * picture replaced in them; an undo of an edit made before a sync, or one that attaches it again as it takes an edit
 * back). The source is where they change, and its next sync would put back what it says. Its settings (its layout,
 * its order) stay the author's; a collection detached by the change, or made by it, is local. Removing a synced
 * collection is refused on its own (see collectionRemove). `except` leaves out a collection, or several: the one a sync
 * writes, or those only restores of saved versions change (#1474). Worded to follow "This" or "it".
 */
/** Whether `after` is `before` with each entry given where it came from (`source`, from `sourceId`) and nothing else. */
function sameEntriesBut(before: Record<string, EntryDoc>, after: Record<string, EntryDoc>, sourceId: string): boolean {
  const ids = Object.keys(after);
  if (ids.length !== Object.keys(before).length) return false;
  return ids.every((id) => {
    const [b, a] = [own(before, id), after[id]];
    if (!b || b.source !== undefined || a.source?.sourceId !== sourceId) return false;
    const { source: _given, ...rest } = a;
    return sameValue(b, rest);
  });
}

export function syncedEntryChange(before: ProjectState, after: ProjectState, except?: string | ReadonlySet<string>): string | null {
  const excepted = (id: string) => (typeof except === 'string' ? id === except : !!except?.has(id));
  for (const c of Object.values(after.collections ?? {})) {
    if (!isSyncedCollection(c?.settings) || excepted(c.settings.id)) continue;
    const was = own(before.collections ?? {}, c.settings.id);
    if (!was || sameValue(was.entries, c.entries)) continue;
    // Attached again as it was detached (an undo of Detach): the very same entries, each given back only where it came
    // from, by the source it is attached to.
    if (!isSyncedCollection(was.settings) && sameEntriesBut(was.entries, c.entries, c.settings.sourceId!)) continue;
    return `would change the entries of the ${c.settings.name} collection, which is synced from an external source, so they are read-only here. Change them in the source, or detach the collection from it first.`;
  }
  return null;
}

/**
 * Why `state` leaves a synced collection among `ids` holding an entry its source never wrote, or two from one record,
 * or null: an undo of a restore that takes the collection back to another source than the one that synced an entry
 * since, or leaves beside an entry one synced since from the same record under another ID (#1474). Its next sync
 * would refuse the collection. Worded to follow "it".
 */
export function foreignSyncedEntry(state: ProjectState, ids: Iterable<string>): string | null {
  for (const id of ids) {
    const c = own(state.collections ?? {}, id);
    if (!c || !isSyncedCollection(c.settings)) continue;
    // As its next sync reads them (syncedIndex): each written by its source, and no two from one record.
    const records = new Set<string>();
    for (const e of Object.values(c.entries)) {
      const src = e.source;
      if (src?.sourceId !== c.settings.sourceId || typeof src?.externalId !== 'string')
        return `would leave “${e.title}” in the ${c.settings.name} collection, which would be synced from a source that did not write it. Restore a saved version instead.`;
      if (records.has(src.externalId)) return `would leave two entries of the ${c.settings.name} collection from the same record of its source. Restore a saved version instead.`;
      records.add(src.externalId);
    }
  }
  return null;
}

/** A stored reference to an entry: the entry naming it and its field. */
export interface EntryReferenceUse {
  collection: Collection;
  entry: EntryDoc;
  field: string;
  schema: ReferenceFieldSchema;
}

/**
 * Every reference field value naming any of the entries `entryIds`, held by any other entry: one row per entry and
 * field. References those entries hold themselves go with them, so they are not listed.
 */
export function entryReferenceUses(state: ProjectState, entryIds: string | ReadonlySet<string>): EntryReferenceUse[] {
  const ids = typeof entryIds === 'string' ? new Set([entryIds]) : entryIds;
  const out: EntryReferenceUse[] = [];
  for (const c of Object.values(state.collections ?? {})) {
    const refs = Object.entries(c.settings?.fields ?? {}).filter((e): e is [string, ReferenceFieldSchema] => e[1]?.type === 'reference');
    if (!refs.length) continue;
    for (const entry of Object.values(c.entries)) {
      if (ids.has(entry.id)) continue;
      for (const [field, schema] of refs) {
        const v: unknown = own(entry.values ?? {}, field);
        if ((Array.isArray(v) ? v : [v]).some((id) => typeof id === 'string' && ids.has(id))) out.push({ collection: c, entry, field, schema });
      }
    }
  }
  return out;
}

type EntryFields = Partial<
  Pick<Op<'entry.update'>, 'title' | 'slug' | 'publishedAt' | 'updatedAt' | 'draft' | 'author' | 'excerpt' | 'featuredImage' | 'featuredImageAlt' | 'terms' | 'values' | 'body' | 'seoTitle' | 'description' | 'socialImage' | 'canonical' | 'noindex' | 'searchHidden'>
>;

function date(v: string, what: string): string {
  if (!isArticleDate(v)) fail(`${what} "${v}" is not a calendar date written YYYY-MM-DD.`);
  return v;
}

/**
 * Applies the details an operation gives to an entry; anything it leaves out stays as it is. An entry given a new slug
 * keeps its old address working when visitors reached it there as the batch began (see keepsAddress), since a
 * draft's address is one no visitor has.
 */
function applyEntryFields(state: ProjectState, c: Collection, entry: EntryDoc, op: EntryFields, atStart?: ReadonlyMap<string, EntryAddress>) {
  const label = `“${op.title ?? entry.title}”`;
  const wasPublished = entry.draft === false;
  if (op.title !== undefined) entry.title = op.title.trim() || fail('An entry needs a title.');
  if (op.publishedAt !== undefined) entry.publishedAt = date(op.publishedAt, 'The publication date');
  if (op.updatedAt === null) delete entry.updatedAt;
  else if (op.updatedAt !== undefined) entry.updatedAt = date(op.updatedAt, 'The revision date');
  if (op.draft !== undefined) entry.draft = op.draft;
  for (const k of ['author', 'excerpt'] as const) {
    const v = op[k];
    if (v === undefined) continue;
    const t = v?.trim();
    if (t) entry[k] = t;
    else delete entry[k];
  }
  // A featured image's description is of that one picture: it goes with it, and another picture given without one
  // starts with none of its own, showing the library's suggestion for it.
  const describe = op.featuredImageAlt === undefined ? undefined : (op.featuredImageAlt ?? '').replace(/\s+/g, ' ').trim();
  if (op.featuredImage === null || op.featuredImage === '') {
    if (describe) fail(`${label}: a featured image description needs a featured image to describe.`);
    delete entry.featuredImage;
    delete entry.featuredImageAlt;
  } else if (op.featuredImage !== undefined) {
    const a = own(state.assets.assets, op.featuredImage);
    if (!a) fail(`${label}: the featured image "${op.featuredImage.slice(0, 60)}" is not in the library.`);
    if (a!.kind !== 'image') fail(`${label}: “${a!.name}” is a ${a!.kind}, not a picture. Choose an image for the featured image.`);
    if (op.featuredImage !== entry.featuredImage) delete entry.featuredImageAlt;
    entry.featuredImage = op.featuredImage;
  }
  if (describe) {
    if (!entry.featuredImage) fail(`${label} has no featured image to describe. Choose one first.`);
    entry.featuredImageAlt = describe;
  } else if (describe === '') delete entry.featuredImageAlt;
  if (op.terms !== undefined) {
    const terms = { ...entry.terms };
    for (const [tax, ids] of Object.entries(op.terms)) {
      const t = own(c.settings.taxonomies, tax) ?? fail(`The ${c.settings.name} collection has no grouping "${tax.slice(0, 60)}".`);
      if (new Set(ids).size !== ids.length) fail(`${label}: a term is given twice for ${t.label}.`);
      for (const id of ids) if (!Object.hasOwn(t.terms, id)) fail(`${t.label} has no term "${id.slice(0, 60)}".`);
      if (ids.length) terms[tax] = [...ids];
      else delete terms[tax];
    }
    entry.terms = terms;
  }
  // The new address first, so the text and the fields can link to it.
  if (op.slug !== undefined) {
    const slug = explicitSlug(op.slug);
    if (slug !== entry.slug) {
      const from = entryRoute(c, entry);
      refuseSlugTaken(state, c, slug, entry.id);
      entry.slug = slug;
      // An entry without a page holds no address, so there is none to take back or keep working.
      const to = entryRoute(c, entry);
      if (from !== undefined && to !== undefined) {
        claimOwnAddresses(state, new Map([[to.toLowerCase(), entry.id]]));
        if (keepsAddress(entry.id, from, wasPublished, atStart, routeIndex(state))) setKeptAddresses(state, [...keptAddresses(state), { from, entryId: entry.id }]);
      }
    }
  }
  if (op.values !== undefined) {
    const values = { ...entry.values };
    for (const [name, v] of Object.entries(op.values)) {
      const schema = own(c.settings.fields, name) ?? fail(`The ${c.settings.name} collection has no field "${name.slice(0, 60)}".`);
      // Left out, a field shows its default.
      if (v === null) delete values[name];
      else values[name] = fieldValue(state, schema, v, `${label} → ${schema.label}`, Object.hasOwn(entry.values, name) ? entry.values[name] : undefined);
    }
    entry.values = values;
  }
  if (op.body !== undefined) {
    const body = normalizeRichText(op.body ?? [], state, `${label} text`, undefined, { entries: true });
    if (body.length && !collectionHasBody(c.settings)) fail(`${label}: entries of ${c.settings.name} have no text of their own. Use a rich text field for words they show.`);
    entry.body = body;
  }
  applyEntrySeo(state, entry, op, label);
}

/**
 * Applies an operation's search and sharing settings to an entry, each one left out staying as it is. Text cleared,
 * an image of null and a switch turned off each remove the setting, so the entry falls back as it did; an entry left
 * with none keeps no settings object at all, as entries stored before they existed have none.
 */
function applyEntrySeo(state: ProjectState, entry: EntryDoc, op: EntryFields, label: string) {
  if (op.seoTitle === undefined && op.description === undefined && op.socialImage === undefined && op.canonical === undefined && op.noindex === undefined && op.searchHidden === undefined) return;
  const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? { ...entry.seo } : {};
  const text = (k: 'title' | 'description', v: string | undefined) => {
    if (v === undefined) return;
    if (v.trim()) seo[k] = v.trim();
    else delete seo[k];
  };
  text('title', op.seoTitle);
  text('description', op.description);
  if (op.socialImage === null || op.socialImage === '') delete seo.socialImage;
  else if (op.socialImage !== undefined) {
    const a = own(state.assets.assets, op.socialImage);
    if (!a) fail(`${label}: the sharing image "${op.socialImage.slice(0, 60)}" is not in the library.`);
    if (a!.kind !== 'image') fail(`${label}: “${a!.name}” is a ${a!.kind}, not a picture. Choose an image to share it with.`);
    seo.socialImage = op.socialImage;
  }
  if (op.canonical !== undefined) {
    const canonical = checkCanonicalUrl(op.canonical);
    if (!canonical.ok) fail(`${label}: ${canonical.message}`);
    else if (canonical.url) seo.canonical = canonical.url;
    else delete seo.canonical;
  }
  for (const k of ['noindex', 'searchHidden'] as const) {
    if (op[k] === true) seo[k] = true;
    else if (op[k] === false) delete seo[k];
  }
  if (Object.keys(seo).length) entry.seo = seo;
  else delete entry.seo;
}

/**
 * Keeps `from`, an address the entry had on an earlier site (an imported post's old permalink), working for it: an
 * address the site can have, other than Home and the entry's own, that nothing else holds or keeps for its archives.
 * A draft keeps it too: the website sends visitors there once the entry is published (see publishedState).
 */
function keepOldAddress(state: ProjectState, c: Collection, entry: EntryDoc, from: string) {
  const label = `“${entry.title}”`;
  const route = entryRoute(c, entry);
  // Nor is an entry without a page of its own.
  if (route === undefined) fail(`${label}: entries of ${c.settings.name} have no pages, so no old address can send visitors to one.`);
  const err = from === '/' ? 'the Home page keeps its own address.' : validateRoute(from);
  if (err) fail(`${label}: ${from.slice(0, 80)} cannot be kept as its old address: ${err}`);
  if (from.toLowerCase() === route!.toLowerCase()) fail(`${label}: ${from} is its own address, not an old one.`);
  refuseTaken(state, from, {}, 'old address');
  const archive = archiveRouteOwner(state, from);
  if (archive) fail(`${from} is kept for ${archive.label}. Choose another old address.`);
  setKeptAddresses(state, [...keptAddresses(state), { from, entryId: entry.id }]);
}

/** An operation's result for an entry: its collection, ID and slug, and its address when it has a page. */
function entryResult(c: Collection, entry: EntryDoc): OpResult {
  const route = entryRoute(c, entry);
  return { collectionId: c.settings.id, entryId: entry.id, slug: entry.slug, ...(route !== undefined ? { route } : {}) };
}

export function entryCreate(state: ProjectState, op: Op<'entry.create'>, sync?: { collectionId: string }): OpResult {
  const c = getCollection(state, op.collectionId);
  refuseSynced(c, 'added to', sync);
  const id = op.entryId ?? newId('en');
  if (findEntry(state, id)) fail(`An entry with the ID "${id}" already exists.`);
  const title = op.title.trim() || fail('An entry needs a title.');
  const entry: EntryDoc = { schemaVersion: SCHEMA_VERSION, id, slug: '', title, publishedAt: todayArticleDate(), draft: true, terms: {}, values: {}, body: [] };
  // Added, with its address, before anything else, so its own text can link to it.
  c.entries[id] = entry;
  if (op.slug !== undefined) {
    entry.slug = explicitSlug(op.slug);
    refuseSlugTaken(state, c, entry.slug, id);
  } else entry.slug = autoSlug(state, c, title, id);
  // An old address kept for this ID (a document edited by hand) is the entry's own again.
  const route = entryRoute(c, entry);
  if (route !== undefined) claimOwnAddresses(state, new Map([[route.toLowerCase(), id]]));
  applyEntryFields(state, c, entry, { ...op, slug: undefined });
  if (op.redirectFrom !== undefined) keepOldAddress(state, c, entry, op.redirectFrom);
  if (Array.isArray(c.settings.entryOrder)) c.settings.entryOrder.push(id);
  return entryResult(c, entry);
}

export function entryUpdate(state: ProjectState, op: Op<'entry.update'>, atStart?: ReadonlyMap<string, EntryAddress>, sync?: { collectionId: string }): OpResult {
  const c = getCollection(state, op.collectionId);
  const entry = getEntry(c, op.entryId);
  refuseSynced(c, 'changed', sync);
  applyEntryFields(state, c, entry, op, atStart);
  return entryResult(c, entry);
}

export function entryReorder(state: ProjectState, op: Op<'entry.reorder'>): OpResult {
  const c = getCollection(state, op.collectionId);
  if (op.entryIds === null) {
    delete c.settings.entryOrder;
    return { collectionId: c.settings.id };
  }
  const ids = op.entryIds;
  if (ids.length !== Object.keys(c.entries).length || new Set(ids).size !== ids.length || !ids.every((id) => Object.hasOwn(c.entries, id)))
    fail(`entry.reorder must list every entry of the ${c.settings.name} collection exactly once.`);
  c.settings.entryOrder = [...ids];
  return { collectionId: c.settings.id };
}

/**
 * Whether an entry can take over from a removed one of `from`: one with a page of its own, which links and old addresses
 * can send visitors to. Where reference fields name the removed entry, only another of its collection can take them, so
 * while that collection's pages are off one without a page may.
 */
export function canReplaceEntry(from: Collection, to: { collection: Collection; entry: EntryDoc }, referenced: boolean): boolean {
  return isEntryPath(to.collection, to.entry) || (referenced && to.collection === from && !hasDetailPages(from.settings));
}

export function entryRemove(state: ProjectState, op: Op<'entry.remove'>, atStart?: Map<string, EntryAddress>, sync?: { collectionId: string }): OpResult {
  const c = getCollection(state, op.collectionId);
  const entry = getEntry(c, op.entryId);
  refuseSynced(c, 'removed', sync);
  // An old address the author keeps for it is theirs: a sync never takes it away with the entry.
  const custom = sync ? keptAddresses(state).find((r) => r?.entryId === entry.id && r.custom) : undefined;
  if (custom) fail(`The old address ${custom.from} goes to “${entry.title}”, which its source no longer has. Point that address elsewhere in Site settings, under Redirects, before syncing.`);
  if (op.replacementEntryId !== undefined && op.replacementPageId !== undefined) fail('Choose a replacement entry or a replacement page, not both.');
  if (op.replacementEntryId === entry.id) fail('The replacement must be a different entry.');
  const replacement = op.replacementEntryId !== undefined ? findEntry(state, op.replacementEntryId) : undefined;
  if (op.replacementEntryId !== undefined && !replacement) fail(`The replacement entry "${op.replacementEntryId.slice(0, 60)}" does not exist.`);
  if (op.replacementPageId !== undefined && !own(state.pages, op.replacementPageId)) fail('The replacement page does not exist.');
  const uses = entryLinkUses(state, entry.id);
  const refs = entryReferenceUses(state, entry.id);
  const to: LinkValue | undefined = op.replacementEntryId !== undefined ? { type: 'entry', target: op.replacementEntryId } : op.replacementPageId !== undefined ? { type: 'page', target: op.replacementPageId } : undefined;
  if (uses.length && !to)
    throw new EngineError('VALIDATION_FAILED', `${uses.length} link${uses.length === 1 ? '' : 's'} point to “${entry.title}”. Choose a replacement entry or page for them.`, { references: uses.length + refs.length });
  if (refs.length) {
    // A reference names an entry of its field's collection: only another of them can take its place.
    const where = [...new Set(refs.map((r) => `${r.entry.title} (${r.collection.settings.name})`))].slice(0, 3).join(', ');
    const n = refs.length;
    const asked = `${n} reference${n === 1 ? '' : 's'} name “${entry.title}” (in ${where})`;
    if (op.replacementEntryId === undefined)
      throw new EngineError('VALIDATION_FAILED', `${asked}. Choose a replacement entry of ${c.settings.name} for them, or clear them first.`, { references: uses.length + n });
    if (!Object.hasOwn(c.entries, op.replacementEntryId)) throw new EngineError('VALIDATION_FAILED', `${asked}, and only another entry of ${c.settings.name} can take its place. Choose one of those, or clear them first.`, { references: uses.length + n });
  }
  refuseSyncedHolders(state, [...uses, ...refs.map((r) => ({ owner: { kind: 'entry' as const, id: r.entry.id, collectionId: r.collection.settings.id }, where: `${r.entry.title} (${r.collection.settings.name})` }))], `“${entry.title}”`);
  // The address it answers at now, when that was an old address of its own as the batch began (taken back during it):
  // visitors' bookmarks to it go on to the replacement like the old addresses it still keeps.
  const current = entryRoute(c, entry);
  const start = current !== undefined ? atStart?.get(current.toLowerCase()) : undefined;
  const reclaimed = start?.entryId === entry.id && start.old;
  const handed = keptAddresses(state).filter((r) => r?.entryId === entry.id && typeof r.from === 'string').map((r) => r.from);
  if (replacement && (uses.length || handed.length || reclaimed) && !canReplaceEntry(c, replacement, refs.length > 0))
    fail(`“${replacement.entry.title}” has no page of its own, so links and old addresses can’t send visitors to it. Choose a page, or an entry with a page of its own.`);
  for (const { link } of uses) {
    link.type = to!.type;
    link.target = to!.target;
    delete link.anchor;
    // A query stays with a post's address: a page link has none.
    if (to!.type !== 'entry') delete link.query;
  }
  // Each reference names the replacement where it named the entry, once: a list already naming it keeps it where it was.
  for (const { entry: holder, field } of refs) {
    const v: unknown = holder.values[field];
    if (Array.isArray(v)) holder.values[field] = [...new Set(v.map((id) => (id === entry.id ? op.replacementEntryId! : id)))] as string[];
    else holder.values[field] = op.replacementEntryId!;
  }
  delete c.entries[entry.id];
  if (Array.isArray(c.settings.entryOrder)) c.settings.entryOrder = c.settings.entryOrder.filter((id) => id !== entry.id);
  // Its old addresses send visitors to the replacement the links now go to, or go with it when there is none.
  const heir: { entryId: string } | { pageId: string } | null = op.replacementEntryId !== undefined ? { entryId: op.replacementEntryId } : op.replacementPageId !== undefined ? { pageId: op.replacementPageId } : null;
  const kept = keptAddresses(state);
  if (handed.length || (reclaimed && heir)) {
    const rest = kept.flatMap((r): SiteRedirect[] => (r?.entryId !== entry.id ? [r] : heir ? [{ from: r.from, ...(r.custom ? { custom: true as const } : {}), ...heir }] : []));
    if (reclaimed && heir) {
      rest.push({ from: current!, ...heir });
      handed.push(current!);
    }
    setKeptAddresses(state, rest);
  }
  if (atStart) {
    // Nothing else of the batch reaches it through this ID, even created again; a replacement entry keeps what it
    // was handed as its own for the rest of the batch.
    for (const [key, a] of [...atStart]) if (a.entryId === entry.id) atStart.delete(key);
    if (heir && 'entryId' in heir) for (const from of handed) atStart.set(from.toLowerCase(), { entryId: heir.entryId, old: true });
  }
  return { collectionId: c.settings.id, entryId: entry.id, referencesRepointed: uses.length + refs.length };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface CollectionDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  owner: { kind: 'collection' | 'entry'; id: string };
  site?: string;
}

/** Every link stored inside a value, rich text spans included. */
function linksIn(v: unknown, out: LinkValue[] = []): LinkValue[] {
  if (Array.isArray(v)) v.forEach((x) => linksIn(x, out));
  else if (v && typeof v === 'object') {
    const l = v as LinkValue;
    if (typeof l.type === 'string' && typeof l.target === 'string') out.push(l);
    Object.values(v).forEach((x) => linksIn(x, out));
  }
  return out;
}

/**
 * What is wrong with the project's collections, as hand edits can leave them: settings, addresses (checked against
 * `routes`, every page's and old page address's, which it extends), entries, their groupings, fields, pictures and
 * links. Only what an edit can never produce is an error that stops saving.
 */
export function collectionDiagnostics(state: ProjectState, routes: Map<string, string>): CollectionDiagnostic[] {
  const out: CollectionDiagnostic[] = [];
  const assets = state.assets.assets;
  const claim = (route: string, label: string, owner: CollectionDiagnostic['owner']) => {
    const key = route.toLowerCase();
    if (routes.has(key)) out.push({ severity: 'error', code: 'ROUTE_DUPLICATE', message: `${routes.get(key)} and ${label} share ${route}.`, owner });
    else routes.set(key, label);
  };
  const entryIds = new Map<string, string>();
  for (const [cid, c] of Object.entries(state.collections ?? {})) {
    const s = c?.settings;
    const owner = { kind: 'collection' as const, id: cid };
    if (!s || typeof s !== 'object' || s.id !== cid || !isCollectionId(cid) || typeof s.name !== 'string') {
      out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `The collection in siteorigin/collections/${cid}/ has damaged settings.`, owner });
      continue;
    }
    const name = `The ${s.name} collection`;
    // Only a collection with pages needs an address: a data-only one claims none, whatever it keeps.
    const routed = hasDetailPages(s);
    const prefixErr = !routed
      ? null
      : typeof s.route !== 'string'
        ? 'it has no address.'
        : s.route === '/'
          ? 'it cannot use "/".'
          : (validateRoute(s.route) ?? (s.route.slice(1, -1).split('/').length > MAX_PREFIX_DEPTH ? `its address can be at most ${MAX_PREFIX_DEPTH} levels deep.` : null));
    if (prefixErr) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `${name}: ${prefixErr}`, owner });
    else if (routed && hasArchivePages(s)) claim(s.route!, `the ${s.name} collection`, owner);
    const settingProblem = collectionSettingProblem(s);
    if (settingProblem) out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: ${settingProblem}`, owner, site: 'settings' });
    const taxonomies = s.taxonomies && typeof s.taxonomies === 'object' ? s.taxonomies : {};
    const fields = s.fields && typeof s.fields === 'object' ? s.fields : {};
    if (taxonomies !== s.taxonomies || Object.entries(taxonomies).some(([id, t]) => !isTermId(id) || typeof t?.label !== 'string' || !t.terms || typeof t.terms !== 'object'))
      out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: its groupings are damaged.`, owner });
    const damaged = (f: CollectionFieldSchema | undefined) => fieldDamaged(state, f);
    const fieldsDamaged = fields !== s.fields || Object.values(fields).some(damaged);
    if (fieldsDamaged) out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: its custom fields are damaged.`, owner });
    // Links in fields' defaults go where links in an entry's fields do.
    for (const [k, f] of Object.entries(fields)) if ((f?.type === 'link' || f?.type === 'richtext') && !damaged(f)) out.push(...linkProblems(state, f.default, `${name}: the default of ${f.label}`, owner, `default|${k}`));
    // Its layout is checked as a tree, element by element, with the others (validate.ts); here only that there is one.
    const t = s.template as Partial<NodeTree> | undefined;
    if (!t || typeof t !== 'object' || !Array.isArray(t.rootIds) || !t.nodes || typeof t.nodes !== 'object')
      out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: its layout is damaged, so its entries cannot be shown.`, owner });
    for (const [k, f] of Object.entries(fields)) {
      const a = f?.type === 'image' && f.default?.assetId ? own(assets, f.default.assetId) : undefined;
      if (f?.type === 'image' && f.default?.assetId && !a) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${name}: the default of ${f.label} shows an image that is not in the library.`, owner, site: `default|${k}` });
      else if (a && a.kind !== 'image') out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${name}: the default of ${f!.label} shows “${a.name}”, which is a ${a.kind}, not a picture.`, owner, site: `default|${k}|${a.id}` });
    }
    const order = s.entryOrder;
    if (order !== undefined && (!Array.isArray(order) || order.length !== Object.keys(c.entries).length || new Set(order).size !== order.length || !order.every((id) => Object.hasOwn(c.entries, id))))
      out.push({ severity: 'warning', code: 'ENTRY_ORDER_INVALID', message: `${name}: its chosen order does not list every entry exactly once, so entries it misses follow it newest first.`, owner });
    const slugs = new Map<string, string>();
    for (const [eid, e] of Object.entries(c.entries)) {
      const eo = { kind: 'entry' as const, id: eid };
      if (!e || typeof e !== 'object' || e.id !== eid || !isEntryId(eid) || typeof e.title !== 'string' || !Array.isArray(e.body) || !e.body.every(isRichBlock)) {
        out.push({ severity: 'error', code: 'ENTRY_INVALID', message: `${name}: the entry ${eid} is damaged.`, owner: eo });
        continue;
      }
      const what = `${s.name}: “${e.title}”`;
      if (entryIds.has(eid)) out.push({ severity: 'error', code: 'ENTRY_INVALID', message: `${what} has the same ID as an entry of the ${entryIds.get(eid)} collection.`, owner: eo });
      entryIds.set(eid, s.name);
      const slugOk = typeof e.slug === 'string' && !validateSegment(e.slug);
      if (!slugOk) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `${what}: its slug is not one lowercase part of an address.`, owner: eo });
      else if (routed && !prefixErr) claim(`${s.route}${e.slug}/`, `the entry “${e.title}”`, eo);
      else if (!routed) {
        // Without pages, two entries' slugs only clash once the collection has them again.
        const twin = slugs.get(e.slug.toLowerCase());
        if (twin !== undefined) out.push({ severity: 'warning', code: 'SLUG_DUPLICATE', message: `${what} has the same slug as “${twin}”, so the two would share an address if its entries had pages.`, owner: eo, site: 'slug' });
        else slugs.set(e.slug.toLowerCase(), e.title);
      }
      if (!collectionHasBody(s) && Array.isArray(e.body) && e.body.length)
        out.push({ severity: 'warning', code: 'ENTRY_TEXT_HIDDEN', message: `${what} has text of its own, which entries of ${s.name} do not show. Clear it, or turn entry text back on.`, owner: eo, site: 'body' });
      const sourceProblem = e.source !== undefined ? entrySourceProblem(e.source) : null;
      if (sourceProblem) out.push({ severity: 'warning', code: 'ENTRY_SOURCE_INVALID', message: `${what}: ${sourceProblem}`, owner: eo, site: 'source' });
      if (!isArticleDate(e.publishedAt)) out.push({ severity: 'warning', code: 'ENTRY_DATE_INVALID', message: `${what}: its publication date is not a calendar date written YYYY-MM-DD.`, owner: eo });
      if (e.updatedAt !== undefined && !isArticleDate(e.updatedAt)) out.push({ severity: 'warning', code: 'ENTRY_DATE_INVALID', message: `${what}: its revision date is not a calendar date written YYYY-MM-DD.`, owner: eo, site: 'updatedAt' });
      if (e.featuredImage !== undefined) {
        const a = typeof e.featuredImage === 'string' ? own(assets, e.featuredImage) : undefined;
        if (!a) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${what}: its featured image is not in the library.`, owner: eo, site: 'featuredImage' });
        else if (a.kind !== 'image') out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${what}: its featured image is “${a.name}”, which is a ${a.kind}, not a picture.`, owner: eo, site: `featuredImage|${a.id}` });
      }
      const seo = e.seo && typeof e.seo === 'object' ? e.seo : undefined;
      if (seo?.socialImage !== undefined && seo.socialImage !== '') {
        const a = typeof seo.socialImage === 'string' ? own(assets, seo.socialImage) : undefined;
        if (!a) out.push({ severity: 'warning', code: 'ASSET_MISSING', message: `${what}: its sharing image is not in the library, so links to it are shared without one.`, owner: eo, site: 'socialImage' });
        else if (a.kind !== 'image') out.push({ severity: 'warning', code: 'ASSET_NOT_IMAGE', message: `${what}: its sharing image is “${a.name}”, which is a ${a.kind}, not a picture.`, owner: eo, site: `socialImage|${a.id}` });
      }
      if (seo?.canonical !== undefined && !storedCanonical(seo.canonical))
        out.push({ severity: 'warning', code: 'CANONICAL_INVALID', message: `${what}: its canonical URL is not a full http(s) address, so its own public URL is used.`, owner: eo, site: 'canonical' });
      for (const [tax, ids] of Object.entries(e.terms && typeof e.terms === 'object' ? e.terms : {})) {
        const t = own(taxonomies, tax);
        const unknown = Array.isArray(ids) ? ids.filter((id) => !t || !Object.hasOwn(t.terms ?? {}, id)) : [String(ids)];
        if (unknown.length) out.push({ severity: 'warning', code: 'TERM_UNKNOWN', message: `${what}: ${t ? `${t.label} has no term` : `the collection has no grouping "${tax}" for`} ${unknown.map((u) => `“${u}”`).join(', ')}.`, owner: eo, site: `terms|${tax}` });
      }
      for (const [k, v] of Object.entries(e.values && typeof e.values === 'object' ? e.values : {})) {
        const f = own(fields, k);
        // A damaged field is reported once, above; its values cannot be judged. A reference to a collection there is
        // can, whatever its default says.
        if (f && damaged(f) && !(f.type === 'reference' && typeof f.collection === 'string' && Object.hasOwn(state.collections, f.collection))) continue;
        if (!f) {
          out.push({ severity: 'warning', code: 'FIELD_VALUE_INVALID', message: `${what}: the collection has no field "${k}".`, owner: eo, site: `values|${k}` });
          continue;
        }
        if (f.type === 'image') {
          const id = (v as { assetId?: unknown })?.assetId;
          const a = typeof id === 'string' ? own(assets, id) : undefined;
          if (typeof id === 'string' && !a) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${what}: ${f.label} shows an image that is not in the library.`, owner: eo, site: `values|${k}` });
          else if (a && a.kind !== 'image') out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${what}: ${f.label} shows “${a.name}”, which is a ${a.kind}, not a picture.`, owner: eo, site: `values|${k}|${a.id}` });
          continue;
        }
        if (f.type === 'link' || f.type === 'richtext') {
          // A rich text field's text is no article: a section heading or a picture in it is left out, and the rest shows.
          const readable = f.type === 'link' ? !!v && typeof v === 'object' && typeof (v as LinkValue).type === 'string' && typeof (v as LinkValue).target === 'string' : Array.isArray(v) && v.every(isRichBlock);
          if (!readable || (f.type === 'richtext' && (v as unknown[]).some(isArticleBlock)))
            out.push({ severity: 'warning', code: 'FIELD_VALUE_INVALID', message: `${what}: its ${f.label} is not a value the field takes.`, owner: eo, site: `values|${k}` });
          if (readable) out.push(...linkProblems(state, v, `${what}: ${f.label}`, eo, `values|${k}`));
          continue;
        }
        if (f.type === 'reference') {
          // One naming an entry that is gone is broken, as a link to it would be: removing an entry never leaves one.
          for (const problem of referenceProblems(state, f, v))
            out.push({
              severity: problem.missing ? 'error' : 'warning',
              code: problem.missing ? 'REFERENCE_BROKEN' : 'FIELD_VALUE_INVALID',
              message: `${what}: its ${f.label} ${problem.message}`,
              owner: eo,
              site: `values|${k}${problem.missing ? `|${problem.missing}` : ''}`
            });
          continue;
        }
        const fits =
          f.type === 'string'
            ? typeof v === 'string'
            : f.type === 'number'
              ? typeof v === 'number' && Number.isFinite(v)
              : f.type === 'boolean'
                ? typeof v === 'boolean'
                : f.type === 'date'
                  ? v === '' || (typeof v === 'string' && isArticleDate(v))
                  : f.options?.some((o) => o.value === v);
        if (!fits) out.push({ severity: 'warning', code: 'FIELD_VALUE_INVALID', message: `${what}: its ${f.label} is not a value the field takes.`, owner: eo, site: `values|${k}` });
      }
      out.push(...linkProblems(state, e.body, `${what}: a link in its text`, eo, 'body'));
      out.push(...bodyImageProblems(state, e.body, what, eo));
    }
  }
  // A page or old address made before archive pages, inside a collection's archive folders: the collection's index or
  // a category archive stops before it, and the website leaves its later pages out.
  for (const o of routeOwners(state)) {
    if (o.kind === 'collection') continue;
    const archive = archiveRouteOwner(state, o.route);
    if (!archive || archive.kind !== 'collection' || (o.kind === 'entry' && o.collectionId === archive.collectionId)) continue;
    // A draft is left out of the website, where an archive page can show at its address instead; anything else there
    // stops the archive pages before it.
    const draftEntry = (id: string | undefined) => (id ? findEntry(state, id)?.entry.draft !== false : false);
    const draft =
      o.kind === 'page'
        ? state.pages[o.pageId]?.draft === true
        : o.kind === 'entry'
          ? draftEntry(o.entryId)
          : o.pageId !== undefined
            ? state.pages[o.pageId]?.draft === true || !Object.hasOwn(state.pages, o.pageId)
            : o.entryId !== undefined
              ? !findEntry(state, o.entryId) || draftEntry(o.entryId)
              : // One leading to another address gives way to the archive page there.
                true;
    out.push({
      severity: 'warning',
      code: 'ARCHIVE_ADDRESS_TAKEN',
      message: `${o.label[0].toUpperCase()}${o.label.slice(1)} is at ${o.route}, an address kept for ${archive.label}: ${draft ? 'the website can show one of them there instead' : 'they can stop before it'}. ${o.kind === 'page' ? 'Give the page another address.' : o.kind === 'entry' ? 'Give the entry another slug, or move its collection.' : 'Stop keeping that old address working.'}`,
      owner: { kind: 'collection', id: archive.collectionId },
      site: o.route.toLowerCase()
    });
  }
  return out;
}

/**
 * Pictures in an entry's text that cannot show: no longer in the library, or not a picture. One the author left
 * undescribed (and did not mark decorative) is said too, as an image on a page is. Numbered as the text shows them.
 */
export function bodyImageProblems(state: ProjectState, body: RichText, what: string, owner: CollectionDiagnostic['owner']): CollectionDiagnostic[] {
  const out: CollectionDiagnostic[] = [];
  let n = 0;
  for (const b of body) {
    if (!isImageBlock(b)) continue;
    n++;
    const a = typeof b.assetId === 'string' ? own(state.assets.assets, b.assetId) : undefined;
    if (!a) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${what}: picture ${n} in its text is not in the library.`, owner, site: `body|image|${n}` });
    else if (a.kind !== 'image') out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${what}: picture ${n} in its text is “${a.name}”, which is a ${a.kind}, not a picture.`, owner, site: `body|image|${n}|${a.id}` });
    else if (!b.decorative && !String(b.alt ?? '').trim()) out.push({ severity: 'warning', code: 'ALT_MISSING', message: `${what}: picture ${n} in its text has no description.`, owner, site: `body|alt|${n}` });
  }
  return out;
}

/**
 * Links in an entry's text, one of its fields or a field's default that go nowhere: a page, an entry or a document that
 * is no longer there. `what` names the place ("…: a link in its text"), `site` the field.
 */
function linkProblems(state: ProjectState, value: unknown, what: string, owner: CollectionDiagnostic['owner'], site: string): CollectionDiagnostic[] {
  const gone = new Set<string>();
  for (const l of linksIn(value)) {
    if (l.type === 'page' && !Object.hasOwn(state.pages, l.target)) gone.add('a page that no longer exists');
    if (l.type === 'entry' && !findEntry(state, l.target)) gone.add('an entry that no longer exists');
    if (l.type === 'collection' && !own(state.collections, l.target)) gone.add('a collection that no longer exists');
    if (l.type === 'document' && own(state.assets.assets, l.target)?.kind !== 'document') gone.add('a document that is no longer in Assets');
  }
  return [...gone].map((g) => ({ severity: 'error' as const, code: 'LINK_BROKEN', message: `${what} goes to ${g}.`, owner, site: `${site}|${g}` }));
}

/** What is wrong with a collection's settings beyond its address, groupings, fields and layout, as a hand edit leaves them, or null. */
function collectionSettingProblem(s: CollectionDoc): string | null {
  if (s.kind !== undefined && !COLLECTION_KINDS.includes(s.kind)) return `its kind is not ${COLLECTION_KINDS.join(' or ')}.`;
  if (s.singularName !== undefined && (typeof s.singularName !== 'string' || !s.singularName.trim())) return 'what one entry is called is not a name.';
  if (s.hasBody !== undefined && typeof s.hasBody !== 'boolean') return 'whether entries have text is not true or false.';
  if (s.rss !== undefined && typeof s.rss !== 'boolean') return 'whether its entries are in the RSS feed is not true or false.';
  const p = s.pages as Partial<CollectionPages> | undefined;
  if (p !== undefined && (!p || typeof p !== 'object' || typeof p.detail !== 'boolean' || typeof p.archive !== 'boolean')) return 'its pages are damaged.';
  if (p?.archive && !p.detail) return "it has an archive without entry pages to list, so it has neither. Turn on entry pages, or turn off the archive.";
  if (s.sourceId !== undefined && (typeof s.sourceId !== 'string' || !s.sourceId.trim() || s.sourceId.length > 200)) return 'the external source it is synced from is damaged.';
  const longDescription = (d: unknown) => d !== undefined && (typeof d !== 'string' || d.length > TEXT_LIMITS.pageDescription);
  if (longDescription(s.description)) return `what its index tells search engines is not text of at most ${TEXT_LIMITS.pageDescription} characters.`;
  const terms = s.taxonomies?.categories?.terms;
  const term = terms && typeof terms === 'object' ? Object.entries(terms).find(([, t]) => t && typeof t === 'object' && longDescription(t.description)) : undefined;
  if (term) return `what the category “${typeof term[1].label === 'string' ? term[1].label : term[0]}” tells search engines is not text of at most ${TEXT_LIMITS.pageDescription} characters.`;
  return null;
}

/** Whether a custom field's schema is one no entry's value can be judged by: an unknown kind, a choice without choices, a reference to nothing. */
function fieldDamaged(state: ProjectState, f: CollectionFieldSchema | undefined): boolean {
  if (!f || typeof f !== 'object' || !(COLLECTION_FIELD_TYPES as readonly unknown[]).includes(f.type)) return true;
  if (f.type === 'enum') return !Array.isArray(f.options) || !f.options.length || !f.options.every((o) => typeof o?.value === 'string');
  // A reference names no entry by default (see normalizeField): one that did would escape the guard on removing it.
  if (f.type === 'reference') return typeof f.collection !== 'string' || !Object.hasOwn(state.collections, f.collection) || JSON.stringify(f.default) !== JSON.stringify(f.multiple ? [] : '');
  if (f.type === 'date') return f.default !== '' && !(typeof f.default === 'string' && isArticleDate(f.default));
  if (f.type === 'link') return !f.default || typeof f.default !== 'object';
  if (f.type === 'richtext') return !Array.isArray(f.default) || !f.default.every((b) => isRichBlock(b) && !isArticleBlock(b));
  return false;
}

/**
 * What is wrong with a reference field's value, as a hand edit or a sync leaves it (it then shows nothing for it): one
 * problem each, and one for each entry it names that its collection does not have (`missing`), so a second one gone is
 * a problem of its own.
 */
function referenceProblems(state: ProjectState, f: ReferenceFieldSchema, v: unknown): Array<{ message: string; missing?: string }> {
  const given = f.multiple ? v : [v];
  const ids = Array.isArray(given) ? given.filter((id): id is string => typeof id === 'string') : [];
  // Each entry ID it holds is checked whatever else is wrong with it: those are what it shows.
  const out: Array<{ message: string; missing?: string }> = [];
  if (!Array.isArray(given) || ids.length !== given.length) out.push({ message: `is not ${f.multiple ? 'a list of entry IDs' : 'an entry ID'}.` });
  else if (new Set(ids).size !== ids.length) out.push({ message: 'names an entry twice.' });
  const target = own(state.collections, f.collection)!;
  for (const id of new Set(ids))
    if (id !== '' && !Object.hasOwn(target.entries, id)) out.push({ message: `names "${id}", which the ${target.settings.name} collection has no entry for, so it shows nothing there.`, missing: id });
  return out;
}

/** A block only an entry's own text (an article) has: a section heading or a picture. */
const isArticleBlock = (b: unknown) => !!b && typeof b === 'object' && ((b as { type?: unknown }).type === 'h2' || isImageBlock(b as RichText[number]));

/** What is wrong with where a synced entry came from, as a hand edit leaves it, or null. */
function entrySourceProblem(source: unknown): string | null {
  const src = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  const text = (k: string) => typeof src[k] === 'string' && (src[k] as string).trim() !== '';
  if (!text('sourceId') || !text('externalId') || !text('contentHash') || !text('syncedAt') || Number.isNaN(Date.parse(src.syncedAt as string))) return 'where it was synced from is damaged.';
  return null;
}

const LAYOUT_NODE_KINDS = new Set(['element', 'text', 'image', 'link', 'icon', 'divider', 'repeat', 'instance']);

/**
 * An archive layout given whole: a tree of the nodes it holds, reached from its roots, each under an ID no other tree
 * has, so no node (or style rule) is shared with the page or layout it was copied from. A node of another kind, or one
 * listed twice, is refused.
 */
function archiveLayoutOf(state: ProjectState, collectionId: string, raw: { rootIds: string[]; nodes: Record<string, unknown> }): NodeTree {
  const src = structuredClone(raw) as NodeTree;
  const ids = new Map<string, string>();
  const nodes: Record<string, GraphNode> = {};
  // An ID of its own is kept, so a batch can go on to edit the node it names; one another tree has (it was copied from
  // a page), or one a class name could not carry, is given a fresh one.
  const taken = new Set(allTrees(state).filter((t) => !(t.owner.kind === 'archive' && t.owner.id === collectionId)).flatMap((t) => Object.keys(t.tree.nodes ?? {})));
  const idFor = (id: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(id) && !taken.has(id) ? id : newId('n'));
  const take = (id: string, depth: number): string => {
    const n = Object.hasOwn(src.nodes, id) ? (src.nodes[id] as GraphNode | null) : undefined;
    if (!n || typeof n !== 'object' || n.id !== id || !LAYOUT_NODE_KINDS.has(n.kind)) fail(`The archive layout's node "${id.slice(0, 60)}" is not one it can hold: give each node its own ID and a kind a page can show.`);
    if (ids.has(id)) fail(`The archive layout shows the node "${id.slice(0, 60)}" twice.`);
    if (depth > 100) fail('The archive layout nests its elements more than 100 deep.');
    if (n.kind === 'repeat' && (!n.list || typeof n.list !== 'object' || Array.isArray(n.list))) fail(`The archive layout's list "${id.slice(0, 60)}" repeats nothing: give it a query, or the archive page's entries.`);
    const fresh = idFor(id);
    taken.add(fresh);
    ids.set(id, fresh);
    const copy = { ...n, id: fresh } as GraphNode;
    if ((copy.kind === 'element' || copy.kind === 'repeat') && Array.isArray(copy.children)) copy.children = copy.children.map((c) => take(c, depth + 1));
    else if (copy.kind === 'element' || copy.kind === 'repeat') fail(`The archive layout's node "${id.slice(0, 60)}" has no list of children.`);
    if (copy.kind === 'instance' && copy.slots) copy.slots = Object.fromEntries(Object.entries(copy.slots).map(([slot, kids]) => [slot, (Array.isArray(kids) ? kids : []).map((c) => take(c, depth + 1))]));
    nodes[fresh] = copy;
    return fresh;
  };
  const rootIds = src.rootIds.map((id) => take(id, 0));
  return { rootIds, nodes };
}

/** A collection's archive layout as `collection.create` or `collection.update` sets it. */
export function setArchiveLayout(state: ProjectState, c: Collection, value: NonNullable<Op<'collection.update'>['archiveTemplate']>): void {
  c.settings.archiveTemplate = value === 'start' ? starterArchiveLayout(c) : archiveLayoutOf(state, c.settings.id, value);
}
