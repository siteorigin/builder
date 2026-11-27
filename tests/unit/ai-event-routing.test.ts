/**
 * A run's messages are shown only in the conversation they belong to (#192): the assistant tags every event with its
 * conversation, and the chat panel ignores message and text events tagged with any other one, so a request filed in
 * another thread can never appear in the thread on screen. Run status stays app-wide: only one request runs at a time.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatContext, ChatMessage, ChatMode, Conversation, ConversationState, RunStatus } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';
import { turnState } from '@shared/turns';
import { ProjectSession } from '../../src/main/project/session';
import { undoableId } from '../../src/renderer/src/lib/result';
import { waitingQuestion } from '../../src/renderer/src/lib/chatQuestions';

vi.stubGlobal('window', { builder: { platform: 'test' } });

// The store is renderer code, outside this test project's types: loaded by a path the type checker does not follow,
// with just the shapes this test uses.
interface ChatState {
  conversation: Conversation | null;
  runStatus: RunStatus | null;
  activeRunId: string | null;
  runMode: ChatMode | null;
  runConversationId: string | null;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as {
  applyAiEvent: (e: AiEvent) => void;
  getState: () => ChatState;
  setState: (p: Partial<ChatState>) => void;
  shownRun: (s: ChatState) => { runId: string; status: RunStatus; mode: 'edit' | 'ask' } | null;
  detachedRun: () => Partial<ChatState>;
  showConversation: (fallback: Conversation, opening: string, current: () => boolean) => Promise<void>;
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
  store.setState({ conversation: null, runStatus: null, activeRunId: null, runMode: null, runConversationId: null });
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
    // Its status said which request ran, and in which thread, from the start: before the model streamed anything.
    expect(events.filter((e) => e.runId === one.runId).map((e) => e.kind).slice(0, 3)).toEqual(['message', 'message', 'status']);
    expect(events.find((e) => e.runId === one.runId && e.kind === 'status')?.status).toBe('preparing');

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
    // The window forgets the project as App does when it closes: the request still holds the app, in no thread.
    store.setState({ conversation: null, aiOutcome: null, ...store.detachedRun() } as Partial<ChatState>);
    const reopened = (await orch.loadConversations()).active;
    expect(reopened.id).toBe(first.id);
    show(reopened);
    const before = store.getState().conversation;
    expect(said(before?.messages)).toEqual(['user: First request', 'assistant: Working on it.']);
    // The same thread is on screen again, but the request is not its: it is neither shown nor stopped from there.
    expect(store.getState()).toMatchObject({ runStatus: 'running', activeRunId: two.runId });
    expect(store.shownRun(store.getState())).toBeNull();

    // The old request streams more, then ends: its status still frees the composer, but nothing else it sends is
    // this opening's, so every event it sends from here on names no conversation.
    const mark = events.length;
    adapter.late = ' Still working.';
    adapter.release();
    await finished();
    expect(tags(events.slice(mark), two.runId!)).toEqual(['message ', 'status ', 'text ']);
    // Detached, its text goes whole again: nothing names the copy it would follow.
    expect(events.slice(mark).filter((e) => e.kind === 'text').map((e) => [e.text, e.at])).toEqual([['Working on it. Still working.', undefined]]);
    expect(store.getState().conversation).toBe(before);
    expect(store.getState()).toMatchObject({ activeRunId: null, runConversationId: null });
    // Its end is no outcome of this opening's.
    expect((store.getState() as unknown as { aiOutcome: unknown }).aiOutcome).toBeNull();
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
    const messages = () => store.getState().conversation?.messages ?? [];
    const reply = () => messages().find((m) => m.runId === run.runId && m.role === 'assistant');
    /** History as the panel receives it in the project's snapshot, copied across the bridge. */
    const history = () => structuredClone(session.historyInfo());
    expect(reply()?.result?.canUndo).toBe(true);
    expect(turnState(reply()!, history())?.standing).toBe('applied');
    expect(undoableId(messages(), history())).toBe(reply()!.id);

    // The Undo is not part of any request, and the transcript keeps the turn as it was said (issue 276): it sends no
    // event, so nothing of it can show in another conversation. The conversation on screen reads it from History.
    const said = structuredClone(reply());
    const mark = events.length;
    expect((await orch.undoTurn(run.runId!)).ok).toBe(true);
    expect(events.slice(mark)).toEqual([]);
    expect(store.getState().conversation?.id).toBe(open.id);
    expect(reply()).toEqual(said);
    expect(turnState(reply()!, history())?.standing).toBe('undone');
    expect(undoableId(messages(), history())).toBeUndefined();

    // A Redo from the toolbar puts it back in the same conversation, offered Undo turn again.
    expect((await session.redo()).ok).toBe(true);
    expect(events.slice(mark)).toEqual([]);
    expect(turnState(reply()!, history())?.standing).toBe('applied');
    expect(undoableId(messages(), history())).toBe(reply()!.id);
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

    // Its own conversation's events still apply. Which request runs is its status's to say, never a message's.
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'text', text: 'Mine, streamed' });
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'message', message: { ...foreign, id: 'm_next' } });
    expect(said(store.getState().conversation?.messages)).toEqual(['assistant: Mine, streamed', 'assistant: Elsewhere']);
    expect(store.getState().activeRunId).toBeNull();
    store.applyAiEvent({ runId: 'r_mine', conversationId: 'c_shown', kind: 'status', status: 'running', mode: 'edit' });
    expect(store.getState()).toMatchObject({ activeRunId: 'r_mine', runConversationId: 'c_shown' });
    store.setState({ runStatus: null, activeRunId: null, runConversationId: null });
  });});

