/**
 * The Export dialog's two exports in a real browser, with the app's own styles (#1112): however many readiness
 * warnings the dialog lists, both stay in view and in reach while the warnings scroll, down to the smallest window.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://export-modal.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));
/**
 * The editor's text is the system's own (--font: SF Pro on macOS, Segoe UI on Windows, whatever Linux has), which
 * set the dialog's lines at different widths, so whether its warnings outgrow a window depended on the computer the
 * test ran on. The page sets them in one font everywhere, Inter (a dependency of the app already), as wide as SF Pro.
 */
const UI_FONT = readFileSync(resolve('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'));
const UI_FONT_CSS = `<style>@font-face { font-family: 'Test UI'; src: url(/ui-font.woff2) format('woff2'); font-weight: 100 900; } :root { --font: 'Test UI', sans-serif; }</style>`;

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
  "flushSync(() => createRoot(document.getElementById('root')).render(h(ExportModal)));",
  // What the dialog hands over to, for a test to read: the dialog itself stays drawn.
  'useStore.subscribe((s) => void (window.__modal = s.modal));',
  // What the main process reports later (the preview's state), for a test to send.
  'window.__setRuntime = (runtime) => flushSync(() => useStore.setState({ runtime }));'

].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

/**
 * The bridge with the client review's calls answered (#1134): one edition captured earlier, and every capture and save
 * held until the test settles it, each call recorded on window.__calls.
 */
const REVIEW_BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  const edition = (id, createdAt) => ({ editionId: id, createdAt, siteName: 'Test Studio', revision: 1, basePath: '', routes: [{ route: '/', title: 'Home' }], widths: [{ label: 'Desktop', width: 1440 }, { label: 'Phone', width: 390 }], captures: [{ route: '/', width: 1440, status: 'captured', file: 'images/001-1440.png', height: 900, sha256: 'a' }, { route: '/', width: 390, status: 'unavailable', reason: 'fonts', detail: 'x' }], siteDigest: 'a', contentDigest: 'b' });
  window.__editions = [edition('2026-11-20T09-00-00Z-0badc0de', '2026-11-20T09:00:00.000Z')];
  window.__calls = [];
  window.__settle = null;
  const held = (name, args) => new Promise((resolve) => { window.__calls.push([name, ...args]); window.__settle = resolve; });
  const project = new Proxy({}, { get: (_, key) =>
    key === 'reviewEditions' ? async () => window.__editions
    : key === 'captureReviewEdition' ? (...a) => held('capture', a).then((r) => { if (r.ok) window.__editions = [r.edition, ...window.__editions]; return r; })
    : key === 'exportReviewSheet' ? (...a) => held('save', a)
    : any('project.' + String(key)) });
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'then' ? undefined : any(String(key))) });
  window.__edition = edition;
`;

/** The bridge with the website export counted on window.__exports, answering as a build that names nothing would. */
const EXPORT_BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.__exports = 0;
  const project = new Proxy({}, { get: (_, key) =>
    key === 'exportStatic' ? async () => (window.__exports++, { ok: false, message: 'The production build failed.', warnings: ['Error: boom'], details: 'Error: boom' })
    : key === 'reviewEditions' ? async () => []
    : any('project.' + String(key)) });
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'then' ? undefined : any(String(key))) });
`;

