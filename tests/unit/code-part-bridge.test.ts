/**
 * The preview bridge in a real browser frame, on markup shaped as the editor's preview renders a code component: its
 * placement wrapped in an element carrying data-so-code, a part its author marked with data-so-part, and content placed
 * in its slot. A click names the marked part just inside its placement; a selection of that part outlines exactly its
 * element, never the same part of another placement or one inside content placed in the slot.
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
// Two placements of the same calculator; the first holds a button in its slot, inside an element marked as a part of
// the content placed there (no code placement owns that marker).
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:16px/1.4 sans-serif}section{padding:10px}output{display:block;width:200px;height:30px}</style></head><body>
<div style="display: contents" data-so-ctx="page:p" data-so-node="calc1" data-so-code="true">
  <section><output id="t1" data-so-part="total">$10</output>
    <div id="extras" data-so-part="extras"><a id="b1" data-so-ctx="page:p" data-so-node="btn">Book <span id="stray" data-so-part="total">x</span></a></div>
  </section>
</div>
<div style="display: contents" data-so-ctx="page:p" data-so-node="calc2" data-so-code="true">
  <section id="s2"><output id="t2" data-so-part="total">$20</output><p id="n2" class="so-part--theme note so-part--note">Named by its class</p><b id="both" data-so-part="total" class="so-part--note">Both</b></section>
</div>
<div style="display: contents" data-so-ctx="page:p" data-so-node="photo" data-so-code="true">
  <picture style="display: contents"><source type="image/webp" srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw= 1w" /><img id="pic" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="display:block;width:120px;height:60px" /></picture>
</div>
<div style="display: contents" data-so-ctx="page:p" data-so-node="plans" data-so-part-items='{"so-oi-aaa":["card","p,1"],"so-oi-bbb":["card","p_two"],"so-oi-ccc":["name","p_two"]}' data-so-code="true">
  <ul><li id="c1" class="plan so-part--card so-oi-aaa">One</li><li id="c2" class="plan so-part--card so-oi-bbb"><b id="nm2" class="so-part--name so-oi-ccc">Two</b></li><li id="c3" class="plan so-part--card so-oi-zzz">Three</li></ul>
</div>
<div style="display: contents" data-so-ctx="page:p" data-so-node="formy" data-so-code="true">
  <form style="display: contents"><input name="children" id="formy-input" style="display:block;width:80px;height:20px" /></form>
</div>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

type Message = { type: string; payload: { chain?: Array<Record<string, unknown>>; selected?: Array<{ x: number; y: number; width: number; height: number }> } };
const messages = () => page.evaluate<Message[]>(`window.seen`);
const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const boxOf = (id: string) => frame.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

describe.skipIf(!browserInstalled)('marked parts of a code component in the preview', () => {
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
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('names a clicked part just inside its placement, and content placed in its slot before both', async () => {
    await page.evaluate(`window.seen = []`);
    const t1 = await boxOf('t1');
    await page.mouse.click(t1.x + 5, t1.y + 5);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain).toEqual([
      { ctx: 'page:p', node: 'calc1', items: '', part: 'total', tag: 'output' },
      { ctx: 'page:p', node: 'calc1', items: '', tag: 'div', code: true }
    ]);
    // A marker inside the content placed in the slot is that content's: the click names the Button, never the
    // calculator's "total".
    await page.evaluate(`window.seen = []`);
    const stray = await boxOf('stray');
    await page.mouse.click(stray.x + 2, stray.y + 2);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.map((d) => d.part ?? d.node)).toEqual(['btn', 'extras', 'calc1']);
    // A part named by the class its placement gave it, as the preview gives a declared part.
    await page.evaluate(`window.seen = []`);
    const n2 = await boxOf('n2');
    await page.mouse.click(n2.x + 3, n2.y + 3);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.[0]).toEqual({ ctx: 'page:p', node: 'calc2', items: '', part: 'note', tag: 'p' });
    // The author's own marker names the part over any class.
    await page.evaluate(`window.seen = []`);
    const both = await boxOf('both');
    await page.mouse.click(both.x + 3, both.y + 3);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.[0]?.part).toBe('total');
  });

  it('outlines the selected part of one placement only, and moving between parts is news to the editor', async () => {
    await post('setMode', { mode: 'edit' });
    await page.evaluate(`window.seen = []`);
    await post('track', { selected: { ctx: 'page:p', node: 'calc1', items: '', part: 'total' } });
    const t1 = await boxOf('t1');
    // Only the first placement's own "total": not the second placement's, nor the marker inside its slot's content.
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload.selected).toEqual([t1]);
    await post('track', { selected: { ctx: 'page:p', node: 'calc2', items: '', part: 'note' } });
    const n2 = await boxOf('n2');
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload.selected).toEqual([n2]);
    // From one part to the space of the same placement around it, then to its other part: each move is news.
    await page.evaluate(`window.seen = []`);
    const t2 = await boxOf('t2');
    const s2 = await boxOf('s2');
    await page.mouse.move(t2.x + 5, t2.y + 5);
    await page.mouse.move(s2.x + s2.width - 5, s2.y + s2.height - 3);
    await page.mouse.move(n2.x + 5, n2.y + 5);
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'hover').map((m) => m.payload.chain?.[0]?.part ?? m.payload.chain?.[0]?.node)).toEqual(['total', 'calc2', 'note']);
  });

  it('names the one card of a list a repeated part was clicked in, and outlines that card alone', async () => {
    await post('setMode', { mode: 'edit' });
    await page.evaluate(`window.seen = []`);
    const c2 = await boxOf('c2');
    await page.mouse.click(c2.x + c2.width - 4, c2.y + 3);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.[0]).toEqual({ ctx: 'page:p', node: 'plans', items: 'p_two', part: 'card', tag: 'li' });
    // A part inside the card names its own item, by its own class; one whose class names no item, none.
    await page.evaluate(`window.seen = []`);
    const nm2 = await boxOf('nm2');
    await page.mouse.click(nm2.x + 2, nm2.y + 2);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.slice(0, 2)).toEqual([
      { ctx: 'page:p', node: 'plans', items: 'p_two', part: 'name', tag: 'b' },
      { ctx: 'page:p', node: 'plans', items: 'p_two', part: 'card', tag: 'li' }
    ]);
    await page.evaluate(`window.seen = []`);
    const c3 = await boxOf('c3');
    await page.mouse.click(c3.x + 3, c3.y + 3);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.[0]).toEqual({ ctx: 'page:p', node: 'plans', items: '', part: 'card', tag: 'li' });
    // An item ID with a comma is written escaped, as the editor's item paths are, and found again the same way.
    await page.evaluate(`window.seen = []`);
    const c1 = await boxOf('c1');
    await page.mouse.click(c1.x + 3, c1.y + 3);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain?.[0]?.items).toBe('p%2C1');
    await post('track', { selected: { ctx: 'page:p', node: 'plans', items: 'p%2C1', part: 'card' } });
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload.selected).toEqual([c1]);
    await post('track', { selected: { ctx: 'page:p', node: 'plans', items: 'p_two', part: 'card' } });
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload.selected).toEqual([c2]);
    // Every card, with no item named.
    await post('track', { selected: { ctx: 'page:p', node: 'plans', items: '', part: 'card' } });
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload.selected).toEqual([c1, c2, c3]);
  });

  it('outlines a placement whose only content is an image in a <picture>, which lays out no box of its own', async () => {
    await post('setMode', { mode: 'edit' });
    await page.evaluate(`window.seen = []`);
    await post('track', { selected: { ctx: 'page:p', node: 'photo', items: '' } });
    const pic = await boxOf('pic');
    expect(pic.width).toBe(120);
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload.selected).toEqual([pic]);
  });

  it('measures a placement through boxless wrappers, even a form whose control is named "children"', async () => {
    await page.evaluate(`window.seen = []`);
    await post('measure', { requestId: 'm1', descs: [{ ctx: 'page:p', node: 'photo', items: '' }, { ctx: 'page:p', node: 'formy', items: '' }] });
    const [pic, input] = [await boxOf('pic'), await boxOf('formy-input')];
    await expect
      .poll(async () => ((await messages()).find((m) => m.type === 'measured')?.payload as { rects?: unknown[] } | undefined)?.rects)
      .toEqual([
        { ...pic, order: 0 },
        { ...input, order: 0 }
      ]);
  });
});
