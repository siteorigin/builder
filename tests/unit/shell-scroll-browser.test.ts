/**
 * The editor's shell never scrolls as a whole, in a real browser with the editor's own stylesheets. Something laid out
 * past the window's edge (a visually hidden status line in a panel that scrolls, positioned against the panel's
 * frame rather than its scroller) made the document taller than the window; with the body's overflow hidden nobody
 * could scroll it by hand, but scrollIntoView and focus did, and shifted the whole editor up under its toolbar (seen
 * at 1536×767, a 1920×1080 screen at 125%). Overlays fixed to the window are still shown in full.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://shell.test';
const STYLES = resolve('src/renderer/src/styles');

// The shape of the editor: the toolbar, the canvas and the dock, whose panel body scrolls and holds a visually hidden
// status line after a long form (as the Inspector's announcer is), and a menu fixed to the window's corner.
const SHELL = `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/styles/index.css"></head><body>
<div id="root">
  <div class="editor">
    <header id="toolbar">Toolbar</header>
    <div style="display: flex; min-height: 0">
      <main style="flex: 1">Canvas</main>
      <aside class="dock" style="width: 320px">
        <div class="panel-body insp" id="insp">
          <div style="height: 1500px">Fields</div>
          <button id="deep">Last field</button>
          <p class="sr-only" role="status">Saved</p>
        </div>
      </aside>
    </div>
    <footer>Status</footer>
  </div>
  <div id="menu" role="menu" style="position: fixed; right: 8px; bottom: 8px; width: 160px; height: 120px; background: red">Menu</div>
</div>
</body></html>`;

let browser: Browser;
let page: Page;

describe.skipIf(!browserInstalled)('the editor shell', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ viewport: { width: 1536, height: 767 } });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: SHELL });
      const css = /^\/styles\/([\w-]+\.css)$/.exec(url.pathname);
      if (css && existsSync(resolve(STYLES, css[1]))) return route.fulfill({ contentType: 'text/css', body: readFileSync(resolve(STYLES, css[1]), 'utf8') });
      return route.abort();
    });
    await page.goto(`${ORIGIN}/`);
    // The editor's own layout applies: the dock is the status line's containing block, and its panel body scrolls.
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.dock')).position`)).toBe('relative');
    expect(await page.evaluate(`getComputedStyle(document.querySelector('.sr-only')).position`)).toBe('absolute');
    expect(await page.evaluate(`getComputedStyle(document.getElementById('insp')).overflowY`)).toBe('auto');
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('is no taller than the window, whatever a panel lays out past its edge', async () => {
    expect(await page.evaluate(`document.scrollingElement.scrollHeight`)).toBe(767);
    expect(await page.evaluate(`document.scrollingElement.scrollWidth`)).toBe(1536);
  });

  it('stays put when a field deep in a panel is scrolled to or focused, and the panel scrolls instead', async () => {
    await page.evaluate(`document.getElementById('deep').scrollIntoView({ block: 'end' })`);
    await page.evaluate(`document.getElementById('deep').focus()`);
    await page.evaluate(`document.querySelector('.sr-only').scrollIntoView()`);
    expect(await page.evaluate(`document.scrollingElement.scrollTop`)).toBe(0);
    expect(await page.evaluate(`document.getElementById('toolbar').getBoundingClientRect().top`)).toBe(0);
    expect(await page.evaluate(`document.getElementById('insp').scrollTop`)).toBeGreaterThan(0);
    // Asked outright, the shell does not move either.
    await page.evaluate(`window.scrollTo(0, 400); document.scrollingElement.scrollTop = 400`);
    expect(await page.evaluate(`document.scrollingElement.scrollTop`)).toBe(0);
  });

  it('still shows a menu fixed to the window in full', async () => {
    const corners = await page.evaluate<string[]>(`(() => {
      const r = document.getElementById('menu').getBoundingClientRect();
      return [[r.left + 1, r.top + 1], [r.right - 1, r.bottom - 1]].map(([x, y]) => document.elementFromPoint(x, y)?.id ?? '');
    })()`);
    expect(corners).toEqual(['menu', 'menu']);
  });
});
