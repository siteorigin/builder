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
  '  toasts: () => useStore.getState().toasts.map((t) => t.text),',
  '  assets: () => useStore.getState().snapshot.state.assets.assets,',
  '  modal: () => useStore.getState().modal?.kind ?? null',
  '};'
].join('\n');

/**
 * The preload bridge: a dropped file's path is its name under /drops (none for a file named `nopath`), every file is
 * reviewed as one to import as it is, every edit is taken, and each import waits for the test to release it with the
 * IDs it added (or a refusal). `t` is the page's side of the test: drops, the text's blocks, and what the bridge heard.
 */
const BRIDGE = `
  window.drop = { lookups: 0, reviews: [], imports: [], applies: 0 };
  const answers = {
    'pathForFile': (file) => (window.drop.lookups++, file.name === 'nopath' ? '' : '/drops/' + file.name),
    // A HEIC photo is read until the test lets it go, and then needs the author to confirm its conversion.
    'project.reviewImport': (paths, only) => {
      window.drop.reviews.push({ paths, only });
      if (!paths[0].endsWith('.heic')) return Promise.resolve({ paths, rows: paths.map((path) => ({ path, action: 'import' })) });
      return new Promise((resolve) => (window.drop.read = () => resolve({ paths, rows: paths.map((path) => ({ path, action: 'convert', fingerprint: 'f', format: 'heic' })) })));
    },
    'project.apply': () => (window.drop.applies++, Promise.resolve({ ok: true })),
    'project.importAssets': (paths, only, choices) => new Promise((resolve) => window.drop.imports.push({ paths, only, choices, release: (assetIds, message) => resolve({ ok: !message, assetIds, message }) }))
  };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => (answers[path] ? answers[path](...args) : path === 'on' ? () => {} : Promise.resolve(undefined))
  });
  window.builder = any('');
  const text = () => document.querySelector('#writer .post-body');
  window.t = {
    // Files named \`names\` let go at the middle of block \`index\` of the text, or just above it ('above').
    drop: async (names, index, edge, type = 'Files') => {
      const root = text();
      const box = root.children[index].getBoundingClientRect();
      const data = new DataTransfer();
      if (type === 'Files') for (const n of names) data.items.add(new File(['x'], n, { type: 'image/jpeg' }));
      else data.setData('text/plain', names.join(' '));
      const y = edge === 'above' ? box.top - 2 : box.top + box.height / 2;
      const at = { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: y, dataTransfer: data };
      const over = new DragEvent('dragover', at);
      (root.children[index] ?? root).dispatchEvent(over);
      await window.t.frames(2);
      const line = document.querySelector('[data-testid="post-drop-line"]');
      // Where the line is drawn from the top of the text (the page here has no styles to place it by).
      const shown = line ? parseFloat(line.style.top) - Math.round(root.getBoundingClientRect().top - root.parentElement.getBoundingClientRect().top) : null;
      const e = new DragEvent('drop', at);
      (root.children[index] ?? root).dispatchEvent(e);
      await window.t.frames(2);
      return { accepted: over.defaultPrevented, line: shown, taken: e.defaultPrevented, lineAfter: !!document.querySelector('[data-testid="post-drop-line"]') };
    },
    blocks: () => [...text().children].map((b) => (b.matches('figure') ? 'figure:' + b.dataset.assetId : b.textContent.trim())),
    figure: () => { const f = text().querySelector('figure.post-figure'); return f && { alt: f.dataset.alt, caption: f.dataset.caption ?? null, figcaption: !!f.querySelector('figcaption') }; },
    // The caret put across the words of block \`from\` to block \`to\`, made backwards (its anchor after its focus).
    select: (from, to) => { const r = text(); r.focus(); getSelection().setBaseAndExtent(r.children[to].firstChild, 3, r.children[from].firstChild, 1); },
    selection: () => { const s = getSelection(); const r = text(); const at = (n) => [...r.children].findIndex((b) => b.contains(n)); return [at(s.anchorNode), s.anchorOffset, at(s.focusNode), s.focusOffset]; },
    heard: () => ({ lookups: window.drop.lookups, reviews: window.drop.reviews, imports: window.drop.imports.map(({ paths, only, choices }) => ({ paths, only, choices })), applies: window.drop.applies }),
    release: (i, ids, message) => window.drop.imports[i].release(ids, message),
    read: () => window.drop.read(),
    frames: (n) => new Promise((done) => { const next = (k) => (k ? requestAnimationFrame(() => next(k - 1)) : done()); next(n); })
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
  const dialog = () => page.getByRole('dialog', { name: 'Add picture' });
  /** Runs `name` of the page's side of the test (BRIDGE's `t`). */
  const t = <R = unknown>(name: string, ...args: unknown[]): Promise<R> => page.evaluate(([name, args]) => (globalThis as unknown as { t: Record<string, (...a: unknown[]) => unknown> }).t[name](...args), [name, args] as const) as Promise<R>;
  const so = (name: string, arg: unknown) => page.evaluate(([name, arg]) => (globalThis as unknown as { so: Record<string, (a: unknown) => unknown> }).so[name](arg), [name, arg] as const);
  type Dropped = { accepted: boolean; line: number | null; taken: boolean; lineAfter: boolean };
  const drop = (names: string[], index: number, edge: 'middle' | 'above' = 'middle', type: 'Files' | 'text' = 'Files') => t<Dropped>('drop', names, index, edge, type);
  const blocks = () => t<string[]>('blocks');
  type Heard = { lookups: number; reviews: Array<{ paths: string[]; only: string }>; imports: Array<{ paths: string[]; only: string; choices: unknown }>; applies: number };
  const heard = () => t<Heard>('heard');
  const imports = async () => (await heard()).imports.length;
  const toasts = () => page.evaluate(() => (globalThis as unknown as { so: { toasts(): string[] } }).so.toasts());
  const images = () => page.evaluate(() => Object.values((globalThis as unknown as { so: { assets(): Record<string, { kind: string }> } }).so.assets()).filter((a) => a.kind === 'image').length);
  /** Import `i` answers with `ids`, then the project's next change brings their records. */
  async function land(i: number, ids: string[], state: ProjectState = withKiln) {
    await expect.poll(imports).toBeGreaterThan(i);
    await t('release', i, ids);
    await so('change', state);
  }
  const TEXT = BODY.map((b) => (b.type === 'p' ? b.spans[0].text : ''));

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
    expect(await images()).toBe(0);
    const dropped = await drop(['kiln.jpg'], 1);
    // Taken, with a line shown between the block dropped on and the next, and gone once let go.
    expect(dropped.accepted && dropped.taken).toBe(true);
    expect(dropped.line).toBeGreaterThan(0);
    expect(dropped.lineAfter).toBe(false);
    await expect.poll(imports).toBe(1);
    expect((await heard()).reviews).toEqual([{ paths: ['/drops/kiln.jpg'], only: 'image' }]);
    expect((await heard()).imports).toEqual([{ paths: ['/drops/kiln.jpg'], only: 'image', choices: { opening: 'w', files: [] } }]);
    // The import has answered, but the project has not yet brought the record: nothing is asked until it has.
    await t('release', 0, [kiln.id]);
    await t('frames', 3);
    expect(await dialog().count()).toBe(0);
    await so('change', withKiln);
    await dialog().waitFor();
    expect(await blocks()).toEqual(TEXT);
    // The photo is chosen, with the description Assets suggests, ready to check and caption.
    expect(await dialog().getByText('Chosen: kiln.jpg').count()).toBe(1);
    expect(await dialog().getByLabel('Description').inputValue()).toBe('The kiln, glowing orange');
    expect(await dialog().getByLabel('Caption').inputValue()).toBe('');
    await dialog().getByLabel('Caption').fill('First firing of the year.');
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await expect.poll(blocks).toEqual([TEXT[0], TEXT[1], 'figure:img_kiln', TEXT[2]]);
    expect(await t('figure')).toEqual({ alt: 'The kiln, glowing orange', caption: 'First firing of the year.', figcaption: true });
  });

  it('puts a photo dropped above the first block before it, with no caption unless one is written', async () => {
    const dropped = await drop(['kiln.jpg'], 0, 'above');
    expect(dropped.line).toBeLessThan(0);
    await land(0, [kiln.id]);
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await expect.poll(blocks).toEqual(['figure:img_kiln', ...TEXT]);
    expect(await t('figure')).toEqual({ alt: 'The kiln, glowing orange', caption: null, figcaption: false });
  });

  it('asks for a description when Assets suggests none; Cancel leaves the text and the caret as they were, and the photo in Assets', async () => {
    const plain = structuredClone(withKiln);
    delete plain.assets.assets[kiln.id].altSuggestion;
    await t('select', 0, 2);
    await t('frames', 2);
    const before = await t<number[]>('selection');
    expect(before).toEqual([2, 3, 0, 1]);
    const saves = (await heard()).applies;
    await drop(['kiln.jpg'], 1);
    await land(0, [kiln.id], plain);
    await dialog().waitFor();
    expect(await dialog().getByLabel('Description').inputValue()).toBe('');
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await dialog().getByText('Describe what the picture shows, or turn on Decorative image.').waitFor();
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => dialog().count()).toBe(0);
    await expect.poll(() => t<number[]>('selection')).toEqual(before);
    expect(await blocks()).toEqual(TEXT);
    expect((await heard()).applies).toBe(saves);
    expect(await images()).toBe(1);
  });

  it('opens no dialog for an import that finishes after the author has moved to another post: the photo stays in Assets', async () => {
    await drop(['kiln.jpg'], 1);
    await expect.poll(imports).toBe(1);
    await so('set', { post: { collectionId: 'posts', entryId: 'en_autumn' } });
    await body().getByText('Autumn is for glazing.').waitFor();
    await land(0, [kiln.id]);
    await expect.poll(toasts).toContain('“kiln.jpg” was added to Assets.');
    expect(await dialog().count()).toBe(0);
    expect(await body().locator('figure').count()).toBe(0);
    // Back on the first post, its text is as it was: nothing was put in it.
    await so('set', { post: { collectionId: 'posts', entryId: 'en_spring' } });
    await body().getByText(TEXT[0]).waitFor();
    expect(await blocks()).toEqual(TEXT);
  });

  it('asks nothing and imports nothing for a photo still being read when the author moves to another post', async () => {
    await drop(['kiln.heic'], 1);
    await expect.poll(async () => (await heard()).reviews.length).toBe(1);
    await so('set', { post: { collectionId: 'posts', entryId: 'en_autumn' } });
    await body().getByText('Autumn is for glazing.').waitFor();
    await t('read');
    await t('frames', 3);
    expect(await so('modal', null)).toBe(null);
    expect(await imports()).toBe(0);
  });

  it('opens no dialog for an import that finishes while the writer is put away', async () => {
    await drop(['kiln.jpg'], 1);
    await expect.poll(imports).toBe(1);
    await so('set', { leftTab: 'assets' });
    await land(0, [kiln.id]);
    await expect.poll(toasts).toContain('“kiln.jpg” was added to Assets.');
    await so('set', { leftTab: 'posts' });
    await t('frames', 2);
    expect(await dialog().count()).toBe(0);
  });

  it('keeps only the latest of two drops: the first photo stays in Assets, the second goes where it was dropped', async () => {
    await drop(['kiln.jpg'], 2);
    await expect.poll(imports).toBe(1);
    await drop(['wheel.jpg'], 0);
    await expect.poll(imports).toBe(2);
    expect((await heard()).imports.map((i) => i.paths)).toEqual([['/drops/kiln.jpg'], ['/drops/wheel.jpg']]);
    // The first finishes while the second is still being copied: it is not offered.
    await land(0, [kiln.id]);
    await expect.poll(toasts).toContain('“kiln.jpg” was added to Assets.');
    expect(await dialog().count()).toBe(0);
    const wheel = image('img_wheel', { name: 'wheel.jpg', altSuggestion: 'A potter’s wheel' });
    const both = structuredClone(withKiln);
    both.assets.assets[wheel.id] = wheel;
    await land(1, [wheel.id], both);
    await dialog().waitFor();
    expect(await dialog().getByText('Chosen: wheel.jpg').count()).toBe(1);
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await expect.poll(blocks).toEqual([TEXT[0], 'figure:img_wheel', TEXT[1], TEXT[2]]);
  });

  it('offers the first of several photos dropped at once; the rest stay in Assets', async () => {
    await drop(['kiln.jpg', 'wheel.jpg'], 1);
    await expect.poll(imports).toBe(1);
    expect((await heard()).imports[0].paths).toEqual(['/drops/kiln.jpg', '/drops/wheel.jpg']);
    const wheel = image('img_wheel', { name: 'wheel.jpg' });
    const both = structuredClone(withKiln);
    both.assets.assets[wheel.id] = wheel;
    await land(0, [kiln.id, wheel.id], both);
    await dialog().waitFor();
    expect(await dialog().getByText('Chosen: kiln.jpg').count()).toBe(1);
  });

  it('goes in by the block in the dropped one’s place when the text is drawn again while the photo is imported', async () => {
    await drop(['kiln.jpg'], 1);
    await expect.poll(imports).toBe(1);
    // A change made somewhere else redraws the text: the block dropped on is a new one now.
    const edited = structuredClone(start);
    edited.collections.posts.entries.en_spring.body = [BODY[0], { type: 'p', spans: [{ text: 'Every student leaves with a set of cups.' }] }, BODY[2]];
    await so('change', edited);
    await body().getByText('Every student leaves with a set of cups.').waitFor();
    const withBoth = structuredClone(edited);
    withBoth.assets.assets[kiln.id] = kiln;
    await land(0, [kiln.id], withBoth);
    await dialog().getByRole('button', { name: 'Add picture' }).click();
    await expect.poll(blocks).toEqual([TEXT[0], 'Every student leaves with a set of cups.', 'figure:img_kiln', TEXT[2]]);
  });

  it('says why when nothing dropped could be added, and opens no dialog', async () => {
    await drop(['notes.txt'], 1);
    await expect.poll(imports).toBe(1);
    await t('release', 0, [], 'notes.txt is not an image.');
    await expect.poll(toasts).toContain('notes.txt is not an image.');
    expect(await dialog().count()).toBe(0);
  });

  it('imports nothing for a drop with no file on disk, or while a picture dialog is open; dragged words keep the browser’s own handling', async () => {
    const none = await drop(['nopath'], 1);
    expect(none.taken).toBe(true);
    expect((await heard()).lookups).toBe(1);
    const words = await drop(['some', 'words'], 1, 'middle', 'text');
    expect(words.accepted || words.taken).toBe(false);
    // The Picture button opens the dialog over the text: a drop meanwhile is not taken up.
    await page.locator('#writer [data-tool="image"]').click();
    await dialog().waitFor();
    await drop(['kiln.jpg'], 1);
    expect(await heard()).toMatchObject({ reviews: [], imports: [] });
  });
});
