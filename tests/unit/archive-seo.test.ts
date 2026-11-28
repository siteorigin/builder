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
import { generateProject, liveRedirects, publishedState } from '@generator/index';
import { generateHostRedirects } from '@generator/host-redirects';
import { validateState } from '@engine/validate';
import { redirectSourceProblem } from '@shared/redirects';
import { checkHeld, fieldKey, placeOf, readFields, shownField } from '../../src/renderer/src/lib/held';

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
    expect(readFields(s, [news])).toEqual([{ found: true, value: { categoryDescription: 'Old.', category: 'News' } }]);
    expect(shownField(news, readFields(s, [news])![0].found ? (readFields(s, [news])![0] as { value: unknown }).value : null)).toBe('Old.');
    expect(placeOf(s, news)).toBe('News archive of Posts');
    expect(readFields(s, [index])).toEqual([{ found: true, value: { description: '' } }]);
    expect(fieldKey([news])).not.toBe(fieldKey([craft]));
    // Changed meanwhile, it is a conflict, not overwritten; another category's change is not.
    const base = readFields(s, [news])!.map((r) => (r.found ? r.value : undefined));
    const elsewhere = run(s, { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'craft', description: 'Theirs.' } });
    expect(checkHeld(elsewhere, [news], base).kind).toBe('apply');
    const changed = run(s, { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'Theirs.' } });
    expect(checkHeld(changed, [news], base).kind).toBe('changed');
    // Another category given its ID meanwhile is not the one it was typed for.
    const swapped = run(
      s,
      { type: 'collection.renameTerm', collectionId: 'posts', taxonomyId: 'categories', termId: 'news', label: 'Studio news' },
      { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'Updates', termId: 'news' } as EditOperation,
      { type: 'collection.update', collectionId: 'posts', categoryDescription: { termId: 'news', description: 'Old.' } }
    );
    expect(checkHeld(swapped, [news], base).kind).toBe('changed');
    // Other settings of a collection are never held.
    expect(readFields(s, [{ type: 'collection.update', collectionId: 'posts', pageSize: 3 }])).toBeNull();
  });
});

