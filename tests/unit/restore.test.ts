import { describe, expect, it } from 'vitest';
import type { NodeTree } from '@shared/types';
import { findRemoval, restoreRemoval, sameValue } from '@engine/restore';

// Small trees by hand: sections s1..s4 at the top, a container c with children, an instance i with a slot.
const el = (id: string, children: string[] = []) => ({ id, kind: 'element', tag: 'div', children });
const inst = (id: string, slots: Record<string, string[]>) => ({ id, kind: 'instance', definitionId: 'def', props: {}, slots });
// Page documents carry their settings beside the tree, as the Browser title in `seo`.
const tree = (rootIds: string[], nodes: Array<{ id: string }>) => ({ seo: {}, rootIds, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) }) as unknown as NodeTree & { seo: { title?: string } };
const base = () =>
  tree(['s1', 's2', 's3', 's4'], [el('s1'), el('s2', ['c']), el('c', ['h', 'p']), el('h'), el('p'), el('s3'), inst('s4', { aside: ['z'], content: ['x', 'y'] }), el('x'), el('y'), el('z')]);

/** `t` with one subtree removed, as node.remove leaves it. */
function without(t: NodeTree, id: string, ids: string[]) {
  const out = structuredClone(t);
  for (const n of Object.values(out.nodes) as Array<{ children?: string[]; slots?: Record<string, string[]> }>) {
    if (n.children) n.children = n.children.filter((c) => c !== id);
    if (n.slots) for (const k of Object.keys(n.slots)) n.slots[k] = n.slots[k].filter((c) => c !== id);
  }
  out.rootIds = out.rootIds.filter((r) => r !== id);
  for (const i of ids) delete out.nodes[i];
  return out;
}
const rootsOf = (t: NodeTree) => t.rootIds;
const childrenOf = (t: NodeTree, id: string) => (t.nodes[id] as unknown as { children: string[] }).children;

describe('finding a removal between two versions', () => {
  it('names the subtree, its list and its neighbours', () => {
    const b = base();
    expect(findRemoval(b, without(b, 's2', ['s2', 'c', 'h', 'p']))).toEqual({ rootId: 's2', ids: ['s2', 'c', 'h', 'p'], parentId: null, slot: undefined, left: ['s1'], right: ['s3', 's4'] });
    expect(findRemoval(b, without(b, 'x', ['x']))).toMatchObject({ rootId: 'x', parentId: 's4', slot: 'content', left: [], right: ['y'] });
    expect(findRemoval(b, without(b, 's4', ['s4', 'x', 'y', 'z']))).toMatchObject({ left: ['s3', 's2', 's1'], right: [] });
  });

  it('finds and restores a node whose ID is also an object property name', () => {
    for (const id of ['toString', '__proto__']) {
      // As JSON.parse reads a hand-edited document: every key is the object's own.
      const b = JSON.parse(`{"seo":{},"rootIds":["s1","${id}"],"nodes":{"s1":${JSON.stringify(el('s1'))},"${id}":${JSON.stringify(el(id))}}}`) as NodeTree;
      const a = JSON.parse(`{"seo":{},"rootIds":["s1"],"nodes":{"s1":${JSON.stringify(el('s1'))}}}`) as NodeTree;
      const removal = findRemoval(b, a);
      expect(removal?.rootId).toBe(id);
      const r = restoreRemoval(b, removal!, a);
      expect(r.ok && Object.hasOwn(r.tree.nodes, id) && JSON.parse(JSON.stringify(r.tree))).toEqual(b);
    }
  });

  it('is null when the change was anything more than one removal', () => {
    const b = base();
    const titled = { ...without(b, 's1', ['s1']), seo: { title: 'Changed' } };
    expect(findRemoval(b, titled)).toBeNull();
    expect(findRemoval(b, without(without(b, 's1', ['s1']), 's3', ['s3']))).toBeNull();
    const moved = without(b, 's1', ['s1']);
    moved.rootIds.reverse();
    expect(findRemoval(b, moved)).toBeNull();
    expect(findRemoval(b, b)).toBeNull();
    // A node left behind from the removed subtree is not a clean removal.
    expect(findRemoval(b, without(b, 'c', ['c', 'h']))).toBeNull();
  });
});

