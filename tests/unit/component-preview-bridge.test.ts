/**
 * The preview bridge in a real browser frame, on a page laid out as an isolated component preview: it reports
 * whether the component mounted, the box it fills (a code component's wrapper takes no box of its own), and the
 * reason it did not mount.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

type Box = { x: number; y: number; width: number; height: number };
type Preview = { key: string; mounted: boolean; error?: string; bounds: Box | null; text: string };

/** Load `body` (with `preview` as the entry module leaves it) in a 437px frame; what the bridge said on ready and on inspect. */
async function run(body: string, preview: object) {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    const origin = 'http://preview.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/__siteorigin/component/abcdefabcdefabcdef/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}<script>window.__siteoriginPreview = ${JSON.stringify(preview)};</script><script type="module" src="/bridge.js"></script></body></html>`
        });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>host</title>' });
    });
    await page.goto(`${origin}/`);
    // Runs in the browser, so it is passed as text (the Node project has no DOM types).
    return await page.evaluate<{ ready: { path: string; preview?: Preview }; report: { preview?: Preview; issues: Array<{ kind: string }>; viewportWidth: number } }>(`new Promise((done, fail) => {
      const frame = document.createElement('iframe');
      frame.name = 'so-test';
      Object.assign(frame.style, { position: 'fixed', left: '-10000px', width: '437px', height: '900px', border: '0' });
      let ready = null;
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'ready') {
          ready = e.data.payload;
          frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r' } }, '*');
        }
        if (e.data?.type === 'inspectResult') done({ ready, report: e.data.payload.report });
      });
      setTimeout(() => fail(new Error('No inspection result.')), 8000);
      frame.src = '/__siteorigin/component/abcdefabcdefabcdef/';
      document.body.appendChild(frame);
    })`);
  } finally {
    await browser.close();
  }
}

/**
 * Open the preview page on its own, as the editor's thumbnail window does (#370), and call what the bridge offers it
 * there; also whether the page shows as visitors see it.
 */
async function alone(body: string, preview: object) {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const origin = 'http://preview.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}<script>window.__siteoriginPreview = ${JSON.stringify(preview)};</script><script type="module" src="/bridge.js"></script></body></html>`
      });
    });
    await page.goto(`${origin}/__siteorigin/component/abcdefabcdefabcdef/`);
    await page.waitForFunction('typeof window.__siteoriginThumb === "function"', null, { timeout: 8000 });
    return await page.evaluate<{ measured: Preview; editing: boolean; unlinked: string | null }>(`(async () => ({
      measured: await window.__siteoriginThumb(),
      editing: document.documentElement.hasAttribute('data-so-editing'),
      unlinked: (() => { const el = document.querySelector('[data-so-unlinked]'); return el ? getComputedStyle(el).display : null; })()
    }))()`);
  } finally {
    await browser.close();
  }
}

