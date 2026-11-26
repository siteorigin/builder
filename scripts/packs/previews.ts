/**
 * Insert thumbnails, drawn from each component's real implementation when its pack is built: every component is
 * placed on a page of its own (once with its defaults, once per variant option), generated, rendered on the
 * server with Svelte as an exported site prerenders it, and photographed in a headless browser with the pack's
 * own fonts and styles. A thumbnail is only drawn again when the HTML and fonts it is drawn from change.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import sharp from 'sharp';
import type { Page } from 'playwright';
import type { ProjectState } from '@shared/types';
import { catalogueEntries, registerPacks } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { previewFile, type ComponentPreviews, type ThemePack } from '@catalogue/pack';
import { installComponent, makeInstance } from '@engine/install';
import { collectionCreate, entryCreate } from '@engine/collections';
import { POSTS_COLLECTION_ID } from '@shared/collections';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { thumbCrop, type Box } from '../../src/main/runtime/component-thumbs';

/**
 * The page a thumbnail is photographed on: a section at desktop width. The photograph is a 16:10 frame around what
 * the component paints (thumbCrop, as a project component's thumbnail is framed), so a short section or a small
 * block fills its Insert tile rather than sitting in a corner of the whole desktop window (#905).
 */
const VIEW = { width: 1280, height: 800 };
/** A block's page: as wide, and tall enough for any block to be framed whole below the room above it. */
const BLOCK_VIEW = { width: 1280, height: 1400 };
const THUMB_SIZE = { width: 320, height: 200 };
/**
 * How wide a block (a feature card, a stat card, a signup form) is shown: about the column of a three- or four-up
 * grid it is placed in, since a block fills whatever holds it.
 */
const BLOCK_WIDTH = 440;
/** How far down the page a block starts. */
const BLOCK_ROOM = 240;
/** Part of every cache key, so a change to how thumbnails are drawn draws them all again. */
const RENDERER = 'preview-v2';
const ORIGIN = 'http://pack.preview';
const GEN = '\0gen:';

interface Case {
  componentId: string;
  /** A block, placed where an element goes, rather than a section of its own (insertAs: 'element'). */
  block: boolean;
  axis?: string;
  option?: string;
  pageId: string;
}

/**
 * Run `fn` with IDs drawn from a fixed sequence, so the same pack builds the same preview HTML every time and its
 * thumbnails are found in the cache instead of drawn again.
 */
function withFixedIds<T>(fn: () => T): T {
  const crypto = globalThis.crypto;
  const real = crypto.getRandomValues;
  const own = Object.hasOwn(crypto, 'getRandomValues');
  let seed = 0x5eed1e55;
  crypto.getRandomValues = (<A extends ArrayBufferView | null>(array: A): A => {
    if (!array) return array;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      bytes[i] = seed >>> 24;
    }
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    return fn();
  } finally {
    if (own) crypto.getRandomValues = real;
    else delete (crypto as { getRandomValues?: unknown }).getRandomValues;
  }
}

/** The published posts a post section's thumbnail lists, newest first. */
const SAMPLE_POSTS = [
  { title: 'Notes from the studio', excerpt: 'A closer look at the materials and small details that shape our work.', publishedAt: '2025-06-12' },
  { title: 'A season of new projects', excerpt: 'What we are building this year, and the people we are building it with.', publishedAt: '2025-05-28' },
  { title: 'How we plan a first visit', excerpt: 'The questions we ask before anything is drawn, and why they matter.', publishedAt: '2025-05-09' }
];

/**
 * What an article's page says about itself, for a section that reads its own page (the Article header): kept out of
 * news lists, so the post sections beside it list the sample posts alone.
 */
const SAMPLE_ARTICLE = { title: 'Notes from the studio', article: { date: '2025-06-12', byline: 'By the studio team', excerpt: 'A closer look at the materials and small details that shape our work.', hidden: true } };

/** Whether a component reads the page it is placed on (an article's title, date and byline). */
const readsOwnPage = (def: { properties: Record<string, { type?: string; feed?: string }> }) => Object.values(def.properties).some((prop) => prop.type === 'list' && prop.feed === 'currentPage');

