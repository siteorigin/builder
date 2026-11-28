/**
 * The posts import review with posts already in the project (#1519), in a real browser: it says how many are already
 * here, skips them by default (with nothing to import, it only closes), and imports with the author's choice.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PostImportPreview, PostImportPreviewPost } from '@shared/api';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://post-import-existing.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PostImportReviewModal } from ${renderer('panels/PostImportReview')};`,
  `import { useStore } from ${renderer('store')};`,
  'const state = window.__project;',
  'const preview = window.__preview;',
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'post-import', opening: 'w1', preview }, snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], recentExports: [], diagnostics: [] } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(PostImportReviewModal, { preview, opening: 'w1' })));",
  'useStore.subscribe((s) => void ((window.__modal = s.modal), (window.__toasts = s.toasts.map((t) => t.text))));'
].join('\n');

/** The preload bridge: the import's calls are recorded on window.__calls, and committing answers as asked. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.__calls = [];
  window.__modal = undefined;
  const project = new Proxy({}, { get: (_, key) =>
    key === 'commitPostImport' ? async (...a) => (window.__calls.push(['commit', ...a]), { ok: true, imported: 1, updated: a[3] === 'update' ? 2 : 0 })
    : key === 'cancelPostImport' ? async (...a) => void window.__calls.push(['cancel', ...a])
    : any('project.' + String(key)) });
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'then' ? undefined : any(String(key))) });
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'post-import-existing', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the review did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

const post = (title: string, over: Partial<PostImportPreviewPost> = {}): PostImportPreviewPost => ({ title, from: title, date: '2019-03-01', draft: false, route: `/blog/${title.toLowerCase()}/`, pictures: 0, categories: [], tags: [], notes: [], ...over });

const preview = (posts: PostImportPreviewPost[], over: Partial<PostImportPreview> = {}): PostImportPreview => ({
  id: 'r1',
  kind: 'wordpress',
  source: 'export.xml',
  collection: { name: 'Posts', route: '/blog/', create: false },
  posts,
  existing: posts.filter((p) => p.existing).length,
  pictures: 0,
  missing: [],
  newTerms: { categories: [], tags: [] },
  redirects: 0,
  redirectsLost: 0,
  skipped: [],
  oldSiteLinks: [],
  problems: [],
  update: { posts: posts.filter((p) => p.existing).length, pictures: 2, missing: [], newTerms: { categories: [], tags: [] }, oldSiteLinks: [], problems: [] },
  ...over
});

describe.skipIf(!browserInstalled)('Posts import review with posts already in the project (#1519)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let page: Page;
  let errors: string[];
  const project = JSON.stringify(createStarterState('business', 'Test Studio', false)).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [built, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const open = async (p: PostImportPreview) => {
    page = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const data = JSON.stringify(p).replace(/</g, '\\u003c');
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: built.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: built.styles });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project}; window.__preview = ${data};</script><script src="/app.js"></script>` });
    });
    await page.goto(`${SITE}/`);
    await page.getByTestId('post-import-existing-count').waitFor();
  };

  it('says every post is already here and, skipping them, only closes', async () => {
    await open(preview([post('Winter', { existing: true }), post('Spring', { existing: true }), post('Summer', { existing: true, draft: true })]));
    await expect(page.getByRole('heading', { name: 'These posts are already in the project' }).count()).resolves.toBe(1);
    expect(await page.getByTestId('post-import-existing-count').textContent()).toBe('3 posts are already in the project, so they will be left as they are.');
    expect(await page.getByTestId('post-import-confirm').count()).toBe(0);
    // Updating them is the other choice: the action then says so.
    await page.getByTestId('post-import-update').check();
    expect(await page.getByTestId('post-import-confirm').textContent()).toBe('Update 3 posts');
    await page.getByLabel('Skip them').check();
    expect(await page.getByTestId('post-import-confirm').count()).toBe(0);
    await page.getByRole('button', { name: 'Close' }).last().click();
    expect(await page.evaluate('window.__calls')).toEqual([['cancel', 'r1']]);
    expect(await page.evaluate('window.__modal')).toBeNull();
  });

  it('imports only the new posts when the choice is left as it is', async () => {
    await open(preview([post('Autumn'), post('Winter', { existing: true })]));
    expect(await page.getByLabel('Skip them').isChecked()).toBe(true);
    await page.getByTestId('post-import-confirm').click();
    await page.waitForFunction('window.__modal === null');
    expect(await page.evaluate('window.__calls')).toEqual([['commit', 'r1', 'w1', false, 'skip']]);
  });

  it('imports only the new posts by default, or updates the others with them when chosen', async () => {
    const p = preview([post('Autumn'), post('Winter', { existing: true }), post('Spring', { existing: true })]);
    await open(p);
    expect(await page.getByTestId('post-import-confirm').textContent()).toBe('Import 1 post');
    await page.getByTestId('post-import-update').check();
    expect(await page.getByTestId('post-import-confirm').textContent()).toBe('Import 1 post and update 2');
    await page.getByTestId('post-import-confirm').click();
    await page.waitForFunction('window.__modal === null');
    expect(await page.evaluate('window.__calls')).toEqual([['commit', 'r1', 'w1', false, 'update']]);
    expect(await page.evaluate('window.__toasts')).toEqual(['Imported 1 post and updated 2.']);
  });

  it('shows what updating changes on the posts already here, and counts those it leaves as they are', async () => {
    const p = preview([post('Autumn'), post('Winter', { existing: true, notes: ['Its text was longer than a post holds, so it ends after 3 of its 9 paragraphs.'] }), post('Spring', { existing: true, unread: true })]);
    p.update!.posts = 1;
    await open(p);
    // Skipping, nothing about them is changed, so nothing about them is listed to check.
    await page.getByTestId('post-import-existing').locator('summary').click();
    expect(await page.getByText('Its text was longer than a post holds', { exact: false }).count()).toBe(0);
    await page.getByTestId('post-import-update').check();
    expect(await page.getByTestId('post-import-existing-count').textContent()).toBe('2 posts are already in the project: 1 will be updated from the export, and 1 whose text could not be read will be left as it is.');
    expect(await page.getByText('Its text was longer than a post holds', { exact: false }).count()).toBe(1);
    expect(await page.getByTestId('post-import-confirm').textContent()).toBe('Import 1 post and update 1');
  });

  it('stops only updating when only updating has a problem', async () => {
    const p = preview([post('Autumn'), post('Winter', { existing: true })]);
    p.update!.problems = ['The posts bring 201 new tags, which would give the collection 201: it can have at most 200.'];
    await open(p);
    expect(await page.getByTestId('post-import-problems').count()).toBe(0);
    await page.getByTestId('post-import-update').check();
    expect(await page.getByTestId('post-import-problems').textContent()).toContain('201 new tags');
    expect(await page.getByTestId('post-import-confirm').count()).toBe(0);
    await page.getByLabel('Skip them').check();
    await page.getByTestId('post-import-confirm').click();
    await page.waitForFunction('window.__modal === null');
    expect(await page.evaluate('window.__calls')).toEqual([['commit', 'r1', 'w1', false, 'skip']]);
  });
});
