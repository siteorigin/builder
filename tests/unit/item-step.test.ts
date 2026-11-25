// Previous and Next item on the selection chip (#552): a part picked in one repeated item (one card of a grid) steps
// to the same part in the card before or after, without wrapping and without changing the list.
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { ElementRef, InstanceNode, ListItem, ProjectState } from '@shared/types';
import { itemStep, refExists } from '../../src/renderer/src/lib/model';

const fresh = () => createStarterState('business', 'Step Studio', false);
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const grid = (s: ProjectState) => {
  const p = s.pages[s.site.homePageId];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
};
const cards = (s: ProjectState) => grid(s).props.items as ListItem[];
/** The card's title part, picked on the page in the card with this ID. */
const titleIn = (s: ProjectState, itemId: string): ElementRef => {
  const g = grid(s);
  const def = s.components[g.definitionId];
  const part = Object.entries(def.parts ?? {}).find(([, p]) => /title/i.test(p.label ?? '') || /title/i.test(p.nodeId))!;
  return { owner: owner(s), instancePath: [g.id], nodeId: part[1].nodeId, partId: part[0], itemPath: [itemId] };
};

describe('stepping the selection between repeated items (#552)', () => {
  it('names the position and the same part in the item before and after, without wrapping', () => {
    const s = fresh();
    const ids = cards(s).map((c) => c.id as string);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const before = JSON.stringify(s);

    // The first card: no Previous, and Next is the same part in the second card.
    const first = itemStep(s, titleIn(s, ids[0]))!;
    expect(first).toMatchObject({ n: 1, count: ids.length, prev: null });
    expect(first.next).toEqual(titleIn(s, ids[1]));
    expect(refExists(s, first.next!)).toBe(true);

    // Forward through every card, then back again: the position follows each step.
    let ref: ElementRef = titleIn(s, ids[0]);
    for (let i = 1; i < ids.length; i++) {
      ref = itemStep(s, ref)!.next!;
      expect(ref.itemPath).toEqual([ids[i]]);
      expect(itemStep(s, ref)).toMatchObject({ n: i + 1, count: ids.length });
    }
    // The last card has no Next: it never wraps to the first.
    expect(itemStep(s, ref)!.next).toBeNull();
    for (let i = ids.length - 2; i >= 0; i--) {
      ref = itemStep(s, ref)!.prev!;
      expect(ref).toEqual(titleIn(s, ids[i]));
      expect(itemStep(s, ref)!.n).toBe(i + 1);
    }
    expect(itemStep(s, ref)!.prev).toBeNull();

    // Stepping only names another item: the project is untouched.
    expect(JSON.stringify(s)).toBe(before);
  });

  it('keeps everything but the item: the part, its placement, and any items further in', () => {
    const s = fresh();
    const ids = cards(s).map((c) => c.id as string);
    const nested = { ...titleIn(s, ids[1]), itemPath: [ids[1], 'inner'] };
    const step = itemStep(s, nested)!;
    expect(step.prev).toEqual({ ...nested, itemPath: [ids[0], 'inner'] });
    expect(step.next).toEqual({ ...nested, itemPath: [ids[2], 'inner'] });
  });

  it('offers no steps outside a repeated item, or for an item that has left the list', () => {
    const s = fresh();
    const g = grid(s);
    // The grid itself, and a part picked in every card (from Layers), have no single item to step from.
    expect(itemStep(s, { owner: owner(s), instancePath: [], nodeId: g.id })).toBeNull();
    const { itemPath: _, ...everyCard } = titleIn(s, cards(s)[0].id as string);
    expect(itemStep(s, everyCard)).toBeNull();
    expect(itemStep(s, titleIn(s, 'gone'))).toBeNull();
  });

  it('skips nothing at an item without an ID: there is no part to select in it, so that step is not offered', () => {
    const s = fresh();
    const list = cards(s);
    list.splice(1, 0, { title: 'No ID' } as unknown as ListItem);
    const step = itemStep(s, titleIn(s, list[0].id as string))!;
    expect(step).toMatchObject({ n: 1, count: list.length, next: null });
  });
});
