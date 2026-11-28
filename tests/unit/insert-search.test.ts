import { describe, expect, it } from 'vitest';
import { catalogueEntries, CATEGORY_LABELS } from '@catalogue/index';
import { BASICS, basicHay, basicSpec, searchItems } from '../../src/renderer/src/lib/insert-search';

/** What the Insert panel searches: every section of the starter theme (as it reads them), then the basic elements. */
const offered = () => [
  ...catalogueEntries('foundation').map((e) => ({ name: e.name, hay: `${e.name} ${e.description} ${e.tags.join(' ')} ${CATEGORY_LABELS[e.category] ?? e.category} section`.toLowerCase(), spec: { componentId: e.componentId } })),
  ...BASICS.map((b) => ({ name: b.name, hay: basicHay(b), spec: basicSpec(b) }))
];

describe('finding lists in Insert', () => {
  it('finds both kinds of list for "list", and the one named first for its own name', () => {
    const names = (q: string) => searchItems(offered(), q).map((it) => it.name);
    expect(names('list')).toEqual(expect.arrayContaining(['Bulleted list', 'Numbered list']));
    expect(names('bulleted list')[0]).toBe('Bulleted list');
    expect(names('numbered list')[0]).toBe('Numbered list');
    expect(names('Bulleted List')[0]).toBe('Bulleted list');
    expect(names('ordered')).toContain('Numbered list');
    expect(names('bullet points')).toContain('Bulleted list');
    expect(searchItems(offered(), '  ')).toEqual([]);
  });

  it('adds rich text that starts as a list of each kind', () => {
    const spec = (name: string) => basicSpec(BASICS.find((b) => b.name === name)!);
    expect(spec('Bulleted list')).toEqual({ primitive: 'richtext', text: '- First item\n- Second item\n- Third item' });
    expect(spec('Numbered list')).toEqual({ primitive: 'richtext', text: '1. First step\n2. Second step\n3. Third step' });
    expect(spec('Heading')).toEqual({ primitive: 'heading' });
  });
});

describe('column layouts in Insert (#514)', () => {
  const names = (q: string) => searchItems(offered(), q).map((it) => it.name);

  it('finds the two- and three-column layouts by number or by word, each once', () => {
    expect(names('2 columns')[0]).toBe('2 columns');
    expect(names('2-column')[0]).toBe('2 columns');
    expect(names('3 columns')[0]).toBe('3 columns');
    expect(names('three column')[0]).toBe('3 columns');
    expect(names('two columns')).toContain('2 columns');
    expect(names('side by side')).toEqual(expect.arrayContaining(['2 columns', '3 columns', 'Row']));
    const columns = names('columns');
    expect(columns).toEqual(expect.arrayContaining(['2 columns', '3 columns', 'Grid']));
    expect(columns.filter((n) => n === '2 columns')).toHaveLength(1);
  });

  // Release gap: searching "two columns" ranks the release's Feature bento and Testimonials, whose descriptions say two columns, ahead of the 2 columns layout.
  it.fails('finds the two-column layout first by word', () => {
    expect(names('two columns')[0]).toBe('2 columns');
  });

  it('finds the uneven layout starters by their names and by what they are for (#665)', () => {
    expect(names('bento')[0]).toBe('Bento grid');
    expect(names('featured tiles')[0]).toBe('Bento grid');
    expect(names('sidebar')[0]).toBe('Sidebar + main');
    expect(names('sticky')).toContain('Sidebar + main');
    expect(names('asymmetric')).toEqual(expect.arrayContaining(['Bento grid', 'Sidebar + main', 'Asymmetric split']));
    expect(names('wide narrow')[0]).toBe('Asymmetric split');
    // Foundation's Split layout offers a 2:1 split among its proportions too.
    expect(names('2:1')).toEqual(['Split layout', 'Asymmetric split']);
  });

  it('adds a Grid that starts with its columns, offered with the Row and Grid ahead of the other elements', () => {
    const spec = (name: string) => basicSpec(BASICS.find((b) => b.name === name)!);
    expect(spec('2 columns')).toEqual({ primitive: 'grid', columns: 2 });
    expect(spec('3 columns')).toEqual({ primitive: 'grid', columns: 3 });
    expect(spec('Grid')).toEqual({ primitive: 'grid' });
    expect(BASICS.filter((b) => b.layout).map((b) => b.name)).toEqual(['2 columns', '3 columns', 'Bento grid', 'Sidebar + main', 'Asymmetric split', 'Row', 'Grid']);
    // Every tile has a key of its own.
    expect(new Set(BASICS.map((b) => b.id)).size).toBe(BASICS.length);
  });
});

describe('word forms in Insert (#1360)', () => {
  const names = (q: string) => searchItems(offered(), q).map((it) => it.name);
  const pricing = ['Pricing', 'Pricing with billing switch', 'Pricing comparison'];

  it('finds every pricing section by price, prices or pricing, ahead of what only mentions a price', () => {
    for (const q of ['price', 'prices', 'pricing', 'Prices']) expect(names(q).slice(0, 3), q).toEqual(pricing);
    expect(names('price')).toEqual(expect.arrayContaining(['Data table', 'Downloads']));
    expect(names('prices')).toEqual(expect.arrayContaining(['Data table', 'Downloads']));
  });

  it('matches another form only as a whole word, and only for the words listed', () => {
    const items = ['Repricing notes', 'Sitemap'].map((name) => ({ name, hay: `${name} location_x relocation`.toLowerCase() }));
    expect(searchItems(items, 'prices')).toEqual([]);
    expect(searchItems(items, 'map').map((it) => it.name)).toEqual(['Sitemap']);
    expect(searchItems(items, 'constructor')).toEqual([]);
    // General plurals are not stripped: Contact details says "There is no form".
    expect(names('forms')).not.toContain('Contact details');
  });

  it('still needs every word, so a second word narrows what price finds', () => {
    expect(names('price list')).toEqual(expect.arrayContaining(['Data table', 'Downloads']));
    expect(names('price list')).not.toContain('Pricing');
    expect(names('prices billing')).toEqual(['Pricing with billing switch']);
  });

  it('ranks names: as typed, then named by another form, starting with it, holding it, and last a description', () => {
    const item = (name: string, about = '') => ({ name, hay: `${name} ${about}`.toLowerCase() });
    const ranked = (items: ReturnType<typeof item>[], q: string) => searchItems(items, q).map((it) => it.name);
    // Listed worst first, so panel order alone would give the reverse.
    expect(ranked([item('Rates', 'a price list'), item('All pricing options'), item('Pricing: seasonal'), item('Pricing'), item('Price card')], 'price')).toEqual(['Price card', 'Pricing', 'Pricing: seasonal', 'All pricing options', 'Rates']);
    // A project's own component, listed first, does not displace the section named for the search.
    expect(ranked([item('Pricing plans comparison'), item('Pricing comparison')], 'price comparison')).toEqual(['Pricing comparison', 'Pricing plans comparison']);
  });

  it('reads another form in any word, beside punctuation, and in the name an item shows', () => {
    const items = [
      { name: 'Rates', hay: 'rates dark pricing variant', shownAs: 'Rates Light' },
      { name: 'Plans', hay: 'plans (pricing) dark variant', shownAs: 'Plans (pricing) Dark' }
    ];
    expect(searchItems(items, 'dark price', (it) => it.shownAs).map((it) => it.name)).toEqual(['Plans', 'Rates']);
  });

  it('finds the contact details by map', () => {
    expect(names('map')).toEqual(['Contact details']);
  });
});
