import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { ChatMessage } from '@shared/api';
import type { InstanceNode, ListItem } from '@shared/types';
import { saysUnchanged, answerOnly, canOpen, changeTarget, changeText, checksOf, continueContext, locationTarget, resumableId, retryableId, standingNote, undoableId } from '../../src/renderer/src/lib/result';
import { canCarryOn, resultAsSaid, runStanding, summaryNow, turnState, type TurnHistory } from '@shared/turns';

describe('AI result card', () => {
  it('counts only passing checks as passed, keeping unchecked ones apart from site problems', () => {
    const r = checksOf({
      validation: [],
      checks: [
        { status: 'pass', text: 'Fits the screen at phone width.' },
        { status: 'issue', text: 'An image failed to load at phone width (gone.jpg).' },
        { status: 'unverified', text: "Couldn't confirm that an image loaded at desktop width." },
        { status: 'pass', text: 'All components build without errors.' }
      ]
    });
    expect(r.passes).toHaveLength(2);
    expect(r.issues).toEqual(['An image failed to load at phone width (gone.jpg).']);
    expect(r.unverified).toEqual(["Couldn't confirm that an image loaded at desktop width."]);
  });

  it('still reads results stored before checks had a status from their wording', () => {
    const r = checksOf({ validation: ['Fits the screen at phone width.', 'No horizontal overflow detected.', 'Content is wider than the screen at tablet width.', "Couldn't check the layout at desktop width.", '2 pre-existing issues remain.', 'Stopped at the limit of 40 tool calls before the request was finished.'] });
    expect(r.passes).toEqual(['Fits the screen at phone width.', 'No horizontal overflow detected.']);
    expect(r.issues).toHaveLength(4);
    expect(r.unverified).toEqual([]);
  });

  it('opens page elements, shared header elements on a page that shows them, and says when one is gone', () => {
    let state = createStarterState('business', 'Test', false);
    const [home, about] = state.site.pageOrder;
    state = applyOperations(state, [{ type: 'page.update', pageId: about, showHeader: false, showFooter: false }]).state;
    const hero = state.pages[home].rootIds[0];
    const nav = state.site.shell.header.rootIds[0];
    const header = { kind: 'shell' as const, id: 'header' };

    expect(changeTarget(state, about, { label: 'x', pageId: home, nodeId: hero })).toEqual({ pageId: home, selection: { owner: { kind: 'page', id: home }, instancePath: [], nodeId: hero } });
    // The page on screen has no header, so the header is shown on the first page that has one; a page on screen
    // that shows it stays.
    expect(changeTarget(state, about, { label: 'x', owner: header, nodeId: nav })).toEqual({ pageId: home, selection: { owner: header, instancePath: [], nodeId: nav } });
    const contact = state.site.pageOrder[2];
    expect(changeTarget(state, contact, { label: 'x', owner: header, nodeId: nav })).toMatchObject({ pageId: contact });
    expect(changeTarget(state, home, { label: 'x', pageId: home, nodeId: 'gone' })).toMatchObject({ pageId: home, selection: null, note: expect.stringMatching(/no longer on Home/) });
    expect(changeTarget(state, home, { label: 'x', pageId: 'pg_missing' })).toEqual({ error: 'That page is no longer in the site.' });
    expect(changeTarget(state, home, { label: 'Changed the site style “Brand”' })).toBeNull();

    expect(canOpen({ label: 'x', owner: header, nodeId: nav })).toBe(true);
    expect(canOpen({ label: 'x', owner: header })).toBe(false);
    expect(canOpen({ label: 'x', owner: { kind: 'component', id: 'c' }, definitionId: 'c', nodeId: 'n' })).toBe(false);
  });

  it('shows a raw operation name stored by an older version as technical detail, not as the change', () => {
    expect(changeText({ label: 'node.setContent' })).toEqual({ label: 'Made a change', operations: ['node.setContent'] });
    expect(changeText({ label: 'Added image to Home', operations: ['node.insert'] })).toEqual({ label: 'Added image to Home', operations: ['node.insert'] });
    expect(changeText({ label: 'Added image to Home' })).toEqual({ label: 'Added image to Home', operations: [] });
  });
});

