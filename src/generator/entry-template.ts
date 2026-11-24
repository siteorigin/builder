/**
 * A collection's layout template made into one entry's page: every `{ $entry: field }` the template's elements and
 * placed sections read is replaced by that entry's value, in the form the place takes (a date written out for
 * reading, and as YYYY-MM-DD for a `<time>`; a picture; a link; rich text), and every element whose condition does
 * not hold for the entry is left out. The result is an ordinary tree of literal values, with the template's node IDs,
 * that the generator writes as it writes a page.
 */
import type { Collection, EntryDoc, GraphNode, ImageValue, InstanceNode, LinkValue, NodeTree, ProjectState, PropSchema } from '@shared/types';
import { conditionHolds, conditionRef, isBindingRef, isEntryBinding } from '@shared/types';
import { ENTRY_CONTENT_FIELDS, ENTRY_DATE_FIELDS, entryFieldSchema, entryFieldValue, entryValuePresent, type EntryNeighbours, type EntryReadContext } from '@shared/entry-fields';
import { isDraftEntry, siteEntries } from './index';
import { derived } from './cache';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * The published entries just before and after `entry` in its collection's order, among those the site has a page
 * for. A draft (shown in the editor) has the published entries on either side of where it is listed.
 */
export function entryNeighbours(state: ProjectState, collectionId: string, entryId: string): EntryNeighbours {
  // Each entry's own pair, worked out once per state: in a cached run an entry's page depends on its two neighbours,
  // not on every entry (a draft added elsewhere, or a post reordered far from it, leaves it as it is).
  const pair = derived(state, `entryNeighbours:${collectionId}:${entryId}`, (s) => {
    const listed = collectionOrder(s, collectionId).filter((e) => e.id === entryId || !e.draft);
    const at = listed.findIndex((e) => e.id === entryId);
    return at < 0 ? null : { prev: listed[at - 1]?.id ?? null, next: listed[at + 1]?.id ?? null };
  });
  const entries = state.collections[collectionId]?.entries ?? {};
  const prev = pair?.prev ? own(entries, pair.prev) : undefined;
  const next = pair?.next ? own(entries, pair.next) : undefined;
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}

/** Each collection's entries the site has a page for, in order, worked out once per state for all its entries. */
const orders = new WeakMap<object, Map<string, Array<{ id: string; draft: boolean }>>>();
function collectionOrder(state: ProjectState, collectionId: string): Array<{ id: string; draft: boolean }> {
  let byCollection = orders.get(state);
  if (!byCollection) orders.set(state, (byCollection = new Map()));
  let order = byCollection.get(collectionId);
  if (!order) {
    order = siteEntries(state)
      .filter((e) => e.collection.settings.id === collectionId)
      .map((e) => ({ id: e.entry.id, draft: isDraftEntry(e.entry) }));
    byCollection.set(collectionId, order);
  }
  return order;
}

const EMPTY_IMAGE: ImageValue = { assetId: null, alt: '' };
const NO_LINK: LinkValue = { type: 'none', target: '' };

/** A value as a property of type `type` takes it. */
function asType(type: PropSchema['type'], v: unknown): unknown {
  switch (type) {
    case 'string':
    case 'enum':
    case 'icon':
      return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    case 'boolean':
      return v === true;
    case 'image':
      return v && typeof v === 'object' && 'assetId' in v ? v : EMPTY_IMAGE;
    case 'link':
      return v && typeof v === 'object' && 'type' in v ? v : NO_LINK;
    case 'richtext':
      return Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [{ type: 'p', spans: [{ text: v }] }] : [];
    default:
      return v;
  }
}

/** What a field shows where nothing (a field the collection no longer has) is bound: an empty value of its kind. */
function emptyFor(node: GraphNode, field: string, nested?: PropSchema): unknown {
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
function boundValue(read: EntryReadContext, node: GraphNode, field: string, entryField: string, nested?: PropSchema): unknown {
  const schema = entryFieldSchema(read.collection, entryField);
  if (!schema) return emptyFor(node, field, nested);
  if (field === 'datetime') return ENTRY_DATE_FIELDS.has(entryField) ? entryFieldValue(read, entryField, 'raw') : undefined;
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

/** The entry's page as a tree of literal values: the template read for `entry`. `template` is never changed. */
export function materializeTemplate(state: ProjectState, collection: Collection, entry: EntryDoc, neighbours: EntryNeighbours): NodeTree {
  const template = collection.settings.template;
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
      if (ref && isEntryBinding(ref)) {
        const holds = conditionHolds(c as Parameters<typeof conditionHolds>[0], entryFieldValue(read, ref.$entry, 'raw'), entryValuePresent);
        if (key === 'when' ? !holds : holds) hidden.add(node.id);
      }
      delete r[key];
    }
    if (node.kind === 'instance') {
      const def = own(state.components, node.definitionId);
      for (const [prop, v] of Object.entries(node.props ?? {})) {
        if (!isBindingRef(v)) continue;
        const nested = own(def?.properties, prop);
        const value = isEntryBinding(v) ? boundValue(read, node, 'prop', v.$entry, nested) : nested?.default;
        if (value === undefined) delete (node.props as Record<string, unknown>)[prop];
        else (node.props as Record<string, unknown>)[prop] = structuredClone(value);
      }
      // A placement's variant reads nothing of an entry: one bound by hand falls back to the design's default.
      for (const [axis, v] of Object.entries(node.variants ?? {})) if (isBindingRef(v)) delete node.variants![axis];
      continue;
    }
    for (const field of ['text', 'datetime', 'image', 'fallbackAlt', 'link', 'label', 'ariaLabel', 'tag', 'action', 'appearance', 'icon', 'iconPosition']) {
      const v = r[field];
      if (!isBindingRef(v)) continue;
      // A layout's structure and look (a tag, a button's style) are the same on every entry: only content reads one.
      const value = isEntryBinding(v) && ENTRY_CONTENT_FIELDS.has(field) ? boundValue(read, node, field, v.$entry) : emptyFor(node, field);
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
