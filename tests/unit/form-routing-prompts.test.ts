/**
 * The editor's other prompts for the app's question about where forms send (#1322): while its review is the dialog on
 * screen, the chat card and the toolbar point at the review instead of at the chat it covers, and once it is gone they
 * point back at the chat.
 */
import { resolve } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, initial: {} as Record<string, unknown> }));
vi.mock('../../src/renderer/src/store', async (original) => {
  const real = await original<{ useStore: { getState: () => Record<string, unknown> } }>();
  // Every field as the app starts with it, so each test sets only what it is about.
  store.initial = real.useStore.getState();
  return {
  ...real,
  useStore: Object.assign((select: (s: unknown) => unknown) => select(store.state), { getState: () => store.state, subscribe: () => () => {} })
  };
});
// Static markup cannot render portals: Chat's announcer is one.
vi.mock('react-dom', async (original) => ({ ...(await original<object>()), createPortal: () => null }));
vi.mock('../../src/renderer/src/components/ui', async (original) => ({
  ...(await original<object>()),
  Modal: ({ children }: { children: ReactNode }) => children,
  // A wide window, read without a server snapshot of its own.
  useWindowWidth: () => 1600
}));

vi.stubGlobal('document', { body: {}, addEventListener: () => {}, removeEventListener: () => {} });
vi.stubGlobal('window', { builder: { platform: 'darwin' }, innerWidth: 1600, addEventListener: () => {}, removeEventListener: () => {} });

// @ts-expect-error TS6142: the Node type-check project sets no --jsx; Vitest compiles the component itself.
const { Chat } = await import('../../src/renderer/src/panels/Chat');
// @ts-expect-error TS6142: the Node type-check project sets no --jsx; Vitest compiles the component itself.
const { Toolbar } = await import('../../src/renderer/src/panels/Toolbar');
// Loaded by path, untyped, so the Node type-check project does not take in the renderer (as form-routing-dialog.test.ts).
type Confirm = { resolve: (ok: boolean | null) => void };
const { confirmDialog, getConfirm } = (await import(/* @vite-ignore */ resolve('src/renderer/src/store.ts'))) as { confirmDialog: (req: Record<string, unknown>) => Promise<boolean | null>; getConfirm: () => Confirm | null };

const review = { forms: [{ title: '“Contact form” on “Home”', rows: [{ label: 'Sends to', before: 'https://forms.example.com/sales', after: 'https://forms.example.com/new' }] }] };
const site = createStarterState('business', 'Site', false);
const snapshot = { workspaceKey: 'w', dir: '/project', state: site, revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, conflicts: [] };
const thread = (id: string, asks: boolean) => ({
  id,
  title: 'Forms',
  createdAt: '2026-11-27T09:00:00.000Z',
  messages: asks
    ? [
        { id: 'm_u', role: 'user', text: 'Send the form to the new inbox', time: '2026-11-27T09:00:00.000Z' },
        { id: 'm_a', role: 'assistant', text: '', time: '2026-11-27T09:00:01.000Z', runId: 'run_1', activities: [], questions: [{ id: 'q_1', text: 'Let the assistant change where your contact form sends visitors’ messages?', choices: ['Keep it as it is', 'Allow this change'], formRouting: review }] }
      ]
    : []
});
const waiting = (conversation: ReturnType<typeof thread>, runConversationId = 'c_1') => {
  store.state = {
    ...store.initial,
    snapshot,
    pageId: site.site.homePageId,
    selection: null,
    settings: { ai: { provider: 'openai', models: { openai: 'gpt-6.2-sol', anthropic: '', local: 'm' }, local: { baseURL: 'http://127.0.0.1:9/v1', allowRemote: false, toolMode: 'native', contextWindow: null, modelsByServer: {} }, sendOnEnter: true }, developerMode: false },
    providers: [],
    conversation,
    chatDrafts: {},
    chatImages: {},
    chatMode: 'edit',
    runStatus: 'awaiting-input',
    activeRunId: 'run_1',
    runConversationId,
    runMode: 'edit',
    viewport: 1280,
    mode: 'edit',
    chatContextEnabled: { page: true, selection: true, scope: null }
  };
};
/** The review on screen, as FormRoutingHost asks it. */
const openReview = () => void confirmDialog({ title: 'Change where your form sends?', body: '', confirmLabel: 'Allow this change', cancelLabel: 'Keep it as it is', formRouting: review, key: 'form-routing:run_1:q_1' });

afterEach(() => {
  while (getConfirm()) getConfirm()!.resolve(null);
});

describe('the editor’s prompts while the form-routing review is open (#1322)', () => {
  it('the chat card points at the review, and back at the chat once it is gone', () => {
    waiting(thread('c_1', true));
    const before = renderToStaticMarkup(createElement(Chat));
    expect(before).toContain('A typed “yes” allows it too.');
    openReview();
    const during = renderToStaticMarkup(createElement(Chat));
    expect(during).not.toContain('A typed “yes” allows it too.');
    expect(during).toContain('in the review that is open.');
    getConfirm()!.resolve(null);
    expect(renderToStaticMarkup(createElement(Chat))).toContain('A typed “yes” allows it too.');
  });

  it('a question waiting in another thread offers no Answer while its review is open', () => {
    waiting(thread('c_2', false));
    const before = renderToStaticMarkup(createElement(Chat));
    expect(before).toContain('The AI needs your answer in another conversation');
    expect(before).toMatch(/>Answer<\/button>/);
    openReview();
    const during = renderToStaticMarkup(createElement(Chat));
    expect(during).toContain('The AI is waiting on the review that is open');
    expect(during).not.toMatch(/>Answer<\/button>/);
  });

  it('the toolbar still says the AI waits, and where the answer goes', () => {
    waiting(thread('c_1', true));
    expect(renderToStaticMarkup(createElement(Toolbar))).toContain('Answer it in the AI panel');
    openReview();
    const during = renderToStaticMarkup(createElement(Toolbar));
    expect(during).toContain('AI is waiting for you');
    expect(during).toContain('Answer it in the review that is open');
    expect(during).not.toContain('Answer it in the AI panel');
  });
});
