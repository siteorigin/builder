import { describe, expect, it } from 'vitest';
import type { ElementNode, ElementRef, InstanceNode, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { inferredRole, placementRole } from '@engine/insert-role';
import { findParent } from '@engine/tree';
import { quickItems } from '../../src/renderer/src/lib/inline-insert';
import { definitionRole, elementWhere, heldSlot, insertAt, insertOps, insertRole, insertSelection, nodeBefore, nodeLabel, placeFor, placementOf, sectionWhere, whereFor, type InsertAt } from '../../src/renderer/src/lib/insert-at';

/**
 * Where Insert puts a project component (#52): a card made inside a grid goes beside the selected card in that grid,
 * like the element it was made from, and a component made from a whole section still goes beside the page's sections.
 */

const home = (s: ProjectState): PageDoc => s.pages[s.site.homePageId];
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });

function apply(state: ProjectState, ops: EditOperation[]) {
  return applyOperations(state, ops);
}

/** The issue's page: Intro section, then a Section holding an Exhibitors grid with one Exhibitor card made from a stack
 *  holding a paragraph, then a closing Section made into a "Closing band" component. */
function exhibitors() {
  let state = createStarterState('blank', 'Expo', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const out = apply(state, ops);
    state = out.state;
    return out.results;
  };
  const [intro, section, closing] = step([
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ]).map((r) => r.nodeId as string);
  const [grid] = step([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'grid' }]).map((r) => r.nodeId as string);
  const [stack] = step([{ type: 'node.insert', owner, parentId: grid, primitive: 'stack' }]).map((r) => r.nodeId as string);
  step([
    { type: 'node.insert', owner, parentId: stack, primitive: 'paragraph', text: 'Hall A, stand 12' },
    { type: 'node.insert', owner, parentId: closing, slot: 'content', primitive: 'heading', text: 'See you there' }
  ]);
  const [made] = step([{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Exhibitor card' }]);
  const [band] = step([{ type: 'component.createFromNode', owner, nodeId: closing, name: 'Closing band' }]);
  return { state, owner, intro, section, grid, card: made.nodeId as string, cardDef: made.definitionId as string, band: band.nodeId as string, bandDef: band.definitionId as string };
}

describe('Create component records where its source sat (#52)', () => {
  it('a node from inside a layout inserts as an element; a section of the page as a section', () => {
    const p = exhibitors();
    expect(p.state.components[p.cardDef].insertAs).toBe('element');
    expect(p.state.components[p.bandDef].insertAs).toBe('section');
    expect(insertRole(p.state, { definitionId: p.cardDef })).toBe('element');
    expect(insertRole(p.state, { definitionId: p.bandDef })).toBe('section');
    // Basic elements and the theme's sections keep their own ways.
    expect(insertRole(p.state, { primitive: 'paragraph' })).toBe('element');
    expect(insertRole(p.state, { componentId: 'layout.section' })).toBe('section');
  });

  it('reads it from the design for a component made before it was recorded, and copies carry it on', () => {
    const p = exhibitors();
    delete p.state.components[p.cardDef].insertAs;
    delete p.state.components[p.bandDef].insertAs;
    // A card's root is a stack; a section made into a component is rooted in the Section it was.
    expect(definitionRole(p.state, p.cardDef)).toBe('element');
    expect(definitionRole(p.state, p.bandDef)).toBe('section');
    const copied = apply(p.state, [{ type: 'component.makeUnique', owner: p.owner, nodeId: p.card, name: 'Sponsor card' }]);
    const copyId = copied.results[0].definitionId as string;
    expect(copied.state.components[copyId].provenance?.forkedFrom).toBe(p.cardDef);
    expect(definitionRole(copied.state, copyId)).toBe('element');
    // A theme's own component, and a project copy of one, are sections.
    const theme = Object.values(p.state.components).find((d) => d.owner === 'theme' && d.category !== 'shell')!;
    expect(definitionRole(p.state, theme.id)).toBe('section');
  });

  it('keeps an unknown or self-referencing definition a section, without looping', () => {
    const p = exhibitors();
    const def = p.state.components[p.bandDef];
    delete def.insertAs;
    def.provenance = { ...def.provenance, forkedFrom: def.id };
    expect(definitionRole(p.state, def.id)).toBe('section');
    expect(definitionRole(p.state, 'missing')).toBe('section');
    // Two unplaced copies made from each other.
    const a = structuredClone(p.state.components[p.cardDef]);
    const b = structuredClone(a);
    for (const [d, id, from] of [[a, 'proj.a', 'proj.b'], [b, 'proj.b', 'proj.a']] as const) {
      Object.assign(d, { id, insertAs: undefined, provenance: { forkedFrom: from } });
      d.tree!.nodes[d.tree!.rootIds[0]] = { ...(d.tree!.nodes[d.tree!.rootIds[0]] as ElementNode), tag: 'section' };
      p.state.components[id] = d;
    }
    expect(definitionRole(p.state, 'proj.a')).toBe('section');
  });

  it('a component made from a filled Section inside the grid is an element, and so is a copy of the card', () => {
    const p = exhibitors();
    const nested = apply(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.grid, componentId: 'layout.section' }]);
    const inner = nested.results[0].nodeId as string;
    const filled = apply(nested.state, [{ type: 'node.insert', owner: p.owner, parentId: inner, slot: 'content', primitive: 'heading', text: 'Hall B' }]);
    const made = apply(filled.state, [{ type: 'component.createFromNode', owner: p.owner, nodeId: inner, name: 'Hall band' }]);
    expect(made.state.components[made.results[0].definitionId as string].insertAs).toBe('element');
    const copy = apply(p.state, [{ type: 'component.makeUnique', owner: p.owner, nodeId: p.card, name: 'Sponsor card' }]);
    expect(copy.state.components[copy.results[0].definitionId as string].insertAs).toBe('element');
  });

  it('an older card rooted in a section element goes where it is placed, and by its design when placed nowhere', () => {
    const p = exhibitors();
    const def = p.state.components[p.cardDef];
    delete def.insertAs;
    (def.tree!.nodes[def.tree!.rootIds[0]] as ElementNode).tag = 'section';
    // Its one placement is in the grid: an element, whatever its tag.
    expect(definitionRole(p.state, p.cardDef)).toBe('element');
    // Placed nowhere: its root says section.
    const page = home(p.state);
    (page.nodes[p.grid] as ElementNode).children = [];
    delete page.nodes[p.card];
    expect(definitionRole(p.state, p.cardDef)).toBe('section');
  });

  it('an older card placed only among the page’s sections (as Insert used to put it) is still read from its design', () => {
    const p = exhibitors();
    delete p.state.components[p.cardDef].insertAs;
    const out = apply(p.state, [{ type: 'node.insert', owner: p.owner, parentId: null, definitionId: p.cardDef }]);
    const page = home(out.state);
    (page.nodes[p.grid] as ElementNode).children = [];
    delete page.nodes[p.card];
    // Its root is a stack: an element, wherever its copies ended up.
    expect(definitionRole(out.state, p.cardDef)).toBe('element');
  });
});

