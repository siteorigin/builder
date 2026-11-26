/**
 * The Content workspace (#675): the project's collections (a blog, a team, projects, testimonials, any other kind of
 * record) made from a starter or from scratch, what each one's entries are called, and the schema settings its dialog
 * edits, turned into the operations the engine takes. Plain functions over the project, tested without a renderer.
 */
import type { Collection, CollectionFieldSchema, CollectionKind, CollectionTaxonomy, ProjectState } from '@shared/types';
import { COLLECTION_FIELD_TYPES } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, collectionHasBody, collectionKind, collectionRoutes, hasArchivePages, hasDetailPages, isCollectionId, isSyncedCollection, isTermId } from '@shared/collections';
import { numberedSlug, slugify, suggestRoute } from '@shared/routes';

export type CollectionFieldType = (typeof COLLECTION_FIELD_TYPES)[number];

/** What each kind of custom field is called where an author chooses one. */
export const FIELD_TYPE_LABELS: Record<CollectionFieldType, string> = {
  string: 'Text',
  richtext: 'Rich text',
  number: 'Number',
  boolean: 'Yes or no',
  enum: 'Choice',
  image: 'Image',
  link: 'Link',
  date: 'Date',
  reference: 'Entries of a collection'
};

/** A collection the Content tab's empty state makes in one click. */
export interface StarterCollection {
  id: string;
  name: string;
  singularName: string;
  description: string;
  kind: CollectionKind;
  hasBody: boolean;
  /** Entry pages and an archive at `route`; none, the collection is data only. */
  pages: { detail: boolean; archive: boolean };
  route?: string;
  fields: Record<string, CollectionFieldSchema>;
  taxonomies: Record<string, CollectionTaxonomy>;
}

const text = (label: string, extra: Partial<Extract<CollectionFieldSchema, { type: 'string' }>> = {}): CollectionFieldSchema => ({ type: 'string', label, default: '', ...extra });
const image = (label: string): CollectionFieldSchema => ({ type: 'image', label, default: { assetId: null, alt: '' } });

export const STARTER_COLLECTIONS: readonly StarterCollection[] = [
  {
    id: POSTS_COLLECTION_ID,
    name: 'Posts',
    singularName: 'Post',
    description: 'Articles, news and updates, each on a page of its own under /blog/, with categories and tags.',
    kind: 'editorial',
    hasBody: true,
    pages: { detail: true, archive: true },
    // The engine's own blog preset gives it its address and groupings.
    fields: {},
    taxonomies: {}
  },
  {
    id: 'team',
    name: 'Team',
    singularName: 'Team member',
    description: 'The people behind the business, with a role and a photo, for a team section on any page.',
    kind: 'structured',
    hasBody: false,
    pages: { detail: false, archive: false },
    fields: { role: text('Role'), department: text('Department'), photo: image('Photo'), featured: { type: 'boolean', label: 'Featured', default: false } },
    taxonomies: {}
  },
  {
    id: 'projects',
    name: 'Projects',
    singularName: 'Project',
    description: 'Work to show off, each with a page of its own and a list of them all.',
    kind: 'structured',
    hasBody: true,
    pages: { detail: true, archive: true },
    route: '/projects/',
    fields: { client: text('Client'), completed: { type: 'date', label: 'Completed', default: '' }, image: image('Image'), website: { type: 'link', label: 'Website', default: { type: 'none', target: '' } } },
    taxonomies: { categories: { label: 'Categories', terms: {} } }
  },
  {
    id: 'testimonials',
    name: 'Testimonials',
    singularName: 'Testimonial',
    description: 'What clients say, with who said it, for a testimonials section on any page.',
    kind: 'structured',
    hasBody: false,
    pages: { detail: false, archive: false },
    fields: { quote: text('Quote', { multiline: true }), person: text('Person'), company: text('Company'), photo: image('Photo') },
    taxonomies: {}
  }
];

/** A collection ID no collection has: `base`, numbered while taken. */
export function freeCollectionId(state: ProjectState, base: string): string {
  const stem = isCollectionId(base) ? base : slugify(base).replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '') || 'collection';
  const id = isCollectionId(stem) ? stem.slice(0, 50).replace(/-+$/, '') : 'collection';
  if (!Object.hasOwn(state.collections ?? {}, id)) return id;
  for (let n = 2; ; n++) {
    const next = numberedSlug(id, n);
    if (!Object.hasOwn(state.collections, next)) return next;
  }
}

