/**
 * The Assets grid draws a tile again only when what it shows changed (#973). Every snapshot reaches the editor as new
 * objects, so before this an edit anywhere drew every tile of the library again, six components each. The real panel
 * and store run in a real browser, counting the components React renders with the editor's own counter
 * (`react.renders`, which counts while marks are on: the page offers the perf bridge, as the preload does).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord, ProjectState } from '@shared/types';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://asset-tiles.test';
const DEV = 'http://preview.asset-tiles.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
const IMAGES = 60;
/** The editor's styles and the panel's, which size the tiles: a picture loads only once its box has a size. */
const CSS = ['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/AssetsPanel.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8')).join('\n');
/** A 1 × 1 PNG, for every picture the tiles load. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

const ENTRY = [
  // Before React DOM, so the editor's counter sees every commit (lib/perf).
  `import ${src('renderer/src/lib/perf')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { AssetsPanel } from ${src('renderer/src/panels/AssetsPanel')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  'let revision = 1;',
  "const snapshot = (state) => ({ workspaceKey: 'w', dir: '/project', state, revision, history: { canUndo: false, canRedo: false, entries: [] }, diagnostics: [], recoveryNotes: [], aiBusy: false, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, recentExports: [], runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } });',
  'window.mount = (state) => {',
  "  flushSync(() => useStore.setState({ screen: 'editor', snapshot: snapshot(state), pageId: state.site.homePageId, leftTab: 'assets', runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(AssetsPanel, { narrow: false })));",
  '};',
  'window.so = {',
  "  renders: () => { window.__siteoriginPerf.mark('probe'); return window.perfRecords.at(-1).c['react.renders'] ?? 0; },",
  // A new snapshot, as one arrives over IPC: every object in it new.
  '  receive: (state) => { revision++; flushSync(() => useStore.setState({ snapshot: snapshot(state) })); },',
  '};'
].join('\n');

const BRIDGE = `
  window.perfRecords = [];
  window.builderPerf = { send: (record) => window.perfRecords.push(record) };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => (path === 'on' ? () => {} : Promise.resolve(undefined))
  });
  window.builder = any('');
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'asset-tiles',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The assets panel did not bundle');
  return chunk.code;
}

/** A blank site with a library of IMAGES pictures. */
function library(): ProjectState {
  const state = createStarterState('blank', 'Tiles', false);
  for (let i = 1; i <= IMAGES; i++) {
    const id = `img-${String(i).padStart(3, '0')}`;
    const a: AssetRecord = { id, name: `Picture ${String(i).padStart(3, '0')}`, file: `static/assets/${id}.png`, mime: 'image/png', bytes: 2000, width: 96, height: 72, hash: id, kind: 'image', createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` };
    state.assets.assets[id] = a;
  }
  return state;
}

describe.skipIf(!browserInstalled)('Assets grid tiles render only when they change (#973)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let state: ProjectState;

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${DEV}/**`, (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>@layer tokens, reset, base, primitives, layout, components;\n${CSS}</style><body><aside class="side-panel" style="width: 320px; height: 700px; display: flex; flex-direction: column"><div id="root" style="display: contents"></div></aside><script>${BRIDGE}</script><script src="/app.js"></script></body>` })
    );
    await page.goto(`${SITE}/`);
    state = library();
    await page.evaluate((s) => (globalThis as unknown as { mount(s: unknown): void }).mount(s), state as unknown);
    await page.locator('[data-asset]').first().waitFor();
    // Every picture in view loaded, so what is counted next is the snapshot's work alone.
    await page.waitForFunction("[...document.querySelectorAll('[data-asset] img')].slice(0, 6).every((i) => i.complete && i.naturalWidth > 0)");
    await page.waitForTimeout(200);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const renders = () => page.evaluate<number>('so.renders()');
  const receive = (s: ProjectState) => page.evaluate((x) => (globalThis as unknown as { so: { receive(s: unknown): void } }).so.receive(x), s as unknown);

  it('draws no tile again for an edit that leaves the library as it was', async () => {
    expect(await page.locator('[data-asset]').count()).toBe(IMAGES);
    const edited = structuredClone(state);
    edited.site.name = 'Tiles, renamed';
    const before = await renders();
    await receive(edited);
    // The panel and its tools draw again; the tiles do not, so the count does not follow the library's size.
    expect((await renders()) - before).toBeLessThan(IMAGES / 2);
  });

  it('draws again the one tile whose image changed, with its new name', async () => {
    const edited = structuredClone(state);
    edited.assets.assets['img-007'].name = 'Harbour at dawn';
    const before = await renders();
    await receive(edited);
    await expect.poll(() => page.locator('[data-asset="img-007"]').getAttribute('aria-label')).toBe('Harbour at dawn');
    expect(await page.locator('[data-asset="img-007"] .asset-name').textContent()).toBe('Harbour at dawn');
    expect((await renders()) - before).toBeLessThan(IMAGES / 2);
    // Another picture's file is a change the tile shows too.
    const moved = structuredClone(edited);
    moved.assets.assets['img-008'].file = 'static/assets/img-008-new.png';
    await receive(moved);
    await expect.poll(() => page.locator('[data-asset="img-008"] img').getAttribute('src')).toContain('img-008-new.png');
  });

  it('takes focus, clicks and the keyboard on its tiles from the grid around them', async () => {
    // Focus moves the grid's one Tab stop to the tile focused, after a snapshot as before it.
    await receive(structuredClone(state));
    const third = page.locator('[data-asset]').nth(2);
    await third.focus();
    await expect.poll(() => third.getAttribute('tabindex')).toBe('0');
    expect(await page.locator('[data-asset][tabindex="0"]').count()).toBe(1);
    await page.keyboard.press('ArrowRight');
    const fourth = page.locator('[data-asset]').nth(3);
    expect(await page.evaluate<string | null>("document.activeElement?.getAttribute('data-asset') ?? null")).toBe(await fourth.getAttribute('data-asset'));
    await expect.poll(() => fourth.getAttribute('tabindex')).toBe('0');
    // A click opens the image it was on.
    const name = await fourth.getAttribute('aria-label');
    await fourth.click();
    await expect.poll(() => page.locator('.asset-detail .asset-ident h4').textContent()).toBe(name);
  });
});
