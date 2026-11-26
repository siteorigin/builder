/**
 * The editor's document never scrolls, in a real browser (issue #897). Content in the Inspector, positioned against
 * the dock rather than its scrolling body, sat past the window's bottom edge, so the document was taller than its
 * window, and the preview's scrollIntoView on a selection then slid the whole editor up, toolbar and all. The editor's
 * own styles must keep whatever a panel holds inside the window, so the document stays at zero through a selection.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const css = ['tokens.css', 'reset.css', 'layout.css'].map((f) => readFileSync(resolve('src/renderer/src/styles', f), 'utf8')).join('\n');

/**
 * The editor's shell: a toolbar, a canvas with a frame whose page is far taller than it, and a dock whose scrolling
 * body holds a long Inspector and, positioned against the dock, a marker at its static place below that content. One
 * more, directly under #root, is placed below the window against no positioned ancestor of its own.
 */
const shell = `<!doctype html><html><head><style>${css}</style>
<style>.toolbar { height: 44px; } .canvas { flex: 1; min-width: 0; } .canvas iframe { width: 100%; height: 100%; border: 0; display: block; }</style></head>
<body><div id="root"><div class="editor">
  <header class="toolbar">Undo Redo Export</header>
  <div class="workspace">
    <main class="canvas"><iframe srcdoc="<!doctype html><body style='margin:0'><div style='height:3000px'></div><h1 id='hero' style='margin:0'>Hero</h1><div style='height:3000px'></div></body>"></iframe></main>
    <aside class="dock" style="width: 340px">
      <div class="panel-body">
        <div class="inspector">${Array.from({ length: 30 }, (_, i) => `<div style="height: 48px">Field ${i}</div>`).join('')}</div>
        <div class="escaped" style="position: absolute; width: 20px; height: 200px"></div>
      </div>
    </aside>
  </div>
  <footer>status</footer>
</div><div class="stray" style="position: absolute; top: 120vh; width: 1px; height: 96px"></div></div></body></html>`;

describe.skipIf(!browserInstalled)('the editor document in a browser', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('is never taller than the window, whatever a panel holds', async () => {
    await page.setContent(shell);
    const { scrollHeight, innerHeight } = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight }));
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  });

  it('stays at zero through a selection that scrolls the preview', async () => {
    await page.setContent(shell);
    const frame = page.frames()[1];
    await frame.waitForSelector('#hero');
    /** The editor document's and #root's scroll positions, which must never move. */
    const editor = () => page.evaluate(() => [scrollX, scrollY, document.scrollingElement!.scrollTop, document.getElementById('root')!.scrollTop]);
    // The bridge scrolls the selection into view inside the preview, which also scrolls every scrollable ancestor.
    await frame.evaluate(() => document.getElementById('hero')!.scrollIntoView({ block: 'center' }));
    expect(await frame.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await editor()).toEqual([0, 0, 0, 0]);
    // Then a field at the Inspector's end, which its own body scrolls to.
    await page.evaluate(() => document.querySelector('.inspector')!.lastElementChild!.scrollIntoView({ block: 'end' }));
    expect(await page.locator('.panel-body').evaluate((b) => b.scrollTop)).toBeGreaterThan(0);
    expect(await editor()).toEqual([0, 0, 0, 0]);
    // And back to the page.
    await frame.evaluate(() => window.scrollTo(0, 0));
    await frame.evaluate(() => document.getElementById('hero')!.scrollIntoView({ block: 'center' }));
    expect(await editor()).toEqual([0, 0, 0, 0]);
  });

  it('keeps the startup error view inside the window', async () => {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"><div class="fatal"><p>No theme pack could be loaded.</p></div></div></body></html>`);
    const { scrollHeight, innerHeight, rootTop } = await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, innerHeight, rootTop: document.getElementById('root')!.getBoundingClientRect().top }));
    expect(rootTop).toBe(0);
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  });

  it('lets a startup error longer than the window scroll to its last reason, inside the window', async () => {
    const reasons = Array.from({ length: 80 }, (_, i) => `<li>Theme ${i} could not be read.</li>`).join('');
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="root"><div class="fatal"><p>No themes.</p><ul>${reasons}</ul></div></div></body></html>`);
    const r = await page.evaluate(() => {
      const last = document.querySelector('.fatal li:last-child')!;
      last.scrollIntoView({ block: 'end' });
      return { scrollHeight: document.documentElement.scrollHeight, innerHeight, docTop: document.scrollingElement!.scrollTop, bottom: last.getBoundingClientRect().bottom };
    });
    expect(r.scrollHeight).toBeLessThanOrEqual(r.innerHeight);
    expect(r.docTop).toBe(0);
    expect(r.bottom).toBeLessThanOrEqual(r.innerHeight);
  });
});
