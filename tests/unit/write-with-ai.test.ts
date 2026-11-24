// Write with AI (#512): an empty page, or one with only its title, opens the AI panel about that whole page, as an
// edit, with a request for the message box that Chat answers once the box shows.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementRef } from '@shared/types';
import type { ChatEditScope, ChatMode, ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { CHAT_FOCUS_WAIT_MS, chatFocusStep, type ChatFocusRequest } from '../../src/renderer/src/lib/page-start';

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
  chatFocus: ChatFocusRequest | null;
}
const load = (path: string) => import(/* @vite-ignore */ path);
let actions: { writePageWithAi: (pageId: string) => void };
let store: { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };

const state = createStarterState('business', 'Studio', false);
const home = state.site.homePageId;
const about = state.site.pageOrder.find((id) => state.pages[id].title === 'About')!;
const headerRef: ElementRef = { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: state.site.shell.header.rootIds[0] };

beforeEach(async () => {
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
    chatContextEnabled: { page: false, scope: 'site' }
  });
});

describe('Write with AI', () => {
  it('opens the AI panel about the whole page on screen, as an edit, and asks for the message box', () => {
    actions.writePageWithAi(about);
    const s = store.getState();
    expect(s.selection).toBeNull();
    expect([s.rightTab, s.dockOpen]).toEqual(['chat', true]);
    expect(s.chatMode).toBe('edit');
    expect(s.chatContextEnabled).toEqual({ page: true, scope: 'page' });
    expect(s.chatFocus).toEqual({ workspaceKey: 'opening#1', pageId: about, at: expect.any(Number) });
    expect(Math.abs(Date.now() - s.chatFocus!.at)).toBeLessThan(1000);
    expect(saved).toEqual([{ chatMode: 'edit' }]);
  });

  it('does nothing for a page that is no longer on screen', () => {
    actions.writePageWithAi(home);
    const s = store.getState();
    expect(s.selection).toEqual(headerRef);
    expect([s.rightTab, s.dockOpen, s.chatFocus]).toEqual(['inspect', false, null]);
    expect(s.chatContextEnabled).toEqual({ page: false, scope: 'site' });
    expect(s.chatMode).toBe('ask');
    expect(saved).toEqual([]);
  });
});

describe('the request for the message box', () => {
  const req: ChatFocusRequest = { workspaceKey: 'opening#1', pageId: 'pg_about', at: 1000 };
  const ready = { now: 1200, workspaceKey: 'opening#1', pageId: 'pg_about', chatShown: true, box: true, boxForced: false, configured: true, asking: false };

  it('focuses the box as soon as it shows', () => {
    expect(chatFocusStep(req, ready)).toBe('focus');
    expect(chatFocusStep(req, { ...ready, box: false })).toBe('wait');
  });

  it('shows the box first when no AI provider is connected, unless a question has it', () => {
    expect(chatFocusStep(req, { ...ready, configured: false, box: false })).toBe('show-box');
    expect(chatFocusStep(req, { ...ready, configured: false, boxForced: true })).toBe('focus');
    expect(chatFocusStep(req, { ...ready, configured: false, asking: true })).toBe('focus');
  });

  it('lets the request go once the author has moved on, or after a short wait', () => {
    expect(chatFocusStep(req, { ...ready, pageId: 'pg_home' })).toBe('drop');
    expect(chatFocusStep(req, { ...ready, workspaceKey: 'opening#2' })).toBe('drop');
    expect(chatFocusStep(req, { ...ready, chatShown: false })).toBe('drop');
    expect(chatFocusStep(req, { ...ready, now: req.at + CHAT_FOCUS_WAIT_MS })).toBe('focus');
    // A box that showed late, while the author was typing elsewhere: focus stays where it is.
    expect(chatFocusStep(req, { ...ready, now: req.at + CHAT_FOCUS_WAIT_MS + 1 })).toBe('drop');
    expect(chatFocusStep(req, { ...ready, now: 4500 })).toBe('drop');
  });
});
