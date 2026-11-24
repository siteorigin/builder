/**
 * Collection and entry operations, and the checks that keep collections consistent with the rest of the project:
 * every address held once across pages, old page addresses, collections and entries; links to entries kept or
 * pointed elsewhere when an entry goes; pictures and links in entries pointing at things that exist.
 */
import type { Collection, CollectionDoc, CollectionFieldSchema, CollectionFieldValue, CollectionTaxonomy, EntryDoc, GraphNode, LinkValue, NodeTree, ProjectState, ResponsiveStyles, RichText, SiteRedirect } from '@shared/types';
import { COLLECTION_FIELD_TYPES, SCHEMA_VERSION, conditionRef, isEntryBinding } from '@shared/types';
import type { Op } from '@shared/ops';
import { ARCHIVE_FOLDERS, MAX_PAGE_SIZE, POSTS_COLLECTION_ID, archiveRouteOwner, entryRoute, findEntry, isCollectionId, isEntryId, isTermId, routeOwners, underArchiveFolder, type RouteOwner } from '@shared/collections';
import { isArticleDate, todayArticleDate } from '@shared/articles';
import { addressSlug, normalizeRoute, numberedSlug, validateRoute, validateSegment } from '@shared/routes';
import { isImageBlock, isRichBlock } from '@shared/richtext';
import { newId } from '@shared/ids';
import { EngineError, fail } from './tree';
import { normalizeRichText, normalizeScalar } from './values';
import { bindingSlots, checkPropName, normalizePropSchema } from './schema';
import { entryLinkUses } from './page-links';
import { declaredTokens } from './tokens';
import { articleTemplateFor } from '@catalogue/index';

type OpResult = Record<string, unknown>;

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The most a project holds, so one collection can never make the project too big to open and save. */
const MAX_COLLECTIONS = 20;
const MAX_TAXONOMIES = 10;
const MAX_TERMS = 200;
const MAX_FIELDS = 30;
/** A collection's prefix leaves one level for its entries under the four levels an address may have. */
const MAX_PREFIX_DEPTH = 3;

function getCollection(state: ProjectState, id: string): Collection {
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
  const holder = routeIndex(state);
  const free = (slug: string) => !holder(`${collection.settings.route}${slug}/`, { entryIds: new Set([entryId]) });
  let slug = stem;
  for (let i = 2; !free(slug); i++) slug = numberedSlug(stem, i);
  return slug;
}

/** Refuses an address something else holds, naming it. */
function refuseTaken(state: ProjectState, route: string, except: Except, what: string) {
  const holder = routeHolder(state, route, except);
  if (holder) fail(`${route} is already the address of ${holder.label}. Choose another ${what}.`);
}

/**
 * Refuses an address for collection `collectionId` where its archive pages could not have theirs: one inside another
 * collection's archive folders, or one whose own archive folders (`page/`, `category/`) already hold a page, an old
 * address or another collection (see ARCHIVE_FOLDERS).
 */
function refuseArchiveClash(state: ProjectState, route: string, collectionId: string) {
  const key = route.toLowerCase();
  for (const c of Object.values(state.collections)) {
    if (c.settings.id === collectionId || typeof c.settings.route !== 'string') continue;
    const folder = ARCHIVE_FOLDERS.find((f) => key.startsWith(`${c.settings.route.toLowerCase()}${f}/`));
    if (folder) fail(`${route} is inside ${c.settings.route}${folder}/, which is kept for the ${c.settings.name} collection's archive pages. Choose another address for the collection.`);
  }
  const inside = archiveRouteOwner(state, route, collectionId);
  if (inside) fail(`${route} is inside ${inside.label}. Choose another address for the collection.`);
  const mine = (o: RouteOwner) => (o.kind === 'collection' || o.kind === 'entry') && o.collectionId === collectionId;
  // Another collection may not sit at an archive folder itself either: its entries would be in it.
  const inFolder = (o: RouteOwner) => underArchiveFolder(route, o.route) || (o.kind === 'collection' && ARCHIVE_FOLDERS.some((f) => o.route.toLowerCase() === `${route.toLowerCase()}${f}/`));
  const clash = routeOwners(state).find((o) => !mine(o) && inFolder(o));
  if (clash)
    fail(`${clash.route} is the address of ${clash.label}, and the addresses under ${route}page/ and ${route}category/ are kept for the collection's archive pages. Choose another address for the collection, or move that first.`);
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
    for (const e of Object.values(c?.entries ?? {})) if (e?.draft === false && typeof e.slug === 'string' && typeof c.settings?.route === 'string') out.set(entryRoute(c, e).toLowerCase(), { entryId: e.id, old: false });
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

/** The ready-made blog's settings, used for whatever a new "posts" collection is not given. */
const POSTS_PRESET = {
  name: 'Posts',
  route: '/blog/',
  taxonomies: { categories: { label: 'Categories', terms: {} }, tags: { label: 'Tags', terms: {} } }
};

function normalizeTaxonomies(raw: Record<string, { label: string; terms?: Record<string, { label: string }> }>): Record<string, CollectionTaxonomy> {
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
      out[id].terms[termId] = { label };
    }
  }
  return out;
}

