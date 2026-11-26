/**
 * A page with no sections (#901), in a real browser frame, shaped as the generated layout renders it: the shared
 * header, an empty <main>, the shared footer. While editing, the page keeps the room the editor asks for between the
 * two, for its "no sections yet" card, and reports where that room is with its outlines. Preview, and a page with
 * content, are left as visitors get them.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Imported, not read from disk, so a change to the bridge alone still selects this test on a pull request.
import bridge from '../../src/runtime/bridge.client.js?raw';
import { emptyAreaOf } from '../../src/renderer/src/lib/payload';

const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const FRAME = `<!doctype html><html><head><style>body{margin:0}header{position:sticky;top:0;height:80px;background:#fff}footer{height:600px}</style></head><body>
<header data-so-ctx="shell:header" data-so-node="h">Header</header>
<main id="main">
  <!---->
</main>
<footer>Footer</footer>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
/** The empty page's room as last reported. */
const reported = async () => emptyAreaOf(await page.evaluate(`window.seen.filter((m) => m.type === 'rects').at(-1)?.payload.empty`));
const footerTop = () => frame.evaluate<number>(`document.querySelector('footer').getBoundingClientRect().top`);
const space = { key: 'home', height: 360, header: [{ ctx: 'shell:header', node: 'h', items: '' }] };

describe.skipIf(!browserInstalled)('the room an empty page keeps for its first step (#901)', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname !== '/bridge.js') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:700px;height:500px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });
  // Each case starts in Edit, at the top of the page, with the room asked for.
  beforeEach(async () => {
    await post('mode', { mode: 'edit' });
    await frame.evaluate(`history.replaceState(null, '', '/frame'); document.querySelector('header').style.height = '80px'; window.scrollTo(0, 0)`);
    await post('emptySpace', { space: null });
    await expect.poll(footerTop).toBe(80);
    await post('emptySpace', { space });
    await expect.poll(reported).toEqual({ key: 'home', top: 80, height: 360, headerBottom: 80 });
  });

  it('holds the room asked for between the header and the footer, and says where it is', async () => {
    expect(await footerTop()).toBe(440);
    await post('emptySpace', { space: { ...space, key: 'about', height: 250.4 } });
    await expect.poll(footerTop).toBe(331);
    await expect.poll(reported).toEqual({ key: 'about', top: 80, height: 251, headerBottom: 80 });
    await post('emptySpace', { space: { ...space, header: [] } });
    await expect.poll(async () => (await reported())?.headerBottom).toBe(0);
  });

  it('follows a scroll, with a header that stays at the top covering its start', async () => {
    await frame.evaluate(`window.scrollTo(0, 100)`);
    await expect.poll(reported).toEqual({ key: 'home', top: -20, height: 360, headerBottom: 80 });
    await frame.evaluate(`document.querySelector('header').style.height = '120px'`);
    await expect.poll(async () => (await reported())?.headerBottom).toBe(120);
  });

  it('leaves Preview as visitors get it, and takes the room again in Edit', async () => {
    await post('mode', { mode: 'preview' });
    await expect.poll(footerTop).toBe(80);
    await expect.poll(reported).toBeNull();
    await post('mode', { mode: 'edit' });
    await expect.poll(footerTop).toBe(440);
    await expect.poll(reported).toEqual({ key: 'home', top: 80, height: 360, headerBottom: 80 });
  });

  it('gives the room up as soon as the first section is on the page, and again when it goes', async () => {
    await frame.evaluate(`document.getElementById('main').insertAdjacentHTML('beforeend', '<section style="height:100px">First</section>')`);
    await expect.poll(footerTop).toBe(180);
    await expect.poll(reported).toBeNull();
    await frame.evaluate(`document.querySelector('main section').remove()`);
    await expect.poll(footerTop).toBe(440);
    await expect.poll(async () => (await reported())?.height).toBe(360);
  });

  it('keeps the room through a jump within the page, and drops it on arriving at another', async () => {
    await frame.evaluate(`history.pushState(null, '', '/frame#top'); dispatchEvent(new Event('siteorigin:navigated'))`);
    await page.evaluate(`window.seen = []`);
    await frame.evaluate(`window.scrollTo(0, 10)`);
    await expect.poll(async () => (await reported())?.top).toBe(70);
    await frame.evaluate(`history.pushState(null, '', '/other/'); dispatchEvent(new Event('siteorigin:navigated'))`);
    await expect.poll(footerTop).toBe(70);
    await expect.poll(reported).toBeNull();
  });

  it('gives the room up when the editor says the page has none to keep', async () => {
    await post('emptySpace', { space: null });
    await expect.poll(footerTop).toBe(80);
    await expect.poll(reported).toBeNull();
  });
});

describe('the report of an empty page’s room', () => {
  const area = { key: 'home', top: -20, height: 360, headerBottom: 80 };
  it('takes a whole report, and nothing malformed', () => {
    expect(emptyAreaOf({ ...area, extra: 1 })).toEqual(area);
    for (const bad of [null, 'home', {}, { ...area, key: 1 }, { ...area, top: Number.NaN }, { ...area, height: -1 }, { ...area, headerBottom: undefined }]) expect(emptyAreaOf(bad)).toBeNull();
  });
});
