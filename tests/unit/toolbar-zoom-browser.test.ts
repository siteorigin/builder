/**
 * The toolbar under View zoom (#1367, #1547): zooming the editor in shrinks the window the toolbar has, down to 550 CSS
 * px at 200% of the 1100px minimum window. At every width the controls keep apart (the project title and save status
 * used to draw over the device switcher, and its clicks land on Desktop), the title's button holds the names it shows,
 * and every control, Export included, stays inside the window. The real toolbar, store and stylesheets run in a real
 * browser.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://toolbar-zoom.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Toolbar } from ${renderer('panels/Toolbar')};`,
  `import { useStore } from ${renderer('store')};`,
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', leftTab: 'layers', dockOpen: true, pageId: state.site.homePageId, snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], history: { canUndo: false, canRedo: false } }, selection: null }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h('div', { className: 'editor' }, h(Toolbar), h('div', { className: 'workspace' }), h('div'))));",
  'window.set = (patch) => flushSync(() => useStore.setState(patch));'
].join('\n');

/** The preload bridge: every call answers nothing; the platform is the one each case names. */
const bridge = (platform: string) => `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? ${JSON.stringify(platform)} : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'toolbar-zoom', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The toolbar did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

type Rect = { name: string; left: number; right: number; top: number; bottom: number };
type Layout = {
  controls: Rect[];
  title: Rect;
  titleParts: Rect[];
  /** Whether a pointer on the middle of the page name, and on the chevron, finds the title's button. */
  titleHits: boolean[];
  toolbar: Rect;
  /** The editor's next row, which starts below the toolbar however many rows it takes. */
  workspace: Rect;
  status: string;
  viewport: number;
};

/** Every control the toolbar draws (its buttons, the width field and the save status), and the title's parts. */
const measure = (p: Page) =>
  p.evaluate<Layout>(`(() => {
    const rect = (el, name) => { const r = el.getBoundingClientRect(); return { name, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const label = (el) => el.getAttribute('aria-label') || el.className || el.textContent;
    const bar = document.querySelector('.toolbar');
    const controls = [...bar.querySelectorAll('button, .width-field, .save-state')]
      .filter((el) => !el.closest('.segmented') || el.matches('.segmented button'))
      .filter((el) => !el.closest('.width-field') || el.matches('.width-field'))
      .filter((el) => !el.closest('.project-title, .save-state') || el.matches('.project-title, .save-state'))
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => rect(el, String(label(el))));
    const title = bar.querySelector('.project-title');
    const parts = [...title.querySelectorAll('.site, .page, .chev, .sep')].map((el) => rect(el, el.getAttribute('class')));
    const hit = (el) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && title.contains(at); };
    return {
      controls,
      title: rect(title, 'title'),
      titleParts: parts,
      titleHits: [hit(title.querySelector('.page .ellipsis')), hit(title.querySelector('.chev'))],
      toolbar: rect(bar, 'toolbar'),
      workspace: rect(document.querySelector('.workspace'), 'workspace'),
      status: bar.querySelector('.save-state').textContent,
      viewport: innerWidth
    };
  })()`);

const overlaps = (a: Rect, b: Rect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe.skipIf(!browserInstalled)('Toolbar under View zoom (#1367)', { timeout: 120_000 }, () => {
  let browser: Browser;
  let bundled: { script: string; styles: string };
  const state = createStarterState('business', 'Harbour Lane Studio', false);
  const project = JSON.stringify(state).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [bundled, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  async function open(platform: string, width: number): Promise<Page> {
    const page = await (await browser.newContext({ viewport: { width, height: 700 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundled.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: bundled.styles });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root" style="height:100vh"></div><script>${bridge(platform)}window.__project = ${project};</script><script src="/app.js"></script>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.project-title').waitFor();
    await page.evaluate('document.fonts.ready');
    expect(errors).toEqual([]);
    return page;
  }

  // 1100, 1280 and 1440px windows from 100% to 207%, and both sides of where the overflow toolbar starts to wrap.
  const widths = [1440, 1280, 1100, 1080, 1040, 1000, 990, 980, 960, 930, 900, 880, 853, 800, 733, 696, 640, 629, 550, 531];
  const snapshot = (conflicts: unknown[]) => ({ state, revision: 1, workspaceKey: 'w1', conflicts, history: { canUndo: false, canRedo: false } });
  // The quiet state, the longest one ("AI is waiting for you", which lets the project name give way) and a conflict.
  const conflict: ProjectSnapshot['conflicts'][number] = { path: 'siteorigin/site.json', reason: 'Changed outside SiteOrigin Builder', kind: 'canonical' };
  const statuses: [string, string, Record<string, unknown>][] = [
    ['saved', 'Saved', { runStatus: null, snapshot: snapshot([]) }],
    ['asking', 'AI is waiting for you', { runStatus: 'awaiting-input', snapshot: snapshot([]) }],
    ['conflict', 'File conflict', { runStatus: null, snapshot: snapshot([conflict]) }]
  ];

  it.each(['darwin', 'win32'])('keeps every control apart and inside the window at every width (%s)', async (platform) => {
    const page = await open(platform, 1440);
    const problems: string[] = [];
    for (const [status, text, patch] of statuses) {
      await page.evaluate((p) => (globalThis as unknown as { set: (p: unknown) => void }).set(p), patch);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 700 });
        await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        const m = await measure(page);
        const at = `${width} ${status}`;
        expect(m.viewport).toBe(width);
        expect(m.status).toContain(text);
        const lowest = Math.max(m.toolbar.bottom, ...m.controls.map((c) => c.bottom));
        if (m.workspace.top < lowest - 0.5) problems.push(`${at}: the editor's next row starts under the toolbar's controls`);
        for (let i = 0; i < m.controls.length; i++) {
          const a = m.controls[i];
          if (a.left < -0.5 || a.right > width + 0.5) problems.push(`${at}: ${a.name} runs out of the window (${Math.round(a.left)} to ${Math.round(a.right)})`);
          for (const b of m.controls.slice(i + 1)) if (overlaps(a, b)) problems.push(`${at}: ${a.name} overlaps ${b.name}`);
        }
        for (const part of m.titleParts)
          if (part.left < m.title.left - 0.5 || part.right > m.title.right + 0.5) problems.push(`${at}: the title's ${part.name} runs outside its button`);
        if (!m.titleHits.every(Boolean)) problems.push(`${at}: a click on the title's page name or chevron misses the title`);
      }
    }
    await page.context().close();
    expect(problems).toEqual([]);
  });

  it('stays one 52px row at the 1100px minimum window and wider', async () => {
    const page = await open('darwin', 1100);
    for (const width of [1100, 1280, 1440]) {
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const m = await measure(page);
      expect(Math.round(m.toolbar.bottom - m.toolbar.top), `${width}px`).toBe(52);
    }
    await page.context().close();
  });
});
