import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { onGonePage } from '../../src/renderer/src/lib/model';
import { duplicateOps, extendTo, groupOf, liveSet, moveIntoOps, moveStepOps, moveToPageOps, rangeOf, removeOps, toggle, besideOf, type LayerSet, type PickResult } from '../../src/renderer/src/lib/layer-set';

/** The Business starter: Home holds hero, logos, features, media, stats, gallery, testimonials, cta. */
function business() {
  const s: ProjectState = createStarterState('business', 'Studio', false);
  const homeId = s.site.homePageId;
  const aboutId = s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
  const owner: OwnerRef = { kind: 'page', id: homeId };
  const roots = s.pages[homeId].rootIds;
  const byComponent = (componentId: string, st: ProjectState = s, pageId = homeId) =>
    st.pages[pageId].rootIds.find((id) => st.components[(st.pages[pageId].nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;
  return { s, homeId, aboutId, owner, roots, gallery: byComponent('media.gallery'), testimonials: byComponent('testimonials.grid'), byComponent };
}
const at = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });

/** Business Home with a Section on top holding three headings, side by side in its "content" slot. */
function withSlot() {
  const t = business();
  let s = apply(t.s, [{ type: 'node.insert', newNodeId: 'n_holder', owner: t.owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
  s = apply(s, ['One', 'Two', 'Three'].map((text): EditOperation => ({ type: 'node.insert', owner: t.owner, parentId: 'n_holder', slot: 'content', primitive: 'heading', text }))).state;
  const slot = () => (s.pages[t.homeId].nodes.n_holder as InstanceNode).slots!.content;
  const [h1, h2, h3] = slot();
  return { ...t, s, h1, h2, h3, slotOf: (st: ProjectState) => (st.pages[t.homeId].nodes.n_holder as InstanceNode).slots!.content };
}
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const picked = (r: PickResult) => {
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  return r;
};

describe('picking several layers in Layers', () => {
  it('Shift selects the range from the layer picked before, in page order, either way', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    // Gallery, then Shift on Testimonials: the issue's own gesture.
    const r = picked(extendTo(home, at(t.owner, t.gallery), null, at(t.owner, t.testimonials)));
    expect(r.selection).toEqual(at(t.owner, t.testimonials));
    expect(r.layerSet).toEqual({ owner: t.owner, ids: [t.gallery, t.testimonials], anchor: t.gallery });
    // Upwards from Testimonials three places: the range keeps the page's order, and its anchor.
    const up = picked(extendTo(home, at(t.owner, t.testimonials), null, at(t.owner, t.roots[3])));
    expect(up.layerSet?.ids).toEqual(t.roots.slice(3, 7));
    expect(up.layerSet?.anchor).toBe(t.testimonials);
    expect(up.selection).toEqual(at(t.owner, t.roots[3]));
  });

  it('a second Shift pick moves the end of the range, and shrinks it back to the anchor alone', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const set: LayerSet = { owner: t.owner, ids: t.roots.slice(2, 6), anchor: t.roots[2] };
    const shorter = picked(extendTo(home, at(t.owner, t.roots[5]), set, at(t.owner, t.roots[3])));
    expect(shorter.layerSet?.ids).toEqual([t.roots[2], t.roots[3]]);
    expect(shorter.selection).toEqual(at(t.owner, t.roots[3]));
    const alone = picked(extendTo(home, shorter.selection, shorter.layerSet, at(t.owner, t.roots[2])));
    expect(alone).toEqual({ selection: at(t.owner, t.roots[2]), layerSet: null });
  });

  it('Cmd/Ctrl adds one layer, and taking the selection away passes it to the nearest one left, above first', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const two = picked(toggle(home, at(t.owner, t.roots[1]), null, at(t.owner, t.roots[3])));
    expect(two.layerSet).toEqual({ owner: t.owner, ids: [t.roots[1], t.roots[3]], anchor: t.roots[3] });
    const three = picked(toggle(home, two.selection, two.layerSet, at(t.owner, t.roots[5])));
    expect(three.layerSet?.ids).toEqual([t.roots[1], t.roots[3], t.roots[5]]);
    // Roots 3 and 5... take 5 (the selection) away: 3 is nearest.
    const less = picked(toggle(home, three.selection, three.layerSet, at(t.owner, t.roots[5])));
    expect(less.selection).toEqual(at(t.owner, t.roots[3]));
    expect(less.layerSet?.ids).toEqual([t.roots[1], t.roots[3]]);
    // Equally near above and below: the one above.
    const mid = picked(toggle(home, at(t.owner, t.roots[3]), { owner: t.owner, ids: [t.roots[1], t.roots[3], t.roots[5]], anchor: t.roots[1] }, at(t.owner, t.roots[3])));
    expect(mid.selection).toEqual(at(t.owner, t.roots[1]));
    // Down to one: no set; then none.
    const one = picked(toggle(home, less.selection, less.layerSet, at(t.owner, t.roots[1])));
    expect(one).toEqual({ selection: at(t.owner, t.roots[3]), layerSet: null });
    expect(picked(toggle(home, one.selection, one.layerSet, at(t.owner, t.roots[3])))).toEqual({ selection: null, layerSet: null });
  });

  it('Cmd/Ctrl adds a layer above in list order; the anchor stays while it is selected, else passes to the selection', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const r = t.roots;
    const above = picked(toggle(home, at(t.owner, r[3]), null, at(t.owner, r[1])));
    expect(above).toEqual({ selection: at(t.owner, r[1]), layerSet: { owner: t.owner, ids: [r[1], r[3]], anchor: r[1] } });
    const three: LayerSet = { owner: t.owner, ids: [r[1], r[3], r[5]], anchor: r[1] };
    // Taking the anchor away: the next range starts at the selection.
    expect(picked(toggle(home, at(t.owner, r[5]), three, at(t.owner, r[1]))).layerSet).toEqual({ owner: t.owner, ids: [r[3], r[5]], anchor: r[5] });
    // Taking another away: the anchor stays.
    expect(picked(toggle(home, at(t.owner, r[5]), three, at(t.owner, r[3]))).layerSet).toEqual({ owner: t.owner, ids: [r[1], r[5]], anchor: r[1] });
    // The selection leaving passes to the nearest one left, below when that is nearer.
    const near = picked(toggle(home, at(t.owner, r[3]), { owner: t.owner, ids: [r[0], r[3], r[4]], anchor: r[0] }, at(t.owner, r[3])));
    expect(near.selection).toEqual(at(t.owner, r[4]));
  });

  it('a pick that can\'t join never replaces what is selected: it says why, and with nothing selected it selects alone', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const hOwner: OwnerRef = { kind: 'shell', id: 'header' };
    // A header with two layers side by side, as a synthetic tree: still selected one at a time.
    const header: NodeTree = { rootIds: ['n_hdr_a', 'n_hdr_b'], nodes: { n_hdr_a: { id: 'n_hdr_a', kind: 'divider' }, n_hdr_b: { id: 'n_hdr_b', kind: 'divider' } } } as unknown as NodeTree;
    expect(extendTo(header, at(hOwner, 'n_hdr_a'), null, at(hOwner, 'n_hdr_b'))).toEqual({ refused: expect.stringMatching(/shared header and footer/) });
    expect(toggle(header, at(hOwner, 'n_hdr_a'), null, at(hOwner, 'n_hdr_b'))).toEqual({ refused: expect.stringMatching(/shared header and footer/) });
    // Two page sections selected, then Cmd on a header layer: refused, so the two stay selected.
    const set: LayerSet = { owner: t.owner, ids: [t.gallery, t.testimonials], anchor: t.gallery };
    expect(toggle(header, at(t.owner, t.testimonials), set, at(hOwner, 'n_hdr_a'))).toEqual({ refused: expect.stringMatching(/shared header and footer/) });
    // A part of a placement, with a section selected: refused; with nothing selected, it is selected alone.
    const part: ElementRef = { owner: t.owner, instancePath: [t.gallery], nodeId: 'n_part', partId: 'title' };
    expect(extendTo(home, at(t.owner, t.testimonials), set, part)).toEqual({ refused: expect.stringMatching(/Parts of a component/) });
    expect(toggle(home, null, null, part)).toEqual({ selection: part, layerSet: null });
    // A layer of another page's tree selected (shown elsewhere): a Shift pick here can't extend it.
    expect(extendTo(home, at({ kind: 'page', id: t.aboutId }, t.s.pages[t.aboutId].rootIds[0]), null, at(t.owner, t.gallery))).toEqual({ refused: expect.stringMatching(/side by side/) });
  });

  it('refuses layers that are not side by side, or that are shared header and footer layers, and says why', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    // A layer inside a section is not beside a section.
    const section = home.nodes[t.gallery] as InstanceNode;
    const s2 = apply(t.s, [{ type: 'node.insert', owner: t.owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const sectionId = s2.pages[t.homeId].rootIds[0];
    const s3 = apply(s2, [{ type: 'node.insert', owner: t.owner, parentId: sectionId, slot: 'content', primitive: 'heading', text: 'Inside' }]).state;
    const inner = (s3.pages[t.homeId].nodes[sectionId] as InstanceNode).slots!.content[0];
    const r = extendTo(s3.pages[t.homeId], at(t.owner, t.gallery), null, at(t.owner, inner));
    expect(r).toEqual({ refused: expect.stringMatching(/side by side/) });
    expect(toggle(s3.pages[t.homeId], at(t.owner, t.gallery), null, at(t.owner, inner))).toEqual({ refused: expect.stringMatching(/side by side/) });
    expect(section.kind).toBe('instance');
    // The shared header's layers are selected one at a time.
    const header = t.s.site.shell.header;
    const hOwner: OwnerRef = { kind: 'shell', id: 'header' };
    if (header.rootIds.length > 1) expect(extendTo(header, at(hOwner, header.rootIds[0]), null, at(hOwner, header.rootIds[1]))).toEqual({ refused: expect.stringMatching(/shared header and footer/) });
    const root = header.rootIds[0];
    expect(toggle(header, at(hOwner, root), null, at(hOwner, root))).toEqual({ selection: null, layerSet: null });
  });

  it('Shift+↑/↓ steps to the sibling beside, never into a branch, and stops at either end', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    expect(besideOf(home, t.gallery, 1)).toBe(t.testimonials);
    expect(besideOf(home, t.roots[0], -1)).toBeNull();
    expect(besideOf(home, t.roots[t.roots.length - 1], 1)).toBeNull();
    const n = withSlot();
    const tree = n.s.pages[n.homeId];
    expect([besideOf(tree, n.h2, -1), besideOf(tree, n.h2, 1), besideOf(tree, n.h3, 1)]).toEqual([n.h1, n.h3, null]);
  });

  it('a set applies only while the selection is one of its layers and they still share one list', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const set: LayerSet = { owner: t.owner, ids: [t.testimonials, t.gallery], anchor: t.gallery };
    expect(liveSet(home, at(t.owner, t.gallery), set)?.ids).toEqual([t.gallery, t.testimonials]);
    expect(liveSet(home, at(t.owner, t.roots[0]), set)).toBeNull();
    expect(liveSet(home, { ...at(t.owner, t.gallery), instancePath: [t.gallery] }, set)).toBeNull();
    // A layer of it removed (an Undo, the AI): one left is no set.
    const gone = apply(t.s, [{ type: 'node.remove', owner: t.owner, nodeId: t.testimonials }]).state;
    expect(liveSet(gone.pages[t.homeId], at(t.owner, t.gallery), set)).toBeNull();
    // The selection itself removed: no set, even with others left.
    const three: LayerSet = { owner: t.owner, ids: t.roots.slice(4, 7), anchor: t.roots[4] };
    const noSel = apply(t.s, [{ type: 'node.remove', owner: t.owner, nodeId: t.roots[5] }]).state;
    expect(liveSet(noSel.pages[t.homeId], at(t.owner, t.roots[5]), three)).toBeNull();
    expect(liveSet(noSel.pages[t.homeId], at(t.owner, t.roots[4]), three)?.ids).toEqual([t.roots[4], t.roots[6]]);
    expect(rangeOf(home, t.gallery, t.gallery)).toEqual([t.gallery]);
    // The same node ID selected in another tree is not this set's.
    expect(liveSet(home, at({ kind: 'page', id: t.aboutId }, t.gallery), set)).toBeNull();
  });

  it('a selection on a page an Undo took away goes with it, so a Redo never brings it back selected off screen', () => {
    const t = business();
    const dup = apply(t.s, [{ type: 'page.duplicate', pageId: t.homeId }]);
    const copyId = dup.results[0].pageId as string;
    const sel = at({ kind: 'page', id: copyId }, dup.state.pages[copyId].rootIds[0]);
    expect(onGonePage(dup.state, sel)).toBe(false);
    expect(onGonePage(t.s, sel)).toBe(true);
    expect(onGonePage(t.s, at(t.owner, t.gallery))).toBe(false);
    expect(onGonePage(t.s, { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: 'x' })).toBe(false);
    expect(onGonePage(t.s, null)).toBe(false);
  });

  it('a layer moved away from the others (an Undo, the AI) leaves the set; the ones still beside the selection stay', () => {
    const n = withSlot();
    const set: LayerSet = { owner: n.owner, ids: [n.h1, n.h2, n.h3], anchor: n.h1 };
    const moved = apply(n.s, [{ type: 'node.move', owner: n.owner, nodeId: n.h3, parentId: null, index: 0 }]).state;
    expect(liveSet(moved.pages[n.homeId], at(n.owner, n.h2), set)?.ids).toEqual([n.h1, n.h2]);
    // The selection itself moved away: the set no longer applies.
    expect(liveSet(moved.pages[n.homeId], at(n.owner, n.h3), set)).toBeNull();
  });
});

