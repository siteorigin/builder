/**
 * The Export dialog's two exports in a real browser, with the app's own styles (#1112): however many readiness
 * warnings the dialog lists, both stay in view and in reach while the warnings scroll, down to the smallest window.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://export-modal.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ExportModal } from ${renderer('panels/ExportModal')};`,
  `import { useStore } from ${renderer('store')};`,
  // The project, made here with the theme packs loaded (tests/unit/setup.ts), as a snapshot brings it.
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'export' }, keptSamples: [], snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], recentExports: window.__recent, diagnostics: [] } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(ExportModal)));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

/** The search audit with nothing to say, for the dialog alone. */
const QUIET_SEO = "export const auditForHealth = () => ({ ok: false }); export const seoPreflight = () => ({ total: 0 }); export const seoCountsText = () => '';";

async function bundle(quiet = false): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'export-modal',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : quiet && id.endsWith('/lib/seo-health') && importer?.endsWith('ExportModal.tsx') ? '\0seo' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0seo' ? QUIET_SEO : null)
      }
    ],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the Export dialog did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  if (!styles.includes('.export-card')) throw new Error('the Export dialog’s styles did not bundle');
  return { script: chunk.code, styles };
}

describe.skipIf(!browserInstalled)('Export dialog actions (#1112)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let quietBuilt: { script: string; styles: string };
  let page: Page;
  let errors: string[];
  const project = JSON.stringify(createStarterState('business', 'Test Studio', false)).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [built, quietBuilt, browser] = await Promise.all([bundle(), bundle(true), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const quietProject = JSON.stringify(createStarterState('blank', 'Test Studio', false)).replace(/</g, '\\u003c');
  const history = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ kind: 'source', format: 'folder', path: `/exports/test-studio-${i}`, exportedAt: '2026-01-01T00:00:00.000Z', revision: 1, notes: [] })));

  const open = async (width: number, height: number, { quiet = false } = {}) => {
    page = await (await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: (quiet ? quietBuilt : built).script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: (quiet ? quietBuilt : built).styles });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${BRIDGE}window.__project = ${quiet ? quietProject : project}; window.__recent = ${quiet ? history : '[]'};</script><script src="/app.js"></script>` });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.export-card').first().waitFor();
    // The dialog pops in: measured once it is where it stays.
    await page.waitForFunction('document.getAnimations().every((a) => a.playState !== "running")');
  };

  /** A short window starts with each review folded: all of them are opened, as an author reading them would. */
  const openReviews = async () => {
    const folded = page.locator('.export-review-toggle[aria-expanded="false"]');
    while (await folded.count()) await folded.first().click();
  };

  /** Whether each export can be seen and clicked where it is now: its corners are on top, inside the window. */
  const inReach = () =>
    page.evaluate<boolean[]>(`[...document.querySelectorAll('.export-card')].map((card) => {
      const r = card.getBoundingClientRect();
      return r.height > 0 && [[r.left + 8, r.top + 4], [r.right - 8, r.bottom - 4]].every(([x, y]) => card.contains(document.elementFromPoint(x, y)));
    })`);

  /** Scroll whatever holds the warnings to one end, and say whether anything did scroll. */
  const scrollWarnings = (to: 'top' | 'bottom') =>
    page.evaluate<boolean>(`(() => {
      let scrolled = false;
      for (let el = document.querySelector('[data-testid="export-sample-contacts"]')?.parentElement; el; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight || !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
        el.scrollTop = ${to === 'top' ? 0 : 'el.scrollHeight'};
        scrolled = true;
      }
      return scrolled;
    })()`);

  // The smallest window the app allows (src/main/index.ts), and the common laptop size in the report.
  it.each([
    [1100, 700],
    [1440, 900]
  ])('keeps both exports in reach at %i×%i while the warnings scroll', async (width, height) => {
    await open(width, height);
    await openReviews();
    // The case is the real one: both kinds of warning are listed, and both exports can be started.
    expect(await page.locator('[data-testid="export-sample-contacts"], [data-testid^="export-sample-email"]').count()).toBeGreaterThan(1);
    expect(await page.locator('.export-card:not([aria-disabled="true"])').count()).toBe(2);
    expect(await inReach()).toEqual([true, true]);
    // The case is the real one: there is more above the exports than the dialog has room for.
    expect(await scrollWarnings('bottom')).toBe(true);
    expect(await inReach()).toEqual([true, true]);
    await scrollWarnings('top');
    expect(await inReach()).toEqual([true, true]);
  });

  it('puts the exports side by side in the smallest window, with Close on the row below', async () => {
    await open(1100, 700);
    const [site, source, close] = await Promise.all(['.export-card:not(.secondary)', '.export-card.secondary', '.modal-foot > button'].map(async (s) => (await page.locator(s).boundingBox())!));
    expect(source.y).toBe(site.y);
    expect(close.y).toBeGreaterThanOrEqual(site.y + site.height);
    expect(close.y + close.height).toBeLessThanOrEqual(700);
  });

  // Where the header, the exports and a strip of body don't fit: zoomed to 150% and 200% in the smallest window, and
  // that window under a tall stack of notices (the band Toasts measures).
  it.each([
    ['zoomed to 733×466', 733, 466, 0],
    ['zoomed to 550×350', 550, 350, 0],
    ['under tall notices', 1100, 700, 360]
  ])('keeps every warning and both exports within reach %s', async (_, width, height, band) => {
    await open(width, height);
    await page.evaluate(`document.documentElement.style.setProperty('--toast-band', '${band}px')`);
    await openReviews();
    // The warnings keep room of their own, and what doesn't fit is the person's to scroll to: a clipped dialog can
    // still be scrolled by focus, so the wheel is what proves it.
    expect(await page.evaluate<number>(`document.querySelector('.modal-body').clientHeight`)).toBeGreaterThanOrEqual(100);
    const head = (await page.locator('.modal-head h2').boundingBox())!;
    await page.mouse.move(head.x + 4, head.y + 4);
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() => page.evaluate<boolean>(`(() => { const b = document.querySelector('.modal-foot > button'); const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()`))
      .toBe(true);
    const controls = page.locator('.modal :is(.export-review-actions button, .export-card, .modal-foot > button)');
    const count = await controls.count();
    expect(count).toBeGreaterThan(8);
    for (let i = 0; i < count; i++) {
      await controls.nth(i).focus();
      expect(
        await page.evaluate<boolean>(`(() => { const el = document.activeElement; const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12))); })()`),
        `control ${i} is in view once focused`
      ).toBe(true);
    }
  });

  it('opens on the format, not on a recent export below, when there is nothing to see to', async () => {
    await open(1100, 700, { quiet: true });
    expect(await page.locator('.export-history li').count()).toBe(6);
    expect(await page.evaluate<string>(`document.activeElement.textContent`)).toBe('Folder');
    expect(await page.evaluate<number>(`document.querySelector('.modal-body').scrollTop`)).toBe(0);
  });
});
