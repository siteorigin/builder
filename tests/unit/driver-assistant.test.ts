// The assistant as the test driver sees it (tests/driver/assistant.ts, issue #495), without launching the app: the
// tracker that turns the app's journal of assistant events into entries keyed by conversation, message and run; the
// wait that ends only for its own run, and only where the author must act or the run is over; the script a scripted
// session's model plays, its gates and placeholders; and the explicit, bounded opt-in to a real provider.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  AssistantTracker,
  LIVE_OPT_IN,
  SCENARIOS,
  Script,
  latestResult,
  liveSettings,
  liveSetup,
  parseLive,
  parseObserveArgs,
  parseScript,
  parseStep,
  parseWaitArgs,
  pick,
  rendered,
  requestContext,
  resolveArgs,
  settledState,
  shownTurn,
  writeLiveKey
} from '../driver/assistant.ts';
import type { RawRecord, ShownChat } from '../driver/assistant.ts';
import { DriverError } from '../driver/protocol.ts';
import type { Reply } from '../driver/protocol.ts';
import { Session } from '../driver/session.ts';
import type { StartPhase } from '../driver/session.ts';
import { MockOpenAIServer } from './mock-openai-server.ts';

// ---------------------------------------------------------------------------
// The app's events, as the orchestrator sends them
// ---------------------------------------------------------------------------

function journal() {
  let seq = 0;
  const records: RawRecord[] = [];
  const add = (event: unknown) => records.push({ seq: ++seq, at: Date.UTC(2026, 10, 24, 12, 0, 0, seq), event });
  return { records, add, get seq() {
    return seq;
  } };
}

/** One run as the orchestrator tells it: its request, its turn, and every change to the turn after. */
function runOf(j: ReturnType<typeof journal>, runId: string, conversationId: string, text: string, opts: { mode?: 'edit' | 'ask'; user?: string; reply?: string } = {}) {
  const mode = opts.mode ?? 'edit';
  const userId = opts.user ?? `m_u_${runId}`;
  const msg: Record<string, any> = { id: opts.reply ?? `m_a_${runId}`, role: 'assistant', text: '', time: '', runId, activities: [] };
  const send = (cid = conversationId) => j.add({ runId, conversationId: cid, kind: 'message', message: structuredClone(msg) });
  return {
    start() {
      j.add({ runId, conversationId, kind: 'message', message: { id: userId, role: 'user', text, time: '', context: { mode, pageTitle: 'Home', selectionLabel: 'Split hero', assetIds: ['a_1'] }, images: [{ assetId: 'a_1', name: 'hero.jpg' }] } });
      send();
      msg.model = { provider: 'local', id: 'test-model', label: 'test-model' };
      send();
      return this;
    },
    status(status: string, cid = conversationId) {
      j.add({ runId, conversationId: cid, kind: 'status', status, mode });
      return this;
    },
    step(id: string, label: string, status = 'running') {
      const a = msg.activities.find((x: any) => x.id === id);
      if (a) a.status = status;
      else msg.activities.push({ id, label, status });
      send();
      return this;
    },
    /** As ask() does it: the status first, then the turn with its new question. */
    ask(id: string, question: string, choices: string[], widen = false) {
      this.status('awaiting-input');
      (msg.questions ??= []).push({ id, text: question, choices, ...(widen ? { widen: true } : {}) });
      send();
      return this;
    },
    /** As answer() does it: the turn with its answer, then the run working again. */
    answer(id: string, answer: string) {
      msg.questions.find((q: any) => q.id === id).answered = answer;
      send();
      this.status('running');
      return this;
    },
    text(t: string) {
      msg.text = t;
      j.add({ runId, conversationId, kind: 'text', text: t });
      return this;
    },
    /** As a run ends: its final status, then the turn with its result. */
    finish(status: string, summary: string, extra: Record<string, unknown> = {}, cid = conversationId) {
      this.status(status, cid);
      msg.result = { status, summary, changes: [], validation: [], canUndo: false, ...extra };
      send(cid);
      return this;
    }
  };
}

