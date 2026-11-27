/**
 * The panels that stay live while hidden (#968): the SEO view and the post writer, each holding a post, and the AI panel
 * with a provider connected. Their settings and requests keep following the project, but what they work out over the
 * whole site only to show it (the SEO overview's findings, where a post is published, the AI panel's starters) waits
 * until they show, and is up to date in the very commit that shows them. The real panels and store run in a real browser.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { assetUsages } from '@engine/apply';
import { run, seoSite } from './fixtures/seo-site';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://hidden-work.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
const PROVIDERS = JSON.stringify([{ id: 'local', label: 'Local model', configured: true, source: 'stored', storage: 'local-file', models: [{ id: 'test-model', label: 'Test model' }] }]);

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Chat } from ${src('renderer/src/panels/Chat')};`,
  `import { SeoView } from ${src('renderer/src/panels/SeoView')};`,
  `import { PostWriter } from ${src('renderer/src/panels/PostWriter')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  `import { countSeoOverviews } from ${src('renderer/src/lib/seo-overview')};`,
  `import { countChatStarters } from ${src('renderer/src/lib/chatSuggestions')};`,
  'window.work = { overviews: 0, starters: 0 };',
  'countSeoOverviews(() => window.work.overviews++);',
  'countChatStarters(() => window.work.starters++);',
  "const settings = { ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: 'http://127.0.0.1:9/v1', allowRemote: false, toolMode: 'native', contextWindow: null, modelsByServer: {} }, sendOnEnter: true }, developerMode: false };",
  'function Editor() {',
  '  const leftTab = useStore((s) => s.leftTab);',
  "  const chatShown = useStore((s) => s.dockOpen && s.rightTab === 'chat');",
  '  return h("div", null,',
  '    h("div", { id: "chat", hidden: !chatShown }, h(Chat)),',
  '    h("div", { id: "seo", hidden: leftTab !== "seo" }, h(SeoView, { shown: leftTab === "seo" })),',
  '    h("div", { id: "writer" }, h(PostWriter, { hidden: leftTab !== "posts" })));',
  '}',
  'window.mount = (state, post, assetUsage) => {',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, assetUsage, missingAssets: [], revision: 1, history: { canUndo: false, canRedo: false, entries: [] }, readOnly: null }, pageId: state.site.homePageId,",
  "    settings, providers: " + PROVIDERS + ", conversation: { id: 'c_h', title: 'New', createdAt: '2026-11-27T00:00:00.000Z', messages: [] }, chatMode: 'edit',",
  "    dockOpen: true, rightTab: 'chat', leftTab: 'seo', seoSubject: { kind: 'entry', collectionId: 'posts', entryId: post }, post: { collectionId: 'posts', entryId: post }, postView: 'write'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  '};',
  'window.so = {',
  '  set: (patch) => flushSync(() => useStore.setState(patch)),',
  // A change as it arrives from main: the whole project, new objects throughout.
  '  change: (state) => flushSync(() => { const s = useStore.getState().snapshot; useStore.setState({ snapshot: { ...s, state, assetUsage: { ...s.assetUsage }, revision: s.revision + 1 } }); }),',
  // The editor's own counter of the website read for a post's address in its previews (lib/perf, marks on).
  "  routes: () => { window.__siteoriginPerf.mark('probe'); return window.perfRecords.at(-1).c['seo.routes'] ?? 0; },",
  // What Undo can take back, as main says it with a change.
  '  history: (canUndo) => flushSync(() => { const s = useStore.getState().snapshot; useStore.setState({ snapshot: { ...s, history: { ...s.history, canUndo }, revision: s.revision + 1 } }); }),',
  // What an element shows: its tone, else its text; or, after an @, one of its attributes.
  '  read: (sel) => { const [css, attr] = sel.split("@"); const el = document.querySelector(css); return !el ? null : attr ? el.getAttribute(attr) : (el.getAttribute("data-tone") ?? el.textContent); },',
  // Shows a panel, and reads what it shows in that same commit, before any effect or later render.
  '  showing: (patch, read) => { flushSync(() => useStore.setState(patch)); return read.map((sel) => window.so.read(sel)); },',
  "  starters: () => [...document.querySelectorAll('#chat .suggestion')].map((el) => el.textContent.trim()),",
  // The writer's bar buttons, read as it is shown in the same turn, before React draws it again (as a script that shows
  // the writer and presses one of them in one go reads them).
  "  barAsShown: (patch) => { useStore.setState(patch); return [...document.querySelectorAll('#writer .post-bar button')].map((b) => b.textContent.trim()); }",
  '};'
].join('\n');

/** The preload bridge: every call answers a promise of nothing but for what Chat asks of the local server; marks on. */
const BRIDGE = `
  window.perfRecords = [];
  window.builderPerf = { send: (record) => window.perfRecords.push(record) };
  const answers = { 'ai.localContext': { server: 'http://127.0.0.1:9/v1', reportedWindow: null }, 'ai.localModels': { ok: true, models: ['test-model'] }, 'ai.providers': ${PROVIDERS} };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => (path === 'on' ? () => {} : Promise.resolve(answers[path]))
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
        name: 'hidden-work',
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

describe.skipIf(!browserInstalled)('hidden panels that stay live work out nothing they only show (#968)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  const site = seoSite();
  const POST = site.entry;
  // The site's home page with a heading on it, so the AI panel has something on the page to offer starters about.
  const start = structuredClone(site.state);
  start.pages[site.home].nodes.n_welcome = { id: 'n_welcome', kind: 'text', tag: 'h1', text: 'Welcome to the studio' };
  start.pages[site.home].rootIds.push('n_welcome');

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
    await page.evaluate(([state, post, usage]) => (globalThis as unknown as { mount(s: unknown, p: unknown, u: unknown): void }).mount(state, post, usage), [start as unknown, POST, assetUsages(start)] as const);
    await page.locator(`#seo [data-seo-doc="entry:posts:${POST}"]`).waitFor();
    // Under the SEO view, the writer is put away holding the post.
    await page.locator('#writer .post-title-input').waitFor({ state: 'attached' });
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const work = () => page.evaluate(() => ({ ...(globalThis as unknown as { work: { overviews: number; starters: number } }).work, routes: (globalThis as unknown as { so: { routes(): number } }).so.routes() }));
  const so = <T>(fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (globalThis as unknown as { so: Record<string, (...x: unknown[]) => T> }).so[f as string](...(a as unknown[])), [fn, args] as const);
  /** The project as main sends it after an edit: a new copy, changed or not. */
  const sent = (s: ProjectState) => structuredClone(s);

  it('leave the SEO view’s findings and the post’s previews alone while hidden, and show them up to date at once', async () => {
    // The SEO view and the writer put away, each holding the post (the sidebar closed), and the AI panel hidden too.
    await so('set', { leftTab: null, rightTab: 'project' });
    const before = await work();
    // Edits elsewhere, as an Inspector edit sends them: each a whole new project.
    const short = run(start, { type: 'entry.update', collectionId: 'posts', entryId: POST, seoTitle: 'Spring' });
    await so('change', sent(run(start, { type: 'page.update', pageId: site.services, title: 'Our services' })));
    await so('change', sent(short));
    expect(await work()).toEqual(before);
    // Shown again: in the commit that shows it, the SEO view finds the short title and its meter says so.
    const [finding, viewMeter] = await so<Array<string | null>>('showing', { leftTab: 'seo' }, ['#seo .seo-findings', '#seo [data-meter="title"]']);
    expect(finding).toContain('Its search title is short at 6 characters.');
    expect(viewMeter).toBe('short');
    // And the writer, shown in its place, measures the same title.
    const [writerMeter] = await so<Array<string | null>>('showing', { leftTab: 'posts' }, ['#writer [data-meter="title"]']);
    expect(writerMeter).toBe('short');
    const after = await work();
    expect(after.overviews).toBeGreaterThan(before.overviews);
    expect(after.routes).toBeGreaterThan(before.routes);
  });

  it('leave the AI panel’s starters alone while hidden, and offer up-to-date ones at once when shown', async () => {
    // On the page (the SEO view left), the AI panel offers the page's starters, one of them about the Services page.
    await so('set', { leftTab: null });
    expect((await so<string[]>('starters')).some((t) => t.includes('“Services”'))).toBe(true);
    await so('set', { rightTab: 'project' });
    const before = await work();
    // A text on the page selected, and the Services page renamed, while the panel is hidden.
    await so('set', { selection: { owner: { kind: 'page', id: site.home }, nodeId: 'n_welcome' } });
    await so('change', sent(run(start, { type: 'page.update', pageId: site.services, title: 'Our services' })));
    expect((await work()).starters).toBe(before.starters);
    // Shown again, its starters are worked out from the project as it is now, in that same commit.
    const [shown] = await so<Array<string | null>>('showing', { rightTab: 'chat' }, ['#chat .suggestions']);
    expect(shown).toContain('“Our services”');
    expect((await work()).starters).toBeGreaterThan(before.starters);
  });

  it('leave the writer’s bar and toolbar as they were while hidden, and up to date at once when shown', async () => {
    const undo = '#writer [data-tool="undo"]@aria-disabled';
    expect(await so('read', undo)).toBe('true');
    await so('set', { leftTab: null, rightTab: 'project' });
    // An edit elsewhere gives Undo something to take back while the writer is put away.
    await so('history', true);
    expect(await so('read', undo)).toBe('true');
    // Shown, its Undo is on in that same commit.
    expect(await so<Array<string | null>>('showing', { leftTab: 'posts' }, [undo])).toEqual([null]);
  });

  it('keep the writer’s bar following the post while hidden, so a button pressed as it shows is the post’s as it is now', async () => {
    // The post is published: the writer offers to move it to drafts.
    await so('set', { leftTab: 'posts' });
    expect(await so<string[]>('barAsShown', {})).toContain('Move to drafts');
    // Put away under the SEO view, the post goes back to being a draft (an Undo, the AI).
    await so('set', { leftTab: 'seo' });
    await so('change', sent(run(start, { type: 'entry.update', collectionId: 'posts', entryId: POST, draft: true })));
    // Shown and pressed in one go, its bar already offers Publish.
    const bar = await so<string[]>('barAsShown', { leftTab: 'posts' });
    expect(bar).toContain('Publish');
    expect(bar).not.toContain('Move to drafts');
  });
});
