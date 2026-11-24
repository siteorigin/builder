/**
 * Reviewing an earlier AI turn in History and taking it back without guessing (issue 164): what the turn changed and
 * what came after it, named with their values; the turn undone on its own when every later change is separate from
 * it, as one step that can itself be undone; and refused, changing nothing, when a later change depends on it, which
 * leaves History's step back through both.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { headerMenu } from '@engine/tree';
import { runStanding } from '@shared/turns';
import type { InstanceNode } from '@shared/types';
import type { ChatMessage } from '@shared/api';
import { ProjectSession } from '../../src/main/project/session';
import { reviewEntryId, reviewNote, standingNote, undoableId } from '../../src/renderer/src/lib/result';
import { reviewPlan, stepChangeText, turnName } from '../../src/renderer/src/lib/turn-review';
import { ownAddress, stepChanges } from '../../src/main/project/turn-review';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-turn-review-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Field Notes Bookshop', false));
  open.push(s);
  return { dir, s };
}
async function reopen(dir: string) {
  const s = await ProjectSession.open(dir, 'test');
  open.push(s);
  return s;
}
async function ok(p: Promise<{ ok: boolean; error?: { message: string } }>) {
  const r = await p;
  expect(r.error?.message).toBeUndefined();
  expect(r.ok).toBe(true);
  return r;
}

const PICKS = 'pg_staffpicks';
/** The AI adds a Staff picks page with a link to it in the header: one History step carrying its run. */
async function addStaffPicks(s: ProjectSession, runId = 'run_picks') {
  expect(await s.beginRun(runId)).toBeNull();
  await ok(s.apply({ operations: [{ type: 'page.create', pageId: PICKS, title: 'Staff picks', route: '/staff-picks/', starter: 'intro', addToNavigation: true }] }, { label: 'AI', source: 'ai', runId, history: false }));
  expect(await s.completeRun('AI: Add a Staff picks page')).toBe(true);
  const entry = s.historyInfo().entries.find((e) => e.runId === runId)!;
  expect(menuTargets(s)).toContain(PICKS);
  return entry.id;
}
const homeId = (s: ProjectSession) => s.state.site.homePageId;
const menuTargets = (s: ProjectSession) => ((headerMenu(s.state)?.node.props.links ?? []) as Array<{ link: { target: string } }>).map((l) => l.link.target);
const setHomeTitle = (s: ProjectSession, seoTitle: string) => ok(s.apply({ operations: [{ type: 'page.update', pageId: homeId(s), seoTitle }] }, { label: 'Change browser title (Home)' }));
/** The Home hero's main button, which takes a link. */
const hero = (s: ProjectSession) => s.state.pages[homeId(s)].rootIds.find((id) => s.state.components[(s.state.pages[homeId(s)].nodes[id] as InstanceNode).definitionId]?.componentId === 'hero.split')!;
const linkHero = (s: ProjectSession, value: unknown) => ok(s.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId(s) }, nodeId: hero(s), prop: 'primaryLink', value }] }, { label: 'Change button link' }));
const standing = (s: ProjectSession, runId = 'run_picks') => runStanding(runId, s.historyInfo());
/** Everything a refused change must leave alone. */
const unchanged = (s: ProjectSession) => ({ state: JSON.stringify(s.state), revision: s.revision, history: JSON.stringify(s.historyInfo()) });

