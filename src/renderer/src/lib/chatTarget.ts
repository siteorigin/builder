/**
 * What the AI composer's next message is about. On a page: that page, and the selected element when the selection
 * switch is on. While a component is edited everywhere: that component's whole design, or one of its own nodes,
 * never the page the canvas happens to show it on. The chips show it and the message is sent with it, from one place.
 */
import type { ChatContext } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { inDefinition, refLabel, resolveRef } from './model';

type DefinitionMode = { definitionId: string; returnPageId: string } | null;

export interface ComposerScope {
  /** The page the editor shows; while a component is edited everywhere, the page it is shown on. */
  page: { id: string; title: string } | null;
  /** The component edited everywhere, while it is. */
  component: { id: string; name: string } | null;
  /** The element the next message can be limited to, and its label. */
  selection: ElementRef | null;
  selectionLabel: string | null;
}

const resolves = (state: ProjectState, ref: ElementRef) => {
  try {
    return !!resolveRef(state, ref).node;
  } catch {
    return false;
  }
};

/** A component design the project still has, which a request can be about. */
function editableDesign(state: ProjectState, id: string | null | undefined) {
  const def = id && Object.hasOwn(state.components, id) ? state.components[id] : undefined;
  return def?.kind === 'managed' && def.tree ? def : null;
}

export function composerScope(state: ProjectState, view: { pageId: string | null; selection: ElementRef | null; definitionMode: DefinitionMode }): ComposerScope {
  const p = view.pageId && Object.hasOwn(state.pages, view.pageId) ? state.pages[view.pageId] : null;
  const page = p ? { id: p.id, title: p.title } : null;
  const def = editableDesign(state, view.definitionMode?.definitionId);
  if (def) {
    // Only the design's own nodes: anything else (a pick the canvas has yet to convert) is not offered.
    const selection = view.selection && inDefinition(view.selection, def.id) && resolves(state, view.selection) ? view.selection : null;
    return { page, component: { id: def.id, name: def.name }, selection, selectionLabel: selection ? refLabel(state, selection) : null };
  }
  return { page, component: null, selection: view.selection, selectionLabel: view.selection ? refLabel(state, view.selection) : null };
}

/** The context a message is sent with, frozen at send time. `enabled` holds the composer's page and selection switches. */
export function chatContextFor(state: ProjectState, scope: ComposerScope, opts: { enabled: { page: boolean; selection: boolean }; viewport: number; assetIds?: string[]; ask?: boolean }): ChatContext {
  const home = state.site.homePageId;
  const page = opts.enabled.page ? scope.page : null;
  const selection = opts.enabled.selection ? scope.selection : null;
  return {
    pageId: page ? page.id : home,
    pageTitle: page ? page.title : (state.pages[home]?.title ?? ''),
    selection: selection ? structuredClone(selection) : null,
    selectionLabel: selection ? scope.selectionLabel : null,
    ...(scope.component ? { component: { ...scope.component } } : {}),
    viewport: opts.viewport,
    // The images go by asset ID only; the app checks they are still in Assets before anything is sent.
    ...(opts.assetIds?.length ? { assetIds: [...opts.assetIds] } : {}),
    ...(opts.ask ? { mode: 'ask' as const } : {})
  };
}

/** How a sent message names what it was about: its page, or the component it edited everywhere, then the element. */
export function targetOf(ctx?: ChatContext | null): string {
  if (!ctx) return '';
  // A transcript is read back from disk: a malformed component is left out.
  const where = typeof ctx.component?.name === 'string' ? `${ctx.component.name} everywhere` : ctx.pageTitle;
  return ctx.selectionLabel ? `${where} → ${ctx.selectionLabel}` : where;
}

/**
 * Where "Edit and try again" puts the editor for a request: on its page, editing its component everywhere (or not),
 * with its selection, each checked against the project as it is now. A target that has gone is dropped rather than
 * restored, and `missing` names it, so the author chooses a new one instead of sending the request somewhere else.
 */
export function retryView(
  state: ProjectState,
  ctx: ChatContext | undefined,
  now: { pageId: string | null; definitionMode: DefinitionMode }
): { pageId?: string; definitionMode: DefinitionMode; selection: ElementRef | null; missing: string | null } {
  const pageOk = !!ctx?.pageId && Object.hasOwn(state.pages, ctx.pageId);
  // Leaving a component edited everywhere goes back to the page it was entered from.
  const leave = now.definitionMode ? { pageId: now.definitionMode.returnPageId } : {};
  // Requests saved before they named their component still name it through a selection inside it.
  const componentId = ctx?.component?.id ?? (ctx?.selection?.owner.kind === 'component' ? ctx.selection.owner.id : null);
  if (ctx && componentId) {
    const def = editableDesign(state, componentId);
    if (!def) return { ...leave, definitionMode: null, selection: null, missing: ctx.component?.name ?? ctx.selectionLabel ?? 'The component' };
    const selOk = !!ctx.selection && inDefinition(ctx.selection, def.id) && resolves(state, ctx.selection);
    const pageId = pageOk ? ctx.pageId : (now.pageId ?? state.site.homePageId);
    return {
      pageId,
      definitionMode: { definitionId: def.id, returnPageId: now.definitionMode?.returnPageId ?? now.pageId ?? pageId },
      selection: selOk ? ctx.selection : null,
      missing: ctx.selection && !selOk ? (ctx.selectionLabel ?? 'The selected element') : null
    };
  }
  const selOk = pageOk && !!ctx?.selection && resolves(state, ctx.selection);
  const gone = (ctx?.selection && !selOk) || (ctx?.pageId && !pageOk);
  return {
    ...(pageOk ? { pageId: ctx!.pageId } : leave),
    definitionMode: null,
    selection: selOk ? ctx!.selection : null,
    missing: gone ? (ctx?.selectionLabel ?? ctx?.pageTitle ?? 'What this was about') : null
  };
}
