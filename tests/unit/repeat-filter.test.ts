/**
 * Category filters on repeated items (#382): a repeat names an item field holding each item's category and, optionally,
 * the yes/no property that turns its pills on. The generated component prerenders every item and a row of pills (All,
 * then each category the items that render name), hides other items on screen only, and counts what shows. Designs
 * whose filter could not work are reported, refused where they are written, and render as plain lists.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, ElementNode, InstanceNode, ListItem, ProjectState, RepeatNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { repeatFilterProblem } from '@engine/schema';
import { FILTER_OFF_CLASS, defFile, generateComponentsCss, generateProject, generateStandaloneComponent } from '@generator/index';
import { UTIL_JS } from '@generator/runtime-files';
import { P, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { MIGRATIONS } from '@shared/migrations';
import { partReach } from '@agent/scope';
import { VISITOR_TEXT_GROUPS, visitorTextFor } from '@shared/visitor-text';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);
/** A single empty Home page: nothing on it but what a test places. */
const blank = () => createStarterState('blank', 'Test Studio', false);
/** The cards of every list on a page, by the class of the design's card element. */
const cards = (html: string) => html.match(/<li class="so-[a-z0-9-]+__card\b/g) ?? [];
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const filterProblems = (s: ProjectState) => validateState(s).filter((d) => d.code === 'FILTER_INVALID');

/** Place a component at the end of Home. */
function place(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}): InstanceNode {
  const node = makeInstance(def, props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

/** The project's copy of a Foundation component. */
const foundation = (s: ProjectState, componentId: string) => s.components[installComponent(s, componentId)];

/** Foundation's Page list (a portfolio) on Home: a card per category, linking in turn to the starter's other pages. */
function portfolio(s: ProjectState, categories: string[], props: Record<string, unknown> = {}) {
  const list = foundation(s, 'content.pages');
  const pages = Object.keys(s.pages).filter((id) => id !== s.site.homePageId);
  const items = categories.map((group, i) => ({ id: `p${i + 1}`, pageLink: { type: 'page', target: pages[i % pages.length] }, title: `Project ${i + 1}`, group }));
  return { list, node: place(s, list, { items, ...props }) };
}
/** The Page list cards on a page. */
const portfolioCards = (html: string) => html.match(/<li class="so-foundation-content-pages__card-item\b/g) ?? [];

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

/** Items with these categories (and titles naming their place). */
const items = (...categories: string[]): ListItem[] => categories.map((category, i) => ({ id: `i${i + 1}`, title: `Card ${i + 1}`, category }));

const TYPES = ['Residential', 'Commercial', 'Restoration'] as const;

/** A card grid filtered by a text or choice field, turned on by `filterable`, with a list item per card. */
function gridDef(s: ProjectState, field: 'text' | 'choice' = 'text') {
  return addDef(s, {
    componentId: `test.grid-${field}`,
    name: 'Project grid',
    properties: {
      filterable: P.bool('Filter', true),
      items: P.list(
        'Projects',
        'Project',
        { title: P.str('Title', 'Project'), category: field === 'text' ? P.str('Category', '') : P.choice('Category', 'residential', TYPES.map((t) => [t.toLowerCase(), t])) },
        [],
        { titleField: 'title' }
      )
    },
    parts: {},
    build: (b) =>
      b.el('root', 'section', {}, [
        b.el('wrap', 'div', {}, [
          b.el('grid', 'ul', {}, [b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.text('title', 'h3', { $item: 'title' })])], { filter: { field: 'category', when: { $prop: 'filterable' } } })])
        ])
      ])
  });
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render the exported Home page. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'repeat-filter-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
}

