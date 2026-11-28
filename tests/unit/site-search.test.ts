/**
 * Site search (#246): the index of the pages the generator writes with the site, and the search code the exported
 * site runs on it, imported here exactly as generated.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { afterAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { catalogueEntries } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE, SEARCH_JS, buildSearchIndex, pageText, usesSiteSearch, type SearchEntry } from '@generator/search';
import { readField } from '../../src/renderer/src/lib/held';
import { describeOps } from '@agent/report';
import type { EditOperation } from '@shared/ops';
import type { GraphNode, InstanceNode, ProjectState, ResponsiveStyles } from '@shared/types';
import { P, prop } from '@catalogue/dsl';
import { foundationDesign, projectDesign, type DesignSpec } from './fixtures/packs';

const HELPER = `${RUNTIME_DIR}/${SEARCH_HELPER_FILE}`;
const INDEX = `${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`;
const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const pageAt = (s: ProjectState, route: string) => Object.values(s.pages).find((p) => p.route === route)!;
const home = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/** A site with Site search on its home page. */
function withSearch(s: ProjectState = fresh()): ProjectState {
  return apply(s, [{ type: 'node.insert', owner: home(s), componentId: 'site.search' }]);
}

/** A text section built in the editor: a heading over rich text, each a property it shows. */
const TEXT_SECTION: DesignSpec = {
  componentId: 'project.text',
  name: 'Text',
  properties: { heading: P.str('Heading', 'Heading'), body: P.rich('Text', []) },
  parts: { root: { nodeId: 'root', label: 'Text' } },
  build: (b) => b.el('root', 'section', { name: 'Text' }, [b.text('heading', 'h2', prop('heading'), { name: 'Heading' }), b.rich('body', prop('body'), { name: 'Text' })])
};

/**
 * A project page with a text section, its body ending with `tail` after a long run of other words. The section is
 * one built in the editor, whose words the index reads from its design, unless `componentId` names one of the
 * theme's.
 */
