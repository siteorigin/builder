/**
 * A section the editor asks the page to show ends up in view once the page settles (issue #902): the real preview
 * bridge, in a real browser frame, with smooth scrolling, on a page taller than the frame. A page just opened from the
 * command menu still lays out (an image above the section loads) or scrolls itself after the bridge's scroll has
 * started, and a section moved from the keyboard is still in its old place until the site's hot update has the move.
 * The author scrolling or clicking meanwhile has the last word.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The site's hot updates, played by the test: `window.applyRevision(n)` is a batch's revision arriving.
const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8').replaceAll('import.meta.hot', 'window.__hot');
const browserInstalled = existsSync(chromium.executablePath());

const SECTIONS = ['hero', 'about', 'team', 'faq', 'contact', 'footer'];
const section = (node: string) => `<section id="${node}" data-so-ctx="page:p" data-so-node="${node}">${node}</section>`;
// The browser's own scroll anchoring is off, so what moves the page is the bridge (or the test) alone.
const FRAME = `<!doctype html><html><head><style>
html{overflow-anchor:none}body{margin:0;font:16px/20px sans-serif}
section{box-sizing:border-box;margin:0;height:450px}
</style></head><body><main id="main">${SECTIONS.map(section).join('')}</main>
<script>
  const main = document.getElementById('main');
  const initial = main.innerHTML;
  window.unmount = () => (main.innerHTML = initial);
  const handlers = {};
  window.__hot = { on: (name, fn) => (handlers[name] = fn), send: () => undefined };
  window.applyRevision = (revision) => handlers['siteorigin:revision']({ revision, batch: revision });
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
/** Longer than a smooth scroll of the frame takes, and the bridge's wait for the page to stop scrolling. */
const SCROLLED_MS = 1200;

describe.skipIf(!browserInstalled)('showing the section the editor asks for once the page settles', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Page;
  let revision = 0;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ reducedMotion: 'no-preference' });
    const origin = 'http://shown.test';
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
  const scrolled = async () => {
    await page.waitForTimeout(SCROLLED_MS);
    await settle();
  };
  /** The element is in the frame's view, top and bottom. */
  const inView = (id: string) =>
    inFrame<boolean>(`const r = doc.getElementById('${id}').getBoundingClientRect(); return r.top >= 0 && r.bottom <= win.innerHeight;`);
  /** Grows the section `id` by `by` pixels, as an image in it loading does. */
  const grow = (id: string, by: number) => inFrame(`doc.getElementById('${id}').style.height = '${450 + by}px';`);
  /** Moves the section `id` to the top of the page, as the site's hot update does with a move. */
  const moveToTop = (id: string) => inFrame(`const main = doc.getElementById('main'); main.prepend(doc.getElementById('${id}'));`);

  beforeEach(async () => {
    // Ends any hold from the test before, as the author scrolling would.
    await inFrame(`win.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 1 })); win.unmount(); win.scrollTo({ top: 0, behavior: 'instant' });`);
    await send('mode', { mode: 'edit' });
    await send('track', { selected: null, hovered: null });
    await settle();
  });

  it('keeps a section in view when the page above it grows after the scroll to it', async () => {
    await send('track', { selected: sel('faq'), hovered: null });
    await send('scrollTo', { desc: sel('faq'), show: true });
    await scrolled();
    expect(await inView('faq')).toBe(true);
    // An image above it loads: the section is pushed down, most of it below the frame.
    await grow('about', 420);
    await scrolled();
    expect(await inView('faq')).toBe(true);
  });

  it('shows a section whose scroll the page cut short, as the site scrolls itself when a page opens', async () => {
    await send('track', { selected: sel('faq'), hovered: null });
    await page.evaluate(`window.post('scrollTo', { desc: ${JSON.stringify(sel('faq'))} })`);
    await page.waitForTimeout(80);
    await inFrame(`win.scrollTo({ top: 0, behavior: 'instant' });`);
    await scrolled();
    expect(await inView('faq')).toBe(true);
  });

  it('leaves the page where the author scrolls it once the section has been shown', async () => {
    await send('track', { selected: sel('faq'), hovered: null });
    await send('scrollTo', { desc: sel('faq') });
    await scrolled();
    await inFrame(`win.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -100 })); win.scrollTo({ top: 100, behavior: 'instant' });`);
    await grow('about', 420);
    await scrolled();
    expect(await scrollY()).toBe(100);
  });

  it('stops keeping it in view when something else is selected', async () => {
    await send('track', { selected: sel('faq'), hovered: null });
    await send('scrollTo', { desc: sel('faq') });
    await scrolled();
    await send('track', { selected: sel('hero'), hovered: null });
    const at = await scrollY();
    await grow('about', 420);
    await scrolled();
    expect(await scrollY()).toBe(at);
  });

  it('leaves a section at the end of the page where the page can show it, without scrolling on and on', async () => {
    await send('track', { selected: sel('footer'), hovered: null });
    await send('scrollTo', { desc: sel('footer') });
    await scrolled();
    const end = await inFrame<number>(`return doc.documentElement.scrollHeight - win.innerHeight;`);
    expect(await scrollY()).toBe(end);
    expect(await inView('footer')).toBe(true);
  });

  it('shows a section moved above the frame once the page has the move', async () => {
    // The author is at the end of the page with the FAQ in view, and moves it to the top.
    await send('track', { selected: sel('faq'), hovered: null });
    await inFrame(`win.scrollTo({ top: doc.getElementById('faq').offsetTop - 60, behavior: 'instant' });`);
    await settle();
    const before = await scrollY();
    revision += 1;
    // The editor asks before the page has the move: nothing moves yet.
    await send('scrollTo', { desc: sel('faq'), revision });
    expect(await scrollY()).toBe(before);
    await moveToTop('faq');
    await inFrame(`win.applyRevision(${revision});`);
    await scrolled();
    expect(await inView('faq')).toBe(true);
  });

  it('shows a moved section at once when the page already has the move', async () => {
    await send('track', { selected: sel('faq'), hovered: null });
    await inFrame(`win.scrollTo({ top: doc.getElementById('faq').offsetTop - 60, behavior: 'instant' });`);
    revision += 1;
    await moveToTop('faq');
    await inFrame(`win.applyRevision(${revision});`);
    await settle();
    await send('scrollTo', { desc: sel('faq'), revision });
    await scrolled();
    expect(await inView('faq')).toBe(true);
  });

  it('leaves the page where the author scrolls it while the move is on its way', async () => {
    await send('track', { selected: sel('faq'), hovered: null });
    await inFrame(`win.scrollTo({ top: doc.getElementById('faq').offsetTop - 60, behavior: 'instant' });`);
    revision += 1;
    await send('scrollTo', { desc: sel('faq'), revision });
    await inFrame(`win.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 100 })); win.scrollTo({ top: 1500, behavior: 'instant' });`);
    await settle();
    await moveToTop('faq');
    await inFrame(`win.applyRevision(${revision});`);
    await scrolled();
    expect(await scrollY()).toBe(1500);
  });
});
