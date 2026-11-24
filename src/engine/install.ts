import type { ComponentDefinition, InstanceNode, ListItem, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { catalogueComponent, getTheme } from '@catalogue/index';
import { newId, stableHash } from '@shared/ids';
import { definitionHash } from '@shared/migrations';
import { findVariant } from '@shared/variants';

export { definitionHash };

export function clone<T>(v: T): T {
  return structuredClone(v);
}

/** Copy a catalogue component (and its dependency closure) into the project. Returns the definition ID. */
export function installComponent(state: ProjectState, componentId: string): string {
  const src = catalogueComponent(state.site.themeId, componentId);
  if (!src) throw new Error(`Unknown component "${componentId}" in theme ${state.site.themeId}.`);
  if (!state.components[src.id]) {
    const def = clone(src);
    state.components[def.id] = def;
    state.themeLock.components[def.id] = { componentId: def.componentId, version: getTheme(state.site.themeId).version, hash: definitionHash(src) };
    for (const dep of def.dependencies ?? []) {
      const depDef = getTheme(state.site.themeId).components.find((c) => c.id === dep);
      if (depDef) installComponent(state, depDef.componentId);
    }
  }
  return src.id;
}

/** Give list items new IDs (used for new instances and duplicates). */
export function freshListIds(schema: Record<string, PropSchema>, props: Record<string, unknown>): Record<string, unknown> {
  const out = { ...props };
  for (const [k, s] of Object.entries(schema)) {
    if (s.type === 'list' && Array.isArray(out[k])) out[k] = (out[k] as ListItem[]).map((it) => ({ ...clone(it), id: newId('i') }));
  }
  return out;
}

/**
 * The ID a list's default item takes in one placement's own copy of the list: its own, so no two placements share
 * one, and worked out again from the default's ID, so an edit sent with the ID the definition gives the item still
 * finds it (see placedItemIndex).
 */
export function placedItemId(owner: OwnerRef, nodeId: string, itemId: string): string {
  const at = `${owner.kind}:${owner.id}:${nodeId}`;
  return `i_${stableHash(`${at}\u0000${itemId}`)}${stableHash(`${itemId}\u0000${at}`)}`;
}

/**
 * One placement's own copy of a list's default items, each under its placedItemId. Should two copies ever work out
 * to the same ID, the later one takes a random one, so the list stays valid.
 */
export function placedDefaultItems(owner: OwnerRef, node: InstanceNode, items: unknown): ListItem[] {
  const taken = new Set<string>();
  return (Array.isArray(items) ? (items as ListItem[]) : []).map((it) => {
    let id = placedItemId(owner, node.id, it.id);
    if (taken.has(id)) id = newId('i');
    taken.add(id);
    return { ...clone(it), id };
  });
}

/** Where an item is in a placement's own list: by its own ID, or by the ID of the default item it was copied from. */
export function placedItemIndex(list: readonly ListItem[], owner: OwnerRef, nodeId: string, itemId: string): number {
  const at = list.findIndex((it) => it?.id === itemId);
  if (at >= 0) return at;
  const copy = placedItemId(owner, nodeId, itemId);
  return list.findIndex((it) => it?.id === copy);
}

export function defaultProps(def: ComponentDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(def.properties)) {
    // A computed list stores nothing: its items come from the site's pages wherever it is placed.
    if (s.type === 'list' && s.feed) continue;
    out[k] = clone(s.default);
  }
  return out;
}

export function makeInstance(def: ComponentDefinition, props: Record<string, unknown> = {}, variants?: string | Record<string, string>): InstanceNode {
  const merged = { ...defaultProps(def), ...clone(props) };
  const node: InstanceNode = {
    id: newId('n'),
    kind: 'instance',
    definitionId: def.id,
    props: freshListIds(def.properties, merged)
  };
  if (typeof variants === 'string') {
    const found = findVariant(def, variants);
    if (!('error' in found)) node.variants = { [found.axis]: found.id };
  } else if (variants && Object.keys(variants).length) node.variants = { ...variants };
  return node;
}
