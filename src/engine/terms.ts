/**
 * A collection's categories and tags managed one term at a time (#396): a term added under a name, renamed with every
 * entry filed under it staying filed under it, and deleted from every entry it was on. A term's ID is its address in
 * its archive (`/blog/category/<ID>/`), so a new name brings a new ID.
 *
 * Lists of entries choose their entries by a term's ID or its name (see shared/entry-feed.ts), so each change is
 * checked against every list wherever it renders: each one must list the same entries afterwards. A choice stored as
 * words is rewritten to keep doing so, by the terms' IDs; one that cannot be (read from an entry, or in code that is
 * not the project's) refuses the change, saying where it is.
 */
import type { Collection, CollectionTaxonomy, CollectionTerm, ComponentDefinition, GraphNode, InstanceNode, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { isBindingRef, isEntryBinding } from '@shared/types';
import type { Op } from '@shared/ops';
import { assignedTermIds, entriesWithTerm, isTermId, termIdFor } from '@shared/collections';
import { codeEntryQueries, entryQuery, entryQueryKey, feedCollection, listsEntries, termsNamed, type EntryQuery } from '@shared/entry-feed';
import { allTrees, displayName, fail } from './tree';
import { normalizeScalar } from './values';
import { defFile } from '@generator/index';
import { MAX_TAXONOMIES, MAX_TERMS, getCollection } from './collections';

type OpResult = Record<string, unknown>;

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The groupings the Posts panel manages, added under these names to a collection that lacks them. */
const STANDARD_TAXONOMIES: Record<string, string> = { categories: 'Categories', tags: 'Tags' };
/** The entry feed properties that choose entries by a grouping's terms, and the grouping each reads (see shared/entry-feed.ts). */
const FEED_PROPS = { category: 'categories', tag: 'tags' } as const;
type FeedProp = keyof typeof FEED_PROPS;
const FEED_PROP_NAMES = Object.keys(FEED_PROPS) as FeedProp[];
/** The grouping whose terms an entry field lists, as a layout binds it ("categories", "terms.tags"). */
const termField = (field: string): string | undefined => (field === 'categories' ? 'categories' : field.startsWith('terms.') ? field.slice(6) : undefined);
const MAX_LABEL = 80;

function taxonomyOf(c: Collection, taxonomyId: string): CollectionTaxonomy {
  return own(c.settings.taxonomies, taxonomyId) ?? fail(`The ${c.settings.name} collection has no grouping "${taxonomyId.slice(0, 60)}".`);
}

function termOf(t: CollectionTaxonomy, termId: string): CollectionTerm {
  return own(t.terms, termId) ?? fail(`${t.label} has no term "${termId.slice(0, 60)}".`);
}

/**
 * A term's name as stored: trimmed, and one no other term of the grouping has (ignoring case), as readers tell them
 * apart. Never with a comma: a list of posts reads a post's terms as their names between commas ("News, Craft"),
 * which a name with commas of its own could be taken for.
 */
function checkLabel(t: CollectionTaxonomy, raw: string, except?: string): string {
  const label = raw.trim();
  if (!label) fail(`${t.label}: every term needs a name.`);
  if (label.length > MAX_LABEL) fail(`${t.label}: a term's name can be at most ${MAX_LABEL} characters.`);
  if (label.includes(',')) fail(`${t.label}: a term's name can't have a comma in it. Lists of posts read commas as between names.`);
  const clash = Object.entries(t.terms).find(([id, x]) => id !== except && typeof x?.label === 'string' && x.label.trim().toLowerCase() === label.toLowerCase());
  if (clash) fail(`${t.label}: there is already a term called “${clash[1].label}”.`);
  return label;
}

/**
 * The ID a term takes: the one asked for while it is free, else a slug of its name (see termIdFor). Never one entries
 * are still filed under without a term (written by hand): the term would gather those entries up.
 */
function idFor(c: Collection, taxonomyId: string, t: CollectionTaxonomy, label: string, wanted: string | undefined, except?: string): string {
  const stale = assignedTermIds(c, taxonomyId);
  if (wanted === undefined) return termIdFor(t.terms, label, except, stale);
  if (!isTermId(wanted)) fail(`${t.label}: "${wanted.slice(0, 60)}" is not a term ID: use lowercase letters, numbers and hyphens.`);
  if (wanted !== except && Object.hasOwn(t.terms, wanted)) fail(`${t.label}: another term already has the ID "${wanted}".`);
  if (wanted !== except && stale.has(wanted)) fail(`${t.label}: entries are still filed under "${wanted}", a term no longer in the list. Choose another ID.`);
  return wanted;
}

/** One place a list renders: the collection whose entries it reads there, and the words that choose them by a grouping's terms. */
interface Reading {
  collectionId: string | undefined;
  taxonomyId: string;
  words: string;
}

/** A choice stored as words, which a change may rewrite. */
interface Stored {
  words(): string;
  store(words: string): void;
  /** The property it is, which the words must suit (a choice of options, a longest length). */
  schema?: PropSchema;
  /** A placement reading its design's default: storing makes the choice its own. */
  inherited?: boolean;
}

/** Somewhere a list of entries chooses entries by terms. */
interface FeedUse {
  where: string;
  /** Each place it renders, read from the project as it is now. */
  readings(): Reading[];
  stored?: Stored;
  /** A design's default, settled before the placements that read it. */
  isDefault?: boolean;
  /**
   * A choice read where the list renders (from each entry, from the design's own property), which this file cannot
   * read: whether a change to a term of `taxonomyId` in `collectionId` might change it. Such a change is refused.
   */
  blocks?: (collectionId: string, taxonomyId: string) => boolean;
}

/**
 * Where each design renders: the collections whose layouts place it (directly or inside other designs), and "" for
 * anywhere else (a page, the shared header and footer). A design no tree places (unused, or imported by code) may
 * render anywhere: every collection's layout and a page.
 */
function designPlaces(state: ProjectState): (defId: string) => string[] {
  const out = new Map<string, Set<string>>();
  const add = (id: string, place: string) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = new Set()));
    if (s.has(place)) return false;
    s.add(place);
    return true;
  };
  const placed = (nodes: Record<string, GraphNode> | undefined) => Object.values(nodes ?? {}).flatMap((n) => (n?.kind === 'instance' ? [n.definitionId] : []));
  for (const { owner, tree } of allTrees(state)) {
    if (owner.kind === 'component') continue;
    for (const id of placed(tree.nodes)) add(id, owner.kind === 'template' ? owner.id : '');
  }
  // What each design renders inside it: the designs its tree places, and, for code, those it imports by file name.
  const designs = Object.values(state.components ?? {});
  const files = designs.map((d) => ({ id: d.id, file: `/${defFile(d).split('/').pop()}` }));
  const inside = new Map(
    designs.map((d) => [d.id, [...placed(d.tree?.nodes), ...(typeof d.source === 'string' ? files.filter((f) => f.id !== d.id && d.source!.includes(f.file)).map((f) => f.id) : [])]])
  );
  for (let changed = true, rounds = 0; changed && rounds <= designs.length; rounds++) {
    changed = false;
    for (const d of designs) for (const place of [...(out.get(d.id) ?? [])]) for (const id of inside.get(d.id) ?? []) changed = add(id, place) || changed;
  }
  const anywhere = ['', ...Object.keys(state.collections ?? {}).sort()];
  return (defId) => {
    const s = out.get(defId);
    return s && s.size ? [...s].sort() : anywhere;
  };
}

