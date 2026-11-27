/**
 * A live-session collaborator's request to the host's AI (#769), below the relay: the host's assistant runs it as a
 * delegated run (agent/orchestrator.ts RunDelegation) against a real project session, with a scripted model, and the
 * request's progress is made safe to share before it goes back to the guest (shared/live/ai.ts). A delegated run is
 * held to what the collaborator could do by hand, hears none of the host's own conversation or brief, and lands as a
 * History step naming the guest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext, ChatMessage } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { guestRunLabel, Orchestrator, type RunDelegation } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import type { InstanceNode } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { liveAiTurn, readAiAccess, readAiTurnEvent, LIVE_AI_REPLY_MAX, LIVE_AI_SETUP_PROBLEM } from '@shared/live/ai';
import { hostPathTail } from '@shared/live/snapshot';
import type { SourceToolHost } from '@agent/source-tools';

type Turn = (req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>;

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Turn[]) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
      return;
    }
    for (const ev of await turn(req)) {
      if (signal.aborted) {
        yield { type: 'error', code: 'cancelled', message: 'Canceled' };
        return;
      }
      yield ev;
    }
  }
}

const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [] }];
const lastResult = (req: CanonicalModelRequest) => JSON.parse((req.items.at(-1) as { content: string }).content) as { ok?: boolean; error?: { code: string; message: string } };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup(turns: Turn[], sources?: () => SourceToolHost) {
  const dir = mkdtempSync(join(tmpdir(), 'so-live-ai-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  // The author's own brief, which guests are never given (shared/live/snapshot.ts).
  session.state = { ...session.state, brief: { schemaVersion: 1, description: 'BRIEF-DESCRIPTION', notes: 'BRIEF-NOTES' } };
  const adapter = new FakeAdapter(turns);
  const events: AiEvent[] = [];
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => events.push(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b),
    // The host has Developer mode on: a guest's request still never gets code.
    codeEnabled: async () => true,
    ...(sources ? { sources } : {})
  });
  const home = session.state.pages[session.state.site.homePageId];
  const ctx: ChatContext = { pageId: home.id, pageTitle: home.title, selection: null, selectionLabel: null, viewport: 1280, mode: 'edit', scope: 'page' };
  const settled = async () => {
    while (orch.busy || busy) await new Promise((res) => setTimeout(res, 10));
  };
  const delegation = (over: Partial<RunDelegation> = {}): RunDelegation & { accepted: string[] } => {
    const accepted: string[] = [];
    return { guestName: 'Ann', grantId: 'grant-1', accept: (runId) => (accepted.push(runId), null), check: () => null, ...over, accepted };
  };
  const hero = () => Object.values(session.state.pages[session.state.site.homePageId].nodes).find((n): n is InstanceNode => n.kind === 'instance' && typeof n.props.heading === 'string')!;
  return { session, adapter, orch, events, ctx, settled, delegation, home, hero };
}

describe('a collaborator’s request to the host’s AI', () => {
  it('edits the page as the guest asked, and lands as one History step naming the guest', async () => {
    const env = await setup([
      () => [call('c1', 'apply_operations', { expectedRevision: env.session.revision, scope: { kind: 'page', targetIds: [env.home.id] }, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: env.home.id }, nodeId: env.hero().id, prop: 'heading', value: 'Bigger and better' }] })],
      (req) => {
        expect(lastResult(req).ok).toBe(true);
        return finish('Changed the heading.');
      }
    ]);
    const d = env.delegation();
    const sent = await env.orch.send('Change the heading', env.ctx, undefined, undefined, d);
    expect(sent).toMatchObject({ ok: true });
    expect(d.accepted).toEqual([sent.runId]);
    await env.settled();
    expect(env.hero().props.heading).toBe('Bigger and better');
    const entry = env.session.historyInfo().entries.at(-1)!;
    expect(entry).toMatchObject({ source: 'ai', guestName: 'Ann', runId: sent.runId });
    expect(entry.label).toMatch(/^AI for Ann: /);
    // Both of its messages say whose turn it is, in the host's conversation.
    expect(env.orch.conversation!.messages.slice(-2).map((m) => m.guest)).toEqual([
      { name: 'Ann', id: 'grant-1' },
      { name: 'Ann', id: 'grant-1' }
    ]);
    // The host can take it back as any AI step.
    expect(await env.orch.undoTurn(sent.runId!)).toEqual({ ok: true });
    expect(env.hero().props.heading).not.toBe('Bigger and better');
  });

  it('never offers code, the project brief, the external sources or the host’s own conversation, whatever the host’s Developer mode', async () => {
    let reached = 0;
    const env = await setup([() => finish('Noted.'), () => finish('Done.')], () => (reached++, {}) as SourceToolHost);
    // The host's own request first, in the same conversation.
    const own = await env.orch.send('HOST-SECRET-REQUEST', { ...env.ctx, scope: undefined });
    expect(own.ok).toBe(true);
    await env.settled();
    const hostRequest = JSON.stringify(env.adapter.requests[0]);
    expect(hostRequest).toContain('BRIEF-NOTES');
    expect(reached).toBe(1);
    const sent = await env.orch.send('Tidy the page', env.ctx, undefined, undefined, env.delegation());
    expect(sent.ok).toBe(true);
    await env.settled();
    const guestRequest = env.adapter.requests[1];
    const text = JSON.stringify(guestRequest);
    expect(text).toContain('Tidy the page');
    expect(text).not.toContain('HOST-SECRET-REQUEST');
    expect(text).not.toContain('BRIEF-NOTES');
    expect(text).not.toContain('BRIEF-DESCRIPTION');
    expect(reached).toBe(1);
    const tools = guestRequest.tools.map((t) => t.name);
    expect(tools).not.toContain('read_source');
    expect(tools).not.toContain('apply_source_patch');
    // A later request of the same guest hears its own earlier turn, and still nothing of the host's.
    const again = await setup([() => finish('One.'), () => finish('Two.'), () => finish('Three.')]);
    await again.orch.send('GUEST-FIRST', again.ctx, undefined, undefined, again.delegation());
    await again.settled();
    await again.orch.send('HOST-BETWEEN', { ...again.ctx, scope: undefined });
    await again.settled();
    await again.orch.send('GUEST-SECOND', again.ctx, undefined, undefined, again.delegation());
    await again.settled();
    const second = JSON.stringify(again.adapter.requests[2]);
    expect(second).toContain('GUEST-FIRST');
    expect(second).not.toContain('HOST-BETWEEN');
    // Nor is a guest's request ever replayed to the author's own run, as if the author had asked it.
    expect(JSON.stringify(again.adapter.requests[1])).not.toContain('GUEST-FIRST');
    // Another admission of the guest (a new grant) hears neither.
    await again.orch.send('OTHER-ADMISSION', again.ctx, undefined, undefined, again.delegation({ grantId: 'grant-2' }));
    await again.settled();
    expect(JSON.stringify(again.adapter.requests[3])).not.toContain('GUEST-FIRST');
  });

  it('refuses any batch a collaborator could not make by hand, and anything once its access has gone', async () => {
    let allowed = true;
    const env = await setup([
      // A page setting only the host decides: whether search engines index it.
      () => [call('c1', 'apply_operations', { expectedRevision: env.session.revision, scope: { kind: 'page', targetIds: [env.home.id] }, operations: [{ type: 'page.update', pageId: env.home.id, noindex: true }] })],
      (req) => {
        expect(lastResult(req)).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
        expect(lastResult(req).error!.message).toContain('guest');
        allowed = false;
        return [call('c2', 'apply_operations', { expectedRevision: env.session.revision, scope: { kind: 'page', targetIds: [env.home.id] }, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: env.home.id }, nodeId: env.hero().id, prop: 'heading', value: 'Too late' }] })];
      },
      (req) => {
        expect(lastResult(req)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
        return finish('Could not.');
      }
    ]);
    const before = env.session.state;
    await env.orch.send('Hide the page from search and rename it', env.ctx, undefined, undefined, env.delegation({ check: () => (allowed ? null : 'The host changed your access to its AI.') }));
    await env.settled();
    expect(env.adapter.requests).toHaveLength(3);
    expect(env.session.state.pages[env.home.id].seo.noindex).toBe(before.pages[env.home.id].seo.noindex);
    expect(env.hero().props.heading).toBe((before.pages[env.home.id].nodes[env.hero().id] as InstanceNode).props.heading);
  });

  it('adds nothing to the conversation and asks no model when the host refuses it at the last moment', async () => {
    const env = await setup([() => finish('Should not run.')]);
    await env.orch.loadConversations();
    const before = env.orch.conversation!.messages.length;
    const refused = await env.orch.send('Change the heading', env.ctx, undefined, undefined, env.delegation({ accept: () => 'The host changed your access to its AI.' }));
    expect(refused).toEqual({ ok: false, message: 'The host changed your access to its AI.' });
    expect(env.orch.conversation!.messages).toHaveLength(before);
    expect(env.adapter.requests).toEqual([]);
    expect(env.orch.busy).toBe(false);
  });

  it('refuses a request that is not an edit of the page or selection, or names a model', async () => {
    const env = await setup([]);
    const d = env.delegation();
    for (const [ctx, recipient] of [
      [{ ...env.ctx, mode: 'ask' as const, scope: undefined }, undefined],
      [{ ...env.ctx, scope: 'site' as const }, undefined],
      [{ ...env.ctx, assetIds: ['a1'] }, undefined],
      [{ ...env.ctx, task: 'component' as const }, undefined],
      [env.ctx, { provider: 'openai', model: 'gpt-x' }]
    ] as const) {
      expect(await env.orch.send('Hi', ctx as ChatContext, undefined, recipient, d)).toMatchObject({ ok: false });
    }
    expect(d.accepted).toEqual([]);
    expect(env.adapter.requests).toEqual([]);
  });

  it('names the guest on the run’s History label', () => {
    expect(guestRunLabel('AI: Changed the heading.', 'Ann')).toBe('AI for Ann: Changed the heading.');
    expect(guestRunLabel('AI (partial): Make pages', 'Ann')).toBe('AI for Ann (partial): Make pages');
    expect(guestRunLabel('AIM: test', 'Ann')).toBe('AIM: test');
  });

  it('keeps nothing of a run its guest lost access to as it finished, and can still roll it back', async () => {
    const env = await setup([]);
    expect(await env.session.beginRun('run_late')).toBeNull();
    const title = env.session.state.pages[env.home.id].title;
    expect((await env.session.apply({ operations: [{ type: 'page.update', pageId: env.home.id, title: 'Late' }] }, { label: 'AI', source: 'ai', runId: 'run_late', history: false })).ok).toBe(true);
    const steps = env.session.historyInfo().entries.length;
    await expect(env.session.completeRun('AI for Ann: Late', 'Ann', () => false)).rejects.toThrow('Canceled');
    expect(env.session.historyInfo().entries).toHaveLength(steps);
    expect(await env.session.abortRun()).toMatchObject({ restored: true });
    expect(env.session.state.pages[env.home.id].title).toBe(title);
    // Lost at the very moment it is decided (its journal ready to take its place): the same.
    expect(await env.session.beginRun('run_later')).toBeNull();
    expect((await env.session.apply({ operations: [{ type: 'page.update', pageId: env.home.id, title: 'Later' }] }, { label: 'AI', source: 'ai', runId: 'run_later', history: false })).ok).toBe(true);
    let asked = 0;
    await expect(env.session.completeRun('AI for Ann: Later', 'Ann', () => ++asked === 1)).rejects.toThrow('Canceled');
    expect(asked).toBe(2);
    expect(env.session.historyInfo().entries).toHaveLength(steps);
    expect(await env.session.abortRun()).toMatchObject({ restored: true });
    expect(env.session.state.pages[env.home.id].title).toBe(title);
  });
});

describe('a host path part way written', () => {
  it('is held back from text that streams, in any case and with either slash', () => {
    const paths = ['/Users/host/site', 'C:\\Users\\Host'];
    expect(hostPathTail('Saved in /Users/ho', paths)).toBe('/Users/ho'.length);
    expect(hostPathTail('Saved in /USERS/HOST/SI', paths)).toBe('/USERS/HOST/SI'.length);
    expect(hostPathTail('Saved in C:/Users/H', paths)).toBe('C:/Users/H'.length);
    expect(hostPathTail('Saved in ', paths)).toBe(0);
    expect(hostPathTail('Saved in /', paths, 4)).toBe(0);
  });
});

describe('a collaborator’s turn as it is sent', () => {
  const scrub = (t: string) => t.replaceAll('/Users/host', '…');
  const assistant: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    runId: 'run-1',
    time: '',
    text: 'Reading /Users/host/site',
    model: { provider: 'openai', model: 'gpt-secret' } as never,
    activities: [{ id: 'x', label: 'Checked /Users/host/site/pages', status: 'done', tool: 'validate_project', detail: 'raw diagnostics' }],
    questions: [{ id: 'q1', text: 'Which one?', choices: ['A', 'B'] }]
  };

  it('carries the request, the reply and its steps in plain words, and nothing technical or of the host’s computer', () => {
    const turn = liveAiTurn('Make it bigger', assistant, 'awaiting-input', scrub);
    expect(turn).toEqual({ runId: 'run-1', request: 'Make it bigger', reply: 'Reading …/site', status: 'awaiting-input', activities: [{ label: 'Checked …/site/pages', status: 'done' }], question: { id: 'q1', text: 'Which one?', choices: ['A', 'B'] }, result: null });
    const ended = liveAiTurn('Make it bigger', { ...assistant, result: { status: 'completed', summary: 'Done in /Users/host/site', changes: [{ label: 'Heading', operations: ['instance.setProp'] }], validation: ['raw'], canUndo: true, usage: { inputTokens: 5, outputTokens: 5 } } }, null, scrub);
    expect(ended.question).toBeNull();
    expect(ended.result).toEqual({ status: 'completed', summary: 'Done in …/site', changes: ['Heading'] });
    const text = JSON.stringify(ended);
    for (const hidden of ['gpt-secret', 'validate_project', 'raw diagnostics', 'instance.setProp', 'inputTokens', '/Users/host']) expect(text).not.toContain(hidden);
    // A question says nothing of the host's computer either.
    expect(liveAiTurn('x', { ...assistant, questions: [{ id: 'q1', text: 'Use /Users/host/site/logo.png?', choices: ['Yes, /Users/host/a', 'No'] }] }, 'awaiting-input', scrub).question).toEqual({ id: 'q1', text: 'Use …/site/logo.png?', choices: ['Yes, …/a', 'No'] });
    // A request the host's AI setup stopped says only that: never the provider, its address, or the error.
    const setup = liveAiTurn('x', { ...assistant, result: { status: 'failed', summary: 'No OpenAI API key is set. Add one in Settings.', changes: [], validation: [], canUndo: false, error: 'sk-… missing', repair: 'key' } }, null, scrub);
    expect(setup.result).toEqual({ status: 'failed', summary: LIVE_AI_SETUP_PROBLEM, changes: [] });
    const local = liveAiTurn('x', { ...assistant, activities: [{ id: 'r', label: 'Checked http://localhost:1234/v1 and http://192.168.1.20:8080/v1', status: 'running' }] }, 'running', scrub);
    expect(local.activities[0].label).toBe('Checked … and …');
    // The provider's own words, in a retry or a failure, never reach the guest.
    const retry = liveAiTurn('x', { ...assistant, activities: [{ id: 'r', label: 'gpt-secret is overloaded at api.example Retrying…', status: 'running', tool: 'provider' }] }, 'running', scrub);
    expect(retry.activities[0].label).not.toContain('gpt-secret');
    const failed = liveAiTurn('x', { ...assistant, result: { status: 'failed', summary: 'The AI request failed: model gpt-secret not found on the server', changes: [], validation: [], canUndo: false } }, null, scrub);
    expect(failed.result!.summary).not.toContain('gpt-secret');
    expect(liveAiTurn('x', { ...assistant, activities: [{ id: 'r', label: 'Linked https://example.org/menu', status: 'done' }] }, 'running', scrub).activities[0].label).toBe('Linked https://example.org/menu');
    // A summary that only repeats the reply is sent once.
    const same = 'Made it bigger. '.repeat(400);
    expect(liveAiTurn('x', { ...assistant, text: same, result: { status: 'completed', summary: same, changes: [], validation: [], canUndo: true } }, null, scrub).result!.summary).toBe('');
    expect(liveAiTurn('x', { ...assistant, text: 'y'.repeat(LIVE_AI_REPLY_MAX + 50) }, null, scrub).reply).toHaveLength(LIVE_AI_REPLY_MAX);
  });

  it('is read back by the guest only when every part of it is what a turn holds', () => {
    const turn = liveAiTurn('Make it bigger', assistant, 'running', scrub);
    expect(readAiTurnEvent({ kind: 'turn', turn })).toEqual({ kind: 'turn', turn });
    expect(readAiTurnEvent({ kind: 'text', runId: 'run-1', at: 3, text: 'more' })).toEqual({ kind: 'text', runId: 'run-1', at: 3, text: 'more' });
    for (const bad of [null, {}, { kind: 'turn' }, { kind: 'turn', turn: { ...turn, status: 'exploded' } }, { kind: 'turn', turn: { ...turn, activities: [{ label: 1 }] } }, { kind: 'text', runId: '', at: 0, text: '' }, { kind: 'text', runId: 'r', at: -1, text: '' }])
      expect(readAiTurnEvent(bad), JSON.stringify(bad)).toBeNull();
    expect(readAiAccess({ allowed: true, turnsLeft: 3 })).toEqual({ allowed: true, turnsLeft: 3 });
    expect(readAiAccess({ allowed: true, turnsLeft: null })).toEqual({ allowed: true, turnsLeft: null });
    for (const bad of [null, { allowed: 'yes' }, { allowed: true, turnsLeft: -1 }, { allowed: true, turnsLeft: 1.5 }]) expect(readAiAccess(bad)).toBeNull();
  });
});
