/**
 * A visually hidden status in a scrolling panel, in a real browser (issue #829). The Pages panel keeps an `sr-only`
 * status after its list, directly in the panel's unpositioned scrolling body, so its containing block is the side
 * panel and the body's clip does not reach it. At its static position below a long list it made the document taller
 * than the window, and scrolling a page row into view then slid the whole editor up. The editor's own reset and
 * layout styles must keep it inside the window.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const css = ['reset.css', 'layout.css'].map((f) => readFileSync(resolve('src/renderer/src/styles', f), 'utf8')).join('\n');

/** The editor's shell at its default size: a side panel whose body scrolls a list far taller than the window. */
const shell = (rows: number) => `<!doctype html><html><head><style>${css}</style>
<style>html, body, #root { height: 100%; margin: 0; } .editor { height: 100%; display: flex; flex-direction: column; } .workspace { flex: 1; min-height: 0; display: flex; }</style></head>
<body><div id="root"><div class="editor"><div class="workspace">
  <aside class="side-panel" style="width: 260px">
    <div class="panel-body">
      <div class="list-wrap" style="position: relative">${Array.from({ length: rows }, (_, i) => `<div class="row" style="height: 41px">Page ${i}</div>`).join('')}</div>
      <span class="sr-only" role="status">Moved in Pages only.</span>
    </div>
  </aside>
  <main style="flex: 1"></main>
</div></div></div></body></html>`;

describe.skipIf(!browserInstalled)('a visually hidden status in a scrolling panel, in a browser', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('does not stretch the document past the window', async () => {
    await page.setContent(shell(40));
    const { scrollHeight, innerHeight } = (await page.evaluate(`({ scrollHeight: document.documentElement.scrollHeight, innerHeight })`)) as { scrollHeight: number; innerHeight: number };
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight);
  });

  it('leaves the editor in place when the last row is scrolled into view', async () => {
    await page.setContent(shell(40));
    const top = await page.evaluate(`(() => {
      const rows = document.querySelectorAll('.row');
      rows[rows.length - 1].scrollIntoView({ block: 'center' });
      return document.scrollingElement.scrollTop;
    })()`);
    expect(top).toBe(0);
    // The panel's own body did the scrolling.
    expect(await page.evaluate(`document.querySelector('.panel-body').scrollTop`)).toBeGreaterThan(0);
  });
});
