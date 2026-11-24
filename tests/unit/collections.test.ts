/**
 * Collections (#392): blog posts, projects or case studies kept apart from the site's pages, each entry a document of
 * its own. Their addresses share one namespace with the pages and old page addresses, links to an entry are guarded
 * or pointed elsewhere when it goes, and pictures they show count as uses of the library's images.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, InstanceNode, ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, assetUsages } from '@engine/apply';
import { normalizeRichText } from '@engine/values';
import { EngineError } from '@engine/tree';
import { entryLinkUses, pageLinkUses } from '@engine/page-links';
import { validateState } from '@engine/validate';
import { MIGRATIONS, migrateProject } from '@shared/migrations';
import { orderedEntries, routeOwners } from '@shared/collections';
import { todayArticleDate } from '@shared/articles';
import { resolveLink } from '@generator/index';
import { linkToTarget } from '@shared/richtext';
import { toolDefinitions } from '@agent/tools';

const image = (id: string): AssetRecord => ({ id, name: `Photo ${id}`, file: `static/assets/${id}-1a2b3c4d.png`, mime: 'image/png', bytes: 10, hash: `hash-${id}`, kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' });
const doc = (id: string): AssetRecord => ({ id, name: `Guide ${id}`, file: `static/assets/${id}-1a2b3c4d.pdf`, mime: 'application/pdf', bytes: 10, hash: `hash-${id}`, kind: 'document', createdAt: '2026-01-01T00:00:00.000Z' });

function site(): ProjectState {
  const s = createStarterState('business', 'Riverside Studio', false);
  s.assets.assets.img_a = image('img_a');
  s.assets.assets.img_b = image('img_b');
  s.assets.assets.doc_a = doc('doc_a');
  return s;
}

const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);
const run = (s: ProjectState, ...ops: EditOperation[]) => apply(s, ops).state;
const pageAt = (s: ProjectState, route: string) => Object.values(s.pages).find((p) => p.route === route)!;

/** The ready-made blog with two posts, the later one added first. */
function blog() {
  return run(
    site(),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' }
  );
}

