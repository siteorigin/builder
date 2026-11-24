import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { ApplyResult } from '@shared/ops';
import type { LocalWorkspaceState, ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { notePlace, placeOn, placeToKeep, readPlaces, selectionBack, type PagePlaces, type PlaceView } from '../../src/renderer/src/lib/page-place';

// Resuming at the element last selected on a page (#224): after switching pages, after Preview, and on reopening the
// project. The places are local workspace state, never part of the site or its Undo history.

const starter = () => structuredClone(createStarterState('business', 'Studio', false)) as ProjectState;
const homeOf = (s: ProjectState) => s.site.homePageId;
const aboutOf = (s: ProjectState) => s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
const page = (id: string): OwnerRef => ({ kind: 'page', id });
const ref = (owner: OwnerRef, nodeId: string, more: Partial<ElementRef> = {}): ElementRef => ({ owner, instancePath: [], nodeId, ...more });
/** The last section of a page: on Home, the closing call to action. */
const lastSection = (s: ProjectState, pageId: string) => s.pages[pageId].rootIds.at(-1)!;
const componentOf = (s: ProjectState, pageId: string, nodeId: string) => s.components[(s.pages[pageId].nodes[nodeId] as InstanceNode).definitionId]?.componentId;
const sectionNamed = (s: ProjectState, pageId: string, componentId: string) => s.pages[pageId].rootIds.find((id) => componentOf(s, pageId, id) === componentId)!;
const without = (s: ProjectState, pageId: string, nodeId: string) => {
  const next = structuredClone(s);
  delete next.pages[pageId].nodes[nodeId];
  next.pages[pageId].rootIds = next.pages[pageId].rootIds.filter((id) => id !== nodeId);
  return next;
};
/** Home's Testimonials, nested in a Section at the top of the page, and the name on its second quote. */
function nestedQuote() {
  const base = starter();
  const home = homeOf(base);
  const quotes = sectionNamed(base, home, 'testimonials.grid');
  const s = applyOperations(base, [
    { type: 'node.insert', newNodeId: 'n_holder', owner: page(home), parentId: null, index: 0, componentId: 'layout.section' },
    { type: 'node.move', owner: page(home), nodeId: quotes, parentId: 'n_holder', slot: 'content', index: 0 }
  ]).state;
  const items = (s.pages[home].nodes[quotes] as InstanceNode).props.items as Array<{ id: string }>;
  return { s, home, quotes, name: ref(page(home), 'name', { instancePath: [quotes], itemPath: [items[1].id] }) };
}

describe('the place kept for a page', () => {
  it('is the element selected on the page, a shared part shown there included', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = lastSection(s, home);
    expect(componentOf(s, home, cta)).toBe('cta.banner');
    expect(placeToKeep(s, home, ref(page(home), cta))).toEqual(ref(page(home), cta));
    const header = ref({ kind: 'shell', id: 'header' }, s.site.shell.header.rootIds[0]);
    const footer = ref({ kind: 'shell', id: 'footer' }, s.site.shell.footer.rootIds[0]);
    expect(placeToKeep(s, home, header)).toEqual(header);
    expect(placeToKeep(s, home, footer)).toEqual(footer);
    s.pages[home].showFooter = false;
    expect(placeToKeep(s, home, footer), 'a footer the page hides is not on it').toBeNull();
    expect(placeToKeep(s, home, header), 'the header it still shows is').toEqual(header);
    s.pages[home].showHeader = false;
    expect(placeToKeep(s, home, header)).toBeNull();
  });

  it('is never an element of another page, a component edited everywhere, or one that is not there', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    expect(placeToKeep(s, about, ref(page(home), lastSection(s, home)))).toBeNull();
    const def = Object.keys(s.components)[0];
    expect(placeToKeep(s, home, ref({ kind: 'component', id: def }, s.components[def].tree?.rootIds[0] ?? 'x'))).toBeNull();
    expect(placeToKeep(s, home, ref(page(home), 'n_gone'))).toBeNull();
  });

  it('for a list item, is the section at the top of the page holding it, never the list or another item', () => {
    const { s, home, name } = nestedQuote();
    expect(s.pages[home].rootIds[0]).toBe('n_holder');
    expect(placeToKeep(s, home, name)).toEqual(ref(page(home), 'n_holder'));
  });

  it('is found where it moved on its page, and not when it was removed or moved to another page', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    const cta = lastSection(s, home);
    const places: PagePlaces = { [home]: ref(page(home), cta) };
    // Moved up to second place on the page.
    const [first, ...rest] = s.pages[home].rootIds.filter((id) => id !== cta);
    s.pages[home].rootIds = [first, cta, ...rest];
    expect(placeOn(s, places, home)).toEqual(ref(page(home), cta));
    // Moved to About: nothing on Home is selected in its place.
    const moved = without(s, home, cta);
    moved.pages[about].nodes[cta] = s.pages[home].nodes[cta];
    moved.pages[about].rootIds.push(cta);
    expect(placeOn(moved, places, home)).toBeNull();
    expect(placeOn(without(s, home, cta), places, home), 'removed').toBeNull();
    // A page without a place opens at the page itself.
    expect(placeOn(s, places, about)).toBeNull();
  });
});

