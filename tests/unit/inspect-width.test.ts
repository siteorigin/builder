/**
 * The layout inspection runs the real preview bridge in a real browser frame with classic scrollbars,
 * because the bug it guards against (a scrollbar narrowing the measured viewport) only exists in layout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

describe('layout inspection width', () => {
  it.skipIf(!browserInstalled)('measures the full 390px on a tall page, whatever the scrollbar', async () => {
    // Playwright hides scrollbars by default, which would hide this bug.
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const page = await browser.newPage();
      const origin = 'http://inspect.test';
      await page.route(`${origin}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
        if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html{overflow-y:scroll}body{margin:0}</style></head><body><main data-so-node="n" data-so-ctx="page:p" style="height:4000px"><h1>Tall</h1></main><script type="module" src="/bridge.js"></script></body></html>' });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>host</title>' });
      });
      await page.goto(`${origin}/`);
      // Runs in the browser, so it is passed as text (the Node project has no DOM types).
      const report = await page.evaluate<{ viewportWidth: number; before: number }>(`new Promise((done, fail) => {
        const frame = document.createElement('iframe');
        frame.name = 'so-test';
        Object.assign(frame.style, { position: 'fixed', left: '-10000px', width: '390px', height: '900px', border: '0' });
        frame.src = '/frame';
        let before = 0;
        frame.onload = () => setTimeout(() => (before = frame.contentDocument.documentElement.clientWidth, frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r' } }, '*')), 100);
        window.addEventListener('message', (e) => {
          if (e.data?.type === 'inspectResult') done({ ...e.data.payload.report, before });
        });
        setTimeout(() => fail(new Error('No inspection result.')), 8000);
        document.body.appendChild(frame);
      })`);
      // The fixture really does lose width to a scrollbar until the inspection removes it.
      expect(report.before).toBeLessThan(390);
      expect(report.viewportWidth).toBe(390);
    } finally {
      await browser.close();
    }
  }, 20000);
});
