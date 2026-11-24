/**
 * Blog feeds, archives and pagination (#397): sections that list a collection's published entries anywhere on the
 * site, newest first by publication date, and the static pages of a collection's index and category archives, a page
 * size at a time, with Previous and Next links between them.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ComponentDefinition, InstanceNode, ListProp, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { normalizePropSchema } from '@engine/schema';
import { validateState } from '@engine/validate';
import { generateProject, pageFile, publishedState, resolveInstanceProps } from '@generator/index';
import { pageLinks } from '@generator/archive';
import { GenerationCache } from '@generator/cache';
import { archivePages } from '@shared/archives';
import { entryQuery, entryRows } from '@shared/entry-feed';
import { upsertToolSchema } from '@agent/macros';
import { propSchemaSummary } from '@agent/context';
import { placedFeedRows } from '../../src/renderer/src/lib/model';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const page = (id: string): OwnerRef => ({ kind: 'page', id });
const POSTS: OwnerRef = { kind: 'template', id: 'posts' };

const PHOTO: AssetRecord = {
  id: 'a_kiln',
  name: 'Kiln',
  file: 'static/assets/kiln-1a2b3c4d.jpg',
  mime: 'image/jpeg',
  bytes: 10,
  width: 1200,
  height: 800,
  hash: 'h',
  kind: 'image',
  createdAt: '2026-01-01',
  description: 'The studio kiln',
  variants: [
    { width: 480, file: 'static/assets/kiln-1a2b3c4d-480w.jpg' },
    { width: 960, file: 'static/assets/kiln-1a2b3c4d-960w.jpg' }
  ]
} as AssetRecord;

const post = (entryId: string, title: string, publishedAt: string, extra: Record<string, unknown> = {}): EditOperation =>
  ({ type: 'entry.create', collectionId: 'posts', entryId, title, publishedAt, draft: false, body: [`${title}.`], ...extra }) as EditOperation;

/**
 * A studio blog: five published posts across two categories (one with a picture, one backdated before the rest), a
 * newer draft, and the editorial order set the other way round from the dates.
 */
function blog(): ProjectState {
  const start = createStarterState('business', 'Riverside Studio', false);
  start.site.language = 'en-GB';
  start.assets.assets[PHOTO.id] = PHOTO;
  let s = run(
    start,
    { type: 'site.update', baseUrl: 'https://example.com' },
    {
      type: 'collection.create',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' }, craft: { label: 'Craft' }, events: { label: 'Events' } } }, tags: { label: 'Tags', terms: { glaze: { label: 'Glaze' } } } }
    },
    post('en_kiln', 'New kiln', '2026-04-01', { author: 'Ana Ruiz', excerpt: 'A bigger kiln for bigger pots.', featuredImage: PHOTO.id, terms: { categories: ['news'] } }),
    post('en_glaze', 'Glaze night', '2026-03-10', { excerpt: 'Mix your own.', terms: { categories: ['craft'], tags: ['glaze'] } }),
    post('en_open', 'Open studio', '2026-02-20', { terms: { categories: ['news'] } }),
    post('en_wheel', 'Wheel basics', '2026-02-01', { terms: { categories: ['craft'] } }),
    post('en_first', 'Hello', '2026-01-05', { terms: { categories: ['news'] } }),
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_secret', title: 'Secret plans', publishedAt: '2026-05-01', body: ['Not yet.'], terms: { categories: ['events'] } } as EditOperation
  );
  // An editorial order oldest first: feeds and archives still go newest first by date.
  s = structuredClone(s);
  s.collections.posts.settings.entryOrder = ['en_first', 'en_wheel', 'en_open', 'en_glaze', 'en_kiln', 'en_secret'];
  return s;
}

/** A feed placed on Home, with its node ID. */
function onHome(s: ProjectState, componentId: string, props: Record<string, unknown> = {}) {
  const home = s.site.homePageId;
  const r = applyOperations(s, [{ type: 'node.insert', owner: page(home), componentId, props }]);
  return { s: r.state, home, nodeId: r.results[0].nodeId as string };
}

