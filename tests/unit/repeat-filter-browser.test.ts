/**
 * Category filters on repeated cards in a real browser (#382). The exported page, rendered on the server with every
 * card, hydrates without a mismatch; its pills then work by pointer and keyboard, one placement at a time, say which is
 * pressed and announce how many cards show; All shows every card again. Printed, every card shows and the pills do not.
 * A category no card names any more shows every card. In the editor, with the real preview bridge, a click on a pill in
 * Edit selects instead of filtering, while Preview filters, and a card the filter hides is shown again when the
 * inspector opens it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComponentDefinition, ListItem, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { defFile, generateProject } from '@generator/index';
import { P } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://filters.test';
const SESSION = 'so-test';
const GEN = '\0gen:';

/** Four projects: two homes, a shop and a church. */
const ITEMS: ListItem[] = [
  { id: 'h1', title: 'Hill house', category: 'Residential' },
  { id: 's1', title: 'Corner shop', category: 'Commercial' },
  { id: 'h2', title: 'Lake house', category: 'Residential' },
  { id: 'c1', title: 'Old chapel', category: 'Restoration' }
];

/** A project whose Home places, twice, a card grid filtered by each card's category. */
function project(): { s: ProjectState; def: ComponentDefinition } {
  const s = createStarterState('blank', 'Test Studio', false);
  const def: ComponentDefinition = {
    ...FOUNDATION.managed({
      componentId: 'test.projects',
      name: 'Projects',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      description: '',
      properties: {
        filterable: P.bool('Filter by category', true),
        items: P.list('Projects', 'Project', { title: P.str('Title', ''), category: P.str('Category', '') }, ITEMS, { titleField: 'title' })
      },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('wrap', 'div', {}, [
            b.el('grid', 'ul', { styles: { layout: 'grid', columns: 2 } }, [b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.text('title', 'h3', { $item: 'title' })])], { filter: { field: 'category', when: { $prop: 'filterable' } } })])
          ])
        ])
    }),
    owner: 'project'
  };
  s.components[def.id] = def;
  const home = s.pages[s.site.homePageId];
  for (let i = 0; i < 2; i++) {
    const node = makeInstance(def, {});
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
  }
  return { s, def };
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The exported Home page rendered on the server, hydration markers and all, as the static site ships it. */
async function serverHtml(files: Map<string, string>): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'repeat-filter-browser-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of files) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body;
}

/**
 * The site's page, the editor's variant of it, and the design on its own with a list the test can change (`setItems`),
 * compiled for the browser into one script.
 */
