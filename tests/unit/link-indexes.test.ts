/**
 * The collections a link can go to the index of, as the Inspector's and the post writer's link editors read them (#967):
 * worked out again only when what they depend on changed, so an edit of a page's content does not walk every entry of
 * every collection, and always what `linkableIndexes` gives for the state shown.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { linkableIndexes } from '@shared/archives';
import { countSiteEntryWalks } from '@shared/collections';
import { linkIndexes } from '../../src/renderer/src/lib/link-indexes';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const blog = () => run(createStarterState('business', 'Riverside Studio', false), { type: 'collection.create', collectionId: 'posts' });
/** `s` with one page's fields changed, every other part of the state the very object it was. */
const withPage = (s: ProjectState, id: string, fields: Record<string, unknown>): ProjectState => ({ ...s, pages: { ...s.pages, [id]: { ...s.pages[id], ...fields } } });

let walks = 0;
countSiteEntryWalks(() => walks++);
afterEach(() => {
  walks = 0;
});
afterAll(() => countSiteEntryWalks(null));

describe('the link editors’ collection indexes', () => {
  it('are not worked out again for an edit of a page’s content', () => {
    const s = blog();
    const first = linkIndexes(s);
    expect(first).toEqual(linkableIndexes(s));
    expect(first.map((x) => x.id)).toEqual(['posts']);
    walks = 0;
    const home = s.site.homePageId;
    const edited = withPage(s, home, { title: 'Welcome home', nodes: { ...s.pages[home].nodes } });
    expect(linkIndexes(edited)).toBe(first);
    expect(walks).toBe(0);
  });

  it('follow a page taking the index’s address, a page made a draft, the collections and the site', () => {
    const s = blog();
    const route = linkIndexes(s)[0].route;
    const other = Object.keys(s.pages).find((id) => id !== s.site.homePageId)!;
    const check = (next: ProjectState) => {
      walks = 0;
      const got = linkIndexes(next);
      expect(walks).toBeGreaterThan(0);
      expect(got).toEqual(linkableIndexes(next));
      return got;
    };
    linkIndexes(s);
    // A page at the index's address takes it: the collection has no index a link can go to.
    const taken = withPage(s, other, { route });
    expect(check(taken)).toEqual([]);
    // Made a draft, the page holds no address on the website, and the index is back.
    expect(check(withPage(taken, other, { draft: true })).map((x) => x.id)).toEqual(['posts']);
    // The collection renamed and nothing else, against a lookup of the same pages and site: its collections alone.
    linkIndexes(s);
    const renamed = { ...s, collections: { ...s.collections, posts: { ...s.collections.posts, settings: { ...s.collections.posts.settings, name: 'Journal' } } } };
    expect(check(renamed)).toEqual([{ id: 'posts', name: 'Journal', route }]);
    // Moved, as the author moves it.
    const moved = run(renamed, { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    expect(check(moved)).toEqual([{ id: 'posts', name: 'Journal', route: '/journal/' }]);
    // An old address kept working holds it while it leads to a published page (the site alone changed since the lookup
    // before), and not once that page is a draft (its pages alone).
    const kept = { ...moved, site: { ...moved.site, redirects: [...(moved.site.redirects ?? []), { from: '/journal/', pageId: other }] } };
    expect(check(kept)).toEqual([]);
    expect(check(withPage(kept, other, { draft: true })).map((x) => x.id)).toEqual(['posts']);
    // Another home page, against a lookup of the same collections and pages: the site alone.
    linkIndexes(moved);
    check({ ...moved, site: { ...moved.site, homePageId: other } });
  });
});
