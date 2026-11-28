/**
 * Chat updates the project brief when the author asks (#1407): update_project_brief is offered only when the author's
 * own message asks to update the brief or to remember something about the project, adds a note to the notes as saved
 * (never retyped from the part a request reads), and lands through the project's grant check like any other run change.
 * Ordinary design and content turns, questions, "Continue" and the raw operation leave the brief as it is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { briefWriteIntent } from '@agent/brief-tools';
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
/** The result the model was sent for its last call. */
const lastResult = (req: CanonicalModelRequest) => JSON.parse((req.items.at(-1) as { content: string }).content);
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

describe('what the author asks of the brief (#1407)', () => {
  it('is a change to the brief only when the message asks for one in so many words', () => {
    for (const text of [
      ISSUE_REQUEST,
      'Add to the working notes that the client prefers British spelling.',
      "Please change the project description to 'A practice restoring old stone houses.'",
      'Can you update our brief so it says we also work in Tuscany?',
      'Remember for this project that the founder is called Claire.',
      'Add that we close every August to my project brief.',
      'My project brief should say we restore lime mortar.',
      "Put this in the brief: we never use cement.",
      'From now on, remember that every page needs a booking button.'
    ])
      expect(briefWriteIntent(text), text).toContain('add_note');
    for (const text of [
      'Write a short intro for the home page',
      'Write a brief intro for the about page',
      'Add a brief description under the hero heading',
      'Shorten the hero using the project brief',
      'Rewrite the services page so it follows the brief',
      'Edit the hero using the project brief',
      'Update the about page copy according to the brief',
      'Write brief notes under each service card',
      "Don't update the brief, just redo the hero",
      'How do I update the project brief?',
      'Remember to keep the hero short',
      ''
    ])
      expect(briefWriteIntent(text), text).toEqual([]);
  });

  it('sets the description when the message names it or there is none yet, and replaces notes only when asked to', () => {
    const described = { brief: { schemaVersion: 1, description: DESCRIPTION, notes: NOTES } };
    expect(briefWriteIntent(ISSUE_REQUEST, described)).toEqual(['add_note']);
    expect(briefWriteIntent(ISSUE_REQUEST, {})).toEqual(['add_note', 'set_description']);
    expect(briefWriteIntent('Update the project description to say we restore stone houses', described)).toEqual(['add_note', 'set_description']);
    expect(briefWriteIntent('Rewrite my working notes as a short list', described)).toEqual(['add_note', 'replace_notes']);
    expect(briefWriteIntent('Remember for this project that we close in August', described)).toEqual(['add_note']);
  });
});

