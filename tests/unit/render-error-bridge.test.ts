/**
 * The preview bridge in a real browser frame, on a page whose code component threw while it rendered (#1526): the
 * placement shows its note (see renderErrorBoundary in the generator), which raises no error of the window. The bridge
 * reports each note to the editor as the page's error, with the component's file, once the page says it is ready and
 * whenever a note appears later; a page served as a 500 with a note is the page, not one still being made, so it is
 * never loaded again in a loop.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const note = (message: string, file: string) =>
  `<div data-so-render-error="${message}" data-so-error-file="${file}" data-so-editor-only><strong>Broken couldn’t be shown</strong> <span>${message}</span></div>`;
const FRAME = `<!doctype html><html><head><title>Home</title></head><body>
<section data-so-ctx="page:p" data-so-node="hero"><h1>Hero</h1></section>
<div style="display: contents" data-so-ctx="page:p" data-so-node="broken" data-so-code="true">
  ${note('Cannot read properties of undefined (reading &#39;nested&#39;)', 'src/lib/siteorigin/custom/Broken.svelte')}
</div>
<section data-so-ctx="page:p" data-so-node="footer"><p>After</p></section>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let loads = 0;

type Message = { type: string; payload: Record<string, unknown> };
const messages = () => page.evaluate<Message[]>(`window.seen`);
const errorsSeen = async () => (await messages()).filter((m) => m.type === 'runtimeError').map((m) => ({ message: m.payload.message, file: m.payload.file }));

describe.skipIf(!browserInstalled)('a code component that threw while the page rendered', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      // Served as SvelteKit serves a page whose render threw inside a boundary: the page, with status 500.
      if (url.origin === SITE && url.pathname === '/frame') {
        loads++;
        return route.fulfill({ status: 500, contentType: 'text/html', body: FRAME });
      }
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:700px;height:400px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    // The editor asked for this page, as it does for a page it has just made: a 500 for it would be loaded again.
    await page.addInitScript(`if (location.origin === '${SITE}' && !window.__asked) { window.__asked = true; sessionStorage.setItem('siteorigin:asked', JSON.stringify({ path: '/frame', tries: 0 })); }`);
    await page.goto(`${HOST}/`);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reports the note as the page’s error once the page is ready, naming the component’s file', async () => {
    await expect.poll(async () => (await messages()).map((m) => m.type).filter((t) => t === 'ready' || t === 'runtimeError')).toEqual(['ready', 'runtimeError']);
    expect(await errorsSeen()).toEqual([{ message: "Cannot read properties of undefined (reading 'nested')", file: 'src/lib/siteorigin/custom/Broken.svelte' }]);
    // The page was not loaded again for its 500: it is there.
    expect(loads).toBe(1);
  });

  it('reports a note that appears later once, and the same note again only for another page', async () => {
    const frame = page.frames().find((f) => f.name() === 'so-test')!;
    await page.evaluate(`window.seen = []`);
    await frame.evaluate(`document.querySelector('[data-so-node="footer"]').insertAdjacentHTML('beforebegin', ${JSON.stringify(`<div style="display: contents" data-so-ctx="page:p" data-so-node="later" data-so-code="true">${note('later is not defined', 'src/lib/siteorigin/custom/Later.svelte')}</div>`)})`);
    await expect.poll(errorsSeen).toEqual([{ message: 'later is not defined', file: 'src/lib/siteorigin/custom/Later.svelte' }]);
    // Other changes to the page say nothing more of notes already reported.
    await frame.evaluate(`document.querySelector('h1').textContent = 'Hero again'`);
    await page.waitForTimeout(150);
    expect(await errorsSeen()).toHaveLength(1);
    // Another page (a link followed in place): both notes are its problems too.
    await page.evaluate(`window.seen = []`);
    await frame.evaluate(`history.pushState(null, '', '/other'); dispatchEvent(new CustomEvent('siteorigin:navigated'))`);
    await expect.poll(async () => (await errorsSeen()).map((e) => e.file).sort()).toEqual(['src/lib/siteorigin/custom/Broken.svelte', 'src/lib/siteorigin/custom/Later.svelte']);
  });
});
