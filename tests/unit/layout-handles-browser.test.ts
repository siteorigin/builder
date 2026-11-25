/**
 * The page's side of the gap, max width and column handles (#385), with the real preview bridge in a real browser
 * frame: the selected box's layout comes with its outline report (a grid's columns, a stack's items, how wide it may
 * be), page-width styles are measured against the width a percentage is taken of, a drag's preview takes only the
 * values a drag can write, and a column preview stays until the page's own stylesheet shows every column as it did.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const FRAME = `<!doctype html><html><head><style>
:root{--so-container-half:50%;--so-space-lg:24px}
body{margin:0;font:16px/20px sans-serif}
#wrap{width:1000px;padding:0 20px}
#grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,2fr);column-gap:24px;row-gap:16px;max-width:800px;margin-inline:auto}
#grid p{margin:0;height:40px}
#row{display:flex;column-gap:20px;margin:0 24px}
#row span{display:block;width:100px;height:40px}
</style><style id="site"></style></head><body><div id="wrap">
<div id="grid" data-so-ctx="page:p" data-so-node="grid"><p>a</p><p>b</p><p>c</p></div>
<div id="row" data-so-ctx="page:p" data-so-node="row"><span>1</span><span>2</span><span style="position:absolute">x</span><span>3</span></div>
</div><script type="module" src="/bridge.js"></script></body></html>`;

const HOST = `<!doctype html><title>host</title>
<iframe name="so-test" src="/frame" style="width:1100px;height:600px;border:0;display:block"></iframe>
<script>
  window.replies = [];
  window.addEventListener('message', (e) => window.replies.push(e.data));
  window.post = (type, payload) => frames[0].postMessage({ protocolVersion: 1, sessionId: 'so-test', type, payload }, '*');
</script>`;

const sel = (node: string) => ({ ctx: 'page:p', node, items: '' });

describe.skipIf(!browserInstalled)('the page’s side of the layout handles', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    const origin = 'http://layout.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      return route.fulfill({ contentType: 'text/html', body: HOST });
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(`window.replies.some((m) => m.type === 'ready')`);
  }, 20000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Waits two frames in the page, so a command's effects and the next outline report have landed. */
  const settle = () => page.frames()[1].evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))`);
  const send = async (type: string, payload: unknown) => {
    await page.evaluate(`window.post(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
    await settle();
  };
  const inFrame = <T>(code: string) => page.evaluate<T>(`(() => { const win = frames[0]; const doc = win.document; ${code} })()`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastReply = (type: string) => page.evaluate<any>(`window.replies.filter((m) => m.type === ${JSON.stringify(type)}).pop()?.payload`);
  const tracks = () => inFrame<number[]>(`return getComputedStyle(doc.getElementById('grid')).gridTemplateColumns.split(' ').map((v) => Math.round(parseFloat(v)));`);
  const previews = () => inFrame<number>(`return doc.querySelectorAll('style[data-so-spacing]').length;`);
  const preview = (drag: string, node: string, decls: Array<[string, string]>, media: string | null = null) => send('spacingPreview', { drag, desc: sel(node), media, decls });

  beforeEach(async () => {
    await send('spacingPreview', { drag: 'd', clear: true });
    await inFrame(`doc.getElementById('site').textContent = '';`);
    await send('mode', { mode: 'edit' });
  });

  it('reports a selected grid’s columns, gaps and how wide it may be', async () => {
    await send('track', { selected: sel('grid'), hovered: null });
    const { layout } = (await lastReply('rects')).spacing;
    expect(layout).toMatchObject({ kind: 'grid', columnGap: 24, rowGap: 16, packedCols: true, packedRows: true, rows: [40] });
    // 800px wide, less two 24px gaps, shared 1:1:2.
    expect(layout.cols.map(Math.round)).toEqual([188, 188, 376]);
    expect(layout.box).toMatchObject({ width: 800 });
    // Centred by auto margins inside the 1000px its container gives it, its max width sizing its content box.
    expect(layout.width).toEqual({ centered: true, max: 800, content: true, basis: 1000 });
  });

  it('reports a stack’s items in flow, and margins of a length as not centring it', async () => {
    await send('track', { selected: sel('row'), hovered: null });
    const { layout } = (await lastReply('rects')).spacing;
    expect(layout).toMatchObject({ kind: 'flex', column: false, wrap: false, spread: false, columnGap: 20 });
    // The absolutely placed item takes no gap.
    expect(layout.items.map((r: { x: number }) => Math.round(r.x - layout.box.x))).toEqual([0, 120, 240]);
    expect(layout.width).toMatchObject({ centered: false, max: null });
  });

  it('measures a style that is a percentage against the width it is taken of', async () => {
    const measure = async (basis?: string) => {
      await send('measureSpace', { requestId: `m-${basis}`, vars: ['--so-container-half', '--so-space-lg'], desc: sel('grid'), basis });
      return (await lastReply('spaceMeasured')).px;
    };
    // The grid's container gives it 1000px; its own content is 800px wide; the page is 1100px wide.
    expect(await measure('parent')).toEqual([500, 24]);
    expect(await measure('box')).toEqual([400, 24]);
    expect(await measure(undefined)).toEqual([550, 24]);
    expect(await inFrame<number>(`return doc.documentElement.children.length;`)).toBe(2);
  });

  it('previews only what a drag can write: fr columns as the stylesheet writes them, gaps and widths of no less than nothing', async () => {
    await preview('d', 'grid', [['grid-template-columns', 'minmax(0, 1fr) minmax(0, 0.5fr) minmax(0, 2.5fr)']]);
    expect(await tracks()).toEqual([188, 94, 470]);
    await preview('d', 'grid', [['grid-template-columns', 'repeat(3, 1fr)']]);
    expect(await previews()).toBe(0);
    expect(await tracks()).toEqual([188, 188, 376]);
    await preview('d', 'grid', [['max-width', 'var(--so-container-half)'], ['column-gap', '0']]);
    expect(await inFrame<string[]>(`const s = getComputedStyle(doc.getElementById('grid')); return [s.maxWidth, s.columnGap];`)).toEqual(['50%', '0px']);
    await preview('d', 'row', [['column-gap', '-4px']]);
    expect(await previews()).toBe(0);
    await preview('d', 'row', [['row-gap', '12px'], ['margin-block-start', '-4px']]);
    expect(await inFrame<string[]>(`const s = getComputedStyle(doc.getElementById('row')); return [s.rowGap, s.marginTop];`)).toEqual(['12px', '-4px']);
  });

  it('keeps a column preview until the page’s stylesheet shows every column, not only the first', async () => {
    // The second divider moved: the first column is as wide either way.
    await preview('d', 'grid', [['grid-template-columns', 'minmax(0, 1fr) minmax(0, 0.5fr) minmax(0, 2.5fr)']], '(min-width: 768px)');
    expect(await tracks()).toEqual([188, 94, 470]);
    await send('revision', { revision: 7 });
    await send('spacingPreview', { drag: 'd', handoff: 7 });
    await settle();
    // The page has the saved revision, but not yet the stylesheet it brings.
    expect(await previews()).toBe(1);
    expect(await tracks()).toEqual([188, 94, 470]);
    await inFrame(`doc.getElementById('site').textContent = '#grid{grid-template-columns:minmax(0,1fr) minmax(0,0.5fr) minmax(0,2.5fr)}';`);
    await settle();
    expect(await previews()).toBe(0);
    expect(await tracks()).toEqual([188, 94, 470]);
  });
});
