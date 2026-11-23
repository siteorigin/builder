/**
 * Following a link to an anchor on a Foundation site whose sticky header is tall (a long brand and seven
 * navigation labels that wrap), in real headless browsers: the generated layout, home page and theme CSS exactly
 * as an exported site ships them, compiled for the client. A direct visit loads the rendered markup first, so the
 * browser jumps to the fragment before the site's script runs, as it does on a prerendered export.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphNode, InstanceNode, LinkValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject } from '@generator/index';

const ORIGIN = 'https://site.test';
const BRAND = 'North Harbor Architecture and Conservation';
const LABELS = ['Our studio', 'Heritage projects', 'Conservation services', 'Residential work', 'Commercial work', 'Journal', 'Visit us'];
const HEADING = 'visitor-bookmark';
const SECTION = 'opening-hours';
const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));

/** The exported site: a tall header, a short heading and a padded section with anchors, and links to both. */
function exportedSite(sticky: boolean) {
  const s = createStarterState('business', BRAND, false);
  const [homeId, aboutId, contactId] = s.site.pageOrder;
  const page = (target: string): LinkValue => ({ type: 'page', target });
  const header = s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  const targets = [homeId, aboutId, contactId];
  header.props = { ...header.props, siteName: BRAND, sticky, links: LABELS.map((label, i) => ({ id: `i${i + 1}`, label, link: page(targets[i % 3]) })) };

  const home = s.pages[homeId];
  const [hero, ...rest] = home.rootIds;
  const section = (id: string, children: GraphNode[], extra: Partial<InstanceNode> = {}) => {
    const node: InstanceNode = { ...makeInstance(s.components[installComponent(s, 'layout.section')], {}), ...extra };
    node.id = id;
    node.slots = { content: children.map((c) => c.id) };
    for (const child of [node, ...children]) home.nodes[child.id] = child;
    return node.id;
  };
  const link = (id: string, anchor: string, label: string): GraphNode => ({ id, kind: 'link', link: { type: 'anchor', target: anchor }, label, appearance: 'link' });
  const text = (id: string, tag: 'h2' | 'p', value: string, anchor?: string): GraphNode => ({ id, kind: 'text', tag, text: value, ...(anchor ? { anchor } : {}) });
  const jumps = section('n-jumps', [link('n-to-heading', HEADING, 'Plan your visit'), link('n-to-section', SECTION, 'Opening hours')]);
  // One line of heading text, so the whole heading fits behind the header.
  const bookmarked = section('n-visit', [text('n-visit-heading', 'h2', 'Visit us', HEADING), text('n-visit-copy', 'p', 'The studio is on the harbour front.')]);
  const padded = section('n-hours', [text('n-hours-heading', 'h2', 'Opening hours'), text('n-hours-copy', 'p', 'Weekdays from nine until five.')], {
    anchor: SECTION,
    overrides: { root: { base: { paddingBlock: '6rem' } } }
  });
  home.rootIds = [hero, jumps, bookmarked, padded, ...rest];
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  return { files, css };
}

/**
 * Every case's layout and home page as one script that defines `window.mountCase(name)`. Mounting ends the way
 * SvelteKit ends hydrating a page: components have mounted, then `afterNavigate` callbacks hear an `enter`.
 */
async function bundleSites(sites: Record<string, Map<string, string>>): Promise<string> {
  const src = new Map<string, string>();
  for (const [name, files] of Object.entries(sites)) {
    for (const [path, text] of files) src.set(`\0site/${name}/${path}`, text);
    src.set(`\0site/${name}/Entry.svelte`, `<script>import Layout from './src/routes/+layout.svelte'; import Page from './src/routes/+page.svelte';</script><Layout><Page /></Layout>`);
  }
  const names = Object.keys(sites);
  const entry = [
    "import { flushSync, mount } from 'svelte';",
    "import { navigated } from '$app/navigation';",
    ...names.map((n, i) => `import E${i} from '\0site/${n}/Entry.svelte';`),
    `const all = { ${names.map((n, i) => `${JSON.stringify(n)}: E${i}`).join(', ')} };`,
    "window.mountCase = (name, type = 'enter') => { mount(all[name], { target: document.getElementById('app') }); flushSync(); navigated(type); };"
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
          if (id === '\0$app/navigation')
            return "import { onMount } from 'svelte'; const callbacks = new Set(); export function afterNavigate(fn) { onMount(() => { callbacks.add(fn); return () => callbacks.delete(fn); }); } export function navigated(type) { for (const fn of callbacks) fn({ type }); }";
          const text = src.get(id);
          if (text === undefined) return null;
          return id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate: 'client', css: 'injected' }).js.code : text;
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return chunk.code;
}

