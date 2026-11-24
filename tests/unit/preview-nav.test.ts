/**
 * The preview bridge answers each of the editor's page requests with the request's id once the page is there,
 * so the editor can tell that report from one sent on the way (see lib/frame-nav). Runs the real bridge in a real
 * browser frame on another origin, with a stand-in for the site's client-side navigation whose steps the test
 * releases one at a time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
// The site's goto, as SvelteKit's: it lands on the page (reporting it as the site does after a navigation), and
// rejects when it is told to fail. Each call waits until the test releases it.
const NAVIGATION = `export async function goto(path) {
  const n = ++window.gotoCalls;
  await new Promise((r) => (window.releases[n] = r));
  if (window.failing.includes(n)) throw new Error('navigation superseded');
  if (location.pathname === path) return;
  history.pushState({}, '', path);
  window.dispatchEvent(new Event('siteorigin:navigated'));
}`;
const PAGE = `<!doctype html><html><head><script type="importmap">{"imports":{"$app/navigation":"/navigation.js"}}</script>
<script>window.gotoCalls = 0; window.releases = {}; window.failing = []; window.loads = (window.loads || 0) + 1;</script></head>
<body><main data-so-node="s" data-so-ctx="page:p"><p>Page</p></main><script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

interface Report {
  path: string;
  navId?: number;
}
const reports = () => page.evaluate<Report[]>(`window.reports`);
const command = (type: string, payload: unknown) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: 'so-test', type, payload })}, '*')`);
const gotoCalls = () => frame.evaluate<number>(`window.gotoCalls`);
const release = (n: number) => frame.evaluate(`window.releases[${n}]()`);
/** Everything the bridge has sent so far, once it has all arrived: messages from one frame arrive in order. */
async function flushed(): Promise<Report[]> {
  await frame.evaluate(`parent.postMessage({ sessionId: 'so-test', type: 'flushed', payload: {} }, '*')`);
  await expect.poll(() => page.evaluate<boolean>(`window.flushed`)).toBe(true);
  await page.evaluate(`window.flushed = false`);
  return reports();
}

describe.skipIf(!browserInstalled)('the preview frame answering the editor’s page requests', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname === '/navigation.js') return route.fulfill({ contentType: 'text/javascript', body: NAVIGATION });
      if (url.origin === SITE) return route.fulfill({ contentType: 'text/html', body: PAGE });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/" style="border:0;width:700px;height:400px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.reports = []; window.flushed = false; window.addEventListener('message', (e) => {
      if (!e.data || e.data.sessionId !== 'so-test') return;
      if (e.data.type === 'navigated') window.reports.push(e.data.payload);
      if (e.data.type === 'measured') window.measured = e.data.payload;
      if (e.data.type === 'flushed') window.flushed = true;
    }); }`);
  }, 30000);
  beforeEach(async () => {
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    await page.evaluate(`window.reports = []`);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('answers a request with its id once the page is there', async () => {
    await command('navigate', { path: '/about/', navId: 1 });
    await expect.poll(gotoCalls).toBe(1);
    await release(1);
    await expect.poll(async () => (await reports()).length).toBe(2);
    // The site's own report on the way carries no id; the answer does.
    expect(await reports()).toEqual([{ path: '/about/' }, { path: '/about/', navId: 1 }]);
  });

  it('answers a request for the page it is already on', async () => {
    await command('navigate', { path: '/', navId: 4 });
    await expect.poll(gotoCalls).toBe(1);
    await release(1);
    await expect.poll(reports).toEqual([{ path: '/', navId: 4 }]);
  });

  it('never answers, or loads a page for, a request the editor has since replaced', async () => {
    await command('navigate', { path: '/about/', navId: 1 });
    await expect.poll(gotoCalls).toBe(1);
    await command('navigate', { path: '/contact/', navId: 2 });
    await expect.poll(gotoCalls).toBe(2);
    // The first navigation fails once the second has started: it must not fall back to loading its page in full.
    await frame.evaluate(`window.failing.push(1)`);
    await release(1);
    await release(2);
    await expect.poll(async () => (await reports()).length).toBe(2);
    expect(await flushed()).toEqual([{ path: '/contact/' }, { path: '/contact/', navId: 2 }]);
    expect(await frame.evaluate(`window.loads`)).toBe(1);
    expect(await frame.evaluate(`location.pathname`)).toBe('/contact/');
  });

  it('measures each sibling with the CSS order it is laid out by', async () => {
    await frame.evaluate(`document.querySelector('main').insertAdjacentHTML('beforeend', \`
      <div style="display: flex">
        <div data-so-ctx="page:p" data-so-node="a" style="order: 1">A</div>
        <div data-so-ctx="page:p" data-so-node="b">B</div>
        <div data-so-ctx="page:p" data-so-node="w" style="display: contents"><span style="display: none; order: 0">hidden</span><span style="order: 2">shown</span></div>
      </div>
      <div><div data-so-ctx="page:p" data-so-node="c" style="order: 1">C</div></div>
      <div style="display: grid"><div data-so-ctx="page:p" data-so-node="g" style="order: -1">G</div></div>
      <div style="display: flex; position: relative"><div data-so-ctx="page:p" data-so-node="x" style="display: contents"><span style="position: absolute; order: 5">badge</span><span style="order: 3">item</span></div></div>\`)`);
    const descs = ['a', 'b', 'w', 'c', 'g', 'x'].map((node) => ({ ctx: 'page:p', node, items: '' }));
    await command('measure', { requestId: 'm1', descs });
    await expect.poll(() => page.evaluate(`window.measured && window.measured.requestId`)).toBe('m1');
    // A block parent lays out by document order whatever its children's order says; a display: contents
    // wrapper is laid out as the child of it that shows.
    // A grid orders its items as a flex row does; a positioned child takes no place among them.
    expect(await page.evaluate(`window.measured.rects.map((r) => r && r.order)`)).toEqual([1, 0, 2, 0, -1, 3]);
  });

  it('still loads the page in full when its latest request cannot be made in the page', async () => {
    await command('navigate', { path: '/about/', navId: 7 });
    await expect.poll(gotoCalls).toBe(1);
    await frame.evaluate(`window.failing.push(1)`);
    await release(1);
    await expect.poll(() => page.frames().find((f) => f.name() === 'so-test')!.url()).toBe(`${SITE}/about/`);
  });
});
