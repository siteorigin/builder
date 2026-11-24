import { describe, expect, it } from 'vitest';
import type { ElementNode, ElementRef, InstanceNode, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { definitionRole, elementWhere, insertOps, insertRole, placeFor, sectionWhere, whereFor } from '../../src/renderer/src/lib/insert-at';

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