/** Each filter row on the page: its pills as [label, pressed, disabled] and the status it reads out. */
function bars(html: string) {
  return [...html.matchAll(/<div class="so-filter"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => ({
    open: /<div class="so-filter"[^>]*>/.exec(m[0])![0],
    pills: [...m[1].matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((b) => [b[2], /aria-pressed="true"/.test(b[1]), /\bdisabled\b/.test(b[1])]),
    status: /role="status"[^>]*>([^<]*)</.exec(m[1])?.[1]
  }));
}

/** Compiler warnings and errors for one design's generated file, in the site and in the editor, for server and browser. */
function compiled(s: ProjectState, def: ComponentDefinition): string[] {
  const out: string[] = [];
  for (const instrument of [false, true]) {
    const source = generateProject(s, { instrument }).get(defFile(def))!;
    for (const generate of ['server', 'client'] as const) out.push(...compile(source, { filename: defFile(def), generate, runes: true }).warnings.map((w) => `${instrument ? 'editor' : 'site'} ${generate}: ${w.code}`));
  }
  return out;
}

describe('generated category filters', () => {
  it('prerender every card and a row of disabled pills, All pressed, once a Foundation Page list’s cards name two categories', async () => {
    const s = fresh();
    const { list } = portfolio(s, ['Homes', 'Offices', 'homes']);
    portfolio(s, ['Homes', ' homes']);
    expect(filterProblems(s)).toEqual([]);
    expect(compiled(s, list)).toEqual([]);
    const html = await renderHome(s);
    // The second placement's cards name one category between them: no pills there.
    expect(bars(html)).toEqual([
      {
        open: '<div class="so-filter" role="group" aria-label="Filter by category">',
        pills: [['All', true, true], ['Homes', false, true], ['Offices', false, true]],
        status: '3 items showing'
      }
    ]);
    // Every card is in the page, none hidden.
    expect(portfolioCards(html)).toHaveLength(5);
    expect(html).not.toContain(FILTER_OFF_CLASS);
    // The row goes just above the list, inside the section's own container.
    expect(html.indexOf('class="so-filter"')).toBeLessThan(html.indexOf('so-foundation-content-pages__grid'));
  });

  it('pills a text field’s categories in the order items first name them, once each however they are spelt, and leaves blanks to All', async () => {
    const s = fresh();
    const def = gridDef(s);
    place(s, def, { items: items(' Commercial', 'residential', 'commercial ', '', 'Residential', 'Restoration') });
    const [bar] = bars(await renderHome(s));
    expect(bar.pills.map((p) => p[0])).toEqual(['All', 'Commercial', 'residential', 'Restoration']);
    expect(bar.status).toBe('6 items showing');
  });

  it('pills a choice field in the order of its options, with their labels, leaving out options no item names', async () => {
    const s = fresh();
    const def = gridDef(s, 'choice');
    place(s, def, { items: items('restoration', 'residential', 'restoration') });
    const [bar] = bars(await renderHome(s));
    expect(bar.pills.map((p) => p[0])).toEqual(['All', 'Residential', 'Restoration']);
    expect(compiled(s, def)).toEqual([]);
  });

  it('shows no pills with the toggle off, or when the items name fewer than two categories', async () => {
    const s = blank();
    const def = gridDef(s);
    place(s, def, { filterable: false, items: items('A', 'B') });
    place(s, def, { items: items('A', 'a', '') });
    place(s, def, { items: [] });
    const html = await renderHome(s);
    expect(bars(html)).toEqual([]);
    expect(cards(html)).toHaveLength(5);
  });

  it('counts and pills only the cards that render: a page list’s card whose page has gone names nothing', async () => {
    const s = fresh();
    const list = foundation(s, 'content.pages');
    const [a, b] = Object.keys(s.pages).filter((id) => id !== s.site.homePageId);
    const page = (target: string) => ({ type: 'page', target });
    place(s, list, {
      items: [
        { id: 'p1', pageLink: page(a), title: 'One', group: 'Homes' },
        { id: 'p2', pageLink: page(b), title: 'Two', group: 'Offices' },
        { id: 'p3', pageLink: { type: 'none', target: '' }, title: 'Gone', group: 'Ghosts' }
      ]
    });
    expect(compiled(s, list)).toEqual([]);
    const [bar] = bars(await renderHome(s));
    expect(bar.pills.map((p) => p[0])).toEqual(['All', 'Homes', 'Offices']);
    expect(bar.status).toBe('2 items showing');
  });

  it('keeps each item’s class list and adds the hiding class only while another category is chosen', () => {
    const s = fresh();
    const def = gridDef(s, 'choice');
    place(s, def);
    const source = generateProject(s).get(defFile(def))!;
    expect(source).toContain(`so_filter_0_active !== null && filterKey(item.category, [{"value":"residential","label":"Residential"},{"value":"commercial","label":"Commercial"},{"value":"restoration","label":"Restoration"}]) !== so_filter_0_active && "${FILTER_OFF_CLASS}"`);
    // The editor's copy takes the bridge's request to show every item again; the site's never does.
    expect(source).not.toContain('sofilterreset');
    expect(generateProject(s, { instrument: true }).get(defFile(def))).toContain('data-so-filter onsofilterreset={() => (so_filter_0 = null)}');
  });

  it('hides filtered items on screen only and leaves the pills out of print, for designs that filter', () => {
    const s = blank();
    const before = generateComponentsCss(s);
    expect(before).not.toContain(FILTER_OFF_CLASS);
    place(s, gridDef(s));
    const css = generateComponentsCss(s);
    expect(css).toContain(`@media not print {\n\t.${FILTER_OFF_CLASS}:not(#so-print) { display: none !important; }\n}`);
    expect(css).toContain(`@media print {\n\t.so-filter:not(#so-print) { display: none !important; }\n}`);
    // The status is read out but not shown, whatever the theme's own CSS has.
    expect(css).toContain('.so-filter__status { position: absolute; width: 1px; height: 1px;');
  });

  it('keeps filtering, with its hiding rules, in a code copy of a placement', () => {
    const s = fresh();
    const { node } = portfolio(s, ['Homes', 'Offices']);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }]);
    const copy = r.state.components[(r.results[0] as { definitionId: string }).definitionId];
    expect(copy.kind).toBe('code');
    const code = copy.source!;
    expect(code).toContain('let so_filter_0 = $state(null);');
    expect(code).toContain('<div class="so-filter" role="group"');
    // The rules reach a card a helper renders, outside the copy's own markup.
    expect(code).toContain(`:global(.${FILTER_OFF_CLASS}:not(#so-print))`);
    expect(code).toContain(`:global(.so-filter:not(#so-print))`);
    for (const generate of ['server', 'client'] as const) expect(compile(code, { filename: 'Copy.svelte', generate, runes: true }).warnings.map((w) => w.code)).toEqual([]);
  });

  it('keeps filtering by an item field a code copy has to rename', () => {
    const s = blank();
    const def = addDef(s, {
      componentId: 'test.classy',
      name: 'Classy',
      properties: { filterable: P.bool('Filter', true), items: P.list('Items', 'Item', { title: P.str('Title', ''), class: P.str('Class', '') }, items('A', 'B').map(({ id, title, category }) => ({ id, title, class: category })), {}) },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('grid', 'ul', {}, [b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.text('title', 'h3', { $item: 'title' })])], { filter: { field: 'class', when: { $prop: 'filterable' } } })])])
    });
    const node = place(s, def);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }]);
    const code = r.state.components[(r.results[0] as { definitionId: string }).definitionId].source!;
    expect(code).toContain('filterCategories(so_filter_0_rows, "classValue")');
    expect(code).toContain('filterKey(item.classValue) !== so_filter_0_active');
  });

  it('names categories and pills them through the generated helpers', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(join(resolve('.tmp'), 'repeat-filter-util-'));
    roots.push(dir);
    writeFileSync(join(dir, 'util.mjs'), UTIL_JS);
    type Options = Array<{ value: string; label: string }>;
    const { filterKey, filterCategories } = (await import(/* @vite-ignore */ join(dir, 'util.mjs'))) as {
      filterKey: (v: unknown, o?: Options) => string;
      filterCategories: (rows: unknown[], field: string, o?: Options) => Array<{ key: string; label: string }>;
    };
    expect([filterKey(' Commercial '), filterKey(''), filterKey(undefined), filterKey(3), filterKey({})]).toEqual(['commercial', '', '', '', '']);
    const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];
    expect([filterKey('a', options), filterKey('A', options), filterKey('c', options)]).toEqual(['a', '', '']);
    expect(filterCategories([{ c: 'x' }, null, { c: ' X ' }, { c: 'y' }, {}], 'c')).toEqual([{ key: 'x', label: 'x' }, { key: 'y', label: 'y' }]);
    expect(filterCategories([{ c: 'b' }, { c: 'a' }, { c: 'z' }], 'c', options)).toEqual([{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]);
    // Two options sharing a value (a hand edit) make one pill, so no two pills share a key.
    expect(filterCategories([{ c: 'a' }, { c: 'b' }], 'c', [...options, { value: 'a', label: 'Again' }])).toEqual([{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]);
  });

  it('says what it says in every language with built-in wording, and in Site styles', () => {
    for (const code of ['en', 'ar', 'he']) {
      const t = visitorTextFor(fresh().site, code);
      for (const key of ['filterLabel', 'filterAll', 'filterOne', 'filterMany'] as const) expect(t[key], `${code} ${key}`).toBeTruthy();
      expect(t.filterMany).toContain('{count}');
    }
    expect(VISITOR_TEXT_GROUPS.flatMap((g) => g.fields.map((f) => f.key))).toEqual(expect.arrayContaining(['filterLabel', 'filterAll', 'filterOne', 'filterMany']));
  });
});