const at = (place: string) => (place ? { entry: { collectionId: place, entryId: '' } } : {});

/**
 * Every place that chooses entries by terms, with each place it renders: a placement on a page, in a layout or inside
 * a design (wherever the design is placed); a design's default; and code converted from a design. A layout's list of
 * each entry's own terms (related posts) follows what the entry is filed under, so nothing here watches it.
 */
function feedUses(state: ProjectState): FeedUse[] {
  const placesOf = designPlaces(state);
  const collections = Object.keys(state.collections ?? {}).sort();
  const out: FeedUse[] = [];
  for (const { owner, tree, label } of allTrees(state)) {
    for (const n of Object.values(tree.nodes ?? {})) {
      if (n?.kind !== 'instance') continue;
      const def = own(state.components, n.definitionId);
      if (!def || !listsEntries(def)) continue;
      const where = `“${displayName(state, n)}” in ${label}`;
      const layout = owner.kind === 'template' ? owner.id : undefined;
      const contexts = layout ? [layout] : owner.kind === 'component' ? placesOf(owner.id) : [''];
      const collectionChoice = own(n.props, 'collection');
      // Only a layout reads a property from each entry; the site reads any other bound choice as unset, the design's
      // default deciding (see entryQuery), as this file reads it too.
      const fromEntry = (v: unknown) => !!layout && isEntryBinding(v);
      // A collection read from each entry may be any of them.
      const read = (): string[] => {
        if (fromEntry(collectionChoice)) return collections;
        const query = entryQuery(def.properties, n.props ?? {});
        return [...new Set(contexts.flatMap((place) => feedCollection(state, query, at(place))?.settings.id ?? []))];
      };
      /** Whether a binding reads the labels of a grouping's terms of the layout's entries ("categories", "terms.tags"). */
      const readsLabels = (v: unknown, collectionId: string, taxonomyId: string) => !!layout && collectionId === layout && isEntryBinding(v) && termField(v.$entry) === taxonomyId;
      // A collection read from the entry's terms may become another collection when one of them is renamed. (A choice of
      // terms stored beside it is read in every collection below.)
      if (fromEntry(collectionChoice)) out.push({ where, readings: () => [], blocks: (collectionId, taxonomyId) => readsLabels(collectionChoice, collectionId, taxonomyId) });
      for (const prop of FEED_PROP_NAMES) {
        const taxonomyId = FEED_PROPS[prop];
        const v = own(n.props, prop);
        if (fromEntry(v)) {
          // Each entry's own terms of this grouping, in its own collection's layout: it follows them.
          if (readsLabels(v, layout ?? '', taxonomyId) && !fromEntry(collectionChoice) && read().every((c) => c === layout)) continue;
          out.push({ where, readings: () => [], blocks: (collectionId, changed) => (changed === taxonomyId && read().includes(collectionId)) || readsLabels(v, collectionId, changed) });
          continue;
        }
        // Bound to anything else, it reads its design's default, which it cannot be given words over.
        const bound = isBindingRef(v);
        if (v !== undefined && typeof v !== 'string' && !bound) continue;
        out.push({
          where,
          stored: bound ? undefined : placementChoice(n, def, prop),
          readings: () => {
            const words = entryQuery(def.properties, n.props ?? {})[prop];
            return read().map((collectionId) => ({ collectionId, taxonomyId, words }));
          }
        });
      }
    }
  }
  for (const def of Object.values(state.components ?? {})) {
    if (listsEntries(def)) {
      for (const prop of FEED_PROP_NAMES) {
        const schema = own(def.properties, prop) as (PropSchema & { default?: unknown }) | undefined;
        if (typeof schema?.default !== 'string' || !schema.default.trim()) continue;
        out.push({
          where: `the default of “${def.name}”`,
          isDefault: true,
          stored: { words: () => String(schema.default ?? ''), store: (w) => (schema.default = w), schema },
          readings: () => [{ collectionId: feedCollection(state, entryQuery(def.properties, {}))?.settings.id, taxonomyId: FEED_PROPS[prop], words: String(schema.default ?? '') }]
        });
      }
    }
    if (typeof def.source === 'string' && def.source.includes('so_pages')) out.push(...codeUses(state, def, placesOf(def.id)));
  }
  return out;
}

