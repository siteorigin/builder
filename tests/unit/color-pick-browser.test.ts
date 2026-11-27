/**
 * A run of picks in the colour picker saves one step at a time (#970): steps picked while a save is on its way wait,
 * and only the newest is saved once that save has been answered, even when the picker has closed by then. An Undo
 * made meanwhile reaches the project after the drag's last step, so it takes back the whole drag. The real ColorPick
 * and store run in a real browser, against a project whose saves the test answers.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://color-pick.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

// The swatch shows the project's value, which changes once a save is answered; closing the picker takes the swatch away.
const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ColorPick } from ${renderer('components/ColorPick')};`,
  `import { applyOps, claimRefusals, projectHistory } from ${renderer('store')};`,
  'function App() {',
  "  const [value, setValue] = useState('#d14131');",
  '  const [open, setOpen] = useState(true);',
  '  window.setSaved = (v) => flushSync(() => setValue(v));',
  '  window.closePicker = () => flushSync(() => setOpen(false));',
  "  window.undo = () => projectHistory('undo');",
  // An edit made in another field, which answers its own refusals.
  "  window.otherEdit = () => claimRefusals((e) => (window.claimed.push(e.message), true), () => applyOps([{ type: 'token.set', tokenId: 'color.text', value: '#111111' }], 'Change Text'));",
  "  return open ? h(ColorPick, { value, label: 'Brand color', onPick: (v) => applyOps([{ type: 'token.set', tokenId: 'color.brand', value: v }], 'Change Brand', 'token:color.brand:picker') }) : null;",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing, except a save, which waits for the test, and an Undo. */
const BRIDGE = `
  window.calls = [];
  window.saves = [];
  /** The refusals the other field answered itself. */
  window.claimed = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path === 'project.undo') {
        window.calls.push('undo');
        return Promise.resolve({ ok: true, revision: 9 });
      }
      if (path !== 'project.apply') return any('');
      window.calls.push(args[0].operations[0].value);
      return new Promise((resolve) => window.saves.push({ batch: args[0], resolve }));
    }
  });
  window.builder = any('');
  /** Refuse the save at \`i\` in the order they were sent. */
  window.refuse = (i, message) => window.saves.splice(i, 1)[0].resolve({ ok: false, error: { code: 'INVALID_ARGUMENT', message } });
  /** Answer the oldest save: the project's copy changes first, then the save is answered. */
  window.land = () => {
    const s = window.saves.shift();
    window.setSaved?.(s.batch.operations[0].value);
    s.resolve({ ok: true, revision: 1, results: [{}] });
  };
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'color-pick',
        enforce: 'pre',
        // Stylesheets are left out; a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The swatch did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('a drag in the colour picker saves one step at a time', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 400, height: 300 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const calls = () => page.evaluate<Array<string>>('window.calls');
  /** The picker's value field: what it shows is the last step picked. */
  const field = () => page.locator('.color-pop input.color-pop-hex');
  /** Steps picked one after another in the open picker, each taken as it is entered, before any save is answered. */
  const drag = async (...steps: string[]) => {
    if (!(await page.locator('.color-pop').count())) {
      await page.locator('button.color-pick').click();
      await page.locator('.color-pop').waitFor();
    }
    for (const hex of steps) {
      await field().fill(hex);
      await field().press('Enter');
    }
  };

  it('saves the first step, then only the last one taken while it was saving', async () => {
    await drag('#0000ff', '#336699', '#2a9d8f', '#e76f51');
    expect(await calls()).toEqual(['#0000ff']);
    // The picker shows the last step picked, not the one being saved.
    expect(await field().inputValue()).toBe('#e76f51');
    await page.evaluate('window.land()');
    await expect.poll(calls).toEqual(['#0000ff', '#e76f51']);
    // The first step's save has landed, and the picker still shows the last step, not the one that landed.
    expect(await field().inputValue()).toBe('#e76f51');
    await page.evaluate('window.land()');
    await expect.poll(() => field().inputValue()).toBe('#e76f51');
    expect(await calls()).toEqual(['#0000ff', '#e76f51']);
  });

  it('saves the last step once the save before it is answered, though the picker closed mid-drag', async () => {
    await drag('#0000ff', '#336699', '#2a9d8f');
    await page.evaluate('window.closePicker()');
    expect(await page.locator('.color-pick').count()).toBe(0);
    // Closing sends nothing out of turn: the last step waits for the save before it.
    expect(await calls()).toEqual(['#0000ff']);
    await page.evaluate('window.land()');
    await expect.poll(calls).toEqual(['#0000ff', '#2a9d8f']);
  });

  it('sends an Undo made during the drag’s last save after its last step, so the Undo takes back the whole drag', async () => {
    await drag('#0000ff', '#336699', '#2a9d8f');
    await page.evaluate('window.undo()');
    expect(await calls()).toEqual(['#0000ff', '#2a9d8f', 'undo']);
  });

  it('sends an edit made elsewhere during the drag after its last step, which is an edit of its own', async () => {
    await drag('#0000ff', '#336699', '#2a9d8f');
    await page.evaluate('void window.otherEdit()');
    expect(await calls()).toEqual(['#0000ff', '#2a9d8f', '#111111']);
    // The step sent ahead of the other field's edit is not that field's: the field answers its own refusal, not the step's.
    await page.evaluate(`window.refuse(1, 'The color was refused.')`);
    await page.evaluate(`window.refuse(1, 'The text color was refused.')`);
    await page.evaluate('window.land()');
    await expect.poll(() => page.evaluate('window.claimed')).toEqual(['The text color was refused.']);
  });
});
