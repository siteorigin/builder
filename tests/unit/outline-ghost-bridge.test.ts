/**
 * The selection's outline the preview bridge draws in the page while the document scrolls (#1307), in a real browser
 * frame shaped as the generated site renders it (the app inside SvelteKit's display:contents wrapper, beside a sticky
 * part of the page): drawn only while the page moves and the editor asked for it, told to the editor only once it has
 * been drawn, kept until the editor has its own outline back, and never for a selection pinned to the view or a box
 * scrolling inside the page.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Imported, not read from disk, so a change to the bridge alone still selects this test on a pull request.
import bridge from '../../src/runtime/bridge.client.js?raw';

const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const FRAME = `<!doctype html><html><head><style>body{margin:0}section{height:600px}.pin{position:sticky;top:0;height:60px;background:#fff}.track{overflow-x:auto;white-space:nowrap}.track div{display:inline-block;width:500px;height:100px}.bar{position:fixed;bottom:0;left:0;width:100px;height:20px}</style></head><body>
<div style="display:contents">
<div class="pin" data-so-ctx="page:home" data-so-node="pin">Pinned</div>
<div style="display:contents" data-so-ctx="page:home" data-so-node="wrapped"><div class="bar">Fixed</div></div>
<main id="main"><section data-so-ctx="page:home" data-so-node="one">One</section><section data-so-ctx="page:home" data-so-node="two">Two</section>
<div class="track"><div>A</div><div>B</div><div>C</div></div><section>Three</section></main>
</div>
<script type="module" src="/bridge.js"></script></body></html>`;
const SPEC = { key: 'k1', color: '#1766c0', pad: 0, z: 0.5 };
const ONE = { ctx: 'page:home', node: 'one', items: '' };

let browser: Browser;
let page: Page;
let frame: Frame;

const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const lastReport = () => page.evaluate(`window.seen.filter((m) => m.type === 'rects').at(-1)?.payload`) as Promise<{ ghost?: string; selected: Array<{ y: number }> } | undefined>;
/** The key the page's last report says its outline was drawn for, if it says one is. */
const ghostKey = async () => (await lastReport())?.ghost ?? null;
const ghostSaid = async () => (await ghostKey()) === SPEC.key;
/** The boxes the page draws, as the page lays them out, and the ring each is drawn with; null without the outline. */
const drawn = () =>
  frame.evaluate(`(() => {
    const host = document.getElementById('so-outline-ghost');
    if (!host) return null;
    return [...host.shadowRoot.children].map((b) => { const r = b.getBoundingClientRect(); return { y: r.y, height: r.height, width: r.width, ring: b.style.boxShadow }; });
  })()`) as Promise<Array<{ y: number; height: number; width: number; ring: string }> | null>;
/** The page scrolled by hand (a wheel turned over it), to `y`; `byHand: false` for a scroll of the page's own. */
const scrollTo = (y: number, byHand = true) => frame.evaluate(`${byHand ? `window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));` : ''} window.scrollTo(0, ${y})`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long after its last input a scroll still counts as the person's (the bridge's HAND_SCROLL_MS). */
const HAND_SCROLL_MS = 300;
/** Into a scroll the person started, past nothing: shorter than a scroll's hold (GHOST_HOLD_MS). */
const HAND_SCROLL_MS_PAST = 120;