describe('reviewing an earlier AI turn (issue 164)', () => {
  it('takes the turn back on its own and keeps a later, unrelated Browser title on Home', async () => {
    const { dir, s } = await make();
    const siteBefore = readFileSync(join(dir, 'siteorigin/site.json'), 'utf8');
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'November client proof');
    // The turn is no longer the newest step, so the card's Undo turn is refused, and a step back in History takes the
    // title with it.
    expect((await s.undoGroup('run_picks')).ok).toBe(false);

    const before = unchanged(s);
    const { review } = await s.reviewAiEntry(entryId);
    // A review never writes.
    expect(unchanged(s)).toEqual(before);
    expect(review).toMatchObject({ entryId, runId: 'run_picks', label: 'AI: Add a Staff picks page', revision: s.revision, applied: true, redoable: 0, revert: { ok: true } });
    expect(review!.changes).toEqual(
      expect.arrayContaining([
        { owner: 'Staff picks', property: 'Page', change: 'added', after: '/staff-picks/' },
        { owner: 'Header', property: 'Link', change: 'added', after: 'Staff picks' }
      ])
    );
    expect(review!.later).toHaveLength(1);
    expect(review!.later[0]).toMatchObject({ label: 'Change browser title (Home)', source: 'user', relation: 'separate' });
    expect(review!.later[0].changes).toEqual([{ owner: 'Home', property: 'Browser title', change: 'added', after: 'November client proof' }]);

    const r = await ok(s.revertAiEntry(entryId, { revision: review!.revision, history: review!.history }));
    expect(s.state.pages[PICKS]).toBeUndefined();
    expect(menuTargets(s)).not.toContain(PICKS);
    expect(s.state.pages[homeId(s)].seo.title).toBe('November client proof');
    // The site settings and header are exactly as they were before the turn.
    expect(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8')).toBe(siteBefore);
    // One new step, which reads the turn as undone, and the turn's own step stays where it was.
    const steps = s.historyInfo().entries;
    expect(steps.map((e) => e.label)).toEqual([...JSON.parse(before.history).entries.map((e: { label: string }) => e.label), 'Undo AI turn: Add a Staff picks page']);
    expect(steps.at(-1)).toMatchObject({ id: (r as { entryId?: string }).entryId, source: 'user', revertsRunId: 'run_picks', applied: true });
    expect(steps.find((e) => e.id === entryId)?.applied).toBe(true);
    expect(standing(s)).toBe('undone');
    const again = await s.reviewAiEntry(entryId);
    expect(again.review?.revertedBy?.label).toBe('Undo AI turn: Add a Staff picks page');
    expect(again.review?.revert).toEqual({ ok: false, reason: 'It was already undone on its own by “Undo AI turn: Add a Staff picks page”. Undo that change to bring the turn back.' });

    // Undoing that step brings the turn back, title kept; redoing takes it away again.
    await ok(s.undo());
    expect(s.state.pages[PICKS]?.title).toBe('Staff picks');
    expect(menuTargets(s)).toContain(PICKS);
    expect(s.state.pages[homeId(s)].seo.title).toBe('November client proof');
    expect(standing(s)).toBe('applied');
    await ok(s.redo());
    expect(s.state.pages[PICKS]).toBeUndefined();
    expect(standing(s)).toBe('undone');

    await s.close();
    const s2 = await reopen(dir);
    expect(s2.state.pages[PICKS]).toBeUndefined();
    expect(s2.state.pages[s2.state.site.homePageId].seo.title).toBe('November client proof');
    expect(standing(s2)).toBe('undone');
  });

  it('names a later change to the page the turn added, refuses to take the turn back alone, and leaves the step back through both', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await ok(s.apply({ operations: [{ type: 'page.update', pageId: PICKS, seoTitle: 'Our favourite books' }] }, { label: 'Change browser title (Staff picks)' }));
    const laterId = s.historyInfo().entries.at(-1)!.id;

    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later).toHaveLength(1);
    expect(review!.later[0]).toMatchObject({ entryId: laterId, relation: 'depends', reason: 'It changes Staff picks, which this turn added.' });
    expect(review!.later[0].changes).toEqual([{ owner: 'Staff picks', property: 'Browser title', change: 'added', after: 'Our favourite books' }]);
    expect(review!.revert).toEqual({ ok: false, reason: 'A later change depends on it, so it can only be undone together with that change.' });

    // Asked for anyway, it changes nothing.
    const before = unchanged(s);
    expect(await s.revertAiEntry(entryId, { revision: review!.revision })).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: review!.revert.ok ? '' : review!.revert.reason } });
    expect(unchanged(s)).toEqual(before);

    // The safe way back is History's step through both, which keeps both redoable.
    await ok(s.stepTo(entryId, 'undo', { revision: s.revision, count: 2 }));
    expect(s.state.pages[PICKS]).toBeUndefined();
    expect(menuTargets(s)).not.toContain(PICKS);
    expect(standing(s)).toBe('undone');
    await ok(s.stepTo(laterId, 'redo', { revision: s.revision, count: 2 }));
    expect(s.state.pages[PICKS]?.seo.title).toBe('Our favourite books');
    expect(menuTargets(s)).toContain(PICKS);
  });

  it('refuses when a later change elsewhere links to the page the turn added, and says so', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await linkHero(s, { type: 'page', target: PICKS });
    const { review } = await s.reviewAiEntry(entryId);
    // On documents of its own, but it relies on the turn: it goes back with it.
    expect(review!.later[0]).toMatchObject({ relation: 'depends', reason: 'It adds a link to “Staff picks”, which this turn added.' });
    expect(review!.revert).toEqual({ ok: false, reason: 'A later change depends on it, so it can only be undone together with that change.' });
    const before = unchanged(s);
    expect((await s.revertAiEntry(entryId, { revision: s.revision })).ok).toBe(false);
    expect(unchanged(s)).toEqual(before);
  });

  it('refuses when a later change links to the page by the site’s own web address', async () => {
    const { s } = await make();
    await ok(s.apply({ operations: [{ type: 'site.update', baseUrl: 'https://books.example' }] }, { label: 'Set website address' }));
    const entryId = await addStaffPicks(s);
    // A full address names no page, so no check notices when the page goes.
    await linkHero(s, { type: 'url', target: 'https://books.example/staff-picks/' });
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later[0]).toMatchObject({ relation: 'depends', reason: 'It adds a link to “Staff picks”, which this turn added.' });
    expect(review!.revert.ok).toBe(false);
    expect((await s.revertAiEntry(entryId, { revision: s.revision })).ok).toBe(false);
    expect(s.state.pages[PICKS]).toBeDefined();

    // A link to another of the site's pages by its address, or to that address on another site, is separate.
    for (const target of ['https://books.example/about/', 'https://elsewhere.example/staff-picks/']) {
      await ok(s.undo());
      await linkHero(s, { type: 'url', target });
      const separate = await s.reviewAiEntry(entryId);
      expect(separate.review?.later.map((l) => l.relation)).toEqual(['separate']);
      expect(separate.review?.revert).toEqual({ ok: true });
    }
  });

  it('refuses when a link typed before the turn would lead nowhere again', async () => {
    const { s } = await make();
    await ok(s.apply({ operations: [{ type: 'site.update', baseUrl: 'https://books.example' }] }, { label: 'Set website address' }));
    // Typed before the page existed, it works only while the turn's page is there.
    await linkHero(s, { type: 'url', target: 'https://books.example/staff-picks/' });
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'Kept');
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later.map((l) => l.relation)).toEqual(['separate']);
    expect(review!.revert).toEqual({ ok: false, reason: expect.stringMatching(/^Undoing it on its own would leave a problem: .* links to https:\/\/books\.example\/staff-picks\/, which would no longer be there\.$/) });
  });

  it('reads a typed address the way the site serves it', () => {
    const shop = [new URL('https://books.example/shop')];
    expect(ownAddress('https://BOOKS.example/shop/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B/?ref=home', shop)).toBe('/お問い合わせ/');
    expect(ownAddress('https://books.example/shop/staff-picks/index.html#top', shop)).toBe('/staff-picks/');
    expect(ownAddress('https://books.example/shop', shop)).toBe('/');
    expect(ownAddress('https://books.example/other/staff-picks/', shop)).toBeNull();
    expect(ownAddress('http://books.example/shop/staff-picks/', shop)).toBeNull();
    expect(ownAddress('not a url', shop)).toBeNull();
  });

  it('tells a later separate change on the same page from one there that links to the turn’s page', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'Kept');
    await linkHero(s, { type: 'page', target: PICKS });
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later.map((l) => [l.label, l.relation])).toEqual([
      ['Change browser title (Home)', 'separate'],
      ['Change button link', 'depends']
    ]);
  });

  it('refuses when taking back a page the turn published would leave a published page linking to a draft', async () => {
    const { s } = await make();
    await ok(s.apply({ operations: [{ type: 'page.create', pageId: PICKS, title: 'Staff picks', route: '/staff-picks/' }] }, { label: 'Add page' }));
    await ok(s.apply({ operations: [{ type: 'page.update', pageId: PICKS, draft: true }] }, { label: 'Make draft' }));
    expect(await s.beginRun('run_publish')).toBeNull();
    await ok(s.apply({ operations: [{ type: 'page.update', pageId: PICKS, draft: false }] }, { label: 'AI', source: 'ai', runId: 'run_publish', history: false }));
    expect(await s.completeRun('AI: Publish Staff picks')).toBe(true);
    const entryId = s.historyInfo().entries.at(-1)!.id;
    await linkHero(s, { type: 'page', target: PICKS });
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.changes).toEqual([{ owner: 'Staff picks', property: 'Draft', change: 'changed', before: 'Yes', after: 'No' }]);
    expect(review!.later.map((l) => l.relation)).toEqual(['separate']);
    expect(review!.revert).toEqual({ ok: false, reason: expect.stringMatching(/^Undoing it on its own would leave a problem: a published page would link to a draft/) });
  });

  it('treats a later change to where a component is used as depending on a turn that changed its design', async () => {
    const { s } = await make();
    // The site's own copy of the hero, which the AI can redesign.
    await ok(s.apply({ operations: [{ type: 'component.fork', definitionId: (s.state.pages[homeId(s)].nodes[hero(s)] as InstanceNode).definitionId }] }, { label: 'Fork hero' }));
    const def = (s.state.pages[homeId(s)].nodes[hero(s)] as InstanceNode).definitionId;
    expect(s.state.components[def].owner).toBe('project');
    expect(await s.beginRun('run_design')).toBeNull();
    await ok(s.apply({ operations: [{ type: 'component.rename', definitionId: def, name: 'Shop hero' }] }, { label: 'AI', source: 'ai', runId: 'run_design', history: false }));
    expect(await s.completeRun('AI: Rename the hero')).toBe(true);
    const entryId = s.historyInfo().entries.at(-1)!.id;
    await setHomeTitle(s, 'Kept');
    await ok(s.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId(s) }, nodeId: hero(s), prop: 'heading', value: 'Read with us' }] }, { label: 'Change heading' }));
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later.map((l) => [l.label, l.relation, l.reason])).toEqual([
      ['Change browser title (Home)', 'separate', undefined],
      ['Change heading', 'depends', 'It changes where “Shop hero” is used, after this turn changed its design.']
    ]);
    expect(review!.later[1].changes).toEqual([expect.objectContaining({ owner: 'Home', property: 'Heading', after: 'Read with us' })]);
  });

  it('treats a later change to the site settings the turn also changed as depending on it', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await ok(s.apply({ operations: [{ type: 'site.update', name: 'Field Notes' }] }, { label: 'Rename site' }));
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later[0]).toMatchObject({ relation: 'depends', reason: 'It changes the site settings, header or footer, which this turn changed too.' });
    // The rename shows wherever the site shows its name, each with the value it had.
    expect(review!.later[0].changes).toEqual(
      expect.arrayContaining([
        { owner: 'Site settings', property: 'Site name', change: 'changed', before: 'Field Notes Bookshop', after: 'Field Notes' },
        { owner: 'Footer', property: 'Copyright', change: 'changed', before: expect.stringMatching(/ Field Notes Bookshop\. All rights reserved\.$/), after: expect.stringMatching(/ Field Notes\. All rights reserved\.$/) }
      ])
    );
    expect(review!.revert.ok).toBe(false);
    const before = unchanged(s);
    expect((await s.revertAiEntry(entryId, { revision: review!.revision, history: review!.history })).ok).toBe(false);
    expect(unchanged(s)).toEqual(before);
  });

  it('refuses a review that is out of date, a busy AI, and a step that is not an AI turn', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'First');
    const { review } = await s.reviewAiEntry(entryId);
    await setHomeTitle(s, 'Second');
    expect(await s.revertAiEntry(entryId, { revision: review!.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(s.state.pages[PICKS]).toBeDefined();
    // History moved without the revision moving (steps let go): what the review said no longer holds.
    const fresh = (await s.reviewAiEntry(entryId)).review!;
    expect(await s.revertAiEntry(entryId, { revision: fresh.revision, history: `${fresh.history}x` })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(s.state.pages[PICKS]).toBeDefined();
    const titleStep = s.historyInfo().entries.at(-1)!.id;
    expect(await s.reviewAiEntry(titleStep)).toEqual({ ok: false, message: 'That change was not made by the AI.' });
    await s.beginRun('run_busy');
    expect(await s.revertAiEntry(entryId, { revision: s.revision })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  });

  it('says an undone turn is already undone, and counts the undone changes a revert would leave no longer redoable', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await ok(s.undo());
    expect((await s.reviewAiEntry(entryId)).review).toMatchObject({ applied: false, later: [], redoable: 1, revert: { ok: false, reason: 'It is already undone.' } });
    await ok(s.redo());
    await setHomeTitle(s, 'Kept');
    await setHomeTitle(s, 'Undone');
    await ok(s.apply({ operations: [{ type: 'site.update', name: 'Also undone' }] }, { label: 'Rename site' }));
    await ok(s.undo());
    await ok(s.undo());
    const { review } = await s.reviewAiEntry(entryId);
    expect(review).toMatchObject({ redoable: 2, revert: { ok: true } });
    expect(review!.later.map((l) => l.label)).toEqual(['Change browser title (Home)']);
    // Taken back on its own, the two undone changes leave redo.
    await ok(s.revertAiEntry(entryId, { revision: review!.revision, history: review!.history }));
    expect(s.historyInfo().canRedo).toBe(false);
    expect(s.state.pages[homeId(s)].seo.title).toBe('Kept');
  });
});