describe('continuing an unfinished request (#88)', () => {
  const user = (id: string, context?: ChatMessage['context']): ChatMessage => ({ id, role: 'user', text: 'Add two pages', time: '', ...(context ? { context } : {}) });
  const reply = (id: string, result?: Partial<NonNullable<ChatMessage['result']>>): ChatMessage => ({
    id,
    role: 'assistant',
    text: '',
    time: '',
    ...(result ? { result: { status: 'completed', summary: '', changes: [], validation: [], canUndo: false, ...result } } : {})
  });

  it('offers Continue only on the latest result, and only when it is unfinished', () => {
    expect(resumableId([user('u1'), reply('a1', { status: 'partial', incomplete: true })])).toBe('a1');
    expect(resumableId([user('u1'), reply('a1', { status: 'no-changes', incomplete: true })])).toBe('a1');
    expect(resumableId([user('u1'), reply('a1')])).toBeUndefined();
    // A completed run finished what it was asked: it is never carried on from.
    expect(resumableId([user('u1'), reply('a1', { status: 'completed', incomplete: true })])).toBeUndefined();
    // A newer request has moved on from the unfinished one.
    expect(resumableId([user('u1'), reply('a1', { status: 'partial', incomplete: true }), user('u2'), reply('a2')])).toBeUndefined();
    expect(resumableId([user('u1'), reply('a1', { status: 'partial', incomplete: true }), user('u2')])).toBeUndefined();
    // A failed run is offered Edit and try again instead; a stopped or conflicted one is the user's to review.
    expect(resumableId([user('u1'), reply('a1', { status: 'failed', incomplete: true })])).toBeUndefined();
    expect(resumableId([user('u1'), reply('a1', { status: 'cancelled', incomplete: true })])).toBeUndefined();
    expect(resumableId([user('u1'), reply('a1', { status: 'conflicted', incomplete: true })])).toBeUndefined();
    // Still running: its message has no result yet.
    expect(resumableId([user('u1'), reply('a1')])).toBeUndefined();
  });

  it('continues with the original page and selection, and never guesses a target that has gone', () => {
    const state = createStarterState('business', 'Test', false);
    const home = state.site.homePageId;
    const about = Object.values(state.pages).find((p) => p.route === '/about/')!;
    const hero = about.rootIds[0];
    const selection = { owner: { kind: 'page' as const, id: about.id }, instancePath: [], nodeId: hero };
    const ctx = { pageId: about.id, pageTitle: 'About', selection, selectionLabel: 'Hero', viewport: 390 };
    expect(continueContext(user('u', ctx), state, 1280)).toEqual({ ctx });
    // A request saved before messages carried a context was about the whole site.
    expect(continueContext(user('u'), state, 1280)).toEqual({ ctx: { pageId: home, pageTitle: state.pages[home].title, selection: null, selectionLabel: null, viewport: 1280 } });
    // The user picks the target: a selection is never dropped (it would widen the request), a page never swapped.
    const { state: without } = applyOperations(state, [{ type: 'node.remove', owner: { kind: 'page', id: about.id }, nodeId: hero }]);
    expect(continueContext(user('u', ctx), without, 1280)).toEqual({ error: 'Hero is no longer in the site. Choose what to change, then send "Continue".' });
    const { state: noAbout } = applyOperations(state, [{ type: 'page.remove', pageId: about.id, replacementPageId: home }]);
    expect(continueContext(user('u', { ...ctx, selection: null, selectionLabel: null }), noAbout, 1280)).toEqual({ error: 'About is no longer in the site. Choose what to change, then send "Continue".' });
    // A card without its request before it (an irregular saved conversation) is not continued blind.
    expect(continueContext(reply('a'), state, 1280)).toEqual({ error: 'Choose what to change, then send "Continue".' });
    expect(continueContext(undefined, state, 1280)).toEqual({ error: 'Choose what to change, then send "Continue".' });
  });

  it('continues with the images the request attached, and names one removed since (#12)', () => {
    const state = createStarterState('business', 'Test', false);
    const home = state.site.homePageId;
    const photo = (id: string, name: string) => ({ id, name, file: `static/assets/${id.replace('_', '-')}.jpg`, mime: 'image/jpeg', bytes: 1000, width: 1536, height: 1024, hash: id, kind: 'image' as const, createdAt: '2026-01-01T00:00:00Z' });
    const nook = photo('a_nook', 'Reading nook');
    const kitchen = photo('a_kitchen', 'Kitchen');
    const font = { id: 'a_font', name: 'Brand Sans', file: 'static/assets/brand-sans.woff2', mime: 'font/woff2', bytes: 1000, hash: 'f', kind: 'font' as const, createdAt: '2026-01-01T00:00:00Z', font: { family: 'Brand Sans', weight: '400', style: 'normal' as const } };
    const { state: both } = applyOperations(state, [{ type: 'asset.add', asset: nook }, { type: 'asset.add', asset: kitchen }, { type: 'asset.add', asset: font }]);
    const ctx = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, assetIds: [nook.id, kitchen.id] };
    const request = { ...user('u', ctx), images: [{ assetId: nook.id, name: 'Reading nook' }, { assetId: kitchen.id, name: 'Kitchen' }] };
    expect(continueContext(request, both, 1280)).toEqual({ ctx });
    // The second image has gone: the request is not continued without it, and the message names that one.
    const { state: noKitchen } = applyOperations(both, [{ type: 'asset.remove', assetId: kitchen.id }]);
    expect(continueContext(request, noKitchen, 1280)).toEqual({ error: 'The image “Kitchen” is no longer in Assets. Attach the images you want, then send "Continue".' });
    // With both gone, the first is named.
    const { state: neither } = applyOperations(noKitchen, [{ type: 'asset.remove', assetId: nook.id }]);
    expect(continueContext(request, neither, 1280)).toEqual({ error: 'The image “Reading nook” is no longer in Assets. Attach the images you want, then send "Continue".' });
    // A font, or an ID the library never had, is not an image either.
    expect(continueContext(user('u', { ...ctx, assetIds: [nook.id, font.id] }), both, 1280)).toEqual({ error: 'An image attached to that request is no longer in Assets. Attach the images you want, then send "Continue".' });
    expect(continueContext(user('u', { ...ctx, assetIds: ['a_unknown'] }), both, 1280)).toEqual({ error: 'An image attached to that request is no longer in Assets. Attach the images you want, then send "Continue".' });
  });
});

