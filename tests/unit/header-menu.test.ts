/**
 * The Foundation header's phone menu as visitors meet it, in real headless browsers: the generated layout, home
 * page and theme CSS exactly as an exported site ships them. The markup is rendered on the server as a prerendered
 * export delivers it; the site's script then hydrates that markup, starts late, or never runs at all. The business
 * has a long name, ten pages in its menu and the starter's Book a call action.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImageValue, InstanceNode, LinkValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { STYLES_DIR, generateProject } from '@generator/index';

const ORIGIN = 'https://site.test';
const BRAND = 'North Harbor Architecture and Conservation';
const LABELS = ['Home', 'About', 'Contact', 'Our studio', 'Heritage projects', 'Conservation services', 'Residential work', 'Commercial work', 'Journal', 'Visit us'];
const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));
/** A wide wordmark: 136px at the header's 34px logo height. */
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100"><rect width="400" height="100" fill="#2a6"/></svg>';
const PHONES = [320, 360, 390];

/** The exported site's files and stylesheets: a long name (and, for `logo`, a wide logo beside it) and ten links. */
function exportedSite(logo: boolean) {
  const s = createStarterState('business', BRAND, false);
  const targets = s.site.pageOrder;
  const page = (target: string): LinkValue => ({ type: 'page', target });
  const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  const image: ImageValue | null = logo ? { src: '/media/wordmark.svg', alt: 'North Harbor wordmark', width: 400, height: 100 } : null;
  header.props = { ...header.props, siteName: BRAND, logo: image, showSiteName: true, sticky: true, links: LABELS.map((label, i) => ({ id: `i${i + 1}`, label, link: page(targets[i % targets.length]) })) };
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css };
}

const STUBS: Record<string, string> = {
  '\0$app/paths': 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;',
  '\0$app/state': 'export const page = { route: { id: "/" }, url: new URL("https://site.test/") };',
  // afterNavigate callbacks hear the visit's `enter` once the site has started, as they do when SvelteKit hydrates.
  '\0$app/navigation':
    "import { onMount } from 'svelte'; const callbacks = new Set(); export function afterNavigate(fn) { onMount(() => { callbacks.add(fn); return () => callbacks.delete(fn); }); } export function navigated(type) { for (const fn of callbacks) fn({ type }); } export function beforeNavigate() {} export function snapshot() {}"
};

/** Every case's layout and home page, bundled for the server (`render`) or the browser (`window.startSite`). */
async function bundleSites(sites: Record<string, Map<string, string>>, generate: 'server' | 'client'): Promise<string> {
  const src = new Map<string, string>();
  for (const [name, files] of Object.entries(sites)) {
    for (const [path, text] of files) src.set(`\0site/${name}/${path}`, text);
    src.set(`\0site/${name}/Entry.svelte`, `<script>import Layout from './src/routes/+layout.svelte'; import Page from './src/routes/+page.svelte';</script><Layout><Page /></Layout>`);
  }
  const names = Object.keys(sites);
  const imports = names.map((n, i) => `import E${i} from '\0site/${n}/Entry.svelte';`);
  const all = `const all = { ${names.map((n, i) => `${JSON.stringify(n)}: E${i}`).join(', ')} };`;
  const entry =
    generate === 'server'
      ? ["import { render } from 'svelte/server';", ...imports, all, 'export const renderCase = (name) => render(all[name]);'].join('\n')
      : [
          "import { flushSync, hydrate } from 'svelte';",
          "import { navigated } from '$app/navigation';",
          ...imports,
          all,
          "window.startSite = (name) => { hydrate(all[name], { target: document.getElementById('app') }); flushSync(); navigated('enter'); window.started = true; };"
        ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ...(generate === 'server' ? { ssr: { noExternal: true } } : {}),
    plugins: [
      {
        name: 'exported-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry') return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          // Stylesheets are inlined in the page; fonts fall back to the system stack.
          if (id.startsWith('@fontsource') || id.endsWith('.css')) return '\0empty';
          if (importer?.startsWith('\0site/') && id.startsWith('.')) {
            const path = `\0${posix.join(posix.dirname(importer.slice(1)), id)}`;
            if (src.has(path)) return path;
          }
          return src.has(id) ? id : null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return '';
          if (STUBS[id]) return STUBS[id];
          const text = src.get(id);
          if (text === undefined) return null;
          const code = id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate, css: 'injected' }).js.code : text;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: {
      write: false,
      ...(generate === 'server' ? { ssr: true } : {}),
      minify: false,
      rolldownOptions: { input: '\0entry', output: { format: generate === 'server' ? 'esm' : 'iife', codeSplitting: false } }
    }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return chunk.code;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

// Browser code is passed as text: the Node project has no DOM types.
const BOXES = `(() => {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  };
  return { toggle: box('.so-header__toggle'), brand: box('.so-header__brand'), viewport: document.documentElement.clientWidth };
})()`;

/** Whether the element is on screen and is what a tap at its centre lands on. */
const tappable = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const b = el.getBoundingClientRect();
  if (!b.width || !b.height || b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > document.documentElement.clientWidth) return false;
  const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
  return !!hit && (hit === el || el.contains(hit));
})()`;

/** Where focus is: in the header, on the menu button, or outside the header (with its text). */
const FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return { inHeader: !!el.closest('header.so-header'), toggle: !!el.closest('.so-header__toggle'), text: el.textContent.trim().replace(/\\s+/g, ' '), href: el.getAttribute('href') };
})()`;

