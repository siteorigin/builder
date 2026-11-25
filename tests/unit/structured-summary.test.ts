/**
 * The structured data in words (#706): one section of plain statements for each entity of the graph a page's or a
 * post's export writes, what the audit says of typed facts still missing, and the exact JSON-LD behind them.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import type { EditOperation } from '@shared/ops';
import { runSeoAudit } from '@engine/seo-audit';
import { documentGraph } from '@generator/structured-data';
import { graphScript } from '@generator/structured-data';
import { publishedState } from '@generator/index';
import type { GraphNode, SeoGraph } from '@generator/seo-graph';
import { structuredPreview } from '../../src/renderer/src/lib/seo-preview';
import { summarizeGraph, writtenDate, type GraphSection } from '../../src/renderer/src/lib/structured-summary';
import { copy, run, seoSite } from './fixtures/seo-site';

const ROOT = 'https://example.com/studio/';
const SERVICES = `${ROOT}services/`;
const PAGE: SeoSubject = { kind: 'page', pageId: 'pg_services' };
const POST: SeoSubject = { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' };

type Facts = NonNullable<Extract<EditOperation, { type: 'page.update' }>['structuredData']>;
const typed = (s: ProjectState, structuredData: Facts) => run(s, { type: 'page.update', pageId: 'pg_services', structuredData });
const sections = (s: ProjectState, subject: SeoSubject = PAGE) => summarizeGraph(documentGraph(publishedState(s), subject)!);
const at = (list: GraphSection[], heading: string) => {
  const found = list.find((s) => s.heading === heading);
  if (!found) throw new Error(`no “${heading}” section: ${list.map((s) => s.heading).join(', ')}`);
  return found;
};
const rows = (s: GraphSection) => Object.fromEntries(s.rows.map((r) => [r.label, r.value]));
const headings = (list: GraphSection[]) => list.map((s) => s.heading);

describe('writtenDate', () => {
  it('writes a day or a time in words, keeping the time and offset as written', () => {
    expect(writtenDate('2027-05-14')).toBe('14 May 2027');
    expect(writtenDate('2027-05-14T19:30')).toBe('14 May 2027 at 19:30');
    expect(writtenDate('2027-05-14T23:30+02:00')).toBe('14 May 2027 at 23:30 (UTC+02:00)');
    expect(writtenDate('2027-05-14T19:30:15Z')).toBe('14 May 2027 at 19:30:15 UTC');
    expect(writtenDate('2027-02-30')).toBe('2027-02-30');
    expect(writtenDate('next spring')).toBe('next spring');
  });
});

describe('the sections of a graph', () => {
  it('says the page, its trail, the publisher and the website, one section for every entity', () => {
    const { state } = seoSite();
    const graph = documentGraph(publishedState(state), PAGE)!;
    const list = summarizeGraph(graph);
    expect(headings(list)).toEqual(['This page', 'Breadcrumb trail', 'Publisher', 'Website']);
    expect(list.map((s) => s.id).sort()).toEqual(graph['@graph'].map((n) => n['@id']).sort());
    expect(at(list, 'This page').statement).toBe('This is a web page.');
    expect(rows(at(list, 'This page'))).toMatchObject({ Title: 'Classes and commissions · Riverside Studio', Address: SERVICES, Language: 'en', Description: expect.stringMatching(/^Weekly wheel classes/) });
    expect(at(list, 'Breadcrumb trail').lists[0]).toMatchObject({ ordered: true, items: [{ detail: ROOT }, { text: 'Services', detail: SERVICES }] });
    expect(at(list, 'Publisher').statement).toBe('Riverside Studio, an organization, publishes the site.');
    expect(at(list, 'Publisher').lists).toEqual([{ label: 'Profiles elsewhere', ordered: false, items: [{ text: 'https://www.wikidata.org/wiki/Q123456' }] }]);
    expect(at(list, 'Website').statement).toBe('This page is part of the website Riverside Studio.');
    expect(rows(at(list, 'Website'))).toMatchObject({ Address: ROOT, 'Published by': 'Riverside Studio' });
  });

  it('says a local business’s contact details, hours, prices and place, and a person’s photo', () => {
    const { state } = seoSite();
    const business = run(state, {
      type: 'site.update',
      identity: { kind: 'LocalBusiness', logo: 'img_icon', address: '1 River Road, Millbrook', telephone: '+1 555 0100', email: 'hello@riverside.example', openingHours: ['Mo-Fr 09:00-17:00', 'Sa 10:00-14:00'], priceRange: '$$', geo: { latitude: 40.5, longitude: -73.25 } }
    });
    const publisher = at(sections(business), 'Publisher');
    expect(publisher.statement).toBe('Riverside Studio, a local business, publishes the site.');
    expect(rows(publisher)).toMatchObject({
      Logo: `${ROOT}assets/img_icon-1a2b3c4d.png`,
      Address: '1 River Road, Millbrook',
      Telephone: '+1 555 0100',
      Email: 'hello@riverside.example',
      'Opening hours': 'Mo-Fr 09:00-17:00, Sa 10:00-14:00',
      'Price range': '$$',
      'Map position': '40.5, -73.25'
    });
    const person = at(sections(run(state, { type: 'site.update', identity: { kind: 'Person', name: 'Ana Ruiz', logo: 'img_icon' } })), 'Publisher');
    expect(person.statement).toBe('Ana Ruiz, a person, publishes the site.');
    expect(rows(person).Photo).toBe(`${ROOT}assets/img_icon-1a2b3c4d.png`);
  });

  it('says a post is a blog posting, with its headline apart from its search title, its author, dates and picture', () => {
    const { state } = seoSite();
    const s = run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', author: 'Ana Ruiz', updatedAt: '2027-04-01', seoTitle: 'Book spring classes' });
    const list = sections(s, POST);
    expect(headings(list).slice(0, 2)).toEqual(['This page', 'Blog post']);
    const post = at(list, 'Blog post');
    expect(post.statement).toBe('The page is about a blog post, “Spring pottery classes”.');
    expect(rows(post)).toMatchObject({ Headline: 'Spring pottery classes', Author: 'Ana Ruiz', Published: '2 March 2027', 'Last modified': '1 April 2027', Image: expect.stringContaining(ROOT), Publisher: 'Riverside Studio' });
    expect(rows(at(list, 'This page'))).toMatchObject({ Title: 'Book spring classes', 'Last updated': '1 April 2027' });
    // Never revised: the post says no more of it than the graph does.
    const unrevised = sections(state, POST);
    expect(rows(at(unrevised, 'This page'))).not.toHaveProperty('Last updated');
    expect(rows(at(unrevised, 'Blog post'))).not.toHaveProperty('Author');
  });

  it('calls another collection’s entry an article', () => {
    const { state } = seoSite();
    const graph = documentGraph(publishedState(state), POST)!;
    const other: SeoGraph = { ...graph, '@graph': graph['@graph'].map((n) => (n['@type'] === 'BlogPosting' ? { ...n, '@type': 'Article' } : n)) };
    expect(at(summarizeGraph(other), 'Article').statement).toBe('The page is about an article, “Spring pottery classes”.');
  });

  it('says About and Contact pages', () => {
    const { state } = seoSite();
    expect(at(sections(typed(state, { type: 'AboutPage' })), 'This page').statement).toBe('This is an About page.');
    expect(at(sections(typed(state, { type: 'ContactPage' })), 'This page').statement).toBe('This is a Contact page.');
  });

  it('says a service, with who provides it', () => {
    const { state } = seoSite();
    const list = sections(typed(state, { type: 'Service', serviceType: 'Pottery classes', areaServed: 'Millbrook' }));
    const service = at(list, 'Service');
    expect(headings(list).slice(0, 2)).toEqual(['This page', 'Service']);
    expect(service.statement).toBe('The page is about the service “Services”.');
    expect(rows(service)).toEqual({ Name: 'Services', Description: expect.any(String), 'Service type': 'Pottery classes', 'Area served': 'Millbrook', 'Provided by': 'Riverside Studio' });
  });

  it('says a product’s price, availability, offer and seller', () => {
    const { state } = seoSite();
    const product = at(sections(typed(state, { type: 'Product', price: '129.50', currency: 'ZAR', availability: 'PreOrder', offerUrl: 'https://shop.example/bowls' })), 'Product');
    expect(rows(product)).toMatchObject({ Price: '129.50 ZAR', Availability: 'Pre-order', 'Offer address': 'https://shop.example/bowls', 'Sold by': 'Riverside Studio' });
  });

  it('says when and where an event is, and who organizes it', () => {
    const { state } = seoSite();
    const event = at(sections(typed(state, { type: 'Event', startDate: '2027-05-14T19:30+02:00', endDate: '2027-05-15', venue: 'The Boathouse', address: '2 River Road' })), 'Event');
    expect(rows(event)).toMatchObject({ Starts: '14 May 2027 at 19:30 (UTC+02:00)', Ends: '15 May 2027', Venue: 'The Boathouse', 'Venue address': '2 River Road', 'Organized by': 'Riverside Studio' });
  });

  it('lists a guide’s steps in order', () => {
    const { state } = seoSite();
    const guide = at(sections(typed(state, { type: 'HowTo', steps: ['Wedge the clay', 'Centre it', 'Open it'] })), 'How-to guide');
    expect(guide.lists).toEqual([{ label: 'Steps', ordered: true, items: [{ text: 'Wedge the clay' }, { text: 'Centre it' }, { text: 'Open it' }] }]);
    expect(rows(guide).Publisher).toBe('Riverside Studio');
  });

  it('says an FAQ page’s questions with their answers, and where the website is searched', () => {
    const { state } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_faq', title: 'Questions', route: '/faq/', starter: 'faq' });
    const graph = documentGraph(publishedState(s), { kind: 'page', pageId: 'pg_faq' })!;
    const asked = graph['@graph'].find((n) => n['@id'] === `${ROOT}faq/#webpage`)!.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
    expect(asked.length).toBeGreaterThan(1);
    const page = at(summarizeGraph(graph), 'This page');
    expect(page.statement).toBe('This is an FAQ page.');
    expect(page.lists).toEqual([{ label: 'Questions and answers', ordered: true, items: asked.map((q) => ({ text: q.name, detail: q.acceptedAnswer.text })) }]);

    const searched: SeoGraph = {
      ...graph,
      '@graph': graph['@graph'].map((n) => (n['@type'] === 'WebSite' ? { ...n, potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${ROOT}search/?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } } : n))
    };
    expect(rows(at(summarizeGraph(searched), 'Website'))['Search address']).toBe(`${ROOT}search/?q={search_term_string}`);
  });

  it('says each contact section’s own details, in the order the page shows them, on a page of two kinds', () => {
    const graph = documentGraph(publishedState(seoSite().state), PAGE)!;
    const contact = (i: number, about: unknown) => ({ '@type': 'WebPageElement', '@id': `${SERVICES}#${i > 1 ? `contact-${i}` : 'contact'}`, isPartOf: { '@id': `${SERVICES}#webpage` }, about }) as GraphNode;
    const many = Array.from({ length: 10 }, (_, i) =>
      contact(i + 1, i === 1 ? { '@type': 'Place', address: '2 River Road' } : [{ '@type': 'ContactPoint', email: i === 0 ? ['a@example.com', 'b@example.com'] : `s${i + 1}@example.com`, telephone: '+1 555 0100' }, { '@type': 'Place', address: '1 Mill Lane' }, { '@type': 'Place', address: '3 Weir Street' }])
    );
    const list = summarizeGraph({
      ...graph,
      // The graph orders added entities by ID, so #contact-10 comes before #contact-2.
      '@graph': [...graph['@graph'].map((n) => (n['@type'] === 'WebPage' ? { ...n, '@type': ['WebPage', 'ContactPage', 'FAQPage'] } : n)), ...[...many].sort((a, b) => (a['@id'] < b['@id'] ? -1 : 1))]
    });
    expect(at(list, 'This page').statement).toBe('This is a Contact page and an FAQ page.');
    expect(list.filter((s) => s.heading.startsWith('Contact section')).map((s) => s.id)).toEqual(many.map((n) => n['@id']));
    expect(rows(at(list, 'Contact section 1'))).toEqual({ Email: 'a@example.com, b@example.com', Telephone: '+1 555 0100', 'Address 1': '1 Mill Lane', 'Address 2': '3 Weir Street' });
    expect(rows(at(list, 'Contact section 2'))).toEqual({ Address: '2 River Road' });
  });

  it('leaves nothing out: an entity and a value it has no words for are listed under their own names', () => {
    const graph = documentGraph(publishedState(seoSite().state), PAGE)!;
    const list = summarizeGraph({
      ...graph,
      '@graph': [
        ...graph['@graph'].map((n) => (n['@type'] === 'WebPage' ? { ...n, speakableSummary: 'Classes by the river' } : n)),
        { '@type': 'Course', '@id': `${SERVICES}#course`, name: 'Wheel course', provider: { '@id': `${ROOT}#organization` }, offers: { '@type': 'Offer', price: '10' } }
      ]
    });
    expect(rows(at(list, 'This page'))['Speakable summary']).toBe('Classes by the river');
    expect(at(list, 'Course').statement).toBe('The graph also describes an entity of the type Course.');
    expect(rows(at(list, 'Course'))).toEqual({ Name: 'Wheel course', Provider: 'Riverside Studio', Offers: 'Price: 10' });
  });
});

describe('structuredPreview in words', () => {
  const audit = (s: ProjectState) => runSeoAudit(s).filter((f) => f.code.startsWith('SEO_PAGE_STRUCTURED_DATA'));
  const preview = (s: ProjectState, subject: SeoSubject = PAGE) => structuredPreview(s, subject)!;

  it('says what the audit says of incomplete typed facts, and links to them, with the entity left unsaid', () => {
    const { state } = seoSite();
    const s = typed(state, { type: 'Product', price: '12' });
    const found = preview(s);
    expect(found.problem).toEqual(audit(s)[0]);
    expect(found.problem).toMatchObject({ code: 'SEO_PAGE_STRUCTURED_DATA_INCOMPLETE', message: expect.stringContaining('Add the currency.'), destination: { kind: 'pageSeo', pageId: 'pg_services', field: 'structuredData' } });
    expect(found.graph.kind === 'graph' && headings(found.graph.sections)).not.toContain('Product');
    const done = typed(s, { currency: 'ZAR' });
    expect(preview(done).problem).toBeNull();
    expect(audit(done)).toEqual([]);
  });

  it('says what can’t be used while the entity is still written', () => {
    const { state } = seoSite();
    const s = copy(typed(state, { type: 'Product', price: '12', currency: 'ZAR' }));
    (s.pages.pg_services.seo.structuredData as { offerUrl?: string }).offerUrl = 'not an address';
    const found = preview(s);
    expect(found.problem).toEqual(audit(s)[0]);
    expect(found.problem?.code).toBe('SEO_PAGE_STRUCTURED_DATA_UNUSABLE');
    expect(found.graph.kind === 'graph' && headings(found.graph.sections)).toContain('Product');
  });

  it('judges the same pages the audit does', () => {
    const { state } = seoSite();
    const s = typed(state, { type: 'Event' });
    for (const [what, next, judged] of [
      ['no public URL yet', run(s, { type: 'site.update', baseUrl: '' }), true],
      ['hidden from search engines', run(s, { type: 'page.update', pageId: 'pg_services', noindex: true }), false],
      ['a draft', run(s, { type: 'page.update', pageId: 'pg_services', draft: true }), false]
    ] as const) {
      expect(!!preview(next).problem, what).toBe(judged);
      expect(audit(next).length > 0, what).toBe(judged);
    }
    expect(preview(state, POST).problem).toBeNull();
  });

  it('keeps the JSON-LD exactly as the exported page writes it', () => {
    const { state } = seoSite();
    const s = run(state, { type: 'page.update', pageId: 'pg_services', description: 'Bowls </script> & cups <by hand>' });
    for (const subject of [PAGE, POST]) {
      const graph = preview(s, subject).graph;
      if (graph.kind !== 'graph') throw new Error(graph.kind);
      expect(`<script type="application/ld+json">${graph.json}</script>`).toBe(graphScript(publishedState(s), subject));
    }
  });
});
