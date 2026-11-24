/**
 * A run's messages are shown only in the conversation they belong to (#192): the assistant tags every event with its
 * conversation, and the chat panel ignores message and text events tagged with any other one, so a request filed in
 * another thread can never appear in the thread on screen. Run status stays app-wide: only one request runs at a time.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Each model turn streams a line of text and waits until the test releases it, then streams whatever `late` holds
 * and ends. A scripted turn, when one is queued, is answered at once instead.
 */
class GatedAdapter implements AgentModelAdapter {
  private gates: Array<() => void> = [];
  script: ModelEvent[][] = [];
  late = '';
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 };
  }
  /** A turn is waiting at its gate, its first text already streamed. */
  get waiting() {
    return this.gates.length > 0;
  }
  release() {
    this.gates.splice(0).forEach((r) => r());
  }
  async *streamTurn(): AsyncIterable<ModelEvent> {
    const scripted = this.script.shift();
    if (scripted) return yield* scripted;
    yield { type: 'text', delta: 'Working on it.' };
    await new Promise<void>((r) => this.gates.push(r));
    if (this.late) yield { type: 'text', delta: this.late };
    yield { type: 'done', stopReason: 'end', text: `Working on it.${this.late}`, toolCalls: [] };
  }
}

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
const orchestrators: Orchestrator[] = [];
afterEach(async () => {
  // Clearing waits for a finished request's transcript write, which would otherwise land in a removed folder.
  for (const o of orchestrators.splice(0)) await o.clearHistory().catch(() => undefined);
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
  /** Every event the assistant sent, as the renderer received it. */
  const events: AiEvent[] = [];
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    // Events reach the store as they reach the renderer: copied across the bridge.
    emit: (e: AiEvent) => {
      events.push(structuredClone(e));
      store.applyAiEvent(structuredClone(e));
    },
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  orchestrators.push(orch);
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  /** Show a conversation in the chat panel, as the renderer receives it. */
  const show = (c: Conversation) => store.setState({ conversation: structuredClone(c) });
  const streaming = () => until(() => adapter.waiting, 'the request to stream');
  const finished = () => until(() => !orch.busy && store.getState().runStatus === null, 'the request to finish');
  const finish = async () => {
    await streaming();
    adapter.release();
    await finished();
  };
  /** Wait until a conversation's file holds `count` messages. */
  const saved = (id: string, count: number) =>
    until(() => {
      const file = join(dir, '.siteorigin', 'sessions', 'chat', `${id}.json`);
      return existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as Conversation).messages.length === count;
    }, 'the transcript to be saved');
  return { session, orch, adapter, events, ctx, show, streaming, finished, finish, saved };
}

const said = (messages: ChatMessage[] | undefined) => (messages ?? []).map((m) => `${m.role}: ${m.text}`);
/** The conversation each kind of event named, for the events of one request. */
const tags = (events: AiEvent[], runId: string) => [...new Set(events.filter((e) => e.runId === runId).map((e) => `${e.kind} ${e.conversationId}`))].sort();

