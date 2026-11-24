import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { dropListSpecs, dropTarget, incomingOrder, insertIndex, measuredLists, measureIds, type Measured } from '../../src/renderer/src/lib/insert-drop';

/**
 * Dragging an Insert tile onto the page (#52): the lists a drop can go into, and the list and gap under the pointer.
 */

const box = (x: number, y: number, width: number, height: number, order = 0): Measured => ({ x, y, width, height, order });

/** Two sections; the first holds a Grid with two cards side by side and an empty Row under it. */
function page() {
  let state: ProjectState = createStarterState('blank', 'Artists', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const step = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results.map((r) => r.nodeId as string);
  };
  const [first, second] = step([
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
  ]);
  const [grid, row] = step([
    { type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'grid' },
    { type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'row' }
  ]);
  const [a, b] = step([
    { type: 'node.insert', owner, parentId: grid, primitive: 'paragraph', text: 'Ada' },
    { type: 'node.insert', owner, parentId: grid, primitive: 'paragraph', text: 'Bo' }
  ]);
  // Laid out on a 1000px page: sections stacked, the grid's two cells side by side, the empty row under the grid.
  const measured = new Map<string, Measured | null>([
    [first, box(0, 0, 1000, 400)],
    [second, box(0, 400, 1000, 300)],
    [grid, box(100, 50, 800, 200)],
    [row, box(100, 280, 800, 80)],
    [a, box(100, 50, 390, 200)],
    [b, box(510, 50, 390, 200)]
  ]);
  return { state, owner, first, second, grid, row, a, b, measured };
}

describe('the lists a drop can go into (#52)', () => {
  it('are the page’s top level, each container, and each section’s content slot, deepest marked', () => {
    const p = page();
    const specs = dropListSpecs(p.state, p.owner);
    expect(specs[0]).toEqual({ parentId: null, childIds: [p.first, p.second], depth: -1 });
    expect(specs).toContainEqual({ parentId: p.first, slot: 'content', childIds: [p.grid, p.row], depth: 0 });
    expect(specs).toContainEqual({ parentId: p.grid, childIds: [p.a, p.b], depth: 1 });
    expect(specs).toContainEqual({ parentId: p.row, childIds: [], depth: 1 });
    expect(measureIds(specs).sort()).toEqual([p.first, p.second, p.grid, p.row, p.a, p.b].sort());
  });

  it('are none while a component is being edited', () => {
    const p = page();
    expect(dropListSpecs(p.state, { kind: 'component', id: 'foundation.layout.section' })).toEqual([]);
  });
});

describe('where a section drops (#52)', () => {
  it('before, between and after the page’s sections, whatever is under the pointer', () => {
    const p = page();
    const lists = measuredLists(dropListSpecs(p.state, p.owner), p.measured);
    const at = (y: number) => dropTarget(lists, 'section', 500, y, 10, 0)!;
    expect(at(100)).toMatchObject({ index: 0, list: { parentId: null } });
    // The grid is under the pointer, but a section goes between sections: after the first one.
    expect(at(260).index).toBe(1);
    expect(at(450).index).toBe(1);
    expect(at(650).index).toBe(2);
    expect(at(650).line).toMatchObject({ y: 699 });
  });

  it('goes to the top of a page with no sections', () => {
    const state = createStarterState('blank', 'Empty', false);
    const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
    const lists = measuredLists(dropListSpecs(state, owner), new Map());
    expect(dropTarget(lists, 'section', 10, 10, 10, 0)).toMatchObject({ index: 0, line: null });
  });
});

