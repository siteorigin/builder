import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { definitionPick, descOf, listPropFor, placementsOn, resolveRef, selectionFromChain, throughPlacement, toDefinitionRef } from '../../src/renderer/src/lib/model';

/** A home page with a Section at the top holding two "Feature card" components, each with a heading. */
function cards() {
  let s: ProjectState = createStarterState('business', 'Test Studio', false);
  const pageId = s.site.homePageId;
  const owner = { kind: 'page' as const, id: pageId };
  s = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
  const section = s.pages[pageId].rootIds[0];
  s = applyOperations(s, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }]).state;
  const stack = (s.pages[pageId].nodes[section] as InstanceNode).slots!.content.at(-1)!;
  s = applyOperations(s, [{ type: 'node.insert', owner, parentId: stack, primitive: 'heading', text: 'Card title' }]).state;
  const made = applyOperations(s, [{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Feature card' }]);
  s = made.state;
  const card1 = made.results[0].nodeId as string;
  const defId = made.results[0].definitionId as string;
  const dup = applyOperations(s, [{ type: 'node.duplicate', owner, nodeId: card1 }]);
  s = dup.state;
  const card2 = dup.results[0].nodeId as string;
  const def = s.components[defId];
  const heading = Object.values(def.tree!.nodes).find((n) => n.kind === 'text')!.id;
  const hero = s.pages[pageId].rootIds.find((id) => id !== section)!;
  const at = (instancePath: string[], nodeId: string): ElementRef => ({ owner, instancePath, nodeId });
  // What the bridge reports for a click on a card's heading: innermost first, every marked element up to the
  // section, the section's own Container part (which holds its slot) included.
  const inner = s.components[(s.pages[pageId].nodes[section] as InstanceNode).definitionId].parts.container.nodeId;
  const chainTo = (card: string) => [descOf(s, at([card], heading)), descOf(s, at([], card)), descOf(s, at([section], inner)), descOf(s, at([], section))];
  return { s, owner, pageId, section, card1, card2, defId, heading, hero, at, chainTo };
}

const strip = (r: ElementRef | null) => r && { owner: r.owner, instancePath: r.instancePath, nodeId: r.nodeId };

describe('canvas selection steps in one level per click', () => {
  it('goes section, then card, then the card’s heading', () => {
    const { s, section, card1, heading, at, chainTo } = cards();
    const chain = chainTo(card1);
    const first = selectionFromChain(s, chain, null, false);
    expect(strip(first)).toEqual(at([], section));
    const second = selectionFromChain(s, chain, first, false);
    expect(strip(second)).toEqual(at([], card1));
    const third = selectionFromChain(s, chain, second, false);
    expect(strip(third)).toEqual(at([card1], heading));
    // Clicking the innermost level again keeps it.
    expect(strip(selectionFromChain(s, chain, third, false))).toEqual(at([card1], heading));
  });

  it('goes straight to the innermost level with a modifier or a double-click', () => {
    const { s, card1, heading, at, chainTo } = cards();
    expect(strip(selectionFromChain(s, chainTo(card1), null, true))).toEqual(at([card1], heading));
  });

  it('moves between siblings at the level inside what they share', () => {
    const { s, card1, card2, heading, at, chainTo } = cards();
    // Working in the first card's heading, a click on the second card selects that card first.
    expect(strip(selectionFromChain(s, chainTo(card2), at([card1], heading), false))).toEqual(at([], card2));
    // With the first card selected, a click on the second card's heading selects the second card.
    expect(strip(selectionFromChain(s, chainTo(card2), at([], card1), false))).toEqual(at([], card2));
  });

  it('goes from the section to what is placed in it, past the section’s own container', () => {
    const { s, section, card1, at, chainTo } = cards();
    expect(strip(selectionFromChain(s, chainTo(card1), at([], section), false))).toEqual(at([], card1));
  });

  it('moves between parts of one repeated item at the part level', () => {
    let s: ProjectState = createStarterState('business', 'Test Studio', false);
    const pageId = Object.keys(s.pages).find((id) => Object.values(s.pages[id].nodes).some((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'features.grid'))!;
    const grid = Object.values(s.pages[pageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'features.grid') as InstanceNode;
    const def = s.components[grid.definitionId];
    const item = (grid.props[listPropFor(def, 'card-title')!] as Array<{ id: string }>)[0].id;
    const owner = { kind: 'page' as const, id: pageId };
    const part = (nodeId: string): ElementRef => ({ owner, instancePath: [grid.id], nodeId, itemPath: [item] });
    const text = Object.values(def.tree!.nodes).find((n) => n.kind === 'text' && n.id !== 'card-title' && listPropFor(def, n.id))!.id;
    const chain = [descOf(s, part(text)), descOf(s, part('card')), descOf(s, { owner, instancePath: [], nodeId: grid.id })];
    // With the card's title selected, a click on its description selects the description.
    expect(strip(selectionFromChain(s, chain, { ...part('card-title'), partId: 'cardTitle' }, false))).toEqual(strip(part(text)));
  });

  it('goes from a hero straight to its heading, past the design’s layout containers', () => {
    const s: ProjectState = createStarterState('business', 'Test Studio', false);
    const pageId = s.site.homePageId;
    const owner = { kind: 'page' as const, id: pageId };
    const hero = s.pages[pageId].nodes[s.pages[pageId].rootIds[0]] as InstanceNode;
    expect(s.components[hero.definitionId].componentId).toBe('hero.split');
    const part = (nodeId: string): ElementRef => ({ owner, instancePath: [hero.id], nodeId });
    // What the bridge reports for a click on the h1: the heading, the design's Content and Layout, its Container
    // part, then its root.
    const chain = ['heading', 'content', 'grid', 'inner', 'root'].map((id) => descOf(s, part(id)));
    const first = selectionFromChain(s, chain, null, false);
    expect(first).toEqual({ owner, instancePath: [], nodeId: hero.id });
    const second = selectionFromChain(s, chain, first, false);
    expect(second).toEqual({ ...part('heading'), partId: 'heading' });
    expect(selectionFromChain(s, chain, second, false)).toEqual(second);
    expect(selectionFromChain(s, chain, null, true)).toEqual(second);
    // A click on the Container's own space, with no content of it under the pointer, still selects it.
    const padding = ['inner', 'root'].map((id) => descOf(s, part(id)));
    expect(selectionFromChain(s, padding, first, false)).toEqual({ ...part('inner'), partId: 'container' });
    // A button goes the same way, past the row of Actions around it as well.
    const button = ['primary', 'actions', 'content', 'grid', 'inner', 'root'].map((id) => descOf(s, part(id)));
    expect(strip(selectionFromChain(s, button, first, false))).toEqual(part('primary'));
    // And from the Container, selected in Layers, a click on the heading inside it selects the heading.
    expect(selectionFromChain(s, chain, { ...part('inner'), partId: 'container' }, false)).toEqual(second);
  });

  it('goes from a component whose root places a hero straight to the hero’s heading', () => {
    let s: ProjectState = createStarterState('business', 'Test Studio', false);
    const pageId = s.site.homePageId;
    const owner = { kind: 'page' as const, id: pageId };
    const heroId = s.pages[pageId].rootIds[0];
    // A project component made from the hero placement: its design's root is that placement.
    const made = applyOperations(s, [{ type: 'component.createFromNode', owner, nodeId: heroId, name: 'Wrapped hero' }]);
    s = made.state;
    const wrap = made.results[0].nodeId as string;
    const def = s.components[made.results[0].definitionId as string];
    const inner = def.tree!.rootIds[0];
    expect(def.tree!.nodes[inner].kind).toBe('instance');
    const part = (nodeId: string): ElementRef => ({ owner, instancePath: [wrap, inner], nodeId });
    const chain = ['heading', 'content', 'grid', 'inner', 'root'].map((id) => descOf(s, part(id)));
    const first = selectionFromChain(s, chain, null, false);
    expect(strip(first)).toEqual(strip({ owner, instancePath: [], nodeId: wrap }));
    expect(strip(selectionFromChain(s, chain, first, false))).toEqual(strip(part('heading')));
  });

  it('starts over from the outside when the selection is elsewhere', () => {
    const { s, section, card1, hero, at, chainTo } = cards();
    expect(strip(selectionFromChain(s, chainTo(card1), at([], hero), false))).toEqual(at([], section));
  });
});

describe('editing a component everywhere', () => {
  it('turns a pick through a placement into the component’s own node', () => {
    const { s, card1, defId, heading, at, chainTo } = cards();
    const hit = toDefinitionRef(s, defId, at([card1], heading));
    expect(hit?.placement).toEqual(at([], card1));
    expect(strip(hit!.ref)).toEqual({ owner: { kind: 'component', id: defId }, instancePath: [], nodeId: heading });
    expect(strip(definitionPick(s, defId, chainTo(card1))!.ref)).toEqual(strip(hit!.ref));
    // The placement itself stands for the component's root.
    expect(toDefinitionRef(s, defId, at([], card1))?.ref.nodeId).toBe(s.components[defId].tree!.rootIds[0]);
  });

  it('picks nothing outside the component', () => {
    const { s, section, hero, defId, at } = cards();
    expect(toDefinitionRef(s, defId, at([], hero))).toBeNull();
    expect(definitionPick(s, defId, [descOf(s, at([], section))])).toBeNull();
  });

  it('shows the component’s nodes through a placement on the page', () => {
    const { s, pageId, card1, card2, defId, heading, at } = cards();
    const placements = placementsOn(s, defId, pageId);
    expect(placements).toEqual([at([], card1), at([], card2)]);
    const own: ElementRef = { owner: { kind: 'component', id: defId }, instancePath: [], nodeId: heading };
    expect(descOf(s, throughPlacement(own, placements[0]))).toEqual(descOf(s, at([card1], heading)));
  });

  it('never resolves ids through the object prototype', () => {
    const { s, pageId } = cards();
    expect(resolveRef(s, { owner: { kind: 'page', id: 'toString' }, instancePath: [], nodeId: 'constructor' })).toEqual({});
    expect(resolveRef(s, { owner: { kind: 'page', id: pageId }, instancePath: [], nodeId: 'constructor' }).node).toBeUndefined();
    expect(resolveRef(s, { owner: { kind: 'component', id: 'constructor' }, instancePath: [], nodeId: 'x' })).toEqual({});
    expect(selectionFromChain(s, [{ ctx: 'page:toString', node: 'constructor', items: '' }], null, false)).toBeNull();
  });

  it('finds the list a repeated part belongs to, even when two lists share field names', () => {
    const s = createStarterState('business', 'Test Studio', false);
    const footer = s.components[(Object.values(s.site.shell.footer.nodes).find((n) => n.kind === 'instance') as InstanceNode).definitionId];
    const repeats = Object.values(footer.tree!.nodes).filter((n) => n.kind === 'repeat');
    expect(repeats.length).toBeGreaterThan(1);
    for (const r of repeats) {
      if (r.kind !== 'repeat') continue;
      const leaf = r.children[0];
      expect(listPropFor(footer, leaf)).toBe(r.list.$prop);
    }
  });
});
