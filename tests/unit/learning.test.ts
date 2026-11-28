import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator, type RunDelegation } from '@agent/orchestrator';
import type { AdapterNote, AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { recordedAdapter, recordedStream, type ChatRecord } from '@agent/learning';
import { fixComponentSource } from '@agent/fixer';
import { ProjectSession } from '../../src/main/project/session';
import { LearningRecorder, PROJECT_MARKER, fileKey, parseLearningLabels, projectHolding, readLearningConfig } from '../../src/main/learning';
import { MANIFEST_FILE } from '../../src/main/project/documents';
import type { ChatRecorder } from '@agent/learning';

type Turn = (req: CanonicalModelRequest, signal: AbortSignal) => ModelEvent[] | Promise<ModelEvent[]>;

/** Replays scripted turns: no provider is reached. */
class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Turn[]) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 };
  }
  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    const events = turn ? await turn(req, signal) : [{ type: 'done' as const, stopReason: 'end' as const, text: 'Done.', toolCalls: [] }];
    for (const ev of events) {
      if (signal.aborted) {
        yield { type: 'error', code: 'cancelled', message: 'Canceled' };
        return;
      }
      yield ev;
    }
  }
}

const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } }];

const dirs: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const APP = { name: 'SiteOrigin Builder', version: '0.1.0', commit: 'a1b2c3d4e5' };

function recorder(dir: string, opts: { labels?: Record<string, string>; warn?: (m: string) => void; now?: () => Date } = {}) {
  return new LearningRecorder({ dir, labels: opts.labels ?? {}, app: APP, warn: opts.warn ?? (() => undefined), ...(opts.now ? { now: opts.now } : {}) });
}

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ChatRecord & { conversationId: string; time: string });
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort() : []);

async function setup(turns: Turn[], learning: ChatRecorder | null, project?: string, onEvent?: (e: AiEvent) => void) {
  const dir = project ?? scratch('so-learning-project');
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const adapter = new FakeAdapter(turns);
  const events: AiEvent[] = [];
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake-model', provider: 'openai' }),
    emit: (e) => {
      events.push(e);
      onEvent?.(e);
    },
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b),
    learning: () => learning
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  const settle = async () => {
    while (orch.busy || busy) await new Promise((res) => setTimeout(res, 10));
    await (learning as LearningRecorder | null)?.flush?.();
  };
  const run = async (text: string, extra: Partial<ChatContext> = {}, delegation?: RunDelegation) => {
    const r = await orch.send(text, { ...ctx, ...extra }, undefined, undefined, delegation);
    expect(r.ok).toBe(true);
    await settle();
    return r.runId!;
  };
  return { session, adapter, orch, run, settle, events, ctx };
}

