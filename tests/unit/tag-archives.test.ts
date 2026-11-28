/**
 * Tags on the website (#1512): each tag with a published post has an archive of its own, as each category does
 * (`/blog/tag/<ID>/`, paginated), and a post's page shows its tags, each linking to its archive.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject, liveRedirects, publishedState } from '@generator/index';
import { archivePages, archiveWords, termArchiveKey, termArchiveRoutes } from '@shared/archives';
import { entryFieldValue, isLinkedForm } from '@shared/entry-fields';
import { siteLinks } from '@generator/checks';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const route = (f: string) => `src/routes/${f.replace(/^\/|\/$/g, '')}/+page.svelte`;
const post = (entryId: string, title: string, publishedAt: string, terms: Record<string, string[]>, extra: Record<string, unknown> = {}): EditOperation =>
  ({ type: 'entry.create', collectionId: 'posts', entryId, title, publishedAt, draft: false, body: [`${title}.`], terms, ...extra }) as EditOperation;

/** A blog whose posts are tagged: a category and a tag share the ID "glaze", and one tag is only on a draft. */
function blog(): ProjectState {
  const start = createStarterState('business', 'Riverside Studio', false);
  start.site.language = 'en-GB';
  return run(
    start,
    { type: 'site.update', baseUrl: 'https://example.com' } as EditOperation,
    {
      type: 'collection.create',
      collectionId: 'posts',
      taxonomies: {
        categories: { label: 'Categories', terms: { news: { label: 'News' }, glaze: { label: 'Glazes' } } },
        tags: { label: 'Tags', terms: { glaze: { label: 'Glaze' }, 'cover-crops': { label: 'Cover crops' }, secret: { label: 'Secret' } } }
      }
    } as EditOperation,
    // Its tags in the other order from the one they are offered in.
    post('en_kiln', 'New kiln', '2026-04-01', { categories: ['news'], tags: ['cover-crops', 'glaze'] }),
    post('en_glaze', 'Glaze night', '2026-03-10', { categories: ['glaze'], tags: ['cover-crops'] }),
    post('en_open', 'Open studio', '2026-02-20', { categories: ['news'], tags: ['cover-crops'] }),
    post('en_plans', 'Plans', '2026-05-01', { tags: ['secret'] }, { draft: true })
  );
}
const files = (s: ProjectState) => generateProject(publishedState(s));