describe('what Edit selects again after Preview', () => {
  it('is the element itself while it is there; after a change, a list item gives way to its section', () => {
    const { s, home, name } = nestedQuote();
    expect(selectionBack(s, home, name, true)).toEqual(name);
    expect(selectionBack(s, home, name, false)).toEqual(ref(page(home), 'n_holder'));
    const cta = ref(page(home), lastSection(s, home));
    expect(selectionBack(s, home, cta, false), 'an element still on the page after a change').toEqual(cta);
    expect(selectionBack(without(s, home, cta.nodeId), home, cta, true), 'checked even when nothing changed since').toBeNull();
    const def = Object.keys(s.components)[0];
    const own = ref({ kind: 'component', id: def }, s.components[def].tree!.rootIds[0]);
    expect(selectionBack(s, home, own, false), 'a component edited everywhere').toEqual(own);
    expect(selectionBack(s, home, { ...own, nodeId: 'n_gone' }, true)).toBeNull();
    // An item of the component's list can only be told apart while nothing has changed.
    const item = { ...own, itemPath: ['i_1'] };
    expect(selectionBack(s, home, item, true)).toEqual(item);
    expect(selectionBack(s, home, item, false)).toBeNull();
  });
});

describe('noting places as the author works', () => {
  const view = (s: ProjectState, p: Partial<PlaceView>): PlaceView => ({ snapshot: { workspaceKey: 'w#1', state: s }, pageId: homeOf(s), selection: null, mode: 'edit', definitionMode: null, pagePlaces: {}, ...p });

  it('remembers each selection on the page shown and forgets it when the author lets it go there', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = ref(page(home), lastSection(s, home));
    const intro = ref(page(home), s.pages[home].rootIds[0]);
    const picked = view(s, { selection: cta });
    const places = notePlace(view(s, {}), picked);
    expect(places).toEqual({ [home]: cta });
    expect(notePlace(picked, { ...picked, selection: { ...cta }, pagePlaces: places }), 'the same element picked again changes nothing').toBe(places);
    const next = notePlace({ ...picked, pagePlaces: places }, view(s, { selection: intro, pagePlaces: places }));
    expect(next, 'a later pick on the page takes its place').toEqual({ [home]: intro });
    expect(notePlace(view(s, { selection: intro, pagePlaces: next }), view(s, { pagePlaces: next }))).toEqual({});
  });

  it('keeps it when another page opens, Preview is entered or a component is edited everywhere', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = ref(page(home), lastSection(s, home));
    const places = { [home]: cta };
    const at = view(s, { selection: cta, pagePlaces: places });
    const editing = { definitionId: 'd', returnPageId: home };
    expect(notePlace(at, view(s, { pageId: aboutOf(s), pagePlaces: places }))).toBe(places);
    expect(notePlace(at, view(s, { mode: 'preview', pagePlaces: places }))).toBe(places);
    expect(notePlace(at, view(s, { definitionMode: editing, pagePlaces: places }))).toBe(places);
    // A selection made while editing everywhere is the component's, not the page's.
    const dm = view(s, { definitionMode: editing, selection: cta, pagePlaces: places });
    expect(notePlace(dm, { ...dm, selection: ref(page(home), s.pages[home].rootIds[0]) })).toBe(places);
    // Finishing it with nothing selected is not letting the page's place go.
    expect(notePlace(dm, view(s, { pagePlaces: places }))).toBe(places);
    // Another opening of the project brings its own places.
    expect(notePlace(view(s, {}), { ...view(s, { selection: cta }), snapshot: { workspaceKey: 'w#2', state: s } })).toEqual({});
  });

  it('notes an element picked as editing everywhere ends (a change shown from the chat)', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = ref(page(home), lastSection(s, home));
    const dm = view(s, { definitionMode: { definitionId: 'd', returnPageId: home } });
    expect(notePlace(dm, view(s, { selection: cta }))).toEqual({ [home]: cta });
  });

  it('never notes a selection that is not on the page shown', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    // A selection of Home's while About is shown (a moment of a page change) is the place of neither.
    const places = notePlace(view(s, { pageId: about }), view(s, { pageId: about, selection: ref(page(home), lastSection(s, home)) }));
    expect(places).toEqual({});
  });

  it('never notes another page shown under the same selection (an Undo took the page away)', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    const intro = ref(page(home), s.pages[home].rootIds[0]);
    const footer = ref({ kind: 'shell', id: 'footer' }, s.site.shell.footer.rootIds[0]);
    const places = { [home]: intro, [about]: footer };
    const onAbout = view(s, { pageId: about, selection: footer, pagePlaces: places });
    expect(notePlace(onAbout, { ...onAbout, pageId: home })).toBe(places);
  });
});

