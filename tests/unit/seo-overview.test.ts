/**
 * The SEO view's overview (#707): one row per page and collection entry, drafts included, with its effective title and
 * description, how each measures up, whether it repeats another document's, its sharing image and whether it is
 * hidden from search engines. Where the audit speaks (published documents search engines may list), the two agree.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { runSeoAudit } from '@engine/seo-audit';
import { SEO_DESCRIPTION_RANGE, SEO_TITLE_RANGE } from '@engine/seo-rules';
import { countSeoOverviews, seoOverview, seoOverviewOnce, seoOverviewProblems, seoTextStatus, type SeoOverviewRow } from '../../src/renderer/src/lib/seo-overview';
import { copy, run, seoSite } from './fixtures/seo-site';

const x = (n: number) => 'x'.repeat(n);
const row = (rows: SeoOverviewRow[], key: string) => rows.find((r) => r.key === key)!;
const HOME = (s: ProjectState) => `page:${s.site.homePageId}`;
const SERVICES = 'page:pg_services';
const SPRING = 'entry:posts:en_spring';

/** The text findings the audit makes, as `{key} {code}`, and the ones the overview's listed rows make. */
const TEXT_CODES = /^SEO_(TITLE|DESCRIPTION)_(MISSING|DUPLICATE|LENGTH)$/;
function auditText(s: ProjectState): string[] {
  return runSeoAudit(s)
    .filter((f) => TEXT_CODES.test(f.code))
    .map((f) => {
      const key = f.owner!.kind === 'page' ? `page:${f.owner!.id}` : `entry:posts:${f.owner!.id}`;
      return `${key} ${f.code}`;
    })
    .sort();
}
function overviewText(s: ProjectState): string[] {
  const code = { 'title-missing': 'SEO_TITLE_MISSING', 'title-duplicate': 'SEO_TITLE_DUPLICATE', 'title-length': 'SEO_TITLE_LENGTH', 'description-missing': 'SEO_DESCRIPTION_MISSING', 'description-duplicate': 'SEO_DESCRIPTION_DUPLICATE', 'description-length': 'SEO_DESCRIPTION_LENGTH' } as Record<string, string>;
  return seoOverview(s)
    .filter((r) => r.listed)
    .flatMap((r) => r.problems.filter((p) => code[p]).map((p) => `${r.key} ${code[p]}`))
    .sort();
}

