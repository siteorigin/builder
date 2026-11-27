/**
 * What a live session's guests may not do to the project, checked against the project as a guest's batch would leave
 * it (#765), where the operations alone cannot show it: change where a contact form sends visitors' messages, through
 * whatever design passes its settings on, or add a dated article (copying one included). The form's own destinations
 * (FORM_DESTINATIONS) are also refused by name before a guest's batch runs (shared/live/capabilities.ts).
 */
import type { ComponentDefinition, GraphNode, OwnerKind, ProjectState } from '@shared/types';
import { formDestinationProps } from './form-destinations';
import { allTrees } from './tree';

type Instance = Extract<GraphNode, { kind: 'instance' }>;

const text = (value: unknown) => (value === undefined ? 'undefined' : JSON.stringify(value));
const defaultOf = (def: ComponentDefinition | undefined, prop: string): unknown => (def && Object.hasOwn(def.properties, prop) ? (def.properties[prop] as { default?: unknown }).default : undefined);

/**
 * A placement's value of a property, as text to compare: its own or its design's default, and the collection a list
 * is connected to, whose entries then stand in for the list's items.
 */
function valueOf(state: ProjectState, n: Instance, prop: string): string {
  const own = n.props && Object.hasOwn(n.props, prop) ? n.props[prop] : undefined;
  const value = text(own ?? defaultOf(Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined, prop));
  const source = n.listSources && Object.hasOwn(n.listSources, prop) ? n.listSources[prop] : undefined;
  return source === undefined ? value : `${value}\u0000${JSON.stringify(source)}`;
}

const EMPTY = new Set(['undefined', 'null', '""']);

/**
 * Why `after` changes where a contact form on a page or in the header or footer sends its messages, or null when it
 * does not. A placement that was there before keeps every setting that decides it, and is never swapped into or out
 * of a design that has such settings. A new one (inserted, duplicated, detached, or moved from another page) may have
 * none, or only what the host already set for that same setting of that same design: in a placement before, or in
 * a design or its defaults, which guests never write. So a guest never sends a form's messages anywhere the host did
 * not choose for it.
 */
export function guestDestinationChange(before: ProjectState, after: ProjectState, owners: readonly OwnerKind[] = ['page', 'shell']): string | null {
  const was = formDestinationProps(before);
  const is = formDestinationProps(after);
  const edited = (kind: OwnerKind) => owners.includes(kind);
  // What the host set, by design and setting: a value used as one design's recipient is never another's.
  const allowed = new Set<string>();
  const at = (definitionId: string, prop: string, value: string) => `${definitionId}\u0000${prop}\u0000${value}`;
  const allows = (definitionId: string, prop: string, value: string) => EMPTY.has(value) || allowed.has(at(definitionId, prop, value));
  const collect = (state: ProjectState, props: Map<string, Set<string>>, which: (kind: OwnerKind) => boolean) => {
    for (const { owner, tree } of allTrees(state)) {
      if (!which(owner.kind)) continue;
      for (const n of Object.values(tree.nodes)) if (n.kind === 'instance') for (const p of props.get(n.definitionId) ?? []) allowed.add(at(n.definitionId, p, valueOf(state, n, p)));
    }
    for (const [id, set] of props) for (const p of set) allowed.add(at(id, p, text(defaultOf(state.components[id], p))));
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
        if (prior ? now === valueOf(before, prior, p) : allows(n.definitionId, p, now)) continue;
        return `Only the host can change where “${name}” sends its messages.`;
      }
    }
  }
  return null;
}

/**
 * Why a guest's batch, leaving the project as `after`, does something only the host may, or null when it does not:
 * adds a dated article (a copy of one included: whether and when the site publishes news is the host's), adds more
 * than GUEST_BATCH_MAX_NEW_ELEMENTS elements, or changes where a contact form sends its messages
 * (guestDestinationChange).
 */
export function guestEditProblem(before: ProjectState, after: ProjectState): string | null {
  for (const [id, page] of Object.entries(after.pages)) if (!Object.hasOwn(before.pages, id) && page.article) return 'Only the host can add an article.';
  if (elements(after) - elements(before) > GUEST_BATCH_MAX_NEW_ELEMENTS) return `One edit may add at most ${GUEST_BATCH_MAX_NEW_ELEMENTS} elements.`;
  return guestDestinationChange(before, after);
}

/**
 * How many elements one guest batch may add to the pages and the header and footer. Copies can each double what the
 * next copies, batch after batch, so the project only ever grows a little at a time from guests' edits.
 */
export const GUEST_BATCH_MAX_NEW_ELEMENTS = 2_000;

/** The elements on the site's pages and in its header and footer. */
function elements(state: ProjectState): number {
  let n = 0;
  for (const { owner, tree } of allTrees(state)) if (owner.kind === 'page' || owner.kind === 'shell') n += Object.keys(tree.nodes).length;
  return n;
}
