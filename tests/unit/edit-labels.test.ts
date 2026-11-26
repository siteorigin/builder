/**
 * History names each manual edit by what was done, to which element, and where (#199): "Duplicate Gallery on Home",
 * "Edit Heading on Home", "Set vertical padding for Gallery on Home". The editor's own actions run against a real
 * project session behind a stand-in for the preload bridge, so the labels checked are the ones History keeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, GraphNode, InstanceNode, OwnerRef, ProjectState, RichText } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';
import { contentLabel, editLabel, fieldLabel, forLabel, partName, placeWords, refTo, styleLabel, subjectWords } from '../../src/renderer/src/lib/edit-label';
import { treeFor } from '../../src/renderer/src/lib/model';

let session: ProjectSession;
const opening = 'opening#labels';
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string } = {}) => session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' }).then(refresh),
    undo: () => session.undo().then(refresh),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

// The editor's store and actions are DOM code, outside this test project's types: loaded by a path the type checker
// does not follow, with just the shapes this test uses.
interface EditorState {
  toasts: unknown[];
  snapshot: ProjectSnapshot | null;
  selection: ElementRef | null;
  layerSet: { owner: OwnerRef; ids: string[]; anchor: string } | null;
  pageId: string | null;
  definitionMode: unknown;
  mode: string;
}
const load = (path: string) => import(/* @vite-ignore */ path);
const actions = (await load('../../src/renderer/src/lib/actions')) as {
  duplicateSelection: () => Promise<void>;
  deleteSelection: () => Promise<void>;
  moveSelection: (dir: -1 | 1) => Promise<void>;
  moveLayers: (dir: -1 | 1) => Promise<void>;
  duplicateLayers: () => Promise<void>;
  commitText: (ref: ElementRef, text: string | RichText) => Promise<'restore' | void>;
};
const { setState } = (await load('../../src/renderer/src/store')) as { setState: (p: Partial<EditorState>) => void };

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-labels-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, createStarterState('business', 'Studio', false));
  setState({ toasts: [], selection: null, layerSet: null, pageId: session.state.site.homePageId, definitionMode: null, mode: 'edit' });
  refresh(null);
});
afterEach(async () => {
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const homeId = () => session.state.site.homePageId;
const home = (): OwnerRef => ({ kind: 'page', id: homeId() });
const roots = () => session.state.pages[homeId()].rootIds;
const sectionOf = (componentId: string) => roots().find((id) => session.state.components[(session.state.pages[homeId()].nodes[id] as InstanceNode).definitionId]?.componentId === componentId)!;
const newest = () => session.historyInfo().entries.at(-1)!.label;
const select = (ref: ElementRef) => setState({ selection: ref, layerSet: null });

/** A text node of a placement's design that shows a text property the placement fills in, as the canvas edits it in place. */
function shownText(st: ProjectState, inst: GraphNode | undefined): GraphNode | undefined {
  if (inst?.kind !== 'instance') return undefined;
  return Object.values(st.components[inst.definitionId]?.tree?.nodes ?? {}).find((n) => n.kind === 'text' && typeof n.text === 'object' && n.text !== null && '$prop' in n.text && typeof inst.props[(n.text as { $prop: string }).$prop] === 'string');
}
/** The first placement on `owner` with such a text, and that text. */
function boundText(st: ProjectState, owner: OwnerRef): ElementRef {
  const tree = treeFor(st, owner)!;
  const instanceId = tree.rootIds.find((id) => shownText(st, tree.nodes[id]));
  expect(instanceId, 'a placement shows text it fills in').toBeDefined();
  return { owner, instancePath: [instanceId!], nodeId: shownText(st, tree.nodes[instanceId!])!.id };
}

describe('the words a History label is made from', () => {
  it('says where an element is: on a page, in the header or footer, in a design or a collection’s layout', () => {
    const st = session.state;
    expect(placeWords(st, home())).toBe('on Home');
    const about = st.site.pageOrder.find((id) => st.pages[id].title === 'About')!;
    expect(placeWords(st, { kind: 'page', id: about })).toBe('on About');
    const untitled = { ...st, pages: { ...st.pages, [about]: { ...st.pages[about], title: '' } } } as ProjectState;
    expect(placeWords(untitled, { kind: 'page', id: about })).toBe('on a page');
    expect(placeWords(st, { kind: 'shell', id: 'header' })).toBe('in Header');
    expect(placeWords(st, { kind: 'shell', id: 'footer' })).toBe('in Footer');
    const def = Object.values(st.components).find((d) => d.componentId === 'media.gallery')!;
    expect(placeWords(st, { kind: 'component', id: def.id })).toBe(`in the ${def.name} design`);
    const withPosts = { ...st, collections: { posts: { settings: { name: 'Posts' } } } } as unknown as ProjectState;
    expect(placeWords(withPosts, { kind: 'template', id: 'posts' })).toBe('in the Posts layout');
  });

  it('names the element, what was done to it, and the style or field it changed', () => {
    const st = session.state;
    const gallery = refTo(home(), sectionOf('media.gallery'));
    expect(subjectWords(st, gallery)).toBe('Gallery on Home');
    expect(editLabel(st, 'Move', gallery, 'up')).toBe('Move Gallery up on Home');
    expect(styleLabel(st, 'paddingBlock', gallery)).toBe('Set vertical padding for Gallery on Home');
    expect(styleLabel(st, 'color', gallery, 'Title')).toBe('Set text color for Title in Gallery on Home');
    // The reset dot sets nothing: it takes the element's own value away.
    expect(styleLabel(st, 'paddingBlock', gallery, undefined, null)).toBe('Reset vertical padding for Gallery on Home');
    expect(forLabel(st, 'Reset styles', gallery)).toBe('Reset styles for Gallery on Home');
    expect(fieldLabel(st, 'Heading', gallery)).toBe('Edit Heading in Gallery on Home');
    expect(contentLabel(st, 'link', gallery)).toBe('Edit link of Gallery on Home');
    expect(contentLabel(st, 'text', gallery)).toBe('Edit Gallery on Home');
    expect(contentLabel(st, 'label', gallery)).toBe('Edit Gallery on Home');
    expect(contentLabel(st, 'ariaLabel', gallery)).toBe('Edit accessible name of Gallery on Home');
    // A layer named by the author goes by that name.
    const named = { ...st, pages: { ...st.pages, [homeId()]: { ...st.pages[homeId()], nodes: { ...st.pages[homeId()].nodes, [gallery.nodeId]: { ...st.pages[homeId()].nodes[gallery.nodeId], name: 'Studio photos' } } } } } as ProjectState;
    expect(editLabel(named, 'Duplicate', gallery)).toBe('Duplicate Studio photos on Home');
  });

  it('names a part of a placement by the part, and the shared header’s own root as the header', () => {
    const st = session.state;
    // A placement on Home whose design has a part of its own besides its root.
    const placed = roots().map((id) => session.state.pages[homeId()].nodes[id] as InstanceNode).find((n) => Object.keys(st.components[n.definitionId]?.parts ?? {}).some((p) => p !== 'root'))!;
    expect(placed, 'a section on Home has a named part').toBeDefined();
    const def = st.components[placed.definitionId];
    const [partId, part] = Object.entries(def.parts).find(([p]) => p !== 'root')!;
    expect(partName(st, home(), placed.id, partId)).toBe(part.label);
    expect(partName(st, home(), placed.id, 'root')).toBeUndefined();
    expect(partName(st, home(), placed.id, undefined)).toBeUndefined();
    expect(forLabel(st, 'Set vertical padding', refTo(home(), placed.id), partName(st, home(), placed.id, partId))).toBe(`Set vertical padding for ${part.label} in ${def.name} on Home`);
    const header: OwnerRef = { kind: 'shell', id: 'header' };
    const named = { ...st, site: { ...st.site, shell: { ...st.site.shell, header: { ...st.site.shell.header, nodes: { ...st.site.shell.header.nodes, [st.site.shell.header.rootIds[0]]: { ...st.site.shell.header.nodes[st.site.shell.header.rootIds[0]], name: 'Header' } } } } } } as ProjectState;
    expect(subjectWords(named, refTo(header, st.site.shell.header.rootIds[0]))).toBe('the shared header');
  });
});

describe('manual edits in History', () => {
  it('duplicate, move and delete a section name it and its page', async () => {
    const gallery = sectionOf('media.gallery');
    select(refTo(home(), gallery));
    await actions.duplicateSelection();
    expect(newest()).toBe('Duplicate Gallery on Home');
    select(refTo(home(), gallery));
    await actions.moveSelection(-1);
    expect(newest()).toBe('Move Gallery up on Home');
    await actions.moveSelection(1);
    expect(newest()).toBe('Move Gallery down on Home');
    select(refTo(home(), gallery));
    await actions.deleteSelection();
    expect(newest()).toBe('Delete Gallery on Home');
  });

  it('names the layers selected together, or how many when there are more than two', async () => {
    const [gallery, testimonials] = [sectionOf('media.gallery'), sectionOf('testimonials.grid')];
    setState({ selection: refTo(home(), testimonials), layerSet: { owner: home(), ids: [gallery, testimonials], anchor: gallery } });
    const order = [...roots()];
    await actions.moveLayers(1);
    expect(newest()).toBe('Move Gallery and Testimonials down on Home');
    expect(roots().indexOf(gallery)).toBe(order.indexOf(gallery) + 1);
    const three = roots().slice(1, 4);
    setState({ selection: refTo(home(), three[0]), layerSet: { owner: home(), ids: three, anchor: three[0] } });
    await actions.duplicateLayers();
    expect(newest()).toBe('Duplicate 3 sections on Home');
  });

  it('text typed on the canvas names the element and where it is: a page, the footer, a design', async () => {
    // A heading of the page's own.
    const made = await bridge.project.apply(
      {
        operations: [
          { type: 'node.insert', newNodeId: 'n_holder', owner: home(), parentId: null, index: 0, componentId: 'layout.section' },
          { type: 'node.insert', newNodeId: 'n_heading', owner: home(), parentId: 'n_holder', slot: 'content', primitive: 'heading', text: 'Welcome' }
        ]
      },
      { label: 'Add heading' }
    );
    expect(made.ok).toBe(true);
    const heading = refTo(home(), 'n_heading');
    await actions.commitText(heading, 'Welcome in');
    expect(newest()).toBe('Edit Heading 2 on Home');
    expect(JSON.stringify(session.state.pages[homeId()].nodes.n_heading)).toContain('Welcome in');

    // Text a placement on the page shows from its content.
    const hero = boundText(session.state, home());
    await actions.commitText(hero, 'Changed on the page');
    expect(newest()).toBe('Edit Eyebrow on Home');

    // Text in the shared footer.
    const inFooter = boundText(session.state, { kind: 'shell', id: 'footer' });
    await actions.commitText(inFooter, 'Changed in the footer');
    expect(newest()).toBe('Edit Site name in Footer');

    // A heading in a component made from that section, edited in its design.
    const created = await bridge.project.apply({ operations: [{ type: 'component.createFromNode', owner: home(), nodeId: 'n_holder', name: 'Welcome band' }] }, { label: 'Create component Welcome band' });
    expect(created.ok).toBe(true);
    const def = Object.values(session.state.components).find((d) => d.name === 'Welcome band')!;
    const inDesign = Object.values(def.tree!.nodes).find((n) => n.kind === 'text')!;
    const ref = refTo({ kind: 'component', id: def.id }, inDesign.id);
    await actions.commitText(ref, 'Welcome, everyone');
    expect(newest()).toBe('Edit Heading 2 in the Welcome band design');
  });
});

describe('editing the footer’s copyright line on the page (#828)', () => {
  it('keeps the line on the year the site is built in while the edit leaves the shown year as it was', async () => {
    const footer = { kind: 'shell', id: 'footer' } as const;
    const instanceId = session.state.site.shell.footer.rootIds[0];
    const ref: ElementRef = { owner: footer, instancePath: [instanceId], nodeId: 'copyright' };
    const copyright = () => (session.state.site.shell.footer.nodes[instanceId] as InstanceNode).props.copyright;
    const year = new Date().getFullYear();
    expect(copyright()).toBe('© {year} Studio. All rights reserved.');
    // The page shows the year: typing after it changes the words and keeps the year current.
    await actions.commitText(ref, `© ${year} Studio. Photos by Ana Lee.`);
    expect(copyright()).toBe('© {year} Studio. Photos by Ana Lee.');
    // Nothing changed but the shown year read back: no edit is made.
    const entries = session.historyInfo().entries.length;
    expect(await actions.commitText(ref, `© ${year} Studio. Photos by Ana Lee.`)).toBe('restore');
    expect(session.historyInfo().entries.length).toBe(entries);
    // Another year typed in its place is the author's fixed year.
    await actions.commitText(ref, `© ${year - 1} Studio.`);
    expect(copyright()).toBe(`© ${year - 1} Studio.`);
  });
});
