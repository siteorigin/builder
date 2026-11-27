/**
 * Save now (#1281) end to end in the main process: the controller saves the author's held edit while the request waits
 * for their answer, the request keeps waiting, and the model hears of the edit with the answer.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatContext } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: {}
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { Orchestrator } = await import('@agent/orchestrator');
const { createStarterState } = await import('@catalogue/starters');
const { readFields } = await import('../../src/renderer/src/lib/held');
const { upsertCreatesIn } = await import('@agent/completeness');
const { PreviewCheck } = await import('@agent/preview-check');
const { applyOperations } = await import('@engine/apply');

type Turn = (req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>;
/** Replays scripted turns, keeping each request. */
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
const calls = (...list: Array<[string, string, unknown]>): ModelEvent[] => [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: list.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })) }];
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [] }];
/** The result the model was sent for call `id`, in the request it was sent with. */
const resultOf = (req: CanonicalModelRequest | undefined, id: string) => {
  const item = req?.items.find((i) => i.kind === 'tool_result' && (i as { callId?: string }).callId === id) as { content: string } | undefined;
  return item ? (JSON.parse(item.content) as Record<string, unknown>) : undefined;
};

const dirs: string[] = [];
const closing: Array<() => Promise<unknown>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-asking-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of closing.splice(0)) await c().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

type Attaching = { attach(s: unknown, workspace: object, runtime: object): Promise<void> };
const URL = 'https://example.com/builder';
const urlEdit: EditOperation[] = [{ type: 'site.update', baseUrl: URL }];
const seen = (state: Parameters<typeof readFields>[0], ops: EditOperation[]) => readFields(state, ops)!.map((r) => (r.found ? r.value : undefined));

