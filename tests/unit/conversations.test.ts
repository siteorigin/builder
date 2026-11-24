/**
 * Finding, naming and removing single AI conversations (#235): titles cut at a word, the list ordered by the latest
 * activity with every request to tell similar ones apart and to search, a name that sticks, and a delete that takes
 * one thread and nothing else (never the site, its undo history, or another conversation).
 */
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatContext, ChatMessage, Conversation } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, ModelEvent } from '@agent/types';
import { autoTitle, byRecentActivity, cleanTitle, matchConversation, storedTitle, summarize, TITLE_MAX } from '@shared/conversations';
import { ProjectSession } from '../../src/main/project/session';
import { activityHint, activityPhrase, matchExcerpt } from '../../src/renderer/src/lib/conversations';

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
    // A one-word request that fits the longest title exactly is kept whole.
    expect(autoTitle('x'.repeat(TITLE_MAX))).toBe('x'.repeat(TITLE_MAX));
    // Punctuation the cut lands after is dropped before the ellipsis.
    expect(autoTitle(`${'word '.repeat(11)}end, then more words that run on past the cut`)).toBe(`${'word '.repeat(11)}end…`);
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
    // A title lost by an earlier version (an images-only first message) reads as its first request with words.
    expect(storedTitle({ title: '', messages })).toBe(autoTitle(opening));
  });

  it('takes a typed name on one line, refusing an empty or overlong one', () => {
    expect(cleanTitle('  Homepage   brief\n')).toBe('Homepage brief');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(7)).toBeNull();
    expect(cleanTitle('a'.repeat(TITLE_MAX))).toBe('a'.repeat(TITLE_MAX));
    expect(cleanTitle('a'.repeat(TITLE_MAX + 1))).toBeNull();
    // Counted in characters, and composed: 41 emoji fit, and a decomposed accent comes back composed.
    expect(cleanTitle('🏺'.repeat(41))).toBe('🏺'.repeat(41));
    expect(cleanTitle('Cafe\u0301 brief')).toBe('Café brief');
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

  it('marks a match as written: a decomposed accent, a ligature and a final sigma', () => {
    const decomposed = 'Cafe\u0301 opening hours';
    const m = matchConversation({ title: 'x', prompts: [decomposed] }, 'café opening')!;
    expect(decomposed.slice(m.start, m.end)).toBe(decomposed.slice(0, 'Cafe\u0301 opening'.length));
    // A match ending on a letter takes its accent along.
    const end = matchConversation({ title: 'x', prompts: [decomposed] }, 'cafe')!;
    expect(decomposed.slice(end.start, end.end)).toBe('Cafe\u0301');
    const lig = matchConversation({ title: 'Our o\uFB03ce', prompts: [] }, 'f')!;
    expect(lig.end).toBeGreaterThan(lig.start);
    expect('Our o\uFB03ce'.slice(lig.start, lig.end)).toBe('\uFB03');
    // Part of a ligature carrying an accent takes the accent too.
    const ligAccent = matchConversation({ title: 'o\uFB03\u0301', prompts: [] }, 'f')!;
    expect('o\uFB03\u0301'.slice(ligAccent.start, ligAccent.end)).toBe('\uFB03\u0301');
    expect(matchConversation({ title: 'ΚΑΦΕΣ', prompts: [] }, 'καφες')).not.toBeNull();
    // Only what the author asked is searched: a reply's words find nothing.
    expect(matchConversation({ title: 'Homepage', prompts: ['Write a brief'] }, 'terracotta')).toBeNull();
  });

  it('lists the conversation continued most recently first, then the one started later', () => {
    const list = [conv('c_old', 'Started first, continued today', [], '2026-11-25T10:00:00.000Z'), conv('c_new', 'Started later, idle since', [], '2026-11-22T10:00:00.000Z')];
    expect([...list].reverse().sort(byRecentActivity).map((c) => c.id)).toEqual(['c_old', 'c_new']);
    const tie = [{ ...conv('c_a', 'A', [], '2026-11-22T10:00:00.000Z'), createdAt: '2026-11-20T08:00:00.000Z' }, { ...conv('c_b', 'B', [], '2026-11-22T10:00:00.000Z'), createdAt: '2026-11-21T08:00:00.000Z' }];
    expect(tie.sort(byRecentActivity).map((c) => c.id)).toEqual(['c_b', 'c_a']);
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
        { id: 'm_4', role: 'user', text: 'Second', time: '2026-11-24T08:00:00.000Z' },
        // The reply is the latest activity, and a time that can't be read is not.
        { id: 'm_5', role: 'assistant', text: 'Done', time: '2026-11-24T08:00:09.000Z' },
        { id: 'm_6', role: 'assistant', text: 'Odd', time: 'yesterday-ish' }
      ]
    };
    expect(summarize(c)).toEqual({ id: 'c_s', title: 'First', createdAt: c.createdAt, updatedAt: '2026-11-24T08:00:09.000Z', prompts: ['First', 'Second'] });
  });
});

