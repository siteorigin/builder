/**
 * Collection loops in a generated file (#677): a repeat over a collection query (`{ $query }`), or over the entries an
 * archive page lists (`{ $archive: true }`), written as a plain `{#each}` over rows that the file holds. Before a tree
 * is written, every place inside a loop that reads an entry field (`{ $item: field }`) is given a key of its own, and
 * each row holds, under that key, the value that place shows for its entry, in the form the place takes: a date
 * written out for reading, and as YYYY-MM-DD for a `<time>`; a picture; a link to the entry's page; rich text. A
 * condition on an entry field is decided once per row, so the row says whether it holds. The tree keeps its node IDs,
 * so the editor's preview selects an element in any row as it does in a component's list. Nothing reads a
 * collection in the visitor's browser.
 */
import type { Collection, ComponentDefinition, Condition, EntryDoc, GraphNode, InstanceNode, ListProp, NodeTree, ProjectState, PropSchema, RepeatNode } from '@shared/types';
import { conditionHolds, conditionRef, isBinding, isBindingRef, isCollectionLoop } from '@shared/types';
import { ENTRY_CONTENT_FIELDS, entryValuePresent, isEntryDateField } from '@shared/entry-fields';
import { CURRENT_COLLECTION, queryCollection, type QueryPlace } from '@shared/collection-query';
import { connectedItems, normalizeConnection, projectField, rowFieldSchema, rowFieldValue } from '@shared/collection-rows';
import { queriedEntries } from './collection-query';
import { emptyFor } from './entry-template';
import { resolveValue, type ResolveContext } from './index';

/** The rows of one loop, and the list they are items of, whose fields name each place's key, with the entries they show. */
export interface LoopRows {
  rows: Array<Record<string, unknown>>;
  schema: ListProp;
  collection?: Collection;
  entries: EntryDoc[];
}

