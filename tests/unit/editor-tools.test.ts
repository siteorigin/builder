/**
 * Chat can step the editor's History and change its preview controls (#1405): "Undo my last change" takes the same step
 * the toolbar's Undo does, recorded as the author's, and "Switch to phone view in dark colors" changes the toolbar's
 * width and colors, in a question too, without a revision or a History step.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { PreviewControlResult, PreviewControlSettings } from '@shared/preview-control';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator, type RunDelegation } from '@agent/orchestrator';
import { asksForHistory, asksForPreview, toolsForRun } from '@agent/tools';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function sessionFor() {
  const dir = mkdtempSync(join(tmpdir(), 'so-editor-tools-'));
  dirs.push(dir);
  return ProjectSession.create(dir, structuredClone(createStarterState('business', 'Studio', false)));
}

/** The author renames Home, as the editor would: their own History step. */
const rename = (session: ProjectSession, title: string) => session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title }] }, { label: `Rename Home to ${title}`, source: 'user' });
const homeTitle = (session: ProjectSession) => session.state.pages[session.state.site.homePageId].title;

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 200000, maxOutputTokens: 32000 } as ModelCapabilities;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    for (const ev of turn ? turn(req) : finish('Done.')) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [] }];
const resultOf = (adapter: FakeAdapter, callId: string) => {
  for (const req of adapter.requests) {
    const item = req.items.find((i) => i.kind === 'tool_result' && i.callId === callId) as Extract<CanonicalItem, { kind: 'tool_result' }> | undefined;
    if (item) return JSON.parse(item.content) as Record<string, any>;
  }
  throw new Error(`no result for ${callId}`);
};

/** The editor as the renderer answers set_preview: the controls it now shows. */
function fakeEditor() {
  const asked: PreviewControlSettings[] = [];
  const controlPreview = async (s: PreviewControlSettings): Promise<PreviewControlResult> => {
    asked.push(s);
    return { now: { width: s.viewport === 'phone' ? 390 : 1280, preset: s.viewport ?? 'desktop', scheme: s.scheme ?? 'system', mode: s.mode ?? 'edit', darkPalette: true }, changed: Object.keys(s) as Array<'viewport'>, refused: [] };
  };
  return { asked, controlPreview };
}

function runner(session: ProjectSession, turns: Array<(req: CanonicalModelRequest) => ModelEvent[]>, extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  const adapter = new FakeAdapter(turns);
  const events: AiEvent[] = [];
  const editor = fakeEditor();
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => events.push(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined,
    codeEnabled: async () => false,
    controlPreview: editor.controlPreview,
    ...extra
  });
  const home = session.state.pages[session.state.site.homePageId];
  const ctx: ChatContext = { pageId: home.id, pageTitle: home.title, selection: null, selectionLabel: null, viewport: 1280 };
  const run = async (text: string, over: Partial<ChatContext> = {}, delegation?: RunDelegation) => {
    const r = await orch.send(text, { ...ctx, ...over }, undefined, undefined, delegation);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    while (orch.busy) await new Promise((res) => setTimeout(res, 5));
    return [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result;
  };
  return { adapter, orch, run, editor, events };
}