describe('where a turn taken back on its own stands once History lets steps go (issue 164)', () => {
  it('stays undone when its own step goes, and when the step that took it back goes too', async () => {
    const { dir, s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'Kept');
    await ok(s.revertAiEntry(entryId, { revision: s.revision }));
    // Only the newest step is kept: the turn's own step goes as applied, while the step that took it back stays.
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(s.historyInfo().entries.map((e) => e.revertsRunId)).toEqual(['run_picks']);
    expect(standing(s)).toBe('undone');
    // Then that step goes too, applied: the turn stays undone.
    s.historyByteLimit = Infinity;
    await setHomeTitle(s, 'Later');
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(s.historyInfo().entries.some((e) => e.revertsRunId)).toBe(false);
    expect(standing(s)).toBe('undone');
    await s.close();
    expect(standing(await reopen(dir))).toBe('undone');
  });

  it('stands applied again once the step that took it back is undone and then replaced', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'Kept');
    await ok(s.revertAiEntry(entryId, { revision: s.revision }));
    await ok(s.undo());
    expect(standing(s)).toBe('applied');
    // A new change drops the undone revert from redo: it took nothing back.
    await setHomeTitle(s, 'New');
    expect(s.historyInfo().entries.some((e) => e.revertsRunId)).toBe(false);
    expect(standing(s)).toBe('applied');
    expect(s.state.pages[PICKS]).toBeDefined();
  });

  it('stands applied once its own step has gone and the undone step that took it back is replaced', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'Kept');
    await ok(s.revertAiEntry(entryId, { revision: s.revision }));
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(s.historyInfo().entries.map((e) => e.revertsRunId)).toEqual(['run_picks']);
    s.historyByteLimit = Infinity;
    // Undone, the revert took nothing back; replaced, it goes as undone and leaves the turn as History noted it.
    await ok(s.undo());
    expect(standing(s)).toBe('applied');
    await setHomeTitle(s, 'New');
    expect(standing(s)).toBe('applied');
    expect(s.state.pages[PICKS]).toBeDefined();
  });
});