/** A placement's choice as words: its own, or its design's default while it has none. */
function placementChoice(n: InstanceNode, def: ComponentDefinition, prop: FeedProp): Stored {
  return {
    inherited: own(n.props, prop) === undefined,
    schema: own(def.properties, prop),
    words: () => entryQuery(def.properties, n.props ?? {})[prop],
    store: (w) => ((n.props ??= {})[prop] = w)
  };
}

/**
 * The feeds code converted from a design reads, by the keys its source names. The project's own code is rewritten
 * with new keys when its choices must change, every key in one pass once all are settled (see `writeCode`), so the
 * rows the site hands it follow; other code, and a key the code also names some other way, are never changed.
 */
function codeUses(state: ProjectState, def: ComponentDefinition, contexts: string[]): FeedUse[] {
  const out: FeedUse[] = [];
  const seen = new Set<string>();
  for (const q of codeEntryQueries(def.source!)) {
    if (seen.has(q.raw)) continue;
    seen.add(q.raw);
    // Shared by the key's category and tag: a rewrite of one is the key the other is then read from.
    const read: { query: EntryQuery } = { query: q.query };
    // A key the code also names some other way (kept in a variable, quoted in a comment) is not rewritten: that use
    // would be left reading a key the site no longer hands it rows for.
    const literal = q.raw.slice('so_pages?.entries?.['.length, -1);
    const alone = def.source!.split(literal).length === def.source!.split(q.raw).length;
    for (const prop of FEED_PROP_NAMES) {
      if (!read.query[prop]) continue;
      const stored: Stored | undefined =
        def.owner === 'project' && alone
          ? {
              words: () => read.query[prop],
              store: (w) => {
                read.query = { ...read.query, [prop]: w };
                const keys = rewrittenKeys.get(def) ?? new Map<string, string>();
                // Escaped as the generator writes a literal, so no text in a key can end the script early.
                keys.set(q.raw, `so_pages?.entries?.[${JSON.stringify(entryQueryKey(read.query, q.max)).replace(/</g, '\\u003c')}]`);
                rewrittenKeys.set(def, keys);
              }
            }
          : undefined;
      out.push({ where: `the code of “${def.name}”`, stored, readings: () => contexts.map((place) => ({ collectionId: feedCollection(state, read.query, at(place))?.settings.id, taxonomyId: FEED_PROPS[prop], words: read.query[prop] })) });
    }
  }
  return out;
}

