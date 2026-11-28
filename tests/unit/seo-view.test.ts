/**
 * The SEO view (#700): a workspace opened from the rail that covers the canvas, as the post writer does, with a list of
 * every page and post to choose from. Its document is kept while other panels show, opened straight from elsewhere,
 * and let go once the project no longer has it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, ProjectState } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import type { SeoSubject } from '@shared/seo';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' } });

const { activeWorkspace, canvasCovered, changeWithoutDocument, stylesShortcutCloses } = await import('../../src/renderer/src/lib/workspace');
const { waitingPreview } = await import('../../src/renderer/src/lib/posts');
const { keepSeoSubject, sameSubject, seoDocument, seoDocuments } = await import('../../src/renderer/src/lib/seo-view');

/** The editor's state as these tests read and set it. The store and actions are loaded by path, as in page-place. */
interface EditorState {
  screen: 'welcome' | 'editor';
  snapshot: ProjectSnapshot | null;
  pageId: string | null;
  selection: ElementRef | null;
  pagePlaces: Record<string, ElementRef>;
  leftTab: string | null;
  mode: 'edit' | 'preview';
  post: { collectionId: string; entryId: string } | null;
  postView: 'write' | 'preview';
  seoSubject: SeoSubject | null;
  modal: { kind: string } | null;
  rightTab: string;
  dockOpen: boolean;
  definitionMode: unknown;
  templateMode: unknown;
  chatContextEnabled: { page: boolean; scope: 'selection' | 'page' | 'site' };
}
const load = (path: string) => import(/* @vite-ignore */ path);
const { getState, setState, useStore } = (await load('../../src/renderer/src/store')) as {
  getState: () => EditorState;
  setState: (p: Partial<EditorState>) => void;
  useStore: { subscribe: (listener: (s: EditorState) => void) => () => void };
};
const subscribe = (listener: (s: EditorState) => void) => useStore.subscribe(listener);
const { openSeoView, openSeoViewFrom, openSiteStyles, pageOutOfSight, selectPage } = (await load('../../src/renderer/src/lib/actions')) as {
  openSeoView: (subject?: SeoSubject | null) => boolean;
  openSeoViewFrom: (subject: SeoSubject, place: { leave: () => void; refused: () => { name: string; focus: () => void } | null }) => boolean;
  openSiteStyles: () => void;
  pageOutOfSight: (s: EditorState, pageId: string) => boolean;
  selectPage: (pageId: string, target?: ElementRef | null) => void;
};

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

/** A business site with a blog (a published post and a draft), case studies, and an empty collection. */
function site(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    // The older post first, so the list's newest-first order is the collection's own, not the order they were made in.
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false },
    { type: 'collection.create', collectionId: 'case-studies', name: 'Case studies', route: '/work/' },
    { type: 'entry.create', collectionId: 'case-studies', entryId: 'en_mill', title: 'The old mill', publishedAt: '2026-01-05', draft: false },
    { type: 'collection.create', collectionId: 'events', name: 'Events', route: '/events/' }
  );
}

const page = (pageId: string): SeoSubject => ({ kind: 'page', pageId });
const entry = (collectionId: string, entryId: string): SeoSubject => ({ kind: 'entry', collectionId, entryId });

