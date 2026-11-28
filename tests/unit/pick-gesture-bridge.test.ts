/**
 * The real preview bridge, in a real browser frame on another origin as the editor's preview is, says how each pick on
 * the page was made (#1361). A press of the mouse is `pointer`, and the editor then takes the keyboard back from the
 * page for the selection; Enter on a link reached with Tab is not, and the link keeps the keyboard.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inputReachesFrame } from './frame-input';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:20px/1.4 sans-serif}header,section{padding:10px}section{height:200px}</style></head><body>
<header data-so-node="nav" data-so-ctx="shell:header"><a data-so-node="about" data-so-ctx="shell:header" href="/about">About</a></header>
<section data-so-node="hero" data-so-ctx="page:p"><h1 data-so-node="title" data-so-ctx="page:p">Split hero</h1></section>
<script type="module" src="/bridge.js"></script></body></html>`;

type Sent = { type: string; payload: { chain?: { node: string }[]; pointer?: unknown } };

let browser: Browser;
let page: Page;
let frame: Frame;

const picks = async () => (await page.evaluate<Sent[]>(`window.seen`)).filter((m) => m.type === 'select');
const focused = () => frame.evaluate<string>(`document.activeElement.getAttribute('data-so-node') || document.activeElement.tagName`);

describe.skipIf(!browserInstalled)('how a pick on the page was made', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><button id="layers">Split hero</button><iframe name="so-test" src="${SITE}/frame" style="border:0;display:block;width:700px;height:400px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    const box = (await page.locator('iframe').boundingBox())!;
    await inputReachesFrame(page, frame, { x: box.x + 300, y: box.y + 300 });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reports a keyboard pick as no pointer, with the link reached by Tab keeping the keyboard', async () => {
    await page.evaluate(`window.seen = []`);
    // From the editor's last control into the page, as the author did: the header's link is the page's first stop.
    await page.focus('#layers');
    await page.keyboard.press('Tab');
    await expect.poll(focused).toBe('about');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await picks()).length).toBe(1);
    const [pick] = await picks();
    expect(pick.payload.chain?.[0]?.node).toBe('about');
    expect(pick.payload.pointer).toBe(false);
    expect(await focused()).toBe('about');
    expect(await page.evaluate(`document.activeElement.tagName`)).toBe('IFRAME');
  });

  it('reports a press of the mouse as a pointer pick, whatever on the page has the keyboard', async () => {
    await page.evaluate(`window.seen = []`);
    expect(await focused()).toBe('about');
    // Below the heading, on the section's own space: in page coordinates, as boxes inside the frame are given.
    const hero = (await frame.locator('[data-so-node="hero"]').boundingBox())!;
    await page.mouse.click(hero.x + 20, hero.y + hero.height - 20);
    await expect.poll(async () => (await picks()).length).toBe(1);
    const [pick] = await picks();
    expect(pick.payload.chain?.[0]?.node).toBe('hero');
    expect(pick.payload.pointer).toBe(true);
    // The page itself moves no focus for a press while editing: the editor is the one to take the keyboard back.
    expect(await focused()).toBe('about');
  });
});
