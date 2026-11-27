/**
 * Insert's project component thumbnails (src/renderer/src/components/ComponentThumb.tsx, #972): a tile asks main for its
 * picture only while it is in view in the open panel, asks again after a change only once it is in view, and asks
 * nothing when it comes back into view with the picture main already gave for the project as it is. The real
 * component, store and React DOM run in a real browser, with main's answers made up by the page.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://component-thumb.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

/** Ten tiles 100 px tall (their pictures 80 px, as Insert's stylesheet makes them) in a scroller 250 px tall: the first
 *  three are in view, the rest below it. */
const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ComponentThumb } from ${renderer('components/ComponentThumb')};`,
  `import { useStore } from ${renderer('store')};`,
  'const sketch = h("b", null, "sketch");',
  'function App({ open }) {',
  '  return h("div", { id: "scroller", style: { height: "250px", overflow: "auto" } },',
  '    Array.from({ length: 10 }, (_, i) => h("div", { key: i, style: { height: "100px" } }, h(ComponentThumb, { definitionId: "c" + i, active: open, fallback: sketch }))));',
  '}',
  "const root = createRoot(document.getElementById('root'));",
  'window.so = {',
  '  render: (open) => flushSync(() => root.render(h(App, { open }))),',
  "  revision: (revision, opening = 'opening-1') => flushSync(() => useStore.setState({ snapshot: { workspaceKey: opening, revision }, runtime: { state: 'ready' } })),",
  '  runtime: (state) => flushSync(() => useStore.setState({ runtime: { state } })),',
  '};'
].join('\n');

/**
 * The preload bridge: main's thumbnail answers, a picture of its own for each look `window.look` names, keyed by the
 * component and the look, left out when the editor says it shows that key, and a failure for a component in
 * `window.failing`; every request is recorded. Every other call answers nothing.
 */
const BRIDGE = `
  window.asked = [];
  window.look = 1;
  window.failing = new Set();
  window.pic = (look) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#' + ['f00', '0f0', '00f', 'ff0'][look % 4] + '"/></svg>');
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  const componentThumb = (id, opening, have) => {
    window.asked.push({ id, have: have ?? null });
    const key = id + '@' + window.look;
    if (window.failing.has(id)) return Promise.resolve({ state: 'failed', key, message: 'Boom' });
    return Promise.resolve(have === key ? { state: 'ready', key } : { state: 'ready', key, url: window.pic(window.look) });
  };
  window.builder = new Proxy({}, {
    get: (_, key) => (key === 'project' ? new Proxy({}, { get: (_, k) => (k === 'componentThumb' ? componentThumb : any('project.' + String(k))) }) : key === 'then' || typeof key === 'symbol' ? undefined : any(String(key)))
  });
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'component-thumb',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The thumbnail tile did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('component thumbnails in Insert', { timeout: 60_000 }, () => {
  let browser: Browser;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    let script: string;
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>.component-thumb { display: block; height: 80px; }</style><body style="margin:0"><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    expect(errors).toEqual([]);
  }, 60_000);

  /** The requests made since the last call, in order. */
  const asked = async (): Promise<Array<{ id: string; have: string | null }>> => page.evaluate('window.asked.splice(0)');
  const scrollTo = (top: number) => page.evaluate(`document.getElementById('scroller').scrollTop = ${top}`);
  const shown = (id: string) => page.locator(`[data-definition-id="${id}"]`).getAttribute('data-thumb');
  /** The picture a tile shows, and the one the bridge draws for `look`. */
  const src = (id: string) => page.locator(`[data-definition-id="${id}"] img`).getAttribute('src');
  const pic = (look: number): Promise<string> => page.evaluate(`window.pic(${look})`);
  /** Longer than the rest a change takes before tiles ask again (SETTLE_MS), with room for the observer's report. */
  const settle = () => page.waitForTimeout(800);

  it('ask only for the tiles in view, each once for the project as it is, and again after a change only once in view', async () => {
    await page.evaluate('so.revision(1)');
    await page.evaluate('so.render(true)');
    await settle();
    // Opened: the three tiles in view ask at once; the seven below it ask nothing.
    expect(await asked()).toEqual([
      { id: 'c0', have: null },
      { id: 'c1', have: null },
      { id: 'c2', have: null }
    ]);
    expect(await shown('c0')).toBe('ready');
    expect(await src('c0')).toBe(await pic(1));
    expect(await shown('c9')).toBe('pending');

    // Scrolled to the end: the tiles that came into view ask, and only they.
    await scrollTo(800);
    await settle();
    expect((await asked()).map((a) => a.id).sort()).toEqual(['c7', 'c8', 'c9']);
    expect(await shown('c9')).toBe('ready');

    // Back at the top with nothing changed: the pictures shown are the ones main gave for this revision.
    await scrollTo(0);
    await settle();
    expect(await asked()).toEqual([]);

    // A change: the tiles in view ask again, saying which picture they show; those scrolled away ask nothing.
    await page.evaluate('window.look = 2; so.revision(2)');
    await settle();
    expect(await asked()).toEqual([
      { id: 'c0', have: 'c0@1' },
      { id: 'c1', have: 'c1@1' },
      { id: 'c2', have: 'c2@1' }
    ]);
    // Each shows the new picture main gave.
    expect([await src('c0'), await src('c2')]).toEqual([await pic(2), await pic(2)]);
    // Scrolled back to them, the tiles that missed the change ask for the project as it is now.
    await scrollTo(800);
    await settle();
    expect((await asked()).sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      { id: 'c7', have: 'c7@1' },
      { id: 'c8', have: 'c8@1' },
      { id: 'c9', have: 'c9@1' }
    ]);
    expect(await src('c9')).toBe(await pic(2));

    // The panel hidden: a change asks for nothing at all.
    await page.evaluate('so.render(false)');
    await page.evaluate('window.look = 3; so.revision(3)');
    await settle();
    expect(await asked()).toEqual([]);
  });

  it('asks again for a tile that failed once the preview is ready again, with nothing changed', async () => {
    // Another opening: the pictures above are forgotten.
    await scrollTo(0);
    await settle();
    await page.evaluate("window.failing = new Set(['c1']); so.revision(1, 'opening-2'); so.render(true)");
    await settle();
    expect((await asked()).map((a) => a.id)).toEqual(['c0', 'c1', 'c2']);
    expect(await shown('c1')).toBe('failed');
    // The preview restarts, on a server where the component can be drawn: the failed tile asks again, the others do not.
    await page.evaluate("window.failing.clear(); so.runtime('starting')");
    await settle();
    expect(await asked()).toEqual([]);
    await page.evaluate("so.runtime('ready')");
    await settle();
    expect(await asked()).toEqual([{ id: 'c1', have: null }]);
    expect(await shown('c1')).toBe('ready');
  });
});
