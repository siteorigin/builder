/**
 * An image's description typed and still focused when the author turns on Decorative image, or removes the image, is
 * kept (#1393): the field saves on leaving it, and the switch's write right after must build on that save rather than on
 * the value the editor last drew, which still has the old description until the edit comes back from the project.
 * The real editor runs in a real browser, under a parent that applies each change a moment later, as the project does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord, ImageValue, ProjectState } from '@shared/types';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://image-decorative.test';
const DEV = 'http://preview.image-decorative.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
const CSS = ['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/Inspector.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8')).join('\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ImageEditor } from ${src('renderer/src/panels/PropEditors')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  "const snapshot = (state) => ({ workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, diagnostics: [], recoveryNotes: [], aiBusy: false, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, recentExports: [], runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } });',
  'window.writes = [];',
  // The project: each change is applied a while after it is made, as an edit comes back from the main process. Until
  // then the editor is drawn again at once with the value as it was (a copy, as another snapshot would bring it).
  'function Host({ state, start }) {',
  '  const [value, setValue] = useState(start);',
  "  window.value = () => value;",
  // Another window's change, heard while the author types.
  '  window.replace = setValue;',
  '  return h(ImageEditor, { value, state, title: "Image", onChange: (v) => { window.writes.push(v); setValue((was) => ({ ...was })); setTimeout(() => setValue(v), 150); } });',
  '}',
  'window.image = (state, start) => {',
  "  flushSync(() => useStore.setState({ screen: 'editor', snapshot: snapshot(state), runtime: { state: 'ready', url: " + JSON.stringify(DEV) + ' } }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Host, { state, start })));",
  '};'
].join('\n');

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
        name: 'image-decorative',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The image editor did not bundle');
  return chunk.code;
}

function project(): ProjectState {
  const state = createStarterState('business', 'Decorative', false);
  for (const id of Object.keys(state.assets.assets)) delete state.assets.assets[id];
  state.assets.assets.hero = { id: 'hero', name: 'Hero', file: 'static/assets/hero.png', mime: 'image/png', bytes: 2000, width: 96, height: 72, hash: 'hero', kind: 'image', createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString() } as AssetRecord;
  return state;
}

describe.skipIf(!browserInstalled)('An image description still being typed survives the Decorative switch (#1393)', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${DEV}/**`, (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>@layer tokens, reset, base, primitives, layout, components;\n${CSS}</style><body><aside class="dock" style="width: 340px; height: 760px; overflow: auto"><div id="dock-panel-inspect"><div id="root"></div></div></aside><script>${BRIDGE}</script><script src="/app.js"></script></body>` })
    );
    await page.goto(`${SITE}/`);
    await page.evaluate(([s, v]) => (globalThis as unknown as { image(s: unknown, v: unknown): void }).image(s, v), [project() as unknown, { assetId: 'hero', alt: 'Old description' } satisfies ImageValue] as const);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const writes = () => page.evaluate<ImageValue[]>('window.writes');
  const settled = () => page.evaluate<ImageValue>('window.value()');
  const description = () => page.getByRole('textbox', { name: 'Image description' });
  const decorative = () => page.getByRole('switch', { name: 'Decorative image' });

  it('keeps the new description when Decorative is clicked straight from the field, and shows it again when cleared', async () => {
    await description().fill('A new description');
    await decorative().click();
    await expect.poll(settled).toEqual({ assetId: 'hero', alt: 'A new description', decorative: true });
    // Both writes carry the description just typed: the save on leaving the field, then the switch.
    expect((await writes()).map((w) => w.alt)).toEqual(['A new description', 'A new description']);
    await decorative().click();
    await expect.poll(settled).toEqual({ assetId: 'hero', alt: 'A new description', decorative: false });
    expect(await description().inputValue()).toBe('A new description');
  });

  it('builds the switch on an image another window put there while the description was typed, not on the typing', async () => {
    await description().fill('Red barn');
    await page.evaluate("window.replace({ assetId: 'hero', alt: 'City skyline' })");
    await decorative().click();
    // The description's save is still made, for the project to check against where typing began (and hold); the
    // switch builds on the image shown, not on that save.
    expect(await writes()).toEqual([
      { assetId: 'hero', alt: 'Red barn' },
      { assetId: 'hero', alt: 'City skyline', decorative: true }
    ]);
  });

  it('builds on what the project shows once the description came back, an Undo of it included', async () => {
    await description().fill('A new description');
    await description().blur();
    await expect.poll(settled).toEqual({ assetId: 'hero', alt: 'A new description' });
    await page.evaluate("window.replace({ assetId: 'hero', alt: 'Old description' })");
    await decorative().click();
    expect((await writes()).at(-1)).toEqual({ assetId: 'hero', alt: 'Old description', decorative: true });
  });

  it('keeps the new description when the image is removed straight from the field', async () => {
    await description().fill('A new description');
    await page.getByRole('button', { name: 'Remove image' }).click();
    await expect.poll(settled).toMatchObject({ assetId: null, alt: 'A new description' });
    expect((await writes()).at(-1)).toMatchObject({ assetId: null, alt: 'A new description' });
  });
});
