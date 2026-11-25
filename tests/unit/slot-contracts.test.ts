import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { slotAccepts, slotDeclProblem, takesComponent } from '@engine/slots';
import { validateState } from '@engine/validate';
import { addPoints, fitting, quickItems, resolvePoint } from '../../src/renderer/src/lib/inline-insert';

/**
 * A slot can take components by name (#660): a catalogue contract ID, the same in every compatible theme, or a
 * project definition ID, beside the categories and element kinds it takes.
 */

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const slotOf = (s: ProjectState, nodeId: string, slot = 'content') => (home(s).nodes[nodeId] as InstanceNode).slots?.[slot] ?? [];

/** A blank site whose Section is the project's own, placed once on Home and empty; and a card component of the project's. */
function bento() {
  let s = createStarterState('blank', 'Bento', false);
  const page: OwnerRef = { kind: 'page', id: s.site.homePageId };
  const run = (ops: EditOperation[]) => {
    const r = applyOperations(s, ops);
    s = r.state;
    return r.results;
  };
  const [{ nodeId: scratch }] = run([{ type: 'node.insert', owner: page, parentId: null, componentId: 'layout.section' }]);
  const [{ nodeId: stack }] = run([{ type: 'node.insert', owner: page, parentId: scratch as string, slot: 'content', primitive: 'stack' }]);
  run([{ type: 'node.insert', owner: page, parentId: stack as string, primitive: 'heading', text: 'Card' }]);
  const [{ definitionId: card }] = run([{ type: 'component.createFromNode', owner: page, nodeId: stack as string, name: 'Feature card' }]);
  const [{ definitionId: section }] = run([{ type: 'component.fork', definitionId: (home(s).nodes[scratch as string] as InstanceNode).definitionId }]);
  run([{ type: 'node.remove', owner: page, nodeId: scratch as string }]);
  const [{ nodeId: grid }] = run([
    { type: 'node.insert', owner: page, parentId: null, definitionId: section as string },
    { type: 'component.setSlot', definitionId: section as string, slot: 'content', label: 'Content', description: null }
  ]);
  return { s, page, section: section as string, card: card as string, grid: grid as string };
}