describe('the tracker', () => {
  it('follows a run from its request to its result, every entry keyed by its conversation, message and run', () => {
    const j = journal();
    const run = runOf(j, 'run_a', 'c_a', 'Make the hero shorter').start().status('running').step('act_1', 'Reading Home').step('act_1', 'Reading Home', 'done').text('Done.');
    run.finish('completed', 'Shortened it.', { changes: [{ label: 'Changed the heading of Split hero' }], canUndo: true });
    const t = new AssistantTracker();
    t.ingest(j.records);
    const { entries, next, latest } = t.read();
    expect(entries.map((e) => e.type)).toEqual(['run.started', 'model', 'status', 'step', 'step', 'text', 'status', 'result']);
    expect(entries.every((e) => e.runId === 'run_a' && e.conversationId === 'c_a' && e.messageId === 'm_a_run_a')).toBe(true);
    expect(entries[0].request).toEqual({ messageId: 'm_u_run_a', text: 'Make the hero shorter', mode: 'edit', target: 'Split hero', images: ['a_1'] });
    expect(entries.map((e) => e.seq)).toEqual([...entries.map((e) => e.seq)].sort((a, b) => a - b));
    expect([next, latest]).toEqual([j.seq, j.seq]);
    const v = t.runView('run_a')!;
    expect(v).toMatchObject({ state: 'terminal', status: 'completed', userMessageId: 'm_u_run_a', messageId: 'm_a_run_a', request: 'Make the hero shorter', text: 'Done.', model: { id: 'test-model' } });
    expect(v.result).toEqual({ status: 'completed', summary: 'Shortened it.', changes: ['Changed the heading of Split hero'], canUndo: true });
    expect(v.steps).toEqual([{ id: 'act_1', label: 'Reading Home', status: 'done' }]);
    expect(settledState(v)).toEqual({ reason: 'terminal' });
  });

  it('says where a run waits for the author, and never counts a question answered before the cursor as a new one', () => {
    const j = journal();
    const t = new AssistantTracker();
    const run = runOf(j, 'run_a', 'c_a', 'Interview me').start().status('running').ask('q_1', 'Who is it for?', ['New clients', 'Both']);
    t.ingest(j.records);
    let v = t.runView('run_a')!;
    expect(v.state).toBe('input');
    expect(v.question).toMatchObject({ questionId: 'q_1', text: 'Who is it for?', choices: ['New clients', 'Both'] });
    expect(settledState(v)).toEqual({ reason: 'input' });
    // The author answers: a cursor taken just before. Until the next question, nothing new waits for them.
    const before = t.cursor;
    expect(settledState(v, before)).toBeNull();
    run.answer('q_1', 'Both');
    t.ingest(j.records);
    v = t.runView('run_a')!;
    expect([v.state, settledState(v, before)]).toEqual(['working', null]);
    run.ask('q_2', 'Which tone?', [], false);
    t.ingest(j.records);
    v = t.runView('run_a')!;
    expect(settledState(v, before)).toEqual({ reason: 'input' });
    expect(v.question!.questionId).toBe('q_2');
    expect(v.questions.map((q) => [q.questionId, q.answer])).toEqual([
      ['q_1', 'Both'],
      ['q_2', undefined]
    ]);
    const types = t.read({ after: before }).entries.map((e) => e.type);
    expect(types).toEqual(['answer', 'status', 'status', 'question']);
  });

  it('marks a request to change more as such', () => {
    const j = journal();
    runOf(j, 'run_a', 'c_a', 'Match the hero').start().status('running').ask('q_1', 'May I also change the hero?', ['Yes, allow changes beyond the selection', 'No, only change the selection'], true);
    const t = new AssistantTracker();
    t.ingest(j.records);
    expect(t.runView('run_a')!.question).toMatchObject({ widen: true, choices: ['Yes, allow changes beyond the selection', 'No, only change the selection'] });
  });

  it('never lets one run’s events settle another: not another thread’s, not an earlier run in the same thread with the same words', () => {
    const j = journal();
    const t = new AssistantTracker();
    runOf(j, 'run_a', 'c_a', 'Suggest a tagline').start().status('running').finish('failed', 'The provider failed.');
    runOf(j, 'run_b', 'c_b', 'Suggest a tagline').start().status('running').finish('completed', 'Here it is.');
    const retry = runOf(j, 'run_c', 'c_a', 'Suggest a tagline').start().status('running');
    t.ingest(j.records);
    expect(settledState(t.runView('run_a')!)).toEqual({ reason: 'terminal' });
    expect(settledState(t.runView('run_b')!)).toEqual({ reason: 'terminal' });
    expect(settledState(t.runView('run_c')!)).toBeNull();
    expect(t.runView('run_c')).toMatchObject({ conversationId: 'c_a', request: 'Suggest a tagline', state: 'working', result: null });
    retry.finish('completed', 'Tagline: rooms that work.');
    t.ingest(j.records);
    expect(t.runView('run_c')!.result!.summary).toBe('Tagline: rooms that work.');
    expect(t.runView('run_a')!.result!.summary).toBe('The provider failed.');
  });

  it('takes a run’s final status as finishing until its result arrives', () => {
    const j = journal();
    const t = new AssistantTracker();
    const run = runOf(j, 'run_a', 'c_a', 'Change it').start().status('running').status('stopping').status('cancelled');
    t.ingest(j.records);
    expect([t.runView('run_a')!.state, settledState(t.runView('run_a')!)]).toEqual(['ending', null]);
    run.finish('cancelled', 'Stopped.');
    t.ingest(j.records);
    expect(settledState(t.runView('run_a')!)).toEqual({ reason: 'terminal' });
  });

  it('follows a run whose status arrives before its turn', () => {
    const t = new AssistantTracker();
    t.ingest([
      { seq: 1, at: 1, event: { runId: 'run_a', conversationId: 'c_a', kind: 'status', status: 'preparing', mode: 'ask' } },
      { seq: 2, at: 2, event: { runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_a', role: 'assistant', runId: 'run_a', text: '', activities: [] } } }
    ]);
    const types = t.read().entries.map((e) => [e.type, e.messageId]);
    expect(types).toEqual([
      ['status', null],
      ['run.started', 'm_a']
    ]);
    expect(t.runView('run_a')).toMatchObject({ mode: 'ask', messageId: 'm_a', conversationId: 'c_a' });
  });

  it('fills in a run’s request when it arrives after the run was first seen', () => {
    const t = new AssistantTracker();
    t.ingest([
      { seq: 1, at: 1, event: { runId: 'run_a', conversationId: 'c_a', kind: 'status', status: 'preparing', mode: 'edit' } },
      { seq: 2, at: 2, event: { runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_u', role: 'user', text: 'Shorter', context: { mode: 'edit', selectionLabel: 'Split hero' } } } }
    ]);
    expect(t.runView('run_a')).toMatchObject({ userMessageId: 'm_u', request: 'Shorter', target: 'Split hero' });
  });

  it('keeps a run in its own conversation when its project closes while it runs', () => {
    const j = journal();
    const t = new AssistantTracker();
    runOf(j, 'run_a', 'c_a', 'Change it').start().status('running').finish('cancelled', 'Stopped.', {}, '');
    t.ingest(j.records);
    const v = t.runView('run_a')!;
    expect([v.conversationId, v.detached, v.state]).toEqual(['c_a', true, 'terminal']);
    const last = t.read().entries.at(-1)!;
    expect([last.type, last.conversationId, last.detached]).toEqual(['result', 'c_a', true]);
  });

  it('notes a change to the transcript outside any run', () => {
    const t = new AssistantTracker();
    t.ingest([{ seq: 1, at: 1, event: { runId: '', conversationId: 'c_a', kind: 'message', message: { id: 'm_a', role: 'assistant', text: '' } } }]);
    expect(t.read().entries).toMatchObject([{ type: 'update', conversationId: 'c_a', runId: null, messageId: 'm_a' }]);
  });

  it('reads a page at a time without splitting a seq, filters by run or conversation, and moves the cursor to the end', () => {
    const j = journal();
    const t = new AssistantTracker();
    runOf(j, 'run_a', 'c_a', 'One').start().status('running').finish('completed', 'Done.');
    runOf(j, 'run_b', 'c_b', 'Two').start().status('running');
    t.ingest(j.records);
    const all = t.read().entries;
    const first = t.read({ limit: 2 });
    expect(first.entries).toEqual(all.slice(0, 2));
    expect(first.next).toBe(all[1].seq);
    const rest = t.read({ after: first.next, limit: 100 });
    expect(rest.entries).toEqual(all.slice(2));
    const onlyB = t.read({ runId: 'run_b' });
    expect(onlyB.entries.every((e) => e.runId === 'run_b')).toBe(true);
    expect(onlyB.next).toBe(j.seq);
    expect(t.read({ conversationId: 'c_a' }).entries.map((e) => e.runId)).toEqual(all.filter((e) => e.conversationId === 'c_a').map((e) => e.runId));
    expect(t.read({ after: j.seq })).toMatchObject({ entries: [], next: j.seq, missed: 0 });
  });

  it('says how much a cursor missed once entries are let go, and marks a gap in the journal', () => {
    const j = journal();
    const t = new AssistantTracker({ maxEntries: 3 });
    runOf(j, 'run_a', 'c_a', 'One').start().status('running').finish('completed', 'Done.');
    t.ingest(j.records);
    const page = t.read();
    expect(page.entries).toHaveLength(3);
    expect(page.missed).toBeGreaterThan(0);
    expect(page.oldest).toBe(page.missed + 1);
    expect(t.read({ after: page.oldest - 1 }).missed).toBe(0);
    const later = new AssistantTracker();
    later.ingest([{ seq: 8, at: 8, event: { runId: 'run_z', conversationId: 'c_z', kind: 'status', status: 'running' } }], 7);
    expect(later.read().entries.map((e) => [e.type, e.missed ?? null])).toEqual([
      ['gap', 7],
      ['status', null]
    ]);
  });

  it('ignores records it has already taken in', () => {
    const j = journal();
    runOf(j, 'run_a', 'c_a', 'One').start().status('running');
    const t = new AssistantTracker();
    t.ingest(j.records);
    const n = t.read().entries.length;
    t.ingest(j.records);
    expect(t.read().entries).toHaveLength(n);
  });
});

// ---------------------------------------------------------------------------
// What the panel shows, matched to a run
// ---------------------------------------------------------------------------

describe('a run as the chat shows it', () => {
  const chat = (over: Partial<ShownChat> = {}): ShownChat => ({
    visible: true,
    conversationId: 'c_a',
    title: 'One',
    messages: [
      { messageId: 'm_u', role: 'user', text: 'One' },
      { messageId: 'm_a', role: 'assistant', runId: 'run_a', text: '', result: { status: 'completed', heading: 'Completed', summary: 'Done.', buttons: [] } }
    ],
    question: null,
    run: null,
    composer: null,
    notices: [],
    ...over
  });
  const view = () => {
    const j = journal();
    runOf(j, 'run_a', 'c_a', 'One', { user: 'm_u', reply: 'm_a' }).start().status('running').finish('completed', 'Done.');
    const t = new AssistantTracker();
    t.ingest(j.records);
    return t.runView('run_a')!;
  };

  it('finds the run’s request and reply by their IDs, only in the run’s own conversation', () => {
    const v = view();
    expect(shownTurn(chat(), v)).toMatchObject({ visible: true, request: { messageId: 'm_u' }, reply: { messageId: 'm_a' } });
    expect(shownTurn(chat({ conversationId: 'c_b' }), v)).toBeNull();
    expect(rendered(chat(), v, 'terminal')).toBe(true);
    expect(rendered(chat({ messages: [] }), v, 'terminal')).toBe(false);
  });

  it('counts a question as shown only when the card is that run’s and that question', () => {
    const j = journal();
    runOf(j, 'run_a', 'c_a', 'One').start().status('running').ask('q_2', 'Which tone?', []);
    const t = new AssistantTracker();
    t.ingest(j.records);
    const v = t.runView('run_a')!;
    const card = (runId: string, questionId: string) => chat({ question: { runId, messageId: 'm_a', questionId, text: 'Which tone?', choices: [], images: [] } });
    expect(rendered(card('run_a', 'q_2'), v, 'input')).toBe(true);
    expect(rendered(card('run_a', 'q_1'), v, 'input')).toBe(false);
    expect(rendered(card('run_b', 'q_2'), v, 'input')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

const request = (messages: unknown[]) => ({ url: '/v1/chat/completions', method: 'POST', headers: {}, body: { messages } });
const ctxMessage = (ctx: unknown) => ({ role: 'user', content: `Do it\n\n<editor_context>\n${JSON.stringify(ctx, null, 1)}\n</editor_context>` });
/** The envelope a reply streams, put back together. */
const envelope = (reply: { frames?: unknown[] }) =>
  JSON.parse(
    (reply.frames ?? [])
      .map((f: any) => (typeof f === 'object' ? (f.choices?.[0]?.delta?.content ?? '') : ''))
      .join('')
  );

describe('the script', () => {
  it('answers each request with the next step, in order, and says when none is left without a retry taking a later one', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'read_page', args: { pageId: 'pg_1' }, status: 'Reading' }, { tool: 'finish', args: { message: 'Done.' } }] }).steps);
    expect(envelope(s.next(request([])))).toEqual({ brief_status: 'Reading', action: { tool: 'read_page', args: { pageId: 'pg_1' } } });
    expect(envelope(s.next(request([])))).toEqual({ brief_status: 'Working', action: { tool: 'finish', args: { message: 'Done.' } } });
    const none = s.next(request([]));
    expect([none.status, JSON.parse(none.body!).error.message]).toEqual([409, 'No scripted reply left']);
    expect(s.state()).toMatchObject({ pending: 0, answered: 2 });
  });

  it('fills placeholders from the request it answers: its editor context, and its latest tool result', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'bind', args: { page: { $context: 'pageId' }, node: { $context: 'selection.nodeId' }, inserted: { $result: 'nodeId' }, first: { $result: 'sections.0.id' }, kept: [1, { $context: 'project.revision' }] } }] }).steps);
    const req = request([
      { role: 'system', content: 'You edit.' },
      ctxMessage({ currentPage: { id: 'pg_1', title: 'Home' }, selection: { nodeId: 'n_sel' }, project: { revision: 7 } }),
      { role: 'assistant', content: '{"brief_status":"Inserting","action":{"tool":"insert","args":{}}}' },
      { role: 'user', content: `Result of insert:\n${JSON.stringify({ ok: true, result: { nodeId: 'n_new' }, sections: [{ id: 'n_1' }] })}` }
    ]);
    expect(envelope(s.next(req)).action.args).toEqual({ page: 'pg_1', node: 'n_sel', inserted: 'n_new', first: 'n_1', kept: [1, 7] });
  });

  it('answers a step whose placeholder finds nothing with a failure that names it, keeping the rest for later', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'bind', args: { node: { $result: 'nodeId' } } }, { tool: 'finish', args: { message: 'x' } }] }).steps);
    const r = s.next(request([ctxMessage({ currentPage: { id: 'pg_1' } })]));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body!).error.message).toBe('Step 1 could not be sent: the request carries no tool result');
    expect(s.state()).toMatchObject({ pending: 1, errors: [{ step: 1, message: 'Step 1 could not be sent: the request carries no tool result' }] });
  });

  it('holds a gated step until it is released, and reports where each gate is', async () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'finish', args: { message: 'x' }, gate: 'g1' }] }).steps);
    expect(s.state().gates).toEqual([{ name: 'g1', state: 'pending' }]);
    const reply = s.next(request([]));
    expect(s.state().gates).toEqual([{ name: 'g1', state: 'reached' }]);
    let let_go = false;
    void reply.hold!.then(() => (let_go = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(let_go).toBe(false);
    expect(s.release('g1')).toEqual({ gate: 'g1', state: 'released' });
    await reply.hold;
    expect(let_go).toBe(true);
    // Again changes nothing; a gate never scripted is not there.
    expect(s.release('g1')).toEqual({ gate: 'g1', state: 'released' });
    expect(() => s.release('nope')).toThrow(expect.objectContaining({ code: 'TARGET_NOT_FOUND' }));
  });

  it('refuses a gate named twice, and replacing drops the waiting steps with their gates', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'a', gate: 'g1' }, { tool: 'b', gate: 'g2' }] }).steps);
    expect(() => s.add(parseScript({ steps: [{ tool: 'c', gate: 'g1' }] }).steps)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(() => s.add(parseScript({ steps: [{ tool: 'c', gate: 'g3' }, { tool: 'd', gate: 'g3' }] }).steps)).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(s.add(parseScript({ steps: [{ tool: 'c' }], mode: 'replace' }).steps, 'replace')).toMatchObject({ pending: 1, gates: [] });
    expect(envelope(s.next(request([]))).action.tool).toBe('c');
  });

  it('lets every held reply go when the session closes', async () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'a', gate: 'g1' }, { tool: 'b' }] }).steps);
    const held = s.next(request([]));
    s.close();
    await held.hold;
    expect(s.state().pending).toBe(0);
  });

  it('holds an error reply at its gate too, on the real server', async () => {
    const server = await new MockOpenAIServer().start();
    try {
      const s = new Script();
      s.add(parseScript({ scenario: 'fail', params: { message: 'Down for now.' } }).steps.map((st) => ({ ...st, gate: 'g' })));
      server.respond = (req) => s.next(req);
      let answered = false;
      const res = fetch(`${server.baseURL}/chat/completions`, { method: 'POST', body: '{}' }).then(async (r) => ((answered = true), [r.status, await r.json()]));
      await new Promise((r) => setTimeout(r, 100));
      expect(answered).toBe(false);
      s.release('g');
      expect(await res).toEqual([409, { error: { message: 'Down for now.' } }]);
    } finally {
      await server.stop();
    }
  });

  it('makes each named scenario from its params, and says what is missing', () => {
    expect(parseScript({ scenario: 'answer', params: { text: 'Hi.' } }).steps).toEqual([{ tool: 'finish', args: { message: 'Hi.' }, status: 'Answering' }]);
    expect(parseScript({ scenario: 'interview', params: { questions: [{ question: 'A?', choices: ['x'] }, { question: 'B?' }], then: 'Done.' } }).steps.map((s: any) => [s.tool, s.args.question ?? s.args.message])).toEqual([
      ['request_clarification', 'A?'],
      ['request_clarification', 'B?'],
      ['finish', 'Done.']
    ]);
    expect(parseScript({ scenario: 'edit-selection', params: { props: { heading: 'H' }, summary: 'Done.' } }).steps[0]).toMatchObject({ tool: 'update_selected_props', args: { props: { heading: 'H' } } });
    expect(parseScript({ scenario: 'widen', params: { question: 'More?', then: 'Done.' } }).steps[0]).toMatchObject({ tool: 'request_wider_scope' });
    expect(parseScript({ scenario: 'fail' }).steps).toEqual([{ error: { status: 409, message: 'The scripted provider refused the request.' } }]);
    expect(parseScript({ scenario: 'read-and-answer', params: { text: 'Hi.' } }).steps[0]).toMatchObject({ tool: 'read_page', args: { pageId: { $context: 'pageId' } } });
    for (const name of Object.keys(SCENARIOS)) expect(SCENARIOS[name].summary).toBeTruthy();
    expect(() => parseScript({ scenario: 'answer' })).toThrow(/"text"/);
    expect(() => parseScript({ scenario: 'interview', params: { then: 'x' } })).toThrow(/questions/);
    expect(() => parseScript({ scenario: 'nope' })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST', details: expect.objectContaining({ scenarios: expect.any(Object) }) }));
  });

  it('checks every step and the request around them', () => {
    const bad = (args: unknown) => () => parseScript(args as Record<string, unknown>);
    expect(bad({})).toThrow(/one of them/);
    expect(bad({ scenario: 'answer', params: { text: 'x' }, steps: [] })).toThrow(/one of them/);
    expect(bad({ steps: [] })).toThrow(/1 to 100/);
    expect(bad({ steps: [{ tool: 'finish' }], params: {} })).toThrow(/goes with a "scenario"/);
    expect(bad({ steps: [{ tool: 'finish' }], mode: 'merge' })).toThrow(/append/);
    expect(bad({ steps: [{ tool: 'finish' }], extra: 1 })).toThrow(/does not take "extra"/);
    expect(() => parseStep({ tool: 'finish', error: { status: 500 } }, 0)).toThrow(/not both/);
    expect(() => parseStep({ error: { status: 200 } }, 0)).toThrow(/400-599/);
    expect(() => parseStep({ tool: '' }, 2)).toThrow(/Step 3 names its "tool"/);
    expect(() => parseStep({ tool: 'finish', gate: 'a b' }, 0)).toThrow(/gate/);
    expect(() => parseStep({ tool: 'finish', delayMs: -1 }, 0)).toThrow(/delayMs/);
    expect(() => parseStep({ tool: 'finish', args: [] }, 0)).toThrow(/"args" is an object/);
    expect(() => parseStep({ tool: 'finish', note: 1 }, 0)).toThrow(/does not take "note"/);
    expect(parseStep({ error: { status: 401, message: 'No.' }, gate: 'g', delayMs: 5 }, 0)).toEqual({ error: { status: 401, message: 'No.' }, gate: 'g', delayMs: 5 });
  });
});

