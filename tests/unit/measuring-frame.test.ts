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

  /**
   * A page whose entrance starts when the test says (so it is under way when the check begins), in one step or two, the
   * second set off as the first ends, beside a spinner that never stops. Each step would run for a minute: it ends three
   * frames after the bridge takes its `finished` (read through document.getAnimations, which the page wraps), so a step
   * is under way whenever the bridge looks, and a bridge that looks again without waiting finds it still running. The page tells the test as each step
   * ends, and records each look (when, after the request, and what was running) and what the bridge waited on, so the
   * checks are told apart by what the bridge did, never by how long frames took.
   */
  const entrancePage = (steps: 0 | 1 | 2) =>
    '<style>@keyframes in { from { transform: translateX(3000px); } } @keyframes again { from { transform: translateX(3000px); } }' +
    ' .in.go { animation: in 60s linear; } .in.go.again { animation: again 60s linear; }' +
    ' @keyframes spin { to { transform: rotate(1turn); } } .spin { width: 10px; height: 10px; animation: spin 1s linear infinite; }</style>' +
    `<main data-so-node="n" data-so-ctx="page:p">${steps ? '<div class="in">Sliding in</div>' : ''}<div class="spin"></div></main>` +
    '<script>const probe = { looks: [], waitedOn: [] }; let asked = 0; const all = document.getAnimations.bind(document);' +
    " document.getAnimations = () => { const found = all(); probe.looks.push({ after: performance.now() - asked, running: found.filter((a) => a.playState === 'running').map((a) => a.animationName) });" +
    " return found.map((a) => new Proxy(a, { get(t, k) { if (k === 'finished') { probe.waitedOn.push(t.animationName); let n = 0; const later = () => (++n < 3 ? requestAnimationFrame(later) : t.finish()); requestAnimationFrame(later); } const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } })); };" +
    " addEventListener('message', (e) => { if (!e.data) return; if (e.data.type === 'inspect') asked = performance.now(); if (e.data.startEntrance) document.querySelector('.in')?.classList.add('go'); if (e.data.probe) parent.postMessage({ probed: probe }, '*'); });" +
    ` addEventListener('animationend', (e) => { parent.postMessage({ ended: e.animationName }, '*'); if (e.animationName === 'in' && ${steps} > 1) e.target.classList.add('again'); });</script>`;
  /** A frame shown in full, which the browser draws every frame: a check's frames then come at the display's rate. */
  const SHOWN = { position: 'fixed', left: '0', top: '0', width: '1280px', height: '900px', border: '0' };
  type Probe = { looks: Array<{ after: number; running: string[] }>; waitedOn: string[] };
  /**
   * Start the page's entrance and check it at once, asking (or not, as the Insert panel's and Inspector's previews being
   * sized do, with no field at all) for animations under way to be let end: the steps that had ended when the answer
   * came, in the order the page said so, the answer, and what the bridge did with the page's animations.
   */
  async function checkWhileEntering(body: string, askToLetEnd: boolean, style: Record<string, string>) {
    const { browser, page } = await previewPage(body);
    try {
      return await page.evaluate<{ ended: string[]; report: { error?: string; documentWidth: number; viewportWidth: number }; probe: Probe }>(`new Promise((done, fail) => {
        const frame = document.createElement('iframe');
        frame.name = 'so-entrance';
        Object.assign(frame.style, ${JSON.stringify(style)});
        frame.src = 'http://preview.test/page';
        const ended = [];
        let report = null;
        window.addEventListener('message', (e) => {
          if (e.source !== frame.contentWindow) return;
          if (e.data?.ended) ended.push(e.data.ended);
          if (e.data?.type === 'inspectResult') {
            report = { ended: [...ended], report: e.data.payload.report };
            frame.contentWindow.postMessage({ probe: true }, '*');
          }
          if (e.data?.probed && report) done({ ...report, probe: e.data.probed });
        });
        frame.onload = () => {
          frame.contentWindow.postMessage({ startEntrance: true }, '*');
          frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-entrance', type: 'inspect', payload: { requestId: 'r', ...(${askToLetEnd} ? { animations: true } : {}) } }, '*');
        };
        setTimeout(() => fail(new Error('No inspection result.')), 12000);
        document.body.appendChild(frame);
      })`);
    } finally {
      await browser.close();
    }
  }

  it.skipIf(!browserInstalled)('waits, when asked, for an entrance under way and the step it sets off to end, before measuring', async () => {
    const { ended, report, probe } = await checkWhileEntering(entrancePage(2), true, SHOWN);
    expect(report.error).toBeUndefined();
    // It waited on each step in turn, and both had ended when it answered, so the box was measured where it comes to
    // rest, not 3,000 px to its right.
    expect(probe.waitedOn).toEqual(['in', 'again']);
    expect(ended).toEqual(['in', 'again']);
    expect(report.documentWidth).toBeLessThanOrEqual(report.viewportWidth);
  }, 30000);

  it.skipIf(!browserInstalled)('never waits for an animation that never ends, even when asked', async () => {
    const { report, probe } = await checkWhileEntering(entrancePage(0), true, measuringFrameStyle(1280));
    expect(report.error).toBeUndefined();
    // It looked at the page's animations well inside its 4 s, saw the spinner running, and did not wait on it.
    expect(probe.looks.some((l) => l.after < 3500 && l.running.includes('spin'))).toBe(true);
    expect(probe.waitedOn).toEqual([]);
  }, 30000);

  it.skipIf(!browserInstalled)('does not hold up a preview being sized, which asks again every 600 ms and keeps only the latest answer', async () => {
    const { report, probe } = await checkWhileEntering(entrancePage(1), false, measuringFrameStyle(1280));
    expect(report.error).toBeUndefined();
    expect(report.viewportWidth).toBe(1280);
    // Asked with no `animations`, as Insert and the Inspector ask: the page's animations were not even looked at.
    expect(probe).toEqual({ looks: [], waitedOn: [] });
  }, 30000);
});
