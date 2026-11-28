/**
 * The toolbar keeps every control inside the window during a live session (#1342). In the remote shell its end holds
 * Notes, the live session pill ("Collaborator · 2h 00m left") and Leave session, which together take more room than
 * the host's Share and Export, so at 1440px on macOS Leave session was pushed past the window's right edge; a host's
 * live Share pill ("Live · 2h 00m left", its people and waiting counts) is wider than Share too. The real toolbar and
 * the app's own styles run in a real browser, at the widths a laptop gives the window.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { TOOLBAR_FULL_MIN } from '../../src/renderer/src/lib/layout';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://toolbar-live-fit.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Toolbar } from ${renderer('panels/Toolbar')};`,
  `import { useStore } from ${renderer('store')};`,
  'window.__store = useStore;',
  'const state = window.__project;',
  "const remote = window.__remote ?? { phase: 'idle', ended: null };",
  "const live = window.__live ?? { phase: 'idle', lastError: null };",
  "const key = remote.phase === 'admitted' ? 'remote:' + remote.joinId : 'w1';",
  "flushSync(() => useStore.setState({ screen: 'editor', mode: 'edit', leftTab: 'layers', pageId: state.site.homePageId, remote, live, liveClock: null, snapshot: { state, revision: 1, workspaceKey: key, conflicts: [], recentExports: [], diagnostics: [], history: { canUndo: false, canRedo: false } }, notes: { notes: window.__notes, guestNotes: true, opening: key }, selection: null }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Toolbar)));"
].join('\n');

/** The preload bridge, on macOS (whose traffic lights take the toolbar's first 70px) unless told otherwise: every call answers nothing. */
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
    resolve: {
      alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)]))
    },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'toolbar-live-fit',
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
  if (!chunk || chunk.type !== 'chunk') throw new Error('The toolbar did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

type Role = 'collaborator' | 'copy-editor' | 'viewer';
type Fit = { width: number; tier: string | null; overflow: number; clipped: string[]; overlap: number };
type Session = { remote?: Record<string, unknown>; live?: Record<string, unknown> };

/** The exact first widths of the full toolbar are measured against macOS's own fonts; elsewhere the browser's fonts differ. */
const macFonts = process.platform === 'darwin';

describe.skipIf(!browserInstalled)('the toolbar in a live session fits its window (#1342)', { timeout: 120_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let page: Page | null = null;
  let errors: string[] = [];
  // The pages' clock, fixed, so the pills read the same however long the run takes.
  const NOW = Date.parse('2026-11-28T10:00:00Z');
  const single = createStarterState('business', 'Test Studio', false);
  // A website with a dark palette too: the toolbar also shows Preview colors.
  const dual = { ...single, tokens: { ...single.tokens, colorSchemeMode: 'toggle' } };
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  // Open notes, so Notes carries its count.
  const note = (id: string, text: string) => ({ id, text, authorName: 'Ann', authorRole: 'viewer', createdAt: NOW - 60_000, pageId: single.site.homePageId, target: null, resolved: false });
  const notes = [note('n1', 'Swap this hero photo'), note('n2', 'Fix the price')];
  // Two hours: the pills read "2h 00m left".
  const ends = NOW + 2 * 3_600_000;
  const guest = (role: Role, patch: Record<string, unknown> = {}): Session => ({
    remote: {
      ...{ phase: 'admitted', joinId: 'j1', relayUrl: 'https://relay.test', roomId: 'r1', displayName: 'Guest', hostConnected: true, reconnecting: false, guestId: 'g1', role },
      ...{ projectName: 'A project with a rather long name', guestExpiresAt: null, sessionExpiresAt: ends, relayClockOffsetMs: 0, hostRuntime: 'ready', previewRevision: 1, previewUrl: null },
      ...{ previewProblem: null, tooLarge: false, participants: [] },
      ...patch
    }
  });
  const admitted = (guestId: string, displayName: string) => ({ guestId, displayName, status: 'admitted', role: 'collaborator', guestExpiresAt: null, colorSlot: 0, connected: true });
  const waiting = (guestId: string, displayName: string) => ({ guestId, displayName, status: 'pending' });
  // A host's session at its widest: timed, locked, with people in it and more waiting to join.
  const host = (patch: Record<string, unknown> = {}): Session => ({
    live: {
      ...{ phase: 'active', workspaceKey: 'w1', runId: 'run-1', roomId: 'abcdefghijkmnpqrstuvwxyz', inviteUrl: 'http://relay.test/s/abcdefghijkmnpqrstuvwxyz', projectName: 'Test Studio' },
      ...{ duration: '2h', startedAt: NOW, expiresAt: ends, relayClockOffsetMs: 0, locked: true, previewReady: true, lastError: null },
      participants: [admitted('g1', 'Ann'), admitted('g2', 'Bo'), waiting('g3', 'Cy'), waiting('g4', 'Di')],
      ...patch
    }
  });

  beforeAll(async () => {
    built = await bundle();
    browser = await chromium.launch({ headless: true });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(() => {
    errors = [];
  });
  afterEach(async () => {
    await page?.context().close();
    page = null;
    expect(errors).toEqual([]);
  });

  /**
   * The toolbar at `width`: its tier, how far its content runs past the window, any control not wholly inside it, and
   * how far the start group (the switcher and the save state) runs into the centre group.
   */
  const fit = async (width: number, session: Session = {}, palettes: 'single' | 'dual' = 'single', platform = 'darwin'): Promise<Fit> => {
    await page?.context().close();
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page = null;
    page = await context.newPage().catch(async (e) => {
      await context.close();
      throw e;
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.clock.setFixedTime(NOW);
    const project = json(palettes === 'dual' ? dual : single);
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: built.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: built.styles });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${bridge(platform)}window.__project = ${project}; window.__notes = ${json(notes)}; window.__remote = ${json(session.remote ?? null)}; window.__live = ${json(session.live ?? null)};</script><script src="/app.js"></script></body>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator(session.remote ? '.remote-leave' : '.export-btn').waitFor();
    // Each fixture shows what it says it does: Notes' count, the session's own pill, and Preview colors with a dark palette.
    expect(await page.locator('.notes-btn').innerText()).toContain('2');
    expect(await page.locator('.scheme-btn').count()).toBe(palettes === 'dual' ? 1 : 0);
    if (session.remote) {
      const r = session.remote;
      expect(await page.locator(`.remote-pill.${r.reconnecting ? 'reconnecting' : r.hostConnected ? 'live' : 'away'}`).count()).toBe(1);
    } else {
      const kind = session.live ? (session.live.phase === 'reconnecting' ? 'reconnecting' : 'live') : 'idle';
      expect(await page.locator(`.share-btn.${kind}`).count()).toBe(1);
      if (session.live) expect(await page.evaluate(`(() => { const b = document.querySelector('.share-btn'); return [b.querySelector('.share-count')?.textContent, b.querySelector('.share-badge')?.textContent, !!b.querySelector('.share-lock')]; })()`)).toEqual(['2', '2', true]);
    }
    return (await page.evaluate(`(() => {
      const bar = document.querySelector('.toolbar');
      const clipped = [...bar.querySelectorAll('button, label')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < 0 || r.right > innerWidth + 0.5);
      }).map((el) => el.getAttribute('aria-label') || el.textContent.trim());
      const startEnd = Math.max(...[...bar.querySelectorAll('.toolbar-start :is(button, .save-state)')].map((el) => el.getBoundingClientRect().right));
      const centre = bar.querySelector('.toolbar-center').getBoundingClientRect().left;
      return { width: innerWidth, tier: bar.getAttribute('data-tier'), overflow: Math.max(0, bar.scrollWidth - bar.clientWidth), clipped, overlap: Math.max(0, Math.round(startEnd - centre)) };
    })()`)) as Fit;
  };
  const fits = (r: Fit) => ({ width: r.width, clipped: r.clipped, overflow: r.overflow, overlap: r.overlap });
  const fitted = (width: number) => ({ width, clipped: [], overflow: 0, overlap: 0 });

  // A 13" laptop's default 1440px, a smaller laptop's 1366px and 1280px, the width the full toolbar used to start at,
  // and the window's 1100px minimum; then roomy windows the full toolbar fits in whatever the fonts.
  const WIDTHS = [1440, 1366, 1280, 1232, 1100, 1640];
  /** The widths to check a session at: the usual ones, and on macOS its full toolbar's first width with either palette. */
  const widths = (full: number) => (macFonts ? [full, ...WIDTHS] : WIDTHS);

  it('keeps every control of a collaborator’s toolbar inside the window, Leave session too', async () => {
    for (const palettes of ['single', 'dual'] as const) {
      for (const width of widths(TOOLBAR_FULL_MIN.guest)) expect(fits(await fit(width, guest('collaborator'), palettes))).toEqual(fitted(width));
    }
    // At 1440px Leave session keeps its place as its icon, and takes a click there.
    const r = await fit(1440, guest('collaborator'));
    expect(r.tier).toBe('compact');
    const leave = page!.getByRole('button', { name: 'Leave session' });
    expect(await leave.innerText()).toBe('');
    await leave.click({ trial: true });
    expect((await fit(1640, guest('collaborator'))).tier).toBe('full');
    expect(await page!.getByRole('button', { name: 'Leave session' }).innerText()).toBe('Leave session');
    // Windows and Linux have no traffic lights, and the full toolbar's start column keeps a 30px narrower floor there.
    if (macFonts) {
      const r = await fit(TOOLBAR_FULL_MIN.guest - 30, guest('collaborator'), 'dual', 'win32');
      expect(r.tier).toBe('full');
      expect(fits(r)).toEqual(fitted(TOOLBAR_FULL_MIN.guest - 30));
    }
  });

  it('keeps Leave session inside the window for each role and connection state', async () => {
    for (const session of [guest('copy-editor'), guest('viewer'), guest('collaborator', { reconnecting: true }), guest('collaborator', { hostConnected: false })]) {
      for (const width of [1440, 1100]) expect(fits(await fit(width, session, 'dual'))).toEqual(fitted(width));
    }
  });

  it('keeps a host’s live Share pill and Export inside the window', async () => {
    for (const session of [host(), host({ phase: 'reconnecting' })]) {
      for (const palettes of ['single', 'dual'] as const) {
        for (const width of widths(TOOLBAR_FULL_MIN.hosting)) expect(fits(await fit(width, session, palettes))).toEqual(fitted(width));
      }
    }
    expect((await fit(1440, host())).tier).toBe('compact');
    expect((await fit(1640, host())).tier).toBe('full');
  });

  it('gives a project with no session the full toolbar from its first width, Notes counting open notes', async () => {
    for (const palettes of ['single', 'dual'] as const) {
      for (const width of widths(TOOLBAR_FULL_MIN.local)) expect(fits(await fit(width, {}, palettes))).toEqual(fitted(width));
    }
    expect((await fit(1440)).tier).toBe('full');
  });
});
