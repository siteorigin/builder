/**
 * Collection and entry operations, and the checks that keep collections consistent with the rest of the project:
 * every address held once across pages, old page addresses, collections and entries; links to entries kept or
 * pointed elsewhere when an entry goes; pictures and links in entries pointing at things that exist.
 */
import type { Collection, CollectionDoc, CollectionFieldSchema, CollectionFieldValue, CollectionTaxonomy, EntryDoc, LinkValue, ProjectState, RichText } from '@shared/types';
import { COLLECTION_FIELD_TYPES, SCHEMA_VERSION } from '@shared/types';
import type { Op } from '@shared/ops';
import { POSTS_COLLECTION_ID, entryRoute, findEntry, isCollectionId, isEntryId, isTermId, routeOwners, type RouteOwner } from '@shared/collections';
import { isArticleDate, todayArticleDate } from '@shared/articles';
import { normalizeRoute, slugify, validateRoute } from '@shared/routes';
import { isRichBlock } from '@shared/richtext';
import { newId } from '@shared/ids';
import { EngineError, fail } from './tree';
import { normalizeRichText, normalizeScalar } from './values';
import { checkPropName, normalizePropSchema } from './schema';
import { entryLinkUses } from './page-links';

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

/** Whether `owner` is one of the claims `except` names: a collection's own, or one entry's. */
type Except = { collectionId?: string; entryIds?: ReadonlySet<string> };
const excepted = (o: RouteOwner, except: Except) =>
  (o.kind === 'collection' && o.collectionId === except.collectionId) || (o.kind === 'entry' && (o.collectionId === except.collectionId || !!except.entryIds?.has(o.entryId)));

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

/** A slug as given: one lowercase segment of an address. */
function explicitSlug(input: string): string {
  const slug = input.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 60) fail(`"${input.slice(0, 80)}" is not a slug: use up to 60 lowercase letters, numbers and hyphens, starting with a letter or number.`);
  return slug;
}

/**
 * The slug an entry titled `title` gets automatically: a slug of its title, numbered when its address is held by
 * anything else (a page, an old page address, a collection, another entry), kept within 60 characters.
 */
function autoSlug(state: ProjectState, collection: Collection, title: string, entryId: string): string {
  const stem = slugify(title) || 'entry';
  const holder = routeIndex(state);
  const free = (slug: string) => !holder(`${collection.settings.route}${slug}/`, { entryIds: new Set([entryId]) });
  let slug = stem;
  for (let i = 2; !free(slug); i++) slug = `${stem.slice(0, 60 - `-${i}`.length).replace(/-+$/, '')}-${i}`;
  return slug;
}

/** Refuses an address something else holds, naming it. */
function refuseTaken(state: ProjectState, route: string, except: Except, what: string) {
  const holder = routeHolder(state, route, except);
  if (holder) fail(`${route} is already the address of ${holder.label}. Choose another ${what}.`);
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
  const settings: CollectionDoc = {
    schemaVersion: SCHEMA_VERSION,
    id: op.collectionId,
    name: (op.name ?? preset?.name ?? nameFromId(op.collectionId)).trim(),
    route,
    taxonomies: normalizeTaxonomies(op.taxonomies ?? preset?.taxonomies ?? {}),
    fields: normalizeFields(op.fields ?? {}, state)
  };
  state.collections[op.collectionId] = { settings, entries: {} };
  return { collectionId: op.collectionId, route };
}

export function collectionUpdate(state: ProjectState, op: Op<'collection.update'>): OpResult {
  const c = getCollection(state, op.collectionId);
  if (op.name !== undefined) c.settings.name = op.name.trim() || c.settings.name;
  if (op.route !== undefined) {
    const route = prefixRoute(op.route);
    // The collection and every entry move together: each new address must be free of everything else.
    const except = { collectionId: c.settings.id };
    refuseTaken(state, route, except, 'address for the collection');
    const held = routeIndex(state);
    for (const e of Object.values(c.entries)) {
      const holder = held(`${route}${e.slug}/`, except);
      if (holder) fail(`Moving the collection to ${route} would give “${e.title}” the address ${route}${e.slug}/, which is ${holder.label}'s. Change that entry's slug first, or choose another address.`);
    }
    c.settings.route = route;
  }
  if (op.taxonomies !== undefined || op.fields !== undefined) {
    const taxonomies = op.taxonomies !== undefined ? normalizeTaxonomies(op.taxonomies) : c.settings.taxonomies;
    const fields = op.fields !== undefined ? normalizeFields(op.fields, state) : c.settings.fields;
    settleEntries(state, c, taxonomies, fields);
    c.settings.taxonomies = taxonomies;
    c.settings.fields = fields;
  }
  return { collectionId: c.settings.id, route: c.settings.route };
}

export function collectionRemove(state: ProjectState, op: Op<'collection.remove'>): OpResult {
  const c = getCollection(state, op.collectionId);
  const members = new Set(Object.keys(c.entries));
  // Links between its own entries go with them; any other link to one of them would be left going nowhere.
  const outside = entryLinkUses(state, members);
  if (outside.length) {
    const n = outside.length;
    throw new EngineError('VALIDATION_FAILED', `${n} link${n === 1 ? '' : 's'} outside the ${c.settings.name} collection point to its entries (in ${[...new Set(outside.map((u) => u.where))].slice(0, 3).join(', ')}). Point them elsewhere first.`, { references: n });
  }
  delete state.collections[c.settings.id];
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

/** Applies the details an operation gives to an entry; anything it leaves out stays as it is. */
function applyEntryFields(state: ProjectState, c: Collection, entry: EntryDoc, op: EntryFields) {
  const label = `“${op.title ?? entry.title}”`;
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
    if (slug !== entry.slug) refuseTaken(state, `${c.settings.route}${slug}/`, { entryIds: new Set([entry.id]) }, 'slug');
    entry.slug = slug;
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
  applyEntryFields(state, c, entry, { ...op, slug: undefined });
  if (Array.isArray(c.settings.entryOrder)) c.settings.entryOrder.push(id);
  return { collectionId: c.settings.id, entryId: id, slug: entry.slug, route: entryRoute(c, entry) };
}

export function entryUpdate(state: ProjectState, op: Op<'entry.update'>): OpResult {
  const c = getCollection(state, op.collectionId);
  const entry = getEntry(c, op.entryId);
  applyEntryFields(state, c, entry, op);
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

export function entryRemove(state: ProjectState, op: Op<'entry.remove'>): OpResult {
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
  delete c.entries[entry.id];
  if (Array.isArray(c.settings.entryOrder)) c.settings.entryOrder = c.settings.entryOrder.filter((id) => id !== entry.id);
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
      !(COLLECTION_FIELD_TYPES as readonly unknown[]).includes(f?.type) || (f!.type === 'enum' && (!Array.isArray(f!.options) || !f!.options.every((o) => o && typeof o === 'object')));
    const fieldsDamaged = fields !== s.fields || Object.values(fields).some(damaged);
    if (fieldsDamaged) out.push({ severity: 'error', code: 'COLLECTION_INVALID', message: `${name}: its custom fields are damaged.`, owner });
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
      const slugOk = typeof e.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(e.slug) && e.slug.length <= 60;
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
    }
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
