/**
 * Site search (#246): the index of the pages the generator writes with the site, and the search code the exported
 * site runs on it, imported here exactly as generated.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { catalogueEntries } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE, SEARCH_JS, buildSearchIndex, pageText, usesSiteSearch, type SearchEntry } from '@generator/search';
import { readField } from '../../src/renderer/src/lib/held';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState } from '@shared/types';

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

/** A project page with a text section, its body ending with `tail` after a long run of other words. */
function project(s: ProjectState, n: number, tail = `Commissioned as piece ${n}.`): ProjectState {
  const id = `pg_project${n}`;
  const filler = Array.from({ length: 60 }, (_, i) => `Oak and linen panel ${i} with a hand-rubbed finish.`).join(' ');
  return apply(s, [
    { type: 'page.create', pageId: id, title: `Workshop commission ${n}`, route: `/portfolio/workshop-commission-${n}/` },
    { type: 'node.insert', owner: { kind: 'page', id }, componentId: 'content.text', props: { heading: `Commission ${n}`, body: `${filler}\n\n${tail}` } }
  ]);
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The search code and an index as the exported site has them, imported as modules. */
async function runtime(index: string): Promise<{ loadPages: () => Promise<SearchEntry[]>; searchPages: (pages: unknown, query: string, limit?: number) => Found; searchWords: (q: string) => string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'so-search-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, SEARCH_HELPER_FILE), SEARCH_JS);
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
    expect(clean.get(defFile(def))).toContain(`from '../runtime/${SEARCH_HELPER_FILE}'`);
  });

  it('keep working for a copy of the component made unique', () => {
    const s = withSearch();
    const node = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'site.search') as InstanceNode;
    const after = apply(s, [{ type: 'component.makeUnique', owner: home(s), nodeId: node.id, name: 'Project finder' }]);
    const copy = Object.values(after.components).find((d) => d.owner === 'project' && d.kind === 'code')!;
    expect(copy.sourcePath).toMatch(/^src\/lib\/siteorigin\/custom\//);
    const files = generateProject(after);
    expect(files.get(copy.sourcePath!)).toContain(`from '../runtime/${SEARCH_HELPER_FILE}'`);
    expect(files.has(INDEX)).toBe(true);
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
  it('lists every page in page order with its address, title and the words it shows', () => {
    let s = withSearch();
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

  it('leaves out the shared header and footer, and settings of the search itself', () => {
    const s = withSearch();
    const homeEntry = buildSearchIndex(s).find((e) => e.route === '/')!;
    const header = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(header).toContain('Test Studio');
    // The footer's text is on every page; the home page's index entry does not repeat it.
    const footerText = pageText(s, { ...s.pages[s.site.homePageId], nodes: s.site.shell.footer.nodes, rootIds: s.site.shell.footer.rootIds });
    for (const line of footerText.split('\n').filter((l) => l.length > 12)) expect(homeEntry.text).not.toContain(line);
    expect(homeEntry.text).not.toContain('Search this site');
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

  it('is the same bytes for the same pages', () => {
    let s = withSearch();
    s = project(s, 1);
    expect(generateProject(s).get(INDEX)).toBe(generateProject(structuredClone(s)).get(INDEX));
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

  it('shows the description, or how the page starts, when only the title matched', async () => {
    const { searchPages } = await runtime('export default [];');
    expect(read(searchPages([{ route: '/a/', title: 'Kitchens', description: 'Fitted kitchens in oak.', text: 'Our work.' }], 'kitchens').results[0].excerpt)).toBe('Fitted kitchens in oak.');
    expect(read(searchPages([{ route: '/a/', title: 'Kitchens', text: 'Our work.' }], 'kitchens').results[0].excerpt)).toBe('Our work.');
    expect(searchPages([{ route: '/a/', title: 'Kitchens', text: '' }], 'kitchens').results[0].excerpt).toEqual([]);
  });
});

describe('Hide from site search setting', () => {
  it('is a page field held edits read back', () => {
    const start = fresh();
    const s = apply(start, [{ type: 'page.update', pageId: start.site.homePageId, searchHidden: true }]);
    const read = readField(s, { type: 'page.update', pageId: s.site.homePageId, searchHidden: false });
    expect(read).toEqual({ found: true, value: { searchHidden: true } });
  });
});
