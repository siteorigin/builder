/**
 * The copies of the project the editor keeps (#1041). Each change comes from the main process as a patch, which the
 * editor reads into a new snapshot that keeps every document the change did not touch (shared/project-feed.ts), and a
 * hidden panel holds the store as it was when it was hidden (lib/hideable.tsx). So what the editor keeps is one snapshot
 * per hidden panel at most, however many edits are made, and each old one keeps of its own only the documents edited
 * since. The real feed, reader, store and panel boundary run in a real browser, its garbage collected by hand.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The feed the page runs, imported here too, so a change to it runs this test (vitest --changed follows imports; the
// store and the panel boundary are the editor's, which this project's Node typecheck does not take, as in hideable-browser).
import { ProjectFeed, ProjectFeedReader } from '../../src/shared/project-feed';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://held-snapshots.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));
/** Panels wrapped as the editor wraps its sidebar views and two of its dock views; one shown at a time. */
const PANELS = 8;

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Hideable } from ${renderer('lib/hideable')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { ProjectFeed, ProjectFeedReader } from ${JSON.stringify(resolve('src/shared/project-feed'))};`,
  // A project of many documents, frozen as the main process's is: 60 pages and 400 entries.
  'const page = (i, heading) => Object.freeze({ id: "p" + i, route: "/p" + i, nodes: Object.freeze([Object.freeze({ id: "n" + i, props: Object.freeze({ heading, body: "x".repeat(200) }) })]) });',
  'const pages = {}; for (let i = 0; i < 60; i++) pages["p" + i] = page(i, "Page " + i);',
  'const entries = {}; for (let i = 0; i < 400; i++) entries["e" + i] = Object.freeze({ id: "e" + i, title: "Entry " + i, body: "y".repeat(300) });',
  'let state = Object.freeze({ site: Object.freeze({ homePageId: "p0" }), pages: Object.freeze(pages), components: Object.freeze({}), sources: Object.freeze({}), collections: Object.freeze({ posts: Object.freeze({ id: "posts", entries: Object.freeze(entries) }) }) });',
  'let revision = 0;',
  'const feed = new ProjectFeed();',
  'const reader = new ProjectFeedReader();',
  /** Every snapshot the editor was handed, held weakly. */
  'const made = [];',
  // The main process's snapshot, made into a message and sent as IPC sends it (a structured clone), read as the
  // editor's transport reads it and put in the store as App does.
  'function send() {',
  '  const snapshot = { dir: "/project", state, revision, history: { undo: [], redo: [] }, diagnostics: [], runtime: { status: "running" }, recoveryNotes: [], aiBusy: false, assetUsage: {}, missingAssets: [], conflicts: [], localState: {}, workspaceKey: "w1", recentExports: [] };',
  '  const snap = reader.read(structuredClone(feed.next(snapshot)));',
  '  made.push(new WeakRef(snap));',
  '  flushSync(() => useStore.setState({ snapshot: snap }));',
  '}',
  // An edit as the engine makes one: the home page's heading changed, every other document the very object it was.
  'function edit() {',
  '  revision++;',
  '  state = Object.freeze({ ...state, pages: Object.freeze({ ...state.pages, p0: page(0, "Heading " + revision) }) });',
  '  send();',
  '}',
  // What a panel reads of the project: the snapshot itself (as many of the editor's components do), the home page's
  // heading and how many pages there are.
  'function Panel({ id }) {',
  '  const snap = useStore((s) => s.snapshot);',
  '  const heading = useStore((s) => s.snapshot?.state.pages.p0.nodes[0].props.heading);',
  '  const count = useStore((s) => Object.keys(s.snapshot?.state.pages ?? {}).length);',
  '  return h("section", { id }, h("b", null, heading), h("i", null, String(count)), h("s", null, String(snap?.revision)));',
  '}',
  'function Editor() {',
  '  const shown = useStore((s) => s.leftTab);',
  `  return h("div", null, Array.from({ length: ${PANELS} }, (_, i) => h("div", { key: i, hidden: shown !== "v" + i }, h(Hideable, { hidden: shown !== "v" + i }, h(Panel, { id: "v" + i })))));`,
  '}',
  'send();',
  "flushSync(() => useStore.setState({ leftTab: 'v0', screen: 'editor' }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Editor)));",
  // Show each panel in turn, an edit after each.
  'let turn = 0;',
  `window.so = { edits(n) { for (let k = 0; k < n; k++) { turn = (turn + 1) % ${PANELS}; flushSync(() => useStore.setState({ leftTab: "v" + turn })); edit(); } }, shown: () => document.querySelector("section:not([hidden] section) b")?.textContent };`,
  // How many of the snapshots handed to the editor are still reachable once garbage is collected, and of the older
  // ones, how many documents each holds that the newest does not.
  'window.held = async () => {',
  '  for (let i = 0; i < 3; i++) { gc(); await new Promise((r) => setTimeout(r, 0)); }',
  '  const now = reader.snapshot;',
  '  const alive = made.map((r) => r.deref()).filter(Boolean);',
  '  const docs = (st) => [["site", st.site], ...Object.entries(st.pages).map(([k, v]) => ["page:" + k, v]), ...Object.entries(st.components).map(([k, v]) => ["component:" + k, v]), ...Object.entries(st.sources).map(([k, v]) => ["source:" + k, v]), ...Object.entries(st.collections).flatMap(([c, col]) => Object.entries(col.entries).map(([k, v]) => ["entry:" + c + ":" + k, v]))];',
  '  const current = new Map(docs(now.state));',
  '  const own = alive.filter((s) => s !== now).map((s) => docs(s.state).filter(([k, v]) => current.get(k) !== v).map(([k]) => k));',
  // The revision each panel shows, hidden or not.
  '  const shows = [...document.querySelectorAll("section")].map((el) => ({ id: el.id, hidden: !!el.closest("[hidden]"), revision: Number(el.querySelector("s").textContent) }));',
  '  return { alive: alive.length, own, edits: revision, shows, documents: current.size };',
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
        name: 'held-snapshots',
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

describe.skipIf(!browserInstalled)('the copies of the project the editor keeps (#1041)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    // The page collects its own garbage, so what is still reachable is all that is counted.
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true, args: ['--js-flags=--expose-gc'] })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  type Held = { alive: number; own: string[][]; edits: number; shows: Array<{ id: string; hidden: boolean; revision: number }>; documents: number };
  const held = () => page.evaluate<Held>('held()');
  const edits = (n: number) => page.evaluate(`so.edits(${n})`);

  it('holds one snapshot per hidden panel at most, however many edits, each keeping of its own only what was edited since', async () => {
    expect([typeof ProjectFeed, typeof ProjectFeedReader]).toEqual(['function', 'function']);
    await edits(2 * PANELS);
    const early = await held();
    await edits(10 * PANELS);
    const late = await held();
    expect([early.edits, late.edits]).toEqual([2 * PANELS, 12 * PANELS]);
    // Each hidden panel holds the revision it was hidden at, every one older than the newest and none the same: the
    // copies counted below are really held.
    const hidden = late.shows.filter((p) => p.hidden);
    expect(hidden.length).toBe(PANELS - 1);
    expect(new Set(hidden.map((p) => p.revision)).size).toBe(PANELS - 1);
    expect(hidden.every((p) => p.revision < late.edits)).toBe(true);
    expect(late.shows.filter((p) => !p.hidden).map((p) => p.revision)).toEqual([late.edits]);
    // Ninety-six edits in, as many snapshots are reachable as sixteen in: one per panel hidden at its own revision, and
    // the newest (with at most one more React keeps of the panel on screen), never one per edit.
    expect(late.alive).toBe(early.alive);
    expect(late.alive).toBeGreaterThanOrEqual(PANELS);
    expect(late.alive).toBeLessThanOrEqual(PANELS + 1);
    // Every older one shares every document with the newest (all 461 of them) but the home page, the one edited since.
    expect(late.documents).toBe(461);
    expect(late.own.length).toBe(late.alive - 1);
    expect(late.own.every((keys) => keys.length === 1 && keys[0] === 'page:p0')).toBe(true);
    // The panel on screen shows the last edit.
    expect(await page.evaluate('so.shown()')).toBe(`Heading ${12 * PANELS}`);
  });
});
