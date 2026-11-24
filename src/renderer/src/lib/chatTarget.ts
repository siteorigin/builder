/**
 * What the AI composer's next message is about. On a page: the selected element, that page, or the whole site from
 * it, as the author chose. While a component is edited everywhere: that component's whole design, or one of its own
 * nodes, never the page the canvas happens to show it on. The chips show it and the message is sent with it, from one
 * place.
 */
import { CHAT_EDIT_SCOPES, type ChatContext, type ChatEditScope } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { inDefinition, placementsOn, refExists, refLabel } from './model';

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

// A request's selection is read back from disk, so a malformed one is no target either.
const resolves = (state: ProjectState, ref: ElementRef) => {
  try {
    return refExists(state, ref);
  } catch {
    return false;
  }
};

/** A component design of this project's own that a request can be about: a theme's original is changed only through
 *  the copy "Edit everywhere" makes. */
export function editableDesign(state: ProjectState, id: unknown) {
  const def = typeof id === 'string' && Object.hasOwn(state.components, id) ? state.components[id] : undefined;
  return def?.kind === 'managed' && def.owner === 'project' && def.tree ? def : null;
}

/** The component a saved request was about: named, or (saved before requests named it) owning its selection. */
export function requestComponentId(ctx: ChatContext | undefined): string | null {
  const named = ctx?.component?.id;
  if (typeof named === 'string') return named;
  return ctx?.selection?.owner?.kind === 'component' ? ctx.selection.owner.id : null;
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
  // A selection that names something gone (until the editor lets it go) is never offered, nor sent.
  const selection = view.selection && resolves(state, view.selection) ? view.selection : null;
  return { page, component: null, selection, selectionLabel: selection ? refLabel(state, selection) : null };
}

/**
 * How far the next message goes, from the composer's choice: the selected element only while one is selected. With
 * nothing selected, the choice to keep to a selection keeps to the page, so an edit starts there by default.
 */
export function editScope(scope: Pick<ComposerScope, 'selection'>, chosen: ChatEditScope): ChatEditScope {
  return chosen === 'selection' && !scope.selection ? 'page' : chosen;
}

/** The context a message is sent with, frozen at send time. `enabled` holds the composer's page switch and its scope choice. */
export function chatContextFor(state: ProjectState, scope: ComposerScope, opts: { enabled: { page: boolean; scope: ChatEditScope }; viewport: number; assetIds?: string[]; ask?: boolean }): ChatContext {
  const home = state.site.homePageId;
  const page = opts.enabled.page ? scope.page : null;
  const chosen = editScope(scope, opts.enabled.scope);
  const selection = chosen === 'selection' ? scope.selection : null;
  return {
    pageId: page ? page.id : home,
    pageTitle: page ? page.title : (state.pages[home]?.title ?? ''),
    selection: selection ? structuredClone(selection) : null,
    selectionLabel: selection ? scope.selectionLabel : null,
    ...(scope.component ? { component: { ...scope.component } } : {}),
    // An edit on a page says how far it may reach. A question changes nothing, and a component edited everywhere says
    // it by what it carries.
    ...(!opts.ask && !scope.component ? { scope: chosen } : {}),
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
): { pageId?: string; definitionMode: DefinitionMode; selection: ElementRef | null; scope: ChatEditScope; missing: string | null } {
  const pageOk = !!ctx?.pageId && Object.hasOwn(state.pages, ctx.pageId);
  // The scope it was sent with. One sent before the scope could be chosen kept to its selection, or reached the whole
  // site; one read back damaged keeps to its selection, or its page.
  const saved = ctx?.scope as unknown;
  const scope: ChatEditScope = CHAT_EDIT_SCOPES.includes(saved as ChatEditScope) ? (saved as ChatEditScope) : ctx?.selection ? 'selection' : saved === undefined ? 'site' : 'page';
  // Leaving a component edited everywhere goes back to the page it was entered from.
  const leave = now.definitionMode ? { pageId: now.definitionMode.returnPageId } : {};
  const componentId = requestComponentId(ctx);
  if (ctx && componentId) {
    const def = editableDesign(state, componentId);
    if (!def) return { ...leave, definitionMode: null, selection: null, scope, missing: ctx.component?.name ?? ctx.selectionLabel ?? 'The component' };
    const selOk = !!ctx.selection && inDefinition(ctx.selection, def.id) && resolves(state, ctx.selection);
    // The canvas shows the design through a placement: on the request's page, else the one open now, else the first
    // page that has one. A design placed nowhere stays on the request's page, editable through Layers.
    const shows = (id: string | null | undefined): id is string => !!id && Object.hasOwn(state.pages, id) && placementsOn(state, def.id, id).length > 0;
    const fallback = pageOk ? ctx.pageId : (now.pageId ?? state.site.homePageId);
    const pageId = [ctx.pageId, now.pageId, ...state.site.pageOrder].find(shows) ?? fallback;
    return {
      pageId,
      definitionMode: { definitionId: def.id, returnPageId: now.definitionMode?.returnPageId ?? now.pageId ?? pageId },
      selection: selOk ? ctx.selection : null,
      scope,
      missing: ctx.selection && !selOk ? (ctx.selectionLabel ?? 'The selected element') : null
    };
  }
  const selOk = pageOk && !!ctx?.selection && resolves(state, ctx.selection);
  const gone = (ctx?.selection && !selOk) || (ctx?.pageId && !pageOk);
  return {
    ...(pageOk ? { pageId: ctx!.pageId } : leave),
    definitionMode: null,
    selection: selOk ? ctx!.selection : null,
    scope,
    missing: gone ? (ctx?.selectionLabel ?? ctx?.pageTitle ?? 'What this was about') : null
  };
}
