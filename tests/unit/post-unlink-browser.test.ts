/**
 * The post writer's Remove link button (#1510): with only the caret in a link, it takes that link off its words and
 * leaves the caret where it was; with words chosen, it unlinks those. The real writer and store run in a real browser,
 * over a stand-in for the preload bridge that keeps the edits it is sent.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState, RichText } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { run } from './fixtures/seo-site';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://post-unlink.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PostWriter } from ${src('renderer/src/panels/PostWriter')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  'window.mount = (state) => {',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage: {}, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null }, pageId: state.site.homePageId,",
  "    leftTab: 'posts', post: { collectionId: 'posts', entryId: 'en_guide' }, postView: 'write'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h('div', { id: 'writer' }, h(PostWriter, { hidden: false }))));",
  '};'
].join('\n');

/** The preload bridge: every edit is taken, and kept. */
const BRIDGE = `
  window.applied = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => (path === 'project.apply' ? (window.applied.push(args), Promise.resolve({ ok: true })) : path === 'on' ? () => {} : Promise.resolve(undefined))
  });
  window.builder = any('');
  const text = () => document.querySelector('#writer .post-body');
  window.t = {
    // The caret, or the words from at to to, put in the text node that reads words.
    select: (words, at, to) => {
      text().focus();
      const walker = document.createTreeWalker(text(), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue === words) return getSelection().setBaseAndExtent(n, at, n, to);
      throw new Error('No text ' + words);
    },
    // The caret in the first link element itself, before its child offset.
    inLink: (offset) => { text().focus(); getSelection().collapse(text().querySelector('a'), offset); },
    // From the end of the first link, across the plain words, to the start of the second.
    between: () => { const [a, b] = text().querySelectorAll('a'); getSelection().setBaseAndExtent(a.firstChild, a.textContent.length, b.firstChild, 0); },
    caret: () => { const s = getSelection(); return { collapsed: s.isCollapsed, text: s.anchorNode.nodeValue, offset: s.anchorOffset }; }
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
        name: 'post-unlink',
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

const HARBOUR = 'https://example.com/harbour';
const ARCHIVE = 'https://example.com/archive';
const BODY: RichText = [
  { type: 'p', spans: [{ text: 'Ask at ' }, { text: 'the harbour desk', link: { type: 'url', target: HARBOUR } }, { text: ' or read ' }, { text: 'the archive', link: { type: 'url', target: ARCHIVE } }, { text: '.' }] },
  { type: 'ul', items: [[{ text: 'Tides' }], [{ text: 'Harbour office', strong: true, em: true, link: { type: 'url', target: HARBOUR } }]] }
];

function site(): ProjectState {
  return run(createStarterState('blank', 'Port Guide', false), { type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_guide', title: 'Visiting the port', publishedAt: '2027-03-02', draft: false, body: BODY });
}

describe.skipIf(!browserInstalled)('Remove link in the post writer’s toolbar (#1510)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const start = site();

  const tool = () => page.locator('#writer [data-tool="unlink"]');
  const html = () => page.locator('#writer .post-body').innerHTML();
  const links = () => page.locator('#writer .post-body a').allTextContents();
  /** Runs `name` of the page's side of the test (BRIDGE's `t`). */
  const t = <R = void>(name: string, ...args: unknown[]): Promise<R> => page.evaluate(([name, args]) => (globalThis as unknown as { t: Record<string, (...a: unknown[]) => unknown> }).t[name](...args), [name, args] as const) as Promise<R>;
  const select = (words: string, at: number, to = at) => t('select', words, at, to);
  const caret = () => t<{ collapsed: boolean; text: string | null; offset: number }>('caret');
  /** The edits the writer last sent to be saved. */
  const saved = () => page.evaluate(() => JSON.stringify((globalThis as unknown as { applied: unknown[] }).applied.at(-1) ?? null));
  const uses = async (href: string) => (await saved()).split(href).length - 1;
  const off = () => expect.poll(() => tool().getAttribute('aria-disabled'));

  const mount = async () => {
    await page.evaluate((state) => (globalThis as unknown as { mount(s: unknown): void }).mount(state), start as unknown);
    await page.locator('#writer .post-body p').first().waitFor();
  };

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
    await mount();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('takes the link holding the caret off all its words, and leaves the caret and the other links', async () => {
    await select('the harbour desk', 7);
    await off().toBeNull();
    await tool().click();
    expect(await links()).toEqual(['the archive', 'Harbour office']);
    expect(await page.locator('#writer .post-body p').textContent()).toBe('Ask at the harbour desk or read the archive.');
    expect(await caret()).toEqual({ collapsed: true, text: 'the harbour desk', offset: 7 });
    // Saved without that link: the harbour address is now the list item's only.
    await expect.poll(() => uses(ARCHIVE)).toBe(1);
    expect(await uses(HARBOUR)).toBe(1);
    await off().toBe('true');
  });

  it('keeps the caret in its list item, and the formatting, when the link starts it', async () => {
    await select('Harbour office', 0);
    await off().toBeNull();
    await tool().click();
    expect(await links()).toEqual(['the harbour desk', 'the archive']);
    expect(await page.locator('#writer .post-body li strong em, #writer .post-body li em strong').textContent()).toBe('Harbour office');
    expect(await caret()).toEqual({ collapsed: true, text: 'Harbour office', offset: 0 });
    await page.keyboard.type('New ');
    expect(await page.locator('#writer .post-body li').allTextContents()).toEqual(['Tides', 'New Harbour office']);
  });

  it('unlinks the link when the caret is in the link element itself, on the same side of its words', async () => {
    for (const [offset, want] of [
      [0, 'Ask at !the harbour desk or read the archive.'],
      [1, 'Ask at the harbour desk! or read the archive.']
    ] as const) {
      await t('inLink', offset);
      await off().toBeNull();
      await tool().click();
      expect(await links()).toEqual(['the archive', 'Harbour office']);
      await page.keyboard.type('!');
      expect(await page.locator('#writer .post-body p').textContent()).toBe(want);
      await page.reload();
      await mount();
    }
  });

  it('unlinks only the words chosen', async () => {
    await select('the archive', 4, 11);
    await off().toBeNull();
    await tool().click();
    expect(await links()).toEqual(['the harbour desk', 'the ', 'Harbour office']);
    expect(await page.locator('#writer .post-body p').textContent()).toBe('Ask at the harbour desk or read the archive.');
  });

  it('is off for chosen words that only reach a link’s edge', async () => {
    await select('the archive', 0, 3);
    await off().toBeNull();
    await t('between');
    await off().toBe('true');
  });
});
