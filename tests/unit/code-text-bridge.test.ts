/**
 * The preview bridge in a real browser frame, on markup shaped as the editor's preview renders a code component that
 * marks its text (#1074): its placement wrapped in an element carrying data-so-code, a heading, rich text and each
 * list item's title marked with data-so-text, and content placed in its slot. A double-click names the marked text
 * just inside its placement; the edit is of the occurrence double-clicked, as the property's kind of text; and an edit
 * of a row the page reuses for another item is handed back as text the update took away.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inputReachesFrame } from './frame-input';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:16px/1.4 sans-serif}h2,h3,p{margin:4px 0}</style></head><body>
<div style="display: contents" data-so-ctx="page:p" data-so-node="svc" data-so-code="true">
  <section>
    <h2 id="h" data-so-text="heading">Our services</h2>
    <div id="body" class="so-rich" data-so-text="body"><p>What we do best.</p></div>
    <ul><li><h3 id="t1" data-so-text="features.title#a">Planning</h3></li><li><h3 id="t2" data-so-text="features.title#b">Building</h3></li></ul>
    <p id="dup1" data-so-text="tagline">Same words</p><p id="dup2" data-so-text="tagline">Same words</p>
    <div id="lead" data-so-text="lead">Lead words <a data-so-ctx="page:p" data-so-node="btn2">Go</a></div>
    <div id="outer" data-so-text="outer">Outer <span data-so-text="inner">inner</span></div>
    <svg width="120" height="20"><text id="svgt" data-so-text="caption" x="0" y="15">Caption</text></svg>
    <div class="extras"><a id="btn" data-so-ctx="page:p" data-so-node="btn"><span id="stray" data-so-text="heading">Book a call</span></a></div>
  </section>
</div>
<script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

type Message = { type: string; payload: Record<string, unknown> & { desc?: Record<string, unknown> } };
const messages = () => page.evaluate<Message[]>(`window.seen`);
const post = (type: string, payload: object) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const boxOf = (id: string) => frame.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const editable = (id: string) => frame.evaluate<string | null>(`document.getElementById(${JSON.stringify(id)}).getAttribute('contenteditable')`);
const dblclick = async (id: string) => {
  const b = await boxOf(id);
  await page.mouse.dblclick(b.x + 4, b.y + b.height / 2);
};
const lastOf = async (type: string) => (await messages()).filter((m) => m.type === type).at(-1)?.payload;
const desc = (bind: string) => ({ ctx: 'page:p', node: 'svc', items: '', bind });

describe.skipIf(!browserInstalled)('marked text of a code component in the preview', () => {
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
  beforeEach(async () => {
    // Whatever an earlier test left open ends, as the editor ends it on leaving the page.
    await page.keyboard.press('Escape');
    await page.evaluate(`window.seen = []`);
  });

  it('names the marked text double-clicked inside its placement, and none inside content placed in its slot', async () => {
    await dblclick('t2');
    await expect.poll(() => lastOf('dblclick').then((p) => p?.bind)).toEqual(desc('features.title#b'));
    await page.evaluate(`window.seen = []`);
    await dblclick('stray');
    await expect.poll(() => lastOf('dblclick').then((p) => p && ('bind' in p ? p.bind : null))).toBeNull();
  });

  it('edits the occurrence double-clicked, and commits it under the marker it was begun on', async () => {
    await dblclick('dup2');
    const hit = await lastOf('dblclick').then((p) => p?.hit);
    await post('beginTextEdit', { desc: desc('tagline'), editId: 'e1', hit, rich: false });
    await expect.poll(() => editable('dup2')).toBe('plaintext-only');
    expect(await editable('dup1')).toBeNull();
    await page.keyboard.press('Escape');

    // Begun from the editor's controls (no double-click), the text is found by its marker inside its placement.
    await post('beginTextEdit', { desc: desc('features.title#b'), editId: 'e2', rich: false });
    await expect.poll(() => editable('t2')).toBe('plaintext-only');
    expect(await editable('t1')).toBeNull();
    await page.keyboard.type(' things');
    await page.keyboard.press('Enter');
    await expect.poll(() => lastOf('textCommit')).toEqual({ desc: desc('features.title#b'), editId: 'e2', text: 'Building things' });
  });

  it('edits rich text as rich text, and refuses text shown otherwise than its property is', async () => {
    await post('beginTextEdit', { desc: desc('body'), editId: 'r1', rich: true });
    await expect.poll(() => editable('body')).toBe('true');
    await page.keyboard.press('Escape');
    await post('beginTextEdit', { desc: desc('heading'), editId: 'r2', rich: true });
    await expect.poll(() => lastOf('textCancel')).toEqual({ desc: desc('heading'), editId: 'r2' });
    expect(await editable('h')).toBeNull();
    await post('beginTextEdit', { desc: desc('body'), editId: 'r3', rich: false });
    await expect.poll(() => lastOf('textCancel')).toEqual({ desc: desc('body'), editId: 'r3' });
    expect(await editable('body')).toBeNull();
  });

  it('refuses marked text that holds the editor’s own content or other marked text, or is not HTML', async () => {
    for (const [bind, id] of [['lead', 'lead'], ['outer', 'outer'], ['caption', 'svgt']]) {
      await post('beginTextEdit', { desc: desc(bind), editId: `c-${bind}`, rich: false });
      await expect.poll(() => lastOf('textCancel'), { message: bind }).toEqual({ desc: desc(bind), editId: `c-${bind}` });
      expect(await editable(id), bind).toBeNull();
    }
  });

  it('hands back an edit of a row the page reused for another item as text the update took away', async () => {
    await post('beginTextEdit', { desc: desc('features.title#a'), editId: 'u1', rich: false });
    await expect.poll(() => editable('t1')).toBe('plaintext-only');
    await page.keyboard.type(' ahead');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('now');
    // A list shown without keys gives the row to the next item: its marker and words change in place.
    await frame.evaluate(`(() => { const el = document.getElementById('t1'); el.setAttribute('data-so-text', 'features.title#c'); el.firstChild.nodeValue = 'Launch'; })()`);
    // What was typed goes back, never the other item's words the page wrote over it, and nothing is put back there.
    await expect.poll(() => lastOf('textCommit')).toEqual({ desc: desc('features.title#a'), editId: 'u1', text: 'Planning ahead now', detached: true, before: 'Planning' });
    expect(await editable('t1')).toBeNull();
    const shown = await frame.evaluate<string>(`document.getElementById('t1').textContent`);
    expect(shown.startsWith('Launch') && !shown.includes('Planning'), shown).toBe(true);
  });

  it('ends an edit whose row only changed item, with the same words', async () => {
    await post('beginTextEdit', { desc: desc('features.title#b'), editId: 'u2', rich: false });
    await expect.poll(() => editable('t2')).toBe('plaintext-only');
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await frame.evaluate(`document.getElementById('t2').setAttribute('data-so-text', 'features.title#d')`);
    await expect.poll(() => lastOf('textCommit')).toMatchObject({ desc: desc('features.title#b'), editId: 'u2', detached: true, before: 'Building things' });
    expect((await lastOf('textCommit'))?.text).toMatch(/ more$/);
    expect(await editable('t2')).toBeNull();
    // The page wrote nothing over the typing (the other item's words are the ones shown): the row shows them again.
    expect(await frame.evaluate(`document.getElementById('t2').textContent`)).toBe('Building things');
  });
});
