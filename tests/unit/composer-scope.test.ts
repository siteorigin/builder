// What the AI composer's next message may change (issue #513) starts again from the selected element, or the page
// with none, whenever the editor shows something else: a choice of the whole site, or of a whole component while it
// is edited everywhere, never carries into the next view. An update that names its own scope keeps it.
import { describe, expect, it, vi } from 'vitest';
import type { ElementRef } from '@shared/types';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => {} }, ai: { stop: async () => {} }, platform: 'darwin' } });

// The editor's store is DOM code, outside this test project's types: loaded by a path the type checker does not
// follow, with just the shapes this test uses.
interface EditorState {
  pageId: string | null;
  selection: ElementRef | null;
  definitionMode: { definitionId: string; returnPageId: string } | null;
  chatContextEnabled: { page: boolean; scope: 'selection' | 'page' | 'site' };
  toasts: unknown[];
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { getState, setState } = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };

const ref = (nodeId: string): ElementRef => ({ owner: { kind: 'page', id: 'pg_home' }, instancePath: [], nodeId });
const scope = () => getState().chatContextEnabled.scope;
const choose = (s: 'page' | 'site') => setState({ chatContextEnabled: { page: true, scope: s } });

describe('the scope of the next AI message', () => {
  it('starts again when the page, the component edited everywhere or the selected element changes', () => {
    setState({ pageId: 'pg_home', selection: null, definitionMode: null, chatContextEnabled: { page: true, scope: 'selection' } });
    choose('site');
    // Nothing the editor shows has changed.
    setState({ pageId: 'pg_home', toasts: [] });
    setState({ selection: null });
    expect(scope()).toBe('site');
    setState({ pageId: 'pg_about' });
    expect(scope()).toBe('selection');
    choose('page');
    setState({ selection: ref('n_hero') });
    expect(scope()).toBe('selection');
    choose('site');
    // The same element, picked again.
    setState({ selection: ref('n_hero') });
    expect(scope()).toBe('site');
    setState({ selection: null });
    expect(scope()).toBe('selection');
    // Whole component, chosen while editing a component everywhere, ends with it.
    setState({ definitionMode: { definitionId: 'proj.hero', returnPageId: 'pg_about' }, selection: ref('heading') });
    choose('site');
    setState({ definitionMode: null, selection: null });
    expect(scope()).toBe('selection');
  });

  it('keeps the scope an update names with what it shows', () => {
    setState({ pageId: 'pg_home', selection: ref('n_hero'), definitionMode: null, chatContextEnabled: { page: true, scope: 'selection' } });
    // "Edit and try again": the request's page, as far as it reached.
    setState({ pageId: 'pg_about', selection: null, chatContextEnabled: { page: true, scope: 'site' } });
    expect(scope()).toBe('site');
  });
});
