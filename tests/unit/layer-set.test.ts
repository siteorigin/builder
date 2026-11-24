import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
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
  });

  it('a second Shift pick moves the end of the range, and shrinks it back to the anchor alone', () => {
    const t = business();
    const home = t.s.pages[t.homeId];
    const set: LayerSet = { owner: t.owner, ids: t.roots.slice(2, 6), anchor: t.roots[2] };
    const shorter = picked(extendTo(home, at(t.owner, t.roots[5]), set, at(t.owner, t.roots[3])));
    expect(shorter.layerSet?.ids).toEqual([t.roots[2], t.roots[3]]);
    const alone = picked(extendTo(home, at(t.owner, t.roots[3]), shorter.layerSet, at(t.owner, t.roots[2])));
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
  });
});
