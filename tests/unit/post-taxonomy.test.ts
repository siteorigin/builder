/**
 * Categories and tags managed one term at a time (#396): a term added under a name, renamed with its ID (its archive
 * address) following the name, every post filed under it and every list of posts that chooses it kept pointing at it
 * in one change, and deleted from every post it was on, refused while a list of posts chooses it.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import { queryEntries } from '@shared/collection-query';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { termFeedUses } from '@engine/terms';
import { EngineError } from '@engine/tree';
import { entriesWithTerm, termIdFor } from '@shared/collections';
import { archivePages } from '@shared/archives';
import { codeEntryQueries, entryQuery, entryRows } from '@shared/entry-feed';
import { defFile, publishedState } from '@generator/index';
import { toolDefinitions } from '@agent/tools';
import { P } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const result = (s: ProjectState, op: EditOperation) => applyOperations(s, [op]).results[0] as Record<string, unknown>;
const refused = (s: ProjectState, ...ops: EditOperation[]) => {
  try {
    applyOperations(s, ops);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('the change was not refused');
};
const page = (id: string): OwnerRef => ({ kind: 'page', id });

const post = (entryId: string, title: string, publishedAt: string, extra: Record<string, unknown> = {}): EditOperation =>
  ({ type: 'entry.create', collectionId: 'posts', entryId, title, publishedAt, draft: false, body: [`${title}.`], ...extra }) as EditOperation;

/** A studio blog: News and Craft categories, a Glaze tag, four posts (one a draft) filed under them. */
function blog(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts', taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' }, craft: { label: 'Craft' } } }, tags: { label: 'Tags', terms: { glaze: { label: 'Glaze' } } } } },
    post('en_kiln', 'New kiln', '2026-04-01', { terms: { categories: ['news'] } }),
    post('en_glaze', 'Glaze night', '2026-03-10', { terms: { categories: ['news', 'craft'], tags: ['glaze'] } }),
    post('en_wheel', 'Wheel basics', '2026-02-01', { terms: { categories: ['craft'] } }),
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans', publishedAt: '2026-05-01', terms: { categories: ['news'] } }
  );
}

/** A grid of posts placed on Home, choosing its posts with these properties. */
function onHome(s: ProjectState, props: Record<string, unknown>) {
  const r = applyOperations(s, [{ type: 'node.insert', owner: page(s.site.homePageId), componentId: 'blog.grid', props }]);
  return { s: r.state, nodeId: r.results[0].nodeId as string };
}
const placed = (s: ProjectState, nodeId: string) => s.pages[s.site.homePageId].nodes[nodeId] as InstanceNode;
/** The posts a placement on Home lists, by ID. */
function listed(s: ProjectState, nodeId: string): string[] {
  const n = placed(s, nodeId);
  return entryRows(s, entryQuery(s.components[n.definitionId].properties, n.props)).map((r) => r.id);
}
const codeDesign = (id: string, name: string, source: string) =>
  ({ schemaVersion: 1, id, componentId: id, contractVersion: 1, kind: 'code', owner: 'project', name, description: '', category: 'custom', tags: [], properties: {}, parts: { root: { nodeId: 'root', label: 'Root' } }, source, sourcePath: `src/lib/siteorigin/custom/${id}.svelte` }) as unknown as ComponentDefinition;
const gridDef = (s: ProjectState) => Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;

describe('adding a term', () => {
  it('takes an ID from its name, numbered while another term has it, and keeps the name as written', () => {
    let s = run(blog(), { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: '  Arts & Crafts ' });
    expect(s.collections.posts.settings.taxonomies.categories.terms['arts-and-crafts']).toEqual({ label: 'Arts & Crafts' });
    expect(result(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Arts and crafts!' })).toMatchObject({ termId: 'arts-and-crafts-2' });
    // A name in another script keeps its letters; its ID, an address, is plain.
    s = run(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: '東京' }, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: '大阪' });
    s = run(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: '京都' });
    expect(s.collections.posts.settings.taxonomies.tags.terms).toMatchObject({ term: { label: '東京' }, 'term-2': { label: '大阪' }, 'term-3': { label: '京都' } });
    // Never an object-prototype name.
    expect(result(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'Constructor' })).toMatchObject({ termId: 'constructor-2' });
    expect(termIdFor({}, 'Constructor')).toBe('constructor-2');
    // A term's ID is a folder of its archive's address: never a name some systems keep for a device.
    expect(termIdFor({}, 'AUX')).toBe('aux-2');
    expect(termIdFor({}, 'Com1')).toBe('com1-2');
    // Or the ID asked for.
    expect(result(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'Kyoto', termId: 'kyoto-trip' })).toMatchObject({ termId: 'kyoto-trip' });
  });

  it('refuses a name another term of the grouping has, an ID that is taken, and a grouping the collection lacks', () => {
    const s = blog();
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'NEWS' })).toMatch(/already a term called “News”/);
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: '   ' })).toMatch(/needs a name/);
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates', termId: 'news' })).toMatch(/already has the ID "news"/);
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates', termId: 'Not An ID' })).toMatch(/not a term ID/);
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'regions', label: 'North' })).toMatch(/no grouping "regions"/);
    // The same name in another grouping is another term.
    expect(result(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'tags', label: 'News' })).toMatchObject({ termId: 'news' });
  });

  it('adds categories or tags to a collection that has none', () => {
    const s = run(createStarterState('business', 'Riverside Studio', false), { type: 'collection.create', collectionId: 'projects' }, { type: 'collection.createTerm', collectionId: 'projects', taxonomyId: 'tags', label: 'Timber' });
    expect(s.collections.projects.settings.taxonomies).toEqual({ tags: { label: 'Tags', terms: { timber: { label: 'Timber' } } } });
  });
});