function project(s: ProjectState, n: number, tail = `Commissioned as piece ${n}.`, componentId?: string): ProjectState {
  const id = `pg_project${n}`;
  const filler = Array.from({ length: 60 }, (_, i) => `Oak and linen panel ${i} with a hand-rubbed finish.`).join(' ');
  let placed: { componentId: string } | { definitionId: string };
  if (componentId) placed = { componentId };
  else {
    const def = foundationDesign(TEXT_SECTION);
    if (!s.components[def.id]) projectDesign((s = structuredClone(s)), TEXT_SECTION);
    placed = { definitionId: def.id };
  }
  return apply(s, [
    { type: 'page.create', pageId: id, title: `Workshop commission ${n}`, route: `/portfolio/workshop-commission-${n}/` },
    { type: 'node.insert', owner: { kind: 'page', id }, ...placed, props: { heading: `Commission ${n}`, body: `${filler}\n\n${tail}` } } as EditOperation
  ]);
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The search code and an index as the exported site has them, imported as modules. */
async function runtime(index: string, helper = SEARCH_JS): Promise<{ loadPages: () => Promise<SearchEntry[]>; searchPages: (pages: unknown, query: string, limit?: number) => Found; searchWords: (q: string) => string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'so-search-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, SEARCH_HELPER_FILE), helper);
  writeFileSync(join(dir, SEARCH_INDEX_FILE), index);
  return import(/* @vite-ignore */ pathToFileURL(join(dir, SEARCH_HELPER_FILE)).href);
}

interface Part {
  text: string;
  mark: boolean;
}
interface Found {
  total: number;
  results: Array<{ route: string; title: Part[]; excerpt: Part[] }>;
}
const read = (parts: Part[]) => parts.map((p) => p.text).join('');
const marked = (parts: Part[]) => parts.filter((p) => p.mark).map((p) => p.text);

describe('site search files', () => {
  it('are generated only while a component of the site searches', () => {
    const s = fresh();
    expect(usesSiteSearch(s)).toBe(false);
    const files = generateProject(s);
    expect(files.has(HELPER)).toBe(false);
    expect(files.has(INDEX)).toBe(false);
    const searched = withSearch(s);
    expect(usesSiteSearch(searched)).toBe(true);
    const clean = generateProject(searched);
    const dev = generateProject(searched, { instrument: true });
    expect(clean.get(HELPER)).toBe(SEARCH_JS);
    expect(clean.get(INDEX)).toBeTruthy();
    // The editor's preview searches the same pages the export does.
    expect(dev.get(INDEX)).toBe(clean.get(INDEX));
    expect(dev.get(HELPER)).toBe(SEARCH_JS);
    // Written before the component that imports them.
    const keys = [...clean.keys()];
    const def = Object.values(searched.components).find((d) => d.componentId === 'site.search')!;
    expect(keys.indexOf(INDEX)).toBeLessThan(keys.indexOf(defFile(def)));
    expect(keys.indexOf(HELPER)).toBeLessThan(keys.indexOf(defFile(def)));
    expect(clean.get(defFile(def))).toContain(`from '../runtime/${SEARCH_HELPER_FILE}'`);
  });

  it('keep working for a copy of the component made unique', () => {
    const s = withSearch();
    const node = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'site.search') as InstanceNode;
    const after = apply(s, [{ type: 'component.makeUnique', owner: home(s), nodeId: node.id, name: 'Project finder' }]);
    const copy = Object.values(after.components).find((d) => d.owner === 'project' && d.kind === 'code')!;
    expect(copy.sourcePath).toMatch(/^src\/lib\/siteorigin\/custom\//);
    // The copy alone keeps the search files, with the theme's original gone from the project, however its import is spelled.
    delete after.components[node.definitionId];
    expect(usesSiteSearch(after)).toBe(true);
    const files = generateProject(after);
    expect(files.has(HELPER)).toBe(true);
    for (const spelling of ["'../runtime/site-search'", "'$lib/siteorigin/runtime/./site-search.js'"]) {
      copy.source = copy.source!.replace(/'[^']*site-search[^']*'/, spelling);
      expect(usesSiteSearch(after), spelling).toBe(true);
    }
    copy.source = copy.source!.replace(/import \{[^}]*\} from '[^']*site-search[^']*';/, '');
    expect(usesSiteSearch(after)).toBe(false);
    expect(files.get(copy.sourcePath!)).toContain(`from '../runtime/${SEARCH_HELPER_FILE}'`);
    expect(files.has(INDEX)).toBe(true);
  });

  it('compile without warnings, accessibility ones included', () => {
    const s = withSearch();
    const def = Object.values(s.components).find((d) => d.componentId === 'site.search')!;
    const source = generateProject(s).get(defFile(def))!;
    for (const generate of ['server', 'client'] as const) expect(compile(source, { filename: 'SiteSearch.svelte', generate, runes: true }).warnings.map((w) => w.code)).toEqual([]);
  });

  it('carry no editor code into the website', () => {
    expect(SEARCH_JS).not.toMatch(/data-so-|__so|siteorigin-bridge|builderTest/);
    // Nothing but the index it generates beside it.
    expect([...SEARCH_JS.matchAll(/import\(['"]([^'"]+)['"]\)|from ['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2])).toEqual([`./${SEARCH_INDEX_FILE}`]);
  });

  it('is found by searching Insert for "search"', () => {
    const entry = catalogueEntries('foundation').find((e) => e.componentId === 'site.search')!;
    expect(entry.name).toBe('Site search');
    expect(entry.tags).toContain('search');
    expect(catalogueEntries('foundation-alt').some((e) => e.componentId === 'site.search')).toBe(true);
  });
});

describe('site search index', () => {
  it('lists every page in page order with its address, title and the words its section shows', () => {
    let s = withSearch();
    // A section designed in the editor: the index reads none of Foundation's but its forms, tables and videos (the
    // Release gap test below).
    s = project(s, 1, 'Built for the Harbour Library reading room.');
    const index = buildSearchIndex(s);
    expect(index.map((e) => e.route)).toEqual(s.site.pageOrder.map((id) => s.pages[id].route));
    const entry = index.find((e) => e.route === '/portfolio/workshop-commission-1/')!;
    expect(entry.title).toBe('Workshop commission 1');
    expect(entry.text).toContain('Commission 1');
    expect(entry.text).toContain('Built for the Harbour Library reading room.');
    // One line per field, each on one line.
    expect(entry.text.split('\n')).toEqual(expect.arrayContaining(['Commission 1']));
  });

  it('lists the words the release’s text section shows', () => {
    const s = project(withSearch(), 1, 'Built for the Harbour Library reading room.', 'content.text');
    const entry = buildSearchIndex(s).find((e) => e.route === '/portfolio/workshop-commission-1/')!;
    expect(entry.text).toContain('Commission 1');
    expect(entry.text).toContain('Built for the Harbour Library reading room.');
  });

  it('leaves out the shared header and footer, and settings of the search itself', () => {
    const s = withSearch();
    const homeEntry = buildSearchIndex(s).find((e) => e.route === '/')!;
    const header = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(header).toContain('Test Studio');
    // The footer's text is on every page; the home page's index entry does not repeat it.
    const footerText = pageText(s, { ...s.pages[s.site.homePageId], nodes: s.site.shell.footer.nodes, rootIds: s.site.shell.footer.rootIds });
    for (const line of footerText.split('\n').filter((l) => l.length > 12)) expect(homeEntry.text).not.toContain(line);
    // The search section's heading is words on the page (#1341); its box's own label, buttons and messages are not.
    expect(homeEntry.text).toContain('Search this site');
    expect(homeEntry.text).not.toContain('Clear search');
    expect(homeEntry.text).not.toContain('Type a word or phrase');
  });

  it('keeps pages hidden from site search out, independently of search engines', () => {
    let s = withSearch();
    s = project(s, 1);
    s = project(s, 2);
    s = apply(s, [
      { type: 'page.update', pageId: 'pg_project1', searchHidden: true },
      { type: 'page.update', pageId: 'pg_project2', noindex: true }
    ]);
    expect(s.pages.pg_project1.seo.searchHidden).toBe(true);
    const routes = buildSearchIndex(s).map((e) => e.route);
    expect(routes).not.toContain('/portfolio/workshop-commission-1/');
    // Hidden from search engines is a different choice: visitors can still find it on the site.
    expect(routes).toContain('/portfolio/workshop-commission-2/');
    // Switched off, the setting is cleared rather than stored as false.
    s = apply(s, [{ type: 'page.update', pageId: 'pg_project1', searchHidden: false }]);
    expect(s.pages.pg_project1.seo.searchHidden).toBeUndefined();
    expect(JSON.stringify(s.pages.pg_project1.seo)).not.toContain('searchHidden');
    expect(buildSearchIndex(s).map((e) => e.route)).toContain('/portfolio/workshop-commission-1/');
  });

  it('never lists a draft, which is not a page of the website', () => {
    let s = withSearch();
    s = project(s, 1);
    s = apply(s, [{ type: 'page.update', pageId: 'pg_project1', draft: true }]);
    expect(buildSearchIndex(s).map((e) => e.route)).not.toContain('/portfolio/workshop-commission-1/');
    s = apply(s, [{ type: 'page.update', pageId: 'pg_project1', draft: false }]);
    expect(buildSearchIndex(s).map((e) => e.route)).toContain('/portfolio/workshop-commission-1/');
  });

  it('follows renamed and removed pages in the next generation, never listing an old address', async () => {
    let s = withSearch();
    for (const n of [1, 2, 3]) s = project(s, n);
    s = apply(s, [
      { type: 'page.update', pageId: 'pg_project1', title: 'Walnut bench for the Harbour Library', route: '/portfolio/harbour-bench/' },
      { type: 'page.remove', pageId: 'pg_project2' }
    ]);
    // An old address kept working for old links only sends visitors on.
    s.site.redirects = [{ from: '/portfolio/workshop-commission-1/', pageId: 'pg_project1' }];
    const files = generateProject(s);
    expect(files.get('src/routes/portfolio/workshop-commission-1/+page.svelte')).toContain('This page has moved');
    const { loadPages, searchPages } = await runtime(files.get(INDEX)!);
    const pages = await loadPages();
    const routes = pages.map((p) => p.route);
    expect(routes).toContain('/portfolio/harbour-bench/');
    expect(routes).not.toContain('/portfolio/workshop-commission-1/');
    expect(routes).not.toContain('/portfolio/workshop-commission-2/');
    expect(searchPages(pages, 'harbour bench').results.map((r) => r.route)).toEqual(['/portfolio/harbour-bench/']);
    // The search code the export ships finds the same.
    const shipped = await runtime(files.get(INDEX)!, files.get(HELPER)!);
    expect(shipped.searchPages(await shipped.loadPages(), 'harbour bench').total).toBe(1);
    // Only the page still called a workshop commission is found by that name.
    expect(searchPages(pages, 'workshop commission').results.map((r) => read(r.title))).toEqual(['Workshop commission 3']);
  });

  it('keeps text exactly as written, whatever characters it has', async () => {
    const tricky = 'Says </script><script>alert(1)</script> and ${window.x} and `ticks` & &amp; “quotes” \\ back slash';
    let s = withSearch();
    s = project(s, 1, tricky);
    s = apply(s, [{ type: 'page.update', pageId: 'pg_project1', seoTitle: 'Bench </script> ${x}', description: 'A walnut & oak bench.' }]);
    const files = generateProject(s);
    expect(files.get(INDEX)).not.toContain('</script>');
    const { loadPages } = await runtime(files.get(INDEX)!);
    const entry = (await loadPages()).find((p) => p.route === '/portfolio/workshop-commission-1/')!;
    expect(entry.text).toContain(tricky.replace(' ', ' '));
    expect(entry.alias).toBe('Bench </script> ${x}');
    expect(entry.description).toBe('A walnut & oak bench.');
  });

  it('is the same bytes for the same pages, and changes with them', () => {
    let s = withSearch();
    s = project(s, 1);
    const index = generateProject(s).get(INDEX)!;
    expect(generateProject(structuredClone(s)).get(INDEX)).toBe(index);
    expect(index).toContain('Workshop commission 1');
    s = apply(s, [{ type: 'page.update', pageId: 'pg_project1', title: 'Oak bench' }]);
    expect(generateProject(s).get(INDEX)).not.toBe(index);
  });

  it('follows the page order', () => {
    let s = withSearch();
    for (const n of [1, 2, 3]) s = project(s, n);
    s = apply(s, [{ type: 'page.reorder', pageIds: [s.site.homePageId, 'pg_project3', 'pg_project1', ...s.site.pageOrder.filter((id) => id !== s.site.homePageId && !['pg_project3', 'pg_project1'].includes(id))] }]);
    const routes = buildSearchIndex(s).map((e) => e.route);
    expect(routes.indexOf('/portfolio/workshop-commission-3/')).toBeLessThan(routes.indexOf('/portfolio/workshop-commission-1/'));
    expect(routes).toEqual(s.site.pageOrder.map((id) => s.pages[id].route));
  });

  it('leaves out text the author hid at every size, and keeps text hidden at some sizes', () => {
    let s = withSearch();
    s = project(s, 1, 'Shown everywhere.');
    s = project(s, 2, 'A secret kept on every screen.');
    s = project(s, 3, 'Hidden on phones only.');
    const section = (id: string) => s.pages[id].nodes[s.pages[id].rootIds[0]] as InstanceNode;
    section('pg_project2').overrides = { root: { base: { hidden: true } } };
    section('pg_project3').overrides = { root: { phone: { hidden: true } } };
    const text = (id: string) => buildSearchIndex(s).find((e) => e.route === s.pages[id].route)!.text;
    expect(text('pg_project1')).toContain('Shown everywhere.');
    expect(text('pg_project2')).not.toContain('secret');
    expect(text('pg_project3')).toContain('Hidden on phones only.');
    // Hidden at each size by that size's own setting.
    section('pg_project2').overrides = { root: { phone: { hidden: true }, tablet: { hidden: true }, desktop: { hidden: true } } };
    expect(text('pg_project2')).not.toContain('secret');
    // Anything a size or the wide range says about its display may show it again: its text stays searchable.
    const shownSomewhere: ResponsiveStyles[] = [
      { base: { hidden: true }, desktop: { hidden: false } },
      { base: { hidden: true }, desktop: { layout: 'stack' } },
      { base: { hidden: true }, phone: { customCss: 'display: none;' } },
      { base: { hidden: true, columnSpan: 2, customCss: 'display: block' } }
    ];
    for (const root of shownSomewhere) {
      section('pg_project2').overrides = { root };
      expect(text('pg_project2'), JSON.stringify(root)).toContain('A secret kept on every screen.');
    }
    // A hidden container hides what is inside it.
    const page = s.pages.pg_project1;
    page.nodes.n_box = { id: 'n_box', kind: 'element', tag: 'div', children: ['n_tucked'], styles: { base: { hidden: true } } } as GraphNode;
    page.nodes.n_tucked = { id: 'n_tucked', kind: 'text', tag: 'p', text: 'Tucked away inside.' } as GraphNode;
    page.rootIds.push('n_box');
    expect(text('pg_project1')).not.toContain('Tucked away');
    (page.nodes.n_box as GraphNode).styles = { base: { hidden: true }, tablet: { customCss: 'display: block;' } };
    expect(text('pg_project1')).toContain('Tucked away inside.');
  });

  it('names a page with no title by its browser title or address, and survives hand-edited values', () => {
    let s = withSearch();
    s = project(s, 1);
    s = project(s, 2);
    s = project(s, 3);
    s.pages.pg_project1.title = '';
    s.pages.pg_project1.seo.title = 'Bench';
    s.pages.pg_project2.title = '';
    (s.pages.pg_project2.seo as Record<string, unknown>).title = 123;
    (s.pages.pg_project2.seo as Record<string, unknown>).description = { text: 'not text' };
    (s.pages.pg_project3.seo as Record<string, unknown>).searchHidden = 'true';
    const index = buildSearchIndex(s);
    expect(index.find((e) => e.route === '/portfolio/workshop-commission-1/')).toMatchObject({ title: 'Bench' });
    expect(index.find((e) => e.route === '/portfolio/workshop-commission-1/')!.alias).toBeUndefined();
    expect(index.find((e) => e.route === '/portfolio/workshop-commission-2/')).toMatchObject({ title: '/portfolio/workshop-commission-2/' });
    // A switch the Inspector shows as on hides the page, whatever the document wrote.
    expect(index.some((e) => e.route === '/portfolio/workshop-commission-3/')).toBe(false);
    expect(() => generateProject(s)).not.toThrow();
  });

  it('lists every word Foundation’s sections show, the ones their canvas cannot type over included (#1351)', async () => {
    let s = withSearch();
    s = apply(
      s,
      ['features.bento', 'pricing.toggle', 'pricing.compare', 'data.table', 'content.media'].map((componentId) => ({
        type: 'node.insert',
        owner: home(s),
        componentId,
        ...(componentId === 'content.media' ? { props: { points: [{ id: 'p1', text: 'Cinnabar freight acoustic calibration' }] } } : {})
      })) as EditOperation[]
    );
    const index = generateProject(s).get(INDEX)!;
    const { loadPages, searchPages } = await runtime(index);
    const pages = await loadPages();
    const homeText = pages.find((e) => e.route === '/')!.text;
    for (const words of [
      // The bento's featured card, an object rather than a list item.
      'One designer, start to finish',
      // Both of the billing switch's prices and notes: the page ships both, one shown at a time.
      '$29',
      'per year, billed once',
      // The comparison's plans, with their prices.
      'Consultation',
      '$350',
      'One session',
      // The table's column headings and cells.
      'Start time',
      'Wheel throwing',
      // Content with image's points, which its canvas marks.
      'Cinnabar freight acoustic calibration'
    ])
      expect(homeText).toContain(words);
    expect(searchPages(pages, 'wheel throwing').results.map((r) => r.route)).toContain('/');
    // In the order the page shows them: a table's heading over its cells, every named plan of the comparison.
    expect(homeText.indexOf('Workshop timetable')).toBeLessThan(homeText.indexOf('Wheel throwing'));
    expect(homeText).toContain('Full service');
    expect(homeText).toContain('Quoted after the visit');
    // A publication carries the sections with the editor's markers taken out of their code: they show the same.
    const { withoutCodeMarkers } = await import('../../src/main/codecheck');
    const published = structuredClone(s);
    for (const def of Object.values(published.components)) if (def.kind === 'code' && typeof def.source === 'string') def.source = await withoutCodeMarkers(def.source);
    expect(buildSearchIndex(published).find((e) => e.route === '/')!.text).toBe(homeText);
    // A button that goes nowhere is no part of the site.
    expect(homeText.split('\n')).not.toContain('Book a session');
    // Prices the comparison's placement hides at every size are not found; its plans' names still are.
    const compare = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[(n as InstanceNode).definitionId]?.componentId === 'pricing.compare')!;
    const noPrices = apply(s, [{ type: 'node.setStyle', owner: home(s), nodeId: compare.id, partId: 'price', scope: 'base', property: 'hidden', value: true }]);
    const priced = pageText(noPrices, noPrices.pages[noPrices.site.homePageId]).split('\n');
    expect(priced).toContain('Consultation');
    expect(priced).not.toContain('$350');
  });

  it('keeps the words of a design around the page’s own content in the order they show (#1351)', () => {
    let s = withSearch();
    const spec: DesignSpec = {
      componentId: 'project.wrap',
      name: 'Wrap',
      properties: { before: P.str('Before', 'Design before'), after: P.str('After', 'Design after') },
      parts: { root: { nodeId: 'root', label: 'Wrap' } },
      slots: { body: { label: 'Body' } },
      build: (b) => b.el('root', 'section', { name: 'Wrap' }, [b.text('before', 'p', prop('before')), b.slot('body', 'body'), b.text('after', 'p', prop('after'))])
    } as DesignSpec;
    const def = foundationDesign(spec);
    projectDesign((s = structuredClone(s)), spec);
    const r = applyOperations(s, [{ type: 'node.insert', owner: home(s), definitionId: def.id } as EditOperation]);
    s = apply(r.state, [{ type: 'node.insert', owner: home(s), parentId: r.results[0].nodeId, slot: 'body', primitive: 'paragraph', text: 'Page slot words' } as EditOperation]);
    const text = pageText(s, s.pages[s.site.homePageId]);
    expect(text).toContain('Page slot words');
    const at = ['Design before', 'Page slot words', 'Design after'].map((w) => text.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('reads a table of any size (#1351)', () => {
    const base = withSearch();
    const s = apply(base, [{ type: 'node.insert', owner: home(base), componentId: 'data.table' } as EditOperation]);
    const page = s.pages[s.site.homePageId];
    const table = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.components[(n as InstanceNode).definitionId]?.componentId === 'data.table') as InstanceNode;
    const columns = Array.from({ length: 12 }, (_, c) => ({ id: `c${c}`, label: `Column ${c}` }));
    table.props.table = { columns, rows: Array.from({ length: 15000 }, (_, r) => ({ id: `r${r}`, cells: Object.fromEntries(columns.map((c) => [c.id, `Cell ${r}-${c.id}`])) })) };
    const text = pageText(s, page);
    expect(text).toContain('Cell 14999-c11');
    expect(text.indexOf('Column 0')).toBeLessThan(text.indexOf('Cell 0-c0'));
  });
});

describe('site search as the website runs it', () => {
  /** 150 project pages, as in the issue, each saying its number only at the end of a long text. */
  async function portfolio() {
    let s = withSearch();
    for (let n = 1; n <= 150; n++) s = project(s, n);
    const index = generateProject(s).get(INDEX)!;
    const rt = await runtime(index);
    return { ...rt, pages: await rt.loadPages() };
  }

  it('finds one project among 150 by its name, best match first, with a passage that tells it apart', async () => {
    const { pages, searchPages } = await portfolio();
    const found = searchPages(pages, 'Workshop commission 105');
    expect(found.results[0].route).toBe('/portfolio/workshop-commission-105/');
    expect(read(found.results[0].title)).toBe('Workshop commission 105');
    expect(marked(found.results[0].title)).toEqual(['Workshop commission 105']);
    // The words found deep in a long text show in context, not the start of the page.
    const deep = searchPages(pages, 'commissioned as piece 105');
    expect(deep.total).toBe(1);
    expect(read(deep.results[0].excerpt)).toMatch(/^….*Commissioned as piece 105\.$/);
    expect(marked(deep.results[0].excerpt).join(' ')).toBe('Commissioned as piece 105');
    expect(read(deep.results[0].excerpt).length).toBeLessThanOrEqual(200);
  });

  it('counts every match and shows the first 20', async () => {
    const { pages, searchPages } = await portfolio();
    const found = searchPages(pages, 'workshop');
    expect(found.total).toBe(150);
    expect(found.results).toHaveLength(20);
    // Equal matches keep the site's page order.
    expect(found.results[0].route).toBe('/portfolio/workshop-commission-1/');
  });

  it('needs every word, in any order and case, and nothing for an empty or unmatched search', async () => {
    const { pages, searchPages } = await portfolio();
    expect(searchPages(pages, '  ').total).toBe(0);
    expect(searchPages(pages, '').results).toEqual([]);
    expect(searchPages(pages, 'zeppelin').total).toBe(0);
    expect(searchPages(pages, 'COMMISSION oak 42').results.map((r) => r.route)).toContain('/portfolio/workshop-commission-42/');
    expect(searchPages(pages, 'commission zeppelin').total).toBe(0);
  });

  it('ranks a page named by the search above pages that only mention it', async () => {
    const { searchPages } = await runtime('export default [];');
    const pages = [
      { route: '/journal/', title: 'Journal', text: 'We finished the walnut table last spring.' },
      { route: '/walnut-table/', title: 'Walnut table', text: 'Solid walnut.' },
      { route: '/tables/', title: 'Tables', alias: 'Walnut table range', text: 'Every table we make.' }
    ];
    expect(searchPages(pages, 'walnut table').results.map((r) => r.route)).toEqual(['/walnut-table/', '/tables/', '/journal/']);
  });

  it('ignores accents and marks the words as written', async () => {
    const { searchPages } = await runtime('export default [];');
    const pages = [{ route: '/menu/', title: 'Café menu', description: 'Crème brûlée and Smørrebrød.', text: 'Our naïve cafe serves crème brûlée every day.' }];
    expect(searchPages(pages, 'cafe').results.map((r) => r.route)).toEqual(['/menu/']);
    expect(marked(searchPages(pages, 'cafe').results[0].title)).toEqual(['Café']);
    const found = searchPages(pages, 'CREME brulee');
    expect(marked(found.results[0].excerpt)).toEqual(['crème brûlée']);
    // Decomposed accents (e and a combining mark) fold the same way.
    const decomposed = [{ route: '/d/', title: 'Crème', text: '' }];
    expect(marked(searchPages(decomposed, 'creme').results[0].title)).toEqual(['Crème']);
  });

  it('tells Japanese kana apart by voicing marks, however they are spelled', async () => {
    const { searchPages } = await runtime('export default [];');
    const kaki = 'かき';
    const kagi = 'かぎ';
    const kagiDecomposed = 'かぎ';
    const pages = [
      { route: '/kaki/', title: kaki, text: '' },
      { route: '/kagi/', title: kagi, text: '' }
    ];
    const routes = (q: string) => searchPages(pages, q).results.map((r) => r.route);
    expect(routes(kagi)).toEqual(['/kagi/']);
    expect(routes(kagiDecomposed)).toEqual(['/kagi/']);
    expect(routes(kaki)).toEqual(['/kaki/']);
    expect(marked(searchPages(pages, kagiDecomposed).results[0].title)).toEqual([kagi]);
    const decomposed = [{ route: '/d/', title: kagiDecomposed, text: '' }];
    expect(searchPages(decomposed, kagi).total).toBe(1);
    expect(marked(searchPages(decomposed, kagi).results[0].title)).toEqual([kagiDecomposed]);
    // Half-width katakana with a separate voicing mark matches the full-width letter, and is marked whole.
    expect(searchPages([{ route: '/h/', title: 'ﾊﾞ', text: '' }], 'バ').total).toBe(1);
    expect(marked(searchPages([{ route: '/h/', title: '前ﾊﾞ後', text: '' }], 'バ').results[0].title)).toEqual(['ﾊﾞ']);
    // Text after many composed marks is found, and its passage starts at the right place.
    const long = [{ route: '/l/', title: 'Long', text: 'き\u3099'.repeat(240) + ' needle here' }];
    expect(read(searchPages(long, 'needle').results[0].excerpt)).toContain('needle here');
    // A stray accent between a kana and its voicing mark, and a kana that folds to two letters, still compose.
    expect(searchPages([{ route: '/a/', title: 'かき\u0301\u3099', text: '' }], kagi).total).toBe(1);
    expect(searchPages([{ route: '/a/', title: '\u30ff\u3099', text: '' }], '\u30b3\u30c9').total).toBe(1);
    // Hangul written as separate jamo still matches the syllable.
    expect(searchPages([{ route: '/g/', title: '\uac00', text: '' }], '\u1100\u1161').total).toBe(1);
  });

  it('marks a word with its accents, every place it overlaps itself, and in text that expands when folded', async () => {
    const { searchPages } = await runtime('export default [];');
    const title = (t: string, q: string) => marked(searchPages([{ route: '/a/', title: t, text: '' }], q).results[0].title);
    expect(title('Cafe\u0301 menu', 'cafe')).toEqual(['Cafe\u0301']);
    expect(title('Banana', 'ana')).toEqual(['anana']);
    expect(title('\ufb01ne café', 'cafe')).toEqual(['café']);
    expect(title('👍🏽 guide', '👍')).toEqual(['👍🏽']);
    expect(searchPages([{ route: '/a/', title: 'ΟΔΟΣ', text: '' }], 'οδός').total).toBe(1);
    expect(searchPages([{ route: '/a/', title: 'οδός', text: '' }], 'ΟΔΟΣ').total).toBe(1);
  });

  it('never splits a character at the edge of a passage, and marks no ellipsis', async () => {
    const { searchPages } = await runtime('export default [];');
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const found = searchPages([{ route: '/a/', title: 'Guide', text: 'x'.repeat(179) + '😀tail' }], 'guide');
    expect(read(found.results[0].excerpt)).not.toMatch(lone);
    expect(read(found.results[0].excerpt).endsWith('…')).toBe(true);
    // A match deep in text that folds unevenly is still the one shown.
    const deep = searchPages([{ route: '/a/', title: 'A', text: 'Ça ﬁt é. '.repeat(80) + 'The needle is here.' }], 'needle');
    expect(marked(deep.results[0].excerpt)).toEqual(['needle']);
    expect(read(deep.results[0].excerpt)).toMatch(/needle is here\.$/);
    // Writing without spaces keeps the words before the match, so two pages stay apart.
    const kyoto = searchPages(
      [
        { route: '/a/', title: 'A', text: '東'.repeat(70) + '京都の工房' },
        { route: '/b/', title: 'B', text: '西'.repeat(70) + '京都の工房' }
      ],
      '京都'
    );
    const [a, b] = kyoto.results.map((r) => r.excerpt);
    expect(read(a)).not.toBe(read(b));
    expect(a[0]).toEqual({ text: '…', mark: false });
    expect(marked(a)).toEqual(['京都']);
  });

  it('needs every word somewhere on the page, and puts a phrase before scattered words', async () => {
    const { searchPages } = await runtime('export default [];');
    const pages = [
      { route: '/scattered/', title: 'Tables', text: 'A table made of walnut.' },
      { route: '/phrase/', title: 'Furniture', text: 'Our walnut table range.' },
      { route: '/split/', title: 'Oak bench', text: 'Built in Leeds.' },
      { route: '/named/', title: 'Journal', alias: 'Walnut', text: '' },
      { route: '/walnut/', title: 'Walnut', text: '' }
    ];
    expect(searchPages(pages, 'walnut table').results.map((r) => r.route)).toEqual(['/phrase/', '/scattered/']);
    expect(searchPages(pages, 'leeds bench').results.map((r) => r.route)).toEqual(['/split/']);
    // The title a visitor reads outranks a browser title that says the same.
    expect(searchPages(pages, 'walnut').results.slice(0, 2).map((r) => r.route)).toEqual(['/walnut/', '/named/']);
    expect(searchPages(pages, '\u0301').total).toBe(0);
  });

  it('shows the description, or how the page starts, when only the title matched', async () => {
    const { searchPages } = await runtime('export default [];');
    expect(read(searchPages([{ route: '/a/', title: 'Kitchens', description: 'Fitted in oak.', text: 'Our work.' }], 'kitchens').results[0].excerpt)).toBe('Fitted in oak.');
    expect(read(searchPages([{ route: '/a/', title: 'Kitchens', description: 'Fitted kitchens in oak.', text: 'Our work.' }], 'kitchens').results[0].excerpt)).toBe('Fitted kitchens in oak.');
    expect(read(searchPages([{ route: '/a/', title: 'Kitchens', text: 'Our work.' }], 'kitchens').results[0].excerpt)).toBe('Our work.');
    expect(searchPages([{ route: '/a/', title: 'Kitchens', text: '' }], 'kitchens').results[0].excerpt).toEqual([]);
  });
});

describe('records in site search', () => {
  const FIELDS = {
    price: { type: 'number', label: 'Guide price', default: 0 },
    region: { type: 'string', label: 'Region', default: '' },
    status: { type: 'enum', label: 'Sale', default: 'open', options: [{ value: 'open', label: 'Open market' }, { value: 'offmarket', label: 'Private Sale' }] },
    reserve: { type: 'string', label: 'Reserve', default: '' }
  };
  /** A Properties collection of records with two listings: Son Vida, in the category Mallorca and tagged Coastal, and a cottage with no region. */
  function listings(): ProjectState {
    const s = apply(withSearch(), [
      { type: 'collection.create', collectionId: 'properties', name: 'Properties', kind: 'structured', hasBody: true, pages: { detail: true, archive: true }, route: '/properties/' } as EditOperation,
      { type: 'collection.update', collectionId: 'properties', fields: structuredClone(FIELDS) as never } as EditOperation,
      { type: 'collection.createTerm', collectionId: 'properties', taxonomyId: 'categories', label: 'Mallorca', termId: 'mallorca' },
      { type: 'collection.createTerm', collectionId: 'properties', taxonomyId: 'tags', label: 'Coastal', termId: 'coastal' },
      { type: 'entry.create', collectionId: 'properties', entryId: 'en_sonvida', title: 'Son Vida estate', draft: false, publishedAt: '2026-10-20', excerpt: 'A finca above Palma.', body: ['Terraced gardens.'], terms: { categories: ['mallorca'], tags: ['coastal'] }, values: { price: 8400000, region: 'Serra de Tramuntana', status: 'offmarket', reserve: 'Quietly 7,900,000' } } as EditOperation,
      { type: 'entry.create', collectionId: 'properties', entryId: 'en_lighthouse', title: 'Lighthouse cottage', draft: false, publishedAt: '2026-10-19', excerpt: 'A keeper\u2019s cottage on the Lizard.', values: { price: 650000 } } as EditOperation
    ]);
    // The author takes the reserve off the listing's page.
    const t = s.collections.properties.settings.template;
    const reserve = Object.values(t.nodes).find((n) => n.name === 'Reserve')!;
    return apply(s, [{ type: 'node.remove', owner: { kind: 'template', id: 'properties' }, nodeId: reserve.id } as EditOperation]);
  }
  const routes = (found: Found) => found.results.map((r) => r.route);

  it('finds a record by the custom fields and categories its page shows, as the page writes them', async () => {
    const s = listings();
    const { loadPages, searchPages } = await runtime(generateProject(s).get(INDEX)!);
    const pages = await loadPages();
    for (const q of ['8,400,000', 'Private Sale', 'Mallorca', 'Tramuntana', 'Guide price 8,400,000']) expect(routes(searchPages(pages, q)), q).toEqual(['/properties/son-vida-estate/']);
    expect(routes(searchPages(pages, '650,000'))).toEqual(['/properties/lighthouse-cottage/']);
    // A row whose condition does not hold leaves its own words off the page too: the cottage has no region.
    expect(routes(searchPages(pages, 'Region')).filter((r) => r.startsWith('/properties/'))).toEqual(['/properties/son-vida-estate/']);
    // Its text and excerpt still come first.
    const entry = buildSearchIndex(s).find((e) => e.route === '/properties/son-vida-estate/')!;
    expect(entry.text.split('\n').slice(0, 2)).toEqual(['A finca above Palma.', 'Terraced gardens.']);
    expect(entry.text).toContain('Private Sale');
    // A choice is found by its label, never by the value it stores.
    expect(searchPages(pages, 'offmarket').total).toBe(0);
  });

  it('never finds a record by what its page leaves off, or by the records it links to', async () => {
    const s = listings();
    const { loadPages, searchPages } = await runtime(generateProject(s).get(INDEX)!);
    const pages = await loadPages();
    // A field the layout no longer shows, and a grouping it never placed.
    expect(searchPages(pages, '7,900,000').total).toBe(0);
    expect(searchPages(pages, 'Coastal').total).toBe(0);
    // The links to the entries before and after it name the other record, which alone is found by its title.
    const files = generateProject(s);
    expect(files.get('src/routes/properties/son-vida-estate/+page.svelte')).toContain('Lighthouse cottage');
    expect(files.get('src/routes/properties/lighthouse-cottage/+page.svelte')).toContain('Son Vida estate');
    expect(routes(searchPages(pages, 'Lighthouse'))).toEqual(['/properties/lighthouse-cottage/']);
    expect(routes(searchPages(pages, 'Son Vida'))).toEqual(['/properties/son-vida-estate/']);
    // A field whose condition does not hold for the record shows nothing: the cottage is in no category.
    expect(routes(searchPages(pages, 'Mallorca'))).toEqual(['/properties/son-vida-estate/']);
    // The title, excerpt and text are the record's own fields, listed once.
    const entry = buildSearchIndex(s).find((e) => e.route === '/properties/son-vida-estate/')!;
    expect(entry.title).toBe('Son Vida estate');
    expect(entry.text.split('\n').filter((l) => l === 'A finca above Palma.')).toHaveLength(1);
    expect(entry.text.split('\n').filter((l) => l.includes('Terraced gardens.'))).toHaveLength(1);
    expect(entry.text).not.toContain('Son Vida estate');
  });

  it('finds a record by a grouping once its layout places it', async () => {
    const s = listings();
    const t = s.collections.properties.settings.template;
    const title = Object.values(t.nodes).find((n) => n.kind === 'text' && JSON.stringify(n.text) === '{"$entry":"title"}')!;
    const owner = { kind: 'template' as const, id: 'properties' };
    const parentId = Object.values(t.nodes).find((n) => (n as { children?: string[] }).children?.includes(title.id))!.id;
    const tagged = apply(s, [
      { type: 'node.insert', owner, parentId, newNodeId: 'n_tags', primitive: 'paragraph', text: '' },
      { type: 'node.setBinding', owner, nodeId: 'n_tags', field: 'text', binding: { $entry: 'terms.tags' } }
    ] as EditOperation[]);
    expect(JSON.stringify(tagged.collections.properties.settings.template.nodes.n_tags)).toContain('terms.tags');
    const { loadPages, searchPages } = await runtime(generateProject(tagged).get(INDEX)!);
    expect(routes(searchPages(await loadPages(), 'Coastal'))).toEqual(['/properties/son-vida-estate/']);
  });

  it('follows a renamed category in a cached run', () => {
    const s = listings();
    const renamed = apply(s, [{ type: 'collection.renameTerm', collectionId: 'properties', taxonomyId: 'categories', termId: 'mallorca', label: 'Majorca', newTermId: 'mallorca' } as EditOperation]);
    const cache = new GenerationCache();
    expect(generateProject(s, {}, cache).get(INDEX)).toContain('Mallorca');
    const warm = generateProject(renamed, {}, cache).get(INDEX)!;
    expect(warm).toEqual(generateProject(renamed).get(INDEX));
    expect(warm).toContain('Majorca');
    expect(warm).not.toContain('Mallorca');
  });
});

describe('Hide from site search setting', () => {
  it('is a page field held edits read back', () => {
    const start = fresh();
    const s = apply(start, [{ type: 'page.update', pageId: start.site.homePageId, searchHidden: true }]);
    const read = readField(s, { type: 'page.update', pageId: s.site.homePageId, searchHidden: false });
    expect(read).toEqual({ found: true, value: { searchHidden: true } });
    expect(readField(start, { type: 'page.update', pageId: start.site.homePageId, searchHidden: true })).toEqual({ found: true, value: { searchHidden: undefined } });
  });

  it('is named apart from search engines when the assistant changes it', () => {
    const start = fresh();
    const ops: EditOperation[] = [{ type: 'page.update', pageId: start.site.homePageId, searchHidden: true, noindex: true }];
    const r = applyOperations(start, ops);
    expect(describeOps(ops, start, r.state, r.results).map((c) => c.label)).toEqual(['Changed the search visibility and site search visibility of page Home']);
  });
});
