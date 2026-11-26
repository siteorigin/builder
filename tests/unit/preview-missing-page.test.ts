/**
 * A page the editor asks the preview for may be one just added, which the preview server does not serve yet: on a
 * slower machine (Windows) the frame's load of it was answered Not Found and stayed that way, though the page was
 * there a moment later. The bridge loads such a page again until the server has it; a visitor's broken link stays
 * missing. Runs the real bridge in a real browser frame on another origin, as the editor's preview is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main data-so-node="s" data-so-ctx="page:p">${body}</main><script type="module" src="/bridge.js"></script></body></html>`;
const NOT_FOUND = PAGE('Not Found', '<h1>404</h1>');

let browser: Browser;
let page: Page;
/** How many loads of each page the server answers Not Found before it serves the page, and the loads it was asked for. */
let missingFor: Record<string, number>;
let loads: Record<string, number>;

const frame = () => page.frames().find((f) => f.name() === 'so-test')!;
const command = (type: string, payload: unknown) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
/** The page each 'ready' the frame sent named, in order. */
const readies = () => page.evaluate<string[]>('window.readies');
const heading = () => frame().evaluate<string>(`document.querySelector('h1')?.textContent ?? ''`);

describe.skipIf(!browserInstalled)('a page the editor asks for before the preview server has it', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && route.request().resourceType() === 'document') {
        loads[url.pathname] = (loads[url.pathname] ?? 0) + 1;
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE('Home', '<h1>Home</h1>') });
        if ((missingFor[url.pathname] ?? Infinity) >= loads[url.pathname]) return route.fulfill({ status: 404, contentType: 'text/html', body: NOT_FOUND });
        return route.fulfill({ contentType: 'text/html', body: PAGE('Our ovens', '<h1>Our ovens</h1>') });
      }
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/" style="border:0;width:700px;height:400px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') {
      window.readies = [];
      window.addEventListener('message', (e) => {
        if (e.data && e.data.sessionId === 'so-test' && e.data.type === 'ready') window.readies.push(e.data.payload.path);
      });
    }`);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    missingFor = {};
    loads = {};
    await page.goto(`${HOST}/`);
    await expect.poll(readies).toEqual(['/']);
  });

  it('loads it again until the server has it, and says it is ready only then', async () => {
    // Not Found for the first two loads, as the dev server answers before it has picked up the new route.
    missingFor['/our-ovens/'] = 2;
    await command('navigate', { path: '/our-ovens/', navId: 1 });
    await expect.poll(heading, { timeout: 10000 }).toBe('Our ovens');
    expect(loads['/our-ovens/']).toBe(3);
    await expect.poll(readies).toEqual(['/', '/our-ovens/']);
  });

  it('shows a page still missing after a few tries as missing', async () => {
    await command('navigate', { path: '/nowhere/', navId: 2 });
    await expect.poll(readies, { timeout: 15000 }).toEqual(['/', '/nowhere/']);
    expect(await heading()).toBe('404');
    expect(loads['/nowhere/']).toBe(7);
  });

  it('leaves a missing page a visitor’s link led to as it is', async () => {
    // Followed as a visitor's link is in Preview: a load of its own, not one the editor asked for.
    await frame().evaluate(`location.assign('/gone/')`);
    await expect.poll(readies).toEqual(['/', '/gone/']);
    await page.waitForTimeout(1000);
    expect(loads['/gone/']).toBe(1);
    expect(await heading()).toBe('404');
  });
});