describe('seoOverview', () => {
  it('gives a well set-up site a row per document, each in order and with nothing to fix', () => {
    const { state } = seoSite();
    const rows = seoOverview(state);
    expect(rows.map((r) => r.key)).toEqual([HOME(state), SERVICES, SPRING]);
    expect(rows.every((r) => r.level === 'ok' && r.problems.length === 0 && r.listed)).toBe(true);
    expect(row(rows, HOME(state))).toMatchObject({ name: 'Home', address: '/', home: true, draft: false, noindex: false, collection: '', image: 'site' });
    expect(row(rows, HOME(state)).title).toEqual({ text: 'Riverside Studio · Pottery classes and handmade work', chars: 52, status: 'good', fallback: false, duplicates: 0, peers: [] });
    // An entry's title is branded with the site's name, and its description is its excerpt.
    expect(row(rows, SPRING)).toMatchObject({ name: 'Spring pottery classes', collection: 'Posts', address: '/blog/spring-pottery-classes/' });
    expect(row(rows, SPRING).title).toMatchObject({ text: 'Spring pottery classes · Riverside Studio', fallback: true, status: 'good' });
    expect(row(rows, SPRING).description).toMatchObject({ text: 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.', fallback: true });
    expect(seoOverviewProblems(rows)).toEqual([]);
  });

  it('measures titles and descriptions on the ranges the audit and the length meters use', () => {
    expect(SEO_TITLE_RANGE).toEqual({ min: 15, max: 60 });
    expect([0, 14, 15, 60, 61].map((n) => seoTextStatus(x(n), 'title').status)).toEqual(['missing', 'short', 'good', 'good', 'long']);
    expect(SEO_DESCRIPTION_RANGE).toEqual({ min: 50, max: 160 });
    expect([49, 50, 160, 161].map((n) => seoTextStatus(x(n), 'description').status)).toEqual(['short', 'good', 'good', 'long']);
    // Spaces are collapsed and an accented letter or emoji counts once, as a reader counts it.
    expect(seoTextStatus('  café   🎉 ', 'title')).toEqual({ text: 'café 🎉', chars: 6, status: 'short' });
    expect(seoTextStatus('   ', 'title').status).toBe('missing');
  });

  it('agrees with the audit on every title and description finding for published documents', () => {
    const { state, home, services } = seoSite();
    const variants: ProjectState[] = [
      state,
      run(state, { type: 'page.update', pageId: services, seoTitle: x(10), description: x(170) }),
      run(state, { type: 'page.update', pageId: services, seoTitle: state.pages[home].seo.title!.toUpperCase() }),
      run(state, { type: 'page.update', pageId: home, description: '' }, { type: 'page.update', pageId: services, description: '' }),
      run(state, { type: 'site.update', description: '' }, { type: 'page.update', pageId: services, description: '' }),
      run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', excerpt: 'Short.' }),
      run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: 'Classes and commissions · Riverside Studio' }),
      // Hidden from search engines: the audit judges neither its words nor its repeats.
      run(state, { type: 'page.update', pageId: services, noindex: true, seoTitle: state.pages[home].seo.title!, description: '' })
    ];
    for (const s of variants) expect(overviewText(s)).toEqual(auditText(s));
    // And the variants do find something, so the agreement is not two empty lists.
    expect(variants.slice(1, -1).every((s) => auditText(s).length > 0)).toBe(true);
  });

  it('flags a repeated title or description on every document involved', () => {
    const { state, home, services } = seoSite();
    const dup = run(state, { type: 'page.update', pageId: services, seoTitle: state.pages[home].seo.title!.toUpperCase().replace(/ /g, '  ') });
    const rows = seoOverview(dup);
    expect(row(rows, HOME(dup)).title.duplicates).toBe(1);
    expect(row(rows, SERVICES).title.duplicates).toBe(1);
    expect(row(rows, HOME(dup)).problems).toEqual(['title-duplicate']);
    expect(row(rows, SERVICES).level).toBe('warning');
    // Problems first, then the rest in the view's order.
    expect(rows.map((r) => r.key)).toEqual([HOME(dup), SERVICES, SPRING]);
    // Two pages left to the site's description share it, and a draft with the same words repeats both.
    const inherited = run(
      state,
      { type: 'page.update', pageId: home, description: '' },
      { type: 'page.update', pageId: services, description: '' },
      { type: 'page.create', pageId: 'pg_draft', title: 'Prices', route: '/prices/' },
      { type: 'page.update', pageId: 'pg_draft', draft: true, description: '' }
    );
    const shared = seoOverview(inherited);
    expect([HOME(inherited), SERVICES].map((k) => [row(shared, k).description.duplicates, row(shared, k).description.fallback, row(shared, k).problems])).toEqual([
      [1, true, ['description-duplicate']],
      [1, true, ['description-duplicate']]
    ]);
    expect(row(shared, 'page:pg_draft').description.duplicates).toBe(2);
  });

  it('keeps documents in different languages apart', () => {
    const { state, home, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, seoTitle: state.pages[home].seo.title! });
    const other = copy(s);
    other.pages[services].language = 'fr';
    expect(row(seoOverview(s), SERVICES).problems).toEqual(['title-duplicate']);
    expect(row(seoOverview(other), SERVICES).problems).toEqual([]);
  });

  it('lists drafts with a status of their own, repeating only what search engines already list', () => {
    const { state, home } = seoSite();
    const s = run(
      state,
      { type: 'page.create', pageId: 'pg_draft', title: 'Prices', route: '/prices/' },
      { type: 'page.update', pageId: 'pg_draft', draft: true, seoTitle: state.pages[home].seo.title!, description: x(20) },
      { type: 'page.create', pageId: 'pg_draft2', title: 'Prices again', route: '/prices-again/' },
      { type: 'page.update', pageId: 'pg_draft2', draft: true, seoTitle: 'A draft title of fair length', description: 'The same draft description, shared by two drafts and nothing else.' },
      { type: 'page.create', pageId: 'pg_draft3', title: 'Prices third', route: '/prices-third/' },
      { type: 'page.update', pageId: 'pg_draft3', draft: true, seoTitle: 'Another draft title, fair length', description: 'The same draft description, shared by two drafts and nothing else.' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_draft', title: 'Winter', publishedAt: '2026-12-01', excerpt: '' }
    );
    const rows = seoOverview(s);
    const draft = row(rows, 'page:pg_draft');
    expect(draft).toMatchObject({ draft: true, listed: false, name: 'Prices' });
    // It would compete with Home's title once published; Home itself is not repeated by a draft.
    expect(draft.title.duplicates).toBe(1);
    expect(draft.problems).toEqual(['title-duplicate', 'description-length']);
    expect(row(rows, HOME(s)).problems).toEqual([]);
    // Two drafts sharing words repeat nothing search engines list.
    expect(row(rows, 'page:pg_draft2').problems).toEqual([]);
    expect(row(rows, 'page:pg_draft3').problems).toEqual([]);
    // A draft entry with no excerpt falls back to the site's description.
    const entry = row(rows, 'entry:posts:en_draft');
    expect(entry).toMatchObject({ draft: true, collection: 'Posts' });
    expect(entry.description).toMatchObject({ text: s.site.description, fallback: true });
    // The audit, which never judges drafts, still agrees on the published ones.
    expect(overviewText(s)).toEqual(auditText(s));
    expect(auditText(s)).toEqual([]);
  });

  it('says where each sharing image comes from, and when there is none', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, socialImage: 'img_bowls' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', featuredImage: 'img_bowls' });
    let rows = seoOverview(s);
    expect([HOME(s), SERVICES, SPRING].map((k) => row(rows, k).image)).toEqual(['site', 'own', 'featured']);
    const gone = copy(s);
    delete gone.assets.assets.img_bowls;
    delete gone.assets.assets.img_share;
    rows = seoOverview(gone);
    expect([HOME(gone), SERVICES, SPRING].map((k) => row(rows, k).image)).toEqual(['gone', 'gone', 'gone']);
    expect(rows.every((r) => r.problems.includes('image-missing') && r.level === 'warning')).toBe(true);
    rows = seoOverview(run(state, { type: 'site.update', socialImage: null }));
    expect(rows.every((r) => r.image === 'none' && r.problems.includes('image-missing'))).toBe(true);
    // The audit rolls them up into one finding for the site; the overview flags each document it covers.
    expect(runSeoAudit(run(state, { type: 'site.update', socialImage: null })).filter((f) => f.code === 'SEO_SOCIAL_IMAGE_MISSING')).toHaveLength(1);
  });

  it('says which documents are hidden from search engines, a problem only on Home', () => {
    const { state, home, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, noindex: true }, { type: 'page.update', pageId: home, noindex: true });
    const rows = seoOverview(s);
    // A document search engines can't list is kept out of search: not one of the documents with something to fix.
    expect(row(rows, SERVICES)).toMatchObject({ noindex: true, listed: false, problems: [], level: 'excluded' });
    expect(row(rows, HOME(s))).toMatchObject({ noindex: true, problems: ['home-hidden'], level: 'warning' });
    expect(runSeoAudit(s).map((f) => f.code)).toContain('SEO_HOME_NOINDEX');
    const post = row(seoOverview(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', noindex: true })), SPRING);
    expect(post).toMatchObject({ noindex: true, listed: false, level: 'excluded' });
    expect(seoOverviewProblems(rows).map((r) => r.key)).toEqual([HOME(s)]);
  });

  it('puts warnings first, then notes, each in the view’s order', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'page.update', pageId: services, seoTitle: x(10) }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', excerpt: '' });
    const noDescription = run(s, { type: 'site.update', description: '' });
    const rows = seoOverview(noDescription);
    expect(rows.map((r) => [r.key, r.level])).toEqual([
      [SPRING, 'warning'],
      [SERVICES, 'note'],
      [HOME(s), 'ok']
    ]);
    expect(seoOverviewProblems(rows).map((r) => r.key)).toEqual([SPRING, SERVICES]);
  });

  it('leaves out a record too damaged to read, and still lists the rest', () => {
    const { state } = seoSite();
    const damaged = copy(state);
    // A page with no address and an entry that is not one, as a project edited outside the app might have them.
    (damaged.pages as Record<string, unknown>).pg_broken = { id: 'pg_broken', title: 'Broken' };
    damaged.site.pageOrder.push('pg_broken');
    (damaged.collections.posts.entries as Record<string, unknown>).en_broken = null;
    expect(seoOverview(damaged).map((r) => r.key)).toEqual([HOME(state), SERVICES, SPRING]);
  });

  it('leaves out a draft the resolver can’t read, where the audit never looks', () => {
    const { state } = seoSite();
    const s = copy(run(state, { type: 'page.create', pageId: 'pg_draft', title: 'Prices', route: '/prices/' }, { type: 'page.update', pageId: 'pg_draft', draft: true }));
    (s.pages.pg_draft.seo as Record<string, unknown>).socialImage = { toString: null };
    expect(() => runSeoAudit(s)).not.toThrow();
    expect(seoOverview(s).map((r) => r.key)).toEqual([HOME(state), SERVICES, SPRING]);
  });

  it('lists a document once however often a hand-edited entry order names it', () => {
    const { state } = seoSite();
    const s = copy(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', excerpt: 'Short.' }));
    s.collections.posts.settings.entryOrder = ['en_spring', 'en_spring'];
    const rows = seoOverview(s);
    expect(rows.map((r) => r.key)).toEqual([SPRING, HOME(state), SERVICES]);
    expect(overviewText(s)).toEqual(auditText(s));
  });

  it('works a saved state out once, and a new one again', () => {
    const { state, services } = seoSite();
    expect(seoOverviewOnce(state)).toBe(seoOverviewOnce(state));
    const next = run(state, { type: 'page.update', pageId: services, seoTitle: x(10) });
    const first = seoOverviewOnce(state);
    expect(row(seoOverviewOnce(next), SERVICES).problems).toEqual(['title-length']);
    expect(seoOverviewOnce(state)).toBe(first);
  });

  it('tells the timing marks of each overview it works out, and of none it already has', () => {
    const { state, services } = seoSite();
    let worked = 0;
    countSeoOverviews(() => worked++);
    try {
      seoOverviewOnce(state);
      seoOverviewOnce(state);
      const next = run(state, { type: 'page.update', pageId: services, seoTitle: x(10) });
      seoOverviewOnce(next);
      seoOverviewOnce(next);
      expect(worked).toBe(2);
    } finally {
      countSeoOverviews(null);
    }
  });

  it('stays quick on a site with a few hundred documents', () => {
    const { state } = seoSite();
    const ops = Array.from({ length: 300 }, (_, i) => ({ type: 'entry.create' as const, collectionId: 'posts', entryId: `en_${i}`, title: `Post number ${i}`, publishedAt: '2026-01-01', draft: i % 3 === 0, excerpt: i % 2 ? 'The same excerpt for half of the posts, long enough to read well.' : '' }));
    const big = run(state, ...ops);
    const start = performance.now();
    const rows = seoOverview(big);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(rows).toHaveLength(303);
    // The published posts sharing an excerpt each repeat the others; the drafts among them repeat all of those.
    const shared = rows.filter((r) => r.key.startsWith('entry:posts:en_') && r.key !== SPRING && r.description.text.startsWith('The same excerpt'));
    const listedCount = shared.filter((r) => r.listed).length;
    expect(listedCount).toBeGreaterThan(1);
    expect(shared.every((r) => r.description.duplicates === (r.listed ? listedCount - 1 : listedCount))).toBe(true);
  });
});