function normalizeFields(raw: Record<string, Record<string, unknown>>, state: ProjectState): Record<string, CollectionFieldSchema> {
  const entries = Object.entries(raw);
  if (entries.length > MAX_FIELDS) fail(`A collection can have at most ${MAX_FIELDS} custom fields.`);
  const out: Record<string, CollectionFieldSchema> = {};
  for (const [name, schema] of entries) {
    checkPropName(name, 'Field');
    if (!(COLLECTION_FIELD_TYPES as readonly unknown[]).includes(schema?.type)) fail(`Field "${name}" needs a type of ${COLLECTION_FIELD_TYPES.join(', ')}.`);
    out[name] = normalizePropSchema(schema, state, name, true) as CollectionFieldSchema;
  }
  return out;
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
      let kept: unknown;
      try {
        kept = normalizeScalar(fields[name], v, state, name, v);
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

export function collectionCreate(state: ProjectState, op: Op<'collection.create'>): OpResult {
  if (!isCollectionId(op.collectionId)) fail(`"${op.collectionId.slice(0, 60)}" is not a collection ID: use lowercase letters, numbers and single hyphens, such as "posts" or "case-studies".`);
  if (Object.hasOwn(state.collections, op.collectionId)) fail(`The collection "${op.collectionId}" already exists.`);
  if (Object.keys(state.collections).length >= MAX_COLLECTIONS) fail(`A project can have at most ${MAX_COLLECTIONS} collections.`);
  const preset = op.collectionId === POSTS_COLLECTION_ID ? POSTS_PRESET : undefined;
  const route = prefixRoute(op.route ?? preset?.route ?? `/${op.collectionId}/`);
  refuseTaken(state, route, {}, 'address for the collection');
  refuseArchiveClash(state, route, op.collectionId);
  const settings: CollectionDoc = {
    schemaVersion: SCHEMA_VERSION,
    id: op.collectionId,
    name: (op.name ?? preset?.name ?? nameFromId(op.collectionId)).trim(),
    route,
    taxonomies: normalizeTaxonomies(op.taxonomies ?? preset?.taxonomies ?? {}),
    fields: normalizeFields(op.fields ?? {}, state),
    template: themeArticleTemplate(state)
  };
  if (op.pageSize !== undefined) settings.pageSize = pageSizeOf(op.pageSize);
  if (op.categoryArchives !== undefined) settings.categoryArchives = op.categoryArchives;
  state.collections[op.collectionId] = { settings, entries: {} };
  return { collectionId: op.collectionId, route };
}

/**
 * The layout a new collection's entries start with: a copy of the theme's, every node with a new ID (so two
 * collections' layouts never share a style rule), keeping only the site styles the site has.
 */
export function themeArticleTemplate(state: ProjectState): NodeTree {
  const source = articleTemplateFor(state.site.themeId);
  if (!source) return { rootIds: [], nodes: {} };
  const tokens = new Set(declaredTokens(state).map((t) => t.id));
  const ids = new Map(Object.keys(source.nodes).map((id) => [id, newId('n')]));
  const remap = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && ids.has(id)).map((id) => ids.get(id)!) : []);
  const nodes: Record<string, GraphNode> = {};
  for (const [id, n] of Object.entries(source.nodes)) {
    const copy = structuredClone(n) as GraphNode & { children?: string[] };
    copy.id = ids.get(id)!;
    if ('children' in copy) copy.children = remap(copy.children);
    if (copy.styles) copy.styles = keptStyles(copy.styles, tokens);
    nodes[copy.id] = copy;
  }
  return { rootIds: remap(source.rootIds), nodes };
}

