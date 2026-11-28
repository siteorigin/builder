// Edit with AI (#1585): choosing it for an element opens the chat as an edit scoped to that element, whatever mode
// the chat was in; opening the chat with nothing in particular leaves the author's mode and choices alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementRef } from '@shared/types';
import type { ChatEditScope, ChatMode, ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';

const saved: unknown[] = [];
vi.stubGlobal('window', { builder: { project: { saveLocalState: async (s: unknown) => void saved.push(s) }, platform: 'darwin' } });

interface EditorState {
  snapshot: ProjectSnapshot | null;
  pageId: string | null;
  selection: ElementRef | null;
  rightTab: string;
  dockOpen: boolean;
  chatMode: ChatMode;
  chatContextEnabled: { page: boolean; scope: ChatEditScope };
}
const load = (path: string) => import(/* @vite-ignore */ path);
let actions: { askAiAbout: (ref: ElementRef | null) => void };
let store: { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };

const state = createStarterState('business', 'Studio', false);
const about = state.site.pageOrder.find((id) => state.pages[id].title === 'About')!;
const headerRef: ElementRef = { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: state.site.shell.header.rootIds[0] };
const pageRef: ElementRef = { owner: { kind: 'page', id: about }, instancePath: [], nodeId: state.pages[about].rootIds[0] };

beforeEach(async () => {
  vi.useFakeTimers();
  saved.length = 0;
  vi.resetModules();
  actions = await load('../../src/renderer/src/lib/actions');
  store = await load('../../src/renderer/src/store');
  store.setState({
    snapshot: { state, revision: 1, workspaceKey: 'opening#1' } as unknown as ProjectSnapshot,
    pageId: about,
    selection: headerRef,
    rightTab: 'inspect',
    dockOpen: false,
    chatMode: 'ask',
    chatContextEnabled: { page: true, scope: 'site' }
  });
});

// The message box is focused a moment later; there is no document here, so that moment never comes.
afterEach(() => void vi.useRealTimers());

describe('Edit with AI', () => {
  it('opens the chat to edit the element chosen, from Ask mode, and keeps Edit for the next opening', () => {
    actions.askAiAbout(pageRef);
    const s = store.getState();
    expect([s.rightTab, s.dockOpen]).toEqual(['chat', true]);
    expect(s.selection).toEqual(pageRef);
    expect(s.chatContextEnabled).toEqual({ page: true, scope: 'selection' });
    expect(s.chatMode).toBe('edit');
    expect(saved).toEqual([{ chatMode: 'edit' }]);
  });

  it.each<ChatMode>(['ask', 'edit'])('leaves %s mode, the scope and the selection alone when no element is chosen', (mode) => {
    store.setState({ chatMode: mode });
    actions.askAiAbout(null);
    const s = store.getState();
    expect([s.rightTab, s.dockOpen]).toEqual(['chat', true]);
    expect(s.selection).toEqual(headerRef);
    expect(s.chatContextEnabled).toEqual({ page: true, scope: 'site' });
    expect(s.chatMode).toBe(mode);
    expect(saved).toEqual([]);
  });
});