describe('filters that cannot work', () => {
  /** The grid design with its tree changed, reported as a whole project. */
  function broken(change: (def: ComponentDefinition, nodes: Record<string, ElementNode | RepeatNode>) => void): string[] {
    const s = fresh();
    const def = gridDef(s);
    change(def, def.tree!.nodes as Record<string, ElementNode | RepeatNode>);
    place(s, def);
    const problems = filterProblems(s).map((d) => d.message);
    // A filter that does not work renders the items as a plain list, which still compiles cleanly.
    expect(compiled(s, def)).toEqual([]);
    expect(generateProject(s).get(defFile(def))).not.toContain('so_filter_0');
    return problems;
  }
  const repeat = (nodes: Record<string, ElementNode | RepeatNode>) => nodes.cards as RepeatNode;

  it.each([
    ['a field the items lack', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => (repeat(n).filter = { field: 'kind' }), /filters by "kind", which items of "Projects" do not have/],
    ['a field that is not text or a choice', (d: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => {
      (d.properties.items as { fields: Record<string, unknown> }).fields.featured = { type: 'boolean', label: 'Featured', default: false };
      repeat(n).filter = { field: 'featured' };
    }, /a boolean field; a category is a text or choice field/],
    ['a switch that is not a yes/no property', (d: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => {
      d.properties.mode = P.str('Mode', '');
      repeat(n).filter = { field: 'category', when: { $prop: 'mode' } };
    }, /turned on by "Mode", which is not a yes\/no property/],
    ['a switch the component lacks', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => (repeat(n).filter = { field: 'category', when: { $prop: 'missing' } }), /turned on by "missing", which the component does not have/],
    ['other settings', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => ((repeat(n) as unknown as { filter: unknown }).filter = { field: 'category', order: ['a'] }), /also says "order"/],
    ['a holder shared with other content', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => {
      n.note = { id: 'note', kind: 'element', tag: 'li', children: [] };
      (n.grid as ElementNode).children.push('note');
    }, /shares the element holding it with other content/],
    ['the design’s top element as the holder', (d: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => {
      d.tree!.rootIds = ['grid'];
      delete n.root;
      delete n.wrap;
    }, /needs an element of its own, inside the design’s top element/],
    ['a holder inside a list', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => ((n.wrap as ElementNode).tag = 'ul'), /held by an element inside a list, a paragraph or a summary/],
    ['a carousel', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => ((n.grid as ElementNode).carousel = true), /is a carousel’s slides/],
    ['a card that links somewhere around it', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => ((n.wrap as ElementNode).link = { type: 'url', target: 'https://example.com' }), /inside a card that links somewhere/],
    ['items that are not one element each', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => (repeat(n).children = ['title']), /shows items that are not one element each/],
    ['items that are carousels', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => Object.assign(n.card as ElementNode, { tag: 'ul', carousel: true }), /shows items that are not one element each/],
    ['items that open something', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => Object.assign(n.card as ElementNode, { tag: 'div', action: 'image' }), /shows items that are not one element each/],
    ['a holder that opens something', (_: ComponentDefinition, n: Record<string, ElementNode | RepeatNode>) => Object.assign(n.grid as ElementNode, { tag: 'div', action: 'link', link: { type: 'url', target: 'https://example.com' } }), /held by an element that links somewhere or opens something/],
    ['a choice whose options cannot be read', (d: ComponentDefinition) => ((d.properties.items as { fields: Record<string, unknown> }).fields.category = { type: 'enum', label: 'Kind', default: 'a', options: [null] }), /a choice whose options cannot be read/]
  ])('reports %s and renders a plain list', (_label, change, message) => {
    expect(broken(change)).toEqual([expect.stringMatching(message)]);
  });

  it('accepts wrappers whose action or link does nothing', () => {
    const s = fresh();
    const def = gridDef(s);
    const n = def.tree!.nodes as Record<string, ElementNode>;
    Object.assign(n.wrap, { action: 'none', link: { type: 'url', target: 'https://example.com' } });
    Object.assign(n.card, { action: 'none' });
    n.root.link = { type: 'none', target: '' };
    place(s, def, { items: items('A', 'B') });
    expect(filterProblems(s)).toEqual([]);
    expect(generateProject(s).get(defFile(def))).toContain('so_filter_0');
  });

  it('reports a filtered list in content handed to a nested component’s slot', () => {
    const s = fresh();
    const box = addDef(s, { componentId: 'test.box', name: 'Box', properties: {}, parts: {}, slots: { content: { label: 'Content' } }, build: (b) => b.el('root', 'p', {}, [b.slot('content', 'content')]) });
    const def = addDef(s, {
      componentId: 'test.slotted',
      name: 'Slotted',
      properties: { items: P.list('Items', 'Item', { title: P.str('Title', ''), category: P.str('Category', '') }, [], {}) },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('grid', 'span', {}, [b.repeat('cards', 'items', [b.el('card', 'span', {}, [])], { filter: { field: 'category' } })])])
    });
    const inst = makeInstance(box, {});
    inst.slots = { content: ['grid'] };
    def.tree!.nodes[inst.id] = inst;
    (def.tree!.nodes.root as ElementNode).children = [inst.id];
    expect(repeatFilterProblem(def, def.tree!.nodes.cards)).toMatch(/in content placed in a nested component/);
  });

  it('reports a filter inside another list', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.nested',
      name: 'Nested',
      properties: {
        groups: P.list('Groups', 'Group', { name: P.str('Name', ''), category: P.str('Category', '') }, [], {}),
        items: P.list('Items', 'Item', { title: P.str('Title', ''), category: P.str('Category', '') }, [], {})
      },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('groups', 'div', {}, [
            b.repeat('group', 'groups', [b.el('group-box', 'div', {}, [b.el('list', 'ul', {}, [b.repeat('cards', 'items', [b.el('card', 'li', {}, [])], { filter: { field: 'category' } })])])])
          ])
        ])
    });
    expect(repeatFilterProblem(def, def.tree!.nodes.cards)).toMatch(/inside another list/);
  });

  it('refuses a filter on anything but a repeat', () => {
    const s = fresh();
    const def = gridDef(s);
    (def.tree!.nodes.grid as unknown as { filter: unknown }).filter = { field: 'category' };
    expect(filterProblems(s).map((d) => d.message)).toEqual([expect.stringMatching(/has a category filter, which only a repeat can/)]);
  });
});

