/**
 * What the real preview bridge tells the editor about where the keyboard is (#1361), in a real browser frame on another
 * origin as the editor's preview is. A pick made by a press of the mouse is `pointer`, and the editor then takes the
 * keyboard back from the page for the selection; Enter on a link reached with Tab, or a click the page's own code makes,
 * is not. Enter or Escape ending an edit of the page's text says so too. Delete and Backspace stay the page's.
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
<div class="so-rich" data-so-node="copy" data-so-ctx="page:p"><p>Some words</p></div>
<script type="module" src="/bridge.js"></script></body></html>`;

type Sent = { type: string; payload: { chain?: { node: string }[]; pointer?: unknown; key?: string; editId?: string } };

let browser: Browser;
let page: Page;
let frame: Frame;

const focused = () => frame.evaluate<string>(`document.activeElement.getAttribute('data-so-node') || document.activeElement.tagName`);
/** Everything the bridge has sent since the last reset, once it has all arrived: messages from one frame arrive in order. */
async function flushed(): Promise<Sent[]> {
  await frame.evaluate(`parent.postMessage({ sessionId: 'so-test', type: 'flushed' }, '*')`);
  await expect.poll(async () => (await page.evaluate<Sent[]>(`window.seen`)).some((m) => m.type === 'flushed')).toBe(true);
  return (await page.evaluate<Sent[]>(`window.seen`)).filter((m) => m.type !== 'flushed');
}
const reset = () => page.evaluate(`window.seen = []`);
/** From the editor's last control into the page, as the author did: the header's link is the page's first stop. */
async function tabToAbout() {
  await page.focus('#layers');
  await page.keyboard.press('Tab');
  await expect.poll(focused).toBe('about');
  await reset();
}
const post = (type: string, payload: unknown) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
/** Start an edit of an element's text, as the editor does after a double-click, with keys reaching the frame. */
async function editText(editId: string, node = 'title') {
  await page.evaluate(`document.querySelector('iframe').focus()`);
  await reset();
  await post('beginTextEdit', { desc: { ctx: 'page:p', node, items: '' }, editId });
  await expect.poll(async () => (await page.evaluate<Sent[]>(`window.seen`)).some((m) => m.type === 'textEditStarted')).toBe(true);
  await expect.poll(() => frame.getAttribute(`[data-so-node="${node}"]`, 'contenteditable')).not.toBeNull();
  await reset();
}
/** How the edits that ended since the last reset ended, and whether the keyboard was said to be left on them. */
const ends = async () => (await flushed()).filter((m) => ['textCancel', 'textCommit', 'editLeftByKey'].includes(m.type)).map((m) => [m.type, m.payload.editId]);