describe('ProjectSession.stepHistoryForRun', () => {
  it("undoes the author's last change for a run that changed nothing, as the author's own step, and lets go of the project", async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    const entries = session.historyInfo().entries.length;
    expect(await session.beginRun('run_a')).toBeNull();
    const r = await session.stepHistoryForRun('run_a', 'undo', 1);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.label).toBe('Rename Home to Welcome');
    expect(homeTitle(session)).toBe('Home');
    const h = session.historyInfo();
    // Nothing is added to History and nothing taken from it: the step can be redone, from the toolbar too.
    expect(h.entries.length).toBe(entries);
    expect(h.canRedo).toBe(true);
    expect(session.activeRun).toBeNull();
    expect(existsSync(session.local('sessions', 'active-run.json'))).toBe(false);
    expect(await session.completeRun('AI (no changes)')).toBe(false);
    const redo = await session.redo();
    expect(redo.ok).toBe(true);
    expect(homeTitle(session)).toBe('Welcome');
  });

  it('keeps a step that was saved when something after the save throws, never holding the project again over it', async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    await session.beginRun('run_t');
    session.once('history', () => {
      throw new Error('a listener failed');
    });
    const r = await session.stepHistoryForRun('run_t', 'undo', 1);
    expect(r).toMatchObject({ ok: true, label: 'Rename Home to Welcome' });
    // Its rollback would otherwise write Welcome back under a cursor that says it is undone.
    expect(session.activeRun).toBeNull();
    expect((await session.abortRun()).restored).toBe(false);
    expect(homeTitle(session)).toBe('Home');
    expect((await session.redo()).ok).toBe(true);
    expect(homeTitle(session)).toBe('Welcome');
  });

  it('refuses once the project moved on from where the run started, though the run itself changed nothing', async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    await session.beginRun('run_s');
    // As a save of the author's while the run waited moves it (saveWhileAsking rebases the checkpoint with it).
    (session as unknown as { revision: number }).revision += 1;
    const r = await session.stepHistoryForRun('run_s', 'undo', 1);
    expect(r.error?.code).toBe('STALE_REVISION');
    expect(homeTitle(session)).toBe('Welcome');
    expect(session.activeRun?.id).toBe('run_s');
  });

  it('takes several steps at once, and refuses more than History has', async () => {
    const session = await sessionFor();
    await rename(session, 'One');
    await rename(session, 'Two');
    await session.beginRun('run_b');
    const tooMany = await session.stepHistoryForRun('run_b', 'undo', 5);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error?.code).toBe('INVALID_ARGUMENT');
    expect((await session.stepHistoryForRun('run_b', 'redo', 1)).error?.message).toBe('Nothing to redo.');
    // Refused before anything was written: the run still holds the project.
    expect(session.activeRun?.id).toBe('run_b');
    const r = await session.stepHistoryForRun('run_b', 'undo', 2);
    expect(r.ok).toBe(true);
    expect(homeTitle(session)).toBe('Home');
  });

  it('refuses a run that already changed the site, another run, and nothing to undo, changing nothing', async () => {
    const session = await sessionFor();
    await session.beginRun('run_c');
    expect((await session.stepHistoryForRun('run_c', 'undo', 1)).error?.code).toBe('INVALID_ARGUMENT');
    expect(session.activeRun?.id).toBe('run_c');
    expect((await session.stepHistoryForRun('run_other', 'undo', 1)).error?.code).toBe('CONFLICT');
    await session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'By the AI' }] }, { label: 'AI', source: 'ai', runId: 'run_c', history: false });
    const r = await session.stepHistoryForRun('run_c', 'undo', 1);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CONFLICT');
    expect(homeTitle(session)).toBe('By the AI');
    expect(session.activeRun?.id).toBe('run_c');
  });
});