describe('reading a request', () => {
  it('finds the latest editor context, and the latest tool result in either format', () => {
    const req = request([ctxMessage({ a: 1 }), { role: 'assistant', content: 'x' }, ctxMessage({ a: 2 })]);
    expect(requestContext(req)).toEqual({ a: 2 });
    expect(requestContext(request([{ role: 'user', content: 'no context' }]))).toBeNull();
    expect(latestResult(request([{ role: 'user', content: 'Result of read_page:\n{"id":"pg_1"}' }, { role: 'user', content: 'plain words' }]))).toEqual({ tool: 'read_page', value: { id: 'pg_1' } });
    expect(latestResult(request([{ role: 'user', content: 'Error from apply:\nnot json' }]))).toEqual({ tool: 'apply', value: 'not json' });
    expect(latestResult(request([{ role: 'tool', name: 'read_page', content: '{"id":"pg_2"}' }]))).toEqual({ tool: 'read_page', value: { id: 'pg_2' } });
    expect(latestResult(request([]))).toBeNull();
  });

  it('picks a value by its dotted path, list indexes included', () => {
    expect(pick({ a: { b: [{ c: 3 }] } }, 'a.b.0.c')).toBe(3);
    expect(pick({ a: 1 }, 'a.b')).toBeUndefined();
    expect(pick({ a: [1] }, 'a.x')).toBeUndefined();
  });

  it('leaves arguments without placeholders as they are, and names a missing context path', () => {
    expect(resolveArgs({ a: [{ b: 'c' }], d: { $context: 'x', y: 1 } }, request([]))).toEqual({ a: [{ b: 'c' }], d: { $context: 'x', y: 1 } });
    expect(() => resolveArgs({ a: { $context: 'pageId' } }, request([]))).toThrow('the request carries no editor context');
    expect(() => resolveArgs({ a: { $context: 'nope' } }, request([ctxMessage({ currentPage: { id: 'pg_1' } })]))).toThrow('the editor context has no nope');
  });
});

