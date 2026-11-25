import { describe, expect, it } from 'vitest';
import type { ElementNode, ElementRef, InstanceNode, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { insertOps } from '../../src/renderer/src/lib/insert-at';
import { addPoints, fitting, offeredAt, pointLabel, quickItems, resolvePoint } from '../../src/renderer/src/lib/inline-insert';

/**
 * The canvas's own Add buttons (#387): above and below a section of the page, and inside a container or a placed
 * component's slot, each inserting exactly there.
 */

const home = (s: ProjectState): PageDoc => s.pages[s.site.homePageId];
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });

/** Home: an Intro section, a Section holding a Row (with a Paragraph) and an empty Stack, and a closing Section; a
 *  card component made from a Stack inside the Row, and a band component made from the closing Section. */
function page() {
  let state = createStarterState('blank', 'Expo', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results.map((r) => r.nodeId as string);
  };
  const [intro, section, closing] = step([
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ]);
  const [row, empty] = step([
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'row' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }
  ]);
  const [para, cardStack] = step([
    { type: 'node.insert', owner, parentId: row, primitive: 'paragraph', text: 'Hall A' },
    { type: 'node.insert', owner, parentId: row, primitive: 'stack' }
  ]);
  step([
    { type: 'node.insert', owner, parentId: cardStack, primitive: 'heading', text: 'Exhibitor' },
    { type: 'node.insert', owner, parentId: closing, slot: 'content', primitive: 'heading', text: 'See you there' }
  ]);
  const made = applyOperations(state, [{ type: 'component.createFromNode', owner, nodeId: cardStack, name: 'Exhibitor card' }]);
  state = made.state;
  const band = applyOperations(state, [{ type: 'component.createFromNode', owner, nodeId: closing, name: 'Closing band' }]);
  state = band.state;
  return { state, owner, intro, section, closing: band.results[0].nodeId as string, row, empty, para, card: made.results[0].nodeId as string, cardDef: made.results[0].definitionId as string, bandDef: band.results[0].definitionId as string };
}

describe('Add buttons above and below a section of the page', () => {
  it('a selected section gets one above and one below it, each for a section at that index, and one inside it', () => {
    const p = page();
    const points = addPoints(p.state, p.owner, ref(p.owner, p.section));
    expect(points.map((x) => [x.side, x.role])).toEqual([
      ['before', 'section'],
      ['after', 'section'],
      ['inside', 'element']
    ]);
    expect(points.map((x) => resolvePoint(p.state, x))).toEqual([
      { owner: p.owner, parentId: null, index: 1 },
      { owner: p.owner, parentId: null, index: 2 },
      { owner: p.owner, parentId: p.section, slot: 'content' }
    ]);
    expect(points.map(pointLabel)).toEqual(['Add a section above Section', 'Add a section below Section', 'Add inside Section']);
  });

  it('below one section and above the next are the same place, by key', () => {
    const p = page();
    const below = addPoints(p.state, p.owner, ref(p.owner, p.intro)).find((x) => x.side === 'after')!;
    const above = addPoints(p.state, p.owner, ref(p.owner, p.section)).find((x) => x.side === 'before')!;
    expect(below.key).toBe(above.key);
    expect(resolvePoint(p.state, below)).toEqual(resolvePoint(p.state, above));
  });

  it('a section chosen there lands between the two sections, in one change', () => {
    const p = page();
    const below = addPoints(p.state, p.owner, ref(p.owner, p.intro)).find((x) => x.side === 'after')!;
    const ops = insertOps(resolvePoint(p.state, below)!, { componentId: 'layout.section' }, 'section');
    expect(ops).toHaveLength(1);
    const out = applyOperations(p.state, ops);
    expect(home(out.state).rootIds).toEqual([p.intro, out.results[0].nodeId, p.section, p.closing]);
  });

  it('is worked out again where the section is now: moved, it follows; gone, there is no place', () => {
    const p = page();
    const below = addPoints(p.state, p.owner, ref(p.owner, p.intro)).find((x) => x.side === 'after')!;
    const above = addPoints(p.state, p.owner, ref(p.owner, p.intro)).find((x) => x.side === 'before')!;
    const moved = applyOperations(p.state, [{ type: 'node.move', owner: p.owner, nodeId: p.intro, parentId: null, index: 2 }]).state;
    expect(home(moved).rootIds.indexOf(p.intro)).toBe(2);
    expect(resolvePoint(moved, below)).toEqual({ owner: p.owner, parentId: null, index: 3 });
    expect(resolvePoint(moved, above)).toEqual({ owner: p.owner, parentId: null, index: 2 });
    const gone = applyOperations(p.state, [{ type: 'node.remove', owner: p.owner, nodeId: p.intro }]).state;
    expect(resolvePoint(gone, below)).toBeNull();
    // Moved inside another section, it is no longer one of the page's sections.
    const nested = applyOperations(p.state, [{ type: 'node.move', owner: p.owner, nodeId: p.intro, parentId: p.section, slot: 'content', index: 0 }]).state;
    expect(resolvePoint(nested, below)).toBeNull();
  });

  it('a placed section component gets the same, and an element inside a section gets no section buttons', () => {
    const p = page();
    expect(addPoints(p.state, p.owner, ref(p.owner, p.closing)).filter((x) => x.role === 'section').map((x) => resolvePoint(p.state, x)?.index)).toEqual([2, 3]);
    expect(addPoints(p.state, p.owner, ref(p.owner, p.para))).toEqual([]);
  });
});

