/**
 * Deleting an entry other entries name in a reference field (#1461): the Content panel's Delete asks which entry of its
 * own collection takes its place, naming the entries that hold the references, rather than a bare yes or no the engine
 * then refuses; with no other entry to offer, it says what has to change first and deletes nothing. The real Content
 * panel and store run in a real browser, over a stand-in for the preload bridge that applies edits with the engine.
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
const SITE = 'http://delete-referenced-entry.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PostsPanel } from ${src('renderer/src/panels/PostsPanel')};`,
  `import { ConfirmHost } from ${src('renderer/src/components/ConfirmDialog')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  `import { applyOperations } from ${src('engine/apply')};`,
  'window.mount = (state, assetUsage) => {',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null }, pageId: state.site.homePageId,",
  "    leftTab: 'posts', post: null, postView: 'write', contentCollection: 'venues'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h('div', null, h(PostsPanel), h(ConfirmHost))));",
  '};',
  // Main's side of an edit: checked against the revision it was planned for, applied by the engine, the project sent on.
  'window.edit = async (batch) => {',
  '  const s = useStore.getState().snapshot;',
  "  if (batch.expectedRevision !== undefined && batch.expectedRevision !== s.revision) return { ok: false, revision: s.revision, error: { code: 'STALE_REVISION', message: 'Stale' } };",
  '  let r;',
  "  try { r = applyOperations(s.state, batch.operations); } catch (e) { return { ok: false, revision: s.revision, error: { code: 'VALIDATION_FAILED', message: e.message } }; }",
  '  const revision = s.revision + 1;',
  '  useStore.setState({ snapshot: { ...s, state: r.state, revision } });',
  "  return { ok: true, revision, results: r.results };",
  '};',
  'window.so = {',
  '  snapshot: () => useStore.getState().snapshot,',
  '  toasts: () => useStore.getState().toasts.map((t) => t.text),',
  // Another edit landing while the dialog is open, as a save or the assistant's would.
  '  apply: (operations) => window.edit({ operations })',
  '};'
].join('\n');

/** The preload bridge: edits go through `edit` above. */
const BRIDGE = `
  window.refuse = null;
  window.lag = 0;
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
        name: 'delete-referenced-entry',
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

/**
 * Visitor venues and Guided tours, a tour naming two venues in a reference field: the old reading room (to delete) and
 * the garden. `successor` adds a published Lantern hall and a draft Annexe to venues; a published page and an entry of
 * another collection are there either way, which no reference can take in place of a venue.
 */
function site(successor: boolean): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_news', title: 'News post', publishedAt: '2027-01-02', draft: false },
    { type: 'collection.create', collectionId: 'venues', kind: 'structured', name: 'Visitor venues', singularName: 'Venue' },
    { type: 'entry.create', collectionId: 'venues', entryId: 'en_oldroom', title: 'Old reading room', draft: false },
    { type: 'entry.create', collectionId: 'venues', entryId: 'en_garden', title: 'Garden', draft: false },
    ...(successor
      ? [
          { type: 'entry.create' as const, collectionId: 'venues', entryId: 'en_lantern', title: 'Lantern hall', draft: false },
          { type: 'entry.create' as const, collectionId: 'venues', entryId: 'en_annex', title: 'Annexe' }
        ]
      : []),
    { type: 'collection.create', collectionId: 'tours', kind: 'structured', name: 'Guided tours', singularName: 'Tour', fields: { venues: { type: 'reference', label: 'Venues', collection: 'venues', multiple: true }, meet: { type: 'link', label: 'Meeting point' } } },
    { type: 'entry.create', collectionId: 'tours', entryId: 'en_tour', title: 'Meet the readers', draft: false, values: { venues: ['en_oldroom', 'en_garden'] } }
  );
}

describe.skipIf(!browserInstalled)('deleting an entry other entries name (#1461)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  const so = <R = unknown>(name: string, arg?: unknown): Promise<R> => page.evaluate(([name, arg]) => (globalThis as unknown as { so: Record<string, (a: unknown) => unknown> }).so[name](arg), [name, arg] as const) as Promise<R>;
  const project = async () => (await so<{ state: ProjectState }>('snapshot')).state;
  async function mount(state: ProjectState) {
    await page.evaluate(([state, usage]) => (globalThis as unknown as { mount(s: unknown, u: unknown): void }).mount(state, usage), [state as unknown, assetUsages(state)] as const);
  }
  /** Delete venue… from the old reading room's options. */
  async function askDelete() {
    await page.getByRole('button', { name: 'Old reading room options' }).click();
    await page.getByRole('menuitem', { name: 'Delete venue…' }).click();
    return page.getByRole('dialog', { name: 'Delete this venue?' });
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
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('names the tour, offers only other venues, and puts the chosen one in the reference’s place', async () => {
    await mount(site(true));
    const dialog = await askDelete();
    await expect.poll(() => dialog.textContent()).toContain('Old reading room is named by Meet the readers (Guided tours) (one reference).');
    const select = dialog.getByLabel('Replace it with');
    // Every other venue, a draft among them as a reference editor offers it; no page, nor an entry of another collection.
    expect(await select.locator('option:not([disabled])').allTextContents()).toEqual(['Annexe (draft)', 'Garden', 'Lantern hall']);
    // Nothing is chosen for the author: Delete waits for a choice.
    const del = dialog.getByRole('button', { name: 'Delete venue' });
    expect(await del.isDisabled()).toBe(true);
    await select.selectOption({ label: 'Lantern hall' });
    await del.click();
    await expect.poll(async () => Object.keys((await project()).collections.venues.entries).sort()).toEqual(['en_annex', 'en_garden', 'en_lantern']);
    expect((await project()).collections.tours.entries.en_tour.values.venues).toEqual(['en_lantern', 'en_garden']);
    expect(await so<string[]>('toasts')).toContain('Deleted “Old reading room”');
  });

  it('takes the garden once where the list already names it', async () => {
    await mount(site(true));
    const dialog = await askDelete();
    await dialog.getByLabel('Replace it with').selectOption({ label: 'Garden' });
    await dialog.getByRole('button', { name: 'Delete venue' }).click();
    await expect.poll(async () => (await project()).collections.tours.entries.en_tour.values.venues).toEqual(['en_garden']);
  });

  it('says what must change first when no other venue can take its place, and deletes nothing', async () => {
    const s = site(false);
    delete s.collections.venues.entries.en_garden;
    s.collections.tours.entries.en_tour.values.venues = ['en_oldroom'];
    await mount(s);
    const dialog = await askDelete();
    await expect.poll(() => dialog.textContent()).toContain('Only another venue of Visitor venues can take its place, and there is none. Add one, or remove the reference from that entry, then delete it.');
    expect(await dialog.getByLabel('Replace it with').count()).toBe(0);
    expect(await dialog.getByRole('button', { name: 'Delete venue' }).isDisabled()).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(Object.keys((await project()).collections.venues.entries)).toEqual(['en_oldroom']);
  });

  it('with an old address kept working too, offers only published venues and hands the address on', async () => {
    const s = site(true);
    s.site.redirects = [{ from: '/venues/reading-room/', entryId: 'en_oldroom' }];
    await mount(s);
    const dialog = await askDelete();
    const select = dialog.getByLabel('Replace it with');
    expect(await select.locator('option:not([disabled])').allTextContents()).toEqual(['Garden', 'Lantern hall']);
    await select.selectOption({ label: 'Lantern hall' });
    await dialog.getByRole('button', { name: 'Delete venue' }).click();
    await expect.poll(async () => (await project()).site.redirects).toEqual([{ from: '/venues/reading-room/', entryId: 'en_lantern' }]);
    expect((await project()).collections.tours.entries.en_tour.values.venues).toEqual(['en_lantern', 'en_garden']);
  });
  it('with a link to it as well, names both, offers only published venues and sends both to the one chosen', async () => {
    const s = site(true);
    s.collections.tours.entries.en_tour.values.meet = { type: 'entry', target: 'en_oldroom' };
    await mount(s);
    const dialog = await askDelete();
    await expect.poll(() => dialog.textContent()).toContain(
      'Old reading room is named by Meet the readers (Guided tours) (one reference) and is linked from Meet the readers (Guided tours) (one link). That reference and that link go here instead:'
    );
    const select = dialog.getByLabel('Replace it with');
    expect(await select.locator('option:not([disabled])').allTextContents()).toEqual(['Garden', 'Lantern hall']);
    await select.selectOption({ label: 'Lantern hall' });
    await dialog.getByRole('button', { name: 'Delete venue' }).click();
    await expect.poll(async () => (await project()).collections.tours.entries.en_tour.values).toEqual({ venues: ['en_lantern', 'en_garden'], meet: { type: 'entry', target: 'en_lantern' } });
  });

  it('asks again when a reference arrives after a place for its links was chosen', async () => {
    const s = site(true);
    s.collections.tours.entries.en_tour.values = { venues: ['en_garden'], meet: { type: 'entry', target: 'en_oldroom' } };
    await mount(s);
    const dialog = await askDelete();
    const links = dialog.getByLabel('Send its links to');
    await links.selectOption({ label: 'Garden' });
    expect(await dialog.getByRole('button', { name: 'Delete venue' }).isDisabled()).toBe(false);
    await so('apply', [{ type: 'entry.update', collectionId: 'tours', entryId: 'en_tour', values: { venues: ['en_oldroom', 'en_garden'] } }]);
    const select = dialog.getByLabel('Replace it with');
    await expect.poll(() => select.inputValue()).toBe('');
    expect(await dialog.getByRole('button', { name: 'Delete venue' }).isDisabled()).toBe(true);
    expect(Object.keys((await project()).collections.venues.entries)).toContain('en_oldroom');
  });

  it('says to change a reference held by a synced collection at its source, and deletes nothing', async () => {
    const s = site(true);
    s.collections.tours.settings.sourceId = 'src_tours';
    await mount(s);
    const dialog = await askDelete();
    await expect.poll(() => dialog.textContent()).toContain('Meet the readers (Guided tours) is synced from an external source, so its entries are read-only here. Change it in the source, or detach that collection, then delete this venue.');
    expect(await dialog.getByLabel('Replace it with').count()).toBe(0);
    expect(await dialog.getByRole('button', { name: 'Delete venue' }).isDisabled()).toBe(true);
  });
  it('with an old address kept for a venue of a collection with no pages, offers a draft as well', async () => {
    const s = site(true);
    s.collections.venues.settings.pages = { detail: false, archive: false };
    s.site.redirects = [{ from: '/venues/reading-room/', entryId: 'en_oldroom' }];
    await mount(s);
    const dialog = await askDelete();
    const select = dialog.getByLabel('Replace it with');
    expect(await select.locator('option:not([disabled])').allTextContents()).toEqual(['Annexe (draft)', 'Garden', 'Lantern hall']);
    await select.selectOption({ label: 'Annexe (draft)' });
    await dialog.getByRole('button', { name: 'Delete venue' }).click();
    await expect.poll(async () => (await project()).collections.tours.entries.en_tour.values.venues).toEqual(['en_annex', 'en_garden']);
  });
});
