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
    for (const p of first.parts) expect(refExists(s, p!)).toBe(true);
    // The first card has no Previous; Next is the same part in the second card.
    expect(stepItem(first.parts, first.n, -1)).toBeNull();
    expect(stepItem(first.parts, first.n, 1)).toEqual(partIn(s, ids[1]));

    // Forward through every card, then back again: the position follows each step.
    let ref: ElementRef = partIn(s, ids[0]);
    for (let i = 1; i < ids.length; i++) {
      const at = itemStep(s, ref)!;
      ref = stepItem(at.parts, at.n, 1)!;
      expect(ref.itemPath).toEqual([ids[i]]);
      expect(itemStep(s, ref)).toMatchObject({ n: i + 1, count: ids.length });
    }
    // The last card has no Next: it never wraps to the first.
    const last = itemStep(s, ref)!;
    expect(stepItem(last.parts, last.n, 1)).toBeNull();
    for (let i = ids.length - 2; i >= 0; i--) {
      const at = itemStep(s, ref)!;
      ref = stepItem(at.parts, at.n, -1)!;
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
    expect(stepItem(parts, n, 1, [true, false, true])).toEqual(partIn(s, ids[2]));
    // Hidden in every card after this one: nothing to step to.
    expect(stepItem(parts, n, 1, [true, false, false])).toBeNull();
    // Not yet known counts as shown.
    expect(stepItem(parts, n, 1, [true, undefined, false])).toEqual(partIn(s, ids[1]));
    expect(stepItem(parts, 3, -1, [false, true, true])).toEqual(partIn(s, ids[1]));
    // Previous steps over a hidden card the same way.
    expect(stepItem(parts, 3, -1, [true, false, true])).toEqual(partIn(s, ids[0]));
    expect(stepItem(parts, 3, -1, [false, false, true])).toBeNull();
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
    expect(stepItem(at.parts, at.n, 1)).toEqual(partIn(s, ids[2]));
    // A list left empty (null in a hand-edited file) shows the design's items too; an empty list shows none.
    (g.props as Record<string, unknown>).items = null;
    expect(itemStep(s, partIn(s, ids[1]))).toMatchObject({ n: 2, count: ids.length });
    (g.props as Record<string, unknown>).items = [];
    expect(itemStep(s, partIn(s, ids[1]))).toBeNull();
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

  it('offers no steps outside a repeated item or for an item that has left the list, and steps past an item without an ID', () => {
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
    expect(at.parts[1]).toBeNull();
    expect(stepItem(at.parts, at.n, 1)).toEqual(partIn(s, list[2].id as string));
  });

  it('names an item a hand-edited file gives a number as its ID as the preview does', () => {
    const s = fresh();
    const list = cards(s);
    (list[1] as { id: unknown }).id = 42;
    const at = itemStep(s, partIn(s, list[0].id as string))!;
    expect(stepItem(at.parts, at.n, 1)).toEqual(partIn(s, '42'));
    expect(itemStep(s, partIn(s, '42'))).toMatchObject({ n: 2, count: list.length });
  });

  it('steps the innermost item of a list repeated inside each item, keeping the outer item', () => {
    const s = fresh();
    const g = grid(s);
    const def = s.components[g.definitionId];
    // Each card lists the same tags: a repeat inside the card's repeat.
    def.properties.tags = { ...def.properties.items, default: [{ id: 't1', title: 'Fast' }, { id: 't2', title: 'Tidy' }, { id: 't3', title: 'Fair' }] } as typeof def.properties.items;
    def.tree!.nodes['tag-text'] = { id: 'tag-text', kind: 'text', tag: 'span', text: { $item: 'title' } } as (typeof def.tree.nodes)[string];
    def.tree!.nodes.tags = { id: 'tags', kind: 'repeat', list: { $prop: 'tags' }, children: ['tag-text'] } as (typeof def.tree.nodes)[string];
    (def.tree!.nodes.card as { children: string[] }).children.push('tags');
    const ids = cards(s).map((c) => c.id as string);
    const tag = (item: string, t: string): ElementRef => ({ owner: owner(s), instancePath: [g.id], nodeId: 'tag-text', itemPath: [item, t] });
    const at = itemStep(s, tag(ids[1], 't2'))!;
    expect(at).toMatchObject({ n: 2, count: 3 });
    expect(stepItem(at.parts, at.n, 1)).toEqual(tag(ids[1], 't3'));
    expect(stepItem(at.parts, at.n, -1)).toEqual(tag(ids[1], 't1'));
    expect(refExists(s, stepItem(at.parts, at.n, 1)!)).toBe(true);
  });

  it('reads the list of a component placed inside another, set there or passed down from it', () => {
    const s = fresh();
    const g = grid(s);
    const gridDef = s.components[g.definitionId];
    const ids = cards(s).map((c) => c.id as string);
    // A wrapper whose design places the grid: once with its own cards, once with the wrapper's cards passed down.
    const wrap = structuredClone(gridDef);
    Object.assign(wrap, { id: 'wrap', componentId: 'test.wrap', name: 'Wrapper', parts: {}, properties: { cards: gridDef.properties.items } });
    wrap.tree = {
      rootIds: ['w-root'],
      nodes: {
        'w-root': { id: 'w-root', kind: 'element', tag: 'div', children: ['w-own', 'w-passed'] },
        'w-own': { id: 'w-own', kind: 'instance', definitionId: gridDef.id, props: { items: cards(s).slice(0, 2) } },
        'w-passed': { id: 'w-passed', kind: 'instance', definitionId: gridDef.id, props: { items: { $prop: 'cards' } } }
      }
    } as unknown as typeof wrap.tree;
    s.components.wrap = wrap;
    const page = s.pages[s.site.homePageId];
    page.nodes['wrap-1'] = { id: 'wrap-1', kind: 'instance', definitionId: 'wrap', props: { cards: cards(s).map((c) => ({ ...c })) } } as InstanceNode;
    page.rootIds.push('wrap-1');
    const title = (inner: string, item: string): ElementRef => ({ owner: owner(s), instancePath: ['wrap-1', inner], nodeId: gridDef.parts.cardTitle.nodeId, partId: 'cardTitle', itemPath: [item] });
    const own = itemStep(s, title('w-own', ids[0]))!;
    expect(own).toMatchObject({ n: 1, count: 2 });
    expect(stepItem(own.parts, own.n, 1)).toEqual(title('w-own', ids[1]));
    const passed = itemStep(s, title('w-passed', ids[1]))!;
    expect(passed).toMatchObject({ n: 2, count: ids.length });
    expect(stepItem(passed.parts, passed.n, 1)).toEqual(title('w-passed', ids[2]));
  });
});
