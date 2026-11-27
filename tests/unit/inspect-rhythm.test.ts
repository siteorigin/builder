/**
 * The layout inspection's notes on a page's rhythm (#366): three or more sections in a row with one layout on one
 * background, filled buttons crowding section after section, and an inner heading as large as the page's h1. Run on
 * the real preview bridge in a real browser, in a frame set up as the editor sets up its measuring frame, on pages
 * marked up as the generator marks them: hand-written pages that change one thing at a time, and the real Business
 * starter and worked eval pages rendered from the generator, which must stay quiet.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InspectionIssue, InspectionRhythmNote } from '../../src/shared/inspection';
import type { InstanceNode, LinkValue, PageDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { generateProject } from '@generator/index';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://rhythm.test';

interface Report {
  issues: InspectionIssue[];
  rhythm?: InspectionRhythmNote[];
}

let browser: Browser;
const roots: string[] = [];
beforeAll(async () => {
  if (browserInstalled) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  roots.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/**
 * Inspect the document `html` at `width`, as the editor asks: with the page's ID and its sections (`page`), or as a
 * caller that names none.
 */
async function inspect(html: string, page: { pageId: string; rootIds: string[] } | null, width = 1280): Promise<Report> {
  const tab = await browser.newPage();
  try {
    await tab.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>editor</title>' });
      // The theme's font files are not served here.
      return route.fulfill({ status: 404, body: '' });
    });
    await tab.goto(`${ORIGIN}/`);
    // Runs in the browser, so it is passed as text (the Node project has no DOM types).
    return await tab.evaluate<Report>(`new Promise((done, fail) => {
      const frame = document.createElement('iframe');
      frame.name = 'so-test';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '${width}px', height: '900px', border: '0', visibility: 'hidden', pointerEvents: 'none' });
      window.addEventListener('message', (e) => {
        if (e.data?.sessionId !== 'so-test') return;
        if (e.data.type === 'ready') {
          // As the editor measures a page: shown as visitors see it, then measured.
          frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'mode', payload: { mode: 'preview' } }, '*');
          frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r', ...${JSON.stringify(page ?? {})} } }, '*');
        }
        if (e.data.type === 'inspectResult') done(e.data.payload.report);
      });
      setTimeout(() => fail(new Error('No inspection result.')), 15000);
      frame.src = '/frame';
      document.body.appendChild(frame);
    })`);
  } finally {
    await tab.close();
  }
}

const kinds = (r: Report) => (r.rhythm ?? []).map((n) => n.kind).sort();
const note = (r: Report, kind: string) => (r.rhythm ?? []).find((n) => n.kind === kind);

// ---------------------------------------------------------------------------
// Hand-written pages: each section marked up as a placement on page "p" (its root's own markup is "page:p|<id>").
// ---------------------------------------------------------------------------

const CSS = `
body{margin:0;font:16px/1.5 sans-serif;color:#111;background:#fff}
section{padding:48px 32px}
h1{font-size:48px;margin:0 0 16px}h2{font-size:32px;margin:0 0 16px}h3{font-size:20px;margin:0}
.muted{background:#f2efe8}.dark{background:#14211d;color:#fff}.fade{background:linear-gradient(#fff,#eee)}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;list-style:none;padding:0;margin:0 0 24px}
.cards.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.card{background:#f6f6f6;padding:16px;border-radius:8px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:center}
.pic{display:block;width:100%;aspect-ratio:4/3;background:#ccc}
.btn{display:inline-block;padding:12px 20px;border-radius:6px;text-decoration:none;background:#1f5a4c;color:#fff}
.btn.outline{background:transparent;color:#1f5a4c;border:1px solid currentColor}
.btn.gradient{background:linear-gradient(#1f5a4c,#2a7a66)}.btn.washed{background:linear-gradient(#fff,#fff);color:#1f5a4c}.btn.half{background:linear-gradient(#1f5a4c,#fff)}
@media (max-width:767px){.cards.stack{grid-template-columns:1fr}.cards.pair{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
const doc = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><main id="main">${body}</main><script type="module" src="/bridge.js"></script></body></html>`;
const at = (id: string, node: string) => `data-so-ctx="page:p|${id}" data-so-node="${node}"`;
const PHOTO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#789"/></svg>');

/** An opening section: the page's h1 beside a picture, with two filled buttons. */
const hero = (id = 's1') =>
  `<section ${at(id, 'root')}><div class="split"><div><h1 ${at(id, 'heading')}>Calm spaces for everyday life</h1><p>Homes and small workplaces that feel good to live in.</p><a class="btn" href="/contact/" ${at(id, 'primary')}>Start a project</a> <a class="btn" href="/work/" ${at(id, 'secondary')}>See our work</a></div><img class="pic" alt="A room" src="${PHOTO}"></div></section>`;

