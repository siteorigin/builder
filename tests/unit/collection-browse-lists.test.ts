/**
 * Visitor browsing beyond the ready-made index (#1730): a collection index with a design of its own, whose loops over
 * the page's entries list the entries that match, and collection listings (a connected list, a query's loop) that a
 * switch beside their query lets visitors browse, over exactly the entries the listing shows. What the switch keeps,
 * validation of one a hand edit damages, what each page writes for its controls, and what the assistant can set.
 */
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { RUNTIME_DIR, generateProject, pageFile, propLocals, publishedState } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { BROWSE_COMPONENT_FILE, BROWSE_HELPER_FILE, archiveLoopIds, browseIndexFile, buildLayoutBrowseIndex, listingBrowse, usesBrowse } from '@generator/collection-browse';
import { queriedEntries } from '@generator/collection-query';
import { archiveFile } from '@generator/archive';
import { runConnectList } from '@agent/collection-lists';
import type { ToolHost } from '@agent/tools';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const home = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');
const warnings = (source: string, filename: string) => compile(source, { filename, generate: 'client', runes: true }).warnings.map((w) => `${w.code}: ${w.message}`);

function refusal(s: ProjectState, op: EditOperation): string {
  try {
    applyOperations(s, [op]);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('Expected the change to be refused.');
}

/** The featured three, by title. */
const BY_TITLE = { collectionId: 'homes', sort: [{ field: 'title' }], limit: 3 };
/** The dearest but one, then the next two. */
const DEAREST = { collectionId: 'homes', sort: [{ field: 'field.price', direction: 'desc' as const }], offset: 1, limit: 3 };

/**
 * Six published homes and a draft, two to a page of the index, filed by region, browsing by search, region, garden,
 * price and title; on Home a Team grid of the first three by title and a loop over the dearest but one and the next two.
 */
function site(browse: Record<string, unknown> | null = { search: true, filters: ['terms.region', 'field.garden'], sort: ['field.price', 'title'] }): { s: ProjectState; grid: string; loop: string } {
  let s = run(createStarterState('business', 'Coast Realty', false), {
    type: 'collection.create',
    collectionId: 'homes',
    name: 'Homes',
    kind: 'structured',
    route: '/homes/',
    pageSize: 2,
    fields: { price: { type: 'number', label: 'Price' }, garden: { type: 'boolean', label: 'Garden' }, agent: { type: 'string', label: 'Agent' } },
    taxonomies: { region: { label: 'Region', terms: { north: { label: 'North Coast' }, south: { label: 'South Bay' } } } },
    ...(browse ? { browse } : {})
  } as EditOperation);
  const homes: Array<[string, string, number, boolean, string]> = [
    ['en_cliff', 'Cliff Cottage', 450000, true, 'north'],
    ['en_harbour', 'Harbour Loft', 320000, false, 'south'],
    ['en_dune', 'Dune House', 780000, true, 'north'],
    ['en_orchard', 'Orchard Farm', 510000, true, 'south'],
    ['en_quay', 'Quay Flat', 210000, false, 'south'],
    ['en_reef', 'Reef View', 990000, true, 'north']
  ];
  s = run(
    s,
    ...homes.map(([entryId, title, price, garden, region], i) => ({ type: 'entry.create', collectionId: 'homes', entryId, title, publishedAt: `2026-0${i + 1}-01`, draft: false, values: { price, garden, agent: `${title} agent` }, terms: { region: [region] } }) as EditOperation),
    { type: 'entry.create', collectionId: 'homes', entryId: 'en_draft', title: 'Secret Shack', publishedAt: '2026-08-01', draft: true, values: { price: 1 }, terms: { region: ['north'] } } as EditOperation
  );
  const placed = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, componentId: 'team.grid' }]);
  s = placed.state;
  const grid = placed.results[0].nodeId as string;
  s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: grid, prop: 'people', source: { query: BY_TITLE, fields: { name: 'title', role: 'field.agent' }, browse: true } });
  const box = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, primitive: 'container' }]);
  s = box.state;
  const looped = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: box.results[0].nodeId as string, primitive: 'repeat', query: DEAREST }]);
  s = looped.state;
  const loop = looped.results[0].nodeId as string;
  const heading = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: loop, primitive: 'heading', text: 'Title' }]);
  s = run(heading.state, { type: 'node.setBinding', owner: home(s), nodeId: heading.results[0].nodeId as string, field: 'text', binding: { $item: 'title' } }, { type: 'node.setRepeatSource', owner: home(s), nodeId: loop, source: { $query: DEAREST, browse: true } });
  return { s, grid, loop };
}

