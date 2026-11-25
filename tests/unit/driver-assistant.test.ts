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
  scrubAssistant,
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
    /** As a run that stops at a limit does: its words so far are cleared before its result is sent. */
    clearText() {
      msg.text = '';
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
    expect(entries[0].request).toEqual({ messageId: 'm_u_run_a', text: 'Make the hero shorter', mode: 'edit', target: 'Split hero', page: 'Home', images: ['a_1'] });
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
    expect(page.missed).toBeLessThan(page.oldest);
    expect(t.read({ after: page.oldest - 1 }).missed).toBe(0);
    const later = new AssistantTracker();
    later.ingest([{ seq: 8, at: 8, event: { runId: 'run_z', conversationId: 'c_z', kind: 'status', status: 'running' } }], 7);
    expect(later.read().entries.map((e) => [e.type, e.missed ?? null])).toEqual([
      ['gap', 7],
      ['status', null]
    ]);
  });

  it('takes a turn with a result as over, even when the status that said so was dropped', () => {
    const j = journal();
    const run = runOf(j, 'run_a', 'c_a', 'One').start().status('running');
    run.finish('completed', 'Done.');
    const t = new AssistantTracker();
    // The final status is lost; the turn with its result arrives.
    t.ingest(j.records.filter((r) => !(r.event as any).kind || (r.event as any).kind !== 'status' || (r.event as any).status !== 'completed'));
    const v = t.runView('run_a')!;
    expect([v.status, v.state, settledState(v)]).toEqual(['running', 'terminal', { reason: 'terminal' }]);
  });

  it('after a gap, trusts a run’s question again only once the run sends its whole turn', () => {
    const j = journal();
    const run = runOf(j, 'run_a', 'c_a', 'Interview me').start().status('running').ask('q_1', 'Who?', ['A', 'B']);
    const t = new AssistantTracker();
    t.ingest(j.records);
    expect(settledState(t.runView('run_a')!)).toEqual({ reason: 'input' });
    // The answer and the run's end are dropped from the journal before they are read.
    run.answer('q_1', 'A').finish('completed', 'Done.');
    const lost = j.records.length;
    runOf(j, 'run_b', 'c_b', 'Other').start().status('running');
    t.ingest(j.records.slice(lost + 1), lost + 1 - t.cursor);
    const v = t.runView('run_a')!;
    expect([v.state, v.gap, settledState(v)]).toEqual(['input', true, null]);
    expect(t.runView('run_b')!.gap).toBeUndefined();
    // The run's next whole turn says where it really is.
    j.add({ runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_a_run_a', role: 'assistant', runId: 'run_a', text: '', activities: [], questions: [{ id: 'q_1', text: 'Who?', choices: ['A', 'B'], answered: 'A' }], result: { status: 'completed', summary: 'Done.', changes: [], validation: [], canUndo: false } } });
    t.ingest(j.records.slice(-1));
    const after = t.runView('run_a')!;
    expect([after.state, after.gap, after.questions[0].answer]).toEqual(['terminal', undefined, 'A']);
  });

  it('after a gap, takes an unanswered question in the run’s whole turn as waiting for the author', () => {
    const t = new AssistantTracker();
    t.ingest([{ seq: 1, at: 1, event: { runId: 'run_a', conversationId: 'c_a', kind: 'status', status: 'running' } }]);
    // The status that said it waits was dropped; the turn with the question arrives.
    t.ingest([{ seq: 4, at: 4, event: { runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_a', role: 'assistant', runId: 'run_a', text: '', questions: [{ id: 'q_1', text: 'Who?', choices: [] }] } } }], 2);
    const v = t.runView('run_a')!;
    expect([v.status, v.state, v.gap, settledState(v)]).toEqual(['awaiting-input', 'input', undefined, { reason: 'input' }]);
  });

  it('after a gap, follows a run it first meets by its question', () => {
    const t = new AssistantTracker();
    t.ingest([{ seq: 7, at: 7, event: { runId: 'run_n', conversationId: 'c_a', kind: 'message', message: { id: 'm_n', role: 'assistant', runId: 'run_n', text: '', questions: [{ id: 'q_1', text: 'Who?', choices: [] }] } } }], 6);
    expect(settledState(t.runView('run_n')!)).toEqual({ reason: 'input' });
  });

  it('keeps a gap’s count once its marker is let go', () => {
    const t = new AssistantTracker({ maxEntries: 1 });
    t.ingest([{ seq: 501, at: 1, event: { runId: 'run_a', conversationId: 'c_a', kind: 'status', status: 'running' } }], 500);
    t.ingest([{ seq: 502, at: 2, event: { runId: 'run_a', conversationId: 'c_a', kind: 'status', status: 'validating' } }]);
    expect(t.read().missed).toBe(501);
  });

  it('counts as missed only the events whose entries were let go', () => {
    const j = journal();
    const t = new AssistantTracker({ maxEntries: 2 });
    // Every record of this run makes entries but its request, which makes none: missed counts entries' seqs only.
    runOf(j, 'run_a', 'c_a', 'One').start().status('running').status('validating').status('completed');
    t.ingest(j.records);
    const kept = t.read();
    const dropped = new Set(j.records.filter((r) => r.seq < kept.oldest && !((r.event as any).message?.role === 'user')).map((r) => r.seq));
    expect(kept.missed).toBe(dropped.size);
  });

  it('never hides a gap behind a filter, and counts it as missed', () => {
    const t = new AssistantTracker();
    t.ingest([{ seq: 9, at: 9, event: { runId: 'run_a', conversationId: 'c_a', kind: 'status', status: 'running' } }], 8);
    expect(t.read({ runId: 'run_b' })).toMatchObject({ entries: [{ type: 'gap', missed: 8 }], missed: 8, next: 9 });
    expect(t.read({ conversationId: 'c_z' }).entries.map((e) => e.type)).toEqual(['gap']);
    expect(t.read({ after: 8 }).missed).toBe(0);
  });

  it('lets entries go a whole seq at a time', () => {
    const j = journal();
    // One turn update that answers a question and finishes a step: two entries of one seq.
    const run = runOf(j, 'run_a', 'c_a', 'One').start().status('running').step('act_1', 'Reading').ask('q_1', 'Who?', []);
    const t = new AssistantTracker({ maxEntries: 3 });
    t.ingest(j.records);
    run.step('act_1', 'Reading', 'done');
    const shared = j.records.length;
    run.answer('q_1', 'Me');
    t.ingest(j.records);
    const page = t.read();
    const seqs = page.entries.map((e) => e.seq);
    // Whatever is kept holds every entry of each of its seqs, and nothing older than `oldest`.
    for (const seq of new Set(seqs)) expect(seqs.filter((x) => x === seq).length).toBe(t.read({ after: seq - 1 }).entries.filter((e) => e.seq === seq).length);
    expect(seqs.every((x) => x >= page.oldest)).toBe(true);
    expect(shared).toBeGreaterThan(0);
  });

  it('notes a turn’s text cleared, as a run stopped at a limit clears it', () => {
    const j = journal();
    const run = runOf(j, 'run_a', 'c_a', 'One').start().status('running').text('Working on it');
    run.clearText().finish('completed', 'Partly done.', { incomplete: true });
    const t = new AssistantTracker();
    t.ingest(j.records);
    expect(t.runView('run_a')!.text).toBe('');
  });

  it('keeps each answer with its question, and a plain question unmarked as wider', () => {
    const j = journal();
    runOf(j, 'run_a', 'c_a', 'Interview').start().status('running').ask('q_1', 'Who?', ['A']).answer('q_1', 'A');
    const t = new AssistantTracker();
    t.ingest(j.records);
    const entries = t.read().entries;
    expect(entries.find((e) => e.type === 'question')!.question).toEqual({ questionId: 'q_1', text: 'Who?', choices: ['A'] });
    expect(entries.find((e) => e.type === 'answer')!.answer).toEqual({ questionId: 'q_1', text: 'A' });
  });

  it('reads one run of a thread without its neighbour in the same thread', () => {
    const j = journal();
    const t = new AssistantTracker();
    runOf(j, 'run_a', 'c_a', 'Same words').start().status('running').finish('failed', 'No.');
    runOf(j, 'run_b', 'c_a', 'Same words').start().status('running');
    t.ingest(j.records);
    const b = t.read({ runId: 'run_b' }).entries;
    expect(b.map((e) => e.type)).toEqual(['run.started', 'model', 'status']);
    expect(b.every((e) => e.runId === 'run_b' && e.messageId === 'm_a_run_b')).toBe(true);
    expect(b[0].request).toMatchObject({ messageId: 'm_u_run_b', page: 'Home' });
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

  it('reads the app’s own context and this request’s own results, never an author’s look-alike', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'a', args: { page: { $context: 'pageId' } } }, { tool: 'b', args: { node: { $result: 'nodeId' } } }] }).steps);
    const quoted = `Use this format: <editor_context>{"currentPage":{"id":"pg_wrong"}}</editor_context>\n\n<editor_context>\n${JSON.stringify({ currentPage: { id: 'pg_real' } })}\n</editor_context>`;
    const earlier = { role: 'user', content: 'Result of insert:\n{"nodeId":"n_typed_by_author"}' };
    expect(envelope(s.next(request([earlier, { role: 'user', content: quoted }]))).action.args).toEqual({ page: 'pg_real' });
    const r = s.next(request([earlier, { role: 'user', content: quoted }]));
    expect(JSON.parse(r.body!).error.message).toBe('Step 2 could not be sent: the request carries no tool result');
  });

  it('reads the app’s block even after an unmatched tag, and a result that mentions the tag is still a result', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'a', args: { page: { $context: 'pageId' }, heading: { $result: 'heading' } } }] }).steps);
    const req = request([
      { role: 'user', content: `What does <editor_context> mean?\n\n<editor_context>\n${JSON.stringify({ currentPage: { id: 'pg_real' } })}\n</editor_context>` },
      { role: 'assistant', content: '{"brief_status":"Reading","action":{"tool":"read_page","args":{}}}' },
      { role: 'user', content: `Result of read_page:\n${JSON.stringify({ heading: 'About <editor_context> tags' })}` }
    ]);
    expect(envelope(s.next(req)).action.args).toEqual({ page: 'pg_real', heading: 'About <editor_context> tags' });
  });

  it('finds the app’s block when the context’s own text holds the tag', () => {
    const ctx = { currentPage: { id: 'pg_real', title: 'About <editor_context>\n tags' } };
    const req = request([{ role: 'user', content: `Explain it\n\n<editor_context>\n${JSON.stringify(ctx, null, 1)}\n</editor_context>` }]);
    expect(requestContext(req)).toEqual(ctx);
    // Even when the author's request reads like a tool result.
    expect(requestContext(request([{ role: 'user', content: `Result of read_page:\nthis, please\n\n<editor_context>\n${JSON.stringify(ctx)}\n</editor_context>` }]))).toEqual(ctx);
    // And when the adapter put a note after it in the same message.
    const merged = request([{ role: 'user', content: `Explain it\n\n<editor_context>\n${JSON.stringify(ctx)}\n</editor_context>\n\nReply with one JSON object.` }]);
    expect(requestContext(merged)).toEqual(ctx);
  });

  it('takes the latest of several results, and refuses a path that names several values', () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'a', args: { node: { $result: 'nodeId' } } }, { tool: 'b', args: { node: { $result: 'nodeId' } } }, { tool: 'c', args: { node: { $result: 'results.1.nodeId' } } }] }).steps);
    const ctx = ctxMessage({ currentPage: { id: 'pg_1' } });
    const one = { role: 'user', content: 'Result of insert:\n{"nodeId":"n_first"}' };
    const two = { role: 'user', content: 'Result of insert:\n{"nodeId":"n_second"}' };
    expect(envelope(s.next(request([ctx, one, two]))).action.args).toEqual({ node: 'n_second' });
    const both = { role: 'user', content: `Result of apply_operations:\n${JSON.stringify({ results: [{ nodeId: 'n_1' }, { nodeId: 'n_2' }] })}` };
    expect(JSON.parse(s.next(request([ctx, both])).body!).error.message).toMatch(/2 different values at nodeId: name one by its full path/);
    expect(envelope(s.next(request([ctx, both]))).action.args).toEqual({ node: 'n_2' });
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
    // A name once used is never used again, so a release meant for the old gate can never open a new one.
    expect(() => s.add(parseScript({ steps: [{ tool: 'd', gate: 'g1' }] }).steps)).toThrow(/already used/);
  });

  it('lets every held reply go, and ends every delay, when the session closes', async () => {
    const s = new Script();
    s.add(parseScript({ steps: [{ tool: 'a', gate: 'g1' }, { tool: 'b', delayMs: 60000 }, { tool: 'c', gate: 'g2' }] }).steps);
    const held = s.next(request([]));
    const slow = s.next(request([]));
    const began = Date.now();
    s.close();
    await Promise.all([held.hold, slow.hold]);
    expect(Date.now() - began).toBeLessThan(1000);
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
    expect(parseScript({ scenario: 'widen', params: { question: 'More?', then: 'Done.' } }).steps.map((s: any) => s.tool)).toEqual(['request_wider_scope', 'finish']);
    // With a site name, the change only an allowed wider scope can make comes between the question and the finish.
    expect(parseScript({ scenario: 'widen', params: { question: 'More?', siteName: 'Harbour Light', then: 'Done.' } }).steps.map((s: any) => [s.tool, s.args])).toEqual([
      ['request_wider_scope', { question: 'More?' }],
      ['update_site_brand', { siteName: 'Harbour Light' }],
      ['finish', { message: 'Done.' }]
    ]);
    expect(() => parseScript({ scenario: 'widen', params: { question: 'More?', siteName: ' ', then: 'Done.' } })).toThrow(/"siteName" is text/);
    expect(() => parseScript({ scenario: 'widen', params: { question: 'More?', siteName: 7, then: 'Done.' } })).toThrow(/"siteName" is text/);
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
    expect(() => parseStep({ tool: 'finish', delayMs: 60001 }, 0)).toThrow(/delayMs/);
    expect(bad({ steps: Array.from({ length: 101 }, () => ({ tool: 'finish' })) })).toThrow(/1 to 100/);
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

describe('keeping credentials out', () => {
  it('replaces a known credential everywhere but in the app’s own IDs and the protocol’s words', () => {
    const secrets = ['run', 'sk-live-0123456789'];
    const scrub = (x: string) => x.replaceAll('sk-live-0123456789', '[redacted]').replaceAll('run', '[redacted]');
    const out = scrubAssistant(
      { runId: 'run_ab12cd34', status: 'running', state: 'working', type: 'run.started', request: { text: 'Please run it with sk-live-0123456789' }, composer: { scopeLabel: 'run sk-live-0123456789' }, runIdTyped: 'run' },
      secrets,
      scrub
    );
    expect(out).toEqual({ runId: 'run_ab12cd34', status: 'running', state: 'working', type: 'run.started', request: { text: 'Please [redacted] it with [redacted]' }, composer: { scopeLabel: '[redacted] [redacted]' }, runIdTyped: '[redacted]' });
    // An ID-shaped key holding something that is not an ID is scrubbed like any text.
    expect(scrubAssistant({ runId: 'sk-live-0123456789' }, secrets, scrub)).toEqual({ runId: '[redacted]' });
    // Asset IDs survive a short credential in them; a long one inside an ID-shaped value does not.
    const short = (x: string) => x.replaceAll('a_', '[r]');
    expect(scrubAssistant({ images: ['a_1x2y3z4w'], answer: { assetId: 'a_9q8w7e6r' }, text: 'a_ b' }, ['a_'], short)).toEqual({ images: ['a_1x2y3z4w'], answer: { assetId: 'a_9q8w7e6r' }, text: '[r] b' });
    const longKey = 'abcd1234efgh';
    expect(scrubAssistant({ id: `sk_${longKey}` }, [longKey], (x) => x.replaceAll(longKey, '[redacted]'))).toEqual({ id: 'sk_[redacted]' });
    // A protocol word stays itself even when a credential spells it; an ID that is a credential does not.
    const word = (x: string) => x.replaceAll('completed', '[r]');
    expect(scrubAssistant({ status: 'completed', state: 'terminal', note: 'completed' }, ['completed'], word)).toEqual({ status: 'completed', state: 'terminal', note: '[r]' });
    expect(scrubAssistant({ images: ['a_abcd'], assetId: 'a_abcd' }, ['a_abcd'], (x) => x.replaceAll('a_abcd', '[r]'))).toEqual({ images: ['[r]'], assetId: '[r]' });
  });
});

describe('the requests to observe and wait', () => {
  it('reads observe’s and wait’s arguments, and refuses anything else', () => {
    expect(parseObserveArgs(undefined)).toEqual({});
    expect(parseObserveArgs({ after: 3, limit: 10, runId: 'run_a', conversationId: 'c_a' })).toEqual({ after: 3, limit: 10, runId: 'run_a', conversationId: 'c_a' });
    expect(() => parseObserveArgs({ after: -1 })).toThrow(/cursor/);
    expect(() => parseObserveArgs({ limit: 0 })).toThrow(/1 to 1000/);
    expect(() => parseObserveArgs({ limit: 1001 })).toThrow(/1 to 1000/);
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
    expect(liveSetup(parseLive({ provider: 'anthropic', maxTurns: 5, timeoutMs: 900000 }), { [LIVE_OPT_IN]: '1', ANTHROPIC_API_KEY: KEY })).toEqual({ provider: 'anthropic', maxTurns: 5, timeoutMs: 900000, key: KEY });
    // Only an exact yes.
    for (const yes of ['true', 'yes', '01']) expect(() => liveSetup(live, { [LIVE_OPT_IN]: yes, OPENAI_API_KEY: KEY })).toThrow(expect.objectContaining({ details: { reason: 'not-opted-in' } }));
    // A local server needs no key, only its address.
    expect(liveSetup(parseLive({ provider: 'local', baseURL: 'http://127.0.0.1:1234/v1' }), { [LIVE_OPT_IN]: '1' })).toEqual({ provider: 'local', baseURL: 'http://127.0.0.1:1234/v1', maxTurns: 1, timeoutMs: 120000 });
  });

  it('is bounded, and says what it takes', () => {
    expect(() => parseLive({ provider: 'openai', key: KEY })).toThrow(/does not take "key"/);
    expect(() => parseLive({ provider: 'openai', maxTurns: 6 })).toThrow(/1 to 5/);
    expect(() => parseLive({ provider: 'openai', maxTurns: 0 })).toThrow(/1 to 5/);
    expect(() => parseLive({ provider: 'openai', timeoutMs: 999 })).toThrow(/1000/);
    for (const url of ['http://user:pass@127.0.0.1:1/v1', 'http://127.0.0.1:1/v1?token=abc', 'http://127.0.0.1:1/v1#k']) expect(() => parseLive({ provider: 'local', baseURL: url })).toThrow(/no credentials/);
    expect(() => parseLive({ provider: 'openai', timeoutMs: 900001 })).toThrow(/900000/);
    expect(() => parseLive({ provider: 'local' })).toThrow(/baseURL/);
    expect(() => parseLive({ provider: 'openai', baseURL: 'http://x' })).toThrow(/local server/);
    expect(() => parseLive({ provider: 'local', baseURL: 'file:///x' })).toThrow(/http/);
    expect(() => parseLive({ provider: 'gemini' })).toThrow(/openai/);
  });

  it('gives the app the provider and model, and nothing secret', () => {
    expect(liveSettings({ provider: 'openai', model: 'gpt-6.2-sol', maxTurns: 1, timeoutMs: 1000, key: KEY })).toEqual({ ai: { provider: 'openai', models: { openai: 'gpt-6.2-sol' } } });
    expect(liveSettings({ provider: 'local', baseURL: 'http://127.0.0.1:1/v1', maxTurns: 1, timeoutMs: 1000 })).toEqual({ ai: { provider: 'local', local: { baseURL: 'http://127.0.0.1:1/v1', allowRemote: false } } });
    expect(liveSettings({ provider: 'anthropic', model: 'claude-x', maxTurns: 1, timeoutMs: 1000, key: KEY })).toEqual({ ai: { provider: 'anthropic', models: { anthropic: 'claude-x' } } });
  });

  it('puts the key in a new file in the profile, readable only by this account', async () => {
    const profile = mkdtempSync(join(scratch, 'profile-'));
    await writeLiveKey(profile, { provider: 'openai', maxTurns: 1, timeoutMs: 1000, key: KEY });
    const file = join(profile, 'api-keys.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ openai: KEY });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(writeLiveKey(profile, { provider: 'openai', maxTurns: 1, timeoutMs: 1000, key: KEY })).rejects.toThrow(/EEXIST/);
    const other = mkdtempSync(join(scratch, 'profile-'));
    await writeLiveKey(other, { provider: 'anthropic', maxTurns: 1, timeoutMs: 1000, key: KEY });
    expect(JSON.parse(readFileSync(join(other, 'api-keys.json'), 'utf8'))).toEqual({ anthropic: KEY });
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
      for (const args of [{ provider: 'configured' }, { live: { provider: 'openai' } }, { provider: 'scripted', live: { provider: 'openai' } }, { provider: 'none', live: { provider: 'openai' } }]) {
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

    /** A started session whose app is stood in for: its journal and its chat panel, as the test sets them. */
    function stubbed(records: () => RawRecord[], chat: () => ShownChat | null, secrets: string[] = []) {
      const s = new Session({ appRoot });
      const x = s as any;
      x.state = 'ready';
      x.app = {};
      for (const k of secrets) x.secrets.add(k);
      x.pull = async () => s.assistant.ingest(records().filter((r) => r.seq > s.assistant.cursor));
      x.shownChat = async () => chat();
      return s;
    }
    const shownWith = (over: Partial<ShownChat>): ShownChat => ({ visible: true, conversationId: 'c_a', title: 't', messages: [], question: null, run: null, composer: null, notices: [], ...over });

    it('returns the question card only when it shows the run’s very question, never one the panel has not moved on from', async () => {
      const j = journal();
      runOf(j, 'run_a', 'c_a', 'Interview', { reply: 'm_a' }).start().status('running').ask('q_1', 'Who?', ['A']).answer('q_1', 'A').ask('q_2', 'Which tone?', ['Calm']);
      const stale = shownWith({ question: { runId: 'run_a', messageId: 'm_a', questionId: 'q_1', text: 'Who?', choices: ['A'], images: [] } });
      const s = stubbed(() => j.records, () => stale);
      const r = (await s.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_a' }, timeoutMs: 1500 })) as Reply;
      expect(r.ok).toBe(true);
      const res = (r as any).result;
      expect([res.reason, res.run.question.questionId, res.question]).toEqual(['input', 'q_2', undefined]);
      const fresh = stubbed(() => j.records, () => ({ ...stale, question: { ...stale.question!, questionId: 'q_2', text: 'Which tone?', choices: ['Calm'] } }));
      const r2 = (await fresh.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_a' }, timeoutMs: 1500 })) as any;
      expect(r2.result.question).toMatchObject({ questionId: 'q_2', choices: ['Calm'] });
    });

    it('ends with where the run stood when a read of the app is cut short by the end of the wait', async () => {
      const j = journal();
      runOf(j, 'run_a', 'c_a', 'Slow').start().status('running');
      const s = stubbed(() => j.records, () => null);
      const first = (s as any).pull;
      let reads = 0;
      (s as any).pull = async (deadline: number) => {
        if (++reads === 1) return first(deadline);
        throw new DriverError('TIMEOUT', 'reading the assistant’s events did not finish in time.', { details: { phase: 'reading the assistant’s events' } });
      };
      const r = (await s.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_a' }, timeoutMs: 2000 })) as any;
      expect(r.error).toMatchObject({ code: 'TIMEOUT', details: { phase: 'assistant.wait', runId: 'run_a', state: 'working', status: 'running' } });
    });

    it('passes its cursor on: a question asked before it does not end the wait', async () => {
      const j = journal();
      runOf(j, 'run_a', 'c_a', 'Ask me').start().status('running').ask('q_1', 'Who?', []);
      const s = stubbed(() => j.records, () => null);
      const now = (await s.call({ v: 1, id: 'w1', op: 'assistant.wait', args: { runId: 'run_a' }, timeoutMs: 1000 })) as any;
      expect(now.result.reason).toBe('input');
      const later = (await s.call({ v: 1, id: 'w2', op: 'assistant.wait', args: { runId: 'run_a', after: j.seq }, timeoutMs: 400 })) as any;
      expect(later.error).toMatchObject({ code: 'TIMEOUT', details: { state: 'input' } });
    });

    it('still polls in a short wait, and says where the run stood when it ends without it', async () => {
      const j = journal();
      const run = runOf(j, 'run_a', 'c_a', 'Ask me').start().status('running');
      setTimeout(() => run.ask('q_1', 'Who?', []), 100);
      const s = stubbed(() => j.records, () => null);
      const r = (await s.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_a' }, timeoutMs: 500 })) as any;
      expect([r.ok, r.result?.reason]).toEqual([true, 'input']);
      // Even a 100 ms wait looks more than once.
      const quick = journal();
      const soon = runOf(quick, 'run_q', 'c_a', 'Quick').start().status('running');
      setTimeout(() => soon.ask('q_1', 'Who?', []), 20);
      const q = stubbed(() => quick.records, () => null);
      const rq = (await q.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_q' }, timeoutMs: 100 })) as any;
      expect([rq.ok, rq.result?.reason]).toEqual([true, 'input']);
      const late = journal();
      runOf(late, 'run_b', 'c_a', 'Slow').start().status('running');
      const t = stubbed(() => late.records, () => null);
      const timed = (await t.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_b' }, timeoutMs: 400 })) as any;
      expect(timed.error).toMatchObject({ code: 'TIMEOUT', details: { runId: 'run_b', state: 'working', status: 'running', sessionState: 'ready' } });
      // The session goes on: the next request is answered.
      expect(((await t.call({ v: 1, id: 'o', op: 'assistant.observe', args: { runId: 'run_b' } })) as any).ok).toBe(true);
    });

    it('after a gap, ends a wait on the finished card the panel shows', async () => {
      let all: RawRecord[] = [{ seq: 1, at: 1, event: { runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_a', role: 'assistant', runId: 'run_a', text: '', activities: [] } } }];
      const done = shownWith({ messages: [{ messageId: 'm_a', role: 'assistant', runId: 'run_a', text: '', result: { status: 'completed', heading: 'Completed', summary: 'Done.', buttons: [] } }] });
      const s = stubbed(() => all, () => done);
      await s.call({ v: 1, id: 'o', op: 'assistant.observe' });
      // Everything after is dropped from the journal before it is read.
      all = [{ seq: 50, at: 50, event: { runId: 'run_z', conversationId: 'c_z', kind: 'status', status: 'running' } }];
      (s as any).pull = async () => s.assistant.ingest(all.filter((r) => r.seq > s.assistant.cursor), 48);
      const r = (await s.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: 'run_a' }, timeoutMs: 1500 })) as any;
      expect([r.ok, r.result?.reason, r.result?.run.gap, r.result?.run.state, r.result?.run.status, r.result?.run.result?.summary]).toEqual([true, 'terminal', true, 'terminal', 'completed', 'Done.']);
    });

    it('turns any failure it meets into one that quotes no credential', async () => {
      const SECRET = 'sk-known-session-secret-4567';
      const s = stubbed(() => [], () => null, [SECRET]);
      (s as any).pull = async () => {
        throw new Error(`page crashed while showing ${SECRET}`);
      };
      const r = (await s.call({ v: 1, id: 'o', op: 'assistant.observe' })) as any;
      expect(r.error.code).toBe('OP_FAILED');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    });

    it('keeps a credential it knows out of every assistant reply and failure, display text included', async () => {
      const SECRET = 'sk-known-session-secret-0123';
      const j = journal();
      runOf(j, 'run_a', 'c_a', `Use ${SECRET}`).start().status('running').text(`I saw ${SECRET}`);
      const chat = shownWith({ messages: [{ messageId: 'm_u', role: 'user', text: `Use ${SECRET}` }], composer: { present: true, answering: false, placeholder: null, value: SECRET, modeLabel: `Edit ${SECRET}`, scopeLabel: `What the AI may change: ${SECRET}`, images: [] } });
      const s = stubbed(() => j.records, () => chat, [SECRET]);
      const seen = (await s.call({ v: 1, id: 'o', op: 'assistant.observe' })) as any;
      expect(seen.ok).toBe(true);
      expect(JSON.stringify(seen)).not.toContain(SECRET);
      expect(seen.result.shown.composer.scopeLabel).toMatch(/^What the AI may change: /);
      const missing = (await s.call({ v: 1, id: 'w', op: 'assistant.wait', args: { runId: SECRET } })) as any;
      expect(missing.error.code).toBe('TARGET_NOT_FOUND');
      expect(JSON.stringify(missing)).not.toContain(SECRET);
    });

    it('has no script to set, being no scripted session', async () => {
      const s = new Session({ appRoot });
      const r = (await s.call({ v: 1, id: 'x', op: 'assistant.script', args: { scenario: 'answer', params: { text: 'Hi.' } } })) as Reply;
      expect(!r.ok && r.error.code).toBe('NOT_STARTED');
      expect(new DriverError('OP_FAILED', 'x').code).toBe('OP_FAILED');
    });
  });
});
