/**
 * Which model handled each AI turn (issue #86): the recipient is fixed when the run starts, survives a model switch
 * while the reply is pending, is saved with the transcript and read back when the conversation is reopened.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext, ChatMessage, Conversation, ProviderId } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { readTurnModel, replayedHistory, REPLAYED_MESSAGES, turnModelText } from '@shared/turn-model';

/** Answers each request with `reply`, after `gate` opens when one is set: a reply held while Settings change. */
class HeldAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  gate: Promise<void> | null = null;
  /** Streamed before the gate: the model has started answering. */
  preface = '';
  /** Answered instead of the reply: a provider refusing the request, say. */
  failure: Extract<ModelEvent, { type: 'error' }> | null = null;
  constructor(private reply: string) {}
  capabilities() {
    return { toolCalling: 'native', streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    if (this.failure) {
      yield this.failure;
      return;
    }
    if (this.preface) yield { type: 'text', delta: this.preface };
    // Stop ends the wait, as a provider's aborted request would.
    if (this.gate) await Promise.race([this.gate, new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))]);
    if (signal.aborted) {
      yield { type: 'error', code: 'cancelled', message: 'Canceled' };
      return;
    }
    yield { type: 'done', stopReason: 'end', text: this.reply, toolCalls: [] };
  }
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup(opts: { compileAll?: () => Promise<[]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-turn-model-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const models: Record<string, HeldAdapter> = { 'studio-a': new HeldAdapter('Noted by A.'), 'studio-b': new HeldAdapter('Noted by B.'), 'gpt-6.2-sol': new HeldAdapter('Noted by OpenAI.') };
  /** What Settings choose now: read once per run, when it starts, as the app does. `auto`: the server picked it. */
  const selected: { provider: ProviderId; model: string; auto?: boolean } = { provider: 'local', model: 'studio-a' };
  const events: AiEvent[] = [];
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter: models[selected.model], model: selected.model, provider: selected.provider, ...(selected.auto ? { auto: true } : {}) }),
    emit: (e) => events.push(e),
    compileAll: opts.compileAll ?? (async () => []),
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, mode: 'ask' };
  const settle = () => expect.poll(() => orch.busy, { timeout: 5000, interval: 5 }).toBe(false);
  const lastTurn = () => orch.conversation!.messages.at(-1)!;
  /** The saved transcript, once it holds `count` messages: it is written after the run ends. */
  const saved = async (id: string, count: number) => {
    const file = session.local('sessions', 'chat', `${id}.json`);
    const read = () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as Conversation;
      } catch {
        return null;
      }
    };
    await expect.poll(() => read()?.messages.length, { timeout: 5000, interval: 5 }).toBe(count);
    return read()!;
  };
  return { session, dir, models, selected, events, orch, ctx, settle, lastTurn, saved };
}

