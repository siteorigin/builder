/**
 * Same-titled places in Find and replace (#1539): each says its address, in its group's heading, its checkbox and its
 * jump chip. The helper is checked against real projects; the dialog itself runs in a real browser with its own styles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GraphNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { contentFields, findContent, placeQualifiers, type ContentField } from '../../src/renderer/src/lib/find-content';

const SENTENCE = 'Bring your photo card to the desk.';
/** Two deep addresses that differ only in the middle, and one whose last segment is not its title's. */
const ROUTES = ['/regional-services-and-community-programmes/north-point/intake-checklist/', '/regional-services-and-community-programmes/south-point/intake-checklist/', '/east-quay/arrivals/'];

/** A page called "Intake checklist" under each region, with the same two sentences. */
function handbook(): ProjectState {
  let s = createStarterState('business', 'Test Studio', false);
  ROUTES.forEach((route, i) => {
    const pageId = `pg_intake000${i}`;
    s = applyOperations(s, [{ type: 'page.create', pageId, title: 'Intake checklist', route }]).state;
    for (const n of [1, 2]) {
      const node: GraphNode = { id: `n_intake_${i}_${n}`, kind: 'text', tag: 'p', text: SENTENCE };
      s.pages[pageId].nodes[node.id] = node;
      s.pages[pageId].rootIds.push(node.id);
    }
  });
  return s;
}

const field = (owner: ContentField['owner'], where: string): ContentField => ({ key: `${owner.kind}:${owner.id}:${where}`, owner, nodeId: owner.id, kind: 'text', value: where, rich: false, richLinks: false, direct: false, where, section: where, label: 'Title' });

describe('qualifying places that share a title', () => {
  it('gives each of the same-titled pages its full address, and a page with a title of its own none', () => {
    const s = handbook();
    const fields = [...findContent(s, 'photo card').map((m) => m.field), ...contentFields(s).filter((f) => f.where === 'About')];
    expect([...placeQualifiers(s, fields)]).toEqual(ROUTES.map((route, i) => [`page:pg_intake000${i}`, route]));
  });

  it('counts places, not fields', () => {
    const s = handbook();
    const one = findContent(s, 'photo card').filter((m) => m.field.owner.id === 'pg_intake0000');
    expect(one).toHaveLength(2);
    expect(placeQualifiers(s, one.map((m) => m.field)).size).toBe(0);
  });

  it('compares titles without their spacing or capitals', () => {
    const s = handbook();
    const out = placeQualifiers(s, [field({ kind: 'page', id: 'pg_intake0000' }, 'Intake  checklist '), field({ kind: 'page', id: 'pg_intake0001' }, 'intake CHECKLIST')]);
    expect(out.size).toBe(2);
    expect(placeQualifiers(s, [field({ kind: 'page', id: 'pg_intake0000' }, 'Intake checklist'), field({ kind: 'page', id: 'pg_intake0001' }, 'Intakechecklist')]).size).toBe(0);
  });

  it('says which is the shared part or the site’s details when a page takes their name', () => {
    const s = handbook();
    const out = placeQualifiers(s, [
      field({ kind: 'shell', id: 'footer' }, 'Footer'),
      field({ kind: 'page', id: 'pg_intake0000' }, 'Footer'),
      field({ kind: 'site', id: 'site' }, 'Site details'),
      field({ kind: 'page', id: 'pg_intake0001' }, 'Site details')
    ]);
    expect(out.get('shell:footer')).toBe('Shared');
    expect(out.get('page:pg_intake0000')).toBe(s.pages.pg_intake0000.route);
    expect(out.get('site:site')).toBe('Whole site');
    expect(out.get('page:pg_intake0001')).toBe(s.pages.pg_intake0001.route);
  });

  it('gives an entry its address, or without a page its collection and slug, and the collection’s ID where those read the same', () => {
    let s = createStarterState('business', 'Test Studio', false);
    const entry = (collectionId: string, entryId: string) => ({ type: 'entry.create' as const, collectionId, entryId, title: 'Intake checklist', slug: 'first-visit' });
    s = applyOperations(s, [
      { type: 'collection.create', collectionId: 'guides', name: 'Guides', route: '/help/' },
      { type: 'collection.create', collectionId: 'notes', name: 'Desk notes', pages: { detail: false, archive: false } },
      // Reads as the other's name does: a browser shows the two spaces as one.
      { type: 'collection.create', collectionId: 'old-notes', name: 'Desk  notes', pages: { detail: false, archive: false } },
      entry('guides', 'en_guide0001'),
      entry('notes', 'en_note00001')
    ]).state;
    const qualified = () => placeQualifiers(s, findContent(s, 'Intake checklist').map((m) => m.field));
    expect([...qualified().values()].sort()).toEqual(['/help/first-visit/', 'Desk notes · first-visit']);
    s = applyOperations(s, [entry('old-notes', 'en_note00002')]).state;
    expect(Object.fromEntries(qualified())).toEqual({
      'entry:en_guide0001': '/help/first-visit/',
      'entry:en_note00001': 'Desk notes · first-visit · notes',
      'entry:en_note00002': 'Desk  notes · first-visit · old-notes'
    });
  });
});

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://find-places.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { FindReplaceModal } from ${renderer('panels/FindReplace')};`,
  `import { useStore } from ${renderer('store')};`,
  "flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', revision: 1, state: window.project }, modal: { kind: 'find' } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(FindReplaceModal, { initial: 'photo card' })));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.builder = any('');
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'find-places',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Find and replace did not bundle');
  return chunk.code;
}

