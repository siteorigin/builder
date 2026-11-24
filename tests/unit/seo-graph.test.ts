/**
 * The connected Schema.org graph (#580): one JSON-LD graph per document, whose organization, website, page and
 * breadcrumb entities refer to each other by stable IDs, and that features add entities to without colliding.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { SeoSubject } from '@shared/seo';
import { createSeoResolver } from '@generator/seo-metadata';
import { buildSeoGraph, graphIds, graphScriptText, type GraphContributor, type GraphNode, type SeoGraph } from '@generator/seo-graph';
import { copy, run, seoSite } from './fixtures/seo-site';

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
    const elsewhere = copy(state);
    elsewhere.pages[services].seo.canonical = 'https://partner.example/classes';
    expect(graphOf(elsewhere, { kind: 'page', pageId: services })).toBeNull();
    expect(graphOf(state, { kind: 'page', pageId: 'pg_gone' })).toBeNull();
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
      nodes: [{ '@type': 'Person', '@id': ids.site('person'), name: 'Ana Ruiz' }],
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
    expect(JSON.stringify(graphOf(state, SPRING, [person, posting]))).toBe(JSON.stringify(g));
    // A page the posting says nothing about has only what the person adds.
    expect(graphOf(state, { kind: 'page', pageId: state.site.homePageId }, [posting, person])!['@graph'].map((n) => n['@type'])).toEqual([['Organization', 'LocalBusiness'], 'WebSite', 'WebPage', 'BreadcrumbList', 'Person']);
    // Setting a value a node already has is no conflict.
    expect(() => graphOf(state, SPRING, [() => ({ extend: [{ id: 'https://example.com/studio/#website', set: { name: 'Riverside Studio' } }] })])).not.toThrow();
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
    // A reference to an entity somewhere else on the web is not the graph's to have.
    expect(refused(({ ids }) => ({ extend: [{ id: ids.organization, set: { parentOrganization: { '@id': 'https://group.example/#org' } } }] }))).not.toThrow();
  });

  it('keeps what a contributor holds on to from changing the graph after it is built', () => {
    const { state } = seoSite();
    const held: GraphNode = { '@type': 'Person', '@id': 'https://example.com/studio/#person', name: 'Ana' };
    const g = graphOf(state, SPRING, [() => ({ nodes: [held] })])!;
    held.name = 'Changed';
    expect(node(g, 'https://example.com/studio/#person').name).toBe('Ana');
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
    expect(() => ids.site('Local Business')).toThrow(/not a graph ID fragment/);
    expect(() => ids.page('')).toThrow();
    const { state, home } = seoSite();
    const s = run(state, { type: 'site.update', name: 'Pots </script><script>alert(1)</script>' });
    const text = graphScriptText(graphOf(s, { kind: 'page', pageId: home })!);
    expect(text).not.toContain('<');
    expect(JSON.parse(text)['@graph'][0].name).toBe('Pots </script><script>alert(1)</script>');
  });
});
