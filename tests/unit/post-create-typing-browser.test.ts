/**
 * Typing straight on after Create draft (#1394): while the new entry is made, the writer still shows the one open
 * before it. What is typed then, after Enter in the title or with a click on the writer still showing, reaches the new
 * entry once it opens, and never the one before it. The real Content panel, writer and store run in a real browser, over
 * a stand-in for the preload bridge whose edits take a moment to land, as main's do; making an entry waits for the test.
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
import { starterCollectionOps } from '../../src/renderer/src/lib/content';

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
  // The writer is put away while the open post is previewed, as the editor does.
  'function Editor() {',
  '  const previewing = useStore((s) => s.postView === "preview");',
  '  return h("div", null, h("div", { id: "panel" }, h(PostsPanel)), h("div", { id: "writer" }, h(PostWriter, { hidden: previewing })));',
  '}',
  'window.mount = (state, post, assetUsage, collection) => {',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null }, pageId: state.site.homePageId,",
  "    leftTab: 'posts', post: post && { collectionId: 'posts', entryId: post }, postView: 'write', contentCollection: collection",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  '};',
  // Main's side of an edit: checked against the revision it was planned for, applied, the project sent on, then answered.
  // Making an entry waits until the test lets it go; with `lag`, the project arrives after the answer, as it may.
  'window.edit = async (batch) => {',
  '  const making = batch.operations.some((o) => o.type === "entry.create");',
  '  if (making) await new Promise((r) => (window.release = r));',
  '  else await new Promise((r) => setTimeout(r, 30));',
  '  if (making) window.release = null;',
  '  const s = useStore.getState().snapshot;',
  "  if (batch.operations.some((o) => o.type === window.refuse)) return { ok: false, revision: s.revision, error: { code: 'INVALID_OPERATION', message: 'That change could not be applied.' } };",
  "  if (batch.expectedRevision !== undefined && batch.expectedRevision !== s.revision) return { ok: false, revision: s.revision, error: { code: 'STALE_REVISION', message: 'Stale' } };",
  '  const r = applyOperations(s.state, batch.operations);',
  '  const revision = s.revision + 1;',
  '  const send = () => useStore.setState({ snapshot: { ...s, state: r.state, revision } });',
  '  if (making && window.lag) setTimeout(send, window.lag);',
  '  else send();',
  "  return { ok: true, revision, results: r.results, entryId: 'h' + revision };",
  '};',
  'window.so = {',
  '  snapshot: () => useStore.getState().snapshot,',
  // Each entry's text as the project has it, by title: its paragraphs one per line.
  '  bodies: () => Object.fromEntries(Object.values(useStore.getState().snapshot.state.collections.posts.entries).map((e) => [e.title, (e.body ?? []).map((b) => (b.spans ?? []).map((x) => x.text).join("")).join("\\n")])),',
  '  values: (c) => Object.fromEntries(Object.values(useStore.getState().snapshot.state.collections[c].entries).map((e) => [e.title, e.values])),',
  '  open: () => { const p = useStore.getState().post; return p && useStore.getState().snapshot.state.collections[p.collectionId].entries[p.entryId]?.title; },',
  '  toasts: () => useStore.getState().toasts.map((t) => t.text),',
  // The control with focus, by its name: its own label, or the label it is under.
  '  focused: () => { const a = document.activeElement; return a === document.body ? "body" : a?.getAttribute("aria-label") ?? a?.labels?.[0]?.textContent ?? a?.className ?? null; },',
  '  waiting: () => typeof window.release === "function",',
  '  drafting: () => useStore.getState().drafting,',
  '  set: (patch) => flushSync(() => useStore.setState(patch)),',
  '  release: () => window.release()',
  '};'
].join('\n');

/** The preload bridge: edits go through `edit` above; one with an operation of the `refuse` type is refused. */
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

/** A blog with Post 1 open, a line of text in it, and an older Post 0. */
function site(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_zero', title: 'Post 0', publishedAt: '2027-01-02', body: [{ type: 'p', spans: [{ text: 'The oldest post.' }] }] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'Post 1', publishedAt: '2027-03-02', body: [{ type: 'p', spans: [{ text: 'The first post.' }] }] }
  );
}

const BEFORE = { 'Post 0': 'The oldest post.', 'Post 1': 'The first post.' };

