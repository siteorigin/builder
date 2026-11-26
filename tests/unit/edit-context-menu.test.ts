/**
 * A right-click while editing site copy on the canvas runs the real preview bridge in a real browser frame on
 * another origin, as the editor's preview is: the click on the text being edited is left to the page (so the
 * app's writing menu opens for the word under the pointer), while a click anywhere else still asks the editor for
 * its element actions.
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
const HEADING = 'Gret recieve confirmation';
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:20px/1.4 monospace}h1,p,div{margin:0;padding:10px}</style></head><body>
<main data-so-node="s" data-so-ctx="page:p">
  <h1 data-so-node="h" data-so-ctx="page:p">${HEADING}</h1>
  <div class="so-rich" data-so-node="r" data-so-ctx="page:p"><p>One <strong>recieve</strong> two</p></div>
  <p data-so-node="o" data-so-ctx="page:p">Other copy</p>
</main><script type="module" src="/bridge.js"></script></body></html>`;

interface Seen {
  /** Messages the bridge sent the editor, by type. */
  messages: { type: string; payload: { chain?: { node: string }[] } }[];
  /** Whether each contextmenu event reaching the frame's window had been cancelled. */
  prevented: boolean[];
}
interface Selected {
  text: string;
  collapsed: boolean;
  /** The text of the node the selection starts in, and the offset in it. */
  node: string | null;
  offset: number;
}

let browser: Browser;
let page: Page;
let frame: Frame;

