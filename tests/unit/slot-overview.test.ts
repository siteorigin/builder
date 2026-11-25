import { describe, expect, it } from 'vitest';
import type { ElementNode, InstanceNode, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { slotItems } from '../../src/renderer/src/lib/inline-insert';
import { insertOps } from '../../src/renderer/src/lib/insert-at';
import { clearSlotOps, moveOutOps, moveOutRefusal, slotCountWords, slotOverviews } from '../../src/renderer/src/lib/slot-overview';

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
        { kind: 'element', id: 'root', tag: 'article', children: ['media', 'body', 'actions', 'quiet'] },
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
  });

  it('a slot naming components says their names, and one restricted to nothing is closed', () => {
    const p = offerPage();
    p.run([
      { type: 'component.setSlot', definitionId: p.definitionId, slot: 'body', label: 'Body', componentIds: ['media.gallery'] },
      { type: 'component.setSlot', definitionId: p.definitionId, slot: 'media', label: 'Media', primitives: [], categories: [] }
    ]);
    const [media, body] = p.rows();
    expect(body.contract).toMatch(/^Takes “.+” · No limit$/);
    expect(body.closed).toBeNull();
    expect(media.contract).toBe('Takes nothing · At most 1');
    expect(media.closed).toBe('This slot takes no content.');
  });

  it('a declaration damaged by hand says what is wrong rather than a contract', () => {
    const p = offerPage();
    const state = structuredClone(p.state());
    (state.components[p.definitionId].slots!.body as { label: unknown }).label = '';
    const [, body] = slotOverviews(state, p.owner, home(state).nodes[p.card] as InstanceNode);
    expect(body).toMatchObject({ slot: 'body', label: 'body', contract: '', damaged: 'has no label' });
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
    p.run([{ type: 'component.upsert', name: 'Wide band', insertAs: 'section', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section' }] }]);
    const band = Object.values(p.state().components).find((d) => d.name === 'Wide band')!.id;
    const keys = offered(p, 'body');
    expect(keys).toEqual(expect.arrayContaining(['e:paragraph', 'e:button', 'e:bento', `c:${band}`, 's:media.gallery', 's:hero.centered']));
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
    expect(offered(p, 'body').sort()).toEqual([`c:${band}`, 's:media.carousel', 's:media.gallery', 's:media.video']);
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

  it('a slot the design no longer shows is closed, and says why', () => {
    const p = offerPage();
    p.run([{ type: 'component.setSlot', definitionId: p.definitionId, slot: 'extra', label: 'Extra' }]);
    expect(p.rows().at(-1)).toMatchObject({ slot: 'extra', count: 0, closed: 'This design doesn’t show this slot, so nothing added to it would appear.' });
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
    const out = applyOperations(p.state(), moveOutOps(p.state(), p.owner, p.card, 'actions')).state;
    expect((home(out).nodes[stack as string] as ElementNode).children).toEqual([p.card, p.button, p.ends]);
  });

  it('Move out of a section on the page puts sections on the page as they are, and each run of anything else in a new Section', () => {
    const p = filled();
    const [{ nodeId: gallery }, { nodeId: last }] = p.run([
      { type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', index: 1, componentId: 'media.gallery' },
      { type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', primitive: 'paragraph', text: 'Last' }
    ]);
    const before = home(p.state()).rootIds;
    const out = applyOperations(p.state(), moveOutOps(p.state(), p.owner, p.section, 'content')).state;
    const roots = home(out).rootIds;
    const at = before.indexOf(p.section);
    expect(roots).toHaveLength(before.length + 3);
    expect(roots[at]).toBe(p.section);
    expect(p.slots(out, p.section)!.content).toEqual([]);
    expect(p.slots(out, roots[at + 1])!.content).toEqual([p.card]);
    expect(roots[at + 2]).toBe(gallery);
    expect(p.slots(out, roots[at + 3])!.content).toEqual([p.after, last]);
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
    expect(() => applyOperations(state, moveOutOps(state, p.owner, p.card, 'actions'))).toThrow(/The “Two” slot of “Pair” holds at most 2 items/);
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
    expect(layout().nodes[title]).toMatchObject({ text: { $entry: 'title' } });
  });

  it('is refused in the shared header and footer, where the editor could not take the moved content out again', () => {
    expect(moveOutRefusal({ kind: 'shell', id: 'footer' })).toBe('Content can’t be moved around in the shared footer. Clear removes it.');
    expect(moveOutRefusal({ kind: 'page', id: 'p' })).toBeNull();
    const p = filled();
    expect(moveOutOps(p.state(), { kind: 'shell', id: 'header' }, p.state().site.shell.header.rootIds[0], 'content')).toEqual([]);
  });
});
