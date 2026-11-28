/**
 * The Assets grid draws a tile again only when what it shows changed, and puts in the page only the rows in and near its
 * view (#973). Every snapshot reaches the editor as new objects, so before the first an edit anywhere drew every tile of
 * the library again, six components each; before the second, every tile of the library was in the page and every
 * picture scrolled past was held. The real panel and store run in a real browser, counting the components React renders
 * with the editor's own counter (`react.renders`, which counts while marks are on: the page offers the perf bridge, as
 * the preload does).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { findTheme } from '@catalogue/index';
import type { AssetRecord, ProjectState } from '@shared/types';
import { sortAssets } from '@shared/asset-order';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://asset-tiles.test';
const DEV = 'http://preview.asset-tiles.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
const IMAGES = 120;
/** The editor's styles and the panel's, which size the tiles: a picture loads only once its box has a size. */
const CSS = ['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/AssetsPanel.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8')).join('\n');
/** The library's theme, as the editor receives it before it first renders. */
const THEME = JSON.stringify(findTheme(createStarterState('blank', 'Tiles', false).site.themeId)).replace(/</g, '\\u003c');
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
  `import { showAsset } from ${src('renderer/src/lib/place')};`,
  // The Fonts tab says which site styles use a family, which it reads from the theme.
  "import { registerPacks } from '@catalogue/index';",
  'registerPacks([window.__theme]);',
  'let revision = 1;',
  'let root;',
  "const snapshot = (state) => ({ workspaceKey: 'w', dir: '/project', state, revision, history: { canUndo: false, canRedo: false, entries: [] }, diagnostics: [], recoveryNotes: [], aiBusy: false, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, recentExports: [], runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } });',
  'window.mount = (state) => {',
  "  flushSync(() => useStore.setState({ screen: 'editor', snapshot: snapshot(state), pageId: state.site.homePageId, leftTab: 'assets', runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } }));',
  "  root = createRoot(document.getElementById('root'));",
  '  flushSync(() => root.render(h(AssetsPanel, { narrow: false })));',
  '};',
  'window.so = {',
  "  renders: () => { window.__siteoriginPerf.mark('probe'); return window.perfRecords.at(-1).c['react.renders'] ?? 0; },",
  // A new snapshot, as one arrives over IPC: every object in it new.
  '  receive: (state, missing) => { revision++; flushSync(() => useStore.setState({ snapshot: { ...snapshot(state), missingAssets: missing ?? [] } })); },',
  // "Open in Assets", from Project health or an export, on a panel already built.
  "  show: (id) => flushSync(() => showAsset('w', id)),",
  // "Show image" asked for while no Assets panel is built (the editor builds a panel the first time it shows): the
  // request comes first, then the panel it shows is built.
  "  showUnbuilt: (id) => { flushSync(() => root.unmount()); showAsset('w', id); root = createRoot(document.getElementById('root')); flushSync(() => root.render(h(AssetsPanel, { narrow: false }))); },",
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

