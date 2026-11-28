/**
 * Back and Forward put an exported site's page back where the visitor left it at once, even though its theme scrolls
 * smoothly (#1542). Runs the generated runtime/history-scroll.js in real Chromium, on a page with the Foundation
 * theme's `html { scroll-behavior: smooth }`, beside a stand-in for SvelteKit 3.4.0's router that restores the way
 * the real one does: it turns the browser's restoration off, keeps each history entry's position, and puts it back
 * with a plain scrollTo() from its own popstate listener (after a microtask within the page, once the next page is
 * drawn for another page). Like SvelteKit's, that listener is added once the layout has mounted.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_SCROLL_JS } from "@generator/runtime-files";
import { generateProject } from "@generator/index";
import { createStarterState } from "@catalogue/starters";

const ORIGIN = "https://site.test";
const browserInstalled = existsSync(chromium.executablePath());

// Svelte's onMount, outside a component: the layout has mounted.
const SVELTE = "export function onMount(fn) { window.unmounts.push(fn()); }";
const NAVIGATION = `export function beforeNavigate(fn) { window.before.push(fn); }
export function afterNavigate(fn) { window.after.push(fn); }`;
/**
 * The router. Its popstate listener is added by startRouter(), after the layout has mounted, as SvelteKit adds its
 * own after hydrating. A link to a section
 * of the page is left to the browser, which follows it (smoothly); the entry it makes is then stamped with an index.
 * A move to the other page is a pushState. A traversal to the other page waits for window.release() before the
 * page is drawn, as a page loading would.
 */