/** Where a tree with loops is written: an entry's page, an archive page (the entries it lists), or anywhere else. */
export interface LoopPlace {
  entry?: { collectionId: string; entryId: string };
  archive?: { collectionId: string; entryIds: readonly string[] };
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The places of an element that can show an entry's field, as the element takes each. */
const CONTENT = ['text', 'datetime', 'image', 'fallbackAlt', 'link', 'label', 'ariaLabel'] as const;
/** The places that are the layout's own, the same in every row: one bound to an entry falls back to an empty value. */
const STRUCTURE = ['tag', 'action', 'appearance', 'icon', 'iconPosition'] as const;

/** The item field a place reads, or undefined when it reads none. */
const itemField = (v: unknown): string | undefined => (isBinding(v) && '$item' in v && typeof v.$item === 'string' ? v.$item : undefined);

/** The query place of a tree written for `place`: an archive page's queries read its collection as `$current`. */
function queryPlace(place: LoopPlace): QueryPlace {
  return place.entry ? { entry: place.entry } : place.archive ? { entry: { collectionId: place.archive.collectionId, entryId: '' } } : {};
}

/**
 * A placement's items for one list property connected to a collection (`listSources`): the entries its query finds
 * where it is written, each as an item, at most as many as the list takes. Undefined while the list is not connected
 * (or its connection cannot be read, as validation reports): the placement's own items show.
 */
export function connectedListItems(state: ProjectState, def: ComponentDefinition, node: Pick<InstanceNode, 'listSources'>, prop: string, place: LoopPlace = {}): Array<Record<string, unknown>> | undefined {
  return connectedList(state, def, node, prop, place)?.items;
}

/**
 * A connected list as connectedListItems reads it, with the collection and the entries its items show, one for each
 * item in order, and whether visitors browse them.
 */
export function connectedList(state: ProjectState, def: ComponentDefinition, node: Pick<InstanceNode, 'listSources'>, prop: string, place: LoopPlace = {}): { items: Array<Record<string, unknown>>; collection?: Collection; entries: EntryDoc[]; browse: boolean } | undefined {
  const raw = own(node.listSources, prop);
  if (raw === undefined) return undefined;
  const schema = own(def.properties, prop);
  const connection = normalizeConnection(raw);
  if (schema?.type !== 'list' || !connection) return undefined;
  const here = queryPlace(place);
  const collection = queryCollection(state, connection.query, here);
  const found = collection ? queriedEntries(state, connection.query, here) : [];
  const max = typeof schema.max === 'number' && Number.isInteger(schema.max) && schema.max >= 0 ? schema.max : undefined;
  const entries = max === undefined ? found : found.slice(0, max);
  return { items: connectedItems(state, schema.fields, connection, collection, entries), collection, entries, browse: connection.browse === true };
}

/** The collection and entries a loop shows where it is written. */
export function loopEntries(state: ProjectState, node: Pick<RepeatNode, 'list'>, place: LoopPlace): { collection?: Collection; entries: EntryDoc[] } {
  const list = node.list as Record<string, unknown>;
  if (Object.hasOwn(list, '$archive')) {
    const a = place.archive;
    const collection = a ? own(state.collections, a.collectionId) : undefined;
    if (!collection) return { entries: [] };
    return { collection, entries: a!.entryIds.flatMap((id) => (Object.hasOwn(collection.entries, id) ? [collection.entries[id]] : [])) };
  }
  // A query on an archive page reads its collection as the one whose pages they are.
  const here = queryPlace(place);
  const query = list.$query as { collectionId?: unknown } | undefined;
  const collection = query ? queryCollection(state, { collectionId: typeof query.collectionId === 'string' ? query.collectionId : '' }, here) : undefined;
  if (!collection) return { entries: [] };
  return { collection, entries: queriedEntries(state, query, here) };
}

/** The schema of the value a place takes, for the list whose rows hold it. */
function placeSchema(node: GraphNode, field: (typeof CONTENT)[number]): PropSchema {
  if (field === 'image') return { type: 'image', label: 'Image', default: { assetId: null, alt: '' } };
  if (field === 'link') return { type: 'link', label: 'Link', default: { type: 'none', target: '' } };
  if (field === 'text' && node.kind === 'text' && node.rich) return { type: 'richtext', label: 'Text', default: [] };
  return { type: 'string', label: field, default: '' };
}

/**
 * A tree ready to write: each collection loop's places keyed and its rows worked out, with the tree they key. The
 * tree is the one given when it has no loop; otherwise a copy, which keeps every node ID.
 */
export function prepareLoops(state: ProjectState, tree: NodeTree, rctx: ResolveContext, inDesign = false): { tree: NodeTree; loops: Map<string, LoopRows> } {
  const place: LoopPlace = { ...(rctx.entry ? { entry: rctx.entry } : {}), ...(rctx.archive ? { archive: rctx.archive } : {}) };
  const loops = new Map<string, LoopRows>();
  const nodes = tree.nodes && typeof tree.nodes === 'object' ? tree.nodes : {};
  if (!Object.values(nodes).some((n) => isCollectionLoop(n as GraphNode))) return { tree, loops };
  // Copied through plain reads: in a cached run the documents are views that record what is read (see ./cache), which
  // structuredClone cannot copy. Documents are JSON, so nothing is lost.
  const copy: Record<string, GraphNode> = JSON.parse(JSON.stringify(nodes));
  for (const loop of Object.values(copy)) {
    if (!isCollectionLoop(loop) || loop.kind !== 'repeat') continue;
    const { collection, entries } = loopEntries(state, loop, place);
    const fields: Record<string, PropSchema> = {};
    /** How each key's value is read for one entry. */
    const readers: Array<[string, (entry: EntryDoc) => unknown]> = [];
    // Each place's key is its place in the loop (`f0`, `f1`...): the site's rows name no editor node.
    const keyed = (_place: string, schema: PropSchema, read: (entry: EntryDoc) => unknown) => {
      const key = `f${readers.length}`;
      fields[key] = schema;
      readers.push([key, read]);
      return { $item: key };
    };
    // Every node the loop repeats, down to (not into) a repeat inside it, which has items of its own.
    const seen = new Set<string>();
    const visit = (id: string) => {
      const n = own(copy, id);
      if (!n || seen.has(id)) return;
      seen.add(id);
      const r = n as unknown as Record<string, unknown>;
      for (const key of ['when', 'unless'] as const) {
        const c = r[key];
        if (c === undefined) continue;
        const ref = conditionRef(c);
        const field = itemField(ref);
        // A design's own property or UI state decides it as anywhere in the design.
        if (field === undefined && inDesign) continue;
        // Inside a loop a condition reads an entry field; anything else (a page has no properties) always holds.
        if (field === undefined || !collection || !rowFieldSchema(collection, field)) {
          delete r[key];
          continue;
        }
        r[key] = { ref: keyed(`${n.id}|${key}`, { type: 'boolean', label: key, default: false }, (e) => conditionHolds(c as Condition, rowFieldValue(state, collection, e, field, 'raw'), entryValuePresent)), eq: true };
      }
      if (n.kind === 'instance') {
        const def = own(state.components, n.definitionId);
        for (const [prop, v] of Object.entries(n.props ?? {})) {
          if (!isBindingRef(v)) continue;
          const field = itemField(v);
          const nested = own(def?.properties, prop);
          if (field === undefined && inDesign) continue;
          if (field === undefined || !nested || !collection || !rowFieldSchema(collection, field)) {
            // What a loop's section cannot read shows the section's own default.
            delete (n.props as Record<string, unknown>)[prop];
            continue;
          }
          const pctx = def?.kind === 'code' ? { ...rctx, forCode: true } : rctx;
          (n.props as Record<string, unknown>)[prop] = keyed(`${n.id}|prop|${prop}`, nested, (e) => resolveValue(nested, projectField(state, collection, e, field, nested), pctx));
        }
        // A placement's variant is its own, the same in every row (or, in a design, the design's to choose).
        if (!inDesign) for (const [axis, v] of Object.entries((n as InstanceNode).variants ?? {})) if (isBindingRef(v)) delete (n as InstanceNode).variants![axis];
        for (const ids of Object.values(n.slots ?? {})) if (Array.isArray(ids)) ids.forEach(visit);
        return;
      }
      for (const key of STRUCTURE) {
        if (!isBindingRef(r[key]) || (inDesign && itemField(r[key]) === undefined)) continue;
        const empty = emptyFor(n, key);
        if (empty === undefined) delete r[key];
        else r[key] = empty;
      }
      for (const key of CONTENT) {
        const v = r[key];
        if (!isBindingRef(v)) continue;
        const field = itemField(v);
        if (field === undefined && inDesign) continue;
        if (field === undefined || !collection || !rowFieldSchema(collection, field) || !ENTRY_CONTENT_FIELDS.has(key)) {
          const empty = emptyFor(n, key);
          if (empty === undefined) delete r[key];
          else r[key] = empty;
          continue;
        }
        const schema = placeSchema(n, key);
        r[key] = keyed(`${n.id}|${key}`, schema, (e) => {
          // A `<time>` states a date as YYYY-MM-DD, and only a date.
          if (key === 'datetime') return isEntryDateField(collection, field) ? rowFieldValue(state, collection, e, field, 'raw') : '';
          return resolveValue(schema, projectField(state, collection, e, field, schema), rctx);
        });
      }
      if (n.kind === 'element' && Array.isArray(n.children)) n.children.forEach(visit);
      if (n.kind === 'slot' && Array.isArray(n.children)) n.children.forEach(visit);
    };
    if (Array.isArray(loop.children)) loop.children.forEach(visit);
    const rows = entries.map((e) => Object.fromEntries([['id', e.id], ...readers.map(([key, read]) => [key, read(e)])]));
    loops.set(loop.id, { rows, schema: { type: 'list', label: 'Entries', itemLabel: 'Entry', fields: fields as ListProp['fields'], default: [] }, collection, entries });
  }
  return { tree: { ...tree, nodes: copy }, loops };
}

/** Whether visitors browse what a collection query's loop shows (see RepeatSource). */
export function loopBrowses(node: Pick<RepeatNode, 'list'>): boolean {
  const list = node.list as { $query?: unknown; browse?: unknown };
  return Object.hasOwn(list, '$query') && list.browse === true;
}

/** Whether a loop's query reads the entry whose page it is on. */
export function readsCurrent(node: Pick<RepeatNode, 'list'>): boolean {
  const q = (node.list as { $query?: { collectionId?: unknown; excludeCurrent?: unknown } }).$query;
  return !!q && (q.collectionId === CURRENT_COLLECTION || q.excludeCurrent === true);
}