/** The feed's items as the website resolves them where it is placed. */
function items(s: ProjectState, pageId: string, nodeId: string) {
  const n = s.pages[pageId].nodes[nodeId] as InstanceNode;
  return resolveInstanceProps(s.components[n.definitionId], n, { state: s, pageId }).items as Array<Record<string, unknown>>;
}

const titles = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.title);
const route = (f: string) => `src/routes/${f.replace(/^\/|\/$/g, '')}/+page.svelte`;

describe('a blog feed on a page', () => {
  it('lists the newest published posts, whatever their editorial order, and never a draft', () => {
    const { s, home, nodeId } = onHome(blog(), 'blog.grid');
    expect(titles(items(s, home, nodeId))).toEqual(['New kiln', 'Glaze night', 'Open studio']);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const source = generateProject(publishedState(s)).get(pageFile(s.pages[home]))!;
    // Each card: its date in a <time>, its picture's sizes, its category, its excerpt and its entry's address.
    expect(source).toContain('"date":"2026-04-01"');
    expect(source).toContain('"dateLabel":"1 April 2026"');
    expect(source).toContain('kiln-1a2b3c4d-480w.jpg 480w');
    expect(source).toContain('"category":"News"');
    expect(source).toContain('"excerpt":"A bigger kiln for bigger pots."');
    expect(source).toContain('"href":"/blog/new-kiln/"');
    expect(source).not.toContain('Secret plans');
  });

  it('moves a backdated post down the list', () => {
    let { s, home, nodeId } = onHome(blog(), 'blog.list', { count: 3 });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_kiln', publishedAt: '2025-12-31' } as EditOperation);
    expect(titles(items(s, home, nodeId))).toEqual(['Glaze night', 'Open studio', 'Wheel basics']);
    // And a draft published moves in at its date.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false } as EditOperation);
    expect(titles(items(s, home, nodeId))).toEqual(['Secret plans', 'Glaze night', 'Open studio']);
  });

  it('shows one category or tag, named by its ID or its label, and nothing for a term the collection lacks', () => {
    const s = blog();
    const q = (props: Record<string, unknown>) => titles(entryRows(s, { collection: '', category: '', tag: '', ...props }) as never);
    expect(q({ category: 'craft' })).toEqual(['Glaze night', 'Wheel basics']);
    expect(q({ category: 'News', count: 2 })).toEqual(['New kiln', 'Open studio']);
    expect(q({ tag: 'glaze' })).toEqual(['Glaze night']);
    expect(q({ category: 'craft', tag: 'Glaze' })).toEqual(['Glaze night']);
    expect(q({ category: 'pottery' })).toEqual([]);
    expect(q({ collection: 'events' })).toEqual([]);
    // A count of 0 shows nothing; the featured post shows one.
    expect(q({ count: 0 })).toEqual([]);
    const featured = onHome(s, 'blog.featured', { category: 'craft' });
    expect(titles(items(featured.s, featured.home, featured.nodeId))).toEqual(['Glaze night']);
  });

  it('reads what a placement chose from its own properties, or their defaults', () => {
    const s = onHome(blog(), 'blog.grid', { category: 'news' }).s;
    const def = Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;
    expect(entryQuery(def.properties, { category: 'news' })).toEqual({ collection: '', category: 'news', tag: '', count: 3 });
    // A value bound from further out counts as unset.
    expect(entryQuery(def.properties, { count: { $prop: 'n' } })).toEqual({ collection: '', category: '', tag: '', count: 3 });
  });

  it('works inside a design that places it, as on the page', () => {
    const { s: placed } = onHome(blog(), 'blog.grid');
    const s = structuredClone(placed);
    const grid = Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;
    const wrapper: ComponentDefinition = {
      schemaVersion: 1,
      id: 'project.wrapper',
      componentId: 'project.wrapper',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Craft strip',
      description: '',
      category: 'custom',
      tags: [],
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: grid.id, props: { category: 'craft', heading: 'Craft notes' } } } }
    };
    s.components[wrapper.id] = wrapper;
    const home = s.site.homePageId;
    s.pages[home].nodes.n_wrapper = { id: 'n_wrapper', kind: 'instance', definitionId: wrapper.id, props: {} };
    s.pages[home].rootIds.push('n_wrapper');
    const files = generateProject(publishedState(s));
    const source = files.get(pageFile(s.pages[home]))!;
    expect(source).toMatch(/so_pages=\{\{"entries":\{"\[\\"\\",\\"craft\\",\\"\\",3,24\]":\[\{"id":"en_glaze"/);
    expect(source).toContain('"href":"/blog/wheel-basics/"');
    const design = [...files.values()].find((f) => f.includes('so_pages?.entries?.['))!;
    expect(design).toContain('so_pages?.entries?.["[\\"\\",\\"craft\\",\\"\\",3,24]"] ?? []');
    expect(design).not.toContain('Glaze night');
  });
});

describe('related posts in a collection’s layout', () => {
  it('lists the collection’s other posts on each post’s page, never the post itself', () => {
    const s = run(blog(), { type: 'node.insert', owner: POSTS, parentId: null, componentId: 'blog.grid', props: { heading: 'More from the studio' } } as EditOperation);
    const files = generateProject(publishedState(s));
    const kiln = files.get(route('/blog/new-kiln/'))!;
    const glaze = files.get(route('/blog/glaze-night/'))!;
    expect(kiln).toContain('More from the studio');
    expect(kiln).not.toContain('"title":"New kiln"');
    expect(kiln).toContain('"title":"Glaze night"');
    expect(glaze).toContain('"title":"New kiln"');
    expect(glaze).not.toContain('"title":"Glaze night"');
  });
});

describe('a collection’s index and category archives', () => {
  const sized = (n: number) => run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: n } as EditOperation);

  it('splits the index into pages of the page size, newest first, with Previous and Next between them', () => {
    const s = sized(2);
    const pages = archivePages(publishedState(s)).filter((p) => !p.category);
    expect(pages.map((p) => [p.route, p.entryIds])).toEqual([
      ['/blog/', ['en_kiln', 'en_glaze']],
      ['/blog/page/2/', ['en_open', 'en_wheel']],
      ['/blog/page/3/', ['en_first']]
    ]);
    const files = generateProject(publishedState(s));
    expect(files.has(route('/blog/page/1/'))).toBe(false);
    const first = files.get(route('/blog/'))!;
    const second = files.get(route('/blog/page/2/'))!;
    const last = files.get(route('/blog/page/3/'))!;
    expect(first).toContain(`<link rel="next" href={resolve("/blog/page/2/")} />`);
    expect(first).not.toContain('rel="prev"');
    expect(second).toContain(`<link rel="prev" href={resolve("/blog/")} />`);
    expect(second).toContain(`<link rel="next" href={resolve("/blog/page/3/")} />`);
    expect(last).not.toContain('<link rel="next"');
    // The page links: labelled, the current one marked, each to its page.
    expect(second).toContain('<nav class="so-archive__pages" aria-label={"Pages"}>');
    expect(second).toContain(`<a href={resolve("/blog/page/2/")} aria-label={"Page 2"} aria-current="page">2</a>`);
    expect(second).toContain(`<a class="so-archive__step" rel="prev" href={resolve("/blog/")}>{"Previous page"}</a>`);
    expect(second).toContain('<link rel="canonical" href={"https://example.com/blog/page/2/"} />');
    // Each card: its date, its title linking to its address, its category linking to that category's archive.
    expect(first).toContain('<time datetime="2026-04-01">{"1 April 2026"}</time>');
    expect(first).toContain(`<a href={resolve("/blog/new-kiln/")}>{"New kiln"}</a>`);
    expect(first).toContain(`<a href={resolve("/blog/category/news/")}>{"News"}</a>`);
    expect(first).toContain('kiln-1a2b3c4d-960w.jpg 960w');
    for (const t of [first, second, last]) expect(t).not.toContain('Secret plans');
    // Every page is in the sitemap.
    const sitemap = files.get('static/sitemap.xml')!;
    for (const r of ['/blog/', '/blog/page/2/', '/blog/page/3/', '/blog/category/news/', '/blog/category/craft/']) expect(sitemap).toContain(`<loc>https://example.com${r}</loc>`);
    expect(sitemap).not.toContain('/blog/category/events/');
  });

  it('gives each category with a published post an archive of its posts alone', () => {
    const s = sized(2);
    const files = generateProject(publishedState(s));
    const news = files.get(route('/blog/category/news/'))!;
    expect(news).toContain('{"News"}</h1>');
    expect(news).toContain('New kiln');
    expect(news).toContain('Open studio');
    expect(news).not.toContain('Glaze night');
    expect(news).toContain(`<link rel="next" href={resolve("/blog/category/news/page/2/")} />`);
    expect(files.get(route('/blog/category/news/page/2/'))).toContain('Hello');
    expect(files.get(route('/blog/category/craft/'))).toContain('Wheel basics');
    // Only a draft in it: no archive.
    expect(files.has(route('/blog/category/events/'))).toBe(false);
    // Turned off, the collection has its index alone.
    const off = run(s, { type: 'collection.update', collectionId: 'posts', categoryArchives: false } as EditOperation);
    expect(archivePages(publishedState(off)).filter((p) => p.category)).toEqual([]);
    expect(generateProject(publishedState(off)).get(route('/blog/'))).not.toContain('/blog/category/');
  });

  it('has an index before anything is published, saying so', () => {
    const s = run(createStarterState('business', 'Riverside Studio', false), { type: 'collection.create', collectionId: 'posts' } as EditOperation);
    expect(archivePages(s).map((p) => p.route)).toEqual(['/blog/']);
    expect(generateProject(s).get(route('/blog/'))).toContain('Nothing has been published here yet.');
  });

  it('keeps the page links short on a long blog', () => {
    expect(pageLinks(1, 3)).toEqual([1, 2, 3]);
    expect(pageLinks(6, 12)).toEqual([1, null, 4, 5, 6, 7, 8, null, 12]);
    expect(pageLinks(1, 12)).toEqual([1, 2, 3, null, 12]);
  });

  it('takes a page size from 1 to 100, and refuses anything else', () => {
    expect(validateOperation({ type: 'collection.update', collectionId: 'posts', pageSize: 0 }).ok).toBe(false);
    expect(() => run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2.5 } as EditOperation)).toThrow();
    expect(sized(100).collections.posts.settings.pageSize).toBe(100);
  });

  it('makes the right pages again in a cached run when a post is backdated across a page', () => {
    const cache = new GenerationCache();
    let s = sized(2);
    generateProject(publishedState(s), {}, cache);
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_kiln', publishedAt: '2025-12-31' } as EditOperation);
    const warm = generateProject(publishedState(s), {}, cache);
    const cold = generateProject(publishedState(s));
    expect([...warm.keys()].sort()).toEqual([...cold.keys()].sort());
    for (const [f, t] of cold) expect(warm.get(f), f).toBe(t);
    expect(warm.get(route('/blog/page/3/'))).toContain('New kiln');
    // A draft published, and a smaller page size, the same.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_secret', draft: false } as EditOperation, { type: 'collection.update', collectionId: 'posts', pageSize: 1 } as EditOperation);
    const again = generateProject(publishedState(s), {}, cache);
    const fresh = generateProject(publishedState(s));
    expect([...again.keys()].sort()).toEqual([...fresh.keys()].sort());
    for (const [f, t] of fresh) expect(again.get(f), f).toBe(t);
    expect(fresh.has(route('/blog/page/6/'))).toBe(true);
    expect(fresh.has(route('/blog/page/7/'))).toBe(false);
    expect(fresh.has(route('/blog/category/events/'))).toBe(true);
  });
});

