/**
 * Slots authored in Edit everywhere (#655): a slot is declared and its placeholder placed in one change, inside the
 * selected container or the whole design; its contract changes only where the form changed it; and a contract or a
 * removal that content placements already hold would break is refused by the engine, with that content kept.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { generateProject } from '@generator/index';
import type { ComponentDefinition, ElementNode, ElementRef, InstanceNode, OwnerRef, ProjectState, SlotPrimitive } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { slotAccepts } from '@engine/slots';
import { blocksSaving, validateState } from '@engine/validate';
import { nodeLabel, slotInsertAt } from '../../src/renderer/src/lib/insert-at';
import {
  createSlotOps,
  editSlotOp,
  newSlotName,
  placedSlots,
  rebaseSlotDraft,
  removeSlotOp,
  slotDraft,
  slotDraftProblem,
  slotFilledIn,
  unplacedSlots,
  type SlotDraft
} from '../../src/renderer/src/lib/slot-contract';

const run = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const ref = (owner: OwnerRef, nodeId: string, instancePath: string[] = []): ElementRef => ({ owner, instancePath, nodeId });

/**
 * A blank site with a Profile card of the project's own: a heading, an empty Body container, a paragraph container
 * holding inline text, and a figure whose caption ends it. The card is placed on Home, inside a Section.
 */
function card() {
  const start = createStarterState('blank', 'Slots', false);
  const page: OwnerRef = { kind: 'page', id: start.site.homePageId };
  const made = run(start, [
    {
      type: 'component.upsert',
      name: 'Profile card',
      properties: { subtitle: { type: 'string', label: 'Subtitle', default: 'Maker' } },
      nodes: [
        { kind: 'element', id: 'root', tag: 'article', children: ['title', 'body', 'note', 'fig'] },
        { kind: 'text', id: 'title', tag: 'h3', text: 'Ana Ruiz' },
        { kind: 'element', id: 'body', name: 'Body', children: [] },
        { kind: 'element', id: 'note', name: 'Note', tag: 'p', children: ['noteText'] },
        { kind: 'text', id: 'noteText', tag: 'span', text: 'Glaze and fire' },
        { kind: 'element', id: 'fig', name: 'Photo', tag: 'figure', children: ['pic', 'cap'] },
        { kind: 'image', id: 'pic', image: { assetId: null, alt: '' } },
        { kind: 'text', id: 'cap', tag: 'figcaption', text: 'In the studio' }
      ]
    }
  ]);
  const id = made.results[0].definitionId as string;
  const placed = run(made.state, [{ type: 'node.insert', owner: page, parentId: null, componentId: 'layout.section' }]);
  const section = placed.results[0].nodeId as string;
  const inst = run(placed.state, [{ type: 'node.insert', owner: page, parentId: section, slot: 'content', definitionId: id }]);
  const owner: OwnerRef = { kind: 'component', id };
  return { s: inst.state, id, owner, page, instance: inst.results[0].nodeId as string, def: (st: ProjectState): ComponentDefinition => st.components[id] };
}

/** The card with a Buttons slot, placed inside its Body. */
function withButtons() {
  const c = card();
  const plan = createSlotOps(c.s, c.def(c.s), 'Buttons', slotInsertAt(c.s, c.id, ref(c.owner, 'body'))!)!;
  return { ...c, s: run(c.s, plan.operations).state, slot: plan.slot };
}

const draft = (s: ProjectState, def: ComponentDefinition, slot: string, patch: Partial<SlotDraft>): SlotDraft => ({ ...slotDraft(def.slots![slot]), ...patch });

