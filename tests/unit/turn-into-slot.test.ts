/**
 * Turn into slot (#659): a container of a project component's design becomes a slot in one change. The container
 * stays, with its tag and styles; its children give way to the slot's outlet, and either move into every placement's
 * new slot, each placement keeping what it showed, or go, leaving the slot empty. Containers that can't safely become a
 * slot say why.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, ElementNode, GraphNode, InstanceNode, OwnerRef, ProjectState, TextNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { containerToSlotProblem } from '@engine/container-to-slot';
import { blocksSaving, validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { foundationDesign } from './fixtures/packs';
import { contentSection } from './fixtures/inspector-workflows-designs';
import { dropListSpecs } from '../../src/renderer/src/lib/insert-drop';
import { defaultSlotLabel, turnIntoSlotItem, turnIntoSlotOp, turnIntoSlotPreflight, turnIntoSlotScope, turnIntoSlotTarget } from '../../src/renderer/src/lib/turn-into-slot';

const run = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const named = (def: ComponentDefinition, name: string): GraphNode => Object.values(def.tree!.nodes).find((n) => n.name === name)!;
const toSlot = (definitionId: string, nodeId: string, keep: 'placements' | 'none', slot = 'sideColumn', label = 'Side column'): EditOperation => ({
  type: 'component.containerToSlot',
  definitionId,
  nodeId,
  slot,
  label,
  keep
});

/**
 * Home holds a Section with a two-column Row built on the page: Main column (a heading and a paragraph) and Side
 * column (a heading and a paragraph). Create component makes the Row a Split component, which takes the Row's place;
 * a second Split beside it shows other opening hours.
 */
function split() {
  const start = createStarterState('blank', 'Bakery', false);
  const page: OwnerRef = { kind: 'page', id: start.site.homePageId };
  let s = start;
  const id = (ops: EditOperation[]) => {
    const r = run(s, ops);
    s = r.state;
    return r.results.map((x) => x.nodeId as string);
  };
  const [section] = id([{ type: 'node.insert', owner: page, parentId: null, componentId: 'layout.section' }]);
  const [row] = id([{ type: 'node.insert', owner: page, parentId: section, slot: 'content', primitive: 'row' }]);
  const [main, side] = id([
    { type: 'node.insert', owner: page, parentId: row, primitive: 'stack' },
    { type: 'node.insert', owner: page, parentId: row, primitive: 'stack' }
  ]);
  id([
    { type: 'node.rename', owner: page, nodeId: row, name: 'Split' },
    { type: 'node.rename', owner: page, nodeId: main, name: 'Main column' },
    { type: 'node.rename', owner: page, nodeId: side, name: 'Side column' },
    { type: 'node.insert', owner: page, parentId: main, primitive: 'heading', text: 'Welcome' },
    { type: 'node.insert', owner: page, parentId: main, primitive: 'paragraph', text: 'Fresh bread daily' },
    { type: 'node.insert', owner: page, parentId: side, primitive: 'heading', text: 'Opening hours' },
    { type: 'node.insert', owner: page, parentId: side, primitive: 'paragraph', text: 'Mon to Fri, 8 to 6' },
    { type: 'node.setStyle', owner: page, nodeId: side, scope: 'base', property: 'paddingBlock', value: { token: 'space.lg' } }
  ]);
  const made = run(s, [{ type: 'component.createFromNode', owner: page, nodeId: row, name: 'Split' }]);
  s = made.state;
  const defId = made.results[0].definitionId as string;
  const first = made.results[0].nodeId as string;
  const def = s.components[defId];
  const sideText = Object.values(def.tree!.nodes).filter((n): n is TextNode => n.kind === 'text' && subtreeOf(def, named(def, 'Side column').id).includes(n.id));
  // The side column's heading and paragraph read two of Split's properties now; the second Split shows its own.
  const props = Object.fromEntries(sideText.map((t) => [(t.text as { $prop: string }).$prop, t.tag === 'p' ? 'Sat, 9 to 1' : 'Weekend hours']));
  const [second] = id([{ type: 'node.insert', owner: page, parentId: section, slot: 'content', definitionId: defId, props }]);
  return { s, page, defId, section, first, second, side: named(s.components[defId], 'Side column').id };
}

