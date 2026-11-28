/**
 * The preview bridge in a real browser frame, on a page whose code component threw while it rendered (#1526): the
 * placement shows its note (see renderErrorBoundary in the generator), which raises no error of the window. The bridge
 * reports each note to the editor as the page's error, with the component's file, once the page says it is ready and
 * whenever a note appears later; for each change the page takes it retries every note, and reports one still there
 * before it says the change is shown. A page served as a 500 with a note is the page, not one still being made, so it
 * is never loaded again in a loop; one served as a 500 without one still is.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bridgeSource from '../../src/runtime/bridge.client.js?raw';

const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
// The page's updates arrive through a stand-in for Vite's hot channel, which a plain module does not have.
const bridge = bridgeSource.replace(/import\.meta\.hot/g, 'window.__hot');
const HOT = `window.__hot = { handlers: {}, sent: [], on(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }, send(e, d) { this.sent.push([e, d]); } };
window.__fire = (e, d) => (window.__hot.handlers[e] || []).forEach((f) => f(d));`;
const note = (message: string, file: string) =>
  `<div data-so-render-error="${message}" data-so-error-file="${file}" data-so-editor-only><strong>Broken couldn’t be shown</strong> <span>${message}</span></div>`;
const BROKEN = `<!doctype html><html><head><title>Home</title></head><body>
<section data-so-ctx="page:p" data-so-node="hero"><h1>Hero</h1></section>
<div style="display: contents" data-so-ctx="page:p" data-so-node="broken" data-so-code="true">
  ${note('Cannot read properties of undefined (reading &#39;nested&#39;)', 'src/lib/siteorigin/custom/Broken.svelte')}
</div>
<section data-so-ctx="page:p" data-so-node="footer"><p>After</p></section>
<script type="module" src="/bridge.js"></script></body></html>`;
const FRESH = `<!doctype html><html><head><title>Fresh</title></head><body><section data-so-ctx="page:p" data-so-node="hero"><h1>Fresh</h1></section><script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
type Message = { type: string; navigationId: string; payload: Record<string, unknown> };
type Opened = { page: Page; frame: () => Frame; loads: () => number; messages: () => Promise<Message[]>; errors: () => Promise<Array<{ message: unknown; file: unknown; revision: unknown }>> };

/** A host page framing `path` of the site, which the editor asked for; `serve` answers each load of it in turn. */
async function open(path: string, serve: Array<{ status: number; body: string }>, init = ''): Promise<Opened> {
  const page = await browser.newPage();
  let loads = 0;
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
    if (url.origin === SITE && url.pathname === path) return route.fulfill({ contentType: 'text/html', ...serve[Math.min(loads++, serve.length - 1)] });
    if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}${path}" style="border:0;width:700px;height:400px"></iframe></body>` });
    return route.abort();
  });
  await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, navigationId: e.data.navigationId, payload: e.data.payload }); }); }`);
  // The editor asked for this page, as it does for one it has just made: a 500 for it is loaded again. Asked once.
  await page.addInitScript(`if (location.origin === '${SITE}') { ${HOT} ${init} if (!sessionStorage.getItem('so-test-asked')) { sessionStorage.setItem('so-test-asked', '1'); sessionStorage.setItem('siteorigin:asked', JSON.stringify({ path: '${path}', tries: 0 })); } }`);
  await page.goto(`${HOST}/`);
  const messages = () => page.evaluate<Message[]>(`window.seen`);
  return {
    page,
    frame: () => page.frames().find((f) => f.name() === 'so-test')!,
    loads: () => loads,
    messages,
    errors: async () => (await messages()).filter((m) => m.type === 'runtimeError').map((m) => ({ message: m.payload.message, file: m.payload.file, revision: m.payload.revision }))
  };
}
/** Two frames of the page drawn: whatever the bridge queued for the next frame has been sent. */
const drawn = (frame: Frame) => frame.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

describe.skipIf(!browserInstalled)('a code component that threw while the page rendered', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });

  it('is reported as the page’s error once the page is ready, naming the component’s file, and the page is not loaded again for its 500', async () => {
    const o = await open('/frame', [{ status: 500, body: BROKEN }]);
    await expect.poll(async () => (await o.messages()).map((m) => m.type).filter((t) => t === 'ready' || t === 'runtimeError'), { timeout: 10000 }).toEqual(['ready', 'runtimeError']);
    expect(await o.errors()).toEqual([{ message: "Cannot read properties of undefined (reading 'nested')", file: 'src/lib/siteorigin/custom/Broken.svelte', revision: 0 }]);
    expect(await o.frame().evaluate(`performance.getEntriesByType('navigation')[0].responseStatus`)).toBe(500);
    await o.page.waitForTimeout(400);
    expect(o.loads()).toBe(1);
    await o.page.close();
  });

  it('loads again a page the editor asked for that came back as a 500 without a note: it was not there yet', async () => {
    const o = await open('/missing', [{ status: 500, body: '<!doctype html><title>Error 500</title><script type="module" src="/bridge.js"></script>' }, { status: 200, body: FRESH }]);
    await expect.poll(async () => (await o.messages()).filter((m) => m.type === 'ready').map((m) => m.payload.title), { timeout: 10000 }).toEqual(['Fresh']);
    expect(o.loads()).toBe(2);
    expect(await o.errors()).toEqual([]);
    await o.page.close();
  });

  it('reports a note that appears later once per file and message, and every note again for another page', async () => {
    const o = await open('/frame', [{ status: 500, body: BROKEN }]);
    await expect.poll(async () => (await o.errors()).length, { timeout: 10000 }).toBe(1);
    const frame = o.frame();
    await o.page.evaluate(`window.seen = []`);
    const later = (node: string, message: string, file: string) =>
      frame.evaluate(`document.querySelector('[data-so-node="footer"]').insertAdjacentHTML('beforebegin', ${JSON.stringify(`<div style="display: contents" data-so-ctx="page:p" data-so-node="${node}" data-so-code="true">${note(message, file)}</div>`)})`);
    // The same file with another message, and the same message from another file, are each a problem of their own.
    await later('a', 'later is not defined', 'src/lib/siteorigin/custom/Later.svelte');
    await later('b', 'another message', 'src/lib/siteorigin/custom/Later.svelte');
    await later('c', 'later is not defined', 'src/lib/siteorigin/custom/Other.svelte');
    await expect.poll(async () => (await o.errors()).map((e) => `${e.file} ${e.message}`).sort(), { timeout: 10000 }).toEqual([
      'src/lib/siteorigin/custom/Later.svelte another message',
      'src/lib/siteorigin/custom/Later.svelte later is not defined',
      'src/lib/siteorigin/custom/Other.svelte later is not defined'
    ]);
    // Other changes to the page say nothing more of notes already reported.
    await frame.evaluate(`document.querySelector('h1').textContent = 'Hero again'`);
    await drawn(frame);
    await drawn(frame);
    expect(await o.errors()).toHaveLength(3);
    // Another page (a link followed in place): all four notes are its problems, said after the editor hears of it.
    await o.page.evaluate(`window.seen = []`);
    await frame.evaluate(`history.pushState(null, '', '/other'); dispatchEvent(new CustomEvent('siteorigin:navigated'))`);
    await expect.poll(async () => (await o.errors()).length, { timeout: 10000 }).toBe(4);
    const after = (await o.messages()).filter((m) => m.type === 'navigated' || m.type === 'runtimeError');
    expect(after[0].type).toBe('navigated');
    expect(new Set(after.map((m) => m.navigationId)).size).toBe(1);
    await o.page.close();
  });

  it('reports a new note once the notes before it have left the page, however many there were', async () => {
    const o = await open('/frame', [{ status: 500, body: BROKEN }]);
    await expect.poll(async () => (await o.errors()).length, { timeout: 10000 }).toBe(1);
    const frame = o.frame();
    // Fifty-one rows, each throwing its own message: the first fifty are said.
    const rows = Array.from({ length: 51 }, (_, i) => note(`row ${i} broke`, 'src/lib/siteorigin/custom/Rows.svelte')).join('');
    await frame.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<div id="rows">${rows}</div>`)})`);
    await expect.poll(async () => (await o.errors()).length, { timeout: 10000 }).toBe(50);
    // Fixed, the page is left with one new problem, which is said.
    await o.page.evaluate(`window.seen = []`);
    await frame.evaluate(`document.getElementById('rows').remove(); document.querySelector('[data-so-render-error]').remove(); document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(note('only this', 'src/lib/siteorigin/custom/Rows.svelte'))})`);
    await expect.poll(async () => (await o.errors()).map((e) => e.message), { timeout: 10000 }).toEqual(['only this']);
    await o.page.close();
  });

  it('in an isolated component preview, says only the notes that appear after the preview said whether it was shown', async () => {
    const o = await open('/frame', [{ status: 200, body: BROKEN }], `window.__siteoriginPreview = { key: 'k', mounted: false, error: 'said with ready' };`);
    await expect.poll(async () => (await o.messages()).some((m) => m.type === 'ready'), { timeout: 10000 }).toBe(true);
    const frame = o.frame();
    await drawn(frame);
    expect(await o.errors()).toEqual([]);
    await frame.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(note('broke after a click', 'src/lib/siteorigin/custom/Later.svelte'))})`);
    await expect.poll(async () => (await o.errors()).map((e) => e.message), { timeout: 10000 }).toEqual(['broke after a click']);
    await o.page.close();
  });

  it('in an isolated component preview that said it was shown, says a note already there when the bridge starts', async () => {
    const o = await open('/frame', [{ status: 200, body: BROKEN }], `window.__siteoriginPreview = { key: 'k', mounted: true };`);
    await expect.poll(async () => (await o.errors()).map((e) => e.file), { timeout: 10000 }).toEqual(['src/lib/siteorigin/custom/Broken.svelte']);
    await o.page.close();
  });

  it('retries each note when the page takes a change, and reports one still there before the change is said to be shown', async () => {
    const o = await open('/frame', [{ status: 500, body: BROKEN }]);
    await expect.poll(async () => (await o.errors()).length, { timeout: 10000 }).toBe(1);
    const frame = o.frame();
    // The boundary's retry, as the note's attachment hands it on: here, still failing, the note stays.
    await frame.evaluate(`window.__retried = 0; document.querySelector('[data-so-render-error]').__soRetry = () => window.__retried++`);
    await o.page.evaluate(`window.seen = []`);
    await frame.evaluate(`window.__fire('siteorigin:revision', { revision: 7, batch: 1 })`);
    await expect.poll(async () => (await o.messages()).some((m) => m.type === 'revisionApplied'), { timeout: 10000 }).toBe(true);
    expect(await frame.evaluate(`window.__retried`)).toBe(1);
    expect((await o.messages()).filter((m) => m.type === 'runtimeError' || m.type === 'revisionApplied').map((m) => [m.type, m.payload.revision])).toEqual([
      ['runtimeError', 7],
      ['revisionApplied', 7]
    ]);
    // Fixed: the retry shows the component again, and the next change is shown with nothing to report.
    await frame.evaluate(`const el = document.querySelector('[data-so-render-error]'); el.__soRetry = () => el.replaceWith(Object.assign(document.createElement('p'), { textContent: 'Value: 1' }))`);
    await o.page.evaluate(`window.seen = []`);
    await frame.evaluate(`window.__fire('siteorigin:revision', { revision: 8, batch: 2 })`);
    await expect.poll(async () => (await o.messages()).some((m) => m.type === 'revisionApplied'), { timeout: 10000 }).toBe(true);
    await drawn(frame);
    expect(await o.errors()).toEqual([]);
    await o.page.close();
  });
});
