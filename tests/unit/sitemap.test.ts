/**
 * The exported sitemap (#596): well-formed XML listing what the shared visibility contract says it lists, each page and
 * entry with the day it last changed when that is known, and each version of a translated page with the same set of
 * alternate-language links (its own among them, and `x-default` for the version in the site's language).
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { generateProject, generateSitemap } from '@generator/index';
import { copy, run, seoSite } from './fixtures/seo-site';
import { assertWellFormed } from './fixtures/xml';

const SITE = 'https://example.com/studio';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** Each listed address with its date and alternate links, in sitemap order; the sitemap checked well-formed first. */
function sitemapOf(s: ProjectState) {
  const xml = generateSitemap(s);
  expect(xml).not.toBeNull();
  expect(assertWellFormed(xml!)).toBe('urlset');
  expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"(?: xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml")?>\n/);
  const urls = [...xml!.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, body]) => {
    // One address and at most one date each.
    expect(body.match(/<loc>/g)).toHaveLength(1);
    expect((body.match(/<lastmod>/g) ?? []).length).toBeLessThan(2);
    expect((body.match(/<xhtml:link /g) ?? []).length).toBe([...body.matchAll(/<xhtml:link rel="alternate" hreflang="[^"]+" href="[^"]+"\/>/g)].length);
    return body;
  }).map((body) => ({
    loc: body.match(/<loc>([^<]*)<\/loc>/)![1],
    lastmod: body.match(/<lastmod>([^<]*)<\/lastmod>/)?.[1] ?? null,
    links: [...body.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map((m) => [m[1], m[2]])
  }));
  expect(new Set(urls.map((u) => u.loc)).size, 'each address is listed once').toBe(urls.length);
  return { xml: xml!, urls, at: (loc: string) => urls.find((u) => u.loc === SITE + loc) };
}

/** The fixture's site with a dated article, a hidden page, a page that copies another site, and a draft. */
function singleLanguage() {
  const { state, services, home } = seoSite();
  const s = run(
    state,
    { type: 'page.create', pageId: 'pg_opening', title: 'Opening day', route: '/opening-day/', starter: 'article', articleDate: '2027-01-10' },
    { type: 'page.create', pageId: 'pg_hidden', title: 'Thank you', route: '/thank-you/' },
    { type: 'page.update', pageId: 'pg_hidden', noindex: true },
    { type: 'page.create', pageId: 'pg_copied', title: 'Press', route: '/press/' },
    { type: 'page.update', pageId: 'pg_copied', canonical: 'https://news.example.org/riverside-studio/' },
    { type: 'page.create', pageId: 'pg_plans', title: 'Plans', route: '/plans/' },
    { type: 'page.update', pageId: 'pg_plans', draft: true },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_quiet', title: 'Quiet notes', publishedAt: '2027-02-01', draft: false },
    { type: 'entry.update', collectionId: 'posts', entryId: 'en_quiet', noindex: true }
  );
  return { s, services, home };
}

/**
 * The fixture with Services in French and German too, linked as one set, and the English version moved last so the
 * set's first version is not the one in the site's language.
 */
function multiLanguage() {
  const { state, services, home } = seoSite();
  let s = run(
    state,
    { type: 'page.create', pageId: 'pg_french', title: 'Services FR', route: '/fr/services/' },
    { type: 'page.update', pageId: 'pg_french', language: 'fr', linkTranslationTo: services },
    { type: 'page.create', pageId: 'pg_german', title: 'Leistungen', route: '/de/leistungen/' },
    { type: 'page.update', pageId: 'pg_german', language: 'de', linkTranslationTo: services }
  );
  s = run(s, { type: 'page.reorder', pageIds: [home, 'pg_french', 'pg_german', services] });
  return { s, services, home };
}

