import { describe, expect, it, vi } from 'vitest';
import type { ElementRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { generateComponentPreview } from '@generator/preview';
import { PREVIEW_MODULE } from '@shared/component-preview';
import { descOf, listPropFor, refExists, studioCtx, studioDescOf, studioDesignCtx, studioPick, designCtx, type BridgeDesc } from '../../src/renderer/src/lib/model';
import { NEW_STUDIO, StudioLoads, studioSpec, studioVariants } from '../../src/renderer/src/lib/studio';

const starter = () => createStarterState('blank', 'Studio Test', false);
const own = (id: string) => ({ kind: 'component' as const, id });

/** A theme component installed in a blank project, unplaced, and its own nodes. */
function design(componentId: string) {
  const state = starter();
  const id = installComponent(state, componentId);
  const def = state.components[id];
  return { state, id, def, nodes: Object.values(def.tree!.nodes) };
}

/** A design with another managed component placed inside it, as the last child of its root element. */
function nestingDesign(): { state: ProjectState; id: string; nested: string } {
  const state = starter();
  const id = installComponent(state, 'features.grid');
  const inner = state.components[installComponent(state, 'content.media')];
  const def = state.components[id];
  const root = def.tree!.nodes[def.tree!.rootIds[0]];
  if (root.kind !== 'element' || inner.kind !== 'managed' || !inner.tree) throw new Error('Unexpected fixture');
  const node = makeInstance(inner);
  def.tree!.nodes[node.id] = node;
  root.children.push(node.id);
  return { state, id, nested: node.id };
}

describe('Component Studio: the design in the isolated preview', () => {
  it('renders the design under the context the studio maps', () => {
    const { state, id, def } = design('features.grid');
    const out = generateComponentPreview(state, { definitionId: id });
    if ('error' in out) throw new Error(out.error);
    // The preview passes the design's context to its one instance; the design's own nodes carry it.
    expect(out.files.get(PREVIEW_MODULE)).toContain(`__so={${JSON.stringify(studioCtx(id))}}`);
    expect(studioDescOf(state, id, { owner: own(id), instancePath: [], nodeId: def.tree!.rootIds[0] })).toEqual({ ctx: studioCtx(id), node: def.tree!.rootIds[0], items: '' });
  });

  it('picks the design’s own nodes and gives back the same reference for each', () => {
    const { state, id, def, nodes } = design('features.grid');
    for (const n of nodes) {
      const ref: ElementRef = { owner: own(id), instancePath: [], nodeId: n.id };
      const desc = studioDescOf(state, id, ref)!;
      const picked = studioPick(state, id, [desc]);
      // A component placed in the design is picked whole, by its own root: the same node of the design.
      expect(picked?.nodeId).toBe(n.id);
      expect(picked?.owner).toEqual(own(id));
      expect(picked?.instancePath).toEqual([]);
      const part = Object.entries(def.parts).find(([, p]) => p.nodeId === n.id)?.[0];
      expect(picked?.partId).toBe(part);
    }
  });

  it('keeps an item of the design’s own list, and lets go of one only the sample content has', () => {
    const { state, id, def, nodes } = design('features.grid');
    const repeated = nodes.find((n) => listPropFor(def, n.id));
    expect(repeated).toBeDefined();
    const list = def.properties[listPropFor(def, repeated!.id)!];
    const itemId = (list.default as Array<{ id: string }>)[0].id;
    const desc = studioDescOf(state, id, { owner: own(id), instancePath: [], nodeId: repeated!.id, itemPath: [itemId] })!;
    expect(desc.items).toBe(descOf(state, { owner: own(id), instancePath: [], nodeId: repeated!.id, itemPath: [itemId] }).items);
    const kept = studioPick(state, id, [desc])!;
    expect(kept.itemPath).toEqual([itemId]);
    expect(refExists(state, kept)).toBe(true);
    const sample = studioPick(state, id, [{ ...desc, items: `${itemId}-sample-3` }])!;
    expect(sample.itemPath).toBeUndefined();
    expect(sample.nodeId).toBe(repeated!.id);
  });

  it('picks a component inside the design whole, from anything inside it, and outlines its parts through it', () => {
    const { state, id, nested } = nestingDesign();
    const inner = state.components[(state.components[id].tree!.nodes[nested] as { definitionId: string }).definitionId];
    const deep = Object.keys(inner.tree!.nodes).find((k) => k !== inner.tree!.rootIds[0]) ?? inner.tree!.rootIds[0];
    const chain: BridgeDesc[] = [{ ctx: `${studioCtx(id)}|${nested}`, node: deep, items: '' }];
    expect(studioPick(state, id, chain)).toMatchObject({ owner: own(id), instancePath: [], nodeId: nested });
    // A part of it chosen in Layers is found inside the nested component's own markup.
    const part: ElementRef = { owner: own(id), instancePath: [nested], nodeId: deep };
    expect(studioDescOf(state, id, part)).toEqual({ ctx: `${studioCtx(id)}|${nested}`, node: deep, items: '' });
    expect(studioDesignCtx(state, id, part)).toBe(designCtx(state, part).replace(`component:${id}`, studioCtx(id)));
  });

  it('ignores the page, other components and the code wrapper', () => {
    const { state, id, def } = design('features.grid');
    const root = def.tree!.rootIds[0];
    expect(studioPick(state, id, [{ ctx: `page:${state.site.homePageId}`, node: root, items: '' }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: 'preview:other|preview', node: root, items: '' }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: `${studioCtx(id)}x`, node: root, items: '' }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: `preview:${id}`, node: 'preview', items: '', code: true }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: studioCtx(id), node: 'gone', items: '' }])).toBeNull();
    // Only the edited component's own references are shown.
    expect(studioDescOf(state, id, { owner: { kind: 'page', id: state.site.homePageId }, instancePath: [], nodeId: root })).toBeNull();
    expect(studioDescOf(state, 'other', { owner: own(id), instancePath: [], nodeId: root })).toBeNull();
  });
});

