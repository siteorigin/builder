import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ElementNode, OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import type { AssetRecord, InstanceNode } from '@shared/types';
import { dropListSpecs, dropRefusal, dropTarget, incomingOrder, insertDestination, insertIndex, INSIDE_ITSELF, measuredLists, measureIds, MOVE_TOP, MOVE_UNSHOWN, moveDestination, savingProblems, slotKey, slotOfKey, type Measured } from '../../src/renderer/src/lib/insert-drop';
import { imageInsertOps } from '../../src/renderer/src/lib/image-drop';
import { insertOps, nodeLabel, type InsertAt } from '../../src/renderer/src/lib/insert-at';

/**
 * Dragging an Insert tile onto the page (#52): the lists a drop can go into, and the list and gap under the pointer.
 */

const box = (x: number, y: number, width: number, height: number, order = 0): Measured => ({ x, y, width, height, order });
/** A plain box, as an empty slot's drop surface is (see measuredLists). */
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

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
    // An empty section takes content too, anywhere in it: its one slot is the section's whole content area.
    expect(specs).toContainEqual({ parentId: p.second, slot: 'content', childIds: [], depth: 0 });
    expect(specs.some((l) => l.byPlaceholder)).toBe(false);
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

  it('reads the incoming order of a theme component from the project’s installed copy, else the theme’s (#664)', () => {
    let s = createStarterState('blank', 'Order', false);
    const owner: OwnerRef = { kind: 'page', id: s.site.homePageId };
    expect(incomingOrder(s, { componentId: 'block.stat' })).toBe(0);
    // Not installed yet: the theme's own design says.
    const shipped = catalogueComponent(s.site.themeId, 'block.stat')!;
    const shippedRoot = shipped.tree!.nodes[shipped.tree!.rootIds[0]] as { styles?: Record<string, Record<string, unknown>> };
    const kept = shippedRoot.styles;
    try {
      shippedRoot.styles = { ...kept, base: { ...(kept?.base ?? {}), order: 4 } };
      expect(incomingOrder(s, { componentId: 'block.stat' })).toBe(4);
    } finally {
      shippedRoot.styles = kept;
    }
    s = applyOperations(s, [
      { type: 'node.insert', newNodeId: 'n_sec', owner, parentId: null, componentId: 'layout.section' },
      { type: 'node.insert', owner, parentId: 'n_sec', slot: 'content', componentId: 'block.stat' }
    ]).state;
    const def = s.components['foundation.block.stat'];
    (def.tree!.nodes[def.tree!.rootIds[0]] as { styles?: Record<string, Record<string, unknown>> }).styles = { base: { order: 3 } };
    expect(incomingOrder(s, { componentId: 'block.stat' })).toBe(3);
    // A tone it is inserted with can order its root too.
    def.variantAxes!.tone.options.muted.styles = { ...def.variantAxes!.tone.options.muted.styles, [def.tree!.rootIds[0]]: { base: { order: 5 } } };
    expect(incomingOrder(s, { componentId: 'block.stat', variants: { tone: 'muted' } })).toBe(5);
    expect(incomingOrder(s, { componentId: 'no.such' })).toBe(0);
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
    expect(aim.line).toEqual(dropTarget(p.lists, 'element', 500, 396, 10, 0)!.line);
    expect(aim.line!.width).toBeGreaterThan(aim.line!.height);
    expect(aim.line).toMatchObject({ y: 399 });
    expect(after!.rootIds).toHaveLength(3);
    expect([after!.rootIds[0], after!.rootIds[2]]).toEqual([p.first, p.second]);
    const made = after!.nodes[after!.rootIds[1]] as InstanceNode;
    expect(p.state.components[made.definitionId].componentId).toBe('layout.section');
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
    // A vertical line between the two cards.
    expect(inGrid.aim.line!.height).toBeGreaterThan(inGrid.aim.line!.width);
    expect((inGrid.after!.nodes[p.grid] as ElementNode).children).toEqual([p.a, 'n_portrait', p.b]);
  });

  it('inside an empty column, shown by the column’s outline alone, drawn at least 4 screen pixels tall', () => {
    const p = withPortrait();
    const { aim, after } = p.drop(300, 320);
    expect(aim).toMatchObject({ at: { parentId: p.stack, index: 0 }, line: null, outline: box(100, 280, 400, 80), where: { lead: 'inside' } });
    expect((after!.nodes[p.stack] as ElementNode).children).toEqual(['n_portrait']);
    // A column with nothing in it yet measures as a line: still the column, outlined 4px tall around it at half scale.
    const flat = p.dest.lists(new Map(p.measured).set(p.stack, box(100, 300, 400, 0)));
    expect(p.dest.aim(flat, 300, 300, 0.5)).toMatchObject({ at: { parentId: p.stack, index: 0 }, line: null, outline: { x: 100, y: 296, width: 400, height: 8 } });
  });

  it('says to use Place on page where a drop can’t reach, not to click a tile', () => {
    const p = withPortrait();
    const many = new Map(p.measured).set(p.a, { ...box(100, 50, 390, 200), many: true });
    const assets = insertDestination(p.state, p.owner, 'element', 0, (at) => imageInsertOps(at, photo.id, 'n_portrait'), 'use Place on page');
    expect(assets.aim(assets.lists(many), 600, 150, 1)!.refused).toBe('This content shows more than once on the page. Select a place inside it and use Place on page instead.');
    expect(p.dest.aim(p.dest.lists(many), 600, 150, 1)!.refused).toBe('This content shows more than once on the page. Select a place inside it and click the tile instead.');
  });

  it('shows no line where an Image can’t go, and has no place to drop it', () => {
    const p = withPortrait();
    // Sections take only text in their content: neither the empty second section nor a new one between them takes it.
    const def = p.state.components[(p.state.pages[p.owner.id].nodes[p.second] as InstanceNode).definitionId];
    def.slots!.content = { ...def.slots!.content, primitives: ['text'] };
    const dest = insertDestination(p.state, p.owner, 'element', 0, (at: InsertAt) => imageInsertOps(at, photo.id, 'n_portrait'));
    const lists = dest.lists(new Map(p.measured).set(p.stack, box(100, 280, 400, 80)));
    for (const [x, y] of [
      [500, 550],
      [500, 396]
    ]) {
      const aim = dest.aim(lists, x, y, 1)!;
      expect(aim).toMatchObject({ at: null, line: null, where: null });
      expect(aim.refused).toMatch(/takes text, not an image/);
    }
    // Each place is checked for itself: the column, which no slot holds, still takes it, before and after a refused one.
    const fresh = insertDestination(p.state, p.owner, 'element', 0, (at: InsertAt) => imageInsertOps(at, photo.id, 'n_portrait'));
    const freshLists = fresh.lists(new Map(p.measured).set(p.stack, box(100, 280, 400, 80)));
    expect(fresh.aim(freshLists, 300, 320, 1)).toMatchObject({ at: { parentId: p.stack }, refused: null });
    expect(fresh.aim(freshLists, 500, 550, 1)).toMatchObject({ at: null });
    expect(lists && dest.aim(lists, 300, 320, 1)).toMatchObject({ at: { parentId: p.stack }, refused: null });
  });
});

