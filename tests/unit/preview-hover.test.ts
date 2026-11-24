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
// `display: contents` element), a second placement of it showing an item with the same id, a strip of the section
// with nothing of its own, a footer the editor knows nothing of, and a list whose question opens to show its
// answer. The page itself is the frame's size whatever
// its content, so a change to the content never resizes it.
const FRAME = `<!doctype html><html><head><style>html{height:100%;overflow:hidden}body{margin:0;font:20px/1.4 monospace}h1,p,div{margin:0;padding:10px}</style></head><body>
<main data-so-ctx="page:p" data-so-node="sec">
  <div data-so-ctx="page:p|card" data-so-node="box">
    <h1 data-so-ctx="page:p|card" data-so-node="title"><span id="words">Heading words</span> and more</h1>
    <p id="a" data-so-ctx="page:p|card" data-so-node="item" data-so-items="a">First item</p>
    <p id="b" data-so-ctx="page:p|card" data-so-node="item" data-so-items="b">Second item</p>
    <div style="display: contents" data-so-ctx="page:p|card" data-so-node="code" data-so-code="true"><p id="custom">Code copy</p></div>
  </div>
  <div data-so-ctx="page:p|card2" data-so-node="box"><p id="a2" data-so-ctx="page:p|card2" data-so-node="item" data-so-items="a">First item, again</p></div>
  <p id="plain">Nothing of its own <span id="tick">0</span></p>
</main>
<footer id="outside" style="height:40px">Outside</footer>
<section data-so-ctx="page:p" data-so-node="faq"><details data-so-ctx="page:p|faq" data-so-node="question" data-so-items="x"><summary>A question?</summary><p data-so-ctx="page:p|faq" data-so-node="answer" data-so-items="x">Its answer</p></details></section>
<script type="module" src="/bridge.js"></script></body></html>`;

/**
 * Runs in the frame before the bridge does. Counts every read that makes the browser lay the page out (`innerText`,
 * measuring boxes and computed styles) and every look at the elements in `window.above`; records which elements
 * real pointer moves reached; stops blur from reaching an element when `window.noBlur` is set; and answers a
 * `barrier` message, which arrives after every command posted before it, once two frames have been drawn.
 */
const FRAME_INIT = `if (location.origin === '${SITE}') {
  window.counts = { layout: 0, above: 0 };
  window.counting = false;
  window.above = null;
  window.moves = [];
  const count = (kind, self) => { if (window.counting && (kind === 'layout' || (window.above && window.above.has(self)))) window.counts[kind]++; };
  const wrap = (proto, name, kind) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d.get) Object.defineProperty(proto, name, { ...d, get() { count(kind, this); return d.get.call(this); } });
    else proto[name] = function (...args) { count(kind, this); return d.value.apply(this, args); };
  };
  wrap(HTMLElement.prototype, 'innerText', 'layout');
  wrap(HTMLElement.prototype, 'offsetWidth', 'layout');
  wrap(HTMLElement.prototype, 'offsetHeight', 'layout');
  wrap(Element.prototype, 'getBoundingClientRect', 'layout');
  wrap(Element.prototype, 'getClientRects', 'layout');
  const style = window.getComputedStyle;
  window.getComputedStyle = function (...args) { count('layout'); return style.apply(this, args); };
  for (const name of ['hasAttribute', 'getAttribute', 'closest', 'matches', 'tagName']) wrap(Element.prototype, name, 'above');
  for (const name of ['parentElement', 'parentNode']) wrap(Node.prototype, name, 'above');
  addEventListener('mousemove', (e) => { if (e.isTrusted) window.moves.push(e.target.localName); }, true);
  addEventListener('blur', (e) => { if (window.noBlur && e.target !== window) e.stopPropagation(); }, true);
  addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'barrier') return;
    const id = e.data.id;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => parent.postMessage({ sessionId: 'so-test', type: 'flushed', payload: { id } }, '*'), 30)));
  });
}`;

interface Desc {
  ctx: string;
  node: string;
  items: string;
}
interface Box {
  x: number;
  y: number;
}
interface Message {
  type: string;
  payload: { chain?: Desc[]; selected?: Box[]; hovered?: Box[]; revealed?: Box[]; hoveredDesc?: Desc | null; editId?: string; id?: number };
}

const SEC = { ctx: 'page:p', node: 'sec', items: '', tag: 'main', code: false };
const BOX = { ctx: 'page:p|card', node: 'box', items: '', tag: 'div', code: false };
const BOX2 = { ...BOX, ctx: 'page:p|card2' };
const TITLE = { ctx: 'page:p|card', node: 'title', items: '', tag: 'h1', code: false };
const item = (id: string, ctx = 'page:p|card') => ({ ctx, node: 'item', items: id, tag: 'p', code: false });
const CODE = { ctx: 'page:p|card', node: 'code', items: '', tag: 'div', code: true };
const desc = (d: Desc): Desc => ({ ctx: d.ctx, node: d.node, items: d.items });

