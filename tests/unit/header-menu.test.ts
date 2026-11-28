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
/** The issue's case: a 33-character name beside the ten links the menu allows and the Book a call action. */
const WIDE_BRAND = 'Harbourside Interior Design Group';
const THEMES = ['foundation', 'foundation-alt'] as const;
const WIDTHS = [768, 820, 900, 1024, 1100, 1180, 1280, 1366, 1440, 1600, 1920];
/** A menu that fits beside the name on every screen wider than a phone. */
const SHORT_LABELS = ['Home', 'About', 'Contact'];
/** A menu that fits beside a short name on a wide screen and not on a narrow one. */
const MEDIUM_LABELS = ['Home', 'About us', 'Services', 'Our work', 'Residential', 'Commercial', 'Journal', 'Contact'];

/** The exported site's files and stylesheets: a long name (and, for `logo`, a wide logo beside it) and ten links. */
function exportedSite(logo: boolean, brand = BRAND, themeId?: string, labels = LABELS) {
  const s = createStarterState('business', brand, false, themeId);
  const targets = s.site.pageOrder;
  const page = (target: string): LinkValue => ({ type: 'page', target });
  const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  let image: ImageValue | null = null;
  if (logo) {
    s.assets.assets.wordmark = { id: 'wordmark', name: 'wordmark', file: 'static/assets/wordmark.svg', mime: 'image/svg+xml', bytes: LOGO_SVG.length, width: 400, height: 100, hash: 'wordmark', kind: 'image', createdAt: '' };
    image = { assetId: 'wordmark', alt: 'North Harbor wordmark' };
  }
  header.props = { ...header.props, siteName: brand, logo: image, showSiteName: true, sticky: true, links: labels.map((label, i) => ({ id: `i${i + 1}`, label, link: page(targets[i % targets.length]) })) };
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css };
}

