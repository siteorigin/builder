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

  it.skipIf(!browserInstalled)('leaves out a control that shows only through a box clipped to a pixel, as a form’s spam trap does (#390)', async () => {
    const box = 'position:absolute;inset-inline-start:-10000px;width:1px;height:1px';
    // The contact form's traps: a text field in a label, or (for Web3Forms) a checkbox.
    const trap = (style: string, control: string) => `<form ${so('form')}><div style="${style}" aria-hidden="true">${control}</div></form>`;
    for (const control of ['<label>Leave this field empty <input type="text" name="trap" tabindex="-1"></label>', '<input type="checkbox" name="trap" tabindex="-1">'])
      expect(of(await inspect(trap(`${box};overflow:hidden`, control)), 'small-tap-target'), control).toEqual([]);
    // A box that does not clip shows the control at its own size, wherever it sits.
    expect(of(await inspect(trap(box, '<input type="text" name="trap" tabindex="-1" style="height:20px">')), 'small-tap-target')).toHaveLength(1);
    // Hidden from assistive technology and out of the tab order, a visible control can still be tapped.
    expect(of(await inspect(`<div ${so('hidden')} aria-hidden="true"><button tabindex="-1" style="width:20px;height:20px;padding:0">+</button></div>`), 'small-tap-target')).toHaveLength(1);
    // A clipping box that makes no box of its own clips nothing; a fixed control, or an absolute one placed against a
    // box outside the clip, shows past it.
    const small = (style = '') => `<button style="width:20px;height:20px;padding:0;${style}">+</button>`;
    for (const html of [
      `<div ${so('contents')} style="display:contents;overflow:hidden">${small()}</div>`,
      `<div ${so('fixed')} style="height:0;overflow:hidden">${small('position:fixed;top:40px;left:20px')}</div>`,
      `<div ${so('placed')} style="position:relative"><div style="height:0;overflow:hidden">${small('position:absolute;top:40px;left:20px')}</div></div>`
    ])
      expect(of(await inspect(html), 'small-tap-target'), html).toHaveLength(1);
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

  it.skipIf(!browserInstalled)('names a link without words, and leaves a placeholder <a> without href alone (#208)', async () => {
    const r = await inspect(`<h1 ${so('title')}>Studio</h1><nav ${so('nav')}><a href="/about/">About</a><a href="/contact/" ${so('empty')}></a><a ${so('placeholder')}></a></nav>`);
    expect(of(r, 'empty-link').map((i) => i.desc?.node)).toEqual(['empty']);
  }, 30000);

  it.skipIf(!browserInstalled)('keeps measuring through form controls that hide the form\'s own properties', async () => {
    // A control named "children" or "childNodes" replaces form.children or form.childNodes on the form element.
    const r = await inspect(`<form ${so('form')} style="color:#ccc">Pale words in a form<input ${so('guests')} name="children" style="display:block;min-height:44px;width:200px"><input ${so('note')} name="childNodes" style="display:block;min-height:44px;width:200px"></form>
      <form ${so('loop')} style="color:#ddd">Pale words in a form whose parent is hidden<input name="parentElement" style="display:block;min-height:44px;width:200px"><input name="hasAttribute" style="display:block;min-height:44px;width:200px"></form>
      <div style="display:contents" ${so('codeForm')} data-so-code="true"><form><input name="getBoundingClientRect" style="display:block;min-height:44px;width:200px"><input name="innerText" style="display:block;min-height:44px;width:200px"></form></div>`);
    expect(r).not.toHaveProperty('error');
    for (const c of Object.values(r.checks!)) expect(c.incomplete).toBeUndefined();
    expect(of(r, 'low-contrast').map((i) => i.desc?.node).sort()).toEqual(['form', 'loop']);
  }, 30000);

  it.skipIf(!browserInstalled)('judges gradients between their stops, and stacked or faded layers as only pixels could', async () => {
    const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>');
    const r = await inspect(`
      <div ${so('blackOnMix')} style="background:linear-gradient(90deg, red, #009000)"><p ${so('blackText')} style="color:#000">Black passes at both ends, not between</p></div>
      <div ${so('whiteOnMix')} style="background:linear-gradient(90deg, red, #009000)"><p ${so('whiteText')} style="color:#fff">White fails at both ends, not between</p></div>
      <div ${so('stacked')} style="background:linear-gradient(#0008, #0008), linear-gradient(#0008, #0008)"><p ${so('stackedText')} style="color:#000">Black under two tints</p></div>
      <section ${so('hero')} style="background:#000 url('${photo}')"><div ${so('fadedCard')} style="opacity:.5"><div style="background:#fff"><p ${so('fadedText')} style="color:#000;margin:0">A faded card over a photo</p></div></div></section>
      <a ${so('photoLink')} href="/buy" style="position:relative;display:block;isolation:isolate;background:#000;color:#fff;min-height:44px"><img alt="" src="${photo}" style="position:absolute;inset:0;width:100%;height:100%;z-index:-1">Buy</a>
      <div ${so('nested')} style="opacity:.5"><div style="opacity:.8"><p ${so('nestedText')} style="color:#000">Black in two fades</p></div></div>
      <div ${so('wrap')}><span style="display:contents;color:#ddd">Pale words in a wrapper with no box</span></div>
      <style>.bar,.side{position:relative;height:120px}.bar::before{content:'';position:absolute;left:0;top:0;width:100px;height:24px;background:#000}.side::after{content:'';position:absolute;right:0;top:0;width:30%;height:100%;background:#000}</style>
      <div class="bar" ${so('bar')}><p ${so('barText')} style="color:#000;margin:0">Black on a black bar</p></div>
      <div class="side" ${so('side')}><p ${so('sideText')} style="color:#000;margin:0">Hi</p></div>`);
    const more = await inspect(`
      <div ${so('hardEdge')} style="background:linear-gradient(90deg, red 50%, #009000 50%)"><p ${so('hardText')} style="color:#000">Black on two colours meeting at an edge</p></div>
      <div ${so('dip')} style="background:linear-gradient(90deg, rgb(50 137 60), rgb(210 96 60))"><p ${so('dipText')} style="color:#000">Black on a blend that dips between quarters</p></div>
      <div ${so('group')} style="opacity:.5"><section style="background:#000 url('${photo}')"><div style="background:#fff"><p ${so('groupText')} style="color:#000;margin:0">A card and its photo faded together</p></div></section></div>
      <section style="background:#000 url('${photo}')"><div style="background:#fff;padding:8px"><div style="opacity:.5"><div style="background:#fff"><p ${so('twoCovers')} style="color:#000;margin:0">A faded card on a panel over a photo</p></div></div></div></section>
      <div style="background:linear-gradient(90deg, red 60%, #009000 40%)"><p ${so('fixedUp')} style="color:#000">Black on two colours, the second stop placed early</p></div>
      <div style="background:linear-gradient(90deg, red 0%, 50%, #009000 50%)"><p ${so('hinted')} style="color:#000">Black on two colours meeting at a hint</p></div>
      <div style="background:linear-gradient(90deg, #000 50%, #fff 50%)"><p ${so('greyEdge')} style="color:#757575">Grey on black and white halves</p></div>
      <style>.mbar{position:relative;height:100px}.mbar::before{content:'';position:absolute;left:0;top:100px;margin-top:-100px;width:300px;height:50px;background:#000}</style>
      <div class="mbar"><p ${so('pulledBar')} style="position:relative;color:#000;margin:0">Black on a bar pulled up by its margin</p></div>
      <div style="background:conic-gradient(red 0deg 180deg, #009000 180deg 360deg)"><p ${so('conic')} style="color:#fff">White on two halves of a turn</p></div>
      <section style="background:#fff url('${photo}')"><div style="background:#000;background-clip:content-box;padding:20px"><p ${so('clipped')} style="color:#fff;margin:0">White in a panel painted only inside its padding</p></div></section>`);
    // Nothing is painted between stops that meet at an edge (however the edge is written), and a dip between the
    // quarter points is still found.
    // A background painted only inside the content box is not trusted to cover the photo under its box.
    expect(of(more, 'contrast-unverified').map((i) => [i.desc?.node, i.reason]).sort()).toEqual([['clipped', 'image'], ['dipText', 'gradient'], ['pulledBar', 'overlay']]);
    // Faded with its photo, a card still hides it; faded on a panel, the panel does. Either way the text is measured
    // (black at half strength on white fails).
    // White fails on both halves of the turn, which meet at an edge with nothing between them.
    expect(of(more, 'low-contrast').map((i) => i.desc?.node).sort()).toEqual(['conic', 'groupText', 'twoCovers']);
    const unverified = Object.fromEntries(of(r, 'contrast-unverified').map((i) => [i.desc?.node, i.reason]));
    expect(unverified).toEqual({ blackText: 'gradient', whiteText: 'gradient', stackedText: 'layers', fadedText: 'image', photoLink: 'image', barText: 'overlay' });
    const pale = of(r, 'low-contrast');
    expect(pale.map((i) => i.desc?.node).sort()).toEqual(['nestedText', 'wrap']);
    // Two fades multiply: black at 40% on white.
    expect(pale.find((i) => i.desc?.node === 'nestedText')?.ratio).toBeCloseTo(2.85, 1);
  }, 30000);

  it.skipIf(!browserInstalled)('reads colours the page styles its own elements against', async () => {
    const r = await inspect(`<style>span, so-color-probe { color: #fff !important }</style><p ${so('dark')} style="color:oklch(0.2 0 0)">Dark text written in oklch</p>`);
    expect(of(r, 'low-contrast')).toEqual([]);
    expect(r.checks!.contrast).toMatchObject({ failed: 0, unverified: 0 });
  }, 30000);

  it.skipIf(!browserInstalled)('tells a line cut off at the side from a slide waiting off screen, whatever shortens it', async () => {
    const r = await inspect(`
      <div ${so('carousel')} style="overflow:hidden;width:300px"><div style="display:flex;width:600px"><p style="flex:0 0 300px;margin:0">Slide one</p><p style="flex:0 0 300px;margin:0">Slide two</p></div></div>
      <p ${so('wideLine')} style="width:120px;white-space:nowrap;overflow:hidden;margin:0">A line that runs out of its box</p>
      <p ${so('tall')} style="height:24px;width:200px;overflow:hidden;text-overflow:ellipsis;margin:0">Several lines of words that wrap well past the height of this short box, ellipsis or not</p>
      <p ${so('mono')} style="font-family:monospace;width:12ch"><span ${so('s1')} style="display:inline-block">1234567890</span><span ${so('s2')}>123456789012 abc</span><span ${so('s3')}> XYZ</span></p>
      <p ${so('runs')} style="width:80px;white-space:nowrap;overflow:hidden;margin:0"><span style="display:inline-block;width:100px">Seen</span><span>Lost words</span></p>
      <p ${so('runs2')} style="width:80px;white-space:nowrap;overflow:hidden;margin:0"><span style="display:inline-block;width:100px">Seen</span><span style="display:contents">Lost words</span></p>`);
    expect(of(r, 'clipped-text').map((i) => [i.desc?.node, i.axis]).sort()).toEqual([['runs', 'horizontal'], ['runs2', 'horizontal'], ['tall', 'vertical'], ['wideLine', 'horizontal']]);
    // Inline boxes flow as lines: their outer rectangles cross without their text doing so.
    expect(of(r, 'overlap')).toEqual([]);
  }, 30000);

  it.skipIf(!browserInstalled)('measures each control on its own box, and only words make a sentence', async () => {
    const r = await inspect(`
      <input type="checkbox" id="c1" ${so('far')}><div style="height:80px"></div><label for="c1">I agree, from far away</label>
      <label ${so('wrapLabel')} style="display:flex;align-items:center;min-height:44px"><input type="checkbox"> I agree to the terms</label>
      <nav ${so('menu')}><ul><li><span><a ${so('wrapped')} href="/">Go</a></span></li></ul></nav>
      <p ${so('seps')}><a href="/a">A</a> | <a href="/b">B</a></p>
      <div role="button" style="width:100px;height:60px"><a ${so('help')} href="/help" style="display:inline-block">?</a></div>
      <label style="position:relative;display:inline-block;width:20px;height:20px"><input ${so('bigBox')} type="checkbox" style="position:absolute;left:0;top:0;width:48px;height:48px;margin:0"></label>
      <input ${so('elsewhere')} type="checkbox" id="elsewhere"><label style="display:block;min-height:60px" for="elsewhere">Agree <input ${so('wrongLabel')} type="checkbox"></label>
      <label style="display:flex;align-items:center;min-height:44px"><input ${so('radio')} type="radio" name="r"> Pick this one</label>
      <div ${so('rich')}><p><a href="/go">Go</a></p></div>`);
    // A label labels one control: the one it names, or else the one inside it.
    expect(of(r, 'small-tap-target').map((i) => [i.desc?.node, i.count ?? 1]).sort()).toEqual([['elsewhere', 1], ['far', 1], ['help', 1], ['rich', 1], ['seps', 2], ['wrapped', 1], ['wrongLabel', 1]]);
    // A link the editor does not address on its own (in rich text) is named by the node holding it, which says so.
    expect(of(r, 'small-tap-target').find((i) => i.desc?.node === 'rich')?.desc).toEqual({ ctx: 'page:p', node: 'rich', items: '', inside: true });
    expect(of(r, 'small-tap-target').find((i) => i.desc?.node === 'wrapped')?.desc).toEqual({ ctx: 'page:p', node: 'wrapped', items: '' });
    const exactly = await inspect(pageWith(['tap']), 768);
    expect(exactly.checks!.tapTargets.skipped).toBeDefined();
  }, 30000);

  it.skipIf(!browserInstalled)('shows the worst of a repeated element\'s items', async () => {
    const colors = ['#999', '#eee', '#bbb'];
    const r = await inspect(`<ul ${so('list')}>${colors.map((c, i) => `<li ${so('card', `c${i}`)}><p ${so('cardText', `c${i}`)} style="color:${c}">Card ${i}</p></li>`).join('')}</ul>`);
    expect(of(r, 'low-contrast')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'cardText', items: 'c1' }, count: 3, foreground: '#eeeeee' })]);
  }, 30000);

  it.skipIf(!browserInstalled)('names the code component around markup the editor does not know', async () => {
    const r = await inspect(`<div style="display:contents" ${so('code1')} data-so-code="true"><div><p style="color:#ccc">Pale words in a code component</p></div></div>`);
    expect(of(r, 'low-contrast')).toEqual([expect.objectContaining({ desc: { ctx: 'page:p', node: 'code1', items: '', inside: true } })]);
  }, 30000);
});