/**
 * A component that shows two slots side by side (#652): Main, which takes anything, and Sidebar, which takes only
 * text, placed in the page's second section with both slots empty.
 */
const slotPhoto: AssetRecord = {
  id: 'img_hours',
  name: 'Hours',
  file: 'static/assets/hours.png',
  mime: 'image/png',
  bytes: 1000,
  width: 800,
  height: 600,
  hash: 'hours',
  kind: 'image',
  altSuggestion: 'Opening hours',
  createdAt: '2026-11-25T09:00:00.000Z'
};

function withSplit() {
  const p = page();
  const made = applyOperations(p.state, [
    { type: 'asset.add', asset: slotPhoto },
    {
      type: 'component.upsert',
      name: 'Split',
      insertAs: 'element',
      properties: {},
      nodes: [
        { kind: 'element', id: 'root', children: ['mainCol', 'sideCol'], styles: { base: { layout: 'grid', columns: 2 } } },
        { kind: 'element', id: 'mainCol', children: ['main'] },
        { kind: 'slot', id: 'main', slot: 'main' },
        { kind: 'element', id: 'sideCol', children: ['side'] },
        { kind: 'slot', id: 'side', slot: 'sidebar' }
      ],
      slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar', primitives: ['text'] } }
    }
  ]);
  const definitionId = made.results[1].definitionId as string;
  const placed = applyOperations(made.state, [{ type: 'node.insert', owner: p.owner, parentId: p.second, slot: 'content', definitionId }]);
  const split = placed.results[0].nodeId as string;
  // Laid out in the second section: the split under its top, each slot's placeholder 72px tall in its column.
  const measured = new Map(p.measured)
    .set(split, box(100, 450, 800, 150))
    .set(slotKey(split, 'main'), box(100, 450, 390, 72))
    .set(slotKey(split, 'sidebar'), box(510, 450, 390, 72));
  return { ...p, state: placed.state, definitionId, split, measured };
}

