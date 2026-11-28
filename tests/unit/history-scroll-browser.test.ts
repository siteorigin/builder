/**
 * Back and Forward put an exported site's page back where the visitor left it at once, even though its theme scrolls
 * smoothly (#1542). Runs the generated runtime/history-scroll.js in real Chromium, on a page with the Foundation
 * theme's `html { scroll-behavior: smooth }`, beside a stand-in for SvelteKit 3.4.0's router that restores the way
 * the real one does: it turns the browser's restoration off, keeps each history entry's position, and puts it back
 * with a plain scrollTo(x, y): within the page from its popstate listener after a microtask, for another page once
 * that page is put in place after onNavigate (before `complete` settles), and from its pageshow listener for a page
 * back from the back/forward cache. Like SvelteKit's, its listeners are added once the layout has mounted.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_SCROLL_JS } from '@generator/runtime-files';
import { generateProject } from '@generator/index';
import { createStarterState } from '@catalogue/starters';

const ORIGIN = 'https://site.test';
const browserInstalled = existsSync(chromium.executablePath());

// Svelte's onMount, outside a component: the layout has mounted.
const SVELTE = 'export function onMount(fn) { window.unmounts.push(fn()); }';
const NAVIGATION = 'export function onNavigate(fn) { window.onNavigates.push(fn); }';
/**
 * The router. A link to a section of the page is left to the browser, which follows it (smoothly); the entry it
 * makes is then stamped with an index. A move to the other page is a pushState. A traversal to the other page waits
 * for window.release(ok) before the page is put in place, as a page loading would; release(false) cancels it before
 * onNavigate, release('abort') ends it after onNavigate, as a newer navigation would, and release('strand') stops
 * after onNavigate without settling, as SvelteKit does when another onNavigate callback throws.
 * Every scrollTo the router makes to restore is logged with the page's position and scroll-behavior just after.
 */
