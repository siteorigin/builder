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
  'window.plainBlurs = 0;',
  "const ref = (nodeId) => ({ owner: { kind: 'page', id: 'home' }, instancePath: [], nodeId });",
  // A project with nothing in it, but a project: what was typed is named from it as it is typed (#1462).
  "const project = () => ({ pages: {}, components: {}, collections: {}, site: { shell: {} } });",
  "flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', state: project() }, pageId: 'home', selection: ref('hero') }));",
  // Keyed as the Inspector keys what it shows: another selection, or with none another page, is another set of fields.
  'function Panel() {',
  '  const selection = useStore((s) => s.selection);',
  '  const pageId = useStore((s) => s.pageId);',
  "  const shows = selection ? selection.nodeId : 'page:' + pageId;",
  // What was saved, by which field, and what the editor had selected and open as it was saved.
  "  const commit = (v) => void window.commits.push([shows, v, useStore.getState().selection?.nodeId ?? null, useStore.getState().pageId]);",
  // A web address refused unless it starts https://: kept in the field, never sent.
  "  const check = (v) => (v.startsWith('https://') ? null : { message: 'Start it with https://' });",
  "  return h('div', { id: 'dock-panel-inspect' }, h('div', { key: JSON.stringify([selection, selection ? null : pageId]) },",
  "    h(DraftInput, { ariaLabel: 'Heading', value: 'Saved ' + shows, onCommit: commit }),",
  "    h(DraftInput, { ariaLabel: 'Supporting text', multiline: true, value: 'Saved text ' + shows, onCommit: commit }),",
  "    h(DraftInput, { ariaLabel: 'Web address', value: 'https://' + shows + '.test', onCommit: commit, check }),",
  // A control of its own (a choice's label): what it does as it goes is its own, and the store leaves it alone.
  "    h('input', { 'aria-label': 'Choice 1', defaultValue: 'Yes', onBlur: () => void window.plainBlurs++ })));",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Panel)));",
  'window.so = {',
  // Not flushed: the canvas writes the selection from a message, and React shows it when it next renders.
  '  pick: (nodeId) => setState({ selection: nodeId ? ref(nodeId) : null }),',
  '  page: (pageId) => setState({ pageId }),',
  // The project changed on disk and took the selected element with it.
  "  removed: () => setState({ snapshot: { workspaceKey: 'w', state: project() }, selection: null }),",
  "  notices: () => useStore.getState().toasts.map((t) => t.text),",
  '};',
  'window.useStore = () => useStore.getState();'
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

  const commits = () => page.evaluate<Array<[string, string, string | null, string]>>('window.commits');
  const notices = () => page.evaluate<string[]>('so.notices()');
  const focused = () => page.evaluate<string | null>('document.activeElement?.getAttribute("aria-label") ?? null');

  /** Types `text` in the field named `name`, leaving focus in it, as an author who has not pressed Enter: nothing is saved yet. */
  const type = async (name: string, text: string) => {
    const field = page.getByRole('textbox', { name, exact: true });
    const before = (await commits()).length;
    await field.click();
    await field.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
    expect(await focused()).toBe(name);
    expect(await field.inputValue()).toBe(text);
    expect(await commits()).toHaveLength(before);
  };
  const shown = (name: string) => page.getByRole('textbox', { name, exact: true }).inputValue();

  for (const [name, tag] of [
    ['Heading', 'INPUT'],
    ['Supporting text', 'TEXTAREA']
  ]) {
    it(`saves what was typed in ${name} for the element it was typed for when the canvas selects another`, async () => {
      expect(await page.evaluate<string>(`document.querySelector('[aria-label="${name}"]').tagName`)).toBe(tag);
      await type(name, 'Typed for the hero');
      await page.evaluate('so.pick("services")');
      await expect.poll(() => shown(name)).toBe(name === 'Heading' ? 'Saved services' : 'Saved text services');
      // Saved once, by the hero's own field, while the hero was still selected: never for the element picked next.
      expect(await commits()).toEqual([['hero', 'Typed for the hero', 'hero', 'home']]);
      expect(await notices()).toEqual([]);
    });
  }

  it('offers text its field refused to copy when the canvas selects another, and saves nothing', async () => {
    await type('Web address', 'harbour lane');
    await page.evaluate('so.pick("services")');
    await expect.poll(() => shown('Web address')).toBe('https://services.test');
    expect(await commits()).toEqual([]);
    expect(await notices()).toEqual(['What you typed in Web address can’t be saved. The field went away, so copy it to keep it.']);
  });

  it('leaves a control of its own to itself', async () => {
    await page.getByRole('textbox', { name: 'Choice 1', exact: true }).click();
    await page.keyboard.insertText(' please');
    await page.evaluate('so.pick("services")');
    await expect.poll(() => shown('Heading')).toBe('Saved services');
    expect(await page.evaluate('window.plainBlurs')).toBe(0);
  });

  it('saves page settings being typed when the canvas selects an element, and when another page opens', async () => {
    await page.evaluate('so.pick(null)');
    await expect.poll(() => shown('Heading')).toBe('Saved page:home');
    await type('Heading', 'Home’s own');
    await page.evaluate('so.pick("hero")');
    await expect.poll(() => shown('Heading')).toBe('Saved hero');
    expect(await commits()).toEqual([['page:home', 'Home’s own', null, 'home']]);
    await page.evaluate('so.pick(null)');
    await expect.poll(() => shown('Heading')).toBe('Saved page:home');
    await type('Heading', 'Still Home’s');
    await page.evaluate('so.page("about")');
    await expect.poll(() => shown('Heading')).toBe('Saved page:about');
    // Saved while Home was still open, by Home's own settings.
    expect(await commits()).toEqual([
      ['page:home', 'Home’s own', null, 'home'],
      ['page:home', 'Still Home’s', null, 'home']
    ]);
    expect(await notices()).toEqual([]);
  });

  it('writes nothing for an element a change to the project took away, and offers what was typed to copy', async () => {
    await type('Heading', 'Typed for the hero');
    await page.evaluate('so.removed()');
    await expect.poll(() => shown('Heading')).toBe('Saved page:home');
    expect(await commits()).toEqual([]);
    await expect.poll(notices).toEqual(['What you were typing was not saved, because the field went away.']);
  });

  it('keeps the author typing when a pick selects what is already selected, on this page or another', async () => {
    await type('Heading', 'Still typing');
    await page.evaluate('window.typedIn = document.activeElement');
    // The field is left, if at all, as the store changes: checked at once, and again once React has drawn the change.
    expect(await page.evaluate(`(so.pick("hero"), [useStore().selection.nodeId, document.activeElement.getAttribute('aria-label')])`)).toEqual(['hero', 'Heading']);
    expect(await page.evaluate(`(so.page("about"), [useStore().pageId, document.activeElement.getAttribute('aria-label')])`)).toEqual(['about', 'Heading']);
    await page.evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r)))');
    expect(await page.evaluate('window.typedIn === document.activeElement && window.typedIn.isConnected')).toBe(true);
    expect(await shown('Heading')).toBe('Still typing');
    expect(await commits()).toEqual([]);
  });
});
