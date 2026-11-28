/**
 * Site settings' Integrations and Custom code sections in a real browser (#1485): what each action sends. A new
 * integration is added only by its Add button, never by leaving its field for Cancel or Escape; a removal sends its
 * null; code the check refuses stays in its field unsent, and code it takes is sent as typed.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://site-code.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { IntegrationFields, SiteCodeFields } from ${src('renderer/src/panels/SiteCode')};`,
  'window.patches = [];',
  'let root = null;',
  'window.so = {',
  '  mount: (which, site, developer) => {',
  '    root?.unmount();',
  "    root = createRoot(document.getElementById('root'));",
  '    const onChange = (patch) => (window.patches.push(patch), undefined);',
  "    flushSync(() => root.render(h(which === 'code' ? SiteCodeFields : IntegrationFields, { site, developer, onChange })));",
  '  },',
  '};'
].join('\n');

/** Every call to main answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => (path === 'on' ? () => {} : Promise.resolve(undefined))
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
        name: 'site-code',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The Site settings sections did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('Integrations and Custom code in Site settings (#1485)', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 400, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><button id="elsewhere">Elsewhere</button><script>${BRIDGE}</script><script src="/app.js"></script></body>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const site = (extra: Record<string, unknown> = {}) => ({ name: 'Riverside', language: 'en', pageOrder: [], ...extra });
  const mount = (which: 'integrations' | 'code', s: Record<string, unknown>, developer = true) => page.evaluate(([w, x, d]) => (globalThis as unknown as { so: { mount(w: unknown, s: unknown, d: unknown): void } }).so.mount(w, x, d), [which, s, developer] as unknown[]);
  const patches = () => page.evaluate<unknown[]>('window.patches');

  it('adds Fathom only from its Add button, and Cancel or Escape adds nothing', async () => {
    await mount('integrations', site());
    await page.getByRole('button', { name: 'Add Fathom Analytics' }).click();
    const id = page.getByRole('textbox', { name: 'Site ID' });
    await expect.poll(() => id.evaluate((e) => e === document.activeElement)).toBe(true);
    await id.fill('ABCDEFGH');
    // Leaving the field for Cancel saves nothing: the ID is only ever the form's until Add.
    await page.getByRole('button', { name: 'Cancel adding Fathom Analytics' }).click();
    expect(await patches()).toEqual([]);
    expect(await page.getByRole('textbox', { name: 'Site ID' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Add Fathom Analytics' }).click();
    await page.getByRole('textbox', { name: 'Site ID' }).fill('ABCDEFGH');
    await page.keyboard.press('Escape');
    expect(await page.getByRole('textbox', { name: 'Site ID' }).count()).toBe(0);
    expect(await patches()).toEqual([]);
    // An ID it cannot use is said beside the field and sent nowhere; one it can is sent trimmed, by Add or Enter.
    await page.getByRole('button', { name: 'Add Fathom Analytics' }).click();
    await page.getByRole('textbox', { name: 'Site ID' }).fill('not an id!');
    await page.getByRole('button', { name: 'Add Fathom Analytics' }).click();
    expect(await page.getByRole('alert').textContent()).toMatch(/short code of letters and digits/);
    expect(await patches()).toEqual([]);
    await page.getByRole('textbox', { name: 'Site ID' }).fill('  ABCDEFGH ');
    await page.keyboard.press('Enter');
    expect(await patches()).toEqual([{ integrations: { fathom: { siteId: 'ABCDEFGH' } } }]);
  });

  it('changes an added integration’s ID as it is left, and removes it with Remove', async () => {
    await mount('integrations', site({ integrations: { fathom: { siteId: 'ABCDEFGH' } } }));
    expect(await page.getByText('Added. Counts visits to the published website').count()).toBe(1);
    const id = page.getByRole('textbox', { name: 'Site ID' });
    await id.fill('HGFEDCBA');
    await page.locator('#elsewhere').click();
    expect(await patches()).toEqual([{ integrations: { fathom: { siteId: 'HGFEDCBA' } } }]);
    await page.getByRole('button', { name: 'Remove Fathom Analytics' }).click();
    expect((await patches()).at(-1)).toEqual({ integrations: { fathom: null } });
  });

  it('says an added integration whose saved ID cannot be used counts nothing yet', async () => {
    await mount('integrations', site({ integrations: { fathom: { siteId: '???' } } }));
    expect(await page.getByText('Added, but not counting visits until its site ID is corrected.').count()).toBe(1);
    expect(await page.getByText('A Fathom site ID is a short code of letters and digits').count()).toBe(1);
  });

  it('sends head code and CSS as typed once they pass their checks, and keeps refused code unsent in its field', async () => {
    await mount('code', site());
    const head = page.locator('#site-head-code');
    await head.fill('<div>');
    await page.locator('#elsewhere').click();
    expect(await page.getByRole('alert').textContent()).toMatch(/^Line 1, column 1: <div> cannot go in the head/);
    expect(await head.inputValue()).toBe('<div>');
    expect(await patches()).toEqual([]);
    await head.fill('<meta name="a" content="b">');
    await page.locator('#elsewhere').click();
    await page.locator('#site-global-css').fill('a { color: red }\n');
    await page.locator('#elsewhere').click();
    expect(await patches()).toEqual([{ headCode: '<meta name="a" content="b">' }, { globalCss: 'a { color: red }\n' }]);
  });

  it('shows saved code to read without Developer mode, and changes nothing', async () => {
    await mount('code', site({ globalCss: 'a { color: red }' }), false);
    const css = page.locator('#site-global-css');
    expect(await css.inputValue()).toBe('a { color: red }');
    expect(await css.getAttribute('readonly')).not.toBeNull();
    expect(await page.locator('#site-head-code').inputValue()).toBe('');
  });
});
