/**
 * The preview bridge reports where its frame is in the frame's own history, and steps Back and Forward through it
 * for a visitor's journey in Preview. Runs the real bridge in a real browser frame on another origin, as the
 * editor's preview is, with plain pages: a link to another page loads it in full, a section link stays on the page.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main data-so-node="s" data-so-ctx="page:p">${body}</main><script type="module" src="/bridge.js"></script></body></html>`;
const PAGES: Record<string, string> = {
  '/': PAGE('Home', '<a id="to-about" href="/about/">About</a>'),
  '/about/': PAGE('About', '<a id="to-contact" href="/contact/#studio-hours">Book a call</a> <a id="to-services" href="/services/">Services</a>'),
  '/contact/': PAGE('Contact', '<a id="to-form" href="#form">Write to us</a><div style="height:3000px"></div><h2 id="studio-hours">Hours</h2><h2 id="form">Form</h2><div style="height:3000px"></div>'),
  '/services/': PAGE('Services', '<p>Services</p>')
};

interface History {
  address: string;
  key: string | null;
  back: string | null;
  forward: string | null;
}

let browser: Browser;
let page: Page;

const frame = () => page.frames().find((f) => f.name() === 'so-test')!;
/** The bridge's latest report of where the frame is. */
const latest = () => page.evaluate<History | null>(`window.latest`);
/** Wait for the frame to report this address, and return the report. */
async function reported(address: string): Promise<History> {
  await expect.poll(async () => (await latest())?.address, { timeout: 10000 }).toBe(address);
  return (await latest())!;
}
const command = (type: string, payload: unknown) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
/** The page's bridge has started and taken the mode the editor gave it (it starts out editing). */
const BRIDGED = `[...document.querySelectorAll('style')].some((s) => s.textContent.includes('data-so-unlinked'))`;
const previewing = () => frame().waitForFunction(`document.readyState === 'complete' && ${BRIDGED} && !document.documentElement.hasAttribute('data-so-editing')`);
/** Follow a link as a visitor does, once the page is in Preview (links are picked, not followed, while editing). */
async function follow(id: string) {
  await previewing();
  await frame().click(`#${id}`);
}
/** Start over: a fresh frame on Home, in Preview, with nothing reported yet. */
async function fresh() {
  await page.goto(`${HOST}/`);
  await previewing();
}
/** Replace the frame's traverseTo with a stand-in that counts its calls, and fails them when asked. */
const stubTraverse = (fail: boolean) =>
  frame().evaluate(`(() => {
    window.traverses = 0;
    navigation.traverseTo = () => {
      window.traverses++;
      const refused = () => Promise.reject(new DOMException('The step was interrupted.', 'AbortError'));
      return ${fail} ? { committed: refused(), finished: refused() } : { committed: Promise.resolve(), finished: Promise.resolve() };
    };
  })()`);
const traverses = () => frame().evaluate<number>(`window.traverses`);

describe.skipIf(!browserInstalled)('a visitor’s journey through the preview frame', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && PAGES[url.pathname]) return route.fulfill({ contentType: 'text/html', body: PAGES[url.pathname] });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/" style="border:0;width:700px;height:400px"></iframe></body>` });
      return route.abort();
    });
    // The editor's side: keep the latest history report, and put every page that loads into Preview, as the editor
    // does when a page says it is ready.
    await page.addInitScript(`if (location.origin === '${HOST}') {
      window.mode = 'preview';
      window.latest = null;
      window.errors = [];
      window.addEventListener('message', (e) => {
        if (!e.data || e.data.sessionId !== 'so-test') return;
        if (e.data.type === 'history') window.latest = e.data.payload;
        if (e.data.type === 'runtimeError') window.errors.push(e.data.payload.message);
        if (e.data.type === 'ready') e.source.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'mode', payload: { mode: window.mode } }, '*');
      });
    }`);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reports each page and section visited, with the #fragment, and steps back and forward through them', async () => {
    await fresh();
    const home = await reported('/');
    expect(home.key).toBeTruthy();
    expect(home.back).toBeNull();

    await follow('to-about');
    const about = await reported('/about/');
    expect(about.back).toBe(home.key);

    await follow('to-contact');
    const contact = await reported('/contact/#studio-hours');
    expect(contact.back).toBe(about.key);
    expect(contact.forward).toBeNull();

    // A section jump on the same page is a visit of its own.
    await follow('to-form');
    const form = await reported('/contact/#form');
    expect(form.back).toBe(contact.key);

    // Back to the section, then back across a page load to About, which still has Contact ahead of it.
    await command('traverse', { key: form.back });
    expect((await reported('/contact/#studio-hours')).forward).toBe(form.key);
    await command('traverse', { key: contact.back });
    const backAtAbout = await reported('/about/');
    expect(backAtAbout).toEqual({ ...about, forward: contact.key });

    // Forward after Back.
    await command('traverse', { key: backAtAbout.forward });
    expect((await reported('/contact/#studio-hours')).key).toBe(contact.key);

    // Back, then a new link: the frame drops the entries that were ahead.
    await command('traverse', { key: contact.back });
    await reported('/about/');
    await follow('to-services');
    const services = await reported('/services/');
    expect(services.back).toBe(about.key);
    expect(services.forward).toBeNull();
  }, 30000);

  it('steps only while previewing, and only to a neighbouring entry', async () => {
    // Home → About → Services.
    await fresh();
    const home = await reported('/');
    await follow('to-about');
    await reported('/about/');
    await follow('to-services');
    const at = await reported('/services/');
    await previewing();
    await stubTraverse(false);
    // While editing, Back is the editor's to refuse: the page stays, and says where it is.
    await command('mode', { mode: 'edit' });
    await page.evaluate(`window.latest = null`);
    await command('traverse', { key: at.back });
    expect(await reported('/services/')).toEqual(at);
    // Previewing, an entry two steps away (Home, behind About) or one that does not exist is not a step.
    await command('mode', { mode: 'preview' });
    for (const key of [home.key, 'no-such-entry']) {
      await page.evaluate(`window.latest = null`);
      await command('traverse', { key });
      expect(await reported('/services/')).toEqual(at);
    }
    expect(await traverses()).toBe(0);
    // One step back is.
    await command('traverse', { key: at.back });
    await expect.poll(traverses).toBe(1);
  }, 30000);

  it('says where the page still is when a step is interrupted, without reporting a page error', async () => {
    await fresh();
    await reported('/');
    await follow('to-about');
    const about = await reported('/about/');
    await previewing();
    await stubTraverse(true);
    await page.evaluate(`window.latest = null`);
    await command('traverse', { key: about.back });
    expect(await reported('/about/')).toEqual(about);
    expect(await traverses()).toBe(1);
    // Give an unhandled rejection time to be reported, as it would be.
    await frame().evaluate(`new Promise((r) => setTimeout(r, 200))`);
    expect(await page.evaluate<string[]>(`window.errors`)).toEqual([]);
  }, 30000);
});
