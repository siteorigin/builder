/**
 * A new selection the page does not show yet is scrolled to once it does (issue #509): the real preview bridge, in a
 * real browser frame, on a page taller than the frame. Inserting a section asks the page to scroll to it before the
 * site's hot update has put it on the page; the bridge waits for it, for a short while, and scrolls to it as it mounts.
 * The author scrolling, clicking or typing meanwhile, a newer request, another page and Preview each end the wait.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
// The wait, shortened so the test of its end is quick; the real one is long enough for a hot update to land.
const WAIT_MS = 600;
const bridge = source.replace(/const SCROLL_WAIT_MS = \d+;/, `const SCROLL_WAIT_MS = ${WAIT_MS};`);
const browserInstalled = existsSync(chromium.executablePath());

const SECTIONS = ['hero', 'about', 'team', 'contact'];
const section = (node: string) => `<section id="${node}" data-so-ctx="page:p" data-so-node="${node}">${node}</section>`;
// Four sections, together more than three times the frame's height, so one added at the end is far out of view. The browser's own
// scroll anchoring is off, so what moves the page is the bridge alone.
const FRAME = `<!doctype html><html><head><style>
html{overflow-anchor:none}body{margin:0;font:16px/20px sans-serif}
section{box-sizing:border-box;margin:0;height:500px}
.wrap{display:contents}
</style></head><body><main id="main">${SECTIONS.map(section).join('')}</main>
<script>
  // What a hot update does as it lands: the new section is rendered at the end of the page, optionally inside a
  // wrapper that is laid out as its children (a component's root), which may arrive empty and fill a moment later.
  window.mount = (node, how = {}) => {
    const s = document.createElement('section');
    s.id = node;
    s.dataset.soCtx = 'page:p';
    s.dataset.soNode = node;
    s.textContent = node;
    if (!how.wrapped) return document.getElementById('main').append(s);
    const w = document.createElement('div');
    w.className = 'wrap';
    w.id = node + '-wrap';
    w.dataset.soCtx = 'page:p';
    w.dataset.soNode = node;
    s.removeAttribute('data-so-node');
    document.getElementById('main').append(w);
    if (how.later) setTimeout(() => w.append(s), how.later);
    else w.append(s);
  };
  window.unmount = () => { for (const el of [...document.getElementById('main').children]) if (!${JSON.stringify(SECTIONS)}.includes(el.id)) el.remove(); };
</script>
<script type="module" src="/bridge.js"></script></body></html>`;

const HOST = `<!doctype html><title>host</title>
<iframe name="so-test" src="/frame" style="width:900px;height:600px;border:0;display:block"></iframe>
<script>
  window.replies = [];
  window.addEventListener('message', (e) => window.replies.push(e.data));
  window.post = (type, payload) => frames[0].postMessage({ protocolVersion: 1, sessionId: 'so-test', type, payload }, '*');
</script>`;

const sel = (node: string) => ({ ctx: 'page:p', node, items: '' });

describe.skipIf(!browserInstalled)('scrolling to a new selection the page shows a moment later', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ reducedMotion: 'reduce' });
    const origin = 'http://pending.test';
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
  const scrollY = () => inFrame<number>(`return win.scrollY;`);
  /** As a hot update would, a moment after the request (`after` ms). */
  const mount = async (node: string, how: { wrapped?: boolean; later?: number } = {}, after = 150) => {
    await page.waitForTimeout(after);
    await inFrame(`win.mount(${JSON.stringify(node)}, ${JSON.stringify(how)});`);
    await settle();
    if (how.later) await page.waitForTimeout(how.later);
    await settle();
  };
  /** The element is in the frame's view, top and bottom. */
  const inView = (id: string) =>
    inFrame<boolean>(`const r = doc.getElementById('${id}').getBoundingClientRect(); return r.top >= 0 && r.bottom <= win.innerHeight;`);
  /** The outline the frame last reported for the selection, in the frame's coordinates. */
  const outline = () => page.evaluate<{ y: number; height: number } | null>(`(() => { const r = window.replies.filter((m) => m.type === 'rects').at(-1); return r ? r.payload.selected[0] ?? null : null; })()`);

  beforeEach(async () => {
    await inFrame(`win.unmount();`);
    await send('mode', { mode: 'edit' });
    await send('track', { selected: null, hovered: null });
    // A request from an earlier test that is still waiting ends with the next one, for a section that is there.
    await send('scrollTo', { desc: sel('hero') });
    await inFrame(`win.scrollTo({ top: 0, behavior: 'instant' });`);
    await settle();
  });

  it('scrolls to a section inserted at the end of a tall page once the page shows it, and outlines it there', async () => {
    // The editor selects the new section, and asks for it to be shown, before the page has it.
    await send('track', { selected: sel('added'), hovered: null });
    await send('scrollTo', { desc: sel('added') });
    expect(await scrollY()).toBe(0);
    await mount('added');
    expect(await scrollY()).toBeGreaterThan(1400);
    expect(await inView('added')).toBe(true);
    // The outline the editor draws is where the section now shows, in the frame's view.
    const o = await outline();
    expect(o).not.toBeNull();
    expect(o!.y).toBeGreaterThanOrEqual(0);
    expect(o!.y + o!.height).toBeLessThanOrEqual(600);
  });

  it('scrolls to one that is already there at once, as before', async () => {
    await send('scrollTo', { desc: sel('contact') });
    expect(await inView('contact')).toBe(true);
  });

  it('scrolls to a component that mounts as a wrapper first and shows its content a moment later', async () => {
    await send('track', { selected: sel('wrapped'), hovered: null });
    await send('scrollTo', { desc: sel('wrapped') });
    await mount('wrapped', { wrapped: true, later: 120 });
    expect(await inView('wrapped')).toBe(true);
  });

  it('leaves the page where the author scrolled it meanwhile', async () => {
    await send('scrollTo', { desc: sel('late') });
    await inFrame(`win.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 100 })); win.scrollTo({ top: 300, behavior: 'instant' });`);
    await settle();
    await mount('late');
    expect(await scrollY()).toBe(300);
  });

  it('leaves the page where it is after a click or a key in it meanwhile', async () => {
    for (const input of [`new win.PointerEvent('pointerdown', { bubbles: true })`, `new win.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })`]) {
      await inFrame(`win.unmount();`);
      await send('scrollTo', { desc: sel('late') });
      await inFrame(`doc.body.dispatchEvent(${input});`);
      await settle();
      await mount('late');
      expect(await scrollY()).toBe(0);
    }
  });

  it('leaves the page where it is when the editor scrolls it for a drag meanwhile', async () => {
    await send('scrollTo', { desc: sel('late') });
    await send('scrollBy', { y: 200 });
    await mount('late');
    expect(await scrollY()).toBe(200);
  });

  it('follows only the latest request', async () => {
    await send('scrollTo', { desc: sel('late') });
    await send('scrollTo', { desc: sel('about') });
    const at = await scrollY();
    expect(await inView('about')).toBe(true);
    await mount('late');
    expect(await scrollY()).toBe(at);
  });

  it('stops waiting when the page changes, or Preview starts', async () => {
    await send('scrollTo', { desc: sel('late') });
    await inFrame(`win.dispatchEvent(new win.Event('siteorigin:navigated'));`);
    await settle();
    await mount('late');
    expect(await scrollY()).toBe(0);

    await inFrame(`win.unmount();`);
    await send('scrollTo', { desc: sel('late') });
    await send('mode', { mode: 'preview' });
    await mount('late');
    expect(await scrollY()).toBe(0);
  });

  it('stops waiting after a short while', async () => {
    expect(bridge).not.toBe(source);
    await send('scrollTo', { desc: sel('late') });
    await mount('late', {}, WAIT_MS + 200);
    expect(await scrollY()).toBe(0);
  });
});