describe('the slots of a component that shows several (#652)', () => {
  it('are each a list of their own, found by their placeholder while empty, with the rest of the component naming none', () => {
    const p = withSplit();
    const specs = dropListSpecs(p.state, p.owner);
    expect(specs).toContainEqual({ parentId: p.split, slot: 'main', childIds: [], byPlaceholder: true, depth: 1.5 });
    expect(specs).toContainEqual({ parentId: p.split, slot: 'sidebar', childIds: [], byPlaceholder: true, depth: 1.5 });
    expect(specs).toContainEqual({ parentId: p.split, childIds: [], refused: 'It has more than one place for content. Drop it onto one of them, or select one and click the tile.', depth: 1 });
    // Each placeholder is measured by its slot key, beside the node IDs.
    expect(measureIds(specs)).toEqual(expect.arrayContaining([p.split, slotKey(p.split, 'main'), slotKey(p.split, 'sidebar')]));
    expect(slotOfKey(slotKey(p.split, 'sidebar'))).toEqual({ parentId: p.split, slot: 'sidebar' });
    expect(slotOfKey(p.split)).toBeNull();
  });

  it('take a drop on their placeholder, edge to edge, and refuse one beside them in the component', () => {
    const p = withSplit();
    const lists = measuredLists(dropListSpecs(p.state, p.owner), p.measured);
    expect(dropTarget(lists, 'element', 300, 486, 10, 0)).toMatchObject({ index: 0, line: null, list: { parentId: p.split, slot: 'main' } });
    expect(dropTarget(lists, 'element', 700, 486, 10, 0)).toMatchObject({ index: 0, line: null, list: { parentId: p.split, slot: 'sidebar' } });
    // Right at a placeholder's edge: still that slot, not beside it.
    expect(dropTarget(lists, 'element', 700, 451, 10, 0)!.list).toMatchObject({ slot: 'sidebar' });
    expect(dropTarget(lists, 'element', 510, 486, 10, 0)!.list).toMatchObject({ slot: 'sidebar' });
    // Below both placeholders, in the component: no one slot.
    expect(dropTarget(lists, 'element', 500, 570, 10, 0)).toMatchObject({ index: null, refused: expect.stringMatching(/more than one place/) });
  });

  it('measure at least 72px tall however collapsed their column is, and two collapsed in one place are laid out apart', () => {
    const p = withSplit();
    const specs = dropListSpecs(p.state, p.owner);
    const slotBox = (m: Map<string, Measured | null>, slot: string) => measuredLists(specs, m).find((l) => l.slot === slot)!.box;
    // A column with no height: the surface is 72px tall from where it starts.
    expect(slotBox(new Map(p.measured).set(slotKey(p.split, 'sidebar'), box(510, 450, 390, 0)), 'sidebar')).toEqual(rect(510, 450, 390, 72));
    // Its width is the placeholder's own: a wider surface would reach into the next column.
    expect(slotBox(new Map(p.measured).set(slotKey(p.split, 'sidebar'), box(700, 450, 30, 72)), 'sidebar')).toEqual(rect(700, 450, 30, 72));
    // Both columns collapsed onto one line: Sidebar goes below Main, and a drop finds each.
    const flat = new Map(p.measured).set(slotKey(p.split, 'main'), box(100, 450, 800, 0)).set(slotKey(p.split, 'sidebar'), box(100, 450, 800, 0));
    const lists = measuredLists(specs, flat);
    expect(lists.find((l) => l.slot === 'main')!.box).toEqual(rect(100, 450, 800, 72));
    expect(lists.find((l) => l.slot === 'sidebar')!.box).toEqual(rect(100, 522, 800, 72));
    expect(dropTarget(lists, 'element', 500, 480, 10, 0)!.list).toMatchObject({ slot: 'main' });
    expect(dropTarget(lists, 'element', 500, 560, 10, 0)!.list).toMatchObject({ slot: 'sidebar' });
  });

  it('leave out a slot the component does not show, and refuse one it shows more than once', () => {
    const p = withSplit();
    const specs = dropListSpecs(p.state, p.owner);
    const hidden = measuredLists(specs, new Map(p.measured).set(slotKey(p.split, 'sidebar'), null));
    expect(hidden.some((l) => l.slot === 'sidebar')).toBe(false);
    const many = measuredLists(specs, new Map(p.measured).set(slotKey(p.split, 'sidebar'), { ...box(510, 450, 390, 72), many: true }));
    expect(dropTarget(many, 'element', 700, 486, 10, 0)).toMatchObject({ index: null, refused: expect.stringMatching(/more than once/) });
    // Nor is one shown more than once drawn as a place to drop.
    const para = insertDestination(p.state, p.owner, 'element', 0, (at) => insertOps(at, { primitive: 'paragraph' }, 'element'));
    expect(para.surfaces(para.lists(new Map(p.measured).set(slotKey(p.split, 'sidebar'), { ...box(510, 450, 390, 72), many: true }))).map((s) => s.label)).toEqual(['Main']);
  });

  it('give way where a surface is bigger than its placeholder to what the page shows beside it, never to what holds it', () => {
    const p = withSplit();
    // A Stack after the Split in the section, and a Sidebar placeholder only 30px tall: its surface reaches the Stack.
    const after = applyOperations(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.second, slot: 'content', primitive: 'stack' }]);
    const stack = after.results[0].nodeId as string;
    const specs = dropListSpecs(after.state, p.owner);
    const short = new Map(p.measured).set(p.split, box(100, 450, 800, 30)).set(slotKey(p.split, 'sidebar'), box(510, 450, 390, 30)).set(stack, box(100, 500, 800, 60));
    const lists = measuredLists(specs, short);
    expect(lists.find((l) => l.slot === 'sidebar')!.box).toEqual(rect(510, 450, 390, 72));
    // Over the Stack, the Stack; on the placeholder, Sidebar; below it where only the section shows, Sidebar's surface.
    expect(dropTarget(lists, 'element', 700, 510, 10, 0)!.list).toMatchObject({ parentId: stack });
    expect(dropTarget(lists, 'element', 700, 465, 10, 0)!.list).toMatchObject({ slot: 'sidebar' });
    expect(dropTarget(lists, 'element', 700, 490, 10, 0)!.list).toMatchObject({ slot: 'sidebar' });
  });

  it('count a placeholder by what its component shows of it, and never reach sideways out of the component', () => {
    const p = withSplit();
    const inStack = applyOperations(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.second, slot: 'content', primitive: 'stack' }]);
    const stack = inStack.results[0].nodeId as string;
    const moved = applyOperations(inStack.state, [{ type: 'node.move', owner: p.owner, nodeId: p.split, parentId: stack, index: 0 }]).state;
    const specs = dropListSpecs(moved, p.owner);
    // A Split 30px tall in a Stack 40px tall, clipping its 72px placeholders: on what shows of Sidebar, Sidebar, not the
    // Stack around it (which is smaller than Sidebar's whole surface, though not than what shows of it).
    const clipped = new Map(p.measured)
      .set(stack, box(100, 450, 400, 40))
      .set(p.split, box(100, 450, 400, 30))
      .set(slotKey(p.split, 'main'), null)
      .set(slotKey(p.split, 'sidebar'), box(110, 450, 380, 72));
    expect(dropTarget(measuredLists(specs, clipped), 'element', 300, 465, 10, 0)!.list).toMatchObject({ slot: 'sidebar' });
    // Below the Split, in a taller Stack, where the clipped part of Sidebar's surface reaches: the Stack.
    const tall = new Map(clipped).set(stack, box(100, 450, 400, 60)).set(p.split, box(100, 450, 400, 24));
    expect(dropTarget(measuredLists(specs, tall), 'element', 300, 490, 10, 0)!.list).toMatchObject({ parentId: stack });
    // A Split 20px wide whose Main placeholder spills 16px to its right: the spill is not Main's.
    const narrow = new Map(p.measured).set(p.split, box(100, 450, 20, 150)).set(slotKey(p.split, 'main'), box(100, 450, 36, 72)).set(slotKey(p.split, 'sidebar'), box(100, 522, 20, 72));
    const lists = measuredLists(dropListSpecs(p.state, p.owner), narrow);
    expect(lists.find((l) => l.slot === 'main')!.box).toEqual(rect(100, 450, 20, 72));
    expect(dropTarget(lists, 'element', 130, 480, 10, 0)!.list).not.toMatchObject({ slot: 'main' });
  });

  it('lay out apart only the placeholders of one component', () => {
    const p = withSplit();
    const two = applyOperations(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.second, slot: 'content', definitionId: p.definitionId }]);
    const other = two.results[0].nodeId as string;
    // A second Split whose placeholders sit where the first one's surfaces reach: each stays where its page shows it.
    const measured = new Map(p.measured).set(other, box(100, 480, 800, 150)).set(slotKey(other, 'main'), box(100, 480, 390, 72)).set(slotKey(other, 'sidebar'), box(510, 480, 390, 72));
    const lists = measuredLists(dropListSpecs(two.state, p.owner), measured);
    expect(lists.find((l) => l.parentId === other && l.slot === 'main')!.box).toEqual(rect(100, 480, 390, 72));
  });

  it('take a drop anywhere on a placeholder, before the component around it names no one slot', () => {
    const p = withSplit();
    // A component as small as its placeholders: its own box is smaller than Main's surface.
    const tiny = new Map(p.measured).set(p.split, box(100, 450, 60, 24)).set(slotKey(p.split, 'main'), box(100, 450, 30, 72)).set(slotKey(p.split, 'sidebar'), box(130, 450, 30, 72));
    const lists = measuredLists(dropListSpecs(p.state, p.owner), tiny);
    expect(dropTarget(lists, 'element', 110, 460, 10, 0)!.list).toMatchObject({ slot: 'main' });
  });

  it('find a filled slot whose content all hides here by its placeholder', () => {
    const p = withSplit();
    const filled = applyOperations(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.split, slot: 'sidebar', primitive: 'paragraph', text: 'Closed Mondays' }]);
    const para = filled.results[0].nodeId as string;
    const specs = dropListSpecs(filled.state, p.owner);
    expect(measureIds(specs)).toContain(slotKey(p.split, 'sidebar'));
    const lists = measuredLists(specs, new Map(p.measured).set(para, null));
    expect(dropTarget(lists, 'element', 700, 486, 10, 0)).toMatchObject({ index: 1, list: { slot: 'sidebar', byPlaceholder: true } });
  });
});