/** A project holding one page per thumbnail, each with a single section. */
export function previewProject(pack: ThemePack): { state: ProjectState; cases: Case[] } {
  const state = createStarterState('blank', 'Studio', false);
  state.site.themeId = pack.id;
  // Entry feeds draw their cards from published entries instead of a property's defaults.
  if (pack.components.some((def) => Object.values(def.properties).some((prop) => prop.type === 'list' && prop.feed === 'entries'))) {
    collectionCreate(state, { type: 'collection.create', collectionId: POSTS_COLLECTION_ID });
    // Enough posts to fill a grid's row and a list, so a post section shows as visitors with a few posts see it.
    for (const [i, post] of SAMPLE_POSTS.entries()) entryCreate(state, { type: 'entry.create', collectionId: POSTS_COLLECTION_ID, entryId: `en_preview${i}`, ...post, author: 'Studio team', draft: false });
  }
  const template = state.pages[state.site.homePageId];
  // News lists draw their rows from the site's dated article pages: a few, published and listed, that no case shows.
  if (pack.components.some((def) => Object.values(def.properties).some((prop) => prop.type === 'list' && prop.feed === 'articles'))) {
    for (const [i, post] of SAMPLE_POSTS.entries()) {
      const pageId = `pg_article${i}`;
      state.pages[pageId] = { ...structuredClone(template), id: pageId, title: post.title, route: `/article-${i}/`, rootIds: [], nodes: {}, article: { date: post.publishedAt, byline: 'Studio team', excerpt: post.excerpt } };
      state.site.pageOrder.push(pageId);
    }
  }
  const cases: Case[] = [];
  for (const entry of catalogueEntries(pack.id)) {
    const def = state.components[installComponent(state, entry.componentId)];
    const options = [undefined, ...Object.entries(def.variantAxes ?? {}).flatMap(([axis, a]) => Object.keys(a.options).filter((o) => o !== a.default).map((option) => ({ axis, option })))];
    for (const o of options) {
      const pageId = `pg_preview${cases.length}`;
      const node = makeInstance(def, {}, o ? { [o.axis]: o.option } : undefined);
      const own = readsOwnPage(def) ? structuredClone(SAMPLE_ARTICLE) : { title: entry.name };
      state.pages[pageId] = { ...structuredClone(template), id: pageId, ...own, route: `/preview-${cases.length}/`, rootIds: [node.id], nodes: { [node.id]: node } };
      state.site.pageOrder.push(pageId);
      cases.push({ componentId: entry.componentId, block: def.insertAs === 'element', ...o, pageId });
    }
  }
  return { state, cases };
}

/**
 * The preview bridge's own measure of where a page paints (inkBounds in bridge.client.js), run in the photographed
 * page, so a theme's thumbnails are framed exactly as a project component's are.
 */
export function inkBoundsSource(): string {
  const bridge = readFileSync(fileURLToPath(new URL('../../src/runtime/bridge.client.js', import.meta.url)), 'utf8');
  const start = bridge.indexOf('\nfunction inkBounds() {');
  const end = start < 0 ? -1 : bridge.indexOf('\n}\n', start);
  if (end < 0) throw new Error('The preview bridge has no inkBounds() to frame thumbnails with.');
  return `(${bridge.slice(start + 1, end + 2)})()`;
}

/** The html of a thumbnail's page: a block in a column of its own width, centred, and a section as wide as the window. */
export function previewHtml(css: string, head: string, body: string, block: boolean): string {
  // Room above a block, so a short one can be centred in its frame.
  const main = block ? `<main id="main" style="box-sizing:content-box;max-width:${BLOCK_WIDTH}px;margin:0 auto;padding:${BLOCK_ROOM}px 16px 24px">` : '<main id="main">';
  // Drawn as a visitor whose browser runs the page's scripts sees it (see SCRIPTS_CLASS): one tab's panel, one period.
  return `<!doctype html><html lang="en" class="so-js"><head><meta charset="utf-8"><style>${css}</style>${head.replace(/<title>[^<]*<\/title>/, '')}<style>html{scroll-behavior:auto}*{animation:none!important;transition:none!important}</style></head><body>${main}${body}</main></body></html>`;
}

