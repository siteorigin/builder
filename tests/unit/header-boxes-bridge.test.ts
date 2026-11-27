/**
 * The shared header's boxes in the preview bridge's reports (#1141), in a real browser frame shaped as the generated
 * layout renders it: a sticky header inside a placed component's display:contents wrapper, with marked parts of its
 * own, then <main>. The editor keeps its Add buttons off these boxes, so they follow the page as it scrolls.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Imported, not read from disk, so a change to the bridge alone still selects this test on a pull request.
import bridge from '../../src/runtime/bridge.client.js?raw';

const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const FRAME = `<!doctype html><html><head><style>body{margin:0}header{position:sticky;top:0;height:80px;background:#fff}section{height:600px}</style></head><body>
<div style="display:contents" data-so-ctx="shell:header" data-so-node="h"><header><a data-so-ctx="shell:header|h" data-so-node="link">Home</a></header></div>
<main id="main"><section data-so-ctx="page:home" data-so-node="one">One</section><section data-so-ctx="page:home" data-so-node="two">Two</section></main>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
type Report = { selected: Array<{ y: number }>; headers: Array<{ x: number; y: number; width: number; height: number }> };
const reported = () => page.evaluate(`window.seen.filter((m) => m.type === 'rects').at(-1)?.payload`) as Promise<Report | undefined>;
const both = async () => {
  const r = await reported();
  return r && { selected: r.selected.map((b) => b.y), headers: r.headers };
};

describe.skipIf(!browserInstalled)('the header boxes the preview reports with its outlines (#1141)', () => {
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
    await post('track', { selected: { ctx: 'page:home', node: 'one', items: '' }, hovered: null, slots: [] });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reports the header once, by its outermost box, and keeps it current as the page scrolls', async () => {
    const box = { x: 0, y: 0, width: 700, height: 80 };
    await expect.poll(both).toEqual({ selected: [80], headers: [box] });
    await frame.evaluate(`window.scrollTo(0, 50)`);
    await expect.poll(both).toEqual({ selected: [30], headers: [box] });
    await frame.evaluate(`document.querySelector('header').style.position = 'static'; window.scrollTo(0, 60)`);
    await expect.poll(both).toEqual({ selected: [20], headers: [{ ...box, y: -60 }] });
  });

  it('reports none for a page without the header', async () => {
    await frame.evaluate(`document.querySelector('[data-so-ctx="shell:header"]').remove()`);
    await expect.poll(async () => (await reported())?.headers).toEqual([]);
  });
});
