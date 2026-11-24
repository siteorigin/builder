/**
 * Moving the pointer over the page and the page changing under it stay cheap: the real preview bridge, in a real
 * browser frame on another origin as the editor's preview is, reports what is under the pointer without reading any
 * element's text or measuring the page, walks up from the pointer only when it reaches another element, and
 * measures nothing for outlines when nothing is outlined.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
// A section holding a component (its title, two repeated items and a code block, which the generator wraps in a
// `display: contents` element), a strip of the section with nothing of its own, and a footer the editor knows nothing of.
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:20px/1.4 monospace}h1,p,div{margin:0;padding:10px}</style></head><body>
<main data-so-ctx="page:p" data-so-node="sec">
  <div data-so-ctx="page:p|card" data-so-node="box">
    <h1 data-so-ctx="page:p|card" data-so-node="title"><span id="words">Heading words</span> and more</h1>
    <p id="a" data-so-ctx="page:p|card" data-so-node="item" data-so-items="a">First item</p>
    <p id="b" data-so-ctx="page:p|card" data-so-node="item" data-so-items="b">Second item</p>
    <div style="display: contents" data-so-ctx="page:p|card" data-so-node="code" data-so-code="true"><p id="custom">Code copy</p></div>
  </div>
  <p id="plain">Nothing of its own <span id="tick">0</span></p>
</main>
<footer id="outside" style="height:40px">Outside</footer>
<script type="module" src="/bridge.js"></script></body></html>`;

interface Desc {
  ctx: string;
  node: string;
  items: string;
}
interface Message {
  type: string;
  payload: { chain?: Record<string, unknown>[]; selected?: unknown[]; hovered?: unknown[]; editId?: string; id?: number };
}

const SEC = { ctx: 'page:p', node: 'sec', items: '', tag: 'main', code: false };
const BOX = { ctx: 'page:p|card', node: 'box', items: '', tag: 'div', code: false };
const TITLE = { ctx: 'page:p|card', node: 'title', items: '', tag: 'h1', code: false };
const item = (id: string) => ({ ctx: 'page:p|card', node: 'item', items: id, tag: 'p', code: false });
const CODE = { ctx: 'page:p|card', node: 'code', items: '', tag: 'div', code: true };
const desc = (d: Desc): Desc => ({ ctx: d.ctx, node: d.node, items: d.items });

let browser: Browser;
let page: Page;
let frame: Frame;
/** Page coordinates of points inside elements of the frame, by element id or node. */
let at: Record<string, { x: number; y: number }>;

/**
 * Counts, in the frame, every read that makes the browser lay the page out (`innerText`, measuring boxes and
 * computed styles), and every look at the elements above the title (its component, the section and the body).
 */
const INSTRUMENT = `(() => {
  window.counts = { layout: 0, above: 0 };
  window.counting = false;
  const above = new Set([document.querySelector('[data-so-node="box"]'), document.querySelector('main'), document.body, document.documentElement]);
  const wrap = (proto, name, kind) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d.get) Object.defineProperty(proto, name, { ...d, get() { if (window.counting && (kind === 'layout' || above.has(this))) window.counts[kind]++; return d.get.call(this); } });
    else proto[name] = function (...args) { if (window.counting && (kind === 'layout' || above.has(this))) window.counts[kind]++; return d.value.apply(this, args); };
  };
  wrap(HTMLElement.prototype, 'innerText', 'layout');
  wrap(HTMLElement.prototype, 'offsetWidth', 'layout');
  wrap(HTMLElement.prototype, 'offsetHeight', 'layout');
  wrap(Element.prototype, 'getBoundingClientRect', 'layout');
  wrap(Element.prototype, 'getClientRects', 'layout');
  const style = window.getComputedStyle;
  window.getComputedStyle = function (...args) { if (window.counting) window.counts.layout++; return style.apply(this, args); };
  for (const name of ['hasAttribute', 'getAttribute', 'closest', 'matches']) wrap(Element.prototype, name, 'above');
  for (const name of ['parentElement', 'parentNode', 'tagName']) wrap(name === 'tagName' ? Element.prototype : Node.prototype, name, 'above');
})()`;