/** A project open in a controller, with the assistant wired to it as the app wires it (src/main/index.ts). */
async function setup(turns: Turn[]) {
  const dir = join(temp('project'), 'site');
  await (await ProjectSession.create(dir, createStarterState('business', 'Persist', false))).close();
  const session = await ProjectSession.open(dir, 'this-window');
  const c = new Controller(() => null);
  closing.push(() => c.close());
  c.send = () => undefined;
  await (c as unknown as Attaching).attach(session, {}, { state: 'error', message: 'No preview in this test.' });
  await c.startingVersion;
  const adapter = new FakeAdapter(turns);
  const events: AiEvent[] = [];
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => events.push(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  c.aiBusy = () => orch.editing;
  c.aiRunId = () => (orch.editing ? orch.runId : null);
  c.admitSave = (runId) => orch.admitSave(runId);
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  const send = async (text: string, delegation?: Parameters<InstanceType<typeof Orchestrator>['send']>[4]) => {
    // A guest's request is limited to the page it was sent from, as a live session sends it.
    const r = await orch.send(text, delegation ? { ...ctx, mode: 'edit', scope: 'page' } : ctx, undefined, undefined, delegation);
    expect(r.ok).toBe(true);
    return r.runId!;
  };
  const lastStatus = () => [...events].reverse().find((e) => e.kind === 'status');
  /** Wait until the request waits for its `n`th answer: that question. */
  const asked = async (n = 1) => {
    const q = () => [...events].reverse().find((e) => e.message?.questions?.length === n && !e.message.questions[n - 1].answered)?.message?.questions?.[n - 1];
    for (let i = 0; i < 500 && !(q() && lastStatus()?.status === 'awaiting-input'); i++) await new Promise((res) => setTimeout(res, 10));
    expect(q()).toBeDefined();
    return q()!;
  };
  const ended = async () => {
    while (orch.busy) await new Promise((res) => setTimeout(res, 10));
    return [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result;
  };
  return { dir, c, session, orch, adapter, events, send, asked, ended, lastStatus };
}

/** The AI renames the site, then asks a question. */
const renameThenAsk = (s: () => InstanceType<typeof ProjectSession>): Turn[] => [
  () => calls(['a1', 'apply_operations', { expectedRevision: s().revision, operations: [{ type: 'site.update', name: 'AI name' }] }]),
  () => calls(['q1', 'request_clarification', { question: 'Which tone should the site take?', choices: ['Warm', 'Brisk'] }])
];

describe('Save now while the AI waits for an answer (#1281)', () => {
  it('saves the Public URL, keeps the AI waiting, and tells the model of the edit with the answer', async () => {
    let told: Record<string, unknown> | undefined;
    const env: Awaited<ReturnType<typeof setup>> = await setup([
      ...renameThenAsk(() => env.session),
      (req) => {
        told = resultOf(req, 'q1');
        return finish('Done.');
      }
    ]);
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Rename the site');
    const q = await env.asked();
    expect(env.lastStatus()).toMatchObject({ status: 'awaiting-input', saveable: true });
    expect((await env.orch.readConversation(env.orch.conversation!.id)).run).toMatchObject({ runId, saveable: true });
    const opening = (env.c as unknown as { workspaceKey: string }).workspaceKey;
    // Made in an earlier opening of the project: never saved into this one.
    expect(await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings', opening: `${opening}-earlier` })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(env.session.state.site.baseUrl).not.toBe(URL);
    const r = await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings', opening });
    expect(r.ok).toBe(true);
    // Saved, and the request still waits for the answer.
    expect(env.session.state.site).toMatchObject({ name: 'AI name', baseUrl: URL });
    expect(env.orch.runId).toBe(runId);
    expect(env.lastStatus()).toMatchObject({ status: 'awaiting-input' });
    expect(env.orch.answer(runId, q.id!, 'Warm')).toBe(true);
    const result = await env.ended();
    expect(result?.status).toBe('completed');
    // The answer names what the author changed, so the model reads it before writing there.
    expect(told).toMatchObject({ ok: true, answer: 'Warm', authorEdits: [`Update site settings in Site settings (site.update: baseUrl = "${URL}")`] });
    expect(told?.note).toMatch(/read what they changed again/);
    // Two steps: the author's, then the AI's, which never holds the URL.
    expect(env.session.historyInfo().entries.slice(-2).map((e) => e.source)).toEqual(['user', 'ai']);
    expect((await env.session.undo()).ok).toBe(true);
    expect(env.session.state.site).toMatchObject({ name: 'Persist', baseUrl: URL });
  });

  it('keeps the saved URL when the request is stopped afterwards, and undoes the AI’s change', async () => {
    const env: Awaited<ReturnType<typeof setup>> = await setup(renameThenAsk(() => env.session));
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Rename the site');
    await env.asked();
    expect((await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings' })).ok).toBe(true);
    expect(await env.orch.stopRun(runId)).toMatchObject({ stopped: true, status: 'cancelled' });
    expect(env.session.state.site).toMatchObject({ name: 'Persist', baseUrl: URL });
    expect(existsSync(join(env.dir, '.siteorigin/sessions/active-run.json'))).toBe(false);
  });

  it('gives the model the edit even when the answer comes while it is being saved', async () => {
    let told: Record<string, unknown> | undefined;
    const env: Awaited<ReturnType<typeof setup>> = await setup([
      ...renameThenAsk(() => env.session),
      (req) => {
        told = resultOf(req, 'q1');
        return finish('Done.');
      }
    ]);
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Rename the site');
    const q = await env.asked();
    const saving = env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings' });
    // Answered before the save has answered: the model hears the answer once the save is in, and no other save is let in
    // meanwhile, which the editor hears at once.
    expect(env.orch.answer(runId, q.id!, 'Brisk')).toBe(true);
    expect(env.lastStatus()).toMatchObject({ status: 'awaiting-input' });
    expect(env.lastStatus()).not.toHaveProperty('saveable');
    const describe = [{ type: 'site.update', description: 'Also mine' }] as EditOperation[];
    expect(await env.c.saveWhileAsking({ operations: describe }, { runId, base: seen(env.session.state, describe), label: 'Update site settings' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect((await saving).ok).toBe(true);
    await env.ended();
    expect(told).toMatchObject({ answer: 'Brisk', authorEdits: [expect.stringContaining('baseUrl')] });
    expect(told?.authorEdits).toHaveLength(1);
    expect(env.session.state.site.description).not.toBe('Also mine');
  });

  it('refuses once the question is answered, and the next question hears nothing of an earlier one’s edit', async () => {
    let second: Record<string, unknown> | undefined;
    const env: Awaited<ReturnType<typeof setup>> = await setup([
      ...renameThenAsk(() => env.session),
      () => calls(['q2', 'request_clarification', { question: 'And the colours?', choices: ['Bright', 'Muted'] }]),
      (req) => {
        second = resultOf(req, 'q2');
        return finish('Done.');
      }
    ]);
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Rename the site');
    const q = await env.asked();
    expect((await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings' })).ok).toBe(true);
    expect(env.orch.answer(runId, q.id!, 'Warm')).toBe(true);
    // Answered: the request may be working again, so an edit waits for it as before.
    expect(await env.c.saveWhileAsking({ operations: [{ type: 'site.update', baseUrl: 'https://late.example' }] }, { runId, base: seen(env.session.state, urlEdit), label: 'Update site settings' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    const q2 = await env.asked(2);
    expect(env.orch.answer(runId, q2.id!, 'Muted')).toBe(true);
    await env.ended();
    expect(second).toEqual(expect.objectContaining({ answer: 'Muted' }));
    expect(second).not.toHaveProperty('authorEdits');
    expect(second).not.toHaveProperty('note');
    expect(env.session.state.site.baseUrl).toBe(URL);
  });

  it('skips a change the model queued after the question, which was planned before it knew of the edit', async () => {
    let skipped: Record<string, unknown> | undefined;
    let fresh: Record<string, unknown> | undefined;
    const env: Awaited<ReturnType<typeof setup>> = await setup([
      () =>
        calls(
          ['q1', 'request_clarification', { question: 'Which tone?', choices: ['Warm', 'Brisk'] }],
          // A tool that writes at the project's current revision, which no stale revision would turn away.
          ['a1', 'update_site_seo', { baseUrl: 'https://ai.example' }]
        ),
      (req) => {
        skipped = resultOf(req, 'a1');
        // Having read what the author changed, the model's next change goes through.
        return calls(['a2', 'update_site_seo', { description: 'Written after reading' }]);
      },
      (req) => {
        fresh = resultOf(req, 'a2');
        return finish('Done.');
      }
    ]);
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Set the address');
    const q = await env.asked();
    expect((await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings' })).ok).toBe(true);
    expect(env.orch.answer(runId, q.id!, 'Warm')).toBe(true);
    await env.ended();
    expect(skipped).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(fresh).toMatchObject({ ok: true });
    expect(env.session.state.site.baseUrl).toBe(URL);
    expect(env.session.state.site.description).toBe('Written after reading');
  });

  it('stays off a live-session guest’s request, whose model the host’s saves would reach', async () => {
    const env = await setup([() => calls(['q1', 'request_clarification', { question: 'Which tone?', choices: ['Warm', 'Brisk'] }])]);
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Retone the page', { guestName: 'Ann', grantId: 'grant-1', accept: () => null, check: () => null });
    await env.asked();
    expect(env.lastStatus()).toMatchObject({ status: 'awaiting-input' });
    expect(env.lastStatus()).not.toHaveProperty('saveable');
    expect(await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(env.session.state.site.baseUrl).not.toBe(URL);
    await env.orch.stopRun(runId);
  });

  it('stays off the app’s own question about where a form sends, whose grant the save would void (#1130)', async () => {
    const EVIL = 'https://evil.example/f';
    const env: Awaited<ReturnType<typeof setup>> = await setup([() => calls(['f1', 'apply_operations', { expectedRevision: env.session.revision, operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }] }]), () => finish('Done.')]);
    const owner = { kind: 'page' as const, id: env.session.state.site.homePageId };
    const placed = await env.session.apply({ operations: [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/sales' } }] }, { label: 'Add a form' });
    const form = placed.results![0].nodeId as string;
    const typed = seen(env.session.state, urlEdit);
    const runId = await env.send('Change the form');
    const q = await env.asked();
    expect(q.formRouting).toBeDefined();
    expect(env.lastStatus()).toMatchObject({ status: 'awaiting-input' });
    expect(env.lastStatus()).not.toHaveProperty('saveable');
    // A window reading the thread again hears the same.
    const read = await env.orch.readConversation(env.orch.conversation!.id);
    expect(read.run).toMatchObject({ runId, status: 'awaiting-input' });
    expect(read.run).not.toHaveProperty('saveable');
    const before = env.session.revision;
    expect(await env.c.saveWhileAsking({ operations: urlEdit }, { runId, base: typed, label: 'Update site settings' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(env.session.revision).toBe(before);
    // The author's Allow still lands the change it was asked about.
    expect(env.orch.answer(runId, q.id!, q.choices[1])).toBe(true);
    await env.ended();
    expect((env.session.state.pages[owner.id].nodes[form] as { props: Record<string, unknown> }).props.endpoint).toBe(EVIL);
  });
});

describe('a page a skipped change would have made (#1281)', () => {
  it('is the page an upsert names when no page has its address yet', () => {
    const state = createStarterState('business', 'Persist', false);
    expect(upsertCreatesIn(JSON.stringify({ slug: 'services', title: 'Our services' }), state)).toEqual([{ title: 'Our services', route: '/services/' }]);
    expect(upsertCreatesIn(JSON.stringify({ slug: '/pricing/' }), state)).toEqual([{ title: 'pricing', route: '/pricing/' }]);
    // An update of a page there already, the Home page, or arguments that say nothing.
    const about = Object.values(state.pages).find((p) => p.title === 'About')!;
    expect(upsertCreatesIn(JSON.stringify({ slug: about.route, title: 'About us' }), state)).toEqual([]);
    expect(upsertCreatesIn(JSON.stringify({ slug: 'home' }), state)).toEqual([]);
    expect(upsertCreatesIn('{not json', state)).toEqual([]);
  });
});

describe('a preview check after the author saved while the AI waited (#1281)', () => {
  it('never holds the run to what the author changed on a page it measured before', async () => {
    const state = createStarterState('business', 'Persist', false);
    const home = state.pages[state.site.homePageId];
    const hero = Object.values(home.nodes).find((n) => n.kind === 'instance' && typeof (n as { props: Record<string, unknown> }).props.heading === 'string')!;
    const edit = (value: string): EditOperation[] => [{ type: 'instance.setProp', owner: { kind: 'page', id: home.id }, nodeId: hero.id, prop: 'heading', value }];
    const clean = { ok: true, report: { documentWidth: 1280, viewportWidth: 1280, issues: [] } };
    const wide = { ok: true, report: { documentWidth: 1600, viewportWidth: 1280, issues: [{ kind: 'horizontal-overflow', message: 'The page is wider than the screen.' }] } };
    /** A run that measured the home page, then changed its heading. */
    const measuredRun = async () => {
      const preview = new PreviewCheck(state, 'Improve the home page', 1280);
      await preview.beforeApply(edit('AI heading'), state, async () => clean, () => undefined);
      const after = applyOperations(state, edit('AI heading')).state;
      preview.landed(edit('AI heading'), state, after);
      const keys = [...(preview as unknown as { baselines: Map<string, unknown> }).baselines.keys()].filter((k) => k.startsWith(`${home.id}\n`));
      expect(keys.length).toBeGreaterThan(0);
      return { preview, after, viewport: keys[0].split('\n')[1] as never };
    };
    // A page the run left too wide is the run's to repair.
    const own = await measuredRun();
    expect(own.preview.introduced(own.after, [{ pageId: home.id, viewport: own.viewport, m: wide }])).toHaveLength(1);
    // The same page, once the author saved an edit of their own on it: what is found there is not sent back to the run.
    const run = await measuredRun();
    const mine = [{ type: 'page.update', pageId: home.id, seoTitle: 'Mine' }, ...edit('Author heading')] as EditOperation[];
    const saved = applyOperations(run.after, mine).state;
    expect([...run.preview.authorSaved(mine, run.after, saved).pages]).toContain(home.id);
    expect(run.preview.introduced(saved, [{ pageId: home.id, viewport: run.viewport, m: wide }])).toEqual([]);
  });
});