const SELECTION = `(() => {
  const s = getSelection();
  return { text: s.toString(), collapsed: s.isCollapsed, node: s.anchorNode && s.anchorNode.textContent, offset: s.anchorOffset };
})()`;
const seen = async (): Promise<Seen> => ({ messages: await page.evaluate<Seen['messages']>(`window.seen`), prevented: await frame.evaluate<boolean[]>(`window.prevented`) });
const reset = async () => {
  await page.evaluate(`window.seen = []`);
  await frame.evaluate(`window.prevented = []; window.atPress = null`);
};
/** Everything the bridge has sent so far, once it has all arrived: messages from one frame arrive in order. */
async function flushed(): Promise<Seen> {
  await frame.evaluate(`parent.postMessage({ sessionId: 'so-test', type: 'flushed' }, '*')`);
  await expect.poll(async () => (await page.evaluate<Seen['messages']>(`window.seen`)).some((m) => m.type === 'flushed')).toBe(true);
  return seen();
}
const selection = () => frame.evaluate<Selected>(SELECTION);
/** The selection as the press that opens the menu left it, before the browser's own handling of the click. */
const atPress = () => frame.evaluate<Selected>(`window.atPress`);
/** Start an inline edit of the element with this node id, as the editor does after a double-click. */
async function beginEdit(node: string) {
  await reset();
  await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'beginTextEdit', payload: { desc: { ctx: 'page:p', node: ${JSON.stringify(node)}, items: '' }, editId: 'e-${node}' } }, '*')`);
  await expect.poll(async () => (await page.evaluate<Seen['messages']>(`window.seen`)).some((m) => m.type === 'textEditStarted')).toBe(true);
}
/** Keys reach the frame as they do once the author has double-clicked into it (focused before the edit begins,
 *  as there: focusing it later would move the selection the edit made). */
const focusFrame = () => page.evaluate(`document.querySelector('iframe').focus()`);
/** The middle of the third letter of `word` inside the element with this node id. */
async function wordPoint(node: string, word: string) {
  return frame.evaluate<{ x: number; y: number }>(`(() => {
    const el = document.querySelector('[data-so-node="${node}"]');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(${JSON.stringify(word)});
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + 2);
      r.setEnd(n, i + 3);
      const box = r.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    throw new Error('word not found');
  })()`);
}
/** Right-click the middle of the third letter of `word` inside the element with this node id, with real mouse input. */
async function rightClickWord(node: string, word: string) {
  const at = await wordPoint(node, word);
  await page.mouse.click(at.x, at.y, { button: 'right' });
}
/** The selection is on `word`, in the text node that holds it: the word itself, or a caret inside it. */
function expectInWord(s: Selected | null, node: string, word: string) {
  expect(s).not.toBeNull();
  expect(s!.node).toBe(node);
  if (!s!.collapsed) return expect(s!.text).toBe(word);
  const start = node.indexOf(word);
  expect(s!.offset).toBeGreaterThan(start);
  expect(s!.offset).toBeLessThan(start + word.length);
}

describe.skipIf(!browserInstalled)('right-clicking site copy while it is being edited', () => {
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
    await inputReachesFrame(page, frame);
    // Recorded after the bridge's own listeners have run: the window is the last stop of both events.
    await frame.evaluate(`window.prevented = [];
      window.addEventListener('contextmenu', (e) => window.prevented.push(e.defaultPrevented));
      window.addEventListener('pointerdown', () => (window.atPress = ${SELECTION}));`);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('leaves a right-click on the edited text to the page, at the word under the pointer, and keeps the edit', async () => {
    await beginEdit('h');
    // The edit starts with a caret, not the whole heading: whole text is for Select All.
    expect((await selection()).collapsed).toBe(true);
    await rightClickWord('h', 'recieve');
    const s = await flushed();
    expect(s.prevented).toEqual([false]);
    expect(s.messages.map((m) => m.type)).not.toContain('contextmenu');
    expect(s.messages.map((m) => m.type)).not.toContain('select');
    // The browser puts the selection on the word under the pointer, where its spelling marker is.
    expectInWord(await selection(), HEADING, 'recieve');
    expect(await frame.getAttribute('[data-so-node="h"]', 'contenteditable')).toBe('plaintext-only');
  });

  it('targets a word inside formatted rich text without leaving the edit', async () => {
    await beginEdit('r');
    await rightClickWord('r', 'recieve');
    const s = await flushed();
    expect(s.prevented).toEqual([false]);
    expect(s.messages.map((m) => m.type)).not.toContain('contextmenu');
    expect(s.messages.map((m) => m.type)).not.toContain('select');
    expectInWord(await selection(), 'recieve', 'recieve');
    expect(await frame.innerHTML('[data-so-node="r"]')).toBe('<p>One <strong>recieve</strong> two</p>');
    expect(await frame.getAttribute('[data-so-node="r"]', 'contenteditable')).toBe('true');
  });

  it('keeps the word a double-click selected for its spelling suggestions', async () => {
    await focusFrame();
    await reset();
    const at = await wordPoint('h', 'recieve');
    await page.mouse.dblclick(at.x, at.y);
    await expect.poll(async () => (await page.evaluate<Seen['messages']>(`window.seen`)).some((m) => m.type === 'dblclick')).toBe(true);
    const dbl = (await page.evaluate<Array<Seen['messages'][number] & { payload: { hit?: string } }>>(`window.seen`)).find((m) => m.type === 'dblclick')!;
    await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'beginTextEdit', payload: { desc: { ctx: 'page:p', node: 'h', items: '' }, editId: 'e-dbl', hit: ${JSON.stringify(dbl.payload.hit)} } }, '*')`);
    await expect.poll(() => frame.getAttribute('[data-so-node="h"]', 'contenteditable')).toBe('plaintext-only');
    expect((await selection()).text).toBe('recieve');
    await rightClickWord('h', 'recieve');
    expect((await atPress())?.text).toBe('recieve');
    expect((await flushed()).prevented).toEqual([false]);
    expect((await selection()).text).toBe('recieve');
  });

  it('keeps a selection the author made with the mouse for Cut and Copy', async () => {
    await beginEdit('h');
    // A press in the text: from here on the selection is the author's.
    await frame.click('[data-so-node="h"]', { position: { x: 15, y: 15 } });
    await frame.evaluate(`(() => {
      const t = document.querySelector('[data-so-node="h"]').firstChild;
      const r = document.createRange();
      r.setStart(t, 0);
      r.setEnd(t, 12);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);
    await rightClickWord('h', 'recieve');
    expect((await atPress())?.text).toBe('Gret recieve');
    expect((await flushed()).prevented).toEqual([false]);
    expect((await selection()).text).toBe('Gret recieve');
  });

  it('keeps a selection the author made with the keyboard', async () => {
    await focusFrame();
    await beginEdit('h');
    await page.keyboard.press('Home');
    for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowRight');
    expect((await selection()).text).toBe('Gret recieve');
    await rightClickWord('h', 'recieve');
    expect((await atPress())?.text).toBe('Gret recieve');
    expect((await selection()).text).toBe('Gret recieve');
  });

  it('keeps everything selected after Edit → Select All', async () => {
    await beginEdit('h');
    // The menu's Select All reaches the text with no key or press.
    await frame.evaluate(`document.execCommand('selectAll')`);
    await rightClickWord('h', 'recieve');
    expect((await atPress())?.text).toBe(HEADING);
    expect((await selection()).text).toBe(HEADING);
  });

  it('still asks the editor for its element actions on a right-click outside the edited text', async () => {
    await beginEdit('h');
    await rightClickWord('o', 'copy');
    const s = await flushed();
    expect(s.prevented).toEqual([true]);
    const menus = s.messages.filter((m) => m.type === 'contextmenu');
    expect(menus).toHaveLength(1);
    expect(menus[0].payload.chain?.[0].node).toBe('o');
  });
});
