import type { ChatContext } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { newId } from '@shared/ids';
import { projectDefinitionId } from '@shared/component-ids';

/** Where Create component puts a new component's first placement: a page, and its place among the page's sections. */
export interface NewComponentPlace {
  pageId: string;
  /** Among the page's top-level sections; left out, at the end. */
  index?: number;
}

/**
 * Where a new component's first placement goes. On a page, where the next section would go. While a component is
 * edited everywhere, the end of the page that editing was entered from: inserting where the editor points then
 * would change the design being edited, on every placement of it. Null when there is no page to place it on.
 */
export function newComponentPlace(state: ProjectState, view: { pageId: string | null; definitionMode: { returnPageId: string } | null }, sectionIndex?: number): NewComponentPlace | null {
  const editing = view.definitionMode?.returnPageId;
  const pageId = editing ?? view.pageId;
  if (!pageId || !Object.hasOwn(state.pages, pageId)) return null;
  return editing || sectionIndex === undefined ? { pageId } : { pageId, index: sectionIndex };
}

/**
 * The one change Start blank makes: an empty component, and its first placement on the page, so one Undo takes
 * back both. The IDs are named ahead, so the editor can open the new design on that placement.
 */
export function startBlankOps(place: NewComponentPlace, name: string, description: string) {
  const definitionId = projectDefinitionId(name);
  const nodeId = newId('n');
  const desc = description.trim();
  const ops: EditOperation[] = [
    { type: 'component.create', definitionId, name: name.trim(), ...(desc ? { description: desc } : {}) },
    { type: 'node.insert', newNodeId: nodeId, owner: { kind: 'page', id: place.pageId }, parentId: null, ...(place.index !== undefined ? { index: place.index } : {}), definitionId }
  ];
  return { ops, definitionId, nodeId };
}

/** What Build with AI asks for, in the author's own words: the name they chose and what they described. */
export function componentRequest(name: string, description: string): string {
  const n = name.trim().replace(/"/g, '”');
  const d = description.trim();
  if (n && d) return `Create a component called "${n}": ${d}`;
  if (n) return `Create a component called "${n}".`;
  return `Create a component: ${d}`;
}

/**
 * The context a Build with AI request is sent with: about the whole site, on the page the author is working on, and
 * marked as a new component, so the run is given what building one takes.
 */
export function componentRequestContext(state: ProjectState, place: NewComponentPlace | null, viewport: number): ChatContext {
  const pageId = place?.pageId ?? state.site.homePageId;
  return { pageId, pageTitle: state.pages[pageId]?.title ?? '', selection: null, selectionLabel: null, viewport, mode: 'edit', task: 'component' };
}
