/**
 * Removing a slot that placements fill, or a component still in use (#663): the review lists each placement in the way
 * by where it is, and a slot can go together with what placements hold in it, as one change, so one Undo puts it all
 * back. The engine still refuses either removal while anything is in the way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { slotInsertAt } from '../../src/renderer/src/lib/insert-at';
import { createSlotOps, removeSlotOp } from '../../src/renderer/src/lib/slot-contract';
import { componentRemovalReview, placementRows, planSlotRemoval } from '../../src/renderer/src/lib/removal-review';
import { ProjectSession } from '../../src/main/project/session';

const run = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });

const CARD: EditOperation = {
  type: 'component.upsert',
  name: 'Offer card',
  insertAs: 'element',
  properties: {},
  nodes: [
    { kind: 'element', id: 'root', tag: 'article', children: ['title', 'body'] },
    { kind: 'text', id: 'title', tag: 'h3', text: 'Spring course' },
    { kind: 'element', id: 'body', name: 'Body', children: [] }
  ]
};

/** A blank site with an Offer card of the project's own, with a Buttons slot inside its Body, placed on Home in a Section. */
function site() {
  const start = createStarterState('blank', 'Review', false);
  const home: OwnerRef = { kind: 'page', id: start.site.homePageId };
  const made = run(start, [CARD]);
  const id = made.results[0].definitionId as string;
  const plan = createSlotOps(made.state, made.state.components[id], 'Buttons', slotInsertAt(made.state, id, ref({ kind: 'component', id }, 'body'))!)!;
  let s = run(made.state, plan.operations).state;
  const section = run(s, [{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }]);
  s = section.state;
  const sectionId = section.results[0].nodeId as string;
  const placed = run(s, [{ type: 'node.insert', owner: home, parentId: sectionId, slot: 'content', definitionId: id }]);
  return { s: placed.state, id, home, section: sectionId, card: placed.results[0].nodeId as string, slot: plan.slot, def: (st: ProjectState): ComponentDefinition => st.components[id] };
}

/** Put a paragraph in a placement's Buttons slot. */
function fill(s: ProjectState, owner: OwnerRef, card: string, text: string) {
  const r = run(s, [{ type: 'node.insert', owner, parentId: card, slot: 'buttons', primitive: 'paragraph', text }]);
  return { s: r.state, nodeId: r.results[0].nodeId as string };
}

const held = (s: ProjectState, page: OwnerRef, card: string) => (s.pages[page.id].nodes[card] as InstanceNode).slots?.buttons;

describe('the placements a removal review lists (#663)', () => {
  it('names each by where it is, in site order, and tells several in one place apart in the order they appear', () => {
    const c = site();
    const second = run(c.s, [{ type: 'node.insert', owner: c.home, parentId: c.section, slot: 'content', definitionId: c.id }]);
    let s = second.state;
    // Another page with the same title is told apart by its address.
    const about = run(s, [{ type: 'page.create', title: 'Home', route: '/home-two/' }]);
    s = about.state;
    const aboutPage: OwnerRef = { kind: 'page', id: about.results[0].pageId as string };
    const onAbout = run(s, [{ type: 'node.insert', owner: aboutPage, parentId: null, definitionId: c.id }]);
    s = onAbout.state;
    // And inside another component's design.
    const wrap = run(s, [{ ...CARD, name: 'Offer wrap', nodes: [{ kind: 'element', id: 'root', tag: 'div', children: [] }] } as EditOperation]);
    s = wrap.state;
    const wrapId = wrap.results[0].definitionId as string;
    const inWrap = run(s, [{ type: 'node.insert', owner: { kind: 'component', id: wrapId }, parentId: 'root', definitionId: c.id }]);
    s = inWrap.state;
    const rows = placementRows(s, c.id);
    expect(rows.map((r) => [r.owner.kind, r.place, r.where])).toEqual([
      ['page', 'Home (/)', 'in Section · 1 of 2'],
      ['page', 'Home (/)', 'in Section · 2 of 2'],
      ['page', 'Home (/home-two/)', undefined],
      ['component', 'Inside Offer wrap', undefined]
    ]);
    expect(rows.map((r) => r.nodeId)).toEqual([c.card, second.results[0].nodeId, onAbout.results[0].nodeId, inWrap.results[0].nodeId]);
    // Only those holding content, when a slot's removal asks.
    s = fill(s, aboutPage, onAbout.results[0].nodeId as string, 'Book').s;
    expect(planSlotRemoval(s, c.id, c.slot)!.rows.map((r) => r.nodeId)).toEqual([onAbout.results[0].nodeId]);
  });

  it('lists what keeps a component from being deleted: each placement and the code that needs it', () => {
    const c = site();
    const s = structuredClone(c.s);
    s.components.cd_ticker = { id: 'cd_ticker', name: 'Ticker', kind: 'code', owner: 'project', dependencies: [c.id] } as unknown as ComponentDefinition;
    const review = componentRemovalReview(s, c.id);
    expect(review.rows).toEqual([{ owner: c.home, nodeId: c.card, place: 'Home' }]);
    expect(review.dependents.map((d) => d.name)).toEqual(['Ticker']);
    expect(() => run(c.s, [{ type: 'component.remove', definitionId: c.id }])).toThrow(/is used 1 time \(Home\)/);
  });
});

