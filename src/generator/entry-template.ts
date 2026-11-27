/**
 * A collection's layout template made into one entry's page: every `{ $entry: field }` the template's elements and
 * placed sections read is replaced by that entry's value, in the form the place takes (a date written out for
 * reading, and as YYYY-MM-DD for a `<time>`; a picture; a link; rich text), and every element whose condition does
 * not hold for the entry is left out. The result is an ordinary tree of literal values, with the template's node IDs,
 * that the generator writes as it writes a page.
 */
import type { Collection, EntryDoc, GraphNode, ImageValue, InstanceNode, LinkValue, NodeTree, ProjectState, PropSchema } from '@shared/types';
import { conditionHolds, conditionRef, isBinding, isBindingRef, isEntryBinding } from '@shared/types';
import { asType } from '@shared/collection-rows';
import { ENTRY_CONTENT_FIELDS, entryFieldSchema, entryFieldValue, entryValuePresent, isEntryDateField, type EntryNeighbours, type EntryReadContext } from '@shared/entry-fields';
import { isDraftEntry, siteEntries } from './index';
import { collectionHasBody } from '@shared/collections';
import { derived } from './cache';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * The published entries just before and after `entry` in its collection's order, among those the site has a page
 * for. A draft (shown in the editor) has the published entries on either side of where it is listed.
 */
export function entryNeighbours(state: ProjectState, collectionId: string, entryId: string): EntryNeighbours {
  // Each entry's own pair, worked out once per state: in a cached run an entry's page depends on its two neighbours,
  // not on every entry (a draft added elsewhere, or a post reordered far from it, leaves it as it is).
  // The pairs of the collection are one value of their own, read by each entry's.
  const pair = derived(state, `entryNeighbours:${collectionId}:${entryId}`, (s) => {
    const all = derived(s, `entryPairs:${collectionId}`, (t) => pairsByEntry(t, collectionId));
    return Object.hasOwn(all, entryId) ? all[entryId] : null;
  });
  const entries = state.collections[collectionId]?.entries ?? {};
  const prev = pair?.prev ? own(entries, pair.prev) : undefined;
  const next = pair?.next ? own(entries, pair.next) : undefined;
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}

type Pair = { prev: string | null; next: string | null };

/** A collection's pairs (collectionPairs) by entry ID, made once for each time they are worked out. */
const records = new WeakMap<Map<string, Pair>, Record<string, Pair>>();
function pairsByEntry(state: ProjectState, collectionId: string): Record<string, Pair> {
  const pairs = collectionPairs(state, collectionId);
  let record = records.get(pairs);
  if (!record) records.set(pairs, (record = Object.fromEntries(pairs)));
  return record;
}
/**
 * Every entry's neighbours in one collection, by entry ID: the nearest published entries before and after it among
 * those the site has a page for. Worked out in one pass per state and collection, however many entries ask.
 */
const pairs = new WeakMap<object, Map<string, Map<string, Pair>>>();
function collectionPairs(state: ProjectState, collectionId: string): Map<string, Pair> {
  let byCollection = pairs.get(state);
  if (!byCollection) pairs.set(state, (byCollection = new Map()));
  let out = byCollection.get(collectionId);
  if (out) return out;
  const order = siteEntries(state)
    .filter((e) => e.collection.settings.id === collectionId)
    .map((e) => ({ id: e.entry.id, draft: isDraftEntry(e.entry) }));
  out = new Map();
  let before: string | null = null;
  for (const e of order) {
    out.set(e.id, { prev: before, next: null });
    if (!e.draft) before = e.id;
  }
  let after: string | null = null;
  for (let i = order.length - 1; i >= 0; i--) {
    out.get(order[i].id)!.next = after;
    if (!order[i].draft) after = order[i].id;
  }
  byCollection.set(collectionId, out);
  return out;
}

const EMPTY_IMAGE: ImageValue = { assetId: null, alt: '' };
const NO_LINK: LinkValue = { type: 'none', target: '' };

/** A read of a collection loop's row (see ./collection-loops), which the loop's rows decide, not the entry whose page it is. */
const readsRow = (v: unknown) => isBinding(v) && '$item' in v;