describe('Chat undoes and redoes (#1405)', () => {
  it('"Undo my last change" steps History once, reports it, and changes nothing more', async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    const { adapter, run } = runner(session, [
      () => [call('c1', 'step_history', { direction: 'undo' })],
      // The model tries to change something else too, and to step again: the request already made its one change.
      () => [call('c2', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'Again' }] })],
      () => [call('c3', 'step_history', { direction: 'undo' })],
      () => finish('I undid "Rename Home to Welcome".')
    ]);
    const result = await run('Undo my last change');
    expect(adapter.requests[0].tools.map((t) => t.name)).toContain('step_history');
    expect(resultOf(adapter, 'c1')).toMatchObject({ ok: true, direction: 'undo', label: 'Rename Home to Welcome' });
    expect(resultOf(adapter, 'c2')).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: false } });
    expect(resultOf(adapter, 'c3')).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: false } });
    expect(resultOf(adapter, 'c3').error.message).toMatch(/already undid "Rename Home to Welcome"/);
    // The model is told what Undo would take back before it calls it, as data (a guest's edit may have named it), never
    // in the tool's instructions.
    const context = JSON.parse(/<editor_context>\n([\s\S]*)\n<\/editor_context>/.exec((adapter.requests[0].items.at(-1) as { text: string }).text)![1]);
    expect(context.history).toEqual({ undoTakesBack: 'Rename Home to Welcome', redoPutsBack: null });
    expect(JSON.stringify(adapter.requests[0].tools)).not.toContain('Rename Home to Welcome');
    expect(homeTitle(session)).toBe('Home');
    expect(result?.status).toBe('completed');
    expect(result?.changes.map((c) => c.label)).toEqual(['Undid "Rename Home to Welcome"']);
    // The step is the author's in History, redone from the toolbar, never this turn's to undo.
    expect(result?.canUndo).toBe(false);
    expect(session.activeRun).toBeNull();
    expect(session.historyInfo().canRedo).toBe(true);
    // The system prompt says to use the tool, not to point at a shortcut.
    expect(adapter.requests[0].system).toContain('call step_history');
  });

  it('refuses for good a change sent beside the step in the same response, never asking for it again', async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    const both: ModelEvent = { type: 'done', stopReason: 'tool_use', text: '', toolCalls: [
      { id: 'c1', name: 'step_history', arguments: JSON.stringify({ direction: 'undo' }) },
      { id: 'c2', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: session.revision + 1, operations: [{ type: 'page.create', title: 'Contact', route: '/contact/' }] }) }
    ] };
    const { adapter, run } = runner(session, [() => [both], () => finish('Undid the rename; the Contact page needs a new message.')]);
    const result = await run('Undo that, then create a Contact page');
    expect(resultOf(adapter, 'c2')).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: false } });
    expect(adapter.requests).toHaveLength(2);
    expect(result?.status).toBe('completed');
    expect(result?.changes.map((c) => c.label)).toEqual(['Undid "Rename Home to Welcome"']);
    // The page the request also asked for is named as not made.
    expect(result?.checks?.map((c) => c.text).join(' ')).toMatch(/Contact.*was not created/);
  });

  it('redoes in a later request', async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    await session.undo();
    const { adapter, run } = runner(session, [() => [call('c1', 'step_history', { direction: 'redo' })], () => finish('Redone.')]);
    const result = await run('Redo that');
    expect(resultOf(adapter, 'c1')).toMatchObject({ ok: true, direction: 'redo', label: 'Rename Home to Welcome' });
    expect(homeTitle(session)).toBe('Welcome');
    expect(result?.changes.map((c) => c.label)).toEqual(['Redid "Rename Home to Welcome"']);
  });

  it('is not offered to a question, nor to a guest in a live session', async () => {
    const session = await sessionFor();
    await rename(session, 'Welcome');
    const ask = runner(session, [() => finish('Use Undo.')]);
    await ask.run('Undo my last change', { mode: 'ask' });
    expect(ask.adapter.requests[0].tools.map((t) => t.name)).not.toContain('step_history');
    const guest = runner(session, [() => finish('Done.')]);
    await guest.run('Undo my last change', { mode: 'edit', scope: 'page' }, { guestName: 'Ann', grantId: 'grant-1', accept: () => null, check: () => null });
    const names = guest.adapter.requests[0].tools.map((t) => t.name);
    expect(names).not.toContain('step_history');
    expect(names).not.toContain('set_preview');
    expect(homeTitle(session)).toBe('Welcome');
  });
});

