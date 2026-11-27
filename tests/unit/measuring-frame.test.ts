/**
 * The editor measures a page in a frame of the preview's origin, which is not the editor's (#976). Chromium does not
 * render such a frame when it is outside the window or `visibility: hidden`: the page's animation frames never come,
 * so the bridge waited out its whole deadline for the two it waits for, on every page check. Where the editor puts its
 * measuring frames, they are rendered, and the page settles in a few frames. Runs the real bridge in a real browser.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { MEASURING_SESSION_PREFIX, measuringFrameStyle } from '../../src/renderer/src/lib/measuring-frame';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

/** Where the frames used to be: outside the window and hidden. */
const OUTSIDE = { position: 'fixed', left: '-10000px', top: '0', width: '1280px', height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' };

describe('the frame a page is measured in', () => {
  it.skipIf(!browserInstalled)('is rendered, so the page settles in a few frames rather than at its deadline', async () => {
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    try {
      const page = await browser.newPage();
      // The editor and the preview are of different origins (and sites), as app:// and the preview server are.
      await page.route('http://editor.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>editor</title><body></body>' }));
      await page.route('http://preview.test/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><main data-so-node="n" data-so-ctx="page:p"><h1>Measured</h1></main><script type="module" src="/bridge.js"></script></body></html>' });
      });
      await page.goto('http://editor.test/');
      /** How long the page waited for its frames before it was measured, with the frame styled `style`. */
      const frameWait = (style: Record<string, string>, name: string) =>
        // Runs in the browser, so it is passed as text (the Node project has no DOM types).
        page.evaluate<number>(`new Promise((done, fail) => {
          const frame = document.createElement('iframe');
          frame.name = ${JSON.stringify(name)};
          Object.assign(frame.style, ${JSON.stringify(style)});
          frame.src = 'http://preview.test/page';
          frame.onload = () => frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: ${JSON.stringify(name)}, type: 'inspect', payload: { requestId: 'r', timing: true } }, '*');
          window.addEventListener('message', (e) => {
            if (e.source === frame.contentWindow && e.data?.type === 'inspectResult') done(e.data.payload.report.settled.frame);
          });
          setTimeout(() => fail(new Error('No inspection result.')), 12000);
          document.body.appendChild(frame);
        })`);
      expect(await frameWait(measuringFrameStyle(1280), 'so-here')).toBeLessThan(1000);
      // Outside the window, the same page never gets its frames: it waits until its 4 s are up.
      expect(await frameWait(OUTSIDE, 'so-outside')).toBeGreaterThanOrEqual(3900);
    } finally {
      await browser.close();
    }
  }, 30000);

  /** A page of the preview's origin with the bridge and `body`, its hot updates sent through a stand-in the test drives. */
  async function previewPage(body: string) {
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await browser.newPage();
    const hot = bridge.replaceAll('import.meta.hot', 'window.__hot');
    // The editor's window keeps painting (as the editor does), so the browser keeps making frames for it and its frames.
    const busy = '<style>@keyframes busy { to { transform: rotate(1turn); } }</style><div style="width:20px;height:20px;background:#ccc;animation:busy 1s linear infinite"></div>';
    await page.route('http://editor.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>editor</title><body>${busy}</body>` }));
    await page.route('http://preview.test/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: hot });
      // The stand-in tells the editor's page what the bridge sends the preview server, and plays its revision events.
      const stub = `<script>const on = {}; window.__hot = { on: (n, f) => (on[n] = f), send: (n) => parent.postMessage({ hotSent: n }, '*') }; addEventListener('message', (e) => { if (e.data && e.data.playRevision) on['siteorigin:revision']({ revision: 1, batch: 1 }); });</script>`;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body style="margin:0">${stub}${body}<script type="module" src="/bridge.js"></script></body></html>` });
    });
    await page.goto('http://editor.test/');
    return { browser, page };
  }

  it.skipIf(!browserInstalled)('never acknowledges an update for the canvas: the preview server waits for the canvas’s own', async () => {
    const { browser, page } = await previewPage('<main data-so-node="n" data-so-ctx="page:p"><h1>Measured</h1></main>');
    try {
      /** What the bridge sent the preview server once it took a revision, in a frame named `name`, its page loaded `loads` times. */
      const sent = (name: string, loads = 1) =>
        page.evaluate<string[]>(`new Promise((done) => {
          const frame = document.createElement('iframe');
          frame.name = ${JSON.stringify(name)};
          Object.assign(frame.style, ${JSON.stringify(measuringFrameStyle(1280))});
          frame.src = 'http://preview.test/page';
          const got = [];
          let left = ${loads};
          window.addEventListener('message', (e) => {
            if (e.source === frame.contentWindow && e.data?.hotSent) got.push(e.data.hotSent);
          });
          frame.onload = () => {
            // Loaded again (a full reload by the preview server): a new document in the same frame, with its name.
            if (--left > 0) return void (frame.src = 'http://preview.test/page?again=' + left);
            frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: ${JSON.stringify(name)}, type: 'mode', payload: { mode: 'preview' } }, '*');
            setTimeout(() => frame.contentWindow.postMessage({ playRevision: true }, '*'), 50);
            setTimeout(() => done(got), 800);
          };
          document.body.appendChild(frame);
        })`);
      expect(await sent('so-canvas')).toContain('siteorigin:applied');
      expect(await sent(`${MEASURING_SESSION_PREFIX}one`)).not.toContain('siteorigin:applied');
      expect(await sent(`${MEASURING_SESSION_PREFIX}two`, 2)).not.toContain('siteorigin:applied');
    } finally {
      await browser.close();
    }
  }, 30000);

  it.skipIf(!browserInstalled)('waits for an entrance under way to end, its next step too, and not for one that never does, when asked', async () => {
    const style =
      '<style>@keyframes in { from { transform: translateX(3000px); } } @keyframes again { from { transform: translateX(3000px); } } .in { animation: in 500ms linear; } .in.again { animation: again 500ms linear; } @keyframes spin { to { transform: rotate(1turn); } } .spin { width: 10px; height: 10px; animation: spin 1s linear infinite; }</style>';
    // The second step starts as the first ends, from the same place off to the right.
    const steps = `<script>addEventListener('animationend', (e) => { if (e.animationName === 'in') e.target.classList.add('again'); });</script>`;
    const { browser, page } = await previewPage(`${style}<main data-so-node="n" data-so-ctx="page:p"><div class="in">Sliding in</div><div class="spin"></div></main>${steps}`);
    try {
      /** The report of a check of the page, which asks (or not) for animations under way to be let end. */
      const inspect = (name: string, animations: boolean) =>
        page.evaluate<{ documentWidth: number; viewportWidth: number; settled: { frame: number } }>(`new Promise((done, fail) => {
        const frame = document.createElement('iframe');
        frame.name = ${JSON.stringify(name)};
        Object.assign(frame.style, ${JSON.stringify(measuringFrameStyle(1280))});
        frame.src = 'http://preview.test/page';
        frame.onload = () => frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: ${JSON.stringify(name)}, type: 'inspect', payload: { requestId: 'r', timing: true, animations: ${animations} } }, '*');
        window.addEventListener('message', (e) => {
          if (e.source === frame.contentWindow && e.data?.type === 'inspectResult') done(e.data.payload.report);
        });
        setTimeout(() => fail(new Error('No inspection result.')), 12000);
        document.body.appendChild(frame);
      })`);
      const report = await inspect('so-check', true);
      // Measured where the box comes to rest after both steps, not 3,000 px to its right, and before the 4 s deadline:
      // the spinner is not waited for.
      expect(report.documentWidth).toBeLessThanOrEqual(report.viewportWidth);
      expect(report.settled.frame).toBeGreaterThan(800);
      expect(report.settled.frame).toBeLessThan(3500);
      // A preview sized as it shows (Insert, the Inspector) asks again every 600 ms and keeps only the latest answer:
      // it is answered after its frames, well before the entrance's two steps are over.
      const sizing = (await inspect('so-sizing', false)).settled.frame;
      expect(sizing).toBeLessThan(report.settled.frame - 400);
      expect(sizing).toBeLessThan(1500);
    } finally {
      await browser.close();
    }
  }, 30000);
});
