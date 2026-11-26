/**
 * A collection's index and its category archives (#883) say what they are when they are found or shared, as every
 * page and entry does: a description (the author's, or a default), Open Graph and X (Twitter) card tags, and the
 * site's structured data with a trail from Home.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject, publishedState } from '@generator/index';
import { checkHeld, fieldKey, readFields } from '../../src/renderer/src/lib/held';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const route = (f: string) => `src/routes/${f.replace(/^\/|\/$/g, '')}/+page.svelte`;
const post = (entryId: string, title: string, publishedAt: string, categories: string[]): EditOperation =>
  ({ type: 'entry.create', collectionId: 'posts', entryId, title, publishedAt, draft: false, body: [`${title}.`], terms: { categories } }) as EditOperation;

function blog(baseUrl = 'https://example.com'): ProjectState {
  const start = createStarterState('business', 'Riverside Studio', false);
  start.site.language = 'en-GB';
  return run(
    start,
    { type: 'site.update', baseUrl } as EditOperation,
    {
      type: 'collection.create',
      collectionId: 'posts',
      taxonomies: { categories: { label: 'Categories', terms: { news: { label: 'News' }, craft: { label: 'Craft' } } } }
    } as EditOperation,
    post('en_kiln', 'New kiln', '2026-04-01', ['news']),
    post('en_glaze', 'Glaze night', '2026-03-10', ['craft']),
    post('en_open', 'Open studio', '2026-02-20', ['news'])
  );
}

const files = (s: ProjectState) => generateProject(publishedState(s));
/** The structured data a generated file carries, parsed. */
const graph = (source: string) => {
  const scripts = [...source.matchAll(/\{@html ("(?:[^"\\]|\\.)*")\}/g)].map((m) => JSON.parse(m[1]) as string).filter((html) => html.startsWith('<script type="application/ld+json">'));
  if (!scripts.length) return null;
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].replace(/^<script type="application\/ld\+json">|<\/script>$/g, '')) as { '@graph': Array<Record<string, unknown>> };
};