function subtreeOf(def: ComponentDefinition, nodeId: string): string[] {
  const n = def.tree!.nodes[nodeId];
  return [nodeId, ...(n?.kind === 'element' ? n.children.flatMap((c) => subtreeOf(def, c)) : [])];
}

const placement = (s: ProjectState, page: OwnerRef, nodeId: string) => s.pages[page.id].nodes[nodeId] as InstanceNode;
/** What a placement holds in a slot, each node as its words (or kind). */
const words = (s: ProjectState, page: OwnerRef, inst: string, slot = 'sideColumn') =>
  (placement(s, page, inst).slots?.[slot] ?? []).map((id) => {
    const n = s.pages[page.id].nodes[id];
    return n.kind === 'text' ? `${n.tag}: ${n.text}` : n.kind;
  });

describe('Turn into slot (#659)', () => {
  it('turns a column of a component made on the page into a slot, each placement keeping what its column showed', async () => {
    const t = split();
    const before = t.s.components[t.defId];
    const column = before.tree!.nodes[t.side] as ElementNode;
    const r = run(t.s, [toSlot(t.defId, t.side, 'placements')]);
    const s = r.state;
    const def = s.components[t.defId];
    // The container stays as it was, holding the outlet alone.
    const kept = def.tree!.nodes[t.side] as ElementNode;
    expect({ ...kept, children: [] }).toEqual({ ...column, children: [] });
    expect(kept.children).toEqual([r.results[0].nodeId]);
    expect(def.tree!.nodes[kept.children[0]]).toEqual({ id: kept.children[0], kind: 'slot', slot: 'sideColumn' });
    expect(def.slots).toEqual({ sideColumn: { label: 'Side column' } });
    expect(r.results[0]).toMatchObject({ definitionId: t.defId, slot: 'sideColumn', filled: 2 });
    // Its old content is gone from the design, with the parts on it; the properties it read stay, and so do their values.
    for (const id of column.children) expect(def.tree!.nodes[id]).toBeUndefined();
    expect(Object.values(def.parts).every((p) => !!def.tree!.nodes[p.nodeId])).toBe(true);
    expect(Object.keys(def.properties)).toEqual(Object.keys(before.properties));
    // Each placement has its own copy, as it showed it, with the words as plain text.
    expect(words(s, t.page, t.first)).toEqual(['h2: Opening hours', 'p: Mon to Fri, 8 to 6']);
    expect(words(s, t.page, t.second)).toEqual(['h2: Weekend hours', 'p: Sat, 9 to 1']);
    const a = placement(s, t.page, t.first).slots!.sideColumn;
    const b = placement(s, t.page, t.second).slots!.sideColumn;
    expect(new Set([...a, ...b]).size).toBe(4);
    expect(errors(s)).toEqual([]);
    // The page reads the same: each column once, as before.
    const html = await renderHome(s);
    for (const text of ['Opening hours', 'Mon to Fri, 8 to 6', 'Weekend hours', 'Sat, 9 to 1']) expect(html.split(text)).toHaveLength(2);
    expect(html.split('Welcome')).toHaveLength(3);
    // Editing one copy leaves the other as it was.
    const edited = run(s, [{ type: 'node.setContent', owner: t.page, nodeId: a[0], field: 'text', value: 'Hours' }]).state;
    expect(words(edited, t.page, t.second)).toEqual(['h2: Weekend hours', 'p: Sat, 9 to 1']);
  });

  it('exposes the new slot of every placement as a drop target at once', () => {
    const t = split();
    for (const keep of ['placements', 'none'] as const) {
      const s = run(t.s, [toSlot(t.defId, t.side, keep)]).state;
      const lists = dropListSpecs(s, t.page);
      for (const inst of [t.first, t.second]) {
        const list = lists.find((l) => l.parentId === inst);
        expect(list).toMatchObject({ slot: 'sideColumn', childIds: placement(s, t.page, inst).slots?.sideColumn ?? [] });
        expect(list?.refused).toBeUndefined();
      }
    }
  });

  it('leaves the slot empty everywhere when the content is not kept', () => {
    const t = split();
    const column = t.s.components[t.defId].tree!.nodes[t.side] as ElementNode;
    const r = run(t.s, [toSlot(t.defId, t.side, 'none')]);
    const s = r.state;
    expect(r.results[0]).toMatchObject({ filled: 0 });
    const def = s.components[t.defId];
    expect((def.tree!.nodes[t.side] as ElementNode).children.map((c) => def.tree!.nodes[c])).toEqual([{ id: r.results[0].nodeId, kind: 'slot', slot: 'sideColumn' }]);
    expect(def.slots).toEqual({ sideColumn: { label: 'Side column' } });
    for (const id of column.children) expect(s.components[t.defId].tree!.nodes[id]).toBeUndefined();
    expect(placement(s, t.page, t.first).slots).toBeUndefined();
    expect(placement(s, t.page, t.second).slots).toBeUndefined();
    // Nothing moved onto the page.
    expect(Object.keys(s.pages[t.page.id].nodes).sort()).toEqual(Object.keys(t.s.pages[t.page.id].nodes).sort());
    expect(errors(s)).toEqual([]);
  });

  it('carries a placement’s own style change to a part it moves, and its look’s rules, into its copy', () => {
    const t = split();
    const def = t.s.components[t.defId];
    const heading = (def.tree!.nodes[t.side] as ElementNode).children[0];
    const partId = Object.entries(def.parts).find(([, p]) => p.nodeId === heading)![0];
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    let s = run(t.s, [
      { type: 'component.setVariant', definitionId: t.defId, axis: 'tone', axisLabel: 'Tone', variant: 'loud', label: 'Loud' },
      { type: 'node.setStyle', owner, nodeId: heading, variant: 'loud', axis: 'tone', scope: 'base', property: 'textTransform', value: 'uppercase' },
      { type: 'node.setStyle', owner: t.page, nodeId: t.first, partId, scope: 'base', property: 'textAlign', value: 'center' },
      { type: 'instance.setVariant', owner: t.page, nodeId: t.second, axis: 'tone', variant: 'loud' }
    ]).state;
    expect(placement(s, t.page, t.first).overrides?.[partId]).toBeTruthy();
    s = run(s, [toSlot(t.defId, t.side, 'placements')]).state;
    const copy = (inst: string) => s.pages[t.page.id].nodes[placement(s, t.page, inst).slots!.sideColumn[0]];
    expect(copy(t.first).styles?.base).toMatchObject({ textAlign: 'center' });
    expect(copy(t.first).styles?.base?.textTransform).toBeUndefined();
    expect(copy(t.second).styles?.base).toMatchObject({ textTransform: 'uppercase' });
    expect(copy(t.second).styles?.base?.textAlign).toBeUndefined();
    // The part, its placement styles and the look's rule for it went with the design's heading.
    const after = s.components[t.defId];
    expect(after.parts[partId]).toBeUndefined();
    expect(placement(s, t.page, t.first).overrides?.[partId]).toBeUndefined();
    expect(after.variantAxes!.tone.options.loud.styles?.[heading]).toBeUndefined();
    expect(errors(s)).toEqual([]);
  });

  it('gives each placement only what its settings show', () => {
    const t = split();
    const def = t.s.components[t.defId];
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const paragraph = (def.tree!.nodes[t.side] as ElementNode).children[1];
    let s = run(t.s, [
      { type: 'component.setPropSchema', definitionId: t.defId, prop: 'showHours', schema: { type: 'boolean', label: 'Show hours', default: true } },
      { type: 'node.setBinding', owner, nodeId: paragraph, field: 'when', binding: { $prop: 'showHours' } },
      { type: 'instance.setProp', owner: t.page, nodeId: t.second, prop: 'showHours', value: false }
    ]).state;
    s = run(s, [toSlot(t.defId, t.side, 'placements')]).state;
    expect(words(s, t.page, t.first)).toEqual(['h2: Opening hours', 'p: Mon to Fri, 8 to 6']);
    expect(words(s, t.page, t.second)).toEqual(['h2: Weekend hours']);
    expect(s.pages[t.page.id].nodes[placement(s, t.page, t.first).slots!.sideColumn[1]].when).toBeUndefined();
  });

  it('can turn the design’s root into a slot, which stays the root', () => {
    const t = split();
    const root = t.s.components[t.defId].tree!.rootIds[0];
    const s = run(t.s, [toSlot(t.defId, root, 'none', 'content', 'Content')]).state;
    const def = s.components[t.defId];
    expect(def.tree!.rootIds).toEqual([root]);
    expect((def.tree!.nodes[root] as ElementNode).children.map((c) => def.tree!.nodes[c].kind)).toEqual(['slot']);
    expect(def.parts.root.nodeId).toBe(root);
    expect(errors(s)).toEqual([]);
  });

  it('turns an empty container into an empty slot', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const root = t.s.components[t.defId].tree!.rootIds[0];
    const made = run(t.s, [{ type: 'node.insert', owner, parentId: root, primitive: 'container' }]);
    const box = made.results[0].nodeId as string;
    const s = run(made.state, [toSlot(t.defId, box, 'placements', 'extra', 'Extra')]).state;
    const def = s.components[t.defId];
    expect((def.tree!.nodes[box] as ElementNode).children.map((c) => def.tree!.nodes[c])).toMatchObject([{ kind: 'slot', slot: 'extra' }]);
    expect(def.slots?.extra).toEqual({ label: 'Extra' });
    expect(placement(s, t.page, t.first).slots).toBeUndefined();
    expect(placement(s, t.page, t.second).slots).toBeUndefined();
  });
});

