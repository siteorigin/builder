/**
 * The Inspector beside the writer, its preview and the SEO view names an entry by its collection's singular noun, and
 * says only what the writer holds for that kind of collection (#1111). The real Inspector and store run in a real
 * browser, over a project the engine made.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { starterCollectionOps } from '../../src/renderer/src/lib/content';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://inspector-entry-kind.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Inspector } from ${renderer('panels/Inspector')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { registerPacks } from ${JSON.stringify(resolve('src/catalogue/index'))};`,
  // As the editor does before it first renders.
  'window.packs = (list) => registerPacks(list);',
  "const root = createRoot(document.getElementById('root'));",
  'window.show = (state, patch) => {',
  "  flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', state }, pageId: state.site.homePageId, selection: null, leftTab: 'posts', postView: 'write', mode: 'edit', post: null, postPreviewAt: null, seoSubject: null, ...patch }));",
  "  flushSync(() => root.render(h('div', { id: 'dock-panel-inspect' }, h(Inspector))));",
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
        name: 'inspector-entry-kind',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The Inspector did not bundle');
  return chunk.code;
}

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

/** The blog, the ready-made Projects and Team, and a collection kept from manual edits, one entry in each. */
function project(): ProjectState {
  let s = createStarterState('business', 'Test Studio', false);
  for (const id of ['posts', 'projects', 'team']) if (!s.collections[id]) s = run(s, ...starterCollectionOps(s, id)!.ops);
  s = run(
    s,
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_news', title: 'Winter hours', draft: false },
    { type: 'entry.create', collectionId: 'projects', entryId: 'en_hall', title: 'Town hall', draft: true },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false },
    { type: 'collection.create', collectionId: 'listings', name: 'Properties', kind: 'structured', singularName: 'Property', hasBody: false, pages: { detail: true, archive: false }, route: '/properties/' },
    { type: 'entry.create', collectionId: 'listings', entryId: 'en_loft', title: 'Harbour loft', draft: false }
,
    // Records with neither fields of their own nor text, and an article collection without pages or text.
    { type: 'collection.create', collectionId: 'partners', name: 'Partners', kind: 'structured', singularName: 'Partner', hasBody: false, pages: { detail: false, archive: false } },
    { type: 'entry.create', collectionId: 'partners', entryId: 'en_kiln', title: 'Kiln & Co', draft: true },
    { type: 'collection.create', collectionId: 'notices', name: 'Notices', kind: 'editorial', singularName: 'Notice', hasBody: false, pages: { detail: false, archive: false } },
    { type: 'entry.create', collectionId: 'notices', entryId: 'en_closed', title: 'Closed Monday', draft: true },
    // Text and entry pages each without the other, and an article collection with a field of its own.
    { type: 'collection.create', collectionId: 'guides', name: 'Guides', kind: 'structured', singularName: 'Guide', hasBody: true, pages: { detail: false, archive: false } },
    { type: 'entry.create', collectionId: 'guides', entryId: 'en_glaze', title: 'Glazing', draft: true },
    { type: 'collection.create', collectionId: 'memos', name: 'Memos', kind: 'editorial', singularName: 'Memo', hasBody: true, pages: { detail: false, archive: false } },
    { type: 'entry.create', collectionId: 'memos', entryId: 'en_memo', title: 'Stock take', draft: true },
    { type: 'collection.create', collectionId: 'releases', name: 'Releases', kind: 'editorial', singularName: 'Release', hasBody: false, pages: { detail: true, archive: false }, route: '/releases/', fields: { venue: { type: 'string', label: 'Venue', default: '' } } },
    { type: 'entry.create', collectionId: 'releases', entryId: 'en_open', title: 'Open day', draft: true }
  );
  s.collections.listings.settings.sourceId = 'listings-feed';
  return s;
}

const REFS = {
  blog: { collectionId: 'posts', entryId: 'en_news' },
  project: { collectionId: 'projects', entryId: 'en_hall' },
  member: { collectionId: 'team', entryId: 'en_ruiz' },
  property: { collectionId: 'listings', entryId: 'en_loft' }
};