describe('a new slot (#655)', () => {
  it('is declared and placed inside the selected container in one change, taking anything', () => {
    const c = card();
    const at = slotInsertAt(c.s, c.id, ref(c.owner, 'body'));
    expect(at).toEqual({ owner: c.owner, parentId: 'body' });
    const plan = createSlotOps(c.s, c.def(c.s), '  Buttons  ', at!)!;
    expect(plan.slot).toBe('buttons');
    expect(plan.operations).toEqual([
      { type: 'component.setSlot', definitionId: c.id, slot: 'buttons', label: 'Buttons' },
      { type: 'node.insert', owner: c.owner, parentId: 'body', primitive: 'slot', bind: 'buttons' }
    ]);
    const s = run(c.s, plan.operations).state;
    const def = c.def(s);
    expect(def.slots).toEqual({ buttons: { label: 'Buttons' } });
    const body = def.tree!.nodes.body as ElementNode;
    expect(body.children).toHaveLength(1);
    expect(def.tree!.nodes[body.children[0]]).toMatchObject({ kind: 'slot', slot: 'buttons' });
    expect(placedSlots(def).get('buttons')).toBe(body.children[0]);
    expect(unplacedSlots(def)).toEqual([]);
    expect(errors(s)).toEqual([]);
    expect(validateState(s).filter((d) => d.code === 'SLOT_UNPLACED')).toEqual([]);
    // Nothing without a name; a long one is cut to what the operation takes.
    expect(createSlotOps(c.s, c.def(c.s), '   ', at!)).toBeNull();
    const long = createSlotOps(s, def, `Call to action ${'x'.repeat(70)}`, slotInsertAt(s, c.id, ref(c.owner, 'root'))!)!;
    expect(long.operations[0]).toMatchObject({ slot: long.slot, label: `Call to action ${'x'.repeat(45)}` });
    expect(long.operations[1]).toMatchObject({ parentId: 'root', bind: long.slot });
    expect(long.slot).toMatch(/^[a-z][a-zA-Z0-9]{0,39}$/);
    expect(run(s, long.operations).state.components[c.id].slots![long.slot].label).toHaveLength(60);
  });

  it('takes a name no slot, property or placement’s kept content already has', () => {
    const c = withButtons();
    expect(newSlotName(c.s, c.def(c.s), 'Buttons')).toBe('buttons2');
    // A property's name is not reused either, so the component never has a slot and a property of one name.
    expect(newSlotName(c.s, c.def(c.s), 'Subtitle')).toBe('subtitle2');
    expect(newSlotName(c.s, c.def(c.s), 'Side panel')).toBe('sidePanel');
    // Svelte reads a property called slot as its own syntax; a label that makes no name falls back to content.
    expect(newSlotName(c.s, c.def(c.s), 'Slot')).toBe('slot2');
    expect(newSlotName(c.s, c.def(c.s), '¡¿!')).toBe('content');
    // Content a placement still keeps under a name (left by a hand edit) would show in a new slot by that name.
    const kept = structuredClone(c.s);
    (kept.pages[kept.site.homePageId].nodes[c.instance] as InstanceNode).slots = { aside: [] };
    expect(newSlotName(kept, c.def(kept), 'Aside')).toBe('aside2');
  });

  it('goes inside a picked container, else inside the whole design: never beside a text, nor into a paragraph', () => {
    const c = card();
    const root = { owner: c.owner, parentId: 'root' };
    expect(slotInsertAt(c.s, c.id, null)).toEqual(root);
    // A picked heading, a node of a component placed in the design, or a node of another tree: the whole design.
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'title'))).toEqual(root);
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'body', ['someInstance']))).toEqual(root);
    expect(slotInsertAt(c.s, c.id, ref(c.page, 'body'))).toEqual(root);
    // A figure keeps its caption last.
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'fig'))).toEqual({ owner: c.owner, parentId: 'fig', index: 1 });
    // A paragraph holds only inline content, which a slot's content is not: the whole design takes it instead.
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'note'))).toEqual(root);
    // A design whose root is no container has nowhere to hold one, unless a container is picked.
    const bare = structuredClone(c.s);
    bare.components[c.id].tree!.rootIds = ['title'];
    expect(slotInsertAt(bare, c.id, null)).toBeNull();
    expect(slotInsertAt(bare, c.id, ref(c.owner, 'note'))).toBeNull();
    const two = structuredClone(c.s);
    two.components[c.id].tree!.rootIds = ['root', 'title'];
    expect(slotInsertAt(two, c.id, null)).toBeNull();
    expect(slotInsertAt(two, c.id, ref(c.owner, 'body'))).toEqual({ owner: c.owner, parentId: 'body' });
    // A missing component, or one written as code, is not edited here.
    expect(slotInsertAt(c.s, 'missing', null)).toBeNull();
    const code = structuredClone(c.s);
    code.components[c.id].kind = 'code';
    expect(slotInsertAt(code, c.id, ref(c.owner, 'body'))).toBeNull();
  });

  it('never goes where it would show once per item, or not at all: a container in a repeat gives way to the whole design', () => {
    const c = card();
    const s = structuredClone(c.s);
    const tree = s.components[c.id].tree!;
    tree.nodes.rep = { id: 'rep', kind: 'repeat', list: { $prop: 'items' }, children: ['cell'] } as never;
    tree.nodes.cell = { id: 'cell', kind: 'element', children: [] } as never;
    (tree.nodes.root as ElementNode).children.push('rep');
    expect(slotInsertAt(s, c.id, ref(c.owner, 'cell'))).toEqual({ owner: c.owner, parentId: 'root' });
    // The same container outside the repeat takes it.
    (tree.nodes.rep as { children: string[] }).children = [];
    (tree.nodes.root as ElementNode).children.push('cell');
    expect(slotInsertAt(s, c.id, ref(c.owner, 'cell'))).toEqual({ owner: c.owner, parentId: 'cell' });
  });

  it('never goes into a placed component’s slot that limits what it takes, nor somewhere the design does not hold', () => {
    const c = withButtons();
    // The card's Buttons slot takes only text, at most two: a new slot, which takes anything, cannot be passed on there.
    let s = run(c.s, [{ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Buttons', primitives: ['text'], max: 2 }]).state;
    const shelf = run(s, [{ type: 'component.upsert', name: 'Shelf', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section', children: [] }] }]);
    const shelfId = shelf.results[0].definitionId as string;
    const shelfOwner: OwnerRef = { kind: 'component', id: shelfId };
    const inner = run(shelf.state, [{ type: 'node.insert', owner: shelfOwner, parentId: 'root', definitionId: c.id }]);
    const cardInShelf = inner.results[0].nodeId as string;
    s = inner.state;
    expect(slotInsertAt(s, shelfId, ref(shelfOwner, cardInShelf))).toEqual({ owner: shelfOwner, parentId: 'root' });
    // Opened up, it can.
    s = run(s, [{ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Buttons', primitives: null, max: null }]).state;
    const at = slotInsertAt(s, shelfId, ref(shelfOwner, cardInShelf));
    expect(at).toEqual({ owner: shelfOwner, parentId: cardInShelf, slot: c.slot });
    expect(errors(run(s, createSlotOps(s, s.components[shelfId], 'Extras', at!)!.operations).state)).toEqual([]);
    // A container left over in the design, which nothing holds, is never shown: the whole design takes it instead.
    const loose = structuredClone(s);
    loose.components[shelfId].tree!.nodes.loose = { id: 'loose', kind: 'element', children: [] } as never;
    expect(slotInsertAt(loose, shelfId, ref(shelfOwner, 'loose'))).toEqual({ owner: shelfOwner, parentId: 'root' });
  });

  it('a component placed in the design takes it in the slot it shows once, passing the new slot’s content on', () => {
    const c = card();
    const placed = run(c.s, [{ type: 'node.insert', owner: c.owner, parentId: 'root', componentId: 'layout.section' }]);
    const section = placed.results[0].nodeId as string;
    const inner = run(placed.state, [{ type: 'node.insert', owner: c.owner, parentId: section, slot: 'content', primitive: 'stack' }]);
    const stack = inner.results[0].nodeId as string;
    let s = inner.state;
    const into = slotInsertAt(s, c.id, ref(c.owner, section));
    expect(into).toEqual({ owner: c.owner, parentId: section, slot: 'content' });
    // A container of the design's own, in that slot, shows once too.
    expect(slotInsertAt(s, c.id, ref(c.owner, stack))).toEqual({ owner: c.owner, parentId: stack });
    const plan = createSlotOps(s, c.def(s), 'Extras', into!)!;
    s = run(s, plan.operations).state;
    expect((c.def(s).tree!.nodes[section] as InstanceNode).slots!.content).toContain(placedSlots(c.def(s)).get('extras'));
    expect(errors(s)).toEqual([]);
    // A design that is a placed Section (made from one on a page) has only that Section's slot to hold one.
    const band = run(c.s, [{ type: 'component.createFromNode', owner: c.page, nodeId: (c.s.pages[c.page.id].rootIds[0]), name: 'Band' }]);
    const bandId = band.results[0].definitionId as string;
    const bandRoot = band.state.components[bandId].tree!.rootIds[0];
    expect(band.state.components[bandId].tree!.nodes[bandRoot].kind).toBe('instance');
    const there = slotInsertAt(band.state, bandId, null);
    expect(there).toEqual({ owner: { kind: 'component', id: bandId }, parentId: bandRoot, slot: 'content' });
    const banded = run(band.state, createSlotOps(band.state, band.state.components[bandId], 'Body', there!)!.operations).state;
    expect(unplacedSlots(banded.components[bandId])).toEqual([]);
    expect(errors(banded)).toEqual([]);
  });

  it('a picked placeholder puts the next one inside the whole design', () => {
    const c = withButtons();
    const placeholder = placedSlots(c.def(c.s)).get('buttons')!;
    expect(slotInsertAt(c.s, c.id, ref(c.owner, placeholder))).toEqual({ owner: c.owner, parentId: 'root' });
  });
});

describe('changing a slot’s contract (#655)', () => {
  it('sends its label and only what the form changed, under the same name', () => {
    const c = withButtons();
    const renamed = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { label: ' Actions ' }));
    expect(renamed).toEqual({ type: 'component.setSlot', definitionId: c.id, slot: 'buttons', label: 'Actions' });
    let s = run(c.s, [renamed!]).state;
    expect(c.def(s).slots).toEqual({ buttons: { label: 'Actions' } });
    expect(placedSlots(c.def(s)).has('buttons')).toBe(true);
    // The placeholder is named by the new label wherever the design's own nodes are named (Inspector, Insert's line).
    expect(nodeLabel(s, c.owner, placedSlots(c.def(s)).get('buttons')!)).toBe('Slot: Actions');
    // Text and buttons, two at most, described.
    const op = editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { description: 'Calls to action', restricted: true, primitives: ['link', 'text', 'link'], categories: [], max: ' 2 ' }));
    expect(op).toEqual({ type: 'component.setSlot', definitionId: c.id, slot: 'buttons', label: 'Actions', description: 'Calls to action', categories: [], primitives: ['text', 'link'], max: 2 });
    s = run(s, [op!]).state;
    expect(slotAccepts(c.def(s).slots!.buttons)).toBe('text and buttons');
    // The same choices in another order change nothing.
    expect(editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { primitives: ['link', 'text'] }))).toBeNull();
    // Unchecking everything takes nothing; Anything clears both lists; a blank limit clears it, 0 closes it.
    const nothing = editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { primitives: [] }))!;
    expect(nothing).toMatchObject({ primitives: [] });
    expect(nothing).not.toHaveProperty('categories');
    expect(slotAccepts(run(s, [nothing]).state.components[c.id].slots!.buttons)).toBe('nothing');
    expect(editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { restricted: false, max: '', description: '' }))).toEqual({
      type: 'component.setSlot',
      definitionId: c.id,
      slot: 'buttons',
      label: 'Actions',
      description: null,
      categories: null,
      primitives: null,
      max: null
    });
    expect(editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { max: '0' }))).toMatchObject({ max: 0 });
  });

  it('Anything alone clears the lists and keeps the rest; a change to one list sends only that list', () => {
    const c = withButtons();
    const s = run(c.s, [{ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Buttons', description: 'Calls', primitives: ['link'], max: 2 }]).state;
    const anything = editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { restricted: false }))!;
    expect(anything).toEqual({ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Buttons', primitives: null });
    expect(run(s, [anything]).state.components[c.id].slots!.buttons).toEqual({ label: 'Buttons', description: 'Calls', max: 2 });
    const media = editSlotOp(c.def(s), c.slot, draft(s, c.def(s), c.slot, { categories: ['media'] }))!;
    expect(media).toEqual({ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Buttons', categories: ['media'] });
    expect(run(s, [media]).state.components[c.id].slots!.buttons).toEqual({ label: 'Buttons', description: 'Calls', primitives: ['link'], categories: ['media'], max: 2 });
  });

  it('a slot that took anything takes only what is checked, even nothing', () => {
    const c = withButtons();
    const op = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { restricted: true }));
    expect(op).toMatchObject({ categories: [], primitives: [] });
    expect(slotAccepts(run(c.s, [op!]).state.components[c.id].slots!.buttons)).toBe('nothing');
    const media = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { restricted: true, categories: ['media', 'hero', 'media'] }));
    expect(media).toMatchObject({ categories: ['hero', 'media'], primitives: [] });
  });

  it('refuses a draft with no name or a limit that is no whole number up to 1000, and a slot that is gone', () => {
    const c = withButtons();
    const def = c.def(c.s);
    for (const bad of [{ label: '  ' }, { max: 'two' }, { max: '1.5' }, { max: '-1' }, { max: '1001' }]) {
      expect(slotDraftProblem(draft(c.s, def, c.slot, bad))).not.toBeNull();
      expect(editSlotOp(def, c.slot, draft(c.s, def, c.slot, bad))).toBeNull();
    }
    expect(slotDraftProblem(draft(c.s, def, c.slot, { max: '1000' }))).toBeNull();
    // A save never declares a removed slot again.
    const gone = run(c.s, [removeSlotOp(def, c.slot)]).state;
    expect(editSlotOp(c.def(gone), c.slot, draft(c.s, def, c.slot, { label: 'Back' }))).toBeNull();
  });
});

