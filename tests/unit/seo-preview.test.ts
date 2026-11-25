/**
 * Search & sharing previews (#597): a page's and a post's search result, link card, length meters, publishing status
 * and structured data come from the generator's own answers, follow text still being typed as saving it would, and
 * say where a results page likely cuts a title or description short.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { createSeoResolver } from '@generator/seo-metadata';
import { documentGraph } from '@generator/structured-data';
import { generateEntry, generatePage, publishedState } from '@generator/index';
import { lengthMeter, previewDocument, resultDate, structuredPreview, withTypedSeo } from '../../src/renderer/src/lib/seo-preview';
import { copy, run, seoSite } from './fixtures/seo-site';

const PAGE: SeoSubject = { kind: 'page', pageId: 'pg_services' };
const POST: SeoSubject = { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' };
const SERVICES = 'https://example.com/studio/services/';
const SPRING = 'https://example.com/studio/blog/spring-pottery-classes/';

const preview = (s: ProjectState, subject: SeoSubject) => previewDocument(s, subject, createSeoResolver(s).resolve(subject)?.route)!;
const graphOf = (s: ProjectState, subject: SeoSubject) => {
  const g = structuredPreview(s, subject)!.graph;
  if (g.kind !== 'graph') throw new Error(`no graph: ${JSON.stringify(g)}`);
  return JSON.parse(g.json) as { '@graph': Array<Record<string, unknown>> };
};
const webpage = (g: { '@graph': Array<Record<string, unknown>> }) => g['@graph'].find((n) => n['@type'] === 'WebPage')!;
const tag = (svelte: string, re: RegExp) => re.exec(svelte)?.[1];

describe('withTypedSeo', () => {
  it('lays typed text over a page as saving it would, without changing the project', () => {
    const { state } = seoSite();
    const before = JSON.stringify(state);
    const typed = withTypedSeo(state, PAGE, { title: 'Wheel classes', description: '' });
    expect(typed.pages.pg_services.seo).toMatchObject({ title: 'Wheel classes' });
    expect(typed.pages.pg_services.seo.description).toBeUndefined();
    // A page's text is saved as it is typed: spaces are its own title, not none.
    expect(withTypedSeo(state, PAGE, { title: '   ' }).pages.pg_services.seo.title).toBe('   ');
    expect(JSON.stringify(state)).toBe(before);
    expect(withTypedSeo(state, PAGE, {})).toBe(state);
  });

  it('trims a post’s typed text, as its fields save it, and never makes up a document the project does not have', () => {
    const { state } = seoSite();
    const typed = withTypedSeo(state, POST, { title: '  Spring at the wheel  ', description: '   ', canonical: 'https://elsewhere.example/spring/' });
    expect(typed.collections.posts.entries.en_spring.seo).toEqual({ title: 'Spring at the wheel', canonical: 'https://elsewhere.example/spring/' });
    expect(withTypedSeo(state, { kind: 'entry', collectionId: 'posts', entryId: 'en_gone' }, { title: 'x' })).toBe(state);
    expect(withTypedSeo(state, { kind: 'page', pageId: 'pg_gone' }, { title: 'x' })).toBe(state);
  });

  it('leaves the settings nobody typed in as they are, and repairs a hand-damaged one', () => {
    const { state } = seoSite();
    const set = run(state, { type: 'page.update', pageId: 'pg_services', noindex: true, canonical: 'https://journal.example/services/' });
    expect(withTypedSeo(set, PAGE, { title: 'Classes' }).pages.pg_services.seo).toEqual({ ...set.pages.pg_services.seo, title: 'Classes' });
    const damaged = copy(state);
    (damaged.collections.posts.entries.en_spring as { seo: unknown }).seo = 'broken';
    expect(withTypedSeo(damaged, POST, { title: 'Spring' }).collections.posts.entries.en_spring.seo).toEqual({ title: 'Spring' });
    expect(damaged.collections.posts.entries.en_spring.seo).toBe('broken');
  });
});

describe('previewDocument', () => {
  it('shows a page’s result and card as its exported head says them', () => {
    const { state } = seoSite();
    const p = preview(state, PAGE);
    const head = generatePage(state, state.pages.pg_services, {});
    expect(p.meta.title).toBe(tag(head, /<title>\{"([^"]*)"\}<\/title>/) ?? tag(head, /<title>([^<]*)<\/title>/));
    expect(p.serp.desktop.title.text).toBe('Classes and commissions · Riverside Studio');
    expect(p.serp.desktop.description.text).toBe(state.pages.pg_services.seo.description);
    expect(p.address).toEqual({ host: 'example.com', trail: ['studio', 'services'] });
    expect(p.siteName).toBe('Riverside Studio');
    expect(p.date).toBeNull();
    expect(p.card).toMatchObject({ host: 'example.com', title: 'Classes and commissions · Riverside Studio', addressNote: null });
    expect(p.card.image?.id).toBe('img_share');
    expect(p.card.imageSaid).toMatch(/, the site’s\.$/);
    expect(p.own).toEqual({ title: true, description: true });
  });

  it('gives a post its branded title in results, its own title on the card, and its date before the description', () => {
    const { state } = seoSite();
    const p = preview(state, POST);
    const resolved = createSeoResolver(state).resolve(POST)!;
    expect(p.meta.title).toBe(resolved.title);
    expect(p.serp.desktop.title.text).toBe('Spring pottery classes · Riverside Studio');
    expect(p.card.title).toBe('Spring pottery classes');
    expect(p.serp.desktop.description.text).toBe(state.collections.posts.entries.en_spring.excerpt);
    expect(p.address.trail).toEqual(['studio', 'blog', 'spring-pottery-classes']);
    expect(p.date).toBe(resultDate('2027-03-02', 'en'));
    expect(p.date).toMatch(/2027 — $/);
    expect(p.serp.desktop.description.max).toBeLessThan(920);
    expect(p.own).toEqual({ title: false, description: false });
    expect(generateEntry(state, 'posts', 'en_spring')).toContain(`content={"${p.card.title}"}`);
  });

  it('follows typed text before it is saved, and the fallbacks once a field is emptied', () => {
    const { state } = seoSite();
    const typed = preview(withTypedSeo(state, POST, { title: 'Throwing pots this spring', description: 'Six weeks at the wheel.' }), POST);
    expect(typed.serp.mobile.title.text).toBe('Throwing pots this spring');
    expect(typed.card).toMatchObject({ title: 'Throwing pots this spring', description: 'Six weeks at the wheel.' });
    expect(typed.own).toEqual({ title: true, description: true });
    const cleared = preview(withTypedSeo(state, PAGE, { title: '', description: '' }), PAGE);
    expect(cleared.serp.desktop.title.text).toBe('Services · Riverside Studio');
    expect(cleared.serp.desktop.description.text).toBe(state.site.description);
    expect(cleared.own).toEqual({ title: false, description: false });
  });

  it('names the card’s host by the canonical URL, and says what a site without a public URL leaves out', () => {
    const { state } = seoSite();
    const moved = preview(withTypedSeo(state, POST, { canonical: 'https://journal.example/spring/' }), POST);
    expect(moved.card.host).toBe('journal.example');
    expect(moved.address.host).toBe('example.com');
    const bare = run(state, { type: 'site.update', baseUrl: '' });
    const noUrl = preview(bare, PAGE);
    expect(noUrl.address).toEqual({ host: null, trail: ['services'] });
    expect(noUrl.card.host).toBeUndefined();
    expect(noUrl.card.addressNote).toMatch(/no usable public URL.*page or image addresses/);
    expect(preview(withTypedSeo(bare, PAGE, { canonical: 'https://journal.example/services/' }), PAGE).card.addressNote).toMatch(/writes no image address/);
  });

  it('is nothing for a document the project does not have', () => {
    const { state } = seoSite();
    expect(previewDocument(state, { kind: 'page', pageId: 'pg_gone' })).toBeNull();
    expect(previewDocument(state, { kind: 'entry', collectionId: 'posts', entryId: 'en_gone' })).toBeNull();
  });
});

describe('lengthMeter', () => {
  it('measures the fallback while a field is empty, and says it is the fallback', () => {
    const { state } = seoSite();
    const p = preview(state, POST);
    const title = lengthMeter('title', p);
    expect(title).toMatchObject({ tone: 'good', cutOn: [], chars: 'Spring pottery classes · Riverside Studio'.length });
    expect(title.label).toBe(`Default title: ${title.chars} characters · fits on computers and phones`);
    expect(title.fill).toBeGreaterThan(0);
    expect(title.fill).toBeLessThan(1);
    expect(title.fill).toBeCloseTo(p.serp.desktop.title.width / 600, 5);
  });

  it('follows a post’s description down its fallbacks: its own, its excerpt, then the site’s', () => {
    const { state } = seoSite();
    const excerpt = state.collections.posts.entries.en_spring.excerpt!;
    const own = preview(withTypedSeo(state, POST, { description: 'Six weeks at the wheel, with every glaze.' }), POST);
    expect(lengthMeter('description', own).label).toBe('41 characters · short: 50 to 160 reads best');
    expect(lengthMeter('description', preview(state, POST)).label).toMatch(new RegExp(`^From the fallback: ${excerpt.length} characters · `));
    const noExcerpt = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', excerpt: null });
    expect(lengthMeter('description', preview(noExcerpt, POST)).label).toMatch(new RegExp(`^From the fallback: ${state.site.description.length} characters · `));
  });

  it('says where a results page likely cuts text short, without refusing it', () => {
    const { state } = seoSite();
    const long = preview(withTypedSeo(state, PAGE, { title: 'Weekly wheel classes, private lessons and commissioned tableware · Riverside Studio' }), PAGE);
    const t = lengthMeter('title', long);
    expect(t.tone).toBe('cut');
    expect(t.cutOn).toEqual(['desktop', 'mobile']);
    expect(t.label).toMatch(/likely cut short on computers and phones$/);
    expect(t.fill).toBe(1);
    // Wide enough for a computer’s two lines but past a phone’s.
    const description = 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing, and every student leaves with a set of bowls and cups.';
    const d = lengthMeter('description', preview(withTypedSeo(state, PAGE, { description }), PAGE));
    expect(d).toMatchObject({ tone: 'cut', cutOn: ['mobile'] });
    expect(d.label).toBe(`${description.length} characters · likely cut short on phones, fits on computers`);
  });

  it('says a short title is short, and what an empty description means', () => {
    const { state } = seoSite();
    expect(lengthMeter('title', preview(withTypedSeo(state, PAGE, { title: 'Classes' }), PAGE))).toMatchObject({ tone: 'short', label: '7 characters · short: 15 to 60 reads best' });
    const bare = copy(state);
    bare.site.description = '';
    expect(lengthMeter('description', preview(withTypedSeo(bare, PAGE, { description: '' }), PAGE))).toMatchObject({ tone: 'none', chars: 0, cutOn: [] });
  });

  it('counts a date a dated result opens with against its description', () => {
    const { state } = seoSite();
    // Fits a phone's description alone, but not once the date takes its room.
    const description = 'Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing for beginners.';
    const post = lengthMeter('description', preview(withTypedSeo(state, POST, { description }), POST));
    const page = lengthMeter('description', preview(withTypedSeo(state, PAGE, { description }), PAGE));
    expect(page.cutOn).toEqual([]);
    expect(post.cutOn).toEqual(['mobile']);
  });
});

describe('structuredPreview', () => {
  it('shows the graph the exported page carries, and where the page is published', () => {
    const { state } = seoSite();
    const s = structuredPreview(state, PAGE)!;
    expect(s.graph.kind).toBe('graph');
    expect(JSON.parse((s.graph as { json: string }).json)).toEqual(documentGraph(publishedState(state), PAGE));
    expect(webpage(graphOf(state, PAGE))).toMatchObject({ url: SERVICES, name: 'Classes and commissions · Riverside Studio' });
    expect(Object.fromEntries(s.status.map((l) => [l.id, l.on]))).toEqual({ canonical: true, search: true, sitemap: true, structured: true, llms: true, siteSearch: true });
    expect(s.status.find((l) => l.id === 'canonical')!.value).toBe(SERVICES);
  });

  it('shows a post’s graph with typed text in it before it is saved', () => {
    const { state } = seoSite();
    const node = webpage(graphOf(withTypedSeo(state, POST, { title: 'Throwing pots this spring', description: 'Six weeks at the wheel.' }), POST));
    expect(node).toMatchObject({ url: SPRING, name: 'Throwing pots this spring', description: 'Six weeks at the wheel.' });
    expect(structuredPreview(state, POST)!.status.find((l) => l.id === 'siteSearch')).toMatchObject({ on: true, value: 'May find it' });
    const hidden = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', searchHidden: true });
    expect(structuredPreview(hidden, POST)!.status.find((l) => l.id === 'siteSearch')).toMatchObject({ on: false, value: 'Hidden from site search' });
  });

  it('follows the post’s sharing image and the site’s publisher', () => {
    const { state } = seoSite();
    const pictured = webpage(graphOf(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', socialImage: 'img_bowls' }), POST));
    expect((pictured.primaryImageOfPage as { url: string }).url).toMatch(/img_bowls/);
    const person = graphOf(run(state, { type: 'site.update', identity: { kind: 'Person', name: 'Ana Ribeiro' } }), POST);
    const publisher = person['@graph'].find((n) => n['@type'] === 'Person')!;
    expect(publisher).toMatchObject({ '@id': 'https://example.com/studio/#person', name: 'Ana Ribeiro' });
    expect(person['@graph'].find((n) => n['@type'] === 'WebSite')!.publisher).toEqual({ '@id': 'https://example.com/studio/#person' });
  });

  it('keeps the graph for a copy whose canonical URL is elsewhere, but leaves it out of the sitemap and llms.txt', () => {
    const { state } = seoSite();
    const s = structuredPreview(withTypedSeo(state, POST, { canonical: 'https://journal.example/spring/' }), POST)!;
    const on = Object.fromEntries(s.status.map((l) => [l.id, l]));
    expect(on.canonical).toMatchObject({ on: false, value: 'https://journal.example/spring/ (another address)' });
    expect(on.structured.on).toBe(true);
    expect(on.sitemap).toMatchObject({ on: false, value: 'No: its canonical URL names another address, so this copy is left out' });
    expect(on.llms).toMatchObject({ on: false, value: 'No: its canonical URL names another address, so this copy is left out' });
    expect(s.graph.kind).toBe('graph');
    // Without a public URL of its own, the override still names another address.
    const bare = structuredPreview(withTypedSeo(run(state, { type: 'site.update', baseUrl: '' }), POST, { canonical: 'https://journal.example/spring/' }), POST)!;
    expect(bare.status.find((l) => l.id === 'canonical')).toMatchObject({ on: false, value: 'https://journal.example/spring/ (another address)' });
  });

  it('says why a draft, a hidden page or a site without a public URL carries none', () => {
    const { state } = seoSite();
    const draft = structuredPreview(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true }), POST)!;
    expect(draft.graph).toMatchObject({ kind: 'none', reason: expect.stringMatching(/^Drafts carry no structured data/) });
    expect((draft.graph as { reason: string }).reason).toMatch(/Once the post is published, its page carries/);
    const hiddenDraft = structuredPreview(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true, noindex: true }), POST)!;
    expect((hiddenDraft.graph as { reason: string }).reason).toMatch(/still hidden from search engines, so it carries none then either/);
    const bareDraft = structuredPreview(run(state, { type: 'site.update', baseUrl: '' }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true }), POST)!;
    expect((bareDraft.graph as { reason: string }).reason).toMatch(/published and the site has a public URL/);
    expect(draft.status.find((l) => l.id === 'search')!.value).toMatch(/^Not while it is a draft/);
    const hidden = structuredPreview(run(state, { type: 'page.update', pageId: 'pg_services', noindex: true }), PAGE)!;
    expect(hidden.graph).toMatchObject({ kind: 'none', reason: expect.stringMatching(/hidden from search engines/) });
    expect(Object.fromEntries(hidden.status.map((l) => [l.id, l.on]))).toMatchObject({ search: false, sitemap: false, structured: false, llms: false, siteSearch: true });
    const bare = structuredPreview(run(state, { type: 'site.update', baseUrl: '' }), PAGE)!;
    expect(bare.graph).toMatchObject({ kind: 'none', reason: expect.stringMatching(/Public URL/) });
    expect(bare.status.find((l) => l.id === 'canonical')).toMatchObject({ on: false, value: 'None: the site has no public URL' });
    const noLlms = structuredPreview(run(state, { type: 'site.update', llmsTxt: false }), PAGE)!;
    expect(noLlms.status.find((l) => l.id === 'llms')).toMatchObject({ on: false, value: 'The site writes no llms.txt' });
  });

  it('is nothing for a document the project does not have', () => {
    const { state } = seoSite();
    expect(structuredPreview(state, { kind: 'page', pageId: 'pg_gone' })).toBeNull();
  });
});
