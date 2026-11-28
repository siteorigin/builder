/**
 * The exported site's full-image viewer (Action.svelte) in a real browser, moving through one gallery's photos: each
 * photo it shows starts with its own caption at the top, however far the visitor read the one before (#1437), by the
 * arrow keys and by the Previous and Next buttons, and a caption holding focus keeps it. At a visitor's enlarged
 * default text size the photo, its caption and every control stay on screen in portrait and in short landscape (#1431).
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { compile } from 'svelte/compiler';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://viewer.test';
const GEN = '\0gen:';

const FIRST = `First photo. ${'The morning light falls across the oak bench and the tiled splashback, picking out the grain. '.repeat(7)}`;
const SECOND = `Second photo. ${'A long hallway runs past the reading nook towards the garden door, lined with framed prints. '.repeat(7)}`;

/** Every photo: 800 × 600, as the gallery's images are. */
const PHOTO = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#8a9"/></svg>';

/** Two photos of one gallery, each opening full size, with the captions above. */
const HARNESS = [
  '<script>',
  "\timport Action from '../lib/siteorigin/runtime/Action.svelte';",
  `\tconst photos = ${JSON.stringify([
    { src: '/images/first.jpg', alt: 'The kitchen', caption: FIRST },
    { src: '/images/second.jpg', alt: 'The hallway', caption: SECOND }
  ])};`,
  '</script>',
  '',
  '{#each photos as photo}',
  '\t<Action mode="image" image={{ src: photo.src, alt: photo.alt, width: 800, height: 600 }} group="gallery">',
  '\t\t<figure><img src={photo.src} alt={photo.alt} width="160" height="120" /><figcaption>{photo.caption}</figcaption></figure>',
  '\t</Action>',
  '{/each}',
  ''
].join('\n');

