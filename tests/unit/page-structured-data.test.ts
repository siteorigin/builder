/**
 * Typed page structured data (#595): what a page is beyond a web page (an About or Contact page, or one of the
 * publisher's own services, products, events or guides), the facts `page.update` saves for it, the entity the page's
 * connected Schema.org graph names once those facts are complete, and the hints the SEO audit and the Inspector give
 * while they are not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { OPERATION_SCHEMAS } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { runSeoAudit } from '@engine/seo-audit';
import { generateProject } from '@generator/index';
import { documentGraph } from '@generator/structured-data';
import type { GraphNode, SeoGraph } from '@generator/seo-graph';
import { checkCurrency, checkEventDate, checkPrice, checkSteps, endsBeforeStart, inspectPageStructuredData, patchPageStructuredData } from '@shared/page-structured-data';
import { fieldKey, readField, shownField, typedText } from '../../src/renderer/src/lib/held';
import { checkAuthority } from '../../src/agent/scope';
import { FOCUSED_PAGE_OPERATIONS, PAGE_OPERATIONS, toolDefinitions } from '../../src/agent/tools';
import { ProjectSession } from '../../src/main/project/session';
import { copy, run, seoSite } from './fixtures/seo-site';

const ROOT = 'https://example.com/studio/';
const SERVICES = `${ROOT}services/`;

const refusal = (s: ProjectState, ...ops: EditOperation[]) => {
  try {
    applyOperations(s, ops);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};
const typed = (s: ProjectState, structuredData: NonNullable<Extract<EditOperation, { type: 'page.update' }>['structuredData']>, pageId = 'pg_services') => run(s, { type: 'page.update', pageId, structuredData });
const stored = (s: ProjectState, pageId = 'pg_services') => (s.pages[pageId] as PageDoc).seo.structuredData;
const graph = (s: ProjectState, pageId = 'pg_services') => documentGraph(s, { kind: 'page', pageId })!;
const node = (g: SeoGraph, id: string) => g['@graph'].find((n) => n['@id'] === id) as GraphNode;
const ids = (g: SeoGraph) => g['@graph'].map((n) => n['@id']);

/** Every `@id` a node's properties refer to. */
function refs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refs);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => (k === '@id' && typeof v === 'string' ? [v] : refs(v)));
}

/** One graph whose IDs are each used once, and whose every reference names one of its nodes. */
function expectLinked(g: SeoGraph) {
  const all = ids(g);
  expect(new Set(all).size).toBe(all.length);
  for (const n of g['@graph']) for (const id of refs(Object.fromEntries(Object.entries(n).filter(([k]) => k !== '@id')))) expect(all, `${n['@id']} → ${id}`).toContain(id);
}

