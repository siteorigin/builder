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

    const r = await ok(s.revertAiEntry(entryId, { revision: review!.revision }));
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
    expect(review!.later[0]).toMatchObject({ relation: 'depends', reason: expect.stringMatching(/page that no longer exists/) });
    expect(review!.revert).toEqual({ ok: false, reason: expect.stringMatching(/^Undoing it on its own would leave a problem: .*page that no longer exists/) });
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
    expect(review!.later[0]).toMatchObject({ relation: 'depends', reason: expect.stringContaining('links to https://books.example/staff-picks/, which this turn added.') });
    expect(review!.revert).toEqual({ ok: false, reason: expect.stringContaining('links to https://books.example/staff-picks/, which would no longer be there.') });
    expect((await s.revertAiEntry(entryId, { revision: s.revision })).ok).toBe(false);
    expect(s.state.pages[PICKS]).toBeDefined();

    // A link to another of the site's pages by its address is separate from the turn.
    await ok(s.undo());
    await linkHero(s, { type: 'url', target: 'https://books.example/about/' });
    const separate = await s.reviewAiEntry(entryId);
    expect(separate.review?.later.map((l) => l.relation)).toEqual(['separate']);
    expect(separate.review?.revert).toEqual({ ok: true });
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
  });

  it('refuses a review that is out of date, a busy AI, and a step that is not an AI turn', async () => {
    const { s } = await make();
    const entryId = await addStaffPicks(s);
    await setHomeTitle(s, 'First');
    const { review } = await s.reviewAiEntry(entryId);
    await setHomeTitle(s, 'Second');
    expect(await s.revertAiEntry(entryId, { revision: review!.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
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
    await ok(s.undo());
    const { review } = await s.reviewAiEntry(entryId);
    expect(review).toMatchObject({ redoable: 1, revert: { ok: true } });
    expect(review!.later.map((l) => l.label)).toEqual(['Change browser title (Home)']);
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
});

describe('the chat card and History’s words for an earlier AI turn (issue 164)', () => {
  const reply = (runId: string, canUndo = true): ChatMessage => ({ id: `m_${runId}`, role: 'assistant', text: '', runId, result: { status: 'completed', summary: 'Added Staff picks.', changes: [], validation: [], canUndo } });

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
    // An older card just offers the review, and a turn that changed nothing has none.
    expect(reviewNote(card, s.historyInfo(), false, true)).toBeUndefined();
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
  });

  it('words a value changed, removed, and one with no single value', () => {
    expect(stepChangeText({ owner: 'Site settings', property: 'Site name', change: 'changed', before: 'A', after: 'B' })).toBe('Site settings · Site name: “A” → “B”');
    expect(stepChangeText({ owner: 'Header', property: 'Link', change: 'removed', before: 'Staff picks' })).toBe('Header · Link: removed “Staff picks”');
    expect(stepChangeText({ owner: 'Home', property: 'Content', change: 'changed', detail: '1 element added' })).toBe('Home · Content: 1 element added');
    expect(stepChangeText({ owner: 'Site styles', property: 'Theme', change: 'changed' })).toBe('Site styles · Theme: changed');
  });
});
