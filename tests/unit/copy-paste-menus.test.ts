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
let actions: { selectPage: (pageId: string) => void };
let store: { getState: () => EditorState; setState: (p: Partial<EditorState>) => void };
let clipboard: {
  copySelection: (plan?: unknown) => boolean;
  pasteCopy: () => boolean;
  pasteFromMenu: () => void;
  forgetCopy: () => void;
  copiedHere: () => { label: string; count: number } | null;
};
let clipKeys: { clipKeyIsEditors: (chord: 'copy' | 'paste', target: Control | null, body: unknown) => boolean };
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

  it('says so when Paste is chosen from a menu that was open while the copy went away', async () => {
    setState({ selection: ref(home(), sectionOf('media.gallery')) });
    const paste = items().paste;
    const n = session.state.pages[homeId()].rootIds.length;
    paste.onSelect!();
    expect(lastToast()).toMatchObject({ kind: 'info', text: expect.stringMatching(/Nothing is copied/) });
    expect(session.state.pages[homeId()].rootIds).toHaveLength(n);
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

  it('pastes a copied element inside the component’s root, and selects it as the component’s own', async () => {
    const edit = await editEverywhere();
    setState({ selection: ref(home(), sectionOf('stats.row')) });
    await chooseCopy();
    enter(edit.definitionId);
    // Nothing selected: the component's root takes it.
    const before = childrenOf(edit.tree, edit.root).length;
    expect(items().paste.disabled).toBe(false);
    items().paste.onSelect!();
    await vi.waitFor(() => expect(childrenOf(edit.tree, edit.root)).toHaveLength(before + 1));
    await pending;
    const id = childrenOf(edit.tree, edit.root).at(-1)!;
    expect((edit.tree().nodes[id] as InstanceNode).definitionId).toBe((session.state.pages[homeId()].nodes[sectionOf('stats.row')] as InstanceNode).definitionId);
    await vi.waitFor(() => expect(getState().selection).toEqual(ref(edit.owner, id)));
    // The page it was copied from is as it was.
    expect(session.state.pages[homeId()].rootIds).toContain(sectionOf('stats.row'));
    // One Undo takes the paste back.
    await bridge.project.undo();
    expect(childrenOf(edit.tree, edit.root)).toHaveLength(before);
  });

  it('pastes where ⌘V was pressed, and leaves the selection to an author who has moved on', async () => {
    const edit = await editEverywhere();
    setState({ selection: ref(home(), sectionOf('stats.row')) });
    await chooseCopy();
    enter(edit.definitionId);
    // The root is selected when ⌘V is pressed; by the time the paste lands the author has moved on.
    setState({ selection: ref(edit.owner, edit.root) });
    const selected = getState().selection;
    const before = childrenOf(edit.tree, edit.root).length;
    expect(clipboard.pasteCopy()).toBe(true);
    setState({ selection: null });
    await vi.waitFor(() => expect(childrenOf(edit.tree, edit.root)).toHaveLength(before + 1));
    await pending;
    expect(selected).not.toBeNull();
    expect(getState().selection).toBeNull();
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
});
