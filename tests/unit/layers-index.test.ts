/**
 * What Layers knows about a tree's shape without walking it for every row (src/renderer/src/lib/layers.ts): the nodes
 * that hold a node and where each node sits, which must say exactly what `subtreeIds` and `findParent` say, on trees as damaged as a hand-edited document can be,
 * and the row states read from them, which must be what each row worked out for itself before.
 */
import { describe, expect, it } from 'vitest';
import type { ElementRef, GraphNode, NodeTree, OwnerRef } from '@shared/types';
import { refKey, sameRef } from '@shared/types';
import { findParent, subtreeIds } from '@engine/tree';
import { holdsSelection, isSelectedRow, nodesHolding, parentOf } from '../../src/renderer/src/lib/layers';

/** A seeded source of numbers in [0, 1) (mulberry32), so a failing tree can be built again. */
function numbers(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A tree with everything a hand edit can leave: a child named twice in one list or by two parents, children and roots
 * that are not nodes (one the nodes' object answers to anyway), roots that are also children, loops, placements with several slots, slot outlets with a
 * fallback, leaves, nodes kept under a key that is not their id, and keys in no particular order.
 */
function damagedTree(seed: number, size: number): NodeTree {
  const r = numbers(seed);
  const ids = Array.from({ length: size }, (_, i) => `n_${i}`);
  // Now and then a name the object holding the nodes answers to without having it ("constructor"), as a walk sees it.
  const pick = () => (r() < 0.1 ? `n_gone${Math.floor(r() * 3)}` : r() < 0.02 ? 'constructor' : ids[Math.floor(r() * size)]);
  const list = (most: number) => Array.from({ length: Math.floor(r() * (most + 1)) }, pick);
  const nodes: Record<string, GraphNode> = {};
  for (const id of [...ids].sort(() => r() - 0.5)) {
    const kind = r();
    const n =
      kind < 0.45
        ? { id, kind: 'element', tag: 'div', children: list(4) }
        : kind < 0.7
          ? { id, kind: 'instance', definitionId: 'd_card', props: {}, slots: { content: list(3), aside: list(2) } }
          : kind < 0.8
            ? { id, kind: 'slot', slot: 'content', children: list(2) }
            : kind < 0.85
              ? { id, kind: 'repeat', children: list(2) }
              : { id, kind: 'text', tag: 'p', text: 'Words' };
    nodes[r() < 0.05 ? `${id}_kept` : id] = n as unknown as GraphNode;
  }
  return { rootIds: list(4).concat(ids[0]), nodes };
}

/** Every name a row or a selection could carry in this tree: its keys, its nodes' ids and names of nodes not there. */
const names = (tree: NodeTree) => [...new Set([...Object.keys(tree.nodes), ...Object.values(tree.nodes).map((n) => n.id), 'n_gone0', 'n_gone1', 'n_gone2', 'constructor'])];

describe('where a node sits', () => {
  it('is where findParent finds it, the same list and place, on damaged trees of every size', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const tree = damagedTree(seed, 4 + (seed % 25));
      for (const id of names(tree)) {
        const want = findParent(tree, id);
        const got = parentOf(tree, id);
        expect(got, `seed ${seed}: ${id}`).toStrictEqual(want);
        if (want) expect(got!.list, `seed ${seed}: ${id}'s list`).toBe(want.list);
      }
    }
  });

  it('is found again for a new tree, never kept from the tree before it', () => {
    const el = (id: string, children: string[]) => ({ id, kind: 'element', tag: 'div', children }) as unknown as GraphNode;
    const before: NodeTree = { rootIds: ['a', 'b'], nodes: { a: el('a', ['c']), b: el('b', []), c: el('c', []) } };
    expect(parentOf(before, 'c')?.parentId).toBe('a');
    const after: NodeTree = { rootIds: ['a', 'b'], nodes: { a: el('a', []), b: el('b', ['c']), c: el('c', []) } };
    expect(parentOf(after, 'c')?.parentId).toBe('b');
  });
});

describe('the nodes holding a node', () => {
  it('are the nodes whose subtree includes it, on damaged trees of every size', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const tree = damagedTree(seed, 4 + (seed % 25));
      const all = names(tree);
      for (const anchor of all) {
        const held = nodesHolding(tree, anchor);
        for (const row of all) if (row !== anchor) expect(held.has(row), `seed ${seed}: ${row} holding ${anchor}`).toBe(subtreeIds(tree, row).includes(anchor));
      }
    }
  });

  it('follow every parent of a node named twice, through loops, and only the loop holds a node itself', () => {
    const el = (id: string, children: string[]) => ({ id, kind: 'element', tag: 'div', children }) as unknown as GraphNode;
    const tree: NodeTree = {
      rootIds: ['a', 'b'],
      nodes: { a: el('a', ['c', 'c']), b: el('b', ['c']), c: el('c', ['d']), d: el('d', []), e: el('e', ['f']), f: el('f', ['e']) }
    };
    expect([...nodesHolding(tree, 'd')].sort()).toEqual(['a', 'b', 'c']);
    expect([...nodesHolding(tree, 'c')].sort()).toEqual(['a', 'b']);
    expect([...nodesHolding(tree, 'a')]).toEqual([]);
    expect([...nodesHolding(tree, 'e')].sort()).toEqual(['e', 'f']);
    // A node that is not there is held by nothing, as no subtree can include it.
    expect([...nodesHolding({ rootIds: [], nodes: { a: el('a', ['x']) } }, 'x')]).toEqual([]);
  });

  it('are found again for a new tree, never kept from the tree before it', () => {
    const el = (id: string, children: string[]) => ({ id, kind: 'element', tag: 'div', children }) as unknown as GraphNode;
    const before: NodeTree = { rootIds: ['a', 'b'], nodes: { a: el('a', ['c']), b: el('b', []), c: el('c', []) } };
    expect([...nodesHolding(before, 'c')]).toEqual(['a']);
    // An edit brings a new tree, with the layer moved.
    const after: NodeTree = { rootIds: ['a', 'b'], nodes: { a: el('a', []), b: el('b', ['c']), c: el('c', []) } };
    expect([...nodesHolding(after, 'c')]).toEqual(['b']);
    expect([...nodesHolding(before, 'c')]).toEqual(['a']);
  });
});