describe('trying a request again after the AI setup failed (#83)', () => {
  const user = (id: string, context?: ChatMessage['context']): ChatMessage => ({ id, role: 'user', text: 'Rename the site', time: '', ...(context ? { context } : {}) });
  const failed = (id: string, result: Partial<NonNullable<ChatMessage['result']>> = {}): ChatMessage => ({ id, role: 'assistant', text: '', time: '', result: { status: 'failed', summary: '', changes: [], validation: [], canUndo: false, ...result } });

  it('offers Try again only on the latest result, and only when the setup failed rather than the request', () => {
    expect(retryableId([user('u1'), failed('a1', { repair: 'settings' })])).toBe('a1');
    expect(retryableId([user('u1'), failed('a1', { repair: 'key' })])).toBe('a1');
    // A request that failed on its own (its changes had errors, say) is edited first, not sent again unchanged.
    expect(retryableId([user('u1'), failed('a1')])).toBeUndefined();
    expect(retryableId([user('u1'), failed('a1', { repair: 'settings', status: 'cancelled' })])).toBeUndefined();
    expect(retryableId([user('u1'), failed('a1', { repair: 'settings' }), user('u2'), failed('a2', { status: 'completed' })])).toBeUndefined();
    expect(retryableId([user('u1'), failed('a1', { repair: 'settings' }), user('u2')])).toBeUndefined();
  });

  it('sends it with the original target, and says to edit it when that target has gone', () => {
    const state = createStarterState('business', 'Test', false);
    const home = state.site.homePageId;
    const ctx = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 390, mode: 'ask' as const };
    expect(continueContext(user('u', ctx), state, 1280, 'use Edit and try again')).toEqual({ ctx });
    expect(continueContext(user('u', { ...ctx, pageId: 'pg_gone', pageTitle: 'Old page' }), state, 1280, 'use Edit and try again')).toEqual({ error: 'Old page is no longer in the site. Choose what to change, then use Edit and try again.' });
  });
});

