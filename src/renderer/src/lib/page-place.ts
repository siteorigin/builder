/**
 * Where the author was on each page: the element last selected there, by page ID. It is kept on this computer with
 * the project's other workspace state (the open page, the panels), never in the site or its Undo history, so a page
 * opened again from the page list, or when the project reopens, resumes at that element.
 *
 * An element is remembered by its ID, which survives moving it, renaming the page and changing its address: a section
 * moved on its page is still found. One removed, or moved to another page, is not, and nothing is selected in its
 * place. A shared header or footer element is remembered on a page only while that page shows the part.
 */
import type { ElementRef, ProjectState } from '@shared/types';
import { refKey } from '@shared/types';
import { isShellPart, showsPart } from '@shared/page-shell';
import { findParent } from '@engine/tree';
import { resolveRef, treeFor } from './model';

export type PagePlaces = Record<string, ElementRef>;

/** Whether `ref` is an element shown on the page, as its own or in the shared part the page shows. */
function onPage(state: ProjectState, pageId: string, ref: ElementRef): boolean {
  const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
  if (!page) return false;
  if (ref.owner.kind === 'page' ? ref.owner.id !== pageId : ref.owner.kind !== 'shell' || !isShellPart(ref.owner.id) || !showsPart(page, ref.owner.id)) return false;
  const r = resolveRef(state, ref);
  if (!r.node) return false;
  // A part named by the reference must still be that node of its component.
  return !ref.partId || r.def?.parts[ref.partId]?.nodeId === ref.nodeId;
}

/**
 * The section of the page an element sits in: the layer at the top of its page (or shared part), holding it. A list
 * item can only be told apart by its item IDs, which a later change can drop or reuse, so the place kept for one is the
 * section that holds the list, never the list's other items.
 */
function sectionOf(state: ProjectState, ref: ElementRef): ElementRef | null {
  const tree = treeFor(state, ref.owner);
  if (!tree) return null;
  let id = ref.instancePath[0] ?? ref.nodeId;
  const seen = new Set([id]);
  for (let p = findParent(tree, id); p?.parentId && !seen.has(p.parentId); p = findParent(tree, p.parentId)) {
    seen.add(p.parentId);
    id = p.parentId;
  }
  return { owner: ref.owner, instancePath: [], nodeId: id };
}

/** What to remember for an element selected on a page, or null when it is not one of the page's elements. */
export function placeToKeep(state: ProjectState, pageId: string, ref: ElementRef): ElementRef | null {
  const kept = ref.itemPath?.length ? sectionOf(state, ref) : { owner: { ...ref.owner }, instancePath: [...ref.instancePath], nodeId: ref.nodeId, ...(ref.partId ? { partId: ref.partId } : {}) };
  return kept && onPage(state, pageId, kept) ? kept : null;
}

/**
 * What Edit selects again after Preview: the element selected when Preview was entered, while it is still there.
 * `unchanged` says the site has not changed since, so a list item is as good as it was; after a change only its
 * section is (see sectionOf). An element of a component edited everywhere is the component's.
 */
export function selectionBack(state: ProjectState, pageId: string, ref: ElementRef, unchanged: boolean): ElementRef | null {
  if (ref.owner.kind === 'component') return resolveRef(state, ref).node && (unchanged || !ref.itemPath?.length) ? ref : null;
  if (ref.itemPath?.length && !unchanged) return placeToKeep(state, pageId, ref);
  return onPage(state, pageId, ref) ? ref : null;
}

/** The element to resume at on a page, if the one remembered there is still on it. */
export function placeOn(state: ProjectState, places: PagePlaces, pageId: string): ElementRef | null {
  const ref = Object.hasOwn(places, pageId) ? places[pageId] : undefined;
  return ref && !ref.itemPath?.length && onPage(state, pageId, ref) ? ref : null;
}

/** The places without the one remembered on a page. */
export function forgetPlace(places: PagePlaces, pageId: string): PagePlaces {
  if (!Object.hasOwn(places, pageId)) return places;
  const next = { ...places };
  delete next[pageId];
  return next;
}

/** The parts of the editor's state a place is noted from. */
export interface PlaceView {
  snapshot: { workspaceKey: string; state: ProjectState } | null;
  pageId: string | null;
  selection: ElementRef | null;
  mode: 'edit' | 'preview';
  definitionMode: unknown;
  pagePlaces: PagePlaces;
}

/**
 * The places after one change of the editor's state. Selecting an element on the page shown remembers it there; the
 * author letting it go on that page (Escape, a click beside the page, the page's own crumb, deleting the element)
 * forgets it. Nothing else does: opening another page, entering Preview and a visitor's link all leave the selection
 * empty without the author having let it go. A component edited everywhere is not a page, and is never remembered.
 */
export function notePlace(prev: PlaceView, s: PlaceView): PagePlaces {
  const places = s.pagePlaces;
  // Only a change of selection is a pick, and Edit keeping one made while previewing: the page shown changing under
  // the same selection (an Undo took the page away and Home is shown) is not.
  if (s.selection === prev.selection && !(prev.mode === 'preview' && s.mode === 'edit')) return places;
  const st = s.snapshot?.state;
  if (!st || !s.pageId || s.mode !== 'edit' || s.definitionMode || s.snapshot?.workspaceKey !== prev.snapshot?.workspaceKey) return places;
  if (s.selection) {
    const kept = placeToKeep(st, s.pageId, s.selection);
    if (!kept) return places;
    const had = Object.hasOwn(places, s.pageId) ? places[s.pageId] : undefined;
    return had && refKey(had) === refKey(kept) && had.partId === kept.partId ? places : { ...places, [s.pageId]: kept };
  }
  // Leaving Preview or a component edited everywhere with nothing selected is not letting go.
  return prev.selection && prev.pageId === s.pageId && prev.mode === 'edit' && !prev.definitionMode ? forgetPlace(places, s.pageId) : places;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** One remembered element, read from the workspace file (which may be old, edited by hand or broken). */
function readRef(v: unknown): ElementRef | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const owner = r.owner as Record<string, unknown> | null | undefined;
  if (!owner || typeof owner !== 'object' || (owner.kind !== 'page' && owner.kind !== 'shell') || !isId(owner.id)) return null;
  if (!Array.isArray(r.instancePath) || r.instancePath.length > 20 || !r.instancePath.every(isId) || !isId(r.nodeId)) return null;
  if (r.partId !== undefined && !isId(r.partId)) return null;
  if (r.itemPath !== undefined) return null;
  return { owner: { kind: owner.kind, id: owner.id }, instancePath: [...r.instancePath], nodeId: r.nodeId, ...(r.partId ? { partId: r.partId } : {}) };
}

/** The places saved for a project, kept to the pages it has and the elements still on them. */
export function readPlaces(state: ProjectState, saved: unknown): PagePlaces {
  const out: PagePlaces = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const [pageId, v] of Object.entries(saved)) {
    const ref = readRef(v);
    if (ref && onPage(state, pageId, ref)) out[pageId] = ref;
  }
  return out;
}
