/**
 * The personal component library (#372) and component files, from any menu that offers them: Insert's Your components,
 * the Inspector's component menu, and the canvas's and Layers' context menus all save, export and insert the same way.
 */
import type { ComponentExportResult, SavedComponent, SavedInsertResult, SaveToLibraryResult } from '@shared/api';
import type { ComponentDefinition, ElementRef, ProjectState } from '@shared/types';
import { api, getState, setState, shownAt, toast, undoAction } from '../store';
import { markArrival } from './arrival';
import type { InsertAt } from './insert-at';
import { treeFor } from './model';

/** The personal library changed: Insert lists it again. */
export const libraryChanged = () => setState({ libraryVersion: getState().libraryVersion + 1 });

/** Whether a component can be saved to the library or exported: one of the project's own, never the header or footer. */
export const carriesAcross = (def: ComponentDefinition | undefined): def is ComponentDefinition => !!def && def.owner === 'project' && def.category !== 'shell';

/**
 * The project component a menu's element is a placement of, when it can be saved or exported from there: the placement
 * itself, not a part inside it, of a component of the project's own; code only in Developer mode.
 */
export function placedDefinition(state: ProjectState, ref: ElementRef | null, dev: boolean): ComponentDefinition | undefined {
  if (!ref || ref.instancePath.length) return undefined;
  const nodes = treeFor(state, ref.owner)?.nodes;
  const n = nodes && Object.hasOwn(nodes, ref.nodeId) ? nodes[ref.nodeId] : undefined;
  const def = n?.kind === 'instance' && Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  return carriesAcross(def) && (dev || def.kind !== 'code') ? def : undefined;
}

/** Save a project component to the personal library, so Insert offers it in every project. */
export async function saveToLibrary(def: Pick<ComponentDefinition, 'id' | 'name'>): Promise<boolean> {
  const opening = getState().snapshot?.workspaceKey;
  if (!opening) return false;
  const r: SaveToLibraryResult = await api.project.saveComponentToLibrary(def.id, opening).catch((e: Error) => ({ ok: false, message: `“${def.name}” couldn’t be saved to your library: ${e.message}` }));
  if (!r.ok) {
    if (r.message) toast(r.message, 'error');
    return false;
  }
  libraryChanged();
  const name = r.name ?? def.name;
  toast([`${r.replaced ? 'Updated' : 'Saved'} ${name} in your library. Insert offers it in every project.`, ...(r.notes ?? [])].join(' '), 'info');
  return true;
}

/** A package file another project can import: the chooser and the writing happen in the app. */
export async function exportComponentFile(def: Pick<ComponentDefinition, 'id' | 'name'>): Promise<void> {
  const r: ComponentExportResult = await api.project.exportComponent(def.id).catch((e: Error) => ({ ok: false, message: `${def.name} couldn’t be exported: ${e.message}` }));
  if (r.ok) toast([`Exported ${def.name}.`, ...(r.notes ?? [])].join(' '), 'info');
  else if (r.message) toast(r.message, 'error');
}

/** Take a component out of the personal library. Projects that inserted it keep their own copies. */
export async function removeFromLibrary(entry: Pick<SavedComponent, 'id' | 'name'>): Promise<void> {
  const removed = await api.project.removeSavedComponent(entry.id).catch(() => false);
  libraryChanged();
  if (removed) toast(`Removed ${entry.name} from your library. Projects it was inserted into keep their copies.`, 'info');
}

/**
 * Insert a saved component at `at` (worked out for its role on the project as this window has it), as one change:
 * imported into the project and placed. Selected, with the arrival cue, once the page shows it. Resolves to the
 * history entry it made, for an Undo beside it.
 */
export async function insertSaved(entry: SavedComponent, at: InsertAt): Promise<string | undefined> {
  const start = getState();
  const snap = start.snapshot;
  if (!snap) return;
  const place = { owner: at.owner, parentId: at.parentId, ...(at.slot !== undefined ? { slot: at.slot } : {}), ...(at.index !== undefined ? { index: at.index } : {}) };
  const r: SavedInsertResult = await api.project.insertSavedComponent(entry.id, place, snap.workspaceKey, snap.revision).catch((e: Error) => ({ ok: false, message: `${entry.name} couldn’t be inserted: ${e.message}` }));
  if (!r.ok || !r.nodeId || r.revision === undefined) {
    if (r.gone) libraryChanged();
    if (r.message) toast(r.message, 'error');
    return;
  }
  const shown = await shownAt(r.revision, snap.workspaceKey);
  const now = getState();
  if (now.snapshot?.workspaceKey !== snap.workspaceKey) return;
  // Selected only while the author is still where it went and has picked nothing else meanwhile (the code question
  // can take a while); otherwise it is said where it went, with its Undo.
  const owner = at.owner;
  const here = owner.kind === 'page' ? now.pageId === owner.id && !now.templateMode && !now.definitionMode : owner.kind === 'template' ? now.templateMode?.collectionId === owner.id : owner.kind === 'component' ? now.definitionMode?.definitionId === owner.id : true;
  if (!shown || !here || now.selection !== start.selection) {
    toast(`Added ${entry.name}.`, 'info', undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey: snap.workspaceKey }));
    return;
  }
  const ref: ElementRef = { owner, instancePath: [], nodeId: r.nodeId };
  if (now.mode === 'edit') markArrival(ref);
  setState({ selection: ref, rightTab: 'inspect' });
  return r.entryId;
}