/** The app's own styles, so a chip that clips its address shows it. */
const STYLES = [
  '@layer tokens, reset, base, primitives, layout, components;',
  ...['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/FindReplace.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8'))
].join('\n');

/**
 * In the page, given a jump chip scrolled to in its strip: whether any of its address is outside the chip or the
 * strip, or cut short. Built from text, as this file is checked without the DOM's types.
 */
const ADDRESS_CUT = new Function(
  'el',
  `
  el.scrollIntoView({ block: 'nearest' });
  const address = el.querySelector('.find-address');
  const text = address.getBoundingClientRect();
  const outside = [el, el.parentElement].some((box) => {
    const r = box.getBoundingClientRect();
    return text.left < r.left - 1 || text.right > r.right + 1 || text.top < r.top - 1 || text.bottom > r.bottom + 1;
  });
  return outside || address.scrollWidth > address.clientWidth + 1;
`
) as (el: unknown) => boolean;

describe.skipIf(!browserInstalled)('Find and replace with same-titled pages (#1539)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    script = await bundle();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  // A dialog of its own for each test, in the narrowest window the app allows at a 125% zoom, with nothing moving.
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 880, height: 600 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const state = JSON.stringify(handbook()).replace(/</g, '\\u003c');
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${STYLES}</style><body><div id="root"></div><script>${BRIDGE};window.project=${state}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.getByRole('dialog').waitFor();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('shows and names each jump chip by its page’s address, all of it', async () => {
    // The strip shows only past ten matches: these words are in every checklist's sentence and across the site.
    await page.getByLabel('Find', { exact: true }).fill('the');
    const chips = page.getByRole('navigation', { name: 'Places with matches' });
    for (const route of ROUTES) {
      const chip = chips.getByRole('button', { name: new RegExp(`^Intake checklist, ${route}, \\d+ match`) });
      await chip.waitFor();
      expect(await chip.locator('.find-address').innerText()).toBe(route);
      expect(await chip.evaluate(ADDRESS_CUT), route).toBe(false);
    }
  });

  it('names each group and its checkbox by its address, so one page can be chosen alone', async () => {
    await page.getByRole('button', { name: 'Replace…' }).click();
    await page.getByRole('button', { name: 'Choose none' }).click();
    for (const route of ROUTES) {
      await expect.poll(() => page.getByRole('button', { name: `Intake checklist ${route} 0 of 2 chosen` }).count()).toBe(1);
      expect(await page.getByRole('checkbox', { name: `Choose all matches in Intake checklist, ${route}`, exact: true }).count()).toBe(1);
    }
    await page.getByRole('checkbox', { name: `Choose all matches in Intake checklist, ${ROUTES[1]}`, exact: true }).check();
    await expect.poll(() => page.getByRole('region', { name: `Intake checklist, ${ROUTES[1]}, this page only` }).locator('li input:checked').count()).toBe(2);
    expect(await page.locator('li input:checked').count()).toBe(2);
  });
});
