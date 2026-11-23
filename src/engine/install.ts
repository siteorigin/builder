import type { ComponentDefinition, InstanceNode, ListItem, ProjectState, PropSchema } from '@shared/types';
import { catalogueComponent, getTheme } from '@catalogue/index';
import { newId } from '@shared/ids';
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

export function defaultProps(def: ComponentDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(def.properties)) out[k] = clone(s.default);
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