/** Styles without the values that name a site style the site lacks (a theme pack's template written for others). */
function keptStyles(styles: ResponsiveStyles, tokens: ReadonlySet<string>): ResponsiveStyles {
  const out: ResponsiveStyles = {};
  for (const [scope, props] of Object.entries(styles) as Array<[keyof ResponsiveStyles, Record<string, unknown>]>) {
    const kept = Object.fromEntries(Object.entries(props ?? {}).filter(([, v]) => !(v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' && !tokens.has((v as { token: string }).token))));
    if (Object.keys(kept).length) out[scope] = kept as ResponsiveStyles[keyof ResponsiveStyles];
  }
  return out;
}

export function collectionUpdate(state: ProjectState, op: Op<'collection.update'>, atStart?: ReadonlyMap<string, EntryAddress>): OpResult {
  const c = getCollection(state, op.collectionId);
  if (op.name !== undefined) c.settings.name = op.name.trim() || c.settings.name;
  if (op.route !== undefined && op.route !== c.settings.route) {
    const route = prefixRoute(op.route);
    // The collection and every entry move together: each new address must be free of everything else, apart from
    // an old address of the entry's own, which it takes back.
    const except = { collectionId: c.settings.id };
    const held = routeIndex(state);
    const taken = held(route, except);
    if (taken) fail(`${route} is already the address of ${taken.label}. Choose another address for the collection.`);
    // Nor one of its own entries' addresses, which the collection would take from under it.
    const under = Object.values(c.entries).find((e) => entryRoute(c, e).toLowerCase() === route.toLowerCase());
    if (under) fail(`${route} is the address of the entry “${under.title}”. Choose another address for the collection.`);
    refuseArchiveClash(state, route, c.settings.id);
    for (const e of Object.values(c.entries)) {
      const holder = held(`${route}${e.slug}/`, { ...except, entryIds: new Set([e.id]) });
      if (holder) fail(`Moving the collection to ${route} would give “${e.title}” the address ${route}${e.slug}/, which is ${holder.label}'s. Change that entry's slug first, or choose another address.`);
    }
    const left = Object.values(c.entries).map((e) => ({ e, from: entryRoute(c, e) }));
    c.settings.route = route;
    claimOwnAddresses(state, new Map(left.map(({ e }) => [entryRoute(c, e).toLowerCase(), e.id])));
    // Each published entry's address keeps working, sending visitors on to the entry's new one.
    const holder = routeIndex(state);
    const kept = left.filter(({ e, from }) => keepsAddress(e.id, from, e.draft === false, atStart, holder)).map(({ e, from }): SiteRedirect => ({ from, entryId: e.id }));
    // An address kept working is never in the archive folders the move gives the collection: it would stop its index there.
    const stranded = kept.find((k) => underArchiveFolder(route, k.from));
    if (stranded) {
      const folder = ARCHIVE_FOLDERS.find((f) => stranded.from.toLowerCase().startsWith(`${route.toLowerCase()}${f}/`));
      fail(`Moving the collection to ${route} would keep “${c.entries[stranded.entryId!].title}”'s address ${stranded.from} working inside ${route}${folder}/, which is kept for the collection's archive pages. Choose another address for the collection.`);
    }
    if (kept.length) setKeptAddresses(state, [...keptAddresses(state), ...kept]);
  }
  if (op.pageSize !== undefined) c.settings.pageSize = pageSizeOf(op.pageSize);
  if (op.categoryArchives !== undefined) c.settings.categoryArchives = op.categoryArchives;
  if (op.taxonomies !== undefined || op.fields !== undefined) {
    const taxonomies = op.taxonomies !== undefined ? normalizeTaxonomies(op.taxonomies) : c.settings.taxonomies;
    const fields = op.fields !== undefined ? normalizeFields(op.fields, state) : c.settings.fields;
    // A custom field the layout shows can't go, or become another kind, while it does: every entry's value would be
    // dropped below, even if a later change in the same batch brought the field back.
    for (const name of layoutFields(c)) {
      const before = Object.hasOwn(c.settings.fields ?? {}, name) ? c.settings.fields[name] : undefined;
      const after = Object.hasOwn(fields, name) ? fields[name] : undefined;
      if (before && (!after || after.type !== before.type))
        fail(`The ${c.settings.name} layout shows ${before.label}. Unbind it in the layout before ${after ? 'changing its kind' : 'removing it'}.`);
    }
    settleEntries(state, c, taxonomies, fields);
    c.settings.taxonomies = taxonomies;
    c.settings.fields = fields;
  }
  return { collectionId: c.settings.id, route: c.settings.route };
}

/** The custom fields a collection's layout shows or tests, by name. */
function layoutFields(c: Collection): Set<string> {
  const out = new Set<string>();
  const nodes = c.settings.template?.nodes;
  for (const n of Object.values(nodes && typeof nodes === 'object' ? nodes : {})) {
    if (!n || typeof n !== 'object') continue;
    for (const slot of bindingSlots(n)) {
      const b = conditionRef(slot.value) ?? slot.value;
      if (isEntryBinding(b) && b.$entry.startsWith('field.')) out.add(b.$entry.slice(6));
    }
  }
  return out;
}

export function collectionRemove(state: ProjectState, op: Op<'collection.remove'>, atStart?: Map<string, EntryAddress>): OpResult {
  const c = getCollection(state, op.collectionId);
  const members = new Set(Object.keys(c.entries));
  // Links between its own entries go with them; any other link to one of them would be left going nowhere.
  const outside = entryLinkUses(state, members);
  if (outside.length) {
    const n = outside.length;
    throw new EngineError('VALIDATION_FAILED', `${n} link${n === 1 ? '' : 's'} outside the ${c.settings.name} collection point to its entries (in ${[...new Set(outside.map((u) => u.where))].slice(0, 3).join(', ')}). Point them elsewhere first.`, { references: n });
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

type EntryFields = Partial<Pick<Op<'entry.update'>, 'title' | 'slug' | 'publishedAt' | 'updatedAt' | 'draft' | 'author' | 'excerpt' | 'featuredImage' | 'terms' | 'values' | 'body'>>;

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
  if (op.featuredImage === null || op.featuredImage === '') delete entry.featuredImage;
  else if (op.featuredImage !== undefined) {
    const a = own(state.assets.assets, op.featuredImage);
    if (!a) fail(`${label}: the featured image "${op.featuredImage.slice(0, 60)}" is not in the library.`);
    if (a!.kind !== 'image') fail(`${label}: “${a!.name}” is a ${a!.kind}, not a picture. Choose an image for the featured image.`);
    entry.featuredImage = op.featuredImage;
  }
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
  if (op.values !== undefined) {
    const values = { ...entry.values };
    for (const [name, v] of Object.entries(op.values)) {
      const schema = own(c.settings.fields, name) ?? fail(`The ${c.settings.name} collection has no field "${name.slice(0, 60)}".`);
      // Left out, a field shows its default.
      if (v === null) delete values[name];
      else values[name] = normalizeScalar(schema, v, state, `${label} → ${schema.label}`, Object.hasOwn(entry.values, name) ? entry.values[name] : undefined) as CollectionFieldValue;
    }
    entry.values = values;
  }
  // The new address first, so the text can link to it.
  if (op.slug !== undefined) {
    const slug = explicitSlug(op.slug);
    if (slug !== entry.slug) {
      const from = entryRoute(c, entry);
      refuseTaken(state, `${c.settings.route}${slug}/`, { entryIds: new Set([entry.id]) }, 'slug');
      entry.slug = slug;
      claimOwnAddresses(state, new Map([[entryRoute(c, entry).toLowerCase(), entry.id]]));
      if (keepsAddress(entry.id, from, wasPublished, atStart, routeIndex(state))) setKeptAddresses(state, [...keptAddresses(state), { from, entryId: entry.id }]);
    }
  }
  if (op.body !== undefined) entry.body = normalizeRichText(op.body ?? [], state, `${label} text`, undefined, { entries: true });
}

export function entryCreate(state: ProjectState, op: Op<'entry.create'>): OpResult {
  const c = getCollection(state, op.collectionId);
  const id = op.entryId ?? newId('en');
  if (findEntry(state, id)) fail(`An entry with the ID "${id}" already exists.`);
  const title = op.title.trim() || fail('An entry needs a title.');
  const entry: EntryDoc = { schemaVersion: SCHEMA_VERSION, id, slug: '', title, publishedAt: todayArticleDate(), draft: true, terms: {}, values: {}, body: [] };
  // Added, with its address, before anything else, so its own text can link to it.
  c.entries[id] = entry;
  if (op.slug !== undefined) {
    entry.slug = explicitSlug(op.slug);
    refuseTaken(state, entryRoute(c, entry), { entryIds: new Set([id]) }, 'slug');
  } else entry.slug = autoSlug(state, c, title, id);
  // An old address kept for this ID (a document edited by hand) is the entry's own again.
  claimOwnAddresses(state, new Map([[entryRoute(c, entry).toLowerCase(), id]]));
  applyEntryFields(state, c, entry, { ...op, slug: undefined });
  if (Array.isArray(c.settings.entryOrder)) c.settings.entryOrder.push(id);
  return { collectionId: c.settings.id, entryId: id, slug: entry.slug, route: entryRoute(c, entry) };
}

export function entryUpdate(state: ProjectState, op: Op<'entry.update'>, atStart?: ReadonlyMap<string, EntryAddress>): OpResult {
  const c = getCollection(state, op.collectionId);
  const entry = getEntry(c, op.entryId);
  applyEntryFields(state, c, entry, op, atStart);
  return { collectionId: c.settings.id, entryId: entry.id, slug: entry.slug, route: entryRoute(c, entry) };
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

export function entryRemove(state: ProjectState, op: Op<'entry.remove'>, atStart?: Map<string, EntryAddress>): OpResult {
  const c = getCollection(state, op.collectionId);
  const entry = getEntry(c, op.entryId);
  if (op.replacementEntryId !== undefined && op.replacementPageId !== undefined) fail('Choose a replacement entry or a replacement page, not both.');
  if (op.replacementEntryId === entry.id) fail('The replacement must be a different entry.');
  if (op.replacementEntryId !== undefined && !findEntry(state, op.replacementEntryId)) fail(`The replacement entry "${op.replacementEntryId.slice(0, 60)}" does not exist.`);
  if (op.replacementPageId !== undefined && !own(state.pages, op.replacementPageId)) fail('The replacement page does not exist.');
  const uses = entryLinkUses(state, entry.id);
  const to: LinkValue | undefined = op.replacementEntryId !== undefined ? { type: 'entry', target: op.replacementEntryId } : op.replacementPageId !== undefined ? { type: 'page', target: op.replacementPageId } : undefined;
  if (uses.length && !to)
    throw new EngineError('VALIDATION_FAILED', `${uses.length} link${uses.length === 1 ? '' : 's'} point to “${entry.title}”. Choose a replacement entry or page for them.`, { references: uses.length });
  for (const { link } of uses) {
    link.type = to!.type;
    link.target = to!.target;
    delete link.anchor;
  }
  // The address it answers at now, when that was an old address of its own as the batch began (taken back during it):
  // visitors' bookmarks to it go on to the replacement like the old addresses it still keeps.
  const current = entryRoute(c, entry);
  const start = atStart?.get(current.toLowerCase());
  const reclaimed = start?.entryId === entry.id && start.old;
  delete c.entries[entry.id];
  if (Array.isArray(c.settings.entryOrder)) c.settings.entryOrder = c.settings.entryOrder.filter((id) => id !== entry.id);
  // Its old addresses send visitors to the replacement the links now go to, or go with it when there is none.
  const heir: { entryId: string } | { pageId: string } | null = op.replacementEntryId !== undefined ? { entryId: op.replacementEntryId } : op.replacementPageId !== undefined ? { pageId: op.replacementPageId } : null;
  const kept = keptAddresses(state);
  const handed = kept.filter((r) => r?.entryId === entry.id && typeof r.from === 'string').map((r) => r.from);
  if (handed.length || (reclaimed && heir)) {
    const rest = kept.flatMap((r): SiteRedirect[] => (r?.entryId !== entry.id ? [r] : heir ? [{ from: r.from, ...heir }] : []));
    if (reclaimed && heir) {
      rest.push({ from: current, ...heir });
      handed.push(current);
    }
    setKeptAddresses(state, rest);
  }
  if (atStart) {
    // Nothing else of the batch reaches it through this ID, even created again; a replacement entry keeps what it
    // was handed as its own for the rest of the batch.
    for (const [key, a] of [...atStart]) if (a.entryId === entry.id) atStart.delete(key);
    if (heir && 'entryId' in heir) for (const from of handed) atStart.set(from.toLowerCase(), { entryId: heir.entryId, old: true });
  }
  return { collectionId: c.settings.id, entryId: entry.id, referencesRepointed: uses.length };
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
    const prefixErr = typeof s.route !== 'string' ? 'it has no address.' : s.route === '/' ? 'it cannot use "/".' : (validateRoute(s.route) ?? (s.route.slice(1, -1).split('/').length > MAX_PREFIX_DEPTH ? `its address can be at most ${MAX_PREFIX_DEPTH} levels deep.` : null));
    if (prefixErr) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `${name}: ${prefixErr}`, owner });
    else claim(s.route, `the ${s.name} collection`, owner);
    const taxonomies = s.taxonomies && typeof s.taxonomies === 'object' ? s.taxonomies : {};
    const fields = s.fields && typeof s.fields === 'object' ? s.fields : {};
    if (taxonomies !== s.taxonomies || Object.entries(taxonomies).some(([id, t]) => !isTermId(id) || typeof t?.label !== 'string' || !t.terms || typeof t.terms !== 'object'))
      out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: its groupings are damaged.`, owner });
    const damaged = (f: CollectionFieldSchema | undefined) =>
      !(COLLECTION_FIELD_TYPES as readonly unknown[]).includes(f?.type) || (f!.type === 'enum' && (!Array.isArray(f!.options) || !f!.options.length || !f!.options.every((o) => typeof o?.value === 'string')));
    const fieldsDamaged = fields !== s.fields || Object.values(fields).some(damaged);
    if (fieldsDamaged) out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: its custom fields are damaged.`, owner });
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
      else if (!prefixErr) claim(entryRoute(c, e), `the entry “${e.title}”`, eo);
      if (!isArticleDate(e.publishedAt)) out.push({ severity: 'warning', code: 'ENTRY_DATE_INVALID', message: `${what}: its publication date is not a calendar date written YYYY-MM-DD.`, owner: eo });
      if (e.updatedAt !== undefined && !isArticleDate(e.updatedAt)) out.push({ severity: 'warning', code: 'ENTRY_DATE_INVALID', message: `${what}: its revision date is not a calendar date written YYYY-MM-DD.`, owner: eo, site: 'updatedAt' });
      if (e.featuredImage !== undefined) {
        const a = typeof e.featuredImage === 'string' ? own(assets, e.featuredImage) : undefined;
        if (!a) out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${what}: its featured image is not in the library.`, owner: eo, site: 'featuredImage' });
        else if (a.kind !== 'image') out.push({ severity: 'error', code: 'ASSET_NOT_IMAGE', message: `${what}: its featured image is “${a.name}”, which is a ${a.kind}, not a picture.`, owner: eo, site: `featuredImage|${a.id}` });
      }
      for (const [tax, ids] of Object.entries(e.terms && typeof e.terms === 'object' ? e.terms : {})) {
        const t = own(taxonomies, tax);
        const unknown = Array.isArray(ids) ? ids.filter((id) => !t || !Object.hasOwn(t.terms ?? {}, id)) : [String(ids)];
        if (unknown.length) out.push({ severity: 'warning', code: 'TERM_UNKNOWN', message: `${what}: ${t ? `${t.label} has no term` : `the collection has no grouping "${tax}" for`} ${unknown.map((u) => `“${u}”`).join(', ')}.`, owner: eo, site: `terms|${tax}` });
      }
      for (const [k, v] of Object.entries(e.values && typeof e.values === 'object' ? e.values : {})) {
        const f = own(fields, k);
        // A damaged field is reported once, above; its values cannot be judged.
        if (f && damaged(f)) continue;
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
        const fits = f.type === 'string' ? typeof v === 'string' : f.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : f.type === 'boolean' ? typeof v === 'boolean' : f.options?.some((o) => o.value === v);
        if (!fits) out.push({ severity: 'warning', code: 'FIELD_VALUE_INVALID', message: `${what}: its ${f.label} is not a value the field takes.`, owner: eo, site: `values|${k}` });
      }
      out.push(...bodyLinkProblems(state, e.body, what, eo));
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
            : !findEntry(state, o.entryId) || draftEntry(o.entryId);
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

/** Links in an entry's text that go nowhere: a page, an entry or a document that is no longer there. */
function bodyLinkProblems(state: ProjectState, body: RichText, what: string, owner: CollectionDiagnostic['owner']): CollectionDiagnostic[] {
  const gone = new Set<string>();
  for (const l of linksIn(body)) {
    if (l.type === 'page' && !Object.hasOwn(state.pages, l.target)) gone.add('a page that no longer exists');
    if (l.type === 'entry' && !findEntry(state, l.target)) gone.add('an entry that no longer exists');
    if (l.type === 'document' && own(state.assets.assets, l.target)?.kind !== 'document') gone.add('a document that is no longer in Assets');
  }
  return [...gone].map((g) => ({ severity: 'error' as const, code: 'LINK_BROKEN', message: `${what}: a link in its text goes to ${g}.`, owner, site: `body|${g}` }));
}
