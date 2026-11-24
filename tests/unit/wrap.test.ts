import { describe, expect, it } from 'vitest';
import type { ElementNode, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, ungroupRefusal } from '@engine/apply';
import { validateState } from '@engine/validate';
import { validateOperation } from '@shared/ops';
import { checkAuthority, OP_REACH, type Authority } from '@agent/scope';

// Wrap in Stack, Row or Grid, and Ungroup (#386): one operation each, so one change and one Undo, that keeps what it
// moves (IDs, styles, bindings) and a component's one root, measures a slot before it, and refuses what it can't do.

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const page = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);

/** A blank site with a Section on Home holding a heading, two buttons and a paragraph, and a second Section after it. */
function twoButtons() {
  let s = createStarterState('blank', 'Blank', false);
  const r = apply(s, [
    { type: 'node.insert', newNodeId: 'n_section', owner: page(s), componentId: 'layout.section' },
    { type: 'node.insert', newNodeId: 'n_heading', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'heading', text: 'Visit us' },
    { type: 'node.insert', newNodeId: 'n_book', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'button', text: 'Book' },
    { type: 'node.insert', newNodeId: 'n_call', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'button', text: 'Call' },
    { type: 'node.insert', newNodeId: 'n_after', owner: page(s), parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'Open daily' },
    { type: 'node.setStyle', owner: page(s), nodeId: 'n_call', scope: 'tablet', property: 'paddingBlock', value: { token: 'space.sm' } },
    { type: 'node.insert', newNodeId: 'n_other', owner: page(s), componentId: 'layout.section' }
  ]);
  s = r.state;
  return s;
}
const content = (s: ProjectState, id = 'n_section') => (home(s).nodes[id] as InstanceNode).slots!.content;