describe('Component Studio: what it shows', () => {
  it('shows the chosen option on each axis, the look being styled on its own, and the default for one gone', () => {
    const { def } = design('features.grid');
    const [[axis, a]] = Object.entries(def.variantAxes!);
    const other = Object.keys(a.options).find((o) => o !== a.default)!;
    expect(studioSpec(def, NEW_STUDIO)).toEqual({ definitionId: def.id });
    expect(studioSpec(def, { ...NEW_STUDIO, variants: { [axis]: other } })).toEqual({ definitionId: def.id, variants: { [axis]: other } });
    // An option removed since (an Undo) falls back to the default, and the request is the plain one again.
    expect(studioSpec(def, { ...NEW_STUDIO, variants: { [axis]: 'gone', nope: 'x' } })).toEqual({ definitionId: def.id });
    // Styling a look shows it, whatever the toolbar says for that axis; another component's look changes nothing.
    expect(studioVariants(def, { ...NEW_STUDIO, variants: { [axis]: a.default } }, { definitionId: def.id, axis, variant: other })[axis]).toBe(other);
    expect(studioVariants(def, NEW_STUDIO, { definitionId: 'other', axis, variant: other })[axis]).toBe(a.default);
    // Sample content goes with the request; the design is never changed.
    const before = JSON.stringify(def);
    expect(studioSpec(def, { ...NEW_STUDIO, sample: 'long' }).props).toBeDefined();
    expect(JSON.stringify(def)).toBe(before);
  });
});

describe('Component Studio: the previews its frame is given', () => {
  it('shows only the latest request, and releases every other preview', () => {
    const release = vi.fn();
    const loads = new StudioLoads(release);
    const a = loads.begin();
    const b = loads.begin();
    // B is prepared first and shown; A, older, arrives late and is let go at once.
    expect(loads.prepared(b, 'keyb')).toBe(true);
    expect(loads.prepared(a, 'keya')).toBe(false);
    expect(release.mock.calls).toEqual([['keya']]);
    expect(loads.shows('keyb')).toBe(true);
    expect(loads.shows('keya')).toBe(false);
    expect(loads.shows(undefined)).toBe(false);
    // The next one replaces it in the frame, and the one it replaces goes.
    const c = loads.begin();
    expect(loads.latest(c)).toBe(true);
    expect(loads.latest(b)).toBe(false);
    expect(loads.prepared(c, 'keyc')).toBe(true);
    expect(release.mock.calls).toEqual([['keya'], ['keyb']]);
    // Closing releases what is shown, and a request still being prepared is out of date.
    const d = loads.begin();
    loads.end();
    expect(release.mock.calls).toEqual([['keya'], ['keyb'], ['keyc']]);
    expect(loads.prepared(d, 'keyd')).toBe(false);
    expect(release.mock.calls.at(-1)).toEqual(['keyd']);
    expect(loads.shows('keyc')).toBe(false);
  });
});