describe('the addresses archives use', () => {
  it('keeps the archive folders for the collection: no page can take an address in them', () => {
    const s = blog();
    expect(() => run(s, { type: 'page.create', pageId: 'pg_p2', title: 'Two', route: '/blog/page/2/' } as EditOperation)).toThrow(/archive pages/);
    expect(() => run(s, { type: 'page.create', pageId: 'pg_cat', title: 'Cat', route: '/blog/category/news/' } as EditOperation)).toThrow(/archive pages/);
    // A post may still be called "page", and a page may sit beside the folders.
    expect(() => run(s, post('en_page', 'Page', '2026-01-01', { slug: 'page' }))).not.toThrow();
    expect(() => run(s, { type: 'page.create', pageId: 'pg_about', title: 'About the blog', route: '/blog-about/' } as EditOperation)).not.toThrow();
  });

  it('refuses a collection address whose archive folders something else uses', () => {
    const s = run(createStarterState('business', 'Riverside Studio', false), { type: 'page.create', pageId: 'pg_two', title: 'Two', route: '/news/page/2/' } as EditOperation);
    expect(() => run(s, { type: 'collection.create', collectionId: 'posts', route: '/news/' } as EditOperation)).toThrow(/archive pages/);
    const blogged = run(s, { type: 'collection.create', collectionId: 'posts', route: '/blog/' } as EditOperation);
    expect(() => run(blogged, { type: 'collection.create', collectionId: 'projects', route: '/blog/category/' } as EditOperation)).toThrow(/archive pages/);
    expect(() => run(blogged, { type: 'collection.update', collectionId: 'posts', route: '/news/' } as EditOperation)).toThrow(/archive pages/);
  });

  it('stops a series before an address a hand-edited project already uses, so no link leads elsewhere', () => {
    const s = structuredClone(run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2 } as EditOperation));
    const pg = structuredClone(Object.values(s.pages).find((p) => p.id !== s.site.homePageId)!);
    pg.id = 'pg_legacy';
    pg.route = '/blog/page/3/';
    s.pages[pg.id] = pg;
    s.site.pageOrder.push(pg.id);
    const index = archivePages(s).filter((p) => !p.category);
    expect(index.map((p) => p.route)).toEqual(['/blog/', '/blog/page/2/']);
    expect(index[1].next).toBeUndefined();
  });
});