describe('update_project_brief in a run (#1407)', () => {
  it('adds the note the issue asks for to an empty brief, in one undoable change', async () => {
    const env = await setup([(req) => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('Added it to your Project Brief.')]);
    await env.run(ISSUE_REQUEST);
    const first = env.adapter.requests[0];
    expect(offers(first)).toBe(true);
    expect(actionsOffered(first)).toEqual(['add_note', 'set_description']);
    const result = lastResult(env.adapter.requests[1]);
    expect(result).toMatchObject({ ok: true, updated: 'notes' });
    expect(brief(env.session.state)).toEqual({ description: '', notes: FACT });
    // The next request reads it as background.
    expect(briefContext(env.session.state)).toContain(FACT);
    expect((await env.session.undo()).ok).toBe(true);
    expect(env.session.state.brief).toBeUndefined();
  });

  it('keeps the description and every note the author wrote, adding the new one after them', async () => {
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('Done.')], { brief: { description: DESCRIPTION, notes: NOTES } });
    await env.run(ISSUE_REQUEST);
    expect(actionsOffered(env.adapter.requests[0])).toEqual(['add_note']);
    expect(brief(env.session.state)).toEqual({ description: DESCRIPTION, notes: `${NOTES}\n\n${FACT}` });
  });

  it('puts the note first in notes too long to read whole, and never rewrites them from the part a request reads', async () => {
    const tail = 'THE-AUTHOR-S-LAST-PARAGRAPH';
    const long = `${'Owners want the old lime mortar kept wherever it is sound. '.repeat(250)}${tail}`;
    expect(long.length).toBeLessThan(TEXT_LIMITS.projectNotes - 200);
    const env = await setup(
      [
        () => call('c1', 'update_project_brief', { action: 'replace_notes', text: 'Owners want the old lime mortar kept.' }),
        (req) => {
          expect(lastResult(req)).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
          return call('c2', 'update_project_brief', { action: 'add_note', text: FACT });
        },
        () => finish('Done.')
      ],
      { brief: { description: DESCRIPTION, notes: long } }
    );
    await env.run('Rewrite my working notes and add that we specialise in Provence and Lake Como.');
    const notes = env.session.state.brief!.notes;
    expect(notes).toBe(`${FACT}\n\n${long}`);
    expect(notes.endsWith(tail)).toBe(true);
    expect(briefContext(env.session.state)).toContain(FACT);
  });

  it('refuses an action the message did not ask for, and a note over the limit, saving nothing', async () => {
    const full = 'n'.repeat(TEXT_LIMITS.projectNotes - 10);
    const env = await setup(
      [
        () => call('c1', 'update_project_brief', { action: 'set_description', text: 'Something else' }),
        (req) => {
          expect(lastResult(req)).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
          return call('c2', 'update_project_brief', { action: 'add_note', text: FACT });
        },
        (req) => {
          expect(lastResult(req)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
          return finish('The notes are full.');
        }
      ],
      { brief: { description: DESCRIPTION, notes: full } }
    );
    await env.run(ISSUE_REQUEST);
    expect(env.adapter.requests).toHaveLength(3);
    expect(brief(env.session.state)).toEqual({ description: DESCRIPTION, notes: full });
  });

  it('is never offered to an ordinary turn, a question or "Continue", and the raw operation is refused', async () => {
    const env = await setup(
      [
        // An ordinary design turn that tries the raw operation anyway, then the tool it was not offered.
        (req) => call('c1', 'apply_operations', { expectedRevision: req.items.length ? 1 : 1, operations: [{ type: 'brief.update', notes: 'Written by a model' }] }),
        (req) => {
          expect(lastResult(req).ok).toBe(false);
          return call('c2', 'update_project_brief', { action: 'add_note', text: 'Written by a model' });
        },
        (req) => {
          expect(lastResult(req).ok).toBe(false);
          return finish('Left it.');
        },
        () => finish('A question.'),
        () => finish('Carried on.')
      ],
      { brief: { description: DESCRIPTION, notes: NOTES } }
    );
    await env.run('Shorten the hero using the project brief');
    expect(offers(env.adapter.requests[0])).toBe(false);
    await env.run('What does my project brief say?', { mode: 'ask' });
    expect(offers(env.adapter.requests[3])).toBe(false);
    await env.run('Continue');
    expect(offers(env.adapter.requests[4])).toBe(false);
    expect(brief(env.session.state)).toEqual({ description: DESCRIPTION, notes: NOTES });
  });

  it('asks to change more than the page before changing the brief from a page run', async () => {
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), (req) => {
      const r = lastResult(req);
      expect(r).toMatchObject({ ok: false, error: { code: 'SCOPE_MISMATCH' } });
      expect(r.error.message).toMatch(/widenScope|request_wider_scope/);
      return finish('May I change more than this page?');
    }]);
    await env.run(ISSUE_REQUEST, { scope: 'page' });
    expect(offers(env.adapter.requests[0])).toBe(true);
    expect(env.session.state.brief).toBeUndefined();
  });

  it('is offered to a grammar-constrained local model, with its short brief', async () => {
    const env = await setup([() => call('c1', 'update_project_brief', { action: 'add_note', text: FACT }), () => finish('Done.')], { capabilities: { toolCalling: 'constrained-json', contextWindowTokens: 32_768 } });
    await env.run(ISSUE_REQUEST);
    expect(offers(env.adapter.requests[0])).toBe(true);
    expect(env.session.state.brief?.notes).toBe(FACT);
  });
});
