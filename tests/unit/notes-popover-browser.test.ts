/**
 * The toolbar's Notes (#770) in a real browser, with the app's own styles: the count of open notes, the checklist,
 * a note pinned where the editor is, resolving one, and a note taking the editor to its page and element.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://notes-popover.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { NotesControl } from ${renderer('panels/NotesPopover')};`,
  `import { useStore } from ${renderer('store')};`,
  'window.__store = useStore;',
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', pageId: state.site.homePageId, snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], recentExports: [], diagnostics: [] }, notes: { ...window.__notes, opening: 'w1' } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h('header', { className: 'toolbar' }, h(NotesControl))));"
].join('\n');

/** The preload bridge: the notes calls are recorded and answered by the page's `__answer`; everything else answers nothing. */
const BRIDGE = `
  window.__calls = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path.startsWith('notes.')) {
        window.__calls.push([path, ...args]);
        return Promise.resolve(window.__answer(path, args));
      }
      return any('');
    }
  });
  window.builder = any('');
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'notes-popover', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the Notes popover did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

describe.skipIf(!browserInstalled)('the toolbar’s Notes (#770)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let page: Page;
  let errors: string[];
  const state = createStarterState('business', 'Test Studio', false);
  const home = state.site.homePageId;
  const other = Object.keys(state.pages).find((id) => id !== home)!;
  const node = Object.keys(state.pages[other].nodes)[0];
  const target = { owner: { kind: 'page', id: other }, instancePath: [], nodeId: node };
  // The page the note is on no longer shows the shared header its element is in.
  state.pages[other].showHeader = false;
  const header = { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: Object.keys(state.site.shell.header.nodes)[0] };
  const notes = {
    notes: [
      { id: 'n1', text: 'Swap this hero photo', authorName: 'Ann', authorRole: 'viewer', createdAt: Date.now() - 5 * 60_000, pageId: other, target, resolved: false },
      { id: 'n5', text: 'Fix the menu', authorName: 'Ann', authorRole: 'viewer', createdAt: Date.now() - 60_000, pageId: other, target: header, resolved: true },
      { id: 'n2', text: 'Fixed the price', authorName: 'Bo', authorRole: 'collaborator', createdAt: Date.now() - 60_000, pageId: home, target: null, resolved: true }
    ],
    guestNotes: true
  };

  beforeAll(async () => {
    [built, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const open = async () => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const project = JSON.stringify(state).replace(/</g, '\\u003c');
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: built.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: built.styles });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project}; window.__notes = ${JSON.stringify(notes)};
          window.__answer = (path, args) => {
            if (path === 'notes.add') return { ok: true, notes: { notes: [{ id: 'n3', text: args[1].text, authorName: 'Host', authorRole: 'host', createdAt: Date.now(), pageId: args[1].pageId, target: args[1].target, resolved: false }, ...window.__notes.notes], guestNotes: true } };
            if (path === 'notes.resolve') return { ok: true, notes: { notes: window.__notes.notes.map((n) => (n.id === args[1] ? { ...n, resolved: args[2] } : n)), guestNotes: true } };
            return { ok: true };
          };</script><script src="/app.js"></script>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.notes-btn').waitFor();
  };

  it('shows how many notes are open, lists them, and pins a new one where the editor is', async () => {
    await open();
    expect(await page.getAttribute('.notes-btn', 'aria-label')).toBe('Notes: 1 open');
    expect(await page.textContent('.notes-badge')).toBe('1');
    await page.click('.notes-btn');
    await page.locator('.notes-popover').waitFor();
    expect(await page.locator('.notes-list[aria-label="Open notes"] .notes-row').count()).toBe(1);
    expect(await page.textContent('.notes-list[aria-label="Open notes"] .notes-body')).toBe('Swap this hero photo');
    expect(await page.textContent('.notes-list[aria-label="Open notes"] .notes-meta')).toMatch(/^Ann · 5 min ago · .+ on /);
    expect(await page.textContent('.notes-done summary')).toBe('Resolved (2)');
    // Pinned to the page shown, since nothing on it is selected.
    expect(await page.textContent('.notes-where')).toBe(`On ${state.pages[home].title}`);
    await page.fill('.notes-form textarea', 'Confirm the pricing copy');
    expect(await page.textContent('.notes-count')).toBe('24/280');
    await page.keyboard.press('Enter');
    await page.locator('.notes-list[aria-label="Open notes"] .notes-row').nth(1).waitFor();
    expect(await page.evaluate<unknown[]>('window.__calls')).toEqual([['notes.add', 'w1', { text: 'Confirm the pricing copy', pageId: home, target: null }]]);
    expect(await page.inputValue('.notes-form textarea')).toBe('');
    expect(await page.textContent('.notes-badge')).toBe('2');
  });

  it('resolves a note, and takes the editor to a note’s page with its element selected', async () => {
    await open();
    await page.click('.notes-btn');
    await page.locator('.notes-popover').waitFor();
    // The box follows the host's answer: the note moves to Resolved once it is kept.
    await page.click('.notes-list[aria-label="Open notes"] input[type="checkbox"]');
    await page.locator('.notes-list[aria-label="Open notes"] .notes-empty').waitFor();
    expect(await page.evaluate<unknown[]>('window.__calls')).toEqual([['notes.resolve', 'w1', 'n1', true]]);
    // A resolved note still goes where it is about.
    await page.click('.notes-done summary');
    await page.click('.notes-done .notes-jump >> text=Swap this hero photo');
    expect(await page.locator('.notes-popover').count()).toBe(0);
    const at = await page.evaluate<{ pageId: string; selection: unknown }>('(() => { const s = window.__store.getState(); return { pageId: s.pageId, selection: s.selection }; })()');
    expect(at).toEqual({ pageId: other, selection: target });
  });

  it('opens the page alone, and says so, for an element its page no longer shows', async () => {
    await open();
    await page.click('.notes-btn');
    await page.click('.notes-done summary');
    expect(await page.textContent('.notes-done .notes-row >> nth=0 >> .notes-meta')).toContain('(element since removed)');
    await page.click('.notes-done .notes-jump >> text=Fix the menu');
    const at = await page.evaluate<{ pageId: string; selection: unknown; toasts: string[] }>('(() => { const s = window.__store.getState(); return { pageId: s.pageId, selection: s.selection, toasts: s.toasts.map((t) => t.text) }; })()');
    expect(at).toMatchObject({ pageId: other, selection: null });
    expect(at.toasts).toContain('What that note was pinned to is no longer on the page.');
  });

  it('keeps a guest’s unsent note while the host pauses notes, and sends it once they are back (#1508)', async () => {
    await open();
    await page.evaluate(`window.__store.setState({ remote: { phase: 'admitted', joinId: 'j1', role: 'viewer' }, snapshot: { ...window.__store.getState().snapshot, workspaceKey: 'remote:j1' }, notes: { ...window.__notes, guestNotes: true, opening: 'remote:j1' } })`);
    await page.click('.notes-btn');
    await page.fill('.notes-form textarea', 'Swap the banner');
    const pause = (on: boolean) => page.evaluate(`window.__store.setState({ notes: { ...window.__store.getState().notes, guestNotes: ${on} } })`);
    await pause(false);
    await page.getByText('The host has turned off notes from guests.').waitFor();
    expect(await page.inputValue('.notes-form textarea')).toBe('Swap the banner');
    expect(await page.isDisabled('.notes-form button[type="submit"]')).toBe(true);
    expect(await page.getAttribute('.notes-form textarea', 'readonly')).not.toBeNull();
    await page.locator('.notes-form textarea').press('Enter');
    expect(await page.evaluate<unknown[]>('window.__calls')).toEqual([]);
    await pause(true);
    expect(await page.inputValue('.notes-form textarea')).toBe('Swap the banner');
    expect(await page.isDisabled('.notes-form button[type="submit"]')).toBe(false);
    await page.click('.notes-form button[type="submit"]');
    await page.waitForFunction('window.__calls.length === 1');
    expect(((await page.evaluate<unknown[][]>('window.__calls'))[0][2] as { text: string }).text).toBe('Swap the banner');
  });
});
