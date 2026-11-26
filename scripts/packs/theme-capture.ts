/**
 * Theme capture harness: draws the built-in themes as a visitor sees them, so a theme's design can be reviewed in real
 * pixels. Opt-in only, never part of a build or a test run:
 *
 *   DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] [THEMES=editorial,signal] npx tsx --tsconfig tsconfig.node.json scripts/packs/theme-capture.ts
 *
 * For each theme it writes:
 *   - `{theme}--page-{home|about|contact}--{width}.png`: the Business starter's pages with its sample pictures, header
 *     and footer, whole, at desktop width (and the home page at 1024 and 390 as well);
 *   - `{theme}--{componentId}[--{axis}-{option}].png`: every section and block on a page of its own, with its defaults
 *     and once per variant option, as the Insert thumbnails are drawn (scripts/packs/previews.ts);
 *   - `{theme}--stress-{name}.png`: the Services grid with two, four, five and six cards, and with linked cards, where a
 *     layout that only suits three shows its holes.
 * Pages are generated and server-rendered exactly as an exported site prerenders them, and photographed in headless
 * Chromium with the pack's own fonts. A page that paints nothing, or a font that does not load, throws rather than
 * writing an image.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { GraphNode, NodeTree, PageDoc, ProjectState } from '@shared/types';
import { BUILTIN_PACKS } from '@catalogue/builtin';
import { registerPacks } from '@catalogue/index';
import { createStarterState, STARTER_ASSETS } from '@catalogue/starters';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { makeInstance } from '@engine/install';
import { buildPack } from '../../src/main/packs/build';
import { bundlePages, previewHtml, previewProject } from './previews';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('theme capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}

const root = process.cwd();
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'themes');
mkdirSync(OUT, { recursive: true });
const THEMES = (process.env.THEMES ?? 'foundation,editorial,signal').split(',');
const ORIGIN = 'http://theme.capture';
const ASSETS = join(root, 'resources', 'starter-assets');

/** Every node of `tree`, copied into `into`, keyed by ID. */
const copyNodes = (tree: NodeTree, into: Record<string, GraphNode>) => {
  for (const [id, n] of Object.entries(tree.nodes)) into[id] = structuredClone(n);
};

/** The Business starter with its sample pictures, each page given its header and footer as sections of its own. */
async function starterState(themeId: string): Promise<{ state: ProjectState; pages: Array<{ name: string; pageId: string }> }> {
  const state = createStarterState('business', 'Harbour Lane', true, themeId);
  const createdAt = new Date().toISOString();
  for (const a of STARTER_ASSETS) {
    const meta = await sharp(join(ASSETS, a.source)).metadata();
    state.assets.assets[a.id] = { id: a.id, name: a.name, file: `static/samples/${a.source}`, mime: 'image/jpeg', bytes: 1, width: meta.width, height: meta.height, hash: a.id, kind: 'image', createdAt };
  }
  const pages: Array<{ name: string; pageId: string }> = [];
  for (const pageId of [...state.site.pageOrder]) {
    const page: PageDoc = state.pages[pageId];
    const nodes: Record<string, GraphNode> = {};
    copyNodes(state.site.shell.header, nodes);
    copyNodes(page, nodes);
    copyNodes(state.site.shell.footer, nodes);
    const id = `${pageId}_whole`;
    state.pages[id] = { ...page, id, route: `${page.route}whole/`, rootIds: [...state.site.shell.header.rootIds, ...page.rootIds, ...state.site.shell.footer.rootIds], nodes };
    state.site.pageOrder.push(id);
    pages.push({ name: page.title.toLowerCase(), pageId: id });
  }
  return { state, pages };
}

interface Shot {
  file: string;
  html: string;
  width: number;
  /** A block with nothing to show by default (a video with no source) is left out rather than failed. */
  mayBeEmpty?: boolean;
}