const ROUTER = `
const KEY = 'sveltekit:metadata';
const positions = {};
let index = 1;
history.scrollRestoration = 'manual';
history.replaceState({ [KEY]: { historyIndex: index } }, '', location.href);
window.restored = 0;
window.before = [];
window.after = [];
window.unmounts = [];
const draw = () => (document.getElementById('page').dataset.page = location.pathname);
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
  scrollTo(0, 0);
});
window.startRouter = () => addEventListener('popstate', async (event) => {
  const to = event.state?.[KEY]?.historyIndex;
  if (!to || to === index) return;
  positions[index] = { x: scrollX, y: scrollY };
  index = to;
  const scroll = positions[to];
  if (document.getElementById('page').dataset.page === location.pathname) {
    await undefined;
    if (scroll) scrollTo(scroll.x, scroll.y);
    window.restored++;
    return;
  }
  let done;
  const complete = new Promise((f) => (done = f));
  const navigation = { type: 'popstate', complete };
  for (const fn of window.before) fn(navigation);
  await new Promise((r) => (window.release = r));
  draw();
  if (scroll) scrollTo(scroll.x, scroll.y);
  window.restored++;
  done();
  for (const fn of window.after) fn(navigation);
});
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

const scrollY = () => page.evaluate<number>("Math.round(scrollY)");
/** The page's position over the next few frames, from the frame after the router has restored it. */
const settled = () =>
  page.evaluate<number[]>(`(async () => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push(Math.round(scrollY));
    }
    return out;
  })()`);
const scrollBehavior = () =>
  page.evaluate<string>(
    "getComputedStyle(document.documentElement).scrollBehavior",
  );
/** Scrolls the page to `y` and follows the link to the section from there. */
async function jump(y: number) {
  await page.evaluate(`scrollTo({ top: ${y}, behavior: 'instant' })`);
  await page.evaluate("document.getElementById('to-section').click()");
  await page.waitForFunction(
    `history.state?.['sveltekit:metadata']?.historyIndex === 2`,
  );
}
async function back(restoredBefore: number) {
  await page.evaluate("history.back()");
  await page.waitForFunction(`window.restored > ${restoredBefore}`);
}

describe.skipIf(!browserInstalled)(
  "Back and Forward on a smoothly scrolling site, in Chromium",
  () => {
    beforeAll(async () => {
      browser = await chromium.launch({
        headless: true,
        executablePath: chromium.executablePath(),
      });
      page = await browser.newPage({
        viewport: { width: 390, height: 800 },
        reducedMotion: "no-preference",
      });
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === "/history-scroll.js")
          return route.fulfill({
            contentType: "text/javascript",
            body: HISTORY_SCROLL_JS,
          });
        if (url.pathname === "/svelte.js")
          return route.fulfill({
            contentType: "text/javascript",
            body: SVELTE,
          });
        if (url.pathname === "/navigation.js")
          return route.fulfill({
            contentType: "text/javascript",
            body: NAVIGATION,
          });
        return route.fulfill({ contentType: "text/html", body: PAGE });
      });
    }, 30000);
    beforeEach(async () => {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction("window.started === true");
    });
    afterAll(async () => {
      await browser?.close();
    });

    it("puts the page back where the visitor left it at once on Back from a section", async () => {
      await jump(120);
      await page.waitForFunction("scrollY > 6000");
      // The jump has come to rest.
      await expect.poll(scrollY).toBeGreaterThan(6300);
      await page.waitForTimeout(1500);
      const at = await scrollY();
      await back(0);
      expect(await scrollY()).toBe(120);
      expect(await settled()).toEqual([120, 120, 120, 120]);
      // Forward returns to the section as quickly.
      await page.evaluate("history.forward()");
      await page.waitForFunction("window.restored > 1");
      expect(await scrollY()).toBe(at);
      expect(await settled()).toEqual([at, at, at, at]);
    });

    it("puts the page back on Back pressed while the jump is still scrolling", async () => {
      await jump(0);
      await page.waitForFunction("scrollY > 400");
      await back(0);
      expect(await settled()).toEqual([0, 0, 0, 0]);
    });

    it("keeps jumps from links smooth after Back", async () => {
      await jump(0);
      await page.waitForTimeout(1500);
      await back(0);
      await settled();
      expect(await scrollBehavior()).toBe("smooth");
      expect(
        await page.evaluate<string>(`document.documentElement.style.cssText`),
      ).toBe("");
      await page.evaluate("document.getElementById('to-section').click()");
      // A smooth jump is on its way after one frame, not there.
      await page.evaluate(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
      expect(await scrollY()).toBeLessThan(6000);
    });

    it("puts the page back at once on Back to another page, once that page is drawn", async () => {
      await page.evaluate(`scrollTo({ top: 2500, behavior: 'instant' })`);
      await page.evaluate("document.getElementById('to-other').click()");
      await page.waitForFunction(`location.pathname === '/other/'`);
      await page.evaluate("history.back()");
      await page.waitForFunction('typeof window.release === "function"');
      // While the page loads, the visitor's position is not taken from them.
      expect(await scrollBehavior()).toBe("auto");
      await page.evaluate("window.release()");
      await page.waitForFunction("window.restored > 0");
      expect(await scrollY()).toBe(2500);
      expect(await settled()).toEqual([2500, 2500, 2500, 2500]);
      expect(await scrollBehavior()).toBe("smooth");
    });

    it("leaves the page alone once the layout has gone", async () => {
      await page.evaluate("for (const stop of window.unmounts) stop?.()");
      await jump(120);
      await page.waitForTimeout(1500);
      await back(0);
      // The router's restore is smooth again: under way, not there.
      expect(await scrollY()).toBeGreaterThan(120);
    });
  },
);

describe("the generated root layout", () => {
  it("keeps Back and Forward instant on every site", () => {
    const files = generateProject(
      createStarterState("business", "Studio", false),
    );
    expect(files.get("src/lib/siteorigin/runtime/history-scroll.js")).toBe(
      HISTORY_SCROLL_JS,
    );
    const layout = files.get("src/routes/+layout.svelte") ?? "";
    expect(layout).toContain(
      "import { keepHistoryScroll } from '../lib/siteorigin/runtime/history-scroll.js';",
    );
    expect(layout).toMatch(/^\tkeepHistoryScroll\(\);$/m);
  });
});