interface Focus {
  inHeader: boolean;
  toggle: boolean;
  text: string;
  href: string | null;
}

const MENU_LINKS = [...LABELS, 'Book a call'];

if (!ENGINES.length) describe.skip('the phone menu (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

describe.each(ENGINES)('the phone menu in %s', (engineName, engine) => {
  let browser: Browser;
  let script: string;
  let dir: string;
  const markup: Record<string, { head: string; body: string }> = {};
  const sites = { name: exportedSite(false), logo: exportedSite(true) };

  beforeAll(async () => {
    const files = Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, site.files]));
    const [client, server, launched] = await Promise.allSettled([
      bundleSites(files, 'client'),
      bundleSites(files, 'server'),
      engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 })
    ]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (client.status === 'rejected') throw client.reason;
    if (server.status === 'rejected') throw server.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = client.value;
    dir = mkdtempSync(join(tmpdir(), 'so-header-menu-'));
    const file = join(dir, 'server.mjs');
    writeFileSync(file, server.value);
    const { renderCase } = (await import(pathToFileURL(file).href)) as { renderCase: (name: string) => { head: string; body: string } };
    for (const name of Object.keys(sites)) markup[name] = renderCase(name);
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Opens a case as delivered: the server-rendered page, whose script hydrates it (`script: 'now'`), only when the
   * test calls `start()` (`'late'`), or never because the browser runs no scripts (`'off'`).
   */
  async function withSite(
    name: keyof typeof sites,
    size: { width: number; height: number },
    scripts: 'now' | 'late' | 'off',
    body: (page: Page, start: () => Promise<void>, context: BrowserContext) => Promise<void>
  ) {
    // Reduced motion turns off the theme's smooth scrolling, so a scroll has finished when it is measured.
    const context = await browser.newContext({ viewport: size, reducedMotion: 'reduce', hasTouch: true, javaScriptEnabled: scripts !== 'off' });
    context.setDefaultTimeout(10_000);
    try {
      const page = await context.newPage();
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        if (path.startsWith('/media/')) return route.fulfill({ contentType: 'image/svg+xml', body: LOGO_SVG });
        if (path !== '/') return route.fulfill({ status: 404, body: '' });
        const { head, body: rendered } = markup[name];
        const start = scripts === 'now' ? `<script src="/site.js"></script><script>startSite(${JSON.stringify(name)})</script>` : '';
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sites[name].css}</style>${head}</head><body><div id="app" style="display: contents">${rendered}</div>${start}</body></html>`
        });
      });
      await page.goto(`${ORIGIN}/`);
      if (scripts === 'now') await page.waitForFunction('window.started === true');
      const start = async () => {
        await page.addScriptTag({ url: `${ORIGIN}/site.js` });
        await page.evaluate(`startSite(${JSON.stringify(name)})`);
      };
      await body(page, start, context);
    } finally {
      await context.close();
    }
  }

  const menuOpen = (page: Page) => page.locator('#so-site-nav').isVisible();
  const focus = async (page: Page) => (await page.evaluate(FOCUS)) as Focus | null;
  const tab = async (page: Page, shift = false) => {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    return focus(page);
  };
  /** Tabs from the top of the page until the menu button has focus. */
  const tabToToggle = async (page: Page) => {
    for (let i = 0; i < 5; i++) if ((await tab(page))?.toggle) return;
    throw new Error('Tab never reached the menu button');
  };

  it('keeps the whole 44 × 44 menu button beside a long name, with or without a logo, at every phone width', async () => {
    const problems: string[] = [];
    for (const name of ['name', 'logo'] as const)
      for (const width of PHONES)
        await withSite(name, { width, height: 700 }, 'now', async (page) => {
          const { toggle, brand, viewport } = (await page.evaluate(BOXES)) as { toggle: Box; brand: Box; viewport: number };
          const at = `${name} at ${width}px`;
          if (Math.round(toggle.width) < 44 || Math.round(toggle.height) < 44) problems.push(`${at}: the button is ${toggle.width}×${toggle.height}`);
          if (toggle.right > viewport + 0.5) problems.push(`${at}: the button reaches ${toggle.right}px`);
          if (brand.right > toggle.left + 0.5) problems.push(`${at}: the brand (to ${brand.right}px) runs under the button (from ${toggle.left}px)`);
        });
    expect(problems).toEqual([]);
  }, 60_000);

  it('opens the menu by touch and by keyboard when the browser runs no scripts', async () => {
    await withSite('name', { width: 390, height: 844 }, 'off', async (page) => {
      expect(await menuOpen(page)).toBe(false);
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      const last = '#so-site-nav .so-header__cta';
      expect(await page.evaluate(tappable(last)), 'Book a call can be tapped').toBe(true);
      for (const label of LABELS) expect(await page.locator('#so-site-nav ul a', { hasText: label }).first().isVisible(), label).toBe(true);
      // Tapping the button again folds the menu away.
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(false);
    });
    if (engineName !== 'chromium') return;
    await withSite('name', { width: 390, height: 844 }, 'off', async (page) => {
      await tabToToggle(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => menuOpen(page)).toBe(true);
      const reached: string[] = [];
      for (let i = 0; i < MENU_LINKS.length; i++) reached.push((await tab(page))?.text ?? '');
      expect(reached).toEqual(MENU_LINKS);
    });
  }, 60_000);

  it('keeps a menu opened before the script starts, then closes it by Escape and by a press outside', async () => {
    await withSite('name', { width: 390, height: 844 }, 'late', async (page, start) => {
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      await start();
      await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
      expect(await menuOpen(page), 'still open once the script runs').toBe(true);
      expect(await page.evaluate(tappable('#so-site-nav .so-header__cta'))).toBe(true);

      await page.locator('.so-header__toggle').focus();
      await page.keyboard.press('Escape');
      await expect.poll(() => menuOpen(page)).toBe(false);
      expect((await focus(page))?.toggle, 'Escape returns to the menu button').toBe(true);

      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      const footer = await page.locator('footer').boundingBox();
      await page.mouse.click(footer!.x + 5, footer!.y + 5);
      await expect.poll(() => menuOpen(page)).toBe(false);
    });
  }, 60_000);

  // Tab follows links in Chromium; Safari's engine moves through links only when the visitor turns that on.
  it.runIf(engineName === 'chromium')('closes when focus leaves the header, leaving it on the control it reached', async () => {
    await withSite('name', { width: 375, height: 490 }, 'now', async (page) => {
      await tabToToggle(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => menuOpen(page)).toBe(true);
      // Between menu links, and back across to the button, it stays open.
      const reached: string[] = [];
      for (let i = 0; i < MENU_LINKS.length; i++) {
        reached.push((await tab(page))?.text ?? '');
        expect(await menuOpen(page), `open at ${reached.at(-1)}`).toBe(true);
      }
      expect(reached).toEqual(MENU_LINKS);
      for (let i = 0; i < MENU_LINKS.length; i++) await tab(page, true);
      expect((await focus(page))?.toggle).toBe(true);
      expect(await menuOpen(page), 'open on the button').toBe(true);
      for (let i = 0; i < MENU_LINKS.length; i++) await tab(page);

      // Past Book a call, focus lands on the page and the menu folds away without taking it back.
      const after = await tab(page);
      expect(after?.inHeader, `focus moved to ${after?.text}`).toBe(false);
      await expect.poll(() => menuOpen(page)).toBe(false);
      expect(await focus(page)).toEqual(after);

      // Shift+Tab out of the top of the header (the brand, then the skip link) closes it the same way.
      await tab(page, true);
      expect((await focus(page))?.toggle).toBe(true);
      await page.keyboard.press('Enter');
      await expect.poll(() => menuOpen(page)).toBe(true);
      expect((await tab(page, true))?.text).toBe(BRAND);
      expect(await menuOpen(page), 'open on the brand').toBe(true);
      const skip = await tab(page, true);
      expect(skip?.inHeader).toBe(false);
      await expect.poll(() => menuOpen(page)).toBe(false);
      expect(await focus(page)).toEqual(skip);
    });
  }, 60_000);

  it('scrolls a long menu on its own on a short landscape screen, and closing it leaves the page where it was', async () => {
    await withSite('name', { width: 667, height: 375 }, 'now', async (page) => {
      await page.evaluate('scrollTo({ top: 300, behavior: "instant" })');
      const scrolled = (await page.evaluate('scrollY')) as number;
      expect(scrolled).toBeGreaterThan(0);
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      const nav = (await page.locator('#so-site-nav').boundingBox())!;
      expect(nav.y + nav.height, 'the menu ends at the bottom of the screen').toBeLessThanOrEqual(375.5);
      const last = '#so-site-nav .so-header__cta';
      expect(await page.evaluate(tappable(last)), 'Book a call starts out of reach').toBe(false);

      // A wheel over the menu scrolls the menu, not the page, until Book a call can be tapped.
      await page.mouse.move(nav.x + nav.width / 2, nav.y + nav.height / 2);
      for (let i = 0; i < 20 && !(await page.evaluate(tappable(last))); i++) {
        await page.mouse.wheel(0, 80);
        await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
      }
      expect(await page.evaluate(tappable(last)), 'Book a call scrolled into reach').toBe(true);
      expect(await page.evaluate('scrollY')).toBe(scrolled);
      await page.locator(last).tap({ trial: true });

      await page.keyboard.press('Escape');
      await expect.poll(() => menuOpen(page)).toBe(false);
      expect(await page.evaluate('scrollY')).toBe(scrolled);
    });
  }, 60_000);

  it.runIf(engineName === 'chromium')('reaches the last link of a long menu by keyboard with doubled text on a short landscape screen', async () => {
    await withSite('name', { width: 667, height: 375 }, 'now', async (page, _start, context) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
      await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
      await tabToToggle(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => menuOpen(page)).toBe(true);
      const nav = (await page.locator('#so-site-nav').boundingBox())!;
      expect(nav.y + nav.height).toBeLessThanOrEqual(375.5);
      for (let i = 0; i < MENU_LINKS.length; i++) await tab(page);
      expect((await focus(page))?.text).toBe('Book a call');
      await page.evaluate('Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))');
      expect(await page.evaluate(tappable('#so-site-nav .so-header__cta')), 'focused Book a call is on screen').toBe(true);
    });
  }, 60_000);
});
