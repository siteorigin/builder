/**
 * Unsent AI messages stay with the conversation they were written in (issue #11): a new conversation starts empty,
 * returning to a thread restores its draft, a sent message is cleared only from its own thread, and a message is
 * only ever sent to the conversation it was written in.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatContext } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { afterSend, chatStatePatch, cleanDrafts, draftFor, moveDraft, restorePlan, unsentDrafts, withDraft, type ChatDrafts } from '../../src/renderer/src/lib/chatDrafts';

describe('drafts per conversation', () => {
  it('a new conversation starts empty, and returning to the first restores its draft', () => {
    let drafts: ChatDrafts = {};
    drafts = withDraft(drafts, 'c_home', 'Add another photo here');
    // New conversation: its own, empty composer (so the starters show).
    expect(draftFor(drafts, 'c_new')).toBe('');
    drafts = withDraft(drafts, 'c_new', 'Make the footer darker');
    // Switching between earlier threads shows each one's own text.
    expect(draftFor(drafts, 'c_home')).toBe('Add another photo here');
    expect(draftFor(drafts, 'c_new')).toBe('Make the footer darker');
    expect(draftFor(drafts, null)).toBe('');
    // Only a conversation's own entry counts, never anything an object inherits.
    expect(draftFor(drafts, 'constructor')).toBe('');
  });

  it('keeps identical text in two threads apart, and an emptied draft leaves no entry', () => {
    let drafts = withDraft(withDraft({}, 'c_a', 'Same words'), 'c_b', 'Same words');
    expect(drafts).toEqual({ c_a: 'Same words', c_b: 'Same words' });
    drafts = withDraft(drafts, 'c_a', '');
    expect(drafts).toEqual({ c_b: 'Same words' });
    // Whitespace is what was typed, and is kept.
    expect(withDraft(drafts, 'c_b', 'Same words\n')).toEqual({ c_b: 'Same words\n' });
    expect(withDraft(drafts, 'c_b', '  ')).toEqual({ c_b: '  ' });
    expect(withDraft(drafts, 'c_b', 'Same words')).toBe(drafts);
  });

  it('clears a sent message from its own thread only, and never text typed while it was sending', () => {
    const drafts = { c_a: 'Make it warmer', c_b: 'Make it warmer' };
    expect(afterSend(drafts, 'c_a', 'Make it warmer')).toEqual({ c_b: 'Make it warmer' });
    const edited = { ...drafts, c_a: 'Make it warmer, and shorter' };
    expect(afterSend(edited, 'c_a', 'Make it warmer')).toBe(edited);
    const newline = { ...drafts, c_a: 'Make it warmer\n' };
    expect(afterSend(newline, 'c_a', 'Make it warmer')).toBe(newline);
    expect(afterSend(drafts, 'c_gone', 'Make it warmer')).toBe(drafts);
  });

  it('offers drafts of new conversations that were left unsent, and moves one into the conversation that resumes it', () => {
    const drafts = { c_saved: 'Saved thread draft', c_left: 'Rewrite the hero', c_open: 'Typing here', c_blank: '  ' };
    expect(unsentDrafts(drafts, ['c_saved'], 'c_open')).toEqual([{ id: 'c_left', text: 'Rewrite the hero' }]);
    expect(moveDraft(drafts, 'c_left', 'c_resumed')).toEqual({ c_saved: 'Saved thread draft', c_open: 'Typing here', c_blank: '  ', c_resumed: 'Rewrite the hero' });
    expect(moveDraft(drafts, 'c_missing', 'c_resumed')).toBe(drafts);
    expect(moveDraft(drafts, 'c_left', 'c_left')).toBe(drafts);
  });

  it('reads only well-formed drafts from a workspace file', () => {
    expect(cleanDrafts({ c_ok1: 'Keep', c_empty: '', c_num: 3, 'not-an-id': 'x', ['__proto__']: 'x' })).toEqual({ c_ok1: 'Keep' });
    expect(cleanDrafts('Calm and understated')).toEqual({});
    expect(cleanDrafts(['x'])).toEqual({});
    expect(cleanDrafts(undefined)).toEqual({});
    expect(cleanDrafts(null)).toEqual({});
    expect(cleanDrafts({ 'c_bad-id': 'x', c_UPPER: 'x' })).toEqual({});
  });

  it('reopens the conversation that was open last time, so its draft comes back', () => {
    const drafts = { c_old: 'Older thread draft', c_fresh: 'Draft in a new conversation' };
    expect(restorePlan(undefined, 'c_newest', ['c_newest', 'c_old'], drafts)).toEqual({ kind: 'active' });
    expect(restorePlan('c_newest', 'c_newest', ['c_newest', 'c_old'], drafts)).toEqual({ kind: 'active' });
    expect(restorePlan('c_old', 'c_newest', ['c_newest', 'c_old'], drafts)).toEqual({ kind: 'open', id: 'c_old' });
    // A new conversation is not saved until something is sent; its draft comes back in a new one.
    expect(restorePlan('c_fresh', 'c_newest', ['c_newest', 'c_old'], drafts)).toEqual({ kind: 'fresh', from: 'c_fresh' });
    // Deleted meanwhile, with nothing typed: the newest conversation, as before.
    expect(restorePlan('c_deleted', 'c_newest', ['c_newest'], drafts)).toEqual({ kind: 'active' });
  });
});

describe('saving the composer state', () => {
  const st = (key: string | null, drafts: ChatDrafts, conversationId: string | null) => ({ key, drafts, conversationId });

  it('saves edits and conversation switches to the project they happened in', () => {
    const drafts = { c_a: 'Hi' };
    expect(chatStatePatch(st('/a#1', {}, 'c_a'), st('/a#1', drafts, 'c_a'))).toEqual({ key: '/a#1', patch: { chatDrafts: drafts } });
    expect(chatStatePatch(st('/a#1', drafts, 'c_a'), st('/a#1', drafts, 'c_b'))).toEqual({ key: '/a#1', patch: { chatConversation: 'c_b' } });
    expect(chatStatePatch(st('/a#1', {}, 'c_a'), st('/a#1', drafts, 'c_b'))).toEqual({ key: '/a#1', patch: { chatDrafts: drafts, chatConversation: 'c_b' } });
    expect(chatStatePatch(st('/a#1', drafts, 'c_a'), st('/a#1', drafts, 'c_a'))).toBeNull();
  });

  it('saves nothing when a project’s own state is loaded, or the project is left', () => {
    const kloof = { c_k: 'Calm and understated' };
    // Leaving Kloof for the welcome screen.
    expect(chatStatePatch(st('/kloof#1', kloof, 'c_k'), st(null, {}, null))).toBeNull();
    expect(chatStatePatch(st(null, {}, null), st(null, kloof, null))).toBeNull();
    // Opening 灯台 straight from Kloof: 灯台's state is loaded, and Kloof's text is not written into it.
    expect(chatStatePatch(st('/kloof#1', kloof, 'c_k'), st('/lighthouse#2', {}, null))).toBeNull();
    // Reopening Kloof loads its state again; that is not an edit either.
    expect(chatStatePatch(st('/kloof#1', {}, 'c_k'), st('/kloof#3', kloof, null))).toBeNull();
    // 灯台's conversation arriving is a switch within 灯台.
    const lighthouse: ChatDrafts = {};
    expect(chatStatePatch(st('/lighthouse#2', lighthouse, null), st('/lighthouse#2', lighthouse, 'c_l'))).toEqual({ key: '/lighthouse#2', patch: { chatConversation: 'c_l' } });
  });
});

/** An adapter whose single turn waits until released, so a run can be held open. */
class GatedAdapter implements AgentModelAdapter {
  release!: () => void;
  private gate = new Promise<void>((r) => (this.release = r));
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 };
  }
  async *streamTurn(): AsyncIterable<ModelEvent> {
    await this.gate;
    yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
  }
}

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'so-chat-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('blank', 'Drafts', false));
  sessions.push(session);
  const adapter = new GatedAdapter();
  let current: ProjectSession | null = session;
  const orch = new Orchestrator({
    session: () => current,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: () => undefined,
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: () => undefined
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  const settle = async () => {
    adapter.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(orch.busy).toBe(false);
  };
  return { session, orch, ctx, settle, adapter, swap: (s: ProjectSession | null) => (current = s), chatDir: join(dir, '.siteorigin', 'sessions', 'chat') };
}

describe('conversations in the assistant', () => {
  it('listing earlier conversations keeps a new, unsent conversation open', async () => {
    const { orch, ctx, settle, chatDir } = await setup();
    await orch.send('First request', ctx);
    await settle();
    const first = orch.conversation!.id;
    const fresh = await orch.newConversation();
    // Opening the History menu lists the saved threads; it must not switch away from the new one.
    const { active, list } = await orch.loadConversations();
    expect(active.id).toBe(fresh.id);
    expect(list.map((c) => c.id)).toEqual([first]);
    // So the message written in the new conversation is sent there, not appended to the first.
    expect((await orch.send('Second request', ctx, fresh.id)).ok).toBe(true);
    await settle();
    expect(readdirSync(chatDir).sort()).toEqual([`${first}.json`, `${fresh.id}.json`].sort());
    const asked = async (id: string) => (await orch.openConversation(id)).messages.filter((m) => m.role === 'user').map((m) => m.text);
    expect(await asked(first)).toEqual(['First request']);
    expect(await asked(fresh.id)).toEqual(['Second request']);
  });

  it('sends a message only to the conversation it was written in', async () => {
    const { orch, ctx } = await setup();
    const open = await orch.newConversation();
    const r = await orch.send('Rewrite the hero', ctx, 'c_elsewhere');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still in the message box/);
    expect(orch.busy).toBe(false);
    expect(orch.conversation!.id).toBe(open.id);
    expect(orch.conversation!.messages).toEqual([]);
  });

  it('never switches conversations while a request is running', async () => {
    const { orch, ctx, settle } = await setup();
    await orch.send('Earlier request', ctx);
    await settle();
    const earlier = orch.conversation!.id;
    const running = await orch.newConversation();
    expect((await orch.send('Running request', ctx, running.id)).ok).toBe(true);
    await expect(orch.openConversation(earlier)).rejects.toThrow(/Wait for the AI to finish/);
    await expect(orch.newConversation()).rejects.toThrow(/Wait for the AI to finish/);
    await expect(orch.clearHistory()).rejects.toThrow(/Wait for the AI to finish/);
    expect(orch.conversation!.id).toBe(running.id);
    await settle();
    // The run's messages were saved to its own conversation.
    expect((await orch.openConversation(running.id)).messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['Running request']);
  });

  it('a request that starts while another conversation is loading keeps its own', async () => {
    const { orch, ctx, settle } = await setup();
    await orch.send('Earlier request', ctx);
    await settle();
    const earlier = orch.conversation!.id;
    const running = await orch.newConversation();
    // History's pick is still reading its file when Send starts a request in the open conversation.
    const switching = orch.openConversation(earlier);
    expect((await orch.send('Running request', ctx, running.id)).ok).toBe(true);
    await expect(switching).rejects.toThrow(/Wait for the AI to finish/);
    expect(orch.conversation!.id).toBe(running.id);
    await settle();
  });

  it('no request starts while the history is being cleared', async () => {
    const { orch, ctx, settle, chatDir } = await setup();
    await orch.send('Earlier request', ctx);
    await settle();
    const clearing = orch.clearHistory();
    const r = await orch.send('Sent while clearing', ctx, orch.conversation!.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/being cleared/);
    const fresh = await clearing;
    expect(orch.conversation!.id).toBe(fresh.id);
    expect(fresh.messages).toEqual([]);
    // Nothing recreated the cleared history.
    expect(existsSync(chatDir)).toBe(false);
  });

  it('a conversation read that finishes after the project changed does not become the next project’s', async () => {
    const { orch, ctx, settle, swap, session } = await setup();
    await orch.send('Earlier request', ctx);
    await settle();
    const earlier = orch.conversation!.id;
    orch.reset();
    const listing = orch.loadConversations();
    swap(null);
    await expect(listing).rejects.toThrow(/project changed/);
    expect(orch.conversation).toBeNull();

    // Another project opening while the file is read is caught too, not only a closed one.
    swap(session);
    await orch.newConversation();
    const other = { local: () => join(tmpdir(), 'so-chat-other'), readOnly: null } as unknown as ProjectSession;
    const opening = orch.openConversation(earlier);
    swap(other);
    await expect(opening).rejects.toThrow(/project changed/);
    swap(session);
    const clearing = orch.clearHistory();
    swap(other);
    await expect(clearing).rejects.toThrow(/project changed/);
  });
});
