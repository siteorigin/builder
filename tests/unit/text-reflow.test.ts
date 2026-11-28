/**
 * Stock Foundation sections as a visitor who enlarges their browser's default text size sees them, in a real
 * headless browser: the generated layout, pages and theme CSS exactly as an exported site ships them, compiled
 * for the client and mounted on a stand-in page. The default font size is the browser preference a visitor
 * sets, not a CSS override, and fonts fall back to the system stack.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LinkValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://site.test';
const PHONES = [320, 390];
const WIDER = [600, 768, 1024, 1280];
const TEXT_SIZES = [16, 32];

/** Each page holds the stock sections with their default copy, on its own and together. */
const CASES: Record<string, string[]> = {
  centered: ['hero.centered'],
  split: ['hero.split'],
  contact: ['contact.details'],
  together: ['hero.centered', 'hero.split', 'contact.details']
};

/** The exported site's files and its stylesheets, in the order the layout imports them. */
function exportedSite(components: string[]) {
  const s = createStarterState('business', 'Test Studio', false);
  const [homeId, aboutId, contactId] = s.site.pageOrder;
  const page = (target: string): LinkValue => ({ type: 'page', target });
  const home = s.pages[homeId];
  home.rootIds = [];
  home.nodes = {};
  for (const id of components) {
    // Default copy; the hero buttons get destinations, so they are links a keyboard can reach.
    const links = id.startsWith('hero.') ? { primaryLink: page(contactId), secondaryLink: page(aboutId) } : {};
    const node = makeInstance(s.components[installComponent(s, id)], links);
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
  }
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css };
}

/**
 * Every case's layout and home page as one script that defines `window.mountCase(name)`, and the components' own
 * styles, which an exported site's build writes to stylesheets the page loads before it shows anything. Injected by
 * the script instead, they arrive after the first measurement: the theme's sections are code components, and their
 * look is in those styles.
 */
