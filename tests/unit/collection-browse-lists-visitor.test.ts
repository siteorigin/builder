/**
 * Visitor browsing beyond the ready-made index (#1730), in a real headless browser, as the static site ships it:
 * rendered on the server, hydrated without a mismatch, then used. Home holds two listings of one collection that each
 * browse only the entries they show and never each other's; the index has a design of its own, whose loop over the
 * page's entries lists the entries that match from every page of the index.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, generateProject, pageFile, publishedState } from '@generator/index';
import { BROWSE_COMPONENT_FILE } from '@generator/collection-browse';
import { archiveFile } from '@generator/archive';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://homes.test';
const GEN = '\0gen:';
const INDEX = archiveFile('/homes/');

/**
 * Seven published homes, three to a page of an index with a design of its own, filed by region, with search, a region
 * and a garden filter and two sorts; on Home a Team grid of the first three by title (Café Corner, Cliff Cottage, Dune
 * House, all North Coast), and a loop over the dearest but one and the next two (Dune House, Café Corner, Orchard Farm).
 */
function site(): ProjectState {
  let s = createStarterState('business', 'Coast Realty', false);
  const apply = (...ops: EditOperation[]) => {
    const r = applyOperations(s, ops);
    s = r.state;
    return r.results[0]?.nodeId as string;
  };
  apply({
    type: 'collection.create',
    collectionId: 'homes',
    name: 'Homes',
    kind: 'structured',
    route: '/homes/',
    pageSize: 3,
    fields: { price: { type: 'number', label: 'Price' }, garden: { type: 'boolean', label: 'Garden' }, agent: { type: 'string', label: 'Agent' } },
    taxonomies: { region: { label: 'Region', terms: { north: { label: 'North Coast' }, south: { label: 'South Bay' } } } },
    browse: { search: true, filters: ['terms.region', 'field.garden'], sort: ['field.price', 'title'] }
  } as EditOperation);
  const homes: Array<[string, string, number, boolean, string]> = [
    ['en_cliff', 'Cliff Cottage', 450000, true, 'north'],
    ['en_harbour', 'Harbour Loft', 320000, false, 'south'],
    ['en_dune', 'Dune House', 780000, true, 'north'],
    ['en_orchard', 'Orchard Farm', 510000, true, 'south'],
    ['en_quay', 'Quay Flat', 210000, false, 'south'],
    ['en_cafe', 'Café Corner', 610000, false, 'north'],
    ['en_reef', 'Reef View', 990000, true, 'north']
  ];
  homes.forEach(([entryId, title, price, garden, region], i) => apply({ type: 'entry.create', collectionId: 'homes', entryId, title, publishedAt: `2026-0${i + 1}-01`, draft: false, values: { price, garden, agent: `${title} agent` }, terms: { region: [region] } } as EditOperation));
  apply({ type: 'collection.update', collectionId: 'homes', archiveTemplate: 'start' } as EditOperation);
  const home: OwnerRef = { kind: 'page', id: s.site.homePageId };
  const grid = apply({ type: 'node.insert', owner: home, parentId: null, componentId: 'team.grid' });
  apply({ type: 'instance.setListSource', owner: home, nodeId: grid, prop: 'people', source: { query: { collectionId: 'homes', sort: [{ field: 'title' }], limit: 3 }, fields: { name: 'title', role: 'field.agent' }, browse: true } });
  const box = apply({ type: 'node.insert', owner: home, parentId: null, primitive: 'container' });
  const dearest = { collectionId: 'homes', sort: [{ field: 'field.price', direction: 'desc' }], offset: 1, limit: 3 };
  const loop = apply({ type: 'node.insert', owner: home, parentId: box, primitive: 'repeat', query: dearest });
  const heading = apply({ type: 'node.insert', owner: home, parentId: loop, primitive: 'heading', text: 'Title' });
  apply({ type: 'node.setBinding', owner: home, nodeId: heading, field: 'text', binding: { $item: 'title' } }, { type: 'node.setRepeatSource', owner: home, nodeId: loop, source: { $query: dearest, browse: true } });
  return s;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A page rendered on the server, head and body, as the static site ships it. */
async function serverRender(files: Map<string, string>, route: string): Promise<{ head: string; body: string }> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'collection-browse-lists-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};\n');
  for (const [path, source] of files) {
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
  const Page = (await import(/* @vite-ignore */ join(dir, `${route}.js`))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} });
}

