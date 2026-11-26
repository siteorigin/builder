/**
 * The editor's per-panel counters for the performance harness (src/renderer/src/lib/perf-panels.tsx): with marks on,
 * each commit's components are counted where they rendered, a panel React left alone counts nothing, the probes and
 * boundaries count nothing either, and a panel's render time is the time spent between its probes. The real hook, store
 * and production React DOM run in a real browser.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://perf-panels.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import { perfMark } from ${renderer('lib/perf')};`,
  "import { createElement as h, memo } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { timedPanel } from ${renderer('lib/perf-panels')};`,
  `import { useStore } from ${renderer('store')};`,
  'const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };',
  'function Row({ n }) { return h("li", null, n); }',
  // Follows the store: it and its rows render on every change to `zoom`.
  'function Live() { const zoom = useStore((s) => s.zoom); busy(4); return h("ul", null, [0, 1, 2].map((n) => h(Row, { key: n, n: n + zoom }))); }',
  // Follows nothing: React leaves it alone.
  'const Still = memo(function Still() { return h("ul", null, [0, 1].map((n) => h(Row, { key: n, n }))); });',
  'function App() { return h("div", null, timedPanel("live", h(Live)), timedPanel("still", h(Still)), h(Row, { n: -1 })); }',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));",
  'window.so = { zoom: (z) => flushSync(() => useStore.setState({ zoom: z })), mark: (name) => perfMark(name) };'
].join('\n');

/** The preload bridges: the perf one keeps what the editor sends; every other call answers nothing. */
const BRIDGE = `
  window.records = [];
  window.builderPerf = { send: (r) => window.records.push(r) };
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
    mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    // React DOM as the editor ships it: the counters read what its production build leaves on each fiber.
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'perf-panels',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The panel counters did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('per-panel counters for the performance harness', { timeout: 30_000 }, () => {
  let browser: Browser;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    let script: string;
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    expect(errors).toEqual([]);
  }, 60_000);

  /** The counters on a mark made now. */
  const counters = async (): Promise<Record<string, number>> => {
    await page.evaluate(`so.mark('probe')`);
    return page.evaluate(`window.records.filter((r) => r.name === 'probe').at(-1).c`);
  };

  it('count each panel’s renders where they happened, and time the panel between its probes', async () => {
    const first = await counters();
    // Mounted: each panel counted from its first render, its own components only (no probes, no boundary).
    expect([first['panel.live.renders'], first['panel.still.renders']]).toEqual([4, 3]);
    // App and the Row outside the panels besides.
    expect(first['react.renders']).toBe(9);
    expect(first['panel.live.renderMs']).toBeGreaterThanOrEqual(4);
    for (const zoom of [2, 3]) await page.evaluate(`so.zoom(${zoom})`);
    const later = await counters();
    // Live and its three rows, twice; Still, memoised and following nothing, not at all.
    expect(later['panel.live.renders'] - first['panel.live.renders']).toBe(8);
    expect(later['panel.still.renders'] - first['panel.still.renders']).toBe(0);
    expect(later['react.renders'] - first['react.renders']).toBe(8);
    expect(later['panel.live.renderMs'] - first['panel.live.renderMs']).toBeGreaterThanOrEqual(8);
    expect(later['panel.still.renderMs'] - first['panel.still.renderMs']).toBeLessThan(2);
    expect(later['react.commits'] - first['react.commits']).toBe(2);
  });
});