describe('a reusable card inserts inside the selected layout (#52)', () => {
  it('goes beside the selected card in its grid, not after the section, and names the grid', () => {
    const p = exhibitors();
    const role = insertRole(p.state, { definitionId: p.cardDef });
    const at = placeFor(p.state, p.owner, role, ref(p.owner, p.card), p.cardDef)!;
    expect(at).toEqual({ owner: p.owner, parentId: p.grid, slot: undefined, index: 1 });
    const where = whereFor(p.state, at, role)!;
    expect(where.lead).toBe('after');
    expect(where.target).toBe('Exhibitor card');
    expect(where.within).toBe(p.state.pages[p.owner.id].nodes[p.grid].name ?? 'Grid');

    const roots = [...home(p.state).rootIds];
    const out = apply(p.state, insertOps(at, { definitionId: p.cardDef }, role));
    const grid = home(out.state).nodes[p.grid];
    expect(grid.kind === 'element' && grid.children).toHaveLength(2);
    const second = out.results.at(-1)!.nodeId as string;
    expect(grid.kind === 'element' && grid.children[1]).toBe(second);
    expect((home(out.state).nodes[second] as InstanceNode).definitionId).toBe(p.cardDef);
    // The page's sections are as they were: nothing new at the top level.
    expect(home(out.state).rootIds).toEqual(roots);
  });

  it('asks for a sibling of a selected card that takes content, and goes inside one of another kind', () => {
    const p = exhibitors();
    // The card gets a slot its design shows.
    const def = p.state.components[p.cardDef];
    def.slots = { extra: { label: 'Extra' } };
    def.tree!.nodes.slotNode = { id: 'slotNode', kind: 'slot', slot: 'extra' };
    (def.tree!.nodes[def.tree!.rootIds[0]] as ElementNode).children.push('slotNode');
    expect(placeFor(p.state, p.owner, 'element', ref(p.owner, p.card), p.cardDef)).toEqual({ owner: p.owner, parentId: p.grid, slot: undefined, index: 1 });
    // A basic element (or another component) goes into the card's slot.
    expect(placeFor(p.state, p.owner, 'element', ref(p.owner, p.card))).toEqual({ owner: p.owner, parentId: p.card, slot: 'extra' });
  });

  it('goes at the end of a selected grid, and into the last section with nothing selected', () => {
    const p = exhibitors();
    expect(placeFor(p.state, p.owner, 'element', ref(p.owner, p.grid), p.cardDef)).toEqual({ owner: p.owner, parentId: p.grid });
    // Nothing selected: the last section that holds content (the closing band is a component with no slot).
    expect(placeFor(p.state, p.owner, 'element', null, p.cardDef)).toEqual({ owner: p.owner, parentId: p.section, slot: 'content' });
    // A selected section takes it inside, at the end of its content.
    expect(placeFor(p.state, p.owner, 'element', ref(p.owner, p.intro), p.cardDef)).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
  });

  it('beside a section that takes no content, it goes into a new section after it, in one change', () => {
    const p = exhibitors();
    const at = placeFor(p.state, p.owner, 'element', ref(p.owner, p.band), p.cardDef)!;
    expect(at).toEqual({ owner: p.owner, parentId: null, slot: undefined, index: 3 });
    expect(elementWhere(p.state, at)).toMatchObject({ lead: 'in a new section after', target: 'Closing band' });
    const ops = insertOps(at, { definitionId: p.cardDef }, 'element');
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: 'node.insert', parentId: null, index: 3, componentId: 'layout.section' });
    expect(ops[1]).toMatchObject({ type: 'node.insert', slot: 'content', definitionId: p.cardDef });
    const out = apply(p.state, ops);
    expect(home(out.state).rootIds).toHaveLength(4);
    // At the top of the page too.
    const top = apply(p.state, insertOps({ owner: p.owner, parentId: null, index: 0 }, { definitionId: p.cardDef }, 'element'));
    const wrapper = home(top.state).nodes[home(top.state).rootIds[0]] as InstanceNode;
    expect(wrapper.definitionId).toBe('foundation.layout.section');
    expect(wrapper.slots?.content).toEqual([top.results.at(-1)!.nodeId]);
  });
});

