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
type Preview = { key: string; mounted: boolean; error?: string; bounds: Box | null };

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

describe('the bridge in an isolated component preview', () => {
  it.skipIf(!browserInstalled)('reports the box a code component fills through its wrapper, and no page heading check', async () => {
    const body = `<main id="main"><div style="display: contents" data-so-ctx="preview:c1" data-so-node="preview" data-so-code="true"><p style="margin:10px 20px;height:40px">One</p><p style="margin:0 20px;height:30px">Two</p></div></main>`;
    const { ready, report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true });
    expect(ready.path).toBe('/__siteorigin/component/abcdefabcdefabcdef/');
    expect(ready.preview).toMatchObject({ key: 'abcdefabcdefabcdef', mounted: true });
    expect(report.viewportWidth).toBe(437);
    expect(report.preview?.bounds).toEqual({ x: 20, y: 10, width: 397, height: 80 });
    // A component is not a page: it is never told it lacks the page's one h1.
    expect(report.issues.map((i) => i.kind)).not.toContain('heading-structure');
  }, 20000);

  it.skipIf(!browserInstalled)('says why a component did not mount', async () => {
    const { ready, report } = await run('<main id="main"></main>', { key: 'abcdefabcdefabcdef', mounted: false, error: 'boom' });
    expect(ready.preview).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null });
    expect(report.preview?.mounted).toBe(false);
  }, 20000);
});
