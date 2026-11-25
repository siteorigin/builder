import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, ElementNode, ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';
import { insertAt, insertOps, slotWhere, whereText } from '../../src/renderer/src/lib/insert-at';
import { layerSlots, placeOps } from '../../src/renderer/src/lib/layer-drop';
import { shownSlots, slotTargetHolds, type SlotTarget } from '../../src/renderer/src/lib/slot-target';
import { insertLanding } from '../../src/renderer/src/lib/command-inserts';

/*
 * Empty slots of a placed component in Layers (#653): each slot its component shows is listed, empty or not, can be
 * picked as where Insert puts the next thing, and takes layers dropped onto it, the slot's contract permitting.
 */

/** A Split: a Main slot that takes anything, then a Sidebar that takes text and buttons, one at most. */
const SPLIT: EditOperation = {
  type: 'component.upsert',
  name: 'Split',
  insertAs: 'element',
  properties: {},
  nodes: [
    { kind: 'element', id: 'root', tag: 'div', children: ['mainBox', 'sideBox'] },
    { kind: 'element', id: 'mainBox', tag: 'div', children: ['mainSlot'] },
    { kind: 'slot', id: 'mainSlot', slot: 'main' },
    { kind: 'element', id: 'sideBox', tag: 'aside', children: ['sideSlot'] },
    { kind: 'slot', id: 'sideSlot', slot: 'sidebar' }
  ],
  slots: { main: { label: 'Main' }, sidebar: { label: 'Sidebar', primitives: ['text', 'link'], max: 1 } }
} as EditOperation;

