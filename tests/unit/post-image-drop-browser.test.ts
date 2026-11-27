/**
 * Image files dropped on the post writer's text from the desktop (#1117): imported into Assets, then offered in the
 * picture dialog to describe and caption, going in at the block they were dropped on. The real writer and store run
 * in a real browser, over a stand-in for the preload bridge whose import the test releases; the library starts empty.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { assetUsages } from '@engine/apply';
import { image, run } from './fixtures/seo-site';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://post-image-drop.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PostWriter } from ${src('renderer/src/panels/PostWriter')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  'function Editor() {',
  '  const leftTab = useStore((s) => s.leftTab);',
  '  return h("div", { id: "writer" }, h(PostWriter, { hidden: leftTab !== "posts" }));',
  '}',
  'window.mount = (state, post, assetUsage) => {',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null }, pageId: state.site.homePageId,",
  "    leftTab: 'posts', post: { collectionId: 'posts', entryId: post }, postView: 'write'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  '};',
  'window.so = {',
  '  set: (patch) => flushSync(() => useStore.setState(patch)),',
  // A change as it arrives from main: the whole project, new objects throughout.
  '  change: (state) => flushSync(() => { const s = useStore.getState().snapshot; useStore.setState({ snapshot: { ...s, state, assetUsage: { ...s.assetUsage }, revision: s.revision + 1 } }); }),',
  '  toasts: () => useStore.getState().toasts.map((t) => t.text)',
  '};'
].join('\n');

/**
 * The preload bridge: a dropped file's path is its name under /drops (none for a file named `nopath`), every file is
 * reviewed as one to import as it is, every edit is taken, and the import waits for the test to release it with the IDs it added.
 */
