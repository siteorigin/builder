/**
 * Which properties decide where a contact form sends what visitors write (#765, #1127): a form's service and its
 * setting, and every property of a design that passes a value on to one of those. A live session's guests may not change
 * them (./guest-edits), and no entry or row of a collection may fill them (./collection-sources), so neither a guest nor
 * an entry's text (written in the editor, or synced from an outside CMS) sends visitors' messages anywhere else.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { FORM_DESTINATIONS, FORM_SERVICES, sendsFormMessages } from '@catalogue/foundation/form';
import { codeImports } from './code-imports';
import { enclosingRepeatProp } from './tree';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A form's settings that decide where its messages go: the service it uses, and that service's own setting. */
export const FORM_ROUTING_PROPS: readonly string[] = ['provider', ...new Set(Object.values(FORM_SERVICES).map((s) => s.prop))];

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
    out.set(d.id, new Set(FORM_ROUTING_PROPS.filter((k) => Object.hasOwn(d.properties, k))));
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
        // A form's own code reads its settings; any other code that places one (even one with a setting's name) may
        // pass it any of its properties.
        if (!sendsFormMessages(d) && [...out.keys()].some((id) => id !== d.id && codeImports(state, d, id))) for (const prop of Object.keys(d.properties)) changed = protect(d, prop) || changed;
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

/** Whether a property of a design decides where a contact form sends (formDestinationProps). */
export type FormDestinationLookup = (definitionId: string, prop: string) => boolean;

/**
 * formDestinationProps as a question, worked out on the first one asked: one check over a whole project reads it as
 * often as it likes, and a project whose bindings never come near a form never walks its designs. Made for one state;
 * a later state (an edit made since) needs its own.
 */
export function formDestinationLookup(state: ProjectState): FormDestinationLookup {
  let props: Map<string, Set<string>> | undefined;
  return (definitionId, prop) => (props ??= formDestinationProps(state)).get(definitionId)?.has(prop) ?? false;
}
