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
  const main = document.getElementById('main');
  const initial = main.innerHTML;
  const wrapper = (node) => {
    const w = document.createElement('div');
    w.className = 'wrap';
    w.dataset.soCtx = 'page:p';
    w.dataset.soNode = node;
    return w;
  };
  // What a hot update does as it lands: the new section is rendered at the end of the page (or in place of the last
  // one, leaving the page as tall as it was), optionally inside a wrapper that is laid out as its children (a
  // component's root, led by a style element that shows nothing, perhaps inside another such wrapper that a line of
  // the component's own follows), which may arrive empty and fill a moment later. A hidden copy first (one a component shows at another width) shows nothing.
  window.mount = (node, how = {}) => {
    const s = document.createElement('section');
    s.id = node;
    s.dataset.soCtx = 'page:p';
    s.dataset.soNode = node;
    s.textContent = node;
    if (how.hiddenCopy) {
      const copy = s.cloneNode(true);
      copy.id = node + '-hidden';
      copy.style.display = 'none';
      main.prepend(copy);
    }
    const put = (el) => (how.replace ? document.getElementById(how.replace).replaceWith(el) : main.append(el));
    if (!how.wrapped) return put(s);
    const w = wrapper(node);
    w.id = node + '-wrap';
    s.removeAttribute('data-so-node');
    put(w);
    const inner = how.nested ? w.appendChild(document.createElement('div')) : w;
    if (how.nested) {
      inner.className = 'wrap';
      w.appendChild(document.createElement('p')).textContent = 'After the section';
    }
    const fill = () => inner.append(document.createElement('style'), s);
    if (how.later) setTimeout(fill, how.later);
    else fill();
  };
  window.unmount = () => (main.innerHTML = initial);
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
  const mount = async (node: string, how: { wrapped?: boolean; nested?: boolean; later?: number; hiddenCopy?: boolean; replace?: string } = {}, after = 150) => {
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
    // The outline the editor draws is where the section now shows, in the frame's view, reported as the new section's.
    const last = await page.evaluate<unknown>(`window.replies.filter((m) => m.type === 'rects').at(-1).payload.selectedDesc`);
    expect(last).toEqual(sel('added'));
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

  it('scrolls through a wrapper inside another wrapper to the content that shows', async () => {
    await send('track', { selected: sel('nested'), hovered: null });
    await send('scrollTo', { desc: sel('nested') });
    await mount('nested', { wrapped: true, nested: true });
    expect(await inView('nested')).toBe(true);
  });

  it('scrolls to the copy that shows, past a hidden one', async () => {
    await send('track', { selected: sel('copied'), hovered: null });
    await send('scrollTo', { desc: sel('copied') });
    await mount('copied', { hiddenCopy: true });
    expect(await inView('copied')).toBe(true);
  });

  it('scrolls to one the page puts in place of another, with nothing selected, the page no taller', async () => {
    // Nothing selected or hovered, and the page keeps its height: only the change to the page itself wakes the wait.
    await send('scrollTo', { desc: sel('swapped') });
    await mount('swapped', { replace: 'contact' });
    expect(await inView('swapped')).toBe(true);
  });

  it('does not wait for one that is on the page but hidden', async () => {
    await inFrame(`win.mount('hidden'); doc.getElementById('hidden').style.display = 'none';`);
    await send('scrollTo', { desc: sel('hidden') });
    // Shown again later (a disclosure opened, another width): the page is not moved to it then.
    await inFrame(`doc.getElementById('hidden').style.display = ''; doc.getElementById('main').append(doc.createElement('p'));`);
    await settle();
    await settle();
    expect(await scrollY()).toBe(0);
  });

  it('leaves the page where the author scrolled it meanwhile', async () => {
    for (const input of [`new win.WheelEvent('wheel', { deltaY: 100 })`, `new win.Event('touchstart')`]) {
      await inFrame(`win.unmount(); win.scrollTo({ top: 0, behavior: 'instant' });`);
      await send('scrollTo', { desc: sel('late') });
      await inFrame(`win.dispatchEvent(${input}); win.scrollTo({ top: 300, behavior: 'instant' });`);
      await settle();
      await mount('late');
      expect(await scrollY()).toBe(300);
    }
  });

  it('keeps waiting through a key that scrolls nothing (Shift, as a shortcut begins, or a shortcut with Ctrl)', async () => {
    for (const key of [`{ key: 'Shift' }`, `{ key: 'ArrowLeft', ctrlKey: true }`]) {
      await inFrame(`win.unmount(); win.scrollTo({ top: 0, behavior: 'instant' });`);
      await send('scrollTo', { desc: sel('late') });
      await inFrame(`doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { ...${key}, bubbles: true }));`);
      await settle();
      await mount('late');
      expect(await inView('late')).toBe(true);
    }
  });

  it('leaves the page where it is after a click or a scrolling key in it meanwhile', async () => {
    const key = (k: string) => `new win.KeyboardEvent('keydown', { key: '${k}', bubbles: true })`;
    for (const input of [`new win.PointerEvent('pointerdown', { bubbles: true })`, ...['PageDown', 'ArrowDown', 'End', ' ', 'Tab'].map(key)]) {
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

  it('keeps waiting while the editor reports the same selection again (a hover, a revision)', async () => {
    await send('track', { selected: sel('late'), hovered: null });
    await send('scrollTo', { desc: sel('late') });
    await send('track', { selected: sel('late'), hovered: sel('hero') });
    await mount('late');
    expect(await inView('late')).toBe(true);
  });

  it('stops waiting when the selection moves to something else meanwhile', async () => {
    await send('track', { selected: sel('late'), hovered: null });
    await send('scrollTo', { desc: sel('late') });
    await send('track', { selected: null, hovered: null });
    await mount('late');
    expect(await scrollY()).toBe(0);
  });

  it('stops waiting when the page changes, or Preview starts', async () => {
    await send('scrollTo', { desc: sel('late') });
    await inFrame(`win.dispatchEvent(new win.Event('siteorigin:navigated'));`);
    await settle();
    await mount('late');
    expect(await scrollY()).toBe(0);

    await inFrame(`win.unmount();`);
    await send('scrollTo', { desc: sel('late') });
    await inFrame(`win.dispatchEvent(new win.PopStateEvent('popstate'));`);
    await settle();
    await mount('late');
    expect(await scrollY()).toBe(0);

    await inFrame(`win.unmount();`);
    await send('scrollTo', { desc: sel('late') });
    await send('mode', { mode: 'preview' });
    await mount('late');
    expect(await scrollY()).toBe(0);

    // Asked while previewing, and Edit back before it mounts: Preview never waits for it.
    await inFrame(`win.unmount();`);
    await send('scrollTo', { desc: sel('late') });
    await send('mode', { mode: 'edit' });
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
