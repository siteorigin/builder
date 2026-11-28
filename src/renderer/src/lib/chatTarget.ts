/**
 * What the AI composer's next message is about. On a page: the selected element, that page, or the whole site from
 * it, as the author chose. While a component is edited everywhere: that component's whole design, or one of its own
 * nodes, never the page the canvas happens to show it on. While a post is open in the Posts workspace: that post, never
 * the page under the writer. While a collection's layout is open on the canvas: that layout, never the page behind it.
 * The chips show it and the message is sent with it, from one place.
 */
import { CHAT_EDIT_SCOPES, type ChatContext, type ChatEditScope, type ChatMessage } from '@shared/api';
import type { ElementRef, ProjectState } from '@shared/types';
import { inDefinition, placementsOn, refExists, refLabel, studioRef, withoutSlot } from './model';
import { NEW_STUDIO, type DefinitionMode } from './studio';
import { postAt, type PostRef } from './posts';
import { keepTemplateValid, type TemplateMode } from './template-view';

export interface ComposerScope {
  /** The page the editor shows; while a component is edited everywhere, the page it is shown on. */
  page: { id: string; title: string } | null;
  /** The component edited everywhere, while it is. */
  component: { id: string; name: string } | null;
  /** The element the next message can be limited to, and its label. */
  selection: ElementRef | null;
  selectionLabel: string | null;
  /** The post open in the Posts workspace (written or previewed), while it is: the next message is about it alone. */
  post?: { collectionId: string; entryId: string; title: string } | null;
  /**
   * The Posts writer is in front with no post open: no page shows, so nothing on the page out of sight under it is
   * offered. A change goes to the whole site, from the home page (#1424), and a question reads the site.
   */
  empty?: true;
  /** The collection layout open on the canvas, while it is: the next message is about it alone (#679). */
  template?: { collectionId: string; archive?: true; entryId?: string; name: string } | null;
}

/** How a collection layout is named in the composer and the transcript: “Team layout”, “Team index layout”. */
export const layoutName = (t: { name?: unknown; archive?: unknown }) => `${(typeof t.name === 'string' && t.name.trim()) || 'Collection'} ${t.archive ? 'index layout' : 'layout'}`;

/** How a post is named in the composer and the transcript: its title, or what an untitled one is called. */
export const postTitle = (title: unknown) => (typeof title === 'string' && title.trim()) || 'Untitled';

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

/** A code component of this project's own, which the AI edits through its source as a whole (#1410): open in
 *  Component Studio, a request is about it, never the page behind the studio. */
export function codeDesign(state: ProjectState, id: unknown) {
  const def = typeof id === 'string' && Object.hasOwn(state.components, id) ? state.components[id] : undefined;
  return def?.kind === 'code' && def.owner === 'project' ? def : null;
}

/** A component a request can be about: a managed design of the project's own, or a project code component. */
export const targetableDesign = (state: ProjectState, id: unknown) => editableDesign(state, id) ?? codeDesign(state, id);

/** The component a saved request was about: named, or (saved before requests named it) owning its selection. */
export function requestComponentId(ctx: ChatContext | undefined): string | null {
  const named = ctx?.component?.id;
  if (typeof named === 'string') return named;
  return ctx?.selection?.owner?.kind === 'component' ? ctx.selection.owner.id : null;
}

/** `post`: the post the Posts workspace shows (lib/posts postShown), which the next message is about while it is there. */
export function composerScope(state: ProjectState, view: { pageId: string | null; selection: ElementRef | null; definitionMode: DefinitionMode; post?: PostRef | null; writer?: boolean; template?: TemplateMode | null }): ComposerScope {
  const p = view.pageId && Object.hasOwn(state.pages, view.pageId) ? state.pages[view.pageId] : null;
  const page = p ? { id: p.id, title: p.title } : null;
  // The writer covers the canvas: a selection or design behind it is never what the message is about.
  const entry = postAt(state, view.post);
  if (entry && view.post) return { page, component: null, selection: null, selectionLabel: null, post: { collectionId: view.post.collectionId, entryId: view.post.entryId, title: postTitle(entry.title) } };
  if (view.writer) return { page: null, component: null, selection: null, selectionLabel: null, empty: true };
  // A code component is edited as a whole, through its source: it has no nodes of its own to select (#1410).
  const code = codeDesign(state, view.definitionMode?.definitionId);
  if (code) return { page, component: { id: code.id, name: code.name }, selection: null, selectionLabel: null };
  const def = editableDesign(state, view.definitionMode?.definitionId);
  if (def) {
    // Only the design's own nodes: anything else (a pick the canvas has yet to convert) is not offered.
    const selection = view.selection && inDefinition(view.selection, def.id) && resolves(state, view.selection) ? view.selection : null;
    return { page, component: { id: def.id, name: def.name }, selection, selectionLabel: selection ? refLabel(state, selection) : null };
  }
  // A collection's layout open on the canvas covers the page behind it: the layout is what the message is about.
  const layout = keepTemplateValid(state, view.template ?? null);
  if (layout) {
    const c = state.collections[layout.collectionId];
    return { page, component: null, selection: null, selectionLabel: null, template: { collectionId: layout.collectionId, ...(layout.archive ? { archive: true as const } : {}), ...(layout.entryId ? { entryId: layout.entryId } : {}), name: c.settings.name } };
  }
  // A selection that names something gone (until the editor lets it go) is never offered, nor sent. A slot picked on the
  // canvas is about its placement, which the AI may change as a whole: it is offered and named as that placement.
  const picked = view.selection && withoutSlot(view.selection);
  const selection = picked && resolves(state, picked) ? picked : null;
  return { page, component: null, selection, selectionLabel: selection ? refLabel(state, selection) : null };
}

