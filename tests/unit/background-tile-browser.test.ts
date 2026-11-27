/**
 * A tiled background image in a real browser (#1137): the generated stylesheet painted with a small viewBox-only SVG
 * pattern and a raster grain, read back pixel by pixel, and the panel's Fill and Tile width fields.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetRecord, BackgroundImageValue, ElementNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateSiteCss, pageNodeClass } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://tile.test';

/** A dot grid drawn to a viewBox alone: a red square in the top left quarter of each 20-unit tile, white elsewhere. */
const DOTS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#ffffff"/><rect width="10" height="10" fill="#ff0000"/></svg>';

/** An 8px grain: blue in its top left quarter, white elsewhere. */
function grainPng(): Buffer {
  const side = 8;
  const rows = Buffer.concat(Array.from({ length: side }, (_, y) => Buffer.from([0, ...Array.from({ length: side }, (_, x) => (x < 4 && y < 4 ? [0, 0, 255] : [255, 255, 255])).flat()])));
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(side, 0);
  head.writeUInt32BE(side, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const asset = (id: string, file: string, mime: string, side: number): AssetRecord => ({ id, name: id, file: `static/assets/${file}`, mime, bytes: 200, width: side, height: side, hash: id, kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' });

/** A project whose home page has an empty band, with the two patterns in its library. */
function studio(): ProjectState {
  const s = createStarterState('blank', 'Tiles', false);
  s.assets.assets = { a_dots: asset('a_dots', 'dots.svg', 'image/svg+xml', 20), a_grain: asset('a_grain', 'grain.png', 'image/png', 8) };
  const page = s.pages[s.site.homePageId];
  page.nodes.n_band = { id: 'n_band', kind: 'element', tag: 'div', children: [] } as ElementNode;
  page.rootIds.push('n_band');
  return s;
}

const setBg = (s: ProjectState, value: BackgroundImageValue) =>
  applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'page', id: s.site.homePageId }, nodeId: 'n_band', scope: 'base', property: 'backgroundImage', value }]).state;

type Rgb = number[];

describe.skipIf(!browserInstalled)('a tiled background image in a browser (#1137)', { timeout: 120_000 }, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  /** The colours the site paints at these points of a 100 by 100 band. */
  async function paint(s: ProjectState, points: Array<[number, number]>): Promise<Rgb[]> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.route(`${SITE}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/assets/dots.svg') return route.fulfill({ contentType: 'image/svg+xml', body: DOTS_SVG });
        if (path === '/assets/grain.png') return route.fulfill({ contentType: 'image/png', body: grainPng() });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>${generateSiteCss(s)}</style><style>body{margin:0}.${pageNodeClass('n_band')}{width:100px;height:100px}</style><div class="${pageNodeClass('n_band')}"></div>` });
      });
      await page.goto(`${SITE}/`, { waitUntil: 'networkidle' });
      const shot = (await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } })).toString('base64');
      return (await page.evaluate(`(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${shot}';
        await img.decode();
        const canvas = Object.assign(document.createElement('canvas'), { width: 100, height: 100 });
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        return ${JSON.stringify(points)}.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3));
      })()`)) as Rgb[];
    } finally {
      await page.close();
    }
  }

  const RED = [255, 0, 0];
  const BLUE = [0, 0, 255];
  const WHITE = [255, 255, 255];

  it('repeats a viewBox-only SVG at its own width, and at the width set', async () => {
    const own = setBg(studio(), { assetId: 'a_dots', size: 'tile' });
    expect(await paint(own, [[5, 5], [15, 5], [25, 5], [85, 85], [95, 95]])).toEqual([RED, WHITE, RED, RED, WHITE]);
    const wide = setBg(studio(), { assetId: 'a_dots', size: 'tile', tileSize: 40 });
    expect(await paint(wide, [[15, 15], [25, 5], [55, 15], [95, 95]])).toEqual([RED, WHITE, RED, RED]);
  });

  it('repeats a raster grain, takes its place on replacement, and stops repeating when it fills the box again', async () => {
    const dots = setBg(studio(), { assetId: 'a_dots', size: 'tile', tileSize: 16 });
    const grain = applyOperations(dots, [{ type: 'asset.replace', assetId: 'a_dots', withAssetId: 'a_grain' }]).state;
    expect(await paint(grain, [[3, 3], [12, 3], [19, 3], [83, 83], [92, 92]])).toEqual([BLUE, WHITE, BLUE, BLUE, WHITE]);
    // Without a width, the grain keeps its own 8px.
    expect(await paint(setBg(studio(), { assetId: 'a_grain', size: 'tile' }), [[2, 2], [6, 2], [10, 2], [90, 90]])).toEqual([BLUE, WHITE, BLUE, BLUE]);
    // Filling the box: one blue quarter, 50px across, and no second one.
    const covered = setBg(grain, { assetId: 'a_grain', tileSize: 16 });
    expect(await paint(covered, [[20, 20], [80, 20], [20, 80], [83, 83]])).toEqual([BLUE, WHITE, WHITE, WHITE]);
  });

  it('draws the scrim once over the whole box while the tile repeats under it', async () => {
    const s = setBg(studio(), { assetId: 'a_dots', size: 'tile', scrim: 'linear-gradient(rgba(0, 0, 0, 0), #000000)' });
    // The same point of the white part of a tile, down the box: ever darker, never starting over.
    const down = (await paint(s, [[15, 5], [15, 25], [15, 45], [15, 65], [15, 85]])).map(([r]) => r);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThan(down[i - 1] - 20);
    // And the pattern still repeats under it.
    const [[r, g], [, white]] = await paint(s, [[5, 85], [15, 85]]);
    expect(r).toBeGreaterThan(g);
    expect(white).toBeGreaterThan(0);
  });
});