describe('Add buttons inside a container or a slot', () => {
  it('a selected Row takes an element at its end; a Paragraph in it takes nothing', () => {
    const p = page();
    const points = addPoints(p.state, p.owner, ref(p.owner, p.row));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ side: 'inside', role: 'element', nodeId: p.row, name: 'Row' });
    expect(resolvePoint(p.state, points[0])).toEqual({ owner: p.owner, parentId: p.row });
    const out = applyOperations(p.state, insertOps(resolvePoint(p.state, points[0])!, { primitive: 'button' }, 'element'));
    const row = home(out.state).nodes[p.row];
    expect(row.kind === 'element' && row.children.at(-1)).toBe(out.results[0].nodeId);
  });

  it('a part of a placed section that holds its slot takes an element in that slot (#185); another part, nothing', () => {
    const p = page();
    const def = p.state.components[(home(p.state).nodes[p.intro] as InstanceNode).definitionId];
    const container: ElementRef = { owner: p.owner, instancePath: [p.intro], nodeId: def.parts.container.nodeId, partId: 'container' };
    const points = addPoints(p.state, p.owner, container);
    expect(points.map((x) => x.side)).toEqual(['inside']);
    expect(resolvePoint(p.state, points[0])).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
    // The section's own root part, or a part of a component placed in its design, would put it somewhere else.
    expect(addPoints(p.state, p.owner, { owner: p.owner, instancePath: [p.intro], nodeId: def.tree!.rootIds[0] })).toEqual([]);
    expect(addPoints(p.state, p.owner, { owner: p.owner, instancePath: [p.intro, 'nested'], nodeId: 'deep' })).toEqual([]);
  });

  it('hovered, only an empty container or slot gets one, and a hovered section keeps its section buttons', () => {
    const p = page();
    expect(addPoints(p.state, p.owner, ref(p.owner, p.row), true)).toEqual([]);
    expect(addPoints(p.state, p.owner, ref(p.owner, p.empty), true).map((x) => x.side)).toEqual(['inside']);
    expect(addPoints(p.state, p.owner, ref(p.owner, p.section), true).map((x) => x.side)).toEqual(['before', 'after']);
    const bare = applyOperations(p.state, [{ type: 'node.insert', owner: p.owner, parentId: null, componentId: 'layout.section' }]);
    expect(addPoints(bare.state, p.owner, ref(p.owner, bare.results[0].nodeId as string), true).map((x) => x.side)).toEqual(['before', 'after', 'inside']);
  });

  it('a container that is gone, or a slot the component no longer declares, has no place', () => {
    const p = page();
    const [inside] = addPoints(p.state, p.owner, ref(p.owner, p.row));
    expect(resolvePoint(applyOperations(p.state, [{ type: 'node.remove', owner: p.owner, nodeId: p.row }]).state, inside)).toBeNull();
    const [, , slot] = addPoints(p.state, p.owner, ref(p.owner, p.section));
    expect(resolvePoint(p.state, slot)).toEqual({ owner: p.owner, parentId: p.section, slot: 'content' });
    const defId = (home(p.state).nodes[p.section] as InstanceNode).definitionId;
    expect(resolvePoint({ ...p.state, components: { ...p.state.components, [defId]: { ...p.state.components[defId], slots: {} } } }, slot)).toBeNull();
    // Another slot declared in its place is not that one.
    expect(resolvePoint({ ...p.state, components: { ...p.state.components, [defId]: { ...p.state.components[defId], slots: { body: { label: 'Body' } } } } }, slot)).toBeNull();
  });
});