describe('the facts page.update saves for a page type', () => {
  it('saves a type, then its facts one at a time, checked and written as search engines read them', () => {
    const { state } = seoSite();
    let s = typed(state, { type: 'Product' });
    expect(stored(s)).toEqual({ type: 'Product' });
    s = typed(s, { price: ' 0 ', currency: 'zar' });
    expect(stored(s)).toEqual({ type: 'Product', price: '0', currency: 'ZAR' });
    s = typed(s, { availability: 'InStock', offerUrl: 'https://shop.example/bowls' });
    expect(stored(s)).toEqual({ type: 'Product', price: '0', currency: 'ZAR', availability: 'InStock', offerUrl: 'https://shop.example/bowls' });
    // "" clears one fact, including one the type needs: an author fills them in one at a time.
    s = typed(s, { price: '', availability: '' });
    expect(stored(s)).toEqual({ type: 'Product', currency: 'ZAR', offerUrl: 'https://shop.example/bowls' });
    // The type and its facts can come in one edit; nothing else of the page's search settings changes.
    const before = (s.pages.pg_services as PageDoc).seo;
    expect({ ...before, structuredData: undefined }).toMatchObject({ title: 'Classes and commissions · Riverside Studio', description: 'Weekly wheel classes, private lessons and commissioned tableware made to order in the studio.' });
  });

  it('keeps the facts when the same type is chosen again, starts afresh with another, and removes them all for a web page', () => {
    const { state } = seoSite();
    let s = typed(state, { type: 'Event', startDate: '2027-05-14 19:30', venue: '  Riverside   Studio ' });
    expect(stored(s)).toEqual({ type: 'Event', startDate: '2027-05-14T19:30', venue: 'Riverside Studio' });
    expect(stored(typed(s, { type: 'Event' }))).toEqual(stored(s));
    expect(stored(typed(s, { type: 'Event', endDate: '2027-05-14T22:00' }))).toEqual({ type: 'Event', startDate: '2027-05-14T19:30', endDate: '2027-05-14T22:00', venue: 'Riverside Studio' });
    // Another type drops the event's facts, so none come back unseen with a later switch.
    s = typed(s, { type: 'Product', price: '129.50' });
    expect(stored(s)).toEqual({ type: 'Product', price: '129.50' });
    expect(stored(typed(s, { type: 'Event' }))).toEqual({ type: 'Event' });
    s = typed(s, { type: 'WebPage' });
    expect(stored(s)).toBeUndefined();
    expect(Object.hasOwn((s.pages.pg_services as PageDoc).seo, 'structuredData')).toBe(false);
  });

  it('refuses a fact the type does not state, a fact before any type, and a fact that does not pass its check', () => {
    const { state } = seoSite();
    const product = typed(state, { type: 'Product' });
    expect(refusal(product, { type: 'page.update', pageId: 'pg_services', structuredData: { startDate: '2027-05-14' } })).toMatch(/Starts is not said of a Product/);
    expect(refusal(state, { type: 'page.update', pageId: 'pg_services', structuredData: { price: '10' } })).toMatch(/Choose what the page is first/);
    expect(refusal(state, { type: 'page.update', pageId: 'pg_services', structuredData: { type: 'WebPage', price: '10' } })).toMatch(/A web page states no facts/);
    expect(refusal(state, { type: 'page.update', pageId: 'pg_services', structuredData: {} })).toMatch(/Choose a page type or give a fact/);
    for (const [patch, message] of [
      [{ price: 'POA' }, /is not a price/],
      [{ price: '1,299' }, /is not a price/],
      [{ price: '-5' }, /is not a price/],
      [{ currency: 'ZZZ' }, /is not a currency code/],
      [{ offerUrl: 'shop.example' }, /needs https:\/\//],
      [{ availability: 'Maybe' }, /is not an availability/]
    ] as const)
      expect(refusal(product, { type: 'page.update', pageId: 'pg_services', structuredData: patch as never }), JSON.stringify(patch)).toMatch(message);
    // The refusal names the page, and nothing of the batch is applied.
    expect(refusal(product, { type: 'page.update', pageId: 'pg_services', structuredData: { price: 'free' } })).toMatch(/^“Services”: /);
    // The operation's schema refuses what it does not know before the engine sees it.
    expect(OPERATION_SCHEMAS['page.update'].safeParse({ type: 'page.update', pageId: 'pg_services', structuredData: { type: 'Product', colour: 'red' } }).success).toBe(false);
    expect(OPERATION_SCHEMAS['page.update'].safeParse({ type: 'page.update', pageId: 'pg_services', structuredData: { type: 'Recipe' } }).success).toBe(false);
  });

  it('checks prices, currencies, event dates and steps the same way wherever they are saved', () => {
    expect(checkPrice('129.50')).toEqual({ ok: true, value: '129.50' });
    expect(checkPrice('1e3').ok).toBe(false);
    expect(checkCurrency(' eur ')).toEqual({ ok: true, value: 'EUR' });
    expect(checkCurrency('EURO').ok).toBe(false);
    expect(checkEventDate('2028-02-29')).toEqual({ ok: true, value: '2028-02-29' });
    expect(checkEventDate('2027-02-29').ok).toBe(false);
    expect(checkEventDate('2027-05-14t09:05:30z')).toEqual({ ok: true, value: '2027-05-14T09:05:30Z' });
    expect(checkEventDate('2027-05-14T19:30+02:00')).toEqual({ ok: true, value: '2027-05-14T19:30+02:00' });
    for (const bad of ['2027-05-14T24:00', '2027-05-14T19:60', '2027-05-14T19:30:60', '2027-05-14T19:30+15:00', '2027-05-14T19:30+14:59', '2027-05-14T19:30-14:01', '14 May 2027', '2027-5-14']) expect(checkEventDate(bad).ok, bad).toBe(false);
    expect(checkEventDate('2027-05-14T19:30-14:00')).toEqual({ ok: true, value: '2027-05-14T19:30-14:00' });
    // Only the letters A to Z spell a code: "ß" upper-cased would be "SS".
    expect(checkCurrency('ßP').ok).toBe(false);
    expect(checkSteps('Wedge the clay\n\n  Centre it on   the wheel \n')).toEqual({ ok: true, value: ['Wedge the clay', 'Centre it on the wheel'] });
    expect(checkSteps(['x'.repeat(501)]).ok).toBe(false);
    expect(checkSteps(Array.from({ length: 51 }, (_, i) => `Step ${i}`)).ok).toBe(false);
    // An end compared with its start: days by day, times on the same clock by the instant, a day and a time by the day.
    expect(endsBeforeStart('2027-05-14', '2027-05-13')).toBe(true);
    expect(endsBeforeStart('2027-05-14T19:00+02:00', '2027-05-14T18:30+01:00')).toBe(false);
    expect(endsBeforeStart('2027-05-14T19:00Z', '2027-05-14T20:30+02:00')).toBe(true);
    expect(endsBeforeStart('2027-05-14T19:00', '2027-05-14')).toBe(false);
    expect(endsBeforeStart('2027-05-14T19:00', '2027-05-14T18:00+02:00')).toBe(false);
    // A local time beside a UTC one: 00:30 in Cape Town is 22:30 UTC the day before, so 23:00 UTC is after it.
    expect(endsBeforeStart('2027-05-15T00:30', '2027-05-14T23:00Z')).toBe(false);
    expect(endsBeforeStart('2027-05-20T10:00', '2027-05-14T10:00Z')).toBe(true);
    expect(endsBeforeStart('2027-05-14', '2027-05-12T23:00')).toBe(true);
    // A day and a time without an offset are the venue's own clock: the 13th at 23:00 is before the 14th begins.
    expect(endsBeforeStart('2027-05-14', '2027-05-13T23:00')).toBe(true);
    expect(endsBeforeStart('2027-05-14', '2027-05-14T08:00')).toBe(false);
    expect(endsBeforeStart('2027-05-14', '2027-05-13T23:00Z')).toBe(false);
  });

  it('patches whatever was stored by hand without trusting it, and drops it when another type is chosen', () => {
    expect(patchPageStructuredData({ type: 'Banana', price: '1' }, { price: '2' })).toEqual({ ok: false, message: expect.stringMatching(/Choose what the page is first/) });
    expect(patchPageStructuredData('Product', { type: 'Product', price: '2' })).toEqual({ ok: true, value: { type: 'Product', price: '2' } });
    expect(patchPageStructuredData({ type: 'HowTo', steps: [null] }, { type: 'Service' })).toEqual({ ok: true, value: { type: 'Service' } });
    // A fact of another type, written in by hand, goes with the next edit rather than staying out of reach.
    expect(patchPageStructuredData({ type: 'Product', price: '10', currency: 'ZAR', venue: 'Old Hall' }, { price: '12' })).toEqual({ ok: true, value: { type: 'Product', price: '12', currency: 'ZAR' } });
    expect(patchPageStructuredData({ type: 'Product', price: '10', venue: 'Old Hall' }, { type: 'Product' })).toEqual({ ok: true, value: { type: 'Product', price: '10' } });
    // An empty list where text belongs is no empty value: it can't be used.
    expect(inspectPageStructuredData({ type: 'Product', price: '10', currency: 'ZAR', offerUrl: [] })).toMatchObject({ ready: true, issues: [{ field: 'offerUrl', blocking: false }] });
  });

  it('saves facts on a page whose search settings were written by hand as something else, and leaves their limits to their checks', () => {
    const { state } = seoSite();
    for (const junk of [null, [], 'legacy']) {
      const damaged = copy(state);
      (damaged.pages.pg_services as unknown as { seo: unknown }).seo = junk;
      const s = typed(damaged, { type: 'AboutPage' });
      expect((s.pages.pg_services as PageDoc).seo, JSON.stringify(junk)).toEqual({ structuredData: { type: 'AboutPage' } });
    }
    // Counted in characters after spaces close up, as the Inspector checks them: never refused by the schema first.
    const parse = (structuredData: Record<string, unknown>) => OPERATION_SCHEMAS['page.update'].safeParse({ type: 'page.update', pageId: 'pg_services', structuredData }).success;
    expect(parse({ serviceType: '🏺'.repeat(160) })).toBe(true);
    expect(parse({ currency: ' zar ' })).toBe(true);
    expect(parse({ steps: [...Array.from({ length: 50 }, (_, i) => `Step ${i}`), ''] })).toBe(true);
    const service = typed(state, { type: 'Service', serviceType: '🏺'.repeat(160) });
    expect(stored(service)).toMatchObject({ serviceType: '🏺'.repeat(160) });
    expect(refusal(service, { type: 'page.update', pageId: 'pg_services', structuredData: { serviceType: '🏺'.repeat(161) } })).toMatch(/at most 160 characters/);
    expect(stored(typed(typed(state, { type: 'Product' }), { currency: ' zar ' }))).toEqual({ type: 'Product', currency: 'ZAR' });
  });
});

describe('the typed entity in the page’s connected graph', () => {
  const service = (s: ProjectState) => typed(s, { type: 'Service', serviceType: 'Pottery classes', areaServed: 'Millbrook' });

  it('names a service the publisher provides, as the main entity of its page', () => {
    const g = graph(service(seoSite().state));
    expectLinked(g);
    expect(ids(g)).toEqual([`${ROOT}#organization`, `${ROOT}#website`, `${SERVICES}#webpage`, `${SERVICES}#breadcrumb`, `${SERVICES}#service`]);
    expect(node(g, `${SERVICES}#service`)).toEqual({
      '@type': 'Service',
      '@id': `${SERVICES}#service`,
      name: 'Services',
      description: 'Weekly wheel classes, private lessons and commissioned tableware made to order in the studio.',
      mainEntityOfPage: { '@id': `${SERVICES}#webpage` },
      serviceType: 'Pottery classes',
      areaServed: 'Millbrook',
      provider: { '@id': `${ROOT}#organization` }
    });
    // The page itself is still a web page, part of the website.
    expect(node(g, `${SERVICES}#webpage`)['@type']).toBe('WebPage');
  });

  it('names a product with the publisher’s offer of it, its price as text and its availability as Schema.org says it', () => {
    const s = typed(seoSite().state, { type: 'Product', price: '0.00', currency: 'ZAR', availability: 'PreOrder', offerUrl: 'https://shop.example/bowls' });
    const g = graph(s);
    expectLinked(g);
    expect(node(g, `${SERVICES}#product`)).toMatchObject({
      '@type': 'Product',
      name: 'Services',
      mainEntityOfPage: { '@id': `${SERVICES}#webpage` },
      offers: { '@type': 'Offer', price: '0.00', priceCurrency: 'ZAR', availability: 'https://schema.org/PreOrder', url: 'https://shop.example/bowls', seller: { '@id': `${ROOT}#organization` } }
    });
  });

  it('names an event the publisher organizes, at its venue, and a guide with its steps in order', () => {
    const { state } = seoSite();
    const event = graph(typed(state, { type: 'Event', startDate: '2027-05-14T19:30+02:00', endDate: '2027-05-14T22:00+02:00', venue: 'Riverside Studio', address: '1 River Road, Millbrook' }));
    expectLinked(event);
    expect(node(event, `${SERVICES}#event`)).toMatchObject({
      '@type': 'Event',
      startDate: '2027-05-14T19:30+02:00',
      endDate: '2027-05-14T22:00+02:00',
      location: { '@type': 'Place', name: 'Riverside Studio', address: '1 River Road, Millbrook' },
      organizer: { '@id': `${ROOT}#organization` },
      mainEntityOfPage: { '@id': `${SERVICES}#webpage` }
    });
    // An address alone is somewhere too.
    expect(node(graph(typed(state, { type: 'Event', startDate: '2027-05-14', address: '1 River Road' })), `${SERVICES}#event`).location).toEqual({ '@type': 'Place', address: '1 River Road' });
    const guide = graph(typed(state, { type: 'HowTo', steps: ['Wedge the clay', 'Centre it on the wheel', 'Open and pull the walls'] }));
    expectLinked(guide);
    expect(node(guide, `${SERVICES}#howto`)).toMatchObject({
      '@type': 'HowTo',
      publisher: { '@id': `${ROOT}#organization` },
      step: [
        { '@type': 'HowToStep', position: 1, text: 'Wedge the clay' },
        { '@type': 'HowToStep', position: 2, text: 'Centre it on the wheel' },
        { '@type': 'HowToStep', position: 3, text: 'Open and pull the walls' }
      ]
    });
  });

  it('makes an About or Contact page that kind of web page, and keeps the Home page about the publisher', () => {
    const { state, home } = seoSite();
    const about = graph(typed(state, { type: 'AboutPage' }, home), home);
    expectLinked(about);
    expect(node(about, `${ROOT}#webpage`)).toMatchObject({ '@type': ['WebPage', 'AboutPage'], about: { '@id': `${ROOT}#organization` } });
    expect(about['@graph']).toHaveLength(4);
    expect(node(graph(typed(state, { type: 'ContactPage' })), `${SERVICES}#webpage`)['@type']).toEqual(['WebPage', 'ContactPage']);
  });

  it('names the publisher whatever kind it is, and keeps a page’s FAQ beside its typed entity', () => {
    const { state } = seoSite();
    let s = run(state, { type: 'site.update', identity: { kind: 'Person', name: 'Ana Ruiz' } }, { type: 'page.create', pageId: 'pg_guide', title: 'Glazing guide', route: '/guide/', starter: 'faq' });
    s = typed(s, { type: 'HowTo', steps: ['Dip the pot', 'Fire it'] }, 'pg_guide');
    const g = graph(s, 'pg_guide');
    expectLinked(g);
    const webpage = node(g, `${ROOT}guide/#webpage`);
    expect(webpage['@type']).toEqual(['WebPage', 'FAQPage']);
    expect((webpage.mainEntity as unknown[]).length).toBeGreaterThan(0);
    expect(node(g, `${ROOT}guide/#howto`)).toMatchObject({ name: 'Glazing guide', publisher: { '@id': `${ROOT}#person` } });
  });

  it('says nothing of an entity whose facts are incomplete, contradict each other or were saved unusable, and keeps the rest of the graph', () => {
    const { state } = seoSite();
    const core = ids(graph(state));
    for (const patch of [{ type: 'Product', price: '10' }, { type: 'Event', venue: 'Studio' }, { type: 'Event', startDate: '2027-05-14' }, { type: 'Service', areaServed: 'Millbrook' }, { type: 'HowTo' }, { type: 'Event', startDate: '2027-05-14', endDate: '2027-05-13', venue: 'Studio' }] as const) {
      const g = graph(typed(state, patch as never));
      expect(ids(g), JSON.stringify(patch)).toEqual(core);
      expect(node(g, `${SERVICES}#webpage`)['@type']).toBe('WebPage');
    }
    // Saved by hand: an unknown type says nothing; an optional fact that can't be used is left out on its own; a page
    // whose title was cleared by hand names no entity, whatever its browser title says.
    const untitled = copy(typed(state, { type: 'Product', price: '10', currency: 'ZAR' }));
    (untitled.pages.pg_services as PageDoc).title = '  ';
    expect(ids(graph(untitled))).toEqual(core);
    const damaged = copy(state);
    (damaged.pages.pg_services as PageDoc).seo.structuredData = { type: 'Recipe' } as never;
    expect(ids(graph(damaged))).toEqual(core);
    (damaged.pages.pg_services as PageDoc).seo.structuredData = { type: 'Product', price: '10', currency: 'USD', offerUrl: 'not a url', availability: 'Soon' } as never;
    expect(node(graph(damaged), `${SERVICES}#product`).offers).toEqual({ '@type': 'Offer', price: '10', priceCurrency: 'USD', seller: { '@id': `${ROOT}#organization` } });
    (damaged.pages.pg_services as PageDoc).seo.structuredData = { type: 'HowTo', steps: [null, 'Fire it', ''] } as never;
    expect(ids(graph(damaged))).toEqual(core);
    expect(inspectPageStructuredData({ type: 'HowTo', steps: [null] }).issues).toEqual([
      { field: 'steps', message: expect.stringMatching(/The saved steps can’t be used/), blocking: false },
      { field: 'steps', message: 'Add at least one step.', blocking: true }
    ]);
  });
});

describe('hints for incomplete page facts', () => {
  const findings = (s: ProjectState) => runSeoAudit(s).filter((f) => f.code.startsWith('SEO_PAGE_STRUCTURED_DATA'));

  it('names the facts a typed page still needs, and where to add them, until they are there', () => {
    const { state } = seoSite();
    let s = typed(state, { type: 'Product' });
    expect(findings(s)).toEqual([
      {
        pillar: 'entity',
        severity: 'warning',
        code: 'SEO_PAGE_STRUCTURED_DATA_INCOMPLETE',
        message: '“Services” is marked as a Product, but its structured data can’t name it until its facts are complete: Add the price. Add the currency.',
        owner: { kind: 'page', id: 'pg_services' },
        site: 'structuredData',
        explanation: expect.any(String),
        aiFixable: false,
        destination: { kind: 'pageSeo', pageId: 'pg_services', field: 'structuredData' }
      }
    ]);
    s = typed(s, { price: '129', currency: 'ZAR' });
    expect(findings(s)).toEqual([]);
    expect(findings(typed(state, { type: 'Event', startDate: '2027-05-14', endDate: '2027-05-01' }))[0].message).toMatch(/an Event, .*: It ends before it starts: correct the start or the end\. Add where it takes place: a venue or an address\.$/);
    // A complete record with an optional fact that can't be used is pointed out, without saying it is left out whole.
    const damaged = copy(s);
    (damaged.pages.pg_services as PageDoc).seo.structuredData = { type: 'Product', price: '129', currency: 'ZAR', offerUrl: 'nope' } as never;
    expect(findings(damaged).map((f) => [f.code, f.message, f.destination])).toEqual([
      ['SEO_PAGE_STRUCTURED_DATA_UNUSABLE', expect.stringMatching(/^“Services” has structured data that can’t all be used: The saved offer address can’t be used/), { kind: 'pageSeo', pageId: 'pg_services', field: 'structuredData' }]
    ]);
  });

  it('judges only the pages whose structured data the website writes', () => {
    const { state } = seoSite();
    const s = typed(state, { type: 'HowTo' });
    expect(findings(s)).toHaveLength(1);
    expect(findings(run(s, { type: 'page.update', pageId: 'pg_services', noindex: true }))).toEqual([]);
    expect(findings(run(s, { type: 'page.update', pageId: 'pg_services', draft: true }))).toEqual([]);
    // Without a public URL the graph waits for one (its own finding says so), but the facts can still be put right.
    expect(findings(run(s, { type: 'site.update', baseUrl: '' }))).toHaveLength(1);
  });
});

describe('a typed edit held while the AI works', () => {
  const op = (structuredData: Record<string, unknown>): EditOperation => ({ type: 'page.update', pageId: 'pg_services', structuredData } as EditOperation);

  it('reads only the facts it writes, with the type they belong to, and the whole record when it chooses a type', () => {
    const s = typed(seoSite().state, { type: 'Product', price: '10', currency: 'ZAR' });
    expect(readField(s, op({ price: '12' }))).toEqual({ found: true, value: { structuredData: '10', structuredType: 'Product' } });
    expect(readField(s, op({ type: 'Event' }))).toEqual({ found: true, value: { structuredData: { type: 'Product', price: '10', currency: 'ZAR' } } });
    // A price waits on no change to the currency, but the page made an event meanwhile is a change to it.
    const price = readField(s, op({ price: '12' }));
    expect(readField(typed(s, { currency: 'USD' }), op({ price: '12' }))).toEqual(price);
    expect(readField(typed(s, { type: 'Event' }), op({ price: '12' }))).not.toEqual(price);
    // Each fact is its own field; the type is one of its own.
    expect(fieldKey([op({ price: '12' })])).not.toBe(fieldKey([op({ currency: 'USD' })]));
    expect(fieldKey([op({ price: '12' })])).toBe(fieldKey([op({ price: '13' })]));
    expect(fieldKey([op({ type: 'Event' })])).not.toBe(fieldKey([op({ price: '12' })]));
    expect(typedText(op({ price: '12' }))).toBe('12');
    expect(typedText(op({ steps: ['One', 'Two'] }))).toBe('One\nTwo');
    const held = readField(s, op({ price: '12' }));
    expect(shownField(op({ price: '12' }), held?.found ? held.value : undefined)).toBe('10');
  });

  it('notices a change of type alone, and finds a fact gone once the page is no type that states it', () => {
    const product = typed(seoSite().state, { type: 'Product' });
    // No price on either side: only the type tells them apart.
    const read = readField(product, op({ currency: 'ZAR' }));
    const otherProduct = typed(product, { type: 'WebPage' });
    expect(readField(typed(otherProduct, { type: 'Product' }), op({ currency: 'ZAR' }))).toEqual(read);
    expect(readField(typed(product, { type: 'Service' }), op({ currency: 'ZAR' }))).toEqual({ found: false, what: 'page type' });
    expect(readField(otherProduct, op({ currency: 'ZAR' }))).toEqual({ found: false, what: 'page type' });
    // Choosing a type never finds the type gone.
    expect(readField(otherProduct, op({ type: 'Event' }))).toEqual({ found: true, value: { structuredData: null } });
  });
});

describe('the AI and typed page facts', () => {
  it('lets a run limited to the page change them, and offers the model no write schema for them', () => {
    const s = typed(seoSite().state, { type: 'Product' });
    const authority = { kind: 'page' as const, pageId: 'pg_services', label: 'the Services page' };
    expect(checkAuthority(s, [{ type: 'page.update', pageId: 'pg_services', structuredData: { price: '10' } }], authority)).toBeNull();
    for (const operations of [undefined, PAGE_OPERATIONS, FOCUSED_PAGE_OPERATIONS]) {
      const apply = toolDefinitions({ codeEnabled: false, operations }).find((t) => t.name === 'apply_operations')!;
      expect(JSON.stringify(apply.parameters)).toContain('"page.update"');
      expect(JSON.stringify(apply.parameters)).not.toContain('structuredData');
    }
  });
});

describe('typed page facts in a project session and the exported website', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('saves them to the page’s file, undoes and redoes a change of type, and writes the entity into the page each time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-structured-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, typed(seoSite().state, { type: 'Product', price: '129', currency: 'ZAR' }));
    const saved = () => (JSON.parse(readFileSync(join(dir, 'siteorigin/pages/pg_services.json'), 'utf8')) as PageDoc).seo.structuredData;
    const page = () => readFileSync(join(dir, 'src/routes/services/+page.svelte'), 'utf8');
    expect(saved()).toEqual({ type: 'Product', price: '129', currency: 'ZAR' });
    expect(page()).toContain('services/#product');
    const change = await session.apply({ operations: [{ type: 'page.update', pageId: 'pg_services', structuredData: { type: 'Event', startDate: '2027-05-14', venue: 'Riverside Studio' } }] }, { label: 'Mark page as an Event', source: 'user' });
    expect(change.ok).toBe(true);
    expect(saved()).toEqual({ type: 'Event', startDate: '2027-05-14', venue: 'Riverside Studio' });
    expect(page()).toContain('services/#event');
    expect(page()).not.toContain('#product');
    expect((await session.undo()).ok).toBe(true);
    expect(saved()).toEqual({ type: 'Product', price: '129', currency: 'ZAR' });
    expect(page()).toContain('services/#product');
    expect(page()).not.toContain('#event');
    expect((await session.redo()).ok).toBe(true);
    expect(saved()).toEqual({ type: 'Event', startDate: '2027-05-14', venue: 'Riverside Studio' });
    expect(page()).toContain('services/#event');
    expect(page()).not.toContain('#product');
    await session.close();
  });

  it('writes each typed page’s entity into its page file, linked to its page and the publisher, and nothing for an incomplete one', () => {
    let s = seoSite().state;
    const pages: Array<[string, string, Record<string, unknown>]> = [
      ['pg_about', 'About', { type: 'AboutPage' }],
      ['pg_contact', 'Contact', { type: 'ContactPage' }],
      ['pg_kiln', 'Kiln hire', { type: 'Service', serviceType: 'Kiln hire' }],
      ['pg_bowl', 'Rice bowl', { type: 'Product', price: '240', currency: 'ZAR', availability: 'InStock' }],
      ['pg_open', 'Open studio', { type: 'Event', startDate: '2027-06-01T10:00+02:00', venue: 'Riverside Studio' }],
      ['pg_glaze', 'Glazing at home', { type: 'HowTo', steps: ['Mix the glaze', 'Dip the pot'] }],
      ['pg_mug', 'Mug', { type: 'Product', price: '120' }]
    ];
    for (const [id, title, structuredData] of pages) s = run(s, { type: 'page.create', pageId: id, title, route: `/${id.slice(3)}/` }, { type: 'page.update', pageId: id, structuredData } as EditOperation);
    const files = generateProject(s);
    const graphOf = (id: string): SeoGraph => {
      const file = [...files].find(([path, content]) => path.endsWith('+page.svelte') && content.includes(`siteorigin/pages/${id}.json`))![1];
      const scripts = [...file.matchAll(/\{@html ("(?:[^"\\]|\\.)*")\}/g)].map((m) => JSON.parse(m[1]) as string).filter((html) => html.startsWith('<script type="application/ld+json">'));
      expect(scripts, id).toHaveLength(1);
      return JSON.parse(scripts[0].replace(/^<script type="application\/ld\+json">|<\/script>$/g, '')) as SeoGraph;
    };
    const expected: Record<string, [string, string] | [string[]]> = {
      pg_about: [['WebPage', 'AboutPage']],
      pg_contact: [['WebPage', 'ContactPage']],
      pg_kiln: ['service', 'provider'],
      pg_bowl: ['product', 'offers'],
      pg_open: ['event', 'organizer'],
      pg_glaze: ['howto', 'publisher']
    };
    for (const [id] of pages) {
      const g = graphOf(id);
      expectLinked(g);
      const url = `${ROOT}${id.slice(3)}/`;
      const want = expected[id];
      if (!want) {
        // Incomplete: the page says only what a web page does.
        expect(g['@graph'], id).toHaveLength(4);
        continue;
      }
      if (want.length === 1) {
        expect(node(g, `${url}#webpage`)['@type'], id).toEqual(want[0]);
        continue;
      }
      const [fragment, role] = want;
      const entity = node(g, `${url}#${fragment}`);
      expect(entity.mainEntityOfPage, id).toEqual({ '@id': `${url}#webpage` });
      expect(refs(entity[role]), id).toEqual([`${ROOT}#organization`]);
    }
  });
});