describe.skipIf(!browserInstalled)('the Inspector names an entry by its collection (#1111)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const state = project();

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
    await page.evaluate((list) => (globalThis as unknown as { packs: (l: unknown) => void }).packs(list), listThemes() as unknown);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const show = async (patch: Record<string, unknown>) => {
    await page.evaluate(([s, p]) => (globalThis as unknown as { show: (a: unknown, b: unknown) => void }).show(s, p), [state, patch] as const);
    return { kind: await page.locator('.insp-kind-label').innerText(), note: await page.locator('.insp-empty p').innerText() };
  };

  it('says what a blog post’s writer holds', async () => {
    expect(await show({ post: REFS.blog })).toEqual({ kind: 'Published post', note: 'Its text, address, date, author, excerpt and featured image are edited in the writer. Nothing here changes a page.' });
  });

  it('names a structured entry and its fields, with its text when the collection has one', async () => {
    expect(await show({ post: REFS.project })).toEqual({ kind: 'Draft project', note: 'Its title, fields, text and publishing details are edited in the writer. Nothing here changes a page.' });
    expect(await show({ post: REFS.member })).toEqual({ kind: 'Published team member', note: 'Its title, fields and publishing details are edited in the writer. Nothing here changes a page.' });
  });

  it('leaves out what a collection’s writer does not have', async () => {
    expect(await show({ post: { collectionId: 'partners', entryId: 'en_kiln' } })).toEqual({ kind: 'Draft partner', note: 'Its title and publishing details are edited in the writer. Nothing here changes a page.' });
    expect(await show({ post: { collectionId: 'notices', entryId: 'en_closed' } })).toEqual({ kind: 'Draft notice', note: 'Its date, author, excerpt and featured image are edited in the writer. Nothing here changes a page.' });
  });

  it('mentions text, an address and an article’s own fields each only where the collection has them', async () => {
    const note = async (collectionId: string, entryId: string) => (await show({ post: { collectionId, entryId } })).note;
    expect(await note('guides', 'en_glaze')).toBe('Its title, text and publishing details are edited in the writer. Nothing here changes a page.');
    expect(await note('memos', 'en_memo')).toBe('Its text, date, author, excerpt and featured image are edited in the writer. Nothing here changes a page.');
    expect(await note('releases', 'en_open')).toBe('Its address, date, author, excerpt, featured image and fields are edited in the writer. Nothing here changes a page.');
  });

  it('offers no change to a synced entry it previews', async () => {
    expect(await show({ postView: 'preview', mode: 'preview', leftTab: null, post: REFS.property })).toEqual({ kind: 'Published property · preview', note: 'Showing the property as visitors see it.' });
  });

  it('does not say a synced entry is edited in the writer', async () => {
    expect(await show({ post: REFS.property })).toEqual({ kind: 'Published property', note: 'This property is synced from an external source, so it is read-only here. Nothing here changes a page.' });
  });

  it('names the previewed entry, and the one a visitor’s link went on to from another collection', async () => {
    const preview = { postView: 'preview', mode: 'preview', leftTab: null, post: REFS.project };
    expect(await show(preview)).toEqual({ kind: 'Draft project · preview', note: 'Showing the project as visitors see it. Back to writing to change it.' });
    // The destination is named by its own collection, and the note names the entry the writer has open.
    const onward = { note: 'A visitor’s link went on from “Town hall”. Back to writing returns to it.' };
    expect(await show({ ...preview, postPreviewAt: '/blog/winter-hours/' })).toEqual({ kind: 'Published post · preview', ...onward });
    expect(await show({ ...preview, postPreviewAt: '/properties/harbour-loft/' })).toEqual({ kind: 'Published property · preview', ...onward });
  });

  it('calls an entry that is gone what its collection does, or an entry once that is gone too', async () => {
    const preview = { postView: 'preview', mode: 'preview', leftTab: null, post: { collectionId: 'projects', entryId: 'en_gone' } };
    expect((await show({ ...preview, postPreviewAt: '/blog/winter-hours/' })).note).toBe('A visitor’s link went on from the project. Back to writing returns to it.');
    expect(await show({ ...preview, postPreviewAt: '/nowhere/' })).toEqual({ kind: 'Preview', note: 'A visitor’s link went on from the project. Back to writing returns to it; pages are changed once the preview ends.' });
    expect((await show({ ...preview, post: { collectionId: 'gone', entryId: 'en_gone' }, postPreviewAt: '/blog/winter-hours/' })).note).toBe('A visitor’s link went on from the entry. Back to writing returns to it.');
  });

  it('names whatever the SEO view has chosen', async () => {
    const seo = (seoSubject: unknown) => show({ leftTab: 'seo', seoSubject });
    const shows = (what: string) => `The SEO view shows ${what} in the canvas’s place. Nothing here changes the page under it.`;
    expect(await seo({ kind: 'entry', ...REFS.project })).toEqual({ kind: 'Draft project', note: shows('this project') });
    expect(await seo({ kind: 'entry', ...REFS.property })).toEqual({ kind: 'Published property', note: shows('this property') });
    expect(await seo({ kind: 'page', pageId: state.site.homePageId })).toEqual({ kind: 'Page', note: shows('this page') });
    expect(await seo(null)).toEqual({ kind: 'Nothing chosen', note: 'Choose a page or entry in the SEO list. The SEO view covers the canvas, and nothing here changes the page under it.' });
  });
});
