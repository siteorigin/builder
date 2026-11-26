import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, OwnerRef } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';

// Copy and Paste from the menus, and Paste right after switching pages (#200): the items the menus share, run against
// a real project session behind a stand-in for the preload bridge. The editor's key handler runs `pasteCopy` for ⌘V once
// a control has let the key through (clip-keys), so a paste from a menu and a paste from the key land the same way.
let session: ProjectSession;
const opening = 'opening#copy-paste-menus';
let pending: Promise<unknown> = Promise.resolve();
const track = <T>(p: Promise<T>) => ((pending = p), p);
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string } = {}) => track(session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' }).then(refresh)),
    undo: () => track(session.undo().then(refresh)),
    copy: (pageId: string, nodeId: string | string[], rev: number, key?: string) => (key === opening ? session.copy(pageId, nodeId, rev) : Promise.resolve({ ok: false, message: 'That project is no longer open.' })),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

interface Toast {
  text: string;
  kind: string;
}
interface EditorState {
  toasts: Toast[];
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: unknown;
  pageId: string | null;
  mode: 'edit' | 'preview';
  definitionMode: { definitionId: string; returnPageId: string } | null;
}
/** What the key handler asks of the control that has focus: whether it sits inside a container. */
interface Control {
  closest?: (selector: string) => unknown;
}
interface Item {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect?: () => void;
}
const load = (path: string) => import(/* @vite-ignore */ path);
// Each test loads the editor's modules afresh, so nothing copied in one reaches the next.
let actions: { selectPage: (pageId: string) => void; insert: (spec: { primitive: string }, label: string, tile?: unknown) => Promise<unknown>;
  insertionPoint: (role: 'element') => unknown;
  insertHere: (spec: { primitive: string }, name: string, role: 'element', at: unknown, snap: ProjectSnapshot, tile?: unknown) => Promise<boolean>;
};
let store: { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };
let clipboard: {
  copySelection: (plan?: unknown) => boolean;
  pasteCopy: () => boolean;
  pasteFromMenu: () => void;
  forgetCopy: () => void;
  copiedHere: () => { label: string; count: number } | null;
};
let clipKeys: {
  clipKeyIsEditors: (chord: 'copy' | 'paste', target: Control | null, body: unknown, selection?: unknown) => boolean;
  deleteKeyIsEditors: (target: Control | null, body: unknown, selection: unknown) => boolean;
  claimForInsert: (control: unknown, selection: unknown) => void;
  forgetInsert: () => void;
};
let menus: { copyPasteItems: (a: { copy: (() => void) | null; paste: (() => void) | null }) => Item[] };
const getState = () => store.getState();
const setState = (p: Partial<EditorState>) => store.setState(p);

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-copy-paste-menus-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, createStarterState('business', 'Studio', false));
  bridge.platform = 'darwin';
  vi.resetModules();
  actions = await load('../../src/renderer/src/lib/actions');
  store = await load('../../src/renderer/src/store');
  clipboard = await load('../../src/renderer/src/lib/clipboard');
  menus = await load('../../src/renderer/src/panels/CopyPaste');
  clipKeys = await load('../../src/renderer/src/lib/clip-keys');
  setState({ toasts: [], selection: null, layerSet: null, pageId: session.state.site.homePageId, definitionMode: null, mode: 'edit' });
  refresh(null);
});
afterEach(async () => {
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const homeId = () => session.state.site.homePageId;
const contactId = () => session.state.site.pageOrder.find((id) => session.state.pages[id].title === 'Contact')!;
const home: () => OwnerRef = () => ({ kind: 'page', id: homeId() });
const ref = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });
const sectionOf = (componentId: string, pageId = homeId()) => session.state.pages[pageId].rootIds.find((id) => session.state.components[(session.state.pages[pageId].nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;
const componentIdOf = (pageId: string, nodeId: string) => session.state.components[(session.state.pages[pageId].nodes[nodeId] as InstanceNode).definitionId].componentId;
const entries = () => session.historyInfo().entries.filter((e) => e.applied).length;
const lastToast = () => getState().toasts.at(-1);

/** What a menu lists: the same builder the Canvas, Layers and Inspector menus call, with their Copy and Paste. */
const items = (): { copy: Item; paste: Item } => {
  const list = menus.copyPasteItems({ copy: () => void clipboard.copySelection(), paste: () => clipboard.pasteFromMenu() });
  return { copy: list.find((i) => i.label === 'Copy')!, paste: list.find((i) => i.label === 'Paste')! };
};
/** Chooses Copy in a menu, and waits for the project to have taken the copy. */
async function chooseCopy() {
  items().copy.onSelect!();
  await vi.waitFor(() => expect(lastToast()?.text).toMatch(/^Copied /));
}

describe('Copy and Paste in the menus', () => {
  it('lists Copy and Paste with this platform’s keys, Paste unavailable until something is copied', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    let { copy, paste } = items();
    expect([copy.shortcut, paste.shortcut]).toEqual(['⌘C', '⌘V']);
    expect(copy.disabled).toBeFalsy();
    expect(paste.disabled).toBe(true);
    bridge.platform = 'win32';
    ({ copy, paste } = items());
    expect([copy.shortcut, paste.shortcut]).toEqual(['Ctrl+C', 'Ctrl+V']);
    await chooseCopy();
    expect(items().paste.disabled).toBe(false);
    expect(clipboard.copiedHere()).toEqual({ label: 'Gallery', count: 1, opening });
  });

  it('leaves a menu without Copy when the selection cannot be copied, and without either when asked for neither', () => {
    expect(menus.copyPasteItems({ copy: null, paste: () => undefined }).map((i) => i.label)).toEqual(['Paste']);
    expect(menus.copyPasteItems({ copy: () => undefined, paste: null }).map((i) => i.label)).toEqual(['Copy']);
    expect(menus.copyPasteItems({ copy: null, paste: null })).toEqual([]);
  });

  it('copies a section from one page and pastes it on another from the menus alone', async () => {
    const gallery = sectionOf('media.gallery');
    setState({ selection: ref(home(), gallery) });
    await chooseCopy();
    // The page is switched with the pointer, as the Pages list, the toolbar and the command menu all do.
    actions.selectPage(contactId());
    expect(getState().selection).toBeNull();
    const before = session.state.pages[contactId()].rootIds.length;
    const n = entries();
    expect(items().paste.disabled).toBe(false);
    items().paste.onSelect!();
    await vi.waitFor(() => expect(session.state.pages[contactId()].rootIds).toHaveLength(before + 1));
    await pending;
    expect(entries()).toBe(n + 1);
    // At the end of the page it was chosen on, as a new section with its own ID; the original stays where it was.
    const pasted = session.state.pages[contactId()].rootIds.at(-1)!;
    expect(componentIdOf(contactId(), pasted)).toBe('media.gallery');
    expect(session.state.pages[homeId()].rootIds).toContain(gallery);
    await vi.waitFor(() => expect(getState().selection).toEqual(ref({ kind: 'page', id: contactId() }, pasted)));
  });

  it('pastes the instant the page changes, as ⌘V does after the page switcher or the command menu, and not again', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    clipboard.copySelection();
    // Switched, and pressed at once: the project may still be taking the copy, and the paste waits for it.
    actions.selectPage(contactId());
    const before = session.state.pages[contactId()].rootIds.length;
    expect(clipboard.pasteCopy()).toBe(true);
    await vi.waitFor(() => expect(session.state.pages[contactId()].rootIds).toHaveLength(before + 1));
    await pending;
    expect(session.state.pages[homeId()].rootIds.filter((id) => componentIdOf(homeId(), id) === 'media.gallery')).toHaveLength(1);
    expect(componentIdOf(contactId(), session.state.pages[contactId()].rootIds.at(-1)!)).toBe('media.gallery');
    // The copy is still there for another page, which it also pastes onto.
    const other = session.state.site.pageOrder.find((id) => id !== homeId() && id !== contactId())!;
    const otherBefore = session.state.pages[other].rootIds.length;
    actions.selectPage(other);
    expect(clipboard.pasteCopy()).toBe(true);
    await vi.waitFor(() => expect(session.state.pages[other].rootIds).toHaveLength(otherBefore + 1));
    expect(componentIdOf(other, session.state.pages[other].rootIds.at(-1)!)).toBe('media.gallery');
    expect(session.state.pages[contactId()].rootIds).toHaveLength(before + 1);
  });

  it('pastes after the section the menu named, not at the end of the page', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    await chooseCopy();
    actions.selectPage(contactId());
    const before = session.state.pages[contactId()].rootIds.length;
    const first = session.state.pages[contactId()].rootIds[0];
    setState({ selection: ref({ kind: 'page', id: contactId() }, first) });
    items().paste.onSelect!();
    await vi.waitFor(() => expect(session.state.pages[contactId()].rootIds).toHaveLength(before + 1));
    const roots = session.state.pages[contactId()].rootIds;
    expect(roots[0]).toBe(first);
    expect(componentIdOf(contactId(), roots[1])).toBe('media.gallery');
  });

  it('keeps Paste unavailable after the project closes, after a copy that failed, and for a read-only project', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    // A copy against a revision the project has moved past is refused, in front of the author, and is not a copy.
    setState({ snapshot: { ...getState().snapshot!, revision: session.revision - 1 } });
    clipboard.copySelection();
    await vi.waitFor(() => expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/changed while copying/) }));
    expect(items().paste.disabled).toBe(true);
    refresh(null);
    await chooseCopy();
    expect(items().paste.disabled).toBe(false);
    setState({ snapshot: { ...getState().snapshot!, readOnly: true } as unknown as ProjectSnapshot });
    expect(items().paste.disabled).toBe(true);
    refresh(null);
    expect(items().paste.disabled).toBe(false);
    // Closing the project takes its copies with it: a menu opened in the next one has nothing to paste.
    clipboard.forgetCopy();
    expect(items().paste.disabled).toBe(true);
    expect(clipboard.copiedHere()).toBeNull();
  });

  it('falls back to the copy before it when a later one is refused, and to nothing when the only one is', async () => {
    const gallery = sectionOf('media.gallery');
    setState({ selection: ref(home(), gallery) });
    await chooseCopy();
    // A second copy against a revision the project has moved past is refused: Paste still pastes the Gallery.
    setState({ selection: ref(home(), sectionOf('testimonials.grid')), snapshot: { ...getState().snapshot!, revision: session.revision - 1 } });
    clipboard.copySelection();
    await vi.waitFor(() => expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/changed while copying/) }));
    expect(clipboard.copiedHere()).toMatchObject({ label: 'Gallery' });
    expect(items().paste.disabled).toBe(false);
    refresh(null);
    actions.selectPage(contactId());
    const before = session.state.pages[contactId()].rootIds.length;
    items().paste.onSelect!();
    await vi.waitFor(() => expect(session.state.pages[contactId()].rootIds).toHaveLength(before + 1));
    expect(componentIdOf(contactId(), session.state.pages[contactId()].rootIds.at(-1)!)).toBe('media.gallery');
  });

  it('says so, and writes nothing, when Paste is chosen from a menu that was open while its copy went away', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    await chooseCopy();
    // The menu was built with Paste available; then the project's copy is gone (the project closed and opened again).
    const paste = items().paste;
    expect(paste.disabled).toBe(false);
    clipboard.forgetCopy();
    const sent = vi.spyOn(session, 'apply');
    const n = session.state.pages[homeId()].rootIds.length;
    paste.onSelect!();
    expect(getState().toasts.filter((t) => /Nothing was pasted|Nothing is copied/.test(t.text))).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).not.toHaveBeenCalled();
    expect(session.state.pages[homeId()].rootIds).toHaveLength(n);
  });

  it('says so, and writes nothing, when the only copy was refused while the menu was open', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')), snapshot: { ...getState().snapshot!, revision: session.revision - 1 } });
    clipboard.copySelection();
    // Pending: Paste is on offer in a menu opened now.
    const paste = items().paste;
    expect(paste.disabled).toBe(false);
    await vi.waitFor(() => expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/changed while copying/) }));
    refresh(null);
    const sent = vi.spyOn(session, 'apply');
    paste.onSelect!();
    expect(lastToast()).toMatchObject({ kind: 'info', text: expect.stringMatching(/Nothing is copied/) });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).not.toHaveBeenCalled();
  });

  it('is not offered while only previewing, and a menu left open into Preview pastes nothing', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    await chooseCopy();
    const paste = items().paste;
    expect(paste.disabled).toBe(false);
    setState({ mode: 'preview' });
    expect(items().paste.disabled).toBe(true);
    const n = session.state.pages[homeId()].rootIds.length;
    paste.onSelect!();
    expect(lastToast()).toMatchObject({ kind: 'info', text: expect.stringMatching(/not in Preview/) });
    await new Promise((r) => setTimeout(r, 50));
    expect(session.state.pages[homeId()].rootIds).toHaveLength(n);
    // Copy is only a read: it stays on offer.
    expect(items().copy.disabled).toBeFalsy();
  });

  it('is never offered a copy from another opening of the project', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    await chooseCopy();
    // The same project opened again is another opening, which holds no copies of the last.
    setState({ snapshot: { ...getState().snapshot!, workspaceKey: 'opening#another' } });
    expect(items().paste.disabled).toBe(true);
    expect(clipboard.copiedHere()).toBeNull();
  });
});

