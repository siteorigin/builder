/**
 * The SEO and agentic readiness audit (#580): rules over a project's state that say what keeps its website from being
 * found, shared and understood, each finding a Diagnostic with a pillar, an explanation, whether the AI can fix it and
 * where the author does. A well set-up site has no findings; each change below brings in exactly the one it should.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState, RichText } from '@shared/types';
import type { EditorDestination } from '@shared/api';
import type { SeoFinding } from '@shared/seo';
import { runSeoAudit, type SeoAuditRule } from '@engine/seo-audit';
import { BASELINE_SEO_RULES, linkWords, SEO_DESCRIPTION_RANGE, SEO_TITLE_RANGE } from '@engine/seo-rules';
import { diagnosticKey, validateState } from '@engine/validate';
import { treeFor } from '../../src/renderer/src/lib/model';
import { destinationLabel, noteState } from '../../src/renderer/src/lib/destinations';
import { copy, POST_BODY, run, seoSite } from './fixtures/seo-site';
import { withPublished } from '@shared/published';

/** The project once the website has been exported as it is now: its pages' addresses are kept working when they move (#890). */
const exported = (s: ProjectState): ProjectState => ({ ...s, published: withPublished(s.published, s) ?? s.published });

const codes = (s: ProjectState) => runSeoAudit(s).map((f) => f.code);
/** The SEO fixture as a project made before #586 has it: nothing said of who publishes the site. */
const unidentifiedSite = () => seoSite({ identity: false });

const only = (s: ProjectState, code: string) => runSeoAudit(s).filter((f) => f.code === code);
const x = (n: number) => 'x'.repeat(n);

/** A finding's destination names something the project has, as the editor would open it. */
function expectValidDestination(s: ProjectState, f: SeoFinding) {
  const d = f.destination as EditorDestination | undefined;
  if (!d) return;
  switch (d.kind) {
    case 'pageSeo':
      expect(Object.hasOwn(s.pages, d.pageId), f.code).toBe(true);
      break;
    case 'entry': {
      const entry = s.collections[d.collectionId]?.entries[d.entryId];
      expect(entry, f.code).toBeTruthy();
      if (d.picture) expect(entry.body.filter((b) => b.type === 'image').length).toBeGreaterThanOrEqual(d.picture);
      break;
    }
    case 'element':
      expect(Object.hasOwn(treeFor(s, d.owner)?.nodes ?? {}, d.nodeId), f.code).toBe(true);
      break;
    case 'site':
      expect(['baseUrl', 'favicon', 'socialImage', 'identity', 'logo', 'sameAs', 'llmsTxt', 'crawlerPolicy']).toContain(d.field);
      break;
    default:
      throw new Error(`Unexpected destination ${d.kind}`);
  }
  expect(destinationLabel(d)).toBeTruthy();
}

/** The shared header's placement. */
const headerOf = (s: ProjectState) => Object.values(s.site.shell.header.nodes).find((n): n is InstanceNode => n.kind === 'instance')!;

/** A header menu item, added by hand as a project edited outside the app might have it. */
function addMenuItem(s: ProjectState, label: string, link: unknown) {
  const inst = headerOf(s);
  (inst.props.links as unknown[]).push({ id: `i${(inst.props.links as unknown[]).length + 1}`, label, link });
  return inst.id;
}