const homePage = (s: ProjectState) => generateProject(publishedState(s)).get(pageFile(s.pages[s.site.homePageId]))!;
/** What the controls of the page's `n`th browsed listing read, as the page declares it. */
const declared = (page: string, n: number) => JSON.parse(page.match(new RegExp(`^\\tconst so_browse_${n} = (.*);$`, 'm'))![1]) as Array<{ id: string; i: number; text?: string; values: Record<string, unknown> }>;

describe("a listing's visitor browsing", () => {
  it('is kept beside the query, never in it, and changes nothing the query finds', () => {
    const { s, grid, loop } = site();
    expect(errors(s)).toEqual([]);
    const tree = s.pages[s.site.homePageId];
    expect((tree.nodes[grid] as InstanceNode).listSources!.people).toEqual({ query: BY_TITLE, fields: { name: 'title', role: 'field.agent' }, browse: true });
    expect((tree.nodes[loop] as RepeatNode).list).toEqual({ $query: DEAREST, browse: true });
    // The query, the same with browsing on or off, finds the same entries.
    expect(queriedEntries(s, BY_TITLE, {}).map((e) => e.id)).toEqual(['en_cliff', 'en_dune', 'en_harbour']);
    // A source sent without it turns it off, leaving no trace.
    const off = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: grid, prop: 'people', source: { query: BY_TITLE, fields: { name: 'title', role: 'field.agent' } } }, { type: 'node.setRepeatSource', owner: home(s), nodeId: loop, source: { $query: DEAREST } });
    expect((off.pages[off.site.homePageId].nodes[grid] as InstanceNode).listSources!.people).not.toHaveProperty('browse');
    expect((off.pages[off.site.homePageId].nodes[loop] as RepeatNode).list).toEqual({ $query: DEAREST });
    expect(homePage(off)).not.toContain('SoBrowse');
  });

  it('is stored only while on, and reported when a hand edit damages it', () => {
    const { s, grid, loop } = site();
    const off = run(s, { type: 'node.setRepeatSource', owner: home(s), nodeId: loop, source: { $query: DEAREST, browse: false } } as unknown as EditOperation);
    expect((off.pages[off.site.homePageId].nodes[loop] as RepeatNode).list).toEqual({ $query: DEAREST });
    expect(refusal(s, { type: 'node.setRepeatSource', owner: home(s), nodeId: loop, source: { $query: { collectionId: 'nowhere' }, browse: true } })).toMatch(/nowhere|collection/i);
    const damaged = structuredClone(s);
    const nodes = damaged.pages[damaged.site.homePageId].nodes;
    (nodes[grid] as InstanceNode).listSources!.people = { ...(nodes[grid] as InstanceNode).listSources!.people, browse: 'yes' as unknown as true };
    (nodes[loop] as RepeatNode).list = { $query: DEAREST, browse: false as unknown as true };
    const found = errors(damaged).map((d) => d.message);
    expect(found.filter((m) => /visitor browsing that is not on/.test(m))).toHaveLength(2);
    expect(found.some((m) => /form that cannot be read/.test(m))).toBe(false);
    // A loop over the archive page's entries browses with the index, never by a switch of its own.
    const designed = run(s, { type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);
    const layout = designed.collections.homes.settings.archiveTemplate!;
    const archiveLoop = Object.values(layout.nodes).find((n) => n.kind === 'repeat') as RepeatNode;
    (archiveLoop.list as Record<string, unknown>).browse = true;
    expect(errors(designed).map((d) => d.message).some((m) => /visitor browsing of its own, but it repeats the index page's entries/.test(m))).toBe(true);
  });

  it('places its controls where a form may go: outside a grid, a list and a linked card', () => {
    const { s: base, loop } = site();
    const s = structuredClone(base);
    const nodes = s.pages[s.site.homePageId].nodes;
    // The loop's holder becomes a list, inside a linked card, inside a grid of two columns.
    const holder = Object.values(nodes).find((n) => n.kind === 'element' && n.children.includes(loop))!;
    const card = { id: 'n_card', kind: 'element', tag: 'article', link: { type: 'url', target: 'https://example.com/' }, children: [holder.id], styles: { base: {} } };
    const grid = { id: 'n_grid', kind: 'element', tag: 'div', children: ['n_card'], styles: { base: { layout: 'grid' } } };
    const outer = { id: 'n_outer', kind: 'element', tag: 'section', children: ['n_grid'], styles: { base: {} } };
    Object.assign(nodes, { n_card: card, n_grid: grid, n_outer: outer } as unknown as typeof nodes);
    (holder as { tag: string }).tag = 'ul';
    const page = s.pages[s.site.homePageId];
    page.rootIds = page.rootIds.map((id) => (id === holder.id ? 'n_outer' : id));
    const written = homePage(s);
    // The grid is what the controls go above, inside the section holding it: never inside the grid, the card or the list.
    expect(written).toMatch(/<section class=\{\["so-n-n_outer"\]\}>\n\t\{#snippet so_listing_1\(so_matches_1\)\}\n\t\t<div class=\{\["so-n-n_grid"\]\}>/);
    expect(written).toMatch(/\t<SoBrowse [^\n]*content=\{so_listing_1\} \/>\n<\/section>/);
    expect(warnings(written, 'src/routes/+page.svelte')).toEqual([]);
  });

  it('declares the footer\'s listings beside the header\'s, numbered apart', () => {
    const { s: base } = site();
    let s = base;
    for (const part of ['header', 'footer'] as const) {
      const owner: OwnerRef = { kind: 'shell', id: part };
      const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, primitive: 'container' }]);
      const looped = applyOperations(placed.state, [{ type: 'node.insert', owner, parentId: placed.results[0].nodeId as string, primitive: 'repeat', query: part === 'header' ? BY_TITLE : DEAREST }]);
      const loop = looped.results[0].nodeId as string;
      const heading = applyOperations(looped.state, [{ type: 'node.insert', owner, parentId: loop, primitive: 'heading', text: 'Title' }]);
      s = run(heading.state, { type: 'node.setBinding', owner, nodeId: heading.results[0].nodeId as string, field: 'text', binding: { $item: 'title' } }, { type: 'node.setRepeatSource', owner, nodeId: loop, source: { $query: part === 'header' ? BY_TITLE : DEAREST, browse: true } });
    }
    const layout = generateProject(publishedState(s)).get('src/routes/+layout.svelte')!;
    expect(declared(layout, 0).map((r) => r.id)).toEqual(['en_cliff', 'en_dune', 'en_harbour']);
    expect(declared(layout, 1).map((r) => r.id)).toEqual(['en_dune', 'en_orchard', 'en_cliff']);
    expect(layout).toContain('const so_rows_1 = ');
    expect(warnings(layout, 'src/routes/+layout.svelte')).toEqual([]);
  });

  it("never lets a design's own property take a name the browse code declares", () => {
    const def = { kind: 'managed', properties: { so_rows_0: { type: 'string' }, so_browse_1: { type: 'string' }, so_listing_0: { type: 'string' }, so_bar: { type: 'string' }, SoBrowse: { type: 'string' } } } as unknown as ComponentDefinition;
    expect([...propLocals(def).values()].sort()).toEqual(['prop_SoBrowse', 'prop_so_bar', 'prop_so_browse_1', 'prop_so_listing_0', 'prop_so_rows_0']);
  });

  it('holds the browse code while code of the author\'s places the browse component', () => {
    const { s } = site(null);
    expect(usesBrowse(s)).toBe(false);
    const code = { id: 'cmp_list', kind: 'code', name: 'List', properties: {}, source: `<script>import SoBrowse from '../runtime/${BROWSE_COMPONENT_FILE}';</script>` };
    expect(usesBrowse({ ...s, components: { ...s.components, cmp_list: code } } as unknown as ProjectState)).toBe(true);
  });

  it('browses exactly the entries each listing shows, with the controls those entries give', () => {
    const { s } = site();
    const page = homePage(s);
    expect(page.match(/<SoBrowse /g)).toHaveLength(2);
    // The featured three by title, and the dearest but one and the next two: each listing's own, in its own order.
    expect(declared(page, 0).map((r) => [r.id, r.i])).toEqual([['en_cliff', 0], ['en_dune', 1], ['en_harbour', 2]]);
    expect(declared(page, 1).map((r) => [r.id, r.i])).toEqual([['en_dune', 0], ['en_orchard', 1], ['en_cliff', 2]]);
    expect(declared(page, 1)[0]).toEqual({ id: 'en_dune', text: 'Dune House\nNorth Coast', values: { 'terms.region': ['north'], 'field.garden': true, 'field.price': 780000, title: 'Dune House' }, i: 0 });
    // The rest of the collection never reaches the page, nor a draft, nor the collection's index of entries.
    for (const never of ['Reef View', 'Quay Flat', 'Secret Shack', browseIndexFile('homes')]) expect(page).not.toContain(never);
    // Each shows every entry it lists: no page of matches at a time.
    expect(page).toContain('size={3}');
    // A choice offers only the options its own entries have.
    const homes = s.collections.homes;
    const north = listingBrowse(s, homes, [homes.entries.en_cliff, homes.entries.en_dune])!;
    expect(north.controls.filters.find((f) => f.key === 'terms.region')).toMatchObject({ options: [{ value: 'north', label: 'North Coast' }] });
    expect(warnings(page, 'src/routes/+page.svelte')).toEqual([]);
    // The editor's variant too, whose elements stay selectable inside the controls' content.
    const dev = generateProject(s, { instrument: true }).get(pageFile(s.pages[s.site.homePageId]))!;
    expect(dev.match(/<SoBrowse /g)).toHaveLength(2);
    expect(warnings(dev, 'src/routes/+page.svelte')).toEqual([]);
    // The site holds the browse code beside it.
    const files = generateProject(publishedState(s));
    expect(files.has(`${RUNTIME_DIR}/${BROWSE_HELPER_FILE}`)).toBe(true);
    expect(files.has(`${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`)).toBe(true);
  });

  it('shows no controls when its collection offers none, or it lists nothing', () => {
    const plain = site(null).s;
    expect(homePage(plain)).not.toContain('SoBrowse');
    expect(generateProject(publishedState(plain)).has(`${RUNTIME_DIR}/${BROWSE_HELPER_FILE}`)).toBe(false);
    const { s, grid } = site();
    const none = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: grid, prop: 'people', source: { query: { collectionId: 'homes', where: [{ field: 'title', op: 'eq', value: 'Nowhere' }] }, fields: { name: 'title' }, browse: true } });
    expect(homePage(none).match(/<SoBrowse /g)).toHaveLength(1);
  });

  it('is set by the assistant beside the query, and kept while the query changes', async () => {
    const { s: start, grid, loop } = site();
    let s = run(start, { type: 'instance.setListSource', owner: home(start), nodeId: grid, prop: 'people', source: { query: BY_TITLE, fields: { name: 'title' } } });
    const host = { state: () => s, revision: () => 1, apply: async (ops: EditOperation[]) => ((s = run(s, ...ops)), { ok: true, revision: 2, results: [] }) } as unknown as ToolHost;
    const call = (args: Record<string, unknown>) => runConnectList({ owner: home(s), ...args } as never, host, 'call');
    await call({ nodeId: grid, prop: 'people', query: BY_TITLE, fields: [{ itemField: 'name', entryField: 'title' }], browse: true });
    expect((s.pages[s.site.homePageId].nodes[grid] as InstanceNode).listSources!.people.browse).toBe(true);
    await call({ nodeId: grid, prop: 'people', query: { ...BY_TITLE, limit: 2 }, fields: [{ itemField: 'name', entryField: 'title' }] });
    expect((s.pages[s.site.homePageId].nodes[grid] as InstanceNode).listSources!.people).toMatchObject({ query: { limit: 2 }, browse: true });
    await call({ nodeId: loop, query: BY_TITLE });
    expect((s.pages[s.site.homePageId].nodes[loop] as RepeatNode).list).toEqual({ $query: BY_TITLE, browse: true });
    await call({ nodeId: loop, query: BY_TITLE, browse: false });
    expect((s.pages[s.site.homePageId].nodes[loop] as RepeatNode).list).toEqual({ $query: BY_TITLE });
    const refused = await call({ nodeId: grid, prop: 'people', disconnect: true, browse: true });
    expect(refused.ok).toBe(false);
  });
});