describe('places read from the workspace file', () => {
  it('keeps the valid ones and drops anything else', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    const [, , third] = s.site.pageOrder;
    const cta = ref(page(home), lastSection(s, home));
    const quotes = sectionNamed(s, home, 'testimonials.grid');
    const saved = {
      [home]: cta,
      [about]: ref(page(about), 'n_gone'),
      gone: ref(page('gone'), 'n_x'),
      [third]: { owner: { kind: 'component', id: 'x' }, instancePath: [], nodeId: 'n' },
      toString: 'not a place'
    };
    expect(readPlaces(s, JSON.parse(JSON.stringify(saved)))).toEqual({ [home]: cta });
    expect(readPlaces(s, [cta])).toEqual({});
    expect(readPlaces(s, 'x')).toEqual({});
    expect(readPlaces(s, undefined)).toEqual({});
    expect(readPlaces(s, { [home]: { ...cta, itemPath: ['a'] } }), 'a list item is never kept').toEqual({});
    expect(readPlaces(s, { [home]: { ...cta, instancePath: 'no' } })).toEqual({});
    expect(readPlaces(s, { [home]: ref(page(home), 'quote', { instancePath: [quotes], partId: 'no-such-part' }) }), 'a part the component no longer has').toEqual({});
  });
});

// The editor's store and actions, behind a stand-in for the preload bridge: the transitions the issue reports.
const saved: Array<{ state: LocalWorkspaceState; key: string }> = [];
let applying: ((r: ApplyResult) => void) | null = null;
vi.stubGlobal('window', {
  builder: {
    project: {
      saveLocalState: async (state: LocalWorkspaceState, key: string) => void saved.push({ state, key }),
      // A change the test answers when it chooses.
      apply: () => new Promise<ApplyResult>((r) => (applying = r))
    }
  },
  platform: 'darwin'
});

interface EditorState {
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: unknown;
  pageId: string | null;
  mode: 'edit' | 'preview';
  definitionMode: { definitionId: string; returnPageId: string } | null;
  pagePlaces: PagePlaces;
  previewReturn: unknown;
  toasts: unknown[];
}
const load = (path: string) => import(/* @vite-ignore */ path);
const store = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  useStore: { subscribe: (l: (s: EditorState, prev: EditorState) => void) => () => void };
  persistPlaces: (s: EditorState, prev: EditorState) => void;
};
const actions = (await load('../../src/renderer/src/lib/actions')) as {
  selectPage: (pageId: string, target?: ElementRef | null) => void;
  setMode: (mode: 'edit' | 'preview') => void;
  takeUnscrolled: (ref: ElementRef | null) => boolean;
  deleteSelection: () => Promise<void>;
};
store.useStore.subscribe(store.persistPlaces);

