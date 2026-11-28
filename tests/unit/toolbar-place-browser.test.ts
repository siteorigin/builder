/**
 * The toolbar's page switcher names what the canvas shows (#1110): while a collection's entry layout or index layout
 * is open it names the layout, with no home glyph and no page checked in its menu, and names the page again once the
 * layout is left. Its Mode toggle has the SEO view as a third option (#1583). The real toolbar and store run in a
 * real browser.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://toolbar-place.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Toolbar } from ${renderer('panels/Toolbar')};`,
  `import { setState, useStore } from ${renderer('store')};`,
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', leftTab: 'layers', pageId: state.site.homePageId, snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], history: { canUndo: false, canRedo: false } }, selection: null }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Toolbar)));",
  'window.__store = useStore;',
  // As the editor's own panels change it, so the panel before the SEO view is remembered.
  'window.storeSet = (patch) => flushSync(() => setState(patch));',
  'window.set = (patch) => flushSync(() => useStore.setState(patch));'
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
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
        name: 'toolbar-place',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The toolbar did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('Toolbar place name (#1110)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];
  const state = applyOperations(createStarterState('business', 'Test Studio', false), [
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'First post', publishedAt: '2026-01-12', draft: false, body: ['Hello.'] },
    { type: 'collection.update', collectionId: 'posts', archiveTemplate: 'start' }
  ]).state;
  const home = state.pages[state.site.homePageId].title;
  const name = state.collections.posts.settings.name;
  const project = JSON.stringify(state).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext({ viewport: { width: 1440, height: 800 } })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project};</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.locator('.project-title').waitFor();
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const set = (patch: Record<string, unknown>) => page.evaluate((p) => (globalThis as unknown as { set: (p: unknown) => void }).set(p), patch);
  const place = () => page.locator('.project-title .page').innerText();
  const homeGlyphs = () => page.locator('.project-title .page .lucide-house').count();

  it.each([
    ['entry layout', { collectionId: 'posts', entryId: 'en_one' }, `${name} layout`],
    ['entry layout shown on no entry', { collectionId: 'posts', entryId: null }, `${name} layout`],
    ['index layout', { collectionId: 'posts', entryId: null, archive: true }, `${name} index layout`]
  ])('names the open %s, then the page again on leaving it', async (_, templateMode, title) => {
    expect(await place()).toBe(home);
    expect(await homeGlyphs()).toBe(1);
    await set({ templateMode });
    expect(await place()).toBe(title);
    expect(await homeGlyphs()).toBe(0);
    expect(await page.locator('.project-title').getAttribute('title')).toContain(`/ ${title}:`);
    expect(await page.getByRole('button', { name: new RegExp(`${title}$`) }).count()).toBe(1);
    await set({ templateMode: null });
    expect(await place()).toBe(home);
    expect(await homeGlyphs()).toBe(1);
  });

  it('names what covers a layout: the SEO view, a post previewed, or a component edited everywhere', async () => {
    await set({ templateMode: { collectionId: 'posts', entryId: 'en_one' } });
    await set({ leftTab: 'seo' });
    expect(await place()).toBe('SEO');
    await set({ leftTab: 'posts', postView: 'preview', mode: 'preview', post: { collectionId: 'posts', entryId: 'en_one' }, postPreviewAt: null });
    expect(await place()).toBe('First post');
    const [definitionId, definition] = Object.entries(state.components)[0];
    await set({ leftTab: 'layers', mode: 'edit', definitionMode: { definitionId, returnPageId: state.site.homePageId } });
    expect(await place()).toBe(definition.name);
    // Preview alone, as a visitor following a link to an entry sees it, names the layout.
    await set({ definitionMode: null, mode: 'preview', postView: 'write', post: null });
    expect(await place()).toBe(`${name} layout`);
  });

  it('offers SEO as the Mode toggle’s third option, chosen while the SEO view is open (#1583)', async () => {
    const mode = page.getByRole('radiogroup', { name: 'Mode' });
    const radio = (name: string) => mode.getByRole('radio', { name, exact: true });
    const checked = () => mode.locator('[aria-checked="true"]').getAttribute('aria-label');
    const leftTab = () => page.evaluate(() => (globalThis as unknown as { __store: { getState: () => { leftTab: string | null; mode: string } } }).__store.getState());
    expect(await mode.getByRole('radio').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(['Edit', 'Preview', 'SEO']);
    expect(await checked()).toBe('Edit');
    // The rail's SEO entry (or any other way in) and the toggle agree.
    await page.evaluate(() => (globalThis as unknown as { storeSet: (p: unknown) => void }).storeSet({ leftTab: 'seo' }));
    expect(await checked()).toBe('SEO');
    for (const name of ['Edit', 'Preview']) {
      expect(await radio(name).isDisabled(), `${name} leaves the view`).toBe(false);
      expect(await radio(name).getAttribute('title')).not.toContain('covers the canvas');
    }
    await radio('Preview').click();
    expect(await leftTab()).toMatchObject({ leftTab: 'layers', mode: 'preview' });
    expect(await checked()).toBe('Preview');
    await radio('SEO').click();
    expect(await leftTab()).toMatchObject({ leftTab: 'seo', mode: 'preview' });
    await radio('Edit').click();
    expect(await leftTab()).toMatchObject({ leftTab: 'layers', mode: 'edit' });
    // One radio group: one tab stop, and the arrow keys step through all three and wrap.
    expect(await mode.locator('[tabindex="0"]').getAttribute('aria-label')).toBe('Edit');
    await radio('Edit').focus();
    await page.keyboard.press('ArrowLeft');
    expect(await leftTab()).toMatchObject({ leftTab: 'seo' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('SEO');
    await page.keyboard.press('ArrowRight');
    expect(await leftTab()).toMatchObject({ leftTab: 'layers', mode: 'edit' });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Edit');
    // A guest in a live session has no SEO view, so no SEO option.
    await set({
      remote: { phase: 'admitted', joinId: 'j1', relayUrl: 'https://relay.test', roomId: 'r1', displayName: 'Guest', hostConnected: true, reconnecting: false, guestId: 'g1', role: 'collaborator', projectName: 'Host project', guestExpiresAt: null, sessionExpiresAt: null, relayClockOffsetMs: 0, hostRuntime: 'ready', previewRevision: 1, previewUrl: null, previewProblem: null, tooLarge: false, participants: [] },
      snapshot: { state, revision: 1, workspaceKey: 'remote:j1', conflicts: [], history: { canUndo: false, canRedo: false } }
    });
    expect(await mode.getByRole('radio').count()).toBe(2);
  });

  it('follows the collection being renamed, and goes back to the page when the collection is gone', async () => {
    await set({ templateMode: { collectionId: 'posts', entryId: 'en_one' } });
    const snapshot = (next: typeof state) => set({ snapshot: { state: next, revision: 2, workspaceKey: 'w1', conflicts: [], history: { canUndo: false, canRedo: false } } });
    await snapshot({ ...state, collections: { posts: { ...state.collections.posts, settings: { ...state.collections.posts.settings, name: 'Journal' } } } });
    expect(await place()).toBe('Journal layout');
    await snapshot({ ...state, collections: {} });
    expect(await place()).toBe(home);
    expect(await homeGlyphs()).toBe(1);
  });

  it('checks no page in the menu while a layout is open', async () => {
    const checked = page.locator('[role="menu"] [role="menuitemradio"][aria-checked="true"]');
    await set({ templateMode: { collectionId: 'posts', entryId: 'en_one' } });
    await page.locator('.project-title').click();
    await page.locator('[role="menu"]').waitFor();
    expect(await checked.count()).toBe(0);
    // The open menu follows the layout being left.
    await set({ templateMode: null });
    expect(await checked.count()).toBe(1);
  });
});