describe('tag archives', () => {
  it('give each tag with a published post a paginated archive of its posts alone, apart from a category of the same ID', () => {
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', pageSize: 2 } as EditOperation);
    const pages = archivePages(publishedState(s)).filter((p) => p.term);
    expect(pages.map((p) => [p.route, p.term, p.entryIds])).toEqual([
      ['/blog/category/news/', { taxonomy: 'categories', id: 'news' }, ['en_kiln', 'en_open']],
      ['/blog/category/glaze/', { taxonomy: 'categories', id: 'glaze' }, ['en_glaze']],
      ['/blog/tag/glaze/', { taxonomy: 'tags', id: 'glaze' }, ['en_kiln']],
      ['/blog/tag/cover-crops/', { taxonomy: 'tags', id: 'cover-crops' }, ['en_kiln', 'en_glaze']],
      ['/blog/tag/cover-crops/page/2/', { taxonomy: 'tags', id: 'cover-crops' }, ['en_open']]
    ]);
    const out = files(s);
    // A tag only a draft is filed under has no archive yet.
    expect(out.has(route('/blog/tag/secret/'))).toBe(false);
    const tag = out.get(route('/blog/tag/cover-crops/'))!;
    expect(tag).toContain('{"Cover crops"}</h1>');
    // Its eyebrow names it a tag, and leads back to the index.
    expect(tag).toMatch(/<p class="so-archive__eyebrow"><a href=\{resolve\("\/blog\/"\)\}>[^<]*<\/a><span aria-hidden="true">\/<\/span>\{"Tag"\}<\/p>/);
    expect(tag).toContain(`<link rel="next" href={resolve("/blog/tag/cover-crops/page/2/")} />`);
    expect(tag).toContain(`<a href={resolve("/blog/tag/cover-crops/page/2/")} aria-label={"Page 2"}>2</a>`);
    expect(tag).toContain('<link rel="canonical" href={"https://example.com/blog/tag/cover-crops/"} />');
    expect(tag).toContain('<meta name="description" content={"Posts tagged Cover crops, from Riverside Studio."} />');
    const second = out.get(route('/blog/tag/cover-crops/page/2/'))!;
    expect(second).toContain('Open studio');
    expect(second).toContain(`<link rel="prev" href={resolve("/blog/tag/cover-crops/")} />`);
    // The category of the same ID lists its own posts.
    expect(out.get(route('/blog/tag/glaze/'))).toContain('{"Glaze"}</h1>');
    expect(out.get(route('/blog/category/glaze/'))).toContain('{"Glazes"}</h1>');
    expect(out.get(route('/blog/category/glaze/'))).toMatch(/<span aria-hidden="true">\/<\/span>\{"Category"\}<\/p>/);
    expect(archiveWords(s, pages[4]).name).toBe('Cover crops – Page 2 of 2');
    const sitemap = out.get('static/sitemap.xml')!;
    for (const r of ['/blog/tag/glaze/', '/blog/tag/cover-crops/', '/blog/tag/cover-crops/page/2/']) expect(sitemap.split(`<loc>https://example.com${r}</loc>`)).toHaveLength(2);
    // Turned off, there are none, nor any for categories.
    const off = run(s, { type: 'collection.update', collectionId: 'posts', termArchives: false } as EditOperation);
    expect(archivePages(publishedState(off)).filter((p) => p.term)).toEqual([]);
  });

  it('keep their addresses for the collection, and keep working when it moves', () => {
    const s = blog();
    expect(() => run(s, { type: 'page.create', pageId: 'pg_tag', title: 'Tag', route: '/blog/tag/glaze/' } as EditOperation)).toThrow(/archive pages/);
    // The folder's own address stays free.
    expect(() => run(s, { type: 'page.create', pageId: 'pg_tags', title: 'Tags', route: '/blog/tag/' } as EditOperation)).not.toThrow();
    const moved = run(run(s, { type: 'collection.update', collectionId: 'posts', pageSize: 2 } as EditOperation), { type: 'collection.update', collectionId: 'posts', route: '/journal/' } as EditOperation);
    const sent = Object.fromEntries(liveRedirects(publishedState(moved)).map((r) => [r.from, r.to]));
    expect(sent).toMatchObject({ '/blog/tag/glaze/': '/journal/tag/glaze/', '/blog/tag/cover-crops/page/2/': '/journal/tag/cover-crops/page/2/' });
    // Moved again, the old addresses go straight to the newest.
    const again = run(moved, { type: 'collection.update', collectionId: 'posts', route: '/notes/' } as EditOperation);
    expect(Object.fromEntries(liveRedirects(publishedState(again)).map((r) => [r.from, r.to]))).toMatchObject({ '/blog/tag/glaze/': '/notes/tag/glaze/', '/journal/tag/cover-crops/page/2/': '/notes/tag/cover-crops/page/2/' });
    expect(validateState(again).filter((d) => d.code.startsWith('REDIRECT') || d.code.startsWith('ROUTE'))).toEqual([]);
  });
});

