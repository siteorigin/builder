import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { LocalWorkspaceState, ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { notePlace, placeOn, placeToKeep, readPlaces, type PagePlaces, type PlaceView } from '../../src/renderer/src/lib/page-place';

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

describe('the place kept for a page', () => {
  it('is the element selected on the page, a shared part shown there included', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = lastSection(s, home);
    expect(componentOf(s, home, cta)).toBe('cta.banner');
    expect(placeToKeep(s, home, ref(page(home), cta))).toEqual(ref(page(home), cta));
    const footer = ref({ kind: 'shell', id: 'footer' }, s.site.shell.footer.rootIds[0]);
    expect(placeToKeep(s, home, footer)).toEqual(footer);
    s.pages[home].showFooter = false;
    expect(placeToKeep(s, home, footer), 'a footer the page hides is not on it').toBeNull();
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

  it('for a list item, is the section holding the list, never the list or another item', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = lastSection(s, home);
    const def = s.components[(s.pages[home].nodes[cta] as InstanceNode).definitionId];
    const inner = def.tree!.rootIds[0];
    const card = ref(page(home), inner, { instancePath: [cta], itemPath: ['item-2'] });
    expect(placeToKeep(s, home, card)).toEqual(ref(page(home), cta));
  });

  it('is found where it moved on its page, and not when it was removed or moved to another page', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    const cta = lastSection(s, home);
    const places: PagePlaces = { [home]: ref(page(home), cta) };
    // Moved to the top of the page.
    s.pages[home].rootIds = [cta, ...s.pages[home].rootIds.filter((id) => id !== cta)];
    expect(placeOn(s, places, home)).toEqual(ref(page(home), cta));
    // Moved to About: nothing on Home is selected in its place.
    const moved = structuredClone(s);
    moved.pages[about].nodes[cta] = moved.pages[home].nodes[cta];
    moved.pages[about].rootIds.push(cta);
    delete moved.pages[home].nodes[cta];
    moved.pages[home].rootIds = moved.pages[home].rootIds.filter((id) => id !== cta);
    expect(placeOn(moved, places, home)).toBeNull();
    // Removed.
    const removed = structuredClone(s);
    delete removed.pages[home].nodes[cta];
    removed.pages[home].rootIds = removed.pages[home].rootIds.filter((id) => id !== cta);
    expect(placeOn(removed, places, home)).toBeNull();
    // A page without a place opens at the page itself.
    expect(placeOn(s, places, about)).toBeNull();
  });
});

describe('noting places as the author works', () => {
  const view = (s: ProjectState, p: Partial<PlaceView>): PlaceView => ({ snapshot: { workspaceKey: 'w#1', state: s }, pageId: homeOf(s), selection: null, mode: 'edit', definitionMode: null, pagePlaces: {}, ...p });

  it('remembers a selection on the page shown and forgets it when the author lets it go there', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = ref(page(home), lastSection(s, home));
    const picked = view(s, { selection: cta });
    const places = notePlace(view(s, {}), picked);
    expect(places).toEqual({ [home]: cta });
    expect(notePlace(picked, { ...picked, pagePlaces: places }), 'the same selection again changes nothing').toBe(places);
    expect(notePlace({ ...picked, pagePlaces: places }, view(s, { pagePlaces: places }))).toEqual({});
  });

  it('keeps it when another page opens, Preview is entered or a component is edited everywhere', () => {
    const s = starter();
    const home = homeOf(s);
    const cta = ref(page(home), lastSection(s, home));
    const places = { [home]: cta };
    const at = view(s, { selection: cta, pagePlaces: places });
    expect(notePlace(at, view(s, { pageId: aboutOf(s), pagePlaces: places }))).toBe(places);
    expect(notePlace(at, view(s, { mode: 'preview', pagePlaces: places }))).toBe(places);
    expect(notePlace(at, view(s, { definitionMode: { definitionId: 'd', returnPageId: home }, pagePlaces: places }))).toBe(places);
    // A selection made while editing everywhere is the component's, not the page's.
    const dm = view(s, { definitionMode: { definitionId: 'd', returnPageId: home }, pagePlaces: places });
    expect(notePlace(dm, { ...dm, selection: ref(page(home), s.pages[home].rootIds[0]) })).toBe(places);
    // Another opening of the project brings its own places.
    expect(notePlace(view(s, {}), { ...view(s, { selection: cta }), snapshot: { workspaceKey: 'w#2', state: s } })).toEqual({});
  });

  it('notes an element shown on another page under that page, never under the page shown', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    // A selection of Home's while About is shown (a moment of a page change) is not About's place.
    const places = notePlace(view(s, { pageId: about }), view(s, { pageId: about, selection: ref(page(home), lastSection(s, home)) }));
    expect(places).toEqual({});
  });
});