const BRIDGE = `
  window.drop = { reviews: [], imports: [], release: null };
  const answers = {
    'pathForFile': (file) => (file.name === 'nopath' ? '' : '/drops/' + file.name),
    'project.reviewImport': (paths, only) => (window.drop.reviews.push({ paths, only }), Promise.resolve({ paths, rows: paths.map((path) => ({ path, action: 'import' })) })),
    // The text saved as it changes: the project takes it.
    'project.apply': () => Promise.resolve({ ok: true }),
    'project.importAssets': (paths, only) => new Promise((resolve) => { window.drop.imports.push({ paths, only }); window.drop.release = (assetIds) => resolve({ ok: true, assetIds }); })
  };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => (answers[path] ? answers[path](...args) : path === 'on' ? () => {} : Promise.resolve(undefined))
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
        name: 'post-image-drop',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The writer did not bundle');
  return chunk.code;
}

const BODY: RichText = [
  { type: 'p', spans: [{ text: 'Our spring classes open for bookings this week.' }] },
  { type: 'p', spans: [{ text: 'Every student leaves with a set of bowls.' }] },
  { type: 'p', spans: [{ text: 'Book early: places go fast.' }] }
];

/** Two posts and a library with no pictures in it. */
function site(): ProjectState {
  const s = run(
    createStarterState('blank', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring classes', publishedAt: '2027-03-02', draft: false, body: BODY },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_autumn', title: 'Autumn classes', publishedAt: '2027-09-02', draft: false, body: [{ type: 'p', spans: [{ text: 'Autumn is for glazing.' }] }] }
  );
  for (const id of Object.keys(s.assets.assets)) if (s.assets.assets[id].kind === 'image') delete s.assets.assets[id];
  return s;
}

describe.skipIf(!browserInstalled)('image files dropped on the post writer’s text (#1117)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const start = site();
  const kiln = image('img_kiln', { name: 'kiln.jpg', altSuggestion: 'The kiln, glowing orange' });
  /** The project once the import has added the kiln photo. */
  const withKiln = structuredClone(start);
  withKiln.assets.assets[kiln.id] = kiln;

  const body = () => page.locator('#writer .post-body');
  const blocks = () => page.evaluate(() => [...document.querySelectorAll('#writer .post-body > *')].map((b) => (b.matches('figure') ? `figure:${(b as HTMLElement).dataset.assetId}` : (b.textContent ?? '').trim())));
  const dialog = () => page.getByRole('dialog', { name: 'Add picture' });

  /** Drop files named `names` at a point on block `index` of the text (`edge`: its top or middle), or above the first. */
  async function drop(names: string[], index: number, edge: 'middle' | 'above' = 'middle') {
    await page.evaluate(
      ({ names, index, edge }) => {
        const root = document.querySelector<HTMLElement>('#writer .post-body')!;
        const box = (root.children[index] as HTMLElement).getBoundingClientRect();
        const data = new DataTransfer();
        for (const n of names) data.items.add(new File(['x'], n, { type: 'image/jpeg' }));
        const x = box.left + 8;
        const y = edge === 'above' ? box.top - 2 : box.top + box.height / 2;
        root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data }));
      },
      { names, index, edge }
    );
  }
  /** The import answers with `ids`, and the project's next change brings their records. */
  async function land(ids: string[], state: ProjectState = withKiln) {
    await page.waitForFunction(() => !!(window as unknown as { drop: { release: unknown } }).drop.release);
    await page.evaluate((ids) => (window as unknown as { drop: { release(ids: string[]): void } }).drop.release(ids), ids);
    await page.evaluate((s) => (window as unknown as { so: { change(s: unknown): void } }).so.change(s), state as unknown);
  }
  const imports = () => page.evaluate(() => (window as unknown as { drop: { imports: Array<{ paths: string[]; only: string }> } }).drop.imports);
  const toasts = () => page.evaluate(() => (window as unknown as { so: { toasts(): string[] } }).so.toasts());

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
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
    await page.evaluate(([state, usage]) => (globalThis as unknown as { mount(s: unknown, p: string, u: unknown): void }).mount(state, 'en_spring', usage), [start as unknown, assetUsages(start)] as const);
    await body().locator('p').first().waitFor();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('imports the dropped photo into an empty library and puts it, described and captioned, after the block it was dropped on', async () => {
    await drop(['kiln.jpg'], 1);
    await expect.poll(imports).toEqual([{ paths: ['/drops/kiln.jpg'], only: 'image' }]);
    // Nothing is asked until the photo is in Assets.
    expect(await dialog().count()).toBe(0);
    await land([kiln.id]);
    await dialog().waitFor();
    // The photo is chosen, with the description Assets suggests, ready to check and caption.
    expect(await dialog().getByLabel('Description').inputValue()).toBe('The kiln, glowing orange');
    await dialog().getByLabel('Caption').fill('First firing of the year.');
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await expect.poll(blocks).toEqual(['Our spring classes open for bookings this week.', 'Every student leaves with a set of bowls.', 'figure:img_kiln', 'Book early: places go fast.']);
    const fig = body().locator('figure.post-figure');
    expect(await fig.getAttribute('data-alt')).toBe('The kiln, glowing orange');
    expect(await fig.getAttribute('data-caption')).toBe('First firing of the year.');
  });

  it('puts a photo dropped above the first block before it, not at the end', async () => {
    await drop(['kiln.jpg'], 0, 'above');
    await land([kiln.id]);
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await expect.poll(blocks).toEqual(['figure:img_kiln', 'Our spring classes open for bookings this week.', 'Every student leaves with a set of bowls.', 'Book early: places go fast.']);
  });

  it('asks for a description when Assets suggests none, and Cancel leaves the text as it was', async () => {
    const plain = structuredClone(withKiln);
    delete plain.assets.assets[kiln.id].altSuggestion;
    await drop(['kiln.jpg'], 1);
    await land([kiln.id], plain);
    await dialog().waitFor();
    expect(await dialog().getByLabel('Description').inputValue()).toBe('');
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await dialog().getByText('Describe what the picture shows, or turn on Decorative image.').waitFor();
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => dialog().count()).toBe(0);
    expect(await blocks()).toEqual(BODY.map((b) => (b.type === 'p' ? b.spans[0].text : '')));
  });

  it('opens no dialog for an import that finishes after the author has moved to another post: the photo stays in Assets', async () => {
    await drop(['kiln.jpg'], 1);
    await expect.poll(async () => (await imports()).length).toBe(1);
    await page.evaluate(() => (window as unknown as { so: { set(p: unknown): void } }).so.set({ post: { collectionId: 'posts', entryId: 'en_autumn' } }));
    await body().getByText('Autumn is for glazing.').waitFor();
    await land([kiln.id]);
    await expect.poll(toasts).toContain('“kiln.jpg” was added to Assets.');
    expect(await dialog().count()).toBe(0);
    expect(await body().locator('figure').count()).toBe(0);
  });

  it('keeps only the latest of two drops: the first photo stays in Assets', async () => {
    await drop(['kiln.jpg'], 1);
    await page.waitForFunction(() => !!(window as unknown as { drop: { release: unknown } }).drop.release);
    const first = await page.evaluateHandle(() => (window as unknown as { drop: { release: unknown } }).drop.release);
    await page.evaluate(() => ((window as unknown as { drop: { release: unknown } }).drop.release = null));
    await drop(['wheel.jpg'], 0);
    await expect.poll(async () => (await imports()).length).toBe(2);
    const wheel = image('img_wheel', { name: 'wheel.jpg', altSuggestion: 'A potter’s wheel' });
    const both = structuredClone(withKiln);
    both.assets.assets[wheel.id] = wheel;
    await page.evaluate((r) => (r as (ids: string[]) => void)(['img_kiln']), first);
    await land([wheel.id], both);
    await dialog().waitFor();
    expect(await dialog().getByLabel('Description').inputValue()).toBe('A potter’s wheel');
    expect(await toasts()).toContain('“kiln.jpg” was added to Assets.');
  });

  it('imports nothing for a drop with no file on disk', async () => {
    await drop(['nopath'], 1);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await imports()).toEqual([]);
  });
});