describe('opening a field the AI located (#203)', () => {
  const setup = () => {
    const state = createStarterState('business', 'Test Studio', false);
    const contact = Object.values(state.pages).find((p) => p.title === 'Contact')!;
    const nodeId = contact.rootIds.find((id) => (contact.nodes[id] as { definitionId?: string }).definitionId === 'foundation.contact.details')!;
    const items = (contact.nodes[nodeId] as InstanceNode).props.items as ListItem[];
    const hours = items.find((i) => i.label === 'Hours')!;
    const owner = { kind: 'page' as const, id: contact.id };
    const location = { owner, nodeId, prop: 'items', itemId: hours.id, field: 'value', path: ['Contact', 'Contact details', 'Content', 'Contact methods', 'Hours', 'Value'] };
    return { state, contact, nodeId, hours, owner, location };
  };

  it('selects the component on its page, from whichever page is open', () => {
    const { state, contact, nodeId, location, owner } = setup();
    expect(locationTarget(state, state.site.homePageId, location)).toEqual({ pageId: contact.id, selection: { owner, instancePath: [], nodeId } });
  });

  it('follows the item after it moves, and never opens a different item with the same title', () => {
    const { state, contact, nodeId, hours, owner, location } = setup();
    let s = applyOperations(state, [{ type: 'instance.listMove', owner, nodeId, prop: 'items', itemId: hours.id, index: 0 }]).state;
    expect(locationTarget(s, null, location)).toEqual({ pageId: contact.id, selection: { owner, instancePath: [], nodeId } });
    s = applyOperations(s, [
      { type: 'instance.listRemove', owner, nodeId, prop: 'items', itemId: hours.id },
      { type: 'instance.listInsert', owner, nodeId, prop: 'items', item: { icon: 'clock', label: 'Hours', value: 'Weekends', link: { type: 'none', target: '' } } }
    ]).state;
    expect(locationTarget(s, null, location)).toEqual({ error: 'Value can no longer be opened. Contact methods in Contact details no longer has that contact method.' });
    s = applyOperations(s, [{ type: 'node.remove', owner, nodeId }]).state;
    expect(locationTarget(s, null, location)).toEqual({ error: 'Value can no longer be opened. That component is no longer on Contact.' });
  });
});

describe('opening a shared header field the AI located (#203)', () => {
  it('opens it on the page being viewed when that page shows the header, else on the first that does', () => {
    const state = createStarterState('business', 'Test Studio', false);
    const nodeId = state.site.shell.header.rootIds[0];
    const owner = { kind: 'shell' as const, id: 'header' };
    const about = Object.values(state.pages).find((p) => p.title === 'About')!;
    const location = { owner, nodeId, prop: 'siteName', path: ['Header', 'Header', 'Content', 'Site name'] };
    expect(locationTarget(state, about.id, location)).toEqual({ pageId: about.id, selection: { owner, instancePath: [], nodeId } });
    // Hiding only the footer leaves the header on About; hiding the header sends it to the first page with one.
    about.showFooter = false;
    expect(locationTarget(state, about.id, location)).toEqual({ pageId: about.id, selection: { owner, instancePath: [], nodeId } });
    about.showHeader = false;
    expect(locationTarget(state, about.id, location)).toEqual({ pageId: state.site.homePageId, selection: { owner, instancePath: [], nodeId } });
  });
});

