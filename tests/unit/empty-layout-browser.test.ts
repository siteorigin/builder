/**
 * Empty containers and slots in the editor's preview, in a real browser (issue #511): the generated Home page of a
 * site with an empty Grid, an empty Row and an empty Section, as the editor's variant, mounted in a frame of a
 * stand-in editor with the real preview bridge. In Edit the Grid shows a labelled frame tall enough to pick, its
 * columns ruled where its gaps are, and a click on it reports the Grid; Preview shows the page as visitors get it:
 * the Grid with no height, no frame, and no placeholder in the empty slot at all. An empty Gallery and Carousel
 * (issue #577) show a box where their images will go in Edit, and nothing at all in Preview.
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { STYLES_DIR, generateProject } from '@generator/index';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://frames.test';
const SESSION = 'so-test';
const GEN = '\0gen:';
const HOME = 'src/routes/+page.svelte';

/**
 * A blank site whose Home has a Section holding an empty Grid and an empty Row, then a component of the site's own
 * (with a property called "document") holding an empty Section, a Section left empty, and an empty Gallery and Carousel.
 */
function site() {
  let s: ProjectState = createStarterState('blank', 'Frames', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  let r = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
  s = r.state;
  const section = r.results[0].nodeId as string;
  r = applyOperations(s, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'grid' }]);
  s = r.state;
  const grid = r.results[0].nodeId as string;
  r = applyOperations(s, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'row' }]);
  s = r.state;
  const row = r.results[0].nodeId as string;
  // The component: a Stack holding an empty Section, made a component, given a property called "document".
  r = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
  r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: r.results[0].nodeId as string, slot: 'content', primitive: 'stack' }]);
  const stack = r.results[0].nodeId as string;
  r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: stack, componentId: 'layout.section' }]);
  r = applyOperations(r.state, [{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Holder' }]);
  s = applyOperations(r.state, [
    { type: 'component.setPropSchema', definitionId: r.results[0].definitionId as string, prop: 'document', schema: { type: 'string', label: 'Document', default: 'Brochure' } },
    { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' },
    { type: 'node.insert', owner, parentId: null, componentId: 'media.gallery' },
    { type: 'node.insert', owner, parentId: null, componentId: 'media.carousel' }
  ]).state;
  return { s, grid, row };
}

/** The editor's variant of Home, compiled for the browser into one script that mounts it. */
async function bundle(files: Map<string, string>): Promise<string> {
  const entry = `import { mount } from 'svelte';\nimport Page from ${JSON.stringify(GEN + HOME)};\nwindow.mountPage = () => mount(Page, { target: document.getElementById('app') });`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'generated-page',
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
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {};';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path)!;
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true, css: 'injected' }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The page did not bundle');
  return chunk.code;
}

/*
 * What runs in the page is written as source, as in appear-browser.test.ts: these tests compile without the DOM's types.
 */
const el = (id: string) => `document.querySelector('[data-so-node="${id}"]')`;
type Box = { width: number; height: number; label: string; outline: string; rule: string; tracks: number[]; gap: number; padLeft: number };
/** How the element with `id` is laid out and framed. */
const BOX = (id: string) =>
  `(() => { const e = ${el(id)}; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { width: r.width, height: r.height, label: getComputedStyle(e, '::before').content, outline: cs.outlineStyle, rule: cs.columnRuleStyle, tracks: cs.gridTemplateColumns === 'none' ? [] : cs.gridTemplateColumns.split(' ').map(parseFloat), gap: parseFloat(cs.columnGap) || 0, padLeft: parseFloat(cs.paddingLeft) || 0 }; })()`;
const MARKERS = `document.querySelectorAll('[data-so-slot-empty], [data-so-editor-only]').length`;
/** Each empty list of images' placeholder: what it says, and how big it is drawn. */
const LISTS = `[...document.querySelectorAll('[data-so-list-empty]')].map((m) => { const r = m.getBoundingClientRect(); return { list: m.getAttribute('data-so-list-empty'), text: m.textContent, height: r.height, width: r.width, border: getComputedStyle(m).borderTopStyle }; })`;
/**
 * Run in a blank page on [png, the content box's left offset, height]: the x offsets inside the content box where a
 * row across the middle of the picture differs from the page behind (read just inside the first column).
 */
const INK = `async ([png, pad, height]) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const xs = new Set();
  // Below the label, which sits at the top left.
  const mid = Math.round(Math.max(height / 2, 40));
  for (let y = mid; y < Math.min(mid + 8, img.height - 3); y++) {
    const row = g.getImageData(0, y, img.width, 1).data;
    const [r0, g0, b0] = [row[(pad + 6) * 4], row[(pad + 6) * 4 + 1], row[(pad + 6) * 4 + 2]];
    for (let x = 3; x < img.width - 3; x++) {
      const d = Math.abs(row[x * 4] - r0) + Math.abs(row[x * 4 + 1] - g0) + Math.abs(row[x * 4 + 2] - b0);
      if (d > 24) xs.add(x - pad);
    }
  }
  return [...xs].sort((a, b) => a - b);
}`;

describe.skipIf(!browserInstalled)('empty containers and slots in the editor preview, in a browser', () => {
  let browser: Browser;
  let script: string;
  let css: string;
  let ids: { grid: string; row: string };
  beforeAll(async () => {
    const { s, grid, row } = site();
    ids = { grid, row };
    const files = generateProject(s, { instrument: true });
    css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
    script = await bundle(files);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The page in a 1280px frame of a stand-in editor that records what the bridge tells it, the bridge running. */
  async function open(): Promise<{ page: Page; site: Frame; close: () => Promise<void> }> {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="main"><div id="app"></div></main></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.pathname === '/site') return route.fulfill({ contentType: 'text/html', body: html });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>Editor</title><script>window.told = []; addEventListener('message', (e) => window.told.push(e.data));</script><iframe name="${SESSION}" src="/site" style="width:1280px;height:800px;border:0"></iframe>`
      });
    });
    await page.goto(`${ORIGIN}/`);
    await expect.poll(() => page.frame({ name: SESSION })?.url()).toBe(`${ORIGIN}/site`);
    const site = page.frame({ name: SESSION })!;
    await site.waitForLoadState();
    await site.addScriptTag({ url: '/app.js', type: 'module' });
    await site.waitForFunction('typeof window.mountPage === "function"');
    await site.evaluate('window.mountPage()');
    await site.addScriptTag({ url: '/bridge.js', type: 'module' });
    await site.waitForFunction('window.__siteoriginBridge === true && document.documentElement.hasAttribute("data-so-editing")');
    return { page, site, close: () => page.close() };
  }

  /** Switches the preview between Edit and Preview, as the editor does. */
  async function mode(page: Page, site: Frame, to: 'edit' | 'preview') {
    await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type: 'mode', payload: { mode: to } })}, '*')`);
    await site.waitForFunction(`document.documentElement.hasAttribute('data-so-editing') === ${to === 'edit'}`);
    await settle(site);
  }
  const settle = (site: Frame) => site.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const box = (site: Frame, id: string) => site.evaluate<Box>(BOX(id));
  const width = async (page: Page, site: Frame, px: number) => {
    await page.evaluate(`document.querySelector('iframe').style.width = '${px}px'`);
    await site.waitForFunction(`innerWidth === ${px}`);
    await settle(site);
  };

  /**
   * Where something other than the page behind it is painted across the middle of the element with `id`, as x
   * offsets inside its content box (the frame's own outline at the edges left out). Several rows are read, so a
   * dashed line is found wherever its dashes fall.
   */
  async function inkAcross(page: Page, site: Frame, id: string): Promise<number[]> {
    const shot = await site.locator(`[data-so-node="${id}"]`).screenshot();
    const b = await box(site, id);
    const reader = await browser.newPage();
    try {
      return await reader.evaluate<number[]>(`(${INK})(${JSON.stringify([shot.toString('base64'), Math.round(b.padLeft), Math.round(b.height)])})`);
    } finally {
      await reader.close();
    }
  }
  /** The x offsets of the middle of each gap between the columns. */
  const gutters = (b: Box) => b.tracks.slice(0, -1).map((_, i) => b.tracks.slice(0, i + 1).reduce((a, t) => a + t, 0) + b.gap * i + b.gap / 2);

  it('frames the empty Grid in Edit, names it, rules its three columns, and a click on it reports the Grid', async () => {
    const { page, site, close } = await open();
    try {
      const grid = await box(site, ids.grid);
      expect(grid.height).toBeGreaterThanOrEqual(72);
      // Named for the author, and silent for a screen reader (no alternative text).
      expect(grid.label).toBe('"Grid" / ""');
      expect(grid.outline).toBe('dashed');
      expect(grid.rule).toBe('dashed');
      expect(grid.tracks).toHaveLength(3);
      // The columns are drawn in the two gaps between them, and nowhere else inside the frame.
      const ink = await inkAcross(page, site, ids.grid);
      const expected = gutters(grid);
      expect(expected).toHaveLength(2);
      for (const x of expected) expect(ink.some((i) => Math.abs(i - x) <= 2), `a line at ${x} in ${JSON.stringify(ink)}`).toBe(true);
      expect(ink.filter((i) => expected.every((x) => Math.abs(i - x) > 2))).toEqual([]);

      // The empty Row has its frame and height too, across its whole width, with no columns to draw.
      const row = await box(site, ids.row);
      expect(row.height).toBeGreaterThanOrEqual(72);
      expect(row.label).toBe('"Row" / ""');
      expect(row.width).toBeCloseTo(grid.width, 0);
      expect(await inkAcross(page, site, ids.row)).toEqual([]);

      // A click in the middle column is a click on the Grid: it is the innermost element the bridge reports.
      const b = (await site.locator(`[data-so-node="${ids.grid}"]`).boundingBox())!;
      await page.evaluate('window.told.length = 0');
      await site.locator(`[data-so-node="${ids.grid}"]`).click({ position: { x: b.width / 2, y: b.height / 2 } });
      await expect.poll(() => page.evaluate<string | undefined>(`window.told.find((m) => m.type === 'select')?.payload.chain[0]?.node`)).toBe(ids.grid);

      // At phone width the Grid has one column: the frame stays, with no line inside it.
      await width(page, site, 390);
      const phone = await box(site, ids.grid);
      expect(phone.tracks).toHaveLength(1);
      expect(phone.height).toBeGreaterThanOrEqual(72);
      expect(await inkAcross(page, site, ids.grid)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('shows the page as visitors get it in Preview, and the frames and slot placeholders again back in Edit', async () => {
    const { page, site, close } = await open();
    try {
      // The page's empty Section, the one in the component (placed there, whatever its own properties are called), and
      // the empty Gallery's and Carousel's lists.
      await expect.poll(() => site.evaluate<number>(MARKERS)).toBe(4);
      const heights = await site.evaluate<number[]>(`[...document.querySelectorAll('[data-so-slot-empty]')].map((m) => m.getBoundingClientRect().height)`);
      expect(heights.length === 2 && heights.every((h) => h >= 72), JSON.stringify(heights)).toBe(true);

      await mode(page, site, 'preview');
      const grid = await box(site, ids.grid);
      expect(grid).toMatchObject({ height: 0, label: 'none', outline: 'none', rule: 'none' });
      expect(await box(site, ids.row)).toMatchObject({ height: 0, label: 'none', outline: 'none' });
      // No placeholder at all: the empty slot renders nothing, and the empty Grid holds nothing.
      await expect.poll(() => site.evaluate<number>(MARKERS)).toBe(0);
      expect(await site.evaluate<boolean>(`${el(ids.grid)}.matches(':empty')`)).toBe(true);

      await mode(page, site, 'edit');
      expect((await box(site, ids.grid)).height).toBeGreaterThanOrEqual(72);
      await expect.poll(() => site.evaluate<number>(MARKERS)).toBe(4);
    } finally {
      await close();
    }
  });

  it('shows where an empty Gallery’s and Carousel’s images will go in Edit, and nothing of it in Preview', async () => {
    const { page, site, close } = await open();
    try {
      type List = { list: string; text: string; height: number; width: number; border: string };
      await expect.poll(() => site.evaluate<number>(`document.querySelectorAll('[data-so-list-empty]').length`)).toBe(2);
      const lists = await site.evaluate<List[]>(LISTS);
      expect(lists.map((l) => l.list)).toEqual(['images', 'slides']);
      expect(lists[0].text).toContain('No images yet');
      expect(lists[1].text).toContain('No slides yet');
      // A dashed box tall enough to see, across the section's column, that says visitors never see it.
      for (const l of lists) {
        expect(l.height, JSON.stringify(l)).toBeGreaterThanOrEqual(160);
        expect(l.width, JSON.stringify(l)).toBeGreaterThan(300);
        expect(l.border).toBe('dashed');
        expect(l.text).toContain('Visitors won’t see this box.');
      }

      await mode(page, site, 'preview');
      await expect.poll(() => site.evaluate<number>(`document.querySelectorAll('[data-so-list-empty]').length`)).toBe(0);

      await mode(page, site, 'edit');
      await expect.poll(() => site.evaluate<number>(`document.querySelectorAll('[data-so-list-empty]').length`)).toBe(2);
    } finally {
      await close();
    }
  });
});