describe.skipIf(!browserInstalled)('where the keyboard is, as the bridge reports it', () => {
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
    // Recorded after the bridge's own listeners have run: the window is the last stop of the event.
    await frame.evaluate(`window.prevented = []; window.addEventListener('keydown', (e) => window.prevented.push([e.key, e.defaultPrevented]));`);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('reports a pick made from the keyboard as no pointer, with the link reached by Tab keeping the keyboard', async () => {
    await tabToAbout();
    await page.keyboard.press('Enter');
    const picks = (await flushed()).filter((m) => m.type === 'select');
    expect(picks.map((m) => [m.payload.chain?.[0]?.node, m.payload.pointer])).toEqual([['about', false]]);
    expect(await focused()).toBe('about');
    expect(await page.evaluate(`document.activeElement.tagName`)).toBe('IFRAME');
  });

  it('reports a press of the mouse as a pointer pick, whatever on the page has the keyboard', async () => {
    await tabToAbout();
    // Below the heading, on the section's own space: in page coordinates, as boxes inside the frame are given.
    const hero = (await frame.locator('[data-so-node="hero"]').boundingBox())!;
    await page.mouse.click(hero.x + 20, hero.y + hero.height - 20);
    const picks = (await flushed()).filter((m) => m.type === 'select');
    expect(picks.map((m) => [m.payload.chain?.[0]?.node, m.payload.pointer])).toEqual([['hero', true]]);
    // The page itself moves no focus for a press while editing: the editor is the one to take the keyboard back.
    expect(await focused()).toBe('about');
  });

  it('never counts a click the page’s own code makes as a pointer pick, whatever click count it claims', async () => {
    await reset();
    await frame.evaluate(`(() => {
      const title = document.querySelector('[data-so-node="title"]');
      title.click();
      title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      title.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, detail: 1, pointerType: 'mouse' }));
    })()`);
    const picks = (await flushed()).filter((m) => m.type === 'select');
    expect(picks.map((m) => [m.payload.chain?.[0]?.node, m.payload.pointer])).toEqual([
      ['title', false],
      ['title', false],
      ['title', false]
    ]);
  });

  it('leaves Delete and Backspace to the page, and still hands the editor Escape', async () => {
    await tabToAbout();
    await frame.evaluate(`window.prevented = []`);
    for (const key of ['Delete', 'Backspace', 'Escape']) await page.keyboard.press(key);
    const keys = (await flushed()).filter((m) => m.type === 'key').map((m) => m.payload.key);
    expect(keys).toEqual(['Escape']);
    expect(await frame.evaluate(`window.prevented`)).toEqual([
      ['Delete', false],
      ['Backspace', false],
      ['Escape', true]
    ]);
    expect(await focused()).toBe('about');
  });

  it('says when Enter or Escape ended an edit of the page’s text, after the edit’s own end', async () => {
    for (const key of ['Escape', 'Enter']) {
      await editText(`e-${key}`);
      await page.keyboard.press(key);
      expect(await ends()).toEqual([
        ['textCancel', `e-${key}`],
        ['editLeftByKey', `e-${key}`]
      ]);
      expect(await frame.getAttribute('[data-so-node="title"]', 'contenteditable')).toBeNull();
    }
    // Text that was typed over is committed, and said the same way.
    await editText('e-typed');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Enter');
    expect(await ends()).toEqual([
      ['textCommit', 'e-typed'],
      ['editLeftByKey', 'e-typed']
    ]);
  });

  it('says so for Cmd or Ctrl+Enter in the formatting toolbar too', async () => {
    await editText('e-toolbar', 'copy');
    await page.keyboard.press('Tab');
    await expect.poll(() => frame.evaluate(`(() => { const a = document.activeElement; return !!(a && a.shadowRoot && a.shadowRoot.activeElement); })()`)).toBe(true);
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await ends()).toEqual([
      ['textCancel', 'e-toolbar'],
      ['editLeftByKey', 'e-toolbar']
    ]);
  });

  it('says nothing of the keyboard when an edit ends any other way', async () => {
    // A key that goes on typing, then a click elsewhere on the page that ends the edit.
    await editText('e-click');
    await page.keyboard.press('ArrowLeft');
    const hero = (await frame.locator('[data-so-node="hero"]').boundingBox())!;
    await page.mouse.click(hero.x + 20, hero.y + hero.height - 20);
    expect(await ends()).toEqual([['textCancel', 'e-click']]);
    // The editor asks for the text back (saving, leaving the page).
    await editText('e-asked');
    await post('commitTextEdit', {});
    expect(await ends()).toEqual([['textCancel', 'e-asked']]);
    // Another edit begins (a double-click elsewhere) while one is open: the open one ends, and the new one has the keyboard.
    await editText('e-first');
    await post('beginTextEdit', { desc: { ctx: 'page:p', node: 'copy', items: '' }, editId: 'e-second' });
    await expect.poll(() => frame.getAttribute('[data-so-node="copy"]', 'contenteditable')).not.toBeNull();
    expect(await ends()).toEqual([['textCancel', 'e-first']]);
    await post('commitTextEdit', {});
    await expect.poll(() => frame.getAttribute('[data-so-node="copy"]', 'contenteditable')).toBeNull();
  });
});
