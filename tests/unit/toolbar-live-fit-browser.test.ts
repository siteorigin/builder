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

/** The preload bridge on macOS, whose traffic lights take the toolbar's first 70px: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
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
type Fit = {
  width: number;
  tier: string | null;
  overflow: number;
  clipped: string[];
  overlap: number;
};
type Session = {
  remote?: Record<string, unknown>;
  live?: Record<string, unknown>;
};

describe.skipIf(!browserInstalled)('the toolbar in a live session fits its window (#1342)', { timeout: 120_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let page: Page | null = null;
  let errors: string[] = [];
  const state = createStarterState('business', 'Test Studio', false);
  const project = JSON.stringify(state).replace(/</g, '\\u003c');
  // Open notes, so Notes carries its count.
  const notes = [
    {
      id: 'n1',
      text: 'Swap this hero photo',
      authorName: 'Ann',
      authorRole: 'viewer',
      createdAt: Date.now() - 60_000,
      pageId: state.site.homePageId,
      target: null,
      resolved: false
    },
    {
      id: 'n2',
      text: 'Fix the price',
      authorName: 'Bo',
      authorRole: 'collaborator',
      createdAt: Date.now() - 60_000,
      pageId: state.site.homePageId,
      target: null,
      resolved: false
    }
  ];
  // Two hours, less a moment: the pills read "2h 00m left".
  const twoHours = () => Date.now() + 2 * 3_600_000 - 30_000;
  const guest = (role: Role, patch: Record<string, unknown> = {}): Session => ({
    remote: {
      phase: 'admitted',
      joinId: 'j1',
      relayUrl: 'https://relay.test',
      roomId: 'r1',
      displayName: 'Guest',
      hostConnected: true,
      reconnecting: false,
      guestId: 'g1',
      role,
      projectName: 'A project with a rather long name',
      guestExpiresAt: null,
      sessionExpiresAt: twoHours(),
      relayClockOffsetMs: 0,
      hostRuntime: 'ready',
      previewRevision: 1,
      previewUrl: null,
      previewProblem: null,
      tooLarge: false,
      participants: [],
      ...patch
    }
  });
  const admitted = (guestId: string, displayName: string) => ({
    guestId,
    displayName,
    status: 'admitted',
    role: 'collaborator',
    guestExpiresAt: null,
    colorSlot: 0,
    connected: true
  });
  // A host's session at its widest: timed, locked, with people in it and more waiting to join.
  const host = (patch: Record<string, unknown> = {}): Session => ({
    live: {
      phase: 'active',
      workspaceKey: 'w1',
      runId: 'run-1',
      roomId: 'abcdefghijkmnpqrstuvwxyz',
      inviteUrl: 'http://relay.test/s/abcdefghijkmnpqrstuvwxyz',
      projectName: 'Test Studio',
      duration: '2h',
      startedAt: Date.now(),
      expiresAt: twoHours(),
      relayClockOffsetMs: 0,
      locked: true,
      participants: [admitted('g1', 'Ann'), admitted('g2', 'Bo'), { guestId: 'g3', displayName: 'Cy', status: 'pending' }, { guestId: 'g4', displayName: 'Di', status: 'pending' }],
      previewReady: true,
      lastError: null,
      ...patch
    }
  });

  beforeAll(async () => {
    [built, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
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
   * how far the start group's content runs into the centre group.
   */
  const fit = async (width: number, session: Session = {}): Promise<Fit> => {
    await page?.context().close();
    page = await (
      await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce'
      })
    ).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
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
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project}; window.__notes = ${JSON.stringify(notes)}; window.__remote = ${JSON.stringify(session.remote ?? null)}; window.__live = ${JSON.stringify(session.live ?? null)};</script><script src="/app.js"></script></body>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator(session.remote ? '.remote-leave' : '.export-btn').waitFor();
    return (await page.evaluate(`(() => {
      const bar = document.querySelector('.toolbar');
      const clipped = [...bar.querySelectorAll('button, label')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.left < 0 || r.right > innerWidth + 0.5);
      }).map((el) => el.getAttribute('aria-label') || el.textContent.trim());
      const startEnd = Math.max(...[...bar.querySelectorAll('.toolbar-start button')].map((el) => el.getBoundingClientRect().right));
      const centre = bar.querySelector('.toolbar-center').getBoundingClientRect().left;
      return { width: innerWidth, tier: bar.getAttribute('data-tier'), overflow: Math.max(0, bar.scrollWidth - bar.clientWidth), clipped, overlap: Math.max(0, Math.round(startEnd - centre)) };
    })()`)) as Fit;
  };
  const fits = (r: Fit) => ({
    width: r.width,
    clipped: r.clipped,
    overflow: r.overflow,
    overlap: r.overlap
  });
  const fitted = (width: number) => ({
    width,
    clipped: [],
    overflow: 0,
    overlap: 0
  });

  // A 13" laptop's default 1440px, a smaller laptop's 1366px and 1280px, the width the full toolbar used to start at,
  // and the window's 1100px minimum.
  const WIDTHS = [1440, 1366, 1280, 1232, 1100];

  it('keeps every control of a collaborator’s toolbar inside the window, Leave session too', async () => {
    for (const width of [TOOLBAR_FULL_MIN.guest, ...WIDTHS]) expect(fits(await fit(width, guest('collaborator')))).toEqual(fitted(width));
    expect((await fit(TOOLBAR_FULL_MIN.guest, guest('collaborator'))).tier).toBe('full');
    expect((await fit(1440, guest('collaborator'))).tier).toBe('compact');
    // And Leave session takes a click where it is.
    await page!.locator('.remote-leave').click({ trial: true });
  });

  it('keeps Leave session inside the window for each role and connection state', async () => {
    for (const session of [guest('copy-editor'), guest('viewer'), guest('collaborator', { reconnecting: true }), guest('collaborator', { hostConnected: false })]) {
      for (const width of [1440, 1100]) expect(fits(await fit(width, session))).toEqual(fitted(width));
    }
  });

  it('keeps a host’s live Share pill and Export inside the window', async () => {
    for (const width of [TOOLBAR_FULL_MIN.hosting, ...WIDTHS]) expect(fits(await fit(width, host()))).toEqual(fitted(width));
    for (const width of [TOOLBAR_FULL_MIN.hosting, ...WIDTHS]) expect(fits(await fit(width, host({ phase: 'reconnecting' })))).toEqual(fitted(width));
    expect((await fit(TOOLBAR_FULL_MIN.hosting, host())).tier).toBe('full');
  });

  it('gives a project with no session the full toolbar from its first width, Notes counting open notes', async () => {
    for (const width of [1440, TOOLBAR_FULL_MIN.local]) {
      const r = await fit(width);
      expect(r.tier).toBe('full');
      expect(fits(r)).toEqual(fitted(width));
    }
  });
});
