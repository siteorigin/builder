import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { ChatMessage } from '@shared/api';
import { canOpen, changeTarget, changeText, checksOf, continueContext, resumableId } from '../../src/renderer/src/lib/result';

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
    state = applyOperations(state, [{ type: 'page.update', pageId: about, shell: 'none' }]).state;
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
    expect(resumableId([user('u1'), reply('a1', { incomplete: true })])).toBe('a1');
    expect(resumableId([user('u1'), reply('a1', { status: 'no-changes', incomplete: true })])).toBe('a1');
    expect(resumableId([user('u1'), reply('a1')])).toBeUndefined();
    // A newer request has moved on from the unfinished one.
    expect(resumableId([user('u1'), reply('a1', { incomplete: true }), user('u2'), reply('a2')])).toBeUndefined();
    expect(resumableId([user('u1'), reply('a1', { incomplete: true }), user('u2')])).toBeUndefined();
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
});
