/**
 * The shared SEO metadata and visibility contract (#580): what each page and collection entry says to search engines
 * and link previews, with every fallback applied, and which of the website's outputs include it. The generated
 * sitemap, site search index and page heads must agree with it, so features reading it see what the export ships.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { seoLength, seoText } from '@shared/seo';
import { pageSharing } from '@shared/sharing';
import { createStarterState } from '@catalogue/starters';
import { createSeoResolver } from '@generator/seo-metadata';
import { entryFile, generateEntry, generatePage, generateProject, generateSitemap, pageFile } from '@generator/index';
import { buildSearchIndex } from '@generator/search';
import { copy, run, seoSite } from './fixtures/seo-site';

const page = (s: ProjectState, pageId: string) => createSeoResolver(s).resolve({ kind: 'page', pageId })!;
const post = (s: ProjectState, entryId = 'en_spring', collectionId = 'posts') => createSeoResolver(s).resolve({ kind: 'entry', collectionId, entryId })!;
const sitemapUrls = (s: ProjectState) => [...(generateSitemap(s) ?? '').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
const titleIn = (svelte: string) => /<title>\{"([^"]*)"\}<\/title>/.exec(svelte)?.[1];

describe('createSeoResolver', () => {
  it('reads an older project with no collections and pages without search settings', () => {
    const s = copy(createStarterState('business', 'Riverside Studio', false));
    // Stored before collections, and hand-edited without search settings: neither is there at all.
    delete (s as Partial<ProjectState>).collections;
    const [, about] = s.site.pageOrder;
    delete (s.pages[about] as { seo?: unknown }).seo;
    s.site.description = 'Pottery by the river.';
    const resolver = createSeoResolver(s);
    const docs = resolver.published();
    expect(docs.map((d) => d.subject)).toEqual(s.site.pageOrder.map((pageId) => ({ kind: 'page', pageId })));
    const meta = resolver.resolve({ kind: 'page', pageId: about })!;
    expect(meta).toMatchObject({ title: `${s.pages[about].title} · Riverside Studio`, description: 'Pottery by the river.', language: 'en', noindex: false, searchHidden: false, imageSource: 'none', image: undefined });
    // No public URL: no address to list it at, though search engines may still list it where they find it.
    expect(meta).toMatchObject({ url: null, canonical: null, imageUrl: null });
    expect(meta.visibility).toEqual({ website: true, indexable: true, sitemap: false, siteSearch: true, jsonLd: false, news: false });
    expect(resolver.resolve({ kind: 'entry', collectionId: 'posts', entryId: 'en_any' })).toBeNull();
    expect(resolver.resolve({ kind: 'page', pageId: 'pg_gone' })).toBeNull();
    // The Inspector's preview reads the same page without failing.
    expect(pageSharing(s, s.pages[about]).title).toBe(meta.title);
  });

  it('keeps a draft page off every output while still describing it for the editor; Home is never a draft', () => {
    const { state, services, home } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, draft: true });
    const meta = page(s, services);
    expect(meta.draft).toBe(true);
    expect(meta.title).toBe('Classes and commissions · Riverside Studio');
    expect(meta.visibility).toEqual({ website: false, indexable: false, sitemap: false, siteSearch: false, jsonLd: false, news: false });
    expect(createSeoResolver(s).published().map((d) => d.subject)).not.toContainEqual({ kind: 'page', pageId: services });
    // The generated outputs agree, and keep the pages that are published.
    expect(sitemapUrls(s)).not.toContain('https://example.com/studio/services/');
    expect(sitemapUrls(s)).toContain('https://example.com/studio/');
    expect(buildSearchIndex(s).map((e) => e.route)).toEqual(['/']);
    expect(page(s, home).visibility).toMatchObject({ website: true, sitemap: true, siteSearch: true });
    // A Home page marked as a draft by hand is published all the same, as the generator publishes it.
    const homeDraft = copy(state);
    homeDraft.pages[home].draft = true;
    expect(page(homeDraft, home)).toMatchObject({ draft: false, visibility: { website: true, indexable: true, sitemap: true } });
  });

  it('keeps a noindex page in site search while leaving it out of the sitemap and structured data', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, noindex: true });
    expect(page(s, services)).toMatchObject({ noindex: true, searchHidden: false });
    expect(page(s, services).visibility).toEqual({ website: true, indexable: false, sitemap: false, siteSearch: true, jsonLd: false, news: false });
    expect(sitemapUrls(s)).not.toContain('https://example.com/studio/services/');
    expect(buildSearchIndex(s).map((e) => e.route)).toContain('/services/');
    // The page is published, asking search engines not to list it.
    expect(generateProject(s).get(pageFile(s.pages[services]))).toContain('<meta name="robots" content="noindex" />');
    // And the other way round: hidden from site search, listed by search engines.
    const hidden = run(state, { type: 'page.update', pageId: services, searchHidden: true });
    expect(page(hidden, services).visibility).toMatchObject({ website: true, indexable: true, sitemap: true, siteSearch: false });
    expect(buildSearchIndex(hidden).map((e) => e.route)).not.toContain('/services/');
  });

  it('publishes a searchHidden entry to search engines and leaves it out of site search', () => {
    const { state } = seoSite();
    const s = copy(state);
    s.collections.posts.entries.en_spring.seo = { searchHidden: true };
    expect(post(s)).toMatchObject({ draft: false, searchHidden: true, noindex: false, route: '/blog/spring-pottery-classes/', url: 'https://example.com/studio/blog/spring-pottery-classes/' });
    expect(post(s).visibility).toEqual({ website: true, indexable: true, sitemap: true, siteSearch: false, jsonLd: true, news: false });
    // Without the switch it belongs in site search; with or without it, the website has its page and the sitemap lists it.
    expect(post(state).visibility).toEqual({ website: true, indexable: true, sitemap: true, siteSearch: true, jsonLd: true, news: false });
    for (const x of [state, s]) {
      expect(sitemapUrls(x)).toContain('https://example.com/studio/blog/spring-pottery-classes/');
      expect(generateProject(x).has('src/routes/blog/spring-pottery-classes/+page.svelte')).toBe(true);
    }
    // A hand-edited value the switch would show as on hides it too, as a page's does.
    const truthy = copy(state);
    (truthy.collections.posts.entries.en_spring as { seo: unknown }).seo = { searchHidden: 1 };
    expect(post(truthy).visibility.siteSearch).toBe(false);
    // A draft entry is on no output; one with a damaged draft flag is a draft, as the website judges it.
    const draft = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true });
    expect(post(draft).visibility).toEqual({ website: false, indexable: false, sitemap: false, siteSearch: false, jsonLd: false, news: false });
    const damaged = copy(state);
    (damaged.collections.posts.entries.en_spring as { draft: unknown }).draft = 'no';
    expect(post(damaged).visibility.website).toBe(false);
  });

  it('describes an entry as its generated page does', () => {
    const { state } = seoSite();
    const meta = post(state);
    expect(meta).toMatchObject({
      title: 'Spring pottery classes · Riverside Studio',
      socialTitle: 'Spring pottery classes',
      description: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.',
      language: 'en',
      imageId: 'img_share',
      imageSource: 'site',
      imageUrl: 'https://example.com/studio/assets/img_share-1a2b3c4d.png'
    });
    const svelte = generateEntry(state, 'posts', 'en_spring');
    expect(titleIn(svelte)).toBe(meta.title);
    expect(svelte).toContain(`<meta property="og:title" content={${JSON.stringify(meta.socialTitle)}} />`);
    expect(entryFile(meta.route)).toBe('src/routes/blog/spring-pottery-classes/+page.svelte');
    // A featured image comes before the site's; one that is not a picture leaves it to the site's.
    const featured = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', featuredImage: 'img_bowls' });
    expect(post(featured)).toMatchObject({ imageId: 'img_bowls', imageSource: 'featured' });
    const broken = copy(featured);
    broken.assets.assets.img_bowls.kind = 'document';
    expect(post(broken)).toMatchObject({ imageId: 'img_share', imageSource: 'site' });
    // Without an excerpt the site's description stands in.
    const bare = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', excerpt: null });
    expect(post(bare).description).toBe(state.site.description);
    expect(generateEntry(bare, 'posts', 'en_spring')).toContain(`<meta name="description" content={${JSON.stringify(state.site.description)}} />`);
    // A library record without a file (written by hand) gives no image address, and nothing fails.
    const fileless = copy(featured);
    (fileless.assets.assets.img_bowls as { file: unknown }).file = null;
    expect(post(fileless)).toMatchObject({ imageId: 'img_bowls', imageUrl: null });
  });

  it('gives a page the title, description and image its head carries, in its own language', () => {
    const { state, services } = seoSite();
    const meta = page(state, services);
    expect(meta).toMatchObject({ title: 'Classes and commissions · Riverside Studio', socialTitle: 'Classes and commissions · Riverside Studio', imageSource: 'site', imageId: 'img_share' });
    const head = generatePage(state, state.pages[services], {});
    expect(titleIn(head)).toBe(meta.title);
    expect(meta.canonical).toBe('https://example.com/studio/services/');
    expect(head).toContain(`<link rel="canonical" href={${JSON.stringify(meta.canonical)}} />`);
    expect(head).toContain(`<meta name="description" content={${JSON.stringify(meta.description)}} />`);
    expect(head).toContain(`<meta property="og:image" content={${JSON.stringify(meta.imageUrl)}} />`);
    const french = run(state, { type: 'page.update', pageId: services, language: 'fr' });
    expect(page(french, services).language).toBe('fr');
    // A page's own image, gone from the library, is no image: it is not quietly given the site's.
    const s = copy(state);
    s.pages[services].seo.socialImage = 'img_gone';
    expect(page(s, services)).toMatchObject({ imageId: 'img_gone', image: undefined, imageSource: 'own', imageUrl: null });
  });

  it('marks a dated article page as one news lists show, unless it is hidden from them', () => {
    const { state } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_opening', title: 'Opening day', route: '/opening-day/', starter: 'article', articleDate: '2027-01-10' });
    expect(page(s, 'pg_opening').visibility.news).toBe(true);
    expect(page(run(s, { type: 'page.update', pageId: 'pg_opening', newsHidden: true }), 'pg_opening').visibility.news).toBe(false);
    expect(page(run(s, { type: 'page.update', pageId: 'pg_opening', draft: true }), 'pg_opening').visibility.news).toBe(false);
    expect(post(s).visibility.news).toBe(false);
    // An article whose date is not one (written by hand) is left out of news lists.
    const undated = copy(s);
    undated.pages.pg_opening.article!.date = '10 January';
    expect(page(undated, 'pg_opening').visibility.news).toBe(false);
  });

  it('gives the published entry an address a draft holds by hand, as the website does', () => {
    const { state } = seoSite();
    let s = run(state, { type: 'entry.create', collectionId: 'posts', entryId: 'en_later', title: 'Summer plans', publishedAt: '2027-06-01' });
    s = copy(s);
    // The newer draft is first in the collection's order, on the published entry's address.
    s.collections.posts.entries.en_later.slug = 'spring-pottery-classes';
    const resolver = createSeoResolver(s);
    expect(resolver.resolve({ kind: 'entry', collectionId: 'posts', entryId: 'en_spring' })).toMatchObject({ route: '/blog/spring-pottery-classes/', visibility: { website: true } });
    expect(resolver.resolve({ kind: 'entry', collectionId: 'posts', entryId: 'en_later' })?.visibility.website).toBe(false);
    expect(resolver.published().filter((d) => d.subject.kind === 'entry').map((d) => (d.subject as { entryId: string }).entryId)).toEqual(['en_spring']);
  });

  it('lists the published documents once each, pages in site order and then entries, and never changes the project', () => {
    const { state, home, services } = seoSite();
    const s = copy(state);
    s.site.pageOrder.push(services, 'pg_missing');
    s.pages.pg_stray = { ...s.pages[services], id: 'pg_stray', route: '/stray/' };
    const before = JSON.stringify(s);
    const docs = createSeoResolver(s).published();
    expect(docs.map((d) => d.subject)).toEqual([
      { kind: 'page', pageId: home },
      { kind: 'page', pageId: services },
      { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' }
    ]);
    // A page left out of the site's order has no page file: it is not on the website.
    expect(createSeoResolver(s).resolve({ kind: 'page', pageId: 'pg_stray' })?.visibility.website).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('encodes an address in another script as the sitemap does', () => {
    const { state } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_contact', title: 'お問い合わせ', route: '/お問い合わせ/' });
    const meta = page(s, 'pg_contact');
    expect(meta.url).toBe('https://example.com/studio/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B/');
    expect(meta.canonical).toBe(meta.url);
    expect(sitemapUrls(s)).toContain(meta.url);
    expect(meta.visibility.sitemap).toBe(true);
  });
});

describe('seo text helpers', () => {
  it('measures text as readers count it', () => {
    expect(seoText('  Pottery \n classes ')).toBe('Pottery classes');
    expect(seoText(7)).toBe('');
    expect(seoLength('Café 🏺')).toBe(6);
    // Composed and decomposed accents are the same text.
    expect(seoText('Café')).toBe(seoText('Café'));
  });
});