async function bundleSites(sites: Record<string, Map<string, string>>): Promise<{ script: string; css: string }> {
  const src = new Map<string, string>();
  const styles = new Map<string, string>();
  for (const [name, files] of Object.entries(sites)) {
    for (const [path, text] of files) src.set(`\0site/${name}/${path}`, text);
    src.set(`\0site/${name}/Entry.svelte`, `<script>import Layout from './src/routes/+layout.svelte'; import Page from './src/routes/+page.svelte';</script><Layout><Page /></Layout>`);
  }
  const names = Object.keys(sites);
  const entry = [
    "import { mount } from 'svelte';",
    ...names.map((n, i) => `import E${i} from '\0site/${n}/Entry.svelte';`),
    `const all = { ${names.map((n, i) => `${JSON.stringify(n)}: E${i}`).join(', ')} };`,
    "window.mountCase = (name) => mount(all[name], { target: document.getElementById('app') });"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'exported-site',
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
          if (id === '\0$app/paths') return 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;';
          if (id === '\0$app/state') return 'export const page = { route: { id: "/" }, url: new URL("https://site.test/") };';
          // The layout's draft keeper registers a snapshot; these pages are never left, so it is never captured.
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const onNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
          const text = src.get(id);
          if (text === undefined) return null;
          if (!id.endsWith('.svelte')) return text;
          const compiled = compile(text, { filename: id.slice(1), generate: 'client', css: 'external' });
          if (compiled.css) styles.set(id, compiled.css.code);
          return compiled.js.code;
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return { script: chunk.code, css: [...styles.values()].join('\n') };
}

interface Layout {
  scrollWidth: number;
  viewportWidth: number;
  /** Rendered elements and lines of text that reach past either side of the viewport. */
  outside: string[];
  /** Lines of text that spill out of the box they belong to. */
  spills: string[];
  /** Boxes that cut off their own content, or make it scroll sideways. */
  clipped: string[];
  /** The page cannot be scrolled the ordinary way. */
  blocksScroll: boolean;
  /** The skip link shows before it is focused. */
  skipLinkShows: boolean;
}

// Runs in the browser, so it is passed as text (the Node project has no DOM types). Deliberately hidden content
// (the visually hidden utility, the off-screen spam trap, the draft keeper's screen-reader-only live region) is left out.
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const hidden = (el) => !!el.closest('.so-visually-hidden, .so-form__trap, .so-draft-announce, script, style');
  const name = (el) => (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName.toLowerCase());
  const past = (b) => b.left < -0.5 || b.right > vw + 0.5;
  const cuts = (v) => v === 'hidden' || v === 'clip';
  const outside = [];
  const spills = [];
  const clipped = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (hidden(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && past(b)) outside.push(name(el) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
    const style = getComputedStyle(el);
    const wide = el.scrollWidth > el.clientWidth + 1;
    if ((style.overflowX !== 'visible' && wide) || (cuts(style.overflowY) && el.scrollHeight > el.clientHeight + 1))
      clipped.push(name(el) + ' ' + el.scrollWidth + 'x' + el.scrollHeight + ' in ' + el.clientWidth + 'x' + el.clientHeight);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) {
    const text = node.textContent.trim();
    if (!text || hidden(node.parentElement)) continue;
    let box = node.parentElement;
    while (box.parentElement && getComputedStyle(box).display === 'inline') box = box.parentElement;
    const own = box.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      if (!line.width) continue;
      const label = '"' + text.slice(0, 40) + '" ' + Math.round(line.left) + '..' + Math.round(line.right);
      if (past(line)) outside.push(label);
      else if (line.left < own.left - 1 || line.right > own.right + 1) spills.push(label + ' in ' + name(box) + ' ' + Math.round(own.left) + '..' + Math.round(own.right));
    }
  }
  const blocks = (el) => cuts(getComputedStyle(el).overflowX) || cuts(getComputedStyle(el).overflowY);
  const skip = document.querySelector('.so-skip-link');
  return {
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: vw,
    outside: [...new Set(outside)],
    spills: [...new Set(spills)],
    clipped: [...new Set(clipped)],
    blocksScroll: blocks(document.documentElement) || blocks(document.body),
    skipLinkShows: !!skip && document.activeElement !== skip && skip.getBoundingClientRect().bottom > 0
  };
})()`;

/**
 * The sections of the page that holds them all, in order, by the name the focus checks give them. Foundation's
 * sections are code components, whose markup names no component, so a section is told by its place on the page.
 */
const TOGETHER = CASES.together.map((id) => id.replace('.', '-'));
/** The element of the `together` page's section with this component ID that a selector inside it finds. */
const inSection = (componentId: string, selector: string) => `main > :nth-child(${CASES.together.indexOf(componentId) + 1}) ${selector}`;

/**
 * The focused element: its text, destination, the section it sits in, where it is on screen, and whether Tab has
 * been here before (marked on the element, so a repeated label elsewhere is not mistaken for wrapping round).
 */
const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const seen = el.hasAttribute('data-test-focused');
  el.setAttribute('data-test-focused', '');
  const main = document.querySelector('main');
  const top = [...(main?.children ?? [])].find((c) => c.contains(el));
  const section = el.closest('header') ? 'header' : el.closest('footer') ? 'shell-footer' : top ? (${JSON.stringify(TOGETHER)}[[...main.children].indexOf(top)] ?? '') : '';
  const b = el.getBoundingClientRect();
  return { seen, section, text: el.textContent.trim(), href: el.getAttribute('href'), left: b.left, right: b.right, top: b.top, bottom: b.bottom, vw: document.documentElement.clientWidth, vh: innerHeight };
})()`;

interface Focused {
  seen: boolean;
  section: string;
  text: string;
  href: string | null;
  left: number;
  right: number;
  top: number;
  bottom: number;
  vw: number;
  vh: number;
}

const onScreen = (f: Focused) => f.left >= -0.5 && f.right <= f.vw + 0.5 && f.top >= -0.5 && f.bottom <= f.vh + 0.5;
const describeFocus = (f: Focused) => `${f.section}: ${f.text} (${f.href}) at ${Math.round(f.left)},${Math.round(f.top)}..${Math.round(f.right)},${Math.round(f.bottom)} in ${f.vw}×${f.vh}`;

