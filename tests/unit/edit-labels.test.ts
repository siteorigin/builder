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
import { P } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { ProjectSession } from '../../src/main/project/session';
import { contentLabel, editLabel, fieldLabel, forLabel, partName, placeWords, refTo, styleLabel, subjectWords } from '../../src/renderer/src/lib/edit-label';
import { codeTextTarget, treeFor, type CodeTextTarget } from '../../src/renderer/src/lib/model';
import { projectDesign } from './fixtures/packs';

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
  showsInlineText: (snapshot: ProjectSnapshot, ref: ElementRef, shown: string) => boolean;
  commitCodeText: (t: CodeTextTarget, text: string | RichText) => Promise<'restore' | void>;
  showsCodeText: (snapshot: ProjectSnapshot, t: CodeTextTarget, shown: string) => boolean;
};
const { setState } = (await load('../../src/renderer/src/store')) as { setState: (p: Partial<EditorState>) => void };

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

/**
 * Foundation's sections are code components, whose marked text the canvas types over through the code path. What
 * the canvas does with a managed design's text is shown on designs of the project's own: a band whose eyebrow a
 * placement fills in, and a footer whose copyright line says `{year}`.
 */
const BAND_ID = 'foundation.test.band';
const FOOTER_ID = 'foundation.test.footer';
function withDesigns(state: ProjectState): ProjectState {
  projectDesign(state, {
    componentId: 'test.band',
    name: 'Band',
    properties: { eyebrow: P.str('Eyebrow', 'Welcome') },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] } },
    build: (b) => b.el('root', 'section', { name: 'Section' }, [b.text('eyebrow', 'p', { $prop: 'eyebrow' }, { name: 'Eyebrow' })])
  });
  projectDesign(state, {
    componentId: 'test.footer',
    name: 'Footer',
    category: 'shell',
    properties: { siteName: P.str('Site name', 'Studio'), copyright: P.str('Copyright', '© {year} Studio. All rights reserved.') },
    parts: { root: { nodeId: 'root', label: 'Footer', styleControls: [] } },
    build: (b) =>
      b.el('root', 'footer', { name: 'Footer' }, [b.text('site-name', 'p', { $prop: 'siteName' }, { name: 'Site name' }), b.text('copyright', 'p', { $prop: 'copyright' }, { name: 'Copyright' })])
  });
  return state;
}

