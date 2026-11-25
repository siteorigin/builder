/**
 * Slots authored in Edit everywhere (#655): a slot is declared and its placeholder placed in one change, inside the
 * selected container or the whole design; its contract changes only where the form changed it; and a contract or a
 * removal that content placements already hold would break is refused by the engine, with that content kept.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ElementNode, ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
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
    // Nothing without a name.
    expect(createSlotOps(c.s, c.def(c.s), '   ', at!)).toBeNull();
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

  it('goes inside a picked container, else inside the whole design; never beside a text, nor into a paragraph', () => {
    const c = card();
    const root = { owner: c.owner, parentId: 'root' };
    expect(slotInsertAt(c.s, c.id, null)).toEqual(root);
    // A picked heading, a node of a component placed in the design, or a node of another tree: the whole design.
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'title'))).toEqual(root);
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'body', ['someInstance']))).toEqual(root);
    expect(slotInsertAt(c.s, c.id, ref(c.page, 'body'))).toEqual(root);
    // A figure keeps its caption last.
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'fig'))).toEqual({ owner: c.owner, parentId: 'fig', index: 1 });
    // A paragraph holds only inline content, which a slot's content is not.
    expect(slotInsertAt(c.s, c.id, ref(c.owner, 'note'))).toBeNull();
    // A design whose root is no container has nowhere to hold one.
    const bare = structuredClone(c.s);
    bare.components[c.id].tree!.rootIds = ['title'];
    expect(slotInsertAt(bare, c.id, null)).toBeNull();
    // A theme's component or a code component is not edited here.
    expect(slotInsertAt(c.s, 'missing', null)).toBeNull();
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
    expect(() => run(c.s, [images])).toThrow(/the “Buttons” slot already holds text, which it would no longer take\. Move it out first\./);
    const closed = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { max: '0' }))!;
    expect(() => run(c.s, [closed])).toThrow(/the “Buttons” slot already holds more than 0/);
    expect(c.def(c.s).slots!.buttons).toEqual({ label: 'Buttons' });
    expect(held(c.s, c.page, c.instance)).toEqual([c.text]);
    // A contract it still fits is taken.
    const text = editSlotOp(c.def(c.s), c.slot, draft(c.s, c.def(c.s), c.slot, { restricted: true, primitives: ['text'], max: '1' }))!;
    const s = run(c.s, [text]).state;
    expect(c.def(s).slots!.buttons).toEqual({ label: 'Buttons', categories: [], primitives: ['text'], max: 1 });
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
    expect((c.def(s).tree!.nodes.body as ElementNode).children).toEqual([]);
    expect(Object.values(c.def(s).tree!.nodes).some((n) => n.kind === 'slot')).toBe(false);
    expect(errors(s)).toEqual([]);
  });
});

describe('slots the design does not show yet (#655)', () => {
  it('are the declared ones with no placeholder anywhere in the design, in the order declared', () => {
    const c = withButtons();
    const s = run(c.s, [
      { type: 'component.setSlot', definitionId: c.id, slot: 'aside', label: 'Aside' },
      { type: 'component.setSlot', definitionId: c.id, slot: 'footer', label: 'Footer' }
    ]).state;
    expect(unplacedSlots(c.def(s))).toEqual(['aside', 'footer']);
    const placed = run(s, [{ type: 'node.insert', owner: c.owner, parentId: 'root', primitive: 'slot', bind: 'footer' }]).state;
    expect(unplacedSlots(c.def(placed))).toEqual(['aside']);
    // A placeholder the engine would count (one passed on to a component inside the design) counts as placed.
    const passed = structuredClone(placed);
    passed.components[c.id].tree!.nodes.handed = { id: 'handed', kind: 'slot', slot: 'aside' };
    expect(unplacedSlots(c.def(passed))).toEqual([]);
    expect(() => run(placed, [{ type: 'node.insert', owner: c.owner, parentId: 'root', primitive: 'slot', bind: 'footer' }])).toThrow(/already placed/);
  });
});