describe('Turn into slot refuses (#659)', () => {
  /** A refused change, with the project left as it was. */
  const refused = (s: ProjectState, op: EditOperation): string => {
    const copy = structuredClone(s);
    let message = '';
    try {
      run(s, [op]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(s).toEqual(copy);
    return message;
  };

  it('a container that holds a list or a slot, or sits in one, and says why', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const def = t.s.components[t.defId];
    const main = named(def, 'Main column').id;
    const listed = run(t.s, [
      { type: 'component.setPropSchema', definitionId: t.defId, prop: 'items', schema: { type: 'list', label: 'Items', itemLabel: 'Item', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] } },
      { type: 'node.insert', owner, parentId: main, primitive: 'repeat', bind: 'items' }
    ]);
    const repeat = listed.results[1].nodeId as string;
    expect(refused(listed.state, toSlot(t.defId, main, 'none'))).toBe('“Main column” holds a list, which can’t become part of a slot. Pick a container that holds no list.');
    expect(containerToSlotProblem(listed.state, listed.state.components[t.defId], main)).toMatch(/holds a list/);
    const inList = run(listed.state, [{ type: 'node.insert', owner, parentId: repeat, primitive: 'stack' }]);
    expect(refused(inList.state, toSlot(t.defId, inList.results[0].nodeId as string, 'none'))).toBe('“Stack” is repeated by a list, so a slot there would show once for every item.');
    const slotted = run(t.s, [
      { type: 'component.setSlot', definitionId: t.defId, slot: 'extra', label: 'Extra' },
      { type: 'node.insert', owner, parentId: t.side, primitive: 'slot', bind: 'extra' }
    ]).state;
    expect(refused(slotted, toSlot(t.defId, t.side, 'none'))).toBe('“Side column” already holds the “Extra” slot. Pick a container that holds no slot.');
  });

  it('what isn’t a container of a project component', () => {
    const t = split();
    const def = t.s.components[t.defId];
    const heading = (def.tree!.nodes[t.side] as ElementNode).children[0];
    expect(refused(t.s, toSlot(t.defId, heading, 'none'))).toMatch(/^Pick a container/);
    // A design built in the editor that Foundation installed is the theme's, not the project's to change.
    const section = foundationDesign(contentSection());
    const withTheme = { ...t.s, components: { ...t.s.components, [section.id]: section } };
    expect(refused(withTheme, toSlot(section.id, section.tree!.rootIds[0], 'none'))).toMatch(/belongs to the theme/);
  });

  it('a container whose own behaviour depends on what it holds', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const hides = run(t.s, [{ type: 'node.setContent', owner, nodeId: t.side, field: 'collapseEmpty', value: true }]).state;
    expect(refused(hides, toSlot(t.defId, t.side, 'none'))).toMatch(/hides while everything in it is hidden.*Turn off Hide when empty first\.$/);
    const nav = run(t.s, [{ type: 'node.setContent', owner, nodeId: t.side, field: 'tag', value: 'nav' }]).state;
    expect(refused(nav, toSlot(t.defId, t.side, 'none'))).toMatch(/takes its accessible name from the heading it starts with/);
    const pictured = run(t.s, [
      { type: 'node.insert', owner, parentId: t.side, primitive: 'image' },
      { type: 'node.setContent', owner, nodeId: t.side, field: 'action', value: 'image' }
    ]).state;
    expect(refused(pictured, toSlot(t.defId, t.side, 'none'))).toMatch(/opens the image in “Side column” full size/);
  });

  it('a name the component already uses, or none', () => {
    const t = split();
    const prop = Object.keys(t.s.components[t.defId].properties)[0];
    expect(refused(t.s, toSlot(t.defId, t.side, 'none', prop))).toBe(`“Split” already uses the name "${prop}". Choose another.`);
    expect(refused(t.s, toSlot(t.defId, t.side, 'none', 'Side column'))).toMatch(/camelCase/);
    expect(refused(t.s, toSlot(t.defId, t.side, 'none', 'sideColumn', '   '))).toBe('Enter a name for the slot.');
  });

  it('moving content that reads the component’s UI state, or into a placement inside another design', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const heading = (t.s.components[t.defId].tree!.nodes[t.side] as ElementNode).children[0];
    const stateful = run(t.s, [
      { type: 'component.setState', definitionId: t.defId, state: 'open', schema: { type: 'boolean', label: 'Open', initial: true } },
      { type: 'node.setBinding', owner, nodeId: heading, field: 'when', binding: { $state: 'open' } }
    ]).state;
    expect(refused(stateful, toSlot(t.defId, t.side, 'placements'))).toMatch(/reads or changes the UI state of “Split”.*Choose an empty slot/);
    // An empty slot is still possible.
    expect(run(stateful, [toSlot(t.defId, t.side, 'none')]).results[0]).toMatchObject({ filled: 0 });
    const shelf = run(t.s, [{ type: 'component.upsert', name: 'Shelf', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section', children: [] }] }]);
    const shelfId = shelf.results[0].definitionId as string;
    const nested = run(shelf.state, [{ type: 'node.insert', owner: { kind: 'component', id: shelfId }, parentId: 'root', definitionId: t.defId }]).state;
    expect(refused(nested, toSlot(t.defId, t.side, 'placements'))).toMatch(/^“Shelf” places “Split” in its design/);
  });

  it('a container that shows only while a slot is empty, here or in a component placed in the design', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const root = t.s.components[t.defId].tree!.rootIds[0];
    // Fallback content of the design's own slot.
    const own = structuredClone(t.s);
    const d = own.components[t.defId];
    d.slots = { extra: { label: 'Extra' } };
    (d.tree!.nodes[root] as ElementNode).children.push('outlet');
    d.tree!.nodes.outlet = { id: 'outlet', kind: 'slot', slot: 'extra', children: ['spare'] };
    d.tree!.nodes.spare = { id: 'spare', kind: 'element', tag: 'div', name: 'Spare', children: [] };
    expect(refused(own, toSlot(t.defId, 'spare', 'none'))).toBe('“Spare” is what the “Extra” slot shows while it is empty, so a slot there would show only then.');
    // A component placed in the design shows its Body twice while its Aside is empty: once more from Aside's fallback.
    const shelf = run(t.s, [
      {
        type: 'component.upsert',
        name: 'Shelf',
        properties: {},
        slots: { body: { label: 'Body' }, aside: { label: 'Aside' } },
        nodes: [
          { kind: 'element', id: 'root', tag: 'div', children: ['body', 'aside'] },
          { kind: 'slot', id: 'body', slot: 'body' },
          { kind: 'slot', id: 'aside', slot: 'aside' }
        ]
      }
    ]);
    const shelfId = shelf.results[0].definitionId as string;
    const placed = run(shelf.state, [{ type: 'node.insert', owner, parentId: root, definitionId: shelfId }]);
    const inner = placed.results[0].nodeId as string;
    const held = run(placed.state, [{ type: 'node.insert', owner, parentId: inner, slot: 'body', primitive: 'stack' }]);
    const stack = held.results[0].nodeId as string;
    expect(containerToSlotProblem(held.state, held.state.components[t.defId], stack)).toBeNull();
    const twice = structuredClone(held.state);
    const sd = twice.components[shelfId].tree!;
    (sd.nodes.aside as { children?: string[] }).children = ['body2'];
    sd.nodes.body2 = { id: 'body2', kind: 'slot', slot: 'body' };
    expect(containerToSlotProblem(twice, twice.components[t.defId], stack)).toBe('“Stack” is in a slot of a component placed in the design that doesn’t show it exactly once.');
    // Shown only from Aside's fallback, Body shows only while Aside is left empty: not exactly once either.
    const sometimes = structuredClone(twice);
    const tree = sometimes.components[shelfId].tree!;
    (tree.nodes.root as ElementNode).children = ['aside'];
    delete tree.nodes.body;
    expect(containerToSlotProblem(sometimes, sometimes.components[t.defId], stack)).toBe('“Stack” is in a slot of a component placed in the design that doesn’t show it exactly once.');
  });

  it('a navigation region only while a heading names it, as the site names it', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const heading = (t.s.components[t.defId].tree!.nodes[t.side] as ElementNode).children[0];
    const nav = run(t.s, [{ type: 'node.setContent', owner, nodeId: t.side, field: 'tag', value: 'nav' }]).state;
    expect(containerToSlotProblem(nav, nav.components[t.defId], t.side)).toMatch(/takes its accessible name/);
    // A top-level heading never names a navigation region, nor does one with a name of its own set.
    const h1 = run(nav, [{ type: 'node.setContent', owner, nodeId: heading, field: 'tag', value: 'h1' }]).state;
    expect(containerToSlotProblem(h1, h1.components[t.defId], t.side)).toBeNull();
    const labelled = run(nav, [{ type: 'node.setContent', owner, nodeId: t.side, field: 'ariaLabel', value: 'Hours' }]).state;
    expect(containerToSlotProblem(labelled, labelled.components[t.defId], t.side)).toBeNull();
    // Nor one that can be hidden.
    const hidden = structuredClone(nav);
    (hidden.components[t.defId].tree!.nodes[heading] as TextNode).unless = { $prop: Object.keys(hidden.components[t.defId].properties)[0] };
    expect(containerToSlotProblem(hidden, hidden.components[t.defId], t.side)).toBeNull();
    // A level chosen through an object's field still names it, as the site names it.
    const levelled = structuredClone(nav);
    const ld = levelled.components[t.defId];
    ld.properties.title = { type: 'object', label: 'Title', fields: { level: { type: 'enum', label: 'Level', default: 'h2', options: [{ value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' }] } } } as never;
    (ld.tree!.nodes[heading] as TextNode).tag = { $prop: 'title', field: 'level' } as never;
    expect(containerToSlotProblem(levelled, ld, t.side)).toMatch(/takes its accessible name/);
  });

  it('a name a placement still keeps content under, or an outlet the design has', () => {
    const t = split();
    const kept = structuredClone(t.s);
    placement(kept, t.page, t.second).slots = { sideColumn: [] };
    expect(refused(kept, toSlot(t.defId, t.side, 'none'))).toBe('“Split” already uses the name "sideColumn". Choose another.');
    const outlet = structuredClone(t.s);
    const d = outlet.components[t.defId];
    (d.tree!.nodes[d.tree!.rootIds[0]] as ElementNode).children.push('stray');
    d.tree!.nodes.stray = { id: 'stray', kind: 'slot', slot: 'sideColumn' };
    expect(refused(outlet, toSlot(t.defId, t.side, 'none'))).toBe('“Split” already uses the name "sideColumn". Choose another.');
    expect(turnIntoSlotOp(outlet, d, t.side, 'Side column', 'none')!.slot).toBe('sideColumn2');
  });

  it('moving a list the site fills in, which would stop following the site', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const paragraph = (t.s.components[t.defId].tree!.nodes[t.side] as ElementNode).children[1];
    const fed = run(t.s, [
      { type: 'component.setPropSchema', definitionId: t.defId, prop: 'news', schema: { type: 'list', label: 'News', itemLabel: 'Story', feed: 'articles', fields: { title: { type: 'string', label: 'Title' } } } },
      { type: 'node.setBinding', owner, nodeId: paragraph, field: 'when', binding: { $prop: 'news' } }
    ]).state;
    expect(refused(fed, toSlot(t.defId, t.side, 'placements'))).toBe('“Side column” shows “News”, which the site fills in wherever “Split” is placed, so a fixed copy of it can’t stand in each placement. Choose an empty slot instead.');
    expect(run(fed, [toSlot(t.defId, t.side, 'none')]).results[0]).toMatchObject({ filled: 0 });
  });

  it('moving content that follows a hover group around the container, in the look a placement shows', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const heading = (t.s.components[t.defId].tree!.nodes[t.side] as ElementNode).children[0];
    const grouped = run(t.s, [
      { type: 'node.setContent', owner, nodeId: t.side, field: 'interactionGroup', value: true },
      { type: 'component.setVariant', definitionId: t.defId, axis: 'tone', axisLabel: 'Tone', variant: 'loud', label: 'Loud' },
      { type: 'node.setStyle', owner, nodeId: heading, variant: 'loud', axis: 'tone', scope: 'base', state: 'groupHover', property: 'opacity', value: 0.5 }
    ]).state;
    // No placement shows the loud look, so no copy needs the group.
    expect(run(grouped, [toSlot(t.defId, t.side, 'placements')]).results[0]).toMatchObject({ filled: 2 });
    const loud = run(grouped, [{ type: 'instance.setVariant', owner: t.page, nodeId: t.second, axis: 'tone', variant: 'loud' }]).state;
    expect(refused(loud, toSlot(t.defId, t.side, 'placements'))).toMatch(/^“Heading 2” has styles for while its card is hovered or has focus, from an interaction group around “Side column”/);
  });

  it('moving an anchor a page already uses elsewhere', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const heading = (t.s.components[t.defId].tree!.nodes[t.side] as ElementNode).children[0];
    const anchored = run(t.s, [{ type: 'node.setContent', owner, nodeId: heading, field: 'anchor', value: 'hours' }]).state;
    // Two placements on Home: the second copy can't take the anchor the first one keeps.
    expect(refused(anchored, toSlot(t.defId, t.side, 'placements'))).toBe('Home already uses the anchor “hours”, which “Heading 2” would take there. Rename one of them first, or choose an empty slot.');
    const one = run(anchored, [{ type: 'node.remove', owner: t.page, nodeId: t.second }]).state;
    // An element of the page itself that holds it already: a heading in the Section's content.
    const placedHeading = run(one, [{ type: 'node.insert', owner: t.page, parentId: t.section, slot: 'content', primitive: 'heading', text: 'Hours' }]);
    const taken = run(placedHeading.state, [{ type: 'node.setContent', owner: t.page, nodeId: placedHeading.results[0].nodeId as string, field: 'anchor', value: 'hours' }]).state;
    expect(refused(taken, toSlot(t.defId, t.side, 'placements'))).toBe('Home already uses the anchor “hours”, which “Heading 2” would take there. Rename one of them first, or choose an empty slot.');
    const s = run(one, [toSlot(t.defId, t.side, 'placements')]).state;
    expect(s.pages[t.page.id].nodes[placement(s, t.page, t.first).slots!.sideColumn[0]].anchor).toBe('hours');
  });
});

describe('Turn into slot… in the editor (#659)', () => {
  const ref = (owner: OwnerRef, nodeId: string, instancePath: string[] = []) => ({ owner, instancePath, nodeId });

  it('is offered on a container of a project component’s own design, and unavailable with the reason where it can’t act', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const def = t.s.components[t.defId];
    const target = turnIntoSlotTarget({ state: t.s }, ref(owner, t.side));
    expect(target).toEqual({ ref: ref(owner, t.side), problem: null });
    const opened: unknown[] = [];
    turnIntoSlotItem(target!, (r) => opened.push(r)).onSelect!();
    expect(opened).toEqual([ref(owner, t.side)]);
    // Not offered on what isn't a container of the design, on a placement's page, or in a project open read-only.
    const heading = (def.tree!.nodes[t.side] as ElementNode).children[0];
    expect(turnIntoSlotTarget({ state: t.s }, ref(owner, heading))).toBeNull();
    expect(turnIntoSlotTarget({ state: t.s }, ref(t.page, t.side, [t.first]))).toBeNull();
    expect(turnIntoSlotTarget({ state: t.s }, ref(t.page, t.section))).toBeNull();
    expect(turnIntoSlotTarget({ state: t.s, readOnly: true }, ref(owner, t.side))).toBeNull();
    // A container that can't become a slot stays in the menu, unavailable, saying why.
    const hides = run(t.s, [{ type: 'node.setContent', owner, nodeId: t.side, field: 'collapseEmpty', value: true }]).state;
    const refused = turnIntoSlotTarget({ state: hides }, ref(owner, t.side))!;
    expect(refused.problem).toMatch(/Turn off Hide when empty first/);
    expect(turnIntoSlotItem(refused, () => {})).toEqual({ label: 'Turn into slot…', disabled: true, description: refused.problem, ariaLabel: 'Turn into slot…' });
  });

  it('names the slot after the container, under a name of its own', () => {
    const t = split();
    const def = t.s.components[t.defId];
    expect(defaultSlotLabel(def, t.side)).toBe('Side column');
    expect(defaultSlotLabel(def, def.tree!.rootIds[0])).toBe('Split');
    const unnamed = run(t.s, [{ type: 'node.rename', owner: { kind: 'component', id: t.defId }, nodeId: t.side, name: '' }]).state;
    expect(defaultSlotLabel(unnamed.components[t.defId], t.side)).toBe('Content');
    expect(turnIntoSlotOp(t.s, def, t.side, '  Side column ', 'placements')).toEqual({ type: 'component.containerToSlot', definitionId: t.defId, nodeId: t.side, slot: 'sideColumn', label: 'Side column', keep: 'placements' });
    expect(turnIntoSlotOp(t.s, def, t.side, '   ', 'none')).toBeNull();
    // A name a property already has gets a number no property has.
    const prop = Object.keys(def.properties)[0];
    const numbered = turnIntoSlotOp(t.s, def, t.side, prop, 'none')!.slot;
    expect(numbered).toMatch(new RegExp(`^${prop}\\d+$`));
    expect(Object.keys(def.properties)).not.toContain(numbered);
    expect(turnIntoSlotScope(t.s, def, t.side)).toEqual({ children: 2, placements: 2, code: [] });
  });

  it('says before the change why a move would be refused, and lets the empty slot through', () => {
    const t = split();
    const owner: OwnerRef = { kind: 'component', id: t.defId };
    const heading = (t.s.components[t.defId].tree!.nodes[t.side] as ElementNode).children[0];
    const s = run(t.s, [{ type: 'node.setContent', owner, nodeId: heading, field: 'anchor', value: 'hours' }]).state;
    const def = s.components[t.defId];
    expect(turnIntoSlotPreflight(s, turnIntoSlotOp(s, def, t.side, 'Side column', 'placements')!)).toMatch(/^Home already uses the anchor “hours”/);
    expect(turnIntoSlotPreflight(s, turnIntoSlotOp(s, def, t.side, 'Side column', 'none')!)).toBeNull();
    expect(turnIntoSlotPreflight(t.s, turnIntoSlotOp(t.s, t.s.components[t.defId], t.side, 'Side column', 'placements')!)).toBeNull();
  });
});

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render the exported Home page. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'turn-into-slot-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
}