describe('a full-page section component still inserts beside the page’s sections (#52)', () => {
  it('goes after the top-level section holding a nested selection', () => {
    const p = exhibitors();
    const role = insertRole(p.state, { definitionId: p.bandDef });
    const at = placeFor(p.state, p.owner, role, ref(p.owner, p.card), p.bandDef)!;
    expect(at).toEqual({ owner: p.owner, parentId: null, index: 2 });
    expect(sectionWhere(p.state, at)).toMatchObject({ lead: 'after', target: 'Section' });
    const out = apply(p.state, insertOps(at, { definitionId: p.bandDef }, role));
    expect(home(out.state).rootIds).toHaveLength(4);
    expect(home(out.state).rootIds[2]).toBe(out.results.at(-1)!.nodeId);
    expect((home(out.state).nodes[home(out.state).rootIds[2]] as InstanceNode).definitionId).toBe(p.bandDef);
  });

  it('carries a chosen variant into the inserted placement', () => {
    const p = exhibitors();
    const ops = insertOps({ owner: p.owner, parentId: null, index: 0 }, { componentId: 'layout.section', variants: { tone: 'inverse' }, text: undefined }, 'section');
    expect(ops).toEqual([{ type: 'node.insert', owner: p.owner, parentId: null, slot: undefined, index: 0, componentId: 'layout.section', variants: { tone: 'inverse' } }]);
  });
});