describe('collections', () => {
  it('creates the ready-made blog and a custom collection with readable settings', () => {
    const s = run(site(), { type: 'collection.create', collectionId: 'posts' }, { type: 'collection.create', collectionId: 'case-studies' });
    expect(s.collections.posts.settings).toEqual({
      schemaVersion: SCHEMA_VERSION,
      id: 'posts',
      name: 'Posts',
      route: '/blog/',
      taxonomies: { categories: { label: 'Categories', terms: {} }, tags: { label: 'Tags', terms: {} } },
      fields: {}
    });
    expect(s.collections['case-studies'].settings).toMatchObject({ name: 'Case studies', route: '/case-studies/', taxonomies: {}, fields: {} });
    // What is given wins over the ready-made blog's settings.
    const named = run(site(), { type: 'collection.create', collectionId: 'posts', name: 'Journal', route: '/journal/', taxonomies: {} });
    expect(named.collections.posts.settings).toMatchObject({ name: 'Journal', route: '/journal/', taxonomies: {} });
    const custom = run(site(), {
      type: 'collection.create',
      collectionId: 'projects',
      name: 'Projects',
      route: 'work/projects',
      taxonomies: { sector: { label: 'Sector', terms: { housing: { label: 'Housing' } } } },
      fields: { client: { type: 'string', label: 'Client' }, budget: { type: 'number', label: 'Budget', min: 0 }, hero: { type: 'image', label: 'Hero' } }
    });
    expect(custom.collections.projects.settings).toMatchObject({ route: '/work/projects/', taxonomies: { sector: { terms: { housing: { label: 'Housing' } } } } });
    expect(custom.collections.projects.settings.fields.client).toMatchObject({ type: 'string', label: 'Client', default: '' });
    expect(custom.collections.projects.settings.fields.hero).toMatchObject({ type: 'image', default: { assetId: null, alt: '' } });
    expect(custom.collections.projects.settings.fields.budget).toMatchObject({ type: 'number', min: 0, default: 0 });
    expect(() => apply(custom, [{ type: 'entry.create', collectionId: 'projects', title: 'X', values: { budget: -1 } }])).toThrow(/at least 0/);
    // Two terms readers cannot tell apart.
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'news', taxonomies: { tags: { label: 'Tags', terms: { a: { label: 'Housing' }, b: { label: 'housing' } } } } }])).toThrow(/two terms called “housing”/);
  });

  it('refuses bad IDs, a second collection with the same ID and unusable addresses', () => {
    const s = run(site(), { type: 'collection.create', collectionId: 'posts' });
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'posts' }])).toThrow(/already exists/);
    for (const id of ['Posts', 'case_studies', 'con', '-x', 'a--b', '__proto__', 'constructor', 'prototype']) expect(() => apply(site(), [{ type: 'collection.create', collectionId: id }]), id).toThrow();
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'prototype' }])).toThrow(/not a collection ID/);
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'news', route: '/' }])).toThrow(/Home page/);
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'news', route: '/a/b/c/d/' }])).toThrow(/at most 3 levels/);
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'news', route: '/api/' }])).toThrow(/reserved/);
    expect(() => apply(site(), [{ type: 'collection.create', collectionId: 'news', fields: { link: { type: 'link', label: 'Link' } } }])).toThrow(/type of string, number, boolean, enum, image/);
  });

  it('creates entries as drafts dated today with a slug of the title, and returns the new ID and address', () => {
    const r = apply(run(site(), { type: 'collection.create', collectionId: 'posts' }), [{ type: 'entry.create', collectionId: 'posts', title: 'Hello, World!' }]);
    const { entryId, slug, route } = r.results[0] as { entryId: string; slug: string; route: string };
    expect(entryId).toMatch(/^en_[a-z0-9]{8}$/);
    expect({ slug, route }).toEqual({ slug: 'hello-world', route: '/blog/hello-world/' });
    expect(r.state.collections.posts.entries[entryId]).toEqual({ schemaVersion: SCHEMA_VERSION, id: entryId, slug: 'hello-world', title: 'Hello, World!', publishedAt: todayArticleDate(), draft: true, terms: {}, values: {}, body: [] });
    const two = apply(r.state, [{ type: 'entry.create', collectionId: 'posts', title: 'Again' }]);
    expect(two.results[0].entryId).not.toBe(entryId);
    expect(Object.keys(two.state.collections.posts.entries)).toHaveLength(2);
    // IDs are unique across the project, not only within a collection.
    const other = run(r.state, { type: 'collection.create', collectionId: 'projects' });
    expect(() => apply(other, [{ type: 'entry.create', collectionId: 'projects', entryId, title: 'Copy' }])).toThrow(/already exists/);
  });

  it('numbers a slug whose address a page, an old page address or another entry already has', () => {
    let s = run(site(), { type: 'collection.create', collectionId: 'posts' }, { type: 'page.create', title: 'Launch', route: '/blog/launch/' });
    // An old address kept for the About page at /blog/news/.
    s.site.redirects = [{ from: '/blog/news/', pageId: pageAt(s, '/about/').id }];
    s = run(
      s,
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_launch1', title: 'Launch' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_launch2', title: 'Launch' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_news', title: 'News' }
    );
    const e = s.collections.posts.entries;
    expect([e.en_launch1.slug, e.en_launch2.slug, e.en_news.slug]).toEqual(['launch-2', 'launch-3', 'news-2']);
    // Kept within 60 characters, with no hyphen left before the number.
    const long = `${'a'.repeat(58)} b`;
    const t = run(s, { type: 'entry.create', collectionId: 'posts', entryId: 'en_long1', title: long }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_long2', title: long });
    expect(t.collections.posts.entries.en_long1.slug).toBe(`${'a'.repeat(58)}-b`);
    expect(t.collections.posts.entries.en_long2.slug).toBe(`${'a'.repeat(58)}-2`);
    expect(validateState(t).filter((d) => d.code.startsWith('ROUTE'))).toEqual([]);
    // Two-digit numbers still fit in 60 characters.
    const ten = run(t, ...Array.from({ length: 8 }, (_, i): EditOperation => ({ type: 'entry.create', collectionId: 'posts', entryId: `en_long${i + 3}`, title: long })));
    expect(ten.collections.posts.entries.en_long10.slug).toBe(`${'a'.repeat(57)}-10`);
    expect(validateState(ten).filter((d) => d.code.startsWith('ROUTE'))).toEqual([]);
    // Another collection's own address counts too.
    const nested = run(site(), { type: 'collection.create', collectionId: 'posts' }, { type: 'collection.create', collectionId: 'launches', route: '/blog/launch/' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_launch', title: 'Launch' });
    expect(nested.collections.posts.entries.en_launch.slug).toBe('launch-2');
  });

  it('refuses a slug or a collection address that a page, an old page address or another entry has', () => {
    let s = blog();
    s.site.redirects = [{ from: '/blog/old-news/', pageId: pageAt(s, '/about/').id }];
    s = run(s, { type: 'page.create', title: 'Team', route: '/blog/team/' });
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'team' }])).toThrow(/\/blog\/team\/ is already the address of the page “Team”/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'old-news' }])).toThrow(/old address of “About/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'spring-open-studio' }])).toThrow(/the entry “Spring open studio”/);
    expect(() => apply(s, [{ type: 'entry.create', collectionId: 'posts', title: 'X', slug: 'Not a slug!' }])).toThrow(/is not a slug/);
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'about', route: '/about/' }])).toThrow(/the page “About/);
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'news', route: '/blog/' }])).toThrow(/the Posts collection/);
    expect(() => apply(s, [{ type: 'entry.create', collectionId: 'posts', title: 'Team', slug: 'team' }])).toThrow(/the page “Team”/);
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'posts', route: '/about/' }])).toThrow(/\/about\/ is already the address of the page “About/);
    // A new collection never takes an entry's address.
    expect(() => apply(s, [{ type: 'collection.create', collectionId: 'spring', route: '/blog/spring-open-studio/' }])).toThrow(/the entry “Spring open studio”/);
    // An entry keeps its own slug, and a collection its own address.
    expect(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'winter-hours' }).collections.posts.entries.en_winter.slug).toBe('winter-hours');
    expect(run(s, { type: 'collection.update', collectionId: 'posts', route: '/blog/' }).collections.posts.settings.route).toBe('/blog/');
    expect(apply(s, [{ type: 'entry.create', collectionId: 'posts', title: 'Free', slug: 'free' }]).results[0].route).toBe('/blog/free/');
  });

  it('keeps pages off collection and entry addresses, and gives a new page a free one', () => {
    const s = blog();
    expect(() => apply(s, [{ type: 'page.create', title: 'Blog', route: '/blog/' }])).toThrow(/\/blog\/ is the address of the Posts collection/);
    expect(() => apply(s, [{ type: 'page.create', title: 'Spring', route: '/blog/spring-open-studio/' }])).toThrow(/the entry “Spring open studio”/);
    expect(() => apply(s, [{ type: 'page.update', pageId: pageAt(s, '/about/').id, route: '/blog/winter-hours/' }])).toThrow(/the entry “Winter hours”/);
    expect(() => apply(s, [{ type: 'page.update', pageId: pageAt(s, '/about/').id, route: '/BLOG/' }])).toThrow(/the Posts collection/);
    const r = apply(s, [{ type: 'page.create', title: 'Blog' }]);
    expect(r.results[0].route).toBe('/blog-2/');
    // Making another page Home moves the old Home to a free address of its own, never a collection's.
    const withPosts = run(site(), { type: 'collection.create', collectionId: 'posts', route: '/home/' });
    const moved = run(withPosts, { type: 'page.setHome', pageId: pageAt(withPosts, '/about/').id, keepOldAddress: false });
    expect(moved.pages[withPosts.site.homePageId].route).toBe('/home-2/');
  });

  it('keeps the pages inside a moved page off collection and entry addresses too', () => {
    const s = run(
      site(),
      { type: 'collection.create', collectionId: 'posts', route: '/updates/blog/' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio' },
      { type: 'page.create', title: 'Old', route: '/old/' },
      { type: 'page.create', title: 'Blog', route: '/old/blog/' },
      { type: 'page.create', title: 'Spring', route: '/old/blog/spring-open-studio/' }
    );
    const old = pageAt(s, '/old/').id;
    expect(() => apply(s, [{ type: 'page.update', pageId: old, route: '/updates/' }])).toThrow(/would move “Blog” to \/updates\/blog\/, which is the address of the Posts collection/);
    // Elsewhere the whole branch moves, and no page sits on an entry's address.
    const moved = run(s, { type: 'page.update', pageId: old, route: '/archive/' });
    expect(Object.values(moved.pages).map((p) => p.route)).toEqual(expect.arrayContaining(['/archive/', '/archive/blog/', '/archive/blog/spring-open-studio/']));
  });

  it('moves a collection with its entries only when every new address is free', () => {
    let s = run(blog(), { type: 'page.create', title: 'Winter', route: '/news/winter-hours/' });
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'posts', route: '/news/' }])).toThrow(/would give “Winter hours” the address \/news\/winter-hours\/, which is the page “Winter”/);
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'winter' });
    // An old page address on a new entry address stops the move too.
    const kept = structuredClone(s);
    kept.site.redirects = [{ from: '/news/winter/', pageId: pageAt(s, '/about/').id }];
    expect(() => apply(kept, [{ type: 'collection.update', collectionId: 'posts', route: '/news/' }])).toThrow(/old address of “About/);
    s = run(s, { type: 'collection.update', collectionId: 'posts', route: '/news/', name: 'News' });
    expect(s.collections.posts.settings).toMatchObject({ route: '/news/', name: 'News' });
    expect(routeOwners(s).filter((o) => o.kind === 'entry').map((o) => o.route).sort()).toEqual(['/news/spring-open-studio/', '/news/winter/']);
    // Its old address is free again.
    expect(apply(s, [{ type: 'page.create', title: 'Blog', route: '/blog/' }]).results[0].route).toBe('/blog/');
  });

  it('publishes, unpublishes, backdates and renames an entry without moving it', () => {
    let s = blog();
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Winter opening hours', draft: false, publishedAt: '2020-01-05', updatedAt: '2026-12-01', author: '  Ana Ruiz ', excerpt: 'Shorter days.' });
    expect(s.collections.posts.entries.en_winter).toMatchObject({ title: 'Winter opening hours', slug: 'winter-hours', draft: false, publishedAt: '2020-01-05', updatedAt: '2026-12-01', author: 'Ana Ruiz', excerpt: 'Shorter days.' });
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', draft: true, updatedAt: null, author: null, excerpt: '' });
    expect(s.collections.posts.entries.en_winter).not.toHaveProperty('updatedAt');
    expect(s.collections.posts.entries.en_winter).not.toHaveProperty('author');
    expect(s.collections.posts.entries.en_winter).not.toHaveProperty('excerpt');
    expect(s.collections.posts.entries.en_winter.draft).toBe(true);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', publishedAt: '2027-02-30' }])).toThrow(/not a calendar date/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', updatedAt: '2027-02-30' }])).toThrow(/revision date/);
    // A link made by address names the entry, so a new title and slug keep it.
    const linked = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['[Hours](/blog/winter-hours/)'] }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', title: 'Opening hours', slug: 'opening-hours' });
    expect(linked.collections.posts.entries.en_winter).toMatchObject({ id: 'en_winter', slug: 'opening-hours' });
    expect(JSON.stringify(linked.collections.posts.entries.en_spring.body)).toContain('{"type":"entry","target":"en_winter"}');
    expect(validateState(linked).filter((d) => d.severity === 'error')).toEqual([]);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_nope', title: 'X' }])).toThrow(/no entry "en_nope"/);
  });

  it('orders entries newest first, or in a chosen order that new entries join at the end', () => {
    let s = blog();
    const ids = (st: ProjectState) => orderedEntries(st.collections.posts).map((e) => e.id);
    expect(ids(s)).toEqual(['en_spring', 'en_winter']);
    // Backdating reorders.
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', publishedAt: '2020-01-01' });
    expect(ids(s)).toEqual(['en_winter', 'en_spring']);
    s = run(s, { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_winter'] });
    expect(s.collections.posts.settings.entryOrder).toEqual(['en_spring', 'en_winter']);
    s = run(s, { type: 'entry.create', collectionId: 'posts', entryId: 'en_third', title: 'Third', publishedAt: '2030-01-01' });
    expect(ids(s)).toEqual(['en_spring', 'en_winter', 'en_third']);
    expect(() => apply(s, [{ type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_winter'] }])).toThrow(/exactly once/);
    expect(() => apply(s, [{ type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_spring', 'en_third'] }])).toThrow(/exactly once/);
    expect(() => apply(s, [{ type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_spring', 'en_winter', 'en_missing'] }])).toThrow(/exactly once/);
    // Entries of the same day go by ID, whatever order they were added in.
    const sameDay = run(site(), { type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_zzzz', title: 'Z', publishedAt: '2026-05-05' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_aaaa', title: 'A', publishedAt: '2026-05-05' });
    expect(ids(sameDay)).toEqual(['en_aaaa', 'en_zzzz']);
    s = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_winter' });
    expect(s.collections.posts.settings.entryOrder).toEqual(['en_spring', 'en_third']);
    s = run(s, { type: 'entry.reorder', collectionId: 'posts', entryIds: null });
    expect(s.collections.posts.settings).not.toHaveProperty('entryOrder');
    expect(ids(s)).toEqual(['en_third', 'en_spring']);
  });

  it('assigns terms and custom field values, and settles entries when groupings and fields change', () => {
    let s = run(
      site(),
      {
        type: 'collection.create',
        collectionId: 'projects',
        taxonomies: { sector: { label: 'Sector', terms: { housing: { label: 'Housing' }, civic: { label: 'Civic' } } } },
        fields: { client: { type: 'string', label: 'Client' }, status: { type: 'enum', label: 'Status', options: ['open', 'closed', 'withdrawn'] }, size: { type: 'number', label: 'Size' } }
      },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Town hall', terms: { sector: ['civic', 'housing'] }, values: { client: 'City', status: 'withdrawn', size: 3 } }
    );
    expect(s.collections.projects.entries.en_hall).toMatchObject({ terms: { sector: ['civic', 'housing'] }, values: { client: 'City', status: 'withdrawn', size: 3 } });
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', terms: { sector: ['parks'] } }])).toThrow(/Sector has no term "parks"/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', terms: { colour: [] } }])).toThrow(/no grouping "colour"/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { status: 'maybe' } }])).toThrow(/must be one of/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { colour: 'red' } }])).toThrow(/no field "colour"/);
    // null goes back to the default.
    expect(run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { client: null } }).collections.projects.entries.en_hall.values).toEqual({ status: 'withdrawn', size: 3 });
    // A term and a field that are gone take their assignments and values with them; renaming a term keeps them.
    const settled = run(s, {
      type: 'collection.update',
      collectionId: 'projects',
      taxonomies: { sector: { label: 'Sector', terms: { civic: { label: 'Civic buildings' } } } },
      fields: { status: { type: 'enum', label: 'Status', options: ['open', 'closed', 'withdrawn'] }, size: { type: 'number', label: 'Size' } }
    });
    expect(settled.collections.projects.entries.en_hall.terms).toEqual({ sector: ['civic'] });
    expect(settled.collections.projects.entries.en_hall.values).toEqual({ status: 'withdrawn', size: 3 });
    // A whole grouping that goes takes every assignment to it.
    expect(run(s, { type: 'collection.update', collectionId: 'projects', taxonomies: {} }).collections.projects.entries.en_hall.terms).toEqual({});
    // An empty list clears a grouping; a term given twice is refused.
    expect(run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', terms: { sector: [] } }).collections.projects.entries.en_hall.terms).toEqual({});
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', terms: { sector: ['civic', 'civic'] } }])).toThrow(/given twice/);
    expect(settled.collections.projects.settings.taxonomies.sector.terms.civic.label).toBe('Civic buildings');
    // A field that stays never changes an entry's value on its own: an option still chosen cannot be removed.
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'projects', fields: { status: { type: 'enum', label: 'Status', options: ['open', 'closed'] } } }])).toThrow(/“Town hall” has a value for Status/);
    // Nor one that would be read differently: a number as a picture, or text whose lines would run together.
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'projects', fields: { size: { type: 'image', label: 'Size' } } }])).toThrow(/value for Size/);
    expect(() => apply(s, [{ type: 'collection.update', collectionId: 'projects', fields: { size: { type: 'string', label: 'Size' } } }])).toThrow(/value for Size/);
    const lines = run(
      site(),
      { type: 'collection.create', collectionId: 'notes', fields: { text: { type: 'string', label: 'Text', multiline: true } } },
      { type: 'entry.create', collectionId: 'notes', entryId: 'en_note', title: 'Note', values: { text: 'one\ntwo' } }
    );
    expect(() => apply(lines, [{ type: 'collection.update', collectionId: 'notes', fields: { text: { type: 'string', label: 'Text' } } }])).toThrow(/value for Text/);
  });

  it('never reads custom fields as links, whatever they are named', () => {
    let s = run(
      site(),
      { type: 'collection.create', collectionId: 'posts', fields: { type: { type: 'string', label: 'Type' }, target: { type: 'string', label: 'Target' }, anchor: { type: 'string', label: 'Anchor' } } }
    );
    const contact = pageAt(s, '/contact/');
    s = run(s, { type: 'entry.create', collectionId: 'posts', entryId: 'en_odd', title: 'Odd', values: { type: 'page', target: contact.id, anchor: 'original' } });
    expect(pageLinkUses(s, contact.id).filter((u) => u.owner.kind === 'entry')).toEqual([]);
    const next = run(s, { type: 'page.remove', pageId: contact.id, replacementPageId: pageAt(s, '/about/').id });
    expect(next.collections.posts.entries.en_odd.values).toEqual({ type: 'page', target: contact.id, anchor: 'original' });
  });

  it('keeps links in an entry’s text to pages and entries, and refuses entry links anywhere else', () => {
    let s = blog();
    const about = pageAt(s, '/about/');
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['See [our studio](/about/), the [spring post](entry:en_spring) and [this](/blog/spring-open-studio/).'] });
    const links = s.collections.posts.entries.en_winter.body.flatMap((b) => ('spans' in b ? b.spans : [])).flatMap((sp) => (sp.link ? [sp.link] : []));
    expect(links).toEqual([
      { type: 'page', target: about.id },
      { type: 'entry', target: 'en_spring' },
      { type: 'entry', target: 'en_spring' }
    ]);
    expect(linkToTarget(links[1], s.pages)).toBe('entry:en_spring');
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['[gone](entry:en_nothing)'] }])).toThrow(/entry "en_nothing" does not exist/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['[gone](/blog/nothing/)'] }])).toThrow(/no page or entry has the route/);
    // Page content cannot hold one: nothing could show it there yet.
    const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
    expect(() => apply(s, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'ctaLink', value: { type: 'entry', target: 'en_spring' } }])).toThrow(/only be made in an entry's text/);
    // The website shows such a link's words without a destination until entries are pages.
    expect(resolveLink({ type: 'entry', target: 'en_spring' }, { state: s } as never)).toBeNull();
    // Structured blocks, list items included, are held to the same rule as text.
    const list = [{ type: 'ul', items: [[{ text: 'Spring', link: { type: 'entry', target: 'en_spring' } }]] }];
    expect(normalizeRichText(list, s, 'Text', undefined, { entries: true })).toEqual(list);
    expect(() => normalizeRichText(list, s, 'Text')).toThrow(/only be made in an entry's text/);
    expect(() => normalizeRichText('[Read](entry:en_spring)', s, 'Text')).toThrow(/only be made in an entry's text/);
    // A //host path is not an address of this site.
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['[x](//blog/spring-open-studio/)'] }])).toThrow();
    // An entry can link to its own new address in the change that gives it.
    const own = apply(s, [{ type: 'entry.create', collectionId: 'posts', entryId: 'en_launch', title: 'Launch', slug: 'launch', body: ['[Permalink](/blog/launch/)'] }]);
    expect(JSON.stringify(own.state.collections.posts.entries.en_launch.body)).toContain('{"type":"entry","target":"en_launch"}');
    const moved = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', slug: 'hours', body: ['[Here](/blog/hours/)'] });
    expect(JSON.stringify(moved.collections.posts.entries.en_winter.body)).toContain('{"type":"entry","target":"en_winter"}');
    // A link to an entry hand-written into a page is reported: the page could neither show nor keep it.
    const hand = structuredClone(s);
    const handHeader = hand.site.shell.header.nodes[hand.site.shell.header.rootIds[0]] as InstanceNode;
    handHeader.props.ctaLink = { type: 'entry', target: 'en_spring' };
    expect(validateState(hand).find((d) => d.code === 'LINK_BROKEN')?.message).toMatch(/a collection entry, which only another entry can link to/);
  });

  it('guards links to an entry it removes, or points them at a replacement entry or page', () => {
    const s = run(
      blog(),
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['Read [the spring post](entry:en_spring).'] },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['A link to [itself](entry:en_spring).'] },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_other', title: 'Other' }
    );
    expect(entryLinkUses(s, 'en_spring')).toHaveLength(1);
    expect(entryLinkUses(s, 'en_spring')[0]).toMatchObject({ owner: { kind: 'entry', id: 'en_winter', collectionId: 'posts' }, where: 'Winter hours (Posts)', label: 'the spring post' });
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }])).toThrow(/1 link point to “Spring open studio”/);
    const toEntry = apply(s, [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementEntryId: 'en_other' }]);
    expect(toEntry.results[0]).toMatchObject({ referencesRepointed: 1 });
    expect(toEntry.state.collections.posts.entries).not.toHaveProperty('en_spring');
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementEntryId: 'en_missing' }])).toThrow(/replacement entry "en_missing" does not exist/);
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementPageId: 'pg_missing' }])).toThrow(/replacement page does not exist/);
    expect(JSON.stringify(toEntry.state.collections.posts.entries.en_winter.body)).toContain('{"type":"entry","target":"en_other"}');
    const about = pageAt(s, '/about/');
    const toPage = run(s, { type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementPageId: about.id });
    expect(JSON.stringify(toPage.collections.posts.entries.en_winter.body)).toContain(`{"type":"page","target":"${about.id}"}`);
    expect(toPage.collections.posts.entries).not.toHaveProperty('en_spring');
    expect(validateState(toPage).filter((d) => d.code === 'LINK_BROKEN')).toEqual([]);
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementEntryId: 'en_spring' }])).toThrow(/different entry/);
    expect(() => apply(s, [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring', replacementEntryId: 'en_other', replacementPageId: about.id }])).toThrow(/not both/);
  });

  it('removes a collection with links only among its own entries, and refuses one linked from outside', () => {
    const s = run(
      blog(),
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['Read [the spring post](entry:en_spring).'] },
      { type: 'collection.create', collectionId: 'projects' },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Town hall' }
    );
    const r = apply(s, [{ type: 'collection.remove', collectionId: 'posts' }]);
    expect(r.results[0]).toEqual({ collectionId: 'posts', removedEntries: 2 });
    expect(r.state.collections).not.toHaveProperty('posts');
    expect(r.state.collections.projects.entries).toHaveProperty('en_hall');
    const linked = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', body: ['See [winter](entry:en_winter).'] });
    expect(() => apply(linked, [{ type: 'collection.remove', collectionId: 'posts' }])).toThrow(/1 link outside the Posts collection point to its entries \(in Town hall \(Projects\)\)/);
  });

  it('points page links inside entries at the replacement when a page is removed', () => {
    let s = blog();
    const contact = pageAt(s, '/contact/');
    const about = pageAt(s, '/about/');
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', body: ['Questions? [Contact us](/contact/).'] });
    expect(pageLinkUses(s, contact.id).filter((u) => u.owner.kind === 'entry')).toHaveLength(1);
    // The entry's link counts like any other: removing the page without a replacement is refused.
    const refsWithout = pageLinkUses(s, contact.id).filter((u) => !u.card).length;
    expect(refsWithout).toBeGreaterThan(0);
    const next = run(s, { type: 'page.remove', pageId: contact.id, replacementPageId: about.id });
    expect(JSON.stringify(next.collections.posts.entries.en_winter.body)).toContain(`{"type":"page","target":"${about.id}"}`);
    // A page only an entry links to is guarded like any other.
    const lonely = apply(s, [{ type: 'page.create', pageId: 'pg_lonely', title: 'Lonely' }]).state;
    const linked = run(lonely, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['[Lonely](/lonely/)'] });
    expect(() => apply(lonely, [{ type: 'page.remove', pageId: 'pg_lonely' }])).not.toThrow();
    let refused: unknown;
    try {
      apply(linked, [{ type: 'page.remove', pageId: 'pg_lonely' }]);
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(EngineError);
    expect((refused as EngineError).details).toEqual({ references: 1 });
    expect(validateState(next).filter((d) => d.code === 'LINK_BROKEN')).toEqual([]);
  });

  it('counts featured images, picture fields and their defaults as uses, and follows an image replacement', () => {
    let s = run(
      site(),
      { type: 'collection.create', collectionId: 'projects', fields: { hero: { type: 'image', label: 'Hero', default: { assetId: 'img_b', alt: 'Default' } }, client: { type: 'string', label: 'Client' } } },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Town hall', featuredImage: 'img_a', values: { hero: { assetId: 'img_a', alt: 'Hall' }, client: 'img_b' } },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_park', title: 'Park', featuredImage: 'img_a' }
    );
    const before = assetUsages(site());
    const used = assetUsages(s);
    // Two featured images and one picture field use img_a; img_b only as the field's default, never as a client's name.
    expect((used.img_a ?? 0) - (before.img_a ?? 0)).toBe(3);
    expect((used.img_b ?? 0) - (before.img_b ?? 0)).toBe(1);
    expect(() => apply(s, [{ type: 'asset.remove', assetId: 'img_a' }])).toThrow(/used 3 times/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', featuredImage: 'doc_a' }])).toThrow(/not a picture/);
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', featuredImage: 'img_missing' }])).toThrow(/not in the library/);
    s = run(s, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b' }, { type: 'asset.remove', assetId: 'img_a' });
    expect(s.collections.projects.entries.en_hall).toMatchObject({ featuredImage: 'img_b', values: { hero: { assetId: 'img_b' } } });
    expect(s.collections.projects.entries.en_park.featuredImage).toBe('img_b');
    // Removing the entries frees the image.
    s = run(s, { type: 'collection.update', collectionId: 'projects', fields: {} }, { type: 'collection.remove', collectionId: 'projects' });
    expect(assetUsages(s).img_b ?? 0).toBe(before.img_b ?? 0);
    expect(run(s, { type: 'asset.remove', assetId: 'img_b' }).assets.assets).not.toHaveProperty('img_b');
  });

  it('moves picture field defaults and values to a replacement image, their suggested descriptions with them', () => {
    const base = site();
    base.assets.assets.img_a.altSuggestion = 'Old view';
    base.assets.assets.img_b.altSuggestion = 'New view';
    let s = run(
      base,
      { type: 'collection.create', collectionId: 'projects', fields: { hero: { type: 'image', label: 'Hero', default: { assetId: 'img_a', alt: 'Old view' } } } },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Hall', values: { hero: { assetId: 'img_a', alt: 'Old view' } } },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_park', title: 'Park', values: { hero: { assetId: 'img_a', alt: 'The park at dusk' } }, featuredImage: 'img_a' }
    );
    s = run(s, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b' }, { type: 'asset.remove', assetId: 'img_a' });
    expect(s.collections.projects.settings.fields.hero.default).toEqual({ assetId: 'img_b', alt: 'New view' });
    expect(s.collections.projects.entries.en_hall.values.hero).toEqual({ assetId: 'img_b', alt: 'New view' });
    expect(s.collections.projects.entries.en_park.values.hero).toEqual({ assetId: 'img_b', alt: 'The park at dusk' });
    expect(s.assets.assets).not.toHaveProperty('img_a');
    // A copy of the same picture keeps every description.
    const copy = run(base, { type: 'collection.create', collectionId: 'projects', fields: { hero: { type: 'image', label: 'Hero', default: { assetId: 'img_a', alt: 'Old view' } } } }, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b', keepAlt: true });
    expect(copy.collections.projects.settings.fields.hero.default).toEqual({ assetId: 'img_b', alt: 'Old view' });
    // Removing a featured image is one use fewer.
    const before = assetUsages(s).img_b;
    expect(assetUsages(run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_park', featuredImage: null })).img_b).toBe(before - 1);
    // An image is an asset ID or nothing.
    expect(() => apply(s, [{ type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { hero: { assetId: ['img_b'], alt: 'x' } } }])).toThrow(/assetId must be an asset ID or null/);
    expect(run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_hall', values: { hero: { assetId: '', alt: '' } } }).collections.projects.entries.en_hall.values.hero).toEqual({ assetId: null, alt: '' });
  });

  it('leaves collections showing the old image when only chosen places are replaced', () => {
    const s = run(
      site(),
      { type: 'site.update', favicon: 'img_a' },
      { type: 'collection.create', collectionId: 'projects', fields: { hero: { type: 'image', label: 'Hero', default: { assetId: 'img_a', alt: '' } } } },
      { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Hall', featuredImage: 'img_a', values: { hero: { assetId: 'img_a', alt: '' } } }
    );
    // Collections' uses have no place a replacement can name, so they change only with every other use.
    const some = run(s, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b', uses: [{ kind: 'site', field: 'favicon' }] });
    expect(some.site.favicon).toBe('img_b');
    expect(some.collections.projects.entries.en_hall).toMatchObject({ featuredImage: 'img_a', values: { hero: { assetId: 'img_a' } } });
    expect(some.collections.projects.settings.fields.hero.default).toMatchObject({ assetId: 'img_a' });
    const all = run(s, { type: 'asset.replace', assetId: 'img_a', withAssetId: 'img_b' });
    expect(all.site.favicon).toBe('img_b');
    expect(all.collections.projects.entries.en_hall).toMatchObject({ featuredImage: 'img_b', values: { hero: { assetId: 'img_b' } } });
    expect(all.collections.projects.settings.fields.hero.default).toMatchObject({ assetId: 'img_b' });
  });

  it('reports what hand edits break: shared addresses, damaged entries, missing pictures and broken links', () => {
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', featuredImage: 'img_a', body: ['[About](/about/)'] });
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const broken = structuredClone(s);
    broken.collections.posts.entries.en_winter.slug = pageAt(s, '/about/').route.slice(1, -1);
    broken.collections.posts.settings.route = '/';
    const codes = (st: ProjectState) => validateState(st).map((d) => d.code);
    expect(codes(broken)).toContain('ROUTE_INVALID');
    const clash = structuredClone(s);
    clash.pages[pageAt(s, '/about/').id].route = '/blog/winter-hours/';
    expect(validateState(clash).find((d) => d.code === 'ROUTE_DUPLICATE')?.message).toMatch(/About and the entry “Winter hours” share \/blog\/winter-hours\//);
    const kept = structuredClone(s);
    kept.site.redirects = [{ from: '/blog/', pageId: pageAt(s, '/about/').id }];
    expect(validateState(kept).find((d) => d.code === 'ROUTE_DUPLICATE')?.message).toMatch(/The old address \/blog\/ and the Posts collection share \/blog\//);
    const gone = structuredClone(s);
    delete gone.assets.assets.img_a;
    delete gone.pages[pageAt(s, '/about/').id];
    gone.site.pageOrder = gone.site.pageOrder.filter((id) => gone.pages[id]);
    gone.collections.posts.entries.en_winter.terms = { tags: ['nope'] };
    gone.collections.posts.entries.en_winter.publishedAt = 'soon';
    expect(codes(gone)).toEqual(expect.arrayContaining(['ASSET_MISSING', 'LINK_BROKEN', 'TERM_UNKNOWN', 'ENTRY_DATE_INVALID']));
    const damaged = structuredClone(s);
    (damaged.collections.posts.entries.en_winter as { body: unknown }).body = 'text';
    expect(codes(damaged)).toContain('ENTRY_INVALID');
    // Each check on its own, named on its entry.
    const only = (mutate: (st: ProjectState) => void, code: string, message: RegExp) => {
      const st = structuredClone(s);
      mutate(st);
      const found = validateState(st).filter((d) => d.code === code && d.owner?.kind === 'entry');
      expect(found.map((d) => d.message).join('\n'), code).toMatch(message);
    };
    only((st) => (st.collections.posts.entries.en_winter.body = [{ type: 'p', spans: [{ text: 'x', link: { type: 'page', target: 'pg_gone' } }] }]), 'LINK_BROKEN', /a page that no longer exists/);
    only((st) => (st.collections.posts.entries.en_winter.body = [{ type: 'p', spans: [{ text: 'x', link: { type: 'entry', target: 'en_gone' } }] }]), 'LINK_BROKEN', /an entry that no longer exists/);
    only((st) => (st.collections.posts.entries.en_winter.slug = 'bad/slug'), 'ROUTE_INVALID', /its slug is not one lowercase part/);
    only((st) => ((st.collections.posts.entries.en_winter as { body: unknown }).body = [{}]), 'ENTRY_INVALID', /is damaged/);
    only((st) => (st.collections.posts.entries.en_winter.featuredImage = 'doc_a'), 'ASSET_NOT_IMAGE', /“Guide doc_a”, which is a document/);
    // An old page address on an entry's own address.
    const kept2 = structuredClone(s);
    kept2.site.redirects = [{ from: '/blog/winter-hours/', pageId: pageAt(s, '/about/').id }];
    expect(validateState(kept2).find((d) => d.code === 'ROUTE_DUPLICATE')?.owner).toEqual({ kind: 'entry', id: 'en_winter' });
    // A damaged choice field is reported, never thrown on.
    const choice = run(s, { type: 'collection.update', collectionId: 'posts', fields: { mood: { type: 'enum', label: 'Mood', options: ['calm'] } } }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_winter', values: { mood: 'calm' } });
    (choice.collections.posts.settings.fields.mood as { options: unknown }).options = 'calm';
    expect(codes(choice)).toContain('COLLECTION_INVALID');
    for (const options of [[], [{}]]) {
      (choice.collections.posts.settings.fields.mood as { options: unknown }).options = options;
      expect(codes(choice), JSON.stringify(options)).toContain('COLLECTION_INVALID');
    }
  });

  it('accepts every operation through the shared validator', () => {
    const ops: unknown[] = [
      { type: 'collection.create', collectionId: 'posts', route: '/blog/' },
      { type: 'collection.update', collectionId: 'posts', taxonomies: { tags: { label: 'Tags', terms: { a: { label: 'A' } } } } },
      { type: 'collection.remove', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', title: 'Hi', body: 'Text' },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_abcd', updatedAt: null },
      { type: 'entry.reorder', collectionId: 'posts', entryIds: null },
      { type: 'entry.remove', collectionId: 'posts', entryId: 'en_abcd', replacementEntryId: 'en_efgh' }
    ];
    for (const op of ops) expect(validateOperation(op).ok, JSON.stringify(op)).toBe(true);
    for (const op of [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_abcd', draft: 'false' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'wrong', title: 'Hi' },
      { type: 'entry.reorder', collectionId: 'posts', entryIds: 'en_abcd' },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_abcd', publishedAt: '1 May 2026' }
    ])
      expect(validateOperation(op).ok, JSON.stringify(op)).toBe(false);
    // Object-prototype names are never keys or IDs.
    expect(validateOperation({ type: 'entry.update', collectionId: 'posts', entryId: 'en_abcd', terms: JSON.parse('{"__proto__": ["x"]}') }).ok).toBe(false);
    expect(validateOperation({ type: 'entry.update', collectionId: 'posts', entryId: '__proto__' }).ok).toBe(false);
  });

  it('is never offered to the assistant', () => {
    const offered = JSON.stringify([toolDefinitions(), toolDefinitions({ codeEnabled: false }), toolDefinitions({ codeEnabled: false, definitionOps: true }), toolDefinitions({ codeEnabled: true, definitionOps: true })]);
    expect(offered).toContain('"page.create"');
    for (const t of ['collection.create', 'collection.update', 'collection.remove', 'entry.create', 'entry.update', 'entry.reorder', 'entry.remove']) expect(offered).not.toContain(`"${t}"`);
  });
});

describe('collections format', () => {
  it('is format 8, which stamps collection and entry documents like any other', () => {
    // Released as the seventh migration, upgrading format 7 to 8; the later UI state step (8 to 9) only changes the version.
    expect(MIGRATIONS.findIndex((m) => m.id === 'collections') + 1).toBe(7);
    expect(MIGRATIONS.slice(7).map((m) => m.id)).toEqual(['ui-state']);
    expect(SCHEMA_VERSION).toBe(9);
    const s = run(blog(), { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: ['**Bold** [link](entry:en_winter)'], terms: {}, author: 'Ana' });
    for (const d of [s.manifest, s.site, s.tokens, s.assets, s.themeLock, ...Object.values(s.pages), ...Object.values(s.components)]) d.schemaVersion = 7;
    s.collections.posts.settings.schemaVersion = 7;
    s.collections.posts.entries.en_spring.schemaVersion = 7;
    const r = migrateProject(s)!;
    expect(r).toMatchObject({ from: 7, to: 9, applied: ['collections', 'ui-state'] });
    expect(r.state.collections.posts.settings.schemaVersion).toBe(9);
    expect(r.state.collections.posts.entries.en_spring.schemaVersion).toBe(9);
    // Nothing else changes.
    expect({ ...r.state.collections.posts.entries.en_spring, schemaVersion: 7 }).toEqual(s.collections.posts.entries.en_spring);
    expect({ ...r.state.collections.posts.settings, schemaVersion: 7 }).toEqual(s.collections.posts.settings);
    // A newer entry alone makes the whole project newer than this app.
    const newer = blog();
    newer.collections.posts.entries.en_winter.schemaVersion = 10;
    expect(migrateProject(newer)).toBeNull();
  });
});