/** What a field shows where nothing (a field the collection no longer has) is bound: an empty value of its kind. */
export function emptyFor(node: GraphNode, field: string, nested?: PropSchema): unknown {
  switch (field) {
    case 'text':
      return node.kind === 'text' && node.rich ? [] : '';
    case 'label':
      return '';
    case 'image':
      return EMPTY_IMAGE;
    case 'link':
      return node.kind === 'link' ? NO_LINK : undefined;
    case 'tag':
      return node.kind === 'text' ? 'p' : 'div';
    case 'icon':
      return node.kind === 'icon' ? 'sparkles' : undefined;
    case 'appearance':
      return 'primary';
    case 'prop':
      return nested?.default;
    default:
      return undefined;
  }
}

/**
 * The value an entry binding gives one place in a node: `field` is the node's field (`text`, `datetime`, `image`,
 * `prop`...), `nested` the placed component's property schema for `prop`. Undefined leaves the place empty.
 */
function boundValue(read: EntryReadContext, node: GraphNode, field: string, entryField: string, nested?: PropSchema, withoutBody = false): unknown {
  const schema = entryFieldSchema(read.collection, entryField);
  // The entry's text left out where it is placed, and nowhere else (a condition on it still holds as it does).
  if (withoutBody && entryField === 'body') return field === 'prop' ? (nested ? asType(nested.type, []) : undefined) : asType('richtext', []);
  if (!schema) return emptyFor(node, field, nested);
  if (field === 'datetime') return isEntryDateField(read.collection, entryField) ? entryFieldValue(read, entryField, 'raw') : undefined;
  // A number or yes/no property takes the value itself (the minutes of a reading time); a text, as readers see it.
  const raw = field === 'prop' && (nested?.type === 'number' || nested?.type === 'boolean');
  const value = entryFieldValue(read, entryField, raw ? 'raw' : 'shown');
  switch (field) {
    case 'text':
      return asType(node.kind === 'text' && node.rich ? 'richtext' : 'string', value);
    case 'image':
      return asType('image', value);
    case 'link':
      return asType('link', value);
    case 'prop':
      return nested ? asType(nested.type, value) : undefined;
    default:
      return asType('string', value);
  }
}

/**
 * A placed component's bound properties as one entry's page has them: what each reads of the entry, or the default of
 * one bound to anything else (undefined: the property's own default decides).
 */
function boundProps(state: ProjectState, read: EntryReadContext, node: InstanceNode, withoutBody = false): Array<[string, unknown]> {
  const def = own(state.components, node.definitionId);
  return Object.entries(node.props ?? {}).flatMap(([prop, v]): Array<[string, unknown]> => {
    if (!isBindingRef(v) || readsRow(v)) return [];
    const nested = own(def?.properties, prop);
    return [[prop, isEntryBinding(v) ? boundValue(read, node, 'prop', v.$entry, nested, withoutBody) : nested?.default]];
  });
}

