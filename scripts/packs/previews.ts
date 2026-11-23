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
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import sharp from 'sharp';
import type { ProjectState } from '@shared/types';
import { catalogueEntries, registerPacks } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { previewFile, type ComponentPreviews, type ThemePack } from '@catalogue/pack';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';

/** What the photograph shows: the top of the section at desktop width, in the 16:10 shape of an Insert tile. */
const VIEW = { width: 1280, height: 800 };
const THUMB_WIDTH = 320;
/** Part of every cache key, so a change to how thumbnails are drawn draws them all again. */
const RENDERER = 'preview-v1';
const ORIGIN = 'http://pack.preview';
const GEN = '\0gen:';

interface Case {
  componentId: string;
  axis?: string;
  option?: string;
  pageId: string;
}

/** A project holding one page per thumbnail, each with a single section. */
function previewProject(pack: ThemePack): { state: ProjectState; cases: Case[] } {
  const state = createStarterState('blank', 'Studio', false);
  state.site.themeId = pack.id;
  const template = state.pages[state.site.homePageId];
  const cases: Case[] = [];
  for (const entry of catalogueEntries(pack.id)) {
    const def = state.components[installComponent(state, entry.componentId)];
    const options = [undefined, ...Object.entries(def.variantAxes ?? {}).flatMap(([axis, a]) => Object.keys(a.options).filter((o) => o !== a.default).map((option) => ({ axis, option })))];
    for (const o of options) {
      const pageId = `pg_preview${cases.length}`;
      const node = makeInstance(def, {}, o ? { [o.axis]: o.option } : undefined);
      state.pages[pageId] = { ...structuredClone(template), id: pageId, title: entry.name, route: `/preview-${cases.length}/`, rootIds: [node.id], nodes: { [node.id]: node } };
      state.site.pageOrder.push(pageId);
      cases.push({ componentId: entry.componentId, ...o, pageId });
    }
  }
  return { state, cases };
}

interface Rendered {
  render: (component: unknown, options: { props: Record<string, unknown> }) => { body: string; head: string };
  pages: unknown[];
}

/** Bundle every preview page for the server, the way the exported site's prerender does. */
async function bundlePages(files: Map<string, string>, pages: string[]): Promise<{ module: Rendered; dir: string }> {
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
 * Draw the thumbnails of every component and variant option of a pack. `files` maps each pack file (its fonts)
 * to its source on disk. Returns the previews map for the manifest and the image bytes by release path.
 */
export async function renderPreviews(pack: ThemePack, files: Map<string, string>, cacheDir: string): Promise<{ previews: Record<string, ComponentPreviews>; bytes: Map<string, Buffer> }> {
  registerPacks([pack]);
  const { state, cases } = previewProject(pack);
  const generated = generateProject(state);
  const css = ['tokens.css', 'theme.css', 'components.css', 'site.css'].map((f) => generated.get(`${STYLES_DIR}/${f}`) ?? '').join('\n');
  const { module, dir } = await bundlePages(generated, cases.map((c) => pageFile(state.pages[c.pageId])));
  const fontBytes = new Map([...files].filter(([rel]) => rel.startsWith('fonts/')).map(([rel, abs]) => [rel.slice('fonts/'.length), readFileSync(abs)]));
  const fontKey = createHash('sha256').update([...fontBytes].map(([k, v]) => `${k}:${createHash('sha256').update(v).digest('hex')}`).join('\n')).digest('hex');
  mkdirSync(cacheDir, { recursive: true });

  const docs = cases.map((c, i) => {
    const { body, head } = module.render(module.pages[i], { props: {} });
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style>${head.replace(/<title>[^<]*<\/title>/, '')}<style>html{scroll-behavior:auto}*{animation:none!important;transition:none!important}</style></head><body><main id="main">${body}</main></body></html>`;
    const key = createHash('sha256').update(`${RENDERER}\n${VIEW.width}x${VIEW.height}\n${fontKey}\n${html}`).digest('hex');
    return { c, html, cached: join(cacheDir, `${key}.webp`) };
  });
  rmSync(dir, { recursive: true, force: true });

  const missing = docs.filter((d) => !existsSync(d.cached));
  if (missing.length) {
    const { chromium } = await import('playwright');
    if (!existsSync(chromium.executablePath())) throw new Error('Drawing theme previews needs Playwright’s Chromium. Run "npx playwright install chromium", then build again.');
    const browser = await chromium.launch();
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
        await page.goto(`${ORIGIN}/styles/preview.html`, { waitUntil: 'load' });
        await page.evaluate('document.fonts.ready.then(() => undefined)');
        const png = await page.screenshot({ clip: { x: 0, y: 0, ...VIEW }, type: 'png' });
        writeFileSync(d.cached, await sharp(png).resize({ width: THUMB_WIDTH }).webp({ quality: 80, effort: 6 }).toBuffer());
      }
    } finally {
      await browser.close();
    }
  }

  const previews: Record<string, ComponentPreviews> = {};
  const bytes = new Map<string, Buffer>();
  for (const { c, cached } of docs) {
    const file = previewFile(c.componentId, c.axis, c.option);
    bytes.set(file, readFileSync(cached));
    const p = (previews[c.componentId] ??= { default: file });
    if (c.axis) ((p.variants ??= {})[c.axis] ??= {})[c.option!] = file;
  }
  return { previews, bytes };
}