describe('an Add button goes only where the slot it fills is plain', () => {
  /** The card gets two slots, Body and Aside, both shown in one Wrap, and a Media slot shown in a box of its own. */
  function twoSlots() {
    const p = page();
    const def = p.state.components[p.cardDef];
    const root = def.tree!.rootIds[0];
    def.slots = { body: { label: 'Body' }, aside: { label: 'Aside' }, media: { label: 'Media' } };
    def.tree!.nodes.bodySlot = { id: 'bodySlot', kind: 'slot', slot: 'body' };
    def.tree!.nodes.asideSlot = { id: 'asideSlot', kind: 'slot', slot: 'aside' };
    def.tree!.nodes.mediaSlot = { id: 'mediaSlot', kind: 'slot', slot: 'media' };
    def.tree!.nodes.wrap = { id: 'wrap', kind: 'element', tag: 'div', children: ['bodySlot', 'asideSlot'] };
    def.tree!.nodes.mediaBox = { id: 'mediaBox', kind: 'element', tag: 'div', children: ['mediaSlot'] };
    (def.tree!.nodes[root] as ElementNode).children.push('wrap', 'mediaBox');
    return p;
  }
  const partOf = (owner: OwnerRef, placement: string, nodeId: string): ElementRef => ({ owner, instancePath: [placement], nodeId });

  it('a part holding two slots gets none, a placement showing several gets one on each empty slot (#657); a part holding one gets that one', () => {
    const p = twoSlots();
    expect(addPoints(p.state, p.owner, partOf(p.owner, p.card, 'wrap'))).toEqual([]);
    expect(addPoints(p.state, p.owner, partOf(p.owner, p.card, 'wrap'), true)).toEqual([]);
    // Each drawn on its own slot's box, never all on the placement's.
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card)).map((x) => [x.slot, x.onSlot])).toEqual([
      ['body', true],
      ['aside', true],
      ['media', true]
    ]);
    // Hovered, the placement has no slot boxes measured for it: the pointer over an empty slot hovers that slot instead.
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card), true)).toEqual([]);
    const [media] = addPoints(p.state, p.owner, partOf(p.owner, p.card, 'mediaBox'));
    expect(resolvePoint(p.state, media)).toEqual({ owner: p.owner, parentId: p.card, slot: 'media' });
    const out = applyOperations(p.state, insertOps(resolvePoint(p.state, media)!, { primitive: 'button' }, 'element'));
    expect((home(out.state).nodes[p.card] as InstanceNode).slots?.media).toEqual([out.results[0].nodeId]);
  });

  it('a placement whose one declared slot its design leaves out gets none', () => {
    const p = page();
    const def = p.state.components[p.cardDef];
    def.slots = { hidden: { label: 'Hidden' } };
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
  });

  it('a placement whose one slot shows once per item of a list gets none: it would show many times, or never', () => {
    const p = page();
    const def = p.state.components[p.cardDef];
    const root = def.tree!.rootIds[0];
    def.slots = { extra: { label: 'Extra' } };
    def.tree!.nodes.extraSlot = { id: 'extraSlot', kind: 'slot', slot: 'extra' };
    def.tree!.nodes.rows = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: ['extraSlot'] };
    (def.tree!.nodes[root] as ElementNode).children.push('rows');
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
    // Shown once outside the list as well, it still shows many times.
    def.tree!.nodes.extraOnce = { id: 'extraOnce', kind: 'slot', slot: 'extra' };
    def.tree!.nodes.extraBox = { id: 'extraBox', kind: 'element', tag: 'div', children: ['extraOnce'] };
    (def.tree!.nodes[root] as ElementNode).children.push('extraBox');
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
    // Taken out of the list, it shows once.
    def.tree!.nodes.rows = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: [] };
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card)).map((x) => [x.side, x.slot])).toEqual([['inside', 'extra']]);
  });

  it('a placement whose one slot is handed to a Section in its design takes it there; shown twice, none', () => {
    const p = page();
    const def = p.state.components[p.cardDef];
    const root = def.tree!.rootIds[0];
    const sectionDef = (home(p.state).nodes[p.section] as InstanceNode).definitionId;
    def.slots = { body: { label: 'Body' } };
    def.tree!.nodes.bodySlot = { id: 'bodySlot', kind: 'slot', slot: 'body' };
    def.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: sectionDef, props: {}, slots: { content: ['bodySlot'] } };
    (def.tree!.nodes[root] as ElementNode).children.push('inner');
    const [inside] = addPoints(p.state, p.owner, ref(p.owner, p.card));
    expect(resolvePoint(p.state, inside)).toEqual({ owner: p.owner, parentId: p.card, slot: 'body' });
    // Handed to a slot the Section does not have, it shows nowhere.
    def.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: sectionDef, props: {}, slots: { aside: ['bodySlot'] } };
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
    // Nor when the Section has stopped declaring the slot it still has an outlet for.
    def.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: sectionDef, props: {}, slots: { content: ['bodySlot'] } };
    const declared = p.state.components[sectionDef].slots;
    p.state.components[sectionDef].slots = {};
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
    p.state.components[sectionDef].slots = declared;
    // Shown from two places, it would show twice.
    def.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: sectionDef, props: {}, slots: { content: ['bodySlot'] } };
    def.tree!.nodes.bodySlot2 = { id: 'bodySlot2', kind: 'slot', slot: 'body' };
    (def.tree!.nodes[root] as ElementNode).children.push('bodySlot2');
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
    (def.tree!.nodes[root] as ElementNode).children.pop();
    // Handed to a component that shows that slot in a list, it shows many times.
    const listing = structuredClone(p.state.components[sectionDef]);
    listing.id = 'listing';
    const [lRoot] = listing.tree!.rootIds;
    const contentSlot = Object.values(listing.tree!.nodes).find((n) => n.kind === 'slot' && n.slot === 'content')!;
    listing.tree!.nodes.lRows = { id: 'lRows', kind: 'repeat', list: { $prop: 'rows' }, children: [contentSlot.id] };
    for (const n of Object.values(listing.tree!.nodes)) if (n.kind === 'element') n.children = n.children.filter((c) => c !== contentSlot.id);
    (listing.tree!.nodes[lRoot] as ElementNode).children.push('lRows');
    p.state.components.listing = listing;
    def.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: 'listing', props: {}, slots: { content: ['bodySlot'] } };
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
    // Handed to a code component, how often it shows is up to its code.
    p.state.components.coded = { ...structuredClone(p.state.components[sectionDef]), id: 'coded', kind: 'code', tree: undefined, source: '<section>{@render content?.()}</section>' };
    def.tree!.nodes.inner = { id: 'inner', kind: 'instance', definitionId: 'coded', props: {}, slots: { content: ['bodySlot'] } };
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card))).toEqual([]);
  });

  it('a code component placed on the page gets none inside: its code decides how often a slot shows', () => {
    const p = page();
    const sectionDef = (home(p.state).nodes[p.section] as InstanceNode).definitionId;
    p.state.components[sectionDef] = { ...p.state.components[sectionDef], kind: 'code', tree: undefined, source: '<section>{@render content?.()}</section>' };
    expect(addPoints(p.state, p.owner, ref(p.owner, p.section)).map((x) => x.side)).toEqual(['before', 'after']);
  });

  it('works out a design that places another twice, which places another twice, without going round each again', () => {
    const p = page();
    const sectionDef = (home(p.state).nodes[p.section] as InstanceNode).definitionId;
    // Forty levels, each placing the next twice and handing it its one slot once: what goes in the outermost shows
    // through each level once, and asking takes no time (each level asked about once, not 2^40 times).
    let below = sectionDef;
    for (let i = 0; i < 40; i++) {
      const id = `level${i}`;
      p.state.components[id] = {
        ...structuredClone(p.state.components[p.cardDef]),
        id,
        insertAs: 'element',
        slots: { body: { label: 'Body' } },
        tree: {
          rootIds: ['r'],
          nodes: {
            r: { id: 'r', kind: 'element', tag: 'div', children: ['a', 'b'] },
            a: { id: 'a', kind: 'instance', definitionId: below, props: {}, slots: { [i ? 'body' : 'content']: ['s'] } },
            // Filled too, with something of its own, so each level asks about the one below twice.
            b: { id: 'b', kind: 'instance', definitionId: below, props: {}, slots: { [i ? 'body' : 'content']: ['u'] } },
            s: { id: 's', kind: 'slot', slot: 'body' },
            u: { id: 'u', kind: 'element', tag: 'div', children: [] }
          }
        }
      };
      below = id;
    }
    (home(p.state).nodes[p.card] as InstanceNode).definitionId = below;
    const started = performance.now();
    expect(addPoints(p.state, p.owner, ref(p.owner, p.card)).map((x) => [x.side, x.slot])).toEqual([['inside', 'body']]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('a repeated item’s copy gets none: the place would be every item’s', () => {
    const p = page();
    expect(addPoints(p.state, p.owner, { ...ref(p.owner, p.row), itemPath: ['a'] })).toEqual([]);
  });
});

describe('Add buttons inside the slots of a component that shows several (#657)', () => {
  /** Home: a Section holding a Split that shows Main (anything) and Sidebar (text only) side by side, both empty. */
  function split() {
    let state = createStarterState('blank', 'Expo', false);
    const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const step = (ops: EditOperation[]) => {
      const out = applyOperations(state, ops);
      state = out.state;
      return out.results;
    };
    const [{ nodeId: section }] = step([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
    const [{ definitionId }] = step([
      {
        type: 'component.upsert',
        name: 'Split',
        insertAs: 'element',
        properties: {},
        nodes: [
          { kind: 'element', id: 'root', children: ['mainCol', 'sideCol'], styles: { base: { layout: 'grid', columns: 2 } } },
          { kind: 'element', id: 'mainCol', children: ['main'] },
          { kind: 'slot', id: 'main', slot: 'main' },
          { kind: 'element', id: 'sideCol', children: ['side'] },
          { kind: 'slot', id: 'side', slot: 'sidebar' }
        ],
        slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar', primitives: ['text'] } }
      }
    ]);
    const [{ nodeId: placed }] = step([{ type: 'node.insert', owner, parentId: section as string, slot: 'content', definitionId: definitionId as string }]);
    const id = placed as string;
    return { state: () => state, step, owner, section: section as string, definitionId: definitionId as string, id, placement: ref(owner, id), slot: (name: string): ElementRef => ({ ...ref(owner, id), slot: name }) };
  }
  const slotList = (s: ProjectState, id: string, slot: string) => (home(s).nodes[id] as InstanceNode).slots?.[slot] ?? [];

  it('a selected Split gets one in Main and one in Sidebar, each on its own slot’s box and named by it', () => {
    const p = split();
    const points = addPoints(p.state(), p.owner, p.placement);
    expect(points.map((x) => [x.side, x.slot, x.onSlot])).toEqual([
      ['inside', 'main', true],
      ['inside', 'sidebar', true]
    ]);
    expect(new Set(points.map((x) => x.key)).size).toBe(2);
    expect(points.map(pointLabel)).toEqual(['Add inside Main in Split', 'Add inside Sidebar in Split']);
    expect(points.map((x) => resolvePoint(p.state(), x))).toEqual([
      { owner: p.owner, parentId: p.id, slot: 'main' },
      { owner: p.owner, parentId: p.id, slot: 'sidebar' }
    ]);
  });

  for (const [slot, other] of [
    ['main', 'sidebar'],
    ['sidebar', 'main']
  ] as const)
    it(`what is chosen from ${slot}’s button goes into ${slot} alone, in one change`, () => {
      const p = split();
      const point = addPoints(p.state(), p.owner, p.placement).find((x) => x.slot === slot)!;
      const at = resolvePoint(p.state(), point)!;
      const paragraph = offeredAt(p.state(), at, 'element').find((it) => it.name === 'Paragraph')!;
      const out = applyOperations(p.state(), insertOps(at, paragraph.spec, 'element'));
      expect(slotList(out.state, p.id, slot)).toEqual([out.results[0].nodeId]);
      expect(slotList(out.state, p.id, other)).toEqual([]);
    });

  it('each slot’s list offers what that slot’s contract takes', () => {
    const p = split();
    const [main, sidebar] = addPoints(p.state(), p.owner, p.placement).map((x) => offeredAt(p.state(), resolvePoint(p.state(), x)!, 'element').map((it) => it.name));
    expect(main).toEqual(expect.arrayContaining(['Paragraph', 'Image']));
    expect(sidebar).toContain('Paragraph');
    expect(sidebar).not.toContain('Image');
  });

  it('a filled slot loses its button, and the empty one keeps its own on its own box', () => {
    const p = split();
    p.step([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot: 'sidebar', primitive: 'paragraph', text: 'Open daily' }]);
    expect(addPoints(p.state(), p.owner, p.placement).map((x) => [x.slot, x.onSlot])).toEqual([['main', true]]);
    p.step([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot: 'main', primitive: 'paragraph', text: 'Menu' }]);
    expect(addPoints(p.state(), p.owner, p.placement)).toEqual([]);
  });

  it('a slot picked by its empty box gets one in it, selected or hovered, the same place as its placement’s', () => {
    const p = split();
    const fromPlacement = addPoints(p.state(), p.owner, p.placement);
    for (const [i, name] of ['main', 'sidebar'].entries()) {
      const [own, ...rest] = addPoints(p.state(), p.owner, p.slot(name));
      expect(rest).toEqual([]);
      expect(own).toMatchObject({ key: fromPlacement[i].key, side: 'inside', slot: name, nodeId: p.id, name: fromPlacement[i].name });
      expect(own.onSlot).toBeUndefined();
      expect(addPoints(p.state(), p.owner, p.slot(name), true)).toEqual([own]);
    }
    // Hovered once filled, it has none, as a filled container has none.
    p.step([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot: 'sidebar', primitive: 'paragraph', text: 'Open daily' }]);
    expect(addPoints(p.state(), p.owner, p.slot('sidebar'), true)).toEqual([]);
  });

  it('a single slot keeps its button where it was: on its placement, named by it', () => {
    const p = split();
    const sectionPoints = addPoints(p.state(), p.owner, ref(p.owner, p.section));
    expect(sectionPoints.map((x) => [x.side, x.slot, x.onSlot])).toEqual([
      ['before', undefined, undefined],
      ['after', undefined, undefined],
      ['inside', 'content', undefined]
    ]);
    // Its slot picked by its empty box is the same place, by the Section's name.
    const empty = applyOperations(p.state(), [{ type: 'node.remove', owner: p.owner, nodeId: p.id }]).state;
    const [inside] = addPoints(empty, p.owner, { ...ref(p.owner, p.section), slot: 'content' });
    expect(inside).toMatchObject({ key: sectionPoints[2].key, side: 'inside', slot: 'content', name: 'Section' });
  });

  it('none for a slot that is closed, shown in a list, gone, on a repeated item, or in the shared header', () => {
    const p = split();
    const def = p.state().components[p.definitionId];
    // Closed to content: no box to draw one on.
    def.slots!.sidebar = { ...def.slots!.sidebar, max: 0 };
    expect(addPoints(p.state(), p.owner, p.placement).map((x) => x.slot)).toEqual(['main']);
    def.slots!.sidebar = { label: 'Sidebar' };
    // Shown once per item of a list, it would show many times, or never.
    def.tree!.nodes.rows = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: ['side'] };
    (def.tree!.nodes.sideCol as ElementNode).children = ['rows'];
    // Main alone shows once: its button is the placement's own, as for any component showing one slot.
    expect(addPoints(p.state(), p.owner, p.placement).map((x) => [x.side, x.slot, x.onSlot])).toEqual([['inside', 'main', undefined]]);
    expect(addPoints(p.state(), p.owner, p.slot('sidebar'))).toEqual([]);
    expect(addPoints(p.state(), p.owner, p.slot('main')).map((x) => x.slot)).toEqual(['main']);
    // A slot its component no longer declares.
    expect(addPoints(p.state(), p.owner, p.slot('footer'))).toEqual([]);
    expect(addPoints(p.state(), p.owner, { ...p.slot('main'), itemPath: ['a'] })).toEqual([]);
    const header: OwnerRef = { kind: 'shell', id: 'header' };
    expect(addPoints(p.state(), p.owner, { ...p.slot('main'), owner: header })).toEqual([]);
  });
});