describe('editing designs that filter', () => {
  it('keeps the property that turns the filter on, and its type, while the filter uses it', () => {
    const s = fresh();
    const def = gridDef(s);
    place(s, def);
    expect(() => apply(s, [{ type: 'component.removePropSchema', definitionId: def.id, prop: 'filterable' }])).toThrow(/"filterable" turns on the category filter of .*\. Change the design without that filter first\./);
    expect(() => apply(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'filterable', schema: { type: 'string', label: 'Filter', default: '' } } as EditOperation])).toThrow(/needs a boolean/);
  });

  it('refuses a change that takes away pills a page shows, and reports one where no placement shows them', () => {
    // The card becomes a component of its own: the list's item is no longer one element the filter can hide.
    const makeCard = (s: ProjectState, def: ComponentDefinition) => applyOperations(s, [{ type: 'component.createFromNode', owner: { kind: 'component', id: def.id }, nodeId: 'card', name: 'Project card' }]).state;
    const introduced = (before: ProjectState, after: ProjectState) => introducedDiagnostics(validateState(before).filter(blocksSaving), validateState(after).filter(blocksSaving)).map((d) => d.code);
    const shown = fresh();
    const def = gridDef(shown);
    place(shown, def, { items: items('A', 'B') });
    expect(introduced(shown, makeCard(shown, def))).toEqual(['FILTER_INVALID']);
    // Switched off everywhere it is placed: the design keeps its filter, and the edit saves with a warning.
    const off = fresh();
    const quiet = gridDef(off);
    place(off, quiet, { filterable: false, items: items('A', 'B') });
    place(off, quiet, { items: items('A', 'a') });
    const next = makeCard(off, quiet);
    expect(introduced(off, next)).toEqual([]);
    expect(filterProblems(next).map((d) => [d.severity, d.message])).toEqual([['warning', expect.stringMatching(/shows items that are not one element each.*Its items all show, without category buttons\./)]]);
    expect(generateProject(next).get(defFile(next.components[quiet.id]))).not.toContain('so_filter_0');
  });

  it('copies a filter with a design built whole, and refuses one that would not work', () => {
    const s = fresh();
    const op = (filter: unknown, top: 'section' | 'list' = 'section'): EditOperation =>
      ({
        type: 'component.upsert',
        name: 'Directory',
        properties: {
          filterable: { type: 'boolean', label: 'Filter by category', default: true },
          people: { type: 'list', label: 'People', itemLabel: 'Person', fields: { name: { type: 'string', label: 'Name', default: '' }, team: { type: 'string', label: 'Team', default: '' } }, default: [] }
        },
        nodes: [
          ...(top === 'section' ? [{ kind: 'element', id: 'root', tag: 'section', children: ['list'] }] : []),
          { kind: 'element', id: 'list', tag: 'ul', children: ['each'] },
          { kind: 'repeat', id: 'each', list: 'people', children: ['person'], filter },
          { kind: 'element', id: 'person', tag: 'li', children: ['name'] },
          { kind: 'text', id: 'name', tag: 'p', text: { $item: 'name' } }
        ]
      }) as EditOperation;
    // A design written whole names the switch plainly, as it names a repeat's list; the document keeps it as a binding.
    const good = op({ field: 'team', when: 'filterable' });
    expect(validateOperation(good).ok).toBe(true);
    const after = applyOperations(s, [good]).state;
    const def = Object.values(after.components).find((d) => d.name === 'Directory')!;
    expect((def.tree!.nodes.each as RepeatNode).filter).toEqual({ field: 'team', when: { $prop: 'filterable' } });
    expect(validateOperation(op({ field: 'team', order: [] })).ok).toBe(false);
    // Without a switch the pills always show.
    const always = Object.values(applyOperations(s, [op({ field: 'team' })]).state.components).find((d) => d.name === 'Directory')!;
    expect((always.tree!.nodes.each as RepeatNode).filter).toEqual({ field: 'team' });
    expect(() => applyOperations(s, [op({ field: 'team', when: 'people' })])).toThrow(/needs a boolean/);
    expect(() => applyOperations(s, [op({ field: 'nickname' })])).toThrow(/filters by "nickname"/);
    // A list held by the design's top element leaves the pills nowhere to go.
    expect(() => applyOperations(s, [op({ field: 'team' }, 'list')])).toThrow(/needs an element of its own/);
  });

  it('carries the filter and its switch into a component made from the part of a design holding the list', () => {
    const s = fresh();
    const def = gridDef(s);
    place(s, def);
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: { kind: 'component', id: def.id }, nodeId: 'wrap', name: 'Project cards' }]);
    const made = Object.values(r.state.components).find((d) => d.name === 'Project cards')!;
    const filtered = Object.values(made.tree!.nodes).find((n): n is RepeatNode => n.kind === 'repeat')!;
    const on = filtered.filter!.when!.$prop;
    expect(made.properties[on]).toMatchObject({ type: 'boolean' });
    expect(filtered.filter!.field).toBe('category');
    expect(filterProblems(r.state)).toEqual([]);
  });

  it('refuses to detach a placement that filters its items, and detaches one whose cards name one category', () => {
    const s = fresh();
    const on = portfolio(s, ['Homes', 'Offices']).node;
    const off = portfolio(s, ['Homes', 'homes ']).node;
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    expect(() => apply(s, [{ type: 'component.detachInstance', owner, nodeId: on.id }])).toThrow(/filters its items by category here/);
    expect(() => apply(s, [{ type: 'component.detachInstance', owner, nodeId: on.id }])).toThrow(/Give its items one category between them, or none, first/);
    expect(() => apply(s, [{ type: 'component.detachInstance', owner, nodeId: off.id }])).not.toThrow();
    // Only cards that render count: the second category is on a card whose page link goes nowhere.
    const t = fresh();
    const { node } = portfolio(t, ['Homes', 'Offices']);
    ((node.props.items as ListItem[])[1] as Record<string, unknown>).pageLink = { type: 'none', target: '' };
    expect(() => apply(t, [{ type: 'component.detachInstance', owner: { kind: 'page', id: t.site.homePageId }, nodeId: node.id }])).not.toThrow();
  });

  it('refuses to detach a placement whose switch the site reads as its default, on', () => {
    const s = fresh();
    const def = gridDef(s);
    const node = place(s, def, { filterable: null, items: items('A', 'B') });
    expect(() => apply(s, [{ type: 'component.detachInstance', owner: { kind: 'page', id: s.site.homePageId }, nodeId: node.id }])).toThrow(/filters its items by category here/);
  });

  it('counts the filter’s field as used above the list, so a part inside one item never holds it alone', () => {
    const s = fresh();
    const def = gridDef(s);
    (def.tree!.nodes.title as unknown as { text: unknown }).text = { $item: 'category' };
    expect(partReach(def, 'title').itemFields.get('items')?.has('category') ?? false).toBe(false);
    // A part holding the whole list, pills and all, holds the field.
    expect(partReach(def, 'wrap').itemFields.get('items')?.has('category')).toBe(true);
  });

  it('marks the format with a version-only step', () => {
    expect(MIGRATIONS.at(-1)!.id).toBe('repeat-filters');
    const s = fresh();
    const out = structuredClone(s);
    MIGRATIONS.at(-1)!.migrate(out as never, () => true);
    expect(out).toEqual(s);
  });
});
