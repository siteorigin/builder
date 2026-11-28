/**
 * The exported site's full-image viewer (Action.svelte) in a real browser, moving through one gallery's photos: each
 * photo it shows starts with its own caption at the top, however far the visitor read the one before (#1437), by the
 * arrow keys and by the Previous and Next buttons, and a caption holding focus keeps it.
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
  async function open(): Promise<{ page: Page; problems: string[] }> {
    const page = await browser.newPage();
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
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: 320, height: 568 });
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
});
