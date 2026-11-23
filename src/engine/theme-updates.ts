/**
 * Picking up newer theme component definitions in an existing project.
 *
 * A project keeps its own copy of every theme component it uses, so a fix to a theme reaches new projects only.
 * An installed definition may be replaced by the theme's current one when all of this holds:
 * - it is still theme data: owned by the theme and matching the hash recorded when it was installed, so neither
 *   forks nor files edited by hand are ever touched;
 * - no project component is built on it, directly or through other components, since those were designed
 *   against the version they have;
 * - neither version places another component: nested theme components only make sense as a matched set;
 * - the new version keeps the public contract its placements rely on, and accepts the content they hold.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import type { Op } from '@shared/ops';
import { getTheme } from '@catalogue/index';
import { definitionHash, matchesLock } from '@shared/migrations';
import { variantOptions } from '@shared/variants';
import { clone } from './install';
import { EngineError, fail, instancesOf, subtreeIds } from './tree';
import { codeNeeds, directDependencies } from './definitions';
import { normalizeProp } from './values';

function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Values placements on pages and in the shell set for a property (or for one field of a list's items). */
function usedValues(state: ProjectState, defId: string, prop: string, field?: string): unknown[] {
  const out = new Set<unknown>();
  // Placements inside project components stay pinned to the old definition, so only pages and the shell count.
  for (const { node, owner } of instancesOf(state, defId)) {
    if (owner.kind === 'component') continue;
    const v = node.props[prop];
    if (v === undefined || isBinding(v)) continue;
    if (field === undefined) out.add(v);
    else if (Array.isArray(v)) for (const it of v as Array<Record<string, unknown>>) if (it?.[field] !== undefined && !isBinding(it[field])) out.add(it[field]);
  }
  return [...out];
}

/** Why `next` cannot stand in for `def` in this project: each entry names a contract it breaks. */
export function contractConflicts(state: ProjectState, def: ComponentDefinition, next: ComponentDefinition): string[] {
  const conflicts: string[] = [];
  for (const [p, was] of Object.entries(def.properties)) {
    const now = own(next.properties, p);
    if (!now || now.type !== was.type) {
      conflicts.push(`${def.name}: property "${p}" is not compatible.`);
      continue;
    }
    if (was.type === 'list' && now.type === 'list') {
      // Which fields follow the linked page is part of what placements' empty fields mean.
      if ((['link', 'title', 'description', 'image'] as const).some((k) => was.pageTeaser?.[k] !== now.pageTeaser?.[k])) conflicts.push(`${def.name}: "${p}" fills different fields from its pages.`);
      for (const [f, field] of Object.entries(was.fields)) {
        const nf = own(now.fields, f);
        if (!nf || nf.type !== field.type) conflicts.push(`${def.name}: "${p}" item field "${f}" is not compatible.`);
        else if (nf.type === 'enum') for (const v of usedValues(state, def.id, p, f)) if (!nf.options.some((o) => o.value === v)) conflicts.push(`${def.name}: "${p}" item field "${f}" has no option "${String(v)}".`);
      }
    }
    if (now.type === 'enum') for (const v of usedValues(state, def.id, p)) if (!now.options.some((o) => o.value === v)) conflicts.push(`${def.name}: property "${p}" has no option "${String(v)}".`);
  }
  for (const p of Object.keys(def.parts)) if (!own(next.parts, p)) conflicts.push(`${def.name}: part "${p}" is missing.`);
  for (const { axis, id } of variantOptions(def)) if (!own(own(next.variantAxes ?? {}, axis)?.options ?? {}, id)) conflicts.push(`${def.name}: ${axis} variant "${id}" is missing.`);
  for (const sl of Object.keys(def.slots ?? {})) if (!own(next.slots ?? {}, sl)) conflicts.push(`${def.name}: slot "${sl}" is missing.`);
  return conflicts;
}

export interface ThemeUpdates {
  /** Installed definitions that can safely take the theme's current version. */
  available: Array<{ id: string; name: string }>;
  /** Definitions with a newer version that stay as they are, and why. */
  kept: Array<{ id: string; name: string; reason: string }>;
}

/** Definitions a definition builds on directly: placed in its tree, declared, or imported by its source. */
function dependenciesOf(state: ProjectState, def: ComponentDefinition): string[] {
  const ids = new Set([...directDependencies(def), ...(def.dependencies ?? [])]);
  if (def.kind === 'code') for (const other of Object.keys(state.components)) if (codeNeeds(state, def, other)) ids.add(other);
  return [...ids];
}

/** For each definition some project component builds on, directly or transitively, the first such component. */
function pinnedByProject(state: ProjectState): Map<string, ComponentDefinition> {
  const pinned = new Map<string, ComponentDefinition>();
  for (const root of Object.values(state.components)) {
    if (root.owner !== 'project') continue;
    const seen = new Set<string>([root.id]);
    const stack = [root];
    while (stack.length) {
      for (const id of dependenciesOf(state, stack.pop()!)) {
        const dep = own(state.components, id);
        if (!dep || seen.has(id)) continue;
        seen.add(id);
        stack.push(dep);
        if (!pinned.has(id)) pinned.set(id, root);
      }
    }
  }
  return pinned;
}

