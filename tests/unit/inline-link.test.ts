/**
 * The link field on the canvas (⌘K while editing rich text) runs the real preview bridge in a real browser frame
 * on another origin, as the editor's preview is. The host page stands in for the editor: it answers the bridge's
 * check of each destination, as Canvas does with inlineLinkProblem, and says when it kept nothing of an edit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inlineLinkProblem, linkFieldProblem } from '../../src/renderer/src/lib/link-problems';
import { createStarterState } from '@catalogue/starters';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const RICH = '<p>Read <a href="/about/">about us</a> today</p>';
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:20px/1.4 monospace}p,div{margin:0;padding:10px}</style></head><body>
<main data-so-node="s" data-so-ctx="page:p">
  <div class="so-rich" data-so-node="r" data-so-ctx="page:p">${RICH}</div>
</main><script type="module" src="/bridge.js"></script></body></html>`;

interface Message {
  type: string;
  payload: Record<string, unknown>;
}

let browser: Browser;
let page: Page;
let frame: Frame;
let edits = 0;

const messages = () => page.evaluate<Message[]>(`window.seen`);
const toFrame = (type: string, payload: unknown) =>
  page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: 'so-test', type, payload })}, '*')`);
/** The bridge's next check of a destination, once it has asked. */
async function nextCheck(after: number): Promise<{ check: number; href: string }> {
  await expect.poll(async () => (await messages()).filter((m) => m.type === 'checkLink').length).toBeGreaterThan(after);
  const m = (await messages()).filter((m) => m.type === 'checkLink').at(-1)!;
  return { check: m.payload.check as number, href: m.payload.href as string };
}
const checks = async () => (await messages()).filter((m) => m.type === 'checkLink').length;
/** The link field, as the author sees it. */
const field = () =>
  frame.evaluate<{ open: boolean; value?: string; invalid?: string | null; error?: string; errorShown?: boolean }>(`(() => {
    const host = [...document.documentElement.children].find((el) => el.shadowRoot && el.shadowRoot.querySelector('input[aria-label="Link destination"]'));
    if (!host) return { open: false };
    const input = host.shadowRoot.querySelector('input');
    const error = host.shadowRoot.querySelector('.error');
    return { open: true, value: input.value, invalid: input.getAttribute('aria-invalid'), error: error.textContent, errorShown: !error.hidden };
  })()`);
const hrefs = () => frame.evaluate<string[]>(`[...document.querySelectorAll('[data-so-node="r"] a')].map((a) => a.getAttribute('href'))`);