describe.skipIf(!browserInstalled)('the outline the preview draws while it scrolls (#1307)', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE) return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:700px;height:500px"></iframe></body>` });
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
    // Each case from the page's top, at rest, with the hero-like first section selected and the editor's word given.
    await post('outlineGhost', { spec: null });
    await post('mode', { mode: 'edit' });
    await post('track', { selected: ONE, hovered: null, slots: [] });
    await scrollTo(0, false);
    await expect.poll(drawn).toBeNull();
    // The scroll back fires its event at the frame's next rendering, and a hand's scroll in the case before stops
    // counting as one HAND_SCROLL_MS after its last wheel: both before the case's own scroll, so none of it is the case's.
    await sleep(HAND_SCROLL_MS + 100);
    await post('outlineGhost', { spec: SPEC });
    await expect.poll(async () => (await lastReport())?.selected[0]?.y).toBe(60);
  });

  it('draws nothing at rest, and the outline in the page while the document scrolls, as the editor draws it', async () => {
    await sleep(200);
    expect(await drawn()).toBeNull();
    expect(await ghostSaid()).toBe(false);
    await scrollTo(40);
    // On the section, where the page lays it out now: the editor's 1, 3 and 4 px rings at half zoom are 2, 6 and 8 here.
    await expect.poll(drawn).toEqual([{ y: 20, height: 600, width: 700, ring: 'rgb(16, 24, 40) 0px 0px 0px 2px inset, rgb(23, 102, 192) 0px 0px 0px 6px inset, rgb(255, 255, 255) 0px 0px 0px 8px inset' }]);
    await expect.poll(ghostSaid).toBe(true);
    // It is in the document: the page carries it as it scrolls on, without it being drawn again.
    const style = (await drawn())![0];
    await scrollTo(100);
    expect(await drawn()).toEqual([{ ...style, y: -40 }]);
    // Asked for at another zoom while it scrolls: drawn again, and said for that.
    await post('outlineGhost', { spec: { ...SPEC, key: 'k2', z: 1 } });
    await scrollTo(110);
    await expect.poll(ghostKey).toBe('k2');
    expect((await drawn())![0].ring).toBe('rgb(16, 24, 40) 0px 0px 0px 1px inset, rgb(23, 102, 192) 0px 0px 0px 3px inset, rgb(255, 255, 255) 0px 0px 0px 4px inset');
  });

  it('draws nothing for a scroll of the page’s own: the selection kept in view as the width changes, the editor’s request', async () => {
    for (const y of [40, 80, 120, 160]) {
      await scrollTo(y, false);
      await sleep(30);
    }
    await sleep(100);
    expect(await drawn()).toBeNull();
    expect(await ghostKey()).toBeNull();
    // A scroll the person started goes on drawing it to its end, by the page's hand or not.
    await scrollTo(200);
    await expect.poll(ghostSaid).toBe(true);
    await sleep(HAND_SCROLL_MS_PAST);
    await scrollTo(240, false);
    await sleep(50);
    expect(await ghostSaid()).toBe(true);
  });

  it('keeps the outline once the scroll stops, until the editor has its own back', async () => {
    await scrollTo(30);
    await expect.poll(ghostSaid).toBe(true);
    // An answer while it still scrolls (one late from before) takes nothing away.
    await post('outlineGhostDone', {});
    await sleep(50);
    expect(await drawn()).not.toBeNull();
    // Still scrolling: it stays said.
    for (let y = 40; y <= 90; y += 10) {
      await scrollTo(y);
      await sleep(40);
      expect(await ghostSaid()).toBe(true);
    }
    // Stopped: the editor is told, and the page's outline stays until the editor says its own is drawn.
    await expect.poll(ghostKey).toBeNull();
    expect(await drawn()).not.toBeNull();
    // Taken away on the editor's word, not left for the fallback a second later.
    await post('outlineGhostDone', {});
    await expect.poll(drawn, { timeout: 400 }).toBeNull();
    // Scrolling again draws it again.
    await scrollTo(120);
    await expect.poll(ghostSaid).toBe(true);
  });

  it('takes the outline away itself when the editor never answers, and at once when the selection, mode or word changes', async () => {
    await scrollTo(30);
    await expect.poll(ghostSaid).toBe(true);
    await expect.poll(ghostKey).toBeNull();
    // Kept a while for the editor's word, then taken away all the same.
    await sleep(300);
    expect(await drawn()).not.toBeNull();
    await expect.poll(drawn, { timeout: 3000 }).toBeNull();
    // Another selection: the page's outline was of the one before.
    await scrollTo(60);
    await expect.poll(ghostSaid).toBe(true);
    await post('track', { selected: { ctx: 'page:home', node: 'two', items: '' }, hovered: null, slots: [] });
    await expect.poll(drawn).toBeNull();
    // Preview: no outline at all.
    await scrollTo(90);
    await expect.poll(drawn).not.toBeNull();
    await post('mode', { mode: 'preview' });
    await expect.poll(drawn).toBeNull();
    await post('mode', { mode: 'edit' });
    // The editor draws something other than the plain outline (no word): the page draws none.
    await scrollTo(130);
    await expect.poll(drawn).not.toBeNull();
    await post('outlineGhost', { spec: null });
    await expect.poll(drawn).toBeNull();
    await scrollTo(160);
    await sleep(100);
    expect(await drawn()).toBeNull();
    expect(await ghostSaid()).toBe(false);
  });

  it('keeps the outline when the page goes elsewhere in place, until the editor has its own back', async () => {
    await scrollTo(30);
    await expect.poll(ghostSaid).toBe(true);
    // Going back can be told twice (the history's own event and the site's): the second takes nothing more away.
    await frame.evaluate(`history.pushState(null, '', '/elsewhere'); window.dispatchEvent(new Event('siteorigin:navigated')); window.dispatchEvent(new PopStateEvent('popstate'))`);
    await expect.poll(ghostKey).toBeNull();
    expect(await drawn()).not.toBeNull();
    await post('outlineGhostDone', {});
    await expect.poll(drawn, { timeout: 400 }).toBeNull();
    await frame.evaluate(`history.pushState(null, '', '/frame'); window.dispatchEvent(new Event('siteorigin:navigated'))`);
  });

  it('draws nothing for a selection that stays put as the document scrolls, or for a box scrolling inside the page', async () => {
    await post('track', { selected: { ctx: 'page:home', node: 'pin', items: '' }, hovered: null, slots: [] });
    await scrollTo(50);
    await sleep(100);
    expect(await drawn()).toBeNull();
    // A placement's wrapper laid out as its children, one of them fixed to the view.
    await post('track', { selected: { ctx: 'page:home', node: 'wrapped', items: '' }, hovered: null, slots: [] });
    await sleep(200);
    await scrollTo(80);
    await sleep(100);
    expect(await drawn()).toBeNull();
    // The section inside the scrolling box, which moves it sideways.
    await frame.evaluate(`document.querySelector('.track div').setAttribute('data-so-ctx', 'page:home'); document.querySelector('.track div').setAttribute('data-so-node', 'card')`);
    await post('track', { selected: { ctx: 'page:home', node: 'card', items: '' }, hovered: null, slots: [] });
    await sleep(200);
    await frame.evaluate(`document.querySelector('.track').scrollLeft = 300`);
    await sleep(100);
    expect(await drawn()).toBeNull();
    await post('track', { selected: ONE, hovered: null, slots: [] });
    await frame.evaluate(`document.querySelector('.track').scrollLeft = 200`);
    await sleep(100);
    expect(await drawn()).toBeNull();
    expect(await ghostSaid()).toBe(false);
  });

  it('draws nothing over which the page cannot draw: a dialog in the top layer, a rescaled page, or an unreadable word', async () => {
    await frame.evaluate(`document.body.insertAdjacentHTML('beforeend', '<dialog id="d">Over it</dialog>'); document.getElementById('d').showModal()`);
    await scrollTo(50);
    await sleep(100);
    expect(await drawn()).toBeNull();
    await frame.evaluate(`document.getElementById('d').close(); document.getElementById('d').remove()`);
    await sleep(200);
    await frame.evaluate(`document.documentElement.style.transform = 'scale(0.8)'`);
    await scrollTo(90);
    await sleep(100);
    expect(await drawn()).toBeNull();
    await frame.evaluate(`document.documentElement.style.transform = ''`);
    await sleep(200);
    await post('outlineGhost', { spec: { ...SPEC, key: undefined } });
    await scrollTo(130);
    await sleep(100);
    expect(await drawn()).toBeNull();
    expect(await ghostKey()).toBeNull();
  });

  it('never makes the page longer: the room around a box at the very end stops at the end', async () => {
    const end = (await frame.evaluate(`document.documentElement.scrollHeight`)) as number;
    // The last section, at the page's very end, with room around it (6 of the editor's pixels, 12 here) past the end.
    await post('outlineGhost', { spec: { ...SPEC, pad: 6 } });
    await frame.evaluate(`document.querySelector('main').lastElementChild.setAttribute('data-so-ctx', 'page:home'); document.querySelector('main').lastElementChild.setAttribute('data-so-node', 'last')`);
    await post('track', { selected: { ctx: 'page:home', node: 'last', items: '' }, hovered: null, slots: [] });
    await scrollTo(end);
    await expect.poll(drawn).not.toBeNull();
    const top = (await frame.evaluate(`document.querySelector('[data-so-node="last"]').getBoundingClientRect().top`)) as number;
    const view = (await frame.evaluate(`innerHeight`)) as number;
    const [box] = (await drawn())!;
    // Its room above it, and none below the page's end (the bottom of the view, scrolled to the end).
    expect(box.y).toBe(top - 12);
    expect(box.y + box.height).toBe(view);
    expect(await frame.evaluate(`document.documentElement.scrollHeight`)).toBe(end);
  });
});