/**
 * A top-level address no page, old address kept working or collection has: the one asked for, numbered while
 * taken (as a new page's address is).
 */
export function freeCollectionRoute(state: ProjectState, wanted: string): string {
  const kept: unknown[] = Array.isArray(state.site.redirects) ? state.site.redirects : [];
  const held = collectionRoutes(state).map((o) => o.route);
  const taken = (r: string) => [...Object.values(state.pages).map((p) => p.route), ...kept.map((x) => (x as { from?: unknown })?.from), ...held].some((u) => typeof u === 'string' && u.toLowerCase().startsWith(r.toLowerCase()));
  return suggestRoute(wanted.replace(/^\/|\/$/g, ''), taken, 'collection').route;
}

/**
 * The operation that makes a starter collection. The blog is the engine's ready-made one; another starter already in
 * the project is made again under a numbered ID, at an address nothing else has.
 */
export function starterCollectionOps(state: ProjectState, starterId: string): { ops: EditOperation[]; collectionId: string } | null {
  const s = STARTER_COLLECTIONS.find((x) => x.id === starterId);
  if (!s) return null;
  if (s.id === POSTS_COLLECTION_ID) return Object.hasOwn(state.collections, POSTS_COLLECTION_ID) ? null : { ops: [{ type: 'collection.create', collectionId: POSTS_COLLECTION_ID }], collectionId: POSTS_COLLECTION_ID };
  const collectionId = freeCollectionId(state, s.id);
  const again = collectionId !== s.id;
  return {
    collectionId,
    ops: [
      {
        type: 'collection.create',
        collectionId,
        name: again ? `${s.name} ${collectionId.slice(s.id.length + 1)}` : s.name,
        kind: s.kind,
        singularName: s.singularName,
        hasBody: s.hasBody,
        pages: s.pages,
        ...(s.pages.detail ? { route: freeCollectionRoute(state, s.route ?? `/${collectionId}/`) } : {}),
        fields: structuredClone(s.fields) as unknown as Record<string, Record<string, unknown>>,
        taxonomies: structuredClone(s.taxonomies)
      }
    ]
  };
}

/** What a custom collection is made with: its name, what one entry is called, what it holds and whether entries get pages. */
export interface CustomCollection {
  name: string;
  singularName: string;
  kind: CollectionKind;
  pages: boolean;
}

/** The operation that makes a custom collection: records data only, or with a page each and an index of them. */
export function customCollectionOps(state: ProjectState, c: CustomCollection): { ops: EditOperation[]; collectionId: string } {
  const name = c.name.trim().slice(0, 80) || 'Collection';
  const collectionId = freeCollectionId(state, name);
  const singular = c.singularName.trim().slice(0, 80);
  return {
    collectionId,
    ops: [
      {
        type: 'collection.create',
        collectionId,
        name,
        kind: c.kind,
        ...(singular ? { singularName: singular } : {}),
        // Records start without text of their own; articles always have it.
        hasBody: c.kind === 'editorial',
        pages: { detail: c.pages, archive: c.pages },
        ...(c.pages ? { route: freeCollectionRoute(state, `/${collectionId}/`) } : {})
      }
    ]
  };
}

/** What one entry of a collection is called, capitalised: its singular name, "Post" for the blog, else "Entry". */
export function entryNoun(collection: Pick<Collection, 'settings'> | undefined): string {
  const s = collection?.settings;
  const own = typeof s?.singularName === 'string' ? s.singularName.trim() : '';
  if (own) return own;
  return !s || s.id === POSTS_COLLECTION_ID || collectionKind(s) === 'editorial' ? 'Post' : 'Entry';
}

/** The same, as it reads inside a sentence ("Delete this team member?"). */
export function entryNounLower(collection: Pick<Collection, 'settings'> | undefined): string {
  const n = entryNoun(collection);
  // An acronym or a name ("FAQ", "Case Study" kept as typed past its first letter) keeps its capitals.
  return n.length > 1 && n[1] === n[1].toUpperCase() && /[A-Z]/.test(n[1]) ? n : n[0].toLowerCase() + n.slice(1);
}

