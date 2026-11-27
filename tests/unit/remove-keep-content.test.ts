import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementNode, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { definitionRole } from '@engine/insert-role';
import { validateState } from '@engine/validate';
import { checkAuthority, OP_REACH, type Authority } from '@agent/scope';
import { describeOps } from '@agent/report';
import { ProjectSession } from '../../src/main/project/session';
import { projectDesign } from './fixtures/packs';
import { FEATURES } from './fixtures/wrap-designs';

// Delete a container or a slotted placement but keep what it holds (#656): one operation, so one change and one Undo,
// that lifts its children (a placement's slots in the order its component declares them) into its place.

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const page = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const lift = (s: ProjectState, nodeId: string, owner: OwnerRef = page(s)) => apply(s, [{ type: 'node.removeKeepContent', owner, nodeId }]);
const inst = (s: ProjectState, id: string) => home(s).nodes[id] as InstanceNode;
const slotOf = (s: ProjectState, id: string, slot = 'content') => inst(s, id).slots![slot];

/**
 * A blank site with a two-column Split component of the project's own: slots Left and Right, declared in that order,
 * though its design shows Right first. A Card component of the project's own places as an element.
 */
function project() {
  const s0 = createStarterState('blank', 'Blank', false);
  const c = apply(s0, [
    { type: 'component.create', name: 'Split' },
    { type: 'component.create', name: 'Card' }
  ]);
  const split = c.results[0].definitionId as string;
  const card = c.results[1].definitionId as string;
  const own = { kind: 'component' as const, id: split };
  const s = apply(c.state, [
    { type: 'component.setSlot', definitionId: split, slot: 'left', label: 'Left' },
    { type: 'component.setSlot', definitionId: split, slot: 'right', label: 'Right' },
    { type: 'node.insert', owner: own, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'right' },
    { type: 'node.insert', owner: own, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'left' },
    { type: 'node.insert', owner: { kind: 'component', id: card }, parentId: c.results[1].rootNodeId as string, primitive: 'heading', text: 'Card' }
  ]).state;
  return { s, split, card };
}

/**
 * The Split filled: Left holds a styled heading with an anchor and a Card, Right a Hero (a section of the theme's) and
 * a button. `at` says where the Split goes: inserted by `place`, which names its node n_split.
 */
function filled(place: (s: ProjectState, split: string) => EditOperation[]) {
  const { s, split, card } = project();
  const o = page(s);
  const r = apply(s, [
    ...place(s, split),
    { type: 'node.insert', newNodeId: 'n_heading', owner: o, parentId: 'n_split', slot: 'left', primitive: 'heading', text: 'Our story' },
    { type: 'node.setStyle', owner: o, nodeId: 'n_heading', scope: 'desktop', property: 'paddingBlock', value: { token: 'space.sm' } },
    { type: 'node.setContent', owner: o, nodeId: 'n_heading', field: 'anchor', value: 'story' },
    { type: 'node.insert', newNodeId: 'n_card', owner: o, parentId: 'n_split', slot: 'left', definitionId: card },
    { type: 'node.insert', newNodeId: 'n_hero', owner: o, parentId: 'n_split', slot: 'right', componentId: 'hero.centered', props: { heading: 'Welcome' } },
    { type: 'node.insert', newNodeId: 'n_button', owner: o, parentId: 'n_split', slot: 'right', primitive: 'button', text: 'Book' }
  ]);
  return { s: r.state, split, card };
}

