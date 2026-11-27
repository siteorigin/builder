/**
 * A layout inspection's findings name the element to change as operations address it (#361): the preview's raw
 * address (data-so-ctx/node/items) becomes { owner, nodeId, partId, itemId }, and an operation given that
 * reference changes the element measured.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import type { InspectionRef } from '@shared/inspection';
import { placementItems } from '@shared/item-styles';
import { inspectionRef } from '../../src/renderer/src/lib/model';
import { attributeFindings } from '../../src/renderer/src/lib/inspect-check';
import { FOUNDATION_AUTHOR } from './fixtures/packs';
import { ctaBanner, placeOnHome, servicesGrid } from './fixtures/inspection-ref-designs';

/** The business starter with a Services grid and a Call to action, designs of the project's own, placed on Home. */
function fresh(): ProjectState {
  const s = createStarterState('business', 'Test Studio', false);
  placeOnHome(s, servicesGrid(s));
  placeOnHome(s, ctaBanner(s));
  return s;
}
const GRID = FOUNDATION_AUTHOR.definitionId('project.features');
const BANNER = FOUNDATION_AUTHOR.definitionId('project.banner');
const homeOf = (s: ProjectState) => s.pages[s.site.homePageId];
const placementOf = (s: ProjectState, definitionId: string) => Object.values(homeOf(s).nodes).find((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === definitionId)!;
const ctxOf = (s: ProjectState, ...path: string[]) => [`page:${s.site.homePageId}`, ...path].join('|');

/** Apply a harmless style change through the reference, as the assistant would, and return the state after it. */
function styleThrough(s: ProjectState, ref: InspectionRef): ProjectState {
  const op = { type: 'node.setStyle' as const, owner: ref.owner, nodeId: ref.nodeId, ...(ref.partId ? { partId: ref.partId } : {}), ...(ref.itemId ? { itemId: ref.itemId } : {}), scope: 'base' as const, property: 'color', value: '#123456' };
  // Throws when the operation refuses the reference.
  return applyOperations(s, [op]).state;
}

describe('inspection references', () => {
  it('names a declared part of a placement, and the one card it was measured in', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const card = (grid.props.items as Array<{ id: string }>)[1].id;
    const ref = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: card });
    expect(ref).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'cardTitle', itemId: card });
    const after = placementOf(styleThrough(s, ref!), GRID);
    // The style landed on that card's title only.
    expect(after.itemOverrides?.cardTitle?.items[card]).toEqual({ base: { color: '#123456' } });
    expect(after.overrides?.cardTitle).toBeUndefined();
  });

  it('falls back to the nearest declared part around an element that is not one, keeping its item', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const card = (grid.props.items as Array<{ id: string }>)[0].id;
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-text', items: card })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'card', itemId: card, match: 'nearest-part' });
    // Outside every list, the nearest part is the whole component's root, with no item.
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'eyebrow', items: '' })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'root', match: 'nearest-part' });
  });

  it('gives a part outside the list no item', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const page = { kind: 'page', id: s.site.homePageId };
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'grid', items: '' })).toEqual({ owner: page, nodeId: grid.id, partId: 'grid' });
    const ref = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'heading', items: '' });
    expect(ref).toEqual({ owner: page, nodeId: grid.id, partId: 'heading' });
    expect(placementOf(styleThrough(s, ref!), GRID).overrides?.heading).toEqual({ base: { color: '#123456' } });
  });

  it('names the placement for its definition root, and for a node on the page itself', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const page = { kind: 'page' as const, id: s.site.homePageId };
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'root', items: '' })).toEqual({ owner: page, nodeId: grid.id });
    expect(inspectionRef(s, { ctx: ctxOf(s), node: grid.id, items: '' })).toEqual({ owner: page, nodeId: grid.id });
    // Markup inside a design's root that the editor does not address on its own is the root part's.
    expect(inspectionRef(s, { ctx: ctxOf(s), node: grid.id, items: '', inside: true })).toEqual({ owner: page, nodeId: grid.id, match: 'nearest-part' });
    // Inside a code component, whose markup the editor does not know element by element, it is the placement's.
    const created = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: {} }]);
    const definitionId = created.results[0].definitionId as string;
    const placed = applyOperations(created.state, [{ type: 'node.insert', owner: page, definitionId }]);
    const code = placed.results[0].nodeId as string;
    expect(inspectionRef(placed.state, { ctx: ctxOf(placed.state), node: code, items: '', inside: true })).toEqual({ owner: page, nodeId: code, match: 'placement' });
  });

  it('reads item IDs escaped as the preview writes them', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const items = grid.props.items as Array<{ id: string }>;
    items[0] = { ...items[0], id: 'a,b%c' };
    const ref = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: 'a%2Cb%25c' });
    expect(ref?.itemId).toBe('a,b%c');
    expect(placementOf(styleThrough(s, ref!), GRID).itemOverrides?.cardTitle?.items['a,b%c']).toEqual({ base: { color: '#123456' } });
    // An item the list no longer has means the measured page was out of date: nothing is named, never every card.
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: 'gone' })).toBeNull();
    // The card's item comes first in the path (deeper lists follow): a later ID that happens to be a card's is not it.
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-text', items: `gone,${items[1].id}` })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-text', items: `${items[1].id},other` })?.itemId).toBe(items[1].id);
    // Items on an element shown outside every list: the page measured was older than the design.
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'heading', items: items[1].id })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: 42 } as never)).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'cardTitle' });
  });

  it('names the part of the outer placement that holds a nested component', () => {
    const s = fresh();
    const outer: ComponentDefinition = structuredClone(s.components[GRID]);
    outer.id = 'project.outer';
    outer.owner = 'project';
    const inner = makeInstance(s.components[BANNER], {});
    outer.tree!.nodes[inner.id] = inner;
    const intro = outer.tree!.nodes.intro;
    if (intro.kind !== 'element') throw new Error('intro is an element');
    intro.children.push(inner.id);
    s.components[outer.id] = outer;
    const placed = makeInstance(outer, {});
    homeOf(s).nodes[placed.id] = placed;
    homeOf(s).rootIds.push(placed.id);
    // The banner's heading, two components down: the outer placement's root part is the nearest there is, and the
    // heading itself is offered in the outer design, where a change reaches every placement of it.
    const ref = inspectionRef(s, { ctx: ctxOf(s, placed.id, inner.id), node: 'heading', items: '' });
    const { definition, ...onPage } = ref!;
    expect(onPage).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: placed.id, partId: 'root', match: 'nearest-part' });
    expect(definition).toEqual({ owner: { kind: 'component', id: outer.id }, nodeId: inner.id, partId: 'heading' });
    styleThrough(s, onPage);
    const styled = styleThrough(s, definition!).components[outer.id].tree!.nodes[inner.id] as InstanceNode;
    expect(styled.overrides?.heading).toEqual({ base: { color: '#123456' } });
    // A banner inside each card: its own elements carry its own items, never the outer card's, so even an ID both
    // lists share names no single card.
    const inCard = makeInstance(s.components[BANNER], {});
    outer.tree!.nodes[inCard.id] = inCard;
    const cardNode = outer.tree!.nodes.card;
    if (cardNode.kind !== 'element') throw new Error('card is an element');
    cardNode.children.push(inCard.id);
    const cards = placementItems(outer, placed, 'items');
    expect(cards.length).toBeGreaterThan(0);
    // The banner itself, at its root, which the outer design exposes only through the card around it.
    const bannerRoot = s.components[BANNER].tree!.rootIds[0];
    expect(inspectionRef(s, { ctx: ctxOf(s, placed.id, inCard.id), node: bannerRoot, items: cards[0].id })).toEqual({
      owner: { kind: 'page', id: s.site.homePageId },
      nodeId: placed.id,
      partId: 'card',
      match: 'nearest-part',
      itemId: cards[0].id,
      definition: { owner: { kind: 'component', id: outer.id }, nodeId: inCard.id }
    });
    const inside = inspectionRef(s, { ctx: ctxOf(s, placed.id, inCard.id), node: 'heading', items: cards[0].id });
    expect(inside).toMatchObject({ nodeId: placed.id, partId: 'card', match: 'nearest-part' });
    expect(inside?.itemId).toBeUndefined();
    // Declared as a part of the outer design, the nested component is named by that part.
    outer.parts.promo = { nodeId: inner.id, label: 'Promo' } as (typeof outer.parts)[string];
    expect(inspectionRef(s, { ctx: ctxOf(s, placed.id, inner.id), node: 'heading', items: '' })).toMatchObject({ nodeId: placed.id, partId: 'promo', match: 'nearest-part' });
  });

  it('names a placement by the part its root is declared as, whatever it is called', () => {
    const s = fresh();
    const banner = placementOf(s, BANNER);
    const def = s.components[BANNER];
    const root = def.tree!.rootIds[0];
    expect(inspectionRef(s, { ctx: ctxOf(s, banner.id), node: root, items: '' })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: banner.id });
    def.parts = Object.fromEntries(Object.entries(def.parts).map(([id, part]) => [id === 'root' ? 'frame' : id, part]));
    expect(inspectionRef(s, { ctx: ctxOf(s, banner.id), node: root, items: '' })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: banner.id, partId: 'frame' });
    // Markup inside that root the editor does not address on its own is the root part's too.
    expect(inspectionRef(s, { ctx: ctxOf(s, banner.id), node: root, items: '', inside: true })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: banner.id, partId: 'frame', match: 'nearest-part' });
  });

  it('names the node holding markup the editor does not address on its own, and says so', () => {
    const s0 = fresh();
    const page = { kind: 'page' as const, id: s0.site.homePageId };
    const inserted = applyOperations(s0, [{ type: 'node.insert', owner: page, primitive: 'container' }]);
    const s = inserted.state;
    const box = inserted.results[0].nodeId as string;
    expect(inspectionRef(s, { ctx: ctxOf(s), node: box, items: '' })).toEqual({ owner: page, nodeId: box });
    expect(inspectionRef(s, { ctx: ctxOf(s), node: box, items: '', inside: true })).toEqual({ owner: page, nodeId: box, match: 'container' });
  });

  it('stops at nodes a hand-edited design left holding each other', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const def = s.components[GRID];
    def.tree!.nodes.loopA = { id: 'loopA', kind: 'element', tag: 'div', children: ['loopB'] } as never;
    def.tree!.nodes.loopB = { id: 'loopB', kind: 'element', tag: 'div', children: ['loopA'] } as never;
    def.parts.loopy = { nodeId: 'loopB', label: 'Loopy' } as (typeof def.parts)[string];
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'loopA', items: 'x' })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'loopA', items: '' })).toMatchObject({ nodeId: grid.id, partId: 'loopy', match: 'nearest-part' });
  });

  it('names nothing for an address the project does not have', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    expect(inspectionRef(s, {} as never)).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 42, items: '' } as never)).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'no-such-node', items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s), node: 'no-such-node', items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: 'page:no-such-page', node: grid.id, items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: 'preview:abc', node: 'root', items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, 'toString'), node: 'root', items: '' })).toBeNull();
  });

  it('replaces every raw address in a report, the overlapped box included, and drops one that names nothing', () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const report = {
      issues: [
        { kind: 'overlap', desc: { ctx: ctxOf(s, grid.id), node: 'heading', items: '' }, with: { desc: { ctx: ctxOf(s, grid.id), node: 'grid', items: '' }, text: 'Grid' }, message: 'Overlaps.' },
        { kind: 'low-contrast', desc: { ctx: ctxOf(s), node: 'gone', items: '' }, ref: { owner: { kind: 'page', id: 'old' }, nodeId: 'old' }, message: 'Pale.' },
        { kind: 'overlap', desc: {}, with: { desc: {} }, message: 'Odd.' },
        { kind: 'heading-structure', message: 'Two h1.' }
      ]
    };
    attributeFindings(s, report);
    expect(report.issues).toEqual([
      { kind: 'overlap', ref: { owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'heading' }, with: { ref: { owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'grid' }, text: 'Grid' }, message: 'Overlaps.' },
      { kind: 'low-contrast', message: 'Pale.' },
      { kind: 'overlap', with: {}, message: 'Odd.' },
      { kind: 'heading-structure', message: 'Two h1.' }
    ]);
  });

  it("names the sections and headings of the page's rhythm notes as findings are named, with or without findings (#366)", () => {
    const s = fresh();
    const grid = placementOf(s, GRID);
    const page = { kind: 'page', id: s.site.homePageId };
    const report = {
      issues: [{ kind: 'overlap', desc: { ctx: ctxOf(s, grid.id), node: 'heading', items: '' }, message: 'Overlaps.' }],
      rhythm: [
        { kind: 'repeated-layout', sections: { first: 1, last: 3 }, desc: { ctx: ctxOf(s), node: grid.id, items: '' }, with: { desc: { ctx: ctxOf(s), node: 'gone', items: '' } }, message: 'Same layout.' },
        { kind: 'heading-scale', desc: { ctx: ctxOf(s, grid.id), node: 'heading', items: '' }, with: { desc: { ctx: ctxOf(s, grid.id), node: 'heading', items: '' }, text: 'Title' }, message: 'Large.' }
      ]
    };
    attributeFindings(s, report);
    expect(report.issues).toEqual([{ kind: 'overlap', ref: { owner: page, nodeId: grid.id, partId: 'heading' }, message: 'Overlaps.' }]);
    expect(report.rhythm).toEqual([
      { kind: 'repeated-layout', sections: { first: 1, last: 3 }, ref: { owner: page, nodeId: grid.id }, with: {}, message: 'Same layout.' },
      { kind: 'heading-scale', ref: { owner: page, nodeId: grid.id, partId: 'heading' }, with: { ref: { owner: page, nodeId: grid.id, partId: 'heading' }, text: 'Title' }, message: 'Large.' }
    ]);
    const alone = { rhythm: [{ kind: 'crowded-actions', desc: { ctx: ctxOf(s), node: grid.id, items: '' }, message: 'Buttons.' }, null] };
    attributeFindings(s, alone);
    expect(alone.rhythm).toEqual([{ kind: 'crowded-actions', ref: { owner: page, nodeId: grid.id }, message: 'Buttons.' }, null]);
  });
});
