/**
 * Finding, naming and removing single AI conversations (#235): titles cut at a word, the list ordered by the latest
 * activity with every request to tell similar ones apart and to search, a name that sticks, and a delete that takes
 * one thread and nothing else (never the site, its undo history, or another conversation).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiEvent, ChatContext, ChatMessage, Conversation } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';
import { autoTitle, byRecentActivity, cleanTitle, matchConversation, storedTitle, summarize, TITLE_MAX } from '@shared/conversations';
import { ProjectSession } from '../../src/main/project/session';

describe('conversation titles', () => {
  it('cuts a long first request at the end of a word, never mid-word', () => {
    const brief = 'Redesign the homepage hero for a calmer studio brand with warm photography and a booking button';
    const title = autoTitle(brief);
    expect(title).toBe('Redesign the homepage hero for a calmer studio brand with…');
    expect(brief.startsWith(title.slice(0, -1))).toBe(true);
    expect(autoTitle('Add a contact page')).toBe('Add a contact page');
    expect(autoTitle('  Two\nlines  of\ttext ')).toBe('Two lines of text');
    // A word running past the cut is kept whole while the title still fits; one longer than any title is cut.
    expect(autoTitle(`Use ${'y'.repeat(62)} as the hero link`)).toBe(`Use ${'y'.repeat(62)}…`);
    expect(autoTitle('x'.repeat(100))).toBe(`${'x'.repeat(60)}…`);
    expect(autoTitle('x'.repeat(70))).toBe('x'.repeat(70));
    // No dangling punctuation before the ellipsis.
    expect(autoTitle(`${'word '.repeat(10)}end, and then much more text that keeps going past the cut`)).not.toMatch(/[,\s]…$/);
  });

  it('shows a conversation stored with the old mid-word cut by its request cut at a word, and keeps a name the author gave', () => {
    const opening = 'Interview me about the Contact page so the copy sounds like our studio and not a template';
    const messages = [{ id: 'm_1', role: 'user', text: opening, time: '2026-11-20T09:00:00.000Z' }] as ChatMessage[];
    expect(storedTitle({ title: opening.slice(0, 60), messages })).toBe(autoTitle(opening));
    expect(storedTitle({ title: 'Contact interview', messages })).toBe('Contact interview');
    expect(storedTitle({ title: opening.slice(0, 60), named: true, messages })).toBe(opening.slice(0, 60));
    expect(storedTitle({ title: '', messages: [] })).toBe('New conversation');
  });

  it('takes a typed name on one line, refusing an empty or overlong one', () => {
    expect(cleanTitle('  Homepage   brief\n')).toBe('Homepage brief');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(7)).toBeNull();
    expect(cleanTitle('a'.repeat(TITLE_MAX))).toBe('a'.repeat(TITLE_MAX));
    expect(cleanTitle('a'.repeat(TITLE_MAX + 1))).toBeNull();
  });
});

describe('finding a conversation', () => {
  const conv = (id: string, title: string, prompts: string[], updatedAt = '2026-11-20T09:00:00.000Z') => ({ id, title, createdAt: '2026-11-20T08:00:00.000Z', updatedAt, prompts });

  it('matches every word in its title or in anything the author asked, ignoring case and accents', () => {
    const keeper = conv('c_a', 'Homepage brief', ['Design the homepage for Café Lumière', 'Make the hero photo warmer and add a terracotta accent']);
    expect(matchConversation(keeper, 'brief')).toMatchObject({ in: 'title', text: 'Homepage brief' });
    const found = matchConversation(keeper, 'TERRACOTTA accent');
    expect(found).toMatchObject({ in: 'prompt', text: 'Make the hero photo warmer and add a terracotta accent' });
    expect(found!.text.slice(found!.start, found!.end)).toBe('terracotta accent');
    // Words from different requests still find it, together.
    expect(matchConversation(keeper, 'lumiere warmer')).not.toBeNull();
    const accented = matchConversation(keeper, 'cafe lumiere');
    expect(accented!.text.slice(accented!.start, accented!.end)).toBe('Café Lumière');
    expect(matchConversation(keeper, 'terracotta navy')).toBeNull();
    expect(matchConversation(keeper, '   ')).toBeNull();
  });

  it('lists the conversation continued most recently first', () => {
    const list = [conv('c_old', 'Started first, continued today', [], '2026-11-25T10:00:00.000Z'), conv('c_new', 'Started later, idle since', [], '2026-11-22T10:00:00.000Z')];
    expect([...list].reverse().sort(byRecentActivity).map((c) => c.id)).toEqual(['c_old', 'c_new']);
  });

  it('summarizes a stored conversation by its latest message and every request', () => {
    const c: Conversation = {
      id: 'c_s',
      title: 'New conversation',
      createdAt: '2026-11-20T08:00:00.000Z',
      messages: [
        { id: 'm_1', role: 'user', text: 'First', time: '2026-11-20T08:00:00.000Z' },
        { id: 'm_2', role: 'assistant', text: 'Done', time: '2026-11-20T08:00:05.000Z' },
        { id: 'm_3', role: 'user', text: '', time: '2026-11-21T08:00:00.000Z' },
        { id: 'm_4', role: 'user', text: 'Second', time: '2026-11-24T08:00:00.000Z' }
      ]
    };
    expect(summarize(c)).toEqual({ id: 'c_s', title: 'First', createdAt: c.createdAt, updatedAt: '2026-11-24T08:00:00.000Z', prompts: ['First', 'Second'] });
  });
});

/** Each model turn answers at once, unless the test holds it at its gate. */
class Adapter implements AgentModelAdapter {
  hold = false;
  private gates: Array<() => void> = [];
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 };
  }
  get waiting() {
    return this.gates.length > 0;
  }
  release() {
    this.gates.splice(0).forEach((r) => r());
  }
  async *streamTurn(): AsyncIterable<ModelEvent> {
    yield { type: 'text', delta: 'Done.' };
    if (this.hold) await new Promise<void>((r) => this.gates.push(r));
    yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
  }
}

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'so-conversations-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('blank', 'Studio', false));
  sessions.push(session);
  const adapter = new Adapter();
  const events: AiEvent[] = [];
  const make = () =>
    new Orchestrator({
      session: () => session,
      adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
      emit: (e: AiEvent) => events.push(e),
      compileAll: async () => [],
      inspectLayout: async () => ({ issues: [] }),
      onBusyChange: () => undefined
    });
  const orch = make();
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  const chatDir = join(dir, '.siteorigin', 'sessions', 'chat');
  const file = (id: string) => join(chatDir, `${id}.json`);
  const stored = (id: string) => JSON.parse(readFileSync(file(id), 'utf8')) as Conversation;
  /** Send a request in the open conversation and wait for it to end and be saved. */
  const ask = async (text: string, o = orch) => {
    const conv = (await o.loadConversations()).active;
    const r = await o.send(text, ctx, conv.id);
    expect(r).toMatchObject({ ok: true });
    await until(() => !o.busy, 'the request to finish');
    await until(() => existsSync(file(conv.id)) && stored(conv.id).messages.filter((m) => m.role === 'user').at(-1)?.text === text, 'the transcript to be saved');
    return conv.id;
  };
  /** A conversation as an earlier session left it on disk. */
  const write = (c: Conversation) => {
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(file(c.id), JSON.stringify(c));
  };
  return { dir, session, adapter, orch, make, ctx, file, stored, ask, write, chatDir };
}