describe('a collection that moves (#1548)', () => {
  it('keeps its index, its later pages and its category archives working at their old addresses', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 1 });
    const moved = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/repair-notes/' });
    const live = liveRedirects(publishedState(moved));
    const sent = Object.fromEntries(live.map((r) => [r.from, r.to]));
    expect(sent).toMatchObject({
      '/blog/': '/journal/repair-notes/',
      '/blog/page/2/': '/journal/repair-notes/page/2/',
      '/blog/page/3/': '/journal/repair-notes/page/3/',
      '/blog/category/news/': '/journal/repair-notes/category/news/',
      '/blog/category/news/page/2/': '/journal/repair-notes/category/news/page/2/',
      '/blog/category/craft/': '/journal/repair-notes/category/craft/',
      // The entries' own addresses still follow them.
      '/blog/new-kiln/': '/journal/repair-notes/new-kiln/'
    });
    const out = files(moved);
    expect(out.has(route('/journal/repair-notes/category/news/page/2/'))).toBe(true);
    expect(out.get(route('/blog/category/news/'))).toContain('/journal/repair-notes/category/news/');
    // A category's later page is deeper than a page can be, and is kept all the same, with its HTTP 301 rule.
    expect(out.get(route('/blog/category/news/page/2/'))).toContain('/journal/repair-notes/category/news/page/2/');
    expect(generateHostRedirects(publishedState(moved))).toContain('/blog/category/news/page/2/ /journal/repair-notes/category/news/page/2/ 301');
    expect(validateState(moved).filter((d) => d.code.startsWith('REDIRECT') || d.code.startsWith('ROUTE'))).toEqual([]);
    // An author can keep one that deep working too.
    const own = run(moved, { type: 'redirect.add', from: '/journal/old/category/news/page/2/', to: '/journal/repair-notes/' });
    expect(liveRedirects(own).map((r) => r.from)).toContain('/journal/old/category/news/page/2/');
  });

  it('sends every old address straight to the newest one, past a page later put at an address it passed through', () => {
    let s = run(blog(), { type: 'redirect.add', from: '/latest/', to: '/blog/category/news/' });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/notes/' });
    s = run(s, { type: 'page.create', pageId: 'pg_journal1', title: 'Journal', route: '/journal/' });
    const sent = Object.fromEntries(liveRedirects(s).map((r) => [r.from, [r.to, r.hops]]));
    expect(sent['/blog/']).toEqual(['/notes/', 0]);
    expect(sent['/blog/category/news/']).toEqual(['/notes/category/news/', 0]);
    expect(sent['/journal/category/news/']).toEqual(['/notes/category/news/', 0]);
    // The author's own redirect is left as they wrote it, and arrives through the category's old address.
    expect(s.site.redirects).toContainEqual({ from: '/latest/', custom: true, to: '/blog/category/news/' });
    expect(sent['/latest/']).toEqual(['/notes/category/news/', 1]);
    // The page holds its address; the index's old address there is left out.
    expect(sent['/journal/']).toBeUndefined();
    expect(s.pages.pg_journal1.route).toBe('/journal/');
  });

  it('keeps only the archive pages visitors had as the batch began, and leaves them with the collection', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' }, { type: 'collection.update', collectionId: 'posts', route: '/notes/' });
    const archived = (t: ProjectState) => (t.site.redirects ?? []).filter((r) => r.archiveOf === 'posts').map((r) => [r.from, r.to]);
    expect(archived(s)).toEqual([
      ['/blog/', '/notes/'],
      ['/blog/category/news/', '/notes/category/news/'],
      ['/blog/category/craft/', '/notes/category/craft/']
    ]);
    // Moving back takes its old addresses back, and keeps the ones it leaves.
    expect(archived(run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' }))).toEqual([
      ['/notes/', '/blog/'],
      ['/notes/category/news/', '/blog/category/news/'],
      ['/notes/category/craft/', '/blog/category/craft/']
    ]);
    // Removed, the collection takes them with it.
    const gone = run(s, { type: 'collection.remove', collectionId: 'posts' });
    expect(archived(gone)).toEqual([]);
    // Passing back through an old address in a batch keeps it, sent on to where the batch leaves the collection.
    expect(archived(run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' }, { type: 'collection.update', collectionId: 'posts', route: '/later/' })).sort()).toEqual([
      ['/blog/', '/later/'],
      ['/blog/category/craft/', '/later/category/craft/'],
      ['/blog/category/news/', '/later/category/news/'],
      ['/notes/', '/later/'],
      ['/notes/category/craft/', '/later/category/craft/'],
      ['/notes/category/news/', '/later/category/news/']
    ]);
  });

  it('sends an old address of a page gone for a while on to that page again once it is back', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2 });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    s = run(s, { type: 'collection.update', collectionId: 'posts', pageSize: 5 });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/notes/' });
    expect(s.site.redirects).toContainEqual({ from: '/blog/page/2/', to: '/notes/page/2/', archiveOf: 'posts' });
    // Gone for now: nothing is there to send visitors to, and Project health says so.
    expect(liveRedirects(s).map((r) => r.from)).not.toContain('/blog/page/2/');
    expect(validateState(s).filter((d) => d.code === 'REDIRECT_PATH_MISSING').map((d) => d.message)).toEqual([expect.stringContaining('/blog/page/2/ sends visitors to /notes/page/2/')]);
    s = run(s, { type: 'collection.update', collectionId: 'posts', pageSize: 2 });
    expect(Object.fromEntries(liveRedirects(s).map((r) => [r.from, r.to]))['/blog/page/2/']).toBe('/notes/page/2/');
  });

  it('sends the old addresses on when the collection moves with its archive off, and keeps them when saved as they are', () => {
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/notes/', pages: { detail: true, archive: false } });
    s = run(s, { type: 'collection.update', collectionId: 'posts', pages: { detail: true, archive: true } });
    expect(s.site.redirects).toContainEqual({ from: '/blog/', to: '/notes/', archiveOf: 'posts' });
    // Saved again with the same destination in Redirects, it is still the collection's: moving back takes it back.
    s = run(s, { type: 'redirect.update', from: '/blog/', to: '/notes/' });
    expect(s.site.redirects).toContainEqual({ from: '/blog/', to: '/notes/', archiveOf: 'posts' });
    const back = run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' });
    expect(back.collections.posts.settings.route).toBe('/blog/');
    expect((back.site.redirects ?? []).map((r) => r.from)).not.toContain('/blog/');
    // Sent somewhere else, it is the author's.
    expect(run(s, { type: 'redirect.update', from: '/blog/', to: '/about/' }).site.redirects).toContainEqual({ from: '/blog/', to: '/about/' });
  });

  it('leaves an old address as it is when its archive is off and sending it on would loop or leave it nowhere', () => {
    const off = { detail: true, archive: false };
    let s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' }, { type: 'redirect.add', from: '/notes/', to: '/blog/' });
    // /notes/ already sends visitors to /blog/: /blog/ sent on to /notes/ would go round.
    const looped = run(s, { type: 'collection.update', collectionId: 'posts', route: '/notes/', pages: off });
    expect(looped.site.redirects).toContainEqual({ from: '/blog/', to: '/journal/', archiveOf: 'posts' });
    // Back at /blog/ with the archive off, nothing answers there: the address is kept, and followed when it moves on.
    s = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/', pages: off });
    expect(s.site.redirects).toContainEqual({ from: '/blog/', to: '/journal/', archiveOf: 'posts' });
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/notes/' });
    expect(s.site.redirects).toContainEqual({ from: '/blog/', to: '/notes/', archiveOf: 'posts' });
  });

  it('gives a collection made again under a removed one’s ID in the same batch none of its old addresses', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 1 });
    const t = run(
      s,
      { type: 'collection.remove', collectionId: 'posts' },
      { type: 'collection.create', collectionId: 'posts', route: '/blog/' } as EditOperation,
      { type: 'collection.update', collectionId: 'posts', route: '/journal/' }
    );
    expect((t.site.redirects ?? []).filter((r) => r.archiveOf)).toEqual([]);
  });

  it('keeps the collection’s mark on its old addresses in the website a draft is left out of, and refuses one too deep', () => {
    const s = run(blog(), { type: 'entry.create', collectionId: 'posts', entryId: 'en_draft', title: 'Draft', body: ['Soon.'] } as EditOperation, { type: 'collection.update', collectionId: 'posts', route: '/journal/' });
    expect(publishedState(s).site.redirects).toContainEqual({ from: '/blog/', to: '/journal/', archiveOf: 'posts' });
    expect(() => run(s, { type: 'redirect.add', from: '/a/b/c/d/e/f/g/h/', to: '/journal/' })).toThrow(/at most 7 levels/);
    expect(run(s, { type: 'redirect.add', from: '/a/b/c/d/e/f/g/', to: '/journal/' }).site.redirects).toContainEqual({ from: '/a/b/c/d/e/f/g/', custom: true, to: '/journal/' });
    expect(redirectSourceProblem(`/${Array.from({ length: 7 }, () => 'é'.repeat(50)).join('/')}/`)).toMatch(/too long/);
    expect(redirectSourceProblem(`/${Array.from({ length: 7 }, () => 'a'.repeat(60)).join('/')}/`)).toBeNull();
  });

  it('keeps no old address for a page the moved archive no longer has, and none while the archive is turned off', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2 });
    // Page 2 exists before the move; turning category archives off in the same change leaves no equivalents for them.
    const moved = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/', termArchives: false });
    expect((moved.site.redirects ?? []).filter((r) => r.archiveOf).map((r) => r.from)).toEqual(['/blog/', '/blog/page/2/']);
    const off = run(s, { type: 'collection.update', collectionId: 'posts', route: '/journal/', pages: { detail: true, archive: false } });
    expect((off.site.redirects ?? []).filter((r) => r.archiveOf)).toEqual([]);
  });
});
