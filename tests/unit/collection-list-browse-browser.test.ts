/**
 * The switch beside a collection list's query that lets visitors search, filter and sort what it shows (#1730): on a
 * connected list and on a query's loop, it sends the source with `browse: true` beside the query, editing the query
 * or what each item shows keeps it, and while it is on the collection's browse choices show beneath it. The real
 * controls and store run in a real browser, over a project the engine made, against a bridge that records each save.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { OwnerRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://collection-list-browse.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ListSourceSwitch, LoopSourceControls } from ${renderer('panels/CollectionListControls')};`,
  `import { useStore } from ${renderer('store')};`,
  "const root = createRoot(document.getElementById('root'));",
  'window.show = (state, owner, gridId, loopId) => {',
  "  flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', state, revision: 1 }, pageId: state.site.homePageId }));",
  '  const grid = state.pages[owner.id].nodes[gridId];',
  '  const schema = state.components[grid.definitionId].properties.people;',
  "  flushSync(() => root.render(h('div', null, h('section', { 'aria-label': 'Grid' }, h(ListSourceSwitch, { state, owner, node: grid, prop: 'people', schema, manual: null })), h('section', { 'aria-label': 'Loop' }, h(LoopSourceControls, { state, owner, node: state.pages[owner.id].nodes[loopId] })))));",
  '};'
].join('\n');

/** The preload bridge: every call answers nothing, but a save, which is recorded and answered. */
const BRIDGE = `
  window.saved = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path !== 'project.apply') return path === 'on' ? () => {} : Promise.resolve(undefined);
      window.saved.push(...args[0].operations);
      return Promise.resolve({ ok: true, revision: 2, results: [{}] });
    }
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
        name: 'collection-list-browse',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The controls did not bundle');
  return chunk.code;
}

const QUERY = { collectionId: 'homes', sort: [{ field: 'title' }], limit: 3 };

/** Homes that offer no browsing yet, a Team grid connected to them on Home, and a loop over them there. */
function project(browse: boolean): { s: ProjectState; owner: OwnerRef; grid: string; loop: string } {
  let s = createStarterState('business', 'Coast Realty', false);
  const owner: OwnerRef = { kind: 'page', id: s.site.homePageId };
  const apply = (...ops: EditOperation[]) => {
    const r = applyOperations(s, ops);
    s = r.state;
    return r.results[0]?.nodeId as string;
  };
  apply(
    { type: 'collection.create', collectionId: 'homes', name: 'Homes', kind: 'structured', route: '/homes/', fields: { garden: { type: 'boolean', label: 'Garden' } } } as EditOperation,
    { type: 'entry.create', collectionId: 'homes', entryId: 'en_cliff', title: 'Cliff Cottage', draft: false, values: { garden: true } } as EditOperation
  );
  const grid = apply({ type: 'node.insert', owner, parentId: null, componentId: 'team.grid' });
  apply({ type: 'instance.setListSource', owner, nodeId: grid, prop: 'people', source: { query: QUERY, fields: { name: 'title' }, ...(browse ? { browse: true as const } : {}) } });
  const box = apply({ type: 'node.insert', owner, parentId: null, primitive: 'container' });
  const loop = apply({ type: 'node.insert', owner, parentId: box, primitive: 'repeat', query: QUERY });
  if (browse) apply({ type: 'node.setRepeatSource', owner, nodeId: loop, source: { $query: QUERY, browse: true } });
  return { s, owner, grid, loop };
}

describe.skipIf(!browserInstalled)("a collection list's visitor browsing switch", { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 400, height: 1600 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const show = async (browse: boolean) => {
    const { s, owner, grid, loop } = project(browse);
    await page.evaluate(([state, o, g, l]) => (window as unknown as { show: (...a: unknown[]) => void }).show(state, o, g, l), [s, owner, grid, loop] as const);
    return { s, owner, grid, loop };
  };
  const saved = () => page.evaluate<EditOperation[]>('window.saved');
  const toggle = (area: string) => page.getByRole('region', { name: area }).getByRole('switch', { name: 'Visitors can search, filter and sort' });

  it('turns browsing on beside the query of a connected list and of a loop, leaving the query as it is', async () => {
    const { owner, grid, loop } = await show(false);
    await expect(toggle('Grid').getAttribute('aria-checked')).resolves.toBe('false');
    expect(await page.getByRole('group', { name: 'What visitors can use' }).count()).toBe(0);
    await toggle('Grid').click();
    await toggle('Loop').click();
    await expect.poll(() => saved().then((ops) => ops.length)).toBe(2);
    expect(await saved()).toEqual([
      { type: 'instance.setListSource', owner, nodeId: grid, prop: 'people', source: { query: QUERY, fields: { name: 'title' }, browse: true } },
      { type: 'node.setRepeatSource', owner, nodeId: loop, source: { $query: QUERY, browse: true } }
    ]);
  });

  it('keeps it while what each item shows changes, offers the choices beneath it, and turns it off', async () => {
    const { owner, grid, loop } = await show(true);
    const grid$ = page.getByRole('region', { name: 'Grid' });
    await expect(toggle('Grid').getAttribute('aria-checked')).resolves.toBe('true');
    // The collection offers nothing yet: the choices say so, and are there to pick.
    const choices = grid$.getByRole('group', { name: 'What visitors can use' });
    await expect(choices.innerText()).resolves.toMatch(/Choose at least one/);
    await expect(choices.getByRole('checkbox', { name: /Garden/ }).count()).resolves.toBe(1);
    await grid$.getByLabel('Role').selectOption({ label: 'Title' });
    await toggle('Loop').click();
    await expect.poll(() => saved().then((ops) => ops.length)).toBe(2);
    expect(await saved()).toEqual([
      { type: 'instance.setListSource', owner, nodeId: grid, prop: 'people', source: { query: QUERY, fields: { name: 'title', role: 'title' }, browse: true } },
      { type: 'node.setRepeatSource', owner, nodeId: loop, source: { $query: QUERY } }
    ]);
  });
});
