/**
 * Site details' redirect form, in a real browser against a project whose save the test holds. The list shows a new
 * redirect as soon as the project has it, before the save is answered: on a slow disk (a Windows laptop) there is time
 * to open that redirect's own form meanwhile, and the add finishing must leave that form open.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://redirect-form.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

// The project's copy changes only when the test lets a save through, just before its reply, as the main process sends
// the changed project before it answers the save.
const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { RedirectsFields } from ${src('renderer/src/panels/RedirectsManager')};`,
  'function App() {',
  '  const [project, setProject] = useState({ state: window.before, revision: 1 });',
  '  window.landInState = () => flushSync(() => setProject({ state: window.after, revision: 2 }));',
  '  return h(RedirectsFields, { state: project.state, problems: [], revision: project.revision });',
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing, except a save, which waits for the test. */
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
  /** The project takes the save: the list shows it, and the save is not answered yet. */
  window.take = () => window.landInState();
  /** The oldest save is answered. */
  window.answer = () => window.saves.shift().resolve({ ok: true, revision: 2, results: [{}] });
`;

// The project before and after the redirect the form adds: to Home, the page it offers first.
const before = createStarterState('business', 'Kloof Studio', false);
const ADD = { type: 'redirect.add', from: '/old-services/', pageId: before.site.pageOrder[0] } as const;
const after = applyOperations(before, [ADD]).state;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'redirect-form',
        enforce: 'pre',
        // Stylesheets are left out (the page loads the shared ones); a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The form did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the redirect form', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 600, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : new URL(route.request().url()).pathname === '/states.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: `window.before = ${JSON.stringify(before)};\nwindow.after = ${JSON.stringify(after)};` })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script src="/states.js"></script><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const saves = () => page.evaluate<number>('window.saves.length');

  it('leaves a redirect’s own form open when the add that made it is answered after it opened', async () => {
    await page.getByRole('button', { name: 'Add redirect' }).click();
    await page.getByRole('textbox', { name: 'Old address' }).fill('/old-services/');
    await page.getByRole('button', { name: 'Add redirect' }).click();
    await expect.poll(saves).toBe(1);
    expect(await page.evaluate('window.saves[0].batch.operations')).toEqual([ADD]);
    // The list has the new redirect while its save is still being written, and the author opens it.
    await page.evaluate('window.take()');
    await page.getByRole('button', { name: 'Edit the redirect from /old-services/' }).click();
    const edit = page.getByRole('form', { name: 'Where /old-services/ sends visitors' });
    await edit.waitFor();
    await page.evaluate('window.answer()');
    // The add is done, and the form open now is another one: it stays.
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    expect(await edit.count()).toBe(1);
    await edit.getByRole('radio', { name: 'An address' }).check();
    expect(await edit.getByRole('textbox', { name: 'Address', exact: true }).count()).toBe(1);
  });

  it('names the draft at an old address, which takes it over once it is published (#1363)', async () => {
    const about = Object.values(before.pages).find((p) => p.title === 'About')!.id;
    const held = [
      { type: 'redirect.add', from: '/old-studio/', pageId: about },
      { type: 'page.create', pageId: 'pg_draft', title: 'Studio rewrite' },
      { type: 'page.update', pageId: 'pg_draft', draft: true },
      { type: 'page.update', pageId: 'pg_draft', route: '/old-studio/' }
    ] as const;
    const state = held.reduce((s, op) => applyOperations(s, [op]).state, before);
    await page.evaluate((s) => {
      (window as unknown as { after: unknown }).after = s;
      (window as unknown as { take: () => void }).take();
    }, state);
    const row = page.locator('[data-from="/old-studio/"]');
    await row.waitFor();
    expect(await row.locator('.so-redirect-main').innerText()).toMatch(/About \(\/about\/\)\s+Added by you · The draft “Studio rewrite” has this address and takes it over once it is published$/);
  });

  it('closes once its own add is answered', async () => {
    await page.getByRole('button', { name: 'Add redirect' }).click();
    await page.getByRole('textbox', { name: 'Old address' }).fill('/old-services/');
    await page.getByRole('button', { name: 'Add redirect' }).click();
    await expect.poll(saves).toBe(1);
    await page.evaluate('window.take()');
    await page.evaluate('window.answer()');
    await expect.poll(() => page.getByRole('form', { name: 'New redirect' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Edit the redirect from /old-services/' }).count()).toBe(1);
  });
});
