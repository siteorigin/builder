/**
 * Text edited on the canvas stays clear of the site's sticky header (issue #1109): the real preview bridge, in a real
 * browser frame with smooth scrolling. The host page stands in for the editor, answering the bridge's clicks as Canvas
 * does: a click picks the outermost level first (the hero), a click again the heading inside it, neither pick is
 * scrolled to (selectOnPage, tested in page-place), and a double-click starts the edit of the heading.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HEADER = 72;
// A sticky header that publishes what it covers, as the site's own header does, over a hero taller than the frame.
const FRAME = `<!doctype html><html style="--so-header-offset:${HEADER}px"><head><style>
html{overflow-anchor:none}body{margin:0;font:16px/20px sans-serif}
header{position:sticky;top:0;z-index:5;height:${HEADER}px;background:#fff}
section{box-sizing:border-box;margin:0}h1{margin:0;font:40px/50px sans-serif;width:320px}
</style></head><body><header id="bar">Studio</header><main>
<section id="hero" data-so-ctx="page:p" data-so-node="hero" style="height:1100px;padding-top:40px"><h1 id="title" data-so-ctx="page:p" data-so-node="title">Calm, considered spaces for everyday life</h1></section>
<section id="next" data-so-ctx="page:p" data-so-node="next" style="height:1400px">Next</section>
</main><script type="module" src="/bridge.js"></script></body></html>`;

const HOST = `<!doctype html><title>host</title><body style="margin:0">
<iframe name="so-test" src="/frame" style="border:0;display:block;width:1000px;height:600px"></iframe>
<script>
  window.replies = [];
  window.post = (type, payload) => frames[0].postMessage({ protocolVersion: 1, sessionId: 'so-test', type, payload }, '*');
  const sel = (node) => ({ ctx: 'page:p', node, items: '' });
  window.selected = null;
  const select = (node) => {
    if (window.selected === node) return;
    window.selected = node;
    post('track', { selected: sel(node), hovered: null });
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    window.replies.push(m);
    if (m.type === 'select') select(window.selected ? 'title' : 'hero');
    if (m.type === 'dblclick') {
      post('beginTextEdit', { desc: sel('title'), editId: 'e1', hit: m.payload.hit });
      select('title');
    }
  });
</script>`;

/** Longer than a smooth scroll of the frame takes, and the bridge's wait for the page to stop scrolling. */
const SCROLLED_MS = 1500;
/** Between the two clicks of a double-click, as a person makes them. */
const CLICK_GAP_MS = 120;

let browser: Browser;
let page: Page;
let frame: Frame;

const started = () => expect.poll(() => page.evaluate<boolean>(`window.replies.some((m) => m.type === 'textEditStarted')`)).toBe(true);
/** Where the heading and the caret are in the frame, and where the header ends. */
const shown = () =>
  frame.evaluate<{ top: number; bottom: number; caretTop: number; caretBottom: number; header: number; height: number; scrollY: number }>(`(() => {
    const r = document.getElementById('title').getBoundingClientRect();
    const c = getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : r;
    return { top: r.top, bottom: r.bottom, caretTop: c.top, caretBottom: c.bottom, header: document.getElementById('bar').getBoundingClientRect().bottom, height: innerHeight, scrollY };
  })()`);