const dirs: string[] = [];
async function open(start: ProjectState) {
  const dir = mkdtempSync(join(tmpdir(), 'so-labels-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, start);
  setState({ toasts: [], selection: null, layerSet: null, pageId: session.state.site.homePageId, definitionMode: null, mode: 'edit' });
  refresh(null);
}
beforeEach(() => open(withDesigns(createStarterState('business', 'Studio', false))));

/** The starter with the project's own footer design in the shared footer, in place of Foundation's. */
async function openWithDesignFooter() {
  await session.close();
  const start = withDesigns(createStarterState('business', 'Studio', false));
  const footer = makeInstance(start.components[FOOTER_ID]);
  start.site.shell.footer = { rootIds: [footer.id], nodes: { [footer.id]: footer } };
  await open(start);
}

/** The marked text `bind` of the code placement `node` on `owner`, as the canvas types over it. */
const codeText = (owner: OwnerRef, node: string, bind: string) => codeTextTarget(session.state, { ctx: `${owner.kind}:${owner.id}`, node, bind });
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

    // Text a placement of a design on the page shows from its content.
    const placed = await bridge.project.apply({ operations: [{ type: 'node.insert', newNodeId: 'n_band', owner: home(), parentId: null, index: 0, definitionId: BAND_ID }] }, { label: 'Add Band' });
    expect(placed.ok).toBe(true);
    const band = boundText(session.state, home());
    expect(band.instancePath).toEqual(['n_band']);
    await actions.commitText(band, 'Changed on the page');
    expect(newest()).toBe('Edit Eyebrow on Home');

    // Text a Foundation section on the page shows, which its code marks: named as the inspector names the field.
    const heroId = roots().find((id) => codeText(home(), id, 'heading'))!;
    const hero = codeText(home(), heroId, 'heading')!;
    const heroName = session.state.components[(session.state.pages[homeId()].nodes[heroId] as InstanceNode).definitionId].name;
    await actions.commitCodeText(hero, 'Changed on the page');
    expect(newest()).toBe(`Edit Heading in ${heroName} on Home`);

    // Text in Foundation's shared footer.
    const footer: OwnerRef = { kind: 'shell', id: 'footer' };
    const inFooter = codeText(footer, session.state.site.shell.footer.rootIds[0], 'siteName')!;
    expect(inFooter).toBeTruthy();
    await actions.commitCodeText(inFooter, 'Changed in the footer');
    expect(newest()).toBe('Edit Site name in the shared footer');

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
    await openWithDesignFooter();
    const footer = { kind: 'shell', id: 'footer' } as const;
    const instanceId = session.state.site.shell.footer.rootIds[0];
    const ref: ElementRef = { owner: footer, instancePath: [instanceId], nodeId: 'copyright' };
    const copyright = () => (session.state.site.shell.footer.nodes[instanceId] as InstanceNode).props.copyright;
    const year = new Date().getFullYear();
    expect(copyright()).toBe('© {year} Studio. All rights reserved.');
    // The page shows the line with the year, which is the text the edit began from, not something else.
    const now = () => ({ state: session.state, revision: session.revision }) as unknown as ProjectSnapshot;
    expect(actions.showsInlineText(now(), ref, `© ${year} Studio. All rights reserved.`)).toBe(true);
    expect(actions.showsInlineText(now(), ref, '© {year} Studio. All rights reserved.')).toBe(false);
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

  // Release gap: showsCodeText and commitCodeText (src/renderer/src/lib/actions.ts) skip the footer's copyright year, so typing over it saves a fixed year.
  it.fails('keeps Foundation’s footer line on the year the site is built in while the edit leaves the shown year as it was', async () => {
    // The shared footer as the app ships it: Foundation's code footer, whose copyright line the code marks.
    const footer = { kind: 'shell', id: 'footer' } as const;
    const instanceId = session.state.site.shell.footer.rootIds[0];
    const target = codeText(footer, instanceId, 'copyright')!;
    expect(target).toBeTruthy();
    const copyright = () => (session.state.site.shell.footer.nodes[instanceId] as InstanceNode).props.copyright ?? session.state.components[(session.state.site.shell.footer.nodes[instanceId] as InstanceNode).definitionId].properties.copyright.default;
    const year = new Date().getFullYear();
    expect(copyright()).toBe('© {year} Studio. All rights reserved.');
    // The page shows the line with the year, which is the text the edit began from, not something else.
    const now = () => ({ state: session.state, revision: session.revision }) as unknown as ProjectSnapshot;
    expect(actions.showsCodeText(now(), target, `© ${year} Studio. All rights reserved.`)).toBe(true);
    expect(actions.showsCodeText(now(), target, '© {year} Studio. All rights reserved.')).toBe(false);
    // The page shows the year: typing after it changes the words and keeps the year current.
    await actions.commitCodeText(target, `© ${year} Studio. Photos by Ana Lee.`);
    expect(copyright()).toBe('© {year} Studio. Photos by Ana Lee.');
    // Nothing changed but the shown year read back: no edit is made.
    const entries = session.historyInfo().entries.length;
    expect(await actions.commitCodeText(target, `© ${year} Studio. Photos by Ana Lee.`)).toBe('restore');
    expect(session.historyInfo().entries.length).toBe(entries);
    // Another year typed in its place is the author's fixed year.
    await actions.commitCodeText(target, `© ${year - 1} Studio.`);
    expect(copyright()).toBe(`© ${year - 1} Studio.`);
  });

  it('leaves other text that happens to start “© {year}” as the author typed it', async () => {
    const made = await bridge.project.apply({ operations: [{ type: 'node.insert', newNodeId: 'n_note', owner: home(), parentId: null, index: 0, primitive: 'heading', text: '© {year} Studio.' }] }, { label: 'Add heading' });
    expect(made.ok).toBe(true);
    const ref = refTo(home(), 'n_note');
    const now = () => ({ state: session.state, revision: session.revision }) as unknown as ProjectSnapshot;
    expect(actions.showsInlineText(now(), ref, `© ${new Date().getFullYear()} Studio.`)).toBe(false);
    await actions.commitText(ref, `© ${new Date().getFullYear()} Studio Co.`);
    expect(JSON.stringify(session.state.pages[homeId()].nodes.n_note)).toContain(`© ${new Date().getFullYear()} Studio Co.`);
  });
});