describe('a streamed reply is sent as the pieces it gains (#974)', () => {
  const texts = (events: AiEvent[], runId: string) => events.filter((e) => e.runId === runId && e.kind === 'text').map((e) => (e.at === undefined ? { text: e.text } : { text: e.text, at: e.at }));

  it('sends each piece once after the text before it, and the whole text again after it was cleared', async () => {
    const { orch, adapter, events, ctx, show, finished } = await setup();
    show((await orch.loadConversations()).active);
    const done = (text: string): ModelEvent => ({ type: 'done', stopReason: 'end', text, toolCalls: [] });
    // An answer that points through labels it never located is sent back once, its text cleared, and asked again.
    adapter.script = [
      [{ type: 'text', delta: 'Open A ' }, { type: 'text', delta: '→ B' }, done('Open A → B')],
      [{ type: 'text', delta: 'Use the ' }, { type: 'text', delta: 'Inspector' }, { type: 'text', delta: '.' }, done('Use the Inspector.')]
    ];
    const r = await orch.send('Where do I change the hours?', { ...ctx, mode: 'ask' });
    expect(r.ok).toBe(true);
    await finished();
    expect(texts(events, r.runId!)).toEqual([{ text: 'Open A ' }, { text: '→ B', at: 7 }, { text: 'Use the ' }, { text: 'Inspector', at: 8 }, { text: '.', at: 17 }]);
    // What was sent grows with the answer: every character once.
    const sent = texts(events, r.runId!).reduce((n, e) => n + (e.text ?? '').length, 0);
    expect(sent).toBe('Open A → B'.length + 'Use the Inspector.'.length);
    const reply = store.getState().conversation?.messages.at(-1);
    expect(reply?.result?.summary).toBe('Use the Inspector.');
  });

  it('puts the pieces together in the panel, and reads the turn from main when one does not follow what is shown', async () => {
    const base = { runId: 'r_live', conversationId: 'c_live' };
    const time = '2026-11-24T00:00:00.000Z';
    const reply: ChatMessage = { id: 'm_reply', role: 'assistant', text: '', time, runId: 'r_live' };
    const shown: Conversation = { id: 'c_live', title: 'Live', createdAt: time, messages: [{ id: 'm_q', role: 'user', text: 'Hi', time }, reply] };
    store.setState({ conversation: structuredClone(shown), snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
    const before = store.getState().conversation!.messages[0];
    store.applyAiEvent({ ...base, kind: 'text', text: 'Hel' });
    store.applyAiEvent({ ...base, kind: 'text', text: 'lo', at: 3 });
    expect(said(store.getState().conversation?.messages)).toEqual(['user: Hi', 'assistant: Hello']);
    // A message that did not change keeps its identity, so it is not rendered again.
    expect(store.getState().conversation!.messages[0]).toBe(before);

    // Main's answers, each held until the test lets it go.
    const answers: Array<(c: Conversation) => void> = [];
    const readConversation = vi.fn((_id: string, _key: string) => new Promise<ConversationState>((resolve) => answers.push((conversation) => resolve({ conversation, run: null }))));
    const openConversation = vi.fn();
    const w = (globalThis as unknown as { window: { builder: Record<string, unknown> } }).window;
    // Read by this opening and this conversation's ID, never as whichever thread main has open.
    w.builder.ai = { readConversation, openConversation };
    const asked = (n: number) => until(() => readConversation.mock.calls.length === n, `read ${n} of the conversation`);
    const settle = () => new Promise((r) => setTimeout(r, 10));
    const withText = (text: string, more: Partial<ChatMessage> = {}): Conversation => ({ ...shown, messages: [shown.messages[0], { ...reply, text, ...more }] });
    try {
      // A piece after text this window never got (it was reloaded meanwhile) is not placed: main's copy is read instead,
      // without opening anything there, and once at a time.
      store.applyAiEvent({ ...base, kind: 'text', text: 'wor', at: 7 });
      store.applyAiEvent({ ...base, kind: 'text', text: 'ld', at: 10 });
      await asked(1);
      await settle();
      expect(readConversation).toHaveBeenCalledTimes(1);
      expect(readConversation).toHaveBeenCalledWith('c_live', 'w1');
      expect(said(store.getState().conversation?.messages)).toEqual(['user: Hi', 'assistant: Hello']);
      answers[0](withText('Hello, world'));
      await until(() => said(store.getState().conversation?.messages).at(-1) === 'assistant: Hello, world', 'main’s copy to be shown');
      expect(openConversation).not.toHaveBeenCalled();
      // The piece that did not fit while it was read is read for again, after it.
      await asked(2);
      answers[1](withText('Hello, world'));
      await settle();
      expect(readConversation).toHaveBeenCalledTimes(2);
      // The pieces after it follow main's copy.
      store.applyAiEvent({ ...base, kind: 'text', text: '.', at: 12 });
      expect(said(store.getState().conversation?.messages)).toEqual(['user: Hi', 'assistant: Hello, world.']);

      // An answer that arrives after the turn's final message is older than it: the final message stays.
      store.applyAiEvent({ ...base, kind: 'text', text: 'xx', at: 5 });
      await asked(3);
      const final = { ...reply, text: 'Hello, world.', result: { status: 'no-changes' as const, summary: 'Hello, world.', changes: [], validation: [], canUndo: false } };
      store.applyAiEvent({ ...base, kind: 'message', message: final });
      answers[2](withText('Hello, wo'));
      await settle();
      expect(store.getState().conversation?.messages).toEqual([shown.messages[0], final]);

      // Nor is an answer about another conversation, or one for another opening of the project, shown.
      const current = store.getState().conversation;
      store.applyAiEvent({ ...base, kind: 'text', text: 'yy', at: 3 });
      await asked(4);
      answers[3]({ ...withText('Elsewhere'), id: 'c_other' });
      await settle();
      expect(store.getState().conversation).toBe(current);
      store.applyAiEvent({ ...base, kind: 'text', text: 'zz', at: 3 });
      await asked(5);
      store.setState({ snapshot: { workspaceKey: 'w2' } } as Partial<ChatState>);
      answers[4](withText('Reopened'));
      await settle();
      expect(store.getState().conversation).toBe(current);

      // Text, whole or a piece, for a turn this window does not show is read from main too. A final message that arrives
      // meanwhile is kept, and main's copy fills in the rest (the request this window never got).
      store.setState({ snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
      store.setState({ conversation: { ...shown, messages: [] } });
      store.applyAiEvent({ ...base, kind: 'text', text: 'Hello' });
      await asked(6);
      store.applyAiEvent({ ...base, kind: 'message', message: final });
      answers[5](withText('Hello'));
      await until(() => store.getState().conversation?.messages.length === 2, 'the turn to be shown');
      expect(store.getState().conversation?.messages).toEqual([shown.messages[0], final]);
    } finally {
      delete w.builder.ai;
      store.setState({ snapshot: null } as Partial<ChatState>);
    }
  });
});

describe('a background run reaches only its own thread (#1124)', () => {
  const time = '2026-11-27T00:00:00.000Z';
  const mine: Conversation = { id: 'c_shown', title: 'Shown', createdAt: time, messages: [{ id: 'm_old', role: 'assistant', text: 'Earlier reply', time, runId: 'r_old' }] };
  const bg = { runId: 'r_bg', conversationId: 'c_bg' };
  const request: ChatMessage = { id: 'm_bg_q', role: 'user', text: 'Elsewhere', time };
  const turn: ChatMessage = { id: 'm_bg_a', role: 'assistant', text: '', time, runId: 'r_bg' };
  const final: ChatMessage = { ...turn, text: 'Done there.', result: { status: 'no-changes', summary: 'Done there.', changes: [], validation: [], canUndo: false } };
  const run = () => store.shownRun(store.getState());
  const ended = (runId: string) => ({ runId, conversationId: 'c_bg', kind: 'status', status: 'completed', mode: 'edit' }) as AiEvent;

  it('keeps status, pieces, its question and its end off the conversation on screen, and the run state its own', async () => {
    store.setState({ conversation: structuredClone(mine), runStatus: null, activeRunId: null, runConversationId: null, snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
    const shown = store.getState().conversation;
    const conversations = vi.fn(() => Promise.resolve({ active: { ...mine, id: 'c_bg' }, list: [] }));
    const w = (globalThis as unknown as { window: { builder: Record<string, unknown> } }).window;
    w.builder.ai = { conversations };
    try {
      // The request starts in the other thread: its messages, then its status at once, before the model is set up.
      store.applyAiEvent({ ...bg, kind: 'message', message: request });
      store.applyAiEvent({ ...bg, kind: 'message', message: turn });
      store.applyAiEvent({ ...bg, kind: 'status', status: 'preparing', mode: 'edit' });
      // Its status holds the app, but belongs to its own thread: the one on screen has no run to show or stop.
      expect(store.getState()).toMatchObject({ runStatus: 'preparing', activeRunId: 'r_bg', runConversationId: 'c_bg' });
      expect(run()).toBeNull();
      store.applyAiEvent({ ...bg, kind: 'status', status: 'running', mode: 'edit' });
      expect(store.getState()).toMatchObject({ runStatus: 'running', activeRunId: 'r_bg', runMode: 'edit', runConversationId: 'c_bg' });
      expect(run()).toBeNull();
      // Its text, whole or a piece, never lands here, and is never read for from main as if this thread missed it.
      store.applyAiEvent({ ...bg, kind: 'text', text: 'Working' });
      store.applyAiEvent({ ...bg, kind: 'text', text: ' on it', at: 7 });
      // Its question waits there, not here.
      store.applyAiEvent({ ...bg, kind: 'message', message: { ...turn, questions: [{ id: 'q1', text: 'Which page?', choices: [] }] } });
      store.applyAiEvent({ ...bg, kind: 'status', status: 'awaiting-input', mode: 'edit' });
      expect(store.getState().runStatus).toBe('awaiting-input');
      expect(run()).toBeNull();
      expect(store.getState().conversation).toBe(shown);
      // A read for missed text would be under way by now.
      await new Promise((r) => setTimeout(r, 10));
      expect(conversations).not.toHaveBeenCalled();

      // The end of a run that is not the one running never ends it.
      store.applyAiEvent(ended('r_stale'));
      expect(store.getState()).toMatchObject({ runStatus: 'awaiting-input', activeRunId: 'r_bg', runConversationId: 'c_bg' });

      // Its own end does, and its final message, which follows the end, never starts it again.
      store.applyAiEvent(ended('r_bg'));
      store.applyAiEvent({ ...bg, kind: 'message', message: final });
      expect(store.getState()).toMatchObject({ runStatus: null, activeRunId: null, runMode: null, runConversationId: null });
      // Nor does a status it sends after it ended.
      store.applyAiEvent({ ...bg, kind: 'status', status: 'running', mode: 'edit' });
      expect(store.getState()).toMatchObject({ runStatus: null, activeRunId: null, runConversationId: null });
      expect(store.getState().conversation).toBe(shown);
    } finally {
      delete w.builder.ai;
      store.setState({ snapshot: null, runConversationId: null } as Partial<ChatState>);
    }
  });

  it('shows the run in its own thread only, whichever thread is on screen as it goes', () => {
    const next = { runId: 'r_next', conversationId: 'c_bg' };
    const other: Conversation = { id: 'c_bg', title: 'Other', createdAt: time, messages: [request, { ...turn, runId: 'r_next' }] };
    store.setState({ conversation: structuredClone(other), runStatus: null, activeRunId: null, runConversationId: null } as Partial<ChatState>);
    store.applyAiEvent({ ...next, kind: 'status', status: 'running', mode: 'ask' });
    expect(run()).toEqual({ runId: 'r_next', status: 'running', mode: 'ask' });
    store.applyAiEvent({ ...next, kind: 'text', text: 'Read' });
    expect(said(store.getState().conversation?.messages)).toEqual(['user: Elsewhere', 'assistant: Read']);

    // Another thread on screen: the run goes on, but not there.
    store.setState({ conversation: structuredClone(mine) });
    expect(run()).toBeNull();
    expect(store.getState().runStatus).toBe('running');
    // Back on its own thread, it shows again.
    store.setState({ conversation: structuredClone(other) });
    expect(run()?.runId).toBe('r_next');

    // A run its project's closing cut off from its thread (its events tagged with none) shows in no thread.
    store.applyAiEvent({ runId: 'r_next', conversationId: '', kind: 'status', status: 'stopping', mode: 'ask' });
    expect(run()).toBeNull();
    expect(store.getState().runStatus).toBe('stopping');
    store.applyAiEvent({ runId: 'r_next', conversationId: '', kind: 'status', status: 'cancelled', mode: 'ask' });
    expect(store.getState()).toMatchObject({ runStatus: null, activeRunId: null, runConversationId: null });

    // Text that arrives for it after its end, even tagged with its own thread on screen, is no piece of it.
    const after = store.getState().conversation;
    store.applyAiEvent({ ...next, kind: 'text', text: 'Late' });
    expect(store.getState().conversation).toBe(after);
  });
});

describe('a reloaded window shows the conversation by its ID, with the request running in it (#1123)', () => {
  const w = () => (globalThis as unknown as { window: { builder: Record<string, unknown> } }).window;
  afterEach(() => {
    delete w().builder.ai;
    store.setState({ snapshot: null } as Partial<ChatState>);
  });

  it('shows a new conversation’s unsaved first turn as it streams, with its status, and follows it to its end', async () => {
    const env = await setup();
    const id = (await env.orch.loadConversations()).active.id;
    const r = await env.orch.send('Write an About page', env.ctx, id);
    await env.streaming();
    // The window reloads: nothing on screen, no status, and the turn has no file yet.
    store.setState({ conversation: null, runStatus: null, activeRunId: null, runMode: null, snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
    expect(existsSync(join(env.session.dir, '.siteorigin', 'sessions', 'chat', `${id}.json`))).toBe(false);
    const asked: Array<[string, string]> = [];
    w().builder.ai = {
      readConversation: async (cid: string, key: string) => {
        asked.push([cid, key]);
        return structuredClone(await env.orch.readConversation(cid));
      }
    };
    await store.showConversation({ id, title: 'New conversation', createdAt: '', messages: [] }, 'w1', () => true);
    expect(asked).toEqual([[id, 'w1']]);
    expect(said(store.getState().conversation?.messages)).toEqual(['user: Write an About page', 'assistant: Working on it.']);
    expect(store.getState()).toMatchObject({ runStatus: 'running', activeRunId: r.runId, runMode: 'edit', runConversationId: id });
    expect(store.shownRun(store.getState())?.runId).toBe(r.runId);

    // The rest of the reply lands in it, and the run ends there.
    env.adapter.late = ' Done.';
    env.adapter.release();
    await env.finished();
    expect(store.getState().conversation?.messages.at(-1)).toMatchObject({ text: 'Working on it. Done.', result: { status: 'no-changes' } });
    expect(store.getState().runStatus).toBeNull();
  });

  it('a read answered after the run ended never brings it back: the newer status stays, and the final turn is read again', async () => {
    const time = '2026-11-24T00:00:00.000Z';
    const user: ChatMessage = { id: 'm_q', role: 'user', text: 'Hi', time };
    const streaming: ChatMessage = { id: 'm_reply', role: 'assistant', text: 'Hel', time, runId: 'r_live' };
    const final: ChatMessage = { ...streaming, text: 'Hello.', result: { status: 'no-changes', summary: 'Hello.', changes: [], validation: [], canUndo: false } };
    const conv = (messages: ChatMessage[]): Conversation => ({ id: 'c_live', title: 'Live', createdAt: time, messages });
    store.setState({ conversation: null, runStatus: null, activeRunId: null, runMode: null, snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
    const answers: Array<(s: ConversationState) => void> = [];
    const readConversation = vi.fn(() => new Promise<ConversationState>((resolve) => answers.push(resolve)));
    w().builder.ai = { readConversation };
    const showing = store.showConversation(conv([]), 'w1', () => true);
    await until(() => answers.length === 1, 'the read');
    // Main read the turn mid-reply; before its answer arrives, the run ends and its final turn is sent, with nothing shown.
    store.applyAiEvent({ runId: 'r_live', conversationId: 'c_live', kind: 'status', status: 'no-changes', mode: 'edit' });
    store.applyAiEvent({ runId: 'r_live', conversationId: 'c_live', kind: 'message', message: final });
    answers[0]({ conversation: conv([user, streaming]), run: { runId: 'r_live', status: 'running', mode: 'edit' } });
    await showing;
    expect(store.getState()).toMatchObject({ runStatus: null, activeRunId: null });
    // The final turn it missed is read again, as main has it now.
    await until(() => answers.length === 2, 'the read again');
    answers[1]({ conversation: conv([user, final]), run: null });
    await until(() => store.getState().conversation?.messages.at(-1)?.text === 'Hello.', 'the final turn');
    expect(store.getState().conversation?.messages).toEqual([user, final]);
    expect(store.getState().runStatus).toBeNull();
  });

  it('keeps text streamed after it shows over the older copy the read again brings', async () => {
    // Its own run ID: an earlier test ended r_live, and pieces of a run that has ended are dropped (#1124).
    const time = '2026-11-24T00:00:00.000Z';
    const user: ChatMessage = { id: 'm_q', role: 'user', text: 'Hi', time };
    const reply = (text: string): ChatMessage => ({ id: 'm_reply', role: 'assistant', text, time, runId: 'r_stream' });
    const conv = (messages: ChatMessage[]): Conversation => ({ id: 'c_live', title: 'Live', createdAt: time, messages });
    store.setState({ conversation: null, runStatus: null, activeRunId: null, runMode: null, snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
    const answers: Array<(s: ConversationState) => void> = [];
    w().builder.ai = { readConversation: vi.fn(() => new Promise<ConversationState>((resolve) => answers.push(resolve))) };
    const showing = store.showConversation(conv([]), 'w1', () => true);
    await until(() => answers.length === 1, 'the read');
    // Text arrives while it is read, with nothing to land in; main's answer already has it.
    store.applyAiEvent({ runId: 'r_stream', conversationId: 'c_live', kind: 'text', text: 'Hel' });
    answers[0]({ conversation: conv([user, reply('Hel')]), run: { runId: 'r_stream', status: 'running', mode: 'edit' } });
    await showing;
    expect(store.getState()).toMatchObject({ runStatus: 'running', activeRunId: 'r_stream' });
    await until(() => answers.length === 2, 'the read again');
    // The next piece follows what is shown; the read again, taken before it, is older and leaves it.
    store.applyAiEvent({ runId: 'r_stream', conversationId: 'c_live', kind: 'text', text: 'lo', at: 3 });
    answers[1]({ conversation: conv([user, reply('Hel')]), run: { runId: 'r_stream', status: 'running', mode: 'edit' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(said(store.getState().conversation?.messages)).toEqual(['user: Hi', 'assistant: Hello']);
  });

  it('shows a question waiting for an answer as waiting, and nothing from another opening or a read that failed', async () => {
    const time = '2026-11-24T00:00:00.000Z';
    const asking: Conversation = { id: 'c_live', title: 'Live', createdAt: time, messages: [{ id: 'm_reply', role: 'assistant', text: '', time, runId: 'r_ask', questions: [{ id: 'q_1', text: 'Which page?', choices: ['Home', 'About'] }] }] };
    store.setState({ conversation: null, runStatus: null, activeRunId: null, runMode: null, runConversationId: null, snapshot: { workspaceKey: 'w1' } } as Partial<ChatState>);
    w().builder.ai = { readConversation: async () => ({ conversation: asking, run: { runId: 'r_ask', status: 'awaiting-input', mode: 'ask' } }) };
    await store.showConversation({ ...asking, messages: [] }, 'w1', () => true);
    expect(store.getState()).toMatchObject({ conversation: asking, runStatus: 'awaiting-input', activeRunId: 'r_ask', runMode: 'ask', runConversationId: 'c_live' });
    // Restored in its own thread, so the run shows there with its answer box (#1124).
    expect(store.shownRun(store.getState())).toEqual({ runId: 'r_ask', status: 'awaiting-input', mode: 'ask' });
    // The composer answers it again.
    const s = store.getState();
    expect(waitingQuestion(s.conversation, s.activeRunId, s.runStatus)).toMatchObject({ runId: 'r_ask', messageId: 'm_reply', question: { id: 'q_1' } });

    // A restore overtaken by a newer one, or by another opening, shows nothing.
    store.setState({ conversation: null, runStatus: null, activeRunId: null, runMode: null });
    await store.showConversation({ ...asking, messages: [] }, 'w1', () => false);
    await store.showConversation({ ...asking, messages: [] }, 'w0', () => true);
    expect(store.getState()).toMatchObject({ conversation: null, runStatus: null });

    // One that cannot be read shows what the restore had, with no run.
    w().builder.ai = { readConversation: async () => Promise.reject(new Error('The project changed, so the conversation was not read.')) };
    await store.showConversation({ ...asking, messages: [] }, 'w1', () => true);
    expect(store.getState()).toMatchObject({ conversation: { id: 'c_live', messages: [] }, runStatus: null });
  });
});
