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
        if (e.data.type === 'ready') frame.contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: 'inspect', payload: { requestId: 'r', ...${JSON.stringify(page ?? {})} } }, '*');
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
.btn.gradient{background:linear-gradient(#1f5a4c,#2a7a66)}.btn.washed{background:linear-gradient(#fff,#fff);color:#1f5a4c}
@media (max-width:767px){.cards.stack{grid-template-columns:1fr}.cards.pair{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
const doc = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><main id="main">${body}</main><script type="module" src="/bridge.js"></script></body></html>`;
const at = (id: string, node: string) => `data-so-ctx="page:p|${id}" data-so-node="${node}"`;
const PHOTO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#789"/></svg>');

/** An opening section: the page's h1 beside a picture, with a filled button. */
const hero = (id = 's1') =>
  `<section ${at(id, 'root')}><div class="split"><div><h1 ${at(id, 'heading')}>Calm spaces for everyday life</h1><p>Homes and small workplaces that feel good to live in.</p><a class="btn" href="/contact/" ${at(id, 'primary')}>Start a project</a></div><img class="pic" alt="A room" src="${PHOTO}"></div></section>`;

interface CardsOptions {
  tone?: 'muted' | 'dark' | 'fade';
  columns?: 2 | 3;
  /** How the cards lay out at phone width: as wide (the default), stacked in one column, or in two columns. */
  phone?: 'stack' | 'pair';
  button?: 'filled' | 'outline' | 'gradient' | 'washed' | 'none';
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
    // The hero's button and the three card sections' buttons: four sections in a row.
    expect(note(r, 'crowded-actions')).toMatchObject({ sections: { first: 1, last: 4 }, buttons: 4, desc: { node: 's1' }, with: { desc: { node: 's4' } } });
    expect(note(r, 'heading-scale')).toMatchObject({ heading: 'h2', size: 48, h1Size: 48, desc: { ctx: 'page:p|s3', node: 'heading', items: '' }, with: { desc: { ctx: 'page:p|s1', node: 'heading', items: '' } }, text: 'What we do s3' });
    expect(note(r, 'heading-scale')!.message).toMatch(/as large as the page's h1 \(48px\)/);
    // Advice only: nothing joins the findings.
    expect(r.issues.map((i) => i.kind)).not.toEqual(expect.arrayContaining(['repeated-layout', 'crowded-actions', 'heading-scale']));
  }, 30000);

  it('goes quiet on each rule once one section in the run changes', async () => {
    // Another background tone, another column count, or a background only pixels could judge breaks the layout run.
    for (const change of [{ tone: 'muted' }, { tone: 'dark' }, { columns: 2 }, { tone: 'fade' }] as CardsOptions[]) {
      const r = await inspect(monotonous(change), PAGE(ids(5)));
      expect(note(r, 'repeated-layout'), JSON.stringify(change)).toBeUndefined();
    }
    // An outlined button in the middle leaves two runs of two, as does one whose gradient is the colour around it.
    for (const button of ['outline', 'washed'] as const) {
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

  it('reports a larger inner heading as larger, and counts the others that match', async () => {
    const r = await inspect(doc(hero() + cards('s2', { headingStyle: 'font-size:52px', button: 'none' }) + cards('s3', { tone: 'muted', headingStyle: 'font-size:48px', button: 'none' })), PAGE(ids(3)));
    expect(kinds(r)).toEqual(['heading-scale']);
    expect(note(r, 'heading-scale')).toMatchObject({ heading: 'h2', size: 52, h1Size: 48, others: 1, desc: { ctx: 'page:p|s2' } });
    expect(note(r, 'heading-scale')!.message).toMatch(/larger than the page's h1 \(48px\), as is one other inner heading/);
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
    expect(one.rhythm).toBeUndefined();
    const unnamed = await inspect(monotonous(), null);
    expect(unnamed.rhythm).toBeUndefined();
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
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
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
    const body = render(Page, { props: {} }).body;
    out.push({ page, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body><main id="main">${body}</main><script type="module" src="/bridge.js"></script></body></html>` });
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
