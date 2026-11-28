/**
 * The toolbar's Mode toggle (#1583): Edit, Preview and SEO. SEO opens the SEO view and is the chosen option while the
 * view is open; Edit or Preview from the view leaves it for the canvas in that mode, with the sidebar back on the panel
 * the view replaced, as every other way out does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' }, addEventListener: () => undefined, removeEventListener: () => undefined });

type Mode = 'edit' | 'preview' | 'seo';
interface EditorState {
  snapshot: ProjectSnapshot | null;
  leftTab: string | null;
  mode: 'edit' | 'preview';
  pageId: string | null;
  selection: unknown;
  previewReturn: unknown;
  definitionMode: unknown;
  seoSubject: unknown;
  modal: unknown;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState>) => void; leaveSeoView: () => void };
const actions = (await load('../../src/renderer/src/lib/actions')) as { chooseMode: (m: Mode) => void; toolbarMode: (s: EditorState) => Mode };
const shown = () => actions.toolbarMode(store.getState());

describe('the toolbar’s Mode toggle', () => {
  let state: ProjectState;
  beforeEach(() => {
    state = structuredClone(createStarterState('business', 'Studio', false)) as ProjectState;
    store.setState({ snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [] } as unknown as ProjectSnapshot, leftTab: 'assets', mode: 'edit', pageId: state.site.homePageId, selection: null, previewReturn: null, definitionMode: null, seoSubject: null, modal: null });
  });

  it('chooses SEO while the view is open, and the canvas’s mode otherwise', () => {
    expect(shown()).toBe('edit');
    store.setState({ mode: 'preview' });
    expect(shown()).toBe('preview');
    store.setState({ leftTab: 'seo' });
    expect(shown(), 'the rail’s SEO entry opened it').toBe('seo');
    store.leaveSeoView();
    expect(shown(), 'Escape or the rail left it').toBe('preview');
  });

  it('SEO opens the view, and Edit leaves it for the panel it replaced', () => {
    actions.chooseMode('seo');
    expect(store.getState().leftTab).toBe('seo');
    expect(shown()).toBe('seo');
    actions.chooseMode('edit');
    expect(store.getState().leftTab, 'the sidebar is back on the panel the view replaced').toBe('assets');
    expect(store.getState().mode).toBe('edit');
    expect(shown()).toBe('edit');
  });

  it('Preview from the view leaves it for the canvas in Preview', () => {
    store.setState({ leftTab: 'layers' });
    actions.chooseMode('seo');
    actions.chooseMode('preview');
    expect(store.getState().leftTab).toBe('layers');
    expect(store.getState().mode).toBe('preview');
    expect(shown()).toBe('preview');
  });

  it('Edit from a view opened in Preview leaves it in Edit, and the view’s chosen document is kept for next time', () => {
    store.setState({ mode: 'preview' });
    const subject = { kind: 'page', pageId: state.site.homePageId };
    store.setState({ leftTab: 'seo', seoSubject: subject });
    actions.chooseMode('edit');
    expect(store.getState().leftTab).toBe('assets');
    expect(store.getState().mode).toBe('edit');
    actions.chooseMode('seo');
    expect(store.getState().seoSubject, 'SEO opens on the document it last chose').toEqual(subject);
  });

  it('Edit or Preview outside the view only changes the mode', () => {
    actions.chooseMode('preview');
    expect(store.getState().leftTab).toBe('assets');
    expect(store.getState().mode).toBe('preview');
    actions.chooseMode('edit');
    expect(store.getState().leftTab).toBe('assets');
    expect(store.getState().mode).toBe('edit');
  });
});
