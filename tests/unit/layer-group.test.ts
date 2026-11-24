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
    copy: (pageId: string, nodeId: string | string[], rev: number) => session.copy(pageId, nodeId, rev),
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
  setState: (p: Partial<EditorState>) => void;
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
const clipboard = (await load('../../src/renderer/src/lib/clipboard')) as { copySelection: (plan?: Plan | null) => boolean; pasteCopy: () => boolean; forgetCopy: () => void };

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
  clipboard.forgetCopy();
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

/** A Section at the top of Home holding three headings side by side in its "content" slot. */
async function threeHeadings() {
  const r = await bridge.project.apply(
    {
      operations: [
        { type: 'node.insert', newNodeId: 'n_holder', owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
        ...['One', 'Two', 'Three'].map((text) => ({ type: 'node.insert' as const, owner: home(), parentId: 'n_holder', slot: 'content', primitive: 'heading' as const, text }))
      ]
    },
    { label: 'Headings' }
  );
  expect(r.ok).toBe(true);
  return slotIds();
}
const slotIds = (id = 'n_holder') => (session.state.pages[homeId()].nodes[id] as InstanceNode).slots!.content;
const textOf = (id: string, pageId = homeId()) => JSON.stringify((session.state.pages[pageId].nodes[id] as { text?: unknown }).text);

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
    // The very same selection written again, through either way of setting state.
    pickGalleryAndTestimonials();
    setState({ selection: getState().selection });
    expect(getState().layerSet).toBeNull();
    pickGalleryAndTestimonials();
    getState().setState({ selection: getState().selection });
    expect(getState().layerSet).toBeNull();
  });

  it('layers selected on a page that is not open are not acted on (an Undo brought it back while another is open)', async () => {
    pickGalleryAndTestimonials();
    setState({ pageId: aboutId() });
    expect(actions.planLayers()?.several).toBe(false);
    const n = entries();
    await actions.duplicateLayers();
    // The selection alone (as before this change) is what a shortcut reaches; never both, on a page not shown.
    expect(entries()).toBeLessThanOrEqual(n + 1);
    expect(sectionOf('media.gallery')).toBeDefined();
    expect(roots().filter((id) => (session.state.pages[homeId()].nodes[id] as InstanceNode).definitionId === (session.state.pages[homeId()].nodes[sectionOf('media.gallery')] as InstanceNode).definitionId)).toHaveLength(1);
  });

  it('duplicates three side by side, keeping which one is selected and where the range starts', async () => {
    const [h1, h2, h3] = await threeHeadings();
    setState({ selection: ref(home(), h2), layerSet: { owner: home(), ids: [h1, h2, h3], anchor: h3 } });
    await actions.duplicateLayers();
    const [, , , c1, c2, c3] = slotIds();
    expect(slotIds().slice(0, 3)).toEqual([h1, h2, h3]);
    expect([c1, c2, c3].map((id) => textOf(id))).toEqual([h1, h2, h3].map((id) => textOf(id)));
    expect(getState().selection).toEqual(ref(home(), c2));
    expect(getState().layerSet).toEqual({ owner: home(), ids: [c1, c2, c3], anchor: c3 });
  });

  it('a change that lands after the author moved on, or pressed Escape, leaves their selection alone', async () => {
    const { gallery, testimonials } = pickGalleryAndTestimonials();
    const elsewhere = ref(home(), roots()[0]);
    const moving = actions.duplicateLayers();
    setState({ selection: elsewhere });
    await moving;
    expect(roots()).toHaveLength(10);
    expect(getState().selection).toBe(elsewhere);
    expect(getState().layerSet).toBeNull();
    // Escape kept just the selection: the copies are not selected over it.
    setState({ selection: ref(home(), testimonials), layerSet: { owner: home(), ids: [gallery, testimonials], anchor: gallery } });
    const kept = getState().selection;
    const again = actions.duplicateLayers();
    setState({ layerSet: null });
    await again;
    expect(roots()).toHaveLength(12);
    expect(getState().selection).toBe(kept);
    expect(getState().layerSet).toBeNull();
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

  it('says how many links the move leaves going nowhere, not counting one that already did', async () => {
    const gallery = sectionOf('media.gallery');
    const testimonials = sectionOf('testimonials.grid');
    await bridge.project.apply(
      {
        operations: [
          { type: 'node.setContent', owner: home(), nodeId: gallery, field: 'anchor', value: 'gallery' },
          { type: 'node.setContent', owner: home(), nodeId: testimonials, field: 'anchor', value: 'praise' }
        ]
      },
      { label: 'Section IDs' }
    );
    // Buttons on About that jump to both sections on Home, and one that already goes nowhere.
    const about = { kind: 'page' as const, id: aboutId() };
    const button = (text: string) => ({ type: 'node.insert' as const, owner: about, parentId: 'n_jumpsection', slot: 'content', primitive: 'button' as const, text });
    const r = await bridge.project.apply({ operations: [{ type: 'node.insert', newNodeId: 'n_jumpsection', owner: about, parentId: null, index: 0, componentId: 'layout.section' }, button('See the work'), button('Read the reviews'), button('Lost')] }, { label: 'Buttons' });
    expect(r.ok).toBe(true);
    const [b1, b2, b3] = [1, 2, 3].map((i) => r.results![i].nodeId as string);
    const link = (nodeId: string, anchor: string) => ({ type: 'node.setContent' as const, owner: about, nodeId, field: 'link' as const, value: { type: 'page', target: homeId(), anchor } });
    await bridge.project.apply({ operations: [link(b1, 'gallery'), link(b2, 'praise'), link(b3, 'nowhere')] }, { label: 'Links' });
    pickGalleryAndTestimonials();
    const ids = await actions.moveToPage(aboutId());
    expect(ids).toHaveLength(2);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Moved Gallery and Testimonials to the end of About. 2 links now go to a section that isn’t there (moved from Home): Project health lists them.' });
    // The section IDs go with them (About has none of its own by those names).
    expect(ids!.map((id) => session.state.pages[aboutId()].nodes[id].anchor)).toEqual(['gallery', 'praise']);
  });

  it('a link that already went nowhere and moves with its section is not counted again', async () => {
    const r = await bridge.project.apply(
      {
        operations: [
          { type: 'node.insert', newNodeId: 'n_carrier', owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
          { type: 'node.insert', owner: home(), parentId: 'n_carrier', slot: 'content', primitive: 'button', text: 'Nowhere' }
        ]
      },
      { label: 'Button' }
    );
    const button = r.results![1].nodeId as string;
    await bridge.project.apply({ operations: [{ type: 'node.setContent', owner: home(), nodeId: button, field: 'link', value: { type: 'page', target: homeId(), anchor: 'nowhere' } }] }, { label: 'Link' });
    setState({ selection: ref(home(), 'n_carrier'), layerSet: null });
    expect(await actions.moveToPage(aboutId())).toHaveLength(1);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'info', text: 'Moved Section to the end of About.' });
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
    await actions.moveLayers(1);
    await actions.moveLayers(1);
    expect(roots().slice(g, g + 3)).toEqual([r[g + 2], gallery, testimonials]);
    expect(getState().selection).toEqual(ref(home(), testimonials));
    expect(getState().layerSet).toEqual({ owner: home(), ids: [gallery, testimonials], anchor: gallery });
  });

  it('a plan made before the project changed is refused whole, changing nothing', async () => {
    pickGalleryAndTestimonials();
    const plan = actions.planLayers();
    await bridge.project.apply({ operations: [{ type: 'page.update', pageId: homeId(), seoTitle: 'Meanwhile' }] }, { label: 'Edit browser title' });
    const before = JSON.stringify(session.state.pages[homeId()]);
    await actions.duplicateLayers(plan);
    expect(JSON.stringify(session.state.pages[homeId()])).toBe(before);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'The project changed while you were choosing. Choose again.' });
    const pages = JSON.stringify(session.state.pages);
    const n = entries();
    await actions.deleteLayers(plan);
    expect(await actions.moveToPage(aboutId(), plan)).toBeNull();
    await actions.moveLayers(-1, plan);
    expect(JSON.stringify(session.state.pages)).toBe(pages);
    expect(entries()).toBe(n);
  });
});