describe('where the canvas offers no Add buttons', () => {
  it('nothing selected, the shared header, another page, or a component being edited', () => {
    const p = page();
    expect(addPoints(p.state, p.owner, null)).toEqual([]);
    const header: OwnerRef = { kind: 'shell', id: 'header' };
    const shellRoot = p.state.site.shell.header.rootIds[0];
    expect(addPoints(p.state, header, ref(header, shellRoot))).toEqual([]);
    expect(addPoints(p.state, p.owner, ref(header, shellRoot))).toEqual([]);
    expect(addPoints(p.state, { kind: 'page', id: 'elsewhere' }, ref(p.owner, p.section))).toEqual([]);
    // A selection on Home, with another page (holding the same nodes) on the canvas.
    const other: OwnerRef = { kind: 'page', id: 'other' };
    const twin: ProjectState = { ...p.state, pages: { ...p.state.pages, other: { ...home(p.state), id: 'other' } } };
    expect(addPoints(twin, other, ref(other, p.section)).length).toBe(3);
    expect(addPoints(twin, other, ref(p.owner, p.section))).toEqual([]);
    const comp: OwnerRef = { kind: 'component', id: p.cardDef };
    expect(addPoints(p.state, comp, ref(comp, p.state.components[p.cardDef].tree!.rootIds[0]))).toEqual([]);
  });
});

