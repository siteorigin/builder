/**
 * Visitor light and dark palettes (issue #389) in real headless browsers: the Home page of a site in each mode as the
 * exported site prerenders it (its generated layout and route compiled for the server and rendered, head included),
 * its generated stylesheets, and the generated Light/Dark switch started as the layout starts it. Checks what a
 * visitor sees: one palette whatever the device, the device's palette, the switch and the choice it remembers, a
 * remembered choice applied before any of the site's own script runs, and the light palette in print.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { chromium, webkit, type Browser, type BrowserContextOptions, type BrowserType, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ColorSchemeMode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { STYLES_DIR, effectiveTokens, generateProject, pageFile } from '@generator/index';
import { themeStorageKey, themeToggleJs } from '@generator/color-scheme';
import { contrastBetween } from '@shared/contrast';
import { parseColor } from '@shared/color';

const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));
const GEN = '\0gen:';
const ORIGIN = 'https://site.test';

/**
 * The page's head and body as the exported site prerenders them (the layout around the Home page), and the scoped
 * styles of the components it renders, which the site's build would put in its stylesheet.
 */
async function renderHome(files: Map<string, string>, route: string): Promise<{ head: string; body: string; scoped: string }> {
  const scoped: string[] = [];
  const entry = `export { render } from 'svelte/server';\nexport { createRawSnippet } from 'svelte';\nexport { default as Layout } from ${JSON.stringify(GEN + 'src/routes/+layout.svelte')};\nexport { default as Page } from ${JSON.stringify(GEN + route)};`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-route',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          if (id === '\0$app/state') return "export const page = { route: { id: '/' }, url: new URL('https://site.test/') };";
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          // The stylesheets go in the page whole (see open()); the layout's imports of them are left out here.
          if (path.endsWith('.css')) return { code: '', moduleType: 'js' };
          const source = files.get(path)!;
          if (!path.endsWith('.svelte')) return { code: source, moduleType: 'js' };
          const compiled = compile(source, { filename: path, generate: 'server', runes: true, css: 'external' });
          if (compiled.css?.code) scoped.push(compiled.css.code);
          return { code: compiled.js.code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The route did not bundle');
  const dir = mkdtempSync(join(tmpdir(), 'so-scheme-route-'));
  try {
    const file = join(dir, 'route.mjs');
    writeFileSync(file, chunk.code);
    type Rendered = { head: string; body: string };
    const mod = (await import(pathToFileURL(file).href)) as { render: (c: unknown, o: { props: Record<string, unknown> }) => Rendered; createRawSnippet: (f: () => { render: () => string }) => unknown; Layout: unknown; Page: unknown };
    const page = mod.render(mod.Page, { props: {} }).body;
    const children = mod.createRawSnippet(() => ({ render: () => `<div>${page}</div>` }));
    const r = mod.render(mod.Layout, { props: { children } });
    const clean = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');
    return { head: clean(r.head), body: clean(r.body), scoped: scoped.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Site {
  state: ProjectState;
  head: string;
  body: string;
  css: string;
  /** The palettes' page and text colours, as #rrggbb. */
  light: { background: string; text: string; inverse: string; onInverse: string };
  dark: { background: string; text: string };
}

const sites = {} as Record<ColorSchemeMode, Site>;

const hexOf = (s: ProjectState, scheme: 'light' | 'dark', id: string) => {
  const v = effectiveTokens(s, scheme).find((t) => t.id === id)?.value;
  const c = typeof v === 'string' ? parseColor(v) : null;
  if (!c) throw new Error(`${id} has no plain color`);
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
};

beforeAll(async () => {
  const base = createStarterState('business', 'Palette Studio', false);
  for (const mode of ['single', 'system', 'toggle'] as const) {
    const state = mode === 'single' ? base : applyOperations(base, [{ type: 'token.setColorScheme', mode }]).state;
    const files = generateProject(state);
    const { head, body, scoped } = await renderHome(files, pageFile(state.pages[state.site.homePageId]));
    sites[mode] = {
      state,
      head,
      body,
      css: [...['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? ''), scoped].join('\n'),
      light: { background: hexOf(state, 'light', 'color.background'), text: hexOf(state, 'light', 'color.text'), inverse: hexOf(state, 'light', 'color.inverse'), onInverse: hexOf(state, 'light', 'color.on-inverse') },
      dark: { background: hexOf(state, 'dark', 'color.background'), text: hexOf(state, 'dark', 'color.text') }
    };
  }
}, 120_000);

if (!ENGINES.length) describe.skip('visitor palettes in a browser (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

/*
 * What runs in the page is written as source, as in appear-browser.test.ts: these tests compile without the DOM's types.
 */
type Colors = { background: string; text: string; theme: string | null; scheme: string };
const COLORS = `(() => { const cs = getComputedStyle(document.body); return { background: cs.backgroundColor, text: cs.color, theme: document.documentElement.getAttribute('data-so-theme'), scheme: getComputedStyle(document.documentElement).colorScheme }; })()`;
type Toggle = { count: number; pressed: string | null; label: string | null; inHeader: boolean; shown: boolean };
const TOGGLE = `(() => { const all = document.querySelectorAll('.so-theme-toggle'); const b = all[0]; return { count: all.length, pressed: b ? b.getAttribute('aria-pressed') : null, label: b ? b.getAttribute('aria-label') : null, inHeader: !!b && !!b.closest('header.so-header'), shown: !!b && getComputedStyle(b).display !== 'none' }; })()`;
/** The footer (a dark band in every palette): its background and text colour. */
const FOOTER = `(() => { const f = document.querySelector('footer'); const cs = getComputedStyle(f); return { background: cs.backgroundColor, text: cs.color }; })()`;

describe.each(ENGINES)('visitor palettes in %s', { timeout: 30_000 }, (name, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * The site's Home page at its own origin, so the browser keeps what the switch remembers. `script` starts the
   * switch as the layout does once the page's script runs; without it the page is as it arrives, before any script
   * of the site's own. `stored` is what the browser remembers from an earlier visit.
   */
  async function open(mode: ColorSchemeMode, options: BrowserContextOptions & { script?: boolean; stored?: string; noStorage?: boolean } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
    const { script = true, stored, noStorage, ...contextOptions } = options;
    const site = sites[mode];
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light', ...contextOptions });
    if (noStorage) await context.addInitScript(`Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage is turned off', 'SecurityError'); } });`);
    const key = themeStorageKey(site.state);
    if (!noStorage && stored) await context.addInitScript(`try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(stored)}); sessionStorage.setItem('seeded', '1'); } } catch {}`);
    const run = script && mode === 'toggle' ? `<script type="module">${themeToggleJs(key)}\nwindow.__stop = startThemeToggle(() => 'Dark mode');\nwindow.__ready = true;</script>` : '';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${site.head}<style>${site.css}</style></head><body>${site.body}${run}</body></html>`;
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    if (run) await page.waitForFunction('window.__ready === true');
    return { page, close: () => context.close() };
  }
  const colors = (page: Page) => page.evaluate<Colors>(COLORS);
  const toggle = (page: Page) => page.evaluate<Toggle>(TOGGLE);

  it('shows a site with one palette in it whatever the device asks for, with nothing added', async () => {
    const site = sites.single;
    expect(site.head).not.toContain('localStorage');
    expect(site.css).not.toContain('prefers-color-scheme');
    const { page, close } = await open('single', { colorScheme: 'dark' });
    try {
      expect(await colors(page)).toMatchObject({ background: site.light.background, text: site.light.text, theme: null, scheme: 'normal' });
      expect((await toggle(page)).count).toBe(0);
    } finally {
      await close();
    }
  });

  it('follows the device for a site that has a dark palette, without a switch', async () => {
    const site = sites.system;
    expect(site.head).not.toContain('localStorage');
    const dark = await open('system', { colorScheme: 'dark' });
    try {
      expect(await colors(dark.page)).toMatchObject({ background: site.dark.background, text: site.dark.text, scheme: 'dark' });
      expect((await toggle(dark.page)).count).toBe(0);
      // The device changes its mind: so does the page.
      await dark.page.emulateMedia({ colorScheme: 'light' });
      expect(await colors(dark.page)).toMatchObject({ background: site.light.background, text: site.light.text, scheme: 'light' });
    } finally {
      await dark.close();
    }
  });

  it('puts a switch in the header that changes the palette, and keeps the choice for the next page', async () => {
    const site = sites.toggle;
    const { page, close } = await open('toggle');
    try {
      expect(await colors(page)).toMatchObject({ background: site.light.background, theme: null });
      expect(await toggle(page)).toEqual({ count: 1, pressed: 'false', label: 'Dark mode', inHeader: true, shown: true });
      await page.click('.so-theme-toggle');
      expect(await colors(page)).toMatchObject({ background: site.dark.background, text: site.dark.text, theme: 'dark' });
      expect((await toggle(page)).pressed).toBe('true');
      expect(await page.evaluate(`localStorage.getItem(${JSON.stringify(themeStorageKey(site.state))})`)).toBe('dark');
      // From the keyboard too.
      await page.focus('.so-theme-toggle');
      await page.keyboard.press('Enter');
      expect(await colors(page)).toMatchObject({ background: site.light.background, theme: 'light' });
      expect(await page.evaluate(`localStorage.getItem(${JSON.stringify(themeStorageKey(site.state))})`)).toBe('light');
      await page.keyboard.press('Space');
      expect((await toggle(page)).pressed).toBe('true');
      // A header drawn afresh gets the switch back.
      await page.evaluate(`(() => { const h = document.querySelector('header.so-header'); const fresh = h.cloneNode(true); fresh.querySelector('.so-theme-toggle').remove(); h.replaceWith(fresh); })()`);
      await page.waitForFunction(`!!document.querySelector('header.so-header .so-theme-toggle')`);
      expect((await toggle(page)).count).toBe(1);
      await page.evaluate('window.__stop()');
      expect((await toggle(page)).count).toBe(0);
    } finally {
      await close();
    }
  });

  it('in the editor, asks the canvas for the other palette instead of switching or remembering', async () => {
    const site = sites.toggle;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      const run = `<script type="module">window.__siteoriginBridge = true; window.__asked = []; addEventListener('siteorigin:color-scheme', (e) => window.__asked.push(e.detail));\n${themeToggleJs('k', true)}\nstartThemeToggle(() => 'Dark mode');\nwindow.__ready = true;</script>`;
      await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${site.css}</style></head><body>${site.body}${run}</body></html>` }));
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('window.__ready === true');
      await page.click('.so-theme-toggle');
      expect(await page.evaluate('window.__asked')).toEqual(['dark']);
      expect(await colors(page)).toMatchObject({ background: site.light.background, theme: null });
      // The canvas switches its frame to dark: the page and the switch follow.
      await page.emulateMedia({ colorScheme: 'dark' });
      expect(await colors(page)).toMatchObject({ background: site.dark.background, theme: null });
      await page.waitForFunction(`document.querySelector('.so-theme-toggle').getAttribute('aria-pressed') === 'true'`);
      expect(await page.evaluate('localStorage.length')).toBe(0);
    } finally {
      await context.close();
    }
  });

  it('applies a remembered choice before the page is drawn, against the device either way', async () => {
    const site = sites.toggle;
    expect(site.head).toMatch(/^<script>try\{var c=localStorage/);
    const dark = await open('toggle', { script: false, stored: 'dark', colorScheme: 'light' });
    try {
      expect(await colors(dark.page)).toMatchObject({ background: site.dark.background, text: site.dark.text, theme: 'dark' });
    } finally {
      await dark.close();
    }
    const light = await open('toggle', { script: false, stored: 'light', colorScheme: 'dark' });
    try {
      expect(await colors(light.page)).toMatchObject({ background: site.light.background, text: site.light.text, theme: 'light' });
    } finally {
      await light.close();
    }
    // Something else remembered there leaves the device in charge.
    const junk = await open('toggle', { script: false, stored: 'sepia', colorScheme: 'dark' });
    try {
      expect(await colors(junk.page)).toMatchObject({ background: site.dark.background, theme: null });
    } finally {
      await junk.close();
    }
  });

  it('follows the device, and switches for the page, when the browser keeps nothing', async () => {
    const site = sites.toggle;
    const { page, close } = await open('toggle', { noStorage: true, colorScheme: 'dark' });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      expect(await colors(page)).toMatchObject({ background: site.dark.background, theme: null });
      expect((await toggle(page)).pressed).toBe('true');
      await page.click('.so-theme-toggle');
      expect(await colors(page)).toMatchObject({ background: site.light.background, theme: 'light' });
      expect((await toggle(page)).pressed).toBe('false');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  it('prints in the light palette, dark bands still legible and the switch left out, whatever was chosen', async () => {
    for (const [mode, stored] of [['system', undefined], ['toggle', 'dark'], ['toggle', undefined]] as const) {
      const site = sites[mode];
      const { page, close } = await open(mode, { colorScheme: 'dark', stored });
      try {
        expect((await colors(page)).background).toBe(site.dark.background);
        await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
        expect(await colors(page), mode).toMatchObject({ background: site.light.background, text: site.light.text, scheme: 'light' });
        const footer = await page.evaluate<{ background: string; text: string }>(FOOTER);
        expect(footer).toEqual({ background: site.light.inverse, text: site.light.onInverse });
        const rgb = (c: string) => parseColor(c)!;
        expect(contrastBetween(rgb(footer.background), rgb(footer.text))).toBeGreaterThanOrEqual(4.5);
        if (mode === 'toggle') expect((await toggle(page)).shown).toBe(false);
        // Back on screen, the visitor's palette again.
        await page.emulateMedia({ media: 'screen' });
        expect((await colors(page)).background).toBe(site.dark.background);
      } finally {
        await close();
      }
    }
  });

  it(`keeps the switch in reach on a phone (${name})`, async () => {
    const { page, close } = await open('toggle', { viewport: { width: 390, height: 800 } });
    try {
      const box = await page.evaluate<{ w: number; h: number; right: number; menuLeft: number }>(
        `(() => { const b = document.querySelector('.so-theme-toggle').getBoundingClientRect(); const m = document.querySelector('.so-header__menu').getBoundingClientRect(); return { w: b.width, h: b.height, right: b.right, menuLeft: m.left }; })()`
      );
      expect(box.w).toBeGreaterThanOrEqual(44);
      expect(box.h).toBeGreaterThanOrEqual(44);
      // Just before the menu button, never under it.
      expect(box.right).toBeLessThanOrEqual(box.menuLeft + 1);
      expect(box.right - box.w).toBeGreaterThanOrEqual(0);
      await page.click('.so-theme-toggle');
      expect((await toggle(page)).pressed).toBe('true');
    } finally {
      await close();
    }
  });
});
