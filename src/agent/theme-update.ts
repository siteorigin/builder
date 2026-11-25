/**
 * Newer theme versions of the components a project installed, as the assistant sees and takes them (#692).
 *
 * A project keeps its own copy of every theme component it uses, so a property or option the theme added later is
 * missing from an older project until that copy is updated. The assistant reads each installed definition as it is,
 * and beside it what the theme's newer version adds and whether this project can take it (`themeUpdates`), so it
 * never calls something impossible that an update allows. `update_theme_component` updates one definition at a time,
 * through the same validated `theme.refresh` the Project health panel sends: in the run's history, its turn report and
 * its undo, and limited by the run's scope (see scope.ts).
 */
import { z } from 'zod';
import type { ComponentDefinition, ProjectState, PropSchema } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { partStyleControls } from '@shared/styles';
import { axesOf } from '@shared/variants';
import { catalogueComponent, getTheme } from '@catalogue/index';
import { themeUpdates, type ThemeUpdates } from '@engine/theme-updates';
import { componentDetail } from './context';
import type { ToolDefinition } from './types';
import type { ToolHost, ToolOutcome } from './tools';

/**
 * The project's theme updates, worked out once per project state: a committed state is never changed in place, and
 * a state no run holds any more is let go with it.
 */
const memo = new WeakMap<ProjectState, ThemeUpdates>();
export function themeUpdatesOf(state: ProjectState): ThemeUpdates {
  let u = memo.get(state);
  if (!u) memo.set(state, (u = themeUpdates(state)));
  return u;
}

/** The theme's current version of an installed theme definition, when it differs from the project's copy. */
function newerVersion(state: ProjectState, def: ComponentDefinition): ComponentDefinition | undefined {
  if (def.owner !== 'theme') return undefined;
  const u = themeUpdatesOf(state);
  if (!u.available.some((a) => a.id === def.id) && !u.kept.some((k) => k.id === def.id)) return undefined;
  return getTheme(state.site.themeId).components.find((c) => c.id === def.id);
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);
const optionLabels = (options: Array<{ value: string; label: string }>) => Object.fromEntries(options.map((o) => [o.value, o.label]));

/** A property as the newer version offers it: its label and type, and for a choice its options by stored value and label. */
function propShape(s: PropSchema) {
  if (s.type === 'enum') return { label: s.label, type: 'enum', options: optionLabels(s.options) };
  if (s.type === 'list' || s.type === 'object') return { label: s.label, type: s.type, fields: Object.fromEntries(Object.entries(s.fields).map(([f, fs]) => [f, fs.type === 'enum' ? { type: 'enum', label: fs.label, options: optionLabels(fs.options) } : { type: fs.type, label: fs.label }])) };
  return { label: s.label, type: s.type };
}

/** New choices of an enum: by stored value and label. */
function newOptions(was: Array<{ value: string }>, now: Array<{ value: string; label: string }>) {
  const had = new Set(was.map((o) => o.value));
  return now.filter((o) => !had.has(o.value));
}

export interface ThemeUpdateChanges {
  /** New properties, each with its label and type, and a choice's options as { storedValue: label }. */
  properties?: Record<string, unknown>;
  /** New choices on properties the installed version has: { property: { storedValue: label } }, or a list or object field's as "property.field". */
  options?: Record<string, Record<string, string>>;
  /** New fields of a list's items or an object property: "property.field" with its label and type. */
  fields?: Record<string, unknown>;
  /** New public parts to style, by part ID and label. */
  parts?: Record<string, string>;
  /** New style controls on parts the installed version has. */
  styleControls?: Record<string, string[]>;
  /** New variant axes, or new options on an axis, by option ID and label. */
  variants?: Record<string, Record<string, string>>;
  /** New slots for placed content, by slot ID and label. */
  slots?: Record<string, string>;
}