describe('a part picked inside a placement counts as the placement, in the slot it holds (#185)', () => {
  /** A part of a placement, as Layers picks it (Section › Parts › Container). */
  const partOf = (owner: OwnerRef, placement: string, nodeId: string, partId?: string): ElementRef => ({ owner, instancePath: [placement], nodeId, ...(partId ? { partId } : {}) });

  it('a Section’s Container takes a card, an element and a section as the Section itself would, not the page’s last Section', () => {
    const p = exhibitors();
    const def = p.state.components[(home(p.state).nodes[p.intro] as InstanceNode).definitionId];
    const container = partOf(p.owner, p.intro, def.parts.container.nodeId, 'container');
    expect(heldSlot(p.state, container)).toBe('content');
    expect(insertAt(p.state, p.owner, 'element', container, p.cardDef)).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
    expect(insertAt(p.state, p.owner, 'element', container)).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
    expect(insertAt(p.state, p.owner, 'section', container, p.bandDef)).toEqual({ owner: p.owner, parentId: null, slot: undefined, index: 1 });
    // Nothing selected still goes into the last Section that holds content.
    expect(insertAt(p.state, p.owner, 'element', null, p.cardDef)).toEqual({ owner: p.owner, parentId: p.section, slot: 'content' });
  });

  it('reads anything inside a placement, however deep, as the outermost placement on the page', () => {
    const p = exhibitors();
    expect(placementOf({ owner: p.owner, instancePath: [p.intro, 'nested'], nodeId: 'deep' })).toEqual(ref(p.owner, p.intro));
    expect(placementOf(ref(p.owner, p.card))).toEqual(ref(p.owner, p.card));
    expect(placementOf(null)).toBeNull();
    // Inside a component placed in the Section's design, nothing the page fills is picked: the Section's own first slot.
    expect(heldSlot(p.state, { owner: p.owner, instancePath: [p.intro, 'nested'], nodeId: 'deep' })).toBeUndefined();
    expect(insertAt(p.state, p.owner, 'element', { owner: p.owner, instancePath: [p.intro, 'nested'], nodeId: 'deep' })).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
  });

  it('a part that holds the second of two slots picks it; the placement, its root or another part, the first', () => {
    const p = exhibitors();
    // The card gets an images-only Media slot declared first and an open Body slot, shown in a Wrap in the other
    // order (Body in a box of its own, then Media), and an Extra slot shown only through a repeat.
    const def = p.state.components[p.cardDef];
    const root = def.tree!.rootIds[0];
    def.slots = { media: { label: 'Media', primitives: ['image'] }, body: { label: 'Body' }, extra: { label: 'Extra' } };
    def.tree!.nodes.mediaSlot = { id: 'mediaSlot', kind: 'slot', slot: 'media' };
    def.tree!.nodes.bodySlot = { id: 'bodySlot', kind: 'slot', slot: 'body' };
    def.tree!.nodes.extraSlot = { id: 'extraSlot', kind: 'slot', slot: 'extra' };
    def.tree!.nodes.bodyBox = { id: 'bodyBox', kind: 'element', tag: 'div', children: ['bodySlot'] };
    def.tree!.nodes.wrap = { id: 'wrap', kind: 'element', tag: 'div', children: ['bodyBox', 'mediaSlot'] };
    def.tree!.nodes.rows = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: ['extraSlot'] };
    def.tree!.nodes.rowsBox = { id: 'rowsBox', kind: 'element', tag: 'div', children: ['rows'] };
    (def.tree!.nodes[root] as ElementNode).children.push('wrap', 'rowsBox');
    const para = (def.tree!.nodes[root] as ElementNode).children[0];
    expect(heldSlot(p.state, partOf(p.owner, p.card, 'bodyBox'))).toBe('body');
    expect(insertAt(p.state, p.owner, 'element', partOf(p.owner, p.card, 'bodyBox'))).toEqual({ owner: p.owner, parentId: p.card, slot: 'body' });
    // Another component goes there too.
    expect(insertAt(p.state, p.owner, 'element', partOf(p.owner, p.card, 'bodyBox'), p.bandDef)).toEqual({ owner: p.owner, parentId: p.card, slot: 'body' });
    // Holding both, the Wrap picks the one declared first, as the card itself does.
    expect(heldSlot(p.state, partOf(p.owner, p.card, 'wrap'))).toBe('media');
    // A slot shown once per item of a list is not where one insert goes.
    expect(heldSlot(p.state, partOf(p.owner, p.card, 'rowsBox'))).toBeUndefined();
    for (const from of [ref(p.owner, p.card), partOf(p.owner, p.card, root, 'root'), partOf(p.owner, p.card, para), partOf(p.owner, p.card, 'rowsBox')]) {
      expect(insertAt(p.state, p.owner, 'element', from)).toEqual({ owner: p.owner, parentId: p.card, slot: 'media' });
    }
    // A card inserted beside its own placement stays beside it, whichever part is picked.
    expect(insertAt(p.state, p.owner, 'element', partOf(p.owner, p.card, 'bodyBox'), p.cardDef)).toEqual({ owner: p.owner, parentId: p.grid, slot: undefined, index: 1 });
    // And what the Body takes lands there.
    const out = apply(p.state, insertOps(insertAt(p.state, p.owner, 'element', partOf(p.owner, p.card, 'bodyBox'))!, { definitionId: p.bandDef }, 'element'));
    expect((home(out.state).nodes[p.card] as InstanceNode).slots?.body).toEqual([out.results.at(-1)!.nodeId]);
  });
});

