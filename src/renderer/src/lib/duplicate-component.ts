/**
 * Duplicate component (spec §8.4): a definition copied under a new project component, with every placement left on
 * the original. The engine copies whatever name it is given, so telling copies apart is the editor's job.
 */
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, ProjectState } from '@shared/types';

/** The longest component name an operation accepts. */
const NAME_MAX = 60;
/** One trailing " copy" or " copy 3" that an earlier duplicate added. */
const COPY_SUFFIX = /\s+copy(?:\s+\d+)?$/i;

/** Whether a component can be duplicated from a menu: never the header or footer, and code only in Developer mode. */
export const canDuplicate = (def: ComponentDefinition, developerMode: boolean): boolean => def.category !== 'shell' && (developerMode || def.kind !== 'code');

/** `name` cut to `max` without splitting a character in two. */
const cut = (name: string, max: number) => (name.length <= max ? name : name.slice(0, /[\uD800-\uDBFF]/.test(name[max - 1]) ? max - 1 : max).trimEnd());

/**
 * The name offered for a duplicate: "Card copy", then "Card copy 2" and so on, whichever no component in the project
 * has yet. Duplicating a copy carries on its series rather than stacking "copy".
 */
export function duplicateName(state: ProjectState, name: string): string {
  const stem = name.trim().replace(COPY_SUFFIX, '') || 'Component';
  const taken = new Set(Object.values(state.components).map((d) => d.name.trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const candidate = `${cut(stem, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The change the dialog sends. A suggestion the author left as it was is settled against the project as it is by
 * then, so a component that took the name while the dialog was open doesn't leave two alike.
 */
export function duplicateOperation(state: ProjectState, def: ComponentDefinition, chosen: string, suggested: string): EditOperation {
  return { type: 'component.duplicate', definitionId: def.id, name: chosen === suggested ? duplicateName(state, def.name) : chosen };
}
