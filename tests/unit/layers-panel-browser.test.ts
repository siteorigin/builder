/**
 * Layers' rows in a real browser (#971): moving the selection renders only the rows it changes (the rows are
 * memoized and read only whether they are, or hold, the selection), and picking a row again still puts the tree's one
 * tab stop back on it, as it did when every row rendered again with each pick.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://layers-panel.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, Profiler } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { LayersPanel } from ${renderer('panels/LayersPanel')};`,
  `import { useStore } from ${renderer('store')};`,
  // The project, made here with the theme packs loaded (tests/unit/setup.ts), as a snapshot brings it.
  'const state = window.__project;',
  'window.log = { commits: 0 };',
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', leftTab: 'layers', layersView: 'layers', pageId: state.site.homePageId, snapshot: { state, revision: 1, workspaceKey: 'w1' }, selection: null }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Profiler, { id: 'layers', onRender: () => window.log.commits++ }, h('div', { className: 'side-panel-view' }, h(LayersPanel)))));",
  'window.home = state.site.homePageId;',
  'window.store = useStore;'
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
        name: 'layers-panel',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Layers did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('Layers rows (#971)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];
  // A blog too, so a collection's layouts can be opened (#953).
  const state = applyOperations(createStarterState('business', 'Test Studio', false), [{ type: 'collection.create', collectionId: 'posts', archiveTemplate: 'start' } as EditOperation]).state;
  const project = JSON.stringify(state).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project};</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.locator('.layers-tree [role="treeitem"][data-owner^="page:"]').first().waitFor();
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  /** The page's top-level rows (its sections), in order. */
  const sections = () => page.locator('.layers-tree [role="treeitem"][data-owner^="page:"][aria-level="1"]');
  /** The rows that are the tree's tab stop, by node, and the row keyboard focus is on. */
  const stops = () =>
    page.evaluate<{ stops: string[]; focused: string | null; selected: string[] }>(`({
      stops: [...document.querySelectorAll('.layers-tree [role="treeitem"]')].filter((r) => r.tabIndex === 0).map((r) => r.dataset.node ?? r.dataset.slot ?? '?'),
      focused: document.activeElement?.closest('[role="treeitem"]')?.dataset.node ?? null,
      selected: [...document.querySelectorAll('.layers-tree [role="treeitem"][aria-selected="true"]')].map((r) => r.dataset.node)
    })`);

  it('puts the tab stop back on a row picked again after focus moved away from it', async () => {
    const a = await sections().nth(0).getAttribute('data-node');
    const b = await sections().nth(1).getAttribute('data-node');
    expect(a && b).toBeTruthy();
    await sections().nth(0).locator('.layer-name').click();
    await page.keyboard.press('Enter');
    expect(await stops()).toEqual({ stops: [a], focused: a, selected: [a] });
    // Focus alone moves down (Ctrl+↓), taking the tab stop with it; the selection stays.
    await page.keyboard.press('Control+ArrowDown');
    const moved = await stops();
    expect(moved.selected).toEqual([a]);
    expect(moved.stops).toEqual([moved.focused]);
    expect(moved.focused).not.toBe(a);
    // A plain ↑ back onto the selected row picks it again: it is the one tab stop once more.
    await page.keyboard.press('ArrowUp');
    expect(await stops()).toEqual({ stops: [a], focused: a, selected: [a] });
  });

  /** The head's switcher, by what it names; the page rows of its menu, with whether each is chosen. */
  const subject = () => page.locator('.panel-head .layers-subject');
  const switcherRows = () =>
    page.evaluate<Array<{ name: string; checked: string | null }>>(`[...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((r) => ({ name: r.textContent.replace(/\\s+/g, ' ').trim(), checked: r.getAttribute('aria-checked') }))`);
  const store = (patch: string) => page.evaluate(`window.store.setState(${patch})`);
  const storeRead = <T>(expr: string) => page.evaluate<T>(`(() => { const s = window.store.getState(); return ${expr}; })()`);

  it('opens no chat from Edit with AI… on a row that went while its menu was open (#1585)', async () => {
    await store(`{ chatMode: 'ask', rightTab: 'inspect' }`);
    const chat = () => storeRead<string[]>('[s.chatMode, s.rightTab]');
    const item = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Edit with AI…' });
    const gone = await sections().nth(1).getAttribute('data-node');
    await sections().nth(1).locator('.layer-name').dispatchEvent('contextmenu');
    await item.waitFor();
    // As an AI run or a change on disk takes it away: a new snapshot without the section.
    await page.evaluate((id) => {
      const { snapshot } = (window as any).store.getState();
      const state = structuredClone(snapshot.state);
      const p = state.pages[state.site.homePageId];
      p.rootIds = p.rootIds.filter((x: string) => x !== id);
      delete p.nodes[id];
      (window as any).store.setState({ snapshot: { ...snapshot, state, revision: 2 } });
    }, gone);
    await item.click();
    expect(await chat()).toEqual(['ask', 'inspect']);
    // A row still there is edited.
    await sections().nth(0).locator('.layer-name').dispatchEvent('contextmenu');
    await item.click();
    expect(await chat()).toEqual(['edit', 'chat']);
  });

  it('names the page Layers shows in its head, and switches page from there (#953)', async () => {
    const about = state.site.pageOrder.find((id) => state.pages[id].route === '/about/')!;
    await expect.poll(() => subject().getAttribute('aria-label')).toBe('Home, switch page');
    expect(await page.locator('.panel-head h3').innerText()).toBe('Home');
    await subject().click();
    const rows = await switcherRows();
    expect(rows.find((r) => r.name.startsWith('Home'))).toEqual({ name: 'HomeHome page · /', checked: 'true' });
    expect(rows.find((r) => r.name.startsWith('About'))).toEqual({ name: 'About/about/', checked: 'false' });
    await page.locator('[role="menu"] [role^="menuitem"]', { hasText: 'About' }).click();
    await expect.poll(() => storeRead<string>('s.pageId')).toBe(about);
    await expect.poll(() => subject().innerText()).toBe('About');
    // The Headings view keeps the same head.
    await page.locator('.layers-views [role="tab"]', { hasText: 'Headings' }).click();
    await expect.poll(() => subject().getAttribute('title')).toBe('Headings of About: switch page');
  });

  it('labels a component or layout with its kind, and opens a page from it even when it is the page underneath (#953)', async () => {
    await store(`{ definitionMode: { definitionId: 'foundation.hero.split', returnPageId: window.home } }`);
    await expect.poll(() => subject().innerText()).toBe('Component: Split hero');
    await subject().click();
    // Nothing is chosen: Layers shows the component, not the page under it.
    expect((await switcherRows()).filter((r) => r.checked === 'true')).toEqual([]);
    await page.locator('[role="menu"] [role^="menuitem"]', { hasText: 'Home' }).click();
    await expect.poll(() => storeRead<boolean>('s.definitionMode === null && s.pageId === window.home')).toBe(true);
    await expect.poll(() => subject().innerText()).toBe('Home');

    const name = state.collections.posts.settings.name;
    await store(`{ templateMode: { collectionId: 'posts', entryId: null } }`);
    await expect.poll(() => subject().innerText()).toBe(`Layout: ${name}`);
    await store(`{ templateMode: { collectionId: 'posts', entryId: null, archive: true } }`);
    await expect.poll(() => subject().innerText()).toBe(`Layout: ${name} index`);
    await subject().click();
    expect((await switcherRows()).filter((r) => r.checked === 'true')).toEqual([]);
    // Choosing the page under the layout leaves the layout for the page.
    await page.locator('[role="menu"] [role^="menuitem"]', { hasText: 'Home' }).click();
    await expect.poll(() => storeRead<boolean>('s.templateMode === null && s.pageId === window.home')).toBe(true);
    await expect.poll(() => subject().innerText()).toBe('Home');
  });
});