describe('runSeoAudit on a well set-up site', () => {
  it('finds nothing', () => {
    const { state } = seoSite();
    expect(runSeoAudit(state)).toEqual([]);
    // Nor do drafts with every problem the rules know of: they are not on the website.
    const s = run(
      state,
      { type: 'page.create', pageId: 'pg_secret', title: 'Secret', route: '/secret/' },
      { type: 'page.update', pageId: 'pg_secret', draft: true },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_draft', title: 'Draft', body: [{ type: 'h4', spans: [{ text: 'Deep' }] }, { type: 'image', assetId: 'img_bowls', alt: '' }] }
    );
    expect(runSeoAudit(s)).toEqual([]);
    // Published, the same documents are judged.
    const live = run(s, { type: 'page.update', pageId: 'pg_secret', draft: false }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_draft', draft: false, body: [{ type: 'h2', spans: [{ text: 'Top' }] }, { type: 'h4', spans: [{ text: 'Deep' }] }, { type: 'image', assetId: 'img_bowls', alt: '' }] });
    expect(new Set(codes(live))).toEqual(new Set(['SEO_PAGE_UNLINKED', 'SEO_DESCRIPTION_DUPLICATE', 'SEO_ENTRY_HEADING_SKIP', 'ALT_MISSING']));
  });
});

describe('baseline rules', () => {
  it('says when the public URL is missing or cannot be used, leading to the Public URL field', () => {
    const { state } = seoSite();
    const missing = only(run(state, { type: 'site.update', baseUrl: '' }), 'SEO_BASE_URL_MISSING');
    expect(missing).toEqual([expect.objectContaining({ severity: 'warning', pillar: 'technical', site: 'baseUrl', aiFixable: false, destination: { kind: 'site', field: 'baseUrl' } })]);
    expect(missing[0].owner).toBeUndefined();
    const bad = copy(state);
    bad.site.baseUrl = 'ftp://example.com';
    expect(only(bad, 'SEO_BASE_URL_INVALID')).toEqual([expect.objectContaining({ message: expect.stringContaining('“ftp://example.com” can’t be used'), destination: { kind: 'site', field: 'baseUrl' } })]);
    expect(codes(run(state, { type: 'site.update', baseUrl: '' }))).toContain('SEO_BASE_URL_MISSING');
    const query = copy(state);
    query.site.baseUrl = 'https://example.com/?ref=1';
    expect(codes(query)).toContain('SEO_BASE_URL_INVALID');
    const numeric = copy(state);
    (numeric.site as { baseUrl: unknown }).baseUrl = 42;
    expect(codes(numeric)).toContain('SEO_BASE_URL_INVALID');
    // Without one, the other rules still run.
    expect(codes(run(state, { type: 'site.update', baseUrl: '', favicon: null }))).toEqual(['SEO_BASE_URL_MISSING', 'SEO_FAVICON_MISSING']);
  });

  it('says when the Home page asks search engines not to list it', () => {
    const { state, home } = seoSite();
    const s = run(state, { type: 'page.update', pageId: home, noindex: true });
    expect(runSeoAudit(s)).toEqual([
      expect.objectContaining({ code: 'SEO_HOME_NOINDEX', severity: 'warning', pillar: 'technical', owner: { kind: 'page', id: home }, site: 'noindex', aiFixable: true, destination: { kind: 'pageSeo', pageId: home, field: 'noindex' } })
    ]);
  });

  it('says when a title is missing, repeated in the same language, or outside the range that reads well', () => {
    const { state, home, services } = seoSite();
    // A Home page without a title of its own is named by the site, and a site saved without a name (by hand) has none.
    const missing = copy(run(state, { type: 'page.update', pageId: home, seoTitle: '' }));
    missing.site.name = ' ';
    expect(only(missing, 'SEO_TITLE_MISSING')).toEqual([expect.objectContaining({ owner: { kind: 'page', id: home }, site: 'title', destination: { kind: 'pageSeo', pageId: home, field: 'title' }, aiFixable: true })]);
    // Told apart from case and spacing; both pages are named.
    const dup = run(state, { type: 'page.update', pageId: services, seoTitle: 'riverside  STUDIO · Pottery classes and handmade work' });
    expect(only(dup, 'SEO_TITLE_DUPLICATE').map((f) => f.owner)).toEqual([
      { kind: 'page', id: home },
      { kind: 'page', id: services }
    ]);
    // The same words in another language are another title.
    expect(codes(run(dup, { type: 'page.update', pageId: services, language: 'fr' }))).toEqual([]);
    // A page search engines are not to list is not judged.
    expect(codes(run(dup, { type: 'page.update', pageId: services, noindex: true }))).toEqual([]);
    const lengths = (n: number) => only(run(state, { type: 'page.update', pageId: services, seoTitle: x(n) }), 'SEO_TITLE_LENGTH');
    expect(SEO_TITLE_RANGE).toEqual({ min: 15, max: 60 });
    expect([14, 15, 60, 61].map((n) => lengths(n).length)).toEqual([1, 0, 0, 1]);
    // An entry's is changed in its title.
    const longPost = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', title: 'Spring pottery classes for complete beginners, every week' });
    expect(only(longPost, 'SEO_TITLE_LENGTH')).toEqual([expect.objectContaining({ owner: { kind: 'entry', id: 'en_spring' }, destination: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'title' } })]);
    expect(lengths(61)[0]).toMatchObject({ severity: 'info', pillar: 'content', message: expect.stringContaining('61 characters'), destination: { kind: 'pageSeo', pageId: services, field: 'title' } });
  });

  it('says when a description is missing, shared, or outside the range search results show', () => {
    const { state, home, services } = seoSite();
    const none = run(state, { type: 'site.update', description: '' }, { type: 'page.update', pageId: services, description: '' });
    expect(only(none, 'SEO_DESCRIPTION_MISSING')).toEqual([expect.objectContaining({ owner: { kind: 'page', id: services }, severity: 'warning', destination: { kind: 'pageSeo', pageId: services, field: 'description' } })]);
    // Told apart from case and spacing.
    const cased = run(state, { type: 'page.update', pageId: services, description: state.pages[home].seo.description!.toUpperCase().replace(/ /g, '  ') });
    expect(only(cased, 'SEO_DESCRIPTION_DUPLICATE').map((f) => f.owner?.id)).toEqual([home, services]);
    // Two pages left to the site's description share it.
    const inherited = run(state, { type: 'page.update', pageId: home, description: '' }, { type: 'page.update', pageId: services, description: '' });
    expect(only(inherited, 'SEO_DESCRIPTION_DUPLICATE').map((f) => f.owner?.id)).toEqual([home, services]);
    const lengths = (n: number) => only(run(state, { type: 'page.update', pageId: services, description: x(n) }), 'SEO_DESCRIPTION_LENGTH').length;
    expect(SEO_DESCRIPTION_RANGE).toEqual({ min: 50, max: 160 });
    expect([49, 50, 160, 161].map(lengths)).toEqual([1, 0, 0, 1]);
    // An entry's is changed in its excerpt, in the editor: the AI changes no collection entry yet (#599).
    const entryless = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', excerpt: 'Short.' });
    expect(only(entryless, 'SEO_DESCRIPTION_LENGTH')).toEqual([expect.objectContaining({ owner: { kind: 'entry', id: 'en_spring' }, aiFixable: false, destination: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'excerpt' } })]);
    // A page's the AI can set.
    expect(only(run(state, { type: 'page.update', pageId: services, description: x(10) }), 'SEO_DESCRIPTION_LENGTH')).toEqual([expect.objectContaining({ owner: { kind: 'page', id: services }, aiFixable: true })]);
  });

  it('says once when pages are shared without a picture, and on its own for a page whose picture has gone', () => {
    const { state, services } = seoSite();
    const none = run(state, { type: 'site.update', socialImage: null });
    expect(only(none, 'SEO_SOCIAL_IMAGE_MISSING')).toEqual([expect.objectContaining({ severity: 'warning', pillar: 'social', message: 'The site has no sharing image.', destination: { kind: 'site', field: 'socialImage' } })]);
    // A page with its own picture needs none from the site.
    const some = run(none, { type: 'page.update', pageId: services, socialImage: 'img_bowls' });
    expect(only(some, 'SEO_SOCIAL_IMAGE_MISSING').map((f) => f.message)).toEqual(['2 of the site’s 3 pages have no sharing image.']);
    const gone = copy(some);
    delete gone.assets.assets.img_bowls;
    expect(only(gone, 'SEO_SOCIAL_IMAGE_MISSING')).toEqual([
      expect.objectContaining({ owner: { kind: 'page', id: services }, destination: { kind: 'pageSeo', pageId: services, field: 'socialImage' } }),
      expect.objectContaining({ message: '2 of the site’s 3 pages have no sharing image.' })
    ]);
    expect(only(gone, 'SEO_SOCIAL_IMAGE_MISSING')[1].owner).toBeUndefined();
    // A page search engines are not to list is still shared.
    const hidden = copy(run(state, { type: 'page.update', pageId: services, noindex: true }));
    hidden.pages[services].seo.socialImage = 'img_gone';
    expect(only(hidden, 'SEO_SOCIAL_IMAGE_MISSING')).toEqual([expect.objectContaining({ owner: { kind: 'page', id: services }, destination: { kind: 'pageSeo', pageId: services, field: 'socialImage' } })]);
    const siteGone = copy(state);
    delete siteGone.assets.assets.img_share;
    expect(only(siteGone, 'SEO_SOCIAL_IMAGE_MISSING').map((f) => f.message)).toEqual(['The site’s sharing image is no longer in the library, so the site is shared without one.']);
  });

  it('says when the site has no icon of its own', () => {
    const { state } = seoSite();
    expect(runSeoAudit(run(state, { type: 'site.update', favicon: null }))).toEqual([
      expect.objectContaining({ code: 'SEO_FAVICON_MISSING', severity: 'info', pillar: 'social', site: 'favicon', destination: { kind: 'site', field: 'favicon' } })
    ]);
    const notPicture = copy(state);
    notPicture.assets.assets.img_icon.kind = 'document';
    expect(codes(notPicture)).toEqual(['SEO_FAVICON_MISSING']);
    const gone = copy(state);
    delete gone.assets.assets.img_icon;
    expect(codes(gone)).toEqual(['SEO_FAVICON_MISSING']);
  });

  it('says when the site doesn’t say who publishes it, or links to no profile that confirms who that is', () => {
    const plain = unidentifiedSite().state;
    expect(runSeoAudit(plain)).toEqual([
      expect.objectContaining({ code: 'SEO_ENTITY_IDENTITY_MISSING', severity: 'warning', pillar: 'entity', site: 'identity', aiFixable: false, destination: { kind: 'site', field: 'identity' } })
    ]);
    // A kind, named by the site, with no profile: who it is can't be confirmed.
    const person = run(plain, { type: 'site.update', identity: { kind: 'Person' } });
    expect(runSeoAudit(person)).toEqual([
      expect.objectContaining({ code: 'SEO_ENTITY_SAME_AS_MISSING', severity: 'warning', pillar: 'entity', site: 'sameAs', aiFixable: false, message: expect.stringContaining('its author'), destination: { kind: 'site', field: 'sameAs' } })
    ]);
    // A kind chosen with no name at all, its own or the site's, says no one.
    const nameless = copy(run(person, { type: 'site.update', identity: { sameAs: ['https://github.com/riverside'] } }));
    nameless.site.name = '  ';
    expect(runSeoAudit(nameless)).toEqual([expect.objectContaining({ code: 'SEO_ENTITY_IDENTITY_MISSING', message: 'The site’s publisher has no name.', site: 'identity' })]);
    expect(runSeoAudit(run(person, { type: 'site.update', identity: { sameAs: ['https://github.com/riverside'] } }))).toEqual([]);
    // Values edited into the file by hand that Site details would refuse count as none.
    const damaged = copy(seoSite().state);
    damaged.site.identity = { kind: 'Company' as never, sameAs: ['https://www.wikidata.org/wiki/Q123456'] };
    expect(codes(damaged)).toEqual(['SEO_ENTITY_IDENTITY_MISSING']);
    damaged.site.identity = { kind: 'Organization', sameAs: ['javascript:alert(1)', 'not an address'] };
    expect(codes(damaged)).toEqual(['SEO_ENTITY_SAME_AS_MISSING']);
    (damaged.site as { identity: unknown }).identity = 'Organization';
    expect(codes(damaged)).toEqual(['SEO_ENTITY_IDENTITY_MISSING']);
    // Clearing it all is the same as never saying.
    expect(codes(run(seoSite().state, { type: 'site.update', identity: null }))).toEqual(['SEO_ENTITY_IDENTITY_MISSING']);
  });

  it('says when nothing on the rest of the site links to a page', () => {
    const { state, home } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_kilns', title: 'Kiln hire', route: '/kiln-hire/' }, { type: 'page.update', pageId: 'pg_kilns', seoTitle: 'Kiln hire by the hour · Riverside Studio', description: 'Hire our electric and gas kilns by the hour, with firing help from the studio team.' });
    expect(runSeoAudit(s)).toEqual([expect.objectContaining({ code: 'SEO_PAGE_UNLINKED', severity: 'warning', pillar: 'content', owner: { kind: 'page', id: 'pg_kilns' }, site: 'incoming-links', aiFixable: false })]);
    // A link in a published post's text counts; one in a draft's does not.
    const linkTo = (target: unknown): RichText => [...POST_BODY, { type: 'p', spans: [{ text: 'Book the kilns', link: target as never }] }];
    expect(codes(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: linkTo({ type: 'page', target: 'pg_kilns' }) }))).toEqual([]);
    expect(codes(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true, body: linkTo({ type: 'page', target: 'pg_kilns' }) }))).toContain('SEO_PAGE_UNLINKED');
    // So does a typed address of the page on the site's public URL, or of an old address kept for it.
    expect(codes(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: linkTo({ type: 'url', target: 'https://example.com/studio/kiln-hire/' }) }))).toEqual([]);
    expect(codes(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: linkTo({ type: 'url', target: 'https://example.com/studio/kiln-hire/index.html' }) }))).toEqual([]);
    const moved = run(exported(s), { type: 'page.update', pageId: 'pg_kilns', route: '/kilns/' });
    expect(moved.site.redirects).toContainEqual({ from: '/kiln-hire/', pageId: 'pg_kilns' });
    expect(codes(run(moved, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: linkTo({ type: 'url', target: 'https://example.com/studio/kiln-hire/' }) }))).toEqual([]);
    // An address elsewhere, or outside the site's sub-path, is no link to it; nor is a link to it from a draft page.
    expect(codes(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: linkTo({ type: 'url', target: 'https://other.example/studio/kiln-hire/' }) }))).toContain('SEO_PAGE_UNLINKED');
    expect(codes(run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: linkTo({ type: 'url', target: 'https://example.com/kiln-hire/' }) }))).toContain('SEO_PAGE_UNLINKED');
    // The header shown on other pages counts; the Home page and pages search engines are not to list are not judged.
    expect(codes(run(s, { type: 'page.update', pageId: 'pg_kilns', noindex: true }))).toEqual([]);
    const menu = copy(s);
    addMenuItem(menu, 'Kiln hire', { type: 'page', target: 'pg_kilns' });
    expect(codes(menu)).toEqual([]);
    expect(only(s, 'SEO_PAGE_UNLINKED').map((f) => f.owner?.id)).not.toContain(home);
  });

  it('does not count a link a page has to itself, or a header only that page shows', () => {
    const { state, services } = seoSite();
    // A site of pages alone, where only Services shows the header with its link to Services.
    const s = copy(state);
    s.collections = {};
    for (const id of s.site.pageOrder) s.pages[id].showHeader = id === services;
    expect(only(s, 'SEO_PAGE_UNLINKED').map((f) => f.owner?.id)).toEqual([services]);
    s.pages[s.site.homePageId].showHeader = true;
    expect(only(s, 'SEO_PAGE_UNLINKED')).toEqual([]);
    // A page's own link to itself leads nowhere new either.
    const self = run(state, { type: 'page.create', pageId: 'pg_kilns', title: 'Kiln hire', route: '/kiln-hire/', starter: 'intro' });
    const own = copy(self);
    own.pages.pg_kilns.nodes.self_link = { id: 'self_link', kind: 'link', label: 'Kiln hire prices', link: { type: 'page', target: 'pg_kilns' }, appearance: 'primary' } as never;
    own.pages.pg_kilns.rootIds.push('self_link');
    expect(only(own, 'SEO_PAGE_UNLINKED').map((f) => f.owner?.id)).toEqual(['pg_kilns']);
    // The same link on another page is one.
    own.pages[state.site.homePageId].nodes.self_link = structuredClone(own.pages.pg_kilns.nodes.self_link);
    own.pages[state.site.homePageId].rootIds.push('self_link');
    expect(only(own, 'SEO_PAGE_UNLINKED')).toEqual([]);
  });

  it('says when a link’s words say nothing of where it goes, leading to where they are changed', () => {
    const { state } = seoSite();
    const menu = copy(state);
    const nodeId = addMenuItem(menu, 'Click here!', { type: 'page', target: 'pg_services' });
    expect(runSeoAudit(menu)).toEqual([
      expect.objectContaining({
        code: 'SEO_LINK_TEXT_GENERIC',
        severity: 'info',
        pillar: 'content',
        message: 'A link says only “Click here!” in the shared header.',
        owner: { kind: 'shell', id: 'header' },
        nodeId,
        aiFixable: true,
        destination: { kind: 'element', owner: { kind: 'shell', id: 'header' }, nodeId }
      })
    ]);
    const text = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [...POST_BODY, { type: 'p', spans: [{ text: 'For dates, ' }, { text: 'read more', link: { type: 'page', target: 'pg_services' } }] }] });
    // A post's text is changed in the editor: the AI changes no collection entry yet (#599).
    expect(runSeoAudit(text)).toEqual([expect.objectContaining({ code: 'SEO_LINK_TEXT_GENERIC', owner: { kind: 'entry', id: 'en_spring' }, site: 'link|body:0', aiFixable: false, destination: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body' } })]);
    // Words that name the destination are fine, however they start.
    const named = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [...POST_BODY, { type: 'p', spans: [{ text: 'Read more about our classes', link: { type: 'page', target: 'pg_services' } }] }] });
    expect(runSeoAudit(named)).toEqual([]);
    expect(['Read more →', ' LEARN  more. ', 'Here…'].map(linkWords)).toEqual(['read more', 'learn more', 'here']);
    // Words on a link that goes nowhere show on no link.
    const noLink = copy(state);
    Object.assign(headerOf(noLink).props, { ctaLabel: 'Read more', ctaLink: { type: 'none', target: '' } });
    expect(runSeoAudit(noLink)).toEqual([]);
    Object.assign(headerOf(noLink).props, { ctaLink: { type: 'page', target: 'pg_services' } });
    expect(codes(noLink)).toEqual(['SEO_LINK_TEXT_GENERIC']);
    // A name that names the destination is no generic word.
    const go = copy(state);
    addMenuItem(go, 'Go', { type: 'page', target: 'pg_services' });
    expect(runSeoAudit(go)).toEqual([]);
  });

  it('issue 1518: says when a link on the site’s own address goes where the website has nothing, once per address', () => {
    const { state } = seoSite();
    // The fixture's public URL is https://example.com/studio: only addresses under it are the site's own.
    const linking = (s: ProjectState, entryId: string, ...targets: string[]) =>
      run(s, { type: 'entry.update', collectionId: 'posts', entryId, body: [...POST_BODY, ...targets.map((target, i) => ({ type: 'p' as const, spans: [{ text: `See ${i}: ` }, { text: `the place numbered ${i}`, link: { type: 'url' as const, target } }] }))] });
    const fine = linking(
      state,
      'en_spring',
      'https://example.com/studio/services/',
      'https://example.com/studio/services/index.html#prices',
      'https://example.com/studio/blog/',
      'https://example.com/studio/files/price-list.pdf',
      'https://example.com/studio/services/?m=spring&s=',
      'https://example.com/about/team/',
      'https://other.example/studio/about/team/'
    );
    expect(only(fine, 'SEO_LINK_OWN_MISSING')).toEqual([]);
    const broken = linking(state, 'en_spring', 'https://example.com/studio/about/team/', 'https://example.com/studio/?p=88', 'https://example.com/studio/about/team/');
    // The same address over plain http, an old site's page file, and one read by its query whatever its file, are too.
    const older = linking(state, 'en_spring', 'http://example.com/studio/about/team/', 'https://example.com/studio/contact.html', 'https://example.com/studio/index.php?p=12', 'http://other.example/studio/about/team/');
    expect(only(older, 'SEO_LINK_OWN_MISSING').map((f) => f.site)).toEqual(['own-link|http://example.com/studio/about/team/', 'own-link|https://example.com/studio/contact.html', 'own-link|https://example.com/studio/index.php?p=12']);
    expect(only(broken, 'SEO_LINK_OWN_MISSING')).toEqual([
      // WordPress read a post by its number; the website has no page for it, whatever is at the address before it.
      expect.objectContaining({ message: '“Spring pottery classes” links to https://example.com/studio/?p=88, where the website has no page.' }),
      expect.objectContaining({
        severity: 'warning',
        pillar: 'content',
        message: '“Spring pottery classes” links to https://example.com/studio/about/team/, where the website has no page.',
        owner: { kind: 'entry', id: 'en_spring' },
        site: 'own-link|https://example.com/studio/about/team/',
        aiFixable: false,
        destination: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body' }
      })
    ]);
    for (const f of only(broken, 'SEO_LINK_OWN_MISSING')) expectValidDestination(broken, f);
    // Two posts linking to it are one finding, naming the first and counting the rest, before an address one links to:
    // two posts of the same title are two places.
    const second = run(broken, { type: 'entry.create', collectionId: 'posts', entryId: 'en_autumn', title: 'Spring pottery classes', publishedAt: '2027-03-01', draft: false, excerpt: 'Glazes for autumn.', body: POST_BODY });
    const both = linking(second, 'en_autumn', 'https://example.com/studio/about/team/');
    expect(only(both, 'SEO_LINK_OWN_MISSING').map((f) => f.message)).toEqual([
      '“Spring pottery classes” and 1 other place link to https://example.com/studio/about/team/, where the website has no page.',
      '“Spring pottery classes” links to https://example.com/studio/?p=88, where the website has no page.'
    ]);
    // An old address that leads nowhere answers nothing; one kept working answers it, and so does a page made there.
    expect(only(run(broken, { type: 'redirect.add', from: '/about/team/', to: '/nowhere/' }), 'SEO_LINK_OWN_MISSING')).toHaveLength(2);
    expect(only(run(broken, { type: 'redirect.add', from: '/about/team/', pageId: 'pg_services' }), 'SEO_LINK_OWN_MISSING').map((f) => f.site)).toEqual(['own-link|https://example.com/studio/?p=88']);
    expect(only(run(broken, { type: 'page.create', title: 'Team', route: '/about/team/' }), 'SEO_LINK_OWN_MISSING').map((f) => f.site)).toEqual(['own-link|https://example.com/studio/?p=88']);
    // A draft there is left to the export, which already stops at links to a draft.
    expect(only(run(broken, { type: 'page.create', title: 'Team', route: '/about/team/', draft: true }), 'SEO_LINK_OWN_MISSING').map((f) => f.site)).toEqual(['own-link|https://example.com/studio/?p=88']);
    // Without a public URL, no address is the site's own.
    expect(only(run(broken, { type: 'site.update', baseUrl: '' }), 'SEO_LINK_OWN_MISSING')).toEqual([]);
  });

  it('says when a picture in a published post has no description, as Project health does', () => {
    const { state } = seoSite();
    const body: RichText = POST_BODY.map((b) => (b.type === 'image' && b.assetId === 'img_bowls' ? { ...b, alt: '  ' } : b));
    const s = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body });
    const [f] = runSeoAudit(s);
    expect(f).toMatchObject({ code: 'ALT_MISSING', severity: 'warning', pillar: 'agentic', owner: { kind: 'entry', id: 'en_spring' }, site: 'body|alt|1', aiFixable: false, destination: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body', picture: 1 } });
    // The same finding as Project health's, told apart the same way.
    expect(validateState(s).filter((d) => d.code === 'ALT_MISSING').map(diagnosticKey)).toEqual([diagnosticKey(f)]);
    // A decorative picture needs none.
    expect(runSeoAudit(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: body.map((b) => (b.type === 'image' ? { ...b, decorative: true } : b)) }))).toEqual([]);
    // Each picture is numbered as the writer shows it.
    const second = POST_BODY.map((b) => (b.type === 'image' && b.assetId === 'img_texture' ? { ...b, decorative: false } : b)) as RichText;
    expect(runSeoAudit(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: second })).map((f) => [f.code, f.site, f.destination])).toEqual([
      ['ALT_MISSING', 'body|alt|2', { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body', picture: 2 }]
    ]);
  });

  it('says when a post’s headings skip a level below its title', () => {
    const { state } = seoSite();
    const skipped = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [{ type: 'h2', spans: [{ text: 'Classes' }] }, { type: 'h4', spans: [{ text: 'Fees' }] }, { type: 'h2', spans: [{ text: 'Dates' }] }] });
    expect(runSeoAudit(skipped)).toEqual([
      expect.objectContaining({ code: 'SEO_ENTRY_HEADING_SKIP', severity: 'warning', pillar: 'agentic', message: expect.stringContaining('“Fees” is a Heading 4 after a Heading 2'), site: 'body|heading|1', aiFixable: false, destination: { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body' } })
    ]);
    const deeper = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [{ type: 'h2', spans: [{ text: 'Classes' }] }, { type: 'h3', spans: [{ text: 'Fees' }] }, { type: 'h2', spans: [{ text: 'Dates' }] }, { type: 'h4', spans: [{ text: 'Spring' }] }] });
    expect(only(deeper, 'SEO_ENTRY_HEADING_SKIP').map((f) => [f.site, f.aiFixable])).toEqual([['body|heading|3', false]]);
    // Its first heading follows whatever its layout shows above the text, so it is not judged.
    const first = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [{ type: 'h4', spans: [{ text: 'Fees' }] }, { type: 'p', spans: [{ text: 'Twenty a class.' }] }] });
    expect(only(first, 'SEO_ENTRY_HEADING_SKIP')).toEqual([]);
  });

  it('leads every finding to something the project has, in a fixed order, the same on every run', () => {
    const { state, services } = seoSite();
    let s = run(
      state,
      { type: 'site.update', socialImage: null, favicon: null, identity: { sameAs: null }, llmsTxt: false, crawlerPolicy: { preset: 'custom', overrides: { 'OAI-SearchBot': 'disallow' } } },
      { type: 'page.update', pageId: state.site.homePageId, noindex: true },
      { type: 'page.update', pageId: services, seoTitle: 'Short', description: '' },
      { type: 'page.create', pageId: 'pg_lost', title: 'Lost', route: '/lost/' },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', body: [{ type: 'h2', spans: [{ text: 'Fees', link: { type: 'page', target: services } }] }, { type: 'h4', spans: [{ text: 'Spring' }] }, { type: 'image', assetId: 'img_bowls', alt: '' }, { type: 'p', spans: [{ text: 'here', link: { type: 'page', target: services } }] }] }
    );
    s = copy(s);
    addMenuItem(s, 'More', { type: 'page', target: services });
    const found = runSeoAudit(s);
    for (const f of found) expectValidDestination(s, f);
    expect(new Set(found.map(diagnosticKey)).size).toBe(found.length);
    // Pillars in their order, the most serious first within each.
    const order = ['technical', 'entity', 'agentic', 'content', 'social'];
    const ranks = found.map((f) => order.indexOf(f.pillar) * 3 + ['error', 'warning', 'info'].indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(found.map((f) => f.code))).toEqual(
      new Set(['SEO_HOME_NOINDEX', 'SEO_ENTITY_SAME_AS_MISSING', 'SEO_ENTRY_HEADING_SKIP', 'ALT_MISSING', 'SEO_LLMS_TXT_OFF', 'SEO_AI_SEARCH_CRAWLERS_BLOCKED', 'SEO_TITLE_LENGTH', 'SEO_DESCRIPTION_DUPLICATE', 'SEO_PAGE_UNLINKED', 'SEO_LINK_TEXT_GENERIC', 'SEO_SOCIAL_IMAGE_MISSING', 'SEO_FAVICON_MISSING'])
    );
    for (const f of found) expect(f.explanation.length, f.code).toBeGreaterThan(20);
    expect(JSON.stringify(runSeoAudit(structuredClone(s)))).toBe(JSON.stringify(found));
    // Findings that say where they are fixed do.
    for (const f of found) if (!['SEO_PAGE_UNLINKED'].includes(f.code)) expect(f.destination, f.code).toBeTruthy();
    expect(found.find((f) => f.code === 'SEO_AI_SEARCH_CRAWLERS_BLOCKED')?.destination).toEqual({ kind: 'site', field: 'crawlerPolicy' });
  });
});