describe('removing a slot with what placements hold in it (#663)', () => {
  it('removes the content and the slot in one change, which the engine otherwise refuses', () => {
    const c = site();
    const { s, nodeId: words } = fill(c.s, c.home, c.card, 'Book your place');
    expect(() => run(s, [removeSlotOp(c.def(s), c.slot)])).toThrow(/The "Buttons" slot has content in 1 place \(Home\)\. Move or remove it first\./);
    const plan = planSlotRemoval(s, c.id, c.slot)!;
    expect(plan.problem).toBeUndefined();
    expect(plan.items).toBe(1);
    expect(plan.operations).toEqual([
      { type: 'node.remove', owner: c.home, nodeId: words },
      { type: 'component.removeSlot', definitionId: c.id, slot: c.slot }
    ]);
    const after = run(s, plan.operations!).state;
    expect(c.def(after).slots).toBeUndefined();
    expect(Object.hasOwn(after.pages[c.home.id].nodes, words)).toBe(false);
    expect(held(after, c.home, c.card)).toBeUndefined();
    expect(Object.values(c.def(after).tree!.nodes).some((n) => n.kind === 'slot')).toBe(false);
    expect(errors(after)).toEqual([]);
  });

  it('removes a placement held in the slot once, with what it holds there itself', () => {
    const c = site();
    // A card inside the card's own Buttons slot, holding a paragraph in its own.
    const inner = run(c.s, [{ type: 'node.insert', owner: c.home, parentId: c.card, slot: 'buttons', definitionId: c.id }]);
    const innerId = inner.results[0].nodeId as string;
    const { s, nodeId: words } = fill(inner.state, c.home, innerId, 'Inside');
    const plan = planSlotRemoval(s, c.id, c.slot)!;
    expect(plan.rows.map((r) => r.nodeId).sort()).toEqual([c.card, innerId].sort());
    expect(plan.items).toBe(1);
    expect(plan.operations).toEqual([
      { type: 'node.remove', owner: c.home, nodeId: innerId },
      { type: 'component.removeSlot', definitionId: c.id, slot: c.slot }
    ]);
    const after = run(s, plan.operations!).state;
    for (const id of [innerId, words]) expect(Object.hasOwn(after.pages[c.home.id].nodes, id)).toBe(false);
    expect(c.def(after).slots).toBeUndefined();
    expect(errors(after)).toEqual([]);
  });

  it('removes what a placement inside another design holds there, where it is', () => {
    const c = site();
    const wrap = run(c.s, [{ ...CARD, name: 'Offer wrap', nodes: [{ kind: 'element', id: 'root', tag: 'div', children: [] }] } as EditOperation]);
    const wrapId = wrap.results[0].definitionId as string;
    const design: OwnerRef = { kind: 'component', id: wrapId };
    const inWrap = run(wrap.state, [{ type: 'node.insert', owner: design, parentId: 'root', definitionId: c.id }]);
    const cardInWrap = inWrap.results[0].nodeId as string;
    const { s, nodeId: words } = fill(inWrap.state, design, cardInWrap, 'Fixed in the design');
    const plan = planSlotRemoval(s, c.id, c.slot)!;
    expect(plan.rows).toEqual([{ owner: design, nodeId: cardInWrap, place: 'Inside Offer wrap' }]);
    const after = run(s, plan.operations!).state;
    expect(Object.hasOwn(after.components[wrapId].tree!.nodes, words)).toBe(false);
    expect((after.components[wrapId].tree!.nodes[cardInWrap] as InstanceNode).slots).toBeUndefined();
    expect(errors(after)).toEqual([]);
  });

  it('leaves content that shows another design’s own filled slot for the author to move first', () => {
    const c = site();
    // Offer wrap shows its own Extra slot through the card's Buttons slot, and Home fills Extra.
    const wrap = run(c.s, [{ ...CARD, name: 'Offer wrap', nodes: [{ kind: 'element', id: 'root', tag: 'div', children: [] }] } as EditOperation]);
    const wrapId = wrap.results[0].definitionId as string;
    const design: OwnerRef = { kind: 'component', id: wrapId };
    const inWrap = run(wrap.state, [{ type: 'node.insert', owner: design, parentId: 'root', definitionId: c.id }]);
    const cardInWrap = inWrap.results[0].nodeId as string;
    const extra = createSlotOps(inWrap.state, inWrap.state.components[wrapId], 'Extra', slotInsertAt(inWrap.state, wrapId, ref(design, 'root'))!)!;
    let s = run(inWrap.state, extra.operations).state;
    const outlet = Object.values(s.components[wrapId].tree!.nodes).find((n) => n.kind === 'slot')!.id;
    s = run(s, [{ type: 'node.move', owner: design, nodeId: outlet, parentId: cardInWrap, slot: 'buttons', index: 0 }]).state;
    const placedWrap = run(s, [{ type: 'node.insert', owner: c.home, parentId: c.section, slot: 'content', definitionId: wrapId }]);
    const wrapOnHome = placedWrap.results[0].nodeId as string;
    // Empty on every placement, Extra's place goes with the content: nothing it shows is lost.
    expect(planSlotRemoval(placedWrap.state, c.id, c.slot)!.problem).toBeUndefined();
    s = run(placedWrap.state, [{ type: 'node.insert', owner: c.home, parentId: wrapOnHome, slot: extra.slot, primitive: 'paragraph', text: 'Extra words' }]).state;
    const plan = planSlotRemoval(s, c.id, c.slot)!;
    expect(plan.operations).toBeUndefined();
    expect(plan.problem).toMatch(/^Inside Offer wrap, the “Buttons” slot holds the place where Offer wrap shows its own “Extra” slot, which holds content where Offer wrap is placed\. Removed, that content would no longer show\./);
  });

  it('leaves content a hand edit damaged for the author to look at', () => {
    const c = site();
    const damaged = structuredClone(c.s);
    (damaged.pages[c.home.id].nodes[c.card] as InstanceNode).slots = { buttons: 'n_text' as unknown as string[] };
    const plan = planSlotRemoval(damaged, c.id, c.slot)!;
    expect(plan.rows.map((r) => r.nodeId)).toEqual([c.card]);
    expect(plan.operations).toBeUndefined();
    expect(plan.problem).toMatch(/What the “Buttons” slot holds on Home is damaged/);
  });

  it('removes a slot no placement fills on its own, and plans nothing for a slot that is not there', () => {
    const c = site();
    expect(planSlotRemoval(c.s, c.id, c.slot)).toEqual({ rows: [], items: 0, operations: [{ type: 'component.removeSlot', definitionId: c.id, slot: c.slot }] });
    expect(planSlotRemoval(c.s, c.id, 'nope')).toBeNull();
    expect(planSlotRemoval(c.s, 'cd_missing', c.slot)).toBeNull();
  });
});