interface CardsOptions {
  tone?: 'muted' | 'dark' | 'fade';
  columns?: 2 | 3;
  /** How the cards lay out at phone width: as wide (the default), stacked in one column, or in two columns. */
  phone?: 'stack' | 'pair';
  button?: 'filled' | 'outline' | 'gradient' | 'washed' | 'half' | 'none';
  headingStyle?: string;
}
/** A section of a heading over a grid of cards, with a button under it. */
function cards(id: string, { tone, columns = 3, phone, button = 'filled', headingStyle = '' }: CardsOptions = {}) {
  const items = Array.from({ length: columns }, (_, i) => `<li class="card"><h3>Service ${i + 1}</h3><p>What it covers, in a sentence or two.</p></li>`).join('');
  const action = button === 'none' ? '' : `<a class="btn${button === 'filled' ? '' : ` ${button}`}" href="/services/" ${at(id, 'action')}>See more</a>`;
  return `<section ${at(id, 'root')}${tone ? ` class="${tone}"` : ''}><h2 ${at(id, 'heading')}${headingStyle ? ` style="${headingStyle}"` : ''}>What we do ${id}</h2><ul class="cards${columns === 2 ? ' two' : ''}${phone ? ` ${phone}` : ''}">${items}</ul>${action}</section>`;
}

/** A closing section on a muted band, with no filled button. */
const closing = (id: string) => `<section ${at(id, 'root')} class="muted"><h2 ${at(id, 'heading')} style="text-align:center">Questions?</h2><p style="text-align:center">Write to us any time.</p></section>`;

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const PAGE = (rootIds: string[]) => ({ pageId: 'p', rootIds });

/** Hero, three alike card sections with a filled button each (the middle one's heading as large as the h1), a closing band. */
const monotonous = (middle: CardsOptions = { headingStyle: 'font-size:48px' }) => doc(hero() + cards('s2') + cards('s3', middle) + cards('s4') + closing('s5'));