describe('a part or repeated item inside a placed section inserts beside that section, never at the page end (#510)', () => {
  /** The exhibitors page (Intro, a Section holding a grid and its card, the slotless Closing band), with one more
   *  flexible Section after the band when `tail`: the page's last section that takes content, where the insert used to go. */
  function page(tail: boolean) {
    const p = exhibitors();
    if (!tail) return { ...p, tail: undefined };
    const out = apply(p.state, [{ type: 'node.insert', owner: p.owner, parentId: null, componentId: 'layout.section' }]);
    return { ...p, state: out.state, tail: out.results[0].nodeId as string };
  }
  type Page = ReturnType<typeof page>;
  const placement = (p: Page, id: string) => p.state.components[(home(p.state).nodes[id] as InstanceNode).definitionId];
  /** A part of a placement, as Layers or the canvas picks it, from inside the placement's own design. */
  const part = (p: Page, id: string, nodeId: string, extra: Partial<ElementRef> = {}): ElementRef => ({ owner: p.owner, instancePath: [id], nodeId, ...extra });
  const container = (p: Page, id: string) => part(p, id, placement(p, id).parts.container.nodeId, { partId: 'container' });
  /** Something inside the Closing band's design that is not its root. */
  const inBand = (p: Page, extra: Partial<ElementRef> = {}) => {
    const def = placement(p, p.band);
    return part(p, p.band, Object.keys(def.tree!.nodes).find((id) => id !== def.tree!.rootIds[0] && def.tree!.nodes[id].kind !== 'slot')!, extra);
  };
  const after = (p: Page, at: NonNullable<ReturnType<typeof insertAt>>) => nodeBefore(p.state, p.owner, at.parentId, at.slot, at.index);

  for (const tail of [false, true]) {
    describe(tail ? 'with a flexible Section after the last component' : 'with a component as the last section', () => {
      it('puts a section right after the section holding the part, and the Insert line says so', () => {
        const p = page(tail);
        const picks: Array<[string, ElementRef, string]> = [
          ['a part of the first Section', container(p, p.intro), p.intro],
          ['a part of a card inside the second Section’s grid', part(p, p.card, placement(p, p.card).tree!.rootIds[0]), p.section],
          ['a part of the Closing band', inBand(p), p.band]
        ];
        for (const [name, from, enclosing] of picks) {
          const at = insertAt(p.state, p.owner, 'section', from)!;
          expect(at, name).toEqual({ owner: p.owner, parentId: null, index: home(p.state).rootIds.indexOf(enclosing) + 1 });
          expect(after(p, at)).toBe(enclosing);
          expect(sectionWhere(p.state, at)).toEqual({ lead: 'after', target: nodeLabel(p.state, p.owner, enclosing) });
          // The placement itself picked says the same.
          expect(insertAt(p.state, p.owner, 'section', ref(p.owner, enclosing))).toEqual(at);
        }
        // It lands there, and the page's last section stays last.
        const at = insertAt(p.state, p.owner, 'section', container(p, p.intro))!;
        const out = apply(p.state, insertOps(at, { componentId: 'layout.section' }, 'section'));
        expect(home(out.state).rootIds).toHaveLength(home(p.state).rootIds.length + 1);
        expect(home(out.state).rootIds[1]).toBe(out.results.at(-1)!.nodeId);
        expect(home(out.state).rootIds.at(-1)).toBe(p.tail ?? p.band);
      });

      it('puts an element into the slot of the section holding the part, not the last section that takes content', () => {
        const p = page(tail);
        for (const from of [container(p, p.intro), part(p, p.intro, placement(p, p.intro).parts.root.nodeId, { partId: 'root' })]) {
          const at = insertAt(p.state, p.owner, 'element', from)!;
          expect(at).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
          expect(elementWhere(p.state, at)).toEqual({ lead: 'inside', target: nodeLabel(p.state, p.owner, p.intro), node: true });
          const out = apply(p.state, insertOps(at, { primitive: 'heading' }, 'element'));
          expect((home(out.state).nodes[p.intro] as InstanceNode).slots?.content).toEqual([out.results.at(-1)!.nodeId]);
          expect(home(out.state).rootIds).toEqual(home(p.state).rootIds);
          for (const other of [p.section, p.tail]) if (other) expect((home(out.state).nodes[other] as InstanceNode).slots?.content ?? []).toEqual((home(p.state).nodes[other] as InstanceNode).slots?.content ?? []);
        }
        // Beside a card inside a grid, an element goes next to the card, in its grid.
        const card = insertAt(p.state, p.owner, 'element', part(p, p.card, placement(p, p.card).tree!.rootIds[0]))!;
        expect(card).toEqual({ owner: p.owner, parentId: p.grid, index: 1 });
      });

      it('wraps an element for a part of a section that takes no content in a new section right after it', () => {
        const p = page(tail);
        const from = inBand(p);
        const at = insertAt(p.state, p.owner, 'element', from)!;
        const index = home(p.state).rootIds.indexOf(p.band) + 1;
        expect(at).toEqual({ owner: p.owner, parentId: null, index });
        expect(elementWhere(p.state, at)).toEqual({ lead: 'in a new section after', target: 'Closing band', node: true });
        const ops = insertOps(at, { primitive: 'heading' }, 'element');
        expect(ops[0]).toMatchObject({ type: 'node.insert', parentId: null, index, componentId: 'layout.section' });
        const out = apply(p.state, ops);
        const rootIds = home(out.state).rootIds;
        expect(rootIds).toHaveLength(home(p.state).rootIds.length + 1);
        expect(rootIds[index - 1]).toBe(p.band);
        expect((home(out.state).nodes[rootIds[index]] as InstanceNode).slots?.content).toEqual([out.results.at(-1)!.nodeId]);
        // The flexible Section after it, when there is one, takes nothing.
        if (p.tail) {
          expect(rootIds.at(-1)).toBe(p.tail);
          expect((home(out.state).nodes[p.tail] as InstanceNode).slots?.content ?? []).toEqual([]);
        }
      });

      it('reads a repeated item of a placed section as the section too', () => {
        const p = page(tail);
        const item = ['row-1'];
        for (const role of ['section', 'element'] as const) {
          expect(insertAt(p.state, p.owner, role, inBand(p, { itemPath: item }))).toEqual(insertAt(p.state, p.owner, role, inBand(p)));
          expect(insertAt(p.state, p.owner, role, container(p, p.intro))).toEqual(insertAt(p.state, p.owner, role, { ...container(p, p.intro), itemPath: item }));
        }
        expect(insertAt(p.state, p.owner, 'section', inBand(p, { itemPath: item }))).toEqual({ owner: p.owner, parentId: null, index: home(p.state).rootIds.indexOf(p.band) + 1 });
        // Two levels deep (a repeated item of a component placed in a section's design) is still the outer placement.
        const deep: ElementRef = { owner: p.owner, instancePath: [p.intro, 'nested'], nodeId: 'deep', itemPath: item };
        expect(insertAt(p.state, p.owner, 'section', deep)).toEqual({ owner: p.owner, parentId: null, index: 1 });
        expect(insertAt(p.state, p.owner, 'element', deep)).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
      });
    });
  }

  it('does the same inside a component edited everywhere: a part of a section placed in its design counts as that section', () => {
    const p = page(false);
    const owner: OwnerRef = { kind: 'component', id: p.cardDef };
    const root = p.state.components[p.cardDef].tree!.rootIds[0];
    const out = apply(p.state, [{ type: 'node.insert', owner, parentId: root, componentId: 'layout.section' }]);
    const state = out.state;
    const first = out.results[0].nodeId as string;
    const def = state.components[(state.components[p.cardDef].tree!.nodes[first] as InstanceNode).definitionId];
    const from: ElementRef = { owner, instancePath: [first], nodeId: def.parts.container.nodeId, partId: 'container' };
    // An element goes into the nested section's slot, and a section at the end of the component's one root: the
    // same places as with the nested section itself picked.
    expect(insertAt(state, owner, 'element', from)).toEqual({ owner, parentId: first, slot: 'content' });
    expect(insertAt(state, owner, 'section', from)).toEqual({ owner, parentId: root });
    expect(insertAt(state, owner, 'section', from)).toEqual(insertAt(state, owner, 'section', ref(owner, first)));
    expect(insertAt(state, owner, 'element', from)).toEqual(insertAt(state, owner, 'element', ref(owner, first)));
    // A repeated item of it too.
    for (const role of ['section', 'element'] as const) expect(insertAt(state, owner, role, { ...from, itemPath: ['row-1'] })).toEqual(insertAt(state, owner, role, from));
  });
});

