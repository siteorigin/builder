/**
 * What a live session's guests may not do to the project, checked against the project as a guest's batch would leave
 * it (#765), where the operations alone cannot show it: change where a contact form sends visitors' messages, through
 * whatever design passes its settings on, or add a dated article (copying one included). The form's own destinations
 * (FORM_DESTINATIONS) are also refused by name before a guest's batch runs (shared/live/capabilities.ts).
 */
import type { ComponentDefinition, GraphNode, OwnerKind, ProjectState } from '@shared/types';
import { FORM_DESTINATIONS, FORM_SERVICES } from '@catalogue/foundation/form';
import { sendsFormMessages } from './component-package';
import { codeImports } from './definitions';
import { allTrees, enclosingRepeatProp } from './tree';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A form's settings that decide where its messages go: the service it uses, and that service's own setting. */
const ROUTING = ['provider', ...new Set(Object.values(FORM_SERVICES).map((s) => s.prop))];

/**
 * The properties of each component that decide where a contact form sends its messages: a form's service and its
 * settings, and every property of a design that passes a value on to one of those, however deep. A form is the theme's
 * (or a copy whose code still reads its settings), or anything with a form destination's name, as the name check
 * refuses it. A whole property or one field of it passed on protects that property; an item's field passed on inside
 * a repeat protects the list it repeats. Code decides in its source what it passes on, so code that places a form
 * (and is not one) has all its properties protected.
 */
export function formDestinationProps(state: ProjectState): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const defs = Object.values(state.components);
  for (const d of defs) {
    if (!sendsFormMessages(d) && !FORM_DESTINATIONS.some((k) => Object.hasOwn(d.properties, k))) continue;
    out.set(d.id, new Set(ROUTING.filter((k) => Object.hasOwn(d.properties, k))));
  }
  const protect = (d: ComponentDefinition, prop: string | undefined): boolean => {
    if (!prop || !Object.hasOwn(d.properties, prop)) return false;
    const set = out.get(d.id) ?? new Set<string>();
    if (set.has(prop)) return false;
    out.set(d.id, set.add(prop));
    return true;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of defs) {
      if (d.kind === 'code') {
        if (!out.has(d.id) && [...out.keys()].some((id) => codeImports(state, d, id))) for (const prop of Object.keys(d.properties)) changed = protect(d, prop) || changed;
        continue;
      }
      for (const n of Object.values(d.tree?.nodes ?? {})) {
        if (n.kind !== 'instance') continue;
        for (const k of out.get(n.definitionId) ?? []) {
          const v = n.props?.[k];
          if (!isRecord(v)) continue;
          if (typeof v.$prop === 'string') changed = protect(d, v.$prop) || changed;
          else if (typeof v.$item === 'string') changed = protect(d, enclosingRepeatProp(d, n.id)) || changed;
        }
      }
    }
  }
  return out;
}

type Instance = Extract<GraphNode, { kind: 'instance' }>;

const text = (value: unknown) => (value === undefined ? 'undefined' : JSON.stringify(value));
const defaultOf = (def: ComponentDefinition | undefined, prop: string): unknown => (def && Object.hasOwn(def.properties, prop) ? (def.properties[prop] as { default?: unknown }).default : undefined);

/** A placement's value of a property, its own or its design's default, as text to compare. */
function valueOf(state: ProjectState, n: Instance, prop: string): string {
  const own = n.props && Object.hasOwn(n.props, prop) ? n.props[prop] : undefined;
  return text(own ?? defaultOf(Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined, prop));
}

const EMPTY = new Set(['undefined', 'null', '""']);

/**
 * Why `after` changes where a contact form on a page or in the header or footer sends its messages, or null when it
 * does not. A placement that was there before keeps every setting that decides it, and is never swapped into or out
 * of a design that has such settings. A new one (inserted, duplicated, detached, or moved from another page) may have
 * none, or only a destination the host already set somewhere: in a placement before, or in a design or its defaults,
 * which guests never write. So a guest never sends a form's messages anywhere the host did not choose.
 */
export function guestDestinationChange(before: ProjectState, after: ProjectState, owners: readonly OwnerKind[] = ['page', 'shell']): string | null {
  const was = formDestinationProps(before);
  const is = formDestinationProps(after);
  const edited = (kind: OwnerKind) => owners.includes(kind);
  const allowed = new Set<string>(EMPTY);
  const collect = (state: ProjectState, props: Map<string, Set<string>>, which: (kind: OwnerKind) => boolean) => {
    for (const { owner, tree } of allTrees(state)) {
      if (!which(owner.kind)) continue;
      for (const n of Object.values(tree.nodes)) if (n.kind === 'instance') for (const p of props.get(n.definitionId) ?? []) allowed.add(valueOf(state, n, p));
    }
    for (const [id, set] of props) for (const p of set) allowed.add(text(defaultOf(state.components[id], p)));
  };
  collect(before, was, () => true);
  collect(after, is, (kind) => !edited(kind));
  const placed = new Map<string, Instance>();
  for (const { owner, tree } of allTrees(before)) if (edited(owner.kind)) for (const n of Object.values(tree.nodes)) if (n.kind === 'instance') placed.set(`${owner.kind}:${owner.id}:${n.id}`, n);
  for (const { owner, tree } of allTrees(after)) {
    if (!edited(owner.kind)) continue;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      const prior = placed.get(`${owner.kind}:${owner.id}:${n.id}`);
      const name = after.components[n.definitionId]?.name ?? 'a contact form';
      // Swapped for another design, into or out of one that decides where a form sends: what carries over cannot be
      // matched setting for setting, so only the host makes that swap.
      if (prior && prior.definitionId !== n.definitionId && (was.has(prior.definitionId) || is.has(n.definitionId))) return `Only the host can change where “${name}” sends its messages.`;
      for (const p of is.get(n.definitionId) ?? []) {
        const now = valueOf(after, n, p);
        if (prior ? now === valueOf(before, prior, p) : allowed.has(now)) continue;
        return `Only the host can change where “${name}” sends its messages.`;
      }
    }
  }
  return null;
}

/**
 * Why a guest's batch, leaving the project as `after`, does something only the host may, or null when it does not:
 * adds a dated article (a copy of one included: whether and when the site publishes news is the host's), or changes
 * where a contact form sends its messages (guestDestinationChange).
 */
export function guestEditProblem(before: ProjectState, after: ProjectState): string | null {
  for (const [id, page] of Object.entries(after.pages)) if (!Object.hasOwn(before.pages, id) && page.article) return 'Only the host can add an article.';
  return guestDestinationChange(before, after);
}
