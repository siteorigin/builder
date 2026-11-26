/**
 * Text typed in the Inspector is saved when a pick on the canvas selects something else (#896). A click on the page
 * takes no focus, so the field still has it when the selection changes, and the Inspector, keyed by the selection,
 * replaces it: a field removed while focused never hears its blur, and used to say its text was not saved. The real
 * draft field, store and Inspector handoff run in a real browser; the pick is a store write made outside React, as
 * the canvas's message handler makes it, through the editor's own `setState`.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://inspector-leave.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { DraftInput } from ${renderer('components/ui')};`,
  `import { setState, useStore } from ${renderer('store')};`,
  'window.commits = [];',
  "const ref = (nodeId) => ({ owner: { kind: 'page', id: 'home' }, instancePath: [], nodeId });",
  "flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', state: {} }, pageId: 'home', selection: ref('hero') }));",
  // Keyed as the Inspector keys what it shows: another selection, or with none another page, is another set of fields.
  'function Panel() {',
  '  const selection = useStore((s) => s.selection);',
  '  const pageId = useStore((s) => s.pageId);',
  "  const shows = selection ? selection.nodeId : 'page:' + pageId;",
  "  const commit = (v) => void window.commits.push([shows, v, useStore.getState().selection?.nodeId ?? null]);",
  "  return h('div', { id: 'dock-panel-inspect' }, h('div', { key: JSON.stringify([selection, selection ? null : pageId]) },",
  "    h(DraftInput, { ariaLabel: 'Heading', value: 'Saved ' + shows, onCommit: commit }),",
  "    h(DraftInput, { ariaLabel: 'Supporting text', multiline: true, value: 'Saved text ' + shows, onCommit: commit })));",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Panel)));",
  'window.so = {',
  // Not flushed: the canvas writes the selection from a message, and React shows it when it next renders.
  '  pick: (nodeId) => setState({ selection: nodeId ? ref(nodeId) : null }),',
  '  page: (pageId) => setState({ pageId }),',
  // The project changed on disk and took the selected element with it.
  "  removed: () => setState({ snapshot: { workspaceKey: 'w', state: {} }, selection: null }),",
  "  notices: () => useStore.getState().toasts.map((t) => t.text),",
  '};'
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
        name: 'inspector-leave',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The Inspector field did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('Inspector text and a pick on the canvas (#896)', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 800, height: 600 } });
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

  const commits = () => page.evaluate<Array<[string, string, string | null]>>('window.commits');
  const notices = () => page.evaluate<string[]>('so.notices()');
  const focused = () => page.evaluate<string | null>('document.activeElement?.getAttribute("aria-label") ?? null');

  /** Types `text` in the field named `name`, leaving focus in it, as an author who has not pressed Enter. */
  const type = async (name: string, text: string) => {
    const field = page.getByRole('textbox', { name, exact: true });
    await field.click();
    await field.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
    expect(await focused()).toBe(name);
  };

  for (const name of ['Heading', 'Supporting text']) {
    it(`saves what was typed in ${name} for the element it was typed for when the canvas selects another`, async () => {
      await type(name, 'Typed for the hero');
      await page.evaluate('so.pick("services")');
      await expect.poll(() => page.getByRole('textbox', { name, exact: true }).inputValue()).toBe(name === 'Heading' ? 'Saved services' : 'Saved text services');
      // Saved once, by the hero's own field, while the hero was still selected: never for the element picked next.
      expect(await commits()).toEqual([['hero', 'Typed for the hero', 'hero']]);
      expect(await notices()).toEqual([]);
    });
  }

  it('saves page settings being typed when the canvas selects an element, and when another page opens', async () => {
    await page.evaluate('so.pick(null)');
    await expect.poll(() => page.getByRole('textbox', { name: 'Heading', exact: true }).inputValue()).toBe('Saved page:home');
    await type('Heading', 'Home’s own');
    await page.evaluate('so.pick("hero")');
    await expect.poll(() => page.getByRole('textbox', { name: 'Heading', exact: true }).inputValue()).toBe('Saved hero');
    await page.evaluate('so.pick(null)');
    await expect.poll(() => page.getByRole('textbox', { name: 'Heading', exact: true }).inputValue()).toBe('Saved page:home');
    await type('Heading', 'Still Home’s');
    await page.evaluate('so.page("about")');
    await expect.poll(() => page.getByRole('textbox', { name: 'Heading', exact: true }).inputValue()).toBe('Saved page:about');
    expect(await commits()).toEqual([
      ['page:home', 'Home’s own', null],
      ['page:home', 'Still Home’s', null]
    ]);
    expect(await notices()).toEqual([]);
  });

  it('writes nothing for an element a change to the project took away, and offers what was typed to copy', async () => {
    await type('Heading', 'Typed for the hero');
    await page.evaluate('so.removed()');
    await expect.poll(() => page.getByRole('textbox', { name: 'Heading', exact: true }).inputValue()).toBe('Saved page:home');
    expect(await commits()).toEqual([]);
    expect(await notices()).toEqual(['What you were typing was not saved, because the field went away.']);
  });

  it('keeps the author typing when a pick selects what is already selected', async () => {
    await type('Heading', 'Still typing');
    await page.evaluate('so.pick("hero")');
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r)))');
    expect(await focused()).toBe('Heading');
    expect(await page.getByRole('textbox', { name: 'Heading', exact: true }).inputValue()).toBe('Still typing');
    expect(await commits()).toEqual([]);
  });
});
