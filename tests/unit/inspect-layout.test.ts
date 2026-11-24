/**
 * The layout inspection's readability checks (contrast, overlapping boxes, clipped text and tap targets), run on the
 * real preview bridge in a real browser, in a frame set up the way the editor sets up its measuring frame: hidden,
 * off screen and sandboxed. Every page here is marked up as the editor's preview marks it (data-so-ctx/node/items).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InspectionChecks, InspectionIssue } from '../../src/shared/inspection';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

interface Report {
  viewportWidth: number;
  checks?: InspectionChecks;
  issues: InspectionIssue[];
  /** Elements the inspection left in the page that the page did not have (a colour probe, say). */
  leftovers: number;
}

const ORIGIN = 'http://inspect.test';
let browser: Browser;

beforeAll(async () => {
  if (browserInstalled) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
});
afterAll(async () => {
  await browser?.close();
});

/** An attribute set placing an element on page "p" as node `node` (in list item `items`, when given). */
const so = (node: string, items?: string) => `data-so-ctx="page:p" data-so-node="${node}"${items ? ` data-so-items="${items}"` : ''}`;

const PAGE = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:16px/1.5 sans-serif;color:#111;background:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
</style></head><body><main ${so('main')}><h1 ${so('title')}>Readable page</h1>${body}</main><script type="module" src="/bridge.js"></script></body></html>`;

/** Inspect `body` (inside a page with one h1) at `width`, twice when asked, and count what the inspection left behind. */
async function inspect(body: string, width = 390): Promise<Report> {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: PAGE(body) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>editor</title>' });
    });
    await page.goto(`${ORIGIN}/`);
    // Runs in the browser, so it is passed as text (the Node project has no DOM types).
    return await page.evaluate<Report>(`new Promise((done, fail) => {
      const frame = document.createElement('iframe');
      frame.name = 'so-test';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '${width}px', height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
      let before = 0;
      window.addEventListener('message', (e) => {
        if (e.data?.sessionId !== 'so-test') return;
        if (e.data.type === 'ready') {
          before = frame.contentDocument.querySelectorAll('*').length;
          frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r' } }, '*');
        }
        if (e.data.type === 'inspectResult') done({ ...e.data.payload.report, leftovers: frame.contentDocument.querySelectorAll('*').length - before });
      });
      setTimeout(() => fail(new Error('No inspection result.')), 15000);
      frame.src = '/frame';
      document.body.appendChild(frame);
    })`);
  } finally {
    await page.close();
  }
}

const of = (r: Report, kind: string) => r.issues.filter((i) => i.kind === kind);
const READABILITY = ['low-contrast', 'overlap', 'clipped-text', 'small-tap-target', 'contrast-unverified'];

// One of each defect, and the change that fixes it.
const DEFECTS = {
  contrast: [`<section ${so('band')} style="background:rgba(0,0,0,.04)"><p ${so('faint')} style="color:#aaa">Pale words on a pale band</p></section>`, `<section ${so('band')} style="background:rgba(0,0,0,.04)"><p ${so('faint')} style="color:#444">Pale words on a pale band</p></section>`],
  overlap: [
    `<div ${so('grid')} style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:10px"><div ${so('wide')} style="width:300px;background:#eee">Wide card</div><div ${so('next')} style="background:#eee">Next card</div></div>`,
    `<div ${so('grid')} style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:10px"><div ${so('wide')} style="background:#eee">Wide card</div><div ${so('next')} style="background:#eee">Next card</div></div>`
  ],
  clipped: [
    `<div ${so('clip')} style="height:48px;overflow:hidden"><p ${so('story')} style="margin:0">One line of the story, then another line of it, and a third and a fourth that the box cannot show at this width, however the font happens to set the words on the line.</p></div>`,
    `<div ${so('clip')} style="overflow:hidden"><p ${so('story')} style="margin:0">One line of the story, then another line of it, and a third and a fourth that the box cannot show at this width, however the font happens to set the words on the line.</p></div>`
  ],
  tap: [`<nav ${so('nav')}><a ${so('navlink')} href="/next" style="display:inline-block;padding:4px 6px">Go</a></nav>`, `<nav ${so('nav')}><a ${so('navlink')} href="/next" style="display:inline-flex;align-items:center;min-width:44px;min-height:44px;padding:0 6px">Go</a></nav>`]
};
type Defect = keyof typeof DEFECTS;
const pageWith = (broken: Defect[]) => (Object.keys(DEFECTS) as Defect[]).map((k) => DEFECTS[k][broken.includes(k) ? 0 : 1]).join('\n');

