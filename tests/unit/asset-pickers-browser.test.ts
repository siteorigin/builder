/**
 * The Inspector's two pickers of library images, the image picker beside an image field and the gallery picker, put in
 * the page only the rows of options in and near their view (#973): with a large library every option was in the page
 * and every picture scrolled past was held. The real editors and store run in a real browser with the Inspector's
 * styles, which size the grids; the keyboard, the chosen image and the Tab stop reach options out of view.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { sortAssets } from '@shared/asset-order';
import type { AssetRecord, ListProp, ProjectState } from '@shared/types';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://asset-pickers.test';
const DEV = 'http://preview.asset-pickers.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
const IMAGES = 150;
const CSS = ['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/Inspector.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8')).join('\n');
/** A 1 × 1 PNG, for every picture the options load. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ImageEditor } from ${src('renderer/src/panels/PropEditors')};`,
  `import { ImagesPicker } from ${src('renderer/src/panels/ImagesPicker')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  "const snapshot = (state) => ({ workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, diagnostics: [], recoveryNotes: [], aiBusy: false, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, recentExports: [], runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } });',
  'const root = () => createRoot(document.getElementById(\'root\'));',
  'window.image = (state, assetId) => {',
  "  flushSync(() => useStore.setState({ screen: 'editor', snapshot: snapshot(state), runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } }));',
  "  flushSync(() => root().render(h(ImageEditor, { value: { assetId, alt: '' }, onChange: () => {}, state, title: 'Image' })));",
  '};',
  'window.gallery = (state, schema) => {',
  "  flushSync(() => useStore.setState({ screen: 'editor', snapshot: snapshot(state), runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } }));',
  '  flushSync(() => root().render(h(ImagesPicker, { schema, items: [], state, onAdd: async () => true, onClose: () => {} })));',
  '};'
].join('\n');

const BRIDGE = `
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
        name: 'asset-pickers',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The pickers did not bundle');
  return chunk.code;
}

/** The Business starter (for its gallery's list) with a library of IMAGES pictures, each added a second apart. */
function library(): { state: ProjectState; schema: ListProp } {
  const state = createStarterState('business', 'Pickers', false);
  for (const id of Object.keys(state.assets.assets)) delete state.assets.assets[id];
  for (let i = 1; i <= IMAGES; i++) {
    const id = `img-${String(i).padStart(3, '0')}`;
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    state.assets.assets[id] = { id, name: `Picture ${String(i).padStart(3, '0')}`, file: `static/assets/${id}.png`, mime: 'image/png', bytes: 2000, width: 96, height: 72, hash: id, kind: 'image', createdAt: t } as AssetRecord;
  }
  const schema = Object.values(state.components).map((d) => d.properties.images).find((p): p is ListProp => p?.type === 'list');
  if (!schema) throw new Error('The Business starter has no gallery');
  return { state, schema };
}