/** How a row decided it was the selection, and held it, when each row worked it out for itself (before #971). */
function rowStateBefore(tree: NodeTree, owner: OwnerRef, id: string, selection: ElementRef | null, slotTarget: { owner: OwnerRef; parentId: string } | null, definitionMode: unknown, isDefRoot: boolean) {
  const n = tree.nodes[id];
  const ref: ElementRef = { owner, instancePath: [], nodeId: id };
  const defRoot = isDefRoot && !!definitionMode && !!selection && selection.owner.kind !== 'component' && selection.instancePath.length === 1 && selection.nodeId === id;
  const own = sameRef(selection, ref) || defRoot || (owner.kind === 'component' && !!selection?.itemPath?.length && sameRef({ ...selection, itemPath: undefined }, ref));
  const anchor = selection && selection.owner.id === owner.id ? (selection.instancePath[0] ?? selection.nodeId) : null;
  const slotAt = slotTarget && slotTarget.owner.kind === owner.kind && slotTarget.owner.id === owner.id ? slotTarget.parentId : null;
  const containsSel = !!n && ((!!anchor && (anchor === id ? !!selection!.instancePath.length : subtreeIds(tree, id).includes(anchor))) || (!!slotAt && (slotAt === id || subtreeIds(tree, id).includes(slotAt))));
  return { own, containsSel };
}

describe('a tree a hand edit damaged further', () => {
  const el = (id: string, children: unknown) => ({ id, kind: 'element', tag: 'div', children }) as unknown as GraphNode;

  it('still answers for the healthy layers beside a child list that is no list', () => {
    const tree: NodeTree = { rootIds: ['a', 'b'], nodes: { a: el('a', ['c']), c: el('c', []), b: el('b', null) } };
    // findParent answered for these before reaching the damaged list; so does the index, which passes over it.
    for (const id of ['a', 'b', 'c']) expect(parentOf(tree, id), id).toStrictEqual(findParent(tree, id));
    expect([...nodesHolding(tree, 'c')]).toEqual(['a']);
  });

  it('follows a child named by a number to the node kept under it, and compares the selected node as listed', () => {
    // As subtreeIds walks: `nodes[7]` is the node kept under "7", and "7" itself is never the number 7.
    const tree: NodeTree = { rootIds: ['outer'], nodes: { outer: el('outer', [7]), '7': el('7', ['leaf']), leaf: el('leaf', []) } };
    for (const anchor of ['leaf', '7'])
      for (const row of ['outer', '7', 'leaf']) if (row !== anchor) expect(nodesHolding(tree, anchor).has(row), `${row} holding ${anchor}`).toBe(subtreeIds(tree, row).includes(anchor));
    expect([...nodesHolding(tree, 'leaf')].sort()).toEqual(['7', 'outer']);
    expect([...nodesHolding(tree, '7')]).toEqual([]);
    for (const id of ['outer', '7', 'leaf']) expect(parentOf(tree, id), id).toStrictEqual(findParent(tree, id));
  });
});

describe('a row and the selection', () => {
  // Owners that share an ID across kinds, as a page and a component could.
  const owners: OwnerRef[] = [
    { kind: 'page', id: 'pg_one' },
    { kind: 'page', id: 'pg_two' },
    { kind: 'component', id: 'pg_one' },
    { kind: 'component', id: 'd_card' },
    { kind: 'shell', id: 'header' },
    { kind: 'template', id: 'posts' },
    { kind: 'archive', id: 'posts' }
  ];

  it('is the selection, and holds it, exactly when the row worked that out for itself', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = numbers(seed * 7919);
      const tree = damagedTree(seed, 6 + (seed % 20));
      const all = names(tree);
      const any = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
      for (let k = 0; k < 120; k++) {
        const selection: ElementRef | null =
          r() < 0.1
            ? null
            : {
                owner: any(owners),
                instancePath: r() < 0.5 ? [] : r() < 0.7 ? [any(all)] : [any(all), any(all)],
                nodeId: any(all),
                ...(r() < 0.3 ? { itemPath: [`item${Math.floor(r() * 3)}`] } : {}),
                ...(r() < 0.2 ? { partId: 'title' } : {}),
                ...(r() < 0.1 ? { slot: 'content' } : {})
              };
        const slotTarget = r() < 0.3 ? { owner: any(owners), parentId: any(all), slot: 'content' } : null;
        const definitionMode = r() < 0.5 ? { definitionId: 'd_card' } : null;
        for (const owner of owners)
          for (const id of all) {
            const isDefRoot = r() < 0.2;
            const before = rowStateBefore(tree, owner, id, selection, slotTarget, definitionMode, isDefRoot);
            const own = isSelectedRow(selection, definitionMode, refKey({ owner, instancePath: [], nodeId: id }), owner, id, isDefRoot);
            const containsSel = !!tree.nodes[id] && holdsSelection(tree, owner, id, selection, slotTarget);
            expect({ own, containsSel }, `seed ${seed}: row ${owner.kind}:${owner.id} ${id} for ${JSON.stringify(selection)} / ${JSON.stringify(slotTarget)}`).toEqual(before);
          }
      }
    }
  });
});
