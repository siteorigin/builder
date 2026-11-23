/** Read-only helpers for the AI result card: the status of each check, and where a change's link goes. */
import type { ChatChange, ChatMessage } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { resolveRef } from './model';

/** Checks that need attention, read from the wording of results stored before checks carried a status. */
const ISSUE = /wider than the screen|overflows its box|(?<!no )horizontal overflow detected|issues? remains?|could(?: not|n['’]t) (?:run|check)|^stopped at /i;

/** Each check's text by status: stored with newer results, read from the wording of older ones. */
export function checksOf(r: Pick<NonNullable<ChatMessage['result']>, 'checks' | 'validation'>) {
  const checks = r.checks ?? r.validation.map((text) => ({ status: ISSUE.test(text) ? ('issue' as const) : ('pass' as const), text }));
  return {
    issues: checks.filter((c) => c.status === 'issue').map((c) => c.text),
    unverified: checks.filter((c) => c.status === 'unverified').map((c) => c.text),
    passes: checks.filter((c) => c.status === 'pass').map((c) => c.text)
  };
}

/** A change can be shown when it names a page, or an element of the shared header or footer. */
export const canOpen = (c: ChatChange) => !!c.pageId || (c.owner?.kind === 'shell' && !!c.nodeId);

export type ChangeTarget = { error: string } | { pageId: string; selection: ElementRef | null; note?: string };

/**
 * Where showing a change goes: its page (for the shared header and footer, the page on screen when it shows
 * them, or else the first page that does), and the element when it is still there. Null when there is nothing
 * to show.
 */
export function changeTarget(state: ProjectState, currentPageId: string | null, c: ChatChange): ChangeTarget | null {
  const owner = c.pageId ? { kind: 'page' as const, id: c.pageId } : c.owner?.kind === 'shell' ? c.owner : null;
  if (!owner) return null;
  const showsShell = (id: string | null | undefined) => !!id && !!state.pages[id] && state.pages[id].shell !== 'none';
  const pageId = owner.kind === 'page' ? (state.pages[owner.id] ? owner.id : undefined) : showsShell(currentPageId) ? currentPageId! : state.site.pageOrder.find(showsShell);
  if (!pageId) return { error: owner.kind === 'page' ? 'That page is no longer in the site.' : 'No page shows the shared header and footer.' };
  if (!c.nodeId) return { pageId, selection: null };
  const ref: ElementRef = { owner, instancePath: [], nodeId: c.nodeId };
  let exists = false;
  try {
    exists = !!resolveRef(state, ref).node;
  } catch {
    exists = false;
  }
  if (exists) return { pageId, selection: ref };
  return { pageId, selection: null, note: `That element is no longer on ${owner.kind === 'page' ? state.pages[pageId].title : `the shared ${owner.id}`}. Showing the page instead.` };
}
