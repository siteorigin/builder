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
    // Scrolled right past it, it is out of the editor's way.
    await frame.evaluate(`window.scrollTo(0, 200)`);
    await expect.poll(both).toEqual({ selected: [-120], headers: [] });
    await frame.evaluate(`window.scrollTo(0, 0)`);
    await expect.poll(both).toEqual({ selected: [80], headers: [box] });
  });

  it('reports each root of a header placed as a managed component, and none in Preview', async () => {
    await frame.evaluate(`document.querySelector('main').insertAdjacentHTML('beforebegin', '<div data-so-ctx="shell:header|banner" data-so-node="b" style="height:20px"><b data-so-ctx="shell:header|banner" data-so-node="c">New</b></div>')`);
    await expect.poll(async () => (await reported())?.headers.map((r) => r.height)).toEqual([80, 20]);
    await post('mode', { mode: 'preview' });
    await expect.poll(async () => (await reported())?.headers).toEqual([]);
    await post('mode', { mode: 'edit' });
    await expect.poll(async () => (await reported())?.headers.length).toBe(2);
    await frame.evaluate(`document.querySelector('[data-so-ctx="shell:header|banner"]').remove()`);
  });

  it('cuts the sticky header out of the outline the page draws while it scrolls, wherever the header is (#1315)', async () => {
    // The browser spaces the path its own way: compared without spaces.
    const ghostClip = async () => ((await frame.evaluate(`document.getElementById('so-outline-ghost')?.style.clipPath ?? null`)) as string | null)?.replace(/\s/g, '') ?? null;
    await frame.evaluate(`document.querySelector('header').style.position = 'sticky'; window.scrollTo(0, 0)`);
    await expect.poll(async () => (await reported())?.selected[0]?.y).toBe(80);
    await post('outlineGhost', { spec: { key: 'k1', color: '#1766c0', pad: 0, z: 1 } });
    // The first section scrolled by hand under the header, which stays at the window's top: 50px down the document.
    await frame.evaluate(`window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 })); window.scrollTo(0, 50)`);
    await expect.poll(ghostClip).toBe('path(evenodd,"M-100000-100000H100000V100000H-100000ZM050H700V130H0Z")');
    await frame.evaluate(`window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 })); window.scrollTo(0, 70)`);
    await expect.poll(ghostClip).toBe('path(evenodd,"M-100000-100000H100000V100000H-100000ZM070H700V150H0Z")');
    await post('outlineGhost', { spec: null });
    await expect.poll(ghostClip).toBeNull();
    await frame.evaluate(`window.scrollTo(0, 0)`);
  });

  it('reports none for a page without the header', async () => {
    // A section's own <header>, and the shared footer, are neither.
    await frame.evaluate(`document.querySelector('main').insertAdjacentHTML('afterend', '<footer data-so-ctx="shell:footer" data-so-node="f">Footer</footer>'); document.querySelector('section').innerHTML = '<header>Section title</header>'; document.querySelector('[data-so-ctx="shell:header"]').remove()`);
    await expect.poll(async () => (await reported())?.headers).toEqual([]);
  });
});
