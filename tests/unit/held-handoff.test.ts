import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext, ProjectSnapshot, RunStatus } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { saveStatusAnnouncement as saveAnnouncement } from '../../src/renderer/src/lib/announce';

/**
 * The "Stop AI and apply my edit" handoff end to end: the renderer store, talking through a stand-in for
 * the preload bridge to a real orchestrator and project session, so cancellation and rollback are real.
 */

type Turn = (req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>;

class FakeAdapter implements AgentModelAdapter {
  constructor(private turns: Turn[]) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 };
  }
  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
      return;
    }
    const events = await turn(req);
    for (const ev of events) {
      if (signal.aborted) {
        yield { type: 'error', code: 'cancelled', message: 'Cancelled' };
        return;
      }
      yield ev;
    }
  }
}

const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }];
const aiEdit = (id: string, operations: unknown[]) => call(id, 'apply_operations', { expectedRevision: 0, scope: { kind: 'site', targetIds: [] }, operations });

const gates: Array<() => void> = [];

/** A model turn that waits until the test releases it: the AI is "in the middle of" its request. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  gates.push(release);
  const turn: Turn = async () => {
    await opened;
    return call('g', 'read_project', {});
  };
  return { turn, release };
}

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** What the test uses of the renderer store. The store is renderer code (it reads `window`), outside
 *  the Node type-check project, so it is loaded by path at run time rather than imported for its types. */
interface Held {
  id: number;
  seq: number;
  phase: string;
  label: string;
  place: string;
  text: string | null;
  currentText?: string | null;
  note?: string;
}
interface StoreState {
  snapshot: ProjectSnapshot | null;
  heldEdits: Held[];
  aiOutcome: { run: RunStatus | null; runId?: string; edit?: 'saved' | 'held' } | null;
  runStatus: RunStatus | null;
  runMode: 'ask' | 'edit' | null;
  pendingSave: number;
  toasts: Array<{ action?: { label: string } }>;
}
interface StoreModule {
  applyOps(operations: EditOperation[], label: string): Promise<unknown>;
  applyHeld(id: number, opts?: { replace?: boolean; stopRunId?: string }): Promise<void>;
  discardHeld(id: number): void;
  commitDraft(base: ProjectSnapshot | null, commit: () => void, text?: string | null, opts?: { check?: boolean }): void;
  holdEdit(base: ProjectSnapshot, operations: EditOperation[], label: string, opts?: { text?: string | null; seq?: number }): { id: number | null } | null;
  applyAiEvent(e: AiEvent): void;
  aiActivity(): number;
  getState(): StoreState;
  setState(patch: Partial<StoreState>): void;
  useStore: { subscribe(fn: (s: StoreState, prev: StoreState) => void): () => void };
}
const STORE_PATH = '../../src/renderer/src/store';
let store: StoreModule;
let current: { session: ProjectSession; orch: Orchestrator; dir: string } | null = null;
const stopCalls: string[] = [];
let applyCalls = 0;
/** Runs once, just before the next write reaches the session: something that happens meanwhile. */
let beforeApply: (() => Promise<void> | void) | null = null;
const dirs: string[] = [];

function snapshot(): ProjectSnapshot | null {
  if (!current) return null;
  const { session, orch, dir } = current;
  // As the controller reports it: only a request that may change the site holds the project.
  return { dir, workspaceKey: `${dir}#1`, state: structuredClone(session.state), revision: session.revision, aiBusy: orch.editing, aiRunId: orch.editing ? orch.runId : null, conflicts: [] } as unknown as ProjectSnapshot;
}

