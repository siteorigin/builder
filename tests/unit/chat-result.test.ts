import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { ChatMessage } from '@shared/api';
import type { InstanceNode, ListItem } from '@shared/types';
import { canOpen, changeTarget, changeText, checksOf, continueContext, locationTarget, resumableId, retryableId } from '../../src/renderer/src/lib/result';

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