describe('a removal saved by the project (#663)', () => {
  const dirs: string[] = [];
  const open: ProjectSession[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close().catch(() => undefined);
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  async function session() {
    const c = site();
    const dir = mkdtempSync(join(tmpdir(), 'so-removal-'));
    dirs.push(dir);
    const s = await ProjectSession.create(dir, c.s);
    open.push(s);
    return { ...c, dir, session: s };
  }

  it('is one step that one Undo puts back, content and slot', async () => {
    const c = await session();
    const filled = await c.session.apply({ operations: [{ type: 'node.insert', owner: c.home, parentId: c.card, slot: 'buttons', primitive: 'paragraph', text: 'Book' }] }, { label: 'Fill' });
    expect(filled.ok).toBe(true);
    const before = structuredClone(c.session.state);
    const plan = planSlotRemoval(c.session.state, c.id, c.slot)!;
    const r = await c.session.apply({ operations: plan.operations! }, { label: 'Remove Buttons slot and its content' });
    expect(r.error?.message).toBeUndefined();
    expect(c.def(c.session.state).slots).toBeUndefined();
    expect((await c.session.undo()).ok).toBe(true);
    expect(c.session.state.pages).toEqual(before.pages);
    expect(c.session.state.components[c.id]).toEqual(before.components[c.id]);
  });

  it('waits for a page changed outside the app, which a placement there could fill or use', async () => {
    const c = await session();
    const other = await c.session.apply({ operations: [{ type: 'page.create', title: 'Prices' }] }, { label: 'Add page' });
    const file = `siteorigin/pages/${other.results![0].pageId as string}.json`;
    const path = join(c.dir, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"Prices"', '"Prices (edited)"'));
    for (const op of [removeSlotOp(c.def(c.session.state), c.slot), { type: 'component.remove', definitionId: c.id } as EditOperation]) {
      // Removing the card from Home first, so only the unread page could be in the way.
      const r = await c.session.apply({ operations: op.type === 'component.remove' ? [{ type: 'node.remove', owner: c.home, nodeId: c.card }, op] : [op] }, { label: 'Remove' });
      expect(r.error).toMatchObject({ code: 'CONFLICT' });
      expect(r.error!.message).toMatch(new RegExp(`^${file} was changed outside SiteOrigin Builder`));
    }
    expect(c.def(c.session.state).slots?.[c.slot]).toBeDefined();
  });
});