describe('how the list words a conversation', () => {
  const now = new Date(2026, 10, 25, 16, 30);
  it('says the time of day for today, so a day’s conversations read apart, and a date before that', () => {
    const today = activityHint(new Date(2026, 10, 25, 9, 5).toISOString(), now, 'en-GB');
    expect(today).toBe('9:05');
    expect(activityHint(new Date(2026, 10, 25, 14, 40).toISOString(), now, 'en-GB')).not.toBe(today);
    expect(activityHint(new Date(2026, 10, 24, 23, 0).toISOString(), now, 'en-GB')).toBe('Yesterday');
    expect(activityHint(new Date(2026, 10, 20, 12, 0).toISOString(), now, 'en-GB')).toBe('20 Nov');
    expect(activityHint(new Date(2025, 10, 20, 12, 0).toISOString(), now, 'en-GB')).toBe('20 Nov 2025');
    expect(activityHint('not a date', now)).toBe('');
    expect(activityPhrase('not a date', now)).toBe('');
    expect(activityPhrase(new Date(2026, 10, 25, 9, 5).toISOString(), now, 'en-GB')).toBe('today at 9:05');
    expect(activityPhrase(new Date(2026, 10, 24, 9, 5).toISOString(), now, 'en-GB')).toBe('yesterday');
    expect(activityPhrase(new Date(2026, 10, 20, 9, 5).toISOString(), now, 'en-GB')).toBe('on 20 Nov');
  });

  it('shows a match deep in a long request where it is, with a few words either side', () => {
    const text = `${'Start with a long opening about the studio and its classes. '.repeat(4)}Then add a terracotta accent to the hero.\nKeep the rest.`;
    const m = matchConversation({ title: 'Homepage', prompts: [text] }, 'terracotta accent')!;
    const x = matchExcerpt(m, 30);
    expect(x.hit).toBe('terracotta accent');
    expect(x.before.startsWith('…')).toBe(true);
    expect(x.before.endsWith('add a ')).toBe(true);
    expect(x.after).toBe(' to the hero. Keep the rest.');
    // A match at the start has nothing cut before it.
    const first = matchExcerpt(matchConversation({ title: 'x', prompts: ['Terracotta everywhere, please'] }, 'terracotta')!);
    expect(first).toEqual({ before: '', hit: 'Terracotta', after: ' everywhere, please' });
    // A long tail is cut at a word, with an ellipsis.
    const tail = matchExcerpt(matchConversation({ title: 'x', prompts: [`Terracotta ${'and more words '.repeat(10)}`] }, 'terracotta')!, 20);
    expect(tail.after.endsWith('…')).toBe(true);
    expect(tail.after.length).toBeLessThan(25);
  });
});

