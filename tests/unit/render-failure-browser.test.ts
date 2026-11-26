/**
 * A screen that fails while rendering (#886) shows what happened and a way back, instead of React unmounting the whole
 * editor to a blank window: Reload editor loads the page again, and Close project, offered while a project is open,
 * leaves it. The real boundary runs in a real browser.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://render-failure.test';

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { RenderFailure } from ${JSON.stringify(resolve('src/renderer/src/components/RenderFailure'))};`,
  'function Screen() {',
  '  const [broken, setBroken] = useState(false);',
  '  window.breakScreen = () => flushSync(() => setBroken(true));',
  "  if (broken) throw new Error('Cannot read properties of undefined (reading \\'nodes\\')');",
  "  return h('main', { id: 'screen' }, 'The editor');",
  '}',
  'function Page() {',
  '  const [closable, setClosable] = useState(true);',
  '  window.setClosable = (on) => flushSync(() => setClosable(on));',
  "  return h(RenderFailure, { onCloseProject: closable ? () => window.closings.push('close') : undefined }, h(Screen));",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Page)));"
].join('\n');

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'render-failure', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The boundary did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('a screen that fails while rendering (#886)', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>window.closings = [];</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.locator('#screen').waitFor();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const failure = () => page.getByRole('alert');

  it('shows what happened in place of the screen, and reloads the editor', async () => {
    await page.evaluate('window.beforeFailure = true; window.breakScreen()');
    await failure().getByRole('heading', { name: 'The editor stopped working' }).waitFor();
    expect(await failure().innerText()).toContain("Cannot read properties of undefined (reading 'nodes')");
    expect(await page.locator('#screen').count()).toBe(0);

    await failure().getByRole('button', { name: 'Reload editor' }).click();
    await page.locator('#screen').waitFor();
    expect(await page.evaluate('window.beforeFailure')).toBeUndefined();
    expect(await failure().count()).toBe(0);
  });

  it('offers to close the project only when one is open', async () => {
    await page.evaluate('window.breakScreen()');
    await failure().getByRole('button', { name: 'Close project' }).click();
    expect(await page.evaluate('window.closings')).toEqual(['close']);

    await page.evaluate('window.setClosable(false)');
    expect(await failure().getByRole('button', { name: 'Close project' }).count()).toBe(0);
    expect(await failure().getByRole('button', { name: 'Reload editor' }).count()).toBe(1);
  });
});