describe('the requests to observe and wait', () => {
  it('reads observe’s and wait’s arguments, and refuses anything else', () => {
    expect(parseObserveArgs(undefined)).toEqual({});
    expect(parseObserveArgs({ after: 3, limit: 10, runId: 'run_a', conversationId: 'c_a' })).toEqual({ after: 3, limit: 10, runId: 'run_a', conversationId: 'c_a' });
    expect(() => parseObserveArgs({ after: -1 })).toThrow(/cursor/);
    expect(() => parseObserveArgs({ limit: 0 })).toThrow(/1 to 1000/);
    expect(() => parseObserveArgs({ runId: '' })).toThrow(/ID/);
    expect(() => parseObserveArgs({ wait: true })).toThrow(/does not take "wait"/);
    expect(parseWaitArgs({ runId: 'run_a' })).toEqual({ runId: 'run_a' });
    expect(parseWaitArgs({ runId: 'run_a', after: 0 })).toEqual({ runId: 'run_a', after: 0 });
    expect(() => parseWaitArgs({})).toThrow(/names its "runId"/);
    expect(() => parseWaitArgs({ runId: 'run_a', after: 1.5 })).toThrow(/cursor/);
    expect(() => parseWaitArgs({ runId: 'run_a', conversationId: 'c_a' })).toThrow(/does not take/);
  });
});