let browser: Browser;
let page: Page;
let frame: Frame;
/** Page coordinates of points inside elements of the frame, by element id. */
let at: Record<string, { x: number; y: number }>;

/** Messages the bridge sent the editor since the last reset. */
const seen = () => page.evaluate<Message[]>(`window.seen`);
const reset = async () => {
  await page.evaluate(`window.seen = []`);
  await frame.evaluate(`window.counts = { layout: 0, above: 0 }; window.moves = []`);
};
const counting = (on: boolean) => frame.evaluate(`window.counting = ${on}`);
const counts = () => frame.evaluate<{ layout: number; above: number }>(`window.counts`);
/** The elements real pointer moves reached since the last reset, by tag name. */
const moves = () => frame.evaluate<string[]>(`window.moves`);
let flushes = 0;
/**
 * Everything the bridge has sent so far, once it has handled every command posted before this, two frames have passed
 * (an outline report waits for the next one) and its messages have all arrived: messages from one frame arrive in
 * order, so the answer to the barrier comes after them.
 */
async function flushed(): Promise<Message[]> {
  const id = ++flushes;
  await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ type: 'barrier', id: ${id} }, '*')`);
  await expect.poll(async () => (await seen()).some((m) => m.type === 'flushed' && m.payload.id === id), { timeout: 10000 }).toBe(true);
  return (await seen()).filter((m) => m.type !== 'flushed');
}
/** A command from the editor, as it posts them to the frame. */
const post = (type: string, payload: unknown) =>
  page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const hovers = (messages: Message[]) => messages.filter((m) => m.type === 'hover').map((m) => m.payload.chain);
/** What each hover reported is, innermost element only, whatever else the chain carries. */
const hoveredAt = (messages: Message[]) => hovers(messages).map((chain) => (chain?.[0] ? desc(chain[0]) : null));
const rects = (messages: Message[]) => messages.filter((m) => m.type === 'rects');
/** The page's text changes, as an update re-rendering it does. The text keeps its length, so nothing moves. */
const changeText = () =>
  frame.evaluate(`(() => {
    const text = document.getElementById('plain').firstChild;
    text.data = text.data === 'Nothing of its own ' ? 'Nothing of its OWN ' : 'Nothing of its own ';
  })()`);
/** An element is replaced by a fresh one of the same size, as an update re-mounting it does. */
const replaceNode = () =>
  frame.evaluate(`(() => {
    const tick = document.getElementById('tick');
    tick.replaceWith(Object.assign(document.createElement('span'), { id: 'tick', textContent: tick.textContent === '0' ? '1' : '0' }));
  })()`);
/** Content arrives (or goes) above everything: what is outlined moves 30px down (or back up). */
const shift = () =>
  frame.evaluate(`(() => {
    const old = document.getElementById('spacer');
    if (old) return old.remove();
    const spacer = document.createElement('div');
    spacer.id = 'spacer';
    spacer.setAttribute('style', 'height:30px;padding:0');
    document.body.prepend(spacer);
  })()`);
/**
 * Takes the pointer out of the frame, so nothing is under it and the editor has nothing hovered. The page is told
 * as a real pointer tells it: a headless browser leaves an iframe without saying so.
 */
async function leaveFrame() {
  await page.mouse.move(650, 590);
  await frame.evaluate(`document.documentElement.dispatchEvent(new MouseEvent('mouseleave'))`);
}

describe.skipIf(!browserInstalled)('pointer movement and page changes in the preview', { timeout: 30000 }, () => {
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
    await page.addInitScript(FRAME_INIT);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    // The frame sits at the page's top left, so a point in the frame is the same point on the page.
    at = await frame.evaluate<Record<string, { x: number; y: number }>>(`(() => {
      const out = {};
      const point = (el, fx = 0.5) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height / 2 }; };
      for (const id of ['words', 'a', 'a2', 'b', 'custom', 'plain', 'outside']) out[id] = point(document.getElementById(id));
      const h1 = document.querySelector('h1');
      // The title's own box: past the end of its words, and its padding.
      out.titleEnd = point(h1, 0.9);
      out.titlePad = { x: h1.getBoundingClientRect().left + 3, y: h1.getBoundingClientRect().top + 3 };
      return out;
    })()`);
    // Above the title: its component, the section, the body and the page.
    await frame.evaluate(`window.above = new Set([document.querySelector('[data-so-node="box"]'), document.querySelector('main'), document.body, document.documentElement])`);
    // The counters count: three reads that lay the page out, and two looks above the title.
    const calibrated = await frame.evaluate(`(() => {
      window.counting = true;
      document.body.innerText; document.body.getBoundingClientRect(); getComputedStyle(document.body);
      document.querySelector('main').hasAttribute('data-so-node'); document.body.parentElement;
      window.counting = false;
      return window.counts;
    })()`);
    expect(calibrated).toEqual({ layout: 3, above: 2 });
    await leaveFrame();
    await flushed();
    await reset();
  }, 30000);
  afterEach(async () => {
    await page?.close();
  });

  it('reports what is under the pointer, innermost first, without reading text or laying out the page', async () => {
    await counting(true);
    for (const p of ['words', 'a', 'a2', 'b', 'custom', 'plain', 'outside']) await page.mouse.move(at[p].x, at[p].y);
    const messages = await flushed();
    expect((await counts()).layout).toBe(0);
    expect(hovers(messages)).toEqual([[TITLE, BOX, SEC], [item('a'), BOX, SEC], [item('a', 'page:p|card2'), BOX2, SEC], [item('b'), BOX, SEC], [CODE, BOX, SEC], [SEC], []]);
  });

  it('reports the same part of a component placed in another list item, which differs only further out', async () => {
    // A component placed in each item of a list: its label carries the same descriptor in both, its root the item.
    const points = await frame.evaluate<Array<{ x: number; y: number }>>(`(() => {
      const plain = document.getElementById('plain');
      return ['r1', 'r2'].map((row) => {
        const root = document.createElement('span');
        root.setAttribute('data-so-ctx', 'page:p|team|badge');
        root.setAttribute('data-so-node', 'root');
        root.setAttribute('data-so-items', row);
        const label = document.createElement('b');
        label.textContent = ' ' + row + ' ';
        label.setAttribute('data-so-ctx', 'page:p|team|badge');
        label.setAttribute('data-so-node', 'label');
        root.append(label);
        plain.append(root);
        const r = label.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    })()`);
    await flushed();
    await reset();
    for (const p of points) await page.mouse.move(p.x, p.y);
    const chains = hovers(await flushed());
    expect(chains.map((chain) => chain.slice(0, 2).map((d: Desc) => desc(d)))).toEqual(
      ['r1', 'r2'].map((row) => [
        { ctx: 'page:p|team|badge', node: 'label', items: '' },
        { ctx: 'page:p|team|badge', node: 'root', items: row }
      ])
    );
  });

  it('gives a click, double-click and right-click the same chain, without reading text or laying out the page', async () => {
    await counting(true);
    await page.mouse.click(at.b.x, at.b.y);
    await page.mouse.click(at.custom.x, at.custom.y, { button: 'right' });
    await page.mouse.dblclick(at.words.x, at.words.y);
    const messages = await flushed();
    expect((await counts()).layout).toBe(0);
    expect(messages.filter((m) => m.type === 'select').map((m) => m.payload.chain)).toEqual([
      [item('b'), BOX, SEC],
      [TITLE, BOX, SEC],
      [TITLE, BOX, SEC]
    ]);
    expect(messages.filter((m) => m.type === 'contextmenu').map((m) => m.payload.chain)).toEqual([[CODE, BOX, SEC]]);
    expect(messages.filter((m) => m.type === 'dblclick').map((m) => m.payload.chain)).toEqual([[TITLE, BOX, SEC]]);
  });

  it('looks no further up than the element under the pointer while the pointer stays inside it', async () => {
    await page.mouse.move(at.words.x, at.words.y);
    expect(hoveredAt(await flushed())).toEqual([desc(TITLE)]);
    await reset();
    await counting(true);
    // Across the title's words, past them, its padding and back: the pointer is over the words or the title itself.
    for (const p of ['titleEnd', 'titlePad', 'words', 'titleEnd']) await page.mouse.move(at[p].x, at[p].y, { steps: 3 });
    const messages = await flushed();
    expect(await counts()).toEqual({ layout: 0, above: 0 });
    expect([...new Set(await moves())].sort()).toEqual(['h1', 'span']);
    expect(hovers(messages)).toEqual([]);
    // Into the next element: what is under the pointer is reported again, once.
    await page.mouse.move(at.a.x, at.a.y);
    expect(hovers(await flushed())).toEqual([[item('a'), BOX, SEC]]);
  });

  it('reports the pointer again after it leaves the page and comes back to the same element', async () => {
    await page.mouse.move(at.a.x, at.a.y);
    await leaveFrame();
    await page.mouse.move(at.a.x, at.a.y);
    expect(hoveredAt(await flushed())).toEqual([desc(item('a')), null, desc(item('a'))]);
  });

  it('reports a repeated element under the pointer again once its item changes', async () => {
    await page.mouse.move(at.a.x, at.a.y);
    // The same element now shows another item, as a keyed list reusing it would.
    await frame.evaluate(`document.getElementById('a').setAttribute('data-so-items', 'c')`);
    await page.mouse.move(at.a.x + 2, at.a.y);
    expect(hoveredAt(await flushed())).toEqual([desc(item('a')), desc(item('c'))]);
  });

  it('measures and reports no outlines when the page changes with nothing outlined', async () => {
    await counting(true);
    await changeText();
    expect(rects(await flushed())).toEqual([]);
    await replaceNode();
    expect(rects(await flushed())).toEqual([]);
    expect((await counts()).layout).toBe(0);
    // A hover sent while previewing is kept, and not shown, so it is not measured either.
    await post('mode', { mode: 'preview' });
    await post('track', { selected: null, hovered: desc(item('a')) });
    expect(rects(await flushed()).at(-1)?.payload).toMatchObject({ hoveredDesc: desc(item('a')), hovered: [], selected: [] });
    await reset();
    await changeText();
    await replaceNode();
    expect(rects(await flushed())).toEqual([]);
    expect((await counts()).layout).toBe(0);
  });

  it('still measures what is selected or hovered while editing when the page changes, and stops once it is not', async () => {
    await post('track', { selected: desc(item('a')), hovered: null });
    let r = rects(await flushed());
    const selectedAt = r.at(-1)!.payload.selected![0].y;
    await reset();
    await shift();
    r = rects(await flushed());
    expect(r).toHaveLength(1);
    expect(r[0].payload.selected!.map((b) => b.y)).toEqual([selectedAt + 30]);
    expect(r[0].payload.hovered).toEqual([]);

    await post('track', { selected: null, hovered: desc(item('b')) });
    r = rects(await flushed());
    const hoverY = r.at(-1)!.payload.hovered![0].y;
    await reset();
    await shift();
    r = rects(await flushed());
    expect(r).toHaveLength(1);
    expect(r[0].payload.selected).toEqual([]);
    expect(r[0].payload.hovered!.map((b) => b.y)).toEqual([hoverY - 30]);

    // A selection still measured in Preview, as before: the editor outlines it again on the way back to editing.
    await post('mode', { mode: 'preview' });
    await post('track', { selected: desc(item('a')) });
    r = rects(await flushed());
    const previewAt = r.at(-1)!.payload.selected![0].y;
    await reset();
    await shift();
    r = rects(await flushed());
    expect(r).toHaveLength(1);
    expect(r[0].payload.selected!.map((b) => b.y)).toEqual([previewAt + 30]);

    // Nothing outlined any more: the editor is told once, and then the page's changes are not measured.
    await post('mode', { mode: 'edit' });
    await post('track', { selected: null, hovered: null });
    r = rects(await flushed());
    expect(r.at(-1)?.payload.selected).toEqual([]);
    expect(r.at(-1)?.payload.hovered).toEqual([]);
    await reset();
    await counting(true);
    await changeText();
    await replaceNode();
    await shift();
    expect(rects(await flushed())).toEqual([]);
    expect((await counts()).layout).toBe(0);
  });

  it('still brings a revealed item up to date when an update re-renders it, with nothing selected or hovered', async () => {
    const open = () => frame.evaluate<boolean>(`document.querySelector('details').open`);
    await post('reveal', { target: { ctx: 'page:p|faq', list: 'questions', items: 'x', nodes: ['question'], within: { question: 0, answer: 0 } } });
    expect(rects(await flushed()).at(-1)?.payload.revealed).toHaveLength(1);
    expect(await open()).toBe(true);
    await reset();
    // The question comes back closed, as a hot update re-mounting it does. The page keeps its size, so only the
    // change itself can bring the item up to date.
    await frame.evaluate(`(() => { const old = document.querySelector('details'); const fresh = old.cloneNode(true); fresh.open = false; old.replaceWith(fresh); })()`);
    const r = rects(await flushed());
    expect(await open()).toBe(true);
    expect(r).toHaveLength(1);
    expect(r[0].payload.revealed).toHaveLength(1);
  });

  it('still ends an inline edit whose element an update removed, with nothing outlined', async () => {
    // Only the page changing can end the edit here: losing focus would end it too.
    await frame.evaluate(`window.noBlur = true`);
    await post('beginTextEdit', { desc: desc(TITLE), editId: 'e1' });
    await expect.poll(async () => (await seen()).some((m) => m.type === 'textEditStarted')).toBe(true);
    // Typed text: an edit ended any other way would hand it back as a commit.
    await frame.evaluate(`document.getElementById('words').textContent = 'Typed words'`);
    await flushed();
    await reset();
    await frame.evaluate(`document.querySelector('h1').replaceWith(Object.assign(document.createElement('h1'), { textContent: 'Rebuilt' }))`);
    const messages = await flushed();
    expect(messages.filter((m) => m.type === 'textCancel').map((m) => m.payload.editId)).toEqual(['e1']);
    expect(messages.map((m) => m.type)).not.toContain('textCommit');
  });
});