/** What the theme's newer version of a definition adds that a placement or its styles can use; empty when it changes only its design or code. */
export function themeUpdateChanges(def: ComponentDefinition, next: ComponentDefinition): ThemeUpdateChanges {
  const out: Required<ThemeUpdateChanges> = { properties: {}, options: {}, fields: {}, parts: {}, styleControls: {}, variants: {}, slots: {} };
  for (const [p, now] of Object.entries(next.properties)) {
    const was = own(def.properties, p);
    if (!was || was.type !== now.type) {
      out.properties[p] = propShape(now);
      continue;
    }
    if (was.type === 'enum' && now.type === 'enum') {
      const added = newOptions(was.options, now.options);
      if (added.length) out.options[p] = optionLabels(added);
    }
    if ((was.type === 'list' && now.type === 'list') || (was.type === 'object' && now.type === 'object')) {
      for (const [f, nf] of Object.entries(now.fields)) {
        const wf = own(was.fields, f);
        if (!wf || wf.type !== nf.type) out.fields[`${p}.${f}`] = nf.type === 'enum' ? { type: 'enum', label: nf.label, options: optionLabels(nf.options) } : { type: nf.type, label: nf.label };
        else if (wf.type === 'enum' && nf.type === 'enum') {
          const added = newOptions(wf.options, nf.options);
          if (added.length) out.options[`${p}.${f}`] = optionLabels(added);
        }
      }
    }
  }
  for (const [k, part] of Object.entries(next.parts)) {
    if (!own(def.parts, k)) {
      out.parts[k] = part.label;
      continue;
    }
    const had = new Set(partStyleControls(def, k) ?? []);
    const added = (partStyleControls(next, k) ?? []).filter((c) => !had.has(c));
    if (added.length) out.styleControls[k] = added;
  }
  const axesWas = new Map(axesOf(def));
  for (const [axis, a] of axesOf(next)) {
    const was = axesWas.get(axis);
    const added = Object.entries(a.options).filter(([id]) => !own(was?.options, id));
    if (added.length) out.variants[axis] = Object.fromEntries(added.map(([id, v]) => [id, v.label]));
  }
  for (const [slot, d] of Object.entries(next.slots ?? {})) if (!own(def.slots, slot)) out.slots[slot] = d.label;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => Object.keys(v).length)) as ThemeUpdateChanges;
}

/** The changes as short lines, for a list of every update: "ctaStyle (Action style): Filled button | Outlined button". */
function changeLines(c: ThemeUpdateChanges): string[] {
  const options = (o: unknown) => (o && typeof o === 'object' ? `: ${Object.values(o as Record<string, string>).join(' | ')}` : '');
  return [
    ...Object.entries(c.properties ?? {}).map(([p, s]) => `property ${p} (${(s as { label: string }).label})${options((s as { options?: unknown }).options)}`),
    ...Object.entries(c.options ?? {}).map(([p, o]) => `${p} options${options(o)}`),
    ...Object.entries(c.fields ?? {}).map(([f, s]) => `field ${f} (${(s as { label: string }).label})`),
    ...Object.entries(c.parts ?? {}).map(([k, label]) => `part ${k} (${label})`),
    ...Object.entries(c.styleControls ?? {}).map(([k, list]) => `${k} part styles: ${list.join(', ')}`),
    ...Object.entries(c.variants ?? {}).map(([axis, o]) => `${axis} variants${options(o)}`),
    ...Object.entries(c.slots ?? {}).map(([slot, label]) => `slot ${slot} (${label})`)
  ];
}

const AVAILABLE_NOTE =
  'The theme has a newer version of this component than the project has installed. What is described here is the installed version; newVersionAdds is what the newer one adds. When the request needs any of it, call update_theme_component with this definitionId, then make the change the user asked for. Never say the component cannot do it.';
const CONTRACT_SAME = 'The newer version changes only its design or code: it adds nothing to set.';
const heldNote = (reason: string) =>
  `The theme has a newer version of this component (newVersionAdds), but this project cannot take it: ${reason} If the request needs what it adds, tell the user the newer version has it and why it cannot be applied here, and offer another way to get close with what the installed version has. Never say the feature does not exist.`;

/**
 * What the assistant reads beside an installed theme definition the theme has a newer version of: whether this project
 * can take it, why not when it cannot, and what it adds. Undefined for a current definition or a project's own.
 */
export function themeUpdateNote(state: ProjectState, def: ComponentDefinition | undefined): Record<string, unknown> | undefined {
  if (!def) return undefined;
  const next = newerVersion(state, def);
  if (!next) return undefined;
  const adds = themeUpdateChanges(def, next);
  const held = themeUpdatesOf(state).kept.find((k) => k.id === def.id);
  const changes = Object.keys(adds).length ? { newVersionAdds: adds } : { newVersionAdds: null, contract: CONTRACT_SAME };
  return held ? { status: 'held', heldBecause: held.reason, ...changes, note: heldNote(held.reason) } : { status: 'available', ...changes, note: AVAILABLE_NOTE };
}

/** Most changes one entry of the list of every update names; read_component shows them all. */
const LINES = 6;

/**
 * Every installed theme definition the theme has a newer version of, for the project summary: those this project can
 * take, each with what it adds, and those it keeps, with why. `only` narrows it to some definitions (a page's).
 * Undefined when there are none.
 */