/** The new key for each key a design's code reads that a change rewrote, by the read as its source spells it. */
const rewrittenKeys = new Map<ComponentDefinition, Map<string, string>>();

/** Write each rewritten key into its code, all of a design's at once, so one rewrite never lands on another's key. */
function writeCode() {
  for (const [def, keys] of rewrittenKeys) {
    def.source = def.source!.replace(CODE_KEY, (m) => keys.get(m) ?? m);
  }
  rewrittenKeys.clear();
}
const CODE_KEY = /so_pages\?\.entries\?\.\[("(?:[^"\\]|\\.)*")\]/g;

/** What a reading lists: every entry (no choice), or those with any of the terms its words name (none, for words no term has). */
function listed(state: ProjectState, r: Reading): string {
  if (!r.words.trim()) return '*';
  const c = r.collectionId === undefined ? undefined : own(state.collections, r.collectionId);
  return c ? JSON.stringify(termsNamed(c, r.taxonomyId, r.words).sort()) : '-';
}

interface Planned {
  use: FeedUse;
  /** What each reading lists now, as it must after the change. */
  expected: string[];
  /** For each reading of the changed grouping, the terms it names by their IDs after the change; null for any other. */
  ids: Array<string[] | null>;
  /** The stored choice's words before the change. */
  words?: string;
  /** Each place it rendered before the change. */
  before: Reading[];
}

/** What every use lists at each place before a change (`renamed`: the ID each term has after it). */
function plan(state: ProjectState, uses: FeedUse[], collectionId: string, taxonomyId: string, renamed: (id: string) => string): Planned[] {
  const c = own(state.collections, collectionId)!;
  return uses.map((use) => {
    const readings = use.readings();
    const ids = readings.map((r) => (r.collectionId === collectionId && r.taxonomyId === taxonomyId && r.words.trim() ? termsNamed(c, taxonomyId, r.words).map(renamed) : null));
    const expected = readings.map((r, i) => (ids[i] ? JSON.stringify([...ids[i]!].sort()) : listed(state, r)));
    return { use, expected, ids, words: use.stored?.words(), before: readings };
  });
}

/** Whether a property takes these words as they are. */
function suits(state: ProjectState, schema: PropSchema | undefined, words: string): boolean {
  if (!schema || schema.type === 'string') return words.length <= ((schema as { maxLength?: number } | undefined)?.maxLength ?? 2000);
  if (schema.type === 'list' || schema.type === 'table' || schema.type === 'object') return false;
  try {
    return normalizeScalar(schema as ScalarPropSchema, words, state, 'choice') === words;
  } catch {
    return false;
  }
}

