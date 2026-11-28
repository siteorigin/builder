/**
 * A published entry's Publication date changed to a day still to come (#1317): nothing makes the website wait for it,
 * so the field's note says the entry goes in the next export all the same, in place of the backdating note, and so
 * does a message as the change lands. The real
 * writer and store run in a real browser, over a stand-in for the preload bridge.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { run } from './fixtures/seo-site';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://post-future-date.test';
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
  '  toasts: () => useStore.getState().toasts.map((t) => t.text),',
  '  assets: () => useStore.getState().snapshot.state.assets.assets,',
  '  modal: () => useStore.getState().modal?.kind ?? null',
  '};'
].join('\n');

const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => (path === 'on' ? () => {} : Promise.resolve(path === 'project.apply' ? { ok: true } : undefined))
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
        name: 'post-future-date',
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

/** One post, on the website or not, dated `publishedAt`. */
const site = (publishedAt: string, draft = false): ProjectState =>
  run(createStarterState('blank', 'Riverside Studio', false), { type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring classes', publishedAt, draft });

const BACKDATE = 'A date in the past backdates the post.';

describe.skipIf(!browserInstalled)('a published entry dated after today (#1317)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  /** What the Publication date field is described by: the note under it. */
  const note = () =>
    page.evaluate(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Publication date')!;
      const input = document.getElementById(label.htmlFor)!;
      return document.getElementById(input.getAttribute('aria-describedby')!)!.textContent;
    });
  const mount = (state: ProjectState) => page.evaluate((state) => (globalThis as unknown as { mount(s: unknown, post: string, usage: unknown): void }).mount(state, 'en_spring', {}), state);
  const toasts = () => page.evaluate(() => (globalThis as unknown as { so: { toasts(): string[] } }).so.toasts());
  /** The date typed into the field, the details opened for it, and committed with Enter. */
  async function type(date: string) {
    await page.locator('#writer .post-details:not(.post-seo) .section-head').click();
    await page.getByLabel('Publication date').fill(date);
    await page.getByLabel('Publication date').press('Enter');
  }
  const change = (state: ProjectState) => page.evaluate((state) => (globalThis as unknown as { so: { change(s: unknown): void } }).so.change(state), state);

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
    await context.close();
    expect(errors).toEqual([]);
  });

  it('says the post stays in the next export once its date is moved past today, until it is moved back', async () => {
    await mount(site('2001-06-01'));
    expect(await note()).toBe(BACKDATE);
    await change(site('2099-01-01'));
    const warned = await note();
    expect(warned).toContain('still in the next export');
    expect(warned).toContain('2099');
    expect(warned).toContain('don’t schedule publishing');
    expect(warned).not.toContain(BACKDATE);
    await change(site('2001-06-01'));
    expect(await note()).toBe(BACKDATE);
  });

  it('keeps the backdating note for a draft dated after today, which stays off the website', async () => {
    await mount(site('2099-01-01', true));
    expect(await note()).toBe(BACKDATE);
  });

  it('says so as a published post’s new date lands, which closing the details does not hide', async () => {
    await mount(site('2001-06-01'));
    await type('2099-01-01');
    await expect.poll(toasts).toHaveLength(1);
    expect((await toasts())[0]).toMatch(/still in the next export, dated .*2099.*don’t schedule publishing/);
  });

  it.each([
    ['a draft’s date moved past today', true, '2099-01-01'],
    ['a published post backdated', false, '2000-01-01']
  ])('says nothing as %s lands', async (_, draft, date) => {
    await mount(site('2001-06-01', draft));
    await type(date);
    await page.waitForTimeout(100);
    expect(await toasts()).toEqual([]);
  });
});
