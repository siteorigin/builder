/**
 * Unsent AI messages stay with the conversation they were written in (issue #11): a new conversation starts empty,
 * returning to a thread restores its draft, a sent message is cleared only from its own thread, and a message is
 * only ever sent to the conversation it was written in.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatContext, Conversation } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';
import { afterSend, afterSendMessage, attachImage, attachImages, chatStatePatch, droppedImagesNote, isFileDrag, lastSentText, cleanDrafts, cleanImages, draftFor, imagesFor, moveDraft, moveImages, restorePlan, unsentDrafts, withDraft, withImages, type ChatDrafts, type ChatImages } from '../../src/renderer/src/lib/chatDrafts';

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
    expect(draftFor(Object.create({ c_home: 'Inherited' }) as ChatDrafts, 'c_home')).toBe('');
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
    const leading = { ...drafts, c_a: ' Make it warmer' };
    expect(afterSend(leading, 'c_a', 'Make it warmer')).toBe(leading);
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
    expect(cleanDrafts({ 'c_bad-id': 'x', c_UPPER: 'x', c_: 'x' })).toEqual({});
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
    // No conversation shown (yet) is not a switch to remember.
    expect(chatStatePatch(st('/a#1', drafts, 'c_a'), st('/a#1', drafts, null))).toBeNull();
  });

  it('saves nothing when a project’s own state is loaded, or the project is left', () => {
    const kloof = { c_k: 'Calm and understated' };
    // Leaving Kloof for the welcome screen.
    expect(chatStatePatch(st('/kloof#1', kloof, 'c_k'), st(null, {}, null))).toBeNull();
    expect(chatStatePatch(st(null, {}, null), st(null, kloof, null))).toBeNull();
    // Opening Kloof from the welcome screen loads its drafts; nothing is written back.
    expect(chatStatePatch(st(null, {}, null), st('/kloof#1', kloof, null))).toBeNull();
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
  const chatDir = join(dir, '.siteorigin', 'sessions', 'chat');
  // Finished, and its transcript written (that happens just after the assistant counts as idle).
  const settle = async () => {
    adapter.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(orch.busy).toBe(false);
    const file = join(chatDir, `${orch.conversation!.id}.json`);
    const sent = orch.conversation!.messages.filter((m) => m.role === 'user').length;
    const saved = () => existsSync(file) && (JSON.parse(readFileSync(file, 'utf8')) as Conversation).messages.filter((m) => m.role === 'user').length === sent;
    for (let i = 0; i < 200 && !saved(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(saved()).toBe(true);
  };
  return { session, orch, ctx, settle, adapter, swap: (s: ProjectSession | null) => (current = s), chatDir };
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

  it('opening the open conversation again shows it as it is, never an older copy on disk', async () => {
    const { orch, ctx, settle, chatDir } = await setup();
    await orch.send('First request', ctx);
    await settle();
    await orch.send('Second request', ctx, orch.conversation!.id);
    const open = orch.conversation!;
    // The file still holds the first turn only, as while the finished request is being written.
    writeFileSync(join(chatDir, `${open.id}.json`), JSON.stringify({ ...open, messages: open.messages.slice(0, 2) }));
    expect((await orch.openConversation(open.id)).messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['First request', 'Second request']);
    await settle();
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

  it('switches conversations while a request goes on in its own, which it saves alone (#1125)', async () => {
    const { orch, ctx, adapter, chatDir } = await setup();
    await orch.send('Earlier request', ctx);
    adapter.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    const earlier = orch.conversation!.id;
    const fresh = new GatedAdapter();
    (orch as unknown as { deps: { adapter: unknown } }).deps.adapter = async () => ({ adapter: fresh, model: 'fake', provider: 'openai' });
    const running = await orch.newConversation();
    expect((await orch.send('Running request', ctx, running.id)).ok).toBe(true);
    // Earlier conversations and New conversation both answer while it runs.
    const opened = await orch.openConversation(earlier);
    expect(opened.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['Earlier request']);
    const blank = await orch.newConversation();
    expect(blank.messages).toEqual([]);
    expect(orch.busy).toBe(true);
    // A new conversation's first turn is listed before it has a file, as it is in memory.
    const { list } = await orch.loadConversations();
    expect(existsSync(join(chatDir, `${running.id}.json`))).toBe(false);
    expect(list.map((c) => c.id)).toContain(running.id);
    // Nothing else is sent meanwhile, and the history is not cleared under it.
    expect((await orch.send('Second request', ctx, blank.id)).message).toMatch(/already working/);
    await expect(orch.clearHistory()).rejects.toThrow(/Wait for the AI to finish before clearing the history/);
    // Back in its thread, the very conversation the request adds to is open again, its turn still going.
    const back = await orch.openConversation(running.id);
    expect(back).toBe(running);
    expect(back.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(back.messages.at(-1)!.result).toBeUndefined();
    fresh.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    const file = join(chatDir, `${running.id}.json`);
    for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
    // The run's messages were saved to its own conversation, and the earlier one kept its own.
    expect((JSON.parse(readFileSync(file, 'utf8')) as Conversation).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((JSON.parse(readFileSync(join(chatDir, `${earlier}.json`), 'utf8')) as Conversation).messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['Earlier request']);
    // The next message goes on in the thread it was returned to.
    expect(orch.conversation).toBe(running);
  });

  it('a conversation opened while a request is starting opens, and the request keeps its own', async () => {
    const { orch, ctx, adapter, chatDir } = await setup();
    await orch.send('Earlier request', ctx);
    adapter.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    const earlier = orch.conversation!.id;
    const running = await orch.newConversation();
    // History's pick is still reading its file when Send starts a request in the open conversation.
    const switching = orch.openConversation(earlier);
    expect((await orch.send('Running request', ctx, running.id)).ok).toBe(true);
    expect((await switching).id).toBe(earlier);
    expect(orch.conversation!.id).toBe(earlier);
    // The request's thread is still the one it was filed in, and is read as it is in memory.
    const read = await orch.readConversation(running.id);
    expect(read.conversation.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['Running request']);
    expect(read.run).toMatchObject({ conversationId: running.id, mode: 'edit' });
    // Read from any other thread, the request still says where it runs.
    expect((await orch.readConversation(earlier)).run).toMatchObject({ conversationId: running.id });
    adapter.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    const file = join(chatDir, `${running.id}.json`);
    for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
    expect((JSON.parse(readFileSync(file, 'utf8')) as Conversation).messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['Running request']);
    expect((await orch.readConversation(earlier)).run).toBeNull();
  });

  it('an open still reading its file gives way to a conversation asked for after it', async () => {
    const { orch, ctx, settle } = await setup();
    await orch.send('Earlier request', ctx);
    await settle();
    const earlier = orch.conversation!.id;
    await orch.newConversation();
    const slow = orch.openConversation(earlier);
    const fresh = await orch.newConversation();
    await expect(slow).rejects.toThrow(/Another conversation was opened meanwhile/);
    // The thread a message goes to is the one asked for last.
    expect(orch.conversation).toBe(fresh);
    // Asking for the conversation already open is a pick too: an earlier one still reading gives way to it.
    const again = orch.openConversation(earlier);
    expect(await orch.openConversation(fresh.id)).toBe(fresh);
    await expect(again).rejects.toThrow(/Another conversation was opened meanwhile/);
    expect(orch.conversation).toBe(fresh);
  });

  it('a thread left while its request runs in a project read-only here keeps its answer, though it is never saved', async () => {
    const { orch, ctx, adapter, chatDir } = await setup();
    await orch.send('Earlier request', ctx);
    adapter.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    const earlier = orch.conversation!.id;
    const fresh = new GatedAdapter();
    (orch as unknown as { deps: { adapter: unknown } }).deps.adapter = async () => ({ adapter: fresh, model: 'fake', provider: 'openai' });
    const asking = await orch.newConversation();
    const session = (orch as unknown as { deps: { session: () => ProjectSession } }).deps.session();
    (session as unknown as { readOnly: unknown }).readOnly = { reason: 'Another app is editing this project.', canUnlock: true };
    try {
      expect((await orch.send('What does the footer say?', { ...ctx, mode: 'ask' }, asking.id)).ok).toBe(true);
      // Switched away while it answers, and the answer lands with nothing written.
      expect((await orch.openConversation(earlier)).id).toBe(earlier);
      fresh.release();
      for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
      await orch.loadConversations();
      expect(existsSync(join(chatDir, `${asking.id}.json`))).toBe(false);
      // Still listed, read and opened as it is in memory, its answer in it.
      expect((await orch.loadConversations()).list.map((c) => c.id)).toContain(asking.id);
      expect((await orch.readConversation(asking.id)).conversation.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Done.', result: { status: 'no-changes' } });
      const back = await orch.openConversation(asking.id);
      expect(back).toBe(asking);
      expect(back.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    } finally {
      (session as unknown as { readOnly: unknown }).readOnly = null;
    }
  });

  it('a thread whose save failed is renamed from memory, whole, and is then read from its file', async () => {
    const { orch, ctx, adapter, chatDir } = await setup();
    const o = orch as unknown as { writeConversation: (...a: unknown[]) => Promise<void> };
    const real = o.writeConversation.bind(orch);
    let fail = true;
    o.writeConversation = async (...a: unknown[]) => {
      if (fail) throw new Error('The disk is full.');
      return real(...a);
    };
    const kept = (await orch.loadConversations()).active;
    adapter.release();
    expect((await orch.send('Write an About page', ctx, kept.id)).ok).toBe(true);
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    await orch.loadConversations();
    const file = join(chatDir, `${kept.id}.json`);
    expect(existsSync(file)).toBe(false);
    fail = false;
    // Renamed while another thread is open: its turn is written with its name, not refused for having no file.
    await orch.newConversation();
    expect(await orch.renameConversation(kept.id, 'About page')).toEqual({ id: kept.id, title: 'About page' });
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Conversation;
    expect([saved.title, saved.messages.map((m) => m.role)]).toEqual(['About page', ['user', 'assistant']]);
    expect((await orch.loadConversations()).list.find((c) => c.id === kept.id)?.title).toBe('About page');
  });

  it('a rename that waited its turn while a request started in another thread still writes the unsaved thread whole', async () => {
    const { orch, ctx, adapter, chatDir } = await setup();
    const o = orch as unknown as { writeConversation: (...a: unknown[]) => Promise<void>; queueFileChange: (c: () => Promise<unknown>) => Promise<unknown> };
    const real = o.writeConversation.bind(orch);
    let fail = true;
    o.writeConversation = async (...a: unknown[]) => {
      if (fail) throw new Error('The disk is full.');
      return real(...a);
    };
    const kept = (await orch.loadConversations()).active;
    adapter.release();
    expect((await orch.send('Write an About page', ctx, kept.id)).ok).toBe(true);
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    await orch.loadConversations();
    fail = false;
    const other = await orch.newConversation();
    // Something already queued holds the rename back until a request has started in the other thread.
    let go!: () => void;
    void o.queueFileChange(() => new Promise<void>((r) => (go = r)));
    const renaming = orch.renameConversation(kept.id, 'About page');
    const fresh = new GatedAdapter();
    (orch as unknown as { deps: { adapter: unknown } }).deps.adapter = async () => ({ adapter: fresh, model: 'fake', provider: 'openai' });
    expect((await orch.send('Meanwhile, the footer', ctx, other.id)).ok).toBe(true);
    go();
    await renaming;
    const saved = JSON.parse(readFileSync(join(chatDir, `${kept.id}.json`), 'utf8')) as Conversation;
    expect([saved.title, saved.messages.map((m) => m.role)]).toEqual(['About page', ['user', 'assistant']]);
    fresh.release();
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
  });

  it('an earlier save that lands never lets go of a later turn whose save failed', async () => {
    const { orch, ctx, adapter } = await setup();
    const o = orch as unknown as { writeConversation: (...a: unknown[]) => Promise<void> };
    const real = o.writeConversation.bind(orch);
    let calls = 0;
    let land!: () => void;
    const landing = new Promise<void>((r) => (land = r));
    o.writeConversation = async (...a: unknown[]) => {
      const n = ++calls;
      if (n === 1) await landing;
      if (n === 2) throw new Error('The disk is full.');
      return real(...a);
    };
    const thread = (await orch.loadConversations()).active;
    adapter.release();
    expect((await orch.send('First request', ctx, thread.id)).ok).toBe(true);
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    // The second turn ends while the first one's save is still being written.
    expect((await orch.send('Second request', ctx, thread.id)).ok).toBe(true);
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 10));
    land();
    await orch.loadConversations();
    expect(calls).toBe(2);
    // Left and opened again: both turns, from memory (the file holds only the first).
    await orch.newConversation();
    const back = await orch.openConversation(thread.id);
    expect(back.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['First request', 'Second request']);
  });

  it('opens nothing while the history is being cleared, so the fresh conversation it leaves is the one open', async () => {
    const { orch, ctx, settle } = await setup();
    await orch.send('Earlier request', ctx);
    await settle();
    const earlier = orch.conversation!.id;
    const clearing = orch.clearHistory();
    await expect(orch.newConversation()).rejects.toThrow(/being cleared/);
    await expect(orch.openConversation(earlier)).rejects.toThrow(/being cleared/);
    const left = await clearing;
    expect(orch.conversation).toBe(left);
  });

  it('clearing history right after a request finishes does not bring its transcript back', async () => {
    const { orch, ctx, adapter, chatDir } = await setup();
    await orch.send('Last request', ctx);
    adapter.release();
    // Idle, with the transcript write just started.
    for (let i = 0; i < 200 && orch.busy; i++) await new Promise((r) => setTimeout(r, 1));
    await orch.clearHistory();
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(chatDir)).toBe(false);
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
    const before = orch.conversation!.id;
    const clearing = orch.clearHistory();
    swap(other);
    await expect(clearing).rejects.toThrow(/project changed/);
    expect(orch.conversation!.id).toBe(before);
  });
});

describe('images attached to an unsent message (#12)', () => {
  it('attaches an image once per message, up to four, and takes one out again', () => {
    let images: ChatImages = {};
    const add = (id: string) => {
      const r = attachImage(images, 'c_one', id);
      images = r.images;
      return r.outcome;
    };
    expect(add('a_yca1j3rh')).toBe('added');
    expect(add('a_hodln13r')).toBe('added');
    // The same image twice is one attachment, wherever it is in the list.
    expect(add('a_hodln13r')).toBe('already');
    expect(add('a_yca1j3rh')).toBe('already');
    expect(imagesFor(images, 'c_one')).toEqual(['a_yca1j3rh', 'a_hodln13r']);
    expect(add('a_3')).toBe('added');
    expect(add('a_4')).toBe('added');
    expect(add('a_5')).toBe('full');
    expect(imagesFor(images, 'c_one')).toEqual(['a_yca1j3rh', 'a_hodln13r', 'a_3', 'a_4']);
    // Each conversation keeps its own; another has none, and reading none is always the same empty list.
    expect(imagesFor(images, 'c_two')).toEqual([]);
    expect(imagesFor(images, 'c_two')).toBe(imagesFor({}, 'c_three'));
    images = withImages(images, 'c_one', ['a_hodln13r']);
    expect(imagesFor(images, 'c_one')).toEqual(['a_hodln13r']);
    expect(withImages(images, 'c_one', ['a_hodln13r'])).toBe(images);
    expect(withImages(images, 'c_one', [])).toEqual({});
  });

  it('takes the sent images out of the message, and clears its text only while it is what was sent', () => {
    const drafts: ChatDrafts = { c_one: 'Use this photo', c_two: 'Other' };
    const images: ChatImages = { c_one: ['a_hodln13r'], c_two: ['a_yca1j3rh'] };
    expect(afterSendMessage(drafts, images, 'c_one', 'Use this photo', ['a_hodln13r'])).toEqual({ drafts: { c_two: 'Other' }, images: { c_two: ['a_yca1j3rh'] } });
    // A new request typed while this one started stays, without the image that already went.
    expect(afterSendMessage({ ...drafts, c_one: 'Now the footer' }, images, 'c_one', 'Use this photo', ['a_hodln13r'])).toEqual({ drafts: { ...drafts, c_one: 'Now the footer' }, images: { c_two: ['a_yca1j3rh'] } });
    // An image attached meanwhile stays for the next message; the sent one and the sent text go.
    expect(afterSendMessage(drafts, { ...images, c_one: ['a_hodln13r', 'a_yca1j3rh'] }, 'c_one', 'Use this photo', ['a_hodln13r'])).toEqual({ drafts: { c_two: 'Other' }, images: { c_one: ['a_yca1j3rh'], c_two: ['a_yca1j3rh'] } });
    // Every image that went is taken out, wherever it sits now.
    expect(afterSendMessage({}, { c_one: ['a_2', 'a_new', 'a_1'] }, 'c_one', '', ['a_1', 'a_2']).images).toEqual({ c_one: ['a_new'] });
    // One image swapped for another meanwhile: the new one stays.
    expect(afterSendMessage(drafts, { ...images, c_one: ['a_kitchen1'] }, 'c_one', 'Use this photo', ['a_hodln13r']).images).toEqual({ c_one: ['a_kitchen1'], c_two: ['a_yca1j3rh'] });
    // A message sent without images clears its text as before, and leaves the images alone.
    const plain = afterSendMessage({ c_one: 'Hi' }, { c_two: ['a_1'] }, 'c_one', 'Hi', []);
    expect(plain).toEqual({ drafts: {}, images: { c_two: ['a_1'] } });
  });

  it('keeps a message that has only images as a draft: listed, restored and moved with its conversation', () => {
    expect(unsentDrafts({ c_typed: 'Hello' }, [], null, { c_pics: ['a_1', 'a_2'], c_typed: ['a_3'] })).toEqual([
      { id: 'c_typed', text: 'Hello', images: 1 },
      { id: 'c_pics', text: '', images: 2 }
    ]);
    // The open conversation and saved ones are not "not sent yet".
    expect(unsentDrafts({}, ['c_saved'], 'c_open', { c_saved: ['a_1'], c_open: ['a_2'] })).toEqual([]);
    expect(restorePlan('c_pics', 'c_newest', ['c_newest'], {}, { c_pics: ['a_1'] })).toEqual({ kind: 'fresh', from: 'c_pics' });
    expect(restorePlan('c_none', 'c_newest', ['c_newest'], {}, {})).toEqual({ kind: 'active' });
    expect(moveImages({ c_old: ['a_1'] }, 'c_old', 'c_new')).toEqual({ c_new: ['a_1'] });
    const same = { c_old: ['a_1'] };
    expect(moveImages(same, 'c_old', 'c_old')).toBe(same);
    expect(moveImages(same, 'c_none', 'c_new')).toBe(same);
  });

  it('saves with the drafts, and reads back only clean lists', () => {
    expect(cleanImages({ c_one: ['a_1', 'a_1', 7, '', 'a_2', 'a_3', 'a_4', 'a_5'], c_two: ['a_9'], 'not-a-conversation': ['a_1'], c_three: 'a_1', c_four: [] })).toEqual({ c_one: ['a_1', 'a_2', 'a_3', 'a_4'], c_two: ['a_9'] });
    expect(cleanImages(null)).toEqual({});
    expect(cleanImages(['a_1'])).toEqual({});
    const prev = { key: 'k1', drafts: {}, images: {}, conversationId: 'c_one' };
    expect(chatStatePatch(prev, { ...prev, images: { c_one: ['a_1'] } })).toEqual({ key: 'k1', patch: { chatImages: { c_one: ['a_1'] } } });
    // Taking the last image out is saved too.
    expect(chatStatePatch({ ...prev, images: { c_one: ['a_1'] } }, { ...prev, images: {} })).toEqual({ key: 'k1', patch: { chatImages: {} } });
    // Another opening, or no change, saves nothing.
    expect(chatStatePatch(prev, { ...prev, key: 'k2', images: { c_one: ['a_1'] } })).toBeNull();
    expect(chatStatePatch(prev, prev)).toBeNull();
  });
});

describe('image files dropped on the composer (#679)', () => {
  it('attaches what the importer returned, in order, each once, up to a message’s worth, and says what happened', () => {
    let images: ChatImages = withImages({}, 'c_home', ['a_kiln']);
    const r = attachImages(images, 'c_home', ['a_ana', 'a_kiln', 'a_bo', 'a_ana', 'a_cy', 'a_di']);
    expect(imagesFor(r.images, 'c_home')).toEqual(['a_kiln', 'a_ana', 'a_bo', 'a_cy']);
    expect(r).toMatchObject({ added: ['a_ana', 'a_bo', 'a_cy'], already: 1, full: 1 });
    expect(droppedImagesNote({ added: r.added.length, already: r.already, full: r.full })).toBe('Attached 3 images to your message. They are in Assets too. 1 image is already in your message. 1 image is in Assets but not in your message: a message carries at most 4 images.');
    // Another conversation's draft is never touched, and nothing to attach changes nothing.
    images = r.images;
    const other = attachImages(images, 'c_other', ['a_ana']).images;
    expect(imagesFor(other, 'c_home')).toEqual(imagesFor(images, 'c_home'));
    expect(imagesFor(other, 'c_other')).toEqual(['a_ana']);
    expect(attachImages(images, 'c_home', []).images).toBe(images);
    expect(droppedImagesNote({ added: 1, already: 0, full: 0 })).toBe('Attached 1 image to your message. It is in Assets too.');
  });

  it('takes only a drag of files from the desktop', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(['text/plain', 'Files'])).toBe(true);
    expect(isFileDrag(['text/plain', 'text/uri-list'])).toBe(false);
  });
});

describe('ArrowUp in an empty composer (#1410)', () => {
  const time = '2026-11-28T00:00:00.000Z';
  it('brings back the last message the author sent, never a reply', () => {
    const messages = [
      { id: 'm1', role: 'user' as const, text: 'Make the hero blue', time },
      { id: 'm2', role: 'assistant' as const, text: 'Done.', time },
      { id: 'm3', role: 'user' as const, text: 'Now add a button', time },
      { id: 'm4', role: 'assistant' as const, text: 'Added a button.', time }
    ];
    expect(lastSentText(messages)).toBe('Now add a button');
  });

  it('has nothing to bring back before anything is sent', () => {
    expect(lastSentText([])).toBeNull();
    expect(lastSentText(undefined)).toBeNull();
    expect(lastSentText([{ role: 'assistant', text: 'Hello' }])).toBeNull();
  });
});