/**
 * After a change to a term of `taxonomyId` in `collectionId`, keeps every list listing what it listed. A choice stored
 * as words is rewritten: to its old words, by a placement whose design's default the change rewrote while it reads
 * another collection too, or to the terms it named, by ID. One that cannot be (or `rewrite` false), or one this file
 * cannot read that the change may reach, refuses the change. `capture`: words that named none of this collection's
 * terms may name one now (a new term, which nothing is filed under yet, called what a list was already told to show).
 * Returns how many choices were rewritten.
 */
function keepLists(
  state: ProjectState,
  planned: Planned[],
  target: { collectionId: string; taxonomyId: string },
  refuse: (where: string, words: string) => never,
  { rewrite = true, capture = false, unread = true } = {}
): number {
  let rewritten = 0;
  rewrittenKeys.clear();
  /** The first place a use no longer lists what it did, as it read before the change. */
  const differs = (p: Planned) => {
    const now = p.use.readings();
    const i =
      now.length !== p.expected.length
        ? 0
        : now.findIndex((r, i) => listed(state, r) !== p.expected[i] && !(capture && p.expected[i] === '[]' && p.before[i]?.collectionId === target.collectionId));
    return i < 0 ? undefined : (p.before[i] ?? now[i]);
  };
  // Designs' defaults first: the placements reading them are then checked with the new words.
  for (const p of [...planned.filter((x) => x.use.isDefault), ...planned.filter((x) => !x.use.isDefault)]) {
    if (p.use.blocks) {
      if (unread && p.use.blocks(target.collectionId, target.taxonomyId)) refuse(p.use.where, '');
      continue;
    }
    const s = p.use.stored;
    // Words read from a default that changed, where the placement also reads a collection whose terms did not.
    const lost = !!s?.inherited && p.words !== undefined && s.words() !== p.words && p.ids.some((x, i) => x === null && p.expected[i] !== '*');
    if (!lost && !differs(p)) continue;
    const ids = p.ids.find((x) => x?.length);
    const candidates = [...new Set([...(s?.inherited && p.words ? [p.words] : []), ...(ids ? [ids.join(', ')] : [])])];
    if (rewrite && s && candidates.some((w) => suits(state, s.schema, w) && (s.store(w), !differs(p)))) {
      rewritten++;
      continue;
    }
    const r = differs(p) ?? p.before[0];
    refuse(p.use.where, r?.words ?? '');
  }
  writeCode();
  return rewritten;
}

/** What a refusal says of a list: the words it chooses by, or that it reads its choice where it renders. */
const choosing = (words: string) => (words.trim() ? `lists entries by “${words.trim().slice(0, 80)}”` : 'reads its choice of entries where it is shown');

export function termCreate(state: ProjectState, op: Op<'collection.createTerm'>): OpResult {
  const c = getCollection(state, op.collectionId);
  if (!c.settings.taxonomies || typeof c.settings.taxonomies !== 'object') c.settings.taxonomies = {};
  let t = own(c.settings.taxonomies, op.taxonomyId);
  if (!t) {
    const name = own(STANDARD_TAXONOMIES, op.taxonomyId) ?? fail(`The ${c.settings.name} collection has no grouping "${op.taxonomyId.slice(0, 60)}".`);
    if (Object.keys(c.settings.taxonomies).length >= MAX_TAXONOMIES) fail(`A collection can have at most ${MAX_TAXONOMIES} groupings.`);
    t = c.settings.taxonomies[op.taxonomyId] = { label: name, terms: {} };
  }
  if (Object.keys(t.terms).length >= MAX_TERMS) fail(`${t.label} can have at most ${MAX_TERMS} terms.`);
  const label = checkLabel(t, op.label);
  const termId = idFor(c, op.taxonomyId, t, label, op.termId);
  // A new term's ID or name may be what a list's words already name another term by: that list keeps its term. A
  // choice read where the list renders is left to it: nothing is filed under the new term yet.
  const target = { collectionId: c.settings.id, taxonomyId: op.taxonomyId };
  const planned = plan(state, feedUses(state), target.collectionId, target.taxonomyId, (id) => id);
  t.terms[termId] = { label };
  keepLists(state, planned, target, (where, words) => fail(`${where} ${choosing(words)}, which a term called “${label}” would change. Change that choice first.`), { capture: true, unread: false });
  return { collectionId: c.settings.id, taxonomyId: op.taxonomyId, termId };
}