/** Server-render the given pages of `state`, each as a whole document. */
async function render(state: ProjectState, pageIds: string[]): Promise<string[]> {
  const generated = generateProject(state);
  const css = ['tokens.css', 'theme.css', 'components.css', 'site.css'].map((f) => generated.get(`${STYLES_DIR}/${f}`) ?? '').join('\n');
  const { module, dir } = await bundlePages(generated, pageIds.map((id) => pageFile(state.pages[id])));
  try {
    return pageIds.map((_, i) => {
      const { body, head } = module.render(module.pages[i], { props: {} });
      return previewHtml(css, head, body, false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const written: string[] = [];
try {
  for (const themeId of THEMES) {
    const authored = BUILTIN_PACKS.find((p) => p.id === themeId);
    if (!authored) throw new Error(`No built-in theme "${themeId}".`);
    const { pack, files } = buildPack(authored, root);
    registerPacks([pack]);
    const fonts = new Map([...files].filter(([rel]) => rel.startsWith('fonts/')).map(([rel, abs]) => [rel.slice('fonts/'.length), readFileSync(abs)]));

    const shots: Shot[] = [];
    const starter = await starterState(themeId);
    const pageHtml = await render(starter.state, starter.pages.map((p) => p.pageId));
    starter.pages.forEach((p, i) => {
      shots.push({ file: `${themeId}--page-${p.name}--1280.png`, html: pageHtml[i], width: 1280 });
      if (p.name === 'home') for (const width of [1024, 390]) shots.push({ file: `${themeId}--page-home--${width}.png`, html: pageHtml[i], width });
    });
    const preview = previewProject(pack);
    // The Services grid with other numbers of cards, and with each card a link.
    const grid = Object.values(preview.state.components).find((d) => d.componentId === 'features.grid');
    if (!grid) throw new Error(`${themeId} has no Services grid installed for the stress states.`);
    const sample = (grid.properties.items as { default: Array<Record<string, unknown>> }).default;
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...sample[i % sample.length], id: `s${i}`, title: `${sample[i % sample.length].title} ${i + 1}` }));
    const stress: Array<[string, Record<string, unknown>]> = [
      ['features-2', { items: many(2) }],
      ['features-4', { items: many(4) }],
      ['features-5', { items: many(5) }],
      ['features-6', { items: many(6) }],
      ['features-linked', { items: many(3).map((it) => ({ ...it, linkLabel: 'Learn more', link: { type: 'url', target: 'https://example.com/' } })) }]
    ];
    const stressPages = stress.map(([name, props]) => {
      const pageId = `pg_stress_${name.replace(/-/g, '_')}`;
      const node = makeInstance(grid, props);
      const home = preview.state.pages[preview.state.site.homePageId];
      preview.state.pages[pageId] = { ...structuredClone(home), id: pageId, title: name, route: `/stress-${name}/`, rootIds: [node.id], nodes: { [node.id]: node } };
      preview.state.site.pageOrder.push(pageId);
      return { name, pageId };
    });
    const caseHtml = await render(preview.state, [...preview.cases.map((c) => c.pageId), ...stressPages.map((p) => p.pageId)]);
    stressPages.forEach((p, i) => shots.push({ file: `${themeId}--stress-${p.name}.png`, html: caseHtml[preview.cases.length + i], width: 1280 }));
    preview.cases.forEach((c, i) => {
      const name = [themeId, c.componentId, ...(c.axis ? [`${c.axis}-${c.option}`] : [])].join('--');
      // A block is shown in a column of a three-up grid, as it is placed.
      const html = c.block ? caseHtml[i].replace('<main id="main">', '<main id="main" style="max-width:420px;margin:40px auto;padding:0 16px">') : caseHtml[i];
      shots.push({ file: `${name}.png`, html, width: 1280, mayBeEmpty: c.block });
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce' });
    let current = '';
    const failedFonts: string[] = [];
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/capture.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: current });
      if (url.pathname.startsWith('/fonts/')) {
        const font = fonts.get(url.pathname.slice('/fonts/'.length));
        if (!font) failedFonts.push(url.pathname);
        return font ? route.fulfill({ contentType: 'font/woff2', body: font }) : route.abort();
      }
      if (url.pathname.startsWith('/samples/')) return route.fulfill({ contentType: 'image/jpeg', body: readFileSync(join(ASSETS, url.pathname.slice('/samples/'.length))) });
      return route.abort();
    });
    for (const s of shots) {
      current = s.html;
      await page.setViewportSize({ width: s.width, height: 800 });
      await page.goto(`${ORIGIN}/capture.html`, { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready.then(() => undefined)');
      // Every picture loads now (a lazy one below the window would never start), and each is decoded before the photograph.
      await page.evaluate(`Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.decode().catch(() => null); }))`);
      const broken = await page.evaluate(`[...document.images].filter((i) => !i.naturalWidth).length`);
      if (broken) throw new Error(`${s.file}: ${broken} pictures did not load; refusing to write`);
      const box = await page.locator('#main').boundingBox();
      if (s.mayBeEmpty && (!box || box.height < 20)) {
        console.log(`${s.file}: paints nothing with its defaults; left out`);
        continue;
      }
      if (!box || box.height < 20) throw new Error(`${s.file}: the page painted nothing; refusing to write`);
      if (failedFonts.length) throw new Error(`${s.file}: fonts did not load: ${failedFonts.join(', ')}`);
      const path = join(OUT, s.file);
      await page.screenshot({ path, fullPage: true });
      written.push(path);
    }
    await page.close();
    console.log(`${themeId}: ${shots.length} captures`);
  }
} finally {
  await browser.close();
}
const onDisk = new Set(readdirSync(OUT));
const lost = written.filter((p) => !onDisk.has(p.slice(OUT.length + 1)));
if (lost.length) throw new Error(`${lost.length} captures are missing from ${OUT}`);
console.log(`theme capture: ${written.length} images in ${OUT}`);