describe.skipIf(!browserInstalled)('rhythm notes on a page', () => {
  it('names each run and heading on a monotonous page, with what was measured and the sections to change', async () => {
    const r = await inspect(monotonous(), PAGE(ids(5)));
    expect(kinds(r)).toEqual(['crowded-actions', 'heading-scale', 'repeated-layout']);
    expect(note(r, 'repeated-layout')).toMatchObject({
      sections: { first: 2, last: 4 },
      layout: 'three card columns',
      background: '#ffffff',
      desc: { ctx: 'page:p', node: 's2', items: '' },
      with: { desc: { ctx: 'page:p', node: 's4', items: '' } }
    });
    expect(note(r, 'repeated-layout')!.message).toMatch(/^Sections 2–4 use the same layout \(three card columns\) on the same background \(#ffffff\), three in a row\./);
    // The hero's two buttons and the three card sections' buttons: four sections in a row.
    expect(note(r, 'crowded-actions')).toMatchObject({ sections: { first: 1, last: 4 }, buttons: 5, desc: { node: 's1' }, with: { desc: { node: 's4' } } });
    expect(note(r, 'heading-scale')).toMatchObject({ heading: 'h2', size: 48, h1Size: 48, desc: { ctx: 'page:p|s3', node: 'heading', items: '' }, with: { desc: { ctx: 'page:p|s1', node: 'heading', items: '' } }, text: 'What we do s3' });
    expect(note(r, 'heading-scale')!.message).toMatch(/as large as the page's h1 \(48px\)/);
    // Advice only: nothing joins the findings.
    expect(r.issues.filter((i) => ['repeated-layout', 'crowded-actions', 'heading-scale'].includes(i.kind))).toEqual([]);
  }, 30000);

  it('goes quiet on each rule once one section in the run changes', async () => {
    // Another background tone, another column count, or a background only pixels could judge breaks the layout run.
    for (const change of [{ tone: 'muted' }, { tone: 'dark' }, { columns: 2 }, { tone: 'fade' }] as CardsOptions[]) {
      const r = await inspect(monotonous(change), PAGE(ids(5)));
      expect(note(r, 'repeated-layout'), JSON.stringify(change)).toBeUndefined();
    }
    // An outlined button in the middle leaves two runs of two, as does one whose gradient is, somewhere or all over,
    // the colour around it.
    for (const button of ['outline', 'washed', 'half'] as const) {
      const r = await inspect(monotonous({ button }), PAGE(ids(5)));
      expect(note(r, 'crowded-actions'), button).toBeUndefined();
      expect(note(r, 'repeated-layout'), button).toBeDefined();
    }
    // A button filled with a gradient is filled.
    expect(note(await inspect(monotonous({ button: 'gradient' }), PAGE(ids(5))), 'crowded-actions')).toMatchObject({ sections: { first: 1, last: 4 } });
    // A heading a fraction smaller than the h1 is smaller.
    const smaller = await inspect(monotonous({ headingStyle: 'font-size:47.5px' }), PAGE(ids(5)));
    expect(note(smaller, 'heading-scale')).toBeUndefined();
    const varied = await inspect(doc(hero() + cards('s2', { button: 'none' }) + cards('s3', { tone: 'muted', columns: 2, button: 'none' }) + cards('s4') + closing('s5')), PAGE(ids(5)));
    expect(varied.rhythm).toEqual([]);
  }, 60000);

  it('reports the largest inner heading, counts the others that match, and needs one h1 to compare with', async () => {
    const r = await inspect(doc(hero() + cards('s2', { headingStyle: 'font-size:48px', button: 'none' }) + cards('s3', { tone: 'muted', headingStyle: 'font-size:52px', button: 'none' })), PAGE(ids(3)));
    expect(kinds(r)).toEqual(['heading-scale']);
    expect(note(r, 'heading-scale')).toMatchObject({ heading: 'h2', size: 52, h1Size: 48, others: 1, desc: { ctx: 'page:p|s3' } });
    expect(note(r, 'heading-scale')!.message).toMatch(/larger than the page's h1 \(48px\), as is one other inner heading/);
    // Two h1s (which the heading structure check reports): no one top level to compare with.
    const twoH1 = await inspect(doc(hero() + cards('s2', { headingStyle: 'font-size:52px', button: 'none' }).replace('<ul', `<h1 ${at('s2', 'second')}>Another title</h1><ul`)), PAGE(ids(2)));
    expect(twoH1.rhythm).toEqual([]);
    // More headings than one inspection measures: the answer could lie past the cap.
    const many = Array.from({ length: 301 }, (_, i) => `<h3>Point ${i}</h3>`).join('');
    const crowdedHeads = await inspect(doc(hero() + cards('s2', { headingStyle: 'font-size:52px', button: 'none' }).replace('</section>', `${many}</section>`)), PAGE(ids(2)));
    expect(crowdedHeads.rhythm).toEqual([]);
  }, 30000);

  it('at phone width, compares only sections that still set columns side by side', async () => {
    // Card grids that stack into one column on a phone: nothing to compare there, though they repeat at tablet width.
    const stacked = doc(hero() + cards('s2', { phone: 'stack' }) + cards('s3', { phone: 'stack', headingStyle: 'font-size:48px' }) + cards('s4', { phone: 'stack' }) + closing('s5'));
    expect(kinds(await inspect(stacked, PAGE(ids(5)), 390))).toEqual(['crowded-actions', 'heading-scale']);
    expect(note(await inspect(stacked, PAGE(ids(5)), 834), 'repeated-layout')).toMatchObject({ sections: { first: 2, last: 4 } });
    // Three, two and three cards that all show two columns on a phone: a repeat only that width shows.
    const pairs = doc(hero() + cards('s2', { phone: 'pair', button: 'none' }) + cards('s3', { columns: 2, phone: 'pair', button: 'none' }) + cards('s4', { phone: 'pair', button: 'none' }) + closing('s5'));
    expect(note(await inspect(pairs, PAGE(ids(5)), 390), 'repeated-layout')).toMatchObject({ sections: { first: 2, last: 4 }, layout: 'two card columns' });
    expect((await inspect(pairs, PAGE(ids(5)), 1280)).rhythm).toEqual([]);
  }, 30000);

  it('takes runs from where sections show, when the page shows them in another order than it lists them', async () => {
    // Listed: three alike card sections, then a dark band; shown: the dark band second.
    const order = (html: string, n: number) => html.replace('<section ', `<section style="order:${n}" `);
    const html = doc(order(cards('s1', { button: 'none' }), 1) + order(cards('s2', { button: 'none' }), 3) + order(cards('s3', { button: 'none' }), 4) + order(cards('s4', { tone: 'dark', button: 'none' }), 2)).replace('<main id="main">', '<main id="main" style="display:flex;flex-direction:column">');
    expect((await inspect(html, PAGE(ids(4)))).rhythm).toEqual([]);
    // Shown in the order listed, they repeat.
    const listed = html.replace(/order:\d/g, 'order:0');
    expect(note(await inspect(listed, PAGE(ids(4))), 'repeated-layout')).toMatchObject({ sections: { first: 1, last: 3 } });
  }, 30000);

  it('reads a section through a wrapper that makes no box, and a section that rendered nothing breaks a run', async () => {
    // A code component's placement: a wrapper with display: contents around its markup.
    const wrapped = doc(hero() + cards('s2') + `<div style="display:contents" data-so-ctx="page:p" data-so-node="s3"><div style="display:contents">${cards('inner')}</div></div>` + cards('s4') + closing('s5'));
    const r = await inspect(wrapped, PAGE(ids(5)));
    expect(note(r, 'repeated-layout')).toMatchObject({ sections: { first: 2, last: 4 }, layout: 'three card columns' });
    // A section the load did not render between two alike ones: they are not known to follow one another.
    const gap = await inspect(doc(hero() + cards('s2') + cards('s3') + cards('s5')), PAGE(['s1', 's2', 's3', 'gone', 's5']));
    expect(note(gap, 'repeated-layout')).toBeUndefined();
    expect(note(gap, 'crowded-actions')).toMatchObject({ sections: { first: 1, last: 3 } });
  }, 30000);

  it('says nothing about a page of one section, or when the caller names no sections', async () => {
    const one = await inspect(doc(cards('s1', { headingStyle: 'font-size:60px' }).replace('<h2', '<h1 style="font-size:40px">Title</h1><h2')), PAGE(['s1']));
    expect(one).not.toHaveProperty('error');
    expect(one.rhythm).toBeUndefined();
    const unnamed = await inspect(monotonous(), null);
    expect(unnamed).not.toHaveProperty('error');
    expect(unnamed.rhythm).toBeUndefined();
  }, 30000);

  it('calls a layout unknown when its column groups disagree, its rows do not line up, or it is a long list', async () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `<li class="card"><p>Card ${i + 1}</p></li>`).join('');
    // Two grids of nearly one size in each section: three columns over two, four, five.
    const twoGrids = (id: string, lower: number) => `<section ${at(id, 'root')}><ul class="cards">${items(3)}</ul><ul class="cards" style="grid-template-columns:repeat(${lower},minmax(0,1fr))">${items(lower)}</ul></section>`;
    expect((await inspect(doc(twoGrids('s1', 2) + twoGrids('s2', 4) + twoGrids('s3', 5)), PAGE(ids(3)))).rhythm).toEqual([]);
    // Rows of two cards over three, flush: no one column count.
    const rows = (id: string) => `<section ${at(id, 'root')}><div style="display:flex;flex-wrap:wrap">${[50, 50, 33.333, 33.333, 33.333].map((w) => `<div class="card" style="box-sizing:border-box;flex:0 0 ${w}%;height:80px">Card</div>`).join('')}</div></section>`;
    expect((await inspect(doc(rows('s1') + rows('s2') + rows('s3')), PAGE(ids(3)))).rhythm).toEqual([]);
    // A long stacked list in each section is not a layout of columns.
    const list = (id: string) => `<section ${at(id, 'root')}><ul style="margin:0">${Array.from({ length: 80 }, (_, i) => `<li>Entry ${i}</li>`).join('')}</ul></section>`;
    expect((await inspect(doc(list('s1') + list('s2') + list('s3')), PAGE(ids(3)))).rhythm).toEqual([]);
  }, 45000);

  it('tells splits apart by the side their picture is on, and bands apart by the panel inside them', async () => {
    // Columns wrapped alike, the picture on the left, the right, then the left: alternating, so varied.
    const split = (id: string, side: 'left' | 'right') => {
      const pic = `<div class="col"><img class="pic" alt="" src="${PHOTO}"></div>`;
      const text = `<div class="col"><h2>Story ${id}</h2><p>What happened, in a sentence or two.</p></div>`;
      return `<section ${at(id, 'root')}><div class="split">${side === 'left' ? pic + text : text + pic}</div></section>`;
    };
    expect((await inspect(doc(split('s1', 'left') + split('s2', 'right') + split('s3', 'left')), PAGE(ids(3)))).rhythm).toEqual([]);
    expect(note(await inspect(doc(split('s1', 'left') + split('s2', 'left') + split('s3', 'left')), PAGE(ids(3))), 'repeated-layout')).toMatchObject({ layout: 'two columns with the picture on the left' });
    // White bands, each with a white wrapper around a panel of its own colour: navy, cream, navy.
    const banner = (id: string, panel: string, ink: string) => `<section ${at(id, 'root')}><div style="background:#fff;padding:8px"><div style="background:${panel};color:${ink};padding:48px"><h2>Ready ${id}?</h2><p>Start today.</p></div></div></section>`;
    expect((await inspect(doc(banner('s1', '#14213d', '#fff') + banner('s2', '#f6efe0', '#111') + banner('s3', '#14213d', '#fff')), PAGE(ids(3)))).rhythm).toEqual([]);
    expect(note(await inspect(doc(banner('s1', '#14213d', '#fff') + banner('s2', '#14213d', '#fff') + banner('s3', '#14213d', '#fff')), PAGE(ids(3))), 'repeated-layout')).toBeDefined();
  }, 45000);

  it('reads a placement that renders several boxes, or is itself the heading or the button', async () => {
    // A code component's placements: a wrapper with no box around a heading and a grid, side by side in the markup.
    const placement = (id: string, inner: string) => `<div style="display:contents" data-so-ctx="page:p" data-so-node="${id}">${inner}</div>`;
    const grid = (id: string) => placement(id, `<h2>Grid ${id}</h2><ul class="cards">${Array.from({ length: 3 }, () => '<li class="card"><p>Card</p></li>').join('')}</ul>`);
    const r = await inspect(doc(placement('s1', '<h1 style="font-size:40px">The title</h1>') + grid('s2') + grid('s3') + grid('s4')), PAGE(ids(4)));
    expect(note(r, 'repeated-layout')).toMatchObject({ sections: { first: 2, last: 4 }, layout: 'three card columns' });
    // The title is the placement's own box, and so is each button.
    const button = (id: string) => placement(id, `<a class="btn" href="/book/" style="display:block;width:max-content">Book ${id}</a>`);
    const b = await inspect(doc(placement('s1', '<h1 style="font-size:30px">The title</h1>') + `<section ${at('s2', 'root')}><h2 ${at('s2', 'heading')}>Bigger than the title</h2></section>` + button('s3') + button('s4') + button('s5')), PAGE(ids(5)));
    expect(note(b, 'heading-scale')).toMatchObject({ heading: 'h2', h1Size: 30 });
    expect(note(b, 'crowded-actions')).toMatchObject({ sections: { first: 3, last: 5 }, buttons: 3 });
  }, 30000);

  it('counts a button that opens a dialog, and not one on a slide waiting off screen', async () => {
    const dialog = (id: string) => `<section ${at(id, 'root')}><h2>Visit ${id}</h2><button class="btn" aria-haspopup="dialog" style="border:0">Book now</button></section>`;
    expect(note(await inspect(doc(dialog('s1') + dialog('s2') + dialog('s3')), PAGE(ids(3))), 'crowded-actions')).toMatchObject({ buttons: 3 });
    const slides = (id: string) => `<section ${at(id, 'root')}><div style="display:flex;overflow-x:auto"><div style="flex:0 0 100%"><h2>Slide one ${id}</h2></div><div style="flex:0 0 100%"><a class="btn" href="/buy/">Buy</a></div></div></section>`;
    expect(note(await inspect(doc(slides('s1') + slides('s2') + slides('s3')), PAGE(ids(3))), 'crowded-actions')).toBeUndefined();
  }, 30000);

  it('breaks a run at markup of the page outside the sections named, and between sections side by side in one band', async () => {
    // A load from before a section was removed: it still shows between two alike ones.
    const stale = await inspect(doc(cards('s1') + cards('s2') + cards('removed', { tone: 'dark' }) + cards('s3')), PAGE(ids(3)));
    expect(note(stale, 'repeated-layout')).toBeUndefined();
    expect(note(stale, 'crowded-actions')).toBeUndefined();
    // Named in full, the same load has a run of four.
    expect(note(await inspect(doc(cards('s1') + cards('s2') + cards('s3', { tone: 'dark' }) + cards('s4')), PAGE(ids(4))), 'crowded-actions')).toMatchObject({ sections: { first: 1, last: 4 } });
    // Three sections in one row of the page: beside each other, not after each other.
    const band = doc(cards('s1', { columns: 2 }) + cards('s2', { columns: 2 }) + cards('s3', { columns: 2 })).replace('<main id="main">', '<main id="main" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:start">');
    expect((await inspect(band, PAGE(ids(3)))).rhythm).toEqual([]);
    // Staggered a few pixels down the row: still one band.
    let k = 0;
    const staggered = band.replace(/<section /g, () => `<section style="margin-top:${2 * k++}px" `);
    expect((await inspect(staggered, PAGE(ids(3)))).rhythm).toEqual([]);
  }, 30000);

  it('leaves a section of many boxes out of every run, and a page of more markup than it lists alone, in time', async () => {
    // A code component rendering a long list straight under its wrapper.
    const long = `<div style="display:contents" data-so-ctx="page:p" data-so-node="s2">${Array.from({ length: 3000 }, (_, i) => `<p style="margin:0">Line ${i}</p>`).join('')}</div>`;
    const started = Date.now();
    const r = await inspect(doc(cards('s1') + long + cards('s3') + cards('s4')), PAGE(ids(4)));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.rhythm).toEqual([]);
    // Hundreds of the page's own sections it does not list (a load far behind the editor): no order to tell.
    const strays = Array.from({ length: 220 }, (_, i) => `<section data-so-ctx="page:p|x${i}" data-so-node="root" style="padding:4px">Old ${i}</section>`).join('');
    const behind = await inspect(doc(cards('s1') + cards('s2') + strays), PAGE(ids(2)));
    expect(behind).not.toHaveProperty('error');
    expect(behind.rhythm).toBeUndefined();
  }, 30000);

  it('tells a split from two cards wrapped alike when only one card has a photo, and compares every panel of a band', async () => {
    const photoCol = `<div class="col"><img class="pic" alt="" src="${PHOTO}"></div><div class="col"><h2>Story</h2><p>What happened.</p></div>`;
    const twoCards = (id: string) => `<section ${at(id, 'root')}><ul class="cards two"><li class="card"><img class="pic" alt="" src="${PHOTO}"><h3>Ada</h3><p>Founder.</p></li><li class="card"><h3>Grace</h3><p>Designer.</p></li></ul></section>`;
    const r = await inspect(doc(`<section ${at('s1', 'root')}><div class="split">${photoCol}</div></section>` + twoCards('s2') + twoCards('s3')), PAGE(ids(3)));
    expect(r.rhythm).toEqual([]);
    // One brand panel inside wrappers of navy, cream, navy, each over much of its white band.
    const banner = (id: string, wrap: string) => `<section ${at(id, 'root')} style="padding:8px"><div style="background:${wrap};padding:16px"><div style="background:#1f5a4c;color:#fff;padding:48px"><h2>Ready ${id}?</h2><p>Start today.</p></div></div></section>`;
    expect((await inspect(doc(banner('s1', '#14213d') + banner('s2', '#f6efe0') + banner('s3', '#14213d')), PAGE(ids(3)))).rhythm).toEqual([]);
    expect(note(await inspect(doc(banner('s1', '#14213d') + banner('s2', '#14213d') + banner('s3', '#14213d')), PAGE(ids(3))), 'repeated-layout')).toBeDefined();
  }, 30000);

  it('keeps cards with linked titles as cards, finds a second h1 past hidden boxes, and counts a button in a scaled box', async () => {
    const split = (id: string) => `<section ${at(id, 'root')}><div class="split"><div class="col"><img class="pic" alt="" src="${PHOTO}"></div><div class="col"><h2>Story ${id}</h2><p>What happened.</p></div></div></section>`;
    const linkedCards = (id: string) => `<section ${at(id, 'root')}><div class="split"><div class="col"><img class="pic" alt="" src="${PHOTO}"><a href="/a/">Ada</a></div><div class="col"><a href="/g/">Grace</a></div></div></section>`;
    expect((await inspect(doc(split('s1') + linkedCards('s2') + split('s3')), PAGE(ids(3)))).rhythm).toEqual([]);
    // A placement whose second h1 comes after more hidden boxes than a section is measured by.
    const hidden = Array.from({ length: 70 }, () => '<p hidden>Old</p>').join('');
    const second = `<div style="display:contents" data-so-ctx="page:p" data-so-node="s2">${hidden}<div><h1>Another title</h1></div></div>`;
    expect(note(await inspect(doc(hero() + second + cards('s3', { headingStyle: 'font-size:52px', button: 'none' })), PAGE(ids(3))), 'heading-scale')).toBeUndefined();
    // A box drawn at twice its size: the button inside it shows, though past its unscaled width.
    const scaled = (id: string) => `<section ${at(id, 'root')}><div style="width:160px;height:40px;overflow:hidden;transform:scale(2);transform-origin:0 0;margin-bottom:48px"><a class="btn" href="/go/" style="position:relative;left:90px;padding:4px 8px;font-size:10px">Go</a></div></section>`;
    expect(note(await inspect(doc(scaled('s1') + scaled('s2') + scaled('s3')), PAGE(ids(3))), 'crowded-actions')).toMatchObject({ buttons: 3 });
  }, 30000);

  it('leaves the notes out of a report too long for the editor to accept, and keeps the report', async () => {
    const throwing = (n: number, length: number) => Array.from({ length: n }, (_, i) => `<script type="module">throw new Error('${String(i)}'.repeat(${length}))</script>`).join('');
    const page = (scripts: string) => doc(hero() + cards('s2') + cards('s3') + cards('s4')).replace('</body>', `${scripts}</body>`);
    const long = await inspect(page(throwing(10, 19_500)), PAGE(ids(4)));
    expect(long).not.toHaveProperty('error');
    expect((long as unknown as { runtimeErrors: string[] }).runtimeErrors.length).toBeGreaterThan(0);
    expect(JSON.stringify(long).length).toBeLessThanOrEqual(200_000);
    expect(long.rhythm).toBeUndefined();
    const short = await inspect(page(throwing(10, 100)), PAGE(ids(4)));
    expect(note(short, 'repeated-layout')).toBeDefined();
  }, 30000);

  it('reads past text hidden for screen readers, through a form hiding its own sizes, and past a page breaking JSON', async () => {
    // A picture column labelled for screen readers is still a picture column: left, right, left is varied.
    const split = (id: string, side: 'left' | 'right') => {
      const pic = `<div class="col"><img class="pic" alt="" src="${PHOTO}"><span class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Photo</span></div>`;
      const text = `<div class="col"><h2>Story ${id}</h2><p>What happened.</p></div>`;
      return `<section ${at(id, 'root')}><div class="split">${side === 'left' ? pic + text : text + pic}</div></section>`;
    };
    expect((await inspect(doc(split('s1', 'left') + split('s2', 'right') + split('s3', 'left')), PAGE(ids(3)))).rhythm).toEqual([]);
    // A form with a control named offsetWidth, clipping its button out of view.
    const form = (id: string) => `<section ${at(id, 'root')}><h2>Write ${id}</h2><form style="width:100px;overflow:hidden;white-space:nowrap"><input type="hidden" name="offsetWidth"><span style="display:inline-block;width:100px"></span><button class="btn" style="border:0">Send</button></form></section>`;
    expect(note(await inspect(doc(form('s1') + form('s2') + form('s3')), PAGE(ids(3))), 'crowded-actions')).toBeUndefined();
    // A page whose scripts make every object refuse to become JSON: the report still comes, without its notes.
    const hostile = doc(hero() + cards('s2') + cards('s3') + cards('s4')).replace('<main', `<script>Object.defineProperty(Object.prototype, 'toJSON', { value() { throw new Error('No JSON here'); }, configurable: true });</script><main`);
    const r = await inspect(hostile, PAGE(ids(4)));
    expect(r).not.toHaveProperty('error');
    expect(r.rhythm).toBeUndefined();
  }, 30000);

  it('counts a button that a box clips only on the other axis', async () => {
    const sideways = (id: string) => `<section ${at(id, 'root')}><h2>Visit ${id}</h2><div style="width:60px;overflow-x:visible;overflow-y:clip"><a class="btn" href="/book/" style="transform:translateX(80px);white-space:nowrap">Book a table</a></div></section>`;
    expect(note(await inspect(doc(sideways('s1') + sideways('s2') + sideways('s3')), PAGE(ids(3))), 'crowded-actions')).toMatchObject({ buttons: 3 });
  }, 30000);
});

// ---------------------------------------------------------------------------
// Pages from the generator: the Business starter and the worked eval's five-page site are paced well, and three
// placements of one card grid in a row are not.
// ---------------------------------------------------------------------------

const link = (pageId: string): LinkValue => ({ type: 'page', target: pageId });

function place(state: ProjectState, componentId: string, props: Record<string, unknown> = {}, variant?: string): InstanceNode {
  const def = state.components[installComponent(state, componentId)];
  return makeInstance(def, props, variant);
}

/** A page made of `sections`, added to the project at `route`. */
function addPage(state: ProjectState, id: string, title: string, route: string, sections: InstanceNode[]): PageDoc {
  const template = state.pages[state.site.homePageId];
  const page: PageDoc = { ...template, id, title, route, seo: {}, rootIds: sections.map((n) => n.id), nodes: Object.fromEntries(sections.map((n) => [n.id, n])) };
  state.pages[id] = page;
  if (!state.site.pageOrder.includes(id)) state.site.pageOrder.push(id);
  return page;
}

/** The worked five-page eval (scripts/eval/cases.ts, build-five-page-site), as its script builds it. */
function fivePageSite(): ProjectState {
  const s = createStarterState('blank', 'Garden Studio', false);
  const home = s.site.homePageId;
  const [services, pricing, about, contact] = ['pg_services', 'pg_pricing', 'pg_about', 'pg_contact'];
  const intro = (heading: string) => place(s, 'intro.page', { heading, lead: `${heading}, explained simply.` });
  const closing = () => place(s, 'cta.banner', { heading: 'Ready when you are', primaryLabel: 'Get in touch', primaryLink: link(contact) });
  const plan = (name: string, price: string) => ({ name, price, features: 'One visit', actionLabel: 'Book', actionLink: link(contact) });
  addPage(s, home, 'Home', '/', [place(s, 'hero.split', { heading: 'Gardens that grow with you', primaryLabel: 'See pricing', primaryLink: link(pricing) }), closing()]);
  addPage(s, services, 'Services', '/services/', [intro('Services'), place(s, 'features.grid', { heading: 'What we do', items: [{ icon: 'leaf', title: 'Garden care', description: 'Weekly visits.' }] }), closing()]);
  addPage(s, pricing, 'Pricing', '/pricing/', [intro('Pricing'), place(s, 'pricing.plans', { plans: [plan('Tidy', '$90'), plan('Care', '$290')] }), closing()]);
  addPage(s, about, 'About', '/about/', [intro('About us'), place(s, 'team.grid', { heading: 'The team', people: [{ name: 'Ada', role: 'Founder', bio: 'Twenty years in gardens.' }] })]);
  addPage(s, contact, 'Contact', '/contact/', [intro('Contact'), place(s, 'contact.details', { heading: 'Talk to us' })]);
  return s;
}

/** Every page of `state` rendered on the server with the editor's markup, each in a document with the site's styles. */
async function renderPages(state: ProjectState): Promise<Array<{ page: PageDoc; html: string }>> {
  const files = generateProject(state, { instrument: true });
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'inspect-rhythm-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const goto = () => {};\n');
  for (const [path, source] of files) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    // A code component's styles are in its own <style>, which the server render puts in the document's head.
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', css: 'injected', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const css = ['tokens', 'theme', 'components', 'site'].map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
  const out: Array<{ page: PageDoc; html: string }> = [];
  for (const page of Object.values(state.pages)) {
    const Page = (await import(/* @vite-ignore */ join(dir, `src/routes${page.route}+page.svelte.js`))).default as Component<Record<string, unknown>>;
    const { head, body } = render(Page, { props: {} });
    out.push({ page, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style>${head}</head><body><main id="main">${body}</main><script type="module" src="/bridge.js"></script></body></html>` });
  }
  return out;
}

describe.skipIf(!browserInstalled)('rhythm notes on generated pages', () => {
  it('has nothing to say about the Business starter at any width', async () => {
    const pages = await renderPages(createStarterState('business', 'Test Studio', false));
    expect(pages.map((p) => p.page.route).sort()).toEqual(['/', '/about/', '/contact/']);
    for (const { page, html } of pages)
      for (const width of [390, 834, 1280]) {
        const r = await inspect(html, { pageId: page.id, rootIds: page.rootIds }, width);
        // An empty list, not a missing one: the rules ran and found the page well paced.
        expect(r.rhythm, `${page.route} at ${width}px: ${JSON.stringify(r.rhythm)}`).toEqual([]);
      }
  }, 120000);

  it('has nothing to say about the worked five-page site', async () => {
    const pages = await renderPages(fivePageSite());
    expect(pages).toHaveLength(5);
    for (const { page, html } of pages)
      for (const width of [390, 1280]) {
        const r = await inspect(html, { pageId: page.id, rootIds: page.rootIds }, width);
        expect(r.rhythm, `${page.route} at ${width}px: ${JSON.stringify(r.rhythm)}`).toEqual([]);
      }
  }, 120000);

  it('notes three placements of one card grid in a row on one background', async () => {
    const s = createStarterState('blank', 'Repeat Studio', false);
    const grid = (heading: string) => place(s, 'features.grid', { heading });
    const sections = [place(s, 'hero.split', { heading: 'One studio, many rooms' }), grid('Planning'), grid('Materials'), grid('Delivery'), place(s, 'cta.banner', { heading: 'Ready?' })];
    const page = addPage(s, s.site.homePageId, 'Home', '/', sections);
    const [{ html }] = await renderPages(s);
    const r = await inspect(html, { pageId: page.id, rootIds: page.rootIds });
    expect(kinds(r)).toEqual(['repeated-layout']);
    expect(note(r, 'repeated-layout')).toMatchObject({ sections: { first: 2, last: 4 }, layout: 'three card columns', desc: { ctx: `page:${page.id}`, node: sections[1].id }, with: { desc: { node: sections[3].id } } });
  }, 60000);
});
