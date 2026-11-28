/**
 * Get started keeps clear of the Pages list (#1316), in a real browser with the editor's stylesheets: the card sits
 * under the list in the Pages view, and a short sidebar (the editor zoomed, or a site with several collections) used
 * to squeeze the list to nothing, so its header and rows were drawn under the card. Whatever the sidebar's height, the
 * list and its header stay in view above the card, the card stays inside the sidebar, and nothing it holds is cut off
 * for good: its heading stays in view and its steps scroll.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { findTheme, listThemes } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { firstStepsStart } from '@shared/first-steps';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://get-started-room.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

// The Pages view as the editor draws it (src/renderer/src/Editor.tsx): the panel, then Get started, in one view.
const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { PagesPanel } from ${renderer('panels/PagesPanel')};`,
  `import { FirstSteps } from ${renderer('panels/FirstSteps')};`,
  `import { useStore } from ${renderer('store')};`,
  `import { registerPacks } from ${JSON.stringify(resolve('src/catalogue/index'))};`,
  'registerPacks(window.__packs);',
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', leftTab: 'pages', pageId: state.site.homePageId, firstSteps: window.__record, snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], recentExports: [], diagnostics: [] } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h('aside', { id: 'editor-sidebar', className: 'side-panel', style: { width: window.__width, height: '100vh' } }, h('div', { className: 'side-panel-view' }, h(PagesPanel), h(FirstSteps)))));",
  'window.store = useStore;'
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)]))
    },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'get-started-room',
        enforce: 'pre',
        resolveId: (id) => (id === '\0entry' ? id : null),
        load: (id) => (id === '\0entry' ? ENTRY : null)
      }
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rolldownOptions: {
        input: '\0entry',
        output: { format: 'iife', codeSplitting: false }
      }
    }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the Pages view did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
const colorIds = (s: ProjectState) => (findTheme(s.site.themeId)?.tokens ?? []).filter((t) => t.group === 'color').map((t) => t.id);
const business = createStarterState('business', 'Harbour Lane Studio', false);
// The issue's site: three collections listed under the pages.
const collections = applyOperations(
  business,
  (['Advisors', 'Journal', 'Properties'] as const).map(
    (name) =>
      ({
        type: 'collection.create',
        collectionId: name.toLowerCase(),
        name,
        kind: 'editorial',
        route: `/${name.toLowerCase()}/`,
        pages: { detail: true, archive: true }
      }) as EditOperation
  )
).state;

/** Whether a pointer at the middle of what the selector finds (its first 20px for a tall one) finds it. */
const HIT = `(el) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height, 20) / 2); return !!at && el.contains(at); }`;

type Box = { top: number; bottom: number; height: number };
type Room = {
  view: Box;
  panel: Box;
  body: Box;
  card: Box;
  head: boolean;
  cardHead: boolean;
  steps: { scroll: number; client: number };
};

/** Where the view, the Pages panel, its list and the card are drawn, and whether their headings are under the pointer. */
const measure = (p: Page) =>
  p.evaluate<Room>(`(() => {
    const hit = ${HIT};
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    const panel = document.querySelector('.pages-panel');
    const card = document.querySelector('.get-started');
    const steps = card.querySelector('.get-started-body');
    return {
      view: box(document.querySelector('.side-panel-view')),
      panel: box(panel),
      body: box(panel.querySelector('.panel-body')),
      card: box(card),
      head: hit(panel.querySelector('.panel-head h3')),
      cardHead: hit(card.querySelector('.get-started-toggle')),
      steps: { scroll: steps.scrollHeight, client: steps.clientHeight }
    };
  })()`);