/** What placements on pages and in the shell hold that `next` would no longer show or accept. */
function placementConflicts(state: ProjectState, def: ComponentDefinition, next: ComponentDefinition): string[] {
  const out = new Set<string>();
  const rendered = new Set(next.tree ? next.tree.rootIds.flatMap((r) => subtreeIds(next.tree!, r)) : []);
  const showsSlot = (slot: string) => [...rendered].some((id) => {
    const n = next.tree!.nodes[id];
    return n.kind === 'slot' && n.slot === slot;
  });
  for (const { node, owner, label } of instancesOf(state, def.id)) {
    if (owner.kind === 'component') continue;
    for (const [name, schema] of Object.entries(next.properties)) {
      if (!Object.hasOwn(node.props, name) || isBinding(node.props[name])) continue;
      try {
        normalizeProp(schema, node.props[name], state, `${label}: ${def.name} → ${schema.label}`, node.props[name]);
      } catch (e) {
        // Content too malformed to check (a hand-edited list) is a reason to hold the update, never to fail.
        out.add(e instanceof EngineError ? e.message : `${label}: ${def.name} holds content in "${name}" that could not be checked.`);
      }
    }
    if (next.kind !== 'managed' || !next.tree) continue;
    for (const [slot, ids] of Object.entries(node.slots ?? {}))
      if (ids.length && !showsSlot(slot)) out.add(`${label}: ${def.name} would no longer show the content in its "${slot}" slot.`);
    for (const partId of Object.keys(node.overrides ?? {})) {
      const target = own(next.parts, partId)?.nodeId;
      const kind = target && rendered.has(target) ? next.tree.nodes[target].kind : undefined;
      if (!kind || kind === 'slot' || kind === 'repeat') out.add(`${label}: ${def.name} would lose the styles set on its "${partId}" part.`);
    }
  }
  return [...out];
}

/** Catalogue definitions never change while the app runs, and this is asked on every project update. */
const catalogueHashes = new WeakMap<ComponentDefinition, string>();
function catalogueHash(def: ComponentDefinition): string {
  let h = catalogueHashes.get(def);
  if (!h) catalogueHashes.set(def, (h = definitionHash(def)));
  return h;
}

export function themeUpdates(state: ProjectState): ThemeUpdates {
  const out: ThemeUpdates = { available: [], kept: [] };
  const catalogue = new Map(getTheme(state.site.themeId).components.map((c) => [c.id, c]));
  // A definition retained from a previous theme has no current version here.
  const outdated = Object.values(state.components).filter((d) => {
    const next = d.owner === 'theme' ? catalogue.get(d.id) : undefined;
    return !!next && catalogueHash(next) !== definitionHash(d);
  });
  if (!outdated.length) return out;
  const pinned = pinnedByProject(state);
  const nestedInTheme = new Set(Object.values(state.components).filter((d) => d.owner === 'theme').flatMap((d) => dependenciesOf(state, d)));
  for (const def of outdated) {
    const next = catalogue.get(def.id)!;
    const keep = (reason: string) => out.kept.push({ id: def.id, name: def.name, reason });
    if (!matchesLock(state.themeLock.components[def.id]?.hash, def)) {
      keep('Its stored definition was changed outside the theme.');
      continue;
    }
    const user = pinned.get(def.id);
    if (user) {
      keep(`"${user.name}" is built on this version.`);
      continue;
    }
    if (dependenciesOf(state, def).length || dependenciesOf(state, next).length || nestedInTheme.has(def.id)) {
      keep('It is part of a nested theme component, so it can only change together with the others.');
      continue;
    }
    const conflicts = [...contractConflicts(state, def, next), ...placementConflicts(state, def, next)];
    if (conflicts.length) {
      keep(conflicts.join(' '));
      continue;
    }
    out.available.push({ id: def.id, name: def.name });
  }
  return out;
}

/** Replace installed theme definitions with the theme's current versions, wherever that is safe. */
export function themeRefresh(state: ProjectState, op: Op<'theme.refresh'>): { updated: string[]; kept: ThemeUpdates['kept'] } {
  const theme = getTheme(state.site.themeId);
  const updates = themeUpdates(state);
  const ready = new Set(updates.available.map((u) => u.id));
  for (const id of op.definitionIds ?? []) {
    if (ready.has(id)) continue;
    const held = updates.kept.find((k) => k.id === id);
    fail(held ? `"${held.name}" cannot be updated: ${held.reason}` : `"${id}" has no theme update.`);
  }
  const targets = op.definitionIds ? [...new Set(op.definitionIds)] : [...ready];
  for (const id of targets) {
    const next = theme.components.find((c) => c.id === id)!;
    state.components[id] = clone(next);
    state.themeLock.components[id] = { componentId: next.componentId, version: theme.version, hash: definitionHash(next) };
  }
  // The lock's pack version says the whole installed set is current, so it moves only once nothing is left behind.
  const left = themeUpdates(state);
  if (!left.available.length && !left.kept.length) state.themeLock.theme = { id: theme.id, version: theme.version };
  return { updated: targets, kept: updates.kept };
}