// ---------------------------------------------------------------------------
// A real provider, by explicit opt-in
// ---------------------------------------------------------------------------

describe('a configured provider', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'driver-assistant-')));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const KEY = 'sk-test-0123456789abcdefghij';

  it('takes the host’s own yes and its key, never one from the request', () => {
    const live = parseLive({ provider: 'openai', model: 'gpt-6.2-sol' });
    expect(() => liveSetup(live, { OPENAI_API_KEY: KEY })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST', details: { reason: 'not-opted-in' } }));
    expect(() => liveSetup(live, { [LIVE_OPT_IN]: '1' })).toThrow(expect.objectContaining({ details: { reason: 'no-key', variable: 'OPENAI_API_KEY' } }));
    expect(liveSetup(live, { [LIVE_OPT_IN]: '1', OPENAI_API_KEY: ` ${KEY} ` })).toEqual({ provider: 'openai', model: 'gpt-6.2-sol', maxTurns: 1, timeoutMs: 120000, key: KEY });
    expect(liveSetup(parseLive({ provider: 'anthropic', maxTurns: 5, timeoutMs: 900000 }), { [LIVE_OPT_IN]: '1', ANTHROPIC_API_KEY: KEY })).toMatchObject({ provider: 'anthropic', maxTurns: 5, timeoutMs: 900000 });
    // A local server needs no key, only its address.
    expect(liveSetup(parseLive({ provider: 'local', baseURL: 'http://127.0.0.1:1234/v1' }), { [LIVE_OPT_IN]: '1' })).toEqual({ provider: 'local', baseURL: 'http://127.0.0.1:1234/v1', maxTurns: 1, timeoutMs: 120000 });
  });

  it('is bounded, and says what it takes', () => {
    expect(() => parseLive({ provider: 'openai', key: KEY })).toThrow(/does not take "key"/);
    expect(() => parseLive({ provider: 'openai', maxTurns: 6 })).toThrow(/1 to 5/);
    expect(() => parseLive({ provider: 'openai', timeoutMs: 900001 })).toThrow(/900000/);
    expect(() => parseLive({ provider: 'local' })).toThrow(/baseURL/);
    expect(() => parseLive({ provider: 'openai', baseURL: 'http://x' })).toThrow(/local server/);
    expect(() => parseLive({ provider: 'local', baseURL: 'file:///x' })).toThrow(/http/);
    expect(() => parseLive({ provider: 'gemini' })).toThrow(/openai/);
  });

  it('gives the app the provider and model, and nothing secret', () => {
    expect(liveSettings({ provider: 'openai', model: 'gpt-6.2-sol', maxTurns: 1, timeoutMs: 1000, key: KEY })).toEqual({ ai: { provider: 'openai', models: { openai: 'gpt-6.2-sol' } } });
    expect(liveSettings({ provider: 'local', baseURL: 'http://127.0.0.1:1/v1', maxTurns: 1, timeoutMs: 1000 })).toEqual({ ai: { provider: 'local', local: { baseURL: 'http://127.0.0.1:1/v1', allowRemote: false } } });
  });

  it('puts the key in a new file in the profile, readable only by this account', async () => {
    const profile = mkdtempSync(join(scratch, 'profile-'));
    await writeLiveKey(profile, { provider: 'openai', maxTurns: 1, timeoutMs: 1000, key: KEY });
    const file = join(profile, 'api-keys.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ openai: KEY });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(writeLiveKey(profile, { provider: 'openai', maxTurns: 1, timeoutMs: 1000, key: KEY })).rejects.toThrow(/EEXIST/);
    const local = mkdtempSync(join(scratch, 'profile-'));
    await writeLiveKey(local, { provider: 'local', baseURL: 'http://127.0.0.1:1/v1', maxTurns: 1, timeoutMs: 1000 });
    expect(readdirSync(local)).toEqual([]);
  });

  describe('in a session', () => {
    const appRoot = join(scratch, 'app');
    mkdirSync(join(appRoot, 'out', 'main'), { recursive: true });
    mkdirSync(join(appRoot, 'out', 'renderer'), { recursive: true });
    writeFileSync(join(appRoot, 'out', 'main', 'index.js'), '// main');
    writeFileSync(join(appRoot, 'out', 'renderer', 'index.html'), '<!doctype html>');
    writeFileSync(join(appRoot, 'package.json'), '{"version":"9.9.9"}');
    const saved = { [LIVE_OPT_IN]: process.env[LIVE_OPT_IN], OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    let n = 0;
    const start = (session: Session, args: Record<string, unknown>, timeoutMs?: number) => session.call({ v: 1, id: `s${++n}`, op: 'session.start', args, ...(timeoutMs ? { timeoutMs } : {}) });

    it('refuses to start without the host’s yes, before anything is made', async () => {
      delete process.env[LIVE_OPT_IN];
      process.env.OPENAI_API_KEY = KEY;
      const parentDir = mkdtempSync(join(scratch, 'parent-'));
      const s = new Session({ appRoot, parentDir });
      const r = (await start(s, { provider: 'configured', live: { provider: 'openai' } })) as Reply;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'not-opted-in' } });
      expect([s.state, readdirSync(parentDir)]).toEqual(['new', []]);
      expect(JSON.stringify(r)).not.toContain(KEY);
    });

    it('pairs a configured provider with its live arguments, and nothing else with them', async () => {
      const s = new Session({ appRoot, parentDir: mkdtempSync(join(scratch, 'parent-')) });
      for (const args of [{ provider: 'configured' }, { live: { provider: 'openai' } }, { provider: 'scripted', live: { provider: 'openai' } }]) {
        const r = (await start(s, args)) as Reply;
        expect(!r.ok && r.error.code).toBe('BAD_REQUEST');
      }
    });

    it('says which provider it uses and its limits, never the key, while starting and in a failed start', async () => {
      process.env[LIVE_OPT_IN] = '1';
      process.env.OPENAI_API_KEY = KEY;
      const parentDir = mkdtempSync(join(scratch, 'parent-'));
      let reached!: () => void;
      const atPhase = new Promise<void>((r) => (reached = r));
      const s = new Session({ appRoot, parentDir, hooks: { phase: (p: StartPhase) => (p === 'provider' ? (reached(), new Promise<void>(() => undefined)) : undefined) } });
      const starting = start(s, { provider: 'configured', live: { provider: 'openai', model: 'gpt-6.2-sol', maxTurns: 2 }, keepArtifacts: 'always' }, 2000);
      await atPhase;
      // Requests wait their turn behind the start; the session describes itself in process meanwhile.
      const described = await s.describe();
      expect(described.session.provider).toEqual({ kind: 'configured', provider: 'openai', model: 'gpt-6.2-sol', maxTurns: 2, timeoutMs: 120000 });
      expect(JSON.stringify(described)).not.toContain(KEY);
      const failed = (await starting) as Reply;
      expect(!failed.ok && failed.error.code).toBe('TIMEOUT');
      expect(JSON.stringify(failed)).not.toContain(KEY);
      const artifacts = !failed.ok ? (failed.error.details!.artifacts as string) : '';
      for (const f of readdirSync(artifacts)) expect(readFileSync(join(artifacts, f), 'utf8')).not.toContain(KEY);
    });

    it('has no script to set, being no scripted session', async () => {
      const s = new Session({ appRoot });
      const r = (await s.call({ v: 1, id: 'x', op: 'assistant.script', args: { scenario: 'answer', params: { text: 'Hi.' } } })) as Reply;
      expect(!r.ok && r.error.code).toBe('NOT_STARTED');
      expect(new DriverError('OP_FAILED', 'x').code).toBe('OP_FAILED');
    });
  });
});
