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
import { generateLayout, generateProject, pageFile, publishedState, resolveInstanceProps, routeId } from '@generator/index';
import { pageLinks } from '@generator/archive';
import { GenerationCache } from '@generator/cache';
import { archivePages } from '@shared/archives';
import { entryQuery, entryRows, termsNamed } from '@shared/entry-feed';
import { withheldRoutes } from '../../src/main/export';
import { upsertToolSchema } from '@agent/macros';
import { retrieveExamples } from '@agent/examples';
import { TreeBuilder } from '@catalogue/dsl';
import { publicationPlan, sharedPageIds } from '@generator/checks';
import { thumbKey } from '../../src/main/runtime/component-thumbs';
import { projectSummary, propSchemaSummary } from '@agent/context';
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

describe('after the review', () => {
  const sized = (n: number) => run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: n } as EditOperation);
  /** A hand-edited project: a page at `route`, made before archive pages. */
  const legacyPage = (s: ProjectState, route: string, draft = false) => {
    const out = structuredClone(s);
    const pg = structuredClone(Object.values(out.pages).find((p) => p.id !== out.site.homePageId)!);
    Object.assign(pg, { id: 'pg_legacy', title: 'Legacy', route, ...(draft ? { draft: true } : {}) });
    out.pages[pg.id] = pg;
    out.site.pageOrder.push(pg.id);
    return out;
  };

  it('shows the author, and matches every filter at once', () => {
    const { s, home } = onHome(blog(), 'blog.grid');
    expect(generateProject(publishedState(s)).get(pageFile(s.pages[home]))).toContain('"byline":"Ana Ruiz"');
    const q = (props: Record<string, unknown>) => titles(entryRows(blog(), { collection: '', category: '', tag: '', ...props }) as never);
    expect(q({ category: 'News', tag: 'Glaze' })).toEqual([]);
    // Several categories, as a layout reads an entry's: any of them.
    expect(q({ category: 'News, Craft' })).toEqual(['New kiln', 'Glaze night', 'Open studio', 'Wheel basics', 'Hello']);
    const def = Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;
    expect(entryQuery(def.properties, { tag: ' glaze ', count: 7 })).toEqual({ collection: '', category: '', tag: 'glaze', count: 7 });
  });

  it('lists the posts in the same categories under each post, through the layout’s binding', () => {
    let s = run(blog(), { type: 'node.insert', owner: POSTS, parentId: null, componentId: 'blog.list', props: { heading: 'More like this' } } as EditOperation);
    const n = Object.values(s.collections.posts.settings.template.nodes).find((x) => x.kind === 'instance' && s.components[x.definitionId]?.componentId === 'blog.list')!;
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: n.id, field: 'prop', prop: 'category', binding: { $entry: 'categories' } } as EditOperation);
    const kiln = generateProject(publishedState(s)).get(route('/blog/new-kiln/'))!;
    expect(kiln).toContain('"title":"Open studio"');
    expect(kiln).toContain('"title":"Hello"');
    expect(kiln).not.toContain('"title":"Glaze night"');
    expect(kiln).not.toContain('"title":"New kiln"');
    // The editor shows the rows of the entry the canvas has the layout on, and its selection keeps every row any entry's page can show.
    const def = s.components[(n as InstanceNode).definitionId];
    const props = (s.collections.posts.settings.template.nodes[n.id] as InstanceNode).props;
    expect(placedFeedRows(s, def.properties.items as ListProp, POSTS, def.properties, props, { entryId: 'en_kiln', nodeId: n.id }).map((r) => r.id)).toEqual(['en_open', 'en_first']);
    expect(placedFeedRows(s, def.properties.items as ListProp, POSTS, def.properties, props).map((r) => r.id)).toEqual(['en_kiln', 'en_glaze', 'en_open', 'en_wheel', 'en_first']);
  });

  it('says so on a populated index, names each page link apart in any wording, and ends the links at the last page', () => {
    const s = sized(2);
    expect(generateProject(publishedState(s)).get(route('/blog/'))).not.toContain('Nothing has been published');
    const worded = run(s, { type: 'site.update', visitorText: { language: 'en', text: { archivePage: 'Page' } } } as EditOperation);
    const second = generateProject(publishedState(worded)).get(route('/blog/page/2/'))!;
    expect(second).toContain('aria-label={"Page 1"}');
    expect(second).toContain('aria-label={"Page 3"}');
    expect(pageLinks(12, 12)).toEqual([1, null, 10, 11, 12]);
  });

  it('refuses a page size over 100', () => {
    expect(validateOperation({ type: 'collection.update', collectionId: 'posts', pageSize: 101 }).ok).toBe(false);
    expect(() => run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 101 } as EditOperation)).toThrow(/1 to 100/);
  });

  it('keeps every address deeper in the archive folders, and refuses a collection whose folders hold an old address', () => {
    expect(() => run(blog(), { type: 'page.create', pageId: 'pg_deep', title: 'Deep', route: '/blog/category/news/more/' } as EditOperation)).toThrow(/archive pages/);
    const s = structuredClone(createStarterState('business', 'Riverside Studio', false));
    s.site.redirects = [{ from: '/news/page/2/', pageId: s.site.homePageId }];
    expect(() => run(s, { type: 'collection.create', collectionId: 'posts', route: '/news/' } as EditOperation)).toThrow(/archive pages/);
  });

  it('refuses a collection at another’s archive folder, whichever is made first', () => {
    const child = run(createStarterState('business', 'Riverside Studio', false), { type: 'collection.create', collectionId: 'projects', route: '/blog/category/' } as EditOperation);
    expect(() => run(child, { type: 'collection.create', collectionId: 'posts', route: '/blog/' } as EditOperation)).toThrow(/archive pages/);
  });

  it('refuses a move that would keep a published entry’s old address inside its own archive folders', () => {
    const s = run(
      createStarterState('business', 'Riverside Studio', false),
      { type: 'collection.create', collectionId: 'posts', route: '/blog/page/' } as EditOperation,
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_two', title: 'Two', slug: '2', publishedAt: '2026-01-01', draft: false, body: ['Two.'] } as EditOperation
    );
    expect(() => run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' } as EditOperation)).toThrow(/archive pages/);
  });

  it('never gives a collection’s index to another collection’s archive', () => {
    const s = structuredClone(blog());
    s.collections.child = structuredClone(s.collections.posts);
    s.collections.child.settings = { ...s.collections.child.settings, id: 'child', name: 'Child', route: '/blog/category/news/', entryOrder: undefined };
    s.collections.child.entries = {};
    const pages = archivePages(s);
    expect(pages.filter((p) => p.route === '/blog/category/news/').map((p) => p.collectionId)).toEqual(['child']);
    expect(pages.some((p) => p.collectionId === 'posts' && p.category === 'news')).toBe(false);
  });

  it('refuses to number a duplicate inside an archive folder, rather than trying forever', () => {
    const s = legacyPage(blog(), '/blog/page/2/');
    expect(() => run(s, { type: 'page.duplicate', pageId: 'pg_legacy' } as EditOperation)).toThrow(/archive pages/);
  });

  it('warns about a page made before archive pages inside their folders', () => {
    const s = legacyPage(sized(2), '/blog/page/3/', true);
    const found = validateState(s).filter((d) => d.code === 'ARCHIVE_ADDRESS_TAKEN');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', owner: { kind: 'collection', id: 'posts' } });
    expect(found[0].message).toMatch(/\/blog\/page\/3\/.*archive pages/);
  });

  it('hands the rows on to code converted from a design', () => {
    const { s: placed } = onHome(blog(), 'blog.grid');
    const s = structuredClone(placed);
    const grid = Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;
    s.components['project.wrapper'] = {
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
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: grid.id, props: { category: 'craft' } } } }
    } as ComponentDefinition;
    const home = s.site.homePageId;
    s.pages[home].nodes.n_wrapper = { id: 'n_wrapper', kind: 'instance', definitionId: 'project.wrapper', props: {} };
    s.pages[home].rootIds.push('n_wrapper');
    const code = run(s, { type: 'component.convertToCode', owner: page(home), nodeId: 'n_wrapper' } as EditOperation);
    const source = generateProject(publishedState(code)).get(pageFile(code.pages[home]))!;
    expect(source).toMatch(/so_pages=\{\{[^\n]*"entries":\{[^\n]*"title":"Glaze night"/);
    expect(source).toMatch(/so_pages=\{\{[^\n]*"title":"Wheel basics"/);
  });

  it('cannot detach a post list into fixed links', () => {
    const { s, home, nodeId } = onHome(blog(), 'blog.grid');
    expect(() => run(s, { type: 'component.detachInstance', owner: page(home), nodeId } as EditOperation)).toThrow(/cannot be detached/);
  });

  it('works out a layout’s post list as each entry’s page has it when checking links to drafts', () => {
    // A related list whose cards also link to a page kept as a draft: with one published post, its page lists no other.
    let s = run(
      createStarterState('business', 'Riverside Studio', false),
      { type: 'collection.create', collectionId: 'posts' } as EditOperation,
      post('en_only', 'Only post', '2026-01-01'),
      { type: 'page.create', pageId: 'pg_plans', title: 'Plans' } as EditOperation,
      { type: 'page.update', pageId: 'pg_plans', draft: true } as EditOperation
    );
    expect(s.pages.pg_plans.draft).toBe(true);
    const b = new TreeBuilder();
    const root = b.el('root', 'div', {}, [b.repeat('cards', 'items', [b.link('more', { type: 'page', target: 'pg_plans' }, { $item: 'title' }, 'plain')])]);
    s = structuredClone(s);
    s.components['project.related'] = {
      schemaVersion: 1,
      id: 'project.related',
      componentId: 'project.related',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Related',
      description: '',
      category: 'custom',
      tags: [],
      properties: { items: { type: 'list', label: 'Posts', itemLabel: 'Post', fields: { pageLink: { type: 'link', label: 'Post', default: { type: 'none', target: '' } }, title: { type: 'string', label: 'Title', default: '' } }, default: [], feed: 'entries' } },
      parts: { root: { nodeId: root, label: 'Root' } },
      tree: { rootIds: [root], nodes: b.nodes }
    } as ComponentDefinition;
    s = run(s, { type: 'node.insert', owner: POSTS, parentId: null, definitionId: 'project.related' } as EditOperation);
    expect(publicationPlan(s).draftLinks).toEqual([]);
    // A second post: each page now lists the other, whose card links to the draft.
    s = run(s, post('en_next', 'Next post', '2026-02-01'));
    expect(publicationPlan(s).draftLinks.length).toBeGreaterThan(0);
  });

  it('offers a header jump only to sections a collection’s index has too', () => {
    let s = createStarterState('business', 'Riverside Studio', false);
    const home = s.pages[s.site.homePageId];
    s = run(s, { type: 'node.setContent', owner: page(home.id), nodeId: home.rootIds[1], field: 'anchor', value: 'intro' } as EditOperation);
    s = structuredClone(s);
    for (const id of s.site.pageOrder) if (id !== home.id) s.pages[id].showHeader = false;
    expect(sharedPageIds(s, 'header').has('intro')).toBe(true);
    expect(sharedPageIds(run(s, { type: 'collection.create', collectionId: 'posts' } as EditOperation), 'header').has('intro')).toBe(false);
  });

  it('suggests and offers post sections only with a collection, of any name, and says what each collection can filter by', () => {
    const fresh = createStarterState('business', 'Riverside Studio', false);
    expect(retrieveExamples(fresh, 'latest blog posts').some((e) => e.componentId.startsWith('blog.'))).toBe(false);
    expect(retrieveExamples(blog(), 'latest blog posts').some((e) => e.componentId.startsWith('blog.'))).toBe(true);
    const projects = run(fresh, { type: 'collection.create', collectionId: 'projects' } as EditOperation);
    for (const id of ['blog.featured', 'blog.grid', 'blog.list']) expect(JSON.stringify(upsertToolSchema(projects))).toContain(`"${id}"`);
    expect(projectSummary(blog(), 1).collections).toEqual([
      { id: 'posts', name: 'Posts', route: '/blog/', published: 5, categories: { news: 'News', craft: 'Craft', events: 'Events' }, tags: { glaze: 'Glaze' } }
    ]);
    expect(projectSummary(fresh, 1)).not.toHaveProperty('collections');
  });

  it('pictures a saved component with a post list again when a post’s tags change', () => {
    const { s: placed } = onHome(blog(), 'blog.grid');
    const s = structuredClone(placed);
    const grid = Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;
    s.components['project.wrapper'] = {
      schemaVersion: 1,
      id: 'project.wrapper',
      componentId: 'project.wrapper',
      contractVersion: 1,
      kind: 'managed',
      owner: 'project',
      name: 'Glaze strip',
      description: '',
      category: 'custom',
      tags: [],
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Root' } },
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', definitionId: grid.id, props: { tag: 'glaze' } } } }
    } as ComponentDefinition;
    const before = thumbKey(s, 'project.wrapper');
    const after = thumbKey(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_wheel', terms: { tags: ['glaze'] } } as EditOperation), 'project.wrapper');
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

describe('after the focused review', () => {
  it('gives a draft made before archive pages no hold on their addresses, whether drafts are in the state or not', () => {
    const base = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2 } as EditOperation);
    const s = structuredClone(base);
    const pg = structuredClone(Object.values(s.pages).find((p) => p.id !== s.site.homePageId)!);
    Object.assign(pg, { id: 'pg_legacy', title: 'Legacy', route: '/blog/page/2/', draft: true });
    s.pages[pg.id] = pg;
    s.site.pageOrder.push(pg.id);
    const live = publishedState(s);
    const routes = (st: ProjectState) => archivePages(st).filter((p) => !p.category).map((p) => p.route);
    expect(routes(s)).toEqual(['/blog/', '/blog/page/2/', '/blog/page/3/']);
    expect(routes(live)).toEqual(routes(s));
    // The archive page is what the website and the preview have there, and the export does not count it as the draft's.
    expect(generateProject(s).get(route('/blog/page/2/'))).toContain('so-archive');
    // Only a file of its own at that address besides the archive's page (route.html) would show the draft.
    expect(withheldRoutes(s, live).find((r) => r.route === '/blog/page/2/')).toMatchObject({ archived: true });
    expect(validateState(s).find((d) => d.code === 'ARCHIVE_ADDRESS_TAKEN')?.message).toMatch(/can show one of them there instead/);
  });

  it('refuses a move whose kept addresses land in the archive folders, judged as the batch keeps them', () => {
    const s = run(
      createStarterState('business', 'Riverside Studio', false),
      { type: 'collection.create', collectionId: 'posts', route: '/blog/page/' } as EditOperation,
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_two', title: 'Two', slug: '2', publishedAt: '2026-01-01', draft: false, body: ['Two.'] } as EditOperation
    );
    // Turned into a draft and back within the move's batch, it was published at the start: its address is kept.
    expect(() =>
      run(
        s,
        { type: 'entry.update', collectionId: 'posts', entryId: 'en_two', draft: true } as EditOperation,
        { type: 'collection.update', collectionId: 'posts', route: '/blog/' } as EditOperation,
        { type: 'entry.update', collectionId: 'posts', entryId: 'en_two', draft: false } as EditOperation
      )
    ).toThrow(/archive pages/);
    // A draft at the start keeps no address: it may move, and be published in the same batch.
    const drafted = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_two', draft: true } as EditOperation);
    const moved = run(drafted, { type: 'entry.update', collectionId: 'posts', entryId: 'en_two', draft: false } as EditOperation, { type: 'collection.update', collectionId: 'posts', route: '/blog/' } as EditOperation);
    expect(moved.collections.posts.settings.route).toBe('/blog/');
    expect(moved.site.redirects ?? []).toEqual([]);
  });

  it('hands the rows on to code converted from a design that places another design with the feed', () => {
    const { s: placed } = onHome(blog(), 'blog.grid');
    const s = structuredClone(placed);
    const grid = Object.values(s.components).find((d) => d.componentId === 'blog.grid')!;
    const design = (id: string, inner: Record<string, unknown>): ComponentDefinition =>
      ({
        schemaVersion: 1,
        id,
        componentId: id,
        contractVersion: 1,
        kind: 'managed',
        owner: 'project',
        name: id,
        description: '',
        category: 'custom',
        tags: [],
        properties: {},
        parts: { root: { nodeId: 'root', label: 'Root' } },
        tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'element', tag: 'div', children: ['inner'] }, inner: { id: 'inner', kind: 'instance', props: {}, ...inner } } }
      }) as unknown as ComponentDefinition;
    s.components['project.inner'] = design('project.inner', { definitionId: grid.id, props: { category: 'craft' } });
    s.components['project.outer'] = design('project.outer', { definitionId: 'project.inner' });
    const home = s.site.homePageId;
    s.pages[home].nodes.n_outer = { id: 'n_outer', kind: 'instance', definitionId: 'project.outer', props: {} };
    s.pages[home].rootIds.push('n_outer');
    const code = run(s, { type: 'component.convertToCode', owner: page(home), nodeId: 'n_outer' } as EditOperation);
    const source = generateProject(publishedState(code)).get(pageFile(code.pages[home]))!;
    expect(source).toMatch(/so_pages=\{\{[^\n]*"entries":\{[^\n]*"title":"Glaze night"/);
  });

  it('matches a term whose label has a comma in it, among others', () => {
    const s = run(blog(), {
      type: 'collection.update',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { arts: { label: 'Arts, Culture' }, news: { label: 'News' } } }, tags: { label: 'Tags', terms: {} } }
    } as EditOperation);
    const c = s.collections.posts;
    expect(termsNamed(c, 'categories', 'Arts, Culture, News')).toEqual(['arts', 'news']);
    expect(termsNamed(c, 'categories', 'News, Arts, Culture')).toEqual(['news', 'arts']);
    expect(termsNamed(c, 'categories', 'Culture')).toEqual([]);
  });

  it('keeps every collection’s rows selectable in a layout whose feed reads its collection from the entry', () => {
    let s = run(blog(), { type: 'collection.create', collectionId: 'projects' } as EditOperation, { type: 'entry.create', collectionId: 'projects', entryId: 'en_barn', title: 'Barn', publishedAt: '2026-01-01', draft: false, body: ['Barn.'] } as EditOperation);
    s = run(s, { type: 'node.insert', owner: POSTS, parentId: null, componentId: 'blog.grid' } as EditOperation);
    const n = Object.values(s.collections.posts.settings.template.nodes).find((x) => x.kind === 'instance' && s.components[x.definitionId]?.componentId === 'blog.grid')!;
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: n.id, field: 'prop', prop: 'collection', binding: { $entry: 'excerpt' } } as EditOperation);
    const def = s.components[(n as InstanceNode).definitionId];
    const rows = placedFeedRows(s, def.properties.items as ListProp, POSTS, def.properties, (s.collections.posts.settings.template.nodes[n.id] as InstanceNode).props);
    expect(rows.map((r) => r.id)).toContain('en_barn');
    expect(rows.map((r) => r.id)).toContain('en_kiln');
  });
});

