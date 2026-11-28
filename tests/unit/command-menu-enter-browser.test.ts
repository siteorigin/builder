/**
 * One Enter on a command menu result runs that result and nothing else (#1371). Picking "Export or publish your
 * website…" closes the menu and opens Export, which puts focus on its first control: with a project Project health has
 * notes on, that is the "Review in Project health" link. The same Enter must not go on to activate it.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://command-menu-enter.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

// The two dialogs as the editor draws them (src/renderer/src/Editor.tsx): whichever the store's modal names.
const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ExportModal } from ${renderer('panels/ExportModal')};`,
  `import { CommandMenu } from ${renderer('panels/CommandMenu')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { registerPacks } from ${JSON.stringify(resolve('src/catalogue/index'))};`,
  // The packs the editor receives before it first renders (src/renderer/src/main.tsx).
  'registerPacks(window.__packs);',
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'cmdk' }, keptSamples: [], snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], recentExports: [], diagnostics: [] } }));",
  // Every dialog the store names from here on, for the test to read.
  'window.__modals = [];',
  'useStore.subscribe((s) => void window.__modals.push(s.modal?.kind ?? null));',
  "function Modals() { const kind = useStore((s) => s.modal?.kind); return kind === 'export' ? h(ExportModal) : kind === 'cmdk' ? h(CommandMenu) : null; }",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Modals)));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'command-menu-enter', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the dialogs did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

describe.skipIf(!browserInstalled)('Command menu Enter (#1371)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let page: Page;
  const errors: string[] = [];
  // A blank project has notes in Project health and nothing else for Export to list, so Export opens on its "Review in
  // Project health" link.
  const project = JSON.stringify(createStarterState('blank', 'Test Studio', false)).replace(/</g, '\\u003c');
  const packs = JSON.stringify(listThemes()).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [built, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: built.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: built.styles });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project}; window.__packs = ${packs};</script><script src="/app.js"></script>` });
    });
    await page.goto(`${SITE}/`);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  it('opens Export and stays there when Enter picks its result', async () => {
    await page.getByRole('combobox', { name: 'Search pages, sections, content and commands' }).fill('export or publish');
    await expect.poll(() => page.locator('[role="option"][aria-selected="true"]').textContent()).toContain('Export or publish your website');
    await page.keyboard.press('Enter');
    // Anything the same Enter went on to do has happened by the next frames.
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))');
    // The menu closes, Export opens, and nothing follows it.
    expect(await page.evaluate('window.__modals.filter(Boolean)')).toEqual(['export']);
    // The case is the real one: Export lists Project health's notes, and opened on the link to them.
    expect(await page.getByTestId('export-health-summary').count()).toBe(1);
    expect(await page.evaluate('document.activeElement?.classList.contains("export-health-go")')).toBe(true);
    expect(errors).toEqual([]);
  });
});