/** The entry's page as a tree of literal values: the template read for `entry`. `template` is never changed. */
export function materializeTemplate(state: ProjectState, collection: Collection, entry: EntryDoc, neighbours: EntryNeighbours, opts: { body?: boolean } = {}): NodeTree {
  const template = collection.settings.template;
  // Without the entry's text where it is placed (`body: false`), for checks that read the entry's own text on their
  // own. Everything else, conditions on the text or its reading time included, is as the website has it.
  const withoutBody = opts.body === false;
  const nodes: Record<string, GraphNode> = structuredClone(template?.nodes && typeof template.nodes === 'object' ? template.nodes : {});
  const read: EntryReadContext = { state, collection, entry, neighbours };
  const hidden = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object') continue;
    const r = node as unknown as Record<string, unknown>;
    // Conditions: an entry's value decides them here, once; anything else a template cannot read shows the element.
    for (const key of ['when', 'unless'] as const) {
      const c = r[key];
      if (c === undefined) continue;
      const ref = conditionRef(c);
      if (readsRow(ref)) continue;
      if (ref && isEntryBinding(ref)) {
        const holds = conditionHolds(c as Parameters<typeof conditionHolds>[0], entryFieldValue(read, ref.$entry, 'raw'), entryValuePresent);
        if (key === 'when' ? !holds : holds) hidden.add(node.id);
      }
      delete r[key];
    }
    if (node.kind === 'instance') {
      for (const [prop, value] of boundProps(state, read, node, withoutBody)) {
        if (value === undefined) delete (node.props as Record<string, unknown>)[prop];
        else (node.props as Record<string, unknown>)[prop] = structuredClone(value);
      }
      // A placement's variant reads nothing of an entry: one bound by hand falls back to the design's default.
      for (const [axis, v] of Object.entries(node.variants ?? {})) if (isBindingRef(v)) delete node.variants![axis];
      continue;
    }
    for (const field of ['text', 'datetime', 'image', 'fallbackAlt', 'link', 'label', 'ariaLabel', 'tag', 'action', 'appearance', 'icon', 'iconPosition']) {
      const v = r[field];
      if (!isBindingRef(v) || readsRow(v)) continue;
      // A layout's structure and look (a tag, a button's style) are the same on every entry: only content reads one.
      const value = isEntryBinding(v) && ENTRY_CONTENT_FIELDS.has(field) ? boundValue(read, node, field, v.$entry, undefined, withoutBody) : emptyFor(node, field);
      if (value === undefined) delete r[field];
      else r[field] = structuredClone(value);
    }
  }
  // Leave out what is hidden, and a collapsing element left with nothing to show.
  const shown = new Map<string, boolean>();
  const visible = (id: string, depth = 0): boolean => {
    if (shown.has(id)) return shown.get(id)!;
    const node = own(nodes, id);
    shown.set(id, false);
    if (!node || hidden.has(id) || depth > 200) return false;
    let result = true;
    if (node.kind === 'element' || node.kind === 'repeat') {
      node.children = (Array.isArray(node.children) ? node.children : []).filter((c) => visible(c, depth + 1));
      if (node.kind === 'element' && node.collapseEmpty && !node.children.length) result = false;
    } else if (node.kind === 'instance' && node.slots) {
      for (const [slot, ids] of Object.entries(node.slots)) if (Array.isArray(ids)) (node as InstanceNode).slots![slot] = ids.filter((c) => visible(c, depth + 1));
    }
    shown.set(id, result);
    return result;
  };
  const rootIds = (Array.isArray(template?.rootIds) ? template.rootIds : []).filter((id) => visible(id));
  return { rootIds, nodes };
}

/**
 * Whether an entry's page shows its text: an element (or placed section) of its layout that shows the text is on the
 * page for it. `article` is the layout read for the entry (materializeTemplate), with its node IDs. Never for entries
 * without text of their own, whatever a stale binding says.
 */
export function showsBody(collection: Collection, article: NodeTree): boolean {
  if (!collectionHasBody(collection.settings)) return false;
  const nodes = collection.settings.template?.nodes ?? {};
  const placed = new Set(
    Object.values(nodes)
      .filter((n) => n && typeof n === 'object' && bindingPlaces(n).some((v) => isEntryBinding(v) && v.$entry === 'body'))
      .map((n) => n.id)
  );
  if (!placed.size) return false;
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (placed.has(id)) return true;
    const n = own(article.nodes, id) as (GraphNode & { children?: unknown; slots?: Record<string, unknown> }) | undefined;
    if (!n) return false;
    const kids = [...(Array.isArray(n.children) ? n.children : []), ...Object.values(n.slots ?? {}).flatMap((ids) => (Array.isArray(ids) ? ids : []))];
    return kids.some((k) => typeof k === 'string' && visit(k));
  };
  return article.rootIds.some(visit);
}

/** The values a node shows that could read an entry field: its content fields and a placed section's properties. */
function bindingPlaces(n: GraphNode): unknown[] {
  const r = n as unknown as Record<string, unknown>;
  return n.kind === 'instance' ? Object.values(n.props ?? {}) : ['text', 'image', 'link', 'label'].map((f) => r[f]);
}

