/**
 * A field keeps what was typed until the change has landed. Leaving a field puts the saved value back a moment
 * later (for text the project refused); that must wait for the change to reach this window, or on a slow disk (a
 * Windows laptop) the field flashes the value from before the edit until the project's copy catches up. The real
 * DraftInput and store run in a real browser, on a clock the test moves, against a project whose save the test holds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://draft-landing.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

// The field shows the project's value; the project's copy changes only once the save is let through, just before its
// reply, as the main process sends the changed project before it answers the save.
const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { DraftInput } from ${renderer('components/ui')};`,
  `import { applyOps } from ${renderer('store')};`,
  'function App() {',
  "  const [value, setValue] = useState('#d14131');",
  '  window.setSaved = (v) => flushSync(() => setValue(v));',
  "  return h(DraftInput, { className: 'input', ariaLabel: 'Brand color value', value, onCommit: (v) => applyOps([{ type: 'token.set', tokenId: 'color.brand', value: v }], 'Change Brand', 'token:color.brand') });",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing, except a save, which waits for the test to land or refuse it. */
const BRIDGE = `
  window.saves = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path !== 'project.apply') return any('');
      return new Promise((resolve) => window.saves.push({ batch: args[0], resolve }));
    }
  });
  window.builder = any('');
  /** Let the oldest save through: the project's copy changes first, then the save is answered. */
  window.land = () => {
    const s = window.saves.shift();
    window.setSaved(s.batch.operations[0].value);
    s.resolve({ ok: true, revision: 1, results: [{}] });
  };
  window.refuse = () => window.saves.shift().resolve({ ok: false, error: { code: 'INVALID', message: 'That is not a color.' } });
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
        name: 'draft-landing',
        enforce: 'pre',
        // Stylesheets are left out (the page loads the shared ones); a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The field did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('a field keeps what was typed until the change lands', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const field = () => page.getByRole('textbox', { name: 'Brand color value' });
  const saves = () => page.evaluate<number>('window.saves.length');
  const type = async (text: string) => {
    await field().fill(text);
    await field().press('Enter');
    await expect.poll(saves).toBe(1);
  };

  it('shows the typed text while a slow save is still being written, then the saved value', async () => {
    await type('rgba(209, 65, 49, 0.5)');
    // Longer than the field waits before it puts the saved value back: the save has not landed yet.
    await page.clock.runFor(2_000);
    expect(await field().inputValue()).toBe('rgba(209, 65, 49, 0.5)');
    await page.evaluate('window.land()');
    await page.clock.runFor(1_000);
    expect(await field().inputValue()).toBe('rgba(209, 65, 49, 0.5)');
  });

  it('puts the saved value back once a refusal has come back, not before', async () => {
    await type('not a color');
    await page.clock.runFor(2_000);
    expect(await field().inputValue()).toBe('not a color');
    await page.evaluate('window.refuse()');
    await page.clock.runFor(1_000);
    await expect.poll(() => field().inputValue()).toBe('#d14131');
  });
});
