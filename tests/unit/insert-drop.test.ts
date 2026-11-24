import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ElementNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { AssetRecord, InstanceNode } from '@shared/types';
import { dropListSpecs, dropRefusal, dropTarget, incomingOrder, insertDestination, insertIndex, measuredLists, measureIds, savingProblems, type Measured } from '../../src/renderer/src/lib/insert-drop';
import { imageInsertOps } from '../../src/renderer/src/lib/image-drop';
import type { InsertAt } from '../../src/renderer/src/lib/insert-at';

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
    // An empty section takes content too.
    expect(specs).toContainEqual({ parentId: p.second, slot: 'content', childIds: [], depth: 0 });
    expect(measureIds(specs).sort()).toEqual([p.first, p.second, p.grid, p.row, p.a, p.b].sort());
  });

  it('are none while a component is being edited', () => {
    const p = page();
    const made = applyOperations(p.state, [{ type: 'component.createFromNode', owner: p.owner, nodeId: p.grid, name: 'Artist grid' }]);
    expect(dropListSpecs(made.state, { kind: 'component', id: made.results[0].definitionId as string })).toEqual([]);
  });
});

describe('where a section drops (#52)', () => {
  it('before, between and after the page’s sections, whatever is under the pointer', () => {
    const p = page();
    const lists = measuredLists(dropListSpecs(p.state, p.owner), p.measured);
    const at = (y: number) => dropTarget(lists, 'section', 500, y, 10, 0)!;
    expect(at(100)).toMatchObject({ index: 0, list: { parentId: null } });
    // The grid is under the pointer, but a section goes between sections: after the first one.
    expect(at(225).index).toBe(1);
    expect(at(225).line).toMatchObject({ y: 399 });
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

  it('leaves out a container that does not show at this width, and keeps its place among its siblings', () => {
    const p = page();
    const hidden = new Map(p.measured);
    hidden.set(p.row, null);
    const lists = measuredLists(dropListSpecs(p.state, p.owner), hidden);
    expect(lists.some((l) => l.parentId === p.row)).toBe(false);
    expect(lists.find((l) => l.parentId === p.first)!.children).toEqual([p.measured.get(p.grid), null]);
    // Below the grid in the section: after the grid, and so before the hidden row.
    expect(dropTarget(lists, 'element', 50, 300, 10, 0)).toMatchObject({ index: 1, list: { parentId: p.first } });
    // A list whose children all hide takes the new node at its end.
    const top = measuredLists([{ parentId: null, childIds: ['h'], depth: -1 }], new Map([['h', null]]));
    expect(dropTarget(top, 'section', 10, 10, 10, 0)).toMatchObject({ index: 1 });
    expect(dropTarget(top, 'section', 10, 10, 10, null)).toMatchObject({ index: 1 });
  });

  it('the deeper of two containers the same size, and an empty row that measures as a line', () => {
    const p = page();
    const same = new Map(p.measured);
    same.set(p.grid, box(0, 0, 1000, 400));
    const lists = measuredLists(dropListSpecs(p.state, p.owner), same);
    expect(dropTarget(lists, 'element', 500, 200, 10, 0)!.list.parentId).toBe(p.grid);
    const flat = new Map(p.measured);
    flat.set(p.row, box(100, 280, 800, 0));
    const thin = measuredLists(dropListSpecs(p.state, p.owner), flat);
    expect(dropTarget(thin, 'element', 500, 284, 10, 0)).toMatchObject({ index: 0, list: { parentId: p.row } });
    expect(dropTarget(thin, 'element', 500, 300, 10, 0)!.list.parentId).toBe(p.first);
    // A short container that holds something keeps its edges: just inside its top is beside it, its middle inside it.
    const short = new Map(p.measured);
    short.set(p.grid, box(100, 50, 800, 24));
    short.set(p.a, box(100, 50, 390, 24));
    short.set(p.b, box(510, 50, 390, 24));
    const held = measuredLists(dropListSpecs(p.state, p.owner), short);
    expect(dropTarget(held, 'element', 500, 53, 10, 0)!.list.parentId).toBe(p.first);
    expect(dropTarget(held, 'element', 300, 62, 10, 0)!.list.parentId).toBe(p.grid);
  });

  it('between two containers side by side, near the edge they share', () => {
    const p = page();
    // Two stacks fill a row with no gap between them.
    const out = applyOperations(p.state, [
      { type: 'node.insert', owner: p.owner, parentId: p.row, primitive: 'stack' },
      { type: 'node.insert', owner: p.owner, parentId: p.row, primitive: 'stack' }
    ]);
    const [left, right] = out.results.map((r) => r.nodeId as string);
    const m = new Map(p.measured);
    m.set(p.row, box(100, 280, 800, 200));
    m.set(left, box(100, 280, 400, 200));
    m.set(right, box(500, 280, 400, 200));
    const lists = measuredLists(dropListSpecs(out.state, p.owner), m);
    expect(lists.find((l) => l.parentId === left)!.sideways).toBe(true);
    // Well inside the right stack: into it.
    expect(dropTarget(lists, 'element', 700, 380, 10, 0)!.list.parentId).toBe(right);
    // At the seam: into the row, between the two.
    expect(dropTarget(lists, 'element', 503, 380, 10, 0)).toMatchObject({ index: 1, list: { parentId: p.row } });
    // A section filling the page's width is no column: its left edge still drops inside it.
    expect(lists.find((l) => l.parentId === p.first)!.sideways).toBeUndefined();
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
    // A hidden last sibling (index 3): the gap after the last one shown is before it, in the document.
    expect(insertIndex([0, 1, 2], 3, order([0, 0, 0, 0]), 0, 4)).toBe(3);
    expect(insertIndex([], 0, order([]), 0, 2)).toBe(2);
    // Negative orders count like any other.
    expect(insertIndex([0, 1], 1, order([-2, 0]), -2)).toBe(1);
  });

  it('places a component whose root has an order by that order, and refuses one whose order changes with the screen size', () => {
    // A card ordered 2 between two order-0 siblings would show after both: that gap is not reachable.
    expect(insertIndex([0, 1], 1, order([0, 0]), 2)).toBeNull();
    expect(insertIndex([0, 1], 2, order([0, 0]), 2)).toBe(2);
    expect(insertIndex([0, 1], 1, order([0, 0]), null)).toBeNull();
    expect(insertIndex([], 0, order([]), null, 0)).toBe(0);
    // Every sibling hidden here: it is the only one shown, wherever it goes.
    expect(insertIndex([], 0, () => 0, null, 2)).toBe(2);
  });

  it('counts the new node’s order only where its container lays items out by order', () => {
    const p = page();
    const ordered = new Map(p.measured);
    ordered.set(p.a, { ...box(100, 50, 390, 200), ordered: true });
    ordered.set(p.b, { ...box(510, 50, 390, 200), ordered: true });
    // A card ordered 2 shows after both cells of a flex or grid container: the gap between them is not reachable.
    expect(dropTarget(measuredLists(dropListSpecs(p.state, p.owner), ordered), 'element', 600, 150, 10, 2)).toMatchObject({ index: null });
    // Laid out as they come, Order does nothing: the gap is.
    expect(dropTarget(measuredLists(dropListSpecs(p.state, p.owner), p.measured), 'element', 600, 150, 10, 2)).toMatchObject({ index: 1 });
    expect(dropTarget(measuredLists(dropListSpecs(p.state, p.owner), p.measured), 'element', 600, 150, 10, null)).toMatchObject({ index: 1 });
  });

  it('puts an element dropped between sections in a Section of its own, whatever its own order', () => {
    const p = page();
    const lists = measuredLists(dropListSpecs(p.state, p.owner), p.measured);
    expect(dropTarget(lists, 'element', 500, 396, 10, 5)).toMatchObject({ index: 1, list: { parentId: null } });
    expect(dropTarget(lists, 'element', 500, 396, 10, null)).toMatchObject({ index: 1, list: { parentId: null } });
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
    root.styles = { phone: { order: 2 } };
    expect(incomingOrder(out.state, { definitionId: defId })).toBeNull();
    root.styles = { base: { order: 2 }, phone: { order: 2 } };
    expect(incomingOrder(out.state, { definitionId: defId })).toBe(2);
    expect(incomingOrder(out.state, { primitive: 'paragraph' })).toBe(0);
    // A variant option it is inserted with can order its root too.
    root.styles = {};
    def.variantAxes = { look: { label: 'Look', default: 'plain', options: { plain: { label: 'Plain' }, last: { label: 'Last', styles: { [def.tree!.rootIds[0]]: { base: { order: 3 } } } } } } };
    expect(incomingOrder(out.state, { definitionId: defId })).toBe(0);
    expect(incomingOrder(out.state, { definitionId: defId, variants: { look: 'last' } })).toBe(3);
    // The variant's Order wins over the design's at every size it sets, so it is one Order throughout.
    root.styles = { base: { order: 0 } };
    def.variantAxes.look.options.last.styles = { [def.tree!.rootIds[0]]: { base: { order: 2 }, phone: { order: 2 } } };
    expect(incomingOrder(out.state, { definitionId: defId, variants: { look: 'last' } })).toBe(2);
    // The design's phone Order still shows on a phone under a variant that sets only the base one.
    root.styles = { phone: { order: 1 } };
    def.variantAxes.look.options.last.styles = { [def.tree!.rootIds[0]]: { base: { order: 2 } } };
    expect(incomingOrder(out.state, { definitionId: defId, variants: { look: 'last' } })).toBeNull();
  });
});

describe('what the project would refuse (#52)', () => {
  it('says why, for what the operation refuses and for a problem that stops saving', () => {
    const p = page();
    const before = () => savingProblems(p.state);
    expect(dropRefusal(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.a, primitive: 'paragraph' }], before)).toMatch(/.+/);
    expect(dropRefusal(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.grid, primitive: 'button' }], before)).toBeNull();
    // The grid becomes a card that links somewhere: a button can't go inside it.
    (p.state.pages[p.owner.id].nodes[p.grid] as ElementNode).link = { type: 'url', target: 'https://example.com/artists' };
    const linked = () => savingProblems(p.state);
    expect(linked()).toEqual([]);
    expect(dropRefusal(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.grid, primitive: 'button' }], linked)).toMatch(/inside a card that links somewhere/);
    expect(dropRefusal(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.grid, primitive: 'paragraph' }], linked)).toBeNull();
  });
});