beforeAll(async () => {
  // The preload bridge, as the renderer sees it, backed by the real session and orchestrator.
  (globalThis as unknown as { window: unknown }).window = {
    builder: {
      platform: 'test',
      ai: {
        stop: (runId?: string) => {
          if (!current) return Promise.resolve();
          if (runId) stopCalls.push(runId);
          return runId ? current.orch.stopRun(runId) : Promise.resolve(current.orch.stop());
        }
      },
      project: {
        snapshot: async () => snapshot(),
        apply: (batch: { operations: EditOperation[]; expectedRevision?: number }, opts?: { label?: string; coalesceKey?: string; opening?: string }) => {
          applyCalls++;
          const meanwhile = beforeApply;
          beforeApply = null;
          if (meanwhile) return Promise.resolve(meanwhile()).then(() => current!.session.apply(batch, { label: opts?.label ?? 'Edit', coalesceKey: opts?.coalesceKey, source: 'user' }));
          if (opts?.opening !== undefined && opts.opening !== `${current!.dir}#1`) return Promise.resolve({ ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'That project is no longer open.' } });
          // As the controller does: the AI owns the project from the moment it starts.
          if (current!.orch.editing) return Promise.resolve({ ok: false, revision: current!.session.revision, error: { code: 'BUSY', message: 'The AI is making changes.' } });
          return current!.session.apply(batch, { label: opts?.label ?? 'Edit', coalesceKey: opts?.coalesceKey, source: 'user' });
        }
      }
    }
  };
  store = (await import(/* @vite-ignore */ STORE_PATH)) as StoreModule;
});

