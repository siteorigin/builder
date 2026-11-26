/**
 * The preview bridge in a real browser frame, on a page laid out as an isolated component preview: it reports
 * whether the component mounted, the box it fills (a code component's wrapper takes no box of its own), and the
 * reason it did not mount.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { ComponentPreviewResult } from '@shared/component-preview';
import type { ComponentDefinition } from '@shared/types';
import { digestComponentInspection, type InspectCase } from '@agent/component-inspection';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

type Box = { x: number; y: number; width: number; height: number };
type Preview = { key: string; mounted: boolean; error?: string; bounds: Box | null; text: string };

/**
 * Load `body` (with `preview` as the entry module leaves it) in a 437px frame; what the bridge said on ready and on
 * inspect, asked with `ask` (the AI's component inspection adds readability and gaps). With `resize`, the frame is
 * given that width that many milliseconds after the inspection is asked for, as a busy machine passes a new width on.
 */
async function run(body: string, preview: object, ask: Record<string, unknown> = {}, resize?: { width: number; after: number }) {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    const origin = 'http://preview.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/__siteorigin/component/abcdefabcdefabcdef/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}<script>window.__siteoriginPreview = ${JSON.stringify(preview)};</script><script type="module" src="/bridge.js"></script></body></html>`
        });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>host</title>' });
    });
    await page.goto(`${origin}/`);
    // Runs in the browser, so it is passed as text (the Node project has no DOM types).
    return await page.evaluate<{ ready: { path: string; preview?: Preview }; report: { preview?: Preview; issues: Array<{ kind: string; desc?: object }>; viewportWidth: number; checks?: Record<string, { checked: number; failed: number }>; gaps?: unknown[] } }>(`new Promise((done, fail) => {
      const frame = document.createElement('iframe');
      frame.name = 'so-test';
      Object.assign(frame.style, { position: 'fixed', left: '-10000px', width: '437px', height: '900px', border: '0' });
      let ready = null;
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'ready') {
          ready = e.data.payload;
          frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r', ...${JSON.stringify(ask)} } }, '*');
          const resize = ${JSON.stringify(resize ?? null)};
          if (resize) setTimeout(() => (frame.style.width = resize.width + 'px'), resize.after);
        }
        if (e.data?.type === 'inspectResult') done({ ready, report: e.data.payload.report });
      });
      setTimeout(() => fail(new Error('No inspection result.')), 8000);
      frame.src = '/__siteorigin/component/abcdefabcdefabcdef/';
      document.body.appendChild(frame);
    })`);
  } finally {
    await browser.close();
  }
}

/**
 * Open the preview page on its own, as the editor's thumbnail window does (#370), and call what the bridge offers it
 * there; also whether the page shows as visitors see it.
 */
async function alone(body: string, preview: object) {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const origin = 'http://preview.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      // An image that never arrives.
      if (path === '/slow.png') return;
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}<script>window.__siteoriginPreview = ${JSON.stringify(preview)};</script><script type="module" src="/bridge.js"></script></body></html>`
      });
    });
    await page.goto(`${origin}/__siteorigin/component/abcdefabcdefabcdef/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('typeof window.__siteoriginThumb === "function"', null, { timeout: 8000 });
    return await page.evaluate<{ measured: Preview; editing: boolean; unlinked: string | null }>(`(async () => ({
      measured: await window.__siteoriginThumb(),
      editing: document.documentElement.hasAttribute('data-so-editing'),
      unlinked: (() => { const el = document.querySelector('[data-so-unlinked]'); return el ? getComputedStyle(el).display : null; })()
    }))()`);
  } finally {
    await browser.close();
  }
}