describe('what the editor puts in front of its page', () => {
  const base = { leftTab: 'pages', postView: 'write', mode: 'edit', post: null } as const;
  const spring = { collectionId: 'posts', entryId: 'en_spring' };

  it('is the SEO view while its panel shows, over a page or a post’s preview, in Edit or Preview', () => {
    expect(activeWorkspace({ ...base, leftTab: 'seo' })).toBe('seo');
    expect(activeWorkspace({ ...base, leftTab: 'seo', mode: 'preview' })).toBe('seo');
    // A post previewed on the canvas is under the view, and shows again once the view is left.
    const previewing = { ...base, postView: 'preview', mode: 'preview', post: spring } as const;
    expect(activeWorkspace(previewing)).toBe('preview');
    expect(activeWorkspace({ ...previewing, leftTab: 'seo' })).toBe('seo');
    expect(activeWorkspace({ ...previewing, leftTab: 'pages' })).toBe('preview');
  });

  it('is the Posts workspace as before, and nothing once another panel or none shows', () => {
    expect(activeWorkspace({ ...base, leftTab: 'posts' })).toBe('write');
    // Preview chosen in the toolbar while writing: the writer stays in front until what it holds is saved.
    expect(activeWorkspace({ ...base, leftTab: 'posts', post: spring, mode: 'preview' })).toBe('write');
    expect(activeWorkspace({ ...base, leftTab: 'posts', post: spring })).toBe('write');
    expect(activeWorkspace(base)).toBeNull();
    expect(activeWorkspace({ ...base, leftTab: null })).toBeNull();
    expect(activeWorkspace({ ...base, leftTab: 'layers', mode: 'preview' })).toBeNull();
  });

  it('covers the canvas while the SEO view or the writer shows, never while a post is previewed on it', () => {
    expect(canvasCovered('seo')).toBe(true);
    expect(canvasCovered('write')).toBe(true);
    expect(canvasCovered('preview')).toBe(false);
    expect(canvasCovered(null)).toBe(false);
  });

  it('holds back a change asked of the AI while the SEO view has no document, never a question or another view', () => {
    expect(changeWithoutDocument('seo', false, false)).toBe(true);
    expect(changeWithoutDocument('seo', true, false)).toBe(false);
    expect(changeWithoutDocument('seo', false, true), 'a question changes nothing').toBe(false);
    // The writer with no post open sends a change to the whole site instead (#1424), never to the page under it.
    expect(changeWithoutDocument('write', false, false)).toBe(false);
    expect(changeWithoutDocument('write', true, false)).toBe(false);
    expect(changeWithoutDocument('write', false, true), 'a question changes nothing').toBe(false);
    expect(changeWithoutDocument('preview', false, false)).toBe(false);
    expect(changeWithoutDocument(null, false, false)).toBe(false);
  });
});

describe('a post’s preview chosen in the toolbar while the writer saves', () => {
  const writing = { leftTab: 'posts', postView: 'write', mode: 'preview', workspaceKey: 'w#1' } as const;

  it('waits while the writer is in front in Preview, in the opening it was asked in', () => {
    expect(waitingPreview(writing, 'w#1')).toBe('waits');
  });

  it('is undone once the writer is left with Preview still on: the SEO view, another panel, or none', () => {
    expect(waitingPreview({ ...writing, leftTab: 'seo' }, 'w#1')).toBe('undone');
    expect(waitingPreview({ ...writing, leftTab: 'pages' }, 'w#1')).toBe('undone');
    expect(waitingPreview({ ...writing, leftTab: null }, 'w#1')).toBe('undone');
  });

  it('ends without undoing anything once a mode is chosen, the post is previewed, or another opening starts', () => {
    expect(waitingPreview({ ...writing, mode: 'edit' }, 'w#1')).toBe('ends');
    expect(waitingPreview({ ...writing, mode: 'edit', leftTab: 'seo' }, 'w#1')).toBe('ends');
    expect(waitingPreview({ ...writing, postView: 'preview' }, 'w#1')).toBe('ends');
    expect(waitingPreview({ ...writing, leftTab: 'seo', workspaceKey: 'w#2' }, 'w#1')).toBe('ends');
    expect(waitingPreview({ ...writing, workspaceKey: 'w#2' }, 'w#1'), 'another opening, the writer still in front').toBe('ends');
  });
});

