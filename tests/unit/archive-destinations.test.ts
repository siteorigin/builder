/**
 * Where a note about a collection's archive layout leads (#1348): a form there opens the index layout with the form
 * selected, never starts a layout or opens one whose index is turned off, and a form in the shared footer that only a
 * collection's index shows opens that index.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import type { EditorDestination, ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined, apply: () => new Promise(() => undefined) } }, platform: 'darwin', addEventListener: () => undefined, removeEventListener: () => undefined });
vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));

interface EditorState {
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  templateMode: { collectionId: string; entryId: string | null; archive?: boolean } | null;
  toasts: Array<{ text: string }>;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState> & Record<string, unknown>) => void };
const { openEditorDestination } = (await load('../../src/renderer/src/lib/open-destination')) as { openEditorDestination: (dest: EditorDestination) => void };

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const ARCHIVE: OwnerRef = { kind: 'archive', id: 'notes' };
const FOOTER: OwnerRef = { kind: 'shell', id: 'footer' };

/** A Notes collection with no entry, its index in a layout of its own holding a contact form, and one in the footer. */
function notes(): ProjectState {
  return run(
    createStarterState('business', 'Test Studio', false),
    { type: 'collection.create', collectionId: 'notes', name: 'Notes', kind: 'editorial', route: '/notes/', pages: { detail: true, archive: true } },
    { type: 'collection.update', collectionId: 'notes', archiveTemplate: 'start' },
    { type: 'node.insert', newNodeId: 'n_noteform', owner: ARCHIVE, parentId: null, componentId: 'contact.form' },
    { type: 'node.insert', newNodeId: 'n_footerform', owner: FOOTER, parentId: null, componentId: 'contact.form' }
  );
}

const open = (state: ProjectState) => store.setState({ snapshot: { state, revision: 1, workspaceKey: 'opening#1' } as unknown as ProjectSnapshot });
const form = (owner: OwnerRef, nodeId: string): EditorDestination => ({ kind: 'form', owner, nodeId, setting: 'connection' });
const lastToast = () => store.getState().toasts.at(-1)?.text;

describe('a form note about a collection’s archive layout', () => {
  beforeEach(() => store.setState({ snapshot: null, selection: null, templateMode: null, definitionMode: null, mode: 'edit', toasts: [], modal: null }));

  it('opens the index layout with the form selected', () => {
    open(notes());
    openEditorDestination(form(ARCHIVE, 'n_noteform'));
    expect(store.getState().templateMode).toEqual({ collectionId: 'notes', entryId: null, archive: true });
    expect(store.getState().selection).toEqual({ owner: ARCHIVE, instancePath: [], nodeId: 'n_noteform' });
  });

  it('opens nothing while the collection’s index is turned off, and never starts a layout', () => {
    const off = structuredClone(notes());
    off.collections.notes.settings.pages = { detail: true, archive: false };
    open(off);
    openEditorDestination(form(ARCHIVE, 'n_noteform'));
    expect(store.getState().templateMode).toBeNull();
    expect(store.getState().selection).toBeNull();
    expect(lastToast()).toBe('That form is no longer on the site.');
  });

  it('opens the index for a footer form when no page or entry shows the footer', () => {
    const hidden = structuredClone(notes());
    for (const id of hidden.site.pageOrder) hidden.pages[id].showFooter = false;
    // A collection that sorts first and shows no pages at all is passed over.
    const s = run(hidden, { type: 'collection.create', collectionId: 'a-records', name: 'Records', kind: 'structured', singularName: 'Record', hasBody: false, pages: { detail: false, archive: false } } as EditOperation);
    open(s);
    openEditorDestination(form(FOOTER, 'n_footerform'));
    expect(store.getState().templateMode).toEqual({ collectionId: 'notes', entryId: null, archive: true });
    expect(store.getState().selection).toEqual({ owner: FOOTER, instancePath: [], nodeId: 'n_footerform' });
  });
});