/** The search audit with nothing to say, for the dialog alone. */
const QUIET_SEO = 'export const auditForHealth = () => ({ ok: true, findings: [] });';

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

  const open = async (width: number, height: number, { quiet = false, bridge = BRIDGE } = {}) => {
    page = await (await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: (quiet ? quietBuilt : built).script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: (quiet ? quietBuilt : built).styles });
      if (path === '/ui-font.woff2') return route.fulfill({ contentType: 'font/woff2', body: UI_FONT });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css">${UI_FONT_CSS}<body><div id="root"></div><script>${bridge}window.__project = ${quiet ? quietProject : project}; window.__recent = ${quiet ? history : '[]'};</script><script src="/app.js"></script>` });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.export-card').first().waitFor();
    await page.evaluate(`document.fonts.load("16px 'Test UI'").then(() => document.fonts.ready).then(() => true)`);
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
    [1100, 640],
    [1440, 760]
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

  // #1632: a dialog tall enough to fill the window sits centred, not hung from a gap at the top.
  it.each([
    ['a plain window', 1100, 700, 0],
    ['under tall notices', 1100, 700, 360]
  ])('centres a tall dialog between its margins, %s (#1632)', async (_, width, height, band) => {
    await open(width, height);
    await page.evaluate(`document.documentElement.style.setProperty('--toast-band', '${band}px')`);
    await openReviews();
    const modal = (await page.locator('.modal').boundingBox())!;
    const above = modal.y;
    const below = height - (modal.y + modal.height);
    expect(Math.abs(above - below)).toBeLessThanOrEqual(band ? Math.max(0, band - 32) + 1 : 1);
    expect(above).toBeGreaterThanOrEqual(31);
    expect(below).toBeGreaterThanOrEqual(Math.max(31, band));
  });

  it('keeps the dialog header in view when the notices leave less room than the dialog needs (#1632)', async () => {
    await open(1100, 300);
    await page.evaluate(`document.documentElement.style.setProperty('--toast-band', '230px')`);
    expect((await page.locator('.modal-head h2').boundingBox())!.y).toBeGreaterThanOrEqual(0);
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
    // The review opened last still has focus, which focusing again would not scroll to.
    await page.evaluate(`document.activeElement?.blur()`);
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

  // The app's own window when it first opens (src/main/index.ts).
  it('shows a site with no notes only the export choice, with its pages on the website card (#1288)', async () => {
    await open(1480, 920, { quiet: true });
    expect(await page.locator('.export-review, [data-testid="export-health-summary"], [data-testid="export-samples-kept"]').count()).toBe(0);
    const pages = page.locator('.export-card:not(.secondary) [data-testid="export-pages"]');
    expect(await pages.innerText()).toMatch(/^The website publishes \d+ pages?: /);
    expect(await page.locator('.modal-body [data-testid="export-pages"]').count()).toBe(0);
    expect(await inReach()).toEqual([true, true]);
  });

  it('puts what keeps visitors away in one box, and the rest of Project health on one line (#1288)', async () => {
    await open(1480, 920);
    // Export is in view as the dialog opens, before anything is scrolled.
    expect(await page.evaluate<number>(`document.querySelector('.modal-body').scrollTop`)).toBe(0);
    expect(await inReach()).toEqual([true, true]);
    const box = page.getByTestId('export-visitor-review');
    expect(await page.locator('.export-review').count()).toBe(1);
    expect(await box.locator('.export-review-head').innerText()).toBe('Visitors can’t reach you yet');
    expect(await page.locator('.modal').innerText()).not.toMatch(/won’t stop the export/);
    // The sample details are one line with one action; their own choices wait behind it.
    const samples = box.getByTestId('export-sample-contacts');
    expect(await samples.locator('.export-review-what').first().innerText()).toMatch(/^hello@example\.com.* sample details from the starter\.$/);
    const review = samples.getByRole('button', { name: 'Review' });
    expect(await review.getAttribute('aria-expanded')).toBe('false');
    expect(await samples.getByRole('button', { name: 'Keep it' }).count()).toBe(0);
    await review.click();
    expect(await samples.getByRole('button', { name: 'Keep it' }).count()).toBeGreaterThan(1);
    expect(await samples.getByRole('button', { name: 'Replace everywhere…' }).count()).toBe(await samples.getByRole('button', { name: 'Keep it' }).count());
    // Search and sharing are counted, and fixed in Project health.
    const health = page.getByTestId('export-health-summary');
    expect(await health.innerText()).toMatch(/^\d+ search and sharing suggestions?( and \d+ more notes?)?\.\s*Review in Project health$/);
    expect(await page.getByRole('button', { name: /^Go to (Published by|sharing image)/ }).count()).toBe(0);
    await health.getByRole('button', { name: 'Review in Project health' }).click();
    await expect.poll(() => page.evaluate(`window.__modal`)).toEqual({ kind: 'health', section: 'seo' });
  });

  it('moves focus to Review them again once the last sample detail is kept (#1288)', async () => {
    await open(1100, 700);
    await page.getByTestId('export-sample-contacts').getByRole('button', { name: 'Review' }).click();
    for (let left = await page.getByRole('button', { name: 'Keep it' }).count(); left > 0; left--) {
      await page.getByRole('button', { name: 'Keep it' }).first().focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.getByRole('button', { name: 'Keep it' }).count()).toBe(left - 1);
    }
    expect(await page.getByTestId('export-visitor-review').count()).toBe(0);
    await expect.poll(() => page.evaluate<string>(`document.activeElement?.textContent?.trim() ?? ''`)).toBe('Review them again');
    expect(await inReach()).toEqual([true, true]);
  });

  it('holds the website export while the website tools are set up, and not while the preview only starts (#1395)', async () => {
    await open(1480, 920, { quiet: true, bridge: EXPORT_BRIDGE });
    const site = page.locator('.export-card:not(.secondary)');
    const source = page.locator('.export-card.secondary');
    await page.evaluate(`window.__setRuntime({ state: 'preparing', message: 'Setting up website tools…' })`);
    const note = page.getByTestId('export-blocked-tools');
    expect(await note.innerText()).toMatch(/still setting up the website tools\. The website can be exported once they are ready; the editable project can be exported now\./);
    expect(await site.getAttribute('aria-disabled')).toBe('true');
    expect(await site.getAttribute('aria-describedby')).toBe('export-blocked-tools');
    expect(await source.getAttribute('aria-disabled')).toBeNull();
    // The dialog says why as it opens on it.
    expect(await page.getByRole('dialog').getAttribute('aria-describedby')).toBe('export-blocked-tools');
    // Capturing review pages builds the website too, so it waits as well.
    await page.getByRole('button', { name: 'Client review pages' }).click();
    const capture = page.getByRole('button', { name: /^Capture/ });
    expect(await capture.getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('.client-review').innerText()).toContain('Capturing waits until the website can be exported.');
    // Clicked all the same, it starts nothing.
    await site.dispatchEvent('click');
    await capture.dispatchEvent('click');
    expect(await site.locator('.export-card-end').innerText()).not.toMatch(/Building/);
    // Tools ready, preview still starting: the website exports.
    await page.evaluate(`window.__setRuntime({ state: 'starting' })`);
    expect(await note.count()).toBe(0);
    expect(await site.getAttribute('aria-disabled')).toBeNull();
    expect(await capture.getAttribute('aria-disabled')).toBeNull();
    await site.click();
    // A failure that names no page or component is never told to check one.
    const result = page.locator('.export-result');
    await expect.poll(() => result.count()).toBe(1);
    // Only the click made once the tools were ready started an export.
    expect(await page.evaluate<number>('window.__exports')).toBe(1);
    expect(await result.innerText()).toMatch(/Try exporting again\./);
    expect(await result.innerText()).not.toMatch(/named above/);
  });

  it('opens on the format, not on a recent export below, when there is nothing to see to', async () => {
    await open(1100, 700, { quiet: true });
    expect(await page.locator('.export-history li').count()).toBe(6);
    expect(await page.evaluate<string>(`document.activeElement.textContent`)).toBe('Folder');
    expect(await page.evaluate<number>(`document.querySelector('.modal-body').scrollTop`)).toBe(0);
  });

  it('captures chosen pages and saves an earlier edition as one file from a folded Client review section (#1134)', async () => {
    await open(1100, 900, { quiet: true, bridge: REVIEW_BRIDGE });
    // Folded, and never where the dialog opens.
    expect(await page.evaluate<string>(`document.activeElement.textContent`)).toBe('Folder');
    const toggle = page.getByRole('button', { name: 'Client review pages' });
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await toggle.click();
    // The earlier edition is listed with what it holds, and the home page is chosen to start with.
    const rows = page.locator('.client-review-editions li');
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().innerText()).toContain('1 page · 1 of 2 pictures taken');
    expect(await rows.first().innerText()).toContain('2026-11-20T09-00-00Z-0badc0de');
    const home = page.getByRole('checkbox', { name: /^Home/ });
    expect(await home.isChecked()).toBe(true);
    expect(await page.getByRole('checkbox').count()).toBeGreaterThan(0);

    // Saving the earlier edition: everything else waits while the chooser is open.
    await rows.first().getByRole('button', { name: /^Save as one file/ }).click();
    await expect.poll(() => page.evaluate(`window.__calls`)).toEqual([['save', '2026-11-20T09-00-00Z-0badc0de']]);
    for (const card of await page.locator('.export-card').all()) expect(await card.getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('.modal-foot > button', { hasText: 'Close' }).isDisabled()).toBe(true);
    await page.evaluate(`window.__settle({ ok: true, path: '/Users/me/Documents/test-studio-review.html', message: 'Saved the review pages as one file.' })`);
    const outcome = page.locator('.client-review-outcome');
    await expect.poll(() => outcome.innerText()).toContain('Saved the review pages as one file.');
    expect(await outcome.innerText()).toContain('/Users/me/Documents/test-studio-review.html');
    await expect.poll(() => page.evaluate<boolean>(`document.activeElement === document.querySelector('.client-review-outcome')`)).toBe(true);
    expect(await outcome.getByRole('button', { name: 'Show in folder' }).count()).toBe(1);
    expect(await page.locator('.export-card').first().getAttribute('aria-disabled')).toBeNull();

    // A cancelled chooser goes back to its button, saying nothing.
    const save = rows.first().getByRole('button', { name: /^Save as one file/ });
    await save.click();
    // The chooser takes focus while it is open.
    await toggle.focus();
    await page.evaluate(`window.__settle({ ok: false })`);
    await expect.poll(() => page.evaluate<boolean>(`document.activeElement?.getAttribute('aria-label')?.startsWith('Save as one file') ?? false`)).toBe(true);

    // Capturing: with no page chosen it says so and asks for nothing.
    await home.uncheck();
    const capture = page.locator('.client-review-actions button');
    expect(await capture.getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('.client-review-hint').innerText()).toBe('Choose at least one page.');
    await capture.click({ force: true });
    expect(await page.evaluate(`window.__calls.length`)).toBe(2);
    await home.check();
    await capture.click();
    await expect.poll(() => page.evaluate(`window.__calls.at(-1)`)).toEqual(['capture', { routes: ['/'] }]);
    await expect.poll(() => page.locator('.client-review-hint').innerText()).toContain('Building the website and picturing each page');
    expect(await home.isDisabled()).toBe(true);
    await page.evaluate(`window.__settle({ ok: true, path: '/p', message: 'Captured 2 pictures.', edition: { ...window.__edition('2026-11-27T10-00-00Z-1badc0de', new Date().toISOString()), captures: [{ route: '/', width: 1440, status: 'captured', file: 'images/001-1440.png', height: 900, sha256: 'a' }, { route: '/', width: 390, status: 'captured', file: 'images/001-390.png', height: 900, sha256: 'a' }] } })`);
    await expect.poll(() => rows.count()).toBe(2);
    expect(await rows.first().innerText()).toContain('1 page · 2 pictures');
    expect(await rows.first().getAttribute('class')).toBe('is-latest');
    expect(await outcome.innerText()).toContain('Captured 2 pictures.');
  });

  it('captures the pages chosen, not only the home page, and drops a page that is no longer published (#1134)', async () => {
    await open(1100, 900, { bridge: REVIEW_BRIDGE });
    await page.getByRole('button', { name: 'Client review pages' }).click();
    const about = page.locator('.client-review-pages label', { hasText: '/about/' }).getByRole('checkbox');
    await about.check();
    await page.getByRole('button', { name: 'Capture 2 pages' }).click();
    await expect.poll(() => page.evaluate(`window.__calls.at(-1)`)).toEqual(['capture', { routes: ['/', '/about/'] }]);
    // The section stays open while it works.
    await page.getByRole('button', { name: 'Client review pages' }).click({ force: true });
    expect(await page.getByRole('button', { name: 'Client review pages' }).getAttribute('aria-expanded')).toBe('true');
    await page.evaluate(`window.__settle({ ok: false, message: 'The website no longer has a page at /about/ to capture.' })`);
    await expect.poll(() => page.locator('.client-review-outcome[role="alert"]').innerText()).toContain('no longer has a page at /about/');
  });
});