describe('layout inspection readability checks', () => {
  it.skipIf(!browserInstalled)('reports each defect on the element to change, with its measurements, at phone width', async () => {
    const r = await inspect(pageWith(['contrast', 'overlap', 'clipped', 'tap']));
    expect(r.checks).toMatchObject({ contrast: { failed: 1, unverified: 0 }, overlaps: { failed: 1, unverified: 0 }, clippedText: { failed: 1, unverified: 0 }, tapTargets: { failed: 1, unverified: 0 } });
    expect(of(r, 'low-contrast')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'faint', items: '' }, required: 4.5, foreground: '#aaaaaa', text: 'Pale words on a pale band' })]);
    // #aaa over 4% black on white: measured against the band actually painted, not the page's white.
    const ratio = of(r, 'low-contrast')[0].ratio as number;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(2.3);
    expect(of(r, 'low-contrast')[0].background).toBe('#f5f5f5');
    // Both boxes of an overlap are named.
    expect(of(r, 'overlap')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'wide', items: '' }, with: expect.objectContaining({ desc: { ctx: 'page:p', node: 'next', items: '' } }) })]);
    expect((of(r, 'overlap')[0].overlap as { width: number }).width).toBeGreaterThan(80);
    expect(of(r, 'clipped-text')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'clip', items: '' }, axis: 'vertical', box: expect.objectContaining({ height: 48 }) })]);
    expect(of(r, 'small-tap-target')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'navlink', items: '' }, minimum: 44 })]);
    expect((of(r, 'small-tap-target')[0].size as { height: number }).height).toBeLessThan(44);
    // Nothing is left behind in the page.
    expect(r.leftovers).toBe(0);
  }, 30000);

  it.skipIf(!browserInstalled)('reports nothing once each defect is fixed, one at a time and all together', async () => {
    for (const fixed of Object.keys(DEFECTS) as Defect[]) {
      const broken = (Object.keys(DEFECTS) as Defect[]).filter((k) => k !== fixed);
      const r = await inspect(pageWith(broken));
      const kind = { contrast: 'low-contrast', overlap: 'overlap', clipped: 'clipped-text', tap: 'small-tap-target' }[fixed];
      expect(of(r, kind), `${fixed} fixed`).toEqual([]);
      expect(r.issues.map((i) => i.kind).sort()).toEqual(['clipped-text', 'low-contrast', 'overlap', 'small-tap-target'].filter((k) => k !== kind).sort());
    }
    const clean = await inspect(pageWith([]));
    expect(clean.issues).toEqual([]);
    for (const c of Object.values(clean.checks!)) expect(c).toMatchObject({ failed: 0, unverified: 0 });
    expect(clean.checks!.contrast.checked).toBeGreaterThan(4);
    expect(clean.checks!.tapTargets.checked).toBe(1);
    expect(clean.checks!.clippedText.skipped).toBeUndefined();
  }, 60000);

  it.skipIf(!browserInstalled)('measures colours as painted: modern colour spaces, group opacity and gradients', async () => {
    const r = await inspect(`
      <p ${so('oklch')} style="color:oklch(0.85 0 0)">Light grey written in oklch</p>
      <div ${so('faded')} style="opacity:.3"><p ${so('inFaded')} style="color:#000">Black text in a faded group</p></div>
      <div ${so('darkGradient')} style="background:linear-gradient(#000, #222)"><p ${so('onDark')} style="color:#fff">White on a dark gradient</p></div>
      <div ${so('paleGradient')} style="background:linear-gradient(#fff, #eee)"><p ${so('onPale')} style="color:#ddd">Pale on a pale gradient</p></div>
      <div ${so('wideGradient')} style="background:linear-gradient(90deg, #fff, #000)"><p ${so('onWide')} style="color:#777">Grey across black and white</p></div>
      <div ${so('tinted')} style="background:rgba(0, 0, 160, .9)"><p ${so('onTint')} style="color:rgba(255, 255, 255, .95)">White on deep blue</p></div>`);
    const nodes = (kind: string) => of(r, kind).map((i) => i.desc?.node);
    expect(nodes('low-contrast').sort()).toEqual(['inFaded', 'oklch', 'onPale']);
    expect(of(r, 'low-contrast').find((i) => i.desc?.node === 'onPale')?.message).toMatch(/every point of its gradient/);
    // Readable at one end and not the other: only pixels could say where the text sits.
    expect(of(r, 'contrast-unverified')).toEqual([expect.objectContaining({ desc: expect.objectContaining({ node: 'onWide' }), reason: 'gradient' })]);
    expect(r.checks!.contrast).toMatchObject({ failed: 3, unverified: 1 });
  }, 30000);

  it.skipIf(!browserInstalled)('calls text over an image unverified, unless an opaque surface sits between them', async () => {
    const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#333"/></svg>');
    const r = await inspect(`
      <section ${so('hero')} style="background:#fff url('${photo}') center/cover;padding:20px"><p ${so('heroText')} style="color:#fff">White over a photo</p>
        <div ${so('card')} style="background:#fff;padding:8px"><p ${so('cardText')} style="color:#222">Dark on a white card over the photo</p></div></section>
      <section ${so('stack')} style="position:relative;height:120px"><img ${so('stackImg')} alt="" src="${photo}" style="position:absolute;inset:0;width:100%;height:100%">
        <p ${so('stackText')} style="position:relative;color:#fff;margin:0">White over an image element</p></section>
      <div ${so('tinted')} style="position:relative;background:#fff"><style>.tint::before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.6)}</style>
        <div class="tint" ${so('tint')} style="position:relative;height:60px"><p ${so('tintText')} style="position:relative;color:#fff;margin:0">White over a tint</p></div></div>`);
    expect(of(r, 'low-contrast')).toEqual([]);
    expect(of(r, 'contrast-unverified').map((i) => [i.desc?.node, i.reason]).sort()).toEqual([['heroText', 'image'], ['stackText', 'image'], ['tintText', 'overlay']].sort());
    expect(r.checks!.contrast.unverified).toBe(3);
  }, 30000);

  it.skipIf(!browserInstalled)('leaves intentional layering, truncation, hidden content and inline links alone', async () => {
    const r = await inspect(`
      <div ${so('cardWithBadge')} style="position:relative;background:#eee;padding:20px"><span ${so('badge')} style="position:absolute;top:-6px;right:-6px;background:#c00;color:#fff;padding:2px 6px">New</span>Card</div>
      <div ${so('pulled')} style="background:#eee;height:60px">Hero</div><div ${so('pullCard')} style="margin-top:-30px;margin-inline:20px;height:80px;background:#fff;border:1px solid #ccc">Card pulled up over the hero</div>
      <div ${so('stackGrid')} style="display:grid"><div ${so('under')} style="grid-area:1/1;background:#eee;height:80px"></div><p ${so('overText')} style="grid-area:1/1;margin:0;color:#222">Placed on the same cell</p></div>
      <p ${so('cut')} style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long line shortened with an ellipsis on purpose</p>
      <p ${so('clamped')} style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;width:200px">A paragraph clamped to two lines on purpose, however long it happens to run on this page</p>
      <a class="sr" href="#main" ${so('skip')}>Skip to content</a>
      <details ${so('more')}><summary style="display:block;min-height:44px;line-height:44px">More</summary><p style="color:#eee">Faint words nobody can see yet</p><a href="/tiny" style="font-size:10px">tiny</a></details>
      <p ${so('prose')}>Read <a href="/more">more</a> about it, or <a href="/less">less</a>.</p>
      <button ${so('icon')} style="width:48px;height:48px;padding:0"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="8"/></svg><span class="sr">Menu</span></button>
      <p ${so('faintDisabled')}><button disabled style="color:#bbb;min-height:44px;min-width:44px">Off</button></p>`);
    expect(r.issues.filter((i) => READABILITY.includes(i.kind))).toEqual([]);
    expect(r.checks!.overlaps.checked).toBeGreaterThan(0);
  }, 30000);

  it.skipIf(!browserInstalled)('checks tap targets only at phone width', async () => {
    const r = await inspect(pageWith(['tap']), 834);
    expect(of(r, 'small-tap-target')).toEqual([]);
    expect(r.checks!.tapTargets).toMatchObject({ checked: 0, failed: 0, skipped: expect.stringContaining('768px') });
    const narrowest = await inspect(pageWith(['tap']), 767);
    expect(of(narrowest, 'small-tap-target')).toHaveLength(1);
  }, 30000);

  it.skipIf(!browserInstalled)('counts a repeated element once with its items, and keeps every kind under the cap', async () => {
    const cards = Array.from({ length: 6 }, (_, i) => `<li ${so('card', `c${i}`)}><p ${so('cardText', `c${i}`)} style="color:#bbb">Card ${i}</p></li>`).join('');
    const pale = Array.from({ length: 50 }, (_, i) => `<p ${so(`pale${i}`)} style="color:#ccc">Pale ${i}</p>`).join('');
    const r = await inspect(`<ul ${so('list')}>${cards}</ul>${pale}${DEFECTS.tap[0]}${DEFECTS.clipped[0]}`);
    expect(r.checks!.contrast.failed).toBe(56);
    expect(r.issues.length).toBeLessThanOrEqual(40);
    const card = of(r, 'low-contrast').find((i) => i.desc?.node === 'cardText');
    expect(card).toMatchObject({ count: 6, desc: { items: 'c0' } });
    // The 50 pale lines come first, yet the tap target and the clipped box are still listed.
    expect(of(r, 'small-tap-target')).toHaveLength(1);
    expect(of(r, 'clipped-text')).toHaveLength(1);
    expect(r.issues.find((i) => i.kind === 'heading-structure')).toBeUndefined();
  }, 30000);

  it.skipIf(!browserInstalled)('names the code component around markup the editor does not know', async () => {
    const r = await inspect(`<div style="display:contents" ${so('code1')} data-so-code="true"><div><p style="color:#ccc">Pale words in a code component</p></div></div>`);
    expect(of(r, 'low-contrast')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'code1', items: '', inside: true } })]);
  }, 30000);
});
