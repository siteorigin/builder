import type { EditorOpening } from './api';
import type { ProjectState } from './types';
import { pageShowing } from './page-shell';

/**
 * Whether what the assistant opens in the editor (#1406) is still in the site `state` holds: an entry, or a section's
 * page and node, deleted since it was found is never opened. An editor view always is.
 */
export function openingInSite(state: ProjectState, opening: EditorOpening): boolean {
  if (opening.kind === 'entry') return Object.hasOwn(state.collections ?? {}, opening.collectionId) && Object.hasOwn(state.collections[opening.collectionId].entries ?? {}, opening.entryId);
  if (opening.kind === 'section') {
    if (!Object.hasOwn(state.pages, opening.pageId)) return false;
    const owner = opening.ref.owner;
    // A shared part shows on its page only while that page shows it.
    const tree = owner.kind === 'page' ? (Object.hasOwn(state.pages, owner.id) ? state.pages[owner.id] : undefined) : owner.kind === 'shell' && (owner.id === 'header' || owner.id === 'footer') && pageShowing(state, owner.id, opening.pageId) === opening.pageId ? state.site.shell[owner.id] : undefined;
    return !!tree && Object.hasOwn(tree.nodes, opening.ref.nodeId);
  }
  return true;
}