const ROUTER = `
const KEY = 'sveltekit:metadata';
const positions = {};
let index = 1;
history.scrollRestoration = 'manual';
history.replaceState({ [KEY]: { historyIndex: index } }, '', location.href);
window.restores = [];
window.onNavigates = [];
window.unmounts = [];
const draw = () => (document.getElementById('page').dataset.page = location.pathname);
const restore = (scroll) => {
  // Code that keeps the window's scrollTo while the page is put back.
  window.keptScrollTo = window.scrollTo;
  scrollTo(scroll.x, scroll.y);
  window.restores.push({ to: scroll.y, at: Math.round(scrollY), behavior: getComputedStyle(document.documentElement).scrollBehavior });
};
document.addEventListener('click', (event) => {
  const a = event.target.closest('a');
  if (!a) return;
  positions[index] = { x: scrollX, y: scrollY };
  if (a.getAttribute('href').startsWith('#')) {
    addEventListener('hashchange', () => history.replaceState({ [KEY]: { historyIndex: ++index } }, '', location.href), { once: true });
    return;
  }
  event.preventDefault();
  history.pushState({ [KEY]: { historyIndex: ++index } }, '', a.href);
  draw();
  scrollTo({ top: 0, behavior: 'instant' });
});
window.startRouter = () => {
  addEventListener('popstate', async (event) => {
    const to = event.state?.[KEY]?.historyIndex;
    if (!to || to === index) return;
    positions[index] = { x: scrollX, y: scrollY };
    index = to;
    const scroll = positions[to] ?? { x: 0, y: 0 };
    if (document.getElementById('page').dataset.page === location.pathname) {
      await undefined;
      restore(scroll);
      return;
    }
    let fulfil, reject;
    const complete = new Promise((f, r) => ((fulfil = f), (reject = r)));
    complete.catch(() => {});
    const navigation = { type: 'popstate', complete };
    const ok = await new Promise((r) => (window.release = r));
    if (!ok) return reject(new Error('navigation cancelled'));
    for (const fn of window.onNavigates) fn(navigation);
    await undefined;
    if (ok === 'abort') return reject(new Error('navigation aborted'));
    // Another onNavigate callback threw: SvelteKit stops, and the navigation never settles.
    if (ok === 'strand') return;
    draw();
    restore(scroll);
    fulfil();
  });
  addEventListener('pagehide', () => (positions[index] = { x: scrollX, y: scrollY }));
  addEventListener('pageshow', (event) => {
    if (event.persisted) restore(positions[index] ?? { x: 0, y: 0 });
  });
};
`;
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>html { scroll-behavior: smooth; } body { margin: 0; } .tall { height: 6000px; }</style>
<script type="importmap">{"imports":{"svelte":"/svelte.js","$app/navigation":"/navigation.js"}}</script>
<script>${ROUTER}</script>
<script type="module">import { keepHistoryScroll } from '/history-scroll.js'; keepHistoryScroll(); startRouter(); window.started = true;</script>
</head><body><main id="page" data-page="/">
<div style="height: 400px"><a id="to-section" href="#hours">Opening hours</a> <a id="to-other" href="/other/">Another page</a></div>
<div class="tall"></div><h2 id="hours">Opening hours</h2><div class="tall"></div>
</main></body></html>`;

let browser: Browser;
let page: Page;

const scrollY = () => page.evaluate<number>('Math.round(scrollY)');
const restores = () => page.evaluate<Array<{ to: number; at: number; behavior: string }>>('window.restores');
/** Where the page is over the next few frames. */
const frames = () =>
  page.evaluate<number[]>(`(async () => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push(Math.round(scrollY));
    }
    return out;
  })()`);
const scrollBehavior = () => page.evaluate<string>('getComputedStyle(document.documentElement).scrollBehavior');
const inlineStyle = () => page.evaluate<string>('document.documentElement.style.cssText');
const scrollTo = (y: number) => page.evaluate(`scrollTo({ top: ${y}, behavior: 'instant' })`);
/** Follows the link to the section and waits for the smooth jump to come to rest there. */
async function jump() {
  const target = await page.evaluate<number>(`(async () => {
    // The scroll that ends at the section, not one before it.
    const ended = new Promise((r) => {
      const on = () => scrollY > 6000 && (removeEventListener('scrollend', on), r());
      addEventListener('scrollend', on);
    });
    document.getElementById('to-section').click();
    await ended;
    return Math.round(scrollY);
  })()`);
  expect(target).toBeGreaterThan(6000);
  return target;
}
async function traverse(how: 'back' | 'forward') {
  const count = (await restores()).length;
  await page.evaluate(`history.${how}()`);
  await page.waitForFunction(`window.restores.length > ${count}`);
  return (await restores())[count];
}

describe.skipIf(!browserInstalled)('Back and Forward on a smoothly scrolling site, in Chromium', () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: chromium.executablePath()
    });
    page = await browser.newPage({
      viewport: { width: 390, height: 800 },
      reducedMotion: 'no-preference'
    });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/history-scroll.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: HISTORY_SCROLL_JS
        });
      if (url.pathname === '/svelte.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: SVELTE
        });
      if (url.pathname === '/navigation.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: NAVIGATION
        });
      return route.fulfill({ contentType: 'text/html', body: PAGE });
    });
  }, 30000);
  beforeEach(async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction('window.started === true');
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('puts the page back where the visitor left it at once on Back from a section, and Forward', async () => {
    await scrollTo(120);
    const at = await jump();
    expect(await traverse('back')).toEqual({
      to: 120,
      at: 120,
      behavior: 'auto'
    });
    expect(await frames()).toEqual([120, 120, 120, 120]);
    expect(await traverse('forward')).toEqual({
      to: at,
      at,
      behavior: 'auto'
    });
    expect(await frames()).toEqual([at, at, at, at]);
  });

  it('puts the page back on Back pressed while the jump is still scrolling', async () => {
    // Back from the page itself, part of the way down, so the jump is certainly still under way.
    const midway = await page.evaluate<number>(`new Promise((resolve) => {
      const on = () => {
        if (scrollY < 1500) return;
        removeEventListener('scroll', on);
        resolve(Math.round(scrollY));
        history.back();
      };
      addEventListener('scroll', on);
      document.getElementById('to-section').click();
    })`);
    expect(midway).toBeLessThan(5000);
    await page.waitForFunction('window.restores.length > 0');
    expect((await restores())[0]).toEqual({ to: 0, at: 0, behavior: 'auto' });
    // The stopped jump's last step, in the next frame, is put back.
    expect(await frames()).toEqual([0, 0, 0, 0]);
  });

  it('keeps jumps from links smooth after Back, and the page root’s own scroll-behavior', async () => {
    await page.evaluate(`document.documentElement.style.setProperty('scroll-behavior', 'smooth', 'important')`);
    await jump();
    await traverse('back');
    await frames();
    expect(await inlineStyle()).toBe('scroll-behavior: smooth !important;');
    expect(await page.evaluate<boolean>('window.scrollTo.toString().includes("[native code]")')).toBe(true);
    // A smooth jump goes by the positions in between.
    const first = await page.evaluate<number>(`new Promise((resolve) => {
      addEventListener('scroll', () => resolve(Math.round(scrollY)), { once: true });
      document.getElementById('to-section').click();
    })`);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6000);
  });

  it('leaves a popstate SvelteKit keeps no position for alone', async () => {
    // Read in the same task, while a hold would still stand.
    expect(await page.evaluate<string>(`dispatchEvent(new PopStateEvent('popstate', { state: null })), document.documentElement.style.cssText`)).toBe('');
    expect(await page.evaluate<string>(`dispatchEvent(new PopStateEvent('popstate', { state: { other: 1 } })), document.documentElement.style.cssText`)).toBe(
      ''
    );
  });

  it('puts the page back at once on Back to another page, as that page is put in place', async () => {
    await scrollTo(2500);
    await page.evaluate("document.getElementById('to-other').click()");
    await scrollTo(4000);
    await page.evaluate('history.back()');
    await page.waitForFunction('typeof window.release === "function"');
    // While the page loads, nothing is held: the brief hold for the popstate has ended.
    await page.evaluate('new Promise((r) => setTimeout(r, 50))');
    expect(await scrollBehavior()).toBe('smooth');
    await page.evaluate('window.release(true)');
    await page.waitForFunction('window.restores.length > 0');
    expect((await restores())[0]).toEqual({
      to: 2500,
      at: 2500,
      behavior: 'auto'
    });
    expect(await frames()).toEqual([2500, 2500, 2500, 2500]);
    expect(await scrollBehavior()).toBe('smooth');
    expect(await inlineStyle()).toBe('');
  });

  it.each([
    ['cancelled before it is put in place', 'false'],
    ['aborted as it is put in place', "'abort'"]
  ])('holds nothing after a Back to another page is %s', async (_how, ok) => {
    await page.evaluate("document.getElementById('to-other').click()");
    await page.evaluate('history.back()');
    await page.waitForFunction('typeof window.release === "function"');
    await page.evaluate(`window.release(${ok})`);
    await page.evaluate('new Promise((r) => setTimeout(r, 50))');
    expect(await inlineStyle()).toBe('');
    expect(await page.evaluate<boolean>('window.scrollTo.toString().includes("[native code]")')).toBe(true);
  });

  it('leaves the window’s scrollTo working for code that kept it during a Back', async () => {
    await scrollTo(120);
    await jump();
    await traverse('back');
    await frames();
    // The window's own again: instant when asked, and as the page's smooth scrolling has it otherwise.
    expect(await page.evaluate<number>(`window.keptScrollTo({ top: 70, behavior: 'instant' }), Math.round(scrollY)`)).toBe(70);
    await page.evaluate('window.keptScrollTo(0, 2000)');
    await expect.poll(scrollY).toBe(2000);
  });

  it('lets a scroll asked for after Back win over putting back a stopped jump', async () => {
    await page.evaluate(
      `addEventListener('popstate', async (event) => { if (!event.state) return; await undefined; await undefined; scrollTo({ top: 330, behavior: 'instant' }); })`
    );
    await page.evaluate(`new Promise((resolve) => {
      const on = () => {
        if (scrollY < 1500) return;
        removeEventListener('scroll', on);
        resolve();
        history.back();
      };
      addEventListener('scroll', on);
      document.getElementById('to-section').click();
    })`);
    await page.waitForFunction('window.restores.length > 0');
    expect(await frames()).toEqual([330, 330, 330, 330]);
  });

  it('ends a hold for a Back to another page that never settles at the next Back or Forward', async () => {
    await page.evaluate("document.getElementById('to-other').click()");
    await page.evaluate('history.back()');
    await page.waitForFunction('typeof window.release === "function"');
    await page.evaluate(`window.release('strand')`);
    await page.evaluate('new Promise((r) => setTimeout(r, 50))');
    expect(await inlineStyle()).toBe('scroll-behavior: auto !important;');
    await page.evaluate('history.forward()');
    await page.waitForFunction('typeof window.release === "function"');
    await page.evaluate(`window.release(false)`);
    await page.evaluate('new Promise((r) => setTimeout(r, 50))');
    expect(await inlineStyle()).toBe('');
  });

  it('puts a page back from the back/forward cache at once', async () => {
    await scrollTo(1800);
    await jump();
    // The page is shown again where its entry was left, from wherever it had got to.
    await page.evaluate(
      `window.restores = []; dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); scrollTo({ top: 300, behavior: 'instant' }); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`
    );
    const shown = (await restores())[0];
    expect(shown.to).toBeGreaterThan(6000);
    expect(shown).toEqual({ to: shown.to, at: shown.to, behavior: 'auto' });
    expect(await frames()).toEqual([shown.to, shown.to, shown.to, shown.to]);
    expect(await inlineStyle()).toBe('');
    // A first showing holds nothing.
    expect(
      await page.evaluate<string>(`dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })), document.documentElement.style.cssText`)
    ).toBe('');
  });

  it('leaves the page alone once the layout has gone', async () => {
    await page.evaluate('for (const stop of window.unmounts) stop?.()');
    await scrollTo(120);
    await jump();
    // The router's restore glides again: under way, not there.
    expect((await traverse('back')).behavior).toBe('smooth');
    await page.evaluate(`window.restores = []; dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    expect((await restores())[0].behavior).toBe('smooth');
  });
});

describe('the generated root layout', () => {
  it('keeps Back and Forward instant on every site', () => {
    const files = generateProject(createStarterState('business', 'Studio', false));
    expect(files.get('src/lib/siteorigin/runtime/history-scroll.js')).toBe(HISTORY_SCROLL_JS);
    const layout = files.get('src/routes/+layout.svelte') ?? '';
    expect(layout).toContain("import { keepHistoryScroll } from '../lib/siteorigin/runtime/history-scroll.js';");
    expect(layout).toMatch(/^\tkeepHistoryScroll\(\);$/m);
  });
});
