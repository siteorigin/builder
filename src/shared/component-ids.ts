import { newId } from './ids';
import { slugify } from './routes';

/**
 * A new project component's definition ID, such as "proj.pricing-card-k3j9x". The editor allocates one ahead of a batch
 * that creates a component and places it, so the placement can name it.
 */
export function projectDefinitionId(name: string, prefix = 'proj'): string {
  // A slug cut to its length limit can end on a hyphen ("&" spells out as "and" first): never doubled before the suffix.
  return `${prefix}.${slugify(name).replace(/-+$/, '') || 'component'}-${newId('x', 5).slice(2)}`;
}

/**
 * The shape `projectDefinitionId` gives a managed component, which one supplied with `component.create` must have: a
 * slug as `slugify` makes it (no doubled, leading or trailing hyphens), so no two IDs share a generated file name.
 */
export const PROJECT_DEFINITION_ID = /^proj\.(?=[a-z0-9-]{1,60}-[a-z0-9]{5}$)[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{5}$/;
