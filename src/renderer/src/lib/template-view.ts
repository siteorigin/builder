/**
 * Editing a collection's layout on the canvas: the layout is shown on one of the collection's entries (any of them,
 * drafts included, as the editor's preview has them all), which the author can switch to see the layout with other
 * words, pictures and dates. The page the editor had open stays the page shown when the layout is closed.
 */
import type { EntryDoc, OwnerRef, ProjectState } from '@shared/types';
import { entryRoute, orderedEntries } from '@shared/collections';
import { siteEntries } from '@generator/index';

export interface TemplateMode {
  collectionId: string;
  /** The entry the layout is shown on, or null for a collection without entries. */
  entryId: string | null;
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** The template owner of a layout being edited. */
export const templateOwner = (mode: TemplateMode): OwnerRef => ({ kind: 'template', id: mode.collectionId });

/** The entries a layout can be shown on, in the collection's order: those the editor's preview has a page for. */
export function sampleEntries(state: ProjectState, collectionId: string): EntryDoc[] {
  const listed = new Set(siteEntries(state).filter((e) => e.collection.settings.id === collectionId).map((e) => e.entry.id));
  const c = own(state.collections, collectionId);
  return c ? orderedEntries(c).filter((e) => listed.has(e.id)) : [];
}

/**
 * The layout mode kept to what the project has after it changes (an Undo, an entry removed, the files changing on
 * disk): its collection, else no layout mode at all; its entry, else the collection's first. Unchanged when it holds.
 */
export function keepTemplateValid(state: ProjectState, mode: TemplateMode | null): TemplateMode | null {
  if (!mode) return null;
  if (!own(state.collections, mode.collectionId)?.settings?.template) return null;
  const samples = sampleEntries(state, mode.collectionId);
  if (mode.entryId && samples.some((e) => e.id === mode.entryId)) return mode;
  const first = samples[0]?.id ?? null;
  return first === mode.entryId ? mode : { collectionId: mode.collectionId, entryId: first };
}

/** What the canvas shows: a page, or a collection's layout on one of its entries. */
export interface ShownView {
  /** Tells views apart for the frame's navigation (a page ID, or the layout and its entry). */
  key: string;
  /** The address the frame opens; null for a layout with no entry to show it on. */
  route: string | null;
  title: string;
  template?: TemplateMode;
}

export function shownView(state: ProjectState, pageId: string | null, mode: TemplateMode | null): ShownView | null {
  if (mode) {
    const c = own(state.collections, mode.collectionId);
    if (!c) return null;
    const entry = mode.entryId ? own(c.entries, mode.entryId) : undefined;
    const routable = !!entry && sampleEntries(state, mode.collectionId).some((e) => e.id === entry.id);
    return { key: `template:${mode.collectionId}:${mode.entryId ?? ''}`, route: routable ? (entryRoute(c, entry) ?? null) : null, title: `${c.settings.name} layout`, template: mode };
  }
  const page = pageId ? own(state.pages, pageId) : undefined;
  return page ? { key: page.id, route: page.route, title: page.title } : null;
}

/** The view shown, as the frame's navigation names it (see lib/frame-nav). */
export const viewKey = (s: { snapshot: { state: ProjectState } | null; pageId: string | null; templateMode: TemplateMode | null }): string | null =>
  s.snapshot ? (shownView(s.snapshot.state, s.pageId, s.templateMode)?.key ?? null) : s.pageId;

/**
 * Where an address the frame reports leads the editor: a collection entry's page is its collection's layout shown on
 * that entry (whichever collection it is in), an ordinary page is that page, and anywhere else (an old address, the
 * not-found page) leaves the editor where it is. Null too for the view already shown.
 */
export function viewAt(state: ProjectState, mode: TemplateMode | null, path: string): { templateMode: TemplateMode } | { pageId: string } | null {
  const same = (route: string) => route === path || route === path + '/';
  for (const e of siteEntries(state)) {
    if (!same(e.route)) continue;
    const cid = e.collection.settings.id;
    return mode?.collectionId === cid && mode.entryId === e.entry.id ? null : { templateMode: { collectionId: cid, entryId: e.entry.id } };
  }
  const page = Object.values(state.pages).find((p) => same(p.route));
  return page ? { pageId: page.id } : null;
}