describe('where an AI turn stands, read from History (issue 276)', () => {
  type Entry = { runId?: string; applied: boolean };
  const steps = (entries: Entry[], droppedRuns?: TurnHistory['droppedRuns']) => ({ canUndo: entries.some((e) => e.applied), entries, ...(droppedRuns ? { droppedRuns } : {}) });
  const turn = (id: string, runId: string, result: Partial<NonNullable<ChatMessage['result']>> = {}): ChatMessage => ({
    id,
    role: 'assistant',
    text: 'Swapped the hero photo.',
    time: '',
    runId,
    result: { status: 'completed', summary: 'Swapped the hero photo.', changes: [{ label: 'Changed the Home hero image' }], validation: [], canUndo: true, ...result }
  });
  const ask = (id: string): ChatMessage => ({ id, role: 'user', text: 'Use the reading nook photo', time: '' });
  /** What an earlier version saved for a turn undone from chat. */
  const marked = (id: string, runId: string) => turn(id, runId, { summary: 'Swapped the hero photo. (Undone.)', canUndo: false });

  it('reads a turn as applied or undone from its step, wherever History moved it from', () => {
    const t = turn('a1', 'r1');
    expect(turnState(t, steps([{ runId: 'r1', applied: true }]))).toMatchObject({ standing: 'applied', undoneEarlier: false, result: { summary: 'Swapped the hero photo.', canUndo: true } });
    expect(turnState(t, steps([{ runId: 'r1', applied: false }]))?.standing).toBe('undone');
    // History let the step go: what it noted then still says where the change stands.
    expect(turnState(t, steps([], { r1: 'undone' }))?.standing).toBe('undone');
    expect(turnState(t, steps([], { r1: 'applied' }))?.standing).toBe('applied');
    // The step itself wins over an older note.
    expect(runStanding('r1', steps([{ runId: 'r1', applied: true }], { r1: 'undone' }))).toBe('applied');
    expect(runStanding('r1', steps([]))).toBe('unknown');
    expect(runStanding('r1', null)).toBe('unknown');
    expect(runStanding(undefined, steps([{ applied: true }]))).toBe('unknown');
    // A turn that changed nothing has no step to stand by.
    expect(turnState(turn('a2', 'r2', { status: 'no-changes', canUndo: false, changes: [] }), steps([{ runId: 'r2', applied: false }]))?.standing).toBe('unknown');
  });

  it('offers Undo turn only on the newest applied step, and again once a Redo reapplies it', () => {
    const msgs = [ask('u1'), turn('a1', 'r1'), ask('u2'), turn('a2', 'r2')];
    expect(undoableId(msgs, steps([{ runId: 'r1', applied: true }, { runId: 'r2', applied: true }]))).toBe('a2');
    // Undone from chat, the toolbar or History: the turn before it is now the newest applied step.
    expect(undoableId(msgs, steps([{ runId: 'r1', applied: true }, { runId: 'r2', applied: false }]))).toBe('a1');
    expect(undoableId(msgs, steps([{ runId: 'r1', applied: false }, { runId: 'r2', applied: false }]))).toBeUndefined();
    // A manual edit after the turn stands in the way.
    expect(undoableId(msgs, steps([{ runId: 'r1', applied: true }, { runId: 'r2', applied: true }, { applied: true }]))).toBeUndefined();
    // A turn that changed nothing has no change of its own to undo.
    expect(undoableId([ask('u1'), turn('a1', 'r1', { status: 'no-changes', canUndo: false, changes: [] })], steps([{ runId: 'r1', applied: true }]))).toBeUndefined();
    // Nothing can be undone while an edit run holds the project.
    expect(undoableId(msgs, { ...steps([{ runId: 'r2', applied: true }]), canUndo: false })).toBeUndefined();
  });

  it('reads a turn an earlier version marked "(Undone.)" as it was said, by where its step stands now', () => {
    const old = marked('a1', 'r1');
    expect(resultAsSaid(old.result!)).toEqual({ result: { ...old.result, summary: 'Swapped the hero photo.', canUndo: true }, undoneOnce: true });
    // Redone from the toolbar since: applied, and offered Undo again.
    expect(turnState(old, steps([{ runId: 'r1', applied: true }]))).toMatchObject({ standing: 'applied', undoneEarlier: false, result: { summary: 'Swapped the hero photo.' } });
    expect(undoableId([ask('u1'), old], steps([{ runId: 'r1', applied: true }]))).toBe('a1');
    expect(turnState(old, steps([{ runId: 'r1', applied: false }]))).toMatchObject({ standing: 'undone', undoneEarlier: false });
    // History has nothing on it: undone once, and not called either applied or undone now.
    expect(turnState(old, steps([]))).toMatchObject({ standing: 'unknown', undoneEarlier: true });
    // Only the mark that earlier versions wrote is read so: a summary of a turn that changed nothing, or one that
    // can still be undone, keeps its words.
    expect(resultAsSaid(turn('a2', 'r2', { summary: 'Removed the note (Undone.)', canUndo: true }).result!).undoneOnce).toBe(false);
    expect(resultAsSaid(turn('a3', 'r3', { status: 'no-changes', summary: 'Nothing to do. (Undone.)', canUndo: false }).result!)).toMatchObject({ undoneOnce: false, result: { summary: 'Nothing to do. (Undone.)' } });
    expect(resultAsSaid(turn('a4', 'r4', { summary: 'Labelled it (Undone.) for now.', canUndo: false }).result!).undoneOnce).toBe(false);
    // The mark was only ever added to the summary: words the turn's own text says too are the assistant's.
    const said = { ...turn('a5', 'r5', { summary: 'The label now reads (Undone.)', canUndo: false }), text: 'The label now reads (Undone.)' };
    expect(turnState(said, steps([]))).toMatchObject({ standing: 'unknown', undoneEarlier: false, result: { summary: 'The label now reads (Undone.)', canUndo: false } });
    expect(resultAsSaid(old.result!, old.text).undoneOnce).toBe(true);
    // Read the same way for Undo turn: the assistant's own words never make a turn undoable.
    expect(undoableId([ask('u1'), said], steps([{ runId: 'r5', applied: true }]))).toBeUndefined();
  });

  it('offers Continue on an unfinished turn that changed the site only while its changes are known to be in it', () => {
    const msgs = [ask('u1'), turn('a1', 'r1', { status: 'partial', incomplete: true })];
    expect(resumableId(msgs, steps([{ runId: 'r1', applied: true }]))).toBe('a1');
    expect(resumableId(msgs, steps([], { r1: 'applied' }))).toBe('a1');
    expect(resumableId(msgs, steps([{ runId: 'r1', applied: false }]))).toBeUndefined();
    expect(resumableId(msgs, steps([], { r1: 'undone' }))).toBeUndefined();
    // History has nothing on it, so its changes may be gone.
    expect(resumableId(msgs, steps([]))).toBeUndefined();
    expect(resumableId(msgs, null)).toBeUndefined();
    expect(resumableId([ask('u1'), marked('a1', 'r1')].map((m) => (m.result ? { ...m, result: { ...m.result, incomplete: true } } : m)), steps([]))).toBeUndefined();
    // One that changed nothing is offered whatever History says.
    expect(resumableId([ask('u1'), turn('a1', 'r1', { status: 'no-changes', canUndo: false, changes: [], incomplete: true })], steps([]))).toBe('a1');
    // A finished turn is never carried on from, applied or not.
    expect(canCarryOn(turnState(turn('a1', 'r1'), steps([{ runId: 'r1', applied: true }])))).toBe(false);
    expect(canCarryOn(turnState(turn('a1', 'r1', { status: 'partial', incomplete: true }), steps([{ runId: 'r1', applied: true }])))).toBe(true);
  });

  it('says why an unfinished turn can no longer be continued, and what can be done instead', () => {
    const partial = turn('a1', 'r1', { status: 'partial', incomplete: true });
    expect(standingNote(partial, steps([{ runId: 'r1', applied: true }]))).toBeUndefined();
    expect(standingNote(partial, steps([{ runId: 'r1', applied: false }]))).toBe('These changes were undone, so this request can only be continued once they are redone.');
    // Its step is gone: no Redo brings it back.
    expect(standingNote(partial, steps([], { r1: 'undone' }))).toBe('These changes were undone. This request can no longer be continued: send it again to start over.');
    expect(standingNote(partial, steps([]))).toBe('History no longer shows whether these changes are in the site. This request can no longer be continued: send it again to start over.');
    // A finished turn needs no word on continuing, whatever its standing; its heading says Undone.
    expect(standingNote(turn('a2', 'r2'), steps([{ runId: 'r2', applied: false }]))).toBeUndefined();
    expect(standingNote(turn('a3', 'r3', { status: 'no-changes', canUndo: false, changes: [], incomplete: true }), steps([]))).toBeUndefined();
    expect(standingNote(marked('a4', 'r4'), steps([]))).toBe('These changes were undone once. History no longer shows whether they were redone since.');
    expect(standingNote({ ...marked('a5', 'r5'), result: { ...marked('a5', 'r5').result!, incomplete: true } }, steps([]))).toBe(
      'These changes were undone once. History no longer shows whether they were redone since. This request can no longer be continued: send it again to start over.'
    );
    // An earlier turn is never continued, so it gets no word on continuing.
    expect(standingNote(partial, steps([{ runId: 'r1', applied: false }]), false)).toBeUndefined();
    expect(standingNote(partial, steps([]), false)).toBe('History no longer shows whether these changes are in the site.');
    expect(standingNote({ ...marked('a5', 'r5'), result: { ...marked('a5', 'r5').result!, incomplete: true } }, steps([]), false)).toBe('These changes were undone once. History no longer shows whether they were redone since.');
  });

  it('drops the app saying an unfinished turn’s changes are kept once that no longer holds, keeping what the assistant said', () => {
    const stopped = 'I reached the limit of 40 tool calls before finishing, so I stopped here. The changes so far are checked and kept, and you can undo them in one step. Reply "continue" to carry on.';
    const missing = 'This request is not finished yet. The page Reader requests was not built. The changes made so far are checked and kept. Press Continue, or reply "continue", to finish it.';
    const at = (summary: string, entries: Array<{ runId?: string; applied: boolean }>) => summaryNow(turnState(turn('a1', 'r1', { status: 'partial', summary, incomplete: true }), steps(entries))!);
    expect(at(stopped, [{ runId: 'r1', applied: true }])).toBe(stopped);
    expect(at(missing, [{ runId: 'r1', applied: true }])).toBe(missing);
    expect(at(stopped, [{ runId: 'r1', applied: false }])).toBe('I reached the limit of 40 tool calls before finishing, so I stopped here.');
    expect(at(missing, [{ runId: 'r1', applied: false }])).toBe('This request is not finished yet. The page Reader requests was not built.');
    expect(at(missing, [])).toBe('This request is not finished yet. The page Reader requests was not built.');
    // A finished turn says what it said, whatever its standing.
    expect(summaryNow(turnState(turn('a2', 'r2', { summary: 'The changes made so far are checked and kept.' }), steps([{ runId: 'r2', applied: false }]))!)).toBe('The changes made so far are checked and kept.');
    // Only the app's own ending goes: the same words inside a page title stay where they are.
    const titled = 'This request is not finished yet. The page " The changes made so far are checked and kept. Press Continue, or reply "continue", to finish it." was not built.';
    expect(at(titled, [])).toBe(titled);
    // A summary read back from disk that is not text is none.
    expect(summaryNow(turnState(turn('a3', 'r3', { summary: undefined as unknown as string, incomplete: true }), steps([]))!)).toBe('');
  });
});

