/**
 * Visitor browsing of a collection's index (#1402): the setting collection.create and collection.update keep (checked
 * against the collection's fields, dropped with a field that goes), validation of one a hand edit leaves, the browse
 * index the website loads (every published entry, its card and the values the controls read, nothing it does not
 * show), the matching code as the site runs it, and the index page that holds the controls.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { afterAll, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { RUNTIME_DIR, generateProject, publishedState } from '@generator/index';
import { BROWSE_COMPONENT_FILE, BROWSE_HELPER_FILE, BROWSE_SVELTE, browseControls, browseIndexFile, browseJs, buildBrowseIndex } from '@generator/collection-browse';
import { archiveFile } from '@generator/archive';
import { collectionsSummary } from '@agent/context';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

/** Homes for sale: six published, one a draft, two to a page of the index, filed by region. */
function homes(browse?: Record<string, unknown>): ProjectState {
  const s = run(createStarterState('business', 'Coast Realty', false), {
    type: 'collection.create',
    collectionId: 'homes',
    name: 'Homes',
    kind: 'structured',
    route: '/homes/',
    pageSize: 2,
    fields: {
      price: { type: 'number', label: 'Price' },
      bedrooms: { type: 'number', label: 'Bedrooms' },
      status: { type: 'enum', label: 'Status', options: [{ value: 'sale', label: 'For sale' }, { value: 'sold', label: 'Sold' }, { value: 'let', label: 'To let' }], default: 'sale' },
      garden: { type: 'boolean', label: 'Garden' },
      agent: { type: 'string', label: 'Agent' },
      listed: { type: 'date', label: 'Listed' },
      motive: { type: 'enum', label: 'Seller motive', options: [{ value: 'distressed', label: 'Distressed sale' }, { value: 'normal', label: 'Normal' }], default: 'normal' }
    },
    taxonomies: { region: { label: 'Region', terms: { north: { label: 'North Coast' }, south: { label: 'South Bay' }, east: { label: 'East Hills' } } } }
  } as EditOperation);
  const entry = (id: string, title: string, day: string, values: Record<string, unknown>, region: string[], extra: Record<string, unknown> = {}): EditOperation =>
    ({ type: 'entry.create', collectionId: 'homes', entryId: id, title, publishedAt: day, draft: false, values, terms: { region }, ...extra }) as EditOperation;
  const out = run(
    s,
    entry('en_cliff', 'Cliff Cottage', '2026-01-01', { price: 450000, bedrooms: 2, status: 'sale', garden: true, agent: 'Zoë', listed: '2026-01-05', motive: 'distressed' }, ['north'], { excerpt: 'Sea views from every room.' }),
    entry('en_harbour', 'Harbour Loft', '2026-02-01', { price: 320000, bedrooms: 1, status: 'sold', agent: 'Ana' }, ['south']),
    entry('en_dune', 'Dune House', '2026-03-01', { price: 780000, bedrooms: 4, garden: true, listed: '2026-03-02' }, ['north', 'south']),
    entry('en_orchard', 'Orchard Farm', '2026-04-01', { bedrooms: 5, status: 'let', garden: false }, []),
    entry('en_quay', 'Quay Flat', '2026-05-01', { price: 0, bedrooms: 0, agent: 'ben' }, ['south']),
    entry('en_cafe', 'Café Corner', '2026-06-01', { price: 610000, bedrooms: 3, status: 'sale' }, ['north']),
    { type: 'entry.create', collectionId: 'homes', entryId: 'en_draft', title: 'Secret Draft', publishedAt: '2026-07-01', draft: true, values: { price: 1 }, terms: { region: ['north'] } } as EditOperation
  );
  return browse ? run(out, { type: 'collection.update', collectionId: 'homes', browse } as EditOperation) : out;
}

const FULL = { search: true, filters: ['terms.region', 'field.status', 'field.garden', 'field.price', 'field.bedrooms'], sort: ['field.price', 'publishedAt', 'title', 'field.agent', 'field.listed'] };