describe('a post’s tags', () => {
  it('are read as links to their archives, in the order they were given', () => {
    const s = blog();
    const collection = s.collections.posts;
    const read = (id: string, field: string) => entryFieldValue({ state: s, collection, entry: collection.entries[id], neighbours: {} }, field);
    const link = (taxonomy: string, id: string) => ({ type: 'collection', target: 'posts', term: { taxonomy, id } });
    expect(read('en_kiln', 'tags.links')).toEqual([{ type: 'p', spans: [{ text: 'Cover crops', link: link('tags', 'cover-crops') }, { text: ', ' }, { text: 'Glaze', link: link('tags', 'glaze') }] }]);
    expect(read('en_kiln', 'categories.links')).toEqual([{ type: 'p', spans: [{ text: 'News', link: link('categories', 'news') }] }]);
    // None, nothing.
    expect(read('en_glaze', 'categories.links')).toEqual([{ type: 'p', spans: [{ text: 'Glazes', link: link('categories', 'glaze') }] }]);
    const untagged = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_open', terms: { tags: [] } } as EditOperation);
    expect(entryFieldValue({ state: untagged, collection: untagged.collections.posts, entry: untagged.collections.posts.entries.en_open, neighbours: {} }, 'tags.links')).toEqual([]);
    // They are shown, never filtered or sorted by.
    expect(isLinkedForm('tags.links')).toBe(true);
    expect(isLinkedForm('categories.links')).toBe(true);
    expect(isLinkedForm('categories')).toBe(false);
  });

  it('show on its page under its text, each linking to its archive while it has one', () => {
    const out = files(blog());
    const kiln = out.get(route('/blog/new-kiln/'))!;
    expect(kiln).toContain('<SoRichText value={[{"type":"p","spans":[{"text":"Cover crops","link":{"href":"/blog/tag/cover-crops/"}},{"text":", "},{"text":"Glaze","link":{"href":"/blog/tag/glaze/"}}]}]}');
    // Under the post's text.
    expect(kiln.indexOf('{"text":"New kiln."}')).toBeGreaterThan(-1);
    expect(kiln.indexOf('/blog/tag/cover-crops/')).toBeGreaterThan(kiln.indexOf('{"text":"New kiln."}'));
    // A post without tags shows no tags.
    const untagged = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_open', terms: { tags: [] } } as EditOperation);
    const open = files(untagged).get(route('/blog/open-studio/'))!;
    expect(open).not.toContain('/blog/tag/');
    // No empty element either: the text alone is rich text.
    expect(open.match(/<SoRichText value=/g)).toHaveLength(1);
    // The archive's address as the site has it, followed when the collection moves.
    const moved = run(blog(), { type: 'collection.update', collectionId: 'posts', route: '/journal/' } as EditOperation);
    expect(files(moved).get(route('/journal/new-kiln/'))).toContain('{"text":"Glaze","link":{"href":"/journal/tag/glaze/"}}');
    expect(termArchiveRoutes(archivePages(publishedState(moved)))[termArchiveKey('posts', { taxonomy: 'tags', id: 'glaze' })]).toBe('/journal/tag/glaze/');
  });

  it('show a tag without an archive as its name alone', () => {
    // With archives off, no tag has one.
    const s = run(blog(), { type: 'collection.update', collectionId: 'posts', termArchives: false } as EditOperation);
    const kiln = files(s).get(route('/blog/new-kiln/'))!;
    expect(kiln).toContain('<SoRichText value={[{"type":"p","spans":[{"text":"Cover crops"},{"text":", "},{"text":"Glaze"}]}]}');
    expect(kiln).not.toContain('/blog/tag/');
    // Nor does Project health count it as a link.
    expect(siteLinks(s).some((l) => l.link.term)).toBe(false);
    expect(siteLinks(blog()).filter((l) => l.link.term).map((l) => l.label)).toEqual(expect.arrayContaining(['Cover crops', 'Glaze']));
  });

  it('leave a collection without tags with a layout that is valid', () => {
    const start = createStarterState('business', 'Riverside Studio', false);
    const s = run(start, { type: 'collection.create', collectionId: 'notes', route: '/notes/' } as EditOperation, { type: 'entry.create', collectionId: 'notes', entryId: 'en_note', title: 'A note', draft: false, body: ['Hello.'] } as EditOperation);
    expect(Object.values(s.collections.notes.settings.template!.nodes).some((n) => JSON.stringify(n).includes('tags.links'))).toBe(true);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    expect(files(s).get(route('/notes/a-note/'))).toContain('A note');
  });
});
