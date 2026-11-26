/**
 * Where a contact form sends visitors' messages, as a live session's guests may not change it (#765). The form's own
 * destinations (FORM_DESTINATIONS) are refused by name before a guest's batch runs (shared/live/capabilities.ts); this
 * follows them through the designs that pass a value on to a form, which only the project can show.
 */
import type { ComponentDefinition, GraphNode, OwnerKind, ProjectState } from '@shared/types';
import { FORM_DESTINATIONS } from '@catalogue/foundation/form';
import { sendsFormMessages } from './component-package';
import { codeImports } from './definitions';
import { allTrees, enclosingRepeatProp } from './tree';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The properties of each component that decide where a contact form sends its messages: a form's own destinations,
 * and every property of a design that passes a value on to one of those, however deep. A whole property or one field
 * of it passed on protects that property; an item's field passed on inside a repeat protects the list it repeats.
 * Code decides in its source what it passes on, so code that places a form (and is not one) has all its properties
 * protected.
 */
export function formDestinationProps(state: ProjectState): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const defs = Object.values(state.components);
  for (const d of defs) if (sendsFormMessages(d)) out.set(d.id, new Set(FORM_DESTINATIONS));
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
        if (!sendsFormMessages(d) && [...out.keys()].some((id) => codeImports(state, d, id))) for (const prop of Object.keys(d.properties)) changed = protect(d, prop) || changed;
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
 * does not. A placement that was there before keeps every destination it had, whatever the batch did to it (a swap to
 * another design included). A new one (inserted, duplicated, detached, or moved from another page) may have none, or
 * only a destination the host already set somewhere: in a placement before, or in a design or its defaults, which
 * guests never write.
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
      for (const p of is.get(n.definitionId) ?? []) {
        const now = valueOf(after, n, p);
        if (prior ? now === valueOf(before, prior, p) : allowed.has(now)) continue;
        const name = after.components[n.definitionId]?.name ?? 'a contact form';
        return `Only the host can change where “${name}” sends its messages.`;
      }
    }
  }
  return null;
}