describe('the documents the SEO view lists', () => {
  it('lists the pages first, in the site’s page order, with Home at /', () => {
    const s = site();
    const reordered = [...s.site.pageOrder].reverse();
    const r = run(s, { type: 'page.reorder', pageIds: reordered });
    const [pages] = seoDocuments(r);
    expect(pages.id).toBe('pages');
    expect(pages.label).toBe('Pages');
    expect(pages.documents.map((d) => d.subject)).toEqual(reordered.map(page));
    const home = pages.documents.find((d) => d.home)!;
    expect(home.subject).toEqual(page(r.site.homePageId));
    expect(home.address).toBe('/');
    const about = pages.documents.find((d) => d.title === 'About')!;
    expect(about.address).toBe(r.pages[(about.subject as { pageId: string }).pageId].route);
    expect(pages.documents.every((d) => !d.draft)).toBe(true);
  });

  it('marks a draft page, never Home', () => {
    const s = site();
    const about = s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
    const r = run(s, { type: 'page.update', pageId: about, draft: true });
    const [pages] = seoDocuments(r);
    expect(pages.documents.find((d) => d.title === 'About')?.draft).toBe(true);
    const home = structuredClone(r);
    home.pages[home.site.homePageId].draft = true;
    expect(seoDocuments(home)[0].documents.find((d) => d.home)?.draft, 'Home is always on the website').toBe(false);
  });

  it('then each collection with entries, by ID, its entries in the collection’s order, drafts included', () => {
    const groups = seoDocuments(site());
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ['pages', 'Pages'],
      ['collection-case-studies', 'Case studies'],
      ['collection-posts', 'Posts']
    ]);
    const posts = groups.find((g) => g.id === 'collection-posts')!;
    // Newest first, the collection's own order with none chosen: the draft is listed with the published post.
    expect(posts.documents.map((d) => [d.title, d.draft, d.address])).toEqual([
      ['Spring open studio', false, '/blog/spring-open-studio/'],
      ['Winter hours', true, '/blog/winter-hours/']
    ]);
    expect(posts.documents[0].subject).toEqual(entry('posts', 'en_spring'));
    expect(groups.find((g) => g.id === 'collection-case-studies')!.documents.map((d) => d.address)).toEqual(['/work/the-old-mill/']);
    // An editorial order chosen for the collection is the list's order.
    const reordered = run(site(), { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_winter', 'en_spring'] });
    expect(seoDocuments(reordered).find((g) => g.id === 'collection-posts')!.documents.map((d) => d.title)).toEqual(['Winter hours', 'Spring open studio']);
  });

  it('keeps a collection called “pages” apart from the site’s pages', () => {
    const s = run(site(), { type: 'collection.create', collectionId: 'pages', name: 'Journal', route: '/journal/' }, { type: 'entry.create', collectionId: 'pages', entryId: 'en_note', title: 'A note', publishedAt: '2026-05-01' });
    const ids = seoDocuments(s).map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(seoDocuments(s).find((g) => g.label === 'Journal')?.id).toBe('collection-pages');
  });

  it('leaves out a collection whose entries have no pages, and lets a chosen entry go once its pages are turned off', () => {
    const s = run(
      site(),
      { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false }
    );
    // Nothing of a data-only entry reaches search results, so it has no address to show and is not listed.
    expect(seoDocuments(s).map((g) => g.id)).not.toContain('collection-team');
    expect(seoDocument(s, entry('team', 'en_ruiz'))).toBeUndefined();
    const mill = entry('case-studies', 'en_mill');
    expect(keepSeoSubject(s, mill)).toEqual({});
    const unpaged = run(s, { type: 'collection.update', collectionId: 'case-studies', pages: { detail: false, archive: false } });
    expect(seoDocuments(unpaged).map((g) => g.id)).not.toContain('collection-case-studies');
    expect(keepSeoSubject(unpaged, mill)).toEqual({ seoSubject: null });
  });

  it('tells documents with the same title apart by their key and address', () => {
    const s = run(site(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring2', title: 'Spring open studio', publishedAt: '2027-03-01' });
    const twins = seoDocuments(s)
      .find((g) => g.id === 'collection-posts')!
      .documents.filter((d) => d.title === 'Spring open studio');
    expect(twins).toHaveLength(2);
    expect(new Set(twins.map((d) => d.key)).size).toBe(2);
    expect(new Set(twins.map((d) => d.address)).size).toBe(2);
    // A document's key is what it is, never its address: it stays when the address changes.
    const key = twins.find((d) => d.subject.kind === 'entry' && d.subject.entryId === 'en_spring2')!.key;
    const moved = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring2', slug: 'spring-again' });
    expect(seoDocument(moved, entry('posts', 'en_spring2'))).toMatchObject({ key, address: '/blog/spring-again/' });
  });
});

describe('the document a subject names', () => {
  it('is the page or entry while the project has it, renamed as it is now', () => {
    const s = site();
    const home = s.site.homePageId;
    expect(seoDocument(s, page(home))?.title).toBe(s.pages[home].title);
    const about = s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
    expect(seoDocument(s, page(about))).toMatchObject({ subject: page(about), title: 'About', address: s.pages[about].route, home: false });
    expect(seoDocument(s, entry('posts', 'en_winter'))).toMatchObject({ title: 'Winter hours', draft: true, address: '/blog/winter-hours/' });
    const renamed = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Winter opening hours' });
    expect(seoDocument(renamed, entry('posts', 'en_winter'))?.title).toBe('Winter opening hours');
  });

  it('is nothing for a page or entry that is gone, or an entry named under another collection', () => {
    const s = site();
    expect(seoDocument(s, page('pg_gone'))).toBeUndefined();
    expect(seoDocument(s, entry('posts', 'en_gone'))).toBeUndefined();
    expect(seoDocument(s, entry('case-studies', 'en_spring'))).toBeUndefined();
    expect(seoDocument(s, entry('nope', 'en_spring'))).toBeUndefined();
    expect(seoDocument(s, null)).toBeUndefined();
    expect(seoDocument(null, page(s.site.homePageId))).toBeUndefined();
  });

  it('is let go with a new copy of the project that no longer has it, and kept while it does', () => {
    const s = site();
    const winter = entry('posts', 'en_winter');
    expect(keepSeoSubject(s, winter)).toEqual({});
    expect(keepSeoSubject(s, null)).toEqual({});
    const deleted = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' });
    expect(keepSeoSubject(deleted, winter)).toEqual({ seoSubject: null });
    const about = s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
    const noAbout = structuredClone(s);
    delete noAbout.pages[about];
    noAbout.site.pageOrder = noAbout.site.pageOrder.filter((id) => id !== about);
    expect(keepSeoSubject(noAbout, page(about))).toEqual({ seoSubject: null });
    expect(sameSubject(page(about), page(about))).toBe(true);
    expect(sameSubject(page(about), page(s.site.homePageId))).toBe(false);
    expect(sameSubject(page(about), entry('posts', about))).toBe(false);
    expect(sameSubject(entry('posts', 'en_winter'), entry('posts', 'en_spring'))).toBe(false);
    expect(sameSubject(page(about), null)).toBe(false);
  });
});

describe('the SEO view in the editor', () => {
  const s = site();
  const home = s.site.homePageId;
  const about = s.site.pageOrder.find((id) => s.pages[id].title === 'About')!;
  const snapshot = (state: ProjectState) => ({ workspaceKey: 'w#1', revision: 1, state, history: { canUndo: false, canRedo: false } }) as unknown as ProjectSnapshot;
  const cta = { owner: { kind: 'page' as const, id: home }, instancePath: [], nodeId: s.pages[home].rootIds.at(-1)! };

  beforeEach(() => setState({ screen: 'editor', snapshot: snapshot(s), pageId: home, selection: cta, leftTab: 'pages', mode: 'edit', post: null, postView: 'write', seoSubject: null, modal: null, definitionMode: null, templateMode: null, pagePlaces: { [home]: cta } }));

  it('opens from another panel on a given page or post, closing the dialog that asked', () => {
    const spring = { collectionId: 'posts', entryId: 'en_spring' };
    setState({ modal: { kind: 'health' }, pageId: about, selection: null, post: spring, postView: 'preview', mode: 'preview' });
    expect(openSeoView(entry('posts', 'en_winter'))).toBe(true);
    expect(getState()).toMatchObject({ leftTab: 'seo', seoSubject: entry('posts', 'en_winter'), modal: null });
    // What the canvas shows (here a post's preview over About) is left as it was, under the view.
    expect(getState()).toMatchObject({ pageId: about, selection: null, mode: 'preview', post: spring, postView: 'preview' });
    expect(openSeoView(page(about))).toBe(true);
    expect(getState().seoSubject).toEqual(page(about));
  });

  it('keeps its document while another panel shows, and opens on it again', () => {
    openSeoView(page(about));
    setState({ leftTab: 'layers' });
    expect(activeWorkspace(getState())).toBeNull();
    setState({ leftTab: 'seo' });
    expect(getState().seoSubject).toEqual(page(about));
    setState({ leftTab: null });
    expect(openSeoView()).toBe(true);
    expect(getState()).toMatchObject({ leftTab: 'seo', seoSubject: page(about) });
  });

  it('refuses a page or post the project no longer has, leaving the editor as it was', () => {
    openSeoView(page(about));
    setState({ leftTab: 'pages' });
    setState({ modal: { kind: 'health' } });
    expect(openSeoView(entry('posts', 'en_gone'))).toBe(false);
    expect(openSeoView(page('pg_gone'))).toBe(false);
    expect(getState()).toMatchObject({ leftTab: 'pages', seoSubject: page(about), modal: { kind: 'health' } });
    setState({ snapshot: null });
    expect(openSeoView(page(home))).toBe(false);
  });

  it('keeps the page under it out of sight, and a page chosen elsewhere puts the view away', () => {
    openSeoView(page(about));
    expect(pageOutOfSight(getState(), home), 'the page under the view takes opening').toBe(true);
    // Opened as another page is, at its place (the section last selected there), rather than as the page itself.
    setState({ selection: null });
    selectPage(home);
    expect(getState()).toMatchObject({ leftTab: 'pages', pageId: home, selection: cta });
    expect(pageOutOfSight(getState(), home)).toBe(false);
    // The view's document is kept for when it opens again.
    expect(getState().seoSubject).toEqual(page(about));
  });

  it('starts the AI’s reach again when it opens, leaves or chooses another document', () => {
    const wide = () => setState({ chatContextEnabled: { page: true, scope: 'site' } });
    wide();
    openSeoView(page(about));
    expect(getState().chatContextEnabled.scope, 'opened').toBe('selection');
    wide();
    setState({ seoSubject: entry('posts', 'en_winter') });
    expect(getState().chatContextEnabled.scope, 'another document').toBe('selection');
    wide();
    setState({ seoSubject: entry('posts', 'en_winter') });
    expect(getState().chatContextEnabled.scope, 'the same one again changes nothing').toBe('site');
    setState({ leftTab: 'layers' });
    expect(getState().chatContextEnabled.scope, 'left').toBe('selection');
    wide();
    setState({ leftTab: 'pages' });
    expect(getState().chatContextEnabled.scope, 'another panel outside the view changes nothing').toBe('site');
    // The document it remembers, let go while another panel shows (deleted), is nothing the message was about.
    setState({ seoSubject: null });
    expect(getState().chatContextEnabled.scope, 'a remembered document let go outside the view').toBe('site');
    // A scope said in the same update is kept.
    setState({ leftTab: 'seo', seoSubject: page(about), chatContextEnabled: { page: true, scope: 'page' } });
    expect(getState().chatContextEnabled.scope, 'its own scope, said with the change').toBe('page');
  });

  // Open in SEO view, beside a document's own settings (#708): what is typed is saved first, and nothing is lost.
  it('opens from a document’s own settings once the field being typed in is left', () => {
    const steps: string[] = [];
    const place = {
      leave: () => steps.push(`left with ${getState().leftTab}`),
      refused: () => (steps.push('looked'), null)
    };
    expect(openSeoViewFrom(entry('posts', 'en_spring'), place)).toBe(true);
    expect(steps, 'the field is left before the view opens, and checked after').toEqual(['left with pages', 'looked']);
    expect(getState()).toMatchObject({ leftTab: 'seo', seoSubject: entry('posts', 'en_spring') });
  });

  it('carries a page’s refused text to the view’s field, and keeps a post’s refused text where it was typed', () => {
    const focused: string[] = [];
    const held = (name: string) => ({ leave: () => undefined, refused: () => ({ name, focus: () => focused.push(name) }) });
    // A page's refused text goes with its field (#702): the view's field shows it, so the view opens.
    expect(openSeoViewFrom(page(about), held('Browser title'))).toBe(true);
    expect(getState()).toMatchObject({ leftTab: 'seo', seoSubject: page(about) });
    expect(focused).toEqual([]);
    // A post's stays in the writer's control (#703): the view, which would show the saved text, does not open over it.
    setState({ leftTab: 'posts', seoSubject: null, toasts: [] } as Partial<EditorState>);
    expect(openSeoViewFrom(entry('posts', 'en_spring'), held('Canonical URL'))).toBe(false);
    expect(getState()).toMatchObject({ leftTab: 'posts', seoSubject: null });
    expect(focused, 'the field with the refused text has focus again').toEqual(['Canonical URL']);
    const said = (getState() as unknown as { toasts: { text: string; kind: string }[] }).toasts.at(-1);
    expect(said).toMatchObject({ kind: 'error' });
    expect(said?.text).toMatch(/^What is typed in Canonical URL is not saved yet\./);
  });

  it('opens from a document’s own settings only on a document the project still has', () => {
    expect(openSeoViewFrom(entry('posts', 'en_gone'), { leave: () => undefined, refused: () => null })).toBe(false);
    expect(getState()).toMatchObject({ leftTab: 'pages', seoSubject: null });
  });

  it('puts a post’s preview under it away too when a page is chosen', () => {
    setState({ leftTab: 'seo', post: { collectionId: 'posts', entryId: 'en_spring' }, postView: 'preview', mode: 'preview' });
    expect(activeWorkspace(getState())).toBe('seo');
    selectPage(about);
    expect(getState()).toMatchObject({ leftTab: 'pages', postView: 'write', pageId: about });
  });
});

describe('a page’s search settings in the SEO view (#702)', () => {
  it('save with the operation and history label the Inspector saves them with', async () => {
    const { pageUpdate } = (await load('../../src/renderer/src/lib/page-settings')) as { pageUpdate: (page: { id: string; title: string }, patch: Record<string, unknown>, label?: string) => { operations: EditOperation[]; label: string } };
    const about = { id: 'pg_about', title: 'About' };
    expect(pageUpdate(about, { seoTitle: 'About us' }, 'Change browser title')).toEqual({ operations: [{ type: 'page.update', pageId: 'pg_about', seoTitle: 'About us' }], label: 'Change browser title (About)' });
    // The visibility switches say only that the page's settings changed, as they always have.
    expect(pageUpdate(about, { noindex: true })).toEqual({ operations: [{ type: 'page.update', pageId: 'pg_about', noindex: true }], label: 'Update page settings (About)' });
    expect(pageUpdate(about, { structuredData: { price: '129' } }, 'Change price')).toEqual({ operations: [{ type: 'page.update', pageId: 'pg_about', structuredData: { price: '129' } }], label: 'Change price (About)' });
  });
});

describe('Site styles opened over a workspace (#1108)', () => {
  const spring = { collectionId: 'posts', entryId: 'en_spring' };
  const open = (p: Partial<EditorState>) => {
    const state = site();
    setState({ screen: 'editor', snapshot: { state } as ProjectSnapshot, pageId: state.site.pageOrder[0], selection: null, leftTab: 'pages', mode: 'edit', post: null, postView: 'write', definitionMode: null });
    setState(p);
  };
  const shown = () => ({ covered: canvasCovered(activeWorkspace(getState())), leftTab: getState().leftTab });

  it('brings the canvas back from the Content writer, with a post open or none, keeping the post', () => {
    for (const post of [spring, null]) {
      open({ leftTab: 'posts', post, rightTab: 'inspect', dockOpen: false });
      openSiteStyles();
      expect(shown()).toEqual({ covered: false, leftTab: 'pages' });
      expect(getState()).toMatchObject({ post, postView: 'write', mode: 'edit', rightTab: 'styles', dockOpen: true });
    }
  });

  it('leaves the SEO view for the panel it replaced', () => {
    open({ leftTab: 'layers' });
    setState({ leftTab: 'seo' });
    openSiteStyles();
    expect(shown()).toEqual({ covered: false, leftTab: 'layers' });
  });

  it('goes to Pages from an SEO view opened over the writer, which would cover the canvas again', () => {
    for (const post of [spring, null]) {
      open({ leftTab: 'posts', post });
      setState({ leftTab: 'seo' });
      openSiteStyles();
      expect(shown()).toEqual({ covered: false, leftTab: 'pages' });
    }
  });

  it('ends a Preview still waiting on the writer before the page shows, so it is never seen as previewed', () => {
    open({ leftTab: 'posts', post: spring, mode: 'preview' });
    const previewed: boolean[] = [];
    const stop = subscribe((s) => void previewed.push(s.mode === 'preview' && !canvasCovered(activeWorkspace(s))));
    openSiteStyles();
    stop();
    expect(previewed).not.toContain(true);
    expect(getState()).toMatchObject({ mode: 'edit', post: spring, postView: 'write' });
    expect(shown()).toEqual({ covered: false, leftTab: 'pages' });
  });

  it('leaves the left panel as it is where the canvas already shows: another panel, none, or a post’s preview', () => {
    for (const leftTab of ['assets', null]) {
      open({ leftTab });
      openSiteStyles();
      expect(shown()).toEqual({ covered: false, leftTab });
    }
    open({ leftTab: 'posts', post: spring, postView: 'preview', mode: 'preview' });
    openSiteStyles();
    expect(shown()).toEqual({ covered: false, leftTab: 'posts' });
    expect(getState()).toMatchObject({ post: spring, postView: 'preview', mode: 'preview' });
  });

  it('has the rail button bring the canvas back, not close, when Site styles already show beside a workspace', () => {
    const showing = { dockOpen: true, rightTab: 'styles', leftTab: 'pages', postView: 'write', mode: 'edit', post: null } as const;
    for (const leftTab of ['pages', 'layers', 'assets', null]) expect(stylesShortcutCloses({ ...showing, leftTab })).toBe(true);
    expect(stylesShortcutCloses({ ...showing, leftTab: 'posts' })).toBe(false);
    expect(stylesShortcutCloses({ ...showing, leftTab: 'seo' })).toBe(false);
    expect(stylesShortcutCloses({ ...showing, leftTab: 'posts', postView: 'preview', mode: 'preview', post: spring })).toBe(true);
    expect(stylesShortcutCloses({ ...showing, dockOpen: false })).toBe(false);
    expect(stylesShortcutCloses({ ...showing, rightTab: 'inspect' })).toBe(false);
  });
});
