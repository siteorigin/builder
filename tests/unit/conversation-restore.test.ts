/**
 * A window reloaded while a request runs shows its conversation as main has it, read by the opening and the
 * conversation's ID, with the request's status (#1123): status is sent only when it changes, so without it the run
 * strip, Stop and a question waiting for its answer would be gone until the next one.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { ChatMessage, ChatMode, Conversation, ConversationState, ProjectSnapshot, RunStatus } from '@shared/api';
import { waitingQuestion } from '../../src/renderer/src/lib/chatQuestions';

interface AppModule {
  openSnapshot(snap: ProjectSnapshot): void;
}
interface StoreModule {
  getState(): { conversation: Conversation | null; runStatus: RunStatus | null; activeRunId: string | null; runMode: ChatMode | null };
}
const APP_PATH = '../../src/renderer/src/App';
const STORE_PATH = '../../src/renderer/src/store';
let app: AppModule;
let store: StoreModule;

const time = '2026-11-27T00:00:00.000Z';
const user: ChatMessage = { id: 'm_q', role: 'user', text: 'Add a gallery page', time };
const asking: ChatMessage = { id: 'm_reply', role: 'assistant', text: 'Before I start:', time, runId: 'r_live', questions: [{ id: 'q_1', text: 'Which photos?', choices: ['Studio', 'Products'] }] };
/** What the list read gives as the open thread, and what the read by ID gives: the same thread, the run in it. */
const listed: Conversation = { id: 'c_live', title: 'Add a gallery page', createdAt: time, messages: [user, { ...asking, text: '', questions: undefined }] };
const live: ConversationState = { conversation: { ...listed, messages: [user, asking] }, run: { runId: 'r_live', status: 'awaiting-input', mode: 'edit' } };

const conversations = vi.fn(async () => ({ active: listed, list: [] }));
const readConversation = vi.fn(async (_id: string, _key: string) => structuredClone(live));
const openConversation = vi.fn();
const newConversation = vi.fn();

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    builder: { platform: 'test', ai: { conversations, readConversation, openConversation, newConversation }, project: { saveLocalState: async () => undefined } },
    addEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined })
  };
  store = (await import(/* @vite-ignore */ STORE_PATH)) as StoreModule;
  app = (await import(/* @vite-ignore */ APP_PATH)) as AppModule;
});

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('restoring a conversation after a reload (#1123)', () => {
  it('shows the remembered conversation by its ID with its question waiting, so the composer answers it', async () => {
    const snap = { state: createStarterState('business', 'Test', false), workspaceKey: 'w1', revision: 1, localState: { chatConversation: 'c_live' }, runtime: { status: 'stopped' } } as unknown as ProjectSnapshot;
    app.openSnapshot(snap);
    await until(() => store.getState().runStatus !== null, 'the run to be restored');
    expect(readConversation).toHaveBeenCalledWith('c_live', 'w1');
    // Main's open thread was shown as it is: nothing was opened or started in its place.
    expect(openConversation).not.toHaveBeenCalled();
    expect(newConversation).not.toHaveBeenCalled();
    const s = store.getState();
    expect(s).toMatchObject({ conversation: live.conversation, runStatus: 'awaiting-input', activeRunId: 'r_live', runMode: 'edit' });
    expect(waitingQuestion(s.conversation, s.activeRunId, s.runStatus)).toMatchObject({ runId: 'r_live', question: { id: 'q_1', text: 'Which photos?' } });
  });
});
