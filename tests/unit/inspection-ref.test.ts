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
import { inspectionRef } from '../../src/renderer/src/lib/model';
import { attributeFindings } from '../../src/renderer/src/lib/inspect-check';

const fresh = () => createStarterState('business', 'Test Studio', false);
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
    const grid = placementOf(s, 'foundation.features.grid');
    const card = (grid.props.items as Array<{ id: string }>)[1].id;
    const ref = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: card });
    expect(ref).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'cardTitle', itemId: card });
    const after = placementOf(styleThrough(s, ref!), 'foundation.features.grid');
    // The style landed on that card's title only.
    expect(after.itemOverrides?.cardTitle?.items[card]).toEqual({ base: { color: '#123456' } });
    expect(after.overrides?.cardTitle).toBeUndefined();
  });

  it('falls back to the nearest declared part around an element that is not one, keeping its item', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const card = (grid.props.items as Array<{ id: string }>)[0].id;
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-text', items: card })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'card', itemId: card, match: 'nearest-part' });
    // Outside every list, the nearest part is the whole component's root, with no item.
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'eyebrow', items: '' })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'root', match: 'nearest-part' });
  });

  it('gives a part outside the list no item, whatever items the element was rendered in', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const card = (grid.props.items as Array<{ id: string }>)[0].id;
    const ref = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'heading', items: card });
    expect(ref).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'heading' });
    expect(placementOf(styleThrough(s, ref!), 'foundation.features.grid').overrides?.heading).toEqual({ base: { color: '#123456' } });
  });

  it('names the placement for its definition root, and for a node on the page itself', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const page = { kind: 'page', id: s.site.homePageId };
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'root', items: '' })).toEqual({ owner: page, nodeId: grid.id });
    expect(inspectionRef(s, { ctx: ctxOf(s), node: grid.id, items: '' })).toEqual({ owner: page, nodeId: grid.id });
    // Markup inside it that the editor does not know element by element (a code component's) is the placement's.
    expect(inspectionRef(s, { ctx: ctxOf(s), node: grid.id, items: '', inside: true })).toEqual({ owner: page, nodeId: grid.id, match: 'placement' });
  });

  it('reads item IDs escaped as the preview writes them', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const items = grid.props.items as Array<{ id: string }>;
    items[0] = { ...items[0], id: 'a,b%c' };
    const ref = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: 'a%2Cb%25c' });
    expect(ref?.itemId).toBe('a,b%c');
    expect(placementOf(styleThrough(s, ref!), 'foundation.features.grid').itemOverrides?.cardTitle?.items['a,b%c']).toEqual({ base: { color: '#123456' } });
    // An item the list no longer has is not offered as one to style.
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-title', items: 'gone' })).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'cardTitle' });
  });

  it('names the part of the outer placement that holds a nested component', () => {
    const s = fresh();
    const outer: ComponentDefinition = structuredClone(s.components['foundation.features.grid']);
    outer.id = 'project.outer';
    outer.owner = 'project';
    const inner = makeInstance(s.components['foundation.cta.banner'], {});
    outer.tree!.nodes[inner.id] = inner;
    const intro = outer.tree!.nodes.intro;
    if (intro.kind !== 'element') throw new Error('intro is an element');
    intro.children.push(inner.id);
    s.components[outer.id] = outer;
    const placed = makeInstance(outer, {});
    homeOf(s).nodes[placed.id] = placed;
    homeOf(s).rootIds.push(placed.id);
    // The banner's heading, two components down: the outer placement's root part is the nearest there is.
    const ref = inspectionRef(s, { ctx: ctxOf(s, placed.id, inner.id), node: 'heading', items: '' });
    expect(ref).toEqual({ owner: { kind: 'page', id: s.site.homePageId }, nodeId: placed.id, partId: 'root', match: 'nearest-part' });
    styleThrough(s, ref!);
    // Declared as a part of the outer design, the nested component is named by that part.
    outer.parts.promo = { nodeId: inner.id, label: 'Promo' } as (typeof outer.parts)[string];
    expect(inspectionRef(s, { ctx: ctxOf(s, placed.id, inner.id), node: 'heading', items: '' })).toMatchObject({ nodeId: placed.id, partId: 'promo', match: 'nearest-part' });
  });

  it('names nothing for an address the project does not have', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    expect(inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'no-such-node', items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s), node: 'no-such-node', items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: 'page:no-such-page', node: grid.id, items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: 'preview:abc', node: 'root', items: '' })).toBeNull();
    expect(inspectionRef(s, { ctx: ctxOf(s, 'toString'), node: 'root', items: '' })).toBeNull();
  });

  it('replaces every raw address in a report, the overlapped box included, and drops one that names nothing', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const report = {
      issues: [
        { kind: 'overlap', desc: { ctx: ctxOf(s, grid.id), node: 'heading', items: '' }, with: { desc: { ctx: ctxOf(s, grid.id), node: 'grid', items: '' }, text: 'Grid' }, message: 'Overlaps.' },
        { kind: 'low-contrast', desc: { ctx: ctxOf(s), node: 'gone', items: '' }, message: 'Pale.' },
        { kind: 'heading-structure', message: 'Two h1.' }
      ]
    };
    attributeFindings(s, report);
    expect(report.issues).toEqual([
      { kind: 'overlap', ref: { owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'heading' }, with: { ref: { owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id, partId: 'grid' }, text: 'Grid' }, message: 'Overlaps.' },
      { kind: 'low-contrast', message: 'Pale.' },
      { kind: 'heading-structure', message: 'Two h1.' }
    ]);
  });
});