describe('a slot that names the components it takes', () => {
  it('takes the components it names, by contract or definition ID, and refuses others and elements it does not list', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'media.gallery'] }]).state;
    expect(s.components[section].slots!.content).toEqual({ label: 'Cards', componentIds: [card, 'media.gallery'] });
    // Named by its definition ID, and by the contract every compatible theme's gallery shares.
    let next = applyOperations(s, [
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', componentId: 'media.gallery' }
    ]).state;
    expect(slotOf(next, grid)).toHaveLength(2);
    expect(errors(next)).toEqual([]);
    // Another component, of whatever category, or an element, is refused, and the message names what it takes.
    const gallery = Object.values(next.components).find((d) => d.componentId === 'media.gallery')!.name;
    expect(() => applyOperations(next, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', componentId: 'features.grid' }])).toThrow(
      new RegExp(`“Cards” slot of “Section” takes “Feature card” and “${gallery}”, not “Services grid” \\(a content component\\)`)
    );
    expect(() => applyOperations(next, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'heading' }])).toThrow(/takes “Feature card” and .*, not text/);
    // With element kinds listed too, it takes either.
    next = applyOperations(next, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', primitives: ['text'] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'heading' }
    ]).state;
    expect(slotOf(next, grid)).toHaveLength(3);
    expect(() => applyOperations(next, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', primitive: 'image' }])).toThrow(/takes “Feature card”, “.*” and text, not an image/);
  });

  it('takes a component of a category it lists or one it names, and calls a component the project lacks by its ID', () => {
    const { s, card } = bento();
    const def = s.components[card];
    expect(takesComponent({ label: 'x', componentIds: [card] }, def)).toBe(true);
    expect(takesComponent({ label: 'x', componentIds: [def.componentId] }, def)).toBe(true);
    expect(takesComponent({ label: 'x', categories: [def.category] }, def)).toBe(true);
    expect(takesComponent({ label: 'x', componentIds: ['pricing.plans'], categories: ['hero'] }, def)).toBe(false);
    expect(takesComponent({ label: 'x', primitives: ['text'] }, def)).toBe(false);
    expect(takesComponent({ label: 'x' }, def)).toBe(true);
    expect(slotAccepts({ label: 'x', componentIds: ['studio.bento-card'] }, s)).toBe('“studio.bento-card”');
    expect(slotAccepts({ label: 'x', componentIds: [] })).toBe('nothing');
    expect(slotAccepts({ label: 'x', categories: ['media'], componentIds: [card], primitives: ['image'] }, s)).toBe('media components, “Feature card” and images');
  });

  it('refuses tightening a contract its content no longer fits, keeps the list a relabel leaves out, and clears it with null', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, card, ` ${card} `] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }
    ]).state;
    // Named once, however often it was sent.
    expect(s.components[section].slots!.content.componentIds).toEqual([card]);
    expect(applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Tiles' }]).state.components[section].slots!.content).toEqual({ label: 'Tiles', componentIds: [card] });
    expect(applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: null }]).state.components[section].slots!.content).toEqual({ label: 'Cards' });
    expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: ['media.gallery'] }])).toThrow(/already holds “Feature card” \(a custom component\), which it would no longer take/);
    expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: ['  '] }])).toThrow(/by its ID/);
    expect(validateOperation({ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'x', componentIds: [''] }).ok).toBe(false);
    expect(validateOperation({ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'x', componentIds: Array.from({ length: 51 }, (_, i) => `c${i}`) }).ok).toBe(false);
    expect(validateOperation({ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'x', componentIds: [card] }).ok).toBe(true);
  });

  it('reports content it does not take, and a list damaged by hand, when the project is opened', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }]).state;
    s.components[section].slots!.content = { label: 'Cards', componentIds: ['media.gallery'] };
    expect(errors(s).map((d) => [d.code, d.message])).toEqual([['SLOT_REFUSED', expect.stringMatching(/the “Cards” slot of Section takes “.*”, but holds “Feature card” \(a custom component\)\./)]]);
    for (const damaged of ['media.gallery', [''], [42], Array.from({ length: 51 }, (_, i) => `c${i}`)]) {
      expect(slotDeclProblem({ label: 'Cards', componentIds: damaged })).toMatch(/names components by something other than up to 50 component IDs/);
      s.components[section].slots!.content = { label: 'Cards', componentIds: damaged as string[] };
      expect(errors(s).map((d) => d.code)).toEqual(['SLOT_INVALID']);
    }
  });

  it('takes a slot passed on from outside only when every component that slot names is one it takes too', () => {
    const { s: base, section, card } = bento();
    const own: OwnerRef = { kind: 'component', id: section };
    // The Section's inner box becomes a component of its own, which takes the Section's content straight on.
    let s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card] }]).state;
    const w = applyOperations(s, [{ type: 'component.createFromNode', owner: own, nodeId: 'inner', name: 'Inner' }]);
    const inner = w.results[0].definitionId as string;
    s = w.state;
    expect(s.components[inner].slots!.content).toEqual({ label: 'Cards', componentIds: [card] });
    expect(errors(s)).toEqual([]);
    // The inner slot can take the card by its category instead.
    s = applyOperations(s, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Cards', componentIds: null, categories: ['custom'] }]).state;
    expect(errors(s)).toEqual([]);
    // Not when it takes neither the card nor its category.
    expect(() => applyOperations(s, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Cards', categories: ['media'] }])).toThrow(/already holds the content of “Cards”, which can be “Feature card”/);
    // Nor when the outer slot names a component the project lacks, which only a slot naming it too can take.
    s = applyOperations(s, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'studio.missing'] }]).state;
    expect(errors(s).map((d) => d.code)).toEqual(['SLOT_REFUSED']);
    s = applyOperations(s, [{ type: 'component.setSlot', definitionId: inner, slot: 'content', label: 'Cards', componentIds: ['studio.missing'] }]).state;
    expect(errors(s)).toEqual([]);
  });

  it('changes a placement in the slot to another design only when the slot takes that design', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [
      { type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card, 'media.gallery'] },
      { type: 'node.insert', owner: page, parentId: grid, slot: 'content', definitionId: card }
    ]).state;
    const placed = slotOf(s, grid)[0];
    expect(() => applyOperations(s, [{ type: 'instance.swapComponent', owner: page, nodeId: placed, componentId: 'features.grid' }])).toThrow(/takes “Feature card” and “.*”, not “Services grid” \(a content component\)/);
  });

  it('offers the canvas’s Add list inside the slot only the components it names', () => {
    const { s: base, page, section, card, grid } = bento();
    const s = applyOperations(base, [{ type: 'component.setSlot', definitionId: section, slot: 'content', label: 'Cards', componentIds: [card] }]).state;
    const ref: ElementRef = { owner: page, instancePath: [], nodeId: grid };
    const inside = addPoints(s, page, ref).find((p) => p.side === 'inside')!;
    const offered = fitting(s, resolvePoint(s, inside)!, 'element', quickItems(s, 'element'));
    expect(offered.map((it) => it.spec.definitionId ?? it.name)).toEqual([card]);
  });
});
