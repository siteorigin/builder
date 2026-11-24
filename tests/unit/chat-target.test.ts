// What the AI composer targets while a component is edited everywhere (issue #191): the chips, the context a message
// is sent with, how it is labelled afterwards, and where "Edit and try again" and "Continue" put it back.
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { ChatContext, ChatMessage } from '@shared/api';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import { chatContextFor, composerScope, retryView, targetOf } from '../../src/renderer/src/lib/chatTarget';
import { continueContext } from '../../src/renderer/src/lib/result';

/** A starter project with the home hero and the closing banner each forked, as "Edit everywhere" does. */
function project() {
  let state = createStarterState('business', 'Test', false);
  const home = state.site.homePageId;
  const about = Object.values(state.pages).find((p) => p.route === '/about/')!.id;
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
  const nested = applyOperations(state, [{ type: 'node.insert', owner, parentId: 'content', componentId: 'cta.banner' }]);
  state = nested.state;
  const nestedId = (nested.results[0] as { nodeId: string }).nodeId;
  return { state, home, about, hero, banner, owner, nestedId };
}

const enabled = { page: true, selection: true };
const user = (id: string, context?: ChatContext): ChatMessage => ({ id, role: 'user', text: 'Continue', time: '', ...(context ? { context } : {}) });

describe('the composer while a component is edited everywhere (#191)', () => {
  it('scopes to the component, not the page behind it, at the overview', () => {
    const { state, home, hero } = project();
    const scope = composerScope(state, { pageId: home, selection: null, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(scope).toEqual({ page: { id: home, title: state.pages[home].title }, component: { id: hero, name: 'Split hero' }, selection: null, selectionLabel: null });
    expect(chatContextFor(state, scope, { enabled, viewport: 1280 })).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' }, viewport: 1280 });
  });

  it('offers one of its own nodes, or the whole component when the switch is off', () => {
    const { state, home, hero, owner } = project();
    const heading: ElementRef = { owner, instancePath: [], nodeId: 'heading' };
    const scope = composerScope(state, { pageId: home, selection: heading, definitionMode: { definitionId: hero, returnPageId: home } });
    expect(scope.selection).toEqual(heading);
    expect(scope.selectionLabel).toBe('Heading');
    const sent = chatContextFor(state, scope, { enabled, viewport: 390, assetIds: ['img1'], ask: true });
    expect(sent).toEqual({ pageId: home, pageTitle: state.pages[home].title, selection: heading, selectionLabel: 'Heading', component: { id: hero, name: 'Split hero' }, viewport: 390, assetIds: ['img1'], mode: 'ask' });
    // A frozen copy: a later selection never changes a message already sent.
    expect(sent.selection).not.toBe(heading);
    const whole = chatContextFor(state, scope, { enabled: { page: true, selection: false }, viewport: 390 });
    expect(whole).toMatchObject({ selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' } });
  });

  it('keeps a part of a component placed in the design, and drops a pick from outside it', () => {
    const { state, home, about, hero, owner, nestedId } = project();
    const nestedDef = state.components[(state.components[hero].tree!.nodes[nestedId] as InstanceNode).definitionId];
    const part: ElementRef = { owner, instancePath: [nestedId], nodeId: nestedDef.tree!.rootIds[0] };
    const dm = { definitionId: hero, returnPageId: home };
    expect(composerScope(state, { pageId: home, selection: part, definitionMode: dm }).selection).toEqual(part);
    // A selection on the page (the moment before the canvas turns it into the design's own node) is not offered.
    const onPage: ElementRef = { owner: { kind: 'page', id: about }, instancePath: [], nodeId: state.pages[about].rootIds[0] };
    expect(composerScope(state, { pageId: home, selection: onPage, definitionMode: dm })).toMatchObject({ component: { id: hero }, selection: null, selectionLabel: null });
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
    expect(sent).toMatchObject({ pageId: home, selection: sel });
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

describe('trying a request about a component again (#191)', () => {
  it('goes back to editing that component everywhere, from wherever the author is', () => {
    const { state, home, about, hero, banner, owner } = project();
    const ctx: ChatContext = { pageId: home, pageTitle: 'Home', selection: { owner, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading', component: { id: hero, name: 'Split hero' }, viewport: 1280 };
    // Editing another component everywhere: the request goes back to its own component, never this one.
    expect(retryView(state, ctx, { pageId: about, definitionMode: { definitionId: banner, returnPageId: about } })).toEqual({ pageId: home, definitionMode: { definitionId: hero, returnPageId: about }, selection: ctx.selection, missing: null });
    // On a page: it starts editing the component again, and finishing goes back to that page.
    expect(retryView(state, ctx, { pageId: about, definitionMode: null })).toEqual({ pageId: home, definitionMode: { definitionId: hero, returnPageId: about }, selection: ctx.selection, missing: null });
  });

  it('drops a component or element that has gone, and says which', () => {
    const { state, home, about, hero, banner, owner } = project();
    const ctx: ChatContext = { pageId: home, pageTitle: 'Home', selection: null, selectionLabel: null, component: { id: hero, name: 'Split hero' }, viewport: 1280 };
    const gone = structuredClone(state) as ProjectState;
    delete gone.components[hero];
    expect(retryView(gone, ctx, { pageId: home, definitionMode: { definitionId: banner, returnPageId: about } })).toEqual({ pageId: about, definitionMode: null, selection: null, missing: 'Split hero' });
    const { state: noHeading } = applyOperations(state, [{ type: 'node.remove', owner, nodeId: 'heading' }]);
    expect(retryView(noHeading, { ...ctx, selection: { owner, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading' }, { pageId: home, definitionMode: null })).toMatchObject({ definitionMode: { definitionId: hero }, selection: null, missing: 'Heading' });
    // The page it was shown on has gone: another one shows it, and nothing is missing.
    const { state: noHome } = applyOperations(state, [{ type: 'page.setHome', pageId: about }]);
    const { state: removed } = applyOperations(noHome, [{ type: 'page.remove', pageId: home, replacementPageId: about }]);
    expect(retryView(removed, ctx, { pageId: about, definitionMode: null })).toEqual({ pageId: about, definitionMode: { definitionId: hero, returnPageId: about }, selection: null, missing: null });
  });

  it('leaves Edit everywhere to try a request about a page, and reads older requests about a component', () => {
    const { state, home, about, hero, owner } = project();
    const page: ChatContext = { pageId: about, pageTitle: 'About', selection: null, selectionLabel: null, viewport: 1280 };
    expect(retryView(state, page, { pageId: home, definitionMode: { definitionId: hero, returnPageId: home } })).toEqual({ pageId: about, definitionMode: null, selection: null, missing: null });
    // Sent before requests named their component: the selection inside it still does.
    const older: ChatContext = { pageId: home, pageTitle: 'Home', selection: { owner, instancePath: [], nodeId: 'heading' }, selectionLabel: 'Heading', viewport: 1280 };
    expect(retryView(state, older, { pageId: home, definitionMode: null })).toMatchObject({ definitionMode: { definitionId: hero }, selection: older.selection, missing: null });
    // No context at all (the oldest requests): about the site.
    expect(retryView(state, undefined, { pageId: home, definitionMode: { definitionId: hero, returnPageId: about } })).toEqual({ pageId: about, definitionMode: null, selection: null, missing: null });
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
  });
});