/** Home: a Section holding an empty Split, then two paragraphs and a Grid beside it. */
function page(state = createStarterState('blank', 'Expo', false)) {
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const made = applyOperations(state, [SPLIT]);
  const defId = made.results[0].definitionId as string;
  const out = applyOperations(made.state, [
    { type: 'node.insert', newNodeId: 'n_section', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', newNodeId: 'n_split', owner, parentId: 'n_section', slot: 'content', definitionId: defId },
    { type: 'node.insert', newNodeId: 'n_one', owner, parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'One' },
    { type: 'node.insert', newNodeId: 'n_two', owner, parentId: 'n_section', slot: 'content', primitive: 'paragraph', text: 'Two' },
    { type: 'node.insert', newNodeId: 'n_grid', owner, parentId: 'n_section', slot: 'content', primitive: 'grid' }
  ]);
  return { state: out.state, owner, defId };
}
const nodes = (s: ProjectState) => s.pages[s.site.homePageId].nodes;
const splitOf = (s: ProjectState) => nodes(s).n_split as InstanceNode;
const sidebar = (owner: OwnerRef): SlotTarget => ({ owner, parentId: 'n_split', slot: 'sidebar' });

describe('a placed component’s slots as Layers lists them (#653)', () => {
  it('lists every slot it shows in the order it declares them, empty ones too', () => {
    const p = page();
    expect(layerSlots(p.state, splitOf(p.state))).toEqual([
      { slot: 'main', label: 'Main', ids: [], shown: true },
      { slot: 'sidebar', label: 'Sidebar', ids: [], shown: true }
    ]);
    const filled = applyOperations(p.state, [{ type: 'node.move', owner: p.owner, nodeId: 'n_one', parentId: 'n_split', slot: 'sidebar', index: 0 }]).state;
    expect(layerSlots(filled, splitOf(filled)).map((l) => [l.slot, l.ids])).toEqual([
      ['main', []],
      ['sidebar', ['n_one']]
    ]);
  });

  it('keeps a slot its design no longer shows only while it holds something, and lists every slot of a code component', () => {
    const p = page();
    const filled = applyOperations(p.state, [{ type: 'node.move', owner: p.owner, nodeId: 'n_one', parentId: 'n_split', slot: 'sidebar', index: 0 }]).state;
    // The design loses its Sidebar outlet (as a hand edit could leave it): its content can still be reached.
    const cut = structuredClone(filled);
    const tree = cut.components[p.defId].tree!;
    delete tree.nodes.sideSlot;
    (tree.nodes.sideBox as ElementNode).children = [];
    expect(shownSlots(cut, p.defId)).toEqual(['main']);
    expect(layerSlots(cut, splitOf(cut))).toEqual([
      { slot: 'main', label: 'Main', ids: [], shown: true },
      { slot: 'sidebar', label: 'Sidebar', ids: ['n_one'], shown: false }
    ]);
    // Empty as well, it is never seen: not listed, and not a place to pick.
    const emptied = structuredClone(p.state);
    delete emptied.components[p.defId].tree!.nodes.sideSlot;
    expect(layerSlots(emptied, splitOf(emptied)).map((l) => l.slot)).toEqual(['main']);
    expect(slotTargetHolds(emptied, sidebar(p.owner))).toBe(false);
    // A code component renders its slots as its code likes: each one it declares is a place.
    const code = structuredClone(p.state);
    code.components[p.defId] = { ...code.components[p.defId], kind: 'code', tree: undefined } as unknown as ComponentDefinition;
    expect(layerSlots(code, splitOf(code)).map((l) => [l.slot, l.shown])).toEqual([
      ['main', true],
      ['sidebar', true]
    ]);
  });
});

describe('a slot picked as where Insert puts things (#653)', () => {
  it('takes an element into its secondary empty slot, and the Insert line names the slot', () => {
    const p = page();
    const t = sidebar(p.owner);
    const at = insertAt(p.state, p.owner, 'element', null, undefined, t);
    expect(at).toEqual({ owner: p.owner, parentId: 'n_split', slot: 'sidebar' });
    const out = applyOperations(p.state, insertOps(at!, { primitive: 'paragraph', text: 'Aside' }, 'element', 'n_aside'));
    expect(splitOf(out.state).slots?.sidebar).toEqual(['n_aside']);
    expect(splitOf(out.state).slots?.main ?? []).toEqual([]);
    expect(whereText(slotWhere(p.state, t)!)).toBe('inside Sidebar in Split');
    // The command menu's row says the same.
    expect(insertLanding(p.state, p.owner, null, { primitive: 'paragraph' }, t)).toEqual({ where: 'inside Sidebar in Split' });
  });

  it('wins over the selection and over how a section or the same component would go', () => {
    const p = page();
    const main: SlotTarget = { owner: p.owner, parentId: 'n_split', slot: 'main' };
    const sel: ElementRef = { owner: p.owner, instancePath: [], nodeId: 'n_two' };
    expect(insertAt(p.state, p.owner, 'element', sel, undefined, main)).toEqual({ owner: p.owner, parentId: 'n_split', slot: 'main' });
    expect(insertAt(p.state, p.owner, 'section', sel, undefined, main)).toEqual({ owner: p.owner, parentId: 'n_split', slot: 'main' });
    // Another Split goes into the picked slot, not beside the selected Split that holds it, as it would unpicked.
    const split: ElementRef = { owner: p.owner, instancePath: [], nodeId: 'n_split' };
    expect(insertAt(p.state, p.owner, 'element', split, p.defId)).toEqual({ owner: p.owner, parentId: 'n_section', slot: 'content', index: 1 });
    expect(insertAt(p.state, p.owner, 'element', split, p.defId, main)).toEqual({ owner: p.owner, parentId: 'n_split', slot: 'main' });
    // Without a pick the placement still fills its first slot.
    expect(insertAt(p.state, p.owner, 'element', { owner: p.owner, instancePath: [], nodeId: 'n_split' })).toEqual({ owner: p.owner, parentId: 'n_split', slot: 'main' });
  });

  it('is nowhere once it has gone, or for another page: what was clicked for it never lands somewhere else', () => {
    const p = page();
    expect(insertAt(p.state, p.owner, 'element', null, undefined, { ...sidebar(p.owner), parentId: 'n_gone' })).toBeNull();
    expect(insertAt(p.state, p.owner, 'element', null, undefined, { ...sidebar(p.owner), slot: 'nope' })).toBeNull();
    expect(insertAt(p.state, { kind: 'page', id: 'pg_other' }, 'element', null, undefined, sidebar(p.owner))).toBeNull();
    expect(insertAt(p.state, { kind: 'template', id: p.owner.id }, 'element', null, undefined, sidebar(p.owner))).toBeNull();
    expect(insertAt(p.state, p.owner, 'element', null, undefined, { ...sidebar(p.owner), parentId: 'n_one' })).toBeNull();
  });
});

describe('layers dropped onto a slot row (#653)', () => {
  it('moves a layer to the end of a secondary empty slot', () => {
    const p = page();
    const ops = placeOps(p.state.pages[p.owner.id], p.owner, ['n_one'], { parentId: 'n_split', slot: 'sidebar', before: null })!;
    expect(ops).toEqual([{ type: 'node.move', owner: p.owner, nodeId: 'n_one', parentId: 'n_split', slot: 'sidebar', index: 0 }]);
    const out = applyOperations(p.state, ops).state;
    expect(splitOf(out).slots?.sidebar).toEqual(['n_one']);
    expect((nodes(out).n_section as InstanceNode).slots?.content).toEqual(['n_split', 'n_two', 'n_grid']);
  });

  it('moves several together into an empty slot that takes them, in their order', () => {
    const p = page();
    const ops = placeOps(p.state.pages[p.owner.id], p.owner, ['n_one', 'n_two'], { parentId: 'n_split', slot: 'main', before: null })!;
    const out = applyOperations(p.state, ops).state;
    expect(splitOf(out).slots?.main).toEqual(['n_one', 'n_two']);
    // Dropped onto the slot that already ends with them, nothing moves.
    expect(placeOps(out.pages[p.owner.id], p.owner, ['n_one', 'n_two'], { parentId: 'n_split', slot: 'main', before: null })).toBeNull();
  });

  it('adds to the end of a slot that already holds something', () => {
    const p = page();
    const one = applyOperations(p.state, placeOps(p.state.pages[p.owner.id], p.owner, ['n_grid'], { parentId: 'n_split', slot: 'main', before: null })!).state;
    const ops = placeOps(one.pages[p.owner.id], p.owner, ['n_one', 'n_two'], { parentId: 'n_split', slot: 'main', before: null })!;
    expect(ops.map((o) => (o.type === 'node.move' ? o.index : -1))).toEqual([1, 2]);
    expect(splitOf(applyOperations(one, ops).state).slots?.main).toEqual(['n_grid', 'n_one', 'n_two']);
  });

  it('is refused whole by the slot’s contract: too many, or a kind it does not take', () => {
    const p = page();
    const two = placeOps(p.state.pages[p.owner.id], p.owner, ['n_one', 'n_two'], { parentId: 'n_split', slot: 'sidebar', before: null })!;
    expect(() => applyOperations(p.state, two)).toThrow(/“Sidebar” slot of “Split” holds at most one item/);
    const grid = placeOps(p.state.pages[p.owner.id], p.owner, ['n_grid'], { parentId: 'n_split', slot: 'sidebar', before: null })!;
    expect(() => applyOperations(p.state, grid)).toThrow(/“Sidebar” slot of “Split” takes text and buttons, not a container/);
  });
});

// The editor's store and actions, against a real project session behind a stand-in for the preload bridge, as
// layer-group.test does.
let session: ProjectSession;
const opening = 'opening#slots';
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string } = {}) => session.apply(batch, { label: opts.label ?? 'Edit', source: 'user' }).then(refresh),
    // Taken only in the opening it was pressed in, as the app does.
    copy: (pageId: string, nodeId: string | string[], rev: number, key?: string) => (key === opening ? session.copy(pageId, nodeId, rev) : Promise.resolve({ ok: false, message: 'That project is no longer open.' })),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