describe('sitemap.xml', () => {
  it('lists a single-language site’s pages and posts with the day each last changed, and nothing it should not', () => {
    const { s, services } = singleLanguage();
    const { xml, urls, at } = sitemapOf(s);
    expect(xml).not.toContain('xmlns:xhtml');
    expect(xml).not.toContain('xhtml:link');
    // A dated article is dated by its publication day until it is revised; a page with neither date has none made up.
    expect(at('/opening-day/')).toMatchObject({ lastmod: '2027-01-10', links: [] });
    expect(at('/')?.lastmod).toBeNull();
    expect(at('/services/')?.lastmod).toBeNull();
    expect(at('/blog/spring-pottery-classes/')?.lastmod).toBe('2027-03-02');
    // Left out: a page and a post hidden from search engines, a copy of another site's page, a draft.
    for (const gone of ['/thank-you/', '/press/', '/plans/', '/blog/quiet-notes/']) expect(at(gone), gone).toBeUndefined();
    // Pages first in site order, then posts, then the blog's archive.
    expect(urls.map((u) => u.loc.slice(SITE.length))).toEqual(['/', '/services/', '/opening-day/', '/blog/spring-pottery-classes/', '/blog/']);

    const revised = run(s, { type: 'page.update', pageId: 'pg_opening', updatedAt: '2027-01-20' }, { type: 'page.update', pageId: services, updatedAt: '2027-02-05' });
    expect(sitemapOf(revised).at('/opening-day/')?.lastmod).toBe('2027-01-20');
    expect(sitemapOf(revised).at('/services/')?.lastmod).toBe('2027-02-05');
  });

  it('gives every listed version of a translated page the same alternates, with x-default for the site language', () => {
    const { s } = multiLanguage();
    const { xml, at } = sitemapOf(s);
    expect(xml).toContain(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="${XHTML}">`);
    const set = [
      ['fr', `${SITE}/fr/services/`],
      ['de', `${SITE}/de/leistungen/`],
      ['en', `${SITE}/services/`],
      ['x-default', `${SITE}/services/`]
    ];
    for (const loc of ['/fr/services/', '/de/leistungen/', '/services/']) expect(at(loc)?.links, loc).toEqual(set);
    // Pages without translations, and posts, carry none.
    expect(at('/')?.links).toEqual([]);
    expect(at('/blog/spring-pottery-classes/')).toMatchObject({ lastmod: '2027-03-02', links: [] });
    expect(at('/blog/')?.links).toEqual([]);
  });

  it('names only the versions it lists, and none once a set is down to one', () => {
    const { s, services } = multiLanguage();
    // English hidden from search engines: French and German still name each other, with no fallback to name.
    const hidden = sitemapOf(run(s, { type: 'page.update', pageId: services, noindex: true }));
    expect(hidden.at('/services/')).toBeUndefined();
    const pair = [
      ['fr', `${SITE}/fr/services/`],
      ['de', `${SITE}/de/leistungen/`]
    ];
    expect(hidden.at('/fr/services/')?.links).toEqual(pair);
    expect(hidden.at('/de/leistungen/')?.links).toEqual(pair);
    expect(hidden.xml).not.toContain('x-default');

    // German a draft, French a copy of an address elsewhere: English is left alone, with no links and no namespace.
    const alone = sitemapOf(run(s, { type: 'page.update', pageId: 'pg_german', draft: true }, { type: 'page.update', pageId: 'pg_french', canonical: 'https://example.fr/services/' }));
    expect(alone.at('/de/leistungen/')).toBeUndefined();
    expect(alone.at('/fr/services/')).toBeUndefined();
    expect(alone.at('/services/')?.links).toEqual([]);
    expect(alone.xml).not.toContain('xmlns:xhtml');
  });

  it('dates a translated page and links its versions on the same entry', () => {
    const { s } = multiLanguage();
    const dated = sitemapOf(run(s, { type: 'page.update', pageId: 'pg_french', updatedAt: '2027-04-01' }));
    expect(dated.at('/fr/services/')).toMatchObject({ lastmod: '2027-04-01', links: [expect.anything(), expect.anything(), expect.anything(), expect.anything()] });
    expect(dated.at('/de/leistungen/')?.lastmod).toBeNull();
  });

  it('names the version in the site’s language as x-default, whatever that language is', () => {
    const { s, services } = multiLanguage();
    // Edited by hand: the site in German, Services in English by its own choice.
    const german = copy(s);
    german.site.language = 'de';
    german.pages[services].language = 'en';
    const { at } = sitemapOf(german);
    expect(at('/services/')?.links).toEqual([
      ['fr', `${SITE}/fr/services/`],
      ['de', `${SITE}/de/leistungen/`],
      ['en', `${SITE}/services/`],
      ['x-default', `${SITE}/de/leistungen/`]
    ]);
    // Language codes compare without regard to case.
    const upper = copy(s);
    upper.site.language = 'EN';
    expect(sitemapOf(upper).at('/fr/services/')?.links.at(-1)).toEqual(['x-default', `${SITE}/services/`]);
  });

  it('keeps each translation set to itself, and links none of a set whose listed versions share a language', () => {
    const { s, home } = multiLanguage();
    const two = run(
      s,
      { type: 'page.create', pageId: 'pg_accueil', title: 'Accueil', route: '/fr/' },
      { type: 'page.update', pageId: 'pg_accueil', language: 'fr', linkTranslationTo: home }
    );
    const both = sitemapOf(two);
    const homeSet = [
      ['en', `${SITE}/`],
      ['fr', `${SITE}/fr/`],
      ['x-default', `${SITE}/`]
    ];
    expect(both.at('/')?.links).toEqual(homeSet);
    expect(both.at('/fr/')?.links).toEqual(homeSet);
    expect(both.at('/services/')?.links).toHaveLength(4);
    expect(both.at('/services/')?.links.map(([, href]) => href)).not.toContain(`${SITE}/fr/`);

    // Edited by hand: German retagged "FR", the same language as the French version in other letters.
    const clash = copy(two);
    clash.pages.pg_german.language = 'FR';
    const clashed = sitemapOf(clash);
    for (const loc of ['/services/', '/fr/services/', '/de/leistungen/']) expect(clashed.at(loc)?.links, loc).toEqual([]);
    // The other set is not affected.
    expect(clashed.at('/')?.links).toEqual(homeSet);
  });

  it('ships the same sitemap in the exported project, for a single-language and a multi-language site', () => {
    for (const { s } of [singleLanguage(), multiLanguage()]) {
      const file = generateProject(s).get('static/sitemap.xml')!;
      expect(file).toBe(generateSitemap(s));
      assertWellFormed(file);
    }
  });

  it('rejects malformed documents, so a pass means something', () => {
    const ok = '<?xml version="1.0" encoding="UTF-8"?>\n<a xmlns:x="u"><x:b c="1"/></a>\n';
    expect(() => assertWellFormed(ok)).not.toThrow();
    for (const bad of [
      ok.replace(' xmlns:x="u"', ''),
      ok.replace('c="1"', 'c="a&b"'),
      ok.replace('</a>', '</b>'),
      ok.replace('</a>\n', '</a>\n<a/>'),
      ok.replace('<x:b c="1"/>', '<x:b c="1" c="2"/>'),
      ok.replace('<?xml version="1.0" encoding="UTF-8"?>\n', ''),
      ok.replace('<x:b c="1"/>', '<x:b c="1"/>a & b'),
      ok.replace('<x:b c="1"/>', '<x:b c="1"/>&#0;'),
      ok.replace('</a>\n', '</a>\njunk'),
      ok.replace('</a>\n', ''),
      ok.replace('</a>', '</a\u00a0>')
    ])
      expect(() => assertWellFormed(bad), bad).toThrow();
  });
});