function refusal(s: ProjectState, op: EditOperation): string {
  try {
    run(s, op);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('Expected the change to be refused.');
}

describe('the browse setting', () => {
  it('keeps what the collection offers, each key once, and removes it with null or with nothing in it', () => {
    const s = homes({ search: true, filters: ['field.price', 'terms.region', 'field.price'], sort: [] });
    expect(s.collections.homes.settings.browse).toEqual({ search: true, filters: ['field.price', 'terms.region'] });
    expect(run(s, { type: 'collection.update', collectionId: 'homes', browse: null } as EditOperation).collections.homes.settings.browse).toBeUndefined();
    expect(run(s, { type: 'collection.update', collectionId: 'homes', browse: { search: false } } as EditOperation).collections.homes.settings.browse).toBeUndefined();
    // A setting given replaces the whole of the one it has.
    expect(run(s, { type: 'collection.update', collectionId: 'homes', browse: { sort: ['title', 'title'] } } as EditOperation).collections.homes.settings.browse).toEqual({ sort: ['title'] });
    // A change of something else keeps it.
    expect(run(s, { type: 'collection.update', collectionId: 'homes', pageSize: 5 } as EditOperation).collections.homes.settings.browse).toEqual({ search: true, filters: ['field.price', 'terms.region'] });
  });

  it('is set when the collection is made, against the fields it is made with', () => {
    const s = run(createStarterState('business', 'Coast Realty', false), {
      type: 'collection.create',
      collectionId: 'team',
      kind: 'structured',
      fields: { senior: { type: 'boolean', label: 'Senior' } },
      browse: { search: true, filters: ['field.senior'], sort: ['title'] }
    } as EditOperation);
    expect(s.collections.team.settings.browse).toEqual({ search: true, filters: ['field.senior'], sort: ['title'] });
    // A field it is not made with is refused, and so is the collection.
    expect(() => run(createStarterState('business', 'Coast Realty', false), { type: 'collection.create', collectionId: 'team', fields: { senior: { type: 'boolean', label: 'Senior' } }, browse: { filters: ['field.senior', 'field.age'] } } as EditOperation)).toThrow(/"field.age" is none of those/);
  });

  it('refuses a filter or sort its fields give no control for, naming the field', () => {
    const s = homes();
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', browse: { filters: ['field.agent'] } } as EditOperation)).toMatch(/filter Homes .*“Agent” is none of those/);
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', browse: { filters: ['field.nope'] } } as EditOperation)).toMatch(/"field.nope" is none of those/);
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', browse: { sort: ['terms.region'] } } as EditOperation)).toMatch(/sort Homes .*“Region” is none of those/);
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', browse: { sort: ['field.garden'] } } as EditOperation)).toMatch(/“Garden” is none of those/);
    // Every key is checked, not only the first.
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', browse: { filters: ['field.price', 'field.agent'] } } as EditOperation)).toMatch(/“Agent” is none of those/);
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', browse: { sort: ['title', 'field.nope'] } } as EditOperation)).toMatch(/sort Homes .*"field.nope" is none of those/);
    // Checked against the fields the same change gives it: one it adds can be chosen, one it removes cannot.
    const fields = structuredClone(s.collections.homes.settings.fields);
    const added = run(s, { type: 'collection.update', collectionId: 'homes', fields: { ...fields, beds: { type: 'number', label: 'Beds' } }, browse: { filters: ['field.beds'] } } as unknown as EditOperation);
    expect(added.collections.homes.settings.browse).toEqual({ filters: ['field.beds'] });
    const { garden: _garden, ...rest } = fields;
    expect(refusal(s, { type: 'collection.update', collectionId: 'homes', fields: rest, browse: { filters: ['field.garden'] } } as unknown as EditOperation)).toMatch(/"field.garden" is none of those/);
  });

  it('drops a filter or sort whose field goes or stops giving that control, and the setting with the last of them', () => {
    let s = homes();
    const fields = structuredClone(s.collections.homes.settings.fields);
    s = run(s, { type: 'collection.update', collectionId: 'homes', fields: { ...fields, size: { type: 'number', label: 'Size' } } } as unknown as EditOperation);
    s = run(s, { type: 'collection.update', collectionId: 'homes', browse: { filters: ['field.size', 'terms.region'], sort: ['field.size', 'title'] } } as EditOperation);
    // Size becomes a choice: still a filter (now its options), no longer a sort.
    const chosen = run(s, { type: 'collection.update', collectionId: 'homes', fields: { ...fields, size: { type: 'enum', label: 'Size', options: [{ value: 'big', label: 'Big' }], default: 'big' } } } as unknown as EditOperation);
    expect(chosen.collections.homes.settings.browse).toEqual({ filters: ['field.size', 'terms.region'], sort: ['title'] });
    // The grouping goes: its filter goes with it.
    const ungrouped = run(s, { type: 'collection.update', collectionId: 'homes', taxonomies: {} } as EditOperation);
    expect(ungrouped.collections.homes.settings.browse).toEqual({ filters: ['field.size'], sort: ['field.size', 'title'] });
    // A browse setting given with the change is checked against the fields it makes.
    const swapped = run(ungrouped, { type: 'collection.update', collectionId: 'homes', fields, browse: { filters: ['field.status'] } } as unknown as EditOperation);
    expect(swapped.collections.homes.settings.browse).toEqual({ filters: ['field.status'] });
    const none = run(run(ungrouped, { type: 'collection.update', collectionId: 'homes', browse: { filters: ['field.size'] } } as EditOperation), { type: 'collection.update', collectionId: 'homes', fields } as unknown as EditOperation);
    expect(none.collections.homes.settings.browse).toBeUndefined();
  });

  it("is shown to the assistant, which replaces it whole, with whether the index's own design keeps it off", () => {
    const s = homes({ search: true, filters: ['terms.region'] });
    expect(collectionsSummary(s).find((c) => c.id === 'homes')).toMatchObject({ browse: { search: true, filters: ['terms.region'] } });
    expect(collectionsSummary(s).find((c) => c.id === 'homes')).not.toHaveProperty('browseOff');
    const designed = run(s, { type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);
    expect(collectionsSummary(designed).find((c) => c.id === 'homes')).toMatchObject({ browseOff: 'the index has its own design' });
    expect(collectionsSummary(homes()).find((c) => c.id === 'homes')).not.toHaveProperty('browse');
  });

  it('is reported when a hand edit names a field it cannot use, and the index leaves that out', () => {
    const s = homes(FULL);
    s.collections.homes.settings.browse = { filters: ['field.agent', 'terms.region'], sort: ['title'] };
    const problems = validateState(s).filter((d) => d.code === 'COLLECTION_INVALID');
    expect(problems.map((d) => d.message)).toEqual(['The Homes collection: visitors cannot filter by "field.agent", so its index leaves that out.']);
    expect(browseControls(s, 'homes').filters.map((f) => f.key)).toEqual(['terms.region']);
    s.collections.homes.settings.browse = 'yes' as never;
    expect(validateState(s).filter((d) => d.code === 'COLLECTION_INVALID').map((d) => d.message)).toEqual(['The Homes collection: its visitor browsing is damaged.']);
    expect(generateProject(s).has(`${RUNTIME_DIR}/${BROWSE_HELPER_FILE}`)).toBe(false);
  });
});

describe('the browse index', () => {
  it('lists every published entry in the index order, with its card and the values its controls read', () => {
    const s = homes(FULL);
    const rows = buildBrowseIndex(s, 'homes');
    expect(rows.map((r) => r.id)).toEqual(['en_cafe', 'en_quay', 'en_orchard', 'en_dune', 'en_harbour', 'en_cliff']);
    const cliff = rows.find((r) => r.id === 'en_cliff')!;
    expect(cliff).toMatchObject({ route: '/homes/cliff-cottage/', title: 'Cliff Cottage', excerpt: 'Sea views from every room.', date: '2026-01-01', image: null });
    expect(cliff.values).toEqual({ 'terms.region': ['north'], 'field.status': ['sale'], 'field.garden': true, 'field.price': 450000, 'field.bedrooms': 2, publishedAt: '2026-01-01', title: 'Cliff Cottage', 'field.agent': 'Zoë', 'field.listed': '2026-01-05' });
    // Defaults read as the entry's own: no status is the default, no garden is no.
    expect(rows.find((r) => r.id === 'en_dune')!.values).toMatchObject({ 'field.status': ['sale'], 'field.garden': true, 'field.agent': '', 'field.listed': '2026-03-02' });
    expect(rows.find((r) => r.id === 'en_harbour')!.values).toMatchObject({ 'field.garden': false });
    // No price reads as the field's default, zero, which is a price.
    expect(rows.find((r) => r.id === 'en_orchard')!.values['field.price']).toBe(0);
    expect(rows.find((r) => r.id === 'en_quay')!.values['field.price']).toBe(0);
  });

  it('finds an entry by what the site shows of it: never by a field no control shows', () => {
    const s = homes(FULL);
    const text = buildBrowseIndex(s, 'homes').find((r) => r.id === 'en_cliff')!.text!;
    expect(text.split('\n')).toEqual(['Cliff Cottage', 'Sea views from every room.', 'North Coast', 'For sale']);
    expect(text).not.toMatch(/Distressed|Zoë/);
    // Without a search, no words at all.
    expect(buildBrowseIndex(homes({ filters: ['terms.region'] }), 'homes').some((r) => 'text' in r)).toBe(false);
  });

  it('leaves the words out of an entry hidden from search, which a filter still lists', () => {
    let s = homes(FULL);
    s = run(s, { type: 'entry.update', collectionId: 'homes', entryId: 'en_cliff', searchHidden: true } as EditOperation);
    expect(s.collections.homes.entries.en_cliff.seo?.searchHidden).toBe(true);
    const cliff = buildBrowseIndex(s, 'homes').find((r) => r.id === 'en_cliff')!;
    expect(cliff.text).toBeUndefined();
    expect(cliff.values['terms.region']).toEqual(['north']);
  });

  it('offers only the options an entry has, and no range without a number', () => {
    const s = homes({ filters: ['field.status', 'terms.region', 'field.price'] });
    const controls = browseControls(s, 'homes');
    expect(controls.filters).toEqual([
      { key: 'field.status', kind: 'choice', label: 'Status', options: [{ value: 'sale', label: 'For sale' }, { value: 'sold', label: 'Sold' }, { value: 'let', label: 'To let' }] },
      { key: 'terms.region', kind: 'choice', label: 'Region', options: [{ value: 'north', label: 'North Coast' }, { value: 'south', label: 'South Bay' }] },
      { key: 'field.price', kind: 'range', label: 'Price' }
    ]);
    // A hand edit that leaves no entry a number (nor the field a default that is one).
    const unpriced = structuredClone(s);
    (unpriced.collections.homes.settings.fields.price as { default: unknown }).default = 'none';
    for (const e of Object.values(unpriced.collections.homes.entries)) delete e.values.price;
    expect(browseControls(unpriced, 'homes').filters.map((f) => f.key)).toEqual(['field.status', 'terms.region']);
  });
});

describe('the matching code', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  type Helper = { browse: (entries: unknown[], controls: unknown, criteria: unknown, locale?: string) => Array<{ id: string }>; isActive: (c: unknown) => boolean; sortChoices: (c: unknown, text: Record<string, string>, fill: (t: string, v: Record<string, string>) => string) => Array<{ value: string; label: string }> };
  async function helper(): Promise<Helper> {
    const dir = mkdtempSync(join(tmpdir(), 'browse-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'collection-browse.mjs'), browseJs());
    return import(/* @vite-ignore */ pathToFileURL(join(dir, 'collection-browse.mjs')).href);
  }
  const s = homes(FULL);
  const entries = buildBrowseIndex(s, 'homes');
  const controls = browseControls(s, 'homes');
  const none = { query: '', choices: {}, yesno: {}, min: {}, max: {}, sort: '' };
  const ids = (h: Helper, c: Partial<typeof none>) => h.browse(entries, controls, { ...none, ...c }, 'en').map((e) => e.id);

  it('searches every word, ignoring case and accents, in the words the index gives', async () => {
    const h = await helper();
    expect(ids(h, { query: 'cafe' })).toEqual(['en_cafe']);
    expect(ids(h, { query: 'NORTH coast' })).toEqual(['en_cafe', 'en_dune', 'en_cliff']);
    expect(ids(h, { query: 'north zeppelin' })).toEqual([]);
    expect(ids(h, { query: 'distressed' })).toEqual([]);
  });

  it('combines filters: any option picked within one, every filter across them', async () => {
    const h = await helper();
    expect(ids(h, { choices: { 'terms.region': ['north', 'south'] } })).toEqual(['en_cafe', 'en_quay', 'en_dune', 'en_harbour', 'en_cliff']);
    expect(ids(h, { choices: { 'terms.region': ['south'], 'field.status': ['sale'] } })).toEqual(['en_quay', 'en_dune']);
    expect(ids(h, { yesno: { 'field.garden': 'yes' } })).toEqual(['en_dune', 'en_cliff']);
    expect(ids(h, { yesno: { 'field.garden': 'no' } })).toEqual(['en_cafe', 'en_quay', 'en_orchard', 'en_harbour']);
    // A range is inclusive, open at either end, and an entry without the number is outside every range.
    expect(ids(h, { min: { 'field.price': '450000' } })).toEqual(['en_cafe', 'en_dune', 'en_cliff']);
    expect(ids(h, { max: { 'field.price': '0' } })).toEqual(['en_quay', 'en_orchard']);
    expect(ids(h, { min: { 'field.bedrooms': '3' }, max: { 'field.bedrooms': '4.5' } })).toEqual(['en_cafe', 'en_dune']);
    expect(ids(h, { min: { 'field.price': 'x' } })).toEqual(entries.map((e) => e.id));
    expect(h.isActive({ ...none, min: { 'field.price': ' ' } })).toBe(false);
    expect(h.isActive({ ...none, min: { 'field.price': '0' } })).toBe(true);
    expect(h.isActive({ ...none, query: '   ' })).toBe(false);
  });

  it('sorts both ways, entries without a value last either way, ties in the index order', async () => {
    const h = await helper();
    expect(ids(h, { sort: 'field.price:asc' })).toEqual(['en_quay', 'en_orchard', 'en_harbour', 'en_cliff', 'en_cafe', 'en_dune']);
    expect(ids(h, { sort: 'field.price:desc' })).toEqual(['en_dune', 'en_cafe', 'en_cliff', 'en_harbour', 'en_quay', 'en_orchard']);
    expect(ids(h, { sort: 'title:asc' })).toEqual(['en_cafe', 'en_cliff', 'en_dune', 'en_harbour', 'en_orchard', 'en_quay']);
    expect(ids(h, { sort: 'publishedAt:asc' })).toEqual(['en_cliff', 'en_harbour', 'en_dune', 'en_orchard', 'en_quay', 'en_cafe']);
    // Text sorts ignore case; blank text is no value.
    expect(ids(h, { sort: 'field.agent:asc' })).toEqual(['en_harbour', 'en_quay', 'en_cliff', 'en_cafe', 'en_orchard', 'en_dune']);
    expect(ids(h, { sort: 'field.listed:desc' })).toEqual(['en_dune', 'en_cliff', 'en_cafe', 'en_quay', 'en_orchard', 'en_harbour']);
    // Spaces alone are no value either, and go last with the blanks.
    const spaced = entries.map((e) => (e.id === 'en_orchard' ? { ...e, values: { ...e.values, 'field.agent': '   ' } } : e));
    expect(h.browse(spaced, controls, { ...none, sort: 'field.agent:asc' }, 'en').map((e) => e.id)).toEqual(['en_harbour', 'en_quay', 'en_cliff', 'en_cafe', 'en_orchard', 'en_dune']);
    // A page language the browser cannot sort by sorts as the browser does, and sorting by a number never asks.
    expect(h.browse(entries, controls, { ...none, sort: 'title:asc' }, 'en_US').map((e) => e.id)).toEqual(['en_cafe', 'en_cliff', 'en_dune', 'en_harbour', 'en_orchard', 'en_quay']);
    expect(h.browse(entries, controls, { ...none, sort: 'field.price:desc' }, 'en_US')[0].id).toBe('en_dune');
    // A sort the page does not offer is the index's order.
    expect(ids(h, { sort: 'field.motive:asc' })).toEqual(entries.map((e) => e.id));
  });

  it('names each sort with the field and its direction', async () => {
    const h = await helper();
    const text = { browseAscending: 'A to Z', browseDescending: 'Z to A', browseLowest: 'Lowest first', browseHighest: 'Highest first', browseOldest: 'Oldest first', browseNewest: 'Newest first', browseSortOption: '{field}: {order}', browseTitle: 'Title', browseDate: 'Date' };
    const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
    expect(h.sortChoices(controls, text, fill).map((o) => o.label)).toEqual([
      'Price: Lowest first',
      'Price: Highest first',
      'Date: Oldest first',
      'Date: Newest first',
      'Title: A to Z',
      'Title: Z to A',
      'Agent: A to Z',
      'Agent: Z to A',
      'Listed: Oldest first',
      'Listed: Newest first'
    ]);
  });
});

describe('the index page', () => {
  const svelteWarnings = (source: string, filename: string) => compile(source, { filename, generate: 'client', runes: true }).warnings.map((w) => `${w.code}: ${w.message}`);

  it('gives the first page of the index the controls, over its own cards and page links, and writes what they load', () => {
    const files = generateProject(publishedState(homes(FULL)));
    const page = files.get(archiveFile('/homes/'))!;
    expect(page).toContain(`import SoBrowse from "../../lib/siteorigin/runtime/${BROWSE_COMPONENT_FILE}";`);
    expect(page).toContain(`load={() => import("../../lib/siteorigin/runtime/${browseIndexFile('homes')}")}`);
    expect(page).toContain('size={2}');
    // The page as written stays inside: its lead, its grid and its page links.
    const inside = page.slice(page.indexOf('<SoBrowse'), page.indexOf('</SoBrowse>'));
    expect(inside).toContain('so-archive__card--lead');
    expect(inside).toContain('so-archive__pages');
    expect(inside).toContain('{#snippet results(entries)}');
    expect(svelteWarnings(page, 'src/routes/homes/+page.svelte')).toEqual([]);
    expect(svelteWarnings(files.get(`${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`)!, BROWSE_COMPONENT_FILE)).toEqual([]);
    expect(files.get(`${RUNTIME_DIR}/${BROWSE_HELPER_FILE}`)).toBe(browseJs());
    expect(files.get(`${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`)).toBe(BROWSE_SVELTE);
    const index = files.get(`${RUNTIME_DIR}/${browseIndexFile('homes')}`)!;
    expect(index).toContain('"en_cliff"');
    expect(index).not.toContain('Secret Draft');
    // Later pages and category archives stay as they are.
    expect(files.get(archiveFile('/homes/page/2/'))).not.toContain('SoBrowse');
    expect(files.get(archiveFile('/homes/page/3/'))).not.toContain('SoBrowse');
    // Nothing the site ships names the Builder's own code.
    for (const f of [page, index, files.get(`${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`)!, browseJs()]) expect(f).not.toMatch(/@shared|@generator|siteorigin\/cache/);
  });

  it('styles the matches it may list, even when the page itself shows no picture or category', () => {
    const page = generateProject(homes({ filters: ['field.garden'] })).get(archiveFile('/homes/'))!;
    expect(page).toContain(':global(.so-archive__image)');
    expect(page).toContain('.so-archive__category a');
    expect(page).toContain('import SoImage');
    expect(svelteWarnings(page, 'src/routes/homes/+page.svelte')).toEqual([]);
  });

  it('has no controls when none would do anything: a filter whose grouping no published entry is filed under', () => {
    const s = homes({ filters: ['terms.region'] });
    for (const e of Object.values(s.collections.homes.entries)) e.terms.region = [];
    expect(generateProject(s).get(archiveFile('/homes/'))).not.toContain('SoBrowse');
  });

  it('has no controls and no browse files without the setting, or with a design of its own', () => {
    const plain = generateProject(homes());
    expect(plain.get(archiveFile('/homes/'))).not.toContain('SoBrowse');
    expect([...plain.keys()].some((f) => f.includes('collection-browse') || f.includes(BROWSE_COMPONENT_FILE) || f.includes('/collections/'))).toBe(false);
    const designed = run(homes(FULL), { type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);
    const files = generateProject(designed);
    expect(files.get(archiveFile('/homes/'))).not.toContain('SoBrowse');
    expect(files.has(`${RUNTIME_DIR}/${BROWSE_HELPER_FILE}`)).toBe(false);
  });
});