const atTop = (s: ProjectState, split: string): EditOperation[] => [{ type: 'node.insert', newNodeId: 'n_split', owner: page(s), definitionId: split }];
const inSection = (s: ProjectState, split: string): EditOperation[] => [
  { type: 'node.insert', newNodeId: 'n_section', owner: page(s), componentId: 'layout.section' },
  { type: 'node.insert', newNodeId: 'n_first', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'Before' },
  { type: 'node.insert', newNodeId: 'n_split', owner: page(s), parentId: 'n_section', slot: 'content', definitionId: split },
  { type: 'node.insert', newNodeId: 'n_last', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'After' }
];
const inGrid = (s: ProjectState, split: string): EditOperation[] => [
  { type: 'node.insert', newNodeId: 'n_section', owner: page(s), componentId: 'layout.section' },
  { type: 'node.insert', newNodeId: 'n_grid', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'grid' },
  { type: 'node.insert', newNodeId: 'n_first', owner: page(s), parentId: 'n_grid', primitive: 'paragraph', text: 'Before' },
  { type: 'node.insert', newNodeId: 'n_split', owner: page(s), parentId: 'n_grid', definitionId: split }
];

describe('Delete a slotted placement and keep what it holds', () => {
  it('lifts its slots in the order the component declares them into the container that held it', () => {
    const { s } = filled(inGrid);
    const kept = ['n_heading', 'n_card', 'n_hero', 'n_button'].map((id) => JSON.stringify(home(s).nodes[id]));
    const r = lift(s, 'n_split');
    const grid = home(r.state).nodes.n_grid as ElementNode;
    // Left before Right, as declared, though the design shows Right first.
    expect(grid.children).toEqual(['n_first', 'n_heading', 'n_card', 'n_hero', 'n_button']);
    expect(home(r.state).nodes).not.toHaveProperty('n_split');
    expect(r.results[0]).toEqual({ nodeId: 'n_heading', nodeIds: ['n_heading', 'n_card', 'n_hero', 'n_button'] });
    // What it held is the same: IDs, anchor, styles and props.
    expect(['n_heading', 'n_card', 'n_hero', 'n_button'].map((id) => JSON.stringify(home(r.state).nodes[id]))).toEqual(kept);
    expect(home(r.state).nodes.n_heading).toMatchObject({ anchor: 'story', styles: { desktop: { paddingBlock: { token: 'space.sm' } } } });
    expect(errors(r.state)).toEqual([]);
  });

  it('lifts into the slot of the Section that held it, between what the slot already showed', () => {
    const { s } = filled(inSection);
    const r = lift(s, 'n_split');
    expect(slotOf(r.state, 'n_section')).toEqual(['n_first', 'n_heading', 'n_card', 'n_hero', 'n_button', 'n_last']);
    expect(errors(r.state)).toEqual([]);
  });

  it('on a page’s top level, puts each run of elements in a new Section and leaves a section of the theme’s bare', () => {
    const { s, card } = filled(atTop);
    expect(definitionRole(s, card)).toBe('element');
    expect(definitionRole(s, inst(s, 'n_hero').definitionId)).toBe('section');
    const r = lift(s, 'n_split');
    const roots = home(r.state).rootIds;
    expect(roots).toHaveLength(3);
    const [first, hero, last] = roots;
    expect(hero).toBe('n_hero');
    for (const id of [first, last]) expect(r.state.components[inst(r.state, id).definitionId].componentId).toBe('layout.section');
    expect(slotOf(r.state, first)).toEqual(['n_heading', 'n_card']);
    expect(slotOf(r.state, last)).toEqual(['n_button']);
    expect(r.results[0]).toEqual({ nodeId: first, nodeIds: roots });
    expect(home(r.state).nodes.n_heading).toMatchObject({ anchor: 'story' });
    expect(errors(r.state)).toEqual([]);
  });

  it('leaves the top level as it was around the placement, sections before and after it included', () => {
    const { s } = filled((st, split) => [
      { type: 'node.insert', newNodeId: 'n_before', owner: page(st), componentId: 'layout.section' },
      ...atTop(st, split),
      { type: 'node.insert', newNodeId: 'n_after', owner: page(st), componentId: 'layout.section' }
    ]);
    const r = lift(s, 'n_split');
    const roots = home(r.state).rootIds;
    expect(roots[0]).toBe('n_before');
    expect(roots[2]).toBe('n_hero');
    expect(roots[roots.length - 1]).toBe('n_after');
    expect(roots).toHaveLength(5);
  });
});