interface Rendered {
  render: (component: unknown, options: { props: Record<string, unknown> }) => { body: string; head: string };
  pages: unknown[];
}

/** Bundle every preview page for the server, the way the exported site's prerender does. */
export async function bundlePages(files: Map<string, string>, pages: string[]): Promise<{ module: Rendered; dir: string }> {
  const entry = ["export { render } from 'svelte/server';", ...pages.map((p, i) => `import P${i} from ${JSON.stringify(GEN + p)};`), `export const pages = [${pages.map((_, i) => `P${i}`).join(', ')}];`].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-site',
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
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true, css: 'injected' }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The preview pages did not bundle.');
  const dir = mkdtempSync(join(tmpdir(), 'so-pack-previews-'));
  writeFileSync(join(dir, 'pages.mjs'), chunk.code);
  return { module: (await import(pathToFileURL(join(dir, 'pages.mjs')).href)) as Rendered, dir };
}

/**
 * Leaves the background, border and shadow of every box about as wide as the window out of what is measured, and
 * returns what puts them back: a section's own band of colour is in the photograph, but what is framed is what it
 * holds, so a short section is not shown as a sliver at the top of the whole window.
 */
const UNPAINT_BANDS = `(() => {
  const kept = [];
  for (const el of document.querySelectorAll('#main, #main *')) {
    if (el.getBoundingClientRect().width < innerWidth * 0.9) continue;
    kept.push([el, el.getAttribute('style')]);
    for (const p of ['background', 'border-color', 'box-shadow']) el.style.setProperty(p, p === 'border-color' ? 'transparent' : 'none', 'important');
  }
  window.__soBands = kept;
})()`;
const REPAINT_BANDS = `(() => {
  for (const [el, style] of window.__soBands ?? []) style === null ? el.removeAttribute('style') : el.setAttribute('style', style);
  delete window.__soBands;
})()`;

/**
 * What to photograph of the page shown in `page`: a 16:10 frame around what it paints (for a section, what its full
 * width bands hold), or the top of the window when it paints nothing that can be measured.
 */