/** A page compiled for the browser, the collection's index of entries (when the page loads it) in a chunk of its own. */
async function bundle(files: Map<string, string>, route: string): Promise<Map<string, string>> {
  const all = new Map([
    ...files,
    ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";'],
    ['app/navigation.js', 'export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};']
  ]);
  const entry = `import { hydrate } from 'svelte';\nimport Page from ${JSON.stringify(GEN + route)};\nwindow.site = hydrate(Page, { target: document.getElementById('app'), props: {} });`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'generated-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/navigation') return GEN + id.slice(1) + '.js';
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (all.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = all.get(path);
          if (source === undefined) throw new Error(`Not generated: ${path}`);
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: { app: '\0entry' }, output: { format: 'esm', entryFileNames: '[name].js', chunkFileNames: (c) => (c.facadeModuleId?.endsWith('collections/homes.js') ? 'homes-index.js' : '[name].js') } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunks = new Map<string, string>();
  for (const o of (Array.isArray(out) ? out[0] : out).output) if (o.type === 'chunk') chunks.set(o.fileName, o.code);
  return chunks;
}

describe.skipIf(!browserInstalled)('listings and a designed index for a visitor', () => {
  let browser: Browser;
  let css: string;
  const built = new Map<string, { ssr: { head: string; body: string }; chunks: Map<string, string> }>();
  let homeRoute: string;

  beforeAll(async () => {
    const s = site();
    const files = generateProject(publishedState(s));
    homeRoute = pageFile(s.pages[s.site.homePageId]);
    const scoped = [homeRoute, INDEX, `${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`, ...[...files.keys()].filter((f) => f.startsWith('src/lib/siteorigin/components/'))]
      .filter((f) => f.endsWith('.svelte'))
      .map((f) => compile(files.get(f)!, { filename: f, generate: 'client', runes: true, css: 'external' }).css?.code ?? '');
    css = [...['tokens', 'theme', 'components', 'site'].map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? ''), ...scoped].join('\n');
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    for (const route of [homeRoute, INDEX]) built.set(route, { ssr: await serverRender(files, route), chunks: await bundle(files, route) });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** A page, hydrated; `requests` is every file it asked for. */
  async function open(route: string): Promise<{ page: Page; problems: string[]; requests: string[] }> {
    const { ssr, chunks } = built.get(route)!;
    const page = await browser.newPage();
    const problems: string[] = [];
    const requests: string[] = [];
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const html = `<!doctype html><html lang="en" class="so-js"><head><meta charset="utf-8">${ssr.head}<style>${css}</style></head><body><div id="app">${ssr.body}</div><script type="module" src="/app.js"></script></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      requests.push(url.pathname);
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      const name = url.pathname.slice(1);
      if (chunks.has(name)) return route.fulfill({ contentType: 'text/javascript', body: chunks.get(name)! });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`${ORIGIN}/`);
    await expect.poll(() => page.locator('.so-browse fieldset').first().isDisabled()).toBe(false);
    return { page, problems, requests };
  }

  it('browses two listings on one page apart, each over only the entries it shows', async () => {
    const { page, problems, requests } = await open(homeRoute);
    try {
      const forms = page.getByRole('search', { name: 'Browse Homes' });
      await expect(forms.count()).resolves.toBe(2);
      const [team, dearest] = [forms.nth(0), forms.nth(1)];
      // What each listing shows: the elements its controls are placed above.
      const shown = (n: number, selector: string) => page.evaluate(`[...document.querySelectorAll('.so-browse')[${n}].parentElement.nextElementSibling.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`);
      const people = () => shown(0, '.team__name');
      const loop = () => shown(1, 'h2');
      await expect(people()).resolves.toEqual(['Café Corner', 'Cliff Cottage', 'Dune House']);
      await expect(loop()).resolves.toEqual(['Dune House', 'Café Corner', 'Orchard Farm']);
      // The team's own search finds only its own: Orchard Farm is the other listing's.
      await team.getByRole('searchbox', { name: 'Search' }).fill('orchard');
      await expect.poll(() => team.getByRole('status').innerText()).toBe('Nothing matches.');
      await expect(people()).resolves.toEqual([]);
      await expect(loop()).resolves.toEqual(['Dune House', 'Café Corner', 'Orchard Farm']);
      await expect(dearest.getByRole('status').innerText()).resolves.toBe('');
      // The other listing filters and sorts its own three, leaving the team's search as it is.
      await dearest.getByRole('combobox', { name: 'Garden' }).selectOption({ label: 'Yes' });
      await expect.poll(() => loop()).toEqual(['Dune House', 'Orchard Farm']);
      await dearest.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Price: Lowest first' });
      await expect.poll(() => loop()).toEqual(['Orchard Farm', 'Dune House']);
      await expect(people()).resolves.toEqual([]);
      await team.getByRole('button', { name: 'Clear all' }).click();
      await expect.poll(() => people()).toEqual(['Café Corner', 'Cliff Cottage', 'Dune House']);
      await expect(loop()).resolves.toEqual(['Orchard Farm', 'Dune House']);
      // A region none of a listing's entries is filed under is not offered: the team's are all North Coast.
      await expect(team.getByRole('group', { name: 'Region' }).getByRole('checkbox').allInnerTexts()).resolves.toHaveLength(1);
      await expect(dearest.getByRole('group', { name: 'Region' }).getByRole('checkbox').count()).resolves.toBe(2);
      await team.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Price: Highest first' });
      await expect.poll(() => people()).toEqual(['Dune House', 'Café Corner', 'Cliff Cottage']);
      // Each shows every match at once, and nothing else was ever fetched: the entries came with the page.
      expect(await page.getByRole('button', { name: 'Show more' }).count()).toBe(0);
      expect(requests.filter((r) => r.endsWith('.js') && r !== '/app.js')).toEqual([]);
      for (const code of built.get(homeRoute)!.chunks.values()) expect(code).not.toContain('Reef View');
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("lists the entries that match in the index's own design, from every page of it, and goes back when cleared", async () => {
    const { page, problems, requests } = await open(INDEX);
    try {
      const titles = () => page.locator('article a').allInnerTexts();
      const search = page.getByRole('search', { name: 'Browse Homes' });
      await expect(titles()).resolves.toEqual(['Reef View', 'Café Corner', 'Quay Flat']);
      expect(requests).not.toContain('/homes-index.js');
      // Orchard Farm is on the second page of the index.
      await search.getByRole('searchbox', { name: 'Search' }).fill('orchard');
      await expect.poll(() => titles()).toEqual(['Orchard Farm']);
      await expect(page.locator('article a').getAttribute('href')).resolves.toBe('/homes/orchard-farm/');
      expect(await page.locator('.so-archive__pages').count()).toBe(0);
      // Three to a page: the rest with Show more, which takes focus to the first of them.
      await search.getByRole('button', { name: 'Clear all' }).click();
      await search.getByRole('group', { name: 'Region' }).getByRole('checkbox', { name: 'North Coast' }).check();
      await expect.poll(() => titles()).toEqual(['Reef View', 'Café Corner', 'Dune House']);
      await page.getByRole('button', { name: 'Show more' }).click();
      await expect.poll(() => titles()).toEqual(['Reef View', 'Café Corner', 'Dune House', 'Cliff Cottage']);
      await expect(page.evaluate('document.activeElement.textContent')).resolves.toBe('Cliff Cottage');
      // With nothing matching, the design stays, its loop empty.
      await search.getByRole('searchbox', { name: 'Search' }).fill('zeppelin');
      await expect.poll(() => search.getByRole('status').innerText()).toBe('Nothing matches.');
      await expect(titles()).resolves.toEqual([]);
      expect(await page.locator('.so-archive__heading').count()).toBe(1);
      await search.getByRole('button', { name: 'Clear all' }).click();
      await expect.poll(() => titles()).toEqual(['Reef View', 'Café Corner', 'Quay Flat']);
      expect(await page.locator('.so-archive__pages').count()).toBe(1);
      expect(requests.filter((r) => r === '/homes-index.js')).toHaveLength(1);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
