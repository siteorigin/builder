/**
 * Opening a recent project from Welcome goes straight to one loading screen: the editor's outline shows in the frame
 * the card is clicked, before the main process has even been asked, and stays until the project arrives. A trust
 * prompt or a failure brings Welcome back as it was, focus included; a menu command chosen meanwhile waits for the
 * screen that follows. On the canvas, a fast start leaves the outline in place, while the waits that have something to
 * say keep their cards. The real App, Welcome and preview status run in a real browser, over a stand-in for the preload.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());

/** The page's own globals, as the scripts handed to page.evaluate see them (this file compiles without the DOM). */
type Node = { textContent: string | null; isConnected: boolean; inert?: boolean; offsetParent: unknown; focus(): void; click(): void; closest(s: string): Node | null };
type Dom = {
  document: { querySelector(s: string): Node | null; querySelectorAll(s: string): Iterable<Node>; activeElement: Node | null };
  requestAnimationFrame(cb: () => void): void;
  calls: unknown[];
  main: { send(c: string, p: unknown): void; answerOpen(r: unknown): void };
  so: Record<string, (...x: unknown[]) => unknown>;
  region: Node | null;
};
const SITE = 'http://open-outline.test';
/** The fake clock's frame: a frame is always due within one. */
const FRAME_MS = 16;
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { App } from ${renderer('App')};`,
  `import { PreviewStatus, useSlowWait } from ${renderer('panels/PreviewStatus')};`,
  `import { getState, setState } from ${renderer('store')};`,
  "createRoot(document.getElementById('root')).render(h(App));",
  // The canvas's preview status on its own, as Canvas renders it, and the slow-wait timer it reads.
  'let showStatus;',
  'function Status() {',
  "  const [props, set] = useState({ runtime: { state: 'starting' }, outlined: false, slow: null });",
  '  showStatus = set;',
  '  const slow = useSlowWait(props.runtime);',
  "  return h('div', { id: 'status', 'data-slow': String(slow) }, h(PreviewStatus, { runtime: props.runtime, outlined: props.outlined, slow: props.slow ?? slow }));",
  '}',
  "createRoot(document.getElementById('status-root')).render(h(Status));",
  'window.so = {',
  "  packsReady: () => setState({ packs: { ready: true, refused: [], userDir: '' } }),",
  '  opening: () => getState().openingProject,',
  '  status: (props) => flushSync(() => showStatus(props))',
  '};'
].join('\n');

/**
 * The preload: recent projects to open, an open the test answers, and the main process's messages sent by the test.
 * Anything else is a request that is never answered, as one still on its way.
 */
const BRIDGE = `
  window.calls = [];
  const listeners = {};
  const answers = {};
  const now = new Date().toISOString();
  const recents = [
    { dir: '/sites/acme', name: 'Acme Bakery', openedAt: now },
    { dir: '/sites/harbour', name: 'Harbour Dental', openedAt: now },
    { dir: '/sites/gone', name: 'Gone Studio', openedAt: now, missing: true }
  ];
  const never = () => new Promise(() => {});
  const ns = (impl) => new Proxy(impl, { get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' || k === 'then' ? undefined : () => never()) });
  window.main = {
    send: (channel, payload) => [...(listeners[channel] ?? [])].forEach((cb) => cb(payload)),
    answerOpen: (r) => answers.open(r)
  };
  window.builder = new Proxy(
    {
      platform: 'darwin',
      on: (channel, cb) => {
        (listeners[channel] ??= new Set()).add(cb);
        return () => listeners[channel].delete(cb);
      },
      menuReady: () => window.calls.push('menuReady'),
      menuReceived: (id) => window.calls.push('menuReceived:' + id),
      leaveResult() {},
      inspectResult() {},
      componentPreviewResult() {},
      project: ns({ feed: async () => null }),
      projects: ns({
        recents: async () => recents,
        open: (dir, opts) => {
          window.calls.push(['open', dir ?? null, opts ?? null]);
          return new Promise((resolve) => (answers.open = resolve));
        }
      })
    },
    { get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' || k === 'then' ? undefined : ns({})) }
  );
`;

const css = [...['tokens', 'reset', 'primitives', 'layout'].map((n) => `styles/${n}.css`), 'Welcome.css', 'components/EditorSkeleton.css', 'panels/PreviewStatus.css']
  .map((n) => readFileSync(resolve('src/renderer/src', n), 'utf8'))
  .join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'open-outline',
        enforce: 'pre',
        resolveId: (id, importer) => {
          if (id === '\0entry') return id;
          // The editor's own code is still on its way throughout: the outline is what shows meanwhile.
          if (importer && /editor-module$/.test(id)) return '\0editor';
          return id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null;
        },
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0editor' ? 'export const editorModule = () => null; export const loadEditor = () => new Promise(() => {});' : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The app did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('opening a recent project shows one loading screen from the click', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style><style>${css}</style><body><div id="root"></div><div id="status-root"></div><script>${BRIDGE}</script><script src="/app.js"></script>`
          })
    );
    await page.goto(`${SITE}/`);
    await page.locator('.recent-card', { hasText: 'Acme Bakery' }).waitFor();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const calls = () => page.evaluate(() => (globalThis as unknown as Dom).calls);
  const opens = async () => (await calls()).filter((c) => Array.isArray(c) && c[0] === 'open');
  const send = (channel: string, payload: unknown) => page.evaluate(([c, p]) => (globalThis as unknown as Dom).main.send(c as string, p), [channel, payload] as const);
  const answerOpen = (r: unknown) => page.evaluate((a) => (globalThis as unknown as Dom).main.answerOpen(a), r);
  const so = <T>(fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (globalThis as unknown as Dom).so[f as string](...(a as unknown[])) as T, [fn, args] as const);
  /** Click a card, and say what the next frame to be painted shows: the clock is run to it, so it comes when paused too. */
  const clickAndLook = async (name: string) => {
    const look = await page.evaluateHandle((n) => {
      const g = globalThis as unknown as Dom;
      const card = [...g.document.querySelectorAll('.recent-card')].find((c) => c.textContent?.includes(n));
      card!.focus();
      card!.click();
      const shown = (el: Node | null) => !!el && el.offsetParent !== null;
      return { frame: new Promise<{ outline: boolean; welcome: boolean; canvas: boolean }>((done) => g.requestAnimationFrame(() => done({ outline: shown(g.document.querySelector('.editor-skeleton')), welcome: shown(g.document.querySelector('.welcome')), canvas: shown(g.document.querySelector('.canvas-skeleton')) }))) };
    }, name);
    await page.clock.runFor(FRAME_MS);
    return look.evaluate(({ frame }) => frame);
  };
  const visible = (sel: string) => page.locator(sel).first().isVisible();
  const count = (sel: string) => page.locator(sel).count();
  const text = (sel: string) => page.locator(sel).first().textContent();
  const statusText = () => page.evaluate(() => [...(globalThis as unknown as Dom).document.querySelectorAll('[role="status"]')].map((s) => s.textContent?.trim()).filter(Boolean));

  it('shows the outline in the frame the card is clicked, before the project is asked for, and announces it once', async () => {
    // From the click the clock moves only as the test moves it, so the second below is the opening's alone, however
    // long each step takes in real time. Held at one instant while it pauses, so pausing moves it neither way.
    const now = await page.evaluate(() => Date.now());
    await page.clock.setFixedTime(now);
    await page.clock.pauseAt(now);
    await page.clock.setSystemTime(now);
    // The themes are still being verified, so the main process has not been asked yet: the outline is the click's.
    expect(await clickAndLook('Acme Bakery')).toEqual({ outline: true, welcome: false, canvas: true });
    expect(await opens()).toEqual([]);
    await expect.poll(statusText).toContain('Opening Acme Bakery…');
    // The outline alone answers the click: its one loading sign shows only once the wait is noticeable (a second).
    expect(await count('.sk-loading')).toBe(0);
    await page.clock.runFor(900 - FRAME_MS);
    // Real time passing, as it does on a loaded machine, is not the opening's.
    await new Promise((r) => setTimeout(r, 300));
    expect(await count('.sk-loading')).toBe(0);
    await page.clock.runFor(200);
    await expect.poll(() => text('.sk-loading')).toBe('Opening Acme Bakery…');
    await page.clock.resume();
    // Nothing in the outline is reachable or read out, and Welcome is kept, not drawn.
    expect(await page.locator('.editor-skeleton').getAttribute('aria-hidden')).toBe('true');
    expect(await page.locator('.editor-skeleton').evaluate((e) => (e as unknown as Node).inert)).toBe(true);
    await expect.poll(() => count('.welcome')).toBeGreaterThan(0);
    await expect.poll(() => visible('.welcome')).toBe(false);

    await so('packsReady');
    await expect.poll(opens).toEqual([['open', '/sites/acme', null]]);
    // Opened: the outline stays until the project's snapshot takes its place, never Welcome in between.
    await answerOpen({ ok: true });
    await page.clock.runFor(100);
    await expect.poll(() => visible('.editor-skeleton')).toBe(true);
    await expect.poll(() => visible('.welcome')).toBe(false);
    expect((await statusText()).filter((t) => t === 'Opening Acme Bakery…')).toHaveLength(1);
    // Closed before it could show: Welcome again.
    await send('project:closed', undefined);
    await expect.poll(() => visible('.welcome')).toBe(true);
    await expect.poll(() => count('.editor-skeleton')).toBe(0);
    expect(await so('opening')).toBeNull();
  });

  it('brings Welcome back with the trust prompt when the project needs trusting', async () => {
    await so('packsReady');
    expect((await clickAndLook('Harbour Dental')).outline).toBe(true);
    await expect.poll(opens).toHaveLength(1);
    await answerOpen({ ok: false, needsTrust: { dir: '/sites/harbour', name: 'Harbour Dental', reason: 'new' } });
    await expect.poll(() => count('.editor-skeleton')).toBe(0);
    await expect.poll(() => visible('.welcome')).toBe(true);
    await expect.poll(() => page.getByRole('dialog').first().isVisible()).toBe(true);
    expect(await page.getByRole('dialog').first().textContent()).toContain('Harbour Dental');
  });

  it('brings Welcome back with the notice and focus on the card when the open fails, and offers a held command again', async () => {
    await so('packsReady');
    expect((await clickAndLook('Acme Bakery')).outline).toBe(true);
    await expect.poll(opens).toHaveLength(1);
    // A File menu command chosen while the outline shows waits, unconfirmed, for the screen that follows.
    await send('menu:command', { cmd: 'settings', id: 7 });
    expect(await calls()).not.toContain('menuReceived:7');
    const ready = (await calls()).filter((c) => c === 'menuReady').length;
    await answerOpen({ ok: false, message: 'The project folder could not be read.' });
    await expect.poll(() => visible('.welcome')).toBe(true);
    await expect.poll(() => count('.editor-skeleton')).toBe(0);
    await expect.poll(() => page.getByText('The project folder could not be read.').first().isVisible()).toBe(true);
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as Dom).document.activeElement?.closest('.recent-card')?.textContent ?? '')).toContain('Acme Bakery');
    await expect.poll(async () => (await calls()).filter((c) => c === 'menuReady').length).toBeGreaterThan(ready);
  });

  it('keeps Welcome for an open that starts with a chooser (Find folder…)', async () => {
    await so('packsReady');
    expect(await clickAndLook('Gone Studio')).toEqual({ outline: false, welcome: true, canvas: false });
    await expect.poll(opens).toEqual([['open', null, { folder: true, replaces: '/sites/gone' }]]);
    expect(await so('opening')).toBeNull();
    await answerOpen({ ok: false });
    await expect.poll(() => visible('.welcome')).toBe(true);
  });

  it('leaves the outline in place over a fast start, and keeps the cards for the waits that have something to say', async () => {
    const card = () => page.locator('#status .status-card');
    // Outlined: a start that has not run long, and a preview not started yet, show nothing of their own.
    await so('status', { runtime: { state: 'starting' }, outlined: true, slow: false });
    await expect.poll(() => card().count()).toBe(0);
    await so('status', { runtime: { state: 'idle' }, outlined: true, slow: false });
    await expect.poll(() => card().count()).toBe(0);
    // A start that runs long says so, and setting up the website tools always does.
    await so('status', { runtime: { state: 'starting' }, outlined: true, slow: true });
    await expect.poll(async () => (await card().count()) ? await card().first().textContent() : '').toContain('This is taking longer than usual.');
    await so('status', { runtime: { state: 'preparing', message: 'Setting up website tools…' }, outlined: true, slow: false });
    await expect.poll(async () => (await card().count()) ? await card().first().textContent() : '').toContain('Setting up website tools');
    // Not outlined, the start keeps its own card, as before.
    await so('status', { runtime: { state: 'starting' }, outlined: false, slow: false });
    await expect.poll(async () => (await card().count()) ? await card().first().textContent() : '').toContain('Starting preview');
    await so('status', { runtime: { state: 'error', message: 'The preview server failed to start.' }, outlined: true, slow: false });
    await expect.poll(async () => (await card().count()) ? await card().first().textContent() : '').toContain('The preview couldn’t start');
  });

  it('times a start as slow 15 seconds after it began, afresh for each wait', async () => {
    const slow = () => page.locator('#status').getAttribute('data-slow');
    await so('status', { runtime: { state: 'starting' }, outlined: true });
    await page.clock.runFor(14_000);
    expect(await slow()).toBe('false');
    await page.clock.runFor(1_500);
    expect(await slow()).toBe('true');
    // The page came up, then the preview restarted: a new wait, not slow yet.
    await so('status', { runtime: { state: 'ready', url: 'http://127.0.0.1:1' }, outlined: false });
    await so('status', { runtime: { state: 'starting' }, outlined: true });
    expect(await slow()).toBe('false');
    // Stopped part way through and started again: timed from the new start, never the old one's deadline.
    await page.clock.runFor(10_000);
    await so('status', { runtime: { state: 'error', message: 'The preview process stopped unexpectedly.' }, outlined: false });
    await so('status', { runtime: { state: 'starting' }, outlined: true });
    await page.clock.runFor(10_000);
    expect(await slow()).toBe('false');
    await page.clock.runFor(5_500);
    expect(await slow()).toBe('true');
  });

  it('times a preview not started yet and its start as one wait, and says so in the region already there', async () => {
    const slow = () => page.locator('#status').getAttribute('data-slow');
    await so('status', { runtime: { state: 'idle' }, outlined: true });
    await page.evaluate(() => {
      const g = globalThis as unknown as Dom;
      g.region = g.document.querySelector('#status [role="status"]');
    });
    await page.clock.runFor(10_000);
    await so('status', { runtime: { state: 'starting' }, outlined: true });
    await page.clock.runFor(4_000);
    expect(await slow()).toBe('false');
    await page.clock.runFor(1_500);
    expect(await slow()).toBe('true');
    expect(
      await page.evaluate(() => {
        const g = globalThis as unknown as Dom;
        return g.region === g.document.querySelector('#status [role="status"]') && g.region?.textContent;
      })
    ).toBe('Starting the preview is taking longer than usual.');
  });

  it('keeps the slow-start announcer as the same region when the card takes over from the outline', async () => {
    await so('status', { runtime: { state: 'starting' }, outlined: true, slow: false });
    await page.evaluate(() => {
      const g = globalThis as unknown as Dom;
      g.region = g.document.querySelector('#status [role="status"]');
    });
    await so('status', { runtime: { state: 'starting' }, outlined: true, slow: true });
    expect(await page.evaluate(() => {
      const g = globalThis as unknown as Dom;
      const region = g.region;
      return !!region?.isConnected && region === g.document.querySelector('#status [role="status"]') && region.textContent;
    })).toBe('Starting the preview is taking longer than usual.');
  });
});
