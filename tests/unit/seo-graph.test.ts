/**
 * The connected Schema.org graph (#580): one JSON-LD graph per document, whose organization, website, page and
 * breadcrumb entities refer to each other by stable IDs, and that features add entities to without colliding.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { createSeoResolver } from '@generator/seo-metadata';
import { buildSeoGraph, graphIds, graphScriptText, type GraphContributor, type GraphNode, type SeoGraph } from '@generator/seo-graph';
import { run, seoSite } from './fixtures/seo-site';

const graphOf = (s: ProjectState, subject: SeoSubject, contributors: GraphContributor[] = []) => buildSeoGraph(s, createSeoResolver(s), subject, contributors);
const node = (g: SeoGraph, id: string) => g['@graph'].find((n) => n['@id'] === id) as GraphNode;
const SPRING: SeoSubject = { kind: 'entry', collectionId: 'posts', entryId: 'en_spring' };

/** Every `@id` a node's properties refer to. */
function refs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refs);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => (k === '@id' && typeof v === 'string' ? [v] : refs(v)));
}

/** Every reference in the graph names one of its nodes. */
function expectLinked(g: SeoGraph) {
  const ids = g['@graph'].map((n) => n['@id']);
  expect(new Set(ids).size).toBe(ids.length);
  for (const n of g['@graph']) for (const id of refs(Object.fromEntries(Object.entries(n).filter(([k]) => k !== '@id')))) expect(ids, `${n['@id']} → ${id}`).toContain(id);
}

