/**
 * Styles for one item of a repeated list (one card of a grid, one pricing plan), kept on the placement beside its
 * shared part styles. Pure helpers shared by the engine, the generator, the editor and the agent, so all of them
 * agree on which part and which list an item's styles apply to.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, ItemStyles, ListItem, ResponsiveStyles } from './types';
import { sha256Hex } from './sha256';
import { repeatProp, slotChildren, slotFallback } from './types';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** Each node's parent within a definition's tree (children of elements and repeats, and a slot's fallback). */
function parentsOf(def: ComponentDefinition): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of Object.values(def.tree?.nodes ?? {})) if (n.kind === 'element' || n.kind === 'repeat' || n.kind === 'slot') for (const c of n.kind === 'slot' ? slotFallback(n) : n.children) if (!out.has(c)) out.set(c, n.id);
  return out;
}

/** Content placed in a nested instance's slots: rendered wherever, and however often, that component renders it. */
function slotted(def: ComponentDefinition): Set<string> {
  return new Set(Object.values(def.tree?.nodes ?? {}).flatMap((n) => (n.kind === 'instance' ? Object.keys(n.slots ?? {}).flatMap((k) => slotChildren(n, k)) : [])));
}

/**
 * The list property whose items a definition's part can be styled one at a time: a part of a managed definition
 * that sits inside exactly one repeat, iterating a list property that keeps its own items (not a computed one), or a
 * part a code component declares repeats over such a list (see codeRepeatedList). Nested repeats render the same item
 * once per outer item, so an item ID there names several elements; such parts, and parts outside every list, have none.
 */
export function repeatedPartList(def: ComponentDefinition, partId: string): string | undefined {
  if (def.kind === 'code') return codeRepeatedList(def, partId);
  if (def.kind !== 'managed' || !def.tree) return undefined;
  const part = own(def.parts, partId);
  const node: GraphNode | undefined = part ? own(def.tree.nodes, part.nodeId) : undefined;
  if (!node || node.kind === 'repeat' || node.kind === 'slot') return undefined;
  const parents = parentsOf(def);
  const inSlot = slotted(def);
  const seen = new Set<string>();
  let list: string | undefined;
  let repeats = 0;
  // A part inside a nested component's slot may be rendered once per item of that component's own lists, which this
  // definition cannot see: one item class would land on several copies, so such a part is styled for all items only.
  if (inSlot.has(node.id)) return undefined;
  for (let id = parents.get(node.id); id && !seen.has(id); id = parents.get(id)) {
    if (inSlot.has(id)) return undefined;
    seen.add(id);
    const n = def.tree.nodes[id];
    if (n?.kind !== 'repeat') continue;
    repeats++;
    list = repeatProp(n);
  }
  if (repeats !== 1 || !list) return undefined;
  const schema = own(def.properties, list);
  // A computed list (a News list's articles) keeps no items of its own: its rows are worked out from the site's
  // pages wherever it is placed, so its parts are styled for every row together.
  return schema?.type === 'list' && !schema.feed ? list : undefined;
}

/**
 * A code component has no tree to read: a part it renders once per item of a list says so itself (`PartDef.list`),
 * and takes each item's class from `so_oi` by the item's ID. The list must be one of its own list properties that
 * keeps its own items; its root is the whole component, never one item.
 */
function codeRepeatedList(def: ComponentDefinition, partId: string): string | undefined {
  const list = partId === 'root' ? undefined : own(def.parts, partId)?.list;
  if (typeof list !== 'string') return undefined;
  const schema = own(def.properties, list);
  return schema?.type === 'list' && !schema.feed ? list : undefined;
}

/** The items a placement's list shows: its own, or the definition's defaults while it has none. */
export function placementItems(def: ComponentDefinition, node: InstanceNode, listProp: string): ListItem[] {
  const stored = own(node.props, listProp);
  const schema = own(def.properties, listProp);
  const list = Array.isArray(stored) ? stored : schema?.type === 'list' ? schema.default : [];
  return (list as ListItem[]).filter((i) => !!i && typeof i === 'object' && typeof i.id === 'string');
}

/** A part's item styles that apply now: the part still repeats over the list they were set for. */
export function liveItemStyles(def: ComponentDefinition | undefined, node: InstanceNode, partId: string): ItemStyles | undefined {
  const entry = own(node.itemOverrides, partId);
  if (!def || !entry || typeof entry !== 'object' || typeof entry.list !== 'string' || !entry.items || typeof entry.items !== 'object') return undefined;
  return repeatedPartList(def, partId) === entry.list ? entry : undefined;
}

/** One item's own styles for a part, when they apply now. */
export function itemStylesOf(def: ComponentDefinition | undefined, node: InstanceNode, partId: string, itemId: string): ResponsiveStyles | undefined {
  return own(liveItemStyles(def, node, partId)?.items, itemId);
}

/** Every responsive style record a placement keeps for single items, for walkers of style values (tokens, fonts). */
export function itemStyleRecords(node: GraphNode): ResponsiveStyles[] {
  if (node.kind !== 'instance' || !node.itemOverrides) return [];
  return Object.values(node.itemOverrides).flatMap((e) =>
    e && typeof e === 'object' && e.items && typeof e.items === 'object' ? Object.values(e.items).filter((rs): rs is ResponsiveStyles => !!rs && typeof rs === 'object') : []
  );
}

/**
 * The class that carries one item's styles for one part of one placement. Item IDs can hold any characters, so the
 * whole identity is hashed: two different items never share a class, whatever their IDs.
 */
export function itemOverrideClass(instanceId: string, partId: string, itemId: string): string {
  return `so-oi-${sha256Hex(JSON.stringify([instanceId, partId, itemId])).slice(0, 16)}`;
}
