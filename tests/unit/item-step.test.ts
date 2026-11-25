// Previous and Next item on the selection chip (#552): a part picked in one repeated item (one card of a grid) steps
// to the same part in the card before or after, without wrapping and without changing the list.
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { ElementRef, InstanceNode, ListItem, ProjectState } from '@shared/types';
import { itemStep, refExists, stepItem } from '../../src/renderer/src/lib/model';

const fresh = () => createStarterState('business', 'Step Studio', false);
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const grid = (s: ProjectState) => {
  const p = s.pages[s.site.homePageId];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
};
const cards = (s: ProjectState) => grid(s).props.items as ListItem[];
/** A part of the card picked on the page in the card with this ID (its title, unless another part is named). */
const partIn = (s: ProjectState, itemId: string, partId = 'cardTitle'): ElementRef => {
  const g = grid(s);
  const part = s.components[g.definitionId].parts[partId];
  expect(part, `the grid has a ${partId} part`).toBeTruthy();
  return { owner: owner(s), instancePath: [g.id], nodeId: part.nodeId, partId, itemPath: [itemId] };
};

describe('stepping the selection between repeated items (#552)', () => {
  it('names the position and the same part in every item, stepping without wrapping', () => {
    const s = fresh();
    const ids = cards(s).map((c) => c.id as string);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const before = JSON.stringify(s);

    const first = itemStep(s, partIn(s, ids[0]))!;
    expect(first).toMatchObject({ n: 1, count: ids.length });
    expect(first.parts).toEqual(ids.map((id) => partIn(s, id)));
    for (const p of first.parts!) expect(refExists(s, p!)).toBe(true);
    // The first card has no Previous; Next is the same part in the second card.
    expect(stepItem(first.parts!, first.n, -1)).toBeNull();
    expect(stepItem(first.parts!, first.n, 1)).toEqual(partIn(s, ids[1]));

    // Forward through every card, then back again: the position follows each step.
    let ref: ElementRef = partIn(s, ids[0]);
    for (let i = 1; i < ids.length; i++) {
      const at = itemStep(s, ref)!;
      ref = stepItem(at.parts!, at.n, 1)!;
      expect(ref.itemPath).toEqual([ids[i]]);
      expect(itemStep(s, ref)).toMatchObject({ n: i + 1, count: ids.length });
    }
    // The last card has no Next: it never wraps to the first.
    const last = itemStep(s, ref)!;
    expect(stepItem(last.parts!, last.n, 1)).toBeNull();
    for (let i = ids.length - 2; i >= 0; i--) {
      const at = itemStep(s, ref)!;
      ref = stepItem(at.parts!, at.n, -1)!;
      expect(ref).toEqual(partIn(s, ids[i]));
      expect(itemStep(s, ref)!.n).toBe(i + 1);
    }

    // Stepping only names another item: the project is untouched.
    expect(JSON.stringify(s)).toBe(before);
  });

  it('steps over items the page does not show the part in, and offers nothing past the last one shown', () => {
    const s = fresh();
    const ids = cards(s).map((c) => c.id as string);
    const { parts, n } = itemStep(s, partIn(s, ids[0]))!;
    // A rule hides the part in the second card: Next goes on to the third.
    expect(stepItem(parts!, n, 1, [true, false, true])).toEqual(partIn(s, ids[2]));
    // Hidden in every card after this one: nothing to step to.
    expect(stepItem(parts!, n, 1, [true, false, false])).toBeNull();
    // Not yet known counts as shown.
    expect(stepItem(parts!, n, 1, [true, undefined, false])).toEqual(partIn(s, ids[1]));
    expect(stepItem(parts!, 3, -1, [false, true, true])).toEqual(partIn(s, ids[1]));
  });

  it('reads the design’s items while the placement has none of its own', () => {
    const s = fresh();
    const g = grid(s);
    const defaults = s.components[g.definitionId].properties.items as { default?: ListItem[] };
    defaults.default = cards(s).map((c) => ({ ...c }));
    delete (g.props as Record<string, unknown>).items;
    const ids = defaults.default.map((c) => c.id as string);
    const at = itemStep(s, partIn(s, ids[1]))!;
    expect(at).toMatchObject({ n: 2, count: ids.length });
    expect(stepItem(at.parts!, at.n, 1)).toEqual(partIn(s, ids[2]));
  });

  it('uses the list that repeats the part, not another list with an item of the same ID', () => {
    const s = fresh();
    const g = grid(s);
    const def = s.components[g.definitionId];
    def.properties = { decoy: { ...def.properties.items }, ...def.properties };
    (g.props as Record<string, unknown>).decoy = [{ ...cards(s)[0], id: cards(s)[1].id }];
    const ids = cards(s).map((c) => c.id as string);
    expect(itemStep(s, partIn(s, ids[1]))).toMatchObject({ n: 2, count: ids.length });
  });

  it('offers no steps outside a repeated item, for an item that has left the list, or past an item without an ID', () => {
    const s = fresh();
    const g = grid(s);
    // The grid itself, and a part picked in every card (from Layers), have no single item to step from.
    expect(itemStep(s, { owner: owner(s), instancePath: [], nodeId: g.id })).toBeNull();
    const { itemPath: _, ...everyCard } = partIn(s, cards(s)[0].id as string);
    expect(itemStep(s, everyCard)).toBeNull();
    expect(itemStep(s, partIn(s, 'gone'))).toBeNull();
    // An item without an ID can't be selected, so it is no step: the one after it is.
    const list = cards(s);
    list.splice(1, 0, { title: 'No ID' } as unknown as ListItem);
    const at = itemStep(s, partIn(s, list[0].id as string))!;
    expect(at).toMatchObject({ n: 1, count: list.length });
    expect(at.parts![1]).toBeNull();
    expect(stepItem(at.parts!, at.n, 1)).toEqual(partIn(s, list[2].id as string));
  });

  it('keeps the position but offers no steps for an item of a list inside another item', () => {
    const s = fresh();
    const ids = cards(s).map((c) => c.id as string);
    expect(itemStep(s, { ...partIn(s, ids[1]), itemPath: [ids[1], 'inner'] })).toEqual({ n: 2, count: ids.length, parts: null });
  });
});