describe.skipIf(!browserInstalled)('The Inspector’s image pickers draw only the rows in and near their view (#973)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let lib: { state: ProjectState; schema: ListProp };

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
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>@layer tokens, reset, base, primitives, layout, components;\n${CSS}</style><body><aside class="dock" style="width: 340px; height: 760px; overflow: auto"><div id="dock-panel-inspect"><div id="root"></div></div></aside><script>${BRIDGE}</script><script src="/app.js"></script></body>` })
    );
    await page.goto(`${SITE}/`);
    lib = library();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  /** The library's images in the pickers' order (newest first, as a new profile sorts them). */
  const order = () => sortAssets(Object.values(lib.state.assets.assets), 'newest').map((a) => a.id);
  const at = (id: string) => order().indexOf(id) + 1;
  /** The options in the page, by their place in the list. */
  const inPage = (grid: string) => page.evaluate<number[]>(`[...document.querySelectorAll('${grid} [role="option"]')].map((o) => Number(o.getAttribute('aria-posinset')))`);
  const focusedAt = () => page.evaluate<number | null>("document.activeElement?.getAttribute('role') === 'option' ? Number(document.activeElement.getAttribute('aria-posinset')) : null");
  /** The options wholly inside the grid's view, by their place in the list. */
  const inView = (grid: string) => page.evaluate<number[]>(`(() => { const g = document.querySelector('${grid}'); const box = g.getBoundingClientRect(); return [...g.querySelectorAll('[role="option"]')].filter((o) => o.getBoundingClientRect().top >= box.top - 0.5 && o.getBoundingClientRect().bottom <= box.bottom + 0.5).map((o) => Number(o.getAttribute('aria-posinset'))); })()`);
  const scrollTo = async (grid: string, top: number | 'end') => {
    await page.evaluate(`(() => { const g = document.querySelector('${grid}'); g.scrollTop = ${top === 'end' ? 'g.scrollHeight' : top}; })()`);
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  };
  const unbroken = (xs: number[]) => xs.every((x, k) => !k || x === xs[k - 1] + 1);

  describe('the image picker', () => {
    const GRID = '.insp-image-pop .insp-pick-grid';
    const open = async (assetId: string | null) => {
      await page.evaluate(([s, id]) => (globalThis as unknown as { image(s: unknown, id: unknown): void }).image(s, id), [lib.state as unknown, assetId] as const);
      await page.getByRole('button', { name: assetId ? 'Change…' : 'Choose image…', exact: true }).click();
      await page.locator(`${GRID} [role="option"]`).first().waitFor();
    };

    it('opens on whole rows with the chosen image in view, its options a few rows of the library', async () => {
      const chosen = order()[100];
      // The rows above it taller than its own: images there share a name, so each says which file it came from.
      for (const id of order().slice(85, 100)) lib.state.assets.assets[id].name = 'Shared name';
      await open(chosen);
      const shown = await inPage(GRID);
      expect(shown.length).toBeLessThan(IMAGES / 3);
      // Each option says where it is in the whole list.
      expect(await page.locator(`${GRID} [role="option"]`).first().getAttribute('aria-setsize')).toBe(String(IMAGES));
      expect(shown).toEqual([...shown].sort((x, y) => x - y));
      // The chosen image is in view, on the last row (a whole row above it at the top), and has the Tab stop.
      const view = await inView(GRID);
      expect(view).toContain(at(chosen));
      expect(unbroken(view)).toBe(true);
      expect(view.at(-1)! - at(chosen)).toBeLessThan(3);
      // The view starts on a whole row: the row above it would not fit as well (the first in view starts a row).
      expect((view[0] - 1) % 3).toBe(0);
      const rowsAbove = await page.evaluate<number>(`(() => { const g = document.querySelector('${GRID}'); return g.scrollTop; })()`);
      expect(rowsAbove).toBeGreaterThan(0);
      expect(await page.locator(`${GRID} [role="option"][aria-selected="true"]`).getAttribute('tabindex')).toBe('0');
    });

    it('moves the focus with the arrows, Home and End to options out of view', async () => {
      await open(null);
      await page.locator(`${GRID} [role="option"][aria-posinset="1"]`).focus();
      await page.keyboard.press('End');
      expect(await focusedAt()).toBe(IMAGES);
      expect(await inView(GRID)).toContain(IMAGES);
      await page.keyboard.press('Home');
      expect(await focusedAt()).toBe(1);
      await page.keyboard.press('ArrowDown');
      expect(await focusedAt()).toBe(4);
      await page.keyboard.press('ArrowRight');
      expect(await focusedAt()).toBe(5);
      // Scrolled away from it, the option with the focus keeps it, and is still the Tab stop.
      await scrollTo(GRID, 'end');
      expect(await focusedAt()).toBe(5);
      expect(await inPage(GRID)).toContain(IMAGES);
      expect(await page.locator(`${GRID} [role="option"][tabindex="0"]`).getAttribute('aria-posinset')).toBe('5');
    });
  });

  describe('the gallery picker', () => {
    const GRID = '.insp-pick-many .insp-pick-grid';
    const open = async () => {
      await page.evaluate(([s, schema]) => (globalThis as unknown as { gallery(s: unknown, schema: unknown): void }).gallery(s, schema), [lib.state as unknown, lib.schema as unknown] as const);
      await page.locator(`${GRID} [role="option"]`).first().waitFor();
    };

    it('puts a few rows of the library in the page, and the rest as it scrolls to them', async () => {
      await open();
      const first = await inPage(GRID);
      expect(first.length).toBeLessThan(IMAGES / 3);
      expect(first[0]).toBe(1);
      expect(unbroken(first)).toBe(true);
      await scrollTo(GRID, 'end');
      expect(await inView(GRID)).toContain(IMAGES);
      expect(unbroken(await inView(GRID))).toBe(true);
      expect((await inPage(GRID)).length).toBeLessThan(IMAGES / 3);
    });

    it('moves one option at a time, and to the ends, choosing an image out of view', async () => {
      await open();
      await page.locator(`${GRID} [role="option"][aria-posinset="1"]`).focus();
      await page.keyboard.press('ArrowDown');
      expect(await focusedAt()).toBe(2);
      await page.keyboard.press('ArrowRight');
      expect(await focusedAt()).toBe(3);
      await page.keyboard.press('ArrowUp');
      expect(await focusedAt()).toBe(2);
      await page.keyboard.press('End');
      expect(await focusedAt()).toBe(IMAGES);
      // Chosen with Space: number 1 of the choice.
      await page.keyboard.press('Space');
      await expect.poll(() => page.locator(`${GRID} [role="option"][aria-posinset="${IMAGES}"]`).getAttribute('aria-selected')).toBe('true');
      expect(await focusedAt()).toBe(IMAGES);
      await page.keyboard.press('Home');
      expect(await focusedAt()).toBe(1);
      // The chosen image is in the order below the grid, by its name.
      expect(await page.locator('.insp-pick-order').textContent()).toContain(lib.state.assets.assets[order()[IMAGES - 1]].name);
    });
  });
});