async function bundle(files: Map<string, string>): Promise<string> {
  const all = new Map<string, string>([
    ...files,
    ['src/routes/harness.svelte', HARNESS],
    ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";'],
    ['app/navigation.js', 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};']
  ]);
  const entry = [
    "import { mount } from 'svelte';",
    `import Harness from ${JSON.stringify(GEN + 'src/routes/harness.svelte')};`,
    "window.startHarness = () => mount(Harness, { target: document.getElementById('app'), props: {} });"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'generated-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/navigation') return GEN + id.slice(1) + '.js';
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (all.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = all.get(path);
          if (source === undefined) throw new Error(`Not generated: ${path}`);
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The viewer did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the full-image viewer moving through a gallery', () => {
  let browser: Browser;
  let script: string;
  let css: string;
  beforeAll(async () => {
    const files = generateProject(createStarterState('business', 'Test Studio', false));
    css = ['tokens', 'theme', 'components', 'site'].map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
    script = await bundle(files);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The two photos on a phone, with console warnings and errors, and uncaught errors, collected. */
  async function open(fontSize = 16, viewport = { width: 320, height: 568 }): Promise<{ page: Page; problems: string[] }> {
    const page = await browser.newPage();
    // The browser's own default text size, as a visitor sets it in Chromium's settings.
    if (fontSize !== 16) await (await page.context().newCDPSession(page)).send('Page.setFontSizes', { fontSizes: { standard: fontSize } });
    const problems: string[] = [];
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const html = `<!doctype html><html lang="en" class="so-js"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="app"></div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname.startsWith('/images/')) return route.fulfill({ contentType: 'image/svg+xml', body: PHOTO });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize(viewport);
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: '/app.js', type: 'module' });
    await page.waitForFunction('typeof window.startHarness === "function"');
    await page.evaluate('window.startHarness()');
    await page.waitForSelector('a.so-action--image');
    return { page, problems };
  }

  /** The caption the open viewer shows: how it starts, how far it is scrolled, and how far it can scroll. */
  const captionOf = (page: Page) =>
    page.evaluate(`(() => {
      const c = document.querySelector('dialog.so-viewer[open] .so-viewer__caption');
      return { start: c.textContent.slice(0, 13), top: c.scrollTop, room: c.scrollHeight - c.clientHeight };
    })()`) as Promise<{ start: string; top: number; room: number }>;
  /** Reads the open caption to its end. */
  const readToEnd = async (page: Page) => {
    await page.evaluate(`(() => { const c = document.querySelector('dialog.so-viewer[open] .so-viewer__caption'); c.scrollTop = c.scrollHeight; })()`);
    expect((await captionOf(page)).top).toBeGreaterThan(0);
  };

  it('starts each photo’s caption at the top after the last one was read to its end, by keyboard and by pointer', async () => {
    const { page, problems } = await open();
    try {
      await page.locator('a.so-action--image').first().click();
      await page.waitForSelector('dialog.so-viewer[open]');
      const first = await captionOf(page);
      expect(first).toMatchObject({ start: 'First photo. ', top: 0 });
      // The caption is longer than its box, as a long caption on a phone is.
      expect(first.room).toBeGreaterThan(40);

      await readToEnd(page);
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await captionOf(page)).start).toBe('Second photo.');
      expect((await captionOf(page)).top).toBe(0);

      await readToEnd(page);
      await page.locator('.so-viewer__step').last().click();
      await expect.poll(async () => (await captionOf(page)).start).toBe('First photo. ');
      expect((await captionOf(page)).top).toBe(0);

      await readToEnd(page);
      await page.locator('.so-viewer__step').first().click();
      await expect.poll(async () => (await captionOf(page)).start).toBe('Second photo.');
      expect((await captionOf(page)).top).toBe(0);

      await readToEnd(page);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(async () => (await captionOf(page)).start).toBe('First photo. ');
      expect((await captionOf(page)).top).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('makes the caption a keyboard stop only while it needs its own scrolling area (#1430)', async () => {
    const { page, problems } = await open();
    try {
      await page.locator('a.so-action--image').first().click();
      await page.waitForSelector('dialog.so-viewer[open]');
      const tab = () => page.evaluate(`document.querySelector('dialog.so-viewer[open] .so-viewer__caption')?.getAttribute('tabindex') ?? null`);
      await expect.poll(tab).toBe('0');
      // Close has focus on opening; the caption is the next stop, and the keys scroll it.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(`document.activeElement?.classList.contains('so-viewer__caption')`)).toBe(true);
      await page.keyboard.press('End');
      await expect.poll(async () => (await captionOf(page)).top).toBeGreaterThan(0);
      // A tall window fits the whole caption: no extra stop.
      await page.setViewportSize({ width: 1200, height: 3000 });
      await expect.poll(tab).toBe(null);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('keeps focus on a caption the visitor is reading while the arrow keys change the photo', async () => {
    const { page, problems } = await open();
    try {
      await page.locator('a.so-action--image').first().click();
      await page.waitForSelector('dialog.so-viewer[open]');
      await page.evaluate(`(() => { const c = document.querySelector('dialog.so-viewer[open] .so-viewer__caption'); c.tabIndex = -1; c.focus(); })()`);
      await page.keyboard.press('End');
      // End scrolls smoothly: the caption is read once it reaches its end.
      await expect
        .poll(
          async () => {
            const c = await captionOf(page);
            return c.top > 0 && Math.abs(c.top - c.room) <= 1;
          },
          { timeout: 5_000 }
        )
        .toBe(true);
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await captionOf(page)).start).toBe('Second photo.');
      expect((await captionOf(page)).top).toBe(0);
      expect(await page.evaluate(`document.activeElement?.classList.contains('so-viewer__caption')`)).toBe(true);
      // The next arrow still reaches the viewer.
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await captionOf(page)).start).toBe('First photo. ');
      expect((await captionOf(page)).top).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });
  /** Where the open viewer's parts sit, and how far it can pan sideways. */
  const layoutOf = (page: Page) =>
    page.evaluate(`(() => {
      const d = document.querySelector('dialog.so-viewer[open]');
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const parts = { close: '.so-viewer__close', previous: '.so-viewer__step', next: '.so-viewer__step:last-of-type', count: '.so-viewer__count', caption: '.so-viewer__caption', photo: '.so-viewer__img', figure: '.so-viewer__figure' };
      return {
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        pan: d.scrollWidth - d.clientWidth,
        scrollLeft: d.scrollLeft,
        natural: d.querySelector('.so-viewer__img').naturalWidth,
        focused: document.activeElement?.className ?? '',
        view: { width: innerWidth, height: innerHeight },
        parts: Object.fromEntries(Object.entries(parts).map(([k, s]) => [k, box(d.querySelector(s))]))
      };
    })()`) as Promise<{
      root: number;
      pan: number;
      scrollLeft: number;
      natural: number;
      focused: string;
      view: { width: number; height: number };
      parts: Record<string, { left: number; right: number; top: number; bottom: number; width: number; height: number }>;
    }>;

  /** The viewer fits its screen: no sideways pan, every part inside it, and the photo a real share of it. */
  const expectFits = async (page: Page, label: string) => {
    const layout = await layoutOf(page);
    expect(layout.pan, label).toBeLessThanOrEqual(0);
    expect(layout.scrollLeft, label).toBe(0);
    for (const [name, r] of Object.entries(layout.parts)) {
      expect(r.left, `${label}: ${name} left`).toBeGreaterThanOrEqual(0);
      expect(r.right, `${label}: ${name} right`).toBeLessThanOrEqual(layout.view.width + 0.5);
      expect(r.top, `${label}: ${name} top`).toBeGreaterThanOrEqual(0);
      expect(r.bottom, `${label}: ${name} bottom`).toBeLessThanOrEqual(layout.view.height + 0.5);
    }
    const { photo, close, previous, next, caption, figure } = layout.parts;
    // The caption scrolls within its share of the figure instead of spilling over the photo or the arrows.
    expect(caption.top, `${label}: caption top`).toBeGreaterThanOrEqual(figure.top - 0.5);
    expect(caption.bottom, `${label}: caption bottom`).toBeLessThanOrEqual(figure.bottom + 0.5);
    expect(caption.top, `${label}: caption below the photo`).toBeGreaterThanOrEqual(photo.bottom - 0.5);
    expect(layout.natural, `${label}: the photo loaded`).toBe(800);
    expect(photo.height, `${label}: photo height`).toBeGreaterThanOrEqual(layout.view.height * 0.25);
    expect(photo.width, `${label}: photo width`).toBeGreaterThan(0);
    // Close and the arrows stay at least a 44 px target.
    for (const r of [close, previous, next]) expect(Math.min(r.width, r.height), label).toBeGreaterThanOrEqual(44);
    return layout;
  };

  for (const fontSize of [16, 24, 32]) {
    it(`keeps the photo, caption and controls on screen at a ${fontSize} px default text size, in portrait and short landscape`, async () => {
      const { page, problems } = await open(fontSize, { width: 320, height: 720 });
      try {
        await page.locator('a.so-action--image').first().focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog.so-viewer[open]');
        await page.waitForFunction(`document.querySelector('.so-viewer__img')?.complete`);
        const portrait = await expectFits(page, `320 × 720 at ${fontSize} px`);
        expect(portrait.root).toBe(fontSize);
        expect(portrait.focused).toContain('so-viewer__close');
        for (const viewport of [
          { width: 390, height: 844 },
          { width: 844, height: 390 },
          { width: 667, height: 375 },
          { width: 568, height: 320 }
        ]) {
          await page.setViewportSize(viewport);
          const layout = await expectFits(page, `${viewport.width} × ${viewport.height} at ${fontSize} px`);
          expect(layout.view).toEqual(viewport);
        }
        expect(problems).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
});