describe('Delete a placement in a slot with a contract', () => {
  /** The Split inside a Section of the project's own, whose Content slot is then limited by `contract`. */
  function limited(contract: { primitives?: string[]; categories?: string[]; max?: number }) {
    const { s } = filled(inSection);
    const sectionDef = inst(s, 'n_section').definitionId;
    const f = apply(s, [{ type: 'component.fork', definitionId: sectionDef }]);
    const id = f.results[0].definitionId as string;
    const r = apply(f.state, [
      { type: 'node.insert', newNodeId: 'n_own', owner: page(s), definitionId: id },
      { type: 'node.move', owner: page(s), nodeId: 'n_split', parentId: 'n_own', slot: 'content', index: 0 },
      { type: 'node.remove', owner: page(s), nodeId: 'n_section' },
      { type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', ...(contract as object) }
    ]);
    return r.state;
  }

  it('lifts what the slot takes', () => {
    const s = limited({ primitives: ['text', 'link', 'element'], categories: ['custom', 'hero'] });
    const r = lift(s, 'n_split');
    expect(slotOf(r.state, 'n_own')).toEqual(['n_heading', 'n_card', 'n_hero', 'n_button']);
  });

  it('refuses what the slot does not take, says what to do, and changes nothing', () => {
    const s = limited({ primitives: ['link', 'element'], categories: ['custom', 'hero'] });
    const before = JSON.stringify(s);
    expect(() => lift(s, 'n_split')).toThrow('The “Content” slot of “Section” takes custom or hero components, buttons and containers, not text. Delete “Split” with what it holds instead, or move that content out of it first.');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('refuses more than the slot holds', () => {
    const s = limited({ max: 2 });
    expect(() => lift(s, 'n_split')).toThrow(/holds at most 2 items/);
  });
});

describe('Delete a container and keep what it holds', () => {
  it('lifts a Stack’s children, whole subtrees included, into the slot that held it', () => {
    const { s, split } = filled(inSection);
    const o = page(s);
    const r0 = apply(s, [
      { type: 'node.insert', newNodeId: 'n_stack', owner: o, parentId: 'n_section', slot: 'content', index: 1, primitive: 'stack' },
      { type: 'node.setStyle', owner: o, nodeId: 'n_stack', scope: 'desktop', property: 'gap', value: { token: 'space.lg' } },
      { type: 'node.move', owner: o, nodeId: 'n_split', parentId: 'n_stack', index: 0 },
      { type: 'node.insert', newNodeId: 'n_note', owner: o, parentId: 'n_stack', primitive: 'paragraph', text: 'Note' }
    ]).state;
    const subtree = JSON.stringify(['n_split', 'n_heading', 'n_card', 'n_hero', 'n_button', 'n_note'].map((id) => home(r0).nodes[id]));
    const r = lift(r0, 'n_stack');
    expect(slotOf(r.state, 'n_section')).toEqual(['n_first', 'n_split', 'n_note', 'n_last']);
    expect(home(r.state).nodes).not.toHaveProperty('n_stack');
    expect(JSON.stringify(['n_split', 'n_heading', 'n_card', 'n_hero', 'n_button', 'n_note'].map((id) => home(r.state).nodes[id]))).toBe(subtree);
    expect(inst(r.state, 'n_split')).toMatchObject({ definitionId: split, slots: { left: ['n_heading', 'n_card'], right: ['n_hero', 'n_button'] } });
    expect(errors(r.state)).toEqual([]);
  });

  it('deletes an empty container, with nothing in its place', () => {
    const { s } = filled(inSection);
    const r0 = apply(s, [{ type: 'node.insert', newNodeId: 'n_empty', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'stack' }]).state;
    const r = lift(r0, 'n_empty');
    expect(r.results[0]).toEqual({ nodeIds: [] });
    expect(slotOf(r.state, 'n_section')).toEqual(['n_first', 'n_split', 'n_last']);
    expect(home(r.state).nodes).not.toHaveProperty('n_empty');
  });

  it('follows the order the component declares its slots in, not the order they were filled or their names', () => {
    const { s, split } = project();
    const o = page(s);
    const r0 = apply(s, [
      // Declared last, though its name sorts first.
      { type: 'component.setSlot', definitionId: split, slot: 'aside', label: 'Aside' },
      ...inGrid(s, split),
      { type: 'node.insert', newNodeId: 'n_c', owner: o, parentId: 'n_split', slot: 'aside', primitive: 'paragraph', text: 'C' },
      { type: 'node.insert', newNodeId: 'n_b', owner: o, parentId: 'n_split', slot: 'right', primitive: 'button', text: 'B' },
      { type: 'node.insert', newNodeId: 'n_a', owner: o, parentId: 'n_split', slot: 'left', primitive: 'paragraph', text: 'A' }
    ]).state;
    expect(Object.keys(r0.components[split].slots!)).toEqual(['left', 'right', 'aside']);
    expect(Object.keys(inst(r0, 'n_split').slots!)).toEqual(['aside', 'right', 'left']);
    const r = lift(r0, 'n_split');
    expect((home(r.state).nodes.n_grid as ElementNode).children).toEqual(['n_first', 'n_a', 'n_b', 'n_c']);
  });

  it('on a page’s top level, lands a component made as a section bare and wraps one made as an element', () => {
    const { s, card } = filled(atTop);
    s.components[card].insertAs = 'section';
    const r = lift(s, 'n_split');
    const roots = home(r.state).rootIds;
    expect(roots.slice(1, 4)).toEqual(['n_card', 'n_hero', roots[3]]);
    expect(slotOf(r.state, roots[0])).toEqual(['n_heading']);
    expect(slotOf(r.state, roots[3])).toEqual(['n_button']);
    s.components[card].insertAs = 'element';
    s.components[inst(s, 'n_hero').definitionId] = { ...s.components[inst(s, 'n_hero').definitionId], insertAs: 'element' };
    const all = lift(s, 'n_split');
    expect(home(all.state).rootIds).toHaveLength(1);
    expect(slotOf(all.state, home(all.state).rootIds[0])).toEqual(['n_heading', 'n_card', 'n_hero', 'n_button']);
  });

  it('refuses when the new Section does not take what would go in it, and changes nothing', () => {
    const { s } = filled(atTop);
    const placed = apply(s, [{ type: 'node.insert', newNodeId: 'n_other', owner: page(s), componentId: 'layout.section' }]).state;
    const sectionDef = placed.components[inst(placed, 'n_other').definitionId];
    // The first new Section takes its heading and card; the one after the hero would get a button.
    sectionDef.slots!.content = { ...sectionDef.slots!.content, primitives: ['text'], categories: ['custom'] };
    const before = JSON.stringify(placed);
    expect(() => lift(placed, 'n_split')).toThrow('The “Content” slot of “Section” takes custom components and text, not a button. Delete “Split” with what it holds instead, or move that content out of it first.');
    expect(JSON.stringify(placed)).toBe(before);
  });
});

describe('Delete a placement inside a component’s design and keep what it holds', () => {
  /**
   * A Holder whose one slot takes at most one item, placed in a Gallery's design: the Holder's slot holds a container,
   * which holds where the Gallery's own Items slot shows (capped at `max`, or not).
   */
  function forwarded(max?: number) {
    const s0 = createStarterState('blank', 'Blank', false);
    const c = apply(s0, [
      { type: 'component.create', name: 'Holder' },
      { type: 'component.create', name: 'Gallery' }
    ]);
    const holder = c.results[0].definitionId as string;
    const gallery = c.results[1].definitionId as string;
    const own = { kind: 'component' as const, id: gallery };
    const s = apply(c.state, [
      { type: 'component.setSlot', definitionId: holder, slot: 'one', label: 'One', max: 1 },
      { type: 'node.insert', owner: { kind: 'component', id: holder }, parentId: c.results[0].rootNodeId as string, primitive: 'slot', bind: 'one' },
      { type: 'component.setSlot', definitionId: gallery, slot: 'items', label: 'Items', ...(max === undefined ? {} : { max }) },
      { type: 'node.insert', newNodeId: 'n_holder', owner: own, parentId: c.results[1].rootNodeId as string, definitionId: holder },
      { type: 'node.insert', newNodeId: 'n_wrap', owner: own, parentId: 'n_holder', slot: 'one', primitive: 'container' },
      { type: 'node.insert', newNodeId: 'n_items', owner: own, parentId: 'n_wrap', primitive: 'slot', bind: 'items' }
    ]).state;
    return { s, own, gallery };
  }

  it('refuses to put where a slot of any size shows into a slot that holds one item', () => {
    const { s, own } = forwarded();
    expect(() => lift(s, 'n_wrap', own)).toThrow(/The “One” slot of “Holder” holds at most one item, and this can show any number\. Delete/);
  });

  it('lifts it when the slot shown there holds one item too', () => {
    const { s, own, gallery } = forwarded(1);
    const r = lift(s, 'n_wrap', own);
    expect((r.state.components[gallery].tree!.nodes.n_holder as InstanceNode).slots!.one).toEqual(['n_items']);
    expect(errors(r.state)).toEqual([]);
  });
});

describe('Delete a container in a component’s design and keep what it holds', () => {
  /** A Services grid as the project's own: root > inner > (intro, grid > cards (repeat) > card (li) > icon wrap, title, text, link). */
  function features() {
    const s = createStarterState('business', 'Test Studio', false);
    const id = projectDesign(s, FEATURES).id;
    return { s, id, own: { kind: 'component' as const, id } };
  }

  it('deletes the container’s part and the variant styles on it, and keeps those of what it held', () => {
    const { s, id, own } = features();
    const s1 = apply(s, [{ type: 'component.setPart', definitionId: id, partId: 'introBox', nodeId: 'intro', label: 'Intro box' }]).state;
    const sticky = s1.components[id].variantAxes!.layout.options['sticky-split'].styles!;
    expect(sticky).toHaveProperty('intro');
    const r = lift(s1, 'intro', own);
    const def = r.state.components[id];
    expect((def.tree!.nodes.inner as ElementNode).children).toEqual(['eyebrow', 'heading', 'lead', 'grid']);
    expect(def.parts).not.toHaveProperty('introBox');
    expect(def.parts.heading.nodeId).toBe('heading');
    expect(def.variantAxes!.layout.options['sticky-split'].styles).not.toHaveProperty('intro');
    expect(def.variantAxes!.layout.options['sticky-split'].styles).toHaveProperty('inner');
    expect(errors(r.state)).toEqual([]);
  });

  it('refuses to leave list items outside their list, or a list item’s content loose in the list', () => {
    const { s, own } = features();
    expect(() => lift(s, 'grid', own)).toThrow('“Card” is a list item, so it goes directly inside a list (ul or ol).');
    expect(() => lift(s, 'card', own)).toThrow(/can’t go directly inside a list: only list items \(li\) and containers can/);
  });

  it('keeps the item fields what it held shows, inside the same list item', () => {
    const { s, id, own } = features();
    const icon = s.components[id].tree!.nodes['card-icon'];
    expect(JSON.stringify(icon)).toContain('$item');
    const r = lift(s, 'card-icon-wrap', own);
    const def = r.state.components[id];
    expect((def.tree!.nodes.card as ElementNode).children).toEqual(['card-icon', 'card-title', 'card-text', 'card-link']);
    expect(def.tree!.nodes['card-icon']).toEqual(icon);
    expect(def.parts.cardIcon.nodeId).toBe('card-icon');
    expect(errors(r.state)).toEqual([]);
  });
});

describe('What can’t be deleted keeping its content', () => {
  it('refuses a node that holds nothing to keep, a placement without slots, and a component’s own root', () => {
    const { s, split, card } = filled(atTop);
    expect(() => lift(s, 'n_button')).toThrow('“Button” holds nothing to keep. Delete it instead.');
    expect(() => lift(s, 'n_card')).toThrow(/has no slots, so it holds no content of its own to keep/);
    const root = s.components[split].tree!.rootIds[0];
    expect(() => lift(s, root, { kind: 'component', id: split })).toThrow(/This is the component itself, so it cannot be removed/);
    expect(s.components[card].slots ?? {}).toEqual({});
  });

  it('refuses a list repeat in a design', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const id = projectDesign(s, FEATURES).id;
    expect(() => lift(s, 'cards', { kind: 'component', id })).toThrow(/once per list item/);
  });

  it('refuses content left in a slot the component no longer has', () => {
    const { s } = filled(inGrid);
    const ghost = structuredClone(s);
    inst(ghost, 'n_split').slots!.old = ['n_button'];
    inst(ghost, 'n_split').slots!.right = ['n_hero'];
    expect(() => lift(ghost, 'n_split')).toThrow(/holds content in “old”, a slot its component no longer has/);
  });

  it('refuses content listed twice, under the placement itself, or missing', () => {
    const { s } = filled(inGrid);
    const twice = structuredClone(s);
    inst(twice, 'n_split').slots!.right = ['n_hero', 'n_heading'];
    expect(() => lift(twice, 'n_split')).toThrow('What “Split” holds is damaged (listed twice, or missing), so it can’t be kept. Delete “Split” with what it holds instead.');
    const self = structuredClone(s);
    inst(self, 'n_split').slots!.right = ['n_split'];
    expect(() => lift(self, 'n_split')).toThrow(/is damaged/);
    const missing = structuredClone(s);
    inst(missing, 'n_split').slots!.right = ['n_hero', 'n_gone'];
    expect(() => lift(missing, 'n_split')).toThrow(/is damaged/);
  });

  it('refuses a placement without slots, on a page or in a design', () => {
    const { s, split, card } = filled(atTop);
    expect(() => lift(s, 'n_card')).toThrow('“Card” has no slots, so it holds no content of its own to keep. Delete it instead.');
    const own = { kind: 'component' as const, id: split };
    const d = apply(s, [{ type: 'node.insert', newNodeId: 'n_inner', owner: own, parentId: s.components[split].tree!.rootIds[0], definitionId: card }]).state;
    expect(() => lift(d, 'n_inner', own)).toThrow('“Card” has no slots, so it holds no content of its own to keep. Delete it instead.');
  });

  it('refuses what holds tab buttons, alone or beside other content, and keeps a yes/no state’s button', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const id = projectDesign(s, FEATURES).id;
    const own = { kind: 'component' as const, id };
    const t = s.components[id].tree!;
    const tab = (nid: string, value: string) => ({ id: nid, kind: 'link' as const, link: { type: 'none' as const, target: '' }, label: value, appearance: 'primary', stateAction: { state: 'view', op: 'set' as const, value } });
    t.nodes.tabs = { id: 'tabs', kind: 'element', tag: 'div', children: ['t1', 't2'] };
    t.nodes.t1 = tab('t1', 'a');
    t.nodes.t2 = tab('t2', 'b');
    t.nodes.mixed = { id: 'mixed', kind: 'element', tag: 'div', children: ['t3', 'note'] };
    t.nodes.t3 = tab('t3', 'a');
    t.nodes.note = { id: 'note', kind: 'text', tag: 'p', text: 'Pick one' };
    t.nodes.toggles = { id: 'toggles', kind: 'element', tag: 'div', children: ['b1'] };
    t.nodes.b1 = { id: 'b1', kind: 'link', link: { type: 'none', target: '' }, label: 'More', appearance: 'primary', stateAction: { state: 'open', op: 'set', value: true } };
    (t.nodes.inner as ElementNode).children.push('tabs', 'mixed', 'toggles');
    expect(() => lift(s, 'tabs', own)).toThrow(/holds buttons that choose what the component shows \(its tabs\)/);
    // A stray tab among other content could join another tab list's panels once lifted.
    expect(() => lift(s, 'mixed', own)).toThrow(/holds buttons that choose what the component shows/);
    const r = lift(s, 'toggles', own);
    expect((r.state.components[id].tree!.nodes.inner as ElementNode).children.slice(-1)).toEqual(['b1']);
  });

  it('refuses the shared header', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const header = s.site.shell.header!;
    expect(() => lift(s, header.rootIds[0], { kind: 'shell', id: 'header' })).toThrow('The shared header and footer cannot be removed. Edit what they hold instead.');
  });
});