export function themeUpdatesSummary(state: ProjectState, only?: (definitionId: string) => boolean): Record<string, unknown> | undefined {
  const u = themeUpdatesOf(state);
  const wanted = (id: string) => (!only || only(id)) && Object.hasOwn(state.components, id);
  const available = u.available.filter((a) => wanted(a.id));
  const held = u.kept.filter((k) => wanted(k.id));
  if (!available.length && !held.length) return undefined;
  const adds = (id: string) => {
    const next = newerVersion(state, state.components[id]);
    const lines = next ? changeLines(themeUpdateChanges(state.components[id], next)) : [];
    return lines.length > LINES ? [...lines.slice(0, LINES), `and ${lines.length - LINES} more (read_component shows them)`] : lines;
  };
  return {
    note: 'Installed theme components the theme has a newer version of. available: update_theme_component brings one up to date when a request needs what it adds. held: this project cannot take it, for the reason given.',
    ...(available.length ? { available: available.map((a) => ({ definitionId: a.id, name: a.name, adds: adds(a.id) })) } : {}),
    ...(held.length ? { held: held.map((k) => ({ definitionId: k.id, name: k.name, reason: k.reason, adds: adds(k.id) })) } : {})
  };
}

export const UPDATE_THEME_COMPONENT_ARGS = z.object({
  definitionId: z.string().describe('The installed theme component to update, as the project summary, read_component or the selection names it.')
});

export const UPDATE_THEME_COMPONENT_DESCRIPTION =
  'Update one installed theme component to the theme\'s newer version, when the request needs something only that version has (a property, an option, a part, a variant or a slot: see newVersionAdds in read_component, inspect_element, the selection, or themeUpdates in the project summary). Every placement keeps its content and styles and gets the newer design; the update is in the turn\'s report and undone with the rest of it. Update only the components the request needs, never every one. The result is the updated contract: then make the change the user asked for in your next step. When a component\'s update is held, this explains why: tell the user, and offer another way.';
export const UPDATE_THEME_COMPONENT_BRIEF = 'Update one installed theme component to the newer theme version, when the request needs what it adds (newVersionAdds). Then make the change asked for. Update only what the request needs.';

/** The tool, offered while the project has a theme update it can take; its definitionId is one of those. */
export function updateThemeComponentTool(state: ProjectState, describe: { description: string; brief?: string }): ToolDefinition | null {
  const ids = themeUpdatesOf(state).available.map((a) => a.id).filter((id) => Object.hasOwn(state.components, id));
  if (!ids.length) return null;
  return {
    name: 'update_theme_component',
    ...describe,
    parameters: {
      type: 'object',
      properties: { definitionId: { type: 'string', enum: ids, description: 'The installed theme component to update.' } },
      required: ['definitionId'],
      additionalProperties: false
    }
  };
}

/** Update one definition: the operation the Project health panel sends, for this one definition, granted to this call alone. */
export async function runUpdateThemeComponent(args: z.infer<typeof UPDATE_THEME_COMPONENT_ARGS>, host: ToolHost, callId: string): Promise<ToolOutcome> {
  const state = host.state();
  const def = Object.hasOwn(state.components, args.definitionId) ? state.components[args.definitionId] : undefined;
  // A theme component the project has not installed yet is placed at the theme's current version.
  if (!def) {
    const themed = catalogueComponent(state.site.themeId, args.definitionId);
    const message = themed ? `"${themed.name}" is not installed yet: placing it uses the theme's current version.` : `No component "${args.definitionId}".`;
    return { ok: false, content: { error: 'INVALID_ARGUMENT', message } };
  }
  const next = newerVersion(state, def);
  if (!next) return { ok: false, content: { error: 'INVALID_ARGUMENT', message: `"${def.name}" has no newer theme version: it is ${def.owner === 'project' ? "the project's own component" : 'already current'}.` } };
  const held = themeUpdatesOf(state).kept.find((k) => k.id === def.id);
  const adds = themeUpdateChanges(def, next);
  if (held)
    return {
      ok: false,
      content: { error: 'UPDATE_HELD', message: `"${def.name}" cannot be updated: ${held.reason}`, newVersionAdds: Object.keys(adds).length ? adds : null, note: heldNote(held.reason) }
    };
  const ops: EditOperation[] = [{ type: 'theme.refresh', definitionIds: [def.id] }];
  const res = await host.apply(ops, host.revision(), `Update ${def.name} to the theme's newer version`, callId, { themeRefresh: def.id });
  if (!res.ok) return { ok: false, content: { ok: false, revision: res.revision, error: res.error } };
  const now = host.state().components[def.id] ?? next;
  return {
    ok: true,
    mutated: true,
    ops,
    results: res.results,
    content: {
      ok: true,
      revision: res.revision,
      updated: def.name,
      added: Object.keys(adds).length ? adds : null,
      component: componentDetail(now),
      note: 'Updated: every placement now uses this contract. Make the change the user asked for in your next step, with this revision.'
    }
  };
}