describe('a collection’s archive pages when found or shared', () => {
  it('give the index and each category page a description, sharing tags and structured data', () => {
    const out = files(blog());
    for (const r of ['/blog/', '/blog/category/news/']) {
      const source = out.get(route(r))!;
      expect(source).toMatch(/<meta name="description" content=\{"[^"]+"\} \/>/);
      expect(source).toMatch(/<meta property="og:description" content=\{"[^"]+"\} \/>/);
      expect(source).toContain('<meta name="twitter:card" content="summary" />');
      expect(source).toMatch(/<meta name="twitter:title" content=\{"[^"]+"\} \/>/);
      expect(source).toMatch(/<meta name="twitter:description" content=\{"[^"]+"\} \/>/);
      expect(source).toContain(`<link rel="canonical" href={"https://example.com${r}"} />`);
      const g = graph(source);
      expect(g).not.toBeNull();
      const page = g!['@graph'].find((n) => n['@id'] === `https://example.com${r}#webpage`);
      expect(page).toBeDefined();
      expect(page!['@type']).toEqual(['WebPage', 'CollectionPage']);
      expect(page!.description).toEqual(expect.any(String));
    }
  });

  it('use the description the author gave the collection and each category', () => {
    const s = run(
      blog(),
      { type: 'collection.update', collectionId: 'posts', description: 'Notes from the studio floor.' },
      { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'What is new at the studio.' } }
    );
    const out = files(s);
    for (const [r, text] of [
      ['/blog/', 'Notes from the studio floor.'],
      ['/blog/category/news/', 'What is new at the studio.']
    ]) {
      const source = out.get(route(r))!;
      for (const tag of ['name="description"', 'property="og:description"', 'name="twitter:description"']) expect(source).toContain(`<meta ${tag} content={${JSON.stringify(text)}} />`);
      expect(graph(source)!['@graph'].find((n) => n['@id'] === `https://example.com${r}#webpage`)!.description).toBe(text);
    }
    // The category's own words are not the index's, nor the other category's.
    expect(out.get(route('/blog/category/craft/'))).toContain('<meta name="description" content={"Posts filed under Craft, from Riverside Studio."} />');
    // Cleared, the index goes back to the site's description, then to a sentence naming the collection.
    const cleared = run(s, { type: 'collection.update', collectionId: 'posts', description: '' });
    expect(cleared.collections.posts.settings).not.toHaveProperty('description');
    const described = run(cleared, { type: 'site.update', description: 'A pottery studio by the river.' } as EditOperation);
    expect(files(described).get(route('/blog/'))).toContain('<meta name="description" content={"A pottery studio by the river."} />');
    const bare = structuredClone(cleared);
    bare.site.description = '';
    expect(files(bare).get(route('/blog/'))).toContain('<meta name="description" content={"Posts from Riverside Studio."} />');
  });

  it('say the same thing in every tag and in the structured data, with a trail from Home through the index', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 1 });
    const out = files(s);
    const news2 = out.get(route('/blog/category/news/page/2/'))!;
    const description = 'Posts filed under News, from Riverside Studio.';
    for (const tag of ['name="description"', 'property="og:description"', 'name="twitter:description"']) expect(news2).toContain(`<meta ${tag} content={${JSON.stringify(description)}} />`);
    expect(news2).toContain('<title>{"News – Page 2 of 2 · Riverside Studio"}</title>');
    expect(news2).toContain('<meta property="og:locale" content="en_GB" />');
    expect(news2).toContain('<link rel="canonical" href={"https://example.com/blog/category/news/page/2/"} />');
    const nodes = graph(news2)!['@graph'];
    const page = nodes.find((n) => n['@id'] === 'https://example.com/blog/category/news/page/2/#webpage')!;
    expect(page['@type']).toEqual(['WebPage', 'CollectionPage']);
    expect(page.description).toBe(description);
    const trail = nodes.find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement as Array<{ name: string; item: string }>;
    expect(trail.map((t) => [t.name, t.item])).toEqual([
      ['Home', 'https://example.com/'],
      ['Posts', 'https://example.com/blog/'],
      ['News', 'https://example.com/blog/category/news/'],
      ['News – Page 2 of 2', 'https://example.com/blog/category/news/page/2/']
    ]);
    const index = graph(out.get(route('/blog/'))!)!['@graph'];
    expect(index.find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement).toHaveLength(2);
    const index2 = graph(out.get(route('/blog/page/2/'))!)!['@graph'];
    expect((index2.find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement as Array<{ name: string }>).map((t) => t.name)).toEqual(['Home', 'Posts', 'Posts – Page 2 of 3']);
  });

  it('trail through the index of a collection whose address theirs is inside', () => {
    const s = run(
      blog(),
      { type: 'collection.update', collectionId: 'posts', route: '/news/blog/' },
      { type: 'collection.create', collectionId: 'news', name: 'News', route: '/news/' } as EditOperation,
      { type: 'entry.create', collectionId: 'news', entryId: 'en_note', title: 'A note', publishedAt: '2026-01-01', draft: false, body: ['Hi.'] } as EditOperation
    );
    const trail = graph(files(s).get(route('/news/blog/category/news/'))!)!['@graph'].find((n) => n['@type'] === 'BreadcrumbList')!.itemListElement as Array<{ name: string; item: string }>;
    expect(trail.map((t) => t.item)).toEqual(['https://example.com/', 'https://example.com/news/', 'https://example.com/news/blog/', 'https://example.com/news/blog/category/news/']);
  });

  it('keep their description and sharing tags without a public URL, leaving out what needs one', () => {
    const out = files(blog(''));
    const index = out.get(route('/blog/'))!;
    expect(index).toMatch(/<meta name="description" content=\{"[^"]+"\} \/>/);
    for (const r of ['/blog/', '/blog/category/news/']) {
      expect(out.get(route(r))).toMatch(/<meta property="og:description" content=\{"[^"]+"\} \/>/);
      expect(out.get(route(r))).toMatch(/<meta name="twitter:description" content=\{"[^"]+"\} \/>/);
    }
    expect(index).toContain('<meta name="twitter:card" content="summary" />');
    expect(index).not.toContain('rel="canonical"');
    expect(graph(index)).toBeNull();
  });

  it('write names as they are, braces and dollar signs too', () => {
    const s = run(
      blog(),
      { type: 'collection.update', collectionId: 'posts', name: 'Notes {site} $&' },
      { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'News {collection}', newTermId: 'news' }
    );
    const out = files(s);
    expect(out.get(route('/blog/category/news/'))).toContain(`<meta name="description" content={${JSON.stringify('Notes {site} $& filed under News {collection}, from Riverside Studio.')}} />`);
  });

  it('keep a category’s description through a rename and a change to the groupings, and clear it when emptied', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: '  What is new.  ' } });
    expect(s.collections.posts.settings.taxonomies.categories.terms.news).toEqual({ label: 'News', description: 'What is new.' });
    s = run(s, { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio news' });
    expect(s.collections.posts.settings.taxonomies.categories.terms['studio-news']).toEqual({ label: 'Studio news', description: 'What is new.' });
    const taxonomies = Object.fromEntries(
      Object.entries(s.collections.posts.settings.taxonomies).map(([id, t]) => [id, { label: t.label, terms: Object.fromEntries(Object.entries(t.terms).map(([tid, x]) => [tid, { label: x.label }])) }])
    );
    s = run(s, { type: 'collection.update', collectionId: 'posts', taxonomies });
    expect(s.collections.posts.settings.taxonomies.categories.terms['studio-news'].description).toBe('What is new.');
    s = run(s, { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'studio-news', description: ' ' }, description: '' });
    expect(s.collections.posts.settings.taxonomies.categories.terms['studio-news']).toEqual({ label: 'Studio news' });
    expect(s.collections.posts.settings).not.toHaveProperty('description');
    expect(() => run(s, { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'nope', description: 'x' } })).toThrow(/no category "nope"/);
  });

  it('hold a description typed while the AI ran as a field of its own, one per category', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'Old.' } });
    const news: EditOperation = { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'New.' } };
    const craft: EditOperation = { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'craft', description: 'Craft.' } };
    const index: EditOperation = { type: 'collection.update', collectionId: 'posts', description: 'Index.' };
    expect(readFields(s, [news])).toEqual([{ found: true, value: { categoryDescription: 'Old.' } }]);
    expect(readFields(s, [index])).toEqual([{ found: true, value: { description: '' } }]);
    expect(fieldKey([news])).not.toBe(fieldKey([craft]));
    // Changed meanwhile, it is a conflict, not overwritten; another category's change is not.
    const base = readFields(s, [news])!.map((r) => (r.found ? r.value : undefined));
    const elsewhere = run(s, { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'craft', description: 'Theirs.' } });
    expect(checkHeld(elsewhere, [news], base).kind).toBe('apply');
    const changed = run(s, { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'Theirs.' } });
    expect(checkHeld(changed, [news], base).kind).toBe('changed');
    // Other settings of a collection are never held.
    expect(readFields(s, [{ type: 'collection.update', collectionId: 'posts', pageSize: 3 }])).toBeNull();
  });
});