describe('a slot changed elsewhere while its form is open (#655)', () => {
  const was = { label: 'Buttons', description: 'Calls', primitives: ['link'] as SlotPrimitive[], max: 2 };

  it('keeps what the author changed and takes the rest as the slot has it now, so a save never puts back an Undo', () => {
    // The author changed only the description; meanwhile an Undo took the limit away and the AI renamed it.
    const now = { label: 'Actions', description: 'Calls', primitives: ['link'] as SlotPrimitive[] };
    const typed = { ...slotDraft(was), description: 'A call to action' };
    const moved = rebaseSlotDraft(typed, was, now);
    expect(moved.clash).toBe(false);
    expect(moved.draft).toEqual({ ...slotDraft(now), description: 'A call to action' });
    const c = withButtons();
    const s = run(c.s, [{ type: 'component.setSlot', definitionId: c.id, slot: c.slot, ...now }]).state;
    expect(editSlotOp(c.def(s), c.slot, moved.draft)).toEqual({ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Actions', description: 'A call to action' });
  });

  it('says when both changed the same thing differently, showing the current value only where the author left it', () => {
    const typed = { ...slotDraft(was), label: 'Book now', max: '3' };
    const moved = rebaseSlotDraft(typed, was, { ...was, label: 'Actions', primitives: ['text'] });
    expect(moved.clash).toBe(true);
    expect(moved.draft).toMatchObject({ label: 'Book now', max: '3', primitives: ['text'] });
    // The same change on both sides is no clash.
    expect(rebaseSlotDraft(typed, was, { ...was, label: 'Book now' }).clash).toBe(false);
    // What it takes changes as one: lists the author left alone follow the slot, even from Anything.
    expect(rebaseSlotDraft(slotDraft(was), was, { label: 'Buttons' }).draft).toMatchObject({ restricted: false, categories: [], primitives: [] });
    // A limit typed differently but the same number is no change of the author's: the newer limit stands.
    const padded = rebaseSlotDraft({ ...slotDraft(was), max: '02' }, was, { ...was, max: 3 });
    expect(padded).toEqual({ draft: { ...slotDraft(was), max: '3' }, clash: false });
  });

  it('leaves a description written elsewhere as it is unless the author changes it', () => {
    const c = withButtons();
    // Written by hand: padded, and longer than the form takes.
    const s = structuredClone(c.s);
    s.components[c.id].slots!.buttons.description = `  ${'Calls to action. '.repeat(20)}  `;
    expect(editSlotOp(c.def(s), c.slot, slotDraft(c.def(s).slots!.buttons))).toBeNull();
    expect(editSlotOp(c.def(s), c.slot, { ...slotDraft(c.def(s).slots!.buttons), max: '1' })).toEqual({ type: 'component.setSlot', definitionId: c.id, slot: c.slot, label: 'Buttons', max: 1 });
  });
});

describe('a slot placements fill (#655)', () => {
  /** The card's Buttons slot on Home, holding one paragraph. */
  function filled() {
    const c = withButtons();
    const r = run(c.s, [{ type: 'node.insert', owner: c.page, parentId: c.instance, slot: 'buttons', primitive: 'paragraph', text: 'Book a class' }]);
    return { ...c, s: r.state, text: r.results[0].nodeId as string };
  }
  const held = (s: ProjectState, page: OwnerRef, instance: string) => (s.pages[page.id].nodes[instance] as InstanceNode).slots?.buttons;

  it('refuses a contract its content no longer fits, saying where, and keeps that content', () => {
    const c = filled();
    expect(slotFilledIn(c.s, c.def(c.s), c.slot)).toEqual([c.s.pages[c.page.id].title]);
    const images = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { restricted: true, primitives: ['image'] }))!;
    expect(() => run(c.s, [images])).toThrow(/^Home: the “Buttons” slot already holds text, which it would no longer take\. Move it out first\./);
    const closed = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { max: '0' }))!;
    expect(() => run(c.s, [closed])).toThrow(/^Home: the “Buttons” slot already holds more than 0/);
    expect(c.def(c.s).slots!.buttons).toEqual({ label: 'Buttons' });
    expect(held(c.s, c.page, c.instance)).toEqual([c.text]);
    // A contract it still fits is taken.
    const text = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { restricted: true, primitives: ['text'], max: '1' }))!;
    const s = run(c.s, [text]).state;
    expect(c.def(s).slots!.buttons).toEqual({ label: 'Buttons', categories: [], primitives: ['text'], max: 1 });
    expect(held(s, c.page, c.instance)).toEqual([c.text]);
    expect(s.pages[c.page.id].nodes[c.text]).toEqual(c.s.pages[c.page.id].nodes[c.text]);
    expect(() => run(s, [{ type: 'node.insert', owner: c.page, parentId: c.instance, slot: 'buttons', primitive: 'image' }])).toThrow(/takes text, not an image/);
    expect(() => run(s, [{ type: 'node.insert', owner: c.page, parentId: c.instance, slot: 'buttons', primitive: 'paragraph' }])).toThrow(/holds at most one item/);
  });

  it('is removed only once no placement holds content in it, with its placeholder', () => {
    const c = filled();
    expect(() => run(c.s, [removeSlotOp(c.def(c.s), c.slot)])).toThrow(/The "Buttons" slot has content in 1 place \(Home\)\. Move or remove it first\./);
    expect(held(c.s, c.page, c.instance)).toEqual([c.text]);
    const emptied = run(c.s, [{ type: 'node.remove', owner: c.page, nodeId: c.text }]).state;
    expect(slotFilledIn(emptied, c.def(emptied), c.slot)).toEqual([]);
    const s = run(emptied, [removeSlotOp(c.def(emptied), c.slot)]).state;
    expect(c.def(s).slots).toBeUndefined();
    expect((s.pages[c.page.id].nodes[c.instance] as InstanceNode).slots ?? {}).not.toHaveProperty('buttons');
    expect((c.def(s).tree!.nodes.body as ElementNode).children).toEqual([]);
    expect(Object.values(c.def(s).tree!.nodes).some((n) => n.kind === 'slot')).toBe(false);
    expect(errors(s)).toEqual([]);
  });

  it('counts content a hand edit left in another shape as the engine does before removing the slot', () => {
    const c = withButtons();
    const damaged = structuredClone(c.s);
    (damaged.pages[damaged.site.homePageId].nodes[c.instance] as InstanceNode).slots = { buttons: 'n_text' as unknown as string[] };
    expect(slotFilledIn(damaged, c.def(damaged), c.slot)).toEqual(['Home']);
    expect(() => run(damaged, [removeSlotOp(c.def(damaged), c.slot)])).toThrow(/has content in 1 place/);
  });
});

