// What the AI composer targets while a component is edited everywhere (issue #191): the chips, the context a message
// is sent with, how it is labelled afterwards, and where "Edit and try again" and "Continue" put it back.
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { grantsWider, type ChatContext, type ChatMessage } from '@shared/api';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import { chatContextFor, codeDesign, composerScope, editScope, requestTarget, retryView, targetOf, grantedScope, withGrant } from '../../src/renderer/src/lib/chatTarget';
import { NEW_STUDIO } from '../../src/renderer/src/lib/studio';
import { continueContext } from '../../src/renderer/src/lib/result';
import { makeInstance } from '@engine/install';
import { P, prop } from '@catalogue/dsl';
import { foundationDesign, type DesignSpec } from './fixtures/packs';

/**
 * A hero a theme built in the editor: a heading in a content area another design can be placed in. Foundation's own
 * sections are code, which the AI edits only as source and nothing is placed inside, so the hero edited everywhere
 * here is this one.
 */
const SPLIT_HERO: DesignSpec = {
  componentId: 'test.split-hero',
  name: 'Split hero',
  properties: { heading: P.str('Heading', 'Designed for living in') },
  parts: { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' } },
  build: (b) => b.el('root', 'section', { name: 'Section' }, [b.el('content', 'div', { name: 'Content' }, [b.text('heading', 'h1', prop('heading'), { name: 'Heading' })])])
};

/** A banner a theme built in the editor, placed inside the hero's design. */
const BANNER: DesignSpec = {
  componentId: 'test.banner',
  name: 'Banner',
  properties: { heading: P.str('Heading', 'Get in touch') },
  parts: { root: { nodeId: 'root', label: 'Banner' } },
  build: (b) => b.el('root', 'section', { name: 'Banner' }, [b.text('title', 'h2', prop('heading'), { name: 'Heading' })])
};

/**
 * A starter project whose home hero is the theme's editor-built Split hero, with it and the closing banner each
 * forked, as "Edit everywhere" does, and the theme's editor-built Banner placed inside the hero's design.
 */
function project() {
  let state = createStarterState('business', 'Test', false);
  const home = state.site.homePageId;
  const heroDesign = foundationDesign(SPLIT_HERO);
  const bannerDesign = foundationDesign(BANNER);
  state.components[heroDesign.id] = heroDesign;
  state.components[bannerDesign.id] = bannerDesign;
  const first = state.pages[home].rootIds[0];
  state.pages[home].nodes[first] = { ...makeInstance(heroDesign), id: first };
  const about = Object.values(state.pages).find((p) => p.route === '/about/')!.id;
  const contact = Object.values(state.pages).find((p) => p.route === '/contact/')!.id;
  const at = (i: number) => state.pages[home].nodes[state.pages[home].rootIds.at(i)!] as InstanceNode;
  const fork = (definitionId: string) => {
    const r = applyOperations(state, [{ type: 'component.fork', definitionId }]);
    state = r.state;
    return (r.results[0] as { definitionId: string }).definitionId;
  };
  const hero = fork(at(0).definitionId);
  const banner = fork(at(-1).definitionId);
  const owner = { kind: 'component' as const, id: hero };
  // A theme component placed inside the hero's design.
  const nested = applyOperations(state, [{ type: 'node.insert', owner, parentId: 'content', definitionId: bannerDesign.id }]);
  state = nested.state;
  const nestedId = (nested.results[0] as { nodeId: string }).nodeId;
  return { state, home, about, contact, hero, banner, owner, nestedId, nestedDesign: bannerDesign.id };
}

const enabled = { page: true, scope: 'selection' as const };
const user = (id: string, context?: ChatContext): ChatMessage => ({ id, role: 'user', text: 'Continue', time: '', ...(context ? { context } : {}) });

describe('the composer while a component is edited everywhere (#191)', () => {
  it('scopes to the component, not the page behind it, at the overview', () => {
    const { state, home, about, hero } = project();
    const scope = composerScope(state, { pageId: home, selection: null, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(scope).toEqual({ page: { id: home, title: state.pages[home].title }, component: { id: hero, name: 'Split hero' }, selection: null, selectionLabel: null });
    expect(chatContextFor(state, scope, { enabled, viewport: 1280 })).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' }, viewport: 1280 });
    // Shown on another page: that page goes with it, or Home when the page switch is off; the component either way.
    const elsewhere = composerScope(state, { pageId: about, selection: null, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(chatContextFor(state, elsewhere, { enabled, viewport: 1280 })).toMatchObject({ pageId: about, pageTitle: state.pages[about].title, component: { id: hero } });
    expect(chatContextFor(state, elsewhere, { enabled: { page: false, scope: 'selection' }, viewport: 1280 })).toMatchObject({ pageId: home, component: { id: hero } });
  });

  it('offers one of its own nodes, or the whole component when the switch is off', () => {
    const { state, home, hero, owner } = project();
    const heading: ElementRef = { owner, instancePath: [], nodeId: 'heading' };
    const scope = composerScope(state, { pageId: home, selection: heading, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(scope.selection).toEqual(heading);
    expect(scope.selectionLabel).toBe('Heading');
    const sent = chatContextFor(state, scope, { enabled, viewport: 390, assetIds: ['img1'], ask: true });
    expect(sent).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: heading, selectionLabel: 'Heading', component: { id: hero, name: 'Split hero' }, viewport: 390, assetIds: ['img1'], mode: 'ask' });
    // A frozen copy: a later selection or attached image never changes a message already sent.
    const images = ['img1'];
    const frozen = chatContextFor(state, scope, { enabled, viewport: 390, assetIds: images });
    heading.instancePath.push('n_later');
    images.push('img2');
    expect(frozen.selection).toEqual({ owner, instancePath: [], nodeId: 'heading' });
    expect(frozen.assetIds).toEqual(['img1']);
    heading.instancePath.pop();
    const whole = chatContextFor(state, scope, { enabled: { page: true, scope: 'site' }, viewport: 390 });
    expect(whole).toMatchObject({ selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' } });
    expect(whole).not.toHaveProperty('scope');
  });

  it('keeps a part of a component placed in the design, and drops a pick from outside it', () => {
    const { state, home, about, hero, owner, nestedId, nestedDesign } = project();
    const nestedDef = state.components[(state.components[hero].tree!.nodes[nestedId] as InstanceNode).definitionId];
    const part: ElementRef = { owner, instancePath: [nestedId], nodeId: nestedDef.tree!.rootIds[0] };
    const dm = { definitionId: hero, returnPageId: home };
    expect(composerScope(state, { pageId: home, selection: part, definitionMode: dm }).selection).toEqual(part);
    // A selection on the page (the moment before the canvas turns it into the design's own node) is not offered.
    const onPage: ElementRef = { owner: { kind: 'page', id: about }, instancePath: [], nodeId: state.pages[about].rootIds[0] };
    expect(composerScope(state, { pageId: home, selection: onPage, definitionMode: dm })).toMatchObject({ component: { id: hero }, selection: null, selectionLabel: null });
    // Nor is a node of another component's design.
    expect(composerScope(state, { pageId: home, selection: { owner: { kind: 'component', id: nestedDesign }, instancePath: [], nodeId: 'root' }, definitionMode: dm }).selection).toBeNull();
    // A node the design no longer has is not offered either.
    expect(composerScope(state, { pageId: home, selection: { owner, instancePath: [], nodeId: 'n_gone' }, definitionMode: dm }).selection).toBeNull();
  });

  it('is about the page and its selection outside Edit everywhere, as before', () => {
    const { state, home } = project();
    const sel: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[1] };
    const scope = composerScope(state, { pageId: home, selection: sel, definitionMode: null });
    expect(scope.component).toBeNull();
    expect(scope.selection).toEqual(sel);
    const sent = chatContextFor(state, scope, { enabled, viewport: 1280 });
    expect(sent).not.toHaveProperty('component');
    expect(sent).toMatchObject({ pageId: home, selection: sel, scope: 'selection' });
    // A component that has gone (its copy undone) ends the mode a moment later; until then the page stands in.
    expect(composerScope(state, { pageId: home, selection: null, definitionMode: { definitionId: 'proj.gone', returnPageId: home } }).component).toBeNull();
  });

  it('labels a sent message with the component it edited everywhere', () => {
    const base = { pageId: 'p', pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
    expect(targetOf(base)).toBe('Home');
    expect(targetOf({ ...base, selectionLabel: 'Hero' })).toBe('Home → Hero');
    expect(targetOf({ ...base, component: { id: 'c', name: 'Split hero' } })).toBe('Split hero everywhere');
    expect(targetOf({ ...base, component: { id: 'c', name: 'Split hero' }, selectionLabel: 'Heading' })).toBe('Split hero everywhere → Heading');
    // Read back from a damaged transcript.
    expect(targetOf({ ...base, component: { id: 'c' } as unknown as { id: string; name: string } })).toBe('Home');
    expect(targetOf(null)).toBe('');
  });
});

describe('a code component open in Component Studio (#367, #1410)', () => {
  const withCode = () => {
    const { state, home, about, hero } = project();
    const made = applyOperations(state, [{ type: 'component.createCode', name: 'Note', source: '<p>Hi</p>\n', properties: {} }]);
    return { state: made.state, home, about, hero, code: made.results[0].definitionId as string };
  };

  it('is what the next message is about, as a whole, never the page behind the studio', () => {
    const { state, home, hero, code } = withCode();
    const studio = { definitionId: code, returnPageId: home, studio: NEW_STUDIO };
    expect(codeDesign(state, code)?.name).toBe('Note');
    expect(codeDesign(state, hero)).toBeNull();
    expect(codeDesign(state, 'gone')).toBeNull();
    // Nothing inside it is selected: its design is its source.
    const scope = composerScope(state, { pageId: home, selection: { owner: { kind: 'component', id: code }, instancePath: [], nodeId: 'x' }, definitionMode: studio });
    expect(scope).toEqual({ page: { id: home, title: state.pages[home].title }, component: { id: code, name: 'Note' }, selection: null, selectionLabel: null });
    const ctx = chatContextFor(state, scope, { enabled: { page: true, scope: 'page' }, viewport: 1280 });
    expect(ctx).toMatchObject({ component: { id: code, name: 'Note' }, selection: null });
    expect(ctx.scope).toBeUndefined();
    // A theme's code is never one of the project's own.
    const theme = Object.values(state.components).find((d) => d.kind === 'code' && d.owner !== 'project')!;
    expect(codeDesign(state, theme.id)).toBeNull();
  });

  it('goes back to the studio to be tried again, and carries on with Continue while the project has it', () => {
    const { state, home, about, code } = withCode();
    const ctx: ChatContext = { pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, component: { id: code, name: 'Note' }, viewport: 1280 };
    expect(retryView(state, ctx, { pageId: home, definitionMode: null })).toEqual({ pageId: about, definitionMode: { definitionId: code, returnPageId: home, studio: NEW_STUDIO }, selection: null, scope: 'site', missing: null });
    expect(continueContext(user('u', ctx), state, 1280)).toEqual({ ctx });
    const gone = structuredClone(state) as ProjectState;
    delete gone.components[code];
    expect(continueContext(user('u', ctx), gone, 1280)).toEqual({ error: 'Note is no longer in the site. Choose what to change, then send "Continue".' });
    expect(retryView(gone, ctx, { pageId: home, definitionMode: null })).toMatchObject({ definitionMode: null, missing: 'Note' });
  });
});

describe('trying a request about a component again (#191)', () => {
  it('goes back to editing that component everywhere, on a page that shows it, from wherever the author is', () => {
    const p = project();
    const { home, about, contact, hero, banner, owner } = p;
    // A second placement of the hero, on About.
    const state = applyOperations(p.state, [{ type: 'node.insert', owner: { kind: 'page', id: about }, definitionId: hero }]).state;
    const ctx: ChatContext = { pageId: about, pageTitle: 'About', selection: { owner, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading', component: { id: hero, name: 'Split hero' }, viewport: 1280 };
    // Editing another component everywhere, entered from Home, with Contact open: the request's own page and
    // component come back, and finishing still returns to Home.
    expect(retryView(state, ctx, { pageId: contact, definitionMode: { definitionId: banner, returnPageId: home } })).toEqual({ pageId: about, definitionMode: { definitionId: hero, returnPageId: home }, selection: ctx.selection, scope: 'selection', missing: null });
    // On a page: it starts editing the component again, and finishing goes back to that page.
    expect(retryView(state, ctx, { pageId: contact, definitionMode: null })).toEqual({ pageId: about, definitionMode: { definitionId: hero, returnPageId: contact }, selection: ctx.selection, scope: 'selection', missing: null });
    // The request's page no longer shows it: the page open now does, else the first page that does.
    const moved = applyOperations(state, [{ type: 'node.remove', owner: { kind: 'page', id: about }, nodeId: state.pages[about].rootIds.at(-1)! }]).state;
    expect(retryView(moved, ctx, { pageId: contact, definitionMode: null }).pageId).toBe(home);
    const onContact = applyOperations(moved, [{ type: 'node.insert', owner: { kind: 'page', id: contact }, definitionId: hero }]).state;
    expect(retryView(onContact, ctx, { pageId: contact, definitionMode: null }).pageId).toBe(contact);
    // Placed nowhere: it opens in Component Studio, which shows the design on its own (issue #367).
    const nowhere = applyOperations(moved, [{ type: 'node.remove', owner: { kind: 'page', id: home }, nodeId: moved.pages[home].rootIds[0] }]).state;
    expect(retryView(nowhere, ctx, { pageId: contact, definitionMode: null })).toMatchObject({ pageId: about, definitionMode: { definitionId: hero, studio: NEW_STUDIO } });
    // Already looking at it in the studio, the look chosen there stays; another component's look never carries over.
    const looking = { variants: { tone: 'inverse' }, sample: 'long' as const };
    expect(retryView(state, ctx, { pageId: contact, definitionMode: { definitionId: hero, returnPageId: home, studio: looking } }).definitionMode).toEqual({ definitionId: hero, returnPageId: home, studio: looking });
    expect(retryView(nowhere, ctx, { pageId: contact, definitionMode: { definitionId: banner, returnPageId: home, studio: looking } }).definitionMode).toEqual({ definitionId: hero, returnPageId: home, studio: NEW_STUDIO });
  });

  it('drops a component or element that has gone, and says which', () => {
    const { state, home, about, hero, banner, owner } = project();
    const ctx: ChatContext = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' }, viewport: 1280 };
    const gone = structuredClone(state) as ProjectState;
    delete gone.components[hero];
    expect(retryView(gone, ctx, { pageId: home, definitionMode: { definitionId: banner, returnPageId: about } })).toEqual({ pageId: about, definitionMode: null, selection: null, scope: 'site', missing: 'Split hero' });
    // A theme's original is never edited in place: only through the copy "Edit everywhere" makes.
    const theme = (state.pages[home].nodes[state.pages[home].rootIds[1]] as InstanceNode).definitionId;
    expect(state.components[theme].owner).toBe('theme');
    expect(retryView(state, { ...ctx, component: { id: theme, name: 'Logo strip' } }, { pageId: home, definitionMode: null })).toMatchObject({ definitionMode: null, missing: 'Logo strip' });
    const { state: noHeading } = applyOperations(state, [{ type: 'node.remove', owner, nodeId: 'heading' }]);
    expect(retryView(noHeading, { ...ctx, selection: { owner, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading' }, { pageId: home, definitionMode: null })).toMatchObject({ definitionMode: { definitionId: hero }, selection: null, scope: 'selection', missing: 'Heading' });
    // The page it was shown on has gone, and with it the only placement: it opens on the page open now.
    const { state: noHome } = applyOperations(state, [{ type: 'page.setHome', pageId: about }]);
    const { state: removed } = applyOperations(noHome, [{ type: 'page.remove', pageId: home, replacementPageId: about }]);
    expect(retryView(removed, ctx, { pageId: about, definitionMode: null })).toEqual({ pageId: about, definitionMode: { definitionId: hero, returnPageId: about, studio: NEW_STUDIO }, selection: null, scope: 'site', missing: null });
  });

  it('leaves Edit everywhere to try a request about a page, and reads older requests about a component', () => {
    const { state, home, about, hero, owner } = project();
    const page: ChatContext = { pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, viewport: 1280 };
    expect(retryView(state, page, { pageId: home, definitionMode: { definitionId: hero, returnPageId: home } })).toEqual({ pageId: about, definitionMode: null, selection: null, scope: 'site', missing: null });
    // Sent before requests named their component: the selection inside it still does.
    const older: ChatContext = { pageId: home, pageTitle: 'Home', selection: { owner, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading', viewport: 1280 };
    expect(retryView(state, older, { pageId: home, definitionMode: null })).toMatchObject({ definitionMode: { definitionId: hero }, selection: older.selection, missing: null });
    // A page request's selection comes back while it is there, and is named when it has gone.
    const section: ElementRef = { owner: { kind: 'page', id: about }, instancePath: [], nodeId: state.pages[about].rootIds[0] };
    expect(retryView(state, { ...page, selection: section, selectionLabel: 'Intro' }, { pageId: home, definitionMode: null })).toEqual({ pageId: about, definitionMode: null, selection: section, scope: 'selection', missing: null });
    const { state: noSection } = applyOperations(state, [{ type: 'node.remove', owner: section.owner, nodeId: section.nodeId }]);
    expect(retryView(noSection, { ...page, selection: section, selectionLabel: 'Intro' }, { pageId: home, definitionMode: null })).toEqual({ pageId: about, definitionMode: null, selection: null, scope: 'selection', missing: 'Intro' });
    // No context at all (the oldest requests): about the site.
    expect(retryView(state, undefined, { pageId: home, definitionMode: { definitionId: hero, returnPageId: about } })).toEqual({ pageId: about, definitionMode: null, selection: null, scope: 'site', missing: null });
  });

  it('continues with the component wherever it is shown, and never with one that has gone', () => {
    const { state, home, about, hero } = project();
    const ctx: ChatContext = { pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' }, viewport: 1280 };
    expect(continueContext(user('u', ctx), state, 1280)).toEqual({ ctx });
    const { state: noAbout } = applyOperations(state, [{ type: 'page.remove', pageId: about, replacementPageId: home }]);
    expect(continueContext(user('u', ctx), noAbout, 1280)).toEqual({ ctx: { ...ctx, pageId: home, pageTitle: state.pages[home].title } });
    const gone = structuredClone(state) as ProjectState;
    delete gone.components[hero];
    expect(continueContext(user('u', ctx), gone, 1280)).toEqual({ error: 'Split hero is no longer in the site. Choose what to change, then send "Continue".' });
    // Saved before requests named their component: its selection inside it still carries on, page or not.
    const older: ChatContext = { pageId: about, pageTitle: 'About', selection: { owner: { kind: 'component', id: hero }, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading', viewport: 1280 };
    expect(continueContext(user('u', older), noAbout, 1280)).toEqual({ ctx: { ...older, pageId: home, pageTitle: state.pages[home].title } });
    // Still checked like any other: a selected node that has gone, an image no longer in Assets.
    const { state: noHeading } = applyOperations(state, [{ type: 'node.remove', owner: { kind: 'component', id: hero }, nodeId: 'heading' }]);
    expect(continueContext(user('u', { ...ctx, selection: older.selection, selectionLabel: 'Heading' }), noHeading, 1280)).toEqual({ error: 'Heading is no longer in the site. Choose what to change, then send "Continue".' });
    expect(continueContext(user('u', { ...ctx, assetIds: ['a_missing'] }), state, 1280)).toMatchObject({ error: expect.stringMatching(/no longer in Assets/) });
  });
});

describe('the composer on a page: selection, this page or the whole site (#513)', () => {
  it('sends an edit with nothing selected about this page, and one with a selection about the selection', () => {
    const { state, home, about } = project();
    const nothing = composerScope(state, { pageId: about, selection: null, definitionMode: null });
    // Keeping to a selection with nothing selected keeps to the page: the default.
    expect(editScope(nothing, 'selection')).toBe('page');
    expect(chatContextFor(state, nothing, { enabled, viewport: 1280 })).toEqual({ pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, scope: 'page', viewport: 1280 });
    expect(chatContextFor(state, nothing, { enabled: { page: true, scope: 'site' }, viewport: 1280 })).toMatchObject({ pageId: about, selection: null, scope: 'site' });
    const sel: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    const picked = composerScope(state, { pageId: home, selection: sel, definitionMode: null });
    expect(editScope(picked, 'selection')).toBe('selection');
    expect(chatContextFor(state, picked, { enabled, viewport: 1280 })).toMatchObject({ selection: sel, selectionLabel: picked.selectionLabel, scope: 'selection' });
    // This page, or the whole site, with an element still selected on the canvas: the request goes without it.
    for (const scope of ['page', 'site'] as const) expect(chatContextFor(state, picked, { enabled: { page: true, scope }, viewport: 1280 })).toMatchObject({ pageId: home, selection: null, selectionLabel: null, scope });
  });

  it('starts from the whole site in a conversation that allowed it, until something narrower is chosen (#1412)', () => {
    const { state, home, about, hero, owner } = project();
    const nothing = composerScope(state, { pageId: about, selection: null, definitionMode: null });
    // The default, with nothing selected: the whole site, not the page.
    expect(grantedScope(nothing, 'selection', true)).toBe('site');
    expect(chatContextFor(state, nothing, { enabled: { page: true, scope: grantedScope(nothing, 'selection', true) }, viewport: 1280 })).toMatchObject({ pageId: about, selection: null, scope: 'site' });
    // Without the grant, the page as before; the page chosen by hand stays the page.
    expect(grantedScope(nothing, 'selection', false)).toBe('selection');
    expect(grantedScope(nothing, 'page', true)).toBe('page');
    expect(grantedScope(nothing, 'site', true)).toBe('site');
    // An element selected is what the author points at: the request keeps to it.
    const sel: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    const picked = composerScope(state, { pageId: home, selection: sel, definitionMode: null });
    expect(grantedScope(picked, 'selection', true)).toBe('selection');
    // A component edited everywhere keeps its own target.
    const design = composerScope(state, { pageId: home, selection: null, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(grantedScope(design, 'selection', true)).toBe('selection');
    const designPart = composerScope(state, { pageId: home, selection: { owner, instancePath: [], nodeId: 'heading' }, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(grantedScope(designPart, 'selection', true)).toBe('selection');
    expect(designPart.selection).not.toBeNull();
    // The writer with no post open already reaches the whole site, and a post or a layout keeps its own target.
    const homePage = { id: home, title: 'Home' };
    expect(grantedScope({ page: homePage, selection: null, component: null, empty: true }, 'selection', true)).toBe('selection');
    expect(grantedScope({ page: homePage, selection: null, component: null, post: { collectionId: 'posts', entryId: 'en_1', title: 'Spring' } }, 'selection', true)).toBe('selection');
    expect(grantedScope({ page: homePage, selection: null, component: null, template: { collectionId: 'posts', name: 'Posts' } }, 'selection', true)).toBe('selection');
    // With no page shown, nothing is offered to widen.
    expect(grantedScope({ page: null, selection: null, component: null }, 'selection', true)).toBe('selection');
  });

  it('carries on a page request from the whole site once its conversation allowed it (#1412)', () => {
    const { state, about, home } = project();
    const nothing = composerScope(state, { pageId: about, selection: null, definitionMode: null });
    const onPage = chatContextFor(state, nothing, { enabled, viewport: 1280 });
    expect(withGrant(onPage, true)).toEqual({ ...onPage, scope: 'site' });
    expect(withGrant(onPage, false)).toBe(onPage);
    // Only a page request is widened: one sent unscoped, or already on the whole site, goes on as it was.
    const { scope: _none, ...unscoped } = onPage;
    expect(withGrant(unscoped, true)).toBe(unscoped);
    const whole = { ...onPage, scope: 'site' as const };
    expect(withGrant(whole, true)).toBe(whole);
    // Anything narrower than the page, or a question, goes on as it was.
    const sel: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    const picked = chatContextFor(state, composerScope(state, { pageId: home, selection: sel, definitionMode: null }), { enabled, viewport: 1280 });
    expect(withGrant(picked, true)).toBe(picked);
    const asked = { ...onPage, mode: 'ask' as const };
    expect(withGrant(asked, true)).toBe(asked);
    for (const extra of [{ component: { id: 'x', name: 'X' } }, { post: { collectionId: 'posts', entryId: 'e', title: 'T' } }, { template: { collectionId: 'posts', name: 'Posts' } }]) {
      const ctx = { ...onPage, ...extra } as ChatContext;
      expect(withGrant(ctx, true)).toBe(ctx);
    }
  });

  it('reads a scope question as allowed by its first choice or a plain typed yes, and nothing else (#1412)', () => {
    const q = { widen: true, choices: ['Yes, allow changes across the whole site', 'No, only change Home'] };
    expect(grantsWider(q, 'Yes, allow changes across the whole site')).toBe(true);
    for (const typed of ['ok', 'Yes.', ' sure ', 'go ahead!']) expect(grantsWider(q, typed)).toBe(true);
    for (const other of ['No, only change Home', 'no', 'yes but only Our Story', '', undefined]) expect(grantsWider(q, other)).toBe(false);
    // Only a scope question grants anything.
    expect(grantsWider({ choices: q.choices }, 'Yes, allow changes across the whole site')).toBe(false);
    expect(grantsWider(null, 'yes')).toBe(false);
    // Only a string is an answer: nothing coerced into one.
    expect(grantsWider(q, ['yes'])).toBe(false);
    expect(grantsWider(q, { toString: () => 'yes' })).toBe(false);
  });

  it('sends a question and a component edited everywhere as before, without a scope', () => {
    const { state, home, hero, owner } = project();
    const sel: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    const picked = composerScope(state, { pageId: home, selection: sel, definitionMode: null });
    const asked = chatContextFor(state, picked, { enabled, viewport: 1280, ask: true });
    expect(asked).not.toHaveProperty('scope');
    expect(asked.selection).toEqual(sel);
    for (const scope of ['page', 'site'] as const) expect(chatContextFor(state, picked, { enabled: { page: true, scope }, viewport: 1280, ask: true })).not.toHaveProperty('scope');
    // A question about the page leaves the selection out, as a page edit does.
    expect(chatContextFor(state, picked, { enabled: { page: true, scope: 'page' }, viewport: 1280, ask: true })).toMatchObject({ selection: null, mode: 'ask' });
    const design = composerScope(state, { pageId: home, selection: { owner, instancePath: [], nodeId: 'heading' }, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(chatContextFor(state, design, { enabled, viewport: 1280 })).not.toHaveProperty('scope');
    // Anything but the element is the whole component.
    expect(chatContextFor(state, design, { enabled: { page: true, scope: 'page' }, viewport: 1280 })).toMatchObject({ selection: null, component: { id: hero } });
  });

  it('tries a request again as far as it reached, and an older one with nothing selected on the whole site', () => {
    const { state, home, about } = project();
    const base: ChatContext = { pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, viewport: 1280 };
    expect(retryView(state, { ...base, scope: 'page' }, { pageId: home, definitionMode: null })).toEqual({ pageId: about, definitionMode: null, selection: null, scope: 'page', missing: null });
    expect(retryView(state, { ...base, scope: 'site' }, { pageId: home, definitionMode: null })).toMatchObject({ scope: 'site' });
    expect(retryView(state, base, { pageId: home, definitionMode: null })).toMatchObject({ scope: 'site' });
    // Read back damaged: its page, never the whole site.
    expect(retryView(state, { ...base, scope: 'everything' as never }, { pageId: home, definitionMode: null })).toMatchObject({ scope: 'page' });
    // Its page has gone: the author is told, and the scope stays the page's (the one open now), never wider.
    const { state: noAbout } = applyOperations(state, [{ type: 'page.remove', pageId: about, replacementPageId: home }]);
    expect(retryView(noAbout, { ...base, scope: 'page' }, { pageId: home, definitionMode: null })).toMatchObject({ scope: 'page', missing: 'About' });
    // Continue carries the scope it was sent with.
    expect(continueContext(user('u', { ...base, scope: 'page' }), state, 1280)).toEqual({ ctx: { ...base, scope: 'page' } });
  });
});

describe('the composer with a post open in the Posts workspace (#400)', () => {
  /** The starter project with a blog of one post. */
  function blog() {
    const { state: start, home, hero } = project();
    const state = applyOperations(start, [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', body: ['Twenty makers.'] }
    ]).state;
    return { state, home, hero, post: { collectionId: 'posts', entryId: 'en_spring' } };
  }

  it('is about the post, never the page, selection or design behind the writer, whatever scope was chosen', () => {
    const { state, home, hero, post } = blog();
    const picked: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    for (const definitionMode of [null, { definitionId: hero, returnPageId: home }]) {
      const scope = composerScope(state, { pageId: home, selection: picked, definitionMode, post });
      expect(scope).toMatchObject({ component: null, selection: null, selectionLabel: null, post: { ...post, title: 'Spring open studio' } });
      for (const chosen of ['selection', 'page', 'site'] as const) {
        const ctx = chatContextFor(state, scope, { enabled: { page: true, scope: chosen }, viewport: 1280 });
        expect(ctx).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: null, selectionLabel: null, post: { ...post, title: 'Spring open studio' }, viewport: 1280 });
      }
      expect(chatContextFor(state, scope, { enabled, viewport: 1280, ask: true })).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: null, selectionLabel: null, post: { ...post, title: 'Spring open studio' }, viewport: 1280, mode: 'ask' });
    }
    // The writer with no post open (or the one open gone) shows no page: nothing on the page or selection out of sight
    // under it is offered (a change waits for a post, lib/workspace), and a question reads the site (#895).
    const behind = Object.keys(state.pages).find((id) => id !== home)!;
    for (const open of [null, { collectionId: 'posts', entryId: 'en_gone' }]) {
      const empty = composerScope(state, { pageId: behind, selection: picked, definitionMode: null, post: open, writer: true });
      expect(empty).toEqual({ page: null, component: null, selection: null, selectionLabel: null, empty: true });
      expect(chatContextFor(state, empty, { enabled, viewport: 1280, ask: true })).toEqual({ pageId: state.site.homePageId, pageTitle: state.pages[state.site.homePageId].title, selection: null, selectionLabel: null, viewport: 1280, mode: 'ask' });
      // An edit goes to the whole site, from the home page, whatever scope was chosen before the writer showed (#1424):
      // never limited to the page or selection out of sight under it.
      for (const chosen of ['selection', 'page', 'site'] as const) {
        expect(editScope(empty, chosen)).toBe('site');
        expect(chatContextFor(state, empty, { enabled: { page: true, scope: chosen }, viewport: 1280 })).toEqual({ pageId: state.site.homePageId, pageTitle: state.pages[state.site.homePageId].title, selection: null, selectionLabel: null, scope: 'site', viewport: 1280 });
      }
    }
    // The writer with a post open is still about the post.
    expect(composerScope(state, { pageId: home, selection: picked, definitionMode: null, post, writer: true }).post).toMatchObject(post);
    // A post that has gone, or none open, leaves the composer on the page as before.
    expect(composerScope(state, { pageId: home, selection: picked, definitionMode: null, post: { collectionId: 'posts', entryId: 'en_gone' } })).toMatchObject({ selection: picked });
    expect(composerScope(state, { pageId: home, selection: picked, definitionMode: null, post: null }).post).toBeUndefined();
    expect(targetOf(chatContextFor(state, composerScope(state, { pageId: home, selection: null, definitionMode: null, post }), { enabled, viewport: 1280 }))).toBe('Post · Spring open studio');
  });

  it('tries a request about a post again in that post, and continues with it, but never with one that has gone', () => {
    const { state, home, post } = blog();
    const ctx: ChatContext = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, post: { ...post, title: 'Spring open studio' }, viewport: 1280 };
    expect(retryView(state, ctx, { pageId: home, definitionMode: null })).toMatchObject({ post, selection: null, definitionMode: null, missing: null });
    expect(continueContext(user('u', ctx), state, 1280)).toEqual({ ctx });
    // The page the writer covered may go; the post goes on.
    const noHome = { ...ctx, pageId: 'pg_gone' };
    expect(continueContext(user('u', noHome), state, 1280)).toMatchObject({ ctx: { pageId: home, post: { entryId: 'en_spring' } } });
    const gone = structuredClone(state);
    delete gone.collections.posts.entries.en_spring;
    expect(retryView(gone, ctx, { pageId: home, definitionMode: null })).toMatchObject({ post: null, missing: 'The post “Spring open studio”' });
    expect(continueContext(user('u', ctx), gone, 1280)).toEqual({ error: 'The post “Spring open studio” is no longer in the site. Open a post, then send "Continue".' });
    expect(continueContext(user('u', { ...ctx, post: { collectionId: 'posts', entryId: 7 } } as unknown as ChatContext), state, 1280)).toMatchObject({ error: expect.stringMatching(/^That post is no longer in the site/) });
    expect(continueContext(user('u', { ...ctx, post: { ...post, title: 3 } } as unknown as ChatContext), state, 1280)).toMatchObject({ error: expect.stringMatching(/^That post/) });
    // One read back damaged is still a post's request, never one about the page under the writer.
    expect(retryView(state, { ...ctx, post: { collectionId: 'posts' } } as unknown as ChatContext, { pageId: home, definitionMode: null })).toMatchObject({ post: null, missing: 'The post' });
  });
});

describe('the composer with a collection layout open on the canvas (#679)', () => {
  /** The starter project with a Team whose entries have pages, one member, and an index layout. */
  function teamSite() {
    const { state: start, home, hero } = project();
    const state = applyOperations(start, [
      { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', route: '/team/', archiveTemplate: 'start' },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ana', title: 'Ana Ruiz', draft: false }
    ]).state;
    return { state, home, hero };
  }

  it('is about the layout, never the page or selection behind it, and names it', () => {
    const { state, home } = teamSite();
    const picked: ElementRef = { owner: { kind: 'page', id: home }, instancePath: [], nodeId: state.pages[home].rootIds[0] };
    const scope = composerScope(state, { pageId: home, selection: picked, definitionMode: null, template: { collectionId: 'team', entryId: 'en_ana' } });
    expect(scope).toMatchObject({ component: null, selection: null, template: { collectionId: 'team', entryId: 'en_ana', name: 'Team' } });
    for (const chosen of ['selection', 'page', 'site'] as const) {
      const ctx = chatContextFor(state, scope, { enabled: { page: true, scope: chosen }, viewport: 1280 });
      expect(ctx).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: null, selectionLabel: null, template: { collectionId: 'team', entryId: 'en_ana', name: 'Team' }, viewport: 1280 });
      expect(targetOf(ctx)).toBe('Team layout');
    }
    // A post open in front of the layout is the target instead.
    const blog = applyOperations(state, [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring' }]).state;
    expect(composerScope(blog, { pageId: home, selection: null, definitionMode: null, post: { collectionId: 'posts', entryId: 'en_spring' }, template: { collectionId: 'team', entryId: 'en_ana' } })).toMatchObject({ post: { entryId: 'en_spring' } });
    expect(composerScope(blog, { pageId: home, selection: null, definitionMode: null, post: { collectionId: 'posts', entryId: 'en_spring' }, template: { collectionId: 'team', entryId: 'en_ana' } }).template).toBeUndefined();
    // The index layout is its own target; a layout that has gone is no target.
    expect(composerScope(state, { pageId: home, selection: null, definitionMode: null, template: { collectionId: 'team', entryId: null, archive: true } }).template).toEqual({ collectionId: 'team', archive: true, name: 'Team' });
    expect(composerScope(state, { pageId: home, selection: picked, definitionMode: null, template: { collectionId: 'gone', entryId: null } })).toMatchObject({ selection: picked });
    expect(composerScope(state, { pageId: home, selection: null, definitionMode: null, template: null }).template).toBeUndefined();
    // Two requests about the two layouts are told apart.
    const detail = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, template: { collectionId: 'team', name: 'Team' } };
    expect(requestTarget({ context: detail })).not.toBe(requestTarget({ context: { ...detail, template: { ...detail.template, archive: true as const } } }));
  });

  it('tries a layout request again on that layout, and continues it, but never one whose layout has gone', () => {
    const { state, home } = teamSite();
    const ctx: ChatContext = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, template: { collectionId: 'team', entryId: 'en_ana', name: 'Team' }, viewport: 1280 };
    expect(retryView(state, ctx, { pageId: home, definitionMode: null })).toMatchObject({ template: { collectionId: 'team', entryId: 'en_ana' }, selection: null, definitionMode: null, missing: null });
    expect(continueContext(user('u', ctx), state, 1280)).toEqual({ ctx });
    expect(continueContext(user('u', { ...ctx, pageId: 'pg_gone' }), state, 1280)).toMatchObject({ ctx: { pageId: home, template: { collectionId: 'team' } } });
    const gone = structuredClone(state);
    delete gone.collections.team;
    // Put back without its layout, it keeps to the page: never the whole site, which a request with no scope once meant.
    expect(retryView(gone, ctx, { pageId: home, definitionMode: null })).toMatchObject({ template: null, missing: 'The Team layout', scope: 'page' });
    // The index layout is tried again as the index layout, and continued only while the collection has an index.
    const index: ChatContext = { ...ctx, template: { collectionId: 'team', archive: true, name: 'Team' } };
    expect(retryView(state, index, { pageId: home, definitionMode: null })).toMatchObject({ template: { collectionId: 'team', entryId: null, archive: true }, missing: null });
    expect(continueContext(user('u', index), state, 1280)).toEqual({ ctx: index });
    const noIndex = applyOperations(state, [{ type: 'collection.update', collectionId: 'team', pages: { detail: true, archive: false } }]).state;
    expect(retryView(noIndex, index, { pageId: home, definitionMode: null })).toMatchObject({ template: null, missing: 'The Team index layout' });
    expect(continueContext(user('u', index), noIndex, 1280)).toMatchObject({ error: expect.stringMatching(/^The Team index layout is no longer in the site/) });
    expect(continueContext(user('u', ctx), gone, 1280)).toEqual({ error: 'The Team layout is no longer in the site. Open a layout or page, then send "Continue".' });
  });
});

describe('what a request was aimed at', () => {
  const ctx = (extra: Partial<ChatContext>): ChatContext => ({ pageId: 'pg_home', pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, ...extra });
  const req = (c: ChatContext): Pick<ChatMessage, 'context'> => ({ context: c });
  const heading = (nodeId: string) => ({ owner: { kind: 'page' as const, id: 'pg_home' }, instancePath: [], nodeId });

  it('tells apart two elements that share a caption, and matches the same one', () => {
    const a = req(ctx({ selection: heading('n_a'), selectionLabel: 'Heading', scope: 'selection' }));
    const b = req(ctx({ selection: heading('n_b'), selectionLabel: 'Heading', scope: 'selection' }));
    expect(targetOf(a.context)).toBe(targetOf(b.context));
    expect(requestTarget(a)).not.toBe(requestTarget(b));
    expect(requestTarget(a)).toBe(requestTarget(req(ctx({ selection: heading('n_a'), selectionLabel: 'Heading', scope: 'selection' }))));
  });

  it('tells apart a question from an edit, and the page from the whole site, about the same page', () => {
    expect(requestTarget(req(ctx({ mode: 'ask' })))).not.toBe(requestTarget(req(ctx({}))));
    expect(requestTarget(req(ctx({ scope: 'page' })))).not.toBe(requestTarget(req(ctx({ scope: 'site' }))));
    expect(requestTarget(undefined)).toBe('');
  });
});