/** Messages the bridge sent the editor since the last reset. */
const seen = () => page.evaluate<Message[]>(`window.seen`);
const reset = async () => {
  await page.evaluate(`window.seen = []`);
  await frame.evaluate(`window.counts = { layout: 0, above: 0 }`);
};
const counting = (on: boolean) => frame.evaluate(`window.counting = ${on}`);
const counts = () => frame.evaluate<{ layout: number; above: number }>(`window.counts`);
let flushes = 0;
/**
 * Everything the bridge has sent so far, once two frames have passed (an outline report waits for the next one) and
 * it has all arrived: messages from one frame arrive in order, so this one comes after them.
 */
async function flushed(): Promise<Message[]> {
  const id = ++flushes;
  await frame.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))`);
  await frame.evaluate(`parent.postMessage({ sessionId: 'so-test', type: 'flushed', payload: { id: ${id} } }, '*')`);
  await expect.poll(async () => (await seen()).some((m) => m.type === 'flushed' && m.payload.id === id)).toBe(true);
  return (await seen()).filter((m) => m.type !== 'flushed');
}
/** A command from the editor, as it posts them to the frame. */
const post = (type: string, payload: unknown) =>
  page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const hovers = (messages: Message[]) => messages.filter((m) => m.type === 'hover').map((m) => m.payload.chain);
const rects = (messages: Message[]) => messages.filter((m) => m.type === 'rects');
/**
 * The page changes as an update re-rendering part of it does: text changes and an element is replaced. Nothing
 * changes size, so the page being resized cannot be what reports outlines.
 */
const mutate = () =>
  frame.evaluate(`(() => {
    const text = document.getElementById('plain').firstChild;
    text.data = text.data === 'Nothing of its own ' ? 'Nothing of its OWN ' : 'Nothing of its own ';
    const tick = document.getElementById('tick');
    tick.replaceWith(Object.assign(document.createElement('span'), { id: 'tick', textContent: tick.textContent === '0' ? '1' : '0' }));
  })()`);
/**
 * Takes the pointer out of the frame, so nothing is under it and the editor has nothing hovered. The page is told
 * as a real pointer tells it: a headless browser leaves an iframe without saying so.
 */
async function leaveFrame() {
  await page.mouse.move(650, 590);
  await frame.evaluate(`document.documentElement.dispatchEvent(new MouseEvent('mouseleave'))`);
}

describe.skipIf(!browserInstalled)('pointer movement and page changes in the preview', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 700, height: 600 } });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:600px;height:500px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    // The frame sits at the page's top left, so a point in the frame is the same point on the page.
    at = await frame.evaluate<Record<string, { x: number; y: number }>>(`(() => {
      const out = {};
      const point = (el, fx = 0.5) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height / 2 }; };
      for (const id of ['words', 'a', 'b', 'custom', 'plain', 'outside']) out[id] = point(document.getElementById(id));
      const h1 = document.querySelector('h1');
      // The title's own text after the span, and its padding.
      out.titleText = point(h1, 0.9);
      out.titlePad = { x: h1.getBoundingClientRect().left + 3, y: h1.getBoundingClientRect().top + 3 };
      return out;
    })()`);
    await frame.evaluate(INSTRUMENT);
    await leaveFrame();
    await flushed();
    await reset();
  }, 30000);
  afterEach(async () => {
    await page?.close();
  });

  it('reports what is under the pointer, innermost first, without reading text or laying out the page', async () => {
    await counting(true);
    for (const p of ['words', 'a', 'b', 'custom', 'plain', 'outside']) await page.mouse.move(at[p].x, at[p].y);
    const messages = await flushed();
    expect(hovers(messages)).toEqual([[TITLE, BOX, SEC], [item('a'), BOX, SEC], [item('b'), BOX, SEC], [CODE, BOX, SEC], [SEC], []]);
    expect((await counts()).layout).toBe(0);
  });

  it('gives a click, double-click and right-click the same chain, without reading text or laying out the page', async () => {
    await counting(true);
    await page.mouse.click(at.b.x, at.b.y);
    await page.mouse.click(at.custom.x, at.custom.y, { button: 'right' });
    await page.mouse.dblclick(at.words.x, at.words.y);
    const messages = await flushed();
    expect(messages.filter((m) => m.type === 'select').map((m) => m.payload.chain)).toEqual([
      [item('b'), BOX, SEC],
      [TITLE, BOX, SEC],
      [TITLE, BOX, SEC]
    ]);
    expect(messages.filter((m) => m.type === 'contextmenu').map((m) => m.payload.chain)).toEqual([[CODE, BOX, SEC]]);
    expect(messages.filter((m) => m.type === 'dblclick').map((m) => m.payload.chain)).toEqual([[TITLE, BOX, SEC]]);
    expect((await counts()).layout).toBe(0);
  });

  it('looks no further up than the element under the pointer while the pointer stays inside it', async () => {
    await page.mouse.move(at.words.x, at.words.y);
    expect(hovers(await flushed())).toEqual([[TITLE, BOX, SEC]]);
    await reset();
    await counting(true);
    // Across the title's own words, its padding and back: the pointer is over the span or the title itself.
    for (const p of ['titleText', 'titlePad', 'words', 'titleText']) await page.mouse.move(at[p].x, at[p].y, { steps: 3 });
    const messages = await flushed();
    expect(hovers(messages)).toEqual([]);
    expect(await counts()).toEqual({ layout: 0, above: 0 });
    // Into the next element: what is under the pointer is reported again, once.
    await page.mouse.move(at.a.x, at.a.y);
    expect(hovers(await flushed())).toEqual([[item('a'), BOX, SEC]]);
  });

  it('reports the pointer again after it leaves the page and comes back to the same element', async () => {
    await page.mouse.move(at.a.x, at.a.y);
    await leaveFrame();
    await page.mouse.move(at.a.x, at.a.y);
    expect(hovers(await flushed())).toEqual([[item('a'), BOX, SEC], [], [item('a'), BOX, SEC]]);
  });

  it('reports a repeated element under the pointer again once its item changes', async () => {
    await page.mouse.move(at.a.x, at.a.y);
    // The same element now shows another item, as a keyed list reusing it would.
    await frame.evaluate(`document.getElementById('a').setAttribute('data-so-items', 'c')`);
    await page.mouse.move(at.a.x + 2, at.a.y);
    expect(hovers(await flushed())).toEqual([[item('a'), BOX, SEC], [item('c'), BOX, SEC]]);
  });

  it('measures and reports no outlines when the page changes with nothing outlined', async () => {
    await counting(true);
    await mutate();
    expect(rects(await flushed())).toEqual([]);
    expect((await counts()).layout).toBe(0);
    // A hover sent while previewing is not shown, so it is not measured either.
    await post('mode', { mode: 'preview' });
    await post('track', { selected: null, hovered: desc(item('a')) });
    await flushed();
    await reset();
    await mutate();
    expect(rects(await flushed())).toEqual([]);
    expect((await counts()).layout).toBe(0);
  });

  it('still measures what is selected or hovered while editing when the page changes, and stops once it is not', async () => {
    await post('track', { selected: desc(item('a')), hovered: null });
    await flushed();
    await reset();
    await mutate();
    let r = rects(await flushed());
    expect(r).toHaveLength(1);
    expect(r[0].payload.selected).toHaveLength(1);
    expect(r[0].payload.hovered).toEqual([]);

    await post('track', { selected: null, hovered: desc(item('b')) });
    await flushed();
    await reset();
    await mutate();
    r = rects(await flushed());
    expect(r).toHaveLength(1);
    expect(r[0].payload.selected).toEqual([]);
    expect(r[0].payload.hovered).toHaveLength(1);

    // A selection still measured in Preview, as before: the editor outlines it again on the way back to editing.
    await post('mode', { mode: 'preview' });
    await post('track', { selected: desc(item('a')) });
    await flushed();
    await reset();
    await mutate();
    expect(rects(await flushed())).toHaveLength(1);

    // Nothing outlined any more: the editor is told once, and then the page's changes are not measured.
    await post('mode', { mode: 'edit' });
    await post('track', { selected: null, hovered: null });
    r = rects(await flushed());
    expect(r.at(-1)?.payload.selected).toEqual([]);
    expect(r.at(-1)?.payload.hovered).toEqual([]);
    await reset();
    await mutate();
    expect(rects(await flushed())).toEqual([]);
  });

  it('still ends an inline edit whose element an update removed, with nothing outlined', async () => {
    await post('beginTextEdit', { desc: desc(TITLE), editId: 'e1' });
    await expect.poll(async () => (await seen()).some((m) => m.type === 'textEditStarted')).toBe(true);
    await reset();
    await frame.evaluate(`document.querySelector('h1').replaceWith(Object.assign(document.createElement('h1'), { textContent: 'Rebuilt' }))`);
    const messages = await flushed();
    expect(messages.filter((m) => m.type === 'textCancel').map((m) => m.payload.editId)).toEqual(['e1']);
  });
});
