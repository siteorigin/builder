/**
 * The preview bridge in a real browser frame, on markup shaped as the editor's preview renders a placement's empty slots
 * (#652): each placeholder names its placement and slot. A click on one names that slot innermost; it is outlined and
 * measured as itself (never as the code placement whose descriptor shares its context and node), measured where it
 * first shows when an earlier copy is hidden, and left out of what a drag asks is under the pointer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const marker = (slot: string, id: string, style = '') =>
  `<span id="${id}" class="so-slot-empty" data-so-editor-only="" data-so-slot-empty="${slot}" data-so-slot-ctx="page:p" data-so-slot-node="split"${style ? ` style="${style}"` : ''}><strong id="${id}-label">${slot}</strong></span>`;
// A code placement "split" showing Main once and Sidebar twice: a copy hidden at this width, then the one that shows.
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:16px/1.4 sans-serif}.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px}</style></head><body>
<div style="display: contents" data-so-ctx="page:p" data-so-node="split" data-so-code="true">
  <div class="cols" id="root"><div>${marker('main', 'main')}</div><div><div style="display: none">${marker('sidebar', 'side-hidden')}</div>${marker('sidebar', 'side')}</div></div>
</div>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

type Box = { x: number; y: number; width: number; height: number };
type Message = { type: string; payload: { chain?: Array<Record<string, unknown>>; selected?: Box[]; hovered?: Box[]; spacing?: unknown; slots?: Array<{ desc: Record<string, unknown>; box: Box }>; rects?: Array<(Box & { many?: boolean }) | null>; requestId?: string } };
const messages = () => page.evaluate<Message[]>(`window.seen`);
const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const boxOf = (id: string) => frame.evaluate<Box>(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const slot = (name: string) => ({ ctx: 'page:p', node: 'split', items: '', slot: name });

describe.skipIf(!browserInstalled)('a placement’s empty slots in the preview (#652)', () => {
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

  it('names a clicked placeholder as its slot, innermost, its label included', async () => {
    await page.evaluate(`window.seen = []`);
    const label = await boxOf('side-label');
    await page.mouse.click(label.x + 2, label.y + 2);
    await expect.poll(async () => (await messages()).find((m) => m.type === 'select')?.payload.chain).toEqual([
      { ...slot('sidebar'), tag: 'span' },
      { ctx: 'page:p', node: 'split', items: '', tag: 'div', code: true }
    ]);
    // Hovering it is news of the slot too.
    await page.evaluate(`window.seen = []`);
    const main = await boxOf('main');
    await page.mouse.move(main.x + main.width / 2, main.y + main.height - 4);
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'hover').at(-1)?.payload.chain?.[0]).toEqual({ ...slot('main'), tag: 'span' });
  });

  it('outlines and measures a slot by its placeholder where it shows, never as the placement, with no spacing handles', async () => {
    await page.evaluate(`window.seen = []`);
    await post('track', { selected: slot('sidebar'), hovered: slot('sidebar') });
    const side = await boxOf('side');
    const rects = async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload;
    // The copy that shows, not the hidden one before it, and not the code placement sharing its context and node.
    await expect.poll(async () => (await rects())?.selected).toEqual([side]);
    expect((await rects())?.hovered).toEqual([side]);
    expect((await rects())?.spacing).toBeNull();
    await post('measure', { requestId: 'm1', descs: [slot('main'), slot('sidebar'), { ctx: 'page:p', node: 'split', items: '' }, slot('footer')] });
    await expect.poll(async () => (await messages()).find((m) => m.type === 'measured')?.payload.requestId).toBe('m1');
    const measured = (await messages()).find((m) => m.type === 'measured')!.payload.rects!;
    expect(measured[0]).toMatchObject(await boxOf('main'));
    expect(measured[1]).toMatchObject(side);
    // One copy shows: it is one place.
    expect(measured[1]!.many).toBeUndefined();
    expect(measured[2]).toMatchObject(await boxOf('root'));
    expect(measured[3]).toBeNull();
    // Any other element is measured where it first shows too (#658): a copy hidden at this width is skipped, and the one
    // copy that shows is one place, as the selection's outline finds it.
    await frame.evaluate(`document.getElementById('root').insertAdjacentHTML('beforeend', '<i data-so-ctx="page:p" data-so-node="twice" style="display: none">a</i><i id="shown-twice" data-so-ctx="page:p" data-so-node="twice">b</i>')`);
    await post('measure', { requestId: 'm2', descs: [{ ctx: 'page:p', node: 'twice', items: '' }] });
    await expect.poll(async () => (await messages()).find((m) => m.type === 'measured' && m.payload.requestId === 'm2')?.payload.rects?.length).toBe(1);
    const twice = (await messages()).find((m) => m.type === 'measured' && m.payload.requestId === 'm2')!.payload.rects![0];
    expect(twice).toMatchObject(await boxOf('shown-twice'));
    expect(twice!.many).toBeUndefined();
  });

  it('reports the box of each slot tracked with the selection where it shows, until the selection no longer asks (#657)', async () => {
    await page.evaluate(`window.seen = []`);
    const placement = { ctx: 'page:p', node: 'split', items: '' };
    await post('track', { selected: placement, hovered: null, slots: [slot('main'), slot('sidebar'), slot('footer')] });
    const rects = async () => (await messages()).filter((m) => m.type === 'rects').at(-1)?.payload;
    // Each on its own placeholder (Sidebar's that shows, not its hidden copy); one the page does not show is left out.
    const main = await boxOf('main');
    const side = await boxOf('side');
    await expect.poll(async () => (await rects())?.slots).toEqual([
      { desc: slot('main'), box: main },
      { desc: slot('sidebar'), box: side }
    ]);
    // A new selection that tracks none drops them.
    await post('track', { selected: placement, hovered: null });
    await expect.poll(async () => (await rects())?.slots).toEqual([]);
  });

  it('leaves placeholders out of what a drag asks is under the pointer', async () => {
    await page.evaluate(`window.seen = []`);
    const side = await boxOf('side');
    await post('pointAt', { requestId: 'p1', x: side.x + 5, y: side.y + 5 });
    await expect.poll(async () => (await messages()).find((m) => m.type === 'pointed')?.payload.chain?.map((d) => d.slot ?? d.node)).toEqual(['split']);
  });
});