describe.skipIf(!browserInstalled)('typing straight on after Create draft (#1394)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const start = site();

  const so = <R = unknown>(name: string, arg?: unknown): Promise<R> => page.evaluate(([name, arg]) => (globalThis as unknown as { so: Record<string, (a: unknown) => unknown> }).so[name](arg), [name, arg] as const) as Promise<R>;
  const bodies = () => so<Record<string, string>>('bodies');
  const open = () => so<string | null>('open');
  const toasts = () => so<string[]>('toasts');
  const focused = () => so<string | null>('focused');
  /** Lets the entry being made land in the project, once it has been asked for. */
  async function release() {
    await expect.poll(() => so<boolean>('waiting')).toBe(true);
    await so('release');
  }
  const set = (key: string, value: unknown) => page.evaluate(([key, value]) => ((globalThis as unknown as Record<string, unknown>)[key] = value), [key, value] as const);
  /** The New post form (or New `noun`), opened from the panel's head, with `title` typed in it. */
  async function typeTitle(title: string, noun = 'post') {
    await page.locator('#panel').getByRole('button', { name: `New ${noun}` }).click();
    const field = page.getByLabel(`New ${noun} title`);
    // Focused by the form once it is drawn: typed into only then, so that focus never comes after the Enter that follows.
    await expect.poll(focused).toBe(`New ${noun} title`);
    await field.pressSequentially(title);
  }
  /** While the entry is made: the writer still shows Post 1, as it was, and takes nothing; it says what it waits for. */
  async function waitingFor(note: string) {
    expect(await page.locator('#writer .post-hold').getAttribute('inert')).not.toBeNull();
    expect(await page.locator('#writer .post-opening-note').textContent()).toBe(` ${note}`);
    expect(await page.locator('#writer .post-title-input').inputValue()).toBe('Post 1');
    expect(await page.locator('#writer .post-body').textContent()).toBe('The first post.');
  }
  async function mount(state: ProjectState, post: string | null, collection: string) {
    await page.evaluate(([state, post, usage, collection]) => (globalThis as unknown as { mount(s: unknown, p: unknown, u: unknown, c: unknown): void }).mount(state, post, usage, collection), [state as unknown, post, assetUsages(state), collection] as const);
  }
  const mountBlog = async () => {
    await mount(start, 'en_one', 'posts');
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
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('keeps every key typed after Enter in the title, and puts them in the new post’s text', async () => {
    await mountBlog();
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    // Straight on, while the draft is made.
    await page.keyboard.type('MARKER-2', { delay: 20 });
    await waitingFor('Opening “Post 2”…');
    await release();
    await expect.poll(open).toBe('Post 2');
    // Into its text, where typing goes on.
    expect(await focused()).toBe('Post text');
    await page.keyboard.type(' body');
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER-2 body' });
    expect(await page.locator('#writer .post-opening').count()).toBe(0);
    expect(await page.locator('#writer .post-hold').getAttribute('inert')).toBeNull();
  });

  it('puts what is typed with a click on the writer still showing the last post in the new one, never the last', async () => {
    await mountBlog();
    await typeTitle('Post 2');
    await page.getByRole('button', { name: 'Create draft' }).click();
    // Into the text still on screen, at once, as the draft is made.
    await page.locator('#writer .post-body').click({ force: true });
    await page.keyboard.type('MARKER-3', { delay: 20 });
    await waitingFor('Opening “Post 2”…');
    expect(await focused()).toBe('Text for “Post 2”');
    await release();
    await expect.poll(open).toBe('Post 2');
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER-3' });
  });

  it('takes corrections and new paragraphs as typed, and a composition once it has ended', async () => {
    await mountBlog();
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('MARKX');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('ER');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Secnd');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('o');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    // An IME composition still open when the draft is made: it opens once the composition is committed.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await release();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
    expect(await open()).toBe('Post 1');
    await waitingFor('Opening “Post 2”…');
    await cdp.send('Input.insertText', { text: '日本' });
    await expect.poll(open).toBe('Post 2');
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER\nSecond\n日本' });
  });

  it('shows the writer when a post is made while the open one is previewed, and counts what is typed ahead as unsaved', async () => {
    await mountBlog();
    await so('set', { postView: 'preview' });
    expect(await page.locator('#writer .post-writer').getAttribute('hidden')).not.toBeNull();
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('MARKER-9', { delay: 20 });
    expect(await page.locator('#writer .post-writer').getAttribute('hidden')).toBeNull();
    expect(await focused()).toBe('Text for “Post 2”');
    // Leaving the project meanwhile would say something is not saved yet.
    expect(await so<number>('drafting')).toBeGreaterThan(0);
    await release();
    await expect.poll(open).toBe('Post 2');
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER-9' });
    await expect.poll(() => so<number>('drafting')).toBe(0);
  });

  it('waits for the new post to be in the project when the answer comes before it', async () => {
    await mountBlog();
    await set('lag', 300);
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('MARKER-7', { delay: 20 });
    await release();
    await expect.poll(open).toBe('Post 2');
    expect(await focused()).toBe('Post text');
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER-7' });
    expect(await toasts()).toEqual([]);
  });

  it('saves what was typed in the new post when another is chosen before it opens, and says so', async () => {
    await mountBlog();
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('MARKER-4', { delay: 20 });
    // Post 0 chosen in the list while the draft is made: that choice stands.
    await page.locator('#panel [data-post="en_zero"]').click();
    await release();
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER-4' });
    expect(await open()).toBe('Post 0');
    await expect.poll(toasts).toContain('What you typed is saved in “Post 2”.');
  });

  it('leaves typing in Find where it is, and saves what was typed ahead in the new post, waiting in the list', async () => {
    await mountBlog();
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('MARKER-8', { delay: 20 });
    const find = page.getByLabel('Find a post by title, address, author or excerpt');
    await find.click();
    // A find the new post does not match: opening it would take the find away.
    await page.keyboard.type('oldest');
    await release();
    await expect.poll(bodies).toEqual({ ...BEFORE, 'Post 2': 'MARKER-8' });
    await expect.poll(toasts).toContain('What you typed is saved in “Post 2”.');
    // Find kept its words and its focus, and the post open stays.
    expect(await find.inputValue()).toBe('oldest');
    expect(await focused()).toBe('Find a post by title, address, author or excerpt');
    expect(await open()).toBe('Post 1');
    expect(await page.locator('#writer .post-hold').getAttribute('inert')).toBeNull();
  });

  it('says what was typed was not kept when the draft could not be made, and only then', async () => {
    await mountBlog();
    await set('refuse', 'entry.create');
    // Refused with nothing typed for it: only the refusal is said.
    await typeTitle('Post 2');
    await page.keyboard.press('Enter');
    await release();
    await expect.poll(toasts).toContain('That change could not be applied.');
    expect((await toasts()).some((t) => t.includes('was not kept'))).toBe(false);
    // Refused again, with words typed for it.
    await page.getByLabel('New post title').press('Enter');
    await page.keyboard.type('MARKER-6', { delay: 20 });
    await release();
    await expect.poll(toasts).toContain('What you typed for “Post 2” was not kept: it was not made.');
    expect(await bodies()).toEqual(BEFORE);
    expect(await open()).toBe('Post 1');
    // The form keeps its title to try again, and the writer takes typing again.
    expect(await page.getByLabel('New post title').inputValue()).toBe('Post 2');
    expect(await page.locator('#writer .post-hold').getAttribute('inert')).toBeNull();
    expect(await page.locator('#writer .post-opening').count()).toBe(0);
  });

  it('takes nothing into the writer still showing the post while a copy of it is made', async () => {
    await mountBlog();
    await page.locator('#panel [data-post="en_one"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate as draft' }).click();
    await page.locator('#writer .post-body').click({ force: true });
    await page.keyboard.type('MARKER-5', { delay: 20 });
    await waitingFor('Opening the copy…');
    await release();
    await expect.poll(open).toBe('Post 1 (copy)');
    expect(await bodies()).toEqual({ ...BEFORE, 'Post 1 (copy)': 'The first post.' });
  });

  it('shows every title whole from the list’s options, then two lines again', async () => {
    await mountBlog();
    const list = page.locator('#panel .posts-list');
    const toggle = page.getByRole('menuitemcheckbox', { name: /Show full titles/ });
    expect(await list.getAttribute('class')).not.toContain('full-titles');
    await page.locator('#panel').getByRole('button', { name: 'Posts options' }).click();
    expect(await toggle.getAttribute('aria-checked')).toBe('false');
    await toggle.click();
    await expect.poll(() => list.getAttribute('class')).toContain('full-titles');
    await page.locator('#panel').getByRole('button', { name: 'Posts options' }).click();
    expect(await toggle.getAttribute('aria-checked')).toBe('true');
    await toggle.click();
    await expect.poll(() => list.getAttribute('class')).not.toContain('full-titles');
  });

  it('opens a new record at its first field, with what was typed while it was made', async () => {
    const team = starterCollectionOps(start, 'team')!;
    await mount(run(start, ...team.ops), null, team.collectionId);
    await typeTitle('Ada Potter', 'team member');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Head potter', { delay: 20 });
    await release();
    await expect.poll(open).toBe('Ada Potter');
    const role = page.locator('#writer').getByLabel('Role');
    expect(await role.inputValue()).toBe('Head potter');
    expect(await focused()).toBe('Role');
    // Saved as the field's value once it is left, as typing there is.
    await role.blur();
    await expect.poll(async () => (await so<Record<string, Record<string, unknown>>>('values', team.collectionId))['Ada Potter']?.role).toBe('Head potter');
  });
});
