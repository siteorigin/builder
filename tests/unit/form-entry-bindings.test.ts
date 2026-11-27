/**
 * Where a contact form sends what visitors write is the site's own, never an entry's (#1127): a collection's layout
 * cannot take a form's service or its setting from each entry, nor can an element of a collection loop from each row,
 * whether the form is placed there directly or through a design that passes its own property on to the form. Editing
 * an entry, or syncing one from an outside CMS, then never sends visitors' messages somewhere else. What a form shows
 * (its heading, its copy) can still come from the entry.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { generateProject, publishedState } from '@generator/index';

const FORM = 'foundation.contact.form';
const LAYOUT: OwnerRef = { kind: 'template', id: 'posts' };
const ROUTING = ['provider', 'endpoint', 'accessKey', 'formName'] as const;

const run = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');

/** The engine error a change is refused with. */
function refusal(s: ProjectState, ops: EditOperation[]): string {
  try {
    applyOperations(s, ops);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('Expected the change to be refused.');
}

/**
 * A Posts collection with a published entry and its layout holding a contact form, and "Contact band": a design around
 * a form that passes its own `recipient` on as the form's endpoint, placed in the layout too.
 */
function posts() {
  let state = run(createStarterState('business', 'Studio', false), [
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Open studio', draft: false, excerpt: 'https://evil.example/f' }
  ]).state;
  const step = (owner: OwnerRef, ops: EditOperation[]) => {
    const r = run(state, ops);
    state = r.state;
    return r.results;
  };
  const home: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const section = step(home, [{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
  step(home, [{ type: 'node.insert', owner: home, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/sales' } }]);
  const band = step(home, [{ type: 'component.createFromNode', owner: home, nodeId: section, name: 'Contact band' }])[0].definitionId as string;
  const inner = Object.values(state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
  step(home, [
    { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } },
    { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: inner, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
  ]);
  const form = step(LAYOUT, [{ type: 'node.insert', owner: LAYOUT, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/posts' } }])[0].nodeId as string;
  const wrapped = step(LAYOUT, [{ type: 'node.insert', owner: LAYOUT, parentId: null, definitionId: band, props: { recipient: 'https://forms.example.com/sales' } }])[0].nodeId as string;
  return { state, form, wrapped, band };
}

const bind = (owner: OwnerRef, nodeId: string, prop: string, binding: Record<string, string>): EditOperation => ({ type: 'node.setBinding', owner, nodeId, field: 'prop', prop, binding } as EditOperation);

describe("a collection layout's contact form", () => {
  it('never takes its service or setting from an entry', () => {
    const { state, form } = posts();
    for (const prop of ROUTING) expect(refusal(state, [bind(LAYOUT, form, prop, { $entry: 'excerpt' })]), prop).toMatch(/destination/);
  });

  it('never takes a setting a design passes on to its form from an entry', () => {
    const { state, wrapped } = posts();
    expect(refusal(state, [bind(LAYOUT, wrapped, 'recipient', { $entry: 'excerpt' })])).toMatch(/destination/);
  });

  it('is reported, and keeps the website from being published, when a layout written by hand binds one', () => {
    const { state, form, wrapped } = posts();
    const hand = structuredClone(state);
    const layout = hand.collections.posts.settings.template!;
    (layout.nodes[form] as InstanceNode).props.endpoint = { $entry: 'excerpt' };
    (layout.nodes[wrapped] as InstanceNode).props.recipient = { $entry: 'excerpt' };
    const found = errors(hand).filter((d) => d.owner?.kind === 'template');
    expect(found.map((d) => d.nodeId).sort()).toEqual([form, wrapped].sort());
    for (const d of found) expect(d.message).toMatch(/destination/);
    // The generator never writes the entry's text in as where the form sends.
    expect([...generateProject(publishedState(hand)).values()].some((f) => typeof f === 'string' && f.includes('https://evil.example/f') && f.includes('endpoint'))).toBe(false);
  });

  it('still shows an entry’s own words as its heading', () => {
    const { state, form } = posts();
    const s = run(state, [bind(LAYOUT, form, 'heading', { $entry: 'title' })]).state;
    expect(errors(s)).toEqual([]);
    expect((s.collections.posts.settings.template!.nodes[form] as InstanceNode).props.heading).toEqual({ $entry: 'title' });
  });
});

describe('a contact form inside a collection loop', () => {
  /** A loop over Posts on Home, holding a contact form and a Contact band. */
  function looped() {
    const { state, band } = posts();
    const home: OwnerRef = { kind: 'page', id: state.site.homePageId };
    let s = state;
    const loop = run(s, [{ type: 'node.insert', owner: home, parentId: null, primitive: 'repeat', query: { collectionId: 'posts' } }]);
    s = loop.state;
    const loopId = loop.results[0].nodeId as string;
    const ins = run(s, [
      { type: 'node.insert', owner: home, parentId: loopId, componentId: 'contact.form' },
      { type: 'node.insert', owner: home, parentId: loopId, definitionId: band }
    ]);
    return { s: ins.state, home, form: ins.results[0].nodeId as string, wrapped: ins.results[1].nodeId as string };
  }

  it('never takes its service or setting from a row, directly or through a design', () => {
    const { s, home, form, wrapped } = looped();
    for (const prop of ROUTING) expect(refusal(s, [bind(home, form, prop, { $item: 'excerpt' })]), prop).toMatch(/destination/);
    expect(refusal(s, [bind(home, wrapped, 'recipient', { $item: 'excerpt' })])).toMatch(/destination/);
  });

  it('still shows a row’s own words as its heading', () => {
    const { s, home, form } = looped();
    const after = run(s, [bind(home, form, 'heading', { $item: 'title' })]).state;
    expect(errors(after)).toEqual([]);
  });
});