interface Landing {
  top: number;
  bottom: number;
  headerBottom: number;
  viewportHeight: number;
  /** What the browser finds at the target's first row and centre: the target, the header, or something else. */
  hits: string[];
}

// Runs in the browser, so it is passed as text (the Node project has no DOM types).
const landing = (id: string) => `(() => {
  const target = document.getElementById(${JSON.stringify(id)});
  const header = document.querySelector('header.so-header');
  const t = target.getBoundingClientRect();
  const x = Math.min(Math.max(t.left + Math.min(t.width / 2, 40), 1), innerWidth - 1);
  const hits = [t.top + 2, (t.top + t.bottom) / 2].filter((y) => y >= 0 && y < innerHeight).map((y) => {
    const el = document.elementFromPoint(x, y);
    return !el ? 'nothing' : header.contains(el) ? 'header' : target.contains(el) ? 'target' : el.tagName.toLowerCase();
  });
  return { top: t.top, bottom: t.bottom, headerBottom: header.getBoundingClientRect().bottom, viewportHeight: innerHeight, hits };
})()`;

const settled = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))';

describe.each(ENGINES)('anchors below the sticky header in %s', (_name, engine) => {
  let browser: Browser;
  let script: string;
  const sites = { sticky: exportedSite(true), static: exportedSite(false) };

  beforeAll(async () => {
    const [bundled, launched] = await Promise.allSettled([
      bundleSites(Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, site.files]))),
      engine.launch({ headless: true, timeout: 30_000 })
    ]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * Opens a case the way a visitor does. `/live` mounts the site; `/` serves the markup it rendered, and the site's
   * script only takes over once the browser has loaded the page and jumped to any fragment.
   */
  async function withSite(name: keyof typeof sites, width: number, body: (page: Page) => Promise<void>) {
    // Reduced motion turns off the theme's smooth scrolling, so a jump has finished when it is measured.
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(10_000);
    try {
      const page = await context.newPage();
      const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sites[name].css}</style>`;
      let rendered = '';
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        const html = (inner: string) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en"><head>${head}</head><body>${inner}</body></html>` });
        if (path === '/live') return html(`<div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountCase(${JSON.stringify(name)})</script>`);
        return html(
          `${rendered}<script>addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => {
            const id = decodeURIComponent(location.hash.slice(1));
            window.beforeScript = id ? { top: document.getElementById(id).getBoundingClientRect().top, headerBottom: document.querySelector('header.so-header').getBoundingClientRect().bottom } : null;
            const s = document.createElement('script');
            s.src = '/site.js';
            // ?arrive= names the navigation the header mounts in; a visit starts with \`enter\`.
            s.onload = () => { const app = document.getElementById('app'); app.textContent = ''; mountCase(${JSON.stringify(name)}, new URLSearchParams(location.search).get('arrive') ?? undefined); window.started = true; };
            document.body.append(s);
          })));</script>`
        );
      });
      await page.goto(`${ORIGIN}/live`);
      await page.locator('main section').first().waitFor();
      await page.evaluate(settled);
      // The component styles Svelte injected travel with the markup, as they would in a prerendered page.
      rendered = (await page.evaluate(`[...document.head.querySelectorAll('style:not(:first-of-type)')].map((s) => s.outerHTML).join('') + document.getElementById('app').outerHTML`)) as string;
      await body(page);
    } finally {
      await context.close();
    }
  }

  /** Opens the page at an anchor in a new document, and where the browser had put the anchor before the script ran. */
  const visit = async (page: Page, id: string, query = '') => {
    await page.goto('about:blank');
    expect(await page.goto(`${ORIGIN}/${query}#${id}`), 'a new document loads').not.toBeNull();
    await page.waitForFunction('window.started === true');
    await page.evaluate(settled);
    const before = (await page.evaluate('window.beforeScript')) as { top: number; headerBottom: number };
    return { before, after: (await page.evaluate(landing(id))) as Landing };
  };

  const follow = async (page: Page, id: string) => {
    await page.evaluate('scrollTo(0, 0)');
    await page.evaluate(settled);
    await page.locator(`main a[href="#${id}"]`).click();
    await page.evaluate(settled);
    return (await page.evaluate(landing(id))) as Landing;
  };

  const describeLanding = (where: string, l: Landing) => `${where}: target ${Math.round(l.top)}..${Math.round(l.bottom)}, header ends at ${Math.round(l.headerBottom)}, hits ${l.hits.join(', ')}`;

  /** The target starts in view, below the header, and the browser finds it there rather than the header. */
  function expectRevealed(where: string, l: Landing) {
    expect(l.hits, describeLanding(where, l)).toEqual(['target', 'target'].slice(0, l.hits.length));
    expect(l.hits.length, describeLanding(where, l)).toBeGreaterThan(0);
    expect(l.top, describeLanding(where, l)).toBeGreaterThanOrEqual(Math.max(l.headerBottom, 0) - 0.5);
    expect(l.top, describeLanding(where, l)).toBeLessThan(l.viewportHeight / 2);
  }

  it.each([1024, 768, 390])('a direct visit to a heading or a section clears the sticky header at %ipx', async (width) => {
    await withSite('sticky', width, async (page) => {
      for (const id of [HEADING, SECTION]) {
        const { before, after } = await visit(page, id);
        // The browser jumped to the fragment before the script ran, using the theme's fallback margin, which a
        // header with wrapped labels covers; the collapsed phone header does not.
        expect(before.top, 'the browser jumped to the fragment before the script ran').toBeLessThan(200);
        if (width >= 768) expect(before.top, `${id} at ${width}px starts under the header`).toBeLessThan(before.headerBottom);
        expectRevealed(`${id} at ${width}px`, after);
      }
    });
  }, 60_000);

  it('a reload keeps the place the visitor scrolled to, even with the anchor under the header', async () => {
    await withSite('sticky', 1024, async (page) => {
      const { after } = await visit(page, HEADING);
      expectRevealed('direct visit', after);
      // Scrolled back just far enough for the heading to sit under the header, which a reload restores.
      await page.evaluate(`scrollBy(0, ${Math.round(after.top - after.headerBottom / 2)})`);
      await page.evaluate(settled);
      const scrolled = (await page.evaluate('scrollY')) as number;
      expect(await page.reload(), 'the page reloads').not.toBeNull();
      await page.waitForFunction('window.started === true');
      await page.evaluate(settled);
      expect((await page.evaluate('performance.getEntriesByType("navigation")[0].type')) as string).toBe('reload');
      // WebKit restores to within a few pixels; revealing the heading would move it a header's height away.
      expect(Math.abs(((await page.evaluate('scrollY')) as number) - scrolled), 'the restored position stays').toBeLessThan(20);
      const kept = (await page.evaluate(landing(HEADING))) as Landing;
      expect(kept.top, describeLanding('after the reload', kept)).toBeLessThan(kept.headerBottom);
    });
  }, 60_000);

  it('a header shown again later in a visit leaves the page where it is', async () => {
    await withSite('sticky', 1024, async (page) => {
      // The header mounts during a back navigation, as it does returning from a page without the site shell.
      const { before, after } = await visit(page, HEADING, '?arrive=popstate');
      expect(before.top, 'the heading starts under the header').toBeLessThan(before.headerBottom);
      expect(after.top, describeLanding('after the header mounts', after)).toBe(before.top);
    });
  }, 60_000);

  it('links to a heading and a section clear the header as the viewport width changes', async () => {
    await withSite('sticky', 1024, async (page) => {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction('window.started === true');
      for (const width of [1024, 768, 390, 1280, 1024]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(settled);
        for (const id of [HEADING, SECTION]) expectRevealed(`link to ${id} at ${width}px`, await follow(page, id));
      }
    });
  }, 60_000);

  it('without a sticky header, anchors land at the top of the window', async () => {
    await withSite('static', 1024, async (page) => {
      // A direct visit keeps the place the browser chose, since nothing covers it.
      expectRevealed('direct visit', (await visit(page, HEADING)).after);
      for (const width of [1024, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(settled);
        for (const id of [HEADING, SECTION]) {
          const l = await follow(page, id);
          expectRevealed(`link to ${id} at ${width}px`, l);
          expect(l.top, describeLanding(`link to ${id} at ${width}px`, l)).toBeLessThanOrEqual(32);
        }
      }
    });
  }, 60_000);
});
