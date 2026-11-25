import { describe, expect, it } from 'vitest';
import type { ElementNode, InstanceNode, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { slotItems } from '../../src/renderer/src/lib/inline-insert';
import { insertOps } from '../../src/renderer/src/lib/insert-at';
import { clearSlotOps, moveOutOps, moveOutRefusal, slotCountWords, slotOverviews, slotTitle } from '../../src/renderer/src/lib/slot-overview';

/** A placed component's slots as the Inspector lists them (#654), what its Add offers, and how content leaves them. */

const home = (s: ProjectState): PageDoc => s.pages[s.site.homePageId];

/** A blank site with an "Offer card" on Home, inside a Section. It declares Media, Body and Actions, in that order
 *  (not the order their names sort in), and a Quiet slot that takes nothing. */
function offerPage() {
  let state = createStarterState('blank', 'Offers', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const run = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results;
  };
  const [{ definitionId }] = run([
    {
      type: 'component.upsert',
      name: 'Offer card',
      insertAs: 'element',
      properties: {},
      slots: {
        media: { label: 'Media', description: 'A picture above the words.', primitives: ['image'], max: 1 },
        body: { label: 'Body' },
        actions: { label: 'Actions', primitives: ['link', 'text'], max: 2 },
        quiet: { label: 'Quiet', max: 0 }
      },
      nodes: [
        // Placed in another order than they are declared, so only the declaration gives the order listed.
        { kind: 'element', id: 'root', tag: 'article', children: ['quiet', 'body', 'media', 'actions'] },
        { kind: 'slot', id: 'media', slot: 'media' },
        { kind: 'slot', id: 'body', slot: 'body' },
        { kind: 'slot', id: 'actions', slot: 'actions' },
        { kind: 'slot', id: 'quiet', slot: 'quiet' }
      ]
    }
  ]);
  const [{ nodeId: section }] = run([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
  const [{ nodeId: card }] = run([{ type: 'node.insert', owner, parentId: section as string, slot: 'content', definitionId: definitionId as string }]);
  const placed = () => home(state).nodes[card as string] as InstanceNode;
  const rows = () => slotOverviews(state, owner, placed());
  return { run, rows, owner, card: card as string, section: section as string, definitionId: definitionId as string, state: () => state };
}

describe('the slots of a placed component', () => {
  it('are listed in the order the component declares them, each with its description and contract', () => {
    const p = offerPage();
    expect(p.rows().map((r) => [r.slot, r.label, r.description, r.contract])).toEqual([
      ['media', 'Media', 'A picture above the words.', 'Takes images · At most 1'],
      ['body', 'Body', '', 'Takes anything · No limit'],
      ['actions', 'Actions', '', 'Takes buttons and text · At most 2'],
      ['quiet', 'Quiet', '', 'Takes nothing']
    ]);
  });

  it('count what each holds, in order, and close at the limit', () => {
    const p = offerPage();
    expect(p.rows().map((r) => [r.slot, r.count, r.closed])).toEqual([
      ['media', 0, null],
      ['body', 0, null],
      ['actions', 0, null],
      ['quiet', 0, 'This slot takes no content.']
    ]);
    const added = p.run([
      { type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'actions', primitive: 'button' },
      { type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'actions', primitive: 'paragraph', text: 'Ends Friday' },
      { type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'media', primitive: 'image' }
    ]);
    const [media, body, actions] = p.rows();
    expect(actions.children).toEqual([added[0].nodeId, added[1].nodeId]);
    expect(actions.count).toBe(2);
    expect(actions.closed).toBe('Full: it holds at most 2 items. Take something out to add more.');
    expect(media.closed).toBe('Full: it holds at most 1 item. Take something out to add more.');
    expect([body.count, body.closed]).toEqual([0, null]);
    // Content over a limit tightened by hand is still counted, and the slot stays closed.
    const over = structuredClone(p.state());
    over.components[p.definitionId].slots!.actions.max = 1;
    expect(slotOverviews(over, p.owner, home(over).nodes[p.card] as InstanceNode)[2]).toMatchObject({ count: 2, closed: 'Full: it holds at most 1 item. Take something out to add more.' });
  });

  it('a slot naming components says their names, and one restricted to nothing is closed', () => {
    const p = offerPage();
    const [{ definitionId: band }] = p.run([{ type: 'component.upsert', name: 'Wide band', insertAs: 'section', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section' }] }]);
    p.run([
      // One by definition ID, and a catalogue contract the project has not installed, named by its ID.
      { type: 'component.setSlot', definitionId: p.definitionId, slot: 'body', label: 'Body', componentIds: [band as string, 'media.gallery'] },
      { type: 'component.setSlot', definitionId: p.definitionId, slot: 'media', label: 'Media', primitives: [], categories: [] }
    ]);
    const [media, body] = p.rows();
    expect(body.contract).toBe('Takes “Wide band” and “media.gallery” · No limit');
    expect(body.closed).toBeNull();
    expect(media.contract).toBe('Takes nothing · At most 1');
    expect(media.closed).toBe('This slot takes no content.');
  });

  it('a declaration damaged by hand says what is wrong rather than a contract', () => {
    const p = offerPage();
    const state = structuredClone(p.state());
    (state.components[p.definitionId].slots!.body as { label: unknown }).label = '';
    (state.components[p.definitionId].slots!.actions as { max: unknown }).max = 'two';
    const [, body, actions] = slotOverviews(state, p.owner, home(state).nodes[p.card] as InstanceNode);
    expect(body).toMatchObject({ slot: 'body', label: 'body', contract: '', damaged: 'The slot “body” has no label.' });
    expect(actions).toMatchObject({ slot: 'actions', contract: '', damaged: 'The slot “actions” has a limit that is not a whole number from 0 to 1000.' });
    // Changes name a slot by its label, or by its own name when the label is not text.
    (state.components[p.definitionId].slots!.body as { label: unknown }).label = { toString: null };
    expect([slotTitle(state.components[p.definitionId], 'body'), slotTitle(state.components[p.definitionId], 'media')]).toEqual(['body', 'Media']);
  });

  it('a slot whose stored content is no list says so, since adding to it would write over it', () => {
    const p = offerPage();
    const state = structuredClone(p.state());
    (home(state).nodes[p.card] as InstanceNode).slots = { body: 'n_lost' as unknown as string[] };
    const rows = slotOverviews(state, p.owner, home(state).nodes[p.card] as InstanceNode);
    expect(rows.map((r) => r.damaged)).toEqual([null, 'What “Body” holds is damaged.', null, null]);
    expect(rows[1].contract).toBe('Takes anything · No limit');
  });

  it('are none for a component that declares none', () => {
    const p = offerPage();
    const [{ definitionId }] = p.run([{ type: 'component.upsert', name: 'Plain', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'div' }] }]);
    const [{ nodeId }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: definitionId as string }]);
    expect(slotOverviews(p.state(), p.owner, home(p.state()).nodes[nodeId as string] as InstanceNode)).toEqual([]);
  });

  it('say how many items each holds in words', () => {
    expect([0, 1, 3, Infinity].map(slotCountWords)).toEqual(['Empty', '1 item', '3 items', 'Any number of items']);
  });
});

describe('what a slot’s Add offers', () => {
  /** The keys offered for the slot `slot` of the card. */
  const offered = (p: ReturnType<typeof offerPage>, slot: string) => slotItems(p.state(), { owner: p.owner, parentId: p.card, slot }).map((i) => i.key);

  it('for a slot that takes anything: the basic elements, the project’s components and the theme’s sections', () => {
    const p = offerPage();
    const [{ definitionId: band }, { definitionId: tag }] = p.run([
      { type: 'component.upsert', name: 'Wide band', insertAs: 'section', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section' }] },
      { type: 'component.upsert', name: 'Small tag', insertAs: 'element', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'div' }] }
    ]);
    const keys = offered(p, 'body');
    expect(keys).toEqual(expect.arrayContaining(['e:paragraph', 'e:button', 'e:bento', `c:${band}`, `c:${tag}`, 's:media.gallery', 's:hero.centered']));
  });

  it('for a slot that takes some kinds of element: only those', () => {
    const p = offerPage();
    expect(offered(p, 'actions').sort()).toEqual(['e:bulleted-list', 'e:button', 'e:heading', 'e:numbered-list', 'e:paragraph']);
    expect(offered(p, 'media')).toEqual(['e:image']);
  });

  it('for a slot that takes a category or names components: those, even ones otherwise placed among sections', () => {
    const p = offerPage();
    const [{ definitionId: band }] = p.run([{ type: 'component.upsert', name: 'Wide band', insertAs: 'section', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section' }] }]);
    p.run([{ type: 'component.setSlot', definitionId: p.definitionId, slot: 'body', label: 'Body', categories: ['media'], componentIds: [band as string] }]);
    expect(offered(p, 'body').sort()).toEqual([`c:${band}`, 's:block.video', 's:media.carousel', 's:media.gallery', 's:media.video']);
  });

  it('leaves out what the place would refuse though the contract takes it: a Button once the card sits inside a link', () => {
    const p = offerPage();
    expect(offered(p, 'actions')).toContain('e:button');
    const [{ nodeId: stack }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', primitive: 'stack' }]);
    p.run([{ type: 'node.move', owner: p.owner, nodeId: p.card, parentId: stack as string, index: 0 }]);
    const state = structuredClone(p.state());
    (home(state).nodes[stack as string] as ElementNode).link = { type: 'url', target: 'https://example.com' };
    const keys = slotItems(state, { owner: p.owner, parentId: p.card, slot: 'actions' }).map((i) => i.key);
    expect(keys).toContain('e:paragraph');
    expect(keys).not.toContain('e:button');
  });

  it('offers a design a slot names that the site kept from another theme, and puts that very design in', () => {
    const p = offerPage();
    const state = structuredClone(p.state());
    // As a theme change leaves a design some project component builds on: installed, and no longer in the catalogue.
    const section = state.components[(home(state).nodes[p.section] as InstanceNode).definitionId];
    state.components['old.layout.section'] = { ...structuredClone(section), id: 'old.layout.section', name: 'Old section' };
    state.components[p.definitionId].slots!.body = { label: 'Body', componentIds: ['old.layout.section'] };
    const at = { owner: p.owner, parentId: p.card, slot: 'body' };
    const items = slotItems(state, at);
    expect(items.map((i) => [i.key, i.group])).toEqual([['c:old.layout.section', 'From the theme']]);
    const out = applyOperations(state, insertOps(at, items[0].spec, 'element'));
    expect((home(out.state).nodes[out.results[0].nodeId as string] as InstanceNode).definitionId).toBe('old.layout.section');
  });

  it('what is chosen goes into that slot and no other', () => {
    const p = offerPage();
    p.run([{ type: 'component.setSlot', definitionId: p.definitionId, slot: 'body', label: 'Body', categories: ['media'] }]);
    const at = { owner: p.owner, parentId: p.card, slot: 'body' };
    const gallery = slotItems(p.state(), at).find((i) => i.key === 's:media.gallery')!;
    const [{ nodeId }] = p.run(insertOps(at, gallery.spec, 'element'));
    expect((home(p.state()).nodes[p.card] as InstanceNode).slots).toEqual({ body: [nodeId] });
    expect(p.rows().map((r) => r.count)).toEqual([0, 1, 0, 0]);
  });

  it('nothing once the slot is full', () => {
    const p = offerPage();
    p.run([{ type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'media', primitive: 'image' }]);
    expect(offered(p, 'media')).toEqual([]);
  });

  const UNSHOWN = 'This component doesn’t show this slot here, so nothing added to it would appear.';

  it('a slot the design no longer shows is closed, and says why', () => {
    const p = offerPage();
    expect(p.rows()[1].closed).toBeNull();
    const placeholder = Object.values(p.state().components[p.definitionId].tree!.nodes).find((n) => n.kind === 'slot' && n.slot === 'body')!;
    p.run([{ type: 'node.remove', owner: { kind: 'component', id: p.definitionId }, nodeId: placeholder.id }]);
    expect(p.rows()[1]).toMatchObject({ slot: 'body', count: 0, closed: UNSHOWN });
  });

  it('a slot shown only in another’s fallback is closed once the placement fills that other', () => {
    const p = offerPage();
    const [{ definitionId }] = p.run([
      {
        type: 'component.upsert',
        name: 'Swap card',
        insertAs: 'element',
        properties: {},
        slots: { body: { label: 'Body' }, aside: { label: 'Aside' } },
        nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['body'] }, { kind: 'slot', id: 'body', slot: 'body', children: ['aside'] }, { kind: 'slot', id: 'aside', slot: 'aside' }]
      }
    ]);
    const [{ nodeId }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: definitionId as string }]);
    const rows = () => slotOverviews(p.state(), p.owner, home(p.state()).nodes[nodeId as string] as InstanceNode);
    expect(rows().map((r) => r.closed)).toEqual([null, null]);
    p.run([{ type: 'node.insert', owner: p.owner, parentId: nodeId as string, slot: 'body', primitive: 'paragraph' }]);
    expect(rows().map((r) => r.closed)).toEqual([null, UNSHOWN]);
  });

  it('a slot handed into another component’s fallback is closed once the design fills the slot that fallback is for', () => {
    const p = offerPage();
    const [{ definitionId: inner }] = p.run([
      {
        type: 'component.upsert',
        name: 'Frame',
        insertAs: 'element',
        properties: {},
        slots: { a: { label: 'A' }, b: { label: 'B' } },
        nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['a'] }, { kind: 'slot', id: 'a', slot: 'a', children: ['b'] }, { kind: 'slot', id: 'b', slot: 'b' }]
      }
    ]);
    const [{ definitionId: outer }] = p.run([
      { type: 'component.upsert', name: 'Framed', insertAs: 'element', properties: {}, slots: { body: { label: 'Body' } }, nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['body'] }, { kind: 'slot', id: 'body', slot: 'body' }] }
    ]);
    const design: OwnerRef = { kind: 'component', id: outer as string };
    const { rootIds, nodes } = p.state().components[outer as string].tree!;
    const placeholder = Object.values(nodes).find((n) => n.kind === 'slot')!.id;
    const [{ nodeId: frame }] = p.run([{ type: 'node.insert', owner: design, parentId: rootIds[0], definitionId: inner as string }]);
    p.run([{ type: 'node.move', owner: design, nodeId: placeholder, parentId: frame as string, slot: 'b', index: 0 }]);
    const [{ nodeId }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: outer as string }]);
    const closed = () => slotOverviews(p.state(), p.owner, home(p.state()).nodes[nodeId as string] as InstanceNode)[0].closed;
    // The Frame shows B while nothing fills A.
    expect(closed()).toBeNull();
    p.run([{ type: 'node.insert', owner: design, parentId: frame as string, slot: 'a', primitive: 'paragraph' }]);
    expect(closed()).toBe(UNSHOWN);
  });

  it('a slot handed to a component placed in the design is closed when that component renders no such slot', () => {
    const p = offerPage();
    const [{ definitionId: inner }] = p.run([
      { type: 'component.upsert', name: 'Frame', insertAs: 'element', properties: {}, slots: { in: { label: 'In' } }, nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['in'] }, { kind: 'slot', id: 'in', slot: 'in' }] }
    ]);
    const [{ definitionId: outer }] = p.run([
      {
        type: 'component.upsert',
        name: 'Framed',
        insertAs: 'element',
        properties: {},
        slots: { body: { label: 'Body' } },
        nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['body'] }, { kind: 'slot', id: 'body', slot: 'body' }]
      }
    ]);
    // In the design, the Frame is placed and the slot's placeholder handed on into its In slot.
    const design: OwnerRef = { kind: 'component', id: outer as string };
    const { rootIds, nodes } = p.state().components[outer as string].tree!;
    const placeholder = Object.values(nodes).find((n) => n.kind === 'slot')!.id;
    const [{ nodeId: frameNode }] = p.run([{ type: 'node.insert', owner: design, parentId: rootIds[0], definitionId: inner as string }]);
    p.run([{ type: 'node.move', owner: design, nodeId: placeholder, parentId: frameNode as string, slot: 'in', index: 0 }]);
    const [{ nodeId }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: outer as string }]);
    const closed = (state: ProjectState) => slotOverviews(state, p.owner, home(state).nodes[nodeId as string] as InstanceNode)[0].closed;
    expect(closed(p.state())).toBeNull();
    const state = structuredClone(p.state());
    const frame = state.components[inner as string].tree!;
    const outlet = Object.values(frame.nodes).find((n) => n.kind === 'slot')!;
    (frame.nodes[frame.rootIds[0]] as ElementNode).children = [];
    delete frame.nodes[outlet.id];
    expect(closed(state)).toBe(UNSHOWN);
  });
});