describe.skipIf(!browserInstalled)('Assets grid tiles render only when they change, and only the rows in view are drawn (#973)', { timeout: 30_000 }, () => {
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
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>@layer tokens, reset, base, primitives, layout, components;\n${CSS}</style><body><aside class="side-panel" style="width: 320px; height: 700px; display: flex; flex-direction: column"><div id="root" style="display: contents"></div></aside><script>${BRIDGE}window.__theme = ${THEME};</script><script src="/app.js"></script></body>` })
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

  /** The library's images in the grid's order (newest first, as a new profile sorts them). */
  const order = () => sortAssets(Object.values(state.assets.assets), 'newest').map((a) => a.id);
  const BODY = "document.querySelector('.asset-host .panel-body')";
  const focused = () => page.evaluate<string | null>("document.activeElement?.getAttribute('data-asset') ?? null");
  const inPage = () => page.evaluate<string[]>("[...document.querySelectorAll('[data-asset]')].map((e) => e.getAttribute('data-asset'))");
  /** Tiles to a row: those level with the first in the page. */
  const columns = () => page.evaluate<number>("(() => { const els = [...document.querySelectorAll('[data-asset]')]; return els.filter((e) => e.offsetTop === els[0].offsetTop).length; })()");
  /** The tiles wholly inside the grid's view, in order. */
  const inView = () => page.evaluate<string[]>(`(() => { const b = ${BODY}; const box = b.getBoundingClientRect(); return [...b.querySelectorAll('[data-asset]')].filter((t) => t.getBoundingClientRect().top >= box.top && t.getBoundingClientRect().bottom <= box.bottom).map((t) => t.getAttribute('data-asset')); })()`);
  const scrollTop = () => page.evaluate<number>(`${BODY}.scrollTop`);
  const scrollTo = async (top: number | 'end') => {
    await page.evaluate(`(() => { const b = ${BODY}; b.scrollTop = ${top === 'end' ? 'b.scrollHeight' : top}; })()`);
    // The grid moves its window on the scroll event, then draws.
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  };

  it('puts only the rows in and near its view in the page, and the rest as it scrolls to them', async () => {
    const ids = order();
    const first = await inPage();
    // A few rows, never the library: the tiles in the page start with the first image and run on unbroken.
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(IMAGES / 2);
    expect(first).toEqual(ids.slice(0, first.length));
    const cols = await columns();
    // The scroller is as tall as the whole grid, so it scrolls to the last image, which is drawn there.
    await scrollTo('end');
    await expect.poll(() => page.locator(`[data-asset="${ids.at(-1)}"]`).count()).toBe(1);
    const last = await inPage();
    expect(last.length).toBeLessThan(IMAGES / 2);
    // The row of the grid's one Tab stop (the first image, nothing focused yet) stays in the page; the rest is the end,
    // in order.
    expect(last.slice(0, cols)).toEqual(ids.slice(0, cols));
    expect(last.slice(cols)).toEqual(ids.slice(IMAGES - (last.length - cols)));
    // Only the pictures of the tiles in the page are held.
    expect(await page.locator('[data-asset] img').count()).toBeLessThan(IMAGES / 2);
  });

  it('moves the focus with End, Home and the arrows to tiles out of view', async () => {
    const ids = order();
    await page.locator(`[data-asset="${ids[0]}"]`).focus();
    expect(await page.locator(`[data-asset="${ids.at(-1)}"]`).count()).toBe(0);
    await page.keyboard.press('End');
    expect(await focused()).toBe(ids.at(-1));
    // The browser scrolled to it, and the grid drew the rows there.
    await expect.poll(() => page.locator(`[data-asset="${ids.at(-2)}"]`).count()).toBe(1);
    await page.keyboard.press('Home');
    expect(await focused()).toBe(ids[0]);
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe(ids[1]);
    const cols = await columns();
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe(ids[1 + cols]);
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toBe(ids[1]);
    await page.keyboard.press('ArrowLeft');
    expect(await focused()).toBe(ids[0]);
    // Only the focused tile is the grid's Tab stop.
    expect(await page.evaluate<string[]>("[...document.querySelectorAll('[data-asset][tabindex=\"0\"]')].map((e) => e.getAttribute('data-asset'))")).toEqual([ids[0]]);
  });

  it('keeps the focused tile in the page while the grid scrolls away from it', async () => {
    const ids = order();
    await page.locator(`[data-asset="${ids[1]}"]`).focus();
    await scrollTo('end');
    await expect.poll(() => page.locator(`[data-asset="${ids.at(-1)}"]`).count()).toBe(1);
    expect(await focused()).toBe(ids[1]);
    // Tab from the search (past the controls between) comes back to it.
    await page.locator('.asset-tools input[type="search"]').focus();
    for (let i = 0; i < 8 && !(await focused()); i++) await page.keyboard.press('Tab');
    expect(await focused()).toBe(ids[1]);
  });

  it('returns from an image’s details to the same place in the grid, with the focus on that image', async () => {
    const ids = order();
    await scrollTo(1500);
    // An image in view, well down the library, focused (a tile in the view's scroll padding is scrolled clear of it).
    const id = (await inView())[1];
    expect(ids.indexOf(id)).toBeGreaterThan(10);
    await page.locator(`[data-asset="${id}"]`).focus();
    const top = await scrollTop();
    await page.keyboard.press('Enter');
    await page.locator('.asset-detail .asset-back').waitFor();
    expect(await page.locator('[data-asset]').count()).toBe(0);
    await page.locator('.asset-detail .asset-back').click();
    expect(await focused()).toBe(id);
    expect(Math.abs((await scrollTop()) - top)).toBeLessThan(2);
    expect(await inView()).toContain(id);
  });

  it('walks the whole grid with the keyboard, then returns from an image’s details to it', async () => {
    const ids = order();
    // As the benchmark does: to the end and back, then End, Home, a step right and a row down, Enter and Back.
    await scrollTo('end');
    await scrollTo(0);
    await page.locator(`[data-asset="${ids[0]}"]`).focus();
    await page.keyboard.press('End');
    expect(await focused()).toBe(ids.at(-1));
    await page.keyboard.press('Home');
    expect(await focused()).toBe(ids[0]);
    await page.keyboard.press('ArrowRight');
    const cols = await columns();
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe(ids[1 + cols]);
    await page.keyboard.press('Enter');
    await page.locator('.asset-detail .asset-back').waitFor();
    // The focus is on the image as soon as Back has been pressed, and stays there.
    await page.locator('.asset-detail .asset-back').click();
    expect(await focused()).toBe(ids[1 + cols]);
    await page.waitForTimeout(300);
    expect(await focused()).toBe(ids[1 + cols]);
  });

  it('opens a font whose file is missing in Fonts, with its family open and the focus on Locate file (#1425)', async () => {
    const face = (id: string, family: string, style: 'normal' | 'italic'): AssetRecord => ({ id, name: `${family} ${style === 'italic' ? 'Italic' : 'Regular'}`, file: `static/assets/${id}-0000000${id.length % 10}.woff2`, mime: 'font/woff2', bytes: 30_000, hash: id, kind: 'font', createdAt: '2026-01-01T00:00:00.000Z', font: { family, weight: '400', style } });
    const fonts = structuredClone(state);
    for (const a of [face('lora-upright', 'Lora', 'normal'), face('lora-italic', 'Lora', 'italic'), face('inter', 'Inter', 'normal')]) fonts.assets.assets[a.id] = a;
    const lost = [{ assetId: 'lora-italic', original: true, variants: [] , damaged: []}];
    await page.evaluate(([x, m]) => (globalThis as unknown as { so: { receive(s: unknown, m: unknown): void } }).so.receive(x, m), [fonts, lost] as unknown[]);
    await page.evaluate("so.show('lora-italic')");
    const locate = page.locator('[data-font="lora-italic"] .font-locate');
    await locate.waitFor();
    await page.waitForFunction("document.activeElement?.classList.contains('font-locate')");
    expect(await page.locator('[data-font="lora-italic"] .asset-missing').textContent()).toContain(`File missing. ${fonts.assets.assets['lora-italic'].file.split('/').pop()} is no longer in the project folder`);
    // Only the face whose file is gone offers it; its family says how many of its files are missing, and the tab is flagged.
    expect(await page.locator('.font-locate').count()).toBe(1);
    expect(await page.locator('[data-font-family="Lora"] .font-family-meta').textContent()).toContain('1 of 2 missing');
    expect(await page.locator('[data-font-family="Inter"] .font-family-meta').textContent()).not.toContain('missing');
    expect(await page.getByRole('img', { name: '1 font is missing its file:' }).count()).toBe(1);
    // The file put back, the note and the flag go.
    await page.evaluate(([x, m]) => (globalThis as unknown as { so: { receive(s: unknown, m: unknown): void } }).so.receive(x, m), [fonts, []] as unknown[]);
    expect(await page.locator('.font-locate').count()).toBe(0);
    expect(await page.getByRole('img', { name: '1 font is missing its file:' }).count()).toBe(0);
  });

  it('names a damaged smaller copy in the image’s details and offers to make it again (#1459)', async () => {
    const id = order()[0];
    const hurt = structuredClone(state);
    const avif = `static/assets/${id}-480w.avif`;
    hurt.assets.assets[id] = { ...hurt.assets.assets[id], width: 1200, height: 900, variants: [{ width: 480, file: `static/assets/${id}-480w.png` }, { width: 480, file: avif }] };
    const send = (m: unknown[]) => page.evaluate(([x, y]) => (globalThis as unknown as { so: { receive(s: unknown, m: unknown): void } }).so.receive(x, y), [hurt, m] as unknown[]);
    await send([{ assetId: id, original: false, variants: [avif], damaged: [avif] }]);
    expect(await page.locator(`[data-asset="${id}"]`).textContent()).toContain('Copy damaged');
    await page.evaluate((x) => (globalThis as unknown as { so: { show(id: string): void } }).so.show(x), id);
    const note = page.locator('.asset-detail .asset-missing');
    await note.waitFor();
    expect(await note.textContent()).toContain(`A smaller copy is damaged. Damaged: ${id}-480w.avif. Some screen sizes may show a broken picture until it is made again from the original.`);
    expect(await note.getByRole('button', { name: 'Make the copy again' }).count()).toBe(1);
    // One gone beside it: both are counted, and the damaged one still named.
    const png = `static/assets/${id}-480w.png`;
    await send([{ assetId: id, original: false, variants: [png, avif], damaged: [avif] }]);
    expect(await note.textContent()).toContain(`2 smaller copies are missing or damaged. Damaged: ${id}-480w.avif.`);
    await send([]);
    expect(await page.locator('.asset-detail .asset-missing').count()).toBe(0);
  });

  it('opens on the image “Show image” asked for when that showing is what builds the panel', async () => {
    const id = order()[40];
    await page.evaluate((x) => (globalThis as unknown as { so: { showUnbuilt(id: string): void } }).so.showUnbuilt(x), id);
    await page.locator('.asset-detail .asset-back').waitFor();
    expect(await page.locator('.asset-detail').textContent()).toContain(state.assets.assets[id].name);
    // Taken once: the next panel built opens on the grid.
    await page.evaluate("so.showUnbuilt('')");
    expect(await page.locator('.asset-detail').count()).toBe(0);
  });

  it('returns to the grid as it was when Back comes before the details have drawn', async () => {
    const ids = order();
    await scrollTo(1500);
    const id = (await inView())[1];
    await page.locator(`[data-asset="${id}"]`).focus();
    const top = await scrollTop();
    // Opened and left in the same task (React draws the details in a microtask): the details' own first frame, which
    // starts them at their top, comes after.
    await page.evaluate(`(async () => {
      document.activeElement.click();
      await Promise.resolve();
      document.querySelector('.asset-detail .asset-back').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    expect(await focused()).toBe(id);
    expect(Math.abs((await scrollTop()) - top)).toBeLessThan(2);
    expect(ids.indexOf(id)).toBeGreaterThan(10);
  });

  it('keeps the focus on an image a snapshot moves to the other end of the library', async () => {
    const ids = order();
    await page.locator(`[data-asset="${ids[1]}"]`).focus();
    // Its date moves it from the first row to the last: far out of the rows drawn.
    const edited = structuredClone(state);
    edited.assets.assets[ids[1]].createdAt = '2025-01-01T00:00:00.000Z';
    await receive(edited);
    expect(await page.locator(`[data-asset="${ids[1]}"]`).count()).toBe(1);
    expect(await focused()).toBe(ids[1]);
  });

  it('keeps the first image showing in view when the thumbnails change size', async () => {
    const ids = order();
    await scrollTo(2000);
    // The first tile showing (its bottom more than 8px into the view): the button pressed takes the focus.
    const id = await page.evaluate<string>(`(() => { const b = ${BODY}; const top = b.getBoundingClientRect().top; return [...b.querySelectorAll('[data-asset]')].find((t) => t.getBoundingClientRect().bottom > top + 8).getAttribute('data-asset'); })()`);
    await page.locator('.asset-density').click();
    expect(await page.locator('.asset-grid.compact').count()).toBe(1);
    // Scrolled to it (as far as the browser's scrollIntoView takes it), wholly in view.
    await expect.poll(inView).toContain(id);
    // The grid at the new size still shows the library in order around it: the tiles in the page in order, those in
    // view one unbroken run.
    const drawn = (await inPage()).map((x) => ids.indexOf(x));
    expect(drawn).toEqual([...drawn].sort((x, y) => x - y));
    const seen = (await inView()).map((x) => ids.indexOf(x));
    expect(seen).toEqual(seen.map((_, k) => seen[0] + k));
  });

  it('draws no tile again for an edit that leaves the library as it was', async () => {
    const edited = structuredClone(state);
    edited.site.name = 'Tiles, renamed';
    const before = await renders();
    await receive(edited);
    // The panel and its tools draw again; the tiles do not, so the count does not follow the library's size.
    expect((await renders()) - before).toBeLessThan(IMAGES / 2);
  });

  it('draws again the one tile whose image changed, with its new name', async () => {
    // Two images in the first rows, which are in the page.
    const [one, two] = order().slice(2, 4);
    const edited = structuredClone(state);
    edited.assets.assets[one].name = 'Harbour at dawn';
    const before = await renders();
    await receive(edited);
    await expect.poll(() => page.locator(`[data-asset="${one}"]`).getAttribute('aria-label')).toBe('Harbour at dawn');
    expect(await page.locator(`[data-asset="${one}"] .asset-name`).textContent()).toBe('Harbour at dawn');
    expect((await renders()) - before).toBeLessThan(IMAGES / 2);
    // Another picture's file is a change the tile shows too.
    const moved = structuredClone(edited);
    moved.assets.assets[two].file = `static/assets/${two}-new.png`;
    await receive(moved);
    await expect.poll(() => page.locator(`[data-asset="${two}"] img`).getAttribute('src')).toContain(`${two}-new.png`);
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