/** Scrolls what the locator finds fully into the list's view, and says whether it is then whole there and under the pointer. */
const reachable = (p: Page, selector: string, index: number) =>
  p.evaluate<boolean>(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    el.scrollIntoView({ block: 'nearest' });
    const port = el.closest('.panel-body, .get-started-body').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= port.top - 0.5 && r.bottom <= port.bottom + 0.5 && (${HIT})(el);
  })()`);

describe.skipIf(!browserInstalled)('Get started beside the Pages list (#1316)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  const packs = json(listThemes());

  beforeAll(async () => {
    [built] = await Promise.all([bundle(), chromium.launch({ headless: true }).then((b) => (browser = b))]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  /** The Pages view in a sidebar `width` wide and `height` tall: the editor's chrome above and below it left out. */
  async function open(state: ProjectState, width: number, height: number, folded = false): Promise<Page> {
    const page = await (
      await browser.newContext({
        viewport: { width: 1100, height },
        reducedMotion: 'reduce'
      })
    ).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const record = { start: firstStepsStart(state, colorIds(state)), folded };
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js')
        return route.fulfill({
          contentType: 'text/javascript; charset=utf-8',
          body: built.script
        });
      if (path === '/app.css')
        return route.fulfill({
          contentType: 'text/css; charset=utf-8',
          body: built.styles
        });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body style="margin:0"><div id="root"></div><script>${BRIDGE}window.__project = ${json(state)}; window.__packs = ${packs}; window.__record = ${json(record)}; window.__width = ${width};</script><script src="/app.js"></script>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.get-started').waitFor();
    expect(errors).toEqual([]);
    return page;
  }

  /** The list ends where the card starts, the card inside the sidebar with its heading in view, as does the list's. */
  function apart(room: Room) {
    expect(room.head).toBe(true);
    expect(room.cardHead).toBe(true);
    expect(room.panel.bottom).toBeLessThanOrEqual(room.card.top + 0.5);
    expect(room.card.bottom).toBeLessThanOrEqual(room.view.bottom + 0.5);
  }

  // The narrowest sidebar in the smallest window (1100x700), at 150%: 387px under the editor's chrome.
  it('shows all three pages whole at 150%, the card giving way to them', async () => {
    const page = await open(business, 200, 387);
    try {
      const room = await measure(page);
      apart(room);
      const rows = await page.locator('.pages-list .page-row').count();
      expect(rows).toBe(Object.keys(business.pages).length);
      // Every row is whole in the list without scrolling it, and under the pointer.
      const whole = await page.evaluate<boolean[]>(
        `(() => { const port = document.querySelector('.pages-panel .panel-body').getBoundingClientRect(); return [...document.querySelectorAll('.pages-list .page-row')].map((r) => { const b = r.getBoundingClientRect(); return b.top >= port.top - 0.5 && b.bottom <= port.bottom + 0.5 && (${HIT})(r); }); })()`
      );
      expect(whole).toEqual(whole.map(() => true));
      // What the card no longer has room for scrolls inside it, under its heading, to the last step.
      expect(room.steps.scroll).toBeGreaterThan(room.steps.client);
      expect(await reachable(page, '.gs-step', 4)).toBe(true);
      expect((await measure(page)).cardHead).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  // At 200%: 270px. The list scrolls now, and every row can still be scrolled to and pointed at.
  it('keeps every page reachable at 200%', async () => {
    const page = await open(business, 200, 270);
    try {
      const room = await measure(page);
      apart(room);
      for (let i = 0; i < Object.keys(business.pages).length; i++) expect(await reachable(page, '.pages-list .page-row', i)).toBe(true);
      expect(await reachable(page, '.gs-step', 4)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  // A 900px window's sidebar, with the issue's three collections: the list keeps most of it, and the last
  // collection's Index settings can be scrolled to and pressed.
  it('keeps most of a 900px sidebar for a site with three collections', async () => {
    const page = await open(collections, 280, 820);
    try {
      const room = await measure(page);
      apart(room);
      expect(room.card.height).toBeLessThanOrEqual(room.view.height * 0.4 + 0.5);
      expect(room.body.height).toBeGreaterThan(room.view.height / 2);
      const toggles = await page.locator('.pages-collection-toggle').count();
      expect(toggles).toBeGreaterThan(0);
      expect(await reachable(page, '.pages-collection-toggle', toggles - 1)).toBe(true);
      const last = page.locator('.pages-collection-toggle').last();
      await last.click();
      expect(await last.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await page.context().close();
    }
  });

  it('leaves a tall sidebar as it was: the whole card shows, with nothing to scroll', async () => {
    const page = await open(business, 280, 1000);
    try {
      const room = await measure(page);
      apart(room);
      expect(room.steps.scroll).toBeLessThanOrEqual(room.steps.client);
    } finally {
      await page.context().close();
    }
  });

  it('keeps a folded card to its heading, whole, in a short sidebar', async () => {
    const page = await open(collections, 200, 270, true);
    try {
      const room = await measure(page);
      apart(room);
      expect(room.card.height).toBeLessThan(60);
    } finally {
      await page.context().close();
    }
  });
});