describe('copying several selected together, as Layers and ⌘C/⌘V do', () => {
  it('pastes elements after the last of the layers selected, in their list, never into one of them, and selects them as copied', async () => {
    const [h1, h2, h3] = await threeHeadings();
    // Two picked upwards: the selection is the first, the range starts at the second.
    setState({ selection: ref(home(), h1), layerSet: { owner: home(), ids: [h1, h2], anchor: h2 } });
    expect(clipboard.copySelection()).toBe(true);
    await vi.waitFor(() => expect(getState().toasts.at(-1)?.text).toBe('Copied Heading 2 and Heading 2. Paste them on any page with ⌘V.'));
    const n = entries();
    expect(clipboard.pasteCopy()).toBe(true);
    await vi.waitFor(() => expect(slotIds()).toHaveLength(5));
    expect(entries()).toBe(n + 1);
    const [, , c1, c2] = slotIds();
    expect(slotIds()).toEqual([h1, h2, c1, c2, h3]);
    expect([c1, c2].map((id) => textOf(id))).toEqual([h1, h2].map((id) => textOf(id)));
    await vi.waitFor(() => expect(getState().selection).toEqual(ref(home(), c1)));
    expect(getState().layerSet).toEqual({ owner: home(), ids: [c1, c2], anchor: c2 });
  });

  it('a menu\'s Copy copies what the menu was opened for, even if the selection moved on since', async () => {
    pickGalleryAndTestimonials();
    const plan = actions.planLayers();
    setState({ selection: ref(home(), roots()[0]) });
    clipboard.copySelection(plan);
    await vi.waitFor(() => expect(getState().toasts.at(-1)?.text).toBe('Copied Gallery and Testimonials. Paste them on any page with ⌘V.'));
  });

  it('pastes containers beside the containers selected, never into the last of them', async () => {
    const r = await bridge.project.apply(
      {
        operations: [
          { type: 'node.insert', newNodeId: 'n_boxes', owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
          { type: 'node.insert', owner: home(), parentId: 'n_boxes', slot: 'content', primitive: 'container' },
          { type: 'node.insert', owner: home(), parentId: 'n_boxes', slot: 'content', primitive: 'container' }
        ]
      },
      { label: 'Boxes' }
    );
    expect(r.ok).toBe(true);
    const [b1, b2] = slotIds('n_boxes');
    setState({ selection: ref(home(), b2), layerSet: { owner: home(), ids: [b1, b2], anchor: b1 } });
    clipboard.copySelection();
    await vi.waitFor(() => expect(getState().toasts.at(-1)?.text).toMatch(/^Copied/));
    clipboard.pasteCopy();
    await vi.waitFor(() => expect(slotIds('n_boxes')).toHaveLength(4));
    expect(slotIds('n_boxes').slice(0, 2)).toEqual([b1, b2]);
    expect((session.state.pages[homeId()].nodes[b2] as { children: string[] }).children).toEqual([]);
  });

  it('pastes two sections on another page, in order, as one change, selected together', async () => {
    pickGalleryAndTestimonials();
    clipboard.copySelection();
    await vi.waitFor(() => expect(getState().toasts.at(-1)?.text).toMatch(/^Copied Gallery and Testimonials/));
    setState({ pageId: aboutId(), selection: null });
    const before = roots(aboutId()).length;
    clipboard.pasteCopy();
    await vi.waitFor(() => expect(roots(aboutId())).toHaveLength(before + 2));
    const [g2, t2] = roots(aboutId()).slice(-2);
    expect([sectionOf('media.gallery', aboutId()), sectionOf('testimonials.grid', aboutId())]).toEqual([g2, t2]);
    await vi.waitFor(() => expect(getState().selection).toEqual(ref({ kind: 'page', id: aboutId() }, t2)));
    expect(getState().layerSet?.ids).toEqual([g2, t2]);
    await bridge.project.undo();
    expect(roots(aboutId())).toHaveLength(before);
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

  it('refuses layers that are not side by side, or named twice, and keeps one-section copies as they were', async () => {
    const [inner] = await threeHeadings();
    const gallery = sectionOf('media.gallery');
    expect(await session.copy(homeId(), ['n_holder', inner], session.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/side by side/) });
    expect(await session.copy(homeId(), [gallery, sectionOf('testimonials.grid'), gallery], session.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/named twice/) });
    expect(await session.copy(homeId(), [gallery, gallery], session.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/named twice/) });
    const one = await session.copy(homeId(), gallery, session.revision);
    const r = await session.apply({ operations: [{ type: 'node.paste', clipboardId: one.clipboardId!, toOwner: home(), parentId: null }] }, { label: 'Paste', source: 'user' });
    expect(r.results![0].nodeIds).toEqual([r.results![0].nodeId]);
    expect(roots().at(-1)).toBe(r.results![0].nodeId);
  });

  it('takes everything inside each section, in the page order, whatever order they were named in', async () => {
    const make = (id: string, text: string) => [
      { type: 'node.insert' as const, newNodeId: id, owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
      { type: 'node.insert' as const, owner: home(), parentId: id, slot: 'content', primitive: 'paragraph' as const, text }
    ];
    await session.apply({ operations: [...make('n_firstsec', 'Inside the first'), ...make('n_secondsec', 'Inside the second')] }, { label: 'Sections', source: 'user' });
    // n_secondsec was inserted at the top after n_firstsec, so the page reads second, first.
    expect(roots().slice(0, 2)).toEqual(['n_secondsec', 'n_firstsec']);
    const c = await session.copy(homeId(), ['n_firstsec', 'n_secondsec'], session.revision);
    const r = await session.apply({ operations: [{ type: 'node.paste', clipboardId: c.clipboardId!, toOwner: { kind: 'page', id: aboutId() }, parentId: null, index: 0 }] }, { label: 'Paste', source: 'user' });
    const ids = r.results![0].nodeIds as string[];
    expect(roots(aboutId()).slice(0, 2)).toEqual(ids);
    expect(ids).not.toContain('n_firstsec');
    const child = (id: string) => (session.state.pages[aboutId()].nodes[id] as InstanceNode).slots!.content[0];
    expect(ids.map((id) => textOf(child(id), aboutId()))).toEqual([JSON.stringify('Inside the second'), JSON.stringify('Inside the first')]);
    expect(ids.map(child)).not.toContain(slotIds('n_firstsec')[0]);
  });
});