describe('a column layout comes with its empty columns, in one change (#514)', () => {
  /** The Grid a batch made, its columns, and the page after it. */
  const made = (state: ProjectState, gridId: string) => {
    const page = home(state);
    const grid = page.nodes[gridId] as ElementNode;
    return { grid, columns: grid.children.map((id) => page.nodes[id] as ElementNode) };
  };

  for (const n of [2, 3, 4])
    it(`${n} columns: a Grid holding ${n} empty Stacks, named for their places, side by side on desktop`, () => {
      const p = exhibitors();
      const at = insertAt(p.state, p.owner, 'element', ref(p.owner, p.intro))!;
      expect(at).toEqual({ owner: p.owner, parentId: p.intro, slot: 'content' });
      const ops = insertOps(at, { primitive: 'grid', columns: n }, 'element', 'n_columns');
      expect(ops[0]).toEqual({ type: 'node.insert', newNodeId: 'n_columns', owner: p.owner, parentId: p.intro, slot: 'content', index: undefined, primitive: 'grid' });
      const { state } = apply(p.state, ops);
      expect((home(state).nodes[p.intro] as InstanceNode).slots?.content).toEqual(['n_columns']);
      const { grid, columns } = made(state, 'n_columns');
      // One column above the other on phones and tablets, as any Grid starts; side by side on desktop.
      expect(grid).toMatchObject({ kind: 'element', name: 'Columns', styles: { base: { layout: 'grid', columns: 1 }, desktop: { columns: n } } });
      expect(new Set(grid.children).size).toBe(n);
      expect(columns.map((c) => c.name)).toEqual(Array.from({ length: n }, (_, i) => `Column ${i + 1}`));
      for (const c of columns) expect(c).toMatchObject({ kind: 'element', children: [], styles: { base: { layout: 'stack' } } });
      expect(validateState(state).filter((d) => d.severity === 'error')).toEqual([]);
      // The first column is what Insert selects, so the next element fills it rather than adding a fourth cell.
      expect(insertSelection(ops, 'n_columns')).toBe(grid.children[0]);
    });

  it('on a page with nowhere to put it, comes in a new Section; each insert names its own Grid', () => {
    let state = createStarterState('blank', 'Plain', false);
    const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const at = insertAt(state, owner, 'element', null)!;
    expect(at.parentId).toBeNull();
    const ops = insertOps(at, { primitive: 'grid', columns: 2 }, 'element');
    expect(ops[0]).toMatchObject({ type: 'node.insert', parentId: null, componentId: 'layout.section' });
    const gridId = (ops[1] as { newNodeId?: string }).newNodeId!;
    expect(gridId).toMatch(/^n_/);
    state = apply(state, ops).state;
    const section = home(state).nodes[home(state).rootIds[0]] as InstanceNode;
    expect(section.slots?.content).toEqual([gridId]);
    expect(made(state, gridId).columns).toHaveLength(2);
    // Planned again, it is another Grid with other columns.
    const again = insertOps(at, { primitive: 'grid', columns: 2 }, 'element');
    expect((again[1] as { newNodeId?: string }).newNodeId).not.toBe(gridId);
  });

  it('a count that is not a column layout, or a spec that is no Grid, inserts as it did', () => {
    const p = exhibitors();
    const at: InsertAt = { owner: p.owner, parentId: p.grid };
    for (const columns of [1, 2.5, 9]) expect(insertOps(at, { primitive: 'grid', columns }, 'element')).toEqual([{ type: 'node.insert', owner: p.owner, parentId: p.grid, slot: undefined, index: undefined, primitive: 'grid' }]);
    // Anything else inserted is itself what is selected, a new section around it or not.
    expect(insertSelection(insertOps(at, { primitive: 'grid' }, 'element', 'n_plain'), 'n_plain')).toBe('n_plain');
    expect(insertSelection(insertOps({ owner: p.owner, parentId: null }, { primitive: 'heading' }, 'element', 'n_title'), 'n_title')).toBe('n_title');
    expect(insertOps(at, { primitive: 'stack', columns: 2 }, 'element')).toEqual([{ type: 'node.insert', owner: p.owner, parentId: p.grid, slot: undefined, index: undefined, primitive: 'stack' }]);
  });
});