/** Each model turn answers at once, unless the test holds it at its gate. */
class Adapter implements AgentModelAdapter {
  hold = false;
  /** Turns answered as written, before any default one. */
  script: ModelEvent[][] = [];
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
    const scripted = this.script.shift();
    if (scripted) return yield* scripted;
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

/** Hold the orchestrator's queue of conversation file changes until released, so the next ones wait behind it. */
function hold(orch: Orchestrator): () => void {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  void (orch as unknown as { queueFileChange(change: () => Promise<void>): Promise<void> }).queueFileChange(() => held);
  return release;
}

describe('managing conversations (#235)', () => {
  it('lists conversations by their latest activity, so one continued today comes first', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage for the studio', '2026-11-20T09:00:00.000Z']]));
    env.write(thread('c_brief2', [['Design a calm homepage for the bakery', '2026-11-22T09:00:00.000Z']]));
    // Started first, continued last: it leads, and it is the one that opens when none is open yet.
    env.write(thread('c_brief0', [['Plan the gallery page', '2026-11-18T09:00:00.000Z'], ['Add captions', '2026-11-23T09:00:00.000Z']]));
    expect((await env.orch.loadConversations()).list.map((c) => c.id)).toEqual(['c_brief0', 'c_brief2', 'c_brief1']);
    expect((await env.orch.loadConversations()).active.id).toBe('c_brief0');
    await env.orch.openConversation('c_brief1');
    await env.ask('Make the studio hero warmer');
    const { list } = await env.orch.loadConversations();
    expect(list.map((c) => c.id)).toEqual(['c_brief1', 'c_brief0', 'c_brief2']);
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
    // Even a name that reads like the placeholder is the author's.
    await env.orch.renameConversation(keeper, 'New conversation');
    await env.ask('One more change');
    expect(env.stored(keeper)).toMatchObject({ title: 'New conversation', named: true });
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
    await expect(env.orch.deleteConversation('../escape')).rejects.toThrow(/Unknown conversation/);
    await expect(env.orch.deleteConversation(7 as unknown as string)).rejects.toThrow(/Unknown conversation/);
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
    // Rename first, then delete, asked for at once: each lands in turn, and the delete is the last word.
    const renamed = env.orch.renameConversation('c_gone1', 'Experiment');
    const deleted = env.orch.deleteConversation('c_gone1');
    await expect(renamed).resolves.toEqual({ id: 'c_gone1', title: 'Experiment' });
    await deleted;
    expect(existsSync(env.file('c_gone1'))).toBe(false);
    // Delete first, then a rename or an open: both find it gone.
    env.write(thread('c_gone2', [['Interview me again', '2026-11-21T09:00:00.000Z']]));
    const del2 = env.orch.deleteConversation('c_gone2');
    await expect(env.orch.renameConversation('c_gone2', 'Back again')).rejects.toThrow(/Unknown conversation/);
    await expect(env.orch.openConversation('c_gone2')).rejects.toThrow();
    await del2;
    expect(existsSync(env.file('c_gone2'))).toBe(false);
    // An open already reading when the delete is asked for: the open is refused, and the thread on screen stays.
    env.write(thread('c_gone3', [['Interview me once more', '2026-11-21T09:00:00.000Z']]));
    const release = hold(env.orch);
    const opening = env.orch.openConversation('c_gone3');
    const del3 = env.orch.deleteConversation('c_gone3');
    release();
    await expect(opening).rejects.toThrow(/deleted/);
    await del3;
    const { active, list } = await env.orch.loadConversations();
    expect(active.id).toBe('c_brief1');
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
    // The request ends while the queue is held, so its save waits; the author deletes it straight after.
    const release = hold(env.orch);
    expect((await env.orch.send('One more question', env.ctx, first)).ok).toBe(true);
    await until(() => !env.orch.busy, 'the request to finish');
    const deleting = env.orch.deleteConversation(first);
    await new Promise((r) => setTimeout(r, 30));
    // Nothing is removed before the save queued ahead of it has run.
    expect(existsSync(env.file(first))).toBe(true);
    release();
    await deleting;
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(env.file(first))).toBe(false);
    expect((await env.make().loadConversations()).list.map((c) => c.id)).toEqual(['c_brief1']);
  });