describe('through the generation cache', () => {
  it('writes what the controls read afresh when a value they read changes, and the controls a setting change gives, as a full run does', () => {
    let s = run(site().s, { type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);
    const cache = new GenerationCache();
    for (const opts of [{}, { instrument: true }]) expect([...generateProject(s, opts, cache)]).toEqual([...generateProject(s, opts)]);
    // A garden the listings never show, a region the controls offer, and a sort fewer.
    s = run(
      s,
      { type: 'entry.update', collectionId: 'homes', entryId: 'en_dune', values: { garden: false } } as EditOperation,
      { type: 'collection.update', collectionId: 'homes', browse: { search: true, filters: ['terms.region', 'field.garden'], sort: ['title'] } } as EditOperation
    );
    for (const opts of [{}, { instrument: true }]) {
      const files = generateProject(s, opts, cache);
      expect([...files]).toEqual([...generateProject(s, opts)]);
      expect(declared(files.get(pageFile(s.pages[s.site.homePageId]))!, 1)[0].values['field.garden']).toBe(false);
    }
  });
});

describe('an index with a design of its own', () => {
  const designed = () => run(site().s, { type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);

  it("lists the entries that match in its loop over the page's entries, from every published entry", () => {
    const s = designed();
    expect(errors(s)).toEqual([]);
    const files = generateProject(publishedState(s));
    const page = files.get(archiveFile('/homes/'))!;
    expect(page).toContain('<SoBrowse ');
    expect(page).toContain('{#snippet content(so_matches, so_more)}');
    expect(page).toContain('so_matches.map((so_e) => so_e.loops[0])');
    // The page links show until a visitor uses a control; the button that shows more takes their place meanwhile.
    expect(page).toMatch(/\{#if so_more\}[\s\S]*\{@render so_more\(\)\}[\s\S]*\{:else if !so_matches\}[\s\S]*so-archive__pages/);
    expect(warnings(page, 'src/routes/homes/+page.svelte')).toEqual([]);
    expect(warnings(generateProject(s, { instrument: true }).get(archiveFile('/homes/'))!, 'src/routes/homes/+page.svelte')).toEqual([]);
    // Each published entry, in the index's order, with the row the layout's loop shows for it, and never a draft.
    const rows = buildLayoutBrowseIndex(s, 'homes');
    expect(rows.map((r) => r.id)).toEqual(['en_reef', 'en_quay', 'en_orchard', 'en_dune', 'en_harbour', 'en_cliff']);
    expect(rows[3].loops[0]).toMatchObject({ id: 'en_dune', f0: { href: '/homes/dune-house/' }, f1: 'Dune House' });
    expect(rows[3]).not.toHaveProperty('route');
    const index = files.get(`${RUNTIME_DIR}/${browseIndexFile('homes')}`)!;
    expect(index).toContain('"Cliff Cottage"');
    expect(index).not.toContain('Secret Shack');
    // Later pages list their own share, as they did.
    expect(files.get(archiveFile('/homes/page/2/'))).not.toContain('SoBrowse');
    // A loop a hand edit left out of the page's sections lists nothing, so it gives the index no controls.
    const detached = structuredClone(s);
    const layout = detached.collections.homes.settings.archiveTemplate!;
    const loop = archiveLoopIds(layout)[0];
    for (const n of Object.values(layout.nodes)) if (n.kind === 'element') n.children = n.children.filter((c) => c !== loop);
    expect(archiveLoopIds(layout)).toEqual([]);
    expect(generateProject(publishedState(detached)).get(archiveFile('/homes/'))).not.toContain('SoBrowse');
  });

  it('keeps a listing on the page browsing on its own', () => {
    const { s: base, grid } = site();
    let s = run(base, { type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);
    const owner: OwnerRef = { kind: 'archive', id: 'homes' };
    const layout = s.collections.homes.settings.archiveTemplate!;
    const team = (base.pages[base.site.homePageId].nodes[grid] as InstanceNode).definitionId;
    const placed = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: layout.rootIds.length, definitionId: team }]);
    s = run(placed.state, { type: 'instance.setListSource', owner, nodeId: placed.results[0].nodeId as string, prop: 'people', source: { query: BY_TITLE, fields: { name: 'title' }, browse: true } });
    const page = generateProject(publishedState(s)).get(archiveFile('/homes/'))!;
    expect(page.match(/<SoBrowse /g)).toHaveLength(2);
    expect(page).toContain('so_matches_0 ? so_matches_0.map((so_m) => so_rows_0[so_m.i]) : so_rows_0');
    expect(page).toContain('content={so_listing_0}');
    expect(warnings(page, 'src/routes/homes/+page.svelte')).toEqual([]);
  });
});
