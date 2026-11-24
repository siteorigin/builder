import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';

// Several sibling sections selected together in Layers (#167), acted on through the editor's own actions against a
// real project session, behind a stand-in for the preload bridge: each action is one change, and one Undo.
let session: ProjectSession;
const opening = 'opening#layers';
let pending: Promise<unknown> = Promise.resolve();
const track = <T>(p: Promise<T>) => ((pending = p), p);
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string } = {}) => track(session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' }).then(refresh)),
    undo: () => track(session.undo().then(refresh)),
    undoEntry: (entryId: string) => track(session.undoEntry(entryId).then(refresh)),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

// The editor's store and actions are DOM code, outside this test project's types: loaded by a path the type
// checker does not follow, with just the shapes this test uses.
interface LayerSet {
  owner: OwnerRef;
  ids: string[];
  anchor: string;
}
interface Toast {
  text: string;
  kind: string;
  action?: { label: string; run: () => void };
}
interface EditorState {
  toasts: Toast[];
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: LayerSet | null;
  pageId: string | null;
  definitionMode: unknown;
}
interface Plan {
  several: boolean;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const actions = (await load('../../src/renderer/src/lib/actions')) as {
  planLayers: () => Plan | null;
  duplicateLayers: (plan?: Plan | null) => Promise<void>;
  deleteLayers: (plan?: Plan | null) => Promise<void>;
  moveLayers: (dir: -1 | 1, plan?: Plan | null) => Promise<void>;
  moveToPage: (pageId: string, plan?: Plan | null) => Promise<string[] | null>;
};
const { getState, setState } = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-layer-group-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, createStarterState('business', 'Studio', false));
  setState({ toasts: [], selection: null, layerSet: null, pageId: session.state.site.homePageId, definitionMode: null });
  refresh(null);
});
afterEach(async () => {
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const homeId = () => session.state.site.homePageId;
const aboutId = () => session.state.site.pageOrder.find((id) => session.state.pages[id].title === 'About')!;
const home: () => OwnerRef = () => ({ kind: 'page', id: homeId() });
const roots = (pageId = homeId(), s: ProjectState = session.state) => s.pages[pageId].rootIds;
const sectionOf = (componentId: string, pageId = homeId(), s: ProjectState = session.state) =>
  roots(pageId, s).find((id) => s.components[(s.pages[pageId].nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });
const entries = () => session.historyInfo().entries.filter((e) => e.applied).length;

/** Gallery picked, then Testimonials Shift-picked, as Layers leaves it. */
function pickGalleryAndTestimonials() {
  const gallery = sectionOf('media.gallery');
  const testimonials = sectionOf('testimonials.grid');
  setState({ selection: ref(home(), testimonials), layerSet: { owner: home(), ids: [gallery, testimonials], anchor: gallery } });
  return { gallery, testimonials };
}

describe('sections selected together in Layers', () => {
  it('⌘D duplicates Gallery and Testimonials together, as one change, and selects the copies', async () => {
    const before = JSON.stringify(session.state.pages[homeId()]);
    const { gallery, testimonials } = pickGalleryAndTestimonials();
    const n = entries();
    await actions.duplicateLayers();
    expect(entries()).toBe(n + 1);
    const after = roots();
    const g = after.indexOf(gallery);
    const [g2, t2] = after.slice(g + 2, g + 4);
    expect(after.slice(g, g + 2)).toEqual([gallery, testimonials]);
    expect(sectionOf('media.gallery', homeId())).toBe(gallery);
    expect([g2, t2].map((id) => session.state.components[(session.state.pages[homeId()].nodes[id] as InstanceNode).definitionId].componentId)).toEqual(['media.gallery', 'testimonials.grid']);
    // The copy of the selection is selected, with the other copy; the range still starts at the first.
    expect(getState().selection).toEqual(ref(home(), t2));
    expect(getState().layerSet).toEqual({ owner: home(), ids: [g2, t2], anchor: g2 });
    await bridge.project.undo();
    expect(JSON.stringify(session.state.pages[homeId()])).toBe(before);
  });

  it('a selection made anywhere else, even of the same section, lets the others go', () => {
    const { testimonials } = pickGalleryAndTestimonials();
    expect(actions.planLayers()?.several).toBe(true);
    setState({ selection: ref(home(), testimonials) });
    expect(getState().layerSet).toBeNull();
    expect(actions.planLayers()?.several).toBe(false);
  });

  it('moves both to the end of About as one change, follows them there, and one Undo puts both back', async () => {
    const before = JSON.stringify([session.state.pages[homeId()], session.state.pages[aboutId()]]);
    const aboutBefore = roots(aboutId());
    pickGalleryAndTestimonials();
    const n = entries();
    const ids = await actions.moveToPage(aboutId());
    expect(entries()).toBe(n + 1);
    expect(ids).toHaveLength(2);
    expect(roots(aboutId())).toEqual([...aboutBefore, ...ids!]);
    expect([sectionOf('media.gallery', aboutId()), sectionOf('testimonials.grid', aboutId())]).toEqual(ids);
    expect(sectionOf('media.gallery')).toBeUndefined();
    expect(sectionOf('testimonials.grid')).toBeUndefined();
    // About opens with both selected, Testimonials' copy as the selection.
    expect(getState().pageId).toBe(aboutId());
    expect(getState().selection).toEqual(ref({ kind: 'page', id: aboutId() }, ids![1]));
    expect(getState().layerSet?.ids).toEqual(ids);
    expect(getState().toasts.at(-1)).toMatchObject({ text: 'Moved Gallery and Testimonials to the end of About.', action: { label: 'Undo' } });
    await bridge.project.undo();
    expect(JSON.stringify([session.state.pages[homeId()], session.state.pages[aboutId()]])).toBe(before);
  });

  it('says when a link jumped to a moved section where it was', async () => {
    const gallery = sectionOf('media.gallery');
    const hero = roots()[0];
    await bridge.project.apply({ operations: [{ type: 'node.setContent', owner: home(), nodeId: gallery, field: 'anchor', value: 'gallery' }] }, { label: 'Section ID' });
    // A button on About that jumps to Home's gallery.
    const about = { kind: 'page' as const, id: aboutId() };
    const r = await bridge.project.apply(
      {
        operations: [
          { type: 'node.insert', newNodeId: 'n_jumpsection', owner: about, parentId: null, index: 0, componentId: 'layout.section' },
          { type: 'node.insert', owner: about, parentId: 'n_jumpsection', slot: 'content', primitive: 'button', text: 'See the work' }
        ]
      },
      { label: 'Button' }
    );
    expect(r.ok).toBe(true);
    const button = r.results![1].nodeId as string;
    await bridge.project.apply({ operations: [{ type: 'node.setContent', owner: about, nodeId: button, field: 'link', value: { type: 'page', target: homeId(), anchor: 'gallery' } }] }, { label: 'Link' });
    setState({ selection: ref(home(), gallery), layerSet: null });
    const ids = await actions.moveToPage(aboutId());
    expect(ids).toHaveLength(1);
    expect(getState().toasts.at(-1)?.text).toMatch(/^Moved Gallery to the end of About\. A link that jumped to it on Home now goes to a section Home no longer has/);
    expect(hero).toBe(roots()[0]);
  });

  it('deletes both as one change, with one Undo beside its notice', async () => {
    const before = JSON.stringify(session.state.pages[homeId()]);
    pickGalleryAndTestimonials();
    const n = entries();
    await actions.deleteLayers();
    expect(entries()).toBe(n + 1);
    expect(sectionOf('media.gallery')).toBeUndefined();
    expect(sectionOf('testimonials.grid')).toBeUndefined();
    expect(getState().selection).toBeNull();
    const t = getState().toasts.at(-1)!;
    expect(t.text).toBe('Deleted Gallery and Testimonials');
    pending = Promise.resolve();
    t.action!.run();
    await pending;
    expect(JSON.stringify(session.state.pages[homeId()])).toBe(before);
  });

  it('moves both up together, keeping them selected', async () => {
    const { gallery, testimonials } = pickGalleryAndTestimonials();
    const r = roots();
    const g = r.indexOf(gallery);
    const n = entries();
    await actions.moveLayers(-1);
    expect(entries()).toBe(n + 1);
    expect(roots().slice(g - 1, g + 2)).toEqual([gallery, testimonials, r[g - 1]]);
    expect(actions.planLayers()?.several).toBe(true);
  });

  it('a plan made before the project changed is refused whole, changing nothing', async () => {
    pickGalleryAndTestimonials();
    const plan = actions.planLayers();
    await bridge.project.apply({ operations: [{ type: 'page.update', pageId: homeId(), seoTitle: 'Meanwhile' }] }, { label: 'Edit browser title' });
    const before = JSON.stringify(session.state.pages[homeId()]);
    await actions.duplicateLayers(plan);
    expect(JSON.stringify(session.state.pages[homeId()])).toBe(before);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'The project changed while you were choosing. Choose again.' });
  });
});

describe('copying several sections side by side', () => {
  it('takes one copy of them in page order, and one paste places them all, in order, as one change', async () => {
    const gallery = sectionOf('media.gallery');
    const testimonials = sectionOf('testimonials.grid');
    const c = await session.copy(homeId(), [testimonials, gallery], session.revision);
    expect(c.ok).toBe(true);
    // Edited after copying: the paste is of the sections as they were.
    await session.apply({ operations: [{ type: 'node.remove', owner: home(), nodeId: gallery }] }, { label: 'Delete', source: 'user' });
    const n = entries();
    const r = await session.apply({ operations: [{ type: 'node.paste', clipboardId: c.clipboardId!, toOwner: { kind: 'page', id: aboutId() }, parentId: null, index: 1 }] }, { label: 'Paste', source: 'user' });
    expect(r.ok).toBe(true);
    expect(entries()).toBe(n + 1);
    const ids = r.results![0].nodeIds as string[];
    expect(r.results![0].nodeId).toBe(ids[0]);
    expect(roots(aboutId()).slice(1, 3)).toEqual(ids);
    expect([sectionOf('media.gallery', aboutId()), sectionOf('testimonials.grid', aboutId())]).toEqual(ids);
  });

  it('refuses layers that are not side by side, and keeps one-section copies as they were', async () => {
    const gallery = sectionOf('media.gallery');
    const s = session.state.pages[homeId()].nodes[roots()[0]] as InstanceNode;
    const inner = Object.values(s.slots ?? {}).flat()[0];
    if (inner) expect(await session.copy(homeId(), [gallery, inner], session.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/side by side/) });
    expect(await session.copy(homeId(), [gallery, gallery], session.revision)).toMatchObject({ ok: false });
    const one = await session.copy(homeId(), gallery, session.revision);
    const r = await session.apply({ operations: [{ type: 'node.paste', clipboardId: one.clipboardId!, toOwner: home(), parentId: null }] }, { label: 'Paste', source: 'user' });
    expect(r.results![0].nodeIds).toEqual([r.results![0].nodeId]);
    expect(roots().at(-1)).toBe(r.results![0].nodeId);
  });
});
