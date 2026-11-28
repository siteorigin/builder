/**
 * The post import review offers the blog it makes a link in the header menu (#1509): ticked, only while there is a menu
 * and the import makes the blog, passed on with the import, and what became of it said afterwards. The real dialog and
 * store run in a real browser over a stand-in for the preload bridge.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PostImportPreview, PostImportResult } from '@shared/api';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://post-import-menu.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PostImportReviewModal } from ${src('renderer/src/panels/PostImportReview')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  'window.mount = (state, preview) => {',
  "  const modal = { kind: 'post-import', opening: 'w', preview };",
  "  flushSync(() => useStore.setState({ screen: 'editor', modal, snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage: {}, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null } }));",
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(PostImportReviewModal, { preview, opening: 'w' })));",
  '};',
  'window.toasts = () => useStore.getState().toasts.map((t) => t.text);'
].join('\n');

/** The preload bridge: the import is recorded, and answered with `window.result`. */
const BRIDGE = `
  window.asked = [];
  const answers = { 'project.commitPostImport': (...args) => { window.asked.push(args); return Promise.resolve(window.result); } };
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
        name: 'post-import-menu',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The review did not bundle');
  return chunk.code;
}

const preview = (create: boolean, more: Partial<PostImportPreview> = {}): PostImportPreview => ({
  id: 'review-1',
  kind: 'markdown',
  source: 'posts',
  collection: { name: 'Posts', route: '/blog/', create },
  posts: [{ title: 'Bread', from: '2026-01-02-bread.md', route: '/blog/bread/', date: '2026-01-02', draft: false, pictures: 0, categories: [], tags: [], notes: [] }],
  existing: 0,
  pictures: 0,
  missing: [],
  newTerms: { categories: [], tags: [] },
  redirects: 0,
  skipped: [],
  oldSiteLinks: [],
  problems: [],
  ...more
});

const BOX = 'Add a Blog link to the header menu';

describe.skipIf(!browserInstalled)('the header link in the post import review (#1509)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const site = createStarterState('business', 'Riverside Studio', false);

  const box = () => page.getByRole('checkbox', { name: BOX });
  const mount = (state: ProjectState, p: PostImportPreview, result: PostImportResult = { ok: true, imported: 1 }) =>
    page.evaluate(
      ([state, p, result]) => {
        const w = globalThis as unknown as { result: unknown; mount(s: unknown, p: unknown): void };
        w.result = result;
        w.mount(state, p);
      },
      [state as unknown, p as unknown, result as unknown] as const
    );
  /** Imports, and what the bridge was asked to add to the menu. */
  async function importing() {
    await page.getByTestId('post-import-confirm').click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { asked: unknown[][] }).asked.length)).toBe(1);
    return page.evaluate(() => (globalThis as unknown as { asked: unknown[][] }).asked[0]);
  }
  const toasts = () => page.evaluate(() => (globalThis as unknown as { toasts(): string[] }).toasts());

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
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('is ticked for a new blog, asks for the link and says it was added', async () => {
    await mount(site, preview(true), { ok: true, imported: 1, addedToNavigation: true });
    expect(await box().isChecked()).toBe(true);
    expect(await importing()).toEqual(['review-1', 'w', true, 'skip']);
    await expect.poll(toasts).toEqual(['Imported 1 post. Added the Blog link to the header menu.']);
  });

  it('asks for no link once unticked, and Enter ticks and unticks it as a click does', async () => {
    await mount(site, preview(true));
    await box().uncheck();
    await box().check();
    await box().press('Enter');
    expect(await box().isChecked()).toBe(false);
    expect(await importing()).toEqual(['review-1', 'w', false, 'skip']);
    await expect.poll(toasts).toEqual(['Imported 1 post.']);
  });

  it('says when the link could not join the menu', async () => {
    await mount(site, preview(true), { ok: true, imported: 1, addedToNavigation: false });
    await importing();
    await expect.poll(toasts).toEqual([expect.stringContaining('Imported 1 post. Its Blog link could not join the header menu')]);
  });

  const added = 'Added the Blog link to the header menu.';
  const refused = 'Its Blog link could not join the header menu';
  it.each([
    { addedToNavigation: true, said: [1, 0] },
    { addedToNavigation: false, said: [0, 1] },
    { addedToNavigation: undefined, said: [0, 0] }
  ])('says what became of the link beside pictures that were not added ($addedToNavigation)', async ({ addedToNavigation, said }) => {
    await mount(site, preview(true, { pictures: 1 }), { ok: true, imported: 1, addedToNavigation, notes: [{ file: 'oven.png', posts: ['Bread'], reason: 'it is damaged.' }] });
    await importing();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('oven.png').waitFor();
    expect([await dialog.getByText(added).count(), await dialog.getByText(refused).count()]).toEqual(said);
  });

  it('is not offered when the blog is already there', async () => {
    await mount(applyOperations(site, [{ type: 'collection.create', collectionId: 'posts' }]).state, preview(false));
    await page.getByTestId('post-import-confirm').waitFor();
    expect(await box().count()).toBe(0);
    expect(await importing()).toEqual(['review-1', 'w', false, 'skip']);
  });

  it('is not offered when the header has no menu', async () => {
    const bare = structuredClone(site);
    bare.site.shell.header = { rootIds: [], nodes: {} } as typeof bare.site.shell.header;
    await mount(bare, preview(true));
    await page.getByTestId('post-import-confirm').waitFor();
    expect(await box().count()).toBe(0);
    expect(await importing()).toEqual(['review-1', 'w', false, 'skip']);
  });

  it('issue 1518: lists the old site’s addresses the posts still link to, with how many posts link to each', async () => {
    await mount(
      site,
      preview(true, {
        site: 'https://old.example',
        oldSiteLinks: [
          { url: 'https://old.example/about/team/', posts: 2 },
          { url: 'https://old.example/category/clay/', posts: 1, to: '/blog/category/clay/', pending: true },
          { url: 'https://old.example/category/soil/', posts: 1, to: '/blog/category/soil/' }
        ]
      })
    );
    const dialog = page.getByRole('dialog');
    await dialog.getByText('The posts link to 3 addresses of the old site').waitFor();
    expect(await dialog.getByText('Once this site is published at https://old.example,').count()).toBe(1);
    expect(await page.getByTestId('post-import-old-links').locator('li').allInnerTexts()).toEqual([
      'https://old.example/about/team/ · 2 posts',
      'https://old.example/category/clay/ · 1 post · sends visitors to /blog/category/clay/ once a post filed under that category is published',
      'https://old.example/category/soil/ · 1 post · kept working: it sends visitors to /blog/category/soil/'
    ]);
  });

  it('is not offered for posts that can’t be imported', async () => {
    await mount(site, preview(true, { problems: ['The posts can’t be imported.'] }));
    await page.getByTestId('post-import-problems').waitFor();
    expect(await box().count()).toBe(0);
  });
});