  it('a request’s save queued after a rename never writes the old name back, and a failed rename leaves the next one standing', async () => {
    const env = await setup();
    const open = await env.ask('Write an About page');
    // The rename waits its turn; meanwhile a request runs and ends, its save queued behind the rename.
    let release = hold(env.orch);
    const renamed = env.orch.renameConversation(open, 'About page');
    expect((await env.orch.send('And a footer', env.ctx, open)).ok).toBe(true);
    await until(() => !env.orch.busy, 'the request to finish');
    release();
    await renamed;
    // A list read waits its turn behind the request's own save: the file is final after it.
    await env.orch.loadConversations();
    expect(env.stored(open).messages).toHaveLength(4);
    expect(env.stored(open)).toMatchObject({ title: 'About page', named: true });

    // Two renames in a row, the first failing to save: the second is the name, in memory and on disk.
    release = hold(env.orch);
    // Only this conversation's next write fails; the project's own files are written as usual.
    const real = fsPromises.writeFile.bind(fsPromises) as (...a: unknown[]) => Promise<void>;
    let failed = false;
    const write = vi.spyOn(fsPromises, 'writeFile').mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (failed || !String(path).includes(`${open}.json`)) return real(path, ...rest);
      failed = true;
      return Promise.reject(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
    }) as typeof fsPromises.writeFile);
    const first = env.orch.renameConversation(open, 'Failed name');
    const second = env.orch.renameConversation(open, 'Final name');
    release();
    try {
      await expect(first).rejects.toThrow(/ENOSPC/);
      await expect(second).resolves.toEqual({ id: open, title: 'Final name' });
    } finally {
      write.mockRestore();
    }
    expect((await env.orch.loadConversations()).active.title).toBe('Final name');
    expect(env.stored(open).title).toBe('Final name');
  });

  it('a save queued before a rename keeps the name even after switching away, and a rename while a request runs is saved first', async () => {
    const env = await setup();
    const open = await env.ask('Write an About page');
    // Rename queued; a request ends and queues its save; the author starts a new conversation before either runs.
    let release = hold(env.orch);
    const renamed = env.orch.renameConversation(open, 'About page');
    expect((await env.orch.send('And a footer', env.ctx, open)).ok).toBe(true);
    await until(() => !env.orch.busy, 'the request to finish');
    await env.orch.newConversation();
    release();
    await renamed;
    await env.orch.loadConversations();
    expect(env.stored(open)).toMatchObject({ title: 'About page', named: true });
    expect(env.stored(open).messages).toHaveLength(4);

    // Back in it: a rename asked for just before a request starts is written to the saved file when its turn
    // comes, before it is answered, and never with the running request's messages.
    await env.orch.openConversation(open);
    release = hold(env.orch);
    const renaming = env.orch.renameConversation(open, 'About and footer');
    env.adapter.hold = true;
    expect((await env.orch.send('And a contact form', env.ctx, open)).ok).toBe(true);
    await until(() => env.adapter.waiting, 'the request to stream');
    release();
    await renaming;
    expect(env.stored(open)).toMatchObject({ title: 'About and footer', named: true });
    expect(env.stored(open).messages).toHaveLength(4);
    env.adapter.release();
    await until(() => !env.orch.busy, 'the request to finish');
    await env.orch.loadConversations();
    expect(env.stored(open)).toMatchObject({ title: 'About and footer', named: true });
    expect(env.stored(open).messages).toHaveLength(6);
  });

  it('a first request that reads “New conversation” stays the title after the next one', async () => {
    const env = await setup();
    const open = await env.ask('New conversation');
    await env.ask('Add a gallery page');
    expect(env.stored(open).title).toBe('New conversation');
    expect(env.stored(open).named).toBeUndefined();
  });

  it('a delete that fails leaves the save queued before it to land, and one already under way refuses a second', async () => {
    const env = await setup();
    const open = await env.ask('Try an interview experiment');
    const release = hold(env.orch);
    expect((await env.orch.send('One more question', env.ctx, open)).ok).toBe(true);
    await until(() => !env.orch.busy, 'the request to finish');
    const rm = vi.spyOn(fsPromises, 'rm').mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
    try {
      const deleting = env.orch.deleteConversation(open);
      await expect(env.orch.deleteConversation(open)).rejects.toThrow(/already being deleted/);
      release();
      await expect(deleting).rejects.toThrow(/EPERM/);
    } finally {
      rm.mockRestore();
    }
    // The request that ended before the delete was asked for reached the disk.
    expect(env.stored(open).messages.map((m) => m.text).filter((t, i) => i % 2 === 0)).toEqual(['Try an interview experiment', 'One more question']);
  });

  it('a delete that fails leaves the conversation listed, open and saved, and can be tried again', async () => {
    const env = await setup();
    const open = await env.ask('Try an interview experiment');
    const rm = vi.spyOn(fsPromises, 'rm').mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
    try {
      await expect(env.orch.deleteConversation(open)).rejects.toThrow(/EPERM/);
    } finally {
      rm.mockRestore();
    }
    expect((await env.orch.loadConversations()).list.map((c) => c.id)).toEqual([open]);
    expect((await env.orch.loadConversations()).active.id).toBe(open);
    // Its next request is saved as usual.
    await env.ask('Keep going');
    expect(env.stored(open).messages).toHaveLength(4);
    await env.orch.deleteConversation(open);
    expect(existsSync(env.file(open))).toBe(false);
  });

  it('nothing is renamed or deleted while the whole history is being cleared', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage', '2026-11-20T09:00:00.000Z']]));
    await env.orch.openConversation('c_brief1');
    const release = hold(env.orch);
    const clearing = env.orch.clearHistory();
    await expect(env.orch.renameConversation('c_brief1', 'Keeper')).rejects.toThrow(/being cleared/);
    await expect(env.orch.deleteConversation('c_brief1')).rejects.toThrow(/being cleared/);
    release();
    await clearing;
    await new Promise((r) => setTimeout(r, 30));
    // The clear is the last word: no rename brought the thread back.
    expect(existsSync(env.chatDir)).toBe(false);
  });

  it('a rename or delete waiting its turn while the project becomes read-only is refused, and changes nothing', async () => {
    const env = await setup();
    env.write(thread('c_brief1', [['Design a calm homepage', '2026-11-20T09:00:00.000Z']]));
    env.write(thread('c_brief2', [['Design a calm homepage for the shop', '2026-11-21T09:00:00.000Z']]));
    await env.orch.openConversation('c_brief1');
    const before = readFileSync(env.file('c_brief2'), 'utf8');
    const release = hold(env.orch);
    const renamingOpen = env.orch.renameConversation('c_brief1', 'Keeper');
    const renaming = env.orch.renameConversation('c_brief2', 'Shop');
    const deleting = env.orch.deleteConversation('c_brief2');
    env.session.readOnly = { reason: 'Another app is editing this project.', canUnlock: false } as typeof env.session.readOnly;
    release();
    await expect(renamingOpen).rejects.toThrow(/Another app/);
    await expect(renaming).rejects.toThrow(/Another app/);
    await expect(deleting).rejects.toThrow(/Another app/);
    env.session.readOnly = null;
    expect(readFileSync(env.file('c_brief2'), 'utf8')).toBe(before);
    expect((await env.orch.loadConversations()).active.title).toBe('Design a calm homepage');
  });

  it('deleting the conversation whose request edited the site keeps the edit and its step in History, which still undoes', async () => {
    const env = await setup();
    const rename = { type: 'site.update', name: 'Kiln and Clay' };
    env.adapter.script.push(
      [{ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id: 'r1', name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: env.session.revision, scope: { kind: 'site', targetIds: [] }, operations: [rename] }) }] }],
      [{ type: 'text', delta: 'Renamed the site.' }, { type: 'done', stopReason: 'end', text: 'Renamed the site.', toolCalls: [] }]
    );
    const open = await env.ask('Rename the site to Kiln and Clay');
    expect(env.session.state.site.name).toBe('Kiln and Clay');
    const steps = env.session.historyInfo();
    const step = steps.entries.filter((e) => e.applied).at(-1)!;
    expect(step.runId).toBeTruthy();

    const fresh = await env.orch.deleteConversation(open);
    expect(fresh.messages).toEqual([]);
    expect(existsSync(env.file(open))).toBe(false);
    expect(env.session.state.site.name).toBe('Kiln and Clay');
    expect(env.session.historyInfo()).toEqual(steps);
    expect((await env.session.undo()).ok).toBe(true);
    expect(env.session.state.site.name).toBe('Studio');
  });
});
