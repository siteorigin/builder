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
const css = ['reset.css', 'layout.css'].map((f) => readFileSync(resolve('src/renderer/src/styles', f), 'utf8')).join('\n');

/**
 * The editor's shell: a toolbar, a canvas with a frame whose page is far taller than it, and a dock whose scrolling
 * body holds a long Inspector and, positioned against the dock, a marker at its static place below that content.
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
</div></div></body></html>`;

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
    // The bridge scrolls the selection into view inside the preview, which also scrolls every scrollable ancestor.
    await frame.evaluate(() => document.getElementById('hero')!.scrollIntoView({ block: 'center' }));
    expect(await frame.evaluate(() => scrollY)).toBeGreaterThan(0);
    expect(await page.evaluate(() => [scrollX, scrollY, document.scrollingElement!.scrollTop])).toEqual([0, 0, 0]);
    // Then the field in the Inspector, and back to the page.
    await page.evaluate(() => document.querySelector('.inspector')!.lastElementChild!.scrollIntoView({ block: 'end' }));
    await frame.evaluate(() => window.scrollTo(0, 0));
    await frame.evaluate(() => document.getElementById('hero')!.scrollIntoView({ block: 'center' }));
    expect(await page.evaluate(() => [scrollX, scrollY, document.scrollingElement!.scrollTop])).toEqual([0, 0, 0]);
  });
});
