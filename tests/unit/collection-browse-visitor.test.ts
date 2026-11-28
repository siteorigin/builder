/**
 * Search, filters and sorting on a collection's index as a visitor uses them (#1402), in a real headless browser: the
 * exported first page of a homes index, rendered on the server as the static site ships it, hydrated without a
 * mismatch, its controls then finding entries from every page of the index (loading the collection's browse index
 * the first time one is used), combining filters, sorting, listing a page of matches at a time, and going back to
 * the page as written when cleared. Without the page's script the controls are left out.
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
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, generateProject, publishedState } from '@generator/index';
import { BROWSE_COMPONENT_FILE } from '@generator/collection-browse';
import { archiveFile } from '@generator/archive';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://homes.test';
const GEN = '\0gen:';
const ROUTE = archiveFile('/homes/');

/** Seven published homes, three to a page of the index, filed by region, with search, three filters and two sorts. */
function site(): ProjectState {
  let s = createStarterState('business', 'Coast Realty', false);
  const apply = (...ops: EditOperation[]) => (s = applyOperations(s, ops).state);
  apply({
    type: 'collection.create',
    collectionId: 'homes',
    name: 'Homes',
    kind: 'structured',
    route: '/homes/',
    pageSize: 3,
    fields: { price: { type: 'number', label: 'Price' }, garden: { type: 'boolean', label: 'Garden' } },
    taxonomies: { region: { label: 'Region', terms: { north: { label: 'North Coast' }, south: { label: 'South Bay' } } } },
    browse: { search: true, filters: ['terms.region', 'field.garden', 'field.price'], sort: ['field.price', 'title'] }
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
  homes.forEach(([entryId, title, price, garden, region], i) =>
    apply({ type: 'entry.create', collectionId: 'homes', entryId, title, publishedAt: `2026-0${i + 1}-01`, draft: false, values: { price, garden }, terms: { region: [region] } } as EditOperation)
  );
  return s;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The page rendered on the server, head and body, as the static site ships it. */
async function serverRender(files: Map<string, string>): Promise<{ head: string; body: string }> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'collection-browse-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  for (const [path, source] of files) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(out, code.replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1').replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths)));
  }
  const Page = (await import(/* @vite-ignore */ join(dir, `${ROUTE}.js`))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} });
}

