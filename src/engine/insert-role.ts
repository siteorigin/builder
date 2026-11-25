/**
 * How a project component goes into a page when it is inserted: as one of the page's sections, or as an element inside
 * a layout. Read by Insert in the editor and by the personal component library (#372), which records it when a
 * component is saved so a project that has never seen the component places it the same way.
 */
import type { OwnerRef, ProjectState } from '@shared/types';
import { catalogueComponent } from '@catalogue/index';
import { allTrees, findParent } from './tree';

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

/**
 * How the site's theme component `componentId` goes into a page: as the project has it once installed (see
 * definitionRole), else as the theme ships it. A theme's block (a feature card, a stat card) ships to insert as an
 * element; every other theme component is a section.
 */
export function catalogueRole(state: ProjectState, componentId: string): InsertRole {
  const def = catalogueComponent(state.site.themeId, componentId);
  if (!def) return 'section';
  if (own(state.components, def.id)) return definitionRole(state, def.id);
  return def.insertAs === 'element' ? 'element' : 'section';
}

/** The role the editor tells from the design alone, as if the author had not chosen one: what Automatic means. */
export function inferredRole(state: ProjectState, definitionId: string): InsertRole {
  const def = own(state.components, definitionId);
  if (!def || def.insertAs === undefined) return definitionRole(state, definitionId);
  const unchosen = { ...def };
  delete unchosen.insertAs;
  return definitionRole({ ...state, components: { ...state.components, [definitionId]: unchosen } }, definitionId);
}

/**
 * What one placement is where it sits, for the Inspector's words (#661): a component inside a column, container,
 * slot or another component's design, or one whose role is an element wherever it sits, is a component; one of a
 * page's (or layout's, or shared part's) own top-level sections is a section.
 */
export function placementRole(state: ProjectState, owner: OwnerRef, nodeId: string): InsertRole {
  if (owner.kind === 'component') return 'element';
  const tree =
    owner.kind === 'page'
      ? own(state.pages, owner.id)
      : owner.kind === 'shell'
        ? owner.id === 'header' || owner.id === 'footer'
          ? state.site.shell[owner.id]
          : undefined
        : own(state.collections ?? {}, owner.id)?.settings.template;
  const parent = tree ? findParent(tree, nodeId) : null;
  if (parent && parent.parentId !== null) return 'element';
  const node = tree ? own(tree.nodes, nodeId) : undefined;
  return node?.kind === 'instance' ? definitionRole(state, node.definitionId) : 'section';
}
