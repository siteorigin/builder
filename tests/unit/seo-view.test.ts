/**
 * The SEO view (#700): a workspace opened from the rail that covers the canvas, as the post writer does, with a list of
 * every page and post to choose from. Its document is kept while other panels show, opened straight from elsewhere,
 * and let go once the project no longer has it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import type { SeoSubject } from '@shared/seo';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => undefined }, platform: 'darwin' } });

const { activeWorkspace, canvasCovered } = await import('../../src/renderer/src/lib/workspace');
const { keepSeoSubject, sameSubject, seoDocument, seoDocuments } = await import('../../src/renderer/src/lib/seo-view');
const { getState, setState } = await import('../../src/renderer/src/store');
const { openSeoView, pageOutOfSight, selectPage } = await import('../../src/renderer/src/lib/actions');

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

/** A business site with a blog (a published post and a draft), case studies, and an empty collection. */
function site(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' },
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
      ['case-studies', 'Case studies'],
      ['posts', 'Posts']
    ]);
    const posts = groups.find((g) => g.id === 'posts')!;
    // Newest first, the collection's own order with none chosen: the draft is listed with the published post.
    expect(posts.documents.map((d) => [d.title, d.draft, d.address])).toEqual([
      ['Spring open studio', false, '/blog/spring-open-studio/'],
      ['Winter hours', true, '/blog/winter-hours/']
    ]);
    expect(posts.documents[0].subject).toEqual(entry('posts', 'en_spring'));
    expect(groups.find((g) => g.id === 'case-studies')!.documents.map((d) => d.address)).toEqual(['/work/the-old-mill/']);
    // An editorial order chosen for the collection is the list's order.
    const reordered = run(site(), { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_winter', 'en_spring'] });
    expect(seoDocuments(reordered).find((g) => g.id === 'posts')!.documents.map((d) => d.title)).toEqual(['Winter hours', 'Spring open studio']);
  });

  it('tells documents with the same title apart by their key and address', () => {
    const s = run(site(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring2', title: 'Spring open studio', publishedAt: '2027-03-01' });
    const twins = seoDocuments(s)
      .find((g) => g.id === 'posts')!
      .documents.filter((d) => d.title === 'Spring open studio');
    expect(twins).toHaveLength(2);
    expect(new Set(twins.map((d) => d.key)).size).toBe(2);
    expect(new Set(twins.map((d) => d.address)).size).toBe(2);
  });
});

describe('the document a subject names', () => {
  it('is the page or entry while the project has it, renamed as it is now', () => {
    const s = site();
    const home = s.site.homePageId;
    expect(seoDocument(s, page(home))?.title).toBe(s.pages[home].title);
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
    expect(sameSubject(page(about), entry('posts', about))).toBe(false);
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
    setState({ modal: { kind: 'health' } });
    expect(openSeoView(entry('posts', 'en_winter'))).toBe(true);
    expect(getState()).toMatchObject({ leftTab: 'seo', seoSubject: entry('posts', 'en_winter'), modal: null });
    // What the canvas shows and what is selected there are left as they were, under the view.
    expect(getState()).toMatchObject({ pageId: home, selection: cta, mode: 'edit', post: null });
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
    expect(openSeoView(entry('posts', 'en_gone'))).toBe(false);
    expect(getState()).toMatchObject({ leftTab: 'pages', seoSubject: page(about) });
    setState({ snapshot: null });
    expect(openSeoView(page(home))).toBe(false);
  });

  it('keeps the page under it out of sight, and a page chosen elsewhere puts the view away', () => {
    openSeoView(page(about));
    expect(pageOutOfSight(getState(), home), 'the page under the view takes opening').toBe(true);
    // Opened as another page is, at its place, rather than as the page itself.
    selectPage(home);
    expect(getState()).toMatchObject({ leftTab: 'pages', pageId: home, selection: cta });
    expect(pageOutOfSight(getState(), home)).toBe(false);
    // The view's document is kept for when it opens again.
    expect(getState().seoSubject).toEqual(page(about));
  });

  it('puts a post’s preview under it away too when a page is chosen', () => {
    setState({ leftTab: 'seo', post: { collectionId: 'posts', entryId: 'en_spring' }, postView: 'preview', mode: 'preview' });
    expect(activeWorkspace(getState())).toBe('seo');
    selectPage(about);
    expect(getState()).toMatchObject({ leftTab: 'pages', postView: 'write', pageId: about });
  });
});