export async function frameOf(page: Page, ink: string, block: boolean): Promise<Box> {
  const view = block ? BLOCK_VIEW : VIEW;
  if (!block) await page.evaluate(UNPAINT_BANDS);
  const painted: Box | null = await page.evaluate(ink);
  if (!block) await page.evaluate(REPAINT_BANDS);
  // A block is shown whole (a form with its button): one taller than its frame is framed wider, centred across.
  // (The frame adds room on every side: the width allows for it, so the room below the block is kept too.)
  if (block && painted && painted.height * 1.6 + 20 > painted.width) {
    const width = Math.min(view.width, painted.height * 1.6 + 20);
    return thumbCrop(null, { ...painted, x: painted.x + painted.width / 2 - width / 2, width }, view) ?? { x: 0, y: 0, ...VIEW };
  }
  const bounds: Box | null = await page.evaluate(`(() => { const r = document.getElementById('main')?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  return thumbCrop(bounds, painted, view) ?? { x: 0, y: 0, ...VIEW };
}

/**
 * Draw the thumbnails of every component and variant option of a pack. `files` maps each pack file (its fonts)
 * to its source on disk. Returns the previews map for the manifest and the image bytes by release path.
 */
export async function renderPreviews(pack: ThemePack, files: Map<string, string>, cacheDir: string, opts: { require?: boolean } = {}): Promise<{ previews: Record<string, ComponentPreviews>; bytes: Map<string, Buffer>; drawn: number }> {
  registerPacks([pack]);
  const { state, cases } = withFixedIds(() => previewProject(pack));
  const generated = generateProject(state);
  const css = ['tokens.css', 'theme.css', 'components.css', 'site.css'].map((f) => generated.get(`${STYLES_DIR}/${f}`) ?? '').join('\n');
  const { module, dir } = await bundlePages(generated, cases.map((c) => pageFile(state.pages[c.pageId])));
  const fontBytes = new Map([...files].filter(([rel]) => rel.startsWith('fonts/')).map(([rel, abs]) => [rel.slice('fonts/'.length), readFileSync(abs)]));
  const fontKey = createHash('sha256').update([...fontBytes].map(([k, v]) => `${k}:${createHash('sha256').update(v).digest('hex')}`).join('\n')).digest('hex');
  mkdirSync(cacheDir, { recursive: true });
  // How a thumbnail is framed, from the code that does it (the crop's whole module, its constants too), so a change to
  // the shared measure or crop draws them again.
  const ink = inkBoundsSource();
  const crop = readFileSync(fileURLToPath(new URL('../../src/main/runtime/component-thumbs.ts', import.meta.url)), 'utf8');
  const framing = createHash('sha256').update(JSON.stringify([VIEW, BLOCK_VIEW, THUMB_SIZE, ink, UNPAINT_BANDS, crop, String(frameOf)])).digest('hex');

  const docs = cases.map((c, i) => {
    const { body, head } = module.render(module.pages[i], { props: {} });
    const html = previewHtml(css, head, body, c.block);
    const key = createHash('sha256').update(`${RENDERER}\n${framing}\n${fontKey}\n${html}`).digest('hex');
    return { c, html, cached: join(cacheDir, `${key}.webp`) };
  });
  rmSync(dir, { recursive: true, force: true });

  const missing = docs.filter((d) => !existsSync(d.cached));
  // The browser is only started when something needs drawing, and whether it can start is what counts.
  const { chromium } = await import('playwright');
  const browser = missing.length
    ? await chromium.launch().catch((e: Error) => {
        const message = `Drawing ${missing.length} theme preview${missing.length === 1 ? '' : 's'} needs Playwright’s Chromium (${e.message.split('\n')[0]}). Run "npx playwright install chromium", then build again.`;
        if (opts.require) throw new Error(message);
        // Development carries on without them: Insert shows a sketch where a thumbnail is missing.
        console.warn(`${pack.id}: ${message} Building without them.`);
        return null;
      })
    : null;
  if (browser) {
    try {
      const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce' });
      let current = '';
      // The page and its fonts come from memory; nothing else may load.
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === '/styles/preview.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: current });
        const font = url.pathname.startsWith('/fonts/') ? fontBytes.get(url.pathname.slice('/fonts/'.length)) : undefined;
        return font ? route.fulfill({ contentType: 'font/woff2', body: font }) : route.abort();
      });
      for (const d of missing) {
        current = d.html;
        await page.setViewportSize(d.c.block ? BLOCK_VIEW : VIEW);
        await page.goto(`${ORIGIN}/styles/preview.html`, { waitUntil: 'load' });
        await page.evaluate('document.fonts.ready.then(() => undefined)');
        const png = await page.screenshot({ clip: await frameOf(page, ink, d.c.block), type: 'png' });
        writeFileSync(d.cached, await sharp(png).resize(THUMB_SIZE).webp({ quality: 80, effort: 6 }).toBuffer());
      }
    } finally {
      await browser.close();
    }
  }

  const previews: Record<string, ComponentPreviews> = {};
  const bytes = new Map<string, Buffer>();
  for (const { c, cached } of docs) {
    if (!existsSync(cached)) continue;
    const file = previewFile(c.componentId, c.axis, c.option);
    bytes.set(file, readFileSync(cached));
    if (!c.axis) previews[c.componentId] = { ...previews[c.componentId], default: file };
    else (((previews[c.componentId] ??= { default: '' }).variants ??= {})[c.axis] ??= {})[c.option!] = file;
  }
  // A variant's thumbnail is only listed beside its section's own.
  for (const [id, p] of Object.entries(previews)) if (!p.default) delete previews[id];
  return { previews, bytes: new Map([...bytes].filter(([f]) => Object.values(previews).some((p) => p.default === f || Object.values(p.variants ?? {}).some((o) => Object.values(o).includes(f))))), drawn: browser ? missing.length : 0 };
}
