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
import { refExists } from '../../src/renderer/src/lib/model';
import { withManaged } from './fixtures/component-contract-designs';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://layers-panel.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, Profiler } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { LayersPanel } from ${renderer('panels/LayersPanel')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { inspectElement } from ${renderer('lib/actions')};`,
  // The project, made here with the theme packs loaded (tests/unit/setup.ts), as a snapshot brings it.
  'const state = window.__project;',
  'window.log = { commits: 0 };',
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', leftTab: 'layers', layersView: 'layers', pageId: state.site.homePageId, snapshot: { state, revision: 1, workspaceKey: 'w1' }, selection: null }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Profiler, { id: 'layers', onRender: () => window.log.commits++ }, h('div', { className: 'side-panel-view' }, h(LayersPanel)))));",
  'window.home = state.site.homePageId;',
  'window.store = useStore;',
  'window.inspectElement = inspectElement;'
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
    await page.evaluate(`(() => {
      const { snapshot } = window.store.getState();
      const state = structuredClone(snapshot.state);
      const p = state.pages[state.site.homePageId];
      p.rootIds = p.rootIds.filter((x) => x !== '${gone}');
      delete p.nodes['${gone}'];
      window.store.setState({ snapshot: { ...snapshot, state, revision: 2 } });
    })()`);
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

  /** Stands for the Inspector, which this bundle leaves out: a section with a field, drawn while the panel shows it. */
  const standInInspector = () =>
    page.evaluate(`(() => {
      const panel = document.body.appendChild(document.createElement('div'));
      panel.id = 'dock-panel-inspect';
      const draw = (s) => (panel.innerHTML = s.dockOpen && s.rightTab === 'inspect' ? '<div class="section"><div class="section-body"><input aria-label="First field"></div></div>' : '');
      draw(window.store.getState());
      window.store.subscribe(draw);
    })()`);
  const inspectItem = () => page.getByRole('menuitem', { name: 'Inspect', exact: true });
  const focusedLabel = () => page.evaluate<string | null>(`document.activeElement?.getAttribute('aria-label') ?? null`);

  for (const from of [
    { name: 'the panel closed', patch: `{ dockOpen: false, rightTab: 'inspect' }` },
    { name: 'the AI tab showing', patch: `{ dockOpen: true, rightTab: 'chat' }` },
    { name: 'Site styles showing', patch: `{ dockOpen: true, rightTab: 'styles' }` },
    { name: 'the Project tab showing', patch: `{ dockOpen: true, rightTab: 'project' }` },
    { name: 'the Inspector already open', patch: `{ dockOpen: true, rightTab: 'inspect' }` }
  ])
    it(`offers Inspect in a row's menu, which shows that element in the Inspector and moves focus there, from ${from.name} (#1586)`, async () => {
      await store(from.patch);
      await standInInspector();
      const row = sections().nth(1);
      const node = await row.getAttribute('data-node');
      await row.click({ button: 'right' });
      // With the other ways into the element, ahead of the AI's.
      const labels = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts();
      expect(labels.findIndex((l) => l.startsWith('Ask AI'))).toBe(labels.findIndex((l) => l.trim() === 'Inspect') + 1);
      await inspectItem().click();
      await expect.poll(focusedLabel).toBe('First field');
      expect(await storeRead('[s.dockOpen, s.rightTab, s.selection?.nodeId, s.layerSet]')).toEqual([true, 'inspect', node, null]);
      // The menu's own hand-back of focus to the row, which comes after it closes, does not take it back.
      await page.waitForTimeout(100);
      expect(await focusedLabel()).toBe('First field');
    });

  it('acts on the row its menu names when the selection has moved on, and not at all once that element has gone (#1586)', async () => {
    await standInInspector();
    await store(`{ dockOpen: true, rightTab: 'chat' }`);
    const named = await sections().nth(1).getAttribute('data-node');
    const other = await sections().nth(2).getAttribute('data-node');
    await sections().nth(1).click({ button: 'right' });
    // Meanwhile another element is selected, with a third picked beside it.
    await page.evaluate(`(() => {
      const ref = (nodeId) => ({ owner: { kind: 'page', id: window.home }, instancePath: [], nodeId });
      window.store.setState({ selection: ref(${JSON.stringify(other)}), layerSet: { owner: ref('').owner, ids: [${JSON.stringify(other)}, ${JSON.stringify(named)}], anchor: ${JSON.stringify(other)} } });
    })()`);
    await inspectItem().click();
    await expect.poll(focusedLabel).toBe('First field');
    expect(await storeRead('[s.selection?.nodeId, s.layerSet]')).toEqual([named, null]);


    await store(`{ rightTab: 'chat', selection: null }`);
    await sections().nth(1).click({ button: 'right' });
    await inspectItem().waitFor();
    // Taken out of the project while the menu is open.
    await page.evaluate(`(() => {
      const { snapshot } = window.store.getState();
      const state = structuredClone(snapshot.state);
      const tree = state.pages[window.home];
      tree.rootIds = tree.rootIds.filter((id) => id !== ${JSON.stringify(named)});
      delete tree.nodes[${JSON.stringify(named)}];
      window.store.setState({ snapshot: { ...snapshot, state, revision: 2 }, selection: null });
    })()`);
    await inspectItem().click();
    await page.waitForTimeout(100);
    expect(await storeRead('[s.rightTab, s.selection]')).toEqual(['chat', null]);
    expect(await focusedLabel()).not.toBe('First field');
  });

  it('stops waiting to move focus once another element is picked (#1586)', async () => {
    await store(`{ dockOpen: true, rightTab: 'chat' }`);
    // An element with no sections, as an empty slot has: only its name, until another is selected.
    const named = await sections().nth(1).getAttribute('data-node');
    await page.evaluate(`(() => {
      const panel = document.body.appendChild(document.createElement('div'));
      panel.id = 'dock-panel-inspect';
      const draw = (s) => (panel.innerHTML = s.selection?.nodeId === ${JSON.stringify(named)} ? '<div class="insp-name"><h3 tabindex="-1">Main</h3></div>' : '<div class="section"><div class="section-body"><input aria-label="First field"></div></div>');
      draw(window.store.getState());
      window.store.subscribe(draw);
    })()`);
    // Left alone, the name takes focus once nothing more has been drawn.
    await sections().nth(1).click({ button: 'right' });
    await inspectItem().click();
    await expect.poll(() => page.evaluate<string | undefined>(`document.activeElement?.closest('.insp-name')?.textContent`), { timeout: 3000 }).toBe('Main');
    await sections().nth(1).click({ button: 'right' });
    await inspectItem().click();
    await page.waitForTimeout(150);
    await sections().nth(2).locator('.layer-name').click();
    await page.waitForTimeout(1200);
    expect(await focusedLabel()).not.toBe('First field');
  });

  it('inspects an element picked in a repeated item that can’t be told from here, and stays in the site’s preview (#1586)', async () => {
    await standInInspector();
    await store(`{ mode: 'preview', rightTab: 'chat' }`);
    // A part of a placed component whose list the design holds, named by an item that list doesn't hold, as an entry
    // layout's list that leaves out its own entry names one.
    // The Services grid as a design drawn from data, with a card's title named by an item its list doesn't hold, as an
    // entry layout's list that leaves out its own entry names one.
    const drawn = withManaged(state, 'features.grid');
    const [pageId, grid] = Object.entries(drawn.pages).flatMap(([id, p]) => Object.values(p.nodes).flatMap((n) => (n.kind === 'instance' && drawn.components[n.definitionId]?.componentId === 'features.grid' ? [[id, n.id] as const] : [])))[0];
    const ref = { owner: { kind: 'page' as const, id: pageId }, instancePath: [grid], nodeId: 'card-title', itemPath: ['not-listed'] };
    expect(refExists(drawn, ref)).toBe(false);
    await page.evaluate(`window.store.setState({ snapshot: { ...window.store.getState().snapshot, state: ${JSON.stringify(drawn).replace(/</g, '\\u003c')}, revision: 2 } })`);
    await page.evaluate(`window.inspectElement(${JSON.stringify(ref)})`);
    await expect.poll(focusedLabel).toBe('First field');
    expect(await storeRead('[s.mode, s.rightTab, s.selection]')).toEqual(['preview', 'inspect', ref]);
  });

  it('leaves a post’s preview for Inspect, since the Inspector shows only the post there (#1586)', async () => {
    await standInInspector();
    const node = await sections().nth(1).getAttribute('data-node');
    await store(`{ mode: 'preview', postView: 'preview', post: { collectionId: 'posts', entryId: 'en_one' }, rightTab: 'chat' }`);
    await sections().nth(1).click({ button: 'right' });
    // Chosen with the keyboard.
    await inspectItem().focus();
    await page.keyboard.press('Enter');
    await expect.poll(focusedLabel).toBe('First field');
    expect(await storeRead('[s.mode, s.rightTab, s.selection?.nodeId]')).toEqual(['edit', 'inspect', node]);
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