/** A double-click on the heading's line `line`, where it is in the frame now. */
const doubleClickLine = async (line: number) => {
  const r = await frame.evaluate<{ left: number; top: number }>(`(() => { const r = document.getElementById('title').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
  // A person's double-click, with the time between its two clicks that lets the editor answer the first.
  await page.mouse.move(r.left + 30, r.top + line * 50 + 25);
  for (const clickCount of [1, 2]) {
    if (clickCount === 2) await page.waitForTimeout(CLICK_GAP_MS);
    await page.mouse.down({ clickCount });
    await page.mouse.up({ clickCount });
  }
};

describe.skipIf(!browserInstalled)('editing a heading on the canvas under a sticky header', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ reducedMotion: 'no-preference', viewport: { width: 1100, height: 700 } });
    const origin = 'http://header.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      return route.fulfill({ contentType: 'text/html', body: HOST });
    });
  }, 20000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    await page.goto('http://header.test/');
    await page.waitForFunction(`window.replies.some((m) => m.type === 'ready')`);
    frame = page.frames()[1];
    await page.evaluate(`window.post('mode', { mode: 'edit' })`);
    await expect.poll(() => frame.evaluate(`document.documentElement.getAttribute('data-so-bridge')`)).toBe('edit');
  });

  for (const [name, width] of [['desktop', 1000], ['phone', 390]] as const) {
    it(`keeps the whole heading and the caret below the header after a double-click (${name} width)`, async () => {
      await page.evaluate(`document.querySelector('iframe').style.width = '${width}px'`);
      await doubleClickLine(0);
      await started();
      await page.waitForTimeout(SCROLLED_MS);
      const at = await shown();
      expect(at.top).toBeGreaterThanOrEqual(at.header);
      expect(at.caretTop).toBeGreaterThanOrEqual(at.header);
      expect(at.caretBottom).toBeLessThanOrEqual(at.height);
      expect(at.bottom).toBeLessThanOrEqual(at.height);
      // A heading already clear of the header is edited where it was double-clicked.
      expect(at.scrollY).toBe(0);
    });

    it(`brings a heading partly under the header clear of it as its edit begins (${name} width)`, async () => {
      await page.evaluate(`document.querySelector('iframe').style.width = '${width}px'`);
      // The author has scrolled until the first line is under the header, then double-clicks a line still showing.
      await frame.evaluate(`window.scrollTo({ top: 90, behavior: 'instant' })`);
      await doubleClickLine(1);
      await started();
      await page.waitForTimeout(SCROLLED_MS);
      const at = await shown();
      expect(at.top).toBeGreaterThanOrEqual(at.header);
      expect(at.caretTop).toBeGreaterThanOrEqual(at.header);
      expect(at.bottom).toBeLessThanOrEqual(at.height);
    });
  }

  it('starts an edit asked for from the editor clear of the header, ending a scroll still on its way', async () => {
    await frame.evaluate(`window.scrollTo({ top: 1500, behavior: 'instant' })`);
    // Edit text from the editor's menu, just after Layers asked to show the hero.
    await page.evaluate(`window.post('track', { selected: { ctx: 'page:p', node: 'hero', items: '' }, hovered: null })`);
    await page.evaluate(`window.post('scrollTo', { desc: { ctx: 'page:p', node: 'hero', items: '' }, show: true })`);
    await page.waitForTimeout(60);
    await page.evaluate(`window.post('beginTextEdit', { desc: { ctx: 'page:p', node: 'title', items: '' }, editId: 'e2' })`);
    await started();
    await page.waitForTimeout(SCROLLED_MS);
    const at = await shown();
    expect(at.top).toBeGreaterThanOrEqual(at.header);
    expect(at.bottom).toBeLessThanOrEqual(at.height);
  });

  it('stops a scroll the editor asked for where a press finds it, so a double-click stays on its word', async () => {
    await page.evaluate(`window.post('track', { selected: { ctx: 'page:p', node: 'hero', items: '' }, hovered: null })`);
    await page.evaluate(`window.post('scrollTo', { desc: { ctx: 'page:p', node: 'hero', items: '' }, show: true })`);
    await frame.evaluate(`window.scrollTo({ top: 1500, behavior: 'instant' })`);
    await page.evaluate(`window.post('scrollTo', { desc: { ctx: 'page:p', node: 'hero', items: '' }, show: true })`);
    await expect.poll(() => frame.evaluate<number>(`scrollY`)).toBeLessThan(1500);
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.up();
    // The frame the press lands in can still move.
    await page.waitForTimeout(100);
    const at = await frame.evaluate<number>(`scrollY`);
    await page.waitForTimeout(SCROLLED_MS);
    expect(await frame.evaluate<number>(`scrollY`)).toBe(at);
    // Stopped on its way, long before the hero it was headed for.
    expect(at).toBeGreaterThan(1000);
  });

  it('keeps the caret below the header as it moves up through text taller than the frame', async () => {
    await frame.evaluate(`(() => {
      const t = document.getElementById('title');
      t.innerHTML = Array.from({ length: 30 }, (_, i) => 'Line ' + i).join('<br>');
      window.scrollTo({ top: 700, behavior: 'instant' });
    })()`);
    await page.evaluate(`document.querySelector('iframe').focus()`);
    await page.evaluate(`window.post('beginTextEdit', { desc: { ctx: 'page:p', node: 'title', items: '' }, editId: 'e3' })`);
    await started();
    // The caret starts at the end; twenty lines up takes it past the top of the frame.
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);
    let at = await shown();
    expect(at.caretTop).toBeGreaterThanOrEqual(at.header);
    expect(at.caretBottom).toBeLessThanOrEqual(at.height);
    // Typing with the caret left under the header brings it out.
    await frame.evaluate(`window.scrollBy({ top: getSelection().getRangeAt(0).getBoundingClientRect().top - 30, behavior: 'instant' })`);
    await page.keyboard.type('x');
    await page.waitForTimeout(100);
    at = await shown();
    expect(at.caretTop).toBeGreaterThanOrEqual(at.header);
  });
});