describe('the bridge in an isolated component preview', () => {
  it.skipIf(!browserInstalled)('opened on its own, shows the component as visitors see it and measures it for its thumbnail', async () => {
    const body = `<main id="main"><div data-so-ctx="preview:c1" data-so-node="preview" style="margin:12px 0 0 30px;width:300px;height:150px;background:red"><a data-so-unlinked href="#">Nowhere</a></div></main>`;
    const { measured, editing, unlinked } = await alone(body, { key: 'abcdefabcdefabcdef', mounted: true });
    expect(editing).toBe(false);
    // A button with nowhere to go is left out, as on the site.
    expect(unlinked).toBe('none');
    expect(measured).toMatchObject({ key: 'abcdefabcdefabcdef', mounted: true, bounds: { x: 30, y: 12, width: 300, height: 150 } });
  }, 20000);

  it.skipIf(!browserInstalled)('opened on its own, says where the component paints, so its thumbnail frames that', async () => {
    // A full-width block with a heading and an icon in it, and a hidden note: only the heading and icon are seen.
    const body = `<main id="main"><div data-so-ctx="preview:c1" data-so-node="preview" style="padding:40px 0"><h2 style="margin:0 0 0 50px;font:20px/30px sans-serif;display:inline-block">Hi</h2><svg width="24" height="24" style="display:block;margin-left:300px"></svg><p style="visibility:hidden;margin:0">Hidden</p></div><div style="height:10px;background:transparent"></div></main>`;
    const { measured } = await alone(body, { key: 'abcdefabcdefabcdef', mounted: true });
    const m = measured as Preview & { ink: Box };
    expect(m.bounds?.width).toBe(640);
    expect(m.ink.x).toBe(50);
    // The heading's text starts at its letters, a little below the top of its line.
    expect(m.ink.y).toBeGreaterThanOrEqual(40);
    expect(m.ink.y).toBeLessThan(47);
    expect(Math.round(m.ink.x + m.ink.width)).toBe(324);
    expect(Math.round(m.ink.y + m.ink.height)).toBe(94);
    // A painted box counts whole.
    const { measured: card } = await alone(`<main id="main"><div style="margin:0 0 0 100px;width:200px;height:80px;background:#f00"></div></main>`, { key: 'abcdefabcdefabcdef', mounted: true });
    expect((card as Preview & { ink: Box }).ink).toEqual({ x: 100, y: 0, width: 200, height: 80 });
  }, 20000);

  it.skipIf(!browserInstalled)('opened on its own, says why a component did not mount', async () => {
    const { measured } = await alone('<main id="main"><p data-so-unlinked>x</p></main>', { key: 'abcdefabcdefabcdef', mounted: false, error: 'boom' });
    expect(measured).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null, text: '', ink: null });
  }, 20000);

  it.skipIf(!browserInstalled)('reports the box a code component fills through its wrapper, and no page heading check', async () => {
    const body = `<main id="main"><div style="display: contents" data-so-ctx="preview:c1" data-so-node="preview" data-so-code="true"><p style="margin:10px 20px;height:40px">One</p><p style="margin:0 20px;height:30px">Two</p></div></main>`;
    const { ready, report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true });
    expect(ready.path).toBe('/__siteorigin/component/abcdefabcdefabcdef/');
    expect(ready.preview).toMatchObject({ key: 'abcdefabcdefabcdef', mounted: true });
    expect(report.viewportWidth).toBe(437);
    expect(report.preview?.bounds).toEqual({ x: 20, y: 10, width: 397, height: 80 });
    expect(report.preview?.text).toBe('One Two');
    // A component is not a page: it is never told it lacks the page's one h1.
    expect(report.issues.map((i) => i.kind)).not.toContain('heading-structure');
  }, 20000);

  it.skipIf(!browserInstalled)('takes in every root, text with no box of its own, and wrappers inside wrappers', async () => {
    const body = `<main id="main"><div style="display: contents" data-so-code="true"><span style="display: contents"><b style="display:block;margin-left:30px;width:100px;height:20px">A</b></span>Loose text</div><section style="margin:50px 0 0 200px;width:50px;height:10px"></section></main>`;
    const { report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true });
    const b = report.preview!.bounds!;
    // The top is the bold block's, inside two wrappers; the loose text below it starts at the left edge; the section
    // sets the right edge and the foot.
    expect([b.x, b.y, Math.round(b.x + b.width)]).toEqual([0, 0, 250]);
    expect(b.height).toBeGreaterThan(20 + 50 + 10);
    expect(report.preview?.text).toBe('A Loose text');
  }, 20000);

  it.skipIf(!browserInstalled)('says why a component did not mount', async () => {
    const { ready, report } = await run('<main id="main"></main>', { key: 'abcdefabcdefabcdef', mounted: false, error: 'boom' });
    expect(ready.preview).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null, text: '' });
    expect(report.preview).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null, text: '' });
  }, 20000);
});
