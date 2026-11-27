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

describe('a pick on the page', () => {
  // The browser tests' host stands in for Canvas, so this holds Canvas to what the host does.
  it('is selected without being scrolled to, wherever Canvas takes one from the page', () => {
    const canvas = readFileSync(resolve('src/renderer/src/panels/Canvas.tsx'), 'utf8');
    const block = (from: string, to: string) => canvas.slice(canvas.indexOf(from), canvas.indexOf(to, canvas.indexOf(from)));
    for (const [from, to] of [["case 'select': {", "case 'dblclick': {"], ["case 'dblclick': {", "case 'textCommit': {"], ["case 'contextmenu': {", "case 'download': {"], ['className="ov-box ov-hover"', 'onPointerEnter']]) {
      const code = block(from, to);
      expect(code, from).toContain('selectOnPage(');
      // Only clearing the selection is set directly.
      expect(code, from).not.toMatch(/setState\(\{ selection: (?!null)/);
    }
  });
});

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
    await page.emulateMedia({ reducedMotion: 'no-preference' });
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
      // Clear of the header, and scrolled no further than that takes.
      expect(Math.abs(at.top - at.header - 8)).toBeLessThan(2);
      expect(at.caretTop).toBeGreaterThanOrEqual(at.header);
      expect(at.bottom).toBeLessThanOrEqual(at.height);
    });
  }

  /** Starts an edit of `node` as the editor's own Edit text does: with no click, so the caret is at the end. */
  const editFromEditor = async (node = 'title') => {
    await page.evaluate(`document.querySelector('iframe').focus()`);
    await page.evaluate(`window.post('beginTextEdit', { desc: { ctx: 'page:p', node: '${node}', items: '' }, editId: 'e-chrome' })`);
    await started();
  };
  /** Thirty lines in the heading: taller than the frame. */
  const makeTall = () => frame.evaluate(`document.getElementById('title').innerHTML = Array.from({ length: 30 }, (_, i) => 'Line ' + i).join('<br>')`);
  const caretClear = async () => {
    const at = await shown();
    return at.caretTop >= at.header && at.caretBottom <= at.height;
  };

  it('shows the caret as an edit of text taller than the frame begins', async () => {
    await makeTall();
    await editFromEditor();
    // The caret is at the end of the last line, far below the frame when the edit was asked for.
    // (A caret at the very end has no box of its own to measure: the heading's bottom edge is its line's.)
    const at = await shown();
    expect(at.bottom).toBeLessThanOrEqual(at.height);
    expect(at.bottom).toBeGreaterThan(at.height - 100);
  });

  it('clears a header of the site’s own that publishes no offset', async () => {
    await frame.evaluate(`(() => {
      document.documentElement.removeAttribute('style');
      document.getElementById('bar').style.height = '120px';
      window.scrollTo({ top: 100, behavior: 'instant' });
    })()`);
    await editFromEditor();
    const at = await shown();
    expect(at.header).toBe(120);
    expect(at.top).toBeGreaterThanOrEqual(at.header);
  });

  it('leaves the page where it is for text edited in the header that stays at the top', async () => {
    await frame.evaluate(`(() => {
      document.getElementById('bar').innerHTML = '<span data-so-ctx="page:p" data-so-node="brand">Studio</span>';
      window.scrollTo({ top: 600, behavior: 'instant' });
    })()`);
    await editFromEditor('brand');
    await page.keyboard.type('x');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(100);
    expect(await frame.evaluate<number>(`scrollY`)).toBe(600);
  });

  it('does not scroll to the list item holding the text being edited', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await frame.evaluate(`(() => {
      document.getElementById('hero').setAttribute('data-so-items', 'first');
      window.scrollTo({ top: 90, behavior: 'instant' });
    })()`);
    await editFromEditor();
    // The hero, taller than the frame and with its top above it, is the item.
    await frame.evaluate(`document.getElementById('hero').setAttribute('data-so-ctx', 'page:p|hero')`);
    const at = await frame.evaluate<number>(`scrollY`);
    expect(at).toBeGreaterThan(0);
    // The inspector opens the item the text is in just after: centring or topping it would bury the heading.
    await page.evaluate(`window.post('reveal', { target: { ctx: 'page:p|hero', list: 'cards', items: 'first', nodes: ['hero'], within: { hero: 0 } } })`);
    await page.waitForTimeout(300);
    expect(await frame.evaluate<number>(`scrollY`)).toBe(at);
  });

  it('starts an edit with nothing scrolling without the site hearing of a scroll', async () => {
    await frame.evaluate(`window.scrolls = 0; addEventListener('scroll', () => window.scrolls++)`);
    await editFromEditor();
    await page.waitForTimeout(100);
    expect(await frame.evaluate<number>(`window.scrolls`)).toBe(0);
  });

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

  /** Scrolls so the caret's line is `y` pixels down the frame. */
  const putCaretAt = (y: number) => frame.evaluate(`window.scrollBy({ top: getSelection().getRangeAt(0).getBoundingClientRect().top - ${y}, behavior: 'instant' })`);
  /** Starts editing tall text with the caret inside a line in its middle. */
  const editMidTall = async () => {
    await makeTall();
    await editFromEditor();
    await frame.evaluate(`getSelection().collapse(document.getElementById('title').childNodes[30], 4)`);
  };

  it('keeps the caret below the header as a key moves it up, each repeat of a held key too', async () => {
    await editMidTall();
    // The line above the caret's is in the frame, under the header.
    await putCaretAt(80);
    await page.keyboard.down('ArrowUp');
    await expect.poll(caretClear).toBe(true);
    await putCaretAt(80);
    // Still held: a repeat, with no key let go.
    await page.keyboard.down('ArrowUp');
    await expect.poll(caretClear).toBe(true);
    await page.keyboard.up('ArrowUp');
  });

  it('brings a caret left under the header clear as the author types', async () => {
    await editMidTall();
    await putCaretAt(20);
    expect(await caretClear()).toBe(false);
    // Text with no key pressed, as dictation or the emoji picker enters it.
    await page.keyboard.insertText('x');
    await expect.poll(caretClear).toBe(true);
  });
});
