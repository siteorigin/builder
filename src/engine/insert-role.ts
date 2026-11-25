/**
 * How a project component goes into a page when it is inserted: as one of the page's sections, or as an element inside
 * a layout. Read by Insert in the editor and by the personal component library (#372), which records it when a
 * component is saved so a project that has never seen the component places it the same way.
 */
import type { ProjectState } from '@shared/types';
import { allTrees } from './tree';

export type InsertRole = 'section' | 'element';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** Whether a definition has a placement inside a layout or inside another component's design. (One among a page's
 *  sections says little: Insert used to put every component there.) */
function placedInside(state: ProjectState, definitionId: string): boolean {
  for (const t of allTrees(state))
    for (const n of Object.values(t.tree.nodes)) if (n.kind === 'instance' && n.definitionId === definitionId && (t.owner.kind === 'component' || !t.tree.rootIds.includes(n.id))) return true;
  return false;
}

/**
 * Whether a component inserts as one of a page's sections or as an element inside a layout. Create component records
 * it (a card made inside a grid is an element); copies carry it on. A definition from before that placed inside a
 * layout anywhere is an element. Otherwise it is read from what it is: a theme's component, or a design whose root is
 * one, is a section, and so is a root that is a section element; a design rooted in any other element (a card, a
 * paragraph) is an element. Code with nothing to go on stays a section.
 */
export function definitionRole(state: ProjectState, definitionId: string, seen = new Set<string>()): InsertRole {
  const def = own(state.components, definitionId);
  if (!def || seen.has(def.id)) return 'section';
  seen.add(def.id);
  if (def.insertAs === 'section' || def.insertAs === 'element') return def.insertAs;
  if (def.owner === 'theme') return 'section';
  if (placedInside(state, def.id)) return 'element';
  const from = def.provenance?.forkedFrom;
  if (from && own(state.components, from)) return definitionRole(state, from, seen);
  const root = def.kind === 'managed' && def.tree ? own(def.tree.nodes, def.tree.rootIds[0] ?? '') : undefined;
  if (!root) return 'section';
  if (root.kind === 'instance') return definitionRole(state, root.definitionId, seen);
  if (root.kind === 'element' && root.tag === 'section') return 'section';
  return 'element';
}