describe('renaming a term', () => {
  it('moves its ID with its name, keeping every post (drafts too) filed under it in the order it was filed', () => {
    const before = blog();
    const r = applyOperations(before, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }]);
    const s = r.state;
    expect(r.results[0]).toMatchObject({ termId: 'studio-updates', previousTermId: 'news', affectedPosts: 3 });
    // The renamed term keeps its place among the others.
    expect(Object.entries(s.collections.posts.settings.taxonomies.categories.terms)).toEqual([
      ['studio-updates', { label: 'Studio updates' }],
      ['craft', { label: 'Craft' }]
    ]);
    expect(s.collections.posts.entries.en_glaze.terms).toEqual({ categories: ['studio-updates', 'craft'], tags: ['glaze'] });
    expect(s.collections.posts.entries.en_secret.terms.categories).toEqual(['studio-updates']);
    expect(entriesWithTerm(s.collections.posts, 'categories', 'news')).toEqual([]);
    // Its archive moves to the new address with its posts.
    const archives = (st: ProjectState) => archivePages(publishedState(st)).filter((p) => p.term?.taxonomy === 'categories').map((p) => [p.route, p.entryIds]);
    expect(archives(before)).toContainEqual(['/blog/category/news/', ['en_kiln', 'en_glaze']]);
    expect(archives(s)).toContainEqual(['/blog/category/studio-updates/', ['en_kiln', 'en_glaze']]);
    expect(archives(s).map(([route]) => route)).not.toContain('/blog/category/news/');
  });

  it('keeps the ID when the new name has the same slug, and changes nothing for the same name', () => {
    const s = run(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'NEWS' });
    expect(s.collections.posts.settings.taxonomies.categories.terms.news).toEqual({ label: 'NEWS' });
    expect(result(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: ' News ' })).toMatchObject({ termId: 'news', feeds: 0 });
    // A slug another term has is numbered; the ID asked for is taken as it is.
    expect(result(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Craft!' })).toMatchObject({ termId: 'craft-2' });
    expect(refused(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'craft' })).toMatch(/already a term called “Craft”/);
    expect(result(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Craft notes', newTermId: 'notes' })).toMatchObject({ termId: 'notes' });
    expect(refused(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates', newTermId: 'craft' })).toMatch(/already has the ID "craft"/);
    expect(refused(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'gone', label: 'Updates' })).toMatch(/Categories has no term "gone"/);
  });

  it('keeps every list of posts that chose it, by ID, by name or among others, listing the same posts', () => {
    let { s, nodeId: byId } = onHome(blog(), { category: 'news' });
    let byName: string;
    ({ s, nodeId: byName } = onHome(s, { category: 'news ' }));
    s = structuredClone(s);
    placed(s, byName).props.category = 'News';
    let several: string;
    ({ s, nodeId: several } = onHome(s, { category: 'Craft, News' }));
    let tagged: string;
    ({ s, nodeId: tagged } = onHome(s, { tag: 'glaze' }));
    const all = [byId, byName, several, tagged].map((n) => listed(s, n));
    const r = applyOperations(s, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }]);
    expect(r.results[0]).toMatchObject({ feeds: 3 });
    const after = r.state;
    expect([byId, byName, several, tagged].map((n) => listed(after, n))).toEqual(all);
    expect(placed(after, byId).props.category).toBe('studio-updates');
    expect(placed(after, byName).props.category).toBe('studio-updates');
    expect(placed(after, several).props.category).toBe('craft, studio-updates');
    expect(placed(after, tagged).props.tag).toBe('glaze');
    // A tag's rename keeps a list of its posts the same way.
    const t = run(after, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'tags', termId: 'glaze', label: 'Glazes' });
    expect(placed(t, tagged).props.tag).toBe('glazes');
    expect(listed(t, tagged)).toEqual(all[3]);
  });

  it('never lets a name another term had pick up a list of that term’s posts', () => {
    // "News" names `workshops` (the first term whose name it is); `news` is the ID of another term.
    const start = run(blog(), {
      type: 'collection.update',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { workshops: { label: 'News' }, news: { label: 'Announcements' }, craft: { label: 'Craft' } } }, tags: { label: 'Tags', terms: { glaze: { label: 'Glaze' } } } }
    } as EditOperation);
    let s = run(start, { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', terms: { categories: ['workshops'] } });
    let byName: string;
    let byOtherId: string;
    ({ s, nodeId: byName } = onHome(s, { category: 'News, Craft' }));
    ({ s, nodeId: byOtherId } = onHome(s, { category: 'news, Craft' }));
    const before = [listed(s, byName), listed(s, byOtherId)];
    expect(before[0]).toEqual(['en_glaze', 'en_wheel']);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'workshops', label: 'Workshops' });
    expect([listed(after, byName), listed(after, byOtherId)]).toEqual(before);
    expect(placed(after, byName).props.category).toBe('workshops, craft');
    expect(placed(after, byOtherId).props.category).toBe('news, Craft');
  });

  it('refuses a new name that a list choosing no term would then pick up', () => {
    const { s } = onHome(blog(), { category: 'Updates' });
    expect(refused(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates' })).toMatch(/“Post grid” in Home lists entries by “Updates”, which renaming “News” would change/);
  });

  it('follows a design’s default choice, and keeps the choice of a placement that reads another collection', () => {
    let s = onHome(blog(), {}).s;
    s = run(s, { type: 'collection.create', collectionId: 'journal', route: '/journal/', taxonomies: { categories: { label: 'Categories', terms: { notes: { label: 'News' } } } } });
    s = run(s, { type: 'entry.create', collectionId: 'journal', entryId: 'en_note', title: 'A note', publishedAt: '2026-01-01', draft: false, terms: { categories: ['notes'] } });
    s = structuredClone(s);
    const grid = gridDef(s);
    // A copy of the grid whose default lists the blog's News.
    const own: ComponentDefinition = structuredClone(grid);
    own.id = own.componentId = 'project.news-grid';
    own.owner = 'project';
    own.name = 'News grid';
    (own.properties.category as { default: string }).default = 'News';
    s.components[own.id] = own;
    const home = s.site.homePageId;
    const add = (st: ProjectState, props: Record<string, unknown>) => {
      const r = applyOperations(st, [{ type: 'node.insert', owner: page(home), definitionId: own.id, props }]);
      return { s: r.state, nodeId: r.results[0].nodeId as string };
    };
    let blogs: string;
    let journals: string;
    ({ s, nodeId: blogs } = add(s, {}));
    ({ s, nodeId: journals } = add(s, { collection: 'journal' }));
    // Neither makes a choice of its own: both read the design's default.
    s = structuredClone(s);
    delete placed(s, blogs).props.category;
    delete placed(s, journals).props.category;
    const before = [listed(s, blogs), listed(s, journals)];
    expect(before).toEqual([['en_kiln', 'en_glaze'], ['en_note']]);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' });
    expect(after.components[own.id].properties.category).toMatchObject({ default: 'studio-updates' });
    expect([listed(after, blogs), listed(after, journals)]).toEqual(before);
    expect(placed(after, blogs).props.category).toBeUndefined();
    expect(placed(after, journals).props.category).toBe('News');
  });

  it('rewrites the key code converted from a design reads its posts by, and refuses for code that is not the project’s', () => {
    const s = structuredClone(blog());
    const key = JSON.stringify(JSON.stringify(['', 'news', '', 3, 24]));
    s.components['project.code'] = codeDesign('project.code', 'Latest news', `<script>\n\tlet { so_pages } = $props();\n\tconst rows = so_pages?.entries?.[${key}] ?? [];\n\tconst again = so_pages?.entries?.[${key}];\n</script>\n`);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' });
    const renamedKey = JSON.stringify(JSON.stringify(['', 'studio-updates', '', 3, 24]));
    expect(after.components['project.code'].source).toBe(`<script>\n\tlet { so_pages } = $props();\n\tconst rows = so_pages?.entries?.[${renamedKey}] ?? [];\n\tconst again = so_pages?.entries?.[${renamedKey}];\n</script>\n`);
    // What the site hands the code under its new key is what it listed.
    expect(codeEntryQueries(after.components['project.code'].source!).map((q) => entryRows(after, q.query).map((r) => r.id))).toEqual([['en_kiln', 'en_glaze'], ['en_kiln', 'en_glaze']]);
    expect(termFeedUses(s, 'posts', 'categories', 'news')).toEqual([{ where: 'the code of “Latest news”' }]);
    expect(refused(s, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' })).toMatch(/the code of “Latest news” lists entries by “News”/);
    // A theme's code is never changed.
    const theirs = structuredClone(s);
    (theirs.components['project.code'] as { owner: string }).owner = 'theme';
    expect(refused(theirs, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' })).toMatch(/the code of “Latest news” lists entries by “news”/);
    // A new name with the same ID leaves what the code reads as it is.
    expect(run(theirs, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'NEWS' }).collections.posts.settings.taxonomies.categories.terms.news.label).toBe('NEWS');
  });

  it('is one change with the rest of its batch: a later edit naming the old ID undoes all of it', () => {
    const s = onHome(blog(), { category: 'News' }).s;
    const original = structuredClone(s);
    expect(
      refused(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', terms: { categories: ['news'] } })
    ).toMatch(/Categories has no term "news"/);
    expect(s).toEqual(original);
    // Filed under the old ID first, the post moves with the rest.
    const t = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', terms: { categories: ['news'] } }, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' });
    expect(t.collections.posts.entries.en_wheel.terms.categories).toEqual(['studio-updates']);
  });

  /** A collection loop on Home over the posts `where` keeps, and the IDs of the posts it lists. */
  const withLoop = (s: ProjectState, where: Array<Record<string, unknown>>) => {
    const r = applyOperations(s, [{ type: 'node.insert', owner: page(s.site.homePageId), parentId: null, primitive: 'repeat', query: { collectionId: 'posts', where } }]);
    return { s: r.state, loop: r.results[0].nodeId as string };
  };
  const loopQuery = (s: ProjectState, loop: string) => (s.pages[s.site.homePageId].nodes[loop] as RepeatNode).list as { $query: { where: Array<{ value: unknown }> } };
  const loopLists = (s: ProjectState, loop: string) => queryEntries(s, loopQuery(s, loop).$query).map((e) => e.id).sort();

  it('a collection loop filtering by the term follows it (#1523)', () => {
    const { s, loop } = withLoop(blog(), [{ field: 'categories', op: 'eq', value: 'news' }]);
    const before = loopLists(s, loop);
    expect(before).toEqual(['en_glaze', 'en_kiln']);
    const r = applyOperations(s, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }]);
    expect(r.results[0]).toMatchObject({ termId: 'studio-updates', feeds: 1 });
    expect(loopQuery(r.state, loop).$query.where[0].value).toBe('studio-updates');
    expect(loopLists(r.state, loop)).toEqual(before);
  });

  it('a loop naming the term by its label, among others, follows it and keeps the others (#1523)', () => {
    const { s, loop } = withLoop(blog(), [{ field: 'categories', op: 'in', value: ['NEWS', 'craft'] }]);
    const before = loopLists(s, loop);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' });
    expect(loopQuery(after, loop).$query.where[0].value).toEqual(['studio-updates', 'craft']);
    expect(loopLists(after, loop)).toEqual(before);
    // A loop filtering by a tag is left alone by a category's rename, and follows its own tag.
    const tagged = withLoop(after, [{ field: 'terms.tags', op: 'ne', value: 'Glaze' }]);
    const renamed = run(tagged.s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'tags', termId: 'glaze', label: 'Glazes' });
    expect(loopQuery(renamed, tagged.loop).$query.where[0].value).toBe('glazes');
    expect(loopLists(renamed, tagged.loop)).toEqual(loopLists(tagged.s, tagged.loop));
  });

  it('a loop filtering by the term keeps listing it when only its name changes (#1523)', () => {
    const named = run(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio news', newTermId: 'news' });
    const { s, loop } = withLoop(named, [{ field: 'categories', op: 'eq', value: 'Studio news' }]);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Latest news', newTermId: 'news' });
    expect(loopQuery(after, loop).$query.where[0].value).toBe('news');
    expect(loopLists(after, loop)).toEqual(['en_glaze', 'en_kiln']);
  });

  it('a loop in the posts layout, reading its own collection, follows the term however it spells the grouping (#1523)', () => {
    const owner: OwnerRef = { kind: 'template', id: 'posts' };
    const r = applyOperations(blog(), [{ type: 'node.insert', owner, parentId: null, primitive: 'repeat', query: { collectionId: '$current', where: [{ field: 'terms.categories', op: 'in', value: [' NEWS ', 'craft'] }] } }]);
    const loop = r.results[0].nodeId as string;
    const query = (s: ProjectState) => ((s.collections.posts.settings.template.nodes[loop] as RepeatNode).list as { $query: { where: Array<{ value: unknown }> } }).$query;
    const renamed = applyOperations(r.state, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }]);
    expect(renamed.results[0]).toMatchObject({ feeds: 1 });
    expect(query(renamed.state).where[0].value).toEqual(['studio-updates', 'craft']);
  });

  it('a list connected to the posts, filtering by the term, follows it (#1523)', () => {
    const s = structuredClone(blog());
    const def = projectDesign(s, {
      componentId: 'project.titles',
      name: 'Titles',
      properties: { items: P.list('Items', 'Item', { name: P.str('Name', 'Name') }, [{ name: 'Sample' }]) },
      parts: { root: { nodeId: 'root', label: 'Titles' } },
      build: (b) => b.el('root', 'ul', { name: 'Titles' }, [])
    });
    const owner = page(s.site.homePageId);
    const ins = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, definitionId: def.id }]);
    const id = ins.results[0].nodeId as string;
    const linked = run(ins.state, { type: 'instance.setListSource', owner, nodeId: id, prop: 'items', source: { query: { collectionId: 'posts', where: [{ field: 'categories', op: 'eq', value: 'News' }] }, fields: { name: 'title' } } });
    const r = applyOperations(linked, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }]);
    expect(r.results[0]).toMatchObject({ feeds: 1 });
    const query = (r.state.pages[r.state.site.homePageId].nodes[id] as InstanceNode).listSources!.items.query as { where: Array<{ value: unknown }> };
    expect(query.where[0].value).toBe('studio-updates');
  });

  it('a loop keeps the term it names when a rename gives another term its words (#1523)', () => {
    // “updates” names Craft by its name, until News is renamed to the ID "updates".
    const s0 = run(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'craft', label: 'Updates', newTermId: 'craft' });
    const { s, loop } = withLoop(s0, [{ field: 'categories', op: 'eq', value: 'updates' }]);
    const before = loopLists(s, loop);
    expect(before).toEqual(['en_glaze', 'en_wheel']);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Latest', newTermId: 'updates' });
    expect(loopQuery(after, loop).$query.where[0].value).toBe('craft');
    expect(loopLists(after, loop)).toEqual(before);
    // Words that named no term would come to name the renamed one, and the list would grow: refused.
    const dangling = withLoop(blog(), [{ field: 'categories', op: 'in', value: ['craft', 'Late News'] }]);
    expect(refused(dangling.s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'late news', newTermId: 'late' })).toMatch(/“Repeated items” in Home filters by “Late News”, which names no categories term now and would name “late news”/);
    // Beside words that already name the renamed term, they list nothing more: the rename goes ahead.
    const redundant = withLoop(blog(), [{ field: 'categories', op: 'in', value: ['news', ' News ', 'later'] }]);
    const kept = applyOperations(redundant.s, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Later' }]);
    expect(kept.results[0]).toMatchObject({ termId: 'later', feeds: 1 });
    expect(loopQuery(kept.state, redundant.loop).$query.where[0].value).toEqual(['later', 'later', 'later']);
    expect(loopLists(kept.state, redundant.loop)).toEqual(loopLists(redundant.s, redundant.loop));
  });
});