describe('a turn that is only an answer', () => {
  type Result = NonNullable<ChatMessage['result']>;
  const result = (extra: Partial<Result> = {}): Result => ({ status: 'no-changes', summary: 'Because the header has two styles.', changes: [], validation: [], canUndo: false, ...extra });

  it('is a finished turn that changed nothing and leaves nothing to act on', () => {
    expect(answerOnly(result(), false)).toBe(true);
    expect(answerOnly(result({ ask: true, checks: [{ status: 'pass', text: 'Fits the screen at phone width.' }] }), false)).toBe(true);
  });

  it('is not one that changed the site, is unfinished, found something, or offers a way on', () => {
    expect(answerOnly(result({ status: 'completed', changes: [{ label: 'Edited Heading content on Home' }] }), false)).toBe(false);
    expect(answerOnly(result({ incomplete: true }), false)).toBe(false);
    expect(answerOnly(result({ checks: [{ status: 'issue', text: 'Content is wider than the screen at phone width.' }] }), false)).toBe(false);
    expect(answerOnly(result({ checks: [{ status: 'unverified', text: 'Could not check the form at tablet width.' }] }), false)).toBe(false);
    expect(answerOnly(result(), true)).toBe(false);
    expect(answerOnly(result({ status: 'failed' }), false)).toBe(false);
    expect(answerOnly(result({ status: 'cancelled' }), false)).toBe(false);
  });
});

describe('saysUnchanged', () => {
  it('recognises the run\'s own wording so the chat does not repeat it', () => {
    expect(saysUnchanged('The provider rejected the key. Nothing in the site was changed.')).toBe(true);
    expect(saysUnchanged('Nothing on your site was changed.')).toBe(true);
    expect(saysUnchanged('The provider returned an error.')).toBe(false);
  });
});
