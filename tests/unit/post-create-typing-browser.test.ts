/**
 * Typing straight on after Create draft (#1394): while the new entry is made, the writer still shows the one open
 * before it. What is typed then, after Enter in the title or into the writer still showing, reaches the new entry once
 * it opens, and never the one before it. The real Content panel, writer and store run in a real browser, over a stand-in
 * for the preload bridge whose edits take a moment to land, as main's do.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { assetUsages } from '@engine/apply';
import { run } from './fixtures/seo-site';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://post-create-typing.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PostsPanel } from ${src('renderer/src/panels/PostsPanel')};`,
  `import { PostWriter } from ${src('renderer/src/panels/PostWriter')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  `import { applyOperations } from ${src('engine/apply')};`,
  'function Editor() {',
  '  return h("div", null, h("div", { id: "panel" }, h(PostsPanel)), h("div", { id: "writer" }, h(PostWriter, { hidden: false })));',
  '}',
  'window.mount = (state, post, assetUsage) => {',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null }, pageId: state.site.homePageId,",
  "    leftTab: 'posts', post: { collectionId: 'posts', entryId: post }, postView: 'write', contentCollection: 'posts'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  '};',
  // Main's side of an edit: checked against the revision it was planned for, applied, the project sent on, then answered.
  'window.edit = async (batch) => {',
  '  window.edits.push(batch.operations.map((o) => o.type));',
  '  await new Promise((r) => setTimeout(r, window.editDelay));',
  '  const s = useStore.getState().snapshot;',
  "  if (batch.expectedRevision !== undefined && batch.expectedRevision !== s.revision) return { ok: false, revision: s.revision, error: { code: 'STALE_REVISION', message: 'Stale' } };",
  '  const r = applyOperations(s.state, batch.operations);',
  '  const revision = s.revision + 1;',
  '  useStore.setState({ snapshot: { ...s, state: r.state, revision } });',
  "  return { ok: true, revision, results: r.results, entryId: 'h' + revision };",
  '};',
  'window.so = {',
  '  snapshot: () => useStore.getState().snapshot,',
  // Each entry's text as the project has it, by title: its paragraphs one per line.
  '  bodies: () => Object.fromEntries(Object.values(useStore.getState().snapshot.state.collections.posts.entries).map((e) => [e.title, (e.body ?? []).map((b) => (b.spans ?? []).map((x) => x.text).join("")).join("\\n")])),',
  '  open: () => { const p = useStore.getState().post; return p && useStore.getState().snapshot.state.collections.posts.entries[p.entryId]?.title; },',
  '  toasts: () => useStore.getState().toasts.map((t) => t.text)',
  '};'
].join('\n');

/** The preload bridge: edits go through `edit` above, after `editDelay` ms; a snapshot asked for is the store's own. */
const BRIDGE = `
  window.edits = [];
  window.editDelay = 300;
  const answers = {
    'project.apply': (batch) => window.edit(batch),
    'project.snapshot': () => Promise.resolve(window.so.snapshot())
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
        name: 'post-create-typing',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The panels did not bundle');
  return chunk.code;
}

/** A blog with one post open, a line of text in it. */
function site(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'Post 1', publishedAt: '2027-03-02', body: [{ type: 'p', spans: [{ text: 'The first post.' }] }] }
  );
}

describe.skipIf(!browserInstalled)('typing straight on after Create draft (#1394)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const start = site();

  const so = <R = unknown>(name: string): Promise<R> => page.evaluate((name) => (globalThis as unknown as { so: Record<string, () => unknown> }).so[name](), name) as Promise<R>;
  const bodies = () => so<Record<string, string>>('bodies');
  const open = () => so<string | null>('open');
  const titleField = () => page.getByLabel('New post title');
  /** The New post form, opened from the panel's head, with `title` typed in it. */
  async function typeTitle(title: string) {
    await page.locator('#panel').getByRole('button', { name: 'New post' }).click();
    await titleField().waitFor();
    await titleField().pressSequentially(title);
  }

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
    await page.evaluate(([state, usage]) => (globalThis as unknown as { mount(s: unknown, p: string, u: unknown): void }).mount(state, 'en_one', usage), [start as unknown, assetUsages(start)] as const);
    await page.locator('#writer .post-body p').first().waitFor();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('keeps every key typed after Enter in the title, and puts them in the new post’s text', async () => {
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    // Straight on, at about 25 characters a second, while the draft is made.
    await page.keyboard.type('MARKER-2 body', { delay: 40 });
    await expect.poll(open).toBe('Post 2');
    await expect.poll(bodies).toEqual({ 'Post 1': 'The first post.', 'Post 2': 'MARKER-2 body' });
  });

  it('puts what is typed into the writer still showing the last post in the new one, never the last', async () => {
    await typeTitle('Post 2');
    await page.getByRole('button', { name: 'Create draft' }).click();
    // Into the text still on screen, at once, as the draft is made.
    await page.locator('#writer .post-body').click({ force: true });
    await page.keyboard.type('MARKER-3', { delay: 40 });
    await expect.poll(open).toBe('Post 2');
    await expect.poll(bodies).toEqual({ 'Post 1': 'The first post.', 'Post 2': 'MARKER-3' });
  });
});