describe('where an element drops (#52)', () => {
  it('between two cards in the grid, inside the empty row, and into the content of the section around them', () => {
    const p = page();
    const lists = measuredLists(dropListSpecs(p.state, p.owner), p.measured);
    // Over the second card's left half: between the two cards, shown by a vertical line.
    const between = dropTarget(lists, 'element', 600, 150, 10, 0)!;
    expect(between.list.parentId).toBe(p.grid);
    expect(between.index).toBe(1);
    expect(between.line!.height).toBeGreaterThan(between.line!.width);
    expect(dropTarget(lists, 'element', 950 - 60, 150, 10, 0)!.index).toBe(2);
    // The empty row: inside it, with its outline and no line.
    const row = dropTarget(lists, 'element', 500, 320, 10, 0)!;
    expect(row).toMatchObject({ index: 0, line: null, list: { parentId: p.row } });
    expect(row.list.box).toEqual(box(100, 280, 800, 80));
    // In the section, beside the grid and row (left of them): its content list.
    expect(dropTarget(lists, 'element', 50, 300, 10, 0)!.list).toMatchObject({ parentId: p.first, slot: 'content' });
  });

  it('near a container’s top or bottom edge, beside it instead of inside it', () => {
    const p = page();
    const lists = measuredLists(dropListSpecs(p.state, p.owner), p.measured);
    // Just inside the grid's top edge: into the section's content, before the grid.
    expect(dropTarget(lists, 'element', 500, 53, 10, 0)).toMatchObject({ index: 0, list: { parentId: p.first, slot: 'content' } });
    // Just inside the first section's bottom edge: between the sections, in a new section of its own.
    expect(dropTarget(lists, 'element', 500, 396, 10, 0)).toMatchObject({ index: 1, list: { parentId: null } });
  });

  it('refuses content that shows more than once, and a component that shows several slots away from them', () => {
    const p = page();
    const many = new Map(p.measured);
    many.set(p.a, { ...box(100, 50, 390, 200), many: true });
    const lists = measuredLists(dropListSpecs(p.state, p.owner), many);
    const t = dropTarget(lists, 'element', 600, 150, 10, 0)!;
    expect(t.index).toBeNull();
    expect(t.refused).toMatch(/more than once/);

    const multi = measuredLists(
      [
        { parentId: null, childIds: ['s'], depth: -1 },
        { parentId: 's', slot: 'content', childIds: ['x'], byChildren: true, depth: 0.5 },
        { parentId: 's', childIds: [], refused: 'It has more than one place for content.', depth: 0 }
      ],
      new Map([
        ['s', box(0, 0, 1000, 400)],
        ['x', box(50, 50, 400, 100)]
      ])
    );
    // Over what the Content slot holds: that slot, found by its children.
    expect(dropTarget(multi, 'element', 200, 130, 10, 0)).toMatchObject({ index: 1, list: { slot: 'content' } });
    // Elsewhere in the component: no one slot, so refused.
    expect(dropTarget(multi, 'element', 800, 300, 10, 0)).toMatchObject({ index: null, refused: 'It has more than one place for content.' });
  });

  it('leaves out a container that does not show at this width', () => {
    const p = page();
    const hidden = new Map(p.measured);
    hidden.set(p.row, null);
    const lists = measuredLists(dropListSpecs(p.state, p.owner), hidden);
    expect(lists.some((l) => l.parentId === p.row)).toBe(false);
  });
});

describe('a new node among siblings with an Order style (#52)', () => {
  const order = (orders: number[]) => (i: number) => orders[i];
  it('lands beside a sibling of its own order, in the document', () => {
    // Siblings 0..2, shown as the document has them.
    expect(insertIndex([0, 1, 2], 0, order([0, 0, 0]), 0)).toBe(0);
    expect(insertIndex([0, 1, 2], 2, order([0, 0, 0]), 0)).toBe(2);
    expect(insertIndex([0, 1, 2], 3, order([0, 0, 0]), 0)).toBe(3);
    // Sibling 0 is shown last (order 1): a gap before it is after the order-0 ones.
    expect(insertIndex([1, 2, 0], 2, order([1, 0, 0]), 0)).toBe(3);
    expect(insertIndex([1, 2, 0], 3, order([1, 0, 0]), 0)).toBeNull();
    // A hidden sibling (index 3) keeps its place: the end of the list is after it.
    expect(insertIndex([0, 1, 2], 3, order([0, 0, 0, 0]), 0, 4)).toBe(3);
    expect(insertIndex([], 0, order([]), 0, 2)).toBe(2);
  });

  it('places a component whose root has an order by that order, and refuses one whose order changes with the screen size', () => {
    // A card ordered 2 between two order-0 siblings would show after both: that gap is not reachable.
    expect(insertIndex([0, 1], 1, order([0, 0]), 2)).toBeNull();
    expect(insertIndex([0, 1], 2, order([0, 0]), 2)).toBe(2);
    expect(insertIndex([0, 1], 1, order([0, 0]), null)).toBeNull();
    expect(insertIndex([], 0, order([]), null, 0)).toBe(0);
  });

  it('reads the incoming order from a component’s root', () => {
    const p = page();
    const out = applyOperations(p.state, [{ type: 'component.createFromNode', owner: p.owner, nodeId: p.a, name: 'Artist card' }]);
    const defId = out.results[0].definitionId as string;
    const def = out.state.components[defId];
    const root = def.tree!.nodes[def.tree!.rootIds[0]] as { styles?: Record<string, Record<string, unknown>> };
    expect(incomingOrder(out.state, { definitionId: defId })).toBe(0);
    root.styles = { base: { order: 2 } };
    expect(incomingOrder(out.state, { definitionId: defId })).toBe(2);
    root.styles = { base: { order: 2 }, phone: { order: 0 } };
    expect(incomingOrder(out.state, { definitionId: defId })).toBeNull();
    expect(incomingOrder(out.state, { primitive: 'paragraph' })).toBe(0);
  });
});
