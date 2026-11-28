/**
 * Locate file with a different picture gives a missing image a new file everywhere it is used, and the alt text each
 * use carries over was written for the old picture (#1385). The real Assets panel and store run in a real browser:
 * the image's details list those uses to check, as Replace everywhere does, until the change is undone. The same
 * picture put back lists nothing.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, OwnerRef, ProjectState } from '@shared/types';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://asset-locate.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
const TIDE = 'Low Atlantic tide exposes a rock shelf with emerald pools';

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { AssetsPanel } from ${src('renderer/src/panels/AssetsPanel')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  `import { showAsset } from ${src('renderer/src/lib/place')};`,
  "const snapshot = (state, more) => ({ workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, diagnostics: [], recoveryNotes: [], aiBusy: false, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, recentExports: [], runtime: { state: 'stopped' }, ...more });",
  'window.so = {',
  '  mount: (state, more) => {',
  "    flushSync(() => useStore.setState({ screen: 'editor', snapshot: snapshot(state, more), pageId: state.site.homePageId, leftTab: 'assets' }));",
  "    const root = createRoot(document.getElementById('root'));",
  '    flushSync(() => root.render(h(AssetsPanel, { narrow: false })));',
  '  },',
  // A new snapshot, as one arrives over IPC.
  '  receive: (state, more) => flushSync(() => useStore.setState({ snapshot: snapshot(state, more) })),',
  "  show: (id) => flushSync(() => showAsset('w', id)),",
  '  toasts: () => useStore.getState().toasts.map((t) => ({ text: t.text, action: t.action?.label ?? null })),',
  '};'
].join('\n');

/** Every call to main answers nothing, but Locate file, which answers what the test sets in `window.located`. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => (path === 'on' ? () => {} : path === 'project.locateAsset' ? Promise.resolve(window.located) : Promise.resolve(undefined))
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
        name: 'asset-locate',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The assets panel did not bundle');
  return chunk.code;
}

/** A blank site whose tide photo is shown twice with its description, and once as decoration. */
function tidePools(): ProjectState {
  const tide: AssetRecord = { id: 'a_tide', name: 'Tide pools', file: 'static/assets/tide-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 2000, width: 1600, height: 900, hash: 'tide', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z', altSuggestion: TIDE };
  const state = createStarterState('blank', 'Coast', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  let r = applyOperations(state, [{ type: 'asset.add', asset: tide }, { type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  const section = r.results.at(-1)!.nodeId as string;
  r = applyOperations(r.state, [
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' },
    { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' }
  ]);
  const [one, two, three] = r.results.map((x) => x.nodeId as string);
  const set = (nodeId: string, value: unknown): EditOperation => ({ type: 'node.setContent', owner, nodeId, field: 'image', value });
  return applyOperations(r.state, [set(one, { assetId: 'a_tide', alt: TIDE }), set(two, { assetId: 'a_tide', alt: 'The shelf at low water' }), set(three, { assetId: 'a_tide', alt: '', decorative: true })]).state;
}

describe.skipIf(!browserInstalled)('Locate file with a different picture, in the image’s details (#1385)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><aside class="side-panel" style="width: 320px; height: 700px; display: flex; flex-direction: column"><div id="root" style="display: contents"></div></aside><script>${BRIDGE}</script><script src="/app.js"></script></body>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  type Snap = { revision: number; assetUsage?: Record<string, number>; missingAssets?: unknown[]; history?: unknown };
  const mount = (s: ProjectState, more: Snap) => page.evaluate(([x, m]) => (globalThis as unknown as { so: { mount(s: unknown, m: unknown): void } }).so.mount(x, m), [s, more] as unknown[]);
  const receive = (s: ProjectState, more: Snap) => page.evaluate(([x, m]) => (globalThis as unknown as { so: { receive(s: unknown, m: unknown): void } }).so.receive(x, m), [s, more] as unknown[]);
  const toasts = () => page.evaluate<Array<{ text: string; action: string | null }>>('so.toasts()');
  const missing = { assetUsage: { a_tide: 3 }, missingAssets: [{ assetId: 'a_tide', original: true, variants: [] }] };
  const history = (applied: boolean) => ({ canUndo: applied, canRedo: !applied, entries: [{ id: 'e_relink', label: 'Relink Tide pools', applied }] });

  async function openMissing(state: ProjectState) {
    await mount(state, { revision: 1, ...missing });
    await page.evaluate('so.show("a_tide")');
    await page.getByRole('button', { name: 'Locate file…' }).waitFor();
    // Before choosing, the note says a different picture would show in every place.
    expect(await page.locator('.asset-missing').textContent()).toContain('Locate the file to bring it back (another picture chosen there shows in every place), or replace it everywhere.');
  }

  it('lists the uses that carried their alt text over, says so with Undo, and drops the list once undone', async () => {
    const state = tidePools();
    const relinked = applyOperations(state, [{ type: 'asset.relink', assetId: 'a_tide', file: 'static/assets/mussels-9f8e7d6c.png', mime: 'image/png', bytes: 3000, hash: 'mussels', width: 1200, height: 800 }]);
    await page.evaluate((r) => ((globalThis as unknown as { located: unknown }).located = r), { ok: true, message: 'mussels.png now shows wherever Tide pools is used.', entryId: 'e_relink', revision: 2, altReview: relinked.results[0].altReview });
    await openMissing(state);
    await page.getByRole('button', { name: 'Locate file…' }).click();
    await expect.poll(toasts).toContainEqual(expect.objectContaining({ action: 'Undo' }));
    // Until the snapshot with the new file arrives, the places still show nothing new: no review yet.
    expect(await page.getByTestId('asset-alt-review').count()).toBe(0);
    // The new snapshot arrives after the reply, as it can from main.
    await receive(relinked.state, { revision: 2, assetUsage: { a_tide: 3 }, missingAssets: [], history: history(true) });
    const note = page.getByTestId('asset-alt-review');
    await note.waitFor();
    expect(await note.locator('#asset-alt-review-title').textContent()).toBe('Check the alt text in 2 places.');
    expect(await note.locator(':scope > div > span').first().textContent()).toMatch(/They now show the new file, but their alt text was written for the old picture, or is empty\.$/);
    expect(await note.locator('.asset-alt-text').allTextContents()).toEqual([`Carried over: “${TIDE}”`, 'Carried over: “The shelf at low water”']);
    expect(await toasts()).toContainEqual({ text: 'mussels.png now shows wherever Tide pools is used. Check the alt text in 2 places below.', action: 'Undo' });
    // Undone, the image shows its old file again: nothing is left to check.
    await receive(state, { revision: 3, ...missing, history: history(false) });
    await expect.poll(() => note.count()).toBe(0);
  });

  it('lists nothing when the same picture is put back', async () => {
    const state = tidePools();
    await page.evaluate(() => ((globalThis as unknown as { located: unknown }).located = { ok: true, message: 'Tide pools is back in the project folder.' }));
    await openMissing(state);
    await page.getByRole('button', { name: 'Locate file…' }).click();
    await expect.poll(toasts).toContainEqual({ text: 'Tide pools is back in the project folder.', action: null });
    await receive(state, { revision: 1, assetUsage: { a_tide: 3 }, missingAssets: [] });
    expect(await page.getByTestId('asset-alt-review').count()).toBe(0);
  });
});
