/**
 * The Inspector's Advanced section offers an Anchor ID on a placed section wherever the anchor reaches the page: a
 * theme section, which is code placing `id={so_id}`, takes one (#1353), and code that places none offers it only to
 * clear one it still has. The real Inspector and store run in a real browser, over a project the engine made.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://inspector-anchor-field.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Inspector } from ${renderer('panels/Inspector')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { registerPacks } from ${JSON.stringify(resolve('src/catalogue/index'))};`,
  // As the editor does before it first renders.
  'window.packs = (list) => registerPacks(list);',
  "const root = createRoot(document.getElementById('root'));",
  'window.show = (state, patch) => {',
  "  flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', state }, pageId: state.site.homePageId, selection: null, leftTab: 'posts', postView: 'write', mode: 'edit', post: null, postPreviewAt: null, seoSubject: null, ...patch }));",
  "  flushSync(() => root.render(h('div', { id: 'dock-panel-inspect' }, h(Inspector))));",
  '};'
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
        name: 'inspector-anchor-field',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The Inspector did not bundle');
  return chunk.code;
}

/** The business starter with a Section on top, and a copy of the split hero whose code places no id. */
function project() {
  const s0 = createStarterState('business', 'Test Studio', false);
  const home = s0.site.homePageId;
  const r = applyOperations(s0, [
    { type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, componentId: 'layout.section' },
    { type: 'component.duplicate', definitionId: 'foundation.hero.split', name: 'Plain hero' }
  ]);
  const s: ProjectState = r.state;
  const section = r.results[0].nodeId as string;
  const plainDef = s.components[r.results[1].definitionId as string];
  plainDef.source = plainDef.source!.replace(/\s+id=\{\s*so_id[^}]*\}/g, '');
  const hero = s.pages[home].rootIds.find((id) => s.components[(s.pages[home].nodes[id] as InstanceNode).definitionId]?.componentId === 'hero.split')!;
  const plain = structuredClone(s);
  (plain.pages[home].nodes[hero] as InstanceNode).definitionId = plainDef.id;
  return { s, plain, home, section, hero };
}

describe.skipIf(!browserInstalled)('the Anchor ID of a placed section (#1353)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const { s, plain, home, section, hero } = project();

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 800, height: 900 } });
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
    // Advanced starts closed; open it as a person who opened it before would find it.
    await page.evaluate(() => localStorage.setItem('section:advanced', '1'));
    await page.evaluate((list) => (globalThis as unknown as { packs: (l: unknown) => void }).packs(list), listThemes() as unknown);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  /** The labels of the fields Advanced shows for the selected node. */
  const advanced = async (state: ProjectState, nodeId: string) => {
    const selection = { owner: { kind: 'page', id: home }, instancePath: [], nodeId };
    await page.evaluate(([st, sel]) => (globalThis as unknown as { show: (a: unknown, b: unknown) => void }).show(st, { leftTab: null, selection: sel }), [state, selection] as const);
    await page.getByLabel('Layer name').waitFor();
    return page.locator('#dock-panel-inspect label').allInnerTexts();
  };

  it('offers it on the theme’s Section and Split hero, and no entrance', async () => {
    for (const id of [section, hero]) {
      const labels = await advanced(s, id);
      expect(labels).toContain('Anchor ID');
      expect(labels).not.toContain('Entrance');
    }
  });

  it('leaves it out of code that places no id, unless it still has an anchor to clear', async () => {
    expect(await advanced(plain, hero)).not.toContain('Anchor ID');
    const stale = structuredClone(plain);
    stale.pages[home].nodes[hero].anchor = 'old';
    expect(await advanced(stale, hero)).toContain('Anchor ID');
    expect(await page.getByLabel('Anchor ID').inputValue()).toBe('old');
  });
});