/**
 * How far the next message goes, from the composer's choice: the selected element only while one is selected. With
 * nothing selected, the choice to keep to a selection keeps to the page, so an edit starts there by default. With the
 * writer showing no post, no page or element is in sight, so an edit reaches the whole site (#1424).
 */
export function editScope(scope: Pick<ComposerScope, 'selection' | 'empty'>, chosen: ChatEditScope): ChatEditScope {
  if (scope.empty) return 'site';
  return chosen === 'selection' && !scope.selection ? 'page' : chosen;
}

/** The context a message is sent with, frozen at send time. `enabled` holds the composer's page switch and its scope choice. */
export function chatContextFor(state: ProjectState, scope: ComposerScope, opts: { enabled: { page: boolean; scope: ChatEditScope }; viewport: number; assetIds?: string[]; ask?: boolean }): ChatContext {
  const home = state.site.homePageId;
  const page = opts.enabled.page ? scope.page : null;
  // A post names itself: no selection, component or scope, so nothing on the page under the writer is its target.
  if (scope.post)
    return {
      pageId: page ? page.id : home,
      pageTitle: page ? page.title : (state.pages[home]?.title ?? ''),
      selection: null,
      selectionLabel: null,
      post: { ...scope.post },
      viewport: opts.viewport,
      ...(opts.assetIds?.length ? { assetIds: [...opts.assetIds] } : {}),
      ...(opts.ask ? { mode: 'ask' as const } : {})
    };
  // A layout names itself too: no selection, component or scope, so the page behind it is never its target.
  if (scope.template)
    return {
      pageId: page ? page.id : home,
      pageTitle: page ? page.title : (state.pages[home]?.title ?? ''),
      selection: null,
      selectionLabel: null,
      template: { ...scope.template },
      viewport: opts.viewport,
      ...(opts.assetIds?.length ? { assetIds: [...opts.assetIds] } : {}),
      ...(opts.ask ? { mode: 'ask' as const } : {})
    };
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
/**
 * What a request was aimed at, beyond the words its caption uses: its mode, reach, page, element, component and post.
 * Two requests about different elements can share a caption ("Home → Heading"); this tells them apart.
 */
export function requestTarget(m: Pick<ChatMessage, 'context'> | undefined): string {
  const c = m?.context;
  if (!c) return '';
  const sel = c.selection;
  return JSON.stringify([
    c.mode ?? 'edit',
    c.scope ?? null,
    c.pageId ?? null,
    sel ? [sel.owner, sel.instancePath ?? [], sel.nodeId] : null,
    typeof c.component?.id === 'string' ? c.component.id : null,
    c.post && typeof c.post === 'object' ? [c.post.collectionId, c.post.entryId] : null,
    ...(c.template && typeof c.template === 'object' ? [[c.template.collectionId, !!c.template.archive]] : [])
  ]);
}

export function targetOf(ctx?: ChatContext | null): string {
  if (!ctx) return '';
  // A transcript is read back from disk: a malformed post is left out.
  if (ctx.post && typeof ctx.post === 'object' && typeof ctx.post.title === 'string') return `Post · ${postTitle(ctx.post.title)}`;
  if (ctx.template && typeof ctx.template === 'object' && typeof ctx.template.collectionId === 'string') return layoutName(ctx.template);
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
): { pageId?: string; definitionMode: DefinitionMode; selection: ElementRef | null; scope: ChatEditScope; missing: string | null; post?: PostRef | null; template?: TemplateMode | null } {
  const pageOk = !!ctx?.pageId && Object.hasOwn(state.pages, ctx.pageId);
  // The scope it was sent with. One sent before the scope could be chosen kept to its selection, or reached the whole
  // site; one read back damaged keeps to its selection, or its page.
  const saved = ctx?.scope as unknown;
  const scope: ChatEditScope = CHAT_EDIT_SCOPES.includes(saved as ChatEditScope) ? (saved as ChatEditScope) : ctx?.selection ? 'selection' : saved === undefined ? 'site' : 'page';
  // Leaving a component edited everywhere goes back to the page it was entered from.
  const leave = now.definitionMode ? { pageId: now.definitionMode.returnPageId } : {};
  // A request about a post goes back to that post, in the writer, while its collection still has it.
  // One read back damaged is still a post's request: the author chooses a post, never the page under the writer.
  if (ctx?.post !== undefined) {
    const p = ctx.post as unknown as Record<string, unknown> | null;
    const post = p && typeof p === 'object' && typeof p.collectionId === 'string' && typeof p.entryId === 'string' ? { collectionId: p.collectionId, entryId: p.entryId } : null;
    const there = !!post && !!postAt(state, post);
    return { ...leave, definitionMode: null, selection: null, scope, missing: there ? null : post ? `The post “${postTitle(p!.title)}”` : 'The post', post: there ? post : null };
  }
  // A request about a collection's layout goes back to that layout, shown on the entry it was, while the collection has
  // it. One read back damaged is still a layout's request: the author opens a layout or page, never the one behind it.
  if (ctx?.template !== undefined) {
    const t = ctx.template as unknown as Record<string, unknown> | null;
    const asked: TemplateMode | null = t && typeof t === 'object' && typeof t.collectionId === 'string' ? { collectionId: t.collectionId, entryId: typeof t.entryId === 'string' ? t.entryId : null, ...(t.archive === true ? { archive: true as const } : {}) } : null;
    const there = keepTemplateValid(state, asked);
    // Sent with no scope of its own: one put back without its layout keeps to the page, never the whole site.
    return { ...(pageOk ? { pageId: ctx.pageId } : leave), definitionMode: null, selection: null, scope: 'page', missing: there ? null : t ? `The ${layoutName(t)}` : 'The layout', template: there };
  }
  const componentId = requestComponentId(ctx);
  if (ctx && componentId) {
    // A code component goes back to Component Studio, where it is edited as a whole (#1410).
    const code = codeDesign(state, componentId);
    if (code) {
      const studio = (now.definitionMode?.definitionId === code.id ? now.definitionMode.studio : undefined) ?? NEW_STUDIO;
      const pageId = pageOk ? ctx.pageId : (now.pageId ?? state.site.homePageId);
      return { pageId, definitionMode: { definitionId: code.id, returnPageId: now.definitionMode?.returnPageId ?? now.pageId ?? pageId, studio }, selection: null, scope, missing: null };
    }
    const def = editableDesign(state, componentId);
    if (!def) return { ...leave, definitionMode: null, selection: null, scope, missing: ctx.component?.name ?? ctx.selectionLabel ?? 'The component' };
    const selOk = !!ctx.selection && inDefinition(ctx.selection, def.id) && resolves(state, ctx.selection);
    // The canvas shows the design through a placement: on the request's page, else the one open now, else the first
    // page that has one. A design placed nowhere opens in Component Studio, which shows it on its own; so does one
    // the author is looking at there already, as they were looking at it.
    const shows = (id: string | null | undefined): id is string => !!id && Object.hasOwn(state.pages, id) && placementsOn(state, def.id, id).length > 0;
    const fallback = pageOk ? ctx.pageId : (now.pageId ?? state.site.homePageId);
    const placed = [ctx.pageId, now.pageId, ...state.site.pageOrder].find(shows);
    const pageId = placed ?? fallback;
    const studio = (now.definitionMode?.definitionId === def.id ? now.definitionMode.studio : undefined) ?? (placed ? undefined : NEW_STUDIO);
    return {
      pageId,
      definitionMode: { definitionId: def.id, returnPageId: now.definitionMode?.returnPageId ?? now.pageId ?? pageId, ...(studio ? { studio } : {}) },
      // The studio shows the design's own items only: one of a placement's is the design's node, in every item.
      selection: selOk ? (studio ? studioRef(state, def.id, ctx.selection!) : ctx.selection) : null,
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