describe('an Assets image dropped between content (#506)', () => {
  const photo: AssetRecord = {
    id: 'img_portrait',
    name: 'Portrait',
    file: 'static/assets/portrait.png',
    mime: 'image/png',
    bytes: 1000,
    width: 800,
    height: 1000,
    hash: 'portrait',
    kind: 'image',
    altSuggestion: 'A portrait of the artist',
    createdAt: '2026-11-25T09:00:00.000Z'
  };
  /** The page as in #52, with the portrait in Assets and an empty Stack in the row (a column to fill). */
  function withPortrait() {
    const p = page();
    const out = applyOperations(p.state, [
      { type: 'asset.add', asset: photo },
      { type: 'node.insert', owner: p.owner, parentId: p.row, primitive: 'stack' }
    ]);
    const stack = out.results[1].nodeId as string;
    const measured = new Map(p.measured).set(stack, box(100, 280, 400, 80));
    const dest = insertDestination(out.state, p.owner, 'element', 0, (at) => imageInsertOps(at, photo.id, 'n_portrait'));
    const lists = measuredLists(dest.specs, measured);
    /** Where a drop at (x, y) goes, and the page once the image is there. */
    const drop = (x: number, y: number) => {
      const aim = dest.aim(lists, x, y, 1)!;
      return { aim, after: aim.at ? applyOperations(out.state, imageInsertOps(aim.at, photo.id, 'n_portrait')).state.pages[p.owner.id] : null };
    };
    return { ...p, state: out.state, stack, dest, lists, drop };
  }
  const image = { kind: 'image', image: { assetId: photo.id, alt: photo.altSuggestion } };

  it('between two sections: in a Section of its own, shown by a line between them', () => {
    const p = withPortrait();
    const { aim, after } = p.drop(500, 396);
    expect(aim).toMatchObject({ at: { owner: p.owner, parentId: null, index: 1 }, refused: null, where: { lead: 'in a new section after' } });
    expect(aim.line).toMatchObject({ y: 399 });
    expect(after!.rootIds).toHaveLength(3);
    expect([after!.rootIds[0], after!.rootIds[2]]).toEqual([p.first, p.second]);
    const made = after!.nodes[after!.rootIds[1]] as InstanceNode;
    expect(made.slots!.content).toEqual(['n_portrait']);
    expect(after!.nodes.n_portrait).toMatchObject(image);
  });

  it('between two elements inside a section, and between two cards in a grid', () => {
    const p = withPortrait();
    // In the section, beside the grid and below it: after the grid, before the row.
    const inSection = p.drop(50, 265);
    expect(inSection.aim).toMatchObject({ at: { parentId: p.first, slot: 'content', index: 1 }, refused: null });
    expect(inSection.aim.line).not.toBeNull();
    expect((inSection.after!.nodes[p.first] as InstanceNode).slots!.content).toEqual([p.grid, 'n_portrait', p.row]);
    expect(inSection.after!.nodes.n_portrait).toMatchObject(image);
    // Over the second card's left half: between the two cards.
    const inGrid = p.drop(600, 150);
    expect(inGrid.aim).toMatchObject({ at: { parentId: p.grid, index: 1 }, where: { lead: 'after' } });
    expect((inGrid.after!.nodes[p.grid] as ElementNode).children).toEqual([p.a, 'n_portrait', p.b]);
  });

  it('inside an empty column, shown by the column’s outline alone', () => {
    const p = withPortrait();
    const { aim, after } = p.drop(300, 320);
    expect(aim).toMatchObject({ at: { parentId: p.stack, index: 0 }, line: null, outline: box(100, 280, 400, 80), where: { lead: 'inside' } });
    expect((after!.nodes[p.stack] as ElementNode).children).toEqual(['n_portrait']);
  });

  it('shows no line where an Image can’t go, and has no place to drop it', () => {
    const p = withPortrait();
    // Sections take only text in their content: neither the empty second section nor a new one between them takes it.
    const def = p.state.components[(p.state.pages[p.owner.id].nodes[p.second] as InstanceNode).definitionId];
    def.slots!.content = { ...def.slots!.content, primitives: ['text'] };
    const dest = insertDestination(p.state, p.owner, 'element', 0, (at: InsertAt) => imageInsertOps(at, photo.id, 'n_portrait'));
    for (const [x, y] of [
      [500, 550],
      [500, 396]
    ]) {
      const aim = dest.aim(measuredLists(dest.specs, new Map(p.measured)), x, y, 1)!;
      expect(aim).toMatchObject({ at: null, line: null, where: null });
      expect(aim.refused).toMatch(/takes text, not an image/);
    }
  });
});
