/**
 * A right-click while editing site copy on the canvas runs the real preview bridge in a real browser frame: the
 * click on the text being edited is left to the page (so the app's writing menu opens for the word under the
 * pointer), while a click anywhere else still asks the editor for its element actions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const FRAME = `<!doctype html><html><head><style>body{margin:0;font:20px/1.4 monospace}h1,p,div{margin:0;padding:10px}</style></head><body>
<main data-so-node="s" data-so-ctx="page:p">
  <h1 data-so-node="h" data-so-ctx="page:p">Gret recieve confirmation</h1>
  <div class="so-rich" data-so-node="r" data-so-ctx="page:p"><p>One <strong>recieve</strong> two</p></div>
  <p data-so-node="o" data-so-ctx="page:p">Other copy</p>
</main><script type="module" src="/bridge.js"></script></body></html>`;

interface Seen {
  /** Messages the bridge sent the editor, by type. */
  messages: { type: string; payload: { chain?: { node: string }[] } }[];
  /** Whether each contextmenu event reaching the window had been cancelled. */
  prevented: boolean[];
}

let browser: Browser;
let page: Page;
let frame: Frame;

const seen = () => page.evaluate<Seen>(`({ messages: window.seen, prevented: window.frames[0].prevented })`);
const reset = () => page.evaluate(`(window.seen = [], window.frames[0].prevented = [])`);
/** Everything the bridge has sent so far, once it has all arrived: messages from one frame arrive in order. */
async function flushed(): Promise<Seen> {
  await frame.evaluate(`parent.postMessage({ sessionId: 'so-test', type: 'flushed' }, '*')`);
  await expect.poll(async () => (await seen()).messages.some((m) => m.type === 'flushed')).toBe(true);
  return seen();
}
const selection = () => frame.evaluate<{ text: string; collapsed: boolean; in: string | null }>(`(() => {
  const s = getSelection();
  const at = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
  return { text: s.toString(), collapsed: s.isCollapsed, in: at && at.textContent };
})()`);
/** Start an inline edit of the element with this node id, as the editor does after a double-click. */
async function beginEdit(node: string) {
  await reset();
  await page.evaluate(`window.frames[0].postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'beginTextEdit', payload: { desc: { ctx: 'page:p', node: ${JSON.stringify(node)}, items: '' }, editId: 'e-${node}' } }, '*')`);
  await expect.poll(async () => (await seen()).messages.some((m) => m.type === 'textEditStarted')).toBe(true);
}
/** Right-click the middle of `word` inside the element with this node id, with real mouse input. */
async function rightClickWord(node: string, word: string) {
  const at = await frame.evaluate<{ x: number; y: number }>(`(() => {
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
  await page.mouse.click(at.x, at.y, { button: 'right' });
}

describe.skipIf(!browserInstalled)('right-clicking site copy while it is being edited', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    const origin = 'http://bridge.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="/frame" style="border:0;width:700px;height:400px"></iframe></body>' });
    });
    await page.addInitScript(`window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); });`);
    await page.goto(`${origin}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    // Recorded after the bridge's own capture listener has run.
    await frame.evaluate(`window.prevented = []; window.addEventListener('contextmenu', (e) => window.prevented.push(e.defaultPrevented))`);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('leaves a right-click on the edited text to the page, at the word under the pointer, and keeps the edit', async () => {
    await beginEdit('h');
    // The edit starts with the whole heading selected, ready to be typed over.
    expect((await selection()).text).toBe('Gret recieve confirmation');
    await rightClickWord('h', 'recieve');
    const s = await flushed();
    expect(s.prevented).toEqual([false]);
    expect(s.messages.map((m) => m.type)).not.toContain('contextmenu');
    expect(s.messages.map((m) => m.type)).not.toContain('select');
    // The browser picks the word under the pointer (or puts the caret in it), where its spelling markers are.
    const sel = await selection();
    expect(sel.text === 'recieve' || (sel.collapsed && sel.in === 'Gret recieve confirmation')).toBe(true);
    expect(sel.text).not.toBe('Gret recieve confirmation');
    expect(await frame.getAttribute('[data-so-node="h"]', 'contenteditable')).toBe('plaintext-only');
  });

  it('keeps a selection the author made for Cut and Copy', async () => {
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
    expect((await seen()).prevented).toEqual([false]);
    expect((await selection()).text).toBe('Gret recieve');
  });

  it('targets a word inside formatted rich text without leaving the edit', async () => {
    await beginEdit('r');
    await rightClickWord('r', 'recieve');
    const s = await flushed();
    expect(s.prevented).toEqual([false]);
    expect(s.messages.map((m) => m.type)).not.toContain('contextmenu');
    const sel = await selection();
    expect(sel.text === 'recieve' || (sel.collapsed && sel.in === 'recieve')).toBe(true);
    expect(await frame.innerHTML('[data-so-node="r"]')).toBe('<p>One <strong>recieve</strong> two</p>');
    expect(await frame.getAttribute('[data-so-node="r"]', 'contenteditable')).toBe('true');
  });

  it('still asks the editor for its element actions on a right-click outside the edited text', async () => {
    await beginEdit('h');
    await rightClickWord('o', 'copy');
    const menusSent = async () => (await seen()).messages.filter((m) => m.type === 'contextmenu');
    await expect.poll(async () => (await menusSent()).length).toBe(1);
    expect((await seen()).prevented).toEqual([true]);
    const menus = await menusSent();
    expect(menus[0].payload.chain?.[0].node).toBe('o');
  });
});