export function termRename(state: ProjectState, op: Op<'collection.renameTerm'>): OpResult {
  const c = getCollection(state, op.collectionId);
  const t = taxonomyOf(c, op.taxonomyId);
  const term = termOf(t, op.termId);
  const label = checkLabel(t, op.label, op.termId);
  const termId = idFor(c, op.taxonomyId, t, label, op.newTermId, op.termId);
  const affectedPosts = entriesWithTerm(c, op.taxonomyId, op.termId).length;
  const result = { collectionId: c.settings.id, taxonomyId: op.taxonomyId, termId, previousTermId: op.termId, affectedPosts };
  if (label === term.label && termId === op.termId) return { ...result, feeds: 0 };
  // Every list is read before anything changes: what each one lists now is what it must list after.
  const target = { collectionId: c.settings.id, taxonomyId: op.taxonomyId };
  const planned = plan(state, feedUses(state), target.collectionId, target.taxonomyId, (id) => (id === op.termId ? termId : id));
  // The term keeps its place among the others, which is the order they are offered in.
  t.terms = Object.fromEntries(Object.entries(t.terms).map(([id, x]) => (id === op.termId ? [termId, { ...x, label }] : [id, x])));
  if (termId !== op.termId) {
    for (const e of Object.values(c.entries)) {
      const ids = own(e.terms, op.taxonomyId);
      if (Array.isArray(ids) && ids.includes(op.termId)) e.terms[op.taxonomyId] = [...new Set(ids.map((id) => (id === op.termId ? termId : id)))];
    }
  }
  const feeds = keepLists(state, planned, target, (where, words) => fail(`${where} ${choosing(words)}, which renaming “${term.label}” would change, and it can't be rewritten here. Change that choice before renaming it.`));
  return { ...result, feeds };
}

/** The places that list entries by the term in its collection (or may, reading their choice where they are shown), which deleting it would change. */
export function termFeedUses(state: ProjectState, collectionId: string, taxonomyId: string, termId: string): Array<{ where: string }> {
  const c = own(state.collections, collectionId);
  if (!c) return [];
  const out = new Set<string>();
  for (const u of feedUses(state)) {
    if (u.blocks?.(collectionId, taxonomyId)) out.add(u.where);
    for (const r of u.readings()) if (r.collectionId === collectionId && r.taxonomyId === taxonomyId && r.words.trim() && termsNamed(c, taxonomyId, r.words).includes(termId)) out.add(u.where);
  }
  return [...out].map((where) => ({ where }));
}

/** A list of places as a sentence: “A”, “A and B”, “A, B and 3 more”. */
function places(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function termRemove(state: ProjectState, op: Op<'collection.removeTerm'>): OpResult {
  const c = getCollection(state, op.collectionId);
  const t = taxonomyOf(c, op.taxonomyId);
  const term = termOf(t, op.termId);
  // A list that chooses the term would list nothing (or, with its choice cleared, everything): the author decides.
  const uses = termFeedUses(state, c.settings.id, op.taxonomyId, op.termId);
  if (uses.length) fail(`${places(uses.map((u) => u.where))} ${uses.length === 1 ? 'lists' : 'list'} entries by “${term.label}”. Choose something else there before deleting it.`);
  // Every other list must list what it did (a name that named it alone among others may now name another term).
  const target = { collectionId: c.settings.id, taxonomyId: op.taxonomyId };
  const planned = plan(state, feedUses(state), target.collectionId, target.taxonomyId, (id) => id);
  const affected = entriesWithTerm(c, op.taxonomyId, op.termId);
  for (const e of affected) {
    const ids = e.terms[op.taxonomyId].filter((id) => id !== op.termId);
    if (ids.length) e.terms[op.taxonomyId] = ids;
    else delete e.terms[op.taxonomyId];
  }
  delete t.terms[op.termId];
  keepLists(state, planned, target, (where, words) => fail(`${where} ${choosing(words)}, which deleting “${term.label}” would change. Choose something else there first.`), { rewrite: false });
  return { collectionId: c.settings.id, taxonomyId: op.taxonomyId, termId: op.termId, affectedPosts: affected.length };
}