async function bundle(clean: Map<string, string>, dev: Map<string, string>, file: string): Promise<string> {
  const wrapper = `<script>\n\timport Projects from '../clean/${file}';\n\tlet items = $state(${JSON.stringify(ITEMS)});\n\twindow.setItems = (next) => (items = next);\n</script>\n\n<Projects filterable={true} {items} />\n`;
  const files = new Map<string, string>([
    ...[...clean].map(([p, src]) => [`clean/${p}`, src] as [string, string]),
    ...[...dev].map(([p, src]) => [`dev/${p}`, src] as [string, string]),
    ['test/Wrapper.svelte', wrapper],
    ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";'],
    ['app/navigation.js', 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};']
  ]);
  const entry = [
    "import { hydrate, mount } from 'svelte';",
    `import Clean from ${JSON.stringify(GEN + 'clean/src/routes/+page.svelte')};`,
    `import Dev from ${JSON.stringify(GEN + 'dev/src/routes/+page.svelte')};`,
    `import Wrapper from ${JSON.stringify(GEN + 'test/Wrapper.svelte')};`,
    "const target = () => document.getElementById('app');",
    "window.startSite = (variant) => (variant === 'dev' ? mount(Dev, { target: target(), props: {} }) : variant === 'wrapper' ? mount(Wrapper, { target: target(), props: {} }) : hydrate(Clean, { target: target(), props: {} }));"
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
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path);
          if (source === undefined) throw new Error(`Not generated: ${path}`);
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The site did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('generated category filters in a browser', () => {
  let browser: Browser;
  let script: string;
  let ssr: string;
  let css: string;
  beforeAll(async () => {
    const { s, def } = project();
    const clean = generateProject(s);
    const dev = generateProject(s, { instrument: true });
    ssr = await serverHtml(clean);
    css = ['tokens', 'theme', 'components', 'site'].map((f) => clean.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
    script = await bundle(clean, dev, defFile(def));
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  interface Opened {
    page: Page;
    /** The document the site is in: the page itself, or the preview frame inside the stand-in editor. */
    site: Frame;
    /** Console warnings and errors, and uncaught errors. */
    problems: string[];
  }

  /**
   * The site: the server-rendered page hydrated (`clean`), the design alone with a list the test changes (`wrapper`),
   * or the editor's variant mounted in a frame of a stand-in editor with the real preview bridge (`dev`), in Edit.
   */
  async function open(variant: 'clean' | 'dev' | 'wrapper'): Promise<Opened> {
    const page = await browser.newPage();
    const problems: string[] = [];
    // A hydration mismatch or a script error shows here. The theme's font files are not served here: those misses are not.
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const site = `<!doctype html><html lang="en"><head><style>${css}</style></head><body><div id="app">${variant === 'clean' ? ssr : ''}</div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.pathname === '/site') return route.fulfill({ contentType: 'text/html', body: site });
      if (url.pathname === '/') {
        const editor = `<!doctype html><title>Editor</title><script>window.sent = []; addEventListener('message', (e) => window.sent.push(e.data));</script><iframe name="${SESSION}" src="/site" style="width:1000px;height:700px;border:0"></iframe>`;
        return route.fulfill({ contentType: 'text/html', body: variant === 'dev' ? editor : site });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${ORIGIN}/`);
    let frame = page.mainFrame();
    if (variant === 'dev') {
      await expect.poll(() => page.frame({ name: SESSION })?.url()).toBe(`${ORIGIN}/site`);
      frame = page.frame({ name: SESSION })!;
      await frame.waitForLoadState();
    }
    await frame.addScriptTag({ url: '/app.js', type: 'module' });
    await frame.waitForFunction('typeof window.startSite === "function"');
    // Marks the server's first row of pills, so a test can tell hydration kept the server's elements.
    if (variant === 'clean') await frame.evaluate(`document.querySelector('.so-filter').fromServer = true`);
    await frame.evaluate(`window.startSite(${JSON.stringify(variant)})`);
    if (variant === 'dev') {
      await frame.addScriptTag({ url: '/bridge.js', type: 'module' });
      await frame.waitForFunction('window.__siteoriginBridge === true && document.documentElement.hasAttribute("data-so-editing")');
    }
    // The pills work once the page's script has run.
    await frame.waitForFunction(`[...document.querySelectorAll('.so-filter__pill')].every((b) => !b.disabled)`);
    return { page, site: frame, problems };
  }

  /** Sends the stand-in editor's message to the preview frame. */
  async function post({ page }: Opened, type: string, payload: unknown) {
    await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type, payload })}, '*')`);
  }
  /** Switches the preview between Edit and Preview, as the editor does. */
  async function mode(opened: Opened, to: 'edit' | 'preview') {
    await post(opened, 'mode', { mode: to });
    await opened.site.waitForFunction(`document.documentElement.hasAttribute('data-so-editing') === ${to === 'edit'}`);
  }

  /**
   * Each placement's pills as [label, pressed], the titles of the cards showing on screen, and what its status says.
   * (Scripts run in the page are written as strings: this file is type-checked without the DOM's types.)
   */
  const state = (site: Frame) =>
    site.evaluate(`[...document.querySelectorAll('.so-filter')].map((bar) => ({
      pills: [...bar.querySelectorAll('button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-pressed')]),
      shown: [...bar.nextElementSibling.children].filter((li) => getComputedStyle(li).display !== 'none').map((li) => li.textContent.trim()),
      status: bar.querySelector('[role="status"]').textContent.trim()
    }))`) as Promise<Array<{ pills: string[][]; shown: string[]; status: string }>>;
  const pressed = (pills: string[][]) => pills.filter((p) => p[1] === 'true').map((p) => p[0]);
  const ALL = ['Hill house', 'Corner shop', 'Lake house', 'Old chapel'];
  const LABELS = ['All', 'Residential', 'Commercial', 'Restoration'];

  it('hydrates the exported page and filters each placement’s cards by pointer and keyboard, All showing them again', async () => {
    const { page, site, problems } = await open('clean');
    try {
      expect(await site.evaluate(`document.querySelector('.so-filter').fromServer === true`)).toBe(true);
      expect(await state(site)).toEqual([...Array(2)].map(() => ({ pills: LABELS.map((l) => [l, String(l === 'All')]), shown: ALL, status: '4 items showing' })));
      const first = site.locator('.so-filter').first();
      await first.getByRole('button', { name: 'Residential' }).click();
      await expect.poll(async () => (await state(site))[0]).toEqual({ pills: LABELS.map((l) => [l, String(l === 'Residential')]), shown: ['Hill house', 'Lake house'], status: '2 items showing' });
      // The other placement keeps its own choice.
      expect((await state(site))[1].shown).toEqual(ALL);
      // From the keyboard: the next pill is a Tab away, and Enter or Space presses it.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(await site.evaluate(`document.activeElement.textContent.trim()`)).toBe('Restoration');
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await state(site))[0]).toMatchObject({ shown: ['Old chapel'], status: '1 item showing' });
      expect(pressed((await state(site))[0].pills)).toEqual(['Restoration']);
      await first.getByRole('button', { name: 'All' }).focus();
      await page.keyboard.press('Space');
      await expect.poll(async () => (await state(site))[0]).toMatchObject({ shown: ALL, status: '4 items showing' });
      expect(pressed((await state(site))[0].pills)).toEqual(['All']);
      // The status is a polite live region, read out when it changes.
      expect(await site.evaluate(`document.querySelector('.so-filter [role="status"]').getAttribute('role')`)).toBe('status');
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('prints every card and leaves the pills out, whatever is chosen on screen', async () => {
    const { page, site, problems } = await open('clean');
    try {
      await site.locator('.so-filter').first().getByRole('button', { name: 'Commercial' }).click();
      await expect.poll(async () => (await state(site))[0].shown).toEqual(['Corner shop']);
      await page.emulateMedia({ media: 'print' });
      const printed = (await site.evaluate(`({
        bars: [...document.querySelectorAll('.so-filter')].map((b) => getComputedStyle(b).display),
        cards: [...document.querySelectorAll('li')].filter((li) => getComputedStyle(li).display !== 'none').length
      })`)) as { bars: string[]; cards: number };
      expect(printed).toEqual({ bars: ['none', 'none'], cards: 8 });
      await page.emulateMedia({ media: 'screen' });
      expect((await state(site)).map((p) => p.shown)).toEqual([['Corner shop'], ALL]);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('shows every card when no card names the chosen category any more, and no pills under two categories', async () => {
    const opened = await open('wrapper');
    const { page, site, problems } = opened;
    try {
      await site.getByRole('button', { name: 'Commercial' }).click();
      await expect.poll(async () => (await state(site))[0].shown).toEqual(['Corner shop']);
      // The shop is recategorised: nothing is Commercial now.
      await site.evaluate(`window.setItems(${JSON.stringify(ITEMS.map((it) => (it.id === 's1' ? { ...it, category: 'Residential' } : it)))})`);
      await expect.poll(() => state(site)).toEqual([{ pills: [['All', 'true'], ['Residential', 'false'], ['Restoration', 'false']], shown: ALL, status: '4 items showing' }]);
      // Choosing Residential, then leaving it the only category: the pills go and every card shows.
      await site.getByRole('button', { name: 'Residential' }).click();
      await expect.poll(async () => (await state(site))[0].shown).toEqual(['Hill house', 'Corner shop', 'Lake house']);
      await site.evaluate(`window.setItems(${JSON.stringify(ITEMS.map((it) => ({ ...it, category: it.id === 'c1' ? '' : 'Residential' })))})`);
      await expect.poll(() => state(site)).toEqual([]);
      expect(await site.evaluate(`[...document.querySelectorAll('li')].filter((li) => getComputedStyle(li).display !== 'none').length`)).toBe(4);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('in Edit selects what holds a pill that is clicked and filters nothing; Preview filters; opening a hidden card shows it', async () => {
    const opened = await open('dev');
    const { page, site } = opened;
    try {
      const selects = () => page.evaluate(`window.sent.filter((m) => m.type === 'select').map((m) => m.payload.chain?.[0]?.node)`) as Promise<string[]>;
      const first = site.locator('.so-filter').first();
      await first.getByRole('button', { name: 'Commercial' }).click();
      await expect.poll(selects).toEqual(['wrap']);
      expect((await state(site)).map((p) => p.shown)).toEqual([ALL, ALL]);
      await mode(opened, 'preview');
      await first.getByRole('button', { name: 'Commercial' }).click();
      await expect.poll(async () => (await state(site))[0].shown).toEqual(['Corner shop']);
      await mode(opened, 'edit');
      // The filter's choice stays in Edit until the inspector opens a card it hides: then every card shows again.
      expect((await state(site))[0].shown).toEqual(['Corner shop']);
      // Each placement has items of its own, with IDs of their own: the Lake house's, in the first placement.
      const lake = site.locator('[data-so-node="card"]', { hasText: 'Lake house' }).first();
      const [ctx, id] = await Promise.all([lake.getAttribute('data-so-ctx'), lake.getAttribute('data-so-items')]);
      expect(await lake.isVisible()).toBe(false);
      await post(opened, 'reveal', { target: { ctx, list: 'items', items: id, nodes: ['card'], within: { card: 0, title: 0 } } });
      await expect.poll(async () => (await state(site))[0]).toMatchObject({ shown: ALL, status: '4 items showing' });
      expect(pressed((await state(site))[0].pills)).toEqual(['All']);
      // The second placement, never filtered, is untouched, and the card asked for is on screen.
      expect((await state(site))[1].shown).toEqual(ALL);
      expect(await lake.isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });
});