describe('what each Add button offers', () => {
  it('between sections: the theme’s sections, then the project’s section components', () => {
    const p = page();
    const items = quickItems(p.state, 'section');
    expect(items.some((it) => it.kind === 'section' && it.spec.componentId === 'layout.section')).toBe(true);
    expect(items.filter((it) => it.kind === 'component').map((it) => it.spec.definitionId)).toEqual([p.bandDef]);
    expect(items.some((it) => it.kind === 'element')).toBe(false);
    expect(items.findIndex((it) => it.kind === 'component')).toBeGreaterThan(items.findLastIndex((it) => it.kind === 'section'));
  });

  it('inside a container: the basic elements, the theme’s blocks, then the project’s inner components', () => {
    const p = page();
    const items = quickItems(p.state, 'element');
    expect(items.find((it) => it.name === 'Button')?.spec).toEqual({ primitive: 'button' });
    expect(items.filter((it) => it.kind === 'component').map((it) => it.spec.definitionId)).toEqual([p.cardDef]);
    expect(items.some((it) => it.kind === 'section')).toBe(false);
    // The blocks (#664), in a group of their own between the basic elements and the project's components.
    const blocks = items.filter((it) => it.kind === 'block');
    expect(blocks.map((it) => it.spec.componentId)).toEqual(['block.feature', 'block.stat', 'block.testimonial', 'block.callout', 'block.signup', 'block.video']);
    expect(new Set(blocks.map((it) => it.group))).toEqual(new Set(['Blocks']));
    expect(items.findIndex((it) => it.kind === 'block')).toBeGreaterThan(items.findLastIndex((it) => it.kind === 'element'));
    expect(items.findIndex((it) => it.kind === 'component')).toBeGreaterThan(items.findLastIndex((it) => it.kind === 'block'));
    // Between sections they are not offered: they go inside one.
    expect(quickItems(p.state, 'section').some((it) => it.kind === 'block' || it.spec.componentId?.startsWith('block.'))).toBe(false);
  });

  it('inside an empty Stack in a Section, every block fits and inserts there in one change (#664)', () => {
    const p = page();
    const [inside] = addPoints(p.state, p.owner, ref(p.owner, p.empty));
    const at = resolvePoint(p.state, inside)!;
    const offered = offeredAt(p.state, at, 'element').filter((it) => it.kind === 'block');
    expect(offered).toHaveLength(6);
    for (const it of offered) {
      const { state } = applyOperations(p.state, insertOps(at, it.spec, 'element', 'n_block'));
      expect((home(state).nodes[p.empty] as ElementNode).children).toEqual(['n_block']);
      expect(home(state).rootIds).toEqual(home(p.state).rootIds);
    }
  });

  it('leaves out what the place would refuse: a Button inside a card that links somewhere', () => {
    const p = page();
    (home(p.state).nodes[p.row] as ElementNode).link = { type: 'url', target: 'https://example.com' };
    const [inside] = addPoints(p.state, p.owner, ref(p.owner, p.row));
    const items = fitting(p.state, resolvePoint(p.state, inside)!, 'element', quickItems(p.state, 'element'));
    expect(items.some((it) => it.name === 'Button')).toBe(false);
    expect(items.some((it) => it.name === 'Paragraph')).toBe(true);
    // Unlinked, it takes a Button again.
    delete (home(p.state).nodes[p.row] as ElementNode).link;
    expect(fitting(p.state, resolvePoint(p.state, inside)!, 'element', quickItems(p.state, 'element')).some((it) => it.name === 'Button')).toBe(true);
  });

  it('between sections, leaves out a section component that cannot stand at the page’s top level, and keeps the theme’s', () => {
    const p = page();
    const def = p.state.components[p.cardDef];
    // A component made to go in as a section whose design is a list item: a page's top level can't hold one.
    def.insertAs = 'section';
    (def.tree!.nodes[def.tree!.rootIds[0]] as ElementNode).tag = 'li';
    const [above] = addPoints(p.state, p.owner, ref(p.owner, p.intro));
    const at = resolvePoint(p.state, above)!;
    const all = quickItems(p.state, 'section');
    expect(all.some((it) => it.spec.definitionId === p.cardDef)).toBe(true);
    const offered = offeredAt(p.state, at, 'section');
    expect(offered.some((it) => it.spec.definitionId === p.cardDef)).toBe(false);
    expect(offered.filter((it) => it.kind === 'section')).toEqual(all.filter((it) => it.kind === 'section'));
    expect(offered.some((it) => it.spec.definitionId === p.bandDef)).toBe(true);
    // Inside a container, every item is tried.
    const [inside] = addPoints(p.state, p.owner, ref(p.owner, p.row));
    expect(offeredAt(p.state, resolvePoint(p.state, inside)!, 'element').map((it) => it.key)).toEqual(fitting(p.state, resolvePoint(p.state, inside)!, 'element', quickItems(p.state, 'element')).map((it) => it.key));
  });

  it('leaves out the shared header and footer, and code components outside Developer mode', () => {
    const p = page();
    const code = { ...p.state.components[p.cardDef], id: 'code-card', name: 'Code card', kind: 'code' as const, tree: undefined, source: '<div></div>' };
    const state: ProjectState = { ...p.state, components: { ...p.state.components, [code.id]: code } };
    expect(quickItems(state, 'element').some((it) => it.spec.definitionId === code.id)).toBe(false);
    expect(quickItems(state, 'element', true).some((it) => it.spec.definitionId === code.id)).toBe(true);
    expect(quickItems(state, 'section').some((it) => state.components[it.spec.definitionId ?? '']?.category === 'shell')).toBe(false);
  });
});