/** Insert `ops` into `state`, returning the new state and the IDs the inserts made. */
function inserted(state: ProjectState, ops: EditOperation[]) {
  const out = applyOperations(state, ops);
  return { state: out.state, ids: out.results.map((r) => r.nodeId as string) };
}

describe('dragging an existing element across columns and slots (#658)', () => {
  /** The Split with a Paragraph and an Image in Main, measured where they show; Sidebar empty. */
  function filledSplit() {
    const p = withSplit();
    const { state, ids } = inserted(p.state, [
      { type: 'node.insert', owner: p.owner, parentId: p.split, slot: 'main', primitive: 'paragraph', text: 'Open daily' },
      { type: 'node.insert', owner: p.owner, parentId: p.split, slot: 'main', primitive: 'image', props: { src: { assetId: slotPhoto.id }, alt: 'Hours' } }
    ]);
    const [para, img] = ids;
    const measured = new Map(p.measured).set(slotKey(p.split, 'main'), null).set(para, box(100, 450, 390, 40)).set(img, box(100, 495, 390, 100));
    return { ...p, state, para, img, measured };
  }
  const nodes = (state: ProjectState, owner: OwnerRef) => state.pages[owner.id].nodes;

  it('moves a paragraph from one slot of a placement into another, as one node.move that keeps the node as it was', () => {
    const p = filledSplit();
    const dest = moveDestination(p.state, p.owner, p.para)!;
    expect(dest.role).toBe('element');
    const lists = dest.lists(p.measured);
    const aim = dest.aim(lists, 700, 486, 1)!;
    expect(aim).toMatchObject({ op: { type: 'node.move', owner: p.owner, nodeId: p.para, parentId: p.split, slot: 'sidebar', index: 0 }, refused: null, line: null });
    expect(aim.where).toMatchObject({ lead: 'inside', target: 'Sidebar', within: 'Split' });
    // Sidebar is drawn as a place it can go while the drag runs.
    expect(dest.surfaces(lists).map((sf) => sf.label)).toEqual(['Sidebar']);
    const before = nodes(p.state, p.owner)[p.para];
    const after = applyOperations(p.state, [aim.op!]).state;
    const split = nodes(after, p.owner)[p.split] as InstanceNode;
    expect(split.slots).toMatchObject({ main: [p.img], sidebar: [p.para] });
    expect(nodes(after, p.owner)[p.para]).toEqual(before);
  });

  it('refuses, live, a slot whose contract does not take it, and draws no surface for it', () => {
    const p = filledSplit();
    const dest = moveDestination(p.state, p.owner, p.img)!;
    const lists = dest.lists(p.measured);
    const aim = dest.aim(lists, 700, 486, 1)!;
    expect(aim).toMatchObject({ op: null, line: null, where: null });
    expect(aim.refused).toMatch(/takes text, not an image/);
    expect(dest.surfaces(lists)).toEqual([]);
  });

  it('moves a card out of one column of a grid into an empty row, and into the content of another section', () => {
    const p = withSplit();
    const dest = moveDestination(p.state, p.owner, p.a)!;
    const lists = dest.lists(p.measured);
    expect(dest.aim(lists, 500, 320, 1)).toMatchObject({ op: { parentId: p.row, index: 0 }, refused: null });
    // Below the Split in the second section: after it, in that section's content.
    expect(dest.aim(lists, 500, 650, 1)).toMatchObject({ op: { parentId: p.second, slot: 'content', index: 1 }, refused: null, where: { lead: 'after' } });
  });

  it('among its own siblings, counts the gap with itself taken out, and moves nothing beside its own place', () => {
    const p = page();
    const dest = moveDestination(p.state, p.owner, p.a)!;
    const lists = dest.lists(p.measured);
    // Past the right half of Bo: after it, which is index 1 once Ada is taken out.
    const aim = dest.aim(lists, 800, 150, 1)!;
    expect(aim).toMatchObject({ op: { parentId: p.grid, index: 1 }, refused: null });
    expect(aim.line).not.toBeNull();
    // Named in the project as the move leaves it: after Bo, never after itself.
    expect(aim.where).toMatchObject({ lead: 'after', within: 'Grid' });
    expect(aim.where!.target).toBe(nodeLabel(p.state, p.owner, p.b));
    expect(applyOperations(p.state, [aim.op!]).state.pages[p.owner.id].nodes[p.grid]).toMatchObject({ children: [p.b, p.a] });
    // On either gap beside it: nothing to do, and nothing refused.
    expect(dest.aim(lists, 200, 150, 1)).toMatchObject({ op: null, refused: null, line: null });
    expect(dest.aim(lists, 495, 150, 1)).toMatchObject({ op: null, refused: null, line: null });
  });

  it('refuses a place inside itself, and the page’s top level for an element', () => {
    const p = page();
    const grid = moveDestination(p.state, p.owner, p.grid)!;
    const lists = grid.lists(p.measured);
    // On the grid's own cards: the grid's own list.
    expect(grid.aim(lists, 300, 150, 1)).toMatchObject({ op: null, refused: INSIDE_ITSELF });
    // Near the first section's top edge, between sections: an element takes no new Section around it there.
    expect(grid.aim(lists, 500, 3, 1)).toMatchObject({ op: null, refused: MOVE_TOP });
  });

  it('moves a section only among the page’s sections', () => {
    const p = page();
    const dest = moveDestination(p.state, p.owner, p.first)!;
    expect(dest.role).toBe('section');
    expect(dest.specs.every((l) => l.parentId === null)).toBe(true);
    const lists = dest.lists(p.measured);
    expect(dest.aim(lists, 500, 650, 1)).toMatchObject({ op: { parentId: null, index: 1 }, refused: null });
    expect(dest.aim(lists, 500, 100, 1)).toMatchObject({ op: null, refused: null });
  });

  it('refuses a move that would stop the project saving, such as a button into a card that links somewhere', () => {
    const p = page();
    const { state, ids } = inserted(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.second, slot: 'content', primitive: 'button' }]);
    const [button] = ids;
    (state.pages[p.owner.id].nodes[p.row] as ElementNode).link = { type: 'url', target: 'https://example.com/artists' };
    const dest = moveDestination(state, p.owner, button)!;
    const lists = dest.lists(new Map(p.measured).set(button, box(100, 450, 200, 40)));
    const aim = dest.aim(lists, 500, 320, 1)!;
    expect(aim.op).toBeNull();
    expect(aim.refused).toMatch(/inside a card that links somewhere/);
    // A plain container still takes it.
    expect(dest.aim(lists, 300, 150, 1)).toMatchObject({ op: { parentId: p.grid }, refused: null });
    // A problem the project already has is not this move's: with a button already in the linked row, a move elsewhere is taken.
    const blocked = inserted(state, [{ type: 'node.insert', owner: p.owner, parentId: p.row, primitive: 'button' }]).state;
    expect(savingProblems(blocked).length).toBeGreaterThan(0);
    const again = moveDestination(blocked, p.owner, button)!;
    expect(again.aim(again.lists(new Map(p.measured).set(button, box(100, 450, 200, 40))), 300, 150, 1)).toMatchObject({ op: { parentId: p.grid }, refused: null });
  });

  it('lands in another list by its own Order, even one its block container ignores', () => {
    const p = page();
    const { state, ids } = inserted(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.second, slot: 'content', primitive: 'paragraph', text: 'Late' }]);
    const [late] = ids;
    // The grid lays its cards out by Order (both 0); the late paragraph's own Order is 2, which its section ignores.
    const measured = new Map(p.measured)
      .set(p.a, { ...box(100, 50, 390, 200), ordered: true })
      .set(p.b, { ...box(510, 50, 390, 200), ordered: true })
      .set(late, { ...box(100, 450, 800, 40), cssOrder: 2 });
    const dest = moveDestination(state, p.owner, late)!;
    const lists = dest.lists(measured);
    // Between the cards the grid would show it after both: refused there, taken after them.
    expect(dest.aim(lists, 495, 150, 1)).toMatchObject({ op: null, refused: expect.stringMatching(/Order style/) });
    expect(dest.aim(lists, 800, 150, 1)).toMatchObject({ op: { parentId: p.grid, index: 2 }, refused: null });
  });

  it('names the place by the node it lands after, never by itself', () => {
    const p = page();
    const { state, ids } = inserted(p.state, [{ type: 'node.insert', owner: p.owner, parentId: p.grid, index: 0, primitive: 'heading', text: 'Artists' }]);
    const [heading] = ids;
    expect(nodeLabel(state, p.owner, heading)).not.toBe(nodeLabel(state, p.owner, p.a));
    // The heading, Ada and Bo side by side in the grid.
    const measured = new Map(p.measured).set(heading, box(100, 50, 250, 200)).set(p.a, box(370, 50, 250, 200)).set(p.b, box(640, 50, 250, 200));
    const dest = moveDestination(state, p.owner, heading)!;
    const lists = dest.lists(measured);
    const afterAda = dest.aim(lists, 600, 150, 1)!;
    expect(afterAda).toMatchObject({ op: { parentId: p.grid, index: 1 }, where: { lead: 'after', target: nodeLabel(state, p.owner, p.a) } });
    // A second gap in the same drag is its own move, not the first one's from the cache.
    expect(dest.aim(lists, 850, 150, 1)).toMatchObject({ op: { parentId: p.grid, index: 2 } });
  });

  it('refuses everywhere a node the page shows more than once, or not at all here', () => {
    const p = page();
    const dest = moveDestination(p.state, p.owner, p.a)!;
    const many = dest.lists(new Map(p.measured).set(p.a, { ...box(100, 50, 390, 200), many: true }));
    expect(dest.aim(many, 500, 320, 1)).toMatchObject({ op: null, refused: MOVE_UNSHOWN });
    const hidden = dest.lists(new Map(p.measured).set(p.a, null));
    expect(dest.aim(hidden, 500, 320, 1)).toMatchObject({ op: null, refused: MOVE_UNSHOWN });
    expect(dest.surfaces(hidden)).toEqual([]);
  });

  it('counts a placement whose component sets Order for a container width as of no known Order elsewhere', () => {
    const p = page();
    const made = applyOperations(p.state, [{ type: 'component.createFromNode', owner: p.owner, nodeId: p.row, name: 'Badge row' }]);
    const def = made.results[0].definitionId as string;
    const tree = made.state.components[def].tree!;
    const root = tree.nodes[tree.rootIds[0]] as ElementNode;
    root.styles = { ...(root.styles ?? {}), 'cq-narrow': { order: 2 } } as ElementNode['styles'];
    const row = Object.values(made.state.pages[p.owner.id].nodes).find((n) => n.kind === 'instance' && n.definitionId === def)!;
    const measured = new Map(p.measured)
      .set(p.a, { ...box(100, 50, 390, 200), ordered: true })
      .set(p.b, { ...box(510, 50, 390, 200), ordered: true })
      .set(row.id, box(100, 280, 800, 80));
    const dest = moveDestination(made.state, p.owner, row.id)!;
    const lists = dest.lists(measured);
    // Between the grid's cards, where an Order it would take in a narrow container could put it elsewhere: refused.
    expect(dest.aim(lists, 495, 150, 1)).toMatchObject({ op: null, refused: expect.stringMatching(/Order style/) });
  });

  it('counts only the variant a placement is shown with, unless the choice is bound to content', () => {
    const p = page();
    const made = applyOperations(p.state, [{ type: 'component.createFromNode', owner: p.owner, nodeId: p.row, name: 'Badge row' }]);
    const def = made.state.components[made.results[0].definitionId as string];
    const rootId = def.tree!.rootIds[0];
    def.variantAxes = { size: { label: 'Size', default: 'plain', options: { plain: { label: 'Plain' }, narrow: { label: 'Narrow', styles: { [rootId]: { 'cq-narrow': { order: 2 } } } } } } } as unknown as typeof def.variantAxes;
    const row = Object.values(made.state.pages[p.owner.id].nodes).find((n) => n.kind === 'instance' && n.definitionId === def.id) as InstanceNode;
    const measured = new Map(p.measured)
      .set(p.a, { ...box(100, 50, 390, 200), ordered: true })
      .set(p.b, { ...box(510, 50, 390, 200), ordered: true })
      .set(row.id, box(100, 280, 800, 80));
    const between = () => {
      const dest = moveDestination(made.state, p.owner, row.id)!;
      return dest.aim(dest.lists(measured), 495, 150, 1);
    };
    // Shown Plain: the Narrow option's Order never reaches it, and it goes between the cards.
    expect(between()).toMatchObject({ op: { parentId: p.grid, index: 1 }, refused: null });
    row.variants = { size: 'narrow' };
    expect(between()).toMatchObject({ op: null, refused: expect.stringMatching(/Order style/) });
    row.variants = { size: { $bind: 'item.size' } } as unknown as InstanceNode['variants'];
    expect(between()).toMatchObject({ op: null, refused: expect.stringMatching(/Order style/) });
  });

  it('moves the last section to the top of the page', () => {
    const p = page();
    const dest = moveDestination(p.state, p.owner, p.second)!;
    const lists = dest.lists(p.measured);
    expect(dest.aim(lists, 500, 100, 1)).toMatchObject({ op: { parentId: null, index: 0 }, refused: null, where: { lead: 'at the top of' } });
  });

  it('refuses a list inside itself before what that list refuses of its own', () => {
    const p = page();
    // The grid's first card shows more than once: its own list would refuse with that, but it is inside the section moved.
    const dest = moveDestination(p.state, p.owner, p.grid)!;
    const lists = dest.lists(new Map(p.measured).set(p.b, { ...box(510, 50, 390, 200), many: true }));
    expect(dest.aim(lists, 300, 150, 1)).toMatchObject({ op: null, refused: INSIDE_ITSELF });
  });

  it('is none for a node whose list a drop never finds, such as a component’s own design', () => {
    const p = page();
    const made = applyOperations(p.state, [{ type: 'component.createFromNode', owner: p.owner, nodeId: p.grid, name: 'Artist grid' }]);
    const def = made.results[0].definitionId as string;
    const tree = made.state.components[def].tree!;
    const inner = tree.nodes[tree.rootIds[0]].kind === 'element' ? (tree.nodes[tree.rootIds[0]] as ElementNode).children[0] : undefined;
    expect(inner).toBeDefined();
    expect(moveDestination(made.state, { kind: 'component', id: def }, inner!)).toBeNull();
  });
});
