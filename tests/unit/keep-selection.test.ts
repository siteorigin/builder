/**
 * The selected element stays in view when the preview changes width (issue #168): the real preview bridge, in a real
 * browser frame, on a long page whose sections grow taller at phone width. Switching width keeps the selection (or the
 * part of a tall one the author was looking at) on screen at both widths, while a page with nothing selected, a
 * selection the author scrolled away from, Preview, a change of height alone and the author's own scrolling are left
 * where the author put them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const block = (node: string, h: number, phone: number, inner = '') =>
  `<section id="${node}" data-so-ctx="page:p" data-so-node="${node}" style="--h:${h}px;--ph:${phone}px">${inner}</section>`;
// The first three paragraphs grow far more than the rest at phone width, so the same share of the whole section lands
// in another paragraph there: only the paragraph itself says where the author was.
const para = (i: number) => `<p id="t${i}"${i < 3 ? ' class="grow"' : ''} data-so-ctx="page:p|tall" data-so-node="para-${i}">Paragraph ${i}</p>`;
// A hero, a row of cards that stack at phone width, a gallery, a section taller than the frame at any width, one with
// nothing of the editor's inside it, and a footer. The browser's own scroll anchoring is off, so what moves the page
// is the bridge alone.
const FRAME = `<!doctype html><html><head><style>
html{overflow-anchor:none}body{margin:0;font:16px/20px sans-serif}
section{box-sizing:border-box;margin:0;height:var(--h)}
#tall{height:auto}#tall p{margin:0;height:200px}
@media (max-width:600px){section{height:var(--ph)}#tall p{height:250px}#tall p.grow{height:600px}}
</style></head><body>
${block('hero', 400, 700)}
${block('cards', 300, 900)}
${block('gallery', 300, 540, '<h2 data-so-ctx="page:p|gallery" data-so-node="title">Gallery</h2><p id="photo" data-so-ctx="page:p|gallery" data-so-node="photo" data-so-items="x">A photo</p>')}
${block('tall', 0, 0, Array.from({ length: 8 }, (_, i) => para(i)).join(''))}
${block('plain', 1400, 2200, '<div style="height:100%">Nothing the editor knows of</div>')}
${block('footer', 400, 400)}
<script>
  // A site that renders a section afresh at another width, as a Svelte component reading the width does.
  window.remount = false;
  addEventListener('resize', () => window.remount && queueMicrotask(() => { const old = document.getElementById('tall'); window.replaced = old; old.replaceWith(old.cloneNode(true)); }));
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
/** Longer than the bridge keeps putting the selection back after a change of width. */
const SETTLED_MS = 400;
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
  /** Waits until a change of width has settled and nothing puts the selection back any more. */
  const settled = async () => {
    await page.waitForTimeout(SETTLED_MS);
    await settle();
  };
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
  /** Runs `code` (with `win`, `doc` and the host's `document`) two frames after the frame's next resize event. */
  const afterNextResize = (code: string) =>
    inFrame(`win.addEventListener('resize', () => win.requestAnimationFrame(() => win.requestAnimationFrame(() => { ${code} })), { once: true });`);
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
  /** How far down the element the middle of the frame is, as a share of the element's height. */
  const middleDepth = async (id: string) => {
    const b = await box(id);
    return (b.height / 2 - b.top) / (b.bottom - b.top);
  };
  /** The element's top is on screen, with room below it to see some of it. */
  const topInView = async (id: string) => {
    const b = await box(id);
    return b.top >= 0 && b.top <= b.height - Math.min(b.bottom - b.top, 100);
  };

  beforeEach(async () => {
    await inFrame(`win.remount = false; for (const id of ['hero', 'footer']) Object.assign(doc.getElementById(id).style, { height: '', display: '' });`);
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

  it('keeps it where the author last scrolled it at the other width', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    await resize(PHONE);
    await settled();
    await placeAt('gallery', 100);
    await resize(DESKTOP);
    expect(Math.abs((await share('gallery')) - 100 / PHONE.height) * DESKTOP.height).toBeLessThan(2);
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
    await inFrame(`win.remount = true; win.replaced = null;`);
    await send('track', { selected: sel('tall'), hovered: null });
    await placeAt('t5', 150);
    const before = await atMiddle();
    expect(before.id).toBe('t5');
    const old = await inFrame<boolean>(`return doc.getElementById('t5') === doc.getElementById('tall').querySelector('#t5');`);
    expect(old).toBe(true);
    await resize(PHONE);
    // The section the bridge measured is gone: what stays in view was found again by what the editor calls it.
    expect(await inFrame<boolean>(`return !!win.replaced && !win.replaced.isConnected;`)).toBe(true);
    const after = await atMiddle();
    expect(after.id).toBe('t5');
    expect(Math.abs(after.depth - before.depth)).toBeLessThan(0.02);
  });

  it('keeps the same point of a tall selection with nothing of the editor’s inside it', async () => {
    await send('track', { selected: sel('plain'), hovered: null });
    await placeAt('plain', -500);
    const before = await middleDepth('plain');
    await resize(PHONE);
    expect(Math.abs((await middleDepth('plain')) - before) * 2200).toBeLessThan(2);
  });

  it('puts it back when the page moves it again while the new width settles', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    const at = await share('gallery');
    // The page grows above the gallery and shrinks below it, so neither its height nor its elements change.
    await afterNextResize(`win.setTimeout(() => { doc.getElementById('hero').style.height = '900px'; doc.getElementById('footer').style.height = '200px'; }, 30);`);
    await resize(PHONE);
    await settled();
    expect(Math.abs((await share('gallery')) - at) * PHONE.height).toBeLessThan(2);
  });

  it('follows the selection through a drag across many widths', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 200);
    for (let w = 880; w >= 380; w -= 50) {
      await resize({ width: w });
      expect(await topInView('gallery')).toBe(true);
    }
  });

  it('still keeps it after a key pressed in the page (a shortcut to the command menu, then a width from it)', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    await inFrame(`win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', metaKey: true }));`);
    await settle();
    await resize(PHONE);
    expect(await topInView('gallery')).toBe(true);
  });

  it('never undoes the author scrolling while the new width settles', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    await afterNextResize(`win.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -100 })); win.scrollTo({ top: 100, behavior: 'instant' });`);
    await resize(PHONE);
    await settled();
    expect(await scrollY()).toBe(100);
  });

  it('leaves a scroll the site makes itself while the new width settles', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    await afterNextResize(`win.scrollTo({ top: 100, behavior: 'instant' });`);
    await resize(PHONE);
    await settled();
    expect(await scrollY()).toBe(100);
  });

  it('still puts it back when the browser scrolls to keep its own place as the layout moves', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    const at = await share('gallery');
    // The hero grows by 200px above the gallery and the page scrolls by only 100px with it, as scroll anchoring on an
    // element other than the gallery can.
    await afterNextResize(`doc.getElementById('hero').style.height = '900px'; win.scrollBy({ top: 100, behavior: 'instant' });`);
    await resize(PHONE);
    await settled();
    expect(Math.abs((await share('gallery')) - at) * PHONE.height).toBeLessThan(2);
  });

  it('puts it back after content below it goes for a moment and the page’s end pulls the page up', async () => {
    await send('track', { selected: sel('plain'), hovered: null });
    // Only the bottom 300px of the section shows, the footer below it: the point kept is 150px down the frame.
    await placeAt('plain', -1100);
    const b = await box('plain');
    const depth = (150 - b.top) / (b.bottom - b.top);
    // Two frames into the new width, the footer goes, so the page ends above the frame's bottom, then comes back.
    await afterNextResize(`doc.getElementById('footer').style.display = 'none'; win.setTimeout(() => { doc.getElementById('footer').style.display = ''; }, 50);`);
    await resize(PHONE);
    await settled();
    const a = await box('plain');
    expect(Math.abs(a.top + depth * (a.bottom - a.top) - (150 / DESKTOP.height) * PHONE.height)).toBeLessThan(2);
  });

  it('leaves free scrolling alone when nothing is selected', async () => {
    await scrollTo(250);
    await resize(PHONE);
    expect(await scrollY()).toBe(250);
    await resize(DESKTOP);
    expect(await scrollY()).toBe(250);
  });

  it('leaves the page where the author scrolled it when the selection was already out of view, above or below', async () => {
    await send('track', { selected: sel('hero'), hovered: null });
    await scrollTo(1400);
    expect((await box('hero')).bottom).toBeLessThan(0);
    await resize(PHONE);
    expect(await scrollY()).toBe(1400);
    await resize(DESKTOP);
    await settled();
    await send('track', { selected: sel('footer'), hovered: null });
    await scrollTo(0);
    expect((await box('footer')).top).toBeGreaterThan(DESKTOP.height);
    await resize(PHONE);
    expect(await scrollY()).toBe(0);
  });

  it('leaves the page where it is when only the height changes, also while a new width settles', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 450);
    const y = await scrollY();
    await resize({ height: 400 });
    expect(await scrollY()).toBe(y);
    await resize({ height: DESKTOP.height });
    // Two frames after the width changed (and the gallery was put back), only the height changes.
    await afterNextResize(`win.keptY = win.scrollY; document.querySelector('iframe').style.height = '${PHONE.height - 50}px';`);
    await resize(PHONE);
    await settled();
    expect(await scrollY()).toBe(await inFrame<number>(`return win.keptY;`));
  });

  it('leaves the page to the visitor in Preview', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await placeAt('gallery', 250);
    await send('mode', { mode: 'preview' });
    const y = await scrollY();
    await resize(PHONE);
    expect(await scrollY()).toBe(y);
  });

  it('leaves a list item open in the inspector to its own reveal', async () => {
    await send('track', { selected: sel('gallery'), hovered: null });
    await send('reveal', { target: { ctx: 'page:p|gallery', list: 'photos', items: 'x', nodes: ['photo'], within: { photo: 0 } } });
    await placeAt('photo', 300);
    await resize(PHONE);
    await settled();
    // The item's own reveal centres it, and the selection's correction leaves it there.
    const b = await box('photo');
    expect(Math.abs((b.top + b.bottom) / 2 - b.height / 2)).toBeLessThan(2);
  });

  it('shows a selection taller than the frame from its top when Layers asks, and centres anything else', async () => {
    await send('scrollTo', { desc: sel('tall'), show: true });
    let b = await box('tall');
    expect(b.top).toBeGreaterThan(-1);
    expect(b.top).toBeLessThan(80);
    // A request without `show` (a new section, a page opened at its place) centres it, tall or not.
    await scrollTo(0);
    await send('scrollTo', { desc: sel('tall') });
    b = await box('tall');
    expect(Math.abs((b.top + b.bottom) / 2 - b.height / 2)).toBeLessThan(2);
    await scrollTo(0);
    await send('scrollTo', { desc: sel('gallery'), show: true });
    b = await box('gallery');
    expect(Math.abs((b.top + b.bottom) / 2 - b.height / 2)).toBeLessThan(2);
  });
});