describe('each action on several layers is one change that keeps their order', () => {
  const ids = (s: ProjectState, pageId: string) => s.pages[pageId].rootIds;

  it('moves a run up and down as a block, and a gapped selection one step each, never past either end', () => {
    const t = business();
    const r = t.roots;
    const home = t.s.pages[t.homeId];
    const block = groupOf(home, t.owner, [r[2], r[1]])!;
    expect(ids(apply(t.s, moveStepOps(block, -1)!).state, t.homeId)).toEqual([r[1], r[2], r[0], ...r.slice(3)]);
    expect(ids(apply(t.s, moveStepOps(block, 1)!).state, t.homeId)).toEqual([r[0], r[3], r[1], r[2], ...r.slice(4)]);
    const gapped = groupOf(home, t.owner, [r[1], r[3]])!;
    expect(ids(apply(t.s, moveStepOps(gapped, 1)!).state, t.homeId)).toEqual([r[0], r[2], r[1], r[4], r[3], ...r.slice(5)]);
    expect(ids(apply(t.s, moveStepOps(gapped, -1)!).state, t.homeId)).toEqual([r[1], r[0], r[3], r[2], ...r.slice(4)]);
    expect(moveStepOps(groupOf(home, t.owner, [r[0], r[2]])!, -1)).toBeNull();
    // Inside a section's slot, the moves stay in that slot.
    const n = withSlot();
    const inSlot = apply(n.s, moveStepOps(groupOf(n.s.pages[n.homeId], n.owner, [n.h3, n.h2])!, -1)!).state;
    expect(n.slotOf(inSlot)).toEqual([n.h2, n.h3, n.h1]);
    expect(moveStepOps(groupOf(home, t.owner, [r[5], r[r.length - 1]])!, 1)).toBeNull();
  });

  it('duplicates Gallery and Testimonials together, after the last of them, leaving the originals where they were', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const out = apply(t.s, duplicateOps(groupOf(home, t.owner, [t.testimonials, t.gallery])!));
    const [g2, t2] = out.results.map((x) => x.nodeId as string);
    const after = ids(out.state, t.homeId);
    const g = after.indexOf(t.gallery);
    expect(after.slice(g, g + 4)).toEqual([t.gallery, t.testimonials, g2, t2]);
    expect(after.length).toBe(t.roots.length + 2);
    // Copies of each, not of one twice.
    const def = (s: ProjectState, id: string) => (s.pages[t.homeId].nodes[id] as InstanceNode).definitionId;
    expect([def(out.state, g2), def(out.state, t2)]).toEqual([def(t.s, t.gallery), def(t.s, t.testimonials)]);
    // A gapped selection: the copies still go together after the last.
    const r = t.roots;
    const gapped = apply(t.s, duplicateOps(groupOf(home, t.owner, [r[1], r[3]])!));
    const [c1, c3] = gapped.results.map((x) => x.nodeId as string);
    expect(ids(gapped.state, t.homeId).slice(0, 7)).toEqual([r[0], r[1], r[2], r[3], c1, c3, r[4]]);
  });

  it('refuses a duplicate placed past the end of its list, and keeps a single duplicate right after its original', () => {
    const t = business();
    expect(() => apply(t.s, [{ type: 'node.duplicate', owner: t.owner, nodeId: t.gallery, index: t.roots.length + 1 }])).toThrow(/past the end/);
    const first = apply(t.s, [{ type: 'node.duplicate', owner: t.owner, nodeId: t.gallery, index: 0 }]);
    expect(ids(first.state, t.homeId)[0]).toBe(first.results[0].nodeId);
    const last = apply(t.s, [{ type: 'node.duplicate', owner: t.owner, nodeId: t.gallery, index: t.roots.length }]);
    expect(ids(last.state, t.homeId).at(-1)).toBe(last.results[0].nodeId);
    const one = apply(t.s, [{ type: 'node.duplicate', owner: t.owner, nodeId: t.gallery }]);
    const after = ids(one.state, t.homeId);
    expect(after[after.indexOf(t.gallery) + 1]).toBe(one.results[0].nodeId);
  });

  it('deletes them all', () => {
    const t = business();
    const out = apply(t.s, removeOps(groupOf(t.s.pages[t.homeId], t.owner, [t.gallery, t.testimonials])!)).state;
    expect(ids(out, t.homeId)).toEqual(t.roots.filter((id) => id !== t.gallery && id !== t.testimonials));
  });

  it('moves them into a container in their order', () => {
    const t = business();
    const s2 = apply(t.s, [{ type: 'node.insert', owner: t.owner, parentId: null, index: 0, componentId: 'layout.section' }]).state;
    const sectionId = s2.pages[t.homeId].rootIds[0];
    const s3 = apply(s2, [
      { type: 'node.insert', owner: t.owner, parentId: sectionId, slot: 'content', primitive: 'heading', text: 'One' },
      { type: 'node.insert', owner: t.owner, parentId: sectionId, slot: 'content', primitive: 'paragraph', text: 'Two' },
      { type: 'node.insert', owner: t.owner, parentId: null, index: 1, componentId: 'layout.section' }
    ]).state;
    const [one, two] = (s3.pages[t.homeId].nodes[sectionId] as InstanceNode).slots!.content;
    const target = s3.pages[t.homeId].rootIds[1];
    const out = apply(s3, moveIntoOps(groupOf(s3.pages[t.homeId], t.owner, [two, one])!, { parentId: target, slot: 'content', index: 0 })).state;
    expect((out.pages[t.homeId].nodes[target] as InstanceNode).slots!.content).toEqual([one, two]);
    expect((out.pages[t.homeId].nodes[sectionId] as InstanceNode).slots?.content ?? []).toEqual([]);
    // Into a slot that already holds a layer, at its second place.
    const n = withSlot();
    const filled = apply(n.s, moveIntoOps(groupOf(n.s.pages[n.homeId], n.owner, [n.h3, n.h2])!, { parentId: 'n_holder', slot: 'content', index: 1 }));
    expect(n.slotOf(filled.state)).toEqual([n.h1, n.h2, n.h3]);
    const target2 = apply(n.s, [{ type: 'node.insert', newNodeId: 'n_target2', owner: n.owner, parentId: null, index: 1, componentId: 'layout.section' }, { type: 'node.insert', owner: n.owner, parentId: 'n_target2', slot: 'content', primitive: 'divider' }]).state;
    const divider = (target2.pages[n.homeId].nodes.n_target2 as InstanceNode).slots!.content[0];
    const into = apply(target2, moveIntoOps(groupOf(target2.pages[n.homeId], n.owner, [n.h1, n.h3])!, { parentId: 'n_target2', slot: 'content', index: 1 })).state;
    expect((into.pages[n.homeId].nodes.n_target2 as InstanceNode).slots!.content).toEqual([divider, n.h1, n.h3]);
    expect(n.slotOf(into)).toEqual([n.h2]);
  });

  it('moves two sections to the end of another page, in order, and off this one', () => {
    const t = business();
    const aboutBefore = ids(t.s, t.aboutId);
    const out = apply(t.s, moveToPageOps(groupOf(t.s.pages[t.homeId], t.owner, [t.testimonials, t.gallery])!, t.aboutId, aboutBefore.length));
    const about = ids(out.state, t.aboutId);
    expect(about.slice(0, aboutBefore.length)).toEqual(aboutBefore);
    expect(about.slice(aboutBefore.length)).toEqual(out.results.slice(0, 2).map((x) => x.nodeId));
    expect(t.byComponent('media.gallery', out.state, t.aboutId)).toBe(about[aboutBefore.length]);
    expect(t.byComponent('testimonials.grid', out.state, t.aboutId)).toBe(about[aboutBefore.length + 1]);
    expect(ids(out.state, t.homeId)).toEqual(t.roots.filter((id) => id !== t.gallery && id !== t.testimonials));
    // At a place inside the page: in order, there.
    const mid = apply(t.s, moveToPageOps(groupOf(t.s.pages[t.homeId], t.owner, [t.gallery, t.testimonials])!, t.aboutId, 1));
    expect(ids(mid.state, t.aboutId)).toEqual([aboutBefore[0], ...mid.results.slice(0, 2).map((x) => x.nodeId), ...aboutBefore.slice(1)]);
  });
});
