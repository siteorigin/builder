/**
 * A live session's copy editor's Inspector (#1318): only the words of a page's own text, and the copy and pictures of
 * a placed section the host grants, with nothing structural, no styles, and no way to add, remove or mark a picture
 * decorative. The real Inspector and store run in a real browser, over a project the engine made.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import { listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { copyEditableProps } from '@engine/copy-editor';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://copy-inspector.test';
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
        name: 'copy-inspector',
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

/** The business starter with a paragraph of the page's own on top, and its Split hero showing a library picture. */
function project() {
  const s0 = createStarterState('business', 'Test Studio', false);
  s0.assets.assets.pic1 = { id: 'pic1', name: 'Studio', file: 'static/assets/pic1.png', mime: 'image/png', bytes: 1, hash: 'pic1', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' };
  const home = s0.site.homePageId;
  const owner = { kind: 'page' as const, id: home };
  const hero = s0.pages[home].rootIds.find((id) => s0.components[(s0.pages[home].nodes[id] as InstanceNode).definitionId]?.componentId === 'hero.split')!;
  const picture = 'pic1';
  const r = applyOperations(s0, [
    { type: 'node.insert', owner, parentId: null, index: 0, primitive: 'paragraph', text: 'Opening hours vary.' },
    { type: 'instance.setProp', owner, nodeId: hero, prop: 'image', value: { assetId: picture, alt: 'The studio' } }
  ]);
  const state: ProjectState = r.state;
  return { state, home, hero, paragraph: r.results[0].nodeId as string };
}

describe.skipIf(!browserInstalled)('a copy editor’s Inspector (#1318)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const { state, home, hero, paragraph } = project();
  const grant = { props: copyEditableProps(state), paused: false };
  const at = (nodeId: string, extra: Partial<ElementRef> = {}): ElementRef => ({ owner: { kind: 'page', id: home }, instancePath: [], nodeId, ...extra });

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 800, height: 900 } });
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

  /** Show the Inspector to a copy editor with `selection` selected, and read its panel. */
  const show = async (selection: ElementRef | null, paused = false) => {
    const snapshot = { workspaceKey: 'remote:join-1', state, revision: 7, diagnostics: [], missingAssets: [], assetUsage: {}, conflicts: [], recoveryNotes: [], runtime: { state: 'starting' }, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: { reason: paused ? 'The host’s AI is making changes.' : 'You’re a copy editor.', canUnlock: false, copyOnly: { ...grant, paused } } };
    await page.evaluate(([snap, sel]) => (globalThis as unknown as { show: (a: unknown, b: unknown) => void }).show((snap as { state: unknown }).state, { leftTab: null, selection: sel, snapshot: snap }), [snapshot, selection] as const);
    const panel = page.locator('#dock-panel-inspect');
    await panel.locator('.panel-body').first().waitFor();
    return panel;
  };

  it('offers a placed section only the copy and picture the host grants, with no styles or layout commands', async () => {
    expect(grant.props[(state.pages[home].nodes[hero] as InstanceNode).definitionId]).toEqual(expect.arrayContaining(['heading', 'image']));
    const panel = await show(at(hero));
    const text = await panel.innerText();
    expect(text).toMatch(/copy editing/);
    expect(await panel.getByLabel('Heading', { exact: true }).count()).toBe(1);
    for (const gone of ['Style', 'Advanced', 'Primary button', 'Heading level', 'Anchor ID']) expect(text, gone).not.toContain(gone);
    // The picture: replaced from the library and described, never removed, imported or marked decorative.
    expect(await panel.getByRole('button', { name: 'Change…' }).count()).toBe(1);
    expect(await panel.getByLabel('Image description').count()).toBe(1);
    expect(await panel.getByRole('button', { name: /^Remove/ }).count()).toBe(0);
    expect(await panel.getByText('Decorative image').count()).toBe(0);
    await panel.getByRole('button', { name: 'Change…' }).click();
    await page.getByRole('dialog').waitFor();
    expect(await page.getByRole('button', { name: /Import/ }).count()).toBe(0);
  });

  it('shows the placement’s copy for a part picked inside it, and a page’s own text by its words', async () => {
    const def = state.components[(state.pages[home].nodes[hero] as InstanceNode).definitionId];
    const part = Object.keys(def.parts).find((p) => p !== 'root') ?? 'root';
    expect(await (await show(at(def.parts[part].nodeId, { instancePath: [hero], partId: part }))).getByLabel('Heading', { exact: true }).count()).toBe(1);
    const panel = await show(at(paragraph));
    expect(await panel.getByLabel('Text', { exact: true }).inputValue()).toBe('Opening hours vary.');
    expect(await panel.innerText()).not.toContain('Style');
  });

  it('says what a copy editor can do with nothing selected, and that the rest is the host’s', async () => {
    expect(await (await show(null)).innerText()).toMatch(/Select text or a section on the page to change its words and pictures/);
    const header = state.site.shell.header.rootIds[0];
    expect(await (await show({ owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: header })).innerText()).toMatch(/Only the host can change this/);
  });

  it('locks its fields while editing is paused, saying why', async () => {
    const panel = await show(at(paragraph), true);
    expect(await panel.innerText()).toContain('The host’s AI is making changes.');
    expect(await panel.getByLabel('Text', { exact: true }).getAttribute('readonly')).not.toBeNull();
  });
});
