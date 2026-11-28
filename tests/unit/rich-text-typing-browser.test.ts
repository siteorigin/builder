/**
 * Typing in a rich text field keeps what was typed (#1369). The browser sends a keystroke's input event with nothing
 * else running, so anything that updates React state from that event before React reads it lets React draw the field
 * again first, with the text from before the keystroke, and the keystroke is lost. A synthetic event dispatched by a
 * test never shows this, so the real RichTextField and DraftInput run in a real browser, typed into with trusted
 * keyboard input.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Imported only so a change to the field reaches this test through the import graph (CI runs the tests a pull
// request's changes reach); the field itself is bundled for the browser.
import richSource from '../../src/renderer/src/components/RichTextField.tsx?raw';
import fieldSource from '../../src/renderer/src/components/ui.tsx?raw';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://rich-text-typing.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));
const TEXT = 'Book a stay with us.';

// The field shows the saved value, and saving it puts the new one back, as the Inspector's prop editor does.
const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { RichTextField } from ${renderer('components/RichTextField')};`,
  'window.commits = [];',
  'function App() {',
  `  const [value, setValue] = useState(${JSON.stringify(TEXT)});`,
  "  return h('div', { style: { width: '320px', padding: '16px' } },",
  "    h(RichTextField, { ariaLabel: 'Text', pages: {}, value, onCommit: (v) => { window.commits.push(v); setValue(v); } }),",
  "    h('input', { 'aria-label': 'Heading' })",
  '  );',
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = () => new Proxy(function () {}, { get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any()), apply: () => any() });
  window.builder = any();
`;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');
if (!richSource.includes('DraftInput') || !fieldSource.includes('export function DraftInput')) throw new Error('RichTextField no longer types into a DraftInput');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'rich-text-typing',
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

describe.skipIf(!browserInstalled)('typing in a rich text field', { timeout: 30_000 }, () => {
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

  const field = () => page.getByRole('textbox', { name: 'Text' });
  const commits = () => page.evaluate<string[]>('window.commits');

  it('keeps each character typed at the end of the text, and saves them on leaving', async () => {
    await field().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Today');
    expect(await field().inputValue()).toBe(`${TEXT} Today`);
    await page.keyboard.press('Tab');
    await expect.poll(commits).toEqual([`${TEXT} Today`]);
    expect(await field().inputValue()).toBe(`${TEXT} Today`);
  });

  it('replaces selected text with a typed sentence', async () => {
    await field().click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('A new sentence.');
    expect(await field().inputValue()).toBe('A new sentence.');
    await page.getByRole('textbox', { name: 'Heading' }).click();
    await expect.poll(commits).toEqual(['A new sentence.']);
  });

  it('follows text that arrives without a key (an input method, dictation) in the toolbar', async () => {
    const addItem = page.getByRole('button', { name: 'Add item' });
    await field().click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    const off = () => addItem.getAttribute('aria-disabled');
    await expect.poll(off).toBe('true');
    // Only an input event: no key goes down or up, so nothing but the text changing can tell the toolbar.
    await page.keyboard.insertText('- First item');
    expect(await field().inputValue()).toBe('- First item');
    await expect.poll(off).toBe(null);
  });

  it('follows the caret when the selection is replaced by the very same text', async () => {
    const bold = page.getByRole('button', { name: 'Bold' });
    const off = () => bold.getAttribute('aria-disabled');
    await field().click();
    await page.keyboard.press('ControlOrMeta+A');
    // Words selected: they can be made bold.
    await expect.poll(off).toBe(null);
    // As pasting the same words from a menu does: the text does not change, so the field reports no change, but the
    // selection is now a caret after them, with nothing to make bold.
    await page.evaluate((t) => document.execCommand('insertText', false, t), TEXT);
    expect(await field().inputValue()).toBe(TEXT);
    await expect.poll(off).toBe('true');
  });
});