/** One collection as the Content tab lists it. */
export interface ContentRow {
  id: string;
  name: string;
  count: number;
  noun: string;
  synced: boolean;
}

/** The project's collections, by name, each with how many entries it has. */
export function contentRows(state: ProjectState): ContentRow[] {
  return Object.values(state.collections ?? {})
    .map((c) => ({ id: c.settings.id, name: c.settings.name, count: Object.keys(c.entries ?? {}).length, noun: entryNoun(c), synced: isSyncedCollection(c.settings) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Whether a collection's entries are kept from manual edits: it is synced from an external source. */
export const isReadOnlyCollection = (collection: Pick<Collection, 'settings'> | undefined) => isSyncedCollection(collection?.settings);

// ---------------------------------------------------------------------------
// The schema dialog
// ---------------------------------------------------------------------------

/** One custom field as the schema dialog edits it. `name` is fixed once the field is saved; its label can change. */
export interface FieldRow {
  name: string;
  schema: CollectionFieldSchema;
  /** Added in the dialog, not saved yet: its name follows its label. */
  added?: boolean;
}

/** One grouping as the schema dialog edits it. Its terms are kept as they are: the terms manager edits those. */
export interface TaxonomyRow {
  id: string;
  label: string;
  added?: boolean;
}

/** A collection's settings as the schema dialog edits them. */
export interface SchemaDraft {
  name: string;
  singularName: string;
  kind: CollectionKind;
  hasBody: boolean;
  detail: boolean;
  archive: boolean;
  route: string;
  fields: FieldRow[];
  taxonomies: TaxonomyRow[];
}

export function schemaDraftOf(collection: Collection): SchemaDraft {
  const s = collection.settings;
  return {
    name: s.name,
    singularName: typeof s.singularName === 'string' ? s.singularName : '',
    kind: collectionKind(s),
    hasBody: collectionHasBody(s),
    detail: hasDetailPages(s),
    archive: hasArchivePages(s),
    route: typeof s.route === 'string' ? s.route : `/${s.id}/`,
    fields: Object.entries(s.fields ?? {}).map(([name, schema]) => ({ name, schema: structuredClone(schema) })),
    taxonomies: Object.entries(s.taxonomies ?? {}).map(([id, t]) => ({ id, label: t.label }))
  };
}

const RESERVED_FIELD_NAMES = new Set(['variant', 'class', 'className', 'children', 'item', 'props', 'has', 'id', 'page', 'default', 'delete', 'new', 'this', 'null', 'true', 'false', 'undefined']);

/** A camelCase field name for a label, free among `taken` (numbered while it is not). */
export function fieldNameFor(label: string, taken: Iterable<string>): string {
  const words = slugify(label)
    .split('-')
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  let stem = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
  if (!/^[a-z]/.test(stem)) stem = `field${stem ? stem[0].toUpperCase() + stem.slice(1) : ''}`;
  stem = stem.slice(0, 36);
  if (RESERVED_FIELD_NAMES.has(stem) || /^item\d*$/.test(stem)) stem = `${stem}Field`;
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let n = 2; ; n++) if (!used.has(`${stem}${n}`)) return `${stem}${n}`;
}

/** A grouping ID for a label, free among `taken`. */
export function taxonomyIdFor(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = slugify(label).replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 50) || 'grouping';
  const id = isTermId(stem) ? stem : 'grouping';
  if (!used.has(id)) return id;
  for (let n = 2; ; n++) if (!used.has(`${id}-${n}`)) return `${id}-${n}`;
}

/**
 * A new field of a kind, as the dialog first shows it. A choice starts with two options to rename; a reference names
 * entries of the collection itself until another is chosen.
 */
export function newFieldSchema(type: CollectionFieldType, label: string, collectionId: string): CollectionFieldSchema {
  switch (type) {
    case 'string':
      return { type, label, default: '' };
    case 'richtext':
      return { type, label, default: [] };
    case 'number':
      return { type, label, default: 0 };
    case 'boolean':
      return { type, label, default: false };
    case 'enum':
      return {
        type,
        label,
        default: 'first',
        options: [
          { value: 'first', label: 'First' },
          { value: 'second', label: 'Second' }
        ]
      };
    case 'image':
      return { type, label, default: { assetId: null, alt: '' } };
    case 'link':
      return { type, label, default: { type: 'none', target: '' } };
    case 'date':
      return { type, label, default: '' };
    case 'reference':
      return { type, label, collection: collectionId, default: '' };
  }
}

/** A field changed to another kind: its label and description stay, the rest starts as a new field of that kind. */
export function retypeField(schema: CollectionFieldSchema, type: CollectionFieldType, collectionId: string): CollectionFieldSchema {
  if (schema.type === type) return schema;
  const next = newFieldSchema(type, schema.label, collectionId);
  return schema.description ? { ...next, description: schema.description } : next;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The one collection.update that saves the dialog's draft: only what changed, so a field or grouping the author left
 * alone is never sent (and the engine never refuses it). Null when nothing changed.
 */
export function schemaUpdateOp(collection: Collection, draft: SchemaDraft): Extract<EditOperation, { type: 'collection.update' }> | null {
  const s = collection.settings;
  const was = schemaDraftOf(collection);
  const op: Extract<EditOperation, { type: 'collection.update' }> = { type: 'collection.update', collectionId: s.id };
  const name = draft.name.trim();
  if (name && name !== s.name) op.name = name;
  const singular = draft.singularName.trim();
  if (singular !== was.singularName) op.singularName = singular || null;
  if (draft.kind !== was.kind) op.kind = draft.kind;
  if (draft.hasBody !== was.hasBody) op.hasBody = draft.hasBody;
  // An archive lists links to entry pages: without them, there is none.
  const archive = draft.detail && draft.archive;
  if (draft.detail !== was.detail || archive !== was.archive) op.pages = { detail: draft.detail, archive };
  const route = normalizePrefix(draft.route);
  if (draft.detail && route !== (typeof s.route === 'string' ? s.route : undefined)) op.route = route;
  const fields: Record<string, CollectionFieldSchema> = Object.fromEntries(draft.fields.map((f) => [f.name, f.schema]));
  if (!same(fields, s.fields ?? {})) op.fields = fields as unknown as Record<string, Record<string, unknown>>;
  const own = s.taxonomies ?? {};
  const taxonomies: Record<string, { label: string; terms?: Record<string, { label: string }> }> = Object.fromEntries(
    draft.taxonomies.map((t) => [t.id, { label: t.label.trim() || t.id, terms: Object.hasOwn(own, t.id) ? structuredClone(own[t.id].terms) : {} }])
  );
  if (!same(taxonomies, Object.fromEntries(Object.entries(own).map(([id, t]) => [id, { label: t.label, terms: t.terms }])))) op.taxonomies = taxonomies;
  return Object.keys(op).length > 2 ? op : null;
}

/** An address prefix as typed ("team", "/our-team") written as one ("/our-team/"). */
export function normalizePrefix(route: string): string {
  const t = route.trim().replace(/^\/+|\/+$/g, '');
  return t ? `/${t}/` : '/';
}

/** What removing a field or grouping in the dialog will take from the entries, said before it is saved. */
export function schemaLosses(collection: Collection, draft: SchemaDraft): string[] {
  const out: string[] = [];
  const entries = Object.values(collection.entries);
  const kept = new Set(draft.fields.map((f) => f.name));
  for (const [name, schema] of Object.entries(collection.settings.fields ?? {})) {
    if (kept.has(name)) continue;
    const n = entries.filter((e) => e.values && Object.hasOwn(e.values, name)).length;
    if (n) out.push(`${schema.label}: the value ${n === 1 ? 'one entry has' : `${n} entries have`}`);
  }
  const groups = new Set(draft.taxonomies.map((t) => t.id));
  for (const [id, t] of Object.entries(collection.settings.taxonomies ?? {})) {
    if (groups.has(id)) continue;
    const n = entries.filter((e) => Array.isArray(e.terms?.[id]) && e.terms[id].length).length;
    if (n || Object.keys(t.terms ?? {}).length) out.push(`${t.label}: its terms${n ? `, and ${n === 1 ? 'one entry' : `${n} entries`} filed under them` : ''}`);
  }
  return out;
}
