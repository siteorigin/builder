/**
 * The layout inspection's image check, run on the real preview bridge in a real browser, in a frame set up the
 * way the editor sets up its measuring frame: hidden, off screen, sandboxed and on another origin.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { chromium, type Route } from 'playwright';
import { describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

/** A real (blank) PNG of the given size: a 1px image would report a natural width of 0 through srcset. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = deflateSync(Buffer.alloc((width * 3 + 1) * height));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', rows), chunk('IEND', Buffer.alloc(0))]);
}

interface ImageSummary {
  total: number;
  loaded: number;
  failed: number;
  unverified: number;
  failedFiles: string[];
}
interface Report {
  images: ImageSummary;
  issues: Array<{ kind: string; message: string }>;
}

const SITE = 'http://site.test';
const EDITOR = 'http://editor.test';

/**
 * A nested route (/contact/) whose images use the relative addresses SvelteKit renders on the server, with
 * responsive variants and lazy loading as the generated Image component writes them.
 */
const PAGE = (extra: string) => `<!doctype html><html><head><style>body{margin:0}img{display:block;max-width:100%;height:auto}</style></head><body>
<main data-so-node="n" data-so-ctx="page:p"><h1>Contact</h1>
<img alt="Hero" src="../assets/hero.jpg" width="1600" height="900" fetchpriority="high">
<div style="height:3000px"></div>
<img alt="Photo" loading="lazy" decoding="async" width="1600" height="900" src="../assets/photo.jpg" srcset="../assets/photo-640.jpg 640w, ../assets/photo-1280.jpg 1280w, ../assets/photo.jpg 1600w" sizes="100vw">
<img alt="Lazy" loading="lazy" decoding="async" width="640" height="360" src="/assets/lazy.jpg">
${extra}
</main><script type="module" src="/bridge.js"></script></body></html>`;

/** Inspect /contact/ at `width`, serving files from `files` (a function may answer differently each time). */
async function inspectAt(width: number, extra: string, files: Record<string, (route: Route) => Promise<void>>): Promise<Report> {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    const image = png(1600, 900);
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== SITE) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>editor</title>' });
      if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.pathname === '/contact/') return route.fulfill({ contentType: 'text/html', body: PAGE(extra) });
      const file = files[url.pathname];
      if (file) return file(route);
      if (['/assets/hero.jpg', '/assets/photo.jpg', '/assets/photo-1280.jpg', '/assets/lazy.jpg'].includes(url.pathname)) return route.fulfill({ contentType: 'image/png', body: image });
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
    });
    await page.goto(`${EDITOR}/`);
    // Runs in the browser, so it is passed as text (the Node project has no DOM types).
    return await page.evaluate<Report>(`new Promise((done, fail) => {
      const frame = document.createElement('iframe');
      frame.name = 'so-test';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '${width}px', height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
      window.addEventListener('message', (e) => {
        if (e.data?.sessionId !== 'so-test') return;
        if (e.data.type === 'ready') frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r' } }, '*');
        if (e.data.type === 'inspectResult') done(e.data.payload.report);
      });
      setTimeout(() => fail(new Error('No inspection result.')), 15000);
      frame.src = '${SITE}/contact/';
      document.body.appendChild(frame);
    })`);
  } finally {
    await browser.close();
  }
}

const brokenPaths = (r: Report) => r.issues.filter((i) => i.kind === 'broken-image').map((i) => i.message);

describe('layout inspection images', () => {
  it.skipIf(!browserInstalled)('reports loaded, missing and responsive images on a nested route at phone width', async () => {
    const report = await inspectAt(390, '<img alt="Gone" loading="lazy" src="/assets/missing.jpg">', {});
    // Hero (relative address on a nested route) and the lazy image load; the photo's phone variant and the
    // missing file do not.
    expect(report.images).toEqual({ total: 4, loaded: 2, failed: 2, unverified: 0, failedFiles: expect.arrayContaining(['photo-640.jpg', 'missing.jpg']) });
    expect(brokenPaths(report)).toEqual(expect.arrayContaining(['Image /assets/photo-640.jpg failed to load.', 'Image /assets/missing.jpg failed to load.']));
    // Image results lead the issue list, so many layout findings cannot hide them.
    expect(report.issues[0].kind).toBe('broken-image');
  }, 30000);

  it.skipIf(!browserInstalled)('loads responsive images whose variants are all there at desktop width', async () => {
    const image = png(640, 360);
    // Which variant the browser picks is its own choice; every one of them is there.
    const report = await inspectAt(1280, '', { '/assets/photo-640.jpg': (route) => route.fulfill({ contentType: 'image/png', body: image }) });
    expect(report.images).toMatchObject({ total: 3, loaded: 3, failed: 0, unverified: 0 });
    expect(brokenPaths(report)).toEqual([]);
  }, 30000);

  it.skipIf(!browserInstalled)('tells a failed request the preview recovers from, and one still loading, from a missing file', async () => {
    let flakyRequests = 0;
    const image = png(640, 360);
    const report = await inspectAt(1280, '<img alt="Flaky" src="/assets/flaky.jpg"><img alt="Slow" src="/assets/slow.jpg">', {
      '/assets/photo-640.jpg': (route) => route.fulfill({ contentType: 'image/png', body: image }),
      // The first request fails (the preview had not caught up yet); asked again, the file is there.
      '/assets/flaky.jpg': (route) => (++flakyRequests === 1 ? route.fulfill({ status: 404, body: 'Not yet' }) : route.fulfill({ contentType: 'image/png', body: image })),
      // Still loading when the check runs out of time: neither a pass nor a failure.
      '/assets/slow.jpg': async (route) => {
        await new Promise((r) => setTimeout(r, 9000));
        await route.fulfill({ contentType: 'image/png', body: image }).catch(() => {});
      }
    });
    expect(flakyRequests).toBeGreaterThan(1);
    expect(report.images).toMatchObject({ total: 5, loaded: 4, failed: 0, unverified: 1 });
    expect(brokenPaths(report)).toEqual([]);
    expect(report.issues.find((i) => i.kind === 'image-unverified')?.message).toMatch(/\/assets\/slow\.jpg.*not a problem with the site/);
  }, 30000);
});