const STUBS: Record<string, string> = {
  '\0$app/paths': 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;',
  '\0$app/state': 'export const page = { route: { id: "/" }, url: new URL("https://site.test/") };',
  // afterNavigate callbacks hear the visit's `enter` once the site has started, as they do when SvelteKit hydrates.
  '\0$app/navigation':
    "import { onMount } from 'svelte'; const callbacks = new Set(); export function afterNavigate(fn) { onMount(() => { callbacks.add(fn); return () => callbacks.delete(fn); }); } export function navigated(type) { for (const fn of callbacks) fn({ type }); } export function beforeNavigate() {} export function onNavigate() {} export function snapshot() {}"
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
          "window.navigated = navigated;",
          // No recovery: a mismatch fails the start instead of quietly replacing the served markup.
          "window.startSite = (name) => { hydrate(all[name], { target: document.getElementById('app'), recover: false }); flushSync(); navigated('enter'); window.started = true; };"
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
  const logo = document.querySelector('.so-header__brand img');
  return { toggle: box('.so-header__toggle'), brand: box('.so-header__brand'), logo: logo && logo.complete && logo.naturalWidth > 0 ? box('.so-header__brand img') : null, viewport: document.documentElement.clientWidth };
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

/**
 * How the header is laid out: whether the menu button shows, how many lines the name takes, and the boxes of the
 * brand, the links and the action, with the row they sit in.
 */
const ARRANGEMENT = `(() => {
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  };
  const name = document.querySelector('.so-header__brand > span');
  const range = document.createRange();
  range.selectNodeContents(name);
  const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
  const toggle = document.querySelector('.so-header__toggle');
  const nav = document.getElementById('so-site-nav');
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  return {
    compact: shown(toggle),
    navShown: shown(nav),
    lines,
    inner: box(document.querySelector('.so-header__inner')),
    brand: box(document.querySelector('.so-header__brand')),
    toggle: shown(toggle) ? box(toggle) : null,
    links: [...nav.querySelectorAll('.so-header__list > li > a')].map(box),
    cta: nav.querySelector('.so-header__cta') ? box(nav.querySelector('.so-header__cta')) : null,
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  };
})()`;

interface Arrangement {
  compact: boolean;
  navShown: boolean;
  lines: number;
  inner: Box;
  brand: Box;
  toggle: Box | null;
  links: Box[];
  cta: Box | null;
  viewport: number;
  scrollWidth: number;
}

/** What is untidy about an arrangement: one row of brand, links and action, or the brand beside the menu button. */
function untidy(a: Arrangement): string[] {
  const out: string[] = [];
  if (a.lines !== 1) out.push(`the name takes ${a.lines} lines`);
  if (a.scrollWidth > a.viewport + 0.5) out.push(`the page scrolls sideways to ${a.scrollWidth}px`);
  if (a.compact) {
    if (a.navShown) out.push('the menu button shows beside an open row of links');
    if (a.toggle && a.brand.right > a.toggle.left + 0.5) out.push('the brand runs under the menu button');
    return out;
  }
  if (!a.navShown) out.push('neither the links nor the menu button show');
  if (!a.links.length || !a.cta) out.push(`the row shows ${a.links.length} links${a.cta ? '' : ' and no action'}`);
  const row = [...a.links, ...(a.cta ? [a.cta] : [])];
  const mid = (b: Box) => (b.top + b.bottom) / 2;
  const centre = mid(a.brand);
  // Every link and the action on one row, level with the brand and beside it.
  if (row.some((b) => Math.abs(mid(b) - centre) > 2)) out.push(`the links sit on rows at ${[...new Set(row.map((b) => Math.round(mid(b))))].join(', ')}px, the brand at ${Math.round(centre)}px`);
  if (row.some((b) => b.left < a.brand.right)) out.push('a link starts before the brand ends');
  if (row.some((b) => b.right > a.inner.right + 0.5)) out.push('a link runs past the header');
  return out;
}

/**
 * Whether the header's row holds the brand, the links and the action on one line: as wide as they need, laid out for
 * a moment within one task as the header's own measure lays them out (nothing is painted).
 */
const ROW_FITS = `(() => {
  const header = document.querySelector('header.so-header');
  const row = header.querySelector(':scope > .so-header__inner');
  const available = row.getBoundingClientRect().width;
  const compact = header.classList.contains('so-header--compact');
  header.classList.remove('so-header--compact');
  header.classList.add('so-header--measure');
  const needed = row.getBoundingClientRect().width;
  header.classList.remove('so-header--measure');
  if (compact) header.classList.add('so-header--compact');
  return needed <= available - 1;
})()`;

const MENU_LINKS = [...LABELS, 'Book a call'];
/** Two frames, or a tenth of a second where a headless engine holds frames back. */
const SETTLED = 'new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 100); })';

if (!ENGINES.length) describe.skip('the phone menu (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

describe.each(ENGINES)('the phone menu in %s', (engineName, engine) => {
  let browser: Browser;
  let script: string;
  let dir: string;
  const markup: Record<string, { head: string; body: string }> = {};
  const sites = {
    name: exportedSite(false),
    logo: exportedSite(true),
    ...(Object.fromEntries(THEMES.map((theme) => [theme, exportedSite(false, WIDE_BRAND, theme)])) as Record<(typeof THEMES)[number], ReturnType<typeof exportedSite>>),
    short: exportedSite(false, 'Studio North', 'foundation', SHORT_LABELS),
    medium: exportedSite(false, 'Studio North', 'foundation', MEDIUM_LABELS)
  };

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
        if (path.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: LOGO_SVG });
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
  /** The disclosure's own open state, which is what the browser announces. */
  const expanded = (page: Page) => page.evaluate<boolean>("document.querySelector('.so-header__menu').open");
  /** Which of the button's two icons shows, and whether it names the menu it controls. */
  const button = (page: Page) =>
    page.evaluate<{ bars: boolean; cross: boolean; controls: string | undefined }>(`(() => {
      const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
      const toggle = document.querySelector('.so-header__toggle');
      return { bars: shown('.so-header__icon-open'), cross: shown('.so-header__icon-close'), controls: document.getElementById(toggle.getAttribute('aria-controls'))?.tagName };
    })()`);
  const focus = async (page: Page) => (await page.evaluate(FOCUS)) as Focus | null;
  const tab = async (page: Page, shift = false) => {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    return focus(page);
  };
  /** The menu button as Chromium's accessibility tree exposes it to screen readers. */
  const announced = async (page: Page, context: BrowserContext) => {
    const cdp = await context.newCDPSession(page);
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.so-header__toggle' });
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const node = nodes[0];
      return { name: node.name?.value, expanded: node.properties?.find((p) => p.name === 'expanded')?.value.value, focusable: node.properties?.find((p) => p.name === 'focusable')?.value.value };
    } finally {
      await cdp.detach();
    }
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
          if (name === 'logo') await page.waitForFunction("document.querySelector('.so-header__brand img')?.complete");
          const { toggle, brand, logo, viewport } = (await page.evaluate(BOXES)) as { toggle: Box; brand: Box; logo: Box | null; viewport: number };
          const at = `${name} at ${width}px`;
          // The wordmark shows at the header's 34px logo height beside the name.
          if (name === 'logo' && (!logo || Math.round(logo.height) !== 34 || Math.round(logo.width) !== 136)) problems.push(`${at}: the logo shows as ${JSON.stringify(logo)}`);
          if (name === 'name' && logo) problems.push(`${at}: a logo shows`);
          if (Math.round(toggle.width) < 44 || Math.round(toggle.height) < 44) problems.push(`${at}: the button is ${toggle.width}×${toggle.height}`);
          if (toggle.right > viewport + 0.5) problems.push(`${at}: the button reaches ${toggle.right}px`);
          if (brand.right > toggle.left + 0.5) problems.push(`${at}: the brand (to ${brand.right}px) runs under the button (from ${toggle.left}px)`);
        });
    expect(problems).toEqual([]);
  }, 60_000);

  it('keeps a long name, ten links and the action in one tidy arrangement at every width in every theme, with or without scripts', async () => {
    const problems: string[] = [];
    const compactAt: Record<string, number[]> = {};
    for (const theme of THEMES)
      for (const scripts of ['now', 'off'] as const) {
        const at = `${theme}${scripts === 'off' ? ' without scripts' : ''}`;
        // Wider and then narrower again, on the same page, as a visitor resizes the window.
        await withSite(theme, { width: WIDTHS[0], height: 800 }, scripts, async (page) => {
          for (const width of [...WIDTHS, ...WIDTHS.slice(0, -1).reverse()]) {
            await page.setViewportSize({ width, height: 800 });
            // A page without scripts runs no frames or timers to wait for.
            if (scripts === 'now') await page.evaluate(SETTLED);
            const arrangement = (await page.evaluate(ARRANGEMENT)) as Arrangement;
            if (arrangement.compact) (compactAt[at] ??= []).push(width);
            const found = untidy(arrangement);
            if (found.length) problems.push(`${at} at ${width}px: ${found.join('; ')}`);
          }
        });
      }
    expect(problems).toEqual([]);
    // The content width caps the row, so a full menu beside a long name folds into the menu button at every width.
    expect(Object.keys(compactAt)).toHaveLength(THEMES.length * 2);
    for (const [at, widths] of Object.entries(compactAt)) expect(widths.length, at).toBe(WIDTHS.length * 2 - 1);

    // There the menu holds every link and the action, one under another.
    for (const theme of THEMES)
      await withSite(theme, { width: 1280, height: 900 }, 'now', async (page) => {
        await page.locator('.so-header__toggle').click();
        await expect.poll(() => menuOpen(page)).toBe(true);
        const shown = (await page.evaluate(`[...document.querySelectorAll('#so-site-nav ul a, #so-site-nav .so-header__cta')].map((a) => {
          const b = a.getBoundingClientRect();
          return { text: a.textContent.trim(), top: b.top, left: b.left, visible: b.width > 0 && b.height > 0 };
        })`)) as Array<{ text: string; top: number; left: number; visible: boolean }>;
        expect(shown.map((l) => l.text), theme).toEqual(MENU_LINKS);
        expect(shown.every((l) => l.visible), theme).toBe(true);
        for (let i = 1; i < shown.length; i++) expect(shown[i].top, `${theme}: ${shown[i].text} below ${shown[i - 1].text}`).toBeGreaterThan(shown[i - 1].top);
        expect(new Set(shown.slice(0, LABELS.length).map((l) => Math.round(l.left))).size, `${theme}: links in one column`).toBe(1);
      });
  }, 150_000);

  it('folds a menu that fits only on wide screens into the menu button as the window narrows, and back out as it widens', async () => {
    await withSite('medium', { width: 1280, height: 800 }, 'now', async (page) => {
      const seen: Array<[number, boolean]> = [];
      const crowded: Array<[number, boolean]> = [];
      for (const width of [1280, 900, 768, 1024, 1440, 820, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(SETTLED);
        const arrangement = (await page.evaluate(ARRANGEMENT)) as Arrangement;
        expect(untidy(arrangement), `${width}px`).toEqual([]);
        seen.push([width, arrangement.compact]);
        crowded.push([width, !(await page.evaluate(ROW_FITS))]);
      }
      // Folded exactly where the row cannot hold the menu on one line.
      expect(seen).toEqual(crowded);
      // At 1024px that depends on the system font the site falls back to here: the menu needs about 1050px in San
      // Francisco (macOS) and 1010px in Segoe UI (Windows). Elsewhere it does not.
      expect(seen.filter(([width]) => width !== 1024)).toEqual([
        [1280, false],
        [900, true],
        [768, true],
        [1440, false],
        [820, true],
        [1280, false]
      ]);
      // Opened while folded, the menu stays open as the window widens, with focus on one of its links. Escape
      // closes it and returns focus to the menu button, which stays while it has focus (the row would hide it); once
      // focus moves on, the row takes over.
      await page.setViewportSize({ width: 900, height: 800 });
      await page.evaluate(SETTLED);
      await page.locator('.so-header__toggle').click();
      await expect.poll(() => menuOpen(page)).toBe(true);
      await page.locator('#so-site-nav ul a').first().focus();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(SETTLED);
      expect(((await page.evaluate(ARRANGEMENT)) as Arrangement).compact, 'open menu kept').toBe(true);
      expect(await menuOpen(page)).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => menuOpen(page)).toBe(false);
      expect((await focus(page))?.toggle).toBe(true);
      await page.evaluate(SETTLED);
      expect(((await page.evaluate(ARRANGEMENT)) as Arrangement).compact, 'the focused menu button kept').toBe(true);
      await tab(page);
      await expect.poll(async () => ((await page.evaluate(ARRANGEMENT)) as Arrangement).compact).toBe(false);
      expect(untidy((await page.evaluate(ARRANGEMENT)) as Arrangement)).toEqual([]);

      // A link in the row with focus keeps the row as the window narrows, until focus moves on.
      await page.locator('#so-site-nav ul a').nth(3).focus();
      await page.setViewportSize({ width: 900, height: 800 });
      await page.evaluate(SETTLED);
      expect(((await page.evaluate(ARRANGEMENT)) as Arrangement).compact, 'focused link kept').toBe(false);
      expect((await focus(page))?.text).toBe(MEDIUM_LABELS[3]);
      await page.evaluate("document.querySelector('main a[href]').focus()");
      await expect.poll(async () => ((await page.evaluate(ARRANGEMENT)) as Arrangement).compact).toBe(true);
    });
  }, 60_000);

  it('folds the menu away and back out when only the links’ type changes, as styling the Menu links part does (#1492)', async () => {
    await withSite('medium', { width: 1280, height: 800 }, 'now', async (page) => {
      const compact = async () => ((await page.evaluate(ARRANGEMENT)) as Arrangement).compact;
      await page.evaluate(SETTLED);
      expect(await compact()).toBe(false);
      // The editor's preview swaps the site's stylesheet in place: the window keeps its width, and no text changes.
      const restyle = (css: string) =>
        page.evaluate(`(() => { let el = document.getElementById('so-edit'); if (!el) { el = document.createElement('style'); el.id = 'so-edit'; document.head.append(el); } el.textContent = ${JSON.stringify(css)}; })()`);
      await restyle('.so-header__link { letter-spacing: 0.4em !important; }');
      await expect.poll(compact).toBe(true);
      expect(await page.evaluate(ROW_FITS)).toBe(false);
      await restyle('');
      await expect.poll(compact).toBe(false);
      expect(untidy((await page.evaluate(ARRANGEMENT)) as Arrangement)).toEqual([]);
      // A stylesheet that arrives after it joins the page: the header measures again once it has loaded.
      await restyle('.so-header__link { letter-spacing: 0.4em !important; }');
      await expect.poll(compact).toBe(true);
      let release = () => {};
      const held = new Promise<void>((done) => (release = done));
      await page.route(`${ORIGIN}/late.css`, async (route) => {
        await held;
        await route.fulfill({ contentType: 'text/css', body: '.so-header__link { letter-spacing: normal !important; }' });
      });
      await page.evaluate(`(() => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/late.css'; document.head.append(link); })()`);
      await page.evaluate(SETTLED);
      expect(await compact()).toBe(true);
      release();
      await expect.poll(compact).toBe(false);
    });
  }, 60_000);

  // Chromium only: a headless WebKit lays type sized to the window out at the new width a while after a resize, later
  // than anything a test can wait on, though the header settles there in the end.
  it.skipIf(engineName === 'webkit')('folds the menu as links sized to the window grow and shrink, while the row stays at its widest (#1492)', async () => {
    await withSite('medium', { width: 1920, height: 800 }, 'now', async (page) => {
      await page.evaluate(`(() => { const el = document.createElement('style'); el.textContent = '.so-header__link { font-size: 1.15vw !important; }'; document.head.append(el); })()`);
      const seen: Array<[number, boolean]> = [];
      const rows = new Set<number>();
      for (const width of [1920, 1600, 2400, 1600, 1920]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(SETTLED);
        // Folded exactly where the row cannot hold the menu on one line.
        const crowded = !(await page.evaluate(ROW_FITS));
        await page.waitForFunction(`document.querySelector('header.so-header').classList.contains('so-header--compact') === ${crowded}`);
        const arrangement = (await page.evaluate(ARRANGEMENT)) as Arrangement;
        rows.add(Math.round(arrangement.inner.width));
        expect(arrangement.compact, `${width}px`).toBe(crowded);
        seen.push([width, arrangement.compact]);
      }
      // The row is as wide at every one of these widths, so only the links' own size decides.
      expect(rows.size).toBe(1);
      expect(new Set(seen.map(([, compact]) => compact))).toEqual(new Set([true, false]));
    });
  }, 60_000);

  it('shows a short menu in the row beside the name at every width above a phone, from the first paint', async () => {
    for (const scripts of ['now', 'off'] as const)
      await withSite('short', { width: WIDTHS[0], height: 800 }, scripts, async (page) => {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          if (scripts === 'now') await page.evaluate(SETTLED);
          const arrangement = (await page.evaluate(ARRANGEMENT)) as Arrangement;
          expect(arrangement.compact, `${width}px${scripts === 'off' ? ' without scripts' : ''}`).toBe(false);
          expect(untidy(arrangement)).toEqual([]);
        }
      });
  }, 60_000);

  it('opens the menu by touch and by keyboard when the browser runs no scripts', async () => {
    await withSite('name', { width: 390, height: 844 }, 'off', async (page) => {
      expect(await menuOpen(page)).toBe(false);
      expect(await button(page)).toEqual({ bars: true, cross: false, controls: 'NAV' });
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      expect(await button(page)).toEqual({ bars: false, cross: true, controls: 'NAV' });
      const last = '#so-site-nav .so-header__cta';
      expect(await page.evaluate(tappable(last)), 'Book a call can be tapped').toBe(true);
      for (const label of LABELS) expect(await page.locator('#so-site-nav ul a', { hasText: label }).first().isVisible(), label).toBe(true);
      // Tapping the button again folds the menu away.
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(false);
    });
    if (engineName !== 'chromium') return;
    await withSite('name', { width: 390, height: 844 }, 'off', async (page, _start, context) => {
      expect(await announced(page, context)).toEqual({ name: 'Menu', expanded: false, focusable: true });
      await tabToToggle(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => menuOpen(page)).toBe(true);
      expect(await announced(page, context)).toEqual({ name: 'Menu', expanded: true, focusable: true });
      const reached: string[] = [];
      for (let i = 0; i < MENU_LINKS.length; i++) reached.push((await tab(page))?.text ?? '');
      expect(reached).toEqual(MENU_LINKS);
    });
  }, 60_000);

  it('keeps a menu opened before the script starts, then closes it by Escape, a press outside, a link or a navigation', async () => {
    await withSite('name', { width: 390, height: 844 }, 'late', async (page, start) => {
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      await page.locator('#so-site-nav ul a').first().focus();
      await page.evaluate("window.servedMenu = document.querySelector('.so-header__menu')");
      await start();
      await page.evaluate(SETTLED);
      expect(await page.evaluate("window.servedMenu === document.querySelector('.so-header__menu')"), 'the script takes over the served menu').toBe(true);
      expect(await expanded(page), 'still open once the script runs').toBe(true);
      expect(await page.evaluate(tappable('#so-site-nav .so-header__cta'))).toBe(true);
      expect((await focus(page))?.text, 'focus stays on the link it was on').toBe('Home');

      // Escape from a menu link, or from nowhere, returns focus to the button.
      await page.keyboard.press('Escape');
      await expect.poll(() => expanded(page)).toBe(false);
      expect(await menuOpen(page)).toBe(false);
      expect((await focus(page))?.toggle, 'Escape returns to the menu button').toBe(true);
      await page.evaluate("document.activeElement.blur(); document.querySelector('.so-header__toggle').click()");
      expect(await expanded(page)).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => expanded(page)).toBe(false);
      expect((await focus(page))?.toggle, 'Escape from nowhere returns to the menu button').toBe(true);
      // With the menu closed, Escape leaves focus alone.
      await page.locator('.so-header__brand').focus();
      await page.keyboard.press('Escape');
      expect((await focus(page))?.text).toBe(BRAND);
      // Escape while focus is on the page closes the menu and leaves focus there.
      await page.evaluate("document.querySelector('main a[href]').focus(); document.querySelector('.so-header__toggle').click()");
      const onPage = await focus(page);
      expect(onPage?.inHeader).toBe(false);
      expect(await expanded(page)).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => expanded(page)).toBe(false);
      expect(await focus(page), 'Escape leaves focus on the page').toEqual(onPage);

      // A press inside the menu keeps it open; one outside the header closes it.
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => expanded(page)).toBe(true);
      await page.locator('#so-site-nav ul').dispatchEvent('pointerdown');
      expect(await expanded(page), 'a press in the menu').toBe(true);
      await page.locator('main').dispatchEvent('pointerdown');
      expect(await expanded(page), 'a press on the page').toBe(false);

      // Choosing a link closes it (the navigation itself is held back here), and so does arriving on another page.
      await page.evaluate("document.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); }, true)");
      for (const link of ['#so-site-nav ul li:nth-child(4) a', '#so-site-nav .so-header__cta']) {
        await page.locator('.so-header__toggle').tap();
        await expect.poll(() => expanded(page)).toBe(true);
        await page.locator(link).click();
        expect(await expanded(page), `after choosing ${link}`).toBe(false);
      }
      for (const type of ['link', 'goto', 'popstate']) {
        await page.locator('.so-header__toggle').tap();
        await expect.poll(() => expanded(page)).toBe(true);
        await page.evaluate(`navigated(${JSON.stringify(type)})`);
        expect(await expanded(page), `after a ${type} navigation`).toBe(false);
      }
    });
  }, 60_000);

  it('folds away a menu that focus left for the page before the script started, leaving focus there', async () => {
    await withSite('name', { width: 390, height: 844 }, 'late', async (page, start) => {
      await page.locator('.so-header__toggle').tap();
      await expect.poll(() => menuOpen(page)).toBe(true);
      await page.locator('main a[href]').first().focus();
      const left = await focus(page);
      expect(left?.inHeader).toBe(false);
      expect(await expanded(page), 'nothing closes it before the script runs').toBe(true);
      await start();
      await expect.poll(() => expanded(page)).toBe(false);
      expect(await focus(page)).toEqual(left);
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

      // Opening it and moving focus out in the same task, before the browser reports the toggle, closes it at once.
      const sameTask = await page.evaluate(`(() => {
        document.querySelector('.so-header__toggle').click();
        const opened = document.querySelector('.so-header__menu').open;
        document.querySelector('main a[href]').focus();
        return { opened, closed: !document.querySelector('.so-header__menu').open };
      })()`);
      expect(sameTask).toEqual({ opened: true, closed: true });
      await page.evaluate(SETTLED);
      expect(await menuOpen(page), 'still closed once the toggle is reported').toBe(false);
      expect((await focus(page))?.inHeader).toBe(false);
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

      // A wheel over the menu scrolls the menu, not the page, until Book a call can be tapped. Each turn stays
      // within the menu's own scroll range, so none of it carries on to the page.
      const room = () => page.evaluate<number>("(() => { const n = document.getElementById('so-site-nav'); return n.scrollHeight - n.clientHeight - n.scrollTop; })()");
      await page.mouse.move(nav.x + nav.width / 2, nav.y + nav.height / 2);
      for (let i = 0; i < 30 && !(await page.evaluate(tappable(last))); i++) {
        const left = await room();
        if (left < 1) break;
        await page.mouse.wheel(0, Math.min(60, Math.floor(left)));
        await expect.poll(room).toBeLessThan(left);
      }
      await expect.poll(() => page.evaluate(tappable(last)), { message: 'Book a call scrolled into reach' }).toBe(true);
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
      await page.evaluate(SETTLED);
      await tabToToggle(page);
      await page.keyboard.press('Enter');
      await expect.poll(() => menuOpen(page)).toBe(true);
      const nav = (await page.locator('#so-site-nav').boundingBox())!;
      expect(nav.y + nav.height).toBeLessThanOrEqual(375.5);
      for (let i = 0; i < MENU_LINKS.length; i++) await tab(page);
      expect((await focus(page))?.text).toBe('Book a call');
      await expect.poll(() => page.evaluate(tappable('#so-site-nav .so-header__cta')), { message: 'focused Book a call is on screen' }).toBe(true);
    });
  }, 60_000);
});
