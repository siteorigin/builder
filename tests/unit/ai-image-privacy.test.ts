/** Settings and Chat say the same thing about what the assistant is given of an image (#1144). */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const WORDING = 'Image files and screenshots are not uploaded. Library images are referred to by ID, with text such as name, alt text and description.';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../src/renderer/src/store', async (original) => ({
  ...(await original<object>()),
  useStore: Object.assign((select: (s: unknown) => unknown) => select(store.state), { getState: () => store.state, subscribe: () => () => {} })
}));
// Static markup cannot render portals: Chat's announcer is one, and so is the dialog's frame.
vi.mock('react-dom', async (original) => ({ ...(await original<object>()), createPortal: () => null }));
vi.mock('../../src/renderer/src/components/ui', async (original) => ({
  ...(await original<object>()),
  Modal: ({ children }: { children: ReactNode }) => children
}));

vi.stubGlobal('document', { body: {}, addEventListener: () => {}, removeEventListener: () => {} });
vi.stubGlobal('window', { builder: { platform: 'darwin' }, addEventListener: () => {}, removeEventListener: () => {} });

// @ts-expect-error TS6142: the Node type-check project sets no --jsx; Vitest compiles the component itself.
const { Chat } = await import('../../src/renderer/src/panels/Chat');
// @ts-expect-error TS6142: the Node type-check project sets no --jsx; Vitest compiles the component itself.
const { SettingsModal } = await import('../../src/renderer/src/panels/SettingsModal');

const settings = (provider: string, baseURL: string, allowRemote: boolean) => ({
  ai: { provider, models: { openai: 'gpt-6.2-sol', anthropic: '', local: 'm' }, local: { baseURL, allowRemote, toolMode: 'native', contextWindow: null, modelsByServer: {} }, sendOnEnter: true },
  developerMode: false
});

describe('AI image privacy notice', () => {
  it.each([
    ['a cloud provider', 'openai', 'http://127.0.0.1:9/v1', false],
    ['a model on this computer', 'local', 'http://127.0.0.1:9/v1', false],
    ['a model on another computer', 'local', 'https://models.example.com/v1', true]
  ])('says what is sent of an image in Settings, for %s', (_, provider, baseURL, allowRemote) => {
    store.state = { ...store.state, settings: settings(provider, baseURL, allowRemote), providers: [], modal: { kind: 'settings', tab: 'ai' } };
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).toContain('id="settings-provider-note"');
    expect(html).toContain(WORDING);
  });

  it('says the same in Chat', () => {
    const state = createStarterState('business', 'Site', false);
    const snapshot = { workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] } };
    store.state = { snapshot, pageId: state.site.homePageId, selection: null, settings: settings('openai', 'http://127.0.0.1:9/v1', false), providers: [], conversation: null, chatDrafts: {}, chatImages: {}, chatMode: 'edit', runStatus: 'idle', activeRunId: null, viewport: 1280, chatContextEnabled: { page: true, selection: true, scope: null } };
    const html = renderToStaticMarkup(createElement(Chat));
    expect(html).toContain(`Page text and structure go to the provider you choose. ${WORDING}`);
  });
});
