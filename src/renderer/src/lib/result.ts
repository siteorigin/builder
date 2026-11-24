/** Read-only helpers for the AI result card: the status of each check, and where a change's link goes. */
import type { ChatChange, ChatContext, ChatMessage, FieldLocation } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { locateField } from '@engine/locate';
import { refExists, resolveRef } from './model';
import { pageShowing, partName } from '@shared/page-shell';
import { editableDesign, requestComponentId } from './chatTarget';
import { canCarryOn, resultAsSaid, turnState, type TurnHistory } from '@shared/turns';

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

/**
 * What a change says, and its technical detail. Results stored before changes had readable labels can carry a
 * raw operation name ("node.setContent") as the label; that is detail, not words for an author.
 */
export function changeText(c: ChatChange): { label: string; operations: string[] } {
  if (!c.operations && /^[a-z]+\.[A-Za-z]+$/.test(c.label)) return { label: 'Made a change', operations: [c.label] };
  return { label: c.label, operations: c.operations ?? [] };
}

/** A change can be shown when it names a page, or an element of the shared header or footer. */
export const canOpen = (c: ChatChange) => !!c.pageId || (c.owner?.kind === 'shell' && !!c.nodeId);

export type ChangeTarget = { error: string } | { pageId: string; selection: ElementRef | null; note?: string };

/**
 * Where showing a change goes: its page (for the shared header or footer, the page on screen when it shows
 * it, or else the first page that does), and the element when it is still there. Null when there is nothing
 * to show.
 */
export function changeTarget(state: ProjectState, currentPageId: string | null, c: ChatChange): ChangeTarget | null {
  const owner = c.pageId ? { kind: 'page' as const, id: c.pageId } : c.owner?.kind === 'shell' ? c.owner : null;
  if (!owner) return null;
  const pageId = owner.kind === 'page' ? (state.pages[owner.id] ? owner.id : undefined) : pageShowing(state, owner.id, currentPageId);
  if (!pageId) return { error: owner.kind === 'page' ? 'That page is no longer in the site.' : `No page shows ${partName(owner.id)}.` };
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

/**
 * Where "Open in inspector" goes for a located field, worked out now: the component and list item are found by
 * their IDs wherever they have moved, and the field by the same rules the answer named it with. A field that
 * has gone, or is no longer shown in the Inspector, is never swapped for another one that looks like it.
 */
export function locationTarget(state: ProjectState, currentPageId: string | null, l: FieldLocation): { pageId: string; selection: ElementRef } | { error: string } {
  const found = locateField(state, l, currentPageId);
  if (!found.ok) return { error: `${l.path.at(-1) ?? 'That field'} can no longer be opened. ${found.message}` };
  return { pageId: found.pageId, selection: { owner: found.owner, instancePath: [], nodeId: l.nodeId } };
}

/**
 * The result that offers Continue: the conversation's last message, when it is a request that ended unfinished.
 * An older unfinished card does not, since a newer request has moved on from it, and neither does one that changed
 * the site unless its changes are known to be in it: once undone, there is nothing to carry on from until a Redo.
 */
export function resumableId(messages: ChatMessage[], history?: TurnHistory | null): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || !last.result?.incomplete || (last.result.status !== 'completed' && last.result.status !== 'no-changes')) return undefined;
  return canCarryOn(turnState(last, history)) ? last.id : undefined;
}

/**
 * The turn that offers Undo turn: the one whose step is the newest applied in History, whichever way History got
 * there. History undoes in order, so any later edit, manual or AI, takes it away, and a Redo from the toolbar or
 * History that reapplies the turn brings it back (issue 276).
 */
export function undoableId(messages: ChatMessage[], history: (TurnHistory & { canUndo: boolean }) | null | undefined): string | undefined {
  if (!history?.canUndo) return undefined;
  const top = [...history.entries].reverse().find((e) => e.applied)?.runId;
  return top ? messages.find((m) => m.role === 'assistant' && m.runId === top && !!m.result && resultAsSaid(m.result, m.text).result.canUndo)?.id : undefined;
}

/**
 * The result that offers Try again: the conversation's last message, when its request failed because of the AI
 * setup (the server, the model or the key) rather than anything in the request, so it can be sent again unchanged.
 */
export function retryableId(messages: ChatMessage[]): string | undefined {
  const last = messages.at(-1);
  return last?.role === 'assistant' && last.result?.status === 'failed' && !!last.result.repair ? last.id : undefined;
}

/**
 * The context a Continue (or a Try again) is sent with: that of the request it continues, checked against the
 * project as it is now. When its page or selected element has gone, nothing is guessed (another page, or a
 * selection dropped so the request reaches the whole site): the user chooses where to carry on and does `next`.
 */
export function continueContext(user: ChatMessage | undefined, state: ProjectState, viewport: number, next = 'send "Continue"'): { ctx: ChatContext } | { error: string } {
  const choose = `Choose what to change, then ${next}.`;
  if (user?.role !== 'user') return { error: choose };
  const ctx = user.context;
  // Requests saved before messages carried a context were about the whole site.
  if (!ctx) return { ctx: { pageId: state.site.homePageId, pageTitle: state.pages[state.site.homePageId]?.title ?? '', selection: null, selectionLabel: null, viewport } };
  const pageOk = !!ctx.pageId && Object.hasOwn(state.pages, ctx.pageId);
  // A request about a component edited everywhere carries on with that component, wherever it was shown.
  let page: Pick<ChatContext, 'pageId' | 'pageTitle'> | null = null;
  const componentId = requestComponentId(ctx);
  if (componentId) {
    if (!editableDesign(state, componentId)) return { error: `${ctx.component?.name || ctx.selectionLabel || 'That component'} is no longer in the site. ${choose}` };
    // The page only showed it, so another one does as well.
    if (!pageOk) page = { pageId: state.site.homePageId, pageTitle: state.pages[state.site.homePageId]?.title ?? '' };
  } else if (!pageOk) return { error: `${ctx.pageTitle || 'That page'} is no longer in the site. ${choose}` };
  if (ctx.selection) {
    let found = false;
    try {
      // Its part and list item too: Continue never sends a request about a card that has gone.
      found = refExists(state, ctx.selection);
    } catch {
      found = false;
    }
    if (!found) return { error: `${ctx.selectionLabel ?? 'The selected element'} is no longer in the site. ${choose}` };
  }
  // The images the request was about go with it; one removed since cannot.
  const gone = (Array.isArray(ctx.assetIds) ? ctx.assetIds : []).filter((id) => typeof id !== 'string' || state.assets.assets[id]?.kind !== 'image');
  if (gone.length) {
    const name = user.images?.find((i) => i.assetId === gone[0])?.name;
    return { error: `${name ? `The image “${name}”` : 'An image attached to that request'} is no longer in Assets. Attach the images you want, then ${next}.` };
  }
  return { ctx: { ...structuredClone(ctx), ...page } };
}
