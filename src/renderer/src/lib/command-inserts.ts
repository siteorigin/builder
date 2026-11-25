/**
 * What the command menu offers to insert (#174): the project's own components, the basic elements and the theme's
 * sections, in the order the Insert panel lists them and found by the same words, and where each would land if chosen
 * now.
 */
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { catalogueEntries } from '@catalogue/index';
import { dependsOn } from '@engine/apply';
import { insertAt, insertRole, slotWhere, whereFor, whereText } from './insert-at';
import type { SlotTarget } from './slot-target';
import { BASICS, basicHay, basicSpec, projectInsertDefinitions, type InsertSpec } from './insert-search';

export interface InsertChoice {
  /** `ins:c:` and a project component's id, `ins:e:` and a basic element's, or `ins:` and a theme section's. */
  id: string;
  name: string;
  /** What it is, shown beside the name, so a component and a basic element with the same name are told apart. */
  kind: 'Component' | 'Code component' | 'Layout' | 'Element' | 'Section';
  /** The Lucide icon a basic element or theme section is drawn with, as in the Insert panel. */
  icon?: string;
  /** Other words it is found by: a component's description, an element's tags. */
  keywords: string;
  spec: InsertSpec;
}

/**
 * Everything the menu can insert, in the Insert panel's order: the project's components first (code ones only in
 * Developer mode), then the column layouts and basic elements, then the theme's sections.
 */
export function insertChoices(state: ProjectState, developerMode: boolean): InsertChoice[] {
  return [
    ...projectInsertDefinitions(state, developerMode).map(
      (d): InsertChoice => ({ id: `ins:c:${d.id}`, name: d.name, kind: d.kind === 'code' ? 'Code component' : 'Component', keywords: `${d.description ?? ''} ${d.kind === 'code' ? 'code ' : ''}component`.trim(), spec: { definitionId: d.id } })
    ),
    ...BASICS.map((b): InsertChoice => ({ id: `ins:e:${b.id}`, name: b.name, kind: b.layout ? 'Layout' : 'Element', icon: b.icon, keywords: basicHay(b), spec: basicSpec(b) })),
    ...catalogueEntries(state.site.themeId).map((e): InsertChoice => ({ id: `ins:${e.componentId}`, name: e.name, kind: 'Section', icon: e.icon, keywords: '', spec: { componentId: e.componentId } }))
  ];
}

/**
 * Where `spec` lands if it is inserted now, in words ("after Split hero", "in a new section at the end of Home"), placed
 * as insert() places it: in `owner`, the page, component or template being edited, relative to `selection`. Otherwise
 * why it cannot go in, said short enough to sit beside the row.
 */
export function insertLanding(state: ProjectState, owner: OwnerRef | null, selection: ElementRef | null, spec: InsertSpec, target: SlotTarget | null = null): { where: string } | { refused: string } {
  // The engine refuses a component inside itself, or inside one it holds; the row says so before it is chosen.
  if (spec.definitionId && owner?.kind === 'component' && (spec.definitionId === owner.id || dependsOn(state, spec.definitionId, owner.id))) return { refused: 'Would contain itself' };
  const role = insertRole(state, spec);
  const at = owner ? insertAt(state, owner, role, selection, spec.definitionId, target) : null;
  // Into a picked slot (`target`, see insertAt), named with its component.
  const where = at ? (target ? slotWhere(state, target) : whereFor(state, at, role)) : null;
  return where ? { where: whereText(where) } : { refused: 'Nowhere to insert' };
}