describe.skipIf(!browserInstalled)('Foundation pages with enlarged text', () => {
  let browser: Browser;
  let script: string;
  let componentCss: string;
  const sites = Object.fromEntries(Object.entries(CASES).map(([name, components]) => [name, exportedSite(components)]));

  beforeAll(async () => {
    // Settled separately, so a browser that launched is still closed when the bundle fails.
    const [bundled, launched] = await Promise.allSettled([
      bundleSites(Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, site.files]))),
      chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 })
    ]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    ({ script, css: componentCss } = bundled.value);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Opens one case at a size, with the browser's default font size set the way a visitor sets it. */
  async function withPage(name: string, size: { width: number; height?: number }, fontSize: number, body: (page: Page) => Promise<void>) {
    // Reduced motion turns off the theme's smooth scrolling, so the scroll Tab starts has finished when focus is measured.
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height ?? 800 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(10_000);
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: fontSize, fixed: Math.round((fontSize * 13) / 16) } });
      await page.route(`${ORIGIN}/**`, (route) => {
        if (new URL(route.request().url()).pathname === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sites[name].css}\n${componentCss}</style></head><body><div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountCase(${JSON.stringify(name)})</script></body></html>`
        });
      });
      await page.goto(`${ORIGIN}/`);
      await page.locator('main section').first().waitFor();
      expect(await fontSizeOf(page, 'html'), "the browser's default font size applies").toBe(fontSize);
      await body(page);
    } finally {
      await context.close();
    }
  }

  const fontSizeOf = async (page: Page, selector: string) =>
    (await page.evaluate(`parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontSize)`)) as number;
  const measure = async (page: Page) => (await page.evaluate(MEASURE)) as Layout;
  /**
   * Read once every transition has finished: the theme's reduced-motion rule still runs a 0.01ms transition, as on
   * the skip link, and its start can wait a few frames (longer while the theme's web fonts load), so a fixed number
   * of frames is not enough. CSS transitions always end, and one cut short by another counts as done.
   */
  const focused = async (page: Page) => {
    await page.evaluate('Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))');
    return (await page.evaluate(FOCUSED)) as Focused | null;
  };
  const tab = async (page: Page) => {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (!f) throw new Error('Tab moved focus out of the page');
    return f;
  };

  /** Every way a case fails to fit at the given widths and text sizes, so one assertion names them all. */
  async function sweep(name: string, widths: number[], fontSizes: number[]): Promise<string[]> {
    const problems: string[] = [];
    for (const fontSize of fontSizes)
      for (const width of widths)
        await withPage(name, { width }, fontSize, async (page) => {
          const at = `${name} at ${width}px with ${fontSize}px text`;
          const check = (layout: Layout, where: string) => {
            if (layout.scrollWidth > layout.viewportWidth) problems.push(`${at}${where}: the page is ${layout.scrollWidth}px wide`);
            for (const el of layout.outside) problems.push(`${at}${where}: ${el}`);
            for (const line of layout.spills) problems.push(`${at}${where}: ${line}`);
            for (const el of layout.clipped) problems.push(`${at}${where}: ${el} cuts off or side-scrolls its content`);
            if (layout.blocksScroll) problems.push(`${at}${where}: page scrolling is turned off`);
            if (layout.skipLinkShows) problems.push(`${at}${where}: the skip link shows before it is focused`);
          };
          check(await measure(page), '');
          const toggle = page.locator('.so-header__toggle');
          if (await toggle.isVisible()) {
            await toggle.click();
            await page.locator('#so-site-nav').waitFor();
            check(await measure(page), ' (menu open)');
          }
        });
    return problems;
  }

  it.each(Object.keys(CASES))('fits the %s page on phones at the ordinary and doubled text size', async (name) => {
    expect(await sweep(name, PHONES, TEXT_SIZES)).toEqual([]);
  }, 60_000);

  it('fits every page on tablets and desktops at the ordinary and doubled text size', async () => {
    const problems: string[] = [];
    for (const name of Object.keys(CASES)) problems.push(...(await sweep(name, WIDER, TEXT_SIZES)));
    expect(problems).toEqual([]);
  }, 120_000);

  for (const fontSize of TEXT_SIZES)
    it(`keeps the requested type size and every word at ${fontSize}px text`, async () => {
      for (const width of PHONES)
        await withPage('together', { width }, fontSize, async (page) => {
          // On phones each text style sits at its minimum, a fixed multiple of the visitor's text size.
          const scale = {
            [inSection('hero.centered', '.hero__heading')]: 2.6,
            [inSection('hero.split', '.hero__heading')]: 2.25,
            [inSection('hero.centered', '.hero__lead')]: 1.08,
            [inSection('hero.centered', '.hero__primary')]: 0.97,
            [inSection('contact.details', '.contact__value')]: 1
          };
          for (const [selector, ratio] of Object.entries(scale)) expect(await fontSizeOf(page, selector), `${selector} at ${width}px`).toBeCloseTo(ratio * fontSize, 0);
          expect(await page.locator(inSection('hero.centered', '.hero__heading')).innerText()).toBe('Designed for living in, not just for photographs');
          expect(await page.locator(inSection('hero.centered', '.hero__primary')).innerText()).toBe('Book a consultation');
          expect(await page.locator(inSection('contact.details', '.contact__value')).first().innerText()).toBe('hello@example.com');
        });
    }, 30_000);

  for (const fontSize of TEXT_SIZES)
    for (const width of PHONES)
      it(`reaches every link by keyboard at ${width}px with ${fontSize}px text`, async () => {
        await withPage('together', { width }, fontSize, async (page) => {
          const reached: Focused[] = [];
          for (let i = 0; i < 40; i++) {
            await page.keyboard.press('Tab');
            const f = await focused(page);
            if (!f || f.seen) break;
            reached.push(f);
          }
          // Each one by its section and destination, so a repeated label elsewhere cannot stand in for it.
          const expected = [
            ['header', 'Test Studio', '/'],
            ['hero-centered', 'Book a consultation', '/contact/'],
            ['hero-centered', 'See recent projects', '/about/'],
            ['hero-split', 'Book a consultation', '/contact/'],
            ['hero-split', 'See recent projects', '/about/'],
            ['contact-details', 'Email us', 'mailto:hello@example.com'],
            ['contact-details', 'hello@example.com', 'mailto:hello@example.com'],
            ['contact-details', '+1 555 0134', 'tel:+15550134'],
            ['shell-footer', 'Home', '/'],
            ['shell-footer', 'About', '/about/'],
            ['shell-footer', 'Contact', '/contact/'],
            ['shell-footer', 'hello@example.com', 'mailto:hello@example.com'],
            ['shell-footer', '+1 555 0134', 'tel:+15550134']
          ];
          const missing = expected.filter(([section, text, href]) => !reached.some((f) => f.section === section && f.text === text && f.href === href));
          expect(missing, 'reached by Tab').toEqual([]);
          // Measured where Tab's own scrolling left it.
          expect(reached.filter((f) => !onScreen(f)).map(describeFocus)).toEqual([]);

          // Enter on a hero action follows its link.
          await page.locator(inSection('hero.centered', '.hero__primary')).focus();
          await Promise.all([page.waitForURL(`${ORIGIN}/contact/`), page.keyboard.press('Enter')]);
        });
      }, 30_000);

  for (const fontSize of TEXT_SIZES)
    for (const width of PHONES)
      it(`keeps the whole phone menu reachable by keyboard on a short screen at ${width}px with ${fontSize}px text`, async () => {
        await withPage('together', { width, height: 400 }, fontSize, async (page) => {
          // The menu button is the summary of a native disclosure, whose open state the browser announces.
          const expanded = () => page.evaluate<boolean>("document.querySelector('.so-header__menu').open");
          const opening = [await tab(page), await tab(page), await tab(page)];
          expect(opening.map((f) => f.text)).toEqual(['Skip to content', 'Test Studio', 'Menu']);
          await page.keyboard.press('Enter');
          await expect.poll(expanded).toBe(true);
          const items: Focused[] = [];
          for (let i = 0; i < 4; i++) items.push(await tab(page));
          expect(items.map((f) => `${f.section}: ${f.text} ${f.href}`)).toEqual(['header: Home /', 'header: About /about/', 'header: Contact /contact/', 'header: Book a call /contact/']);
          expect(items.filter((f) => !onScreen(f)).map(describeFocus)).toEqual([]);
          // One column: each item below the one before it, all on the same centre line (the call to action is a
          // button inset within the column the links fill).
          expect(items.filter((f, i) => i > 0 && f.top < items[i - 1].bottom - 0.5).map(describeFocus)).toEqual([]);
          expect(new Set(items.map((f) => Math.round(f.left + f.right))).size).toBe(1);
          await page.keyboard.press('Escape');
          await expect.poll(expanded).toBe(false);
          await expect.poll(() => page.locator('#so-site-nav').isVisible()).toBe(false);
          expect((await focused(page))?.text).toBe('Menu');
        });
      }, 30_000);
});
