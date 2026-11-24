import { newId } from './ids';
import { slugify } from './routes';

/**
 * A new project component's definition ID, such as "proj.pricing-card-k3j9x". The editor allocates one ahead of a batch
 * that creates a component and places it, so the placement can name it.
 */
export function projectDefinitionId(name: string, prefix = 'proj'): string {
  return `${prefix}.${slugify(name) || 'component'}-${newId('x', 5).slice(2)}`;
}

/** The shape `projectDefinitionId` gives a managed component: one supplied with `component.create` must have it. */
export const PROJECT_DEFINITION_ID = /^proj\.[a-z0-9-]{1,60}-[a-z0-9]{5}$/;