const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { BackgroundImageControl } from ${renderer('panels/BackgroundImageControl')};`,
  `import { useStore } from ${renderer('store')};`,
  'const state = window.__project;',
  "flushSync(() => useStore.setState({ screen: 'editor', snapshot: { state, revision: 1, workspaceKey: 'w1', conflicts: [], recentExports: [], diagnostics: [], missingAssets: [] } }));",
  'window.__saved = [];',
  'function Host() {',
  "  const [value, setValue] = useState({ assetId: 'a_grain', position: '30% 20%', scrim: '#0008' });",
  "  return h(BackgroundImageControl, { label: 'Background image', value, underText: '', scope: 'base', size: 'desktop', previewed: false, onSet: (v) => { window.__saved.push(v); setValue(v ?? undefined); return Promise.resolve({ ok: true, revision: 1 }); } });",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Host)));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'tile-panel', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the background image control did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the Tile option in the panel (#1137)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const [script, launched] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    browser = launched;
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const project = JSON.stringify(studio()).replace(/</g, '\\u003c');
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}window.__project = ${project};</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  const saved = () => page.evaluate<BackgroundImageValue[]>('window.__saved');
  const last = async () => (await saved()).at(-1);

  it('sets the tile and its width, keeps the focus for Cover, and refuses a width it cannot save', async () => {
    const fill = page.getByLabel('Fill', { exact: true });
    const width = page.getByRole('textbox', { name: 'Background image: tile width in pixels' });
    const focus = page.getByRole('group', { name: 'Focus', exact: true });
    await fill.waitFor();
    expect(await width.count()).toBe(0);
    expect(await focus.count()).toBe(1);

    await fill.selectOption('tile');
    expect(await last()).toEqual({ assetId: 'a_grain', size: 'tile', position: '30% 20%', scrim: '#0008' });
    expect(await focus.count()).toBe(0);
    expect(await width.getAttribute('placeholder')).toBe('Automatic');

    await width.fill('48px');
    await width.press('Enter');
    await expect.poll(last).toEqual({ assetId: 'a_grain', size: 'tile', tileSize: 48, position: '30% 20%', scrim: '#0008' });

    const count = (await saved()).length;
    await width.fill('0');
    await width.press('Tab');
    await page.getByRole('alert').filter({ hasText: 'whole number of pixels' }).waitFor();
    expect((await saved()).length).toBe(count);

    await width.fill('');
    await width.press('Enter');
    await expect.poll(last).toEqual({ assetId: 'a_grain', size: 'tile', position: '30% 20%', scrim: '#0008' });
    expect(await page.getByRole('alert').count()).toBe(0);

    await width.fill('32');
    await width.press('Enter');
    await expect.poll(async () => (await last())?.tileSize).toBe(32);
    await fill.selectOption('cover');
    expect(await last()).toEqual({ assetId: 'a_grain', tileSize: 32, position: '30% 20%', scrim: '#0008' });
    expect(await width.count()).toBe(0);
    expect(await focus.count()).toBe(1);

    // The width waited for the next tiling.
    await fill.selectOption('tile');
    expect(await width.inputValue()).toBe('32');
    expect(errors).toEqual([]);
  });
});