describe('slots the design does not show yet (#655)', () => {
  it('are the declared ones with no placeholder anywhere in the design, in the order declared', () => {
    const c = withButtons();
    const s = run(c.s, [
      { type: 'component.setSlot', definitionId: c.id, slot: 'footer', label: 'Footer' },
      { type: 'component.setSlot', definitionId: c.id, slot: 'aside', label: 'Aside' }
    ]).state;
    expect(unplacedSlots(c.def(s))).toEqual(['footer', 'aside']);
    const placed = run(s, [{ type: 'node.insert', owner: c.owner, parentId: 'root', primitive: 'slot', bind: 'footer' }]).state;
    expect(unplacedSlots(c.def(placed))).toEqual(['aside']);
    // A placeholder the engine would count (one passed on to a component inside the design) counts as placed.
    const passed = structuredClone(placed);
    passed.components[c.id].tree!.nodes.handed = { id: 'handed', kind: 'slot', slot: 'aside' };
    expect(unplacedSlots(c.def(passed))).toEqual([]);
    expect(() => run(placed, [{ type: 'node.insert', owner: c.owner, parentId: 'root', primitive: 'slot', bind: 'footer' }])).toThrow(/already placed/);
  });
});

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render the exported Home page. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'slots-'));
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

describe('a slot passed on to a component placed in the design (#655)', () => {
  it('renders what a page puts in it, even under the same name as the slot it is passed to', async () => {
    const c = card();
    const section = c.s.pages[c.page.id].rootIds[0];
    const band = run(c.s, [{ type: 'component.createFromNode', owner: c.page, nodeId: section, name: 'Band' }]);
    const bandId = band.results[0].definitionId as string;
    const plan = createSlotOps(band.state, band.state.components[bandId], 'Content', slotInsertAt(band.state, bandId, null)!)!;
    // The Section in the design takes it in its own Content slot: the same name, passed on.
    expect(plan.slot).toBe('content');
    expect(plan.operations[1]).toMatchObject({ slot: 'content', bind: 'content' });
    let s = run(band.state, plan.operations).state;
    const placed = s.pages[c.page.id].rootIds.map((id) => s.pages[c.page.id].nodes[id]).find((n) => n.kind === 'instance' && n.definitionId === bandId)!;
    s = run(s, [{ type: 'node.insert', owner: c.page, parentId: placed.id, slot: 'content', primitive: 'paragraph', text: 'Book a class' }]).state;
    expect(errors(s)).toEqual([]);
    const html = await renderHome(s);
    expect(html.split('Book a class')).toHaveLength(2);
  });

  it('is read under a name of its own wherever a placed component has a slot generated under its name, editor preview too', async () => {
    // The card declares Body (first) and Content; a Shelf passes its own Content slot on to the card's Body.
    let s = card().s;
    const cardId = Object.values(s.components).find((d) => d.name === 'Profile card')!.id;
    const cardOwner: OwnerRef = { kind: 'component', id: cardId };
    s = run(s, [
      { type: 'component.setSlot', definitionId: cardId, slot: 'body', label: 'Body' },
      { type: 'node.insert', owner: cardOwner, parentId: 'body', primitive: 'slot', bind: 'body' },
      { type: 'component.setSlot', definitionId: cardId, slot: 'content', label: 'Content' },
      { type: 'node.insert', owner: cardOwner, parentId: 'root', primitive: 'slot', bind: 'content' }
    ]).state;
    const shelf = run(s, [{ type: 'component.upsert', name: 'Shelf', properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'section', children: [] }] }]);
    const shelfId = shelf.results[0].definitionId as string;
    const shelfOwner: OwnerRef = { kind: 'component', id: shelfId };
    const inner = run(shelf.state, [{ type: 'node.insert', owner: shelfOwner, parentId: 'root', definitionId: cardId }]);
    s = inner.state;
    const at = slotInsertAt(s, shelfId, ref(shelfOwner, inner.results[0].nodeId as string));
    expect(at).toMatchObject({ slot: 'body' });
    s = run(s, createSlotOps(s, s.components[shelfId], 'Content', at!)!.operations).state;
    const page: OwnerRef = { kind: 'page', id: s.site.homePageId };
    const placed = run(s, [{ type: 'node.insert', owner: page, parentId: null, index: 0, definitionId: shelfId }]);
    s = run(placed.state, [{ type: 'node.insert', owner: page, parentId: placed.results[0].nodeId as string, slot: 'content', primitive: 'paragraph', text: 'Book a class' }]).state;
    expect(errors(s)).toEqual([]);
    // The editor's preview gives the card an empty Content snippet beside Body: the Shelf's own Content must not read it.
    const file = (instrument: boolean) => [...generateProject(s, { instrument })].find(([path, src]) => path.endsWith('.svelte') && src.includes('Code component') === false && src.includes(`slot_content: so_given_content = undefined`))?.[1] ?? '';
    for (const instrument of [false, true]) {
      const shelfFile = file(instrument);
      expect(shelfFile).toContain('{@render so_given_content?.()}');
      expect(shelfFile).not.toContain('{@render slot_content?.()}');
    }
    expect((await renderHome(s)).split('Book a class')).toHaveLength(2);
    // Names that differ but generate the same identifier ("detail-pane", "_detail_pane") shadow it the same way.
    const odd = structuredClone(s);
    odd.components[cardId].slots = { 'detail-pane': { label: 'Detail' } };
    odd.components[shelfId].slots = { _detail_pane: { label: 'Detail' } };
    const oddFile = [...generateProject(odd)].map(([, src]) => src).find((src) => src.includes('slot__detail_pane: so_given__detail_pane = undefined'));
    expect(oddFile).toBeDefined();
    // A design with no component placed in it keeps the slot's own name.
    const plain = [...generateProject(s)].map(([, src]) => src).find((src) => src.includes('slot_body = undefined') && src.includes('slot_content = undefined'));
    expect(plain).toContain('{@render slot_content?.()}');
  });
});
