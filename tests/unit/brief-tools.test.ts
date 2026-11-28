/**
 * Chat updates the project brief when the author asks (#1407): update_project_brief is offered only when the author's
 * own message asks to update the brief or to remember something about the project, adds a note to the notes as saved
 * (never retyped from the part a request reads) or sets the description, and lands through the project's grant check
 * like any other run change.
 * Ordinary design and content turns, questions, "Continue" and the raw operation leave the brief as it is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { BRIEF_RUN_LABEL, briefWriteIntent, runUpdateBrief, withoutBriefAsks } from '@agent/brief-tools';
import type { ToolHost } from '@agent/tools';
import { briefContext } from '@agent/brief';
import { TEXT_LIMITS } from '@shared/text-limits';
import { ProjectSession } from '../../src/main/project/session';

type Turn = (req: CanonicalModelRequest) => ModelEvent[];

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Turn[], private caps: Partial<ReturnType<AgentModelAdapter['capabilities']>> = {}) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000, ...this.caps } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    for (const ev of turn ? turn(req) : finish('Done.')) yield ev;
  }
}

const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }];
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [] }];
/** The result the model was sent for call `callId`, read after the run so a wrong one fails the test. */
const resultOf = (adapter: FakeAdapter, callId: string) => {
  for (const req of adapter.requests)
    for (const item of req.items) if (item.kind === 'tool_result' && item.callId === callId) return JSON.parse(item.content);
  throw new Error(`No result for ${callId}`);
};
const offers = (req: CanonicalModelRequest | undefined) => !!req?.tools.some((t) => t.name === 'update_project_brief');
const actionsOffered = (req: CanonicalModelRequest) => {
  const tool = req.tools.find((t) => t.name === 'update_project_brief')!;
  return ((tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum ?? []).slice().sort();
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const DESCRIPTION = 'A brochure site for a restoration practice.';
const NOTES = 'Audience: owners of old houses.\nTone: calm and exact.';
const FACT = 'We specialise in historic limestone estates across Provence and Lake Como.';
const ISSUE_REQUEST = 'Update my Project Brief to note that we specialize in historic limestone estates across Provence and Lake Como.';

async function setup(turns: Turn[], opts: { brief?: { description?: string; notes?: string }; capabilities?: Partial<ReturnType<AgentModelAdapter['capabilities']>> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-brief-tool-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  if (opts.brief) expect((await session.apply({ operations: [{ type: 'brief.update', ...opts.brief }] }, { label: 'Edit brief' })).ok).toBe(true);
  const adapter = new FakeAdapter(turns, opts.capabilities);
  const events: AiEvent[] = [];
  const orch: Orchestrator = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => {
      events.push(e);
      // Every question the run asks (a wider scope, say) is answered with its first choice.
      const waiting = e.kind === 'message' ? e.message?.questions?.at(-1) : undefined;
      if (waiting?.id && waiting.answered === undefined) queueMicrotask(() => orch.answer(e.runId, waiting.id!, waiting.choices?.[0] ?? 'Yes'));
    },
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  const run = async (text: string, extra: Partial<ChatContext> = {}) => {
    const r = await orch.send(text, { ...ctx, ...extra });
    expect(r.ok).toBe(true);
    while (orch.busy) await new Promise((res) => setTimeout(res, 10));
    return r.runId!;
  };
  return { session, adapter, run, events };
}

const brief = (s: ProjectState) => ({ description: s.brief?.description ?? '', notes: s.brief?.notes ?? '' });
const actions = (text: string, state?: Pick<ProjectState, 'brief'>) => briefWriteIntent(text, state)?.actions ?? [];
const described: Pick<ProjectState, 'brief'> = { brief: { schemaVersion: 1, description: DESCRIPTION, notes: NOTES } };

describe('what the author asks of the brief (#1407)', () => {
  it('is a change to the brief only when the message asks for one in so many words', () => {
    for (const text of [
      ISSUE_REQUEST,
      'Add to the working notes that the client prefers British spelling.',
      "Please change the project description to 'A practice restoring old stone houses.'",
      'Can you update our brief so it says we also work in Tuscany?',
      'Remember for this project that the founder is called Claire.',
      'Remember that our brand uses British spelling.',
      'Add that we close every August to my project brief.',
      'My project brief should say we restore lime mortar.',
      'Put this in the brief: we never use cement.',
      "Update the project brief to say we don't take notes during consultations.",
      'From now on, remember that every page needs a booking button.',
      'Add to my working notes: We haven’t decided whether to accept returns.',
      "Never change the home page’s headline or the service copy, but update the project brief to say we open at 10.",
      'Update the Project Brief. Should I provide details?'
    ])
      expect(actions(text, described), text).toContain('add_note');
    for (const text of [
      'Write a short intro for the home page',
      'Write a brief intro for the about page',
      'Add a brief description under the hero heading',
      'Shorten the hero using the project brief',
      'Rewrite the services page so it follows the brief',
      'Rewrite the hero to match the project brief',
      'Edit the hero using the project brief',
      'Update the about page copy according to the brief',
      'Write brief notes under each service card',
      "Change the button label to 'Clear working notes'",
      "Put this customer quote on the homepage: “Update my Project Brief to say we are closed”",
      "Don't update the brief, just redo the hero",
      "Don't clear the project description",
      "Don't under any circumstances clear the brief's description.",
      'Change "Welcome to the Studio" (use the project brief for context) to a warmer headline.',
      'Change the button label to "Project Description".',
      'How do I edit my working notes, e.g. clear the project description?',
      'Can you read the working notes and tell me whether to rewrite the project brief?',
      'How do I update the project brief?',
      'Remember to keep the hero short',
      ''
    ])
      expect(briefWriteIntent(text, described), text).toBeNull();
  });

  it('sets the description when the message names it, or only while there is none when it does not', () => {
    expect(briefWriteIntent(ISSUE_REQUEST, described)).toEqual({ actions: ['add_note'] });
    expect(briefWriteIntent(ISSUE_REQUEST, {})).toEqual({ actions: ['add_note', 'set_description'], descriptionIfEmpty: true });
    expect(briefWriteIntent('Update the project description to say we restore stone houses', described)).toEqual({ actions: ['add_note', 'set_description'] });
    // Rewriting or clearing the notes is the author's, in the Project tab: it is never offered.
    expect(briefWriteIntent('Rewrite my working notes as a short list', described)).toEqual({ actions: ['add_note'] });
    expect(briefWriteIntent('Clear the project description', described)).toEqual({ actions: ['add_note', 'set_description'] });
    // A description named in another sentence is a page's, not the brief's.
    expect(briefWriteIntent('Remember that this hero is a one-off draft. Rewrite the homepage description.', described)).toEqual({ actions: ['add_note'] });
  });

  it('leaves the rest of a request to the page checks once its brief sentences are taken out', () => {
    expect(withoutBriefAsks('Add to my project brief that we plan to build the Services page next year. Then build the Contact page.')).toBe('Then build the Contact page.');
    // The brief's clause goes; what is left of it names no page.
    expect(withoutBriefAsks(ISSUE_REQUEST)).not.toMatch(/brief|specialize|historic/i);
    expect(withoutBriefAsks('Build the Services page')).toBe('Build the Services page');
    // A page asked for beside a note, in one sentence or with a quoted name, is still asked for.
    expect(withoutBriefAsks('Build the Services page and add to my working notes that we close in August.')).toBe('Build the Services page');
    expect(withoutBriefAsks('Build the "Contact Us" page. Add to my working notes that we close in August.')).toBe('Build the "Contact Us" page.');
  });
});

describe('update_project_brief in a run (#1407)', () => {
  it('adds the note the issue asks for to an empty brief, read by the next request, in one undoable History step', async () => {
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('Added it to your Project Brief.'), () => finish('Done.')]);
    await env.run(ISSUE_REQUEST);
    expect(offers(env.adapter.requests[0])).toBe(true);
    expect(actionsOffered(env.adapter.requests[0])).toEqual(['add_note', 'set_description']);
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: true, updated: 'notes', placed: 'end' });
    expect(brief(env.session.state)).toEqual({ description: '', notes: FACT });
    // Named for what it did, never with the request's own words.
    expect(env.session.historyInfo().entries.at(-1)?.label).toBe(BRIEF_RUN_LABEL);
    // The next request reads it as background, and is not offered the tool.
    await env.run('Write a short intro for the home page');
    expect(env.adapter.requests[2].system).toContain(FACT);
    expect(offers(env.adapter.requests[2])).toBe(false);
    expect((await env.session.undo()).ok).toBe(true);
    expect(env.session.state.brief).toBeUndefined();
  });

  it('keeps the description and every note the author wrote, adding the new one after them once', async () => {
    const env = await setup(
      [() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => call('c2', 'update_project_brief', { action: 'add_note', text: `  ${FACT}  ` }), () => finish('Done.')],
      { brief: { description: DESCRIPTION, notes: `  ${NOTES}` } }
    );
    await env.run(ISSUE_REQUEST);
    expect(actionsOffered(env.adapter.requests[0])).toEqual(['add_note']);
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: true, placed: 'end' });
    // Asked again: already there, so nothing changes.
    expect(resultOf(env.adapter, 'c2')).toMatchObject({ ok: true, unchanged: true });
    expect(brief(env.session.state)).toEqual({ description: DESCRIPTION, notes: `  ${NOTES}\n\n${FACT}` });
  });

  it('adds a note that only reads like part of another one', async () => {
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: 'Use blue.' }), () => finish('Done.')], { brief: { description: DESCRIPTION, notes: 'Retired instruction: Use blue.' } });
    await env.run('Add to my working notes: Use blue.');
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: true, updated: 'notes' });
    expect(env.session.state.brief?.notes).toBe('Retired instruction: Use blue.\n\nUse blue.');
  });

  it('puts the note first in notes a small model reads only the start of, so its next request sees it', async () => {
    const tail = 'THE-AUTHOR-S-LAST-PARAGRAPH';
    const long = `${'Owners want the old lime mortar kept wherever it is sound. '.repeat(25)}${tail}`;
    const local = { toolCalling: 'constrained-json' as const, contextWindowTokens: 32_768 };
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('Done.'), () => finish('Done.')], { brief: { description: DESCRIPTION, notes: long }, capabilities: local });
    // Read whole by a larger model, only in part by a small one.
    expect(briefContext({ brief: { schemaVersion: 1, description: '', notes: long } })).toContain(tail);
    expect(briefContext({ brief: { schemaVersion: 1, description: '', notes: long } }, true)).not.toContain(tail);
    await env.run(ISSUE_REQUEST);
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: true, placed: 'start' });
    expect(env.session.state.brief?.notes).toBe(`${FACT}\n\n${long}`);
    await env.run('Write a short intro for the home page');
    expect(env.adapter.requests[2].system).toContain(FACT);
  });

  it('sets a description named in the message, and never one the author wrote while the run went on', async () => {
    const named = await setup([() => call('c1', 'update_project_brief', { action: 'set_description', text: 'A practice restoring old stone houses.' }), () => finish('Done.')], { brief: { description: DESCRIPTION, notes: NOTES } });
    await named.run('Change the project description to say we restore old stone houses.');
    expect(resultOf(named.adapter, 'c1')).toMatchObject({ ok: true, updated: 'description' });
    expect(brief(named.session.state)).toEqual({ description: 'A practice restoring old stone houses.', notes: NOTES });

    // Offered only because there was no description: one the author has written since (a held edit saved while the
    // run asked) stays theirs.
    const apply = vi.fn();
    const host = { state: () => ({ brief: { schemaVersion: 1, description: DESCRIPTION, notes: '' } }), revision: () => 3, briefWrite: () => ({ actions: ['add_note', 'set_description'], descriptionIfEmpty: true }), apply } as unknown as ToolHost;
    const r = await runUpdateBrief({ action: 'set_description', text: 'Limestone estates.' }, host, 'c1');
    expect(r).toMatchObject({ ok: false, content: { error: { code: 'SCOPE_MISMATCH' } } });
    expect(apply).not.toHaveBeenCalled();
    // A note can still be added then.
    apply.mockResolvedValue({ ok: true, revision: 4 });
    expect((await runUpdateBrief({ action: 'add_note', text: FACT }, host, 'c2')).ok).toBe(true);
    expect(apply).toHaveBeenCalledWith([{ type: 'brief.update', notes: FACT }], 3, expect.any(String), 'c2', { briefWrite: { field: 'notes', text: FACT, base: '' } });
  });

  it('refuses an action the message did not ask for, and a note over the limit, saving nothing', async () => {
    const full = 'n'.repeat(TEXT_LIMITS.projectNotes - 1);
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'set_description', text: 'Something else' }), () => call('c2', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('The notes are full.')], { brief: { description: DESCRIPTION, notes: full } });
    await env.run(ISSUE_REQUEST);
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', recoverable: true } });
    expect(resultOf(env.adapter, 'c2')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', message: expect.stringMatching(/full/), recoverable: false } });
    expect(brief(env.session.state)).toEqual({ description: DESCRIPTION, notes: full });
  });

  it('is never offered to an ordinary turn, a question or "Continue", and the raw operation is refused', async () => {
    const env = await setup(
      [
        // An ordinary design turn that tries the raw operation anyway, at the live revision, then the tool it was not offered.
        () => call('c1', 'apply_operations', { expectedRevision: 1, operations: [{ type: 'brief.update', notes: 'Written by a model' }] }),
        () => call('c2', 'update_project_brief', { action: 'add_note', text: 'Written by a model' }),
        () => finish('Left it.'),
        () => finish('A question.'),
        () => finish('Carried on.')
      ],
      { brief: { description: DESCRIPTION, notes: NOTES } }
    );
    expect(env.session.revision).toBe(1);
    await env.run('Shorten the hero using the project brief');
    expect(offers(env.adapter.requests[0])).toBe(false);
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/project brief can only be changed in the editor/) } });
    expect(resultOf(env.adapter, 'c2').ok).toBe(false);
    await env.run('What does my project brief say?', { mode: 'ask' });
    expect(offers(env.adapter.requests[3])).toBe(false);
    // Straight after a request that asked: "Continue" carries the work on, never the permission.
    await env.run('Continue');
    expect(offers(env.adapter.requests[4])).toBe(false);
    expect(brief(env.session.state)).toEqual({ description: DESCRIPTION, notes: NOTES });
  });

  it('asks to change more than the page before changing the brief from a page run, then changes it', async () => {
    const env = await setup([
      () => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }),
      () => call('c2', 'request_clarification', { question: 'May I change more than this page, to update your Project Brief?', widenScope: true }),
      () => call('c3', 'update_project_brief', { action: 'add_note', text: FACT }),
      () => finish('Done.')
    ]);
    await env.run(ISSUE_REQUEST, { scope: 'page' });
    expect(offers(env.adapter.requests[0])).toBe(true);
    const refused = resultOf(env.adapter, 'c1');
    expect(refused).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
    expect(refused.error.message).toMatch(/limited to/);
    expect(resultOf(env.adapter, 'c3')).toMatchObject({ ok: true, updated: 'notes' });
    expect(env.session.state.brief?.notes).toBe(FACT);
  });

  it('is offered to a grammar-constrained local model, with its short brief', async () => {
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('Done.')], { capabilities: { toolCalling: 'constrained-json', contextWindowTokens: 32_768 } });
    await env.run(ISSUE_REQUEST);
    expect(offers(env.adapter.requests[0])).toBe(true);
    expect(resultOf(env.adapter, 'c1')).toMatchObject({ ok: true });
    expect(env.session.state.brief?.notes).toBe(FACT);
  });
});