describe('buildSeoGraph', () => {
  it('links the organization, website, Home page and its breadcrumb by IDs hung off the public URL', () => {
    const { state, home } = seoSite();
    const g = graphOf(state, { kind: 'page', pageId: home })!;
    expect(g['@context']).toBe('https://schema.org');
    expect(g['@graph'].map((n) => [n['@type'], n['@id']])).toEqual([
      ['Organization', 'https://example.com/studio/#organization'],
      ['WebSite', 'https://example.com/studio/#website'],
      ['WebPage', 'https://example.com/studio/#webpage'],
      ['BreadcrumbList', 'https://example.com/studio/#breadcrumb']
    ]);
    expectLinked(g);
    expect(node(g, 'https://example.com/studio/#organization')).toEqual({ '@type': 'Organization', '@id': 'https://example.com/studio/#organization', name: 'Riverside Studio', url: 'https://example.com/studio/' });
    expect(node(g, 'https://example.com/studio/#website')).toMatchObject({ url: 'https://example.com/studio/', name: 'Riverside Studio', inLanguage: 'en', publisher: { '@id': 'https://example.com/studio/#organization' } });
    expect(node(g, 'https://example.com/studio/#webpage')).toMatchObject({
      url: 'https://example.com/studio/',
      name: 'Riverside Studio · Pottery classes and handmade work',
      description: 'Pottery classes for beginners and a shop of handmade bowls, cups and plates, by the river in town.',
      isPartOf: { '@id': 'https://example.com/studio/#website' },
      breadcrumb: { '@id': 'https://example.com/studio/#breadcrumb' },
      primaryImageOfPage: { '@type': 'ImageObject', url: 'https://example.com/studio/assets/img_share-1a2b3c4d.png' }
    });
    expect(node(g, 'https://example.com/studio/#breadcrumb').itemListElement).toEqual([{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/studio/' }]);
  });

  it('gives a nested page and an entry a breadcrumb through the pages and the collection index above them', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_kilns', title: 'Kiln hire', route: '/services/kiln-hire/' });
    const g = graphOf(s, { kind: 'page', pageId: 'pg_kilns' })!;
    expectLinked(g);
    expect(node(g, 'https://example.com/studio/services/kiln-hire/#breadcrumb').itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/studio/' },
      { '@type': 'ListItem', position: 2, name: 'Services', item: 'https://example.com/studio/services/' },
      { '@type': 'ListItem', position: 3, name: 'Kiln hire', item: 'https://example.com/studio/services/kiln-hire/' }
    ]);
    const post = graphOf(s, SPRING)!;
    expectLinked(post);
    expect(node(post, 'https://example.com/studio/blog/spring-pottery-classes/#breadcrumb').itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/studio/' },
      { '@type': 'ListItem', position: 2, name: 'Posts', item: 'https://example.com/studio/blog/' },
      { '@type': 'ListItem', position: 3, name: 'Spring pottery classes', item: 'https://example.com/studio/blog/spring-pottery-classes/' }
    ]);
    // Every document names the same publisher and website, and a page of its own.
    const services1 = graphOf(s, { kind: 'page', pageId: services })!;
    expect(services1['@graph'].slice(0, 2)).toEqual(post['@graph'].slice(0, 2));
    expect(node(services1, 'https://example.com/studio/services/#webpage')).toBeTruthy();
  });

  it('gives no graph to a document search engines are not to list, or without a public URL', () => {
    const { state, services } = seoSite();
    expect(graphOf(run(state, { type: 'page.update', pageId: services, noindex: true }), { kind: 'page', pageId: services })).toBeNull();
    expect(graphOf(run(state, { type: 'page.update', pageId: services, draft: true }), { kind: 'page', pageId: services })).toBeNull();
    expect(graphOf(run(state, { type: 'site.update', baseUrl: '' }), { kind: 'page', pageId: services })).toBeNull();
    expect(graphOf(state, { kind: 'page', pageId: 'pg_gone' })).toBeNull();
    // Contributors are not asked about a document with no graph.
    let asked = 0;
    expect(graphOf(run(state, { type: 'page.update', pageId: services, noindex: true }), { kind: 'page', pageId: services }, [() => (asked++, null)])).toBeNull();
    expect(asked).toBe(0);
  });

  it('takes linked entities and extensions from contributors, in the same order whichever contributes first', () => {
    const { state } = seoSite();
    const posting: GraphContributor = ({ ids, meta }) =>
      meta.subject.kind !== 'entry'
        ? null
        : {
            nodes: [{ '@type': 'BlogPosting', '@id': ids.page('blogposting'), headline: 'Spring pottery classes', publisher: { '@id': ids.organization }, mainEntityOfPage: { '@id': ids.webpage }, author: { '@id': ids.site('person') } }],
            extend: [{ id: ids.organization, add: { sameAs: ['https://social.example/riverside'] } }]
          };
    const person: GraphContributor = ({ ids }) => ({
      nodes: [{ '@type': 'Person', '@id': ids.site('person'), name: 'Ana Ruiz', worksFor: { '@id': ids.organization } }],
      extend: [
        { id: ids.website, set: { potentialAction: { '@type': 'SearchAction', target: 'https://example.com/studio/search/?q={query}', 'query-input': 'required name=query' } } },
        { id: ids.organization, add: { sameAs: 'https://wiki.example/Riverside_Studio', '@type': 'LocalBusiness' } }
      ]
    });
    const g = graphOf(state, SPRING, [posting, person])!;
    expectLinked(g);
    expect(g['@graph'].map((n) => n['@id'])).toEqual([
      'https://example.com/studio/#organization',
      'https://example.com/studio/#website',
      'https://example.com/studio/blog/spring-pottery-classes/#webpage',
      'https://example.com/studio/blog/spring-pottery-classes/#breadcrumb',
      'https://example.com/studio/#person',
      'https://example.com/studio/blog/spring-pottery-classes/#blogposting'
    ]);
    expect(node(g, 'https://example.com/studio/#organization')).toMatchObject({ '@type': ['Organization', 'LocalBusiness'], sameAs: ['https://social.example/riverside', 'https://wiki.example/Riverside_Studio'] });
    expect(node(g, 'https://example.com/studio/#website').potentialAction).toMatchObject({ '@type': 'SearchAction' });
    expect(node(g, 'https://example.com/studio/blog/spring-pottery-classes/#blogposting')).toEqual({
      '@type': 'BlogPosting',
      '@id': 'https://example.com/studio/blog/spring-pottery-classes/#blogposting',
      headline: 'Spring pottery classes',
      publisher: { '@id': 'https://example.com/studio/#organization' },
      mainEntityOfPage: { '@id': 'https://example.com/studio/blog/spring-pottery-classes/#webpage' },
      author: { '@id': 'https://example.com/studio/#person' }
    });
    expect(JSON.stringify(graphOf(state, SPRING, [person, posting]))).toBe(JSON.stringify(g));
    // A page the posting says nothing about has only what the person adds.
    expect(graphOf(state, { kind: 'page', pageId: state.site.homePageId }, [posting, person])!['@graph'].map((n) => n['@type'])).toEqual([['Organization', 'LocalBusiness'], 'WebSite', 'WebPage', 'BreadcrumbList', 'Person']);
    // Setting a value a node already has is no conflict, nor is the same value with its keys in another order.
    expect(() => graphOf(state, SPRING, [() => ({ extend: [{ id: 'https://example.com/studio/#website', set: { name: 'Riverside Studio' } }] })])).not.toThrow();
    const action = (a: Record<string, string>): GraphContributor => ({ ids }) => ({ extend: [{ id: ids.website, set: { potentialAction: a } }] });
    const a = action({ '@type': 'SearchAction', target: 'x' });
    const b = action({ target: 'x', '@type': 'SearchAction' });
    expect(graphScriptText(graphOf(state, SPRING, [a, b])!)).toBe(graphScriptText(graphOf(state, SPRING, [b, a])!));
  });

  it('links entities described in place to the node that holds them', () => {
    const { state } = seoSite();
    const shop: GraphContributor = ({ ids }) => ({ extend: [{ id: ids.webpage, set: { about: { '@id': ids.site('shop'), '@type': 'Store', name: 'The studio shop' } } }] });
    const worker: GraphContributor = ({ ids }) => ({ nodes: [{ '@type': 'Person', '@id': ids.site('ana'), worksFor: { '@id': ids.site('shop') } }] });
    const g = graphOf(state, SPRING, [shop, worker])!;
    expect(node(g, 'https://example.com/studio/#ana')).toMatchObject({ worksFor: { '@id': 'https://example.com/studio/#shop' } });
    // An address elsewhere that two nodes both name does not link them to each other.
    const elsewhere: GraphContributor = ({ ids }) => ({
      nodes: [
        { '@type': 'Person', '@id': ids.site('ana'), worksFor: { '@id': ids.organization }, knows: { '@id': 'https://people.example/ben' } },
        { '@type': 'Person', '@id': ids.site('cat'), knows: { '@id': 'https://people.example/ben' } }
      ] as GraphNode[]
    });
    expect(() => graphOf(state, SPRING, [elsewhere])).toThrow(/#cat is linked to nothing else/);
  });

  it('writes the same bytes whichever contributor sets new properties on a node first', () => {
    const { state } = seoSite();
    const alternate: GraphContributor = ({ ids }) => ({ extend: [{ id: ids.organization, set: { alternateName: 'Riverside' } }] });
    const logo: GraphContributor = ({ ids }) => ({ extend: [{ id: ids.organization, set: { logo: 'https://example.com/studio/assets/logo.png' }, add: { knowsAbout: ['Pottery', 'Glazing'] } }] });
    const topics: GraphContributor = ({ ids }) => ({ extend: [{ id: ids.organization, add: { knowsAbout: 'Kilns', areaServed: 'Riverside' } }] });
    const one = graphScriptText(graphOf(state, SPRING, [alternate, logo, topics])!);
    expect(graphScriptText(graphOf(state, SPRING, [topics, logo, alternate])!)).toBe(one);
    expect(JSON.parse(one)['@graph'][0]).toMatchObject({ alternateName: 'Riverside', logo: 'https://example.com/studio/assets/logo.png', knowsAbout: ['Glazing', 'Kilns', 'Pottery'], areaServed: 'Riverside' });
  });

  it('refuses contributions that would make the graph say two things', () => {
    const { state } = seoSite();
    const refused = (...contributors: GraphContributor[]) => () => graphOf(state, SPRING, contributors);
    const person: GraphContributor = ({ ids }) => ({ nodes: [{ '@type': 'Person', '@id': ids.site('person'), name: 'Ana' }] });
    expect(refused(person, person)).toThrow(/another contributor added too/);
    expect(refused(({ ids }) => ({ nodes: [{ '@type': 'WebPage', '@id': ids.webpage }] }))).toThrow(/already has: extend it instead/);
    expect(refused(({ ids }) => ({ extend: [{ id: ids.site('nobody'), set: { name: 'x' } }] }))).toThrow(/does not have/);
    expect(refused(({ ids }) => ({ extend: [{ id: ids.website, set: { name: 'Another name' } }] }))).toThrow(/already has another value/);
    expect(refused(({ ids }) => ({ extend: [{ id: ids.website, set: { '@id': 'https://elsewhere.example/#x' } }] }))).toThrow(/tried to change @id/);
    expect(refused(({ ids }) => ({ nodes: [{ '@type': 'BlogPosting', '@id': ids.page('blogposting'), author: { '@id': ids.site('person') } }] }))).toThrow(/refers to https:\/\/example\.com\/studio\/#person/);
    expect(refused(() => ({ nodes: [{ '@type': 'Thing' } as unknown as GraphNode] }))).toThrow(/without an @id/);
    expect(refused(({ ids }) => ({ nodes: [{ '@id': ids.site('thing') } as unknown as GraphNode] }))).toThrow(/without an @id and an @type/);
    // A node is one of this site's or document's, made by ids, and is linked to the rest of the graph.
    expect(refused(() => ({ nodes: [{ '@type': 'Person', '@id': 'https://elsewhere.example/#ana', name: 'Ana' }] }))).toThrow(/not an ID of this site or document/);
    expect(refused(() => ({ nodes: [{ '@type': 'WebPage', '@id': '#webpage' }] }))).toThrow(/not an ID of this site or document/);
    expect(refused(person)).toThrow(/#person is linked to nothing else/);
    expect(
      refused(({ ids }) => ({
        nodes: [
          { '@type': 'Person', '@id': ids.site('ana'), knows: { '@id': ids.site('ben') } },
          { '@type': 'Person', '@id': ids.site('ben'), knows: { '@id': ids.site('ana') } }
        ]
      }))
    ).toThrow(/linked to nothing else/);
    // References are absolute addresses, written without spaces.
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { author: { '@id': '#missing' } } }] }))).toThrow(/not an absolute address/);
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { author: { '@id': ` ${ids.site('person')}` } } }] }))).toThrow(/not an absolute address/);
    // A reference to the graph's own address must resolve, however its fragment is written; a web address is written whole.
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { about: { '@id': `${ids.webpage.split('#')[0]}#service_details` } } }] }))).toThrow(/which the graph does not have/);
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { about: { '@id': 'https:elsewhere.example' } } }] }))).toThrow(/not an absolute address/);
    // Entities come as nodes of their own, never through @included.
    expect(
      refused(({ ids }) => ({
        extend: [{ id: ids.webpage, set: { '@included': [{ '@id': ids.site('service'), '@type': 'Service', name: 'Classes' }] } }],
        nodes: [{ '@type': 'Offer', '@id': ids.site('offer'), itemOffered: { '@id': ids.site('service') } }]
      }))
    ).toThrow(/@included/);
    // JSON-LD keywords beside an @id keep it a reference, and an IRI of another scheme is an address.
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { about: { '@id': ids.organization, '@index': 'publisher' } } }] }))).not.toThrow();
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { citation: { '@id': 'urn:isbn:9780000000001', '@type': 'Book', name: 'Clay' } } }] }))).not.toThrow();
    // An entity is described once, in place or as a node.
    expect(
      refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { about: { '@id': ids.site('shop'), '@type': 'Store', name: 'Shop' }, mentions: { '@id': ids.site('shop'), '@type': 'Store', name: 'Other shop' } } }] }))
    ).toThrow(/describes too: describe it once/);
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { about: { '@id': ids.organization, '@type': 'Organization', name: 'Other' } } }] }))).toThrow(/refer to it instead/);
    // A reference to an entity somewhere else on the web is not the graph's to have, and one described in place is there.
    expect(refused(({ ids }) => ({ extend: [{ id: ids.organization, set: { parentOrganization: { '@id': 'https://group.example/#org' } } }] }))).not.toThrow();
    expect(refused(({ ids }) => ({ extend: [{ id: ids.webpage, set: { author: { '@id': ids.page('author'), '@type': 'Person', name: 'Ana' } } }] }))).not.toThrow();
  });

  it('keeps what a contributor holds on to from changing the graph after it is built', () => {
    const { state } = seoSite();
    const held: GraphNode = { '@type': 'Person', '@id': 'https://example.com/studio/#person', name: 'Ana', worksFor: { '@id': 'https://example.com/studio/#organization' } };
    const g = graphOf(state, SPRING, [() => ({ nodes: [held] })])!;
    held.name = 'Changed';
    (held.worksFor as { '@id': string })['@id'] = 'https://elsewhere.example/';
    expect(node(g, 'https://example.com/studio/#person')).toMatchObject({ name: 'Ana', worksFor: { '@id': 'https://example.com/studio/#organization' } });
  });
});

describe('graphIds and graphScriptText', () => {
  it('makes IDs from fragments of one form, and embeds the graph so no text can end its script', () => {
    const ids = graphIds('https://example.com/', 'https://example.com/about/');
    expect([ids.organization, ids.website, ids.webpage, ids.breadcrumb, ids.site('localbusiness'), ids.page('faq')]).toEqual([
      'https://example.com/#organization',
      'https://example.com/#website',
      'https://example.com/about/#webpage',
      'https://example.com/about/#breadcrumb',
      'https://example.com/#localbusiness',
      'https://example.com/about/#faq'
    ]);
    expect(ids.site('local-business-2')).toBe('https://example.com/#local-business-2');
    expect(() => ids.site('Local Business')).toThrow(/not a graph ID fragment/);
    expect(() => ids.page('')).toThrow();
    const { state, home } = seoSite();
    const s = run(state, { type: 'site.update', name: 'Pots </script><script>alert(1)</script>' });
    const text = graphScriptText(graphOf(s, { kind: 'page', pageId: home })!);
    expect(text).not.toContain('<');
    expect(JSON.parse(text)['@graph'][0].name).toBe('Pots </script><script>alert(1)</script>');
  });
});