describe('the chat card and History’s words for an earlier AI turn (issue 164)', () => {
  const reply = (runId: string, canUndo = true): ChatMessage => ({ id: `m_${runId}`, role: 'assistant', text: '', time: '2026-11-25T00:00:00.000Z', runId, result: { status: 'completed', summary: 'Added Staff picks.', changes: [], validation: [], canUndo } });

  it('offers Review in history on the card once Undo turn has gone, and says why on the latest card', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    const card = reply('run_picks');
    // While it is the newest step, the card offers Undo turn and nothing to review.
    expect(undoableId([card], s.historyInfo())).toBe(card.id);
    expect(reviewEntryId(card, s.historyInfo(), true)).toBeUndefined();
    await setHomeTitle(s, 'November client proof');
    expect(undoableId([card], s.historyInfo())).toBeUndefined();
    expect(reviewEntryId(card, s.historyInfo(), false)).toBe(entryId);
    expect(reviewNote(card, s.historyInfo(), true, true)).toMatch(/^Changes were made after this turn, so it can no longer be undone from here\. Review it in History/);
    // An older card just offers the review, a card with nothing to review says nothing, and a turn that changed
    // nothing has none.
    expect(reviewNote(card, s.historyInfo(), false, true)).toBeUndefined();
    expect(reviewNote(card, s.historyInfo(), true, false)).toBeUndefined();
    expect(reviewEntryId(reply('run_picks', false), s.historyInfo(), false)).toBeUndefined();
    expect(reviewEntryId(reply('run_gone'), s.historyInfo(), false)).toBeUndefined();

    // Once taken back on its own, the card reads as undone, still offers the review, and an unfinished one says how
    // to bring it back.
    await ok(s.revertAiEntry(entryId, { revision: s.revision }));
    expect(reviewEntryId(card, s.historyInfo(), false)).toBe(entryId);
    expect(reviewNote(card, s.historyInfo(), true, true)).toBeUndefined();
    const unfinished: ChatMessage = { ...card, result: { ...card.result!, incomplete: true } };
    expect(standingNote(unfinished, s.historyInfo(), true)).toBe('These changes were reverted, so this request can only be continued once that revert is undone.');
  });

  it('says what each way back takes and keeps', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'November client proof');
    const { review } = await s.reviewAiEntry(entryId);
    const plan = reviewPlan(review!, s.historyInfo().entries);
    expect(plan.revert).toEqual({ ok: true, text: 'Takes back what this turn changed and keeps the 1 change made after it.', keeps: ['Change browser title (Home)'] });
    expect(plan.step).toMatchObject({ direction: 'undo', count: 2, text: 'Undo 2 changes', takes: ['Change browser title (Home)', 'AI: Add a Staff picks page'], note: 'Undoes this turn and the 1 change after it, newest first. You can redo them until you make a new change.' });
    expect(turnName(review!.label)).toBe('Add a Staff picks page');
    expect(review!.later[0].changes.map(stepChangeText)).toEqual(['Home · Browser title: added “November client proof”']);
    expect(review!.changes.map(stepChangeText)).toEqual(expect.arrayContaining(['Staff picks · Page: added “/staff-picks/”', 'Header · Link: added “Staff picks”']));

    // With an undone change waiting to be redone, undoing the turn on its own says that change can no longer be.
    await setHomeTitle(s, 'Undone');
    await ok(s.undo());
    const withRedo = reviewPlan((await s.reviewAiEntry(entryId)).review!, s.historyInfo().entries);
    expect(withRedo.revert).toMatchObject({ ok: true, lost: '1 change you undid can no longer be redone.' });

    // Taken back on its own, a step back through it is not offered: it would undo later work and leave the turn as it is.
    await ok(s.revertAiEntry(entryId, { revision: s.revision }));
    expect(reviewPlan((await s.reviewAiEntry(entryId)).review!, s.historyInfo().entries)).toMatchObject({ revert: { ok: false }, step: null });
  });

  it('puts an undone turn back with the undone changes before it, oldest first', async () => {
    const { s } = await make();
    await setHomeTitle(s, 'Before');
    const entryId = await addStaffPicks(s);
    await ok(s.undo());
    await ok(s.undo());
    const plan = reviewPlan((await s.reviewAiEntry(entryId)).review!, s.historyInfo().entries);
    expect(plan.revert).toEqual({ ok: false, reason: 'It is already undone.' });
    expect(plan.step).toMatchObject({ direction: 'redo', count: 2, text: 'Redo 2 changes', takes: ['Change browser title (Home)', 'AI: Add a Staff picks page'], note: 'Redoes the 1 change before it, then this turn.' });
  });

  it('describes sections moved on a page, and a document it can’t read, without failing the review', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    const [first] = s.state.pages[homeId(s)].rootIds;
    await ok(s.apply({ operations: [{ type: 'node.move', owner: { kind: 'page', id: homeId(s) }, nodeId: first, parentId: null, index: 2 }] }, { label: 'Move section' }));
    const { review } = await s.reviewAiEntry(entryId);
    expect(review!.later[0].changes).toEqual([{ owner: 'Home', property: 'Sections', change: 'changed', detail: 'Order changed' }]);
    // A text element with no tag, as no version of the editor writes it, and a code file that reads as JSON null.
    const page = { title: 'Broken', route: '/broken/', nodes: { n_x: { id: 'n_x', kind: 'text', text: 'a' } }, rootIds: ['n_x'] };
    const changed = { ...page, nodes: { n_x: { id: 'n_x', kind: 'text', text: 'b' } } };
    expect(stepChanges([{ path: 'siteorigin/pages/pg_broken.json', before: page, after: changed }], s.state)).toEqual([{ owner: 'Broken', property: 'Details', change: 'changed' }]);
    expect(stepChanges([{ path: 'src/lib/siteorigin/custom/Thing.svelte', before: 'null', after: '<p>x</p>' }], s.state)).toEqual([{ owner: 'Thing', property: 'Component code', change: 'changed' }]);
  });

  it('words a value changed, removed, and one with no single value', () => {
    expect(stepChangeText({ owner: 'Site settings', property: 'Site name', change: 'changed', before: 'A', after: 'B' })).toBe('Site settings · Site name: “A” → “B”');
    expect(stepChangeText({ owner: 'Header', property: 'Link', change: 'removed', before: 'Staff picks' })).toBe('Header · Link: removed “Staff picks”');
    expect(stepChangeText({ owner: 'Home', property: 'Content', change: 'changed', detail: '1 element added' })).toBe('Home · Content: 1 element added');
    expect(stepChangeText({ owner: 'Site styles', property: 'Theme', change: 'changed' })).toBe('Site styles · Theme: changed');
    expect(stepChangeText({ owner: 'Library', property: 'File', change: 'removed' })).toBe('Library · File: removed');
    expect(stepChangeText({ owner: 'Shop', property: 'Component', change: 'added' })).toBe('Shop · Component: added');
  });
});
