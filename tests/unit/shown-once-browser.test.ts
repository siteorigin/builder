/**
 * Panels built the first time they show (#1042): a project opens with only the panels it shows built, and a panel
 * shown once stays mounted, held while hidden (lib/hideable), with its DOM and what was typed into it kept. The real
 * boundaries and store run in a real browser, the editor's sidebar as Editor.tsx lays it out.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://shown-once.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useLayoutEffect, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Hideable, ShownOnce } from ${renderer('lib/hideable')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { useLeaveInspectorForSeo } from ${renderer('panels/SeoView')};`,
  "const VIEWS = ['pages', 'posts', 'insert', 'seo'];",
  // How many times each panel was built (mounted), and, after every commit of the editor, how many elements the shown
  // view held: a view shown empty for a commit would show here as 0.
  'window.log = { built: {}, commits: [], blurs: 0 };',
  'function Panel({ id }) {',
  '  useState(() => { window.log.built[id] = (window.log.built[id] ?? 0) + 1; });',
  '  const [q, setQ] = useState("");',
  '  const zoom = useStore((s) => s.zoom);',
  '  return h("div", { id: `panel-${id}` }, h("input", { id: `q-${id}`, "aria-label": `Search ${id}`, value: q, onChange: (e) => setQ(e.target.value) }), h("b", { id: `zoom-${id}` }, String(zoom)));',
  '}',
  'function Editor() {',
  '  const leftTab = useStore((s) => s.leftTab);',
  '  useLeaveInspectorForSeo();',
  '  useLayoutEffect(() => { window.log.commits.push(`${leftTab}:${leftTab ? document.querySelector(`[data-view="${leftTab}"]`).childElementCount : "-"}`); });',
  // The Inspector's field goes as the SEO view comes in front, as the real Inspector's do: a blur after the commit is too late.
  '  return h("main", null, h("div", { id: "dock-panel-inspect" }, leftTab === "seo" ? null : h("input", { id: "insp-field", "aria-label": "Heading", onBlur: () => window.log.blurs++ })), h("aside", null, VIEWS.map((t) => h("div", { key: t, "data-view": t, hidden: leftTab !== t }, h(ShownOnce, { shown: leftTab === t }, h(Hideable, { hidden: leftTab !== t }, h(Panel, { id: t })))))));',
  '}',
  "flushSync(() => useStore.setState({ leftTab: 'pages', zoom: 1, snapshot: { workspaceKey: 'w1' }, postView: 'write', mode: 'edit', post: null }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  'window.so = { set: (patch) => flushSync(() => useStore.setState(patch)) };'
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
        name: 'shown-once',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The sidebar did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('a panel built the first time it shows (#1042)', { timeout: 30_000 }, () => {
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
  const log = () => page.evaluate<{ built: Record<string, number>; commits: string[]; blurs: number }>('window.log');

  it('builds only the view that shows, and no other however the store changes', async () => {
    expect((await log()).built).toEqual({ pages: 1 });
    expect(await page.locator('#panel-posts, #panel-insert').count()).toBe(0);
    for (const zoom of [2, 3]) await set({ zoom });
    await set({ leftTab: null });
    expect((await log()).built).toEqual({ pages: 1 });
    expect(await page.locator('#panel-posts, #panel-insert').count()).toBe(0);
  });

  it('builds a view in the commit that first shows it, up to date, never shown empty', async () => {
    await set({ zoom: 4 });
    await set({ leftTab: 'insert' });
    expect((await log()).built).toEqual({ pages: 1, insert: 1 });
    expect(await page.locator('#zoom-insert').textContent()).toBe('4');
    expect((await log()).commits.filter((c) => c.startsWith('insert:'))).toEqual(['insert:1']);
  });

  it('leaves a field with focus in the Inspector as the SEO view first comes in front, built only then', async () => {
    await page.locator('#insp-field').focus();
    // The sidebar's shortcut, from the field: the field still has the focus when the view is asked for.
    await set({ leftTab: 'seo' });
    expect((await log()).blurs).toBe(1);
    expect(await page.evaluate(`document.activeElement?.id ?? null`)).not.toBe('insp-field');
    expect((await log()).built).toEqual({ pages: 1, seo: 1 });
  });

  it('keeps a view shown once mounted while hidden, with its DOM and what was typed into it', async () => {
    await set({ leftTab: 'insert' });
    await page.locator('#q-insert').fill('hero');
    await page.evaluate(`window.held = document.getElementById('panel-insert')`);
    await set({ leftTab: 'posts' });
    await set({ zoom: 5 });
    await set({ leftTab: null });
    await set({ leftTab: 'insert' });
    expect((await log()).built).toEqual({ pages: 1, insert: 1, posts: 1 });
    expect(await page.evaluate(`window.held === document.getElementById('panel-insert')`)).toBe(true);
    expect(await page.locator('#q-insert').inputValue()).toBe('hero');
    expect(await page.locator('#zoom-insert').textContent()).toBe('5');
  });
});
