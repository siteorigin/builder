/**
 * The selected element stays in view when the preview changes width (issue #168): the real preview bridge, in a real
 * browser frame, on a long page whose sections grow taller at phone width. Switching width keeps the selection (or the
 * part of a tall one the author was looking at) on screen at both widths, while a page with nothing selected, a
 * selection the author scrolled away from, Preview and a change of height alone are left where the author put them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const block = (node: string, h: number, phone: number, inner = '') =>
  `<section id="${node}" data-so-ctx="page:p" data-so-node="${node}" style="--h:${h}px;--ph:${phone}px">${inner}</section>`;
const para = (i: number) => `<p id="t${i}" data-so-ctx="page:p|tall" data-so-node="para-${i}">Paragraph ${i}</p>`;
// A hero, a row of cards that stack at phone width, a gallery, a section taller than the frame at any width, and a
// footer. The browser's own scroll anchoring is off, so what moves the page is the bridge alone.
const FRAME = `<!doctype html><html><head><style>
html{overflow-anchor:none}body{margin:0;font:16px/20px sans-serif}
section{box-sizing:border-box;margin:0;height:var(--h)}
#tall{height:auto}#tall p{margin:0;height:200px}
@media (max-width:600px){section{height:var(--ph)}#tall p{height:300px}}
</style></head><body>
${block('hero', 400, 700)}
${block('cards', 300, 900)}
${block('gallery', 300, 540, '<h2 data-so-ctx="page:p|gallery" data-so-node="title">Gallery</h2><p id="photo" data-so-ctx="page:p|gallery" data-so-node="photo" data-so-items="x">A photo</p>')}
${block('tall', 0, 0, Array.from({ length: 8 }, (_, i) => para(i)).join(''))}
${block('footer', 400, 400)}
<script>
  // A site that renders a section afresh at another width, as a Svelte component reading the width does.
  window.remount = false;
  addEventListener('resize', () => window.remount && queueMicrotask(() => { const old = document.getElementById('tall'); old.replaceWith(old.cloneNode(true)); }));
</script>
<script type="module" src="/bridge.js"></script></body></html>`;

const HOST = `<!doctype html><title>host</title>
<iframe name="so-test" src="/frame" style="width:900px;height:600px;border:0;display:block"></iframe>
<script>
  window.replies = [];
  window.addEventListener('message', (e) => window.replies.push(e.data));
  window.post = (type, payload) => frames[0].postMessage({ protocolVersion: 1, sessionId: 'so-test', type, payload }, '*');
</script>`;

const DESKTOP = { width: 900, height: 600 };
// As the editor's canvas at Fit: the narrower page is drawn larger, so the frame holds fewer page pixels of height.
const PHONE = { width: 390, height: 400 };
const sel = (node: string, ctx = 'page:p') => ({ ctx, node, items: '' });

describe.skipIf(!browserInstalled)('keeping the selection in view across preview widths', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ reducedMotion: 'reduce' });
    const origin = 'http://keep.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      return route.fulfill({ contentType: 'text/html', body: HOST });
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(`window.replies.some((m) => m.type === 'ready')`);
  }, 20000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Waits two frames in the page, so a command's effects and the next outline report have landed. */
  const settle = () => page.frames()[1].evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))`);
  const send = async (type: string, payload: unknown) => {
    await page.evaluate(`window.post(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
    await settle();
  };
  const inFrame = <T>(code: string) => page.evaluate<T>(`(() => { const win = frames[0]; const doc = win.document; ${code} })()`);
  const resize = async (size: { width?: number; height?: number }) => {
    const css = Object.fromEntries(Object.entries(size).map(([k, v]) => [k, `${v}px`]));
    await page.evaluate(`Object.assign(document.querySelector('iframe').style, ${JSON.stringify(css)})`);
    await settle();
    await settle();
  };
  const scrollTo = async (y: number) => {
    await inFrame(`win.scrollTo({ top: ${y}, behavior: 'instant' });`);
    await settle();
  };
  /** Scrolls so the element's top sits `offset` pixels below the frame's top. */
  const placeAt = async (id: string, offset: number) => {
    await inFrame(`win.scrollTo({ top: doc.getElementById('${id}').getBoundingClientRect().top + win.scrollY - ${offset}, behavior: 'instant' });`);
    await settle();
  };
  const scrollY = () => inFrame<number>(`return win.scrollY;`);
  /** Where an element is in the frame now, and how tall the frame is. */
  const box = (id: string) => inFrame<{ top: number; bottom: number; height: number }>(`const r = doc.getElementById('${id}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: win.innerHeight };`);
  /** The element at the middle of the frame, and how far down it that point is, as a share of its height. */
  const atMiddle = () =>
    inFrame<{ id: string; depth: number }>(`const el = doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2); const r = el.getBoundingClientRect(); return { id: el.id, depth: (win.innerHeight / 2 - r.top) / r.height };`);
  /** How far down the frame the element's top is, as a share of the frame's height. */
  const share = async (id: string) => {
    const b = await box(id);
    return b.top / b.height;
  };
  /** The element's top is on screen, with room below it to see some of it. */
  const topInView = async (id: string) => {
    const b = await box(id);
    return b.top >= 0 && b.top <= b.height - Math.min(b.bottom - b.top, 100);
  };

  beforeEach(async () => {
    await inFrame(`win.remount = false;`);
    await send('reveal', { target: null });
    await send('mode', { mode: 'edit' });
    await send('track', { selected: null, hovered: null });
    await resize(DESKTOP);
    await scrollTo(0);
  });

  it('keeps a selected section in view when the page narrows to phone width, and again back at desktop', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    const at = await share('gallery');
    await resize(PHONE);
    expect(await topInView('gallery')).toBe(true);
    // At the same place in the frame, which the editor draws at the same height on screen at either width.
    expect(Math.abs((await share('gallery')) - at) * PHONE.height).toBeLessThan(2);
    await resize(DESKTOP);
    expect(await topInView('gallery')).toBe(true);
    expect(Math.abs((await share('gallery')) - at) * DESKTOP.height).toBeLessThan(2);
  });

  it('keeps the part of a tall selected section the author was looking at in view', async () => {
    await send('track', { selected: sel('tall'), hovered: null });
    await placeAt('t3', 40);
    expect((await box('tall')).top).toBeLessThan(0);
    const before = await atMiddle();
    expect(before.id).toBe('t4');
    // The same paragraph, at the same point of it, stays in the middle of the frame at both widths.
    await resize(PHONE);
    let after = await atMiddle();
    expect(after.id).toBe('t4');
    expect(Math.abs(after.depth - before.depth)).toBeLessThan(0.02);
    await resize(DESKTOP);
    after = await atMiddle();
    expect(after.id).toBe('t4');
    expect(Math.abs(after.depth - before.depth)).toBeLessThan(0.02);
  });

  it('finds what it kept again when the site renders the section afresh at the new width', async () => {
    await inFrame(`win.remount = true;`);
    await send('track', { selected: sel('tall'), hovered: null });
    await placeAt('t5', 100);
    const before = await atMiddle();
    await resize(PHONE);
    const after = await atMiddle();
    expect(after.id).toBe(before.id);
    expect(Math.abs(after.depth - before.depth)).toBeLessThan(0.02);
  });

  it('leaves a list item open in the inspector to its own reveal', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await send('reveal', { target: { ctx: 'page:p|gallery', list: 'photos', items: 'x', nodes: ['photo'], within: { photo: 0 } } });
    await placeAt('photo', 300);
    await resize(PHONE);
    // The item is in view, where its reveal puts it, and nothing scrolls the page after that.
    const b = await box('photo');
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.bottom).toBeLessThanOrEqual(b.height);
    const y = await scrollY();
    await settle();
    await settle();
    expect(await scrollY()).toBe(y);
  });

  it('follows the selection through a drag across many widths', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 200);
    for (let w = 880; w >= 380; w -= 50) {
      await resize({ width: w });
      expect(await topInView('gallery')).toBe(true);
    }
  });

  it('leaves free scrolling alone when nothing is selected', async () => {
    await scrollTo(250);
    await resize(PHONE);
    expect(await scrollY()).toBe(250);
    await resize(DESKTOP);
    expect(await scrollY()).toBe(250);
  });

  it('leaves the page where the author scrolled it when the selection was already out of view', async () => {
    await send('track', { selected: sel('hero'), hovered: null });
    await scrollTo(1400);
    expect((await box('hero')).bottom).toBeLessThan(0);
    await resize(PHONE);
    expect(await scrollY()).toBe(1400);
  });

  it('leaves the page where it is when only the height changes', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 450);
    const y = await scrollY();
    await resize({ height: 400 });
    expect(await scrollY()).toBe(y);
  });

  it('leaves the page to the visitor in Preview', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    await send('mode', { mode: 'preview' });
    const y = await scrollY();
    await resize(PHONE);
    expect(await scrollY()).toBe(y);
  });

  it('scrolls to a selection taller than the frame so its top shows', async () => {
    await send('scrollTo', { desc: sel('tall') });
    const b = await box('tall');
    expect(b.top).toBeGreaterThan(-1);
    expect(b.top).toBeLessThan(80);
  });
});
