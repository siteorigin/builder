/**
 * Several posts picked in the Content list and changed together (#1507), in the real Content panel and store in a real
 * browser over a stand-in for the preload bridge that applies edits with the engine: Shift+click picks a range and
 * Cmd+click one more, as in a file manager, Select all picks what a filter shows, and the picked posts are published,
 * filed under a category or deleted, each with one question at most and as one change.
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
const SITE = 'http://posts-bulk.test';
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
  "    leftTab: 'posts', post: null, postView: 'write', contentCollection: 'posts'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h('div', null, h(PostsPanel), h(ConfirmHost))));",
  '};',
  // Main's side of an edit: checked against the revision it was planned for, applied by the engine, the project sent on.
  'window.edit = async (batch) => {',
  '  window.batches.push(batch.operations);',
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
  '  apply: (operations) => window.edit({ operations }),',
  '  batches: () => window.batches,',
  '  setPost: (post) => useStore.setState({ post })',
  '};'
].join('\n');

/** The preload bridge: edits go through `edit` above. */
const BRIDGE = `
  window.batches = [];
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
        name: 'posts-bulk',
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

/** A blog of five posts, newest first: two published, three drafts, one draft linked from a published post. */
function blog(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'collection.createTerm', collectionId: 'posts', taxonomyId: 'categories', label: 'News', termId: 'news' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'One', publishedAt: '2026-05-01', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_two', title: 'Two', publishedAt: '2026-04-01' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_three', title: 'Three', publishedAt: '2026-03-01' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_four', title: 'Four', publishedAt: '2026-02-01', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_five', title: 'Five', publishedAt: '2026-01-01' },
    { type: 'entry.update', collectionId: 'posts', entryId: 'en_four', body: [{ type: 'p', spans: [{ text: 'See ' }, { text: 'five', link: { type: 'entry', target: 'en_five' } }] }] }
  );
}

describe.skipIf(!browserInstalled)('picking several posts and changing them together (#1507)', { timeout: 30_000 }, () => {
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
  const row = (title: string) => page.getByRole('option', { name: new RegExp(`^${title}\\b`) });
  const selected = () => page.locator('[role="option"][aria-selected="true"]').evaluateAll((els) => els.map((e) => (e as unknown as { dataset: Record<string, string> }).dataset.post));
  /** The picked posts' actions, from the bar above the list. */
  async function action(name: string | RegExp) {
    await page.getByTestId('posts-bulk-actions').click();
    await page.getByRole('menuitem', { name }).click();
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

  it('picks a range with Shift+click and one more or one less with Cmd+click, keeping the open post apart', async () => {
    await mount(blog());
    await so('setPost', { collectionId: 'posts', entryId: 'en_one' });
    // Until something is picked, the open post is the list's selection.
    await expect.poll(selected).toEqual(['en_one']);
    expect(await page.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    await row('Three').click({ modifiers: ['Shift'] });
    await expect.poll(selected).toEqual(['en_one', 'en_two', 'en_three']);
    await row('Five').click({ modifiers: ['Meta'] });
    await row('Two').click({ modifiers: ['Meta'] });
    await expect.poll(selected).toEqual(['en_one', 'en_three', 'en_five']);
    // The open post stays open, marked as the current one, and nothing was changed or opened.
    expect(await row('One').getAttribute('aria-current')).toBe('true');
    expect(await page.getByRole('group', { name: '3 posts selected' }).textContent()).toContain('3 selected');
    expect(await so<unknown[]>('batches')).toEqual([]);
    // Shift+click again runs from the anchor, the row last Cmd+clicked, in place of what was picked.
    await row('Four').click({ modifiers: ['Shift'] });
    await expect.poll(selected).toEqual(['en_two', 'en_three', 'en_four']);
    // The open post, no longer picked, is still the one marked open.
    expect(await row('One').getAttribute('aria-current')).toBe('true');
    expect(await row('Two').getAttribute('aria-current')).toBe(null);
    // Escape lets go of them, and the open post is the selection again.
    await row('Three').press('Escape');
    await expect.poll(selected).toEqual(['en_one']);
    expect(await page.getByRole('group', { name: /selected/ }).count()).toBe(0);
  });

  it('picks from the keyboard: Shift+Down for a range, Cmd+Space for one more, Cmd+A for all shown', async () => {
    await mount(blog());
    await row('Two').focus();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(selected).toEqual(['en_two', 'en_three', 'en_four']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Meta+Space');
    await expect.poll(selected).toEqual(['en_two', 'en_three', 'en_four', 'en_five']);
    await page.keyboard.press('Shift+ArrowUp');
    await expect.poll(selected).toEqual(['en_four', 'en_five']);
    await page.keyboard.press('Meta+a');
    await expect.poll(selected).toEqual(['en_one', 'en_two', 'en_three', 'en_four', 'en_five']);
  });

  it('selects all a filter shows, publishes them as one change, and leaves the posts it hides alone', async () => {
    await mount(blog());
    await page.getByRole('radio', { name: /Drafts/ }).click();
    await page.getByTestId('collection-options-posts').click();
    await page.getByRole('menuitem', { name: /Select all 3 shown/ }).click();
    await expect.poll(selected).toEqual(['en_two', 'en_three', 'en_five']);
    await action('Publish');
    await expect.poll(async () => Object.values((await project()).collections.posts.entries).filter((e) => e.draft !== false).length).toBe(0);
    expect(await so<unknown[]>('batches')).toEqual([
      [
        { type: 'entry.update', collectionId: 'posts', entryId: 'en_two', draft: false },
        { type: 'entry.update', collectionId: 'posts', entryId: 'en_three', draft: false },
        { type: 'entry.update', collectionId: 'posts', entryId: 'en_five', draft: false }
      ]
    ]);
    expect((await so<string[]>('toasts')).join(' ')).toContain('Published 3 posts');
  });

  it('a filter that hides picked posts lets go of them, so nothing hidden is changed', async () => {
    await mount(blog());
    await row('One').click({ modifiers: ['Meta'] });
    await row('Two').click({ modifiers: ['Meta'] });
    await page.getByRole('radio', { name: /Drafts/ }).click();
    await expect.poll(selected).toEqual(['en_two']);
    await page.getByRole('radio', { name: /All/ }).click();
    await expect.poll(selected).toEqual(['en_two']);
  });

  it('deletes the picked posts with one question and one change, and keeps the one that is linked to picked', async () => {
    await mount(blog());
    await row('Two').click({ modifiers: ['Meta'] });
    await row('Five').click({ modifiers: ['Shift'] });
    await action('Delete 4 posts…');
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect.poll(() => dialog.textContent()).toContain('Delete 3 posts?');
    expect(await dialog.textContent()).toContain('One stays: “Five” is linked to or named elsewhere.');
    await dialog.getByRole('button', { name: 'Delete 3 posts' }).click();
    await expect.poll(async () => Object.keys((await project()).collections.posts.entries).sort()).toEqual(['en_five', 'en_one']);
    expect(await so<unknown[]>('batches')).toHaveLength(1);
    // Five is still picked, to delete on its own and choose what takes its place.
    await expect.poll(selected).toEqual(['en_five']);
    expect((await so<string[]>('toasts')).join(' ')).toContain('Deleted 3 posts');
  });

  it('files the picked posts under a category from the dialog, in one change', async () => {
    const s = blog();
    s.collections.posts.entries.en_one.terms = { categories: ['news'] };
    await mount(s);
    await row('One').click({ modifiers: ['Meta'] });
    await row('Two').click({ modifiers: ['Meta'] });
    await action(/Categories and tags/);
    const dialog = page.getByRole('dialog', { name: /Categories and tags of 2 posts/ });
    const news = dialog.getByRole('checkbox', { name: 'News' });
    // One of the two is filed under it: part-checked.
    const mixed = () => news.evaluate((el) => (el as unknown as { indeterminate: boolean }).indeterminate);
    expect(await mixed()).toBe(true);
    // On for both, off for both, then back to as it is: Apply has nothing to do.
    await news.click();
    expect([await news.isChecked(), await mixed()]).toEqual([true, false]);
    await news.click();
    expect([await news.isChecked(), await mixed()]).toEqual([false, false]);
    await news.click();
    expect(await mixed()).toBe(true);
    expect(await dialog.getByRole('button', { name: 'Apply' }).isDisabled()).toBe(true);
    await news.click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => (await project()).collections.posts.entries.en_two.terms?.categories).toEqual(['news']);
    expect(await so<unknown[]>('batches')).toEqual([[{ type: 'entry.update', collectionId: 'posts', entryId: 'en_two', terms: { categories: ['news'] } }]]);
    // Now every one is: clearing it takes both out.
    await action(/Categories and tags/);
    await dialog.getByRole('checkbox', { name: 'News' }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(async () => {
      const p = await project();
      return [p.collections.posts.entries.en_one.terms?.categories ?? [], p.collections.posts.entries.en_two.terms?.categories ?? []];
    }).toEqual([[], []]);
  });

  it('a plain click opens the post and lets go of the picked ones', async () => {
    await mount(blog());
    await row('One').click({ modifiers: ['Meta'] });
    await row('Two').click({ modifiers: ['Meta'] });
    // Even on a picked row.
    await row('Two').click();
    // The open post is the selection again once it opens.
    await expect.poll(selected).toEqual(['en_two']);
    expect(await row('Two').getAttribute('aria-current')).toBe('true');
    expect(await page.getByRole('group', { name: /selected/ }).count()).toBe(0);
  });

  it('deletes nothing when a picked post drops out of the pick while the question is open', async () => {
    await mount(blog());
    await page.getByRole('radio', { name: /Drafts/ }).click();
    await row('Two').click({ modifiers: ['Meta'] });
    await row('Three').click({ modifiers: ['Meta'] });
    await action('Delete 2 posts…');
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect.poll(() => dialog.textContent()).toContain('Delete 2 posts?');
    // Published meanwhile (as another window or the assistant would): the Drafts filter hides it, and lets go of it.
    await so('apply', [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_three', draft: false }]);
    await expect.poll(selected).toEqual(['en_two']);
    await dialog.getByRole('button', { name: 'Delete 2 posts' }).click();
    await expect.poll(async () => (await so<string[]>('toasts')).join(' ')).toContain('changed meanwhile, so nothing was changed');
    expect(Object.keys((await project()).collections.posts.entries)).toHaveLength(5);
  });

  it('deletes nothing when a link to a picked post lands while the question is open', async () => {
    await mount(blog());
    await row('One').click({ modifiers: ['Meta'] });
    await row('Two').click({ modifiers: ['Meta'] });
    await action('Delete 2 posts…');
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect.poll(() => dialog.textContent()).toContain('Delete 2 posts?');
    await so('apply', [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_three', body: [{ type: 'p', spans: [{ text: 'two', link: { type: 'entry', target: 'en_two' } }] }] }]);
    await dialog.getByRole('button', { name: 'Delete 2 posts' }).click();
    await expect.poll(async () => (await so<string[]>('toasts')).join(' ')).toContain('changed meanwhile, so none was deleted');
    expect(Object.keys((await project()).collections.posts.entries)).toHaveLength(5);
  });

  it('a picked row’s menu offers what is done to them all, and its own commands', async () => {
    await mount(blog());
    await row('Four').click({ modifiers: ['Meta'] });
    await row('Five').click({ modifiers: ['Meta'] });
    await row('Five').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect.poll(() => menu.getByRole('menuitem').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Delete 2 posts…'), expect.stringContaining('Delete post…'), expect.stringContaining('Duplicate as draft'), expect.stringContaining('Deselect post')]));
    await menu.getByRole('menuitem', { name: /Deselect post/ }).click();
    await expect.poll(selected).toEqual(['en_four']);
  });

  it('closes the categories and tags dialog once a post it was for is gone, filing nothing', async () => {
    await mount(blog());
    await row('One').click({ modifiers: ['Meta'] });
    await row('Two').click({ modifiers: ['Meta'] });
    await action(/Categories and tags/);
    const dialog = page.getByRole('dialog', { name: /Categories and tags of 2 posts/ });
    await dialog.getByRole('checkbox', { name: 'News' }).click();
    await so('apply', [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_two' }]);
    await expect.poll(() => dialog.count()).toBe(0);
    expect((await so<string[]>('toasts')).join(' ')).toContain('picked changed, so nothing was filed');
    expect((await project()).collections.posts.entries.en_one.terms?.categories ?? []).toEqual([]);
  });
});