describe('lists of posts wherever they render', () => {
  const POSTS: OwnerRef = { kind: 'template', id: 'posts' };
  /** A grid in the Posts layout, its category read from each post's `field`. */
  function boundGrid(s: ProjectState, prop: 'category' | 'collection', field: string, props: Record<string, unknown> = {}) {
    const r = applyOperations(s, [{ type: 'node.insert', owner: POSTS, parentId: null, componentId: 'blog.grid', props }]);
    const nodeId = r.results[0].nodeId as string;
    return { s: run(r.state, { type: 'node.setBinding', owner: POSTS, nodeId, field: 'prop', prop, binding: { $entry: field } } as EditOperation), nodeId };
  }

  it('refuses a rename or delete that would change what a post’s own words choose, and lets a list of each post’s categories follow them', () => {
    // A layout grid whose category is the post's excerpt: the kiln post's lists News.
    let s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', excerpt: 'News' });
    s = boundGrid(s, 'category', 'excerpt').s;
    expect(refused(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates' })).toMatch(/“Post grid” in Posts layout reads its choice of entries where it is shown, which renaming “News” would change/);
    expect(refused(s, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' })).toMatch(/“Post grid” in Posts layout lists entries by “News”\. Choose something else there/);
    // A grid of each post's own categories (related posts) follows a rename, and a delete.
    const related = boundGrid(blog(), 'category', 'categories').s;
    const renamed = run(related, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates' });
    expect(renamed.collections.posts.settings.taxonomies.categories.terms).toHaveProperty('updates');
    expect(run(related, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' }).collections.posts.settings.taxonomies.categories.terms).not.toHaveProperty('news');
  });

  it('reads a design’s list in the collection whose layout places it, and refuses a rewrite that would break it in another', () => {
    let s = run(
      blog(),
      { type: 'collection.create', collectionId: 'journal', route: '/journal/', taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' } } } } },
      { type: 'entry.create', collectionId: 'journal', entryId: 'en_note', title: 'A note', publishedAt: '2026-01-01', draft: false, terms: { categories: ['news'] } }
    );
    s = onHome(s, {}).s;
    s = structuredClone(s);
    const grid = gridDef(s);
    // A design holding a grid of "news", with no collection of its own: it lists the news of the layout it is in.
    s.components['project.strip'] = {
      ...structuredClone(grid),
      id: 'project.strip',
      componentId: 'project.strip',
      kind: 'managed',
      owner: 'project',
      name: 'News strip',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: grid.id, props: { category: 'news' } } } }
    } as ComponentDefinition;
    const journalOnly = run(s, { type: 'node.insert', owner: { kind: 'template', id: 'journal' }, parentId: null, definitionId: 'project.strip' } as EditOperation);
    const strip = (st: ProjectState) => (st.components['project.strip'].tree!.nodes.inner as InstanceNode).props.category;
    // Renaming the blog's News leaves it; renaming the journal's rewrites it.
    expect(strip(run(journalOnly, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }))).toBe('news');
    expect(strip(run(journalOnly, { type: 'collection.renameTerm', collectionId: 'journal', taxonomyId: 'categories', termId: 'news', label: 'Notes' }))).toBe('notes');
    expect(termFeedUses(journalOnly, 'posts', 'categories', 'news')).toEqual([]);
    expect(termFeedUses(journalOnly, 'journal', 'categories', 'news')).toEqual([{ where: '“Post grid” in News strip' }]);
    // In both layouts, one stored word cannot keep both lists: the rename is refused.
    const both = run(journalOnly, { type: 'node.insert', owner: POSTS, parentId: null, definitionId: 'project.strip' } as EditOperation);
    expect(refused(both, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' })).toMatch(/“Post grid” in News strip lists entries by “news”/);
  });

  it('reads a list whose collection comes from each post in the collection each post names', () => {
    let s = run(
      blog(),
      { type: 'collection.create', collectionId: 'journal', route: '/journal/', taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' } } } } },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', excerpt: 'journal' }
    );
    s = boundGrid(s, 'collection', 'excerpt', { category: 'news' }).s;
    // On "Wheel basics" the grid lists the journal's news: a stored "news" cannot follow the blog's rename there.
    expect(refused(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' })).toMatch(/“Post grid” in Posts layout lists entries by “news”, which renaming “News” would change/);
  });

  it('renames a category on a site with lists of posts on its pages and related posts under each post', () => {
    let { s, nodeId } = onHome(blog(), { category: 'News' });
    s = boundGrid(s, 'category', 'categories').s;
    const before = listed(s, nodeId);
    const r = applyOperations(s, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' }]);
    expect(r.results[0]).toMatchObject({ termId: 'studio-updates', feeds: 1 });
    expect(listed(r.state, nodeId)).toEqual(before);
    // Only the list on Home holds a delete back; the related posts follow.
    expect(termFeedUses(r.state, 'posts', 'categories', 'studio-updates')).toEqual([{ where: '“Post grid” in Home' }]);
    expect(termFeedUses(r.state, 'posts', 'categories', 'craft')).toEqual([]);
    expect(run(r.state, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'craft' }).collections.posts.settings.taxonomies.categories.terms).not.toHaveProperty('craft');
  });

  it('refuses where a list reads its choice from each post, as a neighbour’s title, and reads one bound to a design’s property as the site does', () => {
    const neighbour = boundGrid(blog(), 'category', 'prevEntry.title').s;
    expect(refused(neighbour, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates' })).toMatch(/“Post grid” in Posts layout reads its choice of entries where it is shown/);
    expect(termFeedUses(neighbour, 'posts', 'categories', 'news')).toEqual([{ where: '“Post grid” in Posts layout' }]);
    // A tag rename never reaches a choice of category.
    expect(run(neighbour, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'tags', termId: 'glaze', label: 'Glazes' }).collections.posts.settings.taxonomies.tags.terms).toHaveProperty('glazes');
    // Bound to a design's own property, a grid's choice is its default where the site lists its rows: here the grid of
    // a design reading the journal, whose default "News" names the journal's News too.
    let s = run(
      onHome(blog(), {}).s,
      { type: 'collection.create', collectionId: 'journal', route: '/journal/', taxonomies: { categories: { label: 'Categories', terms: { notes: { label: 'News' } } } } },
      { type: 'entry.create', collectionId: 'journal', entryId: 'en_note', title: 'A note', publishedAt: '2026-01-01', draft: false, terms: { categories: ['notes'] } }
    );
    s = structuredClone(s);
    const custom: ComponentDefinition = { ...structuredClone(gridDef(s)), id: 'project.news-grid', componentId: 'project.news-grid', owner: 'project', name: 'News grid' };
    (custom.properties.category as { default: string }).default = 'News';
    s.components[custom.id] = custom;
    s.components['project.strip'] = {
      ...structuredClone(custom),
      id: 'project.strip',
      componentId: 'project.strip',
      kind: 'managed',
      name: 'Topic strip',
      properties: { topic: { type: 'string', label: 'Topic', default: 'Craft' } },
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: custom.id, props: { collection: 'journal', category: { $prop: 'topic' } } } } }
    } as ComponentDefinition;
    s = run(s, { type: 'node.insert', owner: page(s.site.homePageId), parentId: null, definitionId: 'project.strip' } as EditOperation);
    // The blog's News renamed would rewrite the default the journal's grid lists its News by: refused.
    expect(refused(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' })).toMatch(/“News grid” in Topic strip lists entries by “News”/);
  });

  it('reads a design wherever code that imports it is placed, as well as where it is placed itself', () => {
    let s = run(
      onHome(blog(), {}).s,
      { type: 'collection.create', collectionId: 'journal', route: '/journal/', taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' } } } } }
    );
    s = structuredClone(s);
    const grid = gridDef(s);
    s.components['project.inner'] = {
      ...structuredClone(grid),
      id: 'project.inner',
      componentId: 'project.inner',
      kind: 'managed',
      owner: 'project',
      name: 'Inner',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['g'] }, g: { id: 'g', kind: 'instance', definitionId: grid.id, props: { category: 'news' } } } }
    } as ComponentDefinition;
    s.components['project.outer'] = codeDesign('project.outer', 'Outer', `<script>\n\timport Inner from '.${defFile(s.components['project.inner']).slice(defFile(s.components['project.inner']).lastIndexOf('/'))}';\n\tlet { so_pages } = $props();\n</script>\n<Inner {so_pages} />\n`);
    s = run(s, { type: 'node.insert', owner: page(s.site.homePageId), parentId: null, definitionId: 'project.inner' } as EditOperation);
    s = run(s, { type: 'node.insert', owner: { kind: 'template', id: 'journal' }, parentId: null, definitionId: 'project.outer' } as EditOperation);
    // On Home "news" is the blog's News, in the journal's layout (through Outer) the journal's: one word for both.
    expect(refused(s, { type: 'collection.renameTerm', collectionId: 'journal', taxonomyId: 'categories', termId: 'news', label: 'Notes' })).toMatch(/“Post grid” in Inner lists entries by “news”/);
  });

  it('refuses a name with a comma, which a list of posts would read as two', () => {
    expect(refused(blog(), { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News, Craft' })).toMatch(/can't have a comma/);
    expect(refused(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'craft', label: 'Arts, Culture' })).toMatch(/can't have a comma/);
  });

  it('rewrites each key of a design’s code once, never one rewrite over another', () => {
    // "updates" names Bulletin by its name; the rename gives News the ID "updates".
    let s = run(blog(), { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates', termId: 'bulletin' });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', terms: { categories: ['craft', 'bulletin'] } });
    s = structuredClone(s);
    const key = (category: string) => JSON.stringify(JSON.stringify(['', category, '', 3, 24]));
    s.components['project.code'] = codeDesign('project.code', 'Two lists', `<script>\n\tlet { so_pages } = $props();\n\tconst a = so_pages?.entries?.[${key('news')}];\n\tconst b = so_pages?.entries?.[${key('updates')}];\n\tconst c = [...so_pages?.entries?.[${key('news')}] ?? []];\n</script>\n`);
    const before = codeEntryQueries(s.components['project.code'].source!).map((q) => entryRows(s, q.query).map((r) => r.id));
    expect(before).toEqual([['en_kiln', 'en_glaze'], ['en_wheel'], ['en_kiln', 'en_glaze']]);
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Latest', newTermId: 'updates' });
    const source = after.components['project.code'].source!;
    expect(codeEntryQueries(source).map((q) => [q.query.category, entryRows(after, q.query).map((r) => r.id)])).toEqual([
      ['updates', ['en_kiln', 'en_glaze']],
      ['bulletin', ['en_wheel']],
      ['updates', ['en_kiln', 'en_glaze']]
    ]);
    // Every read of a key is rewritten with it, a copy of its rows included.
    expect(source).toContain(`[...so_pages?.entries?.[${key('updates')}] ?? []]`);
    // A key the code also keeps some other way is never rewritten from under that use.
    const kept = structuredClone(s);
    kept.components['project.code'] = codeDesign('project.code', 'Two lists', `<script>\n\tlet { so_pages } = $props();\n\tconst a = so_pages?.entries?.[${key('news')}];\n\tconst feeds = so_pages?.entries;\n\tconst b = feeds?.[${key('news')}];\n</script>\n`);
    expect(refused(kept, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Latest' })).toMatch(/the code of “Two lists” lists entries by “news”/);
  });

  it('never lets a new term’s name pick up another collection’s posts for a list that reads both', () => {
    let s = run(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'News', newTermId: 'bulletin' });
    s = run(
      s,
      { type: 'collection.create', collectionId: 'journal', route: '/journal/', taxonomies: { categories: { label: 'Categories', terms: { bulletin: { label: 'Bulletin' } } } } },
      { type: 'entry.create', collectionId: 'journal', entryId: 'en_note', title: 'A note', publishedAt: '2026-01-01', draft: false, terms: { categories: ['bulletin'] } }
    );
    s = onHome(s, {}).s;
    s = structuredClone(s);
    const grid = gridDef(s);
    // Placed nowhere, the design may show anywhere: in the blog "news" is Bulletin by its name, in the journal nothing.
    s.components['project.strip'] = {
      ...structuredClone(grid),
      id: 'project.strip',
      componentId: 'project.strip',
      kind: 'managed',
      owner: 'project',
      name: 'News strip',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: grid.id, props: { category: 'news' } } } }
    } as ComponentDefinition;
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News!' })).toMatch(/“Post grid” in News strip lists entries by “news”, which a term called “News!” would change/);
  });

  it('reads a literal choice beside a bound one, even in a layout with no entries yet', () => {
    let s = run(blog(), { type: 'collection.create', collectionId: 'journal', route: '/journal/' });
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'template', id: 'journal' }, parentId: null, componentId: 'blog.grid', props: { collection: 'posts', category: 'news' } }]);
    s = run(r.state, { type: 'node.setBinding', owner: { kind: 'template', id: 'journal' }, nodeId: r.results[0].nodeId as string, field: 'prop', prop: 'tag', binding: { $entry: 'excerpt' } } as EditOperation);
    expect(refused(s, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' })).toMatch(/“Post grid” in Journal layout lists entries by “News”/);
  });

  it('never gathers up posts still filed under an ID no term has', () => {
    const s = structuredClone(blog());
    s.collections.posts.entries.en_wheel.terms.categories = ['updates'];
    const r = applyOperations(s, [{ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates' }]);
    expect(r.results[0]).toMatchObject({ termId: 'updates-2', affectedPosts: 3 });
    expect(entriesWithTerm(r.state.collections.posts, 'categories', 'updates-2').map((e) => e.id).sort()).toEqual(['en_glaze', 'en_kiln', 'en_secret']);
    expect(result(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates' })).toMatchObject({ termId: 'updates-2' });
    expect(refused(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates', termId: 'updates' })).toMatch(/still filed under "updates"/);
  });

  it('keeps a list on its term when a new term takes the ID or name its words read, and lets a list pick up a name it was waiting for', () => {
    // "news" names Bulletin by its name; a new term would take the ID "news".
    let s = run(blog(), { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'News', newTermId: 'bulletin' });
    let byName: string;
    ({ s, nodeId: byName } = onHome(s, { category: 'news' }));
    const before = listed(s, byName);
    expect(before).toEqual(['en_kiln', 'en_glaze']);
    const r = applyOperations(s, [{ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News!' }]);
    expect(r.results[0]).toMatchObject({ termId: 'news' });
    expect(listed(r.state, byName)).toEqual(before);
    expect(placed(r.state, byName).props.category).toBe('bulletin');
    // A list told to show "Updates" before there was one shows the new term.
    let waiting: string;
    ({ s, nodeId: waiting } = onHome(blog(), { category: 'Updates' }));
    const t = run(s, { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', terms: { categories: ['updates'] } });
    expect(placed(t, waiting).props.category).toBe('Updates');
    expect(listed(t, waiting)).toEqual(['en_wheel']);
  });

  it('keeps the words a placement read from a design’s default where it lists another collection that has no such term', () => {
    let s = onHome(blog(), {}).s;
    s = run(s, { type: 'collection.create', collectionId: 'journal', route: '/journal/' });
    s = structuredClone(s);
    const custom: ComponentDefinition = { ...structuredClone(gridDef(s)), id: 'project.news-grid', componentId: 'project.news-grid', owner: 'project', name: 'News grid' };
    (custom.properties.category as { default: string }).default = 'News';
    s.components[custom.id] = custom;
    const r = applyOperations(s, [{ type: 'node.insert', owner: page(s.site.homePageId), definitionId: custom.id, props: { collection: 'journal' } }]);
    s = structuredClone(r.state);
    const journals = r.results[0].nodeId as string;
    delete placed(s, journals).props.category;
    const after = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' });
    expect(after.components[custom.id].properties.category).toMatchObject({ default: 'studio-updates' });
    expect(placed(after, journals).props.category).toBe('News');
  });

  it('refuses words a list’s property cannot take', () => {
    let s = onHome(blog(), {}).s;
    s = structuredClone(s);
    const custom: ComponentDefinition = { ...structuredClone(gridDef(s)), id: 'project.pick', componentId: 'project.pick', owner: 'project', name: 'Picked grid' };
    custom.properties.category = { type: 'enum', label: 'Category', options: [{ value: 'news', label: 'News' }, { value: 'craft', label: 'Craft' }], default: 'news' } as ComponentDefinition['properties'][string];
    s.components[custom.id] = custom;
    expect(refused(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio updates' })).toMatch(/the default of “Picked grid” lists entries by “news”/);
  });
});

describe('deleting a term', () => {
  it('takes it off every post filed under it and says how many', () => {
    const r = applyOperations(blog(), [{ type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' }]);
    expect(r.results[0]).toMatchObject({ termId: 'news', affectedPosts: 3 });
    const c = r.state.collections.posts;
    expect(Object.keys(c.settings.taxonomies.categories.terms)).toEqual(['craft']);
    expect(c.entries.en_glaze.terms).toEqual({ categories: ['craft'], tags: ['glaze'] });
    // A post left with none of a grouping's terms has none of that grouping, drafts too.
    expect(c.entries.en_kiln.terms).toEqual({});
    expect(c.entries.en_secret.terms).toEqual({});
    expect(refused(blog(), { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'gone' })).toMatch(/has no term "gone"/);
  });

  it('is refused while a list of posts chooses it, alone or among others, and allowed once none does', () => {
    let { s, nodeId } = onHome(blog(), { category: 'Craft, News' });
    expect(termFeedUses(s, 'posts', 'categories', 'news')).toEqual([{ where: '“Post grid” in Home' }]);
    expect(termFeedUses(s, 'posts', 'categories', 'craft')).toHaveLength(1);
    expect(termFeedUses(s, 'posts', 'tags', 'glaze')).toEqual([]);
    expect(refused(s, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' })).toMatch(/“Post grid” in Home lists entries by “News”\. Choose something else there before deleting it\./);
    s = run(s, { type: 'instance.setProp', owner: page(s.site.homePageId), nodeId, prop: 'category', value: 'craft' } as EditOperation);
    expect(run(s, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' }).collections.posts.settings.taxonomies.categories.terms).not.toHaveProperty('news');
    // Nor while a design's default chooses it, placed or not.
    const d = structuredClone(s);
    const custom: ComponentDefinition = { ...structuredClone(gridDef(d)), id: 'project.news-grid', componentId: 'project.news-grid', owner: 'project', name: 'News grid' };
    (custom.properties.category as { default: string }).default = 'News';
    d.components[custom.id] = custom;
    expect(refused(d, { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' })).toMatch(/the default of “News grid” lists entries by “News”/);
  });
});

describe('the term operations', () => {
  it('validate, and are the editor’s alone', () => {
    for (const op of [
      { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News' },
      { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates' },
      { type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news' }
    ])
      expect(validateOperation(op).ok).toBe(true);
    expect(validateOperation({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News', termId: 'bulletin' })).toMatchObject({ ok: true, op: { termId: 'bulletin' } });
    expect(validateOperation({ type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Updates', newTermId: 'notes' })).toMatchObject({ ok: true, op: { newTermId: 'notes' } });
    expect(validateOperation({ type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: '' }).ok).toBe(false);
    expect(validateOperation({ type: 'collection.removeTerm', collectionId: 'posts', taxonomyId: 'categories', termId: '__proto__' }).ok).toBe(false);
    const offered = JSON.stringify([toolDefinitions(), toolDefinitions({ codeEnabled: true, definitionOps: true })]);
    expect(offered).not.toContain('collection.createTerm');
    expect(offered).not.toContain('collection.renameTerm');
    expect(offered).not.toContain('collection.removeTerm');
  });
});