describe('restoring a removal', () => {
  const removeAndRestore = (id: string, ids: string[], edit: (t: NodeTree) => void, earlier: NodeTree[] = []) => {
    const b = base();
    const a = without(b, id, ids);
    const removal = findRemoval(b, a)!;
    const current = structuredClone(a);
    edit(current);
    return { b, current, r: restoreRemoval(b, removal, current, earlier) };
  };

  it('puts a section back between its neighbours, with its content, keeping later edits elsewhere', () => {
    const { b, current, r } = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], (t) => ((t.nodes.s3 as unknown as { name: string }).name = 'Edited'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rootsOf(r.tree)).toEqual(['s1', 's2', 's3', 's4']);
    for (const id of ['s2', 'c', 'h', 'p']) expect(r.tree.nodes[id]).toEqual(b.nodes[id]);
    expect((r.tree.nodes.s3 as unknown as { name: string }).name).toBe('Edited');
    // The current tree is left as it was.
    expect(rootsOf(current)).toEqual(['s1', 's3', 's4']);
  });

  it('restores a nested child and a slot item into their own lists', () => {
    const nested = removeAndRestore('h', ['h'], () => {});
    expect(nested.r.ok && childrenOf(nested.r.tree, 'c')).toEqual(['h', 'p']);
    const slotted = removeAndRestore('y', ['y'], () => {});
    expect(slotted.r.ok && (slotted.r.tree.nodes.s4 as unknown as { slots: Record<string, string[]> }).slots).toEqual({ aside: ['z'], content: ['x', 'y'] });
  });

  it('uses the nearest neighbour still there when the next one has gone too', () => {
    const { r } = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], (t) => {
      t.rootIds = t.rootIds.filter((x) => x !== 's3');
      delete t.nodes.s3;
    });
    expect(r.ok && rootsOf(r.tree)).toEqual(['s1', 's2', 's4']);
    // The nearest right neighbour still there decides, not a farther one.
    const first = removeAndRestore('s1', ['s1'], (t) => {
      t.rootIds = t.rootIds.filter((x) => x !== 's2');
      for (const id of ['s2', 'c', 'h', 'p']) delete t.nodes[id];
    });
    expect(first.r.ok && rootsOf(first.r.tree)).toEqual(['s1', 's3', 's4']);
    const alone = removeAndRestore('h', ['h'], (t) => {
      childrenOf(t, 'c').splice(0);
      delete t.nodes.p;
    });
    expect(alone.r.ok && childrenOf(alone.r.tree, 'c')).toEqual(['h']);
  });

  it('refuses when neighbours crossed the gap, the parent is gone, or an ID is taken', () => {
    const crossed = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], (t) => (t.rootIds = ['s3', 's1', 's4']));
    expect(crossed.r).toEqual({ ok: false, reason: 'The sections around where it was have changed.' });
    const orphaned = removeAndRestore('h', ['h'], (t) => {
      t.rootIds = t.rootIds.filter((x) => x !== 's2');
      for (const id of ['s2', 'c', 'p']) delete t.nodes[id];
    });
    expect(orphaned.r).toEqual({ ok: false, reason: 'What it was inside has been deleted.' });
    // Still in the document but no longer on the page counts as deleted too.
    const detached = removeAndRestore('h', ['h'], (t) => (childrenOf(t, 's2').length = 0));
    expect(detached.r).toEqual({ ok: false, reason: 'What it was inside has been deleted.' });
    const taken = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], (t) => {
      t.rootIds.push('c');
      t.nodes.c = el('c') as never;
    });
    expect(taken.r).toEqual({ ok: false, reason: 'Part of it is back on the page already.' });
    const slotGone = removeAndRestore('y', ['y'], (t) => delete (t.nodes.s4 as unknown as { slots: Record<string, string[]> }).slots.content);
    expect(slotGone.r).toEqual({ ok: false, reason: 'What it was inside has changed.' });
    // A neighbour moved into the gap is no clue to the order, whatever an earlier version says.
    const movedIn = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], (t) => (t.rootIds = ['s1', 's4', 's3']), [base()]);
    expect(movedIn.r).toEqual({ ok: false, reason: 'The sections around where it was have changed.' });
  });

  it('places it among sections standing in its gap only when an earlier version shows their order', () => {
    // s3 was put back into the gap after s2 was removed; the version before either removal shows s2 came first.
    const add = (t: NodeTree) => {
      t.rootIds.splice(1, 0, 'n');
      t.nodes.n = el('n') as never;
    };
    const unknown = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], add);
    expect(unknown.r).toEqual({ ok: false, reason: 'The sections around where it was have changed.', gap: true });
    const known = tree(['s1', 's2', 'n', 's3', 's4'], [...Object.values(base().nodes), el('n')] as Array<{ id: string }>);
    const shown = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], add, [base(), known]);
    expect(shown.r.ok && rootsOf(shown.r.tree)).toEqual(['s1', 's2', 'n', 's3', 's4']);
    const after = tree(['s1', 'n', 's2', 's3', 's4'], [...Object.values(base().nodes), el('n')] as Array<{ id: string }>);
    const behind = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], add, [after]);
    expect(behind.r.ok && rootsOf(behind.r.tree)).toEqual(['s1', 'n', 's2', 's3', 's4']);
  });

  it('takes the order among several arrivals only from a version that has them in the order they stand in now', () => {
    const arrive = (t: NodeTree) => {
      t.rootIds.splice(1, 0, 'm', 'n');
      t.nodes.m = el('m') as never;
      t.nodes.n = el('n') as never;
    };
    const version = (order: string[]) => tree(order, [...Object.values(base().nodes), el('m'), el('n')] as Array<{ id: string }>);
    // The first version shows n before m, which is not how they stand now, so the second one decides.
    const r = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], arrive, [version(['s1', 'n', 's2', 'm', 's3', 's4']), version(['s1', 'm', 's2', 'n', 's3', 's4'])]);
    expect(r.r.ok && rootsOf(r.r.tree)).toEqual(['s1', 'm', 's2', 'n', 's3', 's4']);
    const none = removeAndRestore('s2', ['s2', 'c', 'h', 'p'], arrive, [version(['s1', 'n', 's2', 'm', 's3', 's4'])]);
    expect(none.r).toMatchObject({ ok: false, gap: true });
  });
});

describe('sameValue', () => {
  it('compares JSON deeply, ignoring key order and absent keys', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue({ a: {} }, { a: [] })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});