describe('the editor resumes where the author was', () => {
  let s: ProjectState;
  let home: string;
  let about: string;
  let revision: number;
  const open = (state: ProjectState) => store.setState({ snapshot: { state, revision: ++revision, workspaceKey: 'opening#1' } as unknown as ProjectSnapshot });
  const placesSaved = () => saved.filter((x) => x.state.pagePlaces).at(-1);
  beforeEach(() => {
    s = starter();
    home = homeOf(s);
    about = aboutOf(s);
    revision = 0;
    store.setState({ snapshot: null, pagePlaces: {}, previewReturn: null, selection: null, layerSet: null, mode: 'edit', definitionMode: null, pageId: home, toasts: [] });
    open(s);
    saved.length = 0;
  });

  it('Home → About → Home selects the last section picked on Home again', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta, layerSet: { owner: page(home), ids: [cta.nodeId], anchor: cta.nodeId } });
    actions.selectPage(about);
    expect(store.getState().selection, 'About has no place yet').toBeNull();
    const intro = ref(page(about), s.pages[about].rootIds[0]);
    store.setState({ selection: intro });
    actions.selectPage(home);
    expect(store.getState().pageId).toBe(home);
    expect(store.getState().selection).toEqual(cta);
    expect(store.getState().layerSet).toBeNull();
    actions.selectPage(about);
    expect(store.getState().selection).toEqual(intro);
    // Saved with this opening, as local workspace state, with the page being worked on.
    expect(placesSaved()).toEqual({ state: { pagePlaces: { [home]: cta, [about]: intro }, pageId: about }, key: 'opening#1' });
  });

  it('selects nothing in place of a section that has been removed meanwhile', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.selectPage(about);
    open(without(s, home, cta.nodeId));
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
  });

  it('choosing the page itself, or its settings, opens the page and forgets its place', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.selectPage(about);
    // About shows; its settings are opened for Home from the page list.
    actions.selectPage(home, null);
    expect(store.getState().selection, 'page settings').toBeNull();
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
    // The page shown, chosen again while it shows its place, is the page itself.
    store.setState({ selection: cta });
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection).toEqual(cta);
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
  });

  it('Preview → Edit selects the element again, without scrolling to it, when the visitor stayed', () => {
    const cta = ref(page(home), lastSection(s, home));
    const intro = ref(page(home), s.pages[home].rootIds[0]);
    store.setState({ selection: cta });
    actions.setMode('preview');
    expect(store.getState().selection).toBeNull();
    actions.setMode('preview');
    expect(store.getState().previewReturn, 'choosing Preview again keeps what Edit returns to').toMatchObject({ pageId: home, ref: cta });
    actions.setMode('edit');
    expect(store.getState().selection).toEqual(cta);
    expect(actions.takeUnscrolled(intro), 'another selection is scrolled to').toBe(false);
    actions.setMode('preview');
    actions.setMode('edit');
    expect(actions.takeUnscrolled(cta), 'left where the visitor scrolled').toBe(true);
    expect(actions.takeUnscrolled(cta), 'only that once').toBe(false);
    expect(store.getState().pagePlaces).toEqual({ [home]: cta });
  });

  it('Preview → Edit after a change elsewhere still selects an element that is there', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.setMode('preview');
    const next = structuredClone(s);
    next.pages[home].title = 'Welcome';
    open(next);
    actions.setMode('edit');
    expect(store.getState().selection).toEqual(cta);
  });

  it('Preview → Edit selects nothing after the visitor moved on, or when the element has gone', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.setMode('preview');
    // The canvas lets the return go when the frame reports another entry (a link, a section jump, Back).
    store.setState({ previewReturn: null });
    actions.setMode('edit');
    expect(store.getState().selection).toBeNull();
    expect(store.getState().pagePlaces, 'the page keeps its place for a later return').toEqual({ [home]: cta });

    store.setState({ selection: cta });
    actions.setMode('preview');
    // The visitor followed a link to About.
    store.setState({ pageId: about, selection: null });
    actions.setMode('edit');
    expect(store.getState().selection).toBeNull();
    store.setState({ pageId: home });

    store.setState({ selection: cta });
    actions.setMode('preview');
    open(without(s, home, cta.nodeId));
    actions.setMode('edit');
    expect(store.getState().selection).toBeNull();
  });

  it('a choice made while previewing wins over what Preview was entered with', () => {
    const cta = ref(page(home), lastSection(s, home));
    const intro = ref(page(home), s.pages[home].rootIds[0]);
    store.setState({ selection: cta });
    actions.setMode('preview');
    // Picked in Layers while previewing.
    store.setState({ selection: intro });
    actions.setMode('edit');
    expect(store.getState().selection).toEqual(intro);
    // Preview, a pick in Layers, Preview again: the pick lets go on the page, and Edit returns to it.
    actions.setMode('preview');
    store.setState({ selection: cta });
    actions.setMode('preview');
    expect(store.getState().selection).toBeNull();
    actions.setMode('edit');
    expect(store.getState().selection).toEqual(cta);
    // Page settings while previewing: Edit shows the page itself.
    actions.setMode('preview');
    actions.selectPage(home, null);
    actions.setMode('edit');
    expect(store.getState().selection).toBeNull();
  });

  it('a pick made while previewing becomes the page\'s place once Edit keeps it', () => {
    const cta = ref(page(home), lastSection(s, home));
    const intro = ref(page(home), s.pages[home].rootIds[0]);
    store.setState({ selection: cta });
    actions.setMode('preview');
    store.setState({ selection: intro });
    actions.setMode('edit');
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection).toEqual(intro);
  });

  it('Edit after a visitor\'s link saves the page it opened as the one to reopen at', () => {
    actions.setMode('preview');
    store.setState({ pageId: about, selection: null });
    saved.length = 0;
    actions.setMode('edit');
    expect(saved).toContainEqual({ state: { pageId: about }, key: 'opening#1' });
  });

  it('Preview → Edit never selects a component after editing it everywhere ended meanwhile', () => {
    const def = Object.keys(s.components).find((id) => s.components[id].tree?.rootIds.length)!;
    const own = ref({ kind: 'component', id: def }, s.components[def].tree!.rootIds[0]);
    store.setState({ definitionMode: { definitionId: def, returnPageId: home }, selection: own });
    actions.setMode('preview');
    store.setState({ definitionMode: null, pageId: home, selection: null });
    actions.setMode('edit');
    expect(store.getState().selection).toBeNull();
    // Still editing it everywhere, it is selected again.
    store.setState({ definitionMode: { definitionId: def, returnPageId: home }, selection: own });
    actions.setMode('preview');
    actions.setMode('edit');
    expect(store.getState().selection).toEqual(own);
  });

  it('a page opened in Preview selects nothing, and keeps its place for Edit', () => {
    const cta = ref(page(home), lastSection(s, home));
    const intro = ref(page(about), s.pages[about].rootIds[0]);
    actions.selectPage(about);
    store.setState({ selection: intro });
    actions.selectPage(home);
    store.setState({ selection: cta });
    actions.setMode('preview');
    actions.selectPage(about);
    expect(store.getState().selection).toBeNull();
    actions.selectPage(home);
    actions.setMode('edit');
    expect(store.getState().selection, 'pages were picked while previewing: Home shows itself').toBeNull();
    actions.selectPage(about);
    expect(store.getState().selection).toEqual(intro);
    actions.selectPage(home);
    expect(store.getState().selection).toEqual(cta);
  });

  it('a delete that lands after another page opened leaves that page and its place alone', async () => {
    const intro = ref(page(about), s.pages[about].rootIds[0]);
    actions.selectPage(about);
    store.setState({ selection: intro });
    actions.selectPage(home);
    store.setState({ selection: ref(page(home), lastSection(s, home)) });
    const deleting = actions.deleteSelection();
    actions.selectPage(about);
    expect(store.getState().selection).toEqual(intro);
    applying!({ ok: true, revision: 9 } as ApplyResult);
    await deleting;
    expect(store.getState().selection).toEqual(intro);
    expect(store.getState().pagePlaces[about]).toEqual(intro);
  });

  it('a delete that lands after its page was opened again lets go of the section deleted', async () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: { ...cta } });
    const deleting = actions.deleteSelection();
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection, 'Home resumes at its place, a copy of the selection').toEqual(cta);
    applying!({ ok: true, revision: 9 } as ApplyResult);
    await deleting;
    expect(store.getState().selection).toBeNull();
    expect(store.getState().pagePlaces[home]).toBeUndefined();
  });
});
