/**
 * The others' marks in the preview bridge's reports (#768), in a real browser frame: the editor tracks each live
 * session participant's element, or a spotlight's point as shares of the page's whole width and height, and the page
 * reports one box for each that shows, under the editor's key, and keeps them current as the page scrolls (inside a
 * scrolling box too) and changes, with nothing of the editor's own selected or hovered.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Imported, not read from disk, so a change to the bridge alone still selects this test on a pull request.
import bridge from '../../src/runtime/bridge.client.js?raw';

const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const FRAME = `<!doctype html><html><head><style>body{margin:0}section{height:600px}#scroller{height:300px;overflow:auto}#scroller p{height:200px;margin:0}</style></head><body>
<main id="main"><section data-so-ctx="page:home" data-so-node="one">One</section><section data-so-ctx="page:home" data-so-node="two">Two</section>
<div id="scroller" data-so-ctx="page:home" data-so-node="list"><p>A</p><p data-so-ctx="page:home" data-so-node="inner">B</p><p>C</p></div></main>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
type Box = { x: number; y: number; width: number; height: number };
const marks = async () => {
  const r = (await page.evaluate(`window.seen.filter((m) => m.type === 'rects').at(-1)?.payload`)) as { marks?: Array<{ key: string; box: Box }> } | undefined;
  return r?.marks && Object.fromEntries(r.marks.map((m) => [m.key, [Math.round(m.box.x), Math.round(m.box.y), Math.round(m.box.width), Math.round(m.box.height)]]));
};
const desc = (node: string) => ({ ctx: 'page:home', node, items: '' });

describe.skipIf(!browserInstalled)('the others’ marks the preview reports (#768)', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE) return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:700px;height:500px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    await post('mode', { mode: 'edit' });
    // Nothing of the editor's own: only the others' marks.
    await post('track', {
      selected: null,
      hovered: null,
      slots: [],
      marks: [
        { key: 'ann', desc: desc('two'), point: null },
        { key: 'bea', desc: null, point: { x: 0.25, y: 0.5 } },
        { key: 'gone', desc: desc('nope'), point: null },
        // An element that shows nowhere falls back to its point.
        { key: 'cid', desc: desc('nope'), point: { x: 0, y: 0 } },
        { key: 'inner', desc: desc('inner'), point: null },
        // Not a mark: neither an element nor a point within the page.
        { key: 'bad', desc: null, point: { x: 2, y: 0 } }
      ]
    });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reports a box for each mark that shows, under its key: an element’s, or a point’s as a box of no size', async () => {
    // The page is 700 wide and 1500 tall: two sections, then the 300px scrolling list.
    await expect.poll(marks).toEqual({ ann: [0, 600, 700, 600], bea: [175, 750, 0, 0], cid: [0, 0, 0, 0], inner: [0, 1400, 700, 200] });
  });

  it('keeps them where they are as the page scrolls, and as a box inside it scrolls', async () => {
    await frame.evaluate(`window.scrollTo(0, 500)`);
    await expect.poll(marks).toEqual({ ann: [0, 100, 700, 600], bea: [175, 250, 0, 0], cid: [0, -500, 0, 0], inner: [0, 900, 700, 200] });
    await frame.evaluate(`document.getElementById('scroller').scrollTop = 150`);
    await expect.poll(async () => (await marks())?.inner).toEqual([0, 750, 700, 200]);
    await frame.evaluate(`document.getElementById('scroller').scrollTop = 0; window.scrollTo(0, 0)`);
    await expect.poll(async () => (await marks())?.ann).toEqual([0, 600, 700, 600]);
  });

  it('keeps them where they are as the page changes, and drops them when the editor tracks none', async () => {
    await frame.evaluate(`document.querySelector('main').insertAdjacentHTML('afterbegin', '<div id="banner" style="height:50px">New</div>')`);
    await expect.poll(async () => (await marks())?.ann).toEqual([0, 650, 700, 600]);
    await post('track', { selected: null, hovered: null, slots: [], marks: [] });
    await expect.poll(marks).toEqual({});
  });
});