describe('Chat switches the preview controls (#1405)', () => {
  it('in a question, without a revision or a History step', async () => {
    const session = await sessionFor();
    const revision = session.revision;
    const entries = session.historyInfo().entries.length;
    const { adapter, run, editor } = runner(session, [() => [call('c1', 'set_preview', { viewport: 'phone', scheme: 'dark' })], () => finish('The preview is at phone width in dark colors.')]);
    const result = await run('Switch to phone view and turn on dark mode preview', { mode: 'ask' });
    expect(adapter.requests[0].tools.map((t) => t.name)).toContain('set_preview');
    expect(editor.asked).toEqual([{ viewport: 'phone', scheme: 'dark' }]);
    expect(resultOf(adapter, 'c1')).toMatchObject({ ok: true, now: { width: 390, preset: 'phone', scheme: 'dark' } });
    expect(session.revision).toBe(revision);
    expect(session.historyInfo().entries.length).toBe(entries);
    expect(result?.status).toBe('no-changes');
    expect(adapter.requests[0].system).toContain('call set_preview');
  });

  it('in an edit request, which keeps the project unchanged and nothing to undo', async () => {
    const session = await sessionFor();
    const revision = session.revision;
    const { adapter, run, editor } = runner(session, [() => [call('c1', 'set_preview', { mode: 'preview', width: 600 })], () => finish('Previewing.')]);
    const result = await run('Preview it at 600px');
    expect(resultOf(adapter, 'c1').ok).toBe(true);
    expect(editor.asked).toEqual([{ width: 600, mode: 'preview' }]);
    expect(session.revision).toBe(revision);
    expect(result?.canUndo).toBe(false);
  });

  it('says the editor refused, rather than claiming a change', async () => {
    const session = await sessionFor();
    const controlPreview = async (): Promise<PreviewControlResult> => ({ now: { width: 1280, preset: 'desktop', scheme: 'system', mode: 'edit', darkPalette: false }, changed: [], refused: [{ setting: 'scheme', reason: 'This site has a single color palette.' }] });
    const { adapter, run } = runner(session, [() => [call('c1', 'set_preview', { scheme: 'dark' })], () => finish('This site has no dark colors.')], { controlPreview });
    await run('Dark mode please', { mode: 'ask' });
    expect(resultOf(adapter, 'c1')).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'This site has a single color palette.' } });
  });

  it('is offered only when the app can run it, after whatever task chose the rest', () => {
    const state = createStarterState('business', 'Studio', false);
    const base = { state, selection: null, capabilities: { toolCalling: 'native' as const, contextWindowTokens: 12_288 }, codeEnabled: false, definitionOps: false };
    expect(toolsForRun(base).tools.map((t) => t.name)).not.toContain('set_preview');
    const mine = (r: ReturnType<typeof toolsForRun>) => r.tools.map((t) => t.name).filter((n) => n === 'set_preview' || n === 'step_history');
    const both = { preview: true, history: true };
    // A larger model always has them; a question never steps History.
    const cloud = { ...base, capabilities: { toolCalling: 'native' as const, contextWindowTokens: 200_000 } };
    expect(mine(toolsForRun({ ...cloud, editor: both }))).toEqual(['set_preview', 'step_history']);
    expect(mine(toolsForRun({ ...cloud, ask: true, editor: both }))).toEqual(['set_preview']);
    // A small model's window is kept for the rest unless the request asks for them.
    expect(mine(toolsForRun({ ...base, editor: { ...both, asked: { preview: false, history: false } } }))).toEqual([]);
    expect(mine(toolsForRun({ ...base, editor: { ...both, asked: { preview: false, history: true } } }))).toEqual(['step_history']);
    expect(mine(toolsForRun({ ...base, ask: true, editor: { ...both, asked: { preview: true, history: true } } }))).toEqual(['set_preview']);
    expect(toolsForRun({ ...base, editor: { ...both, asked: { preview: true, history: true } } }).tools.map((t) => t.name).slice(-2)).toEqual(['set_preview', 'step_history']);
  });

  it('knows a request for the preview or for Undo when it sees one', () => {
    for (const t of ['Switch to phone view and turn on dark mode preview', 'Show me this at 768px', 'Go back to Edit mode', 'What does it look like on mobile?']) expect(asksForPreview(t), t).toBe(true);
    for (const t of ['Show me this on an iPhone', 'How does it look on desktop?']) expect(asksForPreview(t), t).toBe(true);
    for (const t of ['Undo my last change', 'Revert that', 'Put it back', 'redo', 'Go back one step']) expect(asksForHistory(t), t).toBe(true);
    for (const t of ['Add a pricing section', 'Rewrite the about page']) {
      expect(asksForPreview(t), t).toBe(false);
      expect(asksForHistory(t), t).toBe(false);
    }
  });
});
