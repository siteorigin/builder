/**
 * Hidden panels (#968): a panel kept mounted while hidden does no work for what it cannot show. Store changes and the
 * editor drawing around it leave it as it is; shown again it shows the store as it is now in that same commit, with
 * what was typed into it, its DOM and its listeners kept. The real store and boundary run in a real browser.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://hideable.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useEffect, useLayoutEffect, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Hideable, usePanelHidden } from ${renderer('lib/hideable')};`,
  `import { Modal } from ${renderer('components/ui')};`,
  `import { getState, selectedRatio, setOverlay, useOverlay, useStore } from ${renderer('store')};`,
  'window.log = { panel: 0, row: 0, shape: 0, effects: [], heard: [] };',
  // What the panel reads of the canvas's overlay (OverlayState): the selection's shape, as the Inspector reads it.
  'function Shape() { const ratio = useOverlay(selectedRatio); window.log.shape++; return h("s", { id: "shape" }, String(ratio)); }',
  // A row of the panel's own: it follows the store too, and renders only when the panel does or the zoom changes.
  'function Row() { const zoom = useStore((s) => s.zoom); window.log.row++; return h("span", { id: "row" }, String(zoom)); }',
  // What a dialog opened from the panel shows: on screen whatever opened it, so it follows the store.
  'function Zoom() { const zoom = useStore((s) => s.zoom); return h("output", { id: "dialog-zoom" }, String(zoom)); }',
  'function Panel() {',
  '  const zoom = useStore((s) => s.zoom);',
  '  const page = useStore((s) => s.pageId);',
  '  const [q, setQ] = useState("");',
  '  const [dialog, setDialog] = useState(false);',
  '  window.openDialog = () => flushSync(() => setDialog(true));',
  '  window.log.hidden = usePanelHidden();',
  '  window.log.panel++;',
  '  useLayoutEffect(() => { window.log.effects.push(String(zoom)); }, [zoom]);',
  // The panel's own listener hears its event while hidden, and reads the store as it is now.
  '  useEffect(() => { const on = () => window.log.heard.push(String(getState().zoom)); window.addEventListener("panel-ping", on); return () => window.removeEventListener("panel-ping", on); }, []);',
  '  return h("div", { id: "panel" }, h("input", { id: "q", "aria-label": "Search", value: q, onChange: (e) => setQ(e.target.value) }), h("b", { id: "zoom" }, String(zoom)), h("i", { id: "page" }, String(page)), h(Row), h(Shape), dialog ? h(Modal, { title: "A dialog", onClose: () => setDialog(false) }, h(Zoom)) : null);',
  '}',
  'function Editor() {',
  '  const leftTab = useStore((s) => s.leftTab);',
  '  const [, redraw] = useState(0);',
  '  window.redraw = () => flushSync(() => redraw((n) => n + 1));',
  '  return h("div", { hidden: leftTab !== "insert" }, h(Hideable, { hidden: leftTab !== "insert" }, h(Panel)));',
  '}',
  "flushSync(() => useStore.setState({ leftTab: 'insert', zoom: 1, pageId: 'p1', snapshot: { workspaceKey: 'w1' } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  'window.so = { set: (patch) => flushSync(() => useStore.setState(patch)), box: (b) => flushSync(() => setOverlay({ rects: { selected: [b], hovered: [], revealed: [] } })) };'
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
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
        name: 'hideable',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The hidden panel did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('a hidden panel (#968)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const set = (patch: Record<string, unknown>) => page.evaluate(`so.set(${JSON.stringify(patch)})`);
  const log = () => page.evaluate<{ panel: number; row: number; shape: number; effects: string[]; heard: string[]; hidden: boolean }>('window.log');
  const text = (id: string) => page.locator(`#${id}`).textContent();

  it('does nothing for store changes or the editor drawing while hidden, and is up to date the moment it shows', async () => {
    await page.locator('#q').fill('hero');
    await set({ leftTab: 'pages' });
    const hidden = await log();
    await page.evaluate(`window.held = document.getElementById('panel')`);
    for (const zoom of [2, 3, 4]) await set({ zoom });
    await set({ pageId: 'p2' });
    await page.evaluate('redraw()');
    // Not one render, of the panel or its row, and no effect re-run, for any of it.
    expect(await log()).toEqual(hidden);
    expect([await text('zoom'), await text('row'), await text('page')]).toEqual(['1', '1', 'p1']);
    // Shown: the same commit that shows it shows the store as it is now, its row too.
    await set({ leftTab: 'insert' });
    expect([await text('zoom'), await text('row'), await text('page')]).toEqual(['4', '4', 'p2']);
    const shown = await log();
    expect(shown.panel - hidden.panel).toBe(1);
    expect(shown.effects.at(-1)).toBe('4');
    // The same element, with what was typed into it.
    expect(await page.evaluate(`window.held === document.getElementById('panel')`)).toBe(true);
    expect(await page.locator('#q').inputValue()).toBe('hero');
    // Shown, it follows the store again.
    await set({ zoom: 5 });
    expect(await text('row')).toBe('5');
  });

  it('draws the hiding itself, keeps listening while hidden, and draws a new opening once', async () => {
    const before = await log();
    await set({ leftTab: 'layers', zoom: 2 });
    // The render that hides it sees the store as the hiding left it.
    expect(await text('zoom')).toBe('2');
    expect((await log()).panel - before.panel).toBe(1);
    await set({ zoom: 3 });
    await page.evaluate(`window.dispatchEvent(new Event('panel-ping'))`);
    expect((await log()).heard).toEqual(['3']);
    // Another project opened while it is hidden: drawn once, so it never holds one that has gone.
    const held = (await log()).panel;
    await set({ snapshot: { workspaceKey: 'w2' }, zoom: 6 });
    expect([await text('zoom'), (await log()).panel - held]).toEqual(['6', 1]);
    await set({ zoom: 7 });
    expect(await text('zoom')).toBe('6');
    // The SEO view taking the canvas's place (another workspace) is drawn once too, and so is its going.
    await set({ leftTab: 'seo' });
    expect([await text('zoom'), (await log()).panel - held]).toEqual(['7', 2]);
    await set({ zoom: 8 });
    await set({ leftTab: 'pages' });
    expect([await text('zoom'), (await log()).panel - held]).toEqual(['8', 3]);
    await set({ zoom: 9 });
    expect(await text('zoom')).toBe('8');
    expect((await log()).hidden).toBe(true);
  });

  it('holds what it reads of the overlay still while hidden too, and renders nothing for a scroll that keeps its shape', async () => {
    const box = (b: { x: number; y: number; width: number; height: number }) => page.evaluate(`so.box(${JSON.stringify(b)})`);
    await box({ x: 0, y: 0, width: 200, height: 100 });
    expect(await text('shape')).toBe('2');
    const shown = (await log()).shape;
    // The page scrolled: the box moved, its shape did not.
    for (const y of [-40, -80, -120]) await box({ x: 0, y, width: 200, height: 100 });
    expect((await log()).shape).toBe(shown);
    // Hidden, a box of another shape changes nothing; shown again, the panel has it in that commit.
    await set({ leftTab: 'pages' });
    const hidden = await log();
    await box({ x: 0, y: 0, width: 300, height: 100 });
    expect([await text('shape'), (await log()).shape]).toEqual(['2', hidden.shape]);
    await set({ leftTab: 'insert' });
    expect(await text('shape')).toBe('3');
  });

  it('lets a dialog the hidden panel opens follow the store, and says whether the panel is hidden', async () => {
    expect((await log()).hidden).toBe(false);
    await set({ leftTab: 'pages' });
    expect((await log()).hidden).toBe(true);
    // Opened while the panel is held (a save it waited on finished after the author moved on): it is on screen.
    await page.evaluate('openDialog()');
    await set({ zoom: 12 });
    expect([await text('dialog-zoom'), await text('zoom')]).toEqual(['12', '1']);
  });
});