describe('taking a slot’s content out', () => {
  /** The card with two buttons in Actions and a paragraph in Body, and a paragraph after the card in its Section. */
  function filled() {
    const p = offerPage();
    const added = p.run([
      { type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'actions', primitive: 'button' },
      { type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'actions', primitive: 'paragraph', text: 'Ends Friday' },
      { type: 'node.insert', owner: p.owner, parentId: p.card, slot: 'body', primitive: 'paragraph', text: 'Ten weeks' },
      { type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', primitive: 'paragraph', text: 'After' }
    ]);
    const [button, ends, words, after] = added.map((r) => r.nodeId as string);
    const slots = (s: ProjectState, id: string) => (home(s).nodes[id] as InstanceNode).slots;
    return { ...p, button, ends, words, after, slots };
  }

  it('Clear deletes what that slot holds, in one change, and leaves the others', () => {
    const p = filled();
    const out = applyOperations(p.state(), clearSlotOps(p.state(), p.owner, p.card, 'actions')).state;
    expect(p.slots(out, p.card)).toMatchObject({ actions: [], body: [p.words] });
    expect([p.button, p.ends].some((id) => id in home(out).nodes)).toBe(false);
    expect(p.slots(out, p.section)!.content).toEqual([p.card, p.after]);
    expect(clearSlotOps(p.state(), p.owner, p.card, 'quiet')).toEqual([]);
  });

  it('Move out puts what that slot holds just after the placement, in order, keeping the placement and its other slots', () => {
    const p = filled();
    const out = applyOperations(p.state(), moveOutOps(p.state(), p.owner, p.card, 'actions')).state;
    expect(p.slots(out, p.section)!.content).toEqual([p.card, p.button, p.ends, p.after]);
    expect(p.slots(out, p.card)).toMatchObject({ actions: [], body: [p.words] });
    expect(home(out).nodes[p.ends]).toEqual(home(p.state()).nodes[p.ends]);
    expect(validateState(out).filter((d) => d.severity === 'error')).toEqual([]);
    expect(moveOutOps(p.state(), p.owner, p.card, 'quiet')).toEqual([]);
  });

  it('Move out into a container puts it among the container’s children', () => {
    const p = filled();
    const [{ nodeId: stack }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', primitive: 'stack' }]);
    p.run([{ type: 'node.move', owner: p.owner, nodeId: p.card, parentId: stack as string, index: 0 }]);
    const [{ nodeId: below }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: stack as string, primitive: 'paragraph', text: 'Below' }]);
    const out = applyOperations(p.state(), moveOutOps(p.state(), p.owner, p.card, 'actions')).state;
    expect((home(out).nodes[stack as string] as ElementNode).children).toEqual([p.card, p.button, p.ends, below]);
  });

  it('Move out of a section on the page puts sections on the page as they are, and each run of anything else in a new Section', () => {
    const p = filled();
    const [{ definitionId: bandDef }] = p.run([{ type: 'component.upsert', name: 'Wide band', insertAs: 'section', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section' }] }]);
    const [{ nodeId: gallery }, { nodeId: last }, { nodeId: band }, { nodeId: footnote }] = p.run([
      { type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', index: 1, componentId: 'media.gallery' },
      { type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', primitive: 'paragraph', text: 'Last' },
      { type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: bandDef as string },
      { type: 'node.insert', owner: p.owner, parentId: null, componentId: 'layout.section' }
    ]);
    const before = home(p.state()).rootIds;
    const out = applyOperations(p.state(), moveOutOps(p.state(), p.owner, p.section, 'content')).state;
    const roots = home(out).rootIds;
    const at = before.indexOf(p.section);
    expect(before.at(-1)).toBe(footnote);
    expect(roots).toHaveLength(before.length + 4);
    const [source, first, second, third, fourth, ...rest] = roots.slice(at);
    expect([source, second, fourth, ...rest]).toEqual([p.section, gallery, band, footnote]);
    expect(p.slots(out, p.section)!.content).toEqual([]);
    expect(p.slots(out, first)!.content).toEqual([p.card]);
    expect(p.slots(out, third)!.content).toEqual([p.after, last]);
    for (const wrapper of [first, third]) expect(out.components[(home(out).nodes[wrapper] as InstanceNode).definitionId].componentId).toBe('layout.section');
    expect(validateState(out).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('Move out is refused whole when the slot holding the placement has room for only some of it', () => {
    const p = filled();
    const [{ definitionId: holder }] = p.run([
      { type: 'component.upsert', name: 'Pair', insertAs: 'element', properties: {}, slots: { two: { label: 'Two', max: 2 } }, nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['two'] }, { kind: 'slot', id: 'two', slot: 'two' }] }
    ]);
    const [{ nodeId: pair }] = p.run([{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: holder as string }]);
    p.run([{ type: 'node.move', owner: p.owner, nodeId: p.card, parentId: pair as string, slot: 'two', index: 0 }]);
    const state = p.state();
    const was = structuredClone(state);
    // The first fits beside the card; the second does not.
    expect(() => applyOperations(state, moveOutOps(state, p.owner, p.card, 'actions'))).toThrow(/^Operation 2 \(node\.move\): The “Two” slot of “Pair” holds at most 2 items/);
    expect(state).toEqual(was);
  });

  it('in a collection layout, goes straight onto the layout’s top level, still reading the entry', () => {
    let state = applyOperations(createStarterState('business', 'Journal', false), [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'component.upsert', name: 'Byline', insertAs: 'element', properties: {}, slots: { words: { label: 'Words' } }, nodes: [{ kind: 'element', id: 'root', tag: 'div', children: ['words'] }, { kind: 'slot', id: 'words', slot: 'words' }] }
    ]).state;
    const owner: OwnerRef = { kind: 'template', id: 'posts' };
    const byline = Object.values(state.components).find((d) => d.name === 'Byline')!.id;
    const layout = () => state.collections.posts.settings.template;
    const placed = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, definitionId: byline }]);
    state = placed.state;
    const card = placed.results[0].nodeId as string;
    const added = applyOperations(state, [{ type: 'node.insert', owner, parentId: card, slot: 'words', primitive: 'heading' }]);
    state = added.state;
    const title = added.results[0].nodeId as string;
    state = applyOperations(state, [{ type: 'node.setBinding', owner, nodeId: title, field: 'text', binding: { $entry: 'title' } }]).state;
    const sections = layout().rootIds.length;
    state = applyOperations(state, moveOutOps(state, owner, card, 'words')).state;
    expect(layout().rootIds).toHaveLength(sections + 1);
    expect(layout().rootIds.slice(-2)).toEqual([card, title]);
    expect((layout().nodes[card] as InstanceNode).slots?.words).toEqual([]);
    expect(layout().nodes[title]).toMatchObject({ text: { $entry: 'title' } });
  });

  it('is refused in the shared header and footer, where the editor could not take the moved content out again', () => {
    expect(moveOutRefusal({ kind: 'page', id: 'p' })).toBeNull();
    for (const part of ['header', 'footer'] as const) {
      const p = filled();
      const owner: OwnerRef = { kind: 'shell', id: part };
      const [{ nodeId: card }] = p.run([{ type: 'node.insert', owner, parentId: null, definitionId: p.definitionId }]);
      p.run([{ type: 'node.insert', owner, parentId: card as string, slot: 'body', primitive: 'paragraph' }]);
      expect(clearSlotOps(p.state(), owner, card as string, 'body')).toHaveLength(1);
      expect(moveOutOps(p.state(), owner, card as string, 'body')).toEqual([]);
      expect(moveOutRefusal(owner)).toBe(`Content can’t be moved around in the shared ${part}. Clear removes it.`);
    }
  });

  it('takes nothing out of a slot whose content a hand edit also lists elsewhere, so nothing there is lost', () => {
    const p = filled();
    expect(p.rows().map((r) => r.shared)).toEqual([null, null, null, null]);
    const state = structuredClone(p.state());
    const [root] = home(state).rootIds;
    // Body now also lists the page's own section.
    (home(state).nodes[p.card] as InstanceNode).slots!.body.push(root);
    const rows = slotOverviews(state, p.owner, home(state).nodes[p.card] as InstanceNode);
    expect(rows.map((r) => !!r.shared)).toEqual([false, true, false, false]);
    expect(clearSlotOps(state, p.owner, p.card, 'body')).toEqual([]);
    expect(moveOutOps(state, p.owner, p.card, 'body')).toEqual([]);
    expect(clearSlotOps(state, p.owner, p.card, 'actions')).toHaveLength(2);
  });
});
