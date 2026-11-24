/**
 * A run's messages are shown only in the conversation they belong to (#192): the assistant tags every event with its
 * conversation, and the chat panel ignores message and text events tagged with any other one, so a request filed in
 * another thread can never appear in the thread on screen. Run status stays app-wide: only one request runs at a time.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatContext, ChatMessage, Conversation, RunStatus } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';

vi.stubGlobal('window', { builder: { platform: 'test' } });

// The store is renderer code, outside this test project's types: loaded by a path the type checker does not follow,
// with just the shapes this test uses.
interface ChatState {
  conversation: Conversation | null;
  runStatus: RunStatus | null;
  activeRunId: string | null;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as {
  applyAiEvent: (e: AiEvent) => void;
  getState: () => ChatState;
  setState: (p: Partial<ChatState>) => void;
};

/** Each model turn streams a line of text, then waits until the test releases it. */
class GatedAdapter implements AgentModelAdapter {
  private gates: Array<() => void> = [];
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 };
  }
  release() {
    this.gates.splice(0).forEach((r) => r());
  }
  async *streamTurn(): AsyncIterable<ModelEvent> {
    yield { type: 'text', delta: 'Working on it.' };
    await new Promise<void>((r) => this.gates.push(r));
    yield { type: 'done', stopReason: 'end', text: 'Working on it.', toolCalls: [] };
  }
}

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  store.setState({ conversation: null, runStatus: null, activeRunId: null });
});

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'so-ai-events-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('blank', 'Events', false));
  sessions.push(session);
  const adapter = new GatedAdapter();
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    // Events reach the store as they reach the renderer: copied across the bridge.
    emit: (e: AiEvent) => store.applyAiEvent(structuredClone(e)),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  /** Show a conversation in the chat panel, as the renderer receives it. */
  const show = (c: Conversation) => store.setState({ conversation: structuredClone(c) });
  const finish = async () => {
    await until(() => store.getState().runStatus === 'running', 'the request to stream');
    adapter.release();
    await until(() => !orch.busy && store.getState().runStatus === null, 'the request to finish');
  };
  return { orch, ctx, show, finish };
}

const said = (messages: ChatMessage[] | undefined) => (messages ?? []).map((m) => `${m.role}: ${m.text}`);

describe('AI events reach only their own conversation', () => {
  it('a request running in another conversation never shows in the new one on screen', async () => {
    const { orch, ctx, show, finish } = await setup();
    const first = (await orch.loadConversations()).active;
    show(first);
    expect((await orch.send('First request', ctx, first.id)).ok).toBe(true);
    await finish();
    // The conversation on screen shows its own request as it streams.
    expect(said(store.getState().conversation?.messages)).toEqual(['user: First request', 'assistant: Working on it.']);

    // New conversation: the panel shows the empty thread, while the assistant is bound to the earlier one (as when
    // listing Earlier conversations used to rebind it), so the next request is filed in that earlier thread.
    const fresh = await orch.newConversation();
    show(fresh);
    await orch.openConversation(first.id);
    expect((await orch.send('Second request', ctx, first.id)).ok).toBe(true);
    await finish();

    // The empty thread stays empty: nothing from the earlier conversation was streamed into it.
    expect(store.getState().conversation?.id).toBe(fresh.id);
    expect(store.getState().conversation?.messages).toEqual([]);
    // The request still finished, so the composer is free again.
    expect(store.getState().activeRunId).toBeNull();
    // And it went to the earlier thread, which shows it when opened.
    expect(said((await orch.openConversation(first.id)).messages)).toEqual(['user: First request', 'assistant: Working on it.', 'user: Second request', 'assistant: Working on it.']);
  });

  it('ignores message and text events tagged with another conversation, or with none', () => {
    const shown: Conversation = { id: 'c_shown', title: 'Shown', createdAt: '2026-11-24T00:00:00.000Z', messages: [{ id: 'm_mine', role: 'assistant', text: 'Mine', time: '2026-11-24T00:00:00.000Z', runId: 'r_mine' }] };
    store.setState({ conversation: shown, runStatus: null, activeRunId: null });
    const foreign: ChatMessage = { id: 'm_other', role: 'assistant', text: 'Elsewhere', time: '2026-11-24T00:00:01.000Z', runId: 'r_mine' };
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_other', kind: 'message', message: foreign });
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_other', kind: 'message', message: { ...shown.messages[0], text: 'Overwritten' } });
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_other', kind: 'text', text: 'Streamed elsewhere' });
    // A project closed mid-run tags its last events with no conversation at all.
    store.applyAiEvent({ runId: 'r_mine', conversationId: '', kind: 'message', message: foreign });
    store.applyAiEvent({ runId: 'r_mine', conversationId: '', kind: 'text', text: 'Streamed nowhere' });
    expect(store.getState().conversation).toBe(shown);
    expect(store.getState().activeRunId).toBeNull();

    // Run status is the app's, whichever conversation the run belongs to.
    store.applyAiEvent({ runId: 'r_other', conversationId: 'c_other', kind: 'status', status: 'running', mode: 'edit' });
    expect(store.getState().runStatus).toBe('running');
    store.applyAiEvent({ runId: 'r_other', conversationId: 'c_other', kind: 'status', status: 'completed', mode: 'edit' });
    expect(store.getState().runStatus).toBeNull();

    // Its own conversation's events still apply.
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'text', text: 'Mine, streamed' });
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'message', message: { ...foreign, id: 'm_next' } });
    expect(said(store.getState().conversation?.messages)).toEqual(['assistant: Mine, streamed', 'assistant: Elsewhere']);
    expect(store.getState().activeRunId).toBe('r_mine');
  });
});