describe('A component’s placement role, chosen in Component Studio (#661)', () => {
  it('component.setInsertAs sets where Insert and + put it, and changes nothing else', () => {
    const p = exhibitors();
    const offered = (st: ProjectState, role: 'section' | 'element') => quickItems(st, role).some((i) => i.spec.definitionId === p.cardDef);
    expect(offered(p.state, 'element')).toBe(true);
    const out = apply(p.state, [{ type: 'component.setInsertAs', definitionId: p.cardDef, insertAs: 'section' }]);
    const { insertAs, ...rest } = out.state.components[p.cardDef];
    const { insertAs: was, ...restBefore } = p.state.components[p.cardDef];
    expect([was, insertAs]).toEqual(['element', 'section']);
    expect(rest).toEqual(restBefore);
    expect(out.state.pages).toEqual(p.state.pages);
    expect(validateState(out.state)).toEqual(validateState(p.state));
    expect(insertRole(out.state, { definitionId: p.cardDef })).toBe('section');
    expect(offered(out.state, 'section')).toBe(true);
    expect(offered(out.state, 'element')).toBe(false);
    // With a card in the grid selected, it went beside the card; now it goes after the section holding the grid.
    const at = (st: ProjectState) => insertAt(st, p.owner, insertRole(st, { definitionId: p.cardDef }), ref(p.owner, p.card), p.cardDef);
    expect(at(p.state)).toMatchObject({ owner: p.owner, parentId: p.grid });
    expect(at(out.state)).toEqual({ owner: p.owner, parentId: null, index: home(out.state).rootIds.indexOf(p.section) + 1 });
  });

  it('null hands it back to the editor, which tells it from the design (Automatic)', () => {
    const p = exhibitors();
    const chosen = apply(p.state, [{ type: 'component.setInsertAs', definitionId: p.cardDef, insertAs: 'section' }]).state;
    // What Automatic would say, while the author's choice stands.
    expect(inferredRole(chosen, p.cardDef)).toBe('element');
    expect(chosen.components[p.cardDef].insertAs).toBe('section');
    const cleared = apply(chosen, [{ type: 'component.setInsertAs', definitionId: p.cardDef, insertAs: null }]).state;
    expect(Object.hasOwn(cleared.components[p.cardDef], 'insertAs')).toBe(false);
    expect(definitionRole(cleared, p.cardDef)).toBe('element');
    expect(inferredRole(cleared, p.bandDef)).toBe('section');
  });

  it('Automatic reads the design even with no placement to go on', () => {
    const p = exhibitors();
    const unplaced = apply(p.state, [
      { type: 'node.remove', owner: p.owner, nodeId: p.card },
      { type: 'component.setInsertAs', definitionId: p.cardDef, insertAs: null }
    ]).state;
    // A design rooted in a stack, not a section element: inside layouts.
    expect(inferredRole(unplaced, p.cardDef)).toBe('element');
    const chosen = apply(unplaced, [{ type: 'component.setInsertAs', definitionId: p.cardDef, insertAs: 'section' }]).state;
    expect(inferredRole(chosen, p.cardDef)).toBe('element');
    expect(definitionRole(chosen, p.cardDef)).toBe('section');
  });

  it('is the project’s own components only', () => {
    const p = exhibitors();
    const themeDef = home(p.state).nodes[p.intro] as InstanceNode;
    expect(() => apply(p.state, [{ type: 'component.setInsertAs', definitionId: themeDef.definitionId, insertAs: 'element' }])).toThrow(/belongs to the theme/);
    expect(() => apply(p.state, [{ type: 'component.setInsertAs', definitionId: 'nope', insertAs: 'element' }])).toThrow(/does not exist/);
  });
});

