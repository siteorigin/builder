/**
 * The exported sitemap (#596): well-formed XML listing what the shared visibility contract says it lists, each page and
 * entry with the day it last changed when that is known, and each version of a translated page with the same set of
 * alternate-language links (its own among them, and `x-default` for the version in the site's language).
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { generateProject, generateSitemap } from '@generator/index';
import { run, seoSite } from './fixtures/seo-site';

const SITE = 'https://example.com/studio';
const XHTML = 'http://www.w3.org/1999/xhtml';

/**
 * Check a document is well-formed XML, strictly enough for what a sitemap holds: one root element, every tag closed in
 * order, quoted attributes named once each, text and values with no bare "<" or "&" outside a known entity, and every
 * namespace prefix declared on the element or one around it. Throws with the reason when it is not.
 */
function assertWellFormed(xml: string): void {
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;
  let rest = xml.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, '');
  if (rest === xml) throw new Error('No XML declaration at the start.');
  const stack: Array<{ name: string; prefixes: Set<string> }> = [];
  let roots = 0;
  const declared = (prefix: string) => prefix === 'xml' || stack.some((e) => e.prefixes.has(prefix));
  while (rest) {
    const lt = rest.indexOf('<');
    const text = lt < 0 ? rest : rest.slice(0, lt);
    if (entity.test(text) || text.includes('>')) throw new Error(`Bad text: ${text}`);
    if (!stack.length && text.trim()) throw new Error(`Text outside the root: ${text}`);
    if (lt < 0) break;
    const tag = rest.slice(lt).match(/^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*)\s*(\/?)>/);
    if (!tag) throw new Error(`Bad tag at: ${rest.slice(lt, lt + 80)}`);
    rest = rest.slice(lt + tag[0].length);
    const [, close, name, attrText, selfClose] = tag;
    if (close) {
      if (attrText || selfClose || stack.pop()?.name !== name) throw new Error(`Mismatched </${name}>`);
      continue;
    }
    const attrs = [...attrText.matchAll(/([\w.:-]+)="([^"]*)"/g)];
    const names = attrs.map((a) => a[1]);
    if (new Set(names).size !== names.length) throw new Error(`Repeated attribute on <${name}>`);
    if (attrs.some((a) => entity.test(a[2]))) throw new Error(`Bad attribute value on <${name}>`);
    const prefixes = new Set(names.filter((n) => n.startsWith('xmlns:')).map((n) => n.slice(6)));
    if (!stack.length && roots++) throw new Error('More than one root element.');
    stack.push({ name, prefixes });
    for (const n of [name, ...names.filter((n) => !n.startsWith('xmlns'))]) {
      const prefix = n.includes(':') ? n.split(':')[0] : null;
      if (prefix && !declared(prefix)) throw new Error(`Undeclared prefix "${prefix}" on <${name}>`);
    }
    if (selfClose) stack.pop();
  }
  if (stack.length || roots !== 1) throw new Error('The document does not close its root element.');
}

/** Each listed address with its date and alternate links, in sitemap order; the sitemap checked well-formed first. */
function sitemapOf(s: ProjectState) {
  const xml = generateSitemap(s);
  expect(xml).not.toBeNull();
  assertWellFormed(xml!);
  const urls = [...xml!.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, body]) => ({
    loc: body.match(/<loc>([^<]*)<\/loc>/)![1],
    lastmod: body.match(/<lastmod>([^<]*)<\/lastmod>/)?.[1] ?? null,
    links: [...body.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map((m) => [m[1], m[2]])
  }));
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
      ok.replace('<?xml version="1.0" encoding="UTF-8"?>\n', '')
    ])
      expect(() => assertWellFormed(bad), bad).toThrow();
  });
});