describe('the entry feed in a definition', () => {
  it('needs fields of the types its rows fill', () => {
    const s = blog();
    expect(() => normalizePropSchema({ type: 'list', itemLabel: 'Post', fields: { image: { type: 'string', label: 'Image' } }, feed: 'entries' }, s, 'posts')).toThrow(/must be a image field/);
    expect(normalizePropSchema({ type: 'list', itemLabel: 'Post', fields: { title: { type: 'string', label: 'Title' }, image: { type: 'image', label: 'Picture' } }, feed: 'entries' }, s, 'posts')).toMatchObject({ feed: 'entries', default: [] });
  });
});

describe('the AI and the editor', () => {
  it('offers the post sections to the page tool once the project has a collection', () => {
    const sections = (s: ProjectState) => JSON.stringify(upsertToolSchema(s));
    expect(sections(createStarterState('business', 'Riverside Studio', false))).not.toContain('"blog.grid"');
    expect(sections(blog())).toContain('"blog.grid"');
    expect(sections(blog())).toContain('"blog.featured"');
  });

  it('describes an entry feed as filled from a collection, chosen by the placement', () => {
    const def = Object.values(onHome(blog(), 'blog.grid').s.components).find((d) => d.componentId === 'blog.grid')!;
    expect(JSON.stringify(propSchemaSummary(def.properties).items)).toContain("a collection's published entries");
  });

  it('gives a feed in a collection’s layout every row any entry’s page can show it with', () => {
    const s = run(blog(), { type: 'node.insert', owner: POSTS, parentId: null, componentId: 'blog.grid', props: { count: 2 } } as EditOperation);
    const n = Object.values(s.collections.posts.settings.template.nodes).find((x) => x.kind === 'instance' && s.components[x.definitionId]?.componentId === 'blog.grid') as InstanceNode;
    const def = s.components[n.definitionId];
    const rows = placedFeedRows(s, def.properties.items as ListProp, POSTS, def.properties, n.props);
    // Two on each entry's page, never that entry: the newest three between them.
    expect(rows.map((r) => r.id)).toEqual(['en_kiln', 'en_glaze', 'en_open']);
    // On a page, what the page shows.
    const placed = onHome(s, 'blog.grid', { count: 2 });
    const home = placed.s.pages[placed.home].nodes[placed.nodeId] as InstanceNode;
    expect(placedFeedRows(placed.s, def.properties.items as ListProp, page(placed.home), def.properties, home.props).map((r) => r.id)).toEqual(['en_kiln', 'en_glaze']);
  });
});