describe('What the Inspector calls a placement (#661)', () => {
  it('a component inside a layout or a slot is a component; one of the page’s sections is a section', () => {
    const p = exhibitors();
    expect(placementRole(p.state, p.owner, p.card)).toBe('element');
    expect(placementRole(p.state, p.owner, p.band)).toBe('section');
    expect(placementRole(p.state, p.owner, p.intro)).toBe('section');
  });

  it('reads where each placement sits: one definition can be a section on the page and a component in a slot', () => {
    const p = exhibitors();
    // The band, a section by choice, placed again inside the middle section's slot.
    const { state, results } = apply(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.section, slot: 'content', definitionId: p.bandDef }]);
    const nested = results[0];
    expect(definitionRole(state, p.bandDef)).toBe('section');
    expect(placementRole(state, p.owner, nested.nodeId as string)).toBe('element');
    expect(placementRole(state, p.owner, p.band)).toBe('section');
    // And as a plain child of the grid, beside the card.
    const inGrid = apply(state, [{ type: 'node.insert', owner: p.owner, parentId: p.grid, definitionId: p.bandDef }]);
    expect(placementRole(inGrid.state, p.owner, inGrid.results[0].nodeId as string)).toBe('element');
  });

  it('reads the shared header’s own tree', () => {
    const p = exhibitors();
    const header: OwnerRef = { kind: 'shell', id: 'header' };
    const top = p.state.site.shell.header.rootIds[0];
    expect(placementRole(p.state, header, top)).toBe('section');
    // The band, a section by choice, inside a section of the header.
    const holder = apply(p.state, [{ type: 'node.insert', owner: header, parentId: null, componentId: 'layout.section' }]);
    const holderId = holder.results[0].nodeId as string;
    const out = apply(holder.state, [{ type: 'node.insert', owner: header, parentId: holderId, slot: 'content', definitionId: p.bandDef }]);
    const inner = out.results[0].nodeId as string;
    expect(findParent(out.state.site.shell.header, inner)?.parentId).toBe(holderId);
    expect(placementRole(out.state, header, inner)).toBe('element');
    expect(placementRole(out.state, header, holderId)).toBe('section');
  });

  it('a component set to insert inside layouts is a component even at the top of the page', () => {
    const p = exhibitors();
    const state = apply(p.state, [{ type: 'component.setInsertAs', definitionId: p.bandDef, insertAs: 'element' }]).state;
    expect(placementRole(state, p.owner, p.band)).toBe('element');
  });

  it('anything placed in a component’s design is a component', () => {
    const p = exhibitors();
    const owner: OwnerRef = { kind: 'component', id: p.bandDef };
    const rootId = p.state.components[p.bandDef].tree!.rootIds[0];
    expect(placementRole(p.state, owner, rootId)).toBe('element');
  });
});