afterEach(async () => {
  gates.splice(0).forEach((release) => release());
  if (current) {
    current.orch.stop();
    const orch = current.orch;
    await until(() => !orch.busy, 'the request to end');
  }
  await current?.session.close().catch(() => undefined);
  current = null;
  stopCalls.length = 0;
  applyCalls = 0;
  beforeApply = null;
  store.setState({ snapshot: null, heldEdits: [], aiOutcome: null, runStatus: null, pendingSave: 0 });
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function setup(turns: Turn[]) {
  const dir = mkdtempSync(join(tmpdir(), 'so-held-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const adapter = new FakeAdapter(turns);
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    // Events and snapshots reach the store as they reach the renderer.
    emit: (e: AiEvent) => store.applyAiEvent(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => store.setState({ snapshot: snapshot() })
  });
  current = { session, orch, dir };
  store.setState({ snapshot: snapshot() });
  const about = Object.values(session.state.pages).find((p) => p.title === 'About')!.id;
  const ctx: ChatContext = { pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, viewport: 1280 };
  const send = async (text: string, mode?: 'ask') => {
    const r = await orch.send(text, { ...ctx, ...(mode ? { mode } : {}) });
    expect(r.ok).toBe(true);
    return r.runId!;
  };
  return { session, orch, dir, about, send };
}

const statusOf = () => store.getState().runStatus;
const browserTitle = (pageId: string, value: string): EditOperation => ({ type: 'page.update', pageId, seoTitle: value });

/** Commit a typed edit, as a text field does when it is left. */
async function typeAndCommit(op: EditOperation, label: string, text: string | null = null, base = store.getState().snapshot, check = false) {
  let result: Promise<unknown> = Promise.resolve();
  store.commitDraft(base, () => (result = store.applyOps([op], label)), text, { check });
  return result;
}

/** The author commits a typed field while the AI works: the edit is held, not saved and not dropped. */
async function commitWhileBusy(op: EditOperation, label = 'Change browser title') {
  expect(store.getState().snapshot?.aiBusy).toBe(true);
  expect(await typeAndCommit(op, label)).toBeNull();
  const held = store.getState().heldEdits.at(-1)!;
  expect(held).toMatchObject({ phase: 'waiting', label });
  return held;
}

/** "Stop AI and apply my edit", for the request the row shows. */
const stopAndApply = (id: number) => store.applyHeld(id, { stopRunId: store.getState().snapshot!.aiRunId! });

const outcomeText = () => saveAnnouncement('working', 'saved', store.getState().aiOutcome);

describe('Stop AI and apply my edit', () => {
  it('saves an edit typed while a read-only question runs, never holding it or treating the question as an edit (#203)', async () => {
    const g = gate();
    const { session, orch, about, send } = await setup([g.turn, () => [{ type: 'done', stopReason: 'end', text: 'The title is set.', toolCalls: [] }]]);
    const before = store.aiActivity();
    await send('What is the browser title of About?', 'ask');
    await until(() => statusOf() === 'running', 'the question to start');
    expect(store.getState().runMode).toBe('ask');
    expect(store.getState().snapshot?.aiBusy).toBe(false);
    // Typed after the question started, so a field would check whether the AI had run since it began.
    await typeAndCommit(browserTitle(about, 'Typed meanwhile'), 'Change browser title', 'Typed meanwhile', store.getState().snapshot, store.aiActivity() !== before);
    expect(store.getState().heldEdits).toEqual([]);
    expect(session.state.pages[about].seo.title).toBe('Typed meanwhile');
    g.release();
    await until(() => !orch.busy && statusOf() === null, 'the question to end');
    expect(store.aiActivity()).toBe(before);
    expect(store.getState().runMode).toBeNull();
    expect(store.getState().aiOutcome).toBeNull();
  });

  it('applies an edit made while the AI waits for an answer, after the request is cancelled (issue #177)', async () => {
    const { session, about, send, dir } = await setup([() => call('q', 'request_clarification', { question: 'Formal or conversational?', choices: ['Formal', 'Conversational'] })]);
    const before = session.state.pages[about].seo.title;
    const runId = await send('Offer formal and conversational choices before editing');
    await until(() => statusOf() === 'awaiting-input', 'the clarification');
    store.setState({ snapshot: snapshot() });

    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    expect(held.text).toBe('Meet our design team');
    expect(held.place).toBe('About');
    // Held, not written: the request still owns the project.
    expect(session.state.pages[about].seo.title).toBe(before);

    await stopAndApply(held.id);
    expect(stopCalls).toEqual([runId]);
    expect(store.getState().heldEdits).toEqual([]);
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    // One ordinary edit of the author's, which Undo takes back.
    expect(session.historyInfo().entries).toHaveLength(1);
    expect(store.getState().aiOutcome).toMatchObject({ run: 'cancelled', edit: 'saved' });
    expect(outcomeText()).toBe('AI stopped. Your edit was saved');
    await session.close();
    const again = await ProjectSession.open(dir, 'reopen');
    expect(again.state.pages[about].seo.title).toBe('Meet our design team');
    await again.close();
  });

  it('applies an edit to a field the stopped request did not change, and rolls back the request', async () => {
    const g = gate();
    let aboutId = '';
    const { session, about, send } = await setup([() => aiEdit('d', [{ type: 'page.update', pageId: aboutId, description: 'Written by the AI' }]), g.turn]);
    aboutId = about;
    const original = session.state.pages[about].seo.description;
    await send('Improve the About page');
    await until(() => session.state.pages[about].seo.description === 'Written by the AI', 'the AI edit');
    store.setState({ snapshot: snapshot() });

    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    const applying = stopAndApply(held.id);
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'applying', stopping: true });
    g.release();
    await applying;
    expect(session.state.pages[about].seo.description).toBe(original);
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    expect(store.getState().heldEdits).toEqual([]);
  });

  it('keeps an edit of a field the stopped request had changed, and replaces it only when asked', async () => {
    const g = gate();
    let aboutId = '';
    const { session, about, send } = await setup([() => aiEdit('t', [{ type: 'page.update', pageId: aboutId, seoTitle: 'AI title' }]), g.turn]);
    aboutId = about;
    await send('Retitle the About page');
    await until(() => session.state.pages[about].seo.title === 'AI title', 'the AI edit');
    store.setState({ snapshot: snapshot() });

    // The author saw the AI's title and edited it.
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    const applying = stopAndApply(held.id);
    g.release();
    await applying;
    // Rolled back to the title before the request; the author's draft is kept, not written over it.
    expect(session.state.pages[about].seo.title).toBeUndefined();
    const kept = store.getState().heldEdits[0];
    expect(kept).toMatchObject({ phase: 'changed', text: 'Meet our design team', currentText: '' });
    expect(store.getState().aiOutcome).toMatchObject({ run: 'cancelled', edit: 'held' });
    expect(saveAnnouncement('working', 'held', store.getState().aiOutcome)).toBe('AI stopped. Your edit was not applied. Review it below');

    // Something else changes the field after the author reviewed it: replacing it needs a new review.
    await session.apply({ operations: [browserTitle(about, 'Changed again')] }, { label: 'Other', source: 'user' });
    await store.applyHeld(kept.id, { replace: true });
    expect(session.state.pages[about].seo.title).toBe('Changed again');
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'changed', currentText: 'Changed again' });

    await store.applyHeld(kept.id, { replace: true });
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    expect(store.getState().heldEdits).toEqual([]);
  });

  it('keeps an edit whose target the stopped request had created, and creates nothing', async () => {
    const g = gate();
    const { session, send } = await setup([() => aiEdit('p', [{ type: 'page.create', title: 'Team' }]), g.turn]);
    await send('Add a team page');
    await until(() => Object.values(session.state.pages).some((p) => p.title === 'Team'), 'the new page');
    const team = Object.values(session.state.pages).find((p) => p.title === 'Team')!.id;
    store.setState({ snapshot: snapshot() });

    const held = await commitWhileBusy(browserTitle(team, 'Our people'));
    const applying = stopAndApply(held.id);
    g.release();
    await applying;
    expect(session.state.pages[team]).toBeUndefined();
    expect(Object.values(session.state.pages).some((p) => p.title === 'Team')).toBe(false);
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'gone', note: 'page', text: 'Our people' });
    expect(session.historyInfo().entries).toHaveLength(0);
  });

  it('holds a typed edit against the project as it was when typing began, so a page the AI removed meanwhile gets it back', async () => {
    const g = gate();
    let aboutId = '';
    let homeId = '';
    const { session, about, send } = await setup([() => aiEdit('r', [{ type: 'page.remove', pageId: aboutId, replacementPageId: homeId }]), g.turn]);
    aboutId = about;
    homeId = session.state.site.homePageId;
    // Typing begins while About exists.
    const typingBegan = snapshot();
    await send('Tidy the pages');
    await until(() => !session.state.pages[about], 'the AI to remove About');
    store.setState({ snapshot: snapshot() });

    expect(await typeAndCommit(browserTitle(about, 'Meet our design team'), 'Change browser title', 'Meet our design team', typingBegan)).toBeNull();
    const held = store.getState().heldEdits[0];
    expect(held).toMatchObject({ phase: 'waiting', place: 'About' });

    const applying = stopAndApply(held.id);
    g.release();
    await applying;
    // Stopping restored About; the edit lands there, never on the page the panel moved on to.
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    expect(session.state.pages[session.state.site.homePageId].seo.title).toBeUndefined();
  });

  it('offers "Apply my edit" after the request ends on its own, and stops nothing', async () => {
    const g = gate();
    let aboutId = '';
    const { session, about, send, orch } = await setup([g.turn, () => aiEdit('d', [{ type: 'page.update', pageId: aboutId, description: 'Kept by the AI' }])]);
    aboutId = about;
    await send('Describe the About page');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    g.release();
    await until(() => !orch.busy && store.getState().snapshot?.aiBusy === false, 'the request to finish');
    expect(store.getState().aiOutcome?.run).toBe('completed');

    await store.applyHeld(held.id);
    expect(stopCalls).toEqual([]);
    expect(session.state.pages[about].seo.description).toBe('Kept by the AI');
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    expect(store.getState().aiOutcome).toEqual({ run: null, edit: 'saved' });
    expect(outcomeText()).toBe('Your edit was saved');
  });

  it('ignores the stop reply for a draft discarded while the AI was stopping', async () => {
    const g = gate();
    const { session, about, send } = await setup([g.turn]);
    const runId = await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Never mind'));
    const applying = stopAndApply(held.id);
    store.discardHeld(held.id);
    g.release();
    await applying;
    // The request was stopped as asked; the discarded draft was not written when the stop answered.
    expect(stopCalls).toEqual([runId]);
    expect(store.getState().aiOutcome?.run).toBe('cancelled');
    expect(session.state.pages[about].seo.title).toBeUndefined();
    expect(applyCalls).toBe(0);
    expect(store.getState().heldEdits).toEqual([]);
  });

  it('never stops another request from a row held during an earlier one', async () => {
    const first = gate();
    const { session, about, send, orch } = await setup([first.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    first.release();
    await until(() => !orch.busy, 'the first request to finish');
    const second = gate();
    (orch as unknown as { deps: { adapter: () => Promise<unknown> } }).deps.adapter = async () => ({ adapter: new FakeAdapter([second.turn]), model: 'fake', provider: 'openai' });
    const secondId = await send('Something else');
    store.setState({ snapshot: snapshot() });
    // "Apply my edit" (offered when the row was drawn) stops nothing: the new request keeps working.
    await store.applyHeld(held.id);
    expect(stopCalls).toEqual([]);
    expect(orch.runId).toBe(secondId);
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'waiting', note: 'The AI is working on another request.' });
    expect(session.state.pages[about].seo.title).toBeUndefined();
    // Stopping is only ever for the request the author chose: one that has already ended stops nothing.
    await store.applyHeld(held.id, { stopRunId: 'run_finished' });
    expect(orch.runId).toBe(secondId);
    second.release();
  });

  it('checks again when the project changes between the check and the write', async () => {
    const g = gate();
    const { session, about, send } = await setup([g.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    // Another edit lands after the check: the write is refused as stale, checked again, then made.
    beforeApply = async () => void (await session.apply({ operations: [{ type: 'page.update', pageId: about, description: 'Elsewhere' }] }, { label: 'Other', source: 'user' }));
    const applying = stopAndApply(held.id);
    g.release();
    await applying;
    expect(applyCalls).toBe(2);
    expect(session.state.pages[about].seo).toMatchObject({ title: 'Meet our design team', description: 'Elsewhere' });
    expect(store.getState().heldEdits).toEqual([]);
  });

  it('cannot discard an edit whose save is already on its way', async () => {
    const g = gate();
    const { session, about, send } = await setup([g.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    beforeApply = () => {
      expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'applying', writing: true, stopping: false });
      store.discardHeld(held.id);
      expect(store.getState().heldEdits).toHaveLength(1);
    };
    const applying = stopAndApply(held.id);
    g.release();
    await applying;
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    expect(store.getState().aiOutcome).toMatchObject({ run: 'cancelled', edit: 'saved' });
  });

  it('holds a typed edit whose write main refuses because the AI has just started', async () => {
    const g = gate();
    const { session, about, send } = await setup([g.turn]);
    const idle = snapshot();
    await send('Think about it');
    // The renderer has not heard yet that the AI started.
    store.setState({ snapshot: idle });
    expect(await typeAndCommit(browserTitle(about, 'Meet our design team'), 'Change browser title', 'Meet our design team')).toBeNull();
    expect(applyCalls).toBe(1);
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'waiting', text: 'Meet our design team' });
    store.setState({ snapshot: snapshot() });
    const applying = stopAndApply(store.getState().heldEdits[0].id);
    g.release();
    await applying;
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
  });

  it('reports how a request ended on its own when the stop arrived too late, and still applies the edit', async () => {
    const g = gate();
    const { session, about, send, orch } = await setup([g.turn]);
    const runId = await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    g.release();
    await until(() => !orch.busy, 'the request to finish');
    // The click was for the request the row showed, which has just ended.
    await store.applyHeld(held.id, { stopRunId: runId });
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
    expect(store.getState().aiOutcome).toMatchObject({ run: 'no-changes', edit: 'saved' });
  });

  it('keeps the newest of two commits of a field when the older one comes back refused late', async () => {
    const g = gate();
    const { about, send } = await setup([g.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const second = await commitWhileBusy(browserTitle(about, 'Second'));
    // The first commit was sent before the AI started, and its BUSY reply arrives now.
    expect(store.holdEdit(snapshot()!, [browserTitle(about, 'First')], 'Change browser title', { seq: second.seq - 1, text: 'First' })).toEqual({ id: null });
    expect(store.getState().heldEdits.map((h) => h.text)).toEqual(['Second']);
    // Not even once the newer one is discarded: the author moved on from the older text.
    store.discardHeld(second.id);
    expect(store.holdEdit(snapshot()!, [browserTitle(about, 'First')], 'Change browser title', { seq: second.seq - 1, text: 'First' })).toEqual({ id: null });
    expect(store.getState().heldEdits).toEqual([]);
    // A different field is its own: an older commit of it is held.
    expect(store.holdEdit(snapshot()!, [{ type: 'page.update', pageId: about, description: 'Older' }], 'Change page description', { seq: second.seq - 1 })?.id).toEqual(expect.any(Number));
  });

  it('checks an edit typed while the AI ran and has since finished: applied when its field is as seen, kept when not', async () => {
    const g = gate();
    let aboutId = '';
    const { session, about, send, orch } = await setup([g.turn, () => aiEdit('d', [{ type: 'page.update', pageId: aboutId, seoTitle: 'Kept by the AI' }])]);
    aboutId = about;
    const typingBegan = snapshot();
    await send('Retitle the About page');
    g.release();
    await until(() => !orch.busy && store.getState().snapshot?.aiBusy === false, 'the request to finish');
    // The description was typed from what the author saw; the AI did not change it, so it applies at once.
    expect(await typeAndCommit({ type: 'page.update', pageId: about, description: 'About us' }, 'Change page description', 'About us', typingBegan, true)).toBeNull();
    await until(() => store.getState().heldEdits.length === 0, 'the checked edit to save');
    expect(session.state.pages[about].seo.description).toBe('About us');
    // The browser title was typed over what the AI then replaced: it is kept for review, never written blindly.
    expect(await typeAndCommit(browserTitle(about, 'Meet our design team'), 'Change browser title', 'Meet our design team', typingBegan, true)).toBeNull();
    await until(() => store.getState().heldEdits[0]?.phase === 'changed', 'the check');
    expect(store.getState().heldEdits[0]).toMatchObject({ currentText: 'Kept by the AI' });
    expect(session.state.pages[about].seo.title).toBe('Kept by the AI');
    expect(stopCalls).toEqual([]);
  });

  it('keeps the draft when the stop reaches a request that had already failed', async () => {
    const g = gate();
    const bad = { type: 'page.update', pageId: 'pg_nope', title: 'X' };
    const { session, about, send, orch } = await setup([g.turn, () => aiEdit('f1', [bad]), () => aiEdit('f2', [bad]), () => aiEdit('f3', [bad])]);
    const runId = await send('Rename a page');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    g.release();
    await until(() => !orch.busy, 'the request to fail');
    expect(store.getState().aiOutcome).toMatchObject({ run: 'failed', runId });
    // The click was for that request, which ended failed: whether it undid everything is not known.
    await store.applyHeld(held.id, { stopRunId: runId });
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'failed', text: 'Meet our design team' });
    expect(session.state.pages[about].seo.title).toBeUndefined();
    expect(applyCalls).toBe(0);
    // The author may still choose to apply it, checked as always.
    await store.applyHeld(held.id);
    expect(session.state.pages[about].seo.title).toBe('Meet our design team');
  });

  it('shows the text the author typed, even when the edit stores it inside a structured value', async () => {
    const g = gate();
    const { session, send } = await setup([g.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    const header = session.state.site.shell.header.rootIds[0];
    const op: EditOperation = { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'logo', value: { assetId: null, alt: 'Studio logo' } };
    expect(await typeAndCommit(op, 'Edit Logo', 'Studio logo')).toBeNull();
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'waiting', text: 'Studio logo', place: 'Header' });
  });

  it('replaces an older held edit of the same field, and keeps edits of other fields', async () => {
    const g = gate();
    const { about, send, session } = await setup([g.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    await commitWhileBusy(browserTitle(about, 'First'));
    await commitWhileBusy(browserTitle(about, 'Second'));
    await commitWhileBusy({ type: 'page.update', pageId: about, description: 'About us' }, 'Change page description');
    expect(store.getState().heldEdits.map((h) => h.text)).toEqual(['Second', 'About us']);
    const [title, description] = store.getState().heldEdits;
    const applying = stopAndApply(title.id);
    g.release();
    await applying;
    // The other row waits for its own click: one click applies one edit.
    expect(store.getState().heldEdits.map((h) => h.id)).toEqual([description.id]);
    await store.applyHeld(description.id);
    expect(session.state.pages[about].seo).toMatchObject({ title: 'Second', description: 'About us' });
  });

  it('refuses a gesture as before: only typed field edits are held', async () => {
    const g = gate();
    const { about, send } = await setup([g.turn]);
    await send('Think about it');
    store.setState({ snapshot: snapshot() });
    expect(await store.applyOps([{ type: 'page.remove', pageId: about }], 'Delete page About')).toBeNull();
    // A switch or a reset button writes fields too, but nothing was typed: refused, not held.
    expect(await store.applyOps([{ type: 'page.update', pageId: about, noindex: true }], 'Update page settings')).toBeNull();
    // A typed edit that is not one field (a gesture inside a draft) is refused as well.
    expect(await typeAndCommit({ type: 'page.reorder', pageIds: [...store.getState().snapshot!.state.site.pageOrder].reverse() }, 'Reorder pages')).toBeNull();
    expect(store.getState().heldEdits).toEqual([]);
    expect(store.getState().toasts.at(-1)?.action?.label).toBe('Stop AI');
    expect(applyCalls).toBe(0);
    g.release();
  });
});