interface EditorState {
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: unknown;
  slotTarget: SlotTarget | null;
  pageId: string | null;
  definitionMode: unknown;
  leftTab: string;
  mode: string;
  toasts: unknown[];
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as { getState: () => EditorState; setState: (p: Partial<EditorState>) => void; selectSlot: (t: SlotTarget) => void };
const actions = (await load('../../src/renderer/src/lib/actions')) as { insert: (spec: object, label: string) => Promise<string | undefined>; deleteSelection: () => Promise<void> };
const clipboard = (await load('../../src/renderer/src/lib/clipboard')) as { copySelection: () => boolean; pasteCopy: (follow?: boolean) => boolean; forgetCopy: () => void };

function refresh<T>(r: T): T {
  store.setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-slot-target-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, page().state);
  store.setState({ toasts: [], selection: null, layerSet: null, slotTarget: null, pageId: session.state.site.homePageId, definitionMode: null, mode: 'preview' });
  clipboard.forgetCopy();
  refresh(null);
});
afterEach(async () => {
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('picking a slot in the editor (#653)', () => {
  const home = (): OwnerRef => ({ kind: 'page', id: session.state.site.homePageId });

  it('selects nothing else, and a tile clicked in Insert lands in that slot and is selected', async () => {
    store.setState({ selection: { owner: home(), instancePath: [], nodeId: 'n_two' }, layerSet: { owner: home(), ids: ['n_one', 'n_two'], anchor: 'n_one' } });
    store.selectSlot(sidebar(home()));
    expect(store.getState()).toMatchObject({ selection: null, layerSet: null, slotTarget: sidebar(home()) });
    // Showing Insert keeps it.
    store.setState({ leftTab: 'insert' });
    expect(store.getState().slotTarget).toEqual(sidebar(home()));
    await actions.insert({ primitive: 'paragraph', text: 'Aside' }, 'Paragraph');
    const placed = splitOf(session.state).slots?.sidebar ?? [];
    expect(placed).toHaveLength(1);
    expect(splitOf(session.state).slots?.main ?? []).toEqual([]);
    expect(store.getState().selection).toEqual({ owner: home(), instancePath: [], nodeId: placed[0] });
    expect(store.getState().slotTarget).toBeNull();
  });

  it('is let go by any selection, by another page, and by a change that takes its component away', async () => {
    store.selectSlot(sidebar(home()));
    store.setState({ selection: null });
    expect(store.getState().slotTarget).toBeNull();

    store.selectSlot(sidebar(home()));
    store.setState({ pageId: 'pg_elsewhere' });
    expect(store.getState().slotTarget).toBeNull();
    store.setState({ pageId: session.state.site.homePageId });

    store.selectSlot(sidebar(home()));
    store.setState({ definitionMode: { definitionId: splitOf(session.state).definitionId, returnPageId: home().id } });
    expect(store.getState().slotTarget).toBeNull();
    store.setState({ definitionMode: null });

    store.selectSlot(sidebar(home()));
    // A change elsewhere keeps it; one that removes the Split lets it go.
    await bridge.project.apply({ operations: [{ type: 'node.remove', owner: home(), nodeId: 'n_grid' }] });
    expect(store.getState().slotTarget).toEqual(sidebar(home()));
    await bridge.project.apply({ operations: [{ type: 'node.remove', owner: home(), nodeId: 'n_split' }] });
    expect(store.getState().slotTarget).toBeNull();
  });

  it('⌘V with a slot picked pastes into it, as a tile clicked in Insert goes', async () => {
    store.setState({ selection: { owner: home(), instancePath: [], nodeId: 'n_two' } });
    expect(clipboard.copySelection()).toBe(true);
    store.selectSlot({ owner: home(), parentId: 'n_split', slot: 'main' });
    await vi.waitFor(() => expect(clipboard.pasteCopy()).toBe(true));
    await vi.waitFor(() => expect(splitOf(session.state).slots?.main ?? []).toHaveLength(1));
    const [copy] = splitOf(session.state).slots!.main;
    expect(nodes(session.state)[copy]).toMatchObject({ kind: 'text', text: (nodes(session.state).n_two as { text: unknown }).text });
    expect(splitOf(session.state).slots?.sidebar ?? []).toEqual([]);
  });

  it('a paste that lands after another slot was picked leaves that pick alone', async () => {
    store.setState({ mode: 'edit', selection: { owner: home(), instancePath: [], nodeId: 'n_two' } });
    expect(clipboard.copySelection()).toBe(true);
    store.selectSlot({ owner: home(), parentId: 'n_split', slot: 'main' });
    await vi.waitFor(() => expect(clipboard.pasteCopy(false)).toBe(true));
    // Picked while the paste is on its way: it still lands where ⌘V was pressed for, and Sidebar stays picked.
    store.selectSlot(sidebar(home()));
    await vi.waitFor(() => expect(splitOf(session.state).slots?.main ?? []).toHaveLength(1));
    // The paste's own ending (where it selects what it pasted) comes a moment after the project has it.
    await new Promise((r) => setTimeout(r, 1000));
    expect(store.getState()).toMatchObject({ selection: null, slotTarget: sidebar(home()) });
  });

  it('Delete with a slot picked removes nothing: a slot is not its component', async () => {
    store.selectSlot(sidebar(home()));
    const before = JSON.stringify(session.state.pages[home().id]);
    await actions.deleteSelection();
    expect(JSON.stringify(session.state.pages[home().id])).toBe(before);
    expect(store.getState().slotTarget).toEqual(sidebar(home()));
  });
});