/** Edit the rich text with the caret in the linked words, then open the link field. */
async function openField() {
  edits++;
  await page.evaluate(`window.seen = []`);
  await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(RICH)}`);
  await page.evaluate(`document.querySelector('iframe').focus()`);
  await toFrame('beginTextEdit', { desc: { ctx: 'page:p', node: 'r', items: '' }, editId: `e${edits}` });
  await expect.poll(async () => (await messages()).some((m) => m.type === 'textEditStarted')).toBe(true);
  await frame.evaluate(`(() => {
    const t = document.querySelector('[data-so-node="r"] a').firstChild;
    const r = document.createRange();
    r.setStart(t, 2);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await page.keyboard.press(`${MOD}+k`);
  await expect.poll(async () => (await field()).open).toBe(true);
  expect((await field()).value).toBe('/about/');
}

describe.skipIf(!browserInstalled)('the link field on the canvas', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:700px;height:400px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    // A field or edit left open by the last test ends first.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  it('stays open on a page the site does not have, says why, and keeps the link the words had', async () => {
    await openField();
    await page.keyboard.type('/abot/');
    await page.keyboard.press('Enter');
    const { check, href } = await nextCheck(0);
    expect(href).toBe('/abot/');
    // Until the editor answers, nothing is linked and the field stays.
    expect((await field()).open).toBe(true);
    await toFrame('linkChecked', { check, problem: 'No page has the address /abot/.' });
    await expect.poll(async () => (await field()).errorShown).toBe(true);
    expect(await field()).toEqual({ open: true, value: '/abot/', invalid: 'true', error: 'No page has the address /abot/.', errorShown: true });
    expect(await hrefs()).toEqual(['/about/']);
    // Typing again clears the message.
    await page.keyboard.press('Backspace');
    expect(await field()).toMatchObject({ invalid: null, errorShown: false });
    // Escape leaves the field; committing the edit keeps the link the words had.
    await page.keyboard.press('Escape');
    expect((await field()).open).toBe(false);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textCommit' || m.type === 'textCancel')).toBe(true);
    // Nothing changed, so nothing is committed; what the page shows still links where it did.
    const ended = (await messages()).find((m) => m.type === 'textCommit' || m.type === 'textCancel')!;
    expect(ended.type).toBe('textCancel');
    expect(await hrefs()).toEqual(['/about/']);
  });

  it('links the words once the editor says the destination is good', async () => {
    await openField();
    await page.keyboard.type('/about#team');
    await page.keyboard.press('Enter');
    const { check } = await nextCheck(0);
    await toFrame('linkChecked', { check });
    await expect.poll(async () => (await field()).open).toBe(false);
    expect(await hrefs()).toEqual(['/about#team']);
  });

  it('acts only on the answer about what the field holds now', async () => {
    await openField();
    await page.keyboard.type('/abot/');
    await page.keyboard.press('Enter');
    const first = await nextCheck(0);
    // The author goes on typing before the answer arrives: a late "good" for the old text links nothing.
    await page.keyboard.type('x');
    await toFrame('linkChecked', { check: first.check });
    const asked = await checks();
    await page.keyboard.press('Enter');
    const second = await nextCheck(asked);
    expect(second.href).toBe('/abot/x');
    expect(second.check).toBeGreaterThan(first.check);
    expect(await field()).toMatchObject({ open: true, value: '/abot/x' });
    expect(await hrefs()).toEqual(['/about/']);
    // An answer to an earlier check never overrides the latest.
    await toFrame('linkChecked', { check: first.check, problem: 'old' });
    await toFrame('linkChecked', { check: second.check, problem: 'No page has the address /abot/x.' });
    await expect.poll(async () => (await field()).error).toBe('No page has the address /abot/x.');
  });

  it('tells the editor when the field is left before its answer about a destination arrives', async () => {
    await openField();
    await page.keyboard.type('/about/');
    await page.keyboard.press('Enter');
    const { check } = await nextCheck(0);
    // Focus leaves the field (a click elsewhere in the page) before the editor answers.
    await frame.evaluate(`document.querySelector('[data-so-node="s"]').setAttribute('tabindex', '-1'); document.querySelector('[data-so-node="s"]').focus()`);
    await expect.poll(async () => (await field()).open).toBe(false);
    await expect.poll(async () => (await messages()).some((m) => m.type === 'linkDropped' && m.payload.editId === `e${edits}`)).toBe(true);
    // The late answer links nothing.
    await toFrame('linkChecked', { check });
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textCancel' || m.type === 'textCommit')).toBe(true);
    expect(await hrefs()).toEqual(['/about/']);
  });

  it('says what is wrong with a destination it can tell is not one, without asking', async () => {
    await openField();
    await page.keyboard.type('about us');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await field()).errorShown).toBe(true);
    expect(await checks()).toBe(0);
    expect(await hrefs()).toEqual(['/about/']);
  });

  it('puts back the saved text on Escape from an edit opened again before the editor said it kept nothing', async () => {
    await page.evaluate(`window.seen = []`);
    await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(RICH)}`);
    await page.evaluate(`document.querySelector('iframe').focus()`);
    // The first edit replaces the words and is committed; the editor has not answered yet.
    await toFrame('beginTextEdit', { desc: { ctx: 'page:p', node: 'r', items: '' }, editId: 'refused-1' });
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textEditStarted')).toBe(true);
    await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = '<p>Words the editor will not keep</p>'`);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textCommit')).toBe(true);
    // Opened again at once, from the text that was not kept; then the editor says it kept nothing.
    await page.evaluate(`window.seen = []`);
    await toFrame('beginTextEdit', { desc: { ctx: 'page:p', node: 'r', items: '' }, editId: 'refused-2' });
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textEditStarted')).toBe(true);
    await toFrame('restoreText', { editId: 'refused-1' });
    // The edit open now is left alone until it ends; Escape then shows what was saved.
    await page.evaluate(`new Promise((r) => setTimeout(r, 100))`);
    expect(await frame.innerHTML('[data-so-node="r"]')).toBe('<p>Words the editor will not keep</p>');
    await page.keyboard.press('Escape');
    await expect.poll(() => frame.innerHTML('[data-so-node="r"]')).toBe(RICH);
  });
});

describe('what is wrong with a link destination', () => {
  const s = createStarterState('business', 'Test Studio', false);
  const pages = s.pages;
  const about = Object.values(pages).find((p) => p.title === 'About')!;

  it('names an address no page has, and accepts the site’s pages and sections on them', () => {
    expect(inlineLinkProblem('/abot/', pages)).toMatch(/No page has the address \/abot\//);
    expect(inlineLinkProblem(about.route, pages)).toBeNull();
    expect(inlineLinkProblem(`${about.route.replace(/\/$/, '')}#team`, pages)).toBeNull();
    expect(inlineLinkProblem('/about#1team', pages)).toMatch(/section name/);
    expect(inlineLinkProblem('https://example.com', pages)).toBeNull();
    expect(inlineLinkProblem('https://', pages)).toMatch(/web address/);
    expect(inlineLinkProblem('mailto:hello', pages)).toMatch(/email/);
    expect(inlineLinkProblem('tel:call me', pages)).toMatch(/phone/);
    expect(inlineLinkProblem('ftp://example.com', pages)).toMatch(/page address/);
  });

  it('tells a typed web address, email or phone number the project would refuse', () => {
    expect(linkFieldProblem('url', 'example.com', s)).toBe('A web address starts with https://, such as https://example.com.');
    expect(linkFieldProblem('url', 'not an address', s)).toMatch(/full web address/);
    expect(linkFieldProblem('url', 'https://example.com', s)).toBeNull();
    expect(linkFieldProblem('email', 'hello', s)).toMatch(/email address/);
    expect(linkFieldProblem('email', 'hello@example.com', s)).toBeNull();
    expect(linkFieldProblem('tel', 'call us', s)).toMatch(/phone number/);
    expect(linkFieldProblem('tel', '+1 555 0100', s)).toBeNull();
    // Nothing typed changes nothing, and other kinds of link are chosen, not typed.
    expect(linkFieldProblem('url', '  ', s)).toBeNull();
    expect(linkFieldProblem('page', 'nowhere', s)).toBeNull();
  });
});
