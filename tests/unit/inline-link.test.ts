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
const rels = () => frame.evaluate<Array<[string | null, string | null, string | null]>>(`[...document.querySelectorAll('[data-so-node="r"] a')].map((a) => [a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('target')])`);

/** Edit the rich text with the caret in the linked words, then open the link field. */
async function openField(rich = RICH, shown = '/about/') {
  edits++;
  await page.evaluate(`window.seen = []`);
  await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(rich)}`);
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
  expect((await field()).value).toBe(shown);
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

  it('keeps what a web address says about its site while the words go to another one, and not to a page (#582)', async () => {
    const shop = '<p>Read <a href="https://shop.example/" target="_blank" rel="noopener noreferrer nofollow sponsored">about us</a> today</p>';
    const pointAt = async (to: string) => {
      await openField(shop, 'https://shop.example/');
      await page.keyboard.type(to);
      await page.keyboard.press('Enter');
      const { check } = await nextCheck(0);
      await toFrame('linkChecked', { check });
      await expect.poll(async () => (await field()).open).toBe(false);
      return rels();
    };
    // The browser makes a new link for the words; the author's relationships and new tab go on it, never the site's
    // own tokens.
    expect(await pointAt('https://shop.example/b')).toEqual([['https://shop.example/b', 'nofollow sponsored', '_blank']]);
    await page.keyboard.press('Escape');
    expect(await pointAt('/about/')).toEqual([['/about/', null, '_blank']]);
    await page.keyboard.press('Escape');
    expect(await pointAt('hi@example.com')).toEqual([['mailto:hi@example.com', null, null]]);
  });

  it('gives words beside a link that join it in a new one nothing of what that link said (#582)', async () => {
    const shop = '<p>Read <a href="https://shop.example/" target="_blank" rel="noopener noreferrer sponsored">about us</a> today</p>';
    await openField(shop, 'https://shop.example/');
    await page.keyboard.press('Escape');
    // The end of the link and the plain word after it.
    await frame.evaluate(`(() => {
      const a = document.querySelector('[data-so-node="r"] a');
      const r = document.createRange();
      r.setStart(a.firstChild, 6);
      r.setEnd(a.nextSibling, 6);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);
    await page.keyboard.press(`${MOD}+k`);
    await expect.poll(async () => (await field()).open).toBe(true);
    await page.keyboard.type('https://other.example/');
    await page.keyboard.press('Enter');
    const { check } = await nextCheck(0);
    await toFrame('linkChecked', { check });
    await expect.poll(async () => (await field()).open).toBe(false);
    expect((await rels()).find(([href]) => href === 'https://other.example/')).toEqual(['https://other.example/', null, null]);
  });

  it('re-points only the link the caret is in when its neighbour goes to the same address but says something else (#582)', async () => {
    const pair = '<p><a href="https://shop.example/" rel="sponsored"><strong>Paid</strong></a><a href="https://shop.example/" rel="ugc"><em>review</em></a> today</p>';
    edits++;
    await page.evaluate(`window.seen = []`);
    await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(pair)}`);
    await page.evaluate(`document.querySelector('iframe').focus()`);
    await toFrame('beginTextEdit', { desc: { ctx: 'page:p', node: 'r', items: '' }, editId: `e${edits}` });
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textEditStarted')).toBe(true);
    await frame.evaluate(`(() => {
      const t = document.querySelectorAll('[data-so-node="r"] a')[1].querySelector('em').firstChild;
      const r = document.createRange();
      r.setStart(t, 2);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);
    await page.keyboard.press(`${MOD}+k`);
    await expect.poll(async () => (await field()).open).toBe(true);
    await page.keyboard.type('https://reviews.example/');
    await page.keyboard.press('Enter');
    const { check } = await nextCheck(0);
    await toFrame('linkChecked', { check });
    await expect.poll(async () => (await field()).open).toBe(false);
    expect(await rels()).toEqual([
      ['https://shop.example/', 'sponsored', null],
      ['https://reviews.example/', 'ugc', null]
    ]);
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
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textCancel' || m.type === 'textCommit')).toBe(true);
    // The editor hears of the link left out while the edit is still its own, before the edit ends.
    const types = (await messages()).map((m) => m.type);
    const dropped = types.indexOf('linkDropped');
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(dropped).toBeLessThan(types.findIndex((t) => t === 'textCancel' || t === 'textCommit'));
    // The late answer links nothing.
    await toFrame('linkChecked', { check });
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
    // Nothing typed yet: the saved text comes back to edit from, and leaving it commits nothing.
    await expect.poll(() => frame.innerHTML('[data-so-node="r"]')).toBe(RICH);
    expect(await frame.getAttribute('[data-so-node="r"]', 'contenteditable')).toBe('true');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await messages()).some((m) => m.type === 'textCancel' && m.payload.editId === 'refused-2')).toBe(true);
    expect((await messages()).some((m) => m.type === 'textCommit')).toBe(false);
    expect(await frame.innerHTML('[data-so-node="r"]')).toBe(RICH);
  });

  it('puts back the saved text when an edit is refused after the element was edited again from it', async () => {
    await page.evaluate(`window.seen = []`);
    await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(RICH)}`);
    await page.evaluate(`document.querySelector('iframe').focus()`);
    const edit = async (editId: string, html: string) => {
      await toFrame('beginTextEdit', { desc: { ctx: 'page:p', node: 'r', items: '' }, editId });
      await expect.poll(async () => (await messages()).filter((m) => m.type === 'textEditStarted').length).toBeGreaterThan(0);
      await frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(html)}`);
      await page.keyboard.press(`${MOD}+Enter`);
      await expect.poll(async () => (await messages()).some((m) => m.type === 'textCommit' && m.payload.editId === editId)).toBe(true);
      await page.evaluate(`window.seen = []`);
    };
    // Two edits committed one after the other, before the editor answers either: it keeps neither.
    await edit('both-1', '<p>First words not kept</p>');
    await edit('both-2', '<p>Second words not kept</p>');
    await toFrame('restoreText', { editId: 'both-1' });
    await toFrame('restoreText', { editId: 'both-2' });
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
    // A number without three digits to dial says so.
    expect(inlineLinkProblem('tel:(1)-2', pages)).toMatch(/at least 3 digits/);
    expect(inlineLinkProblem('tel:(1)-23', pages)).toBeNull();
    expect(inlineLinkProblem('ftp://example.com', pages)).toMatch(/page address/);
  });

  it('tells a typed web address, email or phone number the project would refuse', () => {
    expect(linkFieldProblem('url', 'example.com', s)).toBe('A web address starts with https://, such as https://example.com.');
    expect(linkFieldProblem('url', 'not an address', s)).toMatch(/full web address/);
    expect(linkFieldProblem('url', 'https://example.com', s)).toBeNull();
    expect(linkFieldProblem('email', 'hello', s)).toMatch(/email address/);
    expect(linkFieldProblem('email', 'hello@example.com', s)).toBeNull();
    expect(linkFieldProblem('tel', 'call us', s)).toMatch(/phone number/);
    expect(linkFieldProblem('tel', '(1)-2', s)).toMatch(/at least 3 digits/);
    expect(linkFieldProblem('tel', '+1 555 0100', s)).toBeNull();
    // Nothing typed changes nothing, and other kinds of link are chosen, not typed.
    expect(linkFieldProblem('url', '  ', s)).toBeNull();
    expect(linkFieldProblem('page', 'nowhere', s)).toBeNull();
  });
});