describe('Wrap and Ungroup on a page', () => {
  it('wraps two buttons in a Row where they are, then Ungroup puts the page back exactly', () => {
    const s = twoButtons();
    const before = JSON.stringify(home(s));
    // Named in either order, they keep the order they had.
    const wrapped = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_call', 'n_book'], primitive: 'row' }]);
    const row = wrapped.results[0].nodeId as string;
    expect(content(wrapped.state)).toEqual(['n_heading', row, 'n_after']);
    const node = home(wrapped.state).nodes[row] as ElementNode;
    expect(node).toMatchObject({ kind: 'element', tag: 'div', children: ['n_book', 'n_call'], styles: { base: { layout: 'row' } } });
    // What it holds is the same, styles and all.
    expect(home(wrapped.state).nodes.n_call).toEqual(home(s).nodes.n_call);
    expect(errors(wrapped.state)).toEqual([]);
    const ungrouped = apply(wrapped.state, [{ type: 'node.unwrap', owner: page(s), nodeIds: [row] }]);
    expect(ungrouped.results[0]).toEqual({ nodeId: 'n_book', nodeIds: ['n_book', 'n_call'] });
    expect(JSON.stringify(home(ungrouped.state))).toBe(before);
  });

  it('wraps one element in a Stack or a Grid, with each container’s own starting layout', () => {
    const s = twoButtons();
    const stack = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_heading'], primitive: 'stack' }]);
    expect(home(stack.state).nodes[stack.results[0].nodeId as string]).toMatchObject({ children: ['n_heading'], styles: { base: { layout: 'stack' } } });
    const grid = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_heading', 'n_book', 'n_call', 'n_after'], primitive: 'grid' }]);
    const g = grid.results[0].nodeId as string;
    expect(content(grid.state)).toEqual([g]);
    expect(home(grid.state).nodes[g]).toMatchObject({ children: ['n_heading', 'n_book', 'n_call', 'n_after'], styles: { base: { layout: 'grid', columns: 1 }, desktop: { columns: 3 } } });
  });

  it('ungroups two containers side by side at once, in order', () => {
    let s = twoButtons();
    const a = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_heading', 'n_book'], primitive: 'stack' }]);
    const b = apply(a.state, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_call', 'n_after'], primitive: 'row' }]);
    s = b.state;
    const r = apply(s, [{ type: 'node.unwrap', owner: page(s), nodeIds: [b.results[0].nodeId as string, a.results[0].nodeId as string] }]);
    expect(content(r.state)).toEqual(['n_heading', 'n_book', 'n_call', 'n_after']);
    expect(Object.keys(home(r.state).nodes)).not.toContain(a.results[0].nodeId);
    expect(Object.keys(home(r.state).nodes)).not.toContain(b.results[0].nodeId);
  });

  it('says without copying the project which containers can be ungrouped, as the menus offer them', () => {
    const s = twoButtons();
    const w = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_book', 'n_call'], primitive: 'row' }]);
    const row = w.results[0].nodeId as string;
    expect(ungroupRefusal(w.state, page(s), [row])).toBeNull();
    expect(ungroupRefusal(w.state, page(s), ['n_heading'])).toMatch(/holds nothing to ungroup/);
    expect(ungroupRefusal(w.state, page(s), ['n_section'])).toMatch(/Sections at the top/);
    const named = apply(w.state, [{ type: 'node.setContent', owner: page(s), nodeId: row, field: 'anchor', value: 'go' }]).state;
    expect(ungroupRefusal(named, page(s), [row])).toMatch(/anchor/);
  });

  it('refuses sections at the top of the page, elements apart or in different places, and names given twice', () => {
    const s = twoButtons();
    const before = JSON.stringify(s);
    const refused: Array<[EditOperation, RegExp]> = [
      [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_section', 'n_other'], primitive: 'stack' }, /Sections at the top of a page can’t be wrapped/],
      [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_heading', 'n_call'], primitive: 'row' }, /next to each other/],
      [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_heading', 'n_other'], primitive: 'row' }, /side by side in one place/],
      [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_book', 'n_book'], primitive: 'row' }, /Name each element once/],
      [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_gone'], primitive: 'row' }, /n_gone/],
      [{ type: 'node.unwrap', owner: page(s), nodeIds: ['n_section'] }, /Sections at the top of a page can’t be ungrouped/],
      [{ type: 'node.unwrap', owner: page(s), nodeIds: ['n_book'] }, /holds nothing to ungroup/]
    ];
    for (const [op, message] of refused) expect(() => apply(s, [op]), JSON.stringify(op)).toThrow(message);
    expect(JSON.stringify(s)).toBe(before);
    expect(validateOperation({ type: 'node.wrap', owner: page(s), nodeIds: [], primitive: 'row' }).ok).toBe(false);
    expect(validateOperation({ type: 'node.wrap', owner: page(s), nodeIds: ['n_book'], primitive: 'container' }).ok).toBe(false);
  });

  it('ungroups only a plain container: not one that links, shows under a condition, is jumped to, is named, or is not a div', () => {
    const s = twoButtons();
    const w = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_book', 'n_call'], primitive: 'row' }]);
    const row = w.results[0].nodeId as string;
    const o = page(s);
    const refusedAfter: Array<[EditOperation, RegExp]> = [
      [{ type: 'node.setContent', owner: o, nodeId: row, field: 'anchor', value: 'actions' }, /by its anchor “actions”/],
      [{ type: 'node.setContent', owner: o, nodeId: row, field: 'ariaLabel', value: 'Actions' }, /accessible name/],
      [{ type: 'node.setContent', owner: o, nodeId: row, field: 'tag', value: 'nav' }, /is a nav element/],
      [{ type: 'node.setContent', owner: o, nodeId: row, field: 'appear', value: 'fade' }, /entrance effect/]
    ];
    for (const [edit, message] of refusedAfter) {
      const marked = apply(w.state, [edit]).state;
      expect(() => apply(marked, [{ type: 'node.unwrap', owner: o, nodeIds: [row] }]), JSON.stringify(edit)).toThrow(message);
    }
    const linked = structuredClone(w.state);
    (home(linked).nodes[row] as ElementNode).link = { type: 'url', target: 'https://example.com' };
    expect(() => apply(linked, [{ type: 'node.unwrap', owner: o, nodeIds: [row] }])).toThrow(/is a link/);
    const shown = structuredClone(w.state);
    (home(shown).nodes[row] as ElementNode).unless = { $prop: 'x' };
    expect(() => apply(shown, [{ type: 'node.unwrap', owner: o, nodeIds: [row] }])).toThrow(/under a condition/);
    // Emptied, it holds nothing to promote.
    const empty = apply(s, [{ type: 'node.insert', newNodeId: 'n_empty', owner: o, parentId: 'n_section', slot: 'content', primitive: 'row' }]).state;
    expect(() => apply(empty, [{ type: 'node.unwrap', owner: o, nodeIds: ['n_empty'] }])).toThrow(/is empty/);
    // A placed component is detached instead.
    const placed = apply(s, [{ type: 'node.insert', newNodeId: 'n_cta', owner: o, parentId: 'n_section', slot: 'content', componentId: 'cta.banner' }]);
    expect(() => apply(placed.state, [{ type: 'node.unwrap', owner: o, nodeIds: ['n_cta'] }])).toThrow(/Use Detach component/);
  });

  it('refuses list items wrapped out of their list, and a block wrapped into a paragraph container', () => {
    let s = twoButtons();
    const o = page(s);
    s = apply(s, [
      { type: 'node.insert', newNodeId: 'n_list', owner: o, parentId: 'n_section', slot: 'content', primitive: 'stack' },
      { type: 'node.setContent', owner: o, nodeId: 'n_list', field: 'tag', value: 'ul' },
      { type: 'node.insert', newNodeId: 'n_li1', owner: o, parentId: 'n_list', primitive: 'stack' },
      { type: 'node.insert', newNodeId: 'n_li2', owner: o, parentId: 'n_list', primitive: 'stack' },
      { type: 'node.setContent', owner: o, nodeId: 'n_li1', field: 'tag', value: 'li' },
      { type: 'node.setContent', owner: o, nodeId: 'n_li2', field: 'tag', value: 'li' }
    ]).state;
    expect(errors(s)).toEqual([]);
    expect(() => apply(s, [{ type: 'node.wrap', owner: o, nodeIds: ['n_li1', 'n_li2'], primitive: 'stack' }])).toThrow(/list item, so it goes directly inside a list/);
    // Buttons in a paragraph container are inline; a Row around them would be a block inside the paragraph.
    const para = apply(s, [
      { type: 'node.insert', newNodeId: 'n_para', owner: o, parentId: 'n_section', slot: 'content', primitive: 'stack' },
      { type: 'node.setContent', owner: o, nodeId: 'n_para', field: 'tag', value: 'p' },
      { type: 'node.move', owner: o, nodeId: 'n_book', parentId: 'n_para', index: 0 },
      { type: 'node.move', owner: o, nodeId: 'n_call', parentId: 'n_para', index: 1 }
    ]).state;
    expect(errors(para)).toEqual([]);
    expect(() => apply(para, [{ type: 'node.wrap', owner: o, nodeIds: ['n_book', 'n_call'], primitive: 'row' }])).toThrow(/inside a paragraph container/);
  });
});

describe('Wrap and Ungroup in a slot with a limit', () => {
  /** The project's own Section, its Content slot taking `primitives` and at most `max`, holding two buttons. */
  function limited(primitives: string[], max: number) {
    const base = twoButtons();
    const s0 = apply(base, [
      { type: 'node.remove', owner: page(base), nodeId: 'n_heading' },
      { type: 'node.remove', owner: page(base), nodeId: 'n_after' }
    ]).state;
    const sectionDef = (home(s0).nodes.n_section as InstanceNode).definitionId;
    const f = apply(s0, [{ type: 'component.fork', definitionId: sectionDef }]);
    const id = f.results[0].definitionId as string;
    // The fork is placed in place of the theme's: move the buttons into a placement of it.
    const r = apply(f.state, [
      { type: 'node.insert', newNodeId: 'n_own', owner: page(s0), definitionId: id },
      { type: 'node.move', owner: page(s0), nodeId: 'n_book', parentId: 'n_own', slot: 'content', index: 0 },
      { type: 'node.move', owner: page(s0), nodeId: 'n_call', parentId: 'n_own', slot: 'content', index: 1 },
      { type: 'component.setSlot', definitionId: id, slot: 'content', label: 'Content', primitives: primitives as never, max }
    ]);
    return { s: r.state, id };
  }

  it('wraps a full slot’s two items in one Row and ungroups them again: one replaces two, never three', () => {
    const { s } = limited(['text', 'link', 'element'], 2);
    const before = JSON.stringify(home(s));
    const w = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_book', 'n_call'], primitive: 'row' }]);
    expect(content(w.state, 'n_own')).toEqual([w.results[0].nodeId]);
    const u = apply(w.state, [{ type: 'node.unwrap', owner: page(s), nodeIds: [w.results[0].nodeId as string] }]);
    expect(JSON.stringify(home(u.state))).toBe(before);
  });

  it('refuses a container in a slot that takes none, and ungrouping more than the slot holds', () => {
    const { s } = limited(['text', 'link'], 2);
    expect(() => apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_book', 'n_call'], primitive: 'row' }])).toThrow(/takes text and buttons, not a container/);
    const one = limited(['text', 'link', 'element'], 2);
    const w = apply(one.s, [{ type: 'node.wrap', owner: page(one.s), nodeIds: ['n_book', 'n_call'], primitive: 'row' }]);
    const tight = apply(w.state, [{ type: 'component.setSlot', definitionId: one.id, slot: 'content', label: 'Content', primitives: ['text', 'link', 'element'], max: 1 }]).state;
    expect(() => apply(tight, [{ type: 'node.unwrap', owner: page(one.s), nodeIds: [w.results[0].nodeId as string] }])).toThrow(/holds at most one item/);
  });

  it('refuses ungrouping what the slot does not take into it', () => {
    const { s } = limited(['link', 'element'], 2);
    const w = apply(s, [{ type: 'node.wrap', owner: page(s), nodeIds: ['n_book', 'n_call'], primitive: 'row' }]);
    const row = w.results[0].nodeId as string;
    // A heading inside the Row is the Row's own; ungrouped, it would be the slot's.
    const held = apply(w.state, [{ type: 'node.insert', owner: page(s), parentId: row, primitive: 'heading' }]).state;
    expect(() => apply(held, [{ type: 'node.unwrap', owner: page(s), nodeIds: [row] }])).toThrow('The “Content” slot of “Section” takes buttons and containers, not text.');
  });
});

describe('Wrap and Ungroup in a component’s design', () => {
  /** The Features grid as the project's own: root > inner > (intro, grid > cards (repeat) > card (li) > icon wrap, title, text, link). */
  function features() {
    const s = createStarterState('business', 'Test Studio', false);
    const placed = home(s).rootIds.map((id) => home(s).nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
    const r = apply(s, [{ type: 'component.fork', definitionId: placed.definitionId }]);
    const id = r.results[0].definitionId as string;
    return { s: r.state, id, own: { kind: 'component' as const, id } };
  }
  const tree = (s: ProjectState, id: string) => s.components[id].tree!;

  it('wraps what a repeated card shows, item fields and all, and ungroups it back exactly', () => {
    const { s, id, own } = features();
    const before = JSON.stringify(s.components[id]);
    const w = apply(s, [{ type: 'node.wrap', owner: own, nodeIds: ['card-title', 'card-text'], primitive: 'stack' }]);
    const stack = w.results[0].nodeId as string;
    expect((tree(w.state, id).nodes.card as ElementNode).children).toEqual(['card-icon-wrap', stack, 'card-link']);
    expect(tree(w.state, id).nodes['card-title']).toEqual(tree(s, id).nodes['card-title']);
    expect(errors(w.state)).toEqual([]);
    const u = apply(w.state, [{ type: 'node.unwrap', owner: own, nodeIds: [stack] }]);
    expect(JSON.stringify(u.state.components[id])).toBe(before);
  });

  it('ungroups a group that hides when empty: what it held hides by itself', () => {
    const { s, id, own } = features();
    expect(tree(s, id).nodes.intro).toMatchObject({ collapseEmpty: true });
    const u = apply(s, [{ type: 'node.unwrap', owner: own, nodeIds: ['intro'] }]);
    expect((tree(u.state, id).nodes.inner as ElementNode).children).toEqual(['eyebrow', 'heading', 'lead', 'grid']);
    expect(u.state.components[id].parts.heading.nodeId).toBe('heading');
    expect(errors(u.state)).toEqual([]);
  });

  it('ungroups a plain container right inside the root, and keeps the parts inside it', () => {
    const { s, id, own } = features();
    const u = apply(s, [{ type: 'node.unwrap', owner: own, nodeIds: ['inner'] }]);
    expect(tree(u.state, id).rootIds).toEqual(['root']);
    expect((tree(u.state, id).nodes.root as ElementNode).children).toEqual(['intro', 'grid']);
    expect(u.state.components[id].parts.grid.nodeId).toBe('grid');
    expect(errors(u.state)).toEqual([]);
  });

  it('refuses the component’s own root, its parts, what its variants style, and list items', () => {
    const { s, id, own } = features();
    const before = JSON.stringify(s.components[id]);
    const refused: Array<[EditOperation, RegExp]> = [
      [{ type: 'node.wrap', owner: own, nodeIds: ['root'], primitive: 'stack' }, /component itself, so it cannot be wrapped/],
      [{ type: 'node.unwrap', owner: own, nodeIds: ['root'] }, /component itself, so it cannot be ungrouped/],
      [{ type: 'node.unwrap', owner: own, nodeIds: ['grid'] }, /is a ul element/],
      [{ type: 'node.unwrap', owner: own, nodeIds: ['card'] }, /is a li element/],
      [{ type: 'node.unwrap', owner: own, nodeIds: ['cards'] }, /once per list item/],
      // The card is a list item: a container around it would take it out of its list.
      [{ type: 'node.wrap', owner: own, nodeIds: ['cards'], primitive: 'stack' }, /directly inside a list/]
    ];
    for (const [op, message] of refused) expect(() => apply(s, [op]), JSON.stringify(op)).toThrow(message);
    const asPart = apply(s, [{ type: 'component.setPart', definitionId: id, partId: 'introBox', nodeId: 'intro', label: 'Intro box' }]).state;
    expect(() => apply(asPart, [{ type: 'node.unwrap', owner: own, nodeIds: ['intro'] }])).toThrow(/“Intro box” part/);
    const styled = structuredClone(s);
    styled.components[id].variantAxes!.tone.options.muted.styles!.inner = { base: { gap: { token: 'space.lg' } } };
    expect(() => apply(styled, [{ type: 'node.unwrap', owner: own, nodeIds: ['inner'] }])).toThrow(/variant styles/);
    expect(JSON.stringify(s.components[id])).toBe(before);
  });

  it('refuses a group hiding while a list inside it is empty, which shows the author where its images go', () => {
    const { s, id, own } = features();
    const t = tree(s, id);
    t.nodes.box = { id: 'box', kind: 'element', tag: 'div', children: ['rep'], collapseEmpty: true };
    t.nodes.rep = { id: 'rep', kind: 'repeat', list: { $prop: 'items' }, children: [] };
    (t.nodes.inner as ElementNode).children.push('box');
    expect(() => apply(s, [{ type: 'node.unwrap', owner: own, nodeIds: ['box'] }])).toThrow(/hides while the list inside it is empty/);
  });

  it('wraps what a group hiding when empty holds in a container that hides with it, so the group still hides', () => {
    const { s, id, own } = features();
    const w = apply(s, [{ type: 'node.wrap', owner: own, nodeIds: ['eyebrow', 'heading', 'lead'], primitive: 'stack' }]);
    expect(tree(w.state, id).nodes[w.results[0].nodeId as string]).toMatchObject({ collapseEmpty: true, children: ['eyebrow', 'heading', 'lead'] });
    expect(errors(w.state)).toEqual([]);
    // On a page nothing hides when empty, and the new container is as Insert makes it.
    const p = twoButtons();
    const pw = apply(p, [{ type: 'node.wrap', owner: page(p), nodeIds: ['n_book'], primitive: 'stack' }]);
    expect(home(pw.state).nodes[pw.results[0].nodeId as string]).not.toHaveProperty('collapseEmpty');
  });

  it('refuses ungrouping what holds a filtered list, or tabs, and wrapping a tab or an item entering in turn', () => {
    const { s, id, own } = features();
    const t = tree(s, id);
    const inner = t.nodes.inner as ElementNode;
    t.nodes.fbox = { id: 'fbox', kind: 'element', tag: 'div', children: ['frep'] };
    t.nodes.frep = { id: 'frep', kind: 'repeat', list: { $prop: 'items' }, filter: { field: 'title' }, children: [] };
    const tab = (id: string, value: string) => ({ id, kind: 'link' as const, link: { type: 'none' as const, target: '' }, label: value, stateAction: { state: 'view', op: 'set' as const, value } });
    t.nodes.tabs = { id: 'tabs', kind: 'element', tag: 'div', children: ['t1', 't2'] };
    t.nodes.t1 = tab('t1', 'a');
    t.nodes.t2 = tab('t2', 'b');
    t.nodes.srep = { id: 'srep', kind: 'repeat', list: { $prop: 'items' }, appearStagger: true, children: ['sitem'] };
    t.nodes.sitem = { id: 'sitem', kind: 'element', tag: 'div', appear: 'fade', children: [] };
    inner.children.push('fbox', 'tabs', 'srep');
    expect(() => apply(s, [{ type: 'node.unwrap', owner: own, nodeIds: ['fbox'] }])).toThrow(/category filter pills/);
    expect(() => apply(s, [{ type: 'node.unwrap', owner: own, nodeIds: ['tabs'] }])).toThrow(/choose what the component shows/);
    expect(() => apply(s, [{ type: 'node.wrap', owner: own, nodeIds: ['t1'], primitive: 'stack' }])).toThrow(/choose what the component shows/);
    expect(() => apply(s, [{ type: 'node.wrap', owner: own, nodeIds: ['sitem'], primitive: 'stack' }])).toThrow(/enters in turn/);
  });

  it('wraps an older design’s top level whole, which gives it its one root', () => {
    const { s, id, own } = features();
    const t = tree(s, id);
    t.nodes.extra = { id: 'extra', kind: 'text', tag: 'p', text: 'Loose' };
    t.rootIds.push('extra');
    const w = apply(s, [{ type: 'node.wrap', owner: own, nodeIds: ['root', 'extra'], primitive: 'stack' }]);
    const holder = w.results[0].nodeId as string;
    expect(tree(w.state, id).rootIds).toEqual([holder]);
    expect(w.state.components[id].parts.root.nodeId).toBe(holder);
    // Its top level gains nothing from an ungroup meanwhile.
    expect(() => apply(s, [{ type: 'node.unwrap', owner: own, nodeIds: ['root'] }])).toThrow(/no single top-level element yet/);
  });
});

describe('Ungroup on a detached component', () => {
  it('ungroups a plain detached container, but not one keeping its design’s tone, which the theme colours its content by', () => {
    let s = createStarterState('blank', 'Blank', false);
    const placed = apply(s, [{ type: 'node.insert', newNodeId: 'n_cta', owner: page(s), componentId: 'cta.banner' }]);
    s = apply(placed.state, [{ type: 'component.detachInstance', owner: page(s), nodeId: 'n_cta' }]).state;
    const nodes = home(s).nodes;
    const byNode = (design: string) => Object.values(nodes).find((n) => n.detachedFrom?.node === design)!;
    const panel = byNode('panel');
    const actions = byNode('actions');
    expect(panel.detachedFrom?.options).toMatchObject({ tone: 'default' });
    expect(() => apply(s, [{ type: 'node.unwrap', owner: page(s), nodeIds: [panel.id] }])).toThrow(/keeps the “tone” look/);
    const u = apply(s, [{ type: 'node.unwrap', owner: page(s), nodeIds: [actions.id] }]);
    expect(home(u.state).nodes[actions.id]).toBeUndefined();
    expect((home(u.state).nodes[panel.id] as ElementNode).children).toEqual(expect.arrayContaining((actions as ElementNode).children));
  });
});

describe('what an assistant run may wrap and ungroup', () => {
  it('reaches nodes, each one checked against the selection, the component or the page', () => {
    expect([OP_REACH['node.wrap'], OP_REACH['node.unwrap']]).toEqual(['node', 'node']);
    const s = twoButtons();
    const o = page(s);
    const selection: Authority = { kind: 'selection', owner: o, nodeId: 'n_section', label: 'the Section' };
    expect(checkAuthority(s, [{ type: 'node.wrap', owner: o, nodeIds: ['n_book', 'n_call'], primitive: 'row' }], selection)).toBeNull();
    // The selected element itself would get a new container around it, outside it.
    expect(checkAuthority(s, [{ type: 'node.wrap', owner: o, nodeIds: ['n_section'], primitive: 'row' }], selection)).toMatch(/what holds the Section/);
    const button: Authority = { kind: 'selection', owner: o, nodeId: 'n_book', label: 'the button' };
    expect(checkAuthority(s, [{ type: 'node.wrap', owner: o, nodeIds: ['n_book', 'n_call'], primitive: 'row' }], button)).toMatch(/outside the button/);
    const pageRun: Authority = { kind: 'page', pageId: s.site.homePageId, label: 'Home' };
    expect(checkAuthority(s, [{ type: 'node.unwrap', owner: o, nodeIds: ['n_book'] }], pageRun)).toBeNull();
    const elsewhere: Authority = { kind: 'page', pageId: 'pg_other', label: 'About' };
    expect(checkAuthority(s, [{ type: 'node.unwrap', owner: o, nodeIds: ['n_book'] }], elsewhere)).not.toBeNull();
  });

  it('keeps a component run inside its design, and off its root', () => {
    const st = createStarterState('business', 'Test Studio', false);
    const placed = home(st).rootIds.map((id) => home(st).nodes[id] as InstanceNode).find((n) => st.components[n.definitionId]?.componentId === 'features.grid')!;
    const f = apply(st, [{ type: 'component.fork', definitionId: placed.definitionId }]);
    const id = f.results[0].definitionId as string;
    const own = { kind: 'component' as const, id };
    const run: Authority = { kind: 'component', definitionId: id, label: 'the Features design' };
    expect(checkAuthority(f.state, [{ type: 'node.wrap', owner: own, nodeIds: ['card-title', 'card-text'], primitive: 'stack' }], run)).toBeNull();
    expect(checkAuthority(f.state, [{ type: 'node.wrap', owner: own, nodeIds: ['root'], primitive: 'stack' }], run)).toMatch(/root/);
    expect(checkAuthority(f.state, [{ type: 'node.unwrap', owner: page(st), nodeIds: [placed.id] }], run)).toMatch(/outside the Features design/);
  });
});
