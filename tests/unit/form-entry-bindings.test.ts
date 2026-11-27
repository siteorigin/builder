/**
 * Where a contact form sends what visitors write is the site's own, never an entry's (#1127): a collection's layout
 * cannot take a form's service or its setting from each entry, nor can an element of a collection loop from each row,
 * nor a list filled from a collection or a feed, whether the form is placed there directly or through a design that
 * passes its own property on to the form. Editing an entry, or syncing one from an outside CMS, then never sends
 * visitors' messages somewhere else, and a project written by hand that would is not exported. What a form shows (its
 * heading, its copy) can still come from the entry.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { formDestinationProblems } from '@engine/collection-sources';
import { generateProject, publishedState } from '@generator/index';

const FORM = 'foundation.contact.form';
const LAYOUT: OwnerRef = { kind: 'template', id: 'posts' };
const ROUTING = ['provider', 'endpoint', 'accessKey', 'formName'] as const;
const EVIL = 'https://evil.example/f';

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
 * A Posts collection with a published entry (its excerpt an address, and a "Service" choice field whose options are a
 * form's services, so every setting has a field that fits it) and its layout holding a contact form, and "Contact
 * band": a design around a form that passes its own `recipient` on as the form's endpoint, placed in the layout too.
 */
function posts() {
  let state = run(createStarterState('business', 'Studio', false), [
    { type: 'collection.create', collectionId: 'posts' },
    {
      type: 'collection.update',
      collectionId: 'posts',
      fields: { service: { type: 'enum', label: 'Service', options: [{ value: 'endpoint', label: 'Endpoint' }, { value: 'web3forms', label: 'Web3Forms' }, { value: 'netlify', label: 'Netlify' }], default: 'endpoint' } }
    },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Open studio', draft: false, excerpt: EVIL, values: { service: 'endpoint' } }
  ] as EditOperation[]).state;
  const step = (ops: EditOperation[]) => {
    const r = run(state, ops);
    state = r.state;
    return r.results;
  };
  const home: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const section = step([{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }])[0].nodeId as string;
  step([{ type: 'node.insert', owner: home, parentId: section, slot: 'content', componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/sales' } }]);
  const band = step([{ type: 'component.createFromNode', owner: home, nodeId: section, name: 'Contact band' }])[0].definitionId as string;
  const inner = Object.values(state.components[band].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === FORM)!.id;
  step([
    { type: 'component.setPropSchema', definitionId: band, prop: 'recipient', schema: { type: 'string', label: 'Recipient', default: '' } },
    { type: 'component.setPropSchema', definitionId: band, prop: 'title', schema: { type: 'string', label: 'Title', default: '' } },
    { type: 'node.setBinding', owner: { kind: 'component', id: band }, nodeId: inner, field: 'prop', prop: 'endpoint', binding: { $prop: 'recipient' } }
  ]);
  const form = step([{ type: 'node.insert', owner: LAYOUT, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: 'https://forms.example.com/posts' } }])[0].nodeId as string;
  const wrapped = step([{ type: 'node.insert', owner: LAYOUT, parentId: null, definitionId: band, props: { recipient: 'https://forms.example.com/sales' } }])[0].nodeId as string;
  return { state, home, form, wrapped, band, inner };
}

const bind = (owner: OwnerRef, nodeId: string, prop: string, binding: Record<string, string>): EditOperation => ({ type: 'node.setBinding', owner, nodeId, field: 'prop', prop, binding }) as EditOperation;
/** The entry field that fits each of a form's settings. */
const FITS: Record<(typeof ROUTING)[number], string> = { provider: 'field.service', endpoint: 'excerpt', accessKey: 'excerpt', formName: 'excerpt' };

describe("a collection layout's contact form", () => {
  for (const prop of ROUTING)
    it(`never takes its ${prop} from an entry`, () => {
      const { state, form } = posts();
      expect(refusal(state, [bind(LAYOUT, form, prop, { $entry: FITS[prop] })])).toMatch(/cannot take where it sends what visitors write from .*a form's destination is set on the form, never read from an entry/);
    });

  it('never takes a setting a design passes on to its form from an entry', () => {
    const { state, wrapped } = posts();
    expect(refusal(state, [bind(LAYOUT, wrapped, 'recipient', { $entry: 'excerpt' })])).toMatch(/destination is set on the form/);
  });

  it('refuses a design passing on to its form a property a layout already fills from the entry, in the same batch or later', () => {
    const { state, wrapped, band, inner } = posts();
    // The band's title reads the entry, which is only copy while the band shows it as copy.
    const titled = run(state, [bind(LAYOUT, wrapped, 'title', { $entry: 'excerpt' })]).state;
    expect(errors(titled)).toEqual([]);
    // The design then sends its form's messages wherever its title says: no entry binding in the edit, and still refused.
    const passOn = bind({ kind: 'component', id: band }, inner, 'endpoint', { $prop: 'title' });
    expect(refusal(titled, [passOn])).toMatch(/destination is set on the form/);
    expect(refusal(state, [bind(LAYOUT, wrapped, 'title', { $entry: 'excerpt' }), passOn])).toMatch(/destination is set on the form/);
  });

  it('is reported, and keeps the project from being exported, when a layout written by hand binds one', () => {
    const { state, form, wrapped } = posts();
    const hand = structuredClone(state);
    const layout = hand.collections.posts.settings.template!;
    (layout.nodes[form] as InstanceNode).props.endpoint = { $entry: 'excerpt' };
    (layout.nodes[wrapped] as InstanceNode).props.recipient = { $entry: 'excerpt' };
    const found = errors(hand).filter((d) => d.owner?.kind === 'template');
    expect(found.map((d) => d.nodeId).sort()).toEqual([form, wrapped].sort());
    for (const d of found) expect(d.message).toMatch(/takes where it sends what visitors write from the entry's “Excerpt”/);
    // What the export refuses (src/main/controller.ts exportBlocked).
    expect(formDestinationProblems(hand).map((p) => p.nodeId).sort()).toEqual([form, wrapped].sort());
    expect(formDestinationProblems(state)).toEqual([]);
    // Any other edit to the project still saves: the problem was already there.
    expect(() => run(hand, [{ type: 'page.update', pageId: hand.site.homePageId, title: 'Welcome' } as EditOperation])).not.toThrow();
    // And it can be undone: the binding removed, the form is the layout's own again.
    const fixed = run(hand, [{ type: 'node.setBinding', owner: LAYOUT, nodeId: form, field: 'prop', prop: 'endpoint', binding: null } as EditOperation, { type: 'node.setBinding', owner: LAYOUT, nodeId: wrapped, field: 'prop', prop: 'recipient', binding: null } as EditOperation]).state;
    expect(formDestinationProblems(fixed)).toEqual([]);
  });

  it('still shows an entry’s own words as its heading, and sends where the layout says', () => {
    const { state, form } = posts();
    const s = run(state, [bind(LAYOUT, form, 'heading', { $entry: 'excerpt' })]).state;
    expect(errors(s)).toEqual([]);
    expect((s.collections.posts.settings.template!.nodes[form] as InstanceNode).props.heading).toEqual({ $entry: 'excerpt' });
    const page = [...generateProject(publishedState(s)).entries()].find(([path]) => path.includes('open-studio'))?.[1];
    expect(typeof page === 'string' && page.includes(EVIL)).toBe(true);
    expect(typeof page === 'string' && page.includes('https://forms.example.com/posts')).toBe(true);
  });
});

describe('a contact form inside a collection loop', () => {
  /** A loop over Posts on Home, holding a contact form and a Contact band. */
  function looped() {
    const { state, band, home } = posts();
    const loop = run(state, [{ type: 'node.insert', owner: home, parentId: null, primitive: 'repeat', query: { collectionId: 'posts' } }]);
    const loopId = loop.results[0].nodeId as string;
    const ins = run(loop.state, [
      { type: 'node.insert', owner: home, parentId: loopId, componentId: 'contact.form' },
      { type: 'node.insert', owner: home, parentId: loopId, definitionId: band }
    ]);
    return { s: ins.state, home, form: ins.results[0].nodeId as string, wrapped: ins.results[1].nodeId as string };
  }

  for (const prop of ROUTING)
    it(`never takes its ${prop} from a row`, () => {
      const { s, home, form } = looped();
      expect(refusal(s, [bind(home, form, prop, { $item: FITS[prop] })])).toMatch(/destination is set on the form/);
    });

  it('never takes a setting a design passes on to its form from a row, and is reported when written by hand', () => {
    const { s, home, form, wrapped } = looped();
    expect(refusal(s, [bind(home, wrapped, 'recipient', { $item: 'excerpt' })])).toMatch(/destination is set on the form/);
    const hand = structuredClone(s);
    (hand.pages[home.id].nodes[form] as InstanceNode).props.formName = { $item: 'title' };
    expect(errors(hand).filter((d) => d.nodeId === form).map((d) => d.message)).toEqual([expect.stringMatching(/takes where it sends what visitors write from “Title”/)]);
    expect(formDestinationProblems(hand).map((p) => p.nodeId)).toEqual([form]);
  });

  it('still shows a row’s own words as its heading', () => {
    const { s, home, form } = looped();
    expect(errors(run(s, [bind(home, form, 'heading', { $item: 'title' })]).state)).toEqual([]);
  });
});

describe('a list that passes its items on to a contact form', () => {
  /**
   * "Office forms": a design whose `offices` list repeats a contact form per office, each sending to the office's
   * inbox under the office's name. With `feed`, the list fills itself from the site's entries.
   */
  function offices(feed?: 'entries') {
    const { state, home } = posts();
    const s = structuredClone(state);
    const form = makeInstance(s.components[FORM], { provider: 'endpoint', endpoint: { $item: 'excerpt' }, heading: { $item: 'title' } });
    const repeat = { id: 'n_offrep1', kind: 'repeat', list: { $prop: 'offices' }, children: [form.id] };
    const root = { id: 'n_offroot', kind: 'element', tag: 'div', children: [repeat.id] };
    s.components['project.offices'] = {
      schemaVersion: 1,
      id: 'project.offices',
      componentId: 'project.offices',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Office forms',
      description: '',
      category: 'custom',
      tags: [],
      properties: { offices: { type: 'list', label: 'Offices', itemLabel: 'Office', fields: { title: { type: 'string', label: 'Name', default: '' }, excerpt: { type: 'string', label: 'Inbox', default: '' } }, default: [], ...(feed ? { feed } : {}) } },
      parts: { root: { nodeId: root.id, label: 'Root' } },
      tree: { rootIds: [root.id], nodes: { [root.id]: root, [repeat.id]: repeat, [form.id]: form } }
    } as unknown as ComponentDefinition;
    return { s, home };
  }

  it('is never connected to a collection', () => {
    const { s: base, home } = offices();
    const placed = run(base, [{ type: 'node.insert', owner: home, parentId: null, definitionId: 'project.offices' } as EditOperation]);
    const node = placed.results[0].nodeId as string;
    const connect = { type: 'instance.setListSource', owner: home, nodeId: node, prop: 'offices', source: { query: { collectionId: 'posts' }, fields: { title: 'title', excerpt: 'excerpt' } } } as EditOperation;
    expect(refusal(placed.state, [connect])).toMatch(/fills where it sends what visitors write \(“Offices”\) from a collection's entries/);
    // Written by hand, it is reported and stops the export.
    const hand = structuredClone(placed.state);
    (hand.pages[home.id].nodes[node] as InstanceNode).listSources = { offices: { query: { collectionId: 'posts' }, fields: { title: 'title', excerpt: 'excerpt' } } } as InstanceNode['listSources'];
    expect(formDestinationProblems(hand).map((p) => p.nodeId)).toEqual([node]);
  });

  it('never fills itself from the site’s entries', () => {
    const { s, home } = offices('entries');
    expect(refusal(s, [{ type: 'node.insert', owner: home, parentId: null, definitionId: 'project.offices' } as EditOperation])).toMatch(/fills where it sends what visitors write \(“Offices”\) from the site's entries/);
  });

  it('is an ordinary list while its items are its own', () => {
    const { s, home } = offices();
    const placed = run(s, [{ type: 'node.insert', owner: home, parentId: null, definitionId: 'project.offices' } as EditOperation]);
    expect(formDestinationProblems(placed.state)).toEqual([]);
  });
});