const thread = (id: string, prompts: Array<[string, string]>): Conversation => ({
  id,
  title: 'New conversation',
  createdAt: prompts[0][1],
  messages: prompts.flatMap(([text, time], i) => [
    { id: `m_${id}u${i}`, role: 'user' as const, text, time },
    { id: `m_${id}a${i}`, role: 'assistant' as const, text: 'Done.', time, runId: `run_${id}${i}`, result: { status: 'no-changes' as const, summary: 'Done.', changes: [], validation: [], canUndo: false } }
  ])
});

describe('managing conversations (#235)', () => {
  it('lists conversations by their latest activity, so one continued today comes first', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage for the studio', '2026-11-20T09:00:00.000Z']]));
    env.write(thread('c_brief2', [['Design a calm homepage for the bakery', '2026-11-22T09:00:00.000Z']]));
    expect((await env.orch.loadConversations()).list.map((c) => c.id)).toEqual(['c_brief2', 'c_brief1']);
    // With none open yet, the most recently active one opens.
    expect((await env.orch.loadConversations()).active.id).toBe('c_brief2');
    await env.orch.openConversation('c_brief1');
    await env.ask('Make the studio hero warmer');
    const { list } = await env.orch.loadConversations();
    expect(list.map((c) => c.id)).toEqual(['c_brief1', 'c_brief2']);
    expect(list[0]).toMatchObject({ title: 'Design a calm homepage for the studio', prompts: ['Design a calm homepage for the studio', 'Make the studio hero warmer'] });
    expect(Date.parse(list[0].updatedAt)).toBeGreaterThan(Date.parse('2026-11-24T00:00:00.000Z'));
  });

  it('names a new conversation by its first request, cut at a word', async () => {
    const env = await setup();
    const id = await env.ask('Write a homepage design brief for a ceramics studio that sells online and runs weekend workshops');
    expect(env.stored(id).title).toBe('Write a homepage design brief for a ceramics studio that…');
  });

  it('renames the open conversation and another one; the names are kept across a reopen and by later requests', async () => {
    const env = await setup();
    env.write(thread('c_other1', [['Interview me about the Contact page', '2026-11-20T09:00:00.000Z']]));
    await env.orch.newConversation();
    const keeper = await env.ask('Design a calm homepage for the studio');
    const revision = env.session.revision;
    const history = env.session.historyInfo();

    expect(await env.orch.renameConversation(keeper, '  Homepage   keeper ')).toEqual({ id: keeper, title: 'Homepage keeper' });
    expect((await env.orch.loadConversations()).active).toMatchObject({ id: keeper, title: 'Homepage keeper', named: true });
    await until(() => env.stored(keeper).title === 'Homepage keeper', 'the name to be saved');
    expect(env.stored(keeper).named).toBe(true);
    await env.orch.renameConversation('c_other1', 'Contact interview');
    expect(env.stored('c_other1')).toMatchObject({ title: 'Contact interview', named: true });
    // Its messages are as they were.
    expect(env.stored('c_other1').messages.map((m) => m.text)).toEqual(['Interview me about the Contact page', 'Done.']);

    // A later request never renames it.
    await env.ask('Make the hero warmer');
    expect(env.stored(keeper).title).toBe('Homepage keeper');

    const reopened = env.make();
    const { list } = await reopened.loadConversations();
    expect(Object.fromEntries(list.map((c) => [c.id, c.title]))).toEqual({ [keeper]: 'Homepage keeper', c_other1: 'Contact interview' });
    // Naming touched neither the site nor its undo history.
    expect(env.session.revision).toBe(revision);
    expect(env.session.historyInfo()).toEqual(history);
  });

  it('refuses an empty name, an unknown conversation and a name for a project open read-only', async () => {
    const env = await setup();
    const id = await env.ask('Design a calm homepage');
    await expect(env.orch.renameConversation(id, '   ')).rejects.toThrow(/needs some text/);
    await expect(env.orch.renameConversation('c_missing1', 'Name')).rejects.toThrow();
    await expect(env.orch.renameConversation('../escape', 'Name')).rejects.toThrow(/Unknown conversation/);
    expect(env.stored(id).title).toBe('Design a calm homepage');
    env.session.readOnly = { reason: 'Another app is editing this project.', canUnlock: false } as typeof env.session.readOnly;
    await expect(env.orch.renameConversation(id, 'Keeper')).rejects.toThrow(/Another app/);
    await expect(env.orch.deleteConversation(id)).rejects.toThrow(/Another app/);
    env.session.readOnly = null;
    expect(env.stored(id).title).toBe('Design a calm homepage');
    expect(existsSync(env.file(id))).toBe(true);
  });

  it('deletes only the chosen conversation: the others, the site and its undo history stay', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage for the studio', '2026-11-20T09:00:00.000Z']]));
    env.write(thread('c_brief2', [['Design a calm homepage for the studio shop', '2026-11-21T09:00:00.000Z']]));
    env.write(thread('c_experiment1', [['Interview me about the Contact page', '2026-11-22T09:00:00.000Z']]));
    await env.orch.openConversation('c_brief1');
    const revision = env.session.revision;
    const history = env.session.historyInfo();
    const pages = structuredClone(env.session.state.pages);

    const active = await env.orch.deleteConversation('c_experiment1');
    expect(active.id).toBe('c_brief1');
    expect(readdirSync(env.chatDir).sort()).toEqual(['c_brief1.json', 'c_brief2.json']);
    expect((await env.orch.loadConversations()).list.map((c) => c.id)).toEqual(['c_brief2', 'c_brief1']);
    await expect(env.orch.openConversation('c_experiment1')).rejects.toThrow();
    expect(env.session.revision).toBe(revision);
    expect(env.session.historyInfo()).toEqual(history);
    expect(env.session.state.pages).toEqual(pages);
  });

  it('deleting the open conversation leaves a new one open; nothing is renamed or deleted while a request runs', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage', '2026-11-20T09:00:00.000Z']]));
    await env.orch.newConversation();
    const open = await env.ask('Try an interview experiment');
    env.adapter.hold = true;
    const r = await env.orch.send('Keep going', env.ctx, open);
    expect(r.ok).toBe(true);
    await until(() => env.adapter.waiting, 'the request to stream');
    // A request saves its conversation when it ends, so neither it nor another changes meanwhile.
    await expect(env.orch.deleteConversation(open)).rejects.toThrow(/Wait for the AI to finish before deleting/);
    await expect(env.orch.deleteConversation('c_brief1')).rejects.toThrow(/Wait for the AI to finish/);
    await expect(env.orch.renameConversation(open, 'Experiment')).rejects.toThrow(/Wait for the AI to finish before renaming/);
    await expect(env.orch.renameConversation('c_brief1', 'Keeper')).rejects.toThrow(/Wait for the AI to finish/);
    expect(existsSync(env.file('c_brief1'))).toBe(true);
    env.adapter.release();
    await until(() => !env.orch.busy, 'the request to finish');

    const fresh = await env.orch.deleteConversation(open);
    expect(fresh).toMatchObject({ title: 'New conversation', messages: [] });
    expect(fresh.id).not.toBe(open);
    expect(existsSync(env.file(open))).toBe(false);
    expect(existsSync(env.file('c_brief1'))).toBe(true);
    // A message written in the deleted conversation is not sent into another.
    expect(await env.orch.send('Sent late', env.ctx, open)).toMatchObject({ ok: false });
  });

  it('a delete asked for while a send is starting in that conversation lets no request in, and loses no other thread', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage', '2026-11-20T09:00:00.000Z']]));
    await env.orch.newConversation();
    const open = await env.ask('Try an interview experiment');
    // The delete is under way (its file change queued) when a message written in that thread arrives.
    const deleting = env.orch.deleteConversation(open);
    expect(await env.orch.send('Sent while deleting', env.ctx, open)).toMatchObject({ ok: false });
    const fresh = await deleting;
    expect(fresh.id).not.toBe(open);
    expect(env.orch.busy).toBe(false);
    expect(existsSync(env.file(open))).toBe(false);
    expect(readdirSync(env.chatDir)).toEqual(['c_brief1.json']);
  });

  it('an open, rename and delete of one thread land in the order asked, so a deleted thread never comes back', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage', '2026-11-20T09:00:00.000Z']]));
    env.write(thread('c_gone1', [['Interview me about the Contact page', '2026-11-21T09:00:00.000Z']]));
    await env.orch.openConversation('c_brief1');
    // Rename first, then delete, asked for at once: the delete is the last word (the rename may land or be refused).
    const renamed = env.orch.renameConversation('c_gone1', 'Experiment').catch((e: Error) => e);
    const deleted = env.orch.deleteConversation('c_gone1');
    await renamed;
    await deleted;
    expect(existsSync(env.file('c_gone1'))).toBe(false);
    // Delete first, then a rename or an open: both find it gone.
    env.write(thread('c_gone2', [['Interview me again', '2026-11-21T09:00:00.000Z']]));
    const del2 = env.orch.deleteConversation('c_gone2');
    await expect(env.orch.renameConversation('c_gone2', 'Back again')).rejects.toThrow(/Unknown conversation/);
    await expect(env.orch.openConversation('c_gone2')).rejects.toThrow();
    await del2;
    expect(existsSync(env.file('c_gone2'))).toBe(false);
    // An open already reading when the delete is asked for: the delete still wins, and a new conversation is open.
    env.write(thread('c_gone3', [['Interview me once more', '2026-11-21T09:00:00.000Z']]));
    const opening = env.orch.openConversation('c_gone3');
    const del3 = env.orch.deleteConversation('c_gone3');
    await opening.catch(() => undefined);
    await del3;
    const { active, list } = await env.orch.loadConversations();
    expect(active.id).not.toBe('c_gone3');
    expect(list.map((c) => c.id)).toEqual(['c_brief1']);
    expect(existsSync(env.file('c_gone3'))).toBe(false);
  });

  it('a name given to the open conversation is saved with its messages, and a later request keeps it', async () => {
    const env = await setup();
    const open = await env.ask('Write an About page');
    await env.orch.renameConversation(open, 'About page');
    expect(env.stored(open)).toMatchObject({ title: 'About page', named: true });
    expect(env.stored(open).messages).toHaveLength(2);
    await env.ask('And a footer');
    expect(env.stored(open)).toMatchObject({ title: 'About page', named: true });
    expect(env.stored(open).messages).toHaveLength(4);
    // A new conversation named before its first message keeps the name once that message is sent.
    const fresh = await env.orch.newConversation();
    await env.orch.renameConversation(fresh.id, 'Footer ideas');
    expect(existsSync(env.file(fresh.id))).toBe(false);
    await env.ask('Suggest footer links');
    expect(env.stored(fresh.id)).toMatchObject({ title: 'Footer ideas', named: true });
  });

  it('a delete queued behind a transcript write lands after it, so the deleted file never comes back', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage', '2026-11-20T09:00:00.000Z']]));
    await env.orch.newConversation();
    const first = await env.ask('Try an interview experiment');
    // The request ends and its save is queued; the author switches away and deletes it straight after.
    expect((await env.orch.send('One more question', env.ctx, first)).ok).toBe(true);
    await until(() => !env.orch.busy, 'the request to finish');
    await env.orch.openConversation('c_brief1');
    await env.orch.deleteConversation(first);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(env.file(first))).toBe(false);
    expect((await env.make().loadConversations()).list.map((c) => c.id)).toEqual(['c_brief1']);
  });
});