describe('Paste in a component edited everywhere', () => {
  /** A project copy of the hero, as Edit everywhere makes one, entered from Home. */
  async function editEverywhere() {
    const hero = Object.values(session.state.pages[homeId()].nodes).find((n): n is InstanceNode => n.kind === 'instance' && session.state.components[n.definitionId]?.componentId === 'hero.split')!;
    const r = await bridge.project.apply({ operations: [{ type: 'component.fork', definitionId: hero.definitionId }] }, { label: 'Fork' });
    expect(r.ok).toBe(true);
    const definitionId = r.results![0].definitionId as string;
    const owner: OwnerRef = { kind: 'component', id: definitionId };
    const tree = () => session.state.components[definitionId].tree!;
    return { definitionId, owner, tree, root: tree().rootIds[0] };
  }
  const enter = (definitionId: string) => setState({ definitionMode: { definitionId, returnPageId: homeId() }, pageId: homeId(), selection: null, layerSet: null });
  const childrenOf = (tree: () => { nodes: Record<string, unknown> }, id: string) => {
    const n = tree().nodes[id] as { kind: string; children?: string[]; slots?: Record<string, string[]> };
    return n.kind === 'element' ? n.children! : Object.values(n.slots ?? {}).flat();
  };

  /** The node that holds `id` in the component's design. */
  const parentOf = (tree: () => { nodes: Record<string, unknown> }, id: string) => Object.keys(tree().nodes).find((p) => childrenOf(tree, p).includes(id) && (tree().nodes[p] as { kind: string }).kind !== 'text');

  it('pastes a copied section inside the component’s root when nothing is selected, and selects it as the component’s own', async () => {
    const edit = await editEverywhere();
    const stats = sectionOf('stats.row');
    const statsDefinition = (session.state.pages[homeId()].nodes[stats] as InstanceNode).definitionId;
    setState({ selection: ref(home(), stats) });
    await chooseCopy();
    enter(edit.definitionId);
    const before = childrenOf(edit.tree, edit.root).length;
    expect(items().paste.disabled).toBe(false);
    items().paste.onSelect!();
    await vi.waitFor(() => expect(childrenOf(edit.tree, edit.root)).toHaveLength(before + 1));
    await pending;
    const id = childrenOf(edit.tree, edit.root).at(-1)!;
    expect(id).not.toBe(stats);
    expect((edit.tree().nodes[id] as InstanceNode).definitionId).toBe(statsDefinition);
    await vi.waitFor(() => expect(getState().selection).toEqual(ref(edit.owner, id)));
    // The page it was copied from is as it was.
    expect(session.state.pages[homeId()].rootIds).toContain(stats);
    // One Undo takes the paste back.
    await bridge.project.undo();
    expect(childrenOf(edit.tree, edit.root)).toHaveLength(before);
  });

  it('pastes a copied section inside the container selected in the component, not beside the root’s children', async () => {
    const edit = await editEverywhere();
    setState({ selection: ref(home(), sectionOf('stats.row')) });
    await chooseCopy();
    enter(edit.definitionId);
    // "content" is the hero's text column, two levels down from its root.
    expect(parentOf(edit.tree, 'content')).toBe('grid');
    setState({ selection: ref(edit.owner, 'content') });
    const before = childrenOf(edit.tree, 'content').length;
    items().paste.onSelect!();
    await vi.waitFor(() => expect(childrenOf(edit.tree, 'content')).toHaveLength(before + 1));
    await pending;
    const id = childrenOf(edit.tree, 'content').at(-1)!;
    expect(parentOf(edit.tree, id)).toBe('content');
    await vi.waitFor(() => expect(getState().selection).toEqual(ref(edit.owner, id)));
  });

  it('pastes where ⌘V was pressed, and leaves the selection to an author who has moved on', async () => {
    const edit = await editEverywhere();
    setState({ selection: ref(home(), sectionOf('stats.row')) });
    await chooseCopy();
    enter(edit.definitionId);
    // "content" is selected when ⌘V is pressed; by the time the paste lands the author has moved on to another container.
    setState({ selection: ref(edit.owner, 'content') });
    const [inContent, inMedia] = [childrenOf(edit.tree, 'content').length, childrenOf(edit.tree, 'media-wrap').length];
    expect(clipboard.pasteCopy()).toBe(true);
    setState({ selection: ref(edit.owner, 'media-wrap') });
    await vi.waitFor(() => expect(childrenOf(edit.tree, 'content')).toHaveLength(inContent + 1));
    await pending;
    // The paste has been selected or left alone by now.
    await new Promise((r) => setTimeout(r, 50));
    expect(childrenOf(edit.tree, 'media-wrap')).toHaveLength(inMedia);
    expect(getState().selection).toEqual(ref(edit.owner, 'media-wrap'));
  });

  it('does not select the paste once the author has gone back to the page, though it was made in the component', async () => {
    const edit = await editEverywhere();
    setState({ selection: ref(home(), sectionOf('stats.row')) });
    await chooseCopy();
    enter(edit.definitionId);
    const before = childrenOf(edit.tree, edit.root).length;
    clipboard.pasteFromMenu();
    // Done editing: back on the page, with nothing selected, before the paste lands.
    setState({ definitionMode: null, selection: null });
    await vi.waitFor(() => expect(childrenOf(edit.tree, edit.root)).toHaveLength(before + 1));
    await pending;
    await new Promise((r) => setTimeout(r, 50));
    expect(getState().selection).toBeNull();
  });

  it('says there is nowhere to paste when the component’s design is a single paragraph', async () => {
    // A component made from one heading: its root takes nothing inside it.
    const made = await bridge.project.apply(
      {
        operations: [
          { type: 'node.insert', newNodeId: 'n_holder', owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
          { type: 'node.insert', newNodeId: 'n_title', owner: home(), parentId: 'n_holder', slot: 'content', primitive: 'heading', text: 'Title' },
          { type: 'component.createFromNode', owner: home(), nodeId: 'n_title', name: 'Just a title' }
        ]
      },
      { label: 'Make a component' }
    );
    expect(made.ok).toBe(true);
    const definitionId = made.results!.at(-1)!.definitionId as string;
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    await chooseCopy();
    enter(definitionId);
    const sent = vi.spyOn(session, 'apply');
    clipboard.pasteFromMenu();
    await vi.waitFor(() => expect(lastToast()).toMatchObject({ kind: 'info', text: expect.stringMatching(/no container to hold Gallery/) }));
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses a paste that would make the component contain itself, and says why', async () => {
    const edit = await editEverywhere();
    // The page's own hero placement is now this project component: pasted into itself it would contain itself.
    const hero = Object.values(session.state.pages[homeId()].nodes).find((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === edit.definitionId)!;
    setState({ selection: ref(home(), hero.id) });
    await chooseCopy();
    enter(edit.definitionId);
    const before = JSON.stringify(session.state.components[edit.definitionId]);
    items().paste.onSelect!();
    await vi.waitFor(() => expect(lastToast()?.kind).toBe('error'));
    expect(lastToast()?.text).toMatch(/contain itself/);
    expect(JSON.stringify(session.state.components[edit.definitionId])).toBe(before);
  });

  it('still takes no copy from inside the component, and says to Duplicate there', async () => {
    const edit = await editEverywhere();
    enter(edit.definitionId);
    setState({ selection: ref(edit.owner, childrenOf(edit.tree, edit.root)[0]) });
    expect(clipboard.copySelection()).toBe(true);
    expect(lastToast()).toMatchObject({ kind: 'error', text: expect.stringMatching(/Inside a component, use Duplicate/) });
    expect(clipboard.copiedHere()).toBeNull();
  });
});

describe('which controls let ⌘C and ⌘V through to the editor', () => {
  const body: Control = {};
  /** A control that sits inside the named containers, as the DOM's `closest` would answer. */
  const inside = (...selectors: string[]): Control => ({ closest: (list: string) => (selectors.some((s) => list.includes(s)) ? {} : null) });
  const switcher = inside('.toolbar');
  const pageSettings = inside('.insp-body', '.dock');
  const layers = inside('[role="tree"]');

  it('lets ⌘V through from any control, so a page just picked in the switcher or the command menu takes the paste', () => {
    for (const control of [body, switcher, pageSettings, layers, inside('.pages-list'), inside('.canvas'), inside('.assets')]) expect(clipKeys.clipKeyIsEditors('paste', control, body)).toBe(true);
    expect(clipKeys.clipKeyIsEditors('paste', null, body)).toBe(true);
  });

  it('keeps ⌘C to the page, Layers, the Pages list, the chip and the selection’s own heading', () => {
    for (const control of [body, layers, inside('.canvas'), inside('.ov-chip'), inside('.pages-list'), inside('.insp-head')]) expect(clipKeys.clipKeyIsEditors('copy', control, body)).toBe(true);
    for (const control of [switcher, pageSettings, inside('.assets'), null]) expect(clipKeys.clipKeyIsEditors('copy', control, body)).toBe(false);
  });

  it('keeps Delete to the page, Layers and the chip', () => {
    for (const control of [body, layers, inside('.canvas'), inside('.ov-chip')]) expect(clipKeys.deleteKeyIsEditors(control, body, {})).toBe(true);
    for (const control of [switcher, pageSettings, inside('.assets'), inside('.pages-list'), inside('.insp-head'), null]) expect(clipKeys.deleteKeyIsEditors(control, body, {})).toBe(false);
  });

  // Focus stays on the Insert tile, with what it inserted selected (#898).
  it('gives ⌘C and Delete to the tile that inserted the selection, while that stays selected', () => {
    const [tile, otherTile] = [inside('.insert-body'), inside('.insert-body')];
    const [inserted, other] = [{ nodeId: 'n_new' }, { nodeId: 'n_new' }];
    const takes = (control: Control, selection: unknown) => [clipKeys.clipKeyIsEditors('copy', control, body, selection), clipKeys.deleteKeyIsEditors(control, body, selection)];
    expect(takes(tile, inserted)).toEqual([false, false]);
    clipKeys.claimForInsert(tile, inserted);
    expect(takes(tile, inserted)).toEqual([true, true]);
    expect(takes(otherTile, inserted)).toEqual([false, false]);
    expect(takes(tile, other)).toEqual([false, false]);
    expect(takes(tile, null)).toEqual([false, false]);
    clipKeys.forgetInsert();
    expect(takes(tile, inserted)).toEqual([false, false]);
    // An insert made from no tile (the command menu) takes the claim away.
    clipKeys.claimForInsert(tile, inserted);
    clipKeys.claimForInsert(undefined, other);
    expect(takes(tile, inserted)).toEqual([false, false]);
  });

  it('claims the tile for what insert() selects, and only for a tile it was given', async () => {
    const tile = inside('.insert-body');
    await actions.insert({ primitive: 'heading' }, 'Heading', tile);
    const selection = getState().selection;
    expect(selection).not.toBeNull();
    expect(clipKeys.deleteKeyIsEditors(tile, body, selection)).toBe(true);
    await actions.insert({ primitive: 'paragraph' }, 'Paragraph');
    expect(clipKeys.deleteKeyIsEditors(tile, body, getState().selection)).toBe(false);
  });

  it('claims the tile a drag came from for what the drop selects', async () => {
    const tile = inside('.insert-body');
    const at = actions.insertionPoint('element');
    expect(await actions.insertHere({ primitive: 'heading' }, 'Heading', 'element', at, getState().snapshot!, tile)).toBe(true);
    expect(clipKeys.clipKeyIsEditors('copy', tile, body, getState().selection)).toBe(true);
  });
});