describe('learning mode configuration (#1566)', () => {
  it('is off unless SITEORIGIN_LEARNING turns it on', () => {
    expect(readLearningConfig({}, '/data/learning')).toBeNull();
    expect(readLearningConfig({ SITEORIGIN_LEARNING: '0' }, '/data/learning')).toBeNull();
    expect(readLearningConfig({ SITEORIGIN_LEARNING: '' }, '/data/learning')).toBeNull();
    expect(readLearningConfig({ SITEORIGIN_LEARNING_DIR: '/elsewhere', SITEORIGIN_LEARNING_LABELS: 'a=b' }, '/data/learning')).toBeNull();
    expect(readLearningConfig({ SITEORIGIN_LEARNING: '1' }, '/data/learning')).toEqual({ dir: '/data/learning', labels: {}, problems: [] });
    expect(readLearningConfig({ SITEORIGIN_LEARNING: 'true', SITEORIGIN_LEARNING_DIR: '/elsewhere/rec' }, '/data/learning')?.dir).toBe('/elsewhere/rec');
  });

  it('reads labels as key=value pairs and reports what it cannot read', () => {
    const { labels, problems } = parseLearningLabels(' experiment = sol-baseline, prompt=v3,source=manual,,broken, =x, url=a=b, prompt=v4, __proto__=p');
    expect(Object.entries(labels)).toEqual([
      ['experiment', 'sol-baseline'],
      ['prompt', 'v4'],
      ['source', 'manual'],
      ['url', 'a=b'],
      ['__proto__', 'p']
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('"broken"');
    expect(problems[1]).toContain('"=x"');
    expect(problems[2]).toContain('"prompt" is given more than once');
    const config = readLearningConfig({ SITEORIGIN_LEARNING: '1', SITEORIGIN_LEARNING_LABELS: 'ok=1,nope' }, '/d');
    expect({ ...config!.labels }).toEqual({ ok: '1' });
    expect(config!.problems).toEqual(['SITEORIGIN_LEARNING_LABELS: "nope" is not a key=value pair, so it was left out.']);
  });

  it('names files after the conversation, telling apart IDs that would not be file names', () => {
    expect(fileKey('c_k3j9x2ab')).toBe('c_k3j9x2ab');
    expect(fileKey('../x')).not.toBe(fileKey('/.x'));
    expect(fileKey('../x')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('learning mode recording a chat (#1566)', () => {
  it('writes nothing, and makes no folder, while it is off', async () => {
    const root = scratch('so-learning-off');
    const dir = join(root, 'learning');
    const config = readLearningConfig({}, dir);
    const env = await setup([() => finish('Hello.')], config ? recorder(config.dir) : null);
    await env.run('Say hello');
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('records every step of a chat that calls tools in one timestamped file, in order, with the labels', async () => {
    const dir = join(scratch('so-learning'), 'nested', 'learning');
    const learning = recorder(dir, { labels: { experiment: 'sol-baseline', prompt: 'v3' }, now: () => new Date('2026-11-28T10:15:30.123Z') });
    const env = await setup([() => [call('c1', 'read_project', {})], () => finish('Read it.')], learning);
    const runId = await env.run('What pages are there?');
    const conversationId = env.orch.conversation!.id;
    expect(files(dir)).toEqual([`20261128T101530123Z-${conversationId}.jsonl`]);
    const records = lines(join(dir, files(dir)[0]));
    expect(records.map((r) => r.type)).toEqual(['header', 'user', 'request', 'response', 'tool_result', 'request', 'response', 'outcome']);
    expect(records.every((r) => r.conversationId === conversationId)).toBe(true);
    expect(records.slice(1).every((r) => r.runId === runId)).toBe(true);
    const [header, user, first, firstReply, result, second, secondReply, outcome] = records as Array<Record<string, any>>;
    expect(header).toMatchObject({ type: 'header', continued: false, labels: { experiment: 'sol-baseline', prompt: 'v3' }, app: APP, time: '2026-11-28T10:15:30.123Z' });
    expect(user.message).toMatchObject({ role: 'user', text: 'What pages are there?' });
    expect(user.project).toBe(env.session.dir);
    // Each request exactly as the adapter received it, items as they were when it was sent.
    expect(first).toMatchObject({ call: 'turn', provider: 'openai', model: 'fake-model', requestIndex: 1, step: 1, attempt: 0 });
    expect(first.request).toEqual(JSON.parse(JSON.stringify(env.adapter.requests[0])));
    expect(second.request).toEqual(JSON.parse(JSON.stringify(env.adapter.requests[1])));
    expect(second).toMatchObject({ requestIndex: 2, step: 2, attempt: 0 });
    expect(first.request.items[0]).toMatchObject({ kind: 'user' });
    expect(first.request.system).toBeTruthy();
    expect(first.request.tools.length).toBeGreaterThan(0);
    expect(first.request.maxOutputTokens).toBeGreaterThan(0);
    expect(firstReply.reply).toMatchObject({ stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'read_project' }] });
    expect(result).toMatchObject({ call: { id: 'c1', name: 'read_project' }, ok: true, item: { kind: 'tool_result', callId: 'c1', name: 'read_project' } });
    expect(second.request.items.at(-1)).toEqual(result.item);
    expect(secondReply.reply).toMatchObject({ stopReason: 'end', text: 'Read it.', usage: { inputTokens: 10, outputTokens: 2 } });
    expect(outcome).toMatchObject({ status: 'no-changes', message: { role: 'assistant', text: 'Read it.', result: { status: 'no-changes' } } });
  });

  it('records the edits a change applied with its result', async () => {
    const dir = scratch('so-learning');
    const learning = recorder(dir);
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup(
      [
        () => {
          const home = env.session.state.pages[env.session.state.site.homePageId];
          const hero = Object.values(home.nodes).find((n) => n.kind === 'instance' && typeof (n as { props: Record<string, unknown> }).props.heading === 'string')!;
          return [call('c1', 'apply_operations', { expectedRevision: env.session.revision, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: home.id }, nodeId: hero.id, prop: 'heading', value: 'Learned' }] })];
        },
        () => finish('Changed the heading.')
      ],
      learning
    );
    await env.run('Change the heading');
    const records = lines(join(dir, files(dir)[0])) as Array<Record<string, any>>;
    const result = records.find((r) => r.type === 'tool_result');
    expect(result).toMatchObject({ ok: true, mutated: true, ops: [{ type: 'instance.setProp', prop: 'heading', value: 'Learned' }] });
    expect(result.results).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ type: 'outcome', status: 'completed' });
  });

  it('gives a second conversation a second file, and appends to the first when it is continued, in this launch or the next', async () => {
    const dir = scratch('so-learning');
    let clock = Date.parse('2026-11-28T10:00:00.000Z');
    const now = () => new Date((clock += 1000));
    const project = scratch('so-learning-project');
    const env = await setup([], recorder(dir, { now }), project);
    await env.run('First');
    const first = env.orch.conversation!.id;
    await env.orch.newConversation();
    await env.run('Second');
    const second = env.orch.conversation!.id;
    expect(second).not.toBe(first);
    expect(files(dir)).toHaveLength(2);
    await env.orch.openConversation(first);
    await env.run('First again');
    expect(files(dir)).toHaveLength(2);
    const [a, b] = files(dir);
    expect(a.endsWith(`-${first}.jsonl`)).toBe(true);
    expect(b.endsWith(`-${second}.jsonl`)).toBe(true);
    expect(lines(join(dir, a)).filter((r) => r.type === 'user').map((r) => (r.message as { text: string }).text)).toEqual(['First', 'First again']);
    await env.orch.close();

    // The app quit and opened again: a new recorder finds the conversation's file and adds to it.
    const again = await setup([], recorder(dir, { now, labels: { prompt: 'v4' } }), project);
    await again.orch.openConversation(first);
    await again.run('After a restart');
    expect(files(dir)).toEqual([a, b]);
    const records = lines(join(dir, a));
    expect(records.filter((r) => r.type === 'header').map((r) => [r.continued, r.labels])).toEqual([
      [false, {}],
      [true, { prompt: 'v4' }]
    ]);
    expect(records.at(-1)).toMatchObject({ type: 'outcome', conversationId: first });
    // Earlier lines are kept as they were.
    expect(records.filter((r) => r.type === 'user')).toHaveLength(3);
  });

  it('logs a folder it cannot write to once, and the chat carries on', async () => {
    const root = scratch('so-learning');
    // A file where the folder would go: nothing can be made inside it.
    writeFileSync(join(root, 'blocked'), 'not a folder');
    const warnings: string[] = [];
    const env = await setup([() => [call('c1', 'read_project', {})], () => finish('First.'), () => finish('Second.')], recorder(join(root, 'blocked', 'learning'), { warn: (m) => warnings.push(m) }));
    await env.run('One');
    await env.run('Two');
    const results = env.events.filter((e) => e.kind === 'message' && e.message?.result).map((e) => e.message!.result!.status);
    expect(results).toEqual(['no-changes', 'no-changes']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Learning mode could not write');
    expect(readFileSync(join(root, 'blocked'), 'utf8')).toBe('not a folder');
  });

  it('never writes an API key into a file', async () => {
    const dir = scratch('so-learning');
    const env = await setup([() => [{ type: 'error', code: 'invalid_request', message: 'Bad key sk-proj-abcdefghijklmnop1234' }]], recorder(dir));
    await env.run('My key is sk-ant-api03-ABCDEFGHIJKLMNOP and that is fine');
    const raw = readFileSync(join(dir, files(dir)[0]), 'utf8');
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(raw).toContain('sk-…');
    expect(lines(join(dir, files(dir)[0])).find((r) => r.type === 'response')).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('records a stop, what the model had sent before it, and the cancelled outcome', async () => {
    const dir = scratch('so-learning');
    let env!: Awaited<ReturnType<typeof setup>>;
    // Stopped as the first piece of the reply arrives: the adapter answers the rest with a cancellation.
    env = await setup(
      [() => [{ type: 'text', delta: 'Half' }, { type: 'text', delta: ' more' }, { type: 'done', stopReason: 'end', text: 'Half more', toolCalls: [] }]],
      recorder(dir),
      undefined,
      (e) => e.kind === 'text' && env.orch.stop()
    );
    await env.run('Do something long');
    const records = lines(join(dir, files(dir)[0])) as Array<Record<string, any>>;
    expect(records.map((r) => r.type)).toEqual(['header', 'user', 'request', 'stop', 'response', 'outcome']);
    expect(records[4]).toMatchObject({ error: { code: 'cancelled' }, partial: { text: 'Half', toolCalls: [] } });
    expect(records[5]).toMatchObject({ status: 'cancelled' });
  });

  it('records a question, and a stop while it waits as a stop rather than an answer', async () => {
    const dir = scratch('so-learning');
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup([() => [call('q1', 'request_clarification', { question: 'Which colour?', choices: ['Red', 'Blue'] })]], recorder(dir), undefined, (e) => e.kind === 'status' && e.status === 'awaiting-input' && env.orch.stop());
    await env.run('Make it pop');
    const records = lines(join(dir, files(dir)[0])) as Array<Record<string, any>>;
    expect(records.map((r) => r.type)).toEqual(['header', 'user', 'request', 'response', 'question', 'stop', 'outcome']);
    expect(records[4]).toMatchObject({ question: { text: 'Which colour?', choices: ['Red', 'Blue'] } });
  });

  it('records the answer to a question', async () => {
    const dir = scratch('so-learning');
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup([() => [call('q1', 'request_clarification', { question: 'Which colour?', choices: ['Red', 'Blue'] })], () => finish('Blue it is.')], recorder(dir), undefined, (e) => {
      if (e.kind === 'status' && e.status === 'awaiting-input') {
        // The turn with its question is sent just after the status.
        setTimeout(() => {
          const q = [...env.events].reverse().find((x) => x.kind === 'message' && x.message?.questions?.length)!.message!.questions!.at(-1)!;
          expect(env.orch.answer(e.runId, q.id, 'Blue')).toBe(true);
        });
      }
    });
    await env.run('Make it pop');
    const records = lines(join(dir, files(dir)[0])) as Array<Record<string, any>>;
    expect(records.map((r) => r.type)).toEqual(['header', 'user', 'request', 'response', 'question', 'answer', 'tool_result', 'request', 'response', 'outcome']);
    expect(records[5]).toMatchObject({ questionId: records[4].question.id, answer: 'Blue' });
  });

  it('never lets a recorder that throws reach the chat', async () => {
    const throwing: ChatRecorder = {
      record: () => {
        throw new Error('broken recorder');
      }
    };
    const env = await setup([() => [call('c1', 'read_project', {})], () => finish('Fine.')], throwing);
    await env.run('Hello');
    expect(env.events.find((e) => e.kind === 'message' && e.message?.result)?.message?.result?.status).toBe('no-changes');
    env.orch.stop();
  });

  it("marks a live session guest's turns as the guest's", async () => {
    const dir = scratch('so-learning');
    const env = await setup([() => [call('c1', 'read_page', { pageId: 'home' })], () => finish('Done for the guest.')], recorder(dir));
    const delegation: RunDelegation = { guestName: 'Sam', grantId: 'g_1', accept: () => null, check: () => null };
    await env.run('Change the page', { mode: 'edit', scope: 'page' }, delegation);
    const records = lines(join(dir, files(dir)[0]));
    expect(records.some((r) => r.type === 'tool_result')).toBe(true);
    expect(records.filter((r) => r.type !== 'header').every((r) => (r.guest as { name: string })?.name === 'Sam' && (r.guest as { id: string }).id === 'g_1')).toBe(true);
  });

  it('never writes to a folder inside a project, whichever project the chat or fix is in', async () => {
    expect(PROJECT_MARKER).toBe(MANIFEST_FILE);
    const other = scratch('so-learning-other');
    writeFileSync(join(other, PROJECT_MARKER), '{}');
    for (const dir of [join(other, '.siteorigin', 'learning'), join(other, '..learning'), join(other, 'static', 'learning')]) {
      const warnings: string[] = [];
      const learning = recorder(dir, { warn: (m) => warnings.push(m) });
      const env = await setup([() => finish('Hi.')], learning);
      await env.run('Hello');
      // A code fix, which names no project, is held to the same.
      learning.record('fix_1', { type: 'fix', call: 'fixer' });
      await learning.flush();
      expect(existsSync(dir)).toBe(false);
      expect(warnings).toEqual([expect.stringContaining(`inside the project ${projectHolding(other)}`)]);
    }
    expect(projectHolding(`${other}-sibling`)).toBeNull();
    // The project a chat is in holds its folder like any other.
    const project = scratch('so-learning-project');
    const inside = join(project, 'learning');
    const warnings: string[] = [];
    const env = await setup([() => finish('Hi.')], recorder(inside, { warn: (m) => warnings.push(m) }), project);
    await env.run('Hello');
    expect(existsSync(inside)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('starts a new line after a line an earlier write left unfinished', async () => {
    const dir = scratch('so-learning');
    writeFileSync(join(dir, '20261101T000000000Z-c_torn.jsonl'), '{"type":"header","conversationId":"c_torn"}\n{"type":"user","conv');
    const learning = recorder(dir);
    learning.record('c_torn', { type: 'user', text: 'again' });
    await learning.flush();
    const text = readFileSync(join(dir, '20261101T000000000Z-c_torn.jsonl'), 'utf8').split('\n');
    expect(text[1]).toBe('{"type":"user","conv');
    expect(JSON.parse(text[2])).toMatchObject({ type: 'header', continued: true });
    expect(JSON.parse(text[3])).toMatchObject({ type: 'user', text: 'again' });
  });

  it('finds a run by its own records, not a label that names it, and keeps its place among later steps', async () => {
    const dir = scratch('so-learning');
    writeFileSync(join(dir, '20261101T000000000Z-c_a.jsonl'), `${JSON.stringify({ type: 'user', runId: 'run_r', conversationId: 'c_a' })}\n`);
    writeFileSync(join(dir, '20261102T000000000Z-c_b.jsonl'), `${JSON.stringify({ type: 'header', labels: { runId: 'run_r' }, conversationId: 'c_b' })}\n`);
    const learning = recorder(dir);
    learning.recordRun('run_r', { type: 'undo', via: 'history' });
    learning.record('c_a', { type: 'user', runId: 'run_s' });
    await learning.flush();
    expect(lines(join(dir, '20261101T000000000Z-c_a.jsonl')).map((r) => r.type)).toEqual(['user', 'header', 'undo', 'user']);
    expect(lines(join(dir, '20261102T000000000Z-c_b.jsonl')).map((r) => r.type)).toEqual(['header']);
  });

  it("files an undo under the run's conversation, found in the folder after a restart", async () => {
    const dir = scratch('so-learning');
    const env = await setup([() => finish('Hi.')], recorder(dir));
    const runId = await env.run('Hello');
    const later = recorder(dir);
    later.recordRun(runId, { type: 'undo', via: 'history' });
    later.recordRun('run_unknown', { type: 'undo', via: 'history' });
    await later.flush();
    expect(files(dir)).toHaveLength(1);
    const records = lines(join(dir, files(dir)[0]));
    expect(records.slice(-2)).toMatchObject([
      { type: 'header', continued: true },
      { type: 'undo', runId, via: 'history', conversationId: env.orch.conversation!.id }
    ]);
  });
});

describe('learning mode recording model calls outside a chat turn (#1566)', () => {
  it("marks the code fixer's calls, each attempt, in a file of its own", async () => {
    const dir = scratch('so-learning');
    const learning = recorder(dir);
    const adapter = new FakeAdapter([() => finish('Fixed it.\n```svelte\n<p>ok</p>\n```')]);
    const learn = (r: ChatRecord) => learning.record('fix_abc', r);
    const result = await fixComponentSource(recordedAdapter(adapter, learn, { call: 'fixer', provider: 'anthropic' }), 'fake-model', '<p>broken', async (src) => (src.includes('broken') ? [{ severity: 'error', message: 'Broken' }] : []), new AbortController().signal);
    expect(result.ok).toBe(true);
    await learning.flush();
    expect(files(dir)).toEqual([expect.stringMatching(/-fix_abc\.jsonl$/)]);
    const records = lines(join(dir, files(dir)[0]));
    expect(records.map((r) => [r.type, r.call])).toEqual([
      ['header', undefined],
      ['request', 'fixer'],
      ['response', 'fixer']
    ]);
    expect(records[1]).toMatchObject({ provider: 'anthropic', attempt: 0, request: { once: true, tools: [] } });
  });

  it('records what had arrived when a stream ends without an answer', async () => {
    const got: ChatRecord[] = [];
    const request: CanonicalModelRequest = { model: 'm', system: 'S', items: [], tools: [], maxOutputTokens: 100 };
    async function* open(): AsyncIterable<ModelEvent> {
      yield { type: 'text', delta: 'Part' };
      yield { type: 'tool_call', call: { id: 'c1', name: 'read_project', arguments: '{}' } };
      yield { type: 'text', delta: ' way' };
      yield { type: 'done', stopReason: 'end', text: 'Part way', toolCalls: [] };
    }
    // The caller stops reading part way, as a run does at its time limit.
    for await (const ev of recordedStream((r) => got.push(r), { call: 'turn', provider: 'openai', step: 2, attempt: 1 }, request, open)) if (ev.type === 'text' && ev.delta === ' way') break;
    expect(got.map((r) => r.type)).toEqual(['request', 'response']);
    expect(got[1]).toMatchObject({ ended: 'without an answer', step: 2, attempt: 1, partial: { text: 'Part way', toolCalls: [{ id: 'c1' }] } });
  });

  it('keeps what had arrived before an error', async () => {
    const got: ChatRecord[] = [];
    const request: CanonicalModelRequest = { model: 'm', system: 'S', items: [], tools: [], maxOutputTokens: 100 };
    async function* open(): AsyncIterable<ModelEvent> {
      yield { type: 'text', delta: 'Before' };
      yield { type: 'error', code: 'network', message: 'Could not reach the provider.' };
    }
    for await (const _ of recordedStream((r) => got.push(r), { call: 'turn', provider: 'openai' }, request, open)) void _;
    expect(got[1]).toMatchObject({ type: 'response', error: { code: 'network' }, partial: { text: 'Before' } });
  });

  it('records each time an adapter sends a request again, changed, with the reply it could not use', async () => {
    const got: ChatRecord[] = [];
    const request: CanonicalModelRequest = { model: 'local-model', system: 'S', items: [{ kind: 'user', text: 'Hi' }], tools: [], maxOutputTokens: 100 };
    async function* open(note: (n: AdapterNote) => void): AsyncIterable<ModelEvent> {
      note({ kind: 'resend', reason: 'correction', problem: 'not JSON', reply: '{oops' });
      yield { type: 'done', stopReason: 'end', text: 'OK', toolCalls: [] };
    }
    const seen: ModelEvent[] = [];
    for await (const ev of recordedStream((r) => got.push(r), { call: 'turn', provider: 'local', step: 1, attempt: 0 }, request, open)) seen.push(ev);
    expect(seen).toEqual([{ type: 'done', stopReason: 'end', text: 'OK', toolCalls: [] }]);
    expect(got.map((r) => r.type)).toEqual(['request', 'resend', 'response']);
    expect(got[1]).toMatchObject({ reason: 'correction', reply: '{oops', provider: 'local', step: 1 });
  });
});