describe('AI events reach only their own conversation', () => {
  it('a request running in another conversation never shows in the new one on screen', async () => {
    const { orch, events, ctx, show, streaming, finish } = await setup();
    const first = (await orch.loadConversations()).active;
    show(first);
    const one = await orch.send('First request', ctx, first.id);
    expect(one.ok).toBe(true);
    // The conversation on screen shows its own request, and its reply as it streams.
    await streaming();
    expect(said(store.getState().conversation?.messages)).toEqual(['user: First request', 'assistant: Working on it.']);
    await finish();
    expect(tags(events, one.runId!)).toEqual([`message ${first.id}`, `status ${first.id}`, `text ${first.id}`]);

    // New conversation: the panel shows the empty thread, while the assistant is bound to the earlier one (as when
    // listing Earlier conversations used to rebind it), so the next request is filed in that earlier thread.
    const fresh = await orch.newConversation();
    show(fresh);
    await orch.openConversation(first.id);
    const two = await orch.send('Second request', ctx, first.id);
    expect(two.ok).toBe(true);
    await finish();
    // Every event of it names the thread it was filed in.
    expect(tags(events, two.runId!)).toEqual([`message ${first.id}`, `status ${first.id}`, `text ${first.id}`]);

    // The empty thread stays empty: nothing from the earlier conversation was streamed into it.
    expect(store.getState().conversation?.id).toBe(fresh.id);
    expect(store.getState().conversation?.messages).toEqual([]);
    // The request still finished, so the composer is free again.
    expect(store.getState().activeRunId).toBeNull();
    // And it went to the earlier thread, which shows it when opened.
    expect(said((await orch.openConversation(first.id)).messages)).toEqual(['user: First request', 'assistant: Working on it.', 'user: Second request', 'assistant: Working on it.']);
  });

  it('a request still ending when its project closed shows nothing in the project opened next, even the same thread', async () => {
    const { orch, adapter, events, ctx, show, streaming, finish, finished, saved } = await setup();
    const first = (await orch.loadConversations()).active;
    show(first);
    expect((await orch.send('First request', ctx, first.id)).ok).toBe(true);
    await finish();
    await saved(first.id, 2);
    const two = await orch.send('Second request', ctx, first.id);
    expect(two.ok).toBe(true);
    await streaming();
    expect(tags(events, two.runId!)).toEqual([`message ${first.id}`, `status ${first.id}`, `text ${first.id}`]);

    // Closing gives up waiting for the request and lets the project go; the same project opens again, on the same
    // conversation as its file has it.
    orch.reset();
    store.setState({ conversation: null });
    const reopened = (await orch.loadConversations()).active;
    expect(reopened.id).toBe(first.id);
    show(reopened);
    const before = store.getState().conversation;
    expect(said(before?.messages)).toEqual(['user: First request', 'assistant: Working on it.']);

    // The old request streams more, then ends: its status still frees the composer, but nothing else it sends is
    // this opening's, so every event it sends from here on names no conversation.
    const mark = events.length;
    adapter.late = ' Still working.';
    adapter.release();
    await finished();
    expect(tags(events.slice(mark), two.runId!)).toEqual(['message ', 'status ', 'text ']);
    expect(store.getState().conversation).toBe(before);
    expect(store.getState().activeRunId).toBeNull();
  });

  it('an Undo beside a finished request updates it in the conversation on screen', async () => {
    const { session, orch, adapter, events, ctx, show, finished } = await setup();
    const homeId = session.state.site.homePageId;
    adapter.script = [
      [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: 't1', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: 0, scope: { kind: 'site', targetIds: [] }, operations: [{ type: 'page.update', pageId: homeId, seoTitle: 'Welcome home' }] }) }] }],
      [{ type: 'done', stopReason: 'end', text: 'Renamed it.', toolCalls: [] }]
    ];
    const open = (await orch.loadConversations()).active;
    show(open);
    const run = await orch.send('Retitle the home page', ctx, open.id);
    expect(run.ok).toBe(true);
    await finished();
    const reply = () => store.getState().conversation?.messages.find((m) => m.runId === run.runId && m.role === 'assistant');
    expect(reply()?.result?.canUndo).toBe(true);

    // The Undo is not part of any request: it names the conversation that is open, which shows it.
    const mark = events.length;
    expect((await orch.undoTurn(run.runId!)).ok).toBe(true);
    expect(events.slice(mark).map((e) => `${e.kind} ${e.runId} ${e.conversationId}`)).toEqual([`message  ${open.id}`]);
    expect(reply()?.result?.canUndo).toBe(false);
    expect(reply()?.result?.summary).toMatch(/\(Undone\.\)$/);
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
    store.applyAiEvent({ runId: 'r_other', conversationId: '', kind: 'status', status: 'completed', mode: 'edit' });
    expect(store.getState().runStatus).toBeNull();

    // Its own conversation's events still apply.
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'text', text: 'Mine, streamed' });
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'message', message: { ...foreign, id: 'm_next' } });
    expect(said(store.getState().conversation?.messages)).toEqual(['assistant: Mine, streamed', 'assistant: Elsewhere']);
    expect(store.getState().activeRunId).toBe('r_mine');
  });
});