describe('the bridge in an isolated component preview', () => {
  it.skipIf(!browserInstalled)('opened on its own, shows the component as visitors see it and measures it for its thumbnail', async () => {
    const body = `<main id="main"><div data-so-ctx="preview:c1" data-so-node="preview" style="margin:12px 0 0 30px;width:300px;height:150px;background:red"><a data-so-unlinked href="#">Nowhere</a></div></main>`;
    const { measured, editing, unlinked } = await alone(body, { key: 'abcdefabcdefabcdef', mounted: true });
    expect(editing).toBe(false);
    // A button with nowhere to go is left out, as on the site.
    expect(unlinked).toBe('none');
    expect(measured).toMatchObject({ key: 'abcdefabcdefabcdef', mounted: true, bounds: { x: 30, y: 12, width: 300, height: 150 } });
  }, 20000);

  it.skipIf(!browserInstalled)('opened on its own, says where the component paints, so its thumbnail frames that', async () => {
    // A full-width block with a heading and an icon in it, and a hidden note: only the heading and icon are seen.
    const body = `<main id="main"><div data-so-ctx="preview:c1" data-so-node="preview" style="padding:40px 0"><h2 style="margin:0 0 0 50px;font:20px/30px sans-serif;display:inline-block">Hi</h2><svg width="24" height="24" style="display:block;margin-left:300px"></svg><p style="visibility:hidden;margin:0">Hidden</p></div><div style="height:10px;background:transparent"></div></main>`;
    const { measured } = await alone(body, { key: 'abcdefabcdefabcdef', mounted: true });
    const m = measured as Preview & { ink: Box };
    expect(m.bounds?.width).toBe(640);
    expect(m.ink.x).toBe(50);
    // The heading's text starts at its letters, a little below the top of its line.
    expect(m.ink.y).toBeGreaterThanOrEqual(40);
    expect(m.ink.y).toBeLessThan(47);
    expect(Math.round(m.ink.x + m.ink.width)).toBe(324);
    expect(Math.round(m.ink.y + m.ink.height)).toBe(94);
    // A painted box counts whole.
    const { measured: card } = await alone(`<main id="main"><div style="margin:0 0 0 100px;width:200px;height:80px;background:#f00"></div></main>`, { key: 'abcdefabcdefabcdef', mounted: true });
    expect((card as Preview & { ink: Box }).ink).toEqual({ x: 100, y: 0, width: 200, height: 80 });
  }, 20000);

  it.skipIf(!browserInstalled)('opened on its own, leaves out what a box clips, and counts shadows and generated artwork', async () => {
    const ink = async (body: string) => ((await alone(`<main id="main">${body}</main>`, { key: 'abcdefabcdefabcdef', mounted: true })).measured as Preview & { ink: Box | null }).ink;
    // A red box clipped away by its 1px wrapper is not seen; the text below it is.
    const clipped = await ink(`<div style="height:1px;overflow:hidden"><div style="margin-top:200px;height:30px;background:#f00"></div></div><p style="margin:0;font:16px/20px sans-serif">Hi</p>`);
    expect(clipped!.y + clipped!.height).toBeLessThan(30);
    // A hero painted by its ::before.
    expect(await ink(`<style>.hero::before{content:'';position:absolute;inset:0;background:#00f}</style><div class="hero" style="position:relative;width:400px;height:300px"></div>`)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    // A clearfix's empty ::after paints nothing: the full-width block around the text is not framed. Text an ::after adds is.
    const clearfix = await ink(`<style>.cf::after{content:'';display:table;clear:both}</style><div class="cf"><span style="font:16px/20px sans-serif">Hi</span></div>`);
    expect(clearfix!.width).toBeLessThan(100);
    expect(await ink(`<style>.tag::after{content:'New'}</style><div class="tag" style="width:300px;height:20px"></div>`)).toEqual({ x: 0, y: 0, width: 300, height: 20 });
    // A box drawn only by its shadow.
    expect(await ink(`<div style="margin-left:100px;width:50px;height:50px;box-shadow:0 0 4px #000"></div>`)).toEqual({ x: 100, y: 0, width: 50, height: 50 });
    // Too large to look through: its whole box is framed instead of part of it.
    expect(await ink(`<div style="width:10px;height:10px;background:#000"></div>${'<span></span>'.repeat(5001)}<div style="height:100px;background:#f00"></div>`)).toBeNull();
  }, 30000);

  it.skipIf(!browserInstalled)('opened on its own, says when an image had not arrived', async () => {
    const { measured } = await alone('<main id="main"><img src="/slow.png" width="40" height="40"></main>', { key: 'abcdefabcdefabcdef', mounted: true });
    expect((measured as Preview & { loaded: boolean }).loaded).toBe(false);
    const { measured: done } = await alone('<main id="main"><p>Text</p></main>', { key: 'abcdefabcdefabcdef', mounted: true });
    expect((done as Preview & { loaded: boolean }).loaded).toBe(true);
  }, 20000);

  it.skipIf(!browserInstalled)('opened on its own, says why a component did not mount', async () => {
    const { measured } = await alone('<main id="main"><p data-so-unlinked>x</p></main>', { key: 'abcdefabcdefabcdef', mounted: false, error: 'boom' });
    expect(measured).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null, text: '', ink: null, loaded: true });
  }, 20000);

  it.skipIf(!browserInstalled)('reports the box a code component fills through its wrapper, and no page heading check', async () => {
    const body = `<main id="main"><div style="display: contents" data-so-ctx="preview:c1" data-so-node="preview" data-so-code="true"><p style="margin:10px 20px;height:40px">One</p><p style="margin:0 20px;height:30px">Two</p></div></main>`;
    const { ready, report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true });
    expect(ready.path).toBe('/__siteorigin/component/abcdefabcdefabcdef/');
    expect(ready.preview).toMatchObject({ key: 'abcdefabcdefabcdef', mounted: true });
    expect(report.viewportWidth).toBe(437);
    expect(report.preview?.bounds).toEqual({ x: 20, y: 10, width: 397, height: 80 });
    expect(report.preview?.text).toBe('One Two');
    // A component is not a page: it is never told it lacks the page's one h1.
    expect(report.issues.map((i) => i.kind)).not.toContain('heading-structure');
  }, 20000);

  it.skipIf(!browserInstalled)('is measured at the width the editor gave its frame, once that width reaches the page', async () => {
    const body = `<main id="main"><div data-so-ctx="preview:c1" data-so-node="preview" style="height:40px">Card</div></main>`;
    // The editor made the frame 375px wide just before asking; the page hears of it 400ms later.
    const { report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true }, { width: 375 }, { width: 375, after: 400 });
    expect(report.viewportWidth).toBe(375);
    expect(report.preview?.bounds?.width).toBe(375);
    // A width that never arrives is waited for only so long: the page is measured as it is.
    const started = Date.now();
    const { report: late } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true }, { width: 375 });
    expect(late.viewportWidth).toBe(437);
    expect(Date.now() - started).toBeLessThan(7000);
  }, 20000);

  it.skipIf(!browserInstalled)('takes in every root, text with no box of its own, and wrappers inside wrappers', async () => {
    const body = `<main id="main"><div style="display: contents" data-so-code="true"><span style="display: contents"><b style="display:block;margin-left:30px;width:100px;height:20px">A</b></span>Loose text</div><section style="margin:50px 0 0 200px;width:50px;height:10px"></section></main>`;
    const { report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true });
    const b = report.preview!.bounds!;
    // The top is the bold block's, inside two wrappers; the loose text below it starts at the left edge; the section
    // sets the right edge and the foot.
    expect([b.x, b.y, Math.round(b.x + b.width)]).toEqual([0, 0, 250]);
    expect(b.height).toBeGreaterThan(20 + 50 + 10);
    expect(report.preview?.text).toBe('A Loose text');
  }, 20000);

  it.skipIf(!browserInstalled)('says why a component did not mount', async () => {
    const { ready, report } = await run('<main id="main"></main>', { key: 'abcdefabcdefabcdef', mounted: false, error: 'boom' });
    expect(ready.preview).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null, text: '' });
    expect(report.preview).toEqual({ key: 'abcdefabcdefabcdef', mounted: false, error: 'boom', bounds: null, text: '' });
  }, 20000);

  it.skipIf(!browserInstalled)('checks contrast in a component shown on its own only when the AI asks to check the design (#362)', async () => {
    const at = (node: string) => `data-so-ctx="preview:c1|preview" data-so-node="${node}"`;
    // An inverse tone that left its text dark.
    const body = `<main id="main"><div ${at('r')} style="background:#111;padding:20px"><p ${at('h')} style="color:#333;font:16px/20px sans-serif;margin:0">Dark on dark</p></div></main>`;
    const plain = await run(body, { key: 'abcdefabcdefabcdef', mounted: true });
    expect(plain.report.checks).toBeUndefined();
    expect(plain.report.issues.map((i) => i.kind)).not.toContain('low-contrast');
    // Asked as the AI's component inspection asks: with the gaps too.
    const { report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true }, { readability: true, gaps: true });
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(report.checks?.contrast.checked).toBeGreaterThan(0);
    expect(report.issues.find((i) => i.kind === 'low-contrast')).toMatchObject({ desc: { ctx: 'preview:c1|preview', node: 'h' } });
    expect(report.issues.map((i) => i.kind)).not.toContain('heading-structure');
  }, 20000);

  it.skipIf(!browserInstalled)('says how far apart stacked elements are, so spacing that went with an empty link is found (#362)', async () => {
    const at = (node: string) => `data-so-ctx="preview:c1|preview" data-so-node="${node}"`;
    const card = (container: string, row: string, links: boolean) =>
      `<main id="main"><div ${at('r')} style="${container}"><h3 ${at('h')} style="margin:0;font:20px/24px sans-serif">Spring offer</h3>${links ? `<div ${at('row')} style="${row}"><span ${at('btn')}>Book</span></div>` : ''}<p ${at('p')} style="margin:0;font:16px/20px sans-serif">Ten percent off.</p></div></main>`;
    const def = {
      id: 'c1',
      name: 'Offer',
      parts: { title: { nodeId: 'h', label: 'Title' }, text: { nodeId: 'p', label: 'Text' } },
      tree: { rootIds: ['r'], nodes: { r: { id: 'r', kind: 'element', tag: 'div', children: ['h', 'row', 'p'] }, h: { id: 'h', kind: 'text' }, row: { id: 'row', kind: 'element', tag: 'div', children: ['btn'] }, btn: { id: 'btn', kind: 'text' }, p: { id: 'p', kind: 'text' } } }
    } as unknown as ComponentDefinition;
    const cases: InspectCase[] = [
      { label: 'filled', variants: {}, props: {} },
      { label: 'empty', variants: {}, props: {}, control: 'filled' }
    ];
    const findings = async (container: string, row: string) => {
      const results: ComponentPreviewResult[] = [];
      for (const links of [true, false]) {
        const { report } = await run(card(container, row, links), { key: 'abcdefabcdefabcdef', mounted: true }, { readability: true, gaps: true });
        // Measured at one width here; the digest reads it as both.
        results.push({ state: 'ready', width: 390, report }, { state: 'ready', width: 1280, report });
      }
      const d = digestComponentInspection({ def, select: { definitionId: 'c1' }, values: {}, variants: {}, notes: [] }, cases, results, { offset: 0, total: 2 });
      return (d.content.findings as Array<{ kind: string; at?: { nodeId: string } }> | undefined) ?? [];
    };
    // The button row carries the space around it: with no link it is not shown, and the heading meets the text.
    const collapsed = await findings('', 'margin:24px 0');
    expect(collapsed).toEqual([expect.objectContaining({ kind: 'spacing-collapse', at: { nodeId: 'h', partId: 'title' } })]);
    // The container's gap spaces them, whatever is shown.
    expect(await findings('display:flex;flex-direction:column;gap:16px', '')).toEqual([]);
  }, 40000);

  it.skipIf(!browserInstalled)('measures gaps only from boxes a visitor sees in the flow, named by their list items (#362)', async () => {
    const at = (node: string, items = '') => `data-so-ctx="preview:c1|preview" data-so-node="${node}"${items ? ` data-so-items="${items}"` : ''}`;
    const body = `<main id="main"><div ${at('r')}><p ${at('a')} style="margin:0">A</p><p ${at('hidden')} style="margin:0;visibility:hidden">H</p><p ${at('b')} style="margin:0">B</p><span ${at('inline')}>I</span><div style="display:contents"><p ${at('c', 'i1')} style="margin:8px 0 0">C</p></div></div></main>`;
    const { report } = await run(body, { key: 'abcdefabcdefabcdef', mounted: true }, { gaps: true });
    const pairs = (report.gaps as Array<{ a: { node: string; items: string }; b: { node: string; items: string }; gap: number }>).map((g) => [g.a.node, g.b.node, g.b.items, g.gap]);
    // The hidden box keeps a and b apart and is never an end; the inline box is never an end; the wrapper is looked through.
    expect(pairs).toEqual([]);
    // An inline block is a box of its own, measured like any other.
    const plain = `<main id="main"><div ${at('r')}><p ${at('a')} style="margin:0">A</p><div style="display:contents"><p ${at('c', 'i1')} style="margin:8px 0 0">C</p></div><span ${at('cta')} style="display:inline-block;width:100%;margin-top:4px">Book</span></div></main>`;
    const { report: second } = await run(plain, { key: 'abcdefabcdefabcdef', mounted: true }, { gaps: true });
    const end = (node: string, items = '') => ({ ctx: 'preview:c1|preview', node, items, n: 0, of: 1 });
    expect(second.gaps).toEqual([
      { a: end('a'), b: end('c', 'i1'), gap: 8 },
      { a: end('c', 'i1'), b: end('cta'), gap: 4 }
    ]);
  }, 30000);
});
