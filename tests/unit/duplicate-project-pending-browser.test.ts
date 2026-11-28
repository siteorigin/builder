/**
 * Duplicate project copies what the project holds (#1373): a change still on its way is saved first, and one that can't
 * be saved (text a field refused, an edit kept on hold) stops the copy before any folder is made, with what it is said
 * in the dialog. The real dialog, fields and store run in a real browser, against a bridge that holds each save until
 * the test lets it through and records every copy asked for.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://duplicate-pending.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

// The editor's Public URL field refuses an address without https:// and keeps it, as Site details does. The dialog
// opens over it, as it opens over the editor. A change to the brand color is sent as the store sends every change.
const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { DraftInput } from ${renderer('components/ui')};`,
  `import { DuplicateProjectModal } from ${renderer('components/ProjectDialogs')};`,
  `import { applyOps, markDraft, useStore } from ${renderer('store')};`,
  `import { HELD_DRAFT } from ${renderer('lib/pending')};`,
  "useStore.setState({ screen: 'editor', snapshot: { state: window.__project, revision: 1, workspaceKey: 'w1', dir: '/projects/test-studio', conflicts: [], diagnostics: [] } });",
  'window.holdEdit = () => markDraft(HELD_DRAFT, true);',
  "window.saveColor = (v) => void applyOps([{ type: 'token.set', tokenId: 'color.brand', value: v }], 'Change Brand');",
  'function App() {',
  '  const [open, setOpen] = useState(false);',
  '  window.openDuplicate = () => flushSync(() => setOpen(true));',
  // The project closing takes the dialog with it, whatever it is doing.
  '  window.dropDuplicate = () => flushSync(() => setOpen(false));',
  "  const https = (v) => (v.startsWith('https://') ? null : { message: 'Start the address with https://.' });",
  '  return h(',
  "    'div',",
  '    null,',
  "    h(DraftInput, { className: 'input', ariaLabel: 'Public URL', value: 'https://studio.example', check: https, onCommit: () => true }),",
  '    open && h(DuplicateProjectModal, { onClose: () => setOpen(false), onOpen: () => undefined })',
  '  );',
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing, except a save, held for the test to land, and a copy, recorded. */
const BRIDGE = `
  window.saves = [];
  window.copies = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path === 'project.apply') return new Promise((resolve) => window.saves.push({ batch: args[0], resolve }));
      if (path === 'projects.duplicate') {
        window.copies.push({ ...args[0], saves: window.saves.length });
        return Promise.resolve({ ok: true, dir: args[0].parentDir + '/test-studio-copy', name: args[0].name });
      }
      return any('');
    }
  });
  window.builder = any('');
  /** Let the oldest save through. */
  window.land = () => window.saves.shift().resolve({ ok: true, revision: 2, results: [{}] });
`;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'duplicate-pending',
        enforce: 'pre',
        // Stylesheets are left out (the page loads the shared ones); a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The Duplicate project dialog did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('Duplicate project settles what is being typed first (#1373)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const project = JSON.stringify(createStarterState('blank', 'Test Studio', false)).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1100, height: 700 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${BRIDGE}window.__project = ${project};</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const dialog = () => page.getByRole('dialog');
  const copies = () => page.evaluate<Array<{ name: string; parentDir: string; saves: number }>>('window.copies');
  const duplicateButton = () => dialog().getByRole('button', { name: 'Duplicate', exact: true });
  const duplicate = async (by: 'click' | 'enter' = 'click') => {
    await page.evaluate('window.openDuplicate()');
    await dialog().getByRole('heading', { name: 'Duplicate project' }).waitFor();
    if (by === 'click') await duplicateButton().click();
    else await dialog().getByRole('textbox', { name: 'Copy name' }).press('Enter');
  };
  const problem = () => dialog().getByRole('alert');

  it('makes no copy while a field keeps an address it refused, and says which', async () => {
    const url = page.getByRole('textbox', { name: 'Public URL' });
    await url.fill('studio.example/new');
    await url.press('Tab');
    await duplicate();
    await expect.poll(() => problem().innerText()).toContain('What you typed in Public URL can’t be saved.');
    expect(await problem().innerText()).toContain('wasn’t copied');
    expect(await copies()).toEqual([]);
    expect(await dialog().getByRole('heading', { name: 'Copy created' }).count()).toBe(0);
    // Duplicate takes focus, reading the problem out, and can be tried again once the change is saved or discarded.
    await expect.poll(() => duplicateButton().evaluate((b) => b === document.activeElement)).toBe(true);
    expect(await duplicateButton().isEnabled()).toBe(true);
    // The address stays unsaved, as typed, for the author to correct once the dialog is closed.
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    expect(await url.inputValue()).toBe('studio.example/new');
  });

  it('makes no copy while an edit is kept on hold', async () => {
    await page.evaluate('window.holdEdit()');
    await duplicate();
    await expect.poll(() => problem().innerText()).toContain('An edit you made has not been saved yet.');
    expect(await copies()).toEqual([]);
    expect(await dialog().getByRole('heading', { name: 'Copy created' }).count()).toBe(0);
  });

  it('copies once a change still being saved has landed, never before', async () => {
    await page.evaluate("window.saveColor('#123456')");
    await expect.poll(() => page.evaluate<number>('window.saves.length')).toBe(1);
    await duplicate('enter');
    // The copy waits for the save, whatever it takes, and says what it is waiting for.
    await expect.poll(() => dialog().getByRole('status').innerText()).toContain('Saving your changes first');
    await page.waitForTimeout(300);
    expect(await copies()).toEqual([]);
    await page.evaluate('window.land()');
    await dialog().getByRole('heading', { name: 'Copy created' }).waitFor();
    expect(await copies()).toEqual([{ name: 'Test Studio copy', parentDir: '/projects', opening: 'w1', saves: 0 }]);
    expect(await dialog().innerText()).toContain('with every change made so far');
  });

  it('makes no copy once the dialog has gone with its project while a change was being saved', async () => {
    await page.evaluate("window.saveColor('#123456')");
    await expect.poll(() => page.evaluate<number>('window.saves.length')).toBe(1);
    await duplicate();
    await expect.poll(() => dialog().getByRole('status').innerText()).toContain('Saving your changes first');
    await page.evaluate('window.dropDuplicate()');
    await page.evaluate('window.land()');
    await page.waitForTimeout(300);
    expect(await copies()).toEqual([]);
  });
});