describe('Undo and Redo', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('undoes in one step, the placement and its slots exactly, and redoes the same change', async () => {
    const { s } = filled(atTop);
    const dir = mkdtempSync(join(tmpdir(), 'so-lift-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    const before = structuredClone(session.state);
    const r = await session.apply({ operations: [{ type: 'node.removeKeepContent', owner: page(s), nodeId: 'n_split' }] }, { label: 'Delete, keep content' });
    expect(r.ok).toBe(true);
    const lifted = structuredClone(session.state);
    expect(home(lifted).nodes).not.toHaveProperty('n_split');
    expect(session.historyInfo().undoLabel).toBe('Delete, keep content');
    await session.undo();
    expect(home(session.state)).toEqual(home(before));
    expect(session.state.components).toEqual(before.components);
    expect(session.state.themeLock).toEqual(before.themeLock);
    expect(inst(session.state, 'n_split').slots).toEqual({ left: ['n_heading', 'n_card'], right: ['n_hero', 'n_button'] });
    await session.redo();
    expect(home(session.state)).toEqual(home(lifted));
    expect(session.state.components).toEqual(lifted.components);
    expect(session.state.themeLock).toEqual(lifted.themeLock);
  });
});

describe('What an assistant run may delete keeping its content', () => {
  it('reaches one node: inside a selection, never the selected element itself, whose content would land beside it', () => {
    expect(OP_REACH['node.removeKeepContent']).toBe('node');
    const { s } = filled(inSection);
    const o = page(s);
    const op = (nodeId: string): EditOperation => ({ type: 'node.removeKeepContent', owner: o, nodeId });
    const section: Authority = { kind: 'selection', owner: o, nodeId: 'n_section', label: 'the Section' };
    expect(checkAuthority(s, [op('n_split')], section)).toBeNull();
    const split: Authority = { kind: 'selection', owner: o, nodeId: 'n_split', label: 'the Split' };
    expect(checkAuthority(s, [op('n_split')], split)).toBe('node.removeKeepContent would put what the Split holds outside it.');
    const pageRun: Authority = { kind: 'page', pageId: s.site.homePageId, label: 'Home' };
    expect(checkAuthority(s, [op('n_section')], pageRun)).toBeNull();
    expect(checkAuthority(s, [op('n_section')], { kind: 'page', pageId: 'pg_other', label: 'About' })).not.toBeNull();
  });

  it('keeps a component run off its design’s root', () => {
    const { s, split } = project();
    const own = { kind: 'component' as const, id: split };
    const root = s.components[split].tree!.rootIds[0];
    const run: Authority = { kind: 'component', definitionId: split, label: 'the Split design' };
    expect(checkAuthority(s, [{ type: 'node.removeKeepContent', owner: own, nodeId: root }], run)).toMatch(/^node\.removeKeepContent: The first top-level node of the Split design is its root/);
  });

  it('reports the removal by the name the element had, and that what it held stays', () => {
    const { s } = filled(inGrid);
    const op: EditOperation = { type: 'node.removeKeepContent', owner: page(s), nodeId: 'n_split' };
    const r = apply(s, [op]);
    const [change] = describeOps([op], s, r.state, r.results);
    expect(change.label).toBe('Removed Split from Home, keeping what it held');
    expect(change.nodeId).toBe('n_heading');
    // What took its place, removed later in the run, is not linked to: the next of it still there is.
    const gone: EditOperation = { type: 'node.remove', owner: page(s), nodeId: 'n_heading' };
    const later = apply(r.state, [gone]);
    expect(describeOps([op, gone], s, later.state, [...r.results, ...later.results])[0].nodeId).toBe('n_card');
  });
});