describe('after the last review', () => {
  const legacy = (s: ProjectState, extra: Record<string, unknown>) => {
    const out = structuredClone(s);
    const pg = structuredClone(Object.values(out.pages).find((p) => p.id !== out.site.homePageId)!);
    Object.assign(pg, { id: 'pg_legacy', title: 'Legacy', route: '/blog/page/2/', ...extra });
    out.pages[pg.id] = pg;
    out.site.pageOrder.push(pg.id);
    return out;
  };
  const sized = () => run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2 } as EditOperation);

  it('gives an old address leading nowhere no hold on an archive page, with or without drafts', () => {
    const s = structuredClone(sized());
    s.site.redirects = [{ from: '/blog/page/2/', pageId: 'pg_gone' }];
    const index = (st: ProjectState) => archivePages(st).filter((p) => !p.category).map((p) => p.route);
    expect(index(s)).toEqual(['/blog/', '/blog/page/2/', '/blog/page/3/']);
    expect(index(publishedState(s))).toEqual(index(s));
  });

  it('matches labels with commas however they are spaced, and stays quick on long lists of them', () => {
    const s = run(blog(), {
      type: 'collection.update',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { arts: { label: 'Arts,Culture' }, news: { label: 'News' } } }, tags: { label: 'Tags', terms: {} } }
    } as EditOperation);
    expect(termsNamed(s.collections.posts, 'categories', 'Arts,Culture, News')).toEqual(['arts', 'news']);
    expect(termsNamed(s.collections.posts, 'categories', 'Arts , Culture,News')).toEqual(['arts', 'news']);
    const terms = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`t${i}`, { label: `t${String(i).padStart(2, '0')}${','.repeat(77)}` }]));
    const many = run(blog(), { type: 'collection.update', collectionId: 'posts', taxonomies: { categories: { label: 'Categories', terms }, tags: { label: 'Tags', terms: {} } } } as EditOperation);
    const wanted = Object.values(terms)
      .map((t) => t.label)
      .join(', ');
    const started = Date.now();
    termsNamed(many.collections.posts, 'categories', wanted);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('takes a typed address an archive page answers at for the archive, not the draft it was', () => {
    let s = legacy(sized(), { draft: true });
    const home = s.pages[s.site.homePageId];
    const hero = home.nodes[home.rootIds[0]] as InstanceNode;
    s = run(s, { type: 'instance.setProp', owner: page(home.id), nodeId: hero.id, prop: 'primaryLink', value: { type: 'url', target: 'https://example.com/blog/page/2/' } } as EditOperation);
    expect(publicationPlan(s).draftLinks).toEqual([]);
  });

  it('shows the header, footer and site language on an archive page at a draft’s old address in the preview', () => {
    const s = legacy(sized(), { draft: true, showHeader: false, showFooter: false });
    const layout = generateLayout(s, { instrument: true });
    expect(layout).not.toContain(JSON.stringify(routeId('/blog/page/2/')));
  });

  it('hands rows on through code that places code made from a design', () => {
    const { s: placed } = onHome(blog(), 'blog.grid');
    const s = structuredClone(placed);
    const key = JSON.stringify(JSON.stringify(['', 'craft', '', 3, 24]));
    const code = (id: string, path: string, source: string) =>
      ({ schemaVersion: 1, id, componentId: id, contractVersion: 1, kind: 'code', owner: 'project', name: id, description: '', category: 'custom', tags: [], properties: {}, parts: { root: { nodeId: 'root', label: 'Root' } }, source, sourcePath: path }) as unknown as ComponentDefinition;
    s.components['project.inner'] = code('project.inner', 'src/lib/siteorigin/custom/Inner-x.svelte', `<script>\n\tlet { so_pages } = $props();\n\tconst rows = so_pages?.entries?.[${key}] ?? [];\n</script>\n<p>{rows.length}</p>\n`);
    s.components['project.outer'] = code('project.outer', 'src/lib/siteorigin/custom/Outer-x.svelte', `<script>\n\timport Inner from './Inner-x.svelte';\n\tlet { so_pages } = $props();\n</script>\n<Inner {so_pages} />\n`);
    const home = s.site.homePageId;
    s.pages[home].nodes.n_outer = { id: 'n_outer', kind: 'instance', definitionId: 'project.outer', props: {} };
    s.pages[home].rootIds.push('n_outer');
    const source = generateProject(publishedState(s)).get(pageFile(s.pages[home]))!;
    expect(source).toMatch(/so_pages=\{\{[^\n]*"entries":\{[^\n]*"title":"Glaze night"/);
  });
});