/** The page compiled for the browser, the browse index left in a chunk of its own as the static build leaves it. */
async function bundle(files: Map<string, string>): Promise<Map<string, string>> {
  const all = new Map([...files, ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";']]);
  const entry = `import { hydrate } from 'svelte';\nimport Page from ${JSON.stringify(GEN + ROUTE)};\nwindow.site = hydrate(Page, { target: document.getElementById('app'), props: {} });`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'generated-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths') return GEN + 'app/paths.js';
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
  if (!chunks.has('app.js') || !chunks.has('homes-index.js')) throw new Error(`The site did not bundle as expected: ${[...chunks.keys()].join(', ')}`);
  return chunks;
}

describe.skipIf(!browserInstalled)('a collection index for a visitor', () => {
  let browser: Browser;
  let chunks: Map<string, string>;
  let ssr: { head: string; body: string };
  let css: string;

  beforeAll(async () => {
    const files = generateProject(publishedState(site()));
    // The site's stylesheets, and the page's and the browse component's own styles, as the static build writes them.
    const scoped = [ROUTE, `${RUNTIME_DIR}/${BROWSE_COMPONENT_FILE}`].map((f) => compile(files.get(f)!, { filename: f, generate: 'client', runes: true, css: 'external' }).css?.code ?? '');
    css = [...['tokens', 'theme', 'components', 'site'].map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? ''), ...scoped].join('\n');
    const [rendered, bundled, launched] = await Promise.allSettled([serverRender(files), bundle(files), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    for (const r of [rendered, bundled, launched]) if (r.status === 'rejected') throw r.reason;
    ssr = (rendered as PromiseFulfilledResult<typeof ssr>).value;
    chunks = (bundled as PromiseFulfilledResult<typeof chunks>).value;
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  interface Opened {
    page: Page;
    /** Console warnings and errors, and uncaught errors. */
    problems: string[];
    /** How many times the browse index was asked for. */
    loads: () => number;
  }

  /** The page, hydrated; with `scripts: false` as a browser that runs none shows it. `index` answers each ask for the browse index. */
  async function open(opts: { scripts?: boolean; index?: (n: number) => 'ok' | 'fail' } = {}): Promise<Opened> {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    let asked = 0;
    const scripts = opts.scripts !== false;
    const html = `<!doctype html><html lang="en"${scripts ? ' class="so-js"' : ''}><head><meta charset="utf-8">${ssr.head}<style>${css}</style></head><body><div id="app">${ssr.body}</div>${scripts ? '<script type="module" src="/app.js"></script>' : ''}</body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/homes/') return route.fulfill({ contentType: 'text/html', body: html });
      const name = url.pathname.slice(1);
      if (name === 'homes-index.js') {
        asked++;
        if ((opts.index?.(asked) ?? 'ok') === 'fail') return route.fulfill({ status: 500, body: '' });
      }
      if (chunks.has(name)) return route.fulfill({ contentType: 'text/javascript', body: chunks.get(name)! });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`${ORIGIN}/homes/`);
    if (scripts) await expect.poll(() => page.locator('.so-browse fieldset').first().isDisabled()).toBe(false);
    return { page, problems, loads: () => asked };
  }

  const titles = (page: Page) => page.locator('.so-archive__title a').allInnerTexts();
  const status = (page: Page) => page.getByRole('status');

  it('hydrates the page as written, then finds an entry from a later page of the index by any word, ignoring accents', async () => {
    const { page, problems, loads } = await open();
    try {
      await expect(titles(page)).resolves.toEqual(['Reef View', 'Café Corner', 'Quay Flat']);
      expect(await page.locator('.so-archive__pages').count()).toBe(1);
      // Nothing loads until a control is used.
      expect(loads()).toBe(0);
      const search = page.getByRole('search', { name: 'Browse Homes' });
      await search.getByRole('searchbox', { name: 'Search' }).fill('orchard');
      await expect.poll(() => status(page).innerText()).toBe('1 match');
      await expect(titles(page)).resolves.toEqual(['Orchard Farm']);
      await expect(page.locator('.so-archive__title a').getAttribute('href')).resolves.toBe('/homes/orchard-farm/');
      // The page's own cards and page links are not shown meanwhile.
      expect(await page.locator('.so-archive__pages').count()).toBe(0);
      await search.getByRole('searchbox', { name: 'Search' }).fill('CAFE corner');
      await expect.poll(() => titles(page)).toEqual(['Café Corner']);
      // A category label is found too.
      await search.getByRole('searchbox', { name: 'Search' }).fill('south bay');
      await expect.poll(() => status(page).innerText()).toBe('3 matches');
      await search.getByRole('searchbox', { name: 'Search' }).fill('zeppelin');
      await expect.poll(() => status(page).innerText()).toBe('Nothing matches. Try fewer filters or other words.');
      expect(loads()).toBe(1);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('combines filters and a range, sorts, and lists a page of matches at a time', async () => {
    const { page, problems } = await open();
    try {
      const search = page.getByRole('search', { name: 'Browse Homes' });
      await search.getByRole('group', { name: 'Region' }).getByRole('checkbox', { name: 'North Coast' }).check();
      await expect.poll(() => status(page).innerText()).toBe('4 matches');
      // Three to a page: the next one shows with Show more, which takes focus to it.
      await expect(titles(page)).resolves.toEqual(['Reef View', 'Café Corner', 'Dune House']);
      await page.getByRole('button', { name: 'Show more' }).click();
      await expect.poll(() => titles(page)).toEqual(['Reef View', 'Café Corner', 'Dune House', 'Cliff Cottage']);
      await expect(page.evaluate('document.activeElement.textContent')).resolves.toBe('Cliff Cottage');
      expect(await page.getByRole('button', { name: 'Show more' }).count()).toBe(0);
      await search.getByRole('combobox', { name: 'Garden' }).selectOption({ label: 'Yes' });
      await expect.poll(() => titles(page)).toEqual(['Reef View', 'Dune House', 'Cliff Cottage']);
      const price = search.getByRole('group', { name: 'Price' });
      await price.getByRole('spinbutton', { name: 'Maximum' }).fill('800000');
      await expect.poll(() => titles(page)).toEqual(['Dune House', 'Cliff Cottage']);
      await search.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Price: Lowest first' });
      await expect.poll(() => titles(page)).toEqual(['Cliff Cottage', 'Dune House']);
      await search.getByRole('group', { name: 'Region' }).getByRole('checkbox', { name: 'South Bay' }).check();
      await expect.poll(() => titles(page)).toEqual(['Cliff Cottage', 'Orchard Farm', 'Dune House']);
      // Sorting alone lists every entry, in the order chosen.
      await page.getByRole('button', { name: 'Clear all' }).click();
      await expect(page.evaluate('document.activeElement.getAttribute("type")')).resolves.toBe('search');
      await search.getByRole('combobox', { name: 'Sort by' }).selectOption({ label: 'Title: A to Z' });
      await expect.poll(() => titles(page)).toEqual(['Café Corner', 'Cliff Cottage', 'Dune House']);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('goes back to the page as written when cleared', async () => {
    const { page, problems } = await open();
    try {
      await page.getByRole('searchbox', { name: 'Search' }).fill('dune');
      await expect.poll(() => titles(page)).toEqual(['Dune House']);
      await page.getByRole('button', { name: 'Clear all' }).click();
      await expect.poll(() => titles(page)).toEqual(['Reef View', 'Café Corner', 'Quay Flat']);
      expect(await page.locator('.so-archive__pages').count()).toBe(1);
      await expect(status(page).innerText()).resolves.toBe('');
      await expect(page.getByRole('button', { name: 'Clear all' }).isDisabled()).resolves.toBe(true);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('keeps the page as written when the entries cannot load, and loads them on Try again', async () => {
    const { page, loads } = await open({ index: (n) => (n === 1 ? 'fail' : 'ok') });
    try {
      await page.getByRole('searchbox', { name: 'Search' }).fill('quay');
      await expect.poll(() => status(page).innerText()).toBe('The list could not load.');
      await expect(titles(page)).resolves.toEqual(['Reef View', 'Café Corner', 'Quay Flat']);
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => titles(page)).toEqual(['Quay Flat']);
      expect(loads()).toBe(2);
    } finally {
      await page.close();
    }
  });

  it('leaves the controls out of a page whose scripts never run', async () => {
    const { page } = await open({ scripts: false });
    try {
      await expect(titles(page)).resolves.toEqual(['Reef View', 'Café Corner', 'Quay Flat']);
      expect(await page.getByRole('search').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