describe('places read from the workspace file', () => {
  it('keeps the valid ones and drops anything else', () => {
    const s = starter();
    const home = homeOf(s);
    const about = aboutOf(s);
    const cta = ref(page(home), lastSection(s, home));
    const saved = {
      [home]: cta,
      [about]: ref(page(about), 'n_gone'),
      gone: ref(page('gone'), 'n_x'),
      [s.site.pageOrder[2]]: { owner: { kind: 'component', id: 'x' }, instancePath: [], nodeId: 'n' },
      toString: 'not a place'
    };
    expect(readPlaces(s, JSON.parse(JSON.stringify(saved)))).toEqual({ [home]: cta });
    expect(readPlaces(s, [cta])).toEqual({});
    expect(readPlaces(s, 'x')).toEqual({});
    expect(readPlaces(s, undefined)).toEqual({});
    expect(readPlaces(s, { [home]: { ...cta, itemPath: ['a'] } }), 'a list item is never kept').toEqual({});
    expect(readPlaces(s, { [home]: { ...cta, instancePath: 'no' } })).toEqual({});
  });
});

// The editor's store and actions, behind a stand-in for the preload bridge: the transitions the issue reports.
const saved: Array<{ state: LocalWorkspaceState; key: string }> = [];
vi.stubGlobal('window', { builder: { project: { saveLocalState: async (state: LocalWorkspaceState, key: string) => void saved.push({ state, key }) } }, platform: 'darwin' });

interface EditorState {
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: unknown;
  pageId: string | null;
  mode: 'edit' | 'preview';
  definitionMode: unknown;
  pagePlaces: PagePlaces;
  previewReturn: unknown;
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
};
store.useStore.subscribe(store.persistPlaces);

describe('the editor resumes where the author was', () => {
  let s: ProjectState;
  let home: string;
  let about: string;
  let revision: number;
  const open = (state: ProjectState) => store.setState({ snapshot: { state, revision: ++revision, workspaceKey: 'opening#1' } as unknown as ProjectSnapshot });
  beforeEach(() => {
    s = starter();
    home = homeOf(s);
    about = aboutOf(s);
    revision = 0;
    store.setState({ snapshot: null, pagePlaces: {}, previewReturn: null, selection: null, layerSet: null, mode: 'edit', definitionMode: null, pageId: home });
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
    // Saved with this opening, as local workspace state.
    expect(saved.filter((x) => x.state.pagePlaces).at(-1)).toEqual({ state: { pagePlaces: { [home]: cta, [about]: intro } }, key: 'opening#1' });
  });

  it('selects nothing in place of a section that has been removed meanwhile', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.selectPage(about);
    const next = structuredClone(s);
    delete next.pages[home].nodes[cta.nodeId];
    next.pages[home].rootIds = next.pages[home].rootIds.filter((id) => id !== cta.nodeId);
    open(next);
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
  });

  it('choosing the page itself, or its settings, opens the page and forgets its place', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.selectPage(home);
    expect(store.getState().selection, 'the page shown, chosen again, is the page itself').toBeNull();
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
    store.setState({ selection: cta });
    actions.selectPage(about);
    actions.selectPage(home, null);
    expect(store.getState().selection, 'page settings').toBeNull();
    actions.selectPage(about);
    actions.selectPage(home);
    expect(store.getState().selection).toBeNull();
  });

  it('Preview → Edit selects the element again, without scrolling to it, when the visitor stayed', () => {
    const cta = ref(page(home), lastSection(s, home));
    store.setState({ selection: cta });
    actions.setMode('preview');
    expect(store.getState().selection).toBeNull();
    actions.setMode('preview');
    expect(store.getState().previewReturn, 'choosing Preview again keeps what Edit returns to').toMatchObject({ pageId: home, ref: cta });
    actions.setMode('edit');
    expect(store.getState().selection).toEqual(cta);
    expect(actions.takeUnscrolled(cta), 'left where the visitor scrolled').toBe(true);
    expect(actions.takeUnscrolled(cta), 'only that once').toBe(false);
    expect(store.getState().pagePlaces).toEqual({ [home]: cta });
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
    const next = structuredClone(s);
    delete next.pages[home].nodes[cta.nodeId];
    next.pages[home].rootIds = next.pages[home].rootIds.filter((id) => id !== cta.nodeId);
    open(next);
    actions.setMode('edit');
    expect(store.getState().selection).toBeNull();
  });

  it('a page opened in Preview selects nothing, and keeps its place for Edit', () => {
    const intro = ref(page(about), s.pages[about].rootIds[0]);
    actions.selectPage(about);
    store.setState({ selection: intro });
    actions.selectPage(home);
    actions.setMode('preview');
    actions.selectPage(about);
    expect(store.getState().selection).toBeNull();
    actions.setMode('edit');
    expect(store.getState().selection, 'the visitor went there: the page shows itself').toBeNull();
    actions.selectPage(home);
    actions.selectPage(about);
    expect(store.getState().selection).toEqual(intro);
  });
});