describe('Orchestrator.stopRun', () => {
  it('resolves only after the request is rolled back, and never reports it running again', async () => {
    const statuses: RunStatus[] = [];
    const { session, send, orch } = await setup([
      () => aiEdit('p', [{ type: 'page.create', title: 'Temporary' }]),
      () => call('q', 'request_clarification', { question: 'Formal or conversational?', choices: ['Formal', 'Conversational'] })
    ]);
    const runId = await send('Add a page, then ask');
    await until(() => statusOf() === 'awaiting-input', 'the clarification');
    // There is something to roll back.
    expect(Object.values(session.state.pages).some((p) => p.title === 'Temporary')).toBe(true);
    const unsubscribe = store.useStore.subscribe((s, prev) => {
      if (s.runStatus !== prev.runStatus && s.runStatus) statuses.push(s.runStatus);
    });
    const r = await orch.stopRun(runId);
    unsubscribe();
    expect(r).toEqual({ stopped: true, status: 'cancelled' });
    expect(orch.busy).toBe(false);
    expect(Object.values(session.state.pages).some((p) => p.title === 'Temporary')).toBe(false);
    expect(statuses).toEqual(['stopping']);
  });

  it('leaves a request alone when asked to stop another one', async () => {
    const g = gate();
    const { send, orch } = await setup([g.turn]);
    const runId = await send('Think about it');
    expect(await orch.stopRun('run_someother')).toEqual({ stopped: false });
    expect(orch.busy).toBe(true);
    expect(orch.runId).toBe(runId);
    g.release();
    await until(() => !orch.busy, 'the request to finish');
    // It finished on its own, not cancelled.
    expect(store.getState().aiOutcome?.run).toBe('no-changes');
    expect(await orch.stopRun(runId)).toEqual({ stopped: false });
  });

  it('ends a request whose rollback fails, and applies no held edit over what it could not undo', async () => {
    const g = gate();
    const { session, about, send, orch } = await setup([() => aiEdit('p', [{ type: 'page.create', title: 'Temporary' }]), g.turn]);
    await send('Add a page');
    await until(() => Object.values(session.state.pages).some((p) => p.title === 'Temporary'), 'the AI edit');
    store.setState({ snapshot: snapshot() });
    const held = await commitWhileBusy(browserTitle(about, 'Meet our design team'));
    (session as unknown as { abortRun: () => Promise<never> }).abortRun = () => Promise.reject(new Error('disk full'));
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const applying = stopAndApply(held.id);
      g.release();
      await applying;
    } finally {
      console.error = quiet;
    }
    // Nothing waits on "Stopping AI…": the request ended, and the app was told it is idle.
    expect(orch.busy).toBe(false);
    expect(statusOf()).toBeNull();
    expect(store.getState().snapshot?.aiBusy).toBe(false);
    // The draft is kept for the author to decide, and nothing was written.
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'failed', text: 'Meet our design team' });
    expect(applyCalls).toBe(0);
    expect(store.getState().aiOutcome).toMatchObject({ run: 'failed', edit: 'held' });
  });

  it('never reports a request stopped while preparing as running', async () => {
    const statuses: RunStatus[] = [];
    const { send, orch } = await setup([]);
    // Preparing (finding the model) takes a moment, and the stop comes during it.
    const deps = (orch as unknown as { deps: { adapter: () => Promise<unknown> } }).deps;
    const adapter = deps.adapter;
    deps.adapter = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return adapter();
    };
    const unsubscribe = store.useStore.subscribe((s, prev) => {
      if (s.runStatus !== prev.runStatus && s.runStatus) statuses.push(s.runStatus);
    });
    const runId = await send('Think about it');
    const r = await orch.stopRun(runId);
    unsubscribe();
    expect(r).toEqual({ stopped: true, status: 'cancelled' });
    expect(statuses).not.toContain('running');
  });
});