describe('the audit runner', () => {
  it('runs a feature’s own rules beside the baseline and refuses two rules of one name', () => {
    const { state } = seoSite();
    const entity: SeoAuditRule = {
      id: 'entity-identity',
      check: () => [{ severity: 'warning', code: 'SEO_ENTITY_MISSING', message: 'The site does not say who runs it.', pillar: 'entity', explanation: 'Answer engines check a site’s identity before citing it.', aiFixable: false }]
    };
    expect(runSeoAudit(state, [entity]).map((f) => f.code)).toEqual(['SEO_ENTITY_MISSING']);
    // Its findings take their place among the baseline's by pillar.
    expect(runSeoAudit(run(state, { type: 'site.update', favicon: null, baseUrl: '' }), [entity]).map((f) => f.code)).toEqual(['SEO_BASE_URL_MISSING', 'SEO_ENTITY_MISSING', 'SEO_FAVICON_MISSING']);
    expect(() => runSeoAudit(state, [entity, entity])).toThrow(/both called entity-identity/);
    expect(() => runSeoAudit(state, [{ id: BASELINE_SEO_RULES[0].id, check: () => [] }])).toThrow(/both called/);
    // The same finding from two rules is listed once.
    expect(runSeoAudit(state, [entity, { ...entity, id: 'entity-again' }]).map((f) => f.code)).toEqual(['SEO_ENTITY_MISSING']);
  });

  it('reads damaged documents without failing', () => {
    const { state } = seoSite();
    const s = copy(state);
    (s.collections.posts.entries.en_spring as { body: unknown }).body = [{ type: 'nonsense' }];
    (s.pages[s.site.homePageId].seo as { title: unknown }).title = 7;
    s.site.pageOrder.push('pg_missing');
    (s.collections.posts.entries.en_spring as { featuredImage: unknown }).featuredImage = 'img_bowls';
    (s.assets.assets.img_bowls as { file: unknown }).file = null;
    s.site.favicon = null;
    // A page with no address and an entry that is not one, as a hand edit might leave them.
    s.pages.pg_broken = { ...structuredClone(s.pages[s.site.homePageId]), id: 'pg_broken', route: null as never };
    (s.collections.posts.entries as Record<string, unknown>).en_null = null;
    // The rest of the site is judged all the same.
    expect(codes(s)).toContain('SEO_FAVICON_MISSING');
  });
});

describe('editor destinations for SEO findings', () => {
  it('names each kind’s button, and is never an export note’s to track', () => {
    const { state, services } = seoSite();
    expect(destinationLabel({ kind: 'pageSeo', pageId: services, field: 'title' })).toBe('Go to Search & sharing');
    expect(destinationLabel({ kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'excerpt' })).toBe('Open post');
    expect(destinationLabel({ kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body', picture: 2 })).toBe('Go to picture');
    expect(destinationLabel({ kind: 'element', owner: { kind: 'shell', id: 'header' }, nodeId: 'n1' })).toBe('Show on page');
    for (const destination of [
      { kind: 'pageSeo', pageId: services, field: 'title' },
      { kind: 'entry', collectionId: 'posts', entryId: 'en_spring', field: 'body' },
      { kind: 'element', owner: { kind: 'shell', id: 'header' }, nodeId: 'n1' }
    ] as EditorDestination[])
      expect(noteState(state, { message: 'x', destination }, [])).toBeNull();
  });
});