describe('the model that handled each turn', () => {
  it('stays the one the run started with when Settings switch models while its reply is held', async () => {
    const { models, selected, events, orch, ctx, settle, lastTurn } = await setup();
    let release!: () => void;
    models['studio-a'].gate = new Promise((r) => (release = r));
    const sent = await orch.send('A note for studio-a', ctx);
    expect(sent.ok).toBe(true);
    // The running turn names its recipient before the reply comes back, and before the app is told it is running.
    const stamped = () => events.findIndex((e) => e.kind === 'message' && e.message?.runId === sent.runId && e.message?.model?.id === 'studio-a');
    await expect.poll(stamped, { timeout: 5000, interval: 5 }).toBeGreaterThan(-1);
    const running = events.findIndex((e) => e.kind === 'status' && e.runId === sent.runId && e.status === 'running');
    expect(running).toBeGreaterThan(stamped());
    expect(events.slice(0, stamped()).some((e) => e.kind === 'status' && e.runId === sent.runId)).toBe(false);
    expect(models['studio-a'].requests).toHaveLength(1);
    // Settings now choose studio-b for the next message, while A still works on this one.
    selected.model = 'studio-b';
    release();
    await settle();
    const done = lastTurn();
    expect(done.result?.summary).toBe('Noted by A.');
    expect(done.model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a' });
    expect(turnModelText(done.model!)).toBe('Local model · studio-a');
    expect(models['studio-b'].requests).toHaveLength(0);

    // The follow-up goes to B, which is handed A's turn as earlier conversation: the turns say who handled each.
    await orch.send('A follow-up for studio-b', ctx);
    await settle();
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-b', label: 'studio-b' });
    expect(JSON.stringify(models['studio-b'].requests[0].items)).toContain('A note for studio-a');
    const turns = orch.conversation!.messages.filter((m) => m.role === 'assistant').map((m) => m.model?.id);
    expect(turns).toEqual(['studio-a', 'studio-b']);

    // A fresh conversation sends B only the new message.
    await orch.newConversation();
    await orch.send('A fresh start for studio-b', ctx);
    await settle();
    const fresh = JSON.stringify(models['studio-b'].requests.at(-1)!.items);
    expect(fresh).toContain('A fresh start for studio-b');
    expect(fresh).not.toContain('A note for studio-a');
  });

  it('is saved with the transcript and read back when the conversation is reopened', async () => {
    const { selected, orch, ctx, settle, saved } = await setup();
    await orch.send('A note for studio-a', ctx);
    await settle();
    selected.provider = 'openai';
    selected.model = 'gpt-6.2-sol';
    await orch.send('Now for OpenAI', ctx);
    await settle();
    const id = orch.conversation!.id;
    const file = await saved(id, 4);
    expect(file.messages.filter((m) => m.role === 'assistant').map((m) => m.model)).toEqual([
      { provider: 'local', id: 'studio-a', label: 'studio-a' },
      { provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }
    ]);
    // A new conversation, then the earlier one again, as the history menu does after a restart.
    orch.reset();
    await orch.newConversation();
    const reopened = await orch.openConversation(id);
    expect(reopened.messages.filter((m) => m.role === 'assistant').map((m) => turnModelText(readTurnModel(m.model)!))).toEqual(['Local model · studio-a', 'OpenAI · GPT-6.2 Sol']);
    // User messages never claim a model.
    expect(reopened.messages.filter((m) => m.role === 'user').every((m) => m.model === undefined)).toBe(true);
  });

  it('records a model the local server picked itself, apart from one chosen in Settings', async () => {
    const { selected, orch, ctx, settle, lastTurn, saved } = await setup();
    selected.auto = true;
    await orch.send('Whichever model the server runs', ctx);
    await settle();
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a', auto: true });
    selected.auto = false;
    await orch.send('Now studio-a by name', ctx);
    await settle();
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a' });
    const id = orch.conversation!.id;
    const file = await saved(id, 4);
    expect(file.messages.filter((m) => m.role === 'assistant').map((m) => readTurnModel(m.model)?.auto)).toEqual([true, undefined]);
    // ...and read back so when the conversation is reopened.
    orch.reset();
    await orch.newConversation();
    const reopened = await orch.openConversation(id);
    expect(reopened.messages.filter((m) => m.role === 'assistant').map((m) => readTurnModel(m.model)?.auto)).toEqual([true, undefined]);
  });

  it('marks a turn stopped before its request went out as unanswered, still naming the model it was for', async () => {
    let compiled!: () => void;
    const compiling = new Promise<void>((r) => (compiled = r));
    let started!: () => void;
    const preparing = new Promise<void>((r) => (started = r));
    const { models, events, orch, ctx, settle, lastTurn } = await setup({
      compileAll: async () => {
        started();
        await compiling;
        return [];
      }
    });
    // An edit checks the project before its first request: stopped then, nothing has gone to the model yet.
    const sent = await orch.send('Rename the site', { ...ctx, mode: 'edit' });
    await preparing;
    expect(events.some((e) => e.kind === 'message' && e.message?.runId === sent.runId && e.message?.model?.id === 'studio-a')).toBe(true);
    orch.stop();
    compiled();
    await settle();
    expect(lastTurn().result?.status).toBe('cancelled');
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a', unanswered: true });
    expect(models['studio-a'].requests).toHaveLength(0);
    // The renderer is told too, in the last word on that turn.
    const last = [...events].reverse().find((e) => e.kind === 'message' && e.message?.runId === sent.runId);
    expect(last?.message?.model?.unanswered).toBe(true);
  });

  it('keeps a turn stopped once the model has started answering, which it did handle', async () => {
    const { models, events, orch, ctx, settle, lastTurn } = await setup();
    models['studio-a'].preface = 'Noting';
    models['studio-a'].gate = new Promise(() => undefined);
    const sent = await orch.send('A note for studio-a', ctx);
    await expect.poll(() => events.some((e) => e.kind === 'text' && e.runId === sent.runId), { timeout: 5000, interval: 5 }).toBe(true);
    orch.stop();
    await settle();
    expect(lastTurn().result?.status).toBe('cancelled');
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a' });
    const last = [...events].reverse().find((e) => e.kind === 'message' && e.message?.runId === sent.runId);
    expect(last?.message?.model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a' });
  });

  it('marks a turn its model never answered as unanswered: stopped while waiting, or refused', async () => {
    const { models, orch, ctx, settle, lastTurn } = await setup();
    // Sent, but stopped before a word came back.
    models['studio-a'].gate = new Promise(() => undefined);
    await orch.send('A note for studio-a', ctx);
    await expect.poll(() => models['studio-a'].requests.length, { timeout: 5000, interval: 5 }).toBe(1);
    orch.stop();
    await settle();
    expect(lastTurn().result?.status).toBe('cancelled');
    expect(lastTurn().model?.unanswered).toBe(true);
    // Refused by the provider: an error is not an answer.
    models['studio-a'].gate = null;
    models['studio-a'].failure = { type: 'error', code: 'auth', message: 'Invalid API key' };
    await orch.send('Another note', ctx);
    await settle();
    expect(lastTurn().result?.status).toBe('failed');
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a', unanswered: true });
  });

  it('carries the replayed window of earlier messages in full, and the ones before it as a summary', async () => {
    const { models, orch, ctx, settle } = await setup();
    // The window holds six earlier exchanges: the seventh request sends them all as they were said.
    const last = REPLAYED_MESSAGES / 2 + 2;
    for (let i = 1; i <= last; i++) {
      await orch.send(`note number ${i}.`, ctx);
      await settle();
    }
    const texts = (r: number) => models['studio-a'].requests[r].items.map((i) => ('text' in i ? i.text : ''));
    expect(texts(last - 2)[0]).toBe('note number 1.');
    expect(texts(last - 2).join('\n')).not.toContain('Summary of the earlier conversation');
    // The eighth no longer replays the first note in full: it comes first, in a labelled summary, and only there.
    const sent = texts(last - 1);
    expect(sent[0]).toMatch(/^\[Summary of the earlier conversation/);
    expect(sent[0]).toContain('The author asked: "note number 1."');
    expect(sent.filter((t) => t.includes('note number 1.'))).toHaveLength(1);
    // Then exchanges two to seven as they were said, in order, and the new request.
    const users = sent.slice(1).filter((t) => /^note number \d+\.$/.test(t));
    expect(users).toEqual(Array.from({ length: last - 2 }, (_, i) => `note number ${i + 2}.`));
    expect(sent.at(-1)).toContain(`note number ${last}.`);
    expect(REPLAYED_MESSAGES).toBe(12);
  });

  it('marks a request that could not take the project as unanswered, with nothing sent', async () => {
    const { session, models, orch, ctx, settle, lastTurn } = await setup();
    session.beginRun = async () => 'Another app is changing this project.';
    await orch.send('Rename the site', { ...ctx, mode: 'edit' });
    await settle();
    expect(lastTurn().result).toMatchObject({ status: 'failed', summary: 'Another app is changing this project.' });
    expect(lastTurn().model).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a', unanswered: true });
    expect(models['studio-a'].requests).toHaveLength(0);
  });

  it('sends nothing when the message would go to another model than the composer named', async () => {
    const { models, selected, orch, ctx, settle, lastTurn } = await setup();
    // Written for studio-a, but Settings (or the local server) now send to studio-b.
    selected.model = 'studio-b';
    const sent = await orch.send('A note for studio-a', ctx, undefined, { provider: 'local', model: 'studio-a' });
    expect(sent.ok).toBe(true);
    await settle();
    expect(lastTurn().result).toMatchObject({ status: 'failed', summary: 'Nothing was sent. This message was for Local model · studio-a, but it would now go to Local model · studio-b. Check where your next message goes, then send it again.' });
    expect(lastTurn().model).toBeUndefined();
    expect(models['studio-a'].requests).toHaveLength(0);
    expect(models['studio-b'].requests).toHaveLength(0);
    // Another provider altogether: a hosted one would have received a local conversation.
    selected.provider = 'openai';
    selected.model = 'gpt-6.2-sol';
    await orch.send('Still for studio-b', ctx, undefined, { provider: 'local', model: 'studio-b' });
    await settle();
    expect(lastTurn().result?.summary).toBe('Nothing was sent. This message was for Local model · studio-b, but it would now go to OpenAI · GPT-6.2 Sol. Check where your next message goes, then send it again.');
    expect(models['gpt-6.2-sol'].requests).toHaveLength(0);
    // Sent where the composer said: it goes ahead. A server's own model not yet known matches whatever it offers.
    await orch.send('For OpenAI', ctx, undefined, { provider: 'openai', model: 'gpt-6.2-sol' });
    await settle();
    expect(lastTurn().result?.summary).toBe('Noted by OpenAI.');
    selected.provider = 'local';
    selected.model = 'studio-a';
    selected.auto = true;
    await orch.send('For the server', ctx, undefined, { provider: 'local', model: null });
    await settle();
    expect(lastTurn().model).toMatchObject({ id: 'studio-a', auto: true });
    // A recipient that cannot be read is refused before the message joins the conversation.
    const count = orch.conversation!.messages.length;
    for (const bad of [{ provider: 'gemini', model: 'x' }, { provider: 'local', model: '' }, { provider: 'local' }, 'local'])
      expect(await orch.send('Hello', ctx, undefined, bad)).toEqual({ ok: false, message: 'Your message could not be read. Try sending it again.' });
    expect(orch.conversation!.messages).toHaveLength(count);
  });

  it('is left unset when the run never reached a model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-turn-model-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
    const orch = new Orchestrator({
      session: () => session,
      adapter: async () => ({ error: 'Add your OpenAI API key in Settings to use the assistant.' }),
      emit: () => undefined,
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: () => undefined
    });
    await orch.send('Hello', { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 });
    await expect.poll(() => orch.busy, { timeout: 5000, interval: 5 }).toBe(false);
    const turn = orch.conversation!.messages.at(-1) as ChatMessage;
    expect(turn.result?.status).toBe('failed');
    expect(turn.model).toBeUndefined();
  });
});

describe('readTurnModel', () => {
  it('reads a stored model and refuses anything malformed', () => {
    expect(readTurnModel({ provider: 'anthropic', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' })).toEqual({ provider: 'anthropic', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' });
    // A label that is missing or blank falls back to the ID.
    expect(readTurnModel({ provider: 'local', id: 'studio-a' })).toEqual({ provider: 'local', id: 'studio-a', label: 'studio-a' });
    expect(readTurnModel({ provider: 'local', id: 'studio-a', label: '  ' })?.label).toBe('studio-a');
    // `auto` is kept only as stored by a local turn.
    expect(readTurnModel({ provider: 'local', id: 'studio-a', auto: true })?.auto).toBe(true);
    expect(readTurnModel({ provider: 'local', id: 'studio-a', auto: 'yes' })?.auto).toBeUndefined();
    expect(readTurnModel({ provider: 'openai', id: 'gpt-6.2-sol', auto: true })?.auto).toBeUndefined();
    expect(readTurnModel({ provider: 'local', id: 'studio-a', unanswered: true })?.unanswered).toBe(true);
    expect(readTurnModel({ provider: 'local', id: 'studio-a', unanswered: 1 })?.unanswered).toBeUndefined();
    for (const bad of [undefined, null, 'studio-a', {}, { provider: 'gemini', id: 'x' }, { provider: 'toString', id: 'x' }, { provider: 'local', id: '' }, { provider: 'local', id: '   ' }, { provider: 'local', id: 7 }]) expect(readTurnModel(bad)).toBeNull();
  });

  it('shares the replay window with the orchestrator', () => {
    const list = Array.from({ length: REPLAYED_MESSAGES + 3 }, (_, i) => i);
    expect(replayedHistory(list)).toEqual(list.slice(3));
    expect(replayedHistory([1, 2])).toEqual([1, 2]);
  });
});
