/**
 * The shared popup menu (Menu and useMenu in components/ui.tsx): a row that only states a fact is not a menu item
 * (the arrows pass it, a screen reader hears it once, in the menu's description, after its group's heading); the
 * button whose menu is up says so from React's own render; a menu given its rows as a function keeps up with them
 * while it is open, focus staying on the same row; and each run of radio items keeps its own choice.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://menu.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useRef, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { useMenu } from ${renderer('components/ui')};`,
  // As callers write them: only the row whose words change while the menu is up has an id.
  'const rowsFor = (where, extra) => [',
  '  { heading: "Used 2 times" },',
  '  { label: "Home", onSelect: () => {} },',
  '  ...(extra ? [{ label: "About", onSelect: () => {} }] : []),',
  '  { id: "in", info: true, label: where, hint: "2 times", icon: h("svg", { id: "fact-icon" }) },',
  '  { separator: true },',
  '  { label: "Fit", checked: false, onSelect: () => {} },',
  '  { label: "100%", checked: true, onSelect: () => {} },',
  '  { separator: true },',
  '  { label: "Light", checked: false, onSelect: () => {} },',
  '  { label: "Dark", checked: true, onSelect: () => {} },',
  '  { separator: true },',
  '  { label: "Leave", onSelect: () => {} }',
  '];',
  'function Host() {',
  '  const menu = useMenu();',
  '  const [where, setWhere] = useState("In Team row");',
  '  const [extra, setExtra] = useState(false);',
  '  const [, redraw] = useState(0);',
  '  const rows = useRef([]);',
  '  rows.current = where === null ? rowsFor("In Team row", extra).filter((r) => r.id !== "in") : rowsFor(where, extra);',
  '  window.so = { where: (w) => flushSync(() => setWhere(w)), extra: () => flushSync(() => setExtra(true)), redraw: () => flushSync(() => redraw((n) => n + 1)) };',
  '  return h("div", null,',
  '    h("button", { id: "a", ...menu.triggerProps("a"), onClick: (e) => menu.openAt(e.currentTarget, () => rows.current, "Manage") }, "A"),',
  '    h("button", { id: "b", ...menu.triggerProps("b"), onClick: (e) => menu.openAt(e.currentTarget, rowsFor("x"), "Other") }, "B"),',
  '    menu.node);',
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Host)));"
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
        name: 'menu',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The menu did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the shared popup menu', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const menu = () => page.getByRole('menu');
  const focused = () => page.evaluate<string>(`document.activeElement?.textContent ?? ''`);
  /** The menu's description as its ids name it, in order. */
  const description = () =>
    page.evaluate<string[]>(`(document.querySelector('[role="menu"]')?.getAttribute('aria-describedby')?.split(' ') ?? []).map((id) => document.getElementById(id)?.textContent ?? 'missing ' + id)`);
  const openByKeys = async (id: string) => {
    await page.locator(`#${id}`).focus();
    await page.keyboard.press('Enter');
    await menu().waitFor();
    await page.waitForFunction(`document.activeElement?.getAttribute('role')?.startsWith('menuitem')`);
  };

  it('keeps a fact out of the arrow order, without an icon, and gives it to a screen reader once, under its heading', async () => {
    await openByKeys('a');
    const fact = page.locator('.menu-info');
    expect(await fact.textContent()).toBe('In Team row, 2 times.');
    expect(await fact.getAttribute('role')).toBeNull();
    expect(await page.locator('#fact-icon').count()).toBe(0);
    // It is not one of the menu's items, and the arrows go from Home straight past it.
    expect(await menu().getByRole('menuitem', { name: /Team row/ }).count()).toBe(0);
    expect(await focused()).toBe('Home');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(`document.activeElement?.textContent === 'Fit'`);
    expect(await focused()).toBe('Fit');
    // Read as the menu's description: the heading of its group, then the fact, by ids an id list can hold.
    expect(await description()).toEqual(['Used 2 times.', 'In Team row, 2 times.']);
    expect(await page.evaluate<boolean>(`document.querySelector('[role="menu"]').getAttribute('aria-describedby').split(' ').every((id) => /^\\S+$/.test(id) && !!document.getElementById(id))`)).toBe(true);
  });

  it('marks only the button whose menu is up as expanded, from its own render', async () => {
    const expanded = () => Promise.all(['a', 'b'].map((id) => page.locator(`#${id}`).getAttribute('aria-expanded')));
    expect(await expanded()).toEqual(['false', 'false']);
    expect(await page.locator('#a').getAttribute('aria-haspopup')).toBe('menu');
    await page.locator('#a').click();
    await menu().waitFor();
    expect(await expanded()).toEqual(['true', 'false']);
    await page.evaluate('so.redraw()');
    expect(await expanded()).toEqual(['true', 'false']);
    await page.keyboard.press('Escape');
    await menu().waitFor({ state: 'detached' });
    expect(await expanded()).toEqual(['false', 'false']);
  });

  it('shows what is true now while it stays open, and keeps focus on the same row as rows come and go', async () => {
    await openByKeys('a');
    // The first item takes focus a frame after the menu opens; End then goes to the last.
    await expect.poll(focused).toBe('Home');
    await page.keyboard.press('End');
    await expect.poll(focused).toBe('Leave');
    // A row added above it leaves focus on the same command.
    await page.evaluate('so.extra()');
    await expect.poll(focused).toBe('Leave');
    await page.evaluate('so.where("In Footer band")');
    expect(await page.locator('.menu-info').textContent()).toBe('In Footer band, 2 times.');
    await page.evaluate('so.where(null)');
    expect(await page.locator('.menu-info').count()).toBe(0);
    expect(await focused()).toBe('Leave');
    expect(await description()).toEqual([]);
  });

  it('keeps the choice of each run of radio items', async () => {
    await page.locator('#a').click();
    await menu().waitFor();
    const checked = await menu().getByRole('menuitemradio', { checked: true }).allTextContents();
    expect(checked).toEqual(['100%', 'Dark']);
  });
});
