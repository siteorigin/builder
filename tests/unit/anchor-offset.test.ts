/**
 * Following a link to an anchor on a Foundation site whose sticky header is tall (a long brand and seven
 * navigation labels that wrap), in real headless browsers: the generated layout, home page and theme CSS exactly
 * as an exported site ships them, compiled for the client. A direct visit loads the rendered markup first, so the
 * browser jumps to the fragment before the site's script runs, as it does on a prerendered export.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { chromium, webkit, type Browser, type BrowserType, type Page, type Route } from 'playwright';
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
/** Where a revealed target lands below the header: the theme's 1rem, give or take rounding. */
const GAP = { min: 15, max: 18 };

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
 * SvelteKit ends hydrating a page: components have mounted, `afterNavigate` callbacks hear an `enter`, and the
 * router takes over scroll restoration.
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
    "window.mountCase = (name, type = 'enter') => { mount(all[name], { target: document.getElementById('app') }); flushSync(); navigated(type); history.scrollRestoration = 'manual'; };"
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
            return "import { onMount } from 'svelte'; const callbacks = new Set(); export function afterNavigate(fn) { onMount(() => { callbacks.add(fn); return () => callbacks.delete(fn); }); } export function navigated(type) { for (const fn of callbacks) fn({ type }); } export function beforeNavigate() {}";
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
  scrollY: number;
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
  return { top: t.top, bottom: t.bottom, headerBottom: header.getBoundingClientRect().bottom, viewportHeight: innerHeight, scrollY, hits };
})()`;

const settled = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))';
/** Resolves once the page has not scrolled for eight frames: a smooth jump and the header's reveal are both over. */
const atRest = `new Promise((done) => {
  let last = NaN, still = 0, frames = 0;
  const step = () => { still = scrollY === last ? still + 1 : 0; last = scrollY; if (still >= 8 || ++frames > 400) done(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
})`;

if (!ENGINES.length) describe.skip('anchors below the sticky header (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

describe.each(ENGINES)('anchors below the sticky header in %s', (_name, engine) => {
  let browser: Browser;
  let script: string;
  const sites = { sticky: exportedSite(true), static: exportedSite(false) };

  beforeAll(async () => {
    const [bundled, launched] = await Promise.allSettled([
      bundleSites(Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, site.files]))),
      engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 })
    ]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  interface Site {
    page: Page;
    /** Lets the held web font finish (failing), so `document.fonts.ready` resolves. */
    releaseFont: () => Promise<void>;
  }

  /**
   * Opens a case the way a visitor does. `/live` mounts the site; `/` serves the markup it rendered, and the site's
   * script only takes over once the browser has loaded the page and jumped to any fragment. Before it does, it
   * returns to a saved position as SvelteKit does on a reload or (`?restore`) in a reopened tab. `?arrive=` names
   * the navigation the header mounts in (a visit starts with `enter`); `?font` adds a web font the test holds back.
   */
  async function withSite(name: keyof typeof sites, width: number, body: (site: Site) => Promise<void>, motion: 'reduce' | 'no-preference' = 'reduce') {
    // Reduced motion turns off the theme's smooth scrolling, so a jump has finished when it is measured.
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: motion });
    context.setDefaultTimeout(10_000);
    const held: Route[] = [];
    try {
      const page = await context.newPage();
      const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sites[name].css}</style>`;
      let rendered = '';
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        if (path === '/held.woff2') return void held.push(route);
        const html = (inner: string) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="en"><head>${head}</head><body>${inner}</body></html>` });
        if (path === '/live') return html(`<div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountCase(${JSON.stringify(name)})</script>`);
        return html(
          `${rendered}<script>
          addEventListener('pagehide', () => sessionStorage.setItem('saved-scroll', String(scrollY)));
          addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() => {
            const params = new URLSearchParams(location.search);
            const id = decodeURIComponent(location.hash.slice(1));
            window.beforeScript = id ? { top: document.getElementById(id).getBoundingClientRect().top, headerBottom: document.querySelector('header.so-header').getBoundingClientRect().bottom } : null;
            const saved = sessionStorage.getItem('saved-scroll');
            if (saved !== null && (params.has('restore') || performance.getEntriesByType('navigation')[0].type === 'reload')) {
              history.scrollRestoration = 'manual';
              scrollTo({ top: Number(saved), behavior: 'instant' });
            }
            if (params.has('font')) {
              const font = new FontFace('Held', 'url(/held.woff2)');
              document.fonts.add(font);
              font.load().catch(() => {});
            }
            const s = document.createElement('script');
            s.src = '/site.js';
            s.onload = () => { const app = document.getElementById('app'); app.textContent = ''; mountCase(${JSON.stringify(name)}, params.get('arrive') ?? undefined); window.started = true; };
            document.body.append(s);
          })));</script>`
        );
      });
      await page.goto(`${ORIGIN}/live`);
      await page.locator('main section').first().waitFor();
      await page.evaluate(settled);
      // The component styles Svelte injected travel with the markup, as they would in a prerendered page.
      rendered = (await page.evaluate(`[...document.head.querySelectorAll('style:not(:first-of-type)')].map((s) => s.outerHTML).join('') + document.getElementById('app').outerHTML`)) as string;
      const releaseFont = async () => {
        await Promise.all(held.splice(0).map((r) => r.fulfill({ status: 404, body: '' })));
      };
      await body({ page, releaseFont });
    } finally {
      await Promise.all(held.splice(0).map((r) => r.abort().catch(() => {})));
      await context.close();
    }
  }

  /** Opens the page at an anchor in a new document, and where the browser had put the anchor before the script ran. */
  const visit = async (page: Page, id: string, query = '') => {
    await page.goto('about:blank');
    expect(await page.goto(`${ORIGIN}/${query}#${id}`), 'a new document loads').not.toBeNull();
    await page.waitForFunction('window.started === true');
    await page.evaluate(atRest);
    const before = (await page.evaluate('window.beforeScript')) as { top: number; headerBottom: number };
    return { before, after: (await page.evaluate(landing(id))) as Landing };
  };

  const follow = async (page: Page, id: string) => {
    await page.evaluate('scrollTo({ top: 0, behavior: "instant" })');
    await page.evaluate(settled);
    await page.locator(`main a[href="#${id}"]`).click();
    await page.evaluate(atRest);
    return (await page.evaluate(landing(id))) as Landing;
  };

  const describeLanding = (where: string, l: Landing) => `${where}: target ${Math.round(l.top)}..${Math.round(l.bottom)}, header ends at ${Math.round(l.headerBottom)}, hits ${l.hits.join(', ')}`;

  /** The target is in view, below the header, and the browser finds it there rather than the header. */
  function expectClear(where: string, l: Landing) {
    expect(l.hits.length, describeLanding(where, l)).toBeGreaterThan(0);
    expect(l.hits, describeLanding(where, l)).toEqual(['target', 'target'].slice(0, l.hits.length));
    expect(l.top, describeLanding(where, l)).toBeGreaterThanOrEqual(Math.max(l.headerBottom, 0) - 0.5);
    expect(l.top, describeLanding(where, l)).toBeLessThan(l.viewportHeight / 2);
  }

  /** Clear, and 1rem below whatever covers the top of the window: the header while it sticks, or nothing. */
  function expectLanded(where: string, l: Landing) {
    expectClear(where, l);
    const gap = l.top - Math.max(l.headerBottom, 0);
    expect(gap, describeLanding(where, l)).toBeGreaterThanOrEqual(GAP.min);
    expect(gap, describeLanding(where, l)).toBeLessThanOrEqual(GAP.max);
  }

  it.each([1024, 768, 390])('a direct visit to a heading or a section clears the sticky header at %ipx', async (width) => {
    await withSite('sticky', width, async ({ page }) => {
      for (const id of [HEADING, SECTION]) {
        const { before, after } = await visit(page, id);
        // The browser jumped to the fragment before the script ran, using the theme's 5.5rem fallback margin.
        expect(before.top, `${id} at ${width}px: the browser jumped to the fragment before the script ran`).toBeCloseTo(88, 0);
        if (width >= 768) {
          // Wrapped labels make the header taller than that; the script reveals what it covers.
          expect(before.top, `${id} at ${width}px starts under the header`).toBeLessThan(before.headerBottom);
          expectLanded(`${id} at ${width}px`, after);
        } else {
          // The collapsed phone header is shorter, so the target was already clear and stays where it is.
          expect(before.top, `${id} at ${width}px starts clear of the header`).toBeGreaterThanOrEqual(before.headerBottom);
          expectClear(`${id} at ${width}px`, after);
          expect(Math.abs(after.top - before.top), describeLanding(`${id} at ${width}px`, after)).toBeLessThan(1);
        }
      }
    });
  }, 60_000);

  it('a direct visit with smooth scrolling clears the header once the jump comes to rest', async () => {
    await withSite(
      'sticky',
      1024,
      async ({ page }) => {
        expect(await page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(false);
        const { before, after } = await visit(page, HEADING);
        // The theme's smooth jump was still on its way when the script ran.
        expect(before.top, 'the jump was still moving when the script ran').toBeGreaterThan(200);
        expectLanded('after the smooth jump', after);
      },
      'no-preference'
    );
  }, 60_000);

  it('a web font that makes the header taller after the visit lands is revealed again, unless the visitor has scrolled', async () => {
    await withSite('sticky', 1024, async ({ page, releaseFont }) => {
      const grow = () => page.addStyleTag({ content: '.so-header__inner { padding-block: 40px; }' });
      const { after } = await visit(page, HEADING, '?font');
      expectLanded('before the font loads', after);
      expect(await page.evaluate('document.fonts.status'), 'the font is still loading').toBe('loading');
      await grow();
      await page.evaluate(settled);
      const covered = (await page.evaluate(landing(HEADING))) as Landing;
      expect(covered.top, describeLanding('the taller header covers the heading', covered)).toBeLessThan(covered.headerBottom);
      await releaseFont();
      await page.waitForFunction('document.fonts.status === "loaded"');
      await page.evaluate(atRest);
      expectLanded('after the font loads', (await page.evaluate(landing(HEADING))) as Landing);

      // The visitor scrolls while the font loads: the page stays where they put it.
      await visit(page, HEADING, '?font');
      await grow();
      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, -40);
      await page.evaluate(atRest);
      const moved = (await page.evaluate(landing(HEADING))) as Landing;
      await releaseFont();
      await page.waitForFunction('document.fonts.status === "loaded"');
      await page.evaluate(atRest);
      const kept = (await page.evaluate(landing(HEADING))) as Landing;
      expect(kept.scrollY, describeLanding('after the font loads', kept)).toBe(moved.scrollY);
      expect(kept.top, describeLanding('after the font loads', kept)).toBeLessThan(kept.headerBottom);
    });
  }, 60_000);

  it('a reload or a reopened tab keeps the restored place, even with the anchor under the header', async () => {
    await withSite('sticky', 1024, async ({ page }) => {
      for (const reopen of [false, true]) {
        const { after } = await visit(page, HEADING);
        expectLanded('direct visit', after);
        // Scrolled back just far enough for the heading to sit under the header; that position is saved on leaving.
        await page.evaluate(`scrollBy({ top: ${Math.round(after.top - after.headerBottom / 2)}, behavior: 'instant' })`);
        await page.evaluate(settled);
        const scrolled = (await page.evaluate('scrollY')) as number;
        if (reopen) {
          await page.goto('about:blank');
          expect(await page.goto(`${ORIGIN}/?restore#${HEADING}`), 'the tab reopens').not.toBeNull();
        } else expect(await page.reload(), 'the page reloads').not.toBeNull();
        await page.waitForFunction('window.started === true');
        await page.evaluate(atRest);
        expect((await page.evaluate('performance.getEntriesByType("navigation")[0].type')) as string).toBe(reopen ? 'navigate' : 'reload');
        const kept = (await page.evaluate(landing(HEADING))) as Landing;
        expect(kept.scrollY, describeLanding(reopen ? 'reopened' : 'reloaded', kept)).toBe(scrolled);
        expect(kept.top, describeLanding(reopen ? 'reopened' : 'reloaded', kept)).toBeLessThan(kept.headerBottom);
      }
    });
  }, 60_000);

  it('a header shown again later in a visit leaves the page where it is', async () => {
    await withSite('sticky', 1024, async ({ page }) => {
      // The header mounts during a back navigation, as it does returning from a page without the site shell.
      const { before, after } = await visit(page, HEADING, '?arrive=popstate');
      expect(before.top, 'the heading starts under the header').toBeLessThan(before.headerBottom);
      expect(Math.abs(after.top - before.top), describeLanding('after the header mounts', after)).toBeLessThan(1);
    });
  }, 60_000);

  it('links to a heading and a section land 1rem below the header as the viewport width changes', async () => {
    await withSite('sticky', 1024, async ({ page }) => {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction('window.started === true');
      const heights: number[] = [];
      for (const width of [1024, 768, 390, 1280, 768]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(settled);
        heights.push((await page.evaluate(`document.querySelector('header.so-header').getBoundingClientRect().height`)) as number);
        for (const id of [HEADING, SECTION]) expectLanded(`link to ${id} at ${width}px`, await follow(page, id));
      }
      // Each step changes the header's height, so a stale offset in either direction shows.
      for (let i = 1; i < heights.length; i++) expect(heights[i], `header heights ${heights.join(', ')}`).not.toBeCloseTo(heights[i - 1], 0);
    });
  }, 60_000);

  it('without a sticky header, links land 1rem from the top and a direct visit stays where the browser put it', async () => {
    await withSite('static', 1024, async ({ page }) => {
      for (const id of [HEADING, SECTION]) {
        const { before, after } = await visit(page, id);
        expectClear(`direct visit to ${id}`, after);
        expect(Math.abs(after.top - before.top), describeLanding(`direct visit to ${id}`, after)).toBeLessThan(1);
      }
      for (const width of [1024, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(settled);
        for (const id of [HEADING, SECTION]) expectLanded(`link to ${id} at ${width}px`, await follow(page, id));
      }
    });
  }, 60_000);
});
